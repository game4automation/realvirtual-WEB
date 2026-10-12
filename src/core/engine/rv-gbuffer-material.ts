// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-gbuffer-material — the purpose-neutral normal+depth G-buffer override
 * material (plan-740 D-A10 / P2.2).
 *
 * Extracted verbatim from `RVToonMaterialManager`, which built it inline for
 * the outline Sobel pass and remains its first consumer. The agent eye's
 * `normals` and `edges` channels need exactly the same thing, and a second copy
 * of a batching-aware override shader is precisely the kind of duplicate that
 * goes silently wrong: the toon copy would keep working while the eye's copy
 * rendered every batched instance at the identity transform.
 *
 * WHAT IT WRITES. `RGB = normalize(viewNormal) * 0.5 + 0.5`, `A = linear view
 * depth normalized between `uNear` and `uFar`. One ordinary RGBA8 target, no
 * `DepthTexture` (non-portable across GPUs) and no MRT. The 8-bit alpha is
 * plenty for a Sobel and useless for metres — the eye's `depth` channel
 * therefore uses three's own `MeshDepthMaterial` with `RGBADepthPacking`
 * instead, and this material supplies only the normals.
 *
 * BATCHING CONTRACT (doc-render-picking §1.6 point 5 — do not break this).
 * The material is applied through `scene.overrideMaterial`, so it renders EVERY
 * object including the BatchedMesh arenas of the batched render pipeline. The
 * renderer injects `#define USE_BATCHING` and binds the batching textures per
 * object, but ONLY `<batching_pars_vertex>` / `<batching_vertex>` make the
 * per-instance matrix available to `<defaultnormal_vertex>` and
 * `<project_vertex>`. Remove them and batched geometry renders unposed.
 * `tests/rv-toon-gbuffer-smoke.test.ts` pins this with a real BatchedMesh.
 */

import { ShaderMaterial, type Plane } from 'three';

export const GBUFFER_VERT = /* glsl */`
#include <common>
#include <batching_pars_vertex>
uniform float uNear;
uniform float uFar;
varying vec3 vNrm;
varying float vDepth;
void main() {
  #include <batching_vertex>
  #include <beginnormal_vertex>
  #include <defaultnormal_vertex>
  vNrm = normalize(transformedNormal);
  #include <begin_vertex>
  #include <project_vertex>
  vDepth = clamp((-mvPosition.z - uNear) / max(uFar - uNear, 1e-4), 0.0, 1.0);
}`;

export const GBUFFER_FRAG = /* glsl */`
varying vec3 vNrm;
varying float vDepth;
void main() {
  gl_FragColor = vec4(normalize(vNrm) * 0.5 + 0.5, vDepth);
}`;

/**
 * A fresh G-buffer override material. `uNear`/`uFar` must be set to the
 * rendering camera's near/far before each pass — the alpha channel is
 * normalized against them, so a stale pair silently rescales every depth.
 *
 * `clippingPlanes` is passed through because the toon path renders the outline
 * G-buffer under the same section planes as the scene; an unclipped G-buffer
 * would outline the geometry that the cut removed.
 */
export function createGBufferMaterial(clippingPlanes?: Plane[] | null): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: { uNear: { value: 0.1 }, uFar: { value: 1000 } },
    vertexShader: GBUFFER_VERT,
    fragmentShader: GBUFFER_FRAG,
    ...(clippingPlanes ? { clippingPlanes } : {}),
  });
}

/**
 * Read back what {@link createGBufferMaterial} and the depth pass packed.
 *
 * Lives here rather than with the agent eye: the eye no longer renders a
 * depth pass at all, while the toon outline path still owns the G-buffer this
 * unpacks. Pure maths — no three.js state, testable on four bytes.
 */
/**
 * Unpack a `RGBADepthPacking` texel to a LINEAR view distance in metres.
 *
 * three packs normalized device depth across four bytes (the shadow-map
 * standard); `unpackRGBAToDepth` in GLSL is this dot product. The perspective
 * divide then has to be undone, which is why `near`/`far` are needed: the
 * packed value is not proportional to distance.
 *
 * Returns `NaN` for the cleared background (all four bytes at their clear
 * value), because a background pixel has no distance and `0` would read as
 * "right in front of the camera".
 */
export function unpackRGBADepth(
  r: number, g: number, b: number, a: number, near: number, far: number,
  orthographic = false,
): number {
  // three's `unpackRGBAToDepth` with the CURRENT `UnpackFactors4`:
  //   dot(v, vec4(255/256, 255/256/256, 255/256/65536, 1/16777216))
  // RED carries the coarse value and ALPHA the finest correction, and the
  // 255/256 downscale is not decoration — dropping it, or reading the bytes in
  // the other order, both produce a plausible-looking distance that is simply
  // wrong (the spike measured 6.1 m and 0.1 m for a surface 2.5 m away before
  // this matched three's shader exactly).
  const D = 255 / 256;
  const d = D * (r / 255)
    + D * (g / 255) / 256
    + D * (b / 255) / 65536
    + (a / 255) / 16777216;
  // Clear colour is white → packed depth 1.0 → the far plane → no geometry.
  if (d >= 0.999999) return NaN;
  if (d <= 0) return NaN;
  // Orthographic NDC depth is already linear in view z; the perspective one
  // is not, and undoing the divide is exactly what near/far are for.
  if (orthographic) return near + d * (far - near);
  const denom = far - d * (far - near);
  if (Math.abs(denom) < 1e-9) return NaN;
  return (near * far) / denom;
}
