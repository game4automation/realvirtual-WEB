// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Test 9.1 of plan-362 — the closed-form chain geometry.
 *
 * Pure math: no DOM, no Three.js, no fixtures. What is asserted here is the
 * behaviour the whole component rests on — half bend speed, constant length,
 * continuity at both segment joints, and no NaN when the chain is overstretched.
 */

import { describe, expect, it } from 'vitest';
import {
  arcLengthTotal,
  boneArcLengths,
  chainStatus,
  followerRange,
  minimumBoneCount,
  pointAt,
  projectToPath,
  solveBend,
  strandLengths,
  tangentAt,
} from '../src/core/engine/rv-energy-chain-path';

describe('energy chain path', () => {
  const R = 55, L = 815, a = -154;   // mm, in the bind frame

  it('moves the bend at half the follower speed', () => {
    expect(solveBend({ a, m: -154, R, L }) - solveBend({ a, m: -354, R, L }))
      .toBeCloseTo(100, 3);
  });

  it('preserves total arc length across the whole stroke', () => {
    for (const m of [-154, -254, -354, -554])
      expect(arcLengthTotal({ a, m, R, L })).toBeCloseTo(L, 6);
  });

  it('is continuous at both segment joints', () => {
    const cfg = { a, m: -354, R, L };
    const l1 = solveBend(cfg) - a, eps = 1e-4;
    for (const s of [l1, l1 + Math.PI * R]) {
      const b = pointAt(cfg, s - eps), f = pointAt(cfg, s + eps);
      expect(Math.hypot(f.u - b.u, f.v - b.v)).toBeLessThan(1e-3);
    }
  });

  it('flags overstretch instead of producing NaN', () => {
    const r = solveBend({ a: 0, m: -2000, R, L });
    expect(Number.isNaN(r)).toBe(false);
    expect(chainStatus({ a: 0, m: -2000, R, L })).toBe('overstretched');
    const p = pointAt({ a: 0, m: -2000, R, L }, 400);
    expect(Number.isNaN(p.u)).toBe(false);
    expect(Number.isNaN(p.v)).toBe(false);
  });

  it('starts at the anchor and ends at the follower', () => {
    for (const m of [-154, -354, -554, 100]) {
      const cfg = { a, m, R, L };
      expect(pointAt(cfg, 0).u).toBeCloseTo(a, 9);
      expect(pointAt(cfg, L).u).toBeCloseTo(m, 9);
    }
  });

  it('puts the two strands 2R apart with the bend between them', () => {
    const cfg = { a, m: -354, R, L };
    const { l1 } = strandLengths(cfg);
    const lower = pointAt(cfg, l1 * 0.5);
    const upper = pointAt(cfg, L - 1);
    expect(upper.v - lower.v).toBeCloseTo(2 * R, 6);
    expect(pointAt(cfg, l1 + Math.PI * R * 0.5).u).toBeCloseTo(solveBend(cfg) + R, 6);
  });

  it('reports a symmetric follower range in both travel directions', () => {
    const range = followerRange({ a, R, L });
    const reach = L - Math.PI * R;
    expect(range.min).toBeCloseTo(a - reach, 6);
    expect(range.max).toBeCloseTo(a + reach, 6);
    // Every test value used above stays inside it — the one-sided envelope of
    // the first plan draft would have excluded m = -554 (Re-Challenge R3).
    for (const m of [-154, -254, -354, -554]) {
      expect(m).toBeGreaterThanOrEqual(range.min);
      expect(m).toBeLessThanOrEqual(range.max);
    }
  });

  it('has a unit tangent that matches a finite difference', () => {
    const cfg = { a, m: -354, R, L };
    const { l1 } = strandLengths(cfg);
    for (const s of [10, l1 * 0.5, l1 + 20, l1 + Math.PI * R * 0.5, L - 20]) {
      const t = tangentAt(cfg, s);
      expect(Math.hypot(t.u, t.v)).toBeCloseTo(1, 9);
      const eps = 1e-3;
      const p0 = pointAt(cfg, s - eps), p1 = pointAt(cfg, s + eps);
      const du = (p1.u - p0.u) / (2 * eps), dv = (p1.v - p0.v) / (2 * eps);
      expect(du).toBeCloseTo(t.u, 4);
      expect(dv).toBeCloseTo(t.v, 4);
    }
  });

  it('projects a point back to the arc length it came from', () => {
    const cfg = { a, m: -354, R, L };
    for (let i = 0; i <= 20; i++) {
      const s = (L * i) / 20;
      const p = pointAt(cfg, s);
      const back = projectToPath(cfg, p.u, p.v);
      expect(back.distance).toBeLessThan(1e-6);
      expect(back.s).toBeCloseTo(s, 4);
    }
  });

  it('keeps the transverse offset of an off-centerline point', () => {
    const cfg = { a, m: -354, R, L };
    const { l1 } = strandLengths(cfg);
    const onPath = pointAt(cfg, l1 + Math.PI * R * 0.5);   // outermost bend point
    const outside = { u: onPath.u + 17.5, v: onPath.v };
    const back = projectToPath(cfg, outside.u, outside.v);
    expect(back.distance).toBeCloseTo(17.5, 4);
  });

  it('derives the bone minimum from the maximum relative angle', () => {
    // 13 bend + 3 + 3 + 2 = 21 (Re-Challenge R5 corrected the arithmetic)
    expect(minimumBoneCount(15)).toBe(21);
    expect(minimumBoneCount(30)).toBe(15);
  });

  it('concentrates bone samples on the bend', () => {
    const cfg = { a, m: -354, R, L };
    const samples = boneArcLengths(cfg, 24);
    expect(samples.length).toBe(24);
    expect(samples[0]).toBe(0);
    expect(samples[23]).toBeCloseTo(L, 9);
    for (let i = 1; i < samples.length; i++) {
      expect(samples[i]).toBeGreaterThan(samples[i - 1]);
    }
    // Neighbouring bone frames must stay under the LBS degeneration limit.
    let maxDeltaDeg = 0;
    for (let i = 1; i < samples.length; i++) {
      const t0 = tangentAt(cfg, samples[i - 1]);
      const t1 = tangentAt(cfg, samples[i]);
      const dot = Math.min(1, Math.max(-1, t0.u * t1.u + t0.v * t1.v));
      maxDeltaDeg = Math.max(maxDeltaDeg, (Math.acos(dot) * 180) / Math.PI);
    }
    expect(maxDeltaDeg).toBeLessThanOrEqual(15 + 1e-6);
  });

  it('still yields a monotone bone ramp on an overstretched pose', () => {
    const samples = boneArcLengths({ a: 0, m: -2000, R, L }, 24);
    for (let i = 1; i < samples.length; i++) {
      expect(samples[i]).toBeGreaterThan(samples[i - 1]);
      expect(Number.isNaN(samples[i])).toBe(false);
    }
  });
});
