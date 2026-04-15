// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Static batching fast path for uber-baked meshes.
 *
 * After `applyUberMaterial` runs, every uber-eligible mesh in the scene
 * shares:
 *   - the same material reference (the RVUberMaterial singleton)
 *   - the same canonical attribute layout (position + normal + color + rmPacked)
 *
 * That's exactly what `mergeGeometries()` needs to collapse N meshes into
 * one draw call. This module implements a narrow specialization of static
 * geometry merging that ONLY handles the uber case — it doesn't try to
 * generalize over arbitrary materials, doesn't deal with multi-material
 * meshes, and doesn't implement picking on the merged result. Picking stays
 * on the original (now hidden) meshes so NodeRegistry paths keep resolving.
 *
 * The general-purpose `rv-static-merge.ts` path remains disabled (Phase 4
 * scope) — this fast path is enough to take the entire untextured-static
 * portion of most scenes down to a single draw call.
 */

import {
  Object3D,
  Mesh,
  BufferGeometry,
  Matrix4,
  Vector3,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { debug } from './rv-debug';
import type { RVUberMaterial } from './rv-uber-material';

export interface StaticUberMergeResult {
  /** Number of uber-baked static meshes that were candidates for merging */
  originalCount: number;
  /** Number of merged chunk meshes created (1 for small scenes, N for huge ones) */
  mergedCount: number;
  /** Total vertex count across all merged chunks (for diagnostics / memory budgeting) */
  totalVertices: number;
}

/** Attribute names the uber material cares about — everything else is stripped pre-merge. */
const UBER_ATTRIBUTES = new Set(['position', 'normal', 'color', 'rmPacked']);

/**
 * Per-chunk vertex budget. The merge splits into multiple chunks when the
 * total vertex count exceeds this, so:
 *   - each chunk's VBO stays reasonably sized for GPU memory managers
 *   - three.js frustum culling can cull individual chunks when the user
 *     zooms into a small area of a big scene (one-mesh merges can't be
 *     partially culled — all-or-nothing)
 *   - the shadow pass processes only chunks that are inside the shadow
 *     camera frustum
 *
 * 500k verts / chunk → ~20 MB per chunk (position + normal + color + rmPacked
 * all at normalized byte precision for color/rmPacked, 32-bit float for
 * position/normal). For a 37 000-mesh factory scene with ~20 M verts, that's
 * around 40 chunks — still 99.9 % fewer draws than per-mesh and gives the
 * GPU much better culling opportunities than one mega-mesh.
 */
const CHUNK_VERTEX_BUDGET = 500_000;

/**
 * Merge every static uber-baked mesh under `root` into a single mesh that
 * uses the shared uber material. Original meshes are hidden (`visible = false`)
 * but kept in the scene graph so NodeRegistry path resolution, highlight,
 * and focus-by-path continue to work exactly as before.
 *
 * The merged mesh:
 *   - is added as a child of `root` in root's local space (works even if the
 *     glTF scene root has a non-identity transform)
 *   - is not pickable (`raycast = () => {}`) — picking resolves to the hidden
 *     originals via the NodeRegistry
 *   - is marked `_rvSkipBVH = true` so `computeBVH()` skips it (saves work
 *     computing a BVH that will never be queried)
 *   - casts AND receives shadows. Plan-094 deliberately disabled `castShadow`
 *     on individual static meshes to avoid paying for tens of thousands of
 *     shadow-pass draws. Because the merge collapses all of them into ONE
 *     mesh, casting from the merged mesh is a single extra draw into the
 *     shadow map — cheap, and the user gets shadows from walls, frames,
 *     and factory structure again.
 *   - has `matrixAutoUpdate = false` (never moves)
 */
export function mergeStaticUberMeshes(
  root: Object3D,
  sharedUber: RVUberMaterial,
  chunkVertexBudget: number = CHUNK_VERTEX_BUDGET,
): StaticUberMergeResult {
  // Collect uber-baked static meshes that are safe to merge.
  const candidates: Mesh[] = [];
  root.traverse((node) => {
    if (!(node as Mesh).isMesh) return;
    const mesh = node as Mesh;

    // Must be uber-baked — this is the whole point of the fast path
    if (!mesh.userData?._rvUberBaked) return;
    // Must reference the shared singleton (array-material meshes can never
    // reach this branch because applyUberMaterial skips them)
    if (mesh.material !== sharedUber) return;
    // Must be static — dynamic meshes (under a Drive) have matrixAutoUpdate = true
    if (mesh.matrixAutoUpdate !== false) return;
    // Must have usable geometry
    if (!mesh.geometry?.attributes?.position) return;
    // Skip anything already hidden (e.g. the source meshes from a previous
    // merge pass, in case this function is called twice — idempotent re-run).
    if (!mesh.visible) return;
    // Skip meshes under an invisible ancestor (e.g. Source/MU templates
    // hidden via node.visible = false on their parent Object3D).
    let ancestor = mesh.parent;
    let ancestorHidden = false;
    while (ancestor) {
      if (!ancestor.visible) { ancestorHidden = true; break; }
      ancestor = ancestor.parent;
    }
    if (ancestorHidden) return;
    // Defensive: skip anything already merged, skinned, or morphed
    if (mesh.userData?._rvStaticUberMerged) return;
    if ((mesh as Mesh & { skeleton?: unknown }).skeleton) return;
    if (mesh.morphTargetInfluences && mesh.morphTargetInfluences.length > 0) return;

    candidates.push(mesh);
  });

  // Need at least 2 meshes to make merging worthwhile (1 mesh = same draw call)
  if (candidates.length < 2) {
    return { originalCount: candidates.length, mergedCount: 0, totalVertices: 0 };
  }

  // Normalize geometries into a common shape that mergeGeometries() accepts:
  //   1. clone (never mutate source buffers — other meshes may share them)
  //   2. harmonize indexed/non-indexed state across the batch. GLTFLoader
  //      output is almost always indexed, so we preserve indices when every
  //      input has one (huge memory win — non-indexed bloats a typical cube
  //      from 24 verts to 36). If even one input is non-indexed we fall back
  //      to converting all of them, because mergeGeometries() requires
  //      all-or-none.
  //   3. strip attributes the uber shader doesn't read (any stray uv/uv2/tangent)
  //   4. compute normals if missing
  //   5. bake into root's local space so the merged mesh renders correctly
  //      regardless of root's transform
  root.updateWorldMatrix(true, false);
  const rootInverse = new Matrix4().copy(root.matrixWorld).invert();

  // Decide once whether we can keep indices or must drop them. Scanning is
  // O(N) but tiny compared to the merge itself.
  let keepIndexed = true;
  for (const mesh of candidates) {
    if (!mesh.geometry.index) { keepIndexed = false; break; }
  }

  // Spatial ordering for chunk coherence: sort candidates by their
  // world-space centroid X. Not perfect (a Morton / Z-curve would be
  // better) but cheap and meaningfully better than insertion order for
  // frustum-culling chunks that are spatial slabs across the scene.
  const centroidCache = new Map<Mesh, number>();
  const _tmpCenter = new Vector3();
  for (const mesh of candidates) {
    mesh.updateWorldMatrix(true, false);
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
    mesh.geometry.boundingBox!.getCenter(_tmpCenter).applyMatrix4(mesh.matrixWorld);
    centroidCache.set(mesh, _tmpCenter.x);
  }
  candidates.sort((a, b) => centroidCache.get(a)! - centroidCache.get(b)!);

  // Normalize every clone into a common attribute layout + root-local
  // coordinates, then pack them into chunks by vertex budget.
  const normalize = (mesh: Mesh): BufferGeometry => {
    let geom = mesh.geometry.clone();
    if (!keepIndexed && geom.index) {
      const nonIndexed = geom.toNonIndexed();
      geom.dispose();
      geom = nonIndexed;
    }
    // Drop attributes the uber material doesn't use so every clone shares
    // the exact same attribute set (mergeGeometries fails silently if the
    // keys differ across inputs).
    for (const name of Object.keys(geom.attributes)) {
      if (!UBER_ATTRIBUTES.has(name)) geom.deleteAttribute(name);
    }
    // A few legacy GLBs ship without normals — compute them so lighting
    // stays correct on the merged output.
    if (!geom.attributes.normal) geom.computeVertexNormals();
    // Bake world-space positions, then transform back into root's local
    // space so the merged mesh (child of root) renders at the right place.
    geom.applyMatrix4(mesh.matrixWorld);
    geom.applyMatrix4(rootInverse);
    return geom;
  };

  // Pack candidates into chunks. Each chunk accumulates clones until
  // adding the next one would exceed CHUNK_VERTEX_BUDGET — then it's
  // finalized and we start a new chunk. A chunk always gets at least one
  // clone even if that single clone exceeds the budget (a single 800k-vert
  // mesh still works, we just don't further split it).
  const mergedMeshes: Mesh[] = [];
  let currentChunk: BufferGeometry[] = [];
  let currentChunkVerts = 0;
  let totalVertices = 0;

  const finalizeChunk = (): void => {
    if (currentChunk.length === 0) return;
    const merged = mergeGeometries(currentChunk, false);
    for (const g of currentChunk) g.dispose();
    currentChunk = [];
    currentChunkVerts = 0;
    if (!merged) {
      debug('loader', '[StaticUberMerge] mergeGeometries returned null for a chunk — skipping');
      return;
    }
    const mesh = new Mesh(merged, sharedUber);
    mesh.name = `__staticUberMerge_${mergedMeshes.length}`;
    // The whole point of the merge: N static source meshes become one chunk
    // per spatial slab. Casting shadows from each chunk is one extra draw
    // into the shadow map — cheap, and the user gets shadows from walls,
    // frames, and factory structure again.
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.frustumCulled = true;
    // Not interactive — picks resolve to the hidden originals via NodeRegistry
    mesh.raycast = () => {};
    mesh.userData._rvStaticUberMerged = true;
    mesh.userData._rvSkipBVH = true; // see computeBVH() in rv-scene-loader
    root.add(mesh);
    mergedMeshes.push(mesh);
    if (merged.attributes?.position) {
      totalVertices += merged.attributes.position.count;
    }
  };

  for (const mesh of candidates) {
    const normalized = normalize(mesh);
    const verts = normalized.attributes.position.count;
    // If this clone alone would blow the budget AND the current chunk
    // already has something, finalize first so the big mesh gets its own
    // chunk. Otherwise just append.
    if (currentChunkVerts + verts > chunkVertexBudget && currentChunk.length > 0) {
      finalizeChunk();
    }
    currentChunk.push(normalized);
    currentChunkVerts += verts;
  }
  finalizeChunk();

  if (mergedMeshes.length === 0) {
    return { originalCount: candidates.length, mergedCount: 0, totalVertices: 0 };
  }

  // Hide the source meshes but keep them in the scene graph so NodeRegistry,
  // highlight-by-path, focus-by-path, and the hierarchy browser all continue
  // to operate on the original paths without any adapter layer.
  for (const mesh of candidates) {
    mesh.visible = false;
    mesh.userData._rvStaticUberSource = true;
  }

  // Diagnostic: compute a union bbox over every chunk (root-local AND
  // world space), plus a full breakdown of shadow casters in the scene.
  // Once per load, always on — our eyes-on-the-ground for shadow bugs.
  root.updateMatrixWorld(true);
  // Union of per-chunk bounding boxes in root-local and world space
  const localMin = new Vector3(Infinity, Infinity, Infinity);
  const localMax = new Vector3(-Infinity, -Infinity, -Infinity);
  const worldMin = new Vector3(Infinity, Infinity, Infinity);
  const worldMax = new Vector3(-Infinity, -Infinity, -Infinity);
  for (const m of mergedMeshes) {
    m.geometry.computeBoundingBox();
    m.geometry.computeBoundingSphere();
    const b = m.geometry.boundingBox!;
    localMin.min(b.min); localMax.max(b.max);
    const w = b.clone().applyMatrix4(root.matrixWorld);
    worldMin.min(w.min); worldMax.max(w.max);
  }

  let totalMeshes = 0;
  let totalCasters = 0;
  let visibleCasters = 0;
  let staticCasters = 0;
  let dynamicCasters = 0;
  let uberBakedCasters = 0;
  let mergedSources = 0;
  root.traverse((node) => {
    if (!(node as Mesh).isMesh) return;
    const mesh = node as Mesh;
    totalMeshes++;
    if (mesh.userData?._rvStaticUberSource) mergedSources++;
    if (!mesh.castShadow) return;
    totalCasters++;
    if (mesh.visible) visibleCasters++;
    if (mesh.matrixAutoUpdate === false) staticCasters++;
    else dynamicCasters++;
    if (mesh.userData?._rvUberBaked) uberBakedCasters++;
  });

  const chunkVerts = mergedMeshes.map(m => m.geometry.attributes.position?.count ?? 0);
  const avgChunkVerts = Math.round(totalVertices / mergedMeshes.length);
  console.log(
    `[StaticUberMerge] ${candidates.length} candidates → ${mergedMeshes.length} chunk(s), ` +
    `${totalVertices.toLocaleString()} total vertices\n` +
    `  per-chunk verts: avg ${avgChunkVerts.toLocaleString()}, ` +
    `min ${Math.min(...chunkVerts).toLocaleString()}, max ${Math.max(...chunkVerts).toLocaleString()}\n` +
    `  bbox root-local: [${localMin.x.toFixed(1)},${localMin.y.toFixed(1)},${localMin.z.toFixed(1)}]` +
      `..[${localMax.x.toFixed(1)},${localMax.y.toFixed(1)},${localMax.z.toFixed(1)}]\n` +
    `  bbox world:      [${worldMin.x.toFixed(1)},${worldMin.y.toFixed(1)},${worldMin.z.toFixed(1)}]` +
      `..[${worldMax.x.toFixed(1)},${worldMax.y.toFixed(1)},${worldMax.z.toFixed(1)}]\n` +
    `  scene: ${totalMeshes} meshes, ${mergedSources} hidden uber sources\n` +
    `  shadow casters: ${visibleCasters} visible / ${totalCasters} total ` +
      `(${staticCasters} static, ${dynamicCasters} dynamic, ${uberBakedCasters} uber-baked)`
  );
  debug('loader',
    `[StaticUberMerge] ${candidates.length} uber-baked static meshes → ${mergedMeshes.length} chunk(s) ` +
    `(${candidates.length - mergedMeshes.length} draw calls saved)`
  );

  return {
    originalCount: candidates.length,
    mergedCount: mergedMeshes.length,
    totalVertices,
  };
}
