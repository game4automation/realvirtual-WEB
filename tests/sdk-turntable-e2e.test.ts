// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * sdk-turntable-e2e.test.ts — plan-210 §9 phase 1b PROOF test:
 * the §6-appendix Turntable JS (open angle math, no geom helpers) runs FOR
 * REAL as a script component in the CONTINUOUS kernel against a test scene
 * with snap-graph ports, a rotary drive, a sensor and a belt:
 *
 *   MU waits at the input port (upstreamWaiting) → the disc aligns to the
 *   input (drive.moveTo(angleToPort)) → receives (belt on) → part at centre
 *   (sensor edge) → rotates to a FREE output → discharges → clears → idle.
 *
 * The ports come from the SAME topology source the native TS behaviors use
 * (`createSnapGraphPortsBackend` → classifyConnections over a mock snap
 * registry) with the per-port-then-root `Flow.Occupied` interlock convention.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { Object3D } from 'three';
import { RVScriptHost } from '../src/core/engine/rv-script-host';
import { createSdkComponent } from '../src/core/sdk/rv-component-sdk';
import { RVScriptComponentAdapter } from '../src/core/sdk/rv-script-component-adapter';
import { createSnapGraphPortsBackend } from '../src/core/sdk/rv-sdk-ports';
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

/**
 * The §6-appendix Turntable script — VERBATIM except for the module form:
 * `export function setup` → global `function setup` (the loader contract).
 */
const TURNTABLE_CODE = `
function setup(self) {
  const V = self.vec3, drive = self.drive('Drive-Rot-Y'), sensor = self.sensor('Sensor'), belt = self.belt('Transport');
  if (!drive) return self.disable('no rotary drive');

  // Rotationsachse + deterministische Basis (u,v) senkrecht dazu — einmalig
  const axis = V.normalize(drive.node.worldDirection(V(0, 1, 0)));
  const ref  = Math.abs(axis.x) > 0.9 ? V(0, 0, 1) : V(1, 0, 0);
  const u    = V.normalize(V.cross(axis, ref));
  const vAx  = V.cross(axis, u);

  // OFFENE Winkelberechnung: Richtung Zentrum→Port auf die (u,v)-Ebene projizieren
  const angleToPort = (port) => {
    const dir = V.normalize(V.sub(port.node.worldPosition(), self.self.worldPosition()));
    return Math.atan2(V.dot(dir, vAx), V.dot(dir, u)) * self.RAD2DEG;
  };

  let clearTimer = 0, selectedOut = null;          // EIN State, beide Runner
  self.signal('Flow.Run').set(true);
  self.setState('idle');

  sensor?.on((occ) => {
    if (occ && self.state === 'receiving') {
      const out = self.freeOutputs()[0];
      if (!out) return self.setState('holding');
      selectedOut = out.id; drive.moveTo(angleToPort(out)); self.setState('rotating_out');
    } else if (!occ && self.state === 'discharging') {
      clearTimer = 0.5; self.setState('discharge_clearing');
    }
  });

  return {
    continuous: {
      fixedUpdate(dt) {
        switch (self.state) {
          case 'idle':
            belt?.run(false);
            if (self.signal('Flow.Run').bool) {
              const p = self.inputs().find((x) => x.upstreamWaiting());
              if (p) { drive.moveTo(angleToPort(p)); self.setState('aligning_in'); }
            }
            break;
          case 'aligning_in':  if (drive.isAtTarget) { self.setState('receiving');  belt?.run(true); } break;
          case 'rotating_out': if (drive.isAtTarget) { self.setState('discharging'); belt?.run(true); } break;
          case 'discharge_clearing':
            clearTimer -= dt; if (clearTimer <= 0) { belt?.run(false); self.setState('idle'); }
            break;
        }
      },
    },
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

// ── Mock world ───────────────────────────────────────────────────────────────

interface SnapLiteMock {
  id: string;
  object3D: Object3D;
  flow: 'in' | 'out' | 'bidi';
  pairedSnapId?: string;
  ownerRoot: Object3D;
}

interface World {
  root: Object3D;
  snapHost: { getPlugin(id: string): unknown };
  signals: Map<string, boolean | number>;
  drive: ReturnType<typeof makeRotaryDrive>;
  sensor: SdkSensorTarget & { fire(occ: boolean): void };
  belt: SdkBeltTarget & { readonly calls: string[] };
  states: string[];
  portIds: { in: string; outA: string; outB: string };
}

function makeRotaryDrive(node: Object3D) {
  return {
    currentPosition: 0,
    currentSpeed: 0,
    targetSpeed: 90,      // deg/s
    target: 0,
    moving: false,
    get isAtTarget(): boolean { return !this.moving; },
    jogForward: false,
    jogBackward: false,
    startMove(destination?: number): void {
      if (destination !== undefined) this.target = destination;
      this.moving = Math.abs(this.target - this.currentPosition) > 1e-6;
    },
    stop(): void { this.moving = false; },
    node,
    /** Test kinematics: advance toward the target at targetSpeed. */
    step(dt: number): void {
      if (!this.moving) return;
      const d = this.target - this.currentPosition;
      const maxStep = this.targetSpeed * dt;
      if (Math.abs(d) <= maxStep) {
        this.currentPosition = this.target;
        this.moving = false;
      } else {
        this.currentPosition += Math.sign(d) * maxStep;
      }
    },
  };
}

/**
 * Turntable at the origin, ONE input conveyor behind (-Z) and TWO output
 * conveyors left/right (+X / -X). Snap graph as the snap-point plugin would
 * expose it (authored flow roles — no component registry in this mock, so
 * classifyConnections falls back to the authored flow, exactly like the
 * headless behavior tests).
 */
function buildWorld(): World {
  const root = new Object3D();
  root.name = 'Turntable';
  const rotary = new Object3D();
  rotary.name = 'Drive-Rot-Y';
  root.add(rotary);
  const transport = new Object3D();
  transport.name = 'Transport';
  rotary.add(transport);

  const mkSnap = (name: string, x: number, z: number, flow: 'in' | 'out', owner: Object3D): Object3D => {
    const o = new Object3D();
    o.name = name;
    o.position.set(x, 0, z);
    owner.add(o);
    return o;
  };

  const convIn = new Object3D(); convIn.name = 'ConvIn'; convIn.position.set(0, 0, -3);
  const convOutA = new Object3D(); convOutA.name = 'ConvOutA'; convOutA.position.set(3, 0, 0);
  const convOutB = new Object3D(); convOutB.name = 'ConvOutB'; convOutB.position.set(-3, 0, 0);

  const snaps: SnapLiteMock[] = [
    { id: 'tt-in', object3D: mkSnap('Snap-ZN', 0, -1, 'in', root), flow: 'in', pairedSnapId: 'convin-out', ownerRoot: root },
    { id: 'tt-outA', object3D: mkSnap('Snap-XP', 1, 0, 'out', root), flow: 'out', pairedSnapId: 'convA-in', ownerRoot: root },
    { id: 'tt-outB', object3D: mkSnap('Snap-XN', -1, 0, 'out', root), flow: 'out', pairedSnapId: 'convB-in', ownerRoot: root },
    { id: 'convin-out', object3D: mkSnap('Snap-Out', 0, 1, 'out', convIn), flow: 'out', pairedSnapId: 'tt-in', ownerRoot: convIn },
    { id: 'convA-in', object3D: mkSnap('Snap-In', -1, 0, 'in', convOutA), flow: 'in', pairedSnapId: 'tt-outA', ownerRoot: convOutA },
    { id: 'convB-in', object3D: mkSnap('Snap-In', 1, 0, 'in', convOutB), flow: 'in', pairedSnapId: 'tt-outB', ownerRoot: convOutB },
  ];
  const byId = new Map(snaps.map((s) => [s.id, s]));
  const reg = {
    getByOwnerRoot: (r: Object3D) => snaps.filter((s) => s.ownerRoot === r),
    getById: (id: string) => byId.get(id),
  };
  const snapHost = { getPlugin: (id: string) => (id === 'snap-point' ? { getRegistry: () => reg } : undefined) };

  const signals = new Map<string, boolean | number>();
  const drive = makeRotaryDrive(rotary);

  const subs = new Set<(occ: boolean) => void>();
  const sensor: World['sensor'] = {
    occupied: false,
    subscribe(cb) { subs.add(cb); return () => subs.delete(cb); },
    fire(occ: boolean) { for (const cb of [...subs]) cb(occ); },
  };

  const beltCalls: string[] = [];
  const belt: World['belt'] = {
    run(forward: boolean) {
      const call = `run(${forward})`;
      if (beltCalls[beltCalls.length - 1] !== call) beltCalls.push(call);
    },
    occupied: false,
    speed: 0,
    node: transport,
    get calls() { return beltCalls; },
  };

  return {
    root, snapHost, signals, drive, sensor, belt,
    states: [],
    // Port ids as the script sees them: the PARTNER snap id (Plan 194/196).
    portIds: { in: 'convin-out', outA: 'convA-in', outB: 'convB-in' },
  };
}

function makeEnv(world: World, adapter: RVScriptComponentAdapter): SdkEnvironment {
  return {
    name: 'Turntable',
    path: 'Line1/Turntable',
    node: world.root,
    props: { RotationSpeed: 45 },
    components: {
      drive: (p) => (p === 'Drive-Rot-Y' ? world.drive : null),
      sensor: (p) => (p === 'Sensor' ? world.sensor : null),
      belt: (p) => (p === 'Transport' ? world.belt : null),
    },
    signals: {
      get: (n) => world.signals.get(n),
      set: (n, v) => world.signals.set(n, v),
    },
    ports: createSnapGraphPortsBackend({
      viewer: world.snapHost,
      root: world.root,
      signals: {
        get: (n) => world.signals.get(n),
        set: (n, v) => world.signals.set(n, v),
      },
    }),
    scheduler: adapter.scheduler,
    onSetState: (s) => world.states.push(s),
    log: () => {},
  };
}

function tickSeconds(world: World, adapter: RVScriptComponentAdapter, seconds: number): void {
  const n = Math.round(seconds / FIXED_DT);
  for (let i = 0; i < n; i++) {
    adapter.tick(FIXED_DT);
    world.drive.step(FIXED_DT);
  }
}

describe('SDK phase 1b — §6 Turntable JS runs for real (continuous)', () => {
  it('full cycle: input waiting → align → receive → rotate to FREE output → discharge → clear → idle', async () => {
    const host = await makeHost();
    const world = buildWorld();
    const adapter = new RVScriptComponentAdapter();
    const c = createSdkComponent(host, makeEnv(world, adapter), TURNTABLE_CODE, { callDeadlineMs: 500 });
    expect(c.ok).toBe(true);
    adapter.attach(c);

    // Script published the Flow.Run interop signal at setup.
    expect(world.signals.get('Flow.Run')).toBe(true);

    // Nothing waiting → the table stays idle.
    tickSeconds(world, adapter, 0.2);
    expect(world.states).toEqual(['idle']);

    // A part WAITS on the upstream conveyor (its root Flow.Occupied goes true —
    // the exact interlock convention the TS conveyors publish). Output A is
    // BLOCKED, so the router must pick output B (per-port-then-root read).
    world.signals.set('ConvIn.Flow.Occupied', true);
    world.signals.set('ConvOutA.Flow.Occupied', true);

    // Tick → idle sees the waiting input and aligns to it (angle 0 for -Z with
    // the deterministic (u,v) basis of the §6 open angle math).
    tickSeconds(world, adapter, 0.1);
    expect(world.states).toEqual(['idle', 'aligning_in', 'receiving']);
    expect(world.drive.target).toBeCloseTo(0, 6);
    expect(world.belt.calls[world.belt.calls.length - 1]).toBe('run(true)');

    // Part reaches the centre sensor → the router picks the FREE output (B at
    // -X ⇒ +90° in the (u,v) basis) and rotates out.
    world.signals.set('ConvIn.Flow.Occupied', false);
    world.sensor.fire(true);
    expect(world.states[world.states.length - 1]).toBe('rotating_out');
    expect(world.drive.target).toBeCloseTo(90, 4);

    // 90° at 90°/s ≈ 1 s → discharging, belt on.
    tickSeconds(world, adapter, 1.2);
    expect(world.states[world.states.length - 1]).toBe('discharging');
    expect(world.belt.calls[world.belt.calls.length - 1]).toBe('run(true)');

    // Part leaves the sensor → clearing gate (0.5 s) → idle, belt off.
    world.sensor.fire(false);
    expect(world.states[world.states.length - 1]).toBe('discharge_clearing');
    tickSeconds(world, adapter, 0.6);
    expect(world.states[world.states.length - 1]).toBe('idle');
    expect(world.belt.calls[world.belt.calls.length - 1]).toBe('run(false)');

    // Full FSM trace, §6 semantics.
    expect(world.states).toEqual([
      'idle', 'aligning_in', 'receiving', 'rotating_out',
      'discharging', 'discharge_clearing', 'idle',
    ]);
    c.dispose();
  });

  it('holds when NO output is free, ports carry real snap-graph identity', async () => {
    const host = await makeHost();
    const world = buildWorld();
    const adapter = new RVScriptComponentAdapter();
    const c = createSdkComponent(host, makeEnv(world, adapter), TURNTABLE_CODE, { callDeadlineMs: 500 });
    adapter.attach(c);

    // Both outputs blocked (root-level occupied).
    world.signals.set('ConvOutA.Flow.Occupied', true);
    world.signals.set('ConvOutB.Flow.Occupied', true);
    world.signals.set('ConvIn.Flow.Occupied', true);

    tickSeconds(world, adapter, 0.1);
    world.sensor.fire(true);
    expect(world.states[world.states.length - 1]).toBe('holding');

    // The port surface is the snap graph: partner snap ids, roles, own snap
    // node as the angle frame (probed through an extra guest handler).
    const probeCode = `
      function setup(self) {
        return {
          ports: function () {
            var res = { inputs: [], outputs: [] };
            self.inputs().forEach(function (p) { res.inputs.push({ id: p.id, waiting: p.upstreamWaiting() }); });
            self.outputs().forEach(function (p) { res.outputs.push({ id: p.id, occupied: p.occupied() }); });
            return res;
          },
        };
      }
    `;
    const probeAdapter = new RVScriptComponentAdapter();
    const probeComp = createSdkComponent(host, makeEnv(world, probeAdapter), probeCode, { callDeadlineMs: 500 });
    probeAdapter.attach(probeComp);
    const r = probeComp.callHandler('ports');
    expect(r.ok).toBe(true);
    expect(r.value).toEqual({
      inputs: [{ id: world.portIds.in, waiting: true }],
      outputs: [
        { id: world.portIds.outA, occupied: true },
        { id: world.portIds.outB, occupied: true },
      ],
    });
    probeComp.dispose();
    c.dispose();
  });

  it('per-port interlock wins over the root signal (downstream router opens ONE port)', async () => {
    const host = await makeHost();
    const world = buildWorld();
    const adapter = new RVScriptComponentAdapter();
    const c = createSdkComponent(host, makeEnv(world, adapter), TURNTABLE_CODE, { callDeadlineMs: 500 });
    adapter.attach(c);

    // Output A: root says busy, but the PER-PORT signal explicitly opens this
    // exact port (mutual-busy deadlock breaker — Turntable.ts freeOutputs).
    world.signals.set('ConvOutA.Flow.Occupied', true);
    world.signals.set(`ConvOutA.Flow.Occupied@${world.portIds.outA}`, false);
    world.signals.set('ConvOutB.Flow.Occupied', true);
    world.signals.set('ConvIn.Flow.Occupied', true);

    tickSeconds(world, adapter, 0.1);
    world.sensor.fire(true);
    // Output A (+X ⇒ -90°) is chosen despite its busy root.
    expect(world.states[world.states.length - 1]).toBe('rotating_out');
    expect(world.drive.target).toBeCloseTo(-90, 4);
    c.dispose();
  });
});
