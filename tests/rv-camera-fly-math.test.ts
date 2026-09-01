// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-705 T1/T2 — the pure fly maths behind `web_camera_fly`.
 * No viewer, no canvas, no WebGL: the movement contract is provable on its own.
 */

import { describe, it, expect } from 'vitest';
import { Vector3 } from 'three';
import { computeFlyPose, flyBasis, MAX_PITCH_DEG } from '../src/plugins/mcp-bridge/rv-camera-fly-math';

describe('computeFlyPose', () => {
  // T1
  it('moves the camera forward by the exact distance and keeps the target distance', () => {
    const cur = { position: new Vector3(0, 1.7, 0), target: new Vector3(0, 1.7, -5) };
    const next = computeFlyPose(cur, { forward: 3 });
    expect(next.position.z).toBeCloseTo(-3, 6); // 3 m along -Z
    expect(next.position.distanceTo(cur.position)).toBeCloseTo(3, 6);
    // D-A3: the orbit distance survives the flight, so a following orbit still
    // turns around something in front of the camera.
    expect(next.position.distanceTo(next.target))
      .toBeCloseTo(cur.position.distanceTo(cur.target), 6);
  });

  // T2
  it('yaws counter-clockwise, clamps pitch and keeps ground moves horizontal', () => {
    const cur = { position: new Vector3(0, 2, 0), target: new Vector3(0, 2, -5) };

    const yawed = computeFlyPose(cur, { yawDeg: 90 });
    const dir = yawed.target.clone().sub(yawed.position).normalize();
    expect(dir.x).toBeCloseTo(-1, 5); // +yaw = counter-clockwise from above
    expect(dir.z).toBeCloseTo(0, 5);

    const steep = computeFlyPose(cur, { pitchDeg: 200 }); // absurd -> clamp
    const sDir = steep.target.clone().sub(steep.position).normalize();
    expect(Math.asin(sDir.y) * 180 / Math.PI).toBeCloseTo(MAX_PITCH_DEG, 3);

    // Looking down + ground=true: 4 m forward stay horizontal (D-A4).
    const looking = { position: new Vector3(0, 3, 0), target: new Vector3(0, 0, -3) };
    const walked = computeFlyPose(looking, { forward: 4, ground: true });
    expect(walked.position.y).toBeCloseTo(3, 6);
    expect(walked.position.z).toBeCloseTo(-4, 6);
  });

  it('moves right without tilting, and up along world +Y', () => {
    const cur = { position: new Vector3(0, 1, 0), target: new Vector3(0, 1, -5) };
    const r = computeFlyPose(cur, { right: 2 });
    expect(r.position.x).toBeCloseTo(2, 6);
    expect(r.position.y).toBeCloseTo(1, 6);
    const u = computeFlyPose(cur, { up: 1.5 });
    expect(u.position.y).toBeCloseTo(2.5, 6);
    // Pure translation leaves the view direction alone.
    expect(u.target.clone().sub(u.position).normalize().z).toBeCloseTo(-1, 6);
  });

  it('treats missing and non-finite inputs as zero', () => {
    const cur = { position: new Vector3(1, 2, 3), target: new Vector3(1, 2, -3) };
    const same = computeFlyPose(cur, {});
    expect(same.position.distanceTo(cur.position)).toBeCloseTo(0, 9);
    const nan = computeFlyPose(cur, { forward: Number.NaN, yawDeg: Number.NaN });
    expect(nan.position.distanceTo(cur.position)).toBeCloseTo(0, 9);
  });
});

describe('flyBasis', () => {
  it('projects onto XZ when walking and keeps the pitch when flying', () => {
    const pose = { position: new Vector3(0, 3, 0), target: new Vector3(0, 0, -3) };
    expect(flyBasis(pose, true).forward.y).toBeCloseTo(0, 9);
    expect(flyBasis(pose, false).forward.y).toBeCloseTo(-Math.SQRT1_2, 5);
    // right = (-fz, 0, fx) — the FPV convention, always horizontal.
    expect(flyBasis(pose, false).right.y).toBe(0);
  });

  it('falls back to a usable heading when looking straight down', () => {
    const pose = { position: new Vector3(0, 5, 0), target: new Vector3(0, 0, 0) };
    const { forward, right } = flyBasis(pose, true);
    expect(forward.lengthSq()).toBeCloseTo(1, 6);
    expect(right.lengthSq()).toBeCloseTo(1, 6);
  });
});
