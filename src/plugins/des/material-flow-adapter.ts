// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * material-flow-adapter.ts (PRIVATE, concrete) -- `MaterialFlowAdapter extends
 * DESComponent` (Plan 194 §2.6 P5).
 *
 * This is the concrete adapter used by DESRunner. It subclasses the real
 * private `DESComponent` so the DESManager can register it, run the material
 * flow handshake (canAccept/acceptMU/releaseMU/onDownstreamReady), and dispatch
 * named-action hooks against it — but every decision delegates into the
 * definition's `des` (and shared `logic`) blocks via the shared `self` context.
 *
 * The shared `self` is the single mutable surface (Plan 194 §2.3). Its
 * scheduling (`self.in/at/cancel/now`) is wired to a `DesScheduler` the
 * DESRunner injects (which namespaces a short hook suffix → `<type>.<Suffix>`
 * named-action index, resolved once at registration, R3).
 *
 * PRIVATE — imports `DESComponent`/`DESManager` (private) plus the public
 * material-flow types. It is only ever constructed by the (private) DESRunner,
 * so the public build never sees it.
 */

import type { Object3D } from 'three';
import type {
  MaterialFlowDefinition,
} from '../../core/material-flow/define-material-flow';
import type {
  MaterialFlowSelf,
  TransferResult,
  MU,
  Port,
  MuRef,
  ReservationHandle,
  ReservationRecord,
  FrozenDescriptor,
  JsonValue,
  AcceptPose,
  AcceptContext,
} from '../../core/material-flow/material-flow-self';
import type { RVMovingUnit } from '../../core/engine/rv-mu';
import {
  DESComponent,
  freeCarrierSlots,
  loadMUOnCarrier,
  unloadMUFromCarrier,
  type DESComponentSnapshot,
  type AcceptState,
} from './rv-des-component';
import type { DESMU } from './rv-des-mu';
import type { HookDispatchTarget } from './des-hook-adapter';
import { selfRunStateOf, type SelfRunState } from '../../core/material-flow/material-flow-self';

type ProcessingAttachmentPoint = 'accept' | 'transfer' | 'cycle-dwell';

interface AttachmentProcessingPayload {
  readonly __desProcessingAttachment: true;
  readonly point: 'accept' | 'transfer';
  readonly entryTime?: number;
  readonly componentsVisited?: number;
}

interface ActiveAttachmentProcessing {
  readonly muId: number;
  readonly point: 'accept' | 'transfer';
}

const ACTIVE_PROCESSING_KEY = '__desAttachmentProcessing';
const READY_PROCESSING_KEY = '__desAttachmentReady';

/**
 * Outcome of a pose hand-over (plan-631 F2 / R2-1). `ownerKept` = the MU is
 * still held by the component it came from (nothing changed hands, or the
 * hand-over was rolled back); the caller re-seats its visual.
 */
export type PoseTransferResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      /**
       * - `pose-unsupported`: the target type does not declare `des.acceptsPose`
       * - `async-accept`: the target defers its accept (Processing attachment
       *   at `accept`) — a pose is only valid on the synchronous accept path
       * - `refused`: the pre-check failed (capacity or pose off the belt)
       * - `rolled-back`: the pre-check passed but the accept failed after the
       *   owner released the MU (re-entrant wake-ups filled the target); the MU
       *   was handed back to its owner
       */
      readonly reason: 'pose-unsupported' | 'async-accept' | 'refused' | 'rolled-back';
      readonly ownerKept: boolean;
    };

// plan-2241: armed rule per definition kind.
const PROGRESS_BASE = 0, PROGRESS_SOURCE = 1, PROGRESS_AGV = 2, PROGRESS_SINK = 3;

/** One pending pose: valid for exactly this MU on this (target) adapter. */
interface PendingPose {
  readonly muId: number;
  readonly pose: AcceptPose;
}

function isAttachmentProcessingPayload(data: unknown): data is AttachmentProcessingPayload {
  return !!data
    && typeof data === 'object'
    && (data as Partial<AttachmentProcessingPayload>).__desProcessingAttachment === true;
}

/**
 * Concrete DES adapter for ONE material-flow instance. Subclasses `DESComponent`
 * so the engine treats it like any native DES component, but routes the
 * handshake + named-action hooks into the definition's `des`/`logic` blocks.
 */
export class MaterialFlowAdapter extends DESComponent implements HookDispatchTarget {
  /** The definition this adapter drives (its `des`/`logic` blocks). */
  readonly def: MaterialFlowDefinition;
  /** The shared `self` context (Plan 194 §2.3) — DES mode, scheduler-backed. */
  readonly self: MaterialFlowSelf;

  /** Fixed type tag (DESComponent.type is static; instances expose `def.type`). */
  get componentType(): string {
    return this.def.type;
  }

  /**
   * Runner-wired: fires when the sink path consumed an MU (its visual is marked
   * for removal by the Sink behavior's onAccept). Lets the runner dispose the
   * visual from a small pending list instead of scanning EVERY MU ever
   * registered each frame.
   */
  onMUConsumed: ((mu: DESMU) => void) | null = null;

  /**
   * plan-2212 Phase 2: arrival listeners of a sink (`self.sink(path).on` of
   * Model-Scripts in DES). Called synchronously at the END of `acceptMU`, at the
   * DES time of the arrival - inside the event that delivered the MU, so a
   * snapshot never holds an extra queue event for them. Kept sorted by
   * `orderKey` (code-unit compare; equal keys keep registration order), so the
   * delivery order does not depend on when a listener (re)subscribed.
   */
  private readonly consumedListeners: Array<{ fn: (mu: DESMU) => void; key: string; live: boolean }> = [];

  /** Number of registered arrival listeners (diagnostics / leak tests). */
  get consumedListenerCount(): number {
    return this.consumedListeners.length;
  }

  /**
   * plan-2212 Phase 2: register a sink-arrival listener (see `consumedListeners`).
   * `orderKey` fixes the delivery order among listeners (the script node path);
   * returns the idempotent unsubscribe.
   */
  addConsumedListener(fn: (mu: DESMU) => void, orderKey = ''): () => void {
    const entry = { fn, key: orderKey, live: true };
    const list = this.consumedListeners;
    let at = list.length;
    while (at > 0 && list[at - 1].key > orderKey) at--;
    list.splice(at, 0, entry);
    return () => {
      entry.live = false;   // an arrival being delivered right now skips it too
      const i = list.indexOf(entry);
      if (i >= 0) list.splice(i, 1);
    };
  }

  /** Runner-owned idempotent visual materialisation seam for robot handling. */
  materializeMu: ((mu: MU) =>
    | { ok: true; visual: RVMovingUnit; created: boolean }
    | { ok: false; reason: string; message: string }) | null = null;

  /**
   * DEV-only settle guard (plan-262 Phase 2): wired by `DESRunner.addInstance`
   * behind `import.meta.env.DEV` — warns when a hook of a type WITHOUT
   * `samplesLiveGeometry` dispatches against a mid-tween MU while the
   * event-time settle is disabled. Never set in production builds (the call
   * site below is compile-time dead code there).
   */
  devSettleGuard: ((suffix: string, mu: MU | null) => void) | null = null;
  /** Runner scope used to inherit this source's visual template in legacy hooks. */
  beforeHookDispatch: (() => void) | null = null;

  /** Runner-owned conversion between live scheduled work and JSON descriptors. */
  synchronizeScheduledClock: (() => void) | null = null;
  freezeScheduledWork: (() => FrozenDescriptor[]) | null = null;
  resumeScheduledWork: ((frozen: readonly FrozenDescriptor[]) => void) | null = null;
  private frozen: FrozenDescriptor[] = [];
  private processingAttachmentTime = 0;
  private processingAttachmentSource = '';
  /**
   * Pending take-over poses for THIS target (plan-631 F2, R2-1). A stack, not a
   * slot: a re-entrant hand-over during the owner's release (upstream wake-ups)
   * pushes its own entry, and a hook only ever sees the entry of the MU it is
   * called for. Every entry is removed in a `finally` by the call that pushed it.
   */
  private readonly pendingPoses: PendingPose[] = [];
  private readonly savedAccept: AcceptState = { owner: null, entryTime: 0, componentsVisited: 0 };

  private readonly _progressKind: number;

  /** Canonical adapter-held collection projected by `self.mus/currentLoad`. */
  get heldMUs(): ReadonlyArray<DESMU> {
    return this.mus;
  }

  constructor(def: MaterialFlowDefinition, self: MaterialFlowSelf, node: Object3D) {
    super(node);
    this.def = def;
    this.self = self;
    this.onRestored = () => {
      if (this.def.type === 'Source') {
        const ref = this.restoredSourcePending;
        this.restoredSourcePending = null;
        const mu = ref ? this.manager?.getMUByRef(ref) ?? null : null;
        if (ref && !mu) throw new Error(`Source '${this.path}': pending MU ${ref.id}:${ref.gen} missing after restore`);
        (this.self.local as { pending?: unknown }).pending = mu;
      }
      return this.def.des?.onRestore?.(this.self, this.snapshotState);
    };
    // Share the prop bag so DESComponent snapshots and self.prop stay identical.
    this.prop = self.prop;
    this._progressKind = def.kind === 'sink' ? PROGRESS_SINK
      : def.type === 'Source' ? PROGRESS_SOURCE : def.type === 'Agv' ? PROGRESS_AGV : PROGRESS_BASE;
  }

  /** plan-2241: Source also while `pending`, Agv while it has a task, Sink never. */
  override get progressArmed(): boolean {
    switch (this._progressKind) {
      case PROGRESS_SINK: return false;
      case PROGRESS_AGV: return (this.self.local as { task?: unknown }).task != null;
      case PROGRESS_SOURCE: return super.progressArmed || (this.self.local as { pending?: unknown }).pending != null;
      default: return super.progressArmed;
    }
  }

  override snapshotProgressArmed(snap: Omit<DESComponentSnapshot, 'path'>, blockedCount: number, part: ((key: string) => unknown) | null): boolean {
    switch (this._progressKind) {
      case PROGRESS_SINK: return false;
      case PROGRESS_AGV: {
        // Capture (no raw snapshot): the live task is the saved one.
        if (!part) return this.progressArmed;
        const state = part(`fleet.agv:${this.desId}`) as { task?: unknown } | undefined;
        return state?.task != null;
      }
      case PROGRESS_SOURCE:
        return super.snapshotProgressArmed(snap, blockedCount, part)
          || (snap as { sourcePending?: unknown }).sourcePending != null;
      default: return super.snapshotProgressArmed(snap, blockedCount, part);
    }
  }

  // ── Material-flow handshake (delegates into def.des) ────────────────────

  override canAccept(mu: DESMU): boolean {
    if (this.isFailure) return false;
    // A component whose shared setup disabled itself (`self.disable()`, e.g. a
    // conveyor without Transport-*/Sensor-* nodes) never initialised its DES
    // state — it takes no MU, so the upstream holds instead of crashing in
    // the hook (the runner reports it in the Problems panel).
    if (this.self.disabled) return false;
    // A sink CONSUMES MUs (it never retains or forwards them), so it has
    // unlimited capacity and must never back-pressure the upstream line — mirrors
    // the native DESSink (`MaxCapacity = Infinity`). Without this bypass a sink
    // built on the unified Sink behavior inherits DESComponent's default
    // MaxCapacity=1: it accepts ONE MU (which onAccept destroys) but, having
    // nothing to forward, never frees the load slot, so currentLoad stays 1 and
    // the conveyor feeding it deadlocks at the line's tail.
    if (this.def.kind !== 'sink' && this.currentLoad + this.reservedLoad >= this.MaxCapacity) return false;
    const hook = this.def.des?.canAccept;
    // No port in the base handshake path; routers receive it via the named
    // action data payload (dispatchHook).
    if (!hook) return true;
    // plan-631: the 4th argument exists ONLY for a pending pose of THIS MU —
    // every other call keeps the legacy three-argument form (bit-identical).
    const ctx = this.poseContext(mu);
    return ctx
      ? hook(this.self, mu as unknown as MU, undefined, ctx)
      : hook(this.self, mu as unknown as MU, undefined);
  }

  override acceptMU(mu: DESMU): boolean {
    if (!this.canAccept(mu)) return false;
    // Primitive locals preserve the outer accept across re-entrant hooks.
    const owner = mu.currentComponent;
    const entryTime = mu.entryTime;
    const componentsVisited = mu.componentsVisited;
    const saved = this.savedAccept;
    saved.owner = owner;
    saved.entryTime = entryTime;
    saved.componentsVisited = componentsVisited;
    // plan-2241 F11: an attempt until onAccept's verdict.
    this._beginProgressAttempt();
    try {
      this.addMU(mu);
      if (this.processingPoint === 'accept' && this.processingAttachmentTime > 0) {
        this.beginAttachedProcessing(mu, 'accept', entryTime, componentsVisited);
      } else {
        const ctx = this.poseContext(mu);
        const accepted = ctx
          ? this.def.des?.onAccept?.(this.self, mu as unknown as MU, undefined, ctx)
          : this.def.des?.onAccept?.(this.self, mu as unknown as MU, undefined);
        // A hook returning `false` rejects after the fact — roll back the add.
        if (accepted === false) {
          saved.owner = owner;
          saved.entryTime = entryTime;
          saved.componentsVisited = componentsVisited;
          this.rollbackAccept(mu, saved);
          return false;
        }
      }
    } finally {
      this._endProgressAttempt();
    }
    // Sink semantics: the MU was consumed (destroyed) in onAccept, not held —
    // release the slot immediately so the sink never accumulates load, counts the
    // part as throughput (totalProcessed), and wakes the upstream component
    // (onDownstreamReady) so the next part discharges. Mirrors the native DESSink.
    if (this.def.kind === 'sink') {
      this.releaseMU(mu);
      this.onMUConsumed?.(mu);
      const listeners = this.consumedListeners;
      if (listeners.length > 0) this.notifyConsumed(mu, listeners);
    }
    return true;
  }

  /**
   * Delivers one arrival to the listeners registered when it started (membership
   * snapshot): a listener added during the delivery waits for the next arrival -
   * so a re-registering listener cannot chain without end - and one removed
   * during it is skipped. A throwing listener never blocks the others.
   */
  private notifyConsumed(mu: DESMU, listeners: ReadonlyArray<{ fn: (mu: DESMU) => void; live: boolean }>): void {
    const snapshot = listeners.slice();
    for (let i = 0; i < snapshot.length; i++) {
      if (!snapshot[i].live) continue;
      try { snapshot[i].fn(mu); } catch (err) {
        console.warn(`[DES] sink arrival listener failed (${this.node.name}):`, err);
      }
    }
  }

  // ── Pose hand-over (plan-631 F2 / R2-1 / R2-3) ──────────────────────────

  /** The hook context for `mu` — only when a pose is pending for exactly this MU. */
  private poseContext(mu: { id: number }): AcceptContext | undefined {
    const stack = this.pendingPoses;
    for (let i = stack.length - 1; i >= 0; i--) {
      if (stack[i].muId === mu.id) return { acceptPose: stack[i].pose };
    }
    return undefined;
  }

  /** Run `fn` with `pose` pending for `muId`; the entry is removed in `finally`. */
  private withPose<T>(muId: number, pose: AcceptPose, fn: () => T): T {
    const entry: PendingPose = { muId, pose };
    this.pendingPoses.push(entry);
    try {
      return fn();
    } finally {
      const stack = this.pendingPoses, i = stack.lastIndexOf(entry);
      if (i === stack.length - 1) stack.pop();
      else if (i >= 0) stack.splice(i, 1);
    }
  }

  /** Number of pending poses — 0 outside a pose hand-over (tests / diagnostics). */
  get pendingPoseCount(): number {
    return this.pendingPoses.length;
  }

  /**
   * Why this target cannot take a pose hand-over at all, or null. A pose is
   * valid only on the synchronous accept path of a type that declares
   * `des.acceptsPose` (R2-1).
   */
  poseUnsupportedReason(): 'pose-unsupported' | 'async-accept' | null {
    if (this.def.des?.acceptsPose !== true) return 'pose-unsupported';
    if (this.processingPoint === 'accept' && this.processingAttachmentTime > 0) return 'async-accept';
    return null;
  }

  /**
   * Pre-check a pose hand-over of `mu` (capacity + pose plausibility) without
   * changing anything. False for a target that cannot take a pose at all.
   */
  canAcceptWithPose(mu: DESMU, pose: AcceptPose): boolean {
    if (this.poseUnsupportedReason()) return false;
    return this.withPose(mu.id, pose, () => this.canAccept(mu));
  }

  /**
   * Pre-validate a pose BEFORE the MU exists (R2-3, production source): the
   * same check as {@link canAcceptWithPose} against a probe carrying only the
   * template size (`[x, y, z]` m in the MU's own frame — the size
   * `presetMuBugSize` puts on every spawned MU). Refusal reports the same
   * Problems entry; nothing is spawned or changed.
   */
  canAcceptPoseProbe(templateSize: readonly [number, number, number], pose: AcceptPose): boolean {
    if (this.poseUnsupportedReason()) return false;
    // id −1 never collides with a registered MU (ids start at 0 and count up).
    const probe = { id: -1, _bugSize: [templateSize[0], templateSize[1], templateSize[2]] };
    return this.withPose(probe.id, pose, () => this.canAccept(probe as unknown as DESMU));
  }

  /**
   * Hand `mu` from its current `owner` to THIS target, taken over at `pose`
   * (plan-631 F2). Order, all synchronous:
   *  1. pre-check (`canAccept` with the pose) — refused → the owner keeps the MU;
   *  2. `owner.releaseMU(mu)` — may re-enter (onMUExit, upstream wake-ups, a
   *     nested hand-over into this target; a nested MU never sees this pose);
   *  3. `acceptMU(mu)` with the pose — refused after the pre-check (R2-1) →
   *     the MU is handed back to `owner` (`ownerKept`), like the legacy
   *     PalletYard drop rollback.
   * The pose is pending only for this call and only for this MU (`finally`).
   * Visual parenting is the caller's: detach before, re-seat on `ownerKept`.
   */
  transferInWithPose(owner: DESComponent, mu: DESMU, pose: AcceptPose): PoseTransferResult {
    const unsupported = this.poseUnsupportedReason();
    if (unsupported) return { ok: false, reason: unsupported, ownerKept: true };
    return this.withPose(mu.id, pose, (): PoseTransferResult => {
      if (!this.canAccept(mu)) return { ok: false, reason: 'refused', ownerKept: true };
      // plan-2241 F11: the owner's progress and lifecycle count only on commit.
      let committed = false;
      owner._holdProgress(mu);
      try {
        owner.releaseMU(mu);
        if (this.acceptMU(mu)) { committed = true; return { ok: true }; }
        // Refused after the pre-check: back to the owner. The owner just released
        // it, so its own accept normally succeeds; if a re-entrant wake-up filled
        // the owner too, the MU is re-attached without the capacity check — an
        // MU must never be lost (no owner) by a failed hand-over.
        if (!owner.acceptMU(mu)) {
          (owner as unknown as { addMU(m: DESMU): void }).addMU(mu);
        }
        return { ok: false, reason: 'rolled-back', ownerKept: true };
      } finally {
        owner._releaseHeldProgress(mu, committed);
      }
    });
  }

  override onDownstreamReady(from: DESComponent): void {
    if (this.self.disabled) return;
    if (this.def.kind === 'storage') super.onDownstreamReady(from);
    const hook = this.def.des?.onDownstreamReady;
    if (hook) {
      hook(this.self, from as unknown);
    } else if (this.def.kind !== 'storage') {
      super.onDownstreamReady(from);
    }
    // A Source's `pending` changes only in its own hooks.
    if (this._progressKind === PROGRESS_SOURCE) this._progressCheck();
  }

  override onTransferCommitted(mu: DESMU): void {
    if (this.def.kind === 'storage' && mu.currentComponent === this) {
      this.def.des?.onDownstreamReady?.(this.self, undefined);
    }
  }

  /**
   * Public entry for the unified `self.transfer(mu)` bridge — runs the native
   * blocking handshake (canAccept → accept → release / block) against the
   * resolved downstream. The DESRunner wires `self.onTransfer` to this so a
   * definition's `des` hook can hand an MU off with the same semantics the
   * native DES components use.
   */
  transferMU(mu: DESMU): TransferResult {
    if (mu.inTransfer) return 'deferred';
    if (this.processingPoint === 'transfer' && this.processingAttachmentTime > 0) {
      if (this.isProcessingReady(mu.id)) {
        return this.tryTransferMU(mu);
      }
      if (!this.isProcessingActive(mu.id)) this.beginAttachedProcessing(mu, 'transfer');
      return 'deferred';
    }
    return this.tryTransferMU(mu);
  }

  override releaseMU(mu: DESMU): void {
    this.removeProcessingRecord(mu.id);
    super.releaseMU(mu);
  }

  override clearMUState(): void {
    super.clearMUState();
    // The self's FSM phase and statState de-dupe key are run state as well: a stale
    // de-dupe key would swallow the new run's first statState of the same category.
    selfRunStateOf(this.self)?.reset();
    this.frozen = [];
    this.self.prop[ACTIVE_PROCESSING_KEY] = [];
    this.self.prop[READY_PROCESSING_KEY] = [];
  }

  /** Configure this target from one central Processing attachment instance. */
  configureProcessingAttachment(processingTime: number, sourcePath: string): void {
    if (!Number.isFinite(processingTime) || processingTime <= 0) {
      throw new Error('DES Processing: processingTime must be greater than zero');
    }
    if (this.processingAttachmentSource && this.processingAttachmentSource !== sourcePath) {
      throw new Error(`DES Processing: '${this.path}' already has a Processing attachment`);
    }
    this.processingAttachmentSource = sourcePath;
    this.processingAttachmentTime = processingTime;
    this.self.prop.attachedProcessingTime = processingTime;
  }

  get attachedProcessingTime(): number {
    return this.processingAttachmentTime;
  }

  /**
   * True when this component delays its own outgoing transfer through a
   * Processing attachment at `transfer` (plan-638 Gate R1 #5): a source with it
   * cannot hand over at a pose synchronously and keeps the standard transfer.
   */
  get defersTransfer(): boolean {
    return this.processingPoint === 'transfer' && this.processingAttachmentTime > 0;
  }

  private get processingPoint(): ProcessingAttachmentPoint {
    return this.def.processingAttachmentPoint
      ?? (this.def.kind === 'station' ? 'accept' : 'transfer');
  }

  private activeProcessing(): ActiveAttachmentProcessing[] {
    const value = this.self.prop[ACTIVE_PROCESSING_KEY];
    return Array.isArray(value) ? value as unknown as ActiveAttachmentProcessing[] : [];
  }

  private processingReady(): number[] {
    const value = this.self.prop[READY_PROCESSING_KEY];
    return Array.isArray(value) ? value as unknown as number[] : [];
  }

  private isProcessingActive(muId: number): boolean {
    return this.activeProcessing().some((entry) => entry.muId === muId);
  }

  private isProcessingReady(muId: number): boolean {
    return this.processingReady().includes(muId);
  }

  private beginAttachedProcessing(mu: DESMU, point: 'accept' | 'transfer', entryTime?: number, componentsVisited?: number): void {
    const active = this.activeProcessing();
    active.push({ muId: mu.id, point });
    this.self.prop[ACTIVE_PROCESSING_KEY] = active as unknown as JsonValue;
    this.self.setState('Processing');
    this.self.statState('Working');
    // Absent fields stay ABSENT (never `undefined`): the payload is snapshot data
    // and the data contract has no undefined (plan-2059 F2).
    const payload: { -readonly [K in keyof AttachmentProcessingPayload]: AttachmentProcessingPayload[K] } = {
      __desProcessingAttachment: true, point,
    };
    if (entryTime !== undefined) payload.entryTime = entryTime;
    if (componentsVisited !== undefined) payload.componentsVisited = componentsVisited;
    this.self.in(this.processingAttachmentTime, 'AttachmentComplete', mu, payload);
  }

  private completeAttachedProcessing(mu: DESMU | null, payload: AttachmentProcessingPayload): void {
    if (!mu) return;
    this.self.prop[ACTIVE_PROCESSING_KEY] = this.activeProcessing()
      .filter((entry) => entry.muId !== mu.id) as unknown as JsonValue;
    if (payload.point === 'accept') {
      const accepted = this.def.des?.onAccept?.(this.self, mu as unknown as MU, undefined);
      if (accepted === false) {
        // The sender committed before this delayed hook. Detach without an
        // output or wake-up; it is too late to return ownership to that sender.
        const saved = this.savedAccept;
        saved.owner = null;
        saved.entryTime = payload.entryTime ?? mu.entryTime;
        saved.componentsVisited = payload.componentsVisited ?? mu.componentsVisited;
        this.rollbackAccept(mu, saved);
      }
      return;
    }
    const ready = this.processingReady();
    if (!ready.includes(mu.id)) ready.push(mu.id);
    this.self.prop[READY_PROCESSING_KEY] = ready as unknown as JsonValue;
    this.tryTransferMU(mu);
  }

  private removeProcessingRecord(muId: number): void {
    this.self.prop[ACTIVE_PROCESSING_KEY] = this.activeProcessing()
      .filter((entry) => entry.muId !== muId) as unknown as JsonValue;
    this.self.prop[READY_PROCESSING_KEY] = this.processingReady()
      .filter((id) => id !== muId) as unknown as JsonValue;
  }

  reserveDownstream(
    n: number,
    port?: Port,
    carrier?: { ref: MuRef; slots: number },
  ): ReservationHandle {
    if (!Number.isInteger(n) || n <= 0) {
      throw new Error(`DES: reservation size must be a positive integer (got ${n})`);
    }
    const target = this.reservationTarget(port);
    if (!target) throw new Error(`DES: '${this.path}' has no reservable downstream target`);
    const reserved = this.manager?.reservedForTarget(target.path) ?? 0;
    if (target.isFailure || target.currentLoad + reserved + n > target.MaxCapacity) {
      throw new Error(`DES: downstream capacity unavailable at '${target.path}'`);
    }
    if (carrier) {
      if (!Number.isInteger(carrier.slots) || carrier.slots <= 0) {
        throw new Error('DES: carrier reservation slots must be a positive integer');
      }
      const carrierMU = this.manager?.getMUByRef(carrier.ref) as DESMU | null;
      const alreadyReserved = this.manager?.reservedForCarrier(carrier.ref) ?? 0;
      if (!carrierMU || freeCarrierSlots(carrierMU) - alreadyReserved < carrier.slots) {
        throw new Error(`DES: carrier capacity unavailable at ${carrier.ref.id}:${carrier.ref.gen}`);
      }
    }
    const record = this.manager!.createReservation(this.path, target.path, n, port?.id, carrier);
    return this.handleFor(record, port);
  }

  downstreamFreeCapacity(port?: Port): number {
    const target = this.reservationTarget(port);
    if (!target || target.isFailure) return 0;
    if (target.def.kind === 'sink') return Number.POSITIVE_INFINITY;
    return Math.max(0, target.MaxCapacity - target.currentLoad - target.reservedLoad);
  }

  reservation(id: number): ReservationHandle | null {
    const record = this.manager?.getReservation(id);
    return record && record.holderId === this.path ? this.handleFor(record) : null;
  }

  get reservedLoad(): number {
    return this.manager?.reservedForTarget(this.path) ?? 0;
  }

  reconfigureCapacity(value: number): void {
    if (!Number.isFinite(value) || value <= 0 || !Number.isInteger(value)) {
      throw new Error(`DES: MaxCapacity for '${this.path}' must be a positive integer`);
    }
    const minimum = this.currentLoad + this.reservedLoad;
    if (value < minimum) {
      throw new Error(
        `DES: MaxCapacity for '${this.path}' cannot be reduced below currentLoad + reservations (${minimum})`,
      );
    }
    this.MaxCapacity = value;
  }

  private reservationTarget(port?: Port): MaterialFlowAdapter | null {
    const candidates = this.nextComponents.filter(
      (component): component is MaterialFlowAdapter => component instanceof MaterialFlowAdapter,
    );
    if (port) {
      const exact = candidates.find((component) => component.node === port.ownerRoot);
      if (exact) return exact;
    }
    return candidates[0] ?? null;
  }

  private handleFor(record: ReservationRecord, livePort?: Port): ReservationHandle {
    return {
      record,
      commitMany: (mus) => this.commitReservation(record.id, mus, livePort),
      rollback: () => { this.rollbackReservation(record.id); },
    };
  }

  private commitReservation(id: number, batch: readonly MU[], livePort?: Port): boolean {
    const record = this.manager?.getReservation(id);
    if (!record || record.holderId !== this.path || record.state !== 'reserved') return false;
    if (batch.length !== record.n) return false;
    const target = this.manager?.getComponentByPath(record.targetId);
    if (!(target instanceof MaterialFlowAdapter) || target.isFailure) return false;
    const unique = new Set(batch);
    if (unique.size !== batch.length) return false;
    // `batch` may be the adapter-backed `self.mus` view. Commit mutates that
    // collection, so iterate a stable copy to avoid skipping every other MU.
    const sourceMUs = batch.slice() as unknown as readonly DESMU[];
    if (sourceMUs.some((mu) => !this.ownsReservedMU(mu))) return false;
    const componentReservedByOthers = this.manager?.reservedForTarget(target.path, id) ?? 0;
    if (target.currentLoad + componentReservedByOthers + batch.length > target.MaxCapacity) {
      this.rollbackReservation(id);
      return false;
    }

    let carrierMU: DESMU | null = null;
    if (record.carrier) {
      carrierMU = this.manager?.getMUByRef(record.carrier.ref) as DESMU | null;
      const carrierReservedByOthers = this.manager?.reservedForCarrier(record.carrier.ref, id) ?? 0;
      if (
        !carrierMU
        || record.carrier.slots !== sourceMUs.length
        || freeCarrierSlots(carrierMU) - carrierReservedByOthers < record.carrier.slots
        || sourceMUs.includes(carrierMU)
      ) {
        this.rollbackReservation(id);
        return false;
      }
    }

    const port = livePort ?? (
      record.port ? this.self.outputs().find((candidate) => candidate.id === record.port) : undefined
    );
    const canAccept = target.def.des?.canAccept;
    if (canAccept && sourceMUs.some((mu) => !canAccept(target.self, mu as unknown as MU, port))) {
      this.rollbackReservation(id);
      return false;
    }

    const hierarchyOrigins = sourceMUs.map((mu) => ({
      mu,
      parent: mu.parentMU ? this.manager?.getMUByRef(mu.parentMU) as DESMU | null : null,
    }));
    const parentChildren = new Map<DESMU, MuRef[]>();
    for (const origin of hierarchyOrigins) {
      if (origin.parent && !parentChildren.has(origin.parent)) {
        parentChildren.set(origin.parent, origin.parent.childMUs.map((ref) => ({ ...ref })));
      }
    }

    // plan-2241 F11: holder and target are one attempt.
    this._beginProgressAttempt();
    target._beginProgressAttempt();
    try {
      return this.commitReservationBatch(id, target, sourceMUs, carrierMU, hierarchyOrigins, parentChildren, port);
    } finally {
      target._endProgressAttempt();
      this._endProgressAttempt();
    }
  }

  private commitReservationBatch(
    id: number,
    target: MaterialFlowAdapter,
    sourceMUs: readonly DESMU[],
    carrierMU: DESMU | null,
    hierarchyOrigins: ReadonlyArray<{ mu: DESMU; parent: DESMU | null }>,
    parentChildren: ReadonlyMap<DESMU, MuRef[]>,
    port: Port | undefined,
  ): boolean {
    const accepted: DESMU[] = [];
    for (const mu of sourceMUs) {
      unloadMUFromCarrier(mu, this.manager);
      this.detachReservedMU(mu);
      target.addReservedMU(mu);
      accepted.push(mu);
      const ok = target.def.des?.onAccept?.(target.self, mu as unknown as MU, port);
      if (ok === false) {
        for (const moved of accepted) {
          target.detachReservedMU(moved);
          const origin = hierarchyOrigins.find((candidate) => candidate.mu === moved);
          if (!origin?.parent) this.addReservedMU(moved);
        }
        this.restoreHierarchyOrigins(hierarchyOrigins, parentChildren);
        this.rollbackReservation(id);
        return false;
      }
    }

    if (carrierMU) {
      const loaded: DESMU[] = [];
      for (const mu of sourceMUs) {
        if (!loadMUOnCarrier(carrierMU, mu, this.manager)) {
          for (const nested of loaded) unloadMUFromCarrier(nested, this.manager);
          for (const moved of accepted) {
            target.detachReservedMU(moved);
            const origin = hierarchyOrigins.find((candidate) => candidate.mu === moved);
            if (!origin?.parent) this.addReservedMU(moved);
          }
          this.restoreHierarchyOrigins(hierarchyOrigins, parentChildren);
          this.rollbackReservation(id);
          return false;
        }
        loaded.push(mu);
      }
    }

    this.recordOutput(sourceMUs.length);
    this.manager?.finishReservation(id, 'committed');
    // Reservation-aware targets (notably fixed-cell conveyors) keep their
    // barrier closed while incoming capacity is promised. Wake the target only
    // after the final promise was consumed so it can re-evaluate that barrier.
    if (target.reservedLoad === 0) target.onDownstreamReady(this);
    this.notifyUpstreamCapacity();
    return true;
  }

  private rollbackReservation(id: number): void {
    const record = this.manager?.finishReservation(id, 'rolledback');
    if (!record) return;
    for (const target of this.nextComponents) {
      if (target.path === record.targetId && target instanceof MaterialFlowAdapter) {
        if (target.reservedLoad === 0) target.onDownstreamReady(this);
        break;
      }
    }
  }

  private ownsReservedMU(mu: DESMU): boolean {
    if (this.mus.includes(mu)) return true;
    const visited = new Set<string>();
    let current: DESMU | null = mu;
    while (current?.parentMU) {
      const key = `${current.parentMU.id}:${current.parentMU.gen}`;
      if (visited.has(key)) return false;
      visited.add(key);
      current = this.manager?.getMUByRef(current.parentMU) as DESMU | null;
      if (current && this.mus.includes(current)) return true;
    }
    return false;
  }

  private restoreHierarchyOrigins(
    origins: ReadonlyArray<{ mu: DESMU; parent: DESMU | null }>,
    parentChildren: ReadonlyMap<DESMU, MuRef[]>,
  ): void {
    for (const { mu, parent } of origins) {
      if (parent) loadMUOnCarrier(parent, mu, this.manager);
    }
    for (const [parent, children] of parentChildren) {
      parent.childMUs = children.map((ref) => ({ ...ref }));
    }
  }

  private detachReservedMU(mu: DESMU): void {
    const index = this.mus.indexOf(mu);
    if (index >= 0) this.mus.splice(index, 1);
    this.currentLoad = this.mus.length;
    mu.currentComponent = null;
  }

  private addReservedMU(mu: DESMU): void {
    this.addMU(mu);
  }

  private notifyUpstreamCapacity(): void {
    if (this.currentLoad >= this.MaxCapacity) return;
    for (const previous of this.previousComponents) previous.onDownstreamReady(this);
  }

  // ── Named-action hook dispatch (Plan 194 §2.2 / R3) ─────────────────────

  validateBehaviourState(state: unknown, ctx: import('../../core/material-flow/define-material-flow').BehaviourSnapshotContext): void {
    this.def.des?.validateSnapshot?.(state, { ...ctx, portCounts: { inputs: this.self.inputs().length, outputs: this.self.outputs().length } });
  }

  /**
   * IMPLEMENTS HookDispatchTarget::dispatchHook — invoked by the named-action
   * wrapper registered in `des-hook-adapter`. Maps the short suffix back to the
   * `def.des` hook and calls it with the resolved MU/port/data.
   */
  dispatchHook(suffix: string, mu: MU | null, port: Port | undefined, data: unknown): void {
    const des = this.def.des;
    if (!des || this.self.disabled) return; // a disabled component takes no part in the run
    this.beforeHookDispatch?.();

    if (suffix === 'AttachmentComplete' && isAttachmentProcessingPayload(data)) {
      this.completeAttachedProcessing(mu as DESMU | null, data);
      return;
    }

    // DEV-only (plan-262 Phase 2): sampled stale-geometry warning — dead code
    // in production (import.meta.env.DEV is a compile-time constant).
    if (import.meta.env.DEV && this.devSettleGuard) this.devSettleGuard(suffix, mu);

    // Snapshot the FSM state before the hook so we can detect a transition into
    // an acceptable (idle, free-capacity) state — see the re-notify guard below.
    const stateBefore = (this.self as { state?: string }).state;

    // Every hook's return value is captured: DES hooks are synchronous by
    // contract, and a thenable (an `async` hook) would otherwise be dropped
    // silently — its body would run detached from the event clock (plan-2058 F15).
    let result: unknown;
    switch (suffix) {
      case 'Arrival':
        result = des.onArrival?.(this.self, mu as MU);
        break;
      case 'ServiceEnd': // plan-921 — Agv task service time at the destination
        result = (des as { onServiceEnd?: (self: unknown) => unknown }).onServiceEnd?.(this.self);
        break;
      case 'Replan': // plan-558 — Agv movement-authority events (kind in data)
        result = (des as { onReplan?: (self: unknown, data: unknown) => unknown }).onReplan?.(this.self, data);
        break;
      case 'ProcessComplete':
        result = des.onProcessComplete?.(this.self, mu as MU, data);
        break;
      case 'RotateComplete':
        result = des.onRotateComplete?.(this.self, mu as MU);
        break;
      case 'Generate':
        result = des.onGenerate?.(this.self);
        break;
      case 'AutoRelease':
        result = des.onAutoRelease?.(this.self, mu as MU);
        break;
      case 'Accept':
        result = des.onAccept?.(this.self, mu as MU, port);
        break;
      case 'DownstreamReady':
        result = des.onDownstreamReady?.(this.self, mu as unknown);
        break;
      case 'Freeze':
        result = des.onFreeze?.(this.self, this.frozen);
        break;
      case 'Resume':
        result = des.onResume?.(this.self, this.frozen);
        break;
      default:
        // CanAccept / SignalChanged are not scheduled as standalone events here.
        break;
    }
    if (result != null && typeof (result as { then?: unknown }).then === 'function') {
      // Swallow a later rejection of the thenable itself — the contract
      // violation is reported synchronously below; this only prevents a
      // SECOND, unrelated "unhandled rejection" for the same root cause.
      // `Promise.resolve` adopts any thenable (not only a native Promise with
      // `.catch`) and never throws synchronously, even if its `then` does.
      void Promise.resolve(result).catch(() => {});
      throw new Error(`DES: hook '${suffix}' on '${this.path}' returned a thenable — `
        + 'DES hooks must be synchronous (no async functions or Promises).');
    }

    // Component hooks may report Empty immediately after requesting a deferred
    // transfer (the public Conveyor does this). The central attachment owns the
    // interval until its timer completes, so keep both its FSM label and the
    // canonical Working KPI active after the wrapped hook returns.
    if (this.activeProcessing().length > 0) {
      this.self.setState('Processing');
      this.self.statState('Working');
    }

    // Re-notify upstream when this hook transitioned the component to an
    // acceptable state (e.g. a router finishing its return rotation: state
    // 'discharging'/'returning_in' → 'idle'). The native `releaseMU` upstream
    // wake fires WHEN the slot is freed — but a multi-phase router frees its slot
    // (the discharge transfer) one or more events BEFORE it can actually accept
    // again, so that wake hits a blocked upstream whose retry fails canAccept (the
    // router is not yet 'idle'). Without this, the blocked conveyor is never poked
    // again and the line deadlocks. Guard on a real state CHANGE into acceptability
    // so it is a no-op for the common single-phase components.
    const stateAfter = (this.self as { state?: string }).state;
    if (
      stateAfter !== stateBefore &&
      !this.isFailure &&
      this.currentLoad < this.MaxCapacity
    ) {
      for (const prev of this.previousComponents) prev.onDownstreamReady(this);
    }
    if (this._progressKind === PROGRESS_SOURCE) this._progressCheck();
  }

  override setFailure(failure: boolean): void {
    const entering = failure && !this.isFailure;
    if (failure !== this.isFailure) this.synchronizeScheduledClock?.();
    super.setFailure(failure);
    if (!entering) return;
    const rolledBack = this.manager?.rollbackReservationsForTarget(this.path) ?? [];
    for (const record of rolledBack) {
      const holder = this.manager?.getComponentByPath(record.holderId);
      if (holder instanceof MaterialFlowAdapter) holder.onDownstreamReady(this);
    }
  }

  protected override onFreeze(): void {
    this.frozen = this.freezeScheduledWork?.() ?? [];
    this.def.des?.onFreeze?.(this.self, this.frozen);
  }

  protected override onResume(): void {
    const frozen = this.frozen;
    this.resumeScheduledWork?.(frozen);
    this.def.des?.onResume?.(this.self, frozen);
    if (this.activeProcessing().length > 0) {
      this.self.setState('Processing');
      this.self.statState('Working');
    }
    this.frozen = [];
  }

  private snapshotState: unknown;
  /** Source only: the held-back MU ref of a restore, resolved in onRestored (plan-2059). */
  private restoredSourcePending: { id: number; gen: number } | null = null;

  override toSnapshot(): DESComponentSnapshot {
    const snapshot = super.toSnapshot() as DESComponentSnapshot & { frozen?: FrozenDescriptor[]; sourceGenerated?: number; behaviourState?: unknown };
    if (this.def.des?.onSnapshot) {
      const state = this.def.des.onSnapshot(this.self);
      if (state !== undefined) snapshot.behaviourState = state;
    }
    snapshot.prop = this.prop;
    if (this.def.type === 'Source') {
      snapshot.sourceGenerated = (this.self.local as { generated?: number }).generated ?? 0;
      // plan-2059 review: the MU a Source holds back under ZPA back-pressure is run
      // state; stored as a generation-safe ref (validated in prepare via `muRef`).
      const pending = (this.self.local as { pending?: DESMU | null }).pending ?? null;
      (snapshot as { sourcePending?: { muRef: { id: number; gen: number } } | null }).sourcePending =
        pending ? { muRef: { id: pending.id, gen: pending.generation } } : null;
    }
    if (this.frozen.length > 0) snapshot.frozen = this.frozen;
    const run = selfRunStateOf(this.self);
    if (run) (snapshot as { selfRunState?: SelfRunState }).selfRunState = run.capture();
    return snapshot;
  }

  override fromSnapshot(snapshot: DESComponentSnapshot, simTime?: number): void {
    const canonicalProp = this.prop;
    super.fromSnapshot(snapshot, simTime);
    for (const key of Object.keys(canonicalProp)) delete canonicalProp[key];
    Object.assign(canonicalProp, snapshot.prop);
    this.prop = canonicalProp;
    const extended = snapshot as DESComponentSnapshot & { frozen?: FrozenDescriptor[]; sourceGenerated?: number; behaviourState?: unknown };
    this.snapshotState = extended.behaviourState;
    this.frozen = extended.frozen ?? [];
    const savedRun = (snapshot as { selfRunState?: SelfRunState }).selfRunState;
    if (savedRun) selfRunStateOf(this.self)?.restore(savedRun);
    if (this.def.type === 'Source') {
      (this.self.local as { generated?: number }).generated = extended.sourceGenerated ?? this.totalProcessed + this.currentLoad;
      // Resolved in onRestored, once the restored MU slots are installed.
      this.restoredSourcePending = (snapshot as { sourcePending?: { muRef: { id: number; gen: number } } | null })
        .sourcePending?.muRef ?? null;
    }
  }
}
