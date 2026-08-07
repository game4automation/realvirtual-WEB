// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * project-store — the bridge between a project folder and the browser cache.
 *
 * The folder is the source of truth; localStorage becomes a working cache.
 * This store does not replace `SceneStore`, it feeds it.
 *
 * ## One backend, on purpose
 *
 * There is exactly one backend here: the read-write folder handle. A
 * read-only HTTP provider for published builds is a separate plan, so the
 * read side sits behind the narrow {@link ProjectReadProvider} seam it would
 * need — and nothing more is abstracted on spec.
 *
 * ## Hydration is lazy, and that has a cost that had to be paid (RR2)
 *
 * Opening a project mirrors only the scene **metadata** plus the **active
 * scene** into the cache. Seeding every scene would push megabytes through
 * `writeScene()`, which swallows quota errors silently — a hydration could
 * die halfway and leave orphans with no index entry.
 *
 * The price: `SceneStore.openScene()` throws `Scene <id> not found` when the
 * body is not cached, which would break the Models-panel click and the
 * `web_scene_open` MCP tool. So `SceneStore` gained a pre-fetch hook and is
 * no longer untouched by this work. That is a deliberate, named change, not
 * an accident — see {@link ProjectStore.attachToSceneStore}.
 *
 * ## Draft scoping (RR4)
 *
 * Per-base drafts (`rv-scenes/draft/<baseKey>`) carry no project reference,
 * so the same built-in opened in two projects would share one unsaved draft.
 * Opening a project sets a draft scope; closing clears it.
 *
 * ## Conflict reconciliation (§4c, Phase 2)
 *
 * Opening a project no longer assumes the cache is stale or fresh — it asks
 * {@link resolveSceneConflict} per scene. Two properties of that pass matter:
 *
 *  - **Detection is metadata-only, application reads bodies.** Lazy hydration
 *    means most scenes have no cached body at all; those cannot conflict and
 *    are skipped without a single file read. Only a scene that *is* cached is
 *    compared, first on the manifest's `modifiedAt` alone, and its body is
 *    read solely when the metadata answer is something other than "equal" —
 *    i.e. only when the body is needed either to confirm the divergence or to
 *    apply the folder version.
 *  - **"Folder wins" clears the per-scene draft.** Overwriting only
 *    `rv-scenes/<id>` would be undone by the next `openScene()`, which prefers
 *    `readSceneDraft(id)`. See {@link ProjectStore._applyFolderScene}.
 *
 * ## Cache provenance (plan-373)
 *
 * One `sceneId` legitimately belongs to several projects — that is what
 * `createProjectFromScenes()` produces on purpose — while the cache has room
 * for exactly one body. Until this was tracked, opening project B with
 * project A's body in the cache made {@link ProjectStore.hydrateScene}
 * short-circuit and the next save wrote A's content onto B's own
 * `.scene.json`.
 *
 * `rv-scene-owner/<sceneId>` (see `rv-scene-owner.ts`) records where the
 * cached body came from. Three places consume it here: hydration refuses the
 * short-circuit for a foreign body, the conflict prompt names the project the
 * cache came from, and a demonstrably foreign cache defaults to "the folder
 * wins" instead of silently being adopted. An **unknown** origin keeps the
 * behaviour the store always had — the marker is additive, never a migration.
 *
 * ## Dirty guard (§4e)
 *
 * Switching or closing a project with unsaved work runs the same guard the
 * scene/model switch uses today. It is enforced *inside* `openProjectFolder()`
 * rather than in the (still unbuilt) switcher UI, so no future caller can
 * route around it.
 */

import {
  getFolderHandle,
  projectHandleKey,
  putHandle,
  requestWriteAccess,
  selectFolderForKey,
} from '../engine/rv-local-filesystem';
import {
  clearDraftsForScope,
  clearSceneDraft,
  getDraftScope,
  readScene,
  readSceneDraft,
  setDraftScope,
  writeScene,
} from '../hmi/scene/rv-scene-storage';
import { setActiveSceneId } from '../hmi/scene/rv-scene-mutations';
import type { RvScene } from '../hmi/scene/rv-scene-types';
import { applySettingsBundle, type RVSettingsBundle } from '../hmi/rv-settings-bundle';
import {
  writeManifest,
} from './rv-project-storage';
import type { FolderWriterHost, FolderWriterStatus } from './rv-project-folder-writer';
import {
  BundledBackend,
  DEMO_PROJECT_FOLDER,
  DEMO_PROJECT_ID,
  type BundledBackendOptions,
} from './backends/bundled-backend';
import { FolderBackend } from './backends/folder-backend';
import type { ProjectBackend, ProjectReadProvider } from './backends/project-backend';
import {
  hiddenIdsOf, mergeAssetTiers, mergeSceneTiers,
  type TieredAssetEntry, type TieredSceneEntry,
} from './rv-project-tiers';
import { readRecentProjects, recordRecentProject } from './rv-project-recent';
import { getWorkspaceHandle } from './rv-project-workspace';
import {
  cachedFromProject,
  isCacheFromOtherProject,
  noteSceneMembership,
  setCachedFrom,
} from './rv-scene-owner';
import {
  cacheModifiedAt,
  hasUnsavedDraft,
  resolveSceneConflict,
  type SceneConflictResolution,
} from './rv-project-conflict';
import {
  newProject,
  type RvProject,
  type RvProjectAssetEntry,
  type RvProjectSceneEntry,
} from './rv-project-types';

/** localStorage pointer to the project to restore on next boot. */
export const LS_KEY_LAST_PROJECT = 'rv-project/last';

// ─── Read provider seam ─────────────────────────────────────────────────

/**
 * The read surface a project backend must offer.
 *
 * It moved to `backends/project-backend.ts` together with the folder
 * implementation (§2.2.2) and is re-exported here so existing importers keep
 * working. `kind` now reads `'bundled' | 'browser' | 'folder'`; `'http'` was
 * always the placeholder for what is now called `'bundled'`.
 */
export type { ProjectReadProvider };

// ─── Snapshot ───────────────────────────────────────────────────────────

export interface ProjectSnapshot {
  project: RvProject | null;
  /** Handle name of the open folder, for display. */
  folderName: string | null;
  /** False when the readwrite grant was refused — viewer runs, disk does not. */
  writable: boolean;
  /** Persistent disk-write error, or null. */
  diskError: string | null;
  /** True while a folder write is queued or failed. */
  diskPending: boolean;
  /** Non-fatal notes collected while opening (quota, unreadable scenes, …). */
  warnings: string[];
  /** Where the open project's bytes live. Null when nothing is open. */
  backendKind: 'bundled' | 'browser' | 'folder' | null;
  /**
   * The two tiers merged into one display list (§2.3), each entry tagged.
   *
   * Computed once per publish rather than per read — see {@link sceneIds}.
   */
  scenes: TieredSceneEntry[];
  /**
   * The project's own base models, tier-tagged like {@link scenes} (§2.3).
   *
   * Manifest-driven, exactly like the scene list — which is what keeps another
   * project's models out of this one. The deploy-wide `viewer.availableModels`
   * is a different thing entirely (every GLB the dev server can reach) and must
   * never be shown as if it belonged to whichever project happens to be open.
   */
  models: TieredAssetEntry[];
  /**
   * Ids the project owns across both tiers.
   *
   * **Cached deliberately.** `getProjectSceneIds()` used to mint a fresh
   * `Set` on every call, which is fine for a plain call and fatal under
   * `useSyncExternalStore`: a new object identity on every read is a
   * permanent "the store changed" signal and React re-renders forever.
   */
  sceneIds: Set<string>;
}

export interface OpenProjectOptions {
  /** Write a fresh manifest when the folder has none. Default false. */
  createIfMissing?: boolean;
  /** Name for a freshly created project. Defaults to the folder name. */
  name?: string;
  /** Skip the readwrite upgrade (used by tests and read-only inspection). */
  skipPermissionRequest?: boolean;
  /**
   * Bypass the unsaved-changes guard on a switch. Only for callers that have
   * already asked the user — never a convenience.
   */
  skipDirtyGuard?: boolean;
}

// ─── Boot split (§2.10) ─────────────────────────────────────────────────

export interface ResolveProjectOptions {
  /** Resolve this project instead of the one recorded last (`?project=`). */
  projectId?: string;
  /** Options for the bundled backend built on demand. */
  bundled?: BundledBackendOptions;
  /** Pre-built bundled backend. Tests and callers that already made one. */
  bundledBackend?: BundledBackend;
  /**
   * Deploy root of a project hosted somewhere else (plan-700 Phase 7 / F12).
   *
   * When it answers with a readable `project.json`, that project becomes the
   * active one — an explicitly named URL beats the project restored from the
   * last session, because the person who put it in the address bar said what
   * they wanted. It is registered read-only either way: `BundledBackend` is
   * never writable, so nothing can be written back to someone else's host.
   */
  remoteBaseUrl?: string;
}

/** What boot needs before the `SceneStore` exists. */
export interface ResolvedActiveProject {
  project: RvProject | null;
  backend: ProjectBackend;
  /** Feeds `viewer.availableModels`. */
  models: RvProjectAssetEntry[];
  /** Feeds `viewer.availablePublishedScenes`. */
  scenes: RvProjectSceneEntry[];
  kind: 'bundled' | 'browser' | 'folder';
}

/** Minimal view of SceneStore that this store needs. Keeps the import one-way. */
export interface SceneStoreLike {
  setSceneHydrator(fn: ((id: string) => Promise<boolean>) | null): void;
  refreshScenesFromStorage?(): void;
  /** Used by the dirty guard to see whether the workspace has unsaved edits. */
  getSnapshot?(): { dirty?: boolean; draft?: { name?: string } | null };
}

// ─── Conflict prompt (§4c) ──────────────────────────────────────────────

/** What the user chose for one conflicted scene. */
export type SceneConflictChoice = 'keep-cache' | 'use-folder';

/** One row of the per-scene conflict prompt. */
export interface SceneConflictPromptItem {
  id: string;
  /** Scene name as the cache knows it — the name the user recognises. */
  name: string;
  /** Name recorded in the manifest, when it differs from the cached one. */
  folderName?: string;
  cacheModifiedAt: string | null;
  folderModifiedAt: string | null;
  /** True when the divergence includes work that was never explicitly saved. */
  hasUnsavedDraft: boolean;
  /**
   * Id of the project the cached body demonstrably came from — set **only**
   * when that is a different project than the one being opened (plan-373).
   *
   * Undefined means "same project or origin unknown", which is every cache
   * written before the marker existed. A set value turns the row's honest
   * default into "use the folder version": keeping a cache that provably
   * belongs elsewhere is how the other project's content ends up in this
   * project's files.
   */
  cachedFromProjectId?: string;
  /** Display name for {@link cachedFromProjectId}, when it can be resolved. */
  cachedFromProjectName?: string;
}

/**
 * Ask the user what to do with the conflicted scenes.
 *
 * Returns a decision per scene id. Ids left out of the answer keep the cache —
 * the safe direction, and what a dismissed dialog must mean.
 */
export type SceneConflictPrompt = (
  items: SceneConflictPromptItem[],
  project: RvProject,
) => Promise<Record<string, SceneConflictChoice>> | Record<string, SceneConflictChoice>;

// ─── Dirty guard (§4e) ──────────────────────────────────────────────────

export interface ProjectDirtyContext {
  reason: 'switch' | 'close';
  /** Project being left. */
  projectName: string;
  /** Name of the workspace scene carrying unsaved edits, when known. */
  sceneName: string | null;
  /** SceneStore reports unsaved edits. */
  sceneDirty: boolean;
  /** A folder write is still queued or has failed. */
  diskPending: boolean;
}

/**
 * The unsaved-changes gate for leaving a project — the same question the
 * scene/model switch asks today (`rv-scene-confirm-dialog.tsx`).
 *
 * Returning `'cancel'` aborts the switch and leaves the open project exactly
 * as it was. With no guard installed the switch proceeds: nothing is
 * destroyed by it (the cache survives a close), so a headless caller must not
 * be made to hang.
 */
export type ProjectDirtyGuard = (
  context: ProjectDirtyContext,
) => Promise<'proceed' | 'cancel'> | 'proceed' | 'cancel';

// ─── Store ──────────────────────────────────────────────────────────────

export class ProjectStore {
  private _project: RvProject | null = null;
  private _dir: FileSystemDirectoryHandle | null = null;
  private _provider: ProjectReadProvider | null = null;
  private _writable = false;
  /** The one backend that may write. Null when nothing is open. */
  private _backend: ProjectBackend | null = null;
  /** The always-available read-only backend (§2.2.1). Built on first resolve. */
  private _bundled: BundledBackend | null = null;
  /** Read-only backends for foreign deploy roots, keyed by base URL (F12). */
  private _remotes = new Map<string, BundledBackend>();
  /** Result of {@link resolveActiveProject}, awaiting hydration. */
  private _resolved: { backend: ProjectBackend; project: RvProject } | null = null;
  /** Folder handle of a resolved-but-not-yet-hydrated project. */
  private _pendingDir: FileSystemDirectoryHandle | null = null;
  /** Bundled-tier scene entries of the open project, for the two-tier merge. */
  private _bundledScenes: RvProjectSceneEntry[] = [];
  private _bundledModels: RvProjectAssetEntry[] = [];
  private _userModels: RvProjectAssetEntry[] = [];
  private _sceneStore: SceneStoreLike | null = null;
  private _warnings: string[] = [];
  private _unloadHandler: (() => void) | null = null;
  private _conflictPrompt: SceneConflictPrompt | null = null;
  private _dirtyGuard: ProjectDirtyGuard | null = null;
  private _lastConflicts: SceneConflictPromptItem[] = [];

  private _listeners = new Set<() => void>();
  private _snapshot: ProjectSnapshot = emptySnapshot();

  // ─── Subscription ─────────────────────────────────────────────────────

  subscribe = (listener: () => void): (() => void) => {
    this._listeners.add(listener);
    return () => { this._listeners.delete(listener); };
  };

  getSnapshot = (): ProjectSnapshot => this._snapshot;

  /** The open manifest, or null. */
  getProject(): RvProject | null { return this._project; }

  /** True when a project is open AND the folder accepted a readwrite grant. */
  isWritable(): boolean { return this._writable; }

  /**
   * Ids of the scenes this project owns — the basis for Models-panel scoping.
   *
   * The union of both tiers (§2.3.1 rule 5), and the **same `Set` instance**
   * until something actually changes. Returning a fresh one per call spins
   * `useSyncExternalStore` forever.
   */
  getProjectSceneIds(): Set<string> {
    return this._snapshot.sceneIds;
  }

  /** The two tiers merged into one display list, each entry tagged (§2.3). */
  getProjectScenes(): TieredSceneEntry[] {
    return this._snapshot.scenes;
  }

  /** The backend backing the open project, or null. */
  getBackend(): ProjectBackend | null { return this._backend; }

  /**
   * The open project's directory handle, or null for a non-folder project.
   *
   * Read-only exposure for callers that genuinely need the folder itself
   * rather than the backend's write surface — the `.rvproject` exporter
   * (plan-372 Phase 16) has to walk the real tree to zip it.
   */
  getProjectDir(): FileSystemDirectoryHandle | null { return this._dir; }

  /**
   * The always-available read-only backend.
   *
   * Built on first use so a store that is never resolved costs nothing, and
   * so tests can inject one via {@link resolveActiveProject}.
   */
  getBundledBackend(opts?: BundledBackendOptions): BundledBackend {
    if (!this._bundled) this._bundled = new BundledBackend(opts);
    return this._bundled;
  }

  /**
   * A read-only project hosted on another deploy root (plan-700 Phase 7 / F12).
   *
   * The second backend of the store, and deliberately the same class as the
   * first: a foreign deploy root publishes exactly what our own does
   * (`project.json`, `models.json`, `scenes/index.json`), so this is a
   * `BundledBackend` pointed elsewhere with `discover` on — not a new codepath
   * that could disagree with the one that already works. `writable` is `false`
   * by construction and every write method throws `BackendNotWritableError`,
   * so no accident can push bytes at someone else's host.
   *
   * Cached per base URL: asking twice for the same host returns the same
   * backend, and with it the manifest it already fetched.
   */
  getRemoteBackend(baseUrl: string, opts: BundledBackendOptions = {}): BundledBackend {
    const key = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
    const existing = this._remotes.get(key);
    if (existing) return existing;
    const backend = new BundledBackend({
      ...opts,
      baseUrl: key,
      discover: true,
      id: opts.id ?? `remote:${key}`,
    });
    this._remotes.set(key, backend);
    return backend;
  }

  /** Every remote backend registered so far. Diagnostics and tests. */
  listRemoteBackends(): BundledBackend[] {
    return [...this._remotes.values()];
  }

  // ─── Attach ───────────────────────────────────────────────────────────

  /**
   * Wire the lazy-hydration pre-fetch into `SceneStore` (RR2).
   *
   * Both unguarded callers of `openScene()` — the Models-panel row click and
   * the `web_scene_open` MCP tool — go through `SceneStore.openScene()`, so
   * one hook there covers both without touching either call site.
   */
  attachToSceneStore(store: SceneStoreLike): void {
    this._sceneStore = store;
    store.setSceneHydrator(id => this.hydrateScene(id));
  }

  detachFromSceneStore(): void {
    this._sceneStore?.setSceneHydrator(null);
    this._sceneStore = null;
  }

  // ─── Prompt / guard installation ──────────────────────────────────────

  /**
   * Install the per-scene conflict prompt (§4c). Null restores the safe
   * default: keep the cache, which never destroys unsaved work.
   */
  setConflictPrompt(prompt: SceneConflictPrompt | null): void {
    this._conflictPrompt = prompt;
  }

  /** Install the unsaved-changes gate used when leaving a project (§4e). */
  setDirtyGuard(guard: ProjectDirtyGuard | null): void {
    this._dirtyGuard = guard;
  }

  /** Conflicts raised by the most recent open. Diagnostics and tests. */
  getLastConflicts(): SceneConflictPromptItem[] {
    return [...this._lastConflicts];
  }

  // ─── Open ─────────────────────────────────────────────────────────────

  /**
   * Open the shipped demo project (`DemoRealvirtual`).
   *
   * It is the one project that is always reachable — it needs no folder
   * handle and no permission grant — so the projects list can offer it next
   * to the workspace folders. Switching away from a folder project goes
   * through the same close path as any other switch, dirty guard included.
   */
  async openDemoProject(): Promise<boolean> {
    const backend = this.getBundledBackend();
    if (this._backend === backend) return true;
    if (this._backend && await this._runDirtyGuard('switch') === 'cancel') return false;
    if (this._backend) await this.closeProject();
    const project = await backend.readManifest();
    if (!project) return false;
    await this._adoptProject(backend, project);
    this._publish();
    return true;
  }

  /** Show the picker in readwrite mode and open the chosen folder. */
  async pickAndOpenProject(opts: OpenProjectOptions = {}): Promise<boolean> {
    const handle = await selectFolderForKey('rv-project-pick');
    if (!handle) return false;
    return this.openProjectFolder(handle, opts);
  }

  /**
   * Open a project folder.
   *
   * Each load step is conditional (§1.1 R1): a missing section skips its
   * step in silence. No blind `getDirectoryHandle('docs')` that would throw
   * `NotFoundError` on a project that is legitimately just scenes.
   */
  async openProjectFolder(
    dir: FileSystemDirectoryHandle,
    opts: OpenProjectOptions = {},
  ): Promise<boolean> {
    // §4e — a switch away from unsaved work asks first. The check lives here,
    // not in the switcher UI, so that no caller can route around it.
    if (this._project && !opts.skipDirtyGuard) {
      if (await this._runDirtyGuard('switch') === 'cancel') return false;
    }

    await this.closeProject();
    this._warnings = [];
    this._lastConflicts = [];

    // ── readwrite upgrade; refusal degrades to read-only, never to a throw ──
    let writable = false;
    if (opts.skipPermissionRequest) {
      writable = true;
    } else {
      try {
        writable = await requestWriteAccess(dir);
      } catch {
        writable = false;
      }
    }
    if (!writable) {
      this._warnings.push('Write access was declined — the project opens read-only.');
    }

    const backend = new FolderBackend(dir, {
      writable,
      writerHost: this._writerHost(),
    });
    let project = await backend.readManifest();

    if (!project) {
      if (!opts.createIfMissing) {
        this._warnings.push('No readable project.json in this folder.');
        this._publish();
        return false;
      }
      if (!writable) {
        this._warnings.push('Cannot create a project here without write access.');
        this._publish();
        return false;
      }
      project = newProject(opts.name ?? dir.name ?? 'Untitled project');
      await writeManifest(dir, project);
    }

    this._dir = dir;
    await this._adoptProject(backend, project);
    try { localStorage.setItem(LS_KEY_LAST_PROJECT, project.id); } catch { /* private mode */ }
    try { await putHandle(dir, projectHandleKey(project.id)); } catch { /* non-fatal */ }
    // Recents are recorded AFTER the handle is stored: a display row without a
    // reopenable handle would be a menu entry that does nothing (§4.5).
    recordRecentProject({ id: project.id, name: project.name, folderName: dir.name });

    this._publish();
    return true;
  }

  /**
   * The shared tail of every open path: adopt a resolved backend + manifest.
   *
   * Order is load-bearing, and every step of it was already load-bearing
   * before this refactor:
   *
   *  1. **Draft scope first** (RR4) — everything below reads scoped keys.
   *  2. **Reconcile before seeding** (§4c) — the active scene must be
   *     hydrated from whichever side won, not from whatever was cached.
   *  3. **`activate()` last** (§2.2.1b) — the write side comes up only once
   *     the reads are settled, so reconciliation can never echo back to disk.
   */
  private async _adoptProject(backend: ProjectBackend, project: RvProject): Promise<void> {
    this._backend = backend;
    this._provider = backend;
    this._project = project;
    this._writable = backend.writable;
    this._bundledScenes = await this._readBundledTier(backend, project);
    // Both halves come from the BACKEND, not from the manifest field: a folder
    // project enumerates its models/ folder (every GLB in it belongs to the
    // project), while the read-only HTTP project has only what the manifest
    // declares. Reading project.models here would have re-imposed the
    // manifest-only rule on folders through the back door.
    const backendModels = await backend.listModels();
    const isBundledBackend = backend.kind === 'bundled';
    this._bundledModels = isBundledBackend ? backendModels : [];
    this._userModels = isBundledBackend ? [] : backendModels;

    // RR4 — isolate this project's per-base drafts from every other context.
    //
    // The bundled/Sample project is the deliberate exception, and getting it
    // wrong is data loss rather than cosmetics: every draft written before
    // this plan lives at the **unscoped** key `rv-scenes/draft/<baseKey>`.
    // Since Sample is now adopted on every boot without a folder, scoping it
    // would hide all of them behind `prj_sample:<baseKey>` — and the next
    // `closeProject()` would `clearDraftsForScope()` them away. The unscoped
    // keyspace *is* Sample's keyspace (§2.4); that is what "the loose scenes
    // belong to Sample" means in storage terms.
    setDraftScope(backend.kind === 'bundled' ? null : project.id);

    await this._reconcileScenes(project);
    await this._seedSceneMetas(project);
    await this._applySettings(project);

    await backend.activate();
    if (backend instanceof FolderBackend) backend.onStatus(() => this._publish());
    this._installUnloadFlush();
  }

  /**
   * The bundled tier of the project being opened (§2.3).
   *
   * For a bundled backend the manifest *is* the bundled tier. For a folder
   * project there is no bundled tier at all — its content is what the folder
   * holds, full stop; the shipped demos belong to the Sample project, not to
   * a customer's git repo.
   */
  private async _readBundledTier(
    backend: ProjectBackend,
    project: RvProject,
  ): Promise<RvProjectSceneEntry[]> {
    if (backend.kind !== 'bundled') return [];
    return project.scenes ?? [];
  }

  /** Callbacks the folder writer needs from this store. */
  private _writerHost(): FolderWriterHost {
    return {
      getDirectory: () => (this._writable ? this._dir : null),
      getManifest: () => this._project ?? newProject('Untitled project'),
      setManifest: p => { this._project = p; this._publish(); },
    };
  }

  /**
   * Reopen a project from the "Recent" list (§4.5).
   *
   * Unlike {@link restoreLastProject} this **does** prompt: the user just
   * clicked the project, so the browser's re-grant dialog is expected rather
   * than an ambush. Returns false when the grant is refused or the handle has
   * gone stale — the caller reports it, the open project stays as it was.
   */
  async openRecentProject(
    projectId: string,
    opts: OpenProjectOptions = {},
  ): Promise<boolean> {
    const handle = await getFolderHandle(projectHandleKey(projectId), {
      mode: 'readwrite',
      prompt: true,
    });
    if (!handle) return false;
    return this.openProjectFolder(handle, { skipPermissionRequest: true, ...opts });
  }

  /**
   * Restore the project opened last session, if its handle is still granted.
   * Returns true when a project was restored. Never prompts: a boot-time
   * permission dialog on every reload would be its own bug.
   */
  async restoreLastProject(): Promise<boolean> {
    let lastId: string | null = null;
    try { lastId = localStorage.getItem(LS_KEY_LAST_PROJECT); } catch { return false; }
    if (!lastId) return false;
    const handle = await getFolderHandle(projectHandleKey(lastId), {
      mode: 'readwrite',
      prompt: false,
    });
    if (!handle) return false;
    return this.openProjectFolder(handle, { skipPermissionRequest: true });
  }

  // ─── Boot, in two halves (§2.10) ──────────────────────────────────────

  /**
   * Half one: work out which project is active and read its metadata.
   *
   * Runs **before** `initSceneStore()` and touches the `SceneStore` not at
   * all. That is the whole point. Boot has a cycle otherwise: `entries` and
   * `availablePublishedScenes` have to be in place before the `SceneStore`
   * constructor reads them, but the only pre-existing resolution function
   * (`restoreLastProject`) requires an already-attached store. Swapping the
   * two lines would either crash `attachToSceneStore` or break the Examples
   * mirroring — hence a split rather than a reorder.
   *
   * The backend is opened **read-only**: `activate()` belongs to
   * {@link hydrateProjectScenes}, so nothing can be written before the store
   * is attached.
   */
  async resolveActiveProject(opts: ResolveProjectOptions = {}): Promise<ResolvedActiveProject> {
    const bundled = opts.bundledBackend ?? this.getBundledBackend(opts.bundled);
    this._bundled = bundled;

    let backend: ProjectBackend | null = null;
    let project: RvProject | null = null;
    let dir: FileSystemDirectoryHandle | null = null;

    // A remote deploy root wins over the restored project (F12): it was named
    // explicitly for this load. Read-only throughout — the backend refuses
    // every write — so this can never touch the user's own folders. A host
    // that does not answer falls through to the normal resolution below
    // rather than failing boot.
    if (opts.remoteBaseUrl) {
      try {
        const remote = this.getRemoteBackend(opts.remoteBaseUrl);
        const manifest = await remote.readManifest();
        // `hasDeployedManifest()`, not `manifest !== null`: a base URL that
        // serves no project.json still yields the synthetic demo manifest, and
        // adopting that would turn a typo in the URL into a silently empty
        // project rather than a fall-through to the real one.
        if (manifest && remote.hasDeployedManifest()) {
          backend = remote;
          project = manifest;
        }
      } catch {
        // Unreachable, CORS-blocked or serving something that is not a project.
      }
    }

    const wanted = opts.projectId ?? readLastProjectId();
    if (!backend && wanted) {
      try {
        // `prompt: false` — a permission dialog on every reload would be its
        // own bug. A project whose grant lapsed simply falls back to bundled.
        const handle = await getFolderHandle(projectHandleKey(wanted), {
          mode: 'readwrite',
          prompt: false,
        });
        if (handle) {
          const folder = new FolderBackend(handle, {
            writable: true,
            id: `folder:${wanted}`,
            writerHost: this._writerHost(),
          });
          const manifest = await folder.readManifest();
          if (manifest) {
            backend = folder;
            project = manifest;
            dir = handle;
          }
        }
      } catch {
        // A stale handle or a refused grant is not an error here — the
        // bundled project below is always a valid answer.
      }
    }

    // The demo project as a real, writable folder whenever the workspace holds
    // it (§2.3). The bundled backend below is an HTTP fallback for a deploy —
    // adopting it while the folder sits right there in the workspace made
    // DemoRealvirtual permanently read-only: no new scene, no new asset, and a
    // user tier that `_mergeTiers` drops on the floor. Only ever runs when the
    // workspace grant is already in hand, so it cannot raise a boot prompt.
    if (!backend) {
      const demo = await this._resolveWorkspaceDemoProject();
      if (demo) {
        backend = demo.backend;
        project = demo.project;
        dir = demo.dir;
      }
    }

    if (!backend) {
      backend = bundled;
      project = await bundled.readManifest();
    }

    this._resolved = project ? { backend, project } : null;
    this._pendingDir = dir;

    const models = project?.models ?? (await backend.listModels());
    const scenes = project?.scenes ?? (await backend.listScenes());
    return {
      project,
      backend,
      models,
      scenes,
      kind: backend.kind,
    };
  }

  /**
   * The DemoRealvirtual folder inside the stored workspace, if it is there.
   *
   * Never prompts: `getWorkspaceHandle` is asked with `prompt: false`, so a
   * machine without a workspace (or with a lapsed grant) simply gets null and
   * falls through to the bundled fallback. When the grant *is* held it covers
   * every descendant, which is why the folder can be opened writable here
   * without a second dialog.
   */
  private async _resolveWorkspaceDemoProject(): Promise<
    { backend: FolderBackend; project: RvProject; dir: FileSystemDirectoryHandle } | null
  > {
    try {
      const workspace = await getWorkspaceHandle({ prompt: false });
      if (!workspace) return null;
      const dir = await workspace.getDirectoryHandle(DEMO_PROJECT_FOLDER);
      const backend = new FolderBackend(dir, {
        writable: true,
        id: `folder:${DEMO_PROJECT_ID}`,
        writerHost: this._writerHost(),
      });
      const project = await backend.readManifest();
      return project ? { backend, project, dir } : null;
    } catch {
      // No workspace, no such folder, or a refused grant — all of them mean
      // "use the fallback", none of them is worth failing boot over.
      return null;
    }
  }

  /**
   * Half two: everything that needs the `SceneStore`.
   *
   * Reconciliation, the conflict prompt, the dirty guard, lazy hydration —
   * and `activate()`, which is the first moment in the whole boot at which
   * anything may be written to disk. Call it after
   * {@link attachToSceneStore}; without a resolve first it is a no-op.
   */
  async hydrateProjectScenes(): Promise<boolean> {
    const resolved = this._resolved;
    if (!resolved) return false;
    this._warnings = [];
    this._lastConflicts = [];
    this._dir = this._pendingDir;
    this._pendingDir = null;

    await this._adoptProject(resolved.backend, resolved.project);

    if (resolved.backend.kind === 'folder' && this._dir) {
      const dir = this._dir;
      const project = resolved.project;
      try { localStorage.setItem(LS_KEY_LAST_PROJECT, project.id); } catch { /* private mode */ }
      recordRecentProject({ id: project.id, name: project.name, folderName: dir.name });
    }

    this._publish();
    return true;
  }

  // ─── Conflict reconciliation (§4c) ────────────────────────────────────

  /**
   * Decide, per scene, whether the folder or the cache wins — and apply it.
   *
   * Only scenes that are actually cached can conflict, so an unhydrated
   * project (the normal case) costs nothing here. For a cached scene the
   * manifest's `modifiedAt` is compared first; the body is read only when
   * that answer is not "equal", because from that point the body is needed
   * anyway — either to confirm a real divergence or to apply the folder
   * version.
   */
  private async _reconcileScenes(project: RvProject): Promise<void> {
    const entries = project.scenes ?? [];
    if (entries.length === 0) return;

    const conflicts: Array<{ item: SceneConflictPromptItem; entry: RvProjectSceneEntry; body: RvScene | null }> = [];

    for (const entry of entries) {
      if (!entry?.id) continue;
      // The manifest proves membership — 1:n and independent of whose body is
      // cached. Cheap: the marker only writes when something actually changes.
      noteSceneMembership(entry.id, project.id);

      const saved = readScene(entry.id);
      const draft = readSceneDraft(entry.id);
      if (!saved && !draft) continue;   // nothing cached — nothing to reconcile

      const folderModifiedAt = typeof entry.modifiedAt === 'string' ? entry.modifiedAt : null;
      const byMeta = resolveSceneConflict({
        saved,
        draft,
        folder: { modifiedAt: folderModifiedAt },
      });
      if (byMeta === 'equal' || byMeta === 'cache-wins') continue;

      const foreignFrom = isCacheFromOtherProject(entry.id, project.id)
        ? cachedFromProject(entry.id)
        : null;

      const item: SceneConflictPromptItem = {
        id: entry.id,
        name: saved?.name ?? draft?.name ?? entry.name ?? entry.id,
        folderName: typeof entry.name === 'string' ? entry.name : undefined,
        cacheModifiedAt: cacheModifiedAt(saved, draft),
        folderModifiedAt,
        hasUnsavedDraft: hasUnsavedDraft(saved, draft),
        ...(foreignFrom
          ? {
              cachedFromProjectId: foreignFrom,
              ...(projectNameOf(foreignFrom) ? { cachedFromProjectName: projectNameOf(foreignFrom)! } : {}),
            }
          : {}),
      };

      // Unsaved work always prompts (B3); the body is only fetched if the
      // user actually chooses the folder version.
      if (item.hasUnsavedDraft) {
        conflicts.push({ item, entry, body: null });
        continue;
      }

      const body = await this._readSceneBody(entry);
      if (!body) continue;   // unreadable on disk → keep the cache, warned already

      const decided: SceneConflictResolution = resolveSceneConflict({
        saved,
        draft,
        folder: { modifiedAt: folderModifiedAt, scene: body },
      });
      if (decided === 'folder-wins') this._applyFolderScene(entry.id, body, project.id);
      else if (decided === 'prompt') conflicts.push({ item, entry, body });
    }

    if (conflicts.length === 0) return;
    this._lastConflicts = conflicts.map(c => c.item);

    // Per-row default before anyone is asked (plan-373 §4):
    //  - unknown or same origin → keep the cache; silently taking the folder
    //    there is exactly the data loss §4c exists to prevent;
    //  - **demonstrably another project's body** → the folder wins. Adopting
    //    it would write that other project's content into this project's
    //    files, which is the data loss this plan exists to prevent. It
    //    outranks the B3 draft rule for foreign rows only: a draft sitting on
    //    a foreign cache is not this project's unsaved work either.
    const defaults: Record<string, SceneConflictChoice> = {};
    for (const { item } of conflicts) {
      if (item.cachedFromProjectId) defaults[item.id] = 'use-folder';
    }

    const answered = this._conflictPrompt
      ? await this._askConflictPrompt(conflicts.map(c => c.item), project)
      : {};
    const choices: Record<string, SceneConflictChoice> = { ...defaults, ...answered };

    for (const { item, entry, body } of conflicts) {
      if (choices[item.id] !== 'use-folder') {
        // Keeping the cache is a decision about *this* project: from here the
        // cached body is this project's, otherwise the hydration guard would
        // immediately undo the very choice that was just made.
        setCachedFrom(item.id, project.id);
        continue;
      }
      const scene = body ?? await this._readSceneBody(entry);
      if (!scene) continue;
      this._applyFolderScene(item.id, scene, project.id);
    }
  }

  private async _askConflictPrompt(
    items: SceneConflictPromptItem[],
    project: RvProject,
  ): Promise<Record<string, SceneConflictChoice>> {
    try {
      return (await this._conflictPrompt?.(items, project)) ?? {};
    } catch {
      // A broken dialog must not decide against the user's work.
      return {};
    }
  }

  private async _readSceneBody(entry: RvProjectSceneEntry): Promise<RvScene | null> {
    if (!this._provider || typeof entry.path !== 'string') return null;
    try {
      const scene = await this._provider.readScene(entry.path);
      if (!scene) {
        this._warnings.push(`"${entry.path}" is missing or not a valid scene.`);
        return null;
      }
      return scene;
    } catch {
      this._warnings.push(`Could not read "${entry.path}".`);
      return null;
    }
  }

  /**
   * Let the folder version win for one scene.
   *
   * The `clearSceneDraft` is not housekeeping — `openScene()` loads
   * `readSceneDraft(id) ?? scene`, so a surviving draft would put the losing
   * version straight back on top and make the resolution a lie.
   */
  private _applyFolderScene(id: string, scene: RvScene, projectId: string): void {
    writeScene({ ...scene, id });
    clearSceneDraft(id);
    // The cache now demonstrably holds this project's body — recording it is
    // what lets a later open of the *other* owner detect the divergence.
    setCachedFrom(id, projectId);
    this._sceneStore?.refreshScenesFromStorage?.();
  }

  // ─── Hydration (lazy, §4b) ────────────────────────────────────────────

  /**
   * Mirror only the metadata plus the active scene into the cache.
   *
   * Quota failures are collected and surfaced, never swallowed — the
   * underlying `writeScene()` returns the object it failed to store, so the
   * only way to notice is to read it back.
   */
  private async _seedSceneMetas(project: RvProject): Promise<void> {
    const entries = project.scenes ?? [];
    if (entries.length === 0) return;

    const activeId = typeof project.activeSceneId === 'string' ? project.activeSceneId : null;
    const target = activeId && entries.some(e => e.id === activeId) ? activeId : null;
    if (target) {
      const ok = await this.hydrateScene(target);
      if (ok) setActiveSceneId(target);
      else this._warnings.push(`Active scene ${target} could not be loaded from the folder.`);
    }
  }

  /**
   * Load one scene body from the folder into the cache. Returns true when
   * the body is available afterwards (already cached counts as success).
   *
   * The "already cached" shortcut is only valid for a body that belongs to
   * the **open** project (plan-373). One scene id legitimately lives in
   * several projects while the cache holds exactly one body, so returning
   * whatever happens to be cached served project A's scene to project B —
   * and the next save wrote it onto B's own file. A body of known foreign
   * origin therefore falls through to a real read of this project's file,
   * and a body of *unknown* origin keeps the historic shortcut.
   */
  async hydrateScene(id: string): Promise<boolean> {
    const activeProjectId = this._project?.id ?? null;
    const foreign = isCacheFromOtherProject(id, activeProjectId);
    if (readScene(id) && !foreign) {
      // Claim an unknown-origin cache for the open project: from here on the
      // question "whose body is this?" has an answer, so the *other* owner
      // will see the divergence instead of silently inheriting it.
      if (activeProjectId) setCachedFrom(id, activeProjectId);
      return true;
    }
    const entry = this._sceneEntry(id);
    // A foreign body with no readable entry is a dead end on purpose: serving
    // it would put another project's scene back in front of the user, and the
    // save path would then write it into this project's folder.
    if (!entry || !this._provider) return false;

    let scene: RvScene | null;
    try {
      scene = await this._provider.readScene(entry.path);
    } catch {
      this._warnings.push(`Could not read "${entry.path}".`);
      this._publish();
      return false;
    }
    if (!scene) {
      this._warnings.push(`"${entry.path}" is missing or not a valid scene.`);
      this._publish();
      return false;
    }

    // Keep the folder's id — a folder scene is the same scene, not a copy.
    // (Only a zip import mints a fresh id.)
    writeScene({ ...scene, id: entry.id });
    if (activeProjectId) setCachedFrom(entry.id, activeProjectId);
    if (!readScene(entry.id)) {
      this._warnings.push(
        `Browser storage is full — "${scene.name}" could not be cached. Free space and retry.`,
      );
      this._publish();
      return false;
    }
    this._sceneStore?.refreshScenesFromStorage?.();
    return true;
  }

  private _sceneEntry(id: string): RvProjectSceneEntry | undefined {
    return (this._project?.scenes ?? []).find(e => e.id === id);
  }

  // ─── Settings ─────────────────────────────────────────────────────────

  private async _applySettings(project: RvProject): Promise<void> {
    const ref = project.settingsRef?.ref;
    if (!ref) return;
    let bundle: unknown;
    try {
      bundle = await this._provider?.readSettings(ref);
    } catch {
      return;
    }
    if (!bundle || typeof bundle !== 'object') return;
    const candidate = bundle as { $schema?: unknown };
    if (candidate.$schema !== 'rv-settings-bundle/1.0') return;
    try {
      applySettingsBundle(bundle as RVSettingsBundle);
    } catch (e) {
      this._warnings.push(`Project settings could not be applied: ${String(e)}`);
    }
  }

  // ─── Writer ───────────────────────────────────────────────────────────

  /** Flush any queued folder write and wait for it. */
  async flush(): Promise<void> {
    await this._backend?.flush();
  }

  /**
   * A `setTimeout` debounce does not survive a tab close, so fire the write
   * on `pagehide` and on the hidden transition of `visibilitychange`.
   */
  private _installUnloadFlush(): void {
    if (typeof window === 'undefined' || this._unloadHandler) return;
    const handler = () => { void this._backend?.flush(); };
    const visibility = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') handler();
    };
    window.addEventListener('pagehide', handler);
    document?.addEventListener?.('visibilitychange', visibility);
    this._unloadHandler = () => {
      window.removeEventListener('pagehide', handler);
      document?.removeEventListener?.('visibilitychange', visibility);
    };
  }

  // ─── Dirty guard (§4e) ────────────────────────────────────────────────

  /** True when unsaved scene edits or an unwritten folder change exist. */
  hasUnsavedWork(): boolean {
    const snap = this._sceneStore?.getSnapshot?.();
    const sceneDirty = snap?.dirty === true;
    const status = this._writerStatus();
    return sceneDirty || status?.pending === true || status?.error != null;
  }

  /**
   * Close the project through the unsaved-changes guard.
   *
   * `closeProject()` itself stays unguarded — it is also the internal teardown
   * step of an open, where the guard has already run.
   */
  async requestCloseProject(): Promise<boolean> {
    if (!this._project) return true;
    if (await this._runDirtyGuard('close') === 'cancel') return false;
    await this.closeProject();
    return true;
  }

  private async _runDirtyGuard(reason: 'switch' | 'close'): Promise<'proceed' | 'cancel'> {
    if (!this._dirtyGuard) return 'proceed';
    if (!this.hasUnsavedWork()) return 'proceed';
    const snap = this._sceneStore?.getSnapshot?.();
    const status = this._writerStatus();
    try {
      return await this._dirtyGuard({
        reason,
        projectName: this._project?.name ?? '',
        sceneName: snap?.draft?.name ?? null,
        sceneDirty: snap?.dirty === true,
        diskPending: status?.pending === true || status?.error != null,
      });
    } catch {
      // A guard that blows up must not silently discard the user's work.
      return 'cancel';
    }
  }

  // ─── Close ────────────────────────────────────────────────────────────

  /**
   * Close the project: flush pending disk writes **first**, then drop the
   * handle and the draft scope. The cache is left intact — nothing this
   * store does destroys user data (§1.1 R2 in spirit).
   */
  async closeProject(): Promise<void> {
    if (!this._project && !this._backend) return;
    const kind = this._backend?.kind ?? null;
    // §2.2.1b — deactivation flushes and unsubscribes. It is the only way the
    // writer is torn down, so no path can leave a bus listener behind that
    // would write the next project's saves into this project's folder.
    try {
      await this._backend?.deactivate();
    } catch { /* status already carries the failure */ }
    this._backend = null;
    this._resolved = null;
    this._bundledScenes = [];

    // RR4 — an unsaved per-base draft made inside this project must not
    // resurrect in the next one. Scope goes first so the clears below hit
    // the leaving project's keys, not the global ones.
    this._clearScopedDrafts();
    setDraftScope(null);

    this._unloadHandler?.();
    this._unloadHandler = null;
    const wasFolder = kind === 'folder';
    this._project = null;
    this._dir = null;
    this._pendingDir = null;
    this._provider = null;
    this._writable = false;
    this._warnings = [];
    // Only a folder project has a pointer worth forgetting. Clearing it after
    // closing the always-present bundled project would erase the user's
    // last-opened folder — which is not open only because its grant lapsed.
    if (wasFolder) {
      try { localStorage.removeItem(LS_KEY_LAST_PROJECT); } catch { /* ignore */ }
    }
    this._publish();
  }

  /**
   * Drop the per-base drafts belonging to the project being left.
   *
   * Scoping the key already prevents project A's draft from *appearing* in
   * project B. Clearing on close additionally stops them accumulating, and
   * it is what makes the isolation observable rather than merely structural.
   */
  private _clearScopedDrafts(): void {
    // Only ever clears *scoped* keys. The bundled project has no scope (see
    // `_adoptProject`), and clearing by its id must never be allowed to reach
    // the unscoped keyspace where every pre-existing draft lives.
    if (getDraftScope() === null) return;
    const id = this._project?.id;
    if (!id) return;
    try { clearDraftsForScope(id); } catch { /* ignore */ }
  }

  // ─── Snapshot plumbing ────────────────────────────────────────────────

  /** Writer status, when the active backend has a writer at all. */
  private _writerStatus(): FolderWriterStatus | undefined {
    const backend = this._backend;
    return backend instanceof FolderBackend ? backend.getStatus() : undefined;
  }

  /**
   * Merge the tiers once per publish.
   *
   * For a bundled backend the manifest *is* the bundled tier, so the user
   * side is empty until the browser backend lands (Phase 2). For a folder
   * project there is no bundled tier: a customer's git repo holds what it
   * holds, and the shipped demos belong to Sample, not to it.
   */
  private _mergeTiers(): { scenes: TieredSceneEntry[]; ids: Set<string> } {
    const isBundled = this._backend?.kind === 'bundled';
    const user = isBundled ? [] : (this._project?.scenes ?? []);
    if (this._bundledScenes.length === 0 && user.length === 0) {
      return { scenes: NO_SCENES, ids: NO_SCENE_IDS as Set<string> };
    }
    const merged = mergeSceneTiers(this._bundledScenes, user, hiddenIdsOf(this._project));
    // Keep the previous instances when nothing actually changed. A writer
    // status tick publishes too, and a fresh `Set` on each of those would be
    // an endless "changed" signal to `useSyncExternalStore`.
    const prev = this._snapshot;
    const ids = sameIds(prev.sceneIds, merged.ids) ? prev.sceneIds : merged.ids;
    const scenes = ids === prev.sceneIds && sameEntries(prev.scenes, merged.entries)
      ? prev.scenes
      : merged.entries;
    return { scenes, ids };
  }

  /**
   * The model list, merged the same way the scenes are.
   *
   * Cheaper than {@link _mergeTiers} because nothing caches an id set off it,
   * but it keeps the same identity discipline: an unchanged list must return
   * the *previous* array, or `useSyncExternalStore` sees a change every tick.
   */
  private _mergeModelTiers(): TieredAssetEntry[] {
    const user = this._userModels;
    if (this._bundledModels.length === 0 && user.length === 0) return NO_MODELS;
    const merged = mergeAssetTiers(this._bundledModels, user, hiddenIdsOf(this._project));
    const prev = this._snapshot.models;
    return sameAssets(prev, merged.entries) ? prev : merged.entries;
  }

  /**
   * Resolve a manifest asset path to something `loadModel()` can fetch.
   *
   * A deploy URL passes through untouched; a folder project hands back a blob
   * URL for the file on disk. The `release` half of the backend's result is
   * deliberately dropped: the viewer keeps the model loaded for as long as the
   * user looks at it, and revoking on any schedule this store could know about
   * would pull the bytes out from under it.
   */
  async resolveAssetUrl(relPath: string): Promise<string | null> {
    const resolved = await this._backend?.readBlobUrl(relPath);
    return resolved?.url ?? null;
  }

  private _publish(): void {
    const status = this._writerStatus();
    const { scenes, ids } = this._mergeTiers();
    const models = this._mergeModelTiers();
    this._snapshot = {
      project: this._project,
      folderName: this._dir?.name ?? null,
      writable: this._writable,
      diskError: status?.error ?? null,
      diskPending: status?.pending ?? false,
      warnings: [...this._warnings],
      backendKind: this._backend?.kind ?? null,
      scenes,
      sceneIds: ids,
      models,
    };
    for (const l of [...this._listeners]) {
      try { l(); } catch { /* subscriber errors never break a save */ }
    }
  }
}

/**
 * Best-effort display name for a project id (plan-373).
 *
 * The ownership marker stores ids, not names — names change, ids do not. The
 * recents list is the one place that already maps the two, so it is consulted
 * for the prompt text. A project that was never opened on this machine has no
 * row there; the caller then shows the raw id, which is still more than the
 * dialog said before.
 */
function projectNameOf(projectId: string): string | undefined {
  if (!projectId) return undefined;
  const hit = readRecentProjects().find(e => e.id === projectId);
  const name = hit?.name?.trim();
  return name ? name : undefined;
}

/**
 * The one empty `Set` every snapshot without a project shares.
 *
 * Same reason as {@link ProjectSnapshot.sceneIds}: a fresh instance per
 * publish is a fresh identity, and a fresh identity is a change signal.
 */
const NO_SCENE_IDS: ReadonlySet<string> = new Set<string>();
const NO_SCENES: TieredSceneEntry[] = [];
const NO_MODELS: TieredAssetEntry[] = [];

function sameIds(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const v of b) if (!a.has(v)) return false;
  return true;
}

/** Shallow field-wise comparison — enough to spot a rename or a re-tier. */
function sameEntries(a: readonly TieredSceneEntry[], b: readonly TieredSceneEntry[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x.id !== y.id || x.name !== y.name || x.path !== y.path
      || x.tier !== y.tier || x.modifiedAt !== y.modifiedAt) return false;
  }
  return true;
}

/** Same shallow comparison for the asset list, keyed on `path`. */
function sameAssets(a: readonly TieredAssetEntry[], b: readonly TieredAssetEntry[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x.path !== y.path || x.label !== y.label || x.tier !== y.tier) return false;
  }
  return true;
}

/** The project recorded for the next boot, or null. */
function readLastProjectId(): string | null {
  try {
    return localStorage.getItem(LS_KEY_LAST_PROJECT);
  } catch {
    return null;   // private mode
  }
}

function emptySnapshot(): ProjectSnapshot {
  return {
    project: null,
    folderName: null,
    writable: false,
    diskError: null,
    diskPending: false,
    warnings: [],
    backendKind: null,
    scenes: NO_SCENES,
    sceneIds: NO_SCENE_IDS as Set<string>,
    models: NO_MODELS,
  };
}

// ─── Singleton ──────────────────────────────────────────────────────────

let _instance: ProjectStore | null = null;

/** The app-wide project store. */
export function getProjectStore(): ProjectStore {
  if (!_instance) _instance = new ProjectStore();
  return _instance;
}

/** Test helper — drop the singleton. */
export function resetProjectStore(): void {
  _instance = null;
}
