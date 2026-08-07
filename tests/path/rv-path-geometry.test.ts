// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-268 §9.1 — RVPath substrate: segment geometry, arc-length addressing,
 * tangents, constant speed, degenerate cases and multi-path carry per tick.
 * Headless: synthetic RVPath instances, no GLB/DOM.
 */

import { describe, it, expect } from 'vitest';
import { Vector3, Quaternion } from 'three';
import { LineSegment, ArcSegment, RVPath } from '../../src/core/engine/rv-path';
import { RVPathNetwork } from '../../src/core/engine/rv-path-network';
import { PathTraveler } from '../../src/core/engine/rv-path-traveler';
import { lookRotation } from '../../src/core/engine/rv-pose-align';

const v3 = (x: number, y: number, z: number): Vector3 => new Vector3(x, y, z);

function linePath(id: string, from: Vector3, to: Vector3, successorIds: string[] = []): RVPath {
  return new RVPath(id, [new LineSegment(from, to)], { successorIds });
}

describe('LineSegment', () => {
  it('length, midpoint and constant normalised direction', () => {
    const seg = new LineSegment(v3(1, 0, 0), v3(1, 0, 4));
    expect(seg.length).toBeCloseTo(4, 10);
    const mid = seg.getPosition(0.5);
    expect(mid.x).toBeCloseTo(1, 10);
    expect(mid.z).toBeCloseTo(2, 10);
    const d0 = seg.getDirection(0);
    const d1 = seg.getDirection(0.87);
    expect(d0.length()).toBeCloseTo(1, 10);
    expect(d0.distanceTo(d1)).toBeCloseTo(0, 10); // constant along the segment
    expect(d0.z).toBeCloseTo(1, 10);
  });
});

describe('ArcSegment', () => {
  it('length == 2πR·deg/360 and the expected end point (±1e-6)', () => {
    const seg = new ArcSegment(v3(0, 0, 0), 2, 0, 90, false, 'XZ');
    expect(seg.length).toBeCloseTo(Math.PI, 10); // 2π·2·90/360 = π
    const start = seg.getPosition(0);
    expect(start.distanceTo(v3(2, 0, 0))).toBeLessThan(1e-6);
    const end = seg.getPosition(1);
    expect(end.distanceTo(v3(0, 0, 2))).toBeLessThan(1e-6); // CCW in (X,Z) basis
  });

  it('clockwise flips the sweep', () => {
    const seg = new ArcSegment(v3(0, 0, 0), 2, 90, 90, true, 'XZ');
    // start at 90° = (0,0,2), sweeping -90° → end at 0° = (2,0,0)
    expect(seg.getPosition(1).distanceTo(v3(2, 0, 0))).toBeLessThan(1e-6);
    expect(seg.length).toBeCloseTo(Math.PI, 10);
  });

  it('tangent is perpendicular to the radius everywhere and unit length', () => {
    const center = v3(1, 0, -2);
    const seg = new ArcSegment(center, 1.5, 30, 200, false, 'XZ');
    const p = new Vector3();
    const d = new Vector3();
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      seg.getPosition(t, p);
      seg.getDirection(t, d);
      const radial = p.clone().sub(center);
      expect(Math.abs(radial.dot(d))).toBeLessThan(1e-9);
      expect(d.length()).toBeCloseTo(1, 10);
    }
  });
});

describe('RVPath — segment chain (prefix sums)', () => {
  // line 2 m → quarter arc R=2 (length π) → total 2 + π
  const chain = new RVPath('chain', [
    new LineSegment(v3(0, 0, -2), v3(0, 0, 0)),
    new ArcSegment(v3(-2, 0, 0), 2, 0, 90, false, 'XZ'),
  ]);

  it('total length is the segment sum', () => {
    expect(chain.length).toBeCloseTo(2 + Math.PI, 10);
  });

  it('getAbsPosition maps across the segment boundary', () => {
    // 1 m into the line
    expect(chain.getAbsPosition(1).distanceTo(v3(0, 0, -1))).toBeLessThan(1e-9);
    // exactly at the boundary — both sides agree (continuity)
    const before = chain.getAbsPosition(2 - 1e-9);
    const after = chain.getAbsPosition(2 + 1e-9);
    expect(before.distanceTo(after)).toBeLessThan(1e-6);
    // half the arc: 45° from start angle 0 around (-2,0,0)
    const mid = chain.getAbsPosition(2 + Math.PI / 2);
    const expected = v3(-2 + 2 * Math.cos(Math.PI / 4), 0, 2 * Math.sin(Math.PI / 4));
    expect(mid.distanceTo(expected)).toBeLessThan(1e-9);
    // end of the chain
    expect(chain.getAbsPosition(chain.length).distanceTo(v3(-2, 0, 2))).toBeLessThan(1e-9);
    // clamped beyond the ends (open path)
    expect(chain.getAbsPosition(999).distanceTo(v3(-2, 0, 2))).toBeLessThan(1e-9);
    expect(chain.getAbsPosition(-5).distanceTo(v3(0, 0, -2))).toBeLessThan(1e-9);
  });

  it('constant speed: equal Δs → equal euclidean step size (arc-length param)', () => {
    const ds = 0.01;
    const prev = new Vector3();
    const cur = new Vector3();
    chain.getAbsPosition(0, prev);
    for (let s = ds; s <= chain.length; s += ds) {
      chain.getAbsPosition(s, cur);
      // chord ≈ Δs (chord error at R=2: Δs³/24R² ≈ 4e-9)
      expect(Math.abs(cur.distanceTo(prev) - ds)).toBeLessThan(1e-6);
      prev.copy(cur);
    }
  });

  it('getSpacedPoints samples at equal arc-length spacing', () => {
    const pts = chain.getSpacedPoints(64);
    expect(pts.length).toBe(65);
    for (let i = 1; i < pts.length; i++) {
      expect(Math.abs(pts[i].distanceTo(pts[i - 1]) - chain.length / 64)).toBeLessThan(1e-4);
    }
  });
});

describe('degenerate cases (no NaN, no crash)', () => {
  it('zero-length line (from == to)', () => {
    const seg = new LineSegment(v3(1, 2, 3), v3(1, 2, 3));
    expect(seg.length).toBe(0);
    const p = seg.getPosition(0.5);
    expect(Number.isFinite(p.x + p.y + p.z)).toBe(true);
    expect(seg.getDirection(0.5).length()).toBeCloseTo(1, 10); // fallback tangent
  });

  it('arc with degrees = 0 and radius = 0', () => {
    for (const seg of [
      new ArcSegment(v3(0, 0, 0), 2, 45, 0),
      new ArcSegment(v3(0, 0, 0), 0, 0, 90),
    ]) {
      expect(seg.length).toBe(0);
      const p = seg.getPosition(1);
      expect(Number.isFinite(p.x + p.y + p.z)).toBe(true);
      const d = seg.getDirection(0.3);
      expect(Number.isFinite(d.x + d.y + d.z)).toBe(true);
    }
  });

  it('zero-length path: getAbsPosition/getAbsDirection stay finite', () => {
    const p = new RVPath('zero', [new LineSegment(v3(0, 0, 0), v3(0, 0, 0))]);
    expect(p.length).toBe(0);
    const pos = p.getAbsPosition(0.5);
    const dir = p.getAbsDirection(0.5);
    expect(Number.isFinite(pos.x + pos.y + pos.z)).toBe(true);
    expect(dir.length()).toBeCloseTo(1, 10);
    // empty path (no segments at all)
    const empty = new RVPath('empty', []);
    expect(empty.length).toBe(0);
    expect(Number.isFinite(empty.getAbsPosition(1).x)).toBe(true);
  });

  it('lookRotation guards zero forward and forward ∥ up', () => {
    const q = new Quaternion();
    lookRotation(v3(0, 0, 0), v3(0, 1, 0), q);
    expect(q.equals(new Quaternion())).toBe(true); // identity
    lookRotation(v3(0, 1, 0), v3(0, 1, 0), q); // parallel — fallback up
    expect(Number.isFinite(q.x + q.y + q.z + q.w)).toBe(true);
    expect(Math.abs(q.length() - 1)).toBeLessThan(1e-9);
  });
});

describe('PathTraveler — carry & closed wrap', () => {
  it('carries across MULTIPLE paths in one tick (while-carry)', () => {
    const net = new RVPathNetwork();
    const a = linePath('A', v3(0, 0, 0), v3(0, 0, 1), ['B']);
    const b = linePath('B', v3(0, 0, 1), v3(0, 0, 2), ['C']);
    const c = linePath('C', v3(0, 0, 2), v3(0, 0, 3), []);
    net.register(a); net.register(b); net.register(c);

    const arrivals: string[] = [];
    const t = new PathTraveler('agv1', a, net);
    t.hooks.onArrive = (nodeId) => arrivals.push(nodeId);
    t.v = 2500 * 60; // 2.5 m per 1/60 s tick — spans two whole 1 m paths
    t.advance(1 / 60);

    expect(t.path?.id).toBe('C');
    expect(t.s).toBeCloseTo(0.5, 9);
    expect(arrivals).toEqual(['A', 'B']);
  });

  it('carries BACKWARD to predecessors when s < 0', () => {
    const net = new RVPathNetwork();
    const a = linePath('A', v3(0, 0, 0), v3(0, 0, 1), ['B']);
    const b = linePath('B', v3(0, 0, 1), v3(0, 0, 2), []);
    net.register(a); net.register(b);

    const t = new PathTraveler('agv1', b, net);
    t.s = 0.2;
    t.v = -1000 * 30; // -0.5 m per 1/60 s tick
    t.advance(1 / 60);

    expect(t.path?.id).toBe('A');
    expect(t.s).toBeCloseTo(0.7, 9);
  });

  it('stops at a dead end without crashing (empty successors) and does not re-fire onArrive', () => {
    const net = new RVPathNetwork();
    const a = linePath('A', v3(0, 0, 0), v3(0, 0, 1), []);
    net.register(a);

    const arrivals: string[] = [];
    const t = new PathTraveler('agv1', a, net);
    t.hooks.onArrive = (nodeId) => arrivals.push(nodeId);
    t.v = 2000 * 60;
    t.advance(1 / 60); // overshoots the 1 m path
    expect(t.s).toBe(a.length);
    expect(t.v).toBe(0);
    expect(t.atEnd).toBe(true);
    expect(arrivals).toEqual(['A']);
    t.advance(1 / 60); // no motion — must not re-fire
    t.v = 0; t.advance(1 / 60);
    expect(arrivals).toEqual(['A']);
  });

  it('wraps s modulo length on a closed path (no arrival events)', () => {
    const loop = new RVPath('loop', [
      new LineSegment(v3(0, 0, 0), v3(0, 0, 2)),
      new LineSegment(v3(0, 0, 2), v3(0, 0, 0)),
    ], { closed: true });
    const arrivals: string[] = [];
    const t = new PathTraveler('agv1', loop, null);
    t.hooks.onArrive = (nodeId) => arrivals.push(nodeId);
    t.s = 3.5;
    t.v = 1000 * 60; // +1 m per tick → 4.5 → wraps to 0.5 (L = 4)
    t.advance(1 / 60);
    expect(t.s).toBeCloseTo(0.5, 9);
    expect(arrivals).toEqual([]);
  });

  it('zero-length successor loop is guard-bounded (no hang, finite s)', () => {
    const net = new RVPathNetwork();
    const a = linePath('A', v3(0, 0, 0), v3(0, 0, 0), ['A']); // 0 m, loops to itself
    net.register(a);
    const t = new PathTraveler('agv1', a, net);
    t.v = 1000 * 60;
    t.advance(1 / 60); // must terminate via the carry guard
    expect(Number.isFinite(t.s)).toBe(true);
  });

  it('pose: position on path + lookRotation(tangent, align)', () => {
    const p = linePath('P', v3(0, 0, 0), v3(4, 0, 0)); // travel along +X
    const t = new PathTraveler('agv1', p, null);
    t.s = 1;
    const pos = new Vector3();
    const quat = new Quaternion();
    t.getPose(pos, quat);
    expect(pos.distanceTo(v3(1, 0, 0))).toBeLessThan(1e-9);
    // local +Z must point along the tangent (+X)
    const fwd = v3(0, 0, 1).applyQuaternion(quat);
    expect(fwd.distanceTo(v3(1, 0, 0))).toBeLessThan(1e-9);
    // local +Y stays up
    const up = v3(0, 1, 0).applyQuaternion(quat);
    expect(up.distanceTo(v3(0, 1, 0))).toBeLessThan(1e-9);
  });
});
