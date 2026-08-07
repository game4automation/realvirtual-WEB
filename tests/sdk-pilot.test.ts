// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * sdk-pilot.test.ts — plan-210 §9 phase-1 pilot: a SIMPLE component (sink-like
 * processing gate, deliberately NOT the turntable) running end-to-end in the
 * continuous kernel through the real QuickJS VM:
 *
 *   sensor edge → state machine → drive command → `self.in()` timer →
 *   heap drain on the fixed tick → `des.on` hook → signals written.
 *
 * Also pins the §6b determinism contract: `self.random()` is seeded from the
 * component path (same path ⇒ same sequence) and `self.now` is virtual time
 * (advances only with ticks).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { Object3D } from 'three';
import { RVScriptHost } from '../src/core/engine/rv-script-host';
import { createSdkComponent } from '../src/core/sdk/rv-component-sdk';
import { RVScriptComponentAdapter } from '../src/core/sdk/rv-script-component-adapter';
import type { SdkDriveTarget, SdkEnvironment, SdkSensorTarget } from '../src/core/sdk/rv-sdk-self';

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

const FIXED_DT = 1 / 60;

/** The pilot component: a processing gate (sink-like). */
const PILOT_CODE = `
function setup(self) {
  var drive = self.drive('Gate/Drive');
  var gate = self.sensor('Gate/Sensor');
  if (!drive || !gate) return self.disable('missing references');

  var processed = 0;
  var pendingEvent = -1;
  self.setState('idle');

  gate.on(function (occ) {
    if (occ && self.state === 'idle') {
      self.setState('processing');
      drive.moveTo(90);
      // ProcessTime from rv_extras props, deterministic jitter from the
      // seeded RNG (no Math.random in the sandbox).
      var t = (self.prop.ProcessTime || 1) + self.random() * 0;
      pendingEvent = self.in(t, 'done', { id: processed + 1 });
    }
  });

  return {
    continuous: {},
    des: {
      on: function (hook, mu, data) {
        if (hook === 'done') {
          processed++;
          pendingEvent = -1;
          self.signal('Gate.Done').set(true);
          self.setSignals({ 'Gate.Processed': processed });
          drive.moveTo(0);
          self.setState('idle');
        }
      },
    },
    probe: function () {
      return { state: self.state, processed: processed, now: self.now, pending: pendingEvent };
    },
    cancelPending: function () {
      if (pendingEvent >= 0) { self.cancel(pendingEvent); pendingEvent = -1; self.setState('idle'); }
    },
    rand: function () { return [self.random(), self.random(), self.random()]; },
  };
}
`;

function makeWorld() {
  const calls: string[] = [];
  const drive: SdkDriveTarget = {
    currentPosition: 0,
    currentSpeed: 0,
    targetSpeed: 100,
    isAtTarget: true,
    jogForward: false,
    jogBackward: false,
    startMove(destination?: number) { calls.push(`moveTo(${destination})`); },
    stop() { calls.push('stop'); },
  };
  const subs = new Set<(occ: boolean) => void>();
  const sensor: SdkSensorTarget & { fire(occ: boolean): void } = {
    occupied: false,
    subscribe(cb) { subs.add(cb); return () => subs.delete(cb); },
    fire(occ: boolean) { subs.forEach((cb) => cb(occ)); },
  };
  const signals = new Map<string, boolean | number>();
  const states: string[] = [];
  return { calls, drive, sensor, signals, states };
}

function makeEnv(world: ReturnType<typeof makeWorld>, adapter: RVScriptComponentAdapter, path = 'Line1/Gate'): SdkEnvironment {
  const node = new Object3D();
  node.name = 'Gate';
  return {
    name: 'Gate',
    path,
    node,
    props: { ProcessTime: 1 },
    components: {
      drive: (p) => (p === 'Gate/Drive' ? world.drive : null),
      sensor: (p) => (p === 'Gate/Sensor' ? world.sensor : null),
    },
    signals: {
      get: (n) => world.signals.get(n),
      set: (n, v) => world.signals.set(n, v),
    },
    scheduler: adapter.scheduler,
    onSetState: (s) => world.states.push(s),
    log: () => {},
  };
}

function tickSeconds(adapter: RVScriptComponentAdapter, seconds: number): void {
  const n = Math.round(seconds / FIXED_DT);
  for (let i = 0; i < n; i++) adapter.tick(FIXED_DT);
}

describe('SDK pilot — continuous end-to-end', () => {
  it('sensor edge → drive command → self.in timer fires on the tick drain → signals set', async () => {
    const host = await makeHost();
    const world = makeWorld();
    const adapter = new RVScriptComponentAdapter();
    const c = createSdkComponent(host, makeEnv(world, adapter), PILOT_CODE, { callDeadlineMs: 200 });
    expect(c.ok).toBe(true);
    adapter.attach(c);

    // Idle at t=0.
    let probe = c.callHandler('probe');
    expect(probe.ok && probe.value).toMatchObject({ state: 'idle', processed: 0, now: 0 });

    // Part arrives → processing starts, drive commanded, timer pending.
    world.sensor.fire(true);
    probe = c.callHandler('probe');
    expect(probe.ok && (probe.value as { state: string }).state).toBe('processing');
    expect(world.calls).toEqual(['moveTo(90)']);
    expect(world.signals.has('Gate.Done')).toBe(false);

    // 0.5 s: not due yet (ProcessTime = 1 s).
    tickSeconds(adapter, 0.5);
    probe = c.callHandler('probe');
    expect(probe.ok && (probe.value as { state: string }).state).toBe('processing');

    // Cross 1.0 s: the heap drain fires 'done' → des.on runs in the VM.
    tickSeconds(adapter, 0.6);
    probe = c.callHandler('probe');
    expect(probe.ok && probe.value).toMatchObject({ state: 'idle', processed: 1 });
    expect(world.signals.get('Gate.Done')).toBe(true);
    expect(world.signals.get('Gate.Processed')).toBe(1);
    expect(world.calls).toEqual(['moveTo(90)', 'moveTo(0)']);
    expect(world.states).toEqual(['idle', 'processing', 'idle']);

    // Second part → second cycle works identically.
    world.sensor.fire(true);
    tickSeconds(adapter, 1.1);
    probe = c.callHandler('probe');
    expect(probe.ok && probe.value).toMatchObject({ processed: 2 });
    expect(world.signals.get('Gate.Processed')).toBe(2);
    c.dispose();
  });

  it('self.cancel prevents the pending hook from firing', async () => {
    const host = await makeHost();
    const world = makeWorld();
    const adapter = new RVScriptComponentAdapter();
    const c = createSdkComponent(host, makeEnv(world, adapter), PILOT_CODE, { callDeadlineMs: 200 });
    adapter.attach(c);

    world.sensor.fire(true);
    tickSeconds(adapter, 0.2);
    expect(c.callHandler('cancelPending').ok).toBe(true);
    tickSeconds(adapter, 2.0);
    const probe = c.callHandler('probe');
    expect(probe.ok && probe.value).toMatchObject({ state: 'idle', processed: 0 });
    expect(world.signals.has('Gate.Done')).toBe(false);
    c.dispose();
  });

  it('self.now is virtual time — advances only with ticks', async () => {
    const host = await makeHost();
    const world = makeWorld();
    const adapter = new RVScriptComponentAdapter();
    const c = createSdkComponent(host, makeEnv(world, adapter), PILOT_CODE, { callDeadlineMs: 200 });
    adapter.attach(c);
    tickSeconds(adapter, 1.0);
    const probe = c.callHandler('probe');
    expect(probe.ok && (probe.value as { now: number }).now).toBeCloseTo(1.0, 9);
    c.dispose();
  });

  it('self.random() is deterministic: same path ⇒ same sequence, different path ⇒ different', async () => {
    const host = await makeHost();
    const mk = (path: string) => {
      const world = makeWorld();
      const adapter = new RVScriptComponentAdapter();
      const c = createSdkComponent(host, makeEnv(world, adapter, path), PILOT_CODE, { callDeadlineMs: 200 });
      adapter.attach(c);
      return c;
    };
    const a = mk('Line1/Gate');
    const b = mk('Line1/Gate');
    const other = mk('Line2/OtherGate');
    const ra = a.callHandler('rand');
    const rb = b.callHandler('rand');
    const ro = other.callHandler('rand');
    expect(ra.ok && rb.ok && ro.ok).toBe(true);
    const va = (ra as { value?: number[] }).value!;
    const vb = (rb as { value?: number[] }).value!;
    const vo = (ro as { value?: number[] }).value!;
    expect(va).toEqual(vb);
    expect(va).not.toEqual(vo);
    for (const x of va) expect(x >= 0 && x < 1).toBe(true);
    a.dispose(); b.dispose(); other.dispose();
  });

  it('adapter.reset() clears pending timers and zeroes the clock', async () => {
    const host = await makeHost();
    const world = makeWorld();
    const adapter = new RVScriptComponentAdapter();
    const c = createSdkComponent(host, makeEnv(world, adapter), PILOT_CODE, { callDeadlineMs: 200 });
    adapter.attach(c);
    world.sensor.fire(true);
    tickSeconds(adapter, 0.5);
    adapter.reset();
    tickSeconds(adapter, 2.0);
    const probe = c.callHandler('probe');
    expect(probe.ok && probe.value).toMatchObject({ processed: 0 });
    expect(adapter.now).toBeCloseTo(2.0, 9);
    c.dispose();
  });
});
