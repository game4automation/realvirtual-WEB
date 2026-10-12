// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-mesh-compact — gives every imported mesh its OWN vertices.
 *
 * glTF lets many primitives index into one shared vertex pool, and converters that start
 * from a global vertex list (OBJ → GLB above all) write exactly that: 44 primitives, one
 * 2.5 M vertex accessor, each primitive using a sliver of it. It is valid glTF and a bad
 * asset — every such mesh reports the bounds of the WHOLE pool (never culled, framed and
 * picked as if it were the entire machine), and the pool survives in the saved GLB for as
 * long as a single mesh still references it.
 *
 * `separateMesh` compacts what it splits but leaves a single-island mesh untouched, so the
 * pool used to outlive the import. Compacting here, at the import seam, removes it before
 * anything else sees the tree.
 *
 * Deterministic on purpose: triangle order is kept and vertices are emitted in ascending
 * original order (`extractSubGeometry`), so the fresh import and every replay of the op
 * produce the identical geometry — later `separateMesh` ops address triangles by index.
 */

import type { BufferGeometry, Mesh, Object3D } from 'three';
import { unsupportedMeshShapeReason } from '../engine/rv-mesh-guards';
import { extractSubGeometry, type AttributeArray } from './rv-mesh-separator';

/** A mesh is compacted when it uses at most this share of its vertex buffer. */
export const COMPACT_MAX_USED_RATIO = 0.5;

export interface CompactStats {
  /** Meshes whose geometry was replaced by a compact one. */
  compactedMeshes: number;
}

/** Number of distinct vertices the index actually references. */
function countUsedVertices(geom: BufferGeometry, stamp: Uint8Array): number {
  const index = geom.index!.array as AttributeArray;
  const vertexCount = geom.getAttribute('position').count;
  let used = 0;
  for (let i = 0; i < index.length; i++) {
    const vi = index[i];
    if (vi < vertexCount && stamp[vi] === 0) {
      stamp[vi] = 1;
      used++;
    }
  }
  return used;
}

/**
 * Replace the geometry of every mesh under `root` that references only a fraction of its
 * vertex buffer with a compact copy. Meshes that share one geometry OBJECT (real
 * instancing) keep sharing the compacted one.
 *
 * Left alone: non-indexed geometry (it uses every vertex by construction), geometry with
 * `groups` or a narrowed `drawRange` (the index is not the whole story there), and every
 * shape the attribute-by-attribute copy cannot reproduce (`rv-mesh-guards`).
 */
export function compactSharedVertexPools(root: Object3D): CompactStats {
  const stats: CompactStats = { compactedMeshes: 0 };
  // geometry → its compact replacement, or null when it is fine as it is.
  const decided = new Map<BufferGeometry, BufferGeometry | null>();
  let stamp = new Uint8Array(0);

  root.traverse((node) => {
    const mesh = node as Mesh;
    if (mesh.isMesh !== true || unsupportedMeshShapeReason(mesh)) return;
    const geom = mesh.geometry as BufferGeometry;

    let compact = decided.get(geom);
    if (compact === undefined) {
      compact = null;
      const vertexCount = geom.getAttribute('position').count;
      const wholeRange = geom.drawRange.start === 0 && geom.drawRange.count === Infinity;
      if (geom.index && geom.groups.length === 0 && wholeRange && vertexCount > 0) {
        if (stamp.length < vertexCount) stamp = new Uint8Array(vertexCount);
        else stamp.fill(0, 0, vertexCount);
        const used = countUsedVertices(geom, stamp);
        if (used > 0 && used <= vertexCount * COMPACT_MAX_USED_RATIO) {
          const triangles = Array.from({ length: Math.floor(geom.index.count / 3) }, (_, i) => i);
          compact = extractSubGeometry(geom, triangles);
          compact.name = geom.name;
          compact.userData = { ...geom.userData };
        }
      }
      decided.set(geom, compact);
    }

    if (compact) {
      mesh.geometry = compact;
      stats.compactedMeshes++;
    }
  });

  return stats;
}
