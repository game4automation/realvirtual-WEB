// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * scene-store — Op-based source of truth for the unified Scene model.
 *
 * Holds:
 *   - the workspace shell (id, name, base, createdAt) of the currently open scene
 *   - workspace settings (catalogUrls, gridSizeMm)
 *   - the operation log `_ops` — the canonical edit state
 *   - the baseline `_baselineOps` (ops at the moment of last load/save) for
 *     dirty detection and undo floor
 *   - the redo stack
 *   - flags for in-flight loads / op apply
 *
 * Editors push ops via `applyOp` (or `beginTransaction` / `endTransaction`
 * for grouped edits). The store applies them through the executors, queues
 * concurrent calls, autosaves the draft, and notifies React via
 * useSyncExternalStore.
 *
 * A few thin backward-compat shims (loadScene, createNewLayout,
 * exportLayoutJSON) remain for callers still on the old API.
 */

import type { RVViewer } from '../../rv-viewer';
import type {
  RvScene, RvSceneMeta, SceneBase, BuiltinSceneEntry,
} from './rv-scene-types';
import {
  baseLabelOf, metaOf, newSceneId, makeDraftScene, scenesEqual, isValidSceneV2,
} from './rv-scene-types';
import { publishedSceneUrl, type PublishedSceneEntry } from './rv-published-scenes';
import {
  type EditOp, type PrimitiveEditOp, type SceneEditsSettings, type MaterialisedEdits,
  MAX_OP_HISTORY, COALESCE_WINDOW_MS,
  freshOpId, canCoalesce, mergeOps, describeOp, opsEqual, materialise,
} from './rv-scene-edits';
import {
  listMetas, readScene, writeScene, deleteScene,
  readActiveId, readDraft, writeDraft, clearDraft,
  readSceneDraft, writeSceneDraft, clearSceneDraft,
} from './rv-scene-storage';
import { emitSceneMutation, setActiveSceneId } from './rv-scene-mutations';
import { applyForward, applyInverse } from './rv-scene-executors';
import { showInfoOverlay, hideInfoOverlay } from '../info-overlay-store';
import { nextOptionParam } from '../../../plugins/models/model-option-plugin';
import { writeSettingsIntoModel } from './rv-scene-settings-into-model';
import { getProjectStore } from '../../project/project-store';
import type { ProjectBackend } from '../../project/backends/project-backend';
import { isSupported as isFileSystemAccessSupported } from '../../engine/rv-local-filesystem';
import { saveStartPos } from '../camera-startpos-store';
import { deriveModelKey } from '../../../plugins/camera-startpos-plugin';

// ─── Snapshot ───────────────────────────────────────────────────────────

export interface SceneSnapshot {
  saved: RvScene | null;
  /** Always-present derived view of the current workspace. Includes the
   *  current op log; structurally compared against `saved` for dirty. */
  draft: RvScene | null;
  isDraft: boolean;
  dirty: boolean;
  scenes: RvSceneMeta[];
  builtins: BuiltinSceneEntry[];
  /** Read-only "Example" scenes of the DemoRealvirtual project. */
  published: PublishedSceneEntry[];
  /** urlName of the open published example, for Examples-row highlight; null otherwise. */
  activePublishedName: string | null;
  busy: boolean;
  canUndo: boolean;
  canRedo: boolean;
  /** Tooltip text "Undo: <action>" / "Redo: <action>"; null when disabled. */
  undoLabel: string | null;
  redoLabel: string | null;
}

// ─── Save settings into model ───────────────────────────────────────────

/** Result of {@link SceneStore.saveSettingsIntoModel}. Every failure carries its reason. */
export type SaveSettingsIntoModelOutcome =
  | {
      kind: 'saved';
      /** The name actually used — may carry a `_1` suffix after a collision. */
      fileName: string;
      relPath: string;
      /** glTF nodes that received at least one field. */
      nodes: number;
      /** Individual fields written or deleted. */
      fields: number;
      /** A now-invalid signature was dropped — the written file is unsigned. */
      signatureDropped: boolean;
    }
  /** The scene has no property overrides; the file would be an exact copy. */
  | { kind: 'nothing-to-save' }
  /** Edits that cannot live in node extras — listed for the user. */
  | { kind: 'structural-ops'; details: string[] }
  /** An empty base has no model file to write into. */
  | { kind: 'no-model-base' }
  | { kind: 'no-writable-project'; reason: string }
  /** A folder project on a browser without File System Access. */
  | { kind: 'unsupported' }
  /** The user switched scenes mid-write; the file exists but was not adopted. */
  | { kind: 'scene-changed'; fileName: string; relPath: string }
  | { kind: 'error'; message: string };

/**
 * Name the edits that cannot be represented as node extras.
 *
 * Only `setField` / `unsetField` / `setCode` reach `overlay`. Everything else
 * would need new `nodes[]` entries, `children[]` splicing, or merging a second
 * GLB's buffers into the BIN chunk — which is precisely the byte-identity this
 * feature exists to preserve. Refusing with a list beats writing a file that
 * looks complete and silently is not.
 */
function describeStructuralEdits(edits: MaterialisedEdits): string[] {
  const out: string[] = [];
  const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
  if (edits.placements.length) out.push(n(edits.placements.length, 'planner placement', 'planner placements'));
  if (edits.addedNodes.length) out.push(n(edits.addedNodes.length, 'added node', 'added nodes'));
  if (edits.nodeTransforms.length) out.push(n(edits.nodeTransforms.length, 'moved node', 'moved nodes'));
  if (edits.connections.length) out.push(n(edits.connections.length, 'connection', 'connections'));
  if (edits.connectionTypes.length) out.push(n(edits.connectionTypes.length, 'connection type', 'connection types'));
  return out;
}

/** Scene name → a safe GLB file stem. Mirrors the asset editor's rule. */
function sanitizeModelFileName(name: string): string {
  const stem = name.trim().replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, '_').replace(/\.glb$/i, '');
  return stem || 'Untitled';
}

/** Append `_1`, `_2`, … until the name is free in the project's `models/`. */
async function uniqueModelFileName(backend: ProjectBackend, fileName: string): Promise<string> {
  let taken: Set<string>;
  try {
    const models = await backend.listModels();
    taken = new Set(models.map((m) => (m.path.split('/').pop() ?? '').toLowerCase()));
  } catch {
    return fileName; // Listing is a convenience; never block a bake on it.
  }
  if (!taken.has(fileName.toLowerCase())) return fileName;

  const stem = fileName.replace(/\.glb$/i, '');
  for (let i = 1; ; i++) {
    const candidate = `${stem}_${i}.glb`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

// ─── Internal state ─────────────────────────────────────────────────────

interface WorkspaceShell {
  id: string;            // 'draft' for unsaved drafts; final id after save
  name: string;
  base: SceneBase;
  createdAt: string;
  parentId?: string;
  description?: string;
}

const DRAFT_AUTOSAVE_DEBOUNCE_MS = 2000;
const DEFAULT_SETTINGS: SceneEditsSettings = { catalogUrls: [], gridSizeMm: 500 };

export interface TransactionToken { readonly _depth: number }

// ─── Store ──────────────────────────────────────────────────────────────

export class SceneStore {
  private readonly _viewer: RVViewer;

  // Workspace
  private _workspace: WorkspaceShell | null = null;
  private _settings: SceneEditsSettings = { ...DEFAULT_SETTINGS };
  private _baselineOps: EditOp[] = [];
  private _ops: EditOp[] = [];
  private _redoStack: EditOp[] = [];
  private _saved: RvScene | null = null;

  // Catalogue
  private _builtins: BuiltinSceneEntry[] = [];
  private _scenes: RvSceneMeta[] = [];
  private _published: PublishedSceneEntry[] = [];
  /** urlName of the currently-open published example (for row highlight); null otherwise. */
  private _activePublishedName: string | null = null;

  // UI state flags
  private _busy = false;
  private _loading = false;

  // Async serialisation
  private _opQueue: Promise<void> = Promise.resolve();

  // Transaction buffer (op accumulator)
  private _txnDepth = 0;
  private _txnLabel = '';
  private _txnBuffer: PrimitiveEditOp[] = [];

  // Debounced draft autosave timer
  private _draftAutosaveTimer: number | null = null;

  // Lazy-hydration pre-fetch (installed by ProjectStore; null when no project)
  private _hydrator: ((id: string) => Promise<boolean>) | null = null;

  // React subscribers
  private _listeners = new Set<() => void>();
  private _snapshot: SceneSnapshot;

  constructor(viewer: RVViewer) {
    this._viewer = viewer;
    this._refreshBuiltins();
    this._refreshScenes();
    this._refreshPublished();
    this._snapshot = this._buildSnapshot();
  }

  // ─── React useSyncExternalStore API ─────────────────────────────────

  subscribe = (listener: () => void): (() => void) => {
    this._listeners.add(listener);
    return () => { this._listeners.delete(listener); };
  };

  getSnapshot = (): SceneSnapshot => this._snapshot;

  // ─── External notifications ─────────────────────────────────────────

  refreshGlbList(): void {
    this._refreshBuiltins();
    this._notify();
  }

  /**
   * Boot path: a GLB was loaded directly via loadModelWithProgress (e.g.
   * `?model=` URL) without going through SceneStore. Synthesise a fresh
   * draft on top of that base so the Scene panel highlights the right row.
   *
   * No-op while an `openScene` / `openBuiltin` / `newEmpty` is in flight —
   * those paths already set up the workspace correctly *before* awaiting
   * `viewer.loadScene`, and the inner `loadModelWithProgress` call would
   * otherwise stomp it. In particular for `newEmpty`, the synthesized empty
   * GLB is a `blob:` URL with a random UUID — markGlbActive would clobber
   * the workspace name with that UUID. (`?model=`/`?scene=builtin:` URL
   * routing also reaches loadModel, but at that point `_loading` is true
   * for the whole openBuiltin call.)
   */
  markGlbActive(url: string, label: string): void {
    if (this._loading) return;
    const base: SceneBase = { kind: 'builtin', url, label };
    if (this._workspace?.base.kind === 'builtin' && this._workspace.base.url === url) return;
    this._cancelAutosave();
    this._activePublishedName = null;
    this._workspace = freshShell(base, label);
    this._settings = { ...DEFAULT_SETTINGS };
    this._baselineOps = [];
    this._ops = [];
    this._redoStack = [];
    this._saved = null;
    this._viewer.currentScene = this._buildDraft();
    setActiveSceneId(null);
    this._notify();
  }

  // ─── Catalogue ──────────────────────────────────────────────────────

  listScenes(): RvSceneMeta[] { return this._scenes; }
  listBuiltins(): BuiltinSceneEntry[] { return this._builtins; }
  listPublished(): PublishedSceneEntry[] { return this._published; }

  // ─── Workspace lifecycle ────────────────────────────────────────────

  /**
   * Install a pre-fetch hook consulted when a scene body is missing from the
   * cache. Set by `ProjectStore` so a lazily-hydrated project scene can be
   * pulled off disk on demand; null restores the plain cache-only behaviour.
   */
  setSceneHydrator(fn: ((id: string) => Promise<boolean>) | null): void {
    this._hydrator = fn;
  }

  /**
   * Ensure a scene body is present in the cache, pulling it through the
   * hydrator if one is installed. Returns false when it cannot be produced.
   */
  async ensureSceneHydrated(id: string): Promise<boolean> {
    if (readScene(id)) return true;
    if (!this._hydrator) return false;
    try {
      return await this._hydrator(id);
    } catch {
      return false;
    }
  }

  /** Re-read the scene index from storage (after an external hydration). */
  refreshScenesFromStorage(): void {
    this._refreshScenes();
    this._notify();
  }

  /** Open a saved scene by id. */
  async openScene(id: string): Promise<void> {
    // With lazy project hydration the body may not be cached yet. Without
    // this pre-fetch, a Models-panel click and `web_scene_open` would both
    // throw "Scene <id> not found" on a perfectly valid project scene.
    if (!readScene(id)) await this.ensureSceneHydrated(id);
    const scene = readScene(id);
    if (!scene) throw new Error(`Scene ${id} not found`);
    // Restore any in-progress draft for this saved scene on top of the
    // persisted baseline. The draft lives in `rv-scenes/scene-draft/<id>`,
    // separate from the per-base keyspace, so it can't be wiped by a
    // sibling built-in `openBuiltin(base)` clearing the base draft slot.
    // If no draft exists, fall back to the saved scene as-is.
    const draft = readSceneDraft(id);
    const sceneToLoad = draft ?? scene;
    await this._loadIntoWorkspace(sceneToLoad, scene);
    // Reflect the choice in the URL so a browser reload re-opens the same
    // saved scene. Without this, `?scene=` stays empty and reload falls
    // through to the legacy default-model boot path (which then clears the
    // active-id pointer via markGlbActive — see scene-store.ts).
    updateUrlSceneParam(scene.id, baseLabelForOption(scene.base));
  }

  /** Open a built-in. Auto-resumes the per-base draft if one was autosaved. */
  async openBuiltin(url: string, label: string): Promise<void> {
    const base: SceneBase = { kind: 'builtin', url, label };
    const restored = readDraft(base);
    const scene = restored ?? makeDraftScene(base, label);
    await this._loadIntoWorkspace(scene, null);
    updateUrlSceneParam(urlValueForBase(base), baseLabelForOption(base));
  }

  /**
   * Open a "published" scene transiently — a read-only RvScene fetched from a
   * static asset (e.g. the project's `scenes/<name>.scene.json`) and routed via
   * `?scene=published:<name>`. Unlike a saved scene it is NOT written to
   * localStorage, so a shared public link has no side effects on the visitor's
   * stored scenes. `name` is only used to keep the URL stable across reloads.
   */
  async openPublished(scene: RvScene, name: string): Promise<void> {
    if (!isValidSceneV2(scene)) {
      throw new Error('Invalid published scene JSON (missing schemaVersion 2 / base / edits / settings)');
    }
    await this._loadIntoWorkspace(scene, null);
    // Mark which example is active so the Examples row can highlight (transient
    // scenes have no saved id / non-builtin base to match against).
    this._activePublishedName = name;
    updateUrlSceneParam(`published:${name}`, baseLabelForOption(scene.base));
    this._notify();
  }

  /**
   * Open an "Example" scene from the catalogue transiently (read-only — not
   * written to localStorage), then switch to its preferred workspace mode if
   * one is declared in the manifest.
   *
   * The preferred mode is applied here via the mode manager (which persists it);
   * on reload the published boot path re-applies it from the catalogue entry, so
   * the workspace is restored without the mode needing to live in the URL.
   */
  async openPublishedExample(entry: PublishedSceneEntry): Promise<void> {
    if (this._busy) return;        // ignore re-clicks while a load is in flight
    this._busy = true;
    this._notify();                // disable the rows immediately (fetch precedes _loadIntoWorkspace)
    try {
      const scene = await this._fetchPublishedScene(entry);
      await this.openPublished(scene, entry.urlName);
      this._applyMode(entry.mode);
    } finally {
      this._busy = false;
      this._notify();
    }
  }

  /**
   * Import an "Example" scene into "My Scenes" as a fresh, fully editable saved
   * scene (localStorage), then open it. This is the "make the demo mine" path:
   * the user gets an editable copy under their own name. Returns the new id.
   */
  async addPublishedToMyScenes(entry: PublishedSceneEntry): Promise<string> {
    if (this._busy) throw new Error('A scene operation is already in progress.');
    this._busy = true;
    this._notify();
    try {
      const scene = await this._fetchPublishedScene(entry);
      const now = new Date().toISOString();
      const fresh: RvScene = {
        ...scene,
        id: newSceneId(),
        // Disambiguate so repeated imports don't produce indistinguishable rows.
        name: this._uniqueSceneName(entry.label),
        createdAt: now,
        modifiedAt: now,
        // It's a brand-new user-owned scene, not a duplicate of a stored one.
        parentId: undefined,
      };
      const persisted = writeScene(fresh);
      // writeScene swallows quota errors (returns the object but stores nothing);
      // detect that here so openScene doesn't throw an opaque "not found".
      if (!readScene(persisted.id)) {
        throw new Error('Could not save the example — browser storage is full.');
      }
      emitSceneMutation({ type: 'upsert', id: persisted.id, scene: persisted });
      this._refreshScenes();
      this._notify();
      await this.openScene(persisted.id);
      this._applyMode(entry.mode);
      return persisted.id;
    } finally {
      this._busy = false;
      this._notify();
    }
  }

  /** Make a scene name unique among saved scenes by appending " (2)", " (3)", … */
  private _uniqueSceneName(base: string): string {
    const taken = new Set(this._scenes.map(m => m.name));
    if (!taken.has(base)) return base;
    let n = 2;
    while (taken.has(`${base} (${n})`)) n++;
    return `${base} (${n})`;
  }

  /** Fetch + validate a published scene JSON from the DemoRealvirtual project. */
  private async _fetchPublishedScene(entry: PublishedSceneEntry): Promise<RvScene> {
    const resp = await fetch(publishedSceneUrl(entry.file), { cache: 'no-store' });
    if (!resp.ok) throw new Error(`Failed to fetch example scene ${entry.file}: HTTP ${resp.status}`);
    const scene = await resp.json();
    if (!isValidSceneV2(scene)) {
      throw new Error(`Invalid example scene JSON: ${entry.file}`);
    }
    return scene;
  }

  /** Switch workspace mode if the id is a registered mode. No-op when absent. */
  private _applyMode(mode?: string): void {
    if (!mode) return;
    try {
      if (this._viewer.modes.has(mode)) this._viewer.modes.setMode(mode);
      else console.warn(`[SceneStore] example declares unknown mode '${mode}' — not applied`);
    } catch { /* mode system unavailable (e.g. tests) — ignore */ }
  }

  /**
   * Create a fresh empty scene. Always discards any prior autosaved empty
   * draft and always names the new scene "Untitled" — this is the explicit
   * "New empty scene" gesture from the user (e.g. the SceneWindow button)
   * and from `discard()` for an unsaved empty workspace.
   *
   * For the boot path (reload after editing an Untitled scene) use
   * `openEmpty()` instead — that one resumes the autosaved per-base draft.
   */
  async newEmpty(): Promise<void> {
    const base: SceneBase = { kind: 'empty' };
    clearDraft(base);
    const scene = makeDraftScene(base, 'Untitled');
    await this._loadIntoWorkspace(scene, null);
    updateUrlSceneParam('empty', null);
  }

  /**
   * Open an empty scene, **resuming** the autosaved per-base empty draft if
   * one exists. Used by the boot path (`?scene=empty`) so a reload preserves
   * edits the user has made on an "Untitled" empty workspace — the same
   * resume semantics `openBuiltin()` provides for built-in bases.
   *
   * Compare to `newEmpty()`, which always discards the prior draft and
   * starts fresh.
   */
  async openEmpty(): Promise<void> {
    const base: SceneBase = { kind: 'empty' };
    const restored = readDraft(base);
    const scene = restored ?? makeDraftScene(base, 'Untitled');
    await this._loadIntoWorkspace(scene, null);
    updateUrlSceneParam('empty', null);
  }

  /** Duplicate a saved scene as a fresh draft. */
  async forkFromBase(baseId: string): Promise<void> {
    const src = readScene(baseId);
    if (!src) throw new Error(`Scene ${baseId} not found`);
    const fork: RvScene = {
      ...src,
      id: 'draft',
      name: `${src.name} (copy)`,
      parentId: src.id,
    };
    return this._loadIntoWorkspace(fork, null);
  }

  /**
   * Internal: cancel any pending autosave, set state, await viewer.loadScene,
   * then snapshot the baseline. Used by all four open* entry points.
   */
  private async _loadIntoWorkspace(scene: RvScene, saved: RvScene | null): Promise<void> {
    this._cancelAutosave();
    // Any normal open clears the "active example" marker; openPublished() re-sets
    // it after this returns.
    this._activePublishedName = null;
    this._loading = true;
    this._busy = true;
    this._workspace = workspaceShellOf(scene);
    this._settings = { ...scene.edits.settings };
    // Baseline = the scene's clean (last-persisted) state. Dirty is computed
    // as `!opsEqual(_baselineOps, _ops)`.
    //   • Saved scene  → baseline = the saved scene's ops; identical to
    //                    current on open, so dirty=false until the user
    //                    edits.
    //   • Built-in / fork / restored draft (saved=null) → baseline = empty
    //                    (the unmodified base GLB). On a fresh open, ops=[]
    //                    so dirty=false. On a draft RESTORE the draft's
    //                    ops are non-empty, so dirty=true correctly — the
    //                    UI surfaces "Unsaved" immediately on reload until
    //                    the user explicitly saves or discards.
    this._baselineOps = saved ? saved.edits.ops : [];
    this._ops = [...scene.edits.ops];
    this._redoStack = [];
    this._saved = saved;
    this._notify();
    // Surface a centered loading overlay during scene/GLB swaps. The base
    // GLB parse + scene rebuild blocks the main thread for a few seconds
    // on larger models; without this hint the UI looks frozen. The
    // overlay is `pointerEvents:none` so it doesn't block any background
    // interactions that happen to remain responsive.
    const sceneLabel = scene.name || baseLabelOf(scene.base) || 'scene';
    showInfoOverlay(`Loading ${sceneLabel}…`);
    try {
      await this._viewer.loadScene(scene);
      setActiveSceneId(saved?.id ?? null);
    } finally {
      this._loading = false;
      this._busy = false;
      hideInfoOverlay();
      this._notify();
    }
  }

  // ─── Persistence ────────────────────────────────────────────────────

  /** Save the current draft (creates a new id on first save, else overwrites). */
  async save(): Promise<void> {
    if (!this._workspace) return;
    const isFirstSave = this._workspace.id === 'draft';
    const id = isFirstSave ? newSceneId() : this._workspace.id;
    const now = new Date().toISOString();
    const scene: RvScene = {
      id,
      name: this._workspace.name,
      base: this._workspace.base,
      createdAt: this._workspace.createdAt,
      modifiedAt: now,
      schemaVersion: 2,
      parentId: this._workspace.parentId,
      description: this._workspace.description,
      edits: { ops: [...this._ops], settings: { ...this._settings } },
    };
    const persisted = writeScene(scene);
    this._workspace = workspaceShellOf(persisted);
    this._saved = persisted;
    this._activePublishedName = null;  // now a saved My Scene, not the example
    this._baselineOps = persisted.edits.ops;
    // _ops stays as-is (now matches baseline)
    emitSceneMutation({ type: 'upsert', id: persisted.id, scene: persisted });
    setActiveSceneId(persisted.id);
    // Clear both draft slots: the per-base slot (legacy / pre-fix path that
    // accumulated edits before the workspace had a saved id) AND the new
    // per-saved-scene slot (defensive — clean baseline post-save).
    clearDraft(persisted.base);
    clearSceneDraft(persisted.id);
    this._refreshScenes();
    this._viewer.currentScene = persisted;
    updateUrlSceneParam(persisted.id);
    this._notify();
  }

  /** Save under a new name — always creates a new id. */
  async saveAs(name: string): Promise<string> {
    if (!this._workspace) throw new Error('Nothing to save');
    const id = newSceneId();
    const now = new Date().toISOString();
    const scene: RvScene = {
      id,
      name,
      base: this._workspace.base,
      createdAt: now,
      modifiedAt: now,
      schemaVersion: 2,
      parentId: this._saved?.id,
      description: this._workspace.description,
      edits: { ops: [...this._ops], settings: { ...this._settings } },
    };
    const persisted = writeScene(scene);
    this._workspace = workspaceShellOf(persisted);
    this._saved = persisted;
    this._activePublishedName = null;  // now a saved My Scene, not the example
    this._baselineOps = persisted.edits.ops;
    emitSceneMutation({ type: 'upsert', id: persisted.id, scene: persisted });
    setActiveSceneId(persisted.id);
    // See save() above for the dual-slot rationale.
    clearDraft(persisted.base);
    clearSceneDraft(persisted.id);
    this._refreshScenes();
    this._viewer.currentScene = persisted;
    updateUrlSceneParam(persisted.id);
    this._notify();
    return persisted.id;
  }

  /** Revert to the last-saved state (or to bare base for fresh drafts). */
  async discard(): Promise<void> {
    if (this._saved) {
      // Clear the per-saved-scene draft slot BEFORE re-opening — without
      // this, openScene would just restore the same draft we're trying to
      // throw away.
      clearSceneDraft(this._saved.id);
      await this.openScene(this._saved.id);
    } else if (this._workspace) {
      const base = this._workspace.base;
      clearDraft(base);
      if (base.kind === 'builtin') await this.openBuiltin(base.url, base.label);
      else await this.newEmpty();
    }
  }

  rename(id: string, name: string): void {
    const s = readScene(id);
    if (!s) return;
    const prevName = s.name;
    const updated = writeScene({ ...s, name });
    emitSceneMutation({ type: 'rename', id, scene: updated, prevName });
    if (this._saved?.id === id) {
      this._saved = updated;
      if (this._workspace?.id === id) this._workspace = { ...this._workspace, name };
      this._viewer.currentScene = updated;
    }
    this._refreshScenes();
    this._notify();
  }

  /**
   * Create an empty saved scene **without** opening it.
   *
   * `newEmpty()` is the other half of this pair and replaces the workspace,
   * which is the right gesture from the viewport but the wrong one from the
   * Projects dashboard: there the user is cataloguing, not switching. Creating
   * the row first lets them name it and choose when to leave the screen — and
   * because it is written straight away (same `upsert` seam `duplicate()`
   * uses), it survives a reload as an empty scene rather than as nothing.
   *
   * Returns the new id so the caller can select the card it just made.
   */
  createEmpty(name = 'Untitled'): string {
    const scene = makeDraftScene({ kind: 'empty' }, this._uniqueSceneName(name));
    const persisted = writeScene({ ...scene, id: newSceneId() });
    emitSceneMutation({ type: 'upsert', id: persisted.id, scene: persisted });
    this._refreshScenes();
    this._notify();
    return persisted.id;
  }

  duplicate(id: string): string {
    const src = readScene(id);
    if (!src) throw new Error(`Scene ${id} not found`);
    const now = new Date().toISOString();
    const dup: RvScene = {
      ...src,
      id: newSceneId(),
      name: `${src.name} (copy)`,
      createdAt: now,
      modifiedAt: now,
      parentId: src.id,
    };
    const persistedDup = writeScene(dup);
    emitSceneMutation({ type: 'upsert', id: persistedDup.id, scene: persistedDup });
    this._refreshScenes();
    this._notify();
    return dup.id;
  }

  async delete(id: string): Promise<void> {
    const wasActive = this._saved?.id === id;
    deleteScene(id);
    emitSceneMutation({ type: 'delete', id });
    // Clean up any orphaned draft for this saved scene — otherwise
    // re-creating a scene with the same id (extremely unlikely but
    // possible via JSON import) would inherit a stale draft.
    clearSceneDraft(id);
    this._refreshScenes();
    if (wasActive) {
      this._workspace = null;
      this._saved = null;
      this._ops = [];
      this._baselineOps = [];
      this._redoStack = [];
      this._viewer.currentScene = null;
      const fb = this._builtins[0];
      if (fb) await this.openBuiltin(fb.url, fb.label);
      else await this._viewer.loadEmptyScene();
    }
    this._notify();
  }

  // ─── JSON import / export ───────────────────────────────────────────

  exportSceneJSON(id: string): void {
    const scene = readScene(id);
    if (!scene) return;
    const json = JSON.stringify(scene, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${scene.name.replace(/\s+/g, '_')}.scene.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async importSceneJSON(file: File): Promise<string> {
    const text = await file.text();
    const parsed = JSON.parse(text);
    if (!isValidSceneV2(parsed)) {
      throw new Error('Invalid scene JSON (missing schemaVersion 2 / base / edits / settings)');
    }
    const now = new Date().toISOString();
    const fresh: RvScene = {
      ...parsed,
      id: newSceneId(),
      createdAt: now,
      modifiedAt: now,
      parentId: parsed.id,
    };
    const persistedImport = writeScene(fresh);
    emitSceneMutation({ type: 'upsert', id: persistedImport.id, scene: persistedImport });
    this._refreshScenes();
    this._notify();
    return fresh.id;
  }

  // ─── GLB bake ───────────────────────────────────────────────────────

  /**
   * Write the working scene's property overrides INTO a copy of its base GLB,
   * then adopt that GLB as the new baseline.
   *
   * The point is portability: after this the configuration travels with the
   * file. A signal binding made here survives a cleared localStorage, a
   * different browser, and a customer who only ever receives the `.glb`.
   *
   * The geometry is not re-encoded — only the JSON chunk is rewritten (see
   * `rv-scene-glb-bake.ts`). Structural edits (planner placements, added or
   * moved nodes, connections) cannot be expressed as node extras, so a scene
   * carrying any of them is refused rather than half-baked.
   *
   * Must be called from a user gesture — a folder project prompts for File
   * System Access permission.
   */
  saveSettingsIntoModel(name: string): Promise<SaveSettingsIntoModelOutcome> {
    // The WHOLE transaction runs inside the op queue, not just a drain in front
    // of it. Fetching 35 MB and writing it back takes seconds, and `applyOp` /
    // `undo` / `redo` all queue here — draining first and then working outside
    // would let an edit land mid-flight, be visibly applied, and then be erased
    // by the empty op log this method installs at the end.
    return this._enqueueResult(() => this._saveSettingsIntoModel(name));
  }

  private async _saveSettingsIntoModel(name: string): Promise<SaveSettingsIntoModelOutcome> {
    const workspaceAtStart = this._workspace;
    if (!workspaceAtStart) return { kind: 'error', message: 'No scene is open.' };

    const base = workspaceAtStart.base;
    if (base.kind !== 'builtin') return { kind: 'no-model-base' };

    const edits = materialise(this._ops);
    const blocking = describeStructuralEdits(edits);
    if (blocking.length > 0) return { kind: 'structural-ops', details: blocking };
    if (Object.keys(edits.overlay.nodes).length === 0) return { kind: 'nothing-to-save' };

    // Same guard sequence as `saveAssetToCustomLibrary` — the distinction
    // between "no project", "read-only project" and "browser cannot do folder
    // projects" is what makes the message actionable.
    const backend = getProjectStore().getBackend();
    if (!backend) return { kind: 'no-writable-project', reason: 'No project is open.' };
    if (!backend.writable) {
      return {
        kind: 'no-writable-project',
        reason: backend.kind === 'bundled'
          ? 'This project ships with the application and cannot be written to. Create or open your own project to save into a model.'
          : 'The open project is read-only.',
      };
    }
    if (backend.kind === 'folder' && !isFileSystemAccessSupported()) return { kind: 'unsupported' };

    const registry = this._viewer.registry;
    if (!registry) return { kind: 'error', message: 'No model is loaded.' };

    this._busy = true;
    this._notify();
    // Set once the blob is on disk. Any later failure has to take it back down
    // again — an orphan in `models/` looks exactly like a finished delivery.
    let writtenPath: string | null = null;
    try {
      // The deduplicated name is the ONLY name from here on: reporting the
      // requested one would tell the user about a file that does not exist.
      const fileName = await uniqueModelFileName(backend, `${sanitizeModelFileName(name)}.glb`);
      const relPath = `models/${fileName}`;

      // Re-fetched rather than retained: holding a 35 MB source buffer for the
      // lifetime of every model is exactly the double-buffering that caused
      // out-of-memory blank scenes on mobile (see `loadAndPrepareGLTF`). This is
      // a rare, explicit action, so one fetch is the better trade — and
      // `expectedNames` below covers the risk that fetch brings back a
      // different file than the one the node indices were captured from.
      const response = await fetch(base.url);
      if (!response.ok) throw new Error(`Could not read the model file (${response.status}): ${base.url}`);
      const source = await response.arrayBuffer();

      const result = writeSettingsIntoModel(
        source,
        edits.overlay,
        (path) => registry.getGltfNodeIndex(path),
        { expectedNames: registry.getGltfNodeNames() },
      );

      await backend.writeBlob(relPath, new Blob([result.glb as BlobPart], { type: 'model/gltf-binary' }));
      writtenPath = relPath;

      // Scene loads do NOT go through the op queue, so the user can still have
      // switched scenes while we fetched and wrote. Adopting now would install
      // this model over whatever they moved to. The file stays (it is valid and
      // named after their scene); only the adoption is abandoned.
      if (this._workspace !== workspaceAtStart) {
        writtenPath = null;
        return { kind: 'scene-changed', fileName, relPath };
      }

      // Same resolution the Projects dashboard uses to open a project model
      // (`ProjectsDashboardHost.openModel`). It drops the backend's `release()`
      // on purpose — revoking the object URL would pull the bytes out from
      // under the model the user is about to look at.
      const resolvedUrl = await getProjectStore().resolveAssetUrl(relPath);
      if (!resolvedUrl) throw new Error(`The model was written but could not be resolved back: ${relPath}`);

      // Adopting the new file as the base reloads from the bytes we just wrote,
      // which is also the cheapest possible proof that the result is loadable.
      // `openBuiltin` gives the empty op log and the fresh draft slot for free.
      const label = fileName.replace(/\.glb$/i, '');
      await this.openBuiltin(resolvedUrl, label);
      writtenPath = null; // adopted — the file is the scene's base now, never roll it back
      // The old base's autosave snapshot still holds the ops we just wrote in;
      // left alone it would re-apply them on top of the new model next time
      // that base is opened.
      clearDraft(base);

      // The camera preset lives outside the model file, keyed by model URL —
      // carry it across by hand rather than refuse over it.
      if (edits.cameraStart) {
        const key = deriveModelKey(this._viewer.currentModelUrl);
        if (key) saveStartPos(key, edits.cameraStart);
      }

      return {
        kind: 'saved',
        fileName,
        relPath,
        nodes: result.nodes,
        fields: result.fields,
        signatureDropped: result.signatureDropped,
      };
    } catch (e) {
      console.error('[scene-store] saving settings into the model failed:', e);
      if (writtenPath) {
        // Best-effort: a failed run must not leave a file that looks finished.
        try { await backend.deleteBlob(writtenPath); } catch (cleanup) {
          console.warn('[scene-store] could not remove the partially written model:', cleanup);
          return {
            kind: 'error',
            message: `${e instanceof Error ? e.message : String(e)} — and "${writtenPath}" could not be removed; delete it by hand.`,
          };
        }
      }
      return { kind: 'error', message: e instanceof Error ? e.message : String(e) };
    } finally {
      this._busy = false;
      this._notify();
    }
  }

  // ════════════════════════════════════════════════════════════════════
  // Op API — applyOp / undo / redo / transactions
  // ════════════════════════════════════════════════════════════════════

  /**
   * Apply an op to the live workspace. Serialised through `_opQueue`:
   * concurrent calls run sequentially. During in-flight loads (`_loading`),
   * ops are dropped on the floor — the load is replaying canonical state.
   *
   * If a transaction is open, the op is buffered instead of pushed onto
   * `_ops`; the composite is committed by `endTransaction`.
   */
  applyOp(op: PrimitiveEditOp): Promise<void> {
    return this._enqueue(async () => {
      if (this._loading) return;
      // Inside a transaction, accumulate primitives. The composite executes
      // via the executor at commit time (so the live scene reflects the
      // final state immediately on each primitive — but only one undo).
      if (this._txnDepth > 0) {
        await applyForward(op, { viewer: this._viewer });
        this._txnBuffer.push(op);
        return;
      }
      await applyForward(op, { viewer: this._viewer });
      this._pushOp(op);
      this._redoStack.length = 0;   // any new op invalidates redo
      this._enforceCap();
      this._afterOpsChanged();
    });
  }

  /** Undo the last op (down to the baseline floor). */
  undo(): Promise<void> {
    return this._enqueue(async () => {
      if (this._loading) return;
      if (this._ops.length <= this._baselineOps.length) return;
      const op = this._ops.pop()!;
      await applyInverse(op, { viewer: this._viewer });
      this._redoStack.push(op);
      this._afterOpsChanged();
    });
  }

  /** Redo the most-recently undone op. */
  redo(): Promise<void> {
    return this._enqueue(async () => {
      if (this._loading) return;
      const op = this._redoStack.pop();
      if (!op) return;
      await applyForward(op, { viewer: this._viewer });
      this._ops.push(op);
      this._afterOpsChanged();
    });
  }

  canUndo(): boolean { return this._ops.length > this._baselineOps.length; }
  canRedo(): boolean { return this._redoStack.length > 0; }

  describeUndo(): string | null {
    if (!this.canUndo()) return null;
    return `Undo: ${describeOp(this._ops[this._ops.length - 1])}`;
  }

  describeRedo(): string | null {
    if (!this.canRedo()) return null;
    return `Redo: ${describeOp(this._redoStack[this._redoStack.length - 1])}`;
  }

  /**
   * Begin a transaction. Subsequent `applyOp` calls accumulate into a
   * composite; commit on `endTransaction`. Reference-counted depth — nested
   * transactions commit when the OUTER one ends.
   */
  beginTransaction(label: string): TransactionToken {
    if (this._txnDepth === 0) {
      this._txnLabel = label;
      this._txnBuffer = [];
    }
    this._txnDepth++;
    return Object.freeze({ _depth: this._txnDepth });
  }

  /** Commit (push the composite op). Empty transactions become no-ops. */
  endTransaction(_token: TransactionToken): Promise<void> {
    return this._enqueue(async () => {
      if (this._txnDepth === 0) return;
      this._txnDepth--;
      if (this._txnDepth > 0) return; // outer commits later
      const ops = this._txnBuffer;
      this._txnBuffer = [];
      const label = this._txnLabel;
      this._txnLabel = '';
      if (ops.length === 0) return;
      const composite: EditOp = {
        id: freshOpId(), ts: Date.now(), schemaV: 1,
        kind: 'composite', label, ops,
      };
      this._pushOp(composite);
      this._redoStack.length = 0;
      this._enforceCap();
      this._afterOpsChanged();
    });
  }

  /** Discard the buffered primitives. The forward applies HAVE happened on
   *  the live scene — caller is responsible for any rollback. Use sparingly. */
  abortTransaction(_token: TransactionToken): void {
    if (this._txnDepth === 0) return;
    this._txnDepth--;
    if (this._txnDepth === 0) {
      this._txnBuffer = [];
      this._txnLabel = '';
    }
  }

  /** RAII helper. */
  async withTransaction<T>(label: string, fn: () => T | Promise<T>): Promise<T> {
    const token = this.beginTransaction(label);
    try {
      const result = await fn();
      await this.endTransaction(token);
      return result;
    } catch (e) {
      this.abortTransaction(token);
      throw e;
    }
  }

  /**
   * Push an op onto _ops with coalescing. The merged op is forward-applied
   * only ONCE (the caller already applied it before calling _pushOp), but the
   * incoming op's value replaces the head's. Coalescing only happens when:
   *   - the head exists and `canCoalesce` agrees, AND
   *   - the head is ABOVE the baseline (so coalescing wouldn't corrupt the
   *     baseline's prev field, which would make undo-to-baseline lose
   *     information).
   */
  private _pushOp(op: EditOp): void {
    const last = this._ops[this._ops.length - 1];
    const headIsAboveBaseline = this._ops.length > this._baselineOps.length;
    if (last && headIsAboveBaseline && canCoalesce(last, op)) {
      this._ops[this._ops.length - 1] = mergeOps(last, op);
    } else {
      this._ops.push(op);
    }
  }

  private _enforceCap(): void {
    if (this._ops.length <= MAX_OP_HISTORY) return;
    const drop = this._ops.length - MAX_OP_HISTORY;
    this._ops.splice(0, drop);
    // Keep baseline aligned to the start of the kept window.
    if (this._baselineOps.length > 0) {
      const keepBaseline = Math.max(0, this._baselineOps.length - drop);
      this._baselineOps = this._baselineOps.slice(this._baselineOps.length - keepBaseline);
    }
  }

  private _afterOpsChanged(): void {
    // Schedule draft autosave (debounced). The slot we write to depends on
    // whether the workspace is anchored to a saved scene:
    //   • _saved != null → per-saved-scene slot (rv-scenes/scene-draft/<id>)
    //                       so reload via openScene resumes correctly.
    //   • _saved == null → per-base slot (rv-scenes/draft/<baseKey>) so
    //                       reload via openBuiltin resumes correctly.
    if (this._draftAutosaveTimer !== null) clearTimeout(this._draftAutosaveTimer);
    this._draftAutosaveTimer = window.setTimeout(() => {
      this._draftAutosaveTimer = null;
      if (!this._workspace) return;
      const draft = this._buildDraft();
      if (!draft) return;
      const saved = this._saved;
      if (this.canUndo() || this.canRedo() || !saved) {
        // There's edit content beyond baseline OR we're a fresh draft —
        // persist for tab-close survival.
        if (saved) writeSceneDraft(saved.id, draft);
        else writeDraft(this._workspace.base, draft);
      } else {
        // Workspace is in pristine saved state — clear the saved-scene's
        // draft slot. (No matching clear for the base slot here: a saved
        // workspace's base slot belongs to fresh built-in drafts of that
        // base, not to us.)
        clearSceneDraft(saved.id);
      }
    }, DRAFT_AUTOSAVE_DEBOUNCE_MS);
    this._notify();
  }

  private _cancelAutosave(): void {
    if (this._draftAutosaveTimer !== null) {
      clearTimeout(this._draftAutosaveTimer);
      this._draftAutosaveTimer = null;
    }
  }

  // ─── Async queue ────────────────────────────────────────────────────

  private _enqueue(work: () => Promise<void>): Promise<void> {
    const next = this._opQueue.then(() => work(), () => work());
    this._opQueue = next.catch(() => undefined);
    return next;
  }

  /**
   * `_enqueue` for work that returns something.
   *
   * Same single-flight guarantee — the queue is what makes a long transaction
   * (fetch, patch, write) safe against ops landing halfway through it.
   */
  private _enqueueResult<T>(work: () => Promise<T>): Promise<T> {
    const next = this._opQueue.then(() => work(), () => work());
    this._opQueue = next.then(() => undefined, () => undefined);
    return next;
  }

  // ─── Internals ──────────────────────────────────────────────────────

  private _refreshBuiltins(): void {
    this._builtins = (this._viewer.availableModels ?? []).map(m => ({ url: m.url, label: m.label }));
  }

  private _refreshScenes(): void {
    this._scenes = listMetas();
  }

  private _refreshPublished(): void {
    this._published = this._viewer.availablePublishedScenes ?? [];
  }

  private _buildDraft(): RvScene | null {
    if (!this._workspace) return null;
    return {
      id: this._workspace.id,
      name: this._workspace.name,
      base: this._workspace.base,
      createdAt: this._workspace.createdAt,
      modifiedAt: new Date().toISOString(),
      schemaVersion: 2,
      parentId: this._workspace.parentId,
      description: this._workspace.description,
      edits: { ops: this._ops, settings: this._settings },
    };
  }

  private _buildSnapshot(): SceneSnapshot {
    const draft = this._buildDraft();
    const dirty = !opsEqual(this._baselineOps, this._ops);
    const isDraft = this._saved == null && this._workspace != null;
    return {
      saved: this._saved,
      draft,
      isDraft,
      dirty,
      scenes: this._scenes,
      builtins: this._builtins,
      published: this._published,
      activePublishedName: this._activePublishedName,
      busy: this._busy,
      canUndo: this.canUndo(),
      canRedo: this.canRedo(),
      undoLabel: this.describeUndo(),
      redoLabel: this.describeRedo(),
    };
  }

  private _notify(): void {
    this._snapshot = this._buildSnapshot();
    for (const l of this._listeners) l();
  }

}

// ─── Helpers ────────────────────────────────────────────────────────────

function workspaceShellOf(scene: RvScene): WorkspaceShell {
  return {
    id: scene.id,
    name: scene.name,
    base: scene.base,
    createdAt: scene.createdAt,
    parentId: scene.parentId,
    description: scene.description,
  };
}

function freshShell(base: SceneBase, name: string): WorkspaceShell {
  return {
    id: 'draft',
    name,
    base,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Sync `?scene=<value>` in the address bar. Pass null to drop the param.
 * Always called via history.replaceState — no navigation, just URL refresh
 * so a browser reload picks up exactly where the user left off.
 *
 * `?option=` (the deep-link model variant, plan-373 F6) is deliberately NOT
 * touched for the base it belongs to — that is what makes the deep link survive
 * a reload. It IS removed when switching to a base that does not declare the
 * option, because `ModelOptionPlugin` falls back to `window.location.search` and
 * a leftover `option=bosch` would otherwise keep applying to every later model.
 *
 * @param baseLabel Base model label (GLB filename without .glb) the new scene
 *                  sits on, or null when there is none (empty / saved scenes).
 *                  Pass `undefined` to leave `option` untouched.
 */
function updateUrlSceneParam(value: string | null, baseLabel?: string | null): void {
  if (typeof window === 'undefined' || typeof window.history?.replaceState !== 'function') return;
  try {
    const url = new URL(window.location.href);
    if (value === null) url.searchParams.delete('scene');
    else url.searchParams.set('scene', value);
    url.searchParams.delete('model');
    if (baseLabel !== undefined) {
      const option = url.searchParams.get('option');
      if (option && !nextOptionParam(baseLabel, option)) url.searchParams.delete('option');
    }
    window.history.replaceState(window.history.state, '', url.toString());
  } catch { /* ignore */ }
}

/**
 * The base model label a `?option=` deep link would apply to — the GLB filename
 * without extension, matching `model-options.ts` `baseModel`. Null for any base
 * that is not a built-in GLB, which drops the parameter.
 */
function baseLabelForOption(base: SceneBase): string | null {
  if (base.kind !== 'builtin') return null;
  const filename = base.url.split('?')[0].split('/').pop() ?? '';
  return filename.replace(/\.glb$/i, '') || null;
}

/** Compute the `?scene=<value>` form for a given workspace base. */
function urlValueForBase(base: SceneBase): string {
  if (base.kind === 'empty') return 'empty';
  // For built-ins, prefer the filename — short, stable, matches main.ts boot
  // matcher which checks `entries.find(e => e.filename === wanted || ...)`.
  const filename = base.url.split('?')[0].split('/').pop() ?? base.url;
  return 'builtin:' + filename;
}

// Keep imports from being marked unused by linters.
void scenesEqual;
void baseLabelOf;
void metaOf;
void COALESCE_WINDOW_MS;
