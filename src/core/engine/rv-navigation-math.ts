// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Navigation mathematics (plan-515) — pure, allocation-free functions for
 * scale-adaptive navigation: surface-relative wheel dolly, the zoom-out clamp,
 * dynamic near/far, cursor-anchored orthographic zoom, the orbit about a pivot
 * and the point-keeping pan (plan-515 Phase 2).
 *
 * Every function exists twice:
 *  - the readable scalar form (`dollyStep(d, n, s, min)` …) for callers and
 *    tests, and
 *  - an `…IO` form that reads its scalar inputs from and writes its result into
 *    a caller-owned {@link NavScalarIO} record. The per-frame navigation path
 *    uses ONLY the IO forms: V8 boxes a double into a fresh HeapNumber whenever
 *    it crosses a non-inlined call boundary (argument or return value), so
 *    doubles travel in record fields instead (plan-515 R3-5: controller + math
 *    allocate 0 B, measured). The scalar forms delegate to the IO forms through
 *    a module-level record — one implementation, no allocation either.
 *
 * Precedent: `fitDistanceBothAxesFor` (rv-camera-manager.ts).
 */

import { Vector3 } from 'three';
import type { Camera, OrthographicCamera, Plane, Quaternion, Vector2 } from 'three';

/** Minimal scene-scale snapshot the math needs (subset of plan-515 §2.3 SceneScaleSnapshot). */
export interface NavSceneScale {
  /** Centre of the content bounds (world). */
  readonly center: Vector3;
  /** Radius of the bounding sphere in metres, >= 0.0005. */
  radius: number;
}

/** near/far output record (reused by the caller). */
export interface NearFar {
  near: number;
  far: number;
}

/**
 * Scalar in/out record of the `…IO` functions — each reads the inputs named in
 * its doc and writes `result`. One record per caller, reused every frame.
 */
export interface NavScalarIO {
  /** dollyStepIO: distance to the surface (m). */
  dist: number;
  /** dollyStepIO: wheel notches, > 0 = in. */
  notches: number;
  /** dollyStepIO: fraction of the distance per notch. */
  step: number;
  /** dollyStepIO: smallest distance (m). */
  minDist: number;
  /** maxBackoffInsideIO: cap sphere radius (m); Infinity = no cap. */
  maxRadius: number;
  /** nearFarForIO / orthoNearFarForIO: focus distance (m). */
  focus: number;
  /** zoomOrthoAtCursorIO: zoom factor (> 1 = in). */
  factor: number;
  /** zoomOrthoAtCursorIO: smallest visible height (m). */
  minVisibleH: number;
  /** zoomOrthoAtCursorIO: largest visible height (m); Infinity = no cap. */
  maxVisibleH: number;
  /** orbitAboutPivotIO: yaw about world +Y (rad). */
  yaw: number;
  /** orbitAboutPivotIO: pitch about the camera's right axis (rad), > 0 = look up. */
  pitch: number;
  /** orbitAboutPivotIO: smallest angle (rad) between the view direction and the world vertical. */
  minPolar: number;
  /** cursorRayIO: cursor x in normalised device coordinates. */
  ndcX: number;
  /** cursorRayIO: cursor y in normalised device coordinates. */
  ndcY: number;
  /** Output of the last `…IO` call that has a scalar result. */
  result: number;
}

/** A fresh {@link NavScalarIO} (allocate once, reuse). */
export function createNavScalarIO(): NavScalarIO {
  // Non-integer seeds keep every field on the double representation from the start.
  return {
    dist: 0.5, notches: 0.5, step: 0.5, minDist: 0.5, maxRadius: 0.5,
    focus: 0.5, factor: 0.5, minVisibleH: 0.5, maxVisibleH: 0.5,
    yaw: 0.5, pitch: 0.5, minPolar: 0.5, ndcX: 0.5, ndcY: 0.5, result: 0.5,
  };
}

/** Depth-precision budget: far / near never exceeds this (plan-515 §2.3, R3-4). */
export const MAX_FAR_NEAR_RATIO = 1e7;
/** Smallest near plane distance in metres. */
export const MIN_NEAR = 1e-5;
/**
 * Moving-content fallback (plan-515 R3-1): far is at least this many focus
 * distances, so what the camera is looking at is never clipped while the
 * scene bounds of a running simulation catch up (throttled, <= 500 ms).
 */
export const FAR_FOCUS_FALLBACK = 4;
/**
 * Orbit pitch clamp (plan-515 Phase 2): the view direction keeps at least this
 * many radians from straight up / straight down (the historical trackpad
 * limit), so `lookAt(target)` in `OrbitControls.update()` never meets a pole.
 */
export const MIN_ORBIT_POLAR = 0.01;

const _io = createNavScalarIO();
const _right = new Vector3();
const _up = new Vector3();

// ─── dolly ────────────────────────────────────────────────────────────

/**
 * Surface-relative dolly step (reads `dist`, `notches`, `step`, `minDist`).
 *
 * `notches > 0` zooms IN: `d' = max(d·(1−s)^n, minDist)` — strictly smaller than
 * `d` while `d > minDist`, saturating at `minDist` (never below). `notches < 0`
 * zooms OUT: `d / (1−s)^|n|`. Zero notches is the identity. A start below the
 * minimum returns the minimum.
 */
export function dollyStepIO(io: NavScalarIO): void {
  const n = io.notches;
  if (n === 0) { io.result = io.dist; return; }
  const k = Math.pow(1 - io.step, n > 0 ? n : -n);
  io.result = Math.max(n > 0 ? io.dist * k : io.dist / k, io.minDist);
}

/** Scalar form of {@link dollyStepIO}. */
export function dollyStep(distToHit: number, notches: number, s: number, minDist: number): number {
  _io.dist = distToHit; _io.notches = notches; _io.step = s; _io.minDist = minDist;
  dollyStepIO(_io);
  return _io.result;
}

// ─── zoom-out clamp ───────────────────────────────────────────────────

/**
 * Zoom-out CLAMP (plan-515 §2.4; reads `maxRadius`): the largest distance
 * `t >= 0` the camera may move BACKWARDS along the unit ray direction `dir`
 * (to `cam − dir·t`) without leaving the sphere of radius `maxRadius` around
 * `center`. A camera already outside the sphere may not back off at all (0).
 * Infinity when `maxRadius` is not finite. The caller clamps, it never refuses.
 */
export function maxBackoffInsideIO(cam: Vector3, dir: Vector3, center: Vector3, io: NavScalarIO): void {
  const R = io.maxRadius;
  if (!(R < Infinity)) { io.result = Infinity; return; }
  const rx = cam.x - center.x, ry = cam.y - center.y, rz = cam.z - center.z;
  const k = rx * rx + ry * ry + rz * rz - R * R;
  if (k >= 0) { io.result = 0; return; }
  // |r − dir·t|² = R²  →  t² − 2bt + k = 0,  b = dir·r;  positive root (k < 0).
  const b = dir.x * rx + dir.y * ry + dir.z * rz;
  io.result = b + Math.sqrt(b * b - k);
}

/** Scalar form of {@link maxBackoffInsideIO}. */
export function maxBackoffInside(cam: Vector3, dir: Vector3, center: Vector3, maxRadius: number): number {
  _io.maxRadius = maxRadius;
  maxBackoffInsideIO(cam, dir, center, _io);
  return _io.result;
}

// ─── near / far ───────────────────────────────────────────────────────

function _distTo(a: Vector3, b: Vector3): number {
  const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * Perspective near/far from the focus distance (`io.focus`) and the scene
 * sphere (plan-515 §2.3, R3-4, R3-1).
 *
 * far = (|cam − centre| + radius)·1.1 — the farthest point of the scene sphere
 * plus 10 %; at least `FAR_FOCUS_FALLBACK · focus` (moving content). far is
 * NEVER capped: the depth budget `far/near <= 1e7` is kept by RAISING near,
 * `near = max(focus / 200, far / 1e7, MIN_NEAR)`. Distant geometry is never
 * clipped away; at 600 m the near plane is 0.066 mm, still below the 0.5 mm
 * dolly minimum, so near and far are visible at the same time.
 */
export function nearFarForIO(cam: Vector3, scale: NavSceneScale, io: NavScalarIO, out: NearFar): void {
  const f = io.focus;
  const focus = f > 0 && f < Infinity ? f : 0;
  const far = Math.max((_distTo(cam, scale.center) + scale.radius) * 1.1, focus * FAR_FOCUS_FALLBACK, MIN_NEAR * 1e3);
  out.far = far;
  out.near = Math.max(focus / 200, far / MAX_FAR_NEAR_RATIO, MIN_NEAR);
}

/** Scalar form of {@link nearFarForIO}. */
export function nearFarFor(focusDist: number, cam: Vector3, scale: NavSceneScale, out: NearFar): void {
  _io.focus = focusDist;
  nearFarForIO(cam, scale, _io, out);
}

/**
 * Orthographic near/far (reads `io.focus`): a slab around the scene sphere seen
 * from the camera. near = max(MIN_NEAR, dist − 2.5·radius), far = dist +
 * 2.5·radius, and at least `FAR_FOCUS_FALLBACK · focus` (moving content, R3-1).
 */
export function orthoNearFarForIO(cam: Vector3, scale: NavSceneScale, io: NavScalarIO, out: NearFar): void {
  const dist = _distTo(cam, scale.center);
  const pad = 2.5 * scale.radius;
  out.near = Math.max(MIN_NEAR, dist - pad);
  const f = io.focus;
  const focus = f > 0 && f < Infinity ? f : 0;
  out.far = Math.max(dist + pad, out.near * 1e3, focus * FAR_FOCUS_FALLBACK);
}

/** Scalar form of {@link orthoNearFarForIO}. */
export function orthoNearFarFor(cam: Vector3, scale: NavSceneScale, out: NearFar, focusDist = 0): void {
  _io.focus = focusDist;
  orthoNearFarForIO(cam, scale, _io, out);
}

// ─── framing floor ────────────────────────────────────────────────────

/** F-framing floor: 1 mm instead of the historical 10 cm (plan-515 F2). */
export function fitFloor(maxDim: number): number {
  return Math.max(maxDim, 0.001);
}

// ─── ortho zoom ───────────────────────────────────────────────────────

/**
 * Cursor-anchored orthographic zoom (reads `factor`, `minVisibleH`,
 * `maxVisibleH`; `result` = the new zoom).
 *
 * Multiplies `cam.zoom` by `factor`, clamped so the visible height
 * `(top − bottom) / zoom` stays within [`minVisibleH`, `maxVisibleH`], and writes
 * into `outCamShift` the lateral camera (and target) translation that keeps
 * `anchorWorld` at the same screen position. Assumes a symmetric frustum
 * (what `CameraManager.syncOrthoFrustum` produces) and an up-to-date
 * `cam.matrixWorld`. Does NOT write the camera — the caller applies the new
 * zoom and the shift.
 */
export function zoomOrthoAtCursorIO(cam: OrthographicCamera, anchorWorld: Vector3, outCamShift: Vector3, io: NavScalarIO): void {
  const frustumH = cam.top - cam.bottom;
  const zoom0 = cam.zoom;
  let newZoom = zoom0 * io.factor;
  // visible height = frustumH / zoom  →  zoom in [frustumH/maxH, frustumH/minH]
  const zoomMax = frustumH / io.minVisibleH;
  const zoomMin = io.maxVisibleH < Infinity ? frustumH / io.maxVisibleH : 0;
  if (newZoom > zoomMax) newZoom = zoomMax;
  if (newZoom < zoomMin) newZoom = zoomMin;
  const k = newZoom / zoom0;
  if (!(k > 0) || !(k < Infinity)) {
    outCamShift.x = 0; outCamShift.y = 0; outCamShift.z = 0;
    io.result = zoom0;
    return;
  }
  _right.setFromMatrixColumn(cam.matrixWorld, 0).normalize();
  _up.setFromMatrixColumn(cam.matrixWorld, 1).normalize();
  const rx = anchorWorld.x - cam.position.x, ry = anchorWorld.y - cam.position.y, rz = anchorWorld.z - cam.position.z;
  const w = 1 - 1 / k;
  const ax = (rx * _right.x + ry * _right.y + rz * _right.z) * w;
  const ay = (rx * _up.x + ry * _up.y + rz * _up.z) * w;
  outCamShift.x = _right.x * ax + _up.x * ay;
  outCamShift.y = _right.y * ax + _up.y * ay;
  outCamShift.z = _right.z * ax + _up.z * ay;
  io.result = newZoom;
}

/** Scalar form of {@link zoomOrthoAtCursorIO}; returns the new zoom. */
export function zoomOrthoAtCursor(
  cam: OrthographicCamera,
  factor: number,
  anchorWorld: Vector3,
  outCamShift: Vector3,
  minVisibleH = 0.001,
  maxVisibleH = Infinity,
): number {
  _io.factor = factor; _io.minVisibleH = minVisibleH; _io.maxVisibleH = maxVisibleH;
  zoomOrthoAtCursorIO(cam, anchorWorld, outCamShift, _io);
  return _io.result;
}

// ─── orbit about a pivot (Phase 2) ────────────────────────────────────

/** three's Quaternion component storage (behind the x/y/z/w accessors). */
interface QuaternionFields { _x: number; _y: number; _z: number; _w: number }

/**
 * Orbit the camera about `pivot` (plan-515 §2.3, Phase 2; reads `yaw`, `pitch`,
 * `minPolar`; `result` = the pitch actually applied).
 *
 * Yaw turns about the world +Y axis, pitch about the camera's own right axis;
 * position AND orientation are rotated by the SAME rotation, so the view does
 * not jump when the pivot is off the view axis (nothing is re-aimed at the
 * pivot) and the distance camera–pivot is preserved exactly. The camera stays
 * roll-free (its right axis stays horizontal). Pitch is clamped so the view
 * direction keeps at least `minPolar` from the world vertical; a view already
 * inside that band may only move out of it. Writes `outPos` / `outQuat` (may
 * alias `pos` / `quat`; the quaternion's components are written WITHOUT its
 * change callback — see the note at the write). Pure arithmetic — no call
 * carries a double.
 */
export function orbitAboutPivotIO(
  pos: Vector3, quat: Quaternion, pivot: Vector3, outPos: Vector3, outQuat: Quaternion, io: NavScalarIO,
): void {
  const qx = quat.x, qy = quat.y, qz = quat.z, qw = quat.w;
  // forward = −(third column), right = first column of the rotation matrix.
  const fy = -2 * (qy * qz - qw * qx);
  let rx = 1 - 2 * (qy * qy + qz * qz), ry = 2 * (qx * qy + qw * qz), rz = 2 * (qx * qz - qw * qy);
  const rl = Math.sqrt(rx * rx + ry * ry + rz * rz) || 1;
  rx /= rl; ry /= rl; rz /= rl;
  const polar = Math.acos(fy < -1 ? -1 : fy > 1 ? 1 : fy);
  const mp = io.minPolar;
  // pitch b > 0 tilts the view up (the polar angle of the view shrinks by b).
  let hi = polar - mp;
  let lo = polar - (Math.PI - mp);
  if (hi < 0) hi = 0;
  if (lo > 0) lo = 0;
  let b = io.pitch;
  if (b > hi) b = hi;
  if (b < lo) b = lo;
  const a = io.yaw;
  const sb = Math.sin(b * 0.5), cb = Math.cos(b * 0.5);
  const px = rx * sb, py = ry * sb, pz = rz * sb, pw = cb;
  const sa = Math.sin(a * 0.5), ca = Math.cos(a * 0.5);
  // R = yaw ⊗ pitch   (yaw = (0, sa, 0, ca))
  const Rx = ca * px + sa * pz;
  const Ry = ca * py + sa * pw;
  const Rz = ca * pz - sa * px;
  const Rw = ca * pw - sa * py;
  // outPos = pivot + R·(pos − pivot)
  const vx = pos.x - pivot.x, vy = pos.y - pivot.y, vz = pos.z - pivot.z;
  const tx = 2 * (Ry * vz - Rz * vy), ty = 2 * (Rz * vx - Rx * vz), tz = 2 * (Rx * vy - Ry * vx);
  const nx = pivot.x + vx + Rw * tx + (Ry * tz - Rz * ty);
  const ny = pivot.y + vy + Rw * ty + (Rz * tx - Rx * tz);
  const nz = pivot.z + vz + Rw * tz + (Rx * ty - Ry * tx);
  outPos.x = nx; outPos.y = ny; outPos.z = nz;
  // outQuat = R ⊗ quat (normalised)
  let ox = Rw * qx + Rx * qw + Ry * qz - Rz * qy;
  let oy = Rw * qy - Rx * qz + Ry * qw + Rz * qx;
  let oz = Rw * qz + Rx * qy - Ry * qx + Rz * qw;
  let ow = Rw * qw - Rx * qx - Ry * qy - Rz * qz;
  const ql = Math.sqrt(ox * ox + oy * oy + oz * oz + ow * ow) || 1;
  ox /= ql; oy /= ql; oz /= ql; ow /= ql;
  // Component fields, not the x/y/z/w setters: each setter fires the
  // quaternion's change callback — on an Object3D a full Euler re-sync of
  // `rotation` whose clamp() boxes doubles (measured ~27 B per tick, R3-5).
  // The Euler is re-synced by the next quaternion write through three's API
  // (`OrbitControls.update()` → `lookAt` in the same frame); position,
  // `updateMatrix()` and rendering read the quaternion itself.
  const oq = outQuat as unknown as QuaternionFields;
  oq._x = ox; oq._y = oy; oq._z = oz; oq._w = ow;
  io.result = b;
}

/**
 * Scalar form of {@link orbitAboutPivotIO} on a camera-like pose; returns the
 * pitch actually applied (after the pole clamp).
 */
export function orbitAboutPivot(
  cam: { position: Vector3; quaternion: Quaternion },
  pivot: Vector3,
  dYaw: number,
  dPitch: number,
  outPos: Vector3,
  outQuat: Quaternion,
  minPolar = MIN_ORBIT_POLAR,
): number {
  _io.yaw = dYaw; _io.pitch = dPitch; _io.minPolar = minPolar;
  orbitAboutPivotIO(cam.position, cam.quaternion, pivot, outPos, outQuat, _io);
  // Not a hot path: announce the change (an Object3D re-syncs its Euler).
  outQuat.set(outQuat.x, outQuat.y, outQuat.z, outQuat.w);
  return _io.result;
}

// ─── cursor ray + point-keeping pan (Phase 2) ─────────────────────────

/**
 * World ray through the cursor (reads `ndcX`, `ndcY`) — perspective and
 * orthographic alike: `outOrigin` = the cursor on the near plane, `outDir` =
 * the unit direction into the scene. Unprojects NDC depth −1 and 0 with the
 * camera's `projectionMatrixInverse` and `matrixWorld` (both must be current).
 * Written out instead of `Vector3.unproject`, so no double crosses a call.
 */
export function cursorRayIO(cam: Camera, io: NavScalarIO, outOrigin: Vector3, outDir: Vector3): void {
  const pi = cam.projectionMatrixInverse.elements;
  const mw = cam.matrixWorld.elements;
  const x = io.ndcX, y = io.ndcY;
  // near point (NDC z = −1), camera space
  let w = pi[3] * x + pi[7] * y - pi[11] + pi[15];
  const ax = (pi[0] * x + pi[4] * y - pi[8] + pi[12]) / w;
  const ay = (pi[1] * x + pi[5] * y - pi[9] + pi[13]) / w;
  const az = (pi[2] * x + pi[6] * y - pi[10] + pi[14]) / w;
  // mid point (NDC z = 0), camera space
  w = pi[3] * x + pi[7] * y + pi[15];
  const bx = (pi[0] * x + pi[4] * y + pi[12]) / w;
  const by = (pi[1] * x + pi[5] * y + pi[13]) / w;
  const bz = (pi[2] * x + pi[6] * y + pi[14]) / w;
  // to world
  const wax = mw[0] * ax + mw[4] * ay + mw[8] * az + mw[12];
  const way = mw[1] * ax + mw[5] * ay + mw[9] * az + mw[13];
  const waz = mw[2] * ax + mw[6] * ay + mw[10] * az + mw[14];
  const dx = mw[0] * bx + mw[4] * by + mw[8] * bz + mw[12] - wax;
  const dy = mw[1] * bx + mw[5] * by + mw[9] * bz + mw[13] - way;
  const dz = mw[2] * bx + mw[6] * by + mw[10] * bz + mw[14] - waz;
  outOrigin.x = wax; outOrigin.y = way; outOrigin.z = waz;
  const l = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
  outDir.x = dx / l; outDir.y = dy / l; outDir.z = dz / l;
}

/**
 * Point-keeping pan (plan-515 §2.3, Phase 2): the camera translation that puts
 * `grabbed` back under the cursor. The cursor ray (`origin`, `dir` — from
 * {@link cursorRayIO}) is intersected with the plane through `grabbed` with
 * the unit normal `normal` (the view direction at grab time); `outDelta` =
 * grabbed − intersection. Moving camera AND target by `outDelta` keeps the
 * point exactly under the cursor (a translation parallel to the plane maps the
 * cursor ray onto itself shifted by the delta). Returns false (delta 0) when
 * the ray runs parallel to the plane. Ray-plane arithmetic only — O(1), no pick.
 */
export function panKeepPointIO(origin: Vector3, dir: Vector3, grabbed: Vector3, normal: Vector3, outDelta: Vector3): boolean {
  const den = dir.x * normal.x + dir.y * normal.y + dir.z * normal.z;
  if (!(den > 1e-12 || den < -1e-12)) {
    outDelta.x = 0; outDelta.y = 0; outDelta.z = 0;
    return false;
  }
  const gx = grabbed.x - origin.x, gy = grabbed.y - origin.y, gz = grabbed.z - origin.z;
  const t = (gx * normal.x + gy * normal.y + gz * normal.z) / den;
  outDelta.x = gx - dir.x * t;
  outDelta.y = gy - dir.y * t;
  outDelta.z = gz - dir.z * t;
  return true;
}

const _rayO = new Vector3();
const _rayD = new Vector3();
const _gp = new Vector3();

/**
 * Scalar form of {@link panKeepPointIO} (plan signature): the camera
 * translation that moves the point where the cursor ray (`ndc`) meets `plane`
 * onto `grabbed` — i.e. keeps `grabbed` under the cursor. `plane` normally
 * passes through `grabbed` (⟂ view direction); otherwise `grabbed` is first
 * projected onto it. The camera's matrices must be current.
 */
export function panKeepPoint(cam: Camera, grabbed: Vector3, plane: Plane, ndc: Vector2, outDelta: Vector3): boolean {
  _io.ndcX = ndc.x; _io.ndcY = ndc.y;
  cursorRayIO(cam, _io, _rayO, _rayD);
  const n = plane.normal;
  const off = n.x * grabbed.x + n.y * grabbed.y + n.z * grabbed.z + plane.constant;
  _gp.copy(grabbed).addScaledVector(n, -off);
  const ok = panKeepPointIO(_rayO, _rayD, _gp, n, outDelta);
  if (ok) outDelta.add(grabbed).sub(_gp);
  return ok;
}
