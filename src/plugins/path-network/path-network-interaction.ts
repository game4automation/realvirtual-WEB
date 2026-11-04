// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * path-network-interaction — the pointer / keyboard side of the path-network
 * planner UI (plan-628 Phase 5). It owns NO write logic: every change is one
 * `layout.path.*` command through `commandRegistry` (one undo step each), the
 * geometry comes from `path-network-ui-model`.
 *
 * Gestures (D-N4, Thomas 2026-10-21):
 * - click on a path line        → selects its BLOCK (no 453 endpoint chrome);
 *                                 a block-free path is selected as before
 * - Shift/Ctrl-click (8.9c)      → adds / removes a block to / from the selection
 * - hover (8.9c)                 → the whole block under the pointer is drawn
 *                                 hovered; the selection is drawn wider
 * - double click on a block     → enters it and selects the hit path (453
 *                                 handles, chrome and Alt-click split apply)
 * - Escape                      → leaves the block (back to the block), then
 *                                 clears; disarms an armed catalog tool first
 * - Delete / Backspace (8.9a)   → ONE `layout.path.remove` of every selected
 *                                 block (a chain, a Shift selection); one undo step
 * - R / Shift+R (8.9c, 8.10)      → turns the selected straight/curve by ±90°
 *                                 about its start, with its downstream chain;
 *                                 the predecessor edge is released (never a kink)
 * - right-click (8.9c)           → the viewer's context menu with the path-block
 *                                 items (delete, delete chain, select chain,
 *                                 rotate, reset to template, Replace with …
 *                                 straight / curve L / curve R — 8.11e, the
 *                                 chain follows the new end)
 * - length / radius handle (8.11d) → the cube at a straight's end / a curve's
 *                                 midpoint; drag = `layout.path.setParams` with
 *                                 the chain following (0.25 m raster, Shift free)
 * - Ctrl+C / Ctrl+V (8.11f)      → copy the selected blocks / paste them as new
 *                                 blocks, docked at a free end under the cursor
 *                                 (tangent-true) or free at the cursor
 * - refused action (8.9c)        → a toast with the reason (simulation running,
 *                                 command refusal), not only the panel line
 * - block gizmo                 → move handle + rotate knob (15° raster, Shift
 *                                 free); a junction has one slide handle that
 *                                 runs along its host; release = `layout.path.move`
 * - move handle drag (8.8, E35)  → takes the downstream chain along (stops at
 *                                 junctions / loops), Shift = the block alone
 *                                 (P6); on release the moving free ends re-snap
 *                                 tangent-true onto the nearest free end or
 *                                 `path` placement port within 0.35 m
 * - snap picker (8.4)            → `placeAtSnap` places a picker entry at a free
 *                                 path-end / `path` port snap (one command)
 * - library entry (8.1)          → `pickLibraryEntry` / `beginLibraryDrag`: a
 *                                 `pathBlock` card of the planner library arms
 *                                 the same tool as the toolbar catalog
 * - catalog straight / curve    → with a selection: appended at its free end;
 *                                 else a ghost follows the pointer, snaps
 *                                 tangent-true onto free ends (0.35 m), click
 *                                 places (`R` rotates the free ghost by 15°)
 * - catalog diverge/merge/stub  → hover a path: point at s + side; click sets it
 *
 * Pointer listeners are registered after the path visualizer's (plugin order
 * in main.ts), so a handle / chrome / Alt-split grab of the visualizer wins
 * and stops the event before it reaches this controller.
 */

import {
  BoxGeometry,
  Group,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  Plane,
  Raycaster,
  SphereGeometry,
  TorusGeometry,
  Vector2,
  Vector3,
  type Object3D,
} from 'three';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import type { RVViewer } from '../../core/rv-viewer';
import type { PathSegmentSpec } from '../../core/engine/rv-path';
import { arcPointAt, type Vec3Tuple } from '../../core/engine/rv-path-edit';
import { pointerToNDC } from '../../core/engine/rv-pointer-utils';
import { markNoAO } from '../../core/engine/rv-group-registry';
import { isJunctionBlock } from '../../core/engine/rv-path-block';
import {
  blockMoveSet,
  chainMoveSet,
  clipAnchor,
  copyBlocks,
  isBlockEdited,
  junctionHostLine,
  type BlockClip,
  type NetworkInput,
} from '../../core/engine/rv-path-network-ops';
import type { PathBlockKind, PathBlockSpec, RigidXZ } from '../../core/engine/rv-path-blocks';
import type { LibraryCatalogEntry } from '../../core/library/library-types';
import { DT_CATALOG_ID } from '../layout-planner/drag-types';
import { commandRegistry } from '../../core/hmi/rv-command-registry';
import { showInstruction } from '../../core/hmi/instruction-store';
import type { ContextMenuItem, ContextMenuTarget } from '../../core/hmi/context-menu-store';
import { PATH_VERB_LABEL_PREFIX, setFatLinePositions, type PathVisualizerPlugin } from '../path-visualizer-plugin';
import { getActiveEditTarget } from '../../core/hmi/rv-edit-target';
import { combineSelection, type BoxSelectHitProvider, type BoxSelectQuery, type ModifierState } from '../layout-planner/box-select-hit';
import { isCompositionOwnedNode, snapshotNetwork } from './path-network-scene';
import { listPathNetwork } from './path-network-commands';
import { emitPathNetworkChanged, onPathNetworkChanged } from './path-network-signal';
import { pathIssueTitle } from './path-network-validation';
import {
  appendPortFor,
  catalogEntryForPathBlock,
  CLICK_LAYOUT_CLICK_PX,
  CLICK_LAYOUT_TARGET_PX,
  clickConnectPlan,
  clickLayoutDefaultRadius,
  clickLayoutPlan,
  clickStepArgs,
  parseTypedDimension,
  type ClickLayoutPlan,
  type ClickLayoutTyped,
  type TypedField,
  dropSnap,
  dropTargets,
  ghostPlacement,
  headingDelta,
  isFreeMovable,
  isJunctionEntry,
  junctionPreview,
  movingFreeEnds,
  paramDragPreview,
  paramFromPointer,
  paramHandle,
  parsePathSnapId,
  pasteMotion,
  replaceArgs,
  replaceOptions,
  type HandleBlock,
  type ParamHandle,
  PATH_CATALOG,
  PATH_NETWORK_LOCKED_HINT,
  pathPickerEntries,
  pickerCommandFor,
  placeArgsFor,
  projectableLine,
  ROTATE_SELECTED_STEP_DEG,
  ROTATE_STEP_DEG,
  snapAngle,
  type DropSnap,
  type FreePort,
  type GhostPlacement,
  type MovingEnd,
  type PathCatalogEntry,
  type PathPickerEntry,
  type PathProjection,
  type ProjectableLine,
} from './path-network-ui-model';

import { PATH_BLOCK_DRAG_TYPE } from './path-network-shared';
export { PATH_BLOCK_DRAG_TYPE } from './path-network-shared';

/** Accent of the planner UI (DESIGN.md Instrument Blue) — 3D overlay, not HMI CSS. */
const GHOST_HEX = 0x4fc3f7;
/** plan-628 8.11d: the length / radius handle (a cube, apart from the round move / rotate handles). */
const PARAM_HANDLE_HEX = 0xffb74d;
const HANDLE_RADIUS_M = 0.09;
const ROTATE_KNOB_OFFSET_M = 0.6;
const JUNCTION_PICK_PX = 24;
const LINE_Y_LIFT = 0.03;
/** A right-drag longer than this (px) is an orbit, not a context-menu click (viewer's DRAG_THRESHOLD). */
const CONTEXT_DRAG_PX = 5;

/** Instruction id of the path-network refusal toast (a second refusal replaces it). */
export const PATH_NETWORK_TOAST_ID = 'path-network-refused';
/** Context-menu item ids (tests address them). */
export const PATH_MENU_IDS = Object.freeze({
  delete: 'path-network.delete',
  deleteChain: 'path-network.delete-chain',
  selectChain: 'path-network.select-chain',
  rotate: 'path-network.rotate',
  rotateBack: 'path-network.rotate-back',
  reset: 'path-network.reset',
  locked: 'path-network.locked',
  /** plan-628 8.11e: the "Replace with …" submenu and its choices (`<replace>-<option id>`). */
  replace: 'path-network.replace',
});

/** Context-menu id of a "Replace with …" choice (8.11e). */
export function replaceMenuId(optionId: string): string {
  return `${PATH_MENU_IDS.replace}-${optionId}`;
}

/** The selected block as the UI shows it (inspector card). */
export interface PathBlockView {
  readonly id: string;
  readonly kind: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly edited: boolean;
  readonly junction: boolean;
  readonly paths: readonly string[];
  /** plan-628 8.6: composition owner of a generated block (read-only card), absent for author blocks. */
  readonly owner?: string;
}

/** Snapshot for React (`useSyncExternalStore`). */
export interface PathNetworkUiState {
  readonly active: boolean;
  readonly editable: boolean;
  readonly toolId: string | null;
  /** The PRIMARY selected block (card, gizmo) — the last one clicked. */
  readonly selectedBlock: PathBlockView | null;
  /** plan-628 8.9: every selected block id (primary included); empty = none. */
  readonly selectedBlocks: readonly string[];
  readonly enteredBlock: string | null;
  readonly selectedPath: string | null;
  readonly lastError: string | null;
  readonly busy: boolean;
  /** plan-628 8.11b: a click on the floor builds from the selected block's free end. */
  readonly clickLayout: boolean;
  /** plan-628 8.11c: the typed-dimension prompt as shown at the cursor (null = none). */
  readonly typedText: string | null;
}

/** plan-628 8.11c: typed dimensions while a preview is shown. */
interface TypedState {
  field: TypedField;
  /** The field was chosen explicitly (Tab / suffix) — else it follows the preview. */
  explicit: boolean;
  buffer: string;
  lengthM?: number;
  degrees?: number;
}

/** The slice of the layout planner the path network uses (structural: no module import of the plugin class). */
interface PlannerHost {
  registerBoxSelectHitProvider?(provider: BoxSelectHitProvider): () => void;
  removeSelected?(): Promise<void>;
  snapshotPlacements?(): { placements: readonly { id: string; position: [number, number, number]; rotation: [number, number, number] }[] };
  getPlacedRootById?(id: string): Object3D | null;
  moveById?(id: string, position: [number, number, number], rotation: [number, number, number]): Promise<void>;
}

/** A selected planner placement that a group move takes along (8.11a). */
interface GroupPlacement {
  readonly id: string;
  readonly root: Object3D;
  readonly position: [number, number, number];
  readonly rotation: [number, number, number];
  readonly x0: number;
  readonly z0: number;
}

/** A command refusal inside {@link PathNetworkInteraction.inOneStep} (aborts the whole step). */
class StepRefused extends Error {
  constructor(readonly reason: string) { super(reason); }
}

/** Screen radius (px) of a live-check marker for its hover tip (8.11g). */
const MARKER_TIP_PX = 14;
/** A drag on a selected block longer than this (px) starts the group move (8.11a). */
const GROUP_DRAG_PX = 5;

/** One candidate move set of a block drag (8.8): its paths, free ends and drop targets. */
interface MoveSet {
  readonly pathIds: string[];
  readonly ends: MovingEnd[];
  readonly targets: FreePort[];
}

/** Answer of {@link PathNetworkInteraction.placeAtSnap}. */
export interface PlaceAtSnapResult {
  readonly ok: boolean;
  readonly reason?: string;
  readonly blockId?: string;
}

type DragState =
  | {
    kind: 'move'; blockId: string; start: Vec3Tuple; planeY: number; delta: [number, number]; pivot: [number, number];
    /** P6 (Shift): the block with its hosted junctions; E35 default: + the downstream chain. */
    single: MoveSet; chain: MoveSet; useChain: boolean; snap: DropSnap | null;
  }
  | { kind: 'rotate'; blockId: string; pathIds: string[]; start: Vec3Tuple; planeY: number; pivot: [number, number]; angle: number }
  | { kind: 'slide'; blockId: string; host: ProjectableLine; planeY: number; s: number; at: PathProjection | null; spec: { kind: 'diverge' | 'merge' | 'stub' } & Record<string, unknown> }
  | {
    /** plan-628 8.11d: the length (straight) / radius (curve) handle; the downstream chain follows rigidly. */
    kind: 'param'; blockId: string; handle: ParamHandle; block: HandleBlock; planeY: number; value: number;
    ownPaths: string[]; chainPaths: string[];
  }
  | {
    /** plan-628 8.11a: the whole selection (blocks + planner placements) moves rigidly. */
    kind: 'group'; start: Vec3Tuple; planeY: number; delta: [number, number];
    blockIds: string[]; pathIds: string[]; placements: GroupPlacement[];
  };

export class PathNetworkInteraction {
  private readonly listeners = new Set<() => void>();
  private state: PathNetworkUiState = {
    active: false, editable: false, toolId: null, selectedBlock: null, selectedBlocks: [], enteredBlock: null, selectedPath: null, lastError: null, busy: false,
    clickLayout: false, typedText: null,
  };
  /** 8.11b: the free END the click layout builds from (null = not armed). */
  private clickOrigin: FreePort | null = null;
  /** 8.11b: foreign free starts / consuming ports a click may dock onto. */
  private clickTargets: FreePort[] = [];
  /** 8.11b: where the left button went down on the floor while armed. */
  private clickDown: { x: number; y: number } | null = null;
  /** 8.11b: the plan under the pointer (preview); recomputed per frame. */
  private clickPlan: ClickLayoutPlan | null = null;
  /** 8.11b: the last pointer position over the canvas (typed Enter, preview refresh). */
  private lastPointer: { x: number; y: number } | null = null;
  /** 8.11c: typed dimensions. */
  private typed: TypedState | null = null;
  private typedEl: HTMLDivElement | null = null;
  private tipEl: HTMLDivElement | null = null;
  /** 8.11a: a press on a selected block of a multi-selection — becomes a group move past GROUP_DRAG_PX. */
  private groupCandidate: { x: number; y: number; e: PointerEvent } | null = null;
  /** The last pointer-down was claimed by the click layout onto a foreign end (no mouse compat events). */
  private suppressMouseCompat = false;
  private readonly unsubs: (() => void)[] = [];
  private readonly overlay = new Group();
  private ghost: LineSegments2 | null = null;
  private readonly pointMarker: Mesh;
  private readonly moveHandle: Mesh;
  private readonly rotateHandle: Mesh;
  private readonly rotateRing: Mesh;
  /** plan-628 8.11d: length (straight end) / radius (curve midpoint) handle. */
  private readonly paramHandleMesh: Mesh;
  /** plan-628 8.11f: the path blocks Ctrl+C copied (null = nothing). */
  private clip: BlockClip | null = null;
  private drag: DragState | null = null;
  private catalogDrag: string | null = null;
  private dropPending = false;
  private ghostHeadingDeg = 0;
  private lastGhost: GhostPlacement | null = null;
  private lastJunction: { pathId: string; at: PathProjection; side: 'left' | 'right' } | null = null;
  private hoverLineCache: { pathId: string; line: ProjectableLine } | null = null;
  private freePorts: FreePort[] = [];
  /** Tool entries armed from a library `pathBlock` whose spec is not a built-in catalog entry (8.1). */
  private readonly extraEntries = new Map<string, PathCatalogEntry>();
  /** A planner-library card drag (8.1): its dataTransfer carries the planner's catalog id. */
  private libraryDrag = false;
  /** Ends freed by the last move (8.8): their snaps stay revealed with the selection. */
  private freedPaths: string[] = [];
  /** Where the right button went down (8.9c context-menu drag guard). */
  private rightDown: [number, number] | null = null;
  /** Coalesced block hover (8.9c): the latest pointer position, picked once per frame. */
  private hoverAt: { x: number; y: number } | null = null;
  private hoverRaf = 0;
  private readonly _ray = (() => { const r = new Raycaster(); r.layers.enableAll(); return r; })();
  private readonly _ndc = new Vector2();
  private readonly _plane = new Plane(new Vector3(0, 1, 0), 0);
  private readonly _hit = new Vector3();
  private readonly _m = new Matrix4();
  private readonly _m2 = new Matrix4();

  constructor(private readonly viewer: RVViewer, private readonly viz: PathVisualizerPlugin) {
    this.overlay.name = '__pathNetworkUi';
    this.overlay.renderOrder = 530;
    const mat = (): MeshBasicMaterial => new MeshBasicMaterial({ color: GHOST_HEX, transparent: true, opacity: 0.95, depthTest: false });
    const sphere = new SphereGeometry(HANDLE_RADIUS_M, 14, 10);
    this.pointMarker = new Mesh(sphere, mat());
    this.pointMarker.name = '__pathNetworkUi:point';
    this.moveHandle = new Mesh(sphere, mat());
    this.moveHandle.name = '__pathNetworkUi:move';
    this.rotateHandle = new Mesh(new SphereGeometry(HANDLE_RADIUS_M * 0.8, 12, 8), mat());
    this.rotateHandle.name = '__pathNetworkUi:rotate';
    this.rotateRing = new Mesh(new TorusGeometry(ROTATE_KNOB_OFFSET_M, 0.008, 6, 64), mat());
    this.rotateRing.name = '__pathNetworkUi:ring';
    this.rotateRing.rotation.x = Math.PI / 2;
    this.paramHandleMesh = new Mesh(new BoxGeometry(HANDLE_RADIUS_M * 1.6, HANDLE_RADIUS_M * 1.6, HANDLE_RADIUS_M * 1.6), new MeshBasicMaterial({ color: PARAM_HANDLE_HEX, transparent: true, opacity: 0.95, depthTest: false }));
    this.paramHandleMesh.name = '__pathNetworkUi:param';
    for (const m of [this.pointMarker, this.moveHandle, this.rotateHandle, this.rotateRing, this.paramHandleMesh]) {
      m.renderOrder = 540;
      m.visible = false;
      markNoAO(m);
      this.overlay.add(m);
    }
    viewer.scene.add(this.overlay);
    this.wire();
    viz.setPointerYield(() => this.state.active && this.state.toolId !== null);
    this.unsubs.push(onPathNetworkChanged(() => this.refreshSelection()), () => viz.setPointerYield(null));
  }

  // ── Store ─────────────────────────────────────────────────────────────

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getState = (): PathNetworkUiState => this.state;

  private set(patch: Partial<PathNetworkUiState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  /** Re-derive the activity flags (authoring mode, layer, simulation lock) — called per frame by the plugin. */
  tick(): void {
    const active = this.viz.isPlannerMode && this.viz.isLayerVisible;
    const editable = active && this.viz.structuralAllowed();
    if (active !== this.state.active || editable !== this.state.editable) {
      this.set({ active, editable });
      if (!active) this.reset();
      else if (!editable) { this.armTool(null); this.cancelDrag(); }
      this.syncGizmo();
      this.syncClickLayout();
    }
    if (this.state.selectedPath !== this.viz.selectedPath) this.set({ selectedPath: this.viz.selectedPath });
  }

  // ── Public actions (toolbar + tests) ──────────────────────────────────

  /** Click on a catalog entry: append at the selection's free end, else arm the ghost tool (null disarms). */
  async pickCatalog(entryId: string | null): Promise<void> {
    if (entryId === null) { this.armTool(null); return; }
    const entry = this.entryById(entryId);
    if (!entry || !this.state.editable) return;
    if (!isJunctionEntry(entry.spec)) {
      const selPaths = this.selectionPaths();
      if (selPaths.length > 0) {
        const port = appendPortFor(this.listFreePorts(), selPaths);
        if (port) {
          const r = await this.exec('layout.path.place', placeArgsFor(entry.spec, { mode: 'port', port, specs: [] }));
          if (r && typeof r.blockId === 'string') this.selectBlock(r.blockId);
          return;
        }
      }
    }
    this.armTool(entry.id);
  }

  /** Arm (or disarm with null) a catalog tool without the append shortcut. */
  armTool(entryId: string | null): void {
    if (this.state.toolId === entryId) return;
    this.freePorts = entryId ? this.listFreePorts() : [];
    this.lastGhost = null;
    this.lastJunction = null;
    this.hoverLineCache = null;
    this.hideGhost();
    this.pointMarker.visible = false;
    this.set({ toolId: entryId, lastError: null });
    this.clearTyped();
    this.syncClickLayout();
    this.viewer.markRenderDirty();
  }

  /**
   * Catalog drag (9.7 "drag from the catalog"): a tile drag arms the tool without the
   * append shortcut; `dragover` on the canvas moves the ghost, `drop` places it.
   * A drag that ends without a drop disarms again.
   */
  beginCatalogDrag(entryId: string): void {
    if (!this.state.editable) return;
    this.catalogDrag = entryId;
    this.armTool(null);
    this.armTool(entryId);
  }

  /** End of a catalog tile drag (after `drop` or when cancelled). */
  endCatalogDrag(): void {
    if (!this.catalogDrag) return;
    this.catalogDrag = null;
    if (!this.dropPending) this.disarmKeepingError();
  }

  /** plan-628 8.1: a click on a planner-library `pathBlock` card — same as the toolbar catalog click. */
  async pickLibraryEntry(entry: LibraryCatalogEntry): Promise<void> {
    const ce = this.libraryCatalogEntry(entry);
    if (ce) await this.pickCatalog(ce.id);
  }

  /** plan-628 8.1: a planner-library `pathBlock` card drag starts (the drop lands on the canvas listener). */
  beginLibraryDrag(entry: LibraryCatalogEntry): void {
    const ce = this.libraryCatalogEntry(entry);
    if (!ce) return;
    this.libraryDrag = true;
    this.beginCatalogDrag(ce.id);
  }

  /** plan-628 8.1: the library card drag ended (after its drop, or cancelled). */
  endLibraryDrag(): void {
    this.endCatalogDrag();
    this.libraryDrag = false;
  }

  /** The "Path blocks" entries of the snap picker (8.4). */
  pickerEntries(): PathPickerEntry[] {
    return pathPickerEntries();
  }

  /**
   * plan-628 8.4: place picker entry `entryId` at the free snap `snapId` — a
   * path end (`path-snap:<pathId>:<end>`) or a free `path`-typed placement port.
   * ONE `layout.path.place` / `layout.path.junction` (one undo step); the new
   * block is chained through the command's auto-link and selected.
   */
  async placeAtSnap(entryId: string, snapId: string): Promise<PlaceAtSnapResult> {
    const entry = this.entryById(entryId);
    if (!entry) return { ok: false, reason: `unknown path block '${entryId}'` };
    const ref = parsePathSnapId(snapId);
    const ports = this.listFreePorts();
    const port = ref
      ? ports.find((p) => !p.snapId && p.pathId === ref.pathId && p.end === ref.end)
      : ports.find((p) => p.snapId === snapId);
    if (!port) return { ok: false, reason: 'This snap point is not free' };
    const host = port.pathId ? this.network().paths.find((p) => p.id === port.pathId) : undefined;
    const cmd = pickerCommandFor(entry.spec, port, host ? host.segments : null);
    if (!cmd) return { ok: false, reason: `${entry.label} is set onto a path — choose it at a path end` };
    const r = await this.exec(cmd.id, cmd.args);
    if (!r) return { ok: false, reason: this.state.lastError ?? 'refused' };
    const blockId = typeof r.blockId === 'string' ? r.blockId : undefined;
    if (blockId) this.selectBlock(blockId);
    return { ok: true, ...(blockId ? { blockId } : {}) };
  }

  private entryById(id: string): PathCatalogEntry | null {
    return PATH_CATALOG.find((e) => e.id === id) ?? this.extraEntries.get(id) ?? null;
  }

  private libraryCatalogEntry(entry: LibraryCatalogEntry): PathCatalogEntry | null {
    const pb = entry.pathBlock;
    const ce = pb ? catalogEntryForPathBlock(pb) : null;
    if (ce && !PATH_CATALOG.includes(ce)) this.extraEntries.set(ce.id, ce);
    return ce;
  }

  /** Disarm after a drag; a refusal hint from the drop stays visible. */
  private disarmKeepingError(): void {
    const err = this.state.lastError;
    this.armTool(null);
    if (err) this.set({ lastError: err });
  }

  /** Select a block as a whole (D-N4 single click); null clears. */
  selectBlock(blockId: string | null): void {
    this.setSelection(blockId ? [blockId] : [], blockId);
  }

  /**
   * plan-628 8.9c: Shift/Ctrl-click — add the block to the selection (it becomes
   * the primary) or take it out again (the previous one becomes the primary).
   */
  toggleBlock(blockId: string): void {
    const cur = this.state.selectedBlocks;
    if (cur.includes(blockId)) {
      const rest = cur.filter((id) => id !== blockId);
      this.setSelection(rest, rest.length > 0 ? rest[rest.length - 1] : null);
    } else {
      this.setSelection([...cur, blockId], blockId);
    }
  }

  /**
   * plan-628 8.9c: select the chain of `blockId` (default: the primary) — the
   * same set a drag takes along (8.8 `chainMoveSet`: the block, its hosted
   * junctions and every straight/curve block downstream, stopping at junction
   * blocks and loops). Answers the number of selected blocks.
   */
  selectChain(blockId?: string): number {
    const id = blockId ?? this.state.selectedBlock?.id;
    if (!id) return 0;
    const ids = chainMoveSet(this.network(), id).blockIds;
    this.setSelection(ids, id);
    return ids.length;
  }

  /** The one place the block selection changes: highlight, pins, gizmo follow. */
  private setSelection(ids: readonly string[], primary: string | null): void {
    this.viz.selectPickedPath(null);
    const net = this.network();
    const known = new Set((net.blocks ?? []).map((b) => b.id));
    const sel = [...new Set(ids)].filter((id) => known.has(id));
    const prim = primary && sel.includes(primary) ? primary : sel.length > 0 ? sel[sel.length - 1] : null;
    this.set({ enteredBlock: null, selectedBlocks: sel, selectedBlock: prim ? this.blockView(prim) : null, selectedPath: null });
    this.viz.setBlockHighlight(this.selectedPaths(net));
    this.freedPaths = [];
    this.syncPins();
    this.syncGizmo();
    this.syncClickLayout();
  }

  /** Paths of every selected block (with their hosted junctions). */
  private selectedPaths(net: NetworkInput = this.network()): string[] {
    const out = new Set<string>();
    for (const id of this.state.selectedBlocks) for (const p of blockMoveSet(net, id).pathIds) out.add(p);
    return [...out];
  }

  /** Enter a block and select one of its paths (D-N4 double click). */
  enterBlock(blockId: string, pathId: string): void {
    this.set({ enteredBlock: blockId, selectedBlock: null, selectedBlocks: [] });
    this.viz.setBlockHighlight([]);
    this.viz.selectPickedPath(pathId);
    this.set({ selectedPath: pathId });
    this.syncGizmo();
  }

  /** Escape: disarm, else leave the entered block (back to the block), else clear. */
  escape(): boolean {
    if (this.drag) { this.cancelDrag(); return true; }
    if (this.typed) { this.clearTyped(); return true; }
    if (this.state.toolId) { this.armTool(null); return true; }
    if (this.state.enteredBlock) { this.selectBlock(this.state.enteredBlock); return true; }
    if (this.state.selectedBlock || (this.state.selectedPath && this.viz.selectedPath)) { this.selectBlock(null); return true; }
    return false;
  }

  /**
   * Delete every selected block (8.9a: one block, a Shift selection or a chain)
   * - or a selected block-free path - as ONE `layout.path.remove` (one undo step).
   */
  async removeSelected(): Promise<boolean> {
    const blocks = this.state.selectedBlocks;
    const ids = blocks.length > 0 ? [...blocks] : (this.state.enteredBlock || !this.viz.selectedPath ? [] : [this.viz.selectedPath]);
    if (ids.length === 0) return false;
    if (!this.state.editable) { this.notify(PATH_NETWORK_LOCKED_HINT); return false; }
    // plan-628 8.11a: blocks AND planner items selected (marquee) — ONE step for all of it.
    if (blocks.length > 0 && this.sceneSelection().length > 0) {
      const ok = await this.inOneStep('delete selection', async (run) => {
        await run('layout.path.remove', { ids: ids.join(',') });
        await this.removePlannerSelection(run);
      });
      if (ok) this.selectBlock(null);
      return ok;
    }
    const r = await this.exec('layout.path.remove', { ids: ids.join(',') });
    if (r) this.selectBlock(null);
    return !!r;
  }

  /**
   * plan-628 8.11a (E57): the marquee's hit provider — the planner's
   * rubber-band marquee feeds the block selection with the same rectangle and
   * modifiers it applies to the placements.
   */
  readonly boxSelectProvider: BoxSelectHitProvider = {
    commit: (query, mods) => { this.boxSelect(query, mods); },
  };

  /**
   * plan-628 8.11a: the blocks whose path lines touch the marquee (any overlap,
   * like the placements); composition-owned generated nodes are never hit.
   * Applies replace / Shift = add / Ctrl = toggle to the block selection and
   * answers the hit block ids.
   */
  boxSelect(query: BoxSelectQuery, mods: ModifierState): string[] {
    if (!this.state.active) return [];
    const { input: net, locator } = snapshotNetwork(this.viewer);
    const reg = this.viewer.registry as { getNode?: (path: string) => Object3D | null | undefined } | null | undefined;
    const owned = (nodePath: string | undefined): boolean => !!nodePath && isCompositionOwnedNode(reg?.getNode?.(nodePath) ?? null);
    const hits: string[] = [];
    for (const b of net.blocks ?? []) {
      const own = net.paths.filter((p) => p.block === b.id);
      if (owned(locator.blockNodes.get(b.id)) || own.some((p) => owned(locator.pathNodes.get(p.id)))) continue;
      const specs = own.flatMap((p) => p.segments);
      if (specs.length > 0 && query.intersectsWorldSegments(samplePositions(specs))) hits.push(b.id);
    }
    const cur = this.state.selectedBlocks;
    const next = combineSelection(cur, hits, mods);
    const same = next.length === cur.length && next.every((id, i) => id === cur[i]);
    if (!same) {
      const prim = [...hits].reverse().find((id) => next.includes(id)) ?? this.state.selectedBlock?.id ?? null;
      this.setSelection(next, prim);
    }
    return hits;
  }

  /** The scene selection of the viewer (planner placements, MUs) — the second holder (E57). */
  private sceneSelection(): readonly string[] {
    return this.viewer.selectionManager?.getSnapshot?.().selectedPaths ?? [];
  }

  private planner(): PlannerHost | null {
    return (this.viewer.getPlugin?.('layout-planner') as unknown as PlannerHost | undefined) ?? null;
  }

  /** Delete the planner's selection inside the current step: `layout.remove` when registered, else the planner verb it runs. */
  private async removePlannerSelection(run: (id: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>): Promise<void> {
    if (commandRegistry.get('layout.remove')) { await run('layout.remove', { id: null }); return; }
    await this.planner()?.removeSelected?.();
  }

  /** The selected planner placements (group move, 8.11a). */
  private selectedPlacements(): GroupPlacement[] {
    const sel = this.sceneSelection();
    if (sel.length === 0) return [];
    const planner = this.planner();
    const snap = planner?.snapshotPlacements?.();
    if (!planner || !snap) return [];
    const want = new Set(sel);
    const out: GroupPlacement[] = [];
    for (const p of snap.placements) {
      const root = planner.getPlacedRootById?.(p.id) ?? null;
      const path = root ? this.viewer.registry?.getPathForNode(root) ?? null : null;
      if (!root || !path || !want.has(path)) continue;
      out.push({ id: p.id, root, position: [...p.position] as [number, number, number], rotation: [...p.rotation] as [number, number, number], x0: root.position.x, z0: root.position.z });
    }
    return out;
  }

  /**
   * Run several commands as ONE undo step (plan-628 8.11a/b): an outer
   * transaction with the path-verb label (undo stays locked during the
   * simulation and resets it, like every path verb); a refusal of any command
   * aborts the step and rolls back what it wrote.
   */
  private async inOneStep(label: string, fn: (run: (id: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>) => Promise<void>): Promise<boolean> {
    this.set({ busy: true, lastError: null });
    try {
      await getActiveEditTarget().withTransaction(`${PATH_VERB_LABEL_PREFIX}${label}`, async () => {
        await fn(async (id, args) => {
          const r = await commandRegistry.execute<Record<string, unknown>>(id, args, { origin: 'ui', viewer: this.viewer });
          if (!r.ok) throw new StepRefused(r.reason);
          return r.value ?? {};
        });
      });
      return true;
    } catch (e) {
      const reason = e instanceof StepRefused ? e.reason : e instanceof Error ? e.message : String(e);
      this.notify(reason.startsWith('sim-locked') ? PATH_NETWORK_LOCKED_HINT : reason);
      // The rollback restored the network: snaps + listeners follow it.
      (this.viewer.getPlugin?.('snap-point') as { syncPathSnaps?: () => void } | undefined)?.syncPathSnaps?.();
      emitPathNetworkChanged();
      return false;
    } finally {
      this.set({ busy: false });
      this.refreshSelection();
    }
  }

  /** plan-628 8.9a: delete the chain of `blockId` (see {@link selectChain}) in one step. */
  async removeChain(blockId?: string): Promise<boolean> {
    if (this.selectChain(blockId) === 0) return false;
    return this.removeSelected();
  }

  /**
   * plan-628 8.9c / 8.10 (E52): turn the selected straight/curve block by `deg`
   * (default +90 deg) about its START point (its pose) TOGETHER with its
   * downstream chain (the 8.8 `chainMoveSet`) - one `layout.path.move` with
   * `chain`. The edges inside the chain stay; the edge to the predecessor
   * cannot stay tangential and is released (open end + ring, as E43) - the
   * path network never gets a kink. Without a predecessor the whole chain
   * turns. A junction follows its host: refused.
   */
  async rotateSelected(deg = ROTATE_SELECTED_STEP_DEG): Promise<boolean> {
    const b = this.state.selectedBlock;
    if (!b || this.state.selectedBlocks.length !== 1) return false;
    if (!this.state.editable) { this.notify(PATH_NETWORK_LOCKED_HINT); return false; }
    if (b.junction) { this.notify(`${b.id} is a ${b.kind} junction - it turns with its host path; drag its handle along the host instead`); return false; }
    const r = await this.exec('layout.path.move', { blockId: b.id, dHeadingDeg: deg, chain: true });
    if (r) this.pinFreed(r.unlinked);
    return !!r;
  }

  async resetSelected(): Promise<void> {
    const b = this.state.selectedBlock;
    if (!b) return;
    if (!this.state.editable) { this.notify(PATH_NETWORK_LOCKED_HINT); return; }
    await this.exec('layout.path.reset', { blockId: b.id });
  }

  /**
   * plan-628 8.9c: say WHY something did not happen - the panel line AND a
   * toast at the bottom edge, so a refusal is visible with the panel closed.
   */
  notify(message: string): void {
    this.set({ lastError: message });
    showInstruction({
      id: PATH_NETWORK_TOAST_ID,
      text: message,
      anchor: { kind: 'edge', edge: 'bottom' },
      style: 'toast',
      autoClearAfterMs: 5000,
      source: 'path-network',
    });
  }

  async setSelectedParams(params: Record<string, unknown>): Promise<void> {
    const b = this.state.selectedBlock;
    if (b) await this.exec('layout.path.setParams', { blockId: b.id, ...params });
  }

  dispose(): void {
    for (const u of this.unsubs.splice(0)) u();
    this.reset();
    this.typedEl?.remove();
    this.typedEl = null;
    this.tipEl?.remove();
    this.tipEl = null;
    this.overlay.removeFromParent();
    this.listeners.clear();
  }

  /** plan-435 teardown (model cleared): drop the model-scoped state — drag, tool, selection, pins, previews. */
  clearModelState(): void {
    this.reset();
  }

  // ── Internals ─────────────────────────────────────────────────────────

  private reset(): void {
    this.cancelDrag();
    this.armTool(null);
    this.setHover(null);
    if (this.state.selectedBlock || this.state.selectedBlocks.length > 0 || this.state.enteredBlock) {
      this.set({ selectedBlock: null, selectedBlocks: [], enteredBlock: null });
      this.viz.setBlockHighlight([]);
    }
    this.freedPaths = [];
    this.clearTyped();
    this.showTip(null);
    this.syncPins();
    this.syncGizmo();
    this.syncClickLayout();
  }

  /**
   * plan-628 8.8: the selected block's free end snaps — and the ends the last
   * move freed — stay revealed with the standard marker (snap plugin pins).
   */
  private syncPins(): void {
    const snaps = this.viewer.getPlugin?.('snap-point') as { setPinnedPathSnaps?: (ids: readonly string[]) => void } | undefined;
    if (!snaps?.setPinnedPathSnaps) return;
    const ids = new Set<string>(this.state.selectedBlocks.length > 1 ? this.selectedPaths() : this.state.selectedBlock?.paths ?? []);
    for (const id of this.freedPaths) ids.add(id);
    snaps.setPinnedPathSnaps([...ids]);
  }

  private network(): NetworkInput {
    return snapshotNetwork(this.viewer).input;
  }

  /** Free ends from the `layout.path.list` read model — one derivation (§2.6). */
  private listFreePorts(): FreePort[] {
    const list = listPathNetwork(this.viewer) as { freePorts?: FreePort[] };
    // plan-628 8.3: `path`-typed placement ports are attach targets too (tangent-true).
    const snaps = this.viewer.getPlugin?.('snap-point') as { listPathPlacementPorts?: () => FreePort[] } | undefined;
    return [...(list.freePorts ?? []), ...(snaps?.listPathPlacementPorts?.() ?? [])];
  }

  private blockOfPath(net: NetworkInput, pathId: string): string | null {
    return net.paths.find((p) => p.id === pathId)?.block || null;
  }

  private blockView(blockId: string): PathBlockView | null {
    const net = this.network();
    const b = (net.blocks ?? []).find((x) => x.id === blockId);
    if (!b) return null;
    let edited = false;
    try { edited = isBlockEdited(net, blockId); } catch { edited = false; }
    return {
      id: b.id,
      kind: b.extras.kind,
      params: { ...b.extras.params },
      edited,
      junction: isJunctionBlock(b.extras),
      paths: blockMoveSet(net, blockId).pathIds,
      ...(b.owner ? { owner: b.owner } : {}),
    };
  }

  private refreshSelection(): void {
    if (this.state.selectedBlocks.length > 0 || this.state.selectedBlock) {
      // A removed block (delete, undo of its placement) leaves the selection.
      const net = this.network();
      const known = new Set((net.blocks ?? []).map((b) => b.id));
      const sel = this.state.selectedBlocks.filter((id) => known.has(id));
      const prim = this.state.selectedBlock && known.has(this.state.selectedBlock.id)
        ? this.state.selectedBlock.id
        : sel.length > 0 ? sel[sel.length - 1] : null;
      this.set({ selectedBlocks: sel, selectedBlock: prim ? this.blockView(prim) : null });
      this.viz.setBlockHighlight(this.selectedPaths(net));
    }
    if (this.state.enteredBlock && !this.blockView(this.state.enteredBlock)) this.set({ enteredBlock: null });
    if (this.state.toolId) this.freePorts = this.listFreePorts();
    this.syncPins();
    this.syncGizmo();
    this.syncClickLayout();
  }

  private selectionPaths(): string[] {
    if (this.state.selectedBlock) return [...this.state.selectedBlock.paths];
    const p = this.viz.selectedPath;
    return p ? [p] : [];
  }

  private async exec(id: string, args: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    this.set({ busy: true, lastError: null });
    try {
      const r = await commandRegistry.execute<Record<string, unknown>>(id, args, { origin: 'ui', viewer: this.viewer });
      if (!r.ok) { this.notify(r.reason.startsWith('sim-locked') ? PATH_NETWORK_LOCKED_HINT : r.reason); return null; }
      return r.value ?? {};
    } finally {
      this.set({ busy: false });
      this.refreshSelection();
    }
  }

  // ── Click layout (8.11b) + typed dimensions (8.11c) ──────────────────

  /**
   * Re-derive whether a floor click builds: exactly one straight/curve block
   * selected (not entered), its path END free, editable, no catalog tool.
   */
  private syncClickLayout(): void {
    const b = this.state.selectedBlock;
    let origin: FreePort | null = null;
    if (b && this.state.active && this.state.editable && !this.state.toolId && !this.state.enteredBlock
      && this.state.selectedBlocks.length === 1 && isFreeMovable(b.kind as PathBlockKind)) {
      const ports = this.listFreePorts();
      const own = new Set(b.paths);
      origin = ports.find((p) => !p.snapId && own.has(p.pathId) && p.end === 'end') ?? null;
      this.clickTargets = origin ? ports.filter((p) => p.end === 'start') : [];
    } else {
      this.clickTargets = [];
    }
    this.clickOrigin = origin;
    if (!origin) {
      this.clickDown = null;
      if (this.clickPlan) this.hideClickPreview();
      if (!this.state.toolId) this.clearTyped();
    }
    if (!!origin !== this.state.clickLayout) this.set({ clickLayout: !!origin });
  }

  /** The current click-layout plan under `p` (tests / diagnostics read {@link currentClickPlan}). */
  private computeClickPlan(p: { x: number; y: number }): ClickLayoutPlan | null {
    const origin = this.clickOrigin;
    if (!origin) return null;
    const radius = clickLayoutDefaultRadius();
    const target = this.typed ? null : this.targetAt(p);
    if (target) {
      return clickConnectPlan(origin, target, radius)
        // No tangential solution: an open end placed towards it.
        ?? clickLayoutPlan(origin, [target.position[0], target.position[1] ?? 0, target.position[2]], radius);
    }
    const floor = this.floorPoint({ clientX: p.x, clientY: p.y }, origin.position[1] ?? 0);
    if (!floor) return null;
    const base = clickLayoutPlan(origin, floor, radius);
    this.typedDefault = base?.side ? 'angle' : 'length';
    if (!this.typed) return base;
    return clickLayoutPlan(origin, floor, radius, this.typedValues());
  }

  /** The default field of a typed number: what the preview has (curve → angle, else length). */
  private typedDefault: TypedField = 'length';

  /** The foreign free start within {@link CLICK_LAYOUT_TARGET_PX} of the pointer (nearest). */
  private targetAt(p: { x: number; y: number }): FreePort | null {
    const canvas = this.viewer.renderer.domElement as HTMLCanvasElement;
    const rect = canvas.getBoundingClientRect();
    let best: FreePort | null = null;
    let bestD = CLICK_LAYOUT_TARGET_PX;
    const v = new Vector3();
    for (const t of this.clickTargets) {
      v.set(t.position[0], t.position[1] ?? 0, t.position[2]).project(this.viewer.camera);
      if (v.z > 1) continue;
      const sx = rect.left + ((v.x + 1) / 2) * rect.width;
      const sy = rect.top + ((1 - v.y) / 2) * rect.height;
      const d = Math.hypot(sx - p.x, sy - p.y);
      if (d <= bestD) { best = t; bestD = d; }
    }
    return best;
  }

  /** Preview the click-layout plan under the pointer (or hide it over a line / without origin). */
  private updateClickPreview(p: { x: number; y: number } | null, overLine: boolean): void {
    if (!this.clickOrigin || this.drag || this.state.toolId || !p || overLine) {
      if (this.clickPlan) this.hideClickPreview();
      this.renderTyped();
      return;
    }
    const plan = this.computeClickPlan(p);
    this.clickPlan = plan;
    if (plan) this.showGhost(plan.specs); else this.hideGhost();
    if (plan?.target) {
      const t = plan.target.position;
      this.pointMarker.position.set(t[0], (t[1] ?? 0) + LINE_Y_LIFT, t[2]);
      this.pointMarker.visible = true;
    } else {
      this.pointMarker.visible = false;
    }
    this.renderTyped();
    this.viewer.markRenderDirty();
  }

  private hideClickPreview(): void {
    this.clickPlan = null;
    if (!this.state.toolId && !this.drag) { this.hideGhost(); this.pointMarker.visible = false; }
    this.viewer.markRenderDirty();
  }

  /** The click-layout plan currently previewed (tests / diagnostics). */
  get currentClickPlan(): ClickLayoutPlan | null {
    return this.clickPlan;
  }

  /**
   * plan-628 8.11b: place what a click at (`clientX`, `clientY`) builds from
   * the selected free end — ONE undo step (the steps of the plan in one outer
   * transaction), the new block becomes the selection so the next click
   * continues the run. Answers false when nothing was placed.
   */
  async clickAt(clientX: number, clientY: number): Promise<boolean> {
    if (!this.clickOrigin || !this.state.editable) return false;
    const plan = this.computeClickPlan({ x: clientX, y: clientY });
    if (!plan) return false;
    return this.commitClickPlan(plan);
  }

  private async commitClickPlan(plan: ClickLayoutPlan): Promise<boolean> {
    const origin = this.clickOrigin;
    if (!origin) return false;
    this.hideClickPreview();
    let lastBlock: string | null = null;
    const ok = await this.inOneStep(plan.target ? 'click layout (connect)' : 'click layout', async (run) => {
      let at = origin.pathId;
      for (const st of plan.steps) {
        const r = await run('layout.path.place', clickStepArgs(st, at));
        const created = Array.isArray(r.createdPaths) ? r.createdPaths.find((x): x is string => typeof x === 'string') : undefined;
        if (!created) throw new StepRefused('click layout: the block was not placed');
        at = created;
        if (typeof r.blockId === 'string') lastBlock = r.blockId;
      }
    });
    if (ok) {
      this.clearTyped();
      if (lastBlock) this.selectBlock(lastBlock);
    }
    return ok;
  }

  // 8.11c — typed dimensions

  /** What typing currently drives: the click layout, a straight/curve catalog tool, or nothing. */
  private typedTarget(): 'click' | 'tool' | null {
    if (this.drag) return null;
    if (this.state.toolId) {
      const e = this.toolEntry();
      return e && (e.spec.kind === 'straight' || e.spec.kind === 'curve') ? 'tool' : null;
    }
    return this.clickOrigin ? 'click' : null;
  }

  private effectiveField(): TypedField {
    if (this.typed?.explicit) return this.typed.field;
    if (this.typedTarget() === 'tool') return this.toolEntry()?.spec.kind === 'curve' ? 'angle' : 'length';
    return this.typedDefault;
  }

  /** The typed values, the pending buffer included (live preview). */
  private typedValues(): ClickLayoutTyped {
    const t = this.typed;
    if (!t) return {};
    const out: { lengthM?: number; degrees?: number } = {};
    if (t.lengthM !== undefined) out.lengthM = t.lengthM;
    if (t.degrees !== undefined) out.degrees = t.degrees;
    const pending = t.buffer ? parseTypedDimension(t.buffer, this.effectiveField()) : null;
    if (pending) { if (pending.field === 'length') out.lengthM = pending.value; else out.degrees = pending.value; }
    return out;
  }

  /** Move the pending buffer into its field. */
  private commitBuffer(): void {
    const t = this.typed;
    if (!t || !t.buffer) return;
    const parsed = parseTypedDimension(t.buffer, this.effectiveField());
    if (parsed) {
      if (parsed.field === 'length') t.lengthM = parsed.value; else t.degrees = parsed.value;
      t.field = parsed.field;
    }
    t.buffer = '';
  }

  /**
   * plan-628 8.11c: keys while a preview is shown. Digits / `.` open the
   * prompt at the cursor; a trailing `m` = length, `°` / `d` = angle; Tab
   * switches the field; Enter places; Backspace edits; Esc clears. Answers
   * true when the key was consumed.
   */
  handleTypedKey(e: KeyboardEvent): boolean {
    const target = this.typedTarget();
    if (!target || e.ctrlKey || e.metaKey || e.altKey) return false;
    const k = e.key;
    if (/^[0-9]$/.test(k) || k === '.' || k === ',') {
      this.typed ??= { field: this.effectiveField(), explicit: false, buffer: '' };
      this.typed.buffer += k === ',' ? '.' : k;
      this.afterTypedChange();
      return true;
    }
    const t = this.typed;
    if (!t) return false;
    if (k === 'm' || k === 'M') { t.field = 'length'; t.explicit = true; this.commitBuffer(); this.afterTypedChange(); return true; }
    if (k === 'd' || k === 'D' || k === '°') { t.field = 'angle'; t.explicit = true; this.commitBuffer(); this.afterTypedChange(); return true; }
    if (k === 'Tab') {
      this.commitBuffer();
      t.field = this.effectiveField() === 'length' ? 'angle' : 'length';
      t.explicit = true;
      this.afterTypedChange();
      return true;
    }
    if (k === 'Backspace') {
      if (t.buffer) t.buffer = t.buffer.slice(0, -1);
      else if (this.effectiveField() === 'length' && t.lengthM !== undefined) delete t.lengthM;
      else if (this.effectiveField() === 'angle' && t.degrees !== undefined) delete t.degrees;
      else { this.clearTyped(); return true; }
      this.afterTypedChange();
      return true;
    }
    if (k === 'Enter') { this.commitBuffer(); void this.commitTyped(); return true; }
    if (k === 'Escape') { this.clearTyped(); return true; }
    return false;
  }

  /** Enter: place the preview with the typed values. */
  private async commitTyped(): Promise<boolean> {
    const target = this.typedTarget();
    if (target === 'tool') {
      if (this.lastPointer) this.hoverTool({ clientX: this.lastPointer.x, clientY: this.lastPointer.y });
      const placed = await this.placeTool();
      if (placed) this.clearTyped();
      return placed;
    }
    if (target !== 'click' || !this.clickOrigin) return false;
    const p = this.lastPointer ?? this.screenAhead(this.clickOrigin);
    const plan = p ? this.computeClickPlan(p) : null;
    if (!plan) return false;
    return this.commitClickPlan(plan);
  }

  /** A screen point 1 m ahead of a port (Enter without a pointer over the canvas). */
  private screenAhead(port: FreePort): { x: number; y: number } | null {
    const h = port.headingDeg * Math.PI / 180;
    const v = new Vector3(port.position[0] + Math.cos(h), port.position[1] ?? 0, port.position[2] + Math.sin(h)).project(this.viewer.camera);
    const rect = (this.viewer.renderer.domElement as HTMLCanvasElement).getBoundingClientRect();
    return { x: rect.left + ((v.x + 1) / 2) * rect.width, y: rect.top + ((1 - v.y) / 2) * rect.height };
  }

  private afterTypedChange(): void {
    if (this.typedTarget() === 'tool') {
      if (this.lastPointer) this.hoverTool({ clientX: this.lastPointer.x, clientY: this.lastPointer.y });
      this.renderTyped();
    } else {
      this.updateClickPreview(this.lastPointer ?? (this.clickOrigin ? this.screenAhead(this.clickOrigin) : null), false);
    }
  }

  private clearTyped(): void {
    if (!this.typed && !this.state.typedText) return;
    this.typed = null;
    this.renderTyped();
    if (this.clickOrigin && this.lastPointer) this.updateClickPreview(this.lastPointer, false);
    else if (this.state.toolId && this.lastPointer) this.hoverTool({ clientX: this.lastPointer.x, clientY: this.lastPointer.y });
  }

  /** The prompt at the cursor: `Length: 3.5 m` (+ the other field when set) and the key hint. */
  private renderTyped(): void {
    const t = this.typed;
    if (!t) {
      if (this.typedEl) this.typedEl.style.display = 'none';
      if (this.state.typedText !== null) this.set({ typedText: null });
      return;
    }
    const field = this.effectiveField();
    const fmt = (f: TypedField, v: number | string | undefined): string => `${f === 'length' ? 'Length' : 'Angle'}: ${v ?? ''}${f === 'length' ? ' m' : '°'}`;
    const cur = t.buffer || (field === 'length' ? t.lengthM : t.degrees);
    const other: TypedField = field === 'length' ? 'angle' : 'length';
    const otherV = other === 'length' ? t.lengthM : t.degrees;
    const text = fmt(field, cur) + (otherV !== undefined ? `  ·  ${fmt(other, otherV)}` : '');
    if (this.state.typedText !== text) this.set({ typedText: text });
    const el = this.ensureOverlayEl('typed');
    if (!el) return;
    el.textContent = '';
    const main = document.createElement('div');
    main.textContent = text;
    const hint = document.createElement('div');
    hint.textContent = 'Tab: length / angle · Enter: place · Esc: clear';
    hint.style.opacity = '0.7';
    hint.style.fontSize = '11px';
    el.append(main, hint);
    this.placeOverlay(el, this.lastPointer ?? (this.clickOrigin ? this.screenAhead(this.clickOrigin) : null));
  }

  // 8.11g — hover tip of a live-check marker

  /** The live-check marker within {@link MARKER_TIP_PX} of the pointer, as `Title — short` / detail. */
  private markerTipAt(p: { x: number; y: number }): { title: string; detail: string } | null {
    const issues = this.viz.liveValidation?.last?.issues;
    if (!issues || issues.length === 0) return null;
    const canvas = this.viewer.renderer.domElement as HTMLCanvasElement;
    const rect = canvas.getBoundingClientRect();
    const v = new Vector3();
    let best: { title: string; detail: string } | null = null;
    let bestD = MARKER_TIP_PX;
    for (const i of issues) {
      if (!i.position) continue;
      v.set(i.position[0], i.position[1], i.position[2]).project(this.viewer.camera);
      if (v.z > 1) continue;
      const d = Math.hypot(rect.left + ((v.x + 1) / 2) * rect.width - p.x, rect.top + ((1 - v.y) / 2) * rect.height - p.y);
      if (d > bestD) continue;
      bestD = d;
      best = { title: i.short ? `${pathIssueTitle(i.code)} — ${i.short}` : pathIssueTitle(i.code), detail: i.detail };
    }
    return best;
  }

  /** Show (or hide with null) the marker tip next to the cursor. */
  private showTip(at: { x: number; y: number; tip: { title: string; detail: string } } | null): void {
    if (!at) { if (this.tipEl) this.tipEl.style.display = 'none'; return; }
    const el = this.ensureOverlayEl('tip');
    if (!el) return;
    el.textContent = '';
    const title = document.createElement('div');
    title.textContent = at.tip.title;
    title.style.fontWeight = '600';
    const detail = document.createElement('div');
    detail.textContent = at.tip.detail;
    detail.style.opacity = '0.8';
    detail.style.fontSize = '11px';
    el.append(title, detail);
    this.placeOverlay(el, at);
  }

  /** The cursor-side overlay elements (typed prompt / marker tip), created on demand next to the canvas. */
  private ensureOverlayEl(kind: 'typed' | 'tip'): HTMLDivElement | null {
    const existing = kind === 'typed' ? this.typedEl : this.tipEl;
    if (existing) return existing;
    const parent = (this.viewer.renderer?.domElement as HTMLCanvasElement | undefined)?.parentElement;
    if (!parent || typeof document === 'undefined') return null;
    const el = document.createElement('div');
    el.setAttribute('data-testid', kind === 'typed' ? 'path-network-typed' : 'path-network-marker-tip');
    el.style.cssText = 'position:absolute;pointer-events:none;z-index:12;padding:4px 8px;border-radius:4px;'
      + 'background:rgba(20,22,26,0.9);color:#fff;font:12px system-ui,sans-serif;white-space:nowrap;display:none;'
      + (kind === 'typed' ? 'border:1px solid rgba(79,195,247,0.6);' : 'border:1px solid rgba(255,255,255,0.12);max-width:360px;white-space:normal;');
    parent.appendChild(el);
    if (kind === 'typed') this.typedEl = el; else this.tipEl = el;
    return el;
  }

  private placeOverlay(el: HTMLDivElement, at: { x: number; y: number } | null): void {
    const parent = el.parentElement;
    if (!parent || !at) { el.style.display = 'none'; return; }
    const r = parent.getBoundingClientRect();
    el.style.display = 'block';
    // Beside the cursor; flipped to its left when it would leave the viewer on the right.
    const w = el.offsetWidth;
    const right = at.x - r.left + 16;
    el.style.left = `${right + w > r.width - 8 ? Math.max(0, at.x - r.left - 16 - w) : right}px`;
    el.style.top = `${at.y - r.top + 18}px`;
  }

  // ── Gizmo ─────────────────────────────────────────────────────────────

  private syncGizmo(): void {
    const b = this.state.selectedBlock;
    // One block: its gizmo. Several (8.9c): no gizmo - Delete / the menu act on all.
    const show = !!b && this.state.editable && !this.drag && this.state.selectedBlocks.length === 1;
    this.moveHandle.visible = false;
    this.rotateHandle.visible = false;
    this.rotateRing.visible = false;
    this.paramHandleMesh.visible = false;
    if (show && b) {
      const net = this.network();
      const entry = (net.blocks ?? []).find((x) => x.id === b.id);
      // 8.11d: the length / radius handle (not on generated, composition-owned blocks — H5).
      // 8.6: generated blocks show no gizmo at all — every write is refused ('composition-owned').
      const owned = this.isOwnedBlock(b.id);
      const ph = entry && !owned ? paramHandle(entry.extras) : null;
      if (ph) {
        this.paramHandleMesh.position.set(ph.position[0], ph.position[1] + LINE_Y_LIFT, ph.position[2]);
        this.paramHandleMesh.visible = true;
      }
      if (entry && !owned) {
        const [x, z, h] = entry.extras.pose;
        const y = (entry.extras.y ?? 0) + LINE_Y_LIFT;
        this.moveHandle.position.set(x, y, z);
        this.moveHandle.visible = true;
        if (isFreeMovable(entry.extras.kind)) {
          // Rotate knob on the left of travel (E3: left = (f.z, 0, −f.x)).
          const r = h * Math.PI / 180;
          this.rotateHandle.position.set(x + Math.sin(r) * ROTATE_KNOB_OFFSET_M, y, z - Math.cos(r) * ROTATE_KNOB_OFFSET_M);
          this.rotateHandle.visible = true;
          this.rotateRing.position.set(x, y, z);
          this.rotateRing.visible = true;
        }
      }
    }
    this.viewer.markRenderDirty();
  }

  private pickGizmo(e: PointerEvent): 'move' | 'rotate' | 'param' | null {
    if (!this.moveHandle.visible) return null;
    this.rayFrom(e);
    const hits = this._ray.intersectObjects([this.moveHandle, this.rotateHandle, this.paramHandleMesh].filter((m) => m.visible), false);
    if (hits.length === 0) return null;
    const o = hits[0].object;
    return o === this.moveHandle ? 'move' : o === this.paramHandleMesh ? 'param' : 'rotate';
  }

  /** H5: a block (or one of its paths) owned by a composition (generated content) is read-only. */
  private isOwnedBlock(blockId: string): boolean {
    const { input: net, locator } = snapshotNetwork(this.viewer);
    const reg = this.viewer.registry as { getNode?: (path: string) => Object3D | null | undefined } | null | undefined;
    const owned = (nodePath: string | undefined): boolean => !!nodePath && isCompositionOwnedNode(reg?.getNode?.(nodePath) ?? null);
    if (owned(locator.blockNodes.get(blockId))) return true;
    return net.paths.some((p) => p.block === blockId && owned(locator.pathNodes.get(p.id)));
  }

  private beginGizmoDrag(kind: 'move' | 'rotate' | 'param', e: PointerEvent): boolean {
    const b = this.state.selectedBlock;
    if (!b) return false;
    const net = this.network();
    const entry = (net.blocks ?? []).find((x) => x.id === b.id);
    if (!entry) return false;
    const planeY = entry.extras.y ?? 0;
    const start = this.floorPoint(e, planeY);
    if (!start) return false;
    if (kind === 'param') {
      const handle = paramHandle(entry.extras);
      if (!handle) return false;
      // E25 / P2a: parameters are editable on an UNEDITED block only — say so instead of dragging.
      if (b.edited) {
        this.notify(`${b.id} has single edits — Reset to template first, then drag its ${handle.field === 'lengthM' ? 'length' : 'radius'}`);
        return true;
      }
      const ownPaths = [...b.paths];
      const own = new Set(ownPaths);
      const chainPaths = chainMoveSet(net, b.id).pathIds.filter((id) => !own.has(id));
      this.drag = { kind: 'param', blockId: b.id, handle, block: entry.extras, planeY, value: handle.value, ownPaths, chainPaths };
      this.setOwnLinesVisible(ownPaths, false);
    } else if (entry.extras.kind === 'diverge' || entry.extras.kind === 'merge' || entry.extras.kind === 'stub') {
      if (kind !== 'move') return false;
      const hl = junctionHostLine(net, b.id);
      const host = hl ? projectableLine(hl.specs) : null;
      if (!host) { this.set({ lastError: `${b.id}: host line not found` }); return false; }
      const p0 = host.project([entry.extras.pose[0], planeY, entry.extras.pose[1]]);
      this.drag = {
        kind: 'slide', blockId: b.id, host, planeY, s: p0?.s ?? 0, at: p0,
        spec: { kind: entry.extras.kind, ...entry.extras.params },
      };
    } else if (kind === 'move') {
      // 8.8: both candidate sets up front — Shift may change during the drag.
      const snaps = this.viewer.getPlugin?.('snap-point') as { listPathPlacementPorts?: () => FreePort[] } | undefined;
      const placementPorts = snaps?.listPathPlacementPorts?.() ?? [];
      const moveSet = (ids: string[]): MoveSet => {
        const set = new Set(ids);
        return { pathIds: ids, ends: movingFreeEnds(net, set), targets: dropTargets(net, set, placementPorts) };
      };
      this.drag = {
        kind: 'move', blockId: b.id, start, planeY, delta: [0, 0], pivot: [entry.extras.pose[0], entry.extras.pose[1]],
        single: moveSet(blockMoveSet(net, b.id).pathIds), chain: moveSet(chainMoveSet(net, b.id).pathIds),
        useChain: !e.shiftKey, snap: null,
      };
    } else {
      this.drag = { kind: 'rotate', blockId: b.id, pathIds: [...b.paths], start, planeY, pivot: [entry.extras.pose[0], entry.extras.pose[1]], angle: 0 };
    }
    this.viewer.controls.enabled = false;
    this.syncGizmo();
    return true;
  }

  /**
   * plan-628 8.11a: start moving the WHOLE selection rigidly — every selected
   * straight/curve block (with its hosted junctions) and the selected planner
   * placements. A junction whose host is not selected stays (it slides on its
   * host only).
   */
  private beginGroupDrag(e: PointerEvent): boolean {
    const net = this.network();
    const byId = new Map((net.blocks ?? []).map((b) => [b.id, b]));
    const blockIds = this.state.selectedBlocks.filter((id) => { const b = byId.get(id); return !!b && isFreeMovable(b.extras.kind); });
    const pathIds = new Set<string>();
    for (const id of blockIds) for (const p of blockMoveSet(net, id).pathIds) pathIds.add(p);
    const placements = this.selectedPlacements();
    if (blockIds.length === 0 && placements.length === 0) return false;
    const planeY = blockIds.length > 0 ? (byId.get(blockIds[0])!.extras.y ?? 0) : 0;
    const start = this.floorPoint(e, planeY);
    if (!start) return false;
    this.drag = { kind: 'group', start, planeY, delta: [0, 0], blockIds, pathIds: [...pathIds], placements };
    this.viewer.controls.enabled = false;
    this.syncGizmo();
    this.hideClickPreview();
    return true;
  }

  private updateDrag(e: PointerEvent): void {
    const d = this.drag;
    if (!d) return;
    const p = this.floorPoint(e, d.planeY);
    if (!p) return;
    if (d.kind === 'group') {
      d.delta = [p[0] - d.start[0], p[2] - d.start[2]];
      this._m.makeTranslation(d.delta[0], 0, d.delta[1]);
      this.viz.previewLineTransform(d.pathIds, this._m);
      for (const pl of d.placements) { pl.root.position.x = pl.x0 + d.delta[0]; pl.root.position.z = pl.z0 + d.delta[1]; pl.root.updateMatrixWorld(true); }
      this.viewer.markRenderDirty();
      return;
    }
    if (d.kind === 'param') {
      d.value = paramFromPointer(d.handle, p, e.shiftKey);
      const pv = paramDragPreview(d.block, d.handle.field, d.value);
      if (pv) {
        this.showGhost(pv.specs);
        rigidMatrix(pv.chain, this._m, this._m2);
        this.viz.previewLineTransform(d.chainPaths, this._m);
      }
      const at = d.value * d.handle.unit;
      this.paramHandleMesh.position.set(d.handle.origin[0] + d.handle.dir[0] * at, d.planeY + LINE_Y_LIFT, d.handle.origin[2] + d.handle.dir[1] * at);
      this.paramHandleMesh.visible = true;
      this.showParamLabel(d, { x: e.clientX, y: e.clientY });
      this.viewer.markRenderDirty();
      return;
    }
    if (d.kind === 'move') {
      const useChain = !e.shiftKey;
      if (useChain !== d.useChain) {
        this.viz.previewLineTransform(moveSetOf(d).pathIds, null);
        d.useChain = useChain;
      }
      const set = moveSetOf(d);
      d.delta = [p[0] - d.start[0], p[2] - d.start[2]];
      const raw: RigidXZ = { dx: d.delta[0], dz: d.delta[1], dHeadingDeg: 0, pivot: d.pivot };
      d.snap = dropSnap(set.ends, set.targets, raw);
      rigidMatrix(d.snap?.motion ?? raw, this._m, this._m2);
      this.viz.previewLineTransform(set.pathIds, this._m);
      if (d.snap) {
        const t = d.snap.target.position;
        this.pointMarker.position.set(t[0], (t[1] ?? 0) + LINE_Y_LIFT, t[2]);
      }
      this.pointMarker.visible = !!d.snap;
    } else if (d.kind === 'rotate') {
      d.angle = snapAngle(headingDelta(d.pivot, d.start, p), e.shiftKey);
      // heading +h = rotation about Y by −h (heading = atan2(z, x)).
      this._m.makeTranslation(d.pivot[0], 0, d.pivot[1]);
      this._m2.makeRotationY(-d.angle * Math.PI / 180);
      this._m.multiply(this._m2);
      this._m2.makeTranslation(-d.pivot[0], 0, -d.pivot[1]);
      this._m.multiply(this._m2);
      this.viz.previewLineTransform(d.pathIds, this._m);
    } else {
      const at = d.host.project(p);
      d.at = at;
      if (at) {
        d.s = at.s;
        this.pointMarker.position.set(at.position[0], at.position[1] + LINE_Y_LIFT, at.position[2]);
        this.pointMarker.visible = true;
        const side = (d.spec.side === 'right' ? 'right' : 'left') as 'left' | 'right';
        this.showGhost(junctionPreview(d.spec as never, at, side));
      }
    }
    this.viewer.markRenderDirty();
  }

  private async endDrag(): Promise<void> {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    this.viewer.controls.enabled = true;
    this.pointMarker.visible = false;
    this.hideGhost();
    this.clearDragPreview(d);
    if (d.kind === 'param') {
      // 8.11d: ONE setParams with the chain following (one undo step); the predecessor edge stays (start unchanged).
      if (Math.abs(d.value - d.handle.value) > 1e-6) {
        const r = await this.exec('layout.path.setParams', { blockId: d.blockId, [d.handle.field]: d.value, chain: true });
        if (r) this.pinFreed(r.unlinked);
      }
    } else if (d.kind === 'group') {
      const [dx, dz] = d.delta;
      if (Math.hypot(dx, dz) > 1e-4) {
        const unlinked: unknown[] = [];
        const layoutMove = !!commandRegistry.get('layout.move');
        const planner = this.planner();
        await this.inOneStep('move selection', async (run) => {
          // One block after the other, each alone (P6): an edge between two moved
          // blocks is released by the first move and re-linked by the second
          // (auto-link at the drop); an edge to an unmoved block stays released —
          // never a kink (8.10).
          for (const id of d.blockIds) {
            const r = await run('layout.path.move', { blockId: id, dx: r4(dx), dz: r4(dz) });
            if (Array.isArray(r.unlinked)) unlinked.push(...r.unlinked);
          }
          for (const pl of d.placements) {
            const pos: [number, number, number] = [r4(pl.position[0] + dx), pl.position[1], r4(pl.position[2] + dz)];
            if (layoutMove) await run('layout.move', { id: pl.id, x: pos[0], y: pos[1], z: pos[2] });
            else await planner?.moveById?.(pl.id, pos, pl.rotation);
          }
        });
        // Only the ends that stay free are pinned (an inner edge was re-linked).
        const links = new Set(this.network().paths.flatMap((p) => p.successors.map((s) => `${p.id}>${s}`)));
        this.pinFreed(unlinked.filter((u) => Array.isArray(u) && !links.has(`${u[0]}>${u[1]}`)));
      }
    } else if (d.kind === 'move') {
      // 8.8: the re-snapped motion when a free end is in reach, else the raw drag.
      const m = d.snap?.motion ?? { dx: d.delta[0], dz: d.delta[1], dHeadingDeg: 0 };
      if (Math.hypot(m.dx, m.dz) > 1e-4 || Math.abs(m.dHeadingDeg) > 1e-6) {
        const args: Record<string, unknown> = { blockId: d.blockId, dx: r4(m.dx), dz: r4(m.dz) };
        if (Math.abs(m.dHeadingDeg) > 1e-6) args.dHeadingDeg = r4(m.dHeadingDeg);
        if (d.useChain) args.chain = true;
        const r = await this.exec('layout.path.move', args);
        if (r) this.pinFreed(r.unlinked);
      }
    } else if (d.kind === 'rotate') {
      if (Math.abs(d.angle) > 1e-6) await this.exec('layout.path.move', { blockId: d.blockId, dHeadingDeg: r4(d.angle) });
    } else if (d.at) {
      await this.exec('layout.path.move', { blockId: d.blockId, s: r4(d.s) });
    }
    this.syncGizmo();
  }

  private cancelDrag(): void {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    this.viewer.controls.enabled = true;
    this.clearDragPreview(d);
    this.pointMarker.visible = false;
    this.hideGhost();
    this.syncGizmo();
  }

  private clearDragPreview(d: DragState): void {
    if (d.kind === 'param') {
      this.viz.previewLineTransform(d.chainPaths, null);
      this.setOwnLinesVisible(d.ownPaths, true);
      this.showParamLabel(null, null);
    } else if (d.kind === 'group') {
      this.viz.previewLineTransform(d.pathIds, null);
      for (const pl of d.placements) { pl.root.position.x = pl.x0; pl.root.position.z = pl.z0; pl.root.updateMatrixWorld(true); }
    } else if (d.kind === 'move') {
      this.viz.previewLineTransform(d.single.pathIds, null);
      this.viz.previewLineTransform(d.chain.pathIds, null);
    } else if (d.kind === 'rotate') {
      this.viz.previewLineTransform(d.pathIds, null);
    }
  }

  /** 8.11d: hide the block's own drawn lines while its ghost shows the new geometry (true restores). */
  private setOwnLinesVisible(pathIds: readonly string[], visible: boolean): void {
    const lines = this.viz.getLineObjects();
    for (const id of pathIds) {
      const l = lines.get(id);
      if (l) l.visible = visible;
    }
    this.viewer.markRenderDirty();
  }

  /** 8.11d: the dragged value next to the cursor (`Length: 3.25 m` / `Radius: 1.5 m`); null hides it. */
  private showParamLabel(d: Extract<DragState, { kind: 'param' }> | null, at: { x: number; y: number } | null): void {
    if (!d || !at) {
      if (!this.typed && this.typedEl) this.typedEl.style.display = 'none';
      return;
    }
    const el = this.ensureOverlayEl('typed');
    if (!el) return;
    el.textContent = `${d.handle.field === 'lengthM' ? 'Length' : 'Radius'}: ${d.value} m`;
    const hint = document.createElement('div');
    hint.textContent = 'Shift: free (no 0.25 m raster) · chain follows';
    hint.style.opacity = '0.7';
    hint.style.fontSize = '11px';
    el.appendChild(hint);
    this.placeOverlay(el, at);
  }

  /** The length / radius handle while visible (tests / diagnostics). */
  get paramHandleObject(): Object3D | null {
    return this.paramHandleMesh.visible ? this.paramHandleMesh : null;
  }

  /** 8.8: keep the ends a move freed revealed (both sides of every released edge). */
  private pinFreed(unlinked: unknown): void {
    const ids = new Set<string>();
    if (Array.isArray(unlinked)) for (const e of unlinked) if (Array.isArray(e)) for (const id of e) if (typeof id === 'string') ids.add(id);
    this.freedPaths = [...ids];
    this.syncPins();
  }

  // ── Tool hover / place ────────────────────────────────────────────────

  private toolEntry(): PathCatalogEntry | null {
    return this.state.toolId ? this.entryById(this.state.toolId) : null;
  }

  private hoverTool(e: { clientX: number; clientY: number }): void {
    const entry = this.toolEntry();
    if (!entry) return;
    if (isJunctionEntry(entry.spec)) {
      this.lastJunction = null;
      const hit = this.viz.pickLineAt(e.clientX, e.clientY, JUNCTION_PICK_PX);
      if (hit) {
        if (this.hoverLineCache?.pathId !== hit.pathId) {
          const p = this.network().paths.find((x) => x.id === hit.pathId);
          const line = p ? projectableLine(p.segments) : null;
          this.hoverLineCache = line ? { pathId: hit.pathId, line } : null;
        }
        const cache = this.hoverLineCache;
        const floor = this.floorPoint(e, hit.point[1]);
        const at = cache && floor ? cache.line.project(floor) : null;
        if (cache && at) {
          const side = entry.spec.side ?? at.side;
          this.lastJunction = { pathId: cache.pathId, at, side };
          this.pointMarker.position.set(at.position[0], at.position[1] + LINE_Y_LIFT, at.position[2]);
          this.pointMarker.visible = true;
          this.showGhost(junctionPreview(entry.spec, at, side));
          this.viewer.markRenderDirty();
          return;
        }
      }
      this.pointMarker.visible = false;
      this.hideGhost();
      this.viewer.markRenderDirty();
      return;
    }
    const p = this.floorPoint(e, 0);
    if (!p) return;
    const g = ghostPlacement(this.toolSpec(entry), p, this.ghostHeadingDeg, this.freePorts);
    this.lastGhost = g;
    if (g) this.showGhost(g.specs); else this.hideGhost();
    this.pointMarker.visible = g?.mode === 'port';
    if (g?.mode === 'port') this.pointMarker.position.set(g.port.position[0], (g.port.position[1] ?? 0) + LINE_Y_LIFT, g.port.position[2]);
    this.viewer.markRenderDirty();
  }

  private async placeTool(): Promise<boolean> {
    const entry = this.toolEntry();
    if (!entry || !this.state.editable) return false;
    if (isJunctionEntry(entry.spec)) {
      const j = this.lastJunction;
      if (!j) return false;
      const args: Record<string, unknown> = { kind: entry.spec.kind, pathId: j.pathId, s: r4(j.at.s), side: j.side };
      const r = await this.exec('layout.path.junction', args);
      if (r && typeof r.blockId === 'string') { this.armTool(null); this.selectBlock(r.blockId); }
      return !!r;
    }
    const g = this.lastGhost;
    if (!g) return false;
    const r = await this.exec('layout.path.place', placeArgsFor(this.toolSpec(entry), g));
    if (r) {
      // Keep the tool armed for the next piece ("weiterbauen"); new ends are ports now.
      this.freePorts = this.listFreePorts();
      this.lastGhost = null;
      this.hideGhost();
    }
    return !!r;
  }

  /** 8.11c: the tool's block spec with the typed length (straight) / angle (curve). */
  private toolSpec(entry: PathCatalogEntry): PathBlockSpec {
    const t = this.typed ? this.typedValues() : null;
    if (!t) return entry.spec;
    if (entry.spec.kind === 'straight' && t.lengthM !== undefined && t.lengthM > 0) return { ...entry.spec, lengthM: t.lengthM };
    if (entry.spec.kind === 'curve' && t.degrees !== undefined && t.degrees > 0) return { ...entry.spec, degrees: Math.min(360, t.degrees) };
    return entry.spec;
  }

  private showGhost(specs: readonly PathSegmentSpec[]): void {
    const positions = samplePositions(specs);
    if (positions.length === 0) { this.hideGhost(); return; }
    if (!this.ghost) {
      const mat = new LineMaterial({ color: GHOST_HEX, linewidth: 4, transparent: true, opacity: 0.85, dashed: true, dashSize: 0.12, gapSize: 0.08, depthTest: false });
      const canvas = this.viewer.renderer?.domElement as HTMLCanvasElement | undefined;
      mat.resolution.set(canvas?.clientWidth || 1920, canvas?.clientHeight || 1080);
      this.ghost = new LineSegments2(new LineSegmentsGeometry(), mat);
      this.ghost.name = '__pathNetworkUi:ghost';
      this.ghost.renderOrder = 535;
      this.ghost.frustumCulled = false;
      markNoAO(this.ghost);
      this.overlay.add(this.ghost);
    }
    setFatLinePositions(this.ghost, new Float32Array(positions));
    this.ghost.computeLineDistances();
    this.ghost.visible = true;
  }

  private hideGhost(): void {
    if (this.ghost) this.ghost.visible = false;
  }

  /** The ghost line (tests / diagnostics). */
  get ghostObject(): Object3D | null {
    return this.ghost?.visible ? this.ghost : null;
  }

  /** The last ghost placement (tests / diagnostics). */
  get currentGhost(): GhostPlacement | null {
    return this.lastGhost;
  }

  // ── Pointer + keyboard ────────────────────────────────────────────────

  private rayFrom(e: { clientX: number; clientY: number }): void {
    const canvas = this.viewer.renderer.domElement as HTMLCanvasElement;
    pointerToNDC(e.clientX, e.clientY, canvas, this._ndc);
    this._ray.setFromCamera(this._ndc, this.viewer.camera);
  }

  private floorPoint(e: { clientX: number; clientY: number }, y: number): Vec3Tuple | null {
    this.rayFrom(e);
    this._plane.set(new Vector3(0, 1, 0), -y);
    const hit = this._ray.ray.intersectPlane(this._plane, this._hit);
    return hit ? [hit.x, y, hit.z] : null;
  }

  /** Pointer-down routing (exposed for tests that drive the gestures with synthetic events). */
  handlePointerDown(e: PointerEvent): boolean {
    if (!this.state.active || e.button !== 0) return false;
    if (this.state.toolId) {
      if (!this.state.editable) return false;
      this.hoverTool(e);
      void this.placeTool();
      return true;
    }
    if (this.state.editable) {
      const g = this.pickGizmo(e);
      if (g && this.beginGizmoDrag(g, e)) return true;
    }
    if (e.altKey) return false; // 453 split belongs to the visualizer
    const mods = e.shiftKey || e.ctrlKey || e.metaKey;
    // 8.11b: a press on a foreign free start docks onto it (on release) — before
    // the line under it is picked, and without the snap picker of that end.
    if (!mods && this.clickOrigin && this.state.editable && this.targetAt({ x: e.clientX, y: e.clientY })) {
      this.clickDown = { x: e.clientX, y: e.clientY };
      this.suppressMouseCompat = true;
      return true;
    }
    const hit = this.viz.pickLineAt(e.clientX, e.clientY);
    if (!hit) {
      // 8.11b: with a free end selected a floor CLICK builds (on release); a drag stays the marquee.
      if (!mods && this.clickOrigin && this.state.editable) {
        this.clickDown = { x: e.clientX, y: e.clientY };
        return false;
      }
      if (!mods && (this.state.selectedBlock || this.state.enteredBlock || this.viz.selectedPath)) this.selectBlock(null);
      return false;
    }
    const net = this.network();
    const block = this.blockOfPath(net, hit.pathId);
    if (this.state.enteredBlock && block === this.state.enteredBlock) {
      this.viz.selectPickedPath(hit.pathId);
      this.set({ selectedPath: hit.pathId });
    } else if (block && mods) {
      // 8.11a: Shift/Ctrl extend a mixed selection - the planner items stay.
      this.toggleBlock(block);
      return true;
    } else if (block) {
      // 8.9c / 8.11a: a click on a member of a multi-selection (or of a mixed one
      // with planner items) keeps the selection, the clicked block becomes the
      // primary (card) and a drag moves it all; a plain click elsewhere replaces it.
      const keep = this.state.selectedBlocks.includes(block)
        && (this.state.selectedBlocks.length > 1 || this.sceneSelection().length > 0);
      if (keep) this.setSelection(this.state.selectedBlocks, block);
      else this.selectBlock(block);
      // 8.9c: while the simulation runs the gizmo is gone - say why.
      if (!this.state.editable) this.notify(PATH_NETWORK_LOCKED_HINT);
      if (keep) {
        if (this.state.editable) this.groupCandidate = { x: e.clientX, y: e.clientY, e };
        return true;
      }
    } else {
      this.selectBlock(null);
      this.viz.selectPickedPath(hit.pathId);
      this.set({ selectedPath: hit.pathId });
    }
    this.viewer.selectionManager?.clear?.();
    return true;
  }

  handleDoubleClick(e: MouseEvent): boolean {
    if (!this.state.active || this.state.toolId) return false;
    const hit = this.viz.pickLineAt(e.clientX, e.clientY);
    if (!hit) return false;
    const block = this.blockOfPath(this.network(), hit.pathId);
    if (!block) return false;
    this.enterBlock(block, hit.pathId);
    return true;
  }

  /**
   * plan-628 8.9c: right-click on a path block opens the viewer's context menu
   * (`viewer.contextMenu`, the one menu of the app) with the path-block items.
   * Answers true when it claimed the event (the viewer's node menu stays out).
   */
  handleContextMenu(e: MouseEvent): boolean {
    if (!this.state.active || this.drag) return false;
    if (this.rightDown) {
      const moved = Math.hypot(e.clientX - this.rightDown[0], e.clientY - this.rightDown[1]);
      this.rightDown = null;
      if (moved > CONTEXT_DRAG_PX) return false; // a right-drag orbits
    }
    if (this.state.toolId) { this.armTool(null); return true; } // right-click cancels an armed tool
    const hit = this.viz.pickLineAt(e.clientX, e.clientY);
    if (!hit) return false;
    const net = this.network();
    const block = this.blockOfPath(net, hit.pathId);
    let items: ContextMenuItem[];
    if (block) {
      // A block outside the selection replaces it (planner items included, 8.11a).
      if (!this.state.selectedBlocks.includes(block)) { this.selectBlock(block); this.viewer.selectionManager?.clear?.(); }
      else if (this.state.selectedBlock?.id !== block) this.setSelection(this.state.selectedBlocks, block);
      items = this.contextMenuItems(block);
    } else {
      this.selectBlock(null);
      this.viz.selectPickedPath(hit.pathId);
      this.set({ selectedPath: hit.pathId });
      items = this.state.editable
        ? [{ id: PATH_MENU_IDS.delete, label: `Delete path ${hit.pathId}`, shortcut: 'Del', danger: true, action: () => { void this.removeSelected(); } }]
        : [{ id: PATH_MENU_IDS.locked, label: PATH_NETWORK_LOCKED_HINT }];
    }
    const target: ContextMenuTarget = { path: block ?? hit.pathId, node: this.overlay, types: ['PathBlock'], extras: {}, hitPoint: hit.point };
    this.viewer.contextMenu?.openItems?.({ x: e.clientX, y: e.clientY }, target, items);
    return true;
  }

  /** The context-menu items of a right-clicked block (8.9c). */
  contextMenuItems(blockId: string): ContextMenuItem[] {
    if (!this.state.editable) return [{ id: PATH_MENU_IDS.locked, label: PATH_NETWORK_LOCKED_HINT }];
    const sel = this.state.selectedBlocks;
    const net = this.network();
    const b = (net.blocks ?? []).find((x) => x.id === blockId);
    const free = !!b && isFreeMovable(b.extras.kind);
    const chain = free ? chainMoveSet(net, blockId).blockIds : [blockId];
    const items: ContextMenuItem[] = [];
    items.push({
      id: PATH_MENU_IDS.delete,
      label: deleteLabel(sel.length, blockId, this.sceneSelection().length),
      shortcut: 'Del', danger: true, order: 10,
      action: () => { void this.removeSelected(); },
    });
    if (chain.length > 1) {
      items.push({
        id: PATH_MENU_IDS.deleteChain, label: `Delete chain from here (${chain.length} blocks)`, danger: true, order: 20,
        action: () => { void this.removeChain(blockId); },
      });
      items.push({
        id: PATH_MENU_IDS.selectChain, label: 'Select chain from here', order: 30,
        action: () => { this.selectChain(blockId); },
      });
    }
    if (free && sel.length <= 1) {
      items.push({
        id: PATH_MENU_IDS.rotate, label: `Rotate ${ROTATE_SELECTED_STEP_DEG}°`, shortcut: 'R', order: 40, dividerBefore: true,
        action: () => { void this.rotateSelected(ROTATE_SELECTED_STEP_DEG); },
      });
      items.push({
        id: PATH_MENU_IDS.rotateBack, label: `Rotate −${ROTATE_SELECTED_STEP_DEG}°`, order: 41,
        action: () => { void this.rotateSelected(-ROTATE_SELECTED_STEP_DEG); },
      });
      if (this.state.selectedBlock?.edited) {
        items.push({ id: PATH_MENU_IDS.reset, label: 'Reset to template', order: 50, action: () => { void this.resetSelected(); } });
      }
      // 8.11e: "Replace with …" — straight / curve only (junctions live on their host), never generated blocks (H5).
      const opts = b && !this.isOwnedBlock(blockId) ? replaceOptions(b.extras) : [];
      if (opts.length > 0) {
        items.push({
          id: PATH_MENU_IDS.replace, label: 'Replace with …', order: 45,
          children: opts.map((o, i) => ({ id: replaceMenuId(o.id), label: o.label, order: i, action: () => { void this.replaceBlock(blockId, o.id); } })),
        });
      }
    }
    return items;
  }

  /**
   * plan-628 8.11e: replace straight/curve block `blockId` by the "Replace with
   * …" choice `optionId` (`straight` / `curve-l` / `curve-r`) — ONE
   * `layout.path.replace` with the chain following: the start pose and the
   * predecessor edge stay, the downstream chain moves rigidly onto the new end
   * so its connection stays tangential (E70). Answers true when replaced.
   */
  async replaceBlock(blockId: string, optionId: string): Promise<boolean> {
    if (!this.state.editable) { this.notify(PATH_NETWORK_LOCKED_HINT); return false; }
    const b = (this.network().blocks ?? []).find((x) => x.id === blockId);
    if (!b) return false;
    if (this.isOwnedBlock(blockId)) { this.notify(`${blockId} is generated content — it cannot be replaced here`); return false; }
    const opt = replaceOptions(b.extras).find((o) => o.id === optionId);
    if (!opt) { this.notify(`${blockId} (${b.extras.kind}) cannot be replaced with '${optionId}'`); return false; }
    const r = await this.exec('layout.path.replace', replaceArgs(blockId, opt.spec));
    if (r) { this.selectBlock(blockId); this.pinFreed(r.unlinked); }
    return !!r;
  }

  // ── Copy / paste (8.11f) ──────────────────────────────────────────────

  /**
   * plan-628 8.11f: Ctrl+C — keep the selected straight/curve blocks (world
   * geometry, inner edges) in the path-network clipboard. Junction and
   * generated (composition-owned) blocks are not copied. Answers the number
   * of copied blocks; with nothing to copy the clipboard is cleared.
   */
  copySelected(): number {
    // E82: copyBlocks itself skips junction and generated (composition-owned) blocks — same rule as MCP.
    const ids = this.state.selectedBlocks;
    const clip = ids.length > 0 ? copyBlocks(this.network(), ids) : null;
    this.clip = clip && clip.blocks.length > 0 ? clip : null;
    return this.clip?.blocks.length ?? 0;
  }

  /** The number of blocks in the path-network clipboard (tests / diagnostics). */
  get clipboardSize(): number {
    return this.clip?.blocks.length ?? 0;
  }

  /**
   * plan-628 8.11f: Ctrl+V — paste the clipboard as NEW blocks in ONE
   * `layout.path.paste` (one undo step): docked tangentially at the free path
   * END / emitting `path` port under the cursor (the copy's first free start
   * takes its pose), otherwise free at the cursor keeping the relative layout.
   * The pasted blocks become the selection. `at` defaults to the last pointer.
   */
  async paste(at?: { x: number; y: number }): Promise<string[]> {
    const clip = this.clip;
    if (!clip) return [];
    if (!this.state.editable) { this.notify(PATH_NETWORK_LOCKED_HINT); return []; }
    const anchor = clipAnchor(clip);
    if (!anchor) return [];
    const p = at ?? this.lastPointer;
    const target = p ? this.pasteTargetAt(p) : null;
    const floor = p ? this.floorPoint({ clientX: p.x, clientY: p.y }, anchor.position[1]) : null;
    // No pointer over the canvas: next to the original (1 m off on X and Z), as the planner's paste.
    const cursor: Vec3Tuple = floor ?? [anchor.position[0] + 1, anchor.position[1], anchor.position[2] + 1];
    const m = pasteMotion(anchor, target, cursor);
    const r = await this.exec('layout.path.paste', { clip: JSON.stringify(clip), dx: m.dx, dz: m.dz, dHeadingDeg: m.dHeadingDeg, pivotX: m.pivot[0], pivotZ: m.pivot[1] });
    const ids = r && Array.isArray(r.blockIds) ? r.blockIds.filter((x): x is string => typeof x === 'string') : [];
    if (ids.length > 0) this.setSelection(ids, ids[0]);
    return ids;
  }

  /** The free END / emitting port within {@link CLICK_LAYOUT_TARGET_PX} of a screen point (paste docking). */
  private pasteTargetAt(p: { x: number; y: number }): FreePort | null {
    const canvas = this.viewer.renderer.domElement as HTMLCanvasElement;
    const rect = canvas.getBoundingClientRect();
    let best: FreePort | null = null;
    let bestD = CLICK_LAYOUT_TARGET_PX;
    const v = new Vector3();
    for (const t of this.listFreePorts()) {
      if (t.end !== 'end') continue;
      v.set(t.position[0], t.position[1] ?? 0, t.position[2]).project(this.viewer.camera);
      if (v.z > 1) continue;
      const d = Math.hypot(rect.left + ((v.x + 1) / 2) * rect.width - p.x, rect.top + ((1 - v.y) / 2) * rect.height - p.y);
      if (d <= bestD) { best = t; bestD = d; }
    }
    return best;
  }

  /** 8.9c: the whole block under the pointer is drawn hovered (null clears). */
  private setHover(at: { x: number; y: number } | null): void {
    this.hoverAt = at;
    if (!at) {
      if (this.hoverRaf) { cancelAnimationFrame(this.hoverRaf); this.hoverRaf = 0; }
      this.viz.setBlockHover([]);
      return;
    }
    if (this.hoverRaf) return;
    this.hoverRaf = requestAnimationFrame(() => {
      this.hoverRaf = 0;
      const p = this.hoverAt;
      if (!p || !this.state.active || this.drag || this.state.toolId) { this.viz.setBlockHover([]); this.showTip(null); return; }
      const hit = this.viz.pickLineAt(p.x, p.y);
      // 8.11g: the live-check marker under the pointer explains itself next to the cursor.
      const tip = this.markerTipAt(p);
      this.showTip(tip ? { ...p, tip } : null);
      // 8.11b: the click-layout ghost follows the pointer over the floor (and onto a foreign free start).
      this.updateClickPreview(p, !!hit && !(this.clickOrigin && this.targetAt(p)));
      if (!hit) { this.viz.setBlockHover([]); return; }
      const net = this.network();
      const block = this.blockOfPath(net, hit.pathId);
      this.viz.setBlockHover(block ? blockMoveSet(net, block).pathIds : [hit.pathId]);
    });
  }

  private wire(): void {
    const canvas = this.viewer.renderer?.domElement as HTMLCanvasElement | undefined;
    if (!canvas) return;
    // plan-2215 2.6: no screen pick while a render strategy draws other cameras.
    const blocked = (): boolean => this.viewer.pointerPickBlocked === true;
    const onDown = (e: PointerEvent): void => {
      this.suppressMouseCompat = false;
      if (blocked()) return;
      if (this.handlePointerDown(e)) {
        e.stopPropagation();
        e.stopImmediatePropagation();
        // No compatibility mousedown/up: the snap picker of the end must not open (8.11b).
        if (this.suppressMouseCompat) e.preventDefault();
      }
    };
    const onMove = (e: PointerEvent): void => {
      this.lastPointer = { x: e.clientX, y: e.clientY };
      if (blocked()) {
        // A render strategy took over: the running gesture is dropped, the hover goes.
        this.groupCandidate = null;
        this.clickDown = null;
        this.cancelDrag();
        this.setHover(null);
        return;
      }
      const gc = this.groupCandidate;
      if (gc && !this.drag && (e.buttons & 1) && Math.hypot(e.clientX - gc.x, e.clientY - gc.y) > GROUP_DRAG_PX) {
        this.groupCandidate = null;
        if (this.beginGroupDrag(gc.e)) { this.updateDrag(e); return; }
      }
      if (this.drag) { this.updateDrag(e); return; }
      if (this.state.toolId && this.state.active) { this.hoverTool(e); if (this.typed) this.renderTyped(); return; }
      if (this.state.active && e.buttons === 0) this.setHover({ x: e.clientX, y: e.clientY });
    };
    // 8.11f: a pointer that left the canvas (over a panel) no longer names a paste / typed-Enter spot.
    const onLeave = (): void => { this.setHover(null); this.showTip(null); if (!this.drag) this.lastPointer = null; };
    const onRightDown = (e: PointerEvent): void => { if (e.button === 2) this.rightDown = [e.clientX, e.clientY]; };
    const onContext = (e: MouseEvent): void => {
      if (blocked()) return;
      if (this.handleContextMenu(e)) { e.preventDefault(); e.stopImmediatePropagation(); }
    };
    const onUp = (e: PointerEvent): void => {
      this.groupCandidate = null;
      if (this.drag) { void this.endDrag(); return; }
      // 8.11b: a short press-release on the floor with a free end selected builds.
      const down = this.clickDown;
      this.clickDown = null;
      if (blocked()) return;
      if (down && e.button === 0 && Math.hypot(e.clientX - down.x, e.clientY - down.y) < CLICK_LAYOUT_CLICK_PX) {
        void this.clickAt(e.clientX, e.clientY);
      }
    };
    const onDbl = (e: MouseEvent): void => {
      if (blocked()) return;
      if (this.handleDoubleClick(e)) { e.stopPropagation(); e.stopImmediatePropagation(); }
    };
    const onKey = (e: KeyboardEvent): void => {
      if (!this.state.active) return;
      const tag = (document.activeElement?.tagName ?? '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
      // 8.9c: an open context menu owns the keyboard (Esc closes IT, chords pick items).
      if (this.viewer.contextMenu?.getSnapshot?.().open) return;
      // 8.11c: typed dimensions own digits / Tab / Enter / Backspace while a preview is shown.
      if (this.handleTypedKey(e)) { e.preventDefault(); e.stopImmediatePropagation(); return; }
      if (e.key === 'Escape') {
        if (this.escape()) e.stopPropagation();
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && (this.state.selectedBlocks.length > 0 || (!this.state.enteredBlock && this.viz.selectedPath))) {
        // 8.9a: the path network owns Delete while it has a selection (no
        // planner / editor delete of something else, no browser back).
        e.preventDefault();
        e.stopImmediatePropagation();
        void this.removeSelected();
      } else if ((e.key === 'c' || e.key === 'C') && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) {
        // 8.11f: the selected blocks go into the path-network clipboard (nothing selected
        // clears it). The event travels on: the planner's own Ctrl+C copies its selected
        // placements in the same gesture (one clipboard each, no second planner clipboard).
        this.copySelected();
      } else if ((e.key === 'v' || e.key === 'V') && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) {
        // 8.11f: paste the blocks (docked at a free end under the cursor, else at the cursor);
        // the planner pastes its own clipboard from the same key.
        if (this.clip) void this.paste();
      } else if ((e.key === 'r' || e.key === 'R') && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (this.state.toolId) {
          this.ghostHeadingDeg += e.shiftKey ? -ROTATE_STEP_DEG : ROTATE_STEP_DEG;
          e.stopImmediatePropagation();
        } else if (this.state.selectedBlock && this.state.selectedBlocks.length === 1) {
          // 8.9c: R turns the selected block (Shift+R the other way).
          e.stopImmediatePropagation();
          void this.rotateSelected(e.shiftKey ? -ROTATE_SELECTED_STEP_DEG : ROTATE_SELECTED_STEP_DEG);
        }
      }
    };
    const isCatalogDrag = (e: DragEvent): boolean => {
      if (!this.catalogDrag || !e.dataTransfer) return false;
      const types = Array.from(e.dataTransfer.types);
      // 8.1: a planner-library path-block card carries the planner's catalog id instead.
      return types.includes(PATH_BLOCK_DRAG_TYPE) || (this.libraryDrag && types.includes(DT_CATALOG_ID));
    };
    const onDragOver = (e: DragEvent): void => {
      if (!isCatalogDrag(e) || !this.state.editable) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      this.hoverTool(e);
    };
    const onDrop = (e: DragEvent): void => {
      if (!isCatalogDrag(e)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (!this.state.editable) return;
      this.hoverTool(e);
      this.dropPending = true;
      void this.placeTool().finally(() => {
        this.dropPending = false;
        // A drop leaves the tool idle (a refused junction stays armed until dragend otherwise).
        if (!this.catalogDrag && this.state.toolId) this.disarmKeepingError();
      });
    };
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointerdown', onRightDown, { capture: true });
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerleave', onLeave);
    // Capture on the canvas: runs before the viewer's own (bubble) node menu.
    canvas.addEventListener('contextmenu', onContext, { capture: true });
    canvas.addEventListener('dragover', onDragOver, { capture: true });
    canvas.addEventListener('drop', onDrop, { capture: true });
    window.addEventListener('pointerup', onUp);
    canvas.addEventListener('dblclick', onDbl, { capture: true });
    document.addEventListener('keydown', onKey, { capture: true });
    this.unsubs.push(
      () => canvas.removeEventListener('pointerdown', onDown),
      () => canvas.removeEventListener('pointerdown', onRightDown, { capture: true }),
      () => canvas.removeEventListener('pointermove', onMove),
      () => canvas.removeEventListener('pointerleave', onLeave),
      () => canvas.removeEventListener('contextmenu', onContext, { capture: true }),
      () => canvas.removeEventListener('dragover', onDragOver, { capture: true }),
      () => canvas.removeEventListener('drop', onDrop, { capture: true }),
      () => window.removeEventListener('pointerup', onUp),
      () => canvas.removeEventListener('dblclick', onDbl, { capture: true }),
      () => document.removeEventListener('keydown', onKey, { capture: true }),
    );
  }
}

/** Context-menu label of Delete: blocks, plus the planner items of a mixed (marquee) selection (8.11a). */
function deleteLabel(blocks: number, blockId: string, others: number): string {
  const b = blocks > 1 ? `${blocks} blocks` : blockId;
  return others > 0 ? `Delete ${b} + ${others} item${others === 1 ? '' : 's'}` : `Delete ${b}`;
}

function samplePositions(specs: readonly PathSegmentSpec[]): number[] {
  const out: number[] = [];
  const push = (p: Vec3Tuple, q: Vec3Tuple): void => {
    out.push(p[0], p[1] + LINE_Y_LIFT, p[2], q[0], q[1] + LINE_Y_LIFT, q[2]);
  };
  for (const s of specs) {
    if (s.kind === 'line') push(s.from as Vec3Tuple, s.to as Vec3Tuple);
    else {
      const steps = 24;
      let prev = arcPointAt(s, 0);
      for (let i = 1; i <= steps; i++) {
        const cur = arcPointAt(s, i / steps);
        push(prev, cur);
        prev = cur;
      }
    }
  }
  return out;
}

function r4(v: number): number {
  return Math.round(v * 1e4) / 1e4;
}

/** The candidate set the drag currently uses (8.8). */
function moveSetOf(d: Extract<DragState, { kind: 'move' }>): MoveSet {
  return d.useChain ? d.chain : d.single;
}

/** World matrix of a rigid XZ motion (rotate about the pivot by the heading change, then translate); `tmp` is scratch. */
function rigidMatrix(m: RigidXZ, out: Matrix4, tmp: Matrix4): Matrix4 {
  // heading +h = rotation about Y by −h (heading = atan2(z, x)).
  out.makeTranslation(m.pivot[0] + m.dx, 0, m.pivot[1] + m.dz);
  tmp.makeRotationY(-m.dHeadingDeg * Math.PI / 180);
  out.multiply(tmp);
  tmp.makeTranslation(-m.pivot[0], 0, -m.pivot[1]);
  return out.multiply(tmp);
}

