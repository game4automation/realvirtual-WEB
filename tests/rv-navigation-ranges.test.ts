// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * NAVIGATION_RANGES Constants Test (Plan 148)
 *
 * `NAVIGATION_RANGES` is the single source of truth for OrbitControls slider
 * bounds and store-side clamping. A typo in min/max/step would silently break
 * UI alignment and clamp behaviour — pin values explicitly.
 */

import { describe, it, expect } from 'vitest';
import { NAVIGATION_RANGES } from '../src/core/hmi/visual-settings-store';

describe('NAVIGATION_RANGES constants', () => {
  it('has expected min/max/step for rotate, pan, zoom', () => {
    expect(NAVIGATION_RANGES.rotateSpeed).toEqual({ min: 0.1, max: 3.0, step: 0.05 });
    expect(NAVIGATION_RANGES.panSpeed).toEqual({ min: 0.1, max: 3.0, step: 0.05 });
    expect(NAVIGATION_RANGES.zoomSpeed).toEqual({ min: 0.1, max: 3.0, step: 0.1 });
  });

  it('has expected min/max/step for damping', () => {
    expect(NAVIGATION_RANGES.dampingFactor).toEqual({ min: 0.01, max: 0.5, step: 0.01 });
  });

  it('min < max for every range', () => {
    for (const range of Object.values(NAVIGATION_RANGES)) {
      expect(range.min).toBeLessThan(range.max);
      expect(range.step).toBeGreaterThan(0);
    }
  });
});
