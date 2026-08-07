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
 *      * the private DES runner's `makeScriptHookScheduler()` — schedules a
 *        generic `Script.Hook` named action on the DES event queue whose
 *        wrapper calls BACK through `ScriptHookDispatcher` into the VM.
 *  - PRIVATE (…-Private~/src/plugins/des/rv-des-script-hook.ts): the generic
 *    `ScriptHook` action type (registerAction pattern) — the ONLY private
 *    piece, minimal by design.
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
 *  - `RV_EVERY_HOOK`: recurring `self.every()` slice; the guest re-schedules
 *    the next slice and calls the user hook.
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
  /** Cancel a pending event by id (no-op for unknown/fired ids). */
  cancel(eventId: number): void;
  /** Current virtual sim time in seconds. */
  readonly now: number;
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
  return {
    in(delaySec, hook, mu, data): number {
      return heap.schedule(getNow() + delaySec, hook, mu ?? null, data);
    },
    at(timeSec, hook, mu, data): number {
      return heap.schedule(timeSec, hook, mu ?? null, data);
    },
    cancel(eventId: number): void {
      heap.cancel(eventId);
    },
    get now(): number {
      return getNow();
    },
  };
}
