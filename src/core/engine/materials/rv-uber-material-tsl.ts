// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-uber-material-tsl — TSL (NodeMaterial) variant of the RVUberMaterial
 * (plan-271 Phase 2, port #1).
 *
 * Parity target: the GLSL `onBeforeCompile` patch in rv-uber-material.ts —
 * a single shared `MeshStandardNodeMaterial` that reads
 *   - base color from the `color` vertex attribute (`vertexColors: true`,
 *     three.js-native path — NodeMaterial honours it in setupDiffuseColor)
 *   - roughness/metalness from the packed `rmPacked` vertex attribute
 *     (Uint8 normalized vec2) via `roughnessNode`/`metalnessNode`.
 *
 * The attribute is forwarded through an explicit varying (`vRm`) exactly like
 * the GLSL variant, so the fragment stage interpolates the same data.
 *
 * Import hygiene (enforced by tests/tsl-import-hygiene.node.test.ts):
 *  - This module may ONLY import from 'three/webgpu' / 'three/tsl' — never
 *    from 'three' (dual-three-instance trap, plan-090) and never from
 *    rv-viewer (architecture rule, plan-271 review finding 9).
 *  - It is ONLY loaded via the dynamic import in material-factory.ts
 *    (`preloadTslMaterials()`), so `three/webgpu` stays out of the default
 *    bundle chunk.
 */

import { MeshStandardNodeMaterial, FrontSide } from 'three/webgpu';
import { attribute, varying } from 'three/tsl';

/**
 * Create the shared TSL uber material. Mirrors `new RVUberMaterial(false)`
 * on the GLSL side: identity color/roughness/metalness — the real values come
 * from the baked per-vertex attributes. Marked `userData._rvShared` so
 * clearModel() skips it during model teardown (singleton outlives loads), and
 * named `__rvUberMaterial` so the toon manager recognises it (rmPacked
 * coupling, plan-271 port #2).
 *
 * `clippingPlanes` is inherited from the Material base class and honoured by
 * the WebGPURenderer node pipeline (plan-162 safeguard — asserted by test 9.3).
 */
export function createUberMaterialTsl(): MeshStandardNodeMaterial {
  const mat = new MeshStandardNodeMaterial({
    color: 0xffffff,    // identity — real color comes from the `color` vertex attribute
    roughness: 1.0,     // identity — replaced by rmPacked.x below
    metalness: 0.0,     // identity — replaced by rmPacked.y below
    vertexColors: true, // NodeMaterial-native: multiplies the `color` attribute in
    side: FrontSide,
  });

  // (roughness, metalness) packed as Uint8-normalized vec2 — same layout the
  // GLSL patch consumes. Explicit varying = parity with the GLSL `vRm`.
  // (Explicit <'vec2'> generic: TS would otherwise widen the literal to
  // `string` and lose the swizzle extensions.)
  const vRm = varying(attribute<'vec2'>('rmPacked', 'vec2'), 'vRm');
  mat.roughnessNode = vRm.x;
  mat.metalnessNode = vRm.y;

  mat.name = '__rvUberMaterial';
  mat.userData._rvShared = true;
  return mat;
}
