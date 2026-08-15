// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * ThumbnailRenderer — Generates preview images for library catalog entries
 * using an offscreen WebGL render target.
 *
 * Reuses the viewer's existing WebGLRenderer (no second GL context) and the
 * main scene's image-based environment (HDRI IBL), but renders with a **frozen
 * look** rather than the user's live visual settings (plan-712): the lighting of
 * the 'default' (Shaded) render mode — environment plus one directional key
 * light, no ambient fill — with GTAO ambient occlusion, no tone mapping and no
 * bloom. Two users with different render modes must get byte-comparable
 * previews for the same asset — a card picture is cached, shared and long-lived,
 * so it cannot depend on whatever the viewport happened to be set to when it
 * was generated.
 *
 * The image is rendered at 2x the requested edge length and downscaled in one
 * halving step (supersampling AA — the composer chain makes MSAA useless, see
 * three.js #23300), on a transparent background with a soft baked contact
 * shadow underneath, so the asset sits on the card instead of floating.
 */

import {
  WebGLRenderTarget,
  PerspectiveCamera,
  Scene,
  DirectionalLight,
  Box3,
  Vector3,
  SRGBColorSpace,
  UnsignedByteType,
  NoToneMapping,
} from 'three';
import type { Object3D, WebGLRenderer } from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { computeSubtreeAABB, disposeSubtree } from '../engine/rv-traverse-utils';
import { bakeContactShadow } from './thumbnail-contact-shadow';

const _box = new Box3();
const _center = new Vector3();
const _size = new Vector3();

/**
 * Frozen snapshot of the "Default" visual preset (`public/presets/Default.preset.json`)
 * as far as thumbnails are concerned. Deliberately NOT read from the (editable)
 * preset file at runtime — thumbnails must be deterministic and identical for
 * every user (Entscheidungs-Log plan-712). If the look is ever meant to change,
 * change these constants AND bump the cache bucket in `thumbnail-cache.ts`
 * together, otherwise old and new previews mix in one library.
 */
const THUMBNAIL_LOOK = {
  toneMapping: NoToneMapping,                    // modeSettings.default.toneMapping: "none"
  ao: { intensity: 1, radius: 0.1 },             // ssaoIntensity / ssaoRadius
  // NO ambient light on purpose. The preset's `ambientColor`/`ambientIntensity`
  // are mode-gated: 'default' declares `ambientLight: false`
  // (`rv-render-modes.ts`), so `applyLightingMode()` *removes* the AmbientLight
  // "so it does not stack on top of the environment" — those preset values only
  // ever reach the 'simple' and 'toon' modes. Adding them here made thumbnails
  // brighter than the shaded view they are supposed to match.
  dirLight: {
    color: 0xffffff,                             // dirLightColor
    intensity: 1.5,                              // dirLightIntensity
    /** Fixed studio key direction (light position, target at origin). The
     *  preset has no light placement — the viewer derives it from the model —
     *  so the thumbnail pins its own, slightly off the camera axis to keep some
     *  form-modelling gradient on the asset. */
    direction: [0.5, 1, 0.75] as const,
  },
  // environment: IBL texture + environmentIntensity are still mirrored from the
  // main scene (the HDRI is a scene asset, not a preset value).
} as const;

/** One-time warning flag for the WebGPURenderer skip (plan-271). */
let _warnedWebGPUSkip = false;

export class ThumbnailRenderer {
  private _renderer: WebGLRenderer;
  /** The live main scene — read each render for the environment texture. */
  private _mainScene: Scene;
  private _scene: Scene;
  private _camera: PerspectiveCamera;
  /** Fixed-value sun light (a light Object3D can only live in one scene, so the
   *  thumbnail scene owns its own instance). No ambient — see THUMBNAIL_LOOK. */
  private _dir: DirectionalLight;
  private _composer: EffectComposer | null = null;
  /** Edge length of the supersampled buffers the composer is currently sized to. */
  private _composerSize = 0;
  /** Private camera for {@link renderLive} — never the viewport camera. */
  private _liveCamera: PerspectiveCamera | null = null;
  /** Private render target for {@link renderLive} (no composer on that path). */
  private _liveRT: WebGLRenderTarget | null = null;
  /** Full-resolution scratch canvas for the y-flip (supersampled size). */
  private _ssCanvas: HTMLCanvasElement | null = null;
  /** Output canvas at the requested size (downscale destination). */
  private _canvas: HTMLCanvasElement | null = null;
  private _pixels: Uint8Array | null = null;

  constructor(renderer: WebGLRenderer, mainScene: Scene) {
    this._renderer = renderer;
    this._mainScene = mainScene;

    // Transparent backdrop — the asset floats on the card background.
    this._scene = new Scene();
    this._scene.background = null;

    this._dir = new DirectionalLight(THUMBNAIL_LOOK.dirLight.color, THUMBNAIL_LOOK.dirLight.intensity);
    this._scene.add(this._dir);

    this._camera = new PerspectiveCamera(35, 1, 0.01, 100);
  }

  /**
   * Apply the frozen thumbnail look: the main scene's image-based environment
   * is mirrored (so the asset reflects the same world), everything else is
   * pinned to {@link THUMBNAIL_LOOK} and never copied from the live scene.
   */
  private _applyLook(): void {
    // Shared IBL texture (PMREM output is a plain Texture — safe across scenes
    // on the same WebGL renderer) + matching intensity.
    this._scene.environment = this._mainScene.environment;
    this._scene.environmentIntensity = this._mainScene.environmentIntensity;

    const [dx, dy, dz] = THUMBNAIL_LOOK.dirLight.direction;
    this._dir.color.setHex(THUMBNAIL_LOOK.dirLight.color);
    this._dir.intensity = THUMBNAIL_LOOK.dirLight.intensity;
    // DirectionalLight.target sits at the origin, so the position *is* the
    // direction; the asset's own position is irrelevant (no shadow map).
    this._dir.position.set(dx, dy, dz);
  }

  /**
   * Build (once) and size the offscreen composer: RenderPass → GTAOPass →
   * OutputPass. No bloom — `UnrealBloomPass` clamps alpha to 1 and would fill
   * the transparent background (three.js #14104, "not planned").
   *
   * Three handles here have no precedent anywhere else in this repo and are all
   * load-bearing:
   *  - the render target is explicitly `UnsignedByteType`: the EffectComposer
   *    default is `HalfFloatType`, which `readRenderTargetPixels` would read
   *    into a `Uint8Array` as silently garbled pixels;
   *  - `renderToScreen = false`: the default is `true`, which makes the last
   *    pass draw onto the shared, visible canvas (flash in the live view) and
   *    never delivers the final image into a buffer we can read;
   *  - `setPixelRatio(1)`: the constructor adopts `renderer.getPixelRatio()`
   *    and multiplies it into every pass/RT size, so on a DPR>1 display the AO
   *    buffers would be DPR² oversized and a size change would grow the
   *    ping-pong targets past the region we read back.
   */
  private _ensureComposer(ssSize: number): void {
    if (!this._composer) {
      const rt = new WebGLRenderTarget(ssSize, ssSize, { type: UnsignedByteType });
      rt.texture.colorSpace = SRGBColorSpace;

      const composer = new EffectComposer(this._renderer, rt);
      composer.renderToScreen = false;
      composer.setPixelRatio(1);

      composer.addPass(new RenderPass(this._scene, this._camera));

      const gtao = new GTAOPass(this._scene, this._camera, ssSize, ssSize);
      gtao.output = GTAOPass.OUTPUT.Default;
      gtao.blendIntensity = THUMBNAIL_LOOK.ao.intensity;
      gtao.updateGtaoMaterial({ radius: THUMBNAIL_LOOK.ao.radius });
      composer.addPass(gtao);

      composer.addPass(new OutputPass());

      composer.setSize(ssSize, ssSize);
      this._composer = composer;
      this._composerSize = ssSize;
      return;
    }

    if (this._composerSize !== ssSize) {
      // pixelRatio stays 1 — setSize() is the only size authority.
      this._composer.setSize(ssSize, ssSize);
      this._composerSize = ssSize;
    }
  }

  /**
   * Render a model to a PNG data URL (transparent background, 512px default).
   * The model is cloned internally — the original is not modified.
   *
   * Returns `null` when the viewer runs on a WebGPURenderer (either backend,
   * i.e. `viewer.isWebGPU` — plan-271 semantics): this class is hard-wired to
   * the classic WebGLRenderer (WebGLRenderTarget + synchronous
   * readRenderTargetPixels, which does not exist under WebGPURenderer).
   * Callers must treat `null` as "no thumbnail" — never as an error.
   */
  render(model: Object3D, size = 512): string | null {
    if ((this._renderer as unknown as { isWebGPURenderer?: boolean }).isWebGPURenderer) {
      if (!_warnedWebGPUSkip) {
        _warnedWebGPUSkip = true;
        console.warn('[ThumbnailRenderer] Skipping thumbnail generation — requires the classic WebGLRenderer (viewer is running a WebGPURenderer).');
      }
      return null;
    }

    // Render at 2x and downscale — supersampling AA for the whole pipeline
    // (geometry edges AND the AO/denoise noise), not just for silhouettes.
    const ss = size * 2;
    this._ensureComposer(ss);
    this._ensureReadbackSurfaces(ss, size);

    this._applyLook();

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

    // Contact shadow AFTER the camera fit: the plane is a sibling of the clone,
    // so `Box3.setFromObject(clone)` above never saw it and the framing stays
    // about the asset (Box3 has no exclude option — ordering is the guard).
    const shadow = _box.isEmpty() ? null : bakeContactShadow(this._renderer, clone, _box);
    if (shadow) this._scene.add(shadow.plane);

    // `toneMapping` / `outputColorSpace` are renderer-global and read live by
    // OutputPass, so a thumbnail render would otherwise both inherit the user's
    // live grading and leave its own behind on the main scene.
    const prevTarget = this._renderer.getRenderTarget();
    const prevClearAlpha = this._renderer.getClearAlpha();
    // Types come from three's own d.ts (`outputColorSpace` is typed `string`
    // there) — inferred, so a three upgrade cannot break this line.
    const prevToneMapping = this._renderer.toneMapping;
    const prevColorSpace = this._renderer.outputColorSpace;
    try {
      this._renderer.toneMapping = THUMBNAIL_LOOK.toneMapping;
      this._renderer.setClearAlpha(0);
      // RenderPass clears with the renderer's clear colour/alpha — alpha 0 is
      // what keeps the background transparent through the whole chain.
      this._composer!.render();
    } finally {
      this._renderer.toneMapping = prevToneMapping;
      this._renderer.outputColorSpace = prevColorSpace;
      this._renderer.setClearAlpha(prevClearAlpha);
      this._renderer.setRenderTarget(prevTarget);
    }

    // Read back from the composer's READ buffer: after the last swap that is
    // the buffer holding the OutputPass result. The render target handed to the
    // constructor is only one half of the ping-pong pair and is not guaranteed
    // to be the one carrying the final image.
    const finalTarget = this._composer!.readBuffer;
    this._renderer.readRenderTargetPixels(finalTarget, 0, 0, ss, ss, this._pixels!);

    const dataUrl = this._encodeReadback(ss, size);

    // Clean up clone + shadow from scene
    if (shadow) {
      this._scene.remove(shadow.plane);
      shadow.dispose();
    }
    this._scene.remove(clone);
    disposeSubtree(clone);

    return dataUrl;
  }

  /**
   * Render the LIVE scene — the open model as it currently stands — to a PNG
   * data URL. Nothing is cloned and nothing is disposed.
   *
   * This exists because {@link render} is O(model) on the live model root:
   * `model.clone()` duplicates every BatchedMesh arena (three's
   * `BatchedMesh.copy()` clones the full merged geometry + matrices textures),
   * and `disposeSubtree(clone)` then destroys geometries/materials the clone
   * SHARES with the live scene (`Mesh.clone()` shares both), forcing a full
   * re-upload + shader recompile on the next viewport frame. On a large model
   * that froze the projects dashboard for ~20 s per open/switch. Here the live
   * scene is rendered in place with a private camera into a private render
   * target (the `web_render` "beauty" pattern) — the live model's resources
   * are never touched.
   *
   * Look trade-off, accepted: the picture is the live look (current lighting,
   * no frozen studio grade, no GTAO, no contact shadow) on a transparent
   * background — a snapshot of "what is open right now", not a cached library
   * thumbnail. The private camera keeps the default layer mask (layer 0), so
   * overlay layers (isolate/highlight/measurement) and NO_AO in-scene UI stay
   * out of the shot.
   *
   * Returns `null` under a WebGPURenderer (same contract as {@link render}).
   * A subtree without mesh content yields a transparent picture, not `null` —
   * the same as {@link render}, and the card treats both as "no preview".
   */
  renderLive(root: Object3D, size = 512): string | null {
    if ((this._renderer as unknown as { isWebGPURenderer?: boolean }).isWebGPURenderer) {
      if (!_warnedWebGPUSkip) {
        _warnedWebGPUSkip = true;
        console.warn('[ThumbnailRenderer] Skipping thumbnail generation — requires the classic WebGLRenderer (viewer is running a WebGPURenderer).');
      }
      return null;
    }

    const ss = size * 2;
    // Canvases/pixel buffer are shared with render() — both paths are
    // synchronous on the one renderer, so they can never interleave.
    this._ensureReadbackSurfaces(ss, size);

    // Never empty: the util falls back to a minimal box at the node position,
    // and clamps each size component to ≥ 0.001 — the framing below holds.
    const bounds = computeSubtreeAABB(root, _box);
    const maxDim = Math.max(bounds.size.x, bounds.size.y, bounds.size.z);

    // Same ¾ overhead framing as render(), but near/far derived from the model
    // radius — the live root can be a whole plant, not a library asset.
    const radius = bounds.size.length() * 0.5;
    if (!this._liveCamera) this._liveCamera = new PerspectiveCamera(35, 1, 0.01, 100);
    const camera = this._liveCamera;
    camera.near = Math.max(radius / 500, 0.01);
    camera.far = Math.max(radius * 40, 10);
    const distance = maxDim * 2.0;
    camera.position.set(
      bounds.center.x + distance * 0.6,
      bounds.center.y + distance * 0.7,
      bounds.center.z + distance * 0.6,
    );
    camera.lookAt(bounds.center);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);

    if (!this._liveRT) {
      this._liveRT = new WebGLRenderTarget(ss, ss, { type: UnsignedByteType, colorSpace: SRGBColorSpace });
    } else if (this._liveRT.width !== ss) {
      this._liveRT.setSize(ss, ss);
    }

    // Save/restore exactly what the render touches. Tone mapping is NOT
    // swapped: rendering into a target skips tone mapping anyway (three applies
    // it only on the default framebuffer / via OutputPass), and the sRGB
    // conversion follows the target texture's colorSpace.
    const prevTarget = this._renderer.getRenderTarget();
    const prevClearAlpha = this._renderer.getClearAlpha();
    const prevBackground = this._mainScene.background;
    try {
      // Background null + clearAlpha 0 = transparent card background; the
      // live environment lighting still applies (scene.environment untouched).
      this._mainScene.background = null;
      this._renderer.setClearAlpha(0);
      this._renderer.setRenderTarget(this._liveRT);
      this._renderer.render(this._mainScene, camera);
      this._renderer.readRenderTargetPixels(this._liveRT, 0, 0, ss, ss, this._pixels!);
    } finally {
      this._mainScene.background = prevBackground;
      this._renderer.setClearAlpha(prevClearAlpha);
      this._renderer.setRenderTarget(prevTarget);
    }

    return this._encodeReadback(ss, size);
  }

  /** Size the shared scratch canvases + pixel buffer for one readback. */
  private _ensureReadbackSurfaces(ss: number, size: number): void {
    if (!this._ssCanvas) this._ssCanvas = document.createElement('canvas');
    if (this._ssCanvas.width !== ss) {
      this._ssCanvas.width = ss;
      this._ssCanvas.height = ss;
    }
    if (!this._canvas) this._canvas = document.createElement('canvas');
    this._canvas.width = size;
    this._canvas.height = size;
    if (!this._pixels || this._pixels.length !== ss * ss * 4) {
      this._pixels = new Uint8Array(ss * ss * 4);
    }
  }

  /** Y-flip `_pixels` into the scratch canvas, downscale 2×, return a PNG. */
  private _encodeReadback(ss: number, size: number): string {
    const pixels = this._pixels!;
    const ssCtx = this._ssCanvas!.getContext('2d')!;
    const imageData = ssCtx.createImageData(ss, ss);
    // WebGL pixels are bottom-to-top, flip vertically
    for (let y = 0; y < ss; y++) {
      const srcRow = (ss - 1 - y) * ss * 4;
      const dstRow = y * ss * 4;
      for (let x = 0; x < ss * 4; x++) {
        imageData.data[dstRow + x] = pixels[srcRow + x];
      }
    }
    ssCtx.putImageData(imageData, 0, 0);

    // Downscale 2x in a single halving step (one halving needs no mip chain).
    const ctx = this._canvas!.getContext('2d')!;
    ctx.clearRect(0, 0, size, size);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(this._ssCanvas!, 0, 0, ss, ss, 0, 0, size, size);

    return this._canvas!.toDataURL('image/png');
  }

  dispose(): void {
    // EffectComposer has no dispose() that frees its passes, so take both the
    // ping-pong targets and every pass down by hand.
    if (this._composer) {
      for (const pass of this._composer.passes) {
        (pass as unknown as { dispose?: () => void }).dispose?.();
      }
      this._composer.passes.length = 0;
      this._composer.renderTarget1.dispose();
      this._composer.renderTarget2.dispose();
      this._composer = null;
    }
    this._composerSize = 0;
    this._liveRT?.dispose();
    this._liveRT = null;
    this._liveCamera = null;
    // Detach the shared environment reference (we never owned it).
    this._scene.environment = null;
    this._ssCanvas = null;
    this._canvas = null;
    this._pixels = null;
  }
}
