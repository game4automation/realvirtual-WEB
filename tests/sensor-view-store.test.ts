// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect, beforeEach } from 'vitest';
import { sensorViewStore } from '../src/core/hmi/sensor-view-store';

describe('sensor-view-store', () => {
  beforeEach(() => {
    localStorage.clear();
    // Reset internal state (via load() that re-reads localStorage).
    (sensorViewStore as any)._state = sensorViewStore.load();
  });

  it('defaults: visible=true, shapeOverride=null, isolate=false', () => {
    const s = sensorViewStore.getSnapshot();
    expect(s.visible).toBe(true);
    expect(s.shapeOverride).toBeNull();
    expect(s.isolate).toBe(false);
  });

  it('persists isolate across reload', () => {
    sensorViewStore.setIsolate(true);
    expect(sensorViewStore.load().isolate).toBe(true);
  });

  it('overrides gizmo shape globally', () => {
    sensorViewStore.setShapeOverride('sphere');
    expect(sensorViewStore.getSnapshot().shapeOverride).toBe('sphere');
  });

  it('toggles visibility', () => {
    sensorViewStore.setVisible(false);
    expect(sensorViewStore.getSnapshot().visible).toBe(false);
  });
});
