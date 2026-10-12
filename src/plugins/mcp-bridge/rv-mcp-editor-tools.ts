// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-mcp-editor-tools — MCP authoring tools for the ASSET EDITOR.
 *
 * Delegate class of McpBridgePlugin (multi-instance dispatcher). Every tool
 * here calls the SAME exported action functions the Quick Edit / Materials
 * panels' buttons call, against the same op-logged AssetDocument — so remote
 * agent edits are undoable, visible live in the panels, and land in the saved
 * GLB exactly like human edits.
 *
 * Asset-editor action modules are loaded via dynamic import (cached) — the
 * editor plugin is a lazy chunk (main.ts) and these tools must not fold it
 * into the eager bundle.
 *
 * Every authoring tool starts with `requireEditor` and returns a uniform
 * "Not in editor mode" error outside editor mode.
 */

import { Box3, Euler, Quaternion, Vector3 } from 'three';
import type { BufferGeometry, Mesh, Object3D } from 'three';
import type { RVViewer } from '../../core/rv-viewer';
import { McpTool, McpParam } from '../../core/engine/rv-mcp-tools';
import { getSchemaDefaults, getTypesWithCapability } from '../../core/engine/rv-component-registry';
import { computeSubtreeAABB } from '../../core/engine/rv-traverse-utils';
import { getDriveDragDriver } from '../../core/engine/drive-drag-driver';
import { NodeRegistry } from '../../core/engine/rv-node-registry';
import { isModelRoot } from '../../core/engine/rv-model-root';
import { computeMaterialStats } from '@rv-private/plugins/asset-editor/materials/material-stats';
import {
  indexMeshPathsByMaterialValue,
  materialToValue,
  materialValueKey,
} from '../../core/editor/rv-asset-material';
import type { MaterialValue, NodeTransform } from '../../core/editor/rv-asset-ops';
import type { ActiveAssetContext } from '../../core/editor/active-asset-store';
// plan-713 F10 — the descend chain rides on the core view seam, not on the
// private plugin's RvDocumentStack (see `_breadcrumbFields`).
import { getActiveDocumentView } from '../../core/editor/active-document-view';
import { documentBase, libraryDocumentBase } from '../../core/editor/active-asset-store';
import { resolveEditorOpenDocument } from './rv-mcp-editor-open-resolve';
import { ERR_DOCUMENT_LOCKED } from '../../core/editor/rv-asset-document';
import type { AssetBase } from '../../core/editor/rv-asset-document';
// Type-only: the module itself is dynamically imported inside the mechanism
// tools so the asset-editor chunk stays lazy (see the module header).
import type { MechanismOpPlan } from '@rv-private/plugins/asset-editor/mechanism/mechanism-authoring';
import type { MechanismUiBridge } from '../../core/engine/rv-kinematic-registry';
import type { DownsampledSeries } from '@rv-private/plugins/asset-editor/mechanism/mechanism-force-downsample';
import {
  DEFAULT_WELD_THRESHOLD,
  REASON_MULTI_MATERIAL,
  REASON_SINGLE_PART,
  groupModeIneligibility,
  unsupportedMeshShapeReason,
  type SeparateMode,
} from '../../core/editor/rv-mesh-separator';
// plan-589: the command id, bound by constant (same convention as the group verbs).
import {
  SIGNAL_RENAME_COMMAND,
  SIGNAL_RENAME_RECHECK_COMMAND,
  SIGNAL_RENAME_REPAIR_COMMAND,
  SIGNALS_CREATE_FROM_INTERFACE_COMMAND,
} from '../../core/hmi/problems-store';
import { requireEditor, isGuardError } from './rv-mcp-editor-guard';
import { parsePathsParam } from './rv-object-analyzer-math';
import { canvasToRvImage, compositeMontage } from './rv-frame-capture';
// plan-740 P3.5: the verify montage is rendered through the AGENT camera on the
// shared capture chain — the drive still moves for real, only the picture of it
// stopped being whatever the human's canvas happened to show.
import {
  guardAgentCapture, renderAgentChannels, serializeEyeCapture,
} from './rv-mcp-observe-tools';
import { arrayBufferOf } from '../../core/project/rv-scene-record';
import { buildMeshUniverse } from './rv-mcp-view-tools';
import {
  ensureEditorCommandsRegistered,
  ASSIGN_TO_KINEMATIC_BINDING,
  GROUP_ASSIGN_COMMAND,
  GROUP_DISSOLVE_COMMAND,
  GROUP_REMOVE_COMMAND,
  GROUP_RENAME_COMMAND,
  ERR_TEST_RUN_ACTIVE,
  MODEL_ROOT_LOCKED,
  PIVOT_BINDING,
  SHORTCUT_BINDING,
  normalizeShortcutKeys,
} from '../../core/hmi/editor-command-descriptors';
import {
  ensureMechanismCommandsRegistered,
  mechanismForcesJson,
  MECHANISM_UNAVAILABLE,
} from '../../core/hmi/mechanism-command-descriptors';
import { commandRegistry } from '../../core/hmi/rv-command-registry';
import {
  bindStandalone,
  commandErrorJson,
  dispatchBoundCommand,
  type McpCallContext,
} from '../../core/hmi/rv-command-context';

const r3 = (n: number): number => +n.toFixed(3);

// MODEL_ROOT_LOCKED lives with the command descriptors since plan-499 (one text
// for the command refusal and the remaining direct tools).

/** Kinematic component keys in rv_extras, tolerant of the `_N` dedup suffix. */
const KINEMATIC_KEY_RE = /^Kinematic(_\d+)?$/;
const DRIVE_KEY_RE = /^Drive(_\d+)?$/;
/** KinematicMechanism container keys (the plan-729/501 tools check the mechanism node). */
const MECHANISM_KEY_RE = /^KinematicMechanism(_\d+)?$/;
/** plan-729 — MechanismPath / MechanismTarget keys, tolerant of the `_N` suffix. */
const MECHANISM_PATH_KEY_RE = /^MechanismPath(_\d+)?$/;
const MECHANISM_TARGET_KEY_RE = /^MechanismTarget(_\d+)?$/;
/** plan-501 — MechanismTrajectory keys, tolerant of the `_N` suffix. */
const MECHANISM_TRAJECTORY_KEY_RE = /^MechanismTrajectory(_\d+)?$/;

// MECHANISM_UNAVAILABLE lives with the mechanism command descriptors since plan-504
// (one text for the command refusals and the remaining direct mechanism tools).

/**
 * Narrow the `_requireMechanismBridge` union. Deliberately NOT `isGuardError`:
 * that one is typed for the editor-mode guard's own union, and widening it would
 * make an unrelated module the home of every "or an error" shape in the bridge.
 */
function isMechError(r: MechanismUiBridge | { error: string }): r is { error: string } {
  return 'error' in r;
}

/**
 * Upper bound on the force time series `web_editor_mechanism_forces` hands out.
 *
 * The recorder's ring buffer holds 3000 samples — ~60 kB of JSON per channel,
 * which breaks the answer-size budget for one tool call. 200 points cost ~2 kB
 * and still carry a duty cycle, which is the whole reason a series is requested
 * next to peak and RMS. The reduction preserves the extremes
 * (`mechanism-force-downsample.ts`), so the cap costs resolution, never the peak.
 */
const SERIES_MAX_POINTS = 200;

/** Recorder sampling rate, mirrored so the forces tool needs no eager import. */
const FORCE_SAMPLE_RATE_HZ = 10;

const DRIVE_DIRECTIONS = ['LinearX', 'LinearY', 'LinearZ', 'RotationX', 'RotationY', 'RotationZ'];

/** rv_extras of a node ({} when absent). */
function rvOf(node: Object3D): Record<string, unknown> {
  return (node.userData as Record<string, unknown>)?.['realvirtual'] as Record<string, unknown> ?? {};
}

/** Refuse authoring writes while an in-place TEST RUN owns the scene.
 *
 *  The test session freezes the document history at test start and puts it
 *  back verbatim on stop (`restoreFromSnapshot` — plan-410 §2.4), so every op
 *  recorded during the run is DISCARDED with the test scene. An edit accepted
 *  now would report ok, verify ok against the live (test) scene, and silently
 *  revert minutes later — the exact silent-loss shape Bug #9 is about.
 *  Since plan-462 B3 the DOCUMENT refuses every mutation entry itself, with a
 *  `DocumentLockedError` carrying `ERR_DOCUMENT_LOCKED` — so this guard is no
 *  longer the only thing standing between a test run and a silent loss. It is
 *  kept, and re-pointed at `lockOwner`, because it answers BEFORE the tool does
 *  any of its own work (node lookups, schema validation, JSON parsing) and can
 *  therefore say something specific about the tool that was refused. It will be
 *  removed only once every tool is demonstrably covered by the document guard
 *  ahead of its first side effect. */
function testRunGuard(ctx: ActiveAssetContext): { error: string; code: string } | null {
  if (ctx.doc.lockOwner?.kind !== 'test-run') return null;
  return {
    code: ERR_DOCUMENT_LOCKED,
    error: ERR_TEST_RUN_ACTIVE,
  };
}

/** Structural equality for a userData field read-back after a setField op.
 *  Primitives via Object.is; objects/arrays via JSON round-trip — the values
 *  compared here both came through JSON, so key order is stable enough. */
function fieldValuesEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  try { return JSON.stringify(a) === JSON.stringify(b); }
  catch { return false; }
}

/** Path of the node whose Kinematic component references `groupName`, or null. */
function findKinematicPathForGroup(viewer: RVViewer, groupName: string): string | null {
  const root = viewer.currentModelRoot;
  if (!root) return null;
  let found: string | null = null;
  root.traverse((node) => {
    if (found) return;
    const rv = rvOf(node);
    for (const key of Object.keys(rv)) {
      if (!KINEMATIC_KEY_RE.test(key)) continue;
      const gn = (rv[key] as Record<string, unknown> | undefined)?.['GroupName'];
      if (gn === groupName) { found = NodeRegistry.computeNodePath(node); return; }
    }
  });
  return found;
}

/** The Drive extras data on a node (any `Drive_N` key), or null. */
function driveExtrasOf(node: Object3D): Record<string, unknown> | null {
  const rv = rvOf(node);
  for (const key of Object.keys(rv)) {
    if (DRIVE_KEY_RE.test(key)) {
      const data = rv[key];
      if (data && typeof data === 'object') return data as Record<string, unknown>;
    }
  }
  return null;
}

/** Lazily-loaded asset-editor action modules (the editor stays a lazy chunk). */
interface EditorMods {
  transform: typeof import('@rv-private/plugins/asset-editor/kinematics/transform-actions');
  create: typeof import('@rv-private/plugins/asset-editor/kinematics/create-actions');
  group: typeof import('@rv-private/plugins/asset-editor/group-actions');
  del: typeof import('@rv-private/plugins/asset-editor/delete-selection');
  save: typeof import('@rv-private/plugins/asset-editor/save-flow');
  pending: typeof import('@rv-private/plugins/asset-editor/pending-open-store');
  quickEdit: typeof import('@rv-private/plugins/asset-editor/kinematics/quick-edit-context');
  presets: typeof import('@rv-private/plugins/asset-editor/materials/material-presets');
  gizmoSource: typeof import('@rv-private/plugins/asset-editor/editor-drive-gizmo-source');
  draft: typeof import('../../core/ops/rv-document-drafts');
  importAsset: typeof import('../../core/import/rv-import-asset');
  cadProvider: typeof import('../../core/editor/rv-cad-provider');
}

// plan-499: eager descriptors — the bridge resolves label/button from them before a call.
ensureEditorCommandsRegistered();
// plan-504: the mechanism descriptors too — a first call (even in the community
// build, where it answers ERR_EDITOR_UNAVAILABLE) never meets "Unknown command".
ensureMechanismCommandsRegistered();

export class McpEditorTools {
  constructor(private readonly getViewer: () => RVViewer | undefined) {}

  private get viewer(): RVViewer | undefined {
    return this.getViewer();
  }

  private _mods: Promise<EditorMods> | null = null;

  private _load(): Promise<EditorMods> {
    this._mods ??= (async () => ({
      transform: await import('@rv-private/plugins/asset-editor/kinematics/transform-actions'),
      create: await import('@rv-private/plugins/asset-editor/kinematics/create-actions'),
      group: await import('@rv-private/plugins/asset-editor/group-actions'),
      del: await import('@rv-private/plugins/asset-editor/delete-selection'),
      save: await import('@rv-private/plugins/asset-editor/save-flow'),
      pending: await import('@rv-private/plugins/asset-editor/pending-open-store'),
      quickEdit: await import('@rv-private/plugins/asset-editor/kinematics/quick-edit-context'),
      presets: await import('@rv-private/plugins/asset-editor/materials/material-presets'),
      gizmoSource: await import('@rv-private/plugins/asset-editor/editor-drive-gizmo-source'),
      draft: await import('../../core/ops/rv-document-drafts'),
      importAsset: await import('../../core/import/rv-import-asset'),
      cadProvider: await import('../../core/editor/rv-cad-provider'),
    }))();
    return this._mods;
  }

  /** requireEditor + JSON error shortcut. */
  private _ctx(): ActiveAssetContext | { error: string } {
    return requireEditor(this.viewer);
  }

  /**
   * plan-499: THE one dispatch of a bound body. The bridge hands the call
   * context in (resolved once, before the choreography); a direct call — tests,
   * internal callers — binds the same way here from the method's decorator.
   */
  private _dispatch<R = Record<string, unknown>>(
    ctx: McpCallContext | undefined, methodKey: string, wire: Record<string, unknown>,
  ): ReturnType<typeof dispatchBoundCommand<R>> {
    return dispatchBoundCommand<R>(ctx ?? bindStandalone(this, methodKey, wire, this.viewer), this.viewer);
  }

  /** Serialise a dispatch: `{error, ...details}` on refusal, else the shaped value. */
  private _json<R>(
    r: Awaited<ReturnType<typeof dispatchBoundCommand<R>>>,
    shape: (v: R) => Record<string, unknown> = (v) => v as unknown as Record<string, unknown>,
  ): string {
    return JSON.stringify(r.ok ? shape(r.value) : commandErrorJson(r));
  }

  /** Handle unsaved changes per the ifDirty policy. Returns an error string or null. */
  private async _handleDirty(
    ctx: ActiveAssetContext, ifDirty: string | undefined, saveName?: string,
  ): Promise<string | null> {
    if (!ctx.doc.dirty) return null;
    const policy = (ifDirty || 'fail').toLowerCase();
    // plan-462 B3 — BEFORE the draft is deleted, not after. `discard` clears the
    // draft slot and then re-bases the log; during a test run that slot is the
    // only record of the pre-test authoring state, so a discard accepted here
    // destroys the very work the test session promised to put back.
    const locked = testRunGuard(ctx);
    if (locked) return locked.error;
    const mods = await this._load();
    if (policy === 'discard') {
      await mods.draft.clearDocumentDraft(ctx.doc.draftFrame);
      // poison dirty so deactivate won't re-flush
      await ctx.doc.markSaved(ctx.doc.base, undefined, { clearDraft: true });
      return null;
    }
    if (policy === 'save') {
      const name = saveName?.trim() || ctx.doc.name;
      // "Untitled" saves like any other name (field decision 2026-08-19);
      // only a nameless document has nowhere to go.
      if (!name) {
        return 'Document has no name — pass one to save it, or use ifDirty=discard';
      }
      const outcome = await mods.save.saveAssetAs(ctx, name);
      if (outcome.kind !== 'saved') {
        return `Save failed: ${outcome.kind === 'error' ? outcome.message : outcome.kind}`;
      }
      return null;
    }
    return `Unsaved changes in "${ctx.doc.name}" — pass ifDirty=save or ifDirty=discard`;
  }

  /** Wait until the editor has an active document (bounded poll). */
  private async _awaitEditorContext(notDocId?: string, timeoutMs = 110_000): Promise<ActiveAssetContext | null> {
    const { getActiveAssetContext } = await import('../../core/editor/active-asset-store');
    const t0 = Date.now();
    for (;;) {
      const ctx = getActiveAssetContext();
      if (ctx && ctx.doc.id !== notDocId) return ctx;
      if (Date.now() - t0 > timeoutMs) return null;
      await sleep(150);
    }
  }

  private async _statusJson(): Promise<string> {
    const v = this.viewer;
    const ctx = this._ctx();
    if (isGuardError(ctx)) {
      return JSON.stringify({ active: false, mode: v?.modes.activeMode ?? null, ...ctx });
    }
    const snap = ctx.doc.getSnapshot();
    let nodeCount = 0;
    v?.currentModelRoot?.traverse(() => { nodeCount++; });
    // plan-706: the test-session state rides here rather than in a tool of its
    // own — a whole extra entry in the roster for one enum is a worse trade for
    // the agent's tool-selection budget than one more field on the status it
    // already reads.
    const { getTestSessionState } = await import('@rv-private/plugins/asset-editor/test-session-store');
    return JSON.stringify({
      active: true,
      testSession: getTestSessionState(),
      name: snap.name,
      base: snap.base,
      dirty: snap.dirty,
      busy: snap.busy,
      canUndo: snap.canUndo,
      canRedo: snap.canRedo,
      undoLabel: snap.undoLabel,
      opCount: snap.opCount,
      selectionCount: v?.selectionManager.getSnapshot().selectedPaths.length ?? 0,
      nodeCount,
      // The wireframe VIEW toggle (Shift+Z): true = screenshots show lines, not
      // surfaces. A view state — it never changes the document.
      wireframe: v?.wireframe ?? false,
      // plan-713 F10 — the descend chain, from the ONE core seam both writers
      // publish into. A depth of 1 is the root document, not "no stack".
      ...this._breadcrumbFields(),
    });
  }

  /**
   * The breadcrumb of the open document, as status fields.
   *
   * `RvDocumentStack.breadcrumb()` is what produces these, but the stack lives
   * in the private editor plugin; the published `ActiveDocumentView` is the core
   * seam it writes them into, and reading them there is what lets the status
   * work in a build without that plugin. Never throws — a status that fails
   * because a breadcrumb could not be read is worse than one without it.
   */
  private _breadcrumbFields(): {
    depth?: number;
    breadcrumb?: Array<{ index: number; label: string; occurrence: string; current: boolean; dirty: boolean; stale: boolean }>;
  } {
    try {
      const crumbs = getActiveDocumentView()?.crumbs ?? [];
      if (crumbs.length === 0) return {};
      return {
        depth: crumbs.length,
        breadcrumb: crumbs.map(c => ({
          index: c.index, label: c.label, occurrence: c.occurrence,
          current: c.current, dirty: c.dirty, stale: c.stale,
        })),
      };
    } catch { return {}; }
  }

  @McpTool('Descend INTO a referenced asset at path — opens that asset as its own document one level deeper, exactly like double-clicking the reference in the hierarchy. Editor mode only. The path must be a descendable reference; anything else is refused with the reason. Leave again with web_editor_back; the chain is in web_editor_status as depth + breadcrumb.', { readOnly: false, timeoutMs: 120_000 })
  async webEditorDescend(
    @McpParam('path', 'Node path of the referenced asset to enter') path: string,
  ): Promise<string> {
    const ctx = this._ctx();
    if (isGuardError(ctx)) return JSON.stringify(ctx);
    const target = (path ?? '').trim();
    if (!target) return JSON.stringify({ error: 'path is required.' });
    const node = ctx.viewer.registry?.getNode(target);
    if (!node) return JSON.stringify({ error: `Node not found: ${target}` });

    const { canDescendInto, requestDescend } = await import('../../core/editor/rv-descend-request');
    // `canDescend` FIRST so the refusal names the cause. `requestDescend`
    // returning false is the same verdict with no explanation attached, and an
    // agent that reads "nothing happened" retries the identical call.
    if (!canDescendInto(target)) {
      return JSON.stringify({
        error: `"${target}" cannot be descended into — it is not a resolved asset reference. `
          + 'Referenced assets appear in web_node_tree with a reference component; '
          + 'a placeholder that has not resolved yet cannot be entered.',
      });
    }
    const before = getActiveDocumentView()?.crumbs.length ?? 0;
    if (!requestDescend(target)) {
      return JSON.stringify({ error: `Descend into "${target}" was refused.` });
    }
    // The handler is fire-and-forget by design (it drives UI), so the depth
    // change is what tells us it landed.
    const after = await this._awaitDepth((d) => d > before, before);
    if (after === null) {
      return JSON.stringify({ error: `Descend into "${target}" did not complete in time.` });
    }
    return JSON.stringify({ descended: true, path: target, ...this._breadcrumbFields() });
  }

  @McpTool('Leave the current descend level and return to the document above it (the inverse of web_editor_descend). Refuses at the root, where there is nothing to go back to — close the document with web_editor_close instead.', { readOnly: false, timeoutMs: 120_000 })
  async webEditorBack(): Promise<string> {
    const ctx = this._ctx();
    if (isGuardError(ctx)) return JSON.stringify(ctx);
    const view = getActiveDocumentView();
    const crumbs = view?.crumbs ?? [];
    if (crumbs.length <= 1) {
      return JSON.stringify({
        error: 'Already at the root document — nothing to go back to. '
          + 'Use web_editor_close to leave the editor.',
      });
    }
    const parent = crumbs[crumbs.length - 2]!;
    if (!view?.actions?.onCrumb) {
      return JSON.stringify({ error: 'This document has no navigable stack.' });
    }
    const before = crumbs.length;
    await view.actions.onCrumb(parent);
    const after = await this._awaitDepth((d) => d < before, before);
    if (after === null) return JSON.stringify({ error: 'Back did not complete in time.' });
    return JSON.stringify({ back: true, to: parent.label, ...this._breadcrumbFields() });
  }

  /** Poll the published breadcrumb depth until `done`, or give up. Returns the depth. */
  private async _awaitDepth(
    done: (depth: number) => boolean, initial: number, timeoutMs = 110_000,
  ): Promise<number | null> {
    const t0 = Date.now();
    for (;;) {
      const depth = getActiveDocumentView()?.crumbs.length ?? initial;
      if (done(depth)) return depth;
      if (Date.now() - t0 > timeoutMs) return null;
      await sleep(120);
    }
  }

  // ═══ Lifecycle ════════════════════════════════════════════════════════

  @McpTool('Open the ASSET EDITOR with a document: source=new (creates a NEW document in the open project and opens it) or source=library with relPath naming an EXISTING document of the open project — a library-relative path ("Custom/MyAsset.glb"), a project-relative path ("sidecutter.glb", "models/A.glb", also as "project:<path>"), a document id or a document name from web_document_list. A relPath that matches no document is refused at once with the available names instead of waiting for a load that cannot happen. When the editor is already open with unsaved changes, ifDirty decides: fail (default) | save (needs a saved name) | discard. Editing happens through the web_editor_* tools; finish with web_editor_save.', { readOnly: false, timeoutMs: 120_000 })
  async webEditorOpen(
    @McpParam('source', 'new | library. ("empty" is a deprecated alias of "new".)') source: string,
    @McpParam('relPath', 'Document to open (source=library): library-relative path ("Custom/MyAsset.glb"), project-relative path ("sidecutter.glb", "project:models/A.glb"), document id or name from web_document_list.', 'string', false) relPath: string,
    @McpParam('ifDirty', 'fail | save | discard — what to do with unsaved changes (default fail).', 'string', false) ifDirty: string,
  ): Promise<string> {
    const v = this.viewer;
    if (!v) return JSON.stringify({ error: 'No viewer' });
    const raw = (source || '').toLowerCase();
    // plan-719 F10: `empty` named a base kind that no longer exists. It stays
    // as an alias for ONE release because it is in recipes and transcripts,
    // and it performs the new behaviour rather than the old one — there is no
    // old behaviour left to perform.
    const src = raw === 'empty' ? 'new' : raw;
    if (src !== 'new' && src !== 'library') {
      return JSON.stringify({ error: 'source must be "new" or "library"' });
    }
    if (src === 'library' && !relPath?.trim()) {
      return JSON.stringify({ error: 'source=library needs relPath (e.g. "Custom/MyAsset.glb")' });
    }
    const mods = await this._load();

    // A new document is CREATED before the mode switch, not conjured by it
    // (plan-719 F3): bytes and manifest row first, then the editor opens the
    // real thing. That is also why this can fail with a sentence — a read-only
    // project cannot take a new document, and saying so beats an editor that
    // opens onto a stage nothing can be saved from.
    let pending;
    if (src === 'new') {
      const created = await this._createProjectDocument();
      if (typeof created === 'string') return JSON.stringify({ error: created });
      pending = created;
    } else {
      // Open the ROW the dashboard would open, not a path guessed under
      // `library/`: a document at the project root (the normal place since
      // plan-744) has no `library/` twin, and the editor's load of that
      // non-existent path fails silently — the tool then polled for an active
      // document until its own timeout (2026-09-22). Resolving against the
      // project's one document list finds the file wherever it is, and a miss
      // is answered now, in words, with the names that would have matched.
      const [{ getProjectStore }, documents] = await Promise.all([
        import('../../core/project/project-store'),
        import('../../core/project/rv-project-documents'),
      ]);
      const rows = documents.documentsOf(getProjectStore().getProject());
      const row = resolveEditorOpenDocument(relPath, rows);
      if (row) {
        pending = documentBase(row.id, row.name || row.path, row.path);
      } else if (rows.length === 0) {
        // No project listing to consult (bundled / no project open): the
        // library-relative form is the only address there is — keep it.
        pending = libraryDocumentBase(relPath.trim());
      } else {
        return JSON.stringify({
          error: `No document of the open project matches "${relPath.trim()}".`,
          availableDocuments: rows.map((d) => ({ name: d.name, path: d.path, id: d.id })),
          hint: 'Pass a path from web_document_list (project-relative, e.g. "sidecutter.glb" or "library/Custom/A.glb"), a document id or a name.',
        });
      }
    }

    let prevDocId: string | undefined;
    if (v.modes.activeMode === 'editor') {
      const ctx = this._ctx();
      if (!isGuardError(ctx)) {
        const err = await this._handleDirty(ctx, ifDirty);
        if (err) return JSON.stringify({ error: err });
        prevDocId = ctx.doc.id;
      }
      // Leave and re-enter so the plugin opens the new pending document.
      v.modes.setMode(fallbackMode(v));
    }

    mods.pending.setPendingAssetOpen(pending);
    v.modes.setMode('editor');
    const ctx = await this._awaitEditorContext(prevDocId);
    if (!ctx) return JSON.stringify({ error: 'Editor did not activate (model load failed or timed out)' });
    const status = JSON.parse(await this._statusJson()) as Record<string, unknown>;
    status.next = 'Perceive first (web_node_tree, web_camera_focus, web_node_bounds); workflow guide: web_help("editor")';
    return JSON.stringify(status);
  }

  /**
   * Create a document in the open project and answer its identity.
   *
   * The same `createDocument` the dashboard's New button and the editor's own
   * "nothing to open" branch use — one creation mechanism, so an agent's new
   * document is indistinguishable from a human's. Answers a STRING when it
   * cannot: a read-only or absent project is an operator-fixable condition and
   * deserves the sentence, not a stack trace.
   */
  private async _createProjectDocument(): Promise<AssetBase | string> {
    try {
      const [{ getProjectStore }, { createDocument }, docs] = await Promise.all([
        import('../../core/project/project-store'),
        import('../../core/project/rv-document-ops'),
        import('../../core/hmi/projects/dashboard-documents'),
      ]);
      const store = getProjectStore();
      if (!store.getBackend()?.writable) {
        return 'No writable project is open — open or create one before making a document.';
      }
      const folder = docs.newDocumentFolderFor(store.getProject()?.id, null);
      const target = await createDocument(store, docs.newDocumentNameFor(folder), { folder });
      await store.rescanDocuments?.();
      await store.flush?.();
      return {
        kind: 'document',
        documentId: target.documentId,
        path: target.relPath,
        name: target.name,
      };
    } catch (e) {
      return `The document could not be created: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  @McpTool('Close the asset editor and return to the previous workspace. ifDirty: fail (default) | save (optionally pass name) | discard.', { readOnly: false })
  async webEditorClose(
    @McpParam('ifDirty', 'fail | save | discard (default fail).', 'string', false) ifDirty: string,
    @McpParam('name', 'Asset name when ifDirty=save and the document is Untitled.', 'string', false) name: string,
  ): Promise<string> {
    const v = this.viewer;
    const ctx = this._ctx();
    if (isGuardError(ctx)) return JSON.stringify(ctx);
    const err = await this._handleDirty(ctx, ifDirty, name);
    if (err) return JSON.stringify({ error: err, dirty: true });
    v!.modes.setMode(fallbackMode(v!));
    return JSON.stringify({ mode: v!.modes.activeMode, closed: true });
  }

  @McpTool('Asset editor status: document name/base/dirty, undo/redo availability + label, op count, selection and node counts.', { readOnly: true })
  async webEditorStatus(): Promise<string> {
    return this._statusJson();
  }

  @McpTool('Locate the KNOWLEDGE FOLDER for the open asset inside the OPEN PROJECT — the durable home for notes, a part catalogue and saved views across sessions. Returns the project name/kind, whether it is writable, the asset\'s library-relative path when it has one, and knowledgeRelPath ("knowledge/<AssetName>"). Every path here is PROJECT-relative, which is all the other tools need: web_editor_import_glb / web_editor_import_cad read them, web_eye, web_view_sweep and web_view_ortho write them via savePath. absolutePath is ALWAYS null — the browser exposes no filesystem path, and a browser project (OPFS) has none; put files in through the app, not the OS file manager.', { readOnly: true })
  async webEditorProjectInfo(): Promise<string> {
    const ctx = this._ctx();
    if (isGuardError(ctx)) return JSON.stringify(ctx);
    const { getProjectStore } = await import('../../core/project/project-store');
    const store = getProjectStore();
    const backend = store.getBackend();
    const project = store.getProject();
    const snap = ctx.doc.getSnapshot();
    const assetName = (snap.name || 'Untitled').trim() || 'Untitled';
    // Folder-safe but still recognisable: the agent and the user both navigate to this by name.
    const safeName = assetName.replace(/[^A-Za-z0-9 ._-]/g, '_').replace(/\s+/g, ' ').trim() || 'Untitled';
    const base = snap.base;
    // plan-716 §2.6: `path` is project-relative and already carries the
    // `library/` prefix, so "is this a library asset?" is a question about the
    // path rather than about a kind of its own. The reported `assetRelPath`
    // stays byte-identical to what the former `libraryGlb` branch produced —
    // it is an MCP result shape agents parse.
    const fromLibrary = base.kind === 'document' && base.path.startsWith('library/');
    return JSON.stringify({
      projectOpen: project !== null,
      projectName: project?.name ?? null,
      projectKind: backend?.kind ?? null,
      writable: backend?.writable === true,
      absolutePath: null,
      absolutePathNote: 'Not obtainable from the browser. Every path in this result is project-relative; the tools take those directly.',
      assetName,
      assetFromLibrary: fromLibrary,
      assetRelPath: fromLibrary ? base.path : null,
      knowledgeRelPath: `knowledge/${safeName}`,
      capturesRelPath: 'captures',
      dirty: snap.dirty,
      opCount: snap.opCount,
    });
  }

  @McpTool('List the files the OPEN PROJECT owns, project-relative (path, name, sizeBytes, modified, folder, documentId). Narrow with dir (folder prefix, e.g. "library/Custom") and glob ("*" and "?", matched over the whole path, e.g. "*.glb"). With no project open it answers with the same projectOpen:false shape as web_editor_project_info. Oversized listings are truncated and say by how much.', { readOnly: true, timeoutMs: 60_000 })
  async webEditorProjectFiles(
    @McpParam('dir', 'Project-relative folder prefix, e.g. "library/Custom"', 'string', false) dir?: string,
    @McpParam('glob', 'Glob over the whole path, "*" and "?" only, e.g. "*.glb"', 'string', false) glob?: string,
  ): Promise<string> {
    const [{ getProjectStore }, listing, observe] = await Promise.all([
      import('../../core/project/project-store'),
      import('./rv-mcp-asset-listing'),
      import('./rv-mcp-observe-tools'),
    ]);
    const store = getProjectStore();
    const backend = store.getBackend();
    const project = store.getProject();
    // F4: the SAME refusal shape as `web_editor_project_info`, deliberately —
    // an agent that learnt to branch on `projectOpen` for one of them must not
    // have to learn a second shape for the other.
    if (!backend || project === null) {
      return JSON.stringify({
        projectOpen: false, projectName: null, projectKind: backend?.kind ?? null,
        writable: false, files: [], count: 0,
        hint: 'No project is open — open one with web_project_open.',
      });
    }

    // The backend has no generic directory walk, and inventing one here would be
    // a filesystem surface on an interface that deliberately has none (see the
    // header of project-backend.ts). The union of what it DOES list is the
    // honest answer, and `statDocuments()` supplies the size/mtime the rows lack.
    //
    // Two calls, not four (plan-744 F1): `listModels()` and `listLibrary()`
    // were folder-shaped slices of `listDocuments()` — one non-recursive, one
    // recursive — so the union they contributed to was a union of the same
    // rows at two different depths. `listDocuments()` walks the whole tree.
    const [documents, stats] = await Promise.all([
      backend.listDocuments().catch(() => []),
      backend.statDocuments().catch(() => []),
    ]);
    const statByPath = new Map(stats.map(s => [s.path, s]));

    interface FileRow {
      path: string; name: string; sizeBytes: number | null;
      modified: string | null;
      /** First path segment, `''` at the project root — where the file IS. */
      folder: string;
      documentId: string | null;
    }
    const byPath = new Map<string, FileRow>();
    const put = (path: string, name: string,
                 documentId: string | null, sizeBytes: number | null,
                 modified: string | null): void => {
      if (!path || byPath.has(path)) return;
      const stat = statByPath.get(path);
      // The folder is READ OFF THE PATH, for every row, in one place (plan-736
      // F7). It used to be a `section` argument each caller passed by hand —
      // `'models'` here, `'library'` there, the row's stored field for a
      // document — which is how a listing could disagree with the tree it was
      // listing, and how a root-level file ended up filed as `null`. The
      // deprecated `section` alias that outlived that argument is gone too
      // (plan-744 F9); it only ever repeated `folder`.
      byPath.set(path, {
        path, name,
        sizeBytes: sizeBytes ?? stat?.size ?? null,
        modified: modified ?? (stat?.mtime ? new Date(stat.mtime).toISOString() : null),
        folder: path.includes('/') ? path.slice(0, path.indexOf('/')) : '',
        documentId,
      });
    };
    for (const d of documents) {
      put(d.path, d.name, d.id, d.sizeBytes ?? null, d.modifiedAt ?? null);
    }
    const fileStem = listing.glbStem;
    for (const s of stats) put(s.path, fileStem(s.path), null, s.size, s.mtime ? new Date(s.mtime).toISOString() : null);

    const rows = [...byPath.values()]
      .filter(r => listing.inDirectory(r.path, dir) && listing.matchesGlob(r.path, glob))
      .sort((a, b) => a.path.localeCompare(b.path));

    const capped = listing.capRows(rows, observe.QUERY_RESULT_CAP,
      'Narrow with dir= or glob=.');
    return JSON.stringify({
      projectOpen: true,
      projectName: project.name ?? null,
      projectKind: backend.kind,
      writable: backend.writable === true,
      count: rows.length,
      files: capped.rows,
      ...(capped.note ? { truncated: capped.note } : {}),
    });
  }

  @McpTool('Undo the last N editor operations (default 1).', { readOnly: false, command: 'editor.undo' })
  async webEditorUndo(
    @McpParam('count', 'Number of undo steps (default 1).', 'integer', false) count: number,
    ctx?: McpCallContext,
  ): Promise<string> {
    // plan-499: a view of editor.undo — the same command Ctrl+Z and the toolbar dispatch.
    return this._json(await this._dispatch(ctx, 'webEditorUndo', { count }));
  }

  @McpTool('Redo the last N undone editor operations (default 1).', { readOnly: false, command: 'editor.redo' })
  async webEditorRedo(
    @McpParam('count', 'Number of redo steps (default 1).', 'integer', false) count: number,
    ctx?: McpCallContext,
  ): Promise<string> {
    return this._json(await this._dispatch(ctx, 'webEditorRedo', { count }));
  }

  @McpTool('Save the asset as GLB into the open project — its own folder when it has one, the project ROOT when it has none (plan-744: `library/Custom` is no longer a fallback). The document saves under its current name whatever it is (an "Untitled" name is a name like any other); the same name overwrites the existing file. Needs a configured work folder (File System Access). Reports saveVerb — save (in place), save-into-project (this write COPIES the document into the project and changes its identity) or blocked with a reason.', { readOnly: false, timeoutMs: 60_000 })
  async webEditorSave(
    @McpParam('name', 'Asset name (default: current document name).', 'string', false) name: string,
  ): Promise<string> {
    const ctx = this._ctx();
    if (isGuardError(ctx)) return JSON.stringify(ctx);
    const finalName = name?.trim() || ctx.doc.name;
    // Only a document with NO name at all is refused. "Untitled" is a name
    // like any other (field decision 2026-08-19) — the former guard here made
    // every fresh document unsavable by MCP until renamed, a name-based
    // special case the save semantics no longer have anywhere.
    if (!finalName) {
      return JSON.stringify({ error: 'Document has no name — pass one' });
    }
    // F6 — the verb the SAVE CARD shows, reported by the tool that performs the
    // same save. Taken before the write, because that is when it describes what
    // is about to happen: after a `save-into-project` the document's identity is
    // already the new one and the same call would answer `save`.
    const decision = await this._saveVerb(finalName);
    const mods = await this._load();
    const outcome = await mods.save.saveAssetAs(ctx, finalName);
    if (outcome.kind === 'saved') {
      return JSON.stringify({
        saved: true, fileName: outcome.fileName, relPath: outcome.projectRelPath,
        ...decision,
        next: 'web_editor_close to leave; reload the asset live to jog real drives as a smoke test',
      });
    }
    // The outcome's OWN sentence, from the one place they are worded
    // (plan-719 F4/F5). This used to print `Save unavailable: blocked` for
    // everything that was not an error — the tool telling an agent the name of
    // a branch instead of the reason the save could not happen, while the very
    // same outcome was carrying that reason.
    return JSON.stringify({
      error: mods.save.describeSaveFailure(outcome),
      outcome: outcome.kind,
      ...decision,
    });
  }

  /**
   * The save verb for the current document, as `{ saveVerb, saveReason?, copies? }`.
   *
   * One helper for both lineages because `decideSaveVerb` is one function since
   * plan-710 — the whole point of F6 is that the MCP result cannot say something
   * different from the card, and two call sites shaping the same decision
   * differently is exactly how that would happen. Never throws: a verb is a
   * label on a save, and a save must not fail because its label could not be
   * computed.
   */
  private async _saveVerb(
    name: string,
  ): Promise<{ saveVerb?: string; saveReason?: string; copies?: boolean }> {
    try {
      const ctx = this._ctx();
      if (isGuardError(ctx)) return {};
      const [{ getProjectStore }, { decideSaveVerb }] = await Promise.all([
        import('../../core/project/project-store'),
        import('../../core/editor/rv-save-document'),
      ]);
      const d = decideSaveVerb(
        // The lineage used to be a parameter with exactly one value; the editor
        // tools only ever save assets. The scene lineage has its own helper in
        // `rv-mcp-scene-tools.ts` because its INPUT fields and its RESULT shape
        // both differ (`open`/`transient` in, no `copies` out) — plan-461 V15.
        { lineage: 'asset', base: ctx.doc.getSnapshot().base, name },
        getProjectStore().getBackend(),
      );
      return {
        saveVerb: d.verb,
        ...(d.reason ? { saveReason: d.reason } : {}),
        ...(d.copies ? { copies: true } : {}),
      };
    } catch { return {}; }
  }

  // ═══ Transform / pivot ════════════════════════════════════════════════

  @McpTool('Set a node\'s LOCAL transform (partial): position in meters (px/py/pz), rotation in degrees XYZ Euler (rx/ry/rz), scale (sx/sy/sz). Omitted components keep their current value. One undoable op.', { readOnly: false })
  async webEditorTransform(
    @McpParam('path', 'Node path.') path: string,
    @McpParam('px', 'Local position X (m).', 'number', false) px: number,
    @McpParam('py', 'Local position Y (m).', 'number', false) py: number,
    @McpParam('pz', 'Local position Z (m).', 'number', false) pz: number,
    @McpParam('rx', 'Local rotation X (deg).', 'number', false) rx: number,
    @McpParam('ry', 'Local rotation Y (deg).', 'number', false) ry: number,
    @McpParam('rz', 'Local rotation Z (deg).', 'number', false) rz: number,
    @McpParam('sx', 'Local scale X.', 'number', false) sx: number,
    @McpParam('sy', 'Local scale Y.', 'number', false) sy: number,
    @McpParam('sz', 'Local scale Z.', 'number', false) sz: number,
  ): Promise<string> {
    const ctx = this._ctx();
    if (isGuardError(ctx)) return JSON.stringify(ctx);
    const node = ctx.viewer.registry?.getNode(path);
    if (!node) return JSON.stringify({ error: `Node not found: ${path}` });
    if (isModelRoot(node, ctx.viewer.currentModelRoot)) return JSON.stringify({ error: MODEL_ROOT_LOCKED });
    const mods = await this._load();
    const prev = mods.transform.snapshotLocal(node);
    const num = (v: number | undefined, dflt: number): number =>
      typeof v === 'number' && !Number.isNaN(v) ? v : dflt;
    const next: NodeTransform = {
      position: [num(px, prev.position[0]), num(py, prev.position[1]), num(pz, prev.position[2])],
      quaternion: prev.quaternion,
      scale: [num(sx, prev.scale[0]), num(sy, prev.scale[1]), num(sz, prev.scale[2])],
    };
    if ([rx, ry, rz].some(v => typeof v === 'number' && !Number.isNaN(v))) {
      const e = new Euler().setFromQuaternion(new Quaternion().fromArray(prev.quaternion), 'XYZ');
      const deg = Math.PI / 180;
      const q = new Quaternion().setFromEuler(new Euler(
        num(rx, e.x / deg) * deg, num(ry, e.y / deg) * deg, num(rz, e.z / deg) * deg, 'XYZ',
      ));
      next.quaternion = q.toArray() as [number, number, number, number];
    }
    ctx.doc.transformNode(path, next, prev);
    await ctx.doc.whenIdle();
    return JSON.stringify({ ok: true, path, position: next.position.map(r3) });
  }

  @McpTool('Zero the LOCAL position of the given nodes (Quick Edit "Zero Local"). One undo unit.', { readOnly: false, command: 'editor.zeroPosition' })
  async webEditorZeroPosition(
    @McpParam('paths', 'Node paths, comma/newline-separated.') paths: string,
    ctx?: McpCallContext,
  ): Promise<string> {
    return this._json(await this._dispatch(ctx, 'webEditorZeroPosition', { paths }), (v) => ({ ok: true, ...v }));
  }

  @McpTool('Rotate a node ±90° around a LOCAL axis (Quick Edit rotate buttons). axis = x|y|z, sign = 1|-1.', { readOnly: false, command: 'editor.rotate90' })
  async webEditorRotate90(
    @McpParam('path', 'Node path.') path: string,
    @McpParam('axis', 'x | y | z.') axis: string,
    @McpParam('sign', '1 or -1 (default 1).', 'integer', false) sign: number,
    ctx?: McpCallContext,
  ): Promise<string> {
    return this._json(await this._dispatch(ctx, 'webEditorRotate90', { path, axis, sign }), (v) => ({ ok: true, ...v }));
  }

  @McpTool('Drop a node so its bounding box rests on the ground (Y = 0). Quick Edit "To Ground".', { readOnly: false, command: 'editor.toGround' })
  async webEditorToGround(
    @McpParam('path', 'Node path.') path: string,
    ctx?: McpCallContext,
  ): Promise<string> {
    // plan-499: the tool body is a VIEW of the command — exactly one dispatch,
    // the same enabled() reason the Quick Edit button shows as tooltip.
    return this._json(await this._dispatch(ctx, 'webEditorToGround', { path }), (v) => ({ ok: true, ...v }));
  }

  @McpTool('Move a node\'s PIVOT without moving geometry (children compensated, one undo unit). mode: bottom (pivot to bounds bottom-center) | object_center (to targetPath\'s precise vertex center — THE tool for placing a rotation axis on a specific part) | group_center (kinematic axis to its group\'s center) | align_y_up (rotate so local +Y is world up).', { readOnly: false, command: PIVOT_BINDING })
  async webEditorPivot(
    @McpParam('path', 'Node path whose pivot moves.') path: string,
    @McpParam('mode', 'bottom | object_center | group_center | align_y_up.') mode: string,
    @McpParam('targetPath', 'Target node (required for object_center).', 'string', false) targetPath: string,
    ctx?: McpCallContext,
  ): Promise<string> {
    // plan-499: a multiplexer — `mode` picks the command via PIVOT_BINDING (one branch per mode).
    const r = await this._dispatch<Record<string, unknown>>(ctx, 'webEditorPivot', { path, mode, targetPath });
    if (!r.ok && r.kind === 'unbound' && !r.reason) {
      return JSON.stringify({ error: 'mode must be bottom | object_center | group_center | align_y_up' });
    }
    return this._json(r, (v) => ({ ok: true, path: v['path'], mode: (mode || '').toLowerCase(), pivotWorld: v['pivotWorld'] }));
  }

  @McpTool('Rename a node (undoable).', { readOnly: false, command: 'editor.rename' })
  async webEditorRename(
    @McpParam('path', 'Node path.') path: string,
    @McpParam('name', 'New name.') name: string,
    ctx?: McpCallContext,
  ): Promise<string> {
    return this._json(await this._dispatch(ctx, 'webEditorRename', { path, name }), (v) => ({ ok: true, ...v }));
  }

  @McpTool('Delete nodes (descendants of other given paths are pruned automatically; one undo unit).', { readOnly: false, command: 'editor.delete' })
  async webEditorDelete(
    @McpParam('paths', 'Node paths, comma/newline-separated.') paths: string,
    ctx?: McpCallContext,
  ): Promise<string> {
    return this._json(await this._dispatch(ctx, 'webEditorDelete', { paths }), (v) => ({ ok: true, ...v }));
  }

  @McpTool('Show or hide nodes (authored visibility — saved with the asset, undoable).', { readOnly: false, command: 'editor.setVisible' })
  async webEditorSetVisible(
    @McpParam('paths', 'Node paths, comma/newline-separated.') paths: string,
    @McpParam('visible', 'true to show, false to hide.', 'boolean') visible: boolean,
    ctx?: McpCallContext,
  ): Promise<string> {
    return this._json(await this._dispatch(ctx, 'webEditorSetVisible', { paths, visible }), (v) => ({ ok: true, ...v }));
  }

  @McpTool('SEPARATE meshes into child parts (undoable, same op as the context menu "Separate ▸"): islands = connected loose parts, groups = one part per material group. Each source mesh is replaced by a same-named Group carrying the parts (children "<name>_part<N>"). Omit paths to separate the CURRENT selection.', { readOnly: false, timeoutMs: 120_000 })
  async webEditorSeparate(
    @McpParam('paths', 'Mesh node paths, comma/newline-separated (omit = current selection).', 'string', false) paths: string,
    @McpParam('mode', 'islands | groups | auto (default auto: groups for multi-material meshes, islands otherwise).', 'string', false) mode: string,
  ): Promise<string> {
    const ctx = this._ctx();
    if (isGuardError(ctx)) return JSON.stringify(ctx);
    let list = parsePathsParam(paths ?? '');
    if (list.length === 0) list = [...ctx.viewer.selectionManager.getSnapshot().selectedPaths];
    if (list.length === 0) {
      return JSON.stringify({ error: 'No paths given and nothing selected — pass paths or select first (web_select)' });
    }
    const requested = (mode?.trim() || 'auto').toLowerCase();
    if (!['auto', 'islands', 'groups'].includes(requested)) {
      return JSON.stringify({ error: 'mode must be islands | groups | auto' });
    }

    const results: Array<{ path: string; mode: SeparateMode; parts: number; children: string[] }> = [];
    const skipped: Array<Record<string, unknown>> = [];

    const separateOne = async (p: string): Promise<void> => {
      const node = ctx.viewer.registry?.getNode(p) as Mesh | null;
      if (!node || !(node as { isMesh?: boolean }).isMesh) {
        skipped.push({ path: p, reason: node ? 'Not a mesh — pass a mesh leaf, not a group' : 'Node not found' });
        return;
      }
      const geometry = node.geometry as BufferGeometry;
      const m: SeparateMode = requested === 'auto'
        ? (Array.isArray(node.material) || (geometry.groups?.length ?? 0) >= 2 ? 'groups' : 'islands')
        : requested as SeparateMode;
      // Cheap eligibility first (no union-find — separateMesh pays for that once):
      // shape + group table / material arity.
      const reason = m === 'groups'
        ? groupModeIneligibility(node)
        : unsupportedMeshShapeReason(node) ?? (Array.isArray(node.material) ? REASON_MULTI_MATERIAL : null);
      if (reason) { skipped.push({ path: p, mode: m, reason }); return; }
      try {
        const children = await ctx.doc.separateMesh(p, m, { weldThreshold: DEFAULT_WELD_THRESHOLD });
        if (children.length === 0) { skipped.push({ path: p, mode: m, reason: REASON_SINGLE_PART }); return; }
        results.push({ path: p, mode: m, parts: children.length, children: children.slice(0, 8) });
      } catch (e) {
        skipped.push({ path: p, mode: m, reason: e instanceof Error ? e.message : String(e) });
      }
    };

    if (list.length > 1) {
      await ctx.doc.withTransaction(`Separate ${list.length} meshes`, async () => {
        for (const p of list) await separateOne(p);
      });
    } else {
      await separateOne(list[0]);
    }
    await ctx.doc.whenIdle();
    // The Group took each source's path — re-selecting keeps the user in place,
    // now with the parts one level below (same move as the context-menu flow).
    if (results.length > 0) ctx.viewer.selectionManager?.select(results[0].path);
    return JSON.stringify({
      ok: results.length > 0,
      separated: results,
      skipped,
      ...(results.length > 0
        ? { next: 'Parts are children of the same-named Group at each source path; one web_editor_undo reverts everything' }
        : {}),
    });
  }

  // ═══ Structure / components / kinematics ══════════════════════════════

  @McpTool('Create an empty node (under parentPath, or at the asset root when omitted). Returns the new path.', { readOnly: false, command: 'editor.createEmpty' })
  async webEditorCreateEmpty(
    @McpParam('parentPath', 'Parent node path (omit for asset root).', 'string', false) parentPath: string,
    @McpParam('name', 'Node name (default "Empty").', 'string', false) name: string,
    ctx?: McpCallContext,
  ): Promise<string> {
    return this._json(await this._dispatch(ctx, 'webEditorCreateEmpty', { parentPath, name }), (v) => ({ ok: true, ...v }));
  }

  @McpTool('Move nodes under a new parent, preserving world poses (undoable). newParentPath omitted = asset root.', { readOnly: false, command: 'editor.reparent' })
  async webEditorReparent(
    @McpParam('paths', 'Node paths to move, comma/newline-separated.') paths: string,
    @McpParam('newParentPath', 'Target parent path (omit for asset root).', 'string', false) newParentPath: string,
    ctx?: McpCallContext,
  ): Promise<string> {
    return this._json(await this._dispatch(ctx, 'webEditorReparent', { paths, newParentPath }), (v) => ({ ok: true, ...v }));
  }

  @McpTool('Add a component to a node (Quick Edit "Components" section): Drive, Kinematic, Sensor, TransportSurface, Source, Sink, Grip, BoxCollider, WebPhysicsZone, drive behaviors, signals, LogicSteps… Starts from schema defaults; optional propsJson overrides fields (e.g. {"Direction":"RotationY"}). BoxCollider: one per node, metres; on a mesh it goes onto a new child "Collider" (returned path). WebPhysicsZone adds a missing 1 m BoxCollider and turns physics on for the model. Returns the concrete component key. Undoable.', { readOnly: false, command: 'editor.addComponent' })
  async webEditorAddComponent(
    @McpParam('path', 'Node path.') path: string,
    @McpParam('type', 'Component base type (e.g. Drive).') type: string,
    @McpParam('propsJson', 'Optional JSON object of field overrides.', 'string', false) propsJson: string,
    ctx?: McpCallContext,
  ): Promise<string> {
    return this._json(await this._dispatch(ctx, 'webEditorAddComponent', { path, type, propsJson }), (v) => ({ ok: true, ...v }));
  }

  @McpTool('Remove a component from a node by its concrete key (e.g. "Drive" or "Drive_1" — see web_component_get_all). Undoable.', { readOnly: false, command: 'editor.removeComponent' })
  async webEditorRemoveComponent(
    @McpParam('path', 'Node path.') path: string,
    @McpParam('componentType', 'Concrete component key.') componentType: string,
    ctx?: McpCallContext,
  ): Promise<string> {
    return this._json(await this._dispatch(ctx, 'webEditorRemoveComponent', { path, componentType }), (v) => ({ ok: true, ...v }));
  }

  @McpTool('Set one field of a component on a node (undoable, live in the panels). valueJson is parsed as JSON (numbers/booleans/strings/objects; bare strings work too). VERIFIED: ok is returned only after the value has been read back from the live scene — a dropped or refused op returns an error instead.', { readOnly: false, command: 'editor.setField' })
  async webEditorSetField(
    @McpParam('path', 'Node path.') path: string,
    @McpParam('componentType', 'Concrete component key (e.g. Drive).') componentType: string,
    @McpParam('fieldName', 'Field name (e.g. TargetSpeed).') fieldName: string,
    @McpParam('valueJson', 'New value as JSON (e.g. 500, true, "RotationY").') valueJson: string,
    ctx?: McpCallContext,
  ): Promise<string> {
    // VERIFIED inside the command: ok only after the value was read back from the
    // live scene; a dropped or refused op comes back as {error, ...details}.
    return this._json(
      await this._dispatch(ctx, 'webEditorSetField', { path, componentType, fieldName, valueJson }),
      (v) => ({ ok: true, ...v }),
    );
  }

  // ── Rigid-body mechanisms (plan-404, plan-504) ────────────────────────
  //
  // These orchestrate COMPOSITES of the existing generic ops (addComponent /
  // setField / unsetField) through `runMechanismPlan` — the op union and
  // its dispatchers are untouched by design (plan-404 §2.6). `_validate` and
  // `_jog` are TRANSIENT: they create no ops and no undo entries.
  //
  // plan-504: eleven of the write tools are VIEWS of the `mechanism.*`
  // commands (open descriptors: `mechanism-command-descriptors.ts`, private
  // implementations: `mechanism/mechanism-commands.ts`) — the same rule the
  // Mechanism section's buttons show as tooltip, one dispatch, the afterglow on
  // the row that was addressed. `web_editor_mechanism_set_anchor` stays a direct
  // tool (millimetre field input — no button to be a view of).
  //
  // NOTE the naming: "mechanism" is the RIGID-BODY joint-graph system, not the
  // older `Kinematic` axis-group system that `web_editor_kinematize` /
  // `web_editor_create_kinematic` below drive. The two are never mixed.

  @McpTool('Add a rigid-body MECHANISM (KinematicMechanism) to a node — the container that solves a joint graph with loop closure and free bodies. Add joints afterwards with web_editor_mechanism_add_joint. NOTE: mechanism = the rigid-body joint graph, NOT the axis-group Kinematic system (see web_editor_list_kinematics). Undoable.', { readOnly: false, command: 'mechanism.create' })
  async webEditorMechanismCreate(
    @McpParam('path', 'Node the mechanism component is added to.') path: string,
    ctx?: McpCallContext,
  ): Promise<string> {
    return this._json(await this._dispatch(ctx, 'webEditorMechanismCreate', { path }), (v) => ({ ok: true, ...v }));
  }

  @McpTool('Add a KinematicJoint to a mechanism. jointType = Revolute|Prismatic|Spherical|Universal. bodyBPath is required; OMIT bodyAPath to anchor the joint against WORLD/static space (the authored world-anchor form — an absent Body A, never an empty string). anchors are in millimetres in the respective body local frame; axisA is Body-A-local. NOTE: mechanism = the rigid-body joint graph, NOT the axis-group Kinematic system (see web_editor_list_kinematics). Undoable, one composite.', { readOnly: false, command: 'mechanism.addJoint' })
  async webEditorMechanismAddJoint(
    @McpParam('path', 'Node the joint component is added to (a child of the mechanism node).') path: string,
    @McpParam('jointType', 'Revolute | Prismatic | Spherical | Universal.') jointType: string,
    @McpParam('bodyBPath', 'Node path of Body B (required).') bodyBPath: string,
    @McpParam('bodyAPath', 'Node path of Body A. Omit for a world anchor.', 'string', false) bodyAPath: string,
    @McpParam('anchorAJson', 'Anchor A as JSON {x,y,z} in mm (Body-A-local).', 'string', false) anchorAJson: string,
    @McpParam('anchorBJson', 'Anchor B as JSON {x,y,z} in mm (Body-B-local).', 'string', false) anchorBJson: string,
    @McpParam('axisAJson', 'Axis A as JSON {x,y,z} (Body-A-local).', 'string', false) axisAJson: string,
    ctx?: McpCallContext,
  ): Promise<string> {
    return this._json(await this._dispatch(ctx, 'webEditorMechanismAddJoint', {
      path, jointType, bodyBPath, bodyAPath, anchorAJson, anchorBJson, axisAJson,
    }), (v) => ({ ok: true, ...v }));
  }

  @McpTool('Set a joint\'s anchor point(s), in millimetres, in the respective body local frame. Pass either or both. Both writes land in ONE composite, so an anchor snap is a single undo step. NOTE: mechanism = the rigid-body joint graph, NOT the axis-group Kinematic system (see web_editor_list_kinematics).', { readOnly: false })
  async webEditorMechanismSetAnchor(
    @McpParam('path', 'Node path of the joint.') path: string,
    @McpParam('componentType', 'Concrete joint key (e.g. KinematicJoint or KinematicJoint_1).') componentType: string,
    @McpParam('anchorAJson', 'Anchor A as JSON {x,y,z} in mm.', 'string', false) anchorAJson: string,
    @McpParam('anchorBJson', 'Anchor B as JSON {x,y,z} in mm.', 'string', false) anchorBJson: string,
  ): Promise<string> {
    const ctx = this._ctx();
    if (isGuardError(ctx)) return JSON.stringify(ctx);
    const bridge = await this._requireMechanismBridge();
    if (isMechError(bridge)) return JSON.stringify(bridge);
    const node = ctx.viewer.registry?.getNode(path);
    if (!node) return JSON.stringify({ error: `Node not found: ${path}` });
    if (!(componentType in rvOf(node))) {
      return JSON.stringify({ error: `No component "${componentType}" on ${path}`, components: Object.keys(rvOf(node)) });
    }
    const parse = (json: string) => {
      if (!json) return undefined;
      try {
        const p = JSON.parse(json) as { x?: number; y?: number; z?: number };
        return { x: Number(p.x ?? 0), y: Number(p.y ?? 0), z: Number(p.z ?? 0) };
      } catch { return undefined; }
    };
    const anchorA = parse(anchorAJson);
    const anchorB = parse(anchorBJson);
    if (!anchorA && !anchorB) return JSON.stringify({ error: 'Pass anchorAJson and/or anchorBJson as {"x":..,"y":..,"z":..}' });
    const m = await import('@rv-private/plugins/asset-editor/mechanism/mechanism-authoring');
    await this._mechCommit(ctx, bridge, path, m.planSetAnchor(path, componentType, { anchorA, anchorB }));
    return JSON.stringify({ ok: true, path, componentType, anchorA: anchorA ?? null, anchorB: anchorB ?? null });
  }

  @McpTool('Assign the Drive that actively controls a joint, or clear it. OMIT drivePath to make the joint PASSIVE again (the reference key is removed, which is the authored "no drive" form). NOTE: mechanism = the rigid-body joint graph, NOT the axis-group Kinematic system (see web_editor_list_kinematics). Undoable.', { readOnly: false, command: 'mechanism.assignDrive' })
  async webEditorMechanismAssignDrive(
    @McpParam('path', 'Node path of the joint.') path: string,
    @McpParam('componentType', 'Concrete joint key (e.g. KinematicJoint).') componentType: string,
    @McpParam('drivePath', 'Node path carrying the Drive. Omit to clear.', 'string', false) drivePath: string,
    ctx?: McpCallContext,
  ): Promise<string> {
    return this._json(
      await this._dispatch(ctx, 'webEditorMechanismAssignDrive', { path, componentType, drivePath }),
      (v) => ({ ok: true, ...v }),
    );
  }

  @McpTool('Validate a rigid-body mechanism: structured findings (MissingBodyB, SameBodyAAndB, UnresolvedBody, AnchorsApart, MissingSecondaryAxis, IdleSpinRod, NegativeDof, DriveAxisMismatch, DriveTypeMismatch) plus topology metrics. NOTE: mechanism = the rigid-body joint graph, NOT the axis-group Kinematic system (see web_editor_list_kinematics). TRANSIENT — creates no ops and no undo entry.', { readOnly: true })
  async webEditorMechanismValidate(
    @McpParam('path', 'Node path of the mechanism. Omit to validate all.', 'string', false) path: string,
  ): Promise<string> {
    const bridge = await this._requireMechanismBridge();
    if (isMechError(bridge)) return JSON.stringify(bridge);
    const target = path?.trim();
    if (target) {
      return JSON.stringify({ ok: true, path: target, findings: bridge.validate(target) });
    }
    return JSON.stringify({
      ok: true,
      mechanisms: bridge.list().map((m) => ({
        path: m.nodePath, name: m.name, active: m.active, converged: m.converged,
        residualError: m.residualError, disabledReason: m.disabledReason || null,
        joints: m.jointCount, links: m.linkCount, loops: m.loopCount, dof: m.dof,
        findings: m.findings,
      })),
    });
  }

  @McpTool('Jog one driven joint to an absolute value (degrees for Revolute, millimetres for Prismatic) and run ONE solve, reporting the REAL convergence and residual. TRANSIENT — writes a live drive value only, creates no ops and no undo entry. NOTE: mechanism = the rigid-body joint graph, NOT the axis-group Kinematic system (see web_editor_list_kinematics).', { readOnly: false, command: 'mechanism.jog' })
  async webEditorMechanismJog(
    @McpParam('path', 'Node path of the joint to jog.') path: string,
    @McpParam('value', 'Absolute joint value (deg or mm).', 'number') value: number,
    @McpParam('componentType', 'Concrete joint key (e.g. KinematicJoint_2) when several joints sit on one node. Omit for one-joint-per-node authoring.', 'string', false) componentType: string,
    ctx?: McpCallContext,
  ): Promise<string> {
    return this._json(
      await this._dispatch(ctx, 'webEditorMechanismJog', { path, value, componentType }),
      (v) => ({ ok: true, ...v }),
    );
  }

  /**
   * The private mechanism bridge, or the uniform refusal (plan-706 F14/R2).
   *
   * Sixteen of the eighteen mechanism tools open with this. The two that do NOT
   * are `web_editor_test_start` / `_stop`: the in-place test session exists
   * independently of mechanisms and must stay usable in a public build, where it
   * simply reports `forceRecording: false` instead of an error.
   *
   * Before plan-706 only `_validate` and `_jog` checked at all — the four
   * WRITING tools happily authored `KinematicMechanism` components into a build
   * with no solver behind them, which is document rubbish that only surfaces
   * when the asset reaches a Professional build.
   */
  private async _requireMechanismBridge(): Promise<MechanismUiBridge | { error: string }> {
    const { getMechanismUiBridge } = await import('../../core/engine/rv-kinematic-registry');
    return getMechanismUiBridge() ?? { error: MECHANISM_UNAVAILABLE };
  }


  /**
   * Run an authoring composite AND make the solver see it (plan-706 F2) — for
   * the one mechanism write tool that is not a command view
   * (`web_editor_mechanism_set_anchor`). The commands use the SAME function
   * (`commitMechanismPlan`: one transaction, `whenIdle`, then the rebuild of
   * every mechanism the write invalidates), so a direct tool and a button
   * cannot leave the solver in different states.
   */
  private async _mechCommit(
    ctx: ActiveAssetContext, bridge: MechanismUiBridge, targetPath: string, plan: MechanismOpPlan,
  ): Promise<void> {
    const m = await import('@rv-private/plugins/asset-editor/mechanism/mechanism-commands');
    await m.commitMechanismPlan(ctx.doc, ctx.viewer, targetPath, plan, bridge);
  }

  @McpTool('Read a rigid-body MECHANISM in full: joints (type, bodies, drive, current value, limits, world origin and axis, joggable), links with their mass properties (hasBody, massKg, comLocalMm = centre of mass (link frame, mm), massSource, massWarning), findings and convergence (converged, residualError, dof, loopCount). Each mechanism also carries cog, its CENTRE OF GRAVITY in the current pose: cogWorldMm (world mm, null when nothing contributed), totalMassKg, contributingLinks of totalLinks, skippedLinks with reasons, estimated, ambiguousOwnership, contributions — recomputed per call from the live pose, marker-independent. Omit path to read every mechanism; include keeps the answer small. NOTE: this is the joint-graph mechanism system, NOT the axis-group Kinematic system (see web_editor_list_kinematics). Read-only.', { readOnly: true })
  async webEditorMechanismInspect(
    @McpParam('path', 'Node path of one mechanism. Omit to read all.', 'string', false) path: string,
    @McpParam('include', 'Comma-separated subset of joints,links,findings (default all three).', 'string', false) include: string,
  ): Promise<string> {
    const bridge = await this._requireMechanismBridge();
    if (isMechError(bridge)) return JSON.stringify(bridge);
    const wanted = (include || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    const want = (key: string): boolean => wanted.length === 0 || wanted.includes(key);
    const target = path?.trim();
    const all = bridge.list();
    const mechanisms = target ? all.filter((m) => m.nodePath === target) : all;
    if (target && mechanisms.length === 0) {
      return JSON.stringify({
        error: `No mechanism at "${target}"`,
        availablePaths: all.map((m) => m.nodePath),
      });
    }
    return JSON.stringify({
      ok: true,
      mechanisms: mechanisms.map((m) => ({
        path: m.nodePath,
        name: m.name,
        active: m.active,
        converged: m.converged,
        residualError: m.residualError,
        solveTimeMs: m.solveTimeMs,
        disabledReason: m.disabledReason || null,
        jointCount: m.jointCount,
        linkCount: m.linkCount,
        loopCount: m.loopCount,
        dof: m.dof,
        // The views travel VERBATIM. Renaming a field here would create a second
        // vocabulary next to the panel's for the same facts, and an agent
        // reading `massSource` in one place and `mass_source` in the other has
        // no way to know they are the same thing.
        ...(want('joints') ? { joints: m.joints } : {}),
        ...(want('links') ? { links: m.links } : {}),
        // Unconditional, and NOT behind `include`: the centre of gravity is one small object,
        // it is the headline answer to "how heavy is this and where does it sit", and an agent
        // that narrowed `include` to keep the joint list out of its context would otherwise lose
        // it silently. `null` travels as `null` — never as an invented origin (plan-472).
        cog: m.cog ?? null,
        ...(want('findings') ? { findings: m.findings } : {}),
      })),
    });
  }

  // ── Mechanism paths (plan-729) ───────────────────────────────────────────
  //
  // Cartesian paths for a mechanism: MechanismTarget waypoints (the node's
  // world position IS the waypoint) sequenced by a MechanismPath, LIN or PTP per
  // waypoint. Composites of the generic ops like every other mechanism edit.
  // No mechanism rebuild after these writes: a path or a waypoint changes no
  // joint topology, and the path re-reads its list on every start.

  /** Run a path/target composite (no topology rebuild — see block note). */
  private async _pathCommit(ctx: ActiveAssetContext, plan: MechanismOpPlan): Promise<void> {
    // The ONE commit path since plan-504 (one transaction, then whenIdle); bridge
    // `null` = no solver rebuild, see the block note above.
    const m = await import('@rv-private/plugins/asset-editor/mechanism/mechanism-commands');
    await m.commitMechanismPlan(ctx.doc, ctx.viewer, '', plan, null);
  }

  /** The MechanismPath key on a node plus its current waypoint list, or a refusal. */
  private _pathOn(
    ctx: ActiveAssetContext, path: string,
  ): { key: string; waypoints: string[] } | { error: string; components?: string[] } {
    const node = ctx.viewer.registry?.getNode(path);
    if (!node) return { error: `Node not found: ${path}` };
    const rv = rvOf(node);
    const key = Object.keys(rv).find((k) => MECHANISM_PATH_KEY_RE.test(k));
    if (!key) {
      return {
        error: `"${path}" carries no MechanismPath — create one with web_editor_mechanism_path_create`,
        components: Object.keys(rv),
      };
    }
    const raw = (rv[key] as Record<string, unknown> | undefined)?.['Path'];
    const waypoints: string[] = [];
    if (Array.isArray(raw)) {
      for (const e of raw) {
        const p = e && typeof e === 'object' ? (e as Record<string, unknown>)['path'] : undefined;
        if (typeof p === 'string') waypoints.push(p);
      }
    }
    return { key, waypoints };
  }

  /** The current waypoint list of the path on `path` ([] when there is none). */
  private _waypointsOf(ctx: ActiveAssetContext, path: string): string[] {
    const on = this._pathOn(ctx, path);
    return 'error' in on ? [] : on.waypoints;
  }

  @McpTool('Make a node a MechanismTarget: a path waypoint whose node WORLD POSITION is the target (move the node to move it). interpolation = Linear | PointToPoint. NOTE: mechanism = the rigid-body joint graph, NOT the axis-group Kinematic system (see web_editor_list_kinematics). Undoable.', { readOnly: false })
  async webEditorMechanismAddTarget(
    @McpParam('path', 'Node that becomes the waypoint (its world position is the target).') path: string,
    @McpParam('interpolation', 'Linear | PointToPoint (default Linear).', 'string', false) interpolation: string,
    @McpParam('speedToTarget', 'Optional override: mm/s (Linear) or speed factor (PointToPoint).', 'number', false) speedToTarget: number,
    @McpParam('waitForSeconds', 'Dwell time after arrival in seconds (default 0).', 'number', false) waitForSeconds: number,
    @McpParam('mechanismPath', 'Optional KinematicMechanism node the waypoint belongs to.', 'string', false) mechanismPath: string,
  ): Promise<string> {
    const ctx = this._ctx();
    if (isGuardError(ctx)) return JSON.stringify(ctx);
    const bridge = await this._requireMechanismBridge();
    if (isMechError(bridge)) return JSON.stringify(bridge);
    const node = ctx.viewer.registry?.getNode(path);
    if (!node) return JSON.stringify({ error: `Node not found: ${path}` });
    if (Object.keys(rvOf(node)).some((k) => MECHANISM_TARGET_KEY_RE.test(k))) {
      return JSON.stringify({ error: `"${path}" already carries a MechanismTarget` });
    }
    const m = await import('@rv-private/plugins/asset-editor/mechanism/mechanism-authoring');
    const interp = (interpolation || 'Linear').trim();
    const kinds = m.WAYPOINT_INTERPOLATIONS as readonly string[];
    if (!kinds.includes(interp)) {
      return JSON.stringify({ error: `Unknown interpolation "${interpolation}"`, availableInterpolations: kinds });
    }
    const mech = mechanismPath?.trim() || null;
    if (mech && !ctx.viewer.registry?.getNode(mech)) {
      return JSON.stringify({ error: `Mechanism node not found: ${mech}` });
    }
    const speed = Number(speedToTarget);
    const wait = Number(waitForSeconds);
    await this._pathCommit(ctx, m.planCreateTarget(path, {
      interpolation: interp as 'Linear' | 'PointToPoint',
      speedToTarget: Number.isFinite(speed) && speed > 0 ? speed : undefined,
      waitForSeconds: Number.isFinite(wait) && wait > 0 ? wait : 0,
      mechanismPath: mech,
    }));
    return JSON.stringify({ ok: true, path, component: 'MechanismTarget', interpolation: interp });
  }

  @McpTool('Create a MechanismPath: the mechanism it drives, the TargetLink whose origin follows the path (a Delta: the platform) and optional ordered waypoints. Stops hard on an unreachable waypoint. NOTE: mechanism = the rigid-body joint graph, NOT the axis-group Kinematic system (see web_editor_list_kinematics). Undoable.', { readOnly: false })
  async webEditorMechanismPathCreate(
    @McpParam('path', 'Node the MechanismPath component is added to.') path: string,
    @McpParam('mechanismPath', 'Node carrying the KinematicMechanism.') mechanismPath: string,
    @McpParam('targetLinkPath', 'The mechanism link whose origin follows the path.') targetLinkPath: string,
    @McpParam('waypointPaths', 'Comma-separated MechanismTarget node paths, in order.', 'string', false) waypointPaths: string,
    @McpParam('loopPath', 'Restart after the last waypoint (default false).', 'boolean', false) loopPath: boolean,
    @McpParam('linearSpeed', 'LIN speed in mm/s (default 500).', 'number', false) linearSpeed: number,
    @McpParam('linearAcceleration', 'LIN acceleration in mm/s² (default 1000).', 'number', false) linearAcceleration: number,
  ): Promise<string> {
    const ctx = this._ctx();
    if (isGuardError(ctx)) return JSON.stringify(ctx);
    const bridge = await this._requireMechanismBridge();
    if (isMechError(bridge)) return JSON.stringify(bridge);
    const reg = ctx.viewer.registry;
    const node = reg?.getNode(path);
    if (!node) return JSON.stringify({ error: `Node not found: ${path}` });
    if (Object.keys(rvOf(node)).some((k) => MECHANISM_PATH_KEY_RE.test(k))) {
      return JSON.stringify({ error: `"${path}" already carries a MechanismPath` });
    }
    const mechNode = reg?.getNode(mechanismPath);
    if (!mechNode || !Object.keys(rvOf(mechNode)).some((k) => MECHANISM_KEY_RE.test(k))) {
      return JSON.stringify({
        error: `"${mechanismPath}" is not a KinematicMechanism node`,
        availableMechanisms: bridge.list().map((mm) => mm.nodePath),
      });
    }
    if (!reg?.getNode(targetLinkPath)) return JSON.stringify({ error: `Target link node not found: ${targetLinkPath}` });
    const waypoints = parsePathsParam(waypointPaths);
    for (const w of waypoints) {
      const wn = reg?.getNode(w);
      if (!wn || !Object.keys(rvOf(wn)).some((k) => MECHANISM_TARGET_KEY_RE.test(k))) {
        return JSON.stringify({ error: `"${w}" is not a MechanismTarget — add one with web_editor_mechanism_add_target` });
      }
    }
    const lin = Number(linearSpeed);
    const acc = Number(linearAcceleration);
    const m = await import('@rv-private/plugins/asset-editor/mechanism/mechanism-authoring');
    await this._pathCommit(ctx, m.planCreatePath(path, mechanismPath, targetLinkPath, {
      waypoints,
      loopPath: loopPath === true,
      linearSpeedToTarget: Number.isFinite(lin) && lin > 0 ? lin : undefined,
      linearAcceleration: Number.isFinite(acc) && acc > 0 ? acc : undefined,
    }));
    return JSON.stringify({ ok: true, path, component: 'MechanismPath', mechanism: mechanismPath, targetLink: targetLinkPath, waypoints });
  }

  @McpTool('Insert a MechanismTarget into a mechanism path waypoint list, at index or appended. NOTE: mechanism = the rigid-body joint graph, NOT the axis-group Kinematic system (see web_editor_list_kinematics). Undoable.', { readOnly: false })
  async webEditorMechanismPathAddWaypoint(
    @McpParam('path', 'Node carrying the MechanismPath.') path: string,
    @McpParam('waypointPath', 'Node carrying the MechanismTarget.') waypointPath: string,
    @McpParam('index', 'Insert position (0-based). Omit to append.', 'integer', false) index: number,
  ): Promise<string> {
    const ctx = this._ctx();
    if (isGuardError(ctx)) return JSON.stringify(ctx);
    const bridge = await this._requireMechanismBridge();
    if (isMechError(bridge)) return JSON.stringify(bridge);
    const on = this._pathOn(ctx, path);
    if ('error' in on) return JSON.stringify(on);
    const wn = ctx.viewer.registry?.getNode(waypointPath);
    if (!wn || !Object.keys(rvOf(wn)).some((k) => MECHANISM_TARGET_KEY_RE.test(k))) {
      return JSON.stringify({ error: `"${waypointPath}" is not a MechanismTarget — add one with web_editor_mechanism_add_target` });
    }
    const at = Number.isInteger(Number(index)) && index !== undefined && index !== null ? Number(index) : undefined;
    const m = await import('@rv-private/plugins/asset-editor/mechanism/mechanism-authoring');
    const plan = m.planAddWaypoint(path, on.waypoints, waypointPath, at, on.key);
    await this._pathCommit(ctx, plan);
    return JSON.stringify({ ok: true, path, waypoints: this._waypointsOf(ctx, path) });
  }

  @McpTool('Remove the waypoint at index from a mechanism path list; the node stays. NOTE: mechanism = the rigid-body joint graph, NOT the axis-group Kinematic system (see web_editor_list_kinematics). Undoable.', { readOnly: false })
  async webEditorMechanismPathRemoveWaypoint(
    @McpParam('path', 'Node carrying the MechanismPath.') path: string,
    @McpParam('index', 'Waypoint position to remove (0-based).', 'integer') index: number,
  ): Promise<string> {
    const ctx = this._ctx();
    if (isGuardError(ctx)) return JSON.stringify(ctx);
    const bridge = await this._requireMechanismBridge();
    if (isMechError(bridge)) return JSON.stringify(bridge);
    const on = this._pathOn(ctx, path);
    if ('error' in on) return JSON.stringify(on);
    const i = Number(index);
    if (!Number.isInteger(i) || i < 0 || i >= on.waypoints.length) {
      return JSON.stringify({ error: `index ${index} out of range`, waypoints: on.waypoints });
    }
    const m = await import('@rv-private/plugins/asset-editor/mechanism/mechanism-authoring');
    await this._pathCommit(ctx, m.planRemoveWaypoint(path, on.waypoints, i, on.key));
    return JSON.stringify({ ok: true, path, removed: on.waypoints[i], waypoints: this._waypointsOf(ctx, path) });
  }

  @McpTool('Move one waypoint of a mechanism path from index from to index to. NOTE: mechanism = the rigid-body joint graph, NOT the axis-group Kinematic system (see web_editor_list_kinematics). Undoable.', { readOnly: false })
  async webEditorMechanismPathMoveWaypoint(
    @McpParam('path', 'Node carrying the MechanismPath.') path: string,
    @McpParam('from', 'Current waypoint position (0-based).', 'integer') from: number,
    @McpParam('to', 'New waypoint position (0-based).', 'integer') to: number,
  ): Promise<string> {
    const ctx = this._ctx();
    if (isGuardError(ctx)) return JSON.stringify(ctx);
    const bridge = await this._requireMechanismBridge();
    if (isMechError(bridge)) return JSON.stringify(bridge);
    const on = this._pathOn(ctx, path);
    if ('error' in on) return JSON.stringify(on);
    const f = Number(from);
    const t = Number(to);
    const n = on.waypoints.length;
    if (!Number.isInteger(f) || !Number.isInteger(t) || f < 0 || f >= n || t < 0 || t >= n) {
      return JSON.stringify({ error: `from/to out of range (0..${n - 1})`, waypoints: on.waypoints });
    }
    if (f === t) return JSON.stringify({ ok: true, path, unchanged: true, waypoints: on.waypoints });
    const m = await import('@rv-private/plugins/asset-editor/mechanism/mechanism-authoring');
    await this._pathCommit(ctx, m.planReorderWaypoints(path, on.waypoints, f, t, on.key));
    return JSON.stringify({ ok: true, path, waypoints: this._waypointsOf(ctx, path) });
  }

  @McpTool('Read mechanism paths: waypoints (interpolation, dwell, world mm) and runtime status incl. lastError (why a path stopped). Omit path to read all. NOTE: mechanism = the rigid-body joint graph, NOT the axis-group Kinematic system (see web_editor_list_kinematics). Read-only.', { readOnly: true })
  async webEditorMechanismPathInspect(
    @McpParam('path', 'Node carrying one MechanismPath. Omit to read all.', 'string', false) path: string,
  ): Promise<string> {
    const bridge = await this._requireMechanismBridge();
    if (isMechError(bridge)) return JSON.stringify(bridge);
    const all = bridge.listPaths?.() ?? [];
    const target = path?.trim();
    const paths = target ? all.filter((p) => p.nodePath === target) : all;
    if (target && paths.length === 0) {
      return JSON.stringify({ error: `No MechanismPath at "${target}"`, availablePaths: all.map((p) => p.nodePath) });
    }
    return JSON.stringify({ ok: true, paths });
  }

  // ── Drive sizing from a sampled trajectory (plan-501) ─────────────────────
  //
  // A MechanismTrajectory is one sizing case: sampled TCP path + payload. Import writes the
  // samples (undoable composite, validated by the component on every path); run / inspect /
  // export are transient bridge calls — the run lives in the bridge, so the panel sees it too.

  @McpTool('Import a sampled TCP path CSV (time;X;Y;Z in mm) into a MechanismTrajectory for drive sizing; creates the trajectory when mechanismPath and targetLinkPath are given. NOTE: mechanism = the rigid-body joint graph, NOT the axis-group Kinematic system (see web_editor_list_kinematics). Undoable.', { readOnly: false })
  async webEditorMechanismTrajectoryImport(
    @McpParam('path', 'Node carrying (or receiving) the MechanismTrajectory.') path: string,
    @McpParam('csv', 'CSV text with a header (time, X, Y, Z; velocity/acceleration columns are ignored).', 'string', false) csv: string,
    @McpParam('relPath', 'Project-relative CSV file instead of csv text.', 'string', false) relPath: string,
    @McpParam('mechanismPath', 'KinematicMechanism node — only when creating the trajectory.', 'string', false) mechanismPath: string,
    @McpParam('targetLinkPath', 'Mechanism link carrying the TCP — only when creating.', 'string', false) targetLinkPath: string,
    @McpParam('name', 'Name of the sizing case (prefix of the axis files).', 'string', false) name: string,
  ): Promise<string> {
    const ctx = this._ctx();
    if (isGuardError(ctx)) return JSON.stringify(ctx);
    const bridge = await this._requireMechanismBridge();
    if (isMechError(bridge)) return JSON.stringify(bridge);
    if (!bridge.parseTrajectoryCsv) return JSON.stringify({ error: 'This build has no drive-sizing trajectories' });
    const reg = ctx.viewer.registry;
    const node = reg?.getNode(path);
    if (!node) return JSON.stringify({ error: `Node not found: ${path}` });
    let text = csv ?? '';
    if (!text.trim() && relPath?.trim()) {
      const read = await this._readProjectFile(relPath);
      if ('error' in read) return JSON.stringify(read);
      text = new TextDecoder().decode(read.bytes);
    }
    if (!text.trim()) return JSON.stringify({ error: 'Pass csv text or a project-relative relPath' });
    const parsed = bridge.parseTrajectoryCsv(text);
    if (!parsed.ok) return JSON.stringify({ error: `CSV refused: ${parsed.error}` });
    const m = await import('@rv-private/plugins/asset-editor/mechanism/mechanism-authoring');
    const key = Object.keys(rvOf(node)).find((k) => MECHANISM_TRAJECTORY_KEY_RE.test(k));
    if (key) {
      await this._pathCommit(ctx, m.planSetTrajectorySamples(path, parsed.samples, parsed.intervalMs, key));
    } else {
      const mech = mechanismPath?.trim();
      const link = targetLinkPath?.trim();
      if (!mech || !link) {
        return JSON.stringify({ error: `"${path}" carries no MechanismTrajectory — pass mechanismPath and targetLinkPath to create one` });
      }
      const mechNode = reg?.getNode(mech);
      if (!mechNode || !Object.keys(rvOf(mechNode)).some((k) => MECHANISM_KEY_RE.test(k))) {
        return JSON.stringify({ error: `"${mech}" is not a KinematicMechanism node`, availableMechanisms: bridge.list().map((mm) => mm.nodePath) });
      }
      if (!reg?.getNode(link)) return JSON.stringify({ error: `Target link node not found: ${link}` });
      await this._pathCommit(ctx, m.planCreateTrajectory(path, mech, link, {
        name: name?.trim() || undefined,
        samples: parsed.samples,
        sampleIntervalMs: parsed.intervalMs,
      }));
    }
    const view = (bridge.listTrajectories?.() ?? []).find((t) => t.nodePath === path) ?? null;
    return JSON.stringify({
      ok: true, path, sampleCount: parsed.sampleCount, intervalMs: parsed.intervalMs,
      warnings: parsed.warnings, findings: view?.findings ?? [],
    });
  }

  @McpTool('Run the offline drive sizing of a MechanismTrajectory: inverse solve, forward solve and inverse dynamics per sample in its own raster; returns peak and RMS torque per axis. NOTE: mechanism = the rigid-body joint graph, NOT the axis-group Kinematic system (see web_editor_list_kinematics). Changes no document.', { readOnly: false, timeoutMs: 600_000 })
  async webEditorMechanismTrajectoryRun(
    @McpParam('path', 'Node carrying the MechanismTrajectory.') path: string,
  ): Promise<string> {
    const bridge = await this._requireMechanismBridge();
    if (isMechError(bridge)) return JSON.stringify(bridge);
    if (!bridge.runTrajectory) return JSON.stringify({ error: 'This build has no drive-sizing trajectories' });
    const res = await bridge.runTrajectory(path?.trim() ?? '');
    if ('error' in res) {
      return JSON.stringify({ ...res, availableTrajectories: (bridge.listTrajectories?.() ?? []).map((t) => t.nodePath) });
    }
    return JSON.stringify({ ok: res.run?.state === 'done', trajectory: res });
  }

  @McpTool('Read MechanismTrajectories: configuration, findings, last sizing run and, for one path, the run series downsampled to at most maxPoints. NOTE: mechanism = the rigid-body joint graph, NOT the axis-group Kinematic system (see web_editor_list_kinematics). Read-only.', { readOnly: true })
  async webEditorMechanismTrajectoryInspect(
    @McpParam('path', 'Node carrying one MechanismTrajectory. Omit to read all.', 'string', false) path: string,
    @McpParam('maxPoints', 'Series points per axis (default 200, at most 200).', 'integer', false) maxPoints: number,
  ): Promise<string> {
    const bridge = await this._requireMechanismBridge();
    if (isMechError(bridge)) return JSON.stringify(bridge);
    const all = bridge.listTrajectories?.() ?? [];
    const target = path?.trim();
    if (!target) return JSON.stringify({ ok: true, trajectories: all });
    const one = all.find((t) => t.nodePath === target);
    if (!one) return JSON.stringify({ error: `No MechanismTrajectory at "${target}"`, availableTrajectories: all.map((t) => t.nodePath) });
    const n = Number(maxPoints);
    const cap = Number.isFinite(n) && n > 1 ? Math.min(200, Math.floor(n)) : 200;
    return JSON.stringify({ ok: true, trajectory: one, series: bridge.trajectorySeries?.(target, cap) ?? null });
  }

  @McpTool('Export the last sizing run of a MechanismTrajectory as SERVOsoft axis texts (Tab, decimal comma, CRLF), one per driven axis; refuses a stale, incomplete or failed run. NOTE: mechanism = the rigid-body joint graph, NOT the axis-group Kinematic system (see web_editor_list_kinematics). Read-only.', { readOnly: true })
  async webEditorMechanismTrajectoryExport(
    @McpParam('path', 'Node carrying the MechanismTrajectory.') path: string,
  ): Promise<string> {
    const bridge = await this._requireMechanismBridge();
    if (isMechError(bridge)) return JSON.stringify(bridge);
    if (!bridge.exportTrajectory) return JSON.stringify({ error: 'This build has no drive-sizing trajectories' });
    const res = bridge.exportTrajectory(path?.trim() ?? '');
    if (!res.ok) return JSON.stringify({ error: 'Export refused', findings: res.findings });
    return JSON.stringify({ ok: true, files: res.files });
  }

  @McpTool('List the SNAP CANDIDATES under a canvas point (x,y as 0..1 fractions) so an anchor or a joint axis can be set on real geometry instead of guessed millimetres: bore axes, circle centres, edge/face centres and vertices, each with a stable id, a world position and a world normal. Exactly one is recommended — what a click would take. Aim the camera first (web_camera_focus), then pass the ids to web_editor_mechanism_set_anchor_snap or _set_axis. Ids ("snap<gen>-<i>") live until the next call and belong to this document. NOTE: mechanism = joint graph, NOT the axis-group Kinematic system (see web_editor_list_kinematics).', { readOnly: true })
  async webEditorMechanismSnapList(
    @McpParam('x', 'Horizontal position, fraction 0..1 of canvas width.', 'number') x: number,
    @McpParam('y', 'Vertical position, fraction 0..1 of canvas height.', 'number') y: number,
    @McpParam('maxCandidates', 'Cap on returned candidates (default 12).', 'integer', false) maxCandidates: number,
  ): Promise<string> {
    // requireEditor DESPITE readOnly: the gate here is the PICK PATH, not the
    // write direction. Outside an authoring load a `BatchTable` exists and the
    // triangle refinement would return a faceIndex into a render arena whose
    // triangles belong to no single node — silently wrong candidates rather
    // than an error (plan-706 R9).
    const ctx = this._ctx();
    if (isGuardError(ctx)) return JSON.stringify(ctx);
    const bridge = await this._requireMechanismBridge();
    if (isMechError(bridge)) return JSON.stringify(bridge);
    const v = ctx.viewer;
    const canvas = v.renderer?.domElement;
    if (!canvas) return JSON.stringify({ error: 'No canvas' });
    const rect = canvas.getBoundingClientRect();
    const fx = clamp01(Number(x), 0.5);
    const fy = clamp01(Number(y), 0.5);

    const { querySnapCandidates } = await import('@rv-private/plugins/asset-editor/mechanism/mechanism-snap-query');
    const cap = Math.max(1, Math.round(Number(maxCandidates) || 12));
    const result = querySnapCandidates(
      v, rect.left + fx * rect.width, rect.top + fy * rect.height, { maxCandidates: cap },
    );
    // plan-504: the listing lives with the snap module (shared with the
    // `mechanism.setAnchorSnap` / `mechanism.setAxis` commands). Ids carry the
    // listing generation and are bound to this document — `snap<gen>-<i>`.
    const snapCache = await import('@rv-private/plugins/asset-editor/mechanism/mechanism-commands');
    if (!result) {
      snapCache.clearSnapListing();
      return JSON.stringify({ ok: true, hit: false, candidates: [], hint: 'Nothing under that point — reframe with web_camera_focus and try again' });
    }

    const documentKey = commandRegistry.captureContext(v).handle?.documentKey ?? null;
    const listed: {
      id: string; kind: string; label: string; nodePath: string; worldPosition: Vector3; worldNormal: Vector3;
      radius?: number; inner?: boolean; recommended: boolean;
    }[] = snapCache.recordSnapListing(documentKey, result.candidates.map((c) => ({
      kind: c.kind,
      label: c.label,
      nodePath: result.nodePath,
      worldPosition: c.worldPosition,
      worldNormal: c.worldNormal,
      radius: c.radius,
      inner: c.inner,
      recommended: c.recommended,
    })));
    return JSON.stringify({
      ok: true,
      hit: true,
      hitPath: result.nodePath,
      candidates: listed.map((c) => ({
        id: c.id,
        kind: c.kind,
        label: c.label,
        nodePath: c.nodePath,
        worldPosition: c.worldPosition.toArray().map(r3),
        worldNormal: c.worldNormal.toArray().map(r3),
        ...(c.radius !== undefined ? { radius: r3(c.radius) } : {}),
        ...(c.inner !== undefined ? { inner: c.inner } : {}),
        recommended: c.recommended,
      })),
    });
  }

  @McpTool('Set a joint anchor from a snap candidate listed by web_editor_mechanism_snap_list — the geometrically exact alternative to typing millimetres into web_editor_mechanism_set_anchor. Pass exactly ONE source: candidateId, or pickJson (a picked point, what the panel\'s Anchor A/B pick sends). Writes AnchorA or AnchorB in the body-local frame and, unless assignBody=false, assigns the picked part as that side\'s body — ONE composite, one undo step. NOTE: mechanism = joint graph, NOT the axis-group Kinematic system (see web_editor_list_kinematics). Undoable.', { readOnly: false, command: 'mechanism.setAnchorSnap' })
  async webEditorMechanismSetAnchorSnap(
    @McpParam('path', 'Node path of the joint.') path: string,
    @McpParam('componentType', 'Concrete joint key (e.g. KinematicJoint or KinematicJoint_1).') componentType: string,
    @McpParam('side', 'A | B — which side of the joint the point belongs to.') side: string,
    @McpParam('candidateId', 'Id from the LATEST web_editor_mechanism_snap_list, e.g. "snap3-0". Omit when passing pickJson.', 'string', false) candidateId: string,
    @McpParam('assignBody', 'Also assign the picked node as this side\'s body (default true).', 'boolean', false) assignBody: boolean,
    @McpParam('pickJson', 'Instead of candidateId: {"nodePath":..,"worldPosition":[x,y,z],"worldNormal":[x,y,z]} in world space.', 'string', false) pickJson: string,
    ctx?: McpCallContext,
  ): Promise<string> {
    return this._json(
      await this._dispatch(ctx, 'webEditorMechanismSetAnchorSnap', { path, componentType, side, candidateId, assignBody, pickJson }),
      (v) => ({ ok: true, ...v }),
    );
  }

  @McpTool('Set a joint\'s axis (AxisA, body-A-local) either from a snap candidate — a bore\'s normal IS its axis, so candidateId is the accurate route — or from an explicit world vector. Optionally set SecondaryAxisB for a Universal joint, and snapToPrincipal to magnet a nearly-axis-aligned direction onto X/Y/Z. NOTE: mechanism = joint graph, NOT the axis-group Kinematic system (see web_editor_list_kinematics). Undoable, one composite.', { readOnly: false, command: 'mechanism.setAxis' })
  async webEditorMechanismSetAxis(
    @McpParam('path', 'Node path of the joint.') path: string,
    @McpParam('componentType', 'Concrete joint key (e.g. KinematicJoint).') componentType: string,
    @McpParam('candidateId', 'Snap id whose normal becomes the axis (from web_editor_mechanism_snap_list).', 'string', false) candidateId: string,
    @McpParam('axisWorldJson', 'Axis as JSON {x,y,z} in WORLD space, when no candidateId is given.', 'string', false) axisWorldJson: string,
    @McpParam('secondaryAxisWorldJson', 'Universal joints only: second axis as JSON {x,y,z} in WORLD space.', 'string', false) secondaryAxisWorldJson: string,
    @McpParam('snapToPrincipal', 'Magnet the axis onto the nearest world X/Y/Z when within 5° (default false).', 'boolean', false) snapToPrincipal: boolean,
    ctx?: McpCallContext,
  ): Promise<string> {
    return this._json(
      await this._dispatch(ctx, 'webEditorMechanismSetAxis', {
        path, componentType, candidateId, axisWorldJson, secondaryAxisWorldJson, snapToPrincipal,
      }),
      (v) => ({ ok: true, ...v }),
    );
  }

  @McpTool('Add a MechanismBody to a link so the force analysis has a mass for it — without one the inverse dynamics reports "a link without mass" and every drive figure stays empty. densityPreset = steel|stainless|aluminum|pa|pom|custom. The mass itself is computed from the link\'s geometry and never stored, so it cannot go stale; use web_editor_mechanism_set_mass to override it. NOTE: mechanism = joint graph, NOT the axis-group Kinematic system (see web_editor_list_kinematics). Undoable.', { readOnly: false, command: 'mechanism.addBody' })
  async webEditorMechanismAddBody(
    @McpParam('path', 'Node path of the link to give a body.') path: string,
    @McpParam('densityPreset', 'steel | stainless | aluminum | pa | pom | custom (default steel).', 'string', false) densityPreset: string,
    ctx?: McpCallContext,
  ): Promise<string> {
    return this._json(
      await this._dispatch(ctx, 'webEditorMechanismAddBody', { path, densityPreset }),
      (v) => ({ ok: true, ...v }),
    );
  }

  @McpTool('Set how heavy a link is — density preset, custom density, a pinned mass and a pinned centre of mass — in ONE composite and one undo step, because they are one decision. massKg="null" or comJson="null" DROP the respective override and return to the value computed from the geometry. Without masses the force figures are meaningless, so do this before reading web_editor_mechanism_forces. NOTE: mechanism = joint graph, NOT the axis-group Kinematic system (see web_editor_list_kinematics). Undoable.', { readOnly: false, command: 'mechanism.setMass' })
  async webEditorMechanismSetMass(
    @McpParam('path', 'Node path of the link (must already carry a MechanismBody).') path: string,
    @McpParam('densityPreset', 'steel | stainless | aluminum | pa | pom | custom.', 'string', false) densityPreset: string,
    @McpParam('densityKgM3', 'Density in kg/m³ — only meaningful with densityPreset=custom.', 'number', false) densityKgM3: number,
    @McpParam('massKg', 'Pinned mass in kg, or the string "null" to drop the override.', 'string', false) massKg: string,
    @McpParam('comJson', 'Centre of mass as JSON {x,y,z} in link-local mm, or "null" to drop it.', 'string', false) comJson: string,
    ctx?: McpCallContext,
  ): Promise<string> {
    // The three panel controls are ONE command: each control passes one arg,
    // this call may pass several — one plan, one transaction, one undo step.
    return this._json(
      await this._dispatch(ctx, 'webEditorMechanismSetMass', { path, densityPreset, densityKgM3, massKg, comJson }),
      (v) => ({ ok: true, ...v }),
    );
  }

  @McpTool('Set or clear a joint\'s motion limits — the travel a jog or a drive may use. useLimits=false switches them off and the bounds are ignored; useLimits=true takes lower/upper in degrees (Revolute) or millimetres (Prismatic). Read the current values with web_editor_mechanism_inspect. NOTE: mechanism = joint graph, NOT the axis-group Kinematic system (see web_editor_list_kinematics). Undoable, one composite.', { readOnly: false, command: 'mechanism.setLimits' })
  async webEditorMechanismSetLimits(
    @McpParam('path', 'Node path of the joint.') path: string,
    @McpParam('componentType', 'Concrete joint key (e.g. KinematicJoint).') componentType: string,
    @McpParam('useLimits', 'true to enforce the bounds, false to switch limits off.', 'boolean') useLimits: boolean,
    @McpParam('lower', 'Lower bound (deg or mm) — only with useLimits=true.', 'number', false) lower: number,
    @McpParam('upper', 'Upper bound (deg or mm) — only with useLimits=true.', 'number', false) upper: number,
    ctx?: McpCallContext,
  ): Promise<string> {
    return this._json(
      await this._dispatch(ctx, 'webEditorMechanismSetLimits', { path, componentType, useLimits, lower, upper }),
      (v) => ({ ok: true, ...v }),
    );
  }

  /** Shape one forces snapshot for the wire (the same serialisation `mechanism.statics` answers with). */
  private _forcesJson(
    snapshot: import('../../core/engine/rv-kinematic-registry').MechanismForcesSnapshot,
    recorder: import('../mechanism-force-recorder-plugin').MechanismForceRecorder,
    opts: { channelId?: string; series?: DownsampledSeries | null } = {},
  ): Record<string, unknown> {
    return mechanismForcesJson(snapshot, recorder, opts);
  }

  @McpTool('Read the DRIVE SIZING figures of a mechanism: per channel the current value plus peak, time-weighted RMS and holding force with their unit, and per joint the world reaction force and torque. This is what turns a built mechanism into a motor choice — continuous rating above RMS, peak rating above peak. Record a cycle first with web_editor_test_start/_stop; holding comes from web_editor_mechanism_statics. With channelId and series=true one channel also carries a downsampled time series. NOTE: mechanism = the rigid-body joint graph, NOT the axis-group Kinematic system (see web_editor_list_kinematics). Read-only.', { readOnly: true })
  async webEditorMechanismForces(
    @McpParam('mechanismPath', 'Node path of the mechanism.') mechanismPath: string,
    @McpParam('channelId', 'Channel id from a previous call — required for series.', 'string', false) channelId: string,
    @McpParam('series', 'Also return the recorded time series for channelId, downsampled (default false).', 'boolean', false) series: boolean,
  ): Promise<string> {
    const bridge = await this._requireMechanismBridge();
    if (isMechError(bridge)) return JSON.stringify(bridge);
    const v = this.viewer;
    if (!v) return JSON.stringify({ error: 'No viewer' });
    const path = (mechanismPath || '').trim();
    if (!path) return JSON.stringify({ error: 'mechanismPath is required' });
    const snapshot = bridge.forcesSnapshot(path);
    if (!snapshot) {
      return JSON.stringify({
        error: `No force snapshot for "${path}" — the mechanism is unknown or the analysis was never armed (run web_editor_test_start)`,
        availablePaths: bridge.list().map((m) => m.nodePath),
      });
    }
    const { ensureForceRecorder } = await import('../mechanism-force-recorder-plugin');
    const recorder = ensureForceRecorder(v).recorder;

    let reduced: DownsampledSeries | null = null;
    const wantedId = channelId?.trim();
    if (series === true && wantedId) {
      const recorded = recorder.getSeries(wantedId);
      if (recorded) {
        const { downsampleSeries } = await import('@rv-private/plugins/asset-editor/mechanism/mechanism-force-downsample');
        const times = recorder.timeBuffer.toArray();
        const values = recorded.values.toArray();
        // The shared time buffer and a series wrap independently; only the
        // overlapping tail is index-aligned, and `dt` is read from it rather
        // than assumed, so a paused window does not silently re-date the curve.
        const n = Math.min(times.length, values.length);
        const tail = values.slice(values.length - n);
        const tTail = times.slice(times.length - n);
        const dt = n > 1 ? (tTail[n - 1] - tTail[0]) / (n - 1) : 1 / FORCE_SAMPLE_RATE_HZ;
        reduced = downsampleSeries(tail, dt, SERIES_MAX_POINTS, tTail[0] ?? 0);
      }
    }
    const out = this._forcesJson(snapshot, recorder, { channelId: wantedId, series: reduced });
    if (series === true && !wantedId) out.seriesNote = 'series needs a channelId — pick one from channels[]';
    return JSON.stringify(out);
  }

  @McpTool('Solve the HOLDING forces of a mechanism in its current pose (velocity and acceleration zero) and file them as each channel\'s holding figure — "what does it take to just hold this here", answerable without running the machine. Returns the same shape as web_editor_mechanism_forces with holding filled. Changes no pose and appends no undo entry, but it does replace the previously recorded holding numbers, which the panel shows. NOTE: mechanism = the rigid-body joint graph, NOT the axis-group Kinematic system (see web_editor_list_kinematics).', { readOnly: false, command: 'mechanism.statics' })
  async webEditorMechanismStatics(
    @McpParam('mechanismPath', 'Node path of the mechanism.') mechanismPath: string,
    ctx?: McpCallContext,
  ): Promise<string> {
    // The value already IS the forces answer (`mechanismForcesJson`, with ok:true).
    return this._json(await this._dispatch(ctx, 'webEditorMechanismStatics', { mechanismPath }));
  }

  @McpTool('Apply the auto-fix of a FIXABLE finding on a joint and persist it as an ordinary field composite, so it undoes like a manual edit. Get the code from the findings of web_editor_mechanism_inspect or web_editor_mechanism_validate — only entries with fixable=true have one. NOTE: mechanism = joint graph, NOT the axis-group Kinematic system (see web_editor_list_kinematics). Undoable.', { readOnly: false, command: 'mechanism.fix' })
  async webEditorMechanismFix(
    @McpParam('path', 'Node path of the joint the finding concerns.') path: string,
    @McpParam('code', 'Finding code, e.g. AnchorsApart or MissingSecondaryAxis.') code: string,
    ctx?: McpCallContext,
  ): Promise<string> {
    return this._json(await this._dispatch(ctx, 'webEditorMechanismFix', { path, code }), (v) => ({ ok: true, ...v }));
  }

  // ═══ In-place test session (plan-410, driven per plan-706 F12) ═════════════
  //
  // These two are the ONLY mechanism-area tools that do not require the private
  // bridge: the test session materialises the authoring state and attaches the
  // runtime, which is meaningful with or without a rigid-body solver. Without
  // the bridge they simply report `forceRecording: false` — an honest fact, not
  // an error (§2.5).

  @McpTool('Start the editor\'s IN-PLACE TEST session: the authoring state is materialised through the real save path and the runtime is attached, so drives, logic and mechanisms actually run. Also arms the mechanism force recording, which is what makes web_editor_mechanism_forces return a cycle afterwards. Stop with web_editor_test_stop, which restores the authoring state exactly. Reports the state reached and whether force recording is on.', { readOnly: false, timeoutMs: 120_000 })
  async webEditorTestStart(): Promise<string> {
    const ctx = this._ctx();
    if (isGuardError(ctx)) return JSON.stringify(ctx);
    const { getActiveTestSession } = await import('@rv-private/plugins/asset-editor/test-session-store');
    const session = getActiveTestSession();
    if (!session) {
      return JSON.stringify({ error: 'No test session available — open the asset editor first (web_editor_open)' });
    }
    // Install the recorder BEFORE starting: its session subscription is what
    // arms the analysis, and a plugin that does not exist yet cannot subscribe.
    const { ensureForceRecorder } = await import('../mechanism-force-recorder-plugin');
    const plugin = ensureForceRecorder(ctx.viewer);
    await session.start();
    return JSON.stringify({
      ok: true, state: session.state, forceRecording: plugin.recorder.recording,
    });
  }

  @McpTool('Stop the editor\'s in-place test session and put the authoring state back exactly as it was before the run. The recorded force buffers are KEPT — "what did that cycle need?" is asked after the cycle — so web_editor_mechanism_forces still answers with peak and RMS afterwards. Reports the state reached and whether force recording is (still) on.', { readOnly: false, timeoutMs: 120_000 })
  async webEditorTestStop(): Promise<string> {
    const ctx = this._ctx();
    if (isGuardError(ctx)) return JSON.stringify(ctx);
    const { getActiveTestSession } = await import('@rv-private/plugins/asset-editor/test-session-store');
    const session = getActiveTestSession();
    if (!session) {
      return JSON.stringify({ error: 'No test session available — open the asset editor first (web_editor_open)' });
    }
    const { ensureForceRecorder } = await import('../mechanism-force-recorder-plugin');
    const plugin = ensureForceRecorder(ctx.viewer);
    await session.stop();
    return JSON.stringify({
      ok: true, state: session.state, forceRecording: plugin.recorder.recording,
    });
  }

  @McpTool('Create a new kinematic axis: an empty top-level node with a Kinematic component linked to a fresh group (Quick Edit "Add Kinematic"). Assign members afterwards with web_editor_assign_to_kinematic. Returns the axis path + group name.', { readOnly: false, command: 'editor.createKinematic' })
  async webEditorCreateKinematic(
    @McpParam('name', 'Kinematic/group name (default auto "Kinematic_N").', 'string', false) name: string,
    ctx?: McpCallContext,
  ): Promise<string> {
    return this._json(await this._dispatch(ctx, 'webEditorCreateKinematic', { name }), (v) => ({ ok: true, ...v }));
  }

  @McpTool('Assign nodes to a kinematic\'s group (they will move with the axis). Objects in another kinematic group are moved over; other kinematic axes are skipped. One undo unit.', { readOnly: false, command: ASSIGN_TO_KINEMATIC_BINDING })
  async webEditorAssignToKinematic(
    @McpParam('paths', 'Node paths to assign, comma/newline-separated.') paths: string,
    @McpParam('groupName', 'Target kinematic group name (see web_editor_list_kinematics).') groupName: string,
    ctx?: McpCallContext,
  ): Promise<string> {
    // plan-499: the same command as the K picker, with requireExisting=true (the tool never creates an axis).
    return this._json(
      await this._dispatch<Record<string, unknown>>(ctx, 'webEditorAssignToKinematic', { paths, groupName }),
      (v) => ({ ok: true, kinematicPath: v['kinematicPath'], groupName: v['groupName'], members: v['members'] }),
    );
  }

  // ═══ Groups (plan-760 F13 — views of the Quick Edit Groups section) ═══

  @McpTool('Add nodes to a PLAIN group (Quick Edit Groups): stamps a Group component, never creates a kinematic axis. Omit paths for the current selection. One undo unit.', { readOnly: false, command: GROUP_ASSIGN_COMMAND })
  async webEditorGroupAssign(
    @McpParam('name', 'Resolved group name (new or existing); "" and "/" refused.') name: string,
    @McpParam('paths', 'Node paths, comma/newline-separated (default: selection).', 'string', false) paths: string,
    ctx?: McpCallContext,
  ): Promise<string> {
    return this._json(await this._dispatch(ctx, 'webEditorGroupAssign', { name, paths }), (v) => ({ ok: true, ...v }));
  }

  @McpTool('Remove nodes from one group: strips every matching Group component of each node, other groups stay; non-members are skipped. Omit paths for the current selection. One undo unit.', { readOnly: false, command: GROUP_REMOVE_COMMAND })
  async webEditorGroupRemove(
    @McpParam('name', 'Resolved group name (see web_group_list).') name: string,
    @McpParam('paths', 'Node paths, comma/newline-separated (default: selection).', 'string', false) paths: string,
    ctx?: McpCallContext,
  ): Promise<string> {
    return this._json(await this._dispatch(ctx, 'webEditorGroupRemove', { name, paths }), (v) => ({ ok: true, ...v }));
  }

  @McpTool('Rename a group on every member Group component AND every owning Kinematic, one undo unit. Resolved names; refused on collision, empty name, "/" or when a member\'s GroupNamePrefix would be dropped. Same name = no-op.', { readOnly: false, command: GROUP_RENAME_COMMAND })
  async webEditorGroupRename(
    @McpParam('name', 'Current resolved group name.') name: string,
    @McpParam('newName', 'New resolved group name.') newName: string,
    ctx?: McpCallContext,
  ): Promise<string> {
    return this._json(await this._dispatch(ctx, 'webEditorGroupRename', { name, newName }), (v) => ({ ok: true, ...v }));
  }

  @McpTool('Dissolve a group: removes its Group component from every member and clears GroupName on every owning Kinematic; geometry and other groups stay. One undo unit.', { readOnly: false, command: GROUP_DISSOLVE_COMMAND })
  async webEditorGroupDissolve(
    @McpParam('name', 'Resolved group name (see web_group_list).') name: string,
    ctx?: McpCallContext,
  ): Promise<string> {
    return this._json(await this._dispatch(ctx, 'webEditorGroupDissolve', { name }), (v) => ({ ok: true, ...v }));
  }

  @McpTool('List all kinematics in the asset: axis path, group name, member count, and the Drive on the axis (direction/speed/limits) when present.', { readOnly: true })
  async webEditorListKinematics(): Promise<string> {
    const ctx = this._ctx();
    if (isGuardError(ctx)) return JSON.stringify(ctx);
    const mods = await this._load();
    const root = ctx.viewer.currentModelRoot;
    const out: Array<Record<string, unknown>> = [];
    root?.traverse((node) => {
      const rv = rvOf(node);
      for (const key of Object.keys(rv)) {
        if (!KINEMATIC_KEY_RE.test(key)) continue;
        const gn = (rv[key] as Record<string, unknown> | undefined)?.['GroupName'];
        if (typeof gn !== 'string' || !gn) continue;
        const drive = driveExtrasOf(node);
        out.push({
          path: NodeRegistry.computeNodePath(node),
          name: node.name,
          groupName: gn,
          members: mods.transform.kinematicGroupMemberCount(ctx.viewer, node),
          drive: drive ? {
            direction: drive['Direction'] ?? null,
            targetSpeed: drive['TargetSpeed'] ?? null,
            useLimits: drive['UseLimits'] === true,
            lowerLimit: drive['LowerLimit'] ?? null,
            upperLimit: drive['UpperLimit'] ?? null,
          } : null,
        });
      }
    });
    return JSON.stringify({ kinematics: out });
  }

  // ═══ Signals / logic ══════════════════════════════════════════════════

  @McpTool('Create a PLC signal node as a child (Quick Edit "Signals"). sigType: PLCInputBool | PLCOutputBool | PLCInputFloat | PLCOutputFloat | PLCInputInt | PLCOutputInt. Optional name renames the node. Returns the new path.', { readOnly: false, command: 'editor.addSignal' })
  async webEditorAddSignal(
    @McpParam('parentPath', 'Parent node path.') parentPath: string,
    @McpParam('sigType', 'Signal type (e.g. PLCOutputBool).') sigType: string,
    @McpParam('name', 'Optional node name (default = signal type).', 'string', false) name: string,
    ctx?: McpCallContext,
  ): Promise<string> {
    // plan-499 Phase 4: a view of `editor.addSignal` — the Quick Edit "Signals"
    // Out/In buttons are the others (same plain-object rule).
    return this._json(await this._dispatch(ctx, 'webEditorAddSignal', { parentPath, sigType, name }), (v) => ({ ok: true, ...v }));
  }

  @McpTool('Convert a signal node to another datatype (Bool | Int | Float), keeping direction and value.', { readOnly: false, command: 'editor.convertSignal' })
  async webEditorConvertSignal(
    @McpParam('path', 'Signal node path.') path: string,
    @McpParam('target', 'Bool | Int | Float.') target: string,
    ctx?: McpCallContext,
  ): Promise<string> {
    // plan-499 Phase 4: a view of `editor.convertSignal` (Quick Edit "To Bool/Int/Float").
    return this._json(await this._dispatch(ctx, 'webEditorConvertSignal', { path, target }), (v) => ({ ok: true, ...v }));
  }

  @McpTool('Flip a signal node between PLC input and output (value preserved).', { readOnly: false, command: 'editor.toggleSignalDirection' })
  async webEditorToggleSignalDirection(
    @McpParam('path', 'Signal node path.') path: string,
    ctx?: McpCallContext,
  ): Promise<string> {
    // plan-499 Phase 4: a view of `editor.toggleSignalDirection` (Quick Edit "To Input/Output").
    return this._json(await this._dispatch(ctx, 'webEditorToggleSignalDirection', { path }), (v) => ({ ok: true, ...v }));
  }

  @McpTool('Edit ONE field of a PLC signal node: Comment, OriginDataType (BOOL/INT/DINT/REAL/…) or Type (a full wire type, e.g. PLCInputFloat). "Name" is refused — rename with web_editor_signal_rename.', { readOnly: false, command: 'editor.signalSetField' })
  async webEditorSignalSetField(
    @McpParam('path', 'Signal node path.') path: string,
    @McpParam('field', 'Comment | OriginDataType | Type.') field: string,
    @McpParam('value', 'New value (empty clears Comment / OriginDataType).', 'string', false) value: string,
    ctx?: McpCallContext,
  ): Promise<string> {
    // plan-589 F3: a view of `editor.signalSetField` — the inspector's "Signal" section is the other.
    return this._json(await this._dispatch(ctx, 'webEditorSignalSetField', { path, field, value }), (v) => ({ ok: true, ...v }));
  }

  @McpTool('Set, change or remove the PLC binding of a MODEL signal on ONE CONNECT interface (MQTT: in one topic). Addresses live in CONNECT, never in the model. Omit protocolAddress where the interface needs none (MQTT Single/Json topic, PLCSIM/SHM/ABB name fallback); remove=true unbinds.', { readOnly: false, command: 'editor.signalSetBinding' })
  async webEditorSignalSetBinding(
    @McpParam('name', 'Model signal name (runtime name = the CONNECT signal name).') name: string,
    @McpParam('interfaceId', 'CONNECT interface id.') interfaceId: string,
    @McpParam('topic', 'MQTT topic container; omit for the interface-level signal list.', 'string', false) topic: string,
    @McpParam('protocolAddress', 'Protocol address (DB10.DBX4.1, ns=2;s=Motor1.Speed, %IW13, …).', 'string', false) protocolAddress: string,
    @McpParam('dataType', 'Data type as the interface schema spells it (Bool, Real, DINT, …).', 'string', false) dataType: string,
    @McpParam('remove', 'Remove the binding instead of writing it.', 'boolean', false) remove: boolean,
    ctx?: McpCallContext,
  ): Promise<string> {
    // plan-589 F4: a view of `editor.signalSetBinding` — the inspector's "PLC binding" rows are the
    // others. Single signal, single interface; an atomic multi-write is plan-590.
    return this._json(
      await this._dispatch(ctx, 'webEditorSignalSetBinding',
        { name, interfaceId, topic, protocolAddress, dataType, remove }),
      (v) => ({ ok: true, ...v }));
  }

  @McpTool('Create model signals for an interface\'s plc-only signals (see web_signal_reconcile). Name verbatim, dataType becomes OriginDataType; Text/String is unsupported and skipped.', { readOnly: false, command: SIGNALS_CREATE_FROM_INTERFACE_COMMAND })
  async webEditorSignalsCreateFromInterface(
    @McpParam('interfaceId', 'CONNECT interface id.') interfaceId: string,
    @McpParam('parentPath', 'Parent node; omit = selection.', 'string', false) parentPath: string,
    @McpParam('names', 'Only these names, comma separated; omit = all creatable.', 'string', false) names: string,
    ctx?: McpCallContext,
  ): Promise<string> {
    // plan-589 F7: a view of `editor.signalsCreateFromInterface` — the ConnectPanel button and the
    // Problems entry's action are the others.
    return this._json(
      await this._dispatch(ctx, 'webEditorSignalsCreateFromInterface', { interfaceId, parentPath, names }),
      (v) => ({ ok: true, ...v }));
  }

  @McpTool('Rename a PLC signal with every reference (model, overlay, planner, historian, CONNECT). dryRun=true returns the preview (steps, blockers, wireChanges); wire effects need confirmWireChange=true. One undo step.', { readOnly: false, command: SIGNAL_RENAME_COMMAND })
  async webEditorSignalRename(
    @McpParam('path', 'Signal node path.') path: string,
    @McpParam('newName', 'New signal name.') newName: string,
    @McpParam('dryRun', 'Preview only.', 'boolean', false) dryRun: boolean,
    @McpParam('confirmWireChange', 'Accept wire name changes.', 'boolean', false) confirmWireChange: boolean,
    ctx?: McpCallContext,
  ): Promise<string> {
    // plan-590 F10: a view of `editor.signalRename` — the inspector's rename dialog is the other.
    return this._json(
      await this._dispatch(ctx, 'webEditorSignalRename', { path, newName, dryRun, confirmWireChange }),
      (v) => ({ ok: true, ...v }));
  }

  @McpTool('Retry what a failed signal rename could not restore (Problems "Repair").', { readOnly: false, command: SIGNAL_RENAME_REPAIR_COMMAND })
  async webEditorSignalRenameRepair(
    @McpParam('journalId', 'Journal id from the Problems entry.') journalId: string,
    ctx?: McpCallContext,
  ): Promise<string> {
    // plan-590 F7: a view of `editor.signalRenameRepair` — the Problems entry's action is the other.
    return this._json(await this._dispatch(ctx, 'webEditorSignalRenameRepair', { journalId }), (v) => ({ ok: true, ...v }));
  }

  @McpTool('Ask CONNECT again for a signal rename with an unknown outcome (Problems "Re-check").', { readOnly: false, command: SIGNAL_RENAME_RECHECK_COMMAND })
  async webEditorSignalRenameRecheck(
    @McpParam('journalId', 'Journal id from the Problems entry.') journalId: string,
    ctx?: McpCallContext,
  ): Promise<string> {
    // plan-590 F7: a view of `editor.signalRenameRecheck` — the Problems entry's action is the other.
    return this._json(await this._dispatch(ctx, 'webEditorSignalRenameRecheck', { journalId }), (v) => ({ ok: true, ...v }));
  }

  @McpTool('Add a LogicStep to a node (Quick Edit "Logic Steps"). Unknown stepType returns the palette. Steps sequence one-per-node; a node that already has a step gets a sibling.', { readOnly: false, command: 'editor.addLogicStep' })
  async webEditorAddLogicStep(
    @McpParam('path', 'Context node path.') path: string,
    @McpParam('stepType', 'LogicStep type (e.g. LogicStep_DriveTo).') stepType: string,
    ctx?: McpCallContext,
  ): Promise<string> {
    // plan-499 Phase 4: a view of `editor.addLogicStep` — the Quick Edit starter
    // and palette buttons are the others (same container rule; an unknown type
    // still answers with the palette, now as refusal details).
    return this._json(await this._dispatch(ctx, 'webEditorAddLogicStep', { path, stepType }), (v) => ({ ok: true, ...v }));
  }

  // ═══ Shortcuts ════════════════════════════════════════════════════════

  /** The editor keyboard vocabulary, resolved to the SAME actions the keys
   *  trigger for a human (semantic mapping — no synthetic key events, since
   *  S/K open interactive pickers an agent could not click). */
  private static readonly SHORTCUTS: Record<string, string> = {
    'S>I': 'Select identical geometry (all copies of the selected part)',
    'S>M': 'Select same material/appearance',
    'S>V': 'Invert selection',
    'K>NAME': 'Assign selection to kinematic NAME (creates axis+group when new) — pass the name as arg',
    'H': 'Hide selection (authored visibility, undoable)',
    'SHIFT+H': 'Show selection',
    'DELETE': 'Delete selection (one undo unit)',
    'CTRL+Z': 'Undo',
    'CTRL+Y': 'Redo',
    'ESCAPE': 'Clear selection',
    'SHIFT+Z': 'Toggle the wireframe view (arg "on" / "off" sets it explicitly); state is web_editor_status.wireframe',
  };

  @McpTool('Run an editor keyboard shortcut on the CURRENT selection, exactly as a user would: "S>I" select identical, "S>M" same material, "S>V" invert, "K" + arg=name assign to kinematic, "H" hide, "Shift+H" show, "Delete", "Ctrl+Z"/"Ctrl+Y" undo/redo, "Escape" clear, "Shift+Z" wireframe view (arg "on"/"off" sets it, omitted toggles). Unknown keys return the table. Chain e.g. S>I then web_editor_assign_material (paths omitted = selection).', { readOnly: false, command: SHORTCUT_BINDING })
  async webEditorShortcut(
    @McpParam('keys', 'Shortcut, e.g. "S>I", "K", "H", "Ctrl+Z".') keys: string,
    @McpParam('arg', 'Argument for shortcuts that take one (K: kinematic/group name; Shift+Z: "on" or "off").', 'string', false) arg: string,
    ctx?: McpCallContext,
  ): Promise<string> {
    // plan-499 F6: a multiplexer over SHORTCUT_BINDING — every combo is a branch
    // to the command the real key triggers; the local switch is gone.
    const call = ctx ?? bindStandalone(this, 'webEditorShortcut', { keys, arg }, this.viewer);
    const combo = normalizeShortcutKeys(keys);
    if (!call.bound && !call.refusal) {
      const guard = this._ctx();
      if (isGuardError(guard)) return JSON.stringify(guard);
      return JSON.stringify({
        ...(combo ? { error: `Unknown shortcut "${keys}"` } : {}),
        shortcuts: McpEditorTools.SHORTCUTS,
      });
    }
    if (!call.bound) {
      // A matched branch refused (K without a name): answer with the existing names.
      const v = this.viewer;
      return JSON.stringify({ error: call.refusal, ...(v ? { existing: await this._kinematicNames(v) } : {}) });
    }

    // Show the same on-screen key badge a human keypress produces, chord
    // steps paced like real typing — the shortcut should read as "the user
    // pressed the keys", not as an invisible remote call.
    try {
      const badge = await import('../../core/hmi/key-badge-store');
      const steps = combo.split('>');
      badge.showKeyBadge(steps[0]);
      for (const s of steps.slice(1)) {
        await new Promise((r) => setTimeout(r, 350));
        badge.appendKeyBadge(s);
      }
    } catch { /* badge is cosmetic — never block the shortcut */ }

    const r = await dispatchBoundCommand<Record<string, unknown>>(call, this.viewer);
    if (!r.ok) return JSON.stringify(commandErrorJson(r));
    const v = r.value ?? {};
    switch (call.bound.id) {
      case 'editor.assignToKinematic':
        return JSON.stringify({ shortcut: 'K', groupName: v['groupName'], kinematicPath: v['kinematicPath'] });
      case 'editor.hide': case 'editor.show':
        return JSON.stringify({ shortcut: combo, changed: v['changed'], visible: v['visible'] });
      case 'editor.delete':
        return JSON.stringify({ shortcut: 'Delete', deleted: v['deleted'] });
      case 'editor.undo': case 'editor.redo':
        return JSON.stringify(v);
      case 'selection.clear':
        return JSON.stringify({ shortcut: 'Escape', selected: 0 });
      case 'editor.wireframe':
        return JSON.stringify({ shortcut: 'Shift+Z', wireframe: v['wireframe'] });
      default:
        return JSON.stringify({ shortcut: combo, selected: v['selected'] });
    }
  }

  /** Existing kinematic group names (for the K shortcut's error hint). */
  private async _kinematicNames(v: RVViewer): Promise<string[]> {
    const names: string[] = [];
    v.currentModelRoot?.traverse((node) => {
      const rv = rvOf(node);
      for (const key of Object.keys(rv)) {
        if (!KINEMATIC_KEY_RE.test(key)) continue;
        const gn = (rv[key] as Record<string, unknown> | undefined)?.['GroupName'];
        if (typeof gn === 'string' && gn && !names.includes(gn)) names.push(gn);
      }
    });
    return names;
  }

  // ═══ Materials ════════════════════════════════════════════════════════

  @McpTool('List the material presets (built-in industrial library + user presets): id, name, category, color, metalness, roughness, opacity. Assign with web_editor_assign_material or web_editor_materialize.', { readOnly: true })
  async webEditorMaterialPresets(): Promise<string> {
    const ctx = this._ctx();
    if (isGuardError(ctx)) return JSON.stringify(ctx);
    const mods = await this._load();
    const all = [...mods.presets.BUILTIN_MATERIAL_PRESETS, ...mods.presets.loadCustomPresets()];
    return JSON.stringify(all.map((p) => ({
      id: p.id, name: p.name, category: p.category,
      color: p.color, metalness: p.metalness, roughness: p.roughness, opacity: p.opacity,
    })));
  }

  @McpTool('Material overview of the asset: counts, warnings, and the APPEARANCE GROUPS (meshes bucketed by identical current material) with a stable key, current PBR value, mesh count and sample paths. The perception step before web_editor_materialize.', { readOnly: true })
  async webEditorMaterialStats(): Promise<string> {
    const ctx = this._ctx();
    if (isGuardError(ctx)) return JSON.stringify(ctx);
    const root = ctx.viewer.currentModelRoot ?? null;
    const stats = computeMaterialStats(root);
    const groups = this._appearanceGroups(root);
    return JSON.stringify({
      materialCount: stats.materialCount,
      uniqueByAppearance: stats.uniqueByAppearance,
      meshCount: stats.meshCount,
      textureCount: stats.textureCount,
      warnings: stats.warnings.map((w) => ({ id: w.id, label: w.label, meshCount: w.meshPaths.length })),
      groups,
    });
  }

  /** Appearance groups: value-key → current value + mesh paths (samples). */
  private _appearanceGroups(root: Object3D | null): Array<Record<string, unknown>> {
    const v = this.viewer;
    const index = indexMeshPathsByMaterialValue(root);
    const groups: Array<Record<string, unknown>> = [];
    for (const [key, meshPaths] of index) {
      const first = v?.registry?.getNode(meshPaths[0]);
      const value = first ? materialToValue((first as import('three').Mesh).material as import('three').Material) : null;
      groups.push({
        key,
        name: value?.name ?? null,
        color: value?.color ?? null,
        metalness: value?.metalness ?? null,
        roughness: value?.roughness ?? null,
        opacity: value?.opacity ?? null,
        meshCount: meshPaths.length,
        samplePaths: meshPaths.slice(0, 3),
      });
    }
    groups.sort((a, b) => (b.meshCount as number) - (a.meshCount as number));
    return groups;
  }

  @McpTool('Assign a material to nodes (undoable, like the Materials panel): presetId (from web_editor_material_presets) OR free PBR values (color hex + metalness/roughness/opacity). Omit paths to paint the CURRENT selection — e.g. after web_editor_shortcut "S>I". Expands to paintable meshes automatically.', { readOnly: false, command: 'editor.assignMaterial' })
  async webEditorAssignMaterial(
    @McpParam('paths', 'Node paths, comma/newline-separated (omit = current selection).', 'string', false) paths: string,
    @McpParam('presetId', 'Material preset id (e.g. "steel").', 'string', false) presetId: string,
    @McpParam('color', 'Hex color (e.g. "#2271b3") for a free PBR value.', 'string', false) color: string,
    @McpParam('metalness', 'Metalness 0..1 (default 0).', 'number', false) metalness: number,
    @McpParam('roughness', 'Roughness 0..1 (default 0.5).', 'number', false) roughness: number,
    @McpParam('opacity', 'Opacity 0..1 (default 1).', 'number', false) opacity: number,
    ctx?: McpCallContext,
  ): Promise<string> {
    return this._json(
      await this._dispatch(ctx, 'webEditorAssignMaterial', { paths, presetId, color, metalness, roughness, opacity }),
      (v) => ({ ok: true, ...v }),
    );
  }

  // ═══ Compounds ════════════════════════════════════════════════════════

  @McpTool('KINEMATIZE in one undo step: group the given parts under a (new or existing) kinematic axis, add a Drive on the axis, set its direction/speed/limits, and center the pivot to the group. direction: LinearX|LinearY|LinearZ|RotationX|RotationY|RotationZ. Verify afterwards with web_editor_verify_drive. Fine-tune with web_editor_pivot / web_editor_set_field.', { readOnly: false, timeoutMs: 60_000 })
  async webEditorKinematize(
    @McpParam('paths', 'Part node paths to kinematize, comma/newline-separated.') paths: string,
    @McpParam('groupName', 'Kinematic/group name (e.g. "Turntable").') groupName: string,
    @McpParam('direction', 'Drive direction (default LinearX).', 'string', false) direction: string,
    @McpParam('speed', 'Target speed (mm/s linear, °/s rotary).', 'number', false) speed: number,
    @McpParam('lowerLimit', 'Lower limit (mm or °) — sets UseLimits.', 'number', false) lowerLimit: number,
    @McpParam('upperLimit', 'Upper limit (mm or °) — sets UseLimits.', 'number', false) upperLimit: number,
    @McpParam('startPosition', 'Start position (mm or °).', 'number', false) startPosition: number,
    @McpParam('centerPivot', 'Center the axis pivot to the group bounds (default true).', 'boolean', false) centerPivot: boolean,
  ): Promise<string> {
    const ctx = this._ctx();
    if (isGuardError(ctx)) return JSON.stringify(ctx);
    const name = (groupName || '').trim();
    if (!name) return JSON.stringify({ error: 'groupName is required' });
    const dir = direction?.trim() || 'LinearX';
    if (!DRIVE_DIRECTIONS.includes(dir)) {
      return JSON.stringify({ error: `direction must be one of ${DRIVE_DIRECTIONS.join(' | ')}` });
    }
    const parts = parsePathsParam(paths).filter((p) => ctx.viewer.registry?.getNode(p));
    if (parts.length === 0) return JSON.stringify({ error: 'No resolvable part paths given' });
    const mods = await this._load();

    let kinPath: string | null = null;
    await ctx.doc.withTransaction(`Kinematize "${name}"`, async () => {
      // Group members + create the axis node/Kinematic when the group is new
      // (nested transactions fold into this one — single undo step).
      await mods.group.groupSelection(ctx.viewer, ctx.doc, parts, name);
      kinPath = findKinematicPathForGroup(ctx.viewer, name);
      if (!kinPath) throw new Error(`Kinematic for group "${name}" not found after grouping`);

      const kinNode = ctx.viewer.registry?.getNode(kinPath);
      if (kinNode && !driveExtrasOf(kinNode)) {
        const fields: Record<string, unknown> = { ...getSchemaDefaults('Drive'), Direction: dir };
        if (typeof speed === 'number' && !Number.isNaN(speed)) fields['TargetSpeed'] = speed;
        if (isNum(lowerLimit) || isNum(upperLimit)) {
          fields['UseLimits'] = true;
          if (isNum(lowerLimit)) fields['LowerLimit'] = lowerLimit;
          if (isNum(upperLimit)) fields['UpperLimit'] = upperLimit;
        }
        if (isNum(startPosition)) fields['StartPosition'] = startPosition;
        ctx.doc.addComponent(kinPath, 'Drive', fields);
      } else if (kinNode) {
        // Axis already has a Drive — update the provided fields instead.
        const rv = rvOf(kinNode);
        const driveKey = Object.keys(rv).find((k) => DRIVE_KEY_RE.test(k))!;
        const data = rv[driveKey] as Record<string, unknown>;
        const set = (f: string, val: unknown): void => { ctx.doc.setField(kinPath!, driveKey, f, val, data[f]); };
        if (direction?.trim()) set('Direction', dir);
        if (isNum(speed)) set('TargetSpeed', speed);
        if (isNum(lowerLimit) || isNum(upperLimit)) {
          set('UseLimits', true);
          if (isNum(lowerLimit)) set('LowerLimit', lowerLimit);
          if (isNum(upperLimit)) set('UpperLimit', upperLimit);
        }
        if (isNum(startPosition)) set('StartPosition', startPosition);
      }
      await ctx.doc.whenIdle();
      if (centerPivot !== false && kinPath) {
        await mods.transform.centerKinematicToGroup(ctx.viewer, ctx.doc, kinPath);
      }
    });
    await ctx.doc.whenIdle();

    if (!kinPath) return JSON.stringify({ error: 'Kinematize failed — no kinematic path' });
    const kinNode = ctx.viewer.registry?.getNode(kinPath);
    const members = kinNode ? mods.transform.kinematicGroupMemberCount(ctx.viewer, kinNode) : 0;
    const drive = kinNode ? driveExtrasOf(kinNode) : null;
    const wp = kinNode?.getWorldPosition(new Vector3());
    return JSON.stringify({
      ok: true,
      kinematicPath: kinPath,
      groupName: name,
      members,
      pivotWorld: wp ? [r3(wp.x), r3(wp.y), r3(wp.z)] : null,
      drive: drive ? { direction: drive['Direction'], targetSpeed: drive['TargetSpeed'] ?? null } : null,
      next: 'Verify the motion with web_editor_verify_drive before saving; one web_editor_undo reverts everything',
    });
  }

  @McpTool('MATERIALIZE: call with no assignments to get the appearance groups (same as web_editor_material_stats), then call again with assignmentsJson = [{"key"|"samplePath": ..., "presetId"|"color"(+metalness/roughness/opacity): ...}, ...] to re-material whole appearance groups in ONE undo step.', { readOnly: false, timeoutMs: 60_000, command: 'editor.materialize' })
  async webEditorMaterialize(
    @McpParam('assignmentsJson', 'JSON array of {key|samplePath, presetId|color,metalness,roughness,opacity}.', 'string', false) assignmentsJson: string,
    ctx?: McpCallContext,
  ): Promise<string> {
    // The LISTING call (no assignments) is a read: it answers the appearance
    // groups without dispatching — nothing is pressed, nothing changes.
    if (!assignmentsJson?.trim()) {
      const guard = this._ctx();
      if (isGuardError(guard)) return JSON.stringify(guard);
      return JSON.stringify({ groups: this._appearanceGroups(guard.viewer.currentModelRoot ?? null) });
    }
    return this._json(await this._dispatch(ctx, 'webEditorMaterialize', { assignmentsJson }), (v) => ({ ok: true, ...v }));
  }

  // ═══ Verify ═══════════════════════════════════════════════════════════

  // readOnly stays FALSE: the drive itself is moved, not just a camera. The
  // captures went offscreen with plan-740 P3.5 and the tool no longer touches
  // the viewport — but it still drags the axis through its range and selects it,
  // and CONNECT takes `readOnlyHint` blind for its write gate (D-A8 / I2).
  @McpTool('VERIFY a drive visually before saving — performed like a user would: selects the axis (gizmo + group highlight appear), aims the AGENT camera at a fitted 3/4 view of the swept volume, then smoothly drags the drive through its range while rendering N poses offscreen, springs back, and returns ONE labelled montage cropped to the sweep volume. Wrong axis/pivot/membership is immediately visible. The user viewport is never moved. Defaults: limits when UseLimits, else ±180° rotary / ±500mm linear around home. Requires the classic WebGL renderer.', { readOnly: false, timeoutMs: 60_000 })
  async webEditorVerifyDrive(
    @McpParam('kinematicPath', 'Path of the node carrying the Drive (usually the kinematic axis).') kinematicPath: string,
    @McpParam('from', 'Sweep start (mm or °).', 'number', false) from: number,
    @McpParam('to', 'Sweep end (mm or °).', 'number', false) to: number,
    @McpParam('frames', 'Number of poses 2..12 (default 6).', 'integer', false) frames: number,
    @McpParam('keepView', 'Keep the agent camera where the tool framed it and the axis selected (default true).', 'boolean', false) keepView: boolean,
  ): Promise<string> {
    return serializeEyeCapture(() => this._verifyDrive(kinematicPath, from, to, frames, keepView));
  }

  private async _verifyDrive(
    kinematicPath: string, from: number, to: number, frames: number, keepView: boolean,
  ): Promise<string> {
    const ctx = this._ctx();
    if (isGuardError(ctx)) return JSON.stringify(ctx);
    const v = ctx.viewer;
    const guard = guardAgentCapture(v, 'web_editor_verify_drive');
    if (guard) return JSON.stringify({ error: guard });
    const node = v.registry?.getNode(kinematicPath);
    if (!node) return JSON.stringify({ error: `Node not found: ${kinematicPath}` });
    const mods = await this._load();
    const source = mods.gizmoSource.resolveEditorDriveGizmoSource(v, kinematicPath);
    if (!source) return JSON.stringify({ error: `No Drive component on ${kinematicPath}` });
    const driver = getDriveDragDriver();
    if (!driver) return JSON.stringify({ error: 'Drive preview driver not available (editor not fully active)' });

    const rotary = source.isRotary;
    const unit = rotary ? '°' : 'mm';
    // No limits → symmetric sweep around home: ±180° rotary, ±500 mm linear.
    const span = rotary ? 180 : 500;
    let p0 = isNum(from) ? from : (source.UseLimits ? source.LowerLimit : -span);
    let p1 = isNum(to) ? to : (source.UseLimits ? source.UpperLimit : span);
    if (p0 === p1) p1 = p0 + span;
    const n = Math.min(12, Math.max(2, Math.round(frames || 6)));
    const positions = Array.from({ length: n }, (_, i) => p0 + (p1 - p0) * (i / (n - 1)));

    // 1. Select like a user: axis gizmo + kinematic group highlight appear.
    v.selectionManager.select(kinematicPath);
    await sleep(150);

    const dragCtx = { viewer: v, source, node, position: 0 };
    const shots: HTMLCanvasElement[] = [];
    const labels: string[] = [];
    try {
      // 2. Silent bounds pre-pass (single JS task — at most one intermediate
      // frame renders): union of everything that moves across the whole sweep.
      const groupName = mods.transform.getKinematicGroupName(node);
      const members = groupName ? (v.groups?.get(groupName)?.nodes ?? []) : [];
      const union = new Box3();
      for (const p of positions) {
        driver.preview({ ...dragCtx, position: p });
        union.union(computeSubtreeAABB(node, new Box3()).box);
        for (const m of members) union.union(computeSubtreeAABB(m, new Box3()).box);
      }
      driver.cancel(dragCtx); // back to home before anything is visible

      // 3. Aim the AGENT at a fitted 3/4 view of the sweep volume — instantly
      // (plan-740 D-A7). The old code animated the VIEWPORT there and waited a
      // second for it to arrive, which took a watching operator's view away for
      // the whole verification. Same angle and standoff, no flight, no wait.
      if (!union.isEmpty()) {
        const center = union.getCenter(new Vector3());
        const size = union.getSize(new Vector3());
        const maxDim = Math.max(size.x, size.y, size.z, 0.1);
        const dist = maxDim * 2.1;
        const dir = new Vector3(0.7, 0.5, 0.7).normalize();
        const eye = v.agentEye;
        eye?.ensure();
        eye?.setPose({
          px: center.x + dir.x * dist, py: center.y + dir.y * dist, pz: center.z + dir.z * dist,
          tx: center.x, ty: center.y, tz: center.z,
        });
      }

      // 4. Drag the gizmo like a user: glide between sample positions with
      // small waits (visible motion), capturing each sample pose on the fly.
      const GLIDE_STEPS = 5, GLIDE_WAIT_MS = 30;
      // Start the visible drag from the drive's HOME pose, so a symmetric
      // sweep (e.g. -180..+180) glides out to the start instead of jumping.
      let prev = source.currentPosition;
      for (const p of positions) {
        for (let s = 1; s <= GLIDE_STEPS; s++) {
          driver.preview({ ...dragCtx, position: prev + (p - prev) * (s / GLIDE_STEPS) });
          await sleep(GLIDE_WAIT_MS);
        }
        prev = p;
        const r = await renderAgentChannels(v, {
          size: 640, channels: ['beauty'],
          ...(union.isEmpty() ? {} : { crop: union }),
        });
        if ('error' in r) return JSON.stringify({ error: r.error });
        const beauty = r.channels.find((c) => c.channel === 'beauty');
        if (!beauty) return JSON.stringify({ error: 'Beauty channel missing' });
        shots.push(beauty.canvas);
        labels.push(`${+p.toFixed(1)}${unit}`);
      }

      // 5. Release like a user letting go: spring-back animation, then exact
      // restore (the finally-cancel is a safety net if the spring was cut short).
      driver.release(dragCtx);
      await sleep(450);
    } finally {
      driver.cancel(dragCtx); // exact restore of axis + members (no-op after spring)
    }
    if (keepView === false) v.selectionManager.clear();

    const mont = compositeMontage(shots, labels);
    if ('error' in mont) return JSON.stringify(mont);
    return canvasToRvImage(mont, {
      drive: { path: kinematicPath, rotary, from: r3(p0), to: r3(p1), frames: n, unit },
      restored: true,
    }, 'web_editor_verify_drive');
  }

  // ═══ Imports ══════════════════════════════════════════════════════════

  @McpTool('Import a GLB file from the OPEN PROJECT into the open asset (undoable importCad op). relPath is project-relative (e.g. "library/imports/part.glb"). Returns the created root path.', { readOnly: false, timeoutMs: 120_000 })
  async webEditorImportGlb(
    @McpParam('relPath', 'Project-relative path of a .glb file (e.g. "library/imports/part.glb").') relPath: string,
  ): Promise<string> {
    const ctx = this._ctx();
    if (isGuardError(ctx)) return JSON.stringify(ctx);
    const read = await this._readProjectFile(relPath);
    if ('error' in read) return JSON.stringify(read);
    const mods = await this._load();
    try {
      const paths = await mods.importAsset.importIntoAsset(ctx.doc, [{
        kind: 'glb', bytes: read.bytes, suggestedName: read.name,
      } as import('../../core/import/rv-import-provider').ImportResultItem]);
      return JSON.stringify({ ok: true, rootPaths: paths });
    } catch (e) {
      return JSON.stringify({ error: String(e) });
    }
  }

  @McpTool('Import a CAD file (STEP/JT) from the OPEN PROJECT into the open asset — converts via the CAD provider (private build), then attaches as an undoable importCad op. relPath is project-relative. quality: draft | standard | fine (default standard).', { readOnly: false, timeoutMs: 600_000 })
  async webEditorImportCad(
    @McpParam('relPath', 'Project-relative path of a CAD file (.step/.stp/.jt), e.g. "library/imports/machine.step".') relPath: string,
    @McpParam('quality', 'Tessellation quality: draft | standard | fine (default standard).', 'string', false) quality: string,
  ): Promise<string> {
    const ctx = this._ctx();
    if (isGuardError(ctx)) return JSON.stringify(ctx);
    const mods = await this._load();
    if (!mods.cadProvider.hasCadProvider()) {
      return JSON.stringify({ error: 'CAD provider not available in this build — import a GLB instead' });
    }
    const read = await this._readProjectFile(relPath);
    if ('error' in read) return JSON.stringify(read);
    const provider = mods.cadProvider.getCadProvider(mods.cadProvider.cadFormatOfName(read.name));
    if (!provider) {
      return JSON.stringify({ error: `No CAD provider for "${read.name}" (format not supported in this build)` });
    }
    try {
      const file = new File([read.bytes], read.name);
      const result = await provider.importFile(file, quality?.trim() || 'standard');
      const rootPath = await ctx.doc.importCad(result);
      // plan-561: non-fatal notes (e.g. CONNECT failed, converted in the browser —
      // colours may be incomplete) reach the agent instead of a console line.
      const warnings = result.warnings ?? [];
      return JSON.stringify(warnings.length > 0 ? { ok: true, rootPath, warnings } : { ok: true, rootPath });
    } catch (e) {
      return JSON.stringify({ error: String(e) });
    }
  }

  /**
   * Read a file out of the OPEN PROJECT (plan-709 §2.6.2).
   *
   * One store, whichever backend the project has: a folder project reads from
   * disk, a browser project from OPFS, and the agent passes the same
   * project-relative path either way. `readBlobBytes` is the bytes primitive
   * added in §2.5 — no object URL is minted to read a file.
   */
  private async _readProjectFile(relPath: string):
    Promise<{ bytes: ArrayBuffer; name: string } | { error: string }> {
    const trimmed = relPath?.trim().replace(/\\/g, '/').replace(/^\/+/, '') ?? '';
    if (!trimmed) return { error: 'relPath is required' };
    const { getProjectStore } = await import('../../core/project/project-store');
    const backend = getProjectStore().getBackend();
    if (!backend) return { error: 'No project is open (open one in Projects)' };
    const read = (await backend.readDocument(trimmed))?.bytes ?? null;
    if (!read) return { error: `File not found in the open project: ${trimmed}` };
    return { bytes: arrayBufferOf(read), name: trimmed.split('/').pop() || trimmed };
  }
}

function fallbackMode(v: RVViewer): string {
  const ids = v.modes.list().map((m) => m.id);
  return ids.includes('hmi') ? 'hmi' : ids.find((id) => id !== 'editor') ?? 'hmi';
}

function isNum(v: unknown): v is number {
  return typeof v === 'number' && !Number.isNaN(v);
}

function clamp01(v: number | undefined, dflt: number): number {
  return typeof v === 'number' && !Number.isNaN(v) ? Math.min(Math.max(v, 0), 1) : dflt;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
