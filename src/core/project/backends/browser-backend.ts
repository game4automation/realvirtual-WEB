// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * browser-backend — the writable project that needs no filesystem (§2.5).
 *
 * `folder` is Chromium-only (`'showDirectoryPicker' in window`) and `bundled`
 * is read-only. Without this backend, Safari, Firefox, every iPad and — more
 * importantly — every delivered Bunny/Firebase/CONNECT build would have no
 * writable project at all, and "everything lives in a project" would be false
 * for most of the installed base. This is the backend that makes it true.
 *
 * ## The keyspace is not migrated. That is the whole point.
 *
 * | Data | Where | Why |
 * |---|---|---|
 * | scene catalogue rows | `rv-scenes/*`, **unchanged** | the conflict machinery delivered by plan-370 Phase 2 is written against exactly these keys |
 * | blobs (GLB, thumbnails) | OPFS, SHA-addressed | localStorage is a ~5 MB string store |
 * | manifest | `rv-project/browser/<projectId>` (new key) | there is no folder to hold a `project.json` |
 * | blob path map | `rv-project/browser/<projectId>/blobs` (new key) | a manifest `path` has to resolve to a digest |
 *
 * Only the last two are new, and both describe objects that did not exist
 * before. Nothing under `rv-scenes/…` is renamed, rewritten or deleted here.
 *
 * ## How several browser projects share one flat scene keyspace (§5.1, M2)
 *
 * This is the question the plan flagged as unanswered, so here is the answer
 * in full — it needs **no** keyspace change:
 *
 *  1. **Bodies cannot collide.** `rv-scenes/<id>` is keyed by scene id, and
 *     `newSceneId()` mints `scn_<base36 time>_<6 random base36>`. Two
 *     projects therefore never write the same body key by accident. The flat
 *     keyspace is not "shared" in the dangerous sense; it is a global pool of
 *     uniquely-named bodies.
 *  2. **Membership is the marker, not the key.** `rv-scene-owner/<sceneId>`
 *     (plan-373) carries `projectIds: string[]`. `listScenes()` is a filter
 *     over the index by that array, so two browser projects see two disjoint
 *     lists out of one index without either being able to hide the other's
 *     scenes.
 *  3. **A shared id is sharing, not overwriting.** `createProjectFromScenes()`
 *     deliberately puts one scene id into several manifests. For two *browser*
 *     projects that means both list the same body — which is correct, because
 *     localStorage **is** the store here, not a cache of a file. There is no
 *     second copy that could go stale, so there is nothing to reconcile.
 *  4. **Therefore `cachedFrom` is never written by this backend.** That field
 *     answers "whose file is currently mirrored in the cache", and for a
 *     browser project the question is meaningless: nothing is mirrored. Were
 *     it set, opening a folder project that shares the id would classify the
 *     browser project's only copy as a foreign cache and default to "folder
 *     wins" — deleting the sole copy of a user's scene. Membership yes
 *     ({@link noteSceneMembership}), provenance no.
 *  5. **Draft slots no longer exist.** Both keyspaces are dead since plan-413
 *     phase 6; `setDraftScope(projectId)` survives only so the leftovers of a
 *     given project can still be cleared.
 *
 * The one case the marker cannot express is two projects that *want*
 * independent copies of the same scene id. That is not reachable through any
 * UI — duplicating a scene mints a fresh id — and it is what forking is for.
 *
 * ## No writer, and that is not an omission
 *
 * `FolderBackend` owns an `RVProjectFolderWriter` because writing a file is
 * expensive, debounced and ordering-sensitive. Here, `SceneStore` has already
 * written the body to localStorage synchronously before any mutation is
 * announced. Subscribing to the bus to write it a second time would be a
 * second source of truth. `activate()` therefore only opens the write gate
 * (and asks for persistent storage); it starts nothing.
 */

import { deleteScene as deleteSceneBody } from '../../hmi/scene/rv-scene-storage';
import {
  getBlob,
  getBlobUrl,
  putBlob,
  requestPersistence,
  sha256OfBlob,
  deleteBlob,
} from '../../storage/rv-opfs-blobs';
import {
  deleteSceneGlb,
  readSceneGlb,
  sceneGlbRevision,
  writeSceneGlb,
} from '../../storage/rv-scene-glb-store';
import {
  assertRevisionPrecondition,
  glbSceneRecord,
  type SceneRecord,
  type SceneRevision,
  type SceneWrite,
} from '../rv-scene-record';
import { assertReadableScenePath } from '../rv-legacy-format';
import {
  clearSceneOwner,
  noteSceneMembership,
  readSceneOwner,
  writeSceneOwner,
} from '../rv-scene-owner';
import {
  assetDocumentsOf,
  readDocuments,
  withDerivedDocuments,
  type DocumentStat,
} from '../rv-project-documents';
import {
  RV_PROJECT_SCHEMA_VERSION,
  canonicalNameOf,
  type RvDocumentEntry,
  type RvProject,
  type RvProjectAssetEntry,
} from '../rv-project-types';
import {
  assertWritable,
  WriteQueue,
  type ProjectBackend,
  type ResolvedBackendBlob,
  type WriteBlobOptions,
} from './project-backend';

// ─── Keyspace (additive only) ───────────────────────────────────────────

/** Prefix of every key this backend owns. Deliberately not `rv-scenes/…`. */
export const LS_KEY_BROWSER_PROJECT_PREFIX = 'rv-project/browser/';

export function browserManifestKey(projectId: string): string {
  return `${LS_KEY_BROWSER_PROJECT_PREFIX}${projectId}`;
}

export function browserBlobIndexKey(projectId: string): string {
  return `${LS_KEY_BROWSER_PROJECT_PREFIX}${projectId}/blobs`;
}

/** `relPath -> sha256` for everything this project put into OPFS. */
type BlobIndex = Record<string, string>;

// ─── Options ────────────────────────────────────────────────────────────

export interface BrowserBackendOptions {
  /** Display name for a synthesised manifest. */
  name?: string;
  /** Backend id. Defaults to `browser:<projectId>`. */
  id?: string;
  // `adoptsUnowned` is gone (plan-716 Phase 6). It made one backend adopt
  // owner-less `rv-scenes-index` rows, and the derivation it steered went with
  // the catalogue; a browser project's content is its manifest now.
  /** Ask for persistent storage on activation. Off in tests. */
  requestPersistence?: boolean;
}

// ─── Backend ────────────────────────────────────────────────────────────

export class BrowserBackend implements ProjectBackend {
  readonly kind = 'browser' as const;
  readonly id: string;
  /** Always. localStorage and OPFS need no grant and no picker. */
  readonly writable = true;

  private readonly _projectId: string;
  private readonly _name: string;
  private readonly _wantsPersistence: boolean;
  private _active = false;
  private _persistenceGranted: boolean | null = null;
  /**
   * Serialises every write of THIS backend (plan-709 §2.2.1-3).
   *
   * Not decoration: `_readBlobIndex`/`_writeBlobIndex` is a read-modify-write
   * over one localStorage value, so two concurrent writes to two different
   * paths could each write an index that has forgotten the other's entry.
   */
  private readonly _writes = new WriteQueue();

  constructor(projectId: string, opts: BrowserBackendOptions = {}) {
    if (!projectId) throw new Error('BrowserBackend needs a project id.');
    this._projectId = projectId;
    this._name = opts.name ?? 'My scenes';
    this._wantsPersistence = opts.requestPersistence ?? true;
    this.id = opts.id ?? `browser:${projectId}`;
  }

  get isActive(): boolean { return this._active; }
  get projectId(): string { return this._projectId; }

  /**
   * Outcome of the persistent-storage request made in {@link activate}.
   *
   * `null` until asked (or when the browser has no answer), `false` when it
   * was refused. Scene bodies now live in OPFS, which is **evictable** — a
   * refusal is the difference between "saved" and "saved until the device
   * runs low", and plan-397's answer to it is to keep working and say so
   * (open question 2). This is the field the shell reads to say it; the
   * `not-persisted` notice on `onBlobStoreNotice` carries the same fact for
   * listeners that were not holding the backend.
   */
  get persistenceGranted(): boolean | null { return this._persistenceGranted; }

  // ─── Read ─────────────────────────────────────────────────────────────

  /**
   * The stored manifest, with its scene list refreshed from the index.
   *
   * The scene list is derived rather than trusted: `SceneStore` writes bodies
   * without going through this backend at all (that is the point of not
   * migrating the keyspace), so a manifest copy of the list would be stale
   * within one save. What the stored manifest *does* own is everything the
   * index cannot express — name, `hidden[]`, `activeSceneId`, models, library.
   */
  async readManifest(): Promise<RvProject | null> {
    const stored = this._readStoredManifest();
    const base: RvProject = stored ?? {
      schemaVersion: RV_PROJECT_SCHEMA_VERSION,
      id: this._projectId,
      name: this._name,
      canonicalName: canonicalNameOf(this._name),
      activeSceneId: null,
    };
    return { ...base, documents: this._documentsOf(base) };
  }

  /** Persist the parts of the manifest that are not derived from the index. */
  async writeManifest(project: RvProject): Promise<void> {
    assertWritable(this);
    // Every row is stored, with no filter. The filter that used to sit here
    // dropped `scn_` scene rows because the catalogue derived them on read and
    // a stored copy could disagree with it; with the catalogue gone (plan-716
    // Phase 6) the manifest is the only place a browser project records what it
    // owns, and dropping anything on the way in would lose it.
    const documents = readDocuments(project) ?? [];
    this._writeStoredManifest({ ...project, documents, id: this._projectId } as RvProject);
  }

  /**
   * Read a scene body from the OPFS GLB store.
   *
   * `relPath` is a scene id here. A `scenes/<id>` form is accepted too, so a
   * caller holding a manifest path from a folder project does not have to
   * branch on `backend.kind`.
   *
   * The localStorage op-log body it used to fall back to is gone with the rest
   * of the JSON reader (plan-413 phase 6). A record still carrying one is
   * refused by `rv-scene-storage.readScene` with the F10 error, at the layer
   * that can actually see it — here, the id simply has no bytes.
   */
  async readScene(relPath: string): Promise<SceneRecord | null> {
    assertReadableScenePath(relPath);
    const id = sceneIdOfPath(relPath);
    if (!id) return null;
    const glb = await readSceneGlb(id);
    if (!glb) return null;
    // The name comes from the manifest row, the only place a browser project
    // records one since the catalogue went (plan-716 Phase 6). A body with no
    // row still reads — it is bytes, and refusing them here would turn a
    // recoverable orphan into a lost one.
    const meta = (readDocuments(this._readStoredManifest()) ?? []).find(d => d.id === id);
    return glbSceneRecord(glb, { id, name: meta?.name ?? '', ...meta, path: id });
  }

  async readSettings(): Promise<unknown | null> {
    return (this._readStoredManifest()?.settings as unknown) ?? null;
  }

  // ─── Listing ──────────────────────────────────────────────────────────

  async listModels(): Promise<RvProjectAssetEntry[]> {
    return assetDocumentsOf(this._readStoredManifest(), 'models');
  }

  async listLibrary(): Promise<RvProjectAssetEntry[]> {
    return assetDocumentsOf(this._readStoredManifest(), 'library');
  }

  /** The one list (plan-413 §2.4), over the index plus the stored manifest. */
  async listDocuments(): Promise<RvDocumentEntry[]> {
    return this._documentsOf(this._readStoredManifest());
  }

  /**
   * The stored manifest's documents — all of them, verbatim.
   *
   * This used to splice in a scene half derived from `rv-scenes-index` on every
   * read, because the catalogue owned scenes and the manifest owned everything
   * else. Since plan-716 Phase 6 there is no catalogue: a browser project's
   * documents are written through {@link writeBlob} and recorded in its
   * manifest like any other project's, so the stored list is the whole answer
   * and the two-source reconciliation that used to live here has nothing left
   * to reconcile.
   */
  private _documentsOf(stored: RvProject | null): RvDocumentEntry[] {
    return readDocuments(stored) ?? [];
  }

  /**
   * Stats for the documents this backend actually stores.
   *
   * Blobs are sha-addressed, and the digest alone is enough to clear the
   * scan's pre-filter, so the size is reported as 0 rather than paid for with
   * an OPFS read. The scene-pointer half that used to precede this went with
   * the catalogue (plan-716 Phase 6): the bodies it stat'ed were catalogue
   * bodies, and a browser project's documents are blobs.
   */
  async statDocuments(): Promise<DocumentStat[]> {
    const out: DocumentStat[] = [];
    const blobs = this._readBlobIndex();
    for (const [path, sha] of Object.entries(blobs)) {
      out.push({ path, size: 0, sha256: sha });
    }
    return out;
  }

  // ─── Lifecycle (§2.2.1b) ──────────────────────────────────────────────

  /**
   * Open the write gate.
   *
   * Nothing is started — see the file header. The one side effect is asking
   * for persistent storage, which belongs here rather than in the constructor
   * because discovery constructs backends for projects that are never opened
   * and must not raise a browser prompt for them.
   */
  async activate(): Promise<void> {
    if (this._active) return;
    this._active = true;
    if (this._wantsPersistence) {
      // A refusal is announced through the blob store's notice channel, not
      // thrown — the project is perfectly usable either way. It is also
      // recorded on {@link persistenceGranted}, because since plan-397 the
      // scene bodies themselves are in the evictable store.
      this._persistenceGranted = await requestPersistence().catch(() => false);
    }
  }

  async deactivate(): Promise<void> {
    this._active = false;
  }

  // ─── Write ────────────────────────────────────────────────────────────

  /**
   * Persist a scene GLB into OPFS and record membership.
   *
   * `cachedFrom` is deliberately **not** set — see point 4 of the file header.
   *
   * The precondition is checked against the pointer rather than the bytes, so
   * a compare-and-swap costs one `getItem`. What it protects against here is
   * the two-tab case: both tabs share this localStorage, so the second one to
   * save has a stale revision and is told so instead of quietly winning.
   */
  async writeScene(relPath: string, write: SceneWrite): Promise<SceneRevision> {
    assertWritable(this);
    return this._writes.run(async () => {
      const id = sceneIdOfPath(relPath) || write.meta?.id;
      if (!id) throw new Error('writeScene needs a scene id.');
      if (write.meta?.id && id !== write.meta.id) {
        throw new Error(`"${relPath}" does not address scene ${write.meta.id}.`);
      }
      assertRevisionPrecondition(relPath, write.expectedRevision, sceneGlbRevision(id));
      const revision = await writeSceneGlb(id, write.glb);
      noteSceneMembership(id, this._projectId);
      return revision;
    });
  }

  /**
   * Delete a scene.
   *
   * When the scene belongs to several projects, only this project's claim is
   * dropped and the body stays — the other owners still list it. The body and
   * the marker go together only when the last owner leaves, so a marker can
   * never outlive its scene (§9.3).
   */
  async deleteScene(relPath: string): Promise<void> {
    assertWritable(this);
    const id = sceneIdOfPath(relPath);
    if (!id) throw new Error('deleteScene needs a scene id.');
    const owner = readSceneOwner(id);
    const others = (owner?.projectIds ?? []).filter(p => p !== this._projectId);
    if (others.length > 0) {
      // Still owned elsewhere: give up the claim, keep the data.
      writeSceneOwner(id, {
        projectIds: others,
        cachedFrom: owner?.cachedFrom ?? null,
        cachedRevision: owner?.cachedRevision ?? null,
      });
      return;
    }
    // Both bodies go: during the migration window a scene can have a GLB and
    // a legacy record at once, and leaving either behind would make a deleted
    // scene reappear the next time the other one is consulted.
    deleteSceneBody(id);
    await deleteSceneGlb(id);
    clearSceneOwner(id);
  }

  /**
   * Store a blob under `relPath`.
   *
   * The digest is the storage key and the path is only an alias, so two
   * manifest entries pointing at identical bytes cost one copy. A degraded
   * (no-OPFS) store leaves the path unmapped rather than recording a
   * reference to something that was never written.
   *
   * The compare-and-swap (plan-709 §2.3) costs nothing here: the index already
   * maps every path to the SHA-256 of its bytes, which IS the revision token —
   * so the precondition is one map lookup and never a read of the blob.
   *
   * The precondition is evaluated INSIDE the write queue, not before it. Read
   * outside, it would describe a state a queued write is about to change, and a
   * caller would be told "unchanged" about bytes that are one tick from being
   * replaced.
   */
  async writeBlob(relPath: string, blob: Blob, opts?: WriteBlobOptions): Promise<void> {
    assertWritable(this);
    return this._writes.run(async () => {
      const key = normaliseRelPath(relPath);
      const index = this._readBlobIndex();
      assertRevisionPrecondition(relPath, opts?.expectedRevision, index[key] ?? null);
      const sha = await sha256OfBlob(blob);
      await putBlob(sha, blob);
      // Re-read: `putBlob` awaited, so an entry written by an earlier queue
      // item is already in localStorage, but the object read above is a
      // snapshot from before that await.
      const fresh = this._readBlobIndex();
      fresh[key] = sha;
      this._writeBlobIndex(fresh);
    });
  }

  /**
   * Resolve a blob path to a transient object URL.
   *
   * Accepts a bare digest as well as a mapped path, so a manifest entry that
   * carries only `sha256` resolves without a path round-trip.
   */
  async readBlobUrl(relPath: string): Promise<ResolvedBackendBlob | null> {
    const key = normaliseRelPath(relPath);
    const sha = this._readBlobIndex()[key] ?? (isDigestLike(key) ? key : null);
    if (!sha) return null;
    const resolved = await getBlobUrl(sha);
    if (!resolved) return null;
    // The backend contract says `release()`, the store says `revokeUrl()`.
    // Same object URL, one owner, one revoke.
    return { url: resolved.url, release: () => resolved.revokeUrl() };
  }

  async readBlobBytes(relPath: string): Promise<ArrayBuffer | null> {
    const key = normaliseRelPath(relPath);
    const sha = this._readBlobIndex()[key] ?? (isDigestLike(key) ? key : null);
    if (!sha) return null;
    // The store hands back the stored File itself. `getBlobUrl` wraps exactly
    // this in an object URL; skipping the wrapper is the whole point.
    const blob = await getBlob(sha);
    return blob ? await blob.arrayBuffer() : null;
  }

  /**
   * Forget a blob path. The bytes go only when nothing else maps to them.
   *
   * On the write queue for the same reason `writeBlob` is: this is the OTHER
   * read-modify-write of the shared index, and a delete interleaved with a
   * write is exactly how a live path loses its digest.
   */
  async deleteBlob(relPath: string): Promise<void> {
    assertWritable(this);
    return this._writes.run(async () => {
      const index = this._readBlobIndex();
      const key = normaliseRelPath(relPath);
      const sha = index[key];
      if (!sha) return;
      delete index[key];
      this._writeBlobIndex(index);
      if (!Object.values(index).includes(sha)) await deleteBlob(sha);
    });
  }

  /** Await the write queue. Nothing else is buffered. */
  async flush(): Promise<void> {
    await this._writes.drain();
  }

  // ─── Internals ────────────────────────────────────────────────────────

  // `_sceneEntries()` is gone (plan-716 Phase 6). It scanned `rv-scenes-index`
  // and the OPFS body pointers to synthesise scene rows for `listScenes()` and
  // for the scene half of `listDocuments()`. Both callers are gone: a browser
  // project records what it owns in its manifest, like every other project.


  /**
   * The stored manifest, with its document list derived when it has none.
   *
   * A manifest an older build of this very app wrote carries `models[]` /
   * `library[]` and no `documents[]`. Nothing converts it on the way in — there
   * is no folder read to hang that off — so the derivation happens here, at the
   * one place that reads the key.
   */
  private _readStoredManifest(): RvProject | null {
    return withDerivedDocuments(readJson<RvProject>(browserManifestKey(this._projectId)));
  }

  private _writeStoredManifest(project: RvProject): void {
    writeJson(browserManifestKey(this._projectId), project);
  }

  private _readBlobIndex(): BlobIndex {
    return readJson<BlobIndex>(browserBlobIndexKey(this._projectId)) ?? {};
  }

  private _writeBlobIndex(index: BlobIndex): void {
    writeJson(browserBlobIndexKey(this._projectId), index);
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────

// `isCatalogueSceneDocument()` is gone with the catalogue (plan-716 Phase 6).
// It told a `scn_` row derived from `rv-scenes-index` apart from a real
// manifest document, so that the derived half was never stored twice. Nothing
// derives any more: every row in this backend's list is a document, and the
// distinction it drew no longer has two sides.

/** `scenes/<id>`, `<id>` and `<id>.scene.glb` all address the same scene. */
export function sceneIdOfPath(relPath: string): string {
  const raw = (relPath ?? '').trim();
  if (!raw) return '';
  const last = raw.split('/').pop() ?? raw;
  return last.replace(/\.scene\.glb$/i, '');
}

function normaliseRelPath(relPath: string): string {
  return (relPath ?? '').trim().replace(/^\/+/, '');
}

function isDigestLike(value: string): boolean {
  return /^[0-9a-f]{64}$/i.test(value);
}

function readJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as T) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* quota / private mode — surfaced by the scene-storage error channel */
  }
}
