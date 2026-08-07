// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * folder-backend — the File System Access implementation of
 * {@link ProjectBackend}.
 *
 * The read half is the former `FolderReadProvider` from `project-store.ts`,
 * **moved, not copied**. The write half is not new code either: this class
 * owns an `RVProjectFolderWriter` and delegates to it, so the RR1 filename
 * contract (`_checkPathOwnership` before every write and every delete) and
 * the RR3 write seams stay exactly where they were verified. Nothing here
 * writes a scene file directly.
 *
 * ## The writer is created in `activate()`, never in the constructor
 *
 * Workspace discovery constructs one of these per candidate folder. The
 * scene mutation bus is global and unscoped, so a writer per discovered
 * folder would mean every save landing in every folder. Construction is
 * therefore inert: no writer, no bus subscription, and every write method
 * throws. `activate()` is the single moment where that changes, and the
 * store guarantees only one backend is ever in that state.
 */

import {
  getOrCreateSubfolder,
  writeBlobFile,
} from '../../engine/rv-local-filesystem';
import { emitSceneMutation } from '../../hmi/scene/rv-scene-mutations';
import type { RvScene } from '../../hmi/scene/rv-scene-types';
import {
  readManifest,
  readSceneFile,
  readSettingsFile,
  splitRelPath,
} from '../rv-project-storage';
import {
  RVProjectFolderWriter,
  type FolderWriterHost,
  type FolderWriterStatus,
  type FolderWriterStatusListener,
} from '../rv-project-folder-writer';
import type {
  RvProjectAssetEntry,
  RvProjectSceneEntry,
  RvProject,
} from '../rv-project-types';
import {
  assertWritable,
  type ProjectBackend,
  type ResolvedBackendBlob,
} from './project-backend';

export interface FolderBackendOptions {
  /** Did the folder grant readwrite? A refusal degrades to read-only, never to a throw. */
  writable?: boolean;
  /** Stable backend id. Defaults to `folder:<dirname>`. */
  id?: string;
  /**
   * Everything the writer needs from its host. Absent for a discovered
   * (never-opened) backend — such a backend can be activated, but stays
   * non-writing, because there is no manifest to keep in sync.
   */
  writerHost?: FolderWriterHost;
  /** Test seam: shorten the coalescing window. */
  debounceMs?: number;
}

export class FolderBackend implements ProjectBackend {
  readonly kind = 'folder' as const;
  readonly id: string;

  private readonly _dir: FileSystemDirectoryHandle;
  private _writable: boolean;
  private _writerHost: FolderWriterHost | null;
  private readonly _debounceMs: number | undefined;

  private _writer: RVProjectFolderWriter | null = null;
  private _active = false;
  private _statusListeners = new Set<FolderWriterStatusListener>();

  constructor(dir: FileSystemDirectoryHandle, opts: FolderBackendOptions = {}) {
    this._dir = dir;
    this._writable = opts.writable ?? false;
    this._writerHost = opts.writerHost ?? null;
    this._debounceMs = opts.debounceMs;
    this.id = opts.id ?? `folder:${dir.name ?? 'unnamed'}`;
  }

  get writable(): boolean { return this._writable; }
  get isActive(): boolean { return this._active; }
  /** The open folder handle — the store still needs it for the manifest write. */
  get directory(): FileSystemDirectoryHandle { return this._dir; }
  /** Diagnostics and tests: is a writer in service? */
  get hasWriter(): boolean { return this._writer !== null; }

  /**
   * Install the writer host after construction.
   *
   * Discovery has no host to give; the store does. Setting it while active
   * is refused rather than silently ignored — swapping the manifest source
   * under a running writer is how a write ends up in the wrong project.
   */
  setWriterHost(host: FolderWriterHost | null): void {
    if (this._active) throw new Error('Cannot change the writer host of an active backend.');
    this._writerHost = host;
  }

  /** Reflect a late readwrite grant/refusal. Refused while active, same reason. */
  setWritable(writable: boolean): void {
    if (this._active) throw new Error('Cannot change writability of an active backend.');
    this._writable = writable;
  }

  // ─── Read ─────────────────────────────────────────────────────────────

  async readManifest(): Promise<RvProject | null> {
    const result = await readManifest(this._dir);
    return result?.project ?? null;
  }

  readScene(relPath: string): Promise<RvScene | null> {
    return readSceneFile(this._dir, relPath);
  }

  readSettings(relPath?: string): Promise<unknown | null> {
    return readSettingsFile(this._dir, relPath);
  }

  // ─── Listing ──────────────────────────────────────────────────────────

  /**
   * Scene listing is manifest-driven, on purpose.
   *
   * A scene is more than a file: it has an id that other artefacts reference,
   * a display name, a base and a `modifiedAt` that conflict resolution keys
   * off. None of that can be recovered from a filename, so `project.json`
   * stays the source of truth here.
   */
  async listScenes(): Promise<RvProjectSceneEntry[]> {
    return (await this.readManifest())?.scenes ?? [];
  }

  /**
   * Models are **folder-driven**: every GLB in `models/` belongs to the project.
   *
   * This is the opposite of {@link listScenes}, and deliberately so. A model has
   * no identity beyond its file — dropping `Machine.glb` into a project's
   * `models/` folder *is* the act of adding it, and requiring a second edit to
   * `project.json` before it appears only produced projects that silently
   * showed nothing. The manifest is kept as an optional **metadata overlay**:
   * an entry matching a file on disk contributes its `label`, `thumbnail` and
   * anything else it carries, while an entry naming a file that is gone is
   * dropped rather than listed as a phantom.
   */
  async listModels(): Promise<RvProjectAssetEntry[]> {
    const declared = new Map(
      ((await this.readManifest())?.models ?? []).map(e => [e.path, e] as const),
    );
    const files = await this._listFolderGlbs('models');
    if (files.length === 0) return [];
    return files.map(path => declared.get(path) ?? { path });
  }

  /**
   * Top-level `.glb` filenames of one project subfolder, as manifest paths.
   *
   * Sorted for a stable list order, and non-recursive: a base model is a file
   * in `models/`, not a tree. A missing folder is the normal case for a project
   * that has none
   * (§1.1 R1) and yields an empty list, never a throw.
   */
  private async _listFolderGlbs(folder: string): Promise<string[]> {
    const dir = await this._resolveDir(folder);
    if (!dir) return [];
    const out: string[] = [];
    try {
      // `entries()` rather than `values()`: both are standard, but the name is
      // what this needs and it is the one every handle shim here implements.
      for await (const [name, handle] of dir.entries()) {
        if (handle.kind !== 'file') continue;
        if (!name.toLowerCase().endsWith('.glb')) continue;
        out.push(`${folder}/${name}`);
      }
    } catch {
      // A revoked grant mid-iteration must not take the whole open down.
      return out.sort();
    }
    return out.sort();
  }

  /** File extensions the library layer understands. */
  private static readonly ASSET_EXTENSIONS = ['.glb', '.gltf', '.splat', '.ksplat', '.ply'];

  /**
   * Every asset file under `root`, recursively, as manifest paths.
   *
   * Depth-first and sorted, so a library's folder structure survives as the
   * collection chips the provider derives from it. A missing root is normal.
   */
  private async _walkAssets(root: string): Promise<string[]> {
    const dir = await this._resolveDir(root);
    if (!dir) return [];
    const out: string[] = [];
    const subdirs: string[] = [];
    try {
      for await (const [name, handle] of dir.entries()) {
        if (handle.kind === 'directory') {
          // `.thumbnails` and friends are sidecars, not assets.
          if (!name.startsWith('.')) subdirs.push(`${root}/${name}`);
          continue;
        }
        const lower = name.toLowerCase();
        if (FolderBackend.ASSET_EXTENSIONS.some(ext => lower.endsWith(ext))) {
          out.push(`${root}/${name}`);
        }
      }
    } catch {
      return out.sort();
    }
    out.sort();
    for (const sub of subdirs.sort()) out.push(...await this._walkAssets(sub));
    return out;
  }

  /** Walk a slash-separated folder path down from the project root. */
  private async _resolveDir(folder: string): Promise<FileSystemDirectoryHandle | null> {
    let dir: FileSystemDirectoryHandle = this._dir;
    for (const segment of folder.split('/').filter(Boolean)) {
      try {
        dir = await dir.getDirectoryHandle(segment);
      } catch {
        return null;
      }
    }
    return dir;
  }

  /**
   * Library assets are **folder-driven** too, for the same reason models are:
   * what is in the project belongs to the project.
   *
   * `library/` is a sibling of `models/`, not a folder inside it: a component
   * catalog and a set of base models are different kinds of thing. Scanning is
   * recursive because a library is a tree — its folders become the collection
   * chips the provider derives.
   *
   * The manifest `library[]` is the same optional metadata overlay it is for
   * models — labels and thumbnails for files that exist, nothing for files that
   * do not.
   */
  async listLibrary(): Promise<RvProjectAssetEntry[]> {
    const declared = new Map(
      ((await this.readManifest())?.library ?? []).map(e => [e.path, e] as const),
    );
    const found = await this._walkAssets('library');
    if (found.length === 0) return [];
    return found.map(path => declared.get(path) ?? { path });
  }

  // ─── Lifecycle (§2.2.1b) ──────────────────────────────────────────────

  async activate(): Promise<void> {
    if (this._active) return;
    this._active = true;
    if (!this._writable || !this._writerHost) return;   // active but non-writing
    const writer = new RVProjectFolderWriter(this._writerHost, this._debounceMs);
    for (const l of this._statusListeners) writer.onStatus(l);
    writer.start();
    this._writer = writer;
  }

  async deactivate(): Promise<void> {
    if (!this._active) return;
    this._active = false;
    const writer = this._writer;
    this._writer = null;
    if (!writer) return;
    try {
      await writer.flush();
    } catch { /* the status already carries the failure */ }
    writer.dispose();
  }

  // ─── Write (delegated — see the file header) ──────────────────────────

  /**
   * Queue a scene body write.
   *
   * `relPath` is validated against the writer's own view of the manifest
   * rather than used as a path: RR1 says the on-disk name is derived from
   * the scene **id**, and the writer re-checks ownership before touching
   * anything. A caller passing a stale or foreign path must be refused, not
   * obeyed.
   */
  async writeScene(relPath: string, scene: RvScene): Promise<void> {
    assertWritable(this);
    this._assertPathMatchesEntry(relPath, scene.id);
    this._requireWriter().handleMutation({ type: 'upsert', id: scene.id, scene });
  }

  async deleteScene(relPath: string): Promise<void> {
    assertWritable(this);
    const id = this._entryIdForPath(relPath);
    if (!id) throw new Error(`No manifest entry owns "${relPath}" — refusing to delete.`);
    // The bus is what `SceneStore.delete()` uses; going through it keeps one
    // deletion path instead of two that can drift.
    this._requireWriter().handleMutation({ type: 'delete', id });
  }

  async writeBlob(relPath: string, blob: Blob): Promise<void> {
    assertWritable(this);
    const { folder, filename } = splitRelPath(relPath);
    const dir = folder ? await getOrCreateSubfolder(this._dir, folder) : this._dir;
    await writeBlobFile(dir, filename, blob);
  }

  async deleteBlob(relPath: string): Promise<void> {
    assertWritable(this);
    const { folder, filename } = splitRelPath(relPath);
    try {
      const dir = folder ? await this._dir.getDirectoryHandle(folder) : this._dir;
      await dir.removeEntry(filename);
    } catch {
      // Already gone (or the folder never existed) — the desired end state.
    }
  }

  async readBlobUrl(relPath: string): Promise<ResolvedBackendBlob | null> {
    const { folder, filename } = splitRelPath(relPath);
    // `folder` can be several segments deep (`models/library/PalletHandling`),
    // and `getDirectoryHandle` takes ONE name — a slashed string is not a
    // directory called "a/b", it is a lookup that always fails.
    const dir = folder ? await this._resolveDir(folder) : this._dir;
    if (!dir) return null;
    let file: File;
    try {
      file = await (await dir.getFileHandle(filename)).getFile();
    } catch {
      return null;
    }
    const url = URL.createObjectURL(file);
    return { url, release: () => URL.revokeObjectURL(url) };
  }

  async flush(): Promise<void> {
    await this._writer?.flush();
  }

  // ─── Writer status pass-through ───────────────────────────────────────

  getStatus(): FolderWriterStatus | undefined {
    return this._writer?.getStatus();
  }

  /** Subscribe to writer status. Survives activate/deactivate cycles. */
  onStatus(listener: FolderWriterStatusListener): () => void {
    this._statusListeners.add(listener);
    const off = this._writer?.onStatus(listener);
    return () => {
      this._statusListeners.delete(listener);
      off?.();
    };
  }

  /** Emit a mutation the writer will pick up. Used by the store's own seams. */
  notifyMutation(...args: Parameters<typeof emitSceneMutation>): void {
    emitSceneMutation(...args);
  }

  // ─── Internals ────────────────────────────────────────────────────────

  private _requireWriter(): RVProjectFolderWriter {
    if (!this._writer) {
      throw new Error(`Backend "${this.id}" has no writer — activate it with a writer host first.`);
    }
    return this._writer;
  }

  private _manifest(): RvProject | null {
    try {
      return this._writerHost?.getManifest() ?? null;
    } catch {
      return null;
    }
  }

  private _entryIdForPath(relPath: string): string | null {
    const entries = this._manifest()?.scenes ?? [];
    return entries.find(e => e.path === relPath)?.id ?? null;
  }

  private _assertPathMatchesEntry(relPath: string, id: string): void {
    const entries = this._manifest()?.scenes ?? [];
    const owner = entries.find(e => e.path === relPath);
    // An unknown path is a *new* scene — legitimate. A path owned by someone
    // else is the RR1 collision, and refusing it here is cheaper than
    // discovering it after the file is gone.
    if (owner && owner.id !== id) {
      throw new Error(`"${relPath}" belongs to scene ${owner.id}, not ${id}.`);
    }
  }
}
