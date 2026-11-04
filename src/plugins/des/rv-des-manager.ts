// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-des-manager.ts -- DES simulation manager.
 *
 * Central orchestrator for discrete event simulation:
 * - Event loop with 4-ary min-heap queue
 * - Integer-indexed component and MU arrays for O(1) lookup
 * - Pre-allocated scratch ActionContext for zero-allocation dispatch
 * - Three modes: FastForward, Animated, Step
 * - Snapshot / restore (manager-level slice; full pipeline in rv-des-snapshot.ts)
 */

import { captureStreamsDoc, validateStreamsDoc, applyStreamsDoc, type RngStreamsDoc } from './rv-des-rng-state';
import { DESEventQueue } from './rv-des-event-queue';
import { RngStreamHandle, type RngVersion } from '../../core/rv-rng-streams';
import {
  ACTION_BY_INDEX,
  ACTION_INDEX,
  ACTION_NAME,
  registerAction,
} from './rv-des-named-actions';
import { SFC32, type RngStream } from '../../core/rv-rng-distribution';
import type { ActionContext, IDESManagerRef, DESSerializedEvent } from './rv-des-event';
import {
  NO_MU, NO_ENTITY, DEFAULT_PRIORITY, CHECKPOINT_ACTION, CHECKPOINT_PRIORITY,
  WARMUP_ACTION, WARMUP_PRIORITY,
} from './rv-des-event';
import type {
  ReservationRecord,
  MuRef,
} from '../../core/material-flow/material-flow-self';

/**
 * Action index of the neutral checkpoint SYSTEM event. Registered ONCE with a
 * no-op handler — dispatch is id-keyed inside `_processEventsUpTo` (the
 * `onCheckpoint` hook), the registration only keeps name→index resolution
 * valid for the queue. Lookup-or-register keeps HMR/double-import safe.
 */
/** Transient callbacks require an explicit, restorable origin at the snapshot boundary. */
export const DES_CALLBACK_ACTION = 'DES.Callback';


const CHECKPOINT_ACTION_IDX: number =
  ACTION_INDEX.get(CHECKPOINT_ACTION) ?? registerAction(CHECKPOINT_ACTION, () => {}, { owner: 'des.manager', payload: 'none', handleFields: ['checkpointEventId'] });
const WARMUP_ACTION_IDX: number =
  ACTION_INDEX.get(WARMUP_ACTION) ?? registerAction(WARMUP_ACTION, () => {}, { owner: 'des.manager', payload: 'none', handleFields: ['warmupEventId'] });

// ── Simulation modes ──

export enum DESMode {
  /** Process all events as fast as possible (no rendering). */
  FastForward = 'FastForward',
  /** Advance simTime by real dt, process events up to simTime. */
  Animated = 'Animated',
  /** Process one event per user action. */
  Step = 'Step',
}

// ── Minimal component interface (for Phase 1 -- expanded in Phase 2) ──

export interface IDESComponent {
  desId?: string | null;
  entityId: number;
  readonly path: string;
  /** Wire the manager back-reference (called by `registerComponent`) so
   *  clock-dependent code (statistics) can read `manager.currentTime`. */
  attachManager(manager: DESManager): void;
  /** Reset accumulated statistics to a fresh window starting now (warmup). */
  resetStatistics(): void;
}

// ── Minimal MU interface (for Phase 1 -- expanded in Phase 2) ──

export interface IDESMU {
  id: number;
  generation: number;
  childMUs: MuRef[];
  parentMU: MuRef | null;
  carrierCapacity?: number;
  /** Refcount of queued events referencing this MU (managed by the manager). */
  pendingEvents?: number;
  /** Deferred-retire flag: slot is freed once pendingEvents drains to 0. */
  retired?: boolean;
  retireNotified?: boolean;
}

// ── DESManager ──

export class DESManager implements IDESManagerRef {
  // ── Event queue ──
  private queue: DESEventQueue;

  // ── Flat arrays for O(1) lookup (populated at init) ──
  private _components: IDESComponent[] = [];
  private _componentPaths: string[] = [];
  private _mus: (IDESMU | null)[] = [];
  /** Freed MU slots ready for reuse (retired MUs — memory stays bounded by WIP). */
  private _freeMuIds: number[] = [];
  /** Highest generation ever assigned per MU slot. Survives reset and snapshots. */
  private _muGenerations: number[] = [];
  /**
   * plan-2212: MUs consumed during the current event, retired when that event's
   * dispatch ends (see {@link retireAfterEvent}). Empty between events.
   */
  private readonly _retireAfterEvent: IDESMU[] = [];

  // Persisted active downstream reservations. Terminal records are removed
  // immediately, so memory and snapshot size stay bounded by live contention.
  private _reservations = new Map<number, ReservationRecord>();
  private _nextReservationId = 1;

  /** Runner hook used to release event-associated tween bookkeeping. */
  onEventConsumed: ((eventId: number) => void) | null = null;
  private readonly _lastFailedEvent = { id: -1, time: 0, entityId: -1, actionIndex: -1, componentPath: '' };
  get lastFailedEvent(): Readonly<typeof this._lastFailedEvent> { return this._lastFailedEvent; }
  /** Runner-owned visual disposal hook. Fired once at logical retirement. */
  onMURetired: ((mu: IDESMU) => void) | null = null;
  /** Re-materialize newly exposed hierarchy layers outside hot paths. */
  onHierarchyChanged: (() => void) | null = null;
  /** Carrier retirement releases reservations and wakes their holders. */
  onReservationsRolledBack: ((records: readonly ReservationRecord[]) => void) | null = null;

  // ── Simulation state ──
  private _currentTime = 0;
  private _totalEventsProcessed = 0;
  private _isPaused = false;
  private _mode: DESMode = DESMode.Animated;
  private _duration = 86400; // default: 1 day in seconds (Infinity = run until empty)
  /** Temporary FF boundary; never persisted as the simulation end. */
  private _processingTarget = Infinity;
  private _processingTargetAlreadyReached = false;
  private _statResetTime = 0; // sim time at which component statistics reset (0 = off)
  private _statResetDone = true; // warmup is initially off; re-armed by configuration/reset
  private _masterSeed = 42;
  private _rngVersion: RngVersion = 1;
  private _rng: SFC32;
  private readonly _streams = new Map<string, Map<string, RngStreamHandle>>();

  /** Maximum events to process per batch (prevents infinite loops). */
  private _maxEventsPerBatch = 10000;

  /**
   * Pre-dispatch time-advance hook: called ONCE per distinct event time, BEFORE
   * the first event at that time dispatches. The DESRunner wires this to
   * `TweenRegistry.settle(t)` so every event handler samples visuals (MU
   * positions, drive/turntable rotations) at EXACTLY the event's sim time.
   *
   * Without it, handlers that read live geometry (e.g. the Turntable's
   * `rideOffToOutput` sampling the MU's world position, or `attach()` reparenting
   * with the current world transform) see STALE visuals whenever multiple events
   * process without a render in between — worst in FastForward, where a whole
   * ride-on → rotate → ride-off sequence runs inside ONE frame batch and the
   * computed tween endpoints send parts to positions far off the plant.
   */
  onTimeAdvance: ((time: number) => void) | null = null;

  /**
   * Additional time-advance listeners (plan-260 A2): fired with the SAME
   * once-per-distinct-event-time semantics as `onTimeAdvance`, AFTER it. The
   * single-slot `onTimeAdvance` stays reserved for the runner's tween settle;
   * multi-consumers (checkpoint autosave) attach here without overwriting it.
   */
  private readonly _timeAdvanceListeners: Array<(time: number) => void> = [];

  /** Last event time the additional listeners fired for. Tracked separately
   *  from `_currentTime` — the Animated clock advances by dt and can COINCIDE
   *  with an event's time (dt-grid alignment), which must not swallow the
   *  listener edge. Re-armed in `reset()`. */
  private _lastListenerTime = -1;

  /**
   * Run-archive hook (plan-260 B1): called at the TOP of `reset()` with the
   * PRE-reset clock/counters, BEFORE any state is cleared — the single place
   * that covers native DES and the DESRunner (both funnel through
   * `manager.reset()`). The run-lifecycle controller archives the finished
   * run (statistics are still intact at this point).
   */
  onBeforeReset: ((info: {
    currentTime: number;
    totalEventsProcessed: number;
    isComplete: boolean;
  }) => void) | null = null;

  /** Once-per-run guard for `des:complete` (plan-260 A3): armed on reset. */
  private _completeNotified = false;

  /**
   * Rasterized-checkpoint hook: fired when the scheduled checkpoint SYSTEM
   * event dispatches — the sim clock stands EXACTLY on the requested grid
   * boundary and every time-equal model event has already run (minimum
   * priority). Single slot; the CheckpointController owns it.
   */
  onCheckpoint: ((time: number) => void) | null = null;

  /** Event id of the single scheduled checkpoint system event (-1 = none).
   *  Cleared on reset/restore (queue ids restart there — a stale id must
   *  never be cancelled against a recycled model event id). */
  private _checkpointEventId = -1;
  private _warmupEventId = -1;

  /** Side-channel for event data payloads (TypedArray queue can't store JS objects). */
  private _eventData = new Map<number, unknown>();

  // ── Pre-allocated scratch context (zero allocation per dispatch) ──
  private readonly _ctx: ActionContext & { _entityId: number } = {
    simTime: 0,
    componentPath: '',
    muId: -1,
    data: null,
    manager: this,
    _entityId: -1,
  };

  constructor(initialQueueCapacity = 4096) {
    this.queue = new DESEventQueue(initialQueueCapacity);
    this._rng = new SFC32(this._masterSeed);
  }

  // ── Public properties ──

  /** Run-owned sequence; restore never consumes it. */
  customIdCounter = 0;
  get nextEventId(): number { return this.queue.nextId; }
  exportRunState() {
    return { statResetTime: this._statResetTime, statResetDone: this._statResetDone,
      masterSeed: this._masterSeed, rngState: this._rng.getState(),
      totalEventsProcessed: this._totalEventsProcessed, customIdCounter: this.customIdCounter,
      warmupEventId: this._warmupEventId, checkpointEventId: this._checkpointEventId,
      lastListenerTime: this._lastListenerTime, completeNotified: this._completeNotified };
  }
  applyRunState(s: ReturnType<DESManager['exportRunState']>, time: number): void {
    this._currentTime = time;
    this._statResetTime = s.statResetTime;
    this._statResetDone = s.statResetDone;
    this._masterSeed = s.masterSeed;
    this._rng.setState(s.rngState);
    this._totalEventsProcessed = s.totalEventsProcessed;
    this.customIdCounter = s.customIdCounter;
    this._warmupEventId = s.warmupEventId;
    this._checkpointEventId = s.checkpointEventId;
    this._lastListenerTime = s.lastListenerTime;
    this._completeNotified = s.completeNotified;
  }
  exportMUAllocator() {
    return {
      slotLength: this._mus.length, freeSlots: this._freeMuIds, generations: this._muGenerations,
      // plan-2212: MUs consumed outside any dispatch whose retirement is still due
      // (before the next event). Non-empty only between such a consumption and the
      // next event/sweep - carried so a restore retires them at the same point.
      pendingRetire: this._retireAfterEvent.map(mu => ({ id: mu.id, gen: mu.generation })),
    };
  }
  replaceMUSlots(slots: (IDESMU | null)[], free: number[], generations: number[],
    pendingRetire: ReadonlyArray<{ id: number; gen: number }> = []): void {
    this._mus = slots; this._freeMuIds = free; this._muGenerations = generations;
    this._retireAfterEvent.length = 0;
    for (const ref of pendingRetire) {
      const mu = slots[ref.id];
      if (mu && mu.generation === ref.gen) this._retireAfterEvent.push(mu);
    }
  }
  exportQueue(componentId: (entityId: number) => string, encode: (data: unknown) => import('./rv-snapshot-contract').SnapshotJson): import('./rv-des-action-schema').PersistableQueueEvent[] {
    return this.queue.snapshot().map(e => {
      const action = ACTION_NAME.get(e.actionIndex);
      if (!action) throw new Error(`unknown action index ${e.actionIndex}`);
      const data = this._eventData.get(e.id);
      return { id: e.id, time: e.time, action, componentId: e.entityId === -1 ? null : componentId(e.entityId),
        muId: e.muId, priority: e.priority, ...(data == null ? {} : { data: encode(data) }) };
    });
  }
  /** Pending events that carry a payload (restore re-links tween windows to them). */
  queuedEventsWithData(): Array<{ id: number; time: number; muId: number; entityId: number; data: unknown }> {
    const out: Array<{ id: number; time: number; muId: number; entityId: number; data: unknown }> = [];
    for (const e of this.queue.snapshot()) {
      const data = this._eventData.get(e.id);
      if (data != null) out.push({ id: e.id, time: e.time, muId: e.muId, entityId: e.entityId, data });
    }
    return out;
  }
  /** Queue and data have already been allocated and resolved. */
  swapPreparedQueue(queue: DESEventQueue, data: Map<number, unknown>): void {
    this.queue = queue; this._eventData = data;

  }

  get currentTime(): number { return this._currentTime; }
  get totalEventsProcessed(): number { return this._totalEventsProcessed; }
  get isPaused(): boolean { return this._isPaused; }
  get mode(): DESMode { return this._mode; }
  set mode(m: DESMode) { this._mode = m; }
  get duration(): number { return this._duration; }
  set duration(d: number) { this._duration = d; }
  setProcessingTarget(t: number | null): void {
    if (t !== null && (!Number.isFinite(t) || t < 0)) {
      throw new RangeError('Processing target must be a finite non-negative time');
    }
    this._processingTarget = t ?? Infinity;
    this._processingTargetAlreadyReached = t !== null && this._currentTime >= t;
  }
  get statResetTime(): number { return this._statResetTime; }
  set statResetTime(t: number) {
    this._statResetTime = Math.max(0, t);
    this._statResetDone = this._statResetTime === 0;
    this._scheduleWarmup();
  }

  /** Reset every component's statistics to a fresh window starting at the current sim
   *  time (warmup). Fired ONCE automatically when the clock crosses statResetTime. */
  resetStatistics(): void {
    for (const comp of this._components) comp.resetStatistics();
  }

  /** Replace the warmup system event at its absolute boundary. A boundary the
   *  clock has already passed (warmup changed mid-run) fires at the current time
   *  — never in the past, which would move the clock backwards. */
  /** Re-arm a warm-up that was dropped as an orphan event because the end time was
   *  reached first (run continued past the end). No-op when it already fired or is pending. */
  rearmWarmup(): void {
    if (!this._statResetDone && this._warmupEventId < 0) this._scheduleWarmup();
  }

  private _scheduleWarmup(): void {
    if (this._warmupEventId >= 0) this.queue.cancel(this._warmupEventId);
    this._warmupEventId = -1;
    if (this._statResetTime > 0 && !this._statResetDone) {
      this._warmupEventId = this.queue.enqueue(
        Math.max(this._statResetTime, this._currentTime), WARMUP_ACTION_IDX, NO_ENTITY, NO_MU, WARMUP_PRIORITY,
      );
    }
  }
  get masterSeed(): number { return this._masterSeed; }
  get rngVersion(): RngVersion { return this._rngVersion; }
  get rng(): RngStream { return this._rngVersion === 1 ? this._rng : this.stream('__manager__', 'default'); }

  get isComplete(): boolean {
    // MODEL events decide completion — pending warmup/checkpoint system events
    // never keeps a finished run alive (identical to a run without autosave).
    const t = this.nextModelEventTime;
    return t === Number.POSITIVE_INFINITY || t > this._duration;
  }

  /**
   * Time of the next pending MODEL event, ignoring both system events;
   * +Infinity when only system events (or nothing) remain. The O(n)
   * exclusion scan runs ONLY while a system event is top-of-queue.
   */
  get nextModelEventTime(): number {
    const t = this.queue.peekTime;
    if ((this._checkpointEventId < 0 && this._warmupEventId < 0) || t === Number.POSITIVE_INFINITY) return t;
    const id = this.queue.peekId();
    if (id !== this._checkpointEventId && id !== this._warmupEventId) return t;
    return this.queue.minTimeExcluding2(this._checkpointEventId, this._warmupEventId);
  }

  // ── Checkpoint system event (rasterized autosaves) ──

  /**
   * Schedule (or re-schedule) THE checkpoint system event at an absolute sim
   * time — a neutral event that dispatches the `onCheckpoint` hook: no action
   * table, no MU, no statistics, not counted in `totalEventsProcessed`. At
   * most ONE is pending; scheduling replaces the previous one. Scheduling is
   * purely sim-time/settings-driven, so seeded runs stay bit-identical.
   */
  scheduleCheckpoint(time: number): void {
    // plan-2058 F01: same time contract as model events — never backwards.
    if (!(time >= this._currentTime) || time === Number.POSITIVE_INFINITY) {
      this._throwInvalidEventTime(time, CHECKPOINT_ACTION, '');
    }
    this.cancelCheckpoint();
    this._checkpointEventId = this.queue.enqueue(
      time, CHECKPOINT_ACTION_IDX, NO_ENTITY, NO_MU, CHECKPOINT_PRIORITY,
    );
  }

  /** Cancel the pending checkpoint system event (no-op when none). */
  cancelCheckpoint(): void {
    if (this._checkpointEventId >= 0) {
      this.queue.cancel(this._checkpointEventId);
      this._checkpointEventId = -1;
    }
  }

  /** True while a checkpoint system event is pending in the queue. */
  get hasScheduledCheckpoint(): boolean {
    return this._checkpointEventId >= 0;
  }

  /** Number of registered components. */
  get componentCount(): number { return this._components.length; }

  /** Number of MU slots ever allocated (live + freed for reuse) — the high-water mark of WIP. */
  get muCount(): number { return this._mus.length; }

  /** Number of MUs currently alive (allocated slots minus the freed ones waiting for reuse). */
  get liveMuCount(): number { return this._mus.length - this._freeMuIds.length; }

  /**
   * Number of events currently held by the event queue, cancelled ones not yet drained
   * included (plan-612 #211). Unity parity: `DESManager.QueuedEventCount`. A model that
   * schedules more than it consumes shows up here as unbounded growth.
   */
  get queuedEventCount(): number { return this.queue.count; }

  // ── IDESManagerRef implementation ──

  getComponentByEntityId(entityId: number): IDESComponent | null {
    return this._components[entityId] ?? null;
  }

  getMU(muId: number): IDESMU | null {
    return this._mus[muId] ?? null;
  }

  /** Resolve a generation-safe hierarchy/reservation reference. */
  getMUByRef(ref: MuRef): IDESMU | null {
    const mu = this._mus[ref.id] ?? null;
    return mu && !mu.retired && mu.generation === ref.gen ? mu : null;
  }

  // ── Component / MU registration ──

  /**
   * Register a component. Assigns an integer entityId and stores in flat array.
   */
  registerComponent(comp: IDESComponent): number {
    if (this._rngVersion === 2 && comp.desId != null) {
      this.assertUniqueRngIds([...this._components, comp]);
    }
    const entityId = this._components.length;
    comp.entityId = entityId;
    // Wire the manager back-reference so the component's clock-dependent code
    // (statistics: setState/getStatistics read `this.manager.currentTime`) works.
    // Native components also set this in their own init(), but the unified
    // MaterialFlowAdapter has no such init — without this its state durations stay
    // 0 (now defaults to 0), so utilization stats never accumulate.
    comp.attachManager(this);
    this._components.push(comp);
    this._componentPaths.push(comp.path);

    return entityId;
  }

  /**
   * Register an MU. Assigns an integer id and stores in flat array. Reuses a
   * freed slot from a retired MU when available, so the array (and retained
   * memory) stays bounded by work-in-progress, not total production.
   */
  registerMU(mu: IDESMU): number {
    const free = this._freeMuIds.pop();
    const muId = free !== undefined ? free : this._mus.length;
    const previousGeneration = this._muGenerations[muId];
    const generation = previousGeneration === undefined ? 0 : previousGeneration + 1;
    mu.id = muId;
    mu.generation = generation;
    mu.pendingEvents = 0;
    mu.retired = false;
    mu.retireNotified = false;
    this._muGenerations[muId] = generation;
    if (free !== undefined) this._mus[muId] = mu;
    else this._mus.push(mu);
    return muId;
  }

  /**
   * Register an MU at a FIXED slot id (snapshot restore, plan-261 Phase 2.5).
   * The restored event queue references MUs by their ORIGINAL integer ids —
   * re-assigning fresh ids (registerMU) would break that mapping. Grows the
   * array with null holes as needed and removes the slot from the free list.
   */
  registerMUAt(mu: IDESMU, id: number, generation = mu.generation): void {
    while (this._mus.length <= id) {
      this._freeMuIds.push(this._mus.length);
      this._mus.push(null);
    }
    const freeIdx = this._freeMuIds.indexOf(id);
    if (freeIdx >= 0) this._freeMuIds.splice(freeIdx, 1);
    mu.id = id;
    mu.generation = Math.max(0, Math.trunc(generation));
    mu.pendingEvents = 0;
    mu.retired = false;
    mu.retireNotified = false;
    this._muGenerations[id] = Math.max(this._muGenerations[id] ?? -1, mu.generation);
    this._mus[id] = mu;
  }

  snapshotMUGenerations(): number[] {
    return this._muGenerations.slice();
  }

  restoreMUGenerations(generations: readonly number[] = []): void {
    this._muGenerations = generations.map((value) => (
      Number.isInteger(value) && value >= 0 ? value : 0
    ));
  }

  /**
   * Retire a consumed MU (sink path): drop the manager's reference so the
   * object can be garbage-collected and its slot reused. When events still
   * reference the MU (pendingEvents > 0), the free is DEFERRED until the last
   * one fires or is cancelled — a queued event never resolves to a wrong,
   * recycled MU. Stale or repeated retires are no-ops (slot identity guard).
   */
  retireMU(mu: IDESMU): void {
    this._retireMURecursive(mu, new Set<string>());
  }

  private _retireMURecursive(mu: IDESMU, visiting: Set<string>): void {
    const id = mu.id;
    if (id < 0 || this._mus[id] !== mu || mu.retired) return;
    const key = `${id}:${mu.generation}`;
    if (visiting.has(key)) {
      console.warn(`[DESManager] hierarchy cycle while retiring MU ${key}; branch skipped`);
      return;
    }
    visiting.add(key);
    const parent = mu.parentMU ? this.getMUByRef(mu.parentMU) : null;
    if (parent) {
      const index = parent.childMUs.findIndex(
        (ref) => ref.id === id && ref.gen === mu.generation,
      );
      if (index >= 0) parent.childMUs.splice(index, 1);
    }
    mu.parentMU = null;

    const children = mu.childMUs.slice();
    mu.childMUs.length = 0;
    for (const ref of children) {
      const child = this.getMUByRef(ref);
      if (child) this._retireMURecursive(child, visiting);
    }

    const rolledBack = this.rollbackReservationsForCarrier({ id, gen: mu.generation });
    if (rolledBack.length > 0) this.onReservationsRolledBack?.(rolledBack);

    mu.retired = true;
    if (!mu.retireNotified) {
      mu.retireNotified = true;
      this.onMURetired?.(mu);
    }
    if ((mu.pendingEvents ?? 0) > 0) {
      mu.retired = true; // deferred — freed by _decPendingMU when it drains
      visiting.delete(key);
      this.onHierarchyChanged?.();
      return;
    }
    this._freeMuSlot(id);
    visiting.delete(key);
    this.onHierarchyChanged?.();
  }

  /**
   * plan-2212: retire a consumed MU at the END of the event that consumed it -
   * in DES time, inside the event. MU ids are slot ids and a retired slot is
   * reused by the next `registerMU`, so the moment of retirement decides which
   * id a later part gets: tied to the event, the ids are the same whatever
   * slices the run (FastForward batches cut by wall clock, steps, animated
   * frames, snapshot/restore). Retiring IMMEDIATELY would free the slot while
   * the consuming call chain still holds the MU (it may queue events for it).
   * Outside an event dispatch the retirement waits for the start of the next
   * event (or {@link flushRetirements}).
   */
  retireAfterEvent(mu: IDESMU): void {
    this._retireAfterEvent.push(mu);
  }

  /** Retire every MU queued by {@link retireAfterEvent} (idempotent, in queue order). */
  flushRetirements(): void {
    const list = this._retireAfterEvent;
    if (list.length === 0) return;
    for (let i = 0; i < list.length; i++) this.retireMU(list[i]);
    list.length = 0;
  }

  /** Free an MU slot (null the ref, recycle the id). */
  private _freeMuSlot(id: number): void {
    this._mus[id] = null;
    this._freeMuIds.push(id);
  }

  /** Bump the pending-event refcount of a queued MU (no-op for NO_MU / holes). */
  private _incPendingMU(muId: number): void {
    if (muId < 0) return;
    const mu = this._mus[muId];
    if (mu) mu.pendingEvents = (mu.pendingEvents ?? 0) + 1;
  }

  /** Drop one pending-event reference; frees a deferred-retired MU at 0. */
  private _decPendingMU(muId: number): void {
    if (muId < 0) return;
    const mu = this._mus[muId];
    if (!mu) return;
    const n = Math.max(0, (mu.pendingEvents ?? 1) - 1);
    mu.pendingEvents = n;
    if (n === 0 && mu.retired) this._freeMuSlot(mu.id);
  }

  /**
   * Get a component by path (O(n) scan -- use for user API, not hot path).
   */
  getComponentByPath(path: string): IDESComponent | null {
    const idx = this._componentPaths.indexOf(path);
    return idx >= 0 ? this._components[idx] : null;
  }

  // â”€â”€ Persisted capacity reservations â”€â”€

  createReservation(
    holderId: string,
    targetId: string,
    n: number,
    port?: string,
    carrier?: { ref: MuRef; slots: number },
  ): ReservationRecord {
    const record: ReservationRecord = {
      id: this._nextReservationId++,
      holderId,
      targetId,
      ...(port ? { port } : {}),
      n,
      ...(carrier ? { carrier: structuredClone(carrier) } : {}),
      state: 'reserved',
    };
    this._reservations.set(record.id, record);
    return record;
  }

  getReservation(id: number): ReservationRecord | null {
    return this._reservations.get(id) ?? null;
  }

  get activeReservationCount(): number {
    return this._reservations.size;
  }

  reservedForTarget(targetId: string, exceptId = -1): number {
    let total = 0;
    for (const record of this._reservations.values()) {
      if (record.id !== exceptId && record.targetId === targetId && record.state === 'reserved') {
        total += record.n;
      }
    }
    return total;
  }

  reservedForCarrier(ref: MuRef, exceptId = -1): number {
    let total = 0;
    for (const record of this._reservations.values()) {
      if (
        record.id !== exceptId
        && record.state === 'reserved'
        && record.carrier?.ref.id === ref.id
        && record.carrier.ref.gen === ref.gen
      ) {
        total += record.carrier.slots;
      }
    }
    return total;
  }

  finishReservation(id: number, state: 'committed' | 'rolledback'): ReservationRecord | null {
    const record = this._reservations.get(id);
    if (!record) return null;
    record.state = state;
    this._reservations.delete(id);
    return record;
  }

  rollbackReservationsForTarget(targetId: string): ReservationRecord[] {
    const out = [...this._reservations.values()]
      .filter((record) => record.targetId === targetId && record.state === 'reserved')
      .sort((a, b) => a.id - b.id);
    for (const record of out) {
      record.state = 'rolledback';
      this._reservations.delete(record.id);
    }
    return out;
  }

  rollbackReservationsForCarrier(ref: MuRef): ReservationRecord[] {
    const out = [...this._reservations.values()]
      .filter((record) => (
        record.state === 'reserved'
        && record.carrier?.ref.id === ref.id
        && record.carrier.ref.gen === ref.gen
      ))
      .sort((a, b) => a.id - b.id);
    for (const record of out) {
      record.state = 'rolledback';
      this._reservations.delete(record.id);
    }
    return out;
  }

  snapshotReservations(): ReservationRecord[] {
    return [...this._reservations.values()]
      .filter((record) => record.state === 'reserved')
      .sort((a, b) => a.id - b.id)
      .map((record) => structuredClone(record));
  }

  swapPreparedReservations(records: Map<number, ReservationRecord>, nextId: number): void {
    this._reservations = records;
    this._nextReservationId = nextId;
  }

  get nextReservationId(): number {
    return this._nextReservationId;
  }

  restoreReservations(records: readonly ReservationRecord[] = [], nextId = 1): void {
    this._reservations.clear();
    let maxId = 0;
    for (const saved of records) {
      if (saved.state !== 'reserved') continue;
      const record = structuredClone(saved);
      this._reservations.set(record.id, record);
      maxId = Math.max(maxId, record.id);
    }
    this._nextReservationId = Math.max(1, nextId, maxId + 1);
  }

  /** Remove and return all live events owned by one component. */
  freezeEventsForEntity(entityId: number): Array<{
    id: number;
    time: number;
    action: string;
    muId: number;
    priority: number;
    data: unknown;
  }> {
    const out: Array<{
      id: number; time: number; action: string; muId: number; priority: number; data: unknown;
    }> = [];
    for (const event of this.queue.getSnapshot()) {
      if (event.cancelled || event.entityId !== entityId) continue;
      const action = ACTION_NAME.get(event.actionIndex);
      if (!action || action === CHECKPOINT_ACTION) continue;
      out.push({
        id: event.id,
        time: event.time,
        action,
        muId: event.muId,
        priority: event.priority,
        data: this._eventData.get(event.id) ?? null,
      });
    }
    out.sort((a, b) => a.time - b.time || a.id - b.id);
    for (const event of out) this.cancelEvent(event.id);
    return out;
  }

  // ── Event scheduling ──

  /**
   * Schedule an event at absolute time.
   * @param time - Absolute simulation time
   * @param actionName - Named action string (resolved to index)
   * @param entityId - Component integer ID
   * @param muId - MU integer ID (-1 for none)
   * @param priority - Higher fires first at same time (default 0)
   * @param data - Optional JSON-serializable payload
   * @returns Event ID for cancellation
   */
  scheduleEvent(
    time: number,
    actionName: string,
    entityId: number,
    muId = NO_MU,
    priority = DEFAULT_PRIORITY,
    data: unknown = null,
  ): number {
    const actionIdx = ACTION_INDEX.get(actionName);
    if (actionIdx === undefined) {
      throw new Error(`DES: unknown action '${actionName}'. Register with registerAction() first.`);
    }
    return this.scheduleEventByIndex(time, actionIdx, entityId, muId, priority, data);
  }

  /**
   * Schedule an event at absolute time by pre-resolved action INDEX — the
   * allocation-free hot path. Callers that resolved the index once at
   * registration (DESRunner's scheduler, R3) use this so no string is built or
   * looked up per event.
   */
  scheduleEventByIndex(
    time: number,
    actionIndex: number,
    entityId: number,
    muId = NO_MU,
    priority = DEFAULT_PRIORITY,
    data: unknown = null,
  ): number {
    // plan-2058 F01: the dispatch sets the clock to `event.time` unconditionally,
    // so a past or non-finite time would silently run the simulation clock
    // backwards (or jump it to Infinity). `!(time >= now)` also catches NaN.
    if (!(time >= this._currentTime) || time === Number.POSITIVE_INFINITY) {
      this._throwInvalidEventTime(time, ACTION_NAME.get(actionIndex) ?? `#${actionIndex}`,
        this._componentPaths[entityId] ?? '');
    }
    const eventId = this.queue.enqueue(time, actionIndex, entityId, muId, priority);
    if (data != null) {
      this._eventData.set(eventId, data);
    }
    this._incPendingMU(muId);
    return eventId;
  }

  /**
   * Schedule an event relative to current time.
   */
  scheduleIn(
    delay: number,
    actionName: string,
    entityId: number,
    muId = NO_MU,
    priority = DEFAULT_PRIORITY,
    data: unknown = null,
  ): number {
    return this.scheduleEvent(this._currentTime + delay, actionName, entityId, muId, priority, data);
  }

  /**
   * Schedule an event relative to current time by pre-resolved action INDEX
   * (see `scheduleEventByIndex`).
   */
  scheduleInByIndex(
    delay: number,
    actionIndex: number,
    entityId: number,
    muId = NO_MU,
    priority = DEFAULT_PRIORITY,
    data: unknown = null,
  ): number {
    return this.scheduleEventByIndex(this._currentTime + delay, actionIndex, entityId, muId, priority, data);
  }

  /** plan-2058 F01: the one error for an event time that is non-finite or in the past. */
  private _throwInvalidEventTime(time: number, action: string, componentPath: string): never {
    const where = componentPath ? ` on '${componentPath}'` : '';
    throw new RangeError(
      `DES: cannot schedule '${action}'${where} at t=${time} — event times must be finite and `
      + `not earlier than the current simulation time (${this._currentTime}).`,
    );
  }

  /**
   * Cancel an event by ID.
   */
  actionNameOf(eventId: number): string | undefined {
    const index = this.queue.actionIndexOf(eventId);
    return index === undefined ? undefined : ACTION_NAME.get(index);
  }
  eventDataOf(eventId: number): unknown { return this._eventData.get(eventId); }

  cancelEvent(eventId: number): boolean {
    this._eventData.delete(eventId);
    // Refcount: muIdOf returns -1 for an unknown or ALREADY cancelled event, so
    // a repeated cancel never double-decrements.
    const muId = this.queue.muIdOf(eventId);
    const ok = this.queue.cancel(eventId);
    if (ok) this._decPendingMU(muId);
    return ok;
  }

  // ── Simulation control ──

  /**
   * Process events in Animated mode: advance simTime by dt, process events up to simTime.
   * Returns number of events processed.
   */
  processAnimated(dt: number): number {
    if (this._isPaused) return 0;
    const target = this._currentTime + dt;
    const budget = this._maxEventsPerBatch;
    const processed = this._processEventsUpTo(target, budget);
    // A pause set by a handler mid-batch (plan-2058 F02) leaves events due at or
    // before `target` in the queue: the clock must stay at the last dispatched
    // event, or it would run ahead of them (and backwards on resume).
    if (processed < budget && !this._isPaused) this._currentTime = Math.max(this._currentTime, target);
    return processed;
  }

  /**
   * Process events in batch (for FastForward or explicit control).
   * Processes up to `batchSize` events, or until queue is empty / past duration.
   * Returns number of events processed.
   */
  processEvents(batchSize: number): number {
    if (this._isPaused) return 0;
    return this._processEventsUpTo(this._duration, batchSize);
  }

  /**
   * Process exactly one event (Step mode).
   * Returns true if an event was processed.
   */
  processStep(): boolean {
    if (this._isPaused) return false;
    return this._processEventsUpTo(this._duration, 1) > 0;
  }

  /**
   * Run the full simulation until complete or batchSize events processed.
   * For FastForward mode on main thread (requestIdleCallback fallback).
   * Returns { done, eventsProcessed }.
   */
  runBatch(batchSize: number): { done: boolean; eventsProcessed: number } {
    const target = this._processingTarget;
    if (this._processingTargetAlreadyReached) return { done: true, eventsProcessed: 0 };
    const maxTime = Math.min(this._duration, target);
    // The FastForward drain resumes the manager before it starts and does not
    // honour the pause flag (neither at entry nor mid-batch): a run that stopped
    // on a pause would report `done: false` forever and spin its drain loop.
    const processed = this._processEventsUpTo(maxTime, batchSize, false);
    const next = this.nextModelEventTime;
    // The boundary check includes SYSTEM events (warmup / checkpoint): with the batch budget
    // exhausted a pending one <= maxTime is not processed yet, so the run is not done and the
    // clock must not jump to the target past it.
    const done = this.queue.peekTime > maxTime;
    // An empty model queue ends at its last event, even if system events remain.
    // Otherwise the requested boundary (or the earlier duration) is exact.
    if (target !== Infinity && done && next !== Infinity) {
      this._currentTime = Math.max(this._currentTime, maxTime);
    }
    return { done, eventsProcessed: processed };
  }

  /** Pause the simulation. */
  pause(): void { this._isPaused = true; }

  /** Resume the simulation. */
  resume(): void { this._isPaused = false; }

  /**
   * Register an additional time-advance listener (plan-260 A2). Returns an
   * unsubscribe function. Fired once per distinct event time, after
   * `onTimeAdvance` — the sim state is consistent (previous event fully
   * dispatched) at that point.
   */
  addTimeAdvanceListener(fn: (time: number) => void): () => void {
    this._timeAdvanceListeners.push(fn);
    return () => {
      const i = this._timeAdvanceListeners.indexOf(fn);
      if (i >= 0) this._timeAdvanceListeners.splice(i, 1);
    };
  }

  /**
   * Once-per-run edge detection for `des:complete` (plan-260 A3): returns
   * true exactly ONCE per run — both emit sites (Animated tick + FastForward
   * completion) call this before emitting. Re-armed in `reset()`, NEVER on
   * pause/resume.
   */
  markCompleteNotified(): boolean {
    if (this._completeNotified) return false;
    this._completeNotified = true;
    return true;
  }

  /** Re-evaluate the completion edge after a restore or end-time change. */
  rearmCompleteNotified(): void { this._completeNotified = false; }

  /** Current checkpoint system event id, or -1 when none is scheduled. */
  get checkpointEventId(): number { return this._checkpointEventId; }

  /** Reset simulation to initial state. */
  reset(): void {
    this.customIdCounter = 0;
    // Plan-260 B1: hand the finished run to the archive BEFORE any state is
    // cleared (statistics/clock still intact). Guarded — a throwing archive
    // hook must never wedge the reset.
    if (this.onBeforeReset) {
      try {
        this.onBeforeReset({
          currentTime: this._currentTime,
          totalEventsProcessed: this._totalEventsProcessed,
          isComplete: this.isComplete,
        });
      } catch (e) {
        console.error('[DESManager] onBeforeReset hook threw:', e);
      }
    }
    this._completeNotified = false; // re-arm the des:complete once-per-run guard
    this._lastListenerTime = -1;    // re-arm the additional time-advance listeners
    this._currentTime = 0;
    this._totalEventsProcessed = 0;
    this._isPaused = false;
    this._statResetDone = this._statResetTime === 0;
    this.queue.clear();
    this._warmupEventId = -1;
    this._checkpointEventId = -1; // queue ids restart — never carry a stale slot
    this._eventData.clear();
    // Retire roots and nested children before dropping the slot array so every
    // visual/disposer and carrier reservation observes the same lifecycle.
    this._retireAfterEvent.length = 0;
    const liveMUs = this._mus.slice();
    for (const mu of liveMUs) if (mu && !mu.retired) this.retireMU(mu);
    this._mus = [];
    this._freeMuIds.length = 0;
    for (const record of this._reservations.values()) record.state = 'rolledback';
    this._reservations.clear();
    this._nextReservationId = 1;
    this._rng = new SFC32(this._masterSeed);
    this.reseedStreams();
    this._scheduleWarmup();
  }

  /**
   * Drop every registered component (entity ids restart at 0 with the next
   * `registerComponent`). Call only with no MODEL events queued (after `reset()`):
   * queued events address components by entity id. Decorated-action protos
   * stay registered — their resolver reads the live array. Used by the
   * runner's scene rebind (plan-612 CP1d-b), never by the user reset.
   */
  clearComponents(): void {
    // Streams belong to the component binding, not to the registration: ordinary
    // runner restarts re-register the same adapters and must keep their handles.
    this._components = [];
    this._componentPaths = [];
  }

  /** Full reset including components. */
  dispose(): void {
    this.reset();
    this._muGenerations.length = 0;
    for (const id of [...this._streams.keys()]) if (id !== '__manager__') this.releaseStreams(id);
    this.clearComponents();
    this._components = [];
    this._componentPaths = [];
    this.onMURetired = null;
    this.onHierarchyChanged = null;
    this.onReservationsRolledBack = null;
  }

  /** Validate and select the next run's RNG version; repeated values are inert. */
  setRngVersion(v: number): void {
    // Validate before touching seed, clock, queue or the version, even mid-run.
    if (v !== 1 && v !== 2) throw new Error(`rng-version-unknown: ${v}`);
    // Reasserting the same parameter (batch slots/restoration) is not a change.
    if (v === this._rngVersion) return;
    // System events scheduled by reset do not make the model run active.
    if (this.currentTime > 0 || this.nextModelEventTime !== Number.POSITIVE_INFINITY) {
      throw new Error('rng-version-run-in-progress: reset before changing RNG version');
    }
    if (v === 2) this.assertUniqueRngIds(this._components);
    this._rngVersion = v;
    this.reseedStreams();
  }

  /** Set master seed and recreate RNG. */
  setMasterSeed(seed: number): void {
    this._masterSeed = seed;
    this._rng = new SFC32(seed);
    this.reseedStreams();
  }

  stream(componentId: string, purpose: string, legacy: RngStream | null = null): RngStream {
    if (this._rngVersion === 1) {
      if (!legacy) throw new Error('rng-v1-no-named-streams');
      return legacy;
    }
    if (!componentId) throw new Error('des-rng-id-missing');
    let purposes = this._streams.get(componentId);
    if (!purposes) this._streams.set(componentId, purposes = new Map());
    let handle = purposes.get(purpose);
    if (!handle) {
      handle = new RngStreamHandle(this._masterSeed, componentId, purpose);
      purposes.set(purpose, handle);
    }
    return handle;
  }

  streamEntries(): ReadonlyArray<RngStreamHandle> {
    return [...this._streams.values()].flatMap(streams => [...streams.values()]);
  }

  releaseStreams(componentId: string): void { this._streams.delete(componentId); }

  private reseedStreams(): void {
    for (const purposes of this._streams.values()) {
      for (const handle of purposes.values()) handle.reseed(this._masterSeed);
    }
  }

  private assertUniqueRngIds(components: readonly IDESComponent[]): void {
    const ids = new Set<string>();
    for (const comp of components) {
      if (comp.desId == null) continue;
      if (ids.has(comp.desId)) throw new Error(`des-rng-duplicate-id: ${comp.desId}`);
      ids.add(comp.desId);
    }
  }

  /**
   * Create a per-component RNG seeded from masterSeed + componentIndex.
   */
  createComponentRng(componentIndex: number): SFC32 {
    return new SFC32(this._masterSeed + componentIndex);
  }

  // ── Event queue display snapshot ──

  /**
   * Return a human-readable snapshot of all pending events in the queue.
   * Resolves action names and component paths from integer indices.
   * Used by the Event Queue Window for display only -- does not modify the queue.
   */
  getEventQueueSnapshot(): Array<{
    time: number;
    actionName: string;
    componentPath: string;
    componentShortName: string;
    muId: number;
    priority: number;
    cancelled: boolean;
    id: number;
  }> {
    const raw = this.queue.getSnapshot();
    return raw.map(e => {
      const fullPath = this._componentPaths[e.entityId] ?? '';
      const parts = fullPath.split('/');
      return {
        time: e.time,
        actionName: ACTION_NAME.get(e.actionIndex) ?? `#${e.actionIndex}`,
        componentPath: fullPath,
        componentShortName: parts[parts.length - 1] || fullPath,
        muId: e.muId,
        priority: e.priority,
        cancelled: e.cancelled,
        id: e.id,
      };
    });
  }

  /** Number of pending events (including cancelled) in the queue. */
  get pendingEventCount(): number {
    return this.queue.count;
  }

  /** Time of the next pending event, or +Infinity when the queue is empty. */
  get nextEventTime(): number {
    return this.queue.peekTime;
  }

  /**
   * Advance the simulation up to `maxTime`, processing AT MOST `maxEvents`
   * events. This is BUDGET-SAFE (Plan 194 B4):
   * when the event budget is exhausted before `maxTime` is reached, the
   * remaining events are NOT dropped — they stay in the queue and `currentTime`
   * is left at the last processed event's time, so the next call resumes
   * exactly where this one stopped (the batch is spread across frames, never
   * truncated into an inconsistent state).
   *
   * @returns `{ processed, hitBudget }` — `hitBudget` is true when the batch
   *   stopped early: at the cap with more events still due at/before
   *   `maxTime`, OR on a pause a handler set mid-batch (plan-2058 F02) —
   *   regardless of when the next event is due. Either way the caller must
   *   not advance its clock past `currentTime` (it pulls its render clock
   *   back to the real sim position and continues next frame).
   */
  processUpTo(maxTime: number, maxEvents: number): { processed: number; hitBudget: boolean } {
    if (this._isPaused) return { processed: 0, hitBudget: false };
    const processed = this._processEventsUpTo(maxTime, maxEvents);
    // A pause a handler set mid-batch is ALWAYS an early stop, even when the
    // next event lies beyond `maxTime`: the runner pulls its render clock back
    // only on `hitBudget`, and while paused it never calls again — reporting
    // false here would leave the render clock stuck ahead of the paused sim
    // time (post-impl review of plan-2058 F02). Without a pause, the cap is an
    // early stop only when another event is still due ≤ maxTime.
    const hitBudget = this._isPaused || (processed >= maxEvents && this.queue.peekTime <= maxTime);
    return { processed, hitBudget };
  }

  // ── Snapshot (manager-level slice of the full rv-des-snapshot pipeline) ──

  /**
   * Serialize the entire simulation state to a JSON-safe object.
   */
  snapshot(): {
    currentTime: number;
    statResetTime?: number;
    statResetDone?: boolean;
    masterSeed: number;
    rngVersion: RngVersion;
    rngStreams?: RngStreamsDoc;
    rngState: [number, number, number, number];
    events: DESSerializedEvent[];
    totalEventsProcessed: number;
  } {
    const events: DESSerializedEvent[] = [];
    for (const e of this.queue.snapshot()) {
      const actionName = ACTION_NAME.get(e.actionIndex);
      if (!actionName) continue;
      // Script.Hook events carry a LIVE dispatcher object (adapter → VM) in
      // their payload — not JSON-serializable and bound to a VM instance that
      // will not exist after restore. They are deliberately skipped: script
      // components re-arm their pending timers in onRestore(state) (use
      // `self.at(absoluteTime, hook)` with a time stored in onSnapshot() for
      // exact continuation) — plan-261 §2.3.
      const payload = this._eventData.get(e.id) as { rvScriptHook?: boolean } | undefined;
      if (payload && payload.rvScriptHook === true) continue;
      // SYSTEM events are scheduling infrastructure, not model state.
      // Restore re-plans them; serialized copies would double-fire.
      if (actionName === CHECKPOINT_ACTION || actionName === WARMUP_ACTION) continue;
      // plan-645 S5: callback events carry a closure key, not model state.

      events.push({
        time: e.time,
        action: actionName,
        componentPath: this._componentPaths[e.entityId] ?? '',
        muId: e.muId,
        priority: e.priority,
        data: this._eventData.get(e.id) ?? null,
      });
    }
    return {
      currentTime: this._currentTime,
      statResetTime: this._statResetTime,
      statResetDone: this._statResetDone,
      masterSeed: this._masterSeed,
      rngVersion: this._rngVersion,
      ...(this._rngVersion === 2 ? { rngStreams: captureStreamsDoc(this._masterSeed, this.streamEntries()) } : {}),
      rngState: this._rng.getState(),
      events,
      totalEventsProcessed: this._totalEventsProcessed,
    };
  }

  /**
   * Restore simulation state from a snapshot.
   */
  restore(snap: {
    currentTime: number;
    statResetTime?: number;
    statResetDone?: boolean;
    masterSeed: number;
    rngVersion: RngVersion;
    rngStreams?: RngStreamsDoc;
    rngState: [number, number, number, number];
    events: DESSerializedEvent[];
    totalEventsProcessed: number;
  }): void {
    if (!Number.isInteger(snap.rngVersion) || (snap.rngVersion !== 1 && snap.rngVersion !== 2)) {
      throw new Error(`rng-version-unknown: ${snap.rngVersion}`);
    }
    if (snap.rngVersion !== this._rngVersion) {
      throw new Error(`rng-version-mismatch: snapshot ${snap.rngVersion}, run ${this._rngVersion}`);
    }
    const streams = this._rngVersion === 2
      ? validateStreamsDoc(snap.rngStreams, { knownId: id => id.length > 0 }) : undefined;
    if (this._rngVersion === 2 && !Number.isFinite(snap.masterSeed)) throw new Error('invalid masterSeed');
    if (streams && streams.masterSeed !== snap.masterSeed)
      throw new Error('RNG masterSeed differs from the des.manager masterSeed');
    if (!Array.isArray(snap.rngState) || snap.rngState.length !== 4 || !snap.rngState.every(Number.isInteger))
      throw new Error('rng-state-invalid');
    this._currentTime = snap.currentTime;
    this._statResetTime = snap.statResetTime ?? this._statResetTime;
    this._statResetDone = snap.statResetDone
      ?? (this._statResetTime === 0 || this._currentTime >= this._statResetTime);
    this._masterSeed = snap.masterSeed;
    this._rng.setState(snap.rngState);
    if (streams) applyStreamsDoc(streams, this, () => true);
    this._totalEventsProcessed = snap.totalEventsProcessed;

    // Re-enqueue events (resolve action names to current indices)
    this.queue.clear();
    this._checkpointEventId = -1; // ids restart; the controller re-arms the chain
    this._warmupEventId = -1;
    this._eventData.clear();
    for (const e of snap.events) {
      // Never restore serialized system events outside their single-slot
      // tracking: warmup and checkpoint scheduling are re-planned separately.
      if (e.action === CHECKPOINT_ACTION || e.action === WARMUP_ACTION) continue;
      const actionIdx = ACTION_INDEX.get(e.action);
      if (actionIdx === undefined) continue; // skip unknown actions
      const entityId = this._componentPaths.indexOf(e.componentPath);
      if (entityId < 0) continue; // skip unknown components
      const eventId = this.queue.enqueue(e.time, actionIdx, entityId, e.muId, e.priority);
      if (e.data != null) {
        this._eventData.set(eventId, e.data);
      }
      this._incPendingMU(e.muId);
    }
    this._scheduleWarmup();
  }

  // ── Internal event processing ──

  /**
   * Process events up to maxTime, up to batchSize events.
   * Returns number of events actually processed.
   *
   * `honourPause` (plan-2058 F02): the pause flag is checked before EVERY event,
   * not only at batch entry — a handler that pauses the simulation stops the
   * batch right after its own event. Only the FastForward drain (`runBatch`)
   * passes false.
   */
  private _processEventsUpTo(maxTime: number, batchSize: number, honourPause = true): number {
    let processed = 0;

    while (processed < batchSize) {
      if (honourPause && this._isPaused) break;
      const nextTime = this.queue.peekTime;
      if (nextTime > maxTime || nextTime === Number.POSITIVE_INFINITY) break;

      // Orphan system event: when the DUE top event is a warmup/checkpoint
      // event but no model event remains at or before the sim end, the model
      // is over — drop it silently (no clock advance, no listeners, no save).
      // A run with autosave then completes bit-identically to one without.
      if (this._checkpointEventId >= 0 || this._warmupEventId >= 0) {
        const nextId = this.queue.peekId();
        if (nextId === this._checkpointEventId || nextId === this._warmupEventId) {
          const tModel = this.queue.minTimeExcluding2(this._checkpointEventId, this._warmupEventId);
          if (tModel === Number.POSITIVE_INFINITY || tModel > this._duration) {
            this.queue.cancel(nextId);
            if (nextId === this._checkpointEventId) this._checkpointEventId = -1;
            else this._warmupEventId = -1;
            continue;
          }
        }
      }

      // Additional listeners (plan-260 A2): once per distinct EVENT time,
      // fired BEFORE the next event is dequeued — every event at the previous
      // time is fully dispatched and the upcoming event is STILL IN THE QUEUE,
      // so a checkpoint snapshot taken here is complete (dequeue-then-snapshot
      // would silently drop the in-flight event on restore). Tracked
      // independently of the (dt-advanced) Animated clock; plain indexed loop.
      if (this._timeAdvanceListeners.length > 0 && nextTime !== this._lastListenerTime) {
        this._lastListenerTime = nextTime;
        const tls = this._timeAdvanceListeners;
        for (let i = 0; i < tls.length; i++) tls[i](nextTime);
      }

      const event = this.queue.dequeue();
      if (!event) break;

      // Time advances → let the runner settle the tweens to the NEW time before
      // this event's handler runs (visual state == sim state at dispatch; once
      // per distinct time — same-time bursts settle only on the first event).
      if (this.onTimeAdvance && event.time !== this._currentTime) {
        this.onTimeAdvance(event.time);
      }

      // Advance simulation time
      this._currentTime = event.time;

      if (event.id === this._warmupEventId) {
        this._warmupEventId = -1;
        this._statResetDone = true;
        this.resetStatistics();
        processed++; // system work counts toward the frame budget, not model metrics
        continue;
      }

      // Checkpoint system event: the clock stands EXACTLY on the grid
      // boundary and all time-equal model events have dispatched (minimum
      // priority). Hand off to the hook — no action table, no statistics,
      // NOT counted in totalEventsProcessed (model metrics stay identical
      // to a run without autosave). Guarded — a throwing hook must never
      // wedge the event loop.
      if (event.id === this._checkpointEventId) {
        this._checkpointEventId = -1;
        try {
          this.onCheckpoint?.(event.time);
        } catch (e) {
          console.error('[DESManager] onCheckpoint hook threw:', e);
        }
        processed++; // counts toward the frame budget (snapshots are heavy)
        continue;
      }

      // Populate scratch context
      const ctx = this._ctx;
      ctx.simTime = event.time;
      ctx._entityId = event.entityId;
      ctx.componentPath = this._componentPaths[event.entityId] ?? '';
      ctx.muId = event.muId;
      // Retrieve and consume event data from side-channel
      const data = this._eventData.get(event.id);
      if (data !== undefined) {
        ctx.data = data;
        this._eventData.delete(event.id);
      } else {
        ctx.data = null;
      }

      // A consumption outside any dispatch (startup, a command) retires before
      // this event allocates - the same point whatever sliced the run.
      if (this._retireAfterEvent.length > 0) this.flushRetirements();

      // Dispatch via O(1) array index
      const action = ACTION_BY_INDEX[event.actionIndex];
      let ok = false;
      try {
        if (action) action(ctx);
        ok = true;
      } finally {
        if (!ok) {
          const failed = this._lastFailedEvent;
          failed.id = event.id;
          failed.time = event.time;
          failed.entityId = event.entityId;
          failed.actionIndex = event.actionIndex;
          failed.componentPath = ctx.componentPath;
        }
        this.onEventConsumed?.(event.id);
        // Keep the MU resolvable until dispatch and tween cleanup finish.
        this._decPendingMU(event.muId);
        // plan-2212: MUs consumed by this event retire now, in DES time.
        if (this._retireAfterEvent.length > 0) this.flushRetirements();
      }

      processed++;
      this._totalEventsProcessed++;
    }

    return processed;
  }
}
