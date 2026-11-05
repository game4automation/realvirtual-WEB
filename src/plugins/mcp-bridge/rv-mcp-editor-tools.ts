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

import { whenDocumentSettled } from '../../core/hmi/rv-bind-queue';
import { Box3, Vector3 } from 'three';
import type { BufferGeometry, Mesh, Object3D } from 'three';
import type { RVViewer } from '../../core/rv-viewer';
import { McpTool, McpParam } from '../../core/engine/rv-mcp-tools';
import { getSchemaDefaults, getTypesWithCapability } from '../../core/engine/rv-component-registry';
import { ensureFeatureIfDeclared } from '../../core/rv-feature-loader';
import { computeSubtreeAABB } from '../../core/engine/rv-traverse-utils';
import { getDriveDragDriver } from '../../core/engine/drive-drag-driver';
import { NodeRegistry } from '../../core/engine/rv-node-registry';
import { isModelRoot } from '../../core/engine/rv-model-root';
import { computeMaterialStats } from '@rv-private/plugins/asset-editor/shared/material-stats';
import {
  indexMeshPathsByMaterialValue,
  materialToValue,
  materialValueKey,
} from '../../core/editor/rv-asset-material';
import type { MaterialValue } from '../../core/editor/rv-asset-ops';
import { applyGeneratedUVs, collectUVMeshes, UV_MODES, type UVApplyResult } from '../../core/editor/rv-uv-apply';
import type { UVMode } from '../../core/editor/rv-uv-generate';
import type { ActiveAssetContext } from '../../core/editor/active-asset-store';
// plan-713 F10 — the descend chain rides on the core view seam, not on the
// private plugin's RvDocumentStack (see `_breadcrumbFields`).
import { getActiveDocumentView } from '../../core/editor/active-document-view';
import { documentBase, libraryDocumentBase, setOpenDocumentBase } from '../../core/editor/active-asset-store';
import { resolveEditorOpenDocument } from './rv-mcp-editor-open-resolve';
import { ERR_DOCUMENT_LOCKED } from '../../core/editor/rv-asset-document';
import type { AssetBase } from '../../core/editor/rv-asset-document';
import {
  DEFAULT_WELD_THRESHOLD,
  REASON_MULTI_MATERIAL,
  REASON_SINGLE_PART,
  groupModeIneligibility,
  unsupportedMeshShapeReason,
  type SeparateMode,
} from '../../core/editor/rv-mesh-separator';
import { requireEditor, isGuardError } from './rv-mcp-editor-guard';
import { parsePathsParam } from './rv-object-analyzer-math';
import { serializePathList } from '../../core/hmi/rv-path-list';
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
  ERR_TEST_RUN_ACTIVE,
  MODEL_ROOT_LOCKED,
} from '../../core/hmi/editor-command-descriptors';
import {
  ensureMechanismCommandsRegistered,
} from '../../core/hmi/mechanism-command-descriptors';
import { ensureSolidCraftCommandsRegistered } from '../../core/hmi/solidcraft-command-descriptors';
import {
  commandRegistry,
  type CommandDescriptor,
  type CommandImpl,
  type CommandRegistry,
} from '../../core/hmi/rv-command-registry';
import {
  valueOrThrowToolJson,
} from '../../core/hmi/rv-command-context';

/** Command id of the mesh separation (alias `web_editor_separate`, plan-641 Nachtrag). */
export const EDITOR_SEPARATE_COMMAND = 'editor.separate';
import {
  EDITOR_GENERATE_UVS_COMMAND,
  createGenerateUVsCommandDescriptors,
  ensureGenerateUVsCommandRegistered,
  resolveGenerateUVsArgs,
  type GenerateUVsArgs,
} from '../../core/hmi/uv-command-descriptors';
export { EDITOR_GENERATE_UVS_COMMAND };

const r3 = (n: number): number => +n.toFixed(3);

// MODEL_ROOT_LOCKED lives with the command descriptors since plan-499 (one text
// for the command refusal and the remaining direct tools).

/** Kinematic component keys in rv_extras, tolerant of the `_N` dedup suffix. */
const KINEMATIC_KEY_RE = /^Kinematic(_\d+)?$/;
const DRIVE_KEY_RE = /^Drive(_\d+)?$/;


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
  pending: typeof import('@rv-private/plugins/asset-editor/shared/pending-open-store');
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
// plan-621: the SolidCraft live-sync descriptors (community build: ERR_EDITOR_UNAVAILABLE).
ensureSolidCraftCommandsRegistered();

export class McpEditorTools {
  constructor(private readonly getViewer: () => RVViewer | undefined) {}

  private get viewer(): RVViewer | undefined {
    return this.getViewer();
  }

  private _mods: Promise<EditorMods> | null = null;

  private async _load(): Promise<EditorMods> {
    // plan-652: the editor modules below expect the Editor feature to be active
    // (its plugin registered). In a build where it is on demand, activate it first;
    // a failed activation rejects here and is NOT cached in `_mods`.
    await ensureFeatureIfDeclared(this.viewer, 'asset-editor', 'command:mcp');
    this._mods ??= (async () => ({
      transform: await import('@rv-private/plugins/asset-editor/kinematics/transform-actions'),
      create: await import('@rv-private/plugins/asset-editor/kinematics/create-actions'),
      group: await import('@rv-private/plugins/asset-editor/group-actions'),
      del: await import('@rv-private/plugins/asset-editor/delete-selection'),
      save: await import('@rv-private/plugins/asset-editor/save-flow'),
      pending: await import('@rv-private/plugins/asset-editor/shared/pending-open-store'),
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

  /** Handle unsaved changes per the ifDirty policy. Returns an error string or null. */
  private async _handleDirty(
    ctx: ActiveAssetContext, ifDirty: string | undefined, saveName?: string,
  ): Promise<string | null> {
    await whenDocumentSettled(ctx.doc);
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
    const { getTestSessionState } = await import('@rv-private/plugins/asset-editor/shared/test-session-store');
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
      // plan-774 F12 — placed references are baked placements materialised
      // after the load; until they have arrived, paths into them do not resolve.
      ...this._placementFields(),
    });
  }

  /**
   * plan-774 F12: are the placed references of the open document all there?
   * Read live from `viewer.placements` — the same state the editor's authoring
   * join waited for (`web_editor_open` returns after that join).
   */
  private _placementFields(): { placementsReady: boolean; placementsPending: number; placementsHint?: string } {
    const v = this.viewer;
    const progress = v?.placements?.progress;
    const pending = progress?.pending ?? 0;
    const ready = pending === 0 && !(v?.sceneLoadGate?.loading ?? false);
    if (ready) return { placementsReady: true, placementsPending: 0 };
    return {
      placementsReady: false,
      placementsPending: pending,
      placementsHint: `${pending} placed reference(s) are still loading — nodes inside them do not resolve yet. `
        + 'Re-read web_editor_status until placementsReady is true before editing inside a placed asset.',
    };
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

  @McpTool('Descend INTO a referenced asset at path — opens that asset as its own document one level deeper, exactly like double-clicking the reference in the hierarchy. Editor mode only. A placed reference is shown BAKED in its parent (like in the planner/HMI): only its component nodes are addressable and only their field values can be changed there (instance overrides); to change its geometry, structure, materials or mechanisms, descend into it. The path must be a descendable reference; anything else is refused with the reason. Leave again with web_editor_back; the chain is in web_editor_status as depth + breadcrumb.', { readOnly: false, timeoutMs: 120_000 })
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
          + 'a reference whose placement is still loading (web_editor_status placementsReady false) '
          + 'or that failed to load (placeholder) cannot be entered.',
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
    const nav = await view.actions.onCrumb(parent);
    // Review round 2 (R4): another document took the viewer while the parent
    // was rebuilt — not done, and not an error of this call.
    if (nav && nav.status === 'not-done' && nav.reason === 'superseded') {
      return JSON.stringify({
        back: false, superseded: true,
        message: 'Another document was opened while Back was rebuilding the parent — Back did not complete. Check web_editor_status.',
      });
    }
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

  @McpTool('Open the ASSET EDITOR with a document: source=new (creates a NEW document in the open project and opens it) or source=library with relPath naming an EXISTING document of the open project — a library-relative path ("Custom/MyAsset.glb"), a project-relative path ("sidecutter.glb", "models/A.glb", also as "project:<path>"), a document id or a document name from web_document_list. A relPath that matches no document is refused at once with the available names. When the open editor has unsaved changes, ifDirty decides: fail (default) | save (needs a saved name) | discard. Returns once placed references are baked; placementsReady:false means still loading — re-check web_editor_status. Edit through the web_editor_* tools; finish with web_editor_save.', { readOnly: false, timeoutMs: 120_000 })
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
    // Awaited (plan-652): `_awaitEditorContext` below assumes the switch happened.
    if (!(await v.modes.setModeAsync('editor'))) {
      return JSON.stringify({ error: `Editor mode could not be entered (active mode: ${v.modes.activeMode ?? 'none'}) — see web_errors / the Problems panel` });
    }
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

  @McpTool('Asset editor status: document name/base/dirty, undo/redo availability + label, op count, selection and node counts, and placementsReady / placementsPending (placed references still loading).', { readOnly: true })
  async webEditorStatus(): Promise<string> {
    return this._statusJson();
  }

  async queryProjectInfo(): Promise<string> {
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

  async queryProjectFiles(
    dir?: string,
    glob?: string,
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


  @McpTool('Save the asset as GLB into the open project — its own folder when it has one, the project ROOT when it has none (plan-744: `library/Custom` is no longer a fallback). An explicit name renames a project document while keeping its id before saving. Otherwise the document saves under its current name whatever it is (an "Untitled" name is a name like any other); the same name overwrites the existing file. Needs a configured work folder (File System Access). Reports saveVerb — save (in place), save-into-project (this write COPIES the document into the project and changes its identity) or blocked with a reason.', { readOnly: false, timeoutMs: 60_000 })
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
    let renamedFrom: string | undefined;
    const base = ctx.doc.base;
    if (name?.trim() && finalName !== ctx.doc.name && base.kind === 'document') {
      const [{ getProjectStore }, tree, rules, saves, { getSceneStore }] = await Promise.all([
        import('../../core/project/project-store'),
        import('./rv-mcp-project-tree'),
        import('../../core/project/rv-project-tree'),
        import('../../core/editor/rv-save-document'),
        import('../../core/hmi/scene/scene-store-singleton'),
      ]);
      const store = getProjectStore();
      const loaded = await tree.loadProjectTree(store);
      if ('error' in loaded) return JSON.stringify(loaded);
      const node = tree.nodeAtRelPath(loaded, base.path);
      if (!node || node.documentId !== base.documentId) {
        return JSON.stringify({ error: 'The open document is missing from the project tree.' });
      }
      const verdict = rules.canRenameInTree(loaded.roots, node.path!, finalName);
      if (!verdict.ok) return JSON.stringify({ error: tree.refusalSentence(verdict.reason, base.path) });
      renamedFrom = ctx.doc.name;
      const lock = ctx.doc.tryLock('save');
      if (!lock) return JSON.stringify({ error: 'The document is busy; retry after the current operation.' });
      try {
        await ctx.doc.document.runExclusive(async () => {
          await tree.performTreeEdit(loaded, node, verdict);
          saves.adoptRenamedRevision(store.getBackend()!, base.path, verdict.to);
          const row = store.getProject()!.documents!.find(d => d.id === base.documentId)!;
          ctx.doc.adoptDocumentRename({ ...base, path: row.path, name: row.name }, row.name);
          getSceneStore()?.adoptDocumentRename();
          setOpenDocumentBase(ctx.doc.base);
        });
      } finally { ctx.doc.unlock(lock); }
      const { refreshProjectLibrary } = await import('../../core/library/project-library-provider');
      await refreshProjectLibrary();
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
        ...(renamedFrom ? { renamedFrom } : {}),
        ...decision,
        // plan-765 F5: what the serialization did to the stored references
        // (`after - before > 0` = the file lost some; a Problems entry says so too).
        // Absent for a no-op save, which wrote nothing to measure.
        ...(outcome.references ? { references: outcome.references } : {}),
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
      ...(renamedFrom ? { renamedFrom } : {}),
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
        { lineage: 'editor', base: ctx.doc.getSnapshot().base, name },
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


  /**
   * The UV generation itself — the body of `editor.generateUVs`. JSON; meshes
   * that were left alone are reported in `skipped` (status `partial` via
   * web_execute), `ok:false` when no mesh got UVs.
   */
  async generateUVsForPaths(
    paths: string | undefined, mode: string | undefined, overwrite: boolean | undefined, selection?: readonly string[],
  ): Promise<string> {
    const ctx = this._ctx();
    if (isGuardError(ctx)) return JSON.stringify(ctx);
    let list = parsePathsParam(paths ?? '');
    if (list.length === 0) list = [...(selection ?? ctx.viewer.selectionManager.getSnapshot().selectedPaths)];
    if (list.length === 0) {
      return JSON.stringify({ error: 'No paths given and nothing selected — pass paths or select first (web_select)' });
    }
    const requested = (mode?.trim() || 'auto').toLowerCase() as UVMode;
    if (!UV_MODES.includes(requested)) return JSON.stringify({ error: 'mode must be auto | cylindrical | planar | box' });
    const registry = ctx.viewer.registry;
    if (!registry) return JSON.stringify({ error: 'No scene registry' });
    const missing = list.filter((p) => !registry.getNode(p));
    const meshes = collectUVMeshes(registry, list);
    let result: UVApplyResult = { generated: [], skipped: [] };
    await ctx.doc.withTransaction(`Generate UVs (${requested})`, async () => {
      result = await applyGeneratedUVs(ctx.doc, meshes, requested, overwrite === true);
    });
    await whenDocumentSettled(ctx.doc);
    const skipped = [...missing.map((p) => ({ path: p, reason: 'Node not found' })), ...result.skipped];
    if (meshes.length === 0 && missing.length === 0) skipped.push({ path: list.join(', '), reason: 'No meshes under the given paths' });
    return JSON.stringify({
      ok: result.generated.length > 0,
      generated: result.generated.slice(0, 50),
      generatedCount: result.generated.length,
      skipped,
      ...(result.generated.length > 0 ? { next: 'Assign a textured preset (web_query("editor.materialPresets", {}), category Textured); one editor.undo reverts the UVs' } : {}),
    });
  }

  /**
   * The separation itself — the body of `editor.separate`. JSON; a partial run
   * reports `skipped` (status `partial` via web_execute), `ok:false` when nothing split.
   */
  async separateMeshes(paths: string | undefined, mode: string | undefined, selection?: readonly string[]): Promise<string> {
    const ctx = this._ctx();
    if (isGuardError(ctx)) return JSON.stringify(ctx);
    let list = parsePathsParam(paths ?? '');
    if (list.length === 0) list = [...(selection ?? ctx.viewer.selectionManager.getSnapshot().selectedPaths)];
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
    await whenDocumentSettled(ctx.doc);
    // The Group took each source's path — re-selecting keeps the user in place,
    // now with the parts one level below (same move as the context-menu flow).
    if (results.length > 0) ctx.viewer.selectionManager?.select(results[0].path);
    return JSON.stringify({
      ok: results.length > 0,
      separated: results,
      skipped,
      ...(results.length > 0
        ? { next: 'Parts are children of the same-named Group at each source path; one editor.undo reverts everything' }
        : {}),
    });
  }

  // ═══ Structure / components / kinematics ══════════════════════════════


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
  // the row that was addressed. Explicit anchors use mechanism.setAnchor.
  //
  // NOTE the naming: "mechanism" is the RIGID-BODY joint-graph system, not the
  // older `Kinematic` axis-group system that `web_execute("editor.kinematize", …)` /
  // `web_editor_create_kinematic` below drive. The two are never mixed.


  // ─── plan-650 Phase 4: parametric component families ────────────────

  @McpTool('Define a parametric family on a node (plan-650): base parts are the children of partsRoot, paramsJson the schema, code a pure JS generate(values, parts) returning a build plan; writes the component and builds the first variant as one undo step.', { readOnly: false, timeoutMs: 120_000 })
  async webEditorParametricDefine(
    @McpParam('path', 'Family node path.') path: string,
    @McpParam('paramsJson', 'JSON array [{Name, Type: number|int|bool|enum, Unit?, Min?, Max?, Step?, Enum?, Default}].') paramsJson: string,
    @McpParam('code', 'JavaScript defining generate(values, parts).') code: string,
    @McpParam('valuesJson', 'Initial values (JSON object).', 'string', false) valuesJson: string,
    @McpParam('partsRoot', 'Parts child name (default _Parts).', 'string', false) partsRoot: string,
  ): Promise<string> {
    const ctx = this._ctx();
    if (isGuardError(ctx)) return JSON.stringify(ctx);
    const node = ctx.viewer.registry?.getNode(path);
    if (!node) return JSON.stringify({ error: `Node not found: ${path}` });
    let params: unknown;
    let values: Record<string, unknown> = {};
    try {
      params = JSON.parse(paramsJson);
      if (valuesJson) values = JSON.parse(valuesJson) as Record<string, unknown>;
    } catch (e) {
      return JSON.stringify({ error: `paramsJson / valuesJson is not valid JSON: ${e instanceof Error ? e.message : String(e)}` });
    }
    const pc = await import('../../core/engine/rv-parametric-component');
    const { computeCodeHash } = await import('../../core/engine/rv-parametric-hash');
    const regen = await import('../../core/editor/rv-parametric-regenerate');
    const { assetOpHeader } = await import('../../core/editor/rv-asset-ops');
    const draft: Record<string, unknown> = {
      ApiVersion: pc.PARAMETRIC_API_VERSION,
      Params: params,
      Values: {},
      Code: code,
      CodeHash: await computeCodeHash(code ?? ''),
      ...(partsRoot ? { PartsRoot: partsRoot } : {}),
    };
    const parsed = pc.parseParametricComponent(draft);
    if (!parsed.ok) return JSON.stringify({ error: 'Invalid family definition', errors: parsed.errors });
    let normalized: Record<string, unknown>;
    try {
      normalized = pc.normalizeValues(parsed.value.Params, values);
    } catch (e) {
      return JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
    }
    draft.Values = normalized;
    const partsName = parsed.value.PartsRoot ?? pc.DEFAULT_PARTS_ROOT;
    if (!node.children.some((c) => c.name === partsName)) {
      return JSON.stringify({ error: `"${path}" has no child "${partsName}" with the base parts`, children: node.children.map((c) => c.name) });
    }
    const existing = rvOf(node)[pc.PARAMETRIC_COMPONENT_TYPE] as Record<string, unknown> | undefined;
    let outcome: Awaited<ReturnType<typeof regen.regenerateParametric>> | null = null;
    try {
      await ctx.doc.withTransaction(`Define family ${node.name}`, async () => {
        if (existing) {
          for (const [field, value] of Object.entries(draft)) {
            await ctx.doc.setFieldAwaited(path, pc.PARAMETRIC_COMPONENT_TYPE, field, value, existing[field]);
          }
        } else {
          await ctx.doc.applyOp({
            ...assetOpHeader(), kind: 'addComponent', nodePath: path, componentType: pc.PARAMETRIC_COMPONENT_TYPE, fields: draft,
          });
        }
        // The values are already stored, so the first build is forced.
        const out = await regen.regenerateParametric(ctx, path, normalized, { force: true });
        outcome = out;
        if (out.status === 'failed') throw new Error(`${out.error.code}: ${out.error.message}`);
        if (out.status === 'deferred') throw new Error(out.reason);
      });
    } catch (e) {
      return JSON.stringify({ error: `Family not defined — ${e instanceof Error ? e.message : String(e)}` });
    }
    return JSON.stringify({ ok: true, ...(outcome ?? {}), path });
  }

  @McpTool('Set values of a parametric family (partial JSON, normalized) and regenerate its variant as one undo step; deferred while the simulation runs.', { readOnly: false, timeoutMs: 120_000 })
  async webEditorParametricSet(
    @McpParam('path', 'Family node path.') path: string,
    @McpParam('valuesJson', 'Values JSON, e.g. {"BF":620}.') valuesJson: string,
  ): Promise<string> {
    const ctx = this._ctx();
    if (isGuardError(ctx)) return JSON.stringify(ctx);
    let values: Record<string, unknown>;
    try {
      values = JSON.parse(valuesJson) as Record<string, unknown>;
    } catch (e) {
      return JSON.stringify({ error: `valuesJson is not valid JSON: ${e instanceof Error ? e.message : String(e)}` });
    }
    const regen = await import('../../core/editor/rv-parametric-regenerate');
    const out = await regen.regenerateParametric(ctx, path, values);
    return JSON.stringify(out.status === 'failed' ? { ...out, error: `${out.error.code}: ${out.error.message}`, errorDetail: out.error } : { ok: true, ...out });
  }

  @McpTool('Read a parametric family without changing it: values, hashes (upToDate), parts and, unless runGenerator=false, the build plan or the generator error.', { readOnly: true, timeoutMs: 60_000 })
  async webEditorParametricInspect(
    @McpParam('path', 'Family node path.') path: string,
    @McpParam('valuesJson', 'Values JSON (default stored).', 'string', false) valuesJson: string,
    @McpParam('runGenerator', 'Run the rules (default true).', 'boolean', false) runGenerator: boolean,
  ): Promise<string> {
    const viewer = this.viewer;
    if (!viewer) return JSON.stringify({ error: 'Viewer not ready' });
    const node = viewer.registry?.getNode(path);
    if (!node) return JSON.stringify({ error: `Node not found: ${path}` });
    let values: Record<string, unknown> | undefined;
    try {
      if (valuesJson) values = JSON.parse(valuesJson) as Record<string, unknown>;
    } catch (e) {
      return JSON.stringify({ error: `valuesJson is not valid JSON: ${e instanceof Error ? e.message : String(e)}` });
    }
    const fam = await import('../../core/engine/rv-parametric-family');
    const { DEFAULT_GENERATOR_LIMITS } = await import('../../core/engine/rv-parametric-generator');
    let inputs: Awaited<ReturnType<typeof fam.resolveFamilyInputs>>;
    try {
      inputs = await fam.resolveFamilyInputs(node, values);
    } catch (e) {
      return JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
    }
    const ex = inputs.family.extras;
    const report: Record<string, unknown> = {
      path,
      params: ex.Params,
      storedValues: ex.Values,
      values: inputs.values,
      codeHash: inputs.codeHash,
      storedCodeHash: ex.CodeHash,
      inputHash: inputs.inputHash,
      bakedInputHash: ex.BakedInputHash ?? null,
      upToDate: ex.BakedInputHash === inputs.inputHash,
      partsRoot: inputs.family.partsRootName,
      generatedRoot: inputs.family.generatedRootName,
      parts: inputs.parts.map((p) => ({ name: p.name, meshes: p.meshes.length, boundsMm: p.info.boundsMm, vertexCount: p.info.vertexCount })),
      limits: DEFAULT_GENERATOR_LIMITS,
    };
    if (runGenerator === false) return JSON.stringify(report);
    if (!fam.canRegenerate(viewer as never)) {
      return JSON.stringify({ ...report, error: 'Simulation is running — the generator never runs then (plan-650 §2.6a); stop it first' });
    }
    const variant = await fam.buildVariant(node, inputs.values);
    if (!variant.ok) return JSON.stringify({ ...report, error: `${variant.error.stage}/${variant.error.code}: ${variant.error.message}` });
    report.plan = {
      instances: variant.plan.instances.length,
      nodes: variant.plan.nodes.map((n) => n.name),
      components: variant.plan.components.map((c) => ({ node: c.node, type: c.type })),
      firstInstances: variant.plan.instances.slice(0, 20),
      messages: variant.messages,
    };
    report.stats = { generator: variant.generatorStats, assembly: variant.assemblyStats, elapsedMs: variant.elapsedMs };
    return JSON.stringify(report);
  }


  // ═══ SolidCraft live sync (plan-621 F7) ═════════════════════════════════
  //
  // Views of `solidcraft.connect | resync | disconnect` — the same commands as
  // the editor's SolidCraft menu (activity bar). The sync runs in realvirtual CONNECT, which
  // polls the SolidCraft desktop app and starts it if it is not running (plan-642).


  // ═══ In-place test session (plan-410, driven per plan-706 F12) ═════════════
  //
  // These two are the ONLY mechanism-area tools that do not require the private
  // bridge: the test session materialises the authoring state and attaches the
  // runtime, which is meaningful with or without a rigid-body solver. Without
  // the bridge they simply report `forceRecording: false` — an honest fact, not
  // an error (§2.5).

  @McpTool('Start the editor\'s IN-PLACE TEST session: the authoring state is materialised through the real save path and the runtime is attached, so drives, logic and mechanisms actually run. Also arms the mechanism force recording, which is what makes mechanism.forces return a cycle afterwards. Stop with web_editor_test_stop, which restores the authoring state exactly. Reports the state reached and whether force recording is on.', { readOnly: false, timeoutMs: 120_000 })
  async webEditorTestStart(): Promise<string> {
    const ctx = this._ctx();
    if (isGuardError(ctx)) return JSON.stringify(ctx);
    const { getActiveTestSession } = await import('@rv-private/plugins/asset-editor/shared/test-session-store');
    const session = getActiveTestSession();
    if (!session) {
      return JSON.stringify({ error: 'No test session available — open the asset editor first (web_editor_open)' });
    }
    // Install the recorder BEFORE starting: its session subscription is what
    // arms the analysis, and a plugin that does not exist yet cannot subscribe.
    const { ensureForceRecorder } = await import('../mechanism-force-recorder-plugin');
    const plugin = ensureForceRecorder(ctx.viewer);
    await session.start();
    // plan-769 Phase 7 (D24): the start joins the placed references first, so
    // the drive count includes placed content. Placements still loading or
    // missing are REPORTED, never a failure — the asset's own content runs.
    const progress = ctx.viewer.placements?.progress;
    return JSON.stringify({
      ok: session.state === 'running',
      state: session.state,
      forceRecording: plugin.recorder.recording,
      drives: ctx.viewer.drives?.length ?? 0,
      placements: {
        total: progress?.total ?? 0,
        pending: progress?.pending ?? 0,
        missing: progress?.missing ?? 0,
      },
    });
  }

  @McpTool('Stop the editor\'s in-place test session and put the authoring state back exactly as it was before the run. The recorded force buffers are KEPT — "what did that cycle need?" is asked after the cycle — so mechanism.forces still answers with peak and RMS afterwards. Reports the state reached and whether force recording is (still) on.', { readOnly: false, timeoutMs: 120_000 })
  async webEditorTestStop(): Promise<string> {
    const ctx = this._ctx();
    if (isGuardError(ctx)) return JSON.stringify(ctx);
    const { getActiveTestSession } = await import('@rv-private/plugins/asset-editor/shared/test-session-store');
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


  // ═══ Groups (plan-760 F13 — views of the Quick Edit Groups section) ═══


  async queryListKinematics(): Promise<string> {
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


  // ═══ Materials ════════════════════════════════════════════════════════

  async queryMaterialPresets(): Promise<string> {
    const ctx = this._ctx();
    if (isGuardError(ctx)) return JSON.stringify(ctx);
    const mods = await this._load();
    const all = [...mods.presets.BUILTIN_MATERIAL_PRESETS, ...mods.presets.loadCustomPresets()];
    return JSON.stringify(all.map((p) => ({
      id: p.id, name: p.name, category: p.category,
      color: p.color, metalness: p.metalness, roughness: p.roughness, opacity: p.opacity,
    })));
  }

  async queryMaterialStats(): Promise<string> {
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


  // ═══ Compounds ════════════════════════════════════════════════════════

  async kinematize(
    paths: string,
    groupName: string,
    direction: string,
    speed: number,
    lowerLimit: number,
    upperLimit: number,
    startPosition: number,
    centerPivot: boolean,
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
    await whenDocumentSettled(ctx.doc);

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
      next: 'Verify the motion with web_editor_verify_drive before saving; one editor.undo reverts everything',
    });
  }


  // ═══ Verify ═══════════════════════════════════════════════════════════

  // readOnly stays FALSE: the drive itself is moved, not just a camera. The
  // captures went offscreen with plan-740 P3.5 and the tool no longer touches
  // the viewport — but it still drags the axis through its range and selects it,
  // and CONNECT takes `readOnlyHint` blind for its write gate (D-A8 / I2).
  @McpTool('VERIFY a drive visually before saving — performed like a user would: selects the axis (gizmo + group highlight appear), aims the AGENT camera at a fitted 3/4 view of the swept volume, then smoothly drags the drive through its range while rendering N poses offscreen, springs back, and returns ONE labelled montage cropped to the sweep volume. Wrong axis/pivot/membership is immediately visible. The user viewport is never moved. Defaults: limits when UseLimits, else ±180° rotary / ±500mm linear around home.', { readOnly: false, timeoutMs: 60_000 })
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

  /** Test seam (and the one reader both import bodies use): the project file reader. */
  private _readProjectFile(relPath: string): ReturnType<typeof readProjectFile> {
    return readProjectFile(relPath);
  }

  async importGlb(
    relPath: string,
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
      await whenDocumentSettled(ctx.doc);
      return JSON.stringify({ ok: true, rootPaths: paths });
    } catch (e) {
      return JSON.stringify({ error: String(e) });
    }
  }

  async importCad(
    relPath: string,
    quality: string,
  ): Promise<string> {
    const ctx = this._ctx();
    if (isGuardError(ctx)) return JSON.stringify(ctx);
    const mods = await this._load();
    const read = await this._readProjectFile(relPath);
    if ('error' in read) return JSON.stringify(read);
    const provider = mods.cadProvider.getCadProvider(mods.cadProvider.cadFormatOfName(read.name));
    if (!provider) {
      // Mesh formats (FBX, USD, DXF …) register no CAD geometry provider — there
      // is nothing to re-tessellate — but their import-dialog provider can resolve
      // the file. Same path as the dialog: provider → GLB items → importIntoAsset.
      return this._importViaImportProvider(ctx.doc, mods, read, quality);
    }
    try {
      const file = new File([read.bytes], read.name);
      const result = await provider.importFile(file, quality?.trim() || 'standard');
      const rootPath = await ctx.doc.importCad(result);
      await whenDocumentSettled(ctx.doc);
      // plan-561: non-fatal notes (e.g. CONNECT failed, converted in the browser —
      // colours may be incomplete) reach the agent instead of a console line.
      const warnings = result.warnings ?? [];
      return JSON.stringify(warnings.length > 0 ? { ok: true, rootPath, warnings } : { ok: true, rootPath });
    } catch (e) {
      return JSON.stringify({ error: String(e) });
    }
  }

  /** `importCad` for a format without a CAD geometry provider: its import-dialog provider resolves it. */
  private async _importViaImportProvider(
    doc: ActiveAssetContext['doc'],
    mods: EditorMods,
    read: { bytes: ArrayBuffer; name: string },
    quality: string,
  ): Promise<string> {
    const { importProviderRegistry, resolveFileViaImportProvider } = await import('../../core/import/rv-import-provider');
    try {
      const resolved = await resolveFileViaImportProvider(importProviderRegistry, new File([read.bytes], read.name));
      if (!resolved.ok) return JSON.stringify({ error: resolved.error });
      const paths = await mods.importAsset.importIntoAsset(doc, resolved.items);
      await whenDocumentSettled(doc);
      const warnings = resolved.failed.map((f) => `${f.id}: ${f.error}`);
      const q = quality?.trim();
      if (q && q !== 'standard') {
        warnings.push(`quality "${q}" ignored — ${resolved.providerId} is a mesh format without tessellation`);
      }
      const rootPath = paths[0] ?? null;
      return JSON.stringify({
        ok: true, rootPath, ...(paths.length > 1 ? { rootPaths: paths } : {}),
        provider: resolved.providerId, ...(warnings.length > 0 ? { warnings } : {}),
      });
    } catch (e) {
      return JSON.stringify({ error: String(e) });
    }
  }


}

interface KinematizeArgs {
  paths: string;
  groupName: string;
  direction?: string;
  speed?: number;
  lowerLimit?: number;
  upperLimit?: number;
  startPosition?: number;
  centerPivot?: boolean;
}

export const editorKinematizeImpl: CommandImpl<KinematizeArgs, Record<string, unknown>> = {
  enabled: () => true,
  resolveArgs: (ctx, a) => {
    const groupName = (a.groupName || '').trim();
    const path = findKinematicPathForGroup(ctx.viewer, groupName);
    const node = path ? ctx.viewer.registry?.getNode(path) : null;
    const drive = node ? driveExtrasOf(node) : null;
    return {
      paths: serializePathList(parsePathsParam(a.paths), '\n'), groupName,
      // Omission preserves an existing Drive's direction; a new Drive uses LinearX.
      direction: a.direction?.trim() || (typeof drive?.['Direction'] === 'string' ? drive['Direction'] : 'LinearX'),
      centerPivot: a.centerPivot !== false,
      ...(isNum(a.speed) ? { speed: a.speed } : {}),
      ...(isNum(a.lowerLimit) ? { lowerLimit: a.lowerLimit } : {}),
      ...(isNum(a.upperLimit) ? { upperLimit: a.upperLimit } : {}),
      ...(isNum(a.startPosition) ? { startPosition: a.startPosition } : {}),
    };
  },
  run: async (ctx, a) => valueOrThrowToolJson(await new McpEditorTools(() => ctx.viewer).kinematize(
    a.paths, a.groupName, a.direction ?? '', a.speed ?? NaN, a.lowerLimit ?? NaN,
    a.upperLimit ?? NaN, a.startPosition ?? NaN, a.centerPivot !== false,
  )),
};

const importPath = (path: string): string => path?.trim().replace(/\\/g, '/').replace(/^\/+/, '') ?? '';
export const editorImportGlbImpl: CommandImpl<{ relPath: string }, Record<string, unknown>> = {
  enabled: () => true,
  resolveArgs: (_ctx, a) => ({ relPath: importPath(a.relPath) }),
  run: async (ctx, a) => valueOrThrowToolJson(await new McpEditorTools(() => ctx.viewer).importGlb(a.relPath)),
};
export const editorImportCadImpl: CommandImpl<{ relPath: string; quality?: string }, Record<string, unknown>> = {
  enabled: () => true,
  resolveArgs: (_ctx, a) => ({ relPath: importPath(a.relPath), quality: a.quality?.trim() || 'standard' }),
  run: async (ctx, a) => valueOrThrowToolJson(await new McpEditorTools(() => ctx.viewer).importCad(a.relPath, a.quality ?? 'standard')),
};

function fallbackMode(v: RVViewer): string {
  // The open document may restrict its modes (`documents[].modes`): leave the
  // editor into its default, not into a mode it would refuse.
  const restricted = v.modes.restrictedFallback();
  if (restricted && restricted !== 'editor') return restricted;
  const ids = v.modes.available().map((m) => m.id);
  return ids.includes('hmi') ? 'hmi' : ids.find((id) => id !== 'editor') ?? 'hmi';
}

function isNum(v: unknown): v is number {
  return typeof v === 'number' && !Number.isNaN(v);
}


function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── plan-641 Nachtrag 2026-10-21: the `editor.separate` command ────────

interface SeparateArgs {
  readonly paths?: string | null;
  readonly mode?: string | null;
}

const editorSeparate: CommandImpl<SeparateArgs, Record<string, unknown>> = {
  enabled: () => true,
  run: async (ctx, a) => valueOrThrowToolJson(
    await new McpEditorTools(() => ctx.viewer).separateMeshes(a?.paths ?? undefined, a?.mode ?? undefined, ctx.selection),
  ),
  // M4: the selection fallback and the default mode spelled out, so a replay
  // separates the same meshes whatever is selected then.
  resolveArgs: (ctx, a) => {
    const list = parsePathsParam(a?.paths ?? '');
    return {
      paths: serializePathList(list.length > 0 ? list : [...ctx.selection], '\n'),
      mode: (String(a?.mode ?? '').trim() || 'auto').toLowerCase(),
    };
  },
};

/**
 * Build the separation command (testable seam: no registry side effect). A
 * multi-target op: it continues past individual meshes and reports them in
 * `skipped`, which the command interface classifies as `partial`.
 */
export function createSeparateCommandDescriptors(): CommandDescriptor<never, unknown>[] {
  const sep: CommandDescriptor<SeparateArgs, Record<string, unknown>> = {
    id: EDITOR_SEPARATE_COMMAND,
    label: 'Separate meshes',
    undoLabel: 'Separate meshes',
    readOnly: false,
    macro: true,
    scope: 'none',
    available: true,
    unavailableReason: 'Not available',
    mcp: {
      tool: 'web_editor_separate',
      params: [
        { name: 'paths', type: 'string', required: false },
        { name: 'mode', type: 'string', required: false },
      ],
    },
    argsSchema: { paths: 'string', mode: 'string' },
    eagerImpl: editorSeparate,
    impl: () => Promise.resolve(editorSeparate),
  };
  return [sep as unknown as CommandDescriptor<never, unknown>];
}

const registeredSeparate = new WeakSet<CommandRegistry>();

/** Idempotent eager registration of the separation command. */
export function ensureSeparateCommandRegistered(registry: CommandRegistry = commandRegistry): void {
  if (registeredSeparate.has(registry)) return;
  registeredSeparate.add(registry);
  for (const d of createSeparateCommandDescriptors()) registry.register(d);
}

// Eager like the descriptors above (placed last: the registration set is declared above).
ensureSeparateCommandRegistered();

// ─── plan-675: the `editor.generateUVs` command ──────────────────────────
// The descriptor lives in core (`uv-command-descriptors.ts`, no bridge import) so
// the Materials window can bind a button to it; this is its lazy implementation.

/** The body of `editor.generateUVs` (lazy impl of the core descriptor). */
export const editorGenerateUVsImpl: CommandImpl<GenerateUVsArgs, Record<string, unknown>> = {
  enabled: () => true,
  run: async (ctx, a) => valueOrThrowToolJson(
    await new McpEditorTools(() => ctx.viewer).generateUVsForPaths(
      a?.paths ?? undefined, a?.mode ?? undefined, a?.overwrite ?? undefined, ctx.selection,
    ),
  ),
  resolveArgs: (ctx, a) => resolveGenerateUVsArgs(ctx, a),
};

export { createGenerateUVsCommandDescriptors, ensureGenerateUVsCommandRegistered };

/**
 * Read a file out of the OPEN PROJECT (plan-709 §2.6.2).
 *
 * One store, whichever backend the project has: a folder project reads from
 * disk, a browser project from OPFS, and the agent passes the same
 * project-relative path either way. `readBlobBytes` is the bytes primitive
 * added in §2.5 — no object URL is minted to read a file.
 */
export async function readProjectFile(relPath: string):
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
