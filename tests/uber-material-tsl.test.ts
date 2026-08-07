// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * uber-material-tsl.test.ts — plan-271 test 9.3 (integration, browser,
 * forceWebGL via the F10 harness).
 *
 * Renders the TSL uber material (plan-271 Phase 2 port #1) on a REAL
 * `WebGPURenderer({forceWebGL:true})` and verifies with async pixel readback
 * (`readRenderTargetPixelsAsync` — no sync readback exists under
 * WebGPURenderer):
 *
 *  1. Two mesh instances sharing ONE uber material but carrying different
 *     `rmPacked` vertex attributes produce DIFFERENT pixels — i.e. the
 *     per-vertex roughness/metalness really drives the shading (the whole
 *     point of the rmPacked port).
 *  2. Clipping planes clip the TSL variant (plan-162 safeguard).
 *
 *     FINDING (plan-271 Phase 2 / plan-162): in three r185 the WebGPU
 *     renderer does NOT consume `material.clippingPlanes` at all — clipping
 *     works exclusively via `ClippingGroup` scene nodes (verified against
 *     the three.webgpu.js source: only `clippingGroup.clippingPlanes` feeds
 *     the ClippingContext). The clipping plugin must migrate to
 *     ClippingGroup before any WebGPU default cutover; this test asserts
 *     the SUPPORTED mechanism against the TSL uber material.
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  AmbientLight,
  BufferAttribute,
  Color,
  DirectionalLight,
  Mesh,
  OrthographicCamera,
  Plane,
  PlaneGeometry,
  Scene,
  Vector3,
  WebGLRenderTarget,
  type Camera,
} from 'three';
import { ClippingGroup } from 'three/webgpu';
import {
  createTestViewer,
  readRenderTargetPixelsAsync,
  type TestViewerHandle,
} from './helpers/create-test-viewer';
import {
  createMaterialContext,
  getTslMaterials,
  preloadTslMaterials,
} from '../src/core/engine/materials/material-factory';

const VIEWER_TEST_TIMEOUT = 60_000;
const RT_SIZE = 64;

let handle: TestViewerHandle | null = null;

afterEach(() => {
  handle?.dispose();
  handle = null;
});

/** Build a unit plane with white vertex colors and a constant rmPacked value. */
function makeRmPlane(roughness255: number, metalness255: number): PlaneGeometry {
  const geom = new PlaneGeometry(0.9, 0.9);
  const vCount = geom.attributes.position.count;
  const col = new Uint8Array(vCount * 3).fill(255); // white
  geom.setAttribute('color', new BufferAttribute(col, 3, true));
  const rm = new Uint8Array(vCount * 2);
  for (let i = 0; i < vCount; i++) {
    rm[i * 2] = roughness255;
    rm[i * 2 + 1] = metalness255;
  }
  geom.setAttribute('rmPacked', new BufferAttribute(rm, 2, true));
  return geom;
}

interface AsyncRenderer {
  setRenderTarget(t: unknown): void;
  render(scene: Scene, camera: Camera): void;
  localClippingEnabled?: boolean;
}

/** Render into a target. Both families accept plain render() after the
 *  init() that RVViewer.create() already awaited (renderAsync is deprecated). */
function renderTo(
  renderer: AsyncRenderer,
  rt: WebGLRenderTarget,
  scene: Scene,
  camera: Camera,
): void {
  renderer.setRenderTarget(rt);
  renderer.render(scene, camera);
  renderer.setRenderTarget(null);
}

function pixelAt(buf: Uint8Array, x: number, y: number): [number, number, number] {
  const o = (y * RT_SIZE + x) * 4;
  return [buf[o], buf[o + 1], buf[o + 2]];
}

describe('uber material TSL (plan-271 phase 2, test 9.3)', () => {
  it('different rmPacked on two instances of ONE material → different pixels; clippingPlanes clip', async () => {
    handle = await createTestViewer('webgpu-gl');
    const { viewer } = handle;
    expect(viewer.isWebGPU).toBe(true);

    // create() pre-warms the TSL modules for webgpu-gl; assert + be explicit.
    await preloadTslMaterials(createMaterialContext(viewer.rendererKind, viewer.hasCompute));
    const tsl = getTslMaterials();
    expect(tsl).not.toBeNull();

    const scene = new Scene();
    scene.background = new Color(0x000000);
    scene.add(new AmbientLight(0xffffff, 0.4));
    const sun = new DirectionalLight(0xffffff, 2.5);
    sun.position.set(0.3, 0.4, 1);
    scene.add(sun);

    // ONE shared material, TWO instances with different rmPacked:
    // A = rough non-metal (bright diffuse), B = smooth full metal (no
    // diffuse, env-less → much darker / different response).
    const uber = tsl!.createUberMaterialTsl();
    const renderer = viewer.renderer as unknown as AsyncRenderer;

    // Clipping via ClippingGroup — the ONLY mechanism the WebGPU renderer
    // supports (see module doc). Installed from the first compile on and
    // driven via plane.constant: +1e6 keeps everything visible.
    const clipPlane = new Plane(new Vector3(0, 1, 0), 1e6);
    const clipGroup = new ClippingGroup();
    clipGroup.clippingPlanes = [clipPlane];
    const meshA = new Mesh(makeRmPlane(255, 0), uber);
    meshA.position.set(-0.5, 0, 0);
    const meshB = new Mesh(makeRmPlane(10, 255), uber);
    meshB.position.set(0.5, 0, 0);
    // @types/three 0.185 does not declare ClippingGroup as an Object3D even
    // though it is one at runtime — cast for add()/scene.add().
    const clipRoot = clipGroup as unknown as import('three/webgpu').Object3D;
    clipRoot.add(meshA, meshB);
    scene.add(clipRoot);

    const camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
    camera.position.set(0, 0, 5);
    camera.lookAt(0, 0, 0);

    const rt = new WebGLRenderTarget(RT_SIZE, RT_SIZE);

    renderTo(renderer, rt, scene, camera);
    let px = await readRenderTargetPixelsAsync(viewer, rt);
    const a = pixelAt(px, 16, 32);
    const b = pixelAt(px, 48, 32);

    // Both planes rendered (not background) …
    expect(a[0] + a[1] + a[2], `plane A should be visible, got rgb(${a})`).toBeGreaterThan(30);
    // … and the rmPacked difference shows up as a clear shading difference.
    const delta = Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
    expect(delta, `rmPacked variants A rgb(${a}) vs B rgb(${b}) must differ`).toBeGreaterThan(20);

    // ── clipping on the TSL variant (plan-162 safeguard) ────────────────
    // Flip the plane so distanceToPoint < 0 everywhere → clips everything.
    clipPlane.constant = -1e6;

    renderTo(renderer, rt, scene, camera);
    px = await readRenderTargetPixelsAsync(viewer, rt);
    const aClipped = pixelAt(px, 16, 32);
    const bClipped = pixelAt(px, 48, 32);
    expect(aClipped[0] + aClipped[1] + aClipped[2], `plane A must be clipped, got rgb(${aClipped})`).toBeLessThan(10);
    expect(bClipped[0] + bClipped[1] + bClipped[2], `plane B must be clipped, got rgb(${bClipped})`).toBeLessThan(10);

    rt.dispose();
    uber.dispose();
  }, VIEWER_TEST_TIMEOUT);
});
