// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-toon-materials-tsl — TSL variant of the toon RECOLOR path
 * (plan-271 Phase 2, port #2 — COUPLED to port #1: reads the uber `rmPacked`
 * vertex attribute for per-vertex metalness on uber-baked meshes).
 *
 * Parity target: the `onBeforeCompile` patch installed by
 * `RVToonMaterialManager._toToon()` (rv-toon-materials.ts):
 *
 *  - **Albedo grade**: linear brightness remap of the FULL base colour
 *    (material colour × base-colour texture × vertex colour) into
 *    [uAlbedoMinBright, uAlbedoMaxBright]; brightness = max channel (HSV
 *    value), hue preserved, value-less (black) pixels lift to neutral grey.
 *  - **Metal tint**: GLSL mixes `outgoingLight → (outgoingLight/albedo) ×
 *    uMetalColor` by `metalness × uMetalReflectivity`. Because the toon
 *    diffuse is multiplicatively linear in the albedo
 *    (`outgoingLight = albedo × bandedLight`), that is algebraically identical
 *    to mixing the ALBEDO toward `uMetalColor` before lighting:
 *    `light × mix(albedo, metalColor, k)` — which is exactly what the
 *    `colorNode` chain below does. No custom lighting hook needed.
 *
 * The vertex-colour factor is folded into the chain manually (and
 * `vertexColors` is forced off on the node material), because NodeMaterial
 * multiplies the vertex colour AFTER `colorNode` — the grade must run after
 * the vertex colour, like the GLSL inject after `<color_fragment>`.
 *
 * Deliberately NOT ported here (plan-271 Phase 3, gated): the Sobel outline
 * and the full-screen saturation pass — both stay disabled under WebGPU.
 *
 * Known (accepted) delta vs. GLSL: a base-colour texture's ALPHA channel is
 * not folded into the graded colour (colorNode is vec3; opacity/alphaMap run
 * through the default pipeline). Scene materials converted to toon are
 * opaque PBR — no consumer relies on map-alpha in toon mode.
 *
 * Import hygiene: only 'three/webgpu' / 'three/tsl'; loaded exclusively via
 * the dynamic import in material-factory.ts.
 */

import { MeshToonNodeMaterial, Color } from 'three/webgpu';
import type { Material, Texture } from 'three/webgpu';
import {
  attribute,
  clamp,
  float,
  materialColor,
  max,
  mix,
  select,
  uniform,
  vec3,
  vertexColor,
} from 'three/tsl';

/**
 * Shared recolor uniforms — ONE state object per toon manager; every toon
 * node material created with it references the same uniform nodes, so a
 * single `.value` write updates all materials (parity with the shared
 * `IUniform` objects on the GLSL side). Non-TSL callers (the toon manager)
 * only ever touch `.value`.
 */
export type ToonRecolorStateTsl = ReturnType<typeof createToonRecolorStateTsl>;

/** Create the shared recolor uniform state (defaults mirror the GLSL side). */
export function createToonRecolorStateTsl() {
  return {
    uMetalColor: uniform(new Color('#b0b4bc')),
    uMetalReflectivity: uniform(0.85),
    uAlbedoMinBright: uniform(0),
    uAlbedoMaxBright: uniform(1),
  };
}

/** Structural view of the source material properties the conversion copies.
 *  Covers MeshStandardMaterial AND the uber MeshStandardNodeMaterial. */
export interface ToonSourceMaterialLike extends Material {
  color?: Color;
  map?: Texture | null;
  normalMap?: Texture | null;
  normalScale?: { x: number; y: number };
  emissive?: Color;
  emissiveMap?: Texture | null;
  emissiveIntensity?: number;
  alphaMap?: Texture | null;
  metalness?: number;
  vertexColors: boolean;
}

export interface ToonMaterialTslOptions {
  /** The shared per-manager recolor state (see createToonRecolorStateTsl). */
  state: ToonRecolorStateTsl;
  /** Shared cel gradient ramp (bands×1 DataTexture). */
  gradientMap: Texture | null;
  /** True for the shared uber material — metalness comes from the per-vertex
   *  `rmPacked.y` attribute instead of the scalar `.metalness` (plan-271
   *  port coupling #1→#2). */
  isUber: boolean;
}

/**
 * Convert one source material to a cel-banded toon node material with the
 * metal tint + albedo grade recolor chain. Mirrors `_toToon()`'s property
 * copy (textures shared by reference) and shader patch.
 */
export function createToonMaterialTsl(
  src: ToonSourceMaterialLike,
  options: ToonMaterialTslOptions,
): Material {
  const { state, gradientMap, isUber } = options;

  const toon = new MeshToonNodeMaterial({
    color: src.color ? src.color.clone() : new Color(0xffffff),
    map: src.map ?? null,
    normalMap: src.normalMap ?? null,
    emissive: src.emissive ? src.emissive.clone() : new Color(0x000000),
    emissiveMap: src.emissiveMap ?? null,
    emissiveIntensity: src.emissiveIntensity ?? 1,
    alphaMap: src.alphaMap ?? null,
    transparent: src.transparent,
    opacity: src.opacity,
    alphaTest: src.alphaTest,
    side: src.side,
    gradientMap: gradientMap ?? null,
  });
  // Preserve depth behaviour (matters for the transparent ground plane).
  toon.depthWrite = src.depthWrite;
  toon.depthTest = src.depthTest;
  if (src.normalScale && toon.normalScale) {
    toon.normalScale.set(src.normalScale.x, src.normalScale.y);
  }

  const {
    uMetalColor: metalColor,
    uMetalReflectivity: metalReflectivity,
    uAlbedoMinBright: albedoMin,
    uAlbedoMaxBright: albedoMax,
  } = state;

  // Base colour = material colour × base-colour texture (materialColor node
  // reads both from the material) × vertex colour. The vertex colour is
  // folded in HERE (and vertexColors turned off below) so the grade runs
  // AFTER it — parity with the GLSL inject after <color_fragment>.
  let base = materialColor.rgb;
  if (src.vertexColors) {
    base = base.mul(vertexColor().rgb);
    toon.vertexColors = false; // handled in the chain above
  }

  // Albedo grade: remap brightness (max channel) into [min, max], hue kept;
  // a value-less pixel (pure black) lifts to neutral grey at the remapped
  // value instead of staying black.
  const v = max(base.r, max(base.g, base.b));
  const newV = albedoMin.add(v.mul(albedoMax.sub(albedoMin)));
  const graded = clamp(
    select(v.greaterThan(1e-4), base.mul(newV.div(max(v, float(1e-4)))), vec3(newV)),
    0,
    1,
  );

  // Metal tint: k = clamp(metalness × reflectivity, 0, 1); mixing the albedo
  // toward the metal colour is algebraically identical to the GLSL
  // outgoingLight mix (see module doc).
  const metalness = isUber ? attribute<'vec2'>('rmPacked', 'vec2').y : float(src.metalness ?? 0);
  const k = clamp(metalness.mul(metalReflectivity), 0, 1);
  toon.colorNode = mix(graded, metalColor, k);

  return toon;
}
