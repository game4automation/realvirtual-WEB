// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-aas-source.ts — where AASX files come from (plan-596 Phase 2).
 *
 * The AAS chain used to know exactly one kind of location: a URL `basePath`,
 * computed three different ways by the plugin, the resolution pass and the
 * layout planner. A project folder mounted through the File System Access API
 * has no URL, so a Projekt-AASX in `<project>/aasx/` could never be found.
 *
 * An {@link AasSource} answers the two questions every AAS surface asks —
 * "which AAS ids exist, in which file?" ({@link AasSource.readIndex}) and "give
 * me that file" ({@link AasSource.openPackage}) — independent of the medium:
 *
 *  - {@link UrlAasSource} — a deployed `aasx/` directory (the deploy-wide
 *    `public/aasx`, or an explicit per-model `assetsBasePath`). Bytes go through
 *    the hosted-deploy decrypt seam; an unencrypted deploy opens archives with
 *    HTTP range reads.
 *  - {@link ProjectAasSource} — the open project's `aasx/` folder, read through
 *    its `ProjectBackend` (folder: lazy `File`, ranged; bundled: decrypted by the
 *    backend; browser: OPFS). The project index scan feeds it.
 *  - {@link MergedAasSource} — project over deploy: the project wins per AAS id,
 *    the deploy-wide index stays the fallback for ids the project does not know
 *    (the SEW demo motors keep working inside a customer project).
 *
 * {@link getActiveAasSource} is the ONE place that decides which sources are
 * active; plugin, resolution, order manager, layout planner and PDF viewer all
 * ask it instead of computing a base path of their own.
 *
 * ## Revisions and invalidation
 *
 * Every source carries a `revision` that rises whenever its index changes (a
 * scan wrote `aasx/index.json`, an import added a file). Index results are
 * cached per source until {@link invalidateAasSource}; listeners registered with
 * {@link subscribeAasSources} hear about every change so the resolution pass and
 * the plugin can recompute, and drop results computed against an older revision.
 *
 * ## Open packages
 *
 * Archives are opened on demand only, at most {@link MAX_CONCURRENT_OPENS} at a
 * time, and at most {@link MAX_OPEN_PACKAGES} stay open (LRU). Evicting a package
 * closes its reader and revokes the object URLs handed out for its entries;
 * switching project releases every package of the previous project.
 */

import { getProjectStore } from '../project/project-store';
import type { ProjectBackend } from '../project/backends/project-backend';
import { resolveAssetsBase } from '../project/rv-project-assets-base';
import { decryptServedBytes, isEncryptedDeploy } from '../persistence/rv-served-bytes';
import type { AasxInput, AasxPackage } from './rv-aasx-package';

/** The package reader, loaded on the first archive open (off the entry chunk). */
async function openAasxPackage(input: AasxInput): Promise<AasxPackage> {
  const { openAasxPackage: open } = await import('./rv-aasx-package');
  return open(input);
}

// ─── Index types ────────────────────────────────────────────────────────

/** Index entry mapping an AAS id to its file. */
export interface AasIndexEntry {
  /** Relative to the `aasx/` directory, '/'-separated. */
  file: string;
  idShort: string;
  /** Marks the AASX as a community/demo asset that has not been validated by the supplier. */
  demoOnly?: boolean;
  /** Optional override for the warning banner text. */
  demoNote?: string;
  /** Nameplate ManufacturerProductDesignation (en > de > first). */
  productName?: string;
  /** Nameplate ManufacturerName. */
  manufacturer?: string;
  globalAssetId?: string;
}

/**
 * Discriminated outcome of loading an index — "not shipped" (`missing`) is
 * kept apart from "broken" (`error`) so the viewer can hide AAS surfaces in
 * the first case and keep a visible error in the second.
 */
export type AasIndexResult =
  | { kind: 'available'; index: Record<string, AasIndexEntry> }
  | { kind: 'missing' }
  | { kind: 'error'; reason: string };

/** Per-file record of the project index (stat signature + what it held). */
export interface AasProjectIndexFileRecord {
  size: number;
  lastModified: number;
  aasIds: string[];
  error?: string;
  /**
   * The shells of this file with their index metadata. Kept per FILE (not only
   * per chosen entry) so an unchanged file — also the losing side of a
   * duplicate — never has to be parsed again to rebuild the entries.
   */
  shells?: Array<Omit<AasIndexEntry, 'file'> & { id: string }>;
}

/** `<project>/aasx/index.json` as the viewer writes it. */
export interface AasProjectIndexFile {
  version: 1;
  generator: 'realvirtual-web';
  /** AAS id → entry of the chosen file. */
  entries: Record<string, AasIndexEntry>;
  files: Record<string, AasProjectIndexFileRecord>;
  /** AAS id → every file that carries it (only for ids found more than once). */
  duplicates?: Record<string, string[]>;
}

/** Project-relative path of the project index. */
export const PROJECT_AASX_DIR = 'aasx';
export const PROJECT_AASX_INDEX = `${PROJECT_AASX_DIR}/index.json`;

/**
 * Read either index shape: the flat deploy-wide `Record<id, entry>` or the
 * project format (`version: 1`). Entries without a string `file` are dropped.
 * Returns null for something that is not an object at all.
 */
export function readIndexJson(raw: unknown): { entries: Record<string, AasIndexEntry>; file?: AasProjectIndexFile } | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const isProjectFormat = obj.version === 1 && obj.entries && typeof obj.entries === 'object' && !Array.isArray(obj.entries);
  const source = (isProjectFormat ? obj.entries : obj) as Record<string, unknown>;
  const entries: Record<string, AasIndexEntry> = {};
  for (const [id, value] of Object.entries(source)) {
    const e = value as AasIndexEntry | null;
    if (e && typeof e === 'object' && typeof e.file === 'string' && e.file) {
      entries[id] = e;
    }
  }
  if (!isProjectFormat) return { entries };
  const files = (obj.files && typeof obj.files === 'object' && !Array.isArray(obj.files)
    ? obj.files : {}) as Record<string, AasProjectIndexFileRecord>;
  const duplicates = (obj.duplicates && typeof obj.duplicates === 'object' && !Array.isArray(obj.duplicates)
    ? obj.duplicates : undefined) as Record<string, string[]> | undefined;
  return {
    entries,
    file: { version: 1, generator: 'realvirtual-web', entries, files, ...(duplicates ? { duplicates } : {}) },
  };
}

function parseIndexText(text: string): AasIndexResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (e) {
    return { kind: 'error', reason: e instanceof Error ? e.message : String(e) };
  }
  const read = readIndexJson(raw);
  if (!read) return { kind: 'error', reason: 'aasx/index.json is not an object' };
  return { kind: 'available', index: read.entries };
}

// ─── Source contract ────────────────────────────────────────────────────

export interface AasSource {
  /** `'project:<projectId>'` | `'url:<dir>'` | `'merged:…'`. */
  readonly key: string;
  /** Rises with every index change of this source. */
  readonly revision: number;
  /** The index; cached until {@link invalidate}. */
  readIndex(): Promise<AasIndexResult>;
  /** Open one archive of this source (`file` relative to its `aasx/`). */
  openPackage(file: string): Promise<AasxPackage>;
  /** Drop the cached index and bump the revision. */
  invalidate(): void;
}

/** An AAS id together with the source whose archive holds it (SOL #4). */
export interface AasLookup {
  source: AasSource;
  entry: AasIndexEntry;
}

// ─── Change notification ────────────────────────────────────────────────

const _listeners = new Set<() => void>();
let _version = 0;

/** Subscribe to "some AAS source changed its index" (useSyncExternalStore-compatible). */
export function subscribeAasSources(listener: () => void): () => void {
  _listeners.add(listener);
  return () => { _listeners.delete(listener); };
}

/** Monotonic counter bumped on every source change. */
export function getAasSourcesVersion(): number {
  return _version;
}

function notifySources(): void {
  _version++;
  for (const l of [..._listeners]) {
    try { l(); } catch (e) { console.warn('[aas-source] listener failed', e); }
  }
}

// ─── Registry ───────────────────────────────────────────────────────────

const _registry = new Map<string, AasSource>();

/** The live source registered under `key`, if any. */
export function getAasSourceByKey(key: string): AasSource | undefined {
  return _registry.get(key);
}

/**
 * Invalidate a source: its cached index is dropped, its revision rises, its
 * open packages are released and every listener is told.
 */
export function invalidateAasSource(key: string): void {
  const src = _registry.get(key);
  if (!src) return;
  src.invalidate();
  releaseAasPackages(key);
  notifySources();
}

// ─── URL source ─────────────────────────────────────────────────────────

const INDEX_TIMEOUT_MS = 10_000;
/** Timeout of a retried index read: a cold first load may still saturate the line. */
const INDEX_RETRY_TIMEOUT_MS = 30_000;
/** Backoff before the one automatic retry after a failed index read. */
export const INDEX_RETRY_DELAY_MS = 3_000;
const PACKAGE_TIMEOUT_MS = 60_000;

/** The `aasx/` directory under an assets root (the legacy `basePath`). */
export function aasxDirForAssetsRoot(assetsRoot?: string): string {
  const root = assetsRoot ?? `${import.meta.env.BASE_URL}`;
  return `${root.endsWith('/') ? root : `${root}/`}aasx/`;
}

function timeoutSignal(ms: number): AbortSignal | undefined {
  return typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(ms) : undefined;
}

/**
 * Index caching shared by the URL and the project source: only a SUCCESSFUL
 * read ('available' / 'missing') is cached. A failed read ('error': timeout,
 * network, 5xx, broken JSON) is dropped, so the next `readIndex()` fetches
 * again, and ONE automatic retry is scheduled after {@link INDEX_RETRY_DELAY_MS}:
 * it bumps the revision and notifies, which re-runs the resolution pass (whose
 * read then uses the longer {@link INDEX_RETRY_TIMEOUT_MS}). Without it a cold
 * first load whose 10 s index timeout expired kept every AAS link on
 * `index-error` for the whole session.
 */
abstract class CachedIndexSource {
  abstract readonly key: string;
  protected _revision = 0;
  protected _index: Promise<AasIndexResult> | null = null;
  private _failures = 0;
  private _autoRetried = false;
  private _retryTimer: ReturnType<typeof setTimeout> | null = null;

  get revision(): number { return this._revision; }

  /** The cached index, or a fresh read via `load(timeoutMs)`, cached unless it failed. */
  protected cachedIndex(load: (timeoutMs: number) => Promise<AasIndexResult>): Promise<AasIndexResult> {
    if (this._index) return this._index;
    const p = load(this._failures > 0 ? INDEX_RETRY_TIMEOUT_MS : INDEX_TIMEOUT_MS);
    this._index = p;
    // Registered before any caller's continuation, so the cache is cleared first.
    void p.then((r) => {
      if (r.kind !== 'error') {
        this._failures = 0;
        this._autoRetried = false;
        return;
      }
      if (this._index === p) this._index = null;
      this._failures++;
      if (this._autoRetried || this._retryTimer !== null) return;
      this._autoRetried = true;
      this._retryTimer = setTimeout(() => {
        this._retryTimer = null;
        // Already re-read meanwhile, or the source was replaced: nothing to do.
        if (this._index !== null || _registry.get(this.key) !== (this as unknown)) return;
        this._revision++;
        notifySources();
      }, INDEX_RETRY_DELAY_MS);
    });
    return p;
  }

  /** Cancel a scheduled automatic retry. */
  protected cancelIndexRetry(): void {
    if (this._retryTimer !== null) clearTimeout(this._retryTimer);
    this._retryTimer = null;
  }
}

/** A deployed `aasx/` directory reached over HTTP. */
export class UrlAasSource extends CachedIndexSource implements AasSource {
  readonly key: string;

  constructor(readonly dir: string, readonly rangeReads = false) {
    super();
    this.key = `url:${dir}`;
  }

  readIndex(): Promise<AasIndexResult> {
    return this.cachedIndex((timeoutMs) => this._fetchIndex(timeoutMs));
  }

  private _fetchIndex(timeoutMs: number): Promise<AasIndexResult> {
    const url = `${this.dir}index.json`;
    return fetch(url, { signal: timeoutSignal(timeoutMs) })
      .then(async (r): Promise<AasIndexResult> => {
        if (r.status === 404) return { kind: 'missing' };
        if (!r.ok) return { kind: 'error', reason: `HTTP ${r.status}` };
        // SPA history fallback: a missing file comes back as index.html with 200.
        const contentType = r.headers?.get?.('content-type') ?? '';
        if (/text\/html/i.test(contentType)) return { kind: 'missing' };
        try {
          // Through the decrypt seam: a hosted deploy may publish the index as an envelope.
          const bytes = await decryptServedBytes(await r.arrayBuffer(), url);
          return parseIndexText(new TextDecoder().decode(bytes));
        } catch (e) {
          return { kind: 'error', reason: e instanceof Error ? e.message : String(e) };
        }
      })
      .catch((e): AasIndexResult => ({ kind: 'error', reason: e instanceof Error ? e.message : String(e) }));
  }

  async openPackage(file: string): Promise<AasxPackage> {
    const url = `${this.dir}${file}`;
    const fetchBytes = async (u: string): Promise<ArrayBuffer> => {
      const r = await fetch(u, { signal: timeoutSignal(PACKAGE_TIMEOUT_MS) });
      if (!r.ok) throw new Error(`Failed to load ${file}: ${r.status}`);
      return decryptServedBytes(await r.arrayBuffer(), u);
    };
    if (this.rangeReads) {
      try {
        return await openAasxPackage({ url, rangeReads: true });
      } catch {
        // Host without range support (or an envelope after all): read it whole.
      }
    }
    return openAasxPackage({ url, rangeReads: false, fetchBytes });
  }

  invalidate(): void {
    this.cancelIndexRetry();
    this._index = null;
    this._revision++;
  }
}

/** The shared URL source for an `aasx/` directory (one per directory). */
export function urlAasSourceFor(dir: string, opts: { rangeReads?: boolean } = {}): UrlAasSource {
  const key = `url:${dir}`;
  const existing = _registry.get(key) as UrlAasSource | undefined;
  const rangeReads = opts.rangeReads ?? false;
  if (existing && existing.rangeReads === rangeReads) return existing;
  const src = new UrlAasSource(dir, rangeReads);
  if (existing) {
    // Keep the cached index; only the read mode changed.
    (src as unknown as { _index: unknown })._index = (existing as unknown as { _index: unknown })._index;
  }
  _registry.set(key, src);
  return src;
}

// ─── Project source ─────────────────────────────────────────────────────

/** The parts of a backend a project source reads. */
export type AasProjectBackend = Pick<ProjectBackend, 'kind' | 'id' | 'readDocumentUrl'>
  & Partial<Pick<ProjectBackend, 'readDocumentBlob' | 'listAllFiles' | 'writeDocument' | 'writable' | 'isActive'>>;

async function backendBlob(backend: AasProjectBackend, path: string): Promise<{ blob: Blob } | { url: string; release: () => void } | null> {
  if (backend.readDocumentBlob) {
    const blob = await backend.readDocumentBlob(path).catch(() => null);
    if (blob) return { blob };
  }
  const resolved = await backend.readDocumentUrl(path).catch(() => null);
  return resolved ? { url: resolved.url, release: () => resolved.release() } : null;
}

/** The open project's `aasx/` folder, read through its backend. */
export class ProjectAasSource extends CachedIndexSource implements AasSource {
  readonly key: string;
  private _file: AasProjectIndexFile | null = null;

  constructor(readonly backend: AasProjectBackend, readonly projectId: string) {
    super();
    this.key = `project:${projectId}`;
  }

  /** The project-format index as last read or scanned (null for the flat format / none). */
  get indexFile(): AasProjectIndexFile | null { return this._file; }

  readIndex(): Promise<AasIndexResult> {
    return this.cachedIndex((timeoutMs) => this._readStoredIndex(timeoutMs));
  }

  /**
   * Install an index the scan built (in memory — also for a read-only folder
   * whose index cannot be written). Bumps the revision; callers notify.
   */
  setScannedIndex(file: AasProjectIndexFile): void {
    this.cancelIndexRetry();
    this._file = file;
    this._index = Promise.resolve({ kind: 'available', index: file.entries });
    this._revision++;
  }

  private async _readStoredIndex(timeoutMs: number): Promise<AasIndexResult> {
    try {
      const got = await backendBlob(this.backend, PROJECT_AASX_INDEX);
      if (!got) return { kind: 'missing' };
      let text: string;
      if ('blob' in got) {
        text = await got.blob.text();
      } else {
        try {
          const r = await fetch(got.url, { signal: timeoutSignal(timeoutMs) });
          if (r.status === 404) return { kind: 'missing' };
          if (!r.ok) return { kind: 'error', reason: `HTTP ${r.status}` };
          if (/text\/html/i.test(r.headers?.get?.('content-type') ?? '')) return { kind: 'missing' };
          text = new TextDecoder().decode(await decryptServedBytes(await r.arrayBuffer(), got.url));
        } finally {
          got.release();
        }
      }
      const result = parseIndexText(text);
      if (result.kind === 'available') {
        const read = readIndexJson(JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text));
        this._file = read?.file ?? null;
      }
      return result;
    } catch (e) {
      return { kind: 'error', reason: e instanceof Error ? e.message : String(e) };
    }
  }

  async openPackage(file: string): Promise<AasxPackage> {
    const path = `${PROJECT_AASX_DIR}/${file}`;
    const got = await backendBlob(this.backend, path);
    if (!got) throw new Error(`Failed to load ${file}: not in project`);
    if ('blob' in got) return openAasxPackage(got.blob);
    try {
      // An object URL (OPFS, decrypted hosted bytes) is local — read it whole.
      // A plain deploy URL supports ranges; fall back to a whole read if not.
      if (!got.url.startsWith('blob:') && !isEncryptedDeploy()) {
        try { return await openAasxPackage({ url: got.url, rangeReads: true }); } catch { /* fall through */ }
      }
      return await openAasxPackage({
        url: got.url,
        rangeReads: false,
        fetchBytes: async (u) => {
          const r = await fetch(u);
          if (!r.ok) throw new Error(`Failed to load ${file}: ${r.status}`);
          return decryptServedBytes(await r.arrayBuffer(), u);
        },
      });
    } finally {
      got.release();
    }
  }

  invalidate(): void {
    this.cancelIndexRetry();
    this._index = null;
    this._revision++;
  }
}

/**
 * Install a scanned index on a project source and tell everybody: the revision
 * rises, the source's open packages are released (a file may have changed under
 * them) and every listener recomputes.
 */
export function publishScannedIndex(source: ProjectAasSource, file: AasProjectIndexFile): void {
  source.setScannedIndex(file);
  releaseAasPackages(source.key);
  notifySources();
}

/**
 * The shared project source for a backend. A different backend object under
 * the same project id (re-open) replaces the old source and releases its
 * packages.
 */
export function projectAasSourceFor(backend: AasProjectBackend, projectId: string): ProjectAasSource {
  const key = `project:${projectId}`;
  const existing = _registry.get(key) as ProjectAasSource | undefined;
  if (existing && existing.backend === backend) return existing;
  if (existing) releaseAasPackages(key);
  const src = new ProjectAasSource(backend, projectId);
  _registry.set(key, src);
  return src;
}

// ─── Merged source ──────────────────────────────────────────────────────

/** Project over deploy: the first source that knows an id wins. */
export class MergedAasSource implements AasSource {
  readonly key: string;
  private _own = 0;

  constructor(readonly sources: readonly AasSource[]) {
    this.key = `merged:${sources.map(s => s.key).join('|')}`;
  }

  get revision(): number {
    let r = this._own;
    for (const s of this.sources) r += s.revision;
    return r;
  }

  async readIndex(): Promise<AasIndexResult> {
    const results = await Promise.all(this.sources.map(s => s.readIndex()));
    const merged: Record<string, AasIndexEntry> = {};
    let available = false;
    let error: string | null = null;
    // Later sources first, so earlier ones overwrite: the project wins per id.
    for (let i = results.length - 1; i >= 0; i--) {
      const r = results[i];
      if (r.kind === 'available') {
        available = true;
        Object.assign(merged, r.index);
      } else if (r.kind === 'error' && error === null) {
        error = r.reason;
      }
    }
    if (available) return { kind: 'available', index: merged };
    if (error !== null) return { kind: 'error', reason: error };
    return { kind: 'missing' };
  }

  async openPackage(file: string): Promise<AasxPackage> {
    for (const s of this.sources) {
      const r = await s.readIndex();
      if (r.kind === 'available' && Object.values(r.index).some(e => e.file === file)) return s.openPackage(file);
    }
    throw new Error(`Failed to load ${file}: not in any AAS source`);
  }

  invalidate(): void {
    for (const s of this.sources) s.invalidate();
    this._own++;
  }
}

/** Members of a source: the merged source's list, or the source itself. */
export function sourceMembers(source: AasSource): readonly AasSource[] {
  return source instanceof MergedAasSource ? source.sources : [source];
}

/**
 * Find the source whose index carries `aasId` — WITH that source, so the
 * archive is opened from exactly where the entry came from (SOL #4).
 */
export async function lookupAas(source: AasSource, aasId: string): Promise<AasLookup | null> {
  if (!aasId) return null;
  for (const s of sourceMembers(source)) {
    const r = await s.readIndex();
    if (r.kind === 'available' && r.index[aasId]) return { source: s, entry: r.index[aasId] };
  }
  return null;
}

// ─── Active source ──────────────────────────────────────────────────────

interface DeployContext {
  /** Per-model `pluginConfig['aas-link'].assetsBasePath` (assets ROOT, `aasx/` is appended). */
  explicitBase?: string | null;
  /** Deployment-wide assets root (`viewer.projectAssetsPath`). */
  deployBase?: string | null;
}

let _context: DeployContext = {};

/** Set the deploy-side context (model config, deploy assets root). */
export function setAasDeployContext(ctx: DeployContext): void {
  const changed = ctx.explicitBase !== _context.explicitBase || ctx.deployBase !== _context.deployBase;
  _context = { ...ctx };
  if (changed) notifySources();
}

/** The deploy-wide `aasx/` directory under the current context. */
export function activeDeployAasxDir(): string {
  return resolveAssetsBase({
    explicit: _context.explicitBase,
    project: getProjectStore().getProject(),
    kind: 'aasx',
    fallbackBase: _context.deployBase || `${import.meta.env.BASE_URL}`,
  });
}

/**
 * The active project's source, or null when no project backend is open.
 * Exposed for the project index scan and the inspector picker.
 */
export function getActiveProjectAasSource(): ProjectAasSource | null {
  const store = getProjectStore();
  const backend = store.getBackend();
  if (!backend) return null;
  const projectId = store.getProject()?.id ?? backend.id;
  return projectAasSourceFor(backend, projectId);
}

/**
 * THE active AAS source: the open project's `aasx/` over the deploy-wide
 * directory. Every AAS surface asks this instead of computing a base path.
 */
export function getActiveAasSource(): AasSource {
  const deploy = urlAasSourceFor(activeDeployAasxDir(), { rangeReads: !isEncryptedDeploy() });
  const project = getActiveProjectAasSource();
  if (!project) return deploy;
  const key = `merged:${project.key}|${deploy.key}`;
  const existing = _registry.get(key) as MergedAasSource | undefined;
  if (existing && existing.sources[0] === project && existing.sources[1] === deploy) return existing;
  const merged = new MergedAasSource([project, deploy]);
  _registry.set(key, merged);
  return merged;
}

/**
 * Resolve the source a caller names: an {@link AasSource} as is, a legacy
 * assets-root string (index at `<root>aasx/index.json`), or — when nothing is
 * named — the default deploy directory.
 */
export function asAasSource(sourceOrBase?: AasSource | string | null): AasSource {
  if (sourceOrBase && typeof sourceOrBase === 'object') return sourceOrBase;
  return urlAasSourceFor(aasxDirForAssetsRoot(sourceOrBase ?? undefined));
}

// ─── Package cache (on demand, LRU, bounded concurrency) ────────────────

/** Packages kept open at most; the least recently used one is released first. */
export const MAX_OPEN_PACKAGES = 3;
/** Archives being opened at the same time, at most. */
export const MAX_CONCURRENT_OPENS = 2;

interface PackageRecord {
  sourceKey: string;
  promise: Promise<AasxPackage>;
  urls: Set<string>;
}

const _packages = new Map<string, PackageRecord>();
let _opening = 0;
const _openWaiters: Array<() => void> = [];
let _peakOpening = 0;

async function withOpenSlot<T>(fn: () => Promise<T>): Promise<T> {
  while (_opening >= MAX_CONCURRENT_OPENS) {
    await new Promise<void>(res => _openWaiters.push(res));
  }
  _opening++;
  _peakOpening = Math.max(_peakOpening, _opening);
  try {
    return await fn();
  } finally {
    _opening--;
    _openWaiters.shift()?.();
  }
}

function packageKey(source: AasSource, file: string): string {
  return `${source.key}#${source.revision}::${file}`;
}

function releaseRecord(key: string, rec: PackageRecord): void {
  _packages.delete(key);
  for (const url of rec.urls) URL.revokeObjectURL(url);
  rec.urls.clear();
  rec.promise.then(p => p.close()).catch(() => { /* never opened */ });
}

/**
 * Open (or reuse) one archive of `source`. Bounded: {@link MAX_CONCURRENT_OPENS}
 * opens in flight, {@link MAX_OPEN_PACKAGES} kept open.
 */
export function acquireAasPackage(source: AasSource, file: string): Promise<AasxPackage> {
  const key = packageKey(source, file);
  const hit = _packages.get(key);
  if (hit) {
    // LRU touch: re-insert at the end.
    _packages.delete(key);
    _packages.set(key, hit);
    return hit.promise;
  }
  const rec: PackageRecord = {
    sourceKey: source.key,
    promise: withOpenSlot(() => source.openPackage(file)),
    urls: new Set(),
  };
  _packages.set(key, rec);
  rec.promise.catch(() => { if (_packages.get(key) === rec) _packages.delete(key); });
  while (_packages.size > MAX_OPEN_PACKAGES) {
    const [oldKey, oldRec] = _packages.entries().next().value as [string, PackageRecord];
    releaseRecord(oldKey, oldRec);
  }
  return rec.promise;
}

/** Remember an object URL created for an entry, so evicting the package revokes it. */
export function trackAasPackageUrl(source: AasSource, file: string, url: string): void {
  _packages.get(packageKey(source, file))?.urls.add(url);
}

/** Release every open package (of one source key, or all). */
export function releaseAasPackages(sourceKey?: string): void {
  for (const [key, rec] of [..._packages]) {
    if (!sourceKey || rec.sourceKey === sourceKey) releaseRecord(key, rec);
  }
}

/** Open-package statistics — tests and diagnostics. */
export function getAasPackageStats(): { open: number; keys: string[]; opening: number; peakOpening: number } {
  return { open: _packages.size, keys: [..._packages.keys()], opening: _opening, peakOpening: _peakOpening };
}

/** Reset every source, cache and listener — tests only. */
export function resetAasSources(): void {
  for (const s of _registry.values()) s.invalidate();
  releaseAasPackages();
  _registry.clear();
  _context = {};
  _peakOpening = 0;
}

/** Drop cached indices of every registered source (legacy `resetIndex`). */
export function resetAasIndexCaches(): void {
  for (const s of _registry.values()) s.invalidate();
}
