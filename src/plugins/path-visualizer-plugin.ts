// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * path-visualizer-plugin.ts — Draws every `rv_extras.Path` registered in the
 * default {@link RVPathNetwork} and makes it a first-class PLANNER object
 * (plan-921 for the drawing, plan-447 for visibility/handles/editing).
 *
 * Visual language:
 * - Plain paths: teal (the Path badge color).
 * - Zoned paths (control-point mutual exclusion): orange.
 * - A chevron at each path end shows travel direction (successor hand-off point).
 * - Screen-space constant width via `LineSegments2` / fat lines (F1) — the
 *   WebGL `linewidth` of a plain `LineBasicMaterial` is ignored on most
 *   platforms, so a path was practically a hairline before.
 * - Hover raises width + opacity of THAT path only.
 * - Planner mode raises the base width and shows drag handles (F3).
 *
 * ONE renderer per path (plan-447 risk "zwei Linien-Renderer fuer denselben
 * Pfad"): the plugin keeps a `pathId → LineSegments2` map — this module is the
 * single owner of path line rendering, never a parallel build.
 *
 * Rebuild triggers, cheapest first:
 * 1. `RVPathNetwork.onPathChanged(pathId)` — the live-edit channel
 *    (`RVPathComponent.reapplyConfig()`); rebuilds exactly that one path.
 * 2. A cheap signature poll (ids + lengths + zone ids) at most twice a second
 *    inside `onRender` — catches register/unregister without an event.
 *
 * Handles follow the picking contract (`doc-render-picking.md` §2.3/§2.4):
 * they are registered as AUX RAYCAST TARGETS (`addAuxRaycastTarget`, the
 * sanctioned extension seam, precedent EnergyChain) — never through layer bits,
 * which are explicitly not a filter mechanism there.
 *
 * A drag never mutates the engine per frame: while dragging, only the preview
 * geometry is rebuilt. On release the new segment list is committed as an
 * ordinary `setField` op on the generic `'json'` field `segments` — undo/redo
 * and the save roundtrip come from the existing op log (F5).
 */

import {
  Group,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  Plane,
  Raycaster,
  SphereGeometry,
  Vector2,
  Vector3,
} from 'three';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import type { RVViewerPlugin } from '../core/rv-plugin';
import type { RVViewer } from '../core/rv-viewer';
import { getDefaultPathNetwork } from '../core/engine/rv-path-network';
import type { RVPath } from '../core/engine/rv-path';
import { RVPathComponent, getPathEndpoints } from '../core/engine/rv-path';
import {
  DEFAULT_PATH_SNAP_RADIUS_M,
  arcPointAt,
  cloneSegmentSpecs,
  derivePathHandles,
  movePathHandle,
  readSegmentSpecs,
  snapDragTarget,
  writeSegmentSpecs,
  type PathHandle,
  type PathSnapCandidate,
  type Vec3Tuple,
} from '../core/engine/rv-path-edit';
import type { PathSegmentSpec } from '../core/engine/rv-path';
import { getComponentInstances } from '../core/engine/rv-component-registry';
import { persistFieldOp } from '../core/hmi/scene/scene-field-ops';
import { pointerToNDC } from '../core/engine/rv-pointer-utils';
import { markAsOverlay, markNoAO } from '../core/engine/rv-group-registry';

const PLAIN_HEX = 0x26a69a;  // Path badge teal
const ZONE_HEX = 0xffa726;   // zoned path orange
const HOVER_HEX = 0x4fc3f7;  // Instrument Blue (DESIGN.md accent)
const HANDLE_HEX = 0x4fc3f7;
const HANDLE_ENDPOINT_HEX = 0xffffff;
/** Lift above Y=0 so the lines never z-fight with a ground plane or grid. */
const Y_LIFT = 0.02;
/** Sample density: points per meter of arc length (min 8 per path). */
const POINTS_PER_METER = 8;
/** Chevron wing length in meters. */
const CHEVRON_LEN = 0.25;
/** Signature re-check interval (ms) — authoring latency, not a hot path. */
const CHECK_INTERVAL_MS = 500;

/** Screen-space line widths (px) per presentation state. */
const WIDTH_IDLE = 2;
const WIDTH_PLANNER = 4;
const WIDTH_HOVER = 6;
const OPACITY_IDLE = 0.9;
const OPACITY_HOVER = 1;

/** Handle sphere radius in meters. */
const HANDLE_RADIUS_M = 0.09;

/** Which handle of which path an endpoint drag is currently asking about. */
export interface PathSnapQuery {
  readonly pathId: string;
  readonly handleId: string;
}

/**
 * Extra rastung targets for an endpoint drag (F4). The plugin knows the free
 * ends of every path by itself; STATION snappoints live in the snap-point
 * plugin's `SnapPointRegistry`, which core must not import — so that plugin
 * registers a source here instead (tiny-registry pattern, CLAUDE.md
 * "events & hooks for loose coupling").
 */
export type PathSnapCandidateSource = (query: PathSnapQuery) => readonly PathSnapCandidate[];

/** Live drag bookkeeping (never allocated per frame). */
interface HandleDragState {
  pathId: string;
  handleId: string;
  /** Segment list as it was BEFORE the drag — the undo `prev` value. */
  before: PathSegmentSpec[];
  /** Segment list of the current preview. */
  preview: PathSegmentSpec[];
  /** True for a free chain end (F4 rastung applies). */
  endpoint: boolean;
  /** Y the drag plane is pinned to (handles move in the horizontal plane). */
  planeY: number;
  moved: boolean;
}

export class PathVisualizerPlugin implements RVViewerPlugin {
  readonly id = 'path-visualizer';

  private viewer: RVViewer | null = null;
  private root: Group | null = null;
  private handleRoot: Group | null = null;
  /** EXACTLY one line renderer per path id (plan-447 §2.4). */
  private readonly lines = new Map<string, LineSegments2>();
  /** Handle meshes of the currently shown path handles, keyed `<pathId>|<handleId>`. */
  private readonly handles = new Map<string, Mesh>();
  private readonly handleInfo = new Map<string, { pathId: string; handle: PathHandle }>();
  /** Path node lookup (`pathId → Object3D`), rebuilt with the drawing. */
  private readonly nodeByPathId = new Map<string, Object3D>();

  private signature = '';
  private lastCheck = 0;
  private plannerMode = false;
  private hoveredPathId: string | null = null;
  private drag: HandleDragState | null = null;
  private unsubs: (() => void)[] = [];
  private handleGeometry: SphereGeometry | null = null;
  /** Foreign rastung targets (station snappoints, …) — see {@link addSnapCandidateSource}. */
  private readonly snapSources = new Set<PathSnapCandidateSource>();

  // Pre-allocated temps — no GC in hover/drag paths.
  private readonly _ray = new Raycaster();
  private readonly _ndc = new Vector2();
  private readonly _plane = new Plane(new Vector3(0, 1, 0), 0);
  private readonly _up = new Vector3(0, 1, 0);
  private readonly _hit = new Vector3();

  // ── Lifecycle ──────────────────────────────────────────────────────────

  init(viewer: RVViewer): void {
    this.viewer = viewer;
    this.root = new Group();
    this.root.name = '__pathVisualizer';
    this.root.renderOrder = 500;
    this.root.frustumCulled = false;
    viewer.scene.add(this.root);

    this.handleRoot = new Group();
    this.handleRoot.name = '__pathHandles';
    this.handleRoot.renderOrder = 520;
    this.handleRoot.frustumCulled = false;
    this.handleRoot.visible = false;
    viewer.scene.add(this.handleRoot);

    // Live-edit channel: rebuild exactly the changed path (plan-447).
    this.unsubs.push(
      getDefaultPathNetwork().onPathChanged((pathId) => this.onPathChanged(pathId)),
    );

    // Planner mode drives emphasis + handles.
    this.unsubs.push(
      viewer.on('mode-changed', (d: { to: string }) => this.setPlannerMode(d.to === 'planner')),
    );
    // Hover highlight — resolved through the ordinary raycast pipeline.
    this.unsubs.push(
      viewer.on('object-hover', (d: { node: Object3D } | null) =>
        this.setHoveredPath(d ? this.pathIdForNode(d.node) : null),
      ),
    );

    this.wirePointer();
  }

  onRender(): void {
    if (this.drag) return; // during a drag the preview owns the geometry
    const now = performance.now();
    if (now - this.lastCheck < CHECK_INTERVAL_MS) return;
    this.lastCheck = now;
    // Fat lines need the viewport resolution for their pixel-space width; a
    // canvas resize would otherwise silently change the drawn thickness.
    this.syncLineResolution();
    const paths = getDefaultPathNetwork().all();
    const sig = paths
      .map((p) => `${p.id}:${p.length.toFixed(4)}:${p.zoneId ?? ''}:${p.closed ? 1 : 0}`)
      .join('|');
    if (sig === this.signature) return;
    this.signature = sig;
    this.rebuildAll(paths);
  }

  onModelCleared(): void {
    // The network clears with the model; force the next check to rebuild empty.
    this.signature = ' stale';
    this.lastCheck = 0;
    this.cancelDrag();
    this.clearLines();
    this.clearHandles();
    this.nodeByPathId.clear();
  }

  dispose(): void {
    for (const un of this.unsubs) {
      try {
        un();
      } catch {
        /* listener already gone */
      }
    }
    this.unsubs = [];
    this.snapSources.clear();
    this.cancelDrag();
    this.clearLines();
    this.clearHandles();
    this.handleGeometry?.dispose();
    this.handleGeometry = null;
    if (this.root) {
      this.viewer?.scene.remove(this.root);
      this.root = null;
    }
    if (this.handleRoot) {
      this.viewer?.scene.remove(this.handleRoot);
      this.handleRoot = null;
    }
    this.nodeByPathId.clear();
    this.viewer = null;
  }

  // ── Public state (also the test seam) ──────────────────────────────────

  /** Planner-mode emphasis + drag handles on/off. Idempotent. */
  setPlannerMode(active: boolean): void {
    if (this.plannerMode === active) return;
    this.plannerMode = active;
    if (!active) this.cancelDrag();
    for (const [pathId, line] of this.lines) this.applyStyle(pathId, line);
    if (active) this.rebuildHandles();
    else this.clearHandles();
    if (this.handleRoot) this.handleRoot.visible = active;
    this.viewer?.markRenderDirty();
  }

  /** True while the planner emphasis/handles are on. */
  get isPlannerMode(): boolean {
    return this.plannerMode;
  }

  /** Highlight one path (null clears). */
  setHoveredPath(pathId: string | null): void {
    if (this.hoveredPathId === pathId) return;
    const prev = this.hoveredPathId;
    this.hoveredPathId = pathId;
    if (prev) {
      const line = this.lines.get(prev);
      if (line) this.applyStyle(prev, line);
    }
    if (pathId) {
      const line = this.lines.get(pathId);
      if (line) this.applyStyle(pathId, line);
    }
    this.viewer?.markRenderDirty();
  }

  /** Currently highlighted path id (null = none). */
  get hoveredPath(): string | null {
    return this.hoveredPathId;
  }

  /** The line renderers, keyed by path id — exactly one entry per drawn path. */
  getLineObjects(): ReadonlyMap<string, LineSegments2> {
    return this.lines;
  }

  /** The currently shown drag handles, keyed `<pathId>|<handleId>`. */
  getHandleObjects(): ReadonlyMap<string, Mesh> {
    return this.handles;
  }

  /**
   * Register a source of EXTRA rastung targets for an endpoint drag (F4) —
   * station snappoints and anything else that is not a path end. Returns the
   * unregister function. A throwing source is logged, never propagated: a bad
   * candidate provider must not break the drag.
   */
  addSnapCandidateSource(source: PathSnapCandidateSource): () => void {
    this.snapSources.add(source);
    return () => {
      this.snapSources.delete(source);
    };
  }

  /** Force a full re-derivation from the network (tests / explicit refresh). */
  refresh(): void {
    const paths = getDefaultPathNetwork().all();
    this.signature = paths
      .map((p) => `${p.id}:${p.length.toFixed(4)}:${p.zoneId ?? ''}:${p.closed ? 1 : 0}`)
      .join('|');
    this.rebuildAll(paths);
  }

  // ── Drag API (pointer handlers and tests use the same three calls) ─────

  /** True while a handle drag is in flight. */
  get isDragging(): boolean {
    return this.drag !== null;
  }

  /**
   * Begin dragging one handle. Returns false when the handle is unknown or the
   * path node cannot be resolved (nothing to commit into).
   */
  beginHandleDrag(pathId: string, handleId: string): boolean {
    if (this.drag) this.cancelDrag();
    const node = this.nodeByPathId.get(pathId);
    if (!node) return false;
    const before = readSegmentSpecs(node as unknown as { userData: Record<string, unknown> });
    const handle = derivePathHandles(before).find((h) => h.id === handleId);
    if (!handle) return false;
    this.drag = {
      pathId,
      handleId,
      before,
      preview: cloneSegmentSpecs(before),
      endpoint: handle.endpoint && handle.kind === 'vertex',
      planeY: handle.position[1],
      moved: false,
    };
    if (this.viewer) this.viewer.controls.enabled = false;
    return true;
  }

  /**
   * Move the dragged handle to a world point. Endpoint drags rast onto nearby
   * compatible points (F4). Only the PREVIEW geometry is rebuilt — no engine
   * mutation, no op (plan-447 §2.4).
   */
  updateHandleDrag(target: Vec3Tuple): void {
    const drag = this.drag;
    if (!drag) return;
    let point = target;
    if (drag.endpoint) {
      const res = snapDragTarget(
        target,
        this.snapCandidates(drag.pathId, drag.handleId),
        DEFAULT_PATH_SNAP_RADIUS_M,
      );
      point = res.position;
    }
    drag.preview = movePathHandle(drag.before, drag.handleId, point);
    drag.moved = true;
    this.previewPath(drag.pathId, drag.preview);
    this.viewer?.markRenderDirty();
  }

  /**
   * Release the drag: write the new segment list into the node (optimistic
   * runtime update), re-derive the engine path through the ordinary
   * `reapplyConfig()` route, and record the undoable `setField` op.
   * Returns the committed segment list (null when nothing moved).
   */
  endHandleDrag(): PathSegmentSpec[] | null {
    const drag = this.drag;
    this.drag = null;
    if (this.viewer) this.viewer.controls.enabled = true;
    if (!drag) return null;
    if (!drag.moved) {
      this.refresh();
      return null;
    }
    const node = this.nodeByPathId.get(drag.pathId);
    if (!node) {
      this.refresh();
      return null;
    }
    const specs = drag.preview;
    // 1. Optimistic runtime write + live re-derivation (fires the change event,
    //    which re-projects travelers and re-registers path snaps).
    writeSegmentSpecs(node as unknown as { userData: Record<string, unknown> }, specs);
    pathComponentOf(node)?.reapplyConfig();
    // 2. Durable + undoable: the generic setField op on the json field.
    const nodePath = this.viewer?.registry?.getPathForNode(node) ?? null;
    if (nodePath) {
      persistFieldOp(nodePath, 'Path', 'segments', cloneSegmentSpecs(specs), drag.before);
    }
    this.refresh();
    return specs;
  }

  /** Abort the drag and restore the pre-drag drawing. */
  cancelDrag(): void {
    if (!this.drag) return;
    const pathId = this.drag.pathId;
    this.drag = null;
    if (this.viewer) this.viewer.controls.enabled = true;
    const path = getDefaultPathNetwork().get(pathId);
    if (path) this.rebuildPath(path);
    this.rebuildHandles();
  }

  // ── Change plumbing ────────────────────────────────────────────────────

  private onPathChanged(pathId: string): void {
    if (this.drag && this.drag.pathId === pathId) return; // our own preview owns it
    const path = getDefaultPathNetwork().get(pathId);
    if (!path) {
      this.removeLine(pathId);
      this.nodeByPathId.delete(pathId);
    } else {
      this.indexNode(path.id);
      this.rebuildPath(path);
    }
    if (this.plannerMode) this.rebuildHandles();
    // Keep the poll signature in step so onRender does not rebuild again.
    this.signature = getDefaultPathNetwork()
      .all()
      .map((p) => `${p.id}:${p.length.toFixed(4)}:${p.zoneId ?? ''}:${p.closed ? 1 : 0}`)
      .join('|');
    this.viewer?.markRenderDirty();
  }

  /** Keep every fat-line material's `resolution` in step with the canvas. */
  private syncLineResolution(): void {
    if (this.lines.size === 0) return;
    const canvas = this.viewer?.renderer?.domElement as HTMLCanvasElement | undefined;
    const w = canvas?.clientWidth || (typeof window !== 'undefined' ? window.innerWidth : 1920);
    const h = canvas?.clientHeight || (typeof window !== 'undefined' ? window.innerHeight : 1080);
    for (const line of this.lines.values()) {
      (line.material as LineMaterial).resolution.set(w, h);
    }
  }

  private rebuildAll(paths: readonly RVPath[]): void {
    const live = new Set<string>();
    for (const path of paths) {
      live.add(path.id);
      this.indexNode(path.id);
      this.rebuildPath(path);
    }
    for (const pathId of [...this.lines.keys()]) {
      if (!live.has(pathId)) this.removeLine(pathId);
    }
    for (const pathId of [...this.nodeByPathId.keys()]) {
      if (!live.has(pathId)) this.nodeByPathId.delete(pathId);
    }
    if (this.plannerMode) this.rebuildHandles();
  }

  // ── Line rendering ─────────────────────────────────────────────────────

  /** Sampled polyline + end chevron of ONE path as a flat position array. */
  private samplePositions(path: RVPath): number[] {
    const positions: number[] = [];
    if (path.length <= 0) return positions;
    const a = new Vector3();
    const b = new Vector3();
    const dir = new Vector3();
    const side = new Vector3();
    const UP = new Vector3(0, 1, 0);
    const seg = (p: Vector3, q: Vector3): void => {
      positions.push(p.x, p.y + Y_LIFT, p.z, q.x, q.y + Y_LIFT, q.z);
    };
    const divisions = Math.max(8, Math.ceil(path.length * POINTS_PER_METER));
    const pts = path.getSpacedPoints(divisions);
    for (let i = 0; i < pts.length - 1; i++) seg(pts[i], pts[i + 1]);
    // Direction chevron at the path END (the successor hand-off point).
    path.getAbsPosition(path.length, a);
    path.getAbsDirection(path.length, dir);
    if (dir.lengthSq() > 1e-12) {
      side.crossVectors(UP, dir).normalize().multiplyScalar(CHEVRON_LEN * 0.6);
      dir.normalize().multiplyScalar(CHEVRON_LEN);
      b.copy(a).sub(dir).add(side);
      seg(b, a);
      b.copy(a).sub(dir).sub(side);
      seg(b, a);
    }
    return positions;
  }

  /** Create or update THE one renderer of `path`. */
  private rebuildPath(path: RVPath): void {
    if (!this.root) return;
    const positions = this.samplePositions(path);
    if (positions.length === 0) {
      this.removeLine(path.id);
      return;
    }
    let line = this.lines.get(path.id);
    if (!line) {
      const geom = new LineSegmentsGeometry();
      const mat = new LineMaterial({
        color: PLAIN_HEX,
        linewidth: WIDTH_IDLE,
        transparent: true,
        opacity: OPACITY_IDLE,
        depthTest: true,
        depthWrite: false,
      });
      mat.resolution.set(
        typeof window !== 'undefined' ? window.innerWidth : 1920,
        typeof window !== 'undefined' ? window.innerHeight : 1080,
      );
      line = new LineSegments2(geom, mat);
      line.name = `__pathLine:${path.id}`;
      line.renderOrder = 500;
      line.frustumCulled = false;
      line.userData._rvPathId = path.id;
      // In-scene UI on the floor: out of the SSAO pass, but depth-occluded so a
      // vehicle driving over its path hides the line (markAsOverlay drew it on top).
      markNoAO(line);
      this.root.add(line);
      this.lines.set(path.id, line);
    }
    (line.geometry as LineSegmentsGeometry).setPositions(new Float32Array(positions));
    line.computeLineDistances();
    this.applyStyle(path.id, line);
  }

  /** Draw a PREVIEW of `specs` for `pathId` without touching the engine. */
  private previewPath(pathId: string, specs: readonly PathSegmentSpec[]): void {
    const line = this.lines.get(pathId);
    if (!line) return;
    const positions: number[] = [];
    const push = (p: Vec3Tuple, q: Vec3Tuple): void => {
      positions.push(p[0], p[1] + Y_LIFT, p[2], q[0], q[1] + Y_LIFT, q[2]);
    };
    for (const s of specs) {
      if (s.kind === 'line') {
        push(s.from as Vec3Tuple, s.to as Vec3Tuple);
      } else {
        // Arc: sample it the same way the engine would (shared helper — the
        // preview must never diverge from what reapplyConfig will produce).
        const steps = 24;
        let prev = arcPointAt(s, 0);
        for (let i = 1; i <= steps; i++) {
          const cur = arcPointAt(s, i / steps);
          push(prev, cur);
          prev = cur;
        }
      }
    }
    if (positions.length === 0) return;
    (line.geometry as LineSegmentsGeometry).setPositions(new Float32Array(positions));
    line.computeLineDistances();
    // Handles follow the preview so the dragged sphere sits under the cursor.
    this.syncHandlePositions(pathId, specs);
  }

  private applyStyle(pathId: string, line: LineSegments2): void {
    const path = getDefaultPathNetwork().get(pathId);
    const hovered = this.hoveredPathId === pathId;
    const mat = line.material as LineMaterial;
    mat.color.setHex(hovered ? HOVER_HEX : path?.zoneId ? ZONE_HEX : PLAIN_HEX);
    mat.linewidth = hovered ? WIDTH_HOVER : this.plannerMode ? WIDTH_PLANNER : WIDTH_IDLE;
    mat.opacity = hovered ? OPACITY_HOVER : OPACITY_IDLE;
    mat.needsUpdate = true;
  }

  private removeLine(pathId: string): void {
    const line = this.lines.get(pathId);
    if (!line) return;
    this.root?.remove(line);
    line.geometry.dispose();
    (line.material as LineMaterial).dispose();
    this.lines.delete(pathId);
  }

  private clearLines(): void {
    for (const pathId of [...this.lines.keys()]) this.removeLine(pathId);
  }

  // ── Handles ────────────────────────────────────────────────────────────

  private ensureHandleGeometry(): SphereGeometry {
    if (!this.handleGeometry) this.handleGeometry = new SphereGeometry(HANDLE_RADIUS_M, 12, 8);
    return this.handleGeometry;
  }

  /** (Re)build the handle spheres of every path — planner mode only. */
  private rebuildHandles(): void {
    this.clearHandles();
    if (!this.plannerMode || !this.handleRoot) return;
    const rm = this.viewer?.raycastManager ?? null;
    for (const path of getDefaultPathNetwork().all()) {
      const node = this.nodeByPathId.get(path.id);
      if (!node) continue;
      const specs = readSegmentSpecs(node as unknown as { userData: Record<string, unknown> });
      for (const handle of derivePathHandles(specs)) {
        const key = `${path.id}|${handle.id}`;
        const mesh = new Mesh(
          this.ensureHandleGeometry(),
          new MeshBasicMaterial({
            color: handle.endpoint ? HANDLE_ENDPOINT_HEX : HANDLE_HEX,
            depthTest: false,
            transparent: true,
            opacity: 0.95,
          }),
        );
        mesh.name = `__pathHandle:${key}`;
        mesh.position.set(handle.position[0], handle.position[1] + Y_LIFT, handle.position[2]);
        mesh.renderOrder = 521;
        mesh.frustumCulled = false;
        mesh.userData._rvPathId = path.id;
        mesh.userData._rvPathHandleId = handle.id;
        markAsOverlay(mesh);
        this.handleRoot.add(mesh);
        this.handles.set(key, mesh);
        this.handleInfo.set(key, { pathId: path.id, handle });
        // Picking contract doc-render-picking.md §2.3: aux target resolving to
        // the owning Path node — NEVER a private layer bit (§2.4).
        rm?.addAuxRaycastTarget(mesh, node);
      }
    }
    this.handleRoot.visible = true;
  }

  /** Move the handle spheres of `pathId` onto a preview spec list. */
  private syncHandlePositions(pathId: string, specs: readonly PathSegmentSpec[]): void {
    if (!this.plannerMode) return;
    for (const handle of derivePathHandles(specs)) {
      const mesh = this.handles.get(`${pathId}|${handle.id}`);
      if (!mesh) continue;
      mesh.position.set(handle.position[0], handle.position[1] + Y_LIFT, handle.position[2]);
    }
  }

  private clearHandles(): void {
    const rm = this.viewer?.raycastManager ?? null;
    for (const mesh of this.handles.values()) {
      rm?.removeAuxRaycastTarget(mesh);
      this.handleRoot?.remove(mesh);
      (mesh.material as MeshBasicMaterial).dispose();
      // Geometry is SHARED across handles — disposed once in dispose().
    }
    this.handles.clear();
    this.handleInfo.clear();
    if (this.handleRoot) this.handleRoot.visible = false;
  }

  // ── Node lookup + snap candidates ──────────────────────────────────────

  /** Cache `pathId → Object3D` by scanning the scene for the Path components. */
  private indexNode(pathId: string): void {
    if (this.nodeByPathId.has(pathId)) {
      const cached = this.nodeByPathId.get(pathId)!;
      if (pathComponentOf(cached)?.path?.id === pathId) return;
      this.nodeByPathId.delete(pathId);
    }
    const scene = this.viewer?.scene;
    if (!scene) return;
    let found: Object3D | null = null;
    scene.traverse((o) => {
      if (found) return;
      if (pathComponentOf(o)?.path?.id === pathId) found = o;
    });
    if (found) this.nodeByPathId.set(pathId, found);
  }

  /** Register a path node explicitly (tests / hosts without a NodeRegistry). */
  registerPathNode(pathId: string, node: Object3D): void {
    this.nodeByPathId.set(pathId, node);
  }

  private pathIdForNode(node: Object3D | null): string | null {
    if (!node) return null;
    let cur: Object3D | null = node;
    while (cur) {
      const comp = pathComponentOf(cur);
      if (comp?.path) return comp.path.id;
      const id = (cur.userData as { _rvPathId?: string })._rvPathId;
      if (typeof id === 'string') return id;
      cur = cur.parent;
    }
    return null;
  }

  /**
   * Free path ends OTHER than the dragged one — the rastung targets of F4.
   * Data-bound like the snappoints themselves (rv-path.ts `getPathEndpoints`).
   */
  private snapCandidates(draggedPathId: string, draggedHandleId: string): PathSnapCandidate[] {
    const out: PathSnapCandidate[] = [];
    for (const path of getDefaultPathNetwork().all()) {
      const ends = getPathEndpoints(path);
      if (!ends) continue;
      for (const end of [ends.start, ends.end]) {
        // Skip the handle being dragged (a point never rasts onto itself).
        if (path.id === draggedPathId) {
          const isStart = end.which === 'start' && draggedHandleId === 'v0';
          const isEnd = end.which === 'end' && draggedHandleId === `v${path.segments.length}`;
          if (isStart || isEnd) continue;
        }
        out.push({
          id: `${path.id}:${end.which}`,
          position: [end.position.x, end.position.y, end.position.z],
        });
      }
    }
    // Foreign targets (station snappoints) contributed by other plugins.
    for (const source of this.snapSources) {
      try {
        for (const c of source({ pathId: draggedPathId, handleId: draggedHandleId })) out.push(c);
      } catch (e) {
        console.error('[path-visualizer] snap candidate source failed:', e);
      }
    }
    return out;
  }

  // ── Pointer wiring ─────────────────────────────────────────────────────

  private wirePointer(): void {
    const canvas = this.viewer?.renderer?.domElement as HTMLCanvasElement | undefined;
    if (!canvas) return;

    const onDown = (e: PointerEvent): void => {
      if (!this.plannerMode || e.button !== 0 || this.handles.size === 0) return;
      const hit = this.pickHandle(e, canvas);
      if (!hit) return;
      // A handle grab is OURS alone. The layout-planner listens for
      // `pointerdown` on this same canvas and would start a marquee underneath
      // the handle drag (its raycast only knows layout instances, and a handle
      // is none) — `stopPropagation` does NOT stop a sibling listener on the
      // same target, only `stopImmediatePropagation` does. This plugin wires in
      // `init()`, the planner in `onModelLoaded`, so we are registered first and
      // the immediate-stop reaches it; the planner ALSO guards itself against an
      // in-flight handle drag (canvas-interaction.ts), the same belt-and-braces
      // the FloorGizmo/`transformControls.isDragging` pair uses there.
      e.stopPropagation();
      e.stopImmediatePropagation();
      this.beginHandleDrag(hit.pathId, hit.handle.id);
    };
    const onMove = (e: PointerEvent): void => {
      if (!this.drag) return;
      const p = this.pointerOnDragPlane(e, canvas);
      if (p) this.updateHandleDrag(p);
    };
    const onUp = (): void => {
      if (this.drag) this.endHandleDrag();
    };

    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    this.unsubs.push(
      () => canvas.removeEventListener('pointerdown', onDown),
      () => canvas.removeEventListener('pointermove', onMove),
      () => window.removeEventListener('pointerup', onUp),
    );
  }

  private pickHandle(
    e: PointerEvent,
    canvas: HTMLCanvasElement,
  ): { pathId: string; handle: PathHandle } | null {
    if (!this.viewer) return null;
    pointerToNDC(e.clientX, e.clientY, canvas, this._ndc);
    this._ray.setFromCamera(this._ndc, this.viewer.camera);
    const meshes = [...this.handles.values()];
    const hits = this._ray.intersectObjects(meshes, false);
    if (hits.length === 0) return null;
    const key = hits[0].object.name.replace('__pathHandle:', '');
    return this.handleInfo.get(key) ?? null;
  }

  private pointerOnDragPlane(e: PointerEvent, canvas: HTMLCanvasElement): Vec3Tuple | null {
    if (!this.viewer || !this.drag) return null;
    pointerToNDC(e.clientX, e.clientY, canvas, this._ndc);
    this._ray.setFromCamera(this._ndc, this.viewer.camera);
    this._plane.set(this._up, -this.drag.planeY); // pre-allocated normal — no GC in the drag
    const hit = this._ray.ray.intersectPlane(this._plane, this._hit);
    if (!hit) return null;
    return [hit.x, this.drag.planeY, hit.z];
  }
}

/** The `RVPathComponent` attached to `node` (null when the node carries none). */
function pathComponentOf(node: Object3D): RVPathComponent | null {
  for (const inst of getComponentInstances(node)) {
    if (inst instanceof RVPathComponent) return inst;
  }
  return null;
}
