// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-feature-loader.ts — the one place a feature's code is activated (plan-652).
 *
 * A feature is a manifest key of `tier-manifest.json` (`asset-editor`, `des`, …).
 * Startup features are registered at boot exactly as before; the loader only
 * WATCHES them (`recordStartup`), so the console and `web_status.features` say
 * which feature cost how much. On-demand features are DECLARED by a small stub
 * (`define`) and their body is imported the first time a trigger asks for it
 * (`ensure`) — a mode switch, a component type in a model, a command.
 *
 * Every activation is visible: a `[feature]` console line, a
 * `performance.measure('rv:feature.<id>')`, a status row (DevTools, MCP), a
 * loading hint after 300 ms for a user-triggered load and a Problems entry
 * with a retry when it fails. The loader is React-free and knows no feature id.
 *
 * Hot path: an active feature answers synchronously (`isActive`,
 * `isModeReady`); `ensure` of an active feature resolves without any import.
 */

import type { RVViewer, PluginOrigin } from './rv-viewer';
import { memoizeAsync, type MemoizedAsync } from './rv-memoize-async';
import { FeatureLoadState, type FeatureState, type FeatureStatus, type FeatureTrigger } from './rv-feature-load-state';
import { reportProblem, clearProblem } from './hmi/problems-store';
import type { DeferredComponentHandler } from './engine/rv-component-types';

export type { FeatureState, FeatureStatus, FeatureTrigger } from './rv-feature-load-state';

/** The body of an on-demand feature — what its chunk exports. */
export interface FeatureBody {
  /** Idempotent: each step checks whether it is done already (retry after a partial failure). */
  activate(viewer: RVViewer): void | Promise<void>;
}

/** What a stub declares about an on-demand feature. */
export interface FeatureDefinition {
  /** == manifest key. */
  id: string;
  /** UI text of the loading hint ("Editor", "DES simulation"). */
  label: string;
  /** From the manifest; `mode:<id>` / `component:<type>` / `command:<id>`. */
  activation: FeatureTrigger[];
  /** Passed on to `viewer.use` by the body. */
  origin: PluginOrigin;
  /** `() => import('./X.body')` — the only reference to the body. */
  load: () => Promise<FeatureBody>;
}

/** UI seams of the loader — injectable so tests and the embed viewer run without the HMI. */
export interface FeatureLoaderHooks {
  showHint?(message: string): void;
  hideHint?(): void;
  /** Chunk bytes per feature id (from `feature-chunks.json`), when known. */
  bytesOf?(id: string): number | null;
}

/** Delay before the loading hint shows (ms) — a fast activation shows nothing. */
export const FEATURE_HINT_DELAY_MS = 300;
/** Minimum time the hint stays up once shown (ms) — no flash. */
export const FEATURE_HINT_MIN_MS = 400;
/** Problem code of a failed activation; the id is `feature-load-failed:<id>`. */
export const FEATURE_LOAD_FAILED = 'feature-load-failed';
/** Command id of the retry action the Problems entry offers. */
export const FEATURE_RETRY_COMMAND = 'feature.retry';
/** Command id of the reload action, offered when a retry cannot re-fetch the chunk. */
export const FEATURE_RELOAD_COMMAND = 'feature.reload';
/** Cache-bust retries offered before the Problems entry switches to Reload. */
export const FEATURE_MAX_RETRIES = 2;
/** Query parameter that makes a retried chunk URL a new module-map key. */
export const FEATURE_RETRY_QUERY = 'rv-retry';

const USER_TRIGGERS = (t: FeatureTrigger): boolean =>
  t.startsWith('mode:') || t.startsWith('command:');

interface Entry {
  def: FeatureDefinition;
  body: MemoizedAsync<FeatureBody>;
  activation: Promise<void> | null;
  /** URL of the chunk whose import failed — a retry re-imports it with a cache-bust query. */
  failedUrl: string | null;
  /** Retry counter (the cache-bust value). */
  retries: number;
  /** Failed imports of the body so far. */
  importFailures: number;
}

/**
 * The module URL a failed dynamic import names (Chromium: "Failed to fetch dynamically
 * imported module: <url>", Firefox: "error loading dynamically imported module: <url>").
 * Null when the engine does not say (Safari) — then only a reload helps.
 */
export function failedChunkUrl(error: unknown): string | null {
  const msg = error instanceof Error ? error.message : String(error ?? '');
  const m = /dynamically imported module:?\s+(\S+)/i.exec(msg);
  return m ? m[1] : null;
}

/** `url` with `rv-retry=<n>` appended — a fresh module-map key for the same file. */
export function withRetryQuery(url: string, n: number): string {
  const hash = url.indexOf('#');
  const base = hash >= 0 ? url.slice(0, hash) : url;
  const sep = base.includes('?') ? (/[?&]$/.test(base) ? '' : '&') : '?';
  return `${base}${sep}${FEATURE_RETRY_QUERY}=${n}`;
}

/** Native dynamic import of a computed URL (kept out of bundler analysis). */
const importUrl = (url: string): Promise<FeatureBody> =>
  import(/* @vite-ignore */ url) as Promise<FeatureBody>;

//! Activates features on demand and makes every activation visible.
export class FeatureLoader {
  private readonly _viewer: RVViewer | null;
  private readonly _hooks: FeatureLoaderHooks;
  private readonly _entries = new Map<string, Entry>();
  private readonly _state = new FeatureLoadState();
  /** Unregister functions of the mode enter guards a definition installed. */
  private readonly _guardOffs = new Map<string, Array<() => void>>();
  /** Activations started and not yet settled — see {@link hasActivationsInFlight}. */
  private _inFlight = 0;
  private _hintCount = 0;
  private _hintShownAt = 0;
  private _bootSummaryLogged = false;

  constructor(viewer: RVViewer | null, hooks: FeatureLoaderHooks = {}) {
    this._viewer = viewer;
    this._hooks = hooks;
  }

  // ── Declaration ──────────────────────────────────────────────────────

  //! Declares an on-demand feature (called by its stub). A second define replaces the first.
  define(def: FeatureDefinition): void {
    for (const off of this._guardOffs.get(def.id) ?? []) off();
    const entry: Entry = { def, body: null as unknown as MemoizedAsync<FeatureBody>, activation: null, failedUrl: null, retries: 0, importFailures: 0 };
    entry.body = memoizeAsync(() => this._importBody(entry));
    this._entries.set(def.id, entry);
    this._installModeGuards(def);
    const prev = this._state.get(def.id);
    this._state.patch(def.id, {
      label: def.label,
      activation: [...def.activation],
      state: prev?.state === 'active' ? 'active' : 'declared',
      bytes: this._bytes(def.id),
      origin: def.origin,
    });
  }

  //! True when a feature was declared on demand or recorded at startup.
  isDeclared(id: string): boolean {
    return this._entries.has(id) || this._state.get(id) !== undefined;
  }

  //! True when the feature's code is active. Synchronous — the fast path.
  isActive(id: string): boolean {
    return this._state.get(id)?.state === 'active';
  }

  // ── Activation ───────────────────────────────────────────────────────

  //! Loads and activates a declared feature; parallel calls share one load, a failure is not cached.
  ensure(id: string, trigger: FeatureTrigger): Promise<void> {
    if (this.isActive(id)) return Promise.resolve();
    const entry = this._entries.get(id);
    if (!entry) {
      return Promise.reject(new Error(`[feature] unknown feature "${id}"`));
    }
    if (entry.activation) return entry.activation;
    // plan-673: counted BEFORE `_activate` is called, not after it returns.
    // `_activate` is an async method, so its prologue — including the
    // `state: 'loading'` patch that notifies every status subscriber — runs
    // SYNCHRONOUSLY inside this call. A subscriber that answered
    // `hasActivationsInFlight()` from `entry.activation` would therefore be
    // told "nothing is loading" by the very notification that says one is,
    // and an operator panel waiting for this feature's signals gave up right
    // there (measured as a failing test, not reasoned about).
    this._inFlight++;
    const settle = (): void => {
      entry.activation = null;
      this._inFlight--;
      // And SAY so. `_activate` publishes its final `active` / `failed` patch
      // while this activation still counts as in flight (we are a `then`
      // callback of it), so without this second, field-less patch the moment
      // "nothing is loading any more" would never be announced — and a waiting
      // consumer would wait for ever instead of passing its verdict.
      if (this._inFlight === 0) this._state.patch(entry.def.id, {});
    };
    const run = this._activate(entry, trigger);
    entry.activation = run;
    run.then(settle, settle);
    return run;
  }

  //! Ensures every feature that declares `mode:<mode>`; no-op when none does.
  async ensureForMode(mode: string): Promise<void> {
    const trigger = `mode:${mode}` as FeatureTrigger;
    const ids = this._idsFor(trigger);
    for (const id of ids) await this.ensure(id, trigger);
  }

  //! Synchronous: true when no feature is needed for the mode or all of them are active.
  isModeReady(mode: string): boolean {
    return this._idsFor(`mode:${mode}` as FeatureTrigger).every((id) => this.isActive(id));
  }

  //! Ensures every feature that declares `component:<type>` for one of the given types.
  async ensureForComponentTypes(types: Iterable<string>): Promise<void> {
    const wanted = new Map<string, FeatureTrigger>();
    for (const type of types) {
      const trigger = `component:${type}` as FeatureTrigger;
      for (const id of this._idsFor(trigger)) if (!wanted.has(id)) wanted.set(id, trigger);
    }
    for (const [id, trigger] of wanted) await this.ensure(id, trigger);
  }

  //! The declared, NOT active feature a component type activates, or null (synchronous).
  pendingFeatureForComponentType(type: string): string | null {
    const trigger = `component:${type}` as FeatureTrigger;
    for (const [id, entry] of this._entries) {
      if (entry.def.activation.includes(trigger) && !this.isActive(id)) return id;
    }
    return null;
  }

  //! The `component:<type>` trigger types of declared, NOT active features (the prescan's filter).
  pendingComponentTriggerTypes(): Set<string> {
    const types = new Set<string>();
    for (const [id, entry] of this._entries) {
      if (this.isActive(id)) continue;
      for (const t of entry.def.activation) if (t.startsWith('component:')) types.add(t.slice('component:'.length));
    }
    return types;
  }

  /**
   * True while at least one feature activation is IN FLIGHT (plan-673).
   *
   * Not "something is still declared": `declared` is the resting state of every
   * on-demand feature this build knows and would never clear. This is the
   * narrower fact — somebody called {@link ensure} and the chunk, or the
   * `activate()` behind it, has not settled yet — which is what a consumer
   * needs that must distinguish "the thing I am waiting for is still coming"
   * from "it is never coming". Changes are announced through {@link subscribe}
   * (the status row moves `loading` → `active` / `failed`).
   */
  hasActivationsInFlight(): boolean {
    return this._inFlight > 0;
  }

  //! True while at least one declared feature with a `component:` trigger is not active.
  hasPendingComponentFeatures(): boolean {
    for (const [id, entry] of this._entries) {
      if (!this.isActive(id) && entry.def.activation.some((t) => t.startsWith('component:'))) return true;
    }
    return false;
  }

  /**
   * The safety net of the synchronous build entries (plan-652 §2.4.3 #3): a type of a
   * declared, inactive feature starts its activation and warns once per type; with a
   * `retry` the component is built after the activation, without one a Problems entry
   * says the component appears with the next build.
   */
  deferredComponentHandler(): DeferredComponentHandler {
    const warned = new Set<string>();
    return {
      anyDeferred: () => this.hasPendingComponentFeatures(),
      isDeferred: (type) => this.pendingFeatureForComponentType(type) !== null,
      defer: (type, where, retry) => {
        const id = this.pendingFeatureForComponentType(type);
        if (!id) return;
        if (!warned.has(type)) {
          warned.add(type);
          console.warn(`[feature] ${type} needs ${id} — activate before construction (${where})`);
          if (!retry) {
            reportProblem({
              id: `feature-late-component:${type}`,
              severity: 'warning',
              code: 'feature-late-component',
              title: `${type} built before ${this._entries.get(id)?.def.label ?? id} was loaded`,
              detail: `A ${type} component was added while the feature "${id}" was not active yet (${where}). `
                + 'The feature is loading now; the component appears with the next load of this model.',
            });
          }
        }
        this.ensure(id, `component:${type}` as FeatureTrigger).then(
          () => { if (retry) retry(); },
          () => { /* ensure() reported the failure */ },
        );
      },
    };
  }

  //! Imports a feature's body without activating it (intent prefetch). A failure resets the cache.
  preload(id: string): void {
    const entry = this._entries.get(id);
    if (!entry || this.isActive(id)) return;
    entry.body().catch(() => { /* memoizeAsync already forgot it; ensure() reports */ });
  }

  //! Watches one eager startup registration: times it and publishes it as an active feature.
  async recordStartup(id: string, run: () => Promise<void>): Promise<void> {
    const startedAt = now();
    this._state.patch(id, { state: 'loading', trigger: 'startup', startedAt, activation: ['startup'] });
    try {
      await run();
    } catch (error) {
      const ms = round(now() - startedAt);
      this._state.patch(id, { state: 'failed', ms, error: messageOf(error) });
      throw error;
    }
    const ms = round(now() - startedAt);
    // An on-demand feature's adapter is only its STUB: it declared the feature
    // (define) and loaded none of its body. It stays `declared` until a trigger
    // activates it — marking it active here would skip that load for good.
    const entry = this._entries.get(id);
    if (entry) {
      if (this._state.get(id)?.state !== 'active') {
        this._state.patch(id, { state: 'declared', trigger: undefined, startedAt: undefined, ms: undefined });
      }
      console.debug(`[feature] ${id} declared on demand (${entry.def.activation.join(', ')}) · stub ${ms} ms`);
      return;
    }
    this._measure(id, startedAt);
    this._state.patch(id, { state: 'active', ms, bytes: this._bytes(id) });
    console.debug(`[feature] ${id} ← startup · ${ms} ms`);
  }

  //! Logs one `[boot] features: …` line — once per loader.
  logBootSummary(): void {
    if (this._bootSummaryLogged) return;
    this._bootSummaryLogged = true;
    const rows = this._state.snapshot();
    const startup = rows.filter((r) => r.trigger === 'startup');
    const deferred = rows.filter((r) => r.state === 'declared');
    const total = startup.reduce((sum, r) => sum + (r.ms ?? 0), 0);
    const top = [...startup].sort((a, b) => (b.ms ?? 0) - (a.ms ?? 0)).slice(0, 3)
      .map((r) => `${r.id} ${r.ms} ms`).join(', ');
    console.info(`[boot] features: startup ${startup.length} (${round(total)} ms${top ? `; ${top}` : ''}) · deferred ${deferred.length}`);
  }

  // ── Status ───────────────────────────────────────────────────────────

  //! All feature rows, in declaration order; identity stable until the next change.
  statuses(): readonly FeatureStatus[] {
    return this._state.snapshot();
  }

  //! Subscribes to status changes; returns the unsubscribe function.
  subscribe(cb: () => void): () => void {
    return this._state.subscribe(cb);
  }

  // ── Internals ────────────────────────────────────────────────────────

  /**
   * One ModeManager enter guard per `mode:<id>` trigger (plan-652 section 2.4.4): synchronous
   * `true` once the mode's features are active, else it loads them and lets the switch
   * through on success. A failed load answers `false` - the old mode stays; `ensure`
   * already reported the failure (Problems entry with retry).
   */
  private _installModeGuards(def: FeatureDefinition): void {
    const modes = this._viewer?.modes as
      | { registerEnterGuard?: (mode: string, guard: () => boolean | Promise<boolean>) => () => void }
      | undefined;
    if (!modes || typeof modes.registerEnterGuard !== 'function') return;
    const offs: Array<() => void> = [];
    for (const trigger of def.activation) {
      if (!trigger.startsWith('mode:')) continue;
      const mode = trigger.slice('mode:'.length);
      offs.push(modes.registerEnterGuard(mode, () =>
        this.isModeReady(mode) ? true : this.ensureForMode(mode).then(() => true, () => false)));
    }
    this._guardOffs.set(def.id, offs);
  }

  private _idsFor(trigger: FeatureTrigger): string[] {
    const ids: string[] = [];
    for (const [id, entry] of this._entries) {
      if (entry.def.activation.includes(trigger)) ids.push(id);
    }
    return ids;
  }

  /**
   * Imports the body. The browser keeps a failed `import()` in its module map for the
   * page's lifetime, so re-running `def.load` after a failure fails again without a
   * request. After a failure the URL from the error is re-imported with a cache-bust
   * query: a new module-map key, the same file (dev server and production build alike;
   * the body's own static imports keep their URLs and stay shared).
   */
  private async _importBody(entry: Entry): Promise<FeatureBody> {
    try {
      if (entry.failedUrl) {
        entry.retries++;
        return await importUrl(withRetryQuery(entry.failedUrl, entry.retries));
      }
      return await entry.def.load();
    } catch (error) {
      entry.importFailures++;
      if (!entry.failedUrl) entry.failedUrl = failedChunkUrl(error);
      throw error;
    }
  }

  private async _activate(entry: Entry, trigger: FeatureTrigger): Promise<void> {
    const { id, label } = entry.def;
    const startedAt = now();
    this._state.patch(id, { state: 'loading', trigger, startedAt, error: undefined });
    const hintTimer = USER_TRIGGERS(trigger) ? setTimeout(() => this._showHint(label), FEATURE_HINT_DELAY_MS) : null;
    try {
      const body = await entry.body();
      if (!this._viewer) throw new Error('FeatureLoader has no viewer to activate into');
      await body.activate(this._viewer);
    } catch (error) {
      const ms = round(now() - startedAt);
      // A rejected import is already forgotten by memoizeAsync; a throwing activate()
      // keeps the module (its steps are idempotent, a retry continues).
      this._state.patch(id, { state: 'failed', ms, error: messageOf(error) });
      // Retry re-imports (with a cache-bust query when the error named the chunk URL) and
      // is offered for the first FEATURE_MAX_RETRIES failed imports; a throwing activate()
      // keeps the module and can always retry. After that — e.g. a failed STATIC
      // dependency of the chunk, which stays failed in the module map — only Reload helps.
      const canRetry = entry.body.pending || entry.importFailures <= FEATURE_MAX_RETRIES;
      console.error(`[feature] ${id} ← ${trigger} failed after ${ms} ms:`, error);
      reportProblem({
        id: `${FEATURE_LOAD_FAILED}:${id}`,
        severity: 'error',
        code: FEATURE_LOAD_FAILED,
        title: `Could not load ${label}`,
        detail: `Loading the feature "${id}" (${trigger}) failed: ${messageOf(error) || 'unknown error'}. `
          + (canRetry ? 'Retry, or reload the page if a new version was deployed.' : 'Reload the page — your work is kept by the autosave.'),
        action: canRetry
          ? { label: 'Retry', commandId: FEATURE_RETRY_COMMAND, args: { id } }
          : { label: 'Reload', commandId: FEATURE_RELOAD_COMMAND, args: {} },
      });
      throw error;
    } finally {
      if (hintTimer !== null) clearTimeout(hintTimer);
      this._hideHint();
    }
    const ms = round(now() - startedAt);
    const bytes = this._bytes(id);
    this._measure(id, startedAt);
    this._state.patch(id, { state: 'active', ms, bytes });
    clearProblem(`${FEATURE_LOAD_FAILED}:${id}`);
    console.info(`[feature] ${id} ← ${trigger} · ${ms} ms${bytes != null ? ` · ${Math.round(bytes / 1024)} KB` : ''}`);
  }

  private _measure(id: string, startedAt: number): void {
    try {
      performance.measure(`rv:feature.${id}`, { start: startedAt, end: now() });
    } catch { /* measure is diagnostics only */ }
  }

  private _bytes(id: string): number | null {
    try { return this._hooks.bytesOf?.(id) ?? null; } catch { return null; }
  }

  private _showHint(label: string): void {
    this._hintCount++;
    if (this._hintCount === 1) this._hintShownAt = now();
    try { this._hooks.showHint?.(`Loading ${label} …`); } catch { /* UI only */ }
  }

  private _hideHint(): void {
    if (this._hintCount === 0) return;
    this._hintCount--;
    if (this._hintCount > 0) return;
    const left = FEATURE_HINT_MIN_MS - (now() - this._hintShownAt);
    const hide = (): void => {
      if (this._hintCount > 0) return;
      try { this._hooks.hideHint?.(); } catch { /* UI only */ }
    };
    if (left > 0) setTimeout(hide, left); else hide();
  }
}

/** Compile-time guard for the state union (keeps the import used in emitted d.ts). */
export const FEATURE_STATES: readonly FeatureState[] = ['declared', 'loading', 'active', 'failed'];

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function round(ms: number): number {
  return Math.round(ms * 10) / 10;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Activates `id` when this build declares it and it is not active yet; resolves at once
 * otherwise (plan-652 section 2.4.5). For callers that need a feature's plugin next -
 * importers, MCP tools - without knowing whether the build ships the feature (community
 * edition, restricted customer profile) or whether it is lazy at all. A failed activation
 * rejects (the loader already reported it).
 */
export function ensureFeatureIfDeclared(
  viewer: { features?: Pick<FeatureLoader, 'isDeclared' | 'isActive' | 'ensure'> } | null | undefined,
  id: string,
  trigger: FeatureTrigger,
): Promise<void> {
  const loader = viewer?.features;
  if (!loader || typeof loader.isDeclared !== 'function') return Promise.resolve();
  if (!loader.isDeclared(id) || loader.isActive(id)) return Promise.resolve();
  return loader.ensure(id, trigger);
}

// ── Build table (dist/feature-chunks.json) ─────────────────────────────

/** One row of `feature-chunks.json`, written by `scripts/gen-feature-chunks.mjs`. */
export interface FeatureChunkRow {
  files: string[];
  bytes: number;
}

let _chunkTable: Record<string, FeatureChunkRow> | null = null;
let _chunkTablePromise: Promise<Record<string, FeatureChunkRow> | null> | null = null;

//! Fetches `feature-chunks.json` next to the page once; resolves null when the build has none (dev server).
export function loadFeatureChunks(url = 'feature-chunks.json'): Promise<Record<string, FeatureChunkRow> | null> {
  if (!_chunkTablePromise) {
    _chunkTablePromise = (typeof fetch === 'function' ? fetch(url, { cache: 'no-cache' }) : Promise.reject(new Error('no fetch')))
      .then((r) => (r.ok ? r.json() as Promise<Record<string, FeatureChunkRow>> : null))
      .then((table) => { _chunkTable = table && typeof table === 'object' ? table : null; return _chunkTable; })
      .catch(() => null);
  }
  return _chunkTablePromise;
}

//! Synchronous byte lookup from the loaded table; null before it loaded or for unknown ids.
export function featureChunkBytes(id: string): number | null {
  const row = _chunkTable?.[id];
  return row && typeof row.bytes === 'number' ? row.bytes : null;
}

//! The chunk files of one feature (for prefetch), empty when unknown.
export function featureChunkFiles(id: string): readonly string[] {
  return _chunkTable?.[id]?.files ?? [];
}

/** Test seam: set (or with null clear) the chunk table. */
export function setFeatureChunksForTests(table: Record<string, FeatureChunkRow> | null): void {
  _chunkTable = table;
  _chunkTablePromise = table ? Promise.resolve(table) : null;
}

// ── Retry command (Problems panel action) ──────────────────────────────

//! Registers the `feature.retry` / `feature.reload` commands the `feature-load-failed` problem offers. Idempotent per registry.
export function registerFeatureRetryCommand(
  registry: { register(desc: unknown): () => void; get(id: string): unknown },
): void {
  if (!registry.get(FEATURE_RETRY_COMMAND)) registerRetry(registry);
  if (!registry.get(FEATURE_RELOAD_COMMAND)) registerReload(registry);
}

function registerRetry(registry: { register(desc: unknown): () => void }): void {
  const impl = {
    enabled: (ctx: { viewer: RVViewer }, args: { id?: string }) =>
      (args?.id && ctx.viewer.features?.isDeclared(args.id)) ? true as const : { reason: `Unknown feature "${String(args?.id)}"` },
    run: async (ctx: { viewer: RVViewer }, args: { id: string }) => {
      const loader = ctx.viewer.features;
      const last = loader.statuses().find((s) => s.id === args.id)?.trigger;
      await loader.ensure(args.id, last && last !== 'startup' ? last : 'command:feature.retry');
      return { id: args.id, state: loader.statuses().find((s) => s.id === args.id)?.state ?? 'declared' };
    },
  };
  registry.register({
    id: FEATURE_RETRY_COMMAND,
    label: 'Retry loading feature',
    readOnly: true,
    scope: 'none',
    available: true,
    unavailableReason: '',
    argsSchema: { id: 'string' },
    impl: () => Promise.resolve(impl),
    eagerImpl: impl,
  });
}

function registerReload(registry: { register(desc: unknown): () => void }): void {
  // Reload is the fallback when a chunk cannot be re-imported in this page. The draft
  // autosave carries the document across it; the beforeunload guard (main.ts) still asks
  // when work is not persisted yet.
  const reload = {
    enabled: () => true as const,
    run: async () => {
      if (typeof location !== 'undefined') location.reload();
      return { reloaded: true };
    },
  };
  registry.register({
    id: FEATURE_RELOAD_COMMAND,
    label: 'Reload page',
    readOnly: true,
    scope: 'none',
    available: true,
    unavailableReason: '',
    argsSchema: {},
    impl: () => Promise.resolve(reload),
    eagerImpl: reload,
  });
}

// ── Stale-deploy chunk errors (vite:preloadError) ──────────────────────

/** Problem id of a chunk that a newer deploy removed. */
export const FEATURE_STALE_BUILD_PROBLEM = 'feature-stale-build';

let _preloadHandlerInstalled = false;

//! Handles `vite:preloadError` centrally: no uncaught rejection, no auto-reload, one Problems entry.
//! Reloading is left to the user on purpose — an unsaved editor document must never be thrown away.
export function installPreloadErrorHandler(target: Pick<Window, 'addEventListener'> | undefined = typeof window !== 'undefined' ? window : undefined): void {
  if (_preloadHandlerInstalled || !target) return;
  _preloadHandlerInstalled = true;
  target.addEventListener('vite:preloadError', ((event: Event & { payload?: unknown }) => {
    // The import()'s own rejection still reaches its caller (FeatureLoader.ensure → failed +
    // retry); preventDefault only stops Vite from re-throwing it as an unhandled error.
    event.preventDefault();
    const payload = event.payload;
    const detail = payload instanceof Error ? payload.message : String(payload ?? 'chunk could not be loaded');
    console.warn('[feature] a code chunk could not be loaded — probably a newer version was deployed:', payload);
    reportProblem({
      id: FEATURE_STALE_BUILD_PROBLEM,
      severity: 'warning',
      code: FEATURE_STALE_BUILD_PROBLEM,
      title: 'New version available — reload',
      detail: `A part of the application could not be loaded (${detail}). A newer version was probably deployed. `
        + 'Save your work, then reload the page.',
    });
  }) as EventListener);
}
