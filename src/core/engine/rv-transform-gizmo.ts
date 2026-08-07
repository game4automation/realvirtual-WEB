// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-transform-gizmo.ts — Reusable translate/rotate gizmo (IK-gizmo design).
 *
 * Extracted from the IK path control-point gizmo (ik-target-edit-plugin.ts):
 * three axis arrows + three rotation rings + a centre free-move sphere in the
 * planner/IK design language, screen-space constant size, rendered on
 * HIGHLIGHT_OVERLAY_LAYER (after the EffectComposer) so it never receives
 * SSAO halos or selection outlines, with a cursor-anchored Δ-readout and
 * Shift-snapping (10 mm translate / 90° rotate).
 *
 * Unlike the IK plugin's inline gizmo this class is generic: it attaches to
 * ANY set of nodes. Single node → the gizmo aligns to the node's local frame;
 * multiple nodes → pivot at the world-position centroid with world axes, and
 * drags apply the world-space delta to every node (rotation orbits the
 * non-pivot nodes around the pivot axis).
 *
 * The caller owns persistence: `onDragStart` fires after the nodes' local
 * transforms are made writable (snapshot `prev` there), `onDragEnd(moved)`
 * fires after the pointer is released (commit ops there).
 *
 * Pointer handling is capture-phase on window: a press on a handle claims the
 * event (stopPropagation) so marquee/selection/orbit never see it.
 */

import {
  Box3, ConeGeometry, CylinderGeometry, DoubleSide, Group, Matrix4, Mesh,
  MeshBasicMaterial, Plane, Quaternion, Raycaster, SphereGeometry,
  TorusGeometry, Vector2, Vector3,
  type BufferGeometry, type Camera, type Object3D, type Scene,
} from 'three';
import { HIGHLIGHT_OVERLAY_LAYER } from './rv-group-registry';
import { ensureMovableTransform } from './rv-node-transform';
import { disposeSubtree } from './rv-traverse-utils';

export type TransformGizmoHandle = 'x' | 'y' | 'z' | 'center' | 'rx' | 'ry' | 'rz';

/**
 * Where the gizmo anchors on the attached nodes (Unity's Pivot/Center toggle):
 * 'pivot' = the node origin / multi-select centroid of origins (default);
 * 'center' = the world bounding-box center of the whole selection. All handles
 * use the anchor — rotation orbits the nodes around it.
 */
export type GizmoPivotMode = 'pivot' | 'center';

/** Everything the gizmo needs from its host — RVViewer satisfies this. */
export interface TransformGizmoHost {
  readonly camera: Camera;
  readonly renderer: { domElement: HTMLCanvasElement };
  readonly scene: Scene;
  readonly controls: { enabled: boolean };
  markRenderDirty(): void;
  markShadowsDirty(): void;
}

export interface TransformGizmoCallbacks {
  /** Drag begins — node local transforms are already writable; snapshot `prev` here. */
  onDragStart?(nodes: readonly Object3D[]): void;
  /** Fired after every applied pointer move. */
  onChange?(): void;
  /** Pointer released. `moved` is false for a click without motion. */
  onDragEnd?(nodes: readonly Object3D[], moved: boolean): void;
}

// ── Design language (identical to the IK control-point gizmo) ──
const GIZMO_SCREEN_SCALE = 0.115;
const AX: Record<'x' | 'y' | 'z', Vector3> = {
  x: new Vector3(1, 0, 0), y: new Vector3(0, 1, 0), z: new Vector3(0, 0, 1),
};
const AXIS_COLOR: Record<'x' | 'y' | 'z', number> = { x: 0xe03131, y: 0x2f9e44, z: 0x1971c2 };
const AXIS_COLOR_HOVER: Record<'x' | 'y' | 'z', number> = { x: 0xff6b6b, y: 0x69db7c, z: 0x4dabf7 };
const CENTER_COLOR = 0x4fc34f;
const RING_OPACITY_IDLE = 0.75;
const CENTER_OPACITY_IDLE = 0.5;
const CENTER_OPACITY_HOVER = 0.9;
/** Translation snap step with Shift held (meters). */
const TRANSLATE_SNAP_M = 0.01; // 10 mm
/** Rotation snap step with Shift held (radians). */
const ROTATE_SNAP_RAD = Math.PI / 2; // 90°

/** Rotate cursor (inline SVG) — same glyph as planner FloorGizmo / IK gizmo. */
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

/** Per-node world-space baseline captured at drag start. */
interface NodeBaseline {
  node: Object3D;
  startWorldPos: Vector3;
  startWorldQuat: Quaternion;
  /** parent.matrixWorld⁻¹ at drag start (parents don't move during the drag). */
  parentInv: Matrix4;
  parentQuatInv: Quaternion;
}

interface Drag {
  kind: 'axis' | 'plane' | 'rotate';
  handle: TransformGizmoHandle;
  axisDir: Vector3;
  startPivot: Vector3;
  startPivotQuat: Quaternion;
  plane: Plane;
  grab: number;
  offset: Vector3;
  baselines: NodeBaseline[];
  /** Rotate drag: screen-space swept-angle control (wrap-safe past ±180°). */
  centerPx: [number, number];
  lastPtrAngle: number;
  accumAngle: number;
  rotSign: 1 | -1;
}

export class TransformGizmo {
  private readonly host: TransformGizmoHost;
  private readonly callbacks: TransformGizmoCallbacks;

  private root: Group | null = null;
  private nodes: Object3D[] = [];
  private drag: Drag | null = null;
  private _pivotMode: GizmoPivotMode = 'pivot';
  /** Per attached node: its subtree bounds in the NODE's local space, cached at
   *  attach (geometry doesn't change while attached; transforms are applied per
   *  render via matrixWorld). `null` = no geometry → fall back to the origin. */
  private readonly _localBoxes = new Map<Object3D, Box3 | null>();
  private prevControlsEnabled = true;
  private _dragMoved = false;
  private _hovered: TransformGizmoHandle | null = null;
  private readonly _handleMats = new Map<TransformGizmoHandle, MeshBasicMaterial>();
  private _readoutEl: HTMLDivElement | null = null;
  private _listening = false;

  private readonly raycaster = new Raycaster();
  private readonly ndc = new Vector2();
  private readonly _v = new Vector3();
  private readonly _v2 = new Vector3();
  private readonly _hit = new Vector3();
  private readonly _mat = new Matrix4();
  private readonly _q = new Quaternion();
  private readonly _q2 = new Quaternion();
  private readonly _dPos = new Vector3();
  private readonly _dScl = new Vector3();
  private readonly _box = new Box3();
  private readonly _box2 = new Box3();

  constructor(host: TransformGizmoHost, callbacks: TransformGizmoCallbacks = {}) {
    this.host = host;
    this.callbacks = callbacks;
    // Capture-phase: claims handle grabs before marquee/selection handlers.
    window.addEventListener('pointerdown', this._onPointerDown as EventListener, true);
  }

  dispose(): void {
    this.endDrag();
    this.detach();
    window.removeEventListener('pointerdown', this._onPointerDown as EventListener, true);
    this._setMoveListeners(false);
    this.removeReadout();
    if (this.root) {
      this.host.scene.remove(this.root);
      disposeSubtree(this.root);
      this.root = null;
    }
    this._handleMats.clear();
  }

  // ── Attach / detach ─────────────────────────────────────────────────

  /** Attach to one or more nodes. Single node → local frame; multi → centroid + world axes. */
  attach(nodes: Object3D[]): void {
    if (this.drag) this.endDrag();
    this.nodes = nodes.slice();
    if (nodes.length === 0) { this.detach(); return; }
    this._localBoxes.clear();
    for (const n of nodes) this._localBoxes.set(n, computeLocalBox(n));
    const g = this._ensureRoot();
    this._syncPivotFromNodes();
    g.visible = true;
    this._setMoveListeners(true);
    this.host.markRenderDirty();
  }

  detach(): void {
    if (this.drag) this.endDrag();
    this.nodes = [];
    this._localBoxes.clear();
    if (this.root) this.root.visible = false;
    this._setMoveListeners(false);
    this.setHovered(null);
    this.host.markRenderDirty();
  }

  /** Anchor policy — see {@link GizmoPivotMode}. Takes effect immediately
   *  (outside a drag; a running drag keeps its captured pivot). */
  get pivotMode(): GizmoPivotMode { return this._pivotMode; }
  set pivotMode(mode: GizmoPivotMode) {
    if (mode === this._pivotMode) return;
    this._pivotMode = mode;
    if (!this.drag) this._syncPivotFromNodes();
    this.host.markRenderDirty();
  }

  get attachedNodes(): readonly Object3D[] { return this.nodes; }
  get isDragging(): boolean { return this.drag !== null; }
  /** True while dragging or hovering a handle — marquee/select must stand down. */
  get isEngaged(): boolean { return this.drag !== null || this._hovered !== null; }

  /**
   * Per-render update: screen-constant scale, and (outside a drag) re-sync the
   * pivot from the nodes so external transforms (undo/redo, inspector edits)
   * move the gizmo along.
   */
  update(): void {
    const g = this.root;
    if (!g || !g.visible) return;
    if (!this.drag) this._syncPivotFromNodes();
    g.scale.setScalar(this.host.camera.position.distanceTo(g.position) * GIZMO_SCREEN_SCALE);
  }

  // ── World read that respects frozen/baked matrixWorld ──────────────

  private worldPos(node: Object3D, out: Vector3): Vector3 {
    return out.setFromMatrixPosition(node.matrixWorld);
  }
  private worldQuat(node: Object3D, out: Quaternion): Quaternion {
    node.matrixWorld.decompose(this._dPos, out, this._dScl);
    return out;
  }

  /**
   * Anchor position by {@link pivotMode}: node origin / centroid of origins
   * ('pivot'), or the selection's world bounding-box center ('center').
   * Orientation is mode-independent: single node → its local frame; multi →
   * world axes.
   */
  private _syncPivotFromNodes(): void {
    const g = this.root;
    if (!g || this.nodes.length === 0) return;

    if (this._pivotMode === 'center') {
      // Cached local boxes → world AABB per render (8-corner transform per
      // node — no subtree traversal in the render loop).
      this._box.makeEmpty();
      for (const n of this.nodes) {
        const local = this._localBoxes.get(n);
        if (local) this._box.union(this._box2.copy(local).applyMatrix4(n.matrixWorld));
        else this._box.expandByPoint(this.worldPos(n, this._v2));
      }
      if (!this._box.isEmpty()) g.position.copy(this._box.getCenter(this._v));
      else g.position.copy(this.worldPos(this.nodes[0], this._v));
    } else if (this.nodes.length === 1) {
      g.position.copy(this.worldPos(this.nodes[0], this._v));
    } else {
      this._v.set(0, 0, 0);
      for (const n of this.nodes) this._v.add(this.worldPos(n, this._v2));
      g.position.copy(this._v.divideScalar(this.nodes.length));
    }

    if (this.nodes.length === 1) g.quaternion.copy(this.worldQuat(this.nodes[0], this._q));
    else g.quaternion.identity();
  }

  // ── Pointer handling (capture phase) ────────────────────────────────

  private readonly _onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0 || !this.root?.visible || this.nodes.length === 0) return;
    if (!this.withinCanvas(e)) return;
    const handle = this.pickHandle(e);
    if (!handle) return;
    e.stopPropagation();
    e.preventDefault();
    this.beginDrag(e, handle);
  };

  private beginDrag(e: PointerEvent, handle: TransformGizmoHandle): void {
    const host = this.host;
    const g = this.root!;
    // Make every node's local transform writable BEFORE the caller snapshots prev.
    for (const node of this.nodes) ensureMovableTransform(node);
    try { this.callbacks.onDragStart?.(this.nodes); } catch (err) { console.warn('[TransformGizmo] onDragStart failed:', err); }

    this.prevControlsEnabled = host.controls.enabled;
    host.controls.enabled = false;

    const startPivot = g.position.clone();
    const startPivotQuat = g.quaternion.clone();
    this.setNdc(e);
    this.raycaster.setFromCamera(this.ndc, host.camera);

    const baselines: NodeBaseline[] = this.nodes.map((node) => {
      const parentInv = new Matrix4();
      const parentQuatInv = new Quaternion();
      if (node.parent) {
        parentInv.copy(node.parent.matrixWorld).invert();
        this.worldQuat(node.parent, parentQuatInv).invert();
      }
      return {
        node,
        startWorldPos: this.worldPos(node, new Vector3()).clone(),
        startWorldQuat: this.worldQuat(node, new Quaternion()).clone(),
        parentInv,
        parentQuatInv,
      };
    });

    const d: Drag = {
      kind: 'plane', handle, axisDir: new Vector3(),
      startPivot, startPivotQuat,
      plane: new Plane(), grab: 0, offset: new Vector3(), baselines,
      centerPx: [0, 0], lastPtrAngle: 0, accumAngle: 0, rotSign: 1,
    };
    if (handle === 'center') {
      d.kind = 'plane';
      d.plane.setFromNormalAndCoplanarPoint(host.camera.getWorldDirection(new Vector3()), startPivot);
      if (this.raycaster.ray.intersectPlane(d.plane, this._hit)) d.offset.subVectors(startPivot, this._hit);
    } else if (handle === 'x' || handle === 'y' || handle === 'z') {
      // Axis in the pivot frame (single: node local frame; multi: world axes).
      d.kind = 'axis';
      d.axisDir.copy(AX[handle]).applyQuaternion(startPivotQuat).normalize();
      d.grab = this.closestOnAxis(startPivot, d.axisDir, this.raycaster.ray.origin, this.raycaster.ray.direction);
    } else {
      d.kind = 'rotate';
      d.axisDir.copy(AX[handle[1] as 'x' | 'y' | 'z']).applyQuaternion(startPivotQuat).normalize();
      // Screen-space swept-angle control (a ring-plane raycast degenerates for
      // edge-on rings — see the IK gizmo, same approach).
      this.screenOf(startPivot, d.centerPx);
      d.lastPtrAngle = Math.atan2(e.clientY - d.centerPx[1], e.clientX - d.centerPx[0]);
      this._v.subVectors(host.camera.position, startPivot);
      d.rotSign = d.axisDir.dot(this._v) >= 0 ? -1 : 1;
    }
    this.drag = d;
    this._dragMoved = false;
    this.refreshHandleColors();
    host.renderer.domElement.style.cursor = 'grabbing';
    this.showReadout(e);
    try { host.renderer.domElement.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  }

  private readonly _onPointerMove = (e: PointerEvent): void => {
    const host = this.host;
    if (!this.drag) {
      // Hover feedback: highlight handle + cursor hint.
      if (!this.root?.visible) return;
      const over = this.withinCanvas(e) ? this.pickHandle(e) : null;
      this.setHovered(over);
      host.renderer.domElement.style.cursor = over
        ? (over === 'rx' || over === 'ry' || over === 'rz' ? CURSOR_ROTATE : 'move')
        : '';
      return;
    }
    e.stopPropagation();
    this.setNdc(e);
    this.raycaster.setFromCamera(this.ndc, host.camera);
    const d = this.drag;
    const g = this.root!;

    if (d.kind === 'rotate') {
      const ptr = Math.atan2(e.clientY - d.centerPx[1], e.clientX - d.centerPx[0]);
      let inc = ptr - d.lastPtrAngle;
      if (inc > Math.PI) inc -= 2 * Math.PI; else if (inc < -Math.PI) inc += 2 * Math.PI;
      d.accumAngle += inc;
      d.lastPtrAngle = ptr;
      let angle = d.rotSign * d.accumAngle;
      if (e.shiftKey) angle = Math.round(angle / ROTATE_SNAP_RAD) * ROTATE_SNAP_RAD;
      this.updateReadout(e, `Δ ${fmtDeg(angle)}`);
      this._q.setFromAxisAngle(d.axisDir, angle); // world-space delta rotation
      for (const b of d.baselines) {
        // Orbit position around the pivot + rotate orientation.
        this._v.subVectors(b.startWorldPos, d.startPivot).applyQuaternion(this._q).add(d.startPivot);
        this._q2.copy(this._q).multiply(b.startWorldQuat); // new world quat
        this._applyWorld(b, this._v, this._q2);
      }
      // Single node: gizmo rings follow the object's frame (IK behavior).
      if (d.baselines.length === 1) {
        g.quaternion.copy(this._q.setFromAxisAngle(d.axisDir, angle).multiply(d.startPivotQuat));
      }
    } else {
      if (d.kind === 'axis') {
        const s = this.closestOnAxis(d.startPivot, d.axisDir, this.raycaster.ray.origin, this.raycaster.ray.direction);
        let delta = s - d.grab;
        if (e.shiftKey) delta = Math.round(delta / TRANSLATE_SNAP_M) * TRANSLATE_SNAP_M;
        this._v.copy(d.startPivot).addScaledVector(d.axisDir, delta);
        this.updateReadout(e, `Δ${d.handle} ${fmtMm(delta)}`);
      } else {
        if (!this.raycaster.ray.intersectPlane(d.plane, this._hit)) return;
        this._v.addVectors(this._hit, d.offset);
        if (e.shiftKey) {
          this._v.x = Math.round(this._v.x / TRANSLATE_SNAP_M) * TRANSLATE_SNAP_M;
          this._v.y = Math.round(this._v.y / TRANSLATE_SNAP_M) * TRANSLATE_SNAP_M;
          this._v.z = Math.round(this._v.z / TRANSLATE_SNAP_M) * TRANSLATE_SNAP_M;
        }
        this.updateReadout(e, `Δ ${fmtMm(this._v2.subVectors(this._v, d.startPivot).length())}`);
      }
      // World-space translation delta applied to every node.
      this._v2.subVectors(this._v, d.startPivot);
      for (const b of d.baselines) {
        this._hit.addVectors(b.startWorldPos, this._v2);
        this._applyWorld(b, this._hit, null);
      }
      g.position.copy(this._v);
    }
    this._dragMoved = true;
    try { this.callbacks.onChange?.(); } catch (err) { console.warn('[TransformGizmo] onChange failed:', err); }
    host.markRenderDirty();
  };

  /** Write a world pose onto a node as parent-local TRS and refresh matrices.
   *  Writes straight into node.position/quaternion — no shared temps, so the
   *  passed vectors may alias the class scratch objects. */
  private _applyWorld(b: NodeBaseline, worldPos: Vector3, worldQuat: Quaternion | null): void {
    const node = b.node;
    node.position.copy(worldPos).applyMatrix4(b.parentInv);
    if (worldQuat) node.quaternion.copy(b.parentQuatInv).multiply(worldQuat);
    node.updateMatrix();
    // Recurse with force so child matrixWorlds follow (editor assets load with
    // preserveHierarchy — subtrees are not frozen).
    node.updateMatrixWorld(true);
  }

  private readonly _onPointerUp = (e: PointerEvent): void => {
    if (!this.drag) return;
    e.stopPropagation();
    try { this.host.renderer.domElement.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    const moved = this._dragMoved;
    const nodes = this.drag.baselines.map((b) => b.node);
    this.endDrag();
    this.host.markShadowsDirty();
    try { this.callbacks.onDragEnd?.(nodes, moved); } catch (err) { console.warn('[TransformGizmo] onDragEnd failed:', err); }
  };

  private endDrag(): void {
    if (this.drag) this.host.controls.enabled = this.prevControlsEnabled;
    this.drag = null;
    this._dragMoved = false;
    this.removeReadout();
    this.refreshHandleColors();
    this.host.renderer.domElement.style.cursor = '';
    this._syncPivotFromNodes();
  }

  private _setMoveListeners(on: boolean): void {
    if (on === this._listening) return;
    this._listening = on;
    if (on) {
      window.addEventListener('pointermove', this._onPointerMove as EventListener, true);
      window.addEventListener('pointerup', this._onPointerUp as EventListener, true);
    } else {
      window.removeEventListener('pointermove', this._onPointerMove as EventListener, true);
      window.removeEventListener('pointerup', this._onPointerUp as EventListener, true);
    }
  }

  // ── Gizmo geometry (visible + fat invisible pickers) ────────────────

  private _ensureRoot(): Group {
    if (this.root) return this.root;
    const g = new Group();
    g.name = '__rvTransformGizmo';
    this._handleMats.clear();
    const pickMat = () => new MeshBasicMaterial({ visible: true, transparent: true, opacity: 0, depthTest: false, depthWrite: false });

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

    const centerMat = new MeshBasicMaterial({ color: CENTER_COLOR, transparent: true, opacity: CENTER_OPACITY_IDLE, depthTest: false, depthWrite: false });
    this._handleMats.set('center', centerMat);
    const center = new Mesh(new SphereGeometry(0.08, 20, 20), centerMat);
    center.userData.gizmoHandle = 'center';
    g.add(center);

    // Overlay layer: rendered AFTER the EffectComposer — keeps selection
    // outlines / AO / bloom off the gizmo. Also marks the meshes so highlight
    // collection and the marquee's selectable map skip them.
    g.traverse((o) => {
      o.renderOrder = 11000;
      o.layers.set(HIGHLIGHT_OVERLAY_LAYER);
      o.userData._highlightOverlay = true;
    });
    // Raycaster.layers defaults to layer 0 — enable the overlay layer too or
    // pickHandle() silently misses every handle.
    this.raycaster.layers.enable(HIGHLIGHT_OVERLAY_LAYER);
    g.visible = false;
    this.host.scene.add(g);
    this.root = g;
    return g;
  }

  // ── Hover / drag highlighting ───────────────────────────────────────

  private setHovered(h: TransformGizmoHandle | null): void {
    if (this._hovered === h) return;
    this._hovered = h;
    this.refreshHandleColors();
    this.host.markRenderDirty();
  }

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

  // ── Cursor-anchored Δ-readout ───────────────────────────────────────

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

  // ── Picking helpers ─────────────────────────────────────────────────

  private pickHandle(e: PointerEvent): TransformGizmoHandle | null {
    if (!this.root) return null;
    this.root.updateMatrixWorld(true); // latest position/scale before raycast
    this.setNdc(e);
    this.raycaster.setFromCamera(this.ndc, this.host.camera);
    let best: { h: TransformGizmoHandle; d: number } | null = null;
    let bestRing: { h: TransformGizmoHandle; d: number } | null = null;
    for (const hit of this.raycaster.intersectObject(this.root, true)) {
      const h = hit.object.userData?.gizmoHandle as TransformGizmoHandle | undefined;
      if (!h) continue;
      if (!best) best = { h, d: hit.distance };
      if (!bestRing && h.length === 2) bestRing = { h, d: hit.distance };
      if (best && bestRing) break;
    }
    if (!best) return null;
    // Rings are the thinnest target and share screen space with the axis and
    // centre pickers crossing them — prefer a ring hit unless the other handle
    // is clearly in front of it.
    const eps = 0.2 * (this.root.scale.x || 1);
    if (bestRing && bestRing.d <= best.d + eps) return bestRing.h;
    return best.h;
  }

  private withinCanvas(e: PointerEvent): boolean {
    const r = this.host.renderer.domElement.getBoundingClientRect();
    return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
  }

  private setNdc(e: PointerEvent): void {
    const r = this.host.renderer.domElement.getBoundingClientRect();
    this.ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  }

  /** Project a world position to client-pixel coordinates. */
  private screenOf(world: Vector3, out: [number, number]): [number, number] {
    const r = this.host.renderer.domElement.getBoundingClientRect();
    this._v2.copy(world).project(this.host.camera);
    out[0] = r.left + (this._v2.x * 0.5 + 0.5) * r.width;
    out[1] = r.top + (-this._v2.y * 0.5 + 0.5) * r.height;
    return out;
  }

  /** Parameter of the closest point on `axisO + t·axisD` to the given ray. */
  private closestOnAxis(axisO: Vector3, axisD: Vector3, rayO: Vector3, rayD: Vector3): number {
    this._v.subVectors(axisO, rayO);
    const b = axisD.dot(rayD), c = rayD.dot(rayD), d = axisD.dot(this._v), e2 = rayD.dot(this._v);
    const denom = c - b * b;
    return denom !== 0 ? (b * e2 - c * d) / denom : 0;
  }
}

/**
 * Subtree geometry bounds in `node`-local space, for the 'center' pivot mode.
 * One traversal at attach time; per-render the cached box is carried to world
 * space via matrixWorld (conservative under rotation, exact for the center).
 * Returns null when the subtree has no geometry.
 */
function computeLocalBox(node: Object3D): Box3 | null {
  node.updateWorldMatrix(true, false);
  const nodeInv = new Matrix4().copy(node.matrixWorld).invert();
  const toLocal = new Matrix4();
  const meshBox = new Box3();
  const box = new Box3();
  let hasGeometry = false;
  node.traverse((o) => {
    const geometry = (o as Mesh).geometry as BufferGeometry | undefined;
    if (!geometry) return;
    if (!geometry.boundingBox) geometry.computeBoundingBox();
    if (!geometry.boundingBox || geometry.boundingBox.isEmpty()) return;
    toLocal.multiplyMatrices(nodeInv, o.matrixWorld);
    box.union(meshBox.copy(geometry.boundingBox).applyMatrix4(toLocal));
    hasGeometry = true;
  });
  return hasGeometry ? box : null;
}

function fmtMm(m: number): string {
  const mm = m * 1000;
  return `${mm >= 0 ? '+' : ''}${mm.toFixed(0)} mm`;
}

function fmtDeg(rad: number): string {
  const deg = (rad * 180) / Math.PI;
  return `${deg >= 0 ? '+' : ''}${deg.toFixed(1)}°`;
}
