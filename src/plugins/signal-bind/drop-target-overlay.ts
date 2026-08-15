// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { Raycaster, Vector3, type Mesh, type Object3D } from 'three';
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
  /**
   * NDC after `onRender` — `Vector3.project()` mutates in place, so despite the
   * name this holds clip coordinates for most of its life. The true world
   * position lives in {@link OverlayTarget.worldPos}, which is why the two are
   * separate fields at all (plan-422, SOL-R2 F2: an occlusion ray built from
   * this vector would be cast from the camera into normalised device space).
   */
  world: Vector3;
  /** Untouched world position, refreshed alongside `world` each frame. */
  worldPos: Vector3;
  screen: ScreenPoint;
}

/**
 * Depth tolerance (metres) for the occlusion ray (plan-422 F7).
 *
 * A badge sits ON its object's surface, so the ray to it hits that surface at
 * essentially the badge's own distance. Without slack every target would call
 * itself occluded by the thing it is attached to.
 */
const OCCLUSION_EPSILON_M = 0.02;

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
  // Occlusion check (plan-422 F7) — all pre-allocated: the check runs on a
  // candidate switch during an active drag and must not add GC pressure there.
  private readonly _occlusionRay = new Raycaster();
  private readonly _rayDirection = new Vector3();
  private readonly _rayHits: import('three').Intersection[] = [];
  private _pickMeshCache: readonly Mesh[] = [];
  private _pickMeshSource: object | null = null;
  /** Last screen-space winner and what the occlusion check made of it. */
  private _lastRawWinner: OverlayTarget | null = null;
  private _lastResolved: OverlayTarget | null = null;

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
      target.compatible.node.getWorldPosition(target.worldPos);
      target.world.copy(target.worldPos);
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
    this._setNearest(this._resolveOcclusion(nearest));
  }

  /**
   * Prefer an UNOCCLUDED candidate over a nearer one hidden behind geometry
   * (plan-422 F7). Returns `winner` unchanged whenever it cannot do better.
   *
   * Screen distance alone made the magnet reach through walls: Werner's report
   * that "the drop target at the machine is still called Conveyor Belt" is the
   * conveyor's badge, physically behind the machine, winning on pixels because
   * `nearestCompatibleTarget()` is a pure 2D function with no notion of depth.
   * That function STAYS pure — the fix belongs here, where the camera, the
   * candidates and the scene's pick geometry already are.
   *
   * The budget is the candidate change, and the comparison that enforces it has
   * to be against the RAW screen winner, not against `_nearest`. Those two
   * differ precisely when the check did its job — resolving A to B leaves
   * `_nearest = B` while the screen keeps nominating A, so comparing them would
   * re-run the rays on every single frame of a stationary drag. The last raw
   * winner and its verdict are therefore remembered as a pair.
   *
   * Fail-open throughout. Missing pick geometry, an empty target list or a
   * scene where every candidate is occluded all keep the screen-nearest winner:
   * a drag that suddenly has no target at all is worse than one aimed slightly
   * wrong, and the user can always see where the marker sits.
   */
  private _resolveOcclusion(winner: OverlayTarget | null): OverlayTarget | null {
    if (!winner) { this._lastRawWinner = null; this._lastResolved = null; return null; }
    if (winner === this._lastRawWinner) return this._lastResolved;
    this._lastRawWinner = winner;
    this._lastResolved = this._computeUnoccluded(winner);
    return this._lastResolved;
  }

  /** The occlusion decision itself, without the per-frame budget guard. */
  private _computeUnoccluded(winner: OverlayTarget): OverlayTarget {
    const meshes = this._pickMeshes();
    if (meshes.length === 0) return winner;
    if (!this._isOccluded(winner, meshes)) return winner;

    // The winner is behind something. Take the nearest candidate that is not —
    // screen order again, so the choice stays the one the pointer implies.
    let best: OverlayTarget | null = null;
    let bestDistanceSq = NEAREST_MAGNET_RADIUS_PX * NEAREST_MAGNET_RADIUS_PX;
    for (const candidate of this._targets) {
      if (candidate === winner) continue;
      if (!isInsideNdcFrustum(candidate.world)) continue;
      const dx = candidate.screen.x - this._cursorX;
      const dy = candidate.screen.y - this._cursorY;
      const distanceSq = dx * dx + dy * dy;
      if (distanceSq > bestDistanceSq) continue;
      if (this._isOccluded(candidate, meshes)) continue;
      bestDistanceSq = distanceSq;
      best = candidate;
    }
    // All occluded ⇒ keep the original. The drag is never left aimless.
    return best ?? winner;
  }

  /**
   * The scene's pickable meshes, read-only.
   *
   * `raycastManager.raycastGeometry` is a `RaycastGeometrySet`, not an
   * `Object3D` — it cannot be handed to a raycaster directly (SOL-R2 F2). The
   * raycastable things inside it are the merged static mesh and one merged mesh
   * per kinematic group; both parts are optional, and a scene may have neither.
   *
   * Reused across the whole drag: the array is rebuilt only when the set
   * identity changes, so a candidate switch does not allocate.
   */
  private _pickMeshes(): readonly Mesh[] {
    const set = this._viewer.raycastManager?.raycastGeometry ?? null;
    if (!set) { this._pickMeshCache = []; this._pickMeshSource = null; return this._pickMeshCache; }
    if (set === this._pickMeshSource) return this._pickMeshCache;
    const meshes: Mesh[] = [];
    if (set.staticGroup?.mesh) meshes.push(set.staticGroup.mesh);
    for (const group of set.kinematicGroups.values()) {
      if (group?.mesh) meshes.push(group.mesh);
    }
    this._pickMeshSource = set;
    this._pickMeshCache = meshes;
    return meshes;
  }

  /** Is pickable geometry sitting between the camera and this candidate? */
  private _isOccluded(target: OverlayTarget, meshes: readonly Mesh[]): boolean {
    const camera = this._viewer.camera;
    const origin = camera.position;
    const direction = this._rayDirection.copy(target.worldPos).sub(origin);
    const distance = direction.length();
    if (distance <= OCCLUSION_EPSILON_M) return false;
    direction.divideScalar(distance);

    const raycaster = this._occlusionRay;
    raycaster.set(origin, direction);
    raycaster.near = 0;
    raycaster.far = distance - OCCLUSION_EPSILON_M;
    if (raycaster.far <= 0) return false;
    // firstHitOnly: the three-mesh-bvh fast path — we only need "is there
    // anything", never the full sorted hit list.
    (raycaster as unknown as { firstHitOnly?: boolean }).firstHitOnly = true;

    for (const mesh of meshes) {
      this._rayHits.length = 0;
      try {
        mesh.raycast(raycaster, this._rayHits);
      } catch {
        // A group mid-refit is not a reason to lose the drag.
        continue;
      }
      if (this._rayHits.length > 0) { this._rayHits.length = 0; return true; }
    }
    return false;
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
        worldPos: new Vector3(),
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
    // Drop the pick-mesh reference: a model switch between drags must not keep
    // the previous scene's merged BVH meshes alive through this controller.
    this._pickMeshCache = [];
    this._pickMeshSource = null;
    this._lastRawWinner = null;
    this._lastResolved = null;
    if (hadVisuals) this._viewer.markRenderDirty();
  }
}
