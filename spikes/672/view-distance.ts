// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-672 Phase 0 — the two candidate depth override materials and the FLOAT
 * readback path the plan asks Phase 0 to build before it is believed.
 *
 * Everything here is deliberately spike-local. The plan's §2.2 earmarks the
 * float read path for `src/core/engine/rv-offscreen-capture.ts`, but Phase 0 is
 * a Go/No-Go, not Phase 2: a prototype that measures the real cost settles F3
 * without committing a public module to a format the gate may reject. If the
 * verdict is "float", the body of {@link readFloatTargetTopDown} is what moves
 * into `OffscreenCapture` — it is written to be liftable, not clever.
 *
 * ## The two candidates
 *
 * BASELINE (24 bit, proven): three's own `MeshDepthMaterial` with
 * `RGBADepthPacking` into a LINEAR RGBA8 target, decoded by the repo's
 * `unpackRGBADepth`. Proven green on the classic WebGLRenderer by
 * `tests/rv-toon-gbuffer-smoke.test.ts:152-171`. It writes packed NDC depth, so
 * the decode needs the camera's near/far and the precision is spent
 * non-uniformly — dense at the near plane, coarse far away.
 *
 * KÜR (float): {@link createViewDistanceMaterial} writes the Euclidean view
 * distance `length(mvPosition.xyz)` in METRES into R of a `FloatType` /
 * `HalfFloatType` target. No decode, no near/far dependency, uniform absolute
 * precision — and, unlike the packed path, it also gives the true RADIAL
 * distance rather than the perpendicular depth the rasteriser interpolates,
 * which is what a ToF sensor actually reports.
 *
 * ## BATCHING CONTRACT (doc-bake-picking-internals §1.6 point 5)
 *
 * Both materials go through `scene.overrideMaterial`, so they render the
 * BatchedMesh arenas of the baked pipeline. `<batching_pars_vertex>` /
 * `<batching_vertex>` are what make the per-instance matrix reach
 * `<project_vertex>`; without them every instance draws at the identity and the
 * measurement would be of an empty scene. Copied from `rv-gbuffer-material.ts`
 * for exactly that reason.
 */

import {
  FloatType,
  HalfFloatType,
  LinearFilter,
  LinearSRGBColorSpace,
  NearestFilter,
  RGBAFormat,
  ShaderMaterial,
  WebGLRenderTarget,
  type TextureDataType,
  type WebGLRenderer,
} from 'three';

/** Vertex stage: carry the view-space position, batching-aware. */
export const VIEW_DISTANCE_VERT = /* glsl */`
#include <common>
#include <batching_pars_vertex>
varying vec3 vView;
void main() {
  #include <batching_vertex>
  #include <begin_vertex>
  #include <project_vertex>
  vView = mvPosition.xyz;
}`;

/**
 * Fragment stage: metres into R, nothing else.
 *
 * `length(vView)` is the RADIAL distance from the camera origin, not `-vView.z`
 * — a sensor measures along its ray, and the difference at the edge of a 40°
 * field of view is ~6 %.
 */
export const VIEW_DISTANCE_FRAG = /* glsl */`
varying vec3 vView;
void main() {
  gl_FragColor = vec4(length(vView), 0.0, 0.0, 1.0);
}`;

/** A fresh view-distance override material (metres in R). */
export function createViewDistanceMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: {},
    vertexShader: VIEW_DISTANCE_VERT,
    fragmentShader: VIEW_DISTANCE_FRAG,
  });
}

export type DepthTargetKind = 'rgba8' | 'half' | 'float';

const TYPE_OF: Record<DepthTargetKind, TextureDataType | undefined> = {
  rgba8: undefined, // WebGLRenderTarget's default = UnsignedByteType
  half: HalfFloatType,
  float: FloatType,
};

/**
 * A render target for a depth pass.
 *
 * ALWAYS `LinearSRGBColorSpace`: `contract-bake-picking.md:857-859` — a gbuffer or
 * depth override must render into a LINEAR target. plan-740 measured a surface
 * 2.5 m away as 6.08 m through an sRGB one. That is a recorded bug, not a
 * theoretical risk, and it applies to the float targets too (three decides the
 * output encoding from the texture's colour space, not from its type).
 *
 * `NearestFilter` on the float targets: a sensor samples, it does not blur, and
 * a half-float target with linear filtering is not guaranteed filterable
 * everywhere.
 */
export function createDepthTarget(
  width: number,
  height: number,
  kind: DepthTargetKind,
): WebGLRenderTarget {
  const type = TYPE_OF[kind];
  const rt = new WebGLRenderTarget(width, height, {
    format: RGBAFormat,
    ...(type ? { type } : {}),
    minFilter: kind === 'rgba8' ? LinearFilter : NearestFilter,
    magFilter: kind === 'rgba8' ? LinearFilter : NearestFilter,
    depthBuffer: true,
  });
  rt.texture.colorSpace = LinearSRGBColorSpace;
  return rt;
}

/** What a float readback attempt produced, or why it could not happen. */
export interface FloatReadback {
  /** One float per channel, 4 per pixel, TOP-DOWN rows. */
  pixels: Float32Array;
  /** Which GL read type actually served the data. */
  via: 'float32' | 'half16';
}

/** Bit-exact IEEE half → float32, so a HalfFloatType target can be decoded. */
export function halfToFloat(h: number): number {
  const sign = (h & 0x8000) ? -1 : 1;
  const exp = (h >> 10) & 0x1f;
  const frac = h & 0x3ff;
  if (exp === 0) return sign * Math.pow(2, -14) * (frac / 1024);
  if (exp === 31) return frac ? NaN : sign * Infinity;
  return sign * Math.pow(2, exp - 15) * (1 + frac / 1024);
}

/** Flip rows of an interleaved RGBA buffer in place (GL order → image order). */
function flipRowsInPlace<T extends Float32Array | Uint16Array>(px: T, width: number, height: number): T {
  const row = width * 4;
  const tmp = px.slice(0, row);
  for (let y = 0; y < height >> 1; y++) {
    const a = y * row;
    const b = (height - 1 - y) * row;
    tmp.set(px.subarray(a, a + row));
    px.copyWithin(a, b, b + row);
    px.set(tmp, b);
  }
  return px;
}

/**
 * THE NEW READ PATH — read a FLOAT render target back as top-down rows.
 *
 * This is the piece `rv-offscreen-capture.ts` does not have on any backend
 * (R12): every path there is `Uint8Array`/RGBA8. The mechanics are not exotic,
 * and that is the finding: three's `readRenderTargetPixels` passes the
 * target texture's `format`/`type` straight to `gl.readPixels`, so the ONLY
 * thing a float path needs is a matching typed array —
 *
 *   `FloatType`     → `Float32Array`
 *   `HalfFloatType` → `Uint16Array`, decoded with {@link halfToFloat}
 *
 * The hard part is not the call, it is the CAPABILITY: WebGL2 colour-renders
 * float only with `EXT_color_buffer_float`, and even then `readPixels` from an
 * RGBA16F attachment is only guaranteed for the driver's
 * `IMPLEMENTATION_COLOR_READ_TYPE`. So a caller cannot assume; it has to ask.
 * {@link floatReadbackSupport} is that question, and the honest answer on a
 * given machine is what Phase 0 measures.
 *
 * Classic `WebGLRenderer` only — the WebGPU half of the contract is out of
 * scope by the plan's own instruction (R12: `renderAuxiliaryPass` is a no-op
 * there, so a number would be a sham).
 */
export function readFloatTargetTopDown(
  renderer: WebGLRenderer,
  target: WebGLRenderTarget,
  width: number,
  height: number,
): FloatReadback {
  const type = target.texture.type;
  if (type === FloatType) {
    const px = new Float32Array(width * height * 4);
    renderer.readRenderTargetPixels(target, 0, 0, width, height, px);
    return { pixels: flipRowsInPlace(px, width, height), via: 'float32' };
  }
  if (type === HalfFloatType) {
    const raw = new Uint16Array(width * height * 4);
    renderer.readRenderTargetPixels(target, 0, 0, width, height, raw);
    flipRowsInPlace(raw, width, height);
    const out = new Float32Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = halfToFloat(raw[i]);
    return { pixels: out, via: 'half16' };
  }
  throw new Error(`readFloatTargetTopDown: target type ${String(type)} is not a float type`);
}

/** What this renderer/driver can actually do with float colour targets. */
export interface FloatSupport {
  colorBufferFloat: boolean;
  floatBlend: boolean;
  /** `gl.getParameter(IMPLEMENTATION_COLOR_READ_TYPE)` names on the bound FBO. */
  readTypeFloat: boolean;
  readTypeHalf: boolean;
  renderer: string;
}

const GL_FLOAT = 0x1406;
const GL_HALF_FLOAT = 0x140b;
const GL_IMPLEMENTATION_COLOR_READ_TYPE = 0x8b9a;

/**
 * Probe the float capability — extensions first, then the read type the driver
 * reports while a float target is actually bound (the only answer that counts).
 */
export function floatReadbackSupport(
  renderer: WebGLRenderer,
  probe?: WebGLRenderTarget,
): FloatSupport {
  const gl = renderer.getContext() as WebGL2RenderingContext;
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  const out: FloatSupport = {
    colorBufferFloat: !!gl.getExtension('EXT_color_buffer_float'),
    floatBlend: !!gl.getExtension('EXT_float_blend'),
    readTypeFloat: false,
    readTypeHalf: false,
    renderer: dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : 'unknown',
  };
  if (probe) {
    const prev = renderer.getRenderTarget();
    try {
      renderer.setRenderTarget(probe);
      const t = gl.getParameter(GL_IMPLEMENTATION_COLOR_READ_TYPE) as number;
      out.readTypeFloat = t === GL_FLOAT;
      out.readTypeHalf = t === GL_HALF_FLOAT;
    } finally {
      renderer.setRenderTarget(prev);
    }
  }
  return out;
}
