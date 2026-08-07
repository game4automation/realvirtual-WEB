// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect } from 'vitest';
import { ClippingPlugin } from '../src/plugins/rv-clipping-plugin';
import { Box3, Vector3 } from 'three';

// Small test access to private applyState via bracket notation.
function makePlugin(bbox: Box3): ClippingPlugin {
  const p = new ClippingPlugin();
  (p as any).bbox = bbox;
  (p as any).viewer = { markRenderDirty() {} };
  return p;
}

describe('ClippingPlugin.applyState', () => {
  const bbox = new Box3(new Vector3(-5, -2, -3), new Vector3(5, 2, 3));

  it('enabled axis clips at bbox position', () => {
    const p = makePlugin(bbox);
    p.setAxis('y', { enabled: true, position: 0 });
    const plane = (p as any).planes[1]; // y
    expect(plane.normal.y).toBeCloseTo(1);
    expect(plane.constant).toBeCloseTo(0); // center
  });

  it('flip inverts the normal', () => {
    const p = makePlugin(bbox);
    p.setAxis('y', { enabled: true, position: 0, flip: true });
    expect((p as any).planes[1].normal.y).toBeCloseTo(-1);
  });

  it('disabled axis pushes constant so nothing is clipped (LARGE)', () => {
    const p = makePlugin(bbox);
    p.setAxis('x', { enabled: false });
    expect(Math.abs((p as any).planes[0].constant)).toBeGreaterThan(1e6);
  });

  it('F7: planes array reference & length stay stable across toggles (no recompile)', () => {
    const p = makePlugin(bbox);
    const ref = (p as any).planes;
    p.setAxis('x', { enabled: true, position: 0.5 });
    p.setAxis('x', { enabled: false });
    p.setAxis('z', { enabled: true, position: -0.3 });
    expect((p as any).planes).toBe(ref); // same reference
    expect((p as any).planes.length).toBe(3); // never variable length
  });
});
