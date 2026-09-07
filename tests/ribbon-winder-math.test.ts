// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-459 §9.2 — roll build-up mathematics, with the unit contract as the
 * headline case: 1200 m of 0.1 mm paper on a 50 mm core is 1 200 000 mm, and
 * the expected radius is computed here from the closed form, not read back.
 */

import { describe, it, expect } from 'vitest';
import {
  angularSpeedRad,
  lengthFromRadiusMm,
  radiusFromLengthMm,
} from '../src/core/engine/ribbon/ribbon-winder-math';

describe('ribbon-winder-math', () => {
  it('radiusFromLengthMm(50, 0.1, 1_200_000) equals sqrt(50^2 + 1.2e6*0.1/pi)', () => {
    const r = radiusFromLengthMm(50, 0.1, 1_200_000);
    expect(r).toBeCloseTo(Math.sqrt(50 * 50 + (1_200_000 * 0.1) / Math.PI), 9);
    // Sanity in engineering terms: a ~200 mm radius reel of paper.
    expect(r).toBeGreaterThan(200);
    expect(r).toBeLessThan(205);
  });

  it('radiusFromLengthMm and lengthFromRadiusMm are inverse', () => {
    for (const L of [0, 1, 1000, 250_000, 1_200_000]) {
      const r = radiusFromLengthMm(76.2, 0.08, L);
      expect(lengthFromRadiusMm(76.2, 0.08, r)).toBeCloseTo(L, 3);
    }
    for (const R of [76.2, 100, 300, 600]) {
      const L = lengthFromRadiusMm(76.2, 0.08, R);
      expect(radiusFromLengthMm(76.2, 0.08, L)).toBeCloseTo(R, 9);
    }
  });

  it('an empty roll is exactly the core, and a negative length clamps to it', () => {
    expect(radiusFromLengthMm(50, 0.1, 0)).toBe(50);
    expect(radiusFromLengthMm(50, 0.1, -1e6)).toBe(50);
    expect(lengthFromRadiusMm(50, 0.1, 49)).toBe(0);
    expect(lengthFromRadiusMm(50, 0.1, 50)).toBe(0);
  });

  it('angularSpeedRad clamps radius to minRadius', () => {
    // v / r, signed.
    expect(angularSpeedRad(500, 100, 50)).toBeCloseTo(5, 9);
    expect(angularSpeedRad(-500, 100, 50)).toBeCloseTo(-5, 9);
    // Below the floor the floor is used, so the result stays finite.
    expect(angularSpeedRad(500, 0, 50)).toBeCloseTo(10, 9);
    expect(Number.isFinite(angularSpeedRad(500, 0, 0))).toBe(true);
    expect(angularSpeedRad(Number.NaN, 100, 50)).toBe(0);
  });

  it('non-positive thickness or core radius throws instead of seeding a NaN', () => {
    expect(() => radiusFromLengthMm(0, 0.1, 1000)).toThrow(RangeError);
    expect(() => radiusFromLengthMm(-5, 0.1, 1000)).toThrow(RangeError);
    expect(() => radiusFromLengthMm(50, 0, 1000)).toThrow(RangeError);
    expect(() => lengthFromRadiusMm(50, -1, 100)).toThrow(RangeError);
    expect(() => radiusFromLengthMm(Number.NaN, 0.1, 1000)).toThrow(RangeError);
  });
});
