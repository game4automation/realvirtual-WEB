// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * reload-teardown.test.ts — plan-210 §10 ghosting guard: after dispose /
 * hot-reload the OLD instance must be completely inert —
 *
 *  - no sensor callbacks reach it (host subscriptions unsubscribed),
 *  - no signal writes come from it,
 *  - a pending `self.in` event does NOT fire (auto-cancelled on dispose),
 *  - VM handle count is flat (0 after dispose — retainedHandleCount from
 *    phase 0 as the leak probe),
 *  - deferred notifications raised while the VM was busy are delivered at
 *    the next safe point, never re-entrantly (phase-1 open point).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { RVScriptHost } from '../src/core/engine/rv-script-host';
import { makeWorld, makeRegistry, makeNode, meta, tickSeconds, FIXED_DT } from './_web-component-kit';

const hosts: RVScriptHost[] = [];
async function makeHost(): Promise<RVScriptHost> {
  const host = await RVScriptHost.create();
  hosts.push(host);
  return host;
}
afterEach(() => {
  for (const h of hosts) h.dispose();
  hosts.length = 0;
});

const PATH = 'Line1/Gate';

/** Subscribes sensor + signal, schedules a timer — the full ghost surface. */
const GHOST_CODE = `
function setup(self) {
  var gate = self.sensor('Gate/Sensor');
  gate.on(function (occ) { self.signal('Ghost.Sensor').set(true); });
  self.signal('Run').on(function (v) { self.signal('Ghost.Signal').set(true); });
  self.in(5, 'boom');
  return {
    des: { on: function (hook) { if (hook === 'boom') self.signal('Ghost.Timer').set(true); } },
  };
}
`;

describe('hot-reload teardown — no ghosts (§10)', () => {
  it('after reload: old sensor/signal subscriptions are gone, pending self.in never fires, handles flat', async () => {
    const host = await makeHost();
    const world = makeWorld();
    const registry = makeRegistry(host, world);
    registry.create(PATH, makeNode('Gate'), meta(GHOST_CODE));

    const old = registry.get(PATH)!;
    const oldComponent = old.component!;
    const oldBridge = oldComponent.bridge;
    expect(world.sensor.subCount).toBe(1);
    expect(world.signalSubs.get('Run')?.size).toBe(1);
    expect(oldBridge.pendingTimerCount).toBe(1);
    expect(oldBridge.subscriptionCount).toBe(2);
    expect(oldComponent.ctx.retainedHandleCount).toBeGreaterThan(0);

    // Hot-reload to inert code — the auto-teardown register must clean up.
    registry.reload(PATH, `function setup(self) { return {}; }`);

    // Host-side registrations of the old instance are released.
    expect(world.sensor.subCount).toBe(0);
    expect(world.signalSubs.get('Run')?.size ?? 0).toBe(0);
    expect(oldBridge.pendingTimerCount).toBe(0);
    expect(oldBridge.subscriptionCount).toBe(0);
    // VM handles: flat after dispose (leak probe from phase 0).
    expect(oldComponent.ctx.retainedHandleCount).toBe(0);
    expect(oldComponent.ctx.isDisposed).toBe(true);
    expect(old.isDisposed).toBe(true);

    // Firing the old triggers produces NO signal writes from the old instance.
    world.sensor.fire(true);
    world.setSignal('Run', true);
    tickSeconds(registry, 6);   // well past the 5 s pending timer
    expect(world.signals.has('Ghost.Sensor')).toBe(false);
    expect(world.signals.has('Ghost.Signal')).toBe(false);
    expect(world.signals.has('Ghost.Timer')).toBe(false);
    registry.dispose();
  });

  it('pending timer is cancelled in the heap itself (no host-side listener sees it)', async () => {
    const host = await makeHost();
    const world = makeWorld();
    const registry = makeRegistry(host, world);
    registry.create(PATH, makeNode('Gate'), meta(GHOST_CODE));

    const old = registry.get(PATH)!;
    const heapEvents: string[] = [];
    old.adapter!.heap.addListener((ev) => heapEvents.push(ev.hook));

    // Dispose ONLY the component (bridge cancel path) — then drain the OLD
    // heap directly past the due time: the cancelled event must not reach
    // ANY listener (tombstoned), not merely be ignored by the dead VM.
    old.component!.dispose();
    old.adapter!.heap.drainUntil(10);
    expect(heapEvents).toEqual([]);
    registry.dispose();
  });

  it('registry dispose tears down every instance (model clear path)', async () => {
    const host = await makeHost();
    const world = makeWorld();
    const registry = makeRegistry(host, world);
    registry.create(PATH, makeNode('Gate'), meta(GHOST_CODE));
    registry.create('Line1/Gate2', makeNode('Gate2'), meta(GHOST_CODE));
    expect(host.contextCount).toBe(2);
    expect(world.sensor.subCount).toBe(2);

    registry.dispose();
    expect(host.contextCount).toBe(0);
    expect(world.sensor.subCount).toBe(0);
    expect(registry.size).toBe(0);
  });

  it('notify re-entrancy: a signal written from inside a guest call is delivered deferred, not nested', async () => {
    const host = await makeHost();
    const world = makeWorld();
    const registry = makeRegistry(host, world);
    // The script subscribes to a signal AND writes that signal from inside
    // fixedUpdate — without the defer this would nest a guest call while the
    // VM is executing (shared deadline bookkeeping corruption).
    registry.create(PATH, makeNode('Gate'), meta(`
      function setup(self) {
        var echoes = 0;
        var wrote = false;
        self.signal('Echo').on(function (v) { echoes++; });
        return {
          continuous: { fixedUpdate: function (dt) {
            if (!wrote) { wrote = true; self.signal('Echo').set(1); }
          } },
          probe: function () { return echoes; },
        };
      }
    `));

    const inst = registry.get(PATH)!;
    registry.tickAll(FIXED_DT);   // write happens here; delivery is deferred + flushed post-tick
    expect(inst.ok).toBe(true);   // no poison/disable from a nested call
    const probe = inst.component!.callHandler('probe');
    expect(probe.ok && probe.value).toBe(1);
    registry.dispose();
  });
});
