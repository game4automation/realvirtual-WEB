// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Fleet simulation clock backed by the DES queue. Closures retain the runner
 * callback path; persistable actions use Fleet.Action at the same priority.
 * Restoring fleet.clock preserves generation and queue handles. Legacy restores
 * without that participant retain the restart/replan fallback.
 */

import type { DesCallbackHandle, DesLifecycleEvent, DesLifecycleListener } from '../../../core/material-flow/simulation-kernel';
import type { ClockHandle, SimClock } from '../../../core/fleet/core/sim-clock';
import type { JsonValue } from '../../../core/material-flow/material-flow-self';
import { ACTION_INDEX, registerAction } from '../rv-des-named-actions';
import { PLANNING_PRIORITY } from '../rv-des-event';
import type { DESManager } from '../rv-des-manager';

/** Why a clock started a new generation on its own. */
/** `restore-replan`: a restore WITHOUT a fleet.clock snapshot part - the consumer must re-plan from scratch. */
export type ClockRestart = 'reset' | 'manager' | 'restore' | 'restore-replan';

/** What the DES clock needs of the runner (the `DESRunner` lifecycle service, plan-645 Phase 2). */
export interface DesClockRunner {
  getManager(): DESManager;
  scheduleCallback(t: number, fn: () => void, opts: { afterModelEvents?: boolean; origin: { owner: string; kind: 'ui' | 'replan' } }): DesCallbackHandle;
  cancelCallback(h: DesCallbackHandle | null | undefined): void;
  onLifecycle(fn: DesLifecycleListener, opts?: { replay?: boolean }): () => void;
}

interface ClockGlobals {
  __rvFleetDesClock?: unknown;
  __rvFleetDesClockGen?: number;
}
const globals = globalThis as unknown as ClockGlobals;

/** Next page-wide clock generation (monotone across module reloads). */
export function nextClockGeneration(): number {
  globals.__rvFleetDesClockGen = (globals.__rvFleetDesClockGen ?? 0) + 1;
  return globals.__rvFleetDesClockGen;
}

/** DES clock — see the module doc. */
export class DesSimClock implements SimClock {
  private _generation = nextClockGeneration();
  /** Pending callbacks of this generation: runner callback key → runner handle. */
  private readonly live = new Map<number, DesCallbackHandle>();
  private readonly offLifecycle: () => void;
  /** The runner's last lifecycle event was an end (`reset`): the next `bound` is a restart. */
  private ended = false;
  private restoredState = false;
  private readonly actions = new Map<string, (data: JsonValue | undefined) => void>();
  private disposed = false;

  /**
   * @param runner the DES runner whose callback scheduler and lifecycle the clock uses.
   * @param onRestart called once per restart the runner reported (reset / rebind →
   *   `'reset'`, snapshot restore → `'restore'`) — after the new generation was drawn.
   */
  constructor(
    private readonly runner: DesClockRunner,
    private readonly onRestart?: (why: ClockRestart) => void,
  ) {
    globals.__rvFleetDesClock = this;
    this.offLifecycle = runner.onLifecycle((e) => this.onLifecycle(e));
  }

  /** Current generation — every reset draws a new one (page-wide monotone). */
  get generation(): number { return this._generation; }

  now(): number { return this.runner.getManager()?.currentTime ?? 0; }

  schedule(atSimSec: number, fn: () => void, opts?: { afterModelEvents?: boolean }): ClockHandle {
    if (this.disposed) throw new Error('Fleet DES clock: disposed');
    const g = this._generation;
    const box = { key: -1 };
    const h = this.runner.scheduleCallback(atSimSec, () => {
      if (this.live.get(box.key) === h) this.live.delete(box.key);
      if (this.disposed || g !== this._generation || globals.__rvFleetDesClock !== this) return;
      fn();
    }, { ...opts, origin: { owner: 'fleet.clock', kind: 'replan' } });
    box.key = h.key;
    this.live.set(h.key, h);
    return { g, id: -h.key - 1 };
  }

  registerAction(kind: string, handler: (data: JsonValue | undefined) => void): () => void {
    if (!this.actions.has(kind)) this.actions.set(kind, handler);
    const registered = this.actions.get(kind);
    return () => { if (this.actions.get(kind) === registered) this.actions.delete(kind); };
  }

  scheduleAction(at: number, kind: string, data?: JsonValue, opts?: { afterModelEvents?: boolean }): ClockHandle {
    if (this.disposed) throw new Error('Fleet DES clock: disposed');
    const g = this.generation;
    // Same clamp as DESRunner.scheduleCallback: a time in the past (or not finite) fires at now.
    const manager = this.runner.getManager();
    const when = Number.isFinite(at) ? Math.max(at, manager.currentTime) : manager.currentTime;
    const id = manager.scheduleEvent(when, 'Fleet.Action', -1, -1,
      opts?.afterModelEvents ? PLANNING_PRIORITY : 0, { g, k: kind, ...(data === undefined ? {} : { d: data }) });
    return { g, id };
  }

  dispatchAction(g: number, kind: string, data?: JsonValue): void {
    if (this.disposed || g !== this.generation || globals.__rvFleetDesClock !== this) return;
    const handler = this.actions.get(kind);
    if (!handler) throw new Error(`Unknown clock action: ${kind}`);
    handler(data);
  }

  exportState(): { generation: number } {
    if (this.live.size) throw new Error(`fleet.clock: ${this.live.size} non-persistable closure events pending`);
    return { generation: this.generation };
  }

  restoreGeneration(generation: number): void {
    this._generation = generation;
    globals.__rvFleetDesClockGen = Math.max(globals.__rvFleetDesClockGen ?? 0, generation);
    this.live.clear();
    this.restoredState = true;
  }

  cancel(h: ClockHandle | null | undefined): void {
    if (!h || h.g !== this._generation) return;
    if (h.id >= 0) {
      const manager = this.runner.getManager();
      const data = manager.eventDataOf(h.id) as { g?: number } | undefined;
      // Rewind reuses ids. A stale handle can still hit a different Fleet.Action
      // with the same id and generation: handles carry no timeline identity.
      if (manager.actionNameOf(h.id) === 'Fleet.Action' && data?.g === this.generation)
        manager.cancelEvent(h.id);
      return;
    }
    const key = -h.id - 1;
    const rh = this.live.get(key);
    if (!rh) return;
    this.live.delete(key);
    this.runner.cancelCallback(rh);
  }

  /**
   * New generation: every pending callback is forgotten. Their queue events stay
   * and fire as no-ops — exactly the queue the pre-L3 clock produced, so the fixed
   * M3 / soak references (plan-645 S10) hold.
   */
  reset(): void {
    this._generation = nextClockGeneration();
    this.restoredState = false;
    this.live.clear();
  }

  private onLifecycle(e: DesLifecycleEvent): void {
    if (this.disposed) return;
    switch (e.type) {
      case 'reset':
        this.ended = true;
        this.live.clear();                  // the runner dropped them
        return;
      case 'bound':
        if (!this.ended) return;            // not a restart of a run this clock saw
        this.ended = false;
        this.reset();
        this.onRestart?.('reset');
        return;
      case 'restored':
        if (this.restoredState) { this.restoredState = false; return; }
        this.reset();
        this.onRestart?.('restore-replan');
        return;
      case 'disposed':
        this.reset();                       // the runner is gone: stop, nothing to re-plan on
        this.dispose();
        return;
    }
  }

  /** Number of callbacks still pending in this generation (diagnostics / tests). */
  get pending(): number { return this.live.size; }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.offLifecycle();
    if (globals.__rvFleetDesClock === this) globals.__rvFleetDesClock = null;
    this.live.clear();
  }
}

// The dispatcher resolves the current page clock, including across module reloads.
if (!ACTION_INDEX.has('Fleet.Action')) registerAction('Fleet.Action', ctx => {
  const { g, k, d } = ctx.data as { g: number; k: string; d?: JsonValue };
  (globals.__rvFleetDesClock as DesSimClock | null)?.dispatchAction(g, k, d);
}, { owner: 'fleet.clock', payload: data => {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return ['expected {g,k,d?}'];
  return Number.isSafeInteger(data.g) && Number(data.g) >= 1 && typeof data.k === 'string'
    && Object.keys(data).every(k => ['g', 'k', 'd'].includes(k)) ? [] : ['expected {g,k,d?}'];
} });
