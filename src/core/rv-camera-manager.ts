// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * CameraManager — Manages perspective/orthographic camera switching,
 * camera animation, viewport offset computation, and FOV control.
 *
 * Internal implementation detail of RVViewer — not part of public API.
 * Receives a reference to shared viewer state via ViewerCameraState.
 */

import {
  PerspectiveCamera,
  OrthographicCamera,
  Vector3,
  Quaternion,
  Euler,
  Box3,
  Matrix4,
  Mesh,
  Object3D,
} from 'three';
import type { Renderer } from 'three/webgpu';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { ProjectionType } from './hmi/visual-settings-store';
import type { LeftPanelManager } from './hmi/left-panel-manager';
import type { FollowSource } from './engine/rv-follow-source';
import { chunkBoundsOfNode } from './engine/rv-traverse-utils';

/** Follow/Sit-On tracking mode. */
export type CameraFollowMode = 'off' | 'follow' | 'siton';
export type CameraFollowOwner = 'selection' | 'agent-eye';

/**
 * Distance a camera with `fovDeg` / `aspect` needs so `maxDim` fits BOTH axes,
 * scaled by `margin`. The canonical fit formula, lifted out of
 * {@link CameraManager.fitDistanceBothAxes} so the AI agent's camera — which
 * has its own lens and no OrbitControls — can frame with the identical maths
 * instead of a second copy of it (plan-740 P1.6).
 */
export function fitDistanceBothAxesFor(
  maxDim: number, fovDeg: number, aspect: number, margin = 1,
): number {
  const fov = fovDeg * (Math.PI / 180);
  const halfTan = Math.tan(fov / 2);
  const distV = maxDim / (2 * halfTan);
  const distH = maxDim / (2 * halfTan * aspect);
  return Math.max(distV, distH) * margin;
}

/** Frame rate at which an OrbitControls `dampingFactor` is defined (plan-568). */
export const DAMPING_REFERENCE_HZ = 60;

/**
 * Per-update OrbitControls damping factor for a frame of `dtSec` seconds, so a
 * `dampingFactor` defined per 60 Hz frame decays over the SAME wall time at
 * any render rate (plan-568: 30 FPS cap, 144 Hz displays):
 * `1 - (1 - factor)^(dtSec * 60)`. At exactly 1/60 s it returns `factor`.
 */
export function timeScaledDampingFactor(factor: number, dtSec: number): number {
  if (!(factor > 0) || factor >= 1) return factor;
  if (!(dtSec > 0)) return 0;
  return 1 - Math.pow(1 - factor, dtSec * DAMPING_REFERENCE_HZ);
}

/**
 * Follow smoothing rate (per second) for the frame-rate-independent damping
 * `alpha = 1 - exp(-FOLLOW_DAMPING * dt)`. Higher = snappier follow.
 */
const FOLLOW_DAMPING = 12;

/** Look sensitivity (radians per pixel) for Sit-On mouse look. */
const LOOK_SENSITIVITY = 0.0025;

/** Pitch clamp for Sit-On look (slightly under 90° to avoid gimbal flip). */
const MAX_LOOK_PITCH = Math.PI / 2 - 0.01;

/** Pixel offsets for panels obscuring the 3D viewport. */
export interface ViewportOffset {
  left?: number;
  right?: number;
  top?: number;
  bottom?: number;
}

/** Shared state that CameraManager reads/writes on the facade. */
export interface ViewerCameraState {
  perspCamera: PerspectiveCamera;
  orthoCamera: OrthographicCamera;
  _activeCamera: PerspectiveCamera | OrthographicCamera;
  controls: OrbitControls;
  renderer: Renderer;
  _renderDirty: boolean;
  leftPanelManager: LeftPanelManager;
  getPlugin<T>(id: string): T | undefined;
}

/** Camera animation state. */
export interface CameraAnimation {
  startPos: Vector3;
  endPos: Vector3;
  startTgt: Vector3;
  endTgt: Vector3;
  elapsed: number;
  duration: number;
  easing: CameraEasing;
  /** Who started the flight (plan-520) — lets a user gesture cancel only the MCP follow flight. */
  tag?: string;
  /** Refresh moving destinations immediately before each interpolation step. */
  updateEndpoint?: (position: Vector3, target: Vector3) => void;
}

/** Camera-flight easing. `easeOut` = snappy response to a user click (default);
 *  `easeInOut` = cinematic start-and-stop-smooth (MCP/agent-driven flights). */
export type CameraEasing = 'easeOut' | 'easeInOut';

/**
 * Projection-swap animation state. Element-wise lerp between two camera
 * projection matrices. The intermediate matrices aren't strictly valid
 * projections, but the lerp visually reads as a smooth perspective ↔
 * orthographic crossfade.
 */
export interface ProjectionAnimation {
  /** Camera whose projectionMatrix we mutate during the tween. */
  driveCam: PerspectiveCamera | OrthographicCamera;
  fromMatrix: Matrix4;
  toMatrix: Matrix4;
  toType: ProjectionType;
  elapsed: number;
  duration: number;
}

/**
 * CameraManager handles perspective/orthographic switching,
 * smooth camera animations, FOV, and viewport offset computation.
 */
export class CameraManager {
  private state: ViewerCameraState;
  cameraAnim: CameraAnimation | null = null;
  projectionAnim: ProjectionAnimation | null = null;
  /** See {@link cameraEpoch}. */
  private _cameraEpoch = 0;

  // ─── Follow / Sit-On state ────────────────────────────────────────
  private _followMode: CameraFollowMode = 'off';
  private _followOwner: CameraFollowOwner | null = null;
  onFollowModeChanged?: (mode: CameraFollowMode) => void;
  private _source: FollowSource | null = null;
  /** Sit-On seat offset in the target's local frame. */
  private _seatLocalOffset = new Vector3();
  /** Accumulated Sit-On mouse-look angles. */
  private _lookYaw = 0;
  private _lookPitch = 0;
  /** Saved orbit state for restore on exit. */
  private _savedCamPos = new Vector3();
  private _savedCamTarget = new Vector3();

  // Pre-allocated temps (NO GC in the per-frame tick):
  private _tmpPos = new Vector3();
  private _tmpPrevTarget = new Vector3();   // delta-follow previous target
  private _tmpDelta = new Vector3();
  private _tmpOffset = new Vector3();        // rotated seat offset
  private _tmpQuat = new Quaternion();
  private _lookQuat = new Quaternion();      // mouse-look quaternion
  private _seatYaw180 = new Quaternion(0, 1, 0, 0);
  private _tmpEuler = new Euler(0, 0, 0, 'YXZ');
  private _tmpBox = new Box3();

  constructor(state: ViewerCameraState) {
    this.state = state;
  }

  /**
   * plan-515 Phase 2: counts the camera take-overs of this manager — a camera
   * flight (`animateCameraTo`: fitToNodes / F / focus / bookmarks), a
   * projection switch or tween, Follow / Sit-On start and stop. The
   * NavigationController compares it before it acts: a change resets its orbit
   * pivot to `controls.target` and stops its inertia. (Direct writers of
   * `controls.target` — view-state restore, multiuser, annotations — are
   * detected by the controller from the target itself.)
   */
  get cameraEpoch(): number { return this._cameraEpoch; }

  // ─── FOV ──────────────────────────────────────────────────────────

  get fov(): number { return this.state.perspCamera.fov; }
  set fov(v: number) {
    this.state.perspCamera.fov = v;
    this.state.perspCamera.updateProjectionMatrix();
    if (this.state._activeCamera === this.state.orthoCamera) {
      this.syncOrthoFrustum();
    }
  }

  // ─── Projection ───────────────────────────────────────────────────

  get projection(): ProjectionType {
    return this.state._activeCamera === this.state.perspCamera ? 'perspective' : 'orthographic';
  }

  set projection(v: ProjectionType) {
    const wantPersp = v === 'perspective';
    const isPersp = this.state._activeCamera === this.state.perspCamera;
    if (wantPersp === isPersp) return;

    // plan-515 (R2-2): fold an ortho wheel zoom into camera distance BEFORE
    // the swap, so the perspective camera shows the same extent at the target
    // plane, and enter ortho at zoom 1 (a stale zoom scaled the frustum).
    if (wantPersp) this._normalizeOrthoPose();
    else this.state.orthoCamera.zoom = 1;

    this._cameraEpoch++;
    const oldCam = this.state._activeCamera;
    const newCam = wantPersp ? this.state.perspCamera : this.state.orthoCamera;

    newCam.position.copy(oldCam.position);
    newCam.quaternion.copy(oldCam.quaternion);

    if (!wantPersp) {
      this.syncOrthoFrustum();
    }

    this.state._activeCamera = newCam;
    (this.state.controls as unknown as { object: unknown }).object = newCam;
    this.state.controls.update();
  }

  syncOrthoFrustum(): void {
    const dist = this.state.orthoCamera.position.distanceTo(this.state.controls.target);
    const halfH = dist * Math.tan((this.state.perspCamera.fov * Math.PI / 180) / 2);
    const aspect = this.state.perspCamera.aspect;
    this.state.orthoCamera.left = -halfH * aspect;
    this.state.orthoCamera.right = halfH * aspect;
    this.state.orthoCamera.top = halfH;
    this.state.orthoCamera.bottom = -halfH;
    this.state.orthoCamera.updateProjectionMatrix();
  }

  /**
   * Re-express the current VISIBLE ortho framing as a pure camera distance:
   * fold the OrbitControls wheel zoom (`camera.zoom`) into the position along
   * the view direction, reset zoom to 1 and re-sync the frustum. The rendered
   * image is unchanged. Needed before programmatic camera moves — their
   * framing math (fitDistance et al.) assumes the view scale follows distance,
   * which is only true at zoom 1.
   */
  private _normalizeOrthoPose(): void {
    const cam = this.state.orthoCamera;
    if (this.state._activeCamera !== cam) return;
    const target = this.state.controls.target;
    const halfHVisible = (cam.top - cam.bottom) / 2 / cam.zoom;
    const dist = halfHVisible / Math.tan((this.state.perspCamera.fov * Math.PI / 180) / 2);
    this._tmpPos.subVectors(cam.position, target);
    if (this._tmpPos.lengthSq() < 1e-12) return; // degenerate: camera on target
    this._tmpPos.normalize();
    cam.position.copy(target).addScaledVector(this._tmpPos, dist);
    cam.zoom = 1;
    this.syncOrthoFrustum();
  }

  /**
   * Distance the perspective camera needs to fit `maxDim` vertically in view,
   * scaled by `margin` (the canonical `maxDim / (2·tan(fov/2)) · margin` fit
   * formula — every camera-framing path delegates here so the math cannot
   * drift between copies).
   */
  fitDistance(maxDim: number, margin = 1): number {
    const fov = this.state.perspCamera.fov * (Math.PI / 180);
    return (maxDim / (2 * Math.tan(fov / 2))) * margin;
  }

  /**
   * Like {@link fitDistance}, but fits BOTH axes: the larger of the vertical
   * and horizontal (aspect-corrected) fit distances, scaled by `margin`.
   */
  fitDistanceBothAxes(maxDim: number, margin = 1): number {
    return fitDistanceBothAxesFor(
      maxDim, this.state.perspCamera.fov, this.state.perspCamera.aspect, margin,
    );
  }

  // ─── Camera Animation ─────────────────────────────────────────────

  /** Whether a camera animation is currently in progress. */
  get isCameraAnimating(): boolean { return this.cameraAnim !== null; }

  /**
   * Cancel the in-progress camera animation. Without `tag` any animation is
   * cancelled (the historical behaviour); with `tag` only an animation started
   * with that same tag (plan-520: the controls `'start'` gesture cancels the
   * `'follow-agent'` flight and leaves bookmarks / focus flights alone).
   */
  cancelCameraAnimation(tag?: string): void {
    if (tag !== undefined && this.cameraAnim?.tag !== tag) return;
    this.cameraAnim = null;
  }

  /**
   * Smoothly animate the camera to a new position and orbit target.
   * `tag` names the flight's owner so {@link cancelCameraAnimation} can target it.
   */
  animateCameraTo(position: Vector3, target: Vector3, duration = 0.6, easing: CameraEasing = 'easeOut', tag?: string, updateEndpoint?: (position: Vector3, target: Vector3) => void): void {
    const xr = (this.state.renderer as unknown as Record<string, unknown>).xr as Record<string, unknown> | undefined;
    if (xr?.isPresenting) return;
    this._cameraEpoch++;
    // Release any follow before flying. stopFollowMode clears the mode before
    // its restore flight re-enters here, so this guard prevents recursion.
    if (this._followMode !== 'off') {
      this.stopFollowMode(false);
    }
    // In ortho the visible scale must follow camera distance (the frustum is
    // re-synced every animation tick) — fold any wheel zoom into distance
    // first so the flight starts from the exact same visible framing.
    this._normalizeOrthoPose();
    this.cameraAnim = {
      startPos: this.state._activeCamera.position.clone(),
      endPos: position.clone(),
      startTgt: this.state.controls.target.clone(),
      endTgt: target.clone(),
      elapsed: 0,
      duration,
      easing,
      tag,
      updateEndpoint,
    };
  }

  /** Advance camera animation by frame delta. */
  tickCameraAnimation(dtSec: number): void {
    if (!this.cameraAnim) return;
    this.cameraAnim.updateEndpoint?.(this.cameraAnim.endPos, this.cameraAnim.endTgt);
    this.cameraAnim.elapsed += dtSec;
    // duration 0 = jump (plan-520 reduced motion) — never 0/0 = NaN on a zero-dt frame.
    const t = this.cameraAnim.duration > 0 ? Math.min(this.cameraAnim.elapsed / this.cameraAnim.duration, 1) : 1;
    // easeOut (cubic): instant response, smooth stop — right for user clicks.
    // easeInOut (cubic): smooth start AND stop — right for scripted flights.
    const e = this.cameraAnim.easing === 'easeInOut'
      ? (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)
      : 1 - Math.pow(1 - t, 3);

    this.state._activeCamera.position.lerpVectors(this.cameraAnim.startPos, this.cameraAnim.endPos, e);
    this.state.controls.target.lerpVectors(this.cameraAnim.startTgt, this.cameraAnim.endTgt, e);

    // Ortho zoom follows camera distance: without this the flight moves the
    // camera but the view scale never changes (frustum was only re-synced on
    // projection switch / canvas resize).
    if (this.state._activeCamera === this.state.orthoCamera) this.syncOrthoFrustum();

    if (t >= 1) this.cameraAnim = null;
  }

  // ─── Follow / Sit-On ──────────────────────────────────────────────

  /** Current follow/sit-on tracking mode. */
  get followMode(): CameraFollowMode { return this._followMode; }
  get followOwner(): CameraFollowOwner | null { return this._followOwner; }
  get followSource(): FollowSource | null { return this._source; }

  /**
   * Start orbit-follow: the camera keeps its relative offset to the target as
   * the target moves. OrbitControls stays ENABLED so the user can keep
   * orbiting/zooming around the moving target (delta-pattern in tickFollow).
   */
  startFollow(src: FollowSource, owner: CameraFollowOwner = 'selection'): void {
    this.stopFollowMode(false);
    this._cameraEpoch++;
    this.cancelCameraAnimation();
    this._source = src;
    this._followMode = 'follow';
    this._followOwner = owner;
    this._savedCamPos.copy(this.state._activeCamera.position);
    this._savedCamTarget.copy(this.state.controls.target);
    this.onFollowModeChanged?.(this._followMode);
    // OrbitControls stays active — target is carried along each tick.
  }

  /**
   * Start sit-on: the camera rides on the target (position + orientation
   * follow it) and the user can look around with the mouse. Only meaningful in
   * perspective — if currently orthographic, switch to perspective first.
   */
  startSitOn(src: FollowSource, seatLocalOffset?: Vector3, owner: CameraFollowOwner = 'selection'): void {
    this.stopFollowMode(false);
    if (this.projection === 'orthographic') this.projection = 'perspective';
    this._cameraEpoch++;
    this.cancelCameraAnimation();
    this._source = src;
    this._followMode = 'siton';
    this._followOwner = owner;
    this._savedCamPos.copy(this.state._activeCamera.position);
    this._savedCamTarget.copy(this.state.controls.target);
    this.state.controls.enabled = false;       // same as FPV — we own the camera
    this._lookYaw = 0;
    this._lookPitch = 0;
    src.getBounds(this._tmpBox);
    if (seatLocalOffset) {
      this._seatLocalOffset.copy(seatLocalOffset);
    } else {
      src.getWorldPosition(this._tmpPos); // node origin (world) → top-relative seat
      this._defaultSeatOffset(this._tmpBox, this._tmpPos, this._seatLocalOffset);
    }
    if (src.seatHeight !== undefined) this._seatLocalOffset.y = src.seatHeight;
    this.onFollowModeChanged?.(this._followMode);
  }

  /**
   * Leave follow/sit-on. Re-enables OrbitControls; when `restore` is true,
   * smoothly animates back to the view captured on entry.
   */
  stopFollowMode(restore = true): void {
    if (this._followMode === 'off') return;
    const stopped = this._source;
    this._cameraEpoch++;
    this._followMode = 'off';
    this._followOwner = null;
    this._source = null;
    this.state.controls.enabled = true;
    // Tell the source it is no longer being followed (plan-740). Follow can now
    // end from inside this class — `animateCameraTo` releases any active
    // follow before flying — and no OrbitControls event announces that, so an
    // owner watching only `'start'` would keep a stale "attached" flag and a
    // hidden gizmo. Fired with the mode already off, so a handler calling
    // `stopFollowMode` again is a no-op, and a throwing handler must not stop
    // the restore.
    try { stopped?.onFollowStopped?.(); } catch { /* a faulty owner is not our problem */ }
    if (restore) this.animateCameraTo(this._savedCamPos, this._savedCamTarget, 0.4);
    this.onFollowModeChanged?.(this._followMode);
  }

  /** Apply a Sit-On mouse-look delta (pixels). No-op outside Sit-On. */
  applyLookDelta(dx: number, dy: number, sensitivity = LOOK_SENSITIVITY): void {
    if (this._followMode !== 'siton') return;
    this._lookYaw -= dx * sensitivity;
    this._lookPitch -= dy * sensitivity;
    this._lookPitch = Math.max(-MAX_LOOK_PITCH, Math.min(MAX_LOOK_PITCH, this._lookPitch));
    this.state._renderDirty = true;
  }

  /**
   * Per-frame follow tick. MUST be called from the render loop BEFORE
   * `controls.update()` so OrbitControls applies the user orbit on top of the
   * carried target (Follow) and so the camera pose isn't overwritten.
   */
  tickFollow(dtSec: number): void {
    if (this._followMode === 'off' || !this._source) return;
    // Target vanished (MU consumed, node removed) → end the mode cleanly.
    if (!this._source.isAlive()) { this.stopFollowMode(false); return; }

    const cam = this.state._activeCamera;
    const alpha = 1 - Math.exp(-FOLLOW_DAMPING * dtSec);   // frame-rate-independent

    if (this._followMode === 'follow') {
      // DELTA-offset pattern (preserves user orbit): move controls.target toward
      // the part, then shift the camera by the SAME delta — never set the camera
      // position absolutely. controls.update() (in render()) then re-applies the
      // user's orbit around the carried target.
      this._tmpPrevTarget.copy(this.state.controls.target);
      this._source.getWorldPosition(this._tmpPos);
      this.state.controls.target.lerp(this._tmpPos, alpha);
      this._tmpDelta.copy(this.state.controls.target).sub(this._tmpPrevTarget);
      cam.position.add(this._tmpDelta);
    } else { // 'siton'
      this._source.getWorldPosition(this._tmpPos);
      this._source.getWorldQuaternion(this._tmpQuat);
      // Camera position = part position + seat offset (rotated into part frame).
      this._tmpOffset.copy(this._seatLocalOffset).applyQuaternion(this._tmpQuat);
      cam.position.copy(this._tmpPos).add(this._tmpOffset);
      // Apply the forward-axis correction only to the view, not the seat offset.
      this._tmpEuler.set(this._lookPitch, this._lookYaw, 0, 'YXZ');
      this._lookQuat.setFromEuler(this._tmpEuler);
      cam.quaternion.copy(this._tmpQuat);
      if (this._source.seatForward === 'posZ') cam.quaternion.multiply(this._seatYaw180);
      cam.quaternion.multiply(this._lookQuat);
    }
    this.state._renderDirty = true;   // keep rendering while the mode is active
  }

  /**
   * Default Sit-On seat offset: place the camera clearly ABOVE the top of the
   * target's world bounding box, measured from the node ORIGIN (so it is correct
   * regardless of whether the origin sits at the part's base or center). The
   * margin above the top scales with the part height. Falls back for an
   * empty/degenerate box.
   */
  private _defaultSeatOffset(box: Box3, originWorld: Vector3, out: Vector3): void {
    if (box.isEmpty() || !isFinite(box.min.y) || !isFinite(box.max.y)) {
      out.set(0, 1.5, 0);
      return;
    }
    const sizeY = box.max.y - box.min.y;
    // Top of the bbox relative to the node origin, plus an eye-height margin
    // above the top so you sit clearly above the part and can look around.
    const aboveTop = Math.max(sizeY * 0.6, 0.4);
    out.set(0, (box.max.y - originWorld.y) + aboveTop, 0);
  }

  // ─── Projection Animation ─────────────────────────────────────────

  /** Whether a projection-swap animation is currently in progress. */
  get isProjectionAnimating(): boolean { return this.projectionAnim !== null; }

  /**
   * Smoothly transition between perspective and orthographic. Element-wise
   * lerp between the two cameras' projection matrices over `duration`
   * seconds, then commit the actual camera swap. Visually this looks like
   * the perspective foreshortening fades out (or in) gradually.
   *
   * No-op if already in the requested mode. Restarts cleanly if called
   * again mid-animation.
   */
  animateProjectionTo(v: ProjectionType, duration = 0.4): void {
    const wantPersp = v === 'perspective';
    const isPersp = this.projection === 'perspective';
    if (wantPersp === isPersp && !this.projectionAnim) return;
    this._cameraEpoch++;

    // The driver camera is the one we keep rendering with for the duration of
    // the tween — its projectionMatrix gets overwritten each frame. We always
    // drive with the CURRENT active camera so the renderer doesn't see a
    // mid-frame swap; the actual swap happens at t=1.
    const driveCam = this.state._activeCamera;
    const targetCam = wantPersp ? this.state.perspCamera : this.state.orthoCamera;

    // plan-515 (R2-2): same ortho normalisation as the instant switch.
    if (wantPersp) this._normalizeOrthoPose();
    else this.state.orthoCamera.zoom = 1;

    // Bring the target into sync so its projection matrix is the visual
    // endpoint we're lerping toward.
    targetCam.position.copy(driveCam.position);
    targetCam.quaternion.copy(driveCam.quaternion);
    if (!wantPersp) this.syncOrthoFrustum();
    targetCam.updateProjectionMatrix();

    this.projectionAnim = {
      driveCam,
      fromMatrix: driveCam.projectionMatrix.clone(),
      toMatrix: targetCam.projectionMatrix.clone(),
      toType: v,
      elapsed: 0,
      duration,
    };
  }

  /**
   * plan-515 (R2-1): set near/far on BOTH cameras. A camera's projection
   * matrix is only rebuilt when its near or far moved by more than 1 %. While a
   * projection animation runs, the lerp reads STORED matrix copies
   * (`fromMatrix` / `toMatrix`), so a changed clipping must refresh those
   * endpoints too — otherwise the next tick overwrites the new clipping with the
   * old one. Returns true when anything changed.
   */
  applyClipping(persp: { near: number; far: number }, ortho: { near: number; far: number }): boolean {
    // Records, not four number arguments: a double crossing a non-inlined call
    // is boxed into a fresh HeapNumber (plan-515 R3-5, zero-allocation tick).
    // 1 % hysteresis, written out (no helper call) for the same reason.
    const p = this.state.perspCamera;
    const o = this.state.orthoCamera;
    let changed = false;
    if (Math.abs(persp.near - p.near) > 0.01 * Math.abs(p.near) || Math.abs(persp.far - p.far) > 0.01 * Math.abs(p.far)) {
      p.near = persp.near; p.far = persp.far;
      p.updateProjectionMatrix();
      changed = true;
    }
    if (Math.abs(ortho.near - o.near) > 0.01 * Math.abs(o.near) || Math.abs(ortho.far - o.far) > 0.01 * Math.abs(o.far)) {
      o.near = ortho.near; o.far = ortho.far;
      o.updateProjectionMatrix();
      changed = true;
    }
    if (changed && this.projectionAnim) this.refreshProjectionAnimation();
    return changed;
  }

  /**
   * plan-515 (R2-1): rebuild the stored endpoint matrices of a running
   * projection animation from the cameras' CURRENT state (pose, clipping, ortho
   * extent). Call after anything changed the camera during the tween — the
   * clipping, or a navigation move. The drive camera's live (lerped) matrix is
   * rewritten by the next `tickProjectionAnimation`.
   */
  refreshProjectionAnimation(): void {
    const anim = this.projectionAnim;
    if (!anim) return;
    const driveCam = anim.driveCam;
    const toPersp = anim.toType === 'perspective';
    const targetCam = toPersp ? this.state.perspCamera : this.state.orthoCamera;
    if (targetCam === driveCam) return;
    if (toPersp) this._normalizeOrthoPose();
    targetCam.position.copy(driveCam.position);
    targetCam.quaternion.copy(driveCam.quaternion);
    targetCam.updateMatrixWorld();
    if (!toPersp) {
      this.state.orthoCamera.zoom = 1;
      this.syncOrthoFrustum();
    }
    driveCam.updateProjectionMatrix();
    targetCam.updateProjectionMatrix();
    anim.fromMatrix.copy(driveCam.projectionMatrix);
    anim.toMatrix.copy(targetCam.projectionMatrix);
  }

  /** Cancel any in-progress projection animation; leaves whichever camera
   *  is currently active in place (matrix is restored by the next render
   *  pass via updateProjectionMatrix when needed). */
  cancelProjectionAnimation(): void {
    if (!this.projectionAnim) return;
    // Restore the drive camera's matrix so it isn't left mid-lerp.
    this.projectionAnim.driveCam.updateProjectionMatrix();
    this.projectionAnim = null;
  }

  /**
   * plan-515 (R3-3): jump a running projection animation to its END state and
   * commit the camera swap now. Navigation input calls this before it acts —
   * during the tween the live matrix is a blend of both projections, so a pick
   * would land up to ~36 px beside the cursor. No-op when nothing animates.
   */
  completeProjectionAnimation(): void {
    const anim = this.projectionAnim;
    if (!anim) return;
    anim.elapsed = Math.max(anim.duration, 1e-9);
    if (!(anim.duration > 0)) anim.duration = 1e-9;
    this.tickProjectionAnimation(0);
  }

  /** Advance projection animation by frame delta. */
  tickProjectionAnimation(dtSec: number): void {
    const anim = this.projectionAnim;
    if (!anim) return;
    anim.elapsed += dtSec;
    const t = Math.min(anim.elapsed / anim.duration, 1);
    const e = 1 - Math.pow(1 - t, 3); // ease-out cubic

    // Element-wise lerp into the drive camera's projection matrix.
    const out = anim.driveCam.projectionMatrix.elements;
    const a = anim.fromMatrix.elements;
    const b = anim.toMatrix.elements;
    for (let i = 0; i < 16; i++) {
      out[i] = a[i] + (b[i] - a[i]) * e;
    }
    anim.driveCam.projectionMatrixInverse.copy(anim.driveCam.projectionMatrix).invert();

    if (t >= 1) {
      // Commit the actual camera swap (rebinds OrbitControls, restores the
      // target camera's clean projection matrix).
      this.projectionAnim = null;
      // The drive camera leaves the view now — give it back its own clean
      // matrix, so a later switch back does not render with the lerp endpoint.
      anim.driveCam.updateProjectionMatrix();
      this.projection = anim.toType;
    }
  }

  // ─── Viewport Offset ──────────────────────────────────────────────

  /**
   * Panel offset for camera framing. The WebGL canvas is now confined to the
   * central viewport region (see ViewportFrame) — docked windows and the
   * activity bar no longer overlap it — so focus/fit should center within the
   * real visible canvas with NO extra compensation. Returns undefined (which
   * makes `_panelFitScale` a no-op, scale 1). Kept as a method so callers and
   * the public viewer API stay intact.
   */
  getCurrentViewportOffset(): ViewportOffset | undefined {
    return undefined;
  }

  // ─── Focus & Fit ──────────────────────────────────────────────────

  /** Compute bounding box for a set of nodes.
   *
   *  BatchedMesh arenas are skipped: their geometry bbox is the raw source
   *  buffer and ignores the per-instance matrices that place the copies, so on
   *  a CAD import scaled 0.001 it reads ~1000x too large and the fit camera
   *  ends up far outside the part. The source meshes stay in the graph and
   *  carry the true bounds. Same rule as RVViewer._computeContentBounds().
   *
   *  The geometry bbox is read from the cache and computed only when missing
   *  (as `computeContentBoundsInto` does): SceneScale calls this every 500 ms
   *  for all drive subtrees while the simulation runs, and an unconditional
   *  `computeBoundingBox()` is a full vertex scan of every moving mesh. */
  computeNodeBounds(nodes: Object3D[]): Box3 {
    const box = new Box3();
    const mb = _tmpNodeBox;
    for (const node of nodes) {
      node.updateWorldMatrix(true, true);
      let hasMesh = false;
      node.traverse((child) => {
        const m = child as Mesh;
        if ((m as unknown as { isBatchedMesh?: boolean }).isBatchedMesh) return;
        if (m.isMesh && m.geometry) {
          if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
          if (m.geometry.boundingBox) {
            mb.copy(m.geometry.boundingBox).applyMatrix4(m.matrixWorld);
            box.union(mb);
            hasMesh = true;
          }
        }
      });
      // A node of a BAKED model keeps no meshes of its own — its geometry lives
      // in an ancestor's chunk (plan-754). Its segment boxes are the bounds
      // then (plan-756 F6), exactly as `computeSubtreeAABB` resolves them;
      // without this an alarm card's "focus" on a station framed nothing.
      // `chunkBoundsOfNode` UNIONS into its target — start from an empty box,
      // the scratch still holds the last mesh box (or a previous call's).
      mb.makeEmpty();
      if (!hasMesh && chunkBoundsOfNode(node, mb)) box.union(mb);
    }
    return box;
  }
}
const _tmpNodeBox = new Box3();
