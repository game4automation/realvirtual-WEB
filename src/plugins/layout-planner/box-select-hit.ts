// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Pure hit-testing for the layout-planner box-select (marquee) feature.
 *
 * `computeBoxSelectPaths` walks the planner's `_objectMap`, projects each
 * placement's world-space AABB to NDC, and returns the scene-store paths of
 * placements whose 2D footprint intersects the user-drawn rectangle.
 *
 * `combineSelection` resolves modifier-key semantics (replace / union / xor)
 * against the current selection.
 *
 * Both functions are pure and unit-tested in `tests/box-select-hit.test.ts`.
 */

import { Box3, Vector3 } from 'three';
import type { Object3D, PerspectiveCamera, OrthographicCamera } from 'three';
import { isLockedLayoutInstance } from './layout-predicates';

/** Minimal node-registry surface — only `getPathForNode` is called. */
export interface BoxSelectRegistryLike {
  getPathForNode(node: Object3D): string | null;
}

/** Minimal MU-entry surface — the reconciler entry's node + pre-stored path. */
export interface BoxSelectMuEntry {
  node: Object3D;
  path: string;
}

/** Rectangle in canvas-client coordinates (CSS pixels relative to the canvas). */
export interface ClientRect {
  /** Left edge in canvas-client x. */
  l: number;
  /** Top edge in canvas-client y. */
  t: number;
  /** Width in CSS pixels. */
  w: number;
  /** Height in CSS pixels. */
  h: number;
}

export interface ModifierState {
  shift: boolean;
  ctrl: boolean;
}

// Module-scoped scratch — avoids GC churn (project pattern).
const _box = new Box3();
const _corner = new Vector3();
const _projected = new Vector3();

/**
 * Compute scene-store paths whose world-space AABB, projected to NDC,
 * intersects the marquee rectangle.
 *
 * @param camera Active scene camera.
 * @param canvas Renderer canvas. Used only for `getBoundingClientRect()` to
 *   convert the client-space rectangle to NDC.
 * @param rectClient Rectangle in canvas-client space.
 * @param objectMap Map of placement-id → Three.js root (the planner's `_objectMap`).
 * @param registry Provides `getPathForNode(root)` to resolve roots to scene paths.
 * @param muMap Optional map of spawned-MU entries (`{ node, path }`) — included
 *   in the marquee so MUs box-select like layout objects. The entry's stored
 *   synthetic path is used directly (no `getPathForNode`, no lock check).
 * @returns Deduplicated array of paths.
 */
export function computeBoxSelectPaths(
  camera: PerspectiveCamera | OrthographicCamera,
  canvas: HTMLCanvasElement,
  rectClient: ClientRect,
  objectMap: ReadonlyMap<string, Object3D>,
  registry: BoxSelectRegistryLike,
  muMap?: Iterable<BoxSelectMuEntry> | null,
): string[] {
  const ndc = clientRectToNdc(rectClient, canvas);
  const out: string[] = [];
  const seen = new Set<string>();

  for (const root of objectMap.values()) {
    if (isLockedLayoutInstance(root)) continue;
    if (!aabbIntersectsMarquee(root, camera, ndc)) continue;
    const path = registry.getPathForNode(root);
    if (path && !seen.has(path)) {
      seen.add(path);
      out.push(path);
    }
  }

  if (muMap) {
    for (const { node, path } of muMap) {
      if (!aabbIntersectsMarquee(node, camera, ndc)) continue;
      if (!seen.has(path)) { seen.add(path); out.push(path); }
    }
  }

  return out;
}

/**
 * Combine the marquee result with the current selection per modifier keys.
 *  - `ctrl` (or meta): toggle (XOR) — paths in EITHER list but not both.
 *  - `shift`: union — paths in ANY list.
 *  - neither: replace.
 *
 * Pure; takes ReadonlyArrays and returns a new array.
 */
export function combineSelection(
  current: ReadonlyArray<string>,
  marquee: ReadonlyArray<string>,
  mods: ModifierState,
): string[] {
  if (mods.ctrl) {
    const set = new Set(current);
    for (const p of marquee) {
      if (set.has(p)) set.delete(p);
      else set.add(p);
    }
    return [...set];
  }
  if (mods.shift) {
    return [...new Set([...current, ...marquee])];
  }
  return [...marquee];
}

// ─── Hit providers (plan-628 8.11a) ─────────────────────────────────────

/**
 * The marquee as a query for geometry that is not a placement root (path
 * blocks are lines, not Object3D roots in the planner's map). Same rectangle,
 * same camera, same any-overlap rule: an item is hit when any part of it lies
 * in the rectangle.
 */
export interface BoxSelectQuery {
  /**
   * True when any of the world-space segments touches the marquee. `pairs`
   * holds `[x0, y0, z0, x1, y1, z1, …]` — every 6 numbers are one segment
   * (the `LineSegments` layout). A segment with an end behind the camera is
   * skipped.
   */
  intersectsWorldSegments(pairs: ArrayLike<number>): boolean;
}

/**
 * A second selection holder the marquee feeds (plan-628 8.11a, E57): called on
 * every SELECTION commit of the marquee, after the placements went to the
 * selection manager, with the modifiers of the release (same replace / union /
 * toggle semantics as {@link combineSelection}).
 */
export interface BoxSelectHitProvider {
  commit(query: BoxSelectQuery, mods: ModifierState): void;
}

/** Build the query of one marquee release (canvas-client rectangle). */
export function createBoxSelectQuery(
  camera: PerspectiveCamera | OrthographicCamera,
  canvas: HTMLCanvasElement,
  rectClient: ClientRect,
): BoxSelectQuery {
  const ndc = clientRectToNdc(rectClient, canvas);
  const a = new Vector3();
  const b = new Vector3();
  const pa = new Vector3();
  const pb = new Vector3();
  return {
    intersectsWorldSegments(pairs: ArrayLike<number>): boolean {
      for (let i = 0; i + 5 < pairs.length; i += 6) {
        a.set(pairs[i], pairs[i + 1], pairs[i + 2]);
        b.set(pairs[i + 3], pairs[i + 4], pairs[i + 5]);
        if (!isInFrontOfCamera(a, camera) || !isInFrontOfCamera(b, camera)) continue;
        pa.copy(a).project(camera);
        pb.copy(b).project(camera);
        if (segmentIntersectsNdcRect(pa.x, pa.y, pb.x, pb.y, ndc)) return true;
      }
      return false;
    },
  };
}

/** Liang–Barsky: does the 2D segment (x0,y0)→(x1,y1) touch the rectangle? */
function segmentIntersectsNdcRect(x0: number, y0: number, x1: number, y1: number, r: NdcRect): boolean {
  const dx = x1 - x0;
  const dy = y1 - y0;
  let t0 = 0;
  let t1 = 1;
  const clip = (p: number, q: number): boolean => {
    if (p === 0) return q >= 0;
    const t = q / p;
    if (p < 0) { if (t > t1) return false; if (t > t0) t0 = t; } else { if (t < t0) return false; if (t < t1) t1 = t; }
    return true;
  };
  return clip(-dx, x0 - r.xMin) && clip(dx, r.xMax - x0) && clip(-dy, y0 - r.yMin) && clip(dy, r.yMax - y0) && t0 <= t1;
}

// ─── Internals ──────────────────────────────────────────────────────────

interface NdcRect {
  xMin: number;
  yMin: number;
  xMax: number;
  yMax: number;
}

/**
 * Convert a canvas-client rectangle to a NDC-space rectangle in [-1, +1].
 * Y axis flips because client-y grows downward while NDC-y grows upward.
 */
function clientRectToNdc(rect: ClientRect, canvas: HTMLCanvasElement): NdcRect {
  const cr = canvas.getBoundingClientRect();
  const w = cr.width || 1;
  const h = cr.height || 1;
  const x1 = ((rect.l - cr.left) / w) * 2 - 1;
  const x2 = ((rect.l + rect.w - cr.left) / w) * 2 - 1;
  // Y flip: client-top (smallest y) → NDC max y.
  const y1 = -((rect.t - cr.top) / h) * 2 + 1;
  const y2 = -((rect.t + rect.h - cr.top) / h) * 2 + 1;
  return {
    xMin: Math.min(x1, x2),
    xMax: Math.max(x1, x2),
    yMin: Math.min(y1, y2),
    yMax: Math.max(y1, y2),
  };
}

/**
 * Project the object's world-space AABB to NDC and test intersection with
 * the marquee rect (any-overlap mode).
 *
 * Behind-camera handling: a corner with `w <= 0` after projection has
 * flipped sign and would produce a false intersection. We track how many
 * corners are behind the camera; if ALL eight are behind, cull. Otherwise
 * we union only the in-front corners' NDC into the projected AABB —
 * straddling cases (object crosses the near plane) still get tested.
 */
function aabbIntersectsMarquee(
  root: Object3D,
  camera: PerspectiveCamera | OrthographicCamera,
  marquee: NdcRect,
): boolean {
  _box.makeEmpty();
  _box.setFromObject(root);
  if (_box.isEmpty()) return false;

  let xMin = Infinity, yMin = Infinity, xMax = -Infinity, yMax = -Infinity;
  let inFrontCount = 0;

  for (let i = 0; i < 8; i++) {
    _corner.set(
      i & 1 ? _box.max.x : _box.min.x,
      i & 2 ? _box.max.y : _box.min.y,
      i & 4 ? _box.max.z : _box.min.z,
    );
    _projected.copy(_corner).project(camera);
    // After Vector3.project, the result is already in NDC if the point is
    // in front of the camera. If it's behind, the perspective divide flips
    // signs — detect via the fact that projecting a behind-camera point
    // through OrthographicCamera also returns a valid NDC, so use a depth
    // check via camera-space transform.
    if (isInFrontOfCamera(_corner, camera)) {
      inFrontCount++;
      if (_projected.x < xMin) xMin = _projected.x;
      if (_projected.x > xMax) xMax = _projected.x;
      if (_projected.y < yMin) yMin = _projected.y;
      if (_projected.y > yMax) yMax = _projected.y;
    }
  }

  if (inFrontCount === 0) return false;

  // 2D AABB overlap test in NDC.
  return (
    xMax >= marquee.xMin &&
    xMin <= marquee.xMax &&
    yMax >= marquee.yMin &&
    yMin <= marquee.yMax
  );
}

const _camLocal = new Vector3();

/**
 * True when `pointWorld` is in front of the camera's view direction.
 * For PerspectiveCamera, "in front" means negative Z in camera space
 * (Three.js convention); for OrthographicCamera, the camera's local Z
 * axis points opposite to its view direction so the test is the same.
 */
function isInFrontOfCamera(
  pointWorld: Vector3,
  camera: PerspectiveCamera | OrthographicCamera,
): boolean {
  // Transform world point into camera local space.
  _camLocal.copy(pointWorld).applyMatrix4(camera.matrixWorldInverse);
  return _camLocal.z < 0;
}
