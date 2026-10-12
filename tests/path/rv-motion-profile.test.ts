// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/** plan-558 §9.1 — closed-form motion profile (unit, meters / seconds). */

import { describe, it, expect } from 'vitest';
import {
  planProfile, positionAt, speedAt, timeAt, profileAsLimit, minSeparation, minLimits, emergencyStop,
  earliestGapCrossing, stationaryProfile, type LimitPiece, type MotionProfile,
} from '../../src/core/engine/rv-motion-profile';

const cruise = (x0: number, x1: number, v: number): LimitPiece => ({ x0, x1, c0: v * v, c1: 0 });

/** A constant-speed profile x(t) = x0 + v·t over `dur` seconds (then stopped). */
function constant(x0: number, v: number, dur: number): MotionProfile {
  return {
    t0: 0, x0, v0: v, phases: [{ t0: 0, x0, v0: v, a: 0, dt: dur, x1: x0 + v * dur }],
    xStop: x0 + v * dur, tEnd: dur, vEnd: 0, feasible: true,
  };
}

describe('rv-motion-profile — planProfile (plan-558 §9.1)', () => {
  it('trapezoid: accel → cruise → brake, exact stop at the end', () => {
    const p = planProfile(0, 0, 0, [cruise(0, 10, 1)], 0.5, 0.5, 10);
    expect(p.feasible).toBe(true);
    // 1 m accel (2 s), 8 m cruise (8 s), 1 m brake (2 s) = 12 s
    expect(p.tEnd).toBeCloseTo(12, 9);
    expect(positionAt(p, 12)).toBe(10);
    expect(speedAt(p, 12)).toBe(0);
    expect(positionAt(p, 2)).toBeCloseTo(1, 9);
    expect(speedAt(p, 6)).toBeCloseTo(1, 9);
    for (let t = 0; t <= 12; t += 0.37) expect(timeAt(p, positionAt(p, t))).toBeCloseTo(t, 6);
  });

  it('triangle when the distance is too short for cruise', () => {
    const p = planProfile(0, 0, 0, [cruise(0, 1, 1)], 0.5, 0.5, 1);
    // vp = sqrt(2ab·d/(a+b)) = sqrt(0.5); t = 2·vp/a
    expect(p.tEnd).toBeCloseTo((2 * Math.sqrt(0.5)) / 0.5, 9);
    expect(positionAt(p, p.tEnd)).toBe(1);
  });

  it('asymmetric a / b: braking distance v²/(2b) exactly', () => {
    const p = planProfile(0, 0, 0, [cruise(0, 20, 1)], 1, 0.25, 20);
    const last = p.phases[p.phases.length - 1];
    expect(last.a).toBeCloseTo(-0.25, 12);
    expect(last.x1 - last.x0).toBeCloseTo(1 / (2 * 0.25), 9);
  });

  it('backward pass brakes before a curve limit and the forward pass accelerates after it', () => {
    const lim: LimitPiece[] = [cruise(0, 20, 1), { x0: 8, x1: 12, c0: 0.25, c1: 0 }];
    const p = planProfile(0, 0, 1, lim, 0.5, 0.5, 20);
    for (let t = 0; t < p.tEnd; t += 0.01) {
      const x = positionAt(p, t);
      if (x >= 8 && x <= 12) expect(speedAt(p, t)).toBeLessThanOrEqual(0.5 + 1e-9);
    }
    expect(speedAt(p, timeAt(p, 14))).toBeGreaterThan(0.5);
    // |dv/dt| never exceeds the limits.
    for (const ph of p.phases) expect(ph.a).toBeGreaterThanOrEqual(-0.5 - 1e-12);
    for (const ph of p.phases) expect(ph.a).toBeLessThanOrEqual(0.5 + 1e-12);
  });

  it('v_end: the profile ends at the requested speed and keeps it afterwards', () => {
    const p = planProfile(0, 0, 0, [cruise(0, 10, 1)], 0.5, 0.5, 10, { vEnd: 0.5 });
    expect(p.feasible).toBe(true);
    expect(p.vEnd).toBeCloseTo(0.5, 9);
    expect(speedAt(p, p.tEnd + 3)).toBeCloseTo(0.5, 9);
    expect(positionAt(p, p.tEnd + 2)).toBeCloseTo(11, 9);
    expect(timeAt(p, 11)).toBeCloseTo(p.tEnd + 2, 9);
  });

  it('v_end is clamped to the limit at the end', () => {
    const p = planProfile(0, 0, 0, [cruise(0, 10, 0.4)], 0.5, 0.5, 10, { vEnd: 2 });
    expect(p.vEnd).toBeCloseTo(0.4, 9);
  });

  it('infeasible stop → feasible = false and an emergency stop with b', () => {
    const p = planProfile(0, 0, 1, [cruise(0, 5, 1)], 0.5, 0.5, 0.5);
    expect(p.feasible).toBe(false);
    expect(p.xStop).toBeCloseTo(1, 9); // 1²/(2·0.5)
    expect(p.phases[0].a).toBe(-0.5);
    const e = emergencyStop(0, 0, 0, 0.5);
    expect(e.feasible).toBe(false);
    expect(e.phases.length).toBe(0);
  });

  it('no NaN for v0 = vmax and zero distance', () => {
    const p = planProfile(3, 2, 0, [cruise(2, 2, 1)], 0.5, 0.5, 2);
    expect(positionAt(p, 5)).toBe(2);
    expect(Number.isFinite(p.tEnd)).toBe(true);
    const q = planProfile(0, 0, 1, [cruise(0, 10, 1)], 0.5, 0.5, 10);
    for (let t = 0; t <= q.tEnd; t += 0.5) expect(Number.isFinite(positionAt(q, t))).toBe(true);
  });

  it('a = 0: the vehicle cannot speed up (stays put from rest, coasts and brakes when moving)', () => {
    const rest = planProfile(0, 0, 0, [cruise(0, 10, 1)], 0, 0.5, 10);
    expect(rest.xStop).toBe(0);
    expect(rest.tEnd).toBe(0);
    const moving = planProfile(0, 0, 0.5, [cruise(0, 10, 1)], 0, 0.5, 10);
    expect(moving.feasible).toBe(true);
    expect(positionAt(moving, moving.tEnd)).toBe(10);
    for (const ph of moving.phases) expect(ph.a).toBeLessThanOrEqual(1e-12);
  });

  it('invalid parameters throw instead of producing NaN profiles', () => {
    expect(() => planProfile(0, 0, 0, [cruise(0, 1, 1)], -1, 0.5, 1)).toThrow(RangeError);
    expect(() => planProfile(0, 0, 0, [cruise(0, 1, 1)], 0.5, 0, 1)).toThrow(RangeError);
    expect(() => planProfile(0, 0, 0, [cruise(0, 1, 1)], 0.5, -2, 1)).toThrow(RangeError);
    expect(() => planProfile(Number.NaN, 0, 0, [cruise(0, 1, 1)], 0.5, 0.5, 1)).toThrow(RangeError);
    expect(() => planProfile(0, 0, Infinity, [cruise(0, 1, 1)], 0.5, 0.5, 1)).toThrow(RangeError);
    expect(() => planProfile(0, 0, 0, [cruise(0, 1, 1)], 0.5, 0.5, Number.NaN)).toThrow(RangeError);
  });

  it('a stationary profile stays at its position', () => {
    const p = stationaryProfile(4, 7);
    expect(positionAt(p, 100)).toBe(7);
    expect(speedAt(p, 100)).toBe(0);
    expect(timeAt(p, 8)).toBe(Infinity);
  });
});

describe('rv-motion-profile — limits and envelopes', () => {
  it('minLimits: pointwise minimum with crossings split exactly', () => {
    const rising: LimitPiece[] = [{ x0: 0, x1: 10, c0: 0, c1: 0.2 }];   // 0 → 2
    const flat: LimitPiece[] = [{ x0: 0, x1: 10, c0: 1, c1: 0 }];
    const m = minLimits([rising, flat], 0, 10);
    expect(m.length).toBe(2);
    expect(m[0].x1).toBeCloseTo(5, 9); // 0.2·x = 1
    expect(m[0].c1).toBeCloseTo(0.2, 12);
    expect(m[1].c0).toBeCloseTo(1, 12);
  });

  it('a follower under a slow leader envelope never closes below the gap', () => {
    const lead = planProfile(0, 5, 0.5, [cruise(5, 40, 0.5)], 0.5, 0.5, 40);
    const G = 1.3;
    const env = profileAsLimit(lead, -G, lead.x0, lead.xStop);
    const fol = planProfile(0, 0, 0, [cruise(0, 40, 1), ...env], 0.5, 0.5, lead.xStop - G);
    expect(fol.feasible).toBe(true);
    expect(minSeparation(fol, lead, -G, 0)).toBeGreaterThanOrEqual(-1e-9);
  });
});

describe('rv-motion-profile — minSeparation (R2-1: exact at a branch)', () => {
  it('review counter-example: leader 10+t, follower 8+2t, shift −1, branch at 11.5 → −0.5 m', () => {
    const lead = constant(10, 1, 100);
    const fol = constant(8, 2, 50);
    // d(t) = (10 + t) − 1 − (8 + 2t) = 1 − t; the leader reaches 11.5 at t = 1.5.
    expect(minSeparation(fol, lead, -1, 0, 11.5)).toBeCloseTo(-0.5, 12);
    // Without the branch the gap keeps closing over the plans.
    expect(minSeparation(fol, lead, -1, 0)).toBeLessThan(-40);
  });

  it('branch point BETWEEN two phase boundaries is evaluated exactly', () => {
    // Leader: 1 m/s for 1 s, then brakes at 0.5 m/s² (phase boundaries t = 1, 3).
    const lead: MotionProfile = {
      t0: 0, x0: 10, v0: 1, phases: [
        { t0: 0, x0: 10, v0: 1, a: 0, dt: 1, x1: 11 },
        { t0: 1, x0: 11, v0: 1, a: -0.5, dt: 2, x1: 12 },
      ], xStop: 12, tEnd: 3, vEnd: 0, feasible: true,
    };
    const fol = constant(8, 1.5, 40);
    // Branch at leader x = 11.75 → reached at t = 2 (between the boundaries 1 and 3).
    const tB = timeAt(lead, 11.75);
    expect(tB).toBeCloseTo(2, 9);
    const expected = 11.75 - 1 - (8 + 1.5 * tB);
    expect(minSeparation(fol, lead, -1, 0, 11.75)).toBeCloseTo(expected, 9);
    // A branch already passed at tFrom → empty domain.
    expect(minSeparation(fol, lead, -1, 2.5, 11.75)).toBe(Infinity);
  });

  it('interval vertex (closing then opening) is found between breakpoints', () => {
    const lead: MotionProfile = {
      t0: 0, x0: 5, v0: 0, phases: [{ t0: 0, x0: 5, v0: 0, a: 1, dt: 4, x1: 13 }],
      xStop: 13, tEnd: 4, vEnd: 0, feasible: true,
    };
    const fol = constant(0, 2, 4);
    // d(t) = 5 + 0.5t² − 2t → minimum at t = 2: d = 3.
    expect(minSeparation(fol, lead, 0, 0)).toBeCloseTo(3, 12);
  });
});

describe('rv-motion-profile — earliestGapCrossing (scanner fields)', () => {
  it('predicts the exact entry time of a constant-length field', () => {
    const lead = constant(10, 0.5, 100);
    const fol = constant(0, 1, 100);
    // gap = 10 + 0.5t − t = 10 − 0.5t falls below 2 m at t = 16.
    expect(earliestGapCrossing(fol, lead, 0, 0, Infinity, 0, 0, 1, 2, -1)).toBeCloseTo(16, 9);
    // Exit (rise above 12 m) never happens.
    expect(earliestGapCrossing(fol, lead, 0, 0, Infinity, 0, 0, 1, 12, +1)).toBe(Infinity);
  });

  it('speed-dependent field length v·t_r + v²/2b + margin', () => {
    const lead = constant(10, 0, 100);
    const fol: MotionProfile = {
      t0: 0, x0: 0, v0: 2, phases: [{ t0: 0, x0: 0, v0: 2, a: -0.2, dt: 10, x1: 10 }],
      xStop: 10, tEnd: 10, vEnd: 0, feasible: true,
    };
    const tr = 0.2, b = 0.5, margin = 0.2;
    const t = earliestGapCrossing(fol, lead, 0, 0, Infinity, 1, tr, b, margin, -1);
    const v = speedAt(fol, t);
    const gap = 10 - positionAt(fol, t);
    expect(gap).toBeCloseTo(v * tr + (v * v) / (2 * b) + margin, 6);
    // Already inside at tFrom → tFrom.
    expect(earliestGapCrossing(fol, lead, 0, t + 0.1, Infinity, 1, tr, b, margin, -1)).toBeCloseTo(t + 0.1, 12);
  });

  it('a leader leaving the domain is an exit, never an entry', () => {
    const lead = constant(3, 1, 100);
    const fol = constant(0, 1, 100);
    // Gap constant 3 m (< 5 m field) — the leader branches off at x = 6 (t = 3).
    expect(earliestGapCrossing(fol, lead, 0, 0, 6, 0, 0, 1, 5, +1)).toBeCloseTo(3, 9);
    expect(earliestGapCrossing(fol, lead, 0, 0, 6, 0, 0, 1, 1, -1)).toBe(Infinity);
  });
});
