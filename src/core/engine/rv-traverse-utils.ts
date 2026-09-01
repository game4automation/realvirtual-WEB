// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-traverse-utils.ts — Small reusable Object3D traversal helpers.
 *
 * The `node.traverse(c => { if (!(c as Mesh).isMesh) return; ... })` pattern
 * appears in 30+ files. `traverseMeshes()` makes the intent explicit and
 * eliminates the `as Mesh` cast boilerplate at every call site.
 */

import { Box3, Vector3, type Material, type Object3D } from 'three';
import { Mesh } from 'three';

// ─── Runtime-rig markers (plan-362, EnergyChain) ─────────────────
//
// An EnergyChain rig replaces a static CAD subtree with runtime sidecars:
// one SkinnedMesh per source mesh, the deactivated originals, and one
// invisible picking-proxy hull. Several scene-wide pipelines walk EVERY mesh
// (material dedup, uber-material bake, layout-planner aux raycast targets) and
// must not treat those sidecars as ordinary geometry. The markers live here —
// next to the traversal helpers those pipelines already import — so no
// pipeline needs to depend on the EnergyChain module itself.

/** `userData` flag on the invisible EnergyChain picking-proxy hull. */
export const RV_CHAIN_PROXY = '_rvEnergyChainProxy';
/** `userData` flag on a runtime `SkinnedMesh` sidecar created by an EnergyChain rig. */
export const RV_CHAIN_SKIN = '_rvEnergyChainSkin';
/** `userData` flag on an original CAD mesh that a rig deactivated and shadowed. */
export const RV_CHAIN_SOURCE = '_rvEnergyChainSource';
/**
 * `userData` copy of an original mesh's AUTHORED `visible` flag, kept next to
 * {@link RV_CHAIN_SOURCE}. The export clone has no access to the live component,
 * so this is how it knows whether restoring the mesh means showing it — an
 * author who deliberately hid a part must not have it reappear in the file.
 */
export const RV_CHAIN_SOURCE_VISIBLE = '_rvEnergyChainSourceVisible';

// ─── Runtime-element marker (plan-733, Chain) ────────────────────
//
// Unrelated to the EnergyChain markers above despite the neighbouring name: a
// `Chain` clones its element template `NumberOfElements` times at load. The
// marker lives here for the same reason as the ones above — the asset exporter's
// prune pass must recognise the clones without importing the component module
// (which would pull the whole component-registry side-effect chain into the
// editor's export path).

/** `userData` flag on every runtime element clone built by an `RVChain`. */
export const RV_CHAIN_ELEMENT = '_rvChainElement';

/**
 * True when a mesh belongs to a runtime deformation rig and must be kept out
 * of the material-collapsing pipelines (`deduplicateMaterials`,
 * `applyUberMaterial`).
 *
 * Two independent reasons:
 *   - a `SkinnedMesh` carries per-vertex skin attributes; the uber bake writes
 *     shared per-vertex color/rmPacked attributes and may swap the geometry
 *     for a cached clone, which would silently drop the skin binding;
 *   - the picking proxy is invisible bookkeeping geometry that should never
 *     contribute a material at all;
 *   - the deactivated original shares its geometry with the SkinnedMesh, so
 *     baking it in place would write into the skinned geometry as a side
 *     effect, and `dispose()` must be able to hand back exactly what it took.
 */
export function isRuntimeRigMesh(node: Object3D): boolean {
  const ud = node.userData as Record<string, unknown> | undefined;
  if (ud?.[RV_CHAIN_PROXY] === true || ud?.[RV_CHAIN_SOURCE] === true) return true;
  return (node as unknown as { isSkinnedMesh?: boolean }).isSkinnedMesh === true;
}

/**
 * True when a mesh is a rig sidecar that must NOT become a raycast target:
 * the SkinnedMesh (CPU skin raycast is slow and the proxy already covers the
 * chain) and the deactivated original (it sits frozen in the rest pose). The
 * picking proxy itself deliberately does NOT match — it is the one target the
 * planner drop path should register.
 */
export function isRigRaycastExcluded(node: Object3D): boolean {
  const ud = node.userData as Record<string, unknown> | undefined;
  if (ud?.[RV_CHAIN_SKIN] === true || ud?.[RV_CHAIN_SOURCE] === true) return true;
  return (node as unknown as { isSkinnedMesh?: boolean }).isSkinnedMesh === true;
}

/**
 * Traverse `root` and invoke `cb` for every descendant (and `root` itself,
 * if it is a `Mesh`). Skips non-Mesh nodes.
 *
 * Equivalent to:
 * ```ts
 * root.traverse((c) => { if (!(c as Mesh).isMesh) return; cb(c as Mesh); });
 * ```
 *
 * The `isMesh` runtime check is preserved (not just `instanceof Mesh`) because
 * Three.js uses duck-typed flags on Object3D subclasses and the existing code
 * relied on that behavior.
 */
export function traverseMeshes(root: Object3D, cb: (mesh: Mesh) => void): void {
  root.traverse((child) => {
    if ((child as Mesh).isMesh) {
      cb(child as Mesh);
    }
  });
}

/**
 * Precise geometric center of a subtree: the average of every world-space
 * mesh vertex under `node` (including `node` itself). Unlike the AABB center
 * this is not inflated by rotated bounding boxes and reflects the actual
 * vertex distribution of the geometry. Returns null when the subtree carries
 * no vertices.
 */
export function computeSubtreeVertexCenter(node: Object3D, target?: Vector3): Vector3 | null {
  const sum = target ?? new Vector3();
  sum.set(0, 0, 0);
  let count = 0;
  const v = new Vector3();
  node.updateMatrixWorld(true);
  traverseMeshes(node, (mesh) => {
    const pos = mesh.geometry?.getAttribute('position');
    if (!pos) return;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
      sum.add(v);
      count++;
    }
  });
  if (count === 0) return null;
  return sum.divideScalar(count);
}

/**
 * Traverse `root` and invoke `cb(mesh, depth)` for every descendant `Mesh`
 * whose depth (parent-hops back to `root`) is `<= maxDepth`. Meshes deeper
 * than `maxDepth` are skipped silently; a single console.warn (prefixed with
 * `prefix`) is emitted the first time the depth limit is exceeded.
 *
 * This consolidates a repeated pattern in `rv-gizmo-manager.ts` where three
 * shape builders (`_buildMeshOverlay`, `_buildMeshEdges`, `_buildMeshGlowHull`)
 * each duplicated:
 *
 * ```ts
 * let depth = 0;
 * let overDepthWarned = false;
 * node.traverse((child) => {
 *   depth = 0;
 *   let cur = child;
 *   while (cur && cur !== node) { depth++; cur = cur.parent; }
 *   if (depth > MAX_OVERLAY_DEPTH) {
 *     if (!overDepthWarned) { console.warn(...); overDepthWarned = true; }
 *     return;
 *   }
 *   if (!(child as Mesh).isMesh) return;
 *   ...
 * });
 * ```
 *
 * The depth count and iteration order match the original Three.js
 * `traverse()` semantics exactly: depth is computed by walking
 * `parent` pointers back to `root`; the `root` itself has depth `0` and
 * is iterated if it is a Mesh.
 *
 * The `cb` only fires for Mesh descendants with a defined `geometry`
 * (matches the original guard at every call site).
 */
export function traverseMeshesWithDepth(
  root: Object3D,
  maxDepth: number,
  cb: (mesh: Mesh, depth: number) => void,
  prefix = '[traverseMeshesWithDepth]',
): void {
  let overDepthWarned = false;
  root.traverse((child) => {
    // Cheap depth gate (approximate — same logic as the inlined original)
    let depth = 0;
    let cur: Object3D | null = child;
    while (cur && cur !== root) {
      depth++;
      cur = cur.parent;
    }
    if (depth > maxDepth) {
      if (!overDepthWarned) {
        console.warn(`${prefix} exceeded depth ${maxDepth}; skipping deeper meshes`);
        overDepthWarned = true;
      }
      return;
    }
    const m = child as Mesh;
    if (!m.isMesh || !m.geometry) return;
    cb(m, depth);
  });
}

/**
 * Compute the axis-aligned bounding box of all `Mesh` descendants of `node`,
 * including geometry transforms. Lights, Cameras, Groups, and other non-Mesh
 * children are skipped.
 *
 * The returned object exposes `box` plus pre-computed `size` and `center`
 * Vector3s for convenience. When no mesh descendants exist, the box falls
 * back to a `0.1 × 0.1 × 0.1` cube centered on the node's world position.
 * Each component of `size` is clamped to at least `0.001` to avoid
 * zero-scale traps when the result is used as a Three.js scale.
 *
 * The `target` parameter may be passed to reuse a pre-allocated `Box3`
 * (GC avoidance for callers in hot paths); `size` and `center` are always
 * fresh `Vector3` instances on return.
 */
export function computeSubtreeAABB(
  node: Object3D,
  target?: Box3,
): { box: Box3; size: Vector3; center: Vector3 } {
  const box = target ?? new Box3();
  box.makeEmpty();
  let hasAny = false;
  node.traverse((child) => {
    const asMesh = child as Mesh;
    if (asMesh.isMesh && asMesh.geometry) {
      box.expandByObject(asMesh);
      hasAny = true;
    }
  });
  if (!hasAny) {
    // Fallback: use node world position as center with minimal size
    const pos = new Vector3();
    node.getWorldPosition(pos);
    box.setFromCenterAndSize(pos, new Vector3(0.1, 0.1, 0.1));
  }
  const size = new Vector3();
  box.getSize(size);
  if (size.x < 0.001) size.x = 0.001;
  if (size.y < 0.001) size.y = 0.001;
  if (size.z < 0.001) size.z = 0.001;
  const center = new Vector3();
  box.getCenter(center);
  return { box, size, center };
}

/**
 * Dispose geometry and materials on all Mesh nodes in a subtree.
 * Uses a Set to prevent double-dispose of shared resources.
 * Does NOT remove root from scene — caller is responsible.
 */
export function disposeSubtree(root: Object3D): void {
  const disposed = new Set<unknown>();
  root.traverse((node) => {
    const m = node as Mesh;
    if (m.geometry && !disposed.has(m.geometry)) {
      disposed.add(m.geometry);
      m.geometry.dispose();
    }
    if (m.material) {
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      for (const mat of mats) {
        if (mat && !disposed.has(mat)) {
          disposed.add(mat);
          (mat as Material).dispose();
        }
      }
    }
  });
}
