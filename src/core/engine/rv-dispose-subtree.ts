// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * The ONE traversal that frees a model subtree's GPU resources (plan-442).
 *
 * Three places tear a model root down, and they must agree on the delicate
 * parts or a shared buffer gets freed while something else still renders it:
 *
 *  - `RVViewer.clearModel()` — the regular model switch,
 *  - `loadGLB`'s `abortLoad()` — a load that was superseded mid-merge,
 *  - `RVViewer._loadModelInner()`'s latest-wins guard — a load that was
 *    superseded between `loadGLB` resolving and the root adoption.
 *
 * What is genuinely common is exactly this: walk the subtree, free every
 * geometry (CPU-side BVH first — `geometry.dispose()` only releases the GPU
 * buffers), and free every material ONCE. The dedup set matters because
 * material deduplication makes many meshes share one instance, and
 * `_rvShared` matters because fixtures like the uber-material singleton
 * outlive individual loads and are reused by the next one.
 *
 * What is NOT common stays with its owner and is deliberately not absorbed
 * here: `abortLoad` owns the `batchTable` and the compose `composition`,
 * `clearModel` owns the viewer's texture slots. Hence `onMaterial`, called for
 * each material this pass is actually about to dispose, rather than a boolean
 * flag that would encode one owner's policy into the shared primitive.
 */

import type { Material, Object3D } from 'three';

export interface DisposeModelSubtreeOptions {
  /**
   * Called once per material this pass frees — after the dedup and `_rvShared`
   * checks, before `material.dispose()`. The hook for owner-specific teardown
   * that has to happen while the material is still intact (texture slots).
   */
  onMaterial?: (material: Material) => void;
  /**
   * Dedup set to share across several roots torn down in ONE pass. Omit and
   * the call owns a fresh one.
   */
  disposedMaterials?: Set<Material>;
}

/** Free every geometry and material under `root`. Does not detach `root`. */
export function disposeModelSubtree(
  root: Object3D,
  options?: DisposeModelSubtreeOptions,
): void {
  const disposedMaterials = options?.disposedMaterials ?? new Set<Material>();
  const onMaterial = options?.onMaterial;
  root.traverse((node: Object3D) => {
    const mesh = node as unknown as {
      geometry?: { dispose(): void; disposeBoundsTree?: () => void };
      material?: Material | Material[];
    };
    if (mesh.geometry) {
      // Free the three-mesh-bvh tree explicitly — geometry.dispose() only
      // releases GPU buffers, the CPU-side BVH would otherwise linger as long
      // as anything still references the geometry object.
      mesh.geometry.disposeBoundsTree?.();
      mesh.geometry.dispose();
    }
    if (mesh.material) {
      const disposeMat = (m: Material): void => {
        if (disposedMaterials.has(m)) return;
        disposedMaterials.add(m);
        // Shared fixtures (e.g. the RVUberMaterial singleton) survive a model
        // teardown — they are reused by the next load.
        if (m.userData?._rvShared) return;
        onMaterial?.(m);
        m.dispose();
      };
      if (Array.isArray(mesh.material)) mesh.material.forEach(disposeMat);
      else disposeMat(mesh.material);
    }
  });
}
