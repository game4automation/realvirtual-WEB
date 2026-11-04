// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-script-hook.ts — the PUBLIC hook-dispatch contract between script
 * components and the two simulation kernels (plan-210 §6b, ADR-022 cut).
 *
 * Script components schedule timers with free-form runtime hook NAMES
 * (`self.in(delay, 'rotated', mu)`), unlike the material-flow definitions
 * whose hooks are statically declared (`def.des.*` → named-action integers).
 * The dispatch therefore crosses the public/private boundary as follows:
 *
 *  - PUBLIC (this file): `ScriptHookDispatcher` — the callback surface a
 *    script-component host implements. `SdkScheduler` — the unified
 *    `in/at/cancel/now` timer surface, with TWO implementations:
 *      * `createHeapScheduler()` (public) — backed by the shared
 *        `RVEventHeap`, drained by the continuous kernel each tick;
 *      * the DES runner's `makeScriptHookScheduler()` — schedules a
 *        generic `Script.Hook` named action on the DES event queue whose
 *        wrapper calls BACK through `ScriptHookDispatcher` into the VM.
 *  - DES (src/plugins/des/rv-des-script-hook.ts, core since plan-680): the
 *    generic `ScriptHook` action type (registerAction pattern), minimal by
 *    design.
 *
 * Because both schedulers implement the SAME interface, a script component
 * never knows which kernel serves its timers ("write once, run both speeds").
 */

import { RVEventHeap } from './rv-event-heap';

/** Value-safe MU reference as it crosses the script boundary (plain data). */
export interface ScriptMuRef {
  readonly id: number;
  /** Optional MU type/template name. */
  readonly type?: string;
  readonly prop?: Record<string, unknown>;
}

/**
 * Value-safe PORT descriptor as it crosses the script boundary (plain data,
 * phase 1b). Station dispatch (DES `canAccept/onAccept/onDownstreamReady`)
 * passes ports as descriptors; the guest hydrates them into full `Port`
 * handles whose reads go back through the ports backend BY ID — the id space
 * is the snap-graph partner-snap id on both sides (same topology source).
 */
export interface ScriptPortDesc {
  readonly id: string;
  readonly role: 'input' | 'output';
  /** Opaque node id of the own local snap node (null when host-built without a bridge). */
  readonly node?: number | null;
  /** Opaque node id of the partner root (null when host-built without a bridge). */
  readonly partner?: number | null;
  readonly worldAngle?: number | null;
}

/**
 * INTERNAL hook names riding the normal timer/event pipeline (never delivered
 * to a user's `des.on` directly — the guest-side router consumes them):
 *  - `RV_EVERY_HOOK`: recurring `self.every()` slice, payload `{ pid }`. The
 *    HOST re-arms the next slice (`SdkEveryTimers.fire`, plan-2212 Phase 4c);
 *    the guest looks up hook + data under the pid and calls the user hook.
 *  - `RV_MSG_HOOK`: script→script message (`self.component(path).send` /
 *    `self.broadcast`); routed to the `onMessage(topic, data, fromPath)`
 *    handler. Delivery goes through the target's event list (time = now,
 *    FIFO) so it is deterministic in BOTH kernels.
 */
export const RV_EVERY_HOOK = '__rv.every';
export const RV_MSG_HOOK = '__rv.msg';
/** StopOnExit arrival (plan-259): routed to the `onArrival(mu)` handler. The
 *  event's MU slot carries the held MU reference. */
export const RV_ARRIVAL_HOOK = '__rv.arrival';
/** Custom-connection request (plan-259): routed to
 *  `onRequest(topic, params, reply)`. Data = {@link ScriptConnRequestData}. */
export const RV_CONN_REQ_HOOK = '__rv.connreq';

/** Payload of an `RV_MSG_HOOK` event (plain data). */
export interface ScriptMessageData {
  readonly topic: string;
  readonly data: unknown;
  readonly from: string;
}

/** Payload of an `RV_CONN_REQ_HOOK` event (plain data, plan-259). The guest
 *  router builds a deferred `reply(response)` from `replyId` that answers
 *  through the host (`conn.reply` op) — no Promise/await, exactly-once. */
export interface ScriptConnRequestData {
  readonly topic: string;
  readonly params: Record<string, unknown>;
  readonly replyId: number;
}

/**
 * The dispatch surface a script-component host implements. Both kernels call
 * it when a scheduled hook event comes due:
 *  - continuous: the `RVEventHeap` drain (via `createHeapScheduler` wiring);
 *  - DES: the private `Script.Hook` named action.
 */
export interface ScriptHookDispatcher {
  /** Deliver a due hook event to the component (host→VM: `des.on(hook, mu, data)`). */
  dispatchScriptHook(hook: string, mu: ScriptMuRef | null, data?: unknown): void;
}

/**
 * The unified Tier-0 timer surface behind `self.in/at/cancel/now` (§6b:
 * kernel-agnostic primitives). Times are in SECONDS of virtual sim time.
 */
export interface SdkScheduler {
  /** Schedule `hook` after `delaySec` seconds of virtual time. Returns an event id. */
  in(delaySec: number, hook: string, mu?: ScriptMuRef | null, data?: unknown): number;
  /** Schedule `hook` at ABSOLUTE virtual time `timeSec`. Returns an event id. */
  at(timeSec: number, hook: string, mu?: ScriptMuRef | null, data?: unknown): number;
  /** Cancel a pending event by id (no-op for unknown/fired ids). A NEGATIVE id
   *  names a recurring `every` timer of this scheduler (plan-2212 Phase 4c). */
  cancel(eventId: number): void;
  /**
   * Start a recurring timer (`self.every`, plan-2212 Phase 4c): a slice of
   * `hook` comes due every `intervalSec` seconds. Returns the NEGATIVE public
   * id. The host owns only the CLOCK: it re-arms the next slice itself before
   * the slice reaches the script. The payload never crosses — the guest keeps
   * it (identity preserved) under the pid. Optional only for minimal test
   * schedulers; both kernel schedulers implement it.
   */
  every?(intervalSec: number, hook: string): number;
  /** The recurring-timer records behind {@link every} (dispatch, snapshot, teardown). */
  readonly everyTimers?: SdkEveryTimers;
  /** Current virtual sim time in seconds. */
  readonly now: number;
}

/** One recurring `self.every` timer as the host keeps it (plan-2212 Phase 4c): clock only, no payload. */
export interface SdkEveryRecord {
  /** Public id (negative). */
  pid: number;
  /** Interval in seconds. */
  interval: number;
  /** The user hook a slice delivers (the snapshot table carries it). */
  hook: string;
  /** Event id of the pending slice. */
  current: number;
}

/** The host half of the recurring-timer table (the guest adds `data` per pid). */
export interface SdkEveryTable {
  next: number;
  items: SdkEveryRecord[];
}

/**
 * Host-side clock of the recurring `self.every` timers of ONE script component
 * (plan-2212 Phase 4c: the clock belongs to the kernel, not to the script
 * engine). Each slice is an ordinary `RV_EVERY_HOOK` event with payload
 * `{ pid }`, scheduled through the owning kernel's `in()`. When a slice comes
 * due, the dispatcher calls {@link fire}, which re-arms the NEXT slice before
 * the user hook runs: the same order the former guest-side re-scheduling used,
 * so event ids, event order and results stay unchanged.
 *
 * Public ids are negative (`-1, -2, ...` in creation order) and never collide
 * with kernel event ids; a cancelled id is never reused.
 */
export class SdkEveryTimers {
  private records = new Map<number, SdkEveryRecord>();
  private next = 1;

  constructor(
    private readonly arm: (intervalSec: number, pid: number) => number,
    private readonly disarm: (eventId: number) => void,
  ) {}

  /** Number of live recurring timers. */
  get size(): number {
    return this.records.size;
  }

  /** True when `pid` is a live timer. */
  has(pid: number): boolean {
    return this.records.has(pid);
  }

  /**
   * Create a timer and schedule its first slice. The kernel schedules FIRST:
   * a refused schedule throws before a record exists or the id counter moves.
   */
  add(intervalSec: number, hook: string): number {
    const pid = -this.next;
    const current = this.arm(intervalSec, pid);
    this.next++;
    this.records.set(pid, { pid, interval: intervalSec, hook, current });
    return pid;
  }

  /** A slice of `pid` came due: re-arm the next slice, return the record (null = cancelled, stale slice). */
  fire(pid: unknown): SdkEveryRecord | null {
    const rec = typeof pid === 'number' ? this.records.get(pid) : undefined;
    if (!rec) return null;
    rec.current = this.arm(rec.interval, rec.pid);
    return rec;
  }

  /** Cancel a timer by public id. False for an unknown or already cancelled id. */
  cancel(pid: number): boolean {
    const rec = this.records.get(pid);
    if (!rec) return false;
    this.records.delete(pid);
    this.disarm(rec.current);
    return true;
  }

  /** Cancel every timer (auto-teardown on dispose). The id counter stays. */
  cancelAll(): void {
    const recs = [...this.records.values()];
    this.records.clear();
    for (const rec of recs) {
      try { this.disarm(rec.current); } catch { /* kernel already gone */ }
    }
  }

  /** Drop the records without touching the kernel (its pending slices were already cleared). */
  clear(): void {
    this.records.clear();
  }

  /** Snapshot copy of the host half (creation order). */
  export(): SdkEveryTable {
    return { next: this.next, items: [...this.records.values()].map(r => ({ ...r })) };
  }

  /** Replace the host half with a captured one (snapshot restore; the kernel restores the queued slices). */
  replace(table: SdkEveryTable): void {
    this.records = new Map(table.items.map((r): [number, SdkEveryRecord] =>
      [r.pid, { pid: r.pid, interval: r.interval, hook: r.hook, current: r.current }]));
    this.next = table.next;
  }
}

/**
 * Event payload shape the PRIVATE `Script.Hook` DES action reads from the
 * event-queue data slot. Declared here so the private side and any host stay
 * on one contract without a private import.
 */
export interface ScriptHookEventData {
  /** Discriminator so foreign payloads are never misread. */
  readonly rvScriptHook: true;
  readonly hook: string;
  /** The dispatcher to call back into (the script component's host adapter). */
  readonly dispatcher: ScriptHookDispatcher;
  readonly mu?: ScriptMuRef | null;
  readonly data?: unknown;
}

/**
 * Continuous-kernel `SdkScheduler` over the shared `RVEventHeap`. `getNow`
 * supplies the kernel's virtual clock (the adapter's accumulated fixed-tick
 * time — NEVER wall clock). Dispatch happens wherever the heap is drained
 * (the owning adapter registers a heap listener that forwards to the
 * component's `ScriptHookDispatcher`).
 */
export function createHeapScheduler(heap: RVEventHeap, getNow: () => number): SdkScheduler {
  const everyTimers = new SdkEveryTimers(
    (intervalSec, pid) => heap.schedule(getNow() + intervalSec, RV_EVERY_HOOK, null, { pid }),
    eventId => { heap.cancel(eventId); },
  );
  return {
    in(delaySec, hook, mu, data): number {
      return heap.schedule(getNow() + delaySec, hook, mu ?? null, data);
    },
    at(timeSec, hook, mu, data): number {
      return heap.schedule(timeSec, hook, mu ?? null, data);
    },
    cancel(eventId: number): void {
      if (eventId < 0) { everyTimers.cancel(eventId); return; }
      heap.cancel(eventId);
    },
    every(intervalSec, hook): number {
      return everyTimers.add(intervalSec, hook);
    },
    everyTimers,
    get now(): number {
      return getNow();
    },
  };
}
