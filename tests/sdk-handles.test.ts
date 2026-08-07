// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * sdk-handles.test.ts — plan-210 §6 Tier-0 component handles + null-safety.
 *
 * End-to-end through the real QuickJS VM: guest handle objects call the
 * single `__rvHostCall` bridge; a missing reference resolves to `null` and a
 * `self.disable()` in setup only disables THIS component — sibling
 * components on the shared runtime keep running (setup-failure isolation).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { Object3D } from 'three';
import { RVScriptHost } from '../src/core/engine/rv-script-host';
import { createSdkComponent } from '../src/core/sdk/rv-component-sdk';
import type { SdkDriveTarget, SdkEnvironment, SdkSensorTarget } from '../src/core/sdk/rv-sdk-self';
import type { SdkScheduler } from '../src/core/sdk/rv-script-hook';

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

const nullScheduler: SdkScheduler = { in: () => 0, at: () => 0, cancel: () => {}, now: 0 };

function makeFakeDrive(): SdkDriveTarget & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    currentPosition: 12.5,
    currentSpeed: 0,
    targetSpeed: 100,
    get isAtTarget() { return true; },
    jogForward: false,
    jogBackward: false,
    startMove(destination?: number) { calls.push(`startMove(${destination})`); },
    stop() { calls.push('stop()'); },
    node: (() => { const n = new Object3D(); n.name = 'Drive'; return n; })(),
  };
}

function makeFakeSensor(): SdkSensorTarget & { fire(occ: boolean): void } {
  const subs = new Set<(occ: boolean) => void>();
  let occupied = false;
  return {
    get occupied() { return occupied; },
    mode: 'Collision',
    subscribe(cb) { subs.add(cb); return () => subs.delete(cb); },
    fire(occ: boolean) { occupied = occ; subs.forEach((cb) => cb(occ)); },
  };
}

function makeEnv(overrides: Partial<SdkEnvironment> = {}): SdkEnvironment {
  const node = new Object3D();
  node.name = 'Comp';
  return {
    name: 'Comp',
    path: 'Line1/Comp',
    node,
    scheduler: nullScheduler,
    log: () => {},
    ...overrides,
  };
}

describe('SDK handles — resolution + null-safety', () => {
  it('self.drive("missing") === null; self.disable() only disables THIS component', async () => {
    const host = await makeHost();
    const disabledEnv = makeEnv({ components: {} });
    const broken = createSdkComponent(host, disabledEnv, `
      function setup(self) {
        var d = self.drive('does/not/exist');
        if (d === null) return self.disable('missing references');
        return { continuous: { fixedUpdate: function () {} } };
      }
    `, { callDeadlineMs: 200 });
    expect(broken.ok).toBe(true); // setup ran; disable is a state, not a failure
    expect(broken.ctx.isDisabled).toBe(true);
    expect(broken.ctx.disabledReason).toBe('missing references');

    // Sibling component on the SAME host keeps working (scene continues).
    const healthy = createSdkComponent(host, makeEnv(), `
      function setup(self) {
        var n = 0;
        return { continuous: { fixedUpdate: function (dt) { n += dt; return n; } } };
      }
    `, { callDeadlineMs: 200 });
    expect(healthy.ok).toBe(true);
    const r = healthy.callHandler('continuous.fixedUpdate', 0.5);
    expect(r.ok && r.value).toBe(0.5);
    broken.dispose();
    healthy.dispose();
  });

  it('a setup() runtime error disables the component with a structured error', async () => {
    const host = await makeHost();
    const c = createSdkComponent(host, makeEnv(), `
      function setup(self) { throw new Error('boom in setup'); }
    `, { callDeadlineMs: 200 });
    expect(c.ok).toBe(false);
    expect(c.error?.message).toMatch(/boom in setup/);
    expect(c.ctx.isDisabled).toBe(true);
    c.dispose();
  });

  it('drive handle: value reads + methods route to the host target', async () => {
    const host = await makeHost();
    const drive = makeFakeDrive();
    const env = makeEnv({ components: { drive: (p) => (p === 'Line1/Drive' ? drive : null) } });
    const c = createSdkComponent(host, env, `
      function setup(self) {
        var d = self.drive('Line1/Drive');
        return {
          probe: function () {
            return { pos: d.position, atTarget: d.isAtTarget, moving: d.isMoving, ts: d.targetSpeed };
          },
          act: function () {
            d.moveTo(90);
            d.targetSpeed = 250;
            d.jog(true);
            d.stop();
            d.startMove();
          },
        };
      }
    `, { callDeadlineMs: 200 });
    expect(c.ok).toBe(true);
    const probe = c.callHandler('probe');
    expect(probe.ok && probe.value).toEqual({ pos: 12.5, atTarget: true, moving: false, ts: 100 });
    expect(c.callHandler('act').ok).toBe(true);
    expect(drive.calls).toEqual(['startMove(90)', 'stop()', 'startMove(undefined)']);
    expect(drive.targetSpeed).toBe(250);
    expect(drive.jogForward).toBe(false); // stop() cleared the jog
    c.dispose();
  });

  it('sensor handle: occupied read + on() fan-out into the VM (both kernels share this path)', async () => {
    const host = await makeHost();
    const sensor = makeFakeSensor();
    const env = makeEnv({ components: { sensor: () => sensor } });
    const c = createSdkComponent(host, env, `
      function setup(self) {
        var s = self.sensor('any');
        var edges = [];
        var off = s.on(function (occ) { edges.push(occ); });
        return {
          edges: function () { return edges; },
          occupied: function () { return s.occupied; },
          unsubscribe: function () { off(); },
        };
      }
    `, { callDeadlineMs: 200 });
    expect(c.ok).toBe(true);
    sensor.fire(true);
    sensor.fire(false);
    let r = c.callHandler('edges');
    expect(r.ok && r.value).toEqual([true, false]);
    expect((c.callHandler('occupied') as { value?: unknown }).value).toBe(false);
    // Unsubscribe stops the fan-out.
    expect(c.callHandler('unsubscribe').ok).toBe(true);
    sensor.fire(true);
    r = c.callHandler('edges');
    expect(r.ok && r.value).toEqual([true, false]);
    c.dispose();
  });

  it('signal handles: bool/num coercion, set, setSignals batch and on()', async () => {
    const host = await makeHost();
    const values = new Map<string, boolean | number>();
    const subs = new Map<string, Set<(v: boolean | number) => void>>();
    const env = makeEnv({
      signals: {
        get: (n) => values.get(n),
        set: (n, v) => {
          values.set(n, v);
          subs.get(n)?.forEach((cb) => cb(v));
        },
        subscribe: (n, cb) => {
          let s = subs.get(n);
          if (!s) { s = new Set(); subs.set(n, s); }
          s.add(cb);
          return () => s!.delete(cb);
        },
      },
    });
    values.set('Flow.Run', true);
    values.set('Flow.Count', 3.7);
    const c = createSdkComponent(host, env, `
      function setup(self) {
        var seen = [];
        self.signal('Flow.Ack').on(function (v) { seen.push(v); });
        return {
          read: function () {
            var run = self.signal('Flow.Run');
            var count = self.signal('Flow.Count');
            return { bool: run.bool, num: count.num, int: count.int, boolAsNum: run.num };
          },
          write: function () {
            self.signal('Flow.Done').set(true);
            self.setSignals({ 'A': 1, 'B': false });
          },
          seen: function () { return seen; },
        };
      }
    `, { callDeadlineMs: 200 });
    expect(c.ok).toBe(true);
    const read = c.callHandler('read');
    expect(read.ok && read.value).toEqual({ bool: true, num: 3.7, int: 3, boolAsNum: 1 });
    expect(c.callHandler('write').ok).toBe(true);
    expect(values.get('Flow.Done')).toBe(true);
    expect(values.get('A')).toBe(1);
    expect(values.get('B')).toBe(false);
    env.signals!.set('Flow.Ack', 5);
    const seen = c.callHandler('seen');
    expect(seen.ok && seen.value).toEqual([5]);
    c.dispose();
  });

  it('find(type, path) resolves through the same kind resolvers; unknown types are null', async () => {
    const host = await makeHost();
    const drive = makeFakeDrive();
    const env = makeEnv({ components: { drive: () => drive } });
    const c = createSdkComponent(host, env, `
      function setup(self) {
        return {
          viaFind: function () {
            var d = self.find('Drive', 'x');
            return d ? d.position : null;
          },
          unknown: function () { return self.find('Frobnicator', 'x'); },
        };
      }
    `, { callDeadlineMs: 200 });
    expect((c.callHandler('viaFind') as { value?: unknown }).value).toBe(12.5);
    expect((c.callHandler('unknown') as { value?: unknown }).value).toBeNull();
    c.dispose();
  });

  it('drive handle node is a NodeHandle with POJO world reads', async () => {
    const host = await makeHost();
    const drive = makeFakeDrive();
    drive.node!.position.set(2, 0, 0);
    const env = makeEnv({ components: { drive: () => drive } });
    env.node.add(drive.node!);
    const c = createSdkComponent(host, env, `
      function setup(self) {
        var d = self.drive('x');
        return {
          nodeInfo: function () {
            var p = d.node.worldPosition();
            return { name: d.node.name, x: p.x, isPlain: typeof p === 'object' };
          },
        };
      }
    `, { callDeadlineMs: 200 });
    const r = c.callHandler('nodeInfo');
    expect(r.ok && r.value).toEqual({ name: 'Drive', x: 2, isPlain: true });
    c.dispose();
  });
});
