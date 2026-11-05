// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-pick-utils.ts — the shared pick predicates.
 *
 * What survived of the merged face-range pick geometry (plan-753 Phase 4b
 * deleted `rv-raycast-geometry.ts`): the ONE mesh filter every pick
 * representation applies — the bake (`rv-bake-pipeline.ts`), the in-place
 * registry (`rv-bake-registry.ts`) and the editor instance pick index
 * (`rv-instance-pick-index.ts`) — plus the two ancestor helpers the
 * resolution tail of the raycast manager and the editor share.
 */

import type { Material, Mesh, Object3D } from 'three';
import { getCapabilities } from './rv-component-registry';
import type { NodeRegistry } from './rv-node-registry';

// ─── Content ancestor resolution ────────────────────────────────────

/**
 * Walk up the parent chain from `node` to find the nearest ancestor
 * (including `node` itself) that has a **hoverable** component type
 * in its `userData.realvirtual`. Returns its NodeRegistry path, or null.
 *
 * This ensures that raycast hits resolve to interactive nodes (Drive,
 * Sensor, AASLink, etc.) rather than structural containers (Group,
 * Kinematic) that happen to have rv_extras.
 *
 * CADLink is treated as a container marker, not an interaction target:
 * when the nearest hoverable ancestor is hoverable ONLY through CADLink,
 * the hit resolves to the mesh's own path so nested CAD parts stay
 * individually pickable (editor per-part selection). Planner scenes are
 * unaffected — the LayoutObject ancestor override still bubbles placed
 * assets to their root. A CADLink root that also carries another hoverable
 * component (e.g. user-added Metadata) remains a normal bubble target.
 */
export function findContentAncestor(
  node: Object3D,
  registry: NodeRegistry,
): string | null {
  let current: Object3D | null = node;
  while (current) {
    const rv = current.userData?.realvirtual;
    if (rv && typeof rv === 'object') {
      const keys = Object.keys(rv as object);
      if (keys.length > 0) {
        // Check if any component type on this node is hoverable
        const hoverableKeys = keys.filter(k => getCapabilities(k).pick !== 'none');
        const rvType = current.userData._rvType as string | undefined;
        const rvTypeHoverable = !!rvType && getCapabilities(rvType).pick !== 'none';
        if (hoverableKeys.length > 0 || rvTypeHoverable) {
          const onlyCadLink =
            hoverableKeys.every(k => k === 'CADLink')
            && (!rvTypeHoverable || rvType === 'CADLink')
            && (hoverableKeys.length > 0 || rvType === 'CADLink');
          if (onlyCadLink) {
            const meshPath = registry.getPathForNode(node);
            if (meshPath) return meshPath;
            // Unregistered mesh — fall back to the CADLink root below.
          }
          const path = registry.getPathForNode(current);
          if (path) return path;
        }
      }
    }
    current = current.parent;
  }
  return null;
}

// ─── Shared pickable-mesh predicate ─────────────────────────────────

/**
 * The ONE filter deciding whether a mesh participates in pick geometry.
 * Shared by the bake (chunk windows + in-place keep meshes) and the editor
 * instance pick index — keep every exclusion here so the representations
 * can never drift apart.
 *
 * NOT covered here (context-dependent, applied by the callers):
 * authored-hidden (`rv.Hidden`) subtree inheritance.
 */
export function isPickableMesh(mesh: Mesh): boolean {
  // Pipeline outputs are never sources.
  if (mesh.userData?._rvBakeChunk) return false;
  // Overlay / visualization meshes.
  if (mesh.userData?._highlightOverlay) return false;
  if (mesh.userData?._driveHoverOverlay) return false;
  if (mesh.name.endsWith('_sensorViz')) return false;
  if (mesh.name === '_tankFillViz') return false;
  // Must have geometry.
  if (!mesh.geometry?.attributes?.position) return false;
  // Skinned/morphed meshes deform on the GPU — a static BVH would lie.
  if ((mesh as Mesh & { skeleton?: unknown }).skeleton) return false;
  if (mesh.morphTargetInfluences && mesh.morphTargetInfluences.length > 0) return false;
  return true;
}

/**
 * Does ownerless geometry OCCLUDE a pick (plan-756 Q5)? The one place the rule
 * lives (chunks and keep meshes): opaque unless `transparent`, `alphaTest` or
 * `opacity` < 1; an array blocks only if every entry does (pick the hit
 * face's entry with {@link faceMaterial} first).
 */
export function materialBlocks(material: Material | Material[]): boolean {
  if (Array.isArray(material)) {
    for (let i = 0; i < material.length; i++) if (!materialBlocks(material[i])) return false;
    return material.length > 0;
  }
  const m = material as Material & { opacity?: number; alphaTest?: number };
  if (m.transparent === true) return false;
  if ((m.alphaTest ?? 0) > 0) return false;
  if ((m.opacity ?? 1) < 1) return false;
  return true;
}

/** The material of triangle `faceIndex` (its geometry group); the whole array when unknown. */
export function faceMaterial(
  material: Material | Material[],
  groups: readonly { start: number; count: number; materialIndex?: number }[],
  faceIndex: number,
): Material | Material[] {
  if (!Array.isArray(material) || faceIndex < 0) return material;
  const i = faceIndex * 3;
  for (let g = 0; g < groups.length; g++) {
    const gr = groups[g];
    if (i >= gr.start && i < gr.start + gr.count) return material[gr.materialIndex ?? 0] ?? material;
  }
  return material;
}

/** Authored hidden flag (editor eye toggle / `rv.Hidden` in the GLB). Keyed on
 *  the extras flag, NEVER on `.visible` — a baked source mesh is masked, not
 *  hidden, and stays the pick target. Exported for the editor instance pick
 *  index's per-pick visibility walk. */
export function isAuthoredHidden(node: Object3D): boolean {
  return (node.userData?.realvirtual as Record<string, unknown> | undefined)?.Hidden === true;
}
