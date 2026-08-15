// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * ThumbnailRenderer — the high-quality preview pipeline (plan-712 §9.1).
 *
 * These run against real WebGL in headless Chromium, i.e. a software/ANGLE
 * rasteriser, so pixel assertions carry a tolerance instead of exact values.
 * What they pin down is the set of handles that have no precedent anywhere else
 * in the repo and fail silently when wrong:
 *   - the PNG really is `size` px (proves `setPixelRatio(1)` — the renderer
 *     below deliberately runs at DPR 2, so an unnormalised composer would size
 *     its buffers to 2048 and the 1024 px readback would return a cropped
 *     quadrant);
 *   - the transparent background survives the GTAO blend chain (merge gate);
 *   - the shared renderer's global state is exactly as it was afterwards;
 *   - no bloom pass sneaks in (UnrealBloomPass would clamp alpha to 1);
 *   - a WebGPU renderer is skipped, not crashed into.
 */

import { describe, it, expect } from 'vitest';
import {
  ACESFilmicToneMapping,
  BoxGeometry,
  Mesh,
  MeshStandardMaterial,
  Scene,
  WebGLRenderer,
} from 'three';
import type { Object3D } from 'three';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ThumbnailRenderer } from '../src/core/thumbnails/thumbnail-renderer';

/** Real renderer + empty main scene, mirroring `makeHost()` in
 *  `rv-post-processing.test.ts`. DPR 2 on purpose (see file doc). */
function makeRendererAndScene(): { renderer: WebGLRenderer; scene: Scene } {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const renderer = new WebGLRenderer({ canvas, alpha: true });
  renderer.setPixelRatio(2);
  renderer.setSize(64, 64, /* updateStyle */ false);
  return { renderer, scene: new Scene() };
}

function makeUnitCube(): Object3D {
  return new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial({ color: 0x9099a5 }));
}

interface DecodedImage {
  width: number;
  height: number;
  pixelAt(x: number, y: number): { r: number; g: number; b: number; a: number };
}

/** Decode a PNG data URL into something pixel-addressable. No such helper
 *  exists in the repo; `Image.decode()` + `getImageData` works in browser mode. */
async function decodeDataUrl(dataUrl: string): Promise<DecodedImage> {
  const img = new Image();
  img.src = dataUrl;
  await img.decode();
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0);
  return {
    width: img.naturalWidth,
    height: img.naturalHeight,
    pixelAt(x: number, y: number) {
      const d = ctx.getImageData(x, y, 1, 1).data;
      return { r: d[0], g: d[1], b: d[2], a: d[3] };
    },
  };
}

describe('ThumbnailRenderer HQ pipeline', () => {
  it('renders a 512x512 PNG with transparent corners and opaque subject', async () => {
    const { renderer, scene } = makeRendererAndScene();
    const tr = new ThumbnailRenderer(renderer, scene);
    try {
      const dataUrl = tr.render(makeUnitCube(), 512)!;
      expect(dataUrl.startsWith('data:image/png')).toBe(true);

      const { width, height, pixelAt } = await decodeDataUrl(dataUrl);
      expect(width).toBe(512);
      expect(height).toBe(512);
      expect(pixelAt(2, 2).a).toBeLessThan(8);          // corner: transparent
      expect(pixelAt(256, 256).a).toBeGreaterThan(247); // centre: the cube, opaque
    } finally {
      tr.dispose();
      renderer.dispose();
    }
  });

  it('restores renderTarget, clearAlpha and toneMapping after render', () => {
    const { renderer, scene } = makeRendererAndScene();
    renderer.toneMapping = ACESFilmicToneMapping;      // a live user setting
    const prevClearAlpha = renderer.getClearAlpha();
    const prevColorSpace = renderer.outputColorSpace;
    const tr = new ThumbnailRenderer(renderer, scene);
    try {
      tr.render(makeUnitCube(), 128);
      expect(renderer.toneMapping).toBe(ACESFilmicToneMapping);
      expect(renderer.getRenderTarget()).toBeNull();
      expect(renderer.getClearAlpha()).toBe(prevClearAlpha);
      expect(renderer.outputColorSpace).toBe(prevColorSpace);
    } finally {
      tr.dispose();
      renderer.dispose();
    }
  });

  it('builds an offscreen composer of exactly RenderPass, GTAOPass, OutputPass', () => {
    const { renderer, scene } = makeRendererAndScene();
    const tr = new ThumbnailRenderer(renderer, scene);
    try {
      tr.render(makeUnitCube(), 128);
      const composer = (tr as unknown as { _composer: { passes: object[]; renderToScreen: boolean } })._composer;
      // Identity by instanceof, not by constructor.name: the bundler renames
      // classes (GTAOPass arrives as `_GTAOPass`), so names would flake.
      expect(composer.passes.length).toBe(3);
      expect(composer.passes[0]).toBeInstanceOf(RenderPass);
      expect(composer.passes[1]).toBeInstanceOf(GTAOPass);
      expect(composer.passes[2]).toBeInstanceOf(OutputPass);
      // Guards the "no bloom" decision against a copy-paste from
      // ensureComposer(): UnrealBloomPass clamps alpha to 1 and would fill the
      // transparent background (three.js #14104).
      expect(composer.passes.some(p => /Bloom/.test(p.constructor.name))).toBe(false);
      // Must never draw onto the shared visible canvas.
      expect(composer.renderToScreen).toBe(false);
    } finally {
      tr.dispose();
      renderer.dispose();
    }
  });

  it('reuses one composer across renders and resizes it on a size change', () => {
    const { renderer, scene } = makeRendererAndScene();
    const tr = new ThumbnailRenderer(renderer, scene);
    try {
      tr.render(makeUnitCube(), 128);
      const first = (tr as unknown as { _composer: object })._composer;
      tr.render(makeUnitCube(), 256);
      const second = (tr as unknown as { _composer: { renderTarget1: { width: number } } })._composer;
      expect(second).toBe(first);                    // cached, not rebuilt (leak guard)
      expect(second.renderTarget1.width).toBe(512);  // 256 * 2 supersample, DPR ignored
    } finally {
      tr.dispose();
      renderer.dispose();
    }
  });

  it('returns null on a WebGPU renderer without touching GL state', () => {
    const fakeWebGPU = { isWebGPURenderer: true } as unknown as WebGLRenderer;
    const tr = new ThumbnailRenderer(fakeWebGPU, new Scene());
    expect(tr.render(makeUnitCube(), 512)).toBeNull();
  });
});
