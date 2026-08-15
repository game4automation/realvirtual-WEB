// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-project-folder-writer — keeps `project.json` and the settings bundle in
 * step with the open project folder.
 *
 * Subscribes to the scene mutation bus (§4d), coalesces the resulting work
 * over a short debounce, and then writes the **manifest last** — after the
 * bodies, which is the ordering `writeScene()` uses for body-before-index and
 * for the same reason: a manifest may never point at a file that is not there
 * yet.
 *
 * ## It no longer writes scene bodies (plan-413 phase 6)
 *
 * It used to serialise the mutation's `RvScene` into `scenes/<slug>.scene.json`.
 * That was the op-log world; since plan-397 a scene body is a GLB written by
 * `writeSceneGlbBody()` → `backend.writeScene()`, *before* the mutation is even
 * emitted. Keeping the JSON write alongside it did more than waste a file: the
 * manifest row it upserted named the `.scene.json` path, so the next save
 * pushed GLB bytes into a file called `.scene.json` and the scene stopped being
 * readable. What the writer keeps is the half only it can do — the manifest row,
 * the rename retirement, the deletion, the active id and the settings bundle.
 *
 * ## RR1 — the filename contract, and why it is enforced here
 *
 * Filenames come from {@link sceneGlbFileNameFor}, which folds the scene **id**
 * into the name. That alone would already be enough to stop two scenes
 * called "Cell" from sharing a file. The writer nevertheless re-checks,
 * before *every* delete, that the path it is about to touch belongs to the
 * manifest entry it thinks it is touching, and that no other entry claims it.
 * Belt and braces, because the failure mode is not a broken render — it is
 * silently deleting a different, still-valid scene file. On a mismatch the
 * operation is refused and the project is marked as not-saved-to-disk;
 * nothing is removed.
 *
 * ## §4e — failure is visible, and "saved" means saved
 *
 * `writeBlobFile` and `getOrCreateSubfolder` have no error handling of their
 * own. Disk full, a file locked by a virus scanner or OneDrive, a read-only
 * folder, or a handle invalidated because the folder was renamed (which only
 * throws at I/O time, not at `queryPermission`) all fail here. Every write
 * is wrapped; a failure sets a **persistent** status, never a transient
 * toast, and leaves the scene marked dirty. The alternative is the exact
 * scenario this whole plan exists to prevent: the UI says "saved", the
 * folder is old.
 *
 * A pending debounce does not survive a tab close, so {@link flush} is
 * awaited by `closeProject()` and fired from `pagehide`/`visibilitychange`.
 *
 * Thumbnails: `thumbnailDataUrl` is never written by any code path in this
 * build (verified), so there is nothing to extract to `thumbnails/*.png`.
 * Thumbnail capture is a separate feature; this writer does not pretend to
 * do it.
 */

import { readActiveId, readScene } from '../hmi/scene/rv-scene-storage';
import { onSceneMutation, type SceneMutation } from '../hmi/scene/rv-scene-mutations';
import type { RvScene } from '../hmi/scene/rv-scene-types';
import {
  deleteSceneFile,
  mergeManifest,
  writeManifest,
  writeSettingsFile,
  type ManifestUpdate,
} from './rv-project-storage';
import { sceneDocumentsOf } from './rv-project-documents';
import {
  sceneFileNameOfPath,
  sceneGlbRelPathFor,
  type RvProject,
  type RvProjectSceneEntry,
} from './rv-project-types';

/** Coalescing window for folder writes. */
export const FOLDER_WRITE_DEBOUNCE_MS = 1000;

// ─── Status (§4e) ───────────────────────────────────────────────────────

export interface FolderWriterStatus {
  /** A write is scheduled or running. */
  pending: boolean;
  /** Persistent error text; null when the last write succeeded. */
  error: string | null;
  /** True when the handle went invalid — caller should drop to read-only. */
  handleInvalid: boolean;
  /** ISO timestamp of the last successful disk write. */
  lastWriteAt: string | null;
}

export type FolderWriterStatusListener = (status: FolderWriterStatus) => void;

/** Everything the writer needs from its host, injected so it stays testable. */
export interface FolderWriterHost {
  /** The project root handle, or null when the project is read-only/closed. */
  getDirectory(): FileSystemDirectoryHandle | null;
  /** The manifest as last read/written. Mutated in place by the writer. */
  getManifest(): RvProject;
  /** Hand the freshly merged manifest back to the host. */
  setManifest(project: RvProject): void;
  /** Read a scene body. Defaults to localStorage. */
  readScene?(id: string): RvScene | null;
  /** Collect the settings bundle to persist, or null to skip settings. */
  collectSettings?(): unknown | null;
}

// ─── Writer ─────────────────────────────────────────────────────────────

export class RVProjectFolderWriter {
  private readonly _host: FolderWriterHost;
  private readonly _debounceMs: number;

  /** Scene ids whose body needs writing. */
  private _dirtyScenes = new Set<string>();
  /** Scene ids to delete, with the path recorded at delete time. */
  private _deletedScenes = new Map<string, string>();
  /** Pending rename bookkeeping: id → previous on-disk path. */
  private _staleScenePaths = new Map<string, string>();
  private _activeDirty = false;
  private _settingsDirty = false;

  private _timer: ReturnType<typeof setTimeout> | null = null;
  private _inFlight: Promise<void> | null = null;
  private _unsubscribe: (() => void) | null = null;
  private _disposed = false;

  private _status: FolderWriterStatus = {
    pending: false,
    error: null,
    handleInvalid: false,
    lastWriteAt: null,
  };
  private _statusListeners = new Set<FolderWriterStatusListener>();

  constructor(host: FolderWriterHost, debounceMs: number = FOLDER_WRITE_DEBOUNCE_MS) {
    this._host = host;
    this._debounceMs = debounceMs;
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────

  /** Subscribe to the scene mutation bus. Idempotent. */
  start(): void {
    if (this._unsubscribe || this._disposed) return;
    this._unsubscribe = onSceneMutation(m => this.handleMutation(m));
  }

  /** Stop listening. Does NOT flush — callers await {@link flush} first. */
  stop(): void {
    this._unsubscribe?.();
    this._unsubscribe = null;
  }

  /** Stop listening and drop all pending work. */
  dispose(): void {
    this.stop();
    this._cancelTimer();
    this._disposed = true;
  }

  // ─── Status ───────────────────────────────────────────────────────────

  getStatus(): FolderWriterStatus { return this._status; }

  onStatus(listener: FolderWriterStatusListener): () => void {
    this._statusListeners.add(listener);
    return () => { this._statusListeners.delete(listener); };
  }

  /** True while anything is queued or a write failed — i.e. disk is behind. */
  isDirty(): boolean {
    return this._status.pending || this._status.error !== null;
  }

  private _setStatus(patch: Partial<FolderWriterStatus>): void {
    this._status = { ...this._status, ...patch };
    for (const l of [...this._statusListeners]) {
      try { l(this._status); } catch { /* listener errors never break a save */ }
    }
  }

  // ─── Intake ───────────────────────────────────────────────────────────

  /** Translate a scene mutation into queued file work. */
  handleMutation(mutation: SceneMutation): void {
    if (this._disposed) return;
    switch (mutation.type) {
      case 'upsert':
        this._dirtyScenes.add(mutation.id);
        this._deletedScenes.delete(mutation.id);
        break;
      case 'rename': {
        // A rename changes the slug half of the filename, so the old file
        // has to go after the new one is written. Record the old path now,
        // while the manifest still carries it.
        const prev = this._manifestEntry(mutation.id)?.path;
        const next = this._pathFor(mutation.scene);
        if (prev && prev !== next) this._staleScenePaths.set(mutation.id, prev);
        this._dirtyScenes.add(mutation.id);
        this._deletedScenes.delete(mutation.id);
        break;
      }
      case 'delete': {
        const entry = this._manifestEntry(mutation.id);
        // Only a manifest-managed scene may be removed from disk. An unknown
        // id means the folder never owned it — R2 forbids tidying it away.
        if (entry?.path) this._deletedScenes.set(mutation.id, entry.path);
        this._dirtyScenes.delete(mutation.id);
        break;
      }
      case 'active':
        this._activeDirty = true;
        break;
    }
    this._schedule();
  }

  /** Mark the settings bundle as needing a write. */
  markSettingsDirty(): void {
    this._settingsDirty = true;
    this._schedule();
  }

  private _schedule(): void {
    if (this._disposed) return;
    if (!this._hasWork()) return;
    this._setStatus({ pending: true });
    this._cancelTimer();
    this._timer = setTimeout(() => {
      this._timer = null;
      void this._run();
    }, this._debounceMs);
  }

  private _cancelTimer(): void {
    if (this._timer !== null) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }

  private _hasWork(): boolean {
    return this._dirtyScenes.size > 0
      || this._deletedScenes.size > 0
      || this._staleScenePaths.size > 0
      || this._activeDirty
      || this._settingsDirty;
  }

  /**
   * Run any pending write immediately and wait for it.
   *
   * Called by `closeProject()` and by the `pagehide`/`visibilitychange`
   * handlers — a `setTimeout` debounce does not survive a tab close, so
   * without this a "Saved" a second before closing is simply lost.
   */
  async flush(): Promise<void> {
    this._cancelTimer();
    if (this._inFlight) await this._inFlight.catch(() => undefined);
    if (this._hasWork()) await this._run();
  }

  // ─── Write ────────────────────────────────────────────────────────────

  private async _run(): Promise<void> {
    if (this._inFlight) {
      await this._inFlight.catch(() => undefined);
      if (!this._hasWork()) return;
    }
    const task = this._writeOnce();
    this._inFlight = task;
    try {
      await task;
    } finally {
      if (this._inFlight === task) this._inFlight = null;
    }
  }

  private async _writeOnce(): Promise<void> {
    const dir = this._host.getDirectory();
    if (!dir) {
      // Read-only or closed: keep the queue so a later re-grant can still
      // write it, and say plainly that the disk is behind.
      this._setStatus({
        pending: this._hasWork(),
        error: 'Project folder is not writable — changes are only in browser storage.',
      });
      return;
    }

    // Snapshot and clear the queue up front, so mutations arriving during
    // the await land in the next batch instead of being lost.
    const dirtyIds = [...this._dirtyScenes];
    const deletions = [...this._deletedScenes.entries()];
    const staleRenames = [...this._staleScenePaths.entries()];
    const wantActive = this._activeDirty;
    const wantSettings = this._settingsDirty;
    this._dirtyScenes.clear();
    this._deletedScenes.clear();
    this._staleScenePaths.clear();
    this._activeDirty = false;
    this._settingsDirty = false;

    const readSceneFn = this._host.readScene ?? readScene;
    const upserts: RvProjectSceneEntry[] = [];
    const removeSceneIds: string[] = [];
    const problems: string[] = [];

    try {
      // ── 1. Manifest rows for the scenes whose bodies were just written ──
      for (const id of dirtyIds) {
        const scene = readSceneFn(id);
        if (!scene) {
          // The catalogue row vanished between the event and this batch
          // (deleted, or a quota-swallowed write). Nothing to record.
          continue;
        }
        const relPath = this._pathFor(scene);
        const guard = this._checkPathOwnership(id, relPath);
        if (!guard.ok) { problems.push(guard.reason); continue; }
        upserts.push(sceneEntryOf(scene, relPath, this._manifestEntry(id)));
      }

      // ── 2. Retire files left behind by a rename ──
      for (const [id, oldPath] of staleRenames) {
        const stillReferenced = upserts.some(e => e.path === oldPath)
          || sceneDocumentsOf(this._host.getManifest()).some(e => e.id !== id && e.path === oldPath);
        if (stillReferenced) continue;
        await deleteSceneFile(dir, oldPath);
      }

      // ── 3. Explicit deletions (the one named exception to "never delete") ──
      for (const [id, relPath] of deletions) {
        const guard = this._checkPathOwnership(id, relPath, { forDelete: true });
        if (!guard.ok) { problems.push(guard.reason); continue; }
        await deleteSceneFile(dir, relPath);
        removeSceneIds.push(id);
      }

      // ── 4. Settings bundle ──
      if (wantSettings && this._host.collectSettings) {
        const bundle = this._host.collectSettings();
        if (bundle !== null && bundle !== undefined) await writeSettingsFile(dir, bundle);
      }

      // ── 5. Manifest last ──
      const update: ManifestUpdate = {};
      if (upserts.length > 0) update.scenes = upserts;
      if (removeSceneIds.length > 0) update.removeSceneIds = removeSceneIds;
      if (wantActive) update.activeSceneId = readActiveId();
      if (upserts.length > 0 || removeSceneIds.length > 0 || wantActive) {
        const merged = mergeManifest(this._host.getManifest(), update);
        await writeManifest(dir, merged);
        this._host.setManifest(merged);
      }

      this._setStatus({
        pending: this._hasWork(),
        error: problems.length > 0 ? problems.join(' ') : null,
        lastWriteAt: new Date().toISOString(),
      });
    } catch (e: unknown) {
      // Re-queue everything this batch owned: the disk is behind, and the
      // UI must keep saying so until a retry succeeds.
      for (const id of dirtyIds) this._dirtyScenes.add(id);
      for (const [id, p] of deletions) this._deletedScenes.set(id, p);
      for (const [id, p] of staleRenames) this._staleScenePaths.set(id, p);
      this._activeDirty ||= wantActive;
      this._settingsDirty ||= wantSettings;

      const invalid = isHandleInvalid(e);
      this._setStatus({
        pending: true,
        handleInvalid: invalid,
        error: invalid
          ? 'The project folder is no longer writable (renamed, moved, removed, or permission revoked). Re-open it to keep saving.'
          : `Not saved to disk — ${describeError(e)}. Changes are still in browser storage.`,
      });
    }
  }

  // ─── RR1 guard ────────────────────────────────────────────────────────

  /**
   * Refuse to touch a path that does not belong to the manifest entry we
   * believe we are writing.
   *
   * Two conditions, both fatal to the operation and neither to the app:
   *  - the manifest already records a *different* path for this id, and the
   *    old file is not ours to silently abandon on a plain save;
   *  - some *other* manifest entry already claims this exact path.
   */
  private _checkPathOwnership(
    id: string,
    relPath: string,
    opts: { forDelete?: boolean } = {},
  ): { ok: true } | { ok: false; reason: string } {
    const scenes = sceneDocumentsOf(this._host.getManifest());
    const own = scenes.find(e => e.id === id);

    const claimant = scenes.find(e => e.id !== id && e.path === relPath);
    if (claimant) {
      return {
        ok: false,
        reason: `Refused to write "${relPath}" for scene ${id}: the file already belongs to scene ${claimant.id}.`,
      };
    }

    if (opts.forDelete) {
      // Only ever remove a file the manifest attributes to this very id.
      if (!own) {
        return { ok: false, reason: `Refused to delete "${relPath}": scene ${id} is not in the manifest.` };
      }
      if (own.path !== relPath) {
        return {
          ok: false,
          reason: `Refused to delete "${relPath}": the manifest records "${own.path}" for scene ${id}.`,
        };
      }
      return { ok: true };
    }

    // A write to a *new* path for a known id is legitimate (rename); it is
    // handled by the stale-path retirement above, not refused here. What is
    // refused is a filename that does not derive from this id at all — the
    // only way that happens is a caller inventing a filename of its own.
    if (!sceneFileNameOfPath(relPath).includes(idTokenOf(id))) {
      return {
        ok: false,
        reason: `Refused to write "${relPath}" for scene ${id}: filename is not derived from the scene id.`,
      };
    }
    return { ok: true };
  }

  private _manifestEntry(id: string): RvProjectSceneEntry | undefined {
    return sceneDocumentsOf(this._host.getManifest()).find(e => e.id === id);
  }

  /**
   * Where this scene's bytes are — the recorded path, or the derived one.
   *
   * The recorded path comes first because `writeSceneGlbBody()` wrote the body
   * to exactly that path a moment ago (`existing?.path ?? sceneGlbRelPathFor`).
   * Deriving unconditionally would make the manifest name a file nobody wrote,
   * which is precisely how a rename used to end up deleting the body it had
   * just renamed.
   */
  private _pathFor(scene: RvScene): string {
    return this._manifestEntry(scene.id)?.path ?? sceneGlbRelPathFor(scene);
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────

/**
 * Build the manifest entry for a scene, merging over the existing entry so
 * unknown per-entry fields survive (§2 read-modify-write, field level).
 */
/**
 * Build the manifest entry for one scene, field-level read-modify-write on
 * `previous` so an unknown key a newer client wrote survives (§2).
 *
 * Exported because "New Project from current scenes…" (§4.5) writes the same
 * shape from outside the writer, and two definitions of a manifest entry is
 * exactly how a field quietly stops travelling.
 */
export function sceneEntryOf(
  scene: RvScene,
  relPath: string,
  previous?: RvProjectSceneEntry,
): RvProjectSceneEntry {
  const known: RvProjectSceneEntry = {
    id: scene.id,
    name: scene.name,
    path: relPath,
    createdAt: scene.createdAt,
    modifiedAt: scene.modifiedAt,
    baseKind: scene.base.kind,
    baseLabel: scene.base.kind === 'empty' ? '(empty)' : scene.base.label,
  };
  if (scene.parentId !== undefined) known.parentId = scene.parentId;
  return previous ? { ...previous, ...known } : known;
}

function idTokenOf(id: string): string {
  return (id ?? '').replace(/^scn_/, '').replace(/[^A-Za-z0-9_-]/g, '_') || 'unknown';
}

/**
 * A handle that points at a renamed/moved/deleted folder throws only at I/O
 * time — `queryPermission` still reports `granted`. Detect it so the caller
 * can drop to read-only and offer a re-pick instead of looping on failure.
 */
function isHandleInvalid(e: unknown): boolean {
  const name = (e as { name?: string } | null)?.name;
  return name === 'NotFoundError' || name === 'NotAllowedError' || name === 'InvalidStateError';
}

function describeError(e: unknown): string {
  if (e instanceof Error) return e.message || e.name;
  return String(e);
}
