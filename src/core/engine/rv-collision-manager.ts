// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-collision-manager.ts — viewer-owned collision detection with preset roles
 * (plan-394), on the plan-756 pick structure since plan-781. Part of the
 * on-demand feature `collision` (plan-781 F21): only `features/collision.body.ts`
 * value-imports this module; startup code holds `rv-collision-slot.ts` instead.
 *
 * While the simulation runs, every pair of collision bodies with DIFFERENT
 * roles is checked once per sim tick — but only when one of its bodies MOVED:
 *
 *   1. **Bodies** — a body is the role node's segment ranges in every chunk plus
 *      the kept meshes of its subtree (`rv-collision-bodies.ts`); an MU body is
 *      its clone meshes or its instance slot. A static role node collides after
 *      the destructive bake because its triangles are found where the bake put
 *      them (the plan-394 "meshes under the node" rule found nothing there).
 *   2. **Fresh poses + motion stamps** — every part's matrix chain is refreshed
 *      at the head of the check (the render refreshes `matrixWorld` only later,
 *      F16) and compared with the last seen one (16 floats, F5). Its world box
 *      is re-derived only when it moved.
 *   3. **Broadphase** — a pair list precomputed at rebuild (roles differ, not
 *      nested) and a world-box test; MU × node pairs additionally through the
 *      transport's MU grid (`queryMUsXZ`, F9).
 *   4. **Narrowphase** — the exact walk of `rv-collision-narrowphase.ts` over
 *      the parts' pick structures with the touch-tolerant triangle test
 *      (`rv-collision-tri-tri.ts`). Touching is no collision (F3).
 *
 * Pair states (F6/F7/F17): `Unknown` → first evaluation → `Armed` (apart) or
 * `Baseline` (overlapping: quiet until the pair has been apart once, then
 * `Armed`). A Baseline pair whose bodies cannot move and did not move is
 * `authoredStill` — listed in Problems, never an alarm. `Armed` + hit LATCHES:
 * card + outline + signals, until the pair's TYPE is ignored, its card is
 * acknowledged, a `ResetCollisions` edge arrives or the model changes (user
 * decisions 2026-08-07). States survive a rebuild by `pairKey`.
 *
 * Hard rules:
 * - Collision READS the pick structure and builds none of its own (contract
 *   bake-picking rule 15 as ruled by Vincent, 2026-11-05; rules 10/11: no index
 *   rewrite, no dispose). The guard is `rv-collision-no-structure.node.test.ts`.
 * - The simulation is never stopped or paused.
 * - A body is never checked against a body nested inside it (a robot against
 *   its own gripper always touches at the flange, F16).
 * - Mutations that arrive during a check (`simulation-reset`, MU removal,
 *   invalidate) are flags or queue entries applied at the next tick head (F18).
 * - No allocation in the tick.
 */

import { Box3, Matrix4 } from 'three';
import type { Object3D } from 'three';
import { NodeRegistry } from './rv-node-registry';
import type { CollisionRoleName, CollisionRoleRegistrar, StockBoundsSource } from './rv-collision-role';
import { toCollisionRole } from './rv-collision-role';
import type { IMULifecycleHook } from './rv-transport-manager';
import type { IMUAccessor } from './rv-mu';
import type { AABB } from './rv-aabb';
import type { SignalStore } from './rv-signal-store';
import { createSignalWriter, type SignalWriter } from './rv-signal-store';
import type { CollisionPairView } from '../hmi/collision-alert-store';
import { publishCollisionAlert } from '../hmi/collision-alert-store';
import {
  COLLISION_AUTHORED_OVERLAP_CODE, COLLISION_START_OVERLAP_CODE, clearCollisionOverlapProblems,
  reportCollisionOverlaps, type CollisionOverlapPair,
} from '../hmi/problems-store';
import { debug } from './rv-debug';
import {
  createBodyBuildStats, freshWorldMatrix, partVisible, refreshPartPose, resolveMUParts, resolveNodeParts, stampMotion,
  updatePartWorldBox, type BodyBuildStats, type BodyPart, type CollisionGeometrySource,
} from './rv-collision-bodies';
import {
  createNarrowCounters, createNarrowWitness, partsOverlap, resetNarrowCounters,
  type NarrowCounters, type NarrowWitness,
} from './rv-collision-narrowphase';
import { touchEpsFor } from './rv-collision-tri-tri';

export type { BodyPart, CollisionGeometrySource } from './rv-collision-bodies';

// ─── Signal names ────────────────────────────────────────────────────────

export const SIGNAL_COLLISION_ACTIVE = 'CollisionActive';
export const SIGNAL_COLLISION_COUNT = 'CollisionCount';
export const SIGNAL_RESET_COLLISIONS = 'ResetCollisions';
/** Synthetic path prefix (same idea as the interface layer's `__iface__/`). */
const SIGNAL_PATH_PREFIX = '__collision__';

/**
 * Near-miss margin in metres. 0 = contact only (Vincent, 2026-11-05). A module
 * constant, not a schema field: it becomes a property (mm, number editor) with
 * the later near-miss plan (contract component-model 3/7).
 */
export const MARGIN_M = 0;

/** MU × node pairs of one node body below this count skip the grid query. */
const GRID_MIN_PAIRS = 8;
/** XZ slack of the grid query (m) — the MU grid tracks the transport AABB. */
const GRID_SLACK_M = 0.05;

/** Module scratch for the per-tick stock box (plan-409 F4). */
const _stockBox = new Box3();
const _stockMatrix = new Matrix4();

// ─── Data model ──────────────────────────────────────────────────────────

/** An MU accessor plus the per-instance AABB both MU classes carry. */
export type CollisionMU = IMUAccessor & { readonly aabb: AABB; readonly node: Object3D };

/** Pair states (plan-781 §2.3). Plain numbers — no cross-module const enum. */
export const PairState = { Unknown: 0, Baseline: 1, Armed: 2 } as const;
export type PairStateValue = (typeof PairState)[keyof typeof PairState];

export interface CollisionBody {
  /** Node body: the role-carrying node. MU body: the MU's node (shared for
   *  instanced MUs — used only for the highlight of clones). */
  readonly root: Object3D;
  readonly role: CollisionRoleName;   // never 'None'
  /** Stable identity across rebuilds — node path, or `mu:<id>` for MUs. */
  readonly key: string;
  /** Display name for the card. */
  readonly label: string;
  readonly kind: 'node' | 'mu';
  /** The geometric pieces (chunk ranges, keep meshes, MU instance). May be empty. */
  readonly parts: BodyPart[];
  /** Only for `kind === 'mu'`. */
  readonly mu: CollisionMU | null;
  /** Per-tick union box of the visible parts (and a live stock box). */
  readonly worldBox: Box3;
  /** Live stock-extent providers found in this body's subtree (plan-409 F4). */
  readonly stockSources: StockBoundsSource[];
  /** Bodies whose subtree contains this body — the F16 skip set. */
  readonly ancestorBodies: Set<CollisionBody>;
  /** Some part can move on its own (mover chunk, keep mesh under a mover, MU). */
  readonly mobile: boolean;
  /** This tick: a part moved, became (in)visible, or the stock box changed. */
  moved: boolean;
  /**
   * This tick: a live stock box stands in for the hidden workpiece (plan-409
   * F4). A box has no triangles, so a pair with this body stops after the box
   * test — the one box-only case that remains.
   */
  stockActive: boolean;
  /** @internal Index in `bodies` (swap-and-pop of MU bodies). */
  _index: number;
  /** @internal Every pair record this body takes part in. */
  readonly _pairs: PairRecord[];
  /** @internal Node bodies: the MU × node pairs, grid-filtered per tick. */
  readonly _muPairs: PairRecord[];
  /** @internal Last stock world box (6) + presence in [6]. */
  readonly _stockPrev: Float64Array;
}

/** Index pair into a body array. */
export interface CrossPair {
  readonly i: number;
  readonly j: number;
  /**
   * Normalized body-pair key, PRECOMPUTED at rebuild (plan-409 F7). Same format
   * as {@link RVCollisionManager.acknowledge}, so the suppression set, the
   * latched-pair map and the pair state share one key space.
   */
  readonly pairKey: string;
}

/** A checked pair with its state. Lives in the pair list; never allocated in the tick. */
interface PairRecord extends CrossPair {
  i: number;
  j: number;
  /** Index in `_pairs`. */
  slot: number;
  state: PairStateValue;
  /** Baseline because two still bodies overlap (F6). */
  authoredStill: boolean;
  /** Result of the last evaluation. */
  lastHit: boolean;
  /** Evaluate at the next tick even without motion (rebuild, reset, ack, unmute). */
  retest: boolean;
  /** MU × node pair: the node body (grid prefilter), else null. */
  muNode: CollisionBody | null;
  /** MU × node pair: the MU body. */
  muBody: CollisionBody | null;
  readonly witness: NarrowWitness;
  witnessA: number;
  witnessB: number;
}

/** A currently latched pair: display view + the highlight roots that belong to it. */
interface ActivePair {
  readonly view: CollisionPairView;
  readonly aRoot: Object3D | null;
  readonly bRoot: Object3D | null;
}

/** Minimal body shape `buildCrossPairs` needs (keeps the function unit-testable). */
export interface PairableBody {
  readonly role: string;
  readonly ancestorBodies?: ReadonlySet<unknown>;
  /** Stable body key; used for the precomputed {@link CrossPair.pairKey}. */
  readonly key?: string;
}

/** Separator of {@link bodyPairKey} — a character no node path can contain. */
const KEY_SEP = String.fromCharCode(0);
/** Body key prefix of an MU body (`mu:<id>`). */
const MU_KEY_PREFIX = 'mu:';

/** Normalized, order-independent key for a pair of body keys. */
export function bodyPairKey(aKey: string, bKey: string): string {
  return aKey < bKey ? aKey + KEY_SEP + bKey : bKey + KEY_SEP + aKey;
}

/**
 * Precompute the checked pairs. TWO conditions:
 *   - different roles (identical roles never collide, `None` never collides), and
 *   - not related (a body inside another body's subtree — F16).
 */
export function buildCrossPairs(bodies: readonly PairableBody[]): CrossPair[] {
  const pairs: CrossPair[] = [];
  for (let i = 0; i < bodies.length; i++) {
    const a = bodies[i];
    if (a.role === 'None') continue;
    for (let j = i + 1; j < bodies.length; j++) {
      const b = bodies[j];
      if (!isPairable(a, b)) continue;
      // plan-409 F7: the key is built HERE, once per rebuild, never in the tick.
      pairs.push({ i, j, pairKey: bodyPairKey(a.key ?? `#${i}`, b.key ?? `#${j}`) });
    }
  }
  return pairs;
}

function isPairable(a: PairableBody, b: PairableBody): boolean {
  if (a.role === 'None' || b.role === 'None') return false;
  if (a.role === b.role) return false;
  if (a.ancestorBodies?.has(b)) return false;
  if (b.ancestorBodies?.has(a)) return false;
  return true;
}

// ─── Hosts (narrow seams, no hard viewer dependency) ─────────────────────

/** Highlight seam (OutlinePass STATUS channel in production, a fake in tests). */
export interface CollisionHighlightHost {
  /** Show the collision outline on `roots` (replaces the previous set). */
  showCollision(roots: readonly Object3D[]): void;
  /** Remove the collision outline. */
  hideCollision(): void;
}

/** The slice of `SignalStore` this manager uses. */
export type CollisionSignalHost = Pick<SignalStore, 'register' | 'get' | 'set' | 'subscribe'>
  & Partial<Pick<SignalStore, 'createWriter'>>;

/** The transport's MU grid query (F9) — `RVTransportManager.queryMUsXZ`. */
export interface CollisionMUQuery {
  queryMUsXZ(min: ArrayLike<number>, max: ArrayLike<number>, out: IMUAccessor[]): number;
}

/** The viewer events the manager follows (wired per model, dropped by `clear()`). */
export type CollisionViewerEvent =
  | 'simulation-reset' | 'node-visibility-changed' | 'placements-materialized' | 'layout-content-added';

/** `viewer.on` in the shape the manager needs: subscribe, get the unsubscribe back. */
export type CollisionEventSubscriber = (event: CollisionViewerEvent, cb: () => void) => () => void;

/** Work counters (tests, DevTools, the perf gate). Never required. */
export interface CollisionCounters extends NarrowCounters {
  /** Pairs that reached the world-box test. */
  pairsEvaluated: number;
  /** MU × node pairs skipped because the MU grid did not return the MU. */
  gridSkipped: number;
  /** Grid queries run. */
  gridQueries: number;
}

/** Normalized role-pair key for the ignore set (order-independent). */
export function typeKey(roleA: string, roleB: string): string {
  return roleA < roleB ? `${roleA}|${roleB}` : `${roleB}|${roleA}`;
}

// ─── Machining suppression (plan-409) ────────────────────────────────────

/** One (MachiningVolume, MachiningTool) pair as reported by the MachiningManager. */
interface MachiningAssociation {
  readonly toolRoot: Object3D;
  readonly volumeRoot: Object3D;
  /** Spindle state: true = material is being removed, contact is legitimate. */
  active: boolean;
}

/** Bridge the MachiningManager holds to report its associations. */
export interface CollisionMachiningBridge {
  /** (Re-)declare an association and its current spindle state. Idempotent. */
  setMachiningAssociation(
    assocKey: string, toolRoot: Object3D, volumeRoot: Object3D, active: boolean): void;
  /** Drop an association entirely (volume/tool disposed). */
  removeMachiningAssociation(assocKey: string): void;
  /** Force a body rebuild (grid attached/torn down changes the bounds source). */
  invalidate(): void;
}

/** Largest absolute coordinate of two boxes (F20 tolerance input). */
function maxAbsOf(a: Box3, b: Box3): number {
  let m = 0;
  // Unrolled — no array in the tick.
  let x = Math.abs(a.min.x); if (x > m) m = x;
  x = Math.abs(a.min.y); if (x > m) m = x;
  x = Math.abs(a.min.z); if (x > m) m = x;
  x = Math.abs(a.max.x); if (x > m) m = x;
  x = Math.abs(a.max.y); if (x > m) m = x;
  x = Math.abs(a.max.z); if (x > m) m = x;
  x = Math.abs(b.min.x); if (x > m) m = x;
  x = Math.abs(b.min.y); if (x > m) m = x;
  x = Math.abs(b.min.z); if (x > m) m = x;
  x = Math.abs(b.max.x); if (x > m) m = x;
  x = Math.abs(b.max.y); if (x > m) m = x;
  x = Math.abs(b.max.z); if (x > m) m = x;
  return m;
}

// ─── Manager ─────────────────────────────────────────────────────────────

export class RVCollisionManager implements CollisionRoleRegistrar, IMULifecycleHook {
  // ── Registry (authored roles) ──
  private readonly _roles = new Map<Object3D, CollisionRoleName>();
  private readonly _muRoles = new Map<CollisionMU, CollisionRoleName>();
  /** Live stock-extent providers (plan-409 F4) — today only MachiningVolume. */
  private readonly _stockSources = new Set<StockBoundsSource>();

  // ── Seams ──
  private _source: CollisionGeometrySource | null = null;
  private _muQuery: CollisionMUQuery | null = null;
  private readonly _unsubs: Array<() => void> = [];

  // ── Built state ──
  private _bodies: CollisionBody[] = [];
  private _pairs: PairRecord[] = [];
  private _dirty = true;
  /** Body lookup by root node, rebuilt with the bodies (association resolution). */
  private readonly _bodyByRoot = new Map<Object3D, CollisionBody>();
  private readonly _muBodyOf = new Map<CollisionMU, CollisionBody>();
  /**
   * Pair states by key across rebuilds (F17); cleared on model change and
   * baseline reset. Entries naming an MU that no longer exists are pruned at the
   * end of every rebuild — an MU id never returns, so its memory would only grow.
   */
  private readonly _pairMemory = new Map<string, { state: PairStateValue; authoredStill: boolean; lastHit: boolean }>();

  // ── Deferred mutations (F18) ──
  private _inTick = false;
  private _baselinePending = false;
  private readonly _pendingSpawns = new Map<CollisionMU, CollisionRoleName>();
  private readonly _pendingRemovals: CollisionMU[] = [];

  // ── Latched collisions ──
  private readonly _active = new Map<string, ActivePair>();
  private readonly _activeRoots: Object3D[] = [];

  /** Ignored collision TYPES (normalized role-pair keys). Survives reset(). */
  private readonly _ignoredTypes = new Set<string>();

  /** Machining associations (plan-409 F5) — the second, orthogonal muting system. */
  private readonly _assoc = new Map<string, MachiningAssociation>();
  /** Derived from `_assoc` — the tick loop's only suppression input (F7). */
  private _suppressedPairKeys = new Set<string>();
  /** Warn-once for the "role sits on a CHILD of the machining node" case. */
  private _warnedRoleCutoff = false;

  // ── Problems (F6/F7): quiet start overlaps, once per load ──
  private readonly _authored = new Map<string, CollisionOverlapPair & { nodePath?: string }>();
  private readonly _start = new Map<string, CollisionOverlapPair & { nodePath?: string }>();
  private _problemsDirty = false;

  // ── Hosts ──
  private _highlight: CollisionHighlightHost | null = null;
  private _writer: SignalWriter | null = null;
  private _unsubReset: (() => void) | null = null;
  private _prevReset = false;

  // ── Last written signal values (write only on change) ──
  private _lastActive: boolean | null = null;
  private _lastCount: number | null = null;

  // ── Warn-once per model load ──
  private _warnedDeformed = false;
  private _warnedDynamic = false;
  private _warnedInstanced = false;

  // ── Scratch / counters ──
  private readonly _counters: CollisionCounters = {
    ...createNarrowCounters(), pairsEvaluated: 0, gridSkipped: 0, gridQueries: 0,
  };
  private readonly _gridOut: IMUAccessor[] = [];
  private readonly _gridMin = new Float64Array(3);
  private readonly _gridMax = new Float64Array(3);
  private _gridStamp = 0;
  private readonly _gridMark = new Map<CollisionBody, number>();
  private readonly _scratchWitness = createNarrowWitness();

  // ─── Registration ──────────────────────────────────────────────────

  /** IMPLEMENTS CollisionRoleRegistrar::register */
  register(node: Object3D, role: CollisionRoleName): void {
    const next = toCollisionRole(role);
    if (this._roles.get(node) === next) return;
    this._roles.set(node, next);
    this._dirty = true;
  }

  /** IMPLEMENTS CollisionRoleRegistrar::unregister */
  unregister(node: Object3D): void {
    if (this._roles.delete(node)) this._dirty = true;
  }

  /** IMPLEMENTS CollisionRoleRegistrar::registerStockBounds */
  registerStockBounds(source: StockBoundsSource): void {
    if (this._stockSources.has(source)) return;
    this._stockSources.add(source);
    this._dirty = true;
  }

  /** IMPLEMENTS CollisionRoleRegistrar::unregisterStockBounds */
  unregisterStockBounds(source: StockBoundsSource): void {
    if (this._stockSources.delete(source)) this._dirty = true;
  }

  /** Role currently registered for a node (`'None'` when unknown). */
  roleOf(node: Object3D): CollisionRoleName {
    return this._roles.get(node) ?? 'None';
  }

  /**
   * IMPLEMENTS IMULifecycleHook::onMUSpawned
   *
   * Incremental (F9): the MU's body and its pairs are added at the next tick
   * head — no full rebuild.
   */
  onMUSpawned(mu: IMUAccessor, role: CollisionRoleName | string | undefined): void {
    const parsed = toCollisionRole(role);
    if (parsed === 'None') return;
    const m = mu as CollisionMU;
    const known = this._muRoles.get(m);
    this._muRoles.set(m, parsed);
    if (this._dirty) return;
    if (known !== undefined && known !== parsed) { this._dirty = true; return; }
    if (!this._muBodyOf.has(m)) this._pendingSpawns.set(m, parsed);
  }

  /**
   * IMPLEMENTS IMULifecycleHook::onMURemoved
   *
   * Deferred (F18): the body and its pairs are dropped at the next tick head
   * (swap-and-pop), never while the pair list is being iterated.
   */
  onMURemoved(mu: IMUAccessor): void {
    const m = mu as CollisionMU;
    if (!this._muRoles.delete(m)) return;
    if (this._pendingSpawns.delete(m)) return;
    if (this._dirty) return;
    if (this._muBodyOf.has(m)) this._pendingRemovals.push(m);
  }

  /**
   * Force a rebuild at the head of the next tick (F11). Pair states survive it
   * by `pairKey` (F17) — a grip/zone/hold re-parent never re-baselines a real
   * contact.
   */
  invalidate(): void {
    this._dirty = true;
  }

  /** Node visibility changed somewhere: hidden owners are re-split at the next tick head (F12). */
  invalidateVisibility(): void {
    this._dirty = true;
  }

  /**
   * Take the start baseline again (`simulation-reset`, F7). Applied at the next
   * tick head (F18): every pair goes back to `Unknown`, the start-overlap
   * entry is withdrawn and re-derived by the next evaluation.
   */
  resetBaseline(): void {
    this._baselinePending = true;
  }

  // ─── Host wiring ───────────────────────────────────────────────────

  setHighlightHost(host: CollisionHighlightHost | null): void {
    this._highlight = host;
  }

  /**
   * Install the bake registry the bodies are resolved through (instance
   * setter, never a module singleton). `null` = an unbaked context: bodies
   * then consist of real meshes only.
   */
  setGeometrySource(source: CollisionGeometrySource | null): void {
    if (this._source === source) return;
    this._source = source;
    this._dirty = true;
  }

  /** Install the transport's MU grid (F9); `null` = every MU is a candidate. */
  setMUQuery(query: CollisionMUQuery | null): void {
    this._muQuery = query;
  }

  /**
   * Follow the viewer events of the current model (and the registry's
   * placement release). All subscriptions are dropped by `clear()` / `dispose()`
   * (contract plugins 4) — the viewer re-attaches per model.
   */
  attachEvents(subscribe: CollisionEventSubscriber | null): void {
    this._dropSubscriptions();
    if (subscribe) {
      this._unsubs.push(subscribe('simulation-reset', () => this.resetBaseline()));
      this._unsubs.push(subscribe('node-visibility-changed', () => this.invalidateVisibility()));
      this._unsubs.push(subscribe('placements-materialized', () => this.invalidate()));
      this._unsubs.push(subscribe('layout-content-added', () => this.invalidate()));
    }
    if (this._source) this._unsubs.push(this._source.onRelease(() => this.invalidate()));
  }

  private _dropSubscriptions(): void {
    for (const off of this._unsubs.splice(0)) {
      try { off(); } catch { /* a dead subscription must not break the teardown */ }
    }
  }

  /**
   * Attach to a model's SignalStore: register the three signals and subscribe
   * to the reset edge. Detaches a previous store first.
   */
  attachSignals(store: CollisionSignalHost | null): void {
    this._unsubReset?.();
    this._unsubReset = null;
    this._writer = null;
    this._lastActive = null;
    this._lastCount = null;
    this._prevReset = false;
    if (!store) return;

    store.register(SIGNAL_COLLISION_ACTIVE, `${SIGNAL_PATH_PREFIX}/${SIGNAL_COLLISION_ACTIVE}`, false, 'PLCInputBool');
    store.register(SIGNAL_COLLISION_COUNT, `${SIGNAL_PATH_PREFIX}/${SIGNAL_COLLISION_COUNT}`, 0, 'PLCInputInt');
    store.register(SIGNAL_RESET_COLLISIONS, `${SIGNAL_PATH_PREFIX}/${SIGNAL_RESET_COLLISIONS}`, false, 'PLCOutputBool');

    this._writer = createSignalWriter(store, 'component:CollisionManager', 'component', {
      slotContext: SIGNAL_PATH_PREFIX,
    });
    this._prevReset = store.get(SIGNAL_RESET_COLLISIONS) === true;
    this._unsubReset = store.subscribe(SIGNAL_RESET_COLLISIONS, (v) => {
      const now = v === true;
      const rising = now && !this._prevReset;
      this._prevReset = now;
      if (rising) this.reset();
    });
    this._writeSignals();
  }

  // ─── Read-outs ─────────────────────────────────────────────────────

  /** True when the next `update()` will rebuild first. */
  get isDirty(): boolean { return this._dirty; }

  get bodies(): readonly CollisionBody[] { return this._bodies; }
  get pairs(): readonly CrossPair[] { return this._pairs; }

  /** @internal Number of remembered pair states (F17) — the bounded-memory test reads it. */
  get pairMemorySize(): number { return this._pairMemory.size; }

  /** Work counters since the last {@link resetCounters}. */
  get counters(): Readonly<CollisionCounters> { return this._counters; }

  resetCounters(): void {
    resetNarrowCounters(this._counters);
    this._counters.pairsEvaluated = 0;
    this._counters.gridSkipped = 0;
    this._counters.gridQueries = 0;
  }

  /** The state of one pair (tests, diagnostics) — `null` when it is not checked. */
  pairStateOf(aKey: string, bKey: string): { state: 'unknown' | 'baseline' | 'armed'; authoredStill: boolean } | null {
    const key = bodyPairKey(aKey, bKey);
    for (const p of this._pairs) {
      if (p.pairKey !== key) continue;
      const state = p.state === PairState.Unknown ? 'unknown' : p.state === PairState.Baseline ? 'baseline' : 'armed';
      return { state, authoredStill: p.authoredStill };
    }
    return null;
  }

  // ─── Rebuild ───────────────────────────────────────────────────────

  /**
   * Rebuild bodies + pair list. Runs lazily at the head of a tick, so a role
   * change can never race a running check. Pair states survive by `pairKey`
   * (F17); only NEW pairs start `Unknown`.
   */
  rebuild(): void {
    this._dirty = false;
    this._pendingSpawns.clear();
    this._pendingRemovals.length = 0;

    // F17: states survive by key — also for a pair that is absent for a while
    // (a body hidden to zero parts), so its return is never a silent re-baseline.
    const previous = this._pairMemory;
    for (const p of this._pairs) {
      previous.set(p.pairKey, { state: p.state, authoredStill: p.authoredStill, lastHit: p.lastHit });
    }

    this._bodies = [];
    this._bodyByRoot.clear();
    this._muBodyOf.clear();
    const stats = createBodyBuildStats();

    const roots: Object3D[] = [];
    for (const [node, role] of this._roles) if (role !== 'None') roots.push(node);
    const rootSet = new Set(roots);

    const stockByNode = new Map<Object3D, StockBoundsSource[]>();
    for (const src of this._stockSources) {
      const list = stockByNode.get(src.node);
      if (list) list.push(src);
      else stockByNode.set(src.node, [src]);
    }

    // Nodes that declared themselves a stock source keep their authored mesh
    // although their component is `dynamicGeometry` (plan-781 review #1).
    const stockNodes: ReadonlySet<Object3D> = new Set(stockByNode.keys());

    for (const node of roots) {
      // Role roots strictly below `node` — "the robot counts up to the gripper".
      const nested: Object3D[] = [];
      for (const other of roots) {
        if (other === node) continue;
        for (let p = other.parent; p; p = p.parent) {
          if (p === node) { nested.push(other); break; }
        }
      }
      const parts = resolveNodeParts(node, nested, this._source, stats, stockNodes);
      const stockSources: StockBoundsSource[] = [];
      if (stockByNode.size > 0) {
        const walk = (obj: Object3D): void => {
          if (obj !== node && rootSet.has(obj)) return;
          if (obj.userData?._rvMachiningChunks === true) return;
          const stock = stockByNode.get(obj);
          if (stock) for (const s of stock) stockSources.push(s);
          for (const child of obj.children) walk(child);
        };
        walk(node);
      }
      const key = NodeRegistry.computeNodePath(node);
      const body = this._makeBody(node, this._roles.get(node)!, key, node.name || key, 'node', parts, null, stockSources);
      this._bodies.push(body);
      this._bodyByRoot.set(node, body);
    }

    for (const [mu, role] of this._muRoles) {
      const body = this._makeMUBody(mu, role, stats);
      this._bodies.push(body);
      this._muBodyOf.set(mu, body);
    }

    // Ancestor relation (F16) — a body inside another body's subtree. Node
    // bodies only as ancestors; a gripped clone MU hangs under its gripper.
    for (const body of this._bodies) this._fillAncestors(body);

    this._pairs = [];
    for (const p of buildCrossPairs(this._bodies)) {
      const a = this._bodies[p.i];
      const b = this._bodies[p.j];
      if (this._ignoredTypes.has(typeKey(a.role, b.role))) continue;
      if (!this._isPairCandidate(a) || !this._isPairCandidate(b)) continue;
      const record = this._addPair(p.i, p.j, p.pairKey);
      const prev = previous.get(p.pairKey);
      if (prev) {
        record.state = prev.state;
        record.authoredStill = prev.authoredStill;
        record.lastHit = prev.lastHit;
        // The geometry may differ after a rebuild — evaluate once even without motion.
        record.retest = true;
      }
    }

    this._pruneMemory();
    this._recomputeSuppressedPairs();
    this._warnExcluded(stats);
    debug('sensor', `[collision] rebuild: ${this._bodies.length} bodies, ${this._pairs.length} pairs`);
  }

  /**
   * Drop remembered pair states of MUs that are gone (review #4). A NODE key is
   * kept even while its body is absent (F17: a role node hidden to zero parts or
   * re-registered must not come back as a silent re-baseline); the node keys of
   * one model are bounded and dropped with the model. Rebuild-only — may allocate.
   */
  private _pruneMemory(): void {
    const memory = this._pairMemory;
    if (memory.size === 0) return;
    const liveMU = new Set<string>();
    for (const body of this._muBodyOf.values()) liveMU.add(body.key);
    for (const key of memory.keys()) {
      const sep = key.indexOf(KEY_SEP);
      const a = sep < 0 ? key : key.slice(0, sep);
      const b = sep < 0 ? '' : key.slice(sep + 1);
      if ((a.startsWith(MU_KEY_PREFIX) && !liveMU.has(a)) || (b.startsWith(MU_KEY_PREFIX) && !liveMU.has(b))) {
        memory.delete(key);
      }
    }
  }

  private _makeBody(
    root: Object3D, role: CollisionRoleName, key: string, label: string, kind: 'node' | 'mu',
    parts: BodyPart[], mu: CollisionMU | null, stockSources: StockBoundsSource[],
  ): CollisionBody {
    const worldBox = new Box3();
    for (const p of parts) worldBox.union(p.worldBox);
    return {
      root, role, key, label, kind, parts, mu,
      worldBox,
      stockSources,
      ancestorBodies: new Set<CollisionBody>(),
      mobile: kind === 'mu' || parts.some((p) => p.mobile),
      moved: false,
      stockActive: false,
      _index: this._bodies.length,
      _pairs: [],
      _muPairs: [],
      _stockPrev: new Float64Array(7),
    };
  }

  private _makeMUBody(mu: CollisionMU, role: CollisionRoleName, stats: BodyBuildStats): CollisionBody {
    const parts = resolveMUParts(mu, stats);
    // An MU is never a machining stock (MachiningVolume.tools are scene
    // components, never MUs — documented v1 limit).
    return this._makeBody(mu.node, role, `${MU_KEY_PREFIX}${(mu as unknown as { id: number }).id}`, mu.getName(), 'mu', parts, mu, []);
  }

  private _fillAncestors(body: CollisionBody): void {
    body.ancestorBodies.clear();
    for (let p: Object3D | null = body.root.parent; p; p = p.parent) {
      const owner = this._bodyByRoot.get(p);
      if (owner && owner !== body) body.ancestorBodies.add(owner);
    }
  }

  /** A body without parts and without a stock source produces no pairs. */
  private _isPairCandidate(body: CollisionBody): boolean {
    return body.parts.length > 0 || body.stockSources.length > 0;
  }

  private _addPair(i: number, j: number, pairKey: string): PairRecord {
    const a = this._bodies[i];
    const b = this._bodies[j];
    const muNode = a.kind === 'node' && b.kind === 'mu' ? a : b.kind === 'node' && a.kind === 'mu' ? b : null;
    const record: PairRecord = {
      i, j, pairKey,
      slot: this._pairs.length,
      state: PairState.Unknown,
      authoredStill: false,
      lastHit: false,
      retest: false,
      muNode,
      muBody: muNode === null ? null : muNode === a ? b : a,
      witness: createNarrowWitness(),
      witnessA: -1,
      witnessB: -1,
    };
    this._pairs.push(record);
    a._pairs.push(record);
    b._pairs.push(record);
    if (muNode) muNode._muPairs.push(record);
    return record;
  }

  private _removePair(record: PairRecord): void {
    const last = this._pairs.pop()!;
    if (last !== record) {
      this._pairs[record.slot] = last;
      last.slot = record.slot;
    }
    removeFrom(this._bodies[record.i]._pairs, record);
    removeFrom(this._bodies[record.j]._pairs, record);
    if (record.muNode) removeFrom(record.muNode._muPairs, record);
    this._pairMemory.delete(record.pairKey);
    if (this._authored.delete(record.pairKey)) this._problemsDirty = true;
    if (this._start.delete(record.pairKey)) this._problemsDirty = true;
  }

  // ─── Incremental MU bodies (F9) ────────────────────────────────────

  private _applySpawn(mu: CollisionMU, role: CollisionRoleName): void {
    if (this._muBodyOf.has(mu)) return;
    const body = this._makeMUBody(mu, role, createBodyBuildStats());
    body._index = this._bodies.length;
    this._bodies.push(body);
    this._muBodyOf.set(mu, body);
    this._fillAncestors(body);
    if (!this._isPairCandidate(body)) return;
    for (let k = 0; k < body._index; k++) {
      const other = this._bodies[k];
      if (!isPairable(other, body)) continue;
      if (!this._isPairCandidate(other)) continue;
      if (this._ignoredTypes.has(typeKey(other.role, body.role))) continue;
      this._addPair(k, body._index, bodyPairKey(other.key, body.key));
    }
  }

  private _applyRemoval(mu: CollisionMU): void {
    const body = this._muBodyOf.get(mu);
    if (!body) return;
    this._muBodyOf.delete(mu);
    while (body._pairs.length > 0) this._removePair(body._pairs[body._pairs.length - 1]);
    const last = this._bodies.pop()!;
    if (last !== body) {
      const from = last._index;
      const to = body._index;
      this._bodies[to] = last;
      last._index = to;
      for (const p of last._pairs) {
        if (p.i === from) p.i = to;
        if (p.j === from) p.j = to;
      }
    }
  }

  private _warnExcluded(stats: BodyBuildStats): void {
    if (stats.deformed > 0 && !this._warnedDeformed) {
      this._warnedDeformed = true;
      console.warn(
        `[CollisionManager] ${stats.deformed} deformed mesh(es) (SkinnedMesh / morph targets / `
        + '_rvSkipBVH) are excluded from collision checking — their geometry moves under any '
        + 'cached structure. Energy chains are a known blind spot.',
      );
    }
    if (stats.dynamic > 0 && !this._warnedDynamic) {
      this._warnedDynamic = true;
      console.warn(
        `[CollisionManager] ${stats.dynamic} mesh(es) with rewritten geometry (dynamicGeometry: `
        + 'ribbon band, energy chain) are excluded from collision checking.',
      );
    }
    if (stats.instanced > 0 && !this._warnedInstanced) {
      this._warnedInstanced = true;
      console.warn(
        `[CollisionManager] ${stats.instanced} GPU-instanced mesh(es) inside collision bodies are `
        + 'excluded — one geometry with many poses is not one body part.',
      );
    }
  }

  // ─── Per-tick ──────────────────────────────────────────────────────

  /**
   * One collision tick. Returns true when the visual state changed (new
   * latch), so the caller can mark the frame dirty.
   *
   * A collision found here is reported in THIS call — there is deliberately no
   * time budget or round-robin that would push the report past a tick boundary.
   */
  update(_dt: number): boolean {
    if (this._inTick) return false;
    this._inTick = true;
    try {
      return this._tick();
    } finally {
      this._inTick = false;
    }
  }

  private _tick(): boolean {
    this._applyDeferred();
    if (this._pairs.length === 0) {
      if (this._problemsDirty) this._publishProblems();
      this._writeSignals();
      return false;
    }

    const bodies = this._bodies;
    for (let i = 0; i < bodies.length; i++) this.updateBodyBounds(bodies[i]);

    let added = false;
    const pairs = this._pairs;
    for (let k = 0; k < pairs.length; k++) {
      const p = pairs[k];
      if (p.muNode !== null) continue;          // evaluated per node body below
      if (this._evaluate(p, false)) added = true;
    }
    for (let i = 0; i < bodies.length; i++) {
      const n = bodies[i];
      if (n._muPairs.length === 0) continue;
      if (this._evaluateMUPairs(n)) added = true;
    }

    if (this._problemsDirty) this._publishProblems();
    if (added) {
      this._rebuildHighlightRoots();
      this._applyHighlight();
      this._publish();
    }
    this._writeSignals();
    return added;
  }

  /** Deferred mutations of the last tick (F18), in a fixed order. */
  private _applyDeferred(): void {
    if (this._dirty) {
      this.rebuild();
    } else {
      if (this._pendingRemovals.length > 0) {
        for (const mu of this._pendingRemovals) this._applyRemoval(mu);
        this._pendingRemovals.length = 0;
      }
      if (this._pendingSpawns.size > 0) {
        for (const [mu, role] of this._pendingSpawns) this._applySpawn(mu, role);
        this._pendingSpawns.clear();
      }
    }
    if (this._baselinePending) {
      this._baselinePending = false;
      this._pairMemory.clear();
      for (const p of this._pairs) {
        p.state = PairState.Unknown;
        p.authoredStill = false;
        p.lastHit = false;
        p.retest = true;
        p.witness.valid = false;
      }
      if (this._start.size > 0 || this._authored.size > 0) {
        this._start.clear();
        this._authored.clear();
        this._problemsDirty = true;
      }
    }
  }

  /** MU × node pairs of node body `n`, prefiltered by the MU grid (F9). */
  private _evaluateMUPairs(n: CollisionBody): boolean {
    const list = n._muPairs;
    const useGrid = this._muQuery !== null && list.length >= GRID_MIN_PAIRS;
    let stamp = -1;
    let added = false;
    for (let k = 0; k < list.length; k++) {
      const p = list[k];
      let gridMiss = false;
      if (useGrid && this._needsEvaluation(p)) {
        if (stamp < 0) stamp = this._queryGrid(n);
        gridMiss = this._gridMark.get(p.muBody!) !== stamp;
      }
      if (this._evaluate(p, gridMiss)) added = true;
    }
    return added;
  }

  /** Mark every MU body the grid returns for `n`'s world box; returns the stamp. */
  private _queryGrid(n: CollisionBody): number {
    const stamp = ++this._gridStamp;
    this._counters.gridQueries++;
    const box = n.worldBox;
    if (box.isEmpty()) return stamp;
    this._gridMin[0] = box.min.x - GRID_SLACK_M;
    this._gridMin[1] = box.min.y - GRID_SLACK_M;
    this._gridMin[2] = box.min.z - GRID_SLACK_M;
    this._gridMax[0] = box.max.x + GRID_SLACK_M;
    this._gridMax[1] = box.max.y + GRID_SLACK_M;
    this._gridMax[2] = box.max.z + GRID_SLACK_M;
    const out = this._gridOut;
    const count = this._muQuery!.queryMUsXZ(this._gridMin, this._gridMax, out);
    for (let i = 0; i < count; i++) {
      const body = this._muBodyOf.get(out[i] as CollisionMU);
      if (body) this._gridMark.set(body, stamp);
    }
    out.length = 0;
    return stamp;
  }

  /** Would {@link _evaluate} run the test for this pair this tick? */
  private _needsEvaluation(p: PairRecord): boolean {
    if (this._suppressedPairKeys.size > 0 && this._suppressedPairKeys.has(p.pairKey)) return false;
    if (this._active.has(p.pairKey)) return false;
    return p.state === PairState.Unknown || p.retest || this._bodies[p.i].moved || this._bodies[p.j].moved;
  }

  /**
   * Evaluate one pair: skip rules, the test, the state machine. Returns true
   * when the pair LATCHED in this call. `gridMiss` = the MU grid proved the
   * pair apart (the test is skipped, the result is "no hit").
   */
  private _evaluate(p: PairRecord, gridMiss: boolean): boolean {
    const key = p.pairKey;
    // plan-409 F5/F7 — legitimate cutting. A muted pair is never baselined: the
    // machining configuration is an authoritative statement about it, so it is
    // armed and alarms the moment the spindle stops inside the material.
    if (this._suppressedPairKeys.size > 0 && this._suppressedPairKeys.has(key)) {
      if (p.state === PairState.Unknown) p.state = PairState.Armed;
      p.retest = true;
      return false;
    }
    // F10: an already latched pair needs no narrowphase.
    if (this._active.has(key)) return false;
    const a = this._bodies[p.i];
    const b = this._bodies[p.j];
    if (!(p.state === PairState.Unknown || p.retest || a.moved || b.moved)) {
      // Nothing moved and the state is known: the last result stands.
      if (p.state === PairState.Armed && p.lastHit) return this._recordPair(a, b);
      return false;
    }
    p.retest = false;
    let hit = false;
    if (gridMiss) this._counters.gridSkipped++;
    else hit = this._test(p, a, b);
    p.lastHit = hit;

    switch (p.state) {
      case PairState.Unknown:
        if (!hit) { p.state = PairState.Armed; return false; }
        p.state = PairState.Baseline;
        p.authoredStill = !a.mobile && !b.mobile && !a.moved && !b.moved;
        this._recordOverlap(p, a, b, p.authoredStill);
        return false;
      case PairState.Baseline:
        if (p.authoredStill && (a.moved || b.moved)) {
          // A still pair whose body moved: still overlapping → a start contact.
          p.authoredStill = false;
          if (hit) {
            this._authored.delete(key);
            this._recordOverlap(p, a, b, false);
            return false;
          }
        }
        if (!hit) { p.state = PairState.Armed; p.authoredStill = false; }
        return false;
      default:
        return hit ? this._recordPair(a, b) : false;
    }
  }

  /** Box test, then the exact narrowphase over the visible parts. */
  private _test(p: PairRecord, a: CollisionBody, b: CollisionBody): boolean {
    this._counters.pairsEvaluated++;
    if (!a.worldBox.intersectsBox(b.worldBox)) return false;
    // A stock box has no triangles: the box overlap IS the answer (plan-409 F4).
    if (a.stockActive || b.stockActive) return true;
    const ap = a.parts;
    const bp = b.parts;
    // Witness part pair first (temporal coherence).
    // Only a VALID witness takes its part pair out of the loop below.
    const useWitness = p.witness.valid && p.witnessA >= 0 && p.witnessB >= 0
      && p.witnessA < ap.length && p.witnessB < bp.length;
    const wa = useWitness ? p.witnessA : -1;
    const wb = useWitness ? p.witnessB : -1;
    if (useWitness && this._partPair(ap[wa], bp[wb], p.witness)) return true;
    for (let ia = 0; ia < ap.length; ia++) {
      const pa = ap[ia];
      if (!pa.visible) continue;
      for (let ib = 0; ib < bp.length; ib++) {
        if (ia === wa && ib === wb) continue;
        const pb = bp[ib];
        if (!pb.visible) continue;
        const w = this._scratchWitness;
        w.valid = false;
        if (this._partPair(pa, pb, w)) {
          p.witness.valid = w.valid;
          p.witness.aStart = w.aStart; p.witness.aEnd = w.aEnd;
          p.witness.bStart = w.bStart; p.witness.bEnd = w.bEnd;
          p.witnessA = ia;
          p.witnessB = ib;
          return true;
        }
      }
    }
    return false;
  }

  private _partPair(pa: BodyPart, pb: BodyPart, w: NarrowWitness): boolean {
    if (!pa.visible || !pb.visible) return false;
    if (!pa.worldBox.intersectsBox(pb.worldBox)) return false;
    const eps = touchEpsFor(maxAbsOf(pa.worldBox, pb.worldBox));
    return partsOverlap(pa, pb, MARGIN_M, eps, this._counters, w);
  }

  /**
   * Refresh a body for this tick: fresh part poses (F16), motion stamps (F5),
   * part visibility (F12), the union world box and the live stock box (plan-409
   * F4). Public for the bounds tests; called for every body at the tick head.
   */
  updateBodyBounds(body: CollisionBody): void {
    body.moved = false;
    body.worldBox.makeEmpty();

    // plan-409 F4 — a live stock extent, asked for EVERY tick: `attachGrid()`
    // runs asynchronously, normally AFTER the first rebuild.
    let stockActive = false;
    const prev = body._stockPrev;
    if (body.stockSources.length > 0) {
      for (const src of body.stockSources) {
        const local = src.getStockBoundsLocal();
        if (!local) continue;               // no grid → the meshes speak again
        _stockBox.copy(local).applyMatrix4(freshWorldMatrix(src.node, _stockMatrix));
        body.worldBox.union(_stockBox);
        stockActive = true;
      }
      const wb = body.worldBox;
      if (stockActive !== (prev[6] === 1)
        || (stockActive && (prev[0] !== wb.min.x || prev[1] !== wb.min.y || prev[2] !== wb.min.z
          || prev[3] !== wb.max.x || prev[4] !== wb.max.y || prev[5] !== wb.max.z))) {
        body.moved = true;
        prev[0] = wb.min.x; prev[1] = wb.min.y; prev[2] = wb.min.z;
        prev[3] = wb.max.x; prev[4] = wb.max.y; prev[5] = wb.max.z;
        prev[6] = stockActive ? 1 : 0;
      }
    }
    body.stockActive = stockActive;

    const parts = body.parts;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const visible = partVisible(part);
      if (visible !== part.visible) {
        part.visible = visible;
        body.moved = true;
      }
      if (!visible) { part.moved = false; continue; }
      refreshPartPose(part);
      part.moved = stampMotion(part);
      if (part.moved) {
        updatePartWorldBox(part);
        body.moved = true;
      }
      body.worldBox.union(part.worldBox);
    }
  }

  /** Marks a pair as hit and adds it to the latched set when new. True when new. */
  private _recordPair(a: CollisionBody, b: CollisionBody): boolean {
    const key = bodyPairKey(a.key, b.key);
    if (this._active.has(key)) return false;
    this._active.set(key, {
      view: {
        aPath: a.label, aRole: a.role,
        bPath: b.label, bRole: b.role,
        aKey: a.key, bKey: b.key,
        since: performance.now(),
      },
      aRoot: this._highlightRootOf(a),
      bRoot: this._highlightRootOf(b),
    });
    return true;
  }

  /** A quiet start overlap, for the Problems panel (once per load, F6/F7). */
  private _recordOverlap(p: PairRecord, a: CollisionBody, b: CollisionBody, authored: boolean): void {
    const map = authored ? this._authored : this._start;
    if (map.has(p.pairKey)) return;
    // The REAL node path of a node body — never a chunk, partition or `tex:` key
    // (rules 12/13). An MU has none; then the other body's path, or nothing.
    const nodePath = a.kind === 'node' ? a.key : b.kind === 'node' ? b.key : undefined;
    map.set(p.pairKey, { aLabel: a.label, aRole: a.role, bLabel: b.label, bRole: b.role, nodePath });
    this._problemsDirty = true;
  }

  private _publishProblems(): void {
    this._problemsDirty = false;
    const publish = (code: typeof COLLISION_AUTHORED_OVERLAP_CODE | typeof COLLISION_START_OVERLAP_CODE,
      map: Map<string, CollisionOverlapPair & { nodePath?: string }>): void => {
      const list = [...map.values()];
      reportCollisionOverlaps(code, list, list[0]?.nodePath);
    };
    publish(COLLISION_AUTHORED_OVERLAP_CODE, this._authored);
    publish(COLLISION_START_OVERLAP_CODE, this._start);
  }

  /** Instanced MUs share the pool mesh — highlighting it would light up every
   *  instance in the pool, so they contribute no highlight root. */
  private _highlightRootOf(body: CollisionBody): Object3D | null {
    return body.kind === 'mu' && body.mu?.isInstanced ? null : body.root;
  }

  /** Re-derive the aux highlight roots from the CURRENT latched pairs. */
  private _rebuildHighlightRoots(): void {
    this._activeRoots.length = 0;
    for (const ap of this._active.values()) {
      if (ap.aRoot && !this._activeRoots.includes(ap.aRoot)) this._activeRoots.push(ap.aRoot);
      if (ap.bRoot && !this._activeRoots.includes(ap.bRoot)) this._activeRoots.push(ap.bRoot);
    }
  }

  // ─── Reporting ─────────────────────────────────────────────────────

  private _applyHighlight(): void {
    if (this._activeRoots.length > 0) this._highlight?.showCollision(this._activeRoots);
    else this._highlight?.hideCollision();
  }

  /** Re-apply the aux set — e.g. after a workspace-mode change (F15). */
  reapplyHighlight(): void {
    this._applyHighlight();
  }

  private _publish(): void {
    publishCollisionAlert(this.activePairs);
  }

  private _writeSignals(): void {
    if (!this._writer) return;
    const active = this._active.size > 0;
    const count = this._active.size;
    if (this._lastActive !== active) {
      this._lastActive = active;
      this._writer.set(SIGNAL_COLLISION_ACTIVE, active);
    }
    if (this._lastCount !== count) {
      this._lastCount = count;
      this._writer.set(SIGNAL_COLLISION_COUNT, count);
    }
  }

  /** Pairs whose latch was dropped: their last result is stale (F10 skipped them). */
  private _retestUnlatched(keys: Iterable<string>): void {
    const set = keys instanceof Set ? keys : new Set(keys);
    if (set.size === 0) return;
    for (const p of this._pairs) if (set.has(p.pairKey)) p.retest = true;
  }

  // ─── Machining suppression (plan-409) ───────────────────────────────

  /** Body-pair keys currently muted by an active machining association. */
  get suppressedPairKeys(): ReadonlySet<string> { return this._suppressedPairKeys; }

  /**
   * IMPLEMENTS CollisionMachiningBridge::setMachiningAssociation
   *
   * STATE-based, not edge-based: the caller reports the association's current
   * spindle state, including the very first one at scene-ready.
   */
  setMachiningAssociation(
    assocKey: string, toolRoot: Object3D, volumeRoot: Object3D, active: boolean,
  ): void {
    const existing = this._assoc.get(assocKey);
    if (existing && existing.toolRoot === toolRoot && existing.volumeRoot === volumeRoot) {
      if (existing.active === active) return;
      existing.active = active;
    } else {
      this._assoc.set(assocKey, { toolRoot, volumeRoot, active });
    }
    this._recomputeSuppressedPairs();
  }

  /** IMPLEMENTS CollisionMachiningBridge::removeMachiningAssociation */
  removeMachiningAssociation(assocKey: string): void {
    if (!this._assoc.delete(assocKey)) return;
    this._recomputeSuppressedPairs();
  }

  /**
   * Re-derive `_suppressedPairKeys` from the association registry — on every
   * association change AND at the end of every rebuild, never in the tick.
   * Newly muted pairs are UNLATCHED here (F8); pairs leaving the muted set are
   * re-tested, because the tick skipped them while muted.
   */
  private _recomputeSuppressedPairs(): void {
    const next = new Set<string>();
    for (const assoc of this._assoc.values()) {
      if (!assoc.active) continue;
      const toolBody = this._resolveBody(assoc.toolRoot);
      const volumeBody = this._resolveBody(assoc.volumeRoot);
      if (!toolBody || !volumeBody || toolBody === volumeBody) continue;
      next.add(bodyPairKey(toolBody.key, volumeBody.key));
    }

    let removed = false;
    for (const key of next) {
      if (this._suppressedPairKeys.has(key)) continue;
      if (this._active.delete(key)) removed = true;
    }
    const unmuted: string[] = [];
    for (const key of this._suppressedPairKeys) if (!next.has(key)) unmuted.push(key);
    this._suppressedPairKeys = next;
    this._retestUnlatched(unmuted);

    if (removed) {
      this._rebuildHighlightRoots();
      this._applyHighlight();
      this._publish();
      this._writeSignals();
    }
  }

  /**
   * Body owning `node`: the NEAREST role-carrying ancestor, `node` itself
   * included. A role on a CHILD of the machining node mutes nothing — that is
   * diagnosed once.
   */
  private _resolveBody(node: Object3D): CollisionBody | null {
    let p: Object3D | null = node;
    while (p) {
      const body = this._bodyByRoot.get(p);
      if (body) return body;
      p = p.parent;
    }
    if (!this._warnedRoleCutoff && this._bodies.length > 0 && this._hasRoleDescendant(node)) {
      this._warnedRoleCutoff = true;
      console.warn(
        `[CollisionManager] machining node "${node.name}" has no CollisionRole on itself or on `
        + 'any ancestor — only on a CHILD. The cutter/workpiece contact of that machining setup '
        + 'is therefore NOT suppressed while the spindle runs. Move the CollisionRole up to the '
        + 'MachiningTool / MachiningVolume node (or an ancestor of it).',
      );
    }
    return null;
  }

  /** True when a strict descendant of `node` carries a role (cutoff diagnosis). */
  private _hasRoleDescendant(node: Object3D): boolean {
    for (const [roleNode, role] of this._roles) {
      if (role === 'None' || roleNode === node) continue;
      let p: Object3D | null = roleNode.parent;
      while (p) {
        if (p === node) return true;
        p = p.parent;
      }
    }
    return false;
  }

  // ─── Ignore types (user decision 2026-08-07) ────────────────────

  /** Role-pair types currently ignored for this run (normalized keys). */
  get ignoredTypes(): ReadonlySet<string> { return this._ignoredTypes; }

  /**
   * Ignore a collision TYPE (role pair) for the rest of the current run:
   * matching pairs and latches are dropped at once, and the Problems entries are
   * re-published without that type. Survives reset(); wiped on model change.
   */
  ignoreType(roleA: string, roleB: string): void {
    const key = typeKey(roleA, roleB);
    if (this._ignoredTypes.has(key)) return;
    this._ignoredTypes.add(key);
    for (let k = this._pairs.length - 1; k >= 0; k--) {
      const p = this._pairs[k];
      if (typeKey(this._bodies[p.i].role, this._bodies[p.j].role) === key) this._removePair(p);
    }
    let removed = false;
    for (const [k, ap] of this._active) {
      if (typeKey(ap.view.aRole, ap.view.bRole) === key) {
        this._active.delete(k);
        removed = true;
      }
    }
    for (const map of [this._authored, this._start]) {
      for (const [k, info] of map) {
        if (typeKey(info.aRole, info.bRole) === key) { map.delete(k); this._problemsDirty = true; }
      }
    }
    if (this._problemsDirty && !this._inTick) this._publishProblems();
    if (removed) {
      this._rebuildHighlightRoots();
      this._applyHighlight();
      this._publish();
      this._writeSignals();
    }
  }

  /**
   * Acknowledge ONE latched pair (the card's OK). A pair whose geometry still
   * intersects is re-detected on the very next tick. Unknown keys are a no-op.
   */
  acknowledge(aKey: string, bKey: string): void {
    const key = bodyPairKey(aKey, bKey);
    if (!this._active.delete(key)) return;
    this._retestUnlatched([key]);
    this._rebuildHighlightRoots();
    this._applyHighlight();
    this._publish();
    this._writeSignals();
  }

  // ─── Reset / lifecycle ─────────────────────────────────────────────

  /** Snapshot of the latched pairs (persist until acknowledge/ignore/reset). */
  get activePairs(): readonly CollisionPairView[] {
    const views: CollisionPairView[] = [];
    for (const ap of this._active.values()) views.push(ap.view);
    return views;
  }

  /**
   * Clear the reported state (highlights, cards, signals) — the PLC-side
   * `ResetCollisions` edge and teardown paths. Pair states stay: an Armed pair
   * that still intersects re-latches on the next tick. Never touches the
   * simulation.
   */
  reset(): void {
    this._retestUnlatched([...this._active.keys()]);
    this._active.clear();
    this._activeRoots.length = 0;
    this._highlight?.hideCollision();
    publishCollisionAlert([]);
    this._writeSignals();
  }

  /** Model change: drop the whole registry and every reported state (F12). */
  clear(): void {
    this._dropSubscriptions();
    this._roles.clear();
    this._muRoles.clear();
    this._stockSources.clear();
    // Registry and derived set go BEFORE the geometry teardown so a late
    // association report from a disposing volume cannot resurrect either.
    this._assoc.clear();
    this._suppressedPairKeys = new Set<string>();
    this._bodyByRoot.clear();
    this._muBodyOf.clear();
    this._gridMark.clear();
    this._pairMemory.clear();
    this._pendingSpawns.clear();
    this._pendingRemovals.length = 0;
    this._baselinePending = false;
    this._bodies = [];
    this._pairs = [];
    this._dirty = true;
    this._warnedDeformed = false;
    this._warnedDynamic = false;
    this._warnedInstanced = false;
    this._warnedRoleCutoff = false;
    this._active.clear();
    this._activeRoots.length = 0;
    this._ignoredTypes.clear();
    this._authored.clear();
    this._start.clear();
    this._problemsDirty = false;
    clearCollisionOverlapProblems();
    this._highlight?.hideCollision();
    publishCollisionAlert([]);
    this.attachSignals(null);
  }

  /** Viewer teardown. */
  dispose(): void {
    this.clear();
    this._highlight = null;
    this._source = null;
    this._muQuery = null;
  }
}

function removeFrom<T>(list: T[], item: T): void {
  const i = list.indexOf(item);
  if (i < 0) return;
  const last = list.pop()!;
  if (i < list.length) list[i] = last;
}
