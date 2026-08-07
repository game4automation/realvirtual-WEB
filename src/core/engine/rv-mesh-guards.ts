// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-mesh-guards — the shared structural predicate for operations that rebuild a
 * `BufferGeometry` attribute by attribute (plan-331).
 *
 * The list below is not a taste question: it enumerates exactly the mesh shapes that
 * cannot be copied losslessly by walking `geometry.attributes` with
 * `getComponent` / `setComponent`.
 *
 * - **Instanced / skinned meshes** carry per-instance or per-bone state outside the
 *   geometry; splitting the geometry alone silently drops it.
 * - **Skinning / morph attributes** live in `morphAttributes` (a separate map) and in
 *   `skinIndex` / `skinWeight`, which index bone tables that a partition does not remap.
 * - **Interleaved attributes** share one buffer across attributes with a stride; a
 *   per-attribute copy would either alias or explode them.
 *
 * This module deliberately contains **only** the shared predicate. The two
 * mode-specific guards (`islandModeIneligibility`, `groupModeIneligibility`) live next
 * to the algorithm in `src/core/editor/rv-mesh-separator.ts`, because one of them has to
 * run the island analysis and the engine layer must not depend on the editor layer.
 */

import type { BufferGeometry, Mesh } from 'three';

/** Instanced or skinned mesh — per-instance / per-bone state lives outside the geometry. */
export const MESH_GUARD_INSTANCED_SKINNED = 'Instanced and skinned meshes cannot be separated';

/** Skinning or morph attributes — bone tables and morph targets are not remapped. */
export const MESH_GUARD_SKIN_MORPH = 'Meshes with skinning or morph targets cannot be separated';

/** Interleaved attributes — one shared buffer with a stride cannot be copied per attribute. */
export const MESH_GUARD_INTERLEAVED = 'Interleaved geometry is not supported';

/** No position attribute — nothing to weld, nothing to partition. */
export const MESH_GUARD_NO_POSITION = 'Mesh geometry has no position attribute';

interface MaybeInterleaved {
  isInterleavedBufferAttribute?: boolean;
}

interface MaybeExoticMesh {
  isInstancedMesh?: boolean;
  isSkinnedMesh?: boolean;
}

/**
 * Returns why a geometry cannot be rebuilt attribute by attribute, or `null` when it can.
 *
 * Geometry-level half of the predicate — used directly by the worker path, which never
 * sees an `Object3D`.
 */
export function unsupportedGeometryShapeReason(geom: BufferGeometry | null | undefined): string | null {
  if (!geom) return MESH_GUARD_NO_POSITION;

  const attributes = geom.attributes ?? {};
  if (attributes.skinIndex || attributes.skinWeight) return MESH_GUARD_SKIN_MORPH;
  if (geom.morphAttributes && Object.keys(geom.morphAttributes).length > 0) return MESH_GUARD_SKIN_MORPH;

  for (const key of Object.keys(attributes)) {
    if ((attributes[key] as unknown as MaybeInterleaved)?.isInterleavedBufferAttribute === true) {
      return MESH_GUARD_INTERLEAVED;
    }
  }
  if ((geom.index as unknown as MaybeInterleaved | null)?.isInterleavedBufferAttribute === true) {
    return MESH_GUARD_INTERLEAVED;
  }

  if (!attributes.position) return MESH_GUARD_NO_POSITION;

  return null;
}

/**
 * Returns why a mesh cannot be rebuilt attribute by attribute, or `null` when it can.
 *
 * Checked in the order documented in plan-331 section 2.4: the object-level flags first
 * (they are the coarsest statement), then the geometry-level shape.
 */
export function unsupportedMeshShapeReason(mesh: Mesh | null | undefined): string | null {
  if (!mesh) return MESH_GUARD_NO_POSITION;

  const exotic = mesh as unknown as MaybeExoticMesh;
  if (exotic.isInstancedMesh === true || exotic.isSkinnedMesh === true) {
    return MESH_GUARD_INSTANCED_SKINNED;
  }

  return unsupportedGeometryShapeReason(mesh.geometry as BufferGeometry | undefined);
}
