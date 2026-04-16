// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Navigation Helper Unit Tests (Plan 148)
 *
 * `applyNavigationSettingsToControls` is a pure function that accepts any
 * OrbitControls-shaped object. These tests run against a plain mock — no
 * WebGL or Three.js setup needed, so they are deterministic and fast.
 */

import { describe, it, expect } from 'vitest';
import { applyNavigationSettingsToControls } from '../src/core/rv-viewer';

describe('applyNavigationSettingsToControls', () => {
  it('applies all 4 settings to controls object', () => {
    const mockControls = { rotateSpeed: 0, panSpeed: 0, zoomSpeed: 0, dampingFactor: 0 };
    applyNavigationSettingsToControls(mockControls, {
      orbitRotateSpeed: 2.5,
      orbitPanSpeed: 0.5,
      orbitZoomSpeed: 1.8,
      orbitDampingFactor: 0.12,
    });
    expect(mockControls.rotateSpeed).toBe(2.5);
    expect(mockControls.panSpeed).toBe(0.5);
    expect(mockControls.zoomSpeed).toBe(1.8);
    expect(mockControls.dampingFactor).toBe(0.12);
  });

  it('does not mutate the input settings object', () => {
    const mockControls = { rotateSpeed: 0, panSpeed: 0, zoomSpeed: 0, dampingFactor: 0 };
    const settings = {
      orbitRotateSpeed: 1.0,
      orbitPanSpeed: 1.0,
      orbitZoomSpeed: 1.0,
      orbitDampingFactor: 0.08,
    };
    const snapshot = { ...settings };
    applyNavigationSettingsToControls(mockControls, settings);
    expect(settings).toEqual(snapshot);
  });

  it('overwrites existing controls values', () => {
    const mockControls = { rotateSpeed: 99, panSpeed: 99, zoomSpeed: 99, dampingFactor: 99 };
    applyNavigationSettingsToControls(mockControls, {
      orbitRotateSpeed: 1.0,
      orbitPanSpeed: 1.0,
      orbitZoomSpeed: 1.0,
      orbitDampingFactor: 0.08,
    });
    expect(mockControls.rotateSpeed).toBe(1.0);
    expect(mockControls.panSpeed).toBe(1.0);
    expect(mockControls.zoomSpeed).toBe(1.0);
    expect(mockControls.dampingFactor).toBe(0.08);
  });
});
