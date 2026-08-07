// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * script-hook-action.test.ts — plan-210 §6b ScriptHook public/private cut.
 *
 * The PRIVATE generic `Script.Hook` named action must route scheduled script
 * events back through the PUBLIC `ScriptHookDispatcher` contract:
 * `makeScriptHookScheduler(manager, dispatcher)` implements the SAME
 * `SdkScheduler` surface the continuous heap scheduler implements — a script
 * component never knows which kernel serves its timers.
 *
 * Runs only in the private build (imports `@rv-private/plugins/des/*`).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { DESManager, DESMode } from '@rv-private/plugins/des/rv-des-manager';
import {
  ensureScriptHookAction,
  makeScriptHookScheduler,
  SCRIPT_HOOK_ACTION,
} from '@rv-private/plugins/des/rv-des-script-hook';
import { ACTION_INDEX } from '@rv-private/plugins/des/rv-des-named-actions';
import type { ScriptHookDispatcher, ScriptMuRef } from '../../src/core/sdk/rv-script-hook';

interface Dispatched {
  hook: string;
  mu: ScriptMuRef | null;
  data: unknown;
  at: number;
}

function makeDispatcher(manager: DESManager): ScriptHookDispatcher & { events: Dispatched[] } {
  const events: Dispatched[] = [];
  return {
    events,
    dispatchScriptHook(hook, mu, data) {
      events.push({ hook, mu, data, at: manager.currentTime });
    },
  };
}

/** Advance sim time to (at least) `target` seconds in fixed 0.1 s ticks. */
function advanceTo(manager: DESManager, target: number): void {
  let guard = 0;
  while (manager.currentTime < target && guard++ < 100000) {
    manager.processAnimated(0.1);
  }
}

describe('Script.Hook — generic named action (private) + public dispatcher contract', () => {
  let manager: DESManager;

  beforeEach(() => {
    manager = new DESManager();
    manager.mode = DESMode.Animated;
    manager.duration = 100000;
  });

  it('registers the action exactly once (idempotent)', () => {
    const idx = ensureScriptHookAction();
    expect(ensureScriptHookAction()).toBe(idx);
    expect(ACTION_INDEX.get(SCRIPT_HOOK_ACTION)).toBe(idx);
  });

  it('self.in-style scheduling dispatches the hook string back through the dispatcher at DES time', () => {
    const dispatcher = makeDispatcher(manager);
    const scheduler = makeScriptHookScheduler(manager, dispatcher);

    const mu: ScriptMuRef = { id: 7, prop: { kind: 'pallet' } };
    scheduler.in(2.5, 'rotated', mu, { angle: 90 });
    scheduler.in(1.0, 'first');

    advanceTo(manager, 5);
    expect(dispatcher.events.map((e) => e.hook)).toEqual(['first', 'rotated']);
    expect(dispatcher.events[0].at).toBeCloseTo(1.0, 6);
    expect(dispatcher.events[1].at).toBeCloseTo(2.5, 6);
    expect(dispatcher.events[1].mu).toEqual(mu);
    expect(dispatcher.events[1].data).toEqual({ angle: 90 });
    expect(dispatcher.events[0].mu).toBeNull();
  });

  it('at() schedules on absolute DES time; now reads the DES clock', () => {
    const dispatcher = makeDispatcher(manager);
    const scheduler = makeScriptHookScheduler(manager, dispatcher);
    expect(scheduler.now).toBe(0);
    scheduler.at(3.0, 'absolute');
    advanceTo(manager, 4);
    expect(dispatcher.events).toHaveLength(1);
    expect(dispatcher.events[0].at).toBeCloseTo(3.0, 6);
    expect(scheduler.now).toBeGreaterThanOrEqual(3.0);
  });

  it('cancel prevents dispatch', () => {
    const dispatcher = makeDispatcher(manager);
    const scheduler = makeScriptHookScheduler(manager, dispatcher);
    const id = scheduler.in(1.0, 'never');
    scheduler.cancel(id);
    advanceTo(manager, 3);
    expect(dispatcher.events).toEqual([]);
  });

  it('two script components dispatch to THEIR OWN dispatcher (payload-carried routing)', () => {
    const a = makeDispatcher(manager);
    const b = makeDispatcher(manager);
    const schedA = makeScriptHookScheduler(manager, a);
    const schedB = makeScriptHookScheduler(manager, b);
    schedA.in(1, 'fromA');
    schedB.in(2, 'fromB');
    advanceTo(manager, 3);
    expect(a.events.map((e) => e.hook)).toEqual(['fromA']);
    expect(b.events.map((e) => e.hook)).toEqual(['fromB']);
  });

  it('foreign payloads on the action are ignored (rvScriptHook discriminator)', () => {
    const idx = ensureScriptHookAction();
    // Schedule the action with a non-ScriptHook payload directly.
    manager.scheduleInByIndex(0.5, idx, -1, -1, 0, { something: 'else' });
    expect(() => advanceTo(manager, 1)).not.toThrow();
  });
});
