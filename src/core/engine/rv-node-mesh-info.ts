// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-node-mesh-info.ts — the geometry ONE node carries (read-only).
 *
 * In plain three.js that is simply "the node is a `Mesh`". The bake pipeline
 * (plan-753) adds two more ways a node relates to drawn geometry:
 *   - `own`    — the node IS a `Mesh` and draws itself (a keep mesh, or any
 *                mesh in a tree that was never baked),
 *   - `chunk`  — a baked chunk mesh is parented to the node (the node is the
 *                chunk's owner: a mover, or the asset root for the static chunk),
 *   - `window` — the node owns an index window inside a chunk that hangs under
 *                another node (`ChunkNodeRange`; a merged node has no mesh).
 *
 * plan-754 F12 removed the `drawnByChunk` state and the inspector's `Drawn`
 * row. Under the destructive bake a merged source mesh does not exist any more
 * — it was removed, its triangles live in a chunk and the node reports a
 * `window` — so the state had exactly one possible value. In the in-place half
 * of the A/B switch (`rv.bake.destructive=0`, deleted in Phase 1c) the masked
 * source IS still in the tree and still listed as `own`: the section stays
 * correct there too, because it answers "what geometry does this node carry",
 * which a masked source does; it no longer says whether that geometry is the
 * one on screen.
 *
 * Deliberately NOT a subtree statistic: it looks at the node and its direct
 * children only, so it costs nothing on a 70k-node model and a plain group
 * reports nothing.
 */

import type { BufferGeometry, Material, Mesh, Object3D } from 'three';
import { RV_BAKE_CHUNK_KEY, type ChunkHighlightSource } from './rv-bake-registry';

export type NodeMeshKind = 'own' | 'chunk' | 'window';

export interface NodeMeshEntry {
  kind: NodeMeshKind;
  /** Mesh name, or the chunk key for a chunk / window. */
  name: string;
  /** The referenced data block (`BufferGeometry`): its name, else a short uuid. */
  block: string;
  triangles: number;
  /** Null for a window — it shares the chunk's vertex buffer. */
  vertices: number | null;
  materials: string[];
  /** `own` only: attribute names of the geometry, `index` first when indexed. */
  attributes: string[];
  /** `window` only: the index range the node owns inside the block. */
  range: { indexStart: number; indexCount: number } | null;
}

function triangleCount(geom: BufferGeometry): number {
  if (geom.index) return Math.floor(geom.index.count / 3);
  const pos = geom.getAttribute('position');
  return pos ? Math.floor(pos.count / 3) : 0;
}

function materialNames(mesh: Mesh): string[] {
  const mat = mesh.material as Material | Material[] | undefined;
  if (!mat) return [];
  return (Array.isArray(mat) ? mat : [mat]).map((m) => m.name || m.type);
}

function entryOf(kind: NodeMeshKind, mesh: Mesh): NodeMeshEntry {
  const geom = mesh.geometry;
  return {
    kind,
    name: mesh.name || kind,
    block: geom.name || geom.uuid.slice(0, 8),
    triangles: triangleCount(geom),
    vertices: geom.getAttribute('position')?.count ?? 0,
    materials: materialNames(mesh),
    attributes: [],
    range: null,
  };
}

/**
 * Geometry carried by `node`, own mesh first — empty for a node without any.
 * `chunks` is the bake registry (null in a context that never bakes).
 */
export function collectNodeMeshInfo(node: Object3D, chunks: ChunkHighlightSource | null): NodeMeshEntry[] {
  const entries: NodeMeshEntry[] = [];
  const own = node as Mesh;
  if (own.isMesh && own.geometry && !own.userData?.[RV_BAKE_CHUNK_KEY]) {
    const entry = entryOf('own', own);
    entry.attributes = [...(own.geometry.index ? ['index'] : []), ...Object.keys(own.geometry.attributes)];
    entries.push(entry);
  }
  for (const child of node.children) {
    const mesh = child as Mesh;
    if (mesh.isMesh && mesh.geometry && mesh.userData?.[RV_BAKE_CHUNK_KEY]) entries.push(entryOf('chunk', mesh));
  }
  // A whole-chunk target (`range === null`) is a chunk mesh — listed above when
  // it hangs under this node, and not this node's geometry when it does not.
  for (const target of chunks?.chunkTargetsOf(node) ?? []) {
    if (!target.range) continue;
    const entry = entryOf('window', target.mesh);
    entry.triangles = Math.floor(target.range.indexCount / 3);
    entry.vertices = null;
    entry.range = { indexStart: target.range.indexStart, indexCount: target.range.indexCount };
    entries.push(entry);
  }
  return entries;
}
