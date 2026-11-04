// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-traverse-utils.ts — Small reusable Object3D traversal helpers.
 *
 * The `node.traverse(c => { if (!(c as Mesh).isMesh) return; ... })` pattern
 * appears in 30+ files. `traverseMeshes()` makes the intent explicit and
 * eliminates the `as Mesh` cast boilerplate at every call site.
 */

import { Box3, Matrix4, Vector3, type Material, type Object3D } from 'three';
import { Mesh } from 'three';
import { bakedKeepGeometries, chunkMetaOf } from './rv-bake-chunk';
import { sharedVizGeometries } from './rv-shared-viz-geometry';
import type { BakedChunk } from './rv-bake-chunk';
import { segmentBoxUnion } from './rv-pick-structure';

// ─── Runtime-rig markers (plan-362, EnergyChain) ─────────────────
//
// An EnergyChain rig replaces a static CAD subtree with runtime sidecars:
// one SkinnedMesh per source mesh, the deactivated originals, and one
// invisible picking-proxy hull. Several scene-wide pipelines walk EVERY mesh
// (material dedup, uber-material bake, layout-planner aux raycast targets) and
// must not treat those sidecars as ordinary geometry. The markers live here —
// next to the traversal helpers those pipelines already import — so no
// pipeline needs to depend on the EnergyChain module itself.

/** `userData` flag on the invisible EnergyChain picking-proxy hull. */
export const RV_CHAIN_PROXY = '_rvEnergyChainProxy';
/** `userData` flag on a runtime `SkinnedMesh` sidecar created by an EnergyChain rig. */
export const RV_CHAIN_SKIN = '_rvEnergyChainSkin';
/** `userData` flag on an original CAD mesh that a rig deactivated and shadowed. */
export const RV_CHAIN_SOURCE = '_rvEnergyChainSource';
/**
 * `userData` copy of an original mesh's AUTHORED `visible` flag, kept next to
 * {@link RV_CHAIN_SOURCE}. The export clone has no access to the live component,
 * so this is how it knows whether restoring the mesh means showing it — an
 * author who deliberately hid a part must not have it reappear in the file.
 */
export const RV_CHAIN_SOURCE_VISIBLE = '_rvEnergyChainSourceVisible';

// ─── Runtime-element marker (plan-733, Chain) ────────────────────
//
// Unrelated to the EnergyChain markers above despite the neighbouring name: a
// `Chain` clones its element template `NumberOfElements` times at load. The
// marker lives here for the same reason as the ones above — the asset exporter's
// prune pass must recognise the clones without importing the component module
// (which would pull the whole component-registry side-effect chain into the
// editor's export path).

/** `userData` flag on every runtime element clone built by an `RVChain`. */
export const RV_CHAIN_ELEMENT = '_rvChainElement';

// ─── Runtime-web markers (plan-459, RibbonPath / RibbonWinder) ────────────
//
// Same rationale as the two blocks above: the asset exporter's prune pass and
// the batcher must recognise the web runtime helpers WITHOUT importing the
// component modules (which would drag the component-registry side-effect chain
// into the editor's export path).

/** `userData` flag on the band mesh a `RibbonPath` generates from its rollers. */
export const RV_RIBBON_BAND = '_rvRibbonBand';

/**
 * `userData` copy of a winder `RollMesh`'s AUTHORED local scale, as a plain
 * `[x, y, z]` triple.
 *
 * A `RibbonWinder` scales that node radially every tick, and the exporter works on a
 * CLONE of the live tree — so without this the saved GLB would freeze whatever
 * roll diameter the simulation happened to be at. Restoring `(1,1,1)` would be
 * just as wrong: a CAD roll may be authored with a non-unit scale, and forcing
 * unity would silently resize the part. The triple is the only way the clone can
 * know what the author meant.
 */
export const RV_RIBBON_ROLL_SCALE = '_rvRibbonRollScale';

/**
 * `userData` flag on the mantle mesh of a `RibbonRoller` with `SpinMode: Texture`
 * (plan-460 F11).
 *
 * Such a roller clones its mantle material and its colour map so it can scroll
 * an offset nobody else sees. The dedup pass must therefore leave the mesh out
 * of the value-fingerprint map, exactly as it leaves out a Lamp clone: an
 * identical-looking static material would otherwise be handed to the roller and
 * every mesh sharing it would start scrolling too.
 */
export const RV_RIBBON_SPIN_MESH = '_rvRibbonSpinMesh';

/** True when a mesh is (or is under) a `SpinMode: Texture` roller mantle. */
export function isTextureSpinRoller(node: Object3D): boolean {
  return node.userData?.[RV_RIBBON_SPIN_MESH] === true
    || node.parent?.userData?.[RV_RIBBON_SPIN_MESH] === true;
}

/**
 * True when a mesh belongs to a runtime deformation rig and must be kept out
 * of the material-collapsing pipelines (`deduplicateMaterials`,
 * `applyUberMaterial`).
 *
 * Two independent reasons:
 *   - a `SkinnedMesh` carries per-vertex skin attributes; the uber bake writes
 *     shared per-vertex color/rmPacked attributes and may swap the geometry
 *     for a cached clone, which would silently drop the skin binding;
 *   - the picking proxy is invisible bookkeeping geometry that should never
 *     contribute a material at all;
 *   - the deactivated original shares its geometry with the SkinnedMesh, so
 *     baking it in place would write into the skinned geometry as a side
 *     effect, and `dispose()` must be able to hand back exactly what it took.
 */
export function isRuntimeRigMesh(node: Object3D): boolean {
  const ud = node.userData as Record<string, unknown> | undefined;
  if (ud?.[RV_CHAIN_PROXY] === true || ud?.[RV_CHAIN_SOURCE] === true) return true;
  return (node as unknown as { isSkinnedMesh?: boolean }).isSkinnedMesh === true;
}

/**
 * True when a mesh is a rig sidecar that must NOT become a raycast target:
 * the SkinnedMesh (CPU skin raycast is slow and the proxy already covers the
 * chain) and the deactivated original (it sits frozen in the rest pose). The
 * picking proxy itself deliberately does NOT match — it is the one target the
 * planner drop path should register.
 */
export function isRigRaycastExcluded(node: Object3D): boolean {
  const ud = node.userData as Record<string, unknown> | undefined;
  if (ud?.[RV_CHAIN_SKIN] === true || ud?.[RV_CHAIN_SOURCE] === true) return true;
  return (node as unknown as { isSkinnedMesh?: boolean }).isSkinnedMesh === true;
}

/**
 * First node of `root`'s subtree (pre-order, `root` included) whose name equals
 * `ref` or — when `ref` is a relative path — its last segment. `skip` excludes
 * single nodes (not their subtrees). The ONE name-in-subtree lookup: the MU
 * template resolution of `RVSource` and the bake survival model's
 * `nameInSubtree` target finder (plan-754) both call it, so the component and
 * the bake can never disagree about which node a `ThisObjectAsMU` names.
 */
export function findByNameInSubtree(
  root: Object3D,
  ref: string,
  skip?: (node: Object3D) => boolean,
): Object3D | null {
  const wanted = ref.includes('/') ? ref.slice(ref.lastIndexOf('/') + 1) : ref;
  let found: Object3D | null = null;
  root.traverse((child) => {
    if (found) return;
    if (skip && skip(child)) return;
    if (child.name === wanted || child.name === ref) found = child;
  });
  return found;
}

/**
 * The node at the relative path `path` (`Lift/ForkAnchor`) below `root`: the
 * first node of the subtree (pre-order, `root` included) named like the first
 * segment whose child chain matches the remaining segments exactly. Unlike
 * {@link findByNameInSubtree} every segment counts — a `ForkAnchor` elsewhere
 * in the subtree is no match. Null when no chain matches.
 */
export function findPathInSubtree(root: Object3D, path: string): Object3D | null {
  const segs = path.split('/').filter((s) => s.length > 0);
  if (segs.length === 0) return null;
  let found: Object3D | null = null;
  root.traverse((n) => {
    if (found || n.name !== segs[0]) return;
    let cur: Object3D | undefined = n;
    for (let i = 1; cur && i < segs.length; i++) cur = cur.children.find((c) => c.name === segs[i]);
    if (cur) found = cur;
  });
  return found;
}

/**
 * Traverse `root` and invoke `cb` for every descendant (and `root` itself,
 * if it is a `Mesh`). Skips non-Mesh nodes.
 *
 * Equivalent to:
 * ```ts
 * root.traverse((c) => { if (!(c as Mesh).isMesh) return; cb(c as Mesh); });
 * ```
 *
 * The `isMesh` runtime check is preserved (not just `instanceof Mesh`) because
 * Three.js uses duck-typed flags on Object3D subclasses and the existing code
 * relied on that behavior.
 */
export function traverseMeshes(root: Object3D, cb: (mesh: Mesh) => void): void {
  root.traverse((child) => {
    if ((child as Mesh).isMesh) {
      cb(child as Mesh);
    }
  });
}

/**
 * Precise geometric center of a subtree: the average of every world-space
 * mesh vertex under `node` (including `node` itself). Unlike the AABB center
 * this is not inflated by rotated bounding boxes and reflects the actual
 * vertex distribution of the geometry. Returns null when the subtree carries
 * no vertices.
 */
export function computeSubtreeVertexCenter(node: Object3D, target?: Vector3): Vector3 | null {
  const sum = target ?? new Vector3();
  sum.set(0, 0, 0);
  let count = 0;
  const v = new Vector3();
  node.updateMatrixWorld(true);
  traverseMeshes(node, (mesh) => {
    const pos = mesh.geometry?.getAttribute('position');
    if (!pos) return;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
      sum.add(v);
      count++;
    }
  });
  if (count === 0) return null;
  return sum.divideScalar(count);
}

/**
 * Traverse `root` and invoke `cb(mesh, depth)` for every descendant `Mesh`
 * whose depth (parent-hops back to `root`) is `<= maxDepth`. Meshes deeper
 * than `maxDepth` are skipped silently; a single console.warn (prefixed with
 * `prefix`) is emitted the first time the depth limit is exceeded.
 *
 * This consolidates a repeated pattern in `rv-gizmo-manager.ts` where three
 * shape builders (`_buildMeshOverlay`, `_buildMeshEdges`, `_buildMeshGlowHull`)
 * each duplicated:
 *
 * ```ts
 * let depth = 0;
 * let overDepthWarned = false;
 * node.traverse((child) => {
 *   depth = 0;
 *   let cur = child;
 *   while (cur && cur !== node) { depth++; cur = cur.parent; }
 *   if (depth > MAX_OVERLAY_DEPTH) {
 *     if (!overDepthWarned) { console.warn(...); overDepthWarned = true; }
 *     return;
 *   }
 *   if (!(child as Mesh).isMesh) return;
 *   ...
 * });
 * ```
 *
 * The depth count and iteration order match the original Three.js
 * `traverse()` semantics exactly: depth is computed by walking
 * `parent` pointers back to `root`; the `root` itself has depth `0` and
 * is iterated if it is a Mesh.
 *
 * The `cb` only fires for Mesh descendants with a defined `geometry`
 * (matches the original guard at every call site).
 */
export function traverseMeshesWithDepth(
  root: Object3D,
  maxDepth: number,
  cb: (mesh: Mesh, depth: number) => void,
  prefix = '[traverseMeshesWithDepth]',
): void {
  let overDepthWarned = false;
  root.traverse((child) => {
    // Cheap depth gate (approximate — same logic as the inlined original)
    let depth = 0;
    let cur: Object3D | null = child;
    while (cur && cur !== root) {
      depth++;
      cur = cur.parent;
    }
    if (depth > maxDepth) {
      if (!overDepthWarned) {
        console.warn(`${prefix} exceeded depth ${maxDepth}; skipping deeper meshes`);
        overDepthWarned = true;
      }
      return;
    }
    const m = child as Mesh;
    if (!m.isMesh || !m.geometry) return;
    cb(m, depth);
  });
}

// ─── Chunk bounds seam (plan-756 F6) ─────────────────────────────────
//
// After a destructive bake a merged node has NO `Mesh` descendant: its triangles
// live inside an ancestor's chunk and the only thing that knows where they are is
// the node table's segment interval. `computeSubtreeAABB` would answer with the
// 0.1 m fallback cube — a camera focus onto nothing, an isolate box around a
// point, a gizmo scaled to a speck.
//
// The live `BakeRegistry` is viewer STATE, so it cannot be imported here (and a
// direct import would be a cycle: the registry imports this module's dispose
// guard). It is injected instead — the same pattern as
// `setDriveGizmoFallbackResolver` (drive-gizmo-source.ts).

/** What {@link setChunkBoundsSource} installs — `BakeRegistry` implements it. */
export interface ChunkBoundsSource {
  /** Union the world-space chunk geometry of `node`'s subtree into `target`;
   *  `false` = this node has none (not baked, or no live placement). */
  chunkBoundsOf(node: Object3D, target: Box3): boolean;
  placementOf?(node: Object3D): Object3D | null;
  visitChunkGeometry?(
    node: Object3D,
    onWhole: (mesh: Mesh) => void,
    onRange: (mesh: Mesh, chunk: BakedChunk, first: number, last: number) => void,
  ): void;
}

let _chunkBounds: ChunkBoundsSource | null = null;

/**
 * Install (or clear, with `null`) the source of chunk bounds for
 * {@link computeSubtreeAABB}. Called once per viewer next to
 * `highlighter.setChunkSource(...)`; a context that never bakes leaves it unset
 * and every bounds consumer behaves exactly as before plan-756.
 */
export function setChunkBoundsSource(source: ChunkBoundsSource | null): void {
  _chunkBounds = source;
}

/** Clear the installed source, but only when it is still `source` (a later viewer may have
 *  replaced it): a module-level reference to a disposed viewer's registry keeps its whole
 *  geometry alive. */
export function clearChunkBoundsSource(source: ChunkBoundsSource): void {
  if (_chunkBounds === source) _chunkBounds = null;
}

/** Union the baked chunk geometry of `node`'s subtree into `target` through
 *  the installed source; `false` when no source is installed or the node has
 *  none. For bounds consumers that walk real meshes themselves (camera fit)
 *  and need the same fallback {@link computeSubtreeAABB} takes for a node
 *  whose meshes were merged away by the bake. */
export function chunkBoundsOfNode(node: Object3D, target: Box3): boolean {
  return _chunkBounds !== null && _chunkBounds.chunkBoundsOf(node, target);
}

/**
 * Compute the axis-aligned bounding box of all `Mesh` descendants of `node`,
 * including geometry transforms. Lights, Cameras, Groups, and other non-Mesh
 * children are skipped.
 *
 * The returned object exposes `box` plus pre-computed `size` and `center`
 * Vector3s for convenience. When no mesh descendants exist, a node of a BAKED
 * model still answers with its geometry: the union of the segment boxes of its
 * subtree in world space (plan-756 F6), which is conservatively larger than its
 * triangles and never smaller. Only a node with no meshes AND no segments — a
 * marker, an empty group, a node of an unbaked tree — falls back to a
 * `0.1 × 0.1 × 0.1` cube centered on the node's world position.
 * Each component of `size` is clamped to at least `0.001` to avoid
 * zero-scale traps when the result is used as a Three.js scale.
 *
 * The `target` parameter may be passed to reuse a pre-allocated `Box3`
 * (GC avoidance for callers in hot paths); `size` and `center` are always
 * fresh `Vector3` instances on return.
 */
export function computeSubtreeAABB(
  node: Object3D,
  target?: Box3,
): { box: Box3; size: Vector3; center: Vector3 } {
  const box = target ?? new Box3();
  box.makeEmpty();
  let hasAny = false;
  node.traverse((child) => {
    const asMesh = child as Mesh;
    if (asMesh.isMesh && asMesh.geometry) {
      box.expandByObject(asMesh);
      hasAny = true;
    }
  });
  if (!hasAny && _chunkBounds !== null) {
    // Merged into an ancestor's chunk: the segment boxes ARE this node's geometry.
    hasAny = _chunkBounds.chunkBoundsOf(node, box);
  }
  if (!hasAny) {
    // Fallback: use node world position as center with minimal size
    const pos = new Vector3();
    node.getWorldPosition(pos);
    box.setFromCenterAndSize(pos, new Vector3(0.1, 0.1, 0.1));
  }
  const size = new Vector3();
  box.getSize(size);
  if (size.x < 0.001) size.x = 0.001;
  if (size.y < 0.001) size.y = 0.001;
  if (size.z < 0.001) size.z = 0.001;
  const center = new Vector3();
  box.getCenter(center);
  return { box, size, center };
}

// Shared scratch: synchronous, non-reentrant, like the bake bounds visitor.
// One stamp per mesh avoids Set.clear()/refill allocations on every query.
const _frameVisit = Symbol('rvFrameVisit');
type FrameMesh = Mesh & { [_frameVisit]?: number };
let _frameGeneration = 0;
const _frameInverse = new Matrix4();
const _frameMatrix = new Matrix4();
const _frameBox = new Box3();
const _framePoint = new Vector3();
const _frameRange = new Float64Array(6);
let _frameTarget: Box3;

function addFrameBox(mesh: Mesh, box: Box3): void {
  if (box.isEmpty()) return;
  mesh.updateWorldMatrix(true, false);
  _frameMatrix.multiplyMatrices(_frameInverse, mesh.matrixWorld);
  for (let i = 0; i < 8; i++) {
    _framePoint.set(
      i & 1 ? box.max.x : box.min.x,
      i & 2 ? box.max.y : box.min.y,
      i & 4 ? box.max.z : box.min.z,
    ).applyMatrix4(_frameMatrix);
    _frameTarget.expandByPoint(_framePoint);
  }
}

function addFrameWhole(mesh: FrameMesh): void {
  if (mesh[_frameVisit] === _frameGeneration) return;
  mesh[_frameVisit] = _frameGeneration;
  const geometry = mesh.geometry;
  // Do not lazily allocate geometry.boundingBox in the sampling path.
  if (geometry.boundingBox) addFrameBox(mesh, geometry.boundingBox);
  else {
    const position = geometry.getAttribute('position');
    if (position) {
      _frameBox.makeEmpty();
      for (let i = 0; i < position.count; i++) {
        _framePoint.fromBufferAttribute(position, i);
        _frameBox.expandByPoint(_framePoint);
      }
      addFrameBox(mesh, _frameBox);
    }
  }
}

function addFrameRange(mesh: FrameMesh, chunk: BakedChunk, first: number, last: number): void {
  if (mesh[_frameVisit] === _frameGeneration) return;
  mesh[_frameVisit] = _frameGeneration;
  if (!segmentBoxUnion(chunk.pick, first, last, _frameRange)) return;
  _frameBox.min.set(_frameRange[0], _frameRange[1], _frameRange[2]);
  _frameBox.max.set(_frameRange[3], _frameRange[4], _frameRange[5]);
  addFrameBox(mesh, _frameBox);
}

function visitFrameChunks(node: Object3D, parentPlacement: Object3D | null, root: boolean): void {
  const placement = _chunkBounds?.placementOf?.(node) ?? null;
  if (root || placement !== parentPlacement) {
    _chunkBounds?.visitChunkGeometry?.(node, addFrameWhole, addFrameRange);
  }
  for (let i = 0; i < node.children.length; i++) {
    visitFrameChunks(node.children[i], placement, false);
  }
}

function visitFrameMeshes(node: Object3D): void {
  if ((node as Mesh).isMesh) addFrameWhole(node as Mesh);
  for (let i = 0; i < node.children.length; i++) visitFrameMeshes(node.children[i]);
}

/**
 * Bounds of the live subtree in the caller's frame, including merged segments
 * and attached placements. Writes an empty box and returns false without geometry.
 * Caller-owned result; no per-call objects, callbacks or geometry-box caches.
 * Chunk discovery precedes real meshes so a partial chunk is never added whole.
 * Not reentrant: the installed source must invoke its visitors synchronously.
 */
export function computeSubtreeBoxInFrame(node: Object3D, frameInverse: Matrix4, target: Box3): boolean {
  _frameGeneration++;
  _frameInverse.copy(frameInverse);
  _frameTarget = target;
  target.makeEmpty();
  visitFrameChunks(node, null, true);
  visitFrameMeshes(node);
  return !target.isEmpty();
}

/**
 * Dispose geometry and materials on all Mesh nodes in a subtree.
 * Uses a Set to prevent double-dispose of shared resources.
 * Does NOT remove root from scene — caller is responsible.
 */
export function disposeSubtree(root: Object3D): void {
  const disposed = new Set<unknown>();
  root.traverse((node) => {
    const m = node as Mesh;
    // Runtime dispose guard (plan-753 F11): a baked chunk geometry is SHARED
    // by every placement of its asset and owned by the `BakedAsset` — a
    // placement teardown must never free it, and neither its BVH nor its
    // material (the uber singleton / the master's textured material).
    if (m.geometry && chunkMetaOf.has(m.geometry)) return;
    // Same contract for the shared sensor viz geometries (ray tube, collision
    // box + edges): refcounted and released by `RVSensor.dispose()`, never by
    // a tree walk that may only be tearing down ONE of their users.
    if (m.geometry && sharedVizGeometries.has(m.geometry)) return;
    // plan-774 R8: a keep clone shares its template's geometry — the asset's.
    if (m.geometry && !disposed.has(m.geometry) && !bakedKeepGeometries.has(m.geometry)) {
      disposed.add(m.geometry);
      m.geometry.dispose();
    }
    if (m.material) {
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      for (const mat of mats) {
        if (mat && !disposed.has(mat)) {
          disposed.add(mat);
          (mat as Material).dispose();
        }
      }
    }
  });
}
