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
} from '../../engine/rv-local-filesystem';
import { emitSceneMutation } from '../../hmi/scene/rv-scene-mutations';
import {
  atomicReplaceFile,
  readManifest,
  readSettingsFile,
  splitRelPath,
} from '../rv-project-storage';
import { assertReadableScenePath } from '../rv-legacy-format';
import { CONNECT_CONFIG_SUFFIX, KNOWLEDGE_FILE_SUFFIX } from '../rv-project-refs';
import {
  assertRevisionPrecondition,
  revisionOfBytes,
  type SceneRevision,
} from '../rv-scene-record';
import {
  RVProjectFolderWriter,
  type FolderWriterHost,
  type FolderWriterStatus,
  type FolderWriterStatusListener,
} from '../rv-project-folder-writer';
import {
  assetDocumentsOf,
  documentsFromLists,
  readDocuments,
  sectionOfDocument,
  type DocumentStat,
} from '../rv-project-documents';
import {
  type RvDocumentEntry,
  type RvProjectAssetEntry,
  type RvProjectSceneEntry,
  type RvProject,
} from '../rv-project-types';
import {
  assertWritable,
  docPathOf,
  docRefOf,
  documentRecord,
  isInternalProjectPath,
  preconditionOf,
  WriteQueue,
  type DocRef,
  type DocumentRecord,
  type ProjectBackend,
  type ResolvedBackendBlob,
  type WriteDocumentOptions,
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
  /**
   * Serialises every write of THIS backend (plan-709 §2.2.1-3).
   *
   * The precondition below is a read-then-write, so it has a TOCTOU window by
   * construction. The queue closes that window for everything inside this tab;
   * a SECOND tab holding the same folder handle remains racy exactly as it is
   * today, and is documented as an accepted residual rather than claimed fixed.
   */
  private readonly _writes = new WriteQueue();

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

  /**
   * Read one document body — bytes, manifest metadata, revision.
   *
   * The former `readScene` plus `readBlobBytes`, which on a folder backend were
   * always the same file read: one attached the manifest row and hashed the
   * bytes, the other threw both away. Reading a model now costs exactly what
   * reading a scene did and answers the same three questions, which is what
   * lets every caller hand the revision straight back to
   * {@link writeDocument}.
   *
   * A `.scene.json` path is refused before any I/O rather than parsed and
   * found wanting: the bytes of a JSON body are perfectly readable, so a
   * tolerant reader would hand back a "GLB" that only fails four layers later,
   * as a broken render instead of a sentence the user can act on.
   */
  async readDocument(ref: DocRef): Promise<DocumentRecord | null> {
    const relPath = docPathOf(ref);
    assertReadableScenePath(relPath);
    const meta = await this._entryForPath(relPath);
    const bytes = await this._bytesAt(relPath);
    return bytes ? documentRecord(bytes, { ...meta, path: relPath }) : null;
  }

  /**
   * Raw bytes at a project-relative path, or null.
   *
   * Resolves the folder half segment by segment — see the note in
   * {@link writeDocument}. `readSceneGlbFile` does it in one `getDirectoryHandle`
   * call, which works for `scenes/` and for nothing deeper, and a document can
   * live anywhere in the tree since plan-716.
   */
  private async _bytesAt(relPath: string): Promise<Uint8Array | null> {
    const { folder, filename } = splitRelPath(relPath);
    const dir = folder ? await this._resolveDir(folder) : this._dir;
    if (!dir) return null;
    try {
      const file = await (await dir.getFileHandle(filename)).getFile();
      return new Uint8Array(await file.arrayBuffer());
    } catch {
      return null;
    }
  }

  readSettings(relPath?: string): Promise<unknown | null> {
    return readSettingsFile(this._dir, relPath);
  }

  // ─── Listing ──────────────────────────────────────────────────────────

  /**
   * Models are **folder-driven**: every GLB in `models/` belongs to the project.
   *
   * This is the opposite of the manifest-driven scene half, and deliberately
   * so — a scene has an id, a display name and a `modifiedAt` that conflict
   * resolution keys off, none of which can be recovered from a filename. A model has
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
      assetDocumentsOf(await this.readManifest(), 'models').map(e => [e.path, e] as const),
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
    return this._walkMatching(root, lower =>
      FolderBackend.ASSET_EXTENSIONS.some(ext => lower.endsWith(ext)));
  }

  /** The one recursive walk — `matches` gets the LOWERCASED file name. */
  private async _walkMatching(
    root: string,
    matches: (lowerName: string) => boolean,
  ): Promise<string[]> {
    const dir = await this._resolveDir(root);
    if (!dir) return [];
    // The empty root is the project itself — its files are paths with no
    // folder half, not paths starting with a slash.
    const prefix = root === '' ? '' : `${root}/`;
    const out: string[] = [];
    const subdirs: string[] = [];
    try {
      for await (const [name, handle] of dir.entries()) {
        if (handle.kind === 'directory') {
          // `.thumbnails` and friends are sidecars, not assets.
          if (!name.startsWith('.')) subdirs.push(`${prefix}${name}`);
          continue;
        }
        if (matches(name.toLowerCase())) {
          out.push(`${prefix}${name}`);
        }
      }
    } catch {
      return out.sort();
    }
    out.sort();
    for (const sub of subdirs.sort()) out.push(...await this._walkMatching(sub, matches));
    return out;
  }

  /** Walk a slash-separated folder path down from the project root. */
  /** {@link _resolveDir}, creating each missing segment as it goes. */
  private async _createDir(folder: string): Promise<FileSystemDirectoryHandle> {
    let dir: FileSystemDirectoryHandle = this._dir;
    for (const segment of folder.split('/').filter(Boolean)) {
      dir = await getOrCreateSubfolder(dir, segment);
    }
    return dir;
  }

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
      assetDocumentsOf(await this.readManifest(), 'library').map(e => [e.path, e] as const),
    );
    const found = await this._walkAssets('library');
    if (found.length === 0) return [];
    return found.map(path => declared.get(path) ?? { path });
  }

  /**
   * The one list (plan-413 §2.4) — ONE walk of the whole project tree.
   *
   * This used to be composed from the three section listings above, which made
   * the folder layout a type system through the back door: scenes were
   * manifest-driven, `models/` and `library/` were each walked separately, and
   * a GLB anywhere else — the project root included — existed on disk and in
   * the manifest yet fell out of the list on every rescan. Since plan-716/717 a
   * section is a *place*, so the scan is now placeless: every asset file
   * anywhere under the project root (dot-folders excepted) is a document, and
   * its section is derived from its path exactly as `sectionOfDocument` would
   * derive it anywhere else.
   *
   * The manifest's `documents[]` stays the metadata overlay — it is where the
   * classification cache lives — but it never adds an entry the folder does
   * not have, because a document with no bytes is a phantom. That phantom rule
   * now covers scenes too: a scene row whose body is gone is a card that opens
   * to nothing, and listing it was the old split's bug, not its feature.
   */
  async listDocuments(): Promise<RvDocumentEntry[]> {
    const manifest = await this.readManifest();
    const declared = readDocuments(manifest) ?? [];
    const declaredByPath = new Map(declared.map(d => [d.path, d] as const));
    const scenes: RvProjectSceneEntry[] = [];
    const models: RvProjectAssetEntry[] = [];
    const library: RvProjectAssetEntry[] = [];
    for (const path of await this._walkAssets('')) {
      const row = declaredByPath.get(path);
      const section = sectionOfDocument(row ?? ({ path } as RvDocumentEntry));
      // The empty id/name are the "mint one for me" markers `documentOfSceneEntry`
      // has always honoured — a bare file off the scan has no row to speak with.
      if (section === 'scenes') scenes.push(row ?? { path, id: '', name: '' });
      else if (section === 'models') models.push(row ?? { path });
      else library.push(row ?? { path });
    }
    return documentsFromLists({ scenes, models, library }, declared);
  }

  /**
   * Every `*.connect.json` under the project root — by ENDING, not by folder
   * (see the interface). The walk includes `connect/`, which the asset walk
   * also enters but never matches anything in.
   */
  async listConnectConfigs(): Promise<string[]> {
    return this._walkMatching('', lower => lower.endsWith(CONNECT_CONFIG_SUFFIX));
  }

  /** Every `*.knowledge.md` under the project root — see the interface. */
  async listKnowledgeFiles(): Promise<string[]> {
    return this._walkMatching('', lower => lower.endsWith(KNOWLEDGE_FILE_SUFFIX));
  }

  /**
   * EVERY file under the project root, internals excluded (plan-445 F1).
   *
   * The same `_walkMatching` the two listings above run, with the predicate
   * opened up: a catch-all instead of an ending. That is the whole difference,
   * and it is what lets the dashboard replace two walks with one — the by-ending
   * split happens afterwards, on the paths, in `classifyProjectFiles`.
   *
   * The filter runs on the PATH, not on the file name the walk matches with:
   * `thumbnails/x.png` is internal because of its folder, and the predicate
   * never sees a folder. (Dot-directories are skipped by the walk itself, so
   * that clause of the rule is enforced twice — cheaply, and in the direction
   * that fails safe.)
   */
  async listAllFiles(): Promise<string[]> {
    const all = await this._walkMatching('', () => true);
    return all.filter(path => !isInternalProjectPath(path));
  }

  /** Real `(size, mtime)` for every stored document. See the interface. */
  async statDocuments(): Promise<DocumentStat[]> {
    // The same one walk the listing uses: a stat for every file that exists,
    // which is the only kind of stat there is.
    const paths = await this._walkAssets('');

    const out: DocumentStat[] = [];
    for (const path of paths) {
      const { folder, filename } = splitRelPath(path);
      const dir = folder ? await this._resolveDir(folder) : this._dir;
      if (!dir) continue;
      try {
        const file = await (await dir.getFileHandle(filename)).getFile();
        out.push({ path, size: file.size, mtime: file.lastModified });
      } catch {
        // Gone, or unreadable. No stat means "not scannable", which leaves the
        // manifest entry alone — the honest answer for a file we cannot see.
      }
    }
    return out;
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
   * Write one document body into the project folder, under a precondition.
   *
   * ## Why this does *not* go through `RVProjectFolderWriter`
   *
   * The file header says scene writes are delegated to the writer, and for
   * the manifest they still are — the writer is what carries the RR1
   * ownership check and the debounce that keeps a save from writing the file
   * five times a second. But the writer is driven by the scene **mutation
   * bus**, whose events carry an `RvScene`, and its whole reason for existing
   * is to serialise that object. A byte body is not derivable from it.
   *
   * Rather than push bytes through a bus that speaks op-logs, the body path is
   * direct and keeps the two guarantees the writer would have provided:
   * `_assertPathMatchesEntry` is the RR1 check, unchanged, and
   * `writeSceneGlbFile` is atomic. What it does not keep is the debounce —
   * that belongs on the *caller* side, because a compare-and-swap write cannot
   * be coalesced by something that does not know which revision each queued
   * version was based on.
   *
   * ## What plan-736 changed here
   *
   * `writeBlob` used to sit beside this with a *conditional* precondition and a
   * non-atomic `writeBlobFile`. Both differences are gone: every document is
   * written through the atomic replace, and every write states its expectation.
   * The read that the precondition costs is the price scenes have always paid;
   * `'any'` is still available for a caller that genuinely has nothing to
   * compare against, and it skips the read exactly as before.
   *
   * `relPath` is validated rather than obeyed: a path owned by another
   * document is refused here, which is cheaper than discovering it after the
   * file is gone.
   */
  async writeDocument(
    ref: DocRef,
    bytes: Uint8Array,
    opts: WriteDocumentOptions,
  ): Promise<{ revision: SceneRevision }> {
    assertWritable(this);
    const { path: relPath, id, meta } = docRefOf(ref);
    // A caller that hands over a row hands over its id with it — see the same
    // guard, with the same words and the same reasoning, in `BrowserBackend`.
    if (meta && !meta.id) throw new Error('writeScene needs meta.id.');
    // The RR1 collision guard, now for every document rather than for scenes
    // only. A caller that does not know its id cannot be checked — which is the
    // same position `writeBlob` left every asset write in, so this is strictly
    // more protection than before, never less.
    const ownId = meta?.id ?? id;
    if (ownId) this._assertPathMatchesEntry(relPath, ownId);
    const { folder, filename } = splitRelPath(relPath);
    const expected = preconditionOf(opts.expectedRevision);

    return this._writes.run(async () => {
      // Read-before-write: the stored revision is the only thing that can tell
      // us somebody edited this file in the folder since we last looked. On the
      // queue, so a write already accepted cannot land between this read and
      // the write below. Skipped entirely for `'any'`, which is what makes an
      // unconditional overwrite cost exactly one file access.
      if (expected !== undefined) {
        assertRevisionPrecondition(
          relPath, expected, await this._blobRevision(folder, filename));
      }
      // AFTER the precondition, deliberately: `_createDir` creates, and a
      // refused write must not leave an empty directory behind as its trace.
      //
      // Segment by segment, for the same reason `readDocumentUrl` resolves that
      // way: `getDirectoryHandle` takes ONE name, and `library/Custom` is not a
      // directory called "library/Custom" — it is two lookups. Handing the whole
      // string to the real API throws; handing it to a Map-shaped test double
      // quietly "works", which is how a nested path can look tested and still be
      // unreachable on disk. (`writeSceneGlbFile` resolves the one-shot way and
      // was only ever given the single-segment `scenes/`, which is why the bug
      // it carries has never fired.)
      const dir = folder ? await this._createDir(folder) : this._dir;
      await atomicReplaceFile(
        dir,
        filename,
        new Blob([bytes as unknown as BlobPart], { type: 'model/gltf-binary' }),
      );
      return { revision: await revisionOfBytes(bytes) };
    });
  }

  /**
   * Delete one document body.
   *
   * Direct rather than through the mutation bus: the writer would have to
   * derive the filename from the document id, and the manifest path is the
   * only thing that actually knows it. The bus still hears about it when a row
   * owns the path, so the writer retires that row.
   *
   * ## Why the "no manifest entry owns this" refusal is gone
   *
   * `deleteScene` used to throw for an unowned path while `deleteBlob`, one
   * screen down, deleted it without a word. That was not two policies; it was
   * the `section` split showing through on the delete path. Tolerance wins
   * because it is the one of the two that is idempotent: the caller's intent
   * ("this must not be there") is already satisfied by a file that is not
   * there, and R2 — never tidy away what nobody asked about — is a rule about
   * the *writer's* own sweeps, not about an explicit delete.
   */
  async deleteDocument(ref: DocRef): Promise<void> {
    assertWritable(this);
    const relPath = docPathOf(ref);
    const id = docRefOf(ref).id ?? this._entryIdForPath(relPath);
    const { folder, filename } = splitRelPath(relPath);
    await this._writes.run(async () => {
      try {
        // Segment by segment, like every other path resolution here.
        const dir = folder ? await this._resolveDir(folder) : this._dir;
        if (!dir) return;            // the folder never existed — already gone
        await dir.removeEntry(filename);
      } catch {
        // Already gone — the desired end state.
      }
    });
    if (id) emitSceneMutation({ type: 'delete', id });
  }

  /** SHA-256 of what is stored at `folder/filename`, or null when nothing is. */
  private async _blobRevision(
    folder: string | null,
    filename: string,
  ): Promise<SceneRevision | null> {
    try {
      const dir = folder ? await this._resolveDir(folder) : this._dir;
      if (!dir) return null;
      const file = await (await dir.getFileHandle(filename)).getFile();
      return await revisionOfBytes(await file.arrayBuffer());
    } catch {
      return null;                     // no such file — "this is new" holds
    }
  }

  async readDocumentUrl(ref: DocRef): Promise<ResolvedBackendBlob | null> {
    const { folder, filename } = splitRelPath(docPathOf(ref));
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
    await this._writes.drain();
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

  // The three helpers below read the ONE document list, not the scenes
  // projection. They used to consult `sceneDocumentsOf`, which made the RR1
  // collision guard, the delete-ownership check and the meta lookup silently
  // blind for any document outside `scenes/` — a hole that only opened up once
  // documents could legitimately live anywhere in the project tree.

  private _entryIdForPath(relPath: string): string | null {
    return (readDocuments(this._manifest()) ?? []).find(e => e.path === relPath)?.id ?? null;
  }

  /**
   * Manifest metadata for a scene path, for {@link SceneRecord.meta}.
   *
   * Prefers the writer host's in-memory manifest (no I/O, and the version the
   * rest of the store is already working against) and only reads `project.json`
   * when there is none — which is the discovered/read-only case, where a
   * body read is rare enough that one small JSON read does not matter.
   *
   * A path the manifest does not know is **not** an error: an id is never
   * invented from a filename here, because a wrong id is worse than a missing
   * one — it would make the record claim to be a scene it is not.
   */
  private async _entryForPath(relPath: string): Promise<Partial<RvProjectSceneEntry>> {
    const fromHost = (readDocuments(this._manifest()) ?? []).find(e => e.path === relPath);
    if (fromHost) return fromHost;
    let onDisk: RvDocumentEntry | undefined;
    try {
      onDisk = (readDocuments(await this.readManifest()) ?? []).find(e => e.path === relPath);
    } catch {
      onDisk = undefined;
    }
    return onDisk ?? {};
  }

  private _assertPathMatchesEntry(relPath: string, id: string): void {
    const owner = (readDocuments(this._manifest()) ?? []).find(e => e.path === relPath);
    // An unknown path is a *new* scene — legitimate. A path owned by someone
    // else is the RR1 collision, and refusing it here is cheaper than
    // discovering it after the file is gone.
    if (owner && owner.id !== id) {
      throw new Error(`"${relPath}" belongs to scene ${owner.id}, not ${id}.`);
    }
  }
}
