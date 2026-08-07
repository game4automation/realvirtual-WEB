// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * ThumbnailRenderer — Generates preview images for library catalog entries
 * using an offscreen WebGL render target.
 *
 * Reuses the viewer's existing WebGLRenderer (no second GL context) AND the
 * main scene's lighting so previews look exactly like the asset does in the 3D
 * scene: the same image-based environment (HDRI IBL) + ambient/directional
 * lights, the same tone mapping / exposure (renderer-global, already live on the
 * shared renderer). The background is transparent so the asset sits cleanly on
 * the library card.
 */

import {
  WebGLRenderTarget,
  PerspectiveCamera,
  Scene,
  AmbientLight,
  DirectionalLight,
  Box3,
  Vector3,
  SRGBColorSpace,
} from 'three';
import type { Object3D, WebGLRenderer } from 'three';
import { disposeSubtree } from '../engine/rv-traverse-utils';

const _box = new Box3();
const _center = new Vector3();
const _size = new Vector3();

/** One-time warning flag for the WebGPURenderer skip (plan-271). */
let _warnedWebGPUSkip = false;

export class ThumbnailRenderer {
  private _renderer: WebGLRenderer;
  /** The live main scene — read each render for environment + light state. */
  private _mainScene: Scene;
  private _scene: Scene;
  private _camera: PerspectiveCamera;
  /** Mirrors of the main scene's ambient / sun lights (a light Object3D can
   *  only live in one scene, so we copy state onto our own instances). */
  private _ambient: AmbientLight;
  private _dir: DirectionalLight;
  private _renderTarget: WebGLRenderTarget | null = null;
  private _canvas: HTMLCanvasElement | null = null;

  constructor(renderer: WebGLRenderer, mainScene: Scene) {
    this._renderer = renderer;
    this._mainScene = mainScene;

    // Transparent backdrop — the asset floats on the card background.
    this._scene = new Scene();
    this._scene.background = null;

    // Light mirrors — their color/intensity/position are synced from the main
    // scene on every render (intensity 0 when the source light is inactive).
    this._ambient = new AmbientLight(0xffffff, 0);
    this._scene.add(this._ambient);
    this._dir = new DirectionalLight(0xffffff, 0);
    this._scene.add(this._dir);

    this._camera = new PerspectiveCamera(35, 1, 0.01, 100);
  }

  /**
   * Copy the main scene's image-based environment + ambient/directional light
   * state onto the thumbnail scene so the preview matches the 3D view.
   */
  private _syncLighting(): void {
    // Shared IBL texture (PMREM output is a plain Texture — safe across scenes
    // on the same WebGL renderer) + matching intensity.
    this._scene.environment = this._mainScene.environment;
    this._scene.environmentIntensity = this._mainScene.environmentIntensity;

    // Find the active ambient / directional lights in the main scene graph.
    let srcAmbient: AmbientLight | null = null;
    let srcDir: DirectionalLight | null = null;
    this._mainScene.traverse((o) => {
      if (!srcAmbient && (o as AmbientLight).isAmbientLight) srcAmbient = o as AmbientLight;
      if (!srcDir && (o as DirectionalLight).isDirectionalLight) srcDir = o as DirectionalLight;
    });

    if (srcAmbient) {
      this._ambient.color.copy((srcAmbient as AmbientLight).color);
      this._ambient.intensity = (srcAmbient as AmbientLight).intensity;
    } else {
      this._ambient.intensity = 0; // 'default' mode: env-only, no ambient
    }

    if (srcDir) {
      this._dir.color.copy((srcDir as DirectionalLight).color);
      this._dir.intensity = (srcDir as DirectionalLight).intensity;
      this._dir.position.copy((srcDir as DirectionalLight).position);
    } else {
      this._dir.intensity = 0;
    }
  }

  /**
   * Render a model to a PNG data URL (transparent background).
   * The model is cloned internally — the original is not modified.
   *
   * Returns `null` when the viewer runs on a WebGPURenderer (either backend,
   * i.e. `viewer.isWebGPU` — plan-271 semantics): this class is hard-wired to
   * the classic WebGLRenderer (WebGLRenderTarget + synchronous
   * readRenderTargetPixels, which does not exist under WebGPURenderer).
   * Callers must treat `null` as "no thumbnail" — never as an error.
   */
  render(model: Object3D, size = 256): string | null {
    if ((this._renderer as unknown as { isWebGPURenderer?: boolean }).isWebGPURenderer) {
      if (!_warnedWebGPUSkip) {
        _warnedWebGPUSkip = true;
        console.warn('[ThumbnailRenderer] Skipping thumbnail generation — requires the classic WebGLRenderer (viewer is running a WebGPURenderer).');
      }
      return null;
    }
    // Ensure an sRGB render target exists at the right size. sRGB colorSpace
    // makes the renderer apply tone mapping + sRGB encoding on write, so the
    // PNG matches what the on-screen canvas shows.
    if (!this._renderTarget || this._renderTarget.width !== size) {
      this._renderTarget?.dispose();
      this._renderTarget = new WebGLRenderTarget(size, size);
      this._renderTarget.texture.colorSpace = SRGBColorSpace;
    }
    if (!this._canvas) {
      this._canvas = document.createElement('canvas');
    }
    this._canvas.width = size;
    this._canvas.height = size;

    this._syncLighting();

    // Add clone to thumbnail scene
    const clone = model.clone();
    this._scene.add(clone);

    // Compute bounds and fit camera
    _box.setFromObject(clone);
    if (!_box.isEmpty()) {
      _box.getCenter(_center);
      _box.getSize(_size);

      const maxDim = Math.max(_size.x, _size.y, _size.z);
      const distance = maxDim * 2.0;

      // 3/4 overhead angle
      this._camera.position.set(
        _center.x + distance * 0.6,
        _center.y + distance * 0.7,
        _center.z + distance * 0.6,
      );
      this._camera.lookAt(_center);
      this._camera.updateProjectionMatrix();
    }

    // Render to offscreen target with a transparent clear.
    const prevTarget = this._renderer.getRenderTarget();
    const prevClearAlpha = this._renderer.getClearAlpha();
    this._renderer.setRenderTarget(this._renderTarget);
    this._renderer.setClearAlpha(0);
    this._renderer.clear();
    this._renderer.render(this._scene, this._camera);
    this._renderer.setClearAlpha(prevClearAlpha);
    this._renderer.setRenderTarget(prevTarget);

    // Read pixels to canvas
    const ctx = this._canvas.getContext('2d')!;
    const pixels = new Uint8Array(size * size * 4);
    this._renderer.readRenderTargetPixels(this._renderTarget, 0, 0, size, size, pixels);

    const imageData = ctx.createImageData(size, size);
    // WebGL pixels are bottom-to-top, flip vertically
    for (let y = 0; y < size; y++) {
      const srcRow = (size - 1 - y) * size * 4;
      const dstRow = y * size * 4;
      for (let x = 0; x < size * 4; x++) {
        imageData.data[dstRow + x] = pixels[srcRow + x];
      }
    }
    ctx.putImageData(imageData, 0, 0);

    // Clean up clone from scene
    this._scene.remove(clone);
    disposeSubtree(clone);

    return this._canvas.toDataURL('image/png');
  }

  dispose(): void {
    this._renderTarget?.dispose();
    this._renderTarget = null;
    // Detach the shared environment reference (we never owned it).
    this._scene.environment = null;
    this._canvas = null;
  }
}
