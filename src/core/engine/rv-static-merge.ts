// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { Object3D, Mesh, Material, Matrix4, BufferGeometry } from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export interface StaticMergeResult {
  /** Number of original static meshes that were merged */
  originalCount: number;
  /** Number of merged meshes created */
  mergedCount: number;
}

/**
 * Merge static meshes that share the same material into combined meshes.
 *
 * Static meshes are identified by `matrixAutoUpdate === false` (set during
 * scene load for meshes NOT under Drive nodes). Original meshes are hidden
 * (visible = false) but kept in the scene graph so that hierarchy highlight
 * and focusByPath continue to work via traverse.
 *
 * Must run AFTER material deduplication (grouping relies on material identity).
 */
export function mergeStaticGeometries(
  root: Object3D,
  driveNodeSet: Set<Object3D>,
  transportSurfaceNodeSet: Set<Object3D>,
): StaticMergeResult {
  // Collect static meshes, grouped by material instance
  const materialGroups = new Map<Material, Mesh[]>();
  let originalCount = 0;

  root.traverse((node) => {
    if (!(node as Mesh).isMesh) return;
    const mesh = node as Mesh;

    // Skip dynamic meshes (under drive, except transport surfaces)
    if (mesh.matrixAutoUpdate !== false) return;

    // Skip transparent meshes (depth-sort incompatible with opaque merge)
    const mat = mesh.material as Material & {
      transparent?: boolean;
      alphaTest?: number;
      opacity?: number;
    };
    if (Array.isArray(mesh.material)) return; // Skip multi-material meshes
    if (mat.transparent === true) return;
    if ((mat.alphaTest ?? 0) > 0) return;
    if ((mat.opacity ?? 1) < 1) return;

    // Skip meshes with special render order
    if (mesh.renderOrder !== 0) return;

    // Skip sensor viz meshes
    if (mesh.name.endsWith('_sensorViz')) return;

    // Skip highlight overlays
    if (mesh.userData?._highlightOverlay) return;

    // Skip tank meshes (need individual materials for fill visualization)
    if (mesh.userData?._tankFillViz) return;
    if (mesh.userData?._rvType === 'Tank') return;
    // Walk up one level: mesh may be a child of a tank node
    if (mesh.parent?.userData?._rvType === 'Tank') return;

    // Skip pipe meshes — same reason: PipeFlowManager overlays need the
    // original mesh rendered (not merged) and ProcessIndustryPlugin needs to
    // swap per-pipe materials at runtime for fluid-based coloring.
    if (mesh.userData?._pipeFlowViz) return;
    if (mesh.userData?._rvType === 'Pipe') return;
    if (mesh.parent?.userData?._rvType === 'Pipe') return;

    // Must have geometry with position attribute
    if (!mesh.geometry?.attributes?.position) return;

    originalCount++;
    const group = materialGroups.get(mat) ?? [];
    group.push(mesh);
    materialGroups.set(mat, group);
  });

  // Merge each group
  let mergedCount = 0;
  const _tmpMat4 = new Matrix4();

  for (const [material, meshes] of materialGroups) {
    // Only merge groups with 2+ meshes (single mesh gains nothing)
    if (meshes.length < 2) continue;

    // Validate attribute compatibility: all meshes in the group must have
    // the same set of attribute keys, otherwise mergeGeometries fails silently
    const refAttrs = new Set(Object.keys(meshes[0].geometry.attributes));
    const compatible = meshes.filter((m) => {
      const attrs = Object.keys(m.geometry.attributes);
      if (attrs.length !== refAttrs.size) return false;
      return attrs.every((a) => refAttrs.has(a));
    });
    if (compatible.length < 2) continue;

    // Transform geometries to world space (clone to avoid mutating originals)
    const transformed: BufferGeometry[] = [];
    for (const mesh of compatible) {
      mesh.updateWorldMatrix(true, false);
      const clone = mesh.geometry.clone();
      clone.applyMatrix4(mesh.matrixWorld);
      transformed.push(clone);
    }

    // Merge
    const merged = mergeGeometries(transformed, false);
    if (!merged) {
      // Dispose clones on failure
      for (const g of transformed) g.dispose();
      continue;
    }

    // Dispose temporary clones (merged geometry has its own buffers)
    for (const g of transformed) g.dispose();

    // Create merged mesh
    const mergedMesh = new Mesh(merged, material);
    mergedMesh.name = `__staticMerge_${mergedCount}`;
    mergedMesh.castShadow = true;
    mergedMesh.receiveShadow = true;
    mergedMesh.matrixAutoUpdate = false;
    mergedMesh.frustumCulled = true;
    // Not interactive — skip raycasting
    mergedMesh.raycast = () => {};
    mergedMesh.userData._staticMerged = true;

    // Add merged mesh to root
    root.add(mergedMesh);
    mergedCount++;

    // Hide original meshes (keep in scene graph for highlight/focus)
    for (const mesh of compatible) {
      mesh.visible = false;
    }
  }

  if (mergedCount > 0) {
    console.log(
      `[StaticMerge] ${originalCount} static meshes → ${mergedCount} merged (${originalCount - mergedCount} draw calls saved)`
    );
  }

  return { originalCount, mergedCount };
}
