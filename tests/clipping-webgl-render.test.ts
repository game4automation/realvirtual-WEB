// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Browser integration guard for the production classic-WebGL clipping path.
 * The Toon render mode replaces model materials; clipping must survive that
 * replacement and discard fragments instead of merely showing the translucent
 * plane visualization over an otherwise uncut model.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  AmbientLight,
  Box3,
  Color,
  Group,
  Mesh,
  MeshStandardMaterial,
  OrthographicCamera,
  PlaneGeometry,
  Scene,
  Vector3,
  WebGLRenderTarget,
  type Camera,
  type Material,
  type Plane,
} from 'three';
import { ClippingPlugin } from '../src/plugins/rv-clipping-plugin';
import type { LoadResult } from '../src/core/engine/rv-scene-loader';
import {
  createTestViewer,
  readRenderTargetPixelsAsync,
  type TestViewerHandle,
} from './helpers/create-test-viewer';

const RT_SIZE = 32;
let handle: TestViewerHandle | null = null;

afterEach(() => {
  handle?.dispose();
  handle = null;
});

function centerRgb(pixels: Uint8Array): [number, number, number] {
  const offset = ((RT_SIZE / 2) * RT_SIZE + RT_SIZE / 2) * 4;
  return [pixels[offset], pixels[offset + 1], pixels[offset + 2]];
}

function renderToTarget(
  renderer: { setRenderTarget(target: WebGLRenderTarget | null): void; render(scene: Scene, camera: Camera): void },
  target: WebGLRenderTarget,
  scene: Scene,
  camera: Camera,
): void {
  renderer.setRenderTarget(target);
  renderer.render(scene, camera);
  renderer.setRenderTarget(null);
}

describe('ClippingPlugin classic WebGL rendering', () => {
  it('rebinds clipping when a model loads while Toon mode is already active', async () => {
    handle = await createTestViewer('webgl');
    const { viewer } = handle;
    viewer.renderMode = 'toon';

    const original = new MeshStandardMaterial({ color: 0xffffff });
    const mesh = new Mesh(new PlaneGeometry(1, 1), original);
    const root = new Group();
    root.add(mesh);
    const result = {
      root,
      boundingBox: new Box3(new Vector3(-0.5, -0.5, -0.1), new Vector3(0.5, 0.5, 0.1)),
      drives: [],
    } as unknown as LoadResult;

    const clipping = new ClippingPlugin();
    clipping.onModelLoaded(result, viewer);
    (viewer as unknown as { currentModel: Group }).currentModel = root;
    viewer.emit('model-loaded', { result });

    const toon = mesh.material as Material;
    expect(toon).not.toBe(original);
    expect(toon.clippingPlanes).toBe((clipping as unknown as { planes: unknown }).planes);

    clipping.onModelCleared();
    mesh.geometry.dispose();
    original.dispose();
  });

  it('keeps clipping after the Toon material swap and fully discards cut pixels', async () => {
    handle = await createTestViewer('webgl');
    const { viewer } = handle;
    expect(viewer.rendererKind).toBe('webgl');

    const scene = new Scene();
    scene.background = new Color(0x000000);
    scene.add(new AmbientLight(0xffffff, 3));

    const original = new MeshStandardMaterial({ color: 0xffffff });
    const mesh = new Mesh(new PlaneGeometry(1, 1), original);
    const root = new Group();
    root.add(mesh);
    scene.add(root);

    const result = {
      root,
      boundingBox: new Box3(new Vector3(-0.5, -0.5, -0.1), new Vector3(0.5, 0.5, 0.1)),
      drives: [],
    } as unknown as LoadResult;

    const clipping = new ClippingPlugin();
    clipping.onModelLoaded(result, viewer);
    clipping.resetAll();

    // Simulate the production render-mode transition. It swaps the material
    // before emitting render-mode-changed; the clipping plugin must bind the
    // newly-created Toon material in that event.
    (viewer as unknown as { currentModel: Group }).currentModel = root;
    viewer.renderMode = 'toon';

    const toon = mesh.material as Material;
    expect(toon).not.toBe(original);
    expect(toon.clippingPlanes).toBe((clipping as unknown as { planes: unknown }).planes);

    const camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
    camera.position.set(0, 0, 5);
    camera.lookAt(0, 0, 0);
    const target = new WebGLRenderTarget(RT_SIZE, RT_SIZE);
    const renderer = viewer.renderer as unknown as {
      setRenderTarget(target: WebGLRenderTarget | null): void;
      render(scene: Scene, camera: Camera): void;
    };

    renderToTarget(renderer, target, scene, camera);
    let pixels = await readRenderTargetPixelsAsync(viewer, target);
    const visible = centerRgb(pixels);
    expect(visible[0] + visible[1] + visible[2]).toBeGreaterThan(30);

    clipping.setAxis('y', { enabled: true, position: 1 });
    renderToTarget(renderer, target, scene, camera);
    pixels = await readRenderTargetPixelsAsync(viewer, target);
    const clipped = centerRgb(pixels);
    expect(clipped[0] + clipped[1] + clipped[2], `cut pixel must be hidden, got rgb(${clipped})`).toBeLessThan(10);

    clipping.onModelCleared();
    target.dispose();
    mesh.geometry.dispose();
    original.dispose();
  }, 30_000);

  it('keeps GTAO, Toon and selection-outline buffers from ghosting clipped geometry', async () => {
    handle = await createTestViewer('webgl', { width: 64, height: 64 });
    const { viewer } = handle;
    viewer.scene.background = new Color(0x000000);
    viewer.aoMode = 'off';
    viewer.bloomEnabled = false;

    const material = new MeshStandardMaterial({ color: 0xffffff });
    const mesh = new Mesh(new PlaneGeometry(1, 1), material);
    const root = new Group();
    root.add(mesh);
    viewer.scene.add(root);

    const result = {
      root,
      boundingBox: new Box3(new Vector3(-0.5, -0.5, -0.1), new Vector3(0.5, 0.5, 0.1)),
      drives: [],
    } as unknown as LoadResult;
    const clipping = new ClippingPlugin();
    clipping.onModelLoaded(result, viewer);
    const planes = (clipping as unknown as { planes: Plane[] }).planes;

    // Force all three classic-WebGL helper paths to exist after clipping was
    // registered. Each path lazily creates an override material of its own.
    viewer.outlineManager.setOutlined([root]);
    viewer.renderMode = 'toon';

    const outline = viewer.outlineManager.pass!;
    const pp = (viewer as unknown as {
      _postProcessing: { gtaoPass: { normalMaterial: Material } | null };
    })._postProcessing;
    const toon = (viewer as unknown as {
      _toon: { _gbufferMat: Material | null };
    })._toon;

    expect(outline.depthMaterial.clippingPlanes).toBe(planes);
    expect(outline.prepareMaskMaterial.clippingPlanes).toBe(planes);
    expect(pp.gtaoPass?.normalMaterial.clippingPlanes).toBe(planes);
    expect(toon._gbufferMat?.clippingPlanes).toBe(planes);

    // Clip the whole model and render through the actual EffectComposer,
    // including OutlinePass. A stale mask used to leave bright edge pixels
    // even though the beauty pass was already black.
    clipping.setAxis('y', { enabled: true, position: 1 });
    const camera = viewer.camera;
    camera.position.set(0, 0, 5);
    camera.lookAt(0, 0, 0);
    camera.layers.set(0); // production composer excludes overlay plane viz too
    camera.updateMatrixWorld(true);

    const composer = viewer._composer!;
    composer.renderToScreen = false;
    composer.render();
    const pixels = await readRenderTargetPixelsAsync(viewer, composer.readBuffer);
    let maxRgb = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      maxRgb = Math.max(maxRgb, pixels[i], pixels[i + 1], pixels[i + 2]);
    }
    expect(maxRgb, 'clipped model must leave no post-processing ghost pixels').toBeLessThan(10);

    clipping.onModelCleared();
    viewer.outlineManager.clearAll();
    viewer.scene.remove(root);
    mesh.geometry.dispose();
    material.dispose();
  }, 30_000);
});
