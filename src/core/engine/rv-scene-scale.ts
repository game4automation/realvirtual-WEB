// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * SceneScale — the ONE source of the scene's content bounds and scale
 * (plan-515 §2.3).
 *
 * Navigation (dynamic near/far, zoom-out cap) reads a {@link SceneScaleSnapshot}
 * every frame, but the scene is walked only when something invalidated it:
 *
 *  - `invalidate()` marks the snapshot stale; the next `get()` recomputes it
 *    (at most once per frame however many invalidations arrived). The viewer
 *    wires the five content events through {@link bindSceneScaleEvents}:
 *    `model-loaded`, `layout-content-added`, `layout-transform-update`,
 *    `layout-drag-end`, `model-cleared`.
 *  - While the simulation RUNS, {@link SceneScale.tick} recomputes only the
 *    bounds of the MOVING content (drive subtrees incl. MUs — the source knows
 *    them) at most every `throttleMs` (default 500 ms) and lets the box only
 *    GROW (R3-1). A drive without limits that carries a part far outside the
 *    load bounds is therefore inside far after <= 500 ms, without any layout
 *    event. When the simulation stops (or is reset) the next `get()` does a
 *    full recompute, so the box can shrink again.
 *
 * The bounds computation itself is NOT here: the source delegates to the
 * viewer's BatchedMesh-safe `_computeContentBounds` / `computeNodeBounds`
 * (no fifth copy of that walk).
 */

import { Box3, Vector3, type Mesh, type Object3D } from 'three';

/** Scene scale as navigation sees it. One mutable instance, reused. */
export interface SceneScaleSnapshot {
  /** Centre of the content bounds (world). */
  readonly center: Vector3;
  /** Radius of the bounding sphere in metres, >= {@link MIN_SCENE_RADIUS}. */
  radius: number;
  /** Largest edge length of the content bounds in metres. */
  maxDim: number;
  /** True when nothing draws (no content bounds). */
  empty: boolean;
}

/** What {@link SceneScale} needs from its host (the viewer, or a test double). */
export interface SceneScaleSource {
  /** Full content bounds into `out`; leave it empty when nothing draws. */
  computeContentBounds(out: Box3): void;
  /**
   * Bounds of the content that moves while the simulation runs (drive
   * subtrees incl. MUs) into `out`. Returns false when nothing moves.
   */
  computeMovingBounds(out: Box3): boolean;
}

/** Smallest reported radius (plan-515 §2.3: 0.5 mm). */
export const MIN_SCENE_RADIUS = 0.0005;
/** Default throttle of the moving-content recompute while the simulation runs (R3-1). */
export const MOVING_RECOMPUTE_MS = 500;

export interface SceneScaleOptions {
  /** Throttle of the moving-content recompute in ms (default {@link MOVING_RECOMPUTE_MS}). */
  throttleMs?: number;
}

export class SceneScale {
  /** Counters for tests / DevTools. */
  readonly stats = { fullComputes: 0, movingComputes: 0 };

  private readonly _source: SceneScaleSource;
  private readonly _throttleMs: number;
  private readonly _snap: SceneScaleSnapshot = { center: new Vector3(), radius: MIN_SCENE_RADIUS, maxDim: 0, empty: true };
  private readonly _box = new Box3();
  private readonly _moving = new Box3();
  private readonly _size = new Vector3();
  private readonly _listeners = new Set<(s: SceneScaleSnapshot) => void>();
  private _dirty = true;
  private _simRunning = false;
  private _lastMovingMs = Number.NEGATIVE_INFINITY;

  constructor(source: SceneScaleSource, opts: SceneScaleOptions = {}) {
    this._source = source;
    this._throttleMs = opts.throttleMs ?? MOVING_RECOMPUTE_MS;
  }

  /** Current snapshot; recomputes (one full walk) only after an invalidation. */
  get(): SceneScaleSnapshot {
    if (this._dirty) this._recomputeFull();
    return this._snap;
  }

  /** Mark the snapshot stale — the next {@link get} recomputes it. */
  invalidate(): void {
    this._dirty = true;
  }

  /** True while an invalidation is pending (the next `get()` walks the scene). */
  get isStale(): boolean { return this._dirty; }

  /** Subscribe to snapshot changes (fired after a recompute that changed it). */
  onChange(cb: (s: SceneScaleSnapshot) => void): () => void {
    this._listeners.add(cb);
    return () => { this._listeners.delete(cb); };
  }

  /**
   * Once per frame. `simRunning` = the simulation advances this frame.
   * Running: grow-only recompute of the moving content every `throttleMs`.
   * Running → stopped: full recompute on the next `get()`.
   */
  tick(nowMs: number, simRunning: boolean): void {
    if (!simRunning) {
      if (this._simRunning) { this._simRunning = false; this._dirty = true; }
      return;
    }
    if (!this._simRunning) {
      this._simRunning = true;
      this._lastMovingMs = nowMs;
      return;
    }
    if (nowMs - this._lastMovingMs < this._throttleMs) return;
    this._lastMovingMs = nowMs;
    if (this._dirty) { this._recomputeFull(); return; }
    this._moving.makeEmpty();
    if (!this._source.computeMovingBounds(this._moving) || this._moving.isEmpty()) return;
    this.stats.movingComputes++;
    if (this._box.containsBox(this._moving)) return;
    this._box.union(this._moving);
    this._publish();
  }

  // ─── internals ──────────────────────────────────────────────────

  private _recomputeFull(): void {
    this._dirty = false;
    this.stats.fullComputes++;
    this._box.makeEmpty();
    this._source.computeContentBounds(this._box);
    // While running, the moving content counts too (it may already be outside).
    if (this._simRunning) {
      this._moving.makeEmpty();
      if (this._source.computeMovingBounds(this._moving) && !this._moving.isEmpty()) this._box.union(this._moving);
    }
    this._publish();
  }

  private _publish(): void {
    const s = this._snap;
    const box = this._box;
    const finite = !box.isEmpty()
      && Number.isFinite(box.min.x + box.min.y + box.min.z + box.max.x + box.max.y + box.max.z);
    const prevEmpty = s.empty;
    const prevR = s.radius;
    const pcx = s.center.x, pcy = s.center.y, pcz = s.center.z;
    if (!finite) {
      s.empty = true;
      s.radius = MIN_SCENE_RADIUS;
      s.maxDim = 0;
      s.center.set(0, 0, 0);
    } else {
      box.getCenter(s.center);
      box.getSize(this._size);
      s.empty = false;
      s.maxDim = Math.max(this._size.x, this._size.y, this._size.z);
      s.radius = Math.max(this._size.length() / 2, MIN_SCENE_RADIUS);
    }
    const changed = prevEmpty !== s.empty || prevR !== s.radius
      || pcx !== s.center.x || pcy !== s.center.y || pcz !== s.center.z;
    if (changed) for (const cb of this._listeners) cb(s);
  }
}

/** The viewer events that change the content bounds (plan-515 §2.3). */
export const SCENE_SCALE_INVALIDATING_EVENTS = [
  'model-loaded',
  'layout-content-added',
  'layout-transform-update',
  'layout-drag-end',
  'model-cleared',
] as const;

/** Anything with an `on(event, cb) → unsubscribe` (RVViewer, EventEmitter). */
export interface SceneScaleEventSource {
  on(event: string, cb: (data: unknown) => void): () => void;
}

/** Invalidate `scale` on every content event of `events`; returns the unsubscribe. */
export function bindSceneScaleEvents(scale: SceneScale, events: SceneScaleEventSource): () => void {
  const offs = SCENE_SCALE_INVALIDATING_EVENTS.map((name) => events.on(name, () => scale.invalidate()));
  return () => { for (const off of offs) off(); };
}

// ─── The shared bounds walks (main viewer AND embed) ──────────────────

/**
 * Bounding box over the visible content under `root` into `out` (made empty
 * first), excluding non-content scenery: the ground fade disc, the reflection
 * mirror and the planner authoring floor. Cameras and lights are skipped
 * naturally (not meshes). Non-finite boxes are skipped — one NaN box would
 * poison the union for good.
 *
 * Only EFFECTIVELY visible meshes count (`traverseVisible`): a mesh whose own
 * flag is on but whose ancestor is hidden is not on screen. The agent-eye cone
 * (`_agentEyeOverlay`) is never content either — hidden it sat at the origin
 * and stretched the F-key framing out to (0,0,0), visible it pulls the box to
 * wherever the agent camera stands (plan-515 F framing finding).
 *
 * The ONE copy of this walk: `RVViewer._computeContentBounds` and the embed
 * facade (plan-515 Phase 1b) both call it, so the main viewer and the embed
 * derive near/far and zoom caps from the same bounds.
 */
export function computeContentBoundsInto(root: Object3D, out: Box3): Box3 {
  out.makeEmpty();
  const tmp = _tmpBox;
  root.traverseVisible((obj) => {
    const m = obj as Mesh;
    if (!m.isMesh || !m.geometry) return;
    const ud = m.userData;
    if (ud?._rvGroundPlane || ud?._rvGroundReflector || ud?._layoutFloor || ud?._agentEyeOverlay) return;
    m.updateWorldMatrix(true, false);
    if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
    if (!m.geometry.boundingBox) return;
    tmp.copy(m.geometry.boundingBox).applyMatrix4(m.matrixWorld);
    if (!Number.isFinite(tmp.min.x + tmp.min.y + tmp.min.z + tmp.max.x + tmp.max.y + tmp.max.z)) return;
    out.union(tmp);
  });
  return out;
}
const _tmpBox = new Box3();

/** What {@link computeMovingBoundsInto} reads of a drive. */
export interface MovingDriveLike { readonly node: Object3D | null | undefined }

/**
 * Bounds of the content that moves while the simulation runs (plan-515 R3-1),
 * unioned into `out`: the subtrees of the OUTERMOST drives (nested drives are
 * inside them, bounds via `nodeBounds` — the camera manager's BatchedMesh-safe
 * `computeNodeBounds`) and every MU's AABB. Throttled by {@link SceneScale}
 * (<= every 500 ms), so this may allocate. Returns false when nothing moves.
 */
export function computeMovingBoundsInto(
  drives: readonly MovingDriveLike[],
  mus: Iterable<unknown> | null | undefined,
  nodeBounds: (roots: Object3D[]) => Box3,
  out: Box3,
): boolean {
  let any = false;
  if (drives.length > 0) {
    const driveNodes = new Set<Object3D>();
    for (const d of drives) if (d.node) driveNodes.add(d.node);
    const roots: Object3D[] = [];
    for (const n of driveNodes) {
      let p = n.parent;
      let nested = false;
      while (p) { if (driveNodes.has(p)) { nested = true; break; } p = p.parent; }
      if (!nested) roots.push(n);
    }
    if (roots.length > 0) {
      const box = nodeBounds(roots);
      if (!box.isEmpty()) { out.union(box); any = true; }
    }
  }
  if (mus) {
    for (const mu of mus) {
      const a = (mu as { aabb?: { min: Vector3; max: Vector3 } }).aabb;
      if (!a) continue;
      out.expandByPoint(a.min);
      out.expandByPoint(a.max);
      any = true;
    }
  }
  return any;
}
