// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Model loading, caching, and GLB post-processing helpers for the Layout Planner.
 *
 * - ModelCache: loads + caches GLB models, returns clones
 * - pivotToFloorCenter: recalculates pivot to bottom-center of full AABB
 * - alignToFloor: shifts a group so its bounding box bottom sits at Y=0
 *
 * `unwrapGltfRoot` now lives in `core/engine/rv-gltf-unwrap` — the editor's
 * `parseGlbSubtree` needs the identical definition of "content root". It is
 * re-exported here (and from the plugin index) for backwards compatibility.
 */

import {
  Group,
  Vector3,
  Box3,
  Raycaster,
} from 'three';
import type { Object3D, Scene, Mesh } from 'three';
import type { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { disposeSubtree } from './three-utils';
import { RVAssetBlobCache } from '../../core/engine/rv-asset-blob-cache';
import { unwrapGltfRoot } from '../../core/engine/rv-gltf-unwrap';

export { unwrapGltfRoot };

// ─── Pivot to Floor ─────────────────────────────────────────────────────

const _pivotBox = new Box3();
const _pivotCenter = new Vector3();
const _pivotWorld = new Vector3();
const _pivotOrigPos = new Vector3();

/** Marker component name written by the Unity WebPivot MonoBehaviour into
 *  rv_extras. Presence of this key on any descendant signals an explicit,
 *  hand-authored pivot point that overrides the auto AABB pivot. */
const WEB_PIVOT_KEY = 'WebPivot';

/**
 * Find the first descendant whose rv_extras carries a WebPivot marker.
 * Walks the subtree depth-first and stops at the first match — multiple
 * markers per library object are not supported and the first wins.
 */
function findWebPivotMarker(root: Object3D): Object3D | null {
  let found: Object3D | null = null;
  root.traverse((node) => {
    if (found) return;
    const rv = (node.userData as { realvirtual?: Record<string, unknown> } | undefined)?.realvirtual;
    if (rv && rv[WEB_PIVOT_KEY]) found = node;
  });
  return found;
}

/**
 * Recalculate pivot so the local origin lands at either:
 *   1. an explicit Unity-authored WebPivot marker child (if present), or
 *   2. the bottom-center of the model's full axis-aligned bounding box.
 *
 * WebPivot path: the marker's world position is taken as the new origin —
 * both XZ and Y come from the marker. Use this when a library object needs
 * its rotation/snap origin somewhere other than the AABB floor-center
 * (e.g. a robot mounted on a wall, a fixture with an off-center base).
 *
 * AABB path: XZ = AABB centroid, Y = AABB.min.y. Predictable and explicit;
 * asymmetric models (robot with long arm overhang, L-shaped fixture) get a
 * pivot at the AABB centroid above the floor — that's the documented
 * fallback. Callers that need a contact-footprint pivot should provide a
 * WebPivot marker instead.
 *
 * In both cases every direct child of `obj` is shifted by the negative
 * offset so the visual position of the geometry is unchanged.
 */
export function pivotToFloorCenter(obj: Group): void {
  // We compute everything in obj's LOCAL space so the offsets we add to
  // child.position (which are local-space values) line up with the AABB
  // that Three.js' setFromObject reports (which is world-space). To bridge
  // the two, temporarily neutralize obj's own transform — then world-space
  // coordinates _are_ obj's local-space coordinates. Without this step,
  // any non-zero obj.position would offset the gizmo from the mesh by
  // exactly obj.position (Unity-authored library objects whose root sat at
  // a non-origin position are the typical trigger).
  _pivotOrigPos.copy(obj.position);
  const origRotX = obj.rotation.x;
  const origRotY = obj.rotation.y;
  const origRotZ = obj.rotation.z;
  obj.position.set(0, 0, 0);
  obj.rotation.set(0, 0, 0);
  obj.updateMatrixWorld(true);

  const marker = findWebPivotMarker(obj);
  let offsetX: number;
  let offsetY: number;
  let offsetZ: number;

  if (marker) {
    // WebPivot wins. With obj reset to identity, the marker's world position
    // _is_ its position in obj's local space — which is exactly the value
    // we need to subtract from every direct child.
    marker.getWorldPosition(_pivotWorld);
    offsetX = -_pivotWorld.x;
    offsetY = -_pivotWorld.y;
    offsetZ = -_pivotWorld.z;
  } else {
    _pivotBox.setFromObject(obj);
    if (_pivotBox.isEmpty()) {
      obj.position.copy(_pivotOrigPos);
      obj.rotation.set(origRotX, origRotY, origRotZ);
      return;
    }
    _pivotBox.getCenter(_pivotCenter);
    offsetX = -_pivotCenter.x;
    offsetZ = -_pivotCenter.z;
    offsetY = -_pivotBox.min.y;
  }

  for (const child of obj.children) {
    child.position.x += offsetX;
    child.position.y += offsetY;
    child.position.z += offsetZ;
  }

  obj.position.copy(_pivotOrigPos);
  obj.rotation.set(origRotX, origRotY, origRotZ);
}

// ─── Align to Floor ─────────────────────────────────────────────────────

const _alignBox = new Box3();

/** Shift group so its bounding box bottom sits at Y=0. */
export function alignToFloor(obj: Group): void {
  _alignBox.setFromObject(obj);
  if (_alignBox.isEmpty()) return;
  obj.position.y -= _alignBox.min.y;
}

// ─── Drop to Surface ───────────────────────────────────────────────────

const _dropBox = new Box3();
const _dropOrigin = new Vector3();
const _dropDir = new Vector3(0, -1, 0);
const _dropRaycaster = new Raycaster();

/**
 * Build the list of meshes a `dropToSurface` raycast should consider — every
 * visible scene mesh except `selfObj`'s own descendants and infrastructure
 * (ghosts, gizmos, layout floor, ground plane, highlight/ghost overlays).
 *
 * Exposed as a separate helper so callers can cache the result across many
 * raycasts of the SAME object — e.g. live drop-to-surface during a drag,
 * where the scene composition doesn't change between pointermove frames.
 * The `scene.traverse` is the expensive part of `dropToSurface`; caching
 * cuts a per-frame O(scene-mesh-count) walk down to a single raycast.
 */
export function collectDropTargets(scene: Scene, selfObj: Object3D): Mesh[] {
  const selfMeshes = new Set<Object3D>();
  selfObj.traverse((child) => { selfMeshes.add(child); });

  const targets: Mesh[] = [];
  scene.traverse((child) => {
    if (!(child as Mesh).isMesh) return;
    if (selfMeshes.has(child)) return;
    if (!child.visible) return;
    if (child.userData._isGhost) return;
    if (child.userData._isSourceGhost) return; // source preview ghost — not a drop surface
    if (child.userData._isSourcePreview) return; // source showcase instance — not a drop surface
    if (child.userData._layoutFloor) return;
    if (child.userData._rvGizmo || hasAncestorTag(child, '_rvGizmo')) return;
    if (child.userData._rvGizmoOverlay) return;
    if (child.userData._highlightOverlay) return;
    if (child.userData._isGhostOverlay) return;
    if (child.userData._rvGroundPlane || hasAncestorTag(child, '_rvGroundPlane')) return;
    // FloorGizmo: walk ancestors. The gizmo's hidden Y-axis bars sit inside
    // a Group with visible=false, but Three.js's per-mesh raycast only checks
    // the mesh's own visibility, so the seg meshes still get hit. Match the
    // gizmo root by name to exclude every descendant in one check.
    if (hasAncestorNamed(child, '_floorGizmo')) return;
    targets.push(child as Mesh);
  });
  return targets;
}

/**
 * Raycast downward to find the highest surface below the object's XZ footprint
 * and place its bounding box bottom on that surface. Falls back to Y=0 (floor)
 * if no elevated surface is hit.
 *
 * @param obj      The placed object (must already be in the scene).
 * @param scene    The Three.js scene to raycast against.
 * @param targets  Optional pre-computed candidate-mesh list (see
 *                 `collectDropTargets`). When omitted, this function
 *                 traverses the scene itself — the expected cost on
 *                 single one-shot drops at drag-end. Pass a cached list
 *                 for live drop during a drag (60 Hz).
 * @returns        The surface Y the object was placed on (0 if floor).
 */
export function dropToSurface(
  obj: Object3D,
  scene: Scene,
  targets?: Mesh[],
  centerOnBelt = false,
): number {
  scene.updateMatrixWorld(true);
  _dropBox.setFromObject(obj);
  if (_dropBox.isEmpty()) return 0;

  // Offset from obj.position.y to the bounding box bottom — we preserve this
  // so the pivot stays correct regardless of where the object's local origin is.
  // ASSUMPTION: obj.parent is at world identity (no scaling, no Y offset). True
  // for single-select planner placements parented to layoutRoot / modelRoot.
  // Multi-select members are temporarily under a centroid pivot Group — callers
  // should NOT invoke this from inside a multi-select drag.
  const pivotToBottom = obj.position.y - _dropBox.min.y;

  const candidates = targets ?? collectDropTargets(scene, obj);

  if (candidates.length === 0) {
    obj.position.y = pivotToBottom;
    return 0;
  }

  // Cast a single downward ray from the bbox XZ center
  const cx = (_dropBox.min.x + _dropBox.max.x) / 2;
  const cz = (_dropBox.min.z + _dropBox.max.z) / 2;
  const castY = 50; // well above any scene content
  _dropRaycaster.far = 100;
  _dropOrigin.set(cx, castY, cz);
  _dropRaycaster.set(_dropOrigin, _dropDir);

  const hits = _dropRaycaster.intersectObjects(candidates, false);
  if (hits.length > 0) {
    const surfaceY = hits[0].point.y;
    if (surfaceY > 0.01) {
      // Lateral centering: when requested and we landed on a transport-surface
      // drop plane, snap the object's XZ onto the belt's centre line (keeps the
      // along-belt position; only the cross-belt offset is removed). The plane
      // carries a back-reference to its RVTransportSurface in userData.
      if (centerOnBelt) {
        const surf = hits[0].object.userData._rvDropSurfaceInstance as
          { snapToCenterLine?(p: Vector3): void } | undefined;
        surf?.snapToCenterLine?.(obj.position);
      }
      obj.position.y = surfaceY + pivotToBottom;
      return surfaceY;
    }
  }

  // No elevated surface — place on floor (Y=0)
  obj.position.y = pivotToBottom;
  return 0;
}

/**
 * Drop a multi-select PIVOT Group to the surface below.
 *
 * Companion to {@link dropToSurface} for the centroid pivot built by
 * MultiSelectPivot during multi-object drags. Key differences:
 *
 *   - **Cast XZ:** the pivot's CURRENT world XZ (= the transform gizmo's
 *     position). The bbox center would be wrong for asymmetric selections
 *     (e.g. one big + one small object), because the user reads the gizmo,
 *     not the bbox.
 *   - **Adjust target:** shifts `pivot.position.y` by the delta required to
 *     put the UNION AABB bottom on the surface. Members move rigidly as
 *     the pivot's children, so relative Y offsets between selected objects
 *     are preserved.
 *
 * @param pivot    The selection pivot Group (members live as its children).
 * @param scene    The Three.js scene to raycast against.
 * @param targets  Optional pre-computed candidate-mesh list (see
 *                 {@link collectDropTargets}). Pass a cached list for live
 *                 drop during a drag (60 Hz).
 * @returns        The surface Y the selection was placed on (0 if floor).
 */
export function dropPivotToSurface(
  pivot: Object3D,
  scene: Scene,
  targets?: Mesh[],
): number {
  scene.updateMatrixWorld(true);
  _dropBox.setFromObject(pivot);
  if (_dropBox.isEmpty()) return 0;

  const candidates = targets ?? collectDropTargets(scene, pivot);

  // Cast from the pivot's WORLD XZ — that's exactly where the user sees
  // the gizmo. The pivot is always parented to the scene root, so world
  // XZ equals local XZ; getWorldPosition is the defensive choice.
  pivot.getWorldPosition(_dropOrigin);
  const castX = _dropOrigin.x;
  const castZ = _dropOrigin.z;

  let surfaceY = 0;
  if (candidates.length > 0) {
    const castUp = 50; // well above any scene content
    _dropRaycaster.far = 100;
    _dropOrigin.set(castX, castUp, castZ);
    _dropRaycaster.set(_dropOrigin, _dropDir);
    const hits = _dropRaycaster.intersectObjects(candidates, false);
    if (hits.length > 0 && hits[0].point.y > 0.01) {
      surfaceY = hits[0].point.y;
    }
  }

  // delta = where the union-bbox bottom should land minus where it is now.
  // Apply to pivot.position.y so every child member shifts rigidly.
  pivot.position.y += surfaceY - _dropBox.min.y;
  return surfaceY;
}

/** Check if `child` is a descendant of `ancestor` (or is `ancestor` itself). */
function isDescendantOf(child: Object3D, ancestor: Object3D): boolean {
  let cur: Object3D | null = child;
  while (cur) {
    if (cur === ancestor) return true;
    cur = cur.parent;
  }
  return false;
}

/** Check if any ancestor (including self) has the given userData tag set to truthy. */
function hasAncestorTag(obj: Object3D, tag: string): boolean {
  let cur: Object3D | null = obj.parent;
  while (cur) {
    if (cur.userData[tag]) return true;
    cur = cur.parent;
  }
  return false;
}

/** Check if `obj` itself or any ancestor has the given name. */
function hasAncestorNamed(obj: Object3D, name: string): boolean {
  let cur: Object3D | null = obj;
  while (cur) {
    if (cur.name === name) return true;
    cur = cur.parent;
  }
  return false;
}

/**
 * Placement roots must be transform-neutral: the planner stamps the placement
 * position/rotation/scale directly onto the placed root (materialize/restore
 * paths), which would destroy any intrinsic root transform the asset carries —
 * e.g. the 0.001 mm→m scale a CAD import bakes onto its content root
 * ("way too large" bug for editor-saved CAD assets). Wrap such roots in an
 * identity Group so the intrinsic transform survives inside.
 */
export function ensureNeutralPlacementRoot(source: Group): Group {
  const { position: t, quaternion: q, scale: s } = source;
  const identity =
    t.x === 0 && t.y === 0 && t.z === 0 &&
    q.x === 0 && q.y === 0 && q.z === 0 && q.w === 1 &&
    s.x === 1 && s.y === 1 && s.z === 1;
  if (identity) return source;
  const wrapper = new Group();
  wrapper.name = source.name || 'Asset';
  wrapper.add(source);
  return wrapper;
}

// ─── Model Cache ────────────────────────────────────────────────────────

/** Cache API bucket for all planner GLBs (catalog, GitHub, AM). */
const GLB_CACHE_BUCKET = 'rv-planner-glbs';

/** Shared blob cache singleton — also exposed for tooling that needs to wipe it. */
const _glbBlobCache = new RVAssetBlobCache({ bucket: GLB_CACHE_BUCKET });

/** The rejection an aborted `getOrLoad` consumer receives. */
export class AbortError extends Error {
  readonly name = 'AbortError';
  constructor(message = 'Aborted') { super(message); }
}

/** Reject immediately when the caller is already gone. */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new AbortError();
}

/**
 * Resolve with `work`, or reject as soon as `signal` aborts — WITHOUT
 * cancelling `work` itself. The shared load keeps running for every other
 * consumer (plan-371 H5/R12); this consumer simply stops listening.
 */
function detachOnAbort<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return work;
  // The abandoned promise must still have a handler, or an eventual rejection
  // would surface as an unhandled rejection.
  work.catch(() => { /* owned by whoever still awaits it */ });
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new AbortError());
    if (signal.aborted) { onAbort(); return; }
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
      (err) => { signal.removeEventListener('abort', onAbort); reject(err); },
    );
  });
}

export class ModelCache {
  /** Decoded Three.js Group cache — clones are returned to callers. */
  private _decoded = new Map<string, Group>();
  /**
   * In-flight DECODES, keyed by url (plan-371 §2.10).
   *
   * `_decoded` only ever holds finished results, so without this map two
   * overlapping `getOrLoad` calls for the same url decode the same GLB twice —
   * exactly the situation the hover prefetch creates (prefetch still running,
   * drag starts). Three rules keep the map from introducing bugs of its own;
   * they are spelled out at their enforcement sites in {@link _shared} and
   * {@link invalidate}.
   */
  private _inflight = new Map<string, Promise<Group>>();
  /**
   * Invalidation counter per url. A decode records the epoch it started under
   * and refuses to publish into `_decoded` if `invalidate()` has bumped it
   * meanwhile — dropping the promise from `_inflight` alone is NOT enough,
   * because the abandoned decode still runs to completion and would otherwise
   * re-install the very tree the invalidate was meant to evict.
   */
  private _epoch = new Map<string, number>();
  private _loader: GLTFLoader;

  constructor(loader: GLTFLoader) {
    this._loader = loader;
  }

  /**
   * Get a clone of the cached model, loading it first if needed.
   *
   * `opts.signal` (plan-371) detaches THIS consumer from the result — it does
   * NOT cancel the underlying work. That is deliberate: the blob layer beneath
   * (`RVAssetBlobCache._pending`) de-duplicates in-flight fetches URL-wide, so
   * a real abort would tear down the download of an unrelated second placement
   * of the same asset. The load runs to completion, lands in the cache, and
   * benefits whoever asks next.
   */
  async getOrLoad(url: string, opts?: { signal?: AbortSignal }): Promise<Group> {
    const signal = opts?.signal;
    throwIfAborted(signal);

    const cached = this._decoded.get(url);
    if (cached) return cached.clone();

    const source = await detachOnAbort(this._shared(url), signal);
    return source.clone();
  }

  /**
   * Warm the caches for `url` without producing a clone — fire-and-forget.
   *
   * Called from the library panel's hover intent (plan-371 F8): by the time the
   * user actually starts dragging, fetch and decode are already under way, and
   * the drag's own `getOrLoad` joins the very same promise instead of starting
   * a second one.
   *
   * Never rejects: a prefetch that fails is simply a prefetch that did not
   * help, and the real load re-runs (and re-reports) it moments later.
   */
  prefetch(url: string): void {
    if (!url) return;
    if (this._decoded.has(url)) return;
    this._shared(url).catch(() => { /* speculative — the real load reports */ });
  }

  /**
   * The ONE in-flight decode promise for `url`, created on first ask.
   *
   * RULE 1 — cleanup in every case. Without the settle handler a REJECTED
   * promise would stay in the map forever, and every later caller (including
   * `PendingGeometryRegistry.retry()`) would be handed the same stale failure:
   * a retry that can never succeed, silently. Registering the handler also
   * means the shared promise always has a rejection handler, so a decode whose
   * consumers all detached never surfaces as an unhandled rejection.
   *
   * RULE 2 — no `signal` here on purpose. Aborting is a per-consumer concern
   * and is applied one level up in `getOrLoad` via `detachOnAbort`; cancelling
   * the shared work would tear down an unrelated second placement of the same
   * asset (the same bug class as H5, one layer higher).
   */
  private _shared(url: string): Promise<Group> {
    const existing = this._inflight.get(url);
    if (existing) return existing;

    const decode = this._decode(url);
    this._inflight.set(url, decode);
    // `then(settle, settle)` rather than `finally`: it consumes the rejection
    // instead of re-raising it on a derived promise nobody awaits.
    const settle = (): void => {
      if (this._inflight.get(url) === decode) this._inflight.delete(url);
    };
    decode.then(settle, settle);
    return decode;
  }

  /** Fetch + decode + normalize one GLB into the decoded cache. */
  private async _decode(url: string): Promise<Group> {
    const epoch = this._epoch.get(url) ?? 0;

    // Resolve bytes via the generic blob cache (in-memory + Cache API).
    // For blob: URLs the cache pass-throughs so the GLTFLoader can read
    // them directly without an extra fetch hop.
    const loadUrl = url.startsWith('blob:')
      ? url
      : await _glbBlobCache.getObjectUrl(url);

    try {
      const gltf = await this._loader.loadAsync(loadUrl);
      let source = gltf.scene as Group;
      // Strip UnityGLTF __root__ wrapper and non-content nodes
      source = unwrapGltfRoot(source);
      source = ensureNeutralPlacementRoot(source);
      // Publish only if this decode has not been invalidated while it ran. The
      // caller still gets its result — it asked before the invalidate — but the
      // CACHE must not be repopulated with a superseded tree.
      if ((this._epoch.get(url) ?? 0) === epoch) this._decoded.set(url, source);
      return source;
    } finally {
      if (loadUrl !== url) URL.revokeObjectURL(loadUrl);
    }
  }

  /** Fetch raw GLB bytes for a (blob or object) URL. Test seam. */
  protected async _fetchBytes(url: string): Promise<ArrayBuffer> {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`GLB fetch failed (${resp.status}) for ${url}`);
    return resp.arrayBuffer();
  }

  get size(): number { return this._decoded.size; }

  /**
   * Drop ONE decoded entry (dispose its geometry) — the editor-save
   * invalidation hook: a re-saved library asset must not be served from the
   * pre-save decoded tree. No-op on unknown URLs.
   */
  invalidate(url: string): void {
    // RULE 3 (plan-371 §2.10) — TWO steps, and the second is the load-bearing
    // one. Dropping the promise makes the next ask start a fresh decode; bumping
    // the epoch stops the abandoned decode (which keeps running regardless)
    // from publishing the pre-save tree back into `_decoded` when it lands.
    this._inflight.delete(url);
    this._epoch.set(url, (this._epoch.get(url) ?? 0) + 1);
    const entry = this._decoded.get(url);
    if (!entry) return;
    disposeSubtree(entry);
    this._decoded.delete(url);
  }

  /** Clear the persistent browser cache for all planner GLBs. */
  static async clearPersistentCache(): Promise<void> {
    await _glbBlobCache.clearPersistent();
  }

  dispose(): void {
    for (const [, model] of this._decoded) {
      disposeSubtree(model);
    }
    this._decoded.clear();
    // In-flight decodes are abandoned, not cancelled — see `_shared`. Their
    // settle handlers are harmless no-ops once the map is empty.
    this._inflight.clear();
  }
}
