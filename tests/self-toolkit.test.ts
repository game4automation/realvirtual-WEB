// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect } from 'vitest';
import { Object3D, Vector3 } from 'three';
import { AABB } from '../src/core/engine/rv-aabb';
import {
  createBindContext,
  type BindContextHost,
  type KinematicsSpec,
} from '../src/core/behavior-runtime';
import { EventEmitter } from '../src/core/rv-events';
import { ContextMenuStore } from '../src/core/hmi/context-menu-store';
import { createSelf, type SelfDef } from '../src/core/material-flow/material-flow-self';

const DEF: SelfDef = { type: 'Conveyor', kind: 'conveyor' };

interface FakeDrive {
  name: string;
  node: Object3D;
  jogForward: boolean;
  jogBackward: boolean;
  TargetSpeed: number;
  startMove(d?: number): void;
  stop(): void;
}

function makeHost(opts: { root: Object3D; drives?: FakeDrive[]; transportManager?: unknown } ) {
  const subs = new Map<string, Set<(v: boolean | number) => void>>();
  const values = new Map<string, boolean | number>();
  const events = new EventEmitter<Record<string, unknown>>();
  const host: BindContextHost = {
    signalStore: {
      get: (n: string) => values.get(n),
      set: (n: string, v: boolean | number) => { values.set(n, v); subs.get(n)?.forEach((cb) => cb(v)); },
      subscribe: (n: string, cb: (v: boolean | number) => void) => {
        let s = subs.get(n); if (!s) { s = new Set(); subs.set(n, s); }
        s.add(cb); return () => { s!.delete(cb); };
      },
    },
    on: (e, cb) => events.on(e, cb as never),
    contextMenu: new ContextMenuStore(),
    drives: (opts.drives ?? []) as never,
    registry: null,
  };
  if (opts.transportManager) {
    (host as unknown as { transportManager: unknown }).transportManager = opts.transportManager;
  }
  return { host, values };
}

function selfFor(opts: { root: Object3D; drives?: FakeDrive[]; transportManager?: unknown }) {
  const { host, values } = makeHost(opts);
  const accum: KinematicsSpec = {};
  const { ctx } = createBindContext(opts.root, host, accum);
  return { self: createSelf(ctx, DEF), values, accum };
}

// ─── findTransport / findSensor / findRotaryDrive ───────────────────────────

describe('self toolkit — convention finders', () => {
  it("find('transport'/'sensor') resolves the matching children", () => {
    const root = new Object3D(); root.name = 'Conv';
    const belt = new Object3D(); belt.name = 'Transport-Z'; root.add(belt);
    const sensor = new Object3D(); sensor.name = 'Sensor-1'; root.add(sensor);
    const { self } = selfFor({ root });
    expect(self.find('transport')).toBe(belt);
    expect(self.find('sensor')).toBe(sensor);
    expect(self.find('rotary')).toBeNull();
  });

  it("find('rotary') resolves a Drive-Rot-* child", () => {
    const root = new Object3D(); root.name = 'TT';
    const rot = new Object3D(); rot.name = 'Drive-Rot-Y'; root.add(rot);
    const { self } = selfFor({ root });
    expect(self.find('rotary')).toBe(rot);
  });

  it("findAll('transport') resolves every matching child (multi-axis)", () => {
    const root = new Object3D(); root.name = 'Transfer';
    const x = new Object3D(); x.name = 'Transport-X'; root.add(x);
    const z = new Object3D(); z.name = 'Transport-Z'; root.add(z);
    const { self } = selfFor({ root });
    expect(self.findAll('transport')).toEqual([x, z]);
    expect(self.findAll('rotary')).toEqual([]);
  });
});

// ─── attachBelt / attachDrive ───────────────────────────────────────────────

describe('self toolkit — lazy handles', () => {
  it('attachBelt returns a handle that jogs the resolved drive', () => {
    const root = new Object3D(); root.name = 'Conv';
    const belt = new Object3D(); belt.name = 'Transport-X'; root.add(belt);
    const drive: FakeDrive = { name: 'Transport-X', node: belt, jogForward: false, jogBackward: false, TargetSpeed: 100, startMove() {}, stop() {} };
    const { self } = selfFor({ root, drives: [drive] });
    const handle = self.attachBelt(belt);
    expect(handle.node).toBe(belt);
    handle.run(true);
    expect(drive.jogForward).toBe(true);
  });

  it('attachDrive returns a positioned handle', () => {
    const root = new Object3D(); root.name = 'TT';
    const axis = new Object3D(); axis.name = 'Drive-Rot-Y'; root.add(axis);
    const drive: FakeDrive = { name: 'Drive-Rot-Y', node: axis, jogForward: false, jogBackward: false, TargetSpeed: 50, startMove() {}, stop() {} };
    const { self } = selfFor({ root, drives: [drive] });
    const handle = self.attachDrive(axis);
    expect(handle.node).toBe(axis);
    expect(typeof handle.moveTo).toBe('function');
    expect(typeof handle.isAtTarget).toBe('function');
  });
});

// ─── surfaceOccupied ────────────────────────────────────────────────────────

describe('self toolkit — surfaceOccupied', () => {
  it('reads viewer.transportManager surfaces/mus', () => {
    const root = new Object3D(); root.name = 'Conv';
    const belt = new Object3D(); belt.name = 'Transport-X'; root.add(belt);
    belt.updateMatrixWorld(true);
    const surf = { node: belt, aabb: AABB.fromHalfSize(belt, new Vector3(1, 0.1, 1)) };
    const mu = { aabb: AABB.fromHalfSize(belt, new Vector3(0.2, 0.2, 0.2)), markedForRemoval: false };
    const transportManager = { surfaces: [surf], mus: [mu] };
    const { self } = selfFor({ root, transportManager });
    expect(self.surfaceOccupied(belt)).toBe(true);
  });

  it('returns false without a transport manager', () => {
    const root = new Object3D(); root.name = 'Conv';
    const belt = new Object3D(); belt.name = 'Transport-X'; root.add(belt);
    const { self } = selfFor({ root });
    expect(self.surfaceOccupied(belt)).toBe(false);
  });
});

// ─── declareFlowSignals ─────────────────────────────────────────────────────

describe('self toolkit — declareFlowSignals', () => {
  it('declares the 4 material-flow signals into accum (instance-scoped names)', () => {
    const root = new Object3D(); root.name = 'Conv';
    root.userData.realvirtual = { LayoutObject: { Label: 'Conv', CatalogId: 'c', Locked: false } };
    const { self, accum } = selfFor({ root });
    self.declareFlowSignals();
    // signal() forwards to rv.signal → pushes scoped {name,type,initialValue} onto accum.signals.
    const byName = new Map((accum.signals ?? []).map(s => [s.name, s]));
    expect(byName.get('Conv.Flow.Run')).toMatchObject({ type: 'PLCInputBool', initialValue: true });
    expect(byName.get('Conv.Flow.Occupied')).toMatchObject({ type: 'PLCOutputBool', initialValue: false });
    expect(byName.get('Conv.Flow.Running')).toMatchObject({ type: 'PLCOutputBool', initialValue: false });
    expect(byName.get('Conv.Flow.PartCount')).toMatchObject({ type: 'PLCOutputInt', initialValue: 0 });
    expect(accum.signals?.length).toBe(4);
  });
});

// ─── downstreamInterlock (cached) ───────────────────────────────────────────

describe('self toolkit — downstreamInterlock', () => {
  it('returns a cached { occupied } object', () => {
    const root = new Object3D(); root.name = 'Conv';
    const { self } = selfFor({ root });
    const a = self.downstreamInterlock();
    const b = self.downstreamInterlock();
    expect(typeof a.occupied).toBe('function');
    expect(a).toBe(b); // cached — same instance
    // No downstream successor → blocked (occupied true).
    expect(a.occupied()).toBe(true);
  });
});

// ─── disable ────────────────────────────────────────────────────────────────

describe('self toolkit — disable', () => {
  it('disable() sets self.disabled and warns', () => {
    const root = new Object3D(); root.name = 'Conv';
    const { self } = selfFor({ root });
    expect(self.disabled).toBe(false);
    self.disable('missing Transport-*');
    expect(self.disabled).toBe(true);
  });
});
