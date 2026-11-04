// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-664 §9.2 — the ray basis.
 *
 * The fan, the slab test, the dead zone, the no-hit sentinel and the nearest-hit
 * rule, plus the two properties the rest of the plan leans on: the result is
 * EXACTLY what a brute-force cast would give (so the broad-phase can never
 * silently lose an obstacle), and the hot path allocates nothing.
 */

import { describe, it, expect } from 'vitest';
import {
  buildFan, castFan, raySlab, minRange,
  BOX_STRIDE, HIT_AGV, HIT_MU, HIT_NONE, HIT_TARGET, NO_HIT, type BoxBuffer,
} from '../src/core/engine/rv-ray-scan';
import { mulberry32 } from '../src/core/engine/rv-prng';
import { collectCandidates, fanBounds, makeBoxBuffer, type MuLike } from '../src/core/engine/rv-ray-scene-query';

const FWD = [0, 0, 1];
const RIGHT = [1, 0, 0];
const ORIGIN = [0, 0, 0];

/** A box buffer from `[minX,minY,minZ,maxX,maxY,maxZ,kind]` tuples. */
function boxes(...rows: number[][]): BoxBuffer {
  const b: BoxBuffer = {
    bounds: new Float32Array(rows.length * BOX_STRIDE),
    kinds: new Uint8Array(rows.length),
    count: rows.length,
  };
  rows.forEach((r, i) => { b.bounds.set(r.slice(0, 6), i * BOX_STRIDE); b.kinds[i] = r[6]; });
  return b;
}

/** Brute force oracle: nearest hit per ray, no early-out, no broad-phase. */
function bruteForce(
  angles: Float32Array, rangeMin: number, rangeMax: number, b: BoxBuffer,
): number[] {
  const out: number[] = [];
  for (let i = 0; i < angles.length; i++) {
    const a = angles[i];
    const d = [Math.sin(a), 0, Math.cos(a)];
    let best = Infinity;
    for (let j = 0; j < b.count; j++) {
      const t = raySlab(0, 0, 0, 1 / d[0], 1 / d[1], 1 / d[2], Infinity, b.bounds, j * BOX_STRIDE);
      if (t >= 0 && t < best) best = t;
    }
    out.push(best > rangeMax || best < rangeMin ? NO_HIT : best);
  }
  return out;
}

describe('buildFan', () => {
  it('270 deg at 1 deg gives 271 rays, symmetric around forward, both edges real', () => {
    const a = buildFan(270, 1);
    expect(a.length).toBe(271);
    expect(a[0]).toBeCloseTo(-(135 * Math.PI) / 180, 6);
    expect(a[270]).toBeCloseTo((135 * Math.PI) / 180, 6);
    expect(a[135]).toBeCloseTo(0, 6);
    for (let i = 1; i < a.length; i++) expect(a[i]).toBeGreaterThan(a[i - 1]);
  });

  it('a rangefinder is a fan of one: fov 0 or res 0 gives the single forward ray', () => {
    expect(Array.from(buildFan(0, 1))).toEqual([0]);
    expect(Array.from(buildFan(270, 0))).toEqual([0]);
    expect(Array.from(buildFan(-10, 1))).toEqual([0]);
  });

  it('the count follows floor(fov / res) + 1', () => {
    expect(buildFan(180, 0.5).length).toBe(361);
    expect(buildFan(90, 10).length).toBe(10);
    expect(buildFan(10, 3).length).toBe(4);
  });
});

describe('castFan — geometry', () => {
  it('the fan hits the nearest box, reads -1 on a miss, and respects the dead zone', () => {
    const angles = buildFan(270, 1);                       // 271 rays
    const ranges = new Float32Array(angles.length);
    const kinds = new Uint8Array(angles.length);
    // A 1 m wide box 2 m straight ahead, and a far box behind it.
    const b = boxes(
      [-0.5, -1, 2, 0.5, 1, 2.5, HIT_MU],
      [-0.5, -1, 5, 0.5, 1, 5.5, HIT_AGV],
    );
    castFan(ORIGIN, FWD, RIGHT, angles, 0.02, 8, b, ranges, kinds);
    expect(ranges[135]).toBeCloseTo(2.0, 6);               // straight ahead
    expect(kinds[135]).toBe(HIT_MU);                       // the NEAR one, not the far one
    expect(ranges[0]).toBe(NO_HIT);                        // -135 deg sees nothing
    expect(kinds[0]).toBe(HIT_NONE);
    expect(minRange(ranges)).toBeCloseTo(2.0, 6);
  });

  it('a hit closer than rangeMin is the dead zone, not a reading', () => {
    const angles = buildFan(0, 0);
    const ranges = new Float32Array(1);
    const kinds = new Uint8Array(1);
    const b = boxes([-1, -1, 0.01, 1, 1, 0.05, HIT_MU]);
    castFan(ORIGIN, FWD, RIGHT, angles, 0.1, 8, b, ranges, kinds);
    expect(ranges[0]).toBe(NO_HIT);
    // Move it out of the dead zone and it is seen.
    const b2 = boxes([-1, -1, 0.2, 1, 1, 0.5, HIT_MU]);
    castFan(ORIGIN, FWD, RIGHT, angles, 0.1, 8, b2, ranges, kinds);
    expect(ranges[0]).toBeCloseTo(0.2, 6);
  });

  it('a box beyond rangeMax is not seen', () => {
    const angles = buildFan(0, 0);
    const ranges = new Float32Array(1);
    const kinds = new Uint8Array(1);
    const b = boxes([-1, -1, 9, 1, 1, 10, HIT_TARGET]);
    castFan(ORIGIN, FWD, RIGHT, angles, 0.02, 8, b, ranges, kinds);
    expect(ranges[0]).toBe(NO_HIT);
    castFan(ORIGIN, FWD, RIGHT, angles, 0.02, 12, b, ranges, kinds);
    expect(ranges[0]).toBeCloseTo(9, 6);
    expect(kinds[0]).toBe(HIT_TARGET);
  });

  it('a ray outside the box height misses it (the slab test is 3D, not a floor plan)', () => {
    const angles = buildFan(0, 0);
    const ranges = new Float32Array(1);
    const kinds = new Uint8Array(1);
    // Box between y = 1 and y = 2; the sensor sits at y = 0 and looks level.
    const b = boxes([-1, 1, 2, 1, 2, 3, HIT_MU]);
    castFan(ORIGIN, FWD, RIGHT, angles, 0.02, 8, b, ranges, kinds);
    expect(ranges[0]).toBe(NO_HIT);
    castFan([0, 1.5, 0], FWD, RIGHT, angles, 0.02, 8, b, ranges, kinds);
    expect(ranges[0]).toBeCloseTo(2, 6);
  });

  it('the sensor basis orients the fan: turning it 90 deg moves the hit to another ray', () => {
    const angles = buildFan(180, 1);                      // 181 rays, index 90 = forward
    const ranges = new Float32Array(angles.length);
    const kinds = new Uint8Array(angles.length);
    const b = boxes([-0.25, -1, 2, 0.25, 1, 2.5, HIT_MU]);
    castFan(ORIGIN, FWD, RIGHT, angles, 0.02, 8, b, ranges, kinds);
    expect(ranges[90]).toBeCloseTo(2, 6);
    // Forward now +X, right now -Z: the same box lies 90 deg to the left.
    castFan(ORIGIN, [1, 0, 0], [0, 0, -1], angles, 0.02, 8, b, ranges, kinds);
    expect(ranges[90]).toBe(NO_HIT);
    expect(ranges[0]).toBeCloseTo(2, 6);
  });

  it('a sensor INSIDE a box reads its dead zone, never a negative or NaN distance', () => {
    const angles = buildFan(90, 10);
    const ranges = new Float32Array(angles.length);
    const kinds = new Uint8Array(angles.length);
    const b = boxes([-1, -1, -1, 1, 1, 1, HIT_MU]);
    castFan(ORIGIN, FWD, RIGHT, angles, 0.05, 8, b, ranges, kinds);
    for (let i = 0; i < ranges.length; i++) {
      expect(ranges[i]).toBe(NO_HIT);                      // t = 0 < rangeMin
      expect(Number.isNaN(ranges[i])).toBe(false);
    }
  });

  it('no candidates at all means every ray misses', () => {
    const angles = buildFan(270, 1);
    const ranges = new Float32Array(angles.length).fill(42);
    const kinds = new Uint8Array(angles.length).fill(9);
    castFan(ORIGIN, FWD, RIGHT, angles, 0.02, 8, { bounds: new Float32Array(0), kinds: new Uint8Array(0), count: 0 }, ranges, kinds);
    for (let i = 0; i < ranges.length; i++) { expect(ranges[i]).toBe(NO_HIT); expect(kinds[i]).toBe(HIT_NONE); }
    expect(minRange(ranges)).toBe(NO_HIT);
  });

  /**
   * plan-664 Phase 2 regression — the slab test's NaN hole.
   *
   * A ray parallel to an axis has `d = 0` on it, so the textbook `1 / d` is ±∞;
   * if the ray ALSO starts exactly on one of the box's faces on that axis, the
   * slab term is `0 * ∞ = NaN`, every comparison against it is false, and the
   * box is silently rejected. This is not a corner case in this plan: the
   * acceptance scene is a floor-height scanner against a crate whose box starts
   * at y = 0, which is EXACTLY that geometry. Found when the component layer
   * measured its first crate and saw nothing.
   */
  it('a ray lying in a box face plane still hits it (no 0 * Infinity)', () => {
    // Fan in the y = 0 plane; the crate spans y = 0 .. 1, so the ray runs along
    // its bottom face.
    const onFace = boxes([-0.5, 0, 1.5, 0.5, 1, 2.5, HIT_MU]);
    const ranges = new Float32Array(1);
    const kinds = new Uint8Array(1);
    castFan(ORIGIN, FWD, RIGHT, buildFan(0, 0), 0.02, 8, onFace, ranges, kinds);
    expect(Number.isNaN(ranges[0])).toBe(false);
    expect(ranges[0]).toBeCloseTo(1.5, 6);
    expect(kinds[0]).toBe(HIT_MU);

    // The same for the TOP face, and for a box the ray passes beside in y.
    const topFace = boxes([-0.5, -1, 1.5, 0.5, 0, 2.5, HIT_MU]);
    castFan(ORIGIN, FWD, RIGHT, buildFan(0, 0), 0.02, 8, topFace, ranges, kinds);
    expect(ranges[0]).toBeCloseTo(1.5, 6);
    const above = boxes([-0.5, 0.5, 1.5, 0.5, 1, 2.5, HIT_MU]);
    castFan(ORIGIN, FWD, RIGHT, buildFan(0, 0), 0.02, 8, above, ranges, kinds);
    expect(ranges[0]).toBe(NO_HIT);
  });

  it('raySlab treats a parallel axis symmetrically on both faces', () => {
    // Ray along +Z at the origin: X and Y are parallel axes. The box spans
    // y = -1 .. 0, so oy = 0 sits in its FAR face plane; the near-face case is
    // covered above, and the two must agree or a grazing ray would hit through
    // one face and miss through the other.
    const far = new Float32Array([-0.5, -1, 1.5, 0.5, 0, 2.5]);
    const near = new Float32Array([-0.5, 0, 1.5, 0.5, 1, 2.5]);
    expect(raySlab(0, 0, 0, Infinity, Infinity, 1, 8, far, 0)).toBeCloseTo(1.5, 6);
    expect(raySlab(0, 0, 0, Infinity, Infinity, 1, 8, near, 0)).toBeCloseTo(1.5, 6);
    // Strictly outside the parallel slab stays a miss.
    expect(raySlab(0, 0.5, 0, Infinity, Infinity, 1, 8, far, 0)).toBe(NO_HIT);
    expect(raySlab(0, -0.5, 0, Infinity, Infinity, 1, 8, near, 0)).toBe(NO_HIT);
  });
});

describe('castFan — contracts the rest of the plan relies on', () => {
  it('matches a brute-force cast exactly over 200 random boxes', () => {
    const rnd = mulberry32(664);
    const rows: number[][] = [];
    for (let i = 0; i < 200; i++) {
      const cx = (rnd() - 0.5) * 16;
      const cz = (rnd() - 0.5) * 16;
      const hx = 0.1 + rnd() * 0.6;
      const hz = 0.1 + rnd() * 0.6;
      rows.push([cx - hx, -1, cz - hz, cx + hx, 1, cz + hz, HIT_MU]);
    }
    const b = boxes(...rows);
    const angles = buildFan(270, 1);
    const ranges = new Float32Array(angles.length);
    const kinds = new Uint8Array(angles.length);
    castFan(ORIGIN, FWD, RIGHT, angles, 0.02, 8, b, ranges, kinds);
    const want = bruteForce(angles, 0.02, 8, b);
    for (let i = 0; i < angles.length; i++) {
      if (want[i] === NO_HIT) expect(ranges[i]).toBe(NO_HIT);
      else expect(ranges[i]).toBeCloseTo(want[i], 5);
    }
  });

  it('the box ORDER does not change the result (the nearest hit wins, not the first)', () => {
    const angles = buildFan(60, 2);
    const near = [-0.5, -1, 2, 0.5, 1, 2.5, HIT_MU];
    const far = [-0.5, -1, 5, 0.5, 1, 5.5, HIT_AGV];
    const a = new Float32Array(angles.length);
    const b2 = new Float32Array(angles.length);
    const ka = new Uint8Array(angles.length);
    const kb = new Uint8Array(angles.length);
    castFan(ORIGIN, FWD, RIGHT, angles, 0.02, 8, boxes(near, far), a, ka);
    castFan(ORIGIN, FWD, RIGHT, angles, 0.02, 8, boxes(far, near), b2, kb);
    expect(Array.from(b2)).toEqual(Array.from(a));
    expect(Array.from(kb)).toEqual(Array.from(ka));
  });

  it('the hot path allocates nothing: the caller buffers are written in place', () => {
    const angles = buildFan(270, 1);
    const ranges = new Float32Array(angles.length);
    const kinds = new Uint8Array(angles.length);
    const b = boxes([-0.5, -1, 2, 0.5, 1, 2.5, HIT_MU]);
    const rBuf = ranges.buffer;
    const kBuf = kinds.buffer;
    for (let i = 0; i < 500; i++) castFan(ORIGIN, FWD, RIGHT, angles, 0.02, 8, b, ranges, kinds);
    expect(ranges.buffer).toBe(rBuf);   // identity, not a replacement
    expect(kinds.buffer).toBe(kBuf);
    expect(ranges[135]).toBeCloseTo(2, 6);
  });

  it('a fan of one (rangefinder) and the middle ray of a wide fan agree', () => {
    const b = boxes([-0.5, -1, 2, 0.5, 1, 2.5, HIT_MU], [-4, -1, -1, -2, 1, 1, HIT_AGV]);
    const one = buildFan(0, 0);
    const r1 = new Float32Array(1);
    const k1 = new Uint8Array(1);
    castFan(ORIGIN, FWD, RIGHT, one, 0.02, 8, b, r1, k1);
    const wide = buildFan(270, 1);
    const rw = new Float32Array(wide.length);
    const kw = new Uint8Array(wide.length);
    castFan(ORIGIN, FWD, RIGHT, wide, 0.02, 8, b, rw, kw);
    expect(r1[0]).toBeCloseTo(rw[135], 6);
    expect(k1[0]).toBe(kw[135]);
  });

  it('is deterministic: the same inputs give bit-identical output', () => {
    const angles = buildFan(270, 1);
    const b = boxes([-0.5, -1, 2, 0.5, 1, 2.5, HIT_MU], [-3, -1, 1, -1, 1, 3, HIT_AGV]);
    const run = (): number[] => {
      const r = new Float32Array(angles.length);
      const k = new Uint8Array(angles.length);
      castFan(ORIGIN, FWD, RIGHT, angles, 0.02, 8, b, r, k);
      return Array.from(r);
    };
    expect(run()).toEqual(run());
  });
});

// ── Candidate collection (plan-664 §9.2: self-exclusion, broad-phase parity) ──

describe('rv-ray-scene-query — what a sensor is allowed to see', () => {
  /** A node-like object with a parent chain — all `isInSubtree` needs. */
  function node(parent: NodeLike | null = null): NodeLike {
    const n: NodeLike = { parent };
    return n;
  }
  interface NodeLike { parent: NodeLike | null }

  function mu(cx: number, cz: number, owner: NodeLike | null = null): MuLike {
    return {
      aabb: { min: { x: cx - 0.5, y: 0, z: cz - 0.5 }, max: { x: cx + 0.5, y: 1, z: cz + 0.5 } },
      node: owner as unknown as MuLike['node'],
    };
  }

  const bounds = (reach: number): [Float64Array, Float64Array] => {
    const min = new Float64Array(3);
    const max = new Float64Array(3);
    fanBounds([0, 0.2, 0], reach, 2, min, max);
    return [min, max];
  };

  it('skips the whole subtree of the own vehicle root — own body AND carried load', () => {
    const vehicle = node();
    const fork = node(vehicle);
    const carried = node(fork);          // a pallet on the forks, parented into the vehicle
    const foreign = node();
    const all = [mu(1, 0, carried), mu(2, 0, foreign), mu(3, 0, vehicle)];
    const [min, max] = bounds(8);
    const buf = collectCandidates(makeBoxBuffer(4), {
      queryMUs: (_mn, _mx, out) => { out.length = 0; out.push(...all); return all.length; },
    }, vehicle as unknown as Parameters<typeof collectCandidates>[2], min, max);
    expect(buf.count).toBe(1);           // only the foreign MU survives
    expect(buf.bounds[0]).toBeCloseTo(1.5, 6);
    expect(buf.kinds[0]).toBe(HIT_MU);
  });

  it('without a self root nothing is excluded', () => {
    const all = [mu(1, 0, node()), mu(2, 0, node())];
    const [min, max] = bounds(8);
    const buf = collectCandidates(makeBoxBuffer(1), {
      queryMUs: (_mn, _mx, out) => { out.length = 0; out.push(...all); return all.length; },
    }, null, min, max);
    expect(buf.count).toBe(2);
  });

  it('the broad-phase result equals the brute-force set (a sensor can never lose an obstacle)', () => {
    const rnd = mulberry32(42);
    const all: MuLike[] = [];
    for (let i = 0; i < 300; i++) all.push(mu((rnd() - 0.5) * 40, (rnd() - 0.5) * 40, node()));
    const reach = 8;
    const [min, max] = bounds(reach);
    // "Broad-phase": only the MUs whose XZ footprint meets the fan box.
    const broad = collectCandidates(makeBoxBuffer(8), {
      queryMUs: (mn, mx, out) => {
        out.length = 0;
        for (const m of all) {
          if (m.aabb.max.x < mn[0] || m.aabb.min.x > mx[0]) continue;
          if (m.aabb.max.z < mn[2] || m.aabb.min.z > mx[2]) continue;
          out.push(m);
        }
        return out.length;
      },
    }, null, min, max);
    // Brute force: EVERY MU handed through, no filtering at all.
    const brute = collectCandidates(makeBoxBuffer(8), {
      queryMUs: (_mn, _mx, out) => { out.length = 0; out.push(...all); return all.length; },
    }, null, min, max);
    expect(broad.count).toBeLessThan(brute.count);   // the broad-phase really narrowed it

    const angles = buildFan(270, 1);
    const rB = new Float32Array(angles.length);
    const kB = new Uint8Array(angles.length);
    const rF = new Float32Array(angles.length);
    const kF = new Uint8Array(angles.length);
    castFan([0, 0.2, 0], FWD, RIGHT, angles, 0.02, reach, broad, rB, kB);
    castFan([0, 0.2, 0], FWD, RIGHT, angles, 0.02, reach, brute, rF, kF);
    expect(Array.from(rB)).toEqual(Array.from(rF));  // identical readings, not merely similar
    expect(Array.from(kB)).toEqual(Array.from(kF));
  });

  it('the buffer grows to fit and is then reused (no reallocation in steady state)', () => {
    const all: MuLike[] = [];
    for (let i = 0; i < 50; i++) all.push(mu(i * 0.2 - 5, 0, node()));
    const [min, max] = bounds(8);
    const buf = makeBoxBuffer(2);
    const sources = { queryMUs: (_mn: ArrayLike<number>, _mx: ArrayLike<number>, out: MuLike[]): number => { out.length = 0; out.push(...all); return all.length; } };
    collectCandidates(buf, sources, null, min, max);
    expect(buf.count).toBe(50);
    const bounds0 = buf.bounds;
    for (let i = 0; i < 100; i++) collectCandidates(buf, sources, null, min, max);
    expect(buf.bounds).toBe(bounds0);
    expect(buf.count).toBe(50);
  });
});
