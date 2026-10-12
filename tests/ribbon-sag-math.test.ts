// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * ribbon-sag-math.test.ts — the slack-web profile (plan-471 Phase 1 + Auflage A4).
 *
 * `SAG_C1` is an analytic second-order coefficient, so it is checked against a
 * NUMERICAL quadrature of the true arc length rather than against itself — a
 * test that recomputed the same closed form would pass for a transcription
 * error in either place.
 */

import { describe, it, expect } from 'vitest';
import {
  distributeExcess,
  isSagEstimated,
  lineTangentAfterSag,
  perpGravity,
  SAG_C1,
  SAG_ESTIMATED_RATIO,
  sagDepth,
  sagExcess,
  sagProfile,
  sagProfileDerivative,
  type SagVec3,
} from '../src/core/engine/ribbon/ribbon-sag-math';

/** Composite Simpson over `[0, 1]` with an even number of intervals. */
function simpson(f: (s: number) => number, n = 20000): number {
  const h = 1 / n;
  let sum = f(0) + f(1);
  for (let i = 1; i < n; i++) sum += (i % 2 ? 4 : 2) * f(i * h);
  return (sum * h) / 3;
}

/** The TRUE arc length of the sagging line, by quadrature of |dp/ds|. */
function numericArc(lengthMm: number, depthMm: number): number {
  return simpson((s) => Math.hypot(lengthMm, sagProfileDerivative(s, depthMm)));
}

describe('the sag profile', () => {
  it('starts and ends on the chord', () => {
    expect(sagProfile(0, 50)).toBe(0);
    expect(sagProfile(1, 50)).toBe(0);
  });

  it('reaches exactly the requested depth at the midpoint', () => {
    expect(sagProfile(0.5, 50)).toBeCloseTo(50, 12);
    expect(sagProfile(0.5, 7.25)).toBeCloseTo(7.25, 12);
  });

  it('leaves both contact points ALONG the chord — no kink at the roller', () => {
    // This is the whole reason the profile is a quartic and not 4s(1-s).
    // `toBeCloseTo` rather than `toBe`: the product ends on a signed zero at
    // s = 1, and -0 is not +0 under `Object.is`.
    expect(sagProfileDerivative(0, 50)).toBeCloseTo(0, 15);
    expect(sagProfileDerivative(1, 50)).toBeCloseTo(0, 15);
    // ... and a parabola would not: 4*d*(1-2s) is 4d at s = 0.
    expect(sagProfileDerivative(0.5, 50)).toBeCloseTo(0, 15);
  });

  it('matches a numerical derivative of the profile in between', () => {
    const h = 1e-6;
    for (const s of [0.1, 0.25, 0.4, 0.6, 0.9]) {
      const numeric = (sagProfile(s + h, 30) - sagProfile(s - h, 30)) / (2 * h);
      expect(sagProfileDerivative(s, 30)).toBeCloseTo(numeric, 6);
    }
  });

  it('ignores non-finite arguments instead of producing NaN geometry', () => {
    expect(sagProfile(Number.NaN, 50)).toBe(0);
    expect(sagProfileDerivative(0.5, Number.NaN)).toBe(0);
  });
});

describe('SAG_C1', () => {
  it('is 256 / 105', () => {
    expect(SAG_C1).toBe(256 / 105);
    expect(SAG_C1).toBeCloseTo(2.4380952380952383, 15);
  });

  it('is the limit of the numerical excess as d/L goes to zero', () => {
    // At d/L = 1e-3 the neglected fourth-order term is ~1e-6 relative, and the
    // quadrature of a near-straight line cannot resolve more than that either:
    // the excess is a 1e-6 difference of two numbers of order 1000.
    const L = 1000;
    const d = 1;
    const numeric = numericArc(L, d) - L;
    expect((numeric * L) / (d * d)).toBeCloseTo(SAG_C1, 5);
  });
});

describe('the length contract', () => {
  it('round-trips depth -> excess -> depth', () => {
    for (const [L, d] of [[800, 20], [1000, 50], [250, 12.5]]) {
      const excess = sagExcess(d, L);
      expect(sagDepth(excess, L)).toBeCloseTo(d, 9);
    }
  });

  it('is within the advertised error over the whole usable range (A4)', () => {
    // The numbers the plan and Auflage A4 are written from.
    const L = 1;
    const expected: Array<[number, number]> = [
      [0.05, 0.5],   // ratio, max relative error of the EXCESS in percent
      [0.10, 2.0],
      [0.17, 5.0],
    ];
    for (const [ratio, maxPercent] of expected) {
      const numeric = numericArc(L, ratio) - L;
      const formula = sagExcess(ratio, L);
      const errorPercent = ((formula - numeric) / numeric) * 100;
      expect(errorPercent).toBeGreaterThan(0);      // the formula always over-estimates
      expect(errorPercent).toBeLessThan(maxPercent);
    }
  });

  it('crosses the 5 % excess error just above the estimated threshold (A4)', () => {
    const L = 1;
    const errorAt = (ratio: number): number => {
      const numeric = numericArc(L, ratio) - L;
      return ((sagExcess(ratio, L) - numeric) / numeric) * 100;
    };
    // 4.9 % at the threshold, 5.4 % just past it: the threshold is the last
    // ratio that is still inside the 5 % budget.
    expect(errorAt(SAG_ESTIMATED_RATIO)).toBeLessThan(5);
    expect(errorAt(SAG_ESTIMATED_RATIO + 0.01)).toBeGreaterThan(5);
    // The two headline numbers of the plan, reproduced.
    expect(errorAt(0.2)).toBeCloseTo(6.63, 1);
    const arc25 = numericArc(L, 0.25);
    expect(((sagExcess(0.25, L) - (arc25 - L)) / arc25) * 100).toBeCloseTo(1.2, 1);
  });

  it('flags a depth past the threshold as estimated', () => {
    expect(SAG_ESTIMATED_RATIO).toBe(0.17);
    expect(isSagEstimated(16, 100)).toBe(false);
    expect(isSagEstimated(17, 100)).toBe(false);
    expect(isSagEstimated(18, 100)).toBe(true);
    expect(isSagEstimated(10, 0)).toBe(false);
  });

  it('caps the depth at half the chord without capping anything else', () => {
    // An absurd excess: the quartic would become a spike through the machine.
    expect(sagDepth(1e9, 800)).toBe(400);
    expect(sagDepth(0, 800)).toBe(0);
    expect(sagDepth(-5, 800)).toBe(0);
    expect(sagDepth(10, 0)).toBe(0);
  });
});

describe('perpGravity', () => {
  const out: SagVec3 = { x: 0, y: 0, z: 0 };
  const g: SagVec3 = { x: 0, y: -9810, z: 0 };

  it('is gravity itself on a horizontal chord', () => {
    const magnitude = perpGravity(g, { x: 1, y: 0, z: 0 }, out);
    expect(magnitude).toBeCloseTo(9810, 6);
    expect(out).toEqual({ x: 0, y: -1, z: 0 });
  });

  it('keeps only the perpendicular part on a slanted chord', () => {
    // A 45 degree chord: half the magnitude survives.
    const magnitude = perpGravity(g, { x: 1, y: 1, z: 0 }, out);
    expect(magnitude).toBeCloseTo(9810 / Math.SQRT2, 6);
    // The direction is perpendicular to the chord and points downwards.
    expect(out.x * 1 + out.y * 1).toBeCloseTo(0, 12);
    expect(out.y).toBeLessThan(0);
    expect(Math.hypot(out.x, out.y, out.z)).toBeCloseTo(1, 12);
  });

  it('vanishes on a vertical chord — there is no direction to sag in', () => {
    expect(perpGravity(g, { x: 0, y: 1, z: 0 }, out)).toBe(0);
    expect(out).toEqual({ x: 0, y: 0, z: 0 });
    expect(perpGravity(g, { x: 0, y: -1, z: 0 }, out)).toBe(0);
  });

  it('rejects a degenerate chord', () => {
    expect(perpGravity(g, { x: 0, y: 0, z: 0 }, out)).toBe(0);
  });

  it('follows a rotated frame (A2 in one dimension)', () => {
    // Gravity expressed in a frame rotated 90 degrees about Z: what was -Y is
    // now +X, and a chord along the frame's Y then sags along its +X.
    const rotatedG: SagVec3 = { x: 9810, y: 0, z: 0 };
    const magnitude = perpGravity(rotatedG, { x: 0, y: 1, z: 0 }, out);
    expect(magnitude).toBeCloseTo(9810, 6);
    expect(out).toEqual({ x: 1, y: 0, z: 0 });
  });
});

describe('distributeExcess', () => {
  const out: number[] = [];

  it('splits proportionally to the segment lengths', () => {
    distributeExcess([100, 300], 40, out);
    expect(out[0]).toBeCloseTo(10, 12);
    expect(out[1]).toBeCloseTo(30, 12);
  });

  it('sums to the excess EXACTLY, not approximately', () => {
    const lengths = [173.13, 91.7, 1237.994, 0.3, 55];
    distributeExcess(lengths, 7.3, out);
    let sum = 0;
    for (let i = 0; i < lengths.length; i++) sum += out[i];
    // Exact equality: the last non-empty entry takes the rounding remainder.
    expect(sum).toBe(7.3);
  });

  it('gives zero-length and non-finite segments nothing', () => {
    distributeExcess([0, 200, Number.NaN, 200], 10, out);
    expect(out[0]).toBe(0);
    expect(out[2]).toBe(0);
    expect(out[1] + out[3]).toBe(10);
  });

  it('writes zeros when there is no excess or no usable segment', () => {
    distributeExcess([100, 200], 0, out);
    expect(out.slice(0, 2)).toEqual([0, 0]);
    distributeExcess([0, 0], 10, out);
    expect(out.slice(0, 2)).toEqual([0, 0]);
    expect(distributeExcess([], 10, out)).toBe(0);
  });
});

describe('lineTangentAfterSag (A3)', () => {
  const chord: SagVec3 = { x: 1, y: 0, z: 0 };
  const sagDir: SagVec3 = { x: 0, y: -1, z: 0 };
  const out: SagVec3 = { x: 0, y: 0, z: 0 };

  it('is exactly the chord at both contact points', () => {
    lineTangentAfterSag(chord, sagDir, 0, 40, 800, out);
    expect(out).toEqual({ x: 1, y: 0, z: 0 });
    lineTangentAfterSag(chord, sagDir, 1, 40, 800, out);
    expect(out).toEqual({ x: 1, y: 0, z: 0 });
  });

  it('is the chord again at the lowest point', () => {
    lineTangentAfterSag(chord, sagDir, 0.5, 40, 800, out);
    expect(out.x).toBeCloseTo(1, 12);
    expect(out.y).toBeCloseTo(0, 12);
  });

  it('points downwards on the way in and upwards on the way out', () => {
    lineTangentAfterSag(chord, sagDir, 0.25, 40, 800, out);
    expect(out.y).toBeLessThan(0);
    lineTangentAfterSag(chord, sagDir, 0.75, 40, 800, out);
    expect(out.y).toBeGreaterThan(0);
  });

  it('always returns a unit vector', () => {
    for (const s of [0, 0.1, 0.3, 0.5, 0.7, 0.99, 1]) {
      lineTangentAfterSag(chord, sagDir, s, 120, 400, out);
      expect(Math.hypot(out.x, out.y, out.z)).toBeCloseTo(1, 12);
    }
  });

  it('matches a numerical derivative of the sagging line', () => {
    const L = 800;
    const d = 40;
    const h = 1e-6;
    for (const s of [0.2, 0.45, 0.8]) {
      const px = (s2: number): number => chord.x * L * s2 + sagDir.x * sagProfile(s2, d);
      const py = (s2: number): number => chord.y * L * s2 + sagDir.y * sagProfile(s2, d);
      let dx = (px(s + h) - px(s - h)) / (2 * h);
      let dy = (py(s + h) - py(s - h)) / (2 * h);
      const n = Math.hypot(dx, dy);
      dx /= n; dy /= n;
      lineTangentAfterSag(chord, sagDir, s, d, L, out);
      expect(out.x).toBeCloseTo(dx, 6);
      expect(out.y).toBeCloseTo(dy, 6);
    }
  });

  it('falls back to the chord rather than to a zero tangent', () => {
    lineTangentAfterSag({ x: 0, y: 0, z: 0 }, sagDir, 0, 0, 0, out);
    expect(out).toEqual({ x: 0, y: 0, z: 0 });
  });
});
