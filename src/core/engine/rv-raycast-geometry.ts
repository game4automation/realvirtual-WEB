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
  /** NodeRegistry path of the nearest content-providing ancestor */
  objectPath: string;
}

/** A single merged BVH mesh with its face-range lookup table. */
export interface RaycastGroup {
  /** Invisible, position-only mesh with BVH computed */
  mesh: Mesh;
  /** Sorted by startFace — binary-searchable */
  faceRanges: FaceRange[];
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
 */
function findContentAncestor(
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
        const hasHoverable = keys.some(k => getCapabilities(k).hoverable)
          || (current.userData._rvType && getCapabilities(current.userData._rvType as string).hoverable);
        if (hasHoverable) {
          const path = registry.getPathForNode(current);
          if (path) return path;
        }
      }
    }
    current = current.parent;
  }
  return null;
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
): RaycastGroup | null {
  if (entries.length === 0) return null;

  parentNode.updateWorldMatrix(true, false);
  const parentInverse = new Matrix4().copy(parentNode.matrixWorld).invert();

  // First pass: collect position data and build face ranges
  const positionArrays: Float32Array[] = [];
  const indexArrays: number[][] = [];
  const faceRanges: FaceRange[] = [];
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
  geometry.computeBoundsTree({ indirect: true });

  // Create invisible mesh
  const mesh = new Mesh(geometry);
  mesh.name = '__raycastBVH';
  mesh.visible = false;
  mesh.matrixAutoUpdate = false;
  mesh.frustumCulled = false;
  mesh.userData._rvRaycastBVH = true;

  return { mesh, faceRanges };
}

// ─── Static group builder ───────────────────────────────────────────

/**
 * Collect ALL static meshes, excluding meshes under Drive nodes and
 * render-merge artifacts. Meshes without a content-providing ancestor
 * still participate in raycasting (for occlusion) but resolve to ''.
 */
function buildStaticGroup(
  root: Object3D,
  registry: NodeRegistry,
  driveNodeSet: Set<Object3D>,
): RaycastGroup | null {
  const entries: MeshEntry[] = [];

  const collectStatic = (node: Object3D): void => {
    // Skip Drive subtrees — those go into kinematic groups
    if (driveNodeSet.has(node)) return;

    if ((node as Mesh).isMesh) {
      const mesh = node as Mesh;
      // Skip render-merge outputs (not source meshes)
      if (mesh.userData?._rvStaticUberMerged) return;
      if (mesh.userData?._rvKinGroupMerged) return;
      // Skip overlay/visualization meshes
      if (mesh.userData?._highlightOverlay) return;
      if (mesh.userData?._driveHoverOverlay) return;
      if (mesh.name.endsWith('_sensorViz')) return;
      if (mesh.name === '_tankFillViz') return;
      if (mesh.userData?._rvRaycastBVH) return;
      // Must have geometry
      if (!mesh.geometry?.attributes?.position) return;
      // Skip skinned/morphed
      if ((mesh as Mesh & { skeleton?: unknown }).skeleton) return;
      if (mesh.morphTargetInfluences && mesh.morphTargetInfluences.length > 0) return;

      // Content ancestor path — skip meshes with no resolvable path
      const objectPath = findContentAncestor(mesh, registry);
      if (objectPath) {
        entries.push({ mesh, objectPath });
      }
      // Meshes without a resolvable path are excluded from BVH entirely
      // (transparent to raycaster — prevents dead zones from empty objectPath)
    }

    for (const child of node.children) {
      collectStatic(child);
    }
  };

  collectStatic(root);

  if (entries.length === 0) return null;

  debug('loader', `[RaycastGeometry] Static: ${entries.length} meshes with content ancestors`);

  const group = buildRaycastGroup(entries, root);
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
): RaycastGroup | null {
  const entries: MeshEntry[] = [];
  // Pre-resolve Drive node path for fallback
  const driveNodePath = registry.getPathForNode(driveNode) ?? '';

  const collect = (node: Object3D, isRoot: boolean): void => {
    // Stop at child Drive boundaries (but not at the root Drive itself)
    if (!isRoot && driveNodeSet.has(node)) return;

    if ((node as Mesh).isMesh) {
      const mesh = node as Mesh;
      // Skip render-merge outputs
      if (mesh.userData?._rvStaticUberMerged) return;
      if (mesh.userData?._rvKinGroupMerged) return;
      // Skip overlay/visualization meshes
      if (mesh.userData?._highlightOverlay) return;
      if (mesh.userData?._driveHoverOverlay) return;
      if (mesh.name.endsWith('_sensorViz')) return;
      if (mesh.name === '_tankFillViz') return;
      if (mesh.userData?._rvRaycastBVH) return;
      // Must have geometry
      if (!mesh.geometry?.attributes?.position) return;
      // Skip skinned/morphed
      if ((mesh as Mesh & { skeleton?: unknown }).skeleton) return;
      if (mesh.morphTargetInfluences && mesh.morphTargetInfluences.length > 0) return;

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
      collect(child, false);
    }
  };

  collect(driveNode, true);

  if (entries.length === 0) return null;

  const group = buildRaycastGroup(entries, driveNode);
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

/**
 * Build all raycast geometries for a loaded scene.
 *
 * @param root        Scene root (GLB model root)
 * @param drives      Array of Drive instances (from Phase 5 traversal)
 * @param registry    NodeRegistry (fully built after Phase 7)
 * @param driveNodeSet  Set of Drive Object3D nodes (from Phase 2)
 */
export function buildRaycastGeometries(
  root: Object3D,
  drives: { node: Object3D }[],
  registry: NodeRegistry,
  driveNodeSet: Set<Object3D>,
): RaycastGeometrySet {
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
    );
    if (group) {
      kinematicGroups.set(drive.node, group);
      kinMeshTotal += group.faceRanges.length;
    }
  }

  // Build static group (everything NOT under a Drive)
  const staticGroup = buildStaticGroup(root, registry, driveNodeSet);

  debug('loader',
    `[RaycastGeometry] Built: ` +
    `static=${staticGroup ? staticGroup.faceRanges.length + ' objects' : 'none'}, ` +
    `kinematic=${kinematicGroups.size} groups (${kinMeshTotal} objects)`
  );

  return { staticGroup, kinematicGroups };
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
 * Dispose all raycast geometry (call on scene unload).
 */
export function disposeRaycastGeometries(set: RaycastGeometrySet): void {
  if (set.staticGroup) {
    set.staticGroup.mesh.geometry.disposeBoundsTree();
    set.staticGroup.mesh.geometry.dispose();
    set.staticGroup.mesh.removeFromParent();
  }
  for (const group of set.kinematicGroups.values()) {
    group.mesh.geometry.disposeBoundsTree();
    group.mesh.geometry.dispose();
    group.mesh.removeFromParent();
  }
  set.kinematicGroups.clear();
}
