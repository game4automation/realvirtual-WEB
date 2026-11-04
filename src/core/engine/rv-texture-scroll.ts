// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-texture-scroll.ts — the UV-scroll primitive shared by `TransportSurface`
 * and `RibbonPath` (plan-459, Phase 3).
 *
 * Extracted VERBATIM from `RVTransportSurface._initTextureAnimation()` /
 * `_updateLinearTexture()`: same clone-per-mesh model, same `RepeatWrapping`,
 * same "accumulate an offset, never rebuild geometry" contract. The conveyor's
 * behaviour is unchanged by construction — the regression proof is that
 * `transport-surface-direction.test.ts` and `transport-surface-centering.test.ts`
 * keep passing untouched.
 *
 * ## Why a texture clone and not a material clone
 *
 * `Texture.clone()` shares the `image` (the GPU upload) and copies only the
 * sampler state, so N conveyors carrying the same belt texture still cost ONE
 * upload while each scrolls independently. Cloning the material would duplicate
 * the whole PBR state and defeat the material dedup pass.
 *
 * The clones are owned by whoever created them: {@link disposeScrollableMaps}
 * exists because a `RibbonPath` builds a band material per model load, and a model
 * switch must give the clones back (the E2E leak check in plan §9.9 measures
 * `renderer.info.memory.textures`). `TransportSurface` deliberately does NOT
 * call it — it never did, and its clones are freed with the model teardown.
 */

import { RepeatWrapping } from 'three';
import type { Material, Object3D, Texture } from 'three';
import { traverseMeshes } from './rv-traverse-utils';

/** A material that may carry a scrollable colour map. */
interface MappedMaterial extends Material {
  map?: Texture | null;
}

/**
 * Clone every colour map under `root` into an independently scrollable texture,
 * write the clone back onto its material, and return the clones.
 *
 * Meshes without a `map` contribute nothing — the caller decides whether that is
 * a problem (a conveyor logs it; a `RibbonPath` falls back to a procedural texture
 * so the web is never a motionless grey ribbon).
 */
export function cloneScrollableMaps(root: Object3D): Texture[] {
  const maps: Texture[] = [];
  traverseMeshes(root, (mesh) => {
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const raw of mats) {
      const mat = raw as MappedMaterial;
      if (!mat?.map) continue;
      const tex = mat.map.clone();
      tex.wrapS = RepeatWrapping;
      tex.wrapT = RepeatWrapping;
      tex.needsUpdate = true;
      mat.map = tex;
      maps.push(tex);
    }
  });
  return maps;
}

/** Add `(du, dv)` to the offset of every map. Allocation-free. */
export function scrollMaps(maps: readonly Texture[], du: number, dv: number): void {
  for (const tex of maps) {
    tex.offset.x += du;
    tex.offset.y += dv;
  }
}

/** Reset every map offset to `(0, 0)` — the authored state after a reset. */
export function resetMapOffsets(maps: readonly Texture[]): void {
  for (const tex of maps) tex.offset.set(0, 0);
}

/** Dispose every clone. Only for owners that CREATED the clones (see header). */
export function disposeScrollableMaps(maps: Texture[]): void {
  for (const tex of maps) tex.dispose();
  maps.length = 0;
}

/** Map slots a scrolled material moves together (plan-675, SOL R1 #10). */
const SCROLL_SLOTS = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap'] as const;

/**
 * plan-675 (spike S1): clone a SHARED material for one owner together with its
 * maps, so the owner can scroll them without touching anybody else — the
 * template material and its maps stay exactly as they were. Every map slot is
 * cloned (one clone per distinct texture: an ORM texture in both the roughness
 * and the metalness slot stays ONE clone), `RepeatWrapping`, image shared (one
 * GPU upload). The caller owns material and maps and disposes them.
 *
 * Unlike {@link cloneScrollableMaps} this never writes into the source
 * material — that is what makes per-placement isolation possible on chunk
 * materials the bake shares between every instance of an asset.
 */
export function cloneMaterialWithScrollableMaps(source: Material): { material: Material; maps: Texture[] } {
  const material = source.clone();
  const slots = material as unknown as Record<string, Texture | null | undefined>;
  const cloneOf = new Map<Texture, Texture>();
  const maps: Texture[] = [];
  for (const slot of SCROLL_SLOTS) {
    const src = slots[slot];
    if (!src) continue;
    let tex = cloneOf.get(src);
    if (!tex) {
      tex = src.clone();
      tex.wrapS = RepeatWrapping;
      tex.wrapT = RepeatWrapping;
      if (src.image) tex.needsUpdate = true;
      cloneOf.set(src, tex);
      maps.push(tex);
    }
    slots[slot] = tex;
  }
  return { material, maps };
}
