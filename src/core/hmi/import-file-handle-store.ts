// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * import-file-handle-store.ts — Remembers the last imported local file per use case.
 *
 * When the user imports a local file (signal table, STEP/STP CAD file, …), the
 * chosen `FileSystemFileHandle` is persisted in IndexedDB under a caller-supplied
 * `key` so the next import can offer "Re-open" without re-picking. Each key maps
 * to its own stored handle, so different importers (e.g. `'lastSignalTable'` vs
 * `'lastStepFile'`) persist independently. This works on Chromium-based browsers
 * that support the File System Access API. Browsers without it fall back to the
 * classic `<input type="file">` picker.
 *
 * Privacy: only the file handle (a reference, not contents) is stored locally.
 * Nothing is uploaded. The browser controls permission re-grants on reload.
 *
 * The FS Access types (`FileSystemFileHandle`, `Window.showOpenFilePicker`) are
 * declared globally in `src/file-system-access.d.ts`.
 */

// ─── Constants ──────────────────────────────────────────────────────────

const DB_NAME = 'rv-import-handles';
const DB_VERSION = 1;
const STORE_HANDLES = 'handles';

// ─── Feature detection ──────────────────────────────────────────────────

/** True when the File System Access API (`showOpenFilePicker`) is available. */
export function supportsFsAccess(): boolean {
  return typeof window !== 'undefined' && typeof window.showOpenFilePicker === 'function';
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

// ─── Public API ─────────────────────────────────────────────────────────

/**
 * Persist the last picked file handle under the given `key`.
 * Each key stores an independent handle. Silently ignores failures
 * (private mode / storage disabled).
 */
export async function saveLastFileHandle(key: string, handle: FileSystemFileHandle): Promise<void> {
  try {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_HANDLES, 'readwrite');
      tx.objectStore(STORE_HANDLES).put(handle, key);
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    });
  } catch {
    /* storage disabled / unavailable — non-fatal */
  }
}

/**
 * Retrieve the last picked file handle for the given `key`, or null if none
 * stored / unavailable. Does not request permission — call
 * {@link ensureReadPermission} before reading.
 */
export async function getLastFileHandle(key: string): Promise<FileSystemFileHandle | null> {
  try {
    const db = await openDB();
    return await new Promise<FileSystemFileHandle | null>((resolve, reject) => {
      const tx = db.transaction(STORE_HANDLES, 'readonly');
      const req = tx.objectStore(STORE_HANDLES).get(key);
      req.onsuccess = () => { db.close(); resolve((req.result as FileSystemFileHandle) ?? null); };
      req.onerror = () => { db.close(); reject(req.error); };
    });
  } catch {
    return null;
  }
}

/** Remove the stored file handle for the given `key`. Silently ignores failures. */
export async function clearLastFileHandle(key: string): Promise<void> {
  try {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_HANDLES, 'readwrite');
      tx.objectStore(STORE_HANDLES).delete(key);
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    });
  } catch {
    /* non-fatal */
  }
}

/**
 * Ensure read permission on a stored handle, prompting the user if needed.
 * Returns true if read access is granted. Never throws — a denied or revoked
 * permission resolves to false so callers can fall back to a normal pick.
 */
export async function ensureReadPermission(handle: FileSystemFileHandle): Promise<boolean> {
  try {
    const current = await handle.queryPermission({ mode: 'read' });
    if (current === 'granted') return true;
    const result = await handle.requestPermission({ mode: 'read' });
    return result === 'granted';
  } catch {
    return false;
  }
}
