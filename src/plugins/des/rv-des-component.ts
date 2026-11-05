// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import type { WaitEdge } from '../../core/diagnostics/rv-wait-registry';
/**
 * rv-des-component.ts -- Base class for all DES components.
 *
 * Provides:
 * - State machine (Empty, Working, Blocked, Failure, Paused, Transport, Slowed, Stopped)
 * - Material flow handshake: canAccept / acceptMU / releaseMU / onDownstreamReady
 * - All 13 callback hooks from §2.8.2
 * - Entry/exit point system with 4-level priority chain
 * - Signal integration via subscribeSignal()
 * - Drive support via addDrive() / getDrive() / moveAll()
 * - MU loading via loadMU() / unloadMU()
 * - String-based setState() for dynamic statistics
 * - Registration with DESManager via entityId
 * - prop bag for custom runtime state (snapshot-safe)
 */

import { Object3D, Vector3, Box3 } from 'three';
import type { ComponentSchema, ComponentContext, RVComponent } from '../../core/engine/rv-component-registry';
import { applySchema } from '../../core/engine/rv-component-registry';
import type { NodeRegistry } from '../../core/engine/rv-node-registry';
import type { SignalStore } from '../../core/engine/rv-signal-store';
import type { RVDrive } from '../../core/engine/rv-drive';
import type { DESManager, IDESComponent } from './rv-des-manager';
import { DES } from './rv-des-api';
import { registerAction, ACTION_INDEX } from './rv-des-named-actions';
import type { ActionContext } from './rv-des-event';
import type { DESMU, IDESComponentRef, JsonValue } from './rv-des-mu';
import type { SFC32, RngStream } from '../../core/rv-rng-distribution';
import type { TransferResult } from '../../core/material-flow/material-flow-self';

export interface DesStatAccumulators {
  readonly stateTimings: ReadonlyMap<string, Readonly<StateTimingEntry>>;
  readonly currentStateName: string;
  readonly stateStartTime: number;
  readonly statBaselineTime: number;
  readonly processedBaseline: number;
  readonly totalProcessed: number;
  readonly currentLoad: number;
  readonly freeStates: readonly string[];
}

/** Evaluates the statistics window without changing the clock or accumulators. */
export function computeDesStatistics(acc: DesStatAccumulators, now: number): {
  states: Record<string, { duration: number; percent: number; entries: number }>;
  workingPercent: number;
  blockedPercent: number;
  emptyPercent: number;
  setupPercent: number;
  failurePercent: number;
  transportPercent?: number;
  slowedPercent?: number;
  stoppedPercent?: number;
  /** plan-612: share of time in `Charging` (vehicles). */
  chargingPercent?: number;
  utilization: number;
  totalProcessed: number;
  currentLoad: number;
  outputPerHour: number;
  currentState: string;
} {
  // Flush current state timing — over the stats window [statBaselineTime, now].
  const totalTime = Math.max(1e-9, now - acc.statBaselineTime);

  // Gather all state durations including current
  const allStates: Record<string, { duration: number; percent: number; entries: number }> = {};
  for (const [name, entry] of acc.stateTimings) {
    const dur = name === acc.currentStateName
      ? entry.duration + (now - acc.stateStartTime)
      : entry.duration;
    allStates[name] = { duration: dur, percent: (dur / totalTime) * 100, entries: entry.entries };
  }

  // Handle current state if not yet in map
  if (!allStates[acc.currentStateName]) {
    const dur = now - acc.stateStartTime;
    allStates[acc.currentStateName] = { duration: dur, percent: (dur / totalTime) * 100, entries: 1 };
  }

  const getPercent = (name: string) => allStates[name]?.percent ?? 0;

  // Utilization = 100% - free states
  let freePercent = 0;
  for (const name of acc.freeStates) {
    freePercent += getPercent(name);
  }

  return {
    states: allStates,
    workingPercent: getPercent('Working'),
    blockedPercent: getPercent('Blocked'),
    emptyPercent: getPercent('Empty'),
    setupPercent: getPercent('Setup'),
    failurePercent: getPercent('Failure'),
    transportPercent: getPercent('Transport'),
    slowedPercent: getPercent('Slowed'),
    stoppedPercent: getPercent('Stopped'),
    chargingPercent: getPercent('Charging'),
    utilization: Math.max(0, 100 - freePercent),
    totalProcessed: acc.totalProcessed - acc.processedBaseline,
    currentLoad: acc.currentLoad,
    outputPerHour: ((acc.totalProcessed - acc.processedBaseline) / totalTime) * 3600,
    currentState: acc.currentStateName,
  };
}

export interface AcceptState {
  owner: IDESComponentRef | null;
  entryTime: number;
  componentsVisited: number;
}

// ── Pre-allocated temp vectors ──

const _tmp = new Vector3();
const _tmp2 = new Vector3();
const _boxTmp = new Box3();

/** Remaining direct child slots on a logical carrier. */
export function freeCarrierSlots(mu: DESMU): number {
  if (mu.carrierCapacity === undefined) return Number.POSITIVE_INFINITY;
  return Math.max(0, mu.carrierCapacity - mu.childMUs.length);
}

/**
 * Resolve the uppermost pickable MU using logical hierarchy data only.
 * Child order is a stack: the last valid child is visited first.
 */
export function topmostPickable(
  mu: DESMU,
  manager: Pick<DESManager, 'getMU'>,
  filter?: (candidate: DESMU) => boolean,
): DESMU | null {
  const visiting = new Set<string>();
  const visit = (candidate: DESMU): DESMU | null => {
    const key = `${candidate.id}:${candidate.generation}`;
    if (visiting.has(key)) {
      console.warn(`[DES hierarchy] cycle at MU ${key}; branch skipped`);
      return null;
    }
    if (
      candidate.parentMU?.id === candidate.id
      && candidate.parentMU.gen === candidate.generation
    ) {
      console.warn(`[DES hierarchy] MU ${key} is its own parent; invalid parent skipped`);
    }
    visiting.add(key);
    for (let i = candidate.childMUs.length - 1; i >= 0; i--) {
      const ref = candidate.childMUs[i];
      if (ref.id === candidate.id && ref.gen === candidate.generation) {
        console.warn(`[DES hierarchy] MU ${key} contains itself; child skipped`);
        continue;
      }
      const child = manager.getMU(ref.id) as DESMU | null;
      if (!child || child.retired || child.generation !== ref.gen) {
        console.warn(`[DES hierarchy] stale child ref ${ref.id}:${ref.gen}; child skipped`);
        continue;
      }
      const found = visit(child);
      if (found) {
        visiting.delete(key);
        return found;
      }
    }
    visiting.delete(key);
    return !filter || filter(candidate) ? candidate : null;
  };
  return visit(mu);
}

/** Link a child to a carrier without querying scene geometry. */
export function loadMUOnCarrier(
  parent: DESMU,
  child: DESMU,
  manager?: Pick<DESManager, 'getMU' | 'onHierarchyChanged'> | null,
): boolean {
  if (parent === child || (parent.id === child.id && parent.generation === child.generation)) {
    console.warn('[DES hierarchy] cannot load an MU onto itself');
    return false;
  }
  if (freeCarrierSlots(parent) <= 0) return false;

  if (child.parentMU) {
    const oldParent = manager?.getMU(child.parentMU.id) as DESMU | null | undefined;
    if (oldParent && oldParent.generation === child.parentMU.gen) {
      const oldIndex = oldParent.childMUs.findIndex(
        (ref) => ref.id === child.id && ref.gen === child.generation,
      );
      if (oldIndex >= 0) oldParent.childMUs.splice(oldIndex, 1);
    }
  }

  const ref = { id: child.id, gen: child.generation };
  if (!parent.childMUs.some((candidate) => candidate.id === ref.id && candidate.gen === ref.gen)) {
    parent.childMUs.push(ref);
  }
  child.parentMU = { id: parent.id, gen: parent.generation };
  child.isLoaded = true;
  child.loadedOn = parent.currentComponent ?? parent.loadedOn;

  if (
    parent.visual && !parent.visual.isInstanced
    && child.visual && !child.visual.isInstanced
  ) {
    const parentNode = (parent.visual as { node: Object3D }).node;
    const childNode = (child.visual as { node: Object3D }).node;
    parentNode.attach(childNode);
    const grid = child.prop['gridPosition'];
    if (
      Array.isArray(grid) && grid.length >= 3
      && grid.every((value) => typeof value === 'number')
    ) {
      childNode.position.set(grid[0] as number, grid[1] as number, grid[2] as number);
    }
  }
  manager?.onHierarchyChanged?.();
  return true;
}

/** Remove a child from its logical carrier. */
export function unloadMUFromCarrier(
  child: DESMU,
  manager?: Pick<DESManager, 'getMU' | 'onHierarchyChanged'> | null,
): DESMU | null {
  if (!child.parentMU) return null;
  const parent = manager?.getMU(child.parentMU.id) as DESMU | null | undefined;
  if (parent && parent.generation === child.parentMU.gen) {
    const index = parent.childMUs.findIndex(
      (ref) => ref.id === child.id && ref.gen === child.generation,
    );
    if (index >= 0) parent.childMUs.splice(index, 1);
  }
  child.parentMU = null;
  manager?.onHierarchyChanged?.();
  return parent ?? null;
}

// ── Component state enum ──

export enum DESComponentState {
  Empty = 0,
  Working = 1,
  Blocked = 2,
  Failure = 3,
  Paused = 4,
  Transport = 5,
  /** plan-558: a vehicle driving below its free profile because of traffic / a scanner warning field. */
  Slowed = 6,
  /** plan-558: a vehicle standing at a traffic stop (free time — not utilization). */
  Stopped = 7,
  /** plan-612: a vehicle charging its battery (booked via `AgvTask.serviceState`). */
  Charging = 8,
}

// ── State name strings (used by setState for auto-tracking) ──

const STATE_NAMES: Record<DESComponentState, string> = {
  [DESComponentState.Empty]: 'Empty',
  [DESComponentState.Working]: 'Working',
  [DESComponentState.Blocked]: 'Blocked',
  [DESComponentState.Failure]: 'Failure',
  [DESComponentState.Paused]: 'Paused',
  [DESComponentState.Transport]: 'Transport',
  [DESComponentState.Slowed]: 'Slowed',
  [DESComponentState.Stopped]: 'Stopped',
  [DESComponentState.Charging]: 'Charging',
};

// ── Auto-connect config ──

export interface AutoConnectConfig {
  enabled: boolean;
  maxDistance: number; // meters, 0 = unlimited
}

// ── State timing entry ──

export interface StateTimingEntry {
  duration: number;
  entries: number;
}

// ── DESComponentSnapshot ──

export interface DESComponentSnapshot {
  path: string;
  type: string;
  state: number;
  currentLoad: number;
  totalProcessed: number;
  isBlocked: boolean;
  isWorking: boolean;
  isFailure: boolean;
  exitBlocked: boolean;
  muIds: number[];
  pendingTransferCommits?: number;
  prop: Record<string, JsonValue>;
  stateTimings: Record<string, { duration: number; entries: number }>;
  currentStateName: string;
  stateStartTime: number;
  /** Stats window start [statBaselineTime, now] (plan-261 Phase 0). Optional —
   *  v1 snapshots lack it; restore defaults it to the snapshot's simTime. */
  statBaselineTime?: number;
  /** totalProcessed captured at the last stats reset (plan-261 Phase 0). */
  processedBaseline?: number;
  /** plan-2241 (sim s; null = not armed / never); optional, defaulted on restore. */
  progressArmedSince?: number | null;
  lastProgressSec?: number | null;
  categorySince?: number;
}

export type ProgressKind = 'arm' | 'idle' | 'bump';

// plan-2241 F12: restore silence from the first participant commit; changes are dropped.
let _progressSilence = 0;
export function beginProgressSilence(): void { _progressSilence++; }
export function endProgressSilence(): void { if (_progressSilence > 0) _progressSilence--; }

// ── Register signal-change action ──

// Registered once at module load
let _signalChangedIdx: number | undefined;
function ensureSignalChangedAction(): void {
  if (_signalChangedIdx !== undefined) return;
  if (ACTION_INDEX.has('Component.SignalChanged')) {
    _signalChangedIdx = ACTION_INDEX.get('Component.SignalChanged')!;
    return;
  }
  _signalChangedIdx = registerAction('Component.SignalChanged', (ctx: ActionContext) => {
    const mgr = DES.getManager();
    if (!mgr) return;
    const comp = mgr.getComponentByEntityId((ctx as unknown as { _entityId: number })._entityId) as DESComponent | null;
    if (!comp) return;
    const data = ctx.data as { signal: string; value: boolean | number } | null;
    if (!data) return;
    comp._handleSignalChanged(data.signal, data.value);
  }, { owner: 'component', payload: data => data && typeof data === 'object' && !Array.isArray(data)
    && typeof data.signal === 'string' && (typeof data.value === 'boolean' || typeof data.value === 'number')
    ? [] : ['invalid signal payload'] });
}

// ── DESComponent ──

export class DESComponent implements IDESComponent, IDESComponentRef {
  static readonly type: string = 'DESComponent';

  /**
   * Create a 3D gizmo for this virtual component type.
   * Override in subclasses to provide custom visuals (arrows, funnels, etc.).
   * If not overridden, the layout planner uses a generic wireframe box.
   * @param gizmoSize  Box dimensions in mm [x, y, z]
   * @returns Three.js Object3D to add to the scene
   */
  static createGizmo?(gizmoSize: [number, number, number]): Object3D;

  static readonly schema: ComponentSchema = {
    ProcessingTime: { type: 'number', default: 0 },
    MaxCapacity: { type: 'number', default: 1 },
    LinkedNode: { type: 'string', default: null },
    EntryNode: { type: 'string', default: null },
    ExitNode: { type: 'string', default: null },
    AutoConnect: { type: 'boolean', default: true },
    AutoConnectMaxDistance: { type: 'number', default: 1.0 },
  };

  readonly node: Object3D;
  isOwner = true;
  entityId = -1;

  // ── Configuration (from GLB extras or code) ──

  ProcessingTime = 0;
  MaxCapacity = 1;
  LinkedNode: string | null = null;
  EntryNode: string | null = null;
  ExitNode: string | null = null;

  autoConnect: AutoConnectConfig = { enabled: true, maxDistance: 1.0 };

  // ── Connections ──

  nextComponents: DESComponent[] = [];
  previousComponents: DESComponent[] = [];

  // ── Runtime state (saved in snapshot) ──

  state: DESComponentState = DESComponentState.Empty;
  private _currentLoad = 0;
  /** Bound once for cyclic conveyor occupancy; also tracks reset/restore. */
  onLoadChanged: ((delta: number) => void) | null = null;
  get currentLoad(): number { return this._currentLoad; }
  set currentLoad(value: number) {
    const delta = value - this._currentLoad;
    this._currentLoad = value;
    if (delta) { this.onLoadChanged?.(delta); this._progressCheck(); }
  }
  isBlocked = false;
  isWorking = false;
  isFailure = false;
  exitBlocked = false;
  totalProcessed = 0;
  prop: Record<string, JsonValue> = {};

  // ── MU tracking ──

  protected mus: DESMU[] = [];
  /**
   * MUs whose release is TENTATIVE right now (plan-638 Gate R1 #7): a pose
   * hand-over that may still roll back. Their release does not count as output;
   * `releaseTentatively` commits exactly one output once the target owns the MU.
   * Per MU, never a global flag: a nested release of another MU counts normally.
   */
  private readonly tentativeReleases: DESMU[] = [];
  /** Binding-owned completion listeners; independent of warmup/snapshot statistics. */
  private readonly completionListeners = new Set<(count: number) => void>();
  subscribeCompletions(listener: (count: number) => void): () => void {
    this.completionListeners.add(listener);
    return () => { this.completionListeners.delete(listener); };
  }
  get progressUnitId(): string { return `des:${this.path}`; }
  get progressArmed(): boolean { return this.currentLoad > 0 || this.blockedMUs.size > 0 || this.state === DESComponentState.Blocked; }
  /** Blocked output belongs to this instance; downstream capacity belongs to the target
   * instance. Wait ages come from own begin stamps, never from the statistics window. */
  waitEdges(_now: number): readonly WaitEdge[] {
    const out: WaitEdge[] = [];
    // State waits carry no dependency. Budgets, not the DES source, decide
    // whether these are expected; an explicit ExpectedWaits: [] can diagnose them.
    const waitKind = this.currentStateName.toLowerCase();
    if (this.progressArmed && (waitKind === 'setup' || waitKind === 'failure')) {
      out.push({ waiterId: this.progressUnitId, resourceId: this.path, ownerIds: [],
        kind: waitKind, sinceSimSec: this.categorySince, analysed: true, nodePath: this.path });
    }
    for (const [target, mus] of this.blockedMUs) if (mus.length > 0) {
      out.push({ waiterId: this.progressUnitId, resourceId: target.path,
        ownerIds: [target.progressUnitId], kind: 'des-exit', sinceSimSec: this.blockedSince.get(target) ?? NaN,
        analysed: true, nodePath: this.path });
    }
    return out;
  }

  protected blockedMUs: Map<DESComponent, DESMU[]> = new Map();
  /** First block per downstream target (sim s); a retry that blocks again keeps it. A released target
   * keeps its key with NaN (no map shrink per episode, plan-2241a P3): NaN = not blocked for every reader. */
  protected blockedSince: Map<DESComponent, number> = new Map();
  private _stampBlockedSince(target: DESComponent): void {
    const s = this.blockedSince.get(target);
    if (s === undefined || s !== s) this.blockedSince.set(target, this.manager?.currentTime ?? 0);
  }

  // ── Progress lifecycle (plan-2241; diagnosis only, never read by model logic) ──

  progressArmedSince = NaN;
  lastProgressSec = NaN;
  /** Not re-stamped by a stats reset. */
  protected categorySince = 0;
  onProgress: ((kind: ProgressKind, atSec: number, n?: number) => void) | null = null;
  // F11: an open attempt defers checks to its end; a held pose release waits for its commit.
  private _attemptDepth = 0;
  private readonly _heldMUs: DESMU[] = [];
  private readonly _heldBumps: number[] = [];

  /** @internal O(1); no-op inside an attempt or a restore. */
  _progressCheck(): void {
    if (this._attemptDepth > 0 || _progressSilence > 0) return;
    const since = this.progressArmedSince;
    if (this.progressArmed) {
      if (since === since) return;
      const now = this.manager?.currentTime ?? 0;
      this.progressArmedSince = now;
      if (!(this.lastProgressSec >= now)) this.lastProgressSec = now;
      this.onProgress?.('arm', now);
    } else if (since === since) {
      this.progressArmedSince = NaN;
      this.onProgress?.('idle', this.manager?.currentTime ?? 0);
    }
  }

  progressConsistent(): boolean {
    return this.progressArmed === (this.progressArmedSince === this.progressArmedSince);
  }

  /** Armed as restore will install it: the load comes from the held MU refs (restoreMURefs). */
  snapshotProgressArmed(snap: Omit<DESComponentSnapshot, 'path'>, blockedCount: number, _part: ((key: string) => unknown) | null): boolean {
    return snap.muIds.length > 0 || blockedCount > 0 || snap.state === DESComponentState.Blocked;
  }

  /** @internal Restore post-check, diagnostic only: re-stamp a disagreeing lifecycle deterministically. */
  _repairProgress(time: number): boolean {
    if (this.progressConsistent()) return false;
    if (this.progressArmed) {
      this.progressArmedSince = time;
      if (!(this.lastProgressSec >= time)) this.lastProgressSec = time;
    } else this.progressArmedSince = NaN;
    return true;
  }

  /** @internal */
  _beginProgressAttempt(): void { this._attemptDepth++; }
  /** @internal */
  _endProgressAttempt(): void { if (--this._attemptDepth === 0) this._progressCheck(); }
  /** @internal */
  _holdProgress(mu: DESMU): void {
    this._heldMUs.push(mu); this._heldBumps.push(0); this._attemptDepth++;
  }
  /** @internal */
  _releaseHeldProgress(mu: DESMU, committed: boolean): void {
    const i = this._heldMUs.lastIndexOf(mu);
    let n = 0;
    if (i >= 0) {
      n = this._heldBumps[i];
      // try/finally nests strictly: the entry is the last one (pop, no splice result array).
      if (i === this._heldMUs.length - 1) { this._heldMUs.pop(); this._heldBumps.pop(); }
      else { this._heldMUs.splice(i, 1); this._heldBumps.splice(i, 1); }
    }
    if (committed && n > 0) this._noteProgress(n);
    this._endProgressAttempt();
  }
  private _noteProgress(n: number): void {
    if (_progressSilence > 0) return;
    const now = this.manager?.currentTime ?? 0;
    this.lastProgressSec = now;
    this.onProgress?.('bump', now, n);
  }
  blockedSinceOf(target: DESComponent): number {
    const s = this.blockedSince.get(target);
    return s !== undefined && s === s ? s : this.manager?.currentTime ?? 0;
  }

  // ── State timing ──

  protected stateTimings: Map<string, StateTimingEntry> = new Map();
  protected currentStateName = 'Empty';
  protected stateStartTime = 0;
  freeStates: string[] = ['Empty', 'Stopped'];

  // ── Statistics baseline (warmup / stats-reset) ──
  // Statistics are reported over the window [statBaselineTime, now]. A stats reset
  // (DESManager.statResetTime) sets the baseline to the reset time + captures the
  // processed count there, so utilization / throughput reflect steady state, not the
  // warmup. Both default to 0 → the full run, i.e. no behaviour change until a reset.
  protected statBaselineTime = 0;
  protected processedBaseline = 0;

  // ── Linked node reference ──

  protected visualNode: Object3D | null = null;

  // ── Entry/exit point system ──

  protected entryNodeRef: Object3D | null = null;
  protected exitNodeRef: Object3D | null = null;
  protected inputPoints: Object3D[] = [];
  protected outputPoints: Object3D[] = [];
  protected defaultInPosition = new Vector3();
  protected defaultOutPosition = new Vector3();

  // ── Context references ──

  protected registry: NodeRegistry | null = null;
  protected signalStore: SignalStore | null = null;
  protected manager: DESManager | null = null;
  protected scene: Object3D | null = null;
  desId: string | null = null;
  protected _rng: SFC32 | null = null;

  //! The component's seeded RNG (masterSeed + entityId derived), created when the
  //! DES manager attaches the component; null before that. Public read access so
  //! `self.rng` (plan-2051) and the snapshot path see the same stream.
  get rng(): RngStream | null { return this.rngFor('default'); }

  rngFor(purpose: string): RngStream | null {
    if (!this.manager) return null;
    return this.manager.rngVersion === 2
      ? this.manager.stream(this.desId ?? '', purpose) : this._rng;
  }

  // ── Signal subscriptions ──

  protected signalHandlers = new Map<string, (value: boolean | number) => void>();
  protected cleanups: (() => void)[] = [];

  // ── Drives ──

  protected _drives: Map<string, RVDrive> = new Map();
  private _moveAllPending = 0;
  private _moveAllAction: string | null = null;
  private _moveAllComp: DESComponent | null = null;
  private _moveAllMu: DESMU | null = null;

  // ─────────────────────────────────────────────
  // USER HOOKS — override these for custom logic
  // ─────────────────────────────────────────────

  onSelectNext?: (candidates: DESComponent[], mu: DESMU) => DESComponent | null;
  onCanAccept?: (mu: DESMU) => boolean;
  onMUEnter?: (mu: DESMU) => void;
  onMUExit?: (mu: DESMU) => void;
  /** Accepted MUs whose sender is still publishing its release wake-up. */
  private _pendingTransferCommits = 0;
  get pendingTransferCommits(): number { return this._pendingTransferCommits; }
  set pendingTransferCommits(value: number) {
    const delta = this._pendingTransferCommits - value;
    this._pendingTransferCommits = value;
    if (delta) this.onLoadChanged?.(delta);
  }
  onFailure?: () => void;
  onRepaired?: () => void;
  onSignalChange?: (signalName: string, value: boolean | number) => void;
  validateBehaviourState?(state: unknown, ctx: import('../../core/material-flow/define-material-flow').BehaviourSnapshotContext): void;
  onRestored?: () => void;

  // ── Constructor ──

  constructor(node: Object3D) {
    this.node = node;
  }

  // ── Path ──

  get path(): string {
    // Walk up hierarchy to build path
    const parts: string[] = [];
    let current: Object3D | null = this.node;
    while (current && current.parent) {
      parts.unshift(current.name);
      current = current.parent;
      if (!current.parent) break;
    }
    return parts.join('/');
  }

  // ── Effective node (linked or self) ──

  get effectiveNode(): Object3D {
    return this.visualNode ?? this.node;
  }

  // ── Has visual mesh ──

  get hasVisualMesh(): boolean {
    if (this.visualNode) return true;
    // Check if node has any mesh descendants
    let hasMesh = false;
    this.node.traverse((child: Object3D) => {
      if ((child as unknown as { isMesh?: boolean }).isMesh) hasMesh = true;
    });
    return hasMesh;
  }

  // ── Initialization ──

  init(context: ComponentContext): void {
    this.registry = context.registry;
    this.signalStore = context.signalStore;
    this.scene = context.scene;

    // Sync autoConnect config from schema boolean properties.
    // Note: autoConnect.enabled/maxDistance may have been set by user code before init().
    // Only apply schema values if the schema properties were loaded from GLB extras.
    // Direct assignment to autoConnect.enabled takes priority.

    // Resolve linked node
    if (this.LinkedNode && this.registry) {
      const linked = this.registry.getNode(this.LinkedNode);
      if (linked) {
        this.visualNode = linked;
        // Copy position from linked node
        linked.getWorldPosition(_tmp);
        this.node.position.copy(_tmp);
      }
    }

    // Resolve entry/exit nodes
    if (this.EntryNode) {
      this.entryNodeRef = this.resolveNode(this.EntryNode);
    }
    if (this.ExitNode) {
      this.exitNodeRef = this.resolveNode(this.ExitNode);
    }

    // Create connection points
    this.createConnectionPoints();

    // Get manager from DES API
    this.manager = DES.getManager();
    if (this.manager) {
      this._rng = this.manager.createComponentRng(this.entityId >= 0 ? this.entityId : 0);
    }

    ensureSignalChangedAction();
  }

  /**
   * Re-read this component's schema fields from the (possibly overridden)
   * `node.userData.realvirtual[<type>]` bag (plan-265 §2.4 Option A). Generic for
   * ALL DES component types — the batch runner writes parameter overrides into the
   * raw rv_extras bag and calls this VOR `start()` so the new values take effect
   * (config fields are otherwise read once at construction and never re-read).
   *
   * Only writes schema keys via `applySchema` (same type/enum/alias conversion as
   * construction); runtime counters (`_generated`, state, load, …) are untouched.
   * Missing keys fall back to schema defaults exactly like the initial apply.
   */
  reconfigureFromExtras(): void {
    const ctor = this.constructor as typeof DESComponent;
    const rv = this.node.userData?.realvirtual as Record<string, unknown> | undefined;
    const bag = rv?.[ctor.type];
    const extras = bag && typeof bag === 'object' ? (bag as Record<string, unknown>) : {};
    applySchema(this as unknown as Record<string, unknown>, ctor.schema, extras);
  }

  dispose(): void {
    if (this.desId != null) this.manager?.releaseStreams(this.desId);
    // plan-2058 F21: one throwing cleanup must not skip the others (or leave the
    // list / handler map filled for a second dispose) — run each in isolation,
    // collect the failures, always clear, then report.
    let errors: unknown[] | null = null;
    for (const cleanup of this.cleanups) {
      try { cleanup(); } catch (e) { (errors ??= []).push(e); }
    }
    this.cleanups.length = 0;
    this.signalHandlers.clear();
    if (errors) console.error(`[DESComponent] dispose of '${this.path}': ${errors.length} cleanup(s) failed:`, errors);
  }

  // ── Node resolution (§2.8a) ──

  resolveNode(ref: string, context: 'child' | 'scene' = 'child'): Object3D | null {
    if (!ref) return null;

    if (context === 'scene' || ref.includes('/')) {
      const fromRegistry = this.registry?.getNode(ref) ?? null;
      if (fromRegistry) return fromRegistry;
    }

    const target = this.effectiveNode;
    const direct = target.children.find((c: Object3D) => c.name === ref);
    if (direct) return direct;

    return target.getObjectByName(ref) ?? null;
  }

  // ── Connection points ──

  protected createConnectionPoints(): void {
    this.inputPoints = [];
    this.outputPoints = [];
    const target = this.effectiveNode;
    for (const child of target.children) {
      if (child.name.startsWith('IN')) this.inputPoints.push(child);
      if (child.name.startsWith('OUT')) this.outputPoints.push(child);
    }
    if (this.inputPoints.length === 0 || this.outputPoints.length === 0) {
      this.computeDefaultPoints();
    }
  }

  protected computeDefaultPoints(): void {
    _boxTmp.makeEmpty();
    _boxTmp.expandByObject(this.effectiveNode);
    if (_boxTmp.isEmpty()) {
      // No geometry — use node position with small offset
      const p = this.effectiveNode.getWorldPosition(_tmp);
      this.defaultInPosition.set(p.x - 0.5, p.y, p.z);
      this.defaultOutPosition.set(p.x + 0.5, p.y, p.z);
      return;
    }
    const size = _boxTmp.getSize(_tmp);
    const center = _boxTmp.getCenter(_tmp2);
    this.defaultInPosition.set(center.x - size.x * 0.5, center.y - size.y * 0.5, center.z);
    this.defaultOutPosition.set(center.x + size.x * 0.5, center.y - size.y * 0.5, center.z);
  }

  // ── Position queries (4-level priority chain) ──

  getInputPosition(): Vector3 {
    if (this.entryNodeRef) return this.entryNodeRef.getWorldPosition(_tmp);
    if (this.inputPoints.length > 0) return this.inputPoints[0].getWorldPosition(_tmp);
    return _tmp.copy(this.defaultInPosition);
  }

  getOutputPosition(): Vector3 {
    if (this.exitNodeRef) return this.exitNodeRef.getWorldPosition(_tmp2);
    if (this.outputPoints.length > 0) return this.outputPoints[0].getWorldPosition(_tmp2);
    return _tmp2.copy(this.defaultOutPosition);
  }

  canHaveInputs(): boolean {
    return true;
  }

  // ── Manager wiring ──

  //! Wire the manager back-reference + per-component RNG. Called by
  //! DESManager.registerComponent so EVERY component (native AND the unified
  //! MaterialFlowAdapter, which has no init()) can read `manager.currentTime`
  //! for statistics. Idempotent — native init() may also set the manager.
  //! IMPLEMENTS IDESComponent::attachManager
  attachManager(manager: DESManager): void {
    this.manager = manager;
    this._rng = manager.createComponentRng(this.entityId >= 0 ? this.entityId : 0);
    this._resetStatisticsWindow();
  }

  // ── State machine ──

  setState(name: string): void {
    // Idempotent: re-stating the current category keeps the running interval (no
    // new entry, no churn). The base handshake AND a unified component's
    // self.statState can both report the same category (e.g. 'Empty' on release);
    // without this guard the entry count and stateStartTime would reset spuriously.
    if (name === this.currentStateName) return;
    const now = this.manager?.currentTime ?? 0;
    // Close previous state timing
    if (this.currentStateName) {
      const elapsed = now - this.stateStartTime;
      const entry = this.stateTimings.get(this.currentStateName);
      if (entry) {
        entry.duration += elapsed;
      } else {
        this.stateTimings.set(this.currentStateName, { duration: elapsed, entries: 1 });
      }
    }

    this.currentStateName = name;
    this.stateStartTime = now;
    this.categorySince = now;

    // Increment entry count for new state
    const newEntry = this.stateTimings.get(name);
    if (newEntry) {
      newEntry.entries++;
    } else {
      this.stateTimings.set(name, { duration: 0, entries: 1 });
    }

    // Map to enum for backward compat
    switch (name) {
      case 'Empty': this.state = DESComponentState.Empty; break;
      case 'Working': this.state = DESComponentState.Working; break;
      case 'Blocked': this.state = DESComponentState.Blocked; break;
      case 'Failure': this.state = DESComponentState.Failure; break;
      case 'Paused': this.state = DESComponentState.Paused; break;
      case 'Transport': this.state = DESComponentState.Transport; break;
      case 'Slowed': this.state = DESComponentState.Slowed; break;
      case 'Stopped': this.state = DESComponentState.Stopped; break;
      case 'Charging': this.state = DESComponentState.Charging; break;
    }
    this._progressCheck(); // a real category change only (idempotent calls returned above)
  }

  // ── Statistics ──

  /** Read-only live accumulator view; consumers must not retain it across events. */
  statAccumulators(): DesStatAccumulators {
    return { stateTimings: this.stateTimings, currentStateName: this.currentStateName,
      stateStartTime: this.stateStartTime, statBaselineTime: this.statBaselineTime,
      processedBaseline: this.processedBaseline, totalProcessed: this.totalProcessed,
      currentLoad: this.currentLoad, freeStates: this.freeStates };
  }

  getStatistics(): ReturnType<typeof computeDesStatistics> {
    return computeDesStatistics(this.statAccumulators(), this.manager?.currentTime ?? 0);
  }

  /**
   * Share (0…100 %) of the statistics window spent in `state` — the SAME value
   * `getStatistics()` reports for it (same window, running state included), but
   * allocation-free and for ONE state (plan-644 D8: the DES-HMI state extension
   * point reads registered states through it). A state never booked → 0.
   */
  getStatePercent(state: string): number {
    const now = this.manager?.currentTime ?? 0;
    const totalTime = Math.max(1e-9, now - this.statBaselineTime);
    const entry = this.stateTimings.get(state);
    let dur: number;
    if (entry) {
      dur = state === this.currentStateName ? entry.duration + (now - this.stateStartTime) : entry.duration;
    } else if (state === this.currentStateName) {
      dur = now - this.stateStartTime;
    } else {
      return 0;
    }
    return (dur / totalTime) * 100;
  }

  /**
   * Reset this component's statistics to a fresh window starting NOW (warmup /
   * DESManager.statResetTime): close the running state, clear the accumulated state
   * timings, re-baseline the time + processed count, and re-stamp the current state
   * so it keeps tracking from now. After this, getStatistics() reports over [now, …].
   */
  resetStatistics(): void {
    this._resetStatisticsWindow();
  }

  private _resetStatisticsWindow(): void {
    const now = this.manager?.currentTime ?? 0;
    this.stateTimings.clear();
    this.stateStartTime = now;
    this.statBaselineTime = now;
    this.processedBaseline = this.totalProcessed;
    if (this.currentStateName) {
      this.stateTimings.set(this.currentStateName, { duration: 0, entries: 1 });
    }
  }

  // ── Material flow handshake ──

  canAccept(mu: DESMU): boolean {
    if (this.isFailure) return false;
    if (this.currentLoad >= this.MaxCapacity) return false;
    if (this.onCanAccept) return this.onCanAccept(mu);
    return true;
  }

  acceptMU(mu: DESMU): boolean {
    if (!this.canAccept(mu)) return false;
    this.addMU(mu);
    return true;
  }

  protected rollbackAccept(mu: DESMU, saved: AcceptState): void {
    const idx = this.mus.indexOf(mu);
    if (idx >= 0) this.mus.splice(idx, 1);
    this.currentLoad = this.mus.length;
    mu.currentComponent = saved.owner;
    mu.entryTime = saved.entryTime;
    mu.componentsVisited = saved.componentsVisited;
  }

  /** Acceptance hooks cannot forward an MU until its sender has committed. */
  onTransferCommitted(_mu: DESMU): void {}

  /** Count `n` outputs that are not MUs leaving this component (a vehicle
   *  finishing a job) — feeds totalProcessed / outputPerHour like releaseMU. */
  recordOutput(n = 1): void {
    this._countOutput(n);
    this._noteProgress(n);
  }

  private _countOutput(n: number): void {
    this.totalProcessed += n;
    for (const listener of this.completionListeners) listener(n);
  }

  /**
   * Run `handOver` with the release of `mu` marked tentative (plan-638 R1 #7):
   * a release inside it does not count; if `committed(result)` holds afterwards,
   * exactly ONE output is counted. A rolled-back hand-over therefore counts
   * nothing, however often it is retried. The mark is removed in `finally`.
   */
  releaseTentatively<T>(mu: DESMU, handOver: () => T, committed: (result: T) => boolean): T {
    this.tentativeReleases.push(mu);
    let result: T;
    try {
      result = handOver();
    } finally {
      const i = this.tentativeReleases.lastIndexOf(mu);
      if (i >= 0) this.tentativeReleases.splice(i, 1);
    }
    if (committed(result)) this.recordOutput();
    return result;
  }

  releaseMU(mu: DESMU): void {
    const idx = this.mus.indexOf(mu);
    if (idx >= 0) this.mus.splice(idx, 1);
    this.currentLoad = this.mus.length;
    if (mu.currentComponent === this) mu.currentComponent = null;
    this.onMUExit?.(mu);
    if (this.tentativeReleases.length === 0 || !this.tentativeReleases.includes(mu)) {
      const held = this._heldMUs.length === 0 ? -1 : this._heldMUs.lastIndexOf(mu);
      if (held >= 0) { this._heldBumps[held]++; this._countOutput(1); } else this.recordOutput();
    }

    // Notify upstream that space is available
    if (this.currentLoad < this.MaxCapacity) {
      for (const prev of this.previousComponents) {
        prev.onDownstreamReady(this);
      }
    }

    // Update state
    if (this.currentLoad === 0) {
      this.setState('Empty');
      this.isWorking = false;
    }
  }

  onDownstreamReady(from: DESComponent): void {
    // Try to release blocked MUs
    const waiting = this.blockedMUs.get(from);
    if (waiting && waiting.length > 0) {
      let idx = 0;
      while (idx < waiting.length && waiting[idx].inTransfer) idx++;
      if (idx === waiting.length) return;
      const mu = waiting[idx];
      waiting.splice(idx, 1);
      if (waiting.length === 0) this.blockedMUs.delete(from);
      mu.isBlocked = false;
      this.tryTransferMU(mu);
      // Re-blocking at `from` keeps the wait age.
      if (!this.blockedMUs.has(from) && this.blockedSince.has(from)) this.blockedSince.set(from, NaN);
    }
  }

  /**
   * Rebuild the held-MU list from restored MU instances (snapshot restore,
   * plan-261): the serialized `muIds` resolve to the re-created MUs so
   * `_onProcessComplete`/`tryTransferMU`/`releaseMU` find them again.
   */
  restoreMURefs(held: DESMU[], blocked?: Array<[DESComponent, DESMU[]]>, blockedSince?: readonly number[]): void {
    const now = this.manager?.currentTime ?? 0;
    this.mus = [...held];
    this.currentLoad = this.mus.length;
    this.blockedSince.clear();
    if (blocked) {
      this.blockedMUs = new Map(blocked);
      for (let i = 0; i < blocked.length; i++) this.blockedSince.set(blocked[i][0], blockedSince?.[i] ?? now);
      this._progressCheck();
      return;
    }
    // MU snapshots retain isBlocked, but the retry map holds live references.
    // Rebuild it so downstream-ready can retry the restored instances.
    this.blockedMUs.clear();
    for (const mu of this.mus) {
      if (!mu.isBlocked) continue;
      const target = this.selectNextComponent(mu) ?? this.nextComponents[0];
      if (!target) continue;
      let waiting = this.blockedMUs.get(target);
      if (!waiting) {
        waiting = [];
        this.blockedMUs.set(target, waiting);
        this.blockedSince.set(target, now);
      }
      waiting.push(mu);
    }
    this._progressCheck();
  }

  /**
   * Reset per-run MU state on Reset-on-Switch / `clearMUs` (plan-225 B4): drop
   * held + blocked MUs and the load/blocked flags so a restart does not carry
   * ghost MU references (a stale `blockedMUs` entry would otherwise fire a bogus
   * `onDownstreamReady` later). Connections (next/previousComponents) are kept.
   *
   * The state machine and the statistics counters go back to their construction
   * values too: a run after Reset must start exactly like the first run after load.
   * Keeping `currentStateName` (e.g. 'Blocked' at the end of the run) booked the
   * next run's initial empty period as Blocked, and the raw `totalProcessed` (the
   * TotalProcessed KPI source) kept counting across runs.
   */
  clearMUState(): void {
    // plan-2241 E-A: lifecycle reset; no half-cleared publication.
    const wasArmed = this.progressArmedSince === this.progressArmedSince;
    this._attemptDepth = 1;
    this._heldMUs.length = 0;
    this._heldBumps.length = 0;
    // Reset starts a new run; repairing would replay work from the old queue.
    this.isFailure = false;
    this.mus.length = 0;
    this.blockedMUs.clear();
    this.blockedSince.clear();
    this.currentLoad = 0;
    this.isBlocked = false;
    this.exitBlocked = false;
    this.isWorking = false;
    this.state = DESComponentState.Empty;
    this.currentStateName = 'Empty';
    this.totalProcessed = 0;
    this.processedBaseline = 0;
    // Fresh window at the manager's clock (0 after manager.reset()); attachManager
    // re-baselines again when the next start registers the component.
    this._resetStatisticsWindow();
    this.categorySince = this.manager?.currentTime ?? 0;
    this._attemptDepth = 0;
    this.progressArmedSince = NaN;
    this.lastProgressSec = NaN;
    if (wasArmed && _progressSilence === 0) this.onProgress?.('idle', this.manager?.currentTime ?? 0);
  }

  // ── Internal MU management ──

  protected addMU(mu: DESMU): void {
    this.mus.push(mu);
    this.currentLoad = this.mus.length;
    mu.currentComponent = this;
    mu.entryTime = this.manager?.currentTime ?? 0;
    mu.componentsVisited++;
    this.onMUEnter?.(mu);
  }

  protected tryTransferMU(mu: DESMU): TransferResult {
    if (mu.inTransfer) return 'deferred';
    const target = this.selectNextComponent(mu);
    if (target && target.canAccept(mu)) {
      let accepted: boolean;
      mu.inTransfer = true;
      try {
        accepted = target.acceptMU(mu);
      } finally {
        mu.inTransfer = false;
      }
      if (accepted) {
        mu.isBlocked = false;
        const waiting = this.blockedMUs.get(target);
        if (waiting) {
          const idx = waiting.indexOf(mu);
          if (idx >= 0) waiting.splice(idx, 1);
          if (waiting.length === 0) { this.blockedMUs.delete(target); this.blockedSince.set(target, NaN); }
        }
        // The loop-fill guard historically observed this MU between holders
        // during the sender's wake-up. Preserve that count with accept-first
        // ownership; consumed MUs already contribute no target load.
        const retained = mu.currentComponent === target;
        if (retained) target.pendingTransferCommits++;
        try {
          this.releaseMU(mu);
        } finally {
          if (retained) target.pendingTransferCommits--;
        }
        target.onTransferCommitted(mu);
        return 'moved';
      }
    }
    if (target) {
      // Downstream exists but full — block
      mu.isBlocked = true;
      mu.blockedCount++;
      this.isBlocked = true;
      this.exitBlocked = true;
      this.setState('Blocked');
      let list = this.blockedMUs.get(target);
      if (!list) {
        list = [];
        this.blockedMUs.set(target, list);
        this._stampBlockedSince(target);
      }
      if (!list.includes(mu)) list.push(mu);
      this._progressCheck(); // inserting while already Blocked bypasses setState
    } else if (this.nextComponents.length === 0) {
      // No downstream configured — MU stays here (end of line)
    } else {
      // All downstream blocked
      mu.isBlocked = true;
      mu.blockedCount++;
      this.isBlocked = true;
      this.exitBlocked = true;
      this.setState('Blocked');
      // Register with first downstream for notification
      const first = this.nextComponents[0];
      let list = this.blockedMUs.get(first);
      if (!list) {
        list = [];
        this.blockedMUs.set(first, list);
        this._stampBlockedSince(first);
      }
      if (!list.includes(mu)) list.push(mu);
      this._progressCheck();
    }
    return 'blocked';
  }

  // ── Routing ──

  protected selectNextComponent(mu: DESMU): DESComponent | null {
    if (this.nextComponents.length === 0) return null;
    const candidates = this.nextComponents.filter(c => c.canAccept(mu));
    if (candidates.length === 0) {
      // All full — return first for blocking
      return this.nextComponents[0];
    }
    if (this.onSelectNext) return this.onSelectNext(candidates, mu);
    return candidates[0];
  }

  // ── Signal integration ──

  subscribeSignal(signalName: string, handler: (value: boolean | number) => void): void {
    this.signalHandlers.set(signalName, handler);
    if (this.signalStore) {
      const unsub = this.signalStore.subscribe(signalName, (newValue) => {
        // Schedule a DES event for the signal change (respects sim time)
        if (this.manager && this.entityId >= 0) {
          this.manager.scheduleIn(
            0.001,
            'Component.SignalChanged',
            this.entityId,
            -1,
            0,
            { signal: signalName, value: newValue },
          );
        }
      });
      this.cleanups.push(unsub);
    }
  }

  /** @internal Called by the signal-changed Named Action dispatch. */
  _handleSignalChanged(signal: string, value: boolean | number): void {
    const handler = this.signalHandlers.get(signal);
    if (handler) handler(value);
    this.onSignalChange?.(signal, value);
  }

  // ── Drives ──

  addDrive(nodeName: string, _config?: Record<string, unknown>): RVDrive | null {
    const driveNode = this.resolveNode(nodeName);
    if (!driveNode) return null;

    // Check if node already has a drive registered
    // This is a simplified version — full integration would use NodeRegistry
    const existing = this._drives.get(nodeName);
    if (existing) return existing;

    // In production, this would create an RVDrive instance on the node.
    // For now, return null — drive integration will be completed with scene loader.
    return null;
  }

  getDrive(nodeName: string): RVDrive | null {
    return this._drives.get(nodeName) ?? null;
  }

  get drives(): RVDrive[] {
    return [...this._drives.values()];
  }

  /**
   * Move all specified drives to targets. When ALL arrive, fires the named action.
   * Named Action callback pattern — fully snapshot-safe.
   */
  moveAll(
    targets: Record<string, number>,
    onAllArrived: string,
    comp: DESComponent,
    mu?: DESMU,
  ): void {
    const entries = Object.entries(targets);
    if (entries.length === 0) {
      // No drives — fire action immediately
      DES.in(0.001, onAllArrived, comp, mu);
      return;
    }
    this._moveAllPending = entries.length;
    this._moveAllAction = onAllArrived;
    this._moveAllComp = comp;
    this._moveAllMu = mu ?? null;

    // moveTo on each drive with individual arrival tracking
    // (In full implementation, each drive.moveTo would schedule its own event)
    // For now, schedule a combined event based on max travel time
    let maxTime = 0.001;
    for (const [name, target] of entries) {
      const drive = this._drives.get(name);
      if (drive) {
        // Calculate move time from drive physics
        const dist = Math.abs(target - drive.currentPosition);
        const speed = drive.TargetSpeed || 100;
        const moveTime = dist / speed;
        maxTime = Math.max(maxTime, moveTime);
        drive.currentPosition = target; // FastForward: instant jump
      }
    }
    DES.in(maxTime, onAllArrived, comp, mu);
  }

  // ── MU Loading ──

  loadMU(mu: DESMU, nodeName?: string): void;
  loadMU(mu: DESMU, parentMU: DESMU, nodeName?: string): void;
  loadMU(mu: DESMU, parentOrNode?: DESMU | string, hierarchyNodeName?: string): void {
    const parentMU = typeof parentOrNode === 'string' ? null : parentOrNode ?? null;
    const nodeName = typeof parentOrNode === 'string' ? parentOrNode : hierarchyNodeName;
    if (parentMU) {
      if (!loadMUOnCarrier(parentMU, mu, this.manager)) return;
      mu.loadedOn = this;
      mu.loadedOnNode = nodeName ?? null;
      return;
    }

    unloadMUFromCarrier(mu, this.manager);
    const parentNode = nodeName
      ? this.resolveNode(nodeName) ?? this.effectiveNode
      : this.effectiveNode;

    if (mu.visual && !mu.visual.isInstanced) {
      const muNode = (mu.visual as { node: Object3D }).node;
      const worldPos = muNode.getWorldPosition(_tmp);
      parentNode.add(muNode);
      muNode.position.copy(parentNode.worldToLocal(worldPos.clone()));
    }

    mu.isLoaded = true;
    mu.loadedOn = this;
    mu.loadedOnNode = nodeName ?? null;
  }

  unloadMU(mu: DESMU): void {
    unloadMUFromCarrier(mu, this.manager);
    if (mu.visual && !mu.visual.isInstanced && this.scene) {
      const muNode = (mu.visual as { node: Object3D }).node;
      const worldPos = muNode.getWorldPosition(_tmp);
      this.scene.add(muNode);
      muNode.position.copy(worldPos);
    }

    mu.isLoaded = false;
    mu.loadedOn = null;
    mu.loadedOnNode = null;
  }

  // ── Failure ──

  setFailure(failure: boolean): void {
    if (failure) {
      // Idempotent: a second failure must not re-freeze already-frozen events
      // (it would cancel a fresh id and overwrite the stored remaining time).
      if (this.isFailure) return;
      this.isFailure = true;
      this.setState('Failure');
      // Freeze in-flight work: cancel scheduled completion/transport events and
      // stash their remaining time so a failure truly HALTS work in progress,
      // not just intake. Without this the queued ProcessComplete/Arrival still
      // fires while "failed" and the part teleports through a stopped machine.
      this.onFreeze();
      this.onFailure?.();
    } else {
      // Idempotent: only resume if we were actually failed (avoids a double
      // re-schedule of the frozen events).
      if (!this.isFailure) return;
      this.isFailure = false;
      // Resume frozen work with the REMAINING time captured at freeze, so the
      // downtime extends the effective cycle/transport time (MTTR is real).
      this.onResume();
      // A subclass that re-booked its category while resuming keeps it (plan-612:
      // an Agv servicing with `AgvTask.serviceState` books e.g. 'Charging' from
      // its onResume — overwriting that here desynced the adapter from the self's
      // de-duped statState). Otherwise the load decides, as before.
      if (this.currentStateName === 'Failure') this.setState(this.currentLoad > 0 ? 'Working' : 'Empty');
      this.onRepaired?.();
      // Notify upstream
      for (const prev of this.previousComponents) {
        prev.onDownstreamReady(this);
      }
    }
  }

  /**
   * Hook: cancel this component's in-flight scheduled events and stash their
   * remaining time. Called by `setFailure(true)` AFTER `isFailure` is set.
   * Base is a no-op (components that schedule no time-consuming self-events —
   * e.g. DESSink — need nothing). Subclasses that schedule completion/transport
   * events (Station, Conveyor, Source, Storage) override this.
   */
  protected onFreeze(): void {}

  /**
   * Hook: re-schedule the events cancelled in `onFreeze()` with their stored
   * remaining time. Called by `setFailure(false)` BEFORE the state transition
   * and upstream notification. Base is a no-op.
   */
  protected onResume(): void {}

  /**
   * Cancel a scheduled event and return its remaining time relative to now
   * (clamped to ≥ 0). Pass the event's absolute fire time — for MU-bound events
   * that is `mu.plannedExitTime`. Helper for `onFreeze()` overrides.
   */
  protected freezeEvent(eventId: number, plannedTime: number): number {
    const now = this.manager?.currentTime ?? 0;
    const remaining = Math.max(0, plannedTime - now);
    if (eventId >= 0) this.manager?.cancelEvent(eventId);
    return remaining;
  }

  // ── Snapshot ──

  snapshotBlockedMUs(): Array<[DESComponent, DESMU[]]> { return [...this.blockedMUs]; }

  toSnapshot(): DESComponentSnapshot {
    // Persist completed intervals only; display statistics fold in the open interval.
    const timings: Record<string, { duration: number; entries: number }> = {};
    for (const [name, entry] of this.stateTimings) timings[name] = { ...entry };

    return {
      path: this.path,
      type: (this.constructor as { type?: string }).type ?? 'DESComponent',
      state: this.state,
      currentLoad: this.currentLoad,
      totalProcessed: this.totalProcessed,
      isBlocked: this.isBlocked,
      isWorking: this.isWorking,
      isFailure: this.isFailure,
      exitBlocked: this.exitBlocked,
      muIds: this.mus.map(m => m.id),
      pendingTransferCommits: this._pendingTransferCommits,
      prop: { ...this.prop },
      stateTimings: timings,
      currentStateName: this.currentStateName,
      stateStartTime: this.stateStartTime,
      statBaselineTime: this.statBaselineTime,
      processedBaseline: this.processedBaseline,
      progressArmedSince: this.progressArmedSince === this.progressArmedSince ? this.progressArmedSince : null,
      lastProgressSec: this.lastProgressSec === this.lastProgressSec ? this.lastProgressSec : null,
      categorySince: this.categorySince,
    };
  }

  /**
   * Restore component state from a snapshot.
   *
   * @param snap    the component snapshot.
   * @param simTime the snapshot's sim time, used for the legacy baseline default.
   *
   * NOTE: `onRestored()` is NOT called here — the orchestrating
   * `restoreSnapshot()` calls it once per component AFTER MU/RNG/script state
   * is applied (a hook using `self.random()` must see the restored stream).
   */
  fromSnapshot(snap: DESComponentSnapshot, simTime?: number): void {
    this._pendingTransferCommits = snap.pendingTransferCommits ?? 0;
    this.state = snap.state;
    this.currentLoad = snap.currentLoad;
    this.totalProcessed = snap.totalProcessed;
    this.isBlocked = snap.isBlocked;
    this.isWorking = snap.isWorking;
    this.isFailure = snap.isFailure;
    this.exitBlocked = snap.exitBlocked;
    this.prop = { ...snap.prop };
    this.currentStateName = snap.currentStateName;

    this.stateTimings.clear();
    for (const [name, entry] of Object.entries(snap.stateTimings)) {
      this.stateTimings.set(name, { ...entry });
    }
    const now = simTime ?? this.manager?.currentTime ?? 0;
    this.stateStartTime = snap.stateStartTime;
    // v1→v2 defensive defaults (plan-261 §2.4): a v1 snapshot has no baseline
    // fields — defaulting to the snapshot time keeps every KPI a number (the
    // window restarts at the restore point instead of producing NaN).
    this.statBaselineTime = snap.statBaselineTime ?? now;
    this.processedBaseline = snap.processedBaseline ?? 0;
    // Literal; the participant normalised a legacy snapshot (plan-2241 F4).
    this.progressArmedSince = snap.progressArmedSince ?? NaN;
    this.lastProgressSec = snap.lastProgressSec ?? NaN;
    this.categorySince = snap.categorySince ?? snap.stateStartTime;
  }
}
