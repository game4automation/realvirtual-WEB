// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-705 T5 — pure note aggregation and the sample grid.
 */

import { describe, it, expect } from 'vitest';
import { Vector3 } from 'three';
import { sweepPoses, sampleGrid, summarizeViewHits } from '../src/plugins/mcp-bridge/rv-view-sweep-math';

describe('summarizeViewHits', () => {
  // T5
  it('ranks visible nodes by hit count, caps at topN and reports background share', () => {
    const pose = sweepPoses(new Vector3(), 4, { count: 4 })[0];
    const hits = [
      'A/Frame', 'A/Frame', 'A/Frame', 'A/Frame', // 4
      'A/Belt', 'A/Belt',                          // 2
      'A/Motor',                                   // 1
      null, null, null,                            // 3 background
    ];
    const note = summarizeViewHits(pose, hits, 2);
    expect(note.samples).toBe(10);
    expect(note.topNodes).toEqual([
      { path: 'A/Frame', coverage: 0.4 },
      { path: 'A/Belt', coverage: 0.2 },
    ]); // topN=2 caps "A/Motor"
    expect(note.background).toBeCloseTo(0.3, 6);
    expect(note.index).toBe(pose.index);
    expect(note.label).toBe(pose.label);
    expect(note.cameraPosition).toHaveLength(3); // the way back to full resolution (§3.3)
  });

  it('uses the measured pose and only reports poseDrift beyond the tolerance', () => {
    const pose = sweepPoses(new Vector3(), 10, { count: 4, pitchDeg: 0 })[0];
    const undisturbed = summarizeViewHits(pose, ['A'], 5, pose.position.clone(), 0.1);
    expect(undisturbed.poseDrift).toBeUndefined();

    const nudged = pose.position.clone().add(new Vector3(0, 0, 2));
    const disturbed = summarizeViewHits(pose, ['A'], 5, nudged, 0.1);
    expect(disturbed.poseDrift).toBeCloseTo(2, 3);
    expect(disturbed.cameraPosition[2]).toBeCloseTo(nudged.z, 3);
  });

  it('survives an empty hit list without dividing by zero', () => {
    const pose = sweepPoses(new Vector3(), 5, { count: 4 })[0];
    const note = summarizeViewHits(pose, []);
    expect(note.samples).toBe(0);
    expect(note.background).toBe(0);
    expect(note.topNodes).toEqual([]);
  });
});

describe('sampleGrid', () => {
  it('spreads n×n points inside the canvas with an even margin', () => {
    const g = sampleGrid(3);
    expect(g).toHaveLength(9);
    expect(g[0]).toEqual([1 / 6, 1 / 6]);
    for (const [x, y] of g) {
      expect(x).toBeGreaterThan(0); expect(x).toBeLessThan(1);
      expect(y).toBeGreaterThan(0); expect(y).toBeLessThan(1);
    }
    expect(sampleGrid(7)).toHaveLength(49);
  });
});
