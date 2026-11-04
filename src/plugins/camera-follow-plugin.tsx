// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * CameraFollowPlugin — Follow & Sit-On camera modes bound to the current
 * selection.
 *
 * - Follow: the camera keeps its relative offset to the selected, moving part
 *   while the user can keep orbiting (orbit-follow). OrbitControls stays live.
 * - Sit-On: the camera rides on the part (position + orientation) and the user
 *   looks around with right-click drag (same input scheme as the FPV plugin).
 *
 * The tracking math lives in CameraManager (exposed via the RVViewer facade
 * `startCameraFollow` / `startCameraSitOn` / `stopCameraFollow` /
 * `applyCameraLookDelta`). This plugin only owns the mode lifecycle, the
 * mouse-look input for Sit-On and the conflict guards (FPV / XR).
 * CameraManager reports mode changes through the viewer for the toolbar.
 *
 * Mutually exclusive with FPV and XR: entering a mode exits FPV; an FPV or XR
 * session start, a deselection, or a model clear exits this plugin.
 */

import { BaseViewerPlugin } from '../core/rv-base-plugin';
import type { RVViewer } from '../core/rv-viewer';
import type { PluginContext } from '../core/rv-plugin-context';
import type { LoadResult } from '../core/engine/rv-scene-loader';
import { resolveFollowSource } from '../core/engine/rv-follow-source';
import type { CameraFollowPluginAPI, CameraFollowMode } from '../core/types/plugin-types';

export class CameraFollowPlugin extends BaseViewerPlugin implements CameraFollowPluginAPI {
  readonly id = 'camera-follow';
  readonly order = 5; // alongside FPV

  // ── Private state ──
  private _viewer: RVViewer | null = null;
  private _selectionOff: (() => void) | null = null;

  // Right-click drag look listeners (Sit-On only)
  private _onPointerMove: ((e: PointerEvent) => void) | null = null;
  private _onContextMenu: ((e: Event) => void) | null = null;
  private _listenersSetUp = false;

  // ── Lifecycle ──────────────────────────────────────────────────────

  override init(viewer: RVViewer, context?: PluginContext): void {
    super.init(viewer, context);
    this._viewer = viewer;
    // This subscription must survive BaseViewerPlugin.onModelCleared().
    this._selectionOff?.();
    this._selectionOff = viewer.on('selection-changed', () => {
      if (this.mode && !this.canFollow()) this.exit();
    });
  }

  onModelLoaded(_result: LoadResult, viewer: RVViewer): void {
    this._viewer = viewer;
    this._setupLookListeners(viewer);
    // FPV / XR start ends the selection-owned mode.
    this.sub(viewer.on('fpv-enter', () => this.exit()));
    this.sub(viewer.on('xr-session-start', () => this.exit()));
  }

  override onModelCleared(viewer: RVViewer): void {
    // Scene gone → the followed node is stale; leave the mode without a restore
    // animation (the saved view belongs to the cleared model).
    if (this.mode) this._exitImmediate();
    super.onModelCleared(viewer); // flush viewer.on() subs
    this._viewer = viewer;
  }

  override dispose(): void {
    if (this.mode) this._exitImmediate();
    this._selectionOff?.();
    this._selectionOff = null;
    this._removeLookListeners();
    super.dispose();
    this._viewer = null;
  }

  // ── Public API (CameraFollowPluginAPI) ─────────────────────────────

  /** The active mode, or null when neither Follow nor Sit-On is running. */
  get mode(): CameraFollowMode {
    const v = this._viewer;
    if (!v || v.cameraFollowOwner !== 'selection') return null;
    return v.cameraFollowMode === 'off' ? null : v.cameraFollowMode;
  }

  /** Toggle a mode: re-clicking the active mode exits; otherwise enters it. */
  toggle(mode: 'follow' | 'siton'): void {
    if (this.mode === mode) { this.exit(); return; }
    this.enter(mode);
  }

  /** Enter a mode for the current selection. No-op if nothing followable is selected. */
  enter(mode: 'follow' | 'siton'): void {
    const v = this._viewer;
    if (!v) return;

    // XR conflict guard — never take over the camera during an immersive session.
    const xr = v.getPlugin<{ id: string; isPresenting?: boolean }>('webxr');
    if (xr?.isPresenting) return;

    // Resolve the selected part into a follow source.
    const path = v.selectionManager.primaryPath;
    const src = path ? resolveFollowSource(v, path) : null;
    if (!src) return; // not followable → no-op (button is disabled anyway)

    // Exit FPV first (mutually exclusive camera ownership).
    v.getPlugin<{ id: string; exit?(): void }>('fpv')?.exit?.();

    if (mode === 'follow') {
      v.startCameraFollow(src);
    } else {
      v.startCameraSitOn(src);
    }
  }

  /** Leave the active mode and restore the entry view. */
  exit(): void {
    if (!this.mode || !this._viewer) return;
    this._viewer.stopCameraFollow(true);
  }

  /** Whether a followable part is currently selected (drives toolbar enabled state). */
  canFollow(): boolean {
    const v = this._viewer;
    if (!v) return false;
    const path = v.selectionManager.primaryPath;
    return !!path && !!resolveFollowSource(v, path);
  }

  // ── Private: exit without restore animation (model clear / dispose) ──

  private _exitImmediate(): void {
    if (!this.mode) return;
    const v = this._viewer;
    v?.stopCameraFollow(false);
  }

  // ── Private: Sit-On mouse look (right-click drag, FPV-consistent) ──

  private _setupLookListeners(viewer: RVViewer): void {
    if (this._listenersSetUp) return;
    this._listenersSetUp = true;
    const canvas = viewer.renderer.domElement;

    // Right button held (bitmask) drives the look — works even if pointerdown
    // was consumed elsewhere. Left-click stays free for selection / UI.
    this._onPointerMove = (e: PointerEvent) => {
      if (this.mode !== 'siton') return;
      if (!(e.buttons & 2)) return;
      viewer.applyCameraLookDelta(e.movementX, e.movementY);
    };

    // Suppress the context menu while looking around in Sit-On.
    this._onContextMenu = (e: Event) => {
      if (this.mode === 'siton') e.preventDefault();
    };

    window.addEventListener('pointermove', this._onPointerMove);
    window.addEventListener('contextmenu', this._onContextMenu, true);
    // canvas referenced so future per-canvas listeners are easy to add.
    void canvas;
  }

  private _removeLookListeners(): void {
    if (this._onPointerMove) window.removeEventListener('pointermove', this._onPointerMove);
    if (this._onContextMenu) window.removeEventListener('contextmenu', this._onContextMenu, true);
    this._onPointerMove = null;
    this._onContextMenu = null;
    this._listenersSetUp = false;
  }
}
