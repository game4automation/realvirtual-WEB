// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-mcp-editor-feedback — visual feedback for the web_editor_* MCP tools.
 *
 * Makes remote agent edits look like a person driving the UI. BEFORE a tool
 * executes, the bridge dispatcher runs {@link prepareEditorChoreography}:
 * select the acted-on nodes (as a user would click them first), auto-open the
 * owning panel, then simulate a real click on the equivalent Quick Edit /
 * Materials button — hover, press, release (button-sim-store) — so the edit
 * lands exactly at the release. AFTER the tool succeeds,
 * {@link applyEditorFeedback} finishes up: select result-addressed nodes and
 * frame the camera when the target is offscreen. No pulsing highlights.
 *
 * plan-520 "Follow agent": entries with `follow` fly the camera to the target
 * while the user leaves the viewport alone (rv-mcp-follow-policy.ts) - `'pre'`
 * before the write for arg-addressed targets, `'post'` after it for
 * result-addressed ones. The old offscreen framing runs only when the follow
 * policy answers `'fallback'` (switched off, or the user is active).
 *
 * Policy lives in ONE table (EDITOR_FEEDBACK) instead of 30 tool bodies.
 * web_editor_verify_drive keeps its own richer choreography by simply not
 * being listed here. Feedback never throws.
 *
 * Loaded via dynamic import from McpBridgePlugin so the asset-editor stores it
 * touches stay out of the eager bundle (same discipline as the editor tools'
 * lazy _load()).
 */

import { Box3, Vector3 } from 'three';
import type { Object3D } from 'three';
import type { RVViewer } from '../../core/rv-viewer';
import { computeSubtreeAABB } from '../../core/engine/rv-traverse-utils';
import {
  getStoredKinematicsPanelWidth,
  getStoredMaterialsPanelWidth,
} from '../../core/hmi/layout-constants';
import { simulateButtonClick } from '@rv-private/plugins/asset-editor/button-sim-store';
import { expandMechanismRow } from '../../core/hmi/mechanism-command-descriptors';
import { inspectorFieldKey, requestInspectorFieldReveal } from '../../core/hmi/inspector-field-touch';
import { touchAfterglow } from '../../core/hmi/button-sim-state';
import { getActiveContexts, isUIElementVisible } from '../../core/hmi/ui-context-store';
import type { RvExtrasEditorPlugin } from '../../core/hmi/rv-extras-editor';
import { isCompactWidth } from '../../hooks/use-mobile-layout';
import { parsePathsParam } from './rv-object-analyzer-math';
import { followAgent, type FollowDecision } from './rv-mcp-follow-policy';

type Rec = Record<string, unknown>;
type FeedbackPanel = 'kinematics' | 'materials';

/** The Inspector fields a field-write tool addresses (one node, one component). */
interface FieldTarget {
  path: string;
  componentType: string;
  fields: string[];
}

interface FeedbackSpec {
  /** Paths the tool acted on. Default: args.path as single, else parse args.paths.
   *  `viewer` lets an extractor resolve names (drives) - the others ignore it. */
  paths?: (args: Rec, result: Rec, viewer?: RVViewer) => string[];
  /**
   * plan-520 "Follow agent": fly the camera to the target while the user is
   * idle. `'pre'` = arg-addressed target, followed BEFORE the write so the user
   * sees the change happen; `'post'` = result-addressed target (it only exists
   * or is only known after the write).
   */
  follow?: 'pre' | 'post';
  /** Select the resolved paths (default true when paths resolve non-empty). */
  select?: boolean;
  /** Clear the selection instead (delete). */
  clearSelection?: boolean;
  /** Frame the camera on the paths — only when offscreen, throttled. */
  frame?: boolean;
  /** Auto-open this panel on the right dock when it is closed. */
  panel?: FeedbackPanel;
  /**
   * Field-write tools: open the Property Inspector on the node, reveal the
   * field row, and let the choreography hover/press THAT row (it carries
   * `data-rv-button-id` = {@link inspectorFieldKey}) — the row is the button.
   */
  field?: (args: Rec) => FieldTarget | null;
  // plan-499: no `buttonId` any more — the button a call presses is the bound
  // command's `buttonKey`, resolved once per call by the bridge (McpCallContext).
}

// ─── Path extractors ────────────────────────────────────────────────────

function defaultPaths(args: Rec): string[] {
  if (typeof args['path'] === 'string' && args['path']) return [args['path'] as string];
  if (typeof args['paths'] === 'string') return parsePathsParam(args['paths'] as string);
  return [];
}

function resultPath(_args: Rec, result: Rec): string[] {
  return typeof result['path'] === 'string' && result['path'] ? [result['path'] as string] : [];
}

function resultKinematicPath(_args: Rec, result: Rec): string[] {
  const p = result['kinematicPath'];
  return typeof p === 'string' && p ? [p] : [];
}

/** assign_material: explicit paths, else whatever is selected (the tool's own fallback). */
function materialPaths(args: Rec): string[] {
  return defaultPaths(args);
}

/** materialize: the samplePath anchors of the assigned appearance groups. */
function materializeSamplePaths(args: Rec): string[] {
  try {
    const parsed = JSON.parse((args['assignmentsJson'] as string) ?? '');
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((a: Rec) => (typeof a['samplePath'] === 'string' ? (a['samplePath'] as string) : null))
      .filter((p): p is string => !!p);
  } catch {
    return [];
  }
}

/** statics addresses the MECHANISM, not a node path arg. */
function mechanismPathArg(args: Rec): string[] {
  return typeof args['mechanismPath'] === 'string' && args['mechanismPath'] ? [args['mechanismPath'] as string] : [];
}

/** web_drive_jog / web_drive_stop: the runtime drive named by `args.name` (first match). */
function drivePaths(args: Rec, _result: Rec, viewer?: RVViewer): string[] {
  const name = args['name'];
  if (typeof name !== 'string' || !name || !viewer) return [];
  const drive = viewer.drives?.find((d) => d.name === name);
  if (!drive) return [];
  const path = viewer.registry?.getPathForNode(drive.node);
  return path ? [path] : [];
}

function importRootPaths(_args: Rec, result: Rec): string[] {
  if (Array.isArray(result['rootPaths'])) {
    return (result['rootPaths'] as unknown[]).filter((p): p is string => typeof p === 'string');
  }
  return typeof result['rootPath'] === 'string' ? [result['rootPath'] as string] : [];
}

/** web_editor_set_field: path + componentType + fieldName. */
function setFieldTarget(args: Rec): FieldTarget | null {
  const { path, componentType, fieldName } = args;
  if (typeof path !== 'string' || !path || typeof componentType !== 'string' || typeof fieldName !== 'string') return null;
  return { path, componentType, fields: [fieldName] };
}

/** web_component_set: path + type + the keys of the props JSON object. */
function componentSetTarget(args: Rec): FieldTarget | null {
  const { path, type, props } = args;
  if (typeof path !== 'string' || !path || typeof type !== 'string' || typeof props !== 'string') return null;
  try {
    const parsed = JSON.parse(props);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const fields = Object.keys(parsed as Rec);
    return fields.length > 0 ? { path, componentType: type, fields } : null;
  } catch {
    return null;
  }
}

// ─── The feedback table ─────────────────────────────────────────────────

export const EDITOR_FEEDBACK: Record<string, FeedbackSpec> = {
  // Transform / pivot — frame when offscreen.
  // `follow` (plan-520): node writes follow with the camera; web_editor_delete
  // (the target is gone) and web_editor_set_visible (it may be hidden) do not.
  web_editor_transform: { frame: true, panel: 'kinematics', follow: 'pre' },
  web_editor_zero_position: { frame: true, panel: 'kinematics', follow: 'pre' },
  web_editor_rotate90: { frame: true, panel: 'kinematics', follow: 'pre' },
  web_editor_to_ground: { frame: true, panel: 'kinematics', follow: 'pre' },
  web_editor_pivot: { frame: true, panel: 'kinematics', follow: 'pre' },

  // Structure
  web_editor_rename: { paths: resultPath, panel: 'kinematics', follow: 'post' },
  web_editor_delete: { clearSelection: true, panel: 'kinematics' },
  web_editor_set_visible: { panel: 'kinematics' },
  web_editor_create_empty: { paths: resultPath, panel: 'kinematics', follow: 'post' },
  web_editor_reparent: { frame: true, panel: 'kinematics', follow: 'pre' },

  // Components / kinematics
  web_editor_add_component: { panel: 'kinematics', follow: 'pre' },
  web_editor_remove_component: { panel: 'kinematics', follow: 'pre' },
  // Field writes act in the Property Inspector (no Quick Edit panel — opening
  // a right-dock panel would close the hierarchy the docked inspector needs).
  web_editor_set_field: { field: setFieldTarget, follow: 'pre' },
  web_editor_create_kinematic: { paths: resultKinematicPath, frame: true, panel: 'kinematics', follow: 'post' },
  web_editor_assign_to_kinematic: { paths: resultKinematicPath, frame: true, panel: 'kinematics', follow: 'post' },
  web_editor_kinematize: { paths: resultKinematicPath, frame: true, panel: 'kinematics', follow: 'post' },

  // Signals / logic — the create actions select the new node themselves.
  web_editor_add_signal: { paths: resultPath, panel: 'kinematics' },
  web_editor_convert_signal: { panel: 'kinematics' },
  web_editor_toggle_signal_direction: { panel: 'kinematics' },
  web_editor_add_logic_step: { paths: resultPath, panel: 'kinematics' },

  // Materials
  web_editor_material_presets: { select: false, panel: 'materials' },
  web_editor_material_stats: { select: false, panel: 'materials' },
  web_editor_assign_material: { paths: materialPaths, panel: 'materials', follow: 'pre' },
  web_editor_materialize: { paths: materializeSamplePaths, select: false, panel: 'materials' },

  // Rigid-body mechanisms (plan-504) — the 11 tools that are views of the
  // `mechanism.*` commands. PRE selects the addressed node, POST frames it when
  // it is offscreen; before the press the choreography opens the Mechanism
  // section and the row that owns the path (`expandMechanismRow`), because the
  // section starts collapsed and its rows render their buttons only expanded.
  // The two controls (density select, jog slider) carry no `data-rv-button-id`,
  // so they get no hover/press — only the afterglow.
  web_editor_mechanism_create: { frame: true, panel: 'kinematics', follow: 'pre' },
  web_editor_mechanism_add_joint: { frame: true, panel: 'kinematics', follow: 'pre' },
  web_editor_mechanism_assign_drive: { frame: true, panel: 'kinematics', follow: 'pre' },
  web_editor_mechanism_jog: { panel: 'kinematics', follow: 'pre' },
  web_editor_mechanism_set_anchor_snap: { frame: true, panel: 'kinematics', follow: 'pre' },
  web_editor_mechanism_set_axis: { frame: true, panel: 'kinematics', follow: 'pre' },
  web_editor_mechanism_add_body: { frame: true, panel: 'kinematics', follow: 'pre' },
  web_editor_mechanism_set_mass: { frame: true, panel: 'kinematics', follow: 'pre' },
  web_editor_mechanism_set_limits: { frame: true, panel: 'kinematics', follow: 'pre' },
  web_editor_mechanism_statics: { paths: mechanismPathArg, frame: true, panel: 'kinematics', follow: 'pre' },
  web_editor_mechanism_fix: { frame: true, panel: 'kinematics', follow: 'pre' },

  // Imports
  web_editor_import_glb: { paths: importRootPaths, frame: true, panel: 'kinematics', follow: 'post' },
  web_editor_import_cad: { paths: importRootPaths, frame: true, panel: 'kinematics', follow: 'post' },

  // ─── Scene domains (plan-713 Phase 3) ────────────────────────────────
  //
  // Same table, same mechanism, no new machinery — which is the whole point of
  // extending it rather than writing a planner equivalent. `applyEditorFeedback`
  // was never editor-gated: it resolves paths through `viewer.registry` and
  // no-ops when they do not resolve, so an entry is simply inert in a mode where
  // its tool cannot be called.
  //
  // What these entries do NOT get is `panel`. The two panels the table knows
  // (`kinematics`, `materials`) are the asset editor's right dock; opening one
  // from planner mode would be feedback pointing at a surface that is not there.
  //
  // The layout verbs are absent for a concrete reason rather than an oversight:
  // `web_layout_place` / `_move` / `_snap_attach` answer with a PLACEMENT id,
  // not a node path, and every extractor here resolves through the node
  // registry. Selecting and framing a placement needs a placement→path
  // resolution the planner does not currently expose; adding a half-working
  // extractor that silently returns nothing would look like feedback and be
  // none.
  web_component_set: { field: componentSetTarget, follow: 'pre' },

  // Runtime drives (plan-520): the bound `drive.jog` / `drive.stop` tools select
  // the drive and follow it. No `panel` (the right dock is the asset editor's);
  // the button press stays the bound command's `buttonKey`.
  web_drive_jog: { paths: drivePaths, follow: 'pre' },
  web_drive_stop: { paths: drivePaths, follow: 'pre' },

  // Deliberately absent: web_editor_verify_drive (own choreography),
  // open/close/status/save/undo/redo/shortcut/list_kinematics (no spatial target
  // or they manage selection themselves), web_editor_descend / _back (they
  // REPLACE the document and the stack drives its own isolation and camera —
  // selecting or framing afterwards would fight it).
};

// ─── Camera framing (anti-spam) ─────────────────────────────────────────

const FRAME_THROTTLE_MS = 4000;
let lastFrameMoveAt = -Infinity; // -Infinity: the first frame is never throttled
let now: () => number = () => Date.now();

/** Test hook: inject a clock and reset the throttle window. */
export function _resetFrameThrottleForTest(clock?: () => number): void {
  lastFrameMoveAt = -Infinity;
  now = clock ?? (() => Date.now());
}

/** True when the point projects inside the central NDC window of the camera. */
function isOnScreen(viewer: RVViewer, worldPoint: Vector3): boolean {
  const cam = viewer.camera;
  cam.updateMatrixWorld();
  const p = worldPoint.clone().project(cam);
  return p.z > -1 && p.z < 1 && Math.abs(p.x) <= 0.85 && Math.abs(p.y) <= 0.85;
}

/** Frame `nodes` only when their bounds center is offscreen, and at most once
 *  per throttle window — rapid tool loops must not bounce the camera. */
function frameIfHelpful(viewer: RVViewer, nodes: Object3D[]): void {
  if (nodes.length === 0) return;
  const union = new Box3().makeEmpty();
  for (const n of nodes) {
    n.updateMatrixWorld(true);
    union.union(computeSubtreeAABB(n, new Box3()).box);
  }
  if (union.isEmpty()) return;
  const center = union.getCenter(new Vector3());
  if (isOnScreen(viewer, center)) return;
  const t = now();
  if (t - lastFrameMoveAt < FRAME_THROTTLE_MS) return;
  lastFrameMoveAt = t;
  viewer.fitToNodes(nodes, undefined, { duration: 0.7, easing: 'easeInOut' });
}

// ─── Entry point ────────────────────────────────────────────────────────

/** Same-set compare of the desired selection against the current one, so
 *  rapid set_field loops don't re-fire selection-changed every call. */
function selectionAlreadyIs(viewer: RVViewer, paths: string[]): boolean {
  const current = viewer.selectionManager.getSnapshot().selectedPaths;
  if (current.length !== paths.length) return false;
  const set = new Set(current);
  return paths.every((p) => set.has(p));
}

/** Open the spec's owning panel when it is closed (shared pre/post helper). */
function ensurePanelOpen(viewer: RVViewer, spec: FeedbackSpec): void {
  if (spec.panel && !viewer.leftPanelManager.isOpen(spec.panel)) {
    const width = spec.panel === 'materials'
      ? getStoredMaterialsPanelWidth()
      : getStoredKinematicsPanelWidth();
    viewer.leftPanelManager.open(spec.panel, width, 'right');
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** How long the reveal waits for the field row to render (inspector mount + section expand). */
const FIELD_REVEAL_WAIT_MS = 600;

/**
 * Open the Property Inspector on the target node and make the field row
 * visible, like a user who selects the object and scrolls to the field before
 * typing. Resolves when the row is in the DOM (or after a short wait — a field
 * with a custom renderer, a filtered "more fields" block or viewer mode simply
 * has no row, and the write then goes ahead without the click). Returns the
 * key of the row to press, or null when there is nothing on screen to press.
 */
async function revealInspectorField(viewer: RVViewer, target: FieldTarget): Promise<string | null> {
  if (typeof document === 'undefined' || document.hidden) return null;
  // The inspector is hidden in viewer mode and replaced by a sheet on mobile.
  if (!isUIElementVisible('property-inspector', getActiveContexts())) return null;
  if (typeof window !== 'undefined' && isCompactWidth(window.innerWidth)) return null;
  if (!viewer.registry?.getNode(target.path)) return null;
  const editor = viewer.getPlugin<RvExtrasEditorPlugin>('rv-extras-editor');
  if (!editor) return null;

  const snap = editor.getSnapshot();
  const detached = localStorage.getItem('rv-inspector-detached') === 'true';
  const onScreen = snap.showInspector && snap.selectedNodePath === target.path && (detached || snap.panelOpen);
  if (!onScreen) {
    // Docked inspector needs the hierarchy: selectAndReveal opens it and
    // scrolls the tree to the node — the "user found the object" beat.
    if (detached || snap.panelOpen) editor.selectNode(target.path, true);
    else editor.selectAndReveal(target.path, true);
  }

  const field = target.fields[0];
  requestInspectorFieldReveal(target.path, target.componentType, field);
  const key = inspectorFieldKey(target.path, target.componentType, field);
  const selector = `[data-rv-button-id="${CSS.escape(key)}"]`;
  const until = Date.now() + FIELD_REVEAL_WAIT_MS;
  while (Date.now() < until) {
    if (document.querySelector(selector)) return key;
    await sleep(30);
  }
  return null;
}

/**
 * The human-like PRE-execution choreography: select the arg-addressed nodes
 * (a user clicks the object first), open the owning panel, then simulate a
 * real click on the equivalent button — hover, press, release. Resolves at
 * the release, so the dispatcher executes the actual edit exactly when a
 * real click would have fired. Never throws; resolves immediately for tools
 * without a spec or button.
 */
export async function prepareEditorChoreography(
  viewer: RVViewer,
  tool: string,
  args: Rec,
  /** plan-499: the button to press — the bound command's key from the call context.
   *  Absent: no click simulation (selection + panel only). The bridge calls this
   *  only after the preflight accepted the call. */
  buttonKey?: string,
): Promise<FollowDecision | undefined> {
  // plan-520: the pre-follow verdict, handed to applyEditorFeedback so the old
  // offscreen framing does not run a second time after a follow decision.
  let decision: FollowDecision | undefined;
  try {
    const spec = EDITOR_FEEDBACK[tool];
    if (!spec) return undefined;

    // Pre-selection from ARG paths only (result-addressed paths select post).
    const argPaths = (spec.paths ?? defaultPaths)(args, {}, viewer)
      .filter((p) => !!viewer.registry?.getNode(p));
    if (!spec.clearSelection && spec.select !== false) {
      if (argPaths.length > 0 && !selectionAlreadyIs(viewer, argPaths)) {
        viewer.selectionManager.selectPaths(argPaths);
      }
    }

    // plan-520: follow the arg-addressed target BEFORE the write, so the user
    // sees the change happen. Independent of the Inspector reveal below (viewer
    // mode / compact width: camera + selection only).
    if (spec.follow === 'pre' && argPaths.length > 0) {
      decision = followAgent(viewer, argPaths);
    }

    ensurePanelOpen(viewer, spec);

    // plan-504: a mechanism button lives inside a collapsible section and a
    // collapsible mechanism row — open both BEFORE the beat below, so the
    // button the press targets is rendered by the time it is looked up.
    if (tool.startsWith('web_editor_mechanism_')) {
      const target = (spec.paths ?? defaultPaths)(args, {}, viewer)[0];
      if (target) expandMechanismRow(target);
    }

    // Field writes: open the inspector on the field; an unbound tool
    // (web_component_set) presses the first field's row itself.
    let id = buttonKey;
    if (spec.field) {
      const target = spec.field(args);
      const rowKey = target ? await revealInspectorField(viewer, target) : null;
      if (!rowKey) return decision;
      id = id ?? rowKey;
    }
    {
      if (id) {
        // A HIDDEN tab has no one watching this, and Chrome clamps setTimeout
        // there to >=1 s (up to 60 s once heavily throttled) — so the 80 ms
        // "beat" below silently becomes the reason the whole tool call blows
        // through the bridge's 15 s timeout and reports outcome=unknown.
        // Cosmetic feedback must never be the thing that fails the edit: skip
        // the click choreography while hidden and let the tool do its work.
        if (typeof document !== 'undefined' && document.hidden) return decision;
        // A just-opened panel needs a beat to render its buttons.
        await sleep(80);
        await simulateButtonClick(id);
      }
    }
  } catch {
    // Choreography must never break the tool call.
  }
  return decision;
}

/**
 * plan-499 Phase 3: the click choreography for a bound NON-editor tool (planner
 * Delete, sim segments, library entry, inspector actions). No selection and no
 * panel spec — those tools address ids, not the editor selection. Presses the
 * button only while it is on screen and the tab is visible (the same hidden-tab
 * rule as above); the bridge calls this only after the preflight accepted.
 */
export async function prepareCommandChoreography(buttonKey: string): Promise<void> {
  try {
    if (!buttonKey) return;
    if (typeof document !== 'undefined' && document.hidden) return;
    await simulateButtonClick(buttonKey);
  } catch {
    // Choreography must never break the tool call.
  }
}

/**
 * Apply the visual feedback for a successfully completed editor tool call.
 * Called by McpBridgePlugin after the result is computed. Never throws.
 */
export function applyEditorFeedback(
  viewer: RVViewer,
  tool: string,
  args: Rec,
  resultJson: string,
  /** plan-520: the verdict of this call's pre-follow (from prepareEditorChoreography). */
  preDecision?: FollowDecision,
): void {
  try {
    const spec = EDITOR_FEEDBACK[tool];
    if (!spec) return;

    let result: Rec = {};
    try {
      const parsed = JSON.parse(resultJson);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) result = parsed as Rec;
    } catch { /* non-JSON results (images) keep an empty result object */ }
    if (typeof result['error'] === 'string') return; // no feedback on failure

    const paths = (spec.paths ?? defaultPaths)(args, result, viewer)
      .filter((p) => !!viewer.registry?.getNode(p));

    // Selection — act like a user click on the objects.
    if (spec.clearSelection) {
      viewer.selectionManager.clear();
    } else if (spec.select !== false && paths.length > 0 && !selectionAlreadyIs(viewer, paths)) {
      viewer.selectionManager.selectPaths(paths);
    }

    // Panel — normally opened by the pre-choreography; kept for tools whose
    // feedback runs post-only (result-addressed paths).
    ensurePanelOpen(viewer, spec);

    // Afterglow on the written Inspector rows. A BOUND field write
    // (web_editor_set_field) already gets it from the command listener; an
    // unbound one (web_component_set) glows every field it applied.
    if (spec.field && tool === 'web_component_set') {
      const target = spec.field(args);
      const applied = result['applied'];
      if (target && applied && typeof applied === 'object') {
        for (const f of Object.keys(applied as Rec)) {
          touchAfterglow(inspectorFieldKey(target.path, target.componentType, f), tool);
        }
      }
    }

    // plan-520: follow a result-addressed target after the write.
    let decision = preDecision;
    if (spec.follow === 'post' && paths.length > 0) decision = followAgent(viewer, paths);

    // Camera framing (offscreen check + throttle) - only when follow did not
    // take this call (switched off, user active, or no follow entry at all).
    if (spec.frame && paths.length > 0 && (decision === undefined || decision === 'fallback')) {
      const nodes = paths
        .map((p) => viewer.registry?.getNode(p) ?? null)
        .filter((n): n is Object3D => n !== null);
      frameIfHelpful(viewer, nodes);
    }
  } catch {
    // Feedback must never break the tool call.
  }
}
