// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-bake-chunk.ts — Data model of the planner bake pipeline (plan-753 §2.3).
 *
 * A library asset is baked ONCE per (asset id, document) into a handful of
 * CHUNKS: one merged geometry per (mover subtree × material bucket). Every
 * placement of the asset then renders, picks and highlights through the very
 * same chunk geometries — shared by reference, never cloned, never disposed
 * by a placement.
 *
 * What lives here is deliberately dependency-free (three.js only): the
 * component registry imports {@link BakeRole} from this file, and the dispose
 * helpers import {@link chunkMetaOf}, so anything heavier would form a cycle.
 * `bake()` itself is in rv-bake-pipeline.ts.
 *
 * Two hard rules, both enforced by construction rather than by convention:
 *
 *  - Metadata is keyed in a `WeakMap` ({@link chunkMetaOf}), NEVER in
 *    `geometry.userData` — `Object3D.clone()` JSON-round-trips `userData`,
 *    which would turn node references into plain objects (memory
 *    `webviewer-userdata-clone-json-roundtrip`). The same map is the runtime
 *    dispose guard: `disposeSubtree()` / `disposeModelSubtree()` skip every
 *    geometry registered here.
 *  - A highlight proxy never touches `chunk.geometry.drawRange` (plan-753 S1):
 *    `drawRange` is a property of the geometry INSTANCE, so setting it on the
 *    shared chunk would clip every placement of that asset. Proxies use a
 *    zero-copy WRAPPER geometry ({@link makeRangeProxyGeometry}).
 *
 * plan-756 step 1d removed the window machinery that used to live here — the
 * `nodes[]` / `sources[]` tables, `bsearchNode`, `chunk.boundsTree` and
 * `chunk.ready`. A chunk's table of contents is its {@link BakedChunk.pick}
 * structure plus the asset's `nodeTable`; a triangle resolves through its
 * SEGMENT, and a node's geometry through its subtree's segment interval.
 */

import {
  Box3,
  BufferGeometry,
  Sphere,
  type BufferAttribute,
  type Material,
  type Mesh,
  type Object3D,
} from 'three';
import type { ChunkPickData, ChunkRange, NodeTable } from './rv-pick-structure';
import type { SignatureState } from '../persistence/rv-sig-verify';

/**
 * - `merge` — default. The node's meshes become part of the enclosing chunk
 *   (static blob or the nearest mover's chunk). Nothing about the node moves or
 *   mutates at runtime on its own.
 * - `chunk` — the node is a MOVER: it (and its subtree) gets its own chunk that
 *   is transformed as a unit every tick (Drive, Kinematic, Grip, …). Today this
 *   is what keeps the node matrix-dynamic in `freezeStaticMatrices`.
 * - `keep` — the node's ORIGINAL meshes stay individual and are never baked:
 *   they swap materials, rewrite geometry or are spawned/cloned at runtime
 *   (Lamp, MU templates, Source preview, Chain clones, ribbon web, CSG
 *   workpiece …). Today this is what excludes the subtree from the batched
 *   render arenas.
 */
export type BakeRole = 'merge' | 'chunk' | 'keep';

/** Type guard for values read from rv extras (`rv.BakeRole`). */
export function isBakeRole(value: unknown): value is BakeRole {
  return value === 'merge' || value === 'chunk' || value === 'keep';
}

// ─── Partition contract (plan-755) ───────────────────────────────────

/**
 * `node.userData[RV_PARTITION_KEY]: string[]` — PARTITION LABELS of a node on
 * the temporary graph (plan-755 D1/D2). The bake splits every chunk context by
 * the sorted, `|`-joined set of labels it collected from the mesh up to (but
 * excluding, D12) the chunk boundary: chunk = boundary × partition × material.
 *
 * This key is the ONLY contract between whoever stamps the labels and the bake.
 * It is deliberately generic: the bake knows nothing about where a label comes
 * from (a pre-bake hook resolves names into it today; a plugin may stamp the
 * same key) and imports nothing from the stamping side (plan-755 N2). Plain
 * string data — `userData` is JSON-cloned (memory
 * `webviewer-userdata-clone-json-roundtrip`).
 */
export const RV_PARTITION_KEY = '_rvPartition';

/**
 * `node.userData[RV_SYNTHETIC_KEY] === true` — the node was CREATED by the bake
 * (a partition object, plan-755 D6) and exists in no document: it has a path
 * and is registered, but nothing may be written against it (the inspector shows
 * it read-only) and it never takes part in the sanitized-path fallback, because
 * it was never an authored path (plan-755 R11). Leading `_`: stripped on export.
 */
export const RV_SYNTHETIC_KEY = '_rvSynthetic';

/**
 * What a partition object carries as `userData.realvirtual`, given its labels.
 *
 * The bake creates the object; WHAT the labels mean belongs to whoever stamped
 * them (plan-755 N2 — the bake never names a component type). The stamping side
 * registers one builder here; without one a partition object carries no extras
 * and is a plain, nameable, hideable node. One slot, last registration wins —
 * it is code, not configuration (same rule as `registerPreBakeHook`).
 */
export type PartitionExtrasBuilder = (labels: readonly string[]) => Record<string, unknown> | null;

let _partitionExtras: PartitionExtrasBuilder | null = null;

/** Install the {@link PartitionExtrasBuilder} (`null` removes it). */
export function registerPartitionExtras(builder: PartitionExtrasBuilder | null): void {
  _partitionExtras = builder;
}

/** The rv extras of a partition object for `labels`, or null when nobody declared any. */
export function partitionExtrasOf(labels: readonly string[]): Record<string, unknown> | null {
  return _partitionExtras ? _partitionExtras(labels) : null;
}

// ─── Chunk / asset records ───────────────────────────────────────────

export interface BakedChunk {
  /** `'static'` | `'tex:<material.uuid>'` | `'mover:<nodePath>'` |
   *  `'mover:<nodePath>|tex:<material.uuid>'`.
   *
   *  plan-755: a partitioned chunk carries a `grp:<partition>` segment between
   *  the boundary and the material part — `'grp:<p>'`, `'grp:<p>|tex:<uuid>'`,
   *  `'mover:<nodePath>|grp:<p>'`, `'mover:<nodePath>|grp:<p>|tex:<uuid>'`. The
   *  partition itself may contain `|` (`A|B`); nothing parses a key, it is an
   *  identity. An unpartitioned chunk keeps exactly the four forms above. */
  key: string;
  /** Sorted partition labels joined with `|`, `''` for an unpartitioned chunk
   *  (plan-755 D1: chunk = boundary × partition × material). */
  partition: string;
  /** The labels behind {@link partition}, sorted. Kept apart because a label
   *  may itself contain `|` — the joined spelling cannot be split again. */
  partitionLabels: readonly string[];
  /** Uint32 index; `UBER_ARENA_LAYOUT` for uber chunks, the material's own
   *  attribute layout for textured chunks. Positions are in the OWNER's frame
   *  (mover node) or the asset root's frame (static). */
  geometry: BufferGeometry;
  /** The RVUberMaterial singleton or the master's textured material. Never
   *  disposed by the asset — the material belongs to the session / master. */
  material: Material;
  /** The chunk's `Mesh` inside {@link BakedAsset.template} — destructive bake
   *  only (`null` for an in-place bake, where the instance creates its own).
   *  It is a real node of the template graph, parented to {@link groupObject}
   *  when the chunk is partitioned and to {@link owner} otherwise. */
  templateMesh: Mesh | null;
  /** The partition object this chunk's mesh hangs under (plan-755 D4/D6): ONE
   *  synthetic node per (owner, partition) in the template, child of
   *  {@link owner} at identity. `null` for an unpartitioned chunk and for a
   *  non-destructive bake (which builds no template). {@link owner} stays the
   *  BOUNDARY either way — the segment table and the baked frame do not change. */
  groupObject: Object3D | null;
  /** Mover node path relative to the asset root, or `null` for the static chunk. */
  ownerPath: string | null;
  /** The owner node (mover) or the asset root — the frame `geometry` is baked in. */
  owner: Object3D;
  /** Chunk-local bounds. */
  bounds: Box3;
  /** Triangles in this chunk. */
  triangles: number;
  /**
   * realvirtual's own CPU pick structure for this chunk (plan-756). Complete
   * when `bake()` resolves — there is no "pending" state and no fallback: a
   * chunk is published with its structure or the bake rejects.
   *
   * It addresses the FINAL index of {@link geometry}: the build permutes
   * triangles inside every segment, and nothing may reorder the index
   * afterwards (plan §2.4a.10 — the collision manager therefore builds
   * `indirect` trees on chunk geometries).
   */
  pick: ChunkPickData;
  /**
   * The chunk's material OCCLUDES a node pick (plan Q5): a segment without a
   * pick owner still stops the ray instead of letting it through to whatever
   * lies behind.
   *
   * The rule, deliberately in one place: a chunk blocks unless its material is
   * see-through, i.e. unless it is `transparent`, has an `alphaTest` (cut-out
   * "glass") or an `opacity` below 1. A safety guard behind glass therefore
   * stays selectable while an opaque housing hides what is inside it.
   * Mirrors {@link ChunkPickData.blocks}, which is what the traversal reads.
   */
  blocks: boolean;
}

/**
 * One alias path of a template node (plan-757 D4): ASSET-RELATIVE (root =
 * `''`), a historical spelling a reference may use — the raw or sanitized glTF
 * name of a node three.js deduplicated, or the AUTHORED path of a subtree a
 * pre-bake hook re-parented. The place step registers every alias prefixed
 * with the instance root's registry path, so the same asset answers to the
 * same authored paths as the main model and as any placement.
 */
export interface BakedAlias {
  path: string;
  template: Object3D;
}

export interface BakedAsset {
  /** Cache key (`resolvedCacheKey(...)` or the GLB url — same fallback as `arenaKeyFor`). */
  assetId: string;
  /**
   * The URL the bytes were actually read from (plan-757 Phase 2, F3) — the
   * base a RELATIVE `AssetReference.path` inside this asset resolves against,
   * exactly as `compose()` resolves it against a frame's `baseUrl`. A
   * `project:` asset is keyed by its registry identity (`resolved:…`), so the
   * cache key cannot serve as that base; this can. `''` when unknown (a test
   * bake straight from a tree).
   */
  url: string;
  /** Path aliases of the template, asset-relative — see {@link BakedAlias}. Filled by the recipe. */
  aliases: ReadonlyArray<BakedAlias>;
  /**
   * Every material of the document this asset was baked from, by name (plan-496)
   * — taken BEFORE the dedup/uber passes replace and rename materials. It is
   * what a `MaterialName` on a ribbon component resolves against. Filled by the
   * recipe (`prepareAndBake`); absent when an asset was baked some other way.
   */
  materialsByName?: ReadonlyMap<string, Material>;
  /**
   * Signature verdict of the BYTES this asset was baked from (plan-757 D8).
   * A property of the asset, never inherited from the document that places
   * it: the trust gate of a placement reads THIS, together with the document's
   * own state, exactly as a composed frame does (`isFrameGated`).
   */
  signatureState: SignatureState;
  /**
   * The graph every node reference of this asset points into —
   * `logicNodes[].template`, `keep[].mesh`, `chunk.owner` and every
   * `nodeTable.nodes` entry. `BakeRegistry.instantiate` rebuilds the parent chain
   * from it. Never mutated by an instance.
   *
   * In-place bake (plan-753): this IS the decoded master root the asset was
   * baked from. Destructive bake (plan-754 §2.4): a FRESH graph the bake built
   * — survivors as plain `Group`s, keep meshes MOVED over, one chunk `Mesh` per
   * boundary × material — and the decoded tree it was built from no longer
   * exists. For the main model the template is then placed WITHOUT a clone: it
   * is the scene graph.
   */
  template: Object3D;
  /** True when {@link template} is the bake's own output graph (plan-754). */
  destructive: boolean;
  /** Decode epoch at bake start; the cache publishes only at an unchanged epoch. */
  epoch: number;
  /** Chunks with ≥ 1 triangle. Empty chunks are dropped in the bake. */
  chunks: BakedChunk[];
  /** `bake:'keep'` originals (Lamp, Ray, Fluid …) — cloned per instance in Phase 3. */
  keep: { path: string; mesh: Mesh }[];
  /** Nodes with a component / snap point / mover role, without meshes —
   *  templates for the per-instance logic tree (Phase 3). */
  logicNodes: { path: string; template: Object3D }[];
  /** Bounds of all chunks + keep meshes in the asset root's frame. */
  bounds: Box3;
  /**
   * Pre-order ordinals of every SURVIVING node of this asset plus the sparse
   * (CSR) node → chunk → segment-interval table (plan-756 §2.3). `nodes[]`
   * holds TEMPLATE nodes, so ordinals are stable for the asset's lifetime and
   * an instance maps through `PlacementInstance.nodeOf` as usual.
   *
   * Since step 1d this is the ONLY pick/highlight table: a hit resolves
   * segment → owner ordinal → node, and a node's geometry is its subtree's
   * segment interval per chunk. There is no `asset.ready` any more — `bake()`
   * resolving IS the readiness (plan F1).
   */
  nodeTable: NodeTable<BakedChunk>;
  /** Refcount — live placements/ghosts/drafts. Dispose only at 0 + retired. */
  instances: number;
  /** Set by the cache when it dropped this asset (invalidate / clear / dispose);
   *  the last `release()` then disposes. */
  retired: boolean;
  /** True once the chunk geometries were freed. */
  disposed: boolean;
  /** `instances++`. */
  acquire(): void;
  /** `instances--`; disposes when it reaches 0 on a retired asset. */
  release(): void;
  /** Free every chunk geometry. Idempotent. Never touches materials. */
  dispose(): void;
  /** Total staged vertices / triangles (bake statistics). */
  vertices: number;
  triangles: number;
}

/**
 * Chunk metadata by geometry — the O(1) lookup geometry → chunk that the
 * `.raycast` override and the collision manager's `indirect` rule need, and the
 * dispose guard's membership test. A `WeakMap`, never `userData` (see file
 * header).
 */
export const chunkMetaOf = new WeakMap<BufferGeometry, { chunk: BakedChunk; asset: BakedAsset }>();

// ─── Range proxy geometry ────────────────────────────────────────────

/**
 * A zero-copy WRAPPER geometry that draws exactly one segment interval of a
 * chunk: it shares the chunk's `position` attribute and index by reference and
 * carries its own `drawRange` and `boundingSphere`. The sphere comes with the
 * {@link ChunkRange} — derived from the interval's segment boxes — so a
 * `frustumCulled` renderer does not cull the proxy by the whole chunk's sphere
 * and nothing sweeps the range's vertices any more (plan-756 step 1d; the old
 * two-pass sweep was O(range) per highlight). The OutlinePass reads depth only,
 * so no other attribute is shared (plan-753 S6).
 *
 * Pass `target` to reuse a pooled wrapper. Never call `dispose()` on the
 * result while its attributes are the chunk's — the attributes are the
 * chunk's GPU buffers. (Dropping the wrapper object is enough; a wrapper
 * whose attributes were swapped out for the pool is what the pool disposes.)
 */
export function makeRangeProxyGeometry(
  chunk: BakedChunk | BufferGeometry,
  range: ChunkRange,
  target?: BufferGeometry,
): BufferGeometry {
  const src = (chunk as BakedChunk).geometry ?? (chunk as BufferGeometry);
  const g = target ?? new BufferGeometry();
  const position = src.getAttribute('position') as BufferAttribute;
  if (g.getAttribute('position') !== position) g.setAttribute('position', position);
  if (g.getIndex() !== src.index) g.setIndex(src.index);
  g.setDrawRange(range.indexStart, range.indexCount);

  const sphere = g.boundingSphere ?? new Sphere();
  sphere.center.set(range.centerX, range.centerY, range.centerZ);
  sphere.radius = range.radius;
  g.boundingSphere = sphere;
  return g;
}

/** Path of `node` relative to `root` (`'a/b/c'`), `''` for the root itself. */
export function relativeNodePath(node: Object3D, root: Object3D): string {
  const parts: string[] = [];
  for (let n: Object3D | null = node; n && n !== root; n = n.parent) parts.unshift(n.name);
  return parts.join('/');
}
