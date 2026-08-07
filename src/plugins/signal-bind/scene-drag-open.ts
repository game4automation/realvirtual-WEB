// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * scene-drag-open.ts — auto-open the Signal-Bind popover while a signal chip is
 * dragged over a bindable element in the 3D scene (plan-246 F10).
 *
 * Subscribes to the global signal-drag store. While a drag is in progress and
 * the pointer is over the WebGL canvas, the target is resolved primarily from
 * the drop overlay's magnet selection (the port the active marker points at),
 * with the raycast + findPlacedAncestor path as fallback for direct geometry
 * hits. If it has bindable slots, its Signal-Bind popover opens automatically
 * (debounced ~250 ms so sweeping across elements does not flicker), letting the
 * drop land directly on a slot row. Leaving the element without dropping closes
 * the auto-opened popover again; a successful drop keeps it open.
 *
 * Entirely inert when the viewer has no `signalBindingManager` (the
 * plannerSignalLinking feature is off) — every move checks lazily, so a
 * manager created at model-load time is picked up without re-init.
 */

import type { RVViewer } from '../../core/rv-viewer';
import {
  subscribeSignalDrag,
  subscribeSignalDragPos,
  getSignalDragPhase,
  getLastSignalDragResult,
} from '../../core/hmi/signal-drag-store';
import { openSignalBindPopover, closeSignalBindPopover } from './signal-bind-store';
import { findBindableAncestor, signalBindTargetId, type SignalBindTarget } from './signal-bind-target';

/** Debounce before the popover opens/closes for a new hover target (anti-flicker). */
const AUTO_OPEN_DEBOUNCE_MS = 250;
/** Min interval between raycasts during a drag (pointermove can fire at 120+ Hz). */
const RAYCAST_THROTTLE_MS = 50;

export class SceneDragOpenController {
  private readonly _viewer: RVViewer;
  /** Magnet target of the drop overlay — what the active marker visibly points at. */
  private readonly _nearestTarget: (() => SignalBindTarget | null) | null;
  private _unsubPhase: (() => void) | null = null;
  private _unsubPos: (() => void) | null = null;
  private _lastRaycastMs = 0;

  /** Debounce state: the target we are about to open/close for. */
  private _pendingId: string | null = null;
  private _pendingTarget: SignalBindTarget | null = null;
  private _pendingTimer: number | null = null;

  /** The placedId whose popover THIS controller auto-opened (never a user-opened one). */
  private _autoOpenedId: string | null = null;

  constructor(viewer: RVViewer, nearestTarget?: () => SignalBindTarget | null) {
    this._viewer = viewer;
    this._nearestTarget = nearestTarget ?? null;
    this._unsubPhase = subscribeSignalDrag(() => this._onPhaseChange());
  }

  dispose(): void {
    this._unsubPhase?.();
    this._unsubPhase = null;
    this._detachPos();
    this._clearPending();
    this._autoOpenedId = null;
  }

  // ─── internal ──────────────────────────────────────────────────────────

  private _onPhaseChange(): void {
    const dragging = getSignalDragPhase() === 'dragging';
    if (dragging && !this._unsubPos) {
      this._lastRaycastMs = 0;
      this._unsubPos = subscribeSignalDragPos((x, y) => this._onMove(x, y));
    } else if (!dragging && this._unsubPos) {
      this._detachPos();
      this._clearPending();
      // Drag ended: keep the popover when the drop landed (the user is looking
      // at the fresh binding); close it when the drag was cancelled elsewhere.
      if (this._autoOpenedId && getLastSignalDragResult() !== 'dropped') {
        closeSignalBindPopover();
      }
      this._autoOpenedId = null;
    }
  }

  private _detachPos(): void {
    this._unsubPos?.();
    this._unsubPos = null;
  }

  private _onMove(x: number, y: number): void {
    const mgr = this._viewer.signalBindingManager;
    const rm = this._viewer.raycastManager;
    if (!mgr || !rm) return;

    // Only act while the pointer is over the canvas — over HMI panels
    // (including the auto-opened popover itself) the current state holds.
    // Same lenient over-canvas semantics as the drop-target overlay: the strict
    // `el === canvas` equality silently failed under any element layered above
    // the canvas, which is why the popover sometimes never opened.
    const canvas = this._viewer.renderer.domElement;
    const rect = canvas.getBoundingClientRect();
    const insideCanvas = x >= rect.left && x <= rect.left + rect.width
      && y >= rect.top && y <= rect.top + rect.height;
    const el = insideCanvas ? document.elementFromPoint(x, y) : null;
    if (!insideCanvas || !(el === null || el === canvas || canvas.contains(el))) {
      this._clearPending();
      return;
    }

    // The overlay's magnet target wins: it is what the active marker visibly
    // points at, even when the cursor hovers empty space near the port. The
    // raycast only serves geometry hits outside the magnet radius.
    let target = this._nearestTarget?.() ?? null;
    if (!target) {
      const now = performance.now();
      if (now - this._lastRaycastMs < RAYCAST_THROTTLE_MS) return;
      this._lastRaycastMs = now;
      const hit = rm.raycastForRVNodeDetailed({ clientX: x, clientY: y });
      const node = hit ? this._viewer.registry?.getNode(hit.path) ?? null : null;
      target = node ? findBindableAncestor(this._viewer, node) : null;
    }
    const targetId = target ? signalBindTargetId(target) : null;

    if (targetId === this._autoOpenedId) {
      // Already showing the right popover (or none needed & none open) — stable.
      this._clearPending();
      return;
    }
    if (targetId === this._pendingId && this._pendingTimer !== null) return; // debounce running

    this._clearPending();
    this._pendingId = targetId;
    this._pendingTarget = target;
    this._pendingTimer = window.setTimeout(() => {
      this._pendingTimer = null;
      const pending = this._pendingTarget;
      this._pendingId = null;
      this._pendingTarget = null;
      if (pending) {
        openSignalBindPopover(pending);
        this._autoOpenedId = signalBindTargetId(pending);
      } else if (this._autoOpenedId) {
        closeSignalBindPopover();
        this._autoOpenedId = null;
      }
    }, AUTO_OPEN_DEBOUNCE_MS);
  }

  private _clearPending(): void {
    if (this._pendingTimer !== null) {
      window.clearTimeout(this._pendingTimer);
      this._pendingTimer = null;
    }
    this._pendingId = null;
    this._pendingTarget = null;
  }
}

