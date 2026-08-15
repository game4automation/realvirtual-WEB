// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Contact-shadow bake for library thumbnails (plan-712 Phase 3).
 *
 * Puts the asset on the ground without drawing a ground: an orthographic
 * camera sitting on the floor looks *up* at the subject and renders it with a
 * modified `MeshDepthMaterial` that writes "how close is this fragment to the
 * floor" into the ALPHA channel (colour stays black). Two Gaussian blur passes
 * later, that alpha mask is the shadow — silhouette-true, independent of the
 * scene's lights, camera and shadow-map settings, and free of the usual
 * shadow-map bias/acne tuning.
 *
 * Technique: three.js example `webgl_shadow_contact` / drei `ContactShadows`.
 *
 * The factory is pure in the sense that matters here: it allocates its own
 * render targets, restores every piece of renderer state it touches, and hands
 * ownership of the result to the caller via {@link ContactShadowBake.dispose}.
 * It briefly re-parents `subject` into a private bake scene (an override
 * material needs a `Scene` root) and always puts it back — including on a
 * throw.
 *
 * ## Deliberate non-goals
 *
 * - **Meshless subjects** (Points/Lines only) bake an empty depth pass, so the
 *   shadow texture stays fully transparent and the asset ends up with no
 *   shadow. That is a silent, accepted outcome, not an error.
 * - The plane is never parented to the subject: the thumbnail camera fit runs
 *   `Box3.setFromObject(subject)`, which has no exclude option, so the plane
 *   has to be a sibling or it would inflate the framing.
 */

import {
  Box3,
  DoubleSide,
  Mesh,
  MeshBasicMaterial,
  MeshDepthMaterial,
  OrthographicCamera,
  PlaneGeometry,
  Scene,
  ShaderMaterial,
  UniformsUtils,
  Vector3,
  WebGLRenderTarget,
} from 'three';
import type { Object3D, WebGLRenderer } from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { HorizontalBlurShader } from 'three/addons/shaders/HorizontalBlurShader.js';
import { VerticalBlurShader } from 'three/addons/shaders/VerticalBlurShader.js';

/** Result of {@link bakeContactShadow}. The caller owns disposal. */
export interface ContactShadowBake {
  /** Flat, unlit, transparent shadow plane in world space. Add as a SIBLING of
   *  the subject — never as a child (see module doc). */
  plane: Mesh;
  /** Free the bake render targets, geometry and materials. Call once the
   *  thumbnail has been read back. */
  dispose(): void;
}

export interface ContactShadowOptions {
  /** Edge length of the (square) bake render target in px. */
  resolution?: number;
  /** Peak opacity of the shadow directly under the asset (0..1). */
  opacity?: number;
  /** Blur strength in bake-texture pixels per pass. */
  blur?: number;
  /** Plane extent as a multiple of the subject's larger ground-plane extent.
   *  > 1 leaves room for the blur to fade out instead of being clipped. */
  margin?: number;
}

const _size = new Vector3();
const _center = new Vector3();

/**
 * Bake a soft contact shadow for `subject` and return the plane to place it on.
 *
 * @param renderer live WebGL renderer (state is saved and restored)
 * @param subject  the object to cast — must currently be parented (or parentless)
 *                 in a scene the caller controls; it is temporarily moved
 * @param bounds   world bounds of `subject`, already computed by the caller
 * @returns the bake, or `null` when there is nothing sensible to bake
 *          (empty/degenerate bounds — an empty `Box3` holds ±Infinity and would
 *          turn every derived transform into NaN)
 */
export function bakeContactShadow(
  renderer: WebGLRenderer,
  subject: Object3D,
  bounds: Box3,
  opts: ContactShadowOptions = {},
): ContactShadowBake | null {
  if (bounds.isEmpty()) return null;

  bounds.getSize(_size);
  bounds.getCenter(_center);
  const maxDim = Math.max(_size.x, _size.y, _size.z);
  if (!Number.isFinite(maxDim) || maxDim <= 0) return null;

  const resolution = opts.resolution ?? 256;
  const opacity = opts.opacity ?? 0.4;
  const blur = opts.blur ?? 2.5;
  const margin = opts.margin ?? 1.5;

  // Square footprint so bake target, camera frustum and plane share one aspect.
  const extent = Math.max(_size.x, _size.z, maxDim * 0.05) * margin;
  // Epsilon below the lowest geometry: co-planar assets (sheet metal, cover
  // plates) would Z-fight with a plane sitting exactly at bounds.min.y.
  const planeY = bounds.min.y - Math.max(maxDim * 0.002, 1e-4);
  // Look-up distance: tall enough to catch the whole asset, never zero for a
  // perfectly flat one.
  const depth = Math.max(_size.y, maxDim * 0.05, 1e-3);

  // Camera sits on the floor looking straight up. `up = +Z` makes the baked
  // texture's u/v run along world +X/+Z, which is exactly how the plane below
  // (rotation.x = +PI/2) maps its own uv — no mirrored shadows.
  const camera = new OrthographicCamera(-extent / 2, extent / 2, extent / 2, -extent / 2, 0, depth);
  camera.up.set(0, 0, 1);
  camera.position.set(_center.x, planeY, _center.z);
  camera.lookAt(_center.x, planeY + 1, _center.z);
  camera.updateProjectionMatrix();

  const depthMaterial = new MeshDepthMaterial();
  depthMaterial.depthTest = false;
  depthMaterial.depthWrite = false;
  const darkness = { value: opacity };
  depthMaterial.onBeforeCompile = (shader) => {
    shader.uniforms.darkness = darkness;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', 'uniform float darkness;\n#include <common>')
      .replace(
        'vec4( vec3( 1.0 - fragCoordZ ), opacity );',
        'vec4( vec3( 0.0 ), ( 1.0 - fragCoordZ ) * darkness );',
      );
  };

  const bakeTarget = new WebGLRenderTarget(resolution, resolution);
  const blurTarget = new WebGLRenderTarget(resolution, resolution);

  const hBlur = new ShaderMaterial({
    uniforms: UniformsUtils.clone(HorizontalBlurShader.uniforms),
    vertexShader: HorizontalBlurShader.vertexShader,
    fragmentShader: HorizontalBlurShader.fragmentShader,
    depthTest: false,
    depthWrite: false,
  });
  const vBlur = new ShaderMaterial({
    uniforms: UniformsUtils.clone(VerticalBlurShader.uniforms),
    vertexShader: VerticalBlurShader.vertexShader,
    fragmentShader: VerticalBlurShader.fragmentShader,
    depthTest: false,
    depthWrite: false,
  });
  const quad = new FullScreenQuad(hBlur);

  // An override material only applies to a `Scene` root, so the subject has to
  // visit one. Local transforms are untouched and both scenes are at identity,
  // so world positions stay put for the bake.
  const bakeScene = new Scene();
  bakeScene.overrideMaterial = depthMaterial;
  const prevParent = subject.parent;

  const prevTarget = renderer.getRenderTarget();
  const prevClearAlpha = renderer.getClearAlpha();

  try {
    bakeScene.add(subject);

    renderer.setClearAlpha(0);
    renderer.setRenderTarget(bakeTarget);
    renderer.clear();
    renderer.render(bakeScene, camera);

    // Two-pass separable blur, ping-ponging back into the bake target so the
    // plane can keep pointing at one texture.
    hBlur.uniforms.tDiffuse.value = bakeTarget.texture;
    hBlur.uniforms.h.value = blur / resolution;
    quad.material = hBlur;
    renderer.setRenderTarget(blurTarget);
    renderer.clear();
    quad.render(renderer);

    vBlur.uniforms.tDiffuse.value = blurTarget.texture;
    vBlur.uniforms.v.value = blur / resolution;
    quad.material = vBlur;
    renderer.setRenderTarget(bakeTarget);
    renderer.clear();
    quad.render(renderer);
  } finally {
    bakeScene.remove(subject);
    if (prevParent) prevParent.add(subject);
    renderer.setClearAlpha(prevClearAlpha);
    renderer.setRenderTarget(prevTarget);
    bakeScene.overrideMaterial = null;
  }

  const geometry = new PlaneGeometry(extent, extent);
  const material = new MeshBasicMaterial({
    map: bakeTarget.texture,
    transparent: true,
    // Keeps the plane out of the GTAO depth prepass — no AO seam along the
    // shadow's edge — and out of the way of the asset's own geometry.
    depthWrite: false,
    // The uv-preserving orientation below points the plane's normal downwards;
    // the material is unlit, so rendering both sides is the cheapest fix.
    side: DoubleSide,
  });

  const plane = new Mesh(geometry, material);
  plane.rotation.x = Math.PI / 2;
  plane.position.set(_center.x, planeY, _center.z);
  plane.renderOrder = -1;

  return {
    plane,
    dispose(): void {
      quad.dispose();
      hBlur.dispose();
      vBlur.dispose();
      depthMaterial.dispose();
      geometry.dispose();
      material.dispose();
      blurTarget.dispose();
      bakeTarget.dispose();
    },
  };
}
