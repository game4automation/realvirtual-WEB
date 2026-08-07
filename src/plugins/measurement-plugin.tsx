// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * measurement-plugin.ts — 3D distance measurement tool for the realvirtual WebViewer.
 *
 * Allows users to measure distances between mesh surfaces with a two-click
 * workflow. Measurements persist in localStorage per model and are managed
 * via a LeftPanel UI (MeasurementPanel).
 *
 * Follows the AnnotationPlugin pattern: own Raycaster (Layer 0), CanvasTexture
 * sprite labels, useSyncExternalStore snapshot/subscribe, localStorage persistence.
 */

import { Raycaster, Vector2, Vector3 } from 'three';
import type { Object3D } from 'three';
import type { RVViewerPlugin } from '../core/rv-plugin';
import type { RVViewer } from '../core/rv-viewer';
import type { LoadResult } from '../core/engine/rv-scene-loader';
import type { UISlotEntry } from '../core/rv-ui-plugin';
import type { Measurement, MeasurementPluginAPI } from '../core/types/plugin-types';
import { MeasurementRenderer, formatDistance as _formatDistance } from './rv-measurement-renderer';
import { MEASUREMENT_LAYER } from '../core/engine/rv-constants';
import { pointerToNDC } from '../core/engine/rv-pointer-utils';
import { createStore } from '../core/hmi/create-store';
import { modeContext } from '../core/rv-mode-manager';

// Re-export formatDistance for tests and external consumers
export { formatDistance } from './rv-measurement-renderer';

// ── Constants ──────────────────────────────────────────────────────────

const LS_PREFIX = 'rv-measurements-';
const DEFAULT_COLOR = '#4fc3f7';
const MEASUREMENT_COLORS = [
  '#4fc3f7', '#66bb6a', '#ffa726', '#ef5350', '#ab47bc',
  '#26c6da', '#9ccc65', '#ffca28', '#ec407a', '#7e57c2',
];

// ── State machine ──────────────────────────────────────────────────────

type MeasureState = 'idle' | 'waitingFirst' | 'waitingSecond';

/** Axis lock: measure only along one axis (project pointB onto axis from pointA). */
export type MeasureAxisLock = 'none' | 'x' | 'y' | 'z';

// ── External subscribers for React re-render ───────────────────────────

type Listener = () => void;

export interface MeasurementSnapshot {
  measurements: Measurement[];
  measurementMode: boolean;
  axisLock: MeasureAxisLock;
}

const _store = createStore<MeasurementSnapshot>({
  measurements: [],
  measurementMode: false,
  axisLock: 'none',
});

/** React hook support: subscribe to measurement state changes. */
export function subscribeMeasurements(listener: Listener): () => void {
  return _store.subscribe(listener);
}

export function getMeasurementSnapshot(): MeasurementSnapshot {
  return _store.getSnapshot();
}

// ── MeasureButton (button-group slot) ─────────────────────────────────

import { useSyncExternalStore, useCallback } from 'react';
import { IconButton, Tooltip } from '@mui/material';
import { Straighten } from '@mui/icons-material';
import { useViewer } from '../hooks/use-viewer';
import { useMobileLayout } from '../hooks/use-mobile-layout';
import type { RVViewer as RVViewerType } from '../core/rv-viewer';

function MeasureButton({ viewer: _v }: { viewer: RVViewerType }) {
  const viewer = useViewer();
  const snap = useSyncExternalStore(subscribeMeasurements, getMeasurementSnapshot);
  const plugin = viewer.getPlugin('measurements') as MeasurementPlugin | undefined;
  const isMobile = useMobileLayout();

  const handleClick = useCallback(() => {
    if (!plugin) return;
    plugin.measurementMode = !plugin.measurementMode;
    // On mobile, skip the panel — measurements are shown as 3D labels directly
    if (!isMobile) {
      const lpm = viewer.leftPanelManager;
      if (plugin.measurementMode) {
        lpm.open('measurements', 280);
      } else {
        lpm.close('measurements');
      }
    }
  }, [plugin, viewer, isMobile]);

  return (
    <Tooltip title="Measure distance" placement="right">
      <IconButton
        size="small"
        onClick={handleClick}
        sx={{ color: snap.measurementMode ? '#4fc3f7' : 'text.secondary' }}
      >
        <Straighten sx={{ fontSize: 18 }} />
      </IconButton>
    </Tooltip>
  );
}

// ── Plugin ─────────────────────────────────────────────────────────────

export class MeasurementPlugin implements RVViewerPlugin, MeasurementPluginAPI {
  readonly id = 'measurements';
  readonly order = 50;
  readonly slots: UISlotEntry[] = [
    // Without a rule ButtonPanel hides every entry in a focused workspace mode.
    // Measuring is useful while authoring CAD assets too, so the Editor is
    // explicitly allowed; Planner and DES stay focused on their own tools.
    {
      slot: 'button-group',
      component: MeasureButton,
      order: 55,
      visibilityRule: { hiddenIn: [modeContext('planner'), modeContext('des')] },
    },
  ];

  // ── State ──
  private _measurements: Measurement[] = [];
  private _measurementMode = false;
  private _state: MeasureState = 'idle';
  private _pendingPointA: [number, number, number] | null = null;
  private _pendingNormalA: [number, number, number] | null = null;
  private _pendingNormalB: [number, number, number] | null = null;
  private _colorIndex = 0;
  private _axisLock: MeasureAxisLock = 'none';

  // ── Three.js ──
  private _renderer: MeasurementRenderer | null = null;
  private _worldRaycaster = new Raycaster();
  private _pointer = new Vector2();
  private _viewer: RVViewer | null = null;
  private _modelHash = '';

  // ── Throttle ──
  private _lastMoveTime = 0;

  // ── Touch tap detection (distinguish tap from pan/orbit drag) ──
  private static readonly DRAG_THRESHOLD = 8; // px² — same as rv-viewer.ts
  private _pointerDownPos: { x: number; y: number } | null = null;
  private _pointerDownEvent: PointerEvent | null = null;

  // ── Bound event handlers (for cleanup) ──
  private _onPointerDown: ((e: PointerEvent) => void) | null = null;
  private _onPointerUp: ((e: PointerEvent) => void) | null = null;
  private _onPointerMove: ((e: PointerEvent) => void) | null = null;
  private _onKeyDown: ((e: KeyboardEvent) => void) | null = null;

  constructor() {
    this._worldRaycaster.firstHitOnly = true;
  }

  // ── Public getters / setters ──

  get measurementMode(): boolean { return this._measurementMode; }
  set measurementMode(v: boolean) {
    if (this._measurementMode === v) return;
    this._measurementMode = v;

    if (v) {
      this._state = 'waitingFirst';
      // Mutual exclusion: deactivate annotation mode
      if (this._viewer) {
        const annPlugin = this._viewer.getPlugin('annotations') as { annotationMode: boolean } | undefined;
        if (annPlugin?.annotationMode) annPlugin.annotationMode = false;
      }
      // Disable hover highlighting during measurement
      if (this._viewer) {
        this._viewer.raycastManager?.setEnabled?.(false);
        this._viewer.renderer.domElement.style.cursor = 'crosshair';
      }
    } else {
      this._state = 'idle';
      this._pendingPointA = null;
      this._pendingNormalA = null;
      this._pendingNormalB = null;
      this._renderer?.clearPreview();
      this._renderer?.clearStartMarker();
      this._renderer?.hideCursorDot();
      // Re-enable hover highlighting
      if (this._viewer) {
        this._viewer.raycastManager?.setEnabled?.(true);
        this._viewer.renderer.domElement.style.cursor = '';
      }
    }

    this._emitSnapshot();
  }

  get axisLock(): MeasureAxisLock { return this._axisLock; }
  set axisLock(v: MeasureAxisLock) {
    if (this._axisLock === v) return;
    this._axisLock = v;
    this._emitSnapshot();
  }

  // ── MeasurementPluginAPI ────────────────────────────────────────────

  addMeasurement(pointA: [number, number, number], pointB: [number, number, number]): Measurement {
    // Apply axis lock: project pointB so only the locked axis differs from pointA
    if (this._axisLock === 'x') {
      pointB = [pointB[0], pointA[1], pointA[2]];
    } else if (this._axisLock === 'y') {
      pointB = [pointA[0], pointB[1], pointA[2]];
    } else if (this._axisLock === 'z') {
      pointB = [pointA[0], pointA[1], pointB[2]];
    }

    const dx = pointB[0] - pointA[0];
    const dy = pointB[1] - pointA[1];
    const dz = pointB[2] - pointA[2];
    const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);

    const color = MEASUREMENT_COLORS[this._colorIndex % MEASUREMENT_COLORS.length];
    this._colorIndex++;

    // Save current camera view
    const cameraPos = this._viewer
      ? [this._viewer.camera.position.x, this._viewer.camera.position.y, this._viewer.camera.position.z] as [number, number, number]
      : undefined;
    const cameraTarget = this._viewer
      ? [this._viewer.controls.target.x, this._viewer.controls.target.y, this._viewer.controls.target.z] as [number, number, number]
      : undefined;

    const m: Measurement = {
      id: crypto.randomUUID?.() ?? _fallbackUUID(),
      name: `Measurement ${this._measurements.length + 1}`,
      pointA,
      pointB,
      normalA: this._pendingNormalA,
      normalB: this._pendingNormalB,
      distance,
      visible: true,
      color,
      timestamp: Date.now(),
      cameraPos,
      cameraTarget,
    };

    this._measurements.push(m);
    this._renderer?.addMeasurement(m);
    this._save();
    this._emitSnapshot();

    return m;
  }

  removeMeasurement(id: string): void {
    const idx = this._measurements.findIndex(m => m.id === id);
    if (idx < 0) return;
    this._measurements.splice(idx, 1);
    this._renderer?.removeMeasurement(id);
    this._save();
    this._emitSnapshot();
  }

  updateMeasurement(id: string, changes: Partial<Pick<Measurement, 'name' | 'color' | 'visible'>>): void {
    const m = this._measurements.find(m => m.id === id);
    if (!m) return;

    if (changes.name !== undefined) m.name = changes.name;
    if (changes.color !== undefined) m.color = changes.color;
    if (changes.visible !== undefined) m.visible = changes.visible;
    m.timestamp = Date.now();

    this._renderer?.updateMeasurement(m);
    this._save();
    this._emitSnapshot();
  }

  removeAll(): void {
    for (const m of [...this._measurements]) {
      this._renderer?.removeMeasurement(m.id);
    }
    this._measurements = [];
    this._save();
    this._emitSnapshot();
  }

  getMeasurements(): Measurement[] {
    return [...this._measurements];
  }

  focusMeasurement(id: string): void {
    const m = this._measurements.find(m => m.id === id);
    if (!m || !this._viewer) return;

    // Frame both endpoints: camera looks at midpoint, far enough to see both
    const pA = new Vector3(m.pointA[0], m.pointA[1], m.pointA[2]);
    const pB = new Vector3(m.pointB[0], m.pointB[1], m.pointB[2]);
    const mid = pA.clone().add(pB).multiplyScalar(0.5);
    const span = pA.distanceTo(pB);

    // Position camera at a distance that fits the full measurement
    // Use current camera direction but adjust distance
    const camDir = this._viewer.camera.position.clone().sub(this._viewer.controls.target).normalize();
    const viewDist = Math.max(span * 1.5, 0.5); // 1.5x span for comfortable framing
    const newPos = mid.clone().add(camDir.multiplyScalar(viewDist));

    this._viewer.camera.position.copy(newPos);
    this._viewer.controls.target.copy(mid);
    this._viewer.controls.update();
    this._viewer.markRenderDirty();
  }

  // ── RVViewerPlugin lifecycle ────────────────────────────────────────

  onModelLoaded(result: LoadResult, viewer: RVViewer): void {
    this._viewer = viewer;
    this._modelHash = this._computeModelHash(result);

    // Create renderer
    this._renderer = new MeasurementRenderer();
    this._renderer.attach(viewer.scene);
    this._renderer.setCamera(viewer.camera);
    this._renderer.setRenderer(viewer.renderer);

    // Enable measurement layer on camera
    viewer.camera.layers.enable(MEASUREMENT_LAYER);

    // Load from localStorage
    this._load();

    // Bind canvas events — use pointerup for measurement placement so that
    // touch pan/orbit gestures (drag) are not mistaken for measurement taps.
    const canvas = viewer.renderer.domElement;
    this._onPointerDown = (e: PointerEvent) => this._handlePointerDown(e);
    this._onPointerUp = (e: PointerEvent) => this._handlePointerUp(e);
    this._onPointerMove = (e: PointerEvent) => this._handlePointerMove(e);
    canvas.addEventListener('pointerdown', this._onPointerDown);
    canvas.addEventListener('pointerup', this._onPointerUp);
    canvas.addEventListener('pointermove', this._onPointerMove);

    // ESC handler on document (not canvas — canvas has no keyboard focus)
    this._onKeyDown = (e: KeyboardEvent) => this._handleKeyDown(e);
    document.addEventListener('keydown', this._onKeyDown);
  }

  onModelCleared(): void {
    this._cleanup();
  }

  onRender(): void {
    // Re-bind to the live active camera each frame so LOD scaling stays
    // correct after a perspective ↔ orthographic swap.
    if (this._renderer && this._viewer) this._renderer.setCamera(this._viewer.camera);
    this._renderer?.updateLOD();
    // Keep raycast hover disabled while in measurement mode
    // (OrbitControls 'end' event re-enables it — override every frame)
    if (this._measurementMode && this._viewer?.raycastManager?.enabled) {
      this._viewer.raycastManager.setEnabled(false);
    }
  }

  dispose(): void {
    this._cleanup();
  }

  // ── localStorage (exposed for tests) ─────────────────────────────────

  /** @internal Load measurements from localStorage (exposed for tests). */
  _load(): void {
    try {
      const key = LS_PREFIX + this._modelHash;
      const data = localStorage.getItem(key);
      if (!data) return;

      const parsed = JSON.parse(data) as Measurement[];
      if (!Array.isArray(parsed)) return;

      for (const m of parsed) {
        if (!m.id || !m.pointA || !m.pointB) continue;
        this._measurements.push(m);
        this._renderer?.addMeasurement(m);
      }
      this._emitSnapshot();
    } catch {
      // Corrupt localStorage — ignore
    }
  }

  // ── Private ─────────────────────────────────────────────────────────

  private _cleanup(): void {
    if (this._viewer) {
      const canvas = this._viewer.renderer.domElement;
      if (this._onPointerDown) canvas.removeEventListener('pointerdown', this._onPointerDown);
      if (this._onPointerUp) canvas.removeEventListener('pointerup', this._onPointerUp);
      if (this._onPointerMove) canvas.removeEventListener('pointermove', this._onPointerMove);
      canvas.style.cursor = '';
    }
    if (this._onKeyDown) {
      document.removeEventListener('keydown', this._onKeyDown);
    }
    this._renderer?.disposeAll();
    this._renderer = null;
    this._measurements = [];
    this._measurementMode = false;
    this._state = 'idle';
    this._pointerDownPos = null;
    this._pointerDownEvent = null;
    this._pendingPointA = null;
    this._pendingNormalA = null;
    this._viewer = null;
    this._emitSnapshot();
  }

  private _handlePointerDown(e: PointerEvent): void {
    if (!e.isPrimary) return;
    if (!this._viewer || !this._measurementMode) return;
    if (e.button !== 0) return;

    // Guard: don't measure when clicking on HMI panels
    const target = e.target as HTMLElement;
    if (target.closest?.('[data-ui-panel]')) return;

    // Record pointer-down position for tap-vs-drag detection on pointerup.
    // This prevents touch pan/orbit gestures from accidentally placing points.
    this._pointerDownPos = { x: e.clientX, y: e.clientY };
    this._pointerDownEvent = e;
  }

  private _handlePointerUp(e: PointerEvent): void {
    if (!e.isPrimary) return;
    if (!this._viewer || !this._measurementMode) return;
    if (e.button !== 0) return;

    // Only process if we have a matching pointerdown
    if (!this._pointerDownPos) return;

    // Tap detection: reject if pointer moved too far (user was panning/orbiting)
    const dx = e.clientX - this._pointerDownPos.x;
    const dy = e.clientY - this._pointerDownPos.y;
    this._pointerDownPos = null;
    const downEvt = this._pointerDownEvent;
    this._pointerDownEvent = null;
    if (dx * dx + dy * dy > MeasurementPlugin.DRAG_THRESHOLD * MeasurementPlugin.DRAG_THRESHOLD) return;

    // Raycast from the pointerup position (more accurate for touch)
    const hit = this._worldRaycast(e) ?? (downEvt ? this._worldRaycast(downEvt) : null);
    if (!hit) return;

    // Prevent viewer from selecting objects on this click:
    // Clear _pointerDownPos so the viewer's pointerup handler skips selection
    (this._viewer as any)._pointerDownPos = null;

    if (this._state === 'waitingFirst') {
      this._pendingPointA = [hit.point.x, hit.point.y, hit.point.z];
      this._pendingNormalA = hit.normal ? [hit.normal.x, hit.normal.y, hit.normal.z] : null;
      this._state = 'waitingSecond';
      // Show start-point marker immediately for visual feedback
      this._renderer?.showStartMarker(this._pendingPointA, DEFAULT_COLOR, this._pendingNormalA);
      this._viewer?.markRenderDirty();
    } else if (this._state === 'waitingSecond' && this._pendingPointA) {
      const pointB: [number, number, number] = [hit.point.x, hit.point.y, hit.point.z];
      const normalB: [number, number, number] | null = hit.normal
        ? [hit.normal.x, hit.normal.y, hit.normal.z] : null;
      this._pendingNormalB = normalB;
      this.addMeasurement(this._pendingPointA, pointB);
      this._renderer?.clearPreview();
      this._renderer?.clearStartMarker();
      // Reset for next measurement
      this._pendingPointA = null;
      this._pendingNormalA = null;
      this._state = 'waitingFirst';
    }
  }

  private _handlePointerMove(e: PointerEvent): void {
    if (!e.isPrimary) return;
    if (!this._viewer || !this._measurementMode) return;

    // Cancel pending tap if pointer moved too far (user is panning/orbiting)
    if (this._pointerDownPos) {
      const dx = e.clientX - this._pointerDownPos.x;
      const dy = e.clientY - this._pointerDownPos.y;
      if (dx * dx + dy * dy > MeasurementPlugin.DRAG_THRESHOLD * MeasurementPlugin.DRAG_THRESHOLD) {
        this._pointerDownPos = null;
        this._pointerDownEvent = null;
      }
    }

    const now = performance.now();
    if (now - this._lastMoveTime < 16) return; // ~60fps max
    this._lastMoveTime = now;

    const hit = this._worldRaycast(e);
    if (hit) {
      let cursor: [number, number, number] = [hit.point.x, hit.point.y, hit.point.z];
      const normal: [number, number, number] | null = hit.normal
        ? [hit.normal.x, hit.normal.y, hit.normal.z] : null;
      // Show cursor indicator on surface (ring oriented to normal)
      this._renderer?.showCursorDot(cursor, DEFAULT_COLOR, normal);

      // Show preview line if we have a first point
      if (this._state === 'waitingSecond' && this._pendingPointA) {
        // Apply axis lock to preview — project cursor onto locked axis from pointA
        const pA = this._pendingPointA;
        let projected = cursor;
        if (this._axisLock === 'x') projected = [cursor[0], pA[1], pA[2]];
        else if (this._axisLock === 'y') projected = [pA[0], cursor[1], pA[2]];
        else if (this._axisLock === 'z') projected = [pA[0], pA[1], cursor[2]];

        this._renderer?.updatePreview(this._pendingPointA, projected, DEFAULT_COLOR);
        // Show projected destination point when axis-locked
        if (this._axisLock !== 'none') {
          this._renderer?.showProjectedPoint(projected, DEFAULT_COLOR);
        } else {
          this._renderer?.hideProjectedPoint();
        }
      }
      this._viewer.markRenderDirty();
    } else {
      this._renderer?.hideCursorDot();
      this._viewer.markRenderDirty();
    }
  }

  private _handleKeyDown(e: KeyboardEvent): void {
    if (e.key !== 'Escape') return;
    if (!this._measurementMode) return;

    if (this._state === 'waitingSecond') {
      // Cancel current measurement, go back to waiting for first point
      this._pendingPointA = null;
      this._pendingNormalA = null;
      this._pendingNormalB = null;
      this._renderer?.clearPreview();
      this._renderer?.clearStartMarker();
      this._state = 'waitingFirst';
      this._viewer?.markRenderDirty();
    } else {
      // Deactivate measurement mode
      this.measurementMode = false;
      const lpm = this._viewer?.leftPanelManager;
      lpm?.close('measurements');
    }
  }

  private _worldRaycast(e: PointerEvent): { point: Vector3; normal: Vector3 | null } | null {
    if (!this._viewer) return null;

    const canvas = this._viewer.renderer.domElement;
    pointerToNDC(e.clientX, e.clientY, canvas, this._pointer);

    this._worldRaycaster.setFromCamera(this._pointer, this._viewer.camera);
    this._worldRaycaster.layers.set(0);
    const intersects = this._worldRaycaster.intersectObjects(this._viewer.scene.children, true);

    // First mesh hit (skipping our own measurement overlays + merged static
    // proxies that wouldn't survive a click anyway).
    //
    // Gaussian Splats are intentionally NOT pickable for measurement:
    // splats are alpha-blended volumetric primitives without a well-defined
    // surface, so any sphere/ellipsoid approximation has cm-level depth
    // jitter. We render them as visual backdrop, but measurements happen
    // against real triangulated geometry only. If a splat sits in front of
    // a mesh the user wanted to measure, they need to crop or hide the
    // splat first. Re-enable splat picking only via a GPU depth-pre-pass
    // (cumulative-alpha 0.5) — see castRayAtSplatMesh JSDoc.
    for (const hit of intersects) {
      if (!hit.object.visible) continue;
      if (this._isMeasurementObject(hit.object)) continue;
      return {
        point: hit.point,
        normal: hit.face?.normal?.clone().transformDirection(hit.object.matrixWorld) ?? null,
      };
    }
    return null;
  }

  private _isMeasurementObject(obj: Object3D): boolean {
    let current: Object3D | null = obj;
    while (current) {
      if (current === this._renderer?.group) return true;
      current = current.parent;
    }
    return false;
  }

  // ── Persistence ──────────────────────────────────────────────────────

  private _computeModelHash(result: LoadResult): string {
    const names = result.drives.map(d => d.name).sort().join(',');
    let hash = 0;
    for (let i = 0; i < names.length; i++) {
      hash = ((hash << 5) - hash + names.charCodeAt(i)) | 0;
    }
    return Math.abs(hash).toString(36);
  }

  private _save(): void {
    try {
      const key = LS_PREFIX + this._modelHash;
      const data = JSON.stringify(this._measurements);
      localStorage.setItem(key, data);
    } catch (e) {
      // QuotaExceededError — gracefully ignore
      if (e instanceof DOMException && e.name === 'QuotaExceededError') {
        console.warn('[MeasurementPlugin] localStorage quota exceeded, measurements not saved');
      }
    }
  }

  // ── Snapshot emission ───────────────────────────────────────────────

  private _emitSnapshot(): void {
    _store.set({
      measurements: [...this._measurements],
      measurementMode: this._measurementMode,
      axisLock: this._axisLock,
    });
    this._viewer?.markRenderDirty();
  }
}

// ── Utilities ─────────────────────────────────────────────────────────

function _fallbackUUID(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
