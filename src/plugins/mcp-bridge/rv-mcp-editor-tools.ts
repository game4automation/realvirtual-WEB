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
import { libraryDocumentBase } from '../../core/editor/active-asset-store';
import type { AssetBase } from '../../core/editor/rv-asset-document';
// Type-only: the module itself is dynamically imported inside the mechanism
// tools so the asset-editor chunk stays lazy (see the module header).
import type {
  DensityPresetId, JointKind, MechanismDocumentLike, MechanismOpPlan,
} from '@rv-private/plugins/asset-editor/mechanism/mechanism-authoring';
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
import { requireEditor, isGuardError } from './rv-mcp-editor-guard';
import { parsePathsParam } from './rv-object-analyzer-math';
import { captureFrameCanvas, canvasToRvImage, compositeMontage } from './rv-frame-capture';
import { arrayBufferOf } from '../../core/project/rv-scene-record';
import { buildMeshUniverse } from './rv-mcp-view-tools';
import {
  computeIdenticalPaths,
  computeSameMaterialPaths,
  computeInvertPaths,
  expandToUniverseMeshes,
} from '@rv-private/plugins/asset-editor/select-actions';

const r3 = (n: number): number => +n.toFixed(3);

/** Refusal shown for every structural verb aimed at the GLB root (plan-715 F4). */
const MODEL_ROOT_LOCKED =
  'The model root is locked: it cannot be renamed, transformed, hidden, deleted or reparented '
  + '(its name is the first segment of every node path and its pose is the asset origin). '
  + 'Edit its components/metadata instead, or target a child node.';

/** Kinematic component keys in rv_extras, tolerant of the `_N` dedup suffix. */
const KINEMATIC_KEY_RE = /^Kinematic(_\d+)?$/;
const DRIVE_KEY_RE = /^Drive(_\d+)?$/;
/** Rigid-body MECHANISM container keys — the ancestor walk of `_mechCommit`. */
const MECHANISM_KEY_RE = /^KinematicMechanism(_\d+)?$/;

/**
 * The one refusal every mechanism tool gives without the private bundle.
 *
 * It names the ALTERNATIVE, not just the absence: an agent that reads only
 * "not available" retries the same call three times before giving up, whereas
 * the axis-group system is right there and is what most single-axis authoring
 * actually wants.
 */
const MECHANISM_UNAVAILABLE =
  'Rigid-body mechanisms are not available in this build (private bundle missing). '
  + 'Axis-group kinematics are available via web_editor_create_kinematic.';

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
 *  `isAutosaveSuspended` is true exactly for the duration of a test run. */
function testRunGuard(ctx: ActiveAssetContext): { error: string } | null {
  if (!ctx.doc.isAutosaveSuspended) return null;
  return {
    error: 'A test run is active (in-place test session): edits made now are rolled back '
      + 'together with the test scene when the run stops, so they would be lost silently. '
      + 'Stop the test run first, then repeat the edit.',
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

/**
 * One entry of the snap-candidate cache behind `web_editor_mechanism_snap_list`.
 *
 * The alternative — handing the full candidate geometry back and taking it in
 * again on the commit — would ask the agent to reproduce a position and a normal
 * vector without a rounding error, which is the exact failure class snapping
 * exists to remove. Precedent in house: `web_layout_snap_list` →
 * `web_layout_snap_attach`.
 */
interface CachedSnapCandidate {
  id: string;
  kind: string;
  label: string;
  nodePath: string;
  worldPosition: Vector3;
  worldNormal: Vector3;
  radius?: number;
  inner?: boolean;
  recommended: boolean;
}

export class McpEditorTools {
  constructor(private readonly getViewer: () => RVViewer | undefined) {}

  /**
   * The candidate set of the LAST `snap_list`, addressed by `snap0..snapN`.
   *
   * A new listing invalidates the previous one on purpose: two live sets would
   * make `snap3` ambiguous, and an id that silently means yesterday's bore is a
   * wrong anchor with no error attached.
   */
  private _snapCache: CachedSnapCandidate[] = [];

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

  /** Handle unsaved changes per the ifDirty policy. Returns an error string or null. */
  private async _handleDirty(
    ctx: ActiveAssetContext, ifDirty: string | undefined, saveName?: string,
  ): Promise<string | null> {
    if (!ctx.doc.dirty) return null;
    const policy = (ifDirty || 'fail').toLowerCase();
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

  @McpTool('Open the ASSET EDITOR with a document: source=new (creates a NEW document in the open project and opens it) or source=library with relPath (e.g. "Custom/MyAsset.glb", relative to <workfolder>/library/). source=empty is a deprecated alias of source=new. When the editor is already open with unsaved changes, ifDirty decides: fail (default) | save (needs a saved name) | discard. Editing happens through the web_editor_* tools; finish with web_editor_save.', { readOnly: false, timeoutMs: 120_000 })
  async webEditorOpen(
    @McpParam('source', 'new | library. ("empty" is a deprecated alias of "new".)') source: string,
    @McpParam('relPath', 'Library-relative GLB path (source=library), e.g. "Custom/MyAsset.glb".', 'string', false) relPath: string,
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
      pending = libraryDocumentBase(relPath.trim());
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

  @McpTool('Locate the KNOWLEDGE FOLDER for the open asset inside the OPEN PROJECT — the durable home for notes, a part catalogue and saved views across sessions. Returns the project name/kind, whether it is writable, the asset\'s library-relative path when it has one, and knowledgeRelPath ("knowledge/<AssetName>"). Every path here is PROJECT-relative, which is all the other tools need: web_editor_import_glb / web_editor_import_cad read them, web_render / web_screenshot_annotated write them via savePath. absolutePath is ALWAYS null — the browser exposes no filesystem path, and a browser project (OPFS) has none; put files in through the app, not the OS file manager.', { readOnly: true })
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
    const [documents, models, library, stats] = await Promise.all([
      backend.listDocuments().catch(() => []),
      backend.listModels().catch(() => []),
      backend.listLibrary().catch(() => []),
      backend.statDocuments().catch(() => []),
    ]);
    const statByPath = new Map(stats.map(s => [s.path, s]));

    interface FileRow {
      path: string; name: string; sizeBytes: number | null;
      modified: string | null;
      /** First path segment, `''` at the project root — where the file IS. */
      folder: string;
      /** @deprecated plan-736 — carries the identical value as `folder`. */
      section: string;
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
      // listing, and how a root-level file ended up filed as `null`. `section`
      // stays as a deprecated alias with the identical value, so an agent
      // prompt written against the old field keeps working for one release.
      const folder = path.includes('/') ? path.slice(0, path.indexOf('/')) : '';
      byPath.set(path, {
        path, name,
        sizeBytes: sizeBytes ?? stat?.size ?? null,
        modified: modified ?? (stat?.mtime ? new Date(stat.mtime).toISOString() : null),
        folder, section: folder, documentId,
      });
    };
    for (const d of documents) {
      put(d.path, d.name, d.id, d.sizeBytes ?? null, d.modifiedAt ?? null);
    }
    const fileStem = (p: string): string => (p.split('/').pop() ?? p).replace(/\.glb$/i, '');
    for (const m of models) put(m.path, m.label || fileStem(m.path), m.id ?? null, m.sizeBytes ?? null, null);
    for (const l of library) put(l.path, l.label || fileStem(l.path), l.id ?? null, l.sizeBytes ?? null, null);
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

  @McpTool('Undo the last N editor operations (default 1).', { readOnly: false })
  async webEditorUndo(
    @McpParam('count', 'Number of undo steps (default 1).', 'integer', false) count: number,
  ): Promise<string> {
    const ctx = this._ctx();
    if (isGuardError(ctx)) return JSON.stringify(ctx);
    const n = Math.max(1, Math.round(count || 1));
    let done = 0;
    for (let i = 0; i < n && ctx.doc.getSnapshot().canUndo; i++) { await ctx.doc.undo(); done++; }
    const snap = ctx.doc.getSnapshot();
    return JSON.stringify({ undone: done, canUndo: snap.canUndo, canRedo: snap.canRedo });
  }

  @McpTool('Redo the last N undone editor operations (default 1).', { readOnly: false })
  async webEditorRedo(
    @McpParam('count', 'Number of redo steps (default 1).', 'integer', false) count: number,
  ): Promise<string> {
    const ctx = this._ctx();
    if (isGuardError(ctx)) return JSON.stringify(ctx);
    const n = Math.max(1, Math.round(count || 1));
    let done = 0;
    for (let i = 0; i < n && ctx.doc.getSnapshot().canRedo; i++) { await ctx.doc.redo(); done++; }
    const snap = ctx.doc.getSnapshot();
    return JSON.stringify({ redone: done, canUndo: snap.canUndo, canRedo: snap.canRedo });
  }

  @McpTool('Save the asset as GLB into <workfolder>/library/Custom/. The document saves under its current name whatever it is (an "Untitled" name is a name like any other); the same name overwrites the existing file. Needs a configured work folder (File System Access). Reports saveVerb — save (in place), save-into-project (this write COPIES the document into the project and changes its identity) or blocked with a reason.', { readOnly: false, timeoutMs: 60_000 })
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
    const decision = await this._saveVerb('asset', finalName);
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
    lineage: 'asset', name: string,
  ): Promise<{ saveVerb?: string; saveReason?: string; copies?: boolean }> {
    try {
      const ctx = this._ctx();
      if (isGuardError(ctx)) return {};
      const [{ getProjectStore }, { decideSaveVerb }] = await Promise.all([
        import('../../core/project/project-store'),
        import('../../core/editor/rv-save-document'),
      ]);
      const d = decideSaveVerb(
        { lineage, base: ctx.doc.getSnapshot().base, name },
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

  @McpTool('Zero the LOCAL position of the given nodes (Quick Edit "Zero Local"). One undo unit.', { readOnly: false })
  async webEditorZeroPosition(
    @McpParam('paths', 'Node paths, comma/newline-separated.') paths: string,
  ): Promise<string> {
    const ctx = this._ctx();
    if (isGuardError(ctx)) return JSON.stringify(ctx);
    const mods = await this._load();
    const list = parsePathsParam(paths);
    await mods.transform.zeroLocalPosition(ctx.viewer, ctx.doc, list);
    return JSON.stringify({ ok: true, count: list.length });
  }

  @McpTool('Rotate a node ±90° around a LOCAL axis (Quick Edit rotate buttons). axis = x|y|z, sign = 1|-1.', { readOnly: false })
  async webEditorRotate90(
    @McpParam('path', 'Node path.') path: string,
    @McpParam('axis', 'x | y | z.') axis: string,
    @McpParam('sign', '1 or -1 (default 1).', 'integer', false) sign: number,
  ): Promise<string> {
    const ctx = this._ctx();
    if (isGuardError(ctx)) return JSON.stringify(ctx);
    const a = (axis || '').toLowerCase();
    if (!['x', 'y', 'z'].includes(a)) return JSON.stringify({ error: 'axis must be x|y|z' });
    const mods = await this._load();
    mods.transform.rotate90(ctx.viewer, ctx.doc, path, a as 'x' | 'y' | 'z', sign === -1 ? -1 : 1);
    await ctx.doc.whenIdle();
    return JSON.stringify({ ok: true, path, axis: a, sign: sign === -1 ? -1 : 1 });
  }

  @McpTool('Drop a node so its bounding box rests on the ground (Y = 0). Quick Edit "To Ground".', { readOnly: false })
  async webEditorToGround(
    @McpParam('path', 'Node path.') path: string,
  ): Promise<string> {
    const ctx = this._ctx();
    if (isGuardError(ctx)) return JSON.stringify(ctx);
    const mods = await this._load();
    mods.transform.toGround(ctx.viewer, ctx.doc, path);
    await ctx.doc.whenIdle();
    return JSON.stringify({ ok: true, path });
  }

  @McpTool('Move a node\'s PIVOT without moving geometry (children compensated, one undo unit). mode: bottom (pivot to bounds bottom-center) | object_center (to targetPath\'s precise vertex center — THE tool for placing a rotation axis on a specific part) | group_center (kinematic axis to its group\'s center) | align_y_up (rotate so local +Y is world up).', { readOnly: false })
  async webEditorPivot(
    @McpParam('path', 'Node path whose pivot moves.') path: string,
    @McpParam('mode', 'bottom | object_center | group_center | align_y_up.') mode: string,
    @McpParam('targetPath', 'Target node (required for object_center).', 'string', false) targetPath: string,
  ): Promise<string> {
    const ctx = this._ctx();
    if (isGuardError(ctx)) return JSON.stringify(ctx);
    const mods = await this._load();
    const m = (mode || '').toLowerCase();
    if (m === 'bottom') await mods.transform.pivotToBottom(ctx.viewer, ctx.doc, path);
    else if (m === 'group_center') await mods.transform.centerKinematicToGroup(ctx.viewer, ctx.doc, path);
    else if (m === 'align_y_up') await mods.transform.alignYUp(ctx.viewer, ctx.doc, path);
    else if (m === 'object_center') {
      if (!targetPath) return JSON.stringify({ error: 'object_center needs targetPath' });
      await mods.transform.pivotToObjectCenter(ctx.viewer, ctx.doc, path, targetPath);
    } else {
      return JSON.stringify({ error: 'mode must be bottom | object_center | group_center | align_y_up' });
    }
    const node = ctx.viewer.registry?.getNode(path);
    const wp = node ? node.getWorldPosition(new Vector3()) : null;
    return JSON.stringify({ ok: true, path, mode: m, pivotWorld: wp ? [r3(wp.x), r3(wp.y), r3(wp.z)] : null });
  }

  @McpTool('Rename a node (undoable).', { readOnly: false })
  async webEditorRename(
    @McpParam('path', 'Node path.') path: string,
    @McpParam('name', 'New name.') name: string,
  ): Promise<string> {
    const ctx = this._ctx();
    if (isGuardError(ctx)) return JSON.stringify(ctx);
    const node = ctx.viewer.registry?.getNode(path);
    if (!node) return JSON.stringify({ error: `Node not found: ${path}` });
    if (isModelRoot(node, ctx.viewer.currentModelRoot)) return JSON.stringify({ error: MODEL_ROOT_LOCKED });
    const trimmed = (name || '').trim();
    if (!trimmed) return JSON.stringify({ error: 'Empty name' });
    ctx.doc.renameNode(path, trimmed, node.name);
    await ctx.doc.whenIdle();
    const idx = path.lastIndexOf('/');
    return JSON.stringify({ ok: true, path: idx < 0 ? trimmed : path.slice(0, idx + 1) + trimmed });
  }

  @McpTool('Delete nodes (descendants of other given paths are pruned automatically; one undo unit).', { readOnly: false })
  async webEditorDelete(
    @McpParam('paths', 'Node paths, comma/newline-separated.') paths: string,
  ): Promise<string> {
    const ctx = this._ctx();
    if (isGuardError(ctx)) return JSON.stringify(ctx);
    const mods = await this._load();
    const candidates = parsePathsParam(paths).filter((p) => {
      const node = ctx.viewer.registry?.getNode(p);
      return !!node && !!node.parent && !isModelRoot(node, ctx.viewer.currentModelRoot);
    });
    const pruned = mods.del.pruneDescendantPaths(candidates);
    if (pruned.length === 0) return JSON.stringify({ error: 'No deletable nodes among the given paths' });
    await ctx.doc.deleteNodes(pruned);
    return JSON.stringify({ ok: true, deleted: pruned.length });
  }

  @McpTool('Show or hide nodes (authored visibility — saved with the asset, undoable).', { readOnly: false })
  async webEditorSetVisible(
    @McpParam('paths', 'Node paths, comma/newline-separated.') paths: string,
    @McpParam('visible', 'true to show, false to hide.', 'boolean') visible: boolean,
  ): Promise<string> {
    const ctx = this._ctx();
    if (isGuardError(ctx)) return JSON.stringify(ctx);
    const list = parsePathsParam(paths);
    let changed = 0;
    for (const p of list) {
      const node = ctx.viewer.registry?.getNode(p);
      if (!node) continue;
      // The model root stays visible (plan-715 F4). Reported rather than
      // silently skipped so a single-path call gets a real answer.
      if (isModelRoot(node, ctx.viewer.currentModelRoot)) {
        if (list.length === 1) return JSON.stringify({ error: MODEL_ROOT_LOCKED });
        continue;
      }
      ctx.doc.setNodeVisible(p, visible !== false);
      changed++;
    }
    await ctx.doc.whenIdle();
    return JSON.stringify({ ok: true, changed, visible: visible !== false });
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

  @McpTool('Create an empty node (under parentPath, or at the asset root when omitted). Returns the new path.', { readOnly: false })
  async webEditorCreateEmpty(
    @McpParam('parentPath', 'Parent node path (omit for asset root).', 'string', false) parentPath: string,
    @McpParam('name', 'Node name (default "Empty").', 'string', false) name: string,
  ): Promise<string> {
    const ctx = this._ctx();
    if (isGuardError(ctx)) return JSON.stringify(ctx);
    const newPath = await ctx.doc.createEmptyNode(parentPath?.trim() || null, name?.trim() || 'Empty');
    return JSON.stringify({ ok: true, path: newPath });
  }

  @McpTool('Move nodes under a new parent, preserving world poses (undoable). newParentPath omitted = asset root.', { readOnly: false })
  async webEditorReparent(
    @McpParam('paths', 'Node paths to move, comma/newline-separated.') paths: string,
    @McpParam('newParentPath', 'Target parent path (omit for asset root).', 'string', false) newParentPath: string,
  ): Promise<string> {
    const ctx = this._ctx();
    if (isGuardError(ctx)) return JSON.stringify(ctx);
    const moved = await ctx.doc.reparentNodes(parsePathsParam(paths), newParentPath?.trim() || null);
    return JSON.stringify({ ok: true, moved });
  }

  @McpTool('Add a component to a node (Quick Edit "Components" section): Drive, Kinematic, Sensor, TransportSurface, Source, Sink, Grip, drive behaviors, signals, LogicSteps… Starts from schema defaults; optional propsJson overrides fields (e.g. {"Direction":"RotationY"}). Returns the concrete component key. Undoable.', { readOnly: false })
  async webEditorAddComponent(
    @McpParam('path', 'Node path.') path: string,
    @McpParam('type', 'Component base type (e.g. Drive).') type: string,
    @McpParam('propsJson', 'Optional JSON object of field overrides.', 'string', false) propsJson: string,
  ): Promise<string> {
    const ctx = this._ctx();
    if (isGuardError(ctx)) return JSON.stringify(ctx);
    const testRun = testRunGuard(ctx);
    if (testRun) return JSON.stringify(testRun);
    if (!ctx.viewer.registry?.getNode(path)) return JSON.stringify({ error: `Node not found: ${path}` });
    const authorable = getTypesWithCapability('authorable');
    if (authorable.length > 0 && !authorable.includes(type)) {
      return JSON.stringify({ error: `Unknown component type "${type}"`, availableTypes: authorable });
    }
    let overrides: Record<string, unknown> = {};
    if (propsJson) {
      try {
        const parsed = JSON.parse(propsJson);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error();
        overrides = parsed as Record<string, unknown>;
      } catch {
        return JSON.stringify({ error: 'propsJson must be a JSON object string' });
      }
    }
    const fields = { ...getSchemaDefaults(type), ...overrides };
    if (type === 'Drive' && fields['Direction'] === undefined) fields['Direction'] = 'LinearX';
    const key = ctx.doc.addComponent(path, type, fields);
    await ctx.doc.whenIdle();
    return JSON.stringify({ ok: true, path, component: key, fields });
  }

  @McpTool('Remove a component from a node by its concrete key (e.g. "Drive" or "Drive_1" — see web_component_get_all). Undoable.', { readOnly: false })
  async webEditorRemoveComponent(
    @McpParam('path', 'Node path.') path: string,
    @McpParam('componentType', 'Concrete component key.') componentType: string,
  ): Promise<string> {
    const ctx = this._ctx();
    if (isGuardError(ctx)) return JSON.stringify(ctx);
    const testRun = testRunGuard(ctx);
    if (testRun) return JSON.stringify(testRun);
    const node = ctx.viewer.registry?.getNode(path);
    if (!node) return JSON.stringify({ error: `Node not found: ${path}` });
    if (!(componentType in rvOf(node))) {
      return JSON.stringify({ error: `No component "${componentType}" on ${path}`, components: Object.keys(rvOf(node)) });
    }
    ctx.doc.removeComponent(path, componentType);
    await ctx.doc.whenIdle();
    return JSON.stringify({ ok: true, path, removed: componentType });
  }

  @McpTool('Set one field of a component on a node (undoable, live in the panels). valueJson is parsed as JSON (numbers/booleans/strings/objects; bare strings work too). VERIFIED: ok is returned only after the value has been read back from the live scene — a dropped or refused op returns an error instead.', { readOnly: false })
  async webEditorSetField(
    @McpParam('path', 'Node path.') path: string,
    @McpParam('componentType', 'Concrete component key (e.g. Drive).') componentType: string,
    @McpParam('fieldName', 'Field name (e.g. TargetSpeed).') fieldName: string,
    @McpParam('valueJson', 'New value as JSON (e.g. 500, true, "RotationY").') valueJson: string,
  ): Promise<string> {
    const ctx = this._ctx();
    if (isGuardError(ctx)) return JSON.stringify(ctx);
    const node = ctx.viewer.registry?.getNode(path);
    if (!node) return JSON.stringify({ error: `Node not found: ${path}` });
    const comp = rvOf(node)[componentType] as Record<string, unknown> | undefined;
    if (!comp || typeof comp !== 'object') {
      return JSON.stringify({ error: `No component "${componentType}" on ${path}`, components: Object.keys(rvOf(node)) });
    }
    const testRun = testRunGuard(ctx);
    if (testRun) return JSON.stringify(testRun);
    let value: unknown;
    try { value = JSON.parse(valueJson); }
    catch { value = valueJson; } // bare string
    const prev = comp[fieldName];
    // AWAITED, not detached: the detached path swallows an executor refusal
    // outside a transaction, and this tool used to answer "ok" for an op that
    // never landed (Bug #9 — fields silently reverting in the saved GLB).
    try {
      await ctx.doc.setFieldAwaited(path, componentType, fieldName, value, prev);
    } catch (e) {
      return JSON.stringify({
        error: `setField failed: ${e instanceof Error ? e.message : String(e)}`,
        path, componentType, fieldName,
      });
    }
    // Read-back verification. A resolve alone is not proof: an op queued during
    // a base swap is dropped inside the queue without an error, and a scene
    // swap (editor re-activation, test-session restore) can replace the node
    // between guard and write. What the export will serialize is the node's
    // userData — so that is what "landed" means.
    const nodeAfter = ctx.viewer.registry?.getNode(path);
    const stored = nodeAfter
      ? (rvOf(nodeAfter)[componentType] as Record<string, unknown> | undefined)?.[fieldName]
      : undefined;
    if (!fieldValuesEqual(stored, value)) {
      return JSON.stringify({
        error: `setField did not land: "${componentType}.${fieldName}" on ${path} still holds `
          + `${JSON.stringify(stored ?? null)} after the op. The op was dropped or the scene changed `
          + 'underneath (base swap, editor re-activation, test-session restore) — '
          + 'check web_editor_status and retry.',
        path, componentType, fieldName, value, stored: stored ?? null,
      });
    }
    // Live-instance value for the agent (saves the manual web_component_get):
    // may legitimately differ from `value` for componentRef fields, which the
    // instance holds in RESOLVED form.
    const instance = ctx.viewer.registry?.getByPath(componentType, path) as Record<string, unknown> | null;
    const liveRaw = instance && fieldName in instance ? instance[fieldName] : undefined;
    const live = (liveRaw === null || ['number', 'string', 'boolean'].includes(typeof liveRaw))
      ? liveRaw : undefined;
    return JSON.stringify({
      ok: true, path, componentType, fieldName, value, prev: prev ?? null,
      ...(live !== undefined ? { live } : {}),
    });
  }

  // ── Rigid-body mechanisms (plan-404) ──────────────────────────────────
  //
  // These orchestrate COMPOSITES of the existing generic ops (addComponent /
  // setField / unsetField) through `runMechanismPlan` — the op union and
  // its dispatchers are untouched by design (plan-404 §2.6). `_validate` and
  // `_jog` are TRANSIENT: they create no ops and no undo entries.
  //
  // NOTE the naming: "mechanism" is the RIGID-BODY joint-graph system, not the
  // older `Kinematic` axis-group system that `web_editor_kinematize` /
  // `web_editor_create_kinematic` below drive. The two are never mixed.

  @McpTool('Add a rigid-body MECHANISM (KinematicMechanism) to a node — the container that solves a joint graph with loop closure and free bodies. Add joints afterwards with web_editor_mechanism_add_joint. NOTE: mechanism = the rigid-body joint graph, NOT the axis-group Kinematic system (see web_editor_list_kinematics). Undoable.', { readOnly: false })
  async webEditorMechanismCreate(
    @McpParam('path', 'Node the mechanism component is added to.') path: string,
  ): Promise<string> {
    const ctx = this._ctx();
    if (isGuardError(ctx)) return JSON.stringify(ctx);
    const bridge = await this._requireMechanismBridge();
    if (isMechError(bridge)) return JSON.stringify(bridge);
    if (!ctx.viewer.registry?.getNode(path)) return JSON.stringify({ error: `Node not found: ${path}` });
    const m = await import('@rv-private/plugins/asset-editor/mechanism/mechanism-authoring');
    await this._mechCommit(ctx, bridge, path, m.planCreateMechanism(path));
    return JSON.stringify({ ok: true, path, component: 'KinematicMechanism' });
  }

  @McpTool('Add a KinematicJoint to a mechanism. jointType = Revolute|Prismatic|Spherical|Universal. bodyBPath is required; OMIT bodyAPath to anchor the joint against WORLD/static space (the authored world-anchor form — an absent Body A, never an empty string). anchors are in millimetres in the respective body local frame; axisA is Body-A-local. NOTE: mechanism = the rigid-body joint graph, NOT the axis-group Kinematic system (see web_editor_list_kinematics). Undoable, one composite.', { readOnly: false })
  async webEditorMechanismAddJoint(
    @McpParam('path', 'Node the joint component is added to (a child of the mechanism node).') path: string,
    @McpParam('jointType', 'Revolute | Prismatic | Spherical | Universal.') jointType: string,
    @McpParam('bodyBPath', 'Node path of Body B (required).') bodyBPath: string,
    @McpParam('bodyAPath', 'Node path of Body A. Omit for a world anchor.', 'string', false) bodyAPath: string,
    @McpParam('anchorAJson', 'Anchor A as JSON {x,y,z} in mm (Body-A-local).', 'string', false) anchorAJson: string,
    @McpParam('anchorBJson', 'Anchor B as JSON {x,y,z} in mm (Body-B-local).', 'string', false) anchorBJson: string,
    @McpParam('axisAJson', 'Axis A as JSON {x,y,z} (Body-A-local).', 'string', false) axisAJson: string,
  ): Promise<string> {
    const ctx = this._ctx();
    if (isGuardError(ctx)) return JSON.stringify(ctx);
    const bridge = await this._requireMechanismBridge();
    if (isMechError(bridge)) return JSON.stringify(bridge);
    const m = await import('@rv-private/plugins/asset-editor/mechanism/mechanism-authoring');
    const kinds = m.JOINT_KINDS as readonly string[];
    if (!kinds.includes(jointType)) {
      return JSON.stringify({ error: `Unknown jointType "${jointType}"`, availableTypes: kinds });
    }
    if (!ctx.viewer.registry?.getNode(path)) return JSON.stringify({ error: `Node not found: ${path}` });
    if (!ctx.viewer.registry?.getNode(bodyBPath)) return JSON.stringify({ error: `Body B node not found: ${bodyBPath}` });
    const bodyA = bodyAPath?.trim() || null;
    if (bodyA && !ctx.viewer.registry?.getNode(bodyA)) {
      return JSON.stringify({ error: `Body A node not found: ${bodyA}. Omit bodyAPath for a world anchor.` });
    }
    const vec = (json: string): { x: number; y: number; z: number } | undefined => {
      if (!json) return undefined;
      try {
        const p = JSON.parse(json) as { x?: number; y?: number; z?: number };
        return { x: Number(p.x ?? 0), y: Number(p.y ?? 0), z: Number(p.z ?? 0) };
      } catch { return undefined; }
    };
    await this._mechCommit(ctx, bridge, path, m.planAddJoint({
      nodePath: path,
      jointType: jointType as JointKind,
      bodyAPath: bodyA,
      bodyBPath,
      anchorA: vec(anchorAJson),
      anchorB: vec(anchorBJson),
      axisA: vec(axisAJson),
    }));
    return JSON.stringify({ ok: true, path, jointType, bodyA: bodyA ?? 'world', bodyB: bodyBPath });
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

  @McpTool('Assign the Drive that actively controls a joint, or clear it. OMIT drivePath to make the joint PASSIVE again (the reference key is removed, which is the authored "no drive" form). NOTE: mechanism = the rigid-body joint graph, NOT the axis-group Kinematic system (see web_editor_list_kinematics). Undoable.', { readOnly: false })
  async webEditorMechanismAssignDrive(
    @McpParam('path', 'Node path of the joint.') path: string,
    @McpParam('componentType', 'Concrete joint key (e.g. KinematicJoint).') componentType: string,
    @McpParam('drivePath', 'Node path carrying the Drive. Omit to clear.', 'string', false) drivePath: string,
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
    const target = drivePath?.trim() || null;
    if (target) {
      const driveNode = ctx.viewer.registry?.getNode(target);
      if (!driveNode) return JSON.stringify({ error: `Drive node not found: ${target}` });
      if (!Object.keys(rvOf(driveNode)).some((k) => DRIVE_KEY_RE.test(k))) {
        return JSON.stringify({ error: `Node "${target}" carries no Drive component` });
      }
    }
    const m = await import('@rv-private/plugins/asset-editor/mechanism/mechanism-authoring');
    await this._mechCommit(ctx, bridge, path, m.planAssignDrive(path, componentType, target));
    return JSON.stringify({ ok: true, path, componentType, drive: target });
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

  @McpTool('Jog one driven joint to an absolute value (degrees for Revolute, millimetres for Prismatic) and run ONE solve, reporting the REAL convergence and residual. TRANSIENT — writes a live drive value only, creates no ops and no undo entry. NOTE: mechanism = the rigid-body joint graph, NOT the axis-group Kinematic system (see web_editor_list_kinematics).', { readOnly: false })
  async webEditorMechanismJog(
    @McpParam('path', 'Node path of the joint to jog.') path: string,
    @McpParam('value', 'Absolute joint value (deg or mm).', 'number') value: number,
    @McpParam('componentType', 'Concrete joint key (e.g. KinematicJoint_2) when several joints sit on one node. Omit for one-joint-per-node authoring.', 'string', false) componentType: string,
  ): Promise<string> {
    const bridge = await this._requireMechanismBridge();
    if (isMechError(bridge)) return JSON.stringify(bridge);
    const result = bridge.jog(path, Number(value), componentType?.trim() || undefined);
    if (!result) {
      return JSON.stringify({ error: `Joint "${path}"${componentType ? ` (${componentType})` : ''} not found, not driven, or its mechanism cannot solve` });
    }
    return JSON.stringify({ ok: true, path, ...(componentType ? { componentType } : {}), value: Number(value), ...result });
  }

  /** Adapter: the AssetDocument slice the mechanism plans need. */
  private _mechDoc(ctx: ActiveAssetContext): MechanismDocumentLike {
    return {
      withTransaction: (label, fn) => ctx.doc.withTransaction(label, fn),
      addComponent: (nodePath, baseType, fields) => ctx.doc.addComponent(nodePath, baseType, fields),
      setField: (nodePath, componentType, fieldName, v, prev) =>
        ctx.doc.setField(nodePath, componentType, fieldName, v, prev),
      unsetField: (nodePath, componentType, fieldName, prev) =>
        ctx.doc.unsetField(nodePath, componentType, fieldName, prev),
    };
  }

  /** Adapter: read a field's current value for the inverse half of an op. */
  private _mechReadField(ctx: ActiveAssetContext) {
    return (nodePath: string, componentType: string, fieldName: string): unknown => {
      const node = ctx.viewer.registry?.getNode(nodePath);
      if (!node) return undefined;
      const comp = rvOf(node)[componentType] as Record<string, unknown> | undefined;
      return comp?.[fieldName];
    };
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
   * Which mechanism(s) a write on `targetPath` invalidates — THREE stages, in
   * this order (plan-706, Review F3):
   *
   *  1. **Ancestor walk.** The first self-or-ancestor carrying a
   *     `KinematicMechanism` key. This is the normal case for everything the
   *     authoring flow produces: joints are placed on children of the mechanism
   *     node, and an imported assembly's links hang under it too.
   *  2. **`bridge.list()` search.** A mechanism that already references the
   *     node as a joint or a link. Catches the legitimate case of a body OUTSIDE
   *     the mechanism subtree, linked only by a `ComponentReference`.
   *  3. **Everything.** Expensive, never wrong.
   *
   * Stage 1 comes FIRST because stage 2 structurally misses the commonest new
   * write: `planAddBody` only puts a `MechanismBody` on a node, and until some
   * joint references that node it appears in no `links[]` — so `add_body` and
   * `set_mass` would have fallen through to "rebuild everything" every time,
   * making the last-resort branch the normal path.
   */
  private _mechanismPathsFor(
    ctx: ActiveAssetContext, bridge: MechanismUiBridge, targetPath: string,
  ): string[] {
    const registry = ctx.viewer.registry;
    for (let node = registry?.getNode(targetPath) ?? null; node; node = node.parent) {
      if (!Object.keys(rvOf(node)).some((k) => MECHANISM_KEY_RE.test(k))) continue;
      const path = registry?.getPathForNode(node) ?? NodeRegistry.computeNodePath(node);
      if (path) return [path];
    }
    const all = bridge.list();
    const referencing = all.filter((m) =>
      m.nodePath === targetPath
      || m.joints.some((j) => j.nodePath === targetPath)
      || m.links.some((l) => l.nodePath === targetPath));
    return (referencing.length > 0 ? referencing : all).map((m) => m.nodePath);
  }

  /**
   * Run an authoring composite AND make the solver see it (plan-706 F2).
   *
   * The panel has always done both — `runMechanismPlan` then
   * `bridge.rebuild(mechanismPath)` (`MechanismSection.tsx`, the `commit`
   * callbacks) — while the MCP tools did only the first half, so an anchor set
   * by an agent took effect the next time a human happened to touch the panel.
   * Every writing mechanism tool goes through here, which is what makes the
   * following `validate`/`inspect` read the topology that was just written.
   *
   * The rebuild runs strictly AFTER `withTransaction` resolves: rebuilding a
   * half-applied composite would hand the solver a joint whose body is not
   * assigned yet.
   */
  private async _mechCommit(
    ctx: ActiveAssetContext, bridge: MechanismUiBridge, targetPath: string, plan: MechanismOpPlan,
  ): Promise<void> {
    const m = await import('@rv-private/plugins/asset-editor/mechanism/mechanism-authoring');
    await m.runMechanismPlan(this._mechDoc(ctx), plan, this._mechReadField(ctx));
    await ctx.doc.whenIdle();
    for (const path of this._mechanismPathsFor(ctx, bridge, targetPath)) bridge.rebuild(path);
  }

  @McpTool('Read a rigid-body MECHANISM in full: joints (type, bodies, drive, current value, limits, world origin and axis, joggable), links with their mass properties (hasBody, massKg, massSource, massWarning), findings, and convergence (converged, residualError, dof, loopCount). Omit path to read every mechanism; use include to keep the answer small. This is the READ half of the authoring cycle — call it before and after every edit. NOTE: this is the joint-graph mechanism system, NOT the axis-group Kinematic system (see web_editor_list_kinematics). Read-only.', { readOnly: true })
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
        ...(want('findings') ? { findings: m.findings } : {}),
      })),
    });
  }

  /** Resolve a cached snap id, or the actionable refusal (R6). */
  private _snapCandidate(
    ctx: ActiveAssetContext, candidateId: string,
  ): CachedSnapCandidate | { error: string; availableIds?: string[] } {
    const id = (candidateId || '').trim();
    const found = this._snapCache.find((c) => c.id === id);
    if (!found) {
      return {
        error: `Unknown candidateId "${id}" — call web_editor_mechanism_snap_list first`,
        availableIds: this._snapCache.map((c) => c.id),
      };
    }
    // The model may have been rebuilt between the listing and the commit; a
    // candidate pointing at geometry that no longer exists must refuse rather
    // than write a plausible-looking anchor into a stale frame.
    if (!ctx.viewer.registry?.getNode(found.nodePath)) {
      return { error: `Node "${found.nodePath}" no longer exists — call web_editor_mechanism_snap_list again` };
    }
    return found;
  }

  @McpTool('List the SNAP CANDIDATES under a canvas point (x,y as 0..1 fractions) so an anchor or a joint axis can be set on real geometry instead of guessed millimetres: bore axes, circle centres, edge/face centres and vertices, each with a stable id, a world position and a world normal. Exactly one is recommended — what a click would take. Aim the camera first (web_camera_focus, web_view_pick), then pass the ids to web_editor_mechanism_set_anchor_snap or _set_axis. Ids live until the next call. NOTE: mechanism = joint graph, NOT the axis-group Kinematic system (see web_editor_list_kinematics).', { readOnly: true })
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
    if (!result) {
      this._snapCache = [];
      return JSON.stringify({ ok: true, hit: false, candidates: [], hint: 'Nothing under that point — reframe with web_camera_focus and try again' });
    }

    this._snapCache = result.candidates.map((c, i) => ({
      id: `snap${i}`,
      kind: c.kind,
      label: c.label,
      nodePath: result.nodePath,
      worldPosition: c.worldPosition,
      worldNormal: c.worldNormal,
      radius: c.radius,
      inner: c.inner,
      recommended: c.recommended,
    }));
    return JSON.stringify({
      ok: true,
      hit: true,
      hitPath: result.nodePath,
      candidates: this._snapCache.map((c) => ({
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

  @McpTool('Set a joint anchor from a snap candidate listed by web_editor_mechanism_snap_list — the geometrically exact alternative to typing millimetres into web_editor_mechanism_set_anchor. Writes AnchorA or AnchorB in the body-local frame and, unless assignBody=false, assigns the picked part as that side\'s body — ONE composite, one undo step. NOTE: mechanism = joint graph, NOT the axis-group Kinematic system (see web_editor_list_kinematics). Undoable.', { readOnly: false })
  async webEditorMechanismSetAnchorSnap(
    @McpParam('path', 'Node path of the joint.') path: string,
    @McpParam('componentType', 'Concrete joint key (e.g. KinematicJoint or KinematicJoint_1).') componentType: string,
    @McpParam('side', 'A | B — which side of the joint the point belongs to.') side: string,
    @McpParam('candidateId', 'Id from web_editor_mechanism_snap_list, e.g. "snap0".') candidateId: string,
    @McpParam('assignBody', 'Also assign the picked node as this side\'s body (default true).', 'boolean', false) assignBody: boolean,
  ): Promise<string> {
    const ctx = this._ctx();
    if (isGuardError(ctx)) return JSON.stringify(ctx);
    const bridge = await this._requireMechanismBridge();
    if (isMechError(bridge)) return JSON.stringify(bridge);
    const which = (side || '').trim().toUpperCase();
    if (which !== 'A' && which !== 'B') return JSON.stringify({ error: 'side must be "A" or "B"' });
    const node = ctx.viewer.registry?.getNode(path);
    if (!node) return JSON.stringify({ error: `Node not found: ${path}` });
    if (!(componentType in rvOf(node))) {
      return JSON.stringify({ error: `No component "${componentType}" on ${path}`, components: Object.keys(rvOf(node)) });
    }
    const candidate = this._snapCandidate(ctx, candidateId);
    if ('error' in candidate) return JSON.stringify(candidate);

    const takeBody = assignBody !== false;
    const joint = bridge.list().flatMap((m) => m.joints).find((j) => j.nodePath === path);
    // Whose frame the anchor is expressed in: the newly picked body when we are
    // assigning it, otherwise the body that side ALREADY carries. Getting this
    // wrong writes a numerically fine anchor into the wrong frame — the silent
    // failure planPickAnchor's one-composite rule exists to prevent.
    const framePath = takeBody
      ? candidate.nodePath
      : (which === 'A' ? joint?.bodyAPath ?? null : joint?.bodyBPath ?? null);
    const bodyNode = framePath ? ctx.viewer.registry?.getNode(framePath) ?? null : null;

    const [{ planPickAnchor }, { worldPointToAnchorField }] = await Promise.all([
      import('@rv-private/plugins/asset-editor/mechanism/mechanism-authoring'),
      import('@rv-private/plugins/asset-editor/mechanism/mechanism-frames'),
    ]);
    const anchor = worldPointToAnchorField(candidate.worldPosition, bodyNode);
    await this._mechCommit(ctx, bridge, path, planPickAnchor({
      jointPath: path,
      componentType,
      side: which,
      anchor,
      bodyPath: takeBody ? candidate.nodePath : undefined,
    }));
    return JSON.stringify({
      ok: true, path, componentType, side: which,
      candidate: { id: candidate.id, kind: candidate.kind, label: candidate.label },
      anchor, body: takeBody ? candidate.nodePath : framePath,
    });
  }

  @McpTool('Set a joint\'s axis (AxisA, body-A-local) either from a snap candidate — a bore\'s normal IS its axis, so candidateId is the accurate route — or from an explicit world vector. Optionally set SecondaryAxisB for a Universal joint, and snapToPrincipal to magnet a nearly-axis-aligned direction onto X/Y/Z. NOTE: mechanism = joint graph, NOT the axis-group Kinematic system (see web_editor_list_kinematics). Undoable, one composite.', { readOnly: false })
  async webEditorMechanismSetAxis(
    @McpParam('path', 'Node path of the joint.') path: string,
    @McpParam('componentType', 'Concrete joint key (e.g. KinematicJoint).') componentType: string,
    @McpParam('candidateId', 'Snap id whose normal becomes the axis (from web_editor_mechanism_snap_list).', 'string', false) candidateId: string,
    @McpParam('axisWorldJson', 'Axis as JSON {x,y,z} in WORLD space, when no candidateId is given.', 'string', false) axisWorldJson: string,
    @McpParam('secondaryAxisWorldJson', 'Universal joints only: second axis as JSON {x,y,z} in WORLD space.', 'string', false) secondaryAxisWorldJson: string,
    @McpParam('snapToPrincipal', 'Magnet the axis onto the nearest world X/Y/Z when within 5° (default false).', 'boolean', false) snapToPrincipal: boolean,
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
    const joints = bridge.list().flatMap((m) => m.joints);
    const joint = joints.find((j) => j.nodePath === path);
    if (!joint) {
      return JSON.stringify({
        error: `No solved joint at "${path}" — the axis frame depends on its type and Body A`,
        availableJointPaths: joints.map((j) => j.nodePath),
      });
    }

    const parseVec = (json: string): Vector3 | null => {
      if (!json?.trim()) return null;
      try {
        const p = JSON.parse(json) as { x?: number; y?: number; z?: number };
        const v = new Vector3(Number(p.x ?? 0), Number(p.y ?? 0), Number(p.z ?? 0));
        return v.lengthSq() > 0 ? v : null;
      } catch { return null; }
    };

    let axisWorld: Vector3 | null = null;
    let from = 'vector';
    if (candidateId?.trim()) {
      const candidate = this._snapCandidate(ctx, candidateId);
      if ('error' in candidate) return JSON.stringify(candidate);
      axisWorld = candidate.worldNormal.clone();
      from = `${candidate.id} (${candidate.kind})`;
    } else {
      axisWorld = parseVec(axisWorldJson);
    }
    if (!axisWorld) {
      return JSON.stringify({ error: 'Pass candidateId, or axisWorldJson as {"x":..,"y":..,"z":..} with non-zero length' });
    }

    const frames = await import('@rv-private/plugins/asset-editor/mechanism/mechanism-frames');
    const { planSetAxis } = await import('@rv-private/plugins/asset-editor/mechanism/mechanism-authoring');
    if (snapToPrincipal === true) axisWorld = frames.snapAxisToPrincipal(axisWorld);
    const isTranslation = frames.axisIsTranslation(joint.jointType);
    const bodyA = joint.bodyAPath ? ctx.viewer.registry?.getNode(joint.bodyAPath) ?? null : null;
    const axis = frames.worldDirectionToAxisField(axisWorld, bodyA, isTranslation);

    const secondaryWorld = parseVec(secondaryAxisWorldJson);
    let secondary: ReturnType<typeof frames.worldDirectionToAxisField> | undefined;
    if (secondaryWorld) {
      if (joint.jointType !== 'Universal') {
        return JSON.stringify({ error: `SecondaryAxisB applies to Universal joints only — "${path}" is ${joint.jointType}` });
      }
      // The second axis is BODY-B-local: it is the axis the other side rotates
      // about, and expressing it in Body A's frame would silently skew every
      // universal joint whose two bodies are not aligned.
      const bodyB = joint.bodyBPath ? ctx.viewer.registry?.getNode(joint.bodyBPath) ?? null : null;
      secondary = frames.worldDirectionToAxisField(secondaryWorld, bodyB, false);
    }

    await this._mechCommit(ctx, bridge, path, planSetAxis(path, componentType, axis, secondary));
    return JSON.stringify({ ok: true, path, componentType, from, axis, secondaryAxis: secondary ?? null });
  }

  @McpTool('Add a MechanismBody to a link so the force analysis has a mass for it — without one the inverse dynamics reports "a link without mass" and every drive figure stays empty. densityPreset = steel|stainless|aluminum|pa|pom|custom. The mass itself is computed from the link\'s geometry and never stored, so it cannot go stale; use web_editor_mechanism_set_mass to override it. NOTE: mechanism = joint graph, NOT the axis-group Kinematic system (see web_editor_list_kinematics). Undoable.', { readOnly: false })
  async webEditorMechanismAddBody(
    @McpParam('path', 'Node path of the link to give a body.') path: string,
    @McpParam('densityPreset', 'steel | stainless | aluminum | pa | pom | custom (default steel).', 'string', false) densityPreset: string,
  ): Promise<string> {
    const ctx = this._ctx();
    if (isGuardError(ctx)) return JSON.stringify(ctx);
    const bridge = await this._requireMechanismBridge();
    if (isMechError(bridge)) return JSON.stringify(bridge);
    const node = ctx.viewer.registry?.getNode(path);
    if (!node) return JSON.stringify({ error: `Node not found: ${path}` });
    const m = await import('@rv-private/plugins/asset-editor/mechanism/mechanism-authoring');
    const preset = (densityPreset || 'steel').trim().toLowerCase();
    const entry = m.DENSITY_PRESETS.find((p) => p.id === preset);
    if (!entry) {
      return JSON.stringify({
        error: `Unknown densityPreset "${densityPreset}"`,
        availablePresets: m.DENSITY_PRESETS.map((p) => p.id),
      });
    }
    if (Object.keys(rvOf(node)).some((k) => /^MechanismBody(_\d+)?$/.test(k))) {
      return JSON.stringify({ error: `"${path}" already carries a MechanismBody — change it with web_editor_mechanism_set_mass` });
    }
    await this._mechCommit(ctx, bridge, path, m.planAddBody(path, preset as DensityPresetId));
    return JSON.stringify({
      ok: true, path, densityPreset: entry.id,
      densityKgM3: entry.density > 0 ? entry.density : 7850,
    });
  }

  @McpTool('Set how heavy a link is — density preset, custom density, a pinned mass and a pinned centre of mass — in ONE composite and one undo step, because they are one decision. massKg="null" or comJson="null" DROP the respective override and return to the value computed from the geometry. Without masses the force figures are meaningless, so do this before reading web_editor_mechanism_forces. NOTE: mechanism = joint graph, NOT the axis-group Kinematic system (see web_editor_list_kinematics). Undoable.', { readOnly: false })
  async webEditorMechanismSetMass(
    @McpParam('path', 'Node path of the link (must already carry a MechanismBody).') path: string,
    @McpParam('densityPreset', 'steel | stainless | aluminum | pa | pom | custom.', 'string', false) densityPreset: string,
    @McpParam('densityKgM3', 'Density in kg/m³ — only meaningful with densityPreset=custom.', 'number', false) densityKgM3: number,
    @McpParam('massKg', 'Pinned mass in kg, or the string "null" to drop the override.', 'string', false) massKg: string,
    @McpParam('comJson', 'Centre of mass as JSON {x,y,z} in link-local mm, or "null" to drop it.', 'string', false) comJson: string,
  ): Promise<string> {
    const ctx = this._ctx();
    if (isGuardError(ctx)) return JSON.stringify(ctx);
    const bridge = await this._requireMechanismBridge();
    if (isMechError(bridge)) return JSON.stringify(bridge);
    const node = ctx.viewer.registry?.getNode(path);
    if (!node) return JSON.stringify({ error: `Node not found: ${path}` });
    if (!Object.keys(rvOf(node)).some((k) => /^MechanismBody(_\d+)?$/.test(k))) {
      return JSON.stringify({ error: `"${path}" carries no MechanismBody — add one with web_editor_mechanism_add_body first` });
    }
    const m = await import('@rv-private/plugins/asset-editor/mechanism/mechanism-authoring');

    // The three panel buttons become ONE MechanismOpPlan by concatenating their
    // intents. `MechanismOpPlan` is plain data, so no fourth builder is needed —
    // and one transaction is the difference between an undo that restores "how
    // heavy is this part" and one that half-restores it.
    const applied: string[] = [];
    const intents: MechanismOpPlan['intents'] = [];

    if (densityPreset?.trim()) {
      const preset = densityPreset.trim().toLowerCase();
      if (!m.DENSITY_PRESETS.some((p) => p.id === preset)) {
        return JSON.stringify({
          error: `Unknown densityPreset "${densityPreset}"`,
          availablePresets: m.DENSITY_PRESETS.map((p) => p.id),
        });
      }
      intents.push(...m.planSetDensity(path, preset as DensityPresetId, densityKgM3).intents);
      applied.push('density');
    }

    const massRaw = (massKg ?? '').toString().trim();
    if (massRaw) {
      if (massRaw.toLowerCase() === 'null') {
        intents.push(...m.planSetMassOverride(path, null).intents);
        applied.push('massOverrideCleared');
      } else {
        const kg = Number(massRaw);
        if (!Number.isFinite(kg) || kg <= 0) {
          return JSON.stringify({ error: `massKg must be a positive number or "null", got "${massKg}"` });
        }
        intents.push(...m.planSetMassOverride(path, kg).intents);
        applied.push('massOverride');
      }
    }

    const comRaw = (comJson ?? '').trim();
    if (comRaw) {
      if (comRaw.toLowerCase() === 'null') {
        intents.push(...m.planSetComOverride(path, null).intents);
        applied.push('comOverrideCleared');
      } else {
        try {
          const p = JSON.parse(comRaw) as { x?: number; y?: number; z?: number };
          intents.push(...m.planSetComOverride(path, {
            x: Number(p.x ?? 0), y: Number(p.y ?? 0), z: Number(p.z ?? 0),
          }).intents);
          applied.push('comOverride');
        } catch {
          return JSON.stringify({ error: 'comJson must be JSON {"x":..,"y":..,"z":..} or "null"' });
        }
      }
    }

    if (intents.length === 0) {
      return JSON.stringify({ error: 'Pass at least one of densityPreset, massKg or comJson' });
    }
    await this._mechCommit(ctx, bridge, path, { label: 'Set body mass properties', intents });
    return JSON.stringify({ ok: true, path, applied });
  }

  @McpTool('Set or clear a joint\'s motion limits — the travel a jog or a drive may use. useLimits=false switches them off and the bounds are ignored; useLimits=true takes lower/upper in degrees (Revolute) or millimetres (Prismatic). Read the current values with web_editor_mechanism_inspect. NOTE: mechanism = joint graph, NOT the axis-group Kinematic system (see web_editor_list_kinematics). Undoable, one composite.', { readOnly: false })
  async webEditorMechanismSetLimits(
    @McpParam('path', 'Node path of the joint.') path: string,
    @McpParam('componentType', 'Concrete joint key (e.g. KinematicJoint).') componentType: string,
    @McpParam('useLimits', 'true to enforce the bounds, false to switch limits off.', 'boolean') useLimits: boolean,
    @McpParam('lower', 'Lower bound (deg or mm) — only with useLimits=true.', 'number', false) lower: number,
    @McpParam('upper', 'Upper bound (deg or mm) — only with useLimits=true.', 'number', false) upper: number,
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
    const on = useLimits === true;
    const lo = Number.isFinite(Number(lower)) && lower !== undefined ? Number(lower) : undefined;
    const hi = Number.isFinite(Number(upper)) && upper !== undefined ? Number(upper) : undefined;
    if (on && lo !== undefined && hi !== undefined && lo > hi) {
      return JSON.stringify({ error: `lower (${lo}) must not exceed upper (${hi})` });
    }
    const { planSetLimits } = await import('@rv-private/plugins/asset-editor/mechanism/mechanism-authoring');
    await this._mechCommit(ctx, bridge, path,
      planSetLimits(path, componentType, { useLimits: on, lower: lo, upper: hi }));
    return JSON.stringify({
      ok: true, path, componentType, useLimits: on,
      lower: on ? lo ?? null : null, upper: on ? hi ?? null : null,
    });
  }

  /**
   * Shape one forces snapshot for the wire, adding the recorder's sizing figures.
   *
   * `_forces` and `_statics` both answer with this, which is deliberate: the
   * only difference between "what did the cycle need" and "what does holding it
   * need" is which evaluation filled the numbers, not what the caller has to
   * parse.
   */
  private _forcesJson(
    snapshot: import('../../core/engine/rv-kinematic-registry').MechanismForcesSnapshot,
    recorder: import('../mechanism-force-recorder-plugin').MechanismForceRecorder,
    opts: { channelId?: string; series?: DownsampledSeries | null } = {},
  ): Record<string, unknown> {
    return {
      ok: true,
      mechanismPath: snapshot.mechanismPath,
      status: snapshot.status,
      statusText: snapshot.statusText,
      dynamicsValid: snapshot.dynamicsValid,
      redundant: snapshot.redundant,
      recording: recorder.recording,
      channels: snapshot.channels.map((c) => {
        const m = recorder.metrics(c.id);
        return {
          id: c.id, label: c.label, kind: c.kind, unit: c.unit, value: c.value,
          peak: m.peak, rms: m.rms, holding: m.holding, sampleCount: m.sampleCount,
          ...(opts.series && c.id === opts.channelId ? { series: opts.series } : {}),
        };
      }),
      joints: snapshot.joints,
    };
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

  @McpTool('Solve the HOLDING forces of a mechanism in its current pose (velocity and acceleration zero) and file them as each channel\'s holding figure — "what does it take to just hold this here", answerable without running the machine. Returns the same shape as web_editor_mechanism_forces with holding filled. Changes no pose and appends no undo entry, but it does replace the previously recorded holding numbers, which the panel shows. NOTE: mechanism = the rigid-body joint graph, NOT the axis-group Kinematic system (see web_editor_list_kinematics).', { readOnly: false })
  async webEditorMechanismStatics(
    @McpParam('mechanismPath', 'Node path of the mechanism.') mechanismPath: string,
  ): Promise<string> {
    const bridge = await this._requireMechanismBridge();
    if (isMechError(bridge)) return JSON.stringify(bridge);
    const v = this.viewer;
    if (!v) return JSON.stringify({ error: 'No viewer' });
    const path = (mechanismPath || '').trim();
    if (!path) return JSON.stringify({ error: 'mechanismPath is required' });
    const { ensureForceRecorder } = await import('../mechanism-force-recorder-plugin');
    const plugin = ensureForceRecorder(v);
    const snapshot = plugin.captureStatics(path);
    if (!snapshot) {
      return JSON.stringify({
        error: `Statics could not be solved for "${path}" — unknown mechanism, or links without mass (web_editor_mechanism_add_body)`,
        availablePaths: bridge.list().map((m) => m.nodePath),
      });
    }
    return JSON.stringify(this._forcesJson(snapshot, plugin.recorder));
  }

  @McpTool('Apply the auto-fix of a FIXABLE finding on a joint and persist it as an ordinary field composite, so it undoes like a manual edit. Get the code from the findings of web_editor_mechanism_inspect or web_editor_mechanism_validate — only entries with fixable=true have one. NOTE: mechanism = joint graph, NOT the axis-group Kinematic system (see web_editor_list_kinematics). Undoable.', { readOnly: false })
  async webEditorMechanismFix(
    @McpParam('path', 'Node path of the joint the finding concerns.') path: string,
    @McpParam('code', 'Finding code, e.g. AnchorsApart or MissingSecondaryAxis.') code: string,
  ): Promise<string> {
    const ctx = this._ctx();
    if (isGuardError(ctx)) return JSON.stringify(ctx);
    const bridge = await this._requireMechanismBridge();
    if (isMechError(bridge)) return JSON.stringify(bridge);
    if (!ctx.viewer.registry?.getNode(path)) return JSON.stringify({ error: `Node not found: ${path}` });
    const finding = (code || '').trim();
    if (!finding) return JSON.stringify({ error: 'code is required' });

    // `suggestFix` RETURNS the field edits instead of applying them, which makes
    // the preview free — there is nothing to persist until this tool does it.
    const fix = bridge.suggestFix(path, finding);
    if (!fix || Object.keys(fix).length === 0) {
      const fixable = bridge.list()
        .flatMap((m) => m.findings)
        .filter((f) => f.fixable && f.jointPath === path)
        .map((f) => f.code);
      return JSON.stringify({ error: `No auto-fix for "${finding}" on ${path}`, fixableCodes: fixable });
    }
    const componentType = Object.keys(rvOf(ctx.viewer.registry.getNode(path)!))
      .find((k) => /^KinematicJoint(_\d+)?$/.test(k)) ?? 'KinematicJoint';
    await this._mechCommit(ctx, bridge, path, {
      label: `Fix ${finding}`,
      intents: Object.entries(fix).map(([fieldName, value]) => ({
        op: 'setField' as const, nodePath: path, componentType, fieldName, value,
      })),
    });
    return JSON.stringify({ ok: true, path, componentType, code: finding, applied: fix });
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

  @McpTool('Create a new kinematic axis: an empty top-level node with a Kinematic component linked to a fresh group (Quick Edit "Add Kinematic"). Assign members afterwards with web_editor_assign_to_kinematic. Returns the axis path + group name.', { readOnly: false })
  async webEditorCreateKinematic(
    @McpParam('name', 'Kinematic/group name (default auto "Kinematic_N").', 'string', false) name: string,
  ): Promise<string> {
    const ctx = this._ctx();
    if (isGuardError(ctx)) return JSON.stringify(ctx);
    const mods = await this._load();
    const path = await mods.create.createKinematicWithGroup(ctx.viewer, ctx.doc, name);
    if (!path) return JSON.stringify({ error: 'Kinematic creation failed' });
    const node = ctx.viewer.registry?.getNode(path);
    const groupName = node ? mods.transform.getKinematicGroupName(node) : null;
    return JSON.stringify({ ok: true, kinematicPath: path, groupName });
  }

  @McpTool('Assign nodes to a kinematic\'s group (they will move with the axis). Objects in another kinematic group are moved over; other kinematic axes are skipped. One undo unit.', { readOnly: false })
  async webEditorAssignToKinematic(
    @McpParam('paths', 'Node paths to assign, comma/newline-separated.') paths: string,
    @McpParam('groupName', 'Target kinematic group name (see web_editor_list_kinematics).') groupName: string,
  ): Promise<string> {
    const ctx = this._ctx();
    if (isGuardError(ctx)) return JSON.stringify(ctx);
    const kinPath = findKinematicPathForGroup(ctx.viewer, groupName);
    if (!kinPath) {
      return JSON.stringify({ error: `No kinematic references group "${groupName}" — create one first` });
    }
    const mods = await this._load();
    await mods.group.autoAssignToKinematic(ctx.viewer, ctx.doc, parsePathsParam(paths), groupName, kinPath);
    const node = ctx.viewer.registry?.getNode(kinPath);
    const members = node ? mods.transform.kinematicGroupMemberCount(ctx.viewer, node) : 0;
    return JSON.stringify({ ok: true, kinematicPath: kinPath, groupName, members });
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

  @McpTool('Create a PLC signal node as a child (Quick Edit "Signals"). sigType: PLCInputBool | PLCOutputBool | PLCInputFloat | PLCOutputFloat | PLCInputInt | PLCOutputInt. Optional name renames the node. Returns the new path.', { readOnly: false })
  async webEditorAddSignal(
    @McpParam('parentPath', 'Parent node path.') parentPath: string,
    @McpParam('sigType', 'Signal type (e.g. PLCOutputBool).') sigType: string,
    @McpParam('name', 'Optional node name (default = signal type).', 'string', false) name: string,
  ): Promise<string> {
    const ctx = this._ctx();
    if (isGuardError(ctx)) return JSON.stringify(ctx);
    const mods = await this._load();
    if (!ctx.viewer.registry?.getNode(parentPath)) {
      return JSON.stringify({ error: `Node not found: ${parentPath}` });
    }
    await mods.create.createSignalNode(ctx.viewer, ctx.doc, parentPath, sigType);
    let newPath = ctx.viewer.selectionManager.getSnapshot().primaryPath;
    if (newPath && name?.trim()) {
      const node = ctx.viewer.registry?.getNode(newPath);
      if (node) {
        ctx.doc.renameNode(newPath, name.trim(), node.name);
        await ctx.doc.whenIdle();
        const idx = newPath.lastIndexOf('/');
        newPath = idx < 0 ? name.trim() : newPath.slice(0, idx + 1) + name.trim();
      }
    }
    return JSON.stringify({ ok: true, path: newPath });
  }

  @McpTool('Convert a signal node to another datatype (Bool | Int | Float), keeping direction and value.', { readOnly: false })
  async webEditorConvertSignal(
    @McpParam('path', 'Signal node path.') path: string,
    @McpParam('target', 'Bool | Int | Float.') target: string,
  ): Promise<string> {
    const ctx = this._ctx();
    if (isGuardError(ctx)) return JSON.stringify(ctx);
    const t = (target || '').trim();
    if (!['Bool', 'Int', 'Float'].includes(t)) return JSON.stringify({ error: 'target must be Bool | Int | Float' });
    const mods = await this._load();
    await mods.create.convertSignalType(ctx.viewer, ctx.doc, path, t as 'Bool' | 'Int' | 'Float');
    return JSON.stringify({ ok: true, path });
  }

  @McpTool('Flip a signal node between PLC input and output (value preserved).', { readOnly: false })
  async webEditorToggleSignalDirection(
    @McpParam('path', 'Signal node path.') path: string,
  ): Promise<string> {
    const ctx = this._ctx();
    if (isGuardError(ctx)) return JSON.stringify(ctx);
    const mods = await this._load();
    await mods.create.toggleSignalDirection(ctx.viewer, ctx.doc, path);
    return JSON.stringify({ ok: true, path });
  }

  @McpTool('Add a LogicStep to a node (Quick Edit "Logic Steps"). Unknown stepType returns the palette. Steps sequence one-per-node; a node that already has a step gets a sibling.', { readOnly: false })
  async webEditorAddLogicStep(
    @McpParam('path', 'Context node path.') path: string,
    @McpParam('stepType', 'LogicStep type (e.g. LogicStep_DriveTo).') stepType: string,
  ): Promise<string> {
    const ctx = this._ctx();
    if (isGuardError(ctx)) return JSON.stringify(ctx);
    const mods = await this._load();
    if (!mods.create.LOGIC_STEP_PALETTE.some((s) => s.type === stepType)) {
      return JSON.stringify({
        error: `Unknown stepType "${stepType}"`,
        palette: mods.create.LOGIC_STEP_PALETTE,
      });
    }
    if (!ctx.viewer.registry?.getNode(path)) return JSON.stringify({ error: `Node not found: ${path}` });
    const qe = mods.quickEdit.computeQuickEditContext(ctx.viewer, {
      selectedPaths: [path], primaryPath: path,
    });
    await mods.create.addLogicStep(ctx.viewer, ctx.doc, qe, stepType);
    return JSON.stringify({ ok: true, path: ctx.viewer.selectionManager.getSnapshot().primaryPath ?? path });
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
  };

  @McpTool('Run an editor keyboard shortcut on the CURRENT selection, exactly as a user would: "S>I" select identical, "S>M" same material, "S>V" invert, "K" + arg=name assign to kinematic, "H" hide, "Shift+H" show, "Delete", "Ctrl+Z"/"Ctrl+Y" undo/redo, "Escape" clear. Unknown keys return the table. Chain e.g. S>I then web_editor_assign_material (paths omitted = selection).', { readOnly: false })
  async webEditorShortcut(
    @McpParam('keys', 'Shortcut, e.g. "S>I", "K", "H", "Ctrl+Z".') keys: string,
    @McpParam('arg', 'Argument for shortcuts that need one (K: kinematic/group name).', 'string', false) arg: string,
  ): Promise<string> {
    const ctx = this._ctx();
    if (isGuardError(ctx)) return JSON.stringify(ctx);
    const v = ctx.viewer;
    const sm = v.selectionManager;
    const combo = (keys || '').toUpperCase().replace(/\s+/g, '').replace(/BACKSPACE/, 'DELETE');
    const selection = [...sm.getSnapshot().selectedPaths];
    const mods = await this._load();

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

    const needSelection = (): string | null =>
      selection.length === 0 ? 'Nothing selected — select first (web_select / web_view_pick)' : null;

    switch (combo) {
      case 'S>I': case 'S>M': case 'S>V': {
        const err = combo === 'S>V' ? null : needSelection();
        if (err) return JSON.stringify({ error: err });
        const universe = buildMeshUniverse(v);
        let result: string[];
        if (combo === 'S>V') {
          result = computeInvertPaths(universe, selection);
        } else {
          const seeds = expandToUniverseMeshes(universe, selection);
          if (seeds.size === 0) return JSON.stringify({ error: 'Selection contains no selectable meshes' });
          result = combo === 'S>I'
            ? computeIdenticalPaths(universe, seeds)
            : computeSameMaterialPaths(universe, seeds);
        }
        sm.selectPaths(result);
        return JSON.stringify({ shortcut: combo, selected: result.length });
      }
      case 'K': case 'K>NAME': {
        const err = needSelection();
        if (err) return JSON.stringify({ error: err });
        const name = arg?.trim();
        if (!name) {
          return JSON.stringify({
            error: 'K needs arg = kinematic/group name',
            existing: await this._kinematicNames(v),
          });
        }
        await mods.group.groupSelection(v, ctx.doc, selection, name);
        const kinPath = findKinematicPathForGroup(v, name);
        return JSON.stringify({ shortcut: 'K', groupName: name, kinematicPath: kinPath });
      }
      case 'H': case 'SHIFT+H': {
        const err = needSelection();
        if (err) return JSON.stringify({ error: err });
        const visible = combo === 'SHIFT+H';
        for (const p of selection) ctx.doc.setNodeVisible(p, visible);
        await ctx.doc.whenIdle();
        return JSON.stringify({ shortcut: combo, changed: selection.length, visible });
      }
      case 'DELETE': {
        const err = needSelection();
        if (err) return JSON.stringify({ error: err });
        await mods.del.deleteSelectedNodes(v, ctx.doc);
        return JSON.stringify({ shortcut: 'Delete', deleted: selection.length });
      }
      case 'CTRL+Z': return this.webEditorUndo(1);
      case 'CTRL+Y': case 'CTRL+SHIFT+Z': return this.webEditorRedo(1);
      case 'ESCAPE': {
        sm.clear();
        return JSON.stringify({ shortcut: 'Escape', selected: 0 });
      }
      default:
        return JSON.stringify({
          ...(combo ? { error: `Unknown shortcut "${keys}"` } : {}),
          shortcuts: McpEditorTools.SHORTCUTS,
        });
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

  @McpTool('Assign a material to nodes (undoable, like the Materials panel): presetId (from web_editor_material_presets) OR free PBR values (color hex + metalness/roughness/opacity). Omit paths to paint the CURRENT selection — e.g. after web_editor_shortcut "S>I". Expands to paintable meshes automatically.', { readOnly: false })
  async webEditorAssignMaterial(
    @McpParam('paths', 'Node paths, comma/newline-separated (omit = current selection).', 'string', false) paths: string,
    @McpParam('presetId', 'Material preset id (e.g. "steel").', 'string', false) presetId: string,
    @McpParam('color', 'Hex color (e.g. "#2271b3") for a free PBR value.', 'string', false) color: string,
    @McpParam('metalness', 'Metalness 0..1 (default 0).', 'number', false) metalness: number,
    @McpParam('roughness', 'Roughness 0..1 (default 0.5).', 'number', false) roughness: number,
    @McpParam('opacity', 'Opacity 0..1 (default 1).', 'number', false) opacity: number,
  ): Promise<string> {
    const ctx = this._ctx();
    if (isGuardError(ctx)) return JSON.stringify(ctx);
    let list = parsePathsParam(paths ?? '');
    if (list.length === 0) list = [...ctx.viewer.selectionManager.getSnapshot().selectedPaths];
    if (list.length === 0) {
      return JSON.stringify({ error: 'No paths given and nothing selected — pass paths or select first (web_select / web_editor_shortcut "S>I")' });
    }
    const value = await this._resolveMaterialValue(presetId, color, metalness, roughness, opacity);
    if ('error' in value) return JSON.stringify(value);
    ctx.doc.setMaterial(list, value);
    await ctx.doc.whenIdle();
    return JSON.stringify({ ok: true, applied: value.name, paths: list.length });
  }

  private async _resolveMaterialValue(
    presetId?: string, color?: string, metalness?: number, roughness?: number, opacity?: number,
  ): Promise<MaterialValue | { error: string }> {
    const mods = await this._load();
    if (presetId) {
      const all = [...mods.presets.BUILTIN_MATERIAL_PRESETS, ...mods.presets.loadCustomPresets()];
      const p = all.find((x) => x.id === presetId);
      if (!p) return { error: `Unknown presetId "${presetId}" — see web_editor_material_presets` };
      const { id: _id, category: _cat, ...value } = p;
      return value;
    }
    if (!color || !/^#[0-9a-fA-F]{6}$/.test(color)) {
      return { error: 'Pass presetId, or a hex color like "#8a8f94" for a free PBR value' };
    }
    const op = typeof opacity === 'number' && !Number.isNaN(opacity) ? Math.min(Math.max(opacity, 0), 1) : 1;
    return {
      name: 'Custom',
      color,
      metalness: clamp01(metalness, 0),
      roughness: clamp01(roughness, 0.5),
      opacity: op,
      transparent: op < 1,
    };
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

  @McpTool('MATERIALIZE: call with no assignments to get the appearance groups (same as web_editor_material_stats), then call again with assignmentsJson = [{"key"|"samplePath": ..., "presetId"|"color"(+metalness/roughness/opacity): ...}, ...] to re-material whole appearance groups in ONE undo step.', { readOnly: false, timeoutMs: 60_000 })
  async webEditorMaterialize(
    @McpParam('assignmentsJson', 'JSON array of {key|samplePath, presetId|color,metalness,roughness,opacity}.', 'string', false) assignmentsJson: string,
  ): Promise<string> {
    const ctx = this._ctx();
    if (isGuardError(ctx)) return JSON.stringify(ctx);
    const root = ctx.viewer.currentModelRoot ?? null;
    if (!assignmentsJson?.trim()) {
      return JSON.stringify({ groups: this._appearanceGroups(root) });
    }
    let assignments: Array<Record<string, unknown>>;
    try {
      const parsed = JSON.parse(assignmentsJson);
      if (!Array.isArray(parsed)) throw new Error();
      assignments = parsed as Array<Record<string, unknown>>;
    } catch {
      return JSON.stringify({ error: 'assignmentsJson must be a JSON array' });
    }

    const index = indexMeshPathsByMaterialValue(root);
    const applied: Array<Record<string, unknown>> = [];
    const skipped: Array<Record<string, unknown>> = [];
    const resolved: Array<{ meshPaths: string[]; value: MaterialValue }> = [];

    for (const a of assignments) {
      // Resolve the target appearance group.
      let key = typeof a['key'] === 'string' ? (a['key'] as string) : null;
      const samplePath = typeof a['samplePath'] === 'string' ? (a['samplePath'] as string) : null;
      if (!key && samplePath) {
        const node = ctx.viewer.registry?.getNode(samplePath);
        const value = node ? materialToValue((node as import('three').Mesh).material as import('three').Material) : null;
        key = value ? materialValueKey(value) : null;
      }
      const meshPaths = key ? index.get(key) : undefined;
      if (!key || !meshPaths?.length) {
        skipped.push({ ...a, reason: 'appearance group not found' });
        continue;
      }
      const value = await this._resolveMaterialValue(
        a['presetId'] as string | undefined,
        a['color'] as string | undefined,
        a['metalness'] as number | undefined,
        a['roughness'] as number | undefined,
        a['opacity'] as number | undefined,
      );
      if ('error' in value) {
        skipped.push({ ...a, reason: value.error });
        continue;
      }
      resolved.push({ meshPaths, value });
      applied.push({ key, material: value.name, meshCount: meshPaths.length });
    }

    if (resolved.length > 0) {
      await ctx.doc.withTransaction('Materialize', async () => {
        for (const r of resolved) ctx.doc.setMaterial(r.meshPaths, r.value);
        await ctx.doc.whenIdle();
      });
      await ctx.doc.whenIdle();
    }
    return JSON.stringify({ ok: true, applied, skipped, undo: resolved.length > 0 ? 'One web_editor_undo reverts all assignments' : undefined });
  }

  // ═══ Verify ═══════════════════════════════════════════════════════════

  @McpTool('VERIFY a drive visually before saving — performed like a user would: selects the axis (gizmo + group highlight appear), frames a fitted 3/4 view, then smoothly drags the drive through its range in the viewport while capturing N poses on the fly, springs back, and returns ONE labelled montage. Wrong axis/pivot/membership is immediately visible. Defaults: limits when UseLimits, else ±180° rotary / ±500mm linear around home.', { readOnly: false, timeoutMs: 60_000 })
  async webEditorVerifyDrive(
    @McpParam('kinematicPath', 'Path of the node carrying the Drive (usually the kinematic axis).') kinematicPath: string,
    @McpParam('from', 'Sweep start (mm or °).', 'number', false) from: number,
    @McpParam('to', 'Sweep end (mm or °).', 'number', false) to: number,
    @McpParam('frames', 'Number of poses 2..12 (default 6).', 'integer', false) frames: number,
    @McpParam('keepView', 'Keep the camera where the tool framed it (default true).', 'boolean', false) keepView: boolean,
  ): Promise<string> {
    const ctx = this._ctx();
    if (isGuardError(ctx)) return JSON.stringify(ctx);
    const v = ctx.viewer;
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

      // 3. Frame a fitted 3/4 view of the sweep volume (animated), so both the
      // watching user and the captures get a readable angle.
      if (!union.isEmpty()) {
        const center = union.getCenter(new Vector3());
        const size = union.getSize(new Vector3());
        const maxDim = Math.max(size.x, size.y, size.z, 0.1);
        const dist = maxDim * 2.1;
        const pos = center.clone().add(new Vector3(0.7, 0.5, 0.7).normalize().multiplyScalar(dist));
        v.animateCameraTo(pos, center, 0.9, 'easeInOut');
        await sleep(1000);
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
        const r = captureFrameCanvas(v, { worldBox: union.isEmpty() ? undefined : union, maxDim: 640 });
        if ('error' in r) return JSON.stringify({ error: r.error });
        shots.push(r.canvas);
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
    });
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
      return JSON.stringify({ ok: true, rootPath });
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
