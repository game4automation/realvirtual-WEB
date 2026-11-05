// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-zone.ts — RVZone, the web-authored effect box (plan-521).
 *
 * A Zone is a box (`Center`/`Size`, local glTF millimetres) on a node; it moves
 * with the node and carries any combination of three effects on MUs:
 *
 *  - **Detect** — `occupied` while an MU overlaps the box (with `Block`: the box
 *    grown by {@link CONTACT_TOL_M} per side, so a part arrested in front of it
 *    stays occupied) or while the zone holds an MU; optional `SignalOccupied`.
 *  - **Block** — kinematically transported, not held MUs stop at contact. The
 *    contact rule is the one `TransportStopper` uses ({@link sweptClamp}).
 *  - **Hold** — contained MUs are taken off the transport and attached to the
 *    zone node (owner tag `heldBy = 'zone'`, shared kernel `rv-mu-hold.ts`).
 *
 * The effects act only while the zone is ACTIVE: `Always`, while a bool signal
 * is true (`Signal`, optionally inverted), or while a drive stands still inside
 * a position window (`Axis`).
 *
 * Tick contract (plan-521 §2.4) — the transport manager drives it in three parts:
 *  1. before the MU loop: {@link RVZone.beginTick} — box, activation, Hold
 *     release on the falling edge and Hold acquire on the rising edge
 *     (`OnActivate`) or every active tick (`WhileActive`), on the MU AABBs of
 *     the previous tick;
 *  2. inside the MU loop: {@link RVZone.clampTravel} (Block);
 *  3. after the MU AABB/grid update: {@link RVZone.evaluateDetect}.
 *
 * Authority: DES never runs the transport manager; a multiuser follower sets
 * `isOwner = false`, and such a zone computes only its box and gizmo.
 *
 * **SingleRelease** (plan-530) — opt-in on a Block zone that rides on a stopper:
 * one MU per lowering; the follower is caught at the raised stopper face even
 * when it touches the released MU (belt `MinGap` 0). Effective only while
 * `SingleRelease && Block && !Hold && isOwner` (one shared guard).
 *  - **Home box** — fixed, from the init pose: `init()` stores the node's world
 *    matrix (`_homeMatrix`); the home box is `localBounds × _homeMatrix`. It is
 *    never taken from the current stroke; reapplyConfig / reset / owner change
 *    only recompute it from the stored matrix. A stopper must START raised. A
 *    zone registered without `init()` takes the pose of its first owner tick.
 *  - **Armed → Released** only on a GEOMETRIC departure: the box left the
 *    home box by more than {@link HOME_TOL_M}; **Released → Armed** when it is
 *    back home (token cleared, `_releaseUsed` reset).
 *  - **Inactive = completely off** (plan-539 F13): a zone made inactive by its
 *    activation (`Signal` / `Axis` false) blocks nothing — no home-face
 *    blocking, no Detect, token cleared — and is back in Armed for the next
 *    activation (Released again at once if its box is still away from home).
 *  - **Token** — assigned only in `beginTick` (never in `clampTravel`) to the
 *    eligible MU whose leading face waits at the ENTRY face of the home box
 *    (direction from its surface, dominant axis; nearest first, tie-break
 *    smallest `id`). Once `_releaseUsed` is set no second token is issued in
 *    this lowering — not even when the token MU is disposed.
 *  - **Clamp while Released** — the token MU sees the plain Block rule on the
 *    actual box; every other eligible MU is clamped at the home box (one that
 *    already overlaps it may only continue when its leading face is past the
 *    EXIT face on the dominant axis), then at the actual box while active.
 *    Ineligible MUs (instanced, physics-owned, held, loaded, removed) see the
 *    plain rule only.
 *  - **Detect while Released** also counts eligible MUs at the home box, so a
 *    follower waiting at the face reports `occupied` while the stopper is down.
 *  - The transport manager keeps a Released zone in its blocker list (a
 *    Released zone is always active). Carried motion (lift travel) is not
 *    gated, like plain Block.
 *
 * Naming disambiguation: NOT `ZoneRegistry` (rv-zone-registry.ts, AGV path
 * capacity) and NOT `RVPhysicsZone` (rigid-body volume).
 */

import { Box3, Matrix4, Vector3 } from 'three';
import type { Object3D } from 'three';
import type { ComponentContext, ComponentSchema, RVComponent } from './rv-component-registry';
import { loadSchemaFromSpec, registerComponent, setComponentInstance } from './rv-component-registry';
import type { RVMovingUnit, InstancedMovingUnit } from './rv-mu';
import type { AABB } from './rv-aabb';
import type { RVDrive } from './rv-drive';
import type { RVGripTarget } from './rv-grip-target';
import type { RVTransportSurface } from './rv-transport-surface';
import type { MULoadHost } from './rv-mu-load';
import type { GizmoHandle, GizmoOverlayManager } from './rv-gizmo-manager';
import { createSignalWriter, type SignalWriter } from './rv-signal-store';
import { wireBoolSignal } from './rv-signal-wiring';
import { slotBound, slotDeclare, slotRefuse, slotUndeclare, slotWrite } from './rv-slot-io';
import { NodeRegistry } from './rv-node-registry';
import { sweptClamp } from './rv-swept-aabb';
import {
  detachMU, findNearestGripTarget, hasUniformWorldScale, holdMU, placeOnGripTarget, sceneRootOf,
} from './rv-mu-hold';
import { zoneRuleWarnings } from './rv-extras-validator';
import { debug } from './rv-debug';

type AnyMU = RVMovingUnit | InstancedMovingUnit;

/** Contact tolerance (m): Detect with Block grows the box by this per side; Hold
 *  containment accepts an MU that sticks out by at most this much. */
export const CONTACT_TOL_M = 0.001;
/** SingleRelease (plan-530): the box counts as "left home" once any min/max
 *  coordinate differs from the home box by more than this (m). */
export const HOME_TOL_M = 0.001;
/** Release onto a surface (plan-570 F8): an MU whose bottom ended up at most this
 *  far (m) BELOW the surface top is put onto the top as well (lift latency). */
export const RELEASE_SNAP_UP_M = 0.005;
/** Axis standstill: position change per tick below this counts as standing (mm | deg). */
const AXIS_STILL_EPS = 1e-3;

/** Box-gizmo colours (plan-521 §3.2). */
export const ZONE_COLOR_BLOCK = 0xe88a32;  // orange, like the TransportStopper badge
export const ZONE_COLOR_HOLD = 0x9c6ade;   // violet
export const ZONE_COLOR_DETECT = 0x4caf50; // green

/**
 * What a zone needs from the transport manager. Structural, so tests may pass
 * their own; `RVTransportManager` implements it.
 */
export interface ZoneHost extends MULoadHost {
  readonly surfaces: readonly RVTransportSurface[];
  readonly gripTargets: readonly RVGripTarget[];
  /**
   * MU candidates for a box query: every MU whose indexed AABB overlaps `box`
   * in XZ (grid path) or simply all live MUs (small scenes). Callers still run
   * their own exact 3D test. The returned array is scratch, valid until the
   * next call.
   */
  zoneCandidates(box: Box3): readonly AnyMU[];
}

// Module scratch — single-threaded reuse, no GC in the tick.
const _grown = new Box3();
const _center = new Vector3();
const _muPos = new Vector3();
const _grownHome = new Box3();
const _surfDir = new Vector3();

const AXES = ['x', 'y', 'z'] as const;
type Axis = typeof AXES[number];

/** Strict 3D overlap of a Box3 and an MU AABB (touching faces do not count). */
function boxOverlapsStrict(box: Box3, a: AABB): boolean {
  return a.min.x < box.max.x && a.max.x > box.min.x
    && a.min.y < box.max.y && a.max.y > box.min.y
    && a.min.z < box.max.z && a.max.z > box.min.z;
}

/** Every min/max coordinate of `a` lies within `tol` of the one of `b`. */
function boxNear(a: Box3, b: Box3, tol: number): boolean {
  return Math.abs(a.min.x - b.min.x) <= tol && Math.abs(a.min.y - b.min.y) <= tol
    && Math.abs(a.min.z - b.min.z) <= tol && Math.abs(a.max.x - b.max.x) <= tol
    && Math.abs(a.max.y - b.max.y) <= tol && Math.abs(a.max.z - b.max.z) <= tol;
}

/** Dominant axis of a direction vector (ties: x before y before z). */
function dominantAxis(d: Vector3): Axis {
  const ax = Math.abs(d.x), ay = Math.abs(d.y), az = Math.abs(d.z);
  if (ax >= ay && ax >= az) return 'x';
  return ay >= az ? 'y' : 'z';
}

/**
 * SingleRelease eligibility (plan-530 F3) — the ONE filter used by the token
 * search, the clamp and Detect: a kinematically transported clone MU that no
 * other subsystem owns. Every other MU sees the plain Block rule.
 */
function singleReleaseEligible(c: AnyMU): boolean {
  // Box2D-owned MUs (plan-661) stay eligible: a 2D zone moves them in the
  // plane, the pose is current every tick. Only Rapier bodies are excluded.
  if (c.isInstanced || c.owner === 'rapier' || c.markedForRemoval) return false;
  const mu = c as RVMovingUnit;
  return mu.heldBy === null && !mu.loadedOn;
}

/** 3D overlap of a Box3 and an MU AABB (boundary-inclusive). */
function boxOverlaps(box: Box3, a: AABB): boolean {
  return a.min.x <= box.max.x && a.max.x >= box.min.x
    && a.min.y <= box.max.y && a.max.y >= box.min.y
    && a.min.z <= box.max.z && a.max.z >= box.min.z;
}

/** `a` lies inside `box` (the box already carries any tolerance). */
function boxContains(box: Box3, a: AABB): boolean {
  return a.min.x >= box.min.x && a.max.x <= box.max.x
    && a.min.y >= box.min.y && a.max.y <= box.max.y
    && a.min.z >= box.min.z && a.max.z <= box.max.z;
}

export class RVZone implements RVComponent {
  static readonly schema: ComponentSchema = loadSchemaFromSpec('Zone');

  readonly node: Object3D;
  /** False on a multiuser follower: box + gizmo only, no effects (plan-521 §2.4.5). */
  isOwner = true;

  // ── Schema fields (exact rv-ODT names; initializers are the defensive
  //    fallback — applySchema stamps the rv-odt.json defaults on top) ──
  /** Box center in local glTF coordinates, millimetres. */
  Center = new Vector3();
  /** Box size along the local axes, millimetres. */
  Size = new Vector3(100, 100, 100);
  Detect = true;
  Block = false;
  Hold = false;
  Activation: 'Always' | 'Signal' | 'Axis' = 'Always';
  /** Resolved bool signal address (after resolveComponentRefs), or null. */
  ActivationSignal: string | null = null;
  InvertSignal = false;
  /** Resolved drive (after resolveComponentRefs), or null. */
  ActivationDrive: RVDrive | null = null;
  AxisFrom = 0;
  AxisTo = 0;
  /** Resolved bool signal address the Detect result is written to, or null. */
  SignalOccupied: string | null = null;
  HoldAcquire: 'OnActivate' | 'WhileActive' = 'OnActivate';
  HoldCount: 'All' | 'One' = 'All';
  GripTargetSearchRadius = 500;
  ShowGizmo = true;
  /** Block on a stopper releases exactly one MU per lowering (plan-530). */
  SingleRelease = false;

  // ── Runtime state ──
  /** World box of this tick (empty for a non-positive size). */
  readonly bounds = new Box3();
  /** Result of this tick's activation. */
  active = false;
  /** Detect result (false while inactive or without the Detect effect). */
  occupied = false;
  private readonly occupiedListeners = new Set<(occupied: boolean, zone: RVZone) => void>();

  addOccupiedListener(fn: (occupied: boolean, zone: RVZone) => void): () => void {
    this.occupiedListeners.add(fn);
    return () => { this.occupiedListeners.delete(fn); };
  }
  /** MUs this zone holds (reused array — never reassigned). */
  readonly held: RVMovingUnit[] = [];

  private readonly localBounds = new Box3();
  private _wasActive = false;
  private _signalLevel = false;
  /** `ActivationSignal` carries a value — wired, or bound directly in the viewer (SlotIO). */
  private _activationBound = false;
  private _prevAxisPos = NaN;
  private _writer: SignalWriter | null = null;
  private _manager: { zones: Set<RVZone> } | null = null;
  private _collision: { invalidate(): void } | null = null;
  private readonly _unsubs: (() => void)[] = [];
  private _scaleWarned = false;
  // Gizmo (plan-521 Phase 5)
  private _gizmoManager: GizmoOverlayManager | null = null;
  private _edges: GizmoHandle | null = null;
  private _faces: GizmoHandle | null = null;
  private _visualKey = -1;
  private readonly _edgeOpts = { color: ZONE_COLOR_DETECT, opacity: 1 };
  private readonly _faceOpts = { color: ZONE_COLOR_DETECT, opacity: 0.15 };
  // SingleRelease (plan-530)
  private readonly _homeMatrix = new Matrix4();
  private _homeMatrixValid = false;
  private readonly _homeBounds = new Box3();
  private _homeValid = false;
  private _released = false;
  private _token: AnyMU | null = null;
  private _releaseUsed = false;

  constructor(node: Object3D) {
    this.node = node;
  }

  init(ctx: ComponentContext): void {
    const manager = ctx.transportManager;
    manager.zones.add(this);
    this._manager = manager;
    this._collision = ctx.collisionManager ?? null;

    if (this.Activation === 'Signal') {
      // Unwired, the slot is bound directly (SlotIO); neutralize = no level,
      // i.e. inactive exactly like an unwired signal activation.
      const address = typeof this.ActivationSignal === 'string' ? this.ActivationSignal : null;
      const w = wireBoolSignal(ctx.signalStore, address, (v) => {
        this._signalLevel = v;
        this._activationBound = slotBound(this, 'ActivationSignal', address);
      }, `Zone "${this.node.name}": ActivationSignal`, ctx.reapply, { instance: this, field: 'ActivationSignal' });
      this._unsubs.push(w.unsubscribe);
    } else {
      slotRefuse(this, 'ActivationSignal', `Zone "${this.node.name}": ActivationSignal is only read with Activation = Signal (now ${this.Activation})`);
    }
    // Written from `setOccupied`; unwired, the value is published to a direct binding.
    slotDeclare(this, 'SignalOccupied', 'feedback', { initial: this.occupied });
    if (typeof this.SignalOccupied === 'string' && this.SignalOccupied) {
      const path = NodeRegistry.computeNodePath(this.node);
      this._writer = createSignalWriter(ctx.signalStore, `component:Zone:${path}`, 'component', { slotContext: path });
    } else {
      this.SignalOccupied = null;
    }
    // Unresolved references arrive as null; anything else that is not the
    // expected runtime shape is dropped so the tick never guesses.
    if (this.ActivationDrive && typeof this.ActivationDrive !== 'object') this.ActivationDrive = null;

    for (const problem of zoneRuleWarnings(this)) {
      console.warn(`[Zone] "${this.node.name}": ${problem}`);
    }

    if (ctx.gizmoManager) {
      this._gizmoManager = ctx.gizmoManager;
      if (this.ShowGizmo) this.attachGizmo(ctx.gizmoManager);
    }
    this.updateBounds();
    // SingleRelease home pose (plan-530 F2): the authored start pose, before
    // any simulation tick. Only a new init() (reload, re-init) takes a new pose.
    this.node.updateWorldMatrix(true, false);
    this._homeMatrix.copy(this.node.matrixWorld);
    this._homeMatrixValid = true;
    this._clearSingleRelease();
    debug('loader', `  Zone: ${this.node.name} detect=${this.Detect} block=${this.Block} hold=${this.Hold} activation=${this.Activation}`);
  }

  /**
   * Field edit on the live instance (inspector, editor `setField`, undo): the
   * schema was re-applied — refresh the box and the gizmo (created or dropped
   * with `ShowGizmo`). No tick needed, so the editor shows the edit at once.
   */
  reapplyConfig(): void {
    const gm = this._gizmoManager;
    if (gm && this.ShowGizmo && !this._edges) this.attachGizmo(gm);
    else if (!this.ShowGizmo && this._edges) this.disposeGizmo();
    this._visualKey = -1;
    this.updateBounds();
    this._clearSingleRelease();
    this._syncGizmoState();
  }

  // ─── SingleRelease (plan-530) ───────────────────────────────────────

  /** The one guard of state machine, clamp and Detect (plan-530 F2). */
  private _singleReleaseOn(): boolean {
    return this.SingleRelease && this.Block && !this.Hold && this.isOwner;
  }

  /** True while a SingleRelease zone is Released: it clamps at its home box,
   *  so the transport manager keeps it in its blocker list (F9). A Released
   *  zone is always active (plan-539 F13: inactive = completely off). */
  get singleReleaseBlocking(): boolean {
    return this._released && this._singleReleaseOn();
  }

  /** Released state of the SingleRelease state machine (tests / tooling). */
  get singleReleaseReleased(): boolean { return this._released; }

  /** The MU that may pass in the current lowering, or null (tests / tooling). */
  get singleReleaseToken(): AnyMU | null { return this._token; }

  /** The fixed home box (tests / tooling); valid after the first owner tick. */
  get homeBounds(): Box3 { return this._homeBounds; }

  /** Back to Armed, home box kept — the SingleRelease state in ONE place, so a
   *  sixth state field does not have to be remembered at five call sites. */
  private _resetRelease(): void {
    this._released = false;
    this._token = null;
    this._releaseUsed = false;
  }

  /** Back to Armed; the home box is recomputed from `_homeMatrix` next tick. */
  private _clearSingleRelease(): void {
    this._homeValid = false;
    this._resetRelease();
  }

  /** Home box from the current Center/Size and the stored init pose. A zone
   *  registered without init() (tests, tooling) takes its first-tick pose. */
  private _computeHome(): void {
    if (!this._homeMatrixValid) {
      this.node.updateWorldMatrix(true, false);
      this._homeMatrix.copy(this.node.matrixWorld);
      this._homeMatrixValid = true;
    }
    if (this.bounds.isEmpty()) this._homeBounds.makeEmpty();
    else this._homeBounds.copy(this.localBounds).applyMatrix4(this._homeMatrix);
    this._homeValid = true;
  }

  /** beginTick part of SingleRelease: state machine + token search (F2/F4/F6). */
  private _tickSingleRelease(host: ZoneHost): void {
    if (!this._homeValid) this._computeHome();
    if (this._homeBounds.isEmpty() || this.bounds.isEmpty()) {
      this._resetRelease();
      return;
    }
    // plan-539 F13: an inactive zone is completely off — no Released state, no
    // token, back in Armed for the next activation.
    if (!this.active) {
      if (this._released || this._token !== null || this._releaseUsed) {
        this._resetRelease();
        debug('transport', `Zone "${this.node.name}" off (inactive, SingleRelease)`);
      }
      return;
    }
    const atHome = boxNear(this.bounds, this._homeBounds, HOME_TOL_M);
    if (!this._released) {
      if (atHome) return;
      this._released = true;
      this._token = null;
      this._releaseUsed = false;
      debug('transport', `Zone "${this.node.name}" released (SingleRelease)`);
    } else if (atHome) {
      this._resetRelease();
      debug('transport', `Zone "${this.node.name}" armed (SingleRelease)`);
      return;
    }
    if (!this._releaseUsed) this._assignToken(host);
  }

  /** Token search (F4) on the MU AABBs of the previous tick: the eligible MU
   *  whose leading face waits at the ENTRY face of the home box — nearest
   *  first, tie-break smallest `id` (independent of the MU list order). */
  private _assignToken(host: ZoneHost): void {
    const h = this._homeBounds;
    _grownHome.copy(h).expandByScalar(CONTACT_TOL_M);
    const candidates = host.zoneCandidates(_grownHome);
    let best: AnyMU | null = null;
    let bestDist = Infinity;
    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      if (!singleReleaseEligible(c)) continue;
      const surface = c.currentSurface;
      if (!surface) continue;
      surface.getWorldDirection(_surfDir);
      if (surface.speed < 0) _surfDir.negate();
      const k = dominantAxis(_surfDir);
      const s = _surfDir[k];
      if (s === 0) continue;
      const a = c.aabb;
      const dist = Math.abs((s > 0 ? a.max[k] : a.min[k]) - (s > 0 ? h.min[k] : h.max[k]));
      if (dist > CONTACT_TOL_M) continue;
      // Overlap on the two other axes with the home box grown by the tolerance.
      let lateral = true;
      for (let j = 0; j < 3; j++) {
        const ax = AXES[j];
        if (ax === k) continue;
        if (a.min[ax] > _grownHome.max[ax] || a.max[ax] < _grownHome.min[ax]) { lateral = false; break; }
      }
      if (!lateral) continue;
      if (dist < bestDist || (dist === bestDist && best !== null && c.id < best.id)) {
        bestDist = dist;
        best = c;
      }
    }
    if (best) {
      this._token = best;
      this._releaseUsed = true;
      debug('transport', `Zone "${this.node.name}" releases MU "${best.getName()}" (SingleRelease)`);
    }
  }

  // ─── Tick part 1: box, activation, Hold ──────────────────────────────

  /** Refresh the world box from the node (after the owning axis moved). */
  updateBounds(): void {
    const s = this.Size;
    if (!Number.isFinite(s.x + s.y + s.z) || s.x <= 0 || s.y <= 0 || s.z <= 0) {
      this.bounds.makeEmpty();
    } else {
      this.localBounds.min.copy(this.Center).addScaledVector(s, -0.5).multiplyScalar(0.001);
      this.localBounds.max.copy(this.Center).addScaledVector(s, 0.5).multiplyScalar(0.001);
      this.node.updateWorldMatrix(true, false);
      this.bounds.copy(this.localBounds).applyMatrix4(this.node.matrixWorld);
    }
    this._syncGizmoTransform();
  }

  /** Evaluate the activation of this tick into {@link active}. */
  updateActivation(): void {
    switch (this.Activation) {
      case 'Signal':
        this.active = this._activationBound && this._signalLevel !== this.InvertSignal;
        return;
      case 'Axis': {
        const d = this.ActivationDrive;
        if (!d) { this.active = false; return; }
        const pos = d.currentPosition;
        const prev = this._prevAxisPos;
        this._prevAxisPos = pos;
        const still = !d.isRunning && !d.jogForward && !d.jogBackward && !d.claimedMoveThisTick
          && (Number.isNaN(prev) || Math.abs(pos - prev) < AXIS_STILL_EPS);
        const lo = Math.min(this.AxisFrom, this.AxisTo);
        const hi = Math.max(this.AxisFrom, this.AxisTo);
        this.active = still && pos >= lo - AXIS_STILL_EPS && pos <= hi + AXIS_STILL_EPS;
        return;
      }
      default:
        this.active = true;
    }
  }

  /**
   * Tick part 1 (before the MU loop): box, activation, then Hold release on
   * the falling edge and acquire on the rising edge / while active. Candidates
   * are read from the MU AABBs and grid of the previous tick; an MU acquired
   * here is skipped by the MU loop that follows.
   */
  beginTick(host: ZoneHost): void {
    this.updateBounds();
    if (!this.isOwner) {
      // Follower: the server owns every MU pose — let go, compute nothing.
      if (this.held.length > 0) this.releaseInPlace();
      this.active = false;
      this._wasActive = false;
      this.occupied = false;
      this._clearSingleRelease();
      this._syncGizmoState();
      return;
    }
    this.updateActivation();
    const rising = this.active && !this._wasActive;
    const falling = !this.active && this._wasActive;
    if (this.held.length > 0 && (falling || !this.Hold)) this.releaseAll(host);
    if (this.Hold && this.active && (rising || this.HoldAcquire === 'WhileActive')) this.acquire(host);
    if (this._singleReleaseOn()) this._tickSingleRelease(host);
    else if (this._released || this._token !== null || this._releaseUsed) {
      // Guard went off at runtime (e.g. Hold switched on): plain Block again.
      this._resetRelease();
    }
    this._wasActive = this.active;
    this._syncGizmoState();
  }

  private acquire(host: ZoneHost): void {
    if (this.bounds.isEmpty()) return;
    // One = total occupancy of the zone (plan-521 SOL R1 #9).
    if (this.HoldCount === 'One' && this.held.length > 0) return;
    _grown.copy(this.bounds).expandByScalar(CONTACT_TOL_M);
    const candidates = host.zoneCandidates(_grown);
    const one = this.HoldCount === 'One';
    let best: RVMovingUnit | null = null;
    let bestDist = Infinity;
    if (one) this.bounds.getCenter(_center);
    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      // Box2D-owned MUs may be held (plan-661): the 2D zone plugin hands a held
      // MU back to the transport (holding wins). Rapier bodies stay excluded.
      if (c.isInstanced || c.markedForRemoval || c.owner === 'rapier') continue;
      const mu = c as RVMovingUnit;
      if (mu.heldBy !== null || mu.loadedOn) continue;
      if (!boxContains(_grown, mu.aabb)) continue;
      if (one) {
        const d = mu.aabb.center.distanceToSquared(_center);
        if (d < bestDist) { bestDist = d; best = mu; }
      } else {
        this.holdOne(mu, host);
      }
    }
    if (best) this.holdOne(best, host);
  }

  private holdOne(mu: RVMovingUnit, host: ZoneHost): void {
    if (!this._scaleWarned && !hasUniformWorldScale(this.node)) {
      this._scaleWarned = true;
      console.warn(`[Zone] "${this.node.name}": held MUs are attached below a non-uniformly scaled node — they may shear (world position stays correct).`);
    }
    holdMU(mu, this.node, 'zone', {
      gripTargets: host.gripTargets,
      loadHost: host,
      collision: this._collision,
    });
    this.held.push(mu);
    debug('transport', `Zone "${this.node.name}" holds MU "${mu.getName()}"`);
  }

  /** Release every held MU with the Zone policy (surface → GripTarget → in place). */
  releaseAll(host: ZoneHost): void {
    for (let i = this.held.length - 1; i >= 0; i--) this.release(this.held[i], host);
    this.held.length = 0;
  }

  /**
   * Release one MU — Zone placement policy (plan-521 F7): a transport surface
   * below it wins (the MU is lowered onto its top and transported again), else
   * the nearest free GripTarget within `GripTargetSearchRadius`, else it stays
   * where it is. An MU another subsystem owns meanwhile is only forgotten.
   */
  private release(mu: RVMovingUnit, host: ZoneHost): void {
    const idx = this.held.indexOf(mu);
    if (idx >= 0) this.held.splice(idx, 1);
    if (mu.heldBy !== 'zone') return;
    detachMU(mu, 'zone', sceneRootOf(this.node), this._collision);
    mu.node.updateWorldMatrix(true, false);
    mu.updateAABB();
    const surface = findSurfaceBelow(mu, host.surfaces);
    if (surface) {
      const drop = mu.aabb.min.y - surface.aabb.max.y;
      // plan-570 F8: an MU carried by a zone that rode on a lift comes back a hair
      // BELOW the top (acquired one tick after the lift left home) — it is put on
      // the top as well, so repeated strokes never sink it into the belt.
      if (drop > 0 || (drop < 0 && drop > -RELEASE_SNAP_UP_M)) {
        mu.node.getWorldPosition(_muPos);
        _muPos.y -= drop;
        mu.node.parent?.worldToLocal(_muPos);
        mu.node.position.copy(_muPos);
        mu.node.updateWorldMatrix(false, false);
        mu.updateAABB();
      }
      debug('transport', `Zone "${this.node.name}" released MU "${mu.getName()}" onto surface "${surface.node.name}"`);
      return;
    }
    mu.node.getWorldPosition(_muPos);
    const target = findNearestGripTarget(host.gripTargets, _muPos, this.GripTargetSearchRadius);
    if (target) {
      placeOnGripTarget(mu, target);
      mu.node.updateWorldMatrix(true, false);
      mu.updateAABB();
      debug('transport', `Zone "${this.node.name}" placed MU "${mu.getName()}" on GripTarget "${target.node.name}"`);
      return;
    }
    debug('transport', `Zone "${this.node.name}" released MU "${mu.getName()}" in place`);
  }

  /** Let go of every held MU where it is (removal, follower, dispose). */
  releaseInPlace(): void {
    const root = sceneRootOf(this.node);
    for (let i = this.held.length - 1; i >= 0; i--) {
      const mu = this.held[i];
      if (mu.heldBy === 'zone') detachMU(mu, 'zone', root, this._collision);
    }
    this.held.length = 0;
  }

  // ─── Tick part 2: Block ─────────────────────────────────────────────

  /**
   * Swept contact clamp; returns the allowed travel. Acts only while active
   * with Block — except a Released SingleRelease zone (plan-530 F5), which
   * also clamps every eligible MU but the token MU at its fixed home box.
   */
  clampTravel(mu: AnyMU, direction: Vector3, distance: number): number {
    if (!this.Block || !this.isOwner) return distance;
    const a = mu.aabb;
    if (this._released && mu !== this._token && this._singleReleaseOn() && singleReleaseEligible(mu)) {
      const h = this._homeBounds;
      if (boxOverlapsStrict(h, a)) {
        // F5a: already inside the home box — only an MU whose leading face is
        // past the EXIT face on the dominant axis is leaving; any other stays.
        const k = dominantAxis(direction);
        const s = direction[k];
        const leaving = s > 0 ? a.max[k] > h.max[k] : (s < 0 ? a.min[k] < h.min[k] : false);
        if (!leaving) return 0;
      } else {
        distance = sweptClamp(h, a, direction, distance);
      }
    }
    if (!this.active) return distance;
    return sweptClamp(this.bounds, a, direction, distance);
  }

  // ─── Tick part 3: Detect ────────────────────────────────────────────

  /** Detect on the current MU AABBs (after the MU AABB/grid update). */
  evaluateDetect(host: ZoneHost): void {
    if (!this.isOwner) return;
    let occ = false;
    if (this.Detect && this._released && this._singleReleaseOn()) {
      // F7 (Released): an MU at the actual box (while active) OR an eligible
      // MU at the fixed home box — a follower waiting at the stopper face.
      occ = this.active && this._anyAt(host, _grown.copy(this.bounds).expandByScalar(CONTACT_TOL_M), false);
      if (!occ) occ = this._anyAt(host, _grownHome.copy(this._homeBounds).expandByScalar(CONTACT_TOL_M), true);
    } else if (this.Detect && this.active && !this.bounds.isEmpty()) {
      if (this.held.length > 0) {
        occ = true;
      } else {
        const box = this.Block ? _grown.copy(this.bounds).expandByScalar(CONTACT_TOL_M) : this.bounds;
        const candidates = host.zoneCandidates(box);
        for (let i = 0; i < candidates.length; i++) {
          const c = candidates[i];
          if (c.markedForRemoval) continue;
          if (boxOverlaps(box, c.aabb)) { occ = true; break; }
        }
      }
    }
    this.setOccupied(occ);
    this._syncGizmoState();
  }

  /** Any MU (only eligible ones, if asked) overlapping `box` — Detect helper. */
  private _anyAt(host: ZoneHost, box: Box3, eligibleOnly: boolean): boolean {
    if (box.isEmpty()) return false;
    const candidates = host.zoneCandidates(box);
    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      if (c.markedForRemoval) continue;
      if (eligibleOnly && !singleReleaseEligible(c)) continue;
      if (boxOverlaps(box, c.aabb)) return true;
    }
    return false;
  }

  private setOccupied(occ: boolean): void {
    if (occ === this.occupied) return;
    this.occupied = occ;
    slotWrite(this, 'SignalOccupied', this.SignalOccupied, occ, this._writer);
    for (const fn of this.occupiedListeners) fn(occ, this);
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────

  /** A held MU is being disposed (sink, removeMU, reset) — forget it. */
  onMUDisposed(mu: RVMovingUnit): void {
    // SingleRelease: forget the token but keep `_releaseUsed` — one MU per
    // lowering, even when the token MU is gone (plan-530 F6/F8).
    if (this._token === mu) this._token = null;
    const idx = this.held.indexOf(mu);
    if (idx < 0) return;
    this.held.splice(idx, 1);
    if (mu.heldBy === 'zone') mu.heldBy = null;
  }

  /** Simulation reset: forget held MUs (the manager disposes / restores them),
   *  clear the edge memory and the Detect state. */
  reset(): void {
    for (const mu of this.held) {
      if (mu.heldBy === 'zone') mu.heldBy = null;
      mu.parentBeforeGrip = null;
    }
    this.held.length = 0;
    this.active = false;
    this._wasActive = false;
    this._prevAxisPos = NaN;
    this._clearSingleRelease();
    this.setOccupied(false);
    this._syncGizmoState();
  }

  dispose(): void {
    this.releaseInPlace();
    this._clearSingleRelease();
    for (const unsub of this._unsubs) unsub();
    this._unsubs.length = 0;
    slotUndeclare(this);
    this._manager?.zones.delete(this);
    this._manager = null;
    this._writer = null;
    this._collision = null;
    this.disposeGizmo();
    this._gizmoManager = null;
  }

  private disposeGizmo(): void {
    this._edges?.dispose();
    this._faces?.dispose();
    this._edges = null;
    this._faces = null;
  }

  // ─── Gizmo (plan-521 Phase 5) ───────────────────────────────────────

  /** Create the box gizmo (edges + translucent faces), parented under the node
   *  so it follows the axis. Idempotent. Never exported: gizmo roots carry
   *  `_rvGizmo`, which the GLB export prunes. */
  attachGizmo(gizmoManager: GizmoOverlayManager): void {
    this._gizmoManager = gizmoManager;
    if (this._edges) return;
    this._edges = gizmoManager.create(this.node, {
      kind: 'zone-edges', shape: 'box', color: this.effectColor(), opacity: 1,
      attachToNode: true, excludeFromRaycast: true, category: 'gizmos', depthTest: false,
    });
    this._faces = gizmoManager.create(this.node, {
      kind: 'zone-faces', shape: 'transparent-shell', color: this.effectColor(), opacity: 0.15,
      excludeFromRaycast: true, category: 'gizmos', depthTest: false,
    });
    // The shell shape is scene-parented; hang it under the node so it follows too.
    this.node.add(this._faces.root);
    this._visualKey = -1;
    this._syncGizmoTransform();
    this._syncGizmoState();
  }

  /** Gizmo handles (tests / tooling). */
  get gizmo(): { edges: GizmoHandle | null; faces: GizmoHandle | null } {
    return { edges: this._edges, faces: this._faces };
  }

  /** Edge colour of the strongest effect: Hold > Block > Detect. */
  effectColor(): number {
    if (this.Hold) return ZONE_COLOR_HOLD;
    if (this.Block) return ZONE_COLOR_BLOCK;
    return ZONE_COLOR_DETECT;
  }

  private _syncGizmoTransform(): void {
    const e = this._edges;
    if (!e) return;
    const s = this.Size;
    const f = this._faces!;
    e.root.position.copy(this.Center).multiplyScalar(0.001);
    e.root.scale.set(Math.max(s.x, 1e-3) * 0.001, Math.max(s.y, 1e-3) * 0.001, Math.max(s.z, 1e-3) * 0.001);
    f.root.position.copy(e.root.position);
    f.root.scale.copy(e.root.scale);
  }

  /** Colour / opacity by state (plan-521 §3.2); touches the gizmo only when the
   *  state changes. Inactive = faint edges (the overlay manager has no dashed
   *  line material), active = solid, occupied = denser faces. */
  private _syncGizmoState(): void {
    if (!this._edges) return;
    const color = this.effectColor();
    const key = (this.active ? 1 : 0) | (this.occupied ? 2 : 0) | (color << 2);
    if (key === this._visualKey) return;
    this._visualKey = key;
    this._edgeOpts.color = color;
    this._edgeOpts.opacity = this.active ? 0.95 : 0.35;
    this._faceOpts.color = color;
    this._faceOpts.opacity = !this.active ? 0.05 : (this.occupied ? 0.3 : 0.15);
    this._edges.update(this._edgeOpts);
    this._faces?.update(this._faceOpts);
  }
}

/**
 * Topmost transport surface under `mu`: overlapping it in XZ and not lying
 * entirely above it (the driver-selection rule of the transport manager), or null.
 */
function findSurfaceBelow(mu: RVMovingUnit, surfaces: readonly RVTransportSurface[]): RVTransportSurface | null {
  let best: RVTransportSurface | null = null;
  for (const s of surfaces) {
    if (!s.aabb.overlapsXZ(mu.aabb)) continue;
    if (s.aabb.min.y > mu.aabb.max.y) continue;
    if (!best || s.aabb.max.y > best.aabb.max.y) best = s;
  }
  return best;
}

registerComponent({
  type: 'Zone',
  displayName: 'Zone',
  schema: RVZone.schema,
  capabilities: { authorable: true, ui: { badge: '#9c6ade', filter: 'Zones', category: 'sensors' } },
  create: node => new RVZone(node),
  afterCreate: (instance, node) => setComponentInstance(node, instance),
});
