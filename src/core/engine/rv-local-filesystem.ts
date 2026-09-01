// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-local-filesystem.ts — Local Working Folder for realvirtual WEB.
 *
 * A single "working folder" is configured once in settings. All features
 * (models, planner library, splats) read from defined subfolders:
 *
 *   <working-folder>/
 *   ├── models/          → .glb files for main viewer model selector
 *   ├── library/         → .glb files for layout planner library
 *   │   ├── conveyor/    → category subfolder (optional)
 *   │   ├── robot/
 *   │   └── ...
 *   ├── splats/          → .splat, .ksplat, .ply, .pcd files
 *   └── settings.json    → optional local overrides (future)
 *
 * The directory handle is persisted in IndexedDB so it survives page reloads.
 * On reload, the browser may prompt the user to re-grant read permission.
 *
 * Chrome/Edge 86+ only. Use `isSupported()` to feature-detect.
 */

// ─── Constants ──────────────────────────────────────────────────────────

const DB_NAME = 'rv-filesystem';
const DB_VERSION = 1;
const STORE_HANDLES = 'handles';
const LS_KEY = 'rv-local-folders';

/**
 * Default handle slot — the legacy single-slot key. Every handle function
 * defaults to it, so all pre-existing callers keep their exact behaviour.
 *
 * Since plan-370 the store is **multi-key**: a project folder is persisted
 * under `projectfolder:<id>`, a workspace under `workspace`, and (reserved
 * for a follow-up plan) a shared root under `sharedroot:<name>`. Without
 * this, the first project pick would silently overwrite the working-folder
 * handle and the planner would lose its library.
 */
/**
 * @deprecated The working folder is retired in favour of the project (plan-372
 * Phase 11). This slot is kept **read-only**, so an existing installation can
 * still be migrated — a user who set a working folder in an earlier version
 * would otherwise silently lose access to their own library. Nothing should
 * write to it any more.
 */
export const HANDLE_KEY_WORKFOLDER = 'workfolder';

/** Handle slot for the (optional) workspace root that contains project folders. */
export const HANDLE_KEY_WORKSPACE = 'workspace';

/** Handle slot for a single project folder picked outside a workspace. */
export function projectHandleKey(projectId: string): string {
  return `projectfolder:${projectId}`;
}

/** Well-known subfolder names inside the working folder. */
export const SUBFOLDER = {
  models: 'models',
  library: 'library',
  splats: 'splats',
} as const;

export type SubfolderName = keyof typeof SUBFOLDER;

// ─── Types ──────────────────────────────────────────────────────────────

export interface LocalFileEntry {
  name: string;
  path: string;           // relative path from subfolder root (e.g. "conveyor/belt.glb")
  handle: FileSystemFileHandle;
}

export interface WorkFolderMeta {
  displayName: string;
  lastAccessed: string;   // ISO date
}

/**
 * The outcome of a directory pick — four states, not two.
 *
 * `selectFolderForKey` used to answer `handle | null`, and that single `null`
 * meant three different things: the user cancelled, the browser has no
 * `showDirectoryPicker` at all, or the picker refused to open. Callers can only
 * treat that as "cancelled", so a Firefox user clicking "Open workspace…" got
 * no dialog, no message and no clue — the click looked broken. Naming the
 * reasons is what lets the UI say which one happened.
 */
export type FolderPick =
  /** The user chose a folder; the handle is persisted under the caller's key. */
  | { kind: 'picked'; dir: FileSystemDirectoryHandle }
  /** The user dismissed the dialog. The one outcome that is not a problem. */
  | { kind: 'cancelled' }
  /** No File System Access API in this browser (Firefox, Safari, old WebViews). */
  | { kind: 'unsupported' }
  /** The API exists but declined to open — enterprise policy, or a picker
   *  that is already active because an earlier one never settled. */
  | { kind: 'blocked'; reason: string };

// ─── Feature detection ──────────────────────────────────────────────────

export function isSupported(): boolean {
  return typeof window !== 'undefined' && 'showDirectoryPicker' in window;
}

// ─── IndexedDB helpers ──────────────────────────────────────────────────

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_HANDLES)) {
        db.createObjectStore(STORE_HANDLES);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Persist a directory handle under `key`. Defaults to the legacy
 * `'workfolder'` slot so existing callers are unchanged.
 */
export async function putHandle(
  handle: FileSystemDirectoryHandle,
  key: string = HANDLE_KEY_WORKFOLDER,
): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_HANDLES, 'readwrite');
    tx.objectStore(STORE_HANDLES).put(handle, key);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

/** Read a persisted directory handle. Returns null when the slot is empty. */
export async function getHandle(
  key: string = HANDLE_KEY_WORKFOLDER,
): Promise<FileSystemDirectoryHandle | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_HANDLES, 'readonly');
    const req = tx.objectStore(STORE_HANDLES).get(key);
    req.onsuccess = () => { db.close(); resolve(req.result ?? null); };
    req.onerror = () => { db.close(); reject(req.error); };
  });
}

/** Drop a persisted directory handle. */
export async function deleteStoredHandle(
  key: string = HANDLE_KEY_WORKFOLDER,
): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_HANDLES, 'readwrite');
    tx.objectStore(STORE_HANDLES).delete(key);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

/** Enumerate the keys currently holding a handle. Used by "recent projects". */
export async function listHandleKeys(): Promise<string[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_HANDLES, 'readonly');
    const req = tx.objectStore(STORE_HANDLES).getAllKeys();
    req.onsuccess = () => {
      db.close();
      resolve((req.result ?? []).map(k => String(k)));
    };
    req.onerror = () => { db.close(); reject(req.error); };
  });
}

// ─── localStorage metadata ──────────────────────────────────────────────

function getMeta(): WorkFolderMeta | null {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function setMeta(meta: WorkFolderMeta): void {
  localStorage.setItem(LS_KEY, JSON.stringify(meta));
}

function clearMeta(): void {
  localStorage.removeItem(LS_KEY);
}

// ─── Public API ─────────────────────────────────────────────────────────

/**
 * Show the native directory picker dialog and set it as the working folder.
 * Returns the directory handle on success, null if user cancels.
 */
export async function selectWorkFolder(): Promise<FileSystemDirectoryHandle | null> {
  if (!isSupported()) return null;
  try {
    const handle = await window.showDirectoryPicker!({ id: 'rv-workfolder', mode: 'read' });
    await putHandle(handle);
    setMeta({ displayName: handle.name, lastAccessed: new Date().toISOString() });
    return handle;
  } catch (e: unknown) {
    if (e instanceof DOMException && e.name === 'AbortError') return null;
    throw e;
  }
}

/**
 * Retrieve the previously configured working folder and verify permission.
 * Returns null if no folder stored or permission denied.
 * @param prompt If true (default), will ask user to re-grant if needed.
 */
export async function getWorkFolder(prompt = true): Promise<FileSystemDirectoryHandle | null> {
  const handle = await getHandle();
  if (!handle) return null;

  const perm = await handle.queryPermission({ mode: 'read' });
  if (perm === 'granted') {
    setMeta({ displayName: handle.name, lastAccessed: new Date().toISOString() });
    return handle;
  }
  if (prompt) {
    const result = await handle.requestPermission({ mode: 'read' });
    if (result === 'granted') {
      setMeta({ displayName: handle.name, lastAccessed: new Date().toISOString() });
      return handle;
    }
  }
  return null;
}

/**
 * Remove the stored working folder.
 */
export async function removeWorkFolder(): Promise<void> {
  await deleteStoredHandle();
  clearMeta();
}

// ─── Project / workspace folders (readwrite) ────────────────────────────

/**
 * Show the native directory picker in **readwrite** mode and persist the
 * handle under `key`. Returns null if the user cancels.
 *
 * The working-folder picker above deliberately stays on `mode:'read'`; a
 * project folder is authored into, so it asks for write up front and the
 * grant survives the reload via {@link getFolderHandle}.
 */
export async function pickFolderForKey(
  key: string,
  pickerId = 'rv-projectfolder',
): Promise<FolderPick> {
  if (!isSupported()) return { kind: 'unsupported' };
  try {
    const handle = await window.showDirectoryPicker!({ id: pickerId, mode: 'readwrite' });
    await putHandle(handle, key);
    return { kind: 'picked', dir: handle };
  } catch (e: unknown) {
    if (e instanceof DOMException && e.name === 'AbortError') {
      // Chrome overloads AbortError: a dismissed dialog and a picker that is
      // still open from an earlier call ("File picker already active") arrive
      // with the same name. Only the message separates them, and only the
      // second one is worth telling the user about — it survives until reload.
      return /already active/i.test(e.message)
        ? { kind: 'blocked', reason: 'A file dialog is already open. Reload the page and try again.' }
        : { kind: 'cancelled' };
    }
    // NotAllowedError (enterprise policy, no user gesture) and SecurityError
    // (cross-origin frame) are real refusals — reported, never swallowed.
    if (e instanceof DOMException) return { kind: 'blocked', reason: e.message || e.name };
    throw e;
  }
}

/**
 * Lenient wrapper over {@link pickFolderForKey}: the handle, or null for every
 * outcome that produced none.
 *
 * Kept for callers that genuinely have nothing to say about the reason. Any
 * caller attached to a button should use `pickFolderForKey` instead — a button
 * that does nothing at all is the bug this pair exists to make impossible.
 */
export async function selectFolderForKey(
  key: string,
  pickerId = 'rv-projectfolder',
): Promise<FileSystemDirectoryHandle | null> {
  const pick = await pickFolderForKey(key, pickerId);
  return pick.kind === 'picked' ? pick.dir : null;
}

/**
 * Verify (and if needed re-request) permission on an existing handle.
 *
 * Split out of {@link getFolderHandle} deliberately: the IndexedDB lookup
 * can only ever round-trip a *real* handle (structured clone rejects an
 * object carrying methods), so a test can never drive the permission logic
 * through the store. Kept separate, this half is fully testable against a
 * fake handle — and it is the half that decides whether we are allowed to
 * write to a customer's folder.
 *
 * Returns null when the grant is refused or the handle has gone stale; the
 * caller falls back to read-only rather than looping on failure.
 */
export async function ensureHandlePermission(
  handle: FileSystemDirectoryHandle,
  opts: { mode?: 'read' | 'readwrite'; prompt?: boolean } = {},
): Promise<FileSystemDirectoryHandle | null> {
  const mode = opts.mode ?? 'readwrite';
  const prompt = opts.prompt ?? true;
  try {
    const perm = await handle.queryPermission({ mode });
    if (perm === 'granted') return handle;
    if (!prompt) return null;
    const result = await handle.requestPermission({ mode });
    return result === 'granted' ? handle : null;
  } catch {
    // Stale handle (folder renamed/moved/removed) — treat as unavailable.
    return null;
  }
}

/**
 * Retrieve a persisted handle and verify permission for `mode`.
 *
 * Sister of {@link getWorkFolder}, which is hard-wired to `'read'`.
 */
export async function getFolderHandle(
  key: string,
  opts: { mode?: 'read' | 'readwrite'; prompt?: boolean } = {},
): Promise<FileSystemDirectoryHandle | null> {
  const handle = await getHandle(key);
  if (!handle) return null;
  return ensureHandlePermission(handle, opts);
}

/**
 * Get metadata about the configured working folder (without requiring permission).
 */
export function getWorkFolderMeta(): WorkFolderMeta | null {
  return getMeta();
}

/**
 * Get a subfolder handle from the working folder.
 * Returns null if the subfolder doesn't exist (won't create it).
 */
export async function getSubfolder(
  workFolder: FileSystemDirectoryHandle,
  subfolder: SubfolderName,
): Promise<FileSystemDirectoryHandle | null> {
  try {
    return await workFolder.getDirectoryHandle(SUBFOLDER[subfolder]);
  } catch {
    return null; // subfolder doesn't exist
  }
}

/**
 * Recursively enumerate files in a directory handle filtered by extensions.
 * @param handle Directory handle to scan
 * @param extensions Array of extensions WITH dot (e.g. ['.glb', '.splat'])
 * @param maxDepth Maximum recursion depth (default 5)
 */
export async function listFiles(
  handle: FileSystemDirectoryHandle,
  extensions: string[],
  maxDepth = 5,
): Promise<LocalFileEntry[]> {
  const results: LocalFileEntry[] = [];
  const lowerExts = extensions.map(e => e.toLowerCase());

  async function walk(dir: FileSystemDirectoryHandle, prefix: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;
    for await (const [name, entry] of dir.entries()) {
      if (entry.kind === 'file') {
        const lower = name.toLowerCase();
        if (lowerExts.some(ext => lower.endsWith(ext))) {
          results.push({
            name,
            path: prefix ? `${prefix}/${name}` : name,
            handle: entry as FileSystemFileHandle,
          });
        }
      } else if (entry.kind === 'directory') {
        await walk(entry as FileSystemDirectoryHandle, prefix ? `${prefix}/${name}` : name, depth + 1);
      }
    }
  }

  await walk(handle, '', 0);
  results.sort((a, b) => a.path.localeCompare(b.path));
  return results;
}

/**
 * Read a file from a handle and return a blob URL.
 * Caller is responsible for revoking the URL when done.
 */
export async function readFileAsUrl(fileHandle: FileSystemFileHandle): Promise<string> {
  const file = await fileHandle.getFile();
  return URL.createObjectURL(file);
}

/**
 * Request readwrite permission on an already-acquired folder handle.
 * The original picker uses `mode: 'read'`; this upgrades the existing
 * handle in place (no re-pick) so users keep their granted folder.
 * Returns true if granted.
 */
export async function requestWriteAccess(handle: FileSystemDirectoryHandle): Promise<boolean> {
  const current = await handle.queryPermission({ mode: 'readwrite' });
  if (current === 'granted') return true;
  const result = await handle.requestPermission({ mode: 'readwrite' });
  return result === 'granted';
}

/**
 * Get a subfolder handle, creating it if it doesn't exist. Requires
 * readwrite permission on the parent.
 */
export async function getOrCreateSubfolder(
  parent: FileSystemDirectoryHandle,
  name: string,
): Promise<FileSystemDirectoryHandle> {
  return parent.getDirectoryHandle(name, { create: true });
}

/**
 * Write a Blob into a directory as `filename`, overwriting if it exists.
 * Caller must hold readwrite permission on `dir`.
 */
export async function writeBlobFile(
  dir: FileSystemDirectoryHandle,
  filename: string,
  blob: Blob,
): Promise<void> {
  const fileHandle = await dir.getFileHandle(filename, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(blob);
  await writable.close();
}

/**
 * Read a UTF-8 text file from a directory. Returns null when the file does
 * not exist. Any other failure (permission, I/O) is rethrown — a caller that
 * cannot distinguish "absent" from "broken" would silently discard data.
 */
export async function readTextFile(
  dir: FileSystemDirectoryHandle,
  filename: string,
): Promise<string | null> {
  let fileHandle: FileSystemFileHandle;
  try {
    fileHandle = await dir.getFileHandle(filename);
  } catch (e: unknown) {
    if (e instanceof DOMException && e.name === 'NotFoundError') return null;
    // Non-Chromium/fake handles may throw a plain Error with the same name.
    if (e instanceof Error && e.name === 'NotFoundError') return null;
    throw e;
  }
  const file = await fileHandle.getFile();
  return file.text();
}

/** Write a UTF-8 text file into a directory, overwriting if present. */
export async function writeTextFile(
  dir: FileSystemDirectoryHandle,
  filename: string,
  text: string,
): Promise<void> {
  await writeBlobFile(dir, filename, new Blob([text], { type: 'application/json' }));
}

/**
 * Remove an entry from a directory. Missing entries are not an error —
 * deletion is idempotent. Everything else propagates.
 */
export async function removeFileEntry(
  dir: FileSystemDirectoryHandle,
  filename: string,
): Promise<void> {
  try {
    await dir.removeEntry(filename);
  } catch (e: unknown) {
    if (e instanceof DOMException && e.name === 'NotFoundError') return;
    if (e instanceof Error && e.name === 'NotFoundError') return;
    throw e;
  }
}

/**
 * Get a subfolder handle without creating it. Returns null when absent —
 * the "every artefact folder is optional" rule (§1.1 R1) depends on this
 * NOT throwing for a project that only carries `scenes/`.
 */
export async function tryGetSubfolder(
  parent: FileSystemDirectoryHandle,
  name: string,
): Promise<FileSystemDirectoryHandle | null> {
  try {
    return await parent.getDirectoryHandle(name);
  } catch {
    return null;
  }
}

/**
 * Convenience: get files from a specific subfolder of the working folder.
 * Returns empty array if working folder not set or subfolder doesn't exist.
 */
export async function listSubfolderFiles(
  subfolder: SubfolderName,
  extensions: string[],
  promptPermission = false,
): Promise<LocalFileEntry[]> {
  const root = await getWorkFolder(promptPermission);
  if (!root) return [];
  const sub = await getSubfolder(root, subfolder);
  if (!sub) return [];
  return listFiles(sub, extensions);
}

