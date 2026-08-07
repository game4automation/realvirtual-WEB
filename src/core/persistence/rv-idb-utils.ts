// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-idb-utils.ts — small, generic IndexedDB helpers (promisified).
 *
 * Until plan-261 every consumer opened its own IndexedDB with hand-rolled
 * promise wrappers (`rv-asset-draft-storage`, `rv-local-filesystem`,
 * `rv-des-snapshot`). This module centralises the boilerplate:
 *
 *  - `openIdb(name, version, storeNames)` — open/upgrade with plain
 *    (out-of-line-key) object stores.
 *  - `idbRequest(req)` — one IDBRequest as a Promise.
 *  - `idbTxDone(tx)` — transaction completion as a Promise.
 *  - get/put/delete/keys helpers for the common single-op cases.
 *
 * GENERIC by design (plan-261): lives in the PUBLIC repo so the private DES
 * plugin can import it (private→public only, plan 194). It must never import
 * feature types (no `DESSnapshot`, no `ExperimentMeta`).
 */

/** Open (or upgrade) a database, creating any missing plain object stores. */
export function openIdb(
  name: string,
  version: number,
  storeNames: readonly string[],
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, version);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      // Close automatically when another context upgrades or deletes the DB —
      // otherwise deleteDatabase()/version upgrades block forever on this
      // connection (classic IndexedDB deadlock).
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const storeName of storeNames) {
        if (!db.objectStoreNames.contains(storeName)) {
          db.createObjectStore(storeName);
        }
      }
    };
  });
}

/** Await a single IDBRequest. */
export function idbRequest<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Await transaction completion (rejects on error/abort). */
export function idbTxDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new DOMException('transaction aborted', 'AbortError'));
  });
}

/** Read one record (undefined when absent). */
export async function idbGet<T>(db: IDBDatabase, store: string, key: IDBValidKey): Promise<T | undefined> {
  const tx = db.transaction(store, 'readonly');
  return idbRequest<T | undefined>(tx.objectStore(store).get(key) as IDBRequest<T | undefined>);
}

/** Write one record (single-op transaction). */
export async function idbPut(db: IDBDatabase, store: string, key: IDBValidKey, value: unknown): Promise<void> {
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).put(value, key);
  return idbTxDone(tx);
}

/** Delete one record (single-op transaction). */
export async function idbDelete(db: IDBDatabase, store: string, key: IDBValidKey): Promise<void> {
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).delete(key);
  return idbTxDone(tx);
}

/** All keys of a store, optionally restricted to a key range. */
export async function idbGetAllKeys(
  db: IDBDatabase,
  store: string,
  range?: IDBKeyRange,
): Promise<IDBValidKey[]> {
  const tx = db.transaction(store, 'readonly');
  return idbRequest(tx.objectStore(store).getAllKeys(range ?? null));
}

/** Delete every record whose key falls in `range` (single transaction). */
export async function idbDeleteRange(db: IDBDatabase, store: string, range: IDBKeyRange): Promise<void> {
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).delete(range);
  return idbTxDone(tx);
}

/** Storage usage estimate (0/0 when the API is unavailable). */
export async function idbEstimateUsage(): Promise<{ usedBytes: number; quotaBytes: number }> {
  try {
    if (typeof navigator !== 'undefined' && navigator.storage?.estimate) {
      const est = await navigator.storage.estimate();
      return { usedBytes: est.usage ?? 0, quotaBytes: est.quota ?? 0 };
    }
  } catch { /* estimate unavailable — fall through */ }
  return { usedBytes: 0, quotaBytes: 0 };
}
