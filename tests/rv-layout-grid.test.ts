// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Tests for Grid Snapping — verify grid snap calculations.
 *
 * Note: snapToGrid uses Math.round() which rounds half-values toward +infinity in JS.
 * Math.round(-1.5) = -1, Math.round(-0.5) = 0, Math.round(0.5) = 1
 */
import { describe, test, expect } from 'vitest';
import { snapToGrid } from '../../realvirtual-WebViewer-Private~/src/plugins/layout-planner';

describe('Grid Snapping', () => {
  test('snapToGrid snaps X and Z to grid size', () => {
    const result = snapToGrid({ x: 123, y: 5, z: 456 }, 500);
    expect(result.x).toBe(0);    // round(123/500)*500 = round(0.246)*500 = 0
    expect(result.y).toBe(5);    // Y unchanged
    expect(result.z).toBe(500);  // round(456/500)*500 = round(0.912)*500 = 500
  });

  test('snapToGrid with 0 grid size returns original', () => {
    const result = snapToGrid({ x: 123, y: 5, z: 456 }, 0);
    expect(result.x).toBe(123);
  });

  test('snapToGrid handles negative coordinates', () => {
    // Math.round(-750/500) = Math.round(-1.5) = -1 in JS (rounds toward +inf)
    const result = snapToGrid({ x: -750, y: 0, z: -250 }, 500);
    expect(result.x).toBe(-500);  // round(-1.5)*500 = -1*500
    // Math.round(-0.5) = -0 in JS, so -0 * 500 = -0. Use toEqual for -0/+0 equivalence.
    expect(result.z + 0).toBe(0); // round(-0.5)*500 = -0, coerce to +0
  });

  test('snapToGrid handles exact negative multiples', () => {
    const result = snapToGrid({ x: -1000, y: 0, z: -500 }, 500);
    expect(result.x).toBe(-1000); // round(-2.0)*500 = -2*500
    expect(result.z).toBe(-500);  // round(-1.0)*500 = -1*500
  });

  test('snapToGrid handles values just past half-grid', () => {
    const result = snapToGrid({ x: -751, y: 0, z: 251 }, 500);
    expect(result.x).toBe(-1000); // round(-1.502)*500 = -2*500
    expect(result.z).toBe(500);   // round(0.502)*500 = 1*500
  });

  test('snapToGrid with negative grid size returns original', () => {
    const result = snapToGrid({ x: 123, y: 5, z: 456 }, -100);
    expect(result.x).toBe(123);
    expect(result.z).toBe(456);
  });

  test('snapToGrid preserves exact grid multiples', () => {
    const result = snapToGrid({ x: 1000, y: 0, z: 2000 }, 500);
    expect(result.x).toBe(1000);
    expect(result.z).toBe(2000);
  });
});
