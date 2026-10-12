// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-frame-fit-math — framing a part with the agent lens.
 *
 * The property under test is the one the old framing got wrong: after the fit,
 * the thing must be IN THE MIDDLE and must FILL the frame. Both are checked by
 * re-projecting through the same lens the fit was given, so the test measures
 * the result rather than restating the formula.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FRAME_FILL, boxCorners, fitPoseToBox, fitPoseToPoints, type Vec3,
} from '../src/plugins/mcp-bridge/rv-frame-fit-math';

/** Project `points` through the fitted pose and report the NDC rectangle. */
function ndcRect(
  points: ReadonlyArray<Vec3>, eye: Vec3, target: Vec3, fovDeg: number, aspect: number,
): { cx: number; cy: number; halfW: number; halfH: number } {
  const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a: Vec3, b: Vec3): Vec3 => [
    a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0],
  ];
  const norm = (a: Vec3): Vec3 => {
    const l = Math.hypot(a[0], a[1], a[2]);
    return [a[0] / l, a[1] / l, a[2] / l];
  };
  const forward = norm(sub(target, eye));
  const worldUp: Vec3 = Math.abs(forward[1]) > 0.999 ? [0, 0, 1] : [0, 1, 0];
  const right = norm(cross(forward, worldUp));
  const up = cross(right, forward);
  const tanHalf = Math.tan(fovDeg / 2 * Math.PI / 180);

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of points) {
    const v = sub(p, eye);
    const z = dot(v, forward);
    const x = dot(v, right) / z / (tanHalf * aspect);
    const y = dot(v, up) / z / tanHalf;
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  return {
    cx: (minX + maxX) / 2, cy: (minY + maxY) / 2,
    halfW: (maxX - minX) / 2, halfH: (maxY - minY) / 2,
  };
}

const FOV = 60;
const ASPECT = 4 / 3;

describe('fitPoseToBox', () => {
  it('centres the projected box and fills the frame to the requested fraction', () => {
    // Deliberately off the origin and not cube-shaped, so "centred" cannot be
    // satisfied by accident.
    const min: Vec3 = [1.2, 0.4, -3.1];
    const max: Vec3 = [1.6, 0.9, -2.4];
    const dir: Vec3 = [0.5, 0.4, 0.77];
    const { eye, target } = fitPoseToBox(min, max, dir, FOV, ASPECT);

    // What is SEEN is centred: the projected extent, on both axes.
    const r = ndcRect(boxCorners(min, max), eye, target, FOV, ASPECT);
    expect(Math.abs(r.cx)).toBeLessThan(0.01);
    expect(Math.abs(r.cy)).toBeLessThan(0.01);
    expect(Math.max(r.halfW, r.halfH)).toBeCloseTo(DEFAULT_FRAME_FILL, 2);

    // The 3D CENTRE is deliberately NOT what lands in the middle: under
    // perspective the two differ, and centring the picture is the useful one.
    const centre: Vec3 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
    const c = ndcRect([centre], eye, target, FOV, ASPECT);
    expect(Math.abs(c.cx) + Math.abs(c.cy)).toBeGreaterThan(0);
  });

  it('keeps the view direction exactly — it only moves along it and aims', () => {
    const dir: Vec3 = [0.5, 0.4, 0.77];
    const { eye, target } = fitPoseToBox([0, 0, 0], [1, 2, 3], dir, FOV, ASPECT);
    const back: Vec3 = [eye[0] - target[0], eye[1] - target[1], eye[2] - target[2]];
    const l = Math.hypot(...back);
    const dl = Math.hypot(...dir);
    for (let i = 0; i < 3; i++) expect(back[i] / l).toBeCloseTo(dir[i] / dl, 6);
  });

  it('survives a straight-down view, where the naive up-vector degenerates', () => {
    const { eye, target } = fitPoseToBox([0, 0, 0], [1, 0.2, 1], [0, 1, 0], FOV, ASPECT);
    for (const n of [...eye, ...target]) expect(Number.isFinite(n)).toBe(true);
    expect(eye[1]).toBeGreaterThan(target[1]); // looking down from above
  });

  it('returns finite numbers for a degenerate (zero-size) box', () => {
    const { eye, target } = fitPoseToBox([2, 2, 2], [2, 2, 2], [0, 0, 1], FOV, ASPECT);
    for (const n of [...eye, ...target]) expect(Number.isFinite(n)).toBe(true);
    expect(Math.hypot(eye[0] - target[0], eye[1] - target[1], eye[2] - target[2]))
      .toBeGreaterThan(0);
  });

  it('a narrow aspect frames on the width instead of the height', () => {
    const min: Vec3 = [-1, -0.1, -0.1];
    const max: Vec3 = [1, 0.1, 0.1];                 // wide and flat
    const { eye, target } = fitPoseToBox(min, max, [0, 0, 1], FOV, 0.5);
    const r = ndcRect(boxCorners(min, max), eye, target, FOV, 0.5);
    // The WIDE axis is the limiting one here, so it is the one that reaches fill.
    expect(r.halfW).toBeCloseTo(DEFAULT_FRAME_FILL, 2);
    expect(r.halfH).toBeLessThan(r.halfW);
  });
});

describe('fitPoseToPoints', () => {
  it('never backs off further than the box the points sit in', () => {
    // A thin slab on the 45° diagonal of its own world AABB: most of that box is
    // empty, so its corners project further than any of the material.
    const slab: Array<Vec3> = [];
    for (let i = 0; i <= 20; i++) {
      const t = i / 20;
      const x = -0.5 + t, z = -0.5 + t;             // the 45° diagonal
      for (const y of [-0.02, 0.02]) slab.push([x, y, z]);
    }
    const dir: Vec3 = [0, 0.3, 1];

    const fromPoints = fitPoseToPoints(slab, dir, FOV, ASPECT);
    const rp = ndcRect(slab, fromPoints.eye, fromPoints.target, FOV, ASPECT);
    expect(Math.abs(rp.cx)).toBeLessThan(0.01);
    expect(Math.abs(rp.cy)).toBeLessThan(0.01);
    expect(Math.max(rp.halfW, rp.halfH)).toBeCloseTo(DEFAULT_FRAME_FILL, 2);

    // Feeding the POINTS never ends up further away than feeding the box they
    // sit in — the box contains them, so it can only ever project at least as
    // far. (For a direction that hits the empty corners it is strictly closer;
    // along this one the extremes happen to be shared slab endpoints.)
    const lo: Vec3 = [-0.5, -0.02, -0.5];
    const hi: Vec3 = [0.5, 0.02, 0.5];
    const fromBox = fitPoseToBox(lo, hi, dir, FOV, ASPECT);
    const rb = ndcRect(slab, fromBox.eye, fromBox.target, FOV, ASPECT);
    expect(Math.max(rb.halfW, rb.halfH)).toBeLessThanOrEqual(Math.max(rp.halfW, rp.halfH));
  });

  it('falls back to a usable pose for an empty point set', () => {
    const { eye, target } = fitPoseToPoints([], [0, 0, 1], FOV, ASPECT);
    for (const n of [...eye, ...target]) expect(Number.isFinite(n)).toBe(true);
  });
});
