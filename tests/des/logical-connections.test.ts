// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * logical-connections.test.ts — typed automatic neighbour connections
 * (plan-225). Exercises the private resolver `autoConnectByDistance` /
 * `detectCycles` against lightweight mock instances. Positions come from each
 * instance's node world transform (the resolver reads the node world-AABB; a
 * geometry-less Object3D falls back to its world position), so tests just place
 * the nodes and assert the wiring.
 */

import { describe, it, expect } from 'vitest';
import { Object3D } from 'three';
import {
  autoConnectByDistance,
  breakTwoCycles,
  detectCycles,
  type ConnectableInstance,
} from '@rv-private/plugins/des/logical-connections';

type MockAdapter = {
  node: Object3D;
  nextComponents: MockAdapter[];
  previousComponents: MockAdapter[];
  autoConnect: { enabled: boolean; maxDistance: number };
};

function makeInst(
  name: string,
  kind: string,
  pos: [number, number, number],
  opts: { enabled?: boolean; maxDistance?: number; connectionType?: string; subType?: string } = {},
): ConnectableInstance {
  const root = new Object3D();
  root.name = name;
  root.position.set(pos[0], pos[1], pos[2]);
  root.updateMatrixWorld(true);
  const adapter: MockAdapter = {
    node: root,
    nextComponents: [],
    previousComponents: [],
    autoConnect: { enabled: opts.enabled ?? true, maxDistance: opts.maxDistance ?? 1.0 },
  };
  return {
    root,
    adapter: adapter as never,
    kind,
    connectionType: opts.connectionType ?? 'material-flow',
    subType: opts.subType,
  };
}

const next = (i: ConnectableInstance): MockAdapter[] => (i.adapter as unknown as MockAdapter).nextComponents;
const prev = (i: ConnectableInstance): MockAdapter[] => (i.adapter as unknown as MockAdapter).previousComponents;

describe('logical-connections — autoConnectByDistance', () => {
  it('connects a source to the nearest conveyor in range, bidirectionally (F1)', () => {
    const src = makeInst('Source', 'source', [0, 0, 0]);
    const conv = makeInst('Conveyor', 'conveyor', [0.5, 0, 0]);
    const created = autoConnectByDistance([src, conv]);
    expect(created).toBe(1);
    expect(next(src)).toContain(conv.adapter);
    expect(prev(conv)).toContain(src.adapter);
  });

  it('respects the max distance (F7)', () => {
    const src = makeInst('Source', 'source', [0, 0, 0], { maxDistance: 1.0 });
    const conv = makeInst('Conveyor', 'conveyor', [5, 0, 0]);
    expect(autoConnectByDistance([src, conv])).toBe(0);
  });

  it('picks the nearest of several candidates', () => {
    const src = makeInst('Source', 'source', [0, 0, 0]);
    const near = makeInst('Near', 'conveyor', [0.3, 0, 0]);
    const far = makeInst('Far', 'conveyor', [0.9, 0, 0]);
    autoConnectByDistance([src, far, near]);
    expect(next(src)).toEqual([near.adapter]);
  });

  it('does not touch instances already wired (snap precedence, F4)', () => {
    const src = makeInst('Source', 'source', [0, 0, 0]);
    // Sink (no output of its own) pre-wired to the source as a snap link would be.
    const other = makeInst('Other', 'sink', [0.3, 0, 0]);
    next(src).push(other.adapter as never);
    expect(autoConnectByDistance([src, other])).toBe(0);
    expect(next(src)).toEqual([other.adapter]);
  });

  it('never self-loops and never targets a source as input', () => {
    const src = makeInst('Source', 'source', [0, 0, 0]);
    expect(autoConnectByDistance([src])).toBe(0);
    expect(next(src)).toHaveLength(0);
  });

  it('only connects matching connectionType (typed)', () => {
    const ctrl = makeInst('Ctrl', 'source', [0, 0, 0], { connectionType: 'control' });
    const conv = makeInst('Conveyor', 'conveyor', [0.3, 0, 0], { connectionType: 'material-flow' });
    expect(autoConnectByDistance([ctrl, conv])).toBe(0);
  });

  it('skips instances with autoConnect disabled', () => {
    const src = makeInst('Source', 'source', [0, 0, 0], { enabled: false });
    const conv = makeInst('Conveyor', 'conveyor', [0.3, 0, 0]);
    expect(autoConnectByDistance([src, conv])).toBe(0);
  });
});

describe('logical-connections — breakTwoCycles (snap mis-classification)', () => {
  // Helper to pre-wire a directed link A→B (next + previous), like wireTopology pass 1.
  const wire = (from: ConnectableInstance, to: ConnectableInstance): void => {
    next(from).push(to.adapter as never);
    prev(to).push(from.adapter as never);
  };

  it('drops the bogus output from the over-subscribed endpoint', () => {
    // Conveyor (2 outputs: turntable + next conveyor) ↔ Turntable (1 output: conveyor).
    const conv = makeInst('Conv', 'conveyor', [0, 0, 0]);
    const tt = makeInst('TT', 'conveyor', [1, 0, 0]);
    const conv2 = makeInst('Conv2', 'conveyor', [2, 0, 0]);
    wire(conv, tt);      // bogus: conveyor → turntable
    wire(conv, conv2);   // real:  conveyor → next conveyor
    wire(tt, conv);      // real:  turntable → conveyor

    const removed = breakTwoCycles([conv, tt, conv2]);
    expect(removed).toBe(1);
    // conv keeps only the real successor; tt keeps conv.
    expect(next(conv).map(a => a)).toEqual([conv2.adapter]);
    expect(next(tt)).toEqual([conv.adapter]);
    // previousComponents kept consistent: conv no longer a prev of tt.
    expect(prev(tt)).toEqual([]);
    expect(prev(conv)).toEqual([tt.adapter]);
  });

  it('leaves a clean line untouched', () => {
    const a = makeInst('A', 'source', [0, 0, 0]);
    const b = makeInst('B', 'conveyor', [1, 0, 0]);
    const c = makeInst('C', 'sink', [2, 0, 0]);
    wire(a, b); wire(b, c);
    expect(breakTwoCycles([a, b, c])).toBe(0);
    expect(next(a)).toEqual([b.adapter]);
    expect(next(b)).toEqual([c.adapter]);
  });

  it('resolves a symmetric 2-node cycle to a single direction (deterministic)', () => {
    const a = makeInst('A', 'conveyor', [0, 0, 0]);
    const b = makeInst('B', 'conveyor', [1, 0, 0]);
    wire(a, b); wire(b, a); // both 1 output → tie
    expect(breakTwoCycles([a, b])).toBe(1);
    // Exactly one direction survives.
    const aToB = next(a).includes(b.adapter as never);
    const bToA = next(b).includes(a.adapter as never);
    expect(aToB !== bToA).toBe(true);
  });
});

describe('logical-connections — detectCycles (F8)', () => {
  it('flags a closed loop', () => {
    const a = makeInst('A', 'conveyor', [0, 0, 0]);
    const b = makeInst('B', 'conveyor', [1, 0, 0]);
    next(a).push(b.adapter as never);
    next(b).push(a.adapter as never);
    const inCycle = detectCycles([a, b]);
    expect(inCycle).toContain(a.root);
    expect(inCycle).toContain(b.root);
  });

  it('reports no cycle for a straight line', () => {
    const a = makeInst('A', 'source', [0, 0, 0]);
    const b = makeInst('B', 'conveyor', [1, 0, 0]);
    next(a).push(b.adapter as never);
    expect(detectCycles([a, b])).toHaveLength(0);
  });
});
