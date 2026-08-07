// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { Vector3, type Object3D } from 'three';
import type { RVViewer } from '../../core/rv-viewer';
import type { GizmoHandle } from '../../core/engine/rv-gizmo-manager';
import { applyScreenSpaceScale } from '../../core/engine/rv-screen-space-scale';
import { ndcToScreen, type ScreenPoint } from '../../core/engine/rv-ndc';
import {
  getSignalDragPayload,
  getSignalDragPhase,
  getSignalDragPosition,
  subscribeSignalDrag,
  subscribeSignalDragPos,
} from '../../core/hmi/signal-drag-store';
import { enumerateCompatibleTargets, type CompatibleTarget } from './compatible-targets';
import { makePortMarkerTexture } from './port-marker-texture';
import type { SignalBindTarget } from './signal-bind-target';

export const MAX_HIGHLIGHTS = 50;
const INSTRUMENT_BLUE = 0x4fc3f7;
const IDLE_MARKER_WORLD_SIZE_M = 0.12;
const IDLE_MARKER_PX = 28;
const ACTIVE_MARKER_WORLD_SIZE_M = 0.18;
const ACTIVE_MARKER_PX = 40;
export const NEAREST_MAGNET_RADIUS_PX = 42;
const IDLE_RENDER_ORDER = 2100;
const ACTIVE_RENDER_ORDER = 2101;
const BOX_RENDER_ORDER = 2099;

interface OverlayTarget {
  compatible: CompatibleTarget;
  idleHandle: GizmoHandle;
  world: Vector3;
  screen: ScreenPoint;
}

export interface NearestPortCandidate {
  readonly screen: ScreenPoint;
  readonly world: Vector3;
}

/** Full clip-volume test required before a projected target can be selected. */
export function isInsideNdcFrustum(ndc: Vector3): boolean {
  return ndc.x >= -1 && ndc.x <= 1
    && ndc.y >= -1 && ndc.y <= 1
    && ndc.z > -1 && ndc.z < 1;
}

/** Allocation-free screen-space nearest lookup within the magnetic hit radius. */
export function nearestCompatibleTarget<T extends NearestPortCandidate>(
  candidates: readonly T[],
  cursorX: number,
  cursorY: number,
  radiusPx = NEAREST_MAGNET_RADIUS_PX,
): T | null {
  const maxDistanceSq = radiusPx * radiusPx;
  let best: T | null = null;
  let bestDistanceSq = maxDistanceSq;
  for (const candidate of candidates) {
    if (!isInsideNdcFrustum(candidate.world)) continue;
    const dx = candidate.screen.x - cursorX;
    const dy = candidate.screen.y - cursorY;
    const distanceSq = dx * dx + dy * dy;
    if (distanceSq <= bestDistanceSq) {
      bestDistanceSq = distanceSq;
      best = candidate;
    }
  }
  return best;
}

/** Visualizes every compatible 3D target while a signal chip is dragged. */
export class DropTargetOverlayController {
  private readonly _viewer: RVViewer;
  private _backend: 'three' | 'omniverse';
  private _unsubPhase: (() => void) | null = null;
  private _unsubPos: (() => void) | null = null;
  private readonly _targets: OverlayTarget[] = [];
  private readonly _boxHandles: GizmoHandle[] = [];
  private _activeHandle: GizmoHandle | null = null;
  private _nearest: OverlayTarget | null = null;
  private _cursorX = 0;
  private _cursorY = 0;

  constructor(viewer: RVViewer) {
    this._viewer = viewer;
    this._backend = viewer.renderBackend;
    this._unsubPhase = subscribeSignalDrag(() => this._onPhaseChange());
    this._onPhaseChange();
  }

  /** Per-frame world projection, nearest selection and marker scaling. */
  onRender(): void {
    if (getSignalDragPhase() !== 'dragging' || this._backend !== 'three') return;
    const camera = this._viewer.camera;
    const renderer = this._viewer.renderer;
    if (!camera || !renderer) return;
    const rect = renderer.domElement.getBoundingClientRect();
    const canvasHeight = renderer.domElement.clientHeight || rect.height;
    for (const target of this._targets) {
      if (target.idleHandle.root.visible) {
        applyScreenSpaceScale(target.idleHandle.root, IDLE_MARKER_PX, camera, canvasHeight);
      }
      target.compatible.node.getWorldPosition(target.world);
      target.world.project(camera);
      if (isInsideNdcFrustum(target.world)) {
        ndcToScreen(target.world.x, target.world.y, rect, target.screen);
      }
    }
    if (this._activeHandle?.root.visible) {
      applyScreenSpaceScale(this._activeHandle.root, ACTIVE_MARKER_PX, camera, canvasHeight);
    }

    const insideCanvas = this._cursorX >= rect.left && this._cursorX <= rect.left + rect.width
      && this._cursorY >= rect.top && this._cursorY <= rect.top + rect.height;
    const hit = insideCanvas ? document.elementFromPoint(this._cursorX, this._cursorY) : null;
    const overCanvas = insideCanvas && (hit === null || hit === renderer.domElement || renderer.domElement.contains(hit));
    const nearest = overCanvas
      ? nearestCompatibleTarget(this._targets, this._cursorX, this._cursorY)
      : null;
    this._setNearest(nearest);
  }

  onRenderBackendChanged(backend: 'three' | 'omniverse'): void {
    this._backend = backend;
    if (backend === 'three') this._onPhaseChange();
    else this._teardown();
  }

  dispose(): void {
    this._unsubPhase?.();
    this._unsubPhase = null;
    this._teardown();
  }

  /** Test diagnostics: number of compatible target sprites. */
  get targetCount(): number { return this._targets.length; }
  /** Test diagnostics: number of capped box highlights. */
  get boxHighlightCount(): number { return this._boxHandles.length; }
  /** Test diagnostics: stable id of the active nearest target. */
  get nearestTargetId(): string | null { return this._nearest?.compatible.id ?? null; }
  /** The magnet-selected bind target the active marker currently points at. */
  get nearestBindTarget(): SignalBindTarget | null { return this._nearest?.compatible.target ?? null; }
  /** Test diagnostics: the live active-marker handle. */
  get activeMarkerHandle(): GizmoHandle | null { return this._activeHandle; }
  /** Latest pointer position copied by the hot-path subscriber. */
  get cursorPosition(): Readonly<{ x: number; y: number }> {
    return { x: this._cursorX, y: this._cursorY };
  }

  private _onPhaseChange(): void {
    if (getSignalDragPhase() !== 'dragging') {
      this._teardown();
      return;
    }

    // A backend switch or immediate follow-up drag may call this with stale
    // visuals still present. Teardown is idempotent and makes rebuild atomic.
    this._teardown();
    if (this._backend !== 'three' || !this._viewer.signalBindingManager) return;
    const payload = getSignalDragPayload();
    if (!payload) return;

    const p = getSignalDragPosition();
    this._cursorX = p.x;
    this._cursorY = p.y;
    this._unsubPos = subscribeSignalDragPos((x, y) => {
      // Hot path: copy two numbers only. Projection and all Three.js work run
      // from onRender, naturally coalesced by the viewer's animation frame.
      this._cursorX = x;
      this._cursorY = y;
    });
    this._build(enumerateCompatibleTargets(this._viewer, payload));
  }

  private _build(compatibleTargets: CompatibleTarget[]): void {
    const texture = makePortMarkerTexture('idle');
    for (const compatible of compatibleTargets) {
      const idleHandle = this._viewer.gizmoManager.create(compatible.node, {
        shape: 'sprite',
        color: INSTRUMENT_BLUE,
        opacity: 0.62,
        spriteTexture: texture,
        worldSize: IDLE_MARKER_WORLD_SIZE_M,
        attachToNode: true,
        excludeFromRaycast: true,
        depthTest: false,
        renderOrder: IDLE_RENDER_ORDER,
        category: 'signals',
      });
      this._targets.push({
        compatible,
        idleHandle,
        world: new Vector3(),
        screen: { x: 0, y: 0 },
      });
    }

    // The box cap is independent from the uncapped sprite/nearest set. Pick
    // camera-nearest targets once at build time; attached boxes follow motion.
    const cameraPosition = this._viewer.camera.position;
    const nearestToCamera = [...this._targets];
    for (const target of nearestToCamera) target.compatible.node.getWorldPosition(target.world);
    nearestToCamera.sort((a, b) =>
      a.world.distanceToSquared(cameraPosition) - b.world.distanceToSquared(cameraPosition));
    for (let i = 0; i < Math.min(MAX_HIGHLIGHTS, nearestToCamera.length); i++) {
      this._boxHandles.push(this._viewer.gizmoManager.create(nearestToCamera[i].compatible.node, {
        shape: 'box',
        color: INSTRUMENT_BLUE,
        opacity: 0.3,
        attachToNode: true,
        excludeFromRaycast: true,
        depthTest: false,
        renderOrder: BOX_RENDER_ORDER,
        category: 'signals',
      }));
    }
    this._viewer.markRenderDirty();
  }

  private _setNearest(nearest: OverlayTarget | null): void {
    if (nearest === this._nearest) return;
    this._activeHandle?.dispose();
    this._activeHandle = null;
    this._nearest = nearest;
    if (nearest) {
      this._activeHandle = this._viewer.gizmoManager.create(nearest.compatible.node, {
        shape: 'sprite',
        color: 0xffffff,
        opacity: 1,
        spriteTexture: makePortMarkerTexture('active'),
        worldSize: ACTIVE_MARKER_WORLD_SIZE_M,
        attachToNode: true,
        excludeFromRaycast: true,
        depthTest: false,
        renderOrder: ACTIVE_RENDER_ORDER,
        category: 'signals',
      });
    }
    this._viewer.markRenderDirty();
  }

  private _teardown(): void {
    this._unsubPos?.();
    this._unsubPos = null;
    const hadVisuals = this._targets.length > 0 || this._boxHandles.length > 0 || this._activeHandle !== null;
    this._activeHandle?.dispose();
    this._activeHandle = null;
    this._nearest = null;
    for (const target of this._targets) target.idleHandle.dispose();
    this._targets.length = 0;
    for (const handle of this._boxHandles) handle.dispose();
    this._boxHandles.length = 0;
    if (hadVisuals) this._viewer.markRenderDirty();
  }
}
