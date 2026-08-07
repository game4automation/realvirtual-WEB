// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { afterEach, describe, expect, it, vi } from 'vitest';
import { Box3, PerspectiveCamera, Vector3 } from 'three';
import { RVEmbedViewer } from '../src/embed/rv-embed-viewer';

const VIGNETTE_URL = '/embed/vignettes/conveyor-sensor.glb';
const viewers: RVEmbedViewer[] = [];

afterEach(() => {
  for (const viewer of viewers.splice(0)) viewer.dispose();
  vi.restoreAllMocks();
});

describe('rv-embed camera framing and self-contained loading', () => {
  it.each([
    { label: 'small card', width: 260, height: 180 },
    { label: 'wide card', width: 640, height: 240 },
  ])('fills a useful share of the $label viewport from StartCameraPosition', async ({ width, height }) => {
    const requestedUrls: string[] = [];
    const nativeFetch = globalThis.fetch.bind(globalThis);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      requestedUrls.push(
        typeof input === 'string' ? input : input instanceof Request ? input.url : input.href,
      );
      return nativeFetch(input, init);
    });

    const viewer = new RVEmbedViewer({ width, height });
    viewers.push(viewer);
    const result = await viewer.loadModel(VIGNETTE_URL);
    const camera = viewer.controls.object as PerspectiveCamera;
    const coverage = projectedCoverage(result.boundingBox, camera);
    const motifSize = result.boundingBox.getSize(new Vector3());
    const cameraDistance = camera.position.distanceTo(viewer.controls.target);

    expect(motifSize.toArray()).toEqual([
      expect.closeTo(0.634, 2),
      expect.closeTo(0.644, 2),
      expect.closeTo(7.168, 2),
    ]);
    expect(viewer.controls.target.toArray()).toEqual([
      expect.closeTo(2.2, 5),
      expect.closeTo(0.35, 5),
      expect.closeTo(0.1, 5),
    ]);
    expect(Math.max(coverage.width, coverage.height)).toBeGreaterThan(0.65);
    expect(coverage.width).toBeLessThanOrEqual(1);
    expect(coverage.height).toBeLessThanOrEqual(1);
    expect(cameraDistance).toBeGreaterThan(motifSize.z * 0.6);
    expect(cameraDistance).toBeLessThan(motifSize.z * 1.1);
    expect(requestedUrls.some((url) => /\.kin\.json(?:\?|$)/u.test(url))).toBe(false);
  }, 240_000);
});

function projectedCoverage(box: Box3, camera: PerspectiveCamera): {
  width: number;
  height: number;
} {
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const x of [box.min.x, box.max.x]) {
    for (const y of [box.min.y, box.max.y]) {
      for (const z of [box.min.z, box.max.z]) {
        const point = new Vector3(x, y, z).project(camera);
        minX = Math.min(minX, point.x);
        maxX = Math.max(maxX, point.x);
        minY = Math.min(minY, point.y);
        maxY = Math.max(maxY, point.y);
      }
    }
  }

  return {
    width: (maxX - minX) / 2,
    height: (maxY - minY) / 2,
  };
}
