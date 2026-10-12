// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-offscreen-capture — the one offscreen render + readback path (plan-740
 * P2.1 / D-A15).
 *
 * There were three copies of "render into a private target and read the pixels
 * back": `web_eye` (allocating a fresh target per call),
 * `ThumbnailRenderer.renderLive` (layer 0, 2× supersample, transparent clear)
 * and `ObjectAnalyzer` (overlay layers off, a target per tile size). They agree
 * on the mechanics and DISAGREE on the contract — which is why the contract
 * differences are parameters here ({@link OffscreenPass}) instead of three
 * near-identical bodies that drift.
 *
 * What {@link OffscreenCapture.withPass} guarantees: every piece of renderer and
 * scene state it touches is saved before and restored after, including on a
 * throw. A capture that leaves `scene.overrideMaterial` set or the render target
 * pointing at a private RT does not fail loudly — it silently corrupts the next
 * viewport frame, which is why the restore is unconditional and covered by a
 * test rather than left to each caller.
 *
 * Only fields PRESENT on the pass are set; the rest are left exactly as they
 * were. That is what lets `ThumbnailRenderer` keep its documented "tone mapping
 * is deliberately not swapped" behaviour while the eye channels do swap the
 * background and the override material.
 *
 * MEMORY. One persistent render target per instance, reallocated only when the
 * requested size changes, plus one readback buffer that is reused across calls
 * ({@link OffscreenCapture.readPixels}). Callers that must hold several
 * readbacks alive at once (the analyzer's three-pass mask) pass their own
 * destination to {@link readRenderTargetPixelsFlipped} instead.
 */

import {
  Color,
  SRGBColorSpace,
  WebGLRenderTarget,
  type Camera,
  type Light,
  type ColorSpace,
  type Material,
  type Scene,
  type Texture,
  type ToneMapping,
  type WebGLRenderer,
} from 'three';

/**
 * The message every capture tool returns under a WebGPURenderer (D-U11).
 *
 * Deliberately one shared string: the agent-facing contract is "capture needs
 * the classic renderer, and here is where to switch it", and three tools
 * phrasing that differently is three things for an agent to learn.
 */
export const WEBGL_REQUIRED_ERROR =
  'requires the classic WebGL renderer (Settings → Visual → Renderer)';

/** Renderer surface an offscreen capture needs. */
export interface CaptureRenderer extends WebGLRenderer {
  isWebGPURenderer?: boolean;
}

/**
 * `null` when `renderer` can capture, otherwise the error message naming
 * `tool`. Both halves of the check matter: `isWebGPURenderer` covers the WebGPU
 * backend, and the missing `readRenderTargetPixels` covers anything else that
 * is not the classic renderer (a stub, a future backend).
 */
export function guardWebGL(renderer: unknown, tool: string): string | null {
  const r = renderer as CaptureRenderer | undefined;
  if (!r) return `${tool} ${WEBGL_REQUIRED_ERROR}`;
  if (r.isWebGPURenderer || typeof r.readRenderTargetPixels !== 'function') {
    return `${tool} ${WEBGL_REQUIRED_ERROR}`;
  }
  return null;
}

/**
 * Read an RGBA8 render target back as TOP-DOWN rows.
 *
 * WebGL hands back bottom-up rows; every consumer here wants image order, so
 * the flip happens once, in place, with a single row-sized scratch buffer.
 * `out` lets a caller keep several readbacks alive simultaneously (the object
 * analyzer's colour / visible-mask / full-mask triple) — without it each call
 * allocates.
 */
export function readRenderTargetPixelsFlipped(
  renderer: WebGLRenderer,
  target: WebGLRenderTarget,
  width: number,
  height: number,
  out?: Uint8Array,
): Uint8Array {
  const px = out && out.length === width * height * 4 ? out : new Uint8Array(width * height * 4);
  renderer.readRenderTargetPixels(target, 0, 0, width, height, px);
  const rowBytes = width * 4;
  const tmp = new Uint8Array(rowBytes);
  for (let y = 0; y < height >> 1; y++) {
    const a = y * rowBytes;
    const b = (height - 1 - y) * rowBytes;
    tmp.set(px.subarray(a, a + rowBytes));
    px.copyWithin(a, b, b + rowBytes);
    px.set(tmp, b);
  }
  return px;
}

/**
 * Make sure every shadow-casting light of `scene` has a shadow map before a
 * pass draws the scene with its REAL materials.
 *
 * The viewer updates shadow maps manually (`shadowMap.autoUpdate = false`):
 * the map is rendered inside the viewport's next dirty frame and nowhere
 * else, and the visual-settings setters dispose and null it when the size or
 * quality changes. Between that and the next viewport frame — which, with a
 * backgrounded tab, may never come — `light.shadow.map` is null while the
 * materials' programs still carry a `sampler2DShadow` (three r185 shadow
 * maps are depth-compare textures). Binding the empty texture into that
 * sampler makes every lit draw an INVALID_OPERATION that WebGL drops without
 * a word: the capture comes back as sky and floor only. Override-material
 * passes have no shadow sampler and never noticed.
 *
 * Asking the renderer for one shadow update inside the pass's own `render`
 * call allocates and fills the map; when the map exists this is a no-op.
 */
export function ensureShadowMaps(renderer: WebGLRenderer, scene: Scene): void {
  const shadowMap = renderer.shadowMap as unknown as { enabled: boolean; needsUpdate: boolean };
  if (!shadowMap.enabled || shadowMap.needsUpdate) return;
  let missing = false;
  scene.traverse((o) => {
    if (missing) return;
    const light = o as Light & { shadow?: { map: unknown } };
    if (light.isLight && light.castShadow && light.shadow && !light.shadow.map) missing = true;
  });
  if (missing) shadowMap.needsUpdate = true;
}

/**
 * One offscreen pass. `width`/`height` are the OUTPUT size; `supersample`
 * multiplies the render resolution, so the caller downscales the readback
 * itself (that is what keeps the thumbnail's 2× box filter identical).
 *
 * Everything optional is "leave as is" when omitted — never "reset to default".
 */
export interface OffscreenPass {
  width: number;
  height: number;
  /** Camera layer mask for the pass (e.g. `disableOverlayLayers` applied). */
  layerMask?: number;
  /** Render resolution multiplier. Thumbnails use 2, the eye channels 1. */
  supersample?: 1 | 2;
  /** `scene.overrideMaterial` during the pass (`null` clears it explicitly). */
  overrideMaterial?: Material | null;
  /** `scene.background` during the pass (`null` = transparent). */
  background?: Color | Texture | null;
  /** Renderer clear colour during the pass. */
  clearColor?: Color | number | string;
  /** Renderer clear alpha during the pass. */
  clearAlpha?: number;
  /** Renderer tone mapping during the pass. */
  toneMapping?: ToneMapping;
  /** Colour space of the render target texture (default sRGB). */
  colorSpace?: ColorSpace;
  /** Scene whose `overrideMaterial`/`background` are managed. */
  scene?: Scene;
  /** Camera whose layer mask is managed. */
  camera?: Camera;
}

/** What `withPass` hands the render callback. */
export interface OffscreenPassContext {
  target: WebGLRenderTarget;
  /** Render-resolution width (`width × supersample`). */
  width: number;
  height: number;
  renderer: WebGLRenderer;
}

/**
 * Owns one render target and one readback buffer for a single consumer.
 *
 * Instances are per-owner on purpose (the agent eye plugin, the thumbnail
 * renderer): a shared instance would have two consumers resizing the same
 * target against each other, and the whole reason for a persistent target is to
 * stop reallocating it.
 */
export class OffscreenCapture {
  private _rt: WebGLRenderTarget | null = null;
  private _rtColorSpace: ColorSpace = SRGBColorSpace;
  private _pixels: Uint8Array | null = null;
  private readonly _tmpClear = new Color();

  constructor(private readonly getRenderer: () => WebGLRenderer | undefined) {}

  /** The renderer, or `undefined` when the viewer is gone / not WebGL-capable. */
  get renderer(): WebGLRenderer | undefined {
    return this.getRenderer();
  }

  /** `null` when this capture can run, otherwise the D-U11 error message. */
  guard(tool: string): string | null {
    return guardWebGL(this.getRenderer(), tool);
  }

  /**
   * The persistent target at the requested size. Reallocated (not resized) when
   * the colour space changes, because `WebGLRenderTarget.setSize` does not
   * re-create the texture's colour space.
   */
  target(width: number, height: number, colorSpace: ColorSpace = SRGBColorSpace): WebGLRenderTarget {
    if (this._rt && this._rtColorSpace !== colorSpace) {
      this._rt.dispose();
      this._rt = null;
    }
    if (!this._rt) {
      this._rt = new WebGLRenderTarget(width, height);
      this._rt.texture.colorSpace = colorSpace;
      this._rtColorSpace = colorSpace;
    } else if (this._rt.width !== width || this._rt.height !== height) {
      this._rt.setSize(width, height);
    }
    return this._rt;
  }

  /**
   * Run `fn` with the pass applied, then restore every touched piece of state.
   *
   * Throws when there is no usable renderer — callers gate on {@link guard}
   * first and return the agent-facing error, so reaching here without one is a
   * programming error, not a runtime condition.
   */
  withPass<T>(pass: OffscreenPass, fn: (ctx: OffscreenPassContext) => T): T {
    const renderer = this.getRenderer();
    if (!renderer) throw new Error('OffscreenCapture: no renderer');
    const ss = pass.supersample ?? 1;
    const W = Math.max(1, Math.round(pass.width * ss));
    const H = Math.max(1, Math.round(pass.height * ss));
    const target = this.target(W, H, pass.colorSpace ?? SRGBColorSpace);

    const prevTarget = renderer.getRenderTarget();
    renderer.getClearColor(this._tmpClear);
    const prevClearColor = this._tmpClear.clone();
    const prevClearAlpha = renderer.getClearAlpha();
    const prevToneMapping = renderer.toneMapping;
    const scene = pass.scene;
    const prevOverride = scene ? scene.overrideMaterial : null;
    const prevBackground = scene ? scene.background : null;
    const camera = pass.camera;
    const prevLayerMask = camera ? camera.layers.mask : 0;

    try {
      if (pass.layerMask !== undefined && camera) camera.layers.mask = pass.layerMask;
      if (scene && pass.overrideMaterial !== undefined) scene.overrideMaterial = pass.overrideMaterial;
      if (scene && pass.background !== undefined) scene.background = pass.background;
      if (pass.clearColor !== undefined || pass.clearAlpha !== undefined) {
        renderer.setClearColor(
          pass.clearColor !== undefined ? new Color(pass.clearColor as never) : prevClearColor,
          pass.clearAlpha !== undefined ? pass.clearAlpha : prevClearAlpha,
        );
      }
      if (pass.toneMapping !== undefined) renderer.toneMapping = pass.toneMapping;
      // Real-material passes need the shadow maps the viewport may not have
      // rendered yet (see ensureShadowMaps); override passes do not sample them.
      if (scene && !scene.overrideMaterial) ensureShadowMaps(renderer, scene);
      renderer.setRenderTarget(target);
      return fn({ target, width: W, height: H, renderer });
    } finally {
      renderer.setRenderTarget(prevTarget);
      renderer.setClearColor(prevClearColor, prevClearAlpha);
      renderer.toneMapping = prevToneMapping;
      if (scene) {
        scene.overrideMaterial = prevOverride;
        scene.background = prevBackground;
      }
      if (camera) camera.layers.mask = prevLayerMask;
    }
  }

  /**
   * Read the current target back top-down into the REUSED buffer. The returned
   * array is only valid until the next `readPixels` on this instance — copy it
   * (or pass your own destination to {@link readRenderTargetPixelsFlipped}) if
   * you need two readbacks alive at once.
   */
  readPixels(target: WebGLRenderTarget, width: number, height: number): Uint8Array {
    const renderer = this.getRenderer();
    if (!renderer) throw new Error('OffscreenCapture: no renderer');
    const need = width * height * 4;
    if (!this._pixels || this._pixels.length !== need) this._pixels = new Uint8Array(need);
    return readRenderTargetPixelsFlipped(renderer, target, width, height, this._pixels);
  }

  /** Free the target. The readback buffer is plain memory and is dropped too. */
  dispose(): void {
    this._rt?.dispose();
    this._rt = null;
    this._pixels = null;
  }
}
