// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * ThumbnailRenderer.renderLive — the no-clone, no-dispose hero-preview path.
 *
 * `render()` clones the model and `disposeSubtree`s the clone; on the LIVE
 * model root that destroyed geometries/materials shared with the live scene
 * and duplicated every BatchedMesh arena — the ~20 s dashboard freeze.
 * `renderLive()` exists so the hero card never touches the live model's
 * resources, and these tests pin exactly that:
 *   - the live mesh's geometry and material are NOT disposed, and the model
 *     stays in the scene, still renderable a second time;
 *   - renderer state (render target, clear alpha) and the live scene's
 *     background are restored;
 *   - the PNG is `size` px with a transparent background (the card floats the
 *     picture over its own surface);
 *   - an empty subtree and a WebGPU renderer return `null`, never throw.
 *
 * Runs against real WebGL in headless Chromium (same tolerance rules as
 * `thumbnail-renderer.test.ts`).
 */

import { describe, it, expect, vi } from 'vitest';
import {
  BoxGeometry,
  Color,
  DirectionalLight,
  Group,
  Mesh,
  MeshStandardMaterial,
  Scene,
  WebGLRenderer,
} from 'three';
import { ThumbnailRenderer } from '../src/core/thumbnails/thumbnail-renderer';

/** Real renderer + live main scene. DPR 2 on purpose — renderLive must size
 *  its private target itself, not inherit the canvas DPR. */
function makeRendererAndScene(): { renderer: WebGLRenderer; scene: Scene } {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const renderer = new WebGLRenderer({ canvas, alpha: true });
  renderer.setPixelRatio(2);
  renderer.setSize(64, 64, /* updateStyle */ false);
  return { renderer, scene: new Scene() };
}

/** A "live model root": a group with one lit cube, added to the main scene —
 *  renderLive renders the scene in place, so the root must actually be in it. */
function addLiveModel(scene: Scene): { root: Group; mesh: Mesh } {
  const mesh = new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial({ color: 0x9099a5 }));
  const root = new Group();
  root.add(mesh);
  scene.add(root);
  scene.add(new DirectionalLight(0xffffff, 2));
  return { root, mesh };
}

async function decodeDataUrl(dataUrl: string) {
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

describe('ThumbnailRenderer.renderLive', () => {
  it('renders a size-px PNG with transparent corner and opaque subject', async () => {
    const { renderer, scene } = makeRendererAndScene();
    const { root } = addLiveModel(scene);
    const tr = new ThumbnailRenderer(renderer, scene);
    try {
      const dataUrl = tr.renderLive(root, 256)!;
      expect(dataUrl.startsWith('data:image/png')).toBe(true);

      const { width, height, pixelAt } = await decodeDataUrl(dataUrl);
      expect(width).toBe(256);
      expect(height).toBe(256);
      expect(pixelAt(2, 2).a).toBeLessThan(8);          // corner: transparent
      expect(pixelAt(128, 128).a).toBeGreaterThan(247); // centre: the cube, opaque
    } finally {
      tr.dispose();
      renderer.dispose();
    }
  });

  it('never disposes the live model and leaves it in the scene, renderable again', () => {
    const { renderer, scene } = makeRendererAndScene();
    const { root, mesh } = addLiveModel(scene);
    const geoDispose = vi.spyOn(mesh.geometry, 'dispose');
    const matDispose = vi.spyOn(mesh.material as MeshStandardMaterial, 'dispose');
    const tr = new ThumbnailRenderer(renderer, scene);
    try {
      expect(tr.renderLive(root, 128)).not.toBeNull();
      // The whole reason this method exists: render() disposed shared
      // geometry/material through its clone and broke the live scene.
      expect(geoDispose).not.toHaveBeenCalled();
      expect(matDispose).not.toHaveBeenCalled();
      expect(root.parent).toBe(scene);
      // Still fully renderable — a disposed geometry would fail or go blank.
      expect(tr.renderLive(root, 128)).not.toBeNull();
      expect(geoDispose).not.toHaveBeenCalled();
    } finally {
      tr.dispose();
      renderer.dispose();
    }
  });

  it('restores render target, clear alpha and the live scene background', () => {
    const { renderer, scene } = makeRendererAndScene();
    const { root } = addLiveModel(scene);
    const background = new Color(0x123456);
    scene.background = background;
    const prevClearAlpha = renderer.getClearAlpha();
    const tr = new ThumbnailRenderer(renderer, scene);
    try {
      tr.renderLive(root, 128);
      expect(renderer.getRenderTarget()).toBeNull();
      expect(renderer.getClearAlpha()).toBe(prevClearAlpha);
      // Same instance, not an equal colour — the scene owns this object.
      expect(scene.background).toBe(background);
    } finally {
      tr.dispose();
      renderer.dispose();
    }
  });

  it('yields a transparent picture (not a crash) for a subtree without meshes', async () => {
    const { renderer, scene } = makeRendererAndScene();
    const empty = new Group();
    scene.add(empty);
    const tr = new ThumbnailRenderer(renderer, scene);
    try {
      const dataUrl = tr.renderLive(empty, 128)!;
      expect(dataUrl.startsWith('data:image/png')).toBe(true);
      const { pixelAt } = await decodeDataUrl(dataUrl);
      expect(pixelAt(64, 64).a).toBeLessThan(8);
    } finally {
      tr.dispose();
      renderer.dispose();
    }
  });

  it('returns null on a WebGPU renderer without touching GL state', () => {
    const fakeWebGPU = { isWebGPURenderer: true } as unknown as WebGLRenderer;
    const tr = new ThumbnailRenderer(fakeWebGPU, new Scene());
    expect(tr.renderLive(new Group(), 128)).toBeNull();
  });
});
