// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Wire-proximity pick order — the picking rule of the editor's wireframe view.
 *
 * In wireframe nothing occludes on screen, so "the first surface along the ray"
 * is the wrong winner: a cover whose big triangles the cursor sits INSIDE would
 * swallow every click aimed at a part seen through it. Instead the hits of one
 * ray are re-ranked by how close the cursor is, in screen pixels, to an edge of
 * the hit triangle — the line the user is actually pointing at:
 *
 *   1. hits whose nearest edge is within {@link WIRE_PICK_THRESHOLD_PX} count as
 *      "on a wire" and keep their depth order among themselves (front wire wins);
 *   2. the rest follow, nearest edge first, depth as the tie-break.
 *
 * The ray is unchanged and so is the candidate set (the raycaster returns the
 * front-most triangle of every mesh on the ray) — only the ORDER differs, so
 * every gate behind it (exclusion, visibility, isolation, hover types) applies
 * exactly as in solid mode.
 */

import { Vector3 } from 'three';
import type { BufferAttribute, Camera, Intersection, InterleavedBufferAttribute, Mesh, Object3D, Ray } from 'three';

/** Cursor-to-line distance (CSS px) up to which a hit counts as "on the wire". */
export const WIRE_PICK_THRESHOLD_PX = 5;

const _cursor = new Vector3();
const _a = new Vector3();
const _b = new Vector3();
const _c = new Vector3();

/** Squared distance from point (px,py) to segment (ax,ay)-(bx,by). */
function distSqToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  if (t < 0) t = 0; else if (t > 1) t = 1;
  const cx = ax + t * dx - px, cy = ay + t * dy - py;
  return cx * cx + cy * cy;
}

/** World vertex → pixel coordinates in `out.x/.y`; false when behind the camera. */
function toPixels(v: Vector3, camera: Camera, halfW: number, halfH: number): boolean {
  v.project(camera);
  if (!Number.isFinite(v.x) || !Number.isFinite(v.y) || v.z > 1) return false;
  v.x = (v.x + 1) * halfW;
  v.y = (1 - v.y) * halfH;
  return true;
}

/**
 * Screen distance (CSS px) from the cursor to the nearest edge of the hit
 * triangle. `Infinity` when the hit carries no triangle this function can
 * place on screen (no face, instanced / skinned geometry, vertex behind the
 * camera) — such a hit is ranked last among the non-wire hits, by depth.
 */
export function wireDistancePx(
  hit: Intersection<Object3D>, cursorX: number, cursorY: number,
  camera: Camera, halfW: number, halfH: number,
): number {
  const face = hit.face;
  const mesh = hit.object as Mesh;
  if (!face || hit.instanceId !== undefined || (mesh as { isSkinnedMesh?: boolean }).isSkinnedMesh) return Infinity;
  const pos = mesh.geometry?.getAttribute?.('position') as BufferAttribute | InterleavedBufferAttribute | undefined;
  if (!pos) return Infinity;
  _a.fromBufferAttribute(pos, face.a).applyMatrix4(mesh.matrixWorld);
  _b.fromBufferAttribute(pos, face.b).applyMatrix4(mesh.matrixWorld);
  _c.fromBufferAttribute(pos, face.c).applyMatrix4(mesh.matrixWorld);
  if (!toPixels(_a, camera, halfW, halfH) || !toPixels(_b, camera, halfW, halfH) || !toPixels(_c, camera, halfW, halfH)) {
    return Infinity;
  }
  const d2 = Math.min(
    distSqToSegment(cursorX, cursorY, _a.x, _a.y, _b.x, _b.y),
    distSqToSegment(cursorX, cursorY, _b.x, _b.y, _c.x, _c.y),
    distSqToSegment(cursorX, cursorY, _c.x, _c.y, _a.x, _a.y),
  );
  return Math.sqrt(d2);
}

/**
 * Re-order `hits` (already distance-sorted) by wire proximity, in place.
 * `widthPx` / `heightPx` are the canvas' CSS size. The cursor is derived from
 * the ray itself, so screen picks, hover and arbitrary-ray picks all work.
 */
export function rankHitsByWireProximity(
  hits: Intersection<Object3D>[], ray: Ray, camera: Camera,
  widthPx: number, heightPx: number, thresholdPx: number = WIRE_PICK_THRESHOLD_PX,
): void {
  if (hits.length < 2) return;
  const halfW = widthPx * 0.5, halfH = heightPx * 0.5;
  // Any point on the ray projects onto the cursor.
  _cursor.copy(ray.origin).addScaledVector(ray.direction, 1);
  if (!toPixels(_cursor, camera, halfW, halfH)) return;
  const cx = _cursor.x, cy = _cursor.y;

  const ranked = hits.map((hit) => {
    const d = wireDistancePx(hit, cx, cy, camera, halfW, halfH);
    return { hit, score: d <= thresholdPx ? 0 : d };
  });
  ranked.sort((p, q) => (p.score - q.score) || (p.hit.distance - q.hit.distance));
  for (let i = 0; i < ranked.length; i++) hits[i] = ranked[i].hit;
}
