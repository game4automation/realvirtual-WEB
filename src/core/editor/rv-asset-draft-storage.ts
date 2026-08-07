// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-asset-draft-storage — crash-recovery persistence for the asset editor.
 *
 * One draft slot (`'current'`) in IndexedDB (DB `rv-asset-editor`, store
 * `drafts`) holds the in-progress AssetDocument: shell metadata + the full op
 * log. Ops are JSON-safe by construction (CAD geometry referenced by hash,
 * never inlined), so a draft survives reloads/crashes and replays through the
 * executors + CadGeometryProvider.
 *
 * IndexedDB (not localStorage): matches the FS-handle store precedent, avoids
 * the ~5 MB quota, and structured-clones without stringify overhead.
 */

import type { AssetOp } from './rv-asset-ops';

const DB_NAME = 'rv-asset-editor';
const DB_VERSION = 1;
const STORE = 'drafts';
const DRAFT_KEY = 'current';

/** The persisted draft shape. */
export interface AssetDraft {
  shell: {
    id: string;
    name: string;
    base: AssetDraftBase;
    createdAt: number;
  };
  ops: AssetOp[];
  savedAt: number;
}

/** Where the document started from (mirrors AssetBase, kept JSON-local here). */
export type AssetDraftBase =
  | { kind: 'empty' }
  | { kind: 'libraryGlb'; fileName: string; relPath: string }
  /**
   * An asset that came from a registered library source (plan-372 §2.6.6).
   *
   * Stores the *identity* — provider, source, asset — and never a URL. Cloud
   * adapters hand out `blob:` URLs that are dead after a reload, so a
   * persisted URL would make every draft reopen fail silently. On reopen the
   * editor re-resolves through `getLibrarySource(providerId, sourceId)`.
   *
   * `version` is advisory: a mismatch does NOT block reopening, it only lets
   * the editor tell the user the source has moved on.
   */
  | {
      kind: 'providerAsset';
      providerId: string;
      sourceId: string;
      assetId: string;
      version?: string;
      label: string;
    };

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
  });
}

/** Save (overwrite) the current draft. Best-effort — errors are logged, never thrown. */
export async function saveAssetDraft(draft: AssetDraft): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(draft, DRAFT_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('draft put failed'));
    });
    db.close();
  } catch (e) {
    console.warn('[asset-editor] draft save failed:', e);
  }
}

/** Load the current draft, or null when none exists / storage unavailable. */
export async function loadAssetDraft(): Promise<AssetDraft | null> {
  try {
    const db = await openDb();
    const draft = await new Promise<AssetDraft | null>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(DRAFT_KEY);
      req.onsuccess = () => resolve((req.result as AssetDraft | undefined) ?? null);
      req.onerror = () => reject(req.error ?? new Error('draft get failed'));
    });
    db.close();
    return draft;
  } catch (e) {
    console.warn('[asset-editor] draft load failed:', e);
    return null;
  }
}

/** Delete the current draft (after save / explicit discard). Best-effort. */
export async function clearAssetDraft(): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(DRAFT_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('draft delete failed'));
    });
    db.close();
  } catch (e) {
    console.warn('[asset-editor] draft clear failed:', e);
  }
}
