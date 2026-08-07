// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-annotate projection math: world point -> output-canvas pixel through the
 * capture crop rect + downscale, behind-camera flagging, off-crop clamping.
 */

import { describe, it, expect } from 'vitest';
import { PerspectiveCamera, Vector3 } from 'three';
import { projectLabelAnchors } from '../src/plugins/mcp-bridge/rv-annotate';

function makeCamera(): PerspectiveCamera {
  const cam = new PerspectiveCamera(50, 2, 0.1, 100); // aspect 2 (1600x800 buffer)
  cam.position.set(0, 0, 10);
  cam.lookAt(0, 0, 0);
  cam.updateMatrixWorld(true);
  cam.updateProjectionMatrix();
  return cam;
}

describe('projectLabelAnchors', () => {
  const BW = 1600, BH = 800;

  it('projects the camera-center point to the canvas center (full-frame crop)', () => {
    const cam = makeCamera();
    const crop = { left: 0, top: 0, width: BW, height: BH };
    const [a] = projectLabelAnchors(cam, BW, BH, crop, BW, BH, [
      { point: new Vector3(0, 0, 0), label: 'C' },
    ]);
    expect(a.behind).toBe(false);
    expect(a.clamped).toBe(false);
    expect(a.x).toBeCloseTo(BW / 2, 0);
    expect(a.y).toBeCloseTo(BH / 2, 0);
  });

  it('maps through crop offset and downscale', () => {
    const cam = makeCamera();
    // Crop the right half, downscale 2x: buffer x=1200 -> crop-local 400 -> out 200.
    const crop = { left: 800, top: 0, width: 800, height: 800 };
    const outW = 400, outH = 400;
    // A world point that lands at buffer center (800,400) sits on the crop's left edge.
    const [a] = projectLabelAnchors(cam, BW, BH, crop, outW, outH, [
      { point: new Vector3(0, 0, 0), label: 'E' },
    ]);
    expect(a.x).toBeCloseTo(8, 0); // clamped to the 8px margin (edge)
    expect(a.y).toBeCloseTo(200, 0);
  });

  it('flags points behind the camera', () => {
    const cam = makeCamera();
    const crop = { left: 0, top: 0, width: BW, height: BH };
    const [a] = projectLabelAnchors(cam, BW, BH, crop, BW, BH, [
      { point: new Vector3(0, 0, 20), label: 'B' }, // behind (camera at z=10 looking at -z)
    ]);
    expect(a.behind).toBe(true);
  });

  it('clamps off-crop anchors to the margin and marks them', () => {
    const cam = makeCamera();
    // Crop a small central window; a point projecting far left of it is clamped.
    const crop = { left: 700, top: 300, width: 200, height: 200 };
    const [a] = projectLabelAnchors(cam, BW, BH, crop, 200, 200, [
      { point: new Vector3(-8, 0, 0), label: 'L' },
    ]);
    expect(a.clamped).toBe(true);
    expect(a.x).toBeGreaterThanOrEqual(8);
    expect(a.x).toBeLessThanOrEqual(192);
    expect(a.y).toBeGreaterThanOrEqual(8);
    expect(a.y).toBeLessThanOrEqual(192);
  });
});
