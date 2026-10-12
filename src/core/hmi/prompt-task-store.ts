// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * prompt-task-store — the browser-side prompt queue of plan-486.
 *
 * ## Why the queue lives here and not in a file
 *
 * The OPFS project backend has no disk, a task typed with no project open must
 * not be lost, and this store is the only place where a `claim` can be
 * synchronous — which is what makes at-most-once delivery possible without any
 * lease bookkeeping. The `tasks/*.md` mirror is a paper trail, not the source
 * of truth.
 *
 * ## Claim marks, it does not delete
 *
 * `claim()` picks the oldest `open` task and flips it to `claimed`. An aborted
 * agent run therefore loses nothing: the task is still in `list({includeClaimed})`
 * and `reopen(id)` puts it back. That is bounded retention, not a guarantee —
 * a `claimed` task can still be displaced when the queue fills, and without the
 * project mirror no copy survives that. The plan promises traceability, not
 * indestructibility.
 *
 * ## The claim is persisted BEFORE it is delivered
 *
 * If the write fails, nothing is handed out (`{task:null,error:…}`). Delivering
 * first and persisting second would mean a reload re-delivers work an agent has
 * already started. When there is no usable `localStorage` at all, the queue
 * keeps working and at-most-once holds FOR THE SESSION ONLY — that is the
 * volatile mode, and it is documented as such rather than pretended away.
 *
 * ## Tab identity and the duplicate-tab trap
 *
 * The persistence key carries a tab id kept in `sessionStorage`, so a reload of
 * the same tab rehydrates its own queue. But `sessionStorage` is COPIED when a
 * tab is duplicated (Storage Standard), so a duplicate would inherit the id and
 * both tabs would write the same key. The owner therefore keeps a heartbeat in
 * `localStorage`, refreshed while it lives and CLEARED on `pagehide`:
 *
 *  - reload  → the outgoing page cleared the heartbeat → the new incarnation
 *              adopts its own queue;
 *  - duplicate → the original is alive and its heartbeat is fresh → the copy
 *              mints a NEW tab id and starts empty, instead of stealing a queue.
 *
 * Cross-tab synchronisation is deliberately absent in v1 (see plan §8); tab-own
 * keys are what makes its absence safe.
 */

import {
  MAX_QUEUE_TASKS,
  serializeClaimEmpty,
  serializeClaimError,
  serializeClaimHit,
  serializeList,
  type PromptTask,
} from './prompt-task-envelope';

// ─── Storage seams ──────────────────────────────────────────────────────

/** The slice of the Storage interface this module uses. */
export interface PromptStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface PromptTaskStoreOptions {
  /** Durable storage. `null` selects volatile mode explicitly. */
  local?: PromptStorageLike | null;
  /** Tab-scoped storage holding the tab id. `null` mints a per-instance id. */
  session?: PromptStorageLike | null;
  /** Project key component of the persistence key; `null` → `none`. */
  projectKey?: string | null;
  /** Clock seam (ms). */
  now?: () => number;
  /** Start the background heartbeat refresh. Off in tests. */
  autoHeartbeat?: boolean;
}

const TAB_ID_KEY = 'rv-prompt-tab-id';
const KEY_PREFIX = 'rv-prompt-tasks-';
const OWNER_PREFIX = 'rv-prompt-owner-';

/** A heartbeat older than this belongs to a tab that is gone. */
export const HEARTBEAT_STALE_MS = 8_000;
const HEARTBEAT_INTERVAL_MS = 2_000;

interface PersistedQueue {
  version: 1;
  owner: string;
  tasks: PromptTask[];
  lastClaimAt: string | null;
}

interface OwnerRecord {
  owner: string;
  at: number;
}

// ─── Results ────────────────────────────────────────────────────────────

export interface EnqueueResult {
  ok: boolean;
  /** Set when the 51st task displaced the oldest CLAIMED task. */
  evicted?: PromptTask;
  /** Set when the task was REFUSED (queue full of open work). */
  reason?: string;
}

export interface ClaimResult {
  task: PromptTask | null;
  /** Set when the claim could not be persisted — nothing was delivered. */
  error?: string;
}

export interface PromptTaskSnapshot {
  tasks: readonly PromptTask[];
  open: number;
  claimed: number;
  lastClaimAt: string | null;
  /** Last persistence failure, surfaced in the panel. `null` when healthy. */
  persistError: string | null;
  /** Last displacement or refusal, surfaced in the panel. `null` when none. */
  notice: string | null;
  /** True when no durable storage is available — at-most-once per session only. */
  volatile: boolean;
}

const EMPTY_SNAPSHOT: PromptTaskSnapshot = Object.freeze({
  tasks: Object.freeze([]) as readonly PromptTask[],
  open: 0, claimed: 0, lastClaimAt: null, persistError: null, notice: null, volatile: true,
});

// ─── Store ──────────────────────────────────────────────────────────────

export class PromptTaskStore {
  private _tasks: PromptTask[] = [];
  private _lastClaimAt: string | null = null;
  private _persistError: string | null = null;
  private _notice: string | null = null;
  private _listeners = new Set<() => void>();
  private _snapshot: PromptTaskSnapshot = EMPTY_SNAPSHOT;

  private _local: PromptStorageLike | null;
  private _session: PromptStorageLike | null;
  private readonly _now: () => number;
  private readonly _owner = `${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
  private _projectKey: string;
  private _tabId: string;
  private _timer: ReturnType<typeof setInterval> | null = null;
  private _unloadHandler: (() => void) | null = null;

  constructor(options: PromptTaskStoreOptions = {}) {
    this._local = options.local !== undefined ? options.local : defaultLocal();
    // A storage that refuses on the very first touch is not a storage — it is
    // VOLATILE MODE, decided once here rather than reported as a failure on
    // every later claim. A quota error that appears LATER is a real persistence
    // failure and must still stop a claim, which is why this is a probe and not
    // a blanket try/catch around `_persist`.
    if (this._local && !probeStorage(this._local)) this._local = null;
    this._session = options.session !== undefined ? options.session : defaultSession();
    if (this._session && !probeStorage(this._session)) this._session = null;
    this._now = options.now ?? (() => Date.now());
    this._projectKey = normalizeProjectKey(options.projectKey ?? null);
    this._tabId = this._readTabId();
    this._rehydrate();
    if (options.autoHeartbeat ?? true) this._startHeartbeat();
  }

  // ─── Identity ────────────────────────────────────────────────────────

  /** The tab id the persistence key is built from (test/diagnostics visible). */
  get tabId(): string { return this._tabId; }

  /** The `localStorage` key this store reads and writes. */
  get storageKey(): string { return `${KEY_PREFIX}${this._tabId}-${this._projectKey}`; }

  private get _ownerKey(): string { return `${OWNER_PREFIX}${this._tabId}`; }

  private _readTabId(): string {
    try {
      const existing = this._session?.getItem(TAB_ID_KEY);
      if (existing) return existing;
    } catch { /* private mode */ }
    return this._mintTabId();
  }

  private _mintTabId(): string {
    const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    try { this._session?.setItem(TAB_ID_KEY, id); } catch { /* private mode */ }
    return id;
  }

  // ─── Persistence ─────────────────────────────────────────────────────

  private _readOwner(): OwnerRecord | null {
    try {
      const raw = this._local?.getItem(this._ownerKey);
      if (!raw) return null;
      const rec = JSON.parse(raw) as OwnerRecord;
      return typeof rec?.owner === 'string' && typeof rec?.at === 'number' ? rec : null;
    } catch { return null; }
  }

  /** Stamp ownership of the current tab id. Safe to call often. */
  touchHeartbeat(): void {
    try {
      this._local?.setItem(this._ownerKey, JSON.stringify({ owner: this._owner, at: this._now() }));
    } catch { /* quota — the queue keeps working, persistence is best effort */ }
  }

  private _startHeartbeat(): void {
    if (typeof setInterval === 'function') {
      this._timer = setInterval(() => this.touchHeartbeat(), HEARTBEAT_INTERVAL_MS);
      // Never hold a Node process open for a heartbeat.
      (this._timer as unknown as { unref?: () => void })?.unref?.();
    }
    const w = globalThis as unknown as {
      addEventListener?: (t: string, h: () => void) => void;
    };
    if (typeof w.addEventListener === 'function') {
      // Clearing on the way out is what separates a RELOAD (adopt my own queue)
      // from a DUPLICATE (the original is still alive — mint a new id).
      this._unloadHandler = () => { try { this._local?.removeItem(this._ownerKey); } catch { /* gone */ } };
      w.addEventListener('pagehide', this._unloadHandler);
    }
  }

  /**
   * Load the queue for the current key, minting a new tab id when a LIVE
   * foreign owner holds it (the duplicated-tab case).
   */
  private _rehydrate(): void {
    const owner = this._readOwner();
    if (owner && owner.owner !== this._owner && this._now() - owner.at < HEARTBEAT_STALE_MS) {
      this._tabId = this._mintTabId();
      this._tasks = [];
      this._lastClaimAt = null;
      this._notice = 'This tab looked like a duplicate of a live tab — it started with an empty queue.';
      this.touchHeartbeat();
      this._publish();
      return;
    }
    this._tasks = this._load();
    this._publish();
    this.touchHeartbeat();
  }

  private _load(): PromptTask[] {
    try {
      const raw = this._local?.getItem(this.storageKey);
      if (!raw) return [];
      const parsed = JSON.parse(raw) as PersistedQueue;
      this._lastClaimAt = typeof parsed?.lastClaimAt === 'string' ? parsed.lastClaimAt : null;
      return Array.isArray(parsed?.tasks) ? parsed.tasks.filter(isPromptTask) : [];
    } catch {
      return [];
    }
  }

  /** True when this store has no durable storage at all (volatile mode). */
  get isVolatile(): boolean { return this._local === null; }

  /**
   * Write the queue. Returns an error string on failure, `null` on success —
   * and `null` in volatile mode, where there is nothing to fail.
   */
  private _persist(): string | null {
    if (!this._local) return null;
    const payload: PersistedQueue = {
      version: 1, owner: this._owner, tasks: this._tasks, lastClaimAt: this._lastClaimAt,
    };
    try {
      this._local.setItem(this.storageKey, JSON.stringify(payload));
      this.touchHeartbeat();
      this._persistError = null;
      return null;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this._persistError = `Could not save the prompt queue: ${msg}`;
      return this._persistError;
    }
  }

  // ─── Project switch ──────────────────────────────────────────────────

  /**
   * Point the store at another project key.
   *
   * The OLD key's queue is left exactly where it is — switching back reads it
   * again. Nothing is migrated, because a task written about one model is not a
   * task about another.
   */
  setProjectKey(projectKey: string | null): void {
    const next = normalizeProjectKey(projectKey);
    if (next === this._projectKey) return;
    this._persist();
    this._projectKey = next;
    this._lastClaimAt = null;
    this._tasks = this._load();
    this._publish();
  }

  // ─── Queue verbs ─────────────────────────────────────────────────────

  /**
   * Add a task.
   *
   * At {@link MAX_QUEUE_TASKS} the OLDEST CLAIMED task is displaced and the
   * displacement is reported. With nothing claimed the new task is REFUSED
   * visibly — silently dropping an open, undelivered order is the one outcome
   * this rule exists to prevent.
   */
  enqueue(task: PromptTask): EnqueueResult {
    let evicted: PromptTask | undefined;
    if (this._tasks.length >= MAX_QUEUE_TASKS) {
      const idx = this._oldestClaimedIndex();
      if (idx < 0) {
        this._notice = `Queue full (${MAX_QUEUE_TASKS} open tasks) — work them off or delete some first.`;
        this._publish();
        return { ok: false, reason: this._notice };
      }
      evicted = this._tasks.splice(idx, 1)[0];
      this._notice = `Queue full — displaced the oldest claimed task ${evicted.id} (${evicted.context.targetPath || 'no target'}).`;
      logNotice(this._notice);
    } else {
      this._notice = null;
    }
    this._tasks.push(task);
    this._persist();
    this._publish();
    return evicted ? { ok: true, evicted } : { ok: true };
  }

  /** Queue contents, oldest first. Claimed tasks only on request. */
  list(options: { includeClaimed?: boolean } = {}): PromptTask[] {
    return options.includeClaimed ? [...this._tasks] : this._tasks.filter((t) => t.status === 'open');
  }

  /**
   * Hand out the oldest open task, marking it claimed FIRST.
   *
   * Returns immediately — there is no wait mode and never will be one: a
   * waiting call holds `installMcpDialogPolicy()` open for its whole duration
   * and is undeliverable after a cancellation.
   */
  claim(): ClaimResult {
    const idx = this._tasks.findIndex((t) => t.status === 'open');
    if (idx < 0) return { task: null };

    const original = this._tasks[idx];
    const claimedAt = new Date(this._now()).toISOString();
    const claimed: PromptTask = { ...original, status: 'claimed', claimedAt };
    const previousLastClaim = this._lastClaimAt;

    this._tasks[idx] = claimed;
    this._lastClaimAt = claimedAt;
    const error = this._persist();
    if (error) {
      // Nothing is delivered, and the stored queue is left exactly as it was.
      this._tasks[idx] = original;
      this._lastClaimAt = previousLastClaim;
      this._publish();
      return { task: null, error };
    }
    this._publish();
    return { task: claimed };
  }

  /** Put a claimed task back into the queue. False when the id is unknown. */
  reopen(id: string): boolean {
    const idx = this._tasks.findIndex((t) => t.id === id);
    if (idx < 0) return false;
    const task = this._tasks[idx];
    if (task.status === 'open') return true;
    const reopened: PromptTask = { ...task, status: 'open' };
    delete reopened.claimedAt;
    this._tasks[idx] = reopened;
    this._persist();
    this._publish();
    return true;
  }

  /** Drop a task entirely. */
  remove(id: string): boolean {
    const idx = this._tasks.findIndex((t) => t.id === id);
    if (idx < 0) return false;
    this._tasks.splice(idx, 1);
    this._persist();
    this._publish();
    return true;
  }

  /** Drop everything in the current key's queue. */
  clear(): void {
    this._tasks = [];
    this._persist();
    this._publish();
  }

  /** ISO timestamp of the last successful claim, or `null` — feeds the panel hint. */
  get lastClaimAt(): string | null { return this._lastClaimAt; }

  counts(): { open: number; claimed: number } {
    let open = 0;
    let claimed = 0;
    for (const t of this._tasks) { if (t.status === 'open') open++; else claimed++; }
    return { open, claimed };
  }

  /** Clear the panel notice after the user has seen it. */
  acknowledgeNotice(): void {
    if (this._notice === null) return;
    this._notice = null;
    this._publish();
  }

  // ─── Wire helpers (used by the MCP tools) ────────────────────────────

  /** `web_prompt_claim` — the JSON STRING, already in wire format (F5). */
  claimSerialized(): string {
    const result = this.claim();
    if (result.error) return serializeClaimError(result.error);
    if (!result.task) {
      const { open, claimed } = this.counts();
      return serializeClaimEmpty(open, claimed);
    }
    return serializeClaimHit(result.task);
  }

  /** `web_prompt_list` — the JSON STRING. Changes nothing. */
  listSerialized(includeClaimed: boolean): string {
    return serializeList(this.list({ includeClaimed }), this.counts());
  }

  // ─── React external store ────────────────────────────────────────────

  subscribe = (listener: () => void): (() => void) => {
    this._listeners.add(listener);
    return () => { this._listeners.delete(listener); };
  };

  getSnapshot = (): PromptTaskSnapshot => this._snapshot;

  /** Release the heartbeat timer and unload hook. */
  dispose(): void {
    if (this._timer !== null) { clearInterval(this._timer); this._timer = null; }
    const w = globalThis as unknown as { removeEventListener?: (t: string, h: () => void) => void };
    if (this._unloadHandler && typeof w.removeEventListener === 'function') {
      w.removeEventListener('pagehide', this._unloadHandler);
    }
    this._unloadHandler = null;
    this._listeners.clear();
  }

  private _oldestClaimedIndex(): number {
    let best = -1;
    let bestAt = '';
    for (let i = 0; i < this._tasks.length; i++) {
      const t = this._tasks[i];
      if (t.status !== 'claimed') continue;
      const at = t.claimedAt ?? t.createdAt;
      if (best < 0 || at < bestAt) { best = i; bestAt = at; }
    }
    return best;
  }

  private _publish(): void {
    const { open, claimed } = this.counts();
    this._snapshot = {
      tasks: [...this._tasks],
      open,
      claimed,
      lastClaimAt: this._lastClaimAt,
      persistError: this._persistError,
      notice: this._notice,
      volatile: this.isVolatile,
    };
    for (const listener of this._listeners) listener();
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────

function normalizeProjectKey(key: string | null): string {
  const s = String(key ?? '').trim();
  return s ? s.replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 60) : 'none';
}

function isPromptTask(value: unknown): value is PromptTask {
  const t = value as PromptTask | null;
  return !!t && typeof t.id === 'string' && typeof t.prompt === 'string'
    && (t.status === 'open' || t.status === 'claimed')
    && !!t.context && typeof t.context.targetPath === 'string';
}

function logNotice(message: string): void {
  // eslint-disable-next-line no-console
  console.info(`[rv][prompt-queue] ${message}`);
}

/** Can this storage be written at all? A `false` here selects volatile mode. */
function probeStorage(storage: PromptStorageLike): boolean {
  try {
    const probe = '__rv_prompt_probe__';
    storage.setItem(probe, '1');
    storage.removeItem(probe);
    return true;
  } catch { return false; }
}

/** `localStorage`, or `null` when it is unusable (private mode, disabled). */
function defaultLocal(): PromptStorageLike | null {
  try {
    const probe = '__rv_prompt_probe__';
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
    return localStorage;
  } catch { return null; }
}

function defaultSession(): PromptStorageLike | null {
  try {
    const probe = '__rv_prompt_probe__';
    sessionStorage.setItem(probe, '1');
    sessionStorage.removeItem(probe);
    return sessionStorage;
  } catch { return null; }
}

// ─── Singleton ──────────────────────────────────────────────────────────

let _singleton: PromptTaskStore | null = null;

/** The queue the UI and the MCP tools share. */
export function getPromptTaskStore(): PromptTaskStore {
  if (!_singleton) _singleton = new PromptTaskStore();
  return _singleton;
}

/** Test seam: replace (or drop, with `null`) the shared queue. */
export function _setPromptTaskStore(store: PromptTaskStore | null): void {
  _singleton = store;
}
