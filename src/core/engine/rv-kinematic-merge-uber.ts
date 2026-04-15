// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Kinematic group draw call merge for uber-baked meshes.
 *
 * After the static uber-merge (Phase 10c) collapses all static meshes,
 * there are still ~2,700 dynamic meshes under Drive nodes — each a
 * separate draw call. This module merges uber-baked meshes per Drive
 * subtree into single geometries, reducing dynamic draw calls to ~100-200.
 *
 * Algorithm per Drive group:
 *   1. Sort Drives by subtree depth (deepest first — children before parents)
 *   2. For each Drive, collect uber-baked candidates stopping at child Drive boundaries
 *   3. Bake candidate geometries into Drive-local space
 *   4. mergeGeometries() → attach merged Mesh as child of Drive
 *   5. Hide source meshes, dispose temporary geometry clones
 *
 * The merged mesh:
 *   - is a child of the Drive node → inherits Drive transform via scene graph
 *   - has matrixAutoUpdate = false (never moves relative to parent Drive)
 *   - keeps raycasting enabled (Drive hover via _findRVAncestor ancestor walk)
 *   - has BVH computed (no _rvSkipBVH) for O(log n) raycast
 *   - casts and receives shadows
 */

import {
  Object3D,
  Mesh,
  BufferGeometry,
  Matrix4,
  Material,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { debug } from './rv-debug';

// ─── Constants ───────────────────────────────────────────────────────

/** Attribute names the uber material cares about — everything else is stripped pre-merge. */
const UBER_ATTRIBUTES = new Set(['position', 'normal', 'color', 'rmPacked']);

/** Simulation component types that must remain individually identifiable.
 *  Nodes with any of these in rv_extras are excluded from merging. */
const EXCLUDE_COMPONENT_TYPES = new Set([
  'Drive', 'Drive_Cylinder', 'Drive_Simple',
  'Sensor',
  'Source', 'Sink',
  'Grip',
  'TransportSurface',
  'MU',
  'RuntimeMetadata',
  'Cam',
]);

/** Per-chunk vertex budget — same as static merge (500K). */
const DEFAULT_CHUNK_VERTEX_BUDGET = 500_000;

/** Minimum meshes in a Drive group to justify merging. */
const DEFAULT_MIN_MESHES = 3;

// ─── Result interface ────────────────────────────────────────────────

export interface KinematicMergeResult {
  /** Number of Drive groups that were merged */
  groupsMerged: number;
  /** Total source meshes hidden */
  sourceMeshCount: number;
  /** Total merged chunks created */
  chunksCreated: number;
  /** Drive groups skipped (< MIN_MESHES threshold or no candidates) */
  groupsSkipped: number;
}

// ─── Candidate filter ────────────────────────────────────────────────

/**
 * Check if a mesh is eligible for kinematic group merge.
 * Must be uber-baked, dynamic, visible, and not carry metadata/rv_extras.
 */
function isCandidate(mesh: Mesh, sharedUberMaterial: Material): boolean {
  // Must be uber-baked
  if (!mesh.userData?._rvUberBaked) return false;
  // Must reference the shared uber material
  if (mesh.material !== sharedUberMaterial) return false;
  // Must be dynamic (under a Drive) — static meshes have matrixAutoUpdate = false
  if (mesh.matrixAutoUpdate !== true) return false;
  // Must be visible (not already hidden by static merge)
  if (!mesh.visible) return false;
  // Skip meshes under an invisible ancestor (Source/MU templates)
  let anc = mesh.parent;
  while (anc) { if (!anc.visible) return false; anc = anc.parent; }
  // Must have usable geometry
  if (!mesh.geometry?.attributes?.position) return false;
  // Skip anything already flagged by static merge or a previous kinematic merge pass
  if (mesh.userData?._rvStaticUberMerged) return false;
  if (mesh.userData?._rvStaticUberSource) return false;
  if (mesh.userData?._rvKinGroupSource) return false;
  if (mesh.userData?._rvKinGroupMerged) return false;
  // Skip nodes with special rv type markers (Metadata, Sensor, etc.)
  if (mesh.userData?._rvMetadata) return false;
  if (mesh.userData?._rvType) return false;
  // Skip sensor visualization meshes
  if (mesh.name.endsWith('_sensorViz')) return false;
  // Skip nodes with simulation component types that need individual identification.
  // Everything else (Group, renderer, colliders, etc.) is safe to merge.
  if (mesh.userData?.realvirtual) {
    const rv = mesh.userData.realvirtual as Record<string, unknown>;
    for (const key of Object.keys(rv)) {
      if (EXCLUDE_COMPONENT_TYPES.has(key)) return false;
    }
  }
  // Skip skinned/morphed meshes
  if ((mesh as Mesh & { skeleton?: unknown }).skeleton) return false;
  if (mesh.morphTargetInfluences && mesh.morphTargetInfluences.length > 0) return false;

  return true;
}

// ─── Candidate collection with Drive boundary stopping ───────────────

/**
 * Recursively collect candidate meshes under a Drive node, stopping at
 * child Drive boundaries (nested kinematic chains).
 */
function collectCandidates(
  node: Object3D,
  root: Object3D,
  driveNodeSet: Set<Object3D>,
  sharedUberMaterial: Material,
  candidates: Mesh[],
  rejectCounter?: (reason: string) => void,
): void {
  // Stop at child Drive boundaries (but not at the root Drive itself)
  if (node !== root && driveNodeSet.has(node)) return;

  if ((node as Mesh).isMesh) {
    if (isCandidate(node as Mesh, sharedUberMaterial)) {
      candidates.push(node as Mesh);
    } else if (rejectCounter) {
      // Debug: track why this mesh was rejected
      const mesh = node as Mesh;
      if (!mesh.userData?._rvUberBaked) rejectCounter('not-uber-baked');
      else if (mesh.material !== sharedUberMaterial) rejectCounter('wrong-material');
      else if (mesh.matrixAutoUpdate !== true) rejectCounter('static(matrixAutoUpdate=false)');
      else if (!mesh.visible) rejectCounter('hidden(visible=false)');
      else if (!mesh.geometry?.attributes?.position) rejectCounter('no-position');
      else if (mesh.userData?._rvStaticUberMerged) rejectCounter('static-uber-merged');
      else if (mesh.userData?._rvStaticUberSource) rejectCounter('static-uber-source');
      else if (mesh.userData?._rvKinGroupSource) rejectCounter('kin-group-source');
      else if (mesh.userData?._rvKinGroupMerged) rejectCounter('kin-group-merged');
      else if (mesh.userData?._rvMetadata) rejectCounter('has-metadata');
      else if (mesh.userData?._rvType) rejectCounter('has-rvType');
      else if (mesh.name.endsWith('_sensorViz')) rejectCounter('sensorViz');
      else if (mesh.userData?.realvirtual) rejectCounter('has-rv-component');
      else rejectCounter('other');
    }
  }

  for (const child of node.children) {
    collectCandidates(child, root, driveNodeSet, sharedUberMaterial, candidates, rejectCounter);
  }
}

// ─── Depth computation ───────────────────────────────────────────────

/** Compute scene graph depth of a node (root = 0). */
function nodeDepth(node: Object3D): number {
  let depth = 0;
  let current: Object3D | null = node.parent;
  while (current) {
    depth++;
    current = current.parent;
  }
  return depth;
}

// ─── Main merge function ─────────────────────────────────────────────

/**
 * Merge uber-baked meshes per Drive subtree into single geometries.
 * Processes Drives bottom-up (deepest first) so nested kinematic chains
 * are handled correctly.
 *
 * @param root          Scene root (GLB model root)
 * @param drives        Array of RVDrive instances (from Phase 5 traversal)
 * @param driveNodeSet  Set of Drive Object3D nodes (from Phase 2 mesh processing)
 * @param sharedUberMaterial  The shared uber material singleton
 * @param minMeshes     Minimum meshes per group to justify merging (default: 3)
 * @param chunkVertexBudget  Vertex budget per merged chunk (default: 500K)
 */
export function mergeKinematicGroupMeshes(
  root: Object3D,
  drives: { node: Object3D }[],
  driveNodeSet: Set<Object3D>,
  sharedUberMaterial: Material,
  minMeshes: number = DEFAULT_MIN_MESHES,
  chunkVertexBudget: number = DEFAULT_CHUNK_VERTEX_BUDGET,
): KinematicMergeResult {
  const result: KinematicMergeResult = {
    groupsMerged: 0,
    sourceMeshCount: 0,
    chunksCreated: 0,
    groupsSkipped: 0,
  };

  if (drives.length === 0) return result;

  // Ensure all world matrices are fresh after Phases 9-10c
  root.updateWorldMatrix(true, true);

  // Debug: count rejection reasons across all drives
  const rejectReasons: Record<string, number> = {};
  const countReject = (reason: string) => { rejectReasons[reason] = (rejectReasons[reason] ?? 0) + 1; };

  // Sort Drive nodes by depth (deepest first → process children before parents)
  const sortedDrives = [...drives].sort((a, b) => nodeDepth(b.node) - nodeDepth(a.node));

  // Pre-decide whether to keep indices: scan all dynamic uber-baked meshes once
  // (same pattern as static merge)
  let keepIndexed = true;
  for (const drive of sortedDrives) {
    const candidates: Mesh[] = [];
    collectCandidates(drive.node, drive.node, driveNodeSet, sharedUberMaterial, candidates);
    for (const mesh of candidates) {
      if (!mesh.geometry.index) { keepIndexed = false; break; }
    }
    if (!keepIndexed) break;
  }

  // Process each Drive group
  for (const drive of sortedDrives) {
    const driveNode = drive.node;

    // Collect candidates for this Drive group
    const candidates: Mesh[] = [];
    collectCandidates(driveNode, driveNode, driveNodeSet, sharedUberMaterial, candidates, countReject);

    // Skip groups below minimum threshold
    if (candidates.length < minMeshes) {
      if (candidates.length > 0) result.groupsSkipped++;
      continue;
    }

    // Bake geometries into Drive-local space
    const driveInverse = new Matrix4().copy(driveNode.matrixWorld).invert();

    const normalize = (mesh: Mesh): BufferGeometry => {
      let geom = mesh.geometry.clone();
      if (!keepIndexed && geom.index) {
        const nonIndexed = geom.toNonIndexed();
        geom.dispose();
        geom = nonIndexed;
      }
      // Strip non-uber attributes
      for (const name of Object.keys(geom.attributes)) {
        if (!UBER_ATTRIBUTES.has(name)) geom.deleteAttribute(name);
      }
      // Compute normals if missing
      if (!geom.attributes.normal) geom.computeVertexNormals();
      // Bake world-space → Drive-local space
      geom.applyMatrix4(mesh.matrixWorld);
      geom.applyMatrix4(driveInverse);
      return geom;
    };

    // Pack candidates into chunks by vertex budget
    let currentChunk: BufferGeometry[] = [];
    let currentChunkVerts = 0;
    let groupChunks = 0;

    const finalizeChunk = (): void => {
      if (currentChunk.length === 0) return;
      const merged = mergeGeometries(currentChunk, false);
      // Dispose temporary clones
      for (const g of currentChunk) g.dispose();
      currentChunk = [];
      currentChunkVerts = 0;

      if (!merged) {
        debug('loader', `[KinematicMerge] mergeGeometries returned null for ${driveNode.name} — skipping chunk`);
        return;
      }

      const chunkMesh = new Mesh(merged, sharedUberMaterial);
      chunkMesh.name = `__kinGroupMerge_${driveNode.name}_${groupChunks}`;
      chunkMesh.castShadow = true;
      chunkMesh.receiveShadow = true;
      // The merged chunk never moves relative to its parent Drive.
      // IMPORTANT: only set matrixAutoUpdate = false, NOT matrixWorldAutoUpdate = false.
      // matrixWorldAutoUpdate must stay true so Three.js propagates the parent
      // Drive's world matrix to this child.
      chunkMesh.matrixAutoUpdate = false;
      chunkMesh.frustumCulled = true;
      // Keep raycasting enabled — _findRVAncestor walks up to the Drive node
      // for hover/tooltip. Do NOT disable raycast or set _rvSkipBVH.
      chunkMesh.userData._rvKinGroupMerged = true;

      driveNode.add(chunkMesh);
      groupChunks++;
      result.chunksCreated++;
    };

    for (const mesh of candidates) {
      const normalized = normalize(mesh);
      const verts = normalized.attributes.position.count;
      if (currentChunkVerts + verts > chunkVertexBudget && currentChunk.length > 0) {
        finalizeChunk();
      }
      currentChunk.push(normalized);
      currentChunkVerts += verts;
    }
    finalizeChunk();

    // Only count as merged if at least one chunk was created
    if (groupChunks > 0) {
      // Hide source meshes
      for (const mesh of candidates) {
        mesh.visible = false;
        mesh.userData._rvKinGroupSource = true;
      }
      result.groupsMerged++;
      result.sourceMeshCount += candidates.length;
    } else {
      result.groupsSkipped++;
    }
  }

  // Always log kinematic merge summary + rejection reasons
  const rejectStr = Object.entries(rejectReasons).map(([k, v]) => `${k}:${v}`).join(', ');
  debug('loader',
    `[KinematicMerge] ${result.groupsMerged} Drive groups merged: ` +
    `${result.sourceMeshCount} meshes → ${result.chunksCreated} chunks ` +
    `(${result.groupsSkipped} groups skipped). ` +
    `Rejected meshes: ${rejectStr || 'none'}`
  );

  return result;
}
