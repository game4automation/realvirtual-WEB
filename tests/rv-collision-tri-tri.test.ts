// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-781 §9.1 — the triangle–triangle PENETRATION test.
 *
 * Only real penetration counts (Vincent, 2026-11-05): touching within
 * `TOUCH_EPS`, coplanar flush faces and an edge merely crossing an edge are no
 * hit. The differential case compares against three-mesh-bvh's
 * `ExtendedTriangle.intersectsTriangle` — imported HERE only, never by the
 * collision path (rule 15, guard `rv-collision-no-structure.node.test.ts`) —
 * on random pairs with the touching and coplanar classes excluded.
 */
import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { ExtendedTriangle } from 'three-mesh-bvh';
import { TOUCH_EPS, touchEpsFor, trianglesPenetrate } from '../src/core/engine/rv-collision-tri-tri';
import { makeRandom } from './helpers/seeded-random';

type V = [number, number, number];

function tri(p: V, q: V, r: V): Float64Array {
  return Float64Array.from([...p, ...q, ...r]);
}

function hit(a: Float64Array, b: Float64Array, eps = TOUCH_EPS): boolean {
  return trianglesPenetrate(a, 0, b, 0, eps);
}

/** A horizontal triangle at height z (large, around the origin). */
const floor = (z = 0): Float64Array => tri([-1, -1, z], [1, -1, z], [0, 1.5, z]);
/** A vertical triangle in the plane y = 0 reaching from z0 up to z1. */
const wall = (z0: number, z1: number): Float64Array => tri([-0.5, 0, z0], [0.5, 0, z0], [0, 0, z1]);

describe('trianglesPenetrate', () => {
  it('a crossing pair hits; a separated pair misses', () => {
    expect(hit(floor(), wall(-0.5, 0.5))).toBe(true);
    expect(hit(floor(), wall(0.1, 1))).toBe(false);
    expect(hit(floor(), wall(-1, -0.1))).toBe(false);
  });

  it('coplanar overlapping triangles never count (flush faces)', () => {
    const a = floor(0);
    const b = tri([-0.5, -0.5, 0], [0.5, -0.5, 0], [0, 0.5, 0]);
    expect(hit(a, b)).toBe(false);
    // ... also within the tolerance of being coplanar.
    const c = tri([-0.5, -0.5, 4e-6], [0.5, -0.5, -4e-6], [0, 0.5, 2e-6]);
    expect(hit(a, c)).toBe(false);
  });

  it('touching within TOUCH_EPS misses; 10 × TOUCH_EPS penetration hits', () => {
    // A wall resting ON the floor, its bottom edge at 0.5 eps below.
    expect(hit(floor(), wall(-0.5 * TOUCH_EPS, 1))).toBe(false);
    // Exactly on the plane.
    expect(hit(floor(), wall(0, 1))).toBe(false);
    // Pushed 10 eps through.
    expect(hit(floor(), wall(-10 * TOUCH_EPS, 1))).toBe(true);
  });

  it('edge-on-edge contact is touching, not penetration', () => {
    // Two triangles in perpendicular planes whose edges cross at one point.
    const a = tri([-1, 0, 0], [1, 0, 0], [0, 0, 1]);            // in y = 0, above z = 0
    const b = tri([0, -1, 0], [0, 1, 0], [0, 0, -1]);           // in x = 0, below z = 0
    expect(hit(a, b)).toBe(false);
  });

  it('degenerate (zero-area) triangles and NaN / Infinity input return false without throwing', () => {
    const line = tri([0, 0, 0], [1, 0, 0], [2, 0, 0]);
    expect(hit(floor(), line)).toBe(false);
    expect(hit(line, floor())).toBe(false);
    const nan = tri([NaN, 0, 0], [1, 0, 0], [0, 1, 0]);
    expect(() => hit(nan, wall(-1, 1))).not.toThrow();
    expect(hit(nan, wall(-1, 1))).toBe(false);
    expect(hit(wall(-1, 1), tri([Infinity, 0, 0], [1, 0, 0], [0, 1, 0]))).toBe(false);
  });

  it('is winding-independent (a mirrored transform needs no re-ordering)', () => {
    const a = floor();
    const b = wall(-0.5, 0.5);
    const bRev = tri([b[6], b[7], b[8]], [b[3], b[4], b[5]], [b[0], b[1], b[2]]);
    expect(hit(a, bRev)).toBe(true);
    // det < 0: mirror both through x → still the same answer.
    const mirror = (t: Float64Array): Float64Array => Float64Array.from(t, (v, i) => (i % 3 === 0 ? -v : v));
    expect(hit(mirror(a), mirror(b))).toBe(true);
    expect(hit(mirror(a), mirror(wall(0.1, 1)))).toBe(false);
  });

  it('touchEpsFor grows with the coordinate magnitude (F20)', () => {
    expect(touchEpsFor(0)).toBe(TOUCH_EPS);
    expect(touchEpsFor(1)).toBe(TOUCH_EPS);
    expect(touchEpsFor(1000)).toBeGreaterThan(TOUCH_EPS * 50);
    expect(touchEpsFor(-1000)).toBe(touchEpsFor(1000));
  });

  it('agrees with ExtendedTriangle.intersectsTriangle on 10k random pairs (touching / coplanar excluded)', () => {
    const rnd = makeRandom(781);
    const ta = new ExtendedTriangle();
    const tb = new ExtendedTriangle();
    const va = [new Vector3(), new Vector3(), new Vector3()];
    const vb = [new Vector3(), new Vector3(), new Vector3()];
    const buf = new Float64Array(18);
    let compared = 0;
    let hits = 0;
    let disagreements = 0;
    const margin = 1e-3;

    /** Min |signed distance| of the three vertices to the plane of the other triangle. */
    const minPlaneDistance = (p: Vector3[], q: Vector3[]): number => {
      const n = new Vector3().subVectors(q[1], q[0]).cross(new Vector3().subVectors(q[2], q[0]));
      const len = n.length();
      if (len < 1e-9) return 0;
      n.divideScalar(len);
      let m = Infinity;
      for (const v of p) m = Math.min(m, Math.abs(n.dot(new Vector3().subVectors(v, q[0]))));
      return m;
    };

    for (let i = 0; i < 10_000; i++) {
      for (let k = 0; k < 3; k++) {
        va[k].set(rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1);
        vb[k].set(rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1);
      }
      // Exclude the classes where the two definitions differ on purpose.
      if (minPlaneDistance(va, vb) < margin || minPlaneDistance(vb, va) < margin) continue;
      ta.set(va[0], va[1], va[2]);
      tb.set(vb[0], vb[1], vb[2]);
      ta.needsUpdate = true;
      tb.needsUpdate = true;
      const ref = ta.intersectsTriangle(tb);
      for (let k = 0; k < 3; k++) {
        buf[k * 3] = va[k].x; buf[k * 3 + 1] = va[k].y; buf[k * 3 + 2] = va[k].z;
        buf[9 + k * 3] = vb[k].x; buf[9 + k * 3 + 1] = vb[k].y; buf[9 + k * 3 + 2] = vb[k].z;
      }
      const ours = trianglesPenetrate(buf, 0, buf, 9, TOUCH_EPS);
      compared++;
      if (ref) hits++;
      if (ours !== ref) disagreements++;
    }
    expect(compared).toBeGreaterThan(5000);
    expect(hits).toBeGreaterThan(100);
    // Edge-on-edge grazes (overlap < eps) are the only remaining legal difference.
    expect(disagreements).toBeLessThanOrEqual(2);
  });
});
