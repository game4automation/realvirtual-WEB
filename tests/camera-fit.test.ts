// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it } from 'vitest';
import { Box3, PerspectiveCamera, Vector3 } from 'three';
import { boxCorners, fitPoseInRegion, largestFreeRect } from '../src/core/hmi/camera-fit';

describe('largestFreeRect', () => {
  const canvas = { x: 326, y: 0, w: 1594, h: 1080 };

  it('returns the canvas when no panel overlaps it', () => {
    expect(largestFreeRect(canvas, [{ x: 0, y: 0, w: 300, h: 1080 }])).toEqual(canvas);
  });

  it('takes the wide band left of a panel on the right', () => {
    expect(largestFreeRect(canvas, [{ x: 1100, y: 420, w: 460, h: 640 }]))
      .toEqual({ x: 326, y: 0, w: 774, h: 1080 });
  });

  it('avoids several panels', () => {
    const r = largestFreeRect(canvas, [{ x: 1440, y: 0, w: 480, h: 1080 }, { x: 326, y: 900, w: 400, h: 180 }]);
    expect(r).toEqual({ x: 326, y: 0, w: 1114, h: 900 });
  });
});

describe('fitPoseInRegion', () => {
  const canvas = { x: 0, y: 0, w: 1600, h: 900 };

  function project(pose: { position: Vector3; target: Vector3 }, box: Box3) {
    const cam = new PerspectiveCamera(45, canvas.w / canvas.h, 0.01, 1000);
    cam.position.copy(pose.position);
    cam.lookAt(pose.target);
    cam.updateMatrixWorld();
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
      const p = new Vector3(x, y, z).project(cam);
      const px = (p.x + 1) / 2 * canvas.w, py = (1 - p.y) / 2 * canvas.h;
      minX = Math.min(minX, px); maxX = Math.max(maxX, px); minY = Math.min(minY, py); maxY = Math.max(maxY, py);
    }
    return { minX, maxX, minY, maxY };
  }

  it.each([1, 1.1])('centres the box in the region and spans fill = %s of it', (fill) => {
    const box = new Box3(new Vector3(-1, 0, -0.5), new Vector3(1, 1.5, 0.5));
    const region = { x: 0, y: 0, w: 1000, h: 900 };
    const pose = fitPoseInRegion({
      points: boxCorners(box), viewDir: new Vector3(1, 0.8, 1.2).normalize(), up: new Vector3(0, 1, 0), fovDeg: 45, canvas, region, fill,
    });
    const b = project(pose, box);
    expect((b.minX + b.maxX) / 2).toBeCloseTo(500, -1);
    expect((b.minY + b.maxY) / 2).toBeCloseTo(450, -1);
    const ratio = Math.max((b.maxX - b.minX) / region.w, (b.maxY - b.minY) / region.h);
    expect(ratio).toBeCloseTo(fill, 2);
  });
});
