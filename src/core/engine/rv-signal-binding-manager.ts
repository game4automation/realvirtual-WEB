// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * SignalBindingManager — Planner Signal Linking engine.
 *
 * Couples a placed Planner element's standard-signal SLOTS to live realvirtual
 * CONNECT signals. The relay copies the live value into the element's own
 * (instance-scoped) slot signal each tick (RVConnectSignal pattern). When an
 * element has ≥1 enabled binding whose CONNECT source is present, the element
 * goes `liveControlled` and its internal simulation logic stays silent on its
 * slots — the relay value wins (mirrors `drive.positionOverwrite` / `isOwner`).
 *
 * Mechanics (verbatim from plan-226 §2.5):
 *  - Evaluated in the SIM tick (`tick(dt)`), NOT in the WS handler. The viewer
 *    registers `tick` as a `SimLoopFacade.onTick(TickStage.PRE)` callback that
 *    runs AFTER the interface WS flush and BEFORE drive physics.
 *  - Live-gate trigger: ≥1 enabled binding with a PRESENT CONNECT source.
 *  - Reconnect hold: dt-accumulated `holdMs` timer (default 800 ms), NOT Date.now.
 *  - Unlinked slots of a live element → off / neutral (no hold of last value).
 *  - Relay writes are BATCHED and flushed via `signalStore.setMany(...)` per tick.
 *  - Re-bind guard: bind() unbinds the same (id, slot) first.
 *  - `liveControlled` lives on the component object (RVDriveSimple/Cylinder/Sensor)
 *    AND, for behaviors without an instance handle (Conveyor), in the global
 *    live-control gate keyed by the instance-scoped signal name.
 *
 * Entirely gated by the viewer's `plannerSignalLinking` flag — when off, no
 * manager is created, so none of this runs.
 */

import type { Object3D } from 'three';
import {
  createSignalWriter,
  type SignalStore,
  type SignalWriter,
} from './rv-signal-store';
import type { RVDrive } from './rv-drive';
import { NodeRegistry } from './rv-node-registry';
import { mappingSourceKind, type SignalMapping } from '../../plugins/layout-planner/rv-layout-store';
import {
  resolveBindableSlots,
  type ActiveBindableSlot,
  type BindableSlot,
  type MappedSignalSlot,
  type SlotScope,
} from './rv-binding-slot-resolver';
import { findRepairCandidate, type RepairRejectReason } from './rv-binding-repair';
import {
  claimBound,
  claimForced,
  clearSlotWriteRole,
  makeSignalChannelId,
  makeSlotId,
  registerSlotChannel,
  registerSlotWriteRole,
  releaseBound,
  releaseForced,
  setInstanceLiveControlled,
  setSignalLiveControlled,
  unregisterSlotChannel,
  SIGNAL_BINDING_RELAY_WRITER_ID,
  type SlotId,
} from './rv-slot-authority';
import { signalSourceKey } from './rv-signal-provider';

/** Default reconnect-hold window in milliseconds. */
export const DEFAULT_HOLD_MS = 800;

/**
 * Max relay-drain cycles per {@link SignalBindingManager._flushWrites} call —
 * cycle guard for relay chains (plan-325 S2). A chain slot←internal←extern
 * settles in 2 cycles; a pathological cycle (A→B→A with non-idempotent values)
 * stops at the cap with a dev warning and defers the residual to the next tick.
 */
export const MAX_FLUSH_DRAIN_CYCLES = 8;

export type ElementBindingState = 'unbound' | 'live' | 'pending' | 'disconnected' | 'conflict';
export type SlotLiveness = 'pending' | 'live' | 'hold' | 'disconnected' | 'conflict';
type SlotRole = 'control' | 'feedback' | 'unknown';

/**
 * One model slot a CONNECT source signal drives — the row shape of
 * {@link SignalBindingManager.getLinksForSource}.
 *
 * `slot` is the IDENTITY (raw slot key); `componentType` + `label` are the
 * display pair added by plan-353 F2 and may be absent (slot fixtures without a
 * resolvable registry instance). A renderer therefore falls back
 * `label ?? slot`, and omits the type prefix entirely when `componentType` is
 * missing — never a placeholder like "Component".
 */
export interface SourceLink {
  path: string;
  slot: string;
  placedId: string;
  /** rv_extras component key of the owning instance (e.g. `Drive_Simple`). */
  componentType?: string;
  /** Human-readable slot name (label SSOT); falls back to `slot` when absent. */
  label?: string;
}

/** One active relay for a single (placedId, slot). */
interface SlotBinding {
  mapping: SignalMapping;
  /** Resolved CONNECT source signal name (no `__iface__/` prefix). */
  sourceName: string;
  /** Resolved instance-scoped target slot signal name in the SignalStore. */
  targetName?: string;
  /** Slot value type, for type-mismatch detection. */
  type: 'bool' | 'float' | 'int';
  /** Component instance that carries a `liveControlled` flag (or null). */
  instance: { liveControlled?: boolean } | null;
  /** Underlying drive stopped during an atomic live handover. */
  drive: RVDrive | null;
  /** Rising-edge slots never receive a synthetic seed/redispatch event. */
  edgeTriggered: boolean;
  /** Unsubscribe from the source signal. */
  unsub: () => void;
  /** Provider-specific liveness, maintained per binding. */
  liveness: SlotLiveness;
  holdTimer: number;
  hasBeenLive: boolean;
  role: SlotRole;
  fanInConflict: boolean;
  resolved: ActiveBindableSlot;
  feedbackKey?: string;
  ownerKey: string;
  /**
   * Canonical slot identity (plan-320). Allocated ONCE in bind() (ownerKey
   * pattern) and reused for every claim/release — never rebuilt in tick().
   */
  slotId: SlotId;
  wasForced: boolean;
  hasFeedbackSample: boolean;
  lastFeedbackValue: boolean | number;
  sink:
    | { kind: 'store'; targetName: string }
    | { kind: 'command'; command: (value: boolean | number) => void; neutralize: () => void }
    | { kind: 'feedback' };
}

/**
 * A saved mapping the last apply could not bind (plan-425 F4).
 *
 * `candidateComponentPath` present = the case-B second pass found EXACTLY one
 * plausible new home and a human may confirm it. Absent = `reason` says why no
 * offer is being made. Never both: an offer and an excuse are different answers.
 */
export interface UnresolvedMapping {
  mapping: SignalMapping;
  /** The single slot a repair would move this mapping to, when there is one. */
  candidateComponentPath?: string;
  /** Why no repair is offered. Absent exactly when a candidate is present. */
  reason?: RepairRejectReason;
}

/** Shared empty result — `getUnresolvedMappings` is called per render. */
const EMPTY_UNRESOLVED: readonly UnresolvedMapping[] = Object.freeze([]);

interface ElementEntry {
  node: Object3D;
  /** slot → binding. */
  bindings: Map<string, SlotBinding>;
  /** All resolvable slots of this element (for "unbound → off" handling). */
  slots: BindableSlot[];
  gates: Map<string, boolean>;
  /** Current live-controlled state (after hold logic). */
  liveControlled: boolean;
}

function bindingKey(componentPath: string, slot: string): string {
  return `${componentPath}\u0000${slot}`;
}

export class SignalBindingManager {
  private readonly _store: SignalStore;
  private readonly _writer: SignalWriter;
  private readonly _registry: NodeRegistry;
  /** Reconnect-hold window in ms (dt-accumulated). */
  holdMs = DEFAULT_HOLD_MS;

  private readonly _elements = new Map<string, ElementEntry>();
  /** Per element: what the last applyMappings could NOT bind (plan-425 F4). */
  private readonly _unresolved = new Map<string, UnresolvedMapping[]>();
  /**
   * Resolution scope per element id, registered by whoever creates the bind
   * target (`findSignalBindTarget`): Planner placements aggregate their whole
   * subtree, free nodes own only their own slots. Every later call — badge
   * scan, row models, applyMappings — inherits it, so an element never resolves
   * with two different scopes. Default (unregistered) stays `'aggregate'`.
   */
  private readonly _scopes = new Map<string, SlotScope>();
  /** Batched relay writes collected during a tick, flushed via setMany.
   *  Re-assignable: `_flushWrites()` swaps it against a fresh object per drain
   *  cycle (plan-325 S2) so chain writes queued DURING a setMany notify are
   *  drained in the same tick. */
  private _pendingWrites: Record<string, boolean | number> = {};
  private readonly _feedbackWriters = new Map<string, string>();
  /** Instrumented counter: tick() performs no managed hot-path allocations. */
  readonly hotPathAllocationCount = 0;

  /** Optional listener fired whenever an element's binding state may have
   *  changed (used by the badge controller to refresh). */
  onStateChanged: ((placedId: string) => void) | null = null;

  constructor(store: SignalStore, registry: NodeRegistry) {
    this._store = store;
    this._writer = createSignalWriter(store, SIGNAL_BINDING_RELAY_WRITER_ID, 'component');
    this._registry = registry;
  }

  // ─── Element registration ────────────────────────────────────────────

  /** Registered resolution scope of an element (`'aggregate'` when unknown). */
  getElementScope(placedId: string): SlotScope {
    return this._scopes.get(placedId) ?? 'aggregate';
  }

  /**
   * Register the resolution scope of an element. Changing it invalidates the
   * cached slot set (the element then re-resolves on next access) — bindings
   * whose slot fell outside the new scope are dropped by `applyMappings`.
   */
  setElementScope(placedId: string, scope: SlotScope): void {
    if (this.getElementScope(placedId) === scope) return;
    this._scopes.set(placedId, scope);
    const entry = this._elements.get(placedId);
    if (entry) entry.slots = resolveBindableSlots(entry.node, this._store, this._registry, scope);
  }

  /** Ensure an element entry exists (resolving its slots once). */
  private _ensureElement(placedId: string, node: Object3D): ElementEntry {
    let entry = this._elements.get(placedId);
    if (!entry) {
      entry = {
        node,
        bindings: new Map(),
        slots: resolveBindableSlots(node, this._store, this._registry, this.getElementScope(placedId)),
        gates: new Map(),
        liveControlled: false,
      };
      for (const slot of entry.slots) {
        if (slot.kind !== 'unavailable') entry.gates.set(slot.componentPath, false);
      }
      this._elements.set(placedId, entry);
    }
    return entry;
  }

  /**
   * The bindable slots of a placed element (after instance resolution).
   * Passing `scope` registers it for this element (see {@link setElementScope});
   * omitting it uses the registered one.
   */
  getElementSlots(placedId: string, node?: Object3D, scope?: SlotScope): BindableSlot[] {
    if (scope) this.setElementScope(placedId, scope);
    if (this._elements.has(placedId)) return this._elements.get(placedId)!.slots;
    if (node) return resolveBindableSlots(node, this._store, this._registry, this.getElementScope(placedId));
    return [];
  }

  // ─── bind / unbind ───────────────────────────────────────────────────

  /**
   * Bind a single slot to a CONNECT source signal. Re-bind guard: an existing
   * binding for the same (id, slot) is unbound first → never double-subscribes.
   */
  bind(placedId: string, node: Object3D, mapping: SignalMapping): void {
    const entry = this._ensureElement(placedId, node);
    const requestedKind = mapping.kind ?? 'mapped-signal';
    let resolved = entry.slots.find(s =>
      s.kind === requestedKind
      && s.slot === mapping.slot
      && (mapping.componentPath === undefined || s.componentPath === mapping.componentPath));
    if (!resolved && mapping.kind === undefined && mapping.componentPath === undefined) {
      resolved = entry.slots.find(s => s.kind === 'mapped-signal' && s.slot === mapping.slot);
    }
    if (!resolved || resolved.kind === 'unavailable') return;
    mapping.kind = resolved.kind;
    mapping.componentPath = resolved.componentPath;
    const key = bindingKey(resolved.componentPath, resolved.slot);
    this.unbind(placedId, mapping.slot, resolved.componentPath);

    // Canonical SlotId (plan-320 Phase 1): legacy mappings without kind /
    // componentPath were normalised onto `resolved` above, so old and new
    // persistence formats dock onto the SAME id. componentType comes from the
    // active registry instance via the resolver (plan-317 §2.4: one active
    // instance per node); '' is the defined non-throwing fallback for slot
    // fixtures without a resolvable type. Allocated once here, cached below.
    const slotId = makeSlotId(
      placedId,
      resolved.componentPath,
      resolved.componentType ?? '',
      resolved.slot,
    );

    const sourceName = mapping.signal;
    const role = this._deriveSlotRole(resolved);
    // Mirror the role out to the authority service (plan-353 F6) so the write
    // gate can tell a COMMAND slot from a FEEDBACK slot. The derivation itself
    // stays here — this is a publication, not a second source of truth.
    registerSlotWriteRole(slotId, role);

    let initialLiveness: SlotLiveness = 'pending';
    // Provider auto-resolution applies ONLY to CONNECT sources — an internal
    // model signal (plan-325) must never adopt a same-named CONNECT provider.
    if (resolved.kind !== 'direct-property' && !mapping.interfaceId
      && mappingSourceKind(mapping) === 'connect') {
      const providers = this._store.getSignalProviders(sourceName);
      if (providers.length === 1) {
        mapping.interfaceId = providers[0].interfaceId;
        mapping.topic = providers[0].topic;
      } else if (providers.length > 1) {
        initialLiveness = 'conflict';
      }
    }

    // Relay: when the live CONNECT source changes, queue a write to the element's
    // own slot (batched, flushed at tick end). This is the live override and runs
    // regardless of slot direction — direction only governs viewer→PLC writebacks
    // (see writeToSource). `enabled` is read live so an in-place toggle is honoured.
    let binding!: SlotBinding;
    const unsubSource = this._store.subscribe(sourceName, (value) => {
      if (binding.role !== 'control' || !mapping.enabled || binding.liveness !== 'live') return;
      this._dispatchToSink(binding, value);
    });
    const unsubTarget = resolved.kind === 'mapped-signal'
      ? this._store.subscribe(resolved.targetName, (value) => {
        if (binding.role !== 'feedback' || !mapping.enabled || binding.liveness !== 'live') return;
        this.writeToSource(placedId, mapping.slot, value, resolved.componentPath);
      })
      : () => {};
    const feedbackSource = resolved.kind === 'direct-feedback' ? resolved.source : null;
    const feedbackCb = feedbackSource
      ? (): void => this._sampleFeedback(binding)
      : null;
    if (feedbackCb && feedbackSource) feedbackSource.addFeedbackListener(feedbackCb);
    const unsub = (): void => {
      unsubSource();
      unsubTarget();
      if (feedbackCb) feedbackSource?.removeFeedbackListener(feedbackCb);
    };
    const sink = resolved.kind === 'mapped-signal'
      ? { kind: 'store' as const, targetName: resolved.targetName }
      : resolved.kind === 'direct-property'
        ? { kind: 'command' as const, command: resolved.command, neutralize: resolved.neutralize }
        : { kind: 'feedback' as const };

    binding = {
      mapping,
      sourceName,
      targetName: resolved.kind === 'mapped-signal' ? resolved.targetName : undefined,
      type: resolved.type,
      instance: resolved.instance,
      drive: resolved.drive ?? null,
      edgeTriggered: resolved.edgeTriggered ?? false,
      unsub,
      liveness: initialLiveness,
      holdTimer: 0,
      hasBeenLive: false,
      role,
      fanInConflict: false,
      resolved,
      feedbackKey: resolved.kind !== 'direct-property' ? signalSourceKey({
          interfaceId: mapping.interfaceId ?? '',
          ...(mapping.topic !== undefined ? { topic: mapping.topic } : {}),
          signal: sourceName,
        }) : undefined,
      ownerKey: `${placedId}\u0000${key}`,
      slotId,
      wasForced: resolved.kind === 'mapped-signal' && this._store.isForced(resolved.targetName),
      hasFeedbackSample: false,
      lastFeedbackValue: false,
      sink,
    };
    entry.bindings.set(key, binding);
    // Slot ↔ channel index (plan-320): the channel is the SignalStore name this
    // binding WRITES — the element-side slot signal for mapped slots, the
    // CONNECT source for direct feedback. Direct-property slots write a command
    // (no store channel). Fan-out of two slots onto one channel yields two
    // authority entries with the same channel (test 9.2).
    if (binding.targetName) {
      registerSlotChannel(slotId, makeSignalChannelId(binding.targetName));
    } else if (resolved.kind === 'direct-feedback') {
      registerSlotChannel(slotId, makeSignalChannelId(sourceName));
    }
    this._claimFeedbackWriter(binding);
    this._updateBindingLiveness(binding, 0);
    // Authority claims (plan-320 Phase 2): a binding that is already live at
    // bind time claims 'bound' immediately; an active operator force on the
    // target overlays it as a LATENT 'forced' claim (stack — not displacing).
    if (binding.liveness === 'live' || binding.liveness === 'hold') claimBound(binding.slotId);
    if (binding.wasForced) claimForced(binding.slotId);
    if (binding.liveness === 'live') this._sampleFeedback(binding, true);

    // Seed the relay with the current source value (RVConnectSignal pattern), so
    // a binding to an already-stable source applies on the next tick rather than
    // waiting for the source to change.
    this.onStateChanged?.(placedId);
  }

  /** Unbind a single slot. Disposes its relay subscription. */
  unbind(placedId: string, slot: string, componentPath?: string): void {
    const entry = this._elements.get(placedId);
    if (!entry) return;
    const key = componentPath !== undefined
      ? bindingKey(componentPath, slot)
      : [...entry.bindings].find(([, candidate]) => candidate.mapping.slot === slot)?.[0];
    const binding = key ? entry.bindings.get(key) : undefined;
    if (!binding || !entry) return;
    binding.unsub();
    this._releaseFeedbackWriter(binding);
    // Authority (plan-320): unbinding releases BOTH claims — without a binding
    // there is no wasForced tracker left to maintain a latent forced claim.
    // The store-level force itself (channel) is untouched.
    releaseForced(binding.slotId);
    releaseBound(binding.slotId);
    // The role is binding state too (plan-353 F6): without the binding there is
    // nothing to keep it in step, and a stale `feedback` would keep granting a
    // write right to a slot nobody drives any more.
    clearSlotWriteRole(binding.slotId);
    unregisterSlotChannel(binding.slotId);
    entry.bindings.delete(key!);
    if (binding.sink.kind === 'command') binding.sink.neutralize();
    // Drop any not-yet-flushed relay write queued for this target (e.g. the
    // bind-time seed) so an unbind never lands a stale value on the next tick.
    if (binding.targetName) delete this._pendingWrites[binding.targetName];
    // Drop any live-control state for this slot immediately.
    if (binding.targetName) setSignalLiveControlled(binding.targetName, false);
    let componentLive = false;
    for (const candidate of entry.bindings.values()) {
      if (candidate.resolved.componentPath === binding.resolved.componentPath
        && candidate.role === 'control'
        && (candidate.liveness === 'live' || candidate.liveness === 'hold')) {
        componentLive = true;
        break;
      }
    }
    entry.gates.set(binding.resolved.componentPath, componentLive);
    for (const slotEntry of entry.slots) {
      if (slotEntry.kind === 'unavailable') continue;
      if (slotEntry.componentPath !== binding.resolved.componentPath) continue;
      if (slotEntry.kind === 'mapped-signal') {
        setSignalLiveControlled(slotEntry.targetName, componentLive);
      }
      setInstanceLiveControlled(slotEntry.instance, componentLive);
      setInstanceLiveControlled(slotEntry.drive, componentLive);
    }
    entry.liveControlled = false;
    for (const live of entry.gates.values()) entry.liveControlled ||= live;
    this.onStateChanged?.(placedId);
  }

  /** Unbind every slot of an element and forget it (relays + state). */
  unbindAll(placedId: string): void {
    const entry = this._elements.get(placedId);
    if (!entry) return;
    for (const binding of [...entry.bindings.values()]) {
      this.unbind(placedId, binding.mapping.slot, binding.resolved.componentPath);
    }
    // Clear any residual live-control flags on its instances/slots.
    for (const s of entry.slots) {
      if (s.kind === 'unavailable') continue;
      if (s.kind === 'mapped-signal') setSignalLiveControlled(s.targetName, false);
      setInstanceLiveControlled(s.instance, false);
      setInstanceLiveControlled(s.drive, false);
    }
    this._elements.delete(placedId);
    // The finding belongs to the element, not to the session: an element that is
    // gone has no broken links to report. applyMappings re-populates it straight
    // after its own unbindAll, so this does not erase a fresh diagnosis.
    this._unresolved.delete(placedId);
    this.onStateChanged?.(placedId);
  }

  /**
   * Apply a whole list of mappings for an element (used on load / picker save).
   *
   * Mappings that do not resolve are still dropped — that part is unavoidable,
   * a binding to a slot that is not there cannot be honoured. What changed with
   * plan-425 F4 is that they are no longer dropped in SILENCE: each one is
   * recorded, with a second-pass look for where the slot went, and the result is
   * readable via {@link getUnresolvedMappings}. The old `.filter()` swallowed
   * whole broken restores without a word, and the user's report — "my links are
   * gone" — had nothing on the screen to corroborate it.
   */
  applyMappings(placedId: string, node: Object3D, mappings: readonly SignalMapping[]): SignalMapping[] {
    this.unbindAll(placedId);
    const entry = this._ensureElement(placedId, node);
    const applied: SignalMapping[] = [];
    const unresolved: UnresolvedMapping[] = [];
    for (const mapping of mappings) {
      const requestedKind = mapping.kind ?? 'mapped-signal';
      const resolves = entry.slots.some((slot) =>
        slot.kind !== 'unavailable'
        && slot.kind === requestedKind
        && slot.slot === mapping.slot
        && (mapping.componentPath === undefined || slot.componentPath === mapping.componentPath));
      if (resolves) {
        applied.push({ ...mapping });
        continue;
      }
      // Second pass (case B). It NEVER binds — `findRepairCandidate` returning a
      // path means "a human could confirm this", not "this is it". See
      // rv-binding-repair for why an apparently unique match is not proof.
      const lookup = findRepairCandidate(mapping, entry.slots.filter(
        (slot): slot is Exclude<BindableSlot, { kind: 'unavailable' }> =>
          slot.kind !== 'unavailable' && slot.kind === requestedKind));
      unresolved.push({
        mapping: { ...mapping },
        ...(lookup.found
          ? { candidateComponentPath: lookup.componentPath }
          : { reason: lookup.reason }),
      });
    }
    // Set unconditionally: an element that resolves cleanly must CLEAR a stale
    // finding from an earlier load, or a repaired binding keeps being reported.
    if (unresolved.length > 0) this._unresolved.set(placedId, unresolved);
    else this._unresolved.delete(placedId);
    for (const m of applied) this.bind(placedId, node, m);
    return applied;
  }

  /**
   * Mappings the last {@link applyMappings} for this element could not bind.
   *
   * Empty is the normal answer. A non-empty one is the raw material for the
   * orphan notice and the bindings overview — including, where the second pass
   * found exactly one, the slot a repair would move the mapping to.
   */
  getUnresolvedMappings(placedId: string): readonly UnresolvedMapping[] {
    return this._unresolved.get(placedId) ?? EMPTY_UNRESOLVED;
  }

  /** Every element with unbindable mappings, for whole-scene reporting. */
  getAllUnresolvedMappings(): ReadonlyMap<string, readonly UnresolvedMapping[]> {
    return this._unresolved;
  }

  // ─── tick ────────────────────────────────────────────────────────────

  /**
   * Per-tick resolve. Runs in TickStage.PRE (after WS flush, before drive
   * physics). Determines live-control per element with a dt-accumulated hold
   * timer, applies the gate, drives unlinked slots to off, then flushes the
   * batched relay writes via `setMany`.
   */
  tick(dt: number): void {
    const dtMs = dt * 1000;

    for (const [placedId, entry] of this._elements) {
      // Source present = ≥1 enabled binding whose CONNECT source exists in the
      // store with a compatible type (mismatch → not a valid live source).
      // `hasEnabledBinding` is folded into the same pass (an early break implies
      // it is already true) — no per-tick `[...values()]` spread allocation.
      const wasLive = entry.liveControlled;
      let stateChanged = false;
      let anyLive = false;
      for (const b of entry.bindings.values()) {
        const previous = b.liveness;
        this._updateBindingLiveness(b, dtMs);
        stateChanged ||= previous !== b.liveness;
        // Authority claims (plan-320): claim/release ONLY on liveness edges —
        // the cached SlotId is reused, no string building in the 60Hz tick.
        // 'hold' keeps the bound claim (the live-control gate stays on).
        const wasBound = previous === 'live' || previous === 'hold';
        const nowBound = b.liveness === 'live' || b.liveness === 'hold';
        if (nowBound !== wasBound) {
          if (nowBound) claimBound(b.slotId);
          else releaseBound(b.slotId);
        }
        if (b.role === 'control' && (b.liveness === 'live' || b.liveness === 'hold')) anyLive = true;

        if (b.role === 'control' && b.liveness === 'live' && previous !== 'live'
          && (entry.gates.get(b.resolved.componentPath) ?? false) && !b.edgeTriggered) {
          const current = this._store.get(b.sourceName);
          if (current !== undefined) this._dispatchToSink(b, current);
        }

        if (b.role === 'feedback' && b.liveness === 'live' && previous !== 'live') {
          this._sampleFeedback(b, true);
        }

        if (b.sink.kind === 'store') {
          const forced = this._store.isForced(b.sink.targetName);
          if (b.role === 'control' && b.liveness === 'live' && b.wasForced && !forced && !b.edgeTriggered) {
            const current = this._store.get(b.sourceName);
            if (current !== undefined) this._dispatchToSink(b, current);
          }
          // Authority (plan-320): the force overlays as a LATENT claim on the
          // wasForced edge — releasing it restores 'bound' (claim stack); the
          // value redispatch is the dispatch above, unchanged.
          if (forced !== b.wasForced) {
            if (forced) claimForced(b.slotId);
            else releaseForced(b.slotId);
          }
          b.wasForced = forced;
        }

        if (b.role === 'control' && b.liveness === 'disconnected'
          && previous !== 'disconnected' && b.hasBeenLive) {
          this._neutralizeSink(b);
        }
      }

      entry.liveControlled = anyLive;
      this._refreshComponentGates(entry, wasLive);
      if (anyLive) {
        // Reconnect hold only while there IS still an enabled binding whose source
        // was lost — a fully-unbound element drops to self-sim immediately.
        entry.liveControlled = true;
      } else {
        entry.liveControlled = false;
      }

      // Apply the gate to every slot of the element.
      for (const slot of entry.slots) {
        if (slot.kind === 'unavailable') continue;
        const control = this._deriveSlotRole(slot) === 'control';
        const componentOn = entry.gates.get(slot.componentPath) ?? false;
        if (slot.kind === 'mapped-signal') setSignalLiveControlled(slot.targetName, control && componentOn);
        setInstanceLiveControlled(slot.instance, componentOn);
        setInstanceLiveControlled(slot.drive, componentOn);
        // Unlinked slots of a LIVE element → off / neutral (no hold).
        if (componentOn && control && slot.kind === 'mapped-signal'
          && !entry.bindings.has(bindingKey(slot.componentPath, slot.slot))) {
          this._queueWrite(slot.targetName, slot.type === 'bool' ? false : 0);
        }
      }

      if (!wasLive && entry.liveControlled) {
        for (const slot of entry.slots) {
          if (slot.kind !== 'unavailable') slot.drive?.stop();
        }

        for (const binding of entry.bindings.values()) {
          if (binding.role !== 'control' || binding.liveness !== 'live' || binding.edgeTriggered) continue;
          const current = this._store.get(binding.sourceName);
          if (current !== undefined) this._dispatchToSink(binding, current);
        }
        this._flushWrites();

        for (const binding of entry.bindings.values()) {
          if (binding.role === 'control' && binding.liveness === 'live'
            && !binding.edgeTriggered && binding.sink.kind === 'store') {
            this._store.redispatch(binding.sink.targetName);
          }
        }
      }

      if (stateChanged || wasLive !== entry.liveControlled) this.onStateChanged?.(placedId);
    }

    this._flushWrites();
  }

  // ─── state query ─────────────────────────────────────────────────────

  /** Current binding state of an element (for the 3D badge). */
  getElementState(placedId: string): ElementBindingState {
    const entry = this._elements.get(placedId);
    if (!entry || entry.bindings.size === 0) return 'unbound';

    let live = false;
    let pending = false;
    for (const b of entry.bindings.values()) {
      if (b.liveness === 'conflict') return 'conflict';
      if (b.liveness === 'live' || b.liveness === 'hold') live = true;
      else if (b.liveness === 'pending') pending = true;
    }
    if (live) return 'live';
    if (pending) return 'pending';
    return 'disconnected';
  }

  /** Provider-specific state of one binding, exposed for status UI and tests. */
  getBindingLiveness(placedId: string, slot: string, componentPath?: string): SlotLiveness | undefined {
    const entry = this._elements.get(placedId);
    if (componentPath !== undefined) return entry?.bindings.get(bindingKey(componentPath, slot))?.liveness;
    for (const binding of entry?.bindings.values() ?? []) {
      if (binding.mapping.slot === slot) return binding.liveness;
    }
    return undefined;
  }

  /** True when the element is currently driven by live signals. */
  isLive(placedId: string): boolean {
    return this._elements.get(placedId)?.liveControlled ?? false;
  }

  /**
   * Canonical SlotId of an active binding (plan-320) — the cached id allocated
   * in bind(), exposed for authority queries and tests. Undefined when the
   * (element, slot) pair has no binding.
   */
  getSlotId(placedId: string, slot: string, componentPath?: string): SlotId | undefined {
    const entry = this._elements.get(placedId);
    if (componentPath !== undefined) return entry?.bindings.get(bindingKey(componentPath, slot))?.slotId;
    for (const binding of entry?.bindings.values() ?? []) {
      if (binding.mapping.slot === slot) return binding.slotId;
    }
    return undefined;
  }

  /**
   * All CONNECT source signal names currently linked (manual or auto-derived,
   * enabled bindings). Used by the interface signal list to flag linked signals.
   */
  getLinkedSourceNames(): Set<string> {
    const names = new Set<string>();
    for (const entry of this._elements.values()) {
      for (const b of entry.bindings.values()) {
        if (b.mapping.enabled) names.add(b.sourceName);
      }
    }
    return names;
  }

  /**
   * For each linked CONNECT source signal, the model element(s) it drives —
   * node path + slot + placedId. Lets the interface signal list show WHAT a
   * signal is linked to and navigate to it on click.
   *
   * `componentType` / `label` are the DISPLAY pair (plan-353 F2), taken from the
   * resolved slot that this binding already holds — no second lookup and no
   * second humanisation: `resolved.label` is the label SSOT
   * (`rv-binding-slot-resolver.ts`, plan-341 Phase 4) and `componentType` is the
   * technical rv_extras key, shown verbatim (`Drive_Simple`, not "Drive").
   * Both stay OPTIONAL — hand-built slot fixtures legitimately have neither, and
   * `slot` above remains the identity a consumer keys on.
   */
  getLinksForSource(): Map<string, SourceLink[]> {
    const map = new Map<string, SourceLink[]>();
    for (const [placedId, entry] of this._elements) {
      const path = NodeRegistry.computeNodePath(entry.node);
      for (const b of entry.bindings.values()) {
        if (!b.mapping.enabled) continue;
        const arr = map.get(b.sourceName) ?? [];
        const link: SourceLink = { path, slot: b.mapping.slot, placedId };
        if (b.resolved.componentType !== undefined) link.componentType = b.resolved.componentType;
        if (b.resolved.label !== undefined) link.label = b.resolved.label;
        arr.push(link);
        map.set(b.sourceName, arr);
      }
    }
    return map;
  }

  /**
   * The CONNECT source signal an internal store signal is relayed FROM, or
   * undefined. Display-path helper (plan-325 chain indicator): a slot assigned
   * to an internal signal shows that signal's own external CONNECT mapping
   * (`slot ← internal ← CONNECT`). Never called per tick.
   */
  getConnectSourceForTarget(targetName: string): string | undefined {
    for (const entry of this._elements.values()) {
      for (const b of entry.bindings.values()) {
        if (b.targetName === targetName
          && b.mapping.enabled
          && mappingSourceKind(b.mapping) === 'connect') {
          return b.sourceName;
        }
      }
    }
    return undefined;
  }

  /**
   * Write a value FROM the viewer back to a bound CONNECT source (viewer→PLC).
   * Honours the direction guard: only `plcInput` slots are writable; a write to
   * a `plcOutput` (read-only) slot is ignored. Returns true when the write was
   * applied.
   */
  writeToSource(
    placedId: string,
    slot: string,
    value: boolean | number,
    componentPath?: string,
  ): boolean {
    const entry = this._elements.get(placedId);
    const b = componentPath !== undefined
      ? entry?.bindings.get(bindingKey(componentPath, slot))
      : [...(entry?.bindings.values() ?? [])].find(candidate => candidate.mapping.slot === slot);
    if (!b || !b.mapping.enabled) return false;
    // Owner-only feedback (plan-320 Phase 3): a non-owner multiuser client
    // never publishes feedback back to the source.
    if (!this._isFeedbackOwner(b)) return false;
    const standaloneLegacyWrite = this._store.signalProviderCount === 0
      && b.mapping.direction === 'plcInput';
    // Internal source (plan-325): a writable (plcInput) internal binding
    // accepts viewer writes onto its internal source signal regardless of the
    // CONNECT provider situation — the source lives in the store itself.
    const internalWrite = mappingSourceKind(b.mapping) === 'internal'
      && b.mapping.direction === 'plcInput';
    if ((b.role !== 'feedback' && !standaloneLegacyWrite && !internalWrite) || b.fanInConflict) return false;
    this._writer.set(b.sourceName, value);
    return true;
  }

  /**
   * Owner check for feedback publication (plan-320 Phase 3): only the session
   * owner publishes feedback. Checked on BOTH the component instance AND the
   * drive — the MultiuserPlugin sets `isOwner = false` per instance when the
   * server takes authority; an instance without the flag counts as owner.
   */
  private _isFeedbackOwner(b: SlotBinding): boolean {
    if (b.drive && b.drive.isOwner === false) return false;
    const instance = b.instance as { isOwner?: boolean } | null;
    if (instance && instance.isOwner === false) return false;
    return true;
  }

  // ─── dispose ─────────────────────────────────────────────────────────

  dispose(): void {
    for (const [placedId] of [...this._elements]) this.unbindAll(placedId);
    this._elements.clear();
    this._scopes.clear();
    this._unresolved.clear();
    this._feedbackWriters.clear();
    for (const k in this._pendingWrites) delete this._pendingWrites[k];
  }

  // ─── internal ────────────────────────────────────────────────────────

  /** True when a binding's source type cannot drive the slot type. */
  private _slotConflict(b: SlotBinding): boolean {
    const t = this._store.getType(b.sourceName);
    if (!t) return false; // unknown source type → no conflict claim (suffix etc.)
    const lower = t.toLowerCase();
    const sourceIsBool = lower.includes('bool');
    const sourceIsFloat = lower.includes('float');
    if (b.type === 'bool' && !sourceIsBool) return true;
    if (b.type === 'float' && sourceIsBool) return true;
    if (b.type === 'int' && sourceIsFloat) return true;
    return false;
  }

  private _updateBindingLiveness(b: SlotBinding, dtMs: number): void {
    const nextRole = this._deriveSlotRole(b.resolved);
    if (nextRole !== b.role) {
      if (b.role === 'feedback') this._releaseFeedbackWriter(b);
      b.role = nextRole;
      // Keep the gate's mirror in step (plan-353 F6). The role really does
      // change at runtime — the derivation depends on the store type and the
      // provider count, both of which arrive after a gateway connect — so a
      // register-once-at-bind mirror would go stale on exactly the transition
      // that matters (unknown → feedback once the PLC type is known).
      registerSlotWriteRole(b.slotId, nextRole);
      b.fanInConflict = false;
      if (b.role === 'feedback') this._claimFeedbackWriter(b);
    } else if (b.role === 'feedback' && b.fanInConflict) {
      this._claimFeedbackWriter(b);
    }
    if (!b.mapping.enabled) {
      b.liveness = 'disconnected';
      b.holdTimer = 0;
      return;
    }

    this._resolveLateProvider(b);

    if (b.role === 'unknown' || b.fanInConflict || this._slotConflict(b)) {
      b.liveness = 'conflict';
      b.holdTimer = 0;
      return;
    }

    const internalSource = mappingSourceKind(b.mapping) === 'internal';

    if (!internalSource && this._store.getSignalProviderCount(b.sourceName) > 1) {
      b.liveness = 'conflict';
      b.holdTimer = 0;
      return;
    }

    if (b.drive && !b.drive.isOwner) {
      b.liveness = 'pending';
      b.holdTimer = 0;
      return;
    }

    let providerRegistered = false;
    let providerConnected = false;
    if (internalSource) {
      // Internal source (plan-325 S1): an internal model signal is its own
      // provider — its presence in the store makes the binding live even while
      // a CONNECT session has providers registered. BOTH flags are derived
      // from the same presence check (re-review R1: setting only
      // providerRegistered would strand the binding in 'disconnected' at the
      // providerConnected gate below).
      providerRegistered = this._store.get(b.sourceName) !== undefined;
      providerConnected = providerRegistered;
    } else if (b.resolved.kind === 'mapped-signal' && this._store.signalProviderCount === 0) {
      // Compatibility for standalone engine use without an interface layer.
      providerRegistered = this._store.get(b.sourceName) !== undefined;
      providerConnected = providerRegistered;
    } else if (b.mapping.interfaceId) {
      providerRegistered = this._store.hasSignalProviderByParts(
        b.mapping.interfaceId,
        b.mapping.topic,
        b.sourceName,
      );
      providerConnected = providerRegistered
        && this._store.isSignalProviderConnectedByParts(b.mapping.interfaceId, b.mapping.topic);
    }

    if (!providerRegistered) {
      // Hold grace period also covers the internal branch (plan-325 S1): a
      // vanished internal source signal (practically only model switch/reload)
      // gets the same reconnect hold as a CONNECT source — no status flicker.
      if ((internalSource || (b.resolved.kind === 'mapped-signal' && this._store.signalProviderCount === 0))
        && b.hasBeenLive && b.holdTimer > 0) {
        b.holdTimer = Math.max(0, b.holdTimer - dtMs);
        b.liveness = b.holdTimer > 0 ? 'hold' : 'disconnected';
        return;
      }
      b.liveness = 'pending';
      b.holdTimer = 0;
      return;
    }

    if (providerConnected) {
      b.liveness = 'live';
      b.holdTimer = this.holdMs;
      b.hasBeenLive = true;
      return;
    }

    if (b.hasBeenLive && b.holdTimer > 0) {
      b.holdTimer = Math.max(0, b.holdTimer - dtMs);
      b.liveness = b.holdTimer > 0 ? 'hold' : 'disconnected';
      return;
    }

    b.liveness = 'disconnected';
  }

  /**
   * Late provider resolution (plan-421 F2) — the fix for "the order must not
   * matter".
   *
   * `bind()` resolves a names-only CONNECT mapping (no `interfaceId`) against
   * the providers that happen to exist AT THAT MOMENT, exactly once. Load the
   * model before CONNECT is up and there are none, so the binding stays
   * `pending` forever — the reported "links are gone after reload". Running the
   * same resolution per tick makes model→connect and connect→model end in the
   * same state, with or without a persisted `interfaceId`.
   *
   * Hot path: a resolved binding costs one truthy check. An unresolved one adds
   * an allocation-free provider COUNT; the allocating identity lookup happens
   * ONCE, at the transition to exactly one provider. More than one provider is
   * left to the conflict branch below — never guess.
   *
   * ATOMIC (SOL-R1-3): the feedback claim is keyed by (interfaceId, topic,
   * signal), which the empty `interfaceId` is part of. The old claim is
   * therefore released BEFORE the identity moves and re-taken after — releasing
   * afterwards would look up a key that no longer exists and strand the writer
   * entry, so fan-in would misreport for the rest of the session.
   *
   * Purely IN-MEMORY: no persistence, no ops, no undo entries, no events
   * (plan-421 decision log; persist-back is the F4 follow-up). A reload simply
   * resolves again. Once resolved, the identity is STABLE: if that provider
   * disappears the binding drops out of `live` rather than silently adopting a
   * different provider of the same signal name (SOL-R2-4 — no guessing).
   */
  private _resolveLateProvider(b: SlotBinding): void {
    if (b.mapping.interfaceId) return;
    if (b.resolved.kind === 'direct-property') return;
    if (mappingSourceKind(b.mapping) !== 'connect') return;
    if (this._store.getSignalProviderCount(b.sourceName) !== 1) return;
    const providers = this._store.getSignalProviders(b.sourceName);
    const provider = providers.length === 1 ? providers[0] : undefined;
    // An empty interfaceId would stay falsy and re-enter this path every tick.
    if (!provider?.interfaceId) return;

    this._releaseFeedbackWriter(b);
    b.mapping.interfaceId = provider.interfaceId;
    b.mapping.topic = provider.topic;
    b.feedbackKey = signalSourceKey({
      interfaceId: provider.interfaceId,
      ...(provider.topic !== undefined ? { topic: provider.topic } : {}),
      signal: b.sourceName,
    });
    this._claimFeedbackWriter(b);
  }

  // Role derivation reads ONLY the SLOT side (targetName / descriptor) — an
  // internal source (plan-325) changes nothing here; verified, not modified.
  private _deriveSlotRole(slot: BindableSlot): SlotRole {
    if (slot.kind === 'direct-property') return 'control';
    if (slot.kind === 'direct-feedback') return 'feedback';
    if (slot.kind === 'unavailable') return 'unknown';
    // Preserve the pre-provider standalone engine contract used by legacy
    // embeds. Productive CONNECT routing always has provider registrations and
    // therefore follows the strict three-stage role derivation below.
    if (this._store.signalProviderCount === 0) return 'control';
    const registeredType = this._store.getType(slot.targetName)?.toLowerCase();
    if (registeredType?.includes('plcoutput')) return 'control';
    if (registeredType?.includes('plcinput')) return 'feedback';
    if (!registeredType && slot.descriptorRoleFallback) {
      return slot.direction === 'plcOutput' ? 'control' : 'feedback';
    }
    return 'unknown';
  }

  private _claimFeedbackWriter(b: SlotBinding): void {
    if (b.role !== 'feedback' || !b.feedbackKey) return;
    const existing = this._feedbackWriters.get(b.feedbackKey);
    b.fanInConflict = existing !== undefined && existing !== b.ownerKey;
    if (!b.fanInConflict) this._feedbackWriters.set(b.feedbackKey, b.ownerKey);
  }

  private _releaseFeedbackWriter(b: SlotBinding): void {
    if (b.role !== 'feedback' || !b.feedbackKey) return;
    if (this._feedbackWriters.get(b.feedbackKey) === b.ownerKey) {
      this._feedbackWriters.delete(b.feedbackKey);
    }
  }

  private _refreshComponentGates(entry: ElementEntry, wasElementLive: boolean): void {
    for (const [componentPath, previous] of entry.gates) {
      let current = false;
      for (const binding of entry.bindings.values()) {
        if (binding.resolved.componentPath === componentPath
          && binding.role === 'control'
          && (binding.liveness === 'live' || binding.liveness === 'hold')) {
          current = true;
          break;
        }
      }
      entry.gates.set(componentPath, current);
      if (!wasElementLive || previous || !current) continue;

      for (const slot of entry.slots) {
        if (slot.kind !== 'unavailable' && slot.componentPath === componentPath) slot.drive?.stop();
      }
      for (const binding of entry.bindings.values()) {
        if (binding.resolved.componentPath !== componentPath
          || binding.role !== 'control'
          || binding.liveness !== 'live'
          || binding.edgeTriggered) continue;
        const currentValue = this._store.get(binding.sourceName);
        if (currentValue !== undefined) this._dispatchToSink(binding, currentValue);
      }
      this._flushWrites();
      for (const binding of entry.bindings.values()) {
        if (binding.resolved.componentPath === componentPath
          && binding.role === 'control'
          && binding.liveness === 'live'
          && !binding.edgeTriggered
          && binding.sink.kind === 'store') {
          this._store.redispatch(binding.sink.targetName);
        }
      }
    }
  }


  private _queueWrite(name: string, value: boolean | number): void {
    this._pendingWrites[name] = value;
  }

  private _dispatchToSink(b: SlotBinding, value: boolean | number): void {
    if (b.sink.kind === 'store') this._queueWrite(b.sink.targetName, value);
    else if (b.sink.kind === 'command') b.sink.command(value);
  }

  private _neutralizeSink(b: SlotBinding): void {
    if (b.sink.kind === 'store') {
      this._queueWrite(b.sink.targetName, b.type === 'bool' ? false : 0);
    } else if (b.sink.kind === 'command') {
      b.sink.neutralize();
    }
  }

  private _sampleFeedback(b: SlotBinding, force = false): void {
    if (b.resolved.kind !== 'direct-feedback'
      || b.role !== 'feedback'
      || b.liveness !== 'live'
      || b.fanInConflict
      || !b.mapping.enabled
      // Owner-only feedback (plan-320 Phase 3): non-owner clients stay silent.
      || !this._isFeedbackOwner(b)) return;
    const value = b.resolved.source.readFeedbackSlot(b.resolved.slot);
    if (!force && b.hasFeedbackSample && value === b.lastFeedbackValue) return;
    b.lastFeedbackValue = value;
    b.hasFeedbackSample = true;
    this._writer.set(b.sourceName, value);
  }

  /**
   * Flush the batched relay writes — DRAIN LOOP (plan-325 S2, binding):
   * `setMany` notifies synchronously, and a chain binding (slot ← internal ←
   * extern) queues NEW writes during that notify. The pending object is
   * swapped against a fresh one BEFORE each setMany, and the loop repeats
   * until nothing is queued — so a chain settles IN THE SAME tick (test 9.11).
   * {@link MAX_FLUSH_DRAIN_CYCLES} caps pathological cycles (A→B→A); residual
   * writes stay queued for the next tick and a dev warning is emitted.
   */
  private _flushWrites(): void {
    for (let cycle = 0; cycle < MAX_FLUSH_DRAIN_CYCLES; cycle++) {
      let any = false;
      for (const _k in this._pendingWrites) { any = true; break; }
      if (!any) return;
      const batch = this._pendingWrites;
      this._pendingWrites = {};
      this._writer.setMany(batch);
    }
    if (import.meta.env.DEV) {
      let residual = false;
      for (const _k in this._pendingWrites) { residual = true; break; }
      if (residual) {
        console.warn('[rv] SignalBindingManager: relay drain cap reached — '
          + 'possible relay cycle (A→B→A); residual writes deferred to the next tick');
      }
    }
  }
}
