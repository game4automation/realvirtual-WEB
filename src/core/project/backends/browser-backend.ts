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
 * | scene JSON | `rv-scenes/*`, **unchanged** | the draft/conflict machinery delivered by plan-370 Phase 2 is written against exactly these keys |
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
 *  5. **Drafts are already scoped.** `setDraftScope(projectId)` prefixes the
 *     per-base draft slot, and `rv-scenes/scene-draft/<id>` is keyed by the
 *     same unique scene id. Both are collision-free for free.
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

import {
  deleteScene as deleteSceneBody,
  listMetas,
  readScene as readSceneBody,
  writeScene as writeSceneBody,
} from '../../hmi/scene/rv-scene-storage';
import type { RvScene } from '../../hmi/scene/rv-scene-types';
import {
  getBlobUrl,
  putBlob,
  requestPersistence,
  sha256OfBlob,
  deleteBlob,
} from '../../storage/rv-opfs-blobs';
import {
  clearSceneOwner,
  noteSceneMembership,
  readSceneOwner,
  writeSceneOwner,
} from '../rv-scene-owner';
import {
  RV_PROJECT_SCHEMA_VERSION,
  canonicalNameOf,
  type RvProject,
  type RvProjectAssetEntry,
  type RvProjectSceneEntry,
} from '../rv-project-types';
import {
  assertWritable,
  type ProjectBackend,
  type ResolvedBackendBlob,
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
  /**
   * Treat unowned index entries as belonging to this project (§2.4).
   *
   * True for exactly one backend — the user tier of the Sample project. A
   * scene with no marker is a scene from before this plan, and §2.4 says it
   * belongs to Sample. Any *other* browser project claiming them would be
   * inventing membership.
   */
  adoptsUnowned?: boolean;
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
  private readonly _adoptsUnowned: boolean;
  private readonly _wantsPersistence: boolean;
  private _active = false;

  constructor(projectId: string, opts: BrowserBackendOptions = {}) {
    if (!projectId) throw new Error('BrowserBackend needs a project id.');
    this._projectId = projectId;
    this._name = opts.name ?? 'My scenes';
    this._adoptsUnowned = opts.adoptsUnowned ?? false;
    this._wantsPersistence = opts.requestPersistence ?? true;
    this.id = opts.id ?? `browser:${projectId}`;
  }

  get isActive(): boolean { return this._active; }
  get projectId(): string { return this._projectId; }
  /** Does this backend adopt marker-less scenes (§2.4)? */
  get adoptsUnowned(): boolean { return this._adoptsUnowned; }

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
    return { ...base, scenes: this._sceneEntries() };
  }

  /** Persist the parts of the manifest that are not derived from the index. */
  async writeManifest(project: RvProject): Promise<void> {
    assertWritable(this);
    // `scenes` is derived on every read; storing it would only create a copy
    // that can disagree with the index.
    const { scenes: _scenes, ...rest } = project;
    void _scenes;
    this._writeStoredManifest({ ...rest, id: this._projectId } as RvProject);
  }

  /**
   * Read a scene body.
   *
   * `relPath` is a scene id here. A `scenes/<id>` form is accepted too, so a
   * caller holding a manifest path from a folder project does not have to
   * branch on `backend.kind`.
   */
  async readScene(relPath: string): Promise<RvScene | null> {
    return readSceneBody(sceneIdOfPath(relPath));
  }

  async readSettings(): Promise<unknown | null> {
    return (this._readStoredManifest()?.settings as unknown) ?? null;
  }

  // ─── Listing ──────────────────────────────────────────────────────────

  /** Index entries this project owns, newest first (the index's own order). */
  async listScenes(): Promise<RvProjectSceneEntry[]> {
    return this._sceneEntries();
  }

  async listModels(): Promise<RvProjectAssetEntry[]> {
    return this._readStoredManifest()?.models ?? [];
  }

  async listLibrary(): Promise<RvProjectAssetEntry[]> {
    return this._readStoredManifest()?.library ?? [];
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
      // thrown — the project is perfectly usable either way.
      await requestPersistence().catch(() => false);
    }
  }

  async deactivate(): Promise<void> {
    this._active = false;
  }

  // ─── Write ────────────────────────────────────────────────────────────

  /**
   * Persist a scene body and record membership.
   *
   * `cachedFrom` is deliberately **not** set — see point 4 of the file header.
   */
  async writeScene(relPath: string, scene: RvScene): Promise<void> {
    assertWritable(this);
    const id = sceneIdOfPath(relPath) || scene.id;
    if (id !== scene.id) {
      throw new Error(`"${relPath}" does not address scene ${scene.id}.`);
    }
    writeSceneBody(scene);
    noteSceneMembership(scene.id, this._projectId);
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
      writeSceneOwner(id, { projectIds: others, cachedFrom: owner?.cachedFrom ?? null });
      return;
    }
    deleteSceneBody(id);
    clearSceneOwner(id);
  }

  /**
   * Store a blob under `relPath`.
   *
   * The digest is the storage key and the path is only an alias, so two
   * manifest entries pointing at identical bytes cost one copy. A degraded
   * (no-OPFS) store leaves the path unmapped rather than recording a
   * reference to something that was never written.
   */
  async writeBlob(relPath: string, blob: Blob): Promise<void> {
    assertWritable(this);
    const sha = await sha256OfBlob(blob);
    await putBlob(sha, blob);
    const index = this._readBlobIndex();
    index[normaliseRelPath(relPath)] = sha;
    this._writeBlobIndex(index);
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

  /** Forget a blob path. The bytes go only when nothing else maps to them. */
  async deleteBlob(relPath: string): Promise<void> {
    assertWritable(this);
    const index = this._readBlobIndex();
    const key = normaliseRelPath(relPath);
    const sha = index[key];
    if (!sha) return;
    delete index[key];
    this._writeBlobIndex(index);
    if (!Object.values(index).includes(sha)) await deleteBlob(sha);
  }

  /** Nothing is queued, so there is nothing to await. */
  async flush(): Promise<void> {}

  // ─── Internals ────────────────────────────────────────────────────────

  /**
   * Index entries this project owns.
   *
   * The `path` is the scene id: for a browser project the "path" is an
   * addressing token, and inventing a `scenes/<slug>-<id>.scene.json` that
   * corresponds to no file would be a lie a later reader could act on.
   */
  private _sceneEntries(): RvProjectSceneEntry[] {
    const out: RvProjectSceneEntry[] = [];
    for (const meta of listMetas()) {
      const owner = readSceneOwner(meta.id);
      const owned = owner?.projectIds.includes(this._projectId) ?? false;
      const unowned = !owner || owner.projectIds.length === 0;
      if (!owned && !(this._adoptsUnowned && unowned)) continue;
      out.push({
        id: meta.id,
        name: meta.name,
        path: meta.id,
        createdAt: meta.createdAt,
        modifiedAt: meta.modifiedAt,
        baseKind: meta.baseKind,
        baseLabel: meta.baseLabel,
        ...(meta.parentId ? { parentId: meta.parentId } : {}),
      });
    }
    return out;
  }

  private _readStoredManifest(): RvProject | null {
    return readJson<RvProject>(browserManifestKey(this._projectId));
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

/** `scenes/<id>`, `<id>` and `<id>.scene.json` all address the same scene. */
export function sceneIdOfPath(relPath: string): string {
  const raw = (relPath ?? '').trim();
  if (!raw) return '';
  const last = raw.split('/').pop() ?? raw;
  return last.replace(/\.scene\.json$/i, '');
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
