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

/** Follow/Sit-On tracking mode. */
export type CameraFollowMode = 'off' | 'follow' | 'siton';

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

  // ─── Follow / Sit-On state ────────────────────────────────────────
  private _followMode: CameraFollowMode = 'off';
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
  private _tmpEuler = new Euler(0, 0, 0, 'YXZ');
  private _tmpBox = new Box3();

  constructor(state: ViewerCameraState) {
    this.state = state;
  }

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
    const fov = this.state.perspCamera.fov * (Math.PI / 180);
    const halfTan = Math.tan(fov / 2);
    const aspect = this.state.perspCamera.aspect;
    const distV = maxDim / (2 * halfTan);
    const distH = maxDim / (2 * halfTan * aspect);
    return Math.max(distV, distH) * margin;
  }

  // ─── Camera Animation ─────────────────────────────────────────────

  /** Whether a camera animation is currently in progress. */
  get isCameraAnimating(): boolean { return this.cameraAnim !== null; }

  /** Cancel any in-progress camera animation. */
  cancelCameraAnimation(): void {
    this.cameraAnim = null;
  }

  /**
   * Smoothly animate the camera to a new position and orbit target.
   */
  animateCameraTo(position: Vector3, target: Vector3, duration = 0.6, easing: CameraEasing = 'easeOut'): void {
    const xr = (this.state.renderer as unknown as Record<string, unknown>).xr as Record<string, unknown> | undefined;
    if (xr?.isPresenting) return;
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
    };
  }

  /** Advance camera animation by frame delta. */
  tickCameraAnimation(dtSec: number): void {
    if (!this.cameraAnim) return;
    this.cameraAnim.elapsed += dtSec;
    const t = Math.min(this.cameraAnim.elapsed / this.cameraAnim.duration, 1);
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

  /**
   * Start orbit-follow: the camera keeps its relative offset to the target as
   * the target moves. OrbitControls stays ENABLED so the user can keep
   * orbiting/zooming around the moving target (delta-pattern in tickFollow).
   */
  startFollow(src: FollowSource): void {
    this.cancelCameraAnimation();
    this._source = src;
    this._followMode = 'follow';
    this._savedCamPos.copy(this.state._activeCamera.position);
    this._savedCamTarget.copy(this.state.controls.target);
    // OrbitControls stays active — target is carried along each tick.
  }

  /**
   * Start sit-on: the camera rides on the target (position + orientation
   * follow it) and the user can look around with the mouse. Only meaningful in
   * perspective — if currently orthographic, switch to perspective first.
   */
  startSitOn(src: FollowSource, seatLocalOffset?: Vector3): void {
    if (this.projection === 'orthographic') this.projection = 'perspective';
    this.cancelCameraAnimation();
    this._source = src;
    this._followMode = 'siton';
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
  }

  /**
   * Leave follow/sit-on. Re-enables OrbitControls; when `restore` is true,
   * smoothly animates back to the view captured on entry.
   */
  stopFollowMode(restore = true): void {
    if (this._followMode === 'off') return;
    this._followMode = 'off';
    this._source = null;
    this.state.controls.enabled = true;
    if (restore) this.animateCameraTo(this._savedCamPos, this._savedCamTarget, 0.4);
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
      // Camera orientation = part orientation × mouse-look (Euler YXZ), GC-free.
      this._tmpEuler.set(this._lookPitch, this._lookYaw, 0, 'YXZ');
      this._lookQuat.setFromEuler(this._tmpEuler);
      cam.quaternion.copy(this._tmpQuat).multiply(this._lookQuat);
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

    // The driver camera is the one we keep rendering with for the duration of
    // the tween — its projectionMatrix gets overwritten each frame. We always
    // drive with the CURRENT active camera so the renderer doesn't see a
    // mid-frame swap; the actual swap happens at t=1.
    const driveCam = this.state._activeCamera;
    const targetCam = wantPersp ? this.state.perspCamera : this.state.orthoCamera;

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

  /** Cancel any in-progress projection animation; leaves whichever camera
   *  is currently active in place (matrix is restored by the next render
   *  pass via updateProjectionMatrix when needed). */
  cancelProjectionAnimation(): void {
    if (!this.projectionAnim) return;
    // Restore the drive camera's matrix so it isn't left mid-lerp.
    this.projectionAnim.driveCam.updateProjectionMatrix();
    this.projectionAnim = null;
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
   *  carry the true bounds. Same rule as RVViewer._computeContentBounds(). */
  computeNodeBounds(nodes: Object3D[]): Box3 {
    const box = new Box3();
    for (const node of nodes) {
      node.updateWorldMatrix(true, true);
      node.traverse((child) => {
        const m = child as Mesh;
        if ((m as unknown as { isBatchedMesh?: boolean }).isBatchedMesh) return;
        if (m.isMesh && m.geometry) {
          m.geometry.computeBoundingBox();
          if (m.geometry.boundingBox) {
            const mb = m.geometry.boundingBox.clone();
            mb.applyMatrix4(m.matrixWorld);
            box.union(mb);
          }
        }
      });
    }
    return box;
  }
}
