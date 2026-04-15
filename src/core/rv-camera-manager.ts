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
  Box3,
  Mesh,
  Object3D,
} from 'three';
import type { Renderer } from 'three/webgpu';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { ProjectionType } from './hmi/visual-settings-store';
import { INSPECTOR_PANEL_WIDTH } from './hmi/layout-constants';
import type { RvExtrasEditorPlugin } from './hmi/rv-extras-editor';
import type { LeftPanelManager } from './hmi/left-panel-manager';

/** Check if property inspector is in detached (floating) mode. */
function isInspectorDetached(): boolean {
  try { return localStorage.getItem('rv-inspector-detached') === 'true'; }
  catch { return false; }
}

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
}

/**
 * CameraManager handles perspective/orthographic switching,
 * smooth camera animations, FOV, and viewport offset computation.
 */
export class CameraManager {
  private state: ViewerCameraState;
  cameraAnim: CameraAnimation | null = null;

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
  animateCameraTo(position: Vector3, target: Vector3, duration = 0.6): void {
    const xr = (this.state.renderer as unknown as Record<string, unknown>).xr as Record<string, unknown> | undefined;
    if (xr?.isPresenting) return;
    this.cameraAnim = {
      startPos: this.state._activeCamera.position.clone(),
      endPos: position.clone(),
      startTgt: this.state.controls.target.clone(),
      endTgt: target.clone(),
      elapsed: 0,
      duration,
    };
  }

  /** Advance camera animation by frame delta. */
  tickCameraAnimation(dtSec: number): void {
    if (!this.cameraAnim) return;
    this.cameraAnim.elapsed += dtSec;
    const t = Math.min(this.cameraAnim.elapsed / this.cameraAnim.duration, 1);
    const e = 1 - Math.pow(1 - t, 3); // Smooth ease-out (cubic)

    this.state._activeCamera.position.lerpVectors(this.cameraAnim.startPos, this.cameraAnim.endPos, e);
    this.state.controls.target.lerpVectors(this.cameraAnim.startTgt, this.cameraAnim.endTgt, e);

    if (t >= 1) this.cameraAnim = null;
  }

  // ─── Viewport Offset ──────────────────────────────────────────────

  /** Compute current viewport offset from open panels. */
  getCurrentViewportOffset(): ViewportOffset | undefined {
    let left = 0;

    const editorPlugin = this.state.getPlugin<RvExtrasEditorPlugin>('rv-extras-editor');
    if (editorPlugin) {
      const snapshot = editorPlugin.getSnapshot();
      if (snapshot.panelOpen) {
        // Only count inspector width when docked (not detached as floating window)
        const inspectorDocked = snapshot.selectedNodePath && snapshot.showInspector
          && !isInspectorDetached();
        left = snapshot.panelWidth + (inspectorDocked ? INSPECTOR_PANEL_WIDTH : 0);
      }
    }

    if (left === 0 && this.state.leftPanelManager.activePanelWidth > 0) {
      left = this.state.leftPanelManager.activePanelWidth;
    }

    return left > 0 ? { left } : undefined;
  }

  /**
   * Shift a world-space target point so the focused object appears centered
   * in the visible viewport area (accounting for panels covering the edges).
   */
  applyViewportOffset(center: Vector3, dist: number, offset?: ViewportOffset): Vector3 {
    if (!offset) return center;
    const left = offset.left ?? 0;
    const right = offset.right ?? 0;
    const top = offset.top ?? 0;
    const bottom = offset.bottom ?? 0;
    if (left === 0 && right === 0 && top === 0 && bottom === 0) return center;

    const canvas = this.state.renderer.domElement;
    const canvasW = canvas.clientWidth || 1;
    const canvasH = canvas.clientHeight || 1;

    const horizontalFrac = (left - right) / canvasW;
    const verticalFrac = (bottom - top) / canvasH;

    if (Math.abs(horizontalFrac) < 0.001 && Math.abs(verticalFrac) < 0.001) return center;

    const fovRad = this.state.perspCamera.fov * (Math.PI / 180);
    const halfH = dist * Math.tan(fovRad / 2);
    const halfW = halfH * this.state.perspCamera.aspect;

    const camRight = new Vector3();
    const camUp = new Vector3();
    this.state._activeCamera.getWorldDirection(new Vector3());
    camRight.setFromMatrixColumn(this.state._activeCamera.matrixWorld, 0).normalize();
    camUp.setFromMatrixColumn(this.state._activeCamera.matrixWorld, 1).normalize();

    // Negate: shift the orbit target AWAY from the panels so the object
    // appears centered in the visible (unobscured) viewport area.
    // E.g. left panel open → shift target LEFT → object renders to the RIGHT.
    const adjusted = center.clone();
    adjusted.addScaledVector(camRight, -horizontalFrac * halfW);
    adjusted.addScaledVector(camUp, -verticalFrac * halfH);
    return adjusted;
  }

  // ─── Focus & Fit ──────────────────────────────────────────────────

  /** Compute bounding box for a set of nodes. */
  computeNodeBounds(nodes: Object3D[]): Box3 {
    const box = new Box3();
    for (const node of nodes) {
      node.updateWorldMatrix(true, true);
      node.traverse((child) => {
        const m = child as Mesh;
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
