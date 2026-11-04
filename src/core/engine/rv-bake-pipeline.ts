// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-bake-pipeline.ts — `bake()`: one library asset → a few render chunks
 * (plan-753 §2.4). Pure: no viewer, no scene, no registry side effects.
 *
 * Pipeline (each step is a phase in the bake timing ring):
 *   1. ROLES — walk the master once. A node's role is its own
 *      (`bakeRoleOf`: capability or authored `rv.BakeRole`) or, without a
 *      registered component, the nearest ancestor's. The root has no role of
 *      its own (it is the asset); `PlacementMeta` / `LayoutObject` are not
 *      roles either but the instantiate root marker and are skipped.
 *   2. MOVER CUT — every node whose OWN role is `chunk` opens a chunk context
 *      (a nested mover opens its own; the parent chain stays a logic node).
 *      plan-755: inside a context the meshes are further split by their
 *      PARTITION — the sorted set of `userData._rvPartition` labels between the
 *      mesh and the boundary (boundary excluded). Chunk = boundary × partition
 *      × material; the destructive template gets one partition object per
 *      (boundary, partition). Without any label nothing changes (N1).
 *   3. CLASSIFY — `keep` (role, invisible, skinned/morphed, or a mesh-level
 *      runtime helper such as `_sensorViz`) → original mesh in `keep[]`.
 *      Multi-material meshes are split by `geometry.groups`, each group going
 *      to the chunk of its material. Uber-baked → the context's uber chunk;
 *      any other material → `tex:<material.uuid>` inside the same context.
 *   4. ORDER — within a chunk, items are stable-sorted by the pre-order
 *      ordinal of a mesh's nearest SURVIVING ancestor-or-self
 *      (`computeBakeOrdinals`), DFS order kept inside one survivor's run. The
 *      pick-owner ordinal is part of the segment key, so an owner boundary is
 *      always a segment boundary. After the bake this index order is DATA —
 *      segments, cluster boxes, CSR rows and `faceIndex` address triangles by
 *      position; nothing may re-sort it.
 *   5. STAGE — two passes per chunk (count → allocate once → write), the
 *      documented fix against `RangeError: Array buffer allocation failed`
 *      (`buildRaycastGroup`, `buildMergeBatches`). Attributes canonicalized
 *      through `canonicalizeForArena` (+ `UBER_ARENA_LAYOUT` for uber chunks),
 *      positions baked into the OWNER's frame, winding flipped for
 *      negative-determinant sub-meshes, index always `Uint32Array`, chunks
 *      with zero triangles dropped. Since plan-756 staging returns RAW ARRAYS:
 *      `position` / `index` are handed to the pick build and the geometry is
 *      created only from what comes back.
 *   5a. PICK (plan-756) — one own CPU pick structure per chunk, built in the
 *      shared worker pool and AWAITED: when `bake()` resolves, every chunk has
 *      its structure. Items are ordered by the pre-order ordinal of a mesh's
 *      nearest surviving ancestor-or-self, so the subtree of every surviving
 *      node is one contiguous segment run per chunk (P1), and the asset gets a
 *      CSR node table over those intervals.
 *   6. BOUNDS — per chunk and for the asset. (The former chunk-BVH step and
 *      `asset.ready` were deleted in plan-756 step 1d: the pick structure of
 *      5a replaces them.)
 *
 * Epoch contract: `opts.isEpochCurrent()` is re-checked after EVERY `await`.
 * A stale bake disposes what it already staged and rejects with
 * {@link BakeAbortedError} — nothing is published (plan-753 S2, §9.11).
 *
 * The guard {@link assertBakeAllowed} is the entry: a bake must NEVER run on
 * an authoring load (`preserveHierarchy`) — see Phase 0 header notes below.
 */

import {
  Box3,
  BufferAttribute,
  BufferGeometry,
  FrontSide,
  Group,
  Matrix3,
  Matrix4,
  Mesh,
  Vector3,
  type InstancedMesh,
  type Material,
  type Object3D,
  type Texture,
} from 'three';
import { classifyShadows } from './rv-mesh-classifier';
import { sharedVizGeometries } from './rv-shared-viz-geometry';
import {
  bakedKeepGeometries,
  chunkMetaOf,
  partitionExtrasOf,
  relativeNodePath,
  RV_PARTITION_KEY,
  RV_SYNTHETIC_KEY,
  type BakedAsset,
  type BakedChunk,
  type BakeRole,
} from './rv-bake-chunk';
import {
  bakeRoleOf,
  claimsNodeOf,
  getRegisteredFactories,
  getRegisteredSchemaTypes,
  pickModeOf,
  RV_BAKE_ROLE_KEY,
  type ReferenceBakeTarget,
} from './rv-component-registry';
import { isBakeRole } from './rv-bake-chunk';
import {
  arenaLayoutOf,
  canonicalizeForArena,
  UBER_ARENA_LAYOUT,
  type ArenaAttrSpec,
} from './rv-mesh-merge-batch';
import { isGeometryUberBaked } from './rv-uber-material';
import { isRuntimeRigMesh } from './rv-traverse-utils';
import { getPlacementMeta } from './rv-asset-reference';
import { installPickRaycast } from './rv-pick-backend';
import { beginBakeTiming } from './rv-bake-timings';
import {
  getSharedPickBuildPort,
  type PickBuildJobResult,
  type PickBuildPort,
} from './rv-pick-build-port';
import { buildSegmentOnlyStructure, type PickSegmentInput } from './rv-pick-build';
import type { ChunkPickData, NodeTable } from './rv-pick-structure';
import type { SignatureState } from '../persistence/rv-sig-verify';
import { debug } from './rv-debug';
import { RV_ORIG_NAME_KEY } from './rv-authored-keys';

// ─── Phase 0: entry guard ────────────────────────────────────────────

/**
 * A bake must NEVER run on an authoring load. `preserveHierarchy` is the
 * mesh-bake flag every editor / STEP-inspection load and the simulating embed
 * runtime set (see the note on `LoadGLBOptions.preserveHierarchy` in
 * rv-scene-loader.ts) — such a load keeps every source mesh individual because
 * the editor saves back the tree it sees, and the instance pick backend
 * indexes those meshes one by one. Baking them into chunks would silently
 * break both. Call sites carrying `preserveHierarchy` today (8 files; the
 * loader integration test of Phase 4 checks them end to end):
 *   src/core/editor/rv-asset-material.ts
 *   src/core/editor/rv-asset-ops.ts
 *   src/core/engine/rv-chain.ts
 *   src/core/engine/rv-component-registry.ts   (doc comment only)
 *   src/core/engine/rv-scene-loader.ts
 *   src/core/rv-viewer.ts
 *   src/embed/rv-embed-viewer.ts
 */
export interface BakeGuardOptions {
  /** Authoring / mesh-bake flag of the load (see above). */
  preserveHierarchy?: boolean;
}

/** One recorded guard decision — a test spy hook, never read by product code. */
export interface BakeGuardEvent {
  allowed: boolean;
  preserveHierarchy: boolean;
}

/**
 * Every guard decision in order, oldest first. Product code never reads this;
 * tests use it to prove a load path did (or did not) reach the bake entry.
 * Capped so a long session cannot grow it without bound.
 */
export const bakeEvents: BakeGuardEvent[] = [];
const BAKE_EVENTS_CAP = 256;

/** Clear the recorded guard decisions (test-only). */
export function _resetBakeEventsForTesting(): void {
  bakeEvents.length = 0;
  bakeDropStats.length = 0;
}

/**
 * What every destructive bake released when it dropped its `tmp` graph
 * (plan-754 §2.6, newest last). Same contract as {@link bakeEvents}: capped,
 * never read by product code — it is what the Phase-1c heap gate (G3) and the
 * disposal tests quote, because "the decode is gone" is otherwise only visible
 * as an absence.
 */
export const bakeDropStats: Array<BakeDropStats & { assetId: string }> = [];
const BAKE_DROP_STATS_CAP = 64;

/**
 * Throws when the load is an authoring load (`preserveHierarchy === true`).
 * Records the decision in {@link bakeEvents} either way.
 */
export function assertBakeAllowed(opts: BakeGuardOptions): void {
  const preserveHierarchy = opts.preserveHierarchy === true;
  bakeEvents.push({ allowed: !preserveHierarchy, preserveHierarchy });
  if (bakeEvents.length > BAKE_EVENTS_CAP) bakeEvents.shift();
  if (preserveHierarchy) {
    throw new Error(
      '[rv-bake] bake() refused: preserveHierarchy loads (asset editor, STEP inspection, embed runtime) '
      + 'keep every source mesh individual and must never be baked into chunks (plan-753 §9.12)',
    );
  }
}

// ─── Public API ──────────────────────────────────────────────────────

/** Rejection of a bake whose decode epoch moved on while it ran. */
export class BakeAbortedError extends Error {
  constructor(assetId: string) {
    super(`[rv-bake] bake of "${assetId}" aborted: the asset was invalidated while baking`);
    this.name = 'BakeAbortedError';
  }
}

export interface BakeOptions extends BakeGuardOptions {
  /** Cache key of the asset (`BakedAsset.assetId`). */
  assetId: string;
  /** URL the bytes came from — `BakedAsset.url` (plan-757 Phase 2, F3). Default `''`. */
  url?: string;
  /** Decode epoch at bake start (recorded on the asset). Default 0. */
  epoch?: number;
  /** Signature verdict of the source bytes — `BakedAsset.signatureState` (plan-757 D8). Default `'none'`. */
  signatureState?: SignatureState;
  /** Re-checked after every `await`; `false` aborts the bake. Default: always current. */
  isEpochCurrent?: () => boolean;
  /** The session's RVUberMaterial singleton. Meshes on it (with baked
   *  attributes) go to the uber chunk; everything else is bucketed per
   *  material. `null` = no uber path (every material is its own bucket). */
  uberMaterial?: Material | null;
  /**
   * Pick-structure build port (plan-756 step 1b). Default: the ONE shared pool
   * (`getSharedPickBuildPort()`, plan P3) — a per-bake pool would spawn a set of
   * workers per dragged library asset.
   *
   * THE test seam: pass `createPickBuildPort({ createWorker: () => null })` so a
   * suite builds inline and never spawns a real `Worker`.
   */
  pickPort?: PickBuildPort;
  /**
   * Forced chunk split (plan-753 Phase 3, I7): a node this predicate accepts
   * opens its own chunk context exactly like a `bake:'chunk'` mover and
   * becomes a logic node. Used for the deferred placement roots of a document
   * (`PlacementMeta`); plan-769 F14 removed its other user, `trsByNodeId`.
   * Evaluated once per node in the role pass; never for the root, never over `keep`.
   */
  forceSplit?: (node: Object3D) => boolean;
  /**
   * Incoming reference tags and plugin claims per TARGET node (plan-754 D7/D17,
   * `SurvivalModel.incoming` of rv-bake-survival.ts). A `'chunk'`-tagged target
   * opens its own chunk context exactly like a `bake:'chunk'` mover — the
   * referrer moves, hides or clones it as a unit. `'merge'` tags do not change
   * the classification (the target's triangles stay in the enclosing chunk).
   * Never over `keep`, never for the root.
   */
  incomingRoles?: ReadonlyMap<Object3D, ReferenceBakeTarget>;
  /**
   * The role classification of THIS tree, already computed (plan-582 §2.4) —
   * ONE role pass per bake instead of two. The recipe classifies for the
   * survival model (`SurvivalModel.roles`) and hands the result in here; the
   * bake then only buckets items, keys chunks and takes the boundary frames.
   *
   * Must be the classification of `root` with the SAME `forceSplit` and
   * `incomingRoles` — `prepareAndBake` is what guarantees that. Absent (a
   * direct caller, a test), the bake classifies the tree itself.
   */
  roles?: RoleClassification;
  /**
   * DESTRUCTIVE bake (plan-754 §2.4). The bake builds a fresh TEMPLATE graph
   * from the survivors instead of pointing back into `root`, drops what the
   * template does not reference, and publishes it as {@link BakedAsset.template}.
   * `root` must be considered consumed afterwards: its keep meshes were MOVED
   * into the template and its remaining geometries were disposed.
   */
  destructive?: boolean;
  /**
   * Which nodes the template must carry (plan-754 D4), on top of the ones the
   * bake needs anyway (keep meshes, logic nodes, chunk owners, segment owners).
   * Feed `SurvivalModel.survives`. Ancestors are added automatically — a
   * survivor's path never changes. Ignored unless {@link destructive}.
   */
  survives?: (node: Object3D) => boolean;
  /**
   * Called once, with `tmp node → template node`, AFTER the template is built
   * and BEFORE `tmp` is dropped (destructive bake only). The one window a
   * caller gets to re-point its own tmp-keyed bookkeeping — the loader remaps
   * its renamed-node map here. The map is released right after; holding on to
   * it would pin every removed node and defeat the prune.
   */
  onTemplateBuilt?: (nodeOf: ReadonlyMap<Object3D, Object3D>) => void;
  /**
   * DIAGNOSTIC sink: called once per source mesh (or material group of one) the
   * staging writes into a chunk, with the chunk key. It replaced the retained
   * `chunk.sources[]` window table (plan-756 step 1d) for the only thing that
   * still read it — test probes that ask "where did this mesh land". A callback
   * costs nothing when absent and keeps no reference to the dropped `tmp` graph;
   * a table would have to survive the bake and address triangles the pick build
   * is free to permute.
   *
   * May be called MORE than once for one mesh (one call per material group) and
   * is also called for a re-stage after a failed worker (plan §2.4a.8).
   */
  onStaged?: (mesh: Mesh, chunkKey: string) => void;
}

/** `PlacementMeta` / `LayoutObject` mark the instantiate root, not a role (plan-753 F6). */
export const isPlacementMarker = (type: string): boolean => type === 'PlacementMeta' || type === 'LayoutObject';

/** Snap points carry no component — they are logic nodes by name (`Snap-ZN-convroll`).
 *  The engine-layer snap predicate: the bake survival model imports THIS one. */
export const SNAP_NAME = /^Snap[-_]/i;

/**
 * Bake `root` (a decoded, uber-baked MASTER — see `bakeMasterOntoUber`) into a
 * {@link BakedAsset}. Resolves after staging AND after every chunk's own pick
 * structure landed (plan-756 F1) — there is no later readiness and no
 * `asset.ready` any more. The master is never mutated (staging is copy-only).
 *
 * Rejects with {@link BakeAbortedError} when the epoch moved on — nothing is
 * published then. A chunk whose pick structure could not be built (the worker
 * AND the inline retry threw) is published SEGMENT-ONLY with a warning
 * (plan-757 Phase 3 commit B); the traversal picks it by its linear walk.
 */
export async function bake(root: Object3D, opts: BakeOptions): Promise<BakedAsset> {
  assertBakeAllowed(opts);
  const timing = beginBakeTiming(opts.assetId);
  const isCurrent = opts.isEpochCurrent ?? ((): boolean => true);
  const uber = opts.uberMaterial ?? null;

  root.updateMatrixWorld(true);

  // ── 1–3: roles, mover cut, classification — and the item pass on top of it.
  //
  // plan-582 §2.4: the ROLE pass runs ONCE per bake. `opts.roles` is the one
  // the recipe already ran for the survival model, before the material phase;
  // `bucketItems` adds what only the bake can know (material buckets, chunk
  // keys, boundary frames) and nothing it already knew.
  const plan = bucketItems(root, opts.roles ?? classifyRoles(root, opts), uber);
  timing.mark('roles');

  // ── 4 (plan-756 P2/P1): the survival set is known HERE, before staging, and
  // the ordinals it induces are what items are ordered by — the pre-order
  // ordinal of a mesh's nearest SURVIVING ancestor-or-self, so the subtree of
  // every surviving node becomes one contiguous run of segments per chunk.
  const ordinals = computeBakeOrdinals(root, plan, opts.survives);
  const chunkPlans = [...plan.chunks.values()];
  for (const cp of chunkPlans) {
    for (const item of cp.items) {
      item.segOrdinal = nearestOrdinal(ordinals, item.mesh);
      item.ownerOrdinal = isPickOwner(item.pickNode, root) ? ordinals.ordinalOf.get(item.pickNode) ?? -1 : -1;
    }
    // Stable sort: DFS order is preserved inside one survivor's run. The owner
    // ordinal is part of the segment key, so a pick-owner boundary is always a
    // segment boundary — a segment has exactly ONE owner by construction.
    cp.items.sort((a, b) => a.segOrdinal - b.segOrdinal);
    cp.layout = cp.uber ? UBER_ARENA_LAYOUT : unionLayout(cp.items);
  }
  timing.mark('split');

  // ── 5: staging, one chunk at a time, epoch-checked between chunks.
  //
  // Staging returns RAW ARRAYS, not a geometry (plan-756 §2.4, "buffer ownership
  // window"): `position` and `index` are handed over to the pick build the
  // moment they exist and nothing on the main thread references them again
  // until they come back. The `BufferGeometry` is therefore created only after
  // every build resolved — which is also what makes `bake()`'s resolution the
  // readiness of the pick structures.
  const chunks: BakedChunk[] = [];
  const assetBounds = new Box3();
  let totalVertices = 0;
  let totalTriangles = 0;
  const abort = (): never => {
    for (const c of chunks) {
      chunkMetaOf.delete(c.geometry);
      c.geometry.dispose();
    }
    throw new BakeAbortedError(opts.assetId);
  };
  const pickPort = opts.pickPort ?? getSharedPickBuildPort();
  const pickEpoch = pickPort.beginEpoch();
  const staged: StagedChunk[] = [];
  const pickJobs: Promise<PickBuildJobResult>[] = [];
  for (let i = 0; i < chunkPlans.length; i++) {
    if (i > 0) {
      await yieldToEventLoop();
      if (!isCurrent()) {
        pickEpoch.abort();
        abort();
      }
    }
    const cp = chunkPlans[i];
    const st = stageChunk(cp, root, opts.onStaged);
    if (!st) continue;
    staged.push(st);
    totalVertices += st.vertices;
    totalTriangles += st.triangles;
    // Chunk bounds are owner-local; lift them into the root frame for the asset.
    _tmpBox.copy(st.bounds).applyMatrix4(cp.ctx.owner.matrixWorld).applyMatrix4(plan.rootInverse);
    assetBounds.union(_tmpBox);
    const position = st.position!;
    const index = st.index!;
    // Ownership leaves the main thread here.
    st.position = null;
    st.index = null;
    pickJobs.push(pickEpoch.build({
      key: cp.key,
      position,
      index,
      segments: st.segments,
      options: { blocks: st.blocks, doubleSided: st.doubleSided },
      // A dead worker takes the transferred buffers with it (plan §2.4a.8).
      // Re-staging is side-effect free — the master is read, never written, and
      // `tmp` is alive until the template was built — so the ONE chunk can be
      // re-produced and built inline.
      restage: () => {
        const re = stageChunk(cp, root, opts.onStaged);
        if (!re) throw new Error(`[rv-bake] re-staging chunk "${cp.key}" produced no triangles`);
        return { position: re.position!, index: re.index! };
      },
    }));
  }
  for (const k of plan.keep) {
    _tmpBox.setFromObject(k.mesh).applyMatrix4(plan.rootInverse);
    if (!_tmpBox.isEmpty()) assetBounds.union(_tmpBox);
  }
  timing.mark('stage');
  if (!isCurrent()) {
    pickEpoch.abort();
    abort();
  }

  // ── 5a (plan-756 F1): await every pick build. A `stale` answer means the
  // epoch was aborted (dispose / a superseded bake) — nothing is published.
  //
  // A REJECTED build (plan-757 Phase 3 commit B) is no longer a load error:
  // the port already retried the chunk inline after a dead worker, so a
  // rejection means the build itself threw. That one chunk is re-staged (the
  // transferred buffers are gone, `tmp` is still alive) and published with a
  // SEGMENT-ONLY structure — owners, occlusion and the node table intact, no
  // cluster tree — which the traversal picks by its linear walk. The bake of
  // every other chunk is unaffected, and the warning names the chunk.
  const settled = await Promise.allSettled(pickJobs);
  if (!isCurrent()) {
    pickEpoch.abort();
    abort();
  }
  for (const s of settled) {
    if (s.status === 'fulfilled' && s.value.status !== 'ok') {
      pickEpoch.abort();
      abort();
    }
  }
  let segmentOnlyChunks = 0;
  for (let i = 0; i < staged.length; i++) {
    const s = settled[i];
    if (s.status === 'fulfilled') {
      const result = s.value as Extract<PickBuildJobResult, { status: 'ok' }>;
      chunks.push(finishChunk(staged[i], result.position, result.index, result.data, root));
      continue;
    }
    const cp = staged[i].plan;
    const re = stageChunk(cp, root, opts.onStaged);
    if (!re) throw s.reason;
    const position = re.position!;
    const index = re.index!;
    re.position = null;
    re.index = null;
    const data = buildSegmentOnlyStructure(position, index, re.segments, { blocks: re.blocks, doubleSided: re.doubleSided });
    console.warn(
      `[rv-bake] chunk "${cp.key}" of ${opts.assetId}: pick structure could not be built ` +
      `(${describeReason(s.reason)}) — published segment-only, picked by the linear walk`,
    );
    chunks.push(finishChunk(re, position, index, data, root));
    segmentOnlyChunks++;
  }
  if (segmentOnlyChunks > 0) {
    debug('loader', `[rv-bake] ${opts.assetId}: ${segmentOnlyChunks} chunk(s) without a pick structure`);
  }
  timing.mark('pick');

  // ── 5b (plan-754 §2.4): destructive bake — build the template graph the
  // survivors form, re-point every node reference into it, drop `tmp`.
  const destructive = opts.destructive === true;
  const template = destructive
    ? buildTemplateGraph(root, plan, chunks, opts.assetId, opts.survives, opts.onTemplateBuilt, ordinals.nodes)
    : root;
  if (destructive) timing.mark('template');

  // ── Asset record + refcount.
  const asset: BakedAsset = {
    assetId: opts.assetId,
    url: opts.url ?? '',
    // Filled by the recipe (rv-prepare-and-bake.ts) once the template is known.
    aliases: [],
    signatureState: opts.signatureState ?? 'none',
    template,
    destructive,
    epoch: opts.epoch ?? 0,
    chunks,
    keep: plan.keep,
    logicNodes: plan.logicNodes,
    bounds: assetBounds,
    nodeTable: buildNodeTable(ordinals, chunks),
    instances: 0,
    retired: false,
    disposed: false,
    vertices: totalVertices,
    triangles: totalTriangles,
    acquire(): void {
      this.instances++;
    },
    release(): void {
      if (this.instances <= 0) {
        console.warn('[rv-bake] release() without a matching acquire() on ' + this.assetId);
        this.instances = 0;
      } else {
        this.instances--;
      }
      if (this.instances === 0 && this.retired) this.dispose();
    },
    dispose(): void {
      if (this.disposed) return;
      this.disposed = true;
      for (const c of this.chunks) {
        chunkMetaOf.delete(c.geometry);
        // A collision body may have put an INDIRECT three-mesh-bvh tree on a
        // chunk geometry (plan §2.4a.10); the bake never builds one, but the
        // CPU-side tree must still go before the GPU buffers.
        const g = c.geometry;
        if (g.boundsTree) {
          if (typeof g.disposeBoundsTree === 'function') g.disposeBoundsTree();
          else g.boundsTree = undefined;
        }
        g.dispose();
      }
      // R8: the keep templates' geometries are the asset's too (every
      // placement's keep clone shares them; the dispose guard skips them).
      for (const k of this.keep) {
        const g = k.mesh.geometry as BufferGeometry | undefined;
        if (!g || !bakedKeepGeometries.has(g)) continue;
        bakedKeepGeometries.delete(g);
        if (g.boundsTree) {
          if (typeof g.disposeBoundsTree === 'function') g.disposeBoundsTree();
          else g.boundsTree = undefined;
        }
        g.dispose();
      }
    },
  };
  for (const c of chunks) chunkMetaOf.set(c.geometry, { chunk: c, asset });
  // R8: tag the keep templates' geometries — owned by this asset, never by a
  // placement subtree. A shared sensor-viz geometry stays with its own owner.
  for (const k of plan.keep) {
    const g = k.mesh.geometry as BufferGeometry | undefined;
    if (g && !sharedVizGeometries.has(g)) bakedKeepGeometries.add(g);
  }

  // No BVH step any more (plan-756 step 1d): the chunk BVH queue is gone with
  // `asset.ready`. Every chunk's pick structure landed in phase 'pick' above,
  // so the asset is fully queryable the moment this function resolves (F1).
  timing.finish({ chunks: chunks.length, vertices: totalVertices, triangles: totalTriangles });
  return asset;
}

// ─── Template graph (plan-754 §2.4, destructive bake) ───────────────

/** Marker on every chunk mesh — mirrors `RV_BAKE_CHUNK_KEY` of the registry
 *  without importing it (rv-bake-registry.ts imports THIS module's siblings). */
const RV_BAKE_CHUNK_KEY = '_rvBakeChunk';

/**
 * A plain template node for `src`: name, TRS, draw flags and — by REFERENCE,
 * not by JSON copy — its `userData`.
 *
 * The reference transfer is the whole point of a destructive bake: `tmp` is
 * dropped moments later and nothing else has ever seen this object, so the
 * extras block the components will read is simply handed over. It also avoids
 * `JSON.parse(JSON.stringify(...))` on ~31k surviving nodes of a large CAD
 * model, which is what `cloneLogicNode` has to pay for a placement whose master
 * stays alive.
 */
function makeTemplateNode(src: Object3D): Object3D {
  const node = new Group();
  node.name = src.name;
  node.position.copy(src.position);
  node.quaternion.copy(src.quaternion);
  node.scale.copy(src.scale);
  node.visible = src.visible;
  node.renderOrder = src.renderOrder;
  node.layers.mask = src.layers.mask;
  node.castShadow = src.castShadow;
  node.receiveShadow = src.receiveShadow;
  node.frustumCulled = src.frustumCulled;
  node.matrixAutoUpdate = src.matrixAutoUpdate;
  node.matrixWorldAutoUpdate = src.matrixWorldAutoUpdate;
  node.userData = src.userData;
  // A node `processMeshes` froze (`matrixAutoUpdate = false`) would otherwise
  // keep the identity matrix for ever — nothing recomputes it later.
  node.updateMatrix();
  return node;
}


/**
 * The ONE synthetic node a (boundary, partition) pair gets (plan-755 D4/D6): a
 * plain `Group` at identity under the boundary, parent of that partition's
 * chunk meshes. Hiding or isolating it is a plain subtree operation.
 *
 * NAMED LIKE A LOADED NODE. `detectRenamedNodes` leaves a loaded node with its
 * RAW glTF name (it restores `Part.1` / `a b` after Three's sanitizer when the
 * name is unique) and, on a real collision, with Three's `_N` suffix plus the
 * raw spelling under `_rvOrigName`. Same here: the name IS the readable
 * partition (`MC01.13`, `A|B`) — the hierarchy shows `node.name` — and a
 * collision with a template sibling gets the glTF `_N` suffix with the readable
 * spelling kept where the loader keeps it. Only `/` is removed up front: it is
 * the registry's path separator, and a loaded node cannot carry one either
 * without its path becoming ambiguous.
 *
 * `userData.realvirtual` comes from {@link partitionExtrasOf} — the bake does
 * not know what a label means (N2). Plain data throughout: `cloneLogicNode`
 * JSON-copies it for every placement.
 */
function makePartitionObject(partition: string, labels: readonly string[], usedNames: Set<string>): Object3D {
  const node = new Group();
  const base = partition.split('/').join('') || 'partition';
  let name = base;
  for (let n = 1; usedNames.has(name); n++) name = base + '_' + n;
  usedNames.add(name);
  node.name = name;
  const userData: Record<string, unknown> = { [RV_SYNTHETIC_KEY]: true };
  if (name !== partition) userData[RV_ORIG_NAME_KEY] = partition;
  const extras = partitionExtrasOf(labels);
  if (extras) userData.realvirtual = extras;
  node.userData = userData;
  // Identity for ever: the chunk geometry is baked in the BOUNDARY's frame, and
  // the world matrix follows the boundary through the parent's update (R1).
  node.matrixAutoUpdate = false;
  node.updateMatrix();
  return node;
}

/**
 * Build the fresh graph the survivors form and re-point every node reference of
 * the bake into it (plan-754 §2.4, steps 1–4).
 *
 *  1. Survivors become plain `Group`s — a merged component node is simply a
 *     Group, because no component, registry entry, segment owner or cache has
 *     ever seen the `tmp` object.
 *  2. Keep meshes are MOVED, not cloned: nothing in `tmp` shares their geometry
 *     (they were never staged), and moving them is what makes "dispose what the
 *     template does not reference" a decidable question.
 *  3. One chunk `Mesh` per chunk, parented to its boundary in the template —
 *     or to the boundary's partition object (plan-755, {@link makePartitionObject}).
 *  4. `tmp` is dropped: every geometry only the removed part held is disposed.
 *
 * Returns the template root. `root` is consumed.
 */
function buildTemplateGraph(
  root: Object3D,
  plan: TreePlan,
  chunks: readonly BakedChunk[],
  assetId: string,
  survives?: (node: Object3D) => boolean,
  onTemplateBuilt?: (nodeOf: ReadonlyMap<Object3D, Object3D>) => void,
  /** plan-756: the node table's ordinal → node array, re-pointed IN PLACE from
   *  `tmp` to template nodes. Passed in rather than derived from a returned
   *  `nodeOf` on purpose — holding that map would pin every dropped node. */
  remapNodes?: Object3D[],
): Object3D {
  // Snapshot structure BEFORE anything moves — a moved keep mesh loses its
  // `parent`, and the disposal sweep below needs the complete original node list.
  const order: Object3D[] = [];
  const parentOf = new Map<Object3D, Object3D>();
  root.traverse((n) => {
    order.push(n);
    for (const c of n.children) parentOf.set(c, n);
  });

  const keepSet = new Set<Object3D>();
  for (const k of plan.keep) keepSet.add(k.mesh);

  // ── Required set: what the bake itself needs, plus the survival model's
  // verdict, closed under ancestors (a survivor's path never changes, D4).
  const required = new Set<Object3D>([root]);
  const requireWithAncestors = (node: Object3D): void => {
    for (let c: Object3D | undefined = node; c && !required.has(c); c = parentOf.get(c)) {
      required.add(c);
    }
  };
  for (const k of plan.keep) requireWithAncestors(k.mesh);
  for (const l of plan.logicNodes) requireWithAncestors(l.template);
  for (const chunk of chunks) {
    requireWithAncestors(chunk.owner);
    // plan-756 step 1d: the template must carry every node the SEGMENT table
    // names — the geometry owner (`segNode`) and the pick owner (`segOwner`).
    // This is what the deleted `for (const r of chunk.nodes) …` did for pick
    // windows; without it a pick node whose only reason to exist is its geometry
    // would be dropped and `chunkTargetsOf` / `resolveHit` would name a node the
    // scene graph does not have.
    if (remapNodes) {
      const pick = chunk.pick;
      for (let s = 0; s < pick.segmentCount; s++) {
        const geometryOwner = remapNodes[pick.segNode[s]];
        if (geometryOwner) requireWithAncestors(geometryOwner);
        const owner = pick.segOwner[s];
        if (owner >= 0 && remapNodes[owner]) requireWithAncestors(remapNodes[owner]);
      }
    }
  }
  if (survives) {
    for (const n of order) if (survives(n)) requireWithAncestors(n);
  }

  // ── Build top-down: `order` is pre-order, so a parent is always mapped first.
  const nodeOf = new Map<Object3D, Object3D>();
  const templateRoot = makeTemplateNode(root);
  nodeOf.set(root, templateRoot);
  for (const src of order) {
    if (src === root || !required.has(src)) continue;
    const parent = parentOf.get(src);
    const parentTemplate = (parent && nodeOf.get(parent)) ?? templateRoot;
    let node: Object3D;
    if (keepSet.has(src)) {
      // Move the ORIGINAL. Its `tmp` children are cut loose first: the required
      // ones are re-attached below from `order`, the rest are disposed.
      src.children.length = 0;
      parentTemplate.add(src);
      node = src;
    } else {
      node = makeTemplateNode(src);
      parentTemplate.add(node);
    }
    nodeOf.set(src, node);
  }

  // ── Chunk meshes, parented to their boundary in the template — or, for a
  // partitioned chunk, to the ONE partition object of (boundary, partition)
  // (plan-755 D4: always an object for a non-empty partition, never for the
  // empty one, so there is no "how many partitions" branch anywhere).
  const partitionObjects = new Map<Object3D, Map<string, Object3D>>();
  const siblingNames = new Map<Object3D, Set<string>>();
  const partitionObjectOf = (owner: Object3D, partition: string, labels: readonly string[]): Object3D => {
    let byPartition = partitionObjects.get(owner);
    if (!byPartition) partitionObjects.set(owner, (byPartition = new Map()));
    let object = byPartition.get(partition);
    if (!object) {
      let used = siblingNames.get(owner);
      if (!used) {
        used = new Set();
        for (const c of owner.children) used.add(c.name);
        siblingNames.set(owner, used);
      }
      object = makePartitionObject(partition, labels, used);
      owner.add(object);
      byPartition.set(partition, object);
    }
    return object;
  };
  for (const chunk of chunks) {
    const owner = nodeOf.get(chunk.owner) ?? templateRoot;
    const parent = chunk.partition ? partitionObjectOf(owner, chunk.partition, chunk.partitionLabels) : owner;
    const mesh = new Mesh(chunk.geometry, chunk.material);
    // plan-756 F4: the instance override, explicitly — a clone would not carry it.
    installPickRaycast(mesh);
    mesh.name = chunk.key;
    mesh.castShadow = classifyShadows(mesh);
    mesh.receiveShadow = true;
    mesh.frustumCulled = true;
    // Positions are baked into the owner's frame: the local matrix is identity.
    mesh.matrixAutoUpdate = false;
    mesh.userData[RV_BAKE_CHUNK_KEY] = true;
    parent.add(mesh);
    chunk.templateMesh = mesh;
    chunk.groupObject = parent === owner ? null : parent;
    // Re-point: from here on the asset only ever names template nodes. The
    // owner stays the BOUNDARY even for a partitioned chunk — it is the frame
    // the geometry was baked in and the node an unowned segment falls back to.
    chunk.owner = owner;
  }
  for (const l of plan.logicNodes) l.template = nodeOf.get(l.template) ?? l.template;
  // plan-756: ordinals are an ASSET-level identity, so the table must name
  // template nodes. A survivor of the ordinal pass that the template does not
  // carry (a pick node of a chunk plan that staged nothing) degenerates to the
  // root — it owns no segment, so no CSR row of its own can point at geometry.
  if (remapNodes) {
    for (let i = 0; i < remapNodes.length; i++) remapNodes[i] = nodeOf.get(remapNodes[i]) ?? templateRoot;
  }

  templateRoot.updateMatrixWorld(true);
  if (onTemplateBuilt) {
    try {
      onTemplateBuilt(nodeOf);
    } catch (e) {
      console.warn('[rv-bake] onTemplateBuilt hook failed — tmp-keyed state may be stale:', e);
    }
  }
  const dropped = dropTmp(order, templateRoot);
  bakeDropStats.push({ assetId, ...dropped });
  if (bakeDropStats.length > BAKE_DROP_STATS_CAP) bakeDropStats.shift();
  debug('loader', `[rv-bake] dropped tmp of ${assetId}: ${dropped.geometries} geometr(ies), `
    + `${dropped.materials} material(s), ${dropped.textures} texture(s) (${dropped.images} ImageBitmap(s) closed)`);
  return templateRoot;
}

/**
 * Drop the temporary graph: dispose every geometry, material and TEXTURE that
 * only the removed part held (plan-754 §2.4 step 4 / §2.6).
 *
 * The texture half is what "the decode is really released" means in practice —
 * `Material.dispose()` frees the program, not the images. Note when it actually
 * fires: a material that becomes a CHUNK's material is retained by construction
 * (the chunk draws with it), so what this frees is the material of a mesh the
 * bake staged nowhere — a degenerate CAD mesh, a group whose chunk came out
 * empty — together with its textures and their `ImageBitmap` sources.
 *
 * NOT `disposeSubtree`: that helper has no `isMesh` guard and all Sprites share
 * ONE module-scope geometry, so it frees markers app-wide (memory
 * `webviewer-disposesubtree-sprite-singleton`). Here only `isMesh` nodes are
 * touched, and only when the template references neither their geometry nor
 * their material — keep meshes moved into the template, so their resources are
 * retained by construction, and chunk geometry is brand new.
 */
function dropTmp(order: readonly Object3D[], template: Object3D): BakeDropStats {
  const inTemplate = new Set<Object3D>();
  const retainedGeometries = new Set<BufferGeometry>();
  const retainedMaterials = new Set<Material>();
  const retainedTextures = new Set<Texture>();
  template.traverse((n) => {
    inTemplate.add(n);
    const mesh = n as Mesh;
    if (mesh.geometry) retainedGeometries.add(mesh.geometry);
    const mat = mesh.material as Material | Material[] | undefined;
    if (Array.isArray(mat)) for (const m of mat) retainedMaterials.add(m);
    else if (mat) retainedMaterials.add(mat);
  });
  for (const m of retainedMaterials) collectMaterialTextures(m, retainedTextures);

  const droppedMaterials = new Set<Material>();
  const disposedGeometries = new Set<BufferGeometry>();
  for (const n of order) {
    const mesh = n as Mesh;
    // Only real meshes: a Sprite's geometry is a module-scope SINGLETON shared
    // by every marker in the app (memory `webviewer-disposesubtree-sprite-singleton`),
    // and non-`Mesh` drawables are `keep` anyway — they are in the template.
    if (mesh.isMesh !== true || inTemplate.has(n)) continue;
    const geometry = mesh.geometry;
    if (
      geometry && !retainedGeometries.has(geometry) && !disposedGeometries.has(geometry)
      && !chunkMetaOf.has(geometry)
    ) {
      disposedGeometries.add(geometry);
      geometry.dispose();
    }
    const mat = mesh.material as Material | Material[] | undefined;
    if (Array.isArray(mat)) for (const m of mat) droppedMaterials.add(m);
    else if (mat) droppedMaterials.add(mat);
  }

  // Materials are deduplicated scene-wide and the uber singleton belongs to the
  // session, so a `tmp` material is freed only when nothing in the template
  // (chunk material, keep material) references it any more.
  //
  // A material's TEXTURES are not freed by `Material.dispose()` — that only
  // drops the material's own program. They are the biggest single item in a
  // textured CAD decode, so the release is what the plan-754 heap gate (G3)
  // actually measures, and it is decidable here for the same reason the
  // geometry release is: the template is the only thing that survives.
  let materials = 0;
  let textures = 0;
  let images = 0;
  const droppedTextures = new Set<Texture>();
  for (const m of droppedMaterials) {
    if (retainedMaterials.has(m)) continue;
    if (isSharedResource(m)) continue;
    collectMaterialTextures(m, droppedTextures);
    m.dispose();
    materials++;
  }
  for (const t of droppedTextures) {
    if (retainedTextures.has(t) || isSharedResource(t)) continue;
    textures++;
    if (closeTextureImage(t)) images++;
    t.dispose();
  }
  return { geometries: disposedGeometries.size, materials, textures, images };
}

/** What {@link dropTmp} released — reported by the bake for the heap gate. */
export interface BakeDropStats {
  geometries: number;
  materials: number;
  textures: number;
  /** `ImageBitmap`s closed — decoded pixels the GC cannot reclaim on its own. */
  images: number;
}

/**
 * Opt-out marker for a resource the session owns (the uber material, a shared
 * viz texture): `userData._rvShared` — the same flag the material release has
 * honoured since Phase 1a, applied to textures too.
 */
function isSharedResource(res: { userData?: Record<string, unknown> }): boolean {
  return res.userData?._rvShared === true;
}

/**
 * Every `Texture` a material references, into `out`.
 *
 * Property-driven rather than a fixed map/name list: the set of texture slots
 * differs per material class (and per three release), and a slot this walk
 * missed would leak the one thing the release exists for. `isTexture` is the
 * only test — cheap, and nothing else on a material carries it.
 */
function collectMaterialTextures(material: Material, out: Set<Texture>): void {
  for (const key of Object.keys(material)) {
    const value = (material as unknown as Record<string, unknown>)[key];
    if (value && (value as Texture).isTexture === true) out.add(value as Texture);
  }
}

/**
 * Close a texture's `ImageBitmap` source, if that is what it holds.
 *
 * `Texture.dispose()` frees the GPU upload; the decoded CPU-side bitmap behind
 * it is an `ImageBitmap` the GLTFLoader created (`createImageBitmap`) and only
 * an explicit `close()` releases it — that memory does not live in the JS heap
 * and is exactly the kind that makes a "disposed" decode still cost hundreds of
 * MB. Guarded: a texture may share its source with another texture that is
 * still alive, and a closed bitmap throws nothing but must not be closed twice.
 */
function closeTextureImage(texture: Texture): boolean {
  const source = texture.source as { data?: unknown } | undefined;
  const data = source?.data ?? (texture as unknown as { image?: unknown }).image;
  if (typeof ImageBitmap === 'undefined' || !(data instanceof ImageBitmap)) return false;
  try {
    data.close();
    if (source) source.data = null;
    return true;
  } catch {
    return false;
  }
}

// ─── Classification ─────────────────────────────────────────────────

interface ChunkContext {
  owner: Object3D;
  ownerPath: string | null;
  /** owner.matrixWorld⁻¹ — positions are baked into this frame. */
  inverse: Matrix4;
  /** `''` for the static context, `'mover:<path>'` for a mover; a partitioned
   *  context appends `grp:<partition>` (see {@link partitionContextOf}). */
  keyPrefix: string;
  /** `''` = unpartitioned; otherwise the sorted partition labels joined with
   *  `|` (plan-755 D1). Same owner / frame as the base context — a partition
   *  splits the chunk, never the boundary. */
  partition: string;
  /** The labels behind {@link partition}, sorted — kept apart because a label
   *  may itself contain `|`, so the joined spelling cannot be split again. */
  labels: readonly string[];
}

interface StageItem {
  mesh: Mesh;
  material: Material;
  /** Index-entry range of the group inside the (canonical) geometry, or
   *  `-1` start for "the whole geometry". */
  groupStart: number;
  groupCount: number;
  /** Nearest pickable ancestor-or-self, else the chunk owner. */
  pickNode: Object3D;
  /** First-appearance ordinal of `pickNode` (DFS). Kept for diagnostics; the
   *  sort key is {@link segOrdinal} since plan-756 P1. */
  order: number;
  /** plan-756 P1: pre-order ordinal (among survivors) of this mesh's nearest
   *  SURVIVING ancestor-or-self — the sort key and the segment key. */
  segOrdinal: number;
  /** plan-756: ordinal of {@link pickNode}, the segment's pick owner. */
  ownerOrdinal: number;
  ctx: ChunkContext;
  /** `InstancedMesh` expansion (plan-754 D6): the instance's local matrix,
   *  applied between the mesh's world matrix and the geometry. `null` for an
   *  ordinary mesh. */
  instanceMatrix: Matrix4 | null;
}

interface ChunkPlan {
  key: string;
  ctx: ChunkContext;
  material: Material;
  uber: boolean;
  items: StageItem[];
  layout: readonly ArenaAttrSpec[];
}

interface TreePlan {
  chunks: Map<string, ChunkPlan>;
  keep: BakedAsset['keep'];
  logicNodes: BakedAsset['logicNodes'];
  rootInverse: Matrix4;
  /** Every mesh that went into a chunk (one entry per mesh, not per item). */
  staged: Mesh[];
  /** Triangles staged through `InstancedMesh` expansion (instances × triangles). */
  instancedTriangles: number;
}

/**
 * Does the node carry a BEHAVIOURAL component — one with a registered factory
 * or schema (Drive, Sensor, Lamp, …) — as opposed to a pure Unity export
 * marker (`renderer`, `rigidbody`, `colliders`, …)? Markers are registered
 * capabilities too (hidden in the inspector), so `bakeRoleOf` answers `merge`
 * for a mesh that only carries `renderer` extras — which must neither make it
 * a logic node nor let it break the role INHERITED from a `keep` ancestor.
 *
 * plan-755 D7: a type that declares `claimsNode: false` is an annotation, not
 * behaviour, even when it HAS a schema — `Group` has one (the inspector and the
 * asset editor need it) and would otherwise keep ~12700 group-only nodes of the
 * the large CAD line alive, each as a logic node with an explicit `merge`. It is treated
 * exactly like `renderer`: no role of its own, no logic node, no survival.
 */
export function makeBehaviouralTest(): (rv: Record<string, unknown> | undefined) => boolean {
  const factories = getRegisteredFactories();
  const schemas = new Set(getRegisteredSchemaTypes());
  return (rv) => {
    if (!rv) return false;
    for (const key in rv) {
      if (!rv[key] || isPlacementMarker(key)) continue;
      if ((factories.has(key) || schemas.has(key)) && claimsNodeOf(key)) return true;
    }
    return false;
  };
}

/**
 * A node's OWN bake role as the bake sees it (plan-753 §2.3 + the marker rule):
 * `bakeRoleOf` minus placement markers, and a `merge` that comes from Unity
 * export markers alone (`renderer`, `colliders`, …) is no role of its own — the
 * node inherits (an authored `rv.BakeRole` or a behavioural component is what
 * makes `merge` explicit). Shared by `classifyRoles` and the survival model so
 * both answer "does this node carry a role" identically.
 *
 * plan-755 D7: "export markers alone" now reads "`claimsNode: false` types
 * alone" — the test lives in {@link makeBehaviouralTest}, so a node that only
 * carries `Group(_N)` and/or markers has NO own role here either. A non-`merge`
 * role still wins regardless of `claimsNode` (a role is a statement about
 * geometry; declaring both would be a registration bug, not a survival rule).
 */
export function makeOwnRoleResolver(): (node: Object3D) => BakeRole | undefined {
  const isBehavioural = makeBehaviouralTest();
  return (node) => {
    const rv = node.userData?.realvirtual as Record<string, unknown> | undefined;
    const own = bakeRoleOf(node, isPlacementMarker);
    if (own === 'merge' && !isBehavioural(rv) && !isBakeRole(rv?.[RV_BAKE_ROLE_KEY])) return undefined;
    return own;
  };
}

/** What {@link classifyBakeTree} reports — the bake's classification without staging. */
export interface BakeClassification {
  /** Meshes / lines / points / sprites the bake leaves individual (`keep[]`). */
  keep: Object3D[];
  /** Meshes whose triangles go into a chunk. */
  staged: Mesh[];
  /** Triangles staged through `InstancedMesh` expansion. */
  instancedTriangles: number;
}

/**
 * A chunk BOUNDARY as the role pass sees it (plan-582 §2.4): which node owns
 * the frame and how its chunk keys are prefixed — and NOT the frame itself.
 * The `Matrix4` inverse is a bake-time quantity, taken off `owner.matrixWorld`
 * by {@link bucketItems}, so the role pass reads no matrix at all.
 */
interface BoundaryRole {
  owner: Object3D;
  ownerPath: string | null;
  keyPrefix: string;
}

/**
 * One staged mesh with everything {@link bucketItems} needs beyond the
 * material state: its boundary, its partition (plan-755) and its pick owner.
 * Recorded in DFS order, so the item pass pushes items in exactly the order
 * the single combined pass used to.
 */
interface StagedRole {
  mesh: Mesh;
  /** Joined partition spelling, `''` for none. */
  partition: string;
  /** Sorted partition labels, {@link NO_PARTITION} for none. */
  labels: readonly string[];
  boundary: BoundaryRole;
  pickNode: Object3D;
  order: number;
}

/** The empty label set every boundary restarts from (plan-755 D3). Never mutated. */
const NO_PARTITION: readonly string[] = Object.freeze([]);
const NO_LABELS: ReadonlySet<string> = new Set<string>();

/** No partition at all — the shared spelling of the empty label set. */
const NO_SPELLING: { sorted: readonly string[]; partition: string } = Object.freeze({
  sorted: NO_PARTITION, partition: '',
});

/**
 * What {@link classifyRoles} answers (plan-582 §2.4) — roles, mover cut, keep
 * vs chunk, partition membership and the `InstancedMesh` triangle count.
 *
 * NO items, no material buckets, no chunk keys, no `Matrix4` inverses: those
 * are {@link bucketItems}, which runs inside the bake AFTER the material phase
 * and takes this result as its INPUT. That is what makes ONE role pass per
 * bake enough — the survival model and the bake each ran their own before.
 *
 * It DOES read `material.map` (the TransportSurface rule of
 * {@link isMeshLevelKeep}) and that is deliberate, not an oversight:
 * `applyUberMaterial` rejects every material with a `map` and
 * `deduplicateMaterials` only collapses identical instances, so the answer is
 * INVARIANT under `dedup → uber` (plan-582 §6c M4, guarded by
 * `Test_RoleClassification_InvariantUnderMaterialPhase`). What it must never
 * read is the material IDENTITY the material phase exchanges — that is a chunk
 * key, and a chunk key is `bucketItems`.
 */
export interface RoleClassification {
  /** Meshes / lines / points / sprites the bake leaves individual, with asset-relative paths. */
  keep: BakedAsset['keep'];
  /** Meshes whose triangles go into a chunk (one entry per mesh, not per item). */
  staged: Mesh[];
  /** Triangles staged through `InstancedMesh` expansion (instances × triangles). */
  instancedTriangles: number;
  /** Component / snap / mover nodes — templates for the per-instance logic tree. */
  logicNodes: BakedAsset['logicNodes'];
  /** Bucketing input of {@link bucketItems}, in DFS order. Internal to the bake. */
  stagedRoles: readonly StagedRole[];
}

/**
 * Run ONLY the classification pass of {@link bake} (roles, mover cut, keep vs
 * chunk) — a thin wrapper around {@link classifyRoles} reporting the three
 * fields the survival model and the Phase-0 removal report consume, so "keep
 * mesh" means exactly what the bake means. Pure and read-only.
 *
 * `uberMaterial` is accepted and IGNORED (plan-582 §2.4): the uber material
 * only ever decided a chunk KEY, never a role.
 */
export function classifyBakeTree(
  root: Object3D,
  opts?: Pick<BakeOptions, 'forceSplit' | 'incomingRoles' | 'uberMaterial'>,
): BakeClassification {
  const roles = classifyRoles(root, opts);
  return {
    keep: roles.keep.map((k) => k.mesh),
    staged: roles.staged,
    instancedTriangles: roles.instancedTriangles,
  };
}

/**
 * THE role pass of a bake (plan-582 §2.4) — one DFS, no material bucketing.
 * See {@link RoleClassification} for what it answers and why reading
 * `material.map` is safe here.
 *
 * Reads no matrix: the mover cut records its boundary NODE, and the frame of a
 * boundary is taken by {@link bucketItems} at bake time. That is why the second
 * `root.updateMatrixWorld(true)` this pass used to carry is gone (plan-582
 * Phase 1 step 6) — the one in {@link bake} stays, because the item pass and
 * the staging are what read `matrixWorld`.
 */
export function classifyRoles(
  root: Object3D,
  opts?: Pick<BakeOptions, 'forceSplit' | 'incomingRoles' | 'uberMaterial'>,
): RoleClassification {
  const forceSplit = opts?.forceSplit;
  const incomingRoles = opts?.incomingRoles;
  const ownRoleOf = makeOwnRoleResolver();
  const keep: BakedAsset['keep'] = [];
  const logicNodes: BakedAsset['logicNodes'] = [];
  const staged: Mesh[] = [];
  const stagedRoles: StagedRole[] = [];
  let instancedTriangles = 0;
  const rootBoundary: BoundaryRole = { owner: root, ownerPath: null, keyPrefix: '' };

  // ── plan-755: partition bookkeeping. A label SET is shared by every node
  // below the one that introduced it (a new set is allocated only where a stamp
  // adds something), so its joined spelling is cached per set — one allocation
  // per distinct combination, not per mesh. The derived chunk CONTEXT is
  // `bucketItems`' business now.
  const spellingOfSet = new WeakMap<ReadonlySet<string>, { sorted: readonly string[]; partition: string }>();
  const spellingOf = (labels: ReadonlySet<string>): { sorted: readonly string[]; partition: string } => {
    if (labels.size === 0) return NO_SPELLING;
    let spelling = spellingOfSet.get(labels);
    if (!spelling) {
      const sorted = Object.freeze([...labels].sort());
      spelling = { sorted, partition: sorted.join('|') };
      spellingOfSet.set(labels, spelling);
    }
    return spelling;
  };
  const ordinals = new Map<Object3D, number>();
  const ordinalOf = (node: Object3D): number => {
    let o = ordinals.get(node);
    if (o === undefined) {
      o = ordinals.size;
      ordinals.set(node, o);
    }
    return o;
  };

  const visit = (
    node: Object3D,
    inheritedRole: BakeRole,
    boundary: BoundaryRole,
    pickNode: Object3D,
    visible: boolean,
    underTransport: boolean,
    underSensor: boolean,
    labels: ReadonlySet<string>,
  ): void => {
    const isRoot = node === root;
    const rv = node.userData?.realvirtual as Record<string, unknown> | undefined;
    let own = isRoot ? undefined : ownRoleOf(node);
    // Forced split (I7): a transform-overridden part is its own mover.
    if (!isRoot && own !== 'keep' && forceSplit?.(node)) own = 'chunk';
    // Incoming reference tag / plugin claim (plan-754 D7): a `chunk`-tagged
    // target is a boundary like a mover. Strongest wins, so never over `keep`.
    if (!isRoot && own !== 'keep' && incomingRoles?.get(node) === 'chunk') own = 'chunk';
    const role: BakeRole = own ?? inheritedRole;
    // The root's own `visible` is the INSTANCE's concern (the loader hides
    // the model root during its async phases, N5) — only descendants count.
    if (!isRoot) visible = visible && node.visible;
    if (rv?.TransportSurface) underTransport = true;
    if (rv?.Sensor) underSensor = true;

    if (!isRoot && own === 'chunk') {
      // Mover cut: a new chunk boundary; windows restart at the owner.
      const ownerPath = relativeNodePath(node, root);
      boundary = { owner: node, ownerPath, keyPrefix: 'mover:' + ownerPath };
      pickNode = node;
      // plan-755 D3/D12: labels never reach across a boundary, and the
      // boundary's OWN stamp does not partition — every mesh of the boundary
      // would share it, so it distinguishes nothing (the boundary node itself
      // is what a label on it hides, as a subtree).
      labels = NO_LABELS;
    } else if (!isRoot) {
      // The stamp is read off ANY node, whatever its role and whether or not it
      // survives: a node that carries nothing but labels has no role of its own
      // (plan-755 D7) and is gone after the bake — its labels are not. The root
      // is the boundary of the static context, so D12 applies to it as well.
      const stamp = node.userData?.[RV_PARTITION_KEY] as unknown;
      if (Array.isArray(stamp) && stamp.length > 0) {
        let next: Set<string> | null = null;
        for (const label of stamp) {
          if (typeof label !== 'string' || label === '' || labels.has(label)) continue;
          if (!next) next = new Set(labels);
          next.add(label);
        }
        if (next) labels = next;
      }
    }
    if (!isRoot && pickModeOf(node) !== 'none') pickNode = node;

    // Logic nodes: anything with a registered component, a snap point, or a
    // mover — templates for the per-instance logic tree (Phase 3). A mesh
    // node carrying a component is listed too; its geometry goes to a chunk.
    if (!isRoot && (own !== undefined || SNAP_NAME.test(node.name))) {
      logicNodes.push({ path: relativeNodePath(node, root), template: node });
    }

    const mesh = node as Mesh;
    const geometry = mesh.geometry as BufferGeometry | undefined;
    if (geometry && mesh.isMesh) {
      if (!geometry.getAttribute('position')) {
        // Nothing to draw — neither chunk nor keep.
      } else if (
        role === 'keep' || !visible || isSkinnedOrMorphed(mesh) || hasPerInstanceColor(mesh)
        || isMeshLevelKeep(mesh, underTransport, underSensor)
      ) {
        keep.push({ path: relativeNodePath(node, root), mesh });
      } else {
        staged.push(mesh);
        // plan-755 D1: chunk = boundary × partition × material. Only a STAGED
        // mesh is partitioned — a keep mesh is not a chunk and stays where it is.
        const { sorted, partition } = spellingOf(labels);
        stagedRoles.push({ mesh, partition, labels: sorted, boundary, pickNode, order: ordinalOf(pickNode) });
        // plan-582 §6c M5: the count is NOT purely geometric — it follows the
        // same material-GROUP validity arithmetic `addItems` applies (a material
        // must exist, only whole triangles count). Group arithmetic, not
        // bucketing: no key, no bucket, no inverse.
        instancedTriangles += countInstancedTriangles(mesh);
      }
    } else if (geometry) {
      // Line / Points / Sprite: never baked, kept as-is (typed loosely as Mesh).
      keep.push({ path: relativeNodePath(node, root), mesh: node as Mesh });
    }

    for (const child of node.children) {
      visit(child, role, boundary, pickNode, visible, underTransport, underSensor, labels);
    }
  };

  visit(root, 'merge', rootBoundary, root, true, false, false, NO_LABELS);
  return { keep, staged, instancedTriangles, logicNodes, stagedRoles };
}

/**
 * Triangles an `InstancedMesh` contributes to the chunks (plan-582 §6c M5):
 * the per-group validity arithmetic of {@link addItems} with the items left
 * out. An ordinary mesh contributes nothing — instances are what is counted.
 */
function countInstancedTriangles(mesh: Mesh): number {
  const instanced = (mesh as InstancedMesh).isInstancedMesh === true ? (mesh as InstancedMesh) : null;
  if (!instanced) return 0;
  const geometry = mesh.geometry;
  const total = geometry.index ? geometry.index.count : geometry.getAttribute('position').count;
  const whole = (entries: number): number => Math.floor(entries / 3) * instanced.count;
  if (Array.isArray(mesh.material)) {
    const mats = mesh.material;
    if (geometry.groups.length === 0) return mats[0] ? whole(total) : 0;
    let sum = 0;
    for (const g of geometry.groups) {
      const material = mats[g.materialIndex ?? 0];
      if (!material) continue;
      const start = Math.min(g.start, total);
      const count = Math.min(g.count === Infinity ? total - start : g.count, total - start);
      // Whole triangles only.
      const count3 = count - (count % 3);
      if (count3 <= 0) continue;
      sum += whole(count3);
    }
    return sum;
  }
  if (!mesh.material) return 0;
  return whole(total);
}

/**
 * The ITEM pass (plan-582 §2.4): material bucketing, items, chunk keys and the
 * boundary frames. Runs only inside {@link bake}, AFTER the material phase, and
 * takes the role pass's result as INPUT instead of re-deriving it.
 *
 * It walks the staged LIST, not the tree — the role pass recorded each staged
 * mesh with its boundary, partition and pick owner in DFS order, so every chunk
 * is created and every item pushed in exactly the order the combined pass
 * produced. Chunk keys and boundary inverses are read off the material and
 * matrix state of the BAKE, never of the pre-material tree: the draw-call
 * contract of `contract-bake-picking.md` § 1.3 is untouched.
 */
function bucketItems(root: Object3D, roles: RoleClassification, uber: Material | null): TreePlan {
  const rootInverse = new Matrix4().copy(root.matrixWorld).invert();
  const plan: TreePlan = {
    chunks: new Map(),
    keep: roles.keep.slice(),
    logicNodes: roles.logicNodes.slice(),
    rootInverse,
    staged: roles.staged,
    instancedTriangles: roles.instancedTriangles,
  };
  // One ChunkContext per boundary, and one per (boundary, partition) below it —
  // the same identity sharing the combined pass had, so a chunk key is produced
  // once per distinct combination.
  const frames = new Map<BoundaryRole, ChunkContext>();
  const derived = new Map<ChunkContext, Map<string, ChunkContext>>();
  const frameOf = (b: BoundaryRole): ChunkContext => {
    let ctx = frames.get(b);
    if (!ctx) {
      ctx = {
        owner: b.owner,
        ownerPath: b.ownerPath,
        inverse: b.owner === root ? rootInverse : new Matrix4().copy(b.owner.matrixWorld).invert(),
        keyPrefix: b.keyPrefix,
        partition: '',
        labels: NO_PARTITION,
      };
      frames.set(b, ctx);
    }
    return ctx;
  };
  /** The context of `partition` inside `b` — same owner, same frame, own key. */
  const contextOf = (b: BoundaryRole, partition: string, labels: readonly string[]): ChunkContext => {
    const base = frameOf(b);
    if (partition === '') return base;
    let byPartition = derived.get(base);
    if (!byPartition) derived.set(base, (byPartition = new Map()));
    let ctx = byPartition.get(partition);
    if (!ctx) {
      ctx = {
        owner: base.owner,
        ownerPath: base.ownerPath,
        inverse: base.inverse,
        keyPrefix: (base.keyPrefix ? base.keyPrefix + '|' : '') + 'grp:' + partition,
        partition,
        labels,
      };
      byPartition.set(partition, ctx);
    }
    return ctx;
  };

  for (const sr of roles.stagedRoles) {
    addItems(plan, sr.mesh, contextOf(sr.boundary, sr.partition, sr.labels), sr.pickNode, sr.order, uber);
  }
  return plan;
}

/** Add one mesh (whole, or one item per material group) to its chunk plan(s). */
function addItems(
  plan: TreePlan,
  mesh: Mesh,
  ctx: ChunkContext,
  pickNode: Object3D,
  order: number,
  uber: Material | null,
): void {
  const geometry = mesh.geometry;
  // `InstancedMesh` is no exception (plan-754 D6): every instance is staged
  // with its instance matrix like any other mesh — instances are not nodes.
  const instanced = (mesh as InstancedMesh).isInstancedMesh === true ? (mesh as InstancedMesh) : null;
  const instanceMatrices: (Matrix4 | null)[] = [];
  if (instanced) {
    for (let i = 0; i < instanced.count; i++) {
      const im = new Matrix4();
      instanced.getMatrixAt(i, im);
      instanceMatrices.push(im);
    }
  } else {
    instanceMatrices.push(null);
  }
  const push = (material: Material, groupStart: number, groupCount: number): void => {
    const isUber = uber !== null && material === uber && isGeometryUberBaked(geometry);
    const key = isUber
      ? (ctx.keyPrefix || 'static')
      : (ctx.keyPrefix ? ctx.keyPrefix + '|' : '') + 'tex:' + material.uuid;
    let cp = plan.chunks.get(key);
    if (!cp) {
      cp = { key, ctx, material, uber: isUber, items: [], layout: UBER_ARENA_LAYOUT };
      plan.chunks.set(key, cp);
    }
    for (const instanceMatrix of instanceMatrices) {
      cp.items.push({
        mesh, material, groupStart, groupCount, pickNode, order, ctx, instanceMatrix,
        segOrdinal: 0, ownerOrdinal: 0,
      });
    }
  };

  if (Array.isArray(mesh.material)) {
    const mats = mesh.material;
    const total = geometry.index ? geometry.index.count : geometry.getAttribute('position').count;
    if (geometry.groups.length === 0) {
      if (mats[0]) push(mats[0], -1, 0);
      return;
    }
    for (const g of geometry.groups) {
      const material = mats[g.materialIndex ?? 0];
      if (!material) continue;
      const start = Math.min(g.start, total);
      const count = Math.min(g.count === Infinity ? total - start : g.count, total - start);
      // Whole triangles only.
      const count3 = count - (count % 3);
      if (count3 <= 0) continue;
      push(material, start, count3);
    }
    return;
  }
  if (!mesh.material) return;
  push(mesh.material as Material, -1, 0);
}

/**
 * What can NOT be merged into a triangle chunk (plan-754 D6): a skinned mesh
 * (flag, bound skeleton, or skin attributes on the geometry) and anything with
 * morph targets (influences on the mesh or morph attributes on the geometry).
 * Non-`Mesh` drawables (Line / Points / Sprite) are gated in `classifyRoles`.
 */
function isSkinnedOrMorphed(mesh: Mesh): boolean {
  const m = mesh as Mesh & { skeleton?: unknown; isSkinnedMesh?: boolean };
  if (m.isSkinnedMesh === true || m.skeleton) return true;
  if (mesh.morphTargetInfluences && mesh.morphTargetInfluences.length > 0) return true;
  const g = mesh.geometry;
  if (g.getAttribute('skinIndex') || g.getAttribute('skinWeight')) return true;
  const morph = g.morphAttributes as Record<string, unknown[] | undefined> | undefined;
  if (morph) for (const key in morph) if (morph[key]?.length) return true;
  return false;
}

/**
 * An `InstancedMesh` with per-instance colours cannot be expanded into a chunk
 * that shares ONE material and no per-instance state — it stays a keep mesh.
 */
function hasPerInstanceColor(mesh: Mesh): boolean {
  const im = mesh as InstancedMesh;
  return im.isInstancedMesh === true && !!im.instanceColor;
}

/**
 * Mesh-level `keep`: runtime helpers whose material or geometry is mutated
 * per instance (the single exclusion list since plan-753 Phase 4b):
 *  - sensor ray / tank fill visualisation (`_sensorViz`, `_tankFillViz`),
 *  - lamp meshes and scene-button caps (material swap),
 *  - Pipe / Tank fluid colour, energy-chain rig sidecars,
 *  - pipeline artefacts and overlays (never on a master, guarded anyway),
 *  - under a TransportSurface, every mesh with a scrollable `map`:
 *    `cloneScrollableMaps` clones the map PER INSTANCE and scrolls its
 *    offset every tick — a shared chunk material cannot carry that,
 *  - under a Sensor, the `Ray` marker mesh (`RAY_CHILD_NAME` convention of
 *    rv-sensor.ts) and the runtime `_sensorRay` tube: the component derives
 *    its beam from that sub-tree and re-colours the tube per instance.
 */
const RAY_CHILD_NAME = /^Ray(_\d+|[_ ]?\(\d+\))?$/;

function isMeshLevelKeep(mesh: Mesh, underTransport: boolean, underSensor: boolean): boolean {
  const ud = (mesh.userData ?? {}) as Record<string, unknown>;
  if (ud._rvBakeChunk) return true;
  if (ud._highlightOverlay || ud._driveHoverOverlay || ud._isGhostOverlay) return true;
  const p = mesh.parent?.userData as Record<string, unknown> | undefined;
  if (ud._rvLampMesh || p?._rvLampMesh) return true;
  if (ud._rvSceneButtonMesh || p?._rvSceneButtonMesh) return true;
  if (mesh.name.endsWith('_sensorViz') || mesh.name.endsWith('_sensorRay') || mesh.name === '_tankFillViz') return true;
  if (ud._rvType === 'Pipe' || ud._rvType === 'Tank') return true;
  if (p && (p._rvType === 'Pipe' || p._rvType === 'Tank')) return true;
  if (isRuntimeRigMesh(mesh)) return true;
  if (underTransport && hasScrollableMap(mesh.material)) return true;
  if (underSensor && RAY_CHILD_NAME.test(mesh.name)) return true;
  return false;
}

function hasScrollableMap(material: Material | Material[]): boolean {
  const mats = Array.isArray(material) ? material : [material];
  for (const m of mats) {
    if ((m as Material & { map?: unknown })?.map) return true;
  }
  return false;
}

/** Union of every item's attribute layout (textured chunks) — position first. */
function unionLayout(items: readonly StageItem[]): ArenaAttrSpec[] {
  const byName = new Map<string, number>();
  for (const it of items) {
    for (const spec of arenaLayoutOf(it.mesh.geometry)) {
      if (!byName.has(spec.name)) byName.set(spec.name, spec.itemSize);
    }
  }
  if (!byName.has('position')) byName.set('position', 3);
  if (!byName.has('normal')) byName.set('normal', 3);
  return [...byName.keys()].sort((a, b) => (a === 'position' ? -1 : b === 'position' ? 1 : a.localeCompare(b)))
    .map((name) => ({ name, itemSize: byName.get(name)! }));
}

// ─── Survival ordinals + node table (plan-756 P1/P2, §2.3) ──────────

/**
 * Pre-order numbering of the SURVIVING nodes of a bake, hoisted in front of
 * staging (plan-756 P2).
 *
 * The set is the same question `buildTemplateGraph` asks for the template — what
 * does anybody still need — but it has to be answered EARLIER, because the
 * ordinals are what items are ordered by (P1). It is computed from the
 * classification alone (keep meshes, logic nodes, chunk owners, pick nodes) plus
 * the survival model's verdict, closed under ancestors. It can therefore be a
 * hair LARGER than the template's own required set (a chunk plan that stages
 * nothing still contributes its owner); that only ever adds an ordinal without
 * geometry, and {@link buildTemplateGraph} degenerates such an entry to the root.
 *
 * plan-755 partition objects are deliberately absent: they are created by
 * `buildTemplateGraph`, long after this runs, so a segment's node is always a
 * REAL surviving node (plan §2.4a.9).
 */
interface BakeOrdinals {
  /** Ordinal → node. `tmp` nodes until the template re-points them in place. */
  nodes: Object3D[];
  /** Node → ordinal (`tmp` keys — only used before the template exists). */
  ordinalOf: Map<Object3D, number>;
  /** Ordinal → ordinal of the nearest surviving ANCESTOR; -1 for the root. */
  parent: Int32Array;
  /** Ordinal → last ordinal of its subtree (inclusive). */
  subtreeEnd: Uint32Array;
}

function computeBakeOrdinals(
  root: Object3D,
  plan: TreePlan,
  survives?: (node: Object3D) => boolean,
): BakeOrdinals {
  const survivors = new Set<Object3D>([root]);
  const require = (node: Object3D): void => {
    for (let c: Object3D | null = node; c && !survivors.has(c); c = c.parent) survivors.add(c);
  };
  for (const k of plan.keep) require(k.mesh);
  for (const l of plan.logicNodes) require(l.template);
  for (const cp of plan.chunks.values()) {
    require(cp.ctx.owner);
    for (const item of cp.items) require(item.pickNode);
  }
  if (survives) root.traverse((n) => { if (survives(n)) require(n); });

  const nodes: Object3D[] = [];
  const ordinalOf = new Map<Object3D, number>();
  const parent: number[] = [];
  const subtreeEnd: number[] = [];
  const walk = (node: Object3D, inherited: number): void => {
    let ordinal = inherited;
    if (survivors.has(node)) {
      ordinal = nodes.length;
      nodes.push(node);
      ordinalOf.set(node, ordinal);
      parent.push(inherited);
      subtreeEnd.push(ordinal);
    }
    for (const child of node.children) walk(child, ordinal);
    if (ordinal !== inherited) subtreeEnd[ordinal] = nodes.length - 1;
  };
  walk(root, -1);
  return {
    nodes,
    ordinalOf,
    parent: Int32Array.from(parent),
    subtreeEnd: Uint32Array.from(subtreeEnd),
  };
}

/** Ordinal of the nearest surviving ancestor-or-self of `node` (root = 0). */
function nearestOrdinal(ordinals: BakeOrdinals, node: Object3D): number {
  for (let c: Object3D | null = node; c; c = c.parent) {
    const o = ordinals.ordinalOf.get(c);
    if (o !== undefined) return o;
  }
  return 0;
}

/**
 * The asset's CSR node table (plan-756 §2.3).
 *
 * One row per (surviving node, chunk) pair whose SUBTREE has segments in that
 * chunk — sparse by construction, because a dense `chunks × nodes` layout would
 * be ~40 MB on the large CAD line and blow the memory gate on its own. A node's subtree
 * is the ordinal interval `[n, subtreeEnd[n]]` and a chunk's segments are sorted
 * by node ordinal, so the subtree's segments are one contiguous run per chunk
 * (that IS the P1 guarantee) and `first`/`last` describe it exactly.
 *
 * Built by walking each segment's ancestor chain, which is what bounds the row
 * count by `segments + Σ depth(segment node)`.
 */
function buildNodeTable(ordinals: BakeOrdinals, chunks: readonly BakedChunk[]): NodeTable<BakedChunk> {
  const count = ordinals.nodes.length;
  const rows = new Map<number, Map<number, { first: number; last: number }>>();
  let rowCount = 0;
  for (let ci = 0; ci < chunks.length; ci++) {
    const pick = chunks[ci].pick;
    for (let s = 0; s < pick.segmentCount; s++) {
      for (let a = pick.segNode[s]; a >= 0; a = ordinals.parent[a]) {
        let byChunk = rows.get(a);
        if (!byChunk) rows.set(a, (byChunk = new Map()));
        const row = byChunk.get(ci);
        if (!row) {
          byChunk.set(ci, { first: s, last: s });
          rowCount++;
        } else {
          if (s < row.first) row.first = s;
          if (s > row.last) row.last = s;
        }
      }
    }
  }
  const rowStart = new Uint32Array(count + 1);
  const rowChunk = new Uint32Array(rowCount);
  const rowFirstSeg = new Uint32Array(rowCount);
  const rowLastSeg = new Uint32Array(rowCount);
  let w = 0;
  for (let a = 0; a < count; a++) {
    rowStart[a] = w;
    const byChunk = rows.get(a);
    if (byChunk) {
      for (const ci of [...byChunk.keys()].sort((x, y) => x - y)) {
        const row = byChunk.get(ci)!;
        rowChunk[w] = ci;
        rowFirstSeg[w] = row.first;
        rowLastSeg[w] = row.last;
        w++;
      }
    }
  }
  rowStart[count] = w;
  const ordinalOf = new WeakMap<Object3D, number>();
  for (let i = 0; i < count; i++) ordinalOf.set(ordinals.nodes[i], i);
  return {
    nodes: ordinals.nodes,
    ordinalOf,
    subtreeEnd: ordinals.subtreeEnd,
    chunks: [...chunks],
    rowStart,
    rowChunk,
    rowFirstSeg,
    rowLastSeg,
  };
}

/**
 * Does an opaque chunk OCCLUDE a node pick (plan-756 Q5)?
 *
 * The one place the rule lives: a chunk blocks unless its material is
 * see-through — `transparent`, an `alphaTest` cut-out ("glass") or an `opacity`
 * below 1. Everything else counts as opaque, so a segment without a pick owner
 * stops the ray there instead of letting a hidden part behind a housing light
 * up; a guard behind real safety glass stays selectable.
 */
/**
 * Is `node` a GENUINE pick owner (plan-756 Q5)?
 *
 * `StageItem.pickNode` is "nearest pickable ancestor-or-self, else the chunk
 * boundary" — the fallback is a boundary that may have no pick mode at all, and
 * the static chunk's fallback is the asset ROOT. Such a segment owns nothing:
 * its triangles are geometry that was merged away and has no addressable node
 * left, which is exactly the case an opaque chunk must BLOCK instead of letting
 * the ray through (the old window table expressed the same rule as "a hit in
 * the root's catch-all window resolves to null").
 *
 * A `PlacementMeta` root counts as an owner although it declares no pick mode:
 * a saved planner placement reloaded through a forced split must stay
 * selectable as a whole, exactly like a session placement (plan-753 Phase 4b).
 */
function isPickOwner(node: Object3D, root: Object3D): boolean {
  if (node === root) return false;
  return pickModeOf(node) !== 'none' || getPlacementMeta(node) !== null;
}

function materialBlocks(material: Material): boolean {
  const m = material as Material & { opacity?: number; alphaTest?: number };
  if (m.transparent === true) return false;
  if ((m.alphaTest ?? 0) > 0) return false;
  if ((m.opacity ?? 1) < 1) return false;
  return true;
}

// ─── Staging ────────────────────────────────────────────────────────

const _tmpBox = new Box3();
const _m = new Matrix4();
const _nm = new Matrix3();
const _v = new Vector3();

interface PreparedItem {
  item: StageItem;
  canonical: BufferGeometry;
  /** Vertex ids of the canonical geometry this item writes, or null = all. */
  usedIds: Uint32Array | null;
  /** canonical vertex id → item-local vertex id (group items only). */
  remap: Int32Array | null;
  vertexCount: number;
  indexStart: number;
  indexCount: number;
}

function isU8Attr(name: string): boolean {
  return name === 'color' || name === 'rmPacked';
}

/**
 * What {@link stageChunk} produces: everything a chunk geometry needs, as plain
 * arrays (plan-756 §2.4). The `BufferGeometry` is built by {@link finishChunk}
 * once the pick build handed `position` and `index` back — between the two,
 * `position` / `index` are `null` here, which makes "nothing on the main thread
 * references a transferred buffer" a property of the type rather than a rule.
 */
interface StagedChunk {
  plan: ChunkPlan;
  /** Attribute arrays, `position` included (and also mirrored in `position`). */
  attributes: Map<string, Float32Array | Uint8Array>;
  /** Handed to the pick build; `null` while the build owns it. */
  position: Float32Array | null;
  /** Handed to the pick build; `null` while the build owns it. */
  index: Uint32Array | null;
  /** Pre-order runs of one surviving node (plan-756 P1), sorted by indexStart. */
  segments: PickSegmentInput[];
  bounds: Box3;
  vertices: number;
  triangles: number;
  blocks: boolean;
  doubleSided: boolean;
}

/**
 * Stage one chunk plan into raw arrays. Synchronous, copy-only and free of side
 * effects — the master's geometries are read, never written, which is what makes
 * a re-stage after a dead worker safe (plan §2.4a.8). Returns `null` for a chunk
 * without triangles.
 */
function stageChunk(
  cp: ChunkPlan,
  root: Object3D,
  onStaged?: (mesh: Mesh, chunkKey: string) => void,
): StagedChunk | null {
  const layout = cp.layout;

  // Pass 1 — canonicalize + count.
  const canonCache = new Map<BufferGeometry, BufferGeometry>();
  const prepared: PreparedItem[] = [];
  let totalV = 0;
  let totalI = 0;
  for (const item of cp.items) {
    const src = item.mesh.geometry;
    let canonical = canonCache.get(src);
    if (!canonical) {
      canonical = canonicalizeForArena(src, layout);
      canonCache.set(src, canonical);
    }
    const index = canonical.index!;
    let usedIds: Uint32Array | null = null;
    let remap: Int32Array | null = null;
    let vertexCount: number;
    let indexStart: number;
    let indexCount: number;
    if (item.groupStart < 0) {
      vertexCount = canonical.getAttribute('position').count;
      indexStart = 0;
      indexCount = index.count;
    } else {
      indexStart = item.groupStart;
      indexCount = Math.min(item.groupCount, index.count - indexStart);
      const srcV = canonical.getAttribute('position').count;
      remap = new Int32Array(srcV).fill(-1);
      const ids: number[] = [];
      for (let k = indexStart; k < indexStart + indexCount; k++) {
        const v = index.getX(k);
        if (remap[v] < 0) {
          remap[v] = ids.length;
          ids.push(v);
        }
      }
      usedIds = Uint32Array.from(ids);
      vertexCount = ids.length;
    }
    indexCount -= indexCount % 3;
    if (indexCount <= 0) continue;
    prepared.push({ item, canonical, usedIds, remap, vertexCount, indexStart, indexCount });
    totalV += vertexCount;
    totalI += indexCount;
  }
  if (totalI === 0) return null;

  // Allocate once.
  const arrays = new Map<string, Float32Array | Uint8Array>();
  for (const spec of layout) {
    arrays.set(spec.name, isU8Attr(spec.name)
      ? new Uint8Array(totalV * spec.itemSize)
      : new Float32Array(totalV * spec.itemSize));
  }
  const outIndex = new Uint32Array(totalI);
  const outPos = arrays.get('position') as Float32Array;
  const outNormal = arrays.get('normal') as Float32Array | undefined;
  const bounds = new Box3();

  // Pass 2 — write, tracking one SEGMENT per run of the same
  // (surviving node, pick owner) pair (plan-756 P1).
  const segments: PickSegmentInput[] = [];
  let dstV = 0;
  let dstI = 0;
  let segOrdinal = -1;
  let segOwner = -1;
  let segStart = 0;
  let hasSegment = false;
  for (const p of prepared) {
    const { item, canonical } = p;
    if (!hasSegment || item.segOrdinal !== segOrdinal || item.ownerOrdinal !== segOwner) {
      if (hasSegment) {
        segments.push({ indexStart: segStart, indexCount: dstI - segStart, node: segOrdinal, owner: segOwner });
      }
      segOrdinal = item.segOrdinal;
      segOwner = item.ownerOrdinal;
      segStart = dstI;
      hasSegment = true;
    }

    _m.multiplyMatrices(item.ctx.inverse, item.mesh.matrixWorld);
    if (item.instanceMatrix) _m.multiply(item.instanceMatrix);
    const flip = _m.determinant() < 0;
    _nm.getNormalMatrix(_m);

    // Attributes.
    for (const spec of layout) {
      const out = arrays.get(spec.name)!;
      const attr = canonical.getAttribute(spec.name) as BufferAttribute;
      const srcArr = attr.array as Float32Array | Uint8Array;
      const n = spec.itemSize;
      if (spec.name === 'position') {
        for (let v = 0; v < p.vertexCount; v++) {
          const s = (p.usedIds ? p.usedIds[v] : v) * 3;
          _v.set(srcArr[s], srcArr[s + 1], srcArr[s + 2]).applyMatrix4(_m);
          const d = (dstV + v) * 3;
          outPos[d] = _v.x; outPos[d + 1] = _v.y; outPos[d + 2] = _v.z;
          bounds.expandByPoint(_v);
        }
      } else if (spec.name === 'normal') {
        for (let v = 0; v < p.vertexCount; v++) {
          const s = (p.usedIds ? p.usedIds[v] : v) * 3;
          _v.set(srcArr[s], srcArr[s + 1], srcArr[s + 2]).applyMatrix3(_nm).normalize();
          const d = (dstV + v) * 3;
          outNormal![d] = _v.x; outNormal![d + 1] = _v.y; outNormal![d + 2] = _v.z;
        }
      } else if (!p.usedIds) {
        (out as Float32Array).set(srcArr.subarray(0, p.vertexCount * n) as Float32Array, dstV * n);
      } else {
        for (let v = 0; v < p.vertexCount; v++) {
          const s = p.usedIds[v] * n;
          const d = (dstV + v) * n;
          for (let c = 0; c < n; c++) out[d + c] = srcArr[s + c];
        }
      }
    }

    // Index — rebased, remapped for group items, winding flipped for mirrors.
    const srcIndex = canonical.index!;
    const end = p.indexStart + p.indexCount;
    onStaged?.(item.mesh, cp.key);
    for (let k = p.indexStart; k < end; k += 3) {
      let a = srcIndex.getX(k);
      let b = srcIndex.getX(k + 1);
      let c = srcIndex.getX(k + 2);
      if (p.remap) { a = p.remap[a]; b = p.remap[b]; c = p.remap[c]; }
      outIndex[dstI] = dstV + a;
      if (flip) {
        outIndex[dstI + 1] = dstV + c;
        outIndex[dstI + 2] = dstV + b;
      } else {
        outIndex[dstI + 1] = dstV + b;
        outIndex[dstI + 2] = dstV + c;
      }
      dstI += 3;
    }
    dstV += p.vertexCount;
  }
  if (hasSegment) {
    segments.push({ indexStart: segStart, indexCount: dstI - segStart, node: segOrdinal, owner: segOwner });
  }

  return {
    plan: cp,
    attributes: arrays,
    position: outPos,
    index: outIndex,
    segments,
    bounds,
    vertices: totalV,
    triangles: totalI / 3,
    blocks: materialBlocks(cp.material),
    doubleSided: cp.material.side !== FrontSide,
  };
}

/**
 * Turn a staged chunk plus the arrays the pick build handed back into the
 * published {@link BakedChunk} (plan-756 §2.4).
 *
 * THE single-ownership rule in one function: the `BufferGeometry` is created
 * here and nowhere else, from the RETURNED arrays — the ones staging allocated
 * were transferred away and are detached.
 */
function finishChunk(
  st: StagedChunk,
  position: Float32Array,
  index: Uint32Array,
  pick: ChunkPickData,
  root: Object3D,
): BakedChunk {
  const cp = st.plan;
  const geometry = new BufferGeometry();
  for (const spec of cp.layout) {
    const array = spec.name === 'position' ? position : st.attributes.get(spec.name)!;
    geometry.setAttribute(spec.name, new BufferAttribute(array, spec.itemSize, isU8Attr(spec.name)));
  }
  geometry.setIndex(new BufferAttribute(index, 1));
  geometry.boundingBox = st.bounds.clone();
  geometry.computeBoundingSphere();
  geometry.name = cp.key;
  st.attributes.clear();

  return {
    key: cp.key,
    partition: cp.ctx.partition,
    partitionLabels: cp.ctx.labels,
    groupObject: null,
    geometry,
    material: cp.material,
    templateMesh: null,
    ownerPath: cp.ctx.owner === root ? null : cp.ctx.ownerPath,
    owner: cp.ctx.owner,
    bounds: st.bounds,
    triangles: st.triangles,
    pick,
    blocks: st.blocks,
  };
}

/** One line for a rejected pick build's reason. */
function describeReason(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  if (typeof reason === 'string') return reason;
  try {
    return JSON.stringify(reason) ?? String(reason);
  } catch {
    return String(reason);
  }
}

// ─── Event-loop yield ───────────────────────────────────────────────

/** One macrotask via MessageChannel (same pattern as the BVH port's inline path). */
function yieldToEventLoop(): Promise<void> {
  if (typeof MessageChannel === 'undefined') return Promise.resolve();
  return new Promise<void>((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });
}
