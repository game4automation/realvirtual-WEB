// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-des-script-hook.ts — the generic `Script.Hook` named action (plan-210
 * §6b, phase 1 — private half of the ScriptHook cut).
 *
 * Script components (`WebComponent` JS in rv_extras) schedule timers with
 * FREE-FORM runtime hook names — they cannot pre-register one named action
 * per hook like the statically-declared `def.des.*` material-flow hooks
 * (des-hook-adapter.ts). Instead there is exactly ONE generic action:
 * `'Script.Hook'`. The event's data payload (`ScriptHookEventData`, defined
 * PUBLICLY in rv-script-hook.ts) carries the hook string, the optional MU ref
 * and the `ScriptHookDispatcher` to call back — the dispatch wrapper simply
 * routes the event back through that public contract into the component's VM
 * (`des.on(hook, mu, data)` via the adapter).
 *
 * Deliberately minimal-invasive: no change to the named-action table, the
 * queue or the manager — one lazily-registered action plus a scheduler
 * factory that mirrors `DESRunner.makeScheduler` semantics (`in/at/cancel/
 * now`) with the payload always allocated (script events are NOT the GC-free
 * hot path — accepted per §6b "ScriptHook-Marshalling").
 */

import {
  RV_EVERY_HOOK,
  SdkEveryTimers,
  type SdkScheduler,
  type ScriptHookDispatcher,
  type ScriptHookEventData,
  type ScriptMuRef,
} from '../../core/sdk/rv-script-hook';
import { registerAction, ACTION_INDEX } from './rv-des-named-actions';
import type { ActionContext } from './rv-des-event';
import type { DESManager } from './rv-des-manager';

/** The single generic named action all script-component hooks ride on. */
export const SCRIPT_HOOK_ACTION = 'Script.Hook';

/** Script events carry no engine entity — the dispatcher rides the payload. */
const SCRIPT_ENTITY_ID = -1;
/** Script MU refs are value payload, never queue-registered ids. */
const SCRIPT_NO_MU = -1;

/**
 * Register (once) and return the integer index of the generic `Script.Hook`
 * action. The wrapper reads the `ScriptHookEventData` payload and calls back
 * through the PUBLIC `ScriptHookDispatcher` contract — it never touches
 * manager entity/MU tables (script components live outside them).
 */
export function ensureScriptHookAction(): number {
  let idx = ACTION_INDEX.get(SCRIPT_HOOK_ACTION);
  if (idx === undefined) {
    idx = registerAction(SCRIPT_HOOK_ACTION, (ctx: ActionContext) => {
      const payload = ctx.data as ScriptHookEventData | null;
      if (!payload || payload.rvScriptHook !== true) return;
      payload.dispatcher.dispatchScriptHook(payload.hook, payload.mu ?? null, payload.data);
    }, { owner: 'component', payload: value => {
      const p = value as { hook?: unknown; desId?: unknown; mu?: unknown; data?: unknown } | null;
      return p && typeof p.hook === 'string' && typeof p.desId === 'string'
        && (p.mu === null || typeof p.mu === 'object' && p.mu !== null
          && Number.isSafeInteger((p.mu as { id?: number }).id))
        && p.data !== undefined ? [] : ['invalid script hook payload'];
    } });
  }
  return idx;
}

/**
 * Build the DES-side `SdkScheduler` for ONE script component: `self.in/at`
 * schedule `Script.Hook` events on the manager's queue, `now` is the DES
 * clock. Pass the component's kernel adapter (`RVScriptComponentAdapter`) as
 * the `dispatcher` — due events call back through it into the VM.
 */
export function makeScriptHookScheduler(
  manager: DESManager,
  dispatcher: ScriptHookDispatcher,
): SdkScheduler {
  const actionIdx = ensureScriptHookAction();

  const payloadFor = (
    hook: string,
    mu: ScriptMuRef | null | undefined,
    data: unknown,
  ): ScriptHookEventData => ({
    rvScriptHook: true,
    hook,
    dispatcher,
    mu: mu ?? null,
    data,
  });

  const cancelOwn = (eventId: number): void => {
    // plan-2212 review #1: only an event THIS script still has pending. Queue
    // ids restart with every reset, so a disposed script's stale timer id may
    // name a warm-up / checkpoint event or another script's timer of the new
    // run - cancelling by bare id would delete that foreign event.
    const pending = manager.eventDataOf(eventId) as Partial<ScriptHookEventData> | undefined;
    if (!pending || pending.rvScriptHook !== true || pending.dispatcher !== dispatcher) return;
    manager.cancelEvent(eventId);
  };
  // plan-2212 Phase 4c: recurring timers live HERE (host side). A slice is the
  // same `Script.Hook` event the guest used to schedule (`__rv.every`, `{ pid }`),
  // so the queue and its snapshot format are unchanged.
  const everyTimers = new SdkEveryTimers(
    (intervalSec, pid) => manager.scheduleInByIndex(
      intervalSec, actionIdx, SCRIPT_ENTITY_ID, SCRIPT_NO_MU, 0, payloadFor(RV_EVERY_HOOK, null, { pid })),
    cancelOwn,
  );

  return {
    in(delaySec, hook, mu, data): number {
      return manager.scheduleInByIndex(
        delaySec, actionIdx, SCRIPT_ENTITY_ID, SCRIPT_NO_MU, 0, payloadFor(hook, mu, data));
    },
    every(intervalSec, hook): number {
      return everyTimers.add(intervalSec, hook);
    },
    everyTimers,
    at(timeSec, hook, mu, data): number {
      return manager.scheduleEventByIndex(
        timeSec, actionIdx, SCRIPT_ENTITY_ID, SCRIPT_NO_MU, 0, payloadFor(hook, mu, data));
    },
    cancel(eventId: number): void {
      // Negative = an every timer of THIS scheduler only (owner-scoped by construction).
      if (eventId < 0) { everyTimers.cancel(eventId); return; }
      cancelOwn(eventId);
    },
    get now(): number {
      return manager.currentTime;
    },
  };
}
