// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-des-event-queue.ts -- 4-ary min-heap with TypedArrays.
 *
 * Struct-of-arrays layout for zero GC in the hot path:
 *   Float64Array  times       -- scheduled time
 *   Int32Array    priorities  -- higher = fires first at same time
 *   Uint32Array   ids         -- monotonic event ID (tie-breaker)
 *   Uint32Array   actions     -- index into Named Action table
 *   Int32Array    entityIds   -- component owner
 *   Int32Array    muIds       -- associated MU (-1 if none)
 *
 * Comparison order: time ASC -> priority DESC -> id ASC
 * (matches C# DESEvent.CompareTo)
 *
 * Lazy cancel: cancelled events have times[i] set to -Infinity and are
 * skipped on dequeue. This avoids O(n) removal.
 */

/** Sentinel time for cancelled events. */
const CANCELLED = -Infinity;

/** Branching factor -- 4-ary gives fewer levels and better cache locality than binary. */
const D = 4;

export class DESEventQueue {
  private times: Float64Array;
  private priorities: Int32Array;
  private ids: Uint32Array;
  private actions: Uint32Array;
  private entityIds: Int32Array;
  private muIds: Int32Array;

  private _count = 0;
  private _capacity: number;
  get nextId(): number { return this._nextId; }

  private _nextId = 0;

  /** Map from event ID to slot index (for lazy cancel). */
  private idToSlot: Map<number, number> = new Map();

  constructor(initialCapacity = 1024) {
    this._capacity = Math.max(4, initialCapacity);
    this.times = new Float64Array(this._capacity);
    this.priorities = new Int32Array(this._capacity);
    this.ids = new Uint32Array(this._capacity);
    this.actions = new Uint32Array(this._capacity);
    this.entityIds = new Int32Array(this._capacity);
    this.muIds = new Int32Array(this._capacity);
  }

  // ── Public API ──

  /** Number of events in the queue (including cancelled). */
  get count(): number { return this._count; }

  /** Entries of the id → slot index; equals `count` (plan-612 #211 — never grows with processed events). */
  get indexSize(): number { return this.idToSlot.size; }

  /** Time of the next uncancelled event, or +Infinity if empty. */
  get peekTime(): number {
    // Skip cancelled events at the top
    // Note: cancelled events are lazily cleaned during dequeue
    if (this._count === 0) return Number.POSITIVE_INFINITY;
    return this.times[0] === CANCELLED ? this._peekUncancelled() : this.times[0];
  }

  /** True when there are no uncancelled events left. */
  get isEmpty(): boolean {
    return this.peekTime === Number.POSITIVE_INFINITY;
  }

  /**
   * Insert a new event into the heap.
   * Returns the event ID (for later cancellation).
   */
  enqueue(
    time: number,
    actionIndex: number,
    entityId: number,
    muId: number,
    priority = 0,
  ): number {
    if (this._nextId >= 0xffffffff) throw new RangeError('des-event-id-overflow');
    if (this._count >= this._capacity) this._grow();

    const id = this._nextId++;
    const slot = this._count++;

    this.times[slot] = time;
    this.priorities[slot] = priority;
    this.ids[slot] = id;
    this.actions[slot] = actionIndex;
    this.entityIds[slot] = entityId;
    this.muIds[slot] = muId;
    this.idToSlot.set(id, slot);

    this._siftUp(slot);
    return id;
  }

  /**
   * Remove and return the top event. Skips cancelled events.
   * Returns null if the queue is empty (all events cancelled or count === 0).
   */
  dequeue(): {
    time: number;
    actionIndex: number;
    entityId: number;
    muId: number;
    id: number;
    priority: number;
  } | null {
    while (this._count > 0) {
      // Read top
      const time = this.times[0];
      const actionIndex = this.actions[0];
      const entityId = this.entityIds[0];
      const muId = this.muIds[0];
      const id = this.ids[0];
      const priority = this.priorities[0];

      // Remove top: swap with last, sift down. The id leaves the index AFTER the swap —
      // `_swap` re-registers both ids, so deleting first left the consumed id mapped to the
      // slot just past the heap: the index grew by one entry per event (plan-612 #211), and
      // a late `cancel()` of that id hit whatever live event later occupied the slot.
      this._count--;

      if (this._count > 0) {
        this._swap(0, this._count);
        this._siftDown(0);
      }
      this.idToSlot.delete(id);

      // Skip cancelled
      if (time === CANCELLED) continue;

      return { time, actionIndex, entityId, muId, id, priority };
    }
    return null;
  }

  /** Event ID of the top uncancelled event, or -1 when the queue is empty. */
  peekId(): number {
    if (this.peekTime === Number.POSITIVE_INFINITY) return -1;
    return this.ids[0];
  }

  /**
   * Minimum time among LIVE events EXCLUDING the given event id, or +Infinity
   * when no other live event exists. O(n) scan over the heap arrays — callers
   * (the manager's checkpoint logic) use it only while the excluded event is
   * top-of-queue, never per model event.
   */
  minTimeExcluding(excludeId: number): number {
    return this.minTimeExcluding2(excludeId, -1);
  }

  /** Minimum live model time excluding both system events, without allocation. */
  minTimeExcluding2(a: number, b: number): number {
    let min = Number.POSITIVE_INFINITY;
    for (let i = 0; i < this._count; i++) {
      const t = this.times[i];
      if (t === CANCELLED || this.ids[i] === a || this.ids[i] === b) continue;
      if (t < min) min = t;
    }
    return min;
  }

  /** Action of a live queued event; used only when cancelling handles. */
  actionIndexOf(eventId: number): number | undefined {
    const slot = this.idToSlot.get(eventId);
    return slot === undefined || this.times[slot] === CANCELLED ? undefined : this.actions[slot];
  }

  /**
   * MU id of a LIVE (uncancelled) event, or -1 when the event is unknown or
   * already cancelled. Lets the manager keep per-MU pending-event refcounts in
   * sync on cancel without double-decrementing on a repeated cancel.
   */
  muIdOf(eventId: number): number {
    const slot = this.idToSlot.get(eventId);
    if (slot === undefined) return -1;
    if (this.times[slot] === CANCELLED) return -1;
    return this.muIds[slot];
  }

  /**
   * Cancel an event by ID (lazy -- marks as cancelled, cleaned on dequeue).
   * Returns true if the event was found and cancelled.
   */
  cancel(eventId: number): boolean {
    const slot = this.idToSlot.get(eventId);
    if (slot === undefined) return false;
    this.times[slot] = CANCELLED;
    // Restore the heap invariant: the sentinel is the minimum, so it bubbles to
    // the top and is drained there. Left in place, a cancelled inner node
    // stops the sift-up of a later, EARLIER event below it, which then
    // dequeues after a later event (plan-558: heavy cancel/reschedule
    // traffic exposed sim time running backwards).
    this._siftUp(slot);
    // Don't remove from idToSlot -- cleaned on dequeue
    return true;
  }

  /** Remove all events. */
  clear(): void {
    this._count = 0;
    this._nextId = 0;
    this.idToSlot.clear();
  }

  /**
   * Serialize all non-cancelled events for snapshot.
   * Returns raw arrays (caller maps action indices to names).
   *
   * DETERMINISM (plan-261 B1): the heap arrays are iterated in MEMORY order,
   * which is not dispatch order. `restore()` re-enqueues in array order and
   * assigns FRESH monotonic ids — so the FIFO tie-break (`id ASC`) of
   * time-/priority-equal events would flip if we returned memory order.
   * The result is therefore sorted by the exact dispatch comparator
   * (time ASC → priority DESC → id ASC); after a restore the new ids are
   * assigned in dispatch order and the relative order of equal events is
   * preserved bit-identically.
   */
  snapshot(): Array<{
    time: number;
    actionIndex: number;
    entityId: number;
    muId: number;
    priority: number;
    id: number;
  }> {
    const result: Array<{
      time: number;
      actionIndex: number;
      entityId: number;
      muId: number;
      priority: number;
      id: number;
    }> = [];
    for (let i = 0; i < this._count; i++) {
      if (this.times[i] === CANCELLED) continue;
      result.push({
        time: this.times[i],
        actionIndex: this.actions[i],
        entityId: this.entityIds[i],
        muId: this.muIds[i],
        priority: this.priorities[i],
        id: this.ids[i],
      });
    }
    // Dispatch-order sort (time ASC → priority DESC → id ASC) — see note above.
    result.sort((a, b) => {
      if (a.time !== b.time) return a.time - b.time;
      if (a.priority !== b.priority) return b.priority - a.priority;
      return a.id - b.id;
    });
    return result;
  }

  /**
   * Read all events (including cancelled) without modifying the heap.
   * Returns a time-sorted snapshot for display purposes.
   */
  getSnapshot(): Array<{
    time: number;
    actionIndex: number;
    entityId: number;
    muId: number;
    priority: number;
    cancelled: boolean;
    id: number;
  }> {
    const result: Array<{
      time: number;
      actionIndex: number;
      entityId: number;
      muId: number;
      priority: number;
      cancelled: boolean;
      id: number;
    }> = [];
    for (let i = 0; i < this._count; i++) {
      const isCancelled = this.times[i] === CANCELLED;
      result.push({
        time: isCancelled ? 0 : this.times[i],
        actionIndex: this.actions[i],
        entityId: this.entityIds[i],
        muId: this.muIds[i],
        priority: this.priorities[i],
        cancelled: isCancelled,
        id: this.ids[i],
      });
    }
    // Heap order is NOT sorted by index -- sort by time for display
    result.sort((a, b) => {
      if (a.cancelled !== b.cancelled) return a.cancelled ? 1 : -1;
      return a.time - b.time;
    });
    return result;
  }

  /** Restore from snapshot (queue must be clear first). */
  restore(events: ReadonlyArray<{
    time: number;
    actionIndex: number;
    entityId: number;
    muId: number;
    priority: number;
  }>): void {
    this.clear();
    for (const e of events) {
      this.enqueue(e.time, e.actionIndex, e.entityId, e.muId, e.priority);
    }
  }

  /** Restore original IDs and the sequence counter; reject invalid input before mutation. */
  restoreWithIds(events: ReadonlyArray<{
    id: number;
    time: number;
    actionIndex: number;
    entityId: number;
    muId: number;
    priority: number;
  }>, nextId: number): void {
    const uint32 = (value: number): boolean =>
      Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
    const int32 = (value: number): boolean =>
      Number.isInteger(value) && value >= -0x80000000 && value <= 0x7fffffff;
    if (!uint32(nextId)) throw new RangeError('des-event-next-id-range');
    const ids = new Set<number>();
    for (const e of events) {
      if (!uint32(e.id) || e.id >= nextId || ids.has(e.id))
        throw new RangeError('des-event-id-range');
      if (!Number.isFinite(e.time)) throw new RangeError('des-event-time-range');
      if (!int32(e.priority) || !int32(e.entityId) || !int32(e.muId))
        throw new RangeError('des-event-int32-range');
      if (!uint32(e.actionIndex)) throw new RangeError('des-event-action-index-range');
      ids.add(e.id);
    }

    this.clear();
    for (const e of events) {
      if (this._count >= this._capacity) this._grow();
      const slot = this._count++;
      this.times[slot] = e.time;
      this.priorities[slot] = e.priority;
      this.ids[slot] = e.id;
      this.actions[slot] = e.actionIndex;
      this.entityIds[slot] = e.entityId;
      this.muIds[slot] = e.muId;
      this.idToSlot.set(e.id, slot);
      this._siftUp(slot);
    }
    this._nextId = nextId;
  }

  // ── Internal ──

  /** Find the next uncancelled peekTime by scanning from top. */
  private _peekUncancelled(): number {
    // Drain cancelled events from the top
    while (this._count > 0 && this.times[0] === CANCELLED) {
      const id = this.ids[0];
      this._count--;
      if (this._count > 0) {
        this._swap(0, this._count);
        this._siftDown(0);
      }
      this.idToSlot.delete(id); // after the swap, see dequeue()
    }
    return this._count === 0 ? Number.POSITIVE_INFINITY : this.times[0];
  }

  /** Double capacity and copy all arrays. */
  private _grow(): void {
    const newCap = this._capacity * 2;
    const copyTo = <T extends Float64Array | Int32Array | Uint32Array>(
      OldArr: T,
      Ctor: { new(n: number): T },
    ): T => {
      const arr = new Ctor(newCap);
      arr.set(OldArr);
      return arr;
    };
    this.times = copyTo(this.times, Float64Array as unknown as { new(n: number): Float64Array });
    this.priorities = copyTo(this.priorities, Int32Array as unknown as { new(n: number): Int32Array });
    this.ids = copyTo(this.ids, Uint32Array as unknown as { new(n: number): Uint32Array });
    this.actions = copyTo(this.actions, Uint32Array as unknown as { new(n: number): Uint32Array });
    this.entityIds = copyTo(this.entityIds, Int32Array as unknown as { new(n: number): Int32Array });
    this.muIds = copyTo(this.muIds, Int32Array as unknown as { new(n: number): Int32Array });
    this._capacity = newCap;
  }

  /**
   * Compare two slots: returns true if a should come before b.
   * Order: time ASC -> priority DESC -> id ASC
   */
  private _less(a: number, b: number): boolean {
    const ta = this.times[a], tb = this.times[b];
    if (ta !== tb) return ta < tb;
    const pa = this.priorities[a], pb = this.priorities[b];
    if (pa !== pb) return pa > pb; // higher priority first
    return this.ids[a] < this.ids[b]; // FIFO tie-break
  }

  /** Swap two slots in all arrays. */
  private _swap(a: number, b: number): void {
    // Swap all parallel arrays
    let tmp: number;

    tmp = this.times[a]; this.times[a] = this.times[b]; this.times[b] = tmp;
    tmp = this.priorities[a]; this.priorities[a] = this.priorities[b]; this.priorities[b] = tmp;
    tmp = this.ids[a]; this.ids[a] = this.ids[b]; this.ids[b] = tmp;
    tmp = this.actions[a]; this.actions[a] = this.actions[b]; this.actions[b] = tmp;
    tmp = this.entityIds[a]; this.entityIds[a] = this.entityIds[b]; this.entityIds[b] = tmp;
    tmp = this.muIds[a]; this.muIds[a] = this.muIds[b]; this.muIds[b] = tmp;

    // Update id→slot mapping
    this.idToSlot.set(this.ids[a], a);
    this.idToSlot.set(this.ids[b], b);
  }

  /** 4-ary sift-up: move slot up while parent is worse. */
  private _siftUp(slot: number): void {
    while (slot > 0) {
      const parent = Math.floor((slot - 1) / D);
      if (this._less(slot, parent)) {
        this._swap(slot, parent);
        slot = parent;
      } else {
        break;
      }
    }
  }

  /** 4-ary sift-down: move slot down to smallest child. */
  private _siftDown(slot: number): void {
    const n = this._count;
    while (true) {
      const firstChild = slot * D + 1;
      if (firstChild >= n) break;

      // Find the best among up to D children
      let best = firstChild;
      const lastChild = Math.min(firstChild + D, n);
      for (let c = firstChild + 1; c < lastChild; c++) {
        if (this._less(c, best)) best = c;
      }

      if (this._less(best, slot)) {
        this._swap(slot, best);
        slot = best;
      } else {
        break;
      }
    }
  }
}
