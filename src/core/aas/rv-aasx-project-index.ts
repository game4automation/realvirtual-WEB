// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-aasx-project-index.ts — the project's own AASX index (plan-596 Phase 3).
 *
 * A project keeps its AASX files in `<project>/aasx/` (flat, not recursive).
 * The viewer builds the index AAS id → file ITSELF and writes it back as
 * `aasx/index.json`, so a hosted copy of the project (which cannot list a
 * directory) finds the same ids without any scan.
 *
 * ## When
 *
 * When a project is adopted (store subscription, backend change), after an
 * import, and on request ({@link rescanProjectAasx}). Which backends scan is
 * decided by `backend.kind` (SOL #7), NOT by capability: `folder` and `browser`
 * scan (a read-only folder too — then in memory only); `bundled` never does —
 * its `listAllFiles` is a manifest listing that does not contain AASX files, so
 * it reads the delivered `aasx/index.json` and nothing else.
 *
 * ## How
 *
 * `listAllFiles()` → `aasx/*.aasx` → stat each (size + lastModified of the
 * lazy `File`) → compare with the stored index → parse only what changed (at
 * most {@link SCAN_CONCURRENCY} at once; a broken file is recorded and the scan
 * goes on) → drop removed files → duplicates resolved deterministically (the
 * alphabetically first file wins, every holder listed under `duplicates`, a
 * Problems entry per id) → compare the signature → write only when it changed,
 * the backend is writable and active, and this is still the project the scan
 * started on.
 *
 * ## Races (SOL #5)
 *
 * ONE serialised run per backend. A request while a run is in flight sets a
 * dirty flag and is answered by exactly one follow-up run; only the last run
 * writes. A project adopt starts a new generation: a scan of the previous
 * project neither writes nor publishes its result.
 */

import { getProjectStore } from '../project/project-store';
import type { ProjectBackend } from '../project/backends/project-backend';
import { clearProblemsOfCode, reportProblem } from '../hmi/problems-store';
import {
  PROJECT_AASX_DIR,
  PROJECT_AASX_INDEX,
  projectAasSourceFor,
  publishScannedIndex,
  releaseAasPackages,
  invalidateAasSource,
  type AasIndexEntry,
  type AasProjectIndexFile,
  type AasProjectIndexFileRecord,
  type ProjectAasSource,
} from './rv-aas-source';
import { readAasxSummary, type AasxSummaryResult } from './rv-aasx-package';

/** Archives parsed at the same time during a scan, at most. */
export const SCAN_CONCURRENCY = 4;

/** Problems codes of this module. */
export const AASX_DUPLICATE_CODE = 'aasx-duplicate-id';
export const AASX_UNREADABLE_CODE = 'aasx-unreadable';

/** The backend surface a scan uses. */
export type AasxScanBackend = Pick<ProjectBackend, 'kind' | 'id' | 'readDocumentUrl' | 'writable' | 'isActive' | 'writeDocument'>
  & Partial<Pick<ProjectBackend, 'listAllFiles' | 'readDocumentBlob'>>;

/** Injectable parts (tests). */
export interface AasxScanDeps {
  readSummary?: (blob: Blob) => Promise<AasxSummaryResult>;
}

/** What one scan run did. */
export interface AasxScanOutcome {
  file: AasProjectIndexFile;
  /** Files actually parsed in this run. */
  parsed: string[];
  /** True when `aasx/index.json` was written. */
  wrote: boolean;
  /** True when the run was superseded (newer request / other project) and published nothing. */
  stale: boolean;
}

/** True for `aasx/<name>.aasx` directly in the folder. */
export function isProjectAasxPath(path: string): boolean {
  return /^aasx\/[^/]+\.aasx$/i.test(path);
}

/** Stable JSON of an index file — the write signature. */
export function serializeProjectIndex(file: AasProjectIndexFile): string {
  return `${JSON.stringify(file, null, 2)}\n`;
}

async function statOf(backend: AasxScanBackend, path: string): Promise<{ blob: Blob; size: number; lastModified: number } | null> {
  if (backend.readDocumentBlob) {
    const blob = await backend.readDocumentBlob(path).catch(() => null);
    if (blob) return { blob, size: blob.size, lastModified: (blob as File).lastModified ?? 0 };
  }
  const resolved = await backend.readDocumentUrl(path).catch(() => null);
  if (!resolved) return null;
  try {
    const r = await fetch(resolved.url);
    if (!r.ok) return null;
    const blob = await r.blob();
    return { blob, size: blob.size, lastModified: 0 };
  } finally {
    resolved.release();
  }
}

async function readStoredIndexText(backend: AasxScanBackend): Promise<string | null> {
  try {
    if (backend.readDocumentBlob) {
      const blob = await backend.readDocumentBlob(PROJECT_AASX_INDEX);
      return blob ? await blob.text() : null;
    }
    const resolved = await backend.readDocumentUrl(PROJECT_AASX_INDEX);
    if (!resolved) return null;
    try {
      const r = await fetch(resolved.url);
      return r.ok ? await r.text() : null;
    } finally {
      resolved.release();
    }
  } catch {
    return null;
  }
}

/** Run `fn` over `items` with at most `limit` in flight. */
async function mapLimited<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}

/**
 * Build the index from the folder, reusing the records of unchanged files.
 * Pure with respect to the backend's write side — writing is the caller's job.
 */
export async function buildProjectAasxIndex(
  backend: AasxScanBackend,
  previous: AasProjectIndexFile | null,
  deps: AasxScanDeps = {},
): Promise<{ file: AasProjectIndexFile; parsed: string[] }> {
  const readSummary = deps.readSummary ?? ((blob: Blob) => readAasxSummary(blob));
  const all = backend.listAllFiles ? await backend.listAllFiles().catch(() => [] as string[]) : [];
  const names = all.filter(isProjectAasxPath).map(p => p.slice(PROJECT_AASX_DIR.length + 1)).sort(compareNames);

  const records: Record<string, AasProjectIndexFileRecord> = {};
  const parsed: string[] = [];
  await mapLimited(names, SCAN_CONCURRENCY, async (name) => {
    const stat = await statOf(backend, `${PROJECT_AASX_DIR}/${name}`);
    if (!stat) return; // vanished between listing and stat
    const prev = previous?.files?.[name];
    if (prev && prev.size === stat.size && prev.lastModified === stat.lastModified && !prev.error && prev.shells) {
      records[name] = prev;
      return;
    }
    parsed.push(name);
    const result = await readSummary(stat.blob).catch((e): AasxSummaryResult => ({ ok: false, error: String(e) }));
    records[name] = result.ok
      ? {
        size: stat.size,
        lastModified: stat.lastModified,
        aasIds: result.shells.map(s => s.id),
        shells: result.shells.map(s => ({
          id: s.id,
          idShort: s.idShort,
          ...(s.productName ? { productName: s.productName } : {}),
          ...(s.manufacturer ? { manufacturer: s.manufacturer } : {}),
          ...(s.globalAssetId ? { globalAssetId: s.globalAssetId } : {}),
        })),
      }
      : { size: stat.size, lastModified: stat.lastModified, aasIds: [], error: result.error };
  });

  const entries: Record<string, AasIndexEntry> = {};
  const holders: Record<string, string[]> = {};
  const files: Record<string, AasProjectIndexFileRecord> = {};
  for (const name of names) {
    const rec = records[name];
    if (!rec) continue;
    files[name] = rec;
    for (const shell of rec.shells ?? []) {
      (holders[shell.id] ??= []).push(name);
      if (entries[shell.id]) continue; // alphabetically first file wins
      const { id: _id, ...meta } = shell;
      entries[shell.id] = { file: name, ...meta };
    }
  }
  const duplicates: Record<string, string[]> = {};
  for (const [id, list] of Object.entries(holders)) if (list.length > 1) duplicates[id] = list;

  return {
    file: {
      version: 1,
      generator: 'realvirtual-web',
      entries,
      files,
      ...(Object.keys(duplicates).length ? { duplicates } : {}),
    },
    parsed: parsed.sort(compareNames),
  };
}

function compareNames(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Replace this module's Problems entries with those of `file`. */
export function reportIndexProblems(file: AasProjectIndexFile): void {
  clearProblemsOfCode(AASX_DUPLICATE_CODE);
  clearProblemsOfCode(AASX_UNREADABLE_CODE);
  for (const [id, list] of Object.entries(file.duplicates ?? {})) {
    reportProblem({
      id: `${AASX_DUPLICATE_CODE}:${id}`,
      severity: 'warning',
      code: AASX_DUPLICATE_CODE,
      title: `AAS id in several AASX files: ${id}`,
      detail: `Found in ${list.map(f => `aasx/${f}`).join(', ')}. Using aasx/${list[0]}.`,
    });
  }
  for (const [name, rec] of Object.entries(file.files)) {
    if (!rec.error) continue;
    reportProblem({
      id: `${AASX_UNREADABLE_CODE}:${name}`,
      severity: 'warning',
      code: AASX_UNREADABLE_CODE,
      title: `AASX file could not be read: aasx/${name}`,
      detail: rec.error,
    });
  }
}

// ─── Serialised runs ────────────────────────────────────────────────────

interface ScanState {
  running: Promise<AasxScanOutcome | null> | null;
  dirty: boolean;
}

const _states = new Map<string, ScanState>();
let _generation = 0;
let _deps: AasxScanDeps = {};

/** Override parse dependencies (tests). */
export function setAasxScanDeps(deps: AasxScanDeps): void {
  _deps = deps;
}

/** Start a new adopt generation — scans of earlier generations publish nothing. */
export function beginAasxScanGeneration(): number {
  return ++_generation;
}

/**
 * Scan `backend` (serialised): a request during a run is folded into ONE
 * follow-up run; the promise resolves with the outcome of the last run.
 *
 * `isCurrent` says whether the backend is still the open project's; the
 * default asks the project store.
 */
export function requestAasxScan(
  backend: AasxScanBackend,
  projectId: string,
  opts: { isCurrent?: () => boolean; source?: ProjectAasSource } = {},
): Promise<AasxScanOutcome | null> {
  if (backend.kind === 'bundled') {
    // The delivered index is the whole truth of a deploy (SOL #7).
    return Promise.resolve(null);
  }
  let state = _states.get(backend.id);
  if (!state) {
    state = { running: null, dirty: false };
    _states.set(backend.id, state);
  }
  if (state.running) {
    state.dirty = true;
    return state.running;
  }
  const s = state;
  const generation = _generation;
  const isCurrent = opts.isCurrent ?? (() => isStoreBackend(backend));
  const source = opts.source ?? projectAasSourceFor(backend as unknown as ProjectBackend, projectId);
  s.running = (async () => {
    let last: AasxScanOutcome | null = null;
    try {
      do {
        s.dirty = false;
        last = await scanOnce(backend, source, () => generation === _generation && isCurrent() && !s.dirty);
      } while (s.dirty && generation === _generation && isCurrent());
    } finally {
      s.running = null;
    }
    return last;
  })();
  return s.running;
}

function isStoreBackend(backend: AasxScanBackend): boolean {
  const active = getProjectStore().getBackend();
  // The store wraps the backend (CONNECT notifier) — compare ids, not objects.
  return !!active && active.id === backend.id;
}

async function scanOnce(
  backend: AasxScanBackend,
  source: ProjectAasSource,
  stillMine: () => boolean,
): Promise<AasxScanOutcome> {
  // Previous state: what the source holds, else the stored file.
  let previous = source.indexFile;
  const storedText = await readStoredIndexText(backend);
  if (!previous && storedText) {
    try {
      const raw = JSON.parse(storedText.charCodeAt(0) === 0xfeff ? storedText.slice(1) : storedText) as AasProjectIndexFile;
      if (raw && raw.version === 1 && raw.files) previous = raw;
    } catch { /* unreadable index — rebuilt below */ }
  }

  const { file, parsed } = await buildProjectAasxIndex(backend, previous, _deps);
  if (!stillMine()) return { file, parsed, wrote: false, stale: true };

  const text = serializeProjectIndex(file);
  const hasAasx = Object.keys(file.files).length > 0;
  let wrote = false;
  // No aasx/ files and no index on disk: nothing to write — a project without
  // AASX keeps its tree clean. Written only when the content changed.
  if ((hasAasx || storedText !== null) && text !== storedText && backend.writable && backend.isActive) {
    try {
      await backend.writeDocument(PROJECT_AASX_INDEX, new TextEncoder().encode(text), { expectedRevision: 'any' });
      wrote = true;
    } catch (e) {
      console.warn('[aasx-index] could not write aasx/index.json', e);
    }
  }
  if (!stillMine()) return { file, parsed, wrote, stale: true };

  const current = source.indexFile ? serializeProjectIndex(source.indexFile) : null;
  if (current !== text) publishScannedIndex(source, file);
  reportIndexProblems(file);
  return { file, parsed, wrote, stale: false };
}

/** Rescan the open project's `aasx/` folder (import, explicit request). */
export function rescanProjectAasx(): Promise<AasxScanOutcome | null> {
  const store = getProjectStore();
  const backend = store.getBackend();
  if (!backend) return Promise.resolve(null);
  return requestAasxScan(backend, store.getProject()?.id ?? backend.id);
}

/**
 * Follow the project store: a new backend starts a new generation, releases
 * the previous project's packages and scans (folder / browser) or reloads the
 * delivered index (bundled). Returns the unsubscriber. Idempotent per call site.
 */
export function installAasxProjectIndex(): () => void {
  const store = getProjectStore();
  let lastKey: string | null = null;
  const onChange = (): void => {
    const backend = store.getBackend();
    const projectId = backend ? (store.getProject()?.id ?? backend.id) : null;
    const key = backend && projectId ? `${backend.id}::${projectId}` : null;
    if (key === lastKey) return;
    const previousSourceKey = lastKey ? `project:${lastKey.split('::')[1]}` : null;
    lastKey = key;
    beginAasxScanGeneration();
    if (previousSourceKey) releaseAasPackages(previousSourceKey);
    if (!backend || !projectId) return;
    const source = projectAasSourceFor(backend, projectId);
    if (backend.kind === 'bundled') {
      invalidateAasSource(source.key);
      return;
    }
    // In the background — the model load does not wait for the scan.
    void requestAasxScan(backend, projectId, { source }).catch((e) => console.warn('[aasx-index] scan failed', e));
  };
  const off = store.subscribe(onChange);
  onChange();
  return off;
}

/** Reset module state — tests only. */
export function resetAasxProjectIndex(): void {
  _states.clear();
  _generation = 0;
  _deps = {};
}
