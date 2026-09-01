// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-705 T3/T4 — the pure pose ring behind `web_view_sweep`.
 */

import { describe, it, expect } from 'vitest';
import { Vector3 } from 'three';
import { sweepPoses } from '../src/plugins/mcp-bridge/rv-view-sweep-math';
import { MAX_PITCH_DEG } from '../src/plugins/mcp-bridge/rv-camera-fly-math';

describe('sweepPoses', () => {
  // T3
  it('places count poses on one latitude circle with equal yaw spacing', () => {
    const c = new Vector3(1, 0.5, -2);
    const poses = sweepPoses(c, 8, { count: 6, pitchDeg: 20 });
    expect(poses).toHaveLength(6);
    for (const p of poses) {
      expect(p.position.distanceTo(c)).toBeCloseTo(8, 5); // radius exact
      expect(p.target.equals(c)).toBe(true);              // all look at the centre
      expect(p.pitchDeg).toBe(20);
    }
    const gaps = poses.slice(1).map((p, i) => p.yawDeg - poses[i].yawDeg);
    for (const g of gaps) expect(g).toBeCloseTo(60, 5);
    expect(new Set(poses.map((p) => p.label)).size).toBe(6); // labels unique
    poses.forEach((p, i) => expect(p.label).toContain(`#${i}`));
  });

  // T4
  it('clamps count to 4..8 and reflects elevation in the pose height', () => {
    expect(sweepPoses(new Vector3(), 5, { count: 2 })).toHaveLength(4);
    expect(sweepPoses(new Vector3(), 5, { count: 99 })).toHaveLength(8);

    const flat = sweepPoses(new Vector3(), 5, { count: 4, pitchDeg: 0 });
    const high = sweepPoses(new Vector3(), 5, { count: 4, pitchDeg: 45 });
    expect(flat[0].position.y).toBeCloseTo(0, 5);
    expect(high[0].position.y).toBeCloseTo(5 * Math.sin(Math.PI / 4), 5);
    expect(sweepPoses(new Vector3(), 5, { count: 4, pitchDeg: 300 })[0].pitchDeg)
      .toBe(MAX_PITCH_DEG);
  });

  it('defaults to six views at 20° and starts the arc at yawStartDeg', () => {
    const d = sweepPoses(new Vector3(), 4);
    expect(d).toHaveLength(6);
    expect(d[0].pitchDeg).toBe(20);
    // yaw 0 sits on +Z — the same convention web_camera_orbit uses.
    expect(d[0].position.z).toBeGreaterThan(0);

    const shifted = sweepPoses(new Vector3(), 4, { count: 4, yawStartDeg: 90 });
    expect(shifted.map((p) => p.yawDeg)).toEqual([90, 180, 270, 0]); // wraps to 0..360
  });
});
