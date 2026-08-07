// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * AdaptiveNavPlugin — Distance-based adaptive zoom & pan navigation.
 *
 * Scales OrbitControls zoomSpeed and panSpeed proportionally to the
 * camera-to-target distance every frame. Near objects get finer control,
 * far objects get coarser steps — similar to Unity Scene View behavior.
 *
 * The plugin caches base speeds from the visual-settings store (never reads
 * controls.zoomSpeed as basis to avoid cumulative drift). When active, it
 * owns the controls.zoomSpeed / controls.panSpeed writes — MouseTab sliders
 * and applyNavigationSettingsToControls() only update the store values.
 *
 * Opt-in via `distanceAdaptiveNav: true` in visual settings (default: false).
 */

import { MathUtils, PerspectiveCamera } from 'three';
import type { RVViewerPlugin } from '../core/rv-plugin';
import type { RVViewer } from '../core/rv-viewer';
import type { LoadResult } from '../core/engine/rv-scene-loader';
import { loadVisualSettings } from '../core/hmi/visual-settings-store';

// ── Tuning Constants ─────────────────────────────────────────────────
//
// Scaling uses sqrt(distance * FACTOR) instead of linear distance * FACTOR.
// Why: linear scaling collapses too fast near the target — at 0.1 m the
// wheel effectively freezes (factor 0.01). sqrt keeps close-range usable
// while still giving the "Unity Scene View" feel at distance.
//
// Reference points for zoom with ZOOM_DIST_FACTOR = 0.10:
//   distance = 100 m → sqrt(10)   ≈ 3.16
//   distance =  10 m → sqrt(1.0)  =  1.00  (baseline preserved)
//   distance =   1 m → sqrt(0.1)  ≈ 0.32
//   distance =  0.1 m → sqrt(0.01) =  0.10 → clamped up by MIN_FACTOR

/** sqrt(distance * this) → 1.0 at 10 m (baseline). */
export const ZOOM_DIST_FACTOR = 0.10;
/** Pan scales slightly faster than zoom for natural feel. */
export const PAN_DIST_FACTOR = 0.12;
/** Minimum factor clamp — keeps the wheel responsive at very close range. */
export const MIN_FACTOR = 0.15;
/** Maximum factor clamp — prevents runaway speeds at extreme distance. */
export const MAX_FACTOR = 10.0;

export class AdaptiveNavPlugin implements RVViewerPlugin {
  readonly id = 'adaptive-nav';
  readonly core = true;
  readonly order = -10;

  private _viewer: RVViewer | null = null;
  private _baseZoom = 1.0;
  private _basePan = 1.0;
  private _enabled = false;

  onModelLoaded(_result: LoadResult, viewer: RVViewer): void {
    this._viewer = viewer;
    this.reloadSettings();
  }

  onModelCleared(_viewer: RVViewer): void {
    this._enabled = false;
    this._baseZoom = 1.0;
    this._basePan = 1.0;
  }

  /** Called when settings change (slider, reset, etc.). */
  reloadSettings(): void {
    const s = loadVisualSettings();
    this._enabled = s.distanceAdaptiveNav ?? false;
    this._baseZoom = s.orbitZoomSpeed;
    this._basePan = s.orbitPanSpeed;
  }

  onRender(_frameDt: number): void {
    if (!this._enabled || !this._viewer) return;
    const controls = this._viewer.controls;
    if (!controls?.enabled) return;
    // Skip OrthographicCamera — distanceTo has different semantics
    if (!(this._viewer.camera instanceof PerspectiveCamera)) return;

    const dist = controls.getDistance();
    if (!Number.isFinite(dist)) return;

    const safeDist = Math.max(dist, 0.01);
    controls.zoomSpeed = this._baseZoom * MathUtils.clamp(Math.sqrt(safeDist * ZOOM_DIST_FACTOR), MIN_FACTOR, MAX_FACTOR);
    controls.panSpeed = this._basePan * MathUtils.clamp(Math.sqrt(safeDist * PAN_DIST_FACTOR), MIN_FACTOR, MAX_FACTOR);
  }

  dispose(): void {
    this._viewer = null;
    this._enabled = false;
  }
}
