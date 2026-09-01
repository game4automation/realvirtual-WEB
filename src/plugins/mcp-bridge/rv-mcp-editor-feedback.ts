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
import { parsePathsParam } from './rv-object-analyzer-math';

type Rec = Record<string, unknown>;
type FeedbackPanel = 'kinematics' | 'materials';

interface FeedbackSpec {
  /** Paths the tool acted on. Default: args.path as single, else parse args.paths. */
  paths?: (args: Rec, result: Rec) => string[];
  /** Select the resolved paths (default true when paths resolve non-empty). */
  select?: boolean;
  /** Clear the selection instead (delete). */
  clearSelection?: boolean;
  /** Frame the camera on the paths — only when offscreen, throttled. */
  frame?: boolean;
  /** Auto-open this panel on the right dock when it is closed. */
  panel?: FeedbackPanel;
  /** Simulate a human click on this Quick Edit / Materials button BEFORE the
   *  tool executes (see button-sim-store ids). */
  buttonId?: string | ((args: Rec) => string | null);
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

function importRootPaths(_args: Rec, result: Rec): string[] {
  if (Array.isArray(result['rootPaths'])) {
    return (result['rootPaths'] as unknown[]).filter((p): p is string => typeof p === 'string');
  }
  return typeof result['rootPath'] === 'string' ? [result['rootPath'] as string] : [];
}

// ─── The feedback table ─────────────────────────────────────────────────

export const EDITOR_FEEDBACK: Record<string, FeedbackSpec> = {
  // Transform / pivot — frame when offscreen.
  web_editor_transform: { frame: true, panel: 'kinematics' },
  web_editor_zero_position: { frame: true, panel: 'kinematics', buttonId: 'qe.zero-position' },
  web_editor_rotate90: {
    frame: true, panel: 'kinematics',
    buttonId: (a) => `qe.rotate-${String(a['axis'] ?? '').toLowerCase()}`,
  },
  web_editor_to_ground: { frame: true, panel: 'kinematics', buttonId: 'qe.to-ground' },
  web_editor_pivot: {
    frame: true, panel: 'kinematics',
    buttonId: (a) => ({
      bottom: 'qe.pivot-bottom',
      align_y_up: 'qe.align-y-up',
      object_center: 'qe.pivot-to-object',
    } as Record<string, string>)[String(a['mode'] ?? '').toLowerCase()] ?? null,
  },

  // Structure
  web_editor_rename: { paths: resultPath, panel: 'kinematics' },
  web_editor_delete: { clearSelection: true, panel: 'kinematics' },
  web_editor_set_visible: { panel: 'kinematics' },
  web_editor_create_empty: {
    paths: resultPath, panel: 'kinematics',
    buttonId: (a) => (typeof a['parentPath'] === 'string' && a['parentPath'] ? 'qe.empty-child' : 'qe.empty-root'),
  },
  web_editor_reparent: { frame: true, panel: 'kinematics' },

  // Components / kinematics
  web_editor_add_component: {
    panel: 'kinematics',
    buttonId: (a) => (typeof a['type'] === 'string' && a['type'] ? `qe.add-${(a['type'] as string).toLowerCase()}` : null),
  },
  web_editor_remove_component: { panel: 'kinematics' },
  web_editor_set_field: { panel: 'kinematics' },
  web_editor_create_kinematic: {
    paths: resultKinematicPath, frame: true, panel: 'kinematics', buttonId: 'qe.add-kinematic',
  },
  web_editor_assign_to_kinematic: { paths: resultKinematicPath, frame: true, panel: 'kinematics' },
  web_editor_kinematize: { paths: resultKinematicPath, frame: true, panel: 'kinematics' },

  // Signals / logic — the create actions select the new node themselves.
  web_editor_add_signal: { paths: resultPath, panel: 'kinematics' },
  web_editor_convert_signal: { panel: 'kinematics' },
  web_editor_toggle_signal_direction: { panel: 'kinematics' },
  web_editor_add_logic_step: { paths: resultPath, panel: 'kinematics' },

  // Materials
  web_editor_material_presets: { select: false, panel: 'materials' },
  web_editor_material_stats: { select: false, panel: 'materials' },
  web_editor_assign_material: {
    paths: materialPaths, panel: 'materials',
    buttonId: (a) => (typeof a['presetId'] === 'string' && a['presetId'] ? `mat.preset-${a['presetId']}` : 'mat.assign'),
  },
  web_editor_materialize: { paths: materializeSamplePaths, select: false, panel: 'materials' },

  // Imports
  web_editor_import_glb: { paths: importRootPaths, frame: true, panel: 'kinematics' },
  web_editor_import_cad: { paths: importRootPaths, frame: true, panel: 'kinematics' },

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
  web_component_set: { panel: undefined },

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
): Promise<void> {
  try {
    const spec = EDITOR_FEEDBACK[tool];
    if (!spec) return;

    // Pre-selection from ARG paths only (result-addressed paths select post).
    if (!spec.clearSelection && spec.select !== false) {
      const paths = (spec.paths ?? defaultPaths)(args, {})
        .filter((p) => !!viewer.registry?.getNode(p));
      if (paths.length > 0 && !selectionAlreadyIs(viewer, paths)) {
        viewer.selectionManager.selectPaths(paths);
      }
    }

    ensurePanelOpen(viewer, spec);

    if (spec.buttonId) {
      const id = typeof spec.buttonId === 'function' ? spec.buttonId(args) : spec.buttonId;
      if (id) {
        // A HIDDEN tab has no one watching this, and Chrome clamps setTimeout
        // there to >=1 s (up to 60 s once heavily throttled) — so the 80 ms
        // "beat" below silently becomes the reason the whole tool call blows
        // through the bridge's 15 s timeout and reports outcome=unknown.
        // Cosmetic feedback must never be the thing that fails the edit: skip
        // the click choreography while hidden and let the tool do its work.
        if (typeof document !== 'undefined' && document.hidden) return;
        // A just-opened panel needs a beat to render its buttons.
        await sleep(80);
        await simulateButtonClick(id);
      }
    }
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

    const paths = (spec.paths ?? defaultPaths)(args, result)
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

    // Camera framing (offscreen check + throttle).
    if (spec.frame && paths.length > 0) {
      const nodes = paths
        .map((p) => viewer.registry?.getNode(p) ?? null)
        .filter((n): n is Object3D => n !== null);
      frameIfHelpful(viewer, nodes);
    }
  } catch {
    // Feedback must never break the tool call.
  }
}
