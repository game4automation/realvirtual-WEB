// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-document-mode-store — the one place "the mode a document was last used
 * in" meets IndexedDB (plan-513).
 *
 * Database `rv-document-modes`, version 1, one object store `modes`, key
 * `<backend>:<projectId>:<documentId>` ({@link documentModeKey}), value
 * {@link DocumentModeRecord}. Per browser and personal: nothing here is ever
 * written into a project.
 *
 * Its own database rather than a field of the plan-509 model-index snapshot:
 * the index writer replaces a snapshot whole (`putSnapshot`), so a field there
 * would be overwritten by the next publish of the project store — and a
 * version 2 of `rv-model-index` would make every tab still holding version 1
 * block the upgrade.
 *
 * ## Failure is "unknown", never an error
 *
 * Every IndexedDB failure — a private window, a quota, an eviction — is logged
 * and answered as "no last mode". The open then falls back to the declared
 * mode; nothing breaks and no open is refused because of this store.
 *
 * ## Who writes
 *
 *  - {@link recordDocumentMode} — called by `SceneStore._recordRecentDocument`,
 *    i.e. by every open, Save-as and first save of a draft, right beside the
 *    recents ring. The mode is the ring's rule: the running open's intent
 *    (`withOpenIntentMode`) wins over the live mode.
 *  - {@link attachDocumentModeTracking} — the viewer's `mode-changed`, inert
 *    inside an open-intent scope (the handoff's transitional park mode must
 *    not land on anything) and under a kiosk lock.
 *
 * A kiosk writes nothing, and a demo project writes nothing either: opening a
 * project AS a demo instead deletes whatever it had (SOL R2 F4), so a chip on
 * a closed demo project can never show a last mode — the chip does not know
 * the project's kind, the absence of entries is what makes it right.
 *
 * ## The ring is not a second source
 *
 * The recents ring used to be the only place a document's mode lived. On the
 * first load of this store (marker absent) the ring's modes are copied over
 * once — never for the demo project — and from then on the ring is history
 * only; its `mode` is no longer read by anything that decides or displays.
 *
 * ## Other tabs
 *
 * A `BroadcastChannel('rv-document-modes')` announces every change; listeners
 * in the other tabs reload.
 */

import { idbDelete, idbDeleteRange, idbPut, idbRequest, idbTxDone, openIdb } from '../persistence/rv-idb-utils';
import {
  documentModeKey,
  documentModeProjectPrefix,
  type DocumentModeRecord,
} from './rv-document-mode';
import type { RecentBackend } from './rv-project-recents';
import {
  currentOpenIntentMode,
  isOpenIntentActive,
  readRecents,
} from './rv-project-recents-store';
import { DEMO_PROJECT_ID } from './backends/bundled-backend';

export const DOCUMENT_MODES_DB_NAME = 'rv-document-modes';
export const DOCUMENT_MODES_DB_VERSION = 1;
export const DOCUMENT_MODES_STORE = 'modes';
const CHANNEL_NAME = 'rv-document-modes';

/**
 * The one-time-migration marker. `~` sorts after every backend name and no key
 * of a document can start with it, so neither a load nor a project-wide range
 * delete ever meets it as a document.
 */
const SEED_MARKER_KEY = '~seededFromRecents';

type DbFactory = () => Promise<IDBDatabase>;

const defaultFactory: DbFactory = () =>
  openIdb(DOCUMENT_MODES_DB_NAME, DOCUMENT_MODES_DB_VERSION, [DOCUMENT_MODES_STORE]);

function warn(what: string, e: unknown): void {
  console.warn(`[document-modes] ${what} failed:`, e);
}

function parseRecord(raw: unknown): DocumentModeRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as { mode?: unknown; usedAt?: unknown };
  if (typeof r.mode !== 'string' || r.mode === '') return null;
  return { mode: r.mode, usedAt: typeof r.usedAt === 'string' ? r.usedAt : '' };
}

/** What a caller knows about the open it records. */
export interface DocumentModeOpenFacts {
  projectId: string | null | undefined;
  backend: RecentBackend | null | undefined;
  documentId: string | null | undefined;
  /** `viewer.modes.activeMode` at the moment of the open. */
  activeMode: string | null | undefined;
  /** `viewer.modes.lockedMode` — a kiosk records nothing. */
  lockedMode?: string | null;
  /** `project.kind === 'demo'` — a demo records nothing and loses what it had. */
  isDemo: boolean;
}

/** What the `mode-changed` tracking needs to know about the open document. */
export interface OpenDocumentFacts {
  projectId: string | null;
  backend: RecentBackend | null;
  documentId: string | null;
  isDemo: boolean;
}

/** Minimal shape of the viewer the tracking needs — keeps this testable. */
export interface DocumentModeTrackingHost {
  on(event: 'mode-changed', cb: (data: { from: string | null; to: string }) => void): () => void;
  modes?: { lockedMode?: string | null } | null;
}

export interface DocumentModeStore {
  /** Record an open (or a Save-as / first save). Never throws. */
  recordDocumentMode(facts: DocumentModeOpenFacts): Promise<void>;
  /** Store `mode` for one document outside any open (the `mode-changed` path). */
  setDocumentMode(backend: RecentBackend, projectId: string, documentId: string, mode: string): Promise<void>;
  /** The stored last mode of one document, or null (absent or unreadable). */
  readDocumentMode(backend: RecentBackend, projectId: string, documentId: string): Promise<string | null>;
  /** Every stored entry, keyed by {@link documentModeKey}. Empty on failure. */
  loadDocumentModes(): Promise<Map<string, DocumentModeRecord>>;
  /** Called on every change, in this tab or another. Returns the unsubscribe. */
  subscribeDocumentModes(listener: () => void): () => void;
  /** Drop every entry of one project (unlink, delete, opened as demo). */
  forgetDocumentModesOfProject(backend: RecentBackend, projectId: string): Promise<void>;
  /** Drop one document's entry. */
  forgetDocumentMode(backend: RecentBackend, projectId: string, documentId: string): Promise<void>;
  /** Wire `mode-changed` to the open document's entry. Returns the unsubscribe. */
  attachDocumentModeTracking(host: DocumentModeTrackingHost, whatIsOpen: () => OpenDocumentFacts): () => void;
  /** Close the cached connection (tests; a database delete needs it). */
  close(): void;
}

/**
 * A store instance. The module exports one bound default instance; a test may
 * create a second one to stand in for another tab (it shares the database and
 * the broadcast channel, nothing else).
 */
export function createDocumentModeStore(opts: { dbFactory?: DbFactory } = {}): DocumentModeStore {
  const factory = opts.dbFactory ?? defaultFactory;
  let dbPromise: Promise<IDBDatabase> | null = null;
  const listeners = new Set<() => void>();
  let channel: BroadcastChannel | null = null;

  function db(): Promise<IDBDatabase> {
    if (!dbPromise) {
      dbPromise = factory().then(async (d) => {
        // A connection closed by a version change or a delete elsewhere must
        // not be handed out again.
        d.addEventListener('close', () => { dbPromise = null; });
        const prior = d.onversionchange;
        d.onversionchange = (ev) => {
          dbPromise = null;
          if (typeof prior === 'function') prior.call(d, ev);
          else d.close();
        };
        // Before the connection is handed to anyone: a record written in the
        // same breath as the seed must land AFTER it, never be overwritten by
        // an older ring mode.
        await seedFromRecents(d).catch((e) => warn('seed from recents', e));
        return d;
      }, (e) => {
        // Not cached: a later call may succeed (a transient block).
        dbPromise = null;
        throw e;
      });
    }
    return dbPromise;
  }

  // ── Listeners ─────────────────────────────────────────────────────────

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

  // ── Writes ────────────────────────────────────────────────────────────

  async function put(key: string, mode: string): Promise<void> {
    try {
      const record: DocumentModeRecord = { mode, usedAt: new Date().toISOString() };
      await idbPut(await db(), DOCUMENT_MODES_STORE, key, record);
      announce();
    } catch (e) {
      warn('write', e);
    }
  }

  async function forgetDocumentModesOfProject(backend: RecentBackend, projectId: string): Promise<void> {
    if (!projectId) return;
    const prefix = documentModeProjectPrefix(backend, projectId);
    try {
      // `￿` closes the prefix range: every key that starts with the
      // prefix sorts below `prefix + '￿'`.
      await idbDeleteRange(await db(), DOCUMENT_MODES_STORE,
        IDBKeyRange.bound(prefix, `${prefix}￿`, false, true));
      announce();
    } catch (e) {
      warn('forget project', e);
    }
  }

  function recordDocumentMode(facts: DocumentModeOpenFacts): Promise<void> {
    // Everything that decides is read SYNCHRONOUSLY, here: the intent scope
    // belongs to the open that is running now, and an `await` before reading
    // it could read the scope of the next one.
    if ((facts.lockedMode ?? null) !== null) return Promise.resolve();   // kiosk: silent
    if (!facts.projectId || !facts.backend || !facts.documentId) return Promise.resolve();
    if (facts.isDemo) return forgetDocumentModesOfProject(facts.backend, facts.projectId);
    const mode = currentOpenIntentMode() ?? facts.activeMode ?? null;
    // No mode yet (the boot, before the mode system has run): record nothing
    // rather than erase what the document had. The mode boot's own
    // `mode-changed` is what records the answer then.
    if (!mode) return Promise.resolve();
    return put(documentModeKey(facts.backend, facts.projectId, facts.documentId), mode);
  }

  function setDocumentMode(
    backend: RecentBackend, projectId: string, documentId: string, mode: string,
  ): Promise<void> {
    if (!projectId || !documentId || !mode) return Promise.resolve();
    return put(documentModeKey(backend, projectId, documentId), mode);
  }

  async function forgetDocumentMode(backend: RecentBackend, projectId: string, documentId: string): Promise<void> {
    try {
      await idbDelete(await db(), DOCUMENT_MODES_STORE, documentModeKey(backend, projectId, documentId));
      announce();
    } catch (e) {
      warn('forget entry', e);
    }
  }

  // ── Reads ─────────────────────────────────────────────────────────────

  async function readDocumentMode(
    backend: RecentBackend, projectId: string, documentId: string,
  ): Promise<string | null> {
    try {
      const d = await db();
      const tx = d.transaction(DOCUMENT_MODES_STORE, 'readonly');
      const raw = await idbRequest(tx.objectStore(DOCUMENT_MODES_STORE)
        .get(documentModeKey(backend, projectId, documentId)));
      return parseRecord(raw)?.mode ?? null;
    } catch (e) {
      warn('read', e);
      return null;
    }
  }

  async function loadDocumentModes(): Promise<Map<string, DocumentModeRecord>> {
    const out = new Map<string, DocumentModeRecord>();
    try {
      const d = await db();
      const tx = d.transaction(DOCUMENT_MODES_STORE, 'readonly');
      const os = tx.objectStore(DOCUMENT_MODES_STORE);
      // Keys and values of one read transaction come back in the same (key)
      // order, so they zip.
      const [keys, values] = await Promise.all([
        idbRequest(os.getAllKeys()),
        idbRequest(os.getAll() as IDBRequest<unknown[]>),
      ]);
      keys.forEach((k, i) => {
        if (typeof k !== 'string' || k === SEED_MARKER_KEY) return;
        const rec = parseRecord(values[i]);
        if (rec) out.set(k, rec);
      });
    } catch (e) {
      warn('load', e);
      out.clear();
    }
    return out;
  }

  function subscribeDocumentModes(listener: () => void): () => void {
    ensureChannel();
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }

  // ── Tracking ──────────────────────────────────────────────────────────

  function attachDocumentModeTracking(
    host: DocumentModeTrackingHost,
    whatIsOpen: () => OpenDocumentFacts,
  ): () => void {
    return host.on('mode-changed', ({ to }) => {
      if ((host.modes?.lockedMode ?? null) !== null) return;
      // Inside an open the handoff moves through a mode that belongs to
      // nobody; the open records its own intent through the funnel.
      if (isOpenIntentActive()) return;
      const open = whatIsOpen();
      if (open.isDemo || !open.projectId || !open.backend || !open.documentId) return;
      void setDocumentMode(open.backend, open.projectId, open.documentId, to);
    });
  }

  function close(): void {
    const p = dbPromise;
    dbPromise = null;
    p?.then(d => d.close(), () => { /* never opened */ });
    try { channel?.close(); } catch { /* already closed */ }
    channel = null;
  }

  return {
    recordDocumentMode,
    setDocumentMode,
    readDocumentMode,
    loadDocumentModes,
    subscribeDocumentModes,
    forgetDocumentModesOfProject,
    forgetDocumentMode,
    attachDocumentModeTracking,
    close,
  };
}

/**
 * Copy the recents ring's modes over, once (plan-513 §2.4).
 *
 * One `readwrite` transaction: the marker is checked, the missing entries are
 * added (an existing entry is never overwritten — it is newer than the ring's
 * mode by construction) and the marker is set, all or nothing. The demo
 * project is skipped: it never has a last mode.
 */
async function seedFromRecents(d: IDBDatabase): Promise<void> {
  let ring: ReturnType<typeof readRecents> = [];
  try { ring = readRecents(); } catch { ring = []; }
  const tx = d.transaction(DOCUMENT_MODES_STORE, 'readwrite');
  const os = tx.objectStore(DOCUMENT_MODES_STORE);
  const req = os.getAllKeys();
  req.onsuccess = () => {
    const keys = new Set(req.result.map(k => String(k)));
    if (keys.has(SEED_MARKER_KEY)) return;
    for (const e of ring) {
      if (!e.mode || e.projectId === DEMO_PROJECT_ID) continue;
      const key = documentModeKey(e.backend, e.projectId, e.documentId);
      if (keys.has(key)) continue;
      keys.add(key);
      const record: DocumentModeRecord = { mode: e.mode, usedAt: e.openedAt };
      os.put(record, key);
    }
    os.put({ seededAt: new Date().toISOString() }, SEED_MARKER_KEY);
  };
  await idbTxDone(tx);
}

// ── The default instance ─────────────────────────────────────────────────

let defaultStore = createDocumentModeStore();

export function recordDocumentMode(facts: DocumentModeOpenFacts): Promise<void> {
  return defaultStore.recordDocumentMode(facts);
}
export function setDocumentMode(
  backend: RecentBackend, projectId: string, documentId: string, mode: string,
): Promise<void> {
  return defaultStore.setDocumentMode(backend, projectId, documentId, mode);
}
export function readDocumentMode(
  backend: RecentBackend, projectId: string, documentId: string,
): Promise<string | null> {
  return defaultStore.readDocumentMode(backend, projectId, documentId);
}
export function loadDocumentModes(): Promise<Map<string, DocumentModeRecord>> {
  return defaultStore.loadDocumentModes();
}
export function subscribeDocumentModes(listener: () => void): () => void {
  return defaultStore.subscribeDocumentModes(listener);
}
export function forgetDocumentModesOfProject(backend: RecentBackend, projectId: string): Promise<void> {
  return defaultStore.forgetDocumentModesOfProject(backend, projectId);
}
export function forgetDocumentMode(backend: RecentBackend, projectId: string, documentId: string): Promise<void> {
  return defaultStore.forgetDocumentMode(backend, projectId, documentId);
}
export function attachDocumentModeTracking(
  host: DocumentModeTrackingHost,
  whatIsOpen: () => OpenDocumentFacts,
): () => void {
  return defaultStore.attachDocumentModeTracking(host, whatIsOpen);
}

/** Tests only: swap the database opener (e.g. one that rejects) — a fresh default instance. */
export function __setDocumentModesDbFactory(factory: DbFactory | null): void {
  defaultStore.close();
  defaultStore = createDocumentModeStore(factory ? { dbFactory: factory } : {});
}

/** Tests only: close the default instance's connection so the database can be deleted. */
export function __closeDocumentModesDb(): void {
  defaultStore.close();
  defaultStore = createDocumentModeStore();
}
