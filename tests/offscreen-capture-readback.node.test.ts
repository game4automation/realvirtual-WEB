// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * offscreen-capture-readback.node.test.ts — plan-763 Phase 1, the pure parts.
 *
 * The real WebGPU readback branch never runs headless (no adapter), so the two
 * things it depends on are tested as pure functions:
 *  - `unpadRows` strips the 256-byte row padding of a WebGPU readback,
 *    including the SHORT last row three's backend produces;
 *  - `drawCallsOf` prefers the per-frame `drawCalls` over the cumulative
 *    `calls` of three/webgpu's Info, and stays byte-identical on WebGL.
 */

import { describe, it, expect } from 'vitest';
import { unpadRows, captureSupported } from '../src/core/engine/rv-offscreen-capture';
import { drawCallsOf } from '../src/core/engine/rv-frame-stats';

/** A padded buffer the way WebGPUTextureUtils.copyTextureToBuffer lays it out. */
function paddedReadback(width: number, height: number): { src: Uint8Array; bytesPerRow: number } {
  const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
  const src = new Uint8Array((height - 1) * bytesPerRow + width * 4); // short last row
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = y * bytesPerRow + x * 4;
      src[o] = x; src[o + 1] = y; src[o + 2] = 7; src[o + 3] = 255;
    }
    // Padding bytes carry garbage that must never leak into the result.
    for (let b = width * 4; b < bytesPerRow && y < height - 1; b++) src[y * bytesPerRow + b] = 0xee;
  }
  return { src, bytesPerRow };
}

describe('unpadRows (plan-763)', () => {
  it('strips 256-byte row padding including a short last row (width 50)', () => {
    const { src, bytesPerRow } = paddedReadback(50, 3);
    expect(bytesPerRow).toBe(256);
    const out = unpadRows(src, 50, 3, bytesPerRow);
    expect(out.length).toBe(50 * 3 * 4);
    for (let y = 0; y < 3; y++) {
      for (let x = 0; x < 50; x++) {
        const o = (y * 50 + x) * 4;
        expect([out[o], out[o + 1], out[o + 2], out[o + 3]]).toEqual([x, y, 7, 255]);
      }
    }
    expect(Array.from(out).includes(0xee)).toBe(false);
  });

  it('passes a tightly packed buffer through unchanged (width 64 = no padding)', () => {
    const { src, bytesPerRow } = paddedReadback(64, 2);
    expect(bytesPerRow).toBe(256);
    expect(unpadRows(src, 64, 2, bytesPerRow)).toBe(src);
  });

  it('handles a 1-pixel-wide target', () => {
    const { src, bytesPerRow } = paddedReadback(1, 4);
    const out = unpadRows(src, 1, 4, bytesPerRow);
    expect(out.length).toBe(16);
    expect(out[1]).toBe(0);
    expect(out[13]).toBe(3);
  });
});

describe('drawCallsOf (plan-763)', () => {
  it('returns calls on a WebGL-shaped info (unchanged behaviour)', () => {
    expect(drawCallsOf({ render: { calls: 42, triangles: 0 } })).toBe(42);
  });

  it('prefers the per-frame drawCalls on a WebGPU-shaped info', () => {
    // three/webgpu: `calls` is the cumulative renderer.render() count that
    // info.reset() never clears; `drawCalls` is the frame's draw count.
    const info = { render: { calls: 500, drawCalls: 7, triangles: 0 } };
    expect(drawCallsOf(info)).toBe(7);
    // Next frame: calls keeps growing, drawCalls was reset and re-counted.
    info.render.calls = 503;
    info.render.drawCalls = 7;
    expect(drawCallsOf(info)).toBe(7);
  });

  it('is 0 without either counter', () => {
    expect(drawCallsOf({ render: { triangles: 0 } })).toBe(0);
  });
});

describe('captureSupported (plan-763)', () => {
  it('accepts the classic renderer, both WebGPURenderer backends, and refuses a stub', () => {
    expect(captureSupported({ readRenderTargetPixels() {} }, 't')).toBeNull();
    expect(captureSupported({ isWebGPURenderer: true, readRenderTargetPixelsAsync: async () => undefined }, 't')).toBeNull();
    expect(captureSupported({ isWebGPURenderer: true }, 't')).toMatch(/^t needs a renderer/);
    expect(captureSupported(undefined, 't')).toMatch(/^t has no renderer/);
  });
});
