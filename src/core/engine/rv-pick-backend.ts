// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-pick-backend.ts — the pick backend of every baked model (plan-756 step 1d)
 * and the `.raycast` INSTANCE override that routes stray `THREE.Raycaster`
 * users into the very same structure.
 *
 * It replaces `rv-chunk-pick-backend.ts` (deleted with this step): there is no
 * chunk `boundsTree` any more, no `asset.ready`, no native-raycast window. A
 * chunk is published with its {@link ChunkPickData} (plan F1), so the first
 * ray after scene entry is as fast as the thousandth.
 *
 * **Structure-free mode (plan-757 Phase 3 commit B).** The backend has ONE
 * rollback of its own, independent of the bake: with the dev flag
 * `rv-webviewer-pick-structure` = `0` (`rv-dev-load-flags.ts`, read when the
 * backend is built, i.e. per model load) every chunk is picked by the LINEAR
 * walk of `rv-pick-structure.ts` — the segment table in order, one box test
 * per segment, the same watertight triangle test inside, clusters and SAH tree
 * ignored. Owners, occlusion and hidden-node skipping are identical; only the
 * acceleration is gone. The same walk is taken automatically for a chunk the
 * bake published SEGMENT-ONLY because its structure could not be built
 * (`isSegmentOnly`), flag or no flag. The chunk index is never re-sorted by
 * either mode — it is data (§1.5).
 *
 * Three things happen here, and nowhere else:
 *
 *  1. **Broad phase** — `BakeRegistry.pickMeshes`, each mesh pre-tested with its
 *     WORLD AABB (geometry bounding box × `matrixWorld`) before any ray is
 *     transformed. That is what keeps a ≥ 50-placement planner layout cheap, and
 *     it is recomputed per ray instead of cached, so a moving mover chunk is
 *     always correct (same rule as the editor backend, doc-render-picking §2.4).
 *
 *  2. **Narrow phase** — the world ray is transformed into CHUNK space through
 *     the inverse `matrixWorld` (pre-allocated temporaries, no allocation per
 *     ray). Distances come back in chunk units, so the hit distance is
 *     RECOMPUTED from the world hit point, and `raycaster.near` / `.far` are
 *     applied to that world distance — the same order three.js' own
 *     `Mesh.raycast` uses. A mirrored instance (negative determinant) inverts
 *     the winding seen in chunk space, which is what `flipWinding` corrects.
 *
 *  3. **Resolution** — `resolveHit` maps the hit's SEGMENT to its pick-owner
 *     ordinal, that ordinal to a template node through
 *     `BakedAsset.nodeTable.nodes` and the template to this instance's node
 *     through `PlacementInstance.nodeOf`. No linear scan, no binary search, no
 *     window table.
 *
 * **Occlusion (plan Q5).** A segment without a pick owner in an OPAQUE chunk is
 * real geometry that must hide what is behind it. Such a hit is pushed like any
 * other — so it occludes hits of other chunks and of other backends in the
 * manager's distance sort — and resolves to {@link RAYCAST_BLOCKED}: the
 * manager stops the hit loop instead of falling through. A transparent chunk
 * (`blocks === false`, e.g. safety glass) never blocks, so a guard behind glass
 * stays selectable. The rule only applies to an IDENTITY placement; a cloned
 * placement keeps resolving an unowned face to the chunk owner's instance node
 * (the placement-root rule of plan-753), which is a pickable answer, not a
 * block.
 *
 * **Hidden nodes (plan F2).** Skipping happens DURING the traversal, per
 * instance: a segment whose owning node is effectively invisible is not tested
 * at all, so the part behind it is picked instead of the manager having to
 * reject a hit it already paid for. The decision is taken per instance node and
 * never written onto the shared {@link ChunkPickData}.
 *
 * **Keep meshes.** A `bake:'keep'` mesh keeps its ORIGINAL, authored geometry:
 * its index order is data (GLB export, material groups, `drawRange`), so
 * nothing here may permute it. It is therefore covered by a structure built
 * over segments of exactly `CLUSTER_TRIS` triangles — the one segment size
 * `buildPickStructure` does NOT Morton-sort (plan §2.4a.2), so the index is
 * provably untouched, `faceIndex` stays the authored one and the SAH tree over
 * the cluster boxes still does the accelerating. Below
 * {@link KEEP_BRUTE_TRIS} triangles the structure is not worth its bytes and
 * the box pre-test plus `raycastRangeBruteForce` answer directly; a `dynamic`
 * keep mesh (capability `dynamicGeometry` — machining volume, ribbon band,
 * energy chain) is always brute-forced inside its current bounding box (plan
 * F9), because its geometry is rewritten under us.
 */

import { Box3, Matrix4, Ray, Vector3, type BufferAttribute, type BufferGeometry, type Intersection, type Mesh, type Object3D, type Raycaster } from 'three';
import { chunkMetaOf, type BakedChunk } from './rv-bake-chunk';
import {
  CLUSTER_TRIS,
  raycastPickNearest,
  raycastRangeBruteForce,
  raycastSurfaceNearest,
  type ChunkPickData,
  type NodeTable,
  type PickCounters,
} from './rv-pick-structure';
import { buildPickStructure, type PickSegmentInput } from './rv-pick-build';
import { getCapabilities } from './rv-component-registry';
import { isPickStructureEnabled } from './rv-dev-load-flags';
import type { BakeRegistry, PlacementInstance } from './rv-bake-registry';
import type { BackendHitResolution, PickHit, RaycastBackend } from './rv-raycast-manager';

/** Keep meshes below this triangle count are brute-forced inside their box. */
export const KEEP_BRUTE_TRIS = 512;

/**
 * What {@link PickBackend.raycast} pushes: a vanilla `Intersection` plus the
 * segment it came from. `resolveHit` reads the three `rv*` fields; every other
 * consumer sees an ordinary intersection.
 */
export interface ChunkIntersection extends Intersection<Object3D> {
  /** Segment index inside the chunk's {@link ChunkPickData}. */
  rvSegment: number;
  /** `segOwner[segment]` — pick-owner ordinal, -1 = none. */
  rvOwner: number;
  /** The hit occludes but resolves to no node (opaque unowned segment). */
  rvBlocked: boolean;
}

// ─── Ray temporaries (module scope — no allocation per ray) ─────────

const _inverse = new Matrix4();
const _localRay = new Ray();
const _worldBox = new Box3();
const _hitLocal = new Vector3();

/** Triangle corners + normal scratch for the `Intersection` construction. */
const _a = new Vector3();
const _b = new Vector3();
const _c = new Vector3();
const _ab = new Vector3();

type PickMode = 'pick' | 'surface';

/** Effective `.visible` of `node` and every ancestor. */
function effectivelyVisible(node: Object3D): boolean {
  for (let c: Object3D | null = node; c; c = c.parent) {
    if (!c.visible) return false;
  }
  return true;
}

/** Local-space face normal, three.js' winding (`(c-b) × (a-b)`). */
function faceNormal(position: BufferAttribute, ia: number, ib: number, ic: number): Vector3 {
  _a.fromBufferAttribute(position, ia);
  _b.fromBufferAttribute(position, ib);
  _c.fromBufferAttribute(position, ic);
  const normal = new Vector3().subVectors(_c, _b);
  _ab.subVectors(_a, _b);
  normal.cross(_ab);
  const len = normal.length();
  if (len > 0) normal.multiplyScalar(1 / len);
  return normal;
}

/**
 * The ONE narrow phase: transform the ray, traverse, build the intersection.
 * Returns the pushed intersection (or null). `skipSegment` is only consulted in
 * `pick` mode. `linear` selects the structure-free walk (the traversal takes it
 * on its own for a segment-only chunk).
 */
function intersectStructure(
  mesh: Mesh,
  data: ChunkPickData,
  raycaster: Raycaster,
  out: Intersection<Object3D>[],
  mode: PickMode,
  skipSegment: ((segment: number) => boolean) | null,
  counters: PickCounters | null,
  linear = false,
): ChunkIntersection | null {
  const geometry = mesh.geometry as BufferGeometry;
  const positionAttr = geometry.getAttribute('position') as BufferAttribute | undefined;
  const indexAttr = geometry.getIndex();
  if (!positionAttr || !indexAttr) return null;

  if (geometry.boundingBox === null) geometry.computeBoundingBox();
  _worldBox.copy(geometry.boundingBox!).applyMatrix4(mesh.matrixWorld);
  if (!raycaster.ray.intersectsBox(_worldBox)) return null;

  _inverse.copy(mesh.matrixWorld).invert();
  _localRay.copy(raycaster.ray).applyMatrix4(_inverse);
  // `applyMatrix4` normalises the direction, so chunk-space distances are in
  // chunk units — hence the world recomputation below and near/far AFTER it.
  const flipWinding = _inverse.determinant() < 0;

  const position = positionAttr.array as Float32Array;
  const index = indexAttr.array as Uint32Array;
  const o = _localRay.origin;
  const d = _localRay.direction;
  const query = { skipSegment, flipWinding, counters, linear };
  const hit = mode === 'pick'
    ? raycastPickNearest(data, position, index, o.x, o.y, o.z, d.x, d.y, d.z, query)
    : raycastSurfaceNearest(data, position, index, o.x, o.y, o.z, d.x, d.y, d.z, query);
  if (hit === null) return null;

  _hitLocal.copy(d).multiplyScalar(hit.distance).add(o);
  const point = _hitLocal.clone().applyMatrix4(mesh.matrixWorld);
  const distance = raycaster.ray.origin.distanceTo(point);
  if (distance < raycaster.near || distance > raycaster.far) return null;

  const i = hit.triangle * 3;
  const ia = index[i];
  const ib = index[i + 1];
  const ic = index[i + 2];
  const intersection: ChunkIntersection = {
    distance,
    point,
    object: mesh,
    faceIndex: hit.triangle,
    face: { a: ia, b: ib, c: ic, normal: faceNormal(positionAttr, ia, ib, ic), materialIndex: 0 },
    rvSegment: hit.segment,
    rvOwner: hit.owner,
    rvBlocked: hit.blocked,
  };
  out.push(intersection);
  return intersection;
}

// ─── Keep meshes ────────────────────────────────────────────────────

interface KeepPick {
  /** `null` = brute force (too small, or dynamic geometry). */
  data: ChunkPickData | null;
  /** Guards the cache against a geometry rewrite. */
  index: Uint32Array;
  position: Float32Array;
  positionVersion: number;
  indexStart: number;
  indexCount: number;
}

const keepPickOf = new WeakMap<BufferGeometry, KeepPick>();
const keepDynamicOf = new WeakMap<Object3D, boolean>();

/**
 * Does any component on `mesh` or an ancestor rewrite its mesh geometry at
 * runtime (plan F9)? Read from the capability table — nothing sets a flag.
 */
function isDynamicKeepMesh(mesh: Mesh): boolean {
  const cached = keepDynamicOf.get(mesh);
  if (cached !== undefined) return cached;
  let dynamic = false;
  for (let c: Object3D | null = mesh; c && !dynamic; c = c.parent) {
    const rv = c.userData?.realvirtual as Record<string, unknown> | undefined;
    if (!rv) continue;
    for (const key in rv) {
      if (!rv[key]) continue;
      if (getCapabilities(key.replace(/_\d+$/, '')).dynamicGeometry) { dynamic = true; break; }
    }
  }
  keepDynamicOf.set(mesh, dynamic);
  return dynamic;
}

/**
 * The keep mesh's structure, built lazily and synchronously on first use.
 *
 * Segments are consecutive runs of exactly `CLUSTER_TRIS` triangles — the one
 * size `buildPickStructure` leaves unsorted, so the authored index is provably
 * not permuted (the whole reason keep meshes are not staged through the bake's
 * pool).
 */
function keepStructure(mesh: Mesh): KeepPick | null {
  const geometry = mesh.geometry as BufferGeometry;
  const positionAttr = geometry.getAttribute('position') as BufferAttribute | undefined;
  const indexAttr = geometry.getIndex();
  if (!positionAttr || !indexAttr) return null;
  const position = positionAttr.array as Float32Array;
  const index = indexAttr.array as Uint32Array;

  const range = geometry.drawRange;
  const start = Math.max(0, range.start - (range.start % 3));
  const available = index.length - start;
  const wanted = range.count === Infinity ? available : Math.min(range.count, available);
  const count = Math.max(0, wanted - (wanted % 3));
  if (count === 0) return null;

  const cached = keepPickOf.get(geometry);
  if (cached
    && cached.index === index
    && cached.position === position
    && cached.positionVersion === positionAttr.version
    && cached.indexStart === start
    && cached.indexCount === count) {
    return cached;
  }

  const triangles = count / 3;
  let data: ChunkPickData | null = null;
  if (triangles > KEEP_BRUTE_TRIS && !isDynamicKeepMesh(mesh)) {
    const segments: PickSegmentInput[] = [];
    for (let t = 0; t < triangles; t += CLUSTER_TRIS) {
      const tris = Math.min(CLUSTER_TRIS, triangles - t);
      segments.push({ indexStart: start + t * 3, indexCount: tris * 3, node: 0, owner: -1 });
    }
    // `blocks: false` — a keep mesh is a real node, never an occluding blob.
    data = buildPickStructure(position, index, segments, { blocks: false, doubleSided: true }).data;
  }
  const entry: KeepPick = {
    data, index, position, positionVersion: positionAttr.version, indexStart: start, indexCount: count,
  };
  // The geometry changed under us (or is seen for the first time), so its cached
  // bounding box describes the PREVIOUS tick — the box pre-test would then reject
  // rays that do hit (plan F9).
  geometry.boundingBox = null;
  keepPickOf.set(geometry, entry);
  return entry;
}

/** Brute force over an index range in chunk-local space, with the box pre-test. */
function intersectKeepBrute(
  mesh: Mesh,
  entry: KeepPick,
  raycaster: Raycaster,
  out: Intersection<Object3D>[],
): ChunkIntersection | null {
  const geometry = mesh.geometry as BufferGeometry;
  const positionAttr = geometry.getAttribute('position') as BufferAttribute;
  // The CURRENT box: `keepStructure` invalidated it whenever the geometry moved
  // on, which is what makes a dynamic keep mesh pickable after a rewrite (F9).
  if (geometry.boundingBox === null) geometry.computeBoundingBox();
  _worldBox.copy(geometry.boundingBox!).applyMatrix4(mesh.matrixWorld);
  if (!raycaster.ray.intersectsBox(_worldBox)) return null;

  _inverse.copy(mesh.matrixWorld).invert();
  _localRay.copy(raycaster.ray).applyMatrix4(_inverse);
  const o = _localRay.origin;
  const d = _localRay.direction;
  const hit = raycastRangeBruteForce(
    entry.position, entry.index, entry.indexStart, entry.indexCount, o.x, o.y, o.z, d.x, d.y, d.z,
  );
  if (hit === null) return null;
  _hitLocal.copy(d).multiplyScalar(hit.distance).add(o);
  const point = _hitLocal.clone().applyMatrix4(mesh.matrixWorld);
  const distance = raycaster.ray.origin.distanceTo(point);
  if (distance < raycaster.near || distance > raycaster.far) return null;
  const i = hit.triangle * 3;
  const ia = entry.index[i];
  const ib = entry.index[i + 1];
  const ic = entry.index[i + 2];
  const intersection: ChunkIntersection = {
    distance,
    point,
    object: mesh,
    faceIndex: hit.triangle,
    face: { a: ia, b: ib, c: ic, normal: faceNormal(positionAttr, ia, ib, ic), materialIndex: 0 },
    rvSegment: -1,
    rvOwner: -1,
    rvBlocked: false,
  };
  out.push(intersection);
  return intersection;
}

/** Keep mesh narrow phase — structure when it has one, brute force otherwise. */
function intersectKeep(
  mesh: Mesh,
  raycaster: Raycaster,
  out: Intersection<Object3D>[],
  counters: PickCounters | null,
  linear = false,
): ChunkIntersection | null {
  const entry = keepStructure(mesh);
  if (entry === null) return null;
  if (entry.data === null) return intersectKeepBrute(mesh, entry, raycaster, out);
  // `surface` mode: a keep mesh has no owners, so `pick` would answer the same.
  return intersectStructure(mesh, entry.data, raycaster, out, 'surface', null, counters, linear);
}

// ─── `.raycast` instance override (plan F4) ─────────────────────────

/**
 * The override every chunk and keep mesh gets as an INSTANCE property.
 *
 * `Mesh.prototype.raycast` stays exactly as three-mesh-bvh patched it
 * (`acceleratedRaycast`) — an instance property simply shadows it, which is the
 * whole reason a collision `boundsTree` on a chunk geometry can never change a
 * pick result (plan §2.4a.10 / R6). `Object3D.clone()` does NOT copy own
 * properties, so every path that creates a mesh assigns it explicitly: the
 * bake's template meshes, `BakeRegistry.instantiate`'s `new Mesh(...)` and the
 * `clone(false)` keep clones.
 *
 * Surface semantics (plan Q1/F3): the true nearest triangle, ownership
 * irrelevant, one vanilla-compatible `Intersection` at most. `firstHitOnly` is
 * therefore satisfied by construction; `near` / `far` are honoured in world
 * distance.
 */
function chunkRaycastOverride(this: Mesh, raycaster: Raycaster, intersects: Intersection<Object3D>[]): void {
  const meta = chunkMetaOf.get(this.geometry as BufferGeometry);
  if (meta !== undefined) {
    intersectStructure(this, meta.chunk.pick, raycaster, intersects, 'surface', null, null);
    return;
  }
  intersectKeep(this, raycaster, intersects, null);
}

/** Install {@link chunkRaycastOverride} on a chunk or keep mesh. */
export function installPickRaycast(mesh: Mesh): void {
  mesh.raycast = chunkRaycastOverride;
}

/** True when `mesh` carries the override (guard tests / diagnostics). */
export function hasPickRaycast(mesh: Mesh): boolean {
  return mesh.raycast === chunkRaycastOverride;
}

// ─── The backend ────────────────────────────────────────────────────

export class PickBackend implements RaycastBackend {
  /**
   * Hover runs per animation frame, not on a 50 ms clock (plan-756 F7 / Q10).
   *
   * The structure exists before the scene is shown and answers a ray in ~0.03 ms
   * (p95 gate ≤ 1 ms), so the throttle was pure latency: the highlight lagged the
   * cursor by up to 50 ms on a model this backend picks in microseconds. Frame
   * pacing is an upper bound, not a floor — a ray happens only when the pointer
   * moved, and a hover ray never forces a render.
   */
  readonly hoverCadence = 'frame' as const;

  /** Mutable context of the currently traversed mesh — one bound closure, no
   *  allocation per ray. */
  private readonly _skipCtx: {
    table: NodeTable<BakedChunk> | null;
    pick: ChunkPickData | null;
    instance: PlacementInstance | null;
  } = { table: null, pick: null, instance: null };

  private readonly _skipSegment = (segment: number): boolean => {
    const { table, pick, instance } = this._skipCtx;
    if (table === null || pick === null || instance === null) return false;
    const template = table.nodes[pick.segNode[segment]];
    if (template === undefined) return false;
    const node = instance.identity ? template : instance.nodeOf.get(template);
    // A template node the placement never materialised cannot be hidden on its
    // own — its ancestors are covered by the chunk mesh's own visibility walk.
    if (node === undefined) return false;
    return !effectivelyVisible(node);
  };

  /**
   * False = the structure-free mode: every chunk is walked linearly over its
   * segment table (see the module header). Decided ONCE, when the backend is
   * built — the viewer builds one per model load, so the dev flag
   * `rv-webviewer-pick-structure` needs a reload like every load flag.
   */
  readonly usesStructure: boolean;

  constructor(
    private readonly registry: BakeRegistry,
    /** Optional traversal work counters (tests, DevTools). */
    private readonly counters: PickCounters | null = null,
    /** Override of the dev flag (tests); default `isPickStructureEnabled()`. */
    structure?: boolean,
  ) {
    this.usesStructure = structure ?? isPickStructureEnabled();
  }

  raycast(raycaster: Raycaster, out: Intersection<Object3D>[]): void {
    const linear = !this.usesStructure;
    const meshes = this.registry.pickMeshes;
    for (let i = 0; i < meshes.length; i++) {
      const mesh = meshes[i];
      // Effective visibility of the DRAWN mesh — this is what covers a hidden
      // mover, a hidden partition object (plan-755) and a hidden placement
      // root; the per-segment skip below covers everything under them.
      if (!effectivelyVisible(mesh)) continue;
      if (!mesh.layers.test(raycaster.layers)) continue;
      const instance = this.registry.instanceOfMesh(mesh);
      if (instance === null) continue;
      const chunk = instance.chunkOf.get(mesh);
      if (chunk !== undefined) {
        this._skipCtx.table = instance.baked.nodeTable;
        this._skipCtx.pick = chunk.pick;
        this._skipCtx.instance = instance;
        intersectStructure(mesh, chunk.pick, raycaster, out, 'pick', this._skipSegment, this.counters, linear);
        this._skipCtx.table = null;
        this._skipCtx.pick = null;
        this._skipCtx.instance = null;
      } else {
        intersectKeep(mesh, raycaster, out, this.counters, linear);
      }
    }
  }

  resolvePath(): string | null {
    return null;
  }

  /**
   * Segment → owner ordinal → instance node, through the registry's node-table
   * lookup. The owner ordinal travels on the intersection this backend pushed
   * (`rvOwner`); a hit from somewhere else carries none and is treated as
   * unowned, which is the conservative answer.
   */
  resolveHit(hit: PickHit): BackendHitResolution {
    return this.registry.resolveHit(hit.object, (hit as Partial<ChunkIntersection>).rvOwner ?? -1);
  }
}
