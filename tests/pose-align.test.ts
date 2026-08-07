// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * pose-align.test.ts — Pure tests for the quick-edit orientation alignment
 * helpers (nearest axis-aligned orientation, closest-axis-to-direction).
 */

import { describe, it, expect } from 'vitest';
import { Euler, Quaternion, Vector3 } from 'three';
import { nearestAxisAlignedQuaternion, alignClosestAxisTo } from '../src/core/engine/rv-pose-align';

const DEG = Math.PI / 180;

function angleBetween(a: Quaternion, b: Quaternion): number {
  return 2 * Math.acos(Math.min(1, Math.abs(a.dot(b)))); // radians
}

describe('nearestAxisAlignedQuaternion', () => {
  it('returns identity for a slightly perturbed identity', () => {
    const q = new Quaternion().setFromEuler(new Euler(3 * DEG, -4 * DEG, 2 * DEG));
    const snapped = nearestAxisAlignedQuaternion(q);
    expect(angleBetween(snapped, new Quaternion())).toBeLessThan(1e-6);
  });

  it('snaps a ~93° yaw to the exact 90° yaw', () => {
    const q = new Quaternion().setFromEuler(new Euler(0, 93 * DEG, 0));
    const expected = new Quaternion().setFromEuler(new Euler(0, 90 * DEG, 0));
    const snapped = nearestAxisAlignedQuaternion(q);
    expect(angleBetween(snapped, expected)).toBeLessThan(1e-6);
  });

  it('always returns a proper rotation whose basis axes are world axes', () => {
    const q = new Quaternion().setFromEuler(new Euler(31 * DEG, 57 * DEG, -12 * DEG));
    const snapped = nearestAxisAlignedQuaternion(q);
    for (const a of [new Vector3(1, 0, 0), new Vector3(0, 1, 0), new Vector3(0, 0, 1)]) {
      const r = a.applyQuaternion(snapped);
      // Each rotated basis axis must be a signed world axis.
      const abs = [Math.abs(r.x), Math.abs(r.y), Math.abs(r.z)].sort((x, y) => y - x);
      expect(abs[0]).toBeCloseTo(1, 6);
      expect(abs[1]).toBeCloseTo(0, 6);
    }
  });

  it('never rotates further than the max possible snap distance (62°)', () => {
    // The 24-orientation set covers SO(3) with max distance ~62° (cube symmetry).
    for (let i = 0; i < 20; i++) {
      const q = new Quaternion().setFromEuler(new Euler(i * 17 * DEG, i * 29 * DEG, i * 41 * DEG));
      const snapped = nearestAxisAlignedQuaternion(q);
      expect(angleBetween(snapped, q)).toBeLessThan(63 * DEG);
    }
  });
});

describe('alignClosestAxisTo', () => {
  const DOWN = new Vector3(0, -1, 0);

  it('makes the closest axis point exactly along the direction', () => {
    // Slightly tilted frame: local -Y is closest to world-down.
    const q = new Quaternion().setFromEuler(new Euler(10 * DEG, 25 * DEG, -7 * DEG));
    const aligned = alignClosestAxisTo(q, DOWN);
    // After alignment SOME axis must be exactly down.
    let best = -Infinity;
    for (const a of [
      new Vector3(1, 0, 0), new Vector3(-1, 0, 0),
      new Vector3(0, 1, 0), new Vector3(0, -1, 0),
      new Vector3(0, 0, 1), new Vector3(0, 0, -1),
    ]) {
      best = Math.max(best, a.applyQuaternion(aligned).dot(DOWN));
    }
    expect(best).toBeCloseTo(1, 6);
  });

  it('is a minimal correction (small tilt → small rotation)', () => {
    const q = new Quaternion().setFromEuler(new Euler(5 * DEG, 0, 3 * DEG));
    const aligned = alignClosestAxisTo(q, DOWN);
    expect(angleBetween(aligned, q)).toBeLessThan(10 * DEG);
  });

  it('keeps an already-aligned frame unchanged', () => {
    const q = new Quaternion().setFromEuler(new Euler(0, 42 * DEG, 0)); // yaw only — -Y already down
    const aligned = alignClosestAxisTo(q, DOWN);
    expect(angleBetween(aligned, q)).toBeLessThan(1e-6);
  });
});
