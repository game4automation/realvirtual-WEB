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
 *  - **"Folder wins" sweeps the dead per-scene draft slot.** Nothing reads it
 *    since plan-413 phase 6, but leaving a key behind after the row it belonged
 *    to was replaced is how stale state outlives its owner. See
 *    {@link ProjectStore._applyFolderScene}.
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
  setDraftScope,
  writeScene,
} from '../hmi/scene/rv-scene-storage';
import { setActiveSceneId } from '../hmi/scene/rv-scene-mutations';
import { glbSceneShell, type RvScene } from '../hmi/scene/rv-scene-types';
import { applySettingsBundle, type RVSettingsBundle } from '../hmi/rv-settings-bundle';
import {
  readSettingsFile,
  updateManifestCas,
  writeManifest,
} from './rv-project-storage';
import {
  migrateProjectScriptRefs,
  readScriptRefMigrationMarker,
} from './rv-project-refs-migration';
import { knowledgeForDocument, type RvKnowledge } from './rv-project-knowledge';
import { assertContainedRef, setDocumentRefOn } from './rv-project-refs';
import {
  CONNECT_MIGRATION_HANDOFF,
  migrateConnectRefs,
  parseConnectMigrationHandoff,
  readConnectRefMigrationMarker,
} from './rv-project-connect-ref-migration';
import { discoverDeclaredScriptRefs } from '../rv-model-plugin-manager';
import {
  adoptDiscoveredDocuments as adoptScan,
  applyAdoptDelta,
  isSidecarMigrated,
  mintReferencedAssets,
  mintableReferences,
  type AdoptLogEntry,
  type AdoptSidecarIngestion,
  type WrittenGlbReference,
} from './rv-asset-identity';
import { ingestionFromSidecar, SIDECAR_PATH } from '../library/library-sidecar-ingest';
import { parseSidecar } from '../library/library-sidecar';
import type { FolderWriterHost, FolderWriterStatus } from './rv-project-folder-writer';
import {
  BundledBackend,
  DEMO_PROJECT_FOLDER,
  DEMO_PROJECT_ID,
  DEMO_PROJECT_SLUG,
  type BundledBackendOptions,
} from './backends/bundled-backend';
import { FolderBackend } from './backends/folder-backend';
import type { ProjectBackend, ProjectReadProvider } from './backends/project-backend';
import { isSelfContainedGlb, type ProjectAssetSource } from './rv-project-asset-source';
import { revisionOfBytes, type SceneRecord } from './rv-scene-record';
import {
  hiddenIdsOf, mergeAssetTiers, mergeDocumentTiers,
  type TieredAssetEntry, type TieredDocumentEntry,
} from './rv-project-tiers';
import {
  classificationEquals,
  type DocumentClassification,
} from './rv-document-classification';
import { writeDocumentClassification } from './rv-document-classify';
import {
  classificationOfGlbBlob,
  documentKeyOf,
  documentOfSceneEntry,
  assetDocumentsOf,
  reconcileClassificationCache,
  sceneDocumentsOf,
  sectionOfDocument,
  type DocumentStat,
} from './rv-project-documents';
import { readRecentProjects, recordRecentProject } from './rv-project-recent';
import { getWorkspaceHandle } from './rv-project-workspace';
import {
  ensureWorkspaceDefaultManifest,
  isWorkspaceDefaultBackend,
  isWorkspaceDefaultProject,
  openWorkspaceDefaultBackend,
} from './rv-workspace-default';
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
  type RvDocumentEntry,
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

/**
 * Why the remembered project did not come back on this boot (plan-702 Punkt 3).
 *
 * `permission` — the stored handle exists but the readwrite grant lapsed and
 * boot never prompts (`prompt: false`); `unreadable` — the grant held but the
 * folder had no readable manifest (renamed, moved, deleted, I/O error).
 */
export interface ProjectRestoreFailure {
  projectId: string;
  /** Display name from the recents list, when this machine has one. */
  projectName?: string;
  reason: 'permission' | 'unreadable';
}

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
   * The project's own base models, tier-tagged (§2.3).
   *
   * Manifest-driven, exactly like the scene list — which is what keeps another
   * project's models out of this one. The deploy-wide `viewer.availableModels`
   * is a different thing entirely (every GLB the dev server can reach) and must
   * never be shown as if it belonged to whichever project happens to be open.
   */
  models: TieredAssetEntry[];
  /**
   * **The one list** (plan-413 §2.4) — every scene, model and library asset of
   * the open project, tier-tagged.
   *
   * It was published beside a `scenes` mirror and a `sceneIds` set while the UI
   * was moved over; both are gone with the scene catalogue (plan-716 Phase 6),
   * and this is now the only artefact list the snapshot carries.
   */
  documents: TieredDocumentEntry[];
  /**
   * Set when the last session's project could not be restored at boot and the
   * store fell back to the bundled project (plan-702 Punkt 3). Cleared by the
   * next deliberate open. Null when the restore succeeded or nothing was
   * remembered.
   */
  restoreFailure: ProjectRestoreFailure | null;
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
  /**
   * Open "My Workspace" when nothing else resolved (plan-716 §2.2 / F2).
   * Defaults to **true** — that branch is the boot default now.
   *
   * `false` restores the pre-716 resolution, in which the read-only bundled
   * demo answered "no folder project". It exists for the nets that pin the
   * BUNDLED TIER itself (project-two-tier, the bundled half of boot-order):
   * those ask what a bundled project resolves to, not what a boot with no
   * project should open, and F2 keeps the bundled demo reachable on purpose.
   * Production never passes it.
   */
  workspaceDefault?: boolean;
  /**
   * Run the eager scene→document migration inside the workspace branch
   * (plan-716 §2.3 / F3). Defaults to **true** — it is the boot behaviour.
   *
   * `false` is for the nets that pin the RESOLUTION and nothing else. The
   * migration writes, so leaving it on would make every boot-order assertion
   * about "nothing reached storage yet" depend on whether the fixture happened
   * to seed a catalogue. Production never passes it; the migration's own net
   * calls {@link runWorkspaceScenesMigration} directly.
   */
  migrateScenes?: boolean;
}

/** What boot needs before the `SceneStore` exists. */
export interface ResolvedActiveProject {
  project: RvProject | null;
  backend: ProjectBackend;
  /** Feeds `viewer.availableModels`. */
  models: RvProjectAssetEntry[];
  /**
   * Scene-section entries of the resolved project.
   *
   * It used to feed `viewer.availablePublishedScenes` — the second identity
   * space plan-731 removed. What reads it now is the ordinary document path,
   * so the comment names the data instead of a consumer that is gone.
   */
  scenes: RvProjectSceneEntry[];
  kind: 'bundled' | 'browser' | 'folder';
}

/** Minimal view of SceneStore that this store needs. Keeps the import one-way. */
export interface SceneStoreLike {
  setSceneHydrator(fn: ((id: string) => Promise<boolean>) | null): void;
  /** Used by the dirty guard to see whether the workspace has unsaved edits. */
  getSnapshot?(): { dirty?: boolean; draft?: { name?: string } | null };
  /** Used by the unload guard: edits a reload would actually destroy. */
  hasUnpersistedWork?(): boolean;
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

/** One open document with unsaved work, as the exit guard names it. */
export interface ProjectDirtyDocument {
  name: string;
  /** Position in the document stack; 0 is the root document (plan-703 §2.7.1). */
  depth: number;
}

/**
 * What the open document stack reports to the project-level exit guard.
 *
 * A **probe**, not a subscription: the guard asks once, at the moment of the
 * switch, and a stale cached answer there would be the difference between
 * losing work and not. Returning `[]` (or installing nothing) means "no open
 * document has unsaved work", which is also the correct answer for every
 * headless caller.
 *
 * plan-703 §2.7.3 is explicit that this spans the WHOLE stack and not only the
 * top frame: with N draft slots a user can be three levels deep with two of them
 * dirty, and a guard that asked about the top one would discard the other.
 */
export type ProjectDirtyDocumentsProbe = () => readonly ProjectDirtyDocument[];

/**
 * Whether any open document would lose work to a PAGE RELOAD (plan-710 F7).
 *
 * A second, deliberately separate probe rather than a flag on
 * {@link ProjectDirtyDocument}. The dirty-documents probe feeds
 * {@link ProjectStore.hasUnsavedWork} and through it the project switch/close
 * dialog, which asks a different question ("is anything unsaved") and must keep
 * answering it exactly as before. Widening that list to include documents that
 * are merely mid-write would have changed the switch dialog as a side effect of
 * fixing the unload guard — so the two questions get two probes.
 */
export type ProjectUnpersistedWorkProbe = () => boolean;

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
  /**
   * Open documents with unsaved work, bottom frame first (plan-703 §2.7.3).
   *
   * Empty on every path that has no editor open, which is why it is safe for the
   * dialog to render it unconditionally.
   */
  dirtyDocuments: readonly ProjectDirtyDocument[];
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

// ─── Adopt (plan-717 §2.2) ──────────────────────────────────────────────

/** What one adopt run did. Zeroes throughout mean "nothing to do". */
export interface AdoptRunSummary {
  adopted: number;
  moved: number;
  quarantined: number;
  restored: number;
  removed: number;
  /** Files whose bytes were hashed — the first-run cost of §2.2 step 2. */
  hashed: number;
  /** Row fields filled from `library.json`, plus the marker itself (§2.4). */
  ingested: number;
  /** True when the sidecar file was removed after a successful commit (R1-S3). */
  sidecarRemoved: boolean;
  /** True when a sidecar exists that this build cannot parse — reported, never touched. */
  sidecarUnreadable: boolean;
  durationMs: number;
}

/** Injectables the adopt verb takes from the store. Tests only. */
export interface AdoptStoreOptions {
  now?: () => number;
  quarantineMs?: number;
  log?: (entry: AdoptLogEntry) => void;
}

/** The browser backend's durable manifest half, duck-typed like `rv-document-ops` does. */
type ManifestWritingBackend = { writeManifest(project: RvProject): Promise<void> };

/** The audit trail. One line per write the adopt verb makes — never silent (§2.2). */
function defaultAdoptLog(entry: AdoptLogEntry): void {
  const where = entry.from ? `${entry.from} → ${entry.path}` : entry.path;
  const detail = entry.detail ? ` (${entry.detail})` : '';
  console.info(`[project-store] adopt ${entry.kind}: ${where}${entry.id ? ` [${entry.id}]` : ''}${detail}`);
}

/**
 * Point the scan-derived display rows at the authored rows the adopt just wrote.
 *
 * Without this the listing would keep showing the transient path-id for the
 * rest of the session, because the two halves are keyed differently: the folder
 * backend re-attaches manifest rows BY PATH before `documentsFromLists` sees
 * them (that pre-merge is the only reason an authored id survives a folder
 * listing at all), while the in-memory `_userDocuments` came from the listing
 * before the rows existed. Merging by path here is the same join, one layer up.
 *
 * The manifest row wins on every field it has — that is what "the row is the
 * truth" means — except the classification, which the scan may have read out of
 * the file just now and a freshly adopted row does not carry yet.
 */
function repointToManifestRows(
  documents: readonly RvDocumentEntry[],
  project: RvProject,
): RvDocumentEntry[] {
  const rows = new Map<string, RvDocumentEntry>();
  for (const row of project.documents ?? []) {
    if (typeof row?.path === 'string') rows.set(row.path.replace(/\\/g, '/'), row);
  }
  if (rows.size === 0) return [...documents];
  return documents.map((doc) => {
    const row = rows.get((doc.path ?? '').replace(/\\/g, '/'));
    if (!row || row === doc) return doc;
    return { ...doc, ...row, classification: row.classification ?? doc.classification };
  });
}

// ─── Project-change notifier (plan-725 §2.7) ────────────────────────────

/**
 * "Something that can bear a CONNECT configuration has just been written."
 *
 * Deliberately **argument-free**. The receiver reads the identity it needs —
 * the project id, the open document — from the same synchronous seams the hero
 * card reads them from, so this store does not have to learn what a document
 * means to CONNECT, and a second consumer can be added without changing the
 * shape of this callback.
 */
export type ProjectChangeNotifier = () => void;

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
  private _bundledModels: RvProjectAssetEntry[] = [];
  private _userModels: RvProjectAssetEntry[] = [];
  /** Backend document listing of the open project, split by tier like the models. */
  private _bundledDocuments: RvDocumentEntry[] = [];
  private _userDocuments: RvDocumentEntry[] = [];
  private _sceneStore: SceneStoreLike | null = null;
  private _warnings: string[] = [];
  private _unloadHandler: (() => void) | null = null;
  private _conflictPrompt: SceneConflictPrompt | null = null;
  private _dirtyGuard: ProjectDirtyGuard | null = null;
  /** plan-703 §2.7.3 — unsaved work in open documents, across the whole stack. */
  private _dirtyDocuments: ProjectDirtyDocumentsProbe | null = null;
  private _unpersistedDocuments: ProjectUnpersistedWorkProbe | null = null;
  private _lastConflicts: SceneConflictPromptItem[] = [];
  /** The single adopt run in flight, or null (plan-717 §2.2, R1-A2). */
  private _adoptRun: Promise<AdoptRunSummary> | null = null;
  /** Test seams for the adopt verb — clock, quarantine window, audit sink. */
  private _adoptOptions: AdoptStoreOptions = {};

  private _listeners = new Set<() => void>();
  private _snapshot: ProjectSnapshot = emptySnapshot();

  /** Boot-restore failure, until the next deliberate open (plan-702 Punkt 3). */
  private _restoreFailure: ProjectRestoreFailure | null = null;

  /** plan-725 §2.7 — who wants to know that a config-bearing write happened. */
  private _changeNotifier: ProjectChangeNotifier | null = null;

  // ─── Project-change notifier (plan-725 §2.7) ──────────────────────────

  /**
   * Register (or clear, with `null`) the one listener for config-bearing writes.
   *
   * **Dependency inversion, and it is the point of the method.** The consumer
   * today is realvirtual CONNECT, whose store is a 2000-line feature domain
   * (MQTT, S7, EtherNet/IP defaults). Importing it from here would drag that
   * whole domain into the import graph of the central data layer, for a call
   * this layer does not care about the meaning of. So the arrow points the other
   * way: the HMI layer, which already knows both halves, hands its callback in.
   *
   * One slot rather than a listener set, deliberately: this is a wiring point
   * with exactly one owner, and a set would make "who is still registered after
   * a hot reload" a question nobody can answer.
   */
  setProjectChangeNotifier(notifier: ProjectChangeNotifier | null): void {
    this._changeNotifier = notifier;
  }

  /**
   * Announce a config-bearing write that happened OUTSIDE this store.
   *
   * `ProjectsDashboardHost.handleNewConnectConfig` writes a `*.connect.json`
   * with a raw `backend.writeBlob` and never touches the manifest, and the
   * cross-source document transfer writes through its own CAS wrapper — neither
   * passes any of the paths below, so both say so here instead.
   */
  notifyProjectChanged(): void {
    this._notifyConnectAsync();
  }

  /**
   * Tell the registered listener, and let nothing about it reach the caller.
   *
   * **Fire-and-forget is a hard requirement, not a convenience (F12).** Every
   * call site is the tail of a write the user is waiting on; a gateway that is
   * offline, unauthorised, busy or simply not there must not make that write
   * slow, let alone fail. So: no `await`, no rejection escaping, and the
   * listener's own gate decides whether anything goes on the wire at all.
   */
  private _notifyConnectAsync(): void {
    const notify = this._changeNotifier;
    if (!notify) return;
    try {
      notify();
    } catch (e) {
      console.warn('[project-store] change notifier threw (ignored):', e);
    }
  }

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

  /**
   * Install the probe that reports unsaved OPEN DOCUMENTS (plan-703 §2.7.3).
   *
   * The asset editor installs it for the whole app lifetime, not per mode: the
   * question "does anything unsaved exist" is asked from a *different* surface
   * (the projects dashboard), and a probe that only existed while editor mode
   * was active would answer "no" precisely when it matters.
   */
  setDirtyDocumentsProbe(probe: ProjectDirtyDocumentsProbe | null): void {
    this._dirtyDocuments = probe;
  }

  /**
   * Install the probe that reports open documents with an ARMED draft write
   * (plan-710 F7). Installed alongside the dirty probe, for the same lifetime
   * and the same reason — see {@link setDirtyDocumentsProbe}.
   */
  setUnpersistedWorkProbe(probe: ProjectUnpersistedWorkProbe | null): void {
    this._unpersistedDocuments = probe;
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
    // "Already open" must mean OPEN AND PUBLISHED. A half-adopted state
    // (backend set, adoption aborted before publish) used to satisfy the bare
    // identity check, so every click reported success and rendered nothing.
    // Re-publishing here is what heals that state instead of preserving it.
    if (this._backend === backend && this._project) {
      this._publish();
      return true;
    }
    if (this._backend && await this._runDirtyGuard('switch') === 'cancel') return false;
    const leaving = this._project?.name ?? null;
    const narrate = await this._switchNarrator();
    try {
      if (this._backend) {
        if (leaving) await narrate.say(`Closing ${leaving}…`);
        await this.closeProject();
      }
      const project = await backend.readManifest();
      if (!project) return false;
      await narrate.say(`Opening ${project.name}…`);
      await this._adoptProject(backend, project);
      // A deliberate open answers the boot-restore failure, whichever project
      // the user chose (plan-702 Punkt 3).
      this._restoreFailure = null;
      this._publish();
      return true;
    } finally {
      narrate.done();
    }
  }

  /**
   * Open the implicit browser project "My Workspace" (plan-726 follow-up).
   *
   * The workspace stopped being the projectless boot answer the moment the
   * deploy root carries a manifest — but the documents the eager `scn_`
   * migration converted still live in it, and so does everything a visitor
   * saved before the root manifest arrived. This is the verb the
   * cross-project hop in `SceneStore.openScene` uses to reach them. Same
   * shape as `openDemoProject`, and the dirty guard applies for the same
   * reason: the hop must not be the thing that silently drops unsaved work.
   */
  async openWorkspaceProject(): Promise<boolean> {
    if (this._backend && this._project && isWorkspaceDefaultProject(this._project)) {
      this._publish();
      return true;
    }
    if (this._backend && await this._runDirtyGuard('switch') === 'cancel') return false;
    const leaving = this._project?.name ?? null;
    const narrate = await this._switchNarrator();
    try {
      if (this._backend) {
        if (leaving) await narrate.say(`Closing ${leaving}…`);
        await this.closeProject();
      }
      const backend = openWorkspaceDefaultBackend();
      const project = await backend.readManifest();
      if (!project) return false;
      await narrate.say(`Opening ${project.name}…`);
      await this._adoptProject(backend, project);
      this._restoreFailure = null;
      this._publish();
      return true;
    } finally {
      narrate.done();
    }
  }

  /**
   * Narrate a project switch while it runs.
   *
   * A switch is two long steps with a blank screen between them, and they are
   * not the same step: the close flushes the leaving project's writes, the open
   * reads the arriving folder. Naming each beat is what turns one unexplained
   * freeze into progress the user can read — and it is why this lives here
   * rather than in the switcher UI, for the same reason the dirty guard does:
   * every open path gets it, and no caller can route around it.
   *
   * The overlay module is imported lazily so that React/MUI stay out of the
   * project store's module graph (the pattern the workspace migration below
   * already uses). A failed import is silence, never a failed open — the
   * narration is a courtesy, not a step of the switch.
   */
  private async _switchNarrator(): Promise<{
    say: (message: string) => Promise<void>;
    done: () => void;
  }> {
    // __RV_EMBED__ short-circuit: the overlay is a React/@mui surface and must
    // not reach the embed library build (plan-326 AP1). The null path below is
    // the existing failure path, so the embed simply narrates nothing.
    const overlay = __RV_EMBED__
      ? null
      : await import('../hmi/info-overlay-store').catch(() => null);
    if (!overlay) return { say: async () => {}, done: () => {} };
    return {
      // Two frames before returning: the caller's next step is a long
      // main-thread block, so a message that has not painted yet would only
      // appear once the thing it describes is already over.
      say: async (message: string) => {
        overlay.showInfoOverlay(message);
        await new Promise<void>(resolve => requestAnimationFrame(
          () => requestAnimationFrame(() => resolve())));
      },
      done: () => overlay.hideInfoOverlay(),
    };
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

    // ── readwrite upgrade; refusal degrades to read-only, never to a throw ──
    //
    // FIRST, and before anything that awaits. `requestPermission()` needs the
    // transient user activation of the click that got us here, and every await
    // in front of it spends part of that window — the module import and the
    // paint waits of the narration below included. Asking here also puts the
    // question in the right order: we do not tear down the open project until
    // we know the arriving one can be written to.
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

    // The narration starts only after the dirty guard and the permission
    // prompt: both are real modal questions, and an overlay behind either
    // would announce a switch the user may still be about to cancel.
    const leaving = this._project?.name ?? null;
    const narrate = await this._switchNarrator();
    try {
      if (leaving) await narrate.say(`Closing ${leaving}…`);
      await this.closeProject();
      // The folder name, until the manifest supplies the real one below.
      await narrate.say(`Opening ${dir.name}…`);
      this._warnings = [];
      this._lastConflicts = [];
      // Pushed here rather than where `writable` is decided: `_warnings` is
      // reset just above, so an earlier push would be wiped.
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

      if (project.name && project.name !== dir.name) {
        await narrate.say(`Opening ${project.name}…`);
      }

      this._dir = dir;
      await this._adoptProject(backend, project);
      // A deliberate open answers the boot-restore failure (plan-702 Punkt 3).
      this._restoreFailure = null;
      try { localStorage.setItem(LS_KEY_LAST_PROJECT, project.id); } catch { /* private mode */ }
      try { await putHandle(dir, projectHandleKey(project.id)); } catch { /* non-fatal */ }
      // Recents are recorded AFTER the handle is stored: a display row without a
      // reopenable handle would be a menu entry that does nothing (§4.5).
      recordRecentProject({ id: project.id, name: project.name, folderName: dir.name });

      this._publish();
      return true;
    } finally {
      narrate.done();
    }
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
    // Both halves come from the BACKEND, not from the manifest field: a folder
    // project enumerates its models/ folder (every GLB in it belongs to the
    // project), while the read-only HTTP project has only what the manifest
    // declares. Reading project.models here would have re-imposed the
    // manifest-only rule on folders through the back door.
    const backendModels = await backend.listModels();
    const isBundledBackend = backend.kind === 'bundled';
    this._bundledModels = isBundledBackend ? backendModels : [];
    this._userModels = isBundledBackend ? [] : backendModels;

    // The one list, split by the same tier rule and reconciled against the
    // files before anybody sees it (§2.5). Failure is non-fatal by design: an
    // out-of-date classification cache is a display detail, and letting it take
    // a project open down would be the worst possible trade.
    const documents = await backend.listDocuments().catch(() => []);
    const scanned = await this._scanClassifications(backend, documents);
    this._bundledDocuments = isBundledBackend ? scanned : [];
    this._userDocuments = isBundledBackend ? [] : scanned;

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
    //
    // "My Workspace" inherits that exception verbatim (plan-716 §2.2, Risiko 4).
    // It is now the project adopted on every boot without a folder — the exact
    // role the comment above describes — so the unscoped keyspace is ITS
    // keyspace. Scoping it to `workspace-default:<baseKey>` would hide every
    // pre-716 draft and then have `closeProject()` clear them away, which is the
    // draft loss the plan forbids. The scoped/unscoped rename of the draft slots
    // is Phase 2's job (§2.3e), not a side effect of wiring the project up.
    const unscoped = backend.kind === 'bundled' || isWorkspaceDefaultBackend(backend);
    setDraftScope(unscoped ? null : project.id);

    await this._reconcileScenes(project);
    await this._seedSceneMetas(project);
    await this._applySettings(project);

    await backend.activate();
    // The one write that "creates" My Workspace, and the first legal moment for
    // it: `writeManifest()` refuses on an inactive backend. Idempotent on the
    // fixed key, so a second boot writes nothing (Risiko 7).
    await ensureWorkspaceDefaultManifest(backend, project);
    if (backend instanceof FolderBackend) backend.onStatus(() => this._publish());
    this._installUnloadFlush();

    // plan-717 §2.2 — the adopt verb, at the END of the open and never before
    // `activate()`: the folder writer does not exist until then, and the adopt
    // works on `this._project`, which the steps above may have replaced. Every
    // caller of this method publishes right after it, so the run defers its own
    // publish and the whole open stays at one (R1-A3b).
    await this._adoptQuietly();
    // plan-718 §2.7 — AFTER adopt, and it has to be: the migration binds
    // document ROWS, and on a folder project the rows for `models/**` do not
    // exist until the adopt run has created them.
    await this._migrateScriptRefsQuietly();
    await this._adoptConnectHandoffQuietly();
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
        // Both halves, still. Since plan-735 they say the same thing — a base
        // URL that serves no `project.json` yields `null` now, where it used to
        // yield the synthetic demo manifest — so this is belt-and-braces rather
        // than the load-bearing distinction it once was. Kept as it is because
        // `hasDeployedManifest()` is the SENTENCE ("this host published a
        // project") and `manifest` is the value, and a caller pointing at
        // someone else's URL should read the sentence.
        if (manifest && remote.hasDeployedManifest()) {
          backend = remote;
          project = manifest;
        }
      } catch {
        // Unreachable, CORS-blocked or serving something that is not a project.
      }
    }

    const wanted = opts.projectId ?? readLastProjectId();

    // ── `?project=<slug>` naming the bundled demo (plan-726 F7) ───────────
    //
    // `opts.projectId` carries whatever `?project=` said, and the only thing
    // this function ever did with it was look for a FOLDER HANDLE under that
    // key. The bundled demo has no folder handle and never will, so
    // `?project=demorealvirtual` — the canonical name the backend has exported
    // as `DEMO_PROJECT_SLUG` all along — resolved to nothing and fell through
    // to whatever the last session had open.
    //
    // Matched against the id as well as the slug because both spellings are in
    // circulation: `prj_sample` is what `localStorage` and the recents list
    // hold, `demorealvirtual` is what a person would type or share. Only ever
    // when it was named EXPLICITLY (`opts.projectId`), never from
    // `readLastProjectId()` — a restored session must keep going through the
    // normal resolution so a folder project stays a folder project.
    if (!backend && opts.projectId) {
      const named = opts.projectId.trim().toLowerCase();
      if (named === DEMO_PROJECT_SLUG || named === DEMO_PROJECT_ID.toLowerCase()) {
        const manifest = await bundled.readManifest();
        if (manifest) {
          backend = bundled;
          project = manifest;
        }
      }
    }

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
          } else {
            // Grant held, folder answered, but no readable manifest — renamed,
            // moved, deleted or an I/O error. Record it so boot can say so
            // instead of silently landing in the bundled project (plan-702).
            this._restoreFailure = {
              projectId: wanted,
              projectName: projectNameOf(wanted),
              reason: 'unreadable',
            };
          }
        } else {
          // No handle without a prompt — the grant lapsed. The fallback below
          // is still the right boot answer; the record makes it visible.
          this._restoreFailure = {
            projectId: wanted,
            projectName: projectNameOf(wanted),
            reason: 'permission',
          };
        }
      } catch {
        // A stale handle or a refused grant is not an error here — the
        // bundled project below is always a valid answer. But it IS a failed
        // restore, and the user gets told rather than a console reader.
        this._restoreFailure = {
          projectId: wanted,
          projectName: projectNameOf(wanted),
          reason: 'unreadable',
        };
      }
    }

    // The demo project as a real, writable folder whenever the workspace holds
    // it (§2.3). The bundled backend below is an HTTP fallback for a deploy —
    // adopting it while the folder sits right there in the workspace made
    // DemoRealvirtual permanently read-only: no new scene, no new asset, and a
    // user tier that `_mergeTiers` drops on the floor. Only ever runs when the
    // workspace grant is already in hand, so it cannot raise a boot prompt.
    // Asked ONCE, here, and reused by both branches below. `readManifest()` is
    // memoised, so this is the same single fetch the fallback would have made.
    // Guarded since plan-735 3d (R6). Before it, a `null` from here was
    // impossible and a THROW from here was survivable only by luck: the
    // `remoteBaseUrl` branch above has always had its own try/catch, this one
    // never did, and `_fetchJson()` swallows the ordinary failures — so the
    // residual throws (a `file://` page whose `fetch` rejects synchronously, a
    // hostile `fetch` polyfill) went straight past `resolveActiveProject()` and
    // took the whole boot with them. Now that a missing manifest is a NORMAL,
    // reported outcome rather than an impossible one, the throw beside it has
    // to be normal too: no project resolved, fall through to the resolution
    // below exactly as a 404 does.
    let deployedManifest: RvProject | null = null;
    try {
      deployedManifest = await bundled.readManifest();
    } catch (e) {
      console.warn('[project] The deploy root could not be read for a project manifest:', e);
    }
    const hasDeployedManifest = bundled.hasDeployedManifest();

    if (!backend) {
      // ── The workspace-folder collision guard (plan-726 F9) ────────────
      //
      // `_resolveWorkspaceDemoProject()` looks for a folder literally named
      // `demo-realvirtual` in the user's workspace, and that name is not
      // exotic: it is the folder name this repository uses for the demo
      // project under `WebViewer-Private~/projects/`. A developer who points
      // "My Workspace" at that checkout gets a WRITABLE FolderBackend for
      // `prj_sample` — which silently defeats the read-only contract the demo
      // is supposed to have (F9), and does it with whatever half-finished
      // manifest happens to sit in that folder.
      //
      // The guard is narrow on purpose: it only fires when the deploy itself
      // publishes a `project.json`. In that case the deploy has SAID what the
      // demo is, and a same-named local folder cannot outrank it. Without a
      // root manifest nothing has said anything, and the pre-726 behaviour —
      // the workspace folder wins, so DemoRealvirtual is editable in a
      // checkout — is preserved exactly.
      if (hasDeployedManifest) {
        const collides = await this._workspaceDemoFolderExists();
        if (collides) {
          console.warn(
            '[project] A workspace folder named "'
            + `${DEMO_PROJECT_FOLDER}" was found, but this deploy publishes its own `
            + 'project.json — opening the read-only deployed demo project instead.',
          );
        }
      } else {
        const demo = await this._resolveWorkspaceDemoProject();
        if (demo) {
          backend = demo.backend;
          project = demo.project;
          dir = demo.dir;
        }
      }
    }

    // A deploy that publishes its own `project.json` keeps winning over the
    // implicit workspace below (plan-716 §2.2). Hoisted above the new branch
    // rather than folded into it: a delivered Bunny/CONNECT build IS a project,
    // named by whoever published it, and answering that visitor with an empty
    // local "My Workspace" would hide the very thing they opened. Behaviour for
    // such a root is unchanged — it resolved to `bundled` before too, just from
    // the fallback below. `readManifest()` is memoised, so asking here costs the
    // one fetch the fallback would have made anyway.
    // ── The eager scn_→document migration, unhooked from one branch (F14) ──
    //
    // It used to live INSIDE the "My Workspace" branch below, which was
    // correct only as long as that branch was the boot default. A deploy that
    // publishes its own `project.json` — which, since plan-726, is every
    // public demo and every dev checkout — resolves at the branch below this
    // one and never reaches the workspace branch at all. The migration would
    // then be skipped on EVERY boot, permanently, and not only in
    // `e2e/scene-link-migration.spec.ts`: any developer profile still holding
    // `scn_…` catalogue rows would simply stop seeing those scenes.
    //
    // So it runs here, before the resolution continues, independent of which
    // branch wins. It costs a profile with nothing to convert two `getItem`s
    // (its own early-out), it opens and closes its OWN backend instance for
    // the workspace project, and it therefore keeps this function's promise
    // that the backend it HANDS BACK was never activated.
    if (opts.workspaceDefault !== false && opts.migrateScenes !== false) {
      await this._migrateWorkspaceScenes();
    }

    if (!backend) {
      if (deployedManifest && hasDeployedManifest) {
        backend = bundled;
        project = deployedManifest;
      }
    }

    // "My Workspace" — the writable home every document has (plan-716 F2/§2.2).
    //
    // Before the bundled fallback and after every explicit project, so the
    // read-only demo stops being the answer to "no folder project" and becomes
    // what it is: a source, opened on purpose (`?scene=builtin:`, `openBuiltin`,
    // the demo entry in the dashboard — all unchanged).
    //
    // The fixed id is the entire duplicate guard (Risiko 7): opening is the only
    // operation, and it always addresses the same project. Nothing is written
    // here — the manifest row is a marker written later from `_adoptProject()`,
    // because this function's contract is that it opens the backend read-only.
    //
    // ── Phase 2 (§2.3) DOCKED HERE ─────────────────────────────────────────
    // The eager scene→document migration runs AWAITED at this point, inside
    // this branch and before the resolve returns: `main.ts` already awaits
    // `resolveActiveProject()`, which puts the migration structurally before
    // `initSceneStore()` and before the `?scene=` routing that needs the alias
    // map. Do not move it into `hydrateProjectScenes()` — that runs after both.
    //
    // The migration WRITES, and this function promises it does not
    // (boot-order.test.ts: `resolved.backend.isActive === false`). Both stay
    // true because the migration opens and activates its OWN backend instance
    // for the workspace project and deactivates it again — `BrowserBackend`
    // keys every byte off the project id, so a second instance addresses
    // exactly the same storage while the instance handed back from here is
    // never touched. The manifest is read AFTER the migration, so the returned
    // project already lists the converted documents.
    if (!backend && opts.workspaceDefault !== false) {
      try {
        const workspace = openWorkspaceDefaultBackend();
        // The migration itself moved ABOVE this branch (plan-726 F14) — it has
        // to run whichever branch wins. The ordering guarantee it needed is
        // unchanged: it is still awaited inside `resolveActiveProject()`, i.e.
        // structurally before `initSceneStore()` and before the `?scene=`
        // routing that needs the alias map.
        const manifest = await workspace.readManifest();
        if (manifest) {
          backend = workspace;
          project = manifest;
        }
      } catch (e) {
        // Storage disabled (private mode, a hostile embedder) — the bundled
        // fallback below is still a valid answer, and boot must not die here.
        console.warn('[project] My Workspace unavailable, falling back:', e);
      }
    }

    if (!backend) {
      backend = bundled;
      project = deployedManifest;
    }

    this._resolved = project ? { backend, project } : null;
    this._pendingDir = dir;

    // The manifest first, the folder scan second — same order the pre-413 code
    // had. A discovered folder whose `models/` has not been scanned yet still
    // has to show what its manifest declares.
    const declaredModels = assetDocumentsOf(project, 'models');
    const models = declaredModels.length > 0 ? declaredModels : await backend.listModels();
    const scenes = sceneDocumentsOf(project);
    return {
      project,
      backend,
      models,
      scenes,
      kind: backend.kind,
    };
  }

  /**
   * Run the eager scene→document migration, reporting progress on the existing
   * info overlay (plan-716 §2.3, Risiko 10).
   *
   * Lazily imported so a boot that resolves a folder project never pulls the
   * migration — or the overlay — into its critical path. Never throws: the
   * migration already swallows its own failures, and this wrapper adds the
   * overlay's teardown to the same guarantee.
   */
  private async _migrateWorkspaceScenes(): Promise<void> {
    // Same __RV_EMBED__ gate as _switchNarrator: no React/@mui edge into the
    // embed build. The migration itself runs unchanged; only its progress
    // overlay is absent there.
    const [{ runWorkspaceScenesMigration }, overlay] = await Promise.all([
      import('./rv-workspace-migration'),
      __RV_EMBED__ ? Promise.resolve(null) : import('../hmi/info-overlay-store'),
    ]);
    // The overlay is driven by `onProgress`, which fires only when there is a
    // row to convert. A profile with no catalogue — every boot after the first
    // — therefore shows nothing at all, rather than flashing a box for the two
    // `getItem`s the migration costs it.
    let shown = false;
    try {
      const result = await runWorkspaceScenesMigration({
        onProgress: (done, total) => {
          shown = true;
          overlay?.showInfoOverlay(`Converting ${done} of ${total}…`);
        },
      });
      if (result.skipped.some(s => s.reason === 'alias-failed' || s.reason === 'write-failed')) {
        console.warn('[project] some scenes could not be converted:', result.skipped);
      }
    } finally {
      if (shown) overlay?.hideInfoOverlay();
    }
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
  /**
   * Is there a `demo-realvirtual` folder in the stored workspace? (plan-726 F9)
   *
   * Read-only reconnaissance for the collision guard: it answers the question
   * WITHOUT constructing a writable `FolderBackend`, which is the whole point —
   * the guard exists so that folder never becomes the active backend when the
   * deploy publishes its own manifest. Never prompts, and a missing workspace,
   * a lapsed grant or no such folder are all a plain `false`.
   */
  private async _workspaceDemoFolderExists(): Promise<boolean> {
    try {
      const workspace = await getWorkspaceHandle({ prompt: false });
      if (!workspace) return false;
      await workspace.getDirectoryHandle(DEMO_PROJECT_FOLDER);
      return true;
    } catch {
      return false;
    }
  }

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

    // Publish whatever was adopted even when a later step throws. Before this
    // guard, a throw out of `_adoptProject` left `_backend`/`_project` set but
    // NEVER published — the dashboard then rendered "no project" while
    // `openDemoProject()`'s identity shortcut kept answering "already open",
    // a permanently wedged first screen with no visible error.
    try {
      await this._adoptProject(resolved.backend, resolved.project);
    } finally {
      this._publish();
    }

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
  /**
   * `readScene`, but a cached record this build can no longer parse reads as
   * ABSENT instead of throwing.
   *
   * One legacy record used to abort the whole adoption: `readScene` throws
   * `LegacyFormatError`, `_reconcileScenes` let it out, and `main.ts` answered
   * with "Project restore skipped" — the user's project did not open because
   * of one stale CACHE row, with an error telling them to install the previous
   * release. The cache is never authoritative (the project file is), so the
   * only honest reading of an unreadable cache row is "nothing cached": the
   * reconcile skips it, and a hydrate falls through to the folder read, which
   * overwrites the row in the current format — the cache heals itself.
   */
  private _readCachedScene(id: string, label?: string): RvScene | null {
    try {
      return readScene(id);
    } catch (e) {
      this._warnings.push(
        `The cached copy of "${label ?? id}" is in an old format and was ignored — the project file stays authoritative.`,
      );
      console.warn('[project] legacy cached scene ignored:', id, e);
      return null;
    }
  }

  private async _reconcileScenes(project: RvProject): Promise<void> {
    const entries = sceneDocumentsOf(project);
    if (entries.length === 0) return;

    const conflicts: Array<{
      item: SceneConflictPromptItem;
      entry: RvProjectSceneEntry;
      body: { scene: RvScene; revision: string } | null;
    }> = [];

    for (const entry of entries) {
      if (!entry?.id) continue;
      // The manifest proves membership — 1:n and independent of whose body is
      // cached. Cheap: the marker only writes when something actually changes.
      noteSceneMembership(entry.id, project.id);

      const saved = this._readCachedScene(
        entry.id,
        typeof entry.name === 'string' ? entry.name : undefined,
      );
      if (!saved) continue;   // nothing cached (or nothing readable) — nothing to reconcile

      const folderModifiedAt = typeof entry.modifiedAt === 'string' ? entry.modifiedAt : null;
      const folderRevision = typeof entry.revision === 'string' ? entry.revision : null;
      // `draft: null` throughout: the op-log draft slot is gone (plan-413
      // phase 6), an autosave has been a GLB body since plan-397, and the
      // conflict question is now about the saved catalogue row alone.
      const byMeta = resolveSceneConflict({
        saved,
        draft: null,
        folder: { modifiedAt: folderModifiedAt, revision: folderRevision },
      });
      if (byMeta === 'equal' || byMeta === 'cache-wins') continue;

      const foreignFrom = isCacheFromOtherProject(entry.id, project.id)
        ? cachedFromProject(entry.id)
        : null;

      const item: SceneConflictPromptItem = {
        id: entry.id,
        name: saved.name || entry.name || entry.id,
        folderName: typeof entry.name === 'string' ? entry.name : undefined,
        cacheModifiedAt: cacheModifiedAt(saved, null),
        folderModifiedAt,
        hasUnsavedDraft: hasUnsavedDraft(saved, null),
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
        draft: null,
        folder: { modifiedAt: folderModifiedAt, revision: folderRevision ?? body.revision, scene: body.scene },
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
      const chosen = body ?? await this._readSceneBody(entry);
      if (!chosen) continue;
      this._applyFolderScene(item.id, chosen, project.id);
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

  /**
   * Read one scene body as an `RvScene`.
   *
   * ## Why a GLB body can be an `RvScene` after all
   *
   * Phase 5 left this branch as a deliberate dead end, because everything
   * downstream (hydration into `rv-scenes/<id>`, the draft machinery,
   * conflict resolution via `scenesEqual`/`modifiedAt`) is written against
   * `RvScene` and cannot be handed bytes — and half-converting that chain
   * would have lost the six categories the op log never carried.
   *
   * Phase 6 resolves it without converting the chain at all. A baked scene
   * **is** a base plus an empty op log, which is an `RvScene` in good
   * standing — its base simply names the scene id rather than a URL
   * ({@link glbSceneShell}). Every consumer below keeps working unchanged;
   * only `SceneStore` has to know that such a base needs resolving to bytes
   * before it can be loaded, and it is the one component that already talks
   * to the storage layer.
   *
   * There is no second branch any more: a record is bytes (plan-413 phase 6),
   * and a stored JSON body is refused by the backend with the F10 error rather
   * than handed back here as something to convert.
   */
  private async _readSceneBody(
    entry: RvProjectSceneEntry,
  ): Promise<{ scene: RvScene; revision: string } | null> {
    if (!this._provider || typeof entry.path !== 'string') return null;
    let record: SceneRecord | null;
    try {
      record = await this._provider.readScene(entry.path);
    } catch {
      this._warnings.push(`Could not read "${entry.path}".`);
      return null;
    }
    if (!record) {
      this._warnings.push(`"${entry.path}" is missing or not a valid scene.`);
      return null;
    }
    // The body itself is not cached here — only the shell that points at it.
    // Putting megabytes of GLB into localStorage is what plan-397 phase 6 exists
    // to stop; the bytes stay in the project folder / OPFS and are fetched at
    // load time through `rv-scene-glb-io`. The revision travels with the shell so
    // the caller can record what the cache was filled from — without it, every
    // later write would have to be unconditional and §2.8's compare-and-swap
    // would never have a baseline.
    return {
      scene: glbSceneShell({
        id: entry.id,
        name: entry.name || entry.id,
        revision: record.revision,
        createdAt: typeof entry.createdAt === 'string' ? entry.createdAt : undefined,
        modifiedAt: typeof entry.modifiedAt === 'string' ? entry.modifiedAt : undefined,
      }),
      revision: record.revision,
    };
  }

  /**
   * Let the folder version win for one scene.
   *
   * The `clearSceneDraft` is belt and braces since the draft reader went: it
   * removes a slot nothing consults any more, so a later build cannot resurrect
   * the losing version out of it.
   */
  private _applyFolderScene(
    id: string,
    body: { scene: RvScene; revision: string },
    projectId: string,
  ): void {
    writeScene({ ...body.scene, id });
    clearSceneDraft(id);
    // The cache now demonstrably holds this project's body — recording it is
    // what lets a later open of the *other* owner detect the divergence. The
    // revision goes with it: it is what the next write compares against.
    setCachedFrom(id, projectId, body.revision);
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
    const entries = sceneDocumentsOf(project);
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
    // Tolerant read: a legacy-format cache row counts as "not cached", so the
    // hydrate falls through to the folder read below and `writeScene`
    // replaces the row in the current format.
    if (this._readCachedScene(id) && !foreign) {
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

    // One reader, one set of warnings — see `_readSceneBody` for why a GLB
    // body stops here instead of being half-converted into an op-log record.
    const body = await this._readSceneBody(entry);
    if (!body) {
      this._publish();
      return false;
    }
    const scene = body.scene;

    // Keep the folder's id — a folder scene is the same scene, not a copy.
    // (Only a zip import mints a fresh id.)
    writeScene({ ...scene, id: entry.id });
    if (activeProjectId) setCachedFrom(entry.id, activeProjectId, body.revision);
    if (!readScene(entry.id)) {
      this._warnings.push(
        `Browser storage is full — "${scene.name}" could not be cached. Free space and retry.`,
      );
      this._publish();
      return false;
    }
    return true;
  }

  private _sceneEntry(id: string): RvProjectSceneEntry | undefined {
    return sceneDocumentsOf(this._project).find(e => e.id === id);
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

  // ─── Knowledge ────────────────────────────────────────────────────────

  /**
   * The knowledge file bound to a document through `knowledgeRef`, or null
   * (plan-718 stage 3.1).
   *
   * Deliberately a pull, not an `_applyKnowledge` that runs on open: knowledge
   * is per DOCUMENT and only matters once one is shown, while settings are
   * project-wide and have to be in place before anything renders. Reading every
   * document's file on open would be work for documents nobody opens.
   *
   * Warnings land in the store's own list, so a dead reference surfaces where
   * every other project complaint already does.
   */
  async readKnowledge(documentId: string): Promise<RvKnowledge | null> {
    const knowledge = await knowledgeForDocument(
      this._project, documentId, this._provider, message => this._warnings.push(message),
    );
    this._publish();
    return knowledge;
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

  /**
   * True when unsaved scene edits, an unwritten folder change, or an unsaved
   * OPEN DOCUMENT exist.
   *
   * The third term is plan-703 §2.7.3, and it closes a hole that predates the
   * stack: `main.ts`'s own `hasUnsavedWork()` has always counted the open asset
   * document, but the project switch never did — so switching projects with a
   * dirty editor open asked nothing and discarded it. The probe reports every
   * frame, so the same call answers correctly once a stack of N is open.
   */
  hasUnsavedWork(): boolean {
    const snap = this._sceneStore?.getSnapshot?.();
    const sceneDirty = snap?.dirty === true;
    const status = this._writerStatus();
    return sceneDirty
      || status?.pending === true
      || status?.error != null
      || this._readDirtyDocuments().length > 0;
  }

  /**
   * True when leaving the PAGE would destroy work — the unload guard's question,
   * and deliberately not the same one as {@link hasUnsavedWork}.
   *
   * The two differ because a save is not the only thing that keeps work alive.
   * A normal workspace is `dirty` for most of its life and loses nothing to an
   * F5, because the body autosave already wrote it; warning there would be the
   * dialog everyone learns to dismiss. What survives nothing is a transient
   * workspace (a shared link, an Example — never autosaved by design) and a
   * write still sitting on the debounce timer. Open documents count too: the
   * editor's own `beforeunload` used to ask this for itself, in editor mode
   * only, which left every other mode unguarded.
   *
   * The last term is plan-710 F7 and closes the same asymmetry one level down:
   * an open document's DRAFT TIMER is unpersisted work by exactly the argument
   * that made the scene's timer count, and until now only the scene's did. It
   * is asked in every mode, so an asset document left mid-write behind the
   * planner or the HMI is covered too.
   */
  hasUnpersistedWork(): boolean {
    const status = this._writerStatus();
    return this._sceneStore?.hasUnpersistedWork?.() === true
      || status?.pending === true
      || status?.error != null
      || this._readDirtyDocuments().length > 0
      || this._readUnpersistedDocuments();
  }

  /** The probe's answer, never throwing — a broken probe must not block a switch. */
  private _readDirtyDocuments(): readonly ProjectDirtyDocument[] {
    try {
      return this._dirtyDocuments?.() ?? [];
    } catch (e) {
      console.warn('[project-store] dirty-documents probe failed:', e);
      return [];
    }
  }

  /**
   * Same contract as {@link _readDirtyDocuments}, opposite default: a probe that
   * throws answers "nothing outstanding" rather than blocking the page, because
   * a beforeunload dialog nobody can explain is worse than the missed warning.
   */
  private _readUnpersistedDocuments(): boolean {
    try {
      return this._unpersistedDocuments?.() === true;
    } catch (e) {
      console.warn('[project-store] unpersisted-work probe failed:', e);
      return false;
    }
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
        dirtyDocuments: this._readDirtyDocuments(),
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
    this._bundledDocuments = [];
    this._userDocuments = [];

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
   * The model list, merged from the two tiers once per publish.
   *
   * Identity discipline: an unchanged list must come back as the *previous*
   * array, or `useSyncExternalStore` sees a change every writer-status tick.
   */
  private _mergeModelTiers(): TieredAssetEntry[] {
    const user = this._userModels;
    if (this._bundledModels.length === 0 && user.length === 0) return NO_MODELS;
    const merged = mergeAssetTiers(this._bundledModels, user, hiddenIdsOf(this._project));
    const prev = this._snapshot.models;
    return sameAssets(prev, merged.entries) ? prev : merged.entries;
  }

  /**
   * The document list, merged the same way the scenes and the models are.
   *
   * Same identity discipline for the same `useSyncExternalStore` reason: an
   * unchanged list has to come back as the *previous* array, or every writer
   * status tick reads as a change.
   */
  /**
   * Re-run the open backend's document scan and republish.
   *
   * `listDocuments()` deliberately runs once at open — a folder scan must not
   * hide behind every publish. But an EXPLICIT create ("New asset" writes a
   * blob straight into `library/`) puts a file on disk that no manifest row
   * announces, and without a rescan its card would not exist until the project
   * is reopened. One scan per user action is exactly the right price.
   *
   * Since plan-717 the scan is followed by the adopt verb, which is what turns
   * that file into a row instead of a card that disappears again on the next
   * listing. The scan itself still writes nothing — see
   * {@link ProjectStore.adoptDiscoveredDocuments} and rv-asset-identity rule 1.
   * Both halves publish once, together, at the end.
   */
  async rescanDocuments(): Promise<void> {
    const backend = this._backend;
    if (!backend || backend.kind === 'bundled') return;
    const documents = await backend.listDocuments().catch(() => null);
    if (!documents) return;
    this._userDocuments = await this._scanClassifications(backend, documents);
    await this._adoptQuietly();
    this._publish();
  }

  private _mergeDocumentTiers(): TieredDocumentEntry[] {
    const user = this._liveUserDocuments();
    if (this._bundledDocuments.length === 0 && user.length === 0) return NO_DOCUMENTS;
    const merged = mergeDocumentTiers(this._bundledDocuments, user, hiddenIdsOf(this._project));
    const prev = this._snapshot.documents;
    return sameDocuments(prev, merged.entries) ? prev : merged.entries;
  }

  /**
   * The user tier's documents, with the scene half taken from the LIVE manifest.
   *
   * `listDocuments()` runs once, when the project opens — it is a folder scan,
   * and re-running it on every publish would put disk IO behind a synchronous
   * render. That is right for models and library assets, which change only by
   * somebody putting a file in a folder, and wrong for scenes, which the user
   * creates, renames and deletes from this very screen. So the scene half is
   * re-derived from the manifest's own scene documents, the same list
   * `_mergeTiers()` reads, which the folder writer keeps current through
   * `setManifest`.
   *
   * The classification is merged rather than overwritten: a manifest row that
   * has not been through a scan carries none, and the cached document is then
   * the only place it exists between one open and the next.
   */
  private _liveUserDocuments(): RvDocumentEntry[] {
    const captured = this._userDocuments;
    // A bundled project has no user tier at all, and nothing in it can change.
    if (this._backend?.kind === 'bundled') return captured;
    const manifestScenes = sceneDocumentsOf(this._project);
    const cached = new Map(captured.map(d => [documentKeyOf(d), d]));
    const out: RvDocumentEntry[] = [];
    for (const entry of manifestScenes) {
      if (!entry || typeof entry.path !== 'string') continue;
      const doc = documentOfSceneEntry(entry);
      const known = cached.get(documentKeyOf(doc));
      out.push(known
        ? { ...known, ...doc, classification: doc.classification ?? known.classification }
        : doc);
    }
    for (const doc of captured) {
      if (sectionOfDocument(doc) !== 'scenes') out.push(doc);
    }
    return out;
  }

  /**
   * Bring the classification cache back in line with the files (§2.5).
   *
   * Runs on open, behind the `(size, mtime, sha)` pre-filter — a project whose
   * hundred documents are unchanged performs zero GLB reads, which is the only
   * reason this can sit in the open path at all. A bundled backend returns no
   * stats and is therefore skipped entirely: read-only bytes cannot drift from
   * the manifest that describes them.
   *
   * The result is **not** written back here. Persisting it belongs to the next
   * normal manifest write, so opening a project stays a read.
   */
  private async _scanClassifications(
    backend: ProjectBackend,
    documents: readonly RvDocumentEntry[],
  ): Promise<RvDocumentEntry[]> {
    if (documents.length === 0) return [...documents];
    let stats: DocumentStat[] = [];
    try {
      stats = await backend.statDocuments();
    } catch {
      return [...documents];
    }
    if (stats.length === 0) return [...documents];

    try {
      const scanned = await reconcileClassificationCache(documents, {
        stats,
        readClassification: async path => {
          const resolved = await backend.readBlobUrl(path);
          if (!resolved) return null;
          try {
            const blob = await (await fetch(resolved.url)).blob();
            return await classificationOfGlbBlob(blob);
          } finally {
            resolved.release();
          }
        },
      });
      return scanned.documents;
    } catch {
      return [...documents];
    }
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

  /**
   * Resolve a manifest asset path to loadable bytes, or to a URL with an owner
   * (plan-709 §2.5, phase 4).
   *
   * This is what {@link resolveAssetUrl} should have been. It never produces an
   * unowned object URL: a self-contained GLB — the normal shape here — comes
   * back as bytes and needs no resource at all, and anything with external
   * buffers or textures comes back as a URL *together with* the `release` that
   * frees it, which the caller is then obliged to hold and call.
   *
   * `resolveAssetUrl` survives for the callers that only ever want a string and
   * whose lifetime is a single awaited operation.
   */
  async resolveAssetSource(relPath: string): Promise<ProjectAssetSource | null> {
    const backend = this._backend;
    if (!backend) return null;
    const bytes = await backend.readBlobBytes(relPath);
    if (bytes && isSelfContainedGlb(bytes)) return { kind: 'bytes', bytes };
    // Either nothing is stored, or the bytes name sibling files. Falling
    // through to the URL — rather than returning the bytes we already hold —
    // is deliberate: without a base URL the loader cannot fetch those
    // siblings, and a model missing its textures is worse than one more
    // owned object URL.
    const resolved = await backend.readBlobUrl(relPath);
    if (!resolved) return null;
    return { kind: 'url', url: resolved.url, release: resolved.release };
  }

  /**
   * Change what a document says it is (plan-413 §2.5, phase 4).
   *
   * Bytes first, cache second — see `rv-document-classify`. The manifest half
   * is deliberately best-effort *in ordering only*, never in truth: it is a
   * cache of what the file now says, so a failure to persist it costs one scan,
   * while writing it before the bytes would cost a manifest that describes a
   * file that does not exist.
   *
   * Persisted where there is a manifest file to persist into — a folder
   * project. A browser project derives its scene rows from the scene index (the
   * SceneStore owns that row and writes the same field), and a bundled project
   * is read-only and never gets here. In every case the in-memory list is
   * updated so the dashboard redraws immediately, and the open-time scan is the
   * backstop that makes the file authoritative again.
   *
   * @returns the classification the file now carries.
   */
  async setDocumentClassification(
    documentId: string,
    classification: DocumentClassification | null,
  ): Promise<DocumentClassification | null> {
    const backend = this._backend;
    if (!backend) throw new Error('No project is open.');
    const doc = this._snapshot.documents.find(d => d.id === documentId);
    if (!doc) throw new Error('That document is no longer part of this project.');
    if (doc.tier === 'bundled') {
      throw new Error(`"${doc.name}" is read-only — duplicate it into this project first.`);
    }

    const result = await writeDocumentClassification(backend, doc, classification);
    const next = result.classification ?? undefined;

    // In-memory first so the grid and the detail pane agree before the disk
    // write is awaited; the manifest is the cache, not the display source.
    const key = documentKeyOf(doc);
    const apply = (list: RvDocumentEntry[]) => list.map(
      e => documentKeyOf(e) === key ? { ...e, classification: next } : e);
    this._userDocuments = apply(this._userDocuments);
    this._bundledDocuments = apply(this._bundledDocuments);
    this._publish();

    const dir = this._dir;
    if (dir) {
      await updateManifestCas(dir, current => {
        const base = current ?? this._project;
        if (!base) throw new Error('This project has no manifest to update.');
        const documents = (base.documents ?? []).map(
          e => documentKeyOf(e) === key ? { ...e, classification: next } : e);
        return { ...base, documents };
      });
    }
    return result.classification;
  }

  /**
   * Set or clear one document's CONNECT binding (`documents[].connectRef`,
   * plan-718 §3) — the write half of the hero card's Unity-style reference.
   *
   * In-memory first, then the manifest under CAS, exactly like
   * {@link setDocumentClassification} above: the chip and the detail pane must
   * agree the moment the drop lands, not after the disk write settles. The
   * pure edit itself is `setDocumentRefOn` from `rv-project-refs`, so the
   * containment rule (a ref never leaves the project) is enforced on this path
   * like on every other.
   */
  async setDocumentConnectRef(documentId: string, ref: string | null): Promise<void> {
    return this._setDocumentRefField(documentId, 'connectRef', ref);
  }

  /** The `knowledgeRef` twin of {@link setDocumentConnectRef}. */
  async setDocumentKnowledgeRef(documentId: string, ref: string | null): Promise<void> {
    return this._setDocumentRefField(documentId, 'knowledgeRef', ref);
  }

  private async _setDocumentRefField(
    documentId: string,
    field: 'connectRef' | 'knowledgeRef',
    ref: string | null,
  ): Promise<void> {
    const backend = this._backend;
    if (!backend) throw new Error('No project is open.');
    if (!backend.writable) throw new Error('This project is read-only.');
    const doc = this._snapshot.documents.find(d => d.id === documentId);
    if (!doc) throw new Error('That document is no longer part of this project.');
    if (doc.tier === 'bundled') {
      throw new Error(`"${doc.name}" is read-only — duplicate it into this project first.`);
    }
    const next = ref === null ? null : assertContainedRef(ref, field);

    const key = documentKeyOf(doc);
    const apply = (list: RvDocumentEntry[]) => list.map((e) => {
      if (documentKeyOf(e) !== key) return e;
      const { [field]: _dropped, ...rest } = e;
      return next ? { ...rest, [field]: next } : rest;
    });
    this._userDocuments = apply(this._userDocuments);
    this._bundledDocuments = apply(this._bundledDocuments);
    this._publish();

    const dir = this._dir;
    if (dir) {
      const written = await updateManifestCas(dir, (current) => {
        const base = current ?? this._project;
        if (!base) throw new Error('This project has no manifest to update.');
        return setDocumentRefOn(base, documentId, field, next);
      });
      this._project = written.project;
    }
    // The hero drop itself (plan-725 F1): the whole reason the notify exists.
    this._notifyConnectAsync();
  }

  /**
   * Adopt a manifest a caller derived from {@link getProject} (plan-703 Phase 6).
   *
   * The tree's move is the caller: it has already run `moveDocumentPath` for
   * every row it touched — the function that rewrites `path` and leaves the id
   * alone — and needs the result to become the manifest, in memory and on disk.
   * Handing the finished object over is what keeps the move rules in
   * `rv-project-tree-move.ts` instead of growing a second copy of them here.
   *
   * In-memory first, then disk, exactly like {@link setDocumentClassification}:
   * the tree must redraw at the new path before the write is awaited, or a slow
   * folder makes a drag look like it did nothing.
   *
   * The tier lists are re-pointed **by id**, which is the whole reason a move is
   * safe: the id is what did not change, so it is the only thing that can carry
   * a row from before the move to after it.
   */
  async replaceManifest(next: RvProject): Promise<void> {
    const pathById = new Map<string, string>();
    for (const doc of next.documents ?? []) {
      if (typeof doc.id === 'string' && doc.id !== '') pathById.set(doc.id, doc.path);
    }
    const apply = (list: RvDocumentEntry[]): RvDocumentEntry[] => list.map((e) => {
      const path = e.id ? pathById.get(e.id) : undefined;
      return path !== undefined && path !== e.path ? { ...e, path } : e;
    });

    this._project = next;
    this._userDocuments = apply(this._userDocuments);
    this._bundledDocuments = apply(this._bundledDocuments);
    this._publish();

    const dir = this._dir;
    // `() => next` on purpose: the caller derived this manifest from the one
    // currently open and is stating it as the new truth. The CAS wrapper is
    // still what serialises the write against the folder writer's own queue.
    if (dir) await updateManifestCas(dir, () => next);
    // The tree move/rename path (plan-725 F7): a configuration that changed its
    // name or folder must stop being written back to where it no longer is.
    this._notifyConnectAsync();
  }

  // ─── Adopt (plan-717 §2.2) ────────────────────────────────────────────

  /**
   * Apply a DELTA to the manifest — merged into the current state, written
   * before anything on screen moves (plan-717 §2.2 step 5).
   *
   * Two deliberate differences from every other writer in this class, and both
   * of them are the reason this method exists rather than another
   * `replaceManifest` caller:
   *
   *  1. **A real apply function, not a captured snapshot.** `replaceManifest`
   *     hands `updateManifestCas` a constant `() => next` (see its comment):
   *     correct for a user verb that states a new truth, wrong for a background
   *     step, because a CAS retry then re-writes the stale snapshot and a second
   *     tab's rows vanish. Here `apply` runs again on each attempt, against what
   *     was just read from disk.
   *  2. **Durable first.** The store's idiom is in-memory-then-disk, so the UI
   *     never waits for a folder. An adopt that fails must leave nothing behind
   *     — a boot adopt that hits a revoked grant would otherwise show rows that
   *     do not exist anywhere (Risiko 11) — so the order is inverted here, on
   *     purpose, and only here.
   *
   * @returns the manifest that was written, or null when there was nothing to
   *   write it to. Throws whatever the write threw, with the store unchanged.
   */
  async applyManifestDelta(
    apply: (current: RvProject) => RvProject,
    opts: { publish?: boolean } = {},
  ): Promise<RvProject | null> {
    const backend = this._backend;
    const base = this._project;
    if (!base || !backend?.writable) return null;

    let next: RvProject;
    const dir = this._dir;
    if (dir) {
      next = (await updateManifestCas(dir, current => apply(current ?? base))).project;
    } else {
      const writing = backend as ProjectBackend & Partial<ManifestWritingBackend>;
      if (typeof writing.writeManifest !== 'function') return null;
      const current = await backend.readManifest().catch(() => null);
      next = apply(current ?? base);
      await writing.writeManifest(next);
    }

    // Only now — the write survived, so the rows are real.
    this._project = next;
    this._userDocuments = repointToManifestRows(this._userDocuments, next);
    if (opts.publish !== false) this._publish();
    this._notifyConnectAsync();
    return next;
  }

  /** Test seam: the clock, the quarantine window and the audit sink of the adopt verb. */
  setAdoptOptions(options: AdoptStoreOptions): void {
    this._adoptOptions = { ...options };
  }

  /**
   * Turn what the scan found into authored rows — the write half of §2.2.
   *
   * Runs after `_adoptProject()` and after every `rescanDocuments()`, on a
   * WRITABLE backend and nowhere else. Single-flight: the save cascade fires
   * `void rescanDocuments()` twice a second, and an overlapping call joins the
   * run already going rather than starting a second one (R1-A2).
   *
   * An empty delta means no commit at all — not a commit of an unchanged
   * manifest (R1-I1). That is what keeps a customer's `project.json` untouched
   * on every run after the first.
   */
  async adoptDiscoveredDocuments(opts: { publish?: boolean } = {}): Promise<AdoptRunSummary> {
    if (this._adoptRun) return this._adoptRun;
    const run = this._runAdopt(opts).finally(() => { this._adoptRun = null; });
    this._adoptRun = run;
    return run;
  }

  private async _runAdopt(opts: { publish?: boolean }): Promise<AdoptRunSummary> {
    const started = Date.now();
    const nothing = (): AdoptRunSummary => ({
      adopted: 0, moved: 0, quarantined: 0, restored: 0, removed: 0, hashed: 0,
      ingested: 0, sidecarRemoved: false, sidecarUnreadable: false,
      durationMs: Date.now() - started,
    });
    const backend = this._backend;
    const project = this._project;
    if (!backend?.writable || !project) return nothing();

    let stats: DocumentStat[];
    try {
      stats = await backend.statDocuments();
    } catch {
      return nothing();                  // a scan that failed learnt nothing
    }

    const sidecar = await this._readSidecarForIngestion(backend, project);

    const scan = await adoptScan(project, {
      stats,
      now: this._adoptOptions.now,
      quarantineMs: this._adoptOptions.quarantineMs,
      sidecar: sidecar.ingestion ?? undefined,
      hashOf: async path => {
        const bytes = await backend.readBlobBytes(path).catch(() => null);
        return bytes ? await revisionOfBytes(bytes) : null;
      },
    });

    const base = (): AdoptRunSummary => ({
      ...nothing(), hashed: scan.hashed.length, sidecarUnreadable: sidecar.unreadable,
    });
    if (scan.delta.length === 0) {
      // Nothing to write — but a sidecar may still be lying there from a run
      // that committed and then died before the delete. The marker says the
      // rows already won, so finishing the job is safe and idempotent (R1-S3).
      return { ...base(), sidecarRemoved: await this._removeIngestedSidecar(backend, sidecar) };
    }

    // Re-checked here rather than trusted from the top: a folder grant can be
    // revoked while the hashes are being computed (Risiko 11).
    if (!backend.writable) return base();

    let log: AdoptLogEntry[] = [];
    // Throws on a failed write, and that is the point of the ordering: the
    // sidecar delete below is unreachable unless the rows are durable.
    await this.applyManifestDelta(current => {
      const applied = applyAdoptDelta(current, scan.delta);
      log = applied.log;
      return applied.project;
    }, { publish: opts.publish });

    const sink = this._adoptOptions.log ?? defaultAdoptLog;
    for (const line of log) sink(line);
    const count = (kind: AdoptLogEntry['kind']) => log.filter(l => l.kind === kind).length;
    return {
      ...base(),
      adopted: count('adopt'),
      moved: count('move'),
      quarantined: count('quarantine'),
      restored: count('restore'),
      removed: count('remove'),
      ingested: count('ingest'),
      sidecarRemoved: await this._removeIngestedSidecar(backend, sidecar),
      durationMs: Date.now() - started,
    };
  }

  /**
   * Read `library/library.json` for the ingestion, tolerating every way it can
   * be absent (§2.4).
   *
   * Three outcomes and they are genuinely different: no file (nothing to do),
   * a parsed file (ingest it), and a file this build cannot parse. The third is
   * the one with a rule attached — **never overwritten, never deleted, always
   * reported** — because a file we cannot read is far more likely to come from
   * a version we do not know than to be garbage, and deleting it would destroy
   * collections we could not even see.
   */
  private async _readSidecarForIngestion(
    backend: ProjectBackend,
    project: RvProject,
  ): Promise<{ ingestion: AdoptSidecarIngestion | null; unreadable: boolean }> {
    let text: string | null = null;
    try {
      const bytes = await backend.readBlobBytes(SIDECAR_PATH);
      if (bytes) text = new TextDecoder().decode(bytes);
    } catch {
      return { ingestion: null, unreadable: false };   // unreadable BYTES, not a bad shape
    }
    if (text === null) return { ingestion: null, unreadable: false };

    const parsed = parseSidecar(text);
    if (!parsed) {
      const notice =
        `"${SIDECAR_PATH}" was written by a newer version and was left untouched — `
        + 'the collections in it are not shown.';
      if (!this._warnings.includes(notice)) this._warnings.push(notice);
      console.warn(`[project-store] ${notice}`);
      return { ingestion: null, unreadable: true };
    }
    return { ingestion: ingestionFromSidecar(parsed, project), unreadable: false };
  }

  /**
   * Delete the sidecar — and only ever AFTER the marker is durable (R1-S3).
   *
   * The order is the whole safety property. Deleting first would open a window
   * in which a crash costs the collections outright: the file gone, the rows
   * never written, the fallback with no source. Deleting second costs at worst
   * a repeat, which the marker makes a no-op.
   */
  private async _removeIngestedSidecar(
    backend: ProjectBackend,
    sidecar: { ingestion: AdoptSidecarIngestion | null; unreadable: boolean },
  ): Promise<boolean> {
    if (!sidecar.ingestion || sidecar.unreadable) return false;
    // The marker is read back off the manifest the commit actually produced,
    // not off the delta we hoped to write.
    if (!isSidecarMigrated(this._project)) return false;
    if (!backend.writable) return false;
    try {
      await backend.deleteBlob(SIDECAR_PATH);
      return true;
    } catch (e) {
      // A sidecar that outlives its ingestion is harmless — the row wins and
      // the next run tries again. Failing the adopt over it would not be.
      console.warn(`[project-store] ${SIDECAR_PATH} could not be removed after ingestion:`, e);
      return false;
    }
  }

  /**
   * The adopt run wired into an open/rescan, with its failure contained.
   *
   * A project that cannot adopt still opens (Risiko 11). The user is told
   * through the warnings channel rather than a thrown boot.
   */
  private async _adoptQuietly(): Promise<void> {
    try {
      await this.adoptDiscoveredDocuments({ publish: false });
    } catch (e) {
      console.warn('[project-store] adopt failed — the project keeps its scan-derived rows:', e);
      const notice =
        'Some files in this project could not be registered — they are shown but not saved to project.json.';
      // Deduped: the save cascade rescans every few seconds, and a folder whose
      // grant is gone would otherwise grow the warning list without bound.
      if (!this._warnings.includes(notice)) this._warnings.push(notice);
    }
  }

  /**
   * `models[] → scriptRef`, once per project, at open (plan-718 §2.7).
   *
   * Three deliberate restraints, and each is a rule from somewhere else:
   *
   *  - **writable backends only** (plan-717 §9.0). A deployed or bundled project
   *    cannot save what it migrates, so it would re-run on every open; it reads
   *    its bindings through the `models[]` compatibility path instead.
   *  - **the declaration is read, never executed.** `discoverDeclaredScriptRefs`
   *    pulls the module's SOURCE, so opening a project does not run every
   *    project's plugin code to find out what it claims.
   *  - **best-effort.** A migration that cannot run costs a binding the
   *    compatibility path still provides; letting it take down a project open
   *    would cost the project.
   */
  private async _migrateScriptRefsQuietly(): Promise<void> {
    const project = this._project;
    const dir = this._dir;
    if (!project || !dir || !this._backend?.writable) return;
    if (readScriptRefMigrationMarker(project)) return;
    try {
      const folder = String(project.canonicalName ?? project.name ?? '');
      const modules = await discoverDeclaredScriptRefs(folder);
      if (modules.length === 0) return;
      const dry = migrateProjectScriptRefs(project, { modules });
      if (dry.outcome !== 'migrated') return;

      // Durable first, then in-memory (plan-717 R2-F3), and re-derived inside the
      // CAS callback so a retry runs against what is actually on disk.
      const written = await updateManifestCas(dir, current =>
        migrateProjectScriptRefs(current ?? project, { modules }).project);
      this._project = written.project;
      this._publish();
      if (dry.caseMismatches.length > 0) {
        for (const miss of dry.caseMismatches) {
          console.warn(
            `[project-store] plugin declares model "${miss.declared}" but the document is `
            + `"${miss.documentPath}" — the case differs, so nothing was bound. `
            + 'Fix one of the two by hand.');
        }
      }
    } catch (e) {
      console.warn('[project-store] scriptRef migration skipped:', e);
    }
  }

  /**
   * Adopt CONNECT's migration handoff → `documents[].connectRef` (plan-718 §1.6b).
   *
   * The second half of a migration whose first half ran in another process. It
   * carries the same three restraints as the scriptRef migration above — writable
   * backends only, best-effort, marker-guarded — plus one that belongs to it
   * alone: **it never touches the handoff file**. Clearing it is CONNECT's job,
   * and CONNECT only does it after reading this manifest and finding every
   * binding here. That is what makes the whole thing repeatable instead of
   * merely hopeful.
   */
  private async _adoptConnectHandoffQuietly(): Promise<void> {
    const project = this._project;
    const dir = this._dir;
    if (!project || !dir || !this._backend?.writable) return;
    if (readConnectRefMigrationMarker(project)) return;
    try {
      const bindings = parseConnectMigrationHandoff(
        (await readSettingsFile(dir, CONNECT_MIGRATION_HANDOFF)) as object | null);
      if (bindings.length === 0) return;
      if (migrateConnectRefs(project, bindings).outcome !== 'migrated') return;

      const written = await updateManifestCas(dir, current =>
        migrateConnectRefs(current ?? project, bindings).project);
      this._project = written.project;
      this._publish();
      // This one writes `connectRef` rows at project-open time — the state the
      // gateway most needs to hear about, and the earliest it can.
      this._notifyConnectAsync();

      const result = migrateConnectRefs(project, bindings);
      for (const model of result.unmatched) {
        console.warn(
          `[project-store] CONNECT had a configuration bound to model "${model}", but no document `
          + 'row matches that name — the binding was not adopted. Set connectRef by hand.');
      }
    } catch (e) {
      console.warn('[project-store] CONNECT handoff adoption skipped:', e);
    }
  }

  /**
   * The plan-703 §2.5 mint, at the persistence step and nowhere else.
   *
   * Called by whoever just wrote GLB bytes containing references — today
   * `SceneStore._writeBody`, after the body has landed. Everything that decides
   * *whether* a row is due lives in `rv-asset-identity`; what is here is the two
   * things only the store can do: hold the manifest, and write it.
   *
   * Deliberately best-effort. A failed imprint costs a document its durable id
   * until the next save, which is recoverable; letting it take down a save whose
   * bytes are already on disk is not. It is also a no-op — not even a manifest
   * read — when the bytes carry no mintable reference, which is the overwhelming
   * majority of saves.
   *
   * @returns the rows that were added, empty when nothing was due.
   */
  async mintReferencedAssetIdentities(
    references: readonly WrittenGlbReference[],
  ): Promise<RvDocumentEntry[]> {
    const project = this._project;
    if (!project || references.length === 0) return [];
    const due = mintableReferences(project, references);
    if (due.length === 0) return [];

    try {
      const result = mintReferencedAssets(project, due);
      if (result.minted.length === 0) return [];

      // In-memory first, exactly like `setDocumentClassification`: the dashboard
      // must show the new rows even on a backend that has no manifest file.
      this._project = result.project;
      this._userDocuments = [...this._userDocuments, ...result.minted];
      this._publish();

      const dir = this._dir;
      if (dir) {
        await updateManifestCas(dir, current => {
          const base = current ?? result.project;
          // Re-run against what is actually on disk: another writer may have
          // added rows since, and re-deriving is what keeps the CAS retry loop
          // from writing a manifest built on a stale read.
          return mintReferencedAssets(base, due).project;
        });
      }
      this._notifyConnectAsync();
      return result.minted;
    } catch (e) {
      console.warn('[project-store] could not imprint referenced asset ids:', e);
      return [];
    }
  }

  private _publish(): void {
    const status = this._writerStatus();
    const models = this._mergeModelTiers();
    const documents = this._mergeDocumentTiers();
    this._snapshot = {
      documents,
      project: this._project,
      folderName: this._dir?.name ?? null,
      writable: this._writable,
      diskError: status?.error ?? null,
      diskPending: status?.pending ?? false,
      warnings: [...this._warnings],
      backendKind: this._backend?.kind ?? null,
      models,
      restoreFailure: this._restoreFailure,
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
 * The one empty array every snapshot without a project shares.
 *
 * A fresh instance per publish is a fresh identity, and a fresh identity is a
 * change signal `useSyncExternalStore` never stops reacting to.
 */
const NO_MODELS: TieredAssetEntry[] = [];
const NO_DOCUMENTS: TieredDocumentEntry[] = [];

/**
 * Same shallow comparison for the document list.
 *
 * The classification is compared by value rather than by reference — a scan
 * that read the same answer out of the file must not look like a change, or the
 * open path would publish twice on every project that has any documents at all.
 *
 * Exported for the snapshot-equality test: every field a publish can change
 * must be compared here, or the change is invisible to `useSyncExternalStore`.
 */
export function sameDocuments(
  a: readonly TieredDocumentEntry[],
  b: readonly TieredDocumentEntry[],
): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x.id !== y.id || x.name !== y.name || x.path !== y.path
      || x.tier !== y.tier || x.modifiedAt !== y.modifiedAt
      || x.section !== y.section
      // The three reference fields (plan-718) are row state like everything
      // above: leaving them out made a `setDocumentConnectRef` publish look
      // like "no change", so the hero chip neither appeared on a drop nor
      // disappeared on a clear until the next unrelated publish.
      || x.connectRef !== y.connectRef
      || x.scriptRef !== y.scriptRef
      || x.knowledgeRef !== y.knowledgeRef
      || !classificationEquals(x.classification, y.classification)) return false;
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
    models: NO_MODELS,
    documents: NO_DOCUMENTS,
    restoreFailure: null,
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
