// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * ik-path-visualizer-plugin.ts — Shows a robot's IK path(s) when the robot, or
 * any component/child of it, is selected. Mirrors Unity's scene-view path gizmos
 * (IKPath.DrawPath / DrawTargets): a polyline through the waypoints plus a marker
 * + index label at each IKTarget.
 *
 * Two visual cues beyond the plain path:
 * - Each path SEGMENT is colored by the interpolation type that moves to its end
 *   target (PTP / PTP-unsynced / Linear) via per-vertex colors.
 * - Each waypoint MARKER turns red when the pose is not reachable by the analytical
 *   solver (only when a solver + OPW params are available).
 *
 * Cross-cutting + selection-driven ⇒ a plugin (not a component). It reacts to the
 * 'selection-changed' viewer event, resolves the selected node's RobotIK ancestor,
 * and draws/clears the gizmos for that robot's paths. Positions, segment colors and
 * reachability are refreshed each frame so they stay correct as the robot/targets move.
 */

import { LineSegments, BufferGeometry, BufferAttribute, LineBasicMaterial, Vector3 } from 'three';
import type { Object3D } from 'three';
import type { RVViewerPlugin } from '../core/rv-plugin';
import type { RVViewer } from '../core/rv-viewer';
import type { SelectionSnapshot } from '../core/engine/rv-selection-manager';
import type { GizmoHandle } from '../core/engine/rv-gizmo-manager';
import type { RVRobotIK } from '../core/engine/rv-robot-ik';
import type { RVIKPath } from '../core/engine/rv-ik-path';
import type { RVIKTarget } from '../core/engine/rv-ik-target';
import { ikSolverRegistry, targetPoseInBase, type OpwParams, type CobotSolveOpts } from '../core/engine/rv-ik-solver';
import { ikEditStore } from '../core/hmi/ik-edit-store';

const MARKER_COLOR = 0xce93d8;      // IKTarget badge lavender (reachable)
const UNREACHABLE_COLOR = 0xff4d4d; // red — pose has no IK solution
const MARKER_SIZE = 0.28;
const MARKER_OPACITY = 0.95;
const LABEL_SIZE = 0.6;
const SHOW_LABELS = true;

/** Segment color by the interpolation used to reach the end target. [r, g, b] 0..1. */
const INTERP_RGB: Record<string, [number, number, number]> = {
  PointToPoint: [0.729, 0.408, 0.784],          // 0xba68c8 magenta
  PointToPointUnsynced: [1.0, 0.654, 0.149],    // 0xffa726 orange
  Linear: [0.161, 0.714, 0.965],                // 0x29b6f6 light blue
};
const DEFAULT_RGB: [number, number, number] = INTERP_RGB.PointToPoint;

interface PathVisual {
  line: LineSegments;
  markers: GizmoHandle[];           // one sphere per target (index-aligned with targets)
  labels: GizmoHandle[];
  targets: readonly RVIKTarget[];
  targetNodes: Object3D[];
  robot: RVRobotIK;
  params: OpwParams | null;
  reach: boolean[];                 // last reachability per target (avoids redundant recolor)
  lastMat: Float32Array;            // cached target matrixWorld (N*16) for dirty-checking
  lastInterp: string[];             // cached interpolation per target
}

export class IKPathVisualizerPlugin implements RVViewerPlugin {
  readonly id = 'ik-path-visualizer';

  private viewer: RVViewer | null = null;
  private unsub: (() => void) | null = null;
  private unsubEdit: (() => void) | null = null;
  /** Node path of the marker currently hidden behind the edit gizmo (or null). */
  private hiddenMarkerPath: string | null = null;
  private readonly shown = new Map<RVIKPath, PathVisual>();
  private readonly _tmp = new Vector3();
  private readonly _p3: [number, number, number] = [0, 0, 0];
  private readonly _q4: [number, number, number, number] = [0, 0, 0, 1];
  // Reusable Cobot opts (plan-233 Phase 2): opw is set per call; no warm start
  // for reachability checks (cold, deterministic). Never allocated per frame.
  private readonly _cobotOpts: CobotSolveOpts = {};

  init(viewer: RVViewer): void {
    this.viewer = viewer;
    this.attachRuntime();
  }

  onModelCleared(): void {
    this.clearAll();
  }

  /**
   * User switched the plugin off (plan-436). Drops the path visuals and both
   * subscriptions that `init()` installed. `hiddenMarkerPath` is deliberately
   * NOT reset — it is plain bookkeeping, and `onActivate` re-reads it from the
   * edit store anyway.
   */
  onDeactivate(): void {
    this.detachRuntime();
  }

  /**
   * User switched the plugin back on (plan-436). With `onActivate` present the
   * host replays NO `onModelLoaded` (plan-435 invariant 2), so the paths have
   * to be pulled back from the current selection rather than waited for.
   */
  onActivate(viewer: RVViewer): void {
    this.viewer = viewer;
    this.attachRuntime();
    // The edit store may have moved while the subscription was off.
    this.hiddenMarkerPath = ikEditStore.getSnapshot()?.path ?? null;
    const snap = viewer.selectionManager?.getSnapshot();
    if (snap) this.onSelectionChanged(snap);
    // FORCE the marker state onto the freshly built visuals. Never
    // `syncActiveMarker()` here: it early-returns when the store path already
    // equals `hiddenMarkerPath`, which would leave the actively edited marker
    // fully visible on top of its edit gizmo (plan-436 §2.2).
    this.applyActiveMarker();
  }

  dispose(): void {
    this.detachRuntime();
    this.viewer = null;
  }

  // ── Attach / detach (ONE path, shared by init/dispose and the toggle) ──

  /** Install both subscriptions. Idempotent — repeated off/on cycles never
   *  double a listener (plan-436 F5). */
  private attachRuntime(): void {
    const viewer = this.viewer;
    if (!viewer) return;
    this.unsub?.();
    this.unsub = viewer.on('selection-changed', (snap) => this.onSelectionChanged(snap));
    // Hide the marker of the pathpoint being edited — the edit gizmo sits exactly
    // on it and the fat sphere would bury the gizmo's centre handle.
    this.unsubEdit?.();
    this.unsubEdit = ikEditStore.subscribe(() => this.syncActiveMarker());
  }

  /** Release both subscriptions and every path visual. Shared by `dispose()`
   *  and the user toggle; the plugin holds no permanent resources beyond
   *  them (each `PathVisual` owns its own geometry/material). */
  private detachRuntime(): void {
    this.clearAll();
    this.unsub?.();
    this.unsub = null;
    this.unsubEdit?.();
    this.unsubEdit = null;
  }

  /** Fade out the marker under the active edit gizmo; restore the previous one. */
  private syncActiveMarker(): void {
    const activePath = ikEditStore.getSnapshot()?.path ?? null;
    if (activePath === this.hiddenMarkerPath) return;
    this.hiddenMarkerPath = activePath;
    this.applyActiveMarker();
  }

  private applyActiveMarker(): void {
    const registry = this.viewer?.registry;
    if (!registry) return;
    const activePath = this.hiddenMarkerPath;
    for (const visual of this.shown.values()) {
      for (let i = 0; i < visual.targetNodes.length; i++) {
        const isActive = !!activePath && registry.getPathForNode(visual.targetNodes[i]) === activePath;
        visual.markers[i]?.update({ opacity: isActive ? 0 : MARKER_OPACITY });
      }
    }
  }

  /** Keep polylines, segment colors and reachability glued to the targets — but only
   *  rebuild when a target actually moved or its interpolation changed (skips the
   *  per-frame solver + buffer upload for idle selections). */
  onRender(): void {
    if (this.shown.size === 0) return;
    for (const visual of this.shown.values()) {
      if (!this.changed(visual)) continue;
      this.updateLine(visual);
      this.updateReachability(visual);
    }
  }

  /** True if any target's world matrix or interpolation changed since last check;
   *  syncs the cache as a side effect. (Targets are normally children of the robot,
   *  so a base move is captured via their matrixWorld.) */
  private changed(visual: PathVisual): boolean {
    let dirty = false;
    const nodes = visual.targetNodes;
    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i].matrixWorld.elements;
      const base = i * 16;
      for (let k = 0; k < 16; k++) {
        if (visual.lastMat[base + k] !== el[k]) { dirty = true; visual.lastMat[base + k] = el[k]; }
      }
      const interp = visual.targets[i].InterpolationToTarget;
      if (visual.lastInterp[i] !== interp) { dirty = true; visual.lastInterp[i] = interp; }
    }
    return dirty;
  }

  // ── Selection → desired path set ───────────────────────────────

  private onSelectionChanged(snap: SelectionSnapshot): void {
    const viewer = this.viewer;
    if (!viewer?.registry) { this.clearAll(); return; }
    const registry = viewer.registry;

    // Collect the IK paths to show: for every selected node, find its RobotIK
    // ancestor and take all of that robot's paths.
    const desired = new Set<RVIKPath>();
    const robotsSeen = new Set<RVRobotIK>();
    const robotOf = new Map<RVIKPath, RVRobotIK>();
    for (const path of snap.selectedPaths) {
      const node = registry.getNode(path);
      if (!node) continue;
      const robot = registry.findInParent<RVRobotIK>(node, 'RobotIK');
      if (!robot || robotsSeen.has(robot)) continue;
      robotsSeen.add(robot);
      for (const p of robot.getPaths()) { desired.add(p); robotOf.set(p, robot); }
    }

    // Remove paths no longer desired.
    for (const [path, visual] of this.shown) {
      if (!desired.has(path)) {
        this.disposeVisual(visual);
        this.shown.delete(path);
      }
    }
    // Add newly desired paths.
    for (const path of desired) {
      if (!this.shown.has(path)) {
        const visual = this.createVisual(path, robotOf.get(path)!);
        if (visual) this.shown.set(path, visual);
      }
    }
    // Rebuilt visuals start fully visible — re-hide the actively edited marker.
    this.applyActiveMarker();
  }

  // ── Build / update / dispose visuals ──────────────────────────

  private createVisual(path: RVIKPath, robot: RVRobotIK): PathVisual | null {
    const viewer = this.viewer;
    if (!viewer) return null;
    const targets = path.targets;
    if (targets.length === 0) return null;

    const targetNodes = targets.map((t) => t.node);
    const params = robot.getOpwParams();

    // Markers (+ optional index labels) at each waypoint.
    const markers: GizmoHandle[] = [];
    const labels: GizmoHandle[] = [];
    targets.forEach((t, i) => {
      markers.push(viewer.gizmoManager.create(t.node, {
        shape: 'sphere',
        color: MARKER_COLOR,
        opacity: MARKER_OPACITY,
        size: MARKER_SIZE,
        attachToNode: true,
        excludeFromRaycast: true, // visual only — grabbing is handled by IKTargetEditPlugin proximity
        depthTest: false,
        renderOrder: 9998,
        category: 'gizmos',
      }));
      if (SHOW_LABELS) {
        labels.push(viewer.gizmoManager.create(t.node, {
          shape: 'text',
          color: 0xffffff,
          opacity: 1,
          text: String(i + 1),
          size: LABEL_SIZE,
          attachToNode: true,
          excludeFromRaycast: true,
          category: 'gizmos',
        }));
      }
    });

    // Polyline as colored SEGMENTS (vertex colors per interpolation type). N-1
    // segments = 2*(N-1) vertices; positions/colors filled by updateLine().
    const segs = Math.max(0, targetNodes.length - 1);
    const geom = new BufferGeometry();
    geom.setAttribute('position', new BufferAttribute(new Float32Array(segs * 2 * 3), 3));
    geom.setAttribute('color', new BufferAttribute(new Float32Array(segs * 2 * 3), 3));
    const mat = new LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9, depthTest: false });
    const line = new LineSegments(geom, mat);
    line.renderOrder = 9997;
    line.frustumCulled = false;
    viewer.scene.add(line);

    const visual: PathVisual = {
      line, markers, labels, targets, targetNodes, robot, params,
      reach: new Array(targets.length).fill(true),
      lastMat: new Float32Array(targets.length * 16),
      lastInterp: new Array(targets.length).fill(''),
    };
    this.updateLine(visual);
    this.updateReachability(visual);
    this.changed(visual); // prime the dirty cache so the next frame is a no-op
    return visual;
  }

  /** Refresh segment endpoints + per-segment colors (interpolation may change live). */
  private updateLine(visual: PathVisual): void {
    const geom = visual.line.geometry;
    const posAttr = geom.getAttribute('position') as BufferAttribute;
    const colAttr = geom.getAttribute('color') as BufferAttribute;
    const pos = posAttr.array as Float32Array;
    const col = colAttr.array as Float32Array;
    const nodes = visual.targetNodes;
    for (let s = 0; s < nodes.length - 1; s++) {
      // Read straight from matrixWorld (frozen-node safe — getWorldPosition would corrupt).
      this._tmp.setFromMatrixPosition(nodes[s].matrixWorld);
      pos[s * 6 + 0] = this._tmp.x; pos[s * 6 + 1] = this._tmp.y; pos[s * 6 + 2] = this._tmp.z;
      this._tmp.setFromMatrixPosition(nodes[s + 1].matrixWorld);
      pos[s * 6 + 3] = this._tmp.x; pos[s * 6 + 4] = this._tmp.y; pos[s * 6 + 5] = this._tmp.z;
      // Color the segment by the interpolation used to reach the END target.
      const rgb = INTERP_RGB[visual.targets[s + 1].InterpolationToTarget] ?? DEFAULT_RGB;
      col[s * 6 + 0] = rgb[0]; col[s * 6 + 1] = rgb[1]; col[s * 6 + 2] = rgb[2];
      col[s * 6 + 3] = rgb[0]; col[s * 6 + 4] = rgb[1]; col[s * 6 + 5] = rgb[2];
    }
    posAttr.needsUpdate = true;
    colAttr.needsUpdate = true;
    // No computeBoundingSphere: the line has frustumCulled = false and isn't raycast.
  }

  /** Recolor markers whose reachability flipped (only when a solver + params exist). */
  private updateReachability(visual: PathVisual): void {
    const { params, robot } = visual;
    if (!params || !ikSolverRegistry.available) return;
    for (let i = 0; i < visual.targetNodes.length; i++) {
      const ok = this.isReachable(robot, params, visual.targetNodes[i]);
      if (ok === visual.reach[i]) continue;
      visual.reach[i] = ok;
      visual.markers[i]?.update({ color: ok ? MARKER_COLOR : UNREACHABLE_COLOR });
    }
  }

  /** True if the target pose (relative to the robot base) has any IK solution.
   *  Wrist-type routing (plan-233 Phase 2): NonSpherical robots check via the
   *  numerical Cobot solver (no warm start — cold, deterministic); spherical
   *  wrists — and any fallback (no chain / no pro solver) — via Pieper. */
  private isReachable(robot: RVRobotIK, params: OpwParams, targetNode: Object3D): boolean {
    targetPoseInBase(robot.node.matrixWorld, targetNode.matrixWorld, this._p3, this._q4);
    if (robot.WristType === 'NonSpherical' && ikSolverRegistry.canSolveCobot) {
      const chain = robot.getJointChain();
      if (chain) {
        this._cobotOpts.opw = params;
        this._cobotOpts.warmStart = undefined;
        const sols = ikSolverRegistry.solveCobot(chain, this._p3, this._q4, this._cobotOpts);
        if (sols) return sols.some((s) => s.reachable);
      }
    }
    // NOTE: solvePieper returns the full 8-branch set with per-branch reachable
    // flags — a bare truthiness check would ALWAYS pass once a solver is loaded.
    const sols = ikSolverRegistry.solvePieper(params, this._p3, this._q4);
    return !!sols && sols.some((s) => s.reachable);
  }

  private disposeVisual(visual: PathVisual): void {
    for (const h of visual.markers) h.dispose();
    for (const h of visual.labels) h.dispose();
    this.viewer?.scene.remove(visual.line);
    visual.line.geometry.dispose();
    (visual.line.material as LineBasicMaterial).dispose();
  }

  private clearAll(): void {
    for (const visual of this.shown.values()) this.disposeVisual(visual);
    this.shown.clear();
  }
}
