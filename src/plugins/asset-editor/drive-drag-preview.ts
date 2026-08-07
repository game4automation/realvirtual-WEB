// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * drive-drag-preview — the editor's `DriveDragDriver`: previews a drive's motion
 * while its gizmo is dragged, then springs the objects back on release.
 *
 * Safety-first design (nothing here is ever persisted):
 *  - No ops are emitted — this is pure Object3D mutation, so undo/redo and the
 *    document dirty flag are untouched.
 *  - Every moved node's home local transform is snapshotted on drag-start and
 *    restored EXACTLY on release / cancel — no drift.
 *  - No reparenting — a kinematic group's members are moved by a rigid WORLD
 *    delta (the same transform the axis node undergoes), so node paths, the
 *    registry, and signal bindings are never mutated.
 *  - Restores on `asset-editor-pre-export` (so a preview can never bake into a
 *    saved GLB), on selection change, and on dispose (editor deactivate).
 *
 * The axis node's own subtree children follow automatically via Three.js
 * parent-matrix propagation; only group members that are NOT already under the
 * axis need the rigid delta. Whether members are parented depends on load
 * history (kinematic reparenting runs at GLB load but not in a fresh authoring
 * session), so we detect it per member rather than assume.
 */

import { Euler, Matrix4, Quaternion, Vector3 } from 'three';
import type { Object3D } from 'three';
import type { RVViewer } from '../../core/rv-viewer';
import type { DriveDragContext, DriveDragDriver } from '../../core/engine/drive-drag-driver';
import type { NodeTransform } from '../../core/editor/rv-asset-ops';
import { MM_TO_METERS } from '../../core/engine/rv-constants';
import { parentScaleAlong } from '../../core/engine/rv-drive-units';
import { snapshotLocal } from './kinematics/transform-actions';

/** Kinematic component keys in rv_extras (Kinematic, Kinematic_1, …). */
const KINEMATIC_KEY_RE = /^Kinematic(_\d+)?$/;

/** Spring-back duration and overshoot (cute settle). */
const SPRING_MS = 320;
const BACK_C1 = 1.70158;
const BACK_C3 = BACK_C1 + 1;
/** Ease-out-back: overshoots slightly past 1 then settles. */
function easeOutBack(t: number): number {
  const u = t - 1;
  return 1 + BACK_C3 * u * u * u + BACK_C1 * u * u;
}

/** Throttle shadow updates while previewing (shadows are expensive). */
const SHADOW_MS = 250;

interface MemberSnap {
  node: Object3D;
  homeLocal: NodeTransform;
  homeWorld: Matrix4;
}

interface ActiveDrag {
  node: Object3D;
  source: DriveDragContext['source'];
  isRotary: boolean;
  offset: number;
  axis: Vector3;             // unit local motion axis
  homeBasePos: Vector3;      // node home local position
  homeBaseQuat: Quaternion;  // node home local orientation
  homeNodeWorld: Matrix4;    // node home world matrix
  members: MemberSnap[];     // non-child group members (rigid delta)
  homeP: number;             // drive position at home
  /** Scene units per node-local unit along the motion direction — 1 in an
   *  unscaled frame, 0.001 inside a CAD root. Snapshotted with the pose: the
   *  frame cannot change while a drag is in flight. */
  unitScale: number;
}

export class DriveDragPreview implements DriveDragDriver {
  private active: ActiveDrag | null = null;
  private springRAF: number | null = null;
  private lastShadow = 0;
  private readonly offPreExport: () => void;
  private readonly offSelection: () => void;

  // Scratch (no per-frame allocation).
  private readonly _dq = new Quaternion();
  private readonly _euler = new Euler();
  private readonly _v = new Vector3();
  private readonly _delta = new Matrix4();
  private readonly _world = new Matrix4();
  private readonly _invParent = new Matrix4();

  constructor(
    private readonly viewer: RVViewer,
    /** True while the editor's transform gizmo is engaged — the drive gizmo
     *  yields so the two never fight for a pointer-down. */
    private readonly blockedFn: () => boolean = () => false,
  ) {
    // A jogged/dragged pose must never bake into the exported GLB.
    this.offPreExport = viewer.on('asset-editor-pre-export', () => this.restoreNow());
    // If the selection changes mid-preview (rare), snap back so no node is left
    // displaced when its gizmo rebuilds.
    this.offSelection = viewer.on('selection-changed', () => { if (this.active) this.restoreNow(); });
  }

  isBlocked(): boolean {
    return this.blockedFn();
  }

  // ── DriveDragDriver ───────────────────────────────────────────────────

  preview(ctx: DriveDragContext): void {
    this.cancelSpring();
    if (!this.active || this.active.node !== ctx.node) {
      this.restoreNow();       // finish any prior drag cleanly
      this.capture(ctx);
    }
    this.applyPosition(ctx.position);
  }

  release(_ctx: DriveDragContext): void {
    if (this.active) this.startSpring();
  }

  cancel(_ctx: DriveDragContext): void {
    this.restoreNow();
  }

  /** Tear down (editor deactivate): stop any spring and restore home. */
  dispose(): void {
    this.restoreNow();
    this.offPreExport();
    this.offSelection();
  }

  // ── Preview mechanics ─────────────────────────────────────────────────

  /** Snapshot the axis node + affected members BEFORE any motion. */
  private capture(ctx: DriveDragContext): void {
    const { node, source } = ctx;
    node.updateWorldMatrix(true, false);
    // Pin the pre-drag home so the gizmo's rotary ring frame doesn't follow the
    // node while we rotate it (no-op for a live RVDrive).
    source.setPreviewHome?.(node.quaternion.clone());
    const members: MemberSnap[] = this.collectRigidRoots(node).map((m) => {
      m.updateWorldMatrix(true, false);
      return { node: m, homeLocal: snapshotLocal(m), homeWorld: m.matrixWorld.clone() };
    });
    const axis = source.getAxis(new Vector3());
    const homeBaseQuat = node.quaternion.clone();
    this.active = {
      node, source,
      isRotary: source.isRotary,
      offset: source.Offset,
      axis,
      homeBasePos: node.position.clone(),
      homeBaseQuat,
      homeNodeWorld: node.matrixWorld.clone(),
      members,
      homeP: source.currentPosition,
      unitScale: parentScaleAlong(node, this._v.copy(axis).applyQuaternion(homeBaseQuat)),
    };
  }

  /** Apply drive position P: move the axis node (its children follow) and every
   *  non-child member by the same rigid world delta. Mirrors `RVDrive.applyToNode`. */
  private applyPosition(p: number): void {
    const a = this.active;
    if (!a) return;
    const node = a.node;
    const pos = p + a.offset;
    if (a.isRotary) {
      const rad = (pos * Math.PI) / 180;
      this._v.copy(a.axis).multiplyScalar(rad);
      this._euler.set(this._v.x, this._v.y, this._v.z, 'XYZ');
      node.quaternion.copy(a.homeBaseQuat).multiply(this._dq.setFromEuler(this._euler));
    } else {
      // mm → metres → the PARENT's units, which are metres only in an unscaled
      // frame (a CAD subtree is in millimetres — see rv-drive-units). Mirrors
      // `RVDrive.positionToLocalOffset`, with the frame scale taken at capture.
      const offsetLocal = pos / MM_TO_METERS / a.unitScale;
      node.position.copy(a.homeBasePos)
        .add(this._v.copy(a.axis).multiplyScalar(offsetLocal).applyQuaternion(a.homeBaseQuat));
    }
    node.updateMatrixWorld(true);

    if (a.members.length > 0) {
      // deltaWorld = nodeWorld_now · nodeWorld_home⁻¹ (rigid body motion).
      this._delta.multiplyMatrices(node.matrixWorld, this._invParent.copy(a.homeNodeWorld).invert());
      for (const m of a.members) {
        this._world.multiplyMatrices(this._delta, m.homeWorld);
        this.applyWorld(m.node, this._world);
      }
    }

    a.source.setPreviewPosition?.(p);
    this.viewer.markRenderDirty();
    const now = performance.now();
    if (now - this.lastShadow > SHADOW_MS) { this.viewer.markShadowsDirty(); this.lastShadow = now; }
  }

  /** Write a world matrix onto a node by re-localising through its parent. */
  private applyWorld(node: Object3D, world: Matrix4): void {
    const parent = node.parent;
    if (parent) {
      this._invParent.copy(parent.matrixWorld).invert();
      this._world.multiplyMatrices(this._invParent, world);
      this._world.decompose(node.position, node.quaternion, node.scale);
    } else {
      world.decompose(node.position, node.quaternion, node.scale);
    }
    node.updateMatrixWorld(true);
  }

  // ── Restore / spring ──────────────────────────────────────────────────

  private startSpring(): void {
    const a = this.active;
    if (!a) return;
    const startP = a.source.currentPosition; // last previewed position
    const targetP = a.homeP;
    const t0 = performance.now();
    const step = (): void => {
      if (!this.active) { this.springRAF = null; return; }
      const t = Math.min((performance.now() - t0) / SPRING_MS, 1);
      this.applyPosition(startP + (targetP - startP) * easeOutBack(t));
      if (t < 1) {
        this.springRAF = requestAnimationFrame(step);
      } else {
        this.springRAF = null;
        this.restoreNow(); // exact home, clears state
      }
    };
    this.springRAF = requestAnimationFrame(step);
  }

  /** Restore every moved node to its exact home snapshot and clear preview. */
  private restoreNow(): void {
    this.cancelSpring();
    const a = this.active;
    if (!a) return;
    this.active = null;
    a.node.position.copy(a.homeBasePos);
    a.node.quaternion.copy(a.homeBaseQuat);
    a.node.updateMatrixWorld(true);
    for (const m of a.members) {
      writeSnapshot(m.node, m.homeLocal);
      m.node.updateMatrixWorld(true);
    }
    a.source.setPreviewPosition?.(a.homeP);
    a.source.endPreview?.();
    this.viewer.markRenderDirty();
    this.viewer.markShadowsDirty();
  }

  private cancelSpring(): void {
    if (this.springRAF !== null) { cancelAnimationFrame(this.springRAF); this.springRAF = null; }
  }

  // ── Kinematic assembly closure ────────────────────────────────────────

  /**
   * The nodes that must be moved by a rigid delta when the axis moves.
   *
   * `moving` is the transitive set of everything that ends up rigidly attached
   * to the axis at runtime — mirroring the loader's `applyKinematicparenting`:
   *   - current scene descendants (move via parent-matrix propagation),
   *   - members of any INTEGRATED kinematic group on a moving node (Pass 1), and
   *   - kinematics explicitly parented under a moving node (Pass 2, KinematicParentEnable).
   * A nested kinematic axis is itself a group member, so its own group is pulled
   * in on the next BFS step — the whole chain moves together.
   *
   * The RIGID ROOTS are then the moving nodes whose CURRENT parent is not also
   * moving: in a fresh authoring scene those are the separate group members that
   * need an explicit delta; in a reloaded (already-reparented) scene every member
   * is under the axis, so the set is empty and everything moves via parenting.
   */
  private collectRigidRoots(axisNode: Object3D): Object3D[] {
    const groups = this.viewer.groups;
    const moving = new Set<Object3D>([axisNode]);
    const kinByParent = this.buildKinematicParentIndex();
    const queue: Object3D[] = [axisNode];
    while (queue.length > 0) {
      const n = queue.shift()!;
      // Current scene descendants move with n via parenting.
      for (const child of n.children) {
        if (!moving.has(child)) { moving.add(child); queue.push(child); }
      }
      // Integrated kinematic group members (Pass 1) — a nested kinematic axis is
      // one of these, so its own group is expanded when it is dequeued.
      for (const groupName of integratedGroupNames(n, this.viewer)) {
        for (const m of groups?.get(groupName)?.nodes ?? []) {
          if (!moving.has(m)) { moving.add(m); queue.push(m); }
        }
      }
      // Kinematics explicitly parented under n (Pass 2).
      for (const k of kinByParent.get(n) ?? []) {
        if (!moving.has(k)) { moving.add(k); queue.push(k); }
      }
    }
    const roots: Object3D[] = [];
    for (const n of moving) {
      if (n === axisNode) continue;
      if (!n.parent || !moving.has(n.parent)) roots.push(n); // top-level of the moving set
    }
    return roots;
  }

  /** Reverse index of KinematicParentEnable links: resolved Parent node →
   *  kinematic axis nodes that attach under it at load (Pass 2). */
  private buildKinematicParentIndex(): Map<Object3D, Object3D[]> {
    const index = new Map<Object3D, Object3D[]>();
    const root = this.viewer.currentModelRoot;
    const registry = this.viewer.registry;
    if (!root || !registry) return index;
    root.traverse((node) => {
      forEachKinematic(node, (data) => {
        if (data['KinematicParentEnable'] !== true) return;
        const ref = data['Parent'];
        const path = typeof ref === 'string' ? ref : (ref as { path?: string } | undefined)?.path;
        const parent = path ? registry.getNode(path) : null;
        if (!parent) return;
        const arr = index.get(parent);
        if (arr) arr.push(node); else index.set(parent, [node]);
      });
    });
    return index;
  }
}

/** Run `cb` for each Kinematic component's data on a node. */
function forEachKinematic(node: Object3D, cb: (data: Record<string, unknown>) => void): void {
  const rv = (node.userData as Record<string, unknown> | undefined)?.['realvirtual'] as
    Record<string, unknown> | undefined;
  if (!rv) return;
  for (const key of Object.keys(rv)) {
    if (!KINEMATIC_KEY_RE.test(key)) continue;
    const data = rv[key];
    if (data && typeof data === 'object') cb(data as Record<string, unknown>);
  }
}

/** Resolved names of every INTEGRATED (IntegrateGroupEnable) kinematic group on
 *  a node — only these have their members reparented under the axis at load, so
 *  only these move with it (mirrors loader Pass 1). Honors GroupNamePrefix. */
function integratedGroupNames(node: Object3D, viewer: RVViewer): string[] {
  const names: string[] = [];
  forEachKinematic(node, (data) => {
    if (data['IntegrateGroupEnable'] !== true) return;
    const gname = data['GroupName'];
    if (typeof gname !== 'string' || !gname) return;
    const ref = data['GroupNamePrefix'];
    const path = typeof ref === 'string' ? ref : (ref as { path?: string } | undefined)?.path;
    const prefixNode = path ? viewer.registry?.getNode(path) : null;
    names.push(prefixNode ? prefixNode.name + gname : gname);
  });
  return names;
}

function writeSnapshot(node: Object3D, t: NodeTransform): void {
  node.position.fromArray(t.position);
  node.quaternion.fromArray(t.quaternion);
  node.scale.fromArray(t.scale);
}
