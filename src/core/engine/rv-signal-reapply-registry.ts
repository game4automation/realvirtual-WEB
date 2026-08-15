// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-signal-reapply-registry.ts — Re-apply the CURRENT signal level onto every
 * wired component input (plan-427).
 *
 * WHY
 * ───
 * A PLC works level-based (IEC 61131 scan cycle); the viewer's SignalStore is
 * edge-driven (`subscribeByPath` fires only on CHANGE). `resetSimulation()`
 * deliberately leaves signals untouched, so a level that was already `true`
 * before the reset never fires again — the conveyor stays off, the source stops
 * spawning. The same gap opens after a reconnect.
 *
 * This registry closes it: every wiring helper registers a slot
 * (address + "read the store and call the setter"); `reapplyAll()` invokes each
 * slot ONCE with the value currently in the store. It is the browser equivalent
 * of OPC UA `ResendData()` / MQTT Sparkplug NBIRTH — a resync over the normal
 * notification path, not a synthetic value change.
 *
 * Deliberately NOT a store-wide broadcast: only registered COMPONENT inputs are
 * re-applied. Historian, charts, statistics and LogicStep edge detectors never
 * see a phantom event.
 *
 * Lifecycle (mirrors `RVCollisionManager`): the viewer owns one instance,
 * `WireResult.unsubscribe` drops a single slot, `clear()` runs from
 * `clearModel()` before the geometry teardown.
 */

import { debug } from './rv-debug';

/**
 * Context passed to a signal setter.
 *
 * `replay: true` marks a re-apply of the CURRENT value (reset / reconnect), not
 * a genuine change — analogous to OPC UA ResendData vs. DataChangeNotification.
 * Consumers that detect edges themselves (IKPath's `SignalStart`) use it to
 * sync their baseline instead of firing. Absent (`undefined`) on the initial
 * wire-time read and on every real change event.
 */
export interface SignalApplyContext {
  replay: boolean;
}

/** A component input setter as the wiring helpers see it. */
export type SignalSetter = (value: boolean | number, ctx?: SignalApplyContext) => void;

/** One registered input slot. */
interface ReapplySlot {
  /** Signal address — diagnostics only; the closure already captured it. */
  readonly addr: string;
  /** Reads the CURRENT store value and invokes the component setter. */
  readonly apply: (ctx: SignalApplyContext) => void;
}

/** The single context object handed to every slot — no per-call allocation. */
const REPLAY_CONTEXT: SignalApplyContext = { replay: true };

/**
 * Registry of component input slots that can be re-applied on demand.
 *
 * Insertion-ordered `Set`; the returned unregister closure is the only key, so
 * no node/address bookkeeping is needed and a double registration of the same
 * address is legal (two components may read the same signal).
 */
export class SignalReapplyRegistry {
  private readonly slots = new Set<ReapplySlot>();

  /**
   * Register a slot. Returns an unregister function — the wiring helpers bundle
   * it into `WireResult.unsubscribe`, so a component's `dispose()` drops the
   * store subscription and the registry slot together.
   */
  register(addr: string, apply: (ctx: SignalApplyContext) => void): () => void {
    const slot: ReapplySlot = { addr, apply };
    this.slots.add(slot);
    return () => { this.slots.delete(slot); };
  }

  /**
   * Invoke every registered slot once with the value currently in the store.
   *
   * Iterates a SNAPSHOT so a setter may register or unregister slots while the
   * pass runs, and isolates each slot in `try/catch` so one throwing component
   * cannot rob the later ones of their level (same per-instance isolation the
   * component init pass uses).
   */
  reapplyAll(): void {
    if (this.slots.size === 0) return;
    const snapshot = [...this.slots];
    for (let i = 0; i < snapshot.length; i++) {
      const slot = snapshot[i];
      try {
        slot.apply(REPLAY_CONTEXT);
      } catch (e) {
        debug('signal', `reapply failed for "${slot.addr}": ${String(e)}`);
      }
    }
  }

  /** Drop all slots (model unload). */
  clear(): void {
    this.slots.clear();
  }

  /** Number of registered slots — diagnostics and leak tests. */
  get size(): number {
    return this.slots.size;
  }
}

// ─── Module slot (same rationale as `getKinematicManager()`) ────────────────
//
// `ComponentContext.reapply` is threaded from every producer that HAS a source
// to thread (loadGLB options, RuntimeNodeDeps, the explicit signal-construction
// path). `processExtras()` — the Layout-Planner / asset-editor placement path —
// is called from outside the viewer package with a positional argument list, so
// there is no option bag of the viewer's to extend without touching every call
// site. Reading this slot at each `ComponentContext` construction site makes it
// structurally impossible to miss a path (plan-427 F12), exactly as
// `rv-kinematic-registry.ts` argues for the mechanism manager.
//
// One viewer per page is assumed (as there): the last constructed viewer owns
// the slot, and `dispose()` clears it.

let _activeRegistry: SignalReapplyRegistry | null = null;

/** Install the viewer-owned registry. Pass `null` on viewer dispose. */
export function setActiveSignalReapplyRegistry(registry: SignalReapplyRegistry | null): void {
  _activeRegistry = registry;
}

/** The installed registry, or null when no viewer is alive (pure unit tests). */
export function getActiveSignalReapplyRegistry(): SignalReapplyRegistry | null {
  return _activeRegistry;
}
