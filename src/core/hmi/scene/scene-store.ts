// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * scene-store — Op-based source of truth for the unified Scene model.
 *
 * Holds:
 *   - the workspace shell (id, name, base, createdAt) of the currently open scene
 *   - workspace settings (catalogUrls, gridSizeMm)
 *   - the scene catalogue, the GLB body persistence and the save/fork/discard
 *     lifecycle
 *   - flags for in-flight loads
 *
 * Since plan-703 Phase 3 it does NOT hold its own op log. The operation log,
 * the undo floor, the redo stack, the single-flight queue, transactions,
 * coalescing, the history cap and dirty derivation all live in one shared
 * {@link RvDocument} (`_doc`, in `'scene'` mode) — the same class the asset
 * editor uses. This store was one of the two places that machinery was
 * maintained separately; that duplication is what plan-703 removes.
 *
 * Editors push ops via `applyOp` (or `beginTransaction` / `endTransaction`
 * for grouped edits) exactly as before — the public API is unchanged, and ops
 * are authored and persisted in the ONE vocabulary (`RvOp`).
 *
 * A few thin backward-compat shims (loadScene, createNewLayout,
 * exportLayoutJSON) remain for callers still on the old API.
 */

import type { RVViewer } from '../../rv-viewer';
import { debug } from '../../engine/rv-debug'; // TEMP open-perf instrumentation
import type { FlattenSizeEstimate } from '../../engine/rv-glb-flatten';
import type { RVViewerPlugin } from '../../rv-plugin';
import type { DocumentClassification } from '../../project/rv-document-classification';
import type {
  RvScene, SceneBase, BuiltinSceneEntry,
} from './rv-scene-types';
import {
  baseKeyOf, baseLabelOf, makeDraftScene, scenesEqual,
  RV_SCENE_SCHEMA_VERSION,
} from './rv-scene-types';

/** `glTF` little-endian — the first four bytes of every GLB. */
const GLB_MAGIC = 0x46546c67;
import type { Object3D } from 'three';
import type { PlacedComponent } from '../../../plugins/layout-planner/rv-layout-store';
// `rv-scene-glb-bake` pulls in the GLB chunk codec and the exporter path; it is
// only ever needed when something is actually written, and a write is already
// async. Importing it eagerly put all of that into the graph of every module
// that touches the SceneStore — which showed up as a lazy-panel chunk missing
// its load budget, not as anything resembling a storage bug.
import {
  collectPlacementNodes,
  readCameraStartFromScene,
  readSceneSettingsFromScene,
} from './rv-scene-glb-read';
// Same reasoning as the bake above: `rv-scene-glb-io` reaches the project
// store, the OPFS blob store and the backend contract, and every one of its
// callers here is already async. A static edge would drag all of it into the
// graph of anything that merely imports the SceneStore.
type SceneGlbIo = typeof import('./rv-scene-glb-io');
const sceneGlbIo = (): Promise<SceneGlbIo> => import('./rv-scene-glb-io');
import { publishedSceneUrl, type PublishedSceneEntry } from './rv-published-scenes';
import {
  type SceneEditsSettings, type MaterialisedEdits,
  COALESCE_WINDOW_MS, materialise,
} from './rv-scene-edits';
import { RvDocument, type RvDocumentCore } from '../../ops/rv-document';
import { RvUnifiedExecutor } from '../../ops/rv-unified-executors';
import type { RvOp, RvScenePrimitiveOp } from '../../ops/rv-unified-ops';
import { normalizePersistedSceneOps } from '../../ops/rv-unified-ops';
import {
  readScene,
  readActiveId, clearDraft,
  clearSceneDraft,
} from './rv-scene-storage';
import {
  clearDocumentDraft,
  loadDocumentDraft,
  sharedDocumentFrame,
  type RvDraftBytesCache,
} from '../../ops/rv-document-drafts';
import {
  decideDocumentRecovery,
  describeDocumentRecovery,
  type RvDocumentRecovery,
} from '../../ops/rv-document-recovery';
import { setActiveSceneId } from './rv-scene-mutations';
// Runtime-free module (one variable + two setters, type-only imports), so this
// edge does not pull the editor graph into the core bundle.
import { documentBase, sceneDocumentBase, setOpenDocumentBase } from '../../editor/active-asset-store';
import type { AssetBase } from '../../editor/rv-asset-document';
import { showInfoOverlay, hideInfoOverlay } from '../info-overlay-store';
import { nextOptionParam } from '../../../plugins/models/model-option-plugin';
import { writeSettingsIntoModel } from './rv-scene-settings-into-model';
import { getProjectStore } from '../../project/project-store';
import { documentsOf } from '../../project/rv-project-documents';
// plan-702 Phase 3 — the resume pair is written by the OPEN FUNNEL, see
// `openDocument`. Storage-only module (localStorage + the shared key), so this
// edge adds no graph the store did not already carry.
import { rememberSession } from '../../project/rv-project-resume-store';
import type { ProjectBackend } from '../../project/backends/project-backend';
import {
  isBytesSourceUrl,
  projectAssetRelPath,
  projectAssetUrl,
} from '../../project/rv-project-asset-source';
// plan-716 §2.4 — an old scene id addresses the document it became. Tolerant
// here (never strict): every call below wants "the id to use", not "was this
// migrated".
import {
  hasDocumentAlias,
  resolveDocumentAlias,
  resolveDocumentId,
} from '../../project/rv-doc-alias';
import type { RvDocumentEntry } from '../../project/rv-project-types';
import { isSupported as isFileSystemAccessSupported } from '../../engine/rv-local-filesystem';
import { saveStartPos } from '../camera-startpos-store';
import { deriveModelKey } from '../../../plugins/camera-startpos-plugin';

// ─── Snapshot ───────────────────────────────────────────────────────────

/**
 * The scene facade's snapshot.
 *
 * The three intrinsics (`dirty`, `busy`, `canUndo`, `canRedo`) come from
 * {@link RvDocumentCore} — derived once in the document layer (plan-710 §2.4).
 * Everything else here is scene-specific and STAYS scene-specific: a
 * materialised `RvScene`, the catalogue, the published list and the transient
 * flag have no asset counterpart, and forcing one shape over both was an
 * explicit review finding against an earlier draft of the merge.
 */
export interface SceneSnapshot extends RvDocumentCore {
  saved: RvScene | null;
  /** Always-present derived view of the current workspace. Includes the
   *  current op log; structurally compared against `saved` for dirty. */
  draft: RvScene | null;
  isDraft: boolean;
  dirty: boolean;
  /** Read-only built-in SOURCES, mirrored from `viewer.availableModels`. */
  builtins: BuiltinSceneEntry[];
  /** Read-only "Example" scenes of the DemoRealvirtual project. */
  published: PublishedSceneEntry[];
  /** urlName of the open published example, for Examples-row highlight; null otherwise. */
  activePublishedName: string | null;
  /**
   * The open workspace holds foreign content and persists nothing (plan-386
   * §2.5). Exposed so the UI can say so, and so a regression that leaves the
   * flag standing is visible rather than silent (R6).
   */
  transient: boolean;
  /** Tooltip text "Undo: <action>" / "Redo: <action>"; null when disabled. */
  undoLabel: string | null;
  redoLabel: string | null;
}

/**
 * What a scene save actually did (plan-710 F5).
 *
 * `save()` used to answer `void`, which meant its two silent outcomes — the
 * clean no-op and the §2.2.1-1 discard when the save target moved mid-write —
 * were indistinguishable from success to everyone above it. The card therefore
 * said "saved" for a save that adopted nothing. Nothing about the PROTECTION
 * changed here: the `workspaceAtStart` identity guard already made that
 * decision, it simply had no way to report it.
 */
export type SceneSaveVerdict = 'saved' | 'no-op' | 'target-changed';

/**
 * The living document, handed to another projection (plan-711 §2.2).
 *
 * Everything the borrowing side needs and nothing it could look up: the
 * instance, the identity it was matched on, the display name, the bytes of the
 * current scene state, and the way back. See
 * {@link SceneStore.beginProjectionHandover}.
 */
export interface RvSceneProjectionHandover {
  /** The one living document. Shared for the duration, never copied. */
  document: RvDocument;
  /** `{kind:'document'|'builtinModel', …}` — what the caller matched with `sameDocumentBase`. */
  base: AssetBase;
  name: string;
  /** The scene as bytes: base + the materialised scene overlay. Null if it cannot be baked. */
  bakeBytes(): Promise<Uint8Array | null>;
  /**
   * Which prefix of the shared log this store's bytes hold (plan-711 §2.4).
   *
   * Read at write time by the ops-draft writer, never cached by it: the stamp
   * is a fact about storage, and storage keeps moving.
   */
  bytesCache(): RvDraftBytesCache | null;
  /** Give the document back; `authoredBytes` becomes the scene's new bake source. */
  release(opts?: { authoredBytes?: ArrayBuffer }): void;
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
  /**
   * This workspace holds somebody else's content and must leave no trace
   * (plan-386 §2.5, F7/F19).
   *
   * It is **workspace state, not a one-shot switch**, and it lives on the
   * shell rather than on the store for one reason: every path that replaces
   * the shell replaces the flag with it. `freshShell()` and
   * `workspaceShellOf()` both default it to `false`, so the rule is a
   * whitelist — a new open path is non-transient unless it says otherwise.
   * The opposite arrangement (a store field cleared by each open) is what
   * R6 describes: one forgotten reset and the user edits for an hour with the
   * autosave silently off.
   */
  transient: boolean;
  description?: string;
  /**
   * Classification cache of the workspace scene (plan-413 §2.9).
   *
   * Carried on the shell rather than re-read on every save for the same reason
   * the base and the description are: every path that replaces the workspace
   * replaces this with it, so a save can never write back a classification that
   * belonged to the scene before last. Truth remains the GLB — this only keeps
   * the index row in step, so a project-less dashboard can filter without
   * parsing every body.
   */
  classification?: DocumentClassification;
  /**
   * Manifest path of the project document this workspace saves back into
   * (GLBs only — scene = asset). Set by the first {@link SceneStore._saveIntoDocument};
   * while present, saves replace the document's own file and no scene id or
   * catalogue row exists for this workspace.
   */
  documentPath?: string;
  /**
   * Manifest ROW id of that document (plan-716 §2.5, F5).
   *
   * The path says where the bytes are; this says which document they ARE, and
   * the two are not interchangeable: a rename moves the path and keeps the id,
   * which is precisely why every identity surface added in Phase 3 — the draft
   * slot, the cross-mode handle, the `?doc=` parameter — keys off this and not
   * off {@link documentPath}.
   */
  documentId?: string;
}

const DRAFT_AUTOSAVE_DEBOUNCE_MS = 2000;
const DEFAULT_SETTINGS: SceneEditsSettings = { catalogUrls: [], gridSizeMm: 500 };

export interface TransactionToken { readonly _depth: number }

/**
 * Where a save writes (plan-716 §2.5).
 *
 * `plannedName` is the discriminant, not a decoration: when it is present the
 * document does not exist yet, so the write is create-only and the manifest row
 * is added after the bytes land. When it is absent the document is there and the
 * write carries the revision this session last saw.
 */
interface SaveTarget {
  entryId: string;
  relPath: string;
  plannedName?: string;
}

/** Everything `openTransient()` puts back when a foreign load fails (§2.5, F19). */
interface WorkspaceSnapshotState {
  workspace: WorkspaceShell | null;
  settings: SceneEditsSettings;
  baselineOps: RvOp[];
  ops: RvOp[];
  redoStack: RvOp[];
  saved: RvScene | null;
  activePublishedName: string | null;
}

// ─── Store ──────────────────────────────────────────────────────────────

export class SceneStore {
  private readonly _viewer: RVViewer;

  // Workspace
  /**
   * Which behaviour layer over {@link RvDocument} this is (plan-710 F5).
   *
   * The discriminant `saveDocument()` routes on. A field rather than an
   * `instanceof`: the one save path lives in `core/editor` and must not import
   * this module back, and a compile-time tag beats duck-typing a method name.
   */
  readonly lineage = 'scene';

  private _workspace: WorkspaceShell | null = null;
  private _settings: SceneEditsSettings = { ...DEFAULT_SETTINGS };
  private _saved: RvScene | null = null;

  /**
   * The ONE op-log document (plan-703 Phase 1/3), in `'scene'` mode.
   *
   * This store used to carry its own copy of the queue, transactions,
   * coalescing, undo/redo stacks, history cap and baseline realignment — the
   * same machinery `AssetDocument` carried a second time. All of it is now here,
   * once. What stays in this class is what is genuinely scene-specific: the
   * workspace shell, the scene catalogue, the GLB body persistence, the settings
   * block and the save/fork/discard lifecycle.
   *
   * Ops are authored, applied and PERSISTED in the ONE vocabulary since
   * plan-710. Nothing is converted at this boundary any more; a log written
   * BEFORE the merge is renamed once, where it enters the session
   * (`normalizePersistedSceneOps` in `_installOps`).
   */
  private readonly _doc: RvDocument;

  // Sources (plan-716 Phase 6 — the scene CATALOGUE that used to sit here is
  // gone; both of these are read-only origins, not owned artefacts).
  private _builtins: BuiltinSceneEntry[] = [];
  private _published: PublishedSceneEntry[] = [];
  /** urlName of the currently-open published example (for row highlight); null otherwise. */
  private _activePublishedName: string | null = null;

  // UI state flags
  private _busy = false;
  private _loading = false;

  // Debounced draft autosave timer
  private _draftAutosaveTimer: number | null = null;

  /**
   * A projection of THIS document is active somewhere else (plan-711 R2-Q1).
   *
   * Set for as long as the editor holds the shared `RvDocument` — see
   * {@link beginProjectionHandover}. While it is set the body autosave is
   * SUSPENDED, because `_writeBody` bakes `materialise(this._ops)` against
   * `viewer.registry` and the base bytes, and in the editor projection both are
   * wrong at once: the registry belongs to the authored tree, and `materialise`
   * drops all eleven asset-lineage kinds without a word (plan-711 Spike (b)).
   * A write from here would therefore not merely read the wrong tree — it would
   * persist a body with the editor's half silently missing.
   */
  private _projectionSuspended = false;
  /**
   * A change arrived while suspended and still owes a write.
   *
   * Keeps `hasUnpersistedWork()` truthful for the whole suspension (R2-Q1): the
   * work is real and unwritten, and answering "nothing outstanding" would open
   * a tab-close window that did not exist before the binding.
   */
  private _projectionDeferredWrite = false;
  /**
   * What this store's last successful body write holds of the op log
   * (plan-711 §2.4).
   *
   * The scene's baked bytes are the DERIVED projection of the shared log, and
   * this is the stamp that says which prefix of it they contain. It travels
   * with the handover so the ops-draft writer can put it into every record,
   * which is what later lets {@link decideDocumentRecovery} tell a usable cache
   * from bytes that have moved on — instead of the recovery having to guess how
   * much of the log the bytes already show.
   */
  private _bytesCache: RvDraftBytesCache | null = null;
  /**
   * A frame draft for the SHARED document may exist (plan-711 §2.4).
   *
   * Set when a binding starts, because that is when the other projection begins
   * writing one. It is cleared — and so is the record — the moment this
   * document is clean again, which is the only way that record can be dropped
   * at all: the writer is the editor facade, and by then it is gone.
   */
  private _sharedFrameMayExist = false;

  // ── GLB persistence (plan-397 phase 6) ────────────────────────────────
  //
  // The answer to "a debounced write cannot re-fetch 35 MB every two seconds".
  //
  // `_saveSettingsIntoModel` re-fetches its source on purpose and says why:
  // holding a 35 MB buffer for the lifetime of every model is the
  // double-buffering that produced blank scenes on mobile. That reasoning is
  // about *every model*; this buffer is one, for the scene that is open and
  // being edited, and it is fetched lazily — a session that never edits never
  // pays for it. Re-fetching per autosave was the alternative and is plainly
  // worse: the same megabytes over the wire every two seconds.
  //
  // Keyed by what it was read from, so a workspace switch cannot silently bake
  // the new scene's edits onto the old scene's bytes.
  private _baseBytes: { key: string; bytes: ArrayBuffer } | null = null;
  /** Object URL of the body currently handed to the viewer; revoked on switch. */
  private _bodyObjectUrl: string | null = null;
  /** Owner of the object URL a non-self-contained project asset needed (§2.5). */
  private _assetSourceRelease: (() => void) | null = null;
  /**
   * Revision of each body slot as this session last saw it — the
   * compare-and-swap baseline, **per slot** (plan-709 §2.2.1-2).
   *
   * It used to be one field for two slots, and that was a latent bug rather
   * than a simplification: `_commitBody` wrote the revision of the COMMITTED
   * body (`<id>`) into it, and the very next autosave handed that value to the
   * DRAFT slot (`draft/<id>`) as its precondition. The draft slot holds
   * something else — usually nothing at all right after a save — so the
   * compare failed, the autosave read it as "another tab wrote this", and it
   * stood down and told the user so. A map keyed by slot removes the confusion
   * by construction: two slots, two baselines, one meaning.
   */
  private readonly _slotRevisions = new Map<string, string>();

  // Lazy-hydration pre-fetch (installed by ProjectStore; null when no project)
  private _hydrator: ((id: string) => Promise<boolean>) | null = null;

  // React subscribers
  private _listeners = new Set<() => void>();
  private _snapshot: SceneSnapshot;

  constructor(viewer: RVViewer) {
    this._viewer = viewer;
    this._doc = new RvDocument({
      id: 'scene',
      name: '',
      mode: 'scene',
      executor: new RvUnifiedExecutor(viewer, 'scene'),
      // `_afterOpsChanged` used to be called by hand from five places; this is
      // that one hook, and it fires at exactly the same cadence — once per
      // committed change, never inside a transaction or a rollback.
      onChanged: () => { this._afterOpsChanged(); },
      // Ops queued just before a load are stale by the time they run.
      canApply: () => !this._loading,
      // plan-710 F7 — the scene's half of the page unload guard's question.
      // The timer IS the answer here: a scheduled bake that has not run is the
      // only way a non-transient scene loses work to a reload — plus, since
      // plan-711, a change made while the autosave was suspended for an editor
      // projection, which is the same statement about a timer that was never
      // allowed to be armed.
      hasUnpersistedWork: () => this._draftAutosaveTimer !== null || this._projectionDeferredWrite,
    });
    this._refreshBuiltins();
    this._refreshPublished();
    this._snapshot = this._buildSnapshot();
  }

  /**
   * The unified document behind this store.
   *
   * Exposed for the document stack (plan-703 Phase 4) and the unified draft
   * layer, which speak `RvOp`. Op AUTHORING still goes through this class.
   */
  get document(): RvDocument { return this._doc; }

  /** The op log — what gets persisted into `RvScene`. */
  private get _ops(): readonly RvOp[] { return this._doc.ops; }

  /**
   * Install a whole op log without replaying it.
   *
   * Every open path does this: the viewer has already been handed the resolved
   * scene, so the ops are ALREADY reflected in what is on screen. Replaying them
   * would apply each a second time.
   */
  private _installOps(ops: readonly RvOp[], baseline: readonly RvOp[]): void {
    this._doc.restoreHistory({
      ops: normalizePersistedSceneOps(ops),
      redoOps: [],
      baselineIds: baseline.map((o) => o.id),
      baselineFloor: baseline.length,
      metaDirty: false,
    });
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
    this._installOps([], []);
    this._saved = null;
    this._viewer.currentScene = this._buildDraft();
    setActiveSceneId(null);
    this._notify();
  }

  // ─── Sources ────────────────────────────────────────────────────────
  //
  // What is left after plan-716 Phase 6. `listScenes()` (the `rv-scenes-index`
  // catalogue) and `listBuiltins()` are gone: the catalogue does not exist, and
  // the built-ins were never the store's to hold — they are read from the model
  // catalogue via `builtinSources(viewer)`, where they live. Published examples
  // stay, because a SOURCE is still a concept: opening one persists nothing and
  // saving it materialises a document.

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

  // ─── The one open verb (plan-716 §2.5, F5) ──────────────────────────

  /**
   * Open a GLB DOCUMENT by its manifest row id. **The** open path.
   *
   * Every owned artefact is one of these since plan-716: what used to be a
   * "scene" (catalogue row + id-keyed OPFS body) and what used to be a "project
   * document" (manifest row + file) are the same thing, so they are opened by
   * the same verb and saved by the same one. {@link openScene} and the
   * `rvproject:` half of {@link openBuiltin} are thin forwards onto this;
   * {@link openTransient} deliberately is NOT (a source is not a document, see
   * there).
   *
   * Alias-tolerant on the way in: an id that was a `scn_` before the §2.3
   * migration resolves through the permanent map, so a bookmark, a restored
   * pointer and an MCP call all reach the same row.
   *
   * What it does that the forwarded paths could not:
   *
   *  - binds the workspace to the row (`documentId` + `documentPath`) BEFORE the
   *    load, so the draft slot probed by `_resolveLoad` is `draft/<documentId>`
   *    — the exact string the migration renamed the old Form-C slot to (§2.3e);
   *  - normalises the address bar to `?doc=<documentId>`;
   *  - publishes the cross-mode identity, so a mode switch binds the living
   *    document instead of reopening the file (plan-711 F1);
   *  - records the project's resume pair, so the NEXT boot on a bare URL comes
   *    back here instead of the demo model (plan-702 Phase 3, see below).
   */
  async openDocument(
    documentId: string,
    opts: { name?: string; updateUrl?: boolean } = {},
  ): Promise<void> {
    const row = this._documentRow(documentId);
    if (!row) throw new Error(`Document ${documentId} not found`);
    const name = opts.name?.trim() || row.name || row.id;
    const base: SceneBase = { kind: 'builtin', url: projectAssetUrl(row.path), label: name };
    await this._loadIntoWorkspace(makeDraftScene(base, name), null, {
      document: { id: row.id, path: row.path },
    });
    if (opts.updateUrl !== false) updateUrlDocumentParam(row.id);
    // AFTER the load, never inside it: `_loadIntoWorkspace`'s own
    // `setOpenDocumentBase` block is a pinned characterisation surface
    // (plan-716 §9.3) and Phase 4 owns the decision to rewrite it. This is the
    // documented upgrade-only write instead — it can only ADD an identity the
    // funnel could not express, never clear one.
    this._publishDocumentIdentity();
    // The project's resume point, written HERE and not at the call sites
    // (plan-702 Phase 3). Every opening way — the dashboard, `openScene`,
    // `openBuiltin(rvproject:)`, `newEmpty`, the `?doc=` route, the boot resume,
    // the MCP openers — comes through this method, so the pair exists for all of
    // them without any caller having to remember it. Instrumenting the call
    // sites instead is exactly what produced the bug this fixes: two of them had
    // the write, the funnel had none, and Save / `?doc=` / MCP therefore left the
    // pair empty and every bare-URL reload fell back to the demo model.
    //
    // The mode comes from the viewer the store already holds; no new dependency
    // is created for it. An open is never transient here — `openDocument` calls
    // `_loadIntoWorkspace` WITHOUT `transient`, and the transient openers
    // (`openTransient`, `openPublished`, `openPublishedExample`) deliberately do
    // not forward onto this verb (§2.5: a source is not a document). So the rule
    // `_loadIntoWorkspace` applies to the active-scene pointer — foreign content
    // leaves no trace — holds here by construction rather than by a guard.
    // `modes?.` although the type says it is always there: a resume hint is
    // "never a precondition for a working viewer" (`rv-project-resume-store`),
    // and reading one must not be the thing that fails an open. A viewer built
    // without a mode manager — an embedding, a harness — records a pair without
    // a mode, which `rememberedSessionOf` treats as valid and the boot completes
    // from the globally persisted mode.
    rememberSession(
      getProjectStore().getProject()?.id,
      row.id,
      this._viewer.modes?.activeMode ?? null,
    );
    this._notify();
  }

  /**
   * The manifest row `idOrScn` names, or null.
   *
   * One lookup for all four call sites (open, the save-target resolution, the
   * `openScene` forward, the `openBuiltin` forward) so the alias tolerance
   * cannot be applied in three places and forgotten in the fourth.
   */
  private _documentRow(idOrScn: string): RvDocumentEntry | null {
    if (!idOrScn) return null;
    const id = resolveDocumentId(idOrScn);
    const documents = documentsOf(getProjectStore().getProject());
    return documents.find(d => d.id === id) ?? null;
  }

  /**
   * Open a saved scene by id.
   *
   * A thin forward since plan-716 Phase 3: an id that names a document (which,
   * after the eager migration, is every id the user can still reach) goes
   * straight to {@link openDocument}. The legacy catalogue read below survives
   * only for what the migration deliberately did not convert — a folder
   * project's cache rows (§2.3 step 0) and a profile whose migration has not run
   * yet — and it goes with the rest of the catalogue in Phase 6.
   */
  async openScene(id: string): Promise<void> {
    const row = this._documentRow(id);
    if (row) return this.openDocument(row.id);
    // With lazy project hydration the body may not be cached yet. Without
    // this pre-fetch, a Models-panel click and `web_scene_open` would both
    // throw "Scene <id> not found" on a perfectly valid project scene.
    if (!readScene(id)) await this.ensureSceneHydrated(id);
    const scene = readScene(id);
    if (!scene) throw new Error(`Scene ${id} not found`);
    // The op-log draft slot used to be consulted here. It is gone (plan-413
    // phase 6) — an autosave has been a GLB body since plan-397 phase 6, and
    // `_loadIntoWorkspace` resolves that through the storage layer.
    await this._loadIntoWorkspace(scene, scene);
    // Reflect the choice in the URL so a browser reload re-opens the same
    // saved scene. Without this, `?scene=` stays empty and reload falls
    // through to the legacy default-model boot path (which then clears the
    // active-id pointer via markGlbActive — see scene-store.ts).
    updateUrlSceneParam(scene.id, baseLabelForOption(scene.base));
  }

  /**
   * Open a built-in on a fresh workspace.
   *
   * `opts.updateUrl: false` keeps the address bar untouched — used by the
   * default-model boot in main.ts so a bare `/` stays a bare `/` instead of
   * being rewritten to `?scene=builtin:<default>.glb` on every reload.
   */
  async openBuiltin(url: string, label: string, opts?: { updateUrl?: boolean }): Promise<void> {
    // plan-716 §2.5 — the `rvproject:` half is a DOCUMENT open wearing a URL.
    // Forwarded so it gains the three things only `openDocument` provides (draft
    // slot by document id, `?doc=`, cross-mode identity) while the bundled/http
    // half — a SOURCE — keeps every byte of its behaviour.
    const relPath = projectAssetRelPath(url);
    if (relPath !== null) {
      const row = documentsOf(getProjectStore().getProject()).find(d => d.path === relPath);
      if (row) {
        return this.openDocument(row.id, {
          name: label,
          ...(opts?.updateUrl !== undefined ? { updateUrl: opts.updateUrl } : {}),
        });
      }
    }
    const base: SceneBase = { kind: 'builtin', url, label };
    const scene = makeDraftScene(base, label);
    await this._loadIntoWorkspace(scene, null);
    if (opts?.updateUrl !== false) {
      updateUrlSceneParam(urlValueForBase(base), baseLabelForOption(base));
    }
  }

  /**
   * Open a "published" scene — a read-only GLB served from the deploy root
   * (`scenes/<name>.glb`), routed via `?scene=published:<name>`. `name` only
   * keeps the URL stable across reloads.
   *
   * ## It takes a URL now, not a scene (plan-413 phase 3)
   *
   * It used to take an already-parsed `RvScene`: the caller fetched a
   * `.scene.json`, and this method validated the op log before handing it on.
   * Examples are GLBs since phase 3, so there is no JSON to parse and nothing
   * to validate here — the bytes are a model, and the model loader is the one
   * that judges them. What is left is exactly the difference between an example
   * and any other transient content: it has a NAME, and the address bar has to
   * say so.
   *
   * **Docstring correction (plan-386 Phase 3).** This comment used to claim
   * that "a shared public link has no side effects on the visitor's stored
   * scenes". That was false for two years: the load ran
   * `setActiveSceneId(saved?.id ?? null)` with `saved === null`, which
   * *deleted* the visitor's active-scene pointer, and the debounced autosave
   * wrote a draft as soon as he moved anything. The claim is true now because
   * {@link openTransient} makes it true — see there for what "transient"
   * actually enforces. A comment is not a mechanism; this one is kept only to
   * name the defect it used to hide.
   */
  async openPublished(url: string, name: string, label?: string): Promise<void> {
    const title = label?.trim() || name;
    // The same shape a shared `?glb=` link builds (plan-386): a draft over a
    // `builtin` base pointing at the bytes. `scene-glb` would be wrong here —
    // that base names a scene ID for the storage layer to resolve, and an
    // example has no body in the visitor's OPFS store and must not acquire one.
    const scene = makeDraftScene({ kind: 'builtin', url, label: title }, title);
    await this.openTransient(scene);
    // Mark which example is active so the Examples row can highlight (transient
    // scenes have no saved id / non-builtin base to match against).
    this._activePublishedName = name;
    // The URL update belongs HERE and not in `openTransient`: a published
    // example is addressable by name, a shared `?glb=` link is not, and
    // rewriting the address bar under a shared link would replace it with a
    // path that does not exist (plan-386 F18/R11).
    updateUrlSceneParam(`published:${name}`, baseLabelForOption(scene.base));
    this._notify();
  }

  /**
   * Open foreign content that must leave **no trace** on the visitor
   * (plan-386 §2.5).
   *
   * Two callers, one need. `openPublished()` shows a read-only example that
   * ships with the deploy; the plan-386 escalation shows a GLB somebody mailed
   * a link to. Neither may write the visitor's active-scene pointer, his draft
   * bodies or his address bar — and neither may READ from his slots either:
   * without `transient`, an empty-based scene probes `draft/empty`, which is
   * exactly where an unsaved empty workspace autosaves, so the visitor's own
   * draft would load *instead* of the content and the content's op log would be
   * discarded on the way.
   *
   * Editing stays fully available. The op log, undo and redo are in memory and
   * always were; only the writes are gone. That is deliberate — a viewer who
   * may not move anything is not a viewer, and the escalation exists precisely
   * so he can try things out.
   *
   * ## Failure leaves nothing behind
   *
   * `_loadIntoWorkspace` installs the new workspace *before* awaiting the load,
   * so a foreign GLB that fails to parse would otherwise leave a half-built
   * workspace on screen — worse than the failure itself, because the visitor
   * would then be looking at the wreck of somebody else's file instead of his
   * own scene. The workspace state is therefore captured and restored on
   * failure (§9.4 `transient_FailedLoad_LeavesStateUntouched`), and the error
   * is re-thrown for the caller to report.
   */
  async openTransient(scene: RvScene): Promise<void> {
    // The contract phase 3 made enforceable: foreign content arrives as BYTES.
    // Every caller builds its scene locally over a GLB base (`makeDraftScene`),
    // so the op log is empty by construction — and a future caller that goes
    // back to parsing a `.scene.json` off the network and handing the result in
    // here finds out at the door — phase 6 removed both the executors that
    // would have replayed those ops and the reader that produced them.
    if (scene.edits.ops.length > 0) {
      throw new Error(
        'A transient scene carries no op log of its own — its body is the GLB it names (plan-413 §2.6).',
      );
    }
    const before = this._captureWorkspace();
    try {
      await this._loadIntoWorkspace(scene, null, { transient: true });
    } catch (e) {
      this._restoreWorkspace(before);
      throw e;
    }
  }

  private _captureWorkspace(): WorkspaceSnapshotState {
    return {
      workspace: this._workspace,
      settings: { ...this._settings },
      baselineOps: this._ops.slice(0, this._doc.baselineFloor),
      ops: [...this._ops],
      redoStack: this._doc.captureHistory().redoOps,
      saved: this._saved,
      activePublishedName: this._activePublishedName,
    };
  }

  private _restoreWorkspace(state: WorkspaceSnapshotState): void {
    this._workspace = state.workspace;
    this._settings = state.settings;
    this._doc.restoreHistory({
      ops: [...state.ops],
      redoOps: [...state.redoStack],
      baselineIds: state.baselineOps.map((o) => o.id),
      baselineFloor: state.baselineOps.length,
      metaDirty: false,
    });
    this._saved = state.saved;
    this._activePublishedName = state.activePublishedName;
    this._notify();
  }

  /** Is the open workspace holding foreign content that persists nothing? */
  isTransient(): boolean {
    return this._workspace?.transient === true;
  }

  // ─── Projection handover (plan-711 §2.2, F2) ────────────────────────

  /**
   * The identity of the document this store has open, or null.
   *
   * The same statement `_loadIntoWorkspace` writes into the cross-mode handle,
   * asked of the store directly — because the BIND may not read that handle: a
   * global "who is showing what" pointer is a lookup, and the doctrine
   * (rv-document-stack.ts:11-19, plan-710 R1) is that a living document is
   * HANDED OVER, never looked up. The editor compares identities, and then asks
   * this store for the instance.
   *
   * Narrow on purpose, exactly as over there: a scene identity is the SAVED
   * scene, so a fork (which keeps the source's base while being a different,
   * unsaved document) answers null rather than the original's id — the false
   * positive `sameDocumentBase` exists to avoid (plan-711 risk 8).
   *
   * An UNSAVED workspace on a builtin model answers too (the plan-711 /fix):
   * its stable URL is the very identity `_loadIntoWorkspace` publishes as
   * "what is on screen", so both sides of the editor's comparison come from
   * the same load and the fork false-positive cannot arise. Without this
   * branch a mode switch on the demo scene reopened the base FILE from bytes,
   * and everything the scene had placed on top was simply not there.
   */
  documentIdentity(): AssetBase | null {
    const base = this._workspace?.base;
    if (!base || this._workspace?.transient) return null;
    // plan-716 §2.5 / R1-I5 — the Phase-3 transition, stated in one line: the
    // CONSTRUCTOR and its signature are untouched, and the value handed to it is
    // the documentId. Phase 4 collapses the kind itself; until then a document
    // and a saved scene answer in the same shape, which is what keeps
    // `sameDocumentBase` — and therefore the plan-711 bind — working across the
    // change. The dashboard writes the identical shape for its scene cards
    // (`sceneDocumentBase(row.id, …)`), so the two can only agree.
    const documentId = this._workspace?.documentId;
    if (documentId) {
      // The row's path travels IN the identity: a document is a file, and the
      // editor that binds this identity must see where it lives — that is what
      // lets its breadcrumb name the real location instead of "Scenes", and
      // what keeps a re-open after the bind addressed by path. `sameDocumentBase`
      // compares `documentId` alone, so carrying the path changes no pairing.
      return documentBase(
        documentId,
        this._workspace?.name || documentId,
        this._workspace?.documentPath ?? '',
      );
    }
    const saved = this._saved;
    if (saved && base.kind === 'scene-glb' && base.sceneId === saved.id) {
      return sceneDocumentBase(saved.id, this._workspace?.name || saved.name);
    }
    if (base.kind === 'builtin' && !isBytesSourceUrl(base.url)) {
      return { kind: 'builtinModel', url: base.url, name: this._workspace?.name || base.label };
    }
    return null;
  }

  /**
   * Publish {@link documentIdentity} into the cross-mode handle (plan-711 F1).
   *
   * `_loadIntoWorkspace` writes that handle for every OPEN, which is where the
   * identity comes from when a scene is loaded. It is not the only way a
   * workspace acquires one: the FIRST SAVE of a draft mints the scene id, turns
   * the workspace base into `scene-glb` and thereby makes the document
   * identifiable — without going through a load. Until this call existed the
   * handle kept saying what the workspace was BEFORE the save (for the demo
   * scene: `builtinModel`), so `_resolveOpenPlan` compared the pre-save base
   * against a post-save identity, `sameDocumentBase` answered false, and the
   * editor opened the raw base model as a SECOND document — the bind branch was
   * unreachable for every scene saved in this session (e2e
   * `shared-document-continuity.spec.ts` skipped on exactly this).
   *
   * Only ever an upgrade, never a clear: when the save produced no identity
   * (a scene whose body write returned no revision keeps its `builtin` base),
   * the handle still describes what is on screen correctly, and overwriting it
   * with `null` would throw that fact away for no gain.
   */
  private _publishDocumentIdentity(): void {
    const identity = this.documentIdentity();
    if (identity) setOpenDocumentBase(identity);
  }

  /**
   * Hand the LIVING document over to another projection (plan-711 §2.2).
   *
   * Explicit passing, not a lookup — the whole point of "bind at transition".
   * The caller (the asset editor) has already established that the base it is
   * about to open is `sameDocumentBase` as {@link documentIdentity}; this is
   * where the instance itself crosses over, together with the two things the
   * other side cannot produce for itself:
   *
   *  - `bakeBytes()` — the scene state as BYTES. Per Spike (a) that is the only
   *    way scene ops reach the editor at all: `applyForward` cannot materialise
   *    a placement without the layout planner, while the bake writes exactly
   *    the reference nodes the editor then authors against.
   *  - `release()` — the way back, which adopts the authored tree as the new
   *    bake SOURCE (Spike (b), the "projizierter Baum" rule) and flushes the
   *    autosave that was suspended for the whole binding.
   *
   * The store keeps the document: it is shared, not surrendered. What it gives
   * up for the duration is the right to WRITE — see `_projectionSuspended`.
   */
  beginProjectionHandover(): RvSceneProjectionHandover | null {
    const base = this.documentIdentity();
    if (!base || this._projectionSuspended) return null;
    // A write scheduled but not yet run is work this store still owes, and the
    // suspension is about to take its timer away — so it is carried, not lost.
    this._projectionDeferredWrite = this._draftAutosaveTimer !== null;
    this._cancelAutosave();
    this._projectionSuspended = true;
    // From here the OTHER projection writes this document's op draft, and the
    // record outlives its writer — so this store has to know one exists in
    // order to drop it when the document is clean again (plan-711 §2.4).
    this._sharedFrameMayExist = true;
    this._notify();
    return {
      document: this._doc,
      base,
      name: this._workspace?.name ?? '',
      bakeBytes: () => this._bakeCurrent(),
      bytesCache: () => this._bytesCacheFor(),
      release: (opts) => this.endProjectionHandover(opts),
    };
  }

  /** True while another projection of this document is on screen. */
  get projectionSuspended(): boolean { return this._projectionSuspended; }

  /**
   * Take the document back (plan-711 §2.2, R2-Q1).
   *
   * `authoredBytes` is the export of the tree the editor was authoring, and it
   * REPLACES this store's bake source. That is the §2.3 bake rule the spike
   * settled: the eleven asset-lineage kinds have no overlay vocabulary
   * (`materialise` drops them silently, MESSUNG b1/b2), so the only way a scene
   * save can carry the editor's structural work is for the bake to start from
   * the authored tree instead of from the untouched base bytes. The scene
   * overlay is then baked on top exactly as before — the format is untouched,
   * which is the plan-710 decision this had to respect.
   */
  endProjectionHandover(opts?: { authoredBytes?: ArrayBuffer }): void {
    if (!this._projectionSuspended) return;
    if (opts?.authoredBytes) this.adoptProjectedBaseBytes(opts.authoredBytes);
    this._projectionSuspended = false;
    // Flush what the suspension held back. Through `_afterOpsChanged` rather
    // than straight into `_autosaveBody`, so the write goes through the one
    // path that knows about transient workspaces, the pristine-saved case and
    // the debounce — the flush is "the change is announced now", not "write
    // this instant".
    if (this._projectionDeferredWrite) {
      this._projectionDeferredWrite = false;
      this._afterOpsChanged();
      return;
    }
    this._notify();
  }

  /**
   * Show the open workspace again from its CURRENT base bytes — without
   * touching the op log (plan-711 §2.2, the way back).
   *
   * Deliberately NOT `openScene()`. Every open path runs `_installOps`, which
   * REPLACES the document's history with the stored scene's — and on the return
   * from a bound editor session that history is the one thing that must
   * survive, because it is where the user's unsaved work (both projections'
   * worth) lives. So this is the load half of an open with the history half
   * left out, which is precisely what a recompose asks its host for.
   *
   * The bytes are whatever {@link adoptProjectedBaseBytes} last installed, i.e.
   * the authored tree the editor exported. They already contain BOTH halves —
   * the scene overlay came in through the bake on the way over, the editor's
   * structure was authored on top — which is why the caller replays nothing
   * onto this tree.
   */
  async reprojectFromBaseBytes(): Promise<void> {
    const workspace = this._workspace;
    if (!workspace) return;
    const bytes = await this._ensureBaseBytes();
    if (!bytes) throw new Error('The scene could not be shown again — its bytes are unavailable.');
    this._loading = true;
    this._busy = true;
    this._notify();
    try {
      const url = this._installBodyUrl(new Uint8Array(bytes));
      await this._viewer.loadScene({
        id: workspace.id,
        name: workspace.name,
        base: { kind: 'builtin', url, label: baseLabelOf(workspace.base) },
        createdAt: workspace.createdAt,
        modifiedAt: new Date().toISOString(),
        schemaVersion: RV_SCENE_SCHEMA_VERSION,
        parentId: workspace.parentId,
        description: workspace.description,
        // EMPTY on purpose, exactly as `_resolveLoad` hands a body-backed scene
        // over: the bytes already are the ops. The document's own log is
        // untouched and stays the truth.
        edits: { ops: [], settings: { ...this._settings } },
      });
      // The same adoption a body-backed load performs — the placements in these
      // bytes are reference nodes the planner has to be told about, or the user
      // comes back to a layout they cannot select.
      this._adoptFromLoadedGlb({ persistCamera: false });
    } finally {
      this._loading = false;
      this._busy = false;
      this._notify();
    }
  }

  /**
   * Install `bytes` as what this workspace's overlay is baked onto.
   *
   * Keyed exactly like `_ensureBaseBytes` computes its key, so the next bake
   * finds these bytes instead of re-fetching the base.
   */
  adoptProjectedBaseBytes(bytes: ArrayBuffer): void {
    const base = this._workspace?.base;
    if (!base) return;
    this._setBaseBytes(base.kind === 'empty' ? 'empty' : baseKeyOf(base), bytes);
  }

  // ─── The one draft truth (plan-711 §2.4, F5) ─────────────────────────

  /**
   * The stamp for the slot this workspace would autosave into, or null.
   *
   * Slot-checked rather than returned raw: `_writeBody` also writes COMMITTED
   * bodies, and a stamp describing the committed slot would tell a recovery
   * that the draft slot holds a prefix it does not hold.
   */
  private _bytesCacheFor(): RvDraftBytesCache | null {
    const cache = this._bytesCache;
    if (!cache) return null;
    return cache.slot === this._bodySlots().draft ? cache : null;
  }

  /**
   * Drop the shared document's op draft once the document is clean.
   *
   * The record's WRITER is the editor facade, and it is gone by the time a
   * scene save makes the document clean — so without this the one truth would
   * outlive the work it describes and come back at the next open as unsaved
   * changes that were saved. Best-effort and fire-and-forget, exactly like
   * every other draft write: a net that fails to clear is a nuisance, a save
   * that waits on IndexedDB is a stall.
   */
  private _dropSharedDraftIfClean(): void {
    if (!this._sharedFrameMayExist || this._doc.dirty) return;
    const frame = sharedDocumentFrame(this.documentIdentity());
    this._sharedFrameMayExist = false;
    if (frame) void clearDocumentDraft(frame);
  }

  /**
   * What a crash left behind for the scene this store is about to open.
   *
   * Both records are read here and arbitrated by ONE rule
   * ({@link decideDocumentRecovery}) rather than by whichever path happens to
   * look first — that is the whole of "one recovery truth". Null whenever the
   * scene has no shared identity to recover under, which is every scene that
   * was never bound into the editor.
   */
  private async _planDocumentRecovery(
    scene: RvScene,
    saved: RvScene | null,
  ): Promise<RvDocumentRecovery | null> {
    const base = scene.base;
    if (!saved || base.kind !== 'scene-glb' || base.sceneId !== saved.id) return null;
    const frame = sharedDocumentFrame(sceneDocumentBase(saved.id, scene.name));
    if (!frame) return null;
    const record = await loadDocumentDraft(frame);
    if (!record) return null;
    const slot = `draft/${saved.id}`;
    let revision: string | null = null;
    try {
      revision = (await (await sceneGlbIo()).sceneGlbBodyRevision?.(slot)) ?? null;
    } catch {
      // A revision that cannot be read is a cache that cannot be proven, which
      // is the `unstamped` verdict below — never a reason to drop the record.
      revision = null;
    }
    return decideDocumentRecovery({
      frame: record,
      bytes: revision ? { slot, revision } : null,
      projection: 'scene',
    });
  }

  /**
   * Would a reload lose work? A stricter question than `dirty`, and the one the
   * unload guard has to ask.
   *
   * `dirty` means "differs from the named save", which for a normal workspace is
   * a routine state: the debounced body autosave carries those edits across an
   * F5, so warning about them would train the user to click through the warning.
   * Two states genuinely lose work:
   *
   *   • **transient** — `_afterOpsChanged` never even schedules the timer, by
   *     design (a shared link must not write itself into the visitor's profile).
   *     Every edit here lives only in memory, so any edit at all is at risk.
   *   • **a scheduled write that has not run** — the debounce window is real
   *     time, and a reload inside it drops whatever the timer was going to save.
   */
  hasUnpersistedWork(): boolean {
    if (!this._workspace) return false;
    if (this._workspace.transient) return this._doc.dirty;
    // The timer criterion moved to the document as a callback (plan-710 F7), so
    // both lineages answer the unload guard through one mechanism. The value is
    // unchanged — this still reads `_draftAutosaveTimer`, one indirection out.
    return this._doc.hasUnpersistedWork();
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
    this._notify();                // disable the rows immediately (load precedes _loadIntoWorkspace)
    try {
      await this.openPublished(publishedSceneUrl(entry.file), entry.urlName, entry.label);
      this._applyMode(entry.mode);
    } finally {
      this._busy = false;
      this._notify();
    }
  }

  /**
   * Import an "Example" into the user's project as a fresh, fully editable
   * DOCUMENT, then open it. This is the "make the demo mine" path. Returns the
   * new documentId.
   *
   * ## A source materialises a document (plan-716 F1, Phase 6)
   *
   * An Example is a read-only SOURCE: nothing owns its bytes, and the whole
   * point of this verb is that afterwards something does. Until Phase 6 that
   * "something" was a `scn_` catalogue row over an OPFS body — the last place in
   * the product that minted a scene id, and the reason a demo the user had made
   * his own was still a second-class artefact: not in `documents[]`, not
   * placeable into another layout, not addressable by `?doc=`.
   *
   * It now goes through the same create seam as "New" and `saveAs`, so the copy
   * is a file in the project with a manifest row from its first instant, and the
   * name probe that keeps repeated imports apart is `planDocument`'s rather than
   * a second one spelled here.
   */
  async addPublishedToMyScenes(entry: PublishedSceneEntry): Promise<string> {
    if (this._busy) throw new Error('A scene operation is already in progress.');
    this._busy = true;
    this._notify();
    try {
      // Fetched BEFORE anything is created: a deploy still serving JSON under a
      // `.glb` name must fail with "not a GLB" and leave no half-made document.
      const glb = await this._fetchPublishedGlb(entry);
      const created = await this._createDocument(entry.label, glb as unknown as BlobPart);
      if (!created) {
        throw new Error('There is no writable project to import the example into.');
      }
      await this._noteDocumentRevisionOf(created.relPath, toArrayBuffer(glb));
      await this.openDocument(created.documentId);
      this._applyMode(entry.mode);
      return created.documentId;
    } finally {
      this._busy = false;
      this._notify();
    }
  }

  /**
   * Fetch the bytes of a published example.
   *
   * Only the "make it mine" path needs them in hand — opening one hands the
   * URL to the model loader and never touches the bytes here, which is why
   * this is not on the open path any more (plan-413 phase 3).
   *
   * The GLB magic is checked because the alternative failure is worse than a
   * message: a deploy still serving the old `.scene.json` under a `.glb` name
   * would otherwise be written into the user's own body slot as a scene that
   * can never load.
   */
  private async _fetchPublishedGlb(entry: PublishedSceneEntry): Promise<Uint8Array> {
    const resp = await fetch(publishedSceneUrl(entry.file), { cache: 'no-store' });
    if (!resp.ok) throw new Error(`Failed to fetch example scene ${entry.file}: HTTP ${resp.status}`);
    const bytes = new Uint8Array(await resp.arrayBuffer());
    if (bytes.byteLength < 12
      || new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true) !== GLB_MAGIC) {
      throw new Error(`Invalid example scene (not a GLB): ${entry.file}`);
    }
    return bytes;
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
    // plan-716 F5 — "New" MINTS A DOCUMENT. It used to leave an anonymous draft
    // that only became real on the first save (and, before Phase 3, became a
    // `scn_` catalogue row when it did). A document from the outset is what
    // makes the row survive a reload, be renamable, and be openable by `?doc=`
    // before anything has been saved into it.
    //
    // Only when there is somewhere to put it. Without a writable project — a
    // read-only deploy, a bundled demo, a unit test — the empty-base draft below
    // is still the honest answer: the workspace works, and the first save is the
    // moment the question "where does this live?" has to be answered anyway.
    const created = await this._createDocument('Untitled').catch((e) => {
      console.warn('[scene-store] a new document could not be created:', e);
      return null;
    });
    if (created) {
      await this.openDocument(created.documentId);
      return;
    }
    clearDraft({ kind: 'empty' });
    return this._openEmptyDraft();
  }

  /**
   * Place an empty (or byte-seeded) document in the writable project, or null.
   *
   * The one create seam of this store, shared by "New", the first save of a
   * draft and `saveAs` — so the name probe, the create-only write and the
   * manifest row can only be spelled one way.
   */
  private async _createDocument(
    name: string,
    bytes?: BlobPart,
    folder?: string,
  ): Promise<{ documentId: string; relPath: string; name: string } | null> {
    const store = getProjectStore();
    if (!store.getBackend()?.writable) return null;
    const { createDocument } = await import('../../project/rv-document-ops');
    return createDocument(store, name, {
      ...(bytes !== undefined ? { bytes } : {}),
      // `!== undefined`, not truthiness: '' is the project root, a real folder.
      ...(folder !== undefined ? { folder } : {}),
    });
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
    // plan-716 §2.5 — a forward, and deliberately not to `openDocument`.
    //
    // This is the BOOT path (`?scene=empty`), and its whole job is to resume
    // what the user had. Minting a document here would create one on every
    // reload of an untitled workspace — a new row per F5 — which is the opposite
    // of resuming. So it forwards to the shared draft routine that `newEmpty`
    // falls back to, and the first SAVE is what turns the resumed workspace into
    // a document (one save path, §2.5).
    return this._openEmptyDraft();
  }

  /** The empty-base draft, resumed. Shared by `openEmpty` and `newEmpty`. */
  private async _openEmptyDraft(): Promise<void> {
    const base: SceneBase = { kind: 'empty' };
    const scene = makeDraftScene(base, 'Untitled');
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
  private async _loadIntoWorkspace(
    scene: RvScene,
    saved: RvScene | null,
    opts: { transient?: boolean; document?: { id: string; path: string } } = {},
  ): Promise<void> {
    this._cancelAutosave();
    // Any normal open clears the "active example" marker; openPublished() re-sets
    // it after this returns.
    this._activePublishedName = null;
    this._loading = true;
    this._busy = true;
    // The document binding is installed with the shell and BEFORE `_resolveLoad`
    // runs (plan-716 §2.5): the slot that load probes is `draft/<documentId>`,
    // and a binding applied afterwards would have it probe the base-keyed slot
    // instead — i.e. miss the draft the migration moved onto the new id (§2.3e).
    this._workspace = {
      ...workspaceShellOf(scene),
      transient: opts.transient === true,
      ...(opts.document
        ? { documentId: opts.document.id, documentPath: opts.document.path }
        : {}),
    };
    this._settings = { ...scene.edits.settings };
    // Baseline = the scene's clean (last-persisted) state. `_installOps` puts
    // it in as the document's baseline ids AND its undo floor; dirty falls out
    // of comparing the log against those ids.
    //   • Saved scene  → baseline = the saved scene's ops; identical to
    //                    current on open, so dirty=false until the user
    //                    edits.
    //   • Built-in / fork / restored draft (saved=null) → baseline = empty
    //                    (the unmodified base GLB). On a fresh open, ops=[]
    //                    so dirty=false. On a draft RESTORE the draft's
    //                    ops are non-empty, so dirty=true correctly — the
    //                    UI surfaces "Unsaved" immediately on reload until
    //                    the user explicitly saves or discards.
    this._installOps(scene.edits.ops, saved ? saved.edits.ops : []);
    this._saved = saved;
    this._notify();
    // Surface a centered loading overlay during scene/GLB swaps. The base
    // GLB parse + scene rebuild blocks the main thread for a few seconds
    // on larger models; without this hint the UI looks frozen. The
    // overlay is `pointerEvents:none` so it doesn't block any background
    // interactions that happen to remain responsive.
    const sceneLabel = scene.name || baseLabelOf(scene.base) || 'scene';
    showInfoOverlay(`Loading ${sceneLabel}…`);
    const perfT0 = performance.now(); // TEMP open-perf instrumentation
    let perfRecoveryMs = 0, perfResolveMs = 0, perfLoadMs = 0; // TEMP open-perf
    try {
      // plan-711 §2.4 — ONE recovery truth. A document that was shared with the
      // editor persists its log in the frame keyspace as well, and after a
      // crash that record is what describes it; the body slot below is the
      // bytes projection of a PREFIX of that same log. Asked before the load so
      // the verdict can decide what the load carries.
      const recovery = opts.transient === true
        ? null
        : await this._planDocumentRecovery(scene, saved);
      perfRecoveryMs = performance.now() - perfT0; // TEMP open-perf
      const resolved = await this._resolveLoad(scene, opts.transient === true);
      perfResolveMs = performance.now() - perfT0 - perfRecoveryMs; // TEMP open-perf
      let toLoad = resolved.scene;
      if (resolved.fromGlb) {
        // The body already contains every op — every op the STAMP accounts for,
        // that is. Leaving the legacy array in `_ops` would apply them a SECOND
        // time on the next save (the shape the phase-7 migrator makes
        // reachable); leaving the recovered TAIL out would lose the work made
        // after the last bake, which is the window a bound editor session opens.
        const tail = recovery?.truth === 'ops' ? recovery.tail : [];
        this._installOps(tail, []);
        if (tail.length > 0) {
          toLoad = { ...toLoad, edits: { ...toLoad.edits, ops: [...tail] } };
        }
        const note = recovery ? describeDocumentRecovery(recovery, sceneLabel) : null;
        if (note) console.warn('[scene-store]', note);
      }
      const loadOpts = {
        ...(resolved.identityUrl ? { identityUrl: resolved.identityUrl } : {}),
        ...(resolved.data ? { data: resolved.data } : {}),
      };
      { // TEMP open-perf instrumentation
        const t = performance.now();
        await this._viewer.loadScene(
          toLoad,
          undefined,
          Object.keys(loadOpts).length > 0 ? loadOpts : undefined,
        );
        perfLoadMs = performance.now() - t;
        debug('perf', `[open-perf] scene open "${sceneLabel}"`, {
          recoveryMs: Math.round(perfRecoveryMs),
          resolveMs: Math.round(perfResolveMs),
          loadSceneMs: Math.round(perfLoadMs),
          totalSoFarMs: Math.round(performance.now() - perfT0),
        });
      }
      // Adopt for a transient load too. A shared GLB carries its placements as
      // reference nodes exactly like a stored body does (plan-397 phase 6/7), so
      // the planner has to be told about them or an escalated visitor sees parts
      // he cannot select. The camera preset is the one thing NOT taken over:
      // `saveStartPos` writes localStorage, and a link somebody mailed must not
      // change what the visitor's own models look like on open (F7).
      if (resolved.fromGlb || opts.transient) {
        this._adoptFromLoadedGlb({ persistCamera: opts.transient !== true });
      }
      // A transient workspace does not own the active-scene pointer. Writing it
      // here — even as `null`, which is what `saved` is on this path — is the
      // documented R5 defect: opening a shared link would delete the visitor's
      // own active scene (F7).
      if (opts.transient !== true) setActiveSceneId(saved?.id ?? null);
      // Record WHAT is now on screen for a mode that takes over later. Every
      // open path funnels through here, so the fact can never go stale the way
      // the per-call-site writes did (a builtin opened at boot had no writer,
      // and the editor then opened "Untitled" over a loaded demo). A `builtin`
      // base with a stable URL is identifiable; everything else clears the fact
      // — a MORE specific identity (e.g. the dashboard's `projectDocument`)
      // is written by that caller after this returns, and wins. Not persisted,
      // so a transient open still leaves no trace.
      //
      // plan-711 F1 closes the third case: a SAVED SCENE. It used to fall into
      // the `null` branch, which is why "the editor is about to open the scene
      // that is already on screen" was not a question the code could ask.
      //
      // The condition is deliberately narrower than `isGlbBase(scene.base)`:
      // the identity is the SAVED scene (`saved.id`), not the base's `sceneId`.
      // `forkFromBase` produces a draft that KEEPS the source scene's base
      // while being a different, unsaved document — keying off the base alone
      // would hand a copy the original's identity, which is exactly the false
      // positive `sameDocumentBase` is written to avoid (risk 8).
      //
      // ── plan-716 §9.3: the transient open KEEPS publishing. Decided. ──────
      //
      // This block runs for EVERY open, transient ones included, and a
      // transient open over an http URL satisfies the `builtin` branch below.
      // plan-716 Phase 4 names that as a fork to be taken deliberately rather
      // than inherited, so: it stays. The alternative — guarding the whole
      // block on `opts.transient` — was rejected for three reasons.
      //
      // 1. It does not violate the doctrine; it IS the doctrine. "Sources are
      //    not documents" is a statement about the KIND, and the transient
      //    branch can only ever publish `builtinModel` — a SOURCE kind, which
      //    the Phase-4 collapse deliberately left standing. It never publishes
      //    `document`, and it cannot: `saved` is null on this path, so the
      //    second branch is unreachable for a transient open. The invariant is
      //    asserted rather than asserted-by-comment (see the pin in
      //    open-paths-characterization.test.ts).
      //
      // 2. plan-386 F7 promises transient opens PERSIST nothing. This handle is
      //    explicitly not persisted (`setOpenDocumentBase`'s own doc: "it
      //    describes this tab right now"), and the persistent write on the line
      //    above is already guarded. Guarding an in-memory pointer would buy
      //    nothing the promise asks for.
      //
      // 3. Guarding it would REINTRODUCE a fixed defect. With no handle, a mode
      //    switch during a shared-link session finds nothing on screen and
      //    opens "Untitled" over the visitor's loaded content — the exact
      //    failure the paragraph above records as the reason this block exists.
      //    And `decideSaveVerb` on the published `builtinModel` answers
      //    `save-into-project` with `copies: true`, i.e. "make it mine", which
      //    is precisely the source→document materialisation §2.6 prescribes.
      //
      // `documentIdentity()` still answers null for a transient workspace, and
      // that is not a contradiction with this line — the two answer different
      // questions. `documentIdentity()` says WHICH DOCUMENT this is, for
      // binding, handover and draft frames; a transient workspace has none.
      // This handle says WHAT IS ON SCREEN, and "somebody else's source" is a
      // legitimate answer to that. Phase 4 makes the distinction typed rather
      // than conventional: `documentIdentity()` can only return `document` or
      // null, while this handle may also return a source kind.
      const b = scene.base;
      setOpenDocumentBase(
        b.kind === 'builtin' && !isBytesSourceUrl(b.url)
          ? { kind: 'builtinModel', url: b.url, name: scene.name || b.label }
          : saved && b.kind === 'scene-glb' && b.sceneId === saved.id
            ? sceneDocumentBase(saved.id, scene.name || b.label)
            : null,
      );
    } finally {
      this._loading = false;
      this._busy = false;
      hideInfoOverlay();
      this._notify();
    }
  }

  // ─── GLB bodies (plan-397 phase 6) ──────────────────────────────────

  /**
   * The storage slot a workspace's body lives in.
   *
   * Three slots, mirroring the three localStorage draft keyspaces exactly:
   * a saved scene's committed body, a saved scene's unsaved draft, and an
   * unsaved workspace's draft keyed by its base. The split is not cosmetic —
   * folding the draft into the committed body would overwrite the saved scene
   * on every keystroke and make "discard changes" a lie.
   */
  private _bodySlots(): { draft: string; saved: string | null } {
    const saved = this._saved?.id ?? null;
    // A DOCUMENT owns no committed body slot — its file is the persistence — but
    // it does own a draft slot, and since plan-716 §2.4 that slot is named after
    // the document id rather than after the base key. Two reasons, both hard:
    // the migration renames Form-C drafts to exactly `draft/<documentId>`
    // (§2.3e), so any other spelling makes a converted autosave unreachable; and
    // a base key derived from the `rvproject:` URL moves when the file is
    // renamed, which would silently orphan the draft of a renamed document.
    const documentId = this._workspace?.documentId;
    if (documentId) return { draft: `draft/${documentId}`, saved: null };
    // A workspace bound to a document by an in-place save but opened before this
    // phase (no `documentId` on the shell) keeps the base-keyed slot it has been
    // writing all session.
    if (saved && !this._workspace?.documentPath) return { draft: `draft/${saved}`, saved };
    const base = this._workspace ? baseKeyOf(this._workspace.base) : 'unknown';
    return { draft: `draft/${base}`, saved: null };
  }

  /**
   * Turn a workspace scene into something `viewer.loadScene` can load.
   *
   * A GLB body wins over the op log when one exists, because it *is* the op
   * log — folded in. The scene handed to the viewer therefore carries a
   * transient `builtin` base over an object URL and an empty op array, while
   * the workspace keeps the base it was opened from. Keeping the two apart is
   * what lets a draft body resume without the workspace forgetting that it
   * started life on a built-in.
   */
  private async _resolveLoad(
    scene: RvScene,
    transient = false,
  ): Promise<{ scene: RvScene; fromGlb: boolean; identityUrl?: string; data?: ArrayBuffer }> {
    const slots = this._bodySlots();
    // The base URL the workspace was opened from, kept for the return below.
    // The resolved base is a blob: object URL — bytes, not identity — and every
    // consumer downstream that asks "which model is this?" (model plugins,
    // camera presets, the model selector) would otherwise read a random UUID.
    // That is what silently stripped the demo scene's whole HMI plugin pack on
    // any reload after the first autosave.
    const identityUrl = scene.base.kind === 'builtin' ? scene.base.url : undefined;
    // A transient scene brings its own body with it and owns no slot. Probing
    // for one would hand it a body belonging to whatever the visitor was doing
    // before — see `openPublished`.
    const candidates = transient
      ? (scene.base.kind === 'scene-glb' ? [scene.base.sceneId] : [])
      : [slots.draft, ...(slots.saved ? [slots.saved] : [])];
    if (!transient && scene.base.kind === 'scene-glb') candidates.push(scene.base.sceneId);

    for (const slot of candidates) {
      let body: Awaited<ReturnType<SceneGlbIo['readSceneGlbBody']>>;
      try {
        body = await (await sceneGlbIo()).readSceneGlbBody(slot);
      } catch {
        continue;
      }
      if (!body) continue;

      this._setBaseBytes(`slot:${slot}:${body.revision}`, toArrayBuffer(body.glb));
      this._noteSlotRevision(slot, body.revision);
      const url = this._installBodyUrl(body.glb);
      return {
        scene: {
          ...scene,
          base: { kind: 'builtin', url, label: baseLabelOf(scene.base) },
          edits: { ...scene.edits, ops: [] },
        },
        fromGlb: true,
        identityUrl,
      };
    }

    // No GLB body: the legacy path, unchanged. A `scene-glb` base with no
    // resolvable body is a scene whose bytes were evicted — reported rather
    // than silently shown as empty.
    if (scene.base.kind === 'scene-glb') {
      throw new Error(`The scene body for "${scene.name}" is no longer available.`);
    }
    this._slotRevisions.clear();

    // A project asset names itself by path, not by URL (plan-709 §2.5). It is
    // re-resolved HERE, on every load, rather than being handed in once as an
    // object URL by whoever opened it — which is what makes discard, draft
    // restore and reload work on the same base instead of on a dead blob URL,
    // and what lets a self-contained GLB reach the loader as bytes with no
    // object URL minted anywhere.
    const assetPath = scene.base.kind === 'builtin'
      ? projectAssetRelPath(scene.base.url)
      : null;
    if (scene.base.kind === 'builtin' && assetPath !== null) {
      const label = baseLabelOf(scene.base);
      // The sentinel is the identity in both branches below: stable across
      // opens, where the object URL it replaces was a fresh UUID every time.
      const identity = scene.base.url;
      const source = await getProjectStore().resolveAssetSource(assetPath);
      if (!source) {
        this._installAssetSourceRelease(null);
        throw new Error(`"${label}" could not be read from this project.`);
      }
      if (source.kind === 'bytes') {
        this._installAssetSourceRelease(null);
        // The bytes we just resolved ARE the bake source and ARE the
        // compare-and-swap basis (plan-716 §2.5). Recording both here is what
        // makes a document save work at all: without the first, `_ensureBaseBytes`
        // would try to `fetch('rvproject:…')`; without the second, every save of
        // an opened document would be an unconditional overwrite of whatever the
        // file holds by then.
        this._setBaseBytes(baseKeyOf(scene.base), source.bytes);
        void this._noteDocumentRevisionOf(assetPath, source.bytes);
        return { scene, fromGlb: false, identityUrl: identity, data: source.bytes };
      }
      this._installAssetSourceRelease(source.release);
      return {
        scene: { ...scene, base: { kind: 'builtin', url: source.url, label } },
        fromGlb: false,
        identityUrl: identity,
      };
    }

    return { scene, fromGlb: false };
  }

  /**
   * Take ownership of the object URL a project asset needed, releasing the
   * previous one.
   *
   * One slot, exactly like `_installBodyUrl` next door and for the same reason:
   * a document displaces its predecessor, so the moment a new base resolves is
   * the moment the old one's bytes are provably unreachable. `dispose()` closes
   * the last one. No `FinalizationRegistry` (plan-709 §7).
   */
  private _installAssetSourceRelease(release: (() => void) | null): void {
    this._assetSourceRelease?.();
    this._assetSourceRelease = release;
  }

  /** Remember what a slot held, so the next write can say what it replaces. */
  private _noteSlotRevision(slot: string, revision: string | null): void {
    if (revision) this._slotRevisions.set(slot, revision);
    else this._slotRevisions.delete(slot);
  }

  /**
   * The revision this session believes `slot` holds, or `undefined`.
   *
   * `undefined` — not `null` — is the honest answer for "I have never looked".
   * `null` would mean "I expect nothing to be there", which for an existing
   * scene is a guaranteed false conflict.
   */
  private _expectedRevisionOf(slot: string): string | undefined {
    return this._slotRevisions.get(slot);
  }

  // ─── Document revisions — the CAS basis of the one save (plan-716 §2.5) ──

  /**
   * The revision key of a document FILE.
   *
   * Kept in the same map as the body slots and namespaced so it cannot collide
   * with one: `draft/<id>` and `<id>` are the body keyspace, `doc:<relPath>` is
   * the manifest one, and the two describe different bytes at different
   * addresses.
   */
  private static _docRevisionKey(relPath: string): string {
    return `doc:${relPath}`;
  }

  /** Remember what a document's file held when we last saw it. Best-effort. */
  private async _noteDocumentRevisionOf(relPath: string, bytes: ArrayBuffer): Promise<void> {
    try {
      const { revisionOfBytes } = await import('../../project/rv-scene-record');
      this._noteSlotRevision(SceneStore._docRevisionKey(relPath), await revisionOfBytes(bytes));
    } catch {
      // A hash we cannot compute degrades to an unconditional write, which is
      // the direction `_commitBody` already documents as safe: never `null`,
      // because "expect nothing stored" is a guaranteed false conflict.
    }
  }

  /**
   * The precondition for the next write of `relPath`.
   *
   * `undefined` — never `null` — when this session has not seen the file, for
   * exactly the reason `_commitBody` gives: `null` means "expect nothing to be
   * there", which for an existing document is a guaranteed false conflict.
   * A freshly CREATED document is the one case that legitimately passes `null`,
   * and it does so explicitly at the create site.
   */
  private _expectedDocumentRevision(relPath: string): string | undefined {
    return this._expectedRevisionOf(SceneStore._docRevisionKey(relPath));
  }

  /** Publish bytes as an object URL, revoking the previous body's. */
  private _installBodyUrl(glb: Uint8Array): string {
    if (this._bodyObjectUrl) URL.revokeObjectURL(this._bodyObjectUrl);
    this._bodyObjectUrl = URL.createObjectURL(
      new Blob([glb as unknown as BlobPart], { type: 'model/gltf-binary' }),
    );
    return this._bodyObjectUrl;
  }

  private _setBaseBytes(key: string, bytes: ArrayBuffer): void {
    this._baseBytes = { key, bytes };
  }

  /**
   * The bytes the current workspace's edits are baked onto.
   *
   * Fetched once per workspace and held for as long as it is open. Every
   * autosave re-bakes the FULL op log onto these same bytes, which is what
   * makes repeated saves deterministic rather than cumulative: nothing is ever
   * applied twice, because the source never carries the previous result.
   */
  private async _ensureBaseBytes(): Promise<ArrayBuffer | null> {
    const base = this._workspace?.base;
    if (!base) return null;

    const key = base.kind === 'empty' ? 'empty' : baseKeyOf(base);
    if (this._baseBytes && this._baseBytes.key === key) return this._baseBytes.bytes;
    // A body already loaded from a slot is the right source too — it is what
    // the viewer is showing — and its key form is distinct so it never
    // collides with a base key.
    if (this._baseBytes?.key.startsWith('slot:')) return this._baseBytes.bytes;

    let bytes: ArrayBuffer;
    if (base.kind === 'empty') {
      const { buildEmptyGlbBlob } = await import('./empty-glb');
      bytes = await buildEmptyGlbBlob().arrayBuffer();
    } else if (base.kind === 'builtin') {
      // A project asset names itself by PATH; `fetch('rvproject:…')` is not a
      // request any browser can make. Resolved through the store instead —
      // the same seam `_resolveLoad` uses — so a document whose bytes were
      // dropped (a second store, a discard) can still be baked onto.
      const relPath = projectAssetRelPath(base.url);
      if (relPath !== null) {
        const source = await getProjectStore().resolveAssetSource(relPath);
        if (!source) return null;
        bytes = source.kind === 'bytes'
          ? source.bytes
          : await (async () => {
              try { return await (await fetch(source.url)).arrayBuffer(); }
              finally { source.release(); }
            })();
        void this._noteDocumentRevisionOf(relPath, bytes);
        this._setBaseBytes(key, bytes);
        return bytes;
      }
      const response = await fetch(base.url);
      if (!response.ok) throw new Error(`Could not read the model file (${response.status}).`);
      bytes = await response.arrayBuffer();
    } else {
      const body = await (await sceneGlbIo()).readSceneGlbBody(base.sceneId);
      if (!body) return null;
      bytes = toArrayBuffer(body.glb);
    }
    this._setBaseBytes(key, bytes);
    return bytes;
  }

  /**
   * Take over what the freshly loaded GLB carries: placements, workspace
   * settings, camera preset.
   *
   * The counterpart of the bake. `loadGLB` already composed the reference
   * nodes and registered everything under them, so this is pure adoption —
   * see `adoptPlacedNode` for why rebuilding would be wrong.
   */
  private _adoptFromLoadedGlb(opts: { persistCamera?: boolean } = {}): void {
    const root = this._viewer.currentModelRoot;
    if (!root) return;

    const settings = readSceneSettingsFromScene(root);
    if (settings) this._settings = { ...this._settings, ...settings };

    const entries = collectPlacementNodes(root);
    if (entries.length > 0) {
      const planner = this._viewer.getPlugin<RVViewerPlugin & {
        adoptPlacements?: (e: readonly { node: Object3D; placement: PlacedComponent }[]) => number;
      }>('layout-planner');
      planner?.adoptPlacements?.(entries);
    }

    const preset = readCameraStartFromScene(root);
    if (preset && opts.persistCamera !== false) {
      const key = deriveModelKey(this._viewer.currentModelUrl);
      if (key) saveStartPos(key, preset);
    }
  }

  // ─── Persistence ────────────────────────────────────────────────────

  /**
   * Save the current draft (creates a new id on first save, else overwrites).
   *
   * Runs ON the op queue (plan-709 §2.2.1-2). It did not, and the reason it
   * got away with it was accidental: until this plan a scene save only ever ran
   * from the project exit dialog, which had already sequenced everything before
   * it. A Save button the user can press at any moment removes that accident,
   * so the guarantees are stated instead of inherited — see {@link _save}.
   */
  async save(): Promise<SceneSaveVerdict> {
    return this._doc.runExclusive(() => this._save());
  }

  private async _save(): Promise<SceneSaveVerdict> {
    if (!this._workspace) return 'no-op';
    // §2.2.1-4 — a clean, already-committed scene is a TRUE no-op. Without
    // this, pressing Save twice on an untouched draft minted a second scene id
    // and a second catalogue row for the same content, purely because the
    // button was pressed again.
    if (this._saved && !this._workspace.transient && !this._doc.dirty) return 'no-op';

    // ── The alt-session weiche (plan-716 §2.4, R2-S4b) ───────────────────
    //
    // This tab opened a scene, another tab's migration converted it, and the
    // user presses Save. Without this branch the save would fall through to
    // "place a new document", silently FORKING the very content the migration
    // just converted — two files, and no way for the user to tell which one the
    // migration kept. The autosave path has made this distinction since Phase 2
    // (`hasDocumentAlias` before `reportSceneConflict`); this is the second
    // propagation path R2-S4b names.
    //
    // Only when the alias points somewhere ELSE than what this workspace is
    // already bound to: a document that was aliased onto ITSELF (a folder
    // project's self-alias, §2.3 step 5) has not moved anywhere.
    const movedTo = resolveDocumentAlias(this._saved?.id);
    if (movedTo && movedTo !== this._workspace.documentId) {
      const { reportSceneMovedToDocument } = await import('./rv-scene-live-sync');
      reportSceneMovedToDocument(this._workspace.name || 'This scene');
      return 'target-changed';
    }

    // ── The one save path (plan-716 §2.5, F5) ────────────────────────────
    //
    // There used to be a second one below this line: mint a `scn_` id, write a
    // GLB body into the id-keyed OPFS slot, write a catalogue row. It is gone.
    // Every save now writes a DOCUMENT FILE, and the only question left is
    // WHICH document — an existing one for a workspace that has one, a freshly
    // placed one for a draft. That question is the whole of
    // {@link _resolveSaveTarget}, and the answer goes to the single writer.
    const target = await this._resolveSaveTarget();
    if (!target) {
      // No writable project — a read-only deploy, a bundled demo, a hostile
      // storage environment. Reported rather than silently swallowed: the user
      // pressed Save and nothing was written, and before Phase 3 this case
      // produced a catalogue row that the same environment could not reload.
      console.error('[scene-store] there is no writable project to save into.');
      return 'no-op';
    }
    return this._saveIntoDocument(target);
  }

  /**
   * Which document this save writes, placing one when the workspace has none.
   *
   * Three cases, in order:
   *
   *  1. the workspace is already bound to a document (opened via
   *     {@link openDocument}, or bound by an earlier in-place save) — that one;
   *  2. its base is an `rvproject:` URL the manifest lists — that row, which is
   *     the Stage-1 behaviour `_projectDocumentTarget` describes;
   *  3. anything else that is genuinely the user's (a draft, a fork, a
   *     just-escalated transient) — a NEW document, name-probed, create-only.
   *
   * Case 3 is where the deleted `scn_` mint used to be, and the substitution is
   * exact: same moment, same trigger, a file and a manifest row instead of a
   * body slot and a catalogue row.
   */
  private async _resolveSaveTarget(): Promise<SaveTarget | null> {
    const ws = this._workspace;
    if (!ws) return null;
    if (ws.documentId && ws.documentPath) {
      return { entryId: ws.documentId, relPath: ws.documentPath };
    }
    const bound = this._projectDocumentTarget();
    if (bound) return bound;

    // Saving IS the conversion from "somebody else's content" to "mine"
    // (plan-386 §2.5 transition contract). The document is only PLANNED here —
    // a free name, a free path, a derived id — and neither its bytes nor its row
    // exist yet. `_saveIntoDocument` writes the baked bytes create-only and adds
    // the row afterwards, which buys two things over creating it outright: the
    // file is written ONCE instead of an empty GLB followed immediately by the
    // real one (a 35 MB scene would pay that twice), and the order stays "bytes
    // first, row second" — a torn save leaves an orphan file the next plan
    // recognises, never a row pointing at nothing.
    const store = getProjectStore();
    const backend = store.getBackend();
    if (!backend?.writable) return null;
    try {
      const { planDocument } = await import('../../project/rv-document-ops');
      const planned = await planDocument(backend, store.getProject(), ws.name || 'Untitled');
      return { entryId: planned.documentId, relPath: planned.relPath, plannedName: planned.name };
    } catch (e) {
      console.error('[scene-store] the document could not be placed:', e);
      return null;
    }
  }

  /**
   * The project document this workspace would save back into, or null.
   *
   * Conservative on purpose: only a non-transient workspace whose base is an
   * `rvproject:` URL, in a writable project whose manifest actually lists a
   * document at that path. Everything else — saved scenes, builtins, published
   * examples, empty drafts — keeps its existing save path.
   */
  private _projectDocumentTarget(): { entryId: string; relPath: string } | null {
    const ws = this._workspace;
    if (!ws || ws.transient) return null;
    // A workspace that has already saved as a SCENE keeps saving as one; the
    // in-place path is only for drafts and for workspaces already bound to a
    // document by a previous in-place save.
    if (ws.id !== 'draft' && !ws.documentPath) return null;
    const base = ws.base;
    if (base.kind !== 'builtin') return null;
    const relPath = projectAssetRelPath(base.url);
    if (!relPath) return null;
    const store = getProjectStore();
    if (!store.getBackend()?.writable) return null;
    const entry = documentsOf(store.getProject()).find(e => e.path === relPath);
    return entry ? { entryId: entry.id, relPath } : null;
  }

  /**
   * Save the workspace back into the project document it was opened from
   * (GLBs only — scene = asset).
   *
   * The bytes replace the document's own file through the backend held at
   * start; no scene id is minted, no catalogue row is written and the URL keeps
   * whatever identity the open gave it. The manifest row is the one identity,
   * and `rescanDocuments()` afterwards is what keeps its caches (mtime,
   * classification) describing the new bytes.
   *
   * ## Compare-and-swap (plan-716 §2.5, Phase 3)
   *
   * The write used to be unconditional, with the reasoning that there was no
   * revision to hold as a precondition. There is one now, and it is the same one
   * `_commitBody` uses for the body slot: the revision the FILE had when this
   * session last saw it, recorded at load and re-derived after every write. Both
   * writable backends implement the precondition in full
   * (write-blob-cas.contract.test.ts:121-213), so this is the last unconditional
   * asset write in the save path, and it is now conditional.
   *
   * The degradation is deliberate and matches `_commitBody` word for word: a
   * file this session has never seen is written UNCONDITIONALLY, never with
   * `expectedRevision: null` — "expect nothing to be stored" is a guaranteed
   * false conflict for a document that plainly exists.
   *
   * ## The two conflict outcomes (§2.4, R2-S4b)
   *
   * A refused write is not always a conflict. After the §2.3 migration a refusal
   * can mean the IDENTITY moved rather than the bytes, and the two need opposite
   * words: "somebody edited this, save a copy" versus "this is now a document,
   * reload". The autosave path has made that distinction since Phase 2; this is
   * the second propagation path R2-S4b names, and the choice is made here so
   * both spellings live in one place.
   *
   * The bake runs first and the destination is verified between bake and write,
   * same statement as `_save` §2.2.1-1.
   */
  private async _saveIntoDocument(target: SaveTarget): Promise<SceneSaveVerdict> {
    const ws = this._workspace;
    if (!ws) return 'no-op';
    const store = getProjectStore();
    const backendAtStart = store.getBackend();
    const projectIdAtStart = store.getProject()?.id ?? null;
    if (!backendAtStart?.writable) return 'no-op';

    // BEFORE the re-binding below, because the binding changes the answer: a
    // workspace that becomes a document by saving has been autosaving under its
    // OLD slot all along, and that is the body the cleanup has to drop. Reading
    // it afterwards would drop `draft/<documentId>` — a slot nothing has written
    // yet — and leave the real draft standing, to be resumed on the next open as
    // unsaved changes that were saved.
    const draftSlotBefore = this._bodySlots().draft;
    this._workspace = {
      ...ws,
      transient: false,
      documentPath: target.relPath,
      documentId: target.entryId,
    };
    const workspaceAtStart = this._workspace;
    const floorAtBakeStart = this._doc.opCount;
    this._cancelAutosave();

    const bytes = await this._bakeCurrent();
    if (!bytes) {
      console.error('[scene-store] the document could not be baked — nothing was written.');
      return 'no-op';
    }

    if (
      this._workspace !== workspaceAtStart
      || store.getBackend() !== backendAtStart
      || (store.getProject()?.id ?? null) !== projectIdAtStart
    ) {
      console.warn('[scene-store] the save target changed while writing — result discarded.');
      return 'target-changed';
    }

    // A planned document is written CREATE-ONLY: `null` here means "expect
    // nothing to be stored", which for a path this save just reserved is the
    // truth and the guard — a second tab that reserved the same name in between
    // is refused rather than overwritten.
    const expected = target.plannedName !== undefined
      ? null
      : this._expectedDocumentRevision(target.relPath);
    try {
      await backendAtStart.writeBlob(
        target.relPath,
        new Blob([bytes as unknown as BlobPart], { type: 'model/gltf-binary' }),
        ...(expected !== undefined ? [{ expectedRevision: expected }] as const : []),
      );
    } catch (e) {
      const moved = await this._reportSaveRefusal(e, target);
      if (moved) return 'target-changed';
      throw e;
    }
    // What the file holds now, so the NEXT save states what it replaces.
    await this._noteDocumentRevisionOf(target.relPath, toArrayBuffer(bytes));

    const now = new Date().toISOString();

    // The row, AFTER the bytes (see `_resolveSaveTarget`). Failing here leaves
    // an orphan file, which the next plan recognises by content and reuses; the
    // other order leaves a card the user can see and cannot open.
    if (target.plannedName !== undefined) {
      const { commitDocuments, documentRowFor } = await import('../../project/rv-document-ops');
      await commitDocuments(store, [
        ...documentsOf(store.getProject()),
        documentRowFor(
          { documentId: target.entryId, relPath: target.relPath, name: target.plannedName },
          now,
        ),
      ]);
      // The workspace now names a real file, so later opens and later saves
      // address it directly instead of re-planning a second one.
      const documentBase: SceneBase = {
        kind: 'builtin', url: projectAssetUrl(target.relPath), label: target.plannedName,
      };
      this._workspace = { ...this._workspace, base: documentBase };
      // The bytes just written ARE what the next bake starts from. Without this
      // the changed base key would send `_ensureBaseBytes` back to the backend
      // for a file it already has in hand.
      this._setBaseBytes(baseKeyOf(documentBase), toArrayBuffer(bytes));
    }

    const saved: RvScene = {
      id: target.entryId,
      name: this._workspace.name,
      base: this._workspace.base,
      createdAt: this._workspace.createdAt,
      modifiedAt: now,
      schemaVersion: RV_SCENE_SCHEMA_VERSION,
      parentId: this._workspace.parentId,
      description: this._workspace.description,
      edits: { ops: [...this._ops], settings: { ...this._settings } },
      ...(this._workspace.classification
        ? { classification: this._workspace.classification }
        : {}),
    };
    this._saved = saved;
    this._publishDocumentIdentity();
    this._activePublishedName = null;
    this._doc.markSaved({ floor: floorAtBakeStart });

    // Same conditional as the deleted row save: ops that arrived mid-bake are
    // NOT in the file, and the draft is the only place they still exist.
    //
    // `_bodySlots()` rather than a base key spelled out here (plan-716 §2.4): a
    // document's draft slot is named after its ID now, and computing the name a
    // second way is how the save ends up dropping a different slot than the
    // autosave writes.
    if (this._doc.opCount === floorAtBakeStart) {
      const io = await sceneGlbIo();
      // Every slot this workspace could have been writing: the one it used
      // before the binding, the document's own, and the base-keyed one. A
      // workspace that becomes a document by SAVING has been using the first;
      // leaving any of them behind resumes a draft of work that is now in the
      // file, i.e. shows the user unsaved changes that were saved.
      const slots = new Set([
        draftSlotBefore,
        this._bodySlots().draft,
        `draft/${baseKeyOf(this._workspace.base)}`,
      ]);
      for (const slot of slots) {
        await io.dropSceneGlbBody(slot);
        this._slotRevisions.delete(slot);
        if (this._bytesCache?.slot === slot) this._bytesCache = null;
      }
      clearDraft(this._workspace.base);
      clearSceneDraft(target.entryId);
    } else {
      void this._autosaveBody();
    }

    this._viewer.currentScene = saved;
    // The document IS the identity now, so the address bar says so — the same
    // normalisation `openDocument` performs, applied to the save that MADE this
    // workspace a document (plan-716 §2.4/F5).
    updateUrlDocumentParam(target.entryId);
    void store.rescanDocuments();
    this._notify();
    return 'saved';
  }

  /**
   * Say the right thing about a refused document write, and report whether the
   * refusal was a MOVE rather than a conflict (plan-716 §2.4, R2-S4b).
   *
   * Asked in this order because both can be true at once and only one of them is
   * actionable: if the id this workspace saves under has an alias, the migration
   * re-identified it, and telling the user to "save under a new name" would
   * leave them with a duplicate and no way to tell which copy the migration
   * kept.
   *
   * @returns true when the user was told the document moved — the caller then
   *          answers `target-changed`, which is precisely what happened: the
   *          destination is no longer the one this session was writing to.
   */
  private async _reportSaveRefusal(
    error: unknown,
    target: { entryId: string; relPath: string },
  ): Promise<boolean> {
    const { SceneRevisionConflictError } = await import('../../project/rv-scene-record');
    if (!(error instanceof SceneRevisionConflictError)) return false;
    const name = this._workspace?.name ?? 'This document';
    const live = await import('./rv-scene-live-sync');
    if (hasDocumentAlias(this._saved?.id) || hasDocumentAlias(target.entryId)) {
      live.reportSceneMovedToDocument(name);
      return true;
    }
    live.reportSceneConflict(name);
    return false;
  }

  /**
   * Write the committed body for a scene id and drop its draft body.
   *
   * ## Conditional, not unconditional — the plan-709 §2.3 decision
   *
   * This used to be unconditional, and the reason given was sound as far as it
   * went: a compare-and-swap against *the autosave's* revision would refuse the
   * very save the user asked for, because the last thing written near this
   * scene was almost certainly their own draft. What that argument missed is
   * that the autosave writes a DIFFERENT slot (`draft/<id>`), so the committed
   * slot's revision was never the autosave's to begin with — the two were only
   * conflated by the single `_lastWrittenRevision` field this plan splits.
   *
   * With the split, a precondition here costs nothing and catches the case the
   * unconditional write silently loses: another tab, or an editor in the
   * project folder, committed this same scene since we last looked. So:
   *
   *  - a revision this session has SEEN for the committed slot (from a load, or
   *    from the previous save) is used as the precondition;
   *  - otherwise the manifest/pointer revision is used — a free lookup, no file
   *    read (`sceneGlbBodyRevision`);
   *  - and when neither exists the write stays UNCONDITIONAL. Never `null`:
   *    "expect nothing to be stored" would be a guaranteed false conflict for
   *    every scene saved by a build older than its manifest revisions.
   *
   * A genuine conflict is therefore reported to the caller instead of
   * overwriting somebody's work; every other failure keeps the previous
   * behaviour of a logged null, because a catalogue row is better skipped than
   * written against bytes that are not there.
   */
  private async _commitBody(id: string, base: SceneBase): Promise<string | null> {
    const io = await sceneGlbIo();
    // `?.` and the catch: this is a lookup for a BETTER precondition, never a
    // requirement. Anything it cannot answer degrades to the unconditional
    // write that was here before, which is the safe direction.
    const stored = await Promise.resolve()
      .then(() => io.sceneGlbBodyRevision?.(id))
      .catch(() => null);
    const expected = this._expectedRevisionOf(id) ?? stored ?? undefined;
    try {
      const revision = await this._writeBody(id, expected);
      if (!revision) return null;
      await io.dropSceneGlbBody(`draft/${id}`);
      await io.dropSceneGlbBody(`draft/${baseKeyOf(base)}`);
      this._noteSlotRevision(id, revision);
      // The draft slots are gone, so nothing is known about them any more.
      this._slotRevisions.delete(`draft/${id}`);
      this._slotRevisions.delete(`draft/${baseKeyOf(base)}`);
      return revision;
    } catch (e) {
      const { SceneRevisionConflictError } = await import('../../project/rv-scene-record');
      // A conflict is the ONE failure the user has to hear about: their save
      // did not happen because somebody else's did. Reporting it as "no
      // revision" and carrying on would write a catalogue row describing the
      // other person's bytes.
      if (e instanceof SceneRevisionConflictError) throw e;
      console.error('[scene-store] could not write the scene body:', e);
      return null;
    }
  }

  // ─── Flat export (plan-397 phase 8, F8) ─────────────────────────────

  /**
   * What a flat export of the open scene would weigh, without producing one.
   *
   * Summed over DISTINCT referenced assets — see `estimateFlattenedSize` for
   * why counting occurrences would mislead the user in the direction that
   * makes them not press the button.
   */
  async estimateFlatExport(): Promise<FlattenSizeEstimate | null> {
    if (!this._workspace) return null;
    const source = await this._ensureBaseBytes().catch(() => null);
    if (!source) return null;
    const { estimateFlattenedSize } = await import('../../engine/rv-glb-flatten');
    return estimateFlattenedSize(
      source.byteLength,
      this._viewer.lastLoadResult?.composition?.frames ?? [],
    );
  }

  /**
   * The open scene as a GLB the user can take away.
   *
   * Two shapes, and the difference is what `embedReferences` buys:
   *
   *  - **off** — the scene as it is stored: references stay references, so the
   *    file is small and a library correction still reaches it. Useless to
   *    anyone who does not have the library.
   *  - **on** — the composed tree, with every reference marked `embedded` and
   *    its origin kept (`assetId` + `sha256`). Runs anywhere on its own, and
   *    `unflattenReferences()` can still take it apart again.
   *
   * The embedded path exports the LIVE tree, so the marks are put on and taken
   * off around the export. Leaving them on would tell the running session that
   * its references are already resolved, and the next save would write that.
   */
  async exportSceneGlb(opts: { embedReferences: boolean } = { embedReferences: false }): Promise<Uint8Array> {
    if (!this._workspace) throw new Error('No scene is open.');

    if (!opts.embedReferences) {
      const bytes = await this._bakeCurrent();
      if (!bytes) throw new Error('The scene could not be exported.');
      return bytes;
    }

    const root = this._viewer.currentModelRoot;
    if (!root) throw new Error('No model is loaded.');

    const frames = this._viewer.lastLoadResult?.composition?.frames ?? [];
    const { markReferencesEmbedded, unmarkReferencesEmbedded } =
      await import('../../engine/rv-glb-flatten');
    const { objectToGlb } = await import('../../import/rv-import-object');

    markReferencesEmbedded(frames);
    try {
      return new Uint8Array(await objectToGlb(root));
    } finally {
      // Always — an export that threw must not leave the live scene claiming
      // its references are already inlined.
      unmarkReferencesEmbedded(frames);
    }
  }

  /** Bake the current edit state onto the base bytes and return the result. */
  private async _bakeCurrent(): Promise<Uint8Array | null> {
    const perfT0 = performance.now(); // TEMP open-perf instrumentation
    const source = await this._ensureBaseBytes();
    const registry = this._viewer.registry;
    if (!source || !registry) return null;

    const { bakeIntoGlb, makeRegistryBakeResolver } = await import('./rv-scene-glb-bake');
    // TEMP open-perf instrumentation
    debug('perf', '[open-perf] _bakeCurrent begins', {
      baseBytesMs: Math.round(performance.now() - perfT0),
      sourceKb: Math.round(source.byteLength / 1024),
      ops: this._ops.length,
    });
    const result = await bakeIntoGlb(
      source,
      materialise(this._ops),
      makeRegistryBakeResolver(registry, this._viewer.lastLoadResult?.composition?.frames ?? []),
      {
        expectedNames: registry.getGltfNodeNames(),
        settings: { ...this._settings },
        clearCameraWhenUnset: true,
      },
    );
    // TEMP open-perf instrumentation
    debug('perf', '[open-perf] _bakeCurrent done', {
      totalMs: Math.round(performance.now() - perfT0),
    });
    return result.glb;
  }

  /** Save under a new name — always creates a new id. */
  async saveAs(name: string): Promise<string> {
    return this._doc.runExclusive(() => this._saveAs(name));
  }

  private async _saveAs(name: string): Promise<string> {
    if (!this._workspace) throw new Error('Nothing to save');
    // plan-716 F5 — "Save as" is a NEW DOCUMENT, not a new scene id.
    //
    // The verb is unchanged (a copy under a new name, the original untouched);
    // what changed is what a copy IS. It used to mint `scn_`, write a body slot
    // and add a catalogue row; it now places a file and a manifest row through
    // the same create-only primitive "New" and the first save use.
    //
    // The name goes into the workspace BEFORE anything is written, for the
    // reason the row path documented and which survives verbatim: the file name
    // is derived from it, and a stale name here puts the bytes somewhere the
    // manifest row does not point (plan-921 field finding).
    this._workspace = { ...this._workspace, transient: false, name };
    const workspaceAtStart = this._workspace;
    const store = getProjectStore();
    const backendAtStart = store.getBackend();
    const projectIdAtStart = store.getProject()?.id ?? null;
    this._cancelAutosave();

    // Bake FIRST, then place: the copy carries the CURRENT state, and a document
    // created before a bake that then fails would leave an empty row behind.
    const floorAtBakeStart = this._doc.opCount;
    const bytes = await this._bakeCurrent();
    if (!bytes) throw new Error('The document could not be saved under a new name.');

    if (
      this._workspace !== workspaceAtStart
      || store.getBackend() !== backendAtStart
      || (store.getProject()?.id ?? null) !== projectIdAtStart
    ) {
      throw new Error('The save target changed while writing — nothing was adopted.');
    }

    // Beside the source, exactly like `duplicate` — a "save as" is a copy under
    // a new name, not a move to another folder. Without the explicit folder the
    // copy would land in the project root (the default since the section layout
    // stopped meaning anything) and quietly leave its original behind.
    const { documentFolderOf } = await import('../../project/rv-document-ops');
    const sourcePath = this._documentRow(this._saved?.id ?? '')?.path
      ?? workspaceAtStart.documentPath;
    const created = await this._createDocument(
      name,
      bytes as unknown as BlobPart,
      sourcePath ? documentFolderOf(sourcePath) : undefined,
    );
    if (!created) throw new Error('There is no writable project to save into.');
    await this._noteDocumentRevisionOf(created.relPath, toArrayBuffer(bytes));

    // The workspace now IS the new document: same op log, same bytes on screen,
    // a different file underneath. The base is re-pointed at it so the next save
    // is an ordinary in-place write rather than a second copy.
    const base: SceneBase = { kind: 'builtin', url: projectAssetUrl(created.relPath), label: name };
    const now = new Date().toISOString();
    const saved: RvScene = {
      id: created.documentId,
      name,
      base,
      createdAt: now,
      modifiedAt: now,
      schemaVersion: RV_SCENE_SCHEMA_VERSION,
      parentId: this._saved?.id,
      description: this._workspace.description,
      edits: { ops: [...this._ops], settings: { ...this._settings } },
    };
    this._workspace = {
      ...this._workspace,
      id: created.documentId,
      base,
      documentId: created.documentId,
      documentPath: created.relPath,
    };
    this._setBaseBytes(baseKeyOf(base), toArrayBuffer(bytes));
    this._saved = saved;
    this._publishDocumentIdentity();
    this._activePublishedName = null;  // now the user's own document
    this._doc.markSaved({ floor: floorAtBakeStart });
    // See the in-place save for the conditional-cleanup rationale: ops that
    // arrived mid-bake are not in the copy, so their draft must survive.
    if (this._doc.opCount === floorAtBakeStart) {
      clearDraft(base);
      clearSceneDraft(created.documentId);
    } else {
      void this._autosaveBody();
    }
    this._viewer.currentScene = saved;
    updateUrlDocumentParam(created.documentId);
    void store.rescanDocuments();
    this._notify();
    return created.documentId;
  }

  /** Revert to the last-saved state (or to bare base for fresh drafts). */
  async discard(): Promise<void> {
    if (this._saved) {
      // Clear the per-saved-scene draft slot BEFORE re-opening — without
      // this, openScene would just restore the same draft we're trying to
      // throw away. Both slots: the op-log one for pre-phase-6 drafts still
      // in the field, and the GLB body that replaced it.
      clearSceneDraft(this._saved.id);
      await (await sceneGlbIo()).dropSceneGlbBody(`draft/${this._saved.id}`);
      this._noteSlotRevision(`draft/${this._saved.id}`, null);
      this._baseBytes = null;
      await this.openScene(this._saved.id);
    } else if (this._workspace) {
      const base = this._workspace.base;
      clearDraft(base);
      await (await sceneGlbIo()).dropSceneGlbBody(`draft/${baseKeyOf(base)}`);
      this._noteSlotRevision(`draft/${baseKeyOf(base)}`, null);
      this._baseBytes = null;
      if (base.kind === 'builtin') await this.openBuiltin(base.url, base.label);
      else if (base.kind === 'empty') await this.newEmpty();
      else await this.openScene(base.sceneId);
    }
  }

  /**
   * Rename a document: the row's NAME and its FILE, at a stable id.
   *
   * ## Why the file moves too (plan-717 F6)
   *
   * Until plan-717 this changed `name` only, and moving the bytes was the tree's
   * `applyTreeMove` — "a different gesture with a different confirmation". That
   * split was the last place where a scene and a library asset were renamed by
   * two different mechanisms, and it left every renamed scene with a file called
   * after a name nobody uses any more. Now there is ONE rename: the display name
   * and the file name are the same string, and the `id` is what does not move —
   * which is precisely why a rename can no longer break a reference (F8).
   *
   * ## The order, and what each failure costs
   *
   *  1. **Probe the destination** through `planDocument` with the row's own path
   *     excluded. Nothing is written; a taken name yields a suffix rather than an
   *     overwrite.
   *  2. **Copy the bytes, create-only.** `expectedRevision: null` refuses a
   *     destination another writer created between the probe and the write.
   *  3. **Delete the original.** If THIS fails the rename is abandoned and
   *     reported: the row still points at the old file, both files exist, and the
   *     stray copy is adopted as its own document on the next scan. That is the
   *     same trade the cross-source move makes — "a duplicate is a tidy-up, a
   *     loss is not" — and it is why the row is repointed only after the delete.
   *  4. **The row**, through `applyManifestDelta`: durable-first and merging, so
   *     a second tab's rows are not overwritten by a snapshot captured before the
   *     copy, and nothing appears on screen that did not reach the disk.
   *
   * `id`, the draft slot (`draft/<documentId>`) and `?doc=` are id-based and are
   * untouched throughout; the open workspace is re-pointed at the new path so the
   * next in-place save writes the file it just renamed.
   *
   * A missing row is a no-op, exactly as a missing catalogue row was — the
   * dashboard can call this on a stale card without it throwing.
   */
  async rename(id: string, name: string): Promise<void> {
    const row = this._documentRow(id);
    if (!row) return;
    const wanted = (name ?? '').trim();
    if (!wanted) return;

    const store = getProjectStore();
    const backend = store.getBackend();
    const {
      commitDocuments, documentFolderOf, planDocument, safeDocumentFileName,
    } = await import('../../project/rv-document-ops');

    // ── 1. Plan the destination. Nothing written yet. ──
    let target: { relPath: string; name: string } | null = null;
    if (backend?.writable && safeDocumentFileName(wanted) !== '') {
      const planned = await planDocument(backend, store.getProject(), wanted, {
        folder: documentFolderOf(row.path),
        exclude: row.path,
      });
      if (planned.relPath !== row.path) {
        target = { relPath: planned.relPath, name: planned.name };
      }
    }

    // ── 2./3. The bytes: copy, then delete. ──
    if (target && backend) {
      const bytes = await backend.readBlobBytes(row.path).catch(() => null);
      if (!bytes) {
        // A row whose file is already gone renames its name and nothing else —
        // there is no byte to move and inventing one would create a document.
        target = null;
      } else {
        await backend.writeBlob(
          target.relPath,
          new Blob([bytes], { type: 'model/gltf-binary' }),
          { expectedRevision: null },
        );
        try {
          await backend.deleteBlob(row.path);
        } catch (e) {
          throw new Error(
            `"${row.name}" was copied to "${target.relPath}" but "${row.path}" could not be `
            + `removed (${e instanceof Error ? e.message : String(e)}). The rename was NOT `
            + 'recorded — the document still lives at its old path; delete the stray copy.',
          );
        }
      }
    }

    // ── 4. The row. ──
    const rowName = target?.name ?? wanted;
    const at = new Date().toISOString();
    const patch = (d: RvDocumentEntry): RvDocumentEntry => (
      d.id === row.id
        ? { ...d, name: rowName, ...(target ? { path: target.relPath } : {}), modifiedAt: at }
        : d
    );
    const written = await store.applyManifestDelta(current => ({
      ...current,
      documents: documentsOf(current).map(patch),
    }));
    if (written === null) {
      // No writable manifest to merge into (a read-only project, a backend with
      // neither a folder nor `writeManifest`). The display rename still lands
      // in memory, which is the behaviour this verb had before Phase 3.
      await commitDocuments(store, documentsOf(store.getProject()).map(patch));
    }

    if (this._workspace?.documentId === row.id) {
      let next: WorkspaceShell = { ...this._workspace, name: rowName };
      // Re-point the workspace only when it was bound to the file that moved:
      // `documentPath` is the binding, and a workspace whose base is something
      // else (a transient, a published example) must keep it.
      if (target && this._workspace.documentPath === row.path) {
        const base: SceneBase = {
          kind: 'builtin',
          url: projectAssetUrl(target.relPath),
          label: rowName,
        };
        // The cached base bytes and the CAS precondition describe the SAME bytes
        // at a new address — re-key them, or the next save re-fetches and writes
        // unconditionally.
        const oldKey = baseKeyOf(this._workspace.base);
        if (this._baseBytes?.key === oldKey) this._setBaseBytes(baseKeyOf(base), this._baseBytes.bytes);
        const revision = this._slotRevisions.get(SceneStore._docRevisionKey(row.path));
        if (revision) {
          this._noteSlotRevision(SceneStore._docRevisionKey(target.relPath), revision);
          this._noteSlotRevision(SceneStore._docRevisionKey(row.path), null);
        }
        next = { ...next, base, documentPath: target.relPath };
        if (this._saved) this._saved = { ...this._saved, base };
      }
      this._workspace = next;
      if (this._saved) {
        this._saved = { ...this._saved, name: rowName };
        this._viewer.currentScene = this._saved;
      }
      // The cross-mode handle carries the NAME beside the id; a stale one makes
      // the editor announce a document nobody can find under that title.
      this._publishDocumentIdentity();
    }
    this._notify();
  }

  /**
   * Create an empty DOCUMENT **without** opening it.
   *
   * `newEmpty()` is the other half of this pair and replaces the workspace,
   * which is the right gesture from the viewport but the wrong one from the
   * Projects dashboard: there the user is cataloguing, not switching. Creating
   * the file first lets them name it and choose when to leave the screen.
   *
   * Returns the new documentId so the caller can select the card it just made.
   *
   * Throws when there is nowhere to put it. Since Phase 1 that means a genuinely
   * read-only deploy and nothing else — a browser without a folder project has
   * "My Workspace" — so the honest answer is an error the UI can show, not the
   * catalogue row this used to fall back to (plan-716 F1, Phase 6).
   */
  async createEmpty(name = 'Untitled'): Promise<string> {
    const created = await this._createDocument(name);
    if (!created) throw new Error('There is no writable project to create a document in.');
    this._notify();
    return created.documentId;
  }

  /**
   * Copy a document next to itself.
   *
   * A copy of the FILE, not of the open workspace: duplicating the scene you are
   * editing gives you the last SAVED state, which is what every other duplicate
   * verb in this product means and what the deleted row path did too (it cloned
   * the stored row, never `_ops`).
   */
  async duplicate(id: string): Promise<string> {
    const row = this._documentRow(id);
    if (!row) throw new Error(`Document ${id} not found`);
    const { duplicateDocument } = await import('../../project/rv-document-ops');
    const copy = await duplicateDocument(getProjectStore(), row.id);
    this._notify();
    return copy.documentId;
  }

  /**
   * Delete a document.
   *
   * A RETIRE, not an erase: the row goes and the bytes move to `.trash/` — see
   * `retireDocument` for why a delete gesture in this codebase is recoverable.
   */
  async delete(id: string): Promise<void> {
    const row = this._documentRow(id);
    if (!row) throw new Error(`Document ${id} not found`);
    const wasActive = this._saved?.id === id || this._workspace?.documentId === row.id;
    const { retireDocument } = await import('../../project/rv-document-ops');
    await retireDocument(getProjectStore(), row.id);
    // The draft body of a deleted document has nothing left to belong to.
    await (await sceneGlbIo()).dropSceneGlbBody(`draft/${row.id}`).catch(() => {});
    this._slotRevisions.delete(`draft/${row.id}`);
    // The dead per-saved-scene slot of an earlier release, swept under the id
    // the caller used: an alias-resolved delete must still reach the key the
    // pre-migration session wrote.
    clearSceneDraft(id);
    if (row.id !== id) clearSceneDraft(row.id);
    if (wasActive) {
      this._workspace = null;
      this._saved = null;
      this._installOps([], []);
      this._viewer.currentScene = null;
      const fb = this._builtins[0];
      if (fb) await this.openBuiltin(fb.url, fb.label);
      else await this._viewer.loadEmptyScene();
    }
    this._notify();
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
    const projectIdAtStart = getProjectStore().getProject()?.id ?? null;
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

      // `expectedRevision: null` — create only (plan-709 §2.3, path 4). The
      // name was just deduplicated against `listModels()`, and this closes the
      // window between that listing and this write: if anything is at the path
      // by now the write is refused instead of silently replacing a file the
      // dedup was there to protect.
      await backend.writeBlob(
        relPath,
        new Blob([result.glb as BlobPart], { type: 'model/gltf-binary' }),
        { expectedRevision: null },
      );
      writtenPath = relPath;

      // Scene loads do NOT go through the op queue, so the user can still have
      // switched scenes while we fetched and wrote. Adopting now would install
      // this model over whatever they moved to. The file stays (it is valid and
      // named after their scene); only the adoption is abandoned.
      //
      // Project and backend are checked for the same reason and by the same
      // rule as `_save` (plan-709 §2.2.1-1) — a scene switch inside the project
      // is not the only way the destination can move under a multi-second write.
      if (
        this._workspace !== workspaceAtStart
        || getProjectStore().getBackend() !== backend
        || (getProjectStore().getProject()?.id ?? null) !== projectIdAtStart
      ) {
        writtenPath = null;
        return { kind: 'scene-changed', fileName, relPath };
      }

      // Same reference the Projects dashboard uses to open a project model
      // (`ProjectsDashboardHost.openModel`): the asset's PATH, not a URL for it
      // (plan-709 §2.5). `_resolveLoad` turns it into bytes — or, where the
      // file names siblings, into a URL it then owns and releases. The previous
      // form resolved an object URL here and dropped its `release()`.
      //
      // Adopting the new file as the base reloads from the bytes we just wrote,
      // which is also the cheapest possible proof that the result is loadable —
      // a file that cannot be resolved back fails the open, loudly, below.
      // `openBuiltin` gives the empty op log and the fresh draft slot for free.
      const label = fileName.replace(/\.glb$/i, '');
      await this.openBuiltin(projectAssetUrl(relPath), label);
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
   * Apply an op to the live workspace. Serialised through the document's
   * single-flight queue: concurrent calls run sequentially. During in-flight
   * loads ops are dropped on the floor (the `canApply` gate) — the load is
   * replaying canonical state.
   *
   * If a transaction is open, the op is buffered instead of pushed onto the
   * log; the composite is committed by `endTransaction`.
   */
  applyOp(op: RvScenePrimitiveOp): Promise<void> {
    return this._doc.applyOp(op);
  }

  /** Undo the last op (down to the baseline floor). */
  undo(): Promise<void> {
    return this._doc.undo();
  }

  /** Redo the most-recently undone op. */
  redo(): Promise<void> {
    return this._doc.redo();
  }

  canUndo(): boolean { return this._doc.canUndo(); }
  canRedo(): boolean { return this._doc.canRedo(); }

  describeUndo(): string | null { return this._doc.describeUndo(); }
  describeRedo(): string | null { return this._doc.describeRedo(); }

  /**
   * Begin a transaction. Subsequent `applyOp` calls accumulate into a
   * composite; commit on `endTransaction`. Reference-counted depth — nested
   * transactions commit when the OUTER one ends.
   */
  beginTransaction(label: string): TransactionToken {
    return this._doc.beginTransaction(label);
  }

  /** Commit (push the composite op). Empty transactions become no-ops. */
  endTransaction(token: TransactionToken): Promise<void> {
    return this._doc.endTransaction(token);
  }

  /**
   * Abandon the transaction and ROLL BACK everything it applied.
   *
   * Stronger than it used to be. This method previously discarded the buffer and
   * left the forward applies standing, documented as "caller is responsible for
   * any rollback" — a contract no caller ever honoured, and the mechanism behind
   * a scene that disagrees with its own history. The unified document rolls back
   * (plan-703 Phase 1), so the returned promise is now worth awaiting.
   */
  abortTransaction(token: TransactionToken): Promise<void> {
    return this._doc.abortTransaction(token);
  }

  /** RAII helper. */
  async withTransaction<T>(label: string, fn: () => T | Promise<T>): Promise<T> {
    return this._doc.withTransaction(label, fn);
  }

  private _afterOpsChanged(): void {
    // plan-711 §2.4 — before every other gate, and deliberately not inside one:
    // a document going clean is exactly what a save does, and a save is also
    // the moment the suspension may still be on (the editor's Save button
    // routes here). The record has to go with the work it described.
    this._dropSharedDraftIfClean();
    // A transient workspace edits freely and persists nothing (plan-386 §2.5,
    // F7). Note where the gate sits: the timer is never even scheduled, so
    // there is no window in which a workspace switch could let a pending write
    // land on the next scene's slot. Undo/redo, dirty state and the op log all
    // keep working — they live in memory and always did.
    //
    // This one `return` covers every persistence path the autosave has,
    // including the ones plan-397 added after this plan was written:
    // `_autosaveBody()` (the GLB body via ProjectBackend/OPFS) and the
    // `dropSceneGlbBody` housekeeping branch. Gating the old `writeDraft` call
    // alone would have missed both.
    if (this._workspace?.transient) {
      this._notify();
      return;
    }
    // plan-711 R2-Q1 — the same gate, one reason further out: while another
    // projection of this document is on screen, a bake from here would write a
    // body baked against the wrong tree AND drop the editor's ops (Spike (b)).
    // The work is remembered instead and flushed by
    // `endProjectionHandover()`, with the new bake source in place.
    if (this._projectionSuspended) {
      this._projectionDeferredWrite = true;
      this._notify();
      return;
    }
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
      const saved = this._saved;
      if (this.canUndo() || this.canRedo() || !saved) {
        // There's edit content beyond baseline OR we're a fresh draft —
        // persist for tab-close survival. Since phase 6 this is a GLB body in
        // OPFS / the project folder, not an op log in localStorage: the write
        // is fire-and-forget on the timer, and its failures are reported by
        // `_autosaveBody` rather than thrown into a timeout callback.
        void this._autosaveBody();
      } else {
        // Workspace is in pristine saved state — drop the draft body. (No
        // matching clear for the base slot here: a saved workspace's base slot
        // belongs to fresh built-in drafts of that base, not to us.)
        void sceneGlbIo().then(io => io.dropSceneGlbBody(`draft/${saved.id}`));
        this._noteSlotRevision(`draft/${saved.id}`, null);
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

  /**
   * Stop this store touching anything, and release what it holds.
   *
   * A discarded store used to be harmless — its pending autosave wrote an op
   * log to a key nobody read again. Since phase 6 that timer writes a GLB body
   * to a shared slot, so a store that outlives its usefulness by two seconds
   * can overwrite the body of whatever replaced it. It also holds the base
   * bytes and an object URL, neither of which the garbage collector can take
   * back on its own.
   */
  dispose(): void {
    this._cancelAutosave();
    if (this._bodyObjectUrl) {
      URL.revokeObjectURL(this._bodyObjectUrl);
      this._bodyObjectUrl = null;
    }
    // The other unowned-URL slot (plan-709 §2.5): a project asset that needed a
    // real URL because it names sibling files. Released exactly once, here.
    this._installAssetSourceRelease(null);
    this._baseBytes = null;
    this._listeners.clear();
  }

  // ─── The GLB write (plan-397 phase 6) ───────────────────────────────

  /**
   * Bake the workspace's edits into its base bytes and store the result.
   *
   * THE production caller of `bakeIntoGlb()` — the one phase 4 built and
   * deliberately left unwired until there was somewhere to put the result.
   *
   * `clearCameraWhenUnset` is on because this writer's materialised state is
   * the complete truth of the file: a scene with no camera op genuinely has no
   * preset, which is exactly the distinction that option exists to draw.
   */
  private async _writeBody(slot: string, expectedRevision?: string | null): Promise<string | null> {
    if (!this._workspace) return null;
    // TEMP open-perf instrumentation — an in-flight body write (bake + CAS +
    // IndexedDB) is invisible work that can race a scene open on the main thread.
    const perfT0 = performance.now();
    try { return await this._writeBodyInner(slot, expectedRevision); } finally {
      debug('perf', `[open-perf] _writeBody "${slot}"`, {
        totalMs: Math.round(performance.now() - perfT0),
      });
    }
  }

  private async _writeBodyInner(slot: string, expectedRevision?: string | null): Promise<string | null> {
    if (!this._workspace) return null;
    // plan-711 §2.4 — the floor is read BEFORE the bake, for the same reason
    // `_save` reads its own before `_commitBody`: an op that arrives while the
    // bytes are being produced is NOT in them, and a stamp claiming otherwise
    // would tell a later recovery to skip an op nobody ever wrote.
    const floorAtBakeStart = this._doc.opCount;
    // Safety net, not the mechanism. The mechanism is `_afterOpsChanged`, which
    // never schedules a write for a transient workspace; this refuses one that
    // reaches here by another route. `save()`/`saveAs()` clear the flag *before*
    // committing, because converting to persistent is exactly what they mean.
    if (this._workspace.transient) return null;
    const source = await this._ensureBaseBytes();
    if (!source) return null;

    const registry = this._viewer.registry;
    if (!registry) return null;

    const { bakeIntoGlb, makeRegistryBakeResolver } = await import('./rv-scene-glb-bake');
    const edits = materialise(this._ops);
    const frames = this._viewer.lastLoadResult?.composition?.frames ?? [];
    const result = await bakeIntoGlb(
      source,
      edits,
      makeRegistryBakeResolver(registry, frames),
      {
        expectedNames: registry.getGltfNodeNames(),
        settings: { ...this._settings },
        clearCameraWhenUnset: true,
      },
    );
    for (const warning of result.warnings) console.warn('[scene-store]', warning);

    const written = await (await sceneGlbIo()).writeSceneGlbBody({
      sceneId: slot,
      name: this._workspace.name,
      glb: result.glb,
      expectedRevision,
      createdAt: this._workspace.createdAt,
    });

    // plan-703 §2.5 — the imprint hangs HERE, on the persistence step, and not
    // on the op that created the placement. A transient placement (the
    // `rv-share-escalate` path) never reaches this line, so it stays unnamed
    // without that module needing to know the rule exists. Awaited but never
    // fatal: the bytes are already on disk, and the store swallows its own
    // failures.
    await getProjectStore().mintReferencedAssetIdentities(result.writtenReferences);

    // What these bytes are a projection OF (plan-711 §2.4). Written last, so a
    // failed write never leaves a stamp describing bytes that are not there.
    this._bytesCache = { slot, revision: written.revision, floor: floorAtBakeStart };

    return written.revision;
  }

  /**
   * Drop the op-log draft this workspace's GLB body has just replaced.
   *
   * Not phase 7, and not housekeeping — a correctness fix for the one window
   * where both can exist. A draft written by a PREVIOUS release still sits in
   * `rv-scenes/draft/…`; the moment this session bakes those same ops into a
   * GLB draft body, the two describe the same edits twice. The next load would
   * read the op log into `_ops` AND load the body that already contains them,
   * and the following save would apply them a second time.
   *
   * Removing the superseded copy is safe precisely because the GLB body is
   * written first: there is no instant at which neither exists.
   */
  private _retireSupersededOpLogDraft(): void {
    if (!this._workspace) return;
    const saved = this._saved;
    if (saved) clearSceneDraft(saved.id);
    else clearDraft(this._workspace.base);
  }

  /**
   * The debounced autosave body, replacing the op-log draft write (§2.10).
   *
   * A failed compare-and-swap is a **conflict**, not a retry: another tab
   * wrote the same slot, and overwriting it is the data loss §2.8 exists to
   * prevent. It is surfaced and the autosave stands down until the user acts.
   *
   * Any OTHER failure is surfaced too (plan-422 F2). It used to end in a
   * `console.error` and nowhere else, which made the worst case of all the
   * quietest one: a bake that refuses the file writes no draft body, so the
   * whole session's unsaved work is gone at the next reload while the interface
   * shows nothing at all. A run that succeeds withdraws the notice again, so
   * the banner tracks the current state rather than the worst one ever seen.
   */
  private async _autosaveBody(): Promise<void> {
    const slot = this._bodySlots().draft;
    try {
      // `?? null` — for the DRAFT slot "I have never seen one" and "there is
      // none" are the same statement, and `null` is the precondition that says
      // so. (The committed slot is the opposite case; see `_commitBody`.)
      const revision = await this._writeBody(slot, this._expectedRevisionOf(slot) ?? null);
      if (revision) {
        this._noteSlotRevision(slot, revision);
        const { announceSceneWrite, clearAutosaveError } = await import('./rv-scene-live-sync');
        announceSceneWrite(slot, revision);
        clearAutosaveError(slot);
        this._retireSupersededOpLogDraft();
      }
    } catch (e) {
      const { SceneRevisionConflictError } = await import('../../project/rv-scene-record');
      if (e instanceof SceneRevisionConflictError) {
        const name = this._workspace?.name ?? 'This scene';
        // ── The migration weiche (plan-716 §2.4, R1-S4) ──────────────────
        // A refused write whose scene id now has an ALIAS is not a conflict:
        // the bytes were not changed by anyone, the identity was. Telling the
        // user to "save under a new name" — the conflict copy — would leave
        // them with a duplicate and no way to tell which one the migration
        // kept. Asked before the conflict branch because both are true at once
        // and only this one is actionable.
        const { hasDocumentAlias } = await import('../../project/rv-doc-alias');
        if (hasDocumentAlias(this._saved?.id)) {
          const { reportSceneMovedToDocument } = await import('./rv-scene-live-sync');
          reportSceneMovedToDocument(name);
          return;
        }
        const { reportSceneConflict } = await import('./rv-scene-live-sync');
        reportSceneConflict(name);
        return;
      }
      console.error('[scene-store] autosave failed:', e);
      const { reportAutosaveError } = await import('./rv-scene-live-sync');
      reportAutosaveError(slot, e instanceof Error ? e.message : String(e));
    }
  }

  // ─── Async queue ────────────────────────────────────────────────────

  /**
   * Run long store work (fetch, patch, write) with no op interleaving.
   *
   * This used to be a queue OF ITS OWN, shared with `applyOp`/`undo`/`redo`.
   * Those now live on the document's queue, so the serialisation would have been
   * lost silently had this stayed local: `_saveSettingsIntoModel` materialises
   * the op log, and an op landing mid-write would be written or dropped
   * depending on timing. `runExclusive` puts this work back on the same queue
   * the ops use, which is exactly the guarantee that existed before.
   */
  private _enqueueResult<T>(work: () => Promise<T>): Promise<T> {
    return this._doc.runExclusive(work);
  }

  // ─── Internals ──────────────────────────────────────────────────────

  private _refreshBuiltins(): void {
    this._builtins = (this._viewer.availableModels ?? []).map(m => ({ url: m.url, label: m.label }));
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
      schemaVersion: RV_SCENE_SCHEMA_VERSION,
      parentId: this._workspace.parentId,
      description: this._workspace.description,
      edits: { ops: [...this._ops], settings: this._settings },
    };
  }

  private _buildSnapshot(): SceneSnapshot {
    const draft = this._buildDraft();
    // A workspace BOUND TO A DOCUMENT ROW is not a draft, whatever `_saved`
    // says: it was opened from a file the manifest lists, and `save()` writes
    // that file in place (`_resolveSaveTarget` case 1). Classifying it as a
    // draft made the save card ask for a name and run `saveAs` — a new file
    // (`empty 2.glb`, `empty 2 2.glb`, …) on EVERY save of a document opened
    // through `openDocument` (field finding 2026-08-14).
    const isDraft = this._saved == null && this._workspace != null
      && !this._workspace.documentId;
    return {
      // dirty / canUndo / canRedo, derived once in the document layer.
      ...this._doc.core,
      saved: this._saved,
      draft,
      isDraft,
      builtins: this._builtins,
      published: this._published,
      activePublishedName: this._activePublishedName,
      transient: this._workspace?.transient === true,
      // The ONE deliberate override of the core. `busy` means something WIDER
      // here than the op queue: "the store is loading or saving", which is what
      // greys out the catalogue rows and what every consumer of this snapshot
      // has always read it as. It is also the only honest value: this store
      // notifies from `onChanged` (committed changes) and does not subscribe to
      // the document's per-op busy transitions, so a queue-derived flag would
      // simply be stale here.
      busy: this._busy,
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
    // Whitelist, not blacklist: content is persistent unless an open path
    // explicitly says it is somebody else's (plan-386 §2.5).
    transient: false,
    description: scene.description,
    ...(scene.classification ? { classification: scene.classification } : {}),
  };
}

/**
 * The catalogue record for a scene whose body was just written as GLB.
 *
 * The op array is dropped: it is IN the file now, and leaving a copy in the
 * catalogue would give a reloaded scene two sources of truth that drift the
 * moment either side changes.
 */
function shellFor(scene: RvScene, revision: string): RvScene {
  return {
    ...scene,
    base: { kind: 'scene-glb', sceneId: scene.id, label: scene.name, revision },
    edits: { ops: [], settings: scene.edits.settings },
  };
}

/** Normalise a possibly-view-backed buffer to a standalone ArrayBuffer. */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function freshShell(base: SceneBase, name: string): WorkspaceShell {
  return {
    id: 'draft',
    name,
    base,
    createdAt: new Date().toISOString(),
    transient: false,
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
 * Sync `?doc=<documentId>` in the address bar (plan-716 §2.4, F5).
 *
 * The counterpart of {@link updateUrlSceneParam} for the one identity that
 * survives Phase 6. `?scene=` is REMOVED at the same time and not merely left
 * standing: main.ts routes `?scene=` before `?doc=` (the alias redirect has to
 * win for an old bookmark), so a URL carrying both would keep resolving through
 * the old parameter forever and the normalisation would never stick.
 *
 * `?option=` is left exactly where it is. A document has no base-model label to
 * validate it against, and dropping a deep-link parameter this function cannot
 * judge would be worse than carrying one it does not use.
 */
function updateUrlDocumentParam(documentId: string | null): void {
  if (typeof window === 'undefined' || typeof window.history?.replaceState !== 'function') return;
  try {
    const url = new URL(window.location.href);
    if (documentId === null) url.searchParams.delete('doc');
    else url.searchParams.set('doc', documentId);
    url.searchParams.delete('scene');
    url.searchParams.delete('model');
    window.history.replaceState(window.history.state, '', url.toString());
  } catch { /* ignore */ }
}

/**
 * The base model label a `?option=` deep link would apply to — the GLB filename
 * without extension, matching `model-options.ts` `baseModel`. Null for any base
 * that is not a built-in GLB, which drops the parameter.
 */
function baseLabelForOption(base: SceneBase): string | null {
  if (base.kind !== 'builtin' || isBytesSourceUrl(base.url)) return null;
  const filename = base.url.split('?')[0].split('/').pop() ?? '';
  return filename.replace(/\.glb$/i, '') || null;
}

/** Compute the `?scene=<value>` form for a given workspace base. */
function urlValueForBase(base: SceneBase): string | null {
  if (base.kind === 'empty') return 'empty';
  // A base whose URL is a source of bytes has no address a reload could be
  // pointed at. Dropping `?scene=` says so; the previous behaviour wrote
  // `builtin:<uuid-of-a-dead-blob-url>`, which resolved to nothing on reload —
  // the same outcome, spelled as data. Naming the FILE instead would be worse
  // than either: `builtin:Belt.glb` is exactly what main.ts's boot matcher
  // compares against the bundled models, so a project asset could reopen as an
  // unrelated model of the same name.
  if (base.kind === 'builtin' && isBytesSourceUrl(base.url)) return null;
  // A saved GLB scene is routed by its own id, which is what `?scene=<id>`
  // already means — the boot path resolves it through `openScene`.
  if (base.kind === 'scene-glb') return base.sceneId;
  // For built-ins, prefer the filename — short, stable, matches main.ts boot
  // matcher which checks `entries.find(e => e.filename === wanted || ...)`.
  const filename = base.url.split('?')[0].split('/').pop() ?? base.url;
  return 'builtin:' + filename;
}

// Keep imports from being marked unused by linters.
void scenesEqual;
void baseLabelOf;
void COALESCE_WINDOW_MS;
