// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect } from 'vitest';
import { Object3D } from 'three';
import {
  createBindContext,
  iterateFixedUpdate,
  type BindContextHost,
  type KinematicsSpec,
} from '../src/core/behavior-runtime';
import { EventEmitter } from '../src/core/rv-events';
import { ContextMenuStore } from '../src/core/hmi/context-menu-store';
import { createSelf, type SelfDef, type SelfScheduler, type MU } from '../src/core/material-flow/material-flow-self';
import { StateStatistics } from '../src/core/material-flow/rv-state-statistics';

// ─── Inline mock host (mirrors tests/conveyor-behavior.test.ts) ───────────

interface FakeDrive {
  name: string;
  node: Object3D;
  jogForward: boolean;
  jogBackward: boolean;
  TargetSpeed: number;
  startMove(d?: number): void;
  stop(): void;
}

function makeHost(opts: {
  root: Object3D;
  drives?: FakeDrive[];
  snapPlugin?: unknown;
} = { root: new Object3D() }) {
  const subs = new Map<string, Set<(v: boolean | number) => void>>();
  const values = new Map<string, boolean | number>();
  const signalStore = {
    get: (n: string) => values.get(n),
    set: (n: string, v: boolean | number) => {
      values.set(n, v);
      subs.get(n)?.forEach((cb) => cb(v));
    },
    subscribe: (n: string, cb: (v: boolean | number) => void) => {
      let s = subs.get(n);
      if (!s) { s = new Set(); subs.set(n, s); }
      s.add(cb);
      return () => { s!.delete(cb); };
    },
  };
  const events = new EventEmitter<Record<string, unknown>>();
  const host: BindContextHost = {
    signalStore,
    on: (e, cb) => events.on(e, cb as never),
    contextMenu: new ContextMenuStore(),
    drives: (opts.drives ?? []) as never,
    registry: null,
    getPlugin: (id: string) => (id === 'snap-point' ? opts.snapPlugin : undefined),
  };
  return { host, signalStore, values };
}

const DEF: SelfDef = { type: 'Conveyor', kind: 'conveyor' };

function ctxFor(host: BindContextHost, root: Object3D) {
  const accum: KinematicsSpec = {};
  const { ctx } = createBindContext(root, host, accum);
  return ctx;
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe('createSelf — basic projection', () => {
  it('projects type/kind/root/node/mode/entityId from the def + options', () => {
    const root = new Object3D(); root.name = 'Conv';
    const { host } = makeHost({ root });
    const self = createSelf(ctxFor(host, root), DEF);
    expect(self.type).toBe('Conveyor');
    expect(self.kind).toBe('conveyor');
    expect(self.root).toBe(root);
    expect(self.node).toBe(root);
    expect(self.mode).toBe('continuous');
    expect(self.entityId).toBe(-1);
  });

  it('honours mode + entityId options', () => {
    const root = new Object3D();
    const { host } = makeHost({ root });
    const self = createSelf(ctxFor(host, root), DEF, { mode: 'des', entityId: 7 });
    expect(self.mode).toBe('des');
    expect(self.entityId).toBe(7);
  });
});

describe('createSelf — signals project through rv.signals', () => {
  it('get/set forward to the underlying signal store (instance-scoped)', () => {
    const root = new Object3D(); root.name = 'Conv';
    const { host, values } = makeHost({ root });
    const self = createSelf(ctxFor(host, root), DEF);
    self.signals.set('Flow.Run', true);
    // No LayoutObject ancestor → empty scope → unscoped name.
    expect(values.get('Flow.Run')).toBe(true);
    expect(self.signals.get<boolean>('Flow.Run')).toBe(true);
  });

  it('on() subscribes and fires on subsequent set()', () => {
    const root = new Object3D(); root.name = 'Conv';
    const { host } = makeHost({ root });
    const self = createSelf(ctxFor(host, root), DEF);
    let seen: boolean | number | undefined;
    self.signals.on('Sensor', (v) => { seen = v; });
    self.signals.set('Sensor', true);
    expect(seen).toBe(true);
  });
});

describe('createSelf — drive projection', () => {
  it('resolves a drive by node ref and exposes the BindContextDrive surface', () => {
    const root = new Object3D(); root.name = 'Conv';
    const belt = new Object3D(); belt.name = 'Transport-X'; root.add(belt);
    const drive: FakeDrive = {
      name: 'Transport-X', node: belt, jogForward: false, jogBackward: false,
      TargetSpeed: 100, startMove() {}, stop() {},
    };
    const { host } = makeHost({ root, drives: [drive] });
    const self = createSelf(ctxFor(host, root), DEF);
    const d = self.drive(belt);
    expect(d).not.toBeNull();
    expect(d!.name).toBe('Transport-X');
    d!.jogForward = true;
    expect(drive.jogForward).toBe(true);
  });

  it('returns null for an unknown drive ref', () => {
    const root = new Object3D(); root.name = 'Conv';
    const { host } = makeHost({ root });
    const self = createSelf(ctxFor(host, root), DEF);
    expect(self.drive('Nope')).toBeNull();
  });
});

describe('createSelf — ports from the snap graph', () => {
  it('classifies a paired output snap as an output port (id === partner snap id)', () => {
    const aRoot = new Object3D(); aRoot.name = 'ConvA';
    const aOutObj = new Object3D(); aOutObj.name = 'Snap-XP'; aRoot.add(aOutObj);
    const bRoot = new Object3D(); bRoot.name = 'ConvB';
    const bInObj = new Object3D(); bInObj.name = 'Snap-XN'; bRoot.add(bInObj);

    const aOut = { id: 'a-out', object3D: aOutObj, flow: 'out', pairedSnapId: 'b-in', ownerRoot: aRoot };
    const bIn = { id: 'b-in', object3D: bInObj, flow: 'in', pairedSnapId: 'a-out', ownerRoot: bRoot };
    const byId: Record<string, unknown> = { 'a-out': aOut, 'b-in': bIn };
    const reg = {
      getByOwnerRoot: (r: Object3D) => (r === aRoot ? [aOut] : [bIn]),
      getById: (id: string) => byId[id],
    };
    const snapPlugin = { getRegistry: () => reg };

    const { host } = makeHost({ root: aRoot, snapPlugin });
    const self = createSelf(ctxFor(host, aRoot), DEF);

    const ports = [...self.ports];
    expect(ports.length).toBe(1);
    const port = ports[0];
    // Port.id === partner snap id === TransportLink.partnerSnapId.
    expect(port.id).toBe('b-in');
    expect(port.partnerSnapId).toBe('b-in');
    expect(port.mySnapId).toBe('a-out');
    expect(port.role).toBe('output');
    expect(port.ownerRoot).toBe(bRoot);
    expect(port.ownerComponent).toBeNull();
    expect(self.outputs().length).toBe(1);
    expect(self.inputs().length).toBe(0);
  });

  it('freeOutputs excludes a port whose downstream signal is occupied', () => {
    const aRoot = new Object3D(); aRoot.name = 'ConvA';
    const aOutObj = new Object3D(); aOutObj.name = 'Snap-XP'; aRoot.add(aOutObj);
    const bRoot = new Object3D(); bRoot.name = 'ConvB';
    const bInObj = new Object3D(); bInObj.name = 'Snap-XN'; bRoot.add(bInObj);
    const aOut = { id: 'a-out', object3D: aOutObj, flow: 'out', pairedSnapId: 'b-in', ownerRoot: aRoot };
    const bIn = { id: 'b-in', object3D: bInObj, flow: 'in', pairedSnapId: 'a-out', ownerRoot: bRoot };
    const byId: Record<string, unknown> = { 'a-out': aOut, 'b-in': bIn };
    const reg = {
      getByOwnerRoot: (r: Object3D) => (r === aRoot ? [aOut] : [bIn]),
      getById: (id: string) => byId[id],
    };
    const snapPlugin = { getRegistry: () => reg };
    const { host, values } = makeHost({ root: aRoot, snapPlugin });
    const self = createSelf(ctxFor(host, aRoot), DEF);

    // Downstream not occupied → free.
    expect(self.freeOutputs().length).toBe(1);
    // Mark downstream root occupied (no per-port key → root signal). The `/`-prefixed
    // read resolves via the global escape, which strips the leading slash, so the
    // stored key is the un-prefixed name.
    values.set('ConvB.Flow.Occupied', true);
    expect(self.freeOutputs().length).toBe(0);
    expect(self.downstreamOccupied(self.outputs()[0])).toBe(true);
  });
});

describe('createSelf — state machine + prop', () => {
  it('setState/state round-trip', () => {
    const root = new Object3D();
    const { host } = makeHost({ root });
    const self = createSelf(ctxFor(host, root), DEF);
    expect(self.state).toBe('idle');
    self.setState('receiving');
    expect(self.state).toBe('receiving');
  });

  it('prop is a mutable snapshot-safe bag', () => {
    const root = new Object3D();
    const { host } = makeHost({ root });
    const self = createSelf(ctxFor(host, root), DEF);
    self.prop['alignedPort'] = null;
    self.prop['driveTarget'] = 42;
    expect(self.prop['driveTarget']).toBe(42);
    expect(JSON.stringify(self.prop)).toContain('driveTarget');
  });
});

describe('createSelf — statistics sink (Plan 201)', () => {
  it('statState books canonical category time into the StateStatistics sink', () => {
    let t = 0;
    const stats = new StateStatistics(() => t, { initialState: 'idle' });
    const root = new Object3D();
    const { host } = makeHost({ root });
    const self = createSelf(ctxFor(host, root), DEF, { statistics: stats });
    self.statState('Working'); t = 10;
    self.statState('Empty'); t = 20;
    const snap = stats.getSnapshot();
    expect(snap.states['Working'].duration).toBeCloseTo(10);
    expect(snap.states['Empty'].duration).toBeCloseTo(10);
  });

  it('setState is FSM-only and does NOT pollute the statistics sink', () => {
    let t = 0;
    const stats = new StateStatistics(() => t, { initialState: 'idle' });
    const root = new Object3D();
    const { host } = makeHost({ root });
    const self = createSelf(ctxFor(host, root), DEF, { statistics: stats });
    self.setState('receiving'); t = 10; // FSM phase — must NOT book a stat bucket
    const snap = stats.getSnapshot();
    expect(snap.states['receiving']).toBeUndefined();
    expect(self.state).toBe('receiving'); // FSM state still reflects it
  });

  it('statState forwards the canonical category to onStatState (DES bridge)', () => {
    const seen: string[] = [];
    const root = new Object3D();
    const { host } = makeHost({ root });
    const self = createSelf(ctxFor(host, root), DEF, { onStatState: (n) => seen.push(n) });
    self.statState('Working');
    self.statState('Working'); // de-duped — no second forward
    self.statState('Setup');
    expect(seen).toEqual(['Working', 'Setup']);
  });

  it('statOutput / statCycle delegate to the sink', () => {
    let t = 0;
    const stats = new StateStatistics(() => t, { initialState: 'idle' });
    const root = new Object3D();
    const { host } = makeHost({ root });
    const self = createSelf(ctxFor(host, root), DEF, { statistics: stats });
    self.statCycleStart(); t = 5; self.statCycleEnd();
    self.statOutput(3);
    const snap = stats.getSnapshot();
    expect(snap.output).toBe(3);
    expect(snap.cycleCount).toBe(1);
    expect(snap.cycleAvg).toBeCloseTo(5);
  });

  it('stat calls are no-ops without a sink', () => {
    const root = new Object3D();
    const { host } = makeHost({ root });
    const self = createSelf(ctxFor(host, root), DEF);
    expect(() => {
      self.setState('Working');
      self.statState('Working');
      self.statOutput(2);
      self.statCycleStart();
      self.statCycleEnd();
    }).not.toThrow();
    expect(self.state).toBe('Working');
  });
});

describe('createSelf — kernel-agnostic scheduling (plan-210 §6b)', () => {
  it('continuous mode: in/at schedule on the event heap, the fixed tick drains due hooks via onHook', () => {
    const root = new Object3D();
    const { host } = makeHost({ root });
    const accum: KinematicsSpec = {};
    const { ctx, handle } = createBindContext(root, host, accum);
    const hooks: Array<[string, MU | null, unknown]> = [];
    const self = createSelf(ctx, DEF, {
      mode: 'continuous',
      onHook: (h, mu, data) => hooks.push([h, mu, data]),
    });
    const mu: MU = { id: 1 };
    const id = self.in(0.5, 'Arrival', mu, { x: 1 });
    self.at(1.0, 'Later');
    expect(id).toBeGreaterThan(0);
    expect(self.now).toBe(0);

    // 0.4 s: nothing due yet.
    for (let i = 0; i < 4; i++) iterateFixedUpdate(handle, 0.1);
    expect(hooks).toEqual([]);
    expect(self.now).toBeCloseTo(0.4, 9);

    // Cross 0.5 s → 'Arrival' fires with mu + data.
    iterateFixedUpdate(handle, 0.1);
    expect(hooks).toEqual([['Arrival', mu, { x: 1 }]]);

    // Cross 1.0 s → the absolute-time event fires too.
    for (let i = 0; i < 6; i++) iterateFixedUpdate(handle, 0.1);
    expect(hooks).toHaveLength(2);
    expect(hooks[1][0]).toBe('Later');
  });

  it('continuous mode: cancel prevents the hook; now advances with the tick', () => {
    const root = new Object3D();
    const { host } = makeHost({ root });
    const accum: KinematicsSpec = {};
    const { ctx, handle } = createBindContext(root, host, accum);
    const hooks: string[] = [];
    const self = createSelf(ctx, DEF, {
      mode: 'continuous',
      onHook: (h) => hooks.push(h),
    });
    const id = self.in(0.2, 'Never');
    self.cancel(id);
    for (let i = 0; i < 10; i++) iterateFixedUpdate(handle, 0.1);
    expect(hooks).toEqual([]);
    expect(self.now).toBeCloseTo(1.0, 9);
  });

  it('continuous mode without onHook: a due event warns once instead of throwing', () => {
    const root = new Object3D();
    const { host } = makeHost({ root });
    const accum: KinematicsSpec = {};
    const { ctx, handle } = createBindContext(root, host, accum);
    const self = createSelf(ctx, DEF, { mode: 'continuous' });
    const warnings: unknown[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args[0]); };
    try {
      self.in(0.1, 'Unwired');
      self.in(0.2, 'Unwired2');
      for (let i = 0; i < 5; i++) iterateFixedUpdate(handle, 0.1);
    } finally {
      console.warn = origWarn;
    }
    expect(warnings).toHaveLength(1); // warned ONCE, not per event
    expect(String(warnings[0])).toMatch(/no onHook dispatcher/);
  });

  it('delegates to an injected scheduler in DES mode', () => {
    const root = new Object3D();
    const { host } = makeHost({ root });
    const calls: string[] = [];
    const scheduler: SelfScheduler = {
      in: (d, h) => { calls.push(`in:${d}:${h}`); return 1; },
      at: (t, h) => { calls.push(`at:${t}:${h}`); return 2; },
      cancel: (id) => { calls.push(`cancel:${id}`); },
      now: 12.5,
    };
    const self = createSelf(ctxFor(host, root), DEF, { mode: 'des', entityId: 3, scheduler });
    const mu: MU = { id: 1 };
    expect(self.in(0.5, 'Arrival', mu)).toBe(1);
    expect(self.at(2, 'RotateComplete')).toBe(2);
    self.cancel(99);
    expect(self.now).toBe(12.5);
    expect(calls).toEqual(['in:0.5:Arrival', 'at:2:RotateComplete', 'cancel:99']);
  });
});
