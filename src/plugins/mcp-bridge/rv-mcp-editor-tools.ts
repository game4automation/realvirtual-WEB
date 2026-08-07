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
import type { Object3D } from 'three';
import type { RVViewer } from '../../core/rv-viewer';
import { McpTool, McpParam } from '../../core/engine/rv-mcp-tools';
import { getSchemaDefaults, getTypesWithCapability } from '../../core/engine/rv-component-registry';
import { computeSubtreeAABB } from '../../core/engine/rv-traverse-utils';
import { getDriveDragDriver } from '../../core/engine/drive-drag-driver';
import { NodeRegistry } from '../../core/engine/rv-node-registry';
import { computeMaterialStats } from '../asset-editor/materials/material-stats';
import {
  indexMeshPathsByMaterialValue,
  materialToValue,
  materialValueKey,
} from '../../core/editor/rv-asset-material';
import type { MaterialValue, NodeTransform } from '../../core/editor/rv-asset-ops';
import type { ActiveAssetContext } from '../asset-editor/active-asset-store';
import { requireEditor, isGuardError } from './rv-mcp-editor-guard';
import { parsePathsParam } from './rv-object-analyzer-math';
import { captureFrameCanvas, canvasToRvImage, compositeMontage } from './rv-frame-capture';
import { buildMeshUniverse } from './rv-mcp-view-tools';
import {
  computeIdenticalPaths,
  computeSameMaterialPaths,
  computeInvertPaths,
  expandToUniverseMeshes,
} from '../asset-editor/select-actions';

const r3 = (n: number): number => +n.toFixed(3);

/** Kinematic component keys in rv_extras, tolerant of the `_N` dedup suffix. */
const KINEMATIC_KEY_RE = /^Kinematic(_\d+)?$/;
const DRIVE_KEY_RE = /^Drive(_\d+)?$/;

const DRIVE_DIRECTIONS = ['LinearX', 'LinearY', 'LinearZ', 'RotationX', 'RotationY', 'RotationZ'];

/** rv_extras of a node ({} when absent). */
function rvOf(node: Object3D): Record<string, unknown> {
  return (node.userData as Record<string, unknown>)?.['realvirtual'] as Record<string, unknown> ?? {};
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
  transform: typeof import('../asset-editor/kinematics/transform-actions');
  create: typeof import('../asset-editor/kinematics/create-actions');
  group: typeof import('../asset-editor/group-actions');
  del: typeof import('../asset-editor/delete-selection');
  save: typeof import('../asset-editor/save-flow');
  pending: typeof import('../asset-editor/pending-open-store');
  quickEdit: typeof import('../asset-editor/kinematics/quick-edit-context');
  presets: typeof import('../asset-editor/materials/material-presets');
  gizmoSource: typeof import('../asset-editor/editor-drive-gizmo-source');
  draft: typeof import('../../core/editor/rv-asset-draft-storage');
  importAsset: typeof import('../../core/import/rv-import-asset');
  cadProvider: typeof import('../../core/editor/rv-cad-provider');
  fs: typeof import('../../core/engine/rv-local-filesystem');
}

export class McpEditorTools {
  constructor(private readonly getViewer: () => RVViewer | undefined) {}

  private get viewer(): RVViewer | undefined {
    return this.getViewer();
  }

  private _mods: Promise<EditorMods> | null = null;

  private _load(): Promise<EditorMods> {
    this._mods ??= (async () => ({
      transform: await import('../asset-editor/kinematics/transform-actions'),
      create: await import('../asset-editor/kinematics/create-actions'),
      group: await import('../asset-editor/group-actions'),
      del: await import('../asset-editor/delete-selection'),
      save: await import('../asset-editor/save-flow'),
      pending: await import('../asset-editor/pending-open-store'),
      quickEdit: await import('../asset-editor/kinematics/quick-edit-context'),
      presets: await import('../asset-editor/materials/material-presets'),
      gizmoSource: await import('../asset-editor/editor-drive-gizmo-source'),
      draft: await import('../../core/editor/rv-asset-draft-storage'),
      importAsset: await import('../../core/import/rv-import-asset'),
      cadProvider: await import('../../core/editor/rv-cad-provider'),
      fs: await import('../../core/engine/rv-local-filesystem'),
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
      await mods.draft.clearAssetDraft();
      // poison dirty so deactivate won't re-flush
      await ctx.doc.markSaved(ctx.doc.base, undefined, { clearDraft: true });
      return null;
    }
    if (policy === 'save') {
      const name = saveName?.trim() || ctx.doc.name;
      if (!name || name === 'Untitled') {
        return 'Document is Untitled — pass a name to save it, or use ifDirty=discard';
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
    const { getActiveAssetContext } = await import('../asset-editor/active-asset-store');
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
    return JSON.stringify({
      active: true,
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
    });
  }

  // ═══ Lifecycle ════════════════════════════════════════════════════════

  @McpTool('Open the ASSET EDITOR with a document: source=empty (fresh Untitled asset) or source=library with relPath (e.g. "Custom/MyAsset.glb", relative to <workfolder>/library/). When the editor is already open with unsaved changes, ifDirty decides: fail (default) | save (needs a saved name) | discard. Editing happens through the web_editor_* tools; finish with web_editor_save.', { readOnly: false, timeoutMs: 120_000 })
  async webEditorOpen(
    @McpParam('source', 'empty | library.') source: string,
    @McpParam('relPath', 'Library-relative GLB path (source=library), e.g. "Custom/MyAsset.glb".', 'string', false) relPath: string,
    @McpParam('ifDirty', 'fail | save | discard — what to do with unsaved changes (default fail).', 'string', false) ifDirty: string,
  ): Promise<string> {
    const v = this.viewer;
    if (!v) return JSON.stringify({ error: 'No viewer' });
    const src = (source || '').toLowerCase();
    if (src !== 'empty' && src !== 'library') {
      return JSON.stringify({ error: 'source must be "empty" or "library"' });
    }
    if (src === 'library' && !relPath?.trim()) {
      return JSON.stringify({ error: 'source=library needs relPath (e.g. "Custom/MyAsset.glb")' });
    }
    const mods = await this._load();

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

    mods.pending.setPendingAssetOpen(
      src === 'empty'
        ? { kind: 'empty' }
        : {
            kind: 'libraryGlb',
            fileName: relPath.trim().split('/').pop() ?? relPath.trim(),
            relPath: relPath.trim(),
          },
    );
    v.modes.setMode('editor');
    const ctx = await this._awaitEditorContext(prevDocId);
    if (!ctx) return JSON.stringify({ error: 'Editor did not activate (model load failed or timed out)' });
    const status = JSON.parse(await this._statusJson()) as Record<string, unknown>;
    status.next = 'Perceive first (web_node_tree, web_camera_focus, web_node_bounds); workflow guide: web_help("editor")';
    return JSON.stringify(status);
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

  @McpTool('Locate the KNOWLEDGE FOLDER for the open asset — the durable home for notes, a part catalogue and saved views across sessions. Returns the work folder NAME, the asset\'s library-relative path when it has one, and knowledgeRelPath ("knowledge/<AssetName>"). absolutePath is ALWAYS null: the browser File System Access API exposes no filesystem path, so resolve the root once per machine (search for a directory named workFolderName containing "library"), confirm it with the user, and record it in knowledge.md. web_render and web_screenshot_annotated write into this folder directly via their savePath parameter, which needs no absolute path.', { readOnly: true })
  async webEditorWorkfolderInfo(): Promise<string> {
    const ctx = this._ctx();
    if (isGuardError(ctx)) return JSON.stringify(ctx);
    const mods = await this._load();
    const meta = mods.fs.getWorkFolderMeta();
    const snap = ctx.doc.getSnapshot();
    const assetName = (snap.name || 'Untitled').trim() || 'Untitled';
    // Folder-safe but still recognisable: the agent and the user both navigate to this by name.
    const safeName = assetName.replace(/[^A-Za-z0-9 ._-]/g, '_').replace(/\s+/g, ' ').trim() || 'Untitled';
    const base = snap.base;
    const fromLibrary = base.kind === 'libraryGlb';
    return JSON.stringify({
      configured: meta !== null,
      workFolderName: meta?.displayName ?? null,
      absolutePath: null,
      absolutePathNote: 'Not obtainable from the browser. Resolve once per machine, confirm with the user, and record it in knowledge.md.',
      assetName,
      assetFromLibrary: fromLibrary,
      assetRelPath: fromLibrary ? `library/${base.relPath}` : null,
      knowledgeRelPath: `knowledge/${safeName}`,
      dirty: snap.dirty,
      opCount: snap.opCount,
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

  @McpTool('Save the asset as GLB into <workfolder>/library/Custom/. name is required for an Untitled document; the same name overwrites the existing file. Needs a configured work folder (File System Access).', { readOnly: false, timeoutMs: 60_000 })
  async webEditorSave(
    @McpParam('name', 'Asset name (default: current document name).', 'string', false) name: string,
  ): Promise<string> {
    const ctx = this._ctx();
    if (isGuardError(ctx)) return JSON.stringify(ctx);
    const finalName = name?.trim() || ctx.doc.name;
    if (!finalName || finalName === 'Untitled') {
      return JSON.stringify({ error: 'Document is Untitled — pass a name' });
    }
    const mods = await this._load();
    const outcome = await mods.save.saveAssetAs(ctx, finalName);
    if (outcome.kind === 'saved') {
      return JSON.stringify({
        saved: true, fileName: outcome.fileName, relPath: outcome.relPath,
        next: 'web_editor_close to leave; reload the asset live to jog real drives as a smoke test',
      });
    }
    return JSON.stringify({
      error: outcome.kind === 'error' ? outcome.message : `Save unavailable: ${outcome.kind}`,
    });
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
      return !!node && !!node.parent && node !== ctx.viewer.currentModelRoot;
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
      if (!ctx.viewer.registry?.getNode(p)) continue;
      ctx.doc.setNodeVisible(p, visible !== false);
      changed++;
    }
    await ctx.doc.whenIdle();
    return JSON.stringify({ ok: true, changed, visible: visible !== false });
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
    const node = ctx.viewer.registry?.getNode(path);
    if (!node) return JSON.stringify({ error: `Node not found: ${path}` });
    if (!(componentType in rvOf(node))) {
      return JSON.stringify({ error: `No component "${componentType}" on ${path}`, components: Object.keys(rvOf(node)) });
    }
    ctx.doc.removeComponent(path, componentType);
    await ctx.doc.whenIdle();
    return JSON.stringify({ ok: true, path, removed: componentType });
  }

  @McpTool('Set one field of a component on a node (undoable, live in the panels). valueJson is parsed as JSON (numbers/booleans/strings/objects; bare strings work too).', { readOnly: false })
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
    let value: unknown;
    try { value = JSON.parse(valueJson); }
    catch { value = valueJson; } // bare string
    const prev = comp[fieldName];
    ctx.doc.setField(path, componentType, fieldName, value, prev);
    await ctx.doc.whenIdle();
    return JSON.stringify({ ok: true, path, componentType, fieldName, value, prev: prev ?? null });
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

  @McpTool('Import a GLB file from the work folder into the open asset (undoable importCad op). relPath is relative to the work folder root (e.g. "imports/part.glb"). Returns the created root path.', { readOnly: false, timeoutMs: 120_000 })
  async webEditorImportGlb(
    @McpParam('relPath', 'Work-folder-relative path of a .glb file.') relPath: string,
  ): Promise<string> {
    const ctx = this._ctx();
    if (isGuardError(ctx)) return JSON.stringify(ctx);
    const read = await this._readWorkfolderFile(relPath);
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

  @McpTool('Import a CAD file (STEP/JT) from the work folder into the open asset — converts via the CAD provider (private build), then attaches as an undoable importCad op. quality: draft | standard | fine (default standard).', { readOnly: false, timeoutMs: 600_000 })
  async webEditorImportCad(
    @McpParam('relPath', 'Work-folder-relative path of a CAD file (.step/.stp/.jt).') relPath: string,
    @McpParam('quality', 'Tessellation quality: draft | standard | fine (default standard).', 'string', false) quality: string,
  ): Promise<string> {
    const ctx = this._ctx();
    if (isGuardError(ctx)) return JSON.stringify(ctx);
    const mods = await this._load();
    if (!mods.cadProvider.hasCadProvider()) {
      return JSON.stringify({ error: 'CAD provider not available in this build — import a GLB instead' });
    }
    const read = await this._readWorkfolderFile(relPath);
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

  /** Read a file from the configured work folder (File System Access). */
  private async _readWorkfolderFile(relPath: string):
    Promise<{ bytes: ArrayBuffer; name: string } | { error: string }> {
    const mods = await this._load();
    if (!relPath?.trim()) return { error: 'relPath is required' };
    const root = await mods.fs.getWorkFolder(true);
    if (!root) return { error: 'No writable project is open (open one in Projects)' };
    try {
      const segments = relPath.trim().replace(/\\/g, '/').split('/').filter(Boolean);
      let dir: FileSystemDirectoryHandle = root;
      for (const seg of segments.slice(0, -1)) dir = await dir.getDirectoryHandle(seg);
      const name = segments[segments.length - 1];
      const handle = await dir.getFileHandle(name);
      const bytes = await (await handle.getFile()).arrayBuffer();
      return { bytes, name };
    } catch {
      return { error: `File not found in work folder: ${relPath}` };
    }
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
