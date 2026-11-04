// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * ThumbnailRenderer — renders the preview image a SAVE writes beside a
 * document (plan-776). Nothing renders a thumbnail on view any more: the
 * dashboard and the library read the sidecar the save wrote, so this class is
 * reached only from the save path (`rv-thumbnail-write.ts`, loaded on demand).
 *
 * Reuses the viewer's existing renderer (no second GL context) and the main
 * scene's image-based environment (HDRI IBL), but renders with a **frozen
 * look** rather than the user's live visual settings (plan-712): the lighting of
 * the 'default' (Shaded) render mode — environment plus one directional key
 * light, no ambient fill — with GTAO ambient occlusion, no tone mapping and no
 * bloom. Two users with different render modes get comparable previews for
 * the same document. That includes the 'raytraced' mode (plan-762 F17): it is
 * treated exactly like 'default' — no trace, no history, the frozen Shaded look.
 *
 * ONE source, ONE look, for every document (plan-716: asset = document =
 * model): the capture clone of the document's content roots
 * (`thumbnail-content.ts` — authored content AND materialised placements, each
 * at its world transform) in a private studio scene, with GTAO and a baked
 * contact shadow underneath, a transparent background and the FIXED 3/4 camera
 * (front-right, slightly above) fitted to the bounding sphere of the complete
 * capture. Rendered at 2× and downscaled once (supersampling AA — the composer
 * chain makes MSAA useless, three.js #23300). The clone shares geometry and
 * materials with the live scene; the first save of a document compiles the
 * studio light variant of its materials once (three caches it per material),
 * the live view switches back to its cached programs without a recompile.
 */

import {
  WebGLRenderTarget,
  PerspectiveCamera,
  Scene,
  DirectionalLight,
  Box3,
  Sphere,
  Vector3,
  SRGBColorSpace,
  UnsignedByteType,
  NoToneMapping,
  MathUtils,
} from 'three';
import type { Object3D, WebGLRenderer } from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { OffscreenCapture } from '../engine/rv-offscreen-capture';
import { bakeContactShadow } from './thumbnail-contact-shadow';
import { captureDocument } from './thumbnail-content';

/** What {@link ThumbnailRenderer.render} draws: one content root or several. */
export type ThumbnailContent = Object3D | readonly Object3D[];

function rootsOf(content: ThumbnailContent): readonly Object3D[] {
  return Array.isArray(content) ? content : [content as Object3D];
}

const _sphere = new Sphere();
const _dir = new Vector3();

/** The fixed thumbnail view direction (camera offset from the target): front-right, slightly above. */
export const THUMBNAIL_VIEW_DIRECTION: readonly [number, number, number] = [1, 0.75, 1];
/** Breathing room around the bounding sphere (1 = the sphere touches the frame). */
const FRAME_MARGIN = 1.15;
/** Vertical field of view of the thumbnail camera, degrees. */
const CAMERA_FOV = 35;

/**
 * Frozen snapshot of the "Default" visual preset (`public/presets/Default.preset.json`)
 * as far as thumbnails are concerned. Deliberately NOT read from the (editable)
 * preset file at runtime — thumbnails must be deterministic and identical for
 * every user (Entscheidungs-Log plan-712). A changed look only reaches a
 * document's picture with its next save (plan-776: there is no cache to bump).
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

/**
 * Point `camera` at the bounding sphere of `box` from the fixed 3/4 direction,
 * far enough that the whole sphere fits the (square) frame. View-independent:
 * `r / sin(fov/2) × margin` frames the same object the same way whatever its
 * orientation.
 */
function fitCamera(camera: PerspectiveCamera, box: Box3): void {
  box.getBoundingSphere(_sphere);
  const radius = Math.max(_sphere.radius, 1e-4);
  const halfFov = MathUtils.degToRad(CAMERA_FOV) / 2;
  const distance = (radius / Math.sin(halfFov)) * FRAME_MARGIN;
  _dir.set(...THUMBNAIL_VIEW_DIRECTION).normalize();
  camera.fov = CAMERA_FOV;
  camera.aspect = 1;
  camera.near = Math.max(distance - radius * 2, radius / 500, 1e-4);
  camera.far = distance + radius * 2;
  camera.position.copy(_sphere.center).addScaledVector(_dir, distance);
  camera.lookAt(_sphere.center);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
}

/** True when `box` is a finite, non-empty volume — the framing is meaningful. */
export function isRenderableBounds(box: Box3): boolean {
  if (box.isEmpty()) return false;
  const values = [box.min.x, box.min.y, box.min.z, box.max.x, box.max.y, box.max.z];
  return values.every(Number.isFinite);
}

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
  /** Private render target for the WebGPU path (no composer there). */
  private _capture: OffscreenCapture | null = null;
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

    this._camera = new PerspectiveCamera(CAMERA_FOV, 1, 0.01, 100);
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
    this._aimKeyLight(new Vector3(0, 0, 0));
  }

  /** Key light from the fixed studio direction, aimed at `target`. */
  private _aimKeyLight(target: Vector3): void {
    const [dx, dy, dz] = THUMBNAIL_LOOK.dirLight.direction;
    this._dir.color.setHex(THUMBNAIL_LOOK.dirLight.color);
    this._dir.intensity = THUMBNAIL_LOOK.dirLight.intensity;
    this._dir.target.position.copy(target);
    this._dir.position.set(target.x + dx, target.y + dy, target.z + dz);
    this._dir.updateMatrixWorld(true);
    this._dir.target.updateMatrixWorld(true);
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
   * Render a DOCUMENT to a `size`×`size` canvas (transparent background, 512 px
   * default, rendered at 2×). `content` is the document's content root(s); the
   * capture clone (`captureDocument`) is drawn — the live scene is not touched.
   *
   * The composer render runs synchronously, before the first `await`, so the
   * renderer's global state is restored by the time this call returns its
   * promise. Under a WebGPURenderer the composer chain (GTAO) and the baked
   * contact shadow are WebGL-only, so the image is the plain lit model there —
   * the documented reduced look. `null` = nothing renderable (empty bounds) —
   * callers treat it as "no thumbnail", never as an error.
   *
   * The returned canvas is owned by this renderer: encode it before
   * {@link dispose} or the next render.
   */
  async render(content: ThumbnailContent, size = 512): Promise<HTMLCanvasElement | null> {
    if ((this._renderer as unknown as { isWebGPURenderer?: boolean }).isWebGPURenderer) {
      return this._renderPlainClone(content, size);
    }

    // Render at 2x and downscale — supersampling AA for the whole pipeline
    // (geometry edges AND the AO/denoise noise), not just for silhouettes.
    const ss = size * 2;
    this._ensureComposer(ss);
    this._ensureReadbackSurfaces(ss, size);

    this._applyLook();

    // The bounds come from the FINISHED capture — every placement included.
    const capture = captureDocument(rootsOf(content));
    if (!isRenderableBounds(capture.bounds)) {
      capture.dispose();
      return null;
    }
    this._scene.add(capture.root);
    fitCamera(this._camera, capture.bounds);

    // The contact shadow is a sibling of the capture, built after the bounds,
    // so the framing stays about the document.
    const shadow = bakeContactShadow(this._renderer, capture.root, capture.bounds);
    if (shadow) this._scene.add(shadow.plane);

    // `toneMapping` / `outputColorSpace` are renderer-global and read live by
    // OutputPass, so a thumbnail render would otherwise both inherit the user's
    // live grading and leave its own behind on the main scene.
    const prevTarget = this._renderer.getRenderTarget();
    const prevClearAlpha = this._renderer.getClearAlpha();
    const prevToneMapping = this._renderer.toneMapping;
    const prevColorSpace = this._renderer.outputColorSpace;
    try {
      this._renderer.toneMapping = THUMBNAIL_LOOK.toneMapping;
      this._renderer.setClearAlpha(0);
      // RenderPass clears with the renderer's clear colour/alpha — alpha 0 is
      // what keeps the background transparent through the whole chain.
      this._composer!.render();
      // Read back from the composer's READ buffer: after the last swap that is
      // the buffer holding the OutputPass result.
      this._renderer.readRenderTargetPixels(this._composer!.readBuffer, 0, 0, ss, ss, this._pixels!);
    } finally {
      this._renderer.toneMapping = prevToneMapping;
      this._renderer.outputColorSpace = prevColorSpace;
      this._renderer.setClearAlpha(prevClearAlpha);
      this._renderer.setRenderTarget(prevTarget);
      if (shadow) {
        this._scene.remove(shadow.plane);
        shadow.dispose();
      }
      capture.dispose();
    }

    return this._downscale(this._pixels!, ss, size, true);
  }

  /**
   * WebGPURenderer path of {@link render}: the same capture in the private
   * studio scene, lit by the studio lights, plain forward render into the
   * private offscreen target, async readback. No GTAO, no contact shadow (both
   * are WebGL post/shader chains).
   */
  private async _renderPlainClone(content: ThumbnailContent, size: number): Promise<HTMLCanvasElement | null> {
    const ss = size * 2;
    this._ensureReadbackSurfaces(ss, size);
    this._applyLook();
    const capture = captureDocument(rootsOf(content));
    try {
      if (!isRenderableBounds(capture.bounds)) return null;
      this._scene.add(capture.root);
      fitCamera(this._camera, capture.bounds);
      this._capture ??= new OffscreenCapture(() => this._renderer);
      const read = this._capture.withPass(
        {
          width: ss, height: ss, supersample: 1,
          clearAlpha: 0, background: null, colorSpace: SRGBColorSpace,
          toneMapping: THUMBNAIL_LOOK.toneMapping,
          scene: this._scene, camera: this._camera,
        },
        ({ target }) => {
          this._renderer.render(this._scene, this._camera);
          return this._capture!.readPixels(target, ss, ss);
        },
      );
      const pixels = await read;
      if (!this._canvas) return null; // disposed while the readback was in flight
      return this._downscale(pixels, ss, size, false);
    } finally {
      capture.dispose();
    }
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

  /** Copy `pixels` into the scratch canvas (Y-flipped when they are in GL
   *  order) and downscale 2× in ONE `drawImage` step into the output canvas. */
  private _downscale(pixels: Uint8Array, ss: number, size: number, flip: boolean): HTMLCanvasElement {
    const ssCtx = this._ssCanvas!.getContext('2d')!;
    const imageData = ssCtx.createImageData(ss, ss);
    if (flip) {
      // WebGL pixels are bottom-to-top, flip vertically
      const row = ss * 4;
      for (let y = 0; y < ss; y++) {
        imageData.data.set(pixels.subarray((ss - 1 - y) * row, (ss - y) * row), y * row);
      }
    } else {
      imageData.data.set(pixels.subarray(0, ss * ss * 4));
    }
    ssCtx.putImageData(imageData, 0, 0);

    // One halving needs no mip chain; the canvas filters premultiplied, which
    // is what keeps the silhouette free of dark fringes.
    const ctx = this._canvas!.getContext('2d')!;
    ctx.clearRect(0, 0, size, size);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(this._ssCanvas!, 0, 0, ss, ss, 0, 0, size, size);
    return this._canvas!;
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
    this._capture?.dispose();
    this._capture = null;
    // Detach the shared environment reference (we never owned it).
    this._scene.environment = null;
    this._ssCanvas = null;
    this._canvas = null;
    this._pixels = null;
  }
}
