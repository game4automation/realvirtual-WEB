// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-515 F10 / Phase 3 — scale-derived constants (pure functions): the
 * values for a 0.33 m model and a 500 m scene, and the unchanged values for
 * human-scale / empty scenes.
 */
import { describe, expect, it } from 'vitest';
import {
  fpvScaleDefaults, gizmoFallbackDistance, groundSquareSize, nice125, shadowCameraFor,
  GROUND_SQUARE_DEFAULT, type FpvScaleDefaults, type ScaleLike, type ShadowCameraFit,
} from '../src/core/engine/rv-scale-constants';

/** Scale of a cube-ish content box with edge `maxDim` (radius = half the diagonal). */
function scaleOf(maxDim: number): ScaleLike {
  return { maxDim, radius: Math.sqrt(3) * maxDim / 2, empty: false };
}
const EMPTY: ScaleLike = { maxDim: 0, radius: 0.0005, empty: true };
const fpv = (): FpvScaleDefaults => ({ eyeHeight: 0, speed: 0, sprintSpeed: 0 });
const shadow = (): ShadowCameraFit => ({ pad: 0, near: 0, far: 0, sunDist: 0 });

describe('nice125', () => {
  it('picks the nearest 1-2-5 value in log space', () => {
    expect(nice125(0.033)).toBe(0.05);
    expect(nice125(0.03)).toBe(0.02);
    expect(nice125(50.2)).toBe(50);
    expect(nice125(0.7)).toBe(0.5);
    expect(nice125(0.75)).toBe(1);
    expect(nice125(1)).toBe(1);
    expect(nice125(1.5)).toBe(2);
    expect(nice125(8)).toBe(10);
    expect(nice125(0.0001)).toBe(0.0001);
    expect(Number.isNaN(nice125(0))).toBe(true);
    expect(Number.isNaN(nice125(Number.NaN))).toBe(true);
  });
});

describe('orientation gizmo fallback (pre-515 `d > 0.5 ? 2d : 5`, floor capped at 2·radius)', () => {
  it('0.33 m model: floor 2·radius, far below the old 5 m', () => {
    const s = scaleOf(0.33);
    expect(gizmoFallbackDistance(s, 0)).toBeCloseTo(2 * s.radius, 12);
    expect(gizmoFallbackDistance(s, 0)).toBeLessThan(1);
    expect(gizmoFallbackDistance(s, 0.4)).toBeCloseTo(2 * s.radius, 12);
  });
  it('500 m scene: exactly the pre-515 values (5 m floor, 2d beyond 0.5 m)', () => {
    const s = scaleOf(500);
    expect(gizmoFallbackDistance(s, 0)).toBe(5);
    expect(gizmoFallbackDistance(s, 0.4)).toBe(5);
    expect(gizmoFallbackDistance(s, 3)).toBe(6);
    expect(gizmoFallbackDistance(s, 1000)).toBe(2000);
  });
  it('10 m machine: pre-515 5 m floor', () => {
    expect(gizmoFallbackDistance(scaleOf(10), 0)).toBe(5);
  });
  it('at least 1 mm; empty scene keeps the old 5 m / 2d', () => {
    expect(gizmoFallbackDistance({ maxDim: 0, radius: 0, empty: false }, 0)).toBe(5);
    expect(gizmoFallbackDistance({ maxDim: 1e-6, radius: 1e-6, empty: false }, 0)).toBe(0.001);
    expect(gizmoFallbackDistance(EMPTY, 0)).toBe(5);
    expect(gizmoFallbackDistance(null, 3)).toBe(6);
    expect(gizmoFallbackDistance(null, 0.4)).toBe(5);
  });
});

describe('ground checker square', () => {
  it('≈ min(0.5 m, maxDim/10) on the 1-2-5 series, min 1 mm; empty → 0.5 m', () => {
    // 0.033 → 5 cm: mantissa 3.3 lies above the log midpoint √10 ≈ 3.162 between 2 and 5.
    expect(groundSquareSize(scaleOf(0.33))).toBe(0.05);
    expect(groundSquareSize(scaleOf(500))).toBe(0.5);
    expect(groundSquareSize(scaleOf(10))).toBe(0.5);
    expect(groundSquareSize(scaleOf(5))).toBe(0.5);
    expect(groundSquareSize(scaleOf(3))).toBe(0.2);
    expect(groundSquareSize(scaleOf(0.005))).toBe(0.001);
    expect(groundSquareSize(EMPTY)).toBe(GROUND_SQUARE_DEFAULT);
    expect(groundSquareSize(null)).toBe(0.5);
  });
});

describe('FPV defaults', () => {
  it('0.33 m model: eye 0.5·maxDim, crossed in 3 s, sprint 2×', () => {
    const d = fpvScaleDefaults(scaleOf(0.33), fpv());
    expect(d.eyeHeight).toBeCloseTo(0.165, 12);
    expect(d.speed).toBeCloseTo(0.11, 12);
    expect(d.sprintSpeed).toBeCloseTo(0.22, 12);
  });
  it('>= 3 m, 500 m and empty: today’s 1.7 m / 2.5 m/s / 5 m/s', () => {
    for (const s of [scaleOf(3), scaleOf(500), EMPTY, null]) {
      expect(fpvScaleDefaults(s, fpv())).toEqual({ eyeHeight: 1.7, speed: 2.5, sprintSpeed: 5 });
    }
  });
  it('lower bounds for a degenerate model', () => {
    const d = fpvScaleDefaults({ maxDim: 1e-6, radius: 0.0005, empty: false }, fpv());
    expect(d.eyeHeight).toBe(0.0005);
    expect(d.speed).toBe(0.001);
  });
});

describe('shadow camera', () => {
  it('0.33 m model', () => {
    const f = shadowCameraFor(0.33, shadow());
    expect(f.pad).toBeCloseTo(0.396, 12);
    expect(f.near).toBeCloseTo(0.00033, 12);
    expect(f.far).toBeCloseTo(1.32, 12);
    expect(f.sunDist).toBeCloseTo(0.66, 12);
    // The content sphere (radius <= √3/2 · maxDim) lies between near and far.
    const r = Math.sqrt(3) / 2 * 0.33;
    expect(f.sunDist - r).toBeGreaterThan(f.near);
    expect(f.sunDist + r).toBeLessThan(f.far);
  });
  it('500 m scene (same as before: pad 600, far 2000)', () => {
    const f = shadowCameraFor(500, shadow());
    expect(f.pad).toBe(600);
    expect(f.near).toBe(0.5);
    expect(f.far).toBe(2000);
    expect(f.sunDist).toBe(1000);
  });
  it('floors: pad 5 cm, near 0.1 mm, far 0.5 m', () => {
    const f = shadowCameraFor(0, shadow());
    expect(f).toEqual({ pad: 0.05, near: 1e-4, far: 0.5, sunDist: 0.05 });
  });
});
