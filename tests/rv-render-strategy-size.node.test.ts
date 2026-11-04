// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
import { describe, expect, it, vi } from 'vitest';
import { Vector2 } from 'three';
import { RVViewer } from '../src/core/rv-viewer';
import type { RenderStrategy } from '../src/core/engine/rv-render-strategy';

describe('fixed render strategy canvas size', () => {
  it.each([1, 2])('sets the configured buffer and restores size and original DPR %i on removal', originalRatio => {
    const size = new Vector2(1920, 1080);
    let ratio = originalRatio;
    const viewer = Object.create(RVViewer.prototype) as RVViewer;
    Object.assign(viewer, {
      _renderStrategy: null, _dprBeforeStrategy: null, _sizeBeforeStrategy: null, resizeHandler: null,
      renderer: {
        getSize: (out: Vector2) => out.copy(size),
        setSize: vi.fn((w: number, h: number) => size.set(w, h)),
        getPixelRatio: () => ratio, setPixelRatio: (value: number) => { ratio = value; },
      },
    });
    const strategy: RenderStrategy = { active: true, pixelRatio: 1,
      canvasSize: { width: 3840, height: 2160 }, renderFrame() {}, onFailed() {} };
    expect(viewer.setRenderStrategy(strategy)).toBe(true);
    expect(size.toArray()).toEqual([3840, 2160]);
    expect(ratio).toBe(1);
    viewer.setRenderStrategy(null);
    expect(size.toArray()).toEqual([1920, 1080]);
    expect(ratio).toBe(originalRatio);
    expect(viewer.renderer.setSize).toHaveBeenCalledWith(3840, 2160, false);
    expect(viewer.renderer.setSize).toHaveBeenLastCalledWith(1920, 1080, false);
  });
});
