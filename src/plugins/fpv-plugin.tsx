// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * FpvPlugin — First-Person View walkthrough navigation for desktop browsers.
 *
 * Right-click drag for mouse look, WASD for movement.
 * Left-click remains free for UI interaction and object selection.
 * Disables OrbitControls when active (same pattern as WebXRPlugin).
 * Snaps camera Y to ground plane + eye height via downward raycast.
 *
 * Mobile FPV (nipplejs virtual joystick) is deferred to a future phase.
 */

import { useState, useEffect } from 'react';
import { Vector3, Raycaster, Object3D, Euler, MathUtils } from 'three';
import type { RVViewerPlugin } from '../core/rv-plugin';
import type { RVViewer } from '../core/rv-viewer';
import type { LoadResult } from '../core/engine/rv-scene-loader';
import type { UISlotEntry } from '../core/rv-ui-plugin';
import { isMobileDevice } from '../hooks/use-mobile-layout';
import { loadVisualSettings } from '../core/hmi/visual-settings-store';
import { activateContext, deactivateContext } from '../core/hmi/ui-context-store';
import type { WebXRPlugin } from './webxr-plugin';

// ─── Constants ──────────────────────────────────────────────────────────

/** Ground snap Y interpolation factor per second (exponential lerp). */
const GROUND_SNAP_LERP = 8;

/** Maximum raycast distance downward for ground detection. */
const GROUND_RAY_MAX = 50;

/** Default FPV settings from plan. */
const DEFAULT_SPEED = 2.5;
const DEFAULT_SPRINT_SPEED = 5.0;
const DEFAULT_SENSITIVITY = 0.002;
const DEFAULT_EYE_HEIGHT = 1.7;

/** Max pitch angle in radians (slightly less than 90° to avoid gimbal lock). */
const MAX_PITCH = MathUtils.degToRad(85);

// ─── Key codes for WASD + arrows ────────────────────────────────────────

const FORWARD_KEYS = new Set(['KeyW', 'ArrowUp']);
const BACKWARD_KEYS = new Set(['KeyS', 'ArrowDown']);
const LEFT_KEYS = new Set(['KeyA', 'ArrowLeft']);
const RIGHT_KEYS = new Set(['KeyD', 'ArrowRight']);
const SPRINT_KEYS = new Set(['ShiftLeft', 'ShiftRight']);
const TOGGLE_KEY = 'KeyF';

// ─── Reusable vectors (pre-allocated, zero GC in update loop) ───────────

const _forward = new Vector3();
const _right = new Vector3();
const _moveDir = new Vector3();
const _rayOrigin = new Vector3();
const _downDir = new Vector3(0, -1, 0);

// ─── External subscribers for React re-render ───────────────────────────

type Listener = () => void;
let _fpvActive = false;
const _listeners = new Set<Listener>();
function notifyListeners() { _listeners.forEach((l) => l()); }

/** React hook: subscribe to FPV active state changes. */
export function useFpvActive(): boolean {
  const [active, setActive] = useState(_fpvActive);
  useEffect(() => {
    const cb = () => setActive(_fpvActive);
    _listeners.add(cb);
    return () => { _listeners.delete(cb); };
  }, []);
  return active;
}

// ─── FPV Plugin ─────────────────────────────────────────────────────────

export class FpvPlugin implements RVViewerPlugin {
  readonly id = 'fpv';
  readonly order = 5; // Before drive physics

  // ── Public state ──
  /** Whether FPV mode is currently active. */
  get isActive(): boolean { return this._active; }

  // ── Settings (loaded from visual-settings-store) ──
  speed = DEFAULT_SPEED;
  sprintSpeed = DEFAULT_SPRINT_SPEED;
  sensitivity = DEFAULT_SENSITIVITY;
  eyeHeight = DEFAULT_EYE_HEIGHT;

  // ── Plugin slots (FPV button is in BottomBar, not left sidebar) ──
  readonly slots: UISlotEntry[] = [];

  // ── Private state ──
  private _viewer: RVViewer | null = null;
  private _active = false;
  private _isTransitioning = false;
  private _keys = new Set<string>();
  private _groundTargets: Object3D[] = [];
  private _groundRaycaster = new Raycaster();
  private _currentGroundY = 0;
  private _hasGroundHit = false;

  // Camera Euler angles (yaw = Y rotation, pitch = X rotation)
  private _yaw = 0;
  private _pitch = 0;

  // Right-click drag state
  private _isLooking = false;

  // Saved orbit state for restore on exit
  private _savedCamPos = new Vector3();
  private _savedCamTarget = new Vector3();

  // Info overlay
  private _overlay: HTMLDivElement | null = null;
  private _overlayClickHandler: (() => void) | null = null;

  // Track whether listeners have been set up
  private _listenersSetUp = false;

  // Bound event handlers (for removeEventListener)
  private _onKeyDown: ((e: KeyboardEvent) => void) | null = null;
  private _onKeyUp: ((e: KeyboardEvent) => void) | null = null;
  private _onPointerDown: ((e: PointerEvent) => void) | null = null;
  private _onPointerMove: ((e: PointerEvent) => void) | null = null;
  private _onPointerUp: ((e: PointerEvent) => void) | null = null;
  private _onContextMenu: ((e: Event) => void) | null = null;
  private _onBlur: (() => void) | null = null;
  private _onVisibilityChange: (() => void) | null = null;

  // XR event unsubs
  private _unsubs: (() => void)[] = [];

  // ── Lifecycle ──────────────────────────────────────────────────────

  onModelLoaded(_result: LoadResult, viewer: RVViewer): void {
    this._viewer = viewer;

    // Load settings
    this._loadSettings();

    // Cache ground targets (scene fixtures that are flat meshes on XZ plane)
    this._groundTargets = [];
    for (const child of viewer.scene.children) {
      // The ground plane is a Mesh rotated -PI/2 on X (flat on XZ)
      if ((child as { isMesh?: boolean }).isMesh && Math.abs(child.rotation.x + Math.PI / 2) < 0.01) {
        this._groundTargets.push(child);
      }
    }

    this._setupEventListeners(viewer);

    // Listen for XR session start to exit FPV
    const unsubXrStart = viewer.on('xr-session-start', () => {
      if (this._active) this.exit();
    });
    this._unsubs.push(unsubXrStart);
  }

  onModelCleared(viewer: RVViewer): void {
    // Exit FPV if active (scene geometry gone, ground cache stale)
    if (this._active) this._exitImmediate();
    this._groundTargets = [];
    // Clean up XR event listeners
    this._unsubs.forEach((u) => u());
    this._unsubs = [];
    this._viewer = viewer;
  }

  onFixedUpdatePre(dt: number): void {
    if (!this._active || !this._viewer) return;

    const viewer = this._viewer;
    const camera = viewer.camera;
    const speed = this._keys.has('ShiftLeft') || this._keys.has('ShiftRight')
      ? this.sprintSpeed : this.speed;

    // ── Compute movement direction on XZ plane ──
    _moveDir.set(0, 0, 0);

    // Forward vector: camera look direction projected onto XZ
    camera.getWorldDirection(_forward);
    _forward.y = 0;
    _forward.normalize();

    // Right vector: forward × up = (-fz, 0, fx) — perpendicular on XZ
    _right.set(-_forward.z, 0, _forward.x);

    let hasInput = false;
    for (const code of this._keys) {
      if (FORWARD_KEYS.has(code))  { _moveDir.add(_forward); hasInput = true; }
      if (BACKWARD_KEYS.has(code)) { _moveDir.sub(_forward); hasInput = true; }
      if (LEFT_KEYS.has(code))     { _moveDir.sub(_right); hasInput = true; }
      if (RIGHT_KEYS.has(code))    { _moveDir.add(_right); hasInput = true; }
    }

    if (hasInput) {
      _moveDir.normalize();
      camera.position.addScaledVector(_moveDir, speed * dt);
    }

    // ── Ground snapping ──
    this._snapToGround(camera.position, dt);

    // ── Always mark render dirty while FPV is active (continuous rendering) ──
    viewer.markRenderDirty();
  }

  dispose(): void {
    if (this._active) this._exitImmediate();
    this._removeOverlay();
    this._removeEventListeners();
    this._unsubs.forEach((u) => u());
    this._unsubs = [];
  }

  // ── Public API ─────────────────────────────────────────────────────

  /** Enter FPV mode. Called from button click or F key. */
  enter(): void {
    if (this._active || this._isTransitioning || !this._viewer) return;

    // XR conflict guard
    const xrPlugin = this._viewer.getPlugin<WebXRPlugin>('webxr');
    if (xrPlugin?.isPresenting) return;

    // Show info overlay — user clicks to start
    this._showOverlay();
  }

  /** Exit FPV mode. Called from button click or F key. */
  exit(): void {
    if (!this._active || this._isTransitioning || !this._viewer) return;

    this._isTransitioning = true;
    this._removeOverlay();

    // Restore orbit state
    const viewer = this._viewer;
    viewer.camera.position.copy(this._savedCamPos);
    viewer.controls.target.copy(this._savedCamTarget);
    viewer.controls.enabled = true;
    viewer.controls.update();

    // Update state
    this._active = false;
    _fpvActive = false;
    this._isLooking = false;
    notifyListeners();
    this._keys.clear();
    this._isTransitioning = false;

    // Deactivate UI context so hidden elements reappear
    deactivateContext('fpv');

    viewer.emit('fpv-exit', undefined as void);
    viewer.markRenderDirty();
  }

  /** Toggle FPV mode. */
  toggle(): void {
    if (this._active) {
      this.exit();
    } else {
      this.enter();
    }
  }

  /** Reload settings from visual-settings-store. */
  reloadSettings(): void {
    this._loadSettings();
  }

  // ── Private: Enter flow ────────────────────────────────────────────

  /** Actually activate FPV. */
  private _activateFpv(): void {
    const viewer = this._viewer;
    if (!viewer) return;

    this._isTransitioning = true;

    // Cancel any in-progress camera animation
    viewer.cancelCameraAnimation();

    // Save orbit state (position + controls.target) for restore on exit
    this._savedCamPos.copy(viewer.camera.position);
    this._savedCamTarget.copy(viewer.controls.target);

    // Disable orbit controls
    viewer.controls.enabled = false;

    // Initialize yaw/pitch from current camera orientation
    const euler = new Euler();
    euler.setFromQuaternion(viewer.camera.quaternion, 'YXZ');
    this._yaw = euler.y;
    this._pitch = euler.x;

    // Position camera at current orbit position but at eye height
    const camPos = viewer.camera.position;
    this._currentGroundY = 0;
    this._hasGroundHit = false;

    // Do an initial ground snap to find current ground level
    try {
      if (this._groundTargets.length > 0) {
        _rayOrigin.set(camPos.x, camPos.y + 10, camPos.z);
        this._groundRaycaster.set(_rayOrigin, _downDir);
        this._groundRaycaster.far = GROUND_RAY_MAX;
        const hits = this._groundRaycaster.intersectObjects(this._groundTargets, false);
        if (hits.length > 0) {
          this._currentGroundY = hits[0].point.y;
          this._hasGroundHit = true;
        }
      }
    } catch { /* raycast can fail in test environments with mock objects */ }
    camPos.y = this._currentGroundY + this.eyeHeight;

    // Update state
    this._active = true;
    _fpvActive = true;
    notifyListeners();
    this._isTransitioning = false;

    // Activate UI context so context-aware elements hide themselves
    activateContext('fpv');

    viewer.emit('fpv-enter', undefined as void);
    viewer.markRenderDirty();
  }

  /** Exit FPV immediately without animation (used for model clear, dispose). */
  private _exitImmediate(): void {
    if (!this._viewer) return;

    const viewer = this._viewer;
    viewer.controls.enabled = true;
    this._removeOverlay();

    this._active = false;
    _fpvActive = false;
    this._isLooking = false;
    notifyListeners();
    this._keys.clear();
    this._isTransitioning = false;

    // Deactivate UI context
    deactivateContext('fpv');
  }

  // ── Private: Ground snapping ───────────────────────────────────────

  private _snapToGround(camPos: Vector3, dt: number): void {
    if (this._groundTargets.length === 0) {
      // No ground: keep at eye height above Y=0
      const targetY = this.eyeHeight;
      camPos.y += (targetY - camPos.y) * Math.min(1, GROUND_SNAP_LERP * dt);
      return;
    }

    // Cast ray downward from above camera position
    try {
      _rayOrigin.set(camPos.x, camPos.y + 10, camPos.z);
      this._groundRaycaster.set(_rayOrigin, _downDir);
      this._groundRaycaster.far = GROUND_RAY_MAX;

      const hits = this._groundRaycaster.intersectObjects(this._groundTargets, false);
      if (hits.length > 0) {
        this._currentGroundY = hits[0].point.y;
        this._hasGroundHit = true;
      }
    } catch { /* raycast can fail with non-standard geometry objects */ }

    if (this._hasGroundHit) {
      const targetY = this._currentGroundY + this.eyeHeight;
      camPos.y += (targetY - camPos.y) * Math.min(1, GROUND_SNAP_LERP * dt);
    }
  }

  // ── Private: Settings ──────────────────────────────────────────────

  private _loadSettings(): void {
    const s = loadVisualSettings();
    this.speed = s.fpvSpeed ?? DEFAULT_SPEED;
    this.sprintSpeed = s.fpvSprintSpeed ?? DEFAULT_SPRINT_SPEED;
    this.sensitivity = s.fpvSensitivity ?? DEFAULT_SENSITIVITY;
    this.eyeHeight = s.fpvEyeHeight ?? DEFAULT_EYE_HEIGHT;
  }

  // ── Private: Info Overlay ───────────────────────────────────────────

  private _showOverlay(): void {
    if (this._overlay) return;

    this._overlay = document.createElement('div');
    this._overlay.style.cssText = [
      'position: fixed',
      'inset: 0',
      'display: flex',
      'flex-direction: column',
      'align-items: center',
      'justify-content: center',
      'background: rgba(0, 0, 0, 0.7)',
      'z-index: 10001',
      'cursor: pointer',
      'color: white',
      'font-family: sans-serif',
    ].join('; ');

    this._overlay.innerHTML = `
      <div style="text-align: center; max-width: 400px;">
        <div style="font-size: 36px; margin-bottom: 16px;">&#127918;</div>
        <div style="font-size: 20px; font-weight: 600; margin-bottom: 8px;">Click to Enter</div>
        <div style="font-size: 16px; margin-bottom: 24px;">First-Person View</div>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px 24px; font-size: 14px; color: rgba(255,255,255,0.8);">
          <div><b>WASD</b> &mdash; Move</div>
          <div><b>Right-drag</b> &mdash; Look</div>
          <div><b>Shift</b> &mdash; Sprint</div>
          <div><b>F</b> &mdash; Exit</div>
        </div>
        <div style="margin-top: 24px; font-size: 13px; color: rgba(255,255,255,0.5);">Click anywhere to start</div>
      </div>
    `;

    this._overlayClickHandler = () => {
      this._removeOverlay();
      this._activateFpv();
    };
    this._overlay.addEventListener('click', this._overlayClickHandler);

    document.body.appendChild(this._overlay);
  }

  private _removeOverlay(): void {
    if (this._overlay) {
      if (this._overlayClickHandler) {
        this._overlay.removeEventListener('click', this._overlayClickHandler);
        this._overlayClickHandler = null;
      }
      this._overlay.remove();
      this._overlay = null;
    }
  }

  // ── Private: Mouse look (right-click drag) ─────────────────────────

  private _applyMouseLook(movementX: number, movementY: number): void {
    if (!this._viewer) return;

    this._yaw -= movementX * this.sensitivity;
    this._pitch -= movementY * this.sensitivity;

    // Clamp pitch to avoid flipping
    this._pitch = MathUtils.clamp(this._pitch, -MAX_PITCH, MAX_PITCH);

    // Apply rotation via Euler (YXZ order: yaw first, then pitch)
    const euler = new Euler(this._pitch, this._yaw, 0, 'YXZ');
    this._viewer.camera.quaternion.setFromEuler(euler);

    this._viewer.markRenderDirty();
  }

  // ── Private: Event listeners ───────────────────────────────────────

  private _setupEventListeners(viewer: RVViewer): void {
    if (this._listenersSetUp) return;
    this._listenersSetUp = true;

    const canvas = viewer.renderer.domElement;

    // Keyboard
    this._onKeyDown = (e: KeyboardEvent) => {
      // Input focus guard: skip WASD when typing in input/textarea
      const tag = (document.activeElement as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

      if (!this._active) {
        // F key toggle (only when not in input)
        if (e.code === TOGGLE_KEY && !isMobileDevice()) {
          e.preventDefault();
          this.toggle();
        }
        return;
      }

      this._keys.add(e.code);
    };

    this._onKeyUp = (e: KeyboardEvent) => {
      this._keys.delete(e.code);
    };

    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);

    // Right-click drag for mouse look.
    // Use e.buttons bitmask (bit 1 = right button) instead of tracking
    // pointerdown/up — avoids conflicts with OrbitControls which also
    // listens on the canvas and may consume pointerdown.
    this._onPointerDown = (e: PointerEvent) => {
      if (!this._active) return;
      if (e.button === 2) {
        this._isLooking = true;
        e.preventDefault();
      }
    };

    this._onPointerMove = (e: PointerEvent) => {
      if (!this._active) return;
      // Check right button held via bitmask — works even if pointerdown
      // was consumed by another handler (OrbitControls, etc.)
      if (!(e.buttons & 2)) { this._isLooking = false; return; }
      this._isLooking = true;
      this._applyMouseLook(e.movementX, e.movementY);
    };

    this._onPointerUp = (e: PointerEvent) => {
      if (e.button === 2) {
        this._isLooking = false;
      }
    };

    // Prevent context menu on right-click when FPV is active
    this._onContextMenu = (e: Event) => {
      if (this._active) {
        e.preventDefault();
      }
    };

    canvas.addEventListener('pointerdown', this._onPointerDown);
    window.addEventListener('pointermove', this._onPointerMove);
    window.addEventListener('pointerup', this._onPointerUp);
    // Use capture phase so this fires before any other contextmenu handler
    window.addEventListener('contextmenu', this._onContextMenu, true);

    // Sticky keys guard: clear keys on window blur / visibility change
    this._onBlur = () => { this._keys.clear(); this._isLooking = false; };
    window.addEventListener('blur', this._onBlur);

    this._onVisibilityChange = () => {
      if (document.hidden) { this._keys.clear(); this._isLooking = false; }
    };
    document.addEventListener('visibilitychange', this._onVisibilityChange);
  }

  private _removeEventListeners(): void {
    if (this._onKeyDown) window.removeEventListener('keydown', this._onKeyDown);
    if (this._onKeyUp) window.removeEventListener('keyup', this._onKeyUp);
    if (this._onBlur) window.removeEventListener('blur', this._onBlur);
    if (this._onVisibilityChange) document.removeEventListener('visibilitychange', this._onVisibilityChange);

    // Window-bound pointer listeners
    if (this._onPointerMove) window.removeEventListener('pointermove', this._onPointerMove);
    if (this._onPointerUp) window.removeEventListener('pointerup', this._onPointerUp);
    if (this._onContextMenu) window.removeEventListener('contextmenu', this._onContextMenu, true);

    // Canvas-bound listeners
    const canvas = this._viewer?.renderer?.domElement;
    if (canvas) {
      if (this._onPointerDown) canvas.removeEventListener('pointerdown', this._onPointerDown);
    }
    this._listenersSetUp = false;
  }
}
