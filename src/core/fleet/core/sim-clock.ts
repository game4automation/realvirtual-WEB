// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * sim-clock.ts — the ONE fachliche time source of the fleet core (plan-559 §2.3, D6).
 *
 * Everything the fleet decides (dispatch, wait limits, charging, takt) runs in
 * SIMULATION seconds, deterministically, identical in DES and continuous mode.
 * Nothing here reads a wall clock.
 *
 * Contract of {@link SimClock}:
 *  - `schedule(at, fn)` fires `fn` EXACTLY ONCE when simulation time reaches
 *    `at` — also when one time step jumps over several events (FastForward):
 *    they fire in time order, a tie in scheduling order within the same priority.
 *  - `cancel(h)` prevents a pending event. A handle of a FOREIGN generation
 *    (scheduled before the last `reset()`) is a no-op, as are `null`/`undefined`.
 *  - `reset()` opens a new generation: every pending event of the old one is
 *    dropped and never fires.
 *
 * {@link ContinuousSimClock} is the pure implementation: time is pushed from
 * outside with {@link ContinuousSimClock.advanceTo}. Coupling it to the
 * continuous sim loop (`onFixedUpdatePost`) is plan-559 Phase 7, not here; the
 * DES clock is the adapter `src/plugins/des/fleet/des-sim-clock.ts` (Phase 5).
 */

import type { JsonValue } from '../../material-flow/material-flow-self';

/** Opaque handle of one scheduled event: generation + id. */
export interface ClockHandle { readonly g: number; readonly id: number }

/** The fleet's simulation clock (plan-559 §2.3). */
export interface SimClock {
  /** Current simulation time in seconds. */
  now(): number;
  /** Fire once at `atSimSec`; DES can order after model events, continuous ignores opts (POST). */
  schedule(atSimSec: number, fn: () => void, opts?: { afterModelEvents?: boolean }): ClockHandle;
  scheduleAction(atSimSec: number, kind: string, data?: JsonValue, opts?: { afterModelEvents?: boolean }): ClockHandle;
  registerAction(kind: string, handler: (data: JsonValue | undefined) => void): () => void;
  /** Cancel a pending event; foreign generation / null / already fired: no-op. */
  cancel(h: ClockHandle | null | undefined): void;
  /** Open a new generation — no event scheduled before fires afterwards. */
  reset(): void;
  /** Drop everything; the clock schedules nothing afterwards. */
  dispose(): void;
}

/** Internal heap entry; doubles as the handle given out. */
interface ClockEntry extends ClockHandle {
  readonly at: number;
  fn: (() => void) | null;
  kind?: string;
  data?: JsonValue;
}

/** Strict order: time first, then scheduling order (id). */
function before(a: ClockEntry, b: ClockEntry): boolean {
  return a.at < b.at || (a.at === b.at && a.id < b.id);
}

/**
 * Pure, externally driven implementation of {@link SimClock}.
 *
 * - `advanceTo(t)` fires every pending event with `at <= t` in (time, id)
 *   order and leaves `now() === t`. During a callback `now()` is the event's
 *   own time. Events scheduled from a callback with `at <= t` fire within the
 *   same `advanceTo`.
 * - An event scheduled in the past (`at < now()`) fires on the next
 *   `advanceTo`, never synchronously inside `schedule` (re-entrance safety);
 *   `now()` inside such a callback is the current time (time never runs back).
 * - `advanceTo` with a time before `now()` is a no-op for the time itself.
 * - `reset()` additionally returns the time to `startSec` (default 0): a reset
 *   is the start of a new simulation run.
 */
export class ContinuousSimClock implements SimClock {
  private t = 0;
  private gen = 1;
  private nextId = 1;
  private disposed = false;
  /** Binary min-heap by (at, id). */
  private readonly heap: ClockEntry[] = [];
  /** Pending (scheduled, not fired, not cancelled) events by id. */
  private readonly pending = new Map<number, ClockEntry>();
  private fired = 0;
  private readonly actions = new Map<string, (data: JsonValue | undefined) => void>();

  constructor(startSec = 0) {
    this.t = startSec;
  }

  now(): number {
    return this.t;
  }

  /** Current generation (bumped by {@link reset}). */
  get generation(): number {
    return this.gen;
  }

  /** Number of pending events of the current generation. */
  get pendingCount(): number {
    return this.pending.size;
  }

  /** Events fired since construction / last reset (a deterministic work counter). */
  get firedCount(): number {
    return this.fired;
  }

  schedule(atSimSec: number, fn: () => void, opts?: { afterModelEvents?: boolean }): ClockHandle {
    const entry: ClockEntry = { g: this.gen, id: this.nextId++, at: atSimSec, fn };
    if (this.disposed || Number.isNaN(atSimSec)) {
      entry.fn = null; // never fires; the handle stays valid for cancel()
      return entry;
    }
    this.pending.set(entry.id, entry);
    this.push(entry);
    return entry;
  }

  registerAction(kind: string, handler: (data: JsonValue | undefined) => void): () => void {
    if (!this.actions.has(kind)) this.actions.set(kind, handler);
    const registered = this.actions.get(kind);
    return () => { if (this.actions.get(kind) === registered) this.actions.delete(kind); };
  }

  scheduleAction(atSimSec: number, kind: string, data?: JsonValue, _opts?: { afterModelEvents?: boolean }): ClockHandle {
    const entry: ClockEntry = { g: this.gen, id: this.nextId++, at: atSimSec, fn: null, kind, data };
    if (!this.disposed && !Number.isNaN(atSimSec)) {
      this.pending.set(entry.id, entry);
      this.push(entry);
    }
    // A plain `{g, id}`: the handle is persisted as state, the heap entry must not leak out.
    return { g: entry.g, id: entry.id };
  }

  cancel(h: ClockHandle | null | undefined): void {
    if (!h || h.g !== this.gen) return;
    const entry = this.pending.get(h.id);
    if (!entry) return;
    entry.fn = null; // lazy deletion: skipped when it reaches the heap top
    this.pending.delete(h.id);
  }

  reset(startSec = 0): void {
    this.gen++;
    for (const e of this.heap) e.fn = null;
    this.heap.length = 0;
    this.pending.clear();
    this.t = startSec;
    this.fired = 0;
  }

  dispose(): void {
    this.reset(this.t);
    this.disposed = true;
  }

  /**
   * Advance simulation time to `simSec`, firing every due event exactly once
   * in (time, scheduling) order. Returns the number of events fired.
   * A `reset()` from inside a callback ends the advance (the new generation
   * starts at its own time).
   */
  advanceTo(simSec: number): number {
    if (this.disposed || Number.isNaN(simSec)) return 0;
    const g = this.gen;
    let n = 0;
    while (this.heap.length > 0 && this.heap[0].at <= simSec) {
      const e = this.pop();
      const fn = e.fn;
      if (!this.pending.has(e.id)) continue; // cancelled
      e.fn = null;
      this.pending.delete(e.id);
      if (e.at > this.t) this.t = e.at;
      this.fired++;
      n++;
      if (e.kind !== undefined) {
        const handler = this.actions.get(e.kind);
        if (!handler) throw new Error(`Unknown clock action: ${e.kind}`);
        handler(e.data);
      } else fn!();
      if (this.gen !== g || this.disposed) return n;
    }
    if (simSec > this.t) this.t = simSec;
    return n;
  }

  // ── heap ────────────────────────────────────────────────────────────────

  private push(e: ClockEntry): void {
    const h = this.heap;
    h.push(e);
    let i = h.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!before(h[i], h[p])) break;
      const tmp = h[i]; h[i] = h[p]; h[p] = tmp;
      i = p;
    }
  }

  private pop(): ClockEntry {
    const h = this.heap;
    const top = h[0];
    const last = h.pop()!;
    if (h.length > 0) {
      h[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < h.length && before(h[l], h[m])) m = l;
        if (r < h.length && before(h[r], h[m])) m = r;
        if (m === i) break;
        const tmp = h[i]; h[i] = h[m]; h[m] = tmp;
        i = m;
      }
    }
    return top;
  }
}
