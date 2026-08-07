// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * script-station.test.ts — plan-210 phase 1b DES-station wiring: a script
 * component participates in the DES kernel as a full station through the
 * public ScriptHook contract —
 *
 *   - `RVScriptComponentAdapter` in DES mode takes the PRIVATE
 *     `makeScriptHookScheduler` (Script.Hook named action on the DES queue),
 *   - the runner-facing station dispatch (`stationCanAccept` /
 *     `stationOnAccept` / `stationOnDownstreamReady`) calls the script's
 *     `des.*` handlers with hydrated MU/Port handles,
 *   - the §6-appendix Turntable DES block runs FOR REAL: accept → timed
 *     rotation on the DES clock → `transfer(mu, selectedOutput)`.
 *
 * Runs only in the private build (imports `@rv-private/plugins/des/*`).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Object3D } from 'three';
import { DESManager, DESMode } from '@rv-private/plugins/des/rv-des-manager';
import { makeScriptHookScheduler } from '@rv-private/plugins/des/rv-des-script-hook';
import { RVScriptHost } from '../../src/core/engine/rv-script-host';
import { createSdkComponent } from '../../src/core/sdk/rv-component-sdk';
import { RVScriptComponentAdapter } from '../../src/core/sdk/rv-script-component-adapter';
import { createSnapGraphPortsBackend } from '../../src/core/sdk/rv-sdk-ports';
import type { SdkEnvironment, SdkFlowBackend } from '../../src/core/sdk/rv-sdk-self';

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

/** §6-appendix Turntable — DES block is what matters here (same code as the
 *  continuous e2e; ONE handler set serves both kernels). */
const TURNTABLE_CODE = `
function setup(self) {
  const V = self.vec3, drive = self.drive('Drive-Rot-Y'), sensor = self.sensor('Sensor'), belt = self.belt('Transport');
  if (!drive) return self.disable('no rotary drive');

  const axis = V.normalize(drive.node.worldDirection(V(0, 1, 0)));
  const ref  = Math.abs(axis.x) > 0.9 ? V(0, 0, 1) : V(1, 0, 0);
  const u    = V.normalize(V.cross(axis, ref));
  const vAx  = V.cross(axis, u);
  const angleToPort = (port) => {
    const dir = V.normalize(V.sub(port.node.worldPosition(), self.self.worldPosition()));
    return Math.atan2(V.dot(dir, vAx), V.dot(dir, u)) * self.RAD2DEG;
  };

  let clearTimer = 0, selectedOut = null;
  self.signal('Flow.Run').set(true);
  self.setState('idle');

  return {
    des: {
      canAccept: (mu, port) => self.currentLoad < 1 && self.state === 'idle',
      onAccept(mu, port) {
        const out = self.freeOutputs()[0];
        if (!out) { self.setState('holding'); return true; }
        selectedOut = out.id;
        self.in(Math.abs(angleToPort(out)) / (self.prop.RotationSpeed ?? 45), 'rotated', mu);
        self.setState('rotating_out'); return true;
      },
      on(hook, mu) {
        if (hook === 'rotated') {
          self.transfer(mu, self.outputs().find((p) => p.id === selectedOut));
          self.setState('idle');
        }
      },
    },
  };
}
`;

interface DesWorld {
  root: Object3D;
  env(adapter: RVScriptComponentAdapter): SdkEnvironment;
  signals: Map<string, boolean | number>;
  transferred: Array<{ id: number; port: string | null }>;
  held: Array<{ id: number }>;
  states: string[];
  outId: string;
}

function buildWorld(): DesWorld {
  const root = new Object3D(); root.name = 'Turntable';
  const rotary = new Object3D(); rotary.name = 'Drive-Rot-Y'; root.add(rotary);
  const snapObj = new Object3D(); snapObj.name = 'Snap-XN'; snapObj.position.set(-1, 0, 0); root.add(snapObj);
  const convB = new Object3D(); convB.name = 'ConvOutB'; convB.position.set(-3, 0, 0);
  const bIn = new Object3D(); bIn.name = 'Snap-In'; convB.add(bIn);
  const out = { id: 'tt-out', object3D: snapObj, flow: 'out' as const, pairedSnapId: 'convB-in', ownerRoot: root };
  const partner = { id: 'convB-in', object3D: bIn, flow: 'in' as const, pairedSnapId: 'tt-out', ownerRoot: convB };
  const reg = {
    getByOwnerRoot: (r: Object3D) => (r === root ? [out] : [partner]),
    getById: (id: string) => (id === 'tt-out' ? out : id === 'convB-in' ? partner : undefined),
  };
  const snapHost = { getPlugin: (id: string) => (id === 'snap-point' ? { getRegistry: () => reg } : undefined) };

  const signals = new Map<string, boolean | number>();
  const transferred: DesWorld['transferred'] = [];
  const held: Array<{ id: number }> = [];
  const states: string[] = [];
  const flow: SdkFlowBackend = {
    transfer: (mu, portId) => {
      if (!mu) return;
      const i = held.findIndex((m) => m.id === mu.id);
      if (i >= 0) held.splice(i, 1);
      transferred.push({ id: mu.id, port: portId ?? null });
    },
    mus: () => held,
  };
  const drive = {
    currentPosition: 0, currentSpeed: 0, targetSpeed: 45,
    isAtTarget: true, jogForward: false, jogBackward: false,
    startMove() {}, stop() {},
    node: rotary,
  };

  return {
    root, signals, transferred, held, states,
    outId: 'convB-in',
    env(adapter: RVScriptComponentAdapter): SdkEnvironment {
      return {
        name: 'Turntable',
        path: 'Cell/Turntable',
        node: root,
        props: { RotationSpeed: 45 },
        components: { drive: (p) => (p === 'Drive-Rot-Y' ? drive : null) },
        signals: { get: (n) => signals.get(n), set: (n, v) => signals.set(n, v) },
        ports: createSnapGraphPortsBackend({
          viewer: snapHost,
          root,
          signals: { get: (n) => signals.get(n), set: (n, v) => signals.set(n, v) },
        }),
        flow,
        scheduler: adapter.scheduler,
        onSetState: (s) => states.push(s),
        log: () => {},
      };
    },
  };
}

function advanceTo(manager: DESManager, target: number): void {
  let guard = 0;
  while (manager.currentTime < target && guard++ < 100000) {
    manager.processAnimated(0.1);
  }
}

describe('Script component as DES station (ScriptHook contract, phase 1b)', () => {
  let manager: DESManager;

  beforeEach(() => {
    manager = new DESManager();
    manager.mode = DESMode.Animated;
    manager.duration = 100000;
  });

  it('§6 Turntable DES block: canAccept → onAccept → timed rotation on the DES clock → transfer to the selected output', async () => {
    const host = await makeHost();
    const world = buildWorld();

    // DES-mode adapter: timers ride the PRIVATE Script.Hook action.
    const adapter: RVScriptComponentAdapter = new RVScriptComponentAdapter({
      mode: 'des',
      desScheduler: makeScriptHookScheduler(manager, {
        dispatchScriptHook: (hook, mu, data) => adapter.dispatchScriptHook(hook, mu, data),
      }),
    });
    const c = createSdkComponent(host, world.env(adapter), TURNTABLE_CODE, { callDeadlineMs: 500 });
    expect(c.ok).toBe(true);
    adapter.attach(c);

    // Runner-side handshake: canAccept while idle and empty → true.
    expect(adapter.stationCanAccept({ id: 7 }, { id: 'in-port', role: 'input' })).toBe(true);

    // Hand the MU over (the runner books it into the flow backend, then
    // dispatches onAccept — mirroring the DES adapter's accept path).
    world.held.push({ id: 7 });
    expect(adapter.stationOnAccept({ id: 7 }, { id: 'in-port', role: 'input' })).toBe(true);
    expect(world.states[world.states.length - 1]).toBe('rotating_out');

    // Back-pressure while rotating: currentLoad = 1 AND state != idle.
    expect(adapter.stationCanAccept({ id: 8 }, null)).toBe(false);

    // Output at -X ⇒ |+90°| / 45°/s = 2 s of DES time until 'rotated'.
    advanceTo(manager, 1.5);
    expect(world.transferred).toEqual([]);
    advanceTo(manager, 2.5);
    expect(world.transferred).toEqual([{ id: 7, port: world.outId }]);
    expect(world.states[world.states.length - 1]).toBe('idle');

    // Idle + empty again → accepts the next part.
    expect(adapter.stationCanAccept({ id: 8 }, null)).toBe(true);
    c.dispose();
  });

  it('holds without a free output; onDownstreamReady is delivered with a hydrated port', async () => {
    const host = await makeHost();
    const world = buildWorld();
    world.signals.set('ConvOutB.Flow.Occupied', true); // block the only output

    const adapter: RVScriptComponentAdapter = new RVScriptComponentAdapter({
      mode: 'des',
      desScheduler: makeScriptHookScheduler(manager, {
        dispatchScriptHook: (hook, mu, data) => adapter.dispatchScriptHook(hook, mu, data),
      }),
    });
    const CODE_WITH_READY = TURNTABLE_CODE.replace(
      'on(hook, mu) {',
      `onDownstreamReady(port) { self.setState('ready:' + port.id + ':' + String(port.occupied())); },
      on(hook, mu) {`,
    );
    const c = createSdkComponent(host, world.env(adapter), CODE_WITH_READY, { callDeadlineMs: 500 });
    expect(c.ok).toBe(true);
    adapter.attach(c);

    world.held.push({ id: 9 });
    expect(adapter.stationOnAccept({ id: 9 }, null)).toBe(true);
    expect(world.states[world.states.length - 1]).toBe('holding');

    // Downstream frees → the runner notifies; the port descriptor hydrates
    // into a full Port whose occupied() read resolves through the SAME
    // snap-graph backend by id.
    world.signals.set('ConvOutB.Flow.Occupied', false);
    adapter.stationOnDownstreamReady({ id: world.outId, role: 'output' });
    expect(world.states[world.states.length - 1]).toBe(`ready:${world.outId}:false`);
    c.dispose();
  });

  it('self.every rides the DES queue (recurring Script.Hook events)', async () => {
    const host = await makeHost();
    const world = buildWorld();
    const adapter: RVScriptComponentAdapter = new RVScriptComponentAdapter({
      mode: 'des',
      desScheduler: makeScriptHookScheduler(manager, {
        dispatchScriptHook: (hook, mu, data) => adapter.dispatchScriptHook(hook, mu, data),
      }),
    });
    const c = createSdkComponent(host, world.env(adapter), `
      function setup(self) {
        var beats = [];
        self.every(1.0, 'beat');
        return {
          des: { on: function (hook) { if (hook === 'beat') beats.push(self.now); } },
          beats: function () { return beats; },
        };
      }
    `, { callDeadlineMs: 500 });
    expect(c.ok).toBe(true);
    adapter.attach(c);

    advanceTo(manager, 3.5);
    const r = c.callHandler('beats');
    expect(r.ok).toBe(true);
    const beats = r.value as number[];
    expect(beats.length).toBe(3);
    expect(beats[0]).toBeCloseTo(1.0, 6);
    expect(beats[1]).toBeCloseTo(2.0, 6);
    expect(beats[2]).toBeCloseTo(3.0, 6);
    c.dispose();
  });
});
