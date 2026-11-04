// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * NavigationController — scale-adaptive navigation (plan-515 Phase 1a/1b/2).
 *
 * The controller is the ONLY mouse / wheel / touch path of the viewer.
 * OrbitControls stays the STATE HOLDER (`controls.target`, `update()` with its
 * `lookAt(target)`, the `'change'` event, `enabled` as the take-over switch of
 * FPV / XR / Sit-On / shared view / gizmo drags), but its DOM input is
 * disconnected while a controller is attached, so no pointer, wheel or touch
 * event reaches it; `dispose()` reconnects it.
 *
 *  - Wheel / trackpad pinch (ctrl+wheel): notches are ACCUMULATED in the
 *    handler; {@link tick} (once per frame, from the render loop, before the
 *    projection animation and `controls.update()`) spends at most ONE
 *    `raycastSurface` per frame. The camera moves along the ANCHOR RAY toward
 *    the surface, never through it, never closer than {@link MIN_DOLLY_DIST};
 *    zooming out is CLAMPED at {@link MAX_OUT_RADII} scene radii. Ortho: zoom
 *    at the anchor. The anchor of a mouse wheel is the point under the
 *    CURSOR by default (the pre-515 `zoomToCursor` feel); with
 *    {@link wheelZoomToCursor} = false it is the canvas centre. A trackpad
 *    pinch always anchors under the fingers. The listener sits on an ancestor of the canvas (or the
 *    canvas) in the CAPTURE phase and only takes events whose target IS the
 *    canvas — HMI panels inside the same container keep scrolling.
 *  - Trackpad two-finger drag (no ctrl, small pixel deltas): orbits about
 *    `controls.target` (the historical heuristic).
 *  - Right-drag: ORBIT about the pivot. By default (the pre-515 OrbitControls
 *    feel, plan-515 decision 2026-09-29) the pivot is the FIXED
 *    `controls.target` — no pick at mouse-down. With
 *    {@link navigateAroundCursorPoint} a mouse-down over a surface sets the
 *    pivot to the surface point under the cursor instead; over empty
 *    background it stays the SAME world point as before. Yaw about world Y,
 *    pitch about the camera's right axis (clamped away from the poles),
 *    position and orientation rotated together ({@link orbitAboutPivotIO}) —
 *    the view never jumps at the start.
 *  - Middle-drag: PAN that keeps the grabbed point under the cursor. By
 *    default the grabbed point is the cursor on the plane through
 *    `controls.target` ⟂ the view axis (no pick — the OrbitControls feel, pan
 *    proportional to the target distance); with
 *    {@link navigateAroundCursorPoint} it is the surface point under the
 *    cursor (else that plane). During the drag only ray-plane arithmetic
 *    ({@link panKeepPointIO}), no pick. Shift / ctrl / meta swap the two
 *    buttons, as in OrbitControls.
 *  - Touch: one finger orbits (about `controls.target`, or about the touch
 *    point with {@link navigateAroundCursorPoint}), two fingers pinch toward
 *    the surface under the pinch midpoint (the wheel's dolly / ortho
 *    functions, factor = finger-distance ratio — the scale fix, kept in both
 *    modes) and pan so that point stays under the midpoint.
 *  - Own inertia after a drag release (`controls.enableDamping`; per frame
 *    `velocity *= 1 − dampingFactor`, as OrbitControls); `rotateSpeed`,
 *    `panSpeed` and `zoomSpeed` of the controls apply. `pointercancel` /
 *    `lostpointercapture` end a gesture WITHOUT residual motion; any new
 *    navigation input stops the inertia.
 *  - The pivot resets to `controls.target` (and the inertia stops) whenever
 *    someone else moved the camera: a change of `CameraManager.cameraEpoch`
 *    (camera flights — fitToNodes / F / focus / bookmarks —, projection
 *    switches, Follow / Sit-On) or of `controls.target` itself since the
 *    controller's last action (view-state restore, multiuser take-over,
 *    annotations, …). A running camera flight stops the inertia and cancels a
 *    drag; a drag or wheel input cancels a running flight.
 *  - Guards: `controls.enabled === false` (FPV, XR, Sit-On, shared view, gizmo
 *    drags) → no gesture, a running one is cancelled.
 *  - Orbit-follow (CameraManager 'follow'): the gesture's `'start'` goes out
 *    first, so a follow that yields to the human (the agent eye, plan-740) can
 *    let go — then the gesture is an ordinary one. A follow that stays keeps
 *    the pre-515 OrbitControls behaviour: orbit (right-drag, one finger, and
 *    its inertia) turns about the CARRIED follow target (`controls.target`),
 *    no surface pick; the follow shifts camera and target by the same delta
 *    each frame, so the new relative offset is kept (no snap back). A pinch
 *    dollies toward the carried target without panning. A pan (middle-drag)
 *    is an inert gesture — `'start'` at mouse-down, `'end'` at mouse-up, no
 *    motion — because the follow pulled every pan back to the part before.
 *  - Camera invariant: after every controller action `controls.target` lies on
 *    the VIEW AXIS, so the next `controls.update()` (`lookAt(target)`) cannot
 *    swing the view. Before acting it DISCARDS pending OrbitControls damping
 *    (R2-3) — public API only.
 *  - Any navigation input (wheel, pointer-down on the canvas) first COMPLETES a
 *    running projection tween (R3-3).
 *  - Every frame it sets dynamic near/far on both cameras through
 *    `CameraManager.applyClipping` (R2-1).
 *  - `'start'` / `'end'` are dispatched on the controls once per GESTURE (a
 *    wheel gesture ends after {@link GESTURE_IDLE_MS} without a wheel event; a
 *    drag at pointer-up / cancel, before its inertia). `'change'` comes from
 *    the same frame's `controls.update()`, which sees the moved pose.
 *
 * No allocation in the tick or the math it calls (plan-515 R3-5, measured):
 * all scratch is pre-allocated here, and computed doubles travel through
 * fields / records instead of call arguments — V8 boxes a double into a fresh
 * HeapNumber when it crosses a non-inlined call. The surface pick itself
 * allocates (plan-515 R2-7); it runs once per wheel frame and once per gesture
 * start (orbit / pan only with {@link navigateAroundCursorPoint}; a pinch
 * always), never during a drag.
 */

import { Quaternion, Spherical, Vector3 } from 'three';
import type { OrthographicCamera, PerspectiveCamera } from 'three';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { SurfaceHit } from './rv-raycast-manager';
import {
  createNavScalarIO, cursorRayIO, dollyStepIO, maxBackoffInsideIO, nearFarForIO, orbitAboutPivotIO,
  orthoNearFarForIO, panKeepPointIO, zoomOrthoAtCursorIO, MIN_ORBIT_POLAR, MAX_FAR_NEAR_RATIO,
  type NavSceneScale, type NearFar,
} from './rv-navigation-math';

/** Minimal surface picker (RaycastManager satisfies it). */
export interface SurfacePicker {
  raycastSurface(clientX: number, clientY: number, out: SurfaceHit): boolean;
}

/** The camera-manager surface the controller needs (CameraManager satisfies it). */
export interface NavigationCameraHost {
  applyClipping(persp: NearFar, ortho: NearFar): boolean;
  refreshProjectionAnimation(): void;
  completeProjectionAnimation(): void;
  readonly isProjectionAnimating: boolean;
  readonly isCameraAnimating: boolean;
  cancelCameraAnimation(): void;
  /** Counts camera take-overs (flights, projection switches, Follow / Sit-On) — see CameraManager. */
  readonly cameraEpoch: number;
  /** Follow / Sit-On mode ('follow' = orbit about the carried target, 'siton' = no gesture). */
  readonly followMode: 'off' | 'follow' | 'siton';
}

/** Scene scale as the controller reads it (a SceneScaleSnapshot satisfies it). */
export interface NavSceneScaleSnapshot extends NavSceneScale {
  readonly empty: boolean;
}

export interface NavigationControllerOptions {
  canvas: HTMLCanvasElement;
  /** Ancestor of the canvas (or the canvas) that gets the capture-phase wheel / pointer-down listeners. */
  captureTarget: HTMLElement;
  getCamera: () => PerspectiveCamera | OrthographicCamera;
  controls: OrbitControls;
  getPicker: () => SurfacePicker | null;
  camera: NavigationCameraHost;
  /** Current scene scale; null / empty = leave clipping and caps alone. */
  getSceneScale: () => NavSceneScaleSnapshot | null;
  markDirty: () => void;
  /** Called for every wheel event on the canvas — real user input (plan-520 idle clock). */
  onUserInput?: () => void;
  /**
   * Smallest perspective far plane needed for content outside the scene sphere
   * (the floor disc). 0 = none. Near is raised to keep far/near <= 1e7.
   */
  getMinFar?: (cam: Vector3) => number;
}

/** Smallest camera-to-surface distance of a wheel / pinch dolly (plan F3: 0.5 mm). */
export const MIN_DOLLY_DIST = 0.0005;
/** Base fraction of the distance per notch (plan F3, scaled by `controls.zoomSpeed`). */
export const BASE_STEP = 0.2;
/** Zoom-out cap: camera distance to the scene centre, in scene radii. */
export const MAX_OUT_RADII = 20;
/** Ortho zoom-out cap: visible height, in scene radii. */
export const MAX_ORTHO_HEIGHT_RADII = 40;
/** Ortho zoom-in cap: smallest visible height in metres (1 mm). */
export const MIN_ORTHO_HEIGHT = 0.001;
/** A wheel gesture ends after this long without a wheel event ('end' dispatch). */
export const GESTURE_IDLE_MS = 150;
/** Trackpad two-finger-drag orbit: radians per pixel of wheel delta (historical value). */
export const TRACKPAD_ORBIT_RAD_PER_PX = 0.003;
/** Inertia stops after this many frames at the latest (the viewer's damping render budget). */
export const MAX_INERTIA_FRAMES = 300;
/** Most notches one ctrl+wheel event may carry (a real ctrl+mouse-wheel is not a pinch). */
const MAX_PINCH_NOTCHES_PER_EVENT = 3;

// Drag gesture kinds.
const G_NONE = 0;
const G_ORBIT = 1;
const G_PAN = 2;
const G_TOUCH = 3;
/** Pan during orbit-follow: a gesture that holds 'start' … 'end' but moves nothing. */
const G_HOLD = 4;
// Inertia kinds.
const I_NONE = 0;
const I_ORBIT = 1;
const I_PAN = 2;

const TWO_PI = Math.PI * 2;
const _startEvent = { type: 'start' as const };
const _endEvent = { type: 'end' as const };

/** True for the wheel events the trackpad-orbit heuristic claims (no ctrl, pixel mode, small / diagonal deltas). */
export function isTrackpadOrbitWheel(e: Pick<WheelEvent, 'ctrlKey' | 'deltaMode' | 'deltaX' | 'deltaY'>): boolean {
  if (e.ctrlKey || e.deltaMode !== 0) return false;
  return !(Math.abs(e.deltaY) >= 50 && e.deltaX === 0);
}

export class NavigationController {
  /** Counters for tests / DevTools. */
  readonly stats = {
    wheelEvents: 0, picks: 0, zooms: 0, trackpadOrbits: 0, clippingUpdates: 0, gestures: 0, tweensCompleted: 0,
    drags: 0, orbits: 0, pans: 0, pinches: 0, inertiaFrames: 0, pivotResets: 0, refusedGestures: 0,
  };

  /**
   * Mouse-wheel zoom anchor: true (default) = the point under the cursor,
   * false = the canvas centre. A trackpad pinch (ctrl+wheel) and a touch pinch
   * always anchor under the fingers.
   */
  wheelZoomToCursor = true;

  /**
   * Orbit / pan anchor: false (default) = orbit about the fixed
   * `controls.target` and pan in the plane through it (the pre-515
   * OrbitControls feel); true = orbit about the surface point under the
   * cursor at mouse-down (background keeps the previous pivot), pan grabs the
   * surface point under the cursor, one finger orbits about the touch point.
   */
  navigateAroundCursorPoint = false;

  private readonly opts: NavigationControllerOptions;
  private _pendingNotches = 0;
  private _clientX = 0;
  private _clientY = 0;
  /** Cursor relative to the canvas (event offsetX/Y — no DOMRect per tick). */
  private _offX = 0;
  private _offY = 0;
  /** A wheel gesture is open ('start' sent, 'end' after GESTURE_IDLE_MS). */
  private _wheelGesture = false;
  /** OrbitControls started a gesture since the last flush — damping may be pending. */
  private _needFlush = true;
  /** True while this controller dispatches its own 'start' (not an OrbitControls gesture). */
  private _selfDispatch = false;
  private readonly _onControlsStart: () => void;
  /** Event time (ms, `performance.now()` origin) of the last wheel notch. */
  private _lastWheelMs = 0;
  // Per-zoom values handed to _zoomPerspective / _zoomOrtho through fields
  // (not arguments — see the allocation note above).
  private _ndcX = 0;
  private _ndcY = 0;
  private _notches = 0;
  private _step = 0;
  private _hit = false;
  /** True when `_surf.ray` holds the ray of this frame's pick. */
  private _rayValid = false;
  private readonly _io = createNavScalarIO();
  private readonly _onWheel: (e: WheelEvent) => void;
  private readonly _onPointerDown: (e: PointerEvent) => void;
  private readonly _onPointerMove: (e: Event) => void;
  private readonly _onPointerUp: (e: Event) => void;
  private readonly _onPointerCancel: (e: Event) => void;
  private readonly _onContextMenu: (e: Event) => void;
  /** The element OrbitControls listened on before this controller disconnected it. */
  private readonly _orbitElement: HTMLElement | null;
  /** Where the move / up / cancel listeners of a running drag sit (document or shadow root). */
  private _dragRoot: Node | null = null;

  // ─── Phase 2 drag state ─────────────────────────────────────────
  /** Running drag gesture (G_*). */
  private _drag = G_NONE;
  /** A released drag still to be applied by the next tick (its gesture kind), then inertia. */
  private _tail = G_NONE;
  /** The released drag may coast (pointer-up, not cancel). */
  private _tailInertia = false;
  private _touchCount = 0;
  /** Tracked pointers: A = mouse / first finger, B = second finger (-1 = none). */
  private _ptrA = -1;
  private _ptrAX = 0;
  private _ptrAY = 0;
  private _ptrB = -1;
  private _ptrBX = 0;
  private _ptrBY = 0;
  /** Pixel deltas of pointer A accumulated since the last tick. */
  private _accDX = 0;
  private _accDY = 0;
  /** Canvas client rect origin, taken once per gesture start. */
  private _rectL = 0;
  private _rectT = 0;
  /** Pinch: finger distance at the last tick (px). */
  private _prevDist = 0;
  /** Smoothed per-frame motion of the running drag (becomes the inertia velocity). */
  private _velYaw = 0;
  private _velPitch = 0;
  private readonly _velPan = new Vector3();
  private _inertia = I_NONE;
  private _inertiaFrames = 0;
  /** Orbit pivot — separate from controls.target (plan-515 Entscheidungs-Log). */
  private readonly _pivot = new Vector3();
  /** Pan / pinch: the grabbed point and the plane normal at grab time. */
  private readonly _grab = new Vector3();
  private readonly _grabN = new Vector3();
  /** controls.target and camera epoch as this controller last left / saw them. */
  private readonly _ownTarget = new Vector3();
  private _ownEpoch = 0;

  // Pre-allocated scratch (no GC in the wheel / tick path of this module).
  private readonly _surf: SurfaceHit & { ray: { origin: Vector3; direction: Vector3 } } = {
    point: new Vector3(), distance: 0, blocked: false, path: null,
    ray: { origin: new Vector3(), direction: new Vector3() },
  };
  private readonly _dir = new Vector3();
  private readonly _fwd = new Vector3();
  private readonly _tmp = new Vector3();
  private readonly _anchor = new Vector3();
  private readonly _shift = new Vector3();
  private readonly _rayO = new Vector3();
  private readonly _rayD = new Vector3();
  private readonly _delta = new Vector3();
  private readonly _savedPos = new Vector3();
  private readonly _savedTarget = new Vector3();
  private readonly _savedQuat = new Quaternion();
  private readonly _sph = new Spherical();
  private readonly _nf: NearFar = { near: 0, far: 0 };
  private readonly _onf: NearFar = { near: 0, far: 0 };

  constructor(opts: NavigationControllerOptions) {
    this.opts = opts;
    this._onWheel = (e: WheelEvent) => this._handleWheel(e);
    this._onPointerDown = (e: PointerEvent) => this._handlePointerDown(e);
    this._onPointerMove = (e: Event) => this._handlePointerMove(e as PointerEvent);
    this._onPointerUp = (e: Event) => this._handlePointerUp(e as PointerEvent);
    this._onPointerCancel = (e: Event) => this._handlePointerCancel(e as PointerEvent);
    this._onContextMenu = (e: Event) => { if (this.opts.controls.enabled) e.preventDefault(); };
    this._onControlsStart = () => { if (!this._selfDispatch) this._needFlush = true; };
    const controls = opts.controls;
    controls.addEventListener('start', this._onControlsStart);
    // OrbitControls becomes a pure state holder: no DOM input of its own.
    // (Its disconnect() also clears touch-action — keep the canvas' value.)
    this._orbitElement = (controls.domElement as HTMLElement | null) ?? null;
    if (this._orbitElement) {
      const touchAction = this._orbitElement.style.touchAction;
      controls.disconnect();
      this._orbitElement.style.touchAction = touchAction || 'none';
    }
    opts.captureTarget.addEventListener('wheel', this._onWheel, { capture: true, passive: false });
    opts.captureTarget.addEventListener('pointerdown', this._onPointerDown, { capture: true });
    opts.canvas.addEventListener('contextmenu', this._onContextMenu);
    opts.canvas.addEventListener('lostpointercapture', this._onPointerCancel);
    this._pivot.copy(controls.target);
    this._recordOwn();
  }

  /** Pending (not yet applied) wheel notches — >0 = zoom in. */
  get pendingNotches(): number { return this._pendingNotches; }

  /** True while a wheel gesture or a drag / touch gesture is open. */
  get gestureActive(): boolean { return this._wheelGesture || this._drag !== G_NONE; }

  /** True while a drag / touch gesture is open. */
  get dragActive(): boolean { return this._drag !== G_NONE; }

  /** True while a released drag still moves the camera (its last frame or its inertia). */
  get inertiaActive(): boolean { return this._inertia !== I_NONE || this._tailInertia; }

  /** The current orbit pivot (world). A live view — do not mutate. */
  get pivot(): Readonly<Vector3> { return this._pivot; }

  /**
   * Reset the orbit pivot to `pivot` (default `controls.target`) and stop the inertia (explicit seam
   * for callers). Records the current target as the controller's own, so the next tick keeps the pivot.
   */
  resetPivot(pivot: Readonly<Vector3> = this.opts.controls.target): void {
    this._stopInertia();
    this._pivot.copy(pivot);
    this.stats.pivotResets++;
    this._recordOwn();
  }

  dispose(): void {
    this.opts.captureTarget.removeEventListener('wheel', this._onWheel, { capture: true });
    this.opts.captureTarget.removeEventListener('pointerdown', this._onPointerDown, { capture: true });
    this.opts.canvas.removeEventListener('contextmenu', this._onContextMenu);
    this.opts.canvas.removeEventListener('lostpointercapture', this._onPointerCancel);
    this.opts.controls.removeEventListener('start', this._onControlsStart);
    this._cancelDrag();
    this._stopInertia();
    this._endWheelGesture();
    // Hand the DOM input back to OrbitControls (its owner disposes it next).
    if (this._orbitElement) this.opts.controls.connect(this._orbitElement);
  }

  /**
   * Once per frame, from the render loop, BEFORE `tickProjectionAnimation` and
   * `controls.update()`: react to camera take-overs, apply the drag of this
   * frame (or the inertia), the accumulated wheel (one pick), end an idle
   * wheel gesture, then set the clipping. `nowMs` = the frame time on the
   * `performance.now()` clock (the wheel handler stamps `event.timeStamp`).
   */
  tick(nowMs: number): void {
    const { controls, camera: host } = this.opts;
    if (this._drag !== G_NONE || this._tail !== G_NONE || this._inertia !== I_NONE) {
      // FPV / XR / Sit-On / a gizmo took the camera, or a camera flight runs:
      // the drag ends here, without coasting. (Follow start / stop bumps the
      // camera epoch → _syncExternal stops the inertia; a drag begun during
      // Follow keeps orbiting the carried target.)
      if (!controls.enabled || host.followMode === 'siton' || host.isCameraAnimating) {
        this._cancelDrag();
        this._stopInertia();
      }
    }
    this._syncExternal();
    if (this._drag !== G_NONE || this._tail !== G_NONE) this._applyDrag();
    else if (this._inertia !== I_NONE) this._applyInertia();
    if (this._pendingNotches !== 0) this._applyWheel();
    if (this._wheelGesture && nowMs - this._lastWheelMs >= GESTURE_IDLE_MS) this._endWheelGesture();
    this._applyClipping();
    this._recordOwn();
  }

  /**
   * Discard OrbitControls' pending damping deltas (rotate / pan inertia of a
   * just-released drag) using public API only; the camera does not move.
   */
  flushDamping(): void {
    const controls = this.opts.controls;
    const cam = this.opts.getCamera();
    this._savedPos.copy(cam.position);
    this._savedTarget.copy(controls.target);
    this._savedQuat.copy(cam.quaternion);
    const prev = controls.enableDamping;
    controls.enableDamping = false;
    controls.update();
    controls.enableDamping = prev;
    cam.position.copy(this._savedPos);
    controls.target.copy(this._savedTarget);
    cam.quaternion.copy(this._savedQuat);
    this._syncCamera(cam);
  }

  // ─── pivot bookkeeping ──────────────────────────────────────────

  /** Remember controls.target / camera epoch as this controller leaves them. */
  private _recordOwn(): void {
    this._ownTarget.copy(this.opts.controls.target);
    this._ownEpoch = this.opts.camera.cameraEpoch;
  }

  /**
   * Somebody else moved the camera since the controller's last action (a
   * camera take-over counted by the host, or a changed controls.target) →
   * the pivot becomes the new target and the inertia stops. The tolerance
   * absorbs the float round trip of the target in OrbitControls.update().
   */
  private _syncExternal(): void {
    const t = this.opts.controls.target;
    const o = this._ownTarget;
    const epoch = this.opts.camera.cameraEpoch;
    const dx = t.x - o.x, dy = t.y - o.y, dz = t.z - o.z;
    const ax = t.x < 0 ? -t.x : t.x, ay = t.y < 0 ? -t.y : t.y, az = t.z < 0 ? -t.z : t.z;
    const tol = 1e-9 * (1 + (ax > ay ? (ax > az ? ax : az) : (ay > az ? ay : az)));
    if (epoch !== this._ownEpoch) {
      this._pivot.copy(t);
      this._stopInertia();
      this.stats.pivotResets++;
    } else if (this.opts.camera.followMode === 'follow') {
      // Orbit-follow carries controls.target every frame: the pivot IS the
      // carried target, and a running orbit / its inertia goes on about it.
      this._pivot.copy(t);
    } else if (dx * dx + dy * dy + dz * dz > tol * tol) {
      this._pivot.copy(t);
      this._stopInertia();
      this.stats.pivotResets++;
    }
    o.copy(t);
    this._ownEpoch = epoch;
  }

  // ─── pointer input ──────────────────────────────────────────────

  /** Navigation input: finish a running projection tween first (R3-3). */
  private _completeTween(): void {
    const host = this.opts.camera;
    if (!host.isProjectionAnimating) return;
    host.completeProjectionAnimation();
    this.stats.tweensCompleted++;
    this.opts.markDirty();
  }

  private _handlePointerDown(e: PointerEvent): void {
    if (e.target !== this.opts.canvas || !this.opts.controls.enabled) return;
    this._completeTween();
    if (e.pointerType === 'touch') {
      this._touchDown(e);
      return;
    }
    if (this._drag !== G_NONE) return; // one gesture at a time
    const mod = e.ctrlKey || e.metaKey || e.shiftKey;
    let kind = G_NONE;
    if (e.button === 2) kind = mod ? G_PAN : G_ORBIT;
    else if (e.button === 1) kind = mod ? G_ORBIT : G_PAN;
    if (kind === G_NONE) return;
    if (!this._beginDrag(e)) return;
    // Orbit-follow pulled every pan back to the part (pre-515): hold, don't pan.
    if (kind === G_PAN && this.opts.camera.followMode === 'follow') kind = G_HOLD;
    this._drag = kind;
    this._ptrA = e.pointerId;
    this._ptrAX = e.clientX;
    this._ptrAY = e.clientY;
    if (kind === G_ORBIT) this._grabPivot(e.clientX, e.clientY);
    else if (kind === G_PAN) this._grabPlane(e.clientX, e.clientY, this.navigateAroundCursorPoint);
    this._recordOwn();
  }

  /** Touch: the first finger starts the gesture (orbit), the second one pinch / pan. */
  private _touchDown(e: PointerEvent): void {
    if (this._drag !== G_NONE && this._drag !== G_TOUCH) return; // a mouse drag owns the camera
    if (this._drag === G_NONE) {
      if (!this._beginDrag(e)) return;
      this._drag = G_TOUCH;
      this._touchCount = 1;
      this._ptrA = e.pointerId;
      this._ptrAX = e.clientX;
      this._ptrAY = e.clientY;
      this._grabPivot(e.clientX, e.clientY);
      this._recordOwn();
      return;
    }
    if (this._touchCount !== 1 || e.pointerId === this._ptrA) return; // a third finger is ignored
    this._capture(e.pointerId);
    this._touchCount = 2;
    this._ptrB = e.pointerId;
    this._ptrBX = e.clientX;
    this._ptrBY = e.clientY;
    this._accDX = 0;
    this._accDY = 0;
    this._velYaw = 0;
    this._velPitch = 0;
    const mx = (this._ptrAX + this._ptrBX) * 0.5;
    const my = (this._ptrAY + this._ptrBY) * 0.5;
    if (this.opts.camera.followMode === 'follow') {
      // Orbit-follow: the pinch dollies toward the carried target (anchor
      // re-read every step, see _pinchStep); no pick, no pan.
      this._syncCamera(this.opts.getCamera());
      this._viewAxis(this.opts.getCamera());
      this._grabN.copy(this._fwd);
      this._grab.copy(this.opts.controls.target);
    } else if (this._grabPlane(mx, my, true) && this.navigateAroundCursorPoint) {
      // Pinch anchor: the surface under the midpoint (in both modes - the scale
      // fix), else the midpoint on the plane through the focus point. Only
      // with navigateAroundCursorPoint does it also become the orbit pivot.
      this._pivot.copy(this._grab);
    }
    this._prevDist = Math.hypot(this._ptrBX - this._ptrAX, this._ptrBY - this._ptrAY);
    this._recordOwn();
  }

  /**
   * Common start of a drag: 'start' (once per gesture), guards, cancel a
   * camera flight, stop the inertia, react to take-overs, flush OrbitControls
   * damping, capture the pointer. False = no gesture (the 'start' was answered
   * by an 'end').
   */
  private _beginDrag(e: PointerEvent): boolean {
    const { controls, camera: host, canvas } = this.opts;
    this._endWheelGesture(); // 'start' / 'end' stay paired per gesture
    this._dispatchStart();
    // The 'start' above lets a follow that yields to the human (agent eye,
    // plan-740) let go first. Sit-On owns the camera (controls disabled): no
    // gesture. A follow that stays → the gesture orbits the carried target.
    if (host.followMode === 'siton' || !controls.enabled) {
      controls.dispatchEvent(_endEvent);
      this.stats.refusedGestures++;
      return false;
    }
    this.stats.gestures++;
    this.stats.drags++;
    if (host.isCameraAnimating) host.cancelCameraAnimation();
    this._stopInertia();
    this._tail = G_NONE;
    this._syncExternal();
    if (this._needFlush) {
      this._needFlush = false;
      this.flushDamping();
    }
    const r = canvas.getBoundingClientRect();
    this._rectL = r.left;
    this._rectT = r.top;
    this._accDX = 0;
    this._accDY = 0;
    this._velYaw = 0;
    this._velPitch = 0;
    this._velPan.set(0, 0, 0);
    const root = canvas.getRootNode();
    root.addEventListener('pointermove', this._onPointerMove);
    root.addEventListener('pointerup', this._onPointerUp);
    root.addEventListener('pointercancel', this._onPointerCancel);
    this._dragRoot = root;
    this._capture(e.pointerId);
    this.opts.markDirty();
    return true;
  }

  private _dispatchStart(): void {
    this._selfDispatch = true;
    this.opts.controls.dispatchEvent(_startEvent);
    this._selfDispatch = false;
  }

  private _capture(pointerId: number): void {
    try { this.opts.canvas.setPointerCapture(pointerId); } catch { /* synthetic / inactive pointer */ }
  }

  private _release(pointerId: number): void {
    const cv = this.opts.canvas;
    try { if (cv.hasPointerCapture(pointerId)) cv.releasePointerCapture(pointerId); } catch { /* gone */ }
  }

  /**
   * Orbit start. Default: the pivot is the fixed `controls.target` (no pick).
   * With navigateAroundCursorPoint: the surface point under the cursor becomes
   * the pivot; background keeps it.
   */
  private _grabPivot(clientX: number, clientY: number): void {
    // Orbit-follow: the pivot is the carried follow target, never the surface.
    if (this.opts.camera.followMode === 'follow' || !this.navigateAroundCursorPoint) {
      this._pivot.copy(this.opts.controls.target);
      return;
    }
    if (this._pick(clientX, clientY)) this._pivot.copy(this._surf.point);
  }

  /**
   * Pan / pinch start: with `pickSurface`, grab the surface point under
   * (clientX, clientY); else (or on background) the cursor on the plane
   * through the focus point ⟂ view axis. The plane normal is the view axis at
   * grab time. True on a surface hit.
   */
  private _grabPlane(clientX: number, clientY: number, pickSurface: boolean): boolean {
    const cam = this.opts.getCamera();
    this._syncCamera(cam);
    this._viewAxis(cam);
    this._grabN.copy(this._fwd);
    if (pickSurface && this._pick(clientX, clientY)) {
      this._grab.copy(this._surf.point);
      return true;
    }
    this._cursorRay(cam, clientX - this._rectL, clientY - this._rectT);
    const t = this.opts.controls.target;
    const n = this._grabN;
    const o = this._rayO, d = this._rayD;
    const den = d.x * n.x + d.y * n.y + d.z * n.z;
    const k = den > 1e-9 ? ((t.x - o.x) * n.x + (t.y - o.y) * n.y + (t.z - o.z) * n.z) / den : 0;
    if (k > 0) this._grab.set(o.x + d.x * k, o.y + d.y * k, o.z + d.z * k);
    else this._grab.copy(t);
    return false;
  }

  /** One surface pick — only at a gesture start, never per drag frame. */
  private _pick(clientX: number, clientY: number): boolean {
    const picker = this.opts.getPicker();
    this.stats.picks++;
    return picker ? picker.raycastSurface(clientX, clientY, this._surf) : false;
  }

  private _handlePointerMove(e: PointerEvent): void {
    if (this._drag === G_NONE) return;
    const id = e.pointerId;
    if (id === this._ptrA) {
      this._accDX += e.clientX - this._ptrAX;
      this._accDY += e.clientY - this._ptrAY;
      this._ptrAX = e.clientX;
      this._ptrAY = e.clientY;
    } else if (id === this._ptrB) {
      this._ptrBX = e.clientX;
      this._ptrBY = e.clientY;
    } else {
      return;
    }
    this.opts.markDirty();
  }

  private _handlePointerUp(e: PointerEvent): void {
    const id = e.pointerId;
    if (this._drag === G_NONE || (id !== this._ptrA && id !== this._ptrB)) return;
    if (this._drag === G_TOUCH && this._touchCount === 2) {
      // Two fingers → one: the remaining finger orbits on, from where it is now.
      if (id === this._ptrA) {
        this._ptrA = this._ptrB;
        this._ptrAX = this._ptrBX;
        this._ptrAY = this._ptrBY;
      }
      this._ptrB = -1;
      this._touchCount = 1;
      // Default mode: the remaining finger orbits about the (pinch-moved) target.
      if (!this.navigateAroundCursorPoint) this._pivot.copy(this.opts.controls.target);
      this._accDX = 0;
      this._accDY = 0;
      this._velYaw = 0;
      this._velPitch = 0;
      this._release(id);
      return;
    }
    this._finishDrag(true);
  }

  /** pointercancel / lostpointercapture: end the gesture WITHOUT residual motion. */
  private _handlePointerCancel(e: PointerEvent): void {
    if (this._drag === G_NONE || (e.pointerId !== this._ptrA && e.pointerId !== this._ptrB)) return;
    this._cancelDrag();
    this._stopInertia();
  }

  /**
   * End the drag ('end'). With `coast`, the next tick still applies the motion
   * that arrived since the last frame and then hands the smoothed velocity to
   * the inertia (a pinch never coasts); without, all pending motion is dropped.
   */
  private _finishDrag(coast: boolean): void {
    const kind = this._drag;
    if (kind === G_NONE) return;
    const wasPinch = kind === G_TOUCH && this._touchCount === 2;
    this._tail = coast && !wasPinch && kind !== G_HOLD ? (kind === G_TOUCH ? G_ORBIT : kind) : G_NONE;
    this._tailInertia = this._tail !== G_NONE;
    if (this._tail === G_NONE) { this._accDX = 0; this._accDY = 0; }
    this._drag = G_NONE;
    this._touchCount = 0;
    if (this._ptrA >= 0) this._release(this._ptrA);
    if (this._ptrB >= 0) this._release(this._ptrB);
    this._ptrA = -1;
    this._ptrB = -1;
    const root = this._dragRoot;
    if (root) {
      root.removeEventListener('pointermove', this._onPointerMove);
      root.removeEventListener('pointerup', this._onPointerUp);
      root.removeEventListener('pointercancel', this._onPointerCancel);
      this._dragRoot = null;
    }
    this.opts.controls.dispatchEvent(_endEvent);
    this.opts.markDirty();
  }

  private _cancelDrag(): void {
    if (this._drag !== G_NONE) this._finishDrag(false);
    this._tail = G_NONE;
    this._tailInertia = false;
    this._accDX = 0;
    this._accDY = 0;
  }

  private _stopInertia(): void {
    this._inertia = I_NONE;
    this._inertiaFrames = 0;
    this._tailInertia = false;
  }

  // ─── drag / inertia (tick) ──────────────────────────────────────

  /** Apply this frame's drag (or the released drag's last frame, then start its inertia). */
  private _applyDrag(): void {
    const cam = this.opts.getCamera();
    this._syncCamera(cam);
    const kind = this._drag !== G_NONE ? this._drag : this._tail;
    if (kind === G_HOLD) {
      this._accDX = 0;
      this._accDY = 0;
    } else if (kind === G_PAN) {
      this._panStep(cam);
    } else if (kind === G_TOUCH && this._touchCount === 2) {
      this._pinchStep(cam);
    } else {
      this._orbitStep(cam);
    }
    if (this._drag === G_NONE) {
      // The last frame of the released drag is applied: coast with its smoothed velocity.
      this._tail = G_NONE;
      if (this._tailInertia && this.opts.controls.enableDamping) {
        this._inertia = kind === G_PAN ? I_PAN : I_ORBIT;
        this._inertiaFrames = 0;
      }
      this._tailInertia = false;
    }
  }

  /** Mouse / one-finger orbit by the pixels moved since the last tick. */
  private _orbitStep(cam: PerspectiveCamera | OrthographicCamera): void {
    const dx = this._accDX, dy = this._accDY;
    this._accDX = 0;
    this._accDY = 0;
    let yaw = 0, pitch = 0;
    if (dx !== 0 || dy !== 0) {
      const h = this.opts.canvas.clientHeight || 1;
      const k = TWO_PI / h * (this.opts.controls.rotateSpeed || 1);
      // OrbitControls' mapping: drag right → the scene turns right; drag down → look down.
      yaw = -k * dx;
      pitch = -k * dy;
      this._io.yaw = yaw;
      this._io.pitch = pitch;
      this._orbit(cam);
      pitch = this._io.result;
      this.stats.orbits++;
    }
    this._velYaw = this._velYaw * 0.5 + yaw * 0.5;
    this._velPitch = this._velPitch * 0.5 + pitch * 0.5;
  }

  /** Orbit about the pivot by `_io.yaw` / `_io.pitch`; re-establish the camera invariant. */
  private _orbit(cam: PerspectiveCamera | OrthographicCamera): void {
    const target = this.opts.controls.target;
    const pos = cam.position;
    const tx0 = target.x - pos.x, ty0 = target.y - pos.y, tz0 = target.z - pos.z;
    const focus0 = Math.sqrt(tx0 * tx0 + ty0 * ty0 + tz0 * tz0);
    const io = this._io;
    io.minPolar = MIN_ORBIT_POLAR;
    orbitAboutPivotIO(pos, cam.quaternion, this._pivot, pos, cam.quaternion, io);
    this._syncCamera(cam);
    this._viewAxis(cam);
    // Camera invariant: target on the view axis at the pivot's depth (a rigid
    // rotation about the pivot keeps that depth); a pivot behind the camera
    // keeps the previous focus distance.
    const fwd = this._fwd;
    const p = this._pivot;
    let f = (p.x - pos.x) * fwd.x + (p.y - pos.y) * fwd.y + (p.z - pos.z) * fwd.z;
    if (!(f > MIN_DOLLY_DIST)) f = focus0 > MIN_DOLLY_DIST ? focus0 : MIN_DOLLY_DIST;
    target.x = pos.x + fwd.x * f; target.y = pos.y + fwd.y * f; target.z = pos.z + fwd.z * f;
    this._afterMove();
  }

  /** Mouse pan: keep the grabbed point under the cursor (ray-plane only). */
  private _panStep(cam: PerspectiveCamera | OrthographicCamera): void {
    const dx = this._accDX, dy = this._accDY;
    this._accDX = 0;
    this._accDY = 0;
    if (dx === 0 && dy === 0) {
      this._velPan.multiplyScalar(0.5);
      return;
    }
    this._cursorRay(cam, this._ptrAX - this._rectL, this._ptrAY - this._rectT);
    const d = this._delta;
    panKeepPointIO(this._rayO, this._rayD, this._grab, this._grabN, d);
    const s = this.opts.controls.panSpeed;
    if (s !== 1 && s > 0) d.multiplyScalar(s);
    this._translate(cam, d);
    this._velPan.multiplyScalar(0.5).addScaledVector(d, 0.5);
    this.stats.pans++;
  }

  /** Two fingers: dolly toward the anchor by the finger-distance ratio, then pan it under the midpoint. */
  private _pinchStep(cam: PerspectiveCamera | OrthographicCamera): void {
    this._accDX = 0;
    this._accDY = 0;
    const ax = this._ptrAX, ay = this._ptrAY, bx = this._ptrBX, by = this._ptrBY;
    const ddx = bx - ax, ddy = by - ay;
    const dist = Math.sqrt(ddx * ddx + ddy * ddy);
    const prev = this._prevDist;
    this._prevDist = dist;
    const controls = this.opts.controls;
    const target = controls.target;
    const a = this._grab;
    const following = this.opts.camera.followMode === 'follow';
    if (following) a.copy(target); // the follow carries the anchor
    const io = this._io;
    const scale = this._liveScale();
    if (prev > 0 && dist > 0 && dist !== prev) {
      const zs = controls.zoomSpeed || 1;
      const ratio = zs === 1 ? dist / prev : Math.pow(dist / prev, zs);
      if ((cam as PerspectiveCamera).isPerspectiveCamera) {
        // The wheel's surface dolly with a step from the finger ratio: d' = d / ratio.
        const pos = cam.position;
        const dir = this._dir;
        dir.x = a.x - pos.x; dir.y = a.y - pos.y; dir.z = a.z - pos.z;
        const d = Math.sqrt(dir.x * dir.x + dir.y * dir.y + dir.z * dir.z);
        if (d > 0) {
          dir.x /= d; dir.y /= d; dir.z /= d;
          io.dist = d;
          if (ratio > 1) { io.notches = 1; io.step = 1 - 1 / ratio; } else { io.notches = -1; io.step = 1 - ratio; }
          io.minDist = MIN_DOLLY_DIST;
          dollyStepIO(io);
          let d2 = io.result;
          if (scale && d2 > d) {
            io.maxRadius = MAX_OUT_RADII * scale.radius;
            maxBackoffInsideIO(pos, dir, scale.center, io);
            if (d2 - d > io.result) d2 = d + io.result;
          }
          const move = d - d2;
          pos.x += dir.x * move; pos.y += dir.y * move; pos.z += dir.z * move;
          this._syncCamera(cam);
        }
      } else {
        const o = cam as OrthographicCamera;
        io.factor = ratio;
        io.minVisibleH = MIN_ORTHO_HEIGHT;
        io.maxVisibleH = scale ? MAX_ORTHO_HEIGHT_RADII * scale.radius : Infinity;
        zoomOrthoAtCursorIO(o, a, this._shift, io);
        o.zoom = io.result;
        o.updateProjectionMatrix();
        o.position.add(this._shift);
        target.add(this._shift);
        this._syncCamera(o);
      }
      this.stats.pinches++;
    }
    // Orbit-follow: a pure dolly toward the carried target — it stays on the
    // view axis, so the camera invariant holds without the pan.
    if (following) { this._afterMove(); return; }
    // Pan: the anchor back under the midpoint.
    this._cursorRay(cam, (ax + bx) * 0.5 - this._rectL, (ay + by) * 0.5 - this._rectT);
    const delta = this._delta;
    panKeepPointIO(this._rayO, this._rayD, a, this._grabN, delta);
    const s = controls.panSpeed;
    if (s !== 1 && s > 0) delta.multiplyScalar(s);
    this._translate(cam, delta);
    if ((cam as PerspectiveCamera).isPerspectiveCamera) {
      // Camera invariant at the anchor's depth.
      const pos = cam.position;
      this._viewAxis(cam);
      const fwd = this._fwd;
      let f = (a.x - pos.x) * fwd.x + (a.y - pos.y) * fwd.y + (a.z - pos.z) * fwd.z;
      if (!(f > MIN_DOLLY_DIST)) f = MIN_DOLLY_DIST;
      target.x = pos.x + fwd.x * f; target.y = pos.y + fwd.y * f; target.z = pos.z + fwd.z * f;
    }
  }

  /** Coast after a released drag: `velocity *= 1 − dampingFactor` per frame. */
  private _applyInertia(): void {
    const controls = this.opts.controls;
    const df = controls.dampingFactor;
    const k = 1 - (df > 0 && df < 1 ? df : 0.2);
    const cam = this.opts.getCamera();
    this._syncCamera(cam);
    this._inertiaFrames++;
    this.stats.inertiaFrames++;
    if (this._inertia === I_ORBIT) {
      this._velYaw *= k;
      this._velPitch *= k;
      const y = this._velYaw, p = this._velPitch;
      if ((y < 1e-6 && y > -1e-6 && p < 1e-6 && p > -1e-6) || this._inertiaFrames > MAX_INERTIA_FRAMES) {
        this._stopInertia();
        return;
      }
      this._io.yaw = y;
      this._io.pitch = p;
      this._orbit(cam);
      if (this._io.result !== p) this._velPitch = this._io.result; // the pole clamp absorbs the pitch
    } else {
      const v = this._velPan;
      v.multiplyScalar(k);
      const t = controls.target;
      const cp = cam.position;
      const fx = t.x - cp.x, fy = t.y - cp.y, fz = t.z - cp.z;
      const tiny = 1e-6 * Math.sqrt(fx * fx + fy * fy + fz * fz) + 1e-12;
      if (v.x * v.x + v.y * v.y + v.z * v.z < tiny * tiny || this._inertiaFrames > MAX_INERTIA_FRAMES) {
        this._stopInertia();
        return;
      }
      this._translate(cam, v);
    }
  }

  /** Move camera AND target by `d` (the target stays on the view axis). */
  private _translate(cam: PerspectiveCamera | OrthographicCamera, d: Vector3): void {
    cam.position.x += d.x; cam.position.y += d.y; cam.position.z += d.z;
    const t = this.opts.controls.target;
    t.x += d.x; t.y += d.y; t.z += d.z;
    this._syncCamera(cam);
    this._afterMove();
  }

  private _afterMove(): void {
    const host = this.opts.camera;
    if (host.isProjectionAnimating) host.refreshProjectionAnimation();
    this.opts.markDirty();
  }

  /** `_rayO` / `_rayD` = world ray through the canvas offset (ox, oy) (matrices current). */
  private _cursorRay(cam: PerspectiveCamera | OrthographicCamera, ox: number, oy: number): void {
    const cv = this.opts.canvas;
    const w = cv.clientWidth || 1;
    const h = cv.clientHeight || 1;
    this._io.ndcX = (ox / w) * 2 - 1;
    this._io.ndcY = -(oy / h) * 2 + 1;
    cursorRayIO(cam, this._io, this._rayO, this._rayD);
  }

  /** `_fwd` = unit view axis (−Z column of the current world matrix). */
  private _viewAxis(cam: PerspectiveCamera | OrthographicCamera): void {
    const me = cam.matrixWorld.elements;
    const fwd = this._fwd;
    fwd.x = -me[8]; fwd.y = -me[9]; fwd.z = -me[10];
    const fl = Math.sqrt(fwd.x * fwd.x + fwd.y * fwd.y + fwd.z * fwd.z) || 1;
    fwd.x /= fl; fwd.y /= fl; fwd.z /= fl;
  }

  // ─── wheel ──────────────────────────────────────────────────────

  private _handleWheel(e: WheelEvent): void {
    const { controls, canvas } = this.opts;
    // Only wheel ON the 3D canvas — HMI panels inside the same container scroll normally.
    if (e.target !== canvas) return;
    this.opts.onUserInput?.();
    if (!controls.enabled) return; // FPV / XR / Sit-On own the camera
    e.preventDefault();
    e.stopImmediatePropagation();
    this._completeTween();
    this._stopInertia(); // a new navigation input takes over from a coasting drag
    if (isTrackpadOrbitWheel(e)) {
      this._trackpadOrbit(e.deltaX, e.deltaY);
      return;
    }
    this.stats.wheelEvents++;
    const scale = e.deltaMode === 1 ? 1 / 3 : e.deltaMode === 2 ? 1 : 1 / 100;
    let notches = -e.deltaY * scale;
    if (e.ctrlKey) {
      // Trackpad pinch arrives as ctrl+wheel with small pixel deltas (same ×10 as OrbitControls).
      notches *= 10;
      if (notches > MAX_PINCH_NOTCHES_PER_EVENT) notches = MAX_PINCH_NOTCHES_PER_EVENT;
      else if (notches < -MAX_PINCH_NOTCHES_PER_EVENT) notches = -MAX_PINCH_NOTCHES_PER_EVENT;
    }
    this._pendingNotches += notches;
    // By default the mouse wheel zooms toward the point under the CURSOR;
    // `wheelZoomToCursor = false` anchors it at the middle of the viewport. A trackpad pinch
    // (ctrl+wheel) always keeps its anchor under the fingers. `offsetX/Y` is
    // relative to the canvas (the event target), so the centre in client
    // coordinates needs no layout read.
    const atCursor = e.ctrlKey || this.wheelZoomToCursor;
    const offX = atCursor ? e.offsetX : canvas.clientWidth / 2;
    const offY = atCursor ? e.offsetY : canvas.clientHeight / 2;
    // Whole CSS pixels: the pick and the dolly share ONE ray (the pick's), so
    // rounding costs no consistency — and integers cross calls unboxed.
    this._clientX = Math.round(e.clientX - e.offsetX + offX);
    this._clientY = Math.round(e.clientY - e.offsetY + offY);
    this._offX = offX;
    this._offY = offY;
    this._lastWheelMs = e.timeStamp;
    this.opts.markDirty();
  }

  /**
   * Trackpad two-finger drag: orbit about `controls.target` (the historical
   * heuristic of rv-viewer).
   */
  private _trackpadOrbit(deltaX: number, deltaY: number): void {
    const { controls } = this.opts;
    const cam = this.opts.getCamera();
    const target = controls.target;
    this._tmp.subVectors(cam.position, target);
    this._sph.setFromVector3(this._tmp);
    this._sph.theta += deltaX * TRACKPAD_ORBIT_RAD_PER_PX;
    this._sph.phi = Math.max(0.01, Math.min(Math.PI - 0.01, this._sph.phi + deltaY * TRACKPAD_ORBIT_RAD_PER_PX));
    this._tmp.setFromSpherical(this._sph);
    cam.position.copy(target).add(this._tmp);
    cam.lookAt(target);
    controls.update();
    this.stats.trackpadOrbits++;
    this.opts.markDirty();
  }

  private _applyWheel(): void {
    const notches = this._pendingNotches;
    this._pendingNotches = 0;
    const { controls, camera: host, canvas } = this.opts;
    if (!controls.enabled) return;
    // A drag in progress owns the camera (OrbitControls ignored the wheel then, too).
    if (this._drag !== G_NONE) return;
    if (host.isCameraAnimating) host.cancelCameraAnimation();
    // A tween started programmatically since the wheel event — finish it too.
    this._completeTween();

    if (this._needFlush) {
      this._needFlush = false;
      this.flushDamping();
    }

    const cam = this.opts.getCamera();
    this._syncCamera(cam);
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (w <= 0 || h <= 0) return;
    this._ndcX = (this._offX / w) * 2 - 1;
    this._ndcY = -(this._offY / h) * 2 + 1;
    this._notches = notches;
    // View axis = −Z column of the world matrix (current: _syncCamera just rebuilt it).
    this._viewAxis(cam);

    const picker = this.opts.getPicker();
    this.stats.picks++;
    if (picker) {
      this._surf.ray.direction.x = 0; this._surf.ray.direction.y = 0; this._surf.ray.direction.z = 0;
      this._hit = picker.raycastSurface(this._clientX, this._clientY, this._surf);
      const rd = this._surf.ray.direction;
      this._rayValid = rd.x * rd.x + rd.y * rd.y + rd.z * rd.z > 0.5;
    } else {
      this._hit = false;
      this._rayValid = false;
    }

    this._step = Math.min(0.9, BASE_STEP * (controls.zoomSpeed || 1));
    if (!this._wheelGesture) {
      this._wheelGesture = true;
      this.stats.gestures++;
      this._dispatchStart();
    }
    if ((cam as PerspectiveCamera).isPerspectiveCamera) {
      this._zoomPerspective(cam as PerspectiveCamera);
    } else {
      this._zoomOrtho(cam as OrthographicCamera);
    }
    this.stats.zooms++;
    // No explicit 'change': this frame's `controls.update()` (render loop) sees
    // the moved pose and dispatches it itself — once, like any OrbitControls move.
    if (host.isProjectionAnimating) host.refreshProjectionAnimation();
    this.opts.markDirty();
  }

  private _zoomPerspective(cam: PerspectiveCamera): void {
    const target = this.opts.controls.target;
    const scale = this._liveScale();
    const io = this._io;
    const pos = cam.position;
    const fwd = this._fwd;
    // The dolly moves along the PICK ray (exactly the ray the surface was found
    // on); without a picker, along the cursor ray from the canvas offset.
    const dir = this._dir;
    if (this._rayValid) {
      dir.copy(this._surf.ray.direction);
    } else {
      io.ndcX = this._ndcX; io.ndcY = this._ndcY;
      cursorRayIO(cam, io, this._rayO, dir);
    }
    const cosT = dir.x * fwd.x + dir.y * fwd.y + dir.z * fwd.z;
    const tx = target.x - pos.x, ty = target.y - pos.y, tz = target.z - pos.z;
    const targetDist = Math.sqrt(tx * tx + ty * ty + tz * tz);
    let d: number;
    if (this._hit) {
      const p = this._surf.point;
      d = (p.x - pos.x) * dir.x + (p.y - pos.y) * dir.y + (p.z - pos.z) * dir.z;
    } else if (cosT > 1e-6) {
      // Background: cursor ray against the plane through the target ⟂ view axis.
      d = (tx * fwd.x + ty * fwd.y + tz * fwd.z) / cosT;
    } else {
      d = targetDist;
    }
    if (!(d > 0) || !(d < Infinity)) d = Math.max(targetDist, MIN_DOLLY_DIST);
    io.dist = d; io.notches = this._notches; io.step = this._step; io.minDist = MIN_DOLLY_DIST;
    dollyStepIO(io);
    let d2 = io.result;
    // Zoom-out CLAMP: back off at most to MAX_OUT_RADII scene radii from the centre.
    if (scale && d2 > d) {
      io.maxRadius = MAX_OUT_RADII * scale.radius;
      maxBackoffInsideIO(pos, dir, scale.center, io);
      if (d2 - d > io.result) d2 = d + io.result;
    }
    const move = d - d2;
    pos.x += dir.x * move; pos.y += dir.y * move; pos.z += dir.z * move;
    this._syncCamera(cam);
    // Camera invariant: target on the VIEW AXIS at the hit's depth.
    const f = Math.max(d2 * cosT, MIN_DOLLY_DIST);
    target.x = pos.x + fwd.x * f; target.y = pos.y + fwd.y * f; target.z = pos.z + fwd.z * f;
  }

  private _zoomOrtho(cam: OrthographicCamera): void {
    const target = this.opts.controls.target;
    const scale = this._liveScale();
    const io = this._io;
    const fwd = this._fwd;
    const a = this._anchor;
    if (this._hit) {
      a.copy(this._surf.point);
    } else {
      // Cursor point on the plane through the target ⟂ view axis (ray origin on the near plane).
      const origin = this._tmp;
      if (this._rayValid) {
        origin.copy(this._surf.ray.origin);
      } else {
        io.ndcX = this._ndcX; io.ndcY = this._ndcY;
        cursorRayIO(cam, io, origin, this._rayD);
      }
      const t = (target.x - origin.x) * fwd.x + (target.y - origin.y) * fwd.y + (target.z - origin.z) * fwd.z;
      a.x = origin.x + fwd.x * t; a.y = origin.y + fwd.y * t; a.z = origin.z + fwd.z * t;
    }
    io.factor = 1 / Math.pow(1 - this._step, this._notches);
    io.minVisibleH = MIN_ORTHO_HEIGHT;
    io.maxVisibleH = scale ? MAX_ORTHO_HEIGHT_RADII * scale.radius : Infinity;
    zoomOrthoAtCursorIO(cam, a, this._shift, io);
    cam.zoom = io.result;
    cam.updateProjectionMatrix();
    cam.position.add(this._shift);
    target.add(this._shift);
    this._syncCamera(cam);
  }

  /**
   * Rebuild the camera's world and view matrices after a pose change —
   * `Camera.updateMatrixWorld()` without its `decompose()` (the viewer's
   * cameras are unscaled) and without walking children: `decompose` passes
   * doubles into non-inlined helpers, and once inlined into this module that
   * boxing counts as ours (R3-5). The render pass updates the full graph anyway.
   */
  private _syncCamera(cam: PerspectiveCamera | OrthographicCamera): void {
    if (cam.matrixAutoUpdate) cam.updateMatrix();
    const parent = cam.parent;
    if (parent) cam.matrixWorld.multiplyMatrices(parent.matrixWorld, cam.matrix);
    else cam.matrixWorld.copy(cam.matrix);
    cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
  }

  private _endWheelGesture(): void {
    if (!this._wheelGesture) return;
    this._wheelGesture = false;
    this.opts.controls.dispatchEvent(_endEvent);
  }

  private _liveScale(): NavSceneScaleSnapshot | null {
    const sc = this.opts.getSceneScale();
    return sc && !sc.empty ? sc : null;
  }

  private _applyClipping(): void {
    const sc = this._liveScale();
    if (!sc) return;
    const cam = this.opts.getCamera();
    const p = cam.position;
    const t = this.opts.controls.target;
    const dx = t.x - p.x, dy = t.y - p.y, dz = t.z - p.z;
    const io = this._io;
    io.focus = Math.sqrt(dx * dx + dy * dy + dz * dz);
    nearFarForIO(p, sc, io, this._nf);
    orthoNearFarForIO(p, sc, io, this._onf);
    const minFar = this.opts.getMinFar ? this.opts.getMinFar(p) : 0;
    if (minFar > this._nf.far) {
      this._nf.far = minFar;
      this._nf.near = Math.max(this._nf.near, minFar / MAX_FAR_NEAR_RATIO);
    }
    if (this.opts.camera.applyClipping(this._nf, this._onf)) {
      this.stats.clippingUpdates++;
      this.opts.markDirty();
    }
  }
}
