// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-offscreen-capture — the one offscreen render + readback path (plan-740
 * P2.1 / D-A15; WebGPU-capable since plan-763).
 *
 * There were three copies of "render into a private target and read the pixels
 * back": `web_eye` (allocating a fresh target per call),
 * `ThumbnailRenderer` (its WebGPU studio pass: 2× supersample, transparent clear)
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
 * READBACK (plan-763). Three renderer/backend combinations read pixels back
 * differently, and {@link readTargetPixelsTopDown} hides all three behind one
 * promise of TOP-DOWN RGBA8 rows:
 *  1. the classic `WebGLRenderer`: synchronous `readRenderTargetPixels`, GL
 *     (bottom-up) rows — unchanged behaviour, wrapped in a resolved promise;
 *  2. a `WebGPURenderer` on its WebGL backend (`forceWebGL`, the `webgpu-gl`
 *     test path): only `readRenderTargetPixelsAsync` exists, GL rows, no
 *     padding, and its fence wait polls `requestAnimationFrame`, so it is
 *     guarded by a timeout for background tabs;
 *  3. a `WebGPURenderer` on the real WebGPU backend: `readRenderTargetPixelsAsync`
 *     returns top-down rows padded to 256 bytes (the last row may be short),
 *     which {@link unpadRows} strips.
 * In all three the texture copy is enqueued synchronously by the call, so a
 * caller may render into the same target again right after issuing a read and
 * await the results later — never hold renderer state across an `await`.
 *
 * MEMORY. One persistent render target per instance, reallocated only when the
 * requested size changes. Every readback gets its own buffer: captures run
 * serialised by their owners (eye tools, a save's thumbnail), and a shared buffer
 * handed out before an `await` would be overwritten by the next read.
 */

import {
  Color,
  SRGBColorSpace,
  WebGLRenderTarget,
  type Camera,
  type Light,
  type ColorSpace,
  type Material,
  type Object3D,
  type Scene,
  type Texture,
  type ToneMapping,
  type WebGLRenderer,
} from 'three';

/**
 * The message the video-capture preflight returns under a WebGPURenderer
 * (D-U11). Captures no longer need the classic renderer (plan-763); recording
 * keeps the gate until its WebGPU smoke test is green.
 */
export const WEBGL_REQUIRED_ERROR =
  'requires the classic WebGL renderer (Settings → Visual → Renderer)';

/** Renderer surface an offscreen capture needs. */
export interface CaptureRenderer extends WebGLRenderer {
  isWebGPURenderer?: boolean;
  backend?: { isWebGPUBackend?: boolean };
}

/** The async readback as the WebGPURenderer declares it (6th parameter = texture index). */
interface AsyncReadable {
  readRenderTargetPixelsAsync?: (
    target: WebGLRenderTarget, x: number, y: number, w: number, h: number,
    textureIndex?: number,
  ) => Promise<ArrayBufferView | void>;
}

/**
 * `null` when `renderer` can capture, otherwise the error message naming
 * `tool`. Any renderer that can read a render target back qualifies — the
 * classic WebGLRenderer (sync read) and both WebGPURenderer backends (async
 * read). Only a missing renderer or a stub without either API is refused.
 */
export function captureSupported(renderer: unknown, tool: string): string | null {
  const r = renderer as (CaptureRenderer & AsyncReadable) | undefined;
  if (!r) return `${tool} has no renderer to capture with`;
  if (typeof r.readRenderTargetPixels !== 'function'
    && typeof r.readRenderTargetPixelsAsync !== 'function') {
    return `${tool} needs a renderer that can read pixels back`;
  }
  return null;
}

/** True for a WebGPURenderer running on the real WebGPU backend. */
export function isRealWebGPUBackend(renderer: unknown): boolean {
  const r = renderer as CaptureRenderer | undefined;
  return !!r?.isWebGPURenderer && !!r.backend?.isWebGPUBackend;
}

/**
 * Strip the per-row padding of a WebGPU readback into tightly packed rows.
 *
 * WebGPU requires `bytesPerRow` to be a multiple of 256; three pads each row to
 * that and the LAST row may be short (`(height-1)*bytesPerRow + width*4`
 * bytes in total). Pure, allocation-exact, Node-testable. A buffer that is
 * already tight is returned as is.
 */
export function unpadRows(src: Uint8Array, width: number, height: number, bytesPerRow: number): Uint8Array {
  const rowBytes = width * 4;
  if (bytesPerRow === rowBytes && src.length === rowBytes * height) return src;
  const out = new Uint8Array(rowBytes * height);
  for (let y = 0; y < height; y++) {
    const start = y * bytesPerRow;
    out.set(src.subarray(start, start + rowBytes), y * rowBytes);
  }
  return out;
}

/** The padded row stride three's WebGPU backend uses for RGBA8 readbacks. */
function paddedBytesPerRow(width: number): number {
  return Math.ceil((width * 4) / 256) * 256;
}

/** Flip rows in place (GL order ↔ image order) with one row-sized scratch. */
function flipRowsInPlace(px: Uint8Array, width: number, height: number): Uint8Array {
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

/** Background tabs clamp the WebGL-backend fence poll; fail instead of hanging. */
const ASYNC_READBACK_TIMEOUT_MS = 10_000;

/**
 * Read an RGBA8 render target back as TOP-DOWN rows — classic WebGL path.
 *
 * WebGL hands back bottom-up rows; every consumer here wants image order, so
 * the flip happens once, in place, with a single row-sized scratch buffer.
 * `out` lets a caller keep several readbacks alive simultaneously — without it
 * each call allocates. Synchronous and WebGL-only; the backend-agnostic entry
 * is {@link readTargetPixelsTopDown}.
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
  return flipRowsInPlace(px, width, height);
}

/**
 * Read an RGBA8 render target back as TOP-DOWN rows on ANY renderer.
 *
 * The copy is issued synchronously inside this call on every backend; only
 * the result is awaited. Callers therefore render, call this, render the next
 * thing into the same target, call this again — and `await Promise.all` once
 * their renderer state is restored. Each call returns a fresh buffer (or
 * fills `out` on the classic renderer).
 */
export function readTargetPixelsTopDown(
  renderer: unknown,
  target: WebGLRenderTarget,
  width: number,
  height: number,
  out?: Uint8Array,
): Promise<Uint8Array> {
  const r = renderer as CaptureRenderer;
  if (!r.isWebGPURenderer && typeof r.readRenderTargetPixels === 'function') {
    // 1. classic WebGLRenderer — unchanged synchronous behaviour.
    return Promise.resolve(readRenderTargetPixelsFlipped(r, target, width, height, out));
  }
  const async = renderer as AsyncReadable;
  if (typeof async.readRenderTargetPixelsAsync !== 'function') {
    return Promise.reject(new Error('readTargetPixelsTopDown: renderer cannot read pixels back'));
  }
  // 2./3. WebGPURenderer — the 6th parameter is the TEXTURE INDEX, never a
  // buffer (a buffer crashes deep in the backend: "Invalid value used as weak
  // map key").
  const real = isRealWebGPUBackend(r);
  const read = async.readRenderTargetPixelsAsync(target, 0, 0, width, height, 0)
    .then((result) => {
      let px: Uint8Array;
      if (result instanceof Uint8Array) px = result;
      else if (result && ArrayBuffer.isView(result)) {
        px = new Uint8Array(result.buffer, result.byteOffset, result.byteLength);
      } else throw new Error('readTargetPixelsTopDown: WebGPU readback returned no pixel data');
      if (real) {
        // 3. top-down rows, padded to 256 bytes per row.
        const tight = width * height * 4;
        return px.length === tight ? px : unpadRows(px, width, height, paddedBytesPerRow(width));
      }
      // 2. the WebGL backend behind a WebGPURenderer: GL rows, no padding.
      return flipRowsInPlace(px, width, height);
    });
  if (real) return read;
  // The WebGL backend waits on its fence through requestAnimationFrame
  // (WebGLUtils._clientWaitAsync), which a hidden tab never fires.
  return new Promise<Uint8Array>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('readTargetPixelsTopDown: readback timed out (hidden tab?)')),
      ASYNC_READBACK_TIMEOUT_MS,
    );
    read.then((px) => { clearTimeout(timer); resolve(px); }, (e) => { clearTimeout(timer); reject(e); });
  });
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
 * WebGL only: the WebGPURenderer has no `shadowMap.needsUpdate` model.
 */
export function ensureShadowMaps(renderer: WebGLRenderer, scene: Scene): void {
  if ((renderer as CaptureRenderer).isWebGPURenderer) return;
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
 * itself (that is what keeps the save-time thumbnail's 2× box filter identical).
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
  /** Objects hidden for the pass and restored afterwards (the floor mirror). */
  hide?: readonly Object3D[];
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
 * Owns one render target for a single consumer.
 *
 * Instances are per-owner on purpose (the agent eye plugin, the thumbnail
 * renderer): a shared instance would have two consumers resizing the same
 * target against each other, and the whole reason for a persistent target is to
 * stop reallocating it.
 */
export class OffscreenCapture {
  private _rt: WebGLRenderTarget | null = null;
  private _rtColorSpace: ColorSpace = SRGBColorSpace;
  private readonly _tmpClear = new Color();

  constructor(private readonly getRenderer: () => WebGLRenderer | undefined) {}

  /** The renderer, or `undefined` when the viewer is gone. */
  get renderer(): WebGLRenderer | undefined {
    return this.getRenderer();
  }

  /** `null` when this capture can run, otherwise the agent-facing error. */
  guard(tool: string): string | null {
    return captureSupported(this.getRenderer(), tool);
  }

  /**
   * The persistent target at the requested size. Reallocated (not resized) when
   * the colour space changes, because `WebGLRenderTarget.setSize` does not
   * re-create the texture's colour space. A `WebGLRenderTarget` (RGBA8, i.e.
   * `UnsignedByteType`) is what both renderer families accept and read back as
   * bytes — the WebGPURenderer's default target type is HalfFloat, which would
   * come back as 16-bit words.
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
   * Synchronous by design: `fn` renders and ISSUES its readbacks; the promises
   * it returns are awaited by the caller after this method has restored the
   * renderer, so no `await` ever happens with the pass state applied.
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
    const hidden: Object3D[] = [];

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
      if (pass.hide) {
        for (const o of pass.hide) {
          if (o.visible) { o.visible = false; hidden.push(o); }
        }
      }
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
      for (const o of hidden) o.visible = true;
    }
  }

  /**
   * Issue a top-down readback of `target` into a FRESH buffer. The copy is
   * enqueued synchronously; the pixels arrive with the promise. Call it inside
   * `withPass` right after rendering and await it outside.
   */
  readPixels(target: WebGLRenderTarget, width: number, height: number): Promise<Uint8Array> {
    const renderer = this.getRenderer();
    if (!renderer) return Promise.reject(new Error('OffscreenCapture: no renderer'));
    return readTargetPixelsTopDown(renderer, target, width, height);
  }

  /** Free the target. A readback still in flight keeps its own buffer. */
  dispose(): void {
    this._rt?.dispose();
    this._rt = null;
  }
}
