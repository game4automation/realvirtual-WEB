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
 * Handles follow the picking contract (`contract-bake-picking.md` §2.3/§2.4):
 * they are registered as AUX RAYCAST TARGETS (`addAuxRaycastTarget`, the
 * sanctioned extension seam, precedent EnergyChain) — never through layer bits,
 * which are explicitly not a filter mechanism there.
 *
 * A drag never mutates the engine per frame: while dragging, only the preview
 * geometry is rebuilt. On release the new segment list is committed as an
 * ordinary `setField` op on the generic `'json'` field `segments` — undo/redo
 * and the save roundtrip come from the existing op log (F5).
 *
 * Path topology on release (plan-633 F7): an endpoint drag that rasted onto
 * another path end writes the `successors` link (END → START, the direction
 * the ends imply), and a link the drag pulled apart is removed — both only
 * when the shared tolerance (`PATH_LINK_TOLERANCE`, 5 mm / 2°) agrees, so the
 * load-time check never reports what the planner wrote. `segments` and every
 * `successors` write go into ONE transaction of the active edit target: one
 * undo step, and a failed commit leaves nothing half written (the runtime is
 * restored to the pre-drag state).
 *
 * Structural verbs (plan-453): the arc opening angle (sweep handle at the arc
 * end), append / remove a segment at a free chain end (endpoint chrome of the
 * SELECTED path) and split a segment (Alt-click on the selected path). They
 * change the LENGTH of the segment list and are only allowed in the reset state
 * — {@link isStructuralPathEditAllowed}: detached, or paused with both clocks at
 * 0. Each verb is ONE transaction (`segments` + the `Agv.StartPosition` shift a
 * chain-start change implies, §2.4b) tagged by {@link PATH_VERB_LABEL_PREFIX},
 * re-checks the lock inside the document queue, and ends with
 * `resetSimulation()` so vehicles re-derive their start pose from the NEW
 * geometry. Undo / redo of such an entry pass the same lock (a history guard on
 * the document) and reset the same way. The command API
 * ({@link PathVisualizerPlugin.setArcSweep} etc.) is what the pointer handlers
 * call and what tests and later MCP tools use.
 *
 * Layer (plan-628 §2.5): lines, handles and markers hang under ONE root,
 * `__pathNetworkLayer`, registered as the synthetic group
 * {@link PATH_NETWORK_GROUP} — the Groups panel eye, its persistence and
 * `web_group_set_visible` hide the whole network drawing. A hidden layer is
 * inert: no hover, no pointer claim, no handles (so no aux raycast targets).
 * Handles show in every authoring mode (`planner`, `des`), read at init too.
 */

import {
  Group,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  Plane,
  Raycaster,
  SphereGeometry,
  Vector2,
  Vector3,
} from 'three';
import { isUnsafeObjectKey, ownValue } from '../core/engine/rv-safe-keys';
import type { SelectionSnapshot } from '../core/engine/rv-selection-manager';
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
  MAX_SWEEP_DEG,
  MIN_SWEEP_DEG,
  appendSegment,
  arcPointAt,
  cloneSegmentSpecs,
  derivePathHandles,
  movePathHandle,
  pickSegmentPoint,
  rayOnArcPlane,
  readSegmentSpecs,
  removeEndSegment,
  segmentLength,
  setArcDegrees,
  snapDragTarget,
  splitSegment,
  sweepFromPoint,
  writeSegmentSpecs,
  type PathHandle,
  type PathSnapCandidate,
  type Vec3Tuple,
} from '../core/engine/rv-path-edit';
import type { PathArcSpec, PathSegmentSpec } from '../core/engine/rv-path';
import { getDefaultAgvFleet } from '../core/engine/rv-agv-fleet';
import { RvDocument } from '../core/ops/rv-document';
import type { RvOp } from '../core/ops/rv-unified-ops';
import { freshOpId } from '../core/ops/rv-op-utils';
import { getSceneStore } from '../core/hmi/scene/scene-store-singleton';
import { getComponentInstances } from '../core/engine/rv-component-registry';
import { persistFieldOp } from '../core/hmi/scene/scene-field-ops';
import { pointerToNDC } from '../core/engine/rv-pointer-utils';
import { GroupRegistry, markAsOverlay, markNoAO } from '../core/engine/rv-group-registry';
import { loadGroupVisibilitySettings } from '../core/hmi/group-visibility-store';
import { isAuthoringMode } from './layout-planner/authoring-modes';
import { PathNetworkLiveValidation } from './path-network/path-network-validation';
import { FleetAuthoringSource } from '../core/fleet/scene/fleet-authoring-source';
import { dockSignature } from './path-network/path-network-dock';
import { isPathBlockNode, PATH_NETWORK_NODE } from '../core/engine/rv-path-block';
import { getActiveEditTarget, type EditTarget } from '../core/hmi/rv-edit-target';
import {
  analysePathEnd,
  applySuccessorLink,
  planSuccessorChanges as foldSuccessorChanges,
  writeSuccessorsRuntime,
  type PathLinkPair,
  type SuccessorWrite,
} from '../core/connect/path-topology';

/** The synthetic group that toggles the whole path network drawing (plan-628 P3). */
export const PATH_NETWORK_GROUP = 'Path Network';

/** One plain green for every path - straights, curves, zoned or not (Thomas 2026-10-26). */
const PATH_HEX = 0x43a047;
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
const WIDTH_IDLE = 1.5;
const WIDTH_PLANNER = 3;
const WIDTH_HOVER = 6;
/** plan-628 8.9c: a SELECTED block is drawn wider than a hovered one, so the two read apart. */
const WIDTH_SELECTED = 9;
const OPACITY_IDLE = 0.9;
const OPACITY_HOVER = 1;

/** Handle sphere radius in meters. */
const HANDLE_RADIUS_M = 0.09;
/** Endpoint chrome (plan-453 §2.5): append (+) / remove (−) markers of the selected path. */
const CHROME_APPEND_HEX = 0x66bb6a;
const CHROME_REMOVE_HEX = 0xef5350;
const CHROME_RADIUS_M = 0.07;
/** Distance of the append / remove chrome from the free end, along the outward direction (m). */
const CHROME_APPEND_OFFSET_M = 0.35;
const CHROME_REMOVE_OFFSET_M = 0.65;
/** Split picking tolerance in screen pixels (plan-453 §2.7). */
export const SPLIT_PICK_PX = 8;

// ── Structural path verbs (plan-453) ─────────────────────────────────────

/**
 * Label prefix of every structural path-verb transaction. The history guard
 * recognises verb entries by it (a composite keeps its label in the persisted
 * op log, so the guard also holds after a reload).
 */
/**
 * Write new positions into a fat line. three caches the instance count of an
 * instanced geometry when it is first drawn (`_maxInstanceCount`), so
 * `setPositions` with a different segment count on the SAME geometry keeps
 * drawing the old count — a lengthened path showed only its first metres
 * (plan-628 Phase 7). A changed count therefore gets a fresh geometry.
 */
export function setFatLinePositions(line: LineSegments2, positions: Float32Array): void {
  const old = line.geometry as LineSegmentsGeometry;
  const prev = (old.attributes.instanceStart as { count?: number } | undefined)?.count;
  if (prev !== undefined && prev !== positions.length / 6) {
    line.geometry = new LineSegmentsGeometry();
    old.dispose();
  }
  (line.geometry as LineSegmentsGeometry).setPositions(positions);
}

export const PATH_VERB_LABEL_PREFIX = 'Path verb: ';

/** Why a structural path verb did nothing (plan-453 §2.6). */
export type PathVerbFailure =
  | 'sim-locked' | 'not-found' | 'last-segment' | 'closed-path'
  | 'degenerate' | 'not-an-arc' | 'commit-failed';

/** Outcome of a structural path verb (plan-453 §2.6). */
export type PathVerbResult =
  | { readonly ok: true; readonly specs: PathSegmentSpec[] }
  | { readonly ok: false; readonly reason: PathVerbFailure };

/** The narrow view of the viewer the structural edit lock reads. */
export interface StructuralEditLockView {
  readonly runtime?: {
    readonly state: string;
    readonly desControl: { readonly renderClock?: number } | null;
  } | null;
  readonly simTime?: number;
}

/**
 * THE structural path edit lock (plan-453 §2.4, Option B, Thomas 2026-10-19):
 * allowed when the runtime is `detached`, or when it is `paused` (read ONLY
 * from `SimulationRuntime.state`, never from a DES pause flag) AND no simulation
 * time has passed — `simTime === 0` and the DES render clock `=== 0` (in
 * continuous mode there is no DES control; the term is 0). A running or a
 * paused-after-running simulation is locked. A host without a simulation
 * runtime (headless test hosts) has nothing to lock and is allowed; no viewer
 * at all is not. Every verb, its undo / redo and plan-628 read THIS function.
 */
export function isStructuralPathEditAllowed(viewer: StructuralEditLockView | null | undefined): boolean {
  if (!viewer) return false;
  const rt = viewer.runtime;
  if (!rt) return true;
  if (rt.state === 'detached') return true;
  if (rt.state !== 'paused') return false;
  return (viewer.simTime ?? 0) === 0 && (rt.desControl?.renderClock ?? 0) === 0;
}

/** True for a history entry recorded by a structural path verb. */
export function isPathVerbEntry(op: RvOp | null | undefined): boolean {
  return !!op && op.kind === 'composite' && typeof op.label === 'string'
    && op.label.startsWith(PATH_VERB_LABEL_PREFIX);
}

/** Thrown inside a verb transaction to roll it back with a reason. */
class PathVerbAbort extends Error {
  constructor(readonly reason: PathVerbFailure) {
    super(`path verb aborted: ${reason}`);
  }
}

/** One field write of a verb transaction. */
interface VerbFieldWrite {
  readonly node: Object3D;
  readonly componentType: string;
  readonly fieldName: string;
  readonly value: unknown;
  readonly prev: unknown;
}

/** The pure part of a verb: the new list, or why not; plus the chain-start shift (§2.4b). */
type VerbPlan = { specs: PathSegmentSpec[]; startShiftM?: number } | PathVerbFailure;

/** One endpoint chrome marker (append / remove at a free end). */
interface ChromeInfo {
  readonly pathId: string;
  readonly action: 'append' | 'remove';
  readonly end: 'start' | 'end';
}

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
  /** The rastung target of the last update (null = free) — kept for F7 on release. */
  snappedTo: PathSnapCandidate | null;
  /**
   * Sweep drag (plan-453 F1): the arc being opened/closed and the current,
   * continuously unwrapped sweep magnitude in degrees. Null for every other drag.
   */
  sweep: { segIndex: number; arc: PathArcSpec; deg: number } | null;
}

/** One successor link the release changed (plan-633 F7). */
export interface PathSuccessorChange {
  readonly from: string;
  readonly to: string;
  readonly op: 'add' | 'remove';
}

/** Outcome of the durable part of a drag release (see {@link PathVisualizerPlugin.whenCommitted}). */
export interface PathDragCommit {
  readonly ok: boolean;
  readonly pathId: string;
  /** Successor links written in the commit (empty when none changed). */
  readonly successorChanges: readonly PathSuccessorChange[];
  /**
   * Set when the drag rasted onto a path end but no link was written:
   * `'same-end'` (start onto start / end onto end) or `'tolerance'` (the ends
   * meet, the travel directions differ by more than the link tolerance).
   */
  readonly linkSkipped?: 'same-end' | 'tolerance';
  /** The commit error, when `ok` is false (the runtime was restored). */
  readonly error?: unknown;
}

export class PathVisualizerPlugin implements RVViewerPlugin {
  readonly id = 'path-visualizer';

  private viewer: RVViewer | null = null;
  /** `__pathNetworkLayer` — the one member of {@link PATH_NETWORK_GROUP}. */
  private layerRoot: Group | null = null;
  private root: Group | null = null;
  private handleRoot: Group | null = null;
  /** Validation markers (plan-628 Phase 4 fills it). */
  private markerRoot: Group | null = null;
  /** Live validation (plan-628 Phase 4) — publishes Problems + fills {@link markerRoot}. */
  private validation: PathNetworkLiveValidation | null = null;
  /** Topology signature (ids, successors, zones) the validation last saw. */
  private validationSignature = '';
  private stationDockSignature = '';
  private fleetAuthoring: FleetAuthoringSource | null = null;
  /** `layerRoot.visible` as last applied to handles / hover. */
  private layerShown = true;
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
  private chromeGeometry: SphereGeometry | null = null;
  /** Foreign rastung targets (station snappoints, …) — see {@link addSnapCandidateSource}. */
  private readonly snapSources = new Set<PathSnapCandidateSource>();
  /** Durable part of the last release (transaction in flight or settled). */
  private lastCommit: Promise<PathDragCommit | null> = Promise.resolve(null);

  // ── Structural verbs (plan-453) ──
  /** Endpoint chrome meshes of the selected path, keyed `<pathId>|<+|-><start|end>`. */
  private readonly chrome = new Map<string, Mesh>();
  private readonly chromeInfo = new Map<string, ChromeInfo>();
  /** The path whose endpoint chrome / split picking is active (selection-driven). */
  private selectedPathId: string | null = null;
  /** plan-628 D-N4: the selected path came from the network UI's own pick, not the planner selection. */
  private pickedSelection = false;
  /** plan-628 Phase 5: paths of the selected block, drawn emphasised. */
  private readonly blockHighlight = new Set<string>();
  /** plan-628 8.9c: the paths of the block under the pointer (hover feedback for the whole block). */
  private readonly blockHover = new Set<string>();
  /** plan-628 Phase 5: true while the network UI owns the pointer (armed catalog tool). */
  private pointerYield: (() => boolean) | null = null;
  /** Last structural verb started by a pointer handler (tests / UI await it). */
  private lastVerb: Promise<PathVerbResult | null> = Promise.resolve(null);
  /** Lock result the shown handles / chrome were derived with. */
  private shownAllowed = false;
  /** Documents carrying our history guard → their removal. */
  private readonly guardedDocs = new Map<RvDocument, () => void>();
  /** Verb entry the guard just let through — reset once its undo/redo landed. */
  private pendingHistoryReset: string | null = null;
  /** Count of verb resets (verbs + their undo / redo) — diagnostics and tests. */
  private verbResetCount = 0;
  /** Scratch vector for screen projection (split picking). */
  private readonly _proj = new Vector3();

  // Pre-allocated temps — no GC in hover/drag paths.
  /** Handles / chrome live on the overlay layer; a default (layer-0) ray never hits them. */
  private readonly _ray = (() => { const r = new Raycaster(); r.layers.enableAll(); return r; })();
  private readonly _ndc = new Vector2();
  private readonly _plane = new Plane(new Vector3(0, 1, 0), 0);
  private readonly _up = new Vector3(0, 1, 0);
  private readonly _hit = new Vector3();

  // ── Lifecycle ──────────────────────────────────────────────────────────

  init(viewer: RVViewer): void {
    this.viewer = viewer;
    this.layerRoot = new Group();
    this.layerRoot.name = '__pathNetworkLayer';
    this.layerRoot.frustumCulled = false;
    viewer.scene.add(this.layerRoot);
    this.layerShown = true;

    this.root = new Group();
    this.root.name = '__pathVisualizer';
    this.root.renderOrder = 500;
    this.root.frustumCulled = false;
    this.layerRoot.add(this.root);

    this.handleRoot = new Group();
    this.handleRoot.name = '__pathHandles';
    this.handleRoot.renderOrder = 520;
    this.handleRoot.frustumCulled = false;
    this.handleRoot.visible = false;
    this.layerRoot.add(this.handleRoot);

    this.markerRoot = new Group();
    this.markerRoot.name = '__pathMarkers';
    this.markerRoot.frustumCulled = false;
    this.layerRoot.add(this.markerRoot);
    this.validation = new PathNetworkLiveValidation(viewer, this.markerRoot);
    this.fleetAuthoring = FleetAuthoringSource.of(viewer);
    this.fleetAuthoring.attach(viewer);
    this.unsubs.push(this.fleetAuthoring.onInvalidate(() => this.validation?.markDirty()));

    // Live-edit channel: rebuild exactly the changed path (plan-447).
    this.unsubs.push(
      getDefaultPathNetwork().onPathChanged((pathId) => this.onPathChanged(pathId)),
    );

    // Every authoring mode drives emphasis + handles (plan-628 B9: `des` too,
    // and the mode active at boot — no mode-changed is coming for it).
    this.unsubs.push(
      viewer.on('mode-changed', (d: { to: string }) => this.setPlannerMode(isAuthoringMode(d.to))),
    );
    this.setPlannerMode(isAuthoringMode(viewer.modes?.activeMode ?? null));
    // Hover highlight — resolved through the ordinary raycast pipeline.
    this.unsubs.push(
      viewer.on('object-hover', (d: { node: Object3D } | null) =>
        this.setHoveredPath(d ? this.pathIdForNode(d.node) : null),
      ),
    );
    // plan-453: the selected path carries the endpoint chrome and the split pick.
    this.unsubs.push(
      viewer.on('selection-changed', (snap: SelectionSnapshot) => {
        const node = snap?.primaryNode ?? null;
        // plan-628 D-N4: a path entered through a block (double click) is not a
        // planner selection — the planner's "nothing selected" must not drop it.
        if (!node && this.pickedSelection) return;
        this.pickedSelection = false;
        this.setSelectedPath(this.pathIdForSelection(node));
      }),
    );
    // plan-453 §2.4: the structural lock follows the simulation state — a state
    // change aborts an in-flight sweep drag and re-derives handles / chrome.
    for (const ev of ['simulation-pause-changed', 'runtime-attach-changed', 'simulation-start'] as const) {
      this.unsubs.push(viewer.on(ev, () => this.onSimStateChanged()));
    }

    this.wirePointer();
    this.ensureHistoryGuards();
  }

  onRender(): void {
    this.syncLayerVisibility();
    this.validation?.tick();
    if (this.drag) {
      // A sweep drag is a structural verb: it dies with the lock (§9.12).
      if (this.drag.sweep && !this.structuralAllowed()) this.cancelDrag();
      return; // during a drag the preview owns the geometry
    }
    const now = performance.now();
    if (now - this.lastCheck < CHECK_INTERVAL_MS) return;
    this.lastCheck = now;
    this.ensureHistoryGuards();
    if (this.plannerMode && this.structuralAllowed() !== this.shownAllowed) this.rebuildHandles();
    // Fat lines need the viewport resolution for their pixel-space width; a
    // canvas resize would otherwise silently change the drawn thickness.
    this.syncLineResolution();
    const paths = getDefaultPathNetwork().all();
    if (this.plannerMode && this.validation) {
      const vsig = paths.map((p) => `${p.id}>${p.successors.map((q) => q.id).join(',')}`).join('|');
      if (vsig !== this.validationSignature) { this.validationSignature = vsig; this.validation.markDirty(); }
      const dsig = dockSignature(this.viewer!);
      if (dsig !== this.stationDockSignature) { this.stationDockSignature = dsig; this.validation.markDirty(); }
    }
    const sig = paths
      .map((p) => `${p.id}:${p.length.toFixed(4)}:${p.zoneId ?? ''}:${p.closed ? 1 : 0}`)
      .join('|');
    if (sig === this.signature) return;
    this.signature = sig;
    this.validation?.markDirty();
    this.rebuildAll(paths);
    // Paths of a layout document arrive AFTER model-loaded (stored addNodes).
    this.ensureLayerGroup();
  }

  onModelLoaded(): void {
    this.validation?.markDirty();
    this.ensureLayerGroup();
  }

  onModelCleared(): void {
    // The network clears with the model; force the next check to rebuild empty.
    this.signature = ' stale';
    this.lastCheck = 0;
    this.validation?.clear();
    this.validation?.markDirty();
    this.cancelDrag();
    this.clearLines();
    this.clearHandles();
    this.nodeByPathId.clear();
    this.selectedPathId = null;
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
    for (const remove of this.guardedDocs.values()) remove();
    this.guardedDocs.clear();
    this.snapSources.clear();
    this.cancelDrag();
    this.clearLines();
    this.clearHandles();
    this.handleGeometry?.dispose();
    this.handleGeometry = null;
    this.chromeGeometry?.dispose();
    this.chromeGeometry = null;
    this.root = null;
    this.handleRoot = null;
    this.validation?.dispose();
    this.validation = null;
    this.fleetAuthoring?.dispose();
    this.fleetAuthoring = null;
    this.markerRoot = null;
    if (this.layerRoot) {
      this.viewer?.groups?.unregister(PATH_NETWORK_GROUP, this.layerRoot);
      this.viewer?.scene.remove(this.layerRoot);
      this.layerRoot = null;
    }
    this.nodeByPathId.clear();
    this.viewer = null;
  }

  // ── Public state (also the test seam) ──────────────────────────────────

  /** Authoring-mode (planner / des) emphasis + drag handles on/off. Idempotent. */
  setPlannerMode(active: boolean): void {
    if (this.plannerMode === active) return;
    this.plannerMode = active;
    this.validation?.setActive(active);
    if (!active) this.cancelDrag();
    for (const [pathId, line] of this.lines) this.applyStyle(pathId, line);
    if (active) this.rebuildHandles();
    else this.clearHandles();
    if (this.handleRoot) this.handleRoot.visible = active;
    this.viewer?.markRenderDirty();
  }

  /** The live network validation (plan-628 Phase 4) — diagnostics and tests. */
  get liveValidation(): PathNetworkLiveValidation | null {
    return this.validation;
  }

  /** True while the planner emphasis/handles are on. */
  get isPlannerMode(): boolean {
    return this.plannerMode;
  }

  /** Highlight one path (null clears). Ignored while the layer is hidden. */
  setHoveredPath(pathId: string | null): void {
    if (pathId !== null && !this.isLayerVisible) pathId = null;
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

  /** The `__pathNetworkLayer` root (the group member). Null before init / after dispose. */
  get layer(): Object3D | null {
    return this.layerRoot;
  }

  /** False while the {@link PATH_NETWORK_GROUP} layer is hidden. */
  get isLayerVisible(): boolean {
    return this.layerRoot?.visible !== false;
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
    // plan-453 §2.4: the sweep handle is a structural verb — it does not react
    // outside the reset state (it is not even derived there).
    const allowed = this.structuralAllowed();
    const handle = derivePathHandles(before, { sweep: allowed }).find((h) => h.id === handleId);
    if (!handle) return false;
    const arc = handle.kind === 'arc-sweep' ? before[handle.prevSegIndex] : null;
    this.drag = {
      pathId,
      handleId,
      before,
      preview: cloneSegmentSpecs(before),
      endpoint: handle.endpoint && handle.kind === 'vertex',
      planeY: handle.position[1],
      moved: false,
      snappedTo: null,
      sweep: arc && arc.kind === 'arc'
        ? { segIndex: handle.prevSegIndex, arc, deg: Math.abs(arc.degrees) }
        : null,
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
    if (drag.sweep) {
      // plan-453 F1/§2.7: the point runs on the circle — only `degrees` changes,
      // continuously unwrapped against the previous sweep, then clamped.
      const raw = sweepFromPoint(drag.sweep.arc, target, drag.sweep.deg);
      const deg = Math.min(MAX_SWEEP_DEG, Math.max(MIN_SWEEP_DEG, raw));
      drag.sweep.deg = deg;
      drag.preview = setArcDegrees(drag.before, drag.sweep.segIndex, deg) ?? cloneSegmentSpecs(drag.before);
      drag.moved = true;
      this.previewPath(drag.pathId, drag.preview);
      this.viewer?.markRenderDirty();
      return;
    }
    let point = target;
    if (drag.endpoint) {
      const res = snapDragTarget(
        target,
        this.snapCandidates(drag.pathId, drag.handleId),
        DEFAULT_PATH_SNAP_RADIUS_M,
      );
      point = res.position;
      drag.snappedTo = res.snappedTo;
    }
    drag.preview = movePathHandle(drag.before, drag.handleId, point);
    drag.moved = true;
    this.previewPath(drag.pathId, drag.preview);
    this.viewer?.markRenderDirty();
  }

  /**
   * Release the drag: write the new segment list into the node (optimistic
   * runtime update), re-derive the engine path through the ordinary
   * `reapplyConfig()` route, and record the undoable `setField` op — together
   * with the `successors` writes of an endpoint rastung (F7) in one
   * transaction. Returns the committed segment list (null when nothing moved);
   * the durable part settles in {@link whenCommitted}.
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
    if (drag.sweep) {
      // plan-453 §2.6: the sweep commits through the command (lock re-check,
      // one undoable op, reset). The preview stays until the path re-derives;
      // a refused / failed command redraws the committed state.
      const specs = drag.preview;
      this.lastVerb = this.setArcSweep(drag.pathId, drag.sweep.segIndex, drag.sweep.deg).then((r) => {
        if (!r.ok) this.refresh();
        return r;
      });
      return specs;
    }
    const node = this.nodeByPathId.get(drag.pathId);
    if (!node) {
      this.refresh();
      return null;
    }
    const specs = drag.preview;
    // The links of the dragged end BEFORE the write (F7 bookkeeping).
    const which: 'start' | 'end' | null = drag.endpoint ? (drag.handleId === 'v0' ? 'start' : 'end') : null;
    const linksBefore = which ? linksOfEnd(getDefaultPathNetwork(), drag.pathId, which) : [];
    // 1. Optimistic runtime write + live re-derivation (fires the change event,
    //    which re-projects travelers and re-registers path snaps).
    writeSegmentSpecs(node as unknown as { userData: Record<string, unknown> }, specs);
    pathComponentOf(node)?.reapplyConfig();
    // 2. Path topology of the new geometry (F7): which successor links change.
    const plan = which ? this.planSuccessorChanges(drag, which, linksBefore) : { changes: [], writes: [] };
    // 3. Durable + undoable: segments and successors in ONE transaction.
    const nodePath = this.viewer?.registry?.getPathForNode(node) ?? null;
    this.lastCommit = this.commitRelease(
      drag.pathId, node, nodePath, cloneSegmentSpecs(specs), drag.before, plan,
    );
    this.refresh();
    return specs;
  }

  /**
   * The durable outcome of the last {@link endHandleDrag}: resolves once its
   * transaction committed (`ok: true`) or was rolled back (`ok: false`, runtime
   * restored). Null before the first release with movement.
   */
  whenCommitted(): Promise<PathDragCommit | null> {
    return this.lastCommit;
  }

  /**
   * Successor changes of an endpoint release: the link onto the rastung target
   * (END → START in travel direction, only when the shared tolerance holds
   * AFTER the write) and every link of the dragged end the drag pulled apart.
   */
  private planSuccessorChanges(
    drag: HandleDragState,
    which: 'start' | 'end',
    linksBefore: readonly PathLinkPair[],
  ): SuccessorPlan {
    const network = getDefaultPathNetwork();
    const after = linksOfEnd(network, drag.pathId, which);
    const key = (l: { from: string; to: string }): string => `${l.from}>${l.to}`;
    const afterKeys = new Set(after.map(key));
    const wanted: PathSuccessorChange[] = [];
    for (const l of linksBefore) {
      if (!afterKeys.has(key(l))) wanted.push({ from: l.from, to: l.to, op: 'remove' });
    }
    let skipped: 'same-end' | 'tolerance' | undefined;
    const target = drag.snappedTo?.pathEnd;
    if (target && target.pathId !== drag.pathId) {
      let link: { from: string; to: string } | null = null;
      if (which === 'end' && target.which === 'start') link = { from: drag.pathId, to: target.pathId };
      else if (which === 'start' && target.which === 'end') link = { from: target.pathId, to: drag.pathId };
      if (!link) skipped = 'same-end';
      else if (!afterKeys.has(key(link))) skipped = 'tolerance';
      else wanted.push({ ...link, op: 'add' });
    }
    // One write per source path, all of its changes folded in order
    // (`planSuccessorChanges` of the path topology). `changes` keeps the order
    // of `wanted`; the writes follow the first applied change of each path.
    const opsByFrom = new Map<string, { idx: number[]; ops: { toId: string; op: 'add' | 'remove' }[] }>();
    wanted.forEach((c, idx) => {
      if (!network.get(c.from)) return;
      let group = opsByFrom.get(c.from);
      if (!group) { group = { idx: [], ops: [] }; opsByFrom.set(c.from, group); }
      group.idx.push(idx);
      group.ops.push({ toId: c.to, op: c.op });
    });
    const appliedIdx = new Set<number>();
    const folded = new Map<string, { prev: string[]; next: string[] }>();
    for (const [from, group] of opsByFrom) {
      const r = foldSuccessorChanges(network.get(from)!, group.ops);
      if (!r) continue;
      folded.set(from, { prev: r.prev, next: r.next });
      r.applied.forEach((ok, k) => { if (ok) appliedIdx.add(group.idx[k]); });
    }
    const changes: PathSuccessorChange[] = [];
    const byFrom = new Map<string, { prev: string[]; next: string[] }>();
    wanted.forEach((c, idx) => {
      if (!appliedIdx.has(idx)) return;
      changes.push(c);
      if (!byFrom.has(c.from)) byFrom.set(c.from, folded.get(c.from)!);
    });
    const writes: SuccessorWrite[] = [];
    for (const [from, { prev, next }] of byFrom) {
      this.indexNode(from);
      const node = this.nodeByPathId.get(from);
      if (!node) continue;
      writes.push({ pathId: from, node, nodePath: this.viewer?.registry?.getPathForNode(node) ?? null, prev, next });
    }
    return { changes, writes, ...(skipped ? { skipped } : {}) };
  }

  /** Segments + successors in one transaction; on failure restore the pre-drag runtime. */
  private async commitRelease(
    pathId: string,
    node: Object3D,
    nodePath: string | null,
    specs: PathSegmentSpec[],
    before: PathSegmentSpec[],
    plan: SuccessorPlan,
  ): Promise<PathDragCommit> {
    const target = getActiveEditTarget();
    try {
      await target.withTransaction('Edit path', async () => {
        if (target.available && nodePath) {
          if (target.setFieldAsync) {
            await target.setFieldAsync(nodePath, 'Path', 'segments', specs, before);
          } else {
            persistFieldOp(nodePath, 'Path', 'segments', specs, before);
          }
        }
        for (const w of plan.writes) await applySuccessorLink(w, target);
      });
      return {
        ok: true,
        pathId,
        successorChanges: plan.changes,
        ...(plan.skipped ? { linkSkipped: plan.skipped } : {}),
      };
    } catch (error) {
      // Nothing half written: the transaction rolled back what it applied;
      // the optimistic runtime writes go back to the pre-drag state here.
      writeSegmentSpecs(node as unknown as { userData: Record<string, unknown> }, before);
      pathComponentOf(node)?.reapplyConfig();
      for (const w of plan.writes) writeSuccessorsRuntime(w.node, w.prev);
      console.error(`[path-visualizer] commit of path '${pathId}' failed — restored the pre-drag state:`, error);
      this.refresh();
      return { ok: false, pathId, successorChanges: [], error };
    }
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

  // ── Structural verb commands (plan-453 §2.6) ───────────────────────────

  /** True while structural path edits are allowed for this viewer (§2.4). */
  structuralAllowed(): boolean {
    return isStructuralPathEditAllowed(this.viewer as unknown as StructuralEditLockView | null);
  }

  /** Set the opening angle of arc `segIndex` of `pathId` (F1; magnitude clamped to [1°, 360°], sign kept). */
  setArcSweep(pathId: string, segIndex: number, degrees: number): Promise<PathVerbResult> {
    return this.runVerb(pathId, 'arc sweep', (specs) => {
      const seg = specs[segIndex];
      if (!seg) return 'not-found';
      if (seg.kind !== 'arc') return 'not-an-arc';
      const out = setArcDegrees(specs, segIndex, degrees);
      return out ? { specs: out } : 'not-an-arc';
    });
  }

  /**
   * Append one segment at the free `end` of `pathId` (F2): same kind and
   * dimensions as the neighbour, tangential. At the chain START every Agv
   * whose resolved start path is this path moves its `StartPosition` by +ΔL in
   * the same transaction (§2.4b).
   */
  appendPathSegment(pathId: string, end: 'start' | 'end'): Promise<PathVerbResult> {
    return this.runVerb(pathId, `append segment at ${end}`, (specs, closed) => {
      if (closed) return 'closed-path';
      const out = appendSegment(specs, end);
      if (!out) return 'degenerate';
      const added = end === 'start' ? out[0] : out[out.length - 1];
      return end === 'start' ? { specs: out, startShiftM: segmentLength(added) } : { specs: out };
    });
  }

  /**
   * Remove the segment at the free `end` of `pathId` (F3) — never the last one,
   * never on a closed path. At the chain START the `StartPosition` of the
   * affected Agvs moves by −ΔL, clamped to 0 (§2.4b).
   */
  removePathEndSegment(pathId: string, end: 'start' | 'end'): Promise<PathVerbResult> {
    return this.runVerb(pathId, `remove segment at ${end}`, (specs, closed) => {
      if (closed) return 'closed-path';
      if (specs.length <= 1) return 'last-segment';
      const out = removeEndSegment(specs, end);
      if (!out) return 'last-segment';
      const removed = end === 'start' ? specs[0] : specs[specs.length - 1];
      return end === 'start' ? { specs: out, startShiftM: -segmentLength(removed) } : { specs: out };
    });
  }

  /** Split segment `segIndex` of `pathId` at `t01` (F4) — the geometry is unchanged. */
  splitPathSegment(pathId: string, segIndex: number, t01: number): Promise<PathVerbResult> {
    return this.runVerb(pathId, 'split segment', (specs) => {
      if (!specs[segIndex]) return 'not-found';
      const out = splitSegment(specs, segIndex, t01);
      return out ? { specs: out } : 'degenerate';
    });
  }

  /** The last verb a pointer handler started (sweep release, chrome click, split click). */
  whenVerbSettled(): Promise<PathVerbResult | null> {
    return this.lastVerb;
  }

  /** How many verb resets ran (each verb, each verb undo / redo) — diagnostics / tests. */
  get structuralResetCount(): number {
    return this.verbResetCount;
  }

  /**
   * The ONE verb pipeline (§2.6): (1) lock, (2) pure op, (3) one transaction
   * with the lock re-checked inside the document queue, (4) the engine path
   * re-derived, (5) `resetSimulation()` only after success.
   */
  private async runVerb(
    pathId: string,
    what: string,
    plan: (specs: PathSegmentSpec[], closed: boolean) => VerbPlan,
  ): Promise<PathVerbResult> {
    const fail = (reason: PathVerbFailure): PathVerbResult => ({ ok: false, reason });
    if (!this.structuralAllowed()) return fail('sim-locked');
    const network = getDefaultPathNetwork();
    const path = network.get(pathId);
    if (path) this.indexNode(pathId);
    const node = this.nodeByPathId.get(pathId);
    if (!path || !node) return fail('not-found');
    const before = readSegmentSpecs(node as unknown as { userData: Record<string, unknown> });
    const planned = plan(cloneSegmentSpecs(before), path.closed);
    if (typeof planned === 'string') return fail(planned);
    const after = planned.specs;
    const writes: VerbFieldWrite[] = [
      { node, componentType: 'Path', fieldName: 'segments', value: cloneSegmentSpecs(after), prev: before },
    ];
    if (planned.startShiftM) writes.push(...this.startPositionWrites(pathId, planned.startShiftM));
    const committed = await this.commitVerb(`${PATH_VERB_LABEL_PREFIX}${what}`, writes);
    if (committed !== 'ok') return fail(committed);
    // (4) The executor re-derives through `reapplySchemaForComponent`; a target
    // without one (pre-boot, headless host) leaves the old RVPath — derive here.
    if (network.get(pathId) === path) {
      writeSegmentSpecs(node as unknown as { userData: Record<string, unknown> }, after);
      pathComponentOf(node)?.reapplyConfig();
    }
    // (5) Vehicles, MUs and zones re-derive from the NEW geometry (2.4c).
    this.resetAfterVerb();
    if (this.plannerMode) this.rebuildHandles();
    return { ok: true, specs: cloneSegmentSpecs(after) };
  }

  /**
   * `StartPosition` writes for a chain-start verb (§2.4b): every Agv whose
   * RESOLVED start path (fleet handle `startPathId` — PathId, or its Path node)
   * is `pathId` moves by `shiftM`, clamped to ≥ 0. The value is written into the
   * component the configuration lives in (`Agv`, else `AgvBehavior`).
   */
  private startPositionWrites(pathId: string, shiftM: number): VerbFieldWrite[] {
    const out: VerbFieldWrite[] = [];
    for (const h of getDefaultAgvFleet().handleList) {
      if (h.startPathId !== pathId || !h.node) continue;
      const rv = (h.node.userData?.realvirtual ?? {}) as Record<string, Record<string, unknown> | undefined>;
      const componentType = rv['Agv'] ? 'Agv' : rv['AgvBehavior'] ? 'AgvBehavior' : 'Agv';
      // The effective value — the same merge order Agv.configBag reads (Agv wins).
      const effective = Number(rv['Agv']?.['StartPosition'] ?? rv['AgvBehavior']?.['StartPosition'] ?? 0);
      const cur = Number.isFinite(effective) ? effective : 0;
      const next = Math.max(0, cur + shiftM * 1000);
      if (next === cur) continue;
      out.push({
        node: h.node,
        componentType,
        fieldName: 'StartPosition',
        value: next,
        prev: rv[componentType]?.['StartPosition'],
      });
    }
    return out;
  }

  /**
   * Commit the field writes of one verb as ONE transaction (§2.6 step 3). With
   * a scene `RvDocument` behind the active target, every write is PLANNED in the
   * document queue and re-checks the lock there; a lock that flipped in between
   * aborts the transaction (nothing recorded) with `'sim-locked'`, an executor
   * failure rolls it back with `'commit-failed'`. Without an undoable target the
   * writes go to the runtime only (the verb still works, it is just not undoable).
   */
  private async commitVerb(label: string, writes: readonly VerbFieldWrite[]): Promise<'ok' | PathVerbFailure> {
    const target = getActiveEditTarget();
    const doc = plannerDocumentOf(target);
    if (doc) this.ensureGuard(doc);
    const registry = this.viewer?.registry ?? null;
    const resolved = writes.map((w) => ({ ...w, nodePath: registry?.getPathForNode(w.node) ?? null }));
    const durable = resolved.filter((w) => w.nodePath !== null);
    const runtimeOnly = resolved.filter((w) => w.nodePath === null);
    if (!target.available || durable.length === 0 || durable[0].node !== writes[0].node) {
      // No undoable target (or the path itself has no address): runtime only.
      if (!this.structuralAllowed()) return 'sim-locked';
      for (const w of resolved) writeRuntimeField(w.node, w.componentType, w.fieldName, w.value);
      return 'ok';
    }
    try {
      await target.withTransaction(label, async () => {
        for (const w of durable) {
          if (doc) {
            const applied = await doc.applyPlanned(() => (this.structuralAllowed()
              ? { op: setFieldOp(w.nodePath!, w.componentType, w.fieldName, w.value, w.prev), result: true }
              : { op: null, result: false }));
            if (applied === null) throw new PathVerbAbort('commit-failed');
            if (applied === false) throw new PathVerbAbort('sim-locked');
          } else {
            if (!this.structuralAllowed()) throw new PathVerbAbort('sim-locked');
            if (target.setFieldAsync) await target.setFieldAsync(w.nodePath!, w.componentType, w.fieldName, w.value, w.prev);
            else target.setField(w.nodePath!, w.componentType, w.fieldName, w.value, w.prev);
          }
        }
      });
    } catch (error) {
      if (error instanceof PathVerbAbort) return error.reason;
      console.error(`[path-visualizer] structural path verb "${label}" failed — nothing was written:`, error);
      return 'commit-failed';
    }
    // Writes without an address (an Agv the registry does not know) cannot be undone.
    for (const w of runtimeOnly) {
      console.warn(`[path-visualizer] ${label}: ${w.componentType}.${w.fieldName} of '${w.node.name}' has no node path — written to the runtime only (not undoable).`);
      writeRuntimeField(w.node, w.componentType, w.fieldName, w.value);
    }
    return 'ok';
  }

  /** `resetSimulation()` after a verb or its undo / redo (§2.4 Option B, 2.4c). */
  private resetAfterVerb(): void {
    this.verbResetCount++;
    const v = this.viewer as unknown as { resetSimulation?: () => void } | null;
    v?.resetSimulation?.();
  }

  // ── History guard (plan-453 §2.6, undo / redo of verb entries) ─────────

  /** Install the guard on the planner's document(s) this plugin's edits land in (plan-628 commands call it too). */
  ensureHistoryGuards(): void {
    const store = getSceneStore();
    const doc = store ? (store as unknown as { document?: unknown }).document : null;
    if (doc instanceof RvDocument) this.ensureGuard(doc);
    const fromTarget = plannerDocumentOf(getActiveEditTarget());
    if (fromTarget) this.ensureGuard(fromTarget);
  }

  private ensureGuard(doc: RvDocument): void {
    if (this.guardedDocs.has(doc)) return;
    const removeGuard = doc.addHistoryGuard((entry) => {
      if (!isPathVerbEntry(entry)) return true;
      if (!this.structuralAllowed()) return false;
      this.pendingHistoryReset = entry.id;
      return true;
    });
    const removeObserver = doc.onHistoryChange((change) => {
      if ((change.kind !== 'undo' && change.kind !== 'redo') || !change.opId) return;
      if (change.opId !== this.pendingHistoryReset) return;
      this.pendingHistoryReset = null;
      this.resetAfterVerb();
      if (this.plannerMode) this.rebuildHandles();
    });
    this.guardedDocs.set(doc, () => { removeGuard(); removeObserver(); });
  }

  private onSimStateChanged(): void {
    const allowed = this.structuralAllowed();
    if (!allowed && this.drag?.sweep) this.cancelDrag();
    if (this.plannerMode && allowed !== this.shownAllowed) this.rebuildHandles();
  }

  // ── Selection (endpoint chrome / split pick) ───────────────────────────

  /** The path whose endpoint chrome and split pick are active (null = none). */
  setSelectedPath(pathId: string | null): void {
    if (this.selectedPathId === pathId) return;
    this.selectedPathId = pathId;
    if (this.plannerMode) this.rebuildHandles();
    this.viewer?.markRenderDirty();
  }

  get selectedPath(): string | null {
    return this.selectedPathId;
  }

  /**
   * plan-628 D-N4: select a path from the network UI's own pick (double click
   * into a block, click on a block-free path). Survives the planner clearing
   * its instance selection; the next real planner selection replaces it.
   */
  selectPickedPath(pathId: string | null): void {
    this.pickedSelection = pathId !== null;
    this.setSelectedPath(pathId);
  }

  /** plan-628 Phase 5: while `fn()` is true the visualizer leaves pointer-down to the network UI. */
  setPointerYield(fn: (() => boolean) | null): void {
    this.pointerYield = fn;
  }

  /** plan-628 Phase 5: draw these paths emphasised (the selected block); empty clears. */
  setBlockHighlight(pathIds: Iterable<string>): void {
    const next = new Set(pathIds);
    const touched = new Set([...this.blockHighlight, ...next]);
    this.blockHighlight.clear();
    for (const id of next) this.blockHighlight.add(id);
    for (const id of touched) {
      const line = this.lines.get(id);
      if (line) this.applyStyle(id, line);
    }
    this.viewer?.markRenderDirty();
  }

  /** plan-628 8.9c: draw these paths as hovered (the block under the pointer); empty clears. */
  setBlockHover(pathIds: Iterable<string>): void {
    const next = new Set(pathIds);
    if (next.size === this.blockHover.size && [...next].every((id) => this.blockHover.has(id))) return;
    const touched = new Set([...this.blockHover, ...next]);
    this.blockHover.clear();
    for (const id of next) this.blockHover.add(id);
    for (const id of touched) {
      const line = this.lines.get(id);
      if (line) this.applyStyle(id, line);
    }
    this.viewer?.markRenderDirty();
  }

  /** plan-628 8.9c: the paths currently drawn as the hovered block (tests / diagnostics). */
  get hoveredBlockPaths(): readonly string[] {
    return [...this.blockHover];
  }

  /**
   * plan-628 Phase 5: the path line under a screen point (fat-line pick with a
   * pixel threshold) and the world hit point. Null while the layer is hidden.
   */
  pickLineAt(clientX: number, clientY: number, thresholdPx = 8): { pathId: string; point: Vec3Tuple } | null {
    const viewer = this.viewer;
    const canvas = viewer?.renderer?.domElement as HTMLCanvasElement | undefined;
    if (!viewer || !canvas || !this.isLayerVisible || this.lines.size === 0) return null;
    if (viewer.pointerPickBlocked) return null; // plan-2215: no screen pick under a render strategy
    pointerToNDC(clientX, clientY, canvas, this._ndc);
    this._ray.setFromCamera(this._ndc, viewer.camera);
    const params = this._ray.params as unknown as { Line2?: { threshold: number } };
    const prev = params.Line2;
    params.Line2 = { threshold: thresholdPx };
    try {
      const hits = this._ray.intersectObjects([...this.lines.values()], false);
      if (hits.length === 0) return null;
      const id = (hits[0].object.userData as { _rvPathId?: string })._rvPathId;
      const p = (hits[0] as { pointOnLine?: Vector3 }).pointOnLine ?? hits[0].point;
      return id ? { pathId: id, point: [p.x, p.y - Y_LIFT, p.z] } : null;
    } finally {
      params.Line2 = prev;
    }
  }

  /**
   * plan-628 Phase 5: preview a rigid move of whole lines (block gizmo) — the
   * matrix is applied to the drawn lines only, never to data. Null restores.
   */
  previewLineTransform(pathIds: Iterable<string>, matrix: Matrix4 | null): void {
    for (const id of pathIds) {
      const line = this.lines.get(id);
      if (!line) continue;
      if (matrix) {
        line.matrixAutoUpdate = false;
        line.matrix.copy(matrix);
      } else {
        line.matrix.identity();
        line.matrixAutoUpdate = true;
        line.position.set(0, 0, 0);
        line.rotation.set(0, 0, 0);
        line.updateMatrix();
      }
      line.matrixWorldNeedsUpdate = true;
    }
    this.viewer?.markRenderDirty();
  }

  /** The endpoint chrome currently shown, keyed `<pathId>|<+|-><start|end>`. */
  getChromeObjects(): ReadonlyMap<string, Mesh> {
    return this.chrome;
  }

  /**
   * Split target under a screen point (plan-453 §2.7): every segment of the
   * SELECTED path is hit by the pointer ray (a line by closest points, an arc
   * in its own plane); the winner is the segment point with the smallest
   * screen distance below {@link SPLIT_PICK_PX}. Null when nothing is close
   * enough or the point is within 1 mm of a segment end (the vertex handle).
   */
  pickSplitAt(clientX: number, clientY: number): { pathId: string; segIndex: number; t01: number } | null {
    const viewer = this.viewer;
    const pathId = this.selectedPathId;
    const canvas = viewer?.renderer?.domElement as HTMLCanvasElement | undefined;
    if (!viewer || !pathId || !canvas) return null;
    if (viewer.pointerPickBlocked) return null; // plan-2215: no screen pick under a render strategy
    const node = this.nodeByPathId.get(pathId);
    if (!node) return null;
    const specs = readSegmentSpecs(node as unknown as { userData: Record<string, unknown> });
    pointerToNDC(clientX, clientY, canvas, this._ndc);
    this._ray.setFromCamera(this._ndc, viewer.camera);
    const o = this._ray.ray.origin;
    const d = this._ray.ray.direction;
    const rect = canvas.getBoundingClientRect();
    let best: { segIndex: number; t01: number; px: number } | null = null;
    for (let i = 0; i < specs.length; i++) {
      const hit = pickSegmentPoint(specs[i], [o.x, o.y, o.z], [d.x, d.y, d.z]);
      if (!hit) continue;
      this._proj.set(hit.point[0], hit.point[1] + Y_LIFT, hit.point[2]).project(viewer.camera);
      const sx = rect.left + ((this._proj.x + 1) / 2) * rect.width;
      const sy = rect.top + ((1 - this._proj.y) / 2) * rect.height;
      const px = Math.hypot(sx - clientX, sy - clientY);
      if (px < SPLIT_PICK_PX && (!best || px < best.px)) best = { segIndex: i, t01: hit.t01, px };
    }
    if (!best) return null;
    if (!splitSegment(specs, best.segIndex, best.t01)) return null; // at a segment end
    return { pathId, segIndex: best.segIndex, t01: best.t01 };
  }

  // ── Layer (plan-628 §2.5) ──────────────────────────────────────────────

  /**
   * Register the layer as {@link PATH_NETWORK_GROUP} once the network has a
   * path — idempotent, `groups-changed` only for a NEW membership (never in
   * reply to `groups-changed`: its listeners run synchronously). The load
   * replaces `viewer.groups`, so this runs after every load and from the poll.
   * A registration after `model-loaded` missed the persisted-visibility pass
   * (GroupsOverlay), so the saved hidden state is applied here as well.
   */
  private ensureLayerGroup(): void {
    const viewer = this.viewer;
    const layer = this.layerRoot;
    if (!viewer || !layer || getDefaultPathNetwork().size === 0) return;
    if (viewer.groups?.get(PATH_NETWORK_GROUP)?.nodes.includes(layer)) return;
    const groups = (viewer.groups ??= new GroupRegistry());
    groups.register(PATH_NETWORK_GROUP, layer);
    const saved = loadGroupVisibilitySettings();
    if (!saved.isolatedGroup && saved.hiddenGroups.includes(PATH_NETWORK_GROUP)) {
      groups.setVisible(PATH_NETWORK_GROUP, false);
    }
    this.syncLayerVisibility();
    viewer.emit('groups-changed', { source: 'path-network' });
  }

  /** Follow `layerRoot.visible`: hidden drops hover, drag and handles; shown restores handles. */
  private syncLayerVisibility(): void {
    const shown = this.isLayerVisible;
    if (shown === this.layerShown) return;
    this.layerShown = shown;
    if (!shown) {
      this.cancelDrag();
      this.setHoveredPath(null);
      this.clearHandles();
    } else if (this.plannerMode) {
      this.rebuildHandles();
    }
    this.viewer?.markRenderDirty();
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
    // plan-628 Phase 5: the signature below covers EVERY path — a path that was
    // registered in the same transaction (a placed block next to the relinked
    // predecessor) would otherwise never get its line from the poll.
    for (const p of getDefaultPathNetwork().all()) {
      if (p.id !== pathId && !this.lines.has(p.id)) {
        this.indexNode(p.id);
        this.rebuildPath(p);
      }
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
        color: PATH_HEX,
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
    setFatLinePositions(line, new Float32Array(positions));
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
    setFatLinePositions(line, new Float32Array(positions));
    line.computeLineDistances();
    // Handles follow the preview so the dragged sphere sits under the cursor.
    this.syncHandlePositions(pathId, specs);
  }

  private applyStyle(pathId: string, line: LineSegments2): void {
    const selected = this.blockHighlight.has(pathId);
    const hovered = selected || this.hoveredPathId === pathId || this.blockHover.has(pathId);
    const mat = line.material as LineMaterial;
    mat.color.setHex(hovered ? HOVER_HEX : PATH_HEX);
    mat.linewidth = selected ? WIDTH_SELECTED : hovered ? WIDTH_HOVER : this.plannerMode ? WIDTH_PLANNER : WIDTH_IDLE;
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
    // A hidden layer has no handles — and so no aux raycast targets (M4).
    if (!this.plannerMode || !this.handleRoot || !this.isLayerVisible) return;
    const rm = this.viewer?.raycastManager ?? null;
    // plan-453 §2.4: the structural affordances (sweep handles, endpoint chrome)
    // exist only while the lock allows them — not greyed out, absent.
    const allowed = this.structuralAllowed();
    this.shownAllowed = allowed;
    for (const path of getDefaultPathNetwork().all()) {
      const node = this.nodeByPathId.get(path.id);
      if (!node) continue;
      // plan-628 D-N4: a path inside a block has handles only once the block is
      // entered (its path selected) — a block is grabbed as a whole.
      if (path.id !== this.selectedPathId && node.parent && isPathBlockNode(node.parent)) continue;
      const specs = readSegmentSpecs(node as unknown as { userData: Record<string, unknown> });
      if (allowed && path.id === this.selectedPathId) this.buildChrome(path, specs.length);
      for (const handle of derivePathHandles(specs, { sweep: allowed })) {
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
        // Picking contract contract-bake-picking.md §2.3: aux target resolving to
        // the owning Path node — NEVER a private layer bit (§2.4).
        rm?.addAuxRaycastTarget(mesh, node);
      }
    }
    this.handleRoot.visible = true;
  }

  /**
   * Endpoint chrome of the SELECTED path (plan-453 §2.5): an append marker (+)
   * beyond each free end and — when more than one segment is left — a remove
   * marker (−) further out. No permanent handles for these verbs; a closed
   * path has no free ends and gets none.
   */
  private buildChrome(path: RVPath, segmentCount: number): void {
    const ends = getPathEndpoints(path);
    if (!ends || !this.handleRoot) return;
    if (!this.chromeGeometry) this.chromeGeometry = new SphereGeometry(CHROME_RADIUS_M, 12, 8);
    const node = this.nodeByPathId.get(path.id);
    const rm = this.viewer?.raycastManager ?? null;
    for (const end of [ends.start, ends.end]) {
      const actions: Array<['append' | 'remove', number, number]> = [['append', CHROME_APPEND_OFFSET_M, CHROME_APPEND_HEX]];
      if (segmentCount > 1) actions.push(['remove', CHROME_REMOVE_OFFSET_M, CHROME_REMOVE_HEX]);
      for (const [action, offset, color] of actions) {
        const key = `${path.id}|${action === 'append' ? '+' : '-'}${end.which}`;
        const mesh = new Mesh(
          this.chromeGeometry,
          new MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.95 }),
        );
        mesh.name = `__pathChrome:${key}`;
        mesh.position.copy(end.position).addScaledVector(end.outward, offset);
        mesh.position.y += Y_LIFT;
        mesh.renderOrder = 522;
        mesh.frustumCulled = false;
        mesh.userData._rvPathId = path.id;
        markAsOverlay(mesh);
        this.handleRoot.add(mesh);
        this.chrome.set(key, mesh);
        this.chromeInfo.set(key, { pathId: path.id, action, end: end.which });
        if (node) rm?.addAuxRaycastTarget(mesh, node);
      }
    }
  }

  /** Move the handle spheres of `pathId` onto a preview spec list. */
  private syncHandlePositions(pathId: string, specs: readonly PathSegmentSpec[]): void {
    if (!this.plannerMode) return;
    for (const handle of derivePathHandles(specs, { sweep: true })) {
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
    for (const mesh of this.chrome.values()) {
      rm?.removeAuxRaycastTarget(mesh);
      this.handleRoot?.remove(mesh);
      (mesh.material as MeshBasicMaterial).dispose();
    }
    this.chrome.clear();
    this.chromeInfo.clear();
    if (this.handleRoot) this.handleRoot.visible = false;
  }

  // ── Node lookup + snap candidates ──────────────────────────────────────

  /** Cache `pathId → Object3D` by scanning the scene for the Path components. */
  private indexNode(pathId: string): void {
    // plan-453: a node is only current when its component still drives the
    // network's path of that id — a disposed node of an earlier model (or of a
    // removed placement) keeps reporting the id and would receive verb writes.
    const live = getDefaultPathNetwork().get(pathId);
    const current = (o: Object3D): boolean => {
      const p = pathComponentOf(o)?.path;
      return !!p && p.id === pathId && (!live || p === live);
    };
    if (this.nodeByPathId.has(pathId)) {
      if (current(this.nodeByPathId.get(pathId)!)) return;
      this.nodeByPathId.delete(pathId);
    }
    const scene = this.viewer?.scene;
    if (!scene) return;
    let found: Object3D | null = null;
    scene.traverse((o) => {
      if (found) return;
      if (current(o)) found = o;
    });
    if (found) this.nodeByPathId.set(pathId, found);
  }

  /** Register a path node explicitly (tests / hosts without a NodeRegistry). */
  registerPathNode(pathId: string, node: Object3D): void {
    this.nodeByPathId.set(pathId, node);
  }

  /**
   * The path a selection stands for (plan-453): the node itself or an ancestor
   * carrying a Path, else the FIRST Path below it (a selected layout instance
   * that contains a path — in the planner only instances are selectable).
   */
  private pathIdForSelection(node: Object3D | null): string | null {
    // plan-628 M7 / D-N4: a block (or the network node) stands for the whole
    // block — no single path, so no 453 endpoint chrome.
    if (node && (isPathBlockNode(node) || node.name === PATH_NETWORK_NODE)) return null;
    const up = this.pathIdForNode(node);
    if (up || !node) return up;
    let found: string | null = null;
    node.traverse((o) => {
      if (found) return;
      const id = pathComponentOf(o)?.path?.id;
      if (id) found = id;
    });
    return found;
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
          pathEnd: { pathId: path.id, which: end.which },
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
      if (!this.plannerMode || e.button !== 0 || !this.isLayerVisible) return;
      if (this.viewer?.pointerPickBlocked) return; // plan-2215: no screen pick under a render strategy
      // plan-628 Phase 5: an armed catalog tool places at free ends — exactly
      // where the endpoint handles sit; the tool click wins.
      if (this.pointerYield?.()) return;
      // plan-453 §2.5: endpoint chrome of the selected path — append / remove.
      const chromeHit = this.chrome.size > 0 ? this.pickChrome(e, canvas) : null;
      if (chromeHit) {
        e.stopPropagation();
        e.stopImmediatePropagation();
        this.lastVerb = chromeHit.action === 'append'
          ? this.appendPathSegment(chromeHit.pathId, chromeHit.end)
          : this.removePathEndSegment(chromeHit.pathId, chromeHit.end);
        return;
      }
      // plan-453 §2.5/§2.7: Alt-click on the selected path splits a segment.
      if (e.altKey && this.selectedPathId && this.structuralAllowed()) {
        const split = this.pickSplitAt(e.clientX, e.clientY);
        if (split) {
          e.stopPropagation();
          e.stopImmediatePropagation();
          this.lastVerb = this.splitPathSegment(split.pathId, split.segIndex, split.t01);
          return;
        }
      }
      if (this.handles.size === 0) return;
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
      // plan-453 §2.5: grabbing a handle makes its path the active one (endpoint
      // chrome + split pick) — in the planner a bare path node is not selectable.
      if (this.selectedPathId !== hit.pathId) this.setSelectedPath(hit.pathId);
      this.beginHandleDrag(hit.pathId, hit.handle.id);
    };
    const onMove = (e: PointerEvent): void => {
      if (!this.drag) return;
      // plan-2215: a render strategy took over — the drag ends where it is.
      if (this.viewer?.pointerPickBlocked) {
        this.endHandleDrag();
        return;
      }
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

  private pickChrome(e: PointerEvent, canvas: HTMLCanvasElement): ChromeInfo | null {
    if (!this.viewer) return null;
    pointerToNDC(e.clientX, e.clientY, canvas, this._ndc);
    this._ray.setFromCamera(this._ndc, this.viewer.camera);
    const hits = this._ray.intersectObjects([...this.chrome.values()], false);
    if (hits.length === 0) return null;
    return this.chromeInfo.get(hits[0].object.name.replace('__pathChrome:', '')) ?? null;
  }

  private pointerOnDragPlane(e: PointerEvent, canvas: HTMLCanvasElement): Vec3Tuple | null {
    if (!this.viewer || !this.drag) return null;
    pointerToNDC(e.clientX, e.clientY, canvas, this._ndc);
    this._ray.setFromCamera(this._ndc, this.viewer.camera);
    if (this.drag.sweep) {
      // plan-453 §2.7: the sweep drag runs in the arc's OWN plane (XZ, XY or YZ).
      const o = this._ray.ray.origin;
      const d = this._ray.ray.direction;
      return rayOnArcPlane(this.drag.sweep.arc, [o.x, o.y, o.z], [d.x, d.y, d.z]);
    }
    this._plane.set(this._up, -this.drag.planeY); // pre-allocated normal — no GC in the drag
    const hit = this._ray.ray.intersectPlane(this._plane, this._hit);
    if (!hit) return null;
    return [hit.x, this.drag.planeY, hit.z];
  }
}

/** Successor changes + writes of one endpoint release (plan-633 F7). */
interface SuccessorPlan {
  readonly changes: readonly PathSuccessorChange[];
  readonly writes: readonly SuccessorWrite[];
  readonly skipped?: 'same-end' | 'tolerance';
}

/** Links of one path end: END(path) → x for `'end'`, x → START(path) for `'start'`. */
function linksOfEnd(
  network: ReturnType<typeof getDefaultPathNetwork>,
  pathId: string,
  which: 'start' | 'end',
): PathLinkPair[] {
  // Only the dragged end (plan-644 Phase 2.7): O(P), the same subset and order
  // as filtering the network-wide `pairPathEnds`.
  const out: PathLinkPair[] = [];
  for (const f of analysePathEnd(network, pathId, which)) {
    if (f.kind === 'link') out.push({ from: f.from, to: f.to, distance: f.distance, angleDeg: f.angleDeg });
  }
  return out;
}

/**
 * The SCENE `RvDocument` behind an edit target (plan-453): the target's
 * `documentKey` is either the document itself or the SceneStore that owns it.
 * Null for an asset-lineage target or one without a document.
 */
function plannerDocumentOf(target: EditTarget): RvDocument | null {
  const key = target.documentKey;
  const doc = key instanceof RvDocument ? key : (key as { document?: unknown } | undefined)?.document;
  return doc instanceof RvDocument && doc.mode === 'scene' ? doc : null;
}

/** A scene `setField` op — the exact shape the SceneStore target emits. */
function setFieldOp(nodePath: string, componentType: string, fieldName: string, value: unknown, prev: unknown): RvOp {
  return {
    id: freshOpId(), ts: Date.now(), schemaV: 1,
    kind: 'setField', nodePath, componentType, fieldName, value, prev,
  } as RvOp;
}

/** Runtime half of a verb write without an undoable target (no executor re-applies it). */
function writeRuntimeField(node: Object3D, componentType: string, fieldName: string, value: unknown): void {
  if (componentType === 'Path' && fieldName === 'segments') {
    writeSegmentSpecs(node as unknown as { userData: Record<string, unknown> }, value as PathSegmentSpec[]);
    return;
  }
  if (isUnsafeObjectKey(componentType) || isUnsafeObjectKey(fieldName)) return;
  const ud = node.userData as Record<string, unknown>;
  const rv = (ud.realvirtual ??= {}) as Record<string, Record<string, unknown>>;
  if (!ownValue(rv, componentType)) rv[componentType] = {};
  rv[componentType][fieldName] = value;
}

/** The `RVPathComponent` attached to `node` (null when the node carries none). */
function pathComponentOf(node: Object3D): RVPathComponent | null {
  for (const inst of getComponentInstances(node)) {
    if (inst instanceof RVPathComponent) return inst;
  }
  return null;
}
