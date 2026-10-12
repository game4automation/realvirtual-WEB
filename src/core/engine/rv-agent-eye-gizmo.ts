// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-agent-eye-gizmo.ts — what the human sees of the agent's camera body.
 *
 * A short frustum (0.18 m deep, aspect and FOV of the agent lens) drawn as a
 * wireframe plus translucent faces, sitting on {@link AGENT_EYE_LAYER}. It is
 * the ONLY affordance for the double-click attach, so it has to be visible,
 * small and un-clickable in the ordinary sense: `userData._agentEyeOverlay`
 * keeps it out of `RaycastManager` picks (D-A4), and the attach runs on its own
 * screen-space hit test against {@link AgentEyeGizmo.screenRect}.
 *
 * Two rules earned their own note:
 *   - Both vertex buffers are written IN PLACE on every lens change. Rebuilding
 *     the geometry per `setLens` would allocate and leak (S6).
 *   - `dispose()` is hand-written and must NEVER be replaced by
 *     `disposeSubtree`: that helper has no `isMesh` guard, so a geometry shared
 *     with another overlay could be taken down with it.
 */

import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  Group,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  Quaternion,
  Vector3,
  type Camera,
} from 'three';
import { AGENT_EYE_LAYER } from './rv-group-registry';
import type { AgentPose } from './rv-agent-eye';

/** Depth of the drawn cone in metres — long enough to read, short enough to stay out of the way. */
export const GIZMO_DEPTH_M = 0.18;
/** Near-plane rectangle of the drawn cone, metres. */
export const GIZMO_NEAR_M = 0.015;
/** Default colour = the HMI accent (`theme.palette.primary.main`), inlined because core never imports the React theme. */
export const GIZMO_ACCENT = '#4fc3f7';
/** Opacity of the shaded frustum faces — reads as a volume without hiding the machine behind it. */
const FACE_OPACITY = 0.3;

/** 16 edges × 2 endpoints × 3 components. */
const VERTEX_COUNT = 32;

/** Face vertices: the 4 near corners, then the 4 far corners. */
const FACE_VERTEX_COUNT = 8;

/** Triangles over {@link FACE_VERTEX_COUNT}: 4 side quads plus the near and far caps. */
const FACE_INDICES = new Uint16Array([
  0, 1, 5, 0, 5, 4,
  1, 2, 6, 1, 6, 5,
  2, 3, 7, 2, 7, 6,
  3, 0, 4, 3, 4, 7,
  0, 2, 1, 0, 3, 2,
  4, 5, 6, 4, 6, 7,
]);

/**
 * Fill `dst` (96 floats) with the 16 wireframe edges of the cone in camera-local
 * space. Pure so the geometry update stays trivially testable.
 *
 * Edge groups: near rect, far rect, near→far connectors, and apex→near spokes.
 * In orthographic mode there IS no apex, so the spokes are collapsed onto the
 * near rectangle (drawn twice, invisible) rather than shrinking the buffer.
 */
export function writeFrustumEdges(
  dst: Float32Array, near: number[], far: number[], projection: AgentPose['projection'],
): void {
  let i = 0;
  const push = (src: number[], c: number): void => {
    dst[i++] = src[c * 3]; dst[i++] = src[c * 3 + 1]; dst[i++] = src[c * 3 + 2];
  };
  const rect = (src: number[]): void => {
    for (let c = 0; c < 4; c++) { push(src, c); push(src, (c + 1) % 4); }
  };
  rect(near);
  rect(far);
  for (let c = 0; c < 4; c++) { push(near, c); push(far, c); }
  if (projection === 'orthographic') {
    rect(near);
  } else {
    for (let c = 0; c < 4; c++) {
      dst[i++] = 0; dst[i++] = 0; dst[i++] = 0;     // apex = the eye itself
      push(near, c);
    }
  }
}

/**
 * Fill `dst` (24 floats) with the 8 face corners of the cone in camera-local
 * space: the 4 near corners first, then the 4 far ones, in the order
 * {@link FACE_INDICES} expects. Pure, for the same reason as
 * {@link writeFrustumEdges}.
 */
export function writeFrustumFaces(dst: Float32Array, near: number[], far: number[]): void {
  for (let c = 0; c < 12; c++) dst[c] = near[c];
  for (let c = 0; c < 12; c++) dst[12 + c] = far[c];
}

export interface AgentEyeGizmoOptions {
  /** Cone/label colour. Defaults to {@link GIZMO_ACCENT}. */
  color?: string;
}

/** The scene object drawing the agent's camera body. */
export class AgentEyeGizmo {
  readonly group = new Group();

  private readonly _geometry = new BufferGeometry();
  private readonly _positions = new Float32Array(VERTEX_COUNT * 3);
  private readonly _faceGeometry = new BufferGeometry();
  private readonly _facePositions = new Float32Array(FACE_VERTEX_COUNT * 3);
  private readonly _lineMat: LineBasicMaterial;
  private readonly _faceMat: MeshBasicMaterial;
  private readonly _lines: LineSegments;
  private readonly _faces: Mesh;

  private _showSetting = true;
  private _attached = false;

  // Pre-allocated: `update` runs per pose change and, while attached, per frame.
  private readonly _near: number[] = new Array<number>(12).fill(0);
  private readonly _far: number[] = new Array<number>(12).fill(0);
  private readonly _tmpPos = new Vector3();
  private readonly _tmpTarget = new Vector3();
  private readonly _tmpUp = new Vector3(0, 1, 0);
  private readonly _tmpMat = new Matrix4();
  private readonly _tmpQuat = new Quaternion();
  private readonly _tmpProject = new Vector3();

  constructor(opts: AgentEyeGizmoOptions = {}) {
    const color = opts.color ?? GIZMO_ACCENT;
    this._geometry.setAttribute('position', new BufferAttribute(this._positions, 3));

    // depthTest stays ON: the cone is a thing IN the scene and should read as
    // standing behind a machine, not floating over the whole plant.
    this._lineMat = new LineBasicMaterial({
      color: new Color(color), depthTest: true, transparent: true, opacity: 0.9,
    });
    this._lines = new LineSegments(this._geometry, this._lineMat);
    this._lines.frustumCulled = false;   // the buffer is rewritten, not the bounds

    // depthWrite stays OFF so the translucent hull never punches a hole into
    // whatever is drawn behind it.
    this._faceGeometry.setAttribute('position', new BufferAttribute(this._facePositions, 3));
    this._faceGeometry.setIndex(new BufferAttribute(FACE_INDICES, 1));
    this._faceMat = new MeshBasicMaterial({
      color: new Color(color), transparent: true, opacity: FACE_OPACITY,
      depthTest: true, depthWrite: false, side: DoubleSide,
    });
    this._faces = new Mesh(this._faceGeometry, this._faceMat);
    this._faces.frustumCulled = false;

    this.group.name = 'AgentEyeGizmo';
    this.group.add(this._lines, this._faces);
    this.group.renderOrder = 10;
    // Layer + pick-exclude on EVERY child (D-A4) — a child left on layer 0
    // would show up in the agent's own renders.
    this.group.traverse((o) => {
      o.layers.set(AGENT_EYE_LAYER);
      o.userData._agentEyeOverlay = true;
    });
    this.group.visible = false;   // nothing to show before the first spawn
  }

  /** The Settings ▸ Visual ▸ "Show AI eye" toggle. */
  setShow(show: boolean): void {
    this._showSetting = show;
    this._applyVisibility();
  }

  /** Hide while the viewport rides the body — you are inside the cone. */
  setAttached(attached: boolean): void {
    this._attached = attached;
    this._applyVisibility();
  }

  /** Whether the cone is currently drawn (also the attach gate — no cone, no double-click). */
  get visible(): boolean { return this.group.visible; }

  private _applyVisibility(): void {
    this.group.visible = this._showSetting && !this._attached;
  }

  /**
   * Move and reshape the cone to `pose`. Allocation-free: the transform is
   * composed into pre-allocated temps and the 96 vertex floats are overwritten
   * in place (`needsUpdate`), never reallocated.
   *
   * `cornersFor` comes from the AgentEye so the drawn frustum and the one the
   * agent actually renders through cannot drift apart.
   */
  update(pose: AgentPose, cornersFor: (depth: number, out: number[]) => number[]): void {
    this._tmpPos.set(pose.px, pose.py, pose.pz);
    this._tmpTarget.set(pose.tx, pose.ty, pose.tz);
    if (this._tmpPos.distanceToSquared(this._tmpTarget) < 1e-12) {
      this._tmpTarget.set(pose.px, pose.py, pose.pz - 1);
    }
    this._tmpMat.lookAt(this._tmpPos, this._tmpTarget, this._tmpUp);
    this._tmpQuat.setFromRotationMatrix(this._tmpMat);
    this.group.position.copy(this._tmpPos);
    this.group.quaternion.copy(this._tmpQuat);
    this.group.updateMatrixWorld(true);

    cornersFor(GIZMO_NEAR_M, this._near);
    cornersFor(GIZMO_DEPTH_M, this._far);
    writeFrustumEdges(this._positions, this._near, this._far, pose.projection);
    (this._geometry.getAttribute('position') as BufferAttribute).needsUpdate = true;
    writeFrustumFaces(this._facePositions, this._near, this._far);
    (this._faceGeometry.getAttribute('position') as BufferAttribute).needsUpdate = true;
  }

  /**
   * Screen-space bounding box of the cone in CSS pixels relative to the canvas,
   * or null when it is entirely behind the camera. Feeds the double-click hit
   * test (D-A5) — deliberately not a raycast: BVH picking is the machine's, and
   * the cone must stay out of it.
   */
  screenRect(camera: Camera, canvas: HTMLCanvasElement): { x: number; y: number; width: number; height: number } | null {
    if (!this.group.visible) return null;
    const w = canvas.clientWidth || canvas.width;
    const h = canvas.clientHeight || canvas.height;
    if (!w || !h) return null;
    this.group.updateMatrixWorld(true);
    camera.updateMatrixWorld(true);

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    let any = false;
    // Apex + the 8 rectangle corners. The apex alone is the ortho case's only
    // meaningful anchor, so it is always included.
    for (let i = -1; i < 8; i++) {
      if (i < 0) {
        this._tmpProject.set(0, 0, 0);
      } else {
        const src = i < 4 ? this._near : this._far;
        const c = (i % 4) * 3;
        this._tmpProject.set(src[c], src[c + 1], src[c + 2]);
      }
      this._tmpProject.applyMatrix4(this.group.matrixWorld).project(camera);
      if (this._tmpProject.z > 1) continue;   // behind the camera
      const px = (this._tmpProject.x * 0.5 + 0.5) * w;
      const py = (-this._tmpProject.y * 0.5 + 0.5) * h;
      if (px < minX) minX = px;
      if (px > maxX) maxX = px;
      if (py < minY) minY = py;
      if (py > maxY) maxY = py;
      any = true;
    }
    if (!any) return null;
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  }

  /**
   * Release everything this gizmo owns. Hand-written on purpose — see the file
   * header: `disposeSubtree` would take the shared Sprite geometry with it.
   */
  dispose(): void {
    this.group.removeFromParent();
    this.group.remove(this._lines, this._faces);
    this._geometry.dispose();
    this._faceGeometry.dispose();
    this._lineMat.dispose();
    this._faceMat.dispose();
  }
}
