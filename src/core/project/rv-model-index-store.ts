// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-model-index-store — the one place model-index snapshots meet IndexedDB
 * (plan-509 Phase 1).
 *
 * Database `rv-model-index`, version 1, one object store `snapshots`, key
 * `<backend>:<projectId>` ({@link modelIndexKey}). IndexedDB rather than
 * localStorage because fifty projects with a couple of thousand documents each
 * are tens of megabytes — past the localStorage quota — and because
 * localStorage writes block the main thread. The name deliberately sits
 * outside the `rv-project/*` keys the boot's legacy cleanup sweeps.
 *
 * ## Failure is "no index", never an error
 *
 * Every IndexedDB failure — quota, a blocked private window, an eviction under
 * storage pressure — is logged and answered as an empty index. The search then
 * finds nothing; nothing breaks, and the next project open rebuilds.
 *
 * ## Read-modify-write in one transaction
 *
 * {@link forgetModelIndexEntry} goes through `idbUpdate`, which reads and
 * writes inside ONE `readwrite` transaction. Two overlapping removals — two
 * clicks, or two tabs — are serialised by IndexedDB and cannot lose each
 * other's change. {@link putSnapshot} replaces a snapshot whole and reads
 * nothing.
 *
 * ## Other tabs
 *
 * A `BroadcastChannel('rv-model-index')` announces every change; listeners in
 * the other tabs reload. Without `BroadcastChannel` the Projects screen still
 * reloads on every mount.
 */

import {
  idbDelete, idbGet, idbGetAll, idbPut, idbUpdate, openIdb,
} from '../persistence/rv-idb-utils';
import {
  modelIndexKey, parseSnapshot, snapshotKey,
  type ModelIndexBackend, type ModelIndexSnapshot,
} from './rv-model-index';

export const MODEL_INDEX_DB_NAME = 'rv-model-index';
export const MODEL_INDEX_DB_VERSION = 1;
export const MODEL_INDEX_STORE = 'snapshots';
const CHANNEL_NAME = 'rv-model-index';

type DbFactory = () => Promise<IDBDatabase>;

const defaultFactory: DbFactory = () =>
  openIdb(MODEL_INDEX_DB_NAME, MODEL_INDEX_DB_VERSION, [MODEL_INDEX_STORE]);

let dbFactory: DbFactory = defaultFactory;
let dbPromise: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = dbFactory().then((d) => {
      // A connection closed by a version change or a delete elsewhere must not
      // be handed out again.
      d.addEventListener('close', () => { if (dbPromise) dbPromise = null; });
      const prior = d.onversionchange;
      d.onversionchange = (ev) => {
        dbPromise = null;
        if (typeof prior === 'function') prior.call(d, ev);
        else d.close();
      };
      return d;
    }, (e) => {
      // Not cached: a later call may succeed (a transient block).
      dbPromise = null;
      throw e;
    });
  }
  return dbPromise;
}

function warn(what: string, e: unknown): void {
  console.warn(`[model-index] ${what} failed:`, e);
}

// ── Listeners ────────────────────────────────────────────────────────────

const listeners = new Set<() => void>();
let channel: BroadcastChannel | null = null;

function ensureChannel(): void {
  if (channel || typeof BroadcastChannel !== 'function') return;
  try {
    channel = new BroadcastChannel(CHANNEL_NAME);
    channel.onmessage = () => { notifyLocal(); };
  } catch {
    channel = null;
  }
}

function notifyLocal(): void {
  for (const l of [...listeners]) {
    try { l(); } catch (e) { warn('listener', e); }
  }
}

function announce(): void {
  notifyLocal();
  ensureChannel();
  try { channel?.postMessage({ type: 'changed' }); } catch { /* closed channel */ }
}

/** Called on every change, in this tab or another. Returns the unsubscribe. */
export function subscribeModelIndex(listener: () => void): () => void {
  ensureChannel();
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

// ── Forget hooks (the writer's pending timers) ───────────────────────────

const forgetHooks = new Set<(key: string) => void>();

/**
 * Run `hook(key)` BEFORE a project's snapshot is deleted.
 *
 * The writer registers its `cancelPendingWrite` here, so a debounced write
 * that was already scheduled for the project cannot land after the delete and
 * bring the snapshot back (plan-509 SOL F7). A hook rather than an import: the
 * writer depends on this store, not the other way round.
 */
export function onModelIndexProjectForget(hook: (key: string) => void): () => void {
  forgetHooks.add(hook);
  return () => { forgetHooks.delete(hook); };
}

// ── Reads and writes ─────────────────────────────────────────────────────

/** Every stored snapshot. `ok: false` when IndexedDB could not be read. */
export async function loadModelIndex(): Promise<{ ok: boolean; snapshots: ModelIndexSnapshot[] }> {
  try {
    const raw = await idbGetAll<unknown>(await db(), MODEL_INDEX_STORE);
    const snapshots: ModelIndexSnapshot[] = [];
    for (const r of raw) {
      const s = parseSnapshot(r);
      if (s) snapshots.push(s);
    }
    return { ok: true, snapshots };
  } catch (e) {
    warn('load', e);
    return { ok: false, snapshots: [] };
  }
}

/** One stored snapshot, or null (absent, unreadable, or wrong version). */
export async function readSnapshot(
  backend: ModelIndexBackend,
  projectId: string,
): Promise<ModelIndexSnapshot | null> {
  try {
    return parseSnapshot(
      await idbGet<unknown>(await db(), MODEL_INDEX_STORE, modelIndexKey(backend, projectId)));
  } catch (e) {
    warn('read', e);
    return null;
  }
}

/** Replace a project's snapshot whole. Resolves false when it could not be written. */
export async function putSnapshot(snapshot: ModelIndexSnapshot): Promise<boolean> {
  try {
    await idbPut(await db(), MODEL_INDEX_STORE, snapshotKey(snapshot), snapshot);
    announce();
    return true;
  } catch (e) {
    warn('write', e);
    return false;
  }
}

/**
 * Delete one project's snapshot — the only deletion there is (plan-509 SOL F6:
 * nothing is ever removed automatically). Pending writes for it are cancelled
 * first.
 */
export async function forgetModelIndexOfProject(
  backend: ModelIndexBackend,
  projectId: string,
): Promise<void> {
  const key = modelIndexKey(backend, projectId);
  for (const hook of [...forgetHooks]) {
    try { hook(key); } catch (e) { warn('forget hook', e); }
  }
  try {
    await idbDelete(await db(), MODEL_INDEX_STORE, key);
    announce();
  } catch (e) {
    warn('forget project', e);
  }
}

/**
 * Remove ONE document from a project's snapshot — the open chain's answer to a
 * hit whose document is gone. Read and write share one transaction.
 */
export async function forgetModelIndexEntry(
  backend: ModelIndexBackend,
  projectId: string,
  documentId: string,
): Promise<void> {
  try {
    await idbUpdate<unknown>(await db(), MODEL_INDEX_STORE, modelIndexKey(backend, projectId), (raw) => {
      if (raw === undefined) return undefined;
      const snap = parseSnapshot(raw);
      if (!snap) return raw;   // not ours to repair; leave it as found
      return { ...snap, docs: snap.docs.filter(d => d.id !== documentId) };
    });
    announce();
  } catch (e) {
    warn('forget entry', e);
  }
}

// ── Tests ────────────────────────────────────────────────────────────────

/** Tests only: swap the database opener (e.g. one that rejects). */
export function __setModelIndexDbFactory(factory: DbFactory | null): void {
  __closeModelIndexDb();
  dbFactory = factory ?? defaultFactory;
}

/** Tests only: close the cached connection so the database can be deleted. */
export function __closeModelIndexDb(): void {
  const p = dbPromise;
  dbPromise = null;
  p?.then(d => d.close(), () => { /* never opened */ });
}
