// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-492 §9.4 / R7 — draw calls are counted the same under both backends.
 *
 * `WebGLRenderer.info` counts draw calls in `render.calls`; the WebGPU `Info`
 * counts them in `render.drawCalls` (three PR #30359). The accounting in
 * `rv-frame-stats.ts` and in the viewer's frame loop reads BOTH ends of every
 * pass — the start value and the end value — and the failure mode when only one
 * of them is migrated is silent and plausible-looking: `end − 0`, i.e. every
 * pass reporting the whole frame's draw calls.
 *
 * These tests therefore never call the renderer. They feed the accounting a
 * counter object of each shape, with a known number of draws, and check that the
 * bucket arithmetic comes out the same — including over consecutive frames,
 * where a wrong start value only shows up from the second frame on.
 */
import { describe, expect, it } from 'vitest';
import {
  drawCallsOf, createFrameStats, resetFrameStats, addDelta, finalizeFrameStats,
  type RenderInfoLike,
} from '../../src/core/engine/rv-frame-stats';

/** A counter object of the WebGL shape (`render.calls`). */
function webglInfo(): RenderInfoLike & { draw(n: number, tris?: number): void; reset(): void } {
  const info = {
    render: { calls: 0, triangles: 0 },
    draw(n: number, tris = n * 12) { info.render.calls += n; info.render.triangles += tris; },
    reset() { info.render.calls = 0; info.render.triangles = 0; },
  };
  return info;
}

/** A counter object of the WebGPU shape (`render.drawCalls`, no `calls`). */
function webgpuInfo(): RenderInfoLike & { draw(n: number, tris?: number): void; reset(): void } {
  const info = {
    render: { drawCalls: 0, triangles: 0 },
    draw(n: number, tris = n * 12) { info.render.drawCalls += n; info.render.triangles += tris; },
    reset() { info.render.drawCalls = 0; info.render.triangles = 0; },
  };
  return info;
}

describe('draw-call counters across backends (plan-492 R7)', () => {
  it('drawCallsOf reads either field and never returns undefined', () => {
    expect(drawCallsOf({ render: { calls: 7, triangles: 0 } })).toBe(7);
    expect(drawCallsOf({ render: { drawCalls: 7, triangles: 0 } })).toBe(7);
    // A backend that exposes neither must read as 0, not NaN: `NaN − NaN`
    // poisons every bucket for the rest of the session.
    expect(drawCallsOf({ render: { triangles: 0 } })).toBe(0);
  });

  it.each([['webgl', webglInfo], ['webgpu', webgpuInfo]] as const)(
    'splits the same known passes identically (%s)',
    (_name, make) => {
      const info = make();
      const frame = createFrameStats();

      // Frame 1: 5 scene draws, then 5 shadow draws, then 2 overlay draws.
      info.reset();
      resetFrameStats(frame);
      let c0 = drawCallsOf(info); let t0 = info.render.triangles;
      info.draw(5);
      addDelta(frame.scene, info, c0, t0);
      c0 = drawCallsOf(info); t0 = info.render.triangles;
      info.draw(5);
      addDelta(frame.shadow, info, c0, t0);
      c0 = drawCallsOf(info); t0 = info.render.triangles;
      info.draw(2);
      addDelta(frame.overlay, info, c0, t0);
      finalizeFrameStats(frame, info);

      expect(frame.scene.calls).toBe(5);
      expect(frame.shadow.calls).toBe(5);
      expect(frame.overlay.calls).toBe(2);
      expect(frame.total.calls).toBe(12);
      expect(frame.other.calls).toBe(0);
      expect(frame.scene.triangles).toBe(60);
    },
  );

  it.each([['webgl', webglInfo], ['webgpu', webgpuInfo]] as const)(
    'stays correct over consecutive frames (%s)',
    (_name, make) => {
      const info = make();
      const frame = createFrameStats();
      for (let f = 0; f < 3; f++) {
        info.reset();
        resetFrameStats(frame);
        const c0 = drawCallsOf(info); const t0 = info.render.triangles;
        info.draw(4);
        addDelta(frame.scene, info, c0, t0);
        finalizeFrameStats(frame, info);
        expect(frame.scene.calls, `frame ${f}`).toBe(4);
        expect(frame.total.calls, `frame ${f}`).toBe(4);
      }
    },
  );

  it('a half-migrated read is exactly the bug this guards against', () => {
    // Documented counter-example: taking the start value off `render.calls`
    // while the backend writes `render.drawCalls` reports the whole frame as
    // the pass — which is what a "shadow pass costs as much as the scene"
    // report would have looked like.
    const info = webgpuInfo();
    const frame = createFrameStats();
    info.draw(9);
    const wrongStart = (info.render as { calls?: number }).calls ?? 0;
    addDelta(frame.scene, info, wrongStart, 0);
    expect(frame.scene.calls, 'the naive read inflates the pass').toBe(9);
    resetFrameStats(frame);
    addDelta(frame.scene, info, drawCallsOf(info), info.render.triangles);
    expect(frame.scene.calls, 'the shared accessor books nothing for no work').toBe(0);
  });

  it('the source carries no direct `render.calls` read any more', async () => {
    for (const mod of ['../../src/core/engine/rv-frame-stats.ts', '../../src/core/rv-viewer.ts']) {
      const source = (await import(/* @vite-ignore */ `${mod}?raw`)).default as string;
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
      // `r.calls ?? r.drawCalls` inside `drawCallsOf` itself is the one allowed
      // read, and it does not spell out `render.calls`.
      expect(code, `${mod} reads draw calls through drawCallsOf()`).not.toMatch(/\.render\.calls/);
    }
  });
});
