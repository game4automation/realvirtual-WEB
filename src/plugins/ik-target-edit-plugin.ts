// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * ik-target-edit-plugin.ts — Interactive IK target editing (gizmo + quick-edit).
 *
 * Selecting a robot (or one of its IKTargets) makes its path waypoints editable:
 * move the pointer near a pathpoint → a translate/rotate gizmo pops on it; grab an
 * axis arrow (move), a ring (rotate the TCP orientation), or the centre (free move).
 * The robot's joints re-solve (Pieper/Cobot WASM solver) and follow in real time,
 * and a semi-transparent GHOST of the robot's axis-6 / tool shows the target pose.
 *
 * Solution selection: every solve keeps the full REACHABLE configuration set of
 * the active point (shoulder/elbow/wrist branches). The quick-edit popover steps
 * through them (cycleSolution — hovering the stepper previews the neighbor
 * configuration as an amber whole-arm ghost); the applied configuration is
 * written back to the target's AxisPos (in-memory + persisted setField op).
 *
 * Persistence: moving a point (gizmo drag, numeric pose edit, align shortcut)
 * persists the new LOCAL transform as a `setNodeTransform` op plus the fresh
 * AxisPos in ONE undoable transaction — edited paths survive scene reloads and
 * every drag is a single undo step.
 *
 * Preview/replay consistency: activating a point (and building ghosts) seeds the
 * closest-solution selection with the target's stored AxisPos, so the preview
 * shows the SAME configuration the replay will drive — not whatever branch
 * happens to be nearest to the robot's momentary pose.
 *
 * Gizmo styling follows the planner's FloorGizmo design language (thin axis
 * arrows + cone tips in the muted axis palette, hover highlight, rotate cursor,
 * cursor-anchored Δ-readout in mm/°). Interaction model unchanged: each visible
 * handle has a fat INVISIBLE picker mesh so it's easy to grab; a CAPTURE-phase
 * pointerdown on `window` runs before the planner's canvas handlers and claims
 * the event so box-select / orbit / selection never start. Orbit is disabled
 * only while actively dragging.
 *
 * Performance: pointer listeners attach only while a robot is selected; onRender
 * early-returns unless the gizmo is visible — zero cost in normal mode.
 */

import {
  Group, Mesh, MeshBasicMaterial, CylinderGeometry, ConeGeometry, SphereGeometry, TorusGeometry,
  Raycaster, Plane, Vector2, Vector3, Matrix4, Quaternion, Euler, DoubleSide,
} from 'three';
import type { Object3D, Material } from 'three';
import type { RVViewerPlugin } from '../core/rv-plugin';
import type { RVViewer } from '../core/rv-viewer';
import type { SelectionSnapshot } from '../core/engine/rv-selection-manager';
import { ikSolverRegistry, targetPoseInBase, type OpwParams, type CobotSolveOpts, type IKSolution } from '../core/engine/rv-ik-solver';
import { reachableSolutions, closestSolutionIndex } from '../core/engine/rv-ik-solution-utils';
import { HIGHLIGHT_OVERLAY_LAYER } from '../core/engine/rv-group-registry';
import { ensureMovableTransform, applyLocalPose } from '../core/engine/rv-node-transform';
import { claimAxes, releaseAxes, AxisOwnershipError } from '../core/engine/rv-axis-ownership';
import { nearestAxisAlignedQuaternion, alignClosestAxisTo } from '../core/engine/rv-pose-align';
import type { RVRobotIK } from '../core/engine/rv-robot-ik';
import type { RVDrive } from '../core/engine/rv-drive';
import type { RVIKTarget } from '../core/engine/rv-ik-target';
import { isRef, type RVIKPath } from '../core/engine/rv-ik-path';
import type { ComponentRef } from '../core/engine/rv-node-registry';
import { ikEditStore, type IKEditController, type IKEditValues, type IKEditActive, type PoseField } from '../core/hmi/ik-edit-store';
import { popoverStore } from '../core/hmi/popover-store';
import { persistFieldOp } from '../core/hmi/scene/scene-field-ops';
import { getSceneStore } from '../core/hmi/scene/scene-store-singleton';
import { freshOpId, deepCloneJSON } from '../core/hmi/scene/rv-scene-edits';
import type { RuntimeNodeSpec } from '../core/engine/rv-scene-loader';
import { disposeSubtree } from '../core/engine/rv-traverse-utils';
import { ndcToScreen, type ScreenPoint } from '../core/engine/rv-ndc';

/** IKEditValues key → IKTarget rv_extras / schema field name. */
const IK_FIELD_MAP: Record<keyof IKEditValues, string> = {
  interpolation: 'InterpolationToTarget',
  speedToTarget: 'SpeedToTarget',
  linearSpeed: 'LinearSpeedToTarget',
  linearAccel: 'LinearAcceleration',
  enableBlending: 'EnableBlending',
  blendRadius: 'BlendRadius',
  waitForSeconds: 'WaitForSeconds',
  pickAndPlace: 'PickAndPlace',
};

const GRAB_RADIUS_PX = 44;
const _screenPt: ScreenPoint = { x: 0, y: 0 };
const GIZMO_SCREEN_SCALE = 0.115;
type Handle = 'x' | 'y' | 'z' | 'center' | 'rx' | 'ry' | 'rz';
const AX: Record<'x' | 'y' | 'z', Vector3> = { x: new Vector3(1, 0, 0), y: new Vector3(0, 1, 0), z: new Vector3(0, 0, 1) };

// ── Gizmo design language (planner FloorGizmo palette) ──
const AXIS_COLOR: Record<'x' | 'y' | 'z', number> = { x: 0xe03131, y: 0x2f9e44, z: 0x1971c2 };
const AXIS_COLOR_HOVER: Record<'x' | 'y' | 'z', number> = { x: 0xff6b6b, y: 0x69db7c, z: 0x4dabf7 };
const CENTER_COLOR = 0x4fc34f; // selection-brand green
const RING_OPACITY_IDLE = 0.75;
const CENTER_OPACITY_IDLE = 0.5;
const CENTER_OPACITY_HOVER = 0.9;
/** Rotate cursor (inline SVG) — same glyph the planner's FloorGizmo uses. */
const CURSOR_ROTATE = `url("data:image/svg+xml;utf8,${encodeURIComponent(
  `<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'>` +
  `<g fill='none' stroke='white' stroke-width='3' stroke-linecap='round' stroke-linejoin='round'>` +
    `<path d='M19.5 12 A7.5 7.5 0 1 1 12 4.5'/>` +
    `<polyline points='12,1.5 12,7.5 18,7.5'/>` +
  `</g>` +
  `<g fill='none' stroke='black' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'>` +
    `<path d='M19.5 12 A7.5 7.5 0 1 1 12 4.5'/>` +
    `<polyline points='12,1.5 12,7.5 18,7.5'/>` +
  `</g>` +
  `</svg>`,
)}") 12 12, crosshair`;

interface Candidate { node: Object3D; robot: RVRobotIK; params: OpwParams; drives: RVDrive[]; target: RVIKTarget; ikPath: RVIKPath; }
interface Drag {
  c: Candidate; kind: 'axis' | 'plane' | 'rotate'; handle: Handle; axisDir: Vector3;
  startWorld: Vector3; plane: Plane; grab: number; offset: Vector3;
  startQuat: Quaternion;
  /** Local pose at drag start — the `prev` payload of the persisted transform op. */
  prevLocalPos: [number, number, number]; prevLocalQuat: [number, number, number, number];
  /** Rotate drag: screen-space angle control (see beginDrag). */
  centerPx: [number, number]; lastPtrAngle: number; accumAngle: number; rotSign: 1 | -1;
}

/** Translation snap step with Shift held (meters). */
const TRANSLATE_SNAP_M = 0.01; // 10 mm

export class IKTargetEditPlugin implements RVViewerPlugin {
  readonly id = 'ik-target-edit';

  private viewer: RVViewer | null = null;
  private unsub: (() => void) | null = null;
  private _listening = false;

  private candidates: Candidate[] = [];
  private gizmo: Group | null = null;
  private active: Candidate | null = null;
  private drag: Drag | null = null;
  private prevControlsEnabled = true;
  /** One semi-transparent tool ghost per pathpoint (shown when no point is being edited). */
  private readonly ghosts = new Map<Candidate, Group>();
  private ghostMat: MeshBasicMaterial | null = null;

  private readonly raycaster = new Raycaster();
  private readonly ndc = new Vector2();
  private readonly _v = new Vector3();
  private readonly _hit = new Vector3();
  private readonly _mat = new Matrix4();
  private readonly _pos = new Vector3();
  private readonly _q = new Quaternion();
  private readonly _q2 = new Quaternion();
  private readonly _dPos = new Vector3();
  private readonly _dScl = new Vector3();
  private readonly _wtmp = new Vector3();
  // Reusable solver tuples (avoid per-frame allocation during drag / live anchor).
  private readonly _p3: [number, number, number] = [0, 0, 0];
  private readonly _q4: [number, number, number, number] = [0, 0, 0, 1];
  private readonly _seed: number[] = [0, 0, 0, 0, 0, 0];
  // Reusable Cobot-solve inputs (plan-233 Phase 2): warm start = current drive
  // angles; opts object is mutated per call — never allocated in the drag loop.
  private readonly _warm = new Float64Array(6);
  private readonly _cobotOpts: CobotSolveOpts = {};
  private readonly _worldTuple: [number, number, number] = [0, 0, 0];
  private _lastSnap: SelectionSnapshot | null = null;
  /** Guards onClose recursion while we replace/hide the popover ourselves. */
  private _suppressClose = false;
  /** Reachable configuration set of the ACTIVE pathpoint (for the solution stepper). */
  private _activeSolutions: number[][] = [];
  private _activeSolutionIdx = -1;
  /** Hover/drag highlighting: visible material per handle. */
  private _hovered: Handle | null = null;
  private readonly _handleMats = new Map<Handle, MeshBasicMaterial>();
  /** Cursor-anchored Δ-readout while dragging (mm / °). */
  private _readoutEl: HTMLDivElement | null = null;
  /** True once the current drag actually moved the point (gates AxisPos refresh). */
  private _dragMoved = false;

  // ── World read/write that respects the loader's frozen matrixWorld ──
  // Static nodes are frozen (matrixWorldAutoUpdate=false, baked matrixWorld). Calling
  // getWorldPosition()/updateWorldMatrix() RECOMPUTES from (often identity) local
  // matrices and corrupts the pose to the origin. So read straight from matrixWorld.
  private worldPos(node: Object3D, out: Vector3): Vector3 {
    return out.setFromMatrixPosition(node.matrixWorld);
  }
  private worldQuat(node: Object3D, out: Quaternion): Quaternion {
    node.matrixWorld.decompose(this._dPos, out, this._dScl);
    return out;
  }

  init(viewer: RVViewer): void {
    this.viewer = viewer;
    this.unsub = viewer.on('selection-changed', (s) => this.onSelection(s));
    // pointerdown stays live (click-frequency only) so a robot can be picked — and its
    // path edited — even in planner mode, where the planner's canvas handler would
    // otherwise treat the robot as empty canvas and start a box-select.
    window.addEventListener('pointerdown', this._onPointerDown as EventListener, true);
  }

  onModelCleared(): void {
    this.endDrag(); this.candidates = []; this.hideGizmo(); this.clearGhosts(); this.clearPreview(); this.setListeners(false);
    releaseAxes(this);
    // Reset per-robot free-tier claims (plan-233 §11-A3-Reset): the registry is a
    // module singleton, so without this a 1→2→1-robot scene switch would keep the
    // old robot's slot taken and never re-free live-solving for the new scene.
    ikSolverRegistry.resetLiveSolveClaims();
  }

  dispose(): void {
    this.endDrag(); this.unsub?.(); this.unsub = null; this.setListeners(false);
    releaseAxes(this);
    window.removeEventListener('pointerdown', this._onPointerDown as EventListener, true);
    this.clearGhosts();
    this.clearPreview();
    this.removeReadout();
    this.ghostMat?.dispose(); this.ghostMat = null;
    this._previewMat?.dispose(); this._previewMat = null;
    if (this.viewer && this.gizmo) { this.viewer.scene.remove(this.gizmo); disposeSubtree(this.gizmo); }
    this._handleMats.clear();
    this.gizmo = null; this.viewer = null;
  }

  onRender(): void {
    const g = this.gizmo, viewer = this.viewer;
    if (!g || !g.visible || !viewer) return;
    g.scale.setScalar(viewer.camera.position.distanceTo(g.position) * GIZMO_SCREEN_SCALE);
  }

  /** Attach move/up only while editing (perf). pointerdown is always live (see init). */
  private setListeners(on: boolean): void {
    if (on === this._listening) return;
    this._listening = on;
    // NOTE: call window.addEventListener directly — assigning it to a local var
    // detaches the `this` binding and throws "Illegal invocation".
    if (on) {
      window.addEventListener('pointermove', this._onPointerMove as EventListener, true);
      window.addEventListener('pointerup', this._onPointerUp as EventListener, true);
    } else {
      window.removeEventListener('pointermove', this._onPointerMove as EventListener, true);
      window.removeEventListener('pointerup', this._onPointerUp as EventListener, true);
    }
  }

  // ── Selection → candidate pathpoints ──

  private onSelection(snap: SelectionSnapshot): void {
    const viewer = this.viewer;
    this._lastSnap = snap;
    this.candidates = []; this.hideGizmo(); this.clearGhosts();
    // Release axes claimed for the previous selection FIRST: a running IKPath
    // resumes (driveToTarget from its current target) the moment the robot is
    // deselected or the selection moves to another robot.
    releaseAxes(this);
    if (viewer?.registry) {
      const seen = new Set<RVRobotIK>();
      for (const path of snap.selectedPaths) {
        const node = viewer.registry.getNode(path);
        if (!node) continue;
        const robot = viewer.registry.findInParent<RVRobotIK>(node, 'RobotIK');
        if (!robot || seen.has(robot)) continue;
        seen.add(robot);
        const params = robot.getOpwParams();
        const drives = robot.getAxisDrives();
        if (!params || drives.length < 6) continue;
        // Claim the robot's axes for the whole edit session (ghost previews and
        // drags pose the drives directly). This pauses a RUNNING IKPath instead
        // of dead-locking it: without the claim the path keeps waiting for a
        // PTP arrival that positionOverwrite makes impossible — the robot
        // froze permanently after moving a path point. A claim conflict (e.g.
        // DES RobotHandling drives this robot) makes the robot read-only here.
        try { claimAxes(drives.slice(0, 6), this); }
        catch (e) {
          if (e instanceof AxisOwnershipError) { console.warn(`[IKTargetEdit] ${e.message}`); continue; }
          throw e;
        }
        for (const p of robot.getPaths()) for (const t of p.targets) this.candidates.push({ node: t.node, robot, params, drives, target: t, ikPath: p });
      }
    }
    this.setListeners(this.candidates.length > 0);
    // Robot/path selected but no point being edited yet → show a tool ghost at each waypoint.
    if (this.candidates.length) { this.buildGhosts(); this.setGhostsVisible(true); }
  }

  // ── Pointer handling (capture phase) ──

  private readonly _onPointerDown = (e: PointerEvent): void => {
    const viewer = this.viewer;
    if (!viewer || e.button !== 0 || !this.withinCanvas(e)) return;
    // Clicks on the floating popover must not reach the plugin. The popover's own
    // stopPropagation can't help: this listener is capture-phase (runs first).
    if ((e.target as HTMLElement | null)?.closest?.('[data-rv-popover]')) return;
    // 1) Gizmo is up and we grabbed a handle → start dragging.
    if (this.gizmo?.visible && this.active) {
      const handle = this.pickHandle(e);
      if (handle) { e.stopPropagation(); e.preventDefault(); this.beginDrag(e, handle); return; }
    }
    // 2) Clicked near a pathpoint → pop the gizmo there (sticky), hide ghosts and
    //    preview the robot at that point (re-solve).
    const c = this.nearestCandidate(e);
    if (c) {
      e.stopPropagation(); e.preventDefault();
      this.activate(c);
      return;
    }
    // 3) Clicked a robot mesh → select it (works in planner mode too) so its path
    //    points become editable. Claim the click so the planner won't box-select.
    const robot = this.pickRobot(e);
    if (robot) {
      const path = viewer.registry?.getPathForNode(robot.node);
      if (path) { e.stopPropagation(); e.preventDefault(); viewer.selectionManager.select(path); return; }
    }
    // 4) Clicked elsewhere → leave the gizmo sticky so orbit (drag-empty) doesn't lose
    //    it. A real deselect re-fires onSelection and clears the gizmo + ghosts.
  };

  private beginDrag(e: PointerEvent, handle: Handle): void {
    const viewer = this.viewer!;
    const c = this.active!;
    ensureMovableTransform(c.node);
    this.prevControlsEnabled = viewer.controls.enabled;
    viewer.controls.enabled = false;
    const startWorld = this.worldPos(c.node, new Vector3());
    this.setNdc(e); this.raycaster.setFromCamera(this.ndc, viewer.camera);
    const d: Drag = {
      c, kind: 'plane', handle, axisDir: new Vector3(), startWorld,
      plane: new Plane(), grab: 0, offset: new Vector3(),
      startQuat: this.worldQuat(c.node, new Quaternion()),
      // Local pose is valid here — ensureMovableTransform ran above.
      prevLocalPos: [c.node.position.x, c.node.position.y, c.node.position.z],
      prevLocalQuat: [c.node.quaternion.x, c.node.quaternion.y, c.node.quaternion.z, c.node.quaternion.w],
      centerPx: [0, 0], lastPtrAngle: 0, accumAngle: 0, rotSign: 1,
    };
    if (handle === 'center') {
      d.kind = 'plane';
      d.plane.setFromNormalAndCoplanarPoint(viewer.camera.getWorldDirection(new Vector3()), startWorld);
      if (this.raycaster.ray.intersectPlane(d.plane, this._hit)) d.offset.subVectors(startWorld, this._hit);
    } else if (handle === 'x' || handle === 'y' || handle === 'z') {
      // Axis in the TCP frame: rotate the local axis by the target's world orientation.
      d.kind = 'axis'; d.axisDir.copy(AX[handle]).applyQuaternion(d.startQuat).normalize();
      d.grab = this.closestOnAxis(startWorld, d.axisDir, this.raycaster.ray.origin, this.raycaster.ray.direction);
    } else {
      d.kind = 'rotate'; d.axisDir.copy(AX[handle[1] as 'x' | 'y' | 'z']).applyQuaternion(d.startQuat).normalize();
      // Screen-space angle control: the rotation angle is the cursor's swept
      // angle around the PROJECTED gizmo centre (accumulated per move → drags
      // beyond ±180° keep going). A ring-plane raycast would degenerate for
      // edge-on rings (hits shoot off to infinity → wild angle jumps), which
      // made rotation feel broken from most camera angles.
      this.screenOf(startWorld, d.centerPx);
      d.lastPtrAngle = Math.atan2(e.clientY - d.centerPx[1], e.clientX - d.centerPx[0]);
      // Axis pointing toward the camera: screen-CW (positive atan2 delta with
      // y-down) corresponds to a NEGATIVE right-hand rotation around the axis.
      this._v.subVectors(viewer.camera.position, startWorld);
      d.rotSign = d.axisDir.dot(this._v) >= 0 ? -1 : 1;
    }
    this.drag = d;
    this._dragMoved = false;
    this.refreshHandleColors();
    viewer.renderer.domElement.style.cursor = 'grabbing';
    this.showReadout(e);
    try { viewer.renderer.domElement.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  }

  private readonly _onPointerMove = (e: PointerEvent): void => {
    const viewer = this.viewer;
    if (!viewer) return;
    if (!this.drag) {
      // Sticky model: never show/hide on hover (arrows reach beyond the point).
      // Hint via cursor + handle highlight: 'move' over translate handles, the
      // rotate glyph over rings, 'pointer' near a pathpoint.
      if (this.candidates.length && this.withinCanvas(e)) {
        const overHandle = this.gizmo?.visible && this.active ? this.pickHandle(e) : null;
        this.setHovered(overHandle);
        viewer.renderer.domElement.style.cursor = overHandle
          ? (overHandle === 'rx' || overHandle === 'ry' || overHandle === 'rz' ? CURSOR_ROTATE : 'move')
          : (this.nearestCandidate(e) ? 'pointer' : '');
      }
      return;
    }
    e.stopPropagation();
    this.setNdc(e); this.raycaster.setFromCamera(this.ndc, viewer.camera);
    const d = this.drag, node = d.c.node, parent = node.parent;
    if (d.kind === 'rotate') {
      // Accumulate the cursor's swept screen angle around the projected centre
      // (wrap-safe → continuous drags past ±180°).
      const ptr = Math.atan2(e.clientY - d.centerPx[1], e.clientX - d.centerPx[0]);
      let inc = ptr - d.lastPtrAngle;
      if (inc > Math.PI) inc -= 2 * Math.PI; else if (inc < -Math.PI) inc += 2 * Math.PI;
      d.accumAngle += inc;
      d.lastPtrAngle = ptr;
      let angle = d.rotSign * d.accumAngle;
      // Free rotation by default; Shift snaps to 90° steps.
      if (e.shiftKey) angle = Math.round(angle / (Math.PI / 2)) * (Math.PI / 2);
      this.updateReadout(e, `Δ ${fmtDeg(angle)}`);
      this._q.setFromAxisAngle(d.axisDir, angle).multiply(d.startQuat); // desired world quat
      if (parent) { this.worldQuat(parent, this._q2).invert().multiply(this._q); node.quaternion.copy(this._q2); }
      else node.quaternion.copy(this._q);
    } else {
      if (d.kind === 'axis') {
        const s = this.closestOnAxis(d.startWorld, d.axisDir, this.raycaster.ray.origin, this.raycaster.ray.direction);
        let delta = s - d.grab;
        // Shift snaps the travel along the axis to 10 mm steps.
        if (e.shiftKey) delta = Math.round(delta / TRANSLATE_SNAP_M) * TRANSLATE_SNAP_M;
        this._v.copy(d.startWorld).addScaledVector(d.axisDir, delta);
        this.updateReadout(e, `Δ${d.handle} ${fmtMm(delta)}`);
      } else {
        if (!this.raycaster.ray.intersectPlane(d.plane, this._hit)) return;
        this._v.addVectors(this._hit, d.offset);
        // Shift snaps the world position to a 10 mm grid.
        if (e.shiftKey) {
          this._v.x = Math.round(this._v.x / TRANSLATE_SNAP_M) * TRANSLATE_SNAP_M;
          this._v.y = Math.round(this._v.y / TRANSLATE_SNAP_M) * TRANSLATE_SNAP_M;
          this._v.z = Math.round(this._v.z / TRANSLATE_SNAP_M) * TRANSLATE_SNAP_M;
        }
        this.updateReadout(e, `Δ ${fmtMm(this._wtmp.subVectors(this._v, d.startWorld).length())}`);
      }
      // World target → parent-local via the BAKED parent.matrixWorld directly
      // (parent.worldToLocal() calls updateWorldMatrix → corrupts frozen ancestors).
      // _v is mutated in place — its world value isn't needed after this.
      if (parent) { this._mat.copy(parent.matrixWorld).invert(); node.position.copy(this._v.applyMatrix4(this._mat)); }
      else node.position.copy(this._v);
    }
    this._dragMoved = true;
    // Refresh node.matrixWorld from the correct parent.matrixWorld — no recursion.
    node.updateMatrix();
    if (parent) node.matrixWorld.multiplyMatrices(parent.matrixWorld, node.matrix);
    else node.matrixWorld.copy(node.matrix);
    this.gizmo!.position.copy(this.worldPos(node, this._pos));
    this.gizmo!.quaternion.copy(this.worldQuat(node, this._q));
    const reach = this.resolve(d.c);
    this.pushEditState(d.c, reach);
  };

  /** Push reachability, solution set and world pose of the active point into
   *  the edit store (no-op when nothing changed — avoids React churn). */
  private pushEditState(c: Candidate, reach: boolean): void {
    if (c !== this.active) return;
    const snap = ikEditStore.getSnapshot();
    if (!snap) return;
    const { poseMm, poseDeg } = this.computePose(c);
    if (snap.reachable === reach
      && snap.solutionCount === this._activeSolutions.length
      && snap.solutionIndex === this._activeSolutionIdx
      && tripleEq(snap.poseMm, poseMm) && tripleEq(snap.poseDeg, poseDeg)) return;
    ikEditStore.updateValues({
      reachable: reach,
      solutionCount: this._activeSolutions.length,
      solutionIndex: this._activeSolutionIdx,
      poseMm, poseDeg,
    });
  }

  /** World pose of the target as mm / XYZ-Euler degrees (rounded to 0.1). */
  private readonly _euler = new Euler();
  private computePose(c: Candidate): { poseMm: [number, number, number]; poseDeg: [number, number, number] } {
    const p = this.worldPos(c.node, this._v);
    const q = this.worldQuat(c.node, this._q);
    this._euler.setFromQuaternion(q, 'XYZ');
    const r1 = (v: number) => Math.round(v * 10) / 10;
    const deg = (rad: number) => (rad * 180) / Math.PI;
    return {
      poseMm: [r1(p.x * 1000), r1(p.y * 1000), r1(p.z * 1000)],
      poseDeg: [r1(deg(this._euler.x)), r1(deg(this._euler.y)), r1(deg(this._euler.z))],
    };
  }

  private readonly _onPointerUp = (e: PointerEvent): void => {
    if (!this.drag) return;
    e.stopPropagation();
    try { this.viewer?.renderer.domElement.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    const d = this.drag;
    const moved = this._dragMoved;
    this.endDrag();
    if (moved) this.afterDragCommit(d.c, d.prevLocalPos, d.prevLocalQuat);
  };

  /** A real move happened: re-solve the final pose, refresh AxisPos and persist
   *  the new local transform + AxisPos as ONE undoable transaction. */
  private afterDragCommit(
    c: Candidate,
    prevPos: [number, number, number],
    prevQuat: [number, number, number, number],
  ): void {
    const reach = this.resolve(c);
    const angles = reach ? c.drives.slice(0, 6).map((d) => d.currentPosition) : null;
    if (angles) c.target.AxisPos = [...angles];
    this.persistPose(c, prevPos, prevQuat, angles);
    this.pushEditState(c, reach);
  }

  /** Persist the target's CURRENT local transform (+ AxisPos when solvable) as
   *  one undoable transaction. No-op without a SceneStore / registry path. */
  private persistPose(
    c: Candidate,
    prevPos: [number, number, number],
    prevQuat: [number, number, number, number],
    angles: readonly number[] | null,
  ): void {
    const store = getSceneStore();
    const nodePath = this.viewer?.registry?.getPathForNode(c.node);
    if (!store || !nodePath) return;
    const n = c.node;
    const tOp = {
      id: freshOpId(), ts: Date.now(), schemaV: 1 as const,
      kind: 'setNodeTransform' as const, nodePath,
      position: [n.position.x, n.position.y, n.position.z] as [number, number, number],
      quaternion: [n.quaternion.x, n.quaternion.y, n.quaternion.z, n.quaternion.w] as [number, number, number, number],
      prev: { position: prevPos, quaternion: prevQuat },
    };
    if (angles) {
      const raw = (n.userData?.realvirtual as Record<string, Record<string, unknown>> | undefined)?.['IKTarget'];
      const prevAxis = raw?.['AxisPos'];
      void store.withTransaction('Move path point', async () => {
        await store.applyOp(tOp);
        await store.applyOp({
          id: freshOpId(), ts: Date.now(), schemaV: 1, kind: 'setField',
          nodePath, componentType: 'IKTarget', fieldName: 'AxisPos', value: [...angles], prev: prevAxis,
        });
      });
    } else {
      void store.applyOp(tOp);
    }
  }

  private endDrag(): void {
    const viewer = this.viewer;
    if (this.drag && viewer) viewer.controls.enabled = this.prevControlsEnabled;
    this.drag = null;
    this._dragMoved = false;
    this.removeReadout();
    this.refreshHandleColors();
    if (viewer) viewer.renderer.domElement.style.cursor = '';
  }

  // ── Gizmo geometry (visible + fat invisible pickers) ──

  private ensureGizmo(): Group {
    if (this.gizmo) return this.gizmo;
    const g = new Group(); g.name = '__rvIKGizmo';
    this._handleMats.clear();
    const pickMat = () => new MeshBasicMaterial({ visible: true, transparent: true, opacity: 0, depthTest: false, depthWrite: false });

    // Thin axis arrows (shaft + cone tip) in the planner's muted axis palette.
    const mkAxis = (h: 'x' | 'y' | 'z', dir: Vector3) => {
      const mat = new MeshBasicMaterial({ color: AXIS_COLOR[h], transparent: true, depthTest: false, depthWrite: false });
      this._handleMats.set(h, mat);
      const shaft = new Mesh(new CylinderGeometry(0.009, 0.009, 0.56, 16), mat); shaft.position.y = 0.28;
      const head = new Mesh(new ConeGeometry(0.042, 0.14, 16), mat); head.position.y = 0.63;
      // Slim picker — a fat one crosses the ring band in screen space and
      // steals ring grabs (rotation then "does nothing" / translates instead).
      const picker = new Mesh(new CylinderGeometry(0.07, 0.07, 0.85, 6), pickMat()); picker.position.y = 0.5;
      picker.userData.gizmoHandle = h;
      const grp = new Group(); grp.add(shaft, head, picker);
      grp.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), dir);
      return grp;
    };
    g.add(mkAxis('x', AX.x), mkAxis('y', AX.y), mkAxis('z', AX.z));

    // Slim rotation rings, same per-axis colors — translucent until hovered.
    const mkRing = (h: 'rx' | 'ry' | 'rz', normal: Vector3) => {
      const axis = h[1] as 'x' | 'y' | 'z';
      const mat = new MeshBasicMaterial({ color: AXIS_COLOR[axis], transparent: true, opacity: RING_OPACITY_IDLE, depthTest: false, depthWrite: false, side: DoubleSide });
      this._handleMats.set(h, mat);
      const ring = new Mesh(new TorusGeometry(0.46, 0.008, 8, 64), mat);
      const picker = new Mesh(new TorusGeometry(0.46, 0.1, 6, 32), pickMat()); picker.userData.gizmoHandle = h;
      const grp = new Group(); grp.add(ring, picker);
      grp.quaternion.setFromUnitVectors(new Vector3(0, 0, 1), normal);
      return grp;
    };
    g.add(mkRing('rx', AX.x), mkRing('ry', AX.y), mkRing('rz', AX.z));

    // Centre free-move handle — smoked selection-green sphere (brand color).
    const centerMat = new MeshBasicMaterial({ color: CENTER_COLOR, transparent: true, opacity: CENTER_OPACITY_IDLE, depthTest: false, depthWrite: false });
    this._handleMats.set('center', centerMat);
    const center = new Mesh(new SphereGeometry(0.08, 20, 20), centerMat);
    center.userData.gizmoHandle = 'center'; g.add(center);

    // Overlay layer: rendered AFTER the EffectComposer (like the planner's
    // FloorGizmo) — keeps toon outlines / AO / bloom off the gizmo, which
    // otherwise draw sketchy double edges around the thin rings and arrows.
    g.traverse((o) => { o.renderOrder = 11000; o.layers.set(HIGHLIGHT_OVERLAY_LAYER); });
    // Raycaster.layers defaults to layer 0 — enable the overlay layer too or
    // pickHandle() silently misses every handle.
    this.raycaster.layers.enable(HIGHLIGHT_OVERLAY_LAYER);
    g.visible = false;
    this.viewer!.scene.add(g);
    this.gizmo = g;
    return g;
  }

  // ── Hover / drag highlighting ──

  private setHovered(h: Handle | null): void {
    if (this._hovered === h) return;
    this._hovered = h;
    this.refreshHandleColors();
  }

  /** Recolor the visible handle materials for the hovered/dragged handle. */
  private refreshHandleColors(): void {
    const hot = this.drag ? this.drag.handle : this._hovered;
    for (const [h, mat] of this._handleMats) {
      const isHot = h === hot;
      if (h === 'center') {
        mat.opacity = isHot ? CENTER_OPACITY_HOVER : CENTER_OPACITY_IDLE;
      } else {
        const axis = (h.length === 2 ? h[1] : h) as 'x' | 'y' | 'z';
        mat.color.setHex(isHot ? AXIS_COLOR_HOVER[axis] : AXIS_COLOR[axis]);
        if (h.length === 2) mat.opacity = isHot ? 1 : RING_OPACITY_IDLE;
      }
    }
  }

  // ── Cursor-anchored Δ-readout (planner FloorGizmo look) ──

  private showReadout(e: PointerEvent): void {
    if (this._readoutEl) return;
    const el = document.createElement('div');
    el.style.cssText = `
      position: fixed; pointer-events: none; z-index: 10000;
      background: rgba(20,30,20,0.85); color: #c9ffc9;
      font: 12px/1.3 ui-monospace, monospace;
      padding: 4px 8px; border-radius: 4px;
      border: 1px solid rgba(120,255,120,0.4);
      transform: translate(12px, 18px);
      white-space: nowrap;
    `;
    document.body.appendChild(el);
    this._readoutEl = el;
    this.updateReadout(e, '');
  }

  private updateReadout(e: PointerEvent, text: string): void {
    if (!this._readoutEl) return;
    this._readoutEl.style.left = `${e.clientX}px`;
    this._readoutEl.style.top = `${e.clientY}px`;
    if (text) this._readoutEl.textContent = text;
  }

  private removeReadout(): void {
    this._readoutEl?.remove();
    this._readoutEl = null;
  }

  private showGizmoAt(c: Candidate): void {
    const g = this.ensureGizmo();
    ensureMovableTransform(c.node);
    g.position.copy(this.worldPos(c.node, this._pos));
    g.quaternion.copy(this.worldQuat(c.node, this._q)); // align gizmo to the TCP / tool frame
    g.visible = true;
  }

  /** Activate a pathpoint: pop the gizmo, hide ghosts, re-solve the robot to it
   *  (seeded with the stored AxisPos → replay configuration) and open the
   *  Quick-Edit compact window anchored at the point. */
  private activate(c: Candidate): void {
    this.active = c;
    this.showGizmoAt(c);
    this.setGhostsVisible(false);
    const reachable = this.resolve(c, this.replaySeed(c));
    // Show the popover BEFORE setActive so a replaced previous request's onClose
    // (suppressed) can't wipe the new edit state.
    this._suppressClose = true;
    popoverStore.show({ id: 'ik-target', title: c.node.name || 'Target', getWorld: this._getActiveWorld, onClose: this._onPopoverClose });
    this._suppressClose = false;
    ikEditStore.setActive(this.buildActive(c, reachable), this.controller);
  }

  /** The target's stored AxisPos when it holds usable replay angles, else undefined. */
  private replaySeed(c: Candidate): readonly number[] | undefined {
    return c.target.hasReplayAngles(6) ? c.target.AxisPos : undefined;
  }

  private hideGizmo(): void {
    if (this.gizmo) this.gizmo.visible = false;
    this.active = null;
    this._activeSolutions = [];
    this._activeSolutionIdx = -1;
    this.clearPreview();
    this.setHovered(null);
    this._suppressClose = true;
    popoverStore.hide('ik-target');
    this._suppressClose = false;
    ikEditStore.clear();
  }

  /** Live world anchor for the popover (read straight from the frozen-safe matrixWorld).
   *  Returns a reusable tuple — the popover reads it synchronously each frame. */
  private readonly _getActiveWorld = (): [number, number, number] => {
    if (this.active) {
      const w = this.worldPos(this.active.node, this._wtmp);
      this._worldTuple[0] = w.x; this._worldTuple[1] = w.y; this._worldTuple[2] = w.z;
    }
    return this._worldTuple;
  };

  /** Popover dismissed externally (Escape / replaced): drop the gizmo, restore ghosts. */
  private readonly _onPopoverClose = (): void => {
    if (this._suppressClose) return;
    this.hideGizmo();
    if (this.candidates.length) this.setGhostsVisible(true);
  };

  // ── Quick-Edit controller (consumed by the React popover via ikEditStore) ──

  private readonly controller: IKEditController = {
    setProp: (field, value) => this.setProp(field, value),
    setPose: (field, value) => this.setPoseField(field, value),
    align: (mode) => this.alignPose(mode),
    addPoint: (where) => this.addPathpoint(where),
    deleteTarget: () => this.deleteActiveTarget(),
    cycleSolution: (dir) => this.cycleSolution(dir),
    previewSolution: (dir) => this.previewSolution(dir),
    close: () => { this.hideGizmo(); if (this.candidates.length) this.setGhostsVisible(true); },
  };

  /** Set one world-pose component (mm / degrees) from the numeric editors. */
  private setPoseField(field: PoseField, value: number): void {
    const c = this.active;
    if (!c || !Number.isFinite(value)) return;
    ensureMovableTransform(c.node);
    const prevPos: [number, number, number] = [c.node.position.x, c.node.position.y, c.node.position.z];
    const prevQuat: [number, number, number, number] = [c.node.quaternion.x, c.node.quaternion.y, c.node.quaternion.z, c.node.quaternion.w];
    const p = this.worldPos(c.node, this._v);
    const q = this.worldQuat(c.node, this._q);
    if (field === 'x' || field === 'y' || field === 'z') {
      p[field] = value / 1000;
    } else {
      this._euler.setFromQuaternion(q, 'XYZ');
      const rad = (value * Math.PI) / 180;
      if (field === 'rx') this._euler.x = rad;
      else if (field === 'ry') this._euler.y = rad;
      else this._euler.z = rad;
      q.setFromEuler(this._euler);
    }
    this.applyWorldPose(c, p, q, prevPos, prevQuat);
  }

  /** Align shortcuts: nearest local axis exactly world-down / snap to the
   *  nearest of the 24 axis-aligned world orientations. Minimal rotations. */
  private alignPose(mode: 'down' | 'world'): void {
    const c = this.active;
    if (!c) return;
    ensureMovableTransform(c.node);
    const prevPos: [number, number, number] = [c.node.position.x, c.node.position.y, c.node.position.z];
    const prevQuat: [number, number, number, number] = [c.node.quaternion.x, c.node.quaternion.y, c.node.quaternion.z, c.node.quaternion.w];
    const p = this.worldPos(c.node, this._v);
    const q = this.worldQuat(c.node, this._q);
    const aligned = mode === 'world' ? nearestAxisAlignedQuaternion(q) : alignClosestAxisTo(q, WORLD_DOWN);
    this.applyWorldPose(c, p, aligned, prevPos, prevQuat);
  }

  /** Apply a WORLD pose to the active target (parent-local via baked matrices),
   *  refresh gizmo, re-solve, write AxisPos and persist as one undo unit. */
  private applyWorldPose(
    c: Candidate,
    worldPos: Vector3,
    worldQuat: Quaternion,
    prevPos: [number, number, number],
    prevQuat: [number, number, number, number],
  ): void {
    const node = c.node, parent = node.parent;
    // Local position via the full parent inverse (mirror-safe); local quat via
    // the decompose convention (same as the rotate drag — solver-validated).
    this._wtmp.copy(worldPos);
    if (parent) {
      this._mat.copy(parent.matrixWorld).invert();
      this._wtmp.applyMatrix4(this._mat);
      this.worldQuat(parent, this._q2).invert().multiply(worldQuat);
    } else {
      this._q2.copy(worldQuat);
    }
    applyLocalPose(node, [this._wtmp.x, this._wtmp.y, this._wtmp.z], [this._q2.x, this._q2.y, this._q2.z, this._q2.w]);
    if (this.gizmo?.visible && this.active === c) {
      this.gizmo.position.copy(this.worldPos(node, this._pos));
      this.gizmo.quaternion.copy(this.worldQuat(node, this._q));
    }
    const reach = this.resolve(c);
    const angles = reach ? c.drives.slice(0, 6).map((d) => d.currentPosition) : null;
    if (angles) c.target.AxisPos = [...angles];
    this.persistPose(c, prevPos, prevQuat, angles);
    this.pushEditState(c, reach);
  }

  /** Step through the reachable configurations of the active point and write the
   *  choice back to the target's AxisPos (replay follows the selection). */
  private cycleSolution(dir: 1 | -1): void {
    this.clearPreview();
    const c = this.active;
    const n = this._activeSolutions.length;
    if (!c || n === 0) return;
    const idx = this._activeSolutionIdx < 0
      ? (dir > 0 ? 0 : n - 1)
      : (this._activeSolutionIdx + dir + n) % n;
    this._activeSolutionIdx = idx;
    this.applyAngles(c, this._activeSolutions[idx]);
    this.commitAxisPos(c, this._activeSolutions[idx]);
    ikEditStore.updateValues({ solutionIndex: idx, solutionCount: n });
  }

  // ── Solution preview (stepper hover) ──

  /** Amber whole-arm ghost of the configuration the stepper would switch to.
   *  The robot itself only moves on click (cycleSolution). */
  private _previewGroup: Group | null = null;
  private _previewMat: MeshBasicMaterial | null = null;

  private previewSolution(dir: 1 | -1 | null): void {
    this.clearPreview();
    const c = this.active;
    const n = this._activeSolutions.length;
    if (!dir || !c || n < 2) return;
    const cur = this._activeSolutionIdx < 0 ? 0 : this._activeSolutionIdx;
    const idx = (cur + dir + n) % n;
    if (idx === this._activeSolutionIdx) return;
    // Pose the REAL robot for one closure, snapshot a flat world-space clone,
    // restore — all inside this handler, so the altered frame never renders.
    const saved: number[] = c.drives.slice(0, 6).map((d) => d.currentPosition);
    this.applyAngles(c, this._activeSolutions[idx]);
    this._previewGroup = this.snapshotArm(c);
    this.applyAngles(c, saved);
  }

  private clearPreview(): void {
    if (this._previewGroup && this.viewer) this.viewer.scene.remove(this._previewGroup);
    // Geometry is shared with the live robot — never dispose it.
    this._previewGroup = null;
  }

  /** Flat world-space snapshot of the robot's meshes in the preview material. */
  private snapshotArm(c: Candidate): Group | null {
    const viewer = this.viewer;
    if (!viewer) return null;
    if (!this._previewMat) this._previewMat = new MeshBasicMaterial({ color: 0xffb74d, transparent: true, opacity: 0.28, depthWrite: false });
    const group = new Group();
    group.name = '__rvIKSolutionPreview';
    c.robot.node.traverse((o) => {
      const m = o as Mesh;
      // Skip overlay helpers living inside the subtree (markers, labels — they
      // all render in the >= 9000 overlay band).
      if (!m.isMesh || !m.geometry || (m.renderOrder ?? 0) >= 9000) return;
      m.updateWorldMatrix(true, false);
      const clone = new Mesh(m.geometry, this._previewMat!);
      m.matrixWorld.decompose(clone.position, clone.quaternion, clone.scale);
      clone.renderOrder = 9996;
      group.add(clone);
    });
    if (group.children.length === 0) return null;
    viewer.scene.add(group);
    return group;
  }

  /** Write the applied configuration into the target's AxisPos — in-memory (the
   *  replay drives to what the user sees) AND as a persisted setField op (node
   *  transforms persist too via setNodeTransform, so no reload inconsistency). */
  private commitAxisPos(c: Candidate, angles: readonly number[]): void {
    c.target.AxisPos = [...angles];
    const nodePath = this.viewer?.registry?.getPathForNode(c.node);
    if (!nodePath) return;
    const raw = (c.node.userData?.realvirtual as Record<string, Record<string, unknown>> | undefined)?.['IKTarget'];
    persistFieldOp(nodePath, 'IKTarget', 'AxisPos', [...angles], raw?.['AxisPos']);
  }

  private buildActive(c: Candidate, reachable: boolean): IKEditActive {
    const t = c.target;
    return {
      path: this.viewer?.registry?.getPathForNode(c.node) ?? c.node.uuid,
      name: c.node.name || 'Target',
      interpolation: t.InterpolationToTarget,
      speedToTarget: t.SpeedToTarget,
      linearSpeed: t.LinearSpeedToTarget,
      linearAccel: t.LinearAcceleration,
      enableBlending: t.EnableBlending,
      blendRadius: t.BlendRadius,
      waitForSeconds: t.WaitForSeconds,
      pickAndPlace: t.PickAndPlace,
      reachable,
      solutionCount: this._activeSolutions.length,
      solutionIndex: this._activeSolutionIdx,
      ...this.computePose(c),
    };
  }

  private setProp<K extends keyof IKEditValues>(field: K, value: IKEditValues[K]): void {
    const c = this.active;
    const t = c?.target;
    if (!c || !t) return;
    const fieldName = IK_FIELD_MAP[field];
    const prev = (t as unknown as Record<string, unknown>)[fieldName];
    // Optimistic instance write so the 3D view (e.g. segment color) updates now;
    // the setField op below re-applies the schema and persists it.
    switch (field) {
      case 'interpolation': t.InterpolationToTarget = value as RVIKTarget['InterpolationToTarget']; break;
      case 'speedToTarget': t.SpeedToTarget = value as number; break;
      case 'linearSpeed': t.LinearSpeedToTarget = value as number; break;
      case 'linearAccel': t.LinearAcceleration = value as number; break;
      case 'enableBlending': t.EnableBlending = value as boolean; break;
      case 'blendRadius': t.BlendRadius = value as number; break;
      case 'waitForSeconds': t.WaitForSeconds = value as number; break;
      case 'pickAndPlace': t.PickAndPlace = value as boolean; break;
    }
    ikEditStore.updateValues({ [field]: value } as Partial<IKEditValues>);
    const nodePath = this.viewer?.registry?.getPathForNode(c.node);
    if (nodePath) persistFieldOp(nodePath, 'IKTarget', fieldName, value, prev);
  }

  private deleteActiveTarget(): void {
    const c = this.active;
    const reg = this.viewer?.registry;
    const store = getSceneStore();
    if (!c) return;
    const idx = c.ikPath.targets.indexOf(c.target);
    if (idx >= 0) c.ikPath.removeTarget(idx); // optimistic runtime removal

    const ikNodePath = reg?.getPathForNode(c.ikPath.node);
    const targetPath = reg ? reg.getPathForNode(c.node) : null;
    const rawPath = (c.ikPath.node.userData?.realvirtual as Record<string, Record<string, unknown>> | undefined)?.['IKPath']?.['Path'];
    if (store && reg && ikNodePath && targetPath && Array.isArray(rawPath)) {
      // Rewrite IKPath.Path without the deleted target (matched by node → robust
      // against dedup-renames / runtime reorders).
      const next = (rawPath as unknown[]).filter((r) => !(isRef(r) && reg.getNode((r as ComponentRef).path) === c.node));
      const isAdded = !!(c.node.userData as Record<string, unknown>)['__rvAdded'];
      const pathOp = { id: freshOpId(), ts: Date.now(), schemaV: 1 as const, kind: 'setField' as const, nodePath: ikNodePath, componentType: 'IKPath', fieldName: 'Path', value: next, prev: rawPath };
      if (isAdded) {
        // Added node: also remove it (and cancel its addNode) so it doesn't
        // resurrect on reload. Original GLB nodes only get dropped from the path.
        const spec = this.specFromNode(c.node, targetPath);
        void store.withTransaction('Delete path point', async () => {
          await store.applyOp(pathOp);
          await store.applyOp({ id: freshOpId(), ts: Date.now(), schemaV: 1, kind: 'removeNode', nodePath: targetPath, spec });
        });
      } else {
        void store.applyOp(pathOp);
      }
    }
    this.hideGizmo();
    this.refresh();
  }

  /** Insert a new waypoint before/after the active one and persist it (addNode +
   *  IKPath.Path setField). Pose = midpoint to the neighbor (or a nudge from the
   *  active point); AxisPos is pre-solved so replay works without the solver. */
  private addPathpoint(where: 'before' | 'after'): void {
    const viewer = this.viewer;
    const c = this.active;
    const reg = viewer?.registry;
    const store = getSceneStore();
    if (!viewer || !reg || !c || !store) return;
    const idx = c.ikPath.targets.indexOf(c.target);
    if (idx < 0) return;

    // New world pose: midpoint to the neighbor, or a small nudge if none.
    const pA = new Vector3(), qA = new Quaternion(), sA = new Vector3();
    c.node.matrixWorld.decompose(pA, qA, sA);
    const neighbor = c.ikPath.targets[where === 'before' ? idx - 1 : idx + 1]?.node ?? null;
    if (neighbor) {
      const pB = new Vector3(), qB = new Quaternion(), sB = new Vector3();
      neighbor.matrixWorld.decompose(pB, qB, sB);
      pA.lerp(pB, 0.5); qA.slerp(qB, 0.5);
    } else {
      pA.addScaledVector(new Vector3(1, 0, 0).applyQuaternion(qA), 0.15 * (sA.x || 1));
    }
    const newWorld = new Matrix4().compose(pA, qA, sA);

    // Pre-solve AxisPos (so AxisPos-replay works in builds without the solver).
    // Gated by the same per-robot free-tier claim as live re-solving (§11-A3): a
    // robot beyond the free limit just stores an empty AxisPos (replay still works).
    let axisPos: number[] = [];
    // claimLiveSolve already returns false when tier === 'none' (== !available),
    // so the extra `available &&` guard is redundant.
    if (ikSolverRegistry.claimLiveSolve(c.robot.node.uuid)) {
      targetPoseInBase(c.robot.node.matrixWorld, newWorld, this._p3, this._q4);
      for (let i = 0; i < 6; i++) this._seed[i] = c.drives[i]?.currentPosition ?? 0;
      const sols = this.solveFor(c, this._seed); // wrist-type routing (Cobot vs Pieper)
      const best = sols ? ikSolverRegistry.selectClosest(sols, this._seed) : null;
      if (best) axisPos = [...best];
    }

    // Local transform under the (frozen) parent.
    const parent = c.node.parent;
    const parentPath = parent ? reg.getPathForNode(parent) : null;
    if (!parent || !parentPath) return;
    const local = new Matrix4().copy(parent.matrixWorld).invert().multiply(newWorld);
    const lp = new Vector3(), lq = new Quaternion(), ls = new Vector3();
    local.decompose(lp, lq, ls);

    // Inherit the active target's IKTarget fields (minus per-point refs), set AxisPos.
    const srcRaw = (c.node.userData?.realvirtual as Record<string, Record<string, unknown>> | undefined)?.['IKTarget'] ?? {};
    const comp: Record<string, unknown> = { ...srcRaw };
    for (const k of ['gripTarget', 'fixer', 'SetSignal', 'WaitForSignal']) delete comp[k];
    comp['AxisPos'] = axisPos;

    const name = `Target_${Date.now().toString(36)}`;
    const nodePath = parentPath + '/' + name;
    const spec: RuntimeNodeSpec = {
      parentPath, name,
      position: [lp.x, lp.y, lp.z], quaternion: [lq.x, lq.y, lq.z, lq.w], scale: [ls.x, ls.y, ls.z],
      components: { IKTarget: comp },
    };

    // New Path order with the inserted ref.
    const ikNodePath = reg.getPathForNode(c.ikPath.node);
    const rawPath = ((c.ikPath.node.userData?.realvirtual as Record<string, Record<string, unknown>> | undefined)?.['IKPath']?.['Path'] as unknown[]) ?? [];
    if (!ikNodePath) return;
    const insertAt = where === 'before' ? idx : idx + 1;
    const nextPath = [...rawPath];
    nextPath.splice(insertAt, 0, { type: 'ComponentReference', path: nodePath });

    // Order matters: setField(Path) first so addNode's rebuildIKPaths sees the ref.
    void store.withTransaction(where === 'before' ? 'Insert path point' : 'Add path point', async () => {
      await store.applyOp({ id: freshOpId(), ts: Date.now(), schemaV: 1, kind: 'setField', nodePath: ikNodePath, componentType: 'IKPath', fieldName: 'Path', value: nextPath, prev: rawPath });
      await store.applyOp({ id: freshOpId(), ts: Date.now(), schemaV: 1, kind: 'addNode', nodePath, spec });
    }).then(() => {
      this.refresh();
      // Jump straight to the new waypoint (gizmo + quick-edit follow it).
      this.activateByPath(nodePath);
    });
  }

  /** Activate the candidate whose node sits at `nodePath` (after refresh()). */
  private activateByPath(nodePath: string): void {
    const node = this.viewer?.registry?.getNode(nodePath);
    if (!node) return;
    const c = this.candidates.find((x) => x.node === node);
    if (c) this.activate(c);
  }

  /** Reconstruct a RuntimeNodeSpec from a live op-created node (for removeNode undo). */
  private specFromNode(node: Object3D, nodePath: string): RuntimeNodeSpec {
    const parentPath = nodePath.slice(0, nodePath.lastIndexOf('/'));
    const components = deepCloneJSON((node.userData?.realvirtual ?? {}) as Record<string, Record<string, unknown>>);
    delete (components as Record<string, unknown>)['__rvAdded'];
    return {
      parentPath, name: node.name,
      position: [node.position.x, node.position.y, node.position.z],
      quaternion: [node.quaternion.x, node.quaternion.y, node.quaternion.z, node.quaternion.w],
      scale: [node.scale.x, node.scale.y, node.scale.z],
      components,
    };
  }

  /** Rebuild candidates / ghosts / path visualizer after a structural change. */
  private refresh(): void {
    if (this.viewer && this._lastSnap) this.viewer.emit('selection-changed', this._lastSnap);
  }

  private pickHandle(e: PointerEvent): Handle | null {
    if (!this.gizmo) return null;
    this.gizmo.updateMatrixWorld(true); // ensure latest position/scale before raycast
    this.setNdc(e); this.raycaster.setFromCamera(this.ndc, this.viewer!.camera);
    let best: { h: Handle; d: number } | null = null;
    let bestRing: { h: Handle; d: number } | null = null;
    for (const hit of this.raycaster.intersectObject(this.gizmo, true)) {
      const h = hit.object.userData?.gizmoHandle as Handle | undefined;
      if (!h) continue;
      if (!best) best = { h, d: hit.distance };
      if (!bestRing && h.length === 2) bestRing = { h, d: hit.distance };
      if (best && bestRing) break;
    }
    if (!best) return null;
    // Rings are the thinnest target and share screen space with the axis and
    // centre pickers crossing them — prefer a ring hit unless the other handle
    // is clearly in front of it.
    const eps = 0.2 * (this.gizmo.scale.x || 1);
    if (bestRing && bestRing.d <= best.d + eps) return bestRing.h;
    return best.h;
  }

  /** Raycast the robot subtrees and return the RobotIK whose mesh was hit, or null. */
  private pickRobot(e: PointerEvent): RVRobotIK | null {
    const viewer = this.viewer; if (!viewer?.registry) return null;
    const robots = viewer.registry.getAll<RVRobotIK>('RobotIK');
    if (!robots.length) return null;
    this.setNdc(e); this.raycaster.setFromCamera(this.ndc, viewer.camera);
    const hits = this.raycaster.intersectObjects(robots.map((r) => r.instance.node), true);
    return hits.length ? viewer.registry.findInParent<RVRobotIK>(hits[0].object, 'RobotIK') : null;
  }

  // ── Tool ghosts (one per pathpoint; shown when the path is selected but no point is edited) ──

  private buildGhosts(): void {
    const viewer = this.viewer; if (!viewer) return;
    if (!this.ghostMat) this.ghostMat = new MeshBasicMaterial({ color: 0x33d6ff, transparent: true, opacity: 0.25, depthWrite: false });
    for (const c of this.candidates) {
      const axis6 = c.drives[5]?.node;
      if (!axis6) continue;
      // Solve this waypoint (seeded with its stored AxisPos → the ghost shows the
      // REPLAY configuration) and snapshot the REAL axis-6 world pose → the ghost
      // is oriented exactly like the robot's flange/tool at that target.
      this.resolve(c, this.replaySeed(c));
      axis6.updateWorldMatrix(true, false);
      const clone = axis6.clone(true); // shares geometry refs with the real robot — never dispose it
      clone.position.set(0, 0, 0); clone.quaternion.identity(); clone.scale.set(1, 1, 1);
      clone.traverse((o) => { const m = o as Mesh; if (m.isMesh) m.material = this.ghostMat!; });
      const ghost = new Group(); ghost.name = '__rvIKGhost'; ghost.add(clone);
      axis6.matrixWorld.decompose(ghost.position, ghost.quaternion, ghost.scale);
      ghost.visible = false;
      viewer.scene.add(ghost);
      this.ghosts.set(c, ghost);
    }
    // Leave the robot at the first waypoint (tidy starting pose).
    if (this.candidates[0]) this.resolve(this.candidates[0], this.replaySeed(this.candidates[0]));
  }

  private setGhostsVisible(v: boolean): void {
    for (const g of this.ghosts.values()) g.visible = v;
  }

  /** Remove ghost groups from the scene. Geometry is shared with the robot — do NOT dispose it. */
  private clearGhosts(): void {
    if (this.viewer) for (const g of this.ghosts.values()) this.viewer.scene.remove(g);
    this.ghosts.clear();
  }

  // ── Helpers ──

  private withinCanvas(e: PointerEvent): boolean {
    const el = this.viewer?.renderer.domElement; if (!el) return false;
    const r = el.getBoundingClientRect();
    return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
  }

  private setNdc(e: PointerEvent): void {
    const r = this.viewer!.renderer.domElement.getBoundingClientRect();
    this.ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  }

  /** Project a world position to client-pixel coordinates. */
  private screenOf(world: Vector3, out: [number, number]): [number, number] {
    const r = this.viewer!.renderer.domElement.getBoundingClientRect();
    this._wtmp.copy(world).project(this.viewer!.camera);
    ndcToScreen(this._wtmp.x, this._wtmp.y, r, _screenPt);
    out[0] = _screenPt.x;
    out[1] = _screenPt.y;
    return out;
  }

  private closestOnAxis(axisO: Vector3, axisD: Vector3, rayO: Vector3, rayD: Vector3): number {
    this._v.subVectors(axisO, rayO);
    const b = axisD.dot(rayD), c = rayD.dot(rayD), d = axisD.dot(this._v), e2 = rayD.dot(this._v);
    const denom = c - b * b;
    return denom !== 0 ? (b * e2 - c * d) / denom : 0;
  }

  private nearestCandidate(e: PointerEvent): Candidate | null {
    const viewer = this.viewer!;
    const r = viewer.renderer.domElement.getBoundingClientRect();
    const px = e.clientX - r.left, py = e.clientY - r.top;
    let best: Candidate | null = null, bestD = GRAB_RADIUS_PX;
    for (const c of this.candidates) {
      this.worldPos(c.node, this._v).project(viewer.camera);
      if (this._v.z > 1) continue;
      const sx = (this._v.x * 0.5 + 0.5) * r.width, sy = (-this._v.y * 0.5 + 0.5) * r.height;
      const dd = Math.hypot(sx - px, sy - py);
      if (dd < bestD) { bestD = dd; best = c; }
    }
    return best;
  }

  // ── Re-solve and apply ──

  /** Solve the pose in this._p3/this._q4 (set via targetPoseInBase beforehand),
   *  routed by wrist type (plan-233 Phase 2): NonSpherical robots use the
   *  numerical Cobot solver — with the OPW params as analytic cold-start and
   *  (optionally) `warmStart` joint angles — when a pro solver and a valid
   *  joint chain exist; everything else falls back to the analytic Pieper
   *  solve. No allocation in the drag hot path (reused opts/warm). */
  private solveFor(c: Candidate, warmStart: readonly number[] | null): IKSolution[] | null {
    if (c.robot.WristType === 'NonSpherical' && ikSolverRegistry.canSolveCobot) {
      const chain = c.robot.getJointChain();
      if (chain) {
        if (warmStart) {
          for (let i = 0; i < 6; i++) this._warm[i] = warmStart[i] ?? 0;
        }
        this._cobotOpts.opw = c.params;
        this._cobotOpts.warmStart = warmStart ? this._warm : undefined;
        return ikSolverRegistry.solveCobot(chain, this._p3, this._q4, this._cobotOpts);
      }
    }
    return ikSolverRegistry.solvePieper(c.params, this._p3, this._q4);
  }

  /** Re-solve the robot to the candidate's pose and apply the configuration
   *  closest to `seed` (default: current drive angles — drag continuity). Also
   *  keeps the active point's reachable-solution set for the quick-edit stepper.
   *  Returns true if reachable. matrixWorld is read directly (robot root may be
   *  frozen → updateWorldMatrix corrupts). */
  private resolve(c: Candidate, seed?: readonly number[]): boolean {
    // Free-tier limit (plan-233 §11-A3): only the first `maxRobots` robots get
    // live re-solving; further robots fall back to AxisPos replay. Claim is keyed
    // by the robot node uuid (stable per scene) and reset on model clear.
    if (!ikSolverRegistry.claimLiveSolve(c.robot.node.uuid)) return false;
    targetPoseInBase(c.robot.node.matrixWorld, c.node.matrixWorld, this._p3, this._q4);
    // _seed doubles as Cobot warm start AND closest-selection reference.
    for (let i = 0; i < 6; i++) this._seed[i] = (seed ? seed[i] : c.drives[i].currentPosition) ?? 0;
    const solutions = this.solveFor(c, this._seed);
    this.refreshSolutionList(c, solutions);
    const best = solutions ? ikSolverRegistry.selectClosest(solutions, this._seed) : null;
    if (c === this.active) this._activeSolutionIdx = best ? closestSolutionIndex(this._activeSolutions, best) : -1;
    if (!best) return false;
    this.applyAngles(c, best);
    return true;
  }

  /** Rebuild the stepper's solution list for the ACTIVE point. Pieper returns
   *  the full 8-branch set on every solve, but the numerical Cobot solver
   *  EARLY-EXITS once the warm start converges (one reachable slot) — the
   *  branch variety only comes from a COLD solve. That extra solve is skipped
   *  in the drag hot path (the list from activation stays; it refreshes on
   *  drag end / pose edits via the post-drag resolve). */
  private refreshSolutionList(c: Candidate, warmSolutions: IKSolution[] | null): void {
    if (c !== this.active) return;
    if (c.robot.WristType === 'NonSpherical' && ikSolverRegistry.canSolveCobot) {
      if (this.drag) return; // keep the last cold list while dragging
      const cold = this.solveFor(c, null);
      this._activeSolutions = cold ? reachableSolutions(cold) : [];
      return;
    }
    this._activeSolutions = warmSolutions ? reachableSolutions(warmSolutions) : [];
  }

  /** Drive all six axes to the given joint angles (preview pose). */
  private applyAngles(c: Candidate, angles: readonly number[]): void {
    for (let i = 0; i < 6; i++) { const d = c.drives[i]; d.positionOverwrite = true; d.currentPosition = angles[i] ?? 0; d.applyToNode(); }
  }
}

// ── Module helpers ──

const WORLD_DOWN = new Vector3(0, -1, 0);

function tripleEq(a: readonly number[], b: readonly number[]): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

// Δ-readout formatters (scene units are meters; robotics reads mm).

function fmtMm(m: number): string {
  const mm = m * 1000;
  return `${mm >= 0 ? '+' : ''}${mm.toFixed(0)} mm`;
}

function fmtDeg(rad: number): string {
  const deg = (rad * 180) / Math.PI;
  return `${deg >= 0 ? '+' : ''}${deg.toFixed(1)}°`;
}
