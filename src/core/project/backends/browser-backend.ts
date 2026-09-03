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
  listSceneGlbIds,
  readSceneGlb,
  readSceneGlbPointer,
  sceneGlbRevision,
  writeSceneGlb,
} from '../../storage/rv-scene-glb-store';
import {
  assertRevisionPrecondition,
  type SceneRevision,
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
  sceneGlbRelPathFor,
  type RvDocumentEntry,
  type RvProject,
  type RvProjectAssetEntry,
  type RvProjectSceneEntry,
} from '../rv-project-types';
import {
  assertWritable,
  docPathOf,
  docRefOf,
  documentRecord,
  preconditionOf,
  WriteQueue,
  type DocRef,
  type DocumentRecord,
  type ProjectBackend,
  type ResolvedBackendBlob,
  type WriteDocumentOptions,
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
   * Read one document body — from whichever of this backend's two stores
   * actually holds it.
   *
   * ## The routing lives here, and it is not a manifest lookup
   *
   * This backend keeps bodies in two places: scene GLBs under
   * `rv-scene-glb/<id>` (a pointer plus an OPFS blob, plan-397) and everything
   * else in the path-keyed blob index. Until plan-736 the *caller* chose
   * between them by reading `section` off the manifest row — a stored string
   * deciding a storage protocol.
   *
   * The choice is now made by asking the stores themselves, in the only order
   * that is safe: an id with a scene pointer IS a scene body, and anything else
   * is a blob. That is backend authority rather than a heuristic — no path
   * shape is interpreted, and a manifest that says nothing (or says something
   * stale) cannot misroute a read.
   */
  async readDocument(ref: DocRef): Promise<DocumentRecord | null> {
    const relPath = docPathOf(ref);
    assertReadableScenePath(relPath);
    const sceneId = this._storedSceneId(ref);
    if (sceneId) {
      const glb = await readSceneGlb(sceneId);
      if (glb) {
        // The name comes from the manifest row, the only place a browser
        // project records one since the catalogue went (plan-716 Phase 6). A
        // body with no row still reads — it is bytes, and refusing them here
        // would turn a recoverable orphan into a lost one.
        const meta = (readDocuments(this._readStoredManifest()) ?? []).find(d => d.id === sceneId);
        return documentRecord(glb, { id: sceneId, name: meta?.name ?? '', ...meta, path: relPath });
      }
    }
    const bytes = await this._blobBytes(relPath);
    if (!bytes) return null;
    const meta = (readDocuments(this._readStoredManifest()) ?? []).find(d => d.path === relPath);
    return documentRecord(new Uint8Array(bytes), { ...meta, path: relPath });
  }

  /**
   * The scene id whose body this backend stores for `ref`, or null.
   *
   * Both spellings are consulted and a **stored pointer is required** in each
   * case: an id the caller supplied, and the id-shaped forms of the path
   * ({@link sceneIdOfPath}). Requiring the pointer is what keeps this from
   * becoming the path heuristic it replaces — `library/Foo.glb` has no pointer,
   * so it can never be mistaken for a scene no matter how it is spelled, and a
   * root-level document whose name happens to collide with a scene id resolves
   * to a scene only if a scene body genuinely lives under that id.
   */
  private _storedSceneId(ref: DocRef): string | null {
    const { path, id, meta } = docRefOf(ref);
    for (const candidate of [meta?.id, id, sceneIdOfPath(path)]) {
      if (candidate && readSceneGlbPointer(candidate)) return candidate;
    }
    return null;
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
   * documents are written through {@link writeDocument} and recorded in its
   * manifest like any other project's, so the stored list is the whole answer
   * and the two-source reconciliation that used to live here has nothing left
   * to reconcile.
   */
  private _documentsOf(stored: RvProject | null): RvDocumentEntry[] {
    return readDocuments(stored) ?? [];
  }

  /**
   * Stats for the documents this backend actually stores — **both** stores.
   *
   * Blobs are sha-addressed, and the digest alone is enough to clear the
   * scan's pre-filter, so the size is reported as 0 rather than paid for with
   * an OPFS read.
   *
   * ## Why the scene half is back (plan-736 §2.3, Phase 1)
   *
   * It was dropped with the catalogue (plan-716 Phase 6) on the grounds that
   * "a browser project's documents are blobs". They are not: scene bodies live
   * in the GLB store, so a stat list built from the blob index alone was
   * missing every scene — and that hole is precisely what
   * `sectionOfDocument(r) !== 'scenes'` was guarding in the adopt/orphan filter
   * (`rv-asset-identity.ts`). A scene row looked "missing" to the scan, and
   * without the guard it would have been quarantined and eventually deleted.
   *
   * Enumerating the scene store closes the hole at its source. The scan now
   * sees EVERY body this backend holds, which is what makes the manifest-side
   * section test removable rather than merely relocatable: the information goes
   * back to where it factually is (the backend), instead of being mirrored into
   * a manifest field that could disagree with it.
   *
   * Scene rows address their body by id and carry `path = id`
   * (`documentOfSceneEntry`), so a pointer is reported under its id and matches
   * the row by path. A pointer for a scene this project does not list is still
   * reported — a stat is a statement about storage, and the reconciliation
   * above decides what to do with one nothing claims.
   */
  async statDocuments(): Promise<DocumentStat[]> {
    const out: DocumentStat[] = [];
    for (const [path, sha] of Object.entries(this._readBlobIndex())) {
      out.push({ path, size: 0, sha256: sha });
    }
    const seen = new Set(out.map(s => s.path));
    for (const id of listSceneGlbIds()) {
      const pointer = readSceneGlbPointer(id);
      // A key with an unparseable value is not a body. `readSceneGlbPointer`
      // already returns null for one, and reporting a stat for it would tell
      // the scan a body exists where none does — the exact direction that
      // loses data.
      if (!pointer || seen.has(id)) continue;
      const mtime = Date.parse(pointer.updatedAt);
      out.push({
        path: id,
        size: pointer.size,
        sha256: pointer.sha,
        ...(Number.isFinite(mtime) ? { mtime } : {}),
      });
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
   * Persist one document body into whichever of this backend's stores owns it.
   *
   * ## How the store is chosen, now that `section` is not available
   *
   * Two rules, and neither reads a manifest field:
   *
   *  1. **An existing scene pointer wins.** A body already living under
   *     `rv-scene-glb/<id>` keeps living there, so a re-save can never split a
   *     document across both stores. That is {@link _storedSceneId} — backend
   *     authority, the same rule the read path uses.
   *  2. **Otherwise `ref.meta` decides**, because a caller that hands over a
   *     scene row is a caller performing a scene save. This is *caller intent
   *     at the call site*, not a persisted category: nothing stores it, nothing
   *     can disagree with it later, and only this one backend consults it. It
   *     exists because a brand-new scene has no pointer yet, and routing its
   *     first save into the blob index would leave `readSceneGlb(id)` — which
   *     the scene layer calls directly — permanently empty.
   *
   * Everything else is a blob keyed by path, which is every document the
   * library, the importer and the document ops write.
   *
   * `cachedFrom` is deliberately **not** set — see point 4 of the file header.
   *
   * The scene precondition is checked against the pointer rather than the
   * bytes, so a compare-and-swap costs one `getItem`; the blob precondition is
   * one map lookup. What both protect against here is the two-tab case: both
   * tabs share this localStorage, so the second one to save has a stale
   * revision and is told so instead of quietly winning.
   *
   * ## `relPath` is validated, never reversed (plan-454)
   *
   * The scene branch does not derive the scene id back out of `relPath`. That
   * derivation **cannot exist**: `sceneIdToken()` replaces every character
   * outside `[A-Za-z0-9_-]` with `_` on purpose, and `sceneGlbFileNameFor()`
   * puts a name slug in front of it — so `<slug>-<token>.scene.glb` simply does
   * not carry the id any more. `meta.id` is the id, and `relPath` is checked
   * for **belonging** instead — see {@link _assertPathBelongsToScene}.
   */
  async writeDocument(
    ref: DocRef,
    bytes: Uint8Array,
    opts: WriteDocumentOptions,
  ): Promise<{ revision: SceneRevision }> {
    assertWritable(this);
    const { path: relPath, meta } = docRefOf(ref);
    const expected = preconditionOf(opts.expectedRevision);
    return this._writes.run(async () => {
      // A caller that hands over a scene row hands over its id with it. An
      // empty one is not "write this as a blob then" — it is a scene save that
      // has lost track of what it is saving, and the body would land under a
      // path key that `readSceneGlb(id)` can never find. Refused in the words
      // the folder backend has always used.
      if (meta && !meta.id) throw new Error('writeScene needs meta.id.');
      const sceneId = this._storedSceneId(ref) ?? meta?.id ?? null;
      if (sceneId && meta) this._assertPathBelongsToScene(relPath, meta);
      if (sceneId) {
        assertRevisionPrecondition(relPath, expected, sceneGlbRevision(sceneId));
        const revision = await writeSceneGlb(sceneId, bytes);
        noteSceneMembership(sceneId, this._projectId);
        return { revision };
      }

      const key = normaliseRelPath(relPath);
      const index = this._readBlobIndex();
      assertRevisionPrecondition(relPath, expected, index[key] ?? null);
      // The digest is the storage key and the path is only an alias, so two
      // manifest entries pointing at identical bytes cost one copy.
      const blob = new Blob([bytes as unknown as BlobPart]);
      const sha = await sha256OfBlob(blob);
      await putBlob(sha, blob);
      // Re-read: `putBlob` awaited, so an entry written by an earlier queue
      // item is already in localStorage, but the object read above is a
      // snapshot from before that await.
      const fresh = this._readBlobIndex();
      fresh[key] = sha;
      this._writeBlobIndex(fresh);
      return { revision: sha };
    });
  }

  /**
   * Refuse a `relPath` that does not belong to `meta.id` — in three stages,
   * in this order (plan-454 §2.1).
   *
   *  1. **Who owns the path?** A row of a *different* document holding exactly
   *     this path is refused, always — even when the path is the canonical one
   *     for `meta` as well. This stage is not optional and not redundant:
   *     `sceneIdToken()` is lossy, so `a:b` and `a/b` both become `a_b`, and
   *     with an equal name the slug collides too — the whole filename is then
   *     identical for two different scenes. Comparing only against *this*
   *     scene's canonical path would happily accept a path another scene
   *     already owns. This is the invariant `FolderBackend`'s
   *     `_assertPathMatchesEntry` protects (the "RR1 collision").
   *  2. **Does a row already exist for this id?** Then `relPath` has to be that
   *     row's stored `path`, so an established document cannot acquire a second
   *     home. A deliberate **browser-specific tightening** — the folder backend
   *     checks foreign ownership only (§2.2).
   *  3. **Only without a row** is a fresh path accepted, and only the canonical
   *     `sceneGlbRelPathFor(meta)` or one of the id-addressing forms
   *     {@link sceneIdOfPath} has always allowed (`<id>`, `scenes/<id>`,
   *     `<id>.scene.glb`) — the browser backend keys its bodies by scene id, so
   *     addressing one by its id is how most callers reach it.
   */
  private _assertPathBelongsToScene(relPath: string, meta: RvProjectSceneEntry): void {
    const id = meta.id;
    const rows = readDocuments(this._readStoredManifest()) ?? [];

    // 1 — a path owned by somebody else, no matter how canonical it looks.
    const owner = rows.find(e => e.path === relPath);
    if (owner && owner.id !== id) {
      throw new Error(`"${relPath}" belongs to scene ${owner.id}, not ${id}.`);
    }

    // 2 — an existing row pins the path.
    const row = rows.find(e => e.id === id);
    if (row) {
      if (row.path !== relPath) {
        throw new Error(`Scene ${id} is stored at "${row.path}" — refusing to write it to "${relPath}".`);
      }
      return;
    }

    // 3 — no row yet: the canonical path, or the scene's own id.
    const canonical = sceneGlbRelPathFor({ id, name: meta.name });
    if (relPath === canonical) return;
    if (sceneIdOfPath(relPath) === id) return;
    throw new Error(
      `"${relPath}" does not belong to scene ${id} — expected "${canonical}" or its id.`,
    );
  }

  /**
   * Delete one document body from whichever store holds it.
   *
   * The scene branch keeps its sharing rule: when the scene belongs to several
   * projects, only this project's claim is dropped and the body stays — the
   * other owners still list it. The body and the marker go together only when
   * the last owner leaves, so a marker can never outlive its scene (§9.3).
   *
   * The blob branch keeps its content-addressing rule: the path alias goes
   * first and the bytes only once nothing else maps to them.
   *
   * On the write queue for the same reason {@link writeDocument} is: the blob
   * branch is the OTHER read-modify-write of the shared index, and a delete
   * interleaved with a write is exactly how a live path loses its digest.
   */
  async deleteDocument(ref: DocRef): Promise<void> {
    assertWritable(this);
    const relPath = docPathOf(ref);
    const sceneId = this._storedSceneId(ref);
    return this._writes.run(async () => {
      if (sceneId) {
        const owner = readSceneOwner(sceneId);
        const others = (owner?.projectIds ?? []).filter(p => p !== this._projectId);
        if (others.length > 0) {
          // Still owned elsewhere: give up the claim, keep the data.
          writeSceneOwner(sceneId, {
            projectIds: others,
            cachedFrom: owner?.cachedFrom ?? null,
            cachedRevision: owner?.cachedRevision ?? null,
          });
          return;
        }
        // Both bodies go: during the migration window a scene can have a GLB
        // and a legacy record at once, and leaving either behind would make a
        // deleted scene reappear the next time the other one is consulted.
        deleteSceneBody(sceneId);
        await deleteSceneGlb(sceneId);
        clearSceneOwner(sceneId);
        return;
      }

      const index = this._readBlobIndex();
      const key = normaliseRelPath(relPath);
      const sha = index[key];
      if (!sha) return;
      delete index[key];
      this._writeBlobIndex(index);
      if (!Object.values(index).includes(sha)) await deleteBlob(sha);
    });
  }

  /**
   * Resolve a document to a transient object URL.
   *
   * Accepts a bare digest as well as a mapped path, so a manifest entry that
   * carries only `sha256` resolves without a path round-trip; a scene body
   * resolves through its pointer's digest, which is the same OPFS blob.
   */
  async readDocumentUrl(ref: DocRef): Promise<ResolvedBackendBlob | null> {
    const sha = this._shaFor(ref);
    if (!sha) return null;
    const resolved = await getBlobUrl(sha);
    if (!resolved) return null;
    // The backend contract says `release()`, the store says `revokeUrl()`.
    // Same object URL, one owner, one revoke.
    return { url: resolved.url, release: () => resolved.revokeUrl() };
  }

  /** The OPFS digest that holds `ref`'s bytes, from either store. */
  private _shaFor(ref: DocRef): string | null {
    const sceneId = this._storedSceneId(ref);
    if (sceneId) return readSceneGlbPointer(sceneId)?.sha ?? null;
    const key = normaliseRelPath(docPathOf(ref));
    return this._readBlobIndex()[key] ?? (isDigestLike(key) ? key : null);
  }

  /** Blob-store bytes for a path, or null. The store hands back its own File. */
  private async _blobBytes(relPath: string): Promise<ArrayBuffer | null> {
    const key = normaliseRelPath(relPath);
    const sha = this._readBlobIndex()[key] ?? (isDigestLike(key) ? key : null);
    if (!sha) return null;
    const blob = await getBlob(sha);
    return blob ? await blob.arrayBuffer() : null;
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

/**
 * `scenes/<id>`, `<id>` and `<id>.scene.glb` all address the same scene.
 *
 * A **convenience for callers**, and nothing more: this backend keys its
 * bodies by scene id, so a caller holding an id, a folder-style path or a
 * filename should not have to branch on which one it has.
 *
 * It is expressly **not** the inverse of the filename construction, and must
 * never be used as one (plan-454). `sceneIdToken()` replaces every character
 * outside `[A-Za-z0-9_-]` with `_` — deliberately lossy — and
 * `sceneGlbFileNameFor()` prefixes a name slug that is not part of the id at
 * all. From `<slug>-<token>.scene.glb` no id can be recovered; feeding one in
 * here yields the whole basename, not an id. Ownership of a path is therefore
 * *looked up* (see {@link BrowserBackend.writeScene}), never derived.
 */
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
