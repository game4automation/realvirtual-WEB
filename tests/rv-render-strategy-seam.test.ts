// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2215 9.6 — the neutral render strategy seam of RVViewer.render():
 * mono path unchanged without a strategy, N views with their own cameras and
 * overlay passes, scissor/viewport reset after the frame, shadows once per
 * frame, the error path (strategy removed, mono frame, onFailed once), the
 * single owner, captures stay mono, render on demand.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PerspectiveCamera, Vector2, Vector4, WebGLRenderTarget, type Camera, type WebGLRenderer } from 'three';
import { createTestViewer, type TestViewerHandle } from './helpers/create-test-viewer';
import type { RenderStrategy, RenderStrategyContext, ViewportRect } from '../src/core/engine/rv-render-strategy';
import { HIGHLIGHT_OVERLAY_LAYER } from '../src/core/engine/rv-group-registry';

interface RenderCall {
  camera: Camera;
  mask: number;
  scissor: boolean;
  shadowNeedsUpdate: boolean;
}

let handle: TestViewerHandle;
let calls: RenderCall[];
let renderSpy: ReturnType<typeof vi.spyOn>;

function gl(): WebGLRenderer {
  return handle.viewer.renderer as unknown as WebGLRenderer;
}

/** One render() pass of the viewer with the dirty flag set. */
function frame(): void {
  handle.viewer.markRenderDirty();
  (handle.viewer as unknown as { render(): void }).render();
}

class TwoViewStrategy implements RenderStrategy {
  active = true;
  readonly cams = [new PerspectiveCamera(50, 1, 0.1, 100), new PerspectiveCamera(50, 1, 0.1, 100)];
  readonly rects: ViewportRect[] = [{ x: 0, y: 0, w: 0, h: 0 }, { x: 0, y: 0, w: 0, h: 0 }];
  frames = 0;
  failOnView = -1;
  failed: unknown[] = [];

  renderFrame(ctx: RenderStrategyContext): void {
    this.frames++;
    const half = Math.floor(ctx.canvasWidth / 2);
    this.rects[0] = { x: 0, y: 0, w: half, h: ctx.canvasHeight };
    this.rects[1] = { x: half, y: 0, w: ctx.canvasWidth - half, h: ctx.canvasHeight };
    for (let i = 0; i < 2; i++) {
      if (i === this.failOnView)
        throw new Error('view failed');
      this.cams[i].position.set(i === 0 ? -1 : 1, 0, 5);
      this.cams[i].updateMatrixWorld();
      ctx.renderViewport(this.rects[i], this.cams[i]);
    }
  }

  onFailed(err: unknown): void {
    this.failed.push(err);
  }
}

beforeEach(async () => {
  handle = await createTestViewer('webgl', { width: 640, height: 480 });
  handle.viewer.loop.stop();
  calls = [];
  const r = gl();
  const original = r.render.bind(r);
  renderSpy = vi.spyOn(r, 'render').mockImplementation((scene, camera) => {
    calls.push({
      camera,
      mask: camera.layers.mask,
      scissor: r.getScissorTest(),
      shadowNeedsUpdate: (r.shadowMap as unknown as { needsUpdate: boolean }).needsUpdate,
    });
    original(scene, camera);
  });
});

afterEach(() => {
  renderSpy?.mockRestore();
  handle?.dispose();
});

describe('render strategy seam (plan-2215)', () => {
  it('without a strategy the render calls are identical before and after a strategy was installed and removed', () => {
    frame();
    const before = calls.map(c => ({ camera: c.camera, mask: c.mask, scissor: c.scissor }));
    expect(before.length).toBeGreaterThan(0);
    expect(before.every(c => c.scissor === false)).toBe(true);
    const s = new TwoViewStrategy();
    expect(handle.viewer.setRenderStrategy(s)).toBe(true);
    expect(handle.viewer.setRenderStrategy(null)).toBe(true);
    calls = [];
    frame();
    expect(calls.map(c => ({ camera: c.camera, mask: c.mask, scissor: c.scissor }))).toEqual(before);
    expect(s.frames).toBe(0);
  });

  it('renders two views with their own cameras, overlay pass per view with the view camera', () => {
    const s = new TwoViewStrategy();
    handle.viewer.setRenderStrategy(s);
    const viewports: number[][] = [];
    const vpSpy = vi.spyOn(gl(), 'setViewport');
    frame();
    for (const call of vpSpy.mock.calls)
      viewports.push(call.slice(0, 4) as number[]);
    vpSpy.mockRestore();
    expect(s.frames).toBe(1);
    // Per view: scene pass (overlay layers off) + overlay pass (overlay layers only).
    expect(calls.map(c => c.camera)).toEqual([s.cams[0], s.cams[0], s.cams[1], s.cams[1]]);
    expect(calls.every(c => c.scissor)).toBe(true);
    expect(calls[0].mask & (1 << HIGHLIGHT_OVERLAY_LAYER)).toBe(0);
    expect(calls[1].mask & (1 << HIGHLIGHT_OVERLAY_LAYER)).not.toBe(0);
    expect(calls[3].mask & (1 << HIGHLIGHT_OVERLAY_LAYER)).not.toBe(0);
    expect(viewports).toContainEqual([0, 0, 320, 480]);
    expect(viewports).toContainEqual([320, 0, 320, 480]);
    // The view cameras' layer masks are restored.
    expect(s.cams[0].layers.mask & (1 << HIGHLIGHT_OVERLAY_LAYER)).toBe(0);
  });

  it('resets scissor and viewport after the frame', () => {
    handle.viewer.setRenderStrategy(new TwoViewStrategy());
    frame();
    expect(gl().getScissorTest()).toBe(false);
    const vp = gl().getViewport(new Vector4());
    expect([vp.x, vp.y, vp.z, vp.w]).toEqual([0, 0, 640, 480]);
  });

  it('updates the shadow map with the first view only', () => {
    handle.viewer.setRenderStrategy(new TwoViewStrategy());
    (handle.viewer as unknown as { _shadowsDirty: boolean })._shadowsDirty = true;
    frame();
    const scenePasses = calls.filter((_, i) => i % 2 === 0);
    expect(scenePasses[0].shadowNeedsUpdate).toBe(true);
    expect(scenePasses[1].shadowNeedsUpdate).toBe(false);
  });

  it('a throw (second view) removes the strategy, renders mono and calls onFailed exactly once', () => {
    const s = new TwoViewStrategy();
    s.failOnView = 1;
    handle.viewer.setRenderStrategy(s);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => { });
    frame();
    errors.mockRestore();
    expect(handle.viewer.renderStrategy).toBeNull();
    expect(s.failed).toHaveLength(1);
    expect(calls.some(c => c.camera === handle.viewer.camera && !c.scissor)).toBe(true);
    expect(gl().getScissorTest()).toBe(false);
    // The next frame is plain mono, the failed strategy is not asked again.
    calls = [];
    frame();
    expect(s.frames).toBe(1);
    expect(calls.every(c => c.camera === handle.viewer.camera)).toBe(true);
    // ... and a strategy can be installed again.
    expect(handle.viewer.setRenderStrategy(new TwoViewStrategy())).toBe(true);
  });

  it('has exactly one owner', () => {
    const a = new TwoViewStrategy();
    const b = new TwoViewStrategy();
    expect(handle.viewer.setRenderStrategy(a)).toBe(true);
    expect(handle.viewer.setRenderStrategy(b)).toBe(false);
    expect(handle.viewer.renderStrategy).toBe(a);
    expect(handle.viewer.renderStrategyActive).toBe(true);
    a.active = false;
    expect(handle.viewer.renderStrategyActive).toBe(false);
  });

  it('an inactive strategy leaves the frame mono', () => {
    const s = new TwoViewStrategy();
    s.active = false;
    handle.viewer.setRenderStrategy(s);
    frame();
    expect(s.frames).toBe(0);
    expect(calls.every(c => c.camera === handle.viewer.camera)).toBe(true);
  });

  it('renderFrameForCapture stays mono and the next live frame redraws the views', () => {
    const s = new TwoViewStrategy();
    handle.viewer.setRenderStrategy(s);
    expect(handle.viewer.renderFrameForCapture()).toBe(true);
    expect(s.frames).toBe(0);
    expect(calls.every(c => c.camera === handle.viewer.camera)).toBe(true);
    (handle.viewer as unknown as { render(): void }).render();
    expect(s.frames).toBe(1);
  });

  it('post-review 4: onFailed runs exactly once even when the mono fallback throws too', () => {
    const s = new TwoViewStrategy();
    s.failOnView = 0;
    handle.viewer.setRenderStrategy(s);
    const mono = handle.viewer.camera;
    // Only the fallback throws (the first mono call); the overlay pass after the recovery runs.
    let monoCalls = 0;
    renderSpy.mockImplementation((_scene: unknown, camera: unknown) => {
      if (camera === mono && monoCalls++ === 0)
        throw new Error('mono fallback failed');
    });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => { });
    const warns = vi.spyOn(console, 'warn').mockImplementation(() => { });
    frame();
    errors.mockRestore();
    warns.mockRestore();
    expect(s.failed).toHaveLength(1);
    expect(handle.viewer.renderStrategy).toBeNull();
    expect(handle.viewer.pointerPickBlocked).toBe(false);
    expect(gl().getScissorTest()).toBe(false);
  });

  it('post-review 5: a strategy that binds a render target and throws leaves the entry target bound', () => {
    const target = new WebGLRenderTarget(16, 16);
    const s = new TwoViewStrategy();
    s.renderFrame = () => {
      s.frames++;
      gl().setRenderTarget(target);
      throw new Error('bound and failed');
    };
    handle.viewer.setRenderStrategy(s);
    const targets: Array<unknown> = [];
    const r = gl();
    renderSpy.mockImplementation(() => { targets.push(r.getRenderTarget()); });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => { });
    frame();
    errors.mockRestore();
    expect(s.failed).toHaveLength(1);
    expect(r.getRenderTarget()).toBeNull();
    // The mono fallback went to the back buffer, not into the strategy's target.
    expect(targets.length).toBeGreaterThan(0);
    expect(targets[0]).toBeNull();
    const vp = r.getViewport(new Vector4());
    expect([vp.x, vp.y, vp.z, vp.w]).toEqual([0, 0, 640, 480]);
    target.dispose();
  });

  it('post-review 6: strategyFrame is true for strategy frames only, captures are mono', () => {
    const seen: boolean[] = [];
    handle.viewer.use({ id: 'probe-onrender', onRender: () => { seen.push(handle.viewer.strategyFrame); } });
    const s = new TwoViewStrategy();
    handle.viewer.setRenderStrategy(s);
    frame();
    expect(seen.at(-1)).toBe(true);
    // A tick without a main render: the buffer still holds the strategy frame.
    (handle.viewer as unknown as { render(): void }).render();
    expect(seen.at(-1)).toBe(true);
    expect(handle.viewer.renderFrameForCapture()).toBe(true);
    expect(seen.at(-1)).toBe(false);
    frame();
    expect(seen.at(-1)).toBe(true);
    s.active = false;
    frame();
    expect(seen.at(-1)).toBe(false);
  });

  it('post-review 8: a strategy pixelRatio holds the DPR, survives resize and the setting, restores on removal', () => {
    const r = gl();
    r.setPixelRatio(2);
    const size = new Vector2();
    expect(r.getDrawingBufferSize(size).x).toBe(1280);
    const s = Object.assign(new TwoViewStrategy(), { pixelRatio: 1 });
    handle.viewer.setRenderStrategy(s);
    expect(r.getPixelRatio()).toBe(1);
    expect(r.getDrawingBufferSize(size).toArray()).toEqual([640, 480]);
    // The regular resize path keeps DPR 1.
    (handle.viewer as unknown as { resizeHandler: (() => void) | null }).resizeHandler?.();
    expect(r.getPixelRatio()).toBe(1);
    // The render-resolution setting changes the DPR: the strategy wins, the new value is restored later.
    r.setPixelRatio(1.5);
    frame();
    expect(r.getPixelRatio()).toBe(1);
    expect(s.frames).toBeGreaterThan(0);
    // A capture in between leaves it at 1 as well.
    handle.viewer.renderFrameForCapture();
    expect(r.getPixelRatio()).toBe(1);
    handle.viewer.setRenderStrategy(null);
    expect(r.getPixelRatio()).toBe(1.5);
    expect(r.getDrawingBufferSize(size).toArray()).toEqual([960, 720]);
  });

  it('post-review 8: the failure path restores the DPR as well', () => {
    const r = gl();
    r.setPixelRatio(2);
    const s = Object.assign(new TwoViewStrategy(), { pixelRatio: 1 });
    s.failOnView = 0;
    handle.viewer.setRenderStrategy(s);
    expect(r.getPixelRatio()).toBe(1);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => { });
    frame();
    errors.mockRestore();
    expect(s.failed).toHaveLength(1);
    expect(r.getPixelRatio()).toBe(2);
  });

  it('renders on demand only: a clean frame does not call the strategy', () => {
    const s = new TwoViewStrategy();
    handle.viewer.setRenderStrategy(s);
    frame();
    expect(s.frames).toBe(1);
    (handle.viewer as unknown as { render(): void }).render();
    expect(s.frames).toBe(1);
    handle.viewer.markRenderDirty();
    (handle.viewer as unknown as { render(): void }).render();
    expect(s.frames).toBe(2);
  });

  it('keeps a configured drawing buffer through window resize and restores the original buffer on stop', async () => {
    const resized = await createTestViewer('webgl', { width: 640, height: 480, autoResize: true });
    resized.viewer.loop.stop();
    try {
      const r = resized.viewer.renderer as unknown as WebGLRenderer;
      r.setPixelRatio(2);
      const s = Object.assign(new TwoViewStrategy(), {
        pixelRatio: 1, canvasSize: { width: 3840, height: 2160 },
      });
      resized.viewer.setRenderStrategy(s);
      expect(r.getDrawingBufferSize(new Vector2()).toArray()).toEqual([3840, 2160]);
      window.dispatchEvent(new Event('resize'));
      expect(r.getDrawingBufferSize(new Vector2()).toArray()).toEqual([3840, 2160]);
      expect(r.domElement.clientWidth).toBe(640);
      resized.viewer.setRenderStrategy(null);
      expect(r.getPixelRatio()).toBe(2);
      expect(r.getSize(new Vector2()).toArray()).toEqual([640, 480]);
      expect(r.getDrawingBufferSize(new Vector2()).toArray()).toEqual([1280, 960]);
    } finally { resized.dispose(); }
  });
});
