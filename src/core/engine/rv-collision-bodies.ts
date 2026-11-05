// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-collision-bodies.ts — what a collision body IS after the destructive bake
 * (plan-781 F1/F8/F12/F19).
 *
 * Since plan-754 a role node very often has no mesh under it at all: a static
 * fence or machine frame was merged into the asset's root chunk, and the only
 * thing that still knows where its triangles are is the pick structure — the
 * node table's segment interval per chunk. A body is therefore "the role
 * node's SEGMENT RANGES in every chunk", resolved through the bake registry's
 * `visitChunkGeometry` (the same walk highlight and bounds use), plus the kept
 * meshes of its subtree. The meshes-under-the-node rule of plan-394 silently
 * found nothing for every static role; that was the verified bug.
 *
 * Resolution of a NODE body, binding order (plan §2.8):
 *   1. `visitChunkGeometry(root)`: `onWhole` = every segment of the chunk,
 *      `onRange` = `[first, last]`;
 *   2. every NESTED role root is resolved the same way and SUBTRACTED per chunk
 *      mesh — "the robot counts up to the gripper" (user decision 2026-08-06);
 *      segments are pre-order sorted, so a subtree is one interval and the
 *      subtraction leaves a handful of intervals;
 *   3. hidden owners are split out: a segment whose owning node is not
 *      effectively visible takes no part — the `_skipSegment` rule of the pick
 *      backend (contract rule 9: `.visible` and nothing else);
 *   4. kept meshes of the live subtree (cut at nested roots and at the machining
 *      chunk container) join with the keep mesh's own structure (`keepStructure`,
 *      the pick path's lazily built `KeepPick` — read, never a second copy) or,
 *      without one, as a brute-force part;
 *   5. `localBox` = union of the allowed segment boxes.
 *
 * MU bodies: a clone MU's meshes are keep parts (the clones share geometry, so
 * they share one `KeepPick`); an INSTANCED MU is one part over the pool's
 * template geometry whose pose is the slot pose — the shared `InstancedMesh`
 * matrix alone would put every instance in one place.
 *
 * Nothing here builds a structure (rule 15, Vincent 2026-11-05), writes to a
 * chunk (rule 10) or disposes anything (rule 11).
 */

import { Box3, Matrix4, Quaternion, Vector3 } from 'three';
import type { BufferAttribute, BufferGeometry, InstancedMesh, InterleavedBufferAttribute, Mesh, Object3D } from 'three';
import type { BakedChunk } from './rv-bake-chunk';
import type { PlacementInstance } from './rv-bake-registry';
import { RV_BAKE_CHUNK_KEY } from './rv-bake-registry';
import { effectivelyVisible, keepStructure, KEEP_BRUTE_TRIS } from './rv-pick-backend';
import { isSegmentOnly, segmentBoxUnion, type ChunkPickData } from './rv-pick-structure';
import { getCapabilities } from './rv-component-registry';
import { isSensorRuntimeVizName } from './rv-sensor-viz-names';
import type { NarrowPart, PositionReader } from './rv-collision-narrowphase';

// ─── Seam ────────────────────────────────────────────────────────────

/**
 * The slice of `BakeRegistry` collision reads — installed per manager with
 * `RVCollisionManager.setGeometrySource` (an instance setter, never a module
 * singleton). The engine never imports the viewer (contract plugins 2).
 */
export interface CollisionGeometrySource {
  /** The registry's ONE walk from a node to the chunk geometry of its subtree. */
  visitChunkGeometry(
    node: Object3D,
    onWhole: (mesh: Mesh) => void,
    onRange: (mesh: Mesh, chunk: BakedChunk, first: number, last: number) => void,
  ): void;
  /** The placement instance that owns a chunk or keep mesh. */
  instanceOfMesh(mesh: Object3D): PlacementInstance | null;
  /** Subscribe to instance release (fires BEFORE the refcount drops). */
  onRelease(listener: (instance: PlacementInstance) => void): () => void;
}

/** The slot pose of an instanced MU (`IMUAccessor` subset). */
export interface InstancePoseSource {
  readonly node: Object3D;
  getPosition(): { x: number; y: number; z: number };
  getQuaternion(): { x: number; y: number; z: number; w: number };
}

// ─── Body parts ──────────────────────────────────────────────────────

/** One geometric piece of a body. Pre-allocated; rebuilt only at body (re)build. */
export interface BodyPart extends NarrowPart {
  readonly kind: 'chunk' | 'keep' | 'mu-instance';
  /** Live chunk mesh / keep mesh / the pool's `InstancedMesh`. */
  readonly mesh: Mesh;
  /** `mu-instance` only: where the slot pose comes from. */
  readonly instance: InstancePoseSource | null;
  /** Allowed segments (structure parts), 0 for a brute-force part. */
  readonly segments: number;
  /** Allowed triangles. */
  readonly triangles: number;
  /** Lives under a mover boundary, or is an MU: it can move on its own (F6). */
  readonly mobile: boolean;
  /** Last seen world matrix — the motion stamp (F5). */
  readonly lastMatrix: Float64Array;
  /** Per evaluated tick. */
  readonly worldBox: Box3;
  /** This tick: the pose differs from `lastMatrix`. */
  moved: boolean;
  /** This tick: the mesh is effectively visible. */
  visible: boolean;
}

/** Counters of everything a (re)build left out — feed the warn-once messages. */
export interface BodyBuildStats {
  deformed: number;
  dynamic: number;
  instanced: number;
}

export function createBodyBuildStats(): BodyBuildStats {
  return { deformed: 0, dynamic: 0, instanced: 0 };
}

// ─── Filters (plan-394 F17, plan-409 F3) ─────────────────────────────

/**
 * True for geometry whose cached local box would be a lie: skinned meshes (the
 * viewer builds them for energy chains), morph-target animation, and anything
 * explicitly excluded with `_rvSkipBVH`. Left out of every body — a named blind
 * spot, not a silent wrong answer.
 */
export function isDeformedMesh(mesh: Mesh): boolean {
  if ((mesh as unknown as { isSkinnedMesh?: boolean }).isSkinnedMesh) return true;
  if (mesh.userData?._rvSkipBVH) return true;
  const influences = mesh.morphTargetInfluences;
  return Array.isArray(influences) && influences.length > 0;
}

/**
 * Pipeline helper meshes are not machine geometry and never join a body:
 * pooled highlight overlays (the collision highlight itself parents them into
 * the hit body's subtree — a feedback loop born from the manager's own alarm),
 * runtime machining chunks (`_rvMachiningChunk`, created long after any build)
 * and sensor gizmos.
 */
export function isPipelineHelperMesh(mesh: Mesh): boolean {
  const ud = mesh.userData as Record<string, unknown> | undefined;
  if (!ud) return false;
  // NOT `=== true`: the flag carries the chunk INDEX, and index 0 is falsy.
  if (ud._rvMachiningChunk !== undefined) return true;
  if (ud._highlightOverlay === true) return true;
  return isSensorRuntimeVizName(mesh.name);
}

/**
 * Does a component on `mesh` or an ancestor rewrite its geometry at runtime
 * (capability `dynamicGeometry` — ribbon band, energy chain)? The same rule as
 * the pick backend's keep path. Such a mesh is EXCLUDED from collision (F19,
 * named blind spot, warned once): its triangles change under any cached box.
 *
 * Exception, declared by the component itself and not by a type list: a node
 * that is a registered stock-bounds source (`registerStockBounds`, plan-409 F4 —
 * today the machining volume) keeps its AUTHORED mesh (plan-781 review #1). That
 * mesh is never rewritten: the component draws its rewritten state into
 * separate runtime meshes (`_rvMachiningChunk` under `_rvMachiningChunks`),
 * which are pipeline helpers and cut out of every walk, and it hides or
 * layer-masks the authored mesh while they show — {@link partVisible} then
 * drops it and the stock box stands in. Without that state (no machining
 * provider, the async grid init, a degrade or teardown) the authored mesh IS
 * the workpiece.
 */
export function isDynamicGeometryMesh(mesh: Object3D, stockNodes?: ReadonlySet<Object3D>): boolean {
  for (let c: Object3D | null = mesh; c; c = c.parent) {
    const rv = c.userData?.realvirtual as Record<string, unknown> | undefined;
    if (!rv) continue;
    if (stockNodes !== undefined && stockNodes.has(c)) continue;
    for (const key in rv) {
      if (!rv[key]) continue;
      if (getCapabilities(key.replace(/_\d+$/, '')).dynamicGeometry) return true;
    }
  }
  return false;
}

// ─── Intervals ───────────────────────────────────────────────────────

/** Inclusive `[first, last]` pairs, flat. */
type IntervalList = number[];

/** Sort + merge into disjoint, ascending pairs. */
function normalize(list: IntervalList): IntervalList {
  const n = list.length / 2;
  if (n <= 1) return list;
  const idx = Array.from({ length: n }, (_, i) => i).sort((x, y) => list[x * 2] - list[y * 2]);
  const out: IntervalList = [];
  for (const i of idx) {
    const f = list[i * 2];
    const l = list[i * 2 + 1];
    const k = out.length;
    if (k > 0 && f <= out[k - 1] + 1) {
      if (l > out[k - 1]) out[k - 1] = l;
    } else {
      out.push(f, l);
    }
  }
  return out;
}

/** `a \ b`, both normalized. */
function subtract(a: IntervalList, b: IntervalList): IntervalList {
  if (b.length === 0) return a;
  const out: IntervalList = [];
  for (let i = 0; i < a.length; i += 2) {
    let f = a[i];
    const l = a[i + 1];
    for (let j = 0; j < b.length && f <= l; j += 2) {
      const bf = b[j];
      const bl = b[j + 1];
      if (bl < f || bf > l) continue;
      if (bf > f) out.push(f, bf - 1);
      f = bl + 1;
    }
    if (f <= l) out.push(f, l);
  }
  return out;
}

/** Per chunk mesh: the intervals a node's subtree owns. */
function collectChunkIntervals(
  source: CollisionGeometrySource,
  node: Object3D,
  into: Map<Mesh, IntervalList>,
): void {
  const add = (mesh: Mesh, f: number, l: number): void => {
    const list = into.get(mesh);
    if (list) list.push(f, l);
    else into.set(mesh, [f, l]);
  };
  source.visitChunkGeometry(
    node,
    (mesh) => {
      const inst = source.instanceOfMesh(mesh);
      const chunk = inst?.chunkOf.get(mesh);
      if (!chunk || chunk.pick.segmentCount === 0) return;
      add(mesh, 0, chunk.pick.segmentCount - 1);
    },
    (mesh, _chunk, first, last) => {
      if (last >= first) add(mesh, first, last);
    },
  );
}

// ─── Part construction ───────────────────────────────────────────────

/** The fast-path array, or null when the attribute must be read through `getX/Y/Z`. */
function fastPositions(attr: BufferAttribute | InterleavedBufferAttribute): Float32Array | null {
  if ((attr as InterleavedBufferAttribute).isInterleavedBufferAttribute) return null;
  if (attr.itemSize !== 3) return null;
  return attr.array instanceof Float32Array ? attr.array : null;
}

function emptyBox6(): Float64Array {
  const b = new Float64Array(6);
  b[0] = b[1] = b[2] = Infinity;
  b[3] = b[4] = b[5] = -Infinity;
  return b;
}

const _segScratch = new Float64Array(6);

function unionSegments(pick: ChunkPickData, intervals: IntervalList, out: Float64Array): void {
  for (let i = 0; i < intervals.length; i += 2) {
    if (!segmentBoxUnion(pick, intervals[i], intervals[i + 1], _segScratch)) continue;
    if (_segScratch[0] < out[0]) out[0] = _segScratch[0];
    if (_segScratch[1] < out[1]) out[1] = _segScratch[1];
    if (_segScratch[2] < out[2]) out[2] = _segScratch[2];
    if (_segScratch[3] > out[3]) out[3] = _segScratch[3];
    if (_segScratch[4] > out[4]) out[4] = _segScratch[4];
    if (_segScratch[5] > out[5]) out[5] = _segScratch[5];
  }
}

function countSegmentTriangles(pick: ChunkPickData, intervals: IntervalList): { segments: number; triangles: number } {
  let segments = 0;
  let triangles = 0;
  for (let i = 0; i < intervals.length; i += 2) {
    for (let s = intervals[i]; s <= intervals[i + 1]; s++) {
      segments++;
      triangles += pick.segIndexCount[s] / 3;
    }
  }
  return { segments, triangles };
}

function makePart(
  kind: BodyPart['kind'],
  mesh: Mesh,
  pick: ChunkPickData | null,
  attr: BufferAttribute | InterleavedBufferAttribute,
  index: Uint32Array | Uint16Array | null,
  intervals: IntervalList,
  localBox: Float64Array,
  segments: number,
  triangles: number,
  mobile: boolean,
  instance: InstancePoseSource | null,
): BodyPart {
  const position = fastPositions(attr);
  const part: BodyPart = {
    kind,
    mesh,
    instance,
    pick,
    segmentOnly: pick !== null && isSegmentOnly(pick),
    position,
    positionReader: position === null ? (attr as unknown as PositionReader) : null,
    index,
    intervals: Uint32Array.from(intervals),
    intervalCount: intervals.length / 2,
    localBox,
    world: new Float64Array(16),
    segments,
    triangles,
    mobile,
    lastMatrix: new Float64Array(16),
    worldBox: new Box3(),
    moved: false,
    visible: true,
  };
  // Stamp the build pose: the first tick compares against THIS, so a part
  // that has not moved since the (re)build is "still" (F5/F6).
  refreshPartPose(part);
  part.lastMatrix.set(part.world);
  updatePartWorldBox(part);
  return part;
}

/**
 * A keep / clone-MU / instanced-pool part over `mesh`'s geometry: its
 * `KeepPick` when the geometry is big enough to have one and plain (indexed,
 * non-interleaved Float32 positions), the brute-force path otherwise (F8/F19).
 * Null when the mesh has no drawable triangles.
 */
function keepPart(
  mesh: Mesh,
  kind: 'keep' | 'mu-instance',
  mobile: boolean,
  instance: InstancePoseSource | null,
): BodyPart | null {
  const geometry = mesh.geometry as BufferGeometry | undefined;
  const attr = geometry?.getAttribute('position') as BufferAttribute | InterleavedBufferAttribute | undefined;
  if (!geometry || !attr || attr.count === 0) return null;
  const indexAttr = geometry.getIndex();
  const index = indexAttr ? (indexAttr.array as Uint32Array | Uint16Array) : null;
  const available = index ? index.length : attr.count;

  // The drawn range, exactly as `keepStructure` reads it.
  const range = geometry.drawRange;
  const start = Math.max(0, range.start - (range.start % 3));
  const avail = available - start;
  const wanted = range.count === Infinity ? avail : Math.min(range.count, avail);
  const count = Math.max(0, wanted - (wanted % 3));
  if (count === 0) return null;
  const triangles = count / 3;

  if (index && fastPositions(attr) && triangles > KEEP_BRUTE_TRIS) {
    const keep = keepStructure(mesh);
    if (keep && keep.data && keep.data.segmentCount > 0) {
      const iv: IntervalList = [0, keep.data.segmentCount - 1];
      const box = emptyBox6();
      unionSegments(keep.data, iv, box);
      return makePart(kind, mesh, keep.data, attr, index, iv, box, keep.data.segmentCount, triangles, mobile, instance);
    }
  }

  // Brute force over the triangle range: the box comes from the vertices.
  const first = start / 3;
  const iv: IntervalList = [first, first + triangles - 1];
  const box = emptyBox6();
  const pos = fastPositions(attr);
  for (let i = start; i < start + count; i++) {
    const v = index ? index[i] : i;
    if (v >= attr.count) continue;
    let x: number, y: number, z: number;
    if (pos) { x = pos[v * 3]; y = pos[v * 3 + 1]; z = pos[v * 3 + 2]; } else { x = attr.getX(v); y = attr.getY(v); z = attr.getZ(v); }
    // NaN fails every comparison and never enters the box (rule 14).
    if (x < box[0]) box[0] = x; if (x > box[3]) box[3] = x;
    if (y < box[1]) box[1] = y; if (y > box[4]) box[4] = y;
    if (z < box[2]) box[2] = z; if (z > box[5]) box[5] = z;
  }
  if (!(box[3] >= box[0] && box[4] >= box[1] && box[5] >= box[2])) return null;
  return makePart(kind, mesh, null, attr, index, iv, box, 0, triangles, mobile, instance);
}

/** Per resolution: placement instance → its nodes that own a MOVER chunk. */
type MoverCache = WeakMap<PlacementInstance, Set<Object3D>>;

function moverNodesOf(inst: PlacementInstance, cache: MoverCache): Set<Object3D> {
  let set = cache.get(inst);
  if (set) return set;
  set = new Set();
  for (const chunk of inst.chunkOf.values()) {
    if (chunk.ownerPath === null) continue;
    const node = inst.identity ? chunk.owner : inst.nodeOf.get(chunk.owner);
    if (node) set.add(node);
  }
  cache.set(inst, set);
  return set;
}

/** Does a keep mesh hang under a mover boundary of its placement? */
function keepIsMobile(mesh: Mesh, source: CollisionGeometrySource | null, cache: MoverCache): boolean {
  const inst = source?.instanceOfMesh(mesh) ?? null;
  if (!inst) return false;
  const movers = moverNodesOf(inst, cache);
  if (movers.size === 0) return false;
  for (let c: Object3D | null = mesh.parent; c; c = c.parent) {
    if (movers.has(c)) return true;
    if (c === inst.root) break;
  }
  return false;
}

/** Is `mesh` a candidate keep part at all? Counts what it leaves out. */
function acceptKeepMesh(mesh: Mesh, stats: BodyBuildStats, stockNodes?: ReadonlySet<Object3D>): boolean {
  if (!mesh.isMesh || !mesh.geometry) return false;
  if (mesh.userData?.[RV_BAKE_CHUNK_KEY] === true) return false;   // chunk: via the registry
  if (isPipelineHelperMesh(mesh)) return false;
  if ((mesh as unknown as InstancedMesh).isInstancedMesh) {
    // A pool or a GPU-instanced CAD mesh: one geometry, many poses — never one
    // body part. Instanced MUs come in through their own body.
    if (!mesh.userData?._muPool) stats.instanced++;
    return false;
  }
  if (isDeformedMesh(mesh)) { stats.deformed++; return false; }
  if (isDynamicGeometryMesh(mesh, stockNodes)) { stats.dynamic++; return false; }
  return true;
}

// ─── Node bodies ─────────────────────────────────────────────────────

/**
 * Resolve a NODE body (plan §2.8 Rebuild steps 2-6). `nestedRoots` are the
 * role roots strictly below `root` — their subtrees are cut out. A body may end
 * up with zero parts; it keeps its registry entry and produces no pairs.
 */
export function resolveNodeParts(
  root: Object3D,
  nestedRoots: readonly Object3D[],
  source: CollisionGeometrySource | null,
  stats: BodyBuildStats,
  stockNodes?: ReadonlySet<Object3D>,
): BodyPart[] {
  const parts: BodyPart[] = [];
  const movers: MoverCache = new WeakMap();

  // ── chunk parts ──
  if (source) {
    const own = new Map<Mesh, IntervalList>();
    collectChunkIntervals(source, root, own);
    if (own.size > 0) {
      const cut = new Map<Mesh, IntervalList>();
      for (const n of nestedRoots) collectChunkIntervals(source, n, cut);
      const visibleOf = new Map<Object3D, boolean>();
      for (const [mesh, raw] of own) {
        const inst = source.instanceOfMesh(mesh);
        const chunk = inst?.chunkOf.get(mesh);
        if (!inst || !chunk) continue;
        let iv = normalize(raw);
        const minus = cut.get(mesh);
        if (minus) iv = subtract(iv, normalize(minus));
        iv = splitHidden(iv, chunk.pick, inst, visibleOf);
        if (iv.length === 0) continue;
        const geometry = mesh.geometry as BufferGeometry;
        const attr = geometry.getAttribute('position') as BufferAttribute | InterleavedBufferAttribute | undefined;
        const indexAttr = geometry.getIndex();
        if (!attr || !indexAttr) continue;
        const box = emptyBox6();
        unionSegments(chunk.pick, iv, box);
        if (!(box[3] >= box[0] && box[4] >= box[1] && box[5] >= box[2])) continue;
        const { segments, triangles } = countSegmentTriangles(chunk.pick, iv);
        parts.push(makePart(
          'chunk', mesh, chunk.pick, attr, indexAttr.array as Uint32Array | Uint16Array, iv, box,
          segments, triangles, chunk.ownerPath !== null, null,
        ));
      }
    }
  }

  // ── keep parts: the live subtree, cut at nested roots and the CSG container ──
  const nested = new Set(nestedRoots);
  const walk = (obj: Object3D): void => {
    if (obj !== root && nested.has(obj)) return;
    if (obj.userData?._rvMachiningChunks === true) return;
    const mesh = obj as Mesh;
    if (mesh.isMesh && acceptKeepMesh(mesh, stats, stockNodes)) {
      const part = keepPart(mesh, 'keep', keepIsMobile(mesh, source, movers), null);
      if (part) parts.push(part);
    }
    for (const child of obj.children) walk(child);
  };
  walk(root);
  return parts;
}

/**
 * Drop the segments whose owning node is not effectively visible (F12) — the
 * pick backend's `_skipSegment` rule: `segNode` → template → this instance's
 * node → `.visible` along the parents. A template node the placement never
 * materialised cannot be hidden on its own (the chunk mesh's own visibility
 * covers its ancestors).
 */
function splitHidden(
  iv: IntervalList,
  pick: ChunkPickData,
  inst: PlacementInstance,
  visibleOf: Map<Object3D, boolean>,
): IntervalList {
  const table = inst.baked.nodeTable;
  const out: IntervalList = [];
  for (let i = 0; i < iv.length; i += 2) {
    let runFirst = -1;
    for (let s = iv[i]; s <= iv[i + 1]; s++) {
      const template = table.nodes[pick.segNode[s]];
      const node = template === undefined ? undefined : inst.identity ? template : inst.nodeOf.get(template);
      let visible = true;
      if (node !== undefined) {
        const cached = visibleOf.get(node);
        if (cached === undefined) {
          visible = effectivelyVisible(node);
          visibleOf.set(node, visible);
        } else {
          visible = cached;
        }
      }
      if (visible) {
        if (runFirst < 0) runFirst = s;
      } else if (runFirst >= 0) {
        out.push(runFirst, s - 1);
        runFirst = -1;
      }
    }
    if (runFirst >= 0) out.push(runFirst, iv[i + 1]);
  }
  return out;
}

// ─── MU bodies ───────────────────────────────────────────────────────

/** The MU shape the parts need (`IMUAccessor` subset). */
export interface CollisionMUShape extends InstancePoseSource {
  readonly isInstanced: boolean;
}

/**
 * Parts of an MU body (F8): clone MU → keep parts of its own meshes (shared
 * geometry → shared `KeepPick`); instanced MU → one part over the pool's
 * geometry, posed by the slot.
 */
export function resolveMUParts(mu: CollisionMUShape, stats: BodyBuildStats): BodyPart[] {
  const parts: BodyPart[] = [];
  if (mu.isInstanced) {
    const pool = mu.node as Mesh;
    if (pool.isMesh && pool.geometry && !isDeformedMesh(pool)) {
      const part = keepPart(pool, 'mu-instance', true, mu);
      if (part) parts.push(part);
    }
    return parts;
  }
  const walk = (obj: Object3D): void => {
    if (obj.userData?._rvMachiningChunks === true) return;
    const mesh = obj as Mesh;
    if (mesh.isMesh && acceptKeepMesh(mesh, stats)) {
      const part = keepPart(mesh, 'keep', true, null);
      if (part) parts.push(part);
    }
    for (const child of obj.children) walk(child);
  };
  walk(mu.node);
  return parts;
}

// ─── Per-tick pose ───────────────────────────────────────────────────

const _pos = new Vector3();
const _quat = new Quaternion();
const _one = new Vector3(1, 1, 1);
const _slot = new Matrix4();
const _fresh = new Matrix4();

/**
 * The CURRENT world matrix of `obj` into `out`, without writing any
 * `matrixWorld` (F16). It does refresh the LOCAL `matrix` of `matrixAutoUpdate`
 * nodes on the way up (`updateMatrix()`, the same value the render would
 * compose from position/quaternion/scale a moment later). The sim tick runs before the render refreshes `matrixWorld`, so
 * a drive that moved in this tick is not in it yet. `updateWorldMatrix(true,
 * false)` is no answer: in three r185 it does not recompute a child whose own
 * matrix is fixed (every chunk mesh: `matrixAutoUpdate = false`) after its
 * parent moved, and it CLEARS the parents' `matrixWorldNeedsUpdate` — the render
 * would then skip their other chunk meshes and draw them where they were.
 *
 * Local matrices of `matrixAutoUpdate` nodes are composed (what the render does
 * too); a frozen static node (`matrixWorldAutoUpdate = false`) answers with its
 * frozen `matrixWorld` and ends the walk.
 */
export function freshWorldMatrix(obj: Object3D, out: Matrix4): Matrix4 {
  if (obj.matrixWorldAutoUpdate === false) return out.copy(obj.matrixWorld);
  if (obj.matrixAutoUpdate) obj.updateMatrix();
  const parent = obj.parent;
  if (parent === null) return out.copy(obj.matrix);
  freshWorldMatrix(parent, out);
  return out.multiply(obj.matrix);
}

/**
 * Refresh `part.world` from the LIVE pose (F16, see {@link freshWorldMatrix}).
 * An instanced part composes the pool mesh's world matrix with the slot pose —
 * exactly the matrix the GPU draws the instance with (the pool places instances
 * with position + rotation only; a scaled template takes the clone path).
 */
export function refreshPartPose(part: BodyPart): void {
  freshWorldMatrix(part.mesh, _fresh);
  const inst = part.instance;
  if (inst !== null) {
    // The getters return SHARED scratch vectors — copy the values at once.
    const p = inst.getPosition();
    _pos.set(p.x, p.y, p.z);
    const q = inst.getQuaternion();
    _quat.set(q.x, q.y, q.z, q.w);
    _slot.compose(_pos, _quat, _one).premultiply(_fresh);
    part.world.set(_slot.elements);
    return;
  }
  part.world.set(_fresh.elements);
}

/** World box of a part from its `localBox` and `world` (exact AABB of the transformed box). */
export function updatePartWorldBox(part: BodyPart): void {
  const b = part.localBox;
  const e = part.world;
  const cx = (b[0] + b[3]) * 0.5, cy = (b[1] + b[4]) * 0.5, cz = (b[2] + b[5]) * 0.5;
  const hx = (b[3] - b[0]) * 0.5, hy = (b[4] - b[1]) * 0.5, hz = (b[5] - b[2]) * 0.5;
  const wx = e[0] * cx + e[4] * cy + e[8] * cz + e[12];
  const wy = e[1] * cx + e[5] * cy + e[9] * cz + e[13];
  const wz = e[2] * cx + e[6] * cy + e[10] * cz + e[14];
  const ex = Math.abs(e[0]) * hx + Math.abs(e[4]) * hy + Math.abs(e[8]) * hz;
  const ey = Math.abs(e[1]) * hx + Math.abs(e[5]) * hy + Math.abs(e[9]) * hz;
  const ez = Math.abs(e[2]) * hx + Math.abs(e[6]) * hy + Math.abs(e[10]) * hz;
  part.worldBox.min.set(wx - ex, wy - ey, wz - ez);
  part.worldBox.max.set(wx + ex, wy + ey, wz + ez);
}

/** Effective visibility of the part's mesh this tick (`.visible` chain, plus a renderer-masked source). */
export function partVisible(part: BodyPart): boolean {
  const m = part.mesh;
  if (m.layers.mask === 0) return false;
  return effectivelyVisible(m);
}

/** Compare `world` against the stamp; copy and report a change. */
export function stampMotion(part: BodyPart): boolean {
  const w = part.world;
  const l = part.lastMatrix;
  for (let i = 0; i < 16; i++) {
    if (w[i] !== l[i]) {
      l.set(w);
      return true;
    }
  }
  return false;
}
