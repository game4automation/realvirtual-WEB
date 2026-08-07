// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-event-heap.ts — the shared timer/event heap (plan-210 §6b, phase 1).
 *
 * ONE event heap is the single source of virtual time for script-component
 * timers (`self.in` / `self.at` / `self.cancel`), kernel-agnostic:
 *
 *  - **continuous kernel** — the fixed tick drains all events with
 *    `time <= now` (`drainUntil`), HDL-delta-cycle style.
 *  - **DES kernel** — the scheduler jumps straight to `peekTime()`.
 *
 * Determinism rules (§6b point 5):
 *  - events are ordered by ABSOLUTE virtual target time (never frame counts,
 *    never wall clock);
 *  - ties break FIFO by registration order (a monotonic sequence number);
 *  - MULTIPLE handlers per event from the start (listener array, not a
 *    single-slot registration — the Factorio lesson).
 *
 * The heap itself carries NO clock — the owning kernel/adapter advances time
 * and calls `drainUntil(now)`. Cancellation is lazy (tombstone set): a
 * cancelled event stays in the array until it surfaces and is skipped.
 */

/** A scheduled hook event as delivered to heap listeners. */
export interface ScheduledHookEvent {
  /** Monotonic event id (as returned by `schedule`). */
  readonly id: number;
  /** Absolute virtual target time in seconds. */
  readonly time: number;
  /** Free-form hook name (`self.in(delay, hook, …)`). */
  readonly hook: string;
  /** Optional MU reference riding the event (opaque to the heap). */
  readonly mu: unknown | null;
  /** Optional user payload. */
  readonly data: unknown;
}

/** Listener invoked for every due event on drain. */
export type HookEventListener = (event: ScheduledHookEvent) => void;

interface HeapEntry {
  id: number;
  time: number;
  seq: number;
  hook: string;
  mu: unknown | null;
  data: unknown;
}

/** `(time, seq)` lexicographic order — earlier time first, FIFO on ties. */
function isBefore(a: HeapEntry, b: HeapEntry): boolean {
  return a.time < b.time || (a.time === b.time && a.seq < b.seq);
}

/**
 * Binary min-heap of scheduled hook events, ordered by `(time, seq)`.
 * No wall clock, no `Date` — pure virtual time, fully deterministic.
 */
export class RVEventHeap {
  private readonly entries: HeapEntry[] = [];
  private readonly cancelled = new Set<number>();
  private readonly listeners: HookEventListener[] = [];
  private nextId = 1;
  private nextSeq = 0;

  /** Number of pending (non-cancelled) events. */
  get size(): number {
    return this.entries.length - this.cancelled.size;
  }

  /**
   * Schedule an event at ABSOLUTE virtual time `time`. Returns the event id
   * (usable with `cancel`). Ties with already-scheduled events at the same
   * time dispatch FIFO (registration order).
   */
  schedule(time: number, hook: string, mu?: unknown | null, data?: unknown): number {
    if (!Number.isFinite(time)) {
      throw new Error(`[event-heap] non-finite event time (${time}) for hook '${hook}'`);
    }
    const entry: HeapEntry = {
      id: this.nextId++,
      time,
      seq: this.nextSeq++,
      hook,
      mu: mu ?? null,
      data,
    };
    this.entries.push(entry);
    this.bubbleUp(this.entries.length - 1);
    return entry.id;
  }

  /** Cancel a pending event. Returns true when the id was pending. */
  cancel(eventId: number): boolean {
    // Lazy delete: mark and skip on surfacing. Guard against ids that never
    // existed or already fired (their entry is gone from the array).
    if (this.cancelled.has(eventId)) return false;
    const pending = this.entries.some((e) => e.id === eventId);
    if (!pending) return false;
    this.cancelled.add(eventId);
    return true;
  }

  /** Absolute time of the next pending event, or null when empty. */
  peekTime(): number | null {
    this.skimCancelled();
    return this.entries.length > 0 ? this.entries[0].time : null;
  }

  /**
   * Register a drain listener. EVERY listener receives EVERY due event
   * (listener array — multiple handlers per event, §6b point 4). Returns an
   * unsubscribe function.
   */
  addListener(listener: HookEventListener): () => void {
    this.listeners.push(listener);
    return () => {
      const i = this.listeners.indexOf(listener);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  /**
   * Pop + dispatch ALL events with `time <= now` in `(time, seq)` order (the
   * continuous kernel's per-tick drain). Events scheduled DURING the drain
   * that are also due (`time <= now`) run in the same drain — delta-cycle
   * semantics. Returns the number of dispatched events.
   */
  drainUntil(now: number): number {
    let dispatched = 0;
    for (;;) {
      this.skimCancelled();
      if (this.entries.length === 0 || this.entries[0].time > now) break;
      const entry = this.popTop();
      dispatched++;
      const event: ScheduledHookEvent = {
        id: entry.id,
        time: entry.time,
        hook: entry.hook,
        mu: entry.mu,
        data: entry.data,
      };
      // Snapshot the listener array so a listener adding/removing listeners
      // mid-dispatch does not skew this event's fan-out.
      for (const listener of [...this.listeners]) {
        try {
          listener(event);
        } catch (err) {
          console.error(`[event-heap] listener failed for hook '${entry.hook}':`, err);
        }
      }
    }
    return dispatched;
  }

  /** Drop all pending events and cancellations (reset). Listeners stay. */
  clear(): void {
    this.entries.length = 0;
    this.cancelled.clear();
  }

  // ─── Internals ─────────────────────────────────────────────────────────

  /** Remove cancelled entries sitting at the top so peek/drain see live ones. */
  private skimCancelled(): void {
    while (this.entries.length > 0 && this.cancelled.has(this.entries[0].id)) {
      const top = this.popTop();
      this.cancelled.delete(top.id);
    }
  }

  private popTop(): HeapEntry {
    const top = this.entries[0];
    const last = this.entries.pop()!;
    if (this.entries.length > 0) {
      this.entries[0] = last;
      this.sinkDown(0);
    }
    return top;
  }

  private bubbleUp(index: number): void {
    const e = this.entries;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (!isBefore(e[index], e[parent])) break;
      [e[index], e[parent]] = [e[parent], e[index]];
      index = parent;
    }
  }

  private sinkDown(index: number): void {
    const e = this.entries;
    const n = e.length;
    for (;;) {
      const left = 2 * index + 1;
      const right = left + 1;
      let smallest = index;
      if (left < n && isBefore(e[left], e[smallest])) smallest = left;
      if (right < n && isBefore(e[right], e[smallest])) smallest = right;
      if (smallest === index) break;
      [e[index], e[smallest]] = [e[smallest], e[index]];
      index = smallest;
    }
  }
}
