// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * sdk-conveyor-e2e.test.ts — plan-210 §9 phase 1b PROOF test (conveyor-like
 * JS): belt.run + sensor stop + downstream interlock as a pure script
 * component. The conveyor runs its belt while `Flow.Run` is on, publishes the
 * `Flow.Occupied` interop convention (root + per-port) and BLOCKS when a part
 * sits at the sensor while the downstream is occupied — resuming when it
 * frees. Also proves the Tier-1 MU surface (spawn/transfer/currentLoad,
 * mu.park/release) against the continuous flow backend.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { Object3D } from 'three';
import { RVScriptHost } from '../src/core/engine/rv-script-host';
import { createSdkComponent } from '../src/core/sdk/rv-component-sdk';
import { RVScriptComponentAdapter } from '../src/core/sdk/rv-script-component-adapter';
import { createSnapGraphPortsBackend } from '../src/core/sdk/rv-sdk-ports';
import { createLocalFlowBackend, type LocalFlowMu } from '../src/core/sdk/rv-sdk-flow';
import type { SdkBeltTarget, SdkEnvironment, SdkSensorTarget } from '../src/core/sdk/rv-sdk-self';

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

/** Conveyor-like script: belt + sensor + downstream interlock, §6 style. */
const CONVEYOR_CODE = `
function setup(self) {
  var belt = self.belt('Transport');
  var sensor = self.sensor('Sensor');
  if (!belt || !sensor) return self.disable('missing belt/sensor');

  self.signal('Flow.Run').set(true);
  self.setState('running');

  return {
    continuous: {
      fixedUpdate: function (dt) {
        var run = self.signal('Flow.Run').bool;
        // Interlock: a part AT the sensor may only leave when the downstream
        // can take it (per-port-then-root Flow.Occupied convention).
        var blocked = sensor.occupied && self.downstreamOccupied();
        belt.run(run && !blocked);
        self.setState(!run ? 'stopped' : blocked ? 'blocked' : 'running');

        // Publish MY occupancy for the upstream (root + per-port).
        self.signal('Flow.Occupied').set(sensor.occupied);
        var out = self.outputs()[0];
        if (out) out.setOccupied(sensor.occupied);
      },
    },
  };
}
`;

interface World {
  root: Object3D;
  signals: Map<string, boolean | number>;
  sensor: SdkSensorTarget & { fire(occ: boolean): void; occupied: boolean };
  belt: SdkBeltTarget & { running: boolean | null };
  states: string[];
  env(adapter: RVScriptComponentAdapter): SdkEnvironment;
  outPortId: string;
  mySnapId: string;
}

function buildWorld(): World {
  const root = new Object3D();
  root.name = 'ConvA';
  const transport = new Object3D();
  transport.name = 'Transport';
  root.add(transport);

  const convB = new Object3D();
  convB.name = 'ConvB';
  const aOutObj = new Object3D(); aOutObj.name = 'Snap-Out'; root.add(aOutObj);
  const bInObj = new Object3D(); bInObj.name = 'Snap-In'; convB.add(bInObj);
  const aOut = { id: 'a-out', object3D: aOutObj, flow: 'out' as const, pairedSnapId: 'b-in', ownerRoot: root };
  const bIn = { id: 'b-in', object3D: bInObj, flow: 'in' as const, pairedSnapId: 'a-out', ownerRoot: convB };
  const reg = {
    getByOwnerRoot: (r: Object3D) => (r === root ? [aOut] : [bIn]),
    getById: (id: string) => (id === 'a-out' ? aOut : id === 'b-in' ? bIn : undefined),
  };
  const snapHost = { getPlugin: (id: string) => (id === 'snap-point' ? { getRegistry: () => reg } : undefined) };

  const signals = new Map<string, boolean | number>();
  const subs = new Set<(occ: boolean) => void>();
  const sensor: World['sensor'] = {
    occupied: false,
    subscribe(cb) { subs.add(cb); return () => subs.delete(cb); },
    fire(occ: boolean) { this.occupied = occ; for (const cb of [...subs]) cb(occ); },
  };
  const belt: World['belt'] = {
    running: null,
    run(forward: boolean) { this.running = forward; },
    node: transport,
  };
  const states: string[] = [];

  return {
    root, signals, sensor, belt, states,
    outPortId: 'b-in',
    mySnapId: 'a-out',
    env(adapter: RVScriptComponentAdapter): SdkEnvironment {
      return {
        name: 'ConvA',
        path: 'Line1/ConvA',
        node: root,
        components: {
          sensor: (p) => (p === 'Sensor' ? sensor : null),
          belt: (p) => (p === 'Transport' ? belt : null),
        },
        signals: {
          get: (n) => signals.get(n),
          set: (n, v) => signals.set(n, v),
        },
        ports: createSnapGraphPortsBackend({
          viewer: snapHost,
          root,
          signals: { get: (n) => signals.get(n), set: (n, v) => signals.set(n, v) },
        }),
        scheduler: adapter.scheduler,
        onSetState: (s) => { if (states[states.length - 1] !== s) states.push(s); },
        log: () => {},
      };
    },
  };
}

function tick(adapter: RVScriptComponentAdapter, seconds: number): void {
  const n = Math.round(seconds / FIXED_DT);
  for (let i = 0; i < n; i++) adapter.tick(FIXED_DT);
}

describe('SDK phase 1b — conveyor-like JS (belt + sensor + downstream interlock)', () => {
  it('runs, blocks on downstream-occupied + part at sensor, resumes when freed', async () => {
    const host = await makeHost();
    const world = buildWorld();
    const adapter = new RVScriptComponentAdapter();
    const c = createSdkComponent(host, world.env(adapter), CONVEYOR_CODE, { callDeadlineMs: 500 });
    expect(c.ok).toBe(true);
    adapter.attach(c);

    // Free line → belt runs.
    tick(adapter, 0.1);
    expect(world.belt.running).toBe(true);
    expect(world.states).toEqual(['running']);

    // Downstream occupied but NO part at the sensor → keep feeding forward.
    world.signals.set('ConvB.Flow.Occupied', true);
    tick(adapter, 0.1);
    expect(world.belt.running).toBe(true);

    // Part reaches the sensor while downstream is occupied → STOP (interlock).
    world.sensor.fire(true);
    tick(adapter, 0.1);
    expect(world.belt.running).toBe(false);
    expect(world.states).toEqual(['running', 'blocked']);
    // The conveyor published its own occupancy (root + per-port).
    expect(world.signals.get('Flow.Occupied')).toBe(true);
    expect(world.signals.get(`Flow.Occupied@${world.mySnapId}`)).toBe(true);

    // Downstream frees → the belt resumes.
    world.signals.set('ConvB.Flow.Occupied', false);
    tick(adapter, 0.1);
    expect(world.belt.running).toBe(true);
    expect(world.states).toEqual(['running', 'blocked', 'running']);

    // Part left the sensor → occupancy cleared.
    world.sensor.fire(false);
    tick(adapter, 0.1);
    expect(world.signals.get('Flow.Occupied')).toBe(false);
    expect(world.signals.get(`Flow.Occupied@${world.mySnapId}`)).toBe(false);
    c.dispose();
  });

  it('per-port downstream interlock: root busy but this port opened → not blocked', async () => {
    const host = await makeHost();
    const world = buildWorld();
    const adapter = new RVScriptComponentAdapter();
    const c = createSdkComponent(host, world.env(adapter), CONVEYOR_CODE, { callDeadlineMs: 500 });
    adapter.attach(c);

    world.signals.set('ConvB.Flow.Occupied', true);
    world.signals.set(`ConvB.Flow.Occupied@${world.outPortId}`, false); // router opens THIS port
    world.sensor.fire(true);
    tick(adapter, 0.1);
    expect(world.belt.running).toBe(true); // per-port wins over root
    c.dispose();
  });

  it('Tier-1 MU surface: spawn/transfer/currentLoad + mu.park()/mu.release() (continuous flow backend)', async () => {
    const host = await makeHost();
    const world = buildWorld();
    const adapter = new RVScriptComponentAdapter();

    const parked: string[] = [];
    const transferred: Array<{ id: number; port: string | null }> = [];
    const flow = createLocalFlowBackend({
      muType: 'Box',
      onPark: (mu: LocalFlowMu) => parked.push(`park(${mu.id})`),
      onRelease: (mu: LocalFlowMu) => parked.push(`release(${mu.id})`),
      onTransfer: (mu, portId) => transferred.push({ id: mu.id, port: portId }),
    });
    const env = world.env(adapter);
    env.flow = flow;

    const MU_CODE = `
      function setup(self) {
        return {
          run: function () {
            var mu = self.spawn();
            var before = self.currentLoad;
            mu.park();
            var parkedFlag = self.mus[0].prop.__parked === true;
            mu.release();
            var out = self.outputs()[0];
            self.transfer(mu, out);
            return {
              id: mu.id, type: mu.type, before: before, parkedFlag: parkedFlag,
              after: self.currentLoad,
            };
          },
        };
      }
    `;
    const c = createSdkComponent(host, env, MU_CODE, { callDeadlineMs: 500 });
    expect(c.ok).toBe(true);
    adapter.attach(c);

    const r = c.callHandler('run');
    expect(r.ok).toBe(true);
    expect(r.value).toEqual({ id: 1, type: 'Box', before: 1, parkedFlag: true, after: 0 });
    expect(parked).toEqual(['park(1)', 'release(1)']);
    // transfer carried the REAL port id from the snap graph.
    expect(transferred).toEqual([{ id: 1, port: world.outPortId }]);
    expect(flow.held).toHaveLength(0);
    c.dispose();
  });
});
