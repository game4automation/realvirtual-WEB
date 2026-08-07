// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Grouped BVH raycast geometry builder.
 *
 * Replaces the per-mesh BVH + layer bitmask raycasting system with:
 *   - ONE merged BVH for all static meshes
 *   - ONE merged BVH per kinematic Drive group
 *
 * Each merged geometry is position-only (12 bytes/vertex), invisible,
 * and carries a sorted face-range table that maps triangle indices to
 * source object paths. Hit resolution is a binary search — O(log n) —
 * instead of a parent chain walk-up.
 *
 * Kinematic BVH meshes are children of their Drive nodes, so the BVH
 * stays valid when the Drive transform changes (BVH is in local space).
 */

import {
  Object3D,
  Mesh,
  BufferGeometry,
  BufferAttribute,
  Matrix4,
} from 'three';
import type { Material } from 'three';
import { debug } from './rv-debug';
import { getCapabilities } from './rv-component-registry';
import type { NodeRegistry } from './rv-node-registry';

// ─── Types ──────────────────────────────────────────────────────────

/** Maps a contiguous range of triangles to the source object they came from. */
export interface FaceRange {
  /** Inclusive start triangle index */
  startFace: number;
  /** Exclusive end triangle index */
  endFace: number;
  /** NodeRegistry path of the nearest content-providing ancestor —
   *  or the source mesh itself inside CADLink-only subtrees (per-part picking) */
  objectPath: string;
}

/** One source mesh's vertex window inside a group's merged position buffer. */
export interface RaycastSource {
  mesh: Mesh;
  /** First vertex of this mesh's window in the merged position attribute. */
  vertexStart: number;
  /** Vertex count of the window (== the mesh geometry's position count). */
  vertexCount: number;
}

/** A single merged BVH mesh with its face-range lookup table. */
export interface RaycastGroup {
  /** Invisible, position-only mesh with BVH computed */
  mesh: Mesh;
  /** Sorted by startFace — binary-searchable */
  faceRanges: FaceRange[];
  /** Merge-order source meshes with their vertex windows — consumed by the
   *  transform-refit fast path ({@link refitRaycastGroupsForSubtrees}). */
  sources: RaycastSource[];
}

/** Complete raycast geometry set for a loaded scene. */
export interface RaycastGeometrySet {
  /** Merged BVH for all static meshes (null if no static content providers) */
  staticGroup: RaycastGroup | null;
  /** Per-Drive merged BVH (driveNode → RaycastGroup) */
  kinematicGroups: Map<Object3D, RaycastGroup>;
}

// ─── Mesh entry for the merge pipeline ──────────────────────────────

interface MeshEntry {
  mesh: Mesh;
  objectPath: string;
}

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
        const hoverableKeys = keys.filter(k => getCapabilities(k).hoverable);
        const rvType = current.userData._rvType as string | undefined;
        const rvTypeHoverable = !!rvType && getCapabilities(rvType).hoverable;
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
 * Shared by both merged-group builders (static + kinematic) and the editor
 * instance pick index — keep every exclusion here so the representations
 * can never drift apart.
 *
 * NOT covered here (context-dependent, applied by the callers):
 * authored-hidden (`rv.Hidden`) subtree inheritance and the static/kinematic
 * Drive partition.
 */
export function isPickableMesh(mesh: Mesh): boolean {
  // Render-merge/batch outputs and our own BVH artifacts are never sources.
  if (mesh.userData?._rvBatchedRender) return false;
  if (mesh.userData?._rvRaycastBVH) return false;
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

// ─── Geometry merge with face-range tracking ────────────────────────

/**
 * Merge an array of mesh entries into a single position-only
 * BufferGeometry, recording which face ranges came from which source.
 *
 * Returns null if entries is empty or produces no geometry.
 */
function buildRaycastGroup(
  entries: MeshEntry[],
  parentNode: Object3D,
  deferBVH: boolean,
): RaycastGroup | null {
  if (entries.length === 0) return null;

  parentNode.updateWorldMatrix(true, false);
  const parentInverse = new Matrix4().copy(parentNode.matrixWorld).invert();

  // First pass: collect position data and build face ranges
  const positionArrays: Float32Array[] = [];
  const indexArrays: number[][] = [];
  const faceRanges: FaceRange[] = [];
  const sources: RaycastSource[] = [];
  let totalVertices = 0;
  let totalFaces = 0;

  for (const { mesh, objectPath } of entries) {
    const geom = mesh.geometry;
    if (!geom?.attributes?.position) continue;

    mesh.updateWorldMatrix(true, false);

    // Bake positions into parent-local space
    const bakeMatrix = new Matrix4()
      .multiplyMatrices(parentInverse, mesh.matrixWorld);

    const srcPos = geom.attributes.position;
    const vertCount = srcPos.count;
    const positions = new Float32Array(vertCount * 3);

    // Copy and transform positions
    for (let i = 0; i < vertCount; i++) {
      const x = srcPos.getX(i);
      const y = srcPos.getY(i);
      const z = srcPos.getZ(i);
      // Apply bake matrix inline
      const e = bakeMatrix.elements;
      const w = 1 / (e[3] * x + e[7] * y + e[11] * z + e[15]);
      positions[i * 3]     = (e[0] * x + e[4] * y + e[8]  * z + e[12]) * w;
      positions[i * 3 + 1] = (e[1] * x + e[5] * y + e[9]  * z + e[13]) * w;
      positions[i * 3 + 2] = (e[2] * x + e[6] * y + e[10] * z + e[14]) * w;
    }

    // Handle indexed vs non-indexed geometry
    let faceCount: number;
    if (geom.index) {
      const srcIndex = geom.index;
      const idxCount = srcIndex.count;
      faceCount = idxCount / 3;
      const indices: number[] = new Array(idxCount);
      for (let i = 0; i < idxCount; i++) {
        indices[i] = srcIndex.getX(i) + totalVertices;
      }
      indexArrays.push(indices);
    } else {
      faceCount = vertCount / 3;
      // Generate sequential indices offset by totalVertices
      const indices: number[] = new Array(vertCount);
      for (let i = 0; i < vertCount; i++) {
        indices[i] = i + totalVertices;
      }
      indexArrays.push(indices);
    }

    positionArrays.push(positions);

    // Record face range
    faceRanges.push({
      startFace: totalFaces,
      endFace: totalFaces + faceCount,
      objectPath,
    });
    sources.push({ mesh, vertexStart: totalVertices, vertexCount: vertCount });

    totalVertices += vertCount;
    totalFaces += faceCount;
  }

  if (totalVertices === 0 || totalFaces === 0) return null;

  // Build merged BufferGeometry (position-only, indexed)
  const mergedPositions = new Float32Array(totalVertices * 3);
  let posOffset = 0;
  for (const arr of positionArrays) {
    mergedPositions.set(arr, posOffset);
    posOffset += arr.length;
  }

  // Build merged index
  const totalIndices = indexArrays.reduce((sum, arr) => sum + arr.length, 0);
  const useUint32 = totalVertices > 65535;
  const mergedIndex = useUint32
    ? new Uint32Array(totalIndices)
    : new Uint16Array(totalIndices);
  let idxOffset = 0;
  for (const arr of indexArrays) {
    for (let i = 0; i < arr.length; i++) {
      mergedIndex[idxOffset++] = arr[i];
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(mergedPositions, 3));
  geometry.setIndex(new BufferAttribute(mergedIndex, 1));

  // Compute BVH with indirect mode — preserves the original index buffer
  // ordering so that faceIndex from acceleratedRaycast matches our
  // face-range table. Without this, computeBoundsTree() reorders the
  // index buffer for spatial locality, breaking the face-range mapping.
  //
  // With `deferBVH` (loadGLB path, plan-240) the merge stays synchronous but
  // the BVH is built asynchronously afterwards (computeBVHAsync, indirect
  // mode). Until the tree is assigned, `acceleratedRaycast` falls back to the
  // native three.js raycast against this merged geometry — hover/click work
  // immediately, just slower.
  if (!deferBVH) {
    geometry.computeBoundsTree({ indirect: true });
  }

  // Create invisible mesh
  const mesh = new Mesh(geometry);
  mesh.name = '__raycastBVH';
  mesh.visible = false;
  mesh.matrixAutoUpdate = false;
  mesh.frustumCulled = false;
  mesh.userData._rvRaycastBVH = true;

  return { mesh, faceRanges, sources };
}

// ─── Transform refit (fast path) ────────────────────────────────────

/** True when `mesh` is `node` or a descendant of any node in `moved`. */
function isUnderAny(mesh: Object3D, moved: Set<Object3D>): boolean {
  for (let cur: Object3D | null = mesh; cur; cur = cur.parent) {
    if (moved.has(cur)) return true;
  }
  return false;
}

/**
 * Transform fast path: re-bake the merged positions of every source mesh
 * under one of `movedNodes` and refit the affected groups' BVHs in place —
 * instead of a full `buildRaycastGeometries` rebuild.
 *
 * Valid ONLY for pure transforms: the mesh set, face order, topology and
 * object paths are unchanged — exactly what the merged index, the face-range
 * tables, the indirect BVHs and the highlight proxies key on. The highlight
 * proxies (fill + edge arena) share this position attribute zero-copy, so the
 * in-place rewrite updates them too. Anything structural (add / delete /
 * reparent / rename / hide) MUST go through a full rebuild instead.
 *
 * Returns false when any affected group could not be refit (mismatched source
 * geometry, detached group mesh, refit failure) — the caller should fall back
 * to a full rebuild.
 */
export function refitRaycastGroupsForSubtrees(
  set: RaycastGeometrySet,
  movedNodes: readonly Object3D[],
): boolean {
  if (movedNodes.length === 0) return true;
  const moved = new Set<Object3D>(movedNodes);

  const groups: RaycastGroup[] = [];
  if (set.staticGroup) groups.push(set.staticGroup);
  groups.push(...set.kinematicGroups.values());

  const bake = new Matrix4();
  const parentInverse = new Matrix4();
  let ok = true;

  for (const group of groups) {
    const affected = group.sources.filter((s) => isUnderAny(s.mesh, moved));
    if (affected.length === 0) continue;

    const parent = group.mesh.parent;
    const geometry = group.mesh.geometry;
    const posAttr = geometry.getAttribute('position') as BufferAttribute | undefined;
    if (!parent || !posAttr) { ok = false; continue; }

    parent.updateWorldMatrix(true, false);
    parentInverse.copy(parent.matrixWorld).invert();
    const dst = posAttr.array as Float32Array;

    for (const { mesh, vertexStart, vertexCount } of affected) {
      const srcPos = mesh.geometry?.attributes?.position;
      // Source geometry changed since the build (should have been a rebuild) —
      // bail out rather than write a mismatched window.
      if (!srcPos || srcPos.count !== vertexCount) { ok = false; continue; }
      mesh.updateWorldMatrix(true, false);
      bake.multiplyMatrices(parentInverse, mesh.matrixWorld);
      const e = bake.elements;
      for (let i = 0; i < vertexCount; i++) {
        const x = srcPos.getX(i);
        const y = srcPos.getY(i);
        const z = srcPos.getZ(i);
        const w = 1 / (e[3] * x + e[7] * y + e[11] * z + e[15]);
        const o = (vertexStart + i) * 3;
        dst[o]     = (e[0] * x + e[4] * y + e[8]  * z + e[12]) * w;
        dst[o + 1] = (e[1] * x + e[5] * y + e[9]  * z + e[13]) * w;
        dst[o + 2] = (e[2] * x + e[6] * y + e[10] * z + e[14]) * w;
      }
    }
    // Highlight proxies render from this attribute (zero-copy) — re-upload.
    posAttr.needsUpdate = true;

    const tree = geometry.boundsTree;
    if (tree) {
      try {
        tree.refit();
      } catch (err) {
        console.warn('[RaycastGeometry] BVH refit failed — falling back to rebuild:', err);
        ok = false;
      }
    } else {
      // BVH still pending (deferred async build): the native raycast fallback
      // reads the updated positions directly — just invalidate the stale
      // culling sphere three.js computed for it.
      geometry.boundingSphere = null;
    }
  }
  return ok;
}

// ─── Static group builder ───────────────────────────────────────────

/** Authored hidden flag (editor eye toggle / `rv.Hidden` in the GLB). Keyed on
 *  the extras flag, NEVER on `.visible` — the static merge hides its source
 *  meshes via `.visible` while keeping them as the pick targets. Exported for
 *  the editor instance pick index's per-pick visibility walk. */
export function isAuthoredHidden(node: Object3D): boolean {
  return (node.userData?.realvirtual as Record<string, unknown> | undefined)?.Hidden === true;
}

/** True when the node or any ancestor carries the authored hidden flag. */
function hasAuthoredHiddenAncestor(node: Object3D): boolean {
  for (let cur: Object3D | null = node.parent; cur; cur = cur.parent) {
    if (isAuthoredHidden(cur)) return true;
  }
  return false;
}

/**
 * Collect ALL static meshes, excluding meshes under Drive nodes and
 * render-merge artifacts. Meshes without a content-providing ancestor
 * still participate in raycasting (for occlusion) but resolve to ''.
 * Authored-hidden subtrees (rv.Hidden) are excluded — hidden ⇒ not pickable.
 */
function buildStaticGroup(
  root: Object3D,
  registry: NodeRegistry,
  driveNodeSet: Set<Object3D>,
  deferBVH: boolean,
): RaycastGroup | null {
  const entries: MeshEntry[] = [];

  const collectStatic = (node: Object3D, hiddenAncestor: boolean): void => {
    // Skip Drive subtrees — those go into kinematic groups
    if (driveNodeSet.has(node)) return;
    const hidden = hiddenAncestor || isAuthoredHidden(node);

    if (!hidden && (node as Mesh).isMesh) {
      const mesh = node as Mesh;
      // Shared predicate — batched sources are collected normally
      // (they ARE the pick geometry); batch outputs/overlays/etc. are not.
      if (!isPickableMesh(mesh)) return;

      // Content ancestor path — skip meshes with no resolvable path
      const objectPath = findContentAncestor(mesh, registry);
      if (objectPath) {
        entries.push({ mesh, objectPath });
      }
      // Meshes without a resolvable path are excluded from BVH entirely
      // (transparent to raycaster — prevents dead zones from empty objectPath)
    }

    for (const child of node.children) {
      collectStatic(child, hidden);
    }
  };

  collectStatic(root, false);

  if (entries.length === 0) return null;

  debug('loader', `[RaycastGeometry] Static: ${entries.length} meshes with content ancestors`);

  const group = buildRaycastGroup(entries, root, deferBVH);
  if (group) {
    group.mesh.name = '__raycastBVH_static';
    root.add(group.mesh);
  }
  return group;
}

// ─── Kinematic group builder ────────────────────────────────────────

/**
 * Collect all meshes under a Drive subtree, stopping at child Drive
 * boundaries. Include ALL meshes (uber + textured, with or without
 * _rvType) — unlike the render merge which excludes component nodes.
 */
function buildKinematicGroupForDrive(
  driveNode: Object3D,
  registry: NodeRegistry,
  driveNodeSet: Set<Object3D>,
  deferBVH: boolean,
): RaycastGroup | null {
  const entries: MeshEntry[] = [];
  // Pre-resolve Drive node path for fallback
  const driveNodePath = registry.getPathForNode(driveNode) ?? '';

  const collect = (node: Object3D, isRoot: boolean, hiddenAncestor: boolean): void => {
    // Stop at child Drive boundaries (but not at the root Drive itself)
    if (!isRoot && driveNodeSet.has(node)) return;
    const hidden = hiddenAncestor || isAuthoredHidden(node);

    if (!hidden && (node as Mesh).isMesh) {
      const mesh = node as Mesh;
      // Shared predicate — same exclusions as the static builder.
      if (!isPickableMesh(mesh)) return;

      // Content ancestor path — fallback to Drive node for non-uber-baked child meshes
      let objectPath = findContentAncestor(mesh, registry);
      if (!objectPath && driveNodePath) {
        // Non-uber-baked child mesh without own rv_extras → resolve to parent Drive node
        objectPath = driveNodePath;
      }
      if (objectPath) {
        entries.push({ mesh, objectPath });
        // Debug: log when a mesh resolves to a non-Drive path inside a Drive group
        if (objectPath !== driveNodePath) {
          debug('loader', `[RaycastGeometry] Kinematic mesh '${mesh.name}' → '${objectPath}' (Drive: '${driveNodePath}')`);
        }
      }
      // Meshes with no resolvable path are excluded from BVH entirely
    }

    for (const child of node.children) {
      collect(child, false, hidden);
    }
  };

  collect(driveNode, true, hasAuthoredHiddenAncestor(driveNode));

  if (entries.length === 0) return null;

  const group = buildRaycastGroup(entries, driveNode, deferBVH);
  if (group) {
    group.mesh.name = `__raycastBVH_${driveNode.name}`;
    driveNode.add(group.mesh);
  }
  return group;
}

// ─── Depth computation (reused from kinematic merge) ────────────────

function nodeDepth(node: Object3D): number {
  let depth = 0;
  let current: Object3D | null = node.parent;
  while (current) {
    depth++;
    current = current.parent;
  }
  return depth;
}

// ─── Main orchestrator ──────────────────────────────────────────────

/** Options for buildRaycastGeometries. */
export interface BuildRaycastGeometriesOptions {
  /**
   * When true, the merged geometries are built WITHOUT their BVH — the caller
   * builds the trees asynchronously afterwards (plan-240: `computeBVHAsync`
   * with `{ indirect: true }`; see `collectPendingBVHGeometries`). Until then,
   * raycasts against the merged meshes use the native three.js fallback.
   * Default false — synchronous `computeBoundsTree({ indirect: true })`
   * exactly as before (planner `rebuildGroupedBvh()` path, tests).
   */
  deferBVH?: boolean;
}

/**
 * Build all raycast geometries for a loaded scene.
 *
 * @param root        Scene root (GLB model root)
 * @param drives      Array of Drive instances (from Phase 5 traversal)
 * @param registry    NodeRegistry (fully built after Phase 7)
 * @param driveNodeSet  Set of Drive Object3D nodes (from Phase 2)
 * @param options     Optional build options (see BuildRaycastGeometriesOptions)
 */
export function buildRaycastGeometries(
  root: Object3D,
  drives: { node: Object3D }[],
  registry: NodeRegistry,
  driveNodeSet: Set<Object3D>,
  options?: BuildRaycastGeometriesOptions,
): RaycastGeometrySet {
  const deferBVH = options?.deferBVH ?? false;

  // Ensure all world matrices are fresh
  root.updateWorldMatrix(true, true);

  // Sort Drives deepest-first (children before parents) — same strategy
  // as kinematic render merge, so nested Drive chains are handled correctly
  const sortedDrives = [...drives].sort(
    (a, b) => nodeDepth(b.node) - nodeDepth(a.node),
  );

  // Build kinematic groups
  const kinematicGroups = new Map<Object3D, RaycastGroup>();
  let kinMeshTotal = 0;
  for (const drive of sortedDrives) {
    const group = buildKinematicGroupForDrive(
      drive.node,
      registry,
      driveNodeSet,
      deferBVH,
    );
    if (group) {
      kinematicGroups.set(drive.node, group);
      kinMeshTotal += group.faceRanges.length;
    }
  }

  // Build static group (everything NOT under a Drive)
  const staticGroup = buildStaticGroup(root, registry, driveNodeSet, deferBVH);

  debug('loader',
    `[RaycastGeometry] Built: ` +
    `static=${staticGroup ? staticGroup.faceRanges.length + ' objects' : 'none'}, ` +
    `kinematic=${kinematicGroups.size} groups (${kinMeshTotal} objects)`
  );

  return { staticGroup, kinematicGroups };
}

/**
 * Collect the merged geometries of a RaycastGeometrySet that still lack their
 * BVH (built with `deferBVH: true`). Order is deterministic and
 * benefit-sorted: the static group first (largest triangle count), then the
 * kinematic groups in their build order (Drives deepest-first).
 *
 * These geometries MUST be built in indirect mode (`{ indirect: true }`) so
 * the face-range tables stay valid — `computeBVHAsync` handles that.
 */
export function collectPendingBVHGeometries(set: RaycastGeometrySet): BufferGeometry[] {
  const out: BufferGeometry[] = [];
  if (set.staticGroup && !set.staticGroup.mesh.geometry.boundsTree) {
    out.push(set.staticGroup.mesh.geometry);
  }
  for (const group of set.kinematicGroups.values()) {
    if (!group.mesh.geometry.boundsTree) {
      out.push(group.mesh.geometry);
    }
  }
  return out;
}

// ─── Hit resolution ─────────────────────────────────────────────────

/**
 * Binary search the face-range table to find which source object
 * a hit triangle belongs to.
 *
 * @param faceRanges  Sorted face-range table from a RaycastGroup
 * @param faceIndex   Triangle index from the raycast intersection
 * @returns           Source object path, or null if not found
 */
export function resolveHit(
  faceRanges: FaceRange[],
  faceIndex: number,
): string | null {
  let lo = 0;
  let hi = faceRanges.length - 1;

  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const range = faceRanges[mid];

    if (faceIndex < range.startFace) {
      hi = mid - 1;
    } else if (faceIndex >= range.endFace) {
      lo = mid + 1;
    } else {
      return range.objectPath;
    }
  }

  return null;
}

// ─── Disposal ───────────────────────────────────────────────────────

/**
 * Dispose all raycast geometry (scene unload AND rebuild — a superseded set is
 * retired through here, see `RVViewer._retireRaycastGeometry`).
 *
 * Detaches every group mesh from the scene graph as well: `buildRaycastGeometries`
 * parents a FRESH `__raycastBVH_*` mesh on each call, so a rebuild that does not
 * retire its predecessor accumulates hidden corpses in the graph (plan-359 §2.2).
 *
 * CALLER CONTRACT: any `ProxyOverlayProvider` built over this set must be
 * disposed FIRST. Highlight proxies share the merged position/index attributes
 * zero-copy and `WebGLGeometries` does not refcount — disposing here under a
 * live proxy frees the buffers it is still drawing from (doc-render-picking.md §4.2).
 */
export function disposeRaycastGeometries(set: RaycastGeometrySet): void {
  // `?.` — with deferBVH the tree (and, before the first load completed, even
  // the prototype patch) may not exist yet.
  if (set.staticGroup) {
    disposeRaycastGroupMesh(set.staticGroup.mesh);
  }
  for (const group of set.kinematicGroups.values()) {
    disposeRaycastGroupMesh(group.mesh);
  }
  set.kinematicGroups.clear();
}

/** Retire one merged pick mesh: BVH, geometry, its private default material
 *  (each group mesh owns an unshared `MeshBasicMaterial` from `new Mesh(geo)`),
 *  then detach it from the graph. */
function disposeRaycastGroupMesh(mesh: Mesh): void {
  mesh.geometry.disposeBoundsTree?.();
  mesh.geometry.dispose();
  const material = mesh.material as Material | Material[] | undefined;
  if (Array.isArray(material)) for (const m of material) m.dispose();
  else material?.dispose();
  mesh.removeFromParent();
}
