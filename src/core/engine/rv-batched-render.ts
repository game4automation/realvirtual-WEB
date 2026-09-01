// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-batched-render.ts — BatchedMesh (multi-draw) arena builders.
 *
 * The scene is partitioned into MOTION BLOBS — sets of meshes that move
 * together:
 *   - ONE static blob (everything with a frozen transform), anchored at the
 *     model root
 *   - ONE blob per Drive subtree (stopping at nested child drives), anchored
 *     at the drive node — the arena is parented UNDER the drive, so drive
 *     motion moves the whole blob via normal parent-matrix propagation
 *     (no per-frame matrix uploads)
 *
 * Within every blob the meshes collapse into:
 *   - one UBER arena — all meshes on the shared RVUberMaterial singleton
 *     (untextured, baked per-vertex color/roughness/metalness)
 *   - one arena PER TEXTURED MATERIAL (× attribute signature) — including
 *     transparent materials (their arenas keep `sortObjects = true` for
 *     per-instance back-to-front ordering)
 *
 * Unique geometries are stored ONCE per arena (`addGeometry`) and referenced
 * by N instances (`addInstance`). Visibility is per instance (`setVisibleAt`,
 * driven by the BatchVisibilityService) — no owner buckets, no chunk
 * parenting, no minimum-bucket skips.
 *
 * The ONLY meshes that stay individual are those whose material or transform
 * is mutated at runtime in ways a shared arena cannot express:
 *   - TransportSurface subtrees (per-mesh cloned textures, animated UV offsets)
 *   - Source / Sink / MU subtrees (ghost/template material swaps, instancing)
 *   - Pipe / Tank meshes (runtime fluid-color material swap)
 *   - Cam-driven meshes (per-frame node rotation outside the drive transform)
 *   - sensor viz / tank fill viz (runtime color state), overlay helpers
 *   - skinned / morphed meshes, multi-material meshes
 *   - lone meshes (a 1-instance arena saves nothing)
 *
 * Source meshes stay in the scene graph with `visible = true` and
 * `layers.mask = 0` (see rv-batch-table.ts); they keep serving picking
 * (raycast BVH), highlight overlays and GLB export. Registration happens only
 * after an arena filled successfully — a failed or aborted build leaves every
 * source rendering exactly as before.
 */

import {
  BatchedMesh,
  BufferGeometry,
  Material,
  Matrix4,
  Mesh,
  Object3D,
} from 'three';
import { debug } from './rv-debug';
import type { RVUberMaterial } from './rv-uber-material';
import { BatchTable } from './rv-batch-table';
import {
  arenaLayoutOf,
  arenaSignatureOf,
  canonicalizeForArena,
  flipWinding,
  UBER_ARENA_LAYOUT,
  type ArenaAttrSpec,
} from './rv-mesh-merge-batch';
import { yieldMacrotask } from './rv-mesh-merge-port';
import type { LoadProfiler } from './rv-load-profiler';
import { resolveArenaPlan } from './rv-arena-planner';

export interface SceneBatchBuildOptions {
  /** Abort predicate — checked at every yield point. On abort the partially
   *  built arena is disposed; source meshes are left untouched. */
  shouldAbort?: () => boolean;
  /** Test/diagnostic hook — invoked at the start of every arena build (gives
   *  tests a deterministic interleave point, mirrors the old merge-port spy). */
  onArenaBuild?: () => void;
  /** Optional load-profiler sink for synchronous CPU self-time. */
  profiler?: LoadProfiler;
}

export interface StaticBatchBuildResult {
  /** Source meshes turned into batch instances. */
  instanceCount: number;
  /** BatchedMesh arenas created. */
  batchCount: number;
  /** Distinct geometries stored in the arena(s). */
  uniqueGeometryCount: number;
  /** Total arena vertex capacity. */
  arenaVertices: number;
  /** Total arena index capacity. */
  arenaIndices: number;
  /** Candidates left individual (lone groups / failed arena builds). */
  skippedCount: number;
}

export interface KinematicBatchResult extends StaticBatchBuildResult {
  /** Drive blobs that produced at least one arena. */
  driveGroups: number;
}

export interface SceneBatchResult {
  /** Static blob, uber material arena. */
  staticUber: StaticBatchBuildResult;
  /** Static blob, per-textured-material arenas. */
  staticTextured: StaticBatchBuildResult;
  /** All drive blobs combined (uber + textured arenas per drive). */
  kinematic: KinematicBatchResult;
}

const EMPTY_RESULT: StaticBatchBuildResult = {
  instanceCount: 0, batchCount: 0, uniqueGeometryCount: 0, arenaVertices: 0, arenaIndices: 0, skippedCount: 0,
};

/** Yield-granularity for the arena fill (staged vertices between yields). */
const FILL_YIELD_VERTEX_BUDGET = 500_000;

// ─── Candidate classification ───────────────────────────────────────

/** Ancestor component keys whose SUBTREES mutate materials/templates at
 *  runtime — batching anything below them would freeze that behavior.
 *
 *  `MachiningVolume` (plan-405) is the one entry that mutates GEOMETRY rather
 *  than materials: its `CsgChunks` child rewrites vertex and index buffers
 *  every time the CSG kernel re-tessellates a dirty chunk. The batcher bakes
 *  the HOME pose into a static arena exactly once, so a batched workpiece would
 *  keep showing its uncut shape forever. */
/** `PlacementMeta` marks a planner placement (plan-397 phase 6): the user can
 *  move and delete it at runtime, exactly like a freshly dragged-in library
 *  object — which renders per-object because it arrives AFTER the batch build.
 *  Baking a placement into a static arena froze its frame at the load pose:
 *  dragging moved only the drive-anchored (kinematic) parts — "only the rolls
 *  move" — and deletion would leave the baked geometry behind (2026-09-01,
 *  DemoPlanner). Same rule as the place path, so behavior is identical. */
/** `Chain` (plan-733) is the mover case, not a material case: the component
 *  clones its element template N times at load and writes each clone's position
 *  and rotation every tick. The clones are created in the loader's onSceneReady
 *  pass — BEFORE the batch build — so they would be legitimate candidates, and a
 *  static arena would freeze the whole chain at its start pose. Excluding the
 *  subtree keeps the elements individual meshes, exactly like MU/TransportSurface
 *  geometry; an instanced fast path is a separate follow-up, not a batch entry. */
const EXCLUDED_SUBTREE_KEYS = ['TransportSurface', 'Source', 'Sink', 'MU', 'Cam', 'MachiningVolume', 'PlacementMeta', 'Chain'] as const;

function isSkinnedOrMorphed(mesh: Mesh): boolean {
  if ((mesh as Mesh & { skeleton?: unknown }).skeleton) return true;
  return !!(mesh.morphTargetInfluences && mesh.morphTargetInfluences.length > 0);
}

/** Mesh-level exclusions: runtime-material viz helpers + overlay meshes. */
function isExcludedMesh(mesh: Mesh): boolean {
  const ud = mesh.userData ?? {};
  if (ud._rvBatchSource || ud._rvBatchedRender || ud._rvRaycastBVH) return true;
  if (ud._highlightOverlay || ud._driveHoverOverlay || ud._isGhostOverlay) return true;
  if (ud._rvLampMesh || mesh.parent?.userData?._rvLampMesh) return true;
  // Scene-button caps (plan-417): they translate/rotate every frame and swap
  // material for the button light — baking them into a static arena would
  // freeze both. Only the cap is excluded; the button base stays batched.
  if (ud._rvSceneButtonMesh || mesh.parent?.userData?._rvSceneButtonMesh) return true;
  if (mesh.name.endsWith('_sensorViz') || mesh.name === '_tankFillViz') return true;
  // Pipe/Tank fluid-color material swap (mirrors the uber-bake exclusion).
  if (ud._rvType === 'Pipe' || ud._rvType === 'Tank') return true;
  const p = mesh.parent?.userData;
  if (p && (p._rvType === 'Pipe' || p._rvType === 'Tank')) return true;
  return false;
}

function hasExcludedKey(node: Object3D): boolean {
  const rv = node.userData?.realvirtual as Record<string, unknown> | undefined;
  if (!rv) return false;
  for (const key of EXCLUDED_SUBTREE_KEYS) {
    if (rv[key]) return true;
  }
  return false;
}

/** Returns whether a mesh satisfies every public batching safety rule. */
export function isBatchSafe(
  mesh: Mesh,
  root: Object3D,
): boolean {
  if (!mesh.geometry?.attributes?.position) return false;
  if (!mesh.material || Array.isArray(mesh.material)) return false;
  if (isSkinnedOrMorphed(mesh)) return false;
  if (!mesh.visible || isExcludedMesh(mesh) || hasExcludedKey(mesh)) return false;
  if (mesh === root) return true;

  let ancestor = mesh.parent;
  while (ancestor && ancestor !== root) {
    if (!ancestor.visible || hasExcludedKey(ancestor)) return false;
    ancestor = ancestor.parent;
  }

  // This walk only checks visibility/excluded subtrees; blob classification belongs to the planner.
  return ancestor === root;
}

// ─── Arena fill ─────────────────────────────────────────────────────

interface ArenaFill {
  batch: BatchedMesh;
  uniqueGeometries: number;
  verts: number;
  indices: number;
}

/**
 * Fill one BatchedMesh arena from a blob's mesh group. The arena is parented
 * under `anchor` with instance matrices in anchor-local space — a static
 * anchor (model root) uploads once; a drive anchor moves the whole arena via
 * parent-matrix propagation.
 *
 * Returns null on abort/failure — the partial batch is disposed and NO
 * source mesh was touched.
 */
async function fillArena(
  anchor: Object3D,
  meshes: readonly Mesh[],
  material: Material,
  layout: readonly ArenaAttrSpec[],
  name: string,
  sortObjects: boolean,
  table: BatchTable,
  opts: Required<Pick<SceneBatchBuildOptions, 'shouldAbort'>> & SceneBatchBuildOptions,
): Promise<ArenaFill | null> {
  opts.onArenaBuild?.();
  // One yield up front: guarantees an abort window per arena even for small
  // scenes that never hit the vertex budget below.
  await yieldMacrotask();
  if (opts.shouldAbort()) return null;

  // Unique-geometry set + exact arena sizing. Mirrored (negative-determinant)
  // instances get their own winding-flipped geometry slot: the GL front-face
  // is per draw call, so a mirrored instance sharing the regular index would
  // render inside-out (back faces visible → wrong culling everywhere and
  // inward normals in the GTAO/toon gbuffers — e.g. the scale:[1,1,-1] CNC
  // node in DemoRealvirtualWeb).
  const anchorInverse = new Matrix4().copy(anchor.matrixWorld).invert();
  const _local = new Matrix4();
  const mirrored: boolean[] = new Array(meshes.length);
  const uniqueGeoms: { geom: BufferGeometry; flip: boolean }[] = [];
  const geomSlot = new Map<BufferGeometry, number>();
  const geomSlotFlipped = new Map<BufferGeometry, number>();
  let maxVerts = 0;
  let maxIndices = 0;
  for (let m = 0; m < meshes.length; m++) {
    const mesh = meshes[m];
    _local.multiplyMatrices(anchorInverse, mesh.matrixWorld);
    const flip = _local.determinant() < 0;
    mirrored[m] = flip;
    const slots = flip ? geomSlotFlipped : geomSlot;
    if (slots.has(mesh.geometry)) continue;
    slots.set(mesh.geometry, uniqueGeoms.length);
    uniqueGeoms.push({ geom: mesh.geometry, flip });
    const v = mesh.geometry.getAttribute('position').count;
    maxVerts += v;
    maxIndices += mesh.geometry.index ? mesh.geometry.index.count : v;
  }

  const batch = new BatchedMesh(meshes.length, maxVerts, maxIndices, material);
  batch.name = name;

  try {
    const geometryIds: number[] = new Array(uniqueGeoms.length);
    let stagedVerts = 0;
    for (let g = 0; g < uniqueGeoms.length; g++) {
      const canonicalStart = performance.now();
      let canonical = canonicalizeForArena(uniqueGeoms[g].geom, layout);
      if (uniqueGeoms[g].flip) canonical = flipWinding(canonical);
      opts.profiler?.addSelfTime('buildBatchedScene', 'canonicalize+flip', performance.now() - canonicalStart);
      const addGeometryStart = performance.now();
      geometryIds[g] = batch.addGeometry(canonical);
      opts.profiler?.addSelfTime('buildBatchedScene', 'addGeometry', performance.now() - addGeometryStart);
      stagedVerts += canonical.getAttribute('position').count;
      if (stagedVerts >= FILL_YIELD_VERTEX_BUDGET) {
        stagedVerts = 0;
        await yieldMacrotask();
        if (opts.shouldAbort()) {
          batch.dispose();
          return null;
        }
      }
    }

    // Instances in anchor-local space.
    const pending: { mesh: Mesh; instanceId: number }[] = [];
    const instancesStart = performance.now();
    for (let m = 0; m < meshes.length; m++) {
      const mesh = meshes[m];
      const slots = mirrored[m] ? geomSlotFlipped : geomSlot;
      const instanceId = batch.addInstance(geometryIds[slots.get(mesh.geometry)!]);
      _local.multiplyMatrices(anchorInverse, mesh.matrixWorld);
      batch.setMatrixAt(instanceId, _local);
      pending.push({ mesh, instanceId });
    }
    opts.profiler?.addSelfTime('buildBatchedScene', 'instances', performance.now() - instancesStart);

    // Success — apply the source contract only now (no silent geometry loss).
    for (const { mesh, instanceId } of pending) {
      table.register(mesh, { batch, instanceId });
    }
  } catch (e) {
    console.warn(`[BatchedRender] arena build failed for ${name} — sources keep rendering individually:`, e);
    batch.dispose();
    return null;
  }

  batch.castShadow = true;
  batch.receiveShadow = true;
  batch.matrixAutoUpdate = false; // local transform stays identity under the anchor
  batch.frustumCulled = true;
  batch.perObjectFrustumCulled = true;
  batch.sortObjects = sortObjects;
  // Not interactive — picking resolves via the separate raycast BVH path.
  batch.raycast = () => {};
  batch.userData._rvBatchedRender = true;
  batch.userData._rvSkipBVH = true;
  batch.computeBoundingBox();
  batch.computeBoundingSphere();
  anchor.add(batch);
  batch.updateMatrixWorld(true);
  table.addBatch(batch, uniqueGeoms.length, maxVerts, maxIndices);

  return { batch, uniqueGeometries: uniqueGeoms.length, verts: maxVerts, indices: maxIndices };
}

// ─── Blob batching ──────────────────────────────────────────────────

/** Accumulate an ArenaFill into a result. */
function accumulate(into: StaticBatchBuildResult, fill: ArenaFill, instances: number): void {
  into.instanceCount += instances;
  into.batchCount += 1;
  into.uniqueGeometryCount += fill.uniqueGeometries;
  into.arenaVertices += fill.verts;
  into.arenaIndices += fill.indices;
}

/** Single non-array material, or null. */
function singleMaterial(mesh: Mesh): Material | null {
  const m = mesh.material;
  if (!m || Array.isArray(m)) return null;
  return m as Material;
}

/**
 * Build every arena for the whole scene: static blob + one blob per drive,
 * each split into an uber arena and per-textured-material arenas.
 *
 * MUST run in the loader's home-pose window (Phase 10c-10e): drive-local
 * instance matrices are baked against the drives' HOME transforms, exactly
 * like the retired kinematic chunk merge.
 */
export async function buildBatchedScene(
  root: Object3D,
  sharedUber: RVUberMaterial | null,
  driveNodeSet: ReadonlySet<Object3D>,
  table: BatchTable,
  options?: SceneBatchBuildOptions,
): Promise<SceneBatchResult> {
  const opts = {
    shouldAbort: options?.shouldAbort ?? ((): boolean => false),
    onArenaBuild: options?.onArenaBuild,
    profiler: options?.profiler,
  };

  const result: SceneBatchResult = {
    staticUber: { ...EMPTY_RESULT },
    staticTextured: { ...EMPTY_RESULT },
    kinematic: { ...EMPTY_RESULT, driveGroups: 0 },
  };

  const partitionStart = performance.now();

  const candidates: Mesh[] = [];
  root.updateWorldMatrix(true, true);
  root.traverse((node) => {
    if (!(node as Mesh).isMesh) return;
    if ((node as unknown as { isBatchedMesh?: boolean }).isBatchedMesh) return;
    const mesh = node as Mesh;
    if (isBatchSafe(mesh, root)) candidates.push(mesh);
  });
  const resolved = resolveArenaPlan(root, candidates, {
    sharedUber,
    driveNodeSet,
    shouldAbort: opts.shouldAbort,
  });

  // Signature is a correctness split for textured arenas; uber arenas canonicalize
  // to UBER_ARENA_LAYOUT and stay unsplit for cs:9438 parity.
  const executable: { anchor: Object3D | null; material: Material; meshes: Mesh[]; uber: boolean }[] = [];
  const planned = new Set<Mesh>();
  for (const group of resolved.groups) {
    const byMaterial = new Map<Material, Map<string, Mesh[]>>();
    const uberMeshes: Mesh[] = [];
    for (const mesh of group.meshes) {
      planned.add(mesh);
      const material = singleMaterial(mesh)!;
      const uber = !!sharedUber
        && material === sharedUber
        && mesh.userData?._rvUberBaked === true;
      if (uber) {
        uberMeshes.push(mesh);
        continue;
      }
      let bySignature = byMaterial.get(material);
      if (!bySignature) {
        bySignature = new Map();
        byMaterial.set(material, bySignature);
      }
      const signature = arenaSignatureOf(mesh.geometry);
      let meshes = bySignature.get(signature);
      if (!meshes) {
        meshes = [];
        bySignature.set(signature, meshes);
      }
      meshes.push(mesh);
    }
    if (uberMeshes.length >= 2) {
      executable.push({
        anchor: group.anchor,
        material: sharedUber!,
        meshes: uberMeshes,
        uber: true,
      });
    }
    for (const [material, bySignature] of byMaterial) {
      for (const meshes of bySignature.values()) {
        if (meshes.length < 2) continue;
        executable.push({
          anchor: group.anchor,
          material,
          meshes,
          uber: false,
        });
      }
    }
  }

  for (const mesh of candidates) {
    if (planned.has(mesh)) continue;
    const material = singleMaterial(mesh);
    const uber = !!sharedUber && material === sharedUber && mesh.userData?._rvUberBaked === true;
    if (mesh.matrixAutoUpdate === false) (uber ? result.staticUber : result.staticTextured).skippedCount++;
    else result.kinematic.skippedCount++;
  }
  opts.profiler?.addSelfTime('buildBatchedScene', 'classify/partition', performance.now() - partitionStart);
  if (opts.shouldAbort()) return result;

  const drivesWithArenas = new Set<Object3D>();
  let arenaIdx = 0;
  for (const group of executable) {
    if (opts.shouldAbort()) return result;
    const into = group.anchor === null
      ? (group.uber ? result.staticUber : result.staticTextured)
      : result.kinematic;
    const transparent = !group.uber && group.material.transparent === true;
    const prefix = group.anchor === null
      ? (group.uber ? '__staticUberBatch' : '__staticTexBatch')
      : (group.uber ? '__driveUberBatch' : '__driveTexBatch');
    const suffix = group.anchor?.name || arenaIdx;
    const fill = await fillArena(
      group.anchor ?? root,
      group.meshes,
      group.material,
      group.uber ? UBER_ARENA_LAYOUT : arenaLayoutOf(group.meshes[0].geometry),
      `${prefix}_${suffix}`,
      transparent,
      table,
      opts,
    );
    arenaIdx++;
    if (!fill) {
      into.skippedCount += group.meshes.length;
      continue;
    }
    accumulate(into, fill, group.meshes.length);
    if (group.anchor) drivesWithArenas.add(group.anchor);
  }
  result.kinematic.driveGroups = drivesWithArenas.size;

  const s = result.staticUber;
  const t = result.staticTextured;
  const k = result.kinematic;
  console.log(
    `[BatchedRender] static uber: ${s.instanceCount} meshes → ${s.batchCount} batch (${s.uniqueGeometryCount} geoms) · ` +
    `static textured: ${t.instanceCount} meshes → ${t.batchCount} batches (${t.skippedCount} lone) · ` +
    `kinematic: ${k.instanceCount} meshes → ${k.batchCount} batches across ${k.driveGroups} drives (${k.skippedCount} lone) · ` +
    `arena total ${(s.arenaVertices + t.arenaVertices + k.arenaVertices).toLocaleString()} verts · planner=${resolved.planner}`,
  );
  debug('loader',
    `[BatchedRender] ${s.instanceCount + t.instanceCount + k.instanceCount} meshes → ` +
    `${s.batchCount + t.batchCount + k.batchCount} arenas · planner=${resolved.planner}`,
  );

  return result;
}
