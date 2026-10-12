// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-scene-snapshot — one O(N) pass over the model producing a plain-data,
 * per-node geometric summary. The shared backbone of the MCP observation
 * layer: `web_scene_query` hands the frozen snapshot to the read-only eval,
 * `web_node_find`'s geometric filters run over it, `web_node_tree` joins its
 * bounds/mesh counts in, and `web_eye` derives ID-mask groups from it.
 *
 * Per-mesh world AABBs come from the (three.js-cached) geometry bounding box
 * transformed by the mesh world matrix; subtree bounds are aggregated in a
 * single post-order recursion — never `Box3.setFromObject` per node, which
 * would be O(N·V) over a CAD tree.
 *
 * Everything returned is plain JSON data (arrays/numbers/strings) — no live
 * Three.js references ever leak out, which is what makes the eval tool
 * read-only by construction.
 *
 * plan-754 F11: the snapshot reports the SAME graph the hierarchy panel shows.
 * Before, a node the `NodeRegistry` did not know got no entry at all, so after
 * the destructive bake the chunk meshes — which is where the triangles of every
 * merged CAD part now live — were invisible to `web_node_find` and
 * `web_scene_query` while the panel listed them. Unregistered nodes are entries
 * now, flagged `runtime` / `chunk` exactly as the panel flags them
 * (`rv-node-classification.ts`), with the name path they would have; only a
 * registered path can be handed to a path-taking WRITE tool, which is what the
 * flag says.
 */

import { Box3, Color, Vector3 } from 'three';
import type { Material, Mesh, MeshStandardMaterial, Object3D } from 'three';
import type { RVViewer } from '../../core/rv-viewer';
import { NodeRegistry } from '../../core/engine/rv-node-registry';
import { isChunkMesh, isRuntimeNode } from '../../core/engine/rv-node-classification';
import { extractComponentTypes } from '../../core/hmi/rv-inspector-helpers';

export interface SnapshotBounds {
  center: [number, number, number];
  size: [number, number, number];
  min: [number, number, number];
  max: [number, number, number];
}

export interface SnapshotMaterial {
  name: string;
  /** '#rrggbb' of material.color when present. */
  color: string | null;
  metalness: number | null;
  roughness: number | null;
  opacity: number | null;
}

export interface SceneNodeSnapshot {
  /** Registry path when the document addresses the node, else the name path it
   *  would have (`runtime` / `chunk` entries — read-only, see the flags). */
  path: string;
  name: string;
  /** Parent-hops from the model root (root = 0). */
  depth: number;
  parentPath: string | null;
  /** rv_extras component type keys on this node ('Drive', 'Kinematic', …). */
  components: string[];
  /** True when the node itself is a mesh (not just a container). */
  isMesh: boolean;
  /** Meshes in the whole subtree (including self). */
  meshCount: number;
  /** Triangles in the whole subtree (including self). */
  triangles: number;
  /** World AABB of the subtree geometry — null when it has no meshes. */
  bounds: SnapshotBounds | null;
  /** Material summary of the node's OWN mesh (null for containers). */
  material: SnapshotMaterial | null;
  /** Effective visibility (own flag only — ancestors gate separately). */
  visible: boolean;
  /** Not in the `NodeRegistry` and not a chunk mesh (D2): a light, the floor, a
   *  gizmo, a hover overlay. Browsable, never addressable by path. Absent =
   *  false, so a registered node's JSON is unchanged. */
  runtime?: true;
  /** A mesh the bake produced — the merged triangles of one boundary ×
   *  material. It IS the document's geometry, just not a document node. */
  chunk?: true;
}

const r3 = (n: number): number => +n.toFixed(3);
const v3 = (v: Vector3): [number, number, number] => [r3(v.x), r3(v.y), r3(v.z)];

function boundsOf(box: Box3): SnapshotBounds {
  const size = box.getSize(new Vector3());
  const center = box.getCenter(new Vector3());
  return { center: v3(center), size: v3(size), min: v3(box.min), max: v3(box.max) };
}

function materialOf(mesh: Mesh): SnapshotMaterial | null {
  const mat = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as
    (Material & Partial<MeshStandardMaterial>) | undefined;
  if (!mat) return null;
  const color = mat.color instanceof Color ? `#${mat.color.getHexString()}` : null;
  return {
    name: mat.name || '',
    color,
    metalness: typeof mat.metalness === 'number' ? r3(mat.metalness) : null,
    roughness: typeof mat.roughness === 'number' ? r3(mat.roughness) : null,
    opacity: typeof mat.opacity === 'number' ? r3(mat.opacity) : null,
  };
}

function trianglesOf(mesh: Mesh): number {
  const geo = mesh.geometry;
  if (!geo) return 0;
  if (geo.index) return Math.floor(geo.index.count / 3);
  const pos = geo.getAttribute('position');
  return pos ? Math.floor(pos.count / 3) : 0;
}

/**
 * Component type keys of a node — the SAME rule the hierarchy panel's badges
 * use (plan-754 F11).
 *
 * The local `!k.startsWith('_')` filter this replaced diverged from the panel
 * twice over: it kept scalar markers like `name` (not a component) and it kept
 * hidden types that carry no underscore, so a snapshot could announce a type
 * the panel deliberately never shows.
 */
function componentTypesOf(node: Object3D): string[] {
  return extractComponentTypes((node.userData as Record<string, unknown> | undefined)?.['realvirtual']);
}

/**
 * Build the snapshot for the whole model (or a subtree).
 *
 * Every node under the root gets an entry, in the same order the panel would
 * list it; unregistered ones carry `runtime` / `chunk` and a computed name path
 * (F11). Aggregates are unchanged — they always counted the whole subtree.
 */
export function buildSceneSnapshot(viewer: RVViewer, rootPath?: string): SceneNodeSnapshot[] {
  const registry = viewer.registry;
  const root = rootPath ? registry?.getNode(rootPath) : viewer.currentModelRoot;
  if (!registry || !root) return [];
  root.updateMatrixWorld(true);

  const out: SceneNodeSnapshot[] = [];
  const meshBox = new Box3();

  const visit = (node: Object3D, depth: number, parentPath: string | null): {
    box: Box3 | null; meshCount: number; triangles: number;
  } => {
    const registered = registry.getPathForNode(node);
    // An unregistered node still needs an identity to be reported under. The
    // name path is the one every other path in this file is computed from, so a
    // chunk mesh reads as `Robot/A1/mover:Robot/A1` — recognisable, and
    // resolvable by the read tools' graph fallback, but never registry-backed.
    const path = registered ?? NodeRegistry.computeNodePath(node);
    let own: Box3 | null = null;
    let meshCount = 0;
    let triangles = 0;

    const mesh = node as Mesh;
    if (mesh.isMesh && mesh.geometry) {
      const geo = mesh.geometry;
      if (!geo.boundingBox) geo.computeBoundingBox();
      if (geo.boundingBox && !geo.boundingBox.isEmpty()) {
        meshBox.copy(geo.boundingBox).applyMatrix4(mesh.matrixWorld);
        own = meshBox.clone();
      }
      meshCount = 1;
      triangles = trianglesOf(mesh);
    }

    for (const child of node.children) {
      const c = visit(child, depth + 1, path);
      if (c.box) own = own ? own.union(c.box) : c.box;
      meshCount += c.meshCount;
      triangles += c.triangles;
    }

    out.push({
      path,
      name: node.name,
      depth,
      parentPath,
      components: componentTypesOf(node),
      isMesh: !!(mesh.isMesh && mesh.geometry),
      meshCount,
      triangles,
      bounds: own ? boundsOf(own) : null,
      material: mesh.isMesh ? materialOf(mesh) : null,
      visible: node.visible,
      ...(isRuntimeNode(node, registered) ? { runtime: true as const } : {}),
      ...(isChunkMesh(node) ? { chunk: true as const } : {}),
    });
    return { box: own, meshCount, triangles };
  };

  visit(root, 0, null);
  return out;
}

/** Path → snapshot lookup for join-style consumers (node_tree bounds). */
export function snapshotByPath(snapshot: readonly SceneNodeSnapshot[]): Map<string, SceneNodeSnapshot> {
  const map = new Map<string, SceneNodeSnapshot>();
  for (const s of snapshot) {
    // A `runtime` / `chunk` entry carries a COMPUTED path, which can collide
    // with a registered one. The document wins: this map exists for consumers
    // that join on a registry path.
    const prev = map.get(s.path);
    if (prev && !prev.runtime && !prev.chunk) continue;
    map.set(s.path, s);
  }
  return map;
}
