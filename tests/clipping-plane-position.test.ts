// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect } from 'vitest';
import { computeClipPlanePosition } from '../src/plugins/rv-clipping-plugin';
import { Box3, Vector3 } from 'three';

describe('computeClipPlanePosition', () => {
  const bbox = new Box3(new Vector3(-5, -2, -3), new Vector3(5, 2, 3));

  it('normalizedPos=0 -> bbox center', () => {
    expect(computeClipPlanePosition(bbox, 'y', 0)).toBeCloseTo(0);
  });

  it('normalizedPos=-1 -> bbox min', () => {
    expect(computeClipPlanePosition(bbox, 'y', -1)).toBeCloseTo(-2);
  });

  it('normalizedPos=+1 -> bbox max', () => {
    expect(computeClipPlanePosition(bbox, 'x', 1)).toBeCloseTo(5);
  });

  it('asymmetric bbox maps correctly along z', () => {
    const asym = new Box3(new Vector3(0, 0, 2), new Vector3(0, 0, 12));
    expect(computeClipPlanePosition(asym, 'z', 0)).toBeCloseTo(7); // center
    expect(computeClipPlanePosition(asym, 'z', -1)).toBeCloseTo(2); // min
    expect(computeClipPlanePosition(asym, 'z', 1)).toBeCloseTo(12); // max
    expect(computeClipPlanePosition(asym, 'z', 0.5)).toBeCloseTo(9.5); // center + 0.5*half
  });
});
