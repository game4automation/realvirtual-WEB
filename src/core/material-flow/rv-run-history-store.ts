// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-run-history-store.ts — the PUBLIC side of the simulation-run hierarchy
 * (plan-260, unified with the plan-261 experiment store):
 *
 *   Project            (public IndexedDB `rv-sim-projects`, this module)
 *     └── Experiment   (private store `rv-des-experiments`, one manifest per
 *          └── Run      model+experiment; a RUN is a REPLICATION with run
 *               └── Checkpoint   metadata; a CHECKPOINT is a Snapshot(t))
 *
 * Only the PROJECT registry lives here (small records, own DB via the shared
 * rv-idb-utils). Experiments/runs/checkpoints stay in the private plan-261
 * store and cross the repo seam exclusively as JSON strings through the
 * `SimDesControl` facade — this module provides the pure-data parse types the
 * public UI reads from those strings (no private type import).
 *
 * The `runScopeStore` announces the ACTIVE run scope (model + experiment +
 * project) to the private run-lifecycle controller: the private side imports
 * this public module (private→public only) and archives finished runs into
 * that scope. `null` scope = run archiving off (non-DES scenes stay unloaded).
 */

import { openIdb, idbRequest, idbTxDone } from '../persistence/rv-idb-utils';
import { createStore, type Store } from '../hmi/create-store';
import type { VariantOverride } from '../variants/rv-variant-model';
import type { RngVersion } from '../rv-rng-streams';
import type { SimDesStatistics } from './simulation-kernel';
import { normalizeKpiDefs, parseKpiTrack, type KpiDef, type KpiTrack } from '../../plugins/sim-controller/des-kpi-defs';

// ── Project registry (public IndexedDB) ──

export interface Project {
  readonly projectId: string;
  readonly name: string;
  readonly createdAt: number;
}

const DB_NAME = 'rv-sim-projects';
const DB_VERSION = 1;
const PROJECT_STORE = 'projects';

let dbPromise: Promise<IDBDatabase> | null = null;
function db(): Promise<IDBDatabase> {
  dbPromise ??= openIdb(DB_NAME, DB_VERSION, [PROJECT_STORE]);
  return dbPromise;
}

/** Close the project DB connection (tests / teardown). Reopens lazily. */
export async function closeProjectDb(): Promise<void> {
  if (!dbPromise) return;
  const d = await dbPromise;
  d.close();
  dbPromise = null;
}

/** Fresh uuid (crypto when available, time+random fallback). */
export function freshRunId(): string {
  try {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  } catch { /* fall through */ }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** All projects, newest first. */
export async function listProjects(): Promise<Project[]> {
  const d = await db();
  const tx = d.transaction(PROJECT_STORE, 'readonly');
  const all = await idbRequest<Project[]>(tx.objectStore(PROJECT_STORE).getAll() as IDBRequest<Project[]>);
  return (all ?? []).sort((a, b) => b.createdAt - a.createdAt);
}

/** Create a project. */
export async function createProject(name: string): Promise<Project> {
  const project: Project = { projectId: freshRunId(), name, createdAt: Date.now() };
  const d = await db();
  const tx = d.transaction(PROJECT_STORE, 'readwrite');
  tx.objectStore(PROJECT_STORE).put(project, project.projectId);
  await idbTxDone(tx);
  return project;
}

/** Rename a project. */
export async function renameProject(projectId: string, name: string): Promise<void> {
  const d = await db();
  const tx = d.transaction(PROJECT_STORE, 'readwrite');
  const store = tx.objectStore(PROJECT_STORE);
  const req = store.get(projectId) as IDBRequest<Project | undefined>;
  req.onsuccess = () => {
    if (req.result) store.put({ ...req.result, name }, projectId);
  };
  await idbTxDone(tx);
}

/** Delete the project RECORD only. Cascading experiment deletion goes through
 *  the `SimDesControl` facade (see rv-project-manager.deleteProjectCascade). */
export async function deleteProjectRecord(projectId: string): Promise<void> {
  const d = await db();
  const tx = d.transaction(PROJECT_STORE, 'readwrite');
  tx.objectStore(PROJECT_STORE).delete(projectId);
  await idbTxDone(tx);
}

// ── Active run scope (read by the private run-lifecycle controller) ──

/** The scope a finished run is archived into. `projectId` tags the experiment
 *  manifest so comparisons stay strictly project-internal (F11). */
export interface RunScope {
  /** Base identity resolved before start, shared with current column validity. */
  readonly baseKey?: string | null;
  readonly model: string;
  readonly exp: string;
  readonly rngVersion?: RngVersion;
  readonly crn?: boolean;
  readonly projectId: string | null;
}

/** Shared active-scope store. `null` = run archiving disabled. */
export const runScopeStore: Store<RunScope | null> = createStore<RunScope | null>(null);

// The generic store merges object patches; null must clear the scope instead
// of merging into an empty object (or retaining the previous destination).
const setRunScope = runScopeStore.set;
runScopeStore.set = (update) => setRunScope(update === null ? () => null : update);

// ── Parsed experiment/run types (JSON transport across the repo seam) ──

export type RunStatus = 'running' | 'completed' | 'aborted';
export type RunEndReason = 'reset' | 'duration-reached' | 'manual';

/** One stored checkpoint (= plan-261 snapshot) of a run. */
export interface CheckpointInfo {
  readonly simTime: number;
  readonly label?: string;
  readonly bytes: number;
  readonly createdAt: number;
}

/** Variant-column settings transported in manifests and public projections. */
export interface ExperimentColumnFields {
  variantId?: string | null;
  variantSnapshot?: { id: string; name: string; revision: number; overrides: VariantOverride[]; description?: string };
  /** Base column only: the Base description as last edited (recovery copy; '' = removed). */
  baseDescription?: string;
  pinnedRows?: Array<{ address: string; component: string; field: string; path?: string }>;
  kpiRows?: string[];
  /** User-defined KPIs ("+ Add KPI"), kept on the Base manifest next to kpiRows. */
  kpiDefs?: KpiDef[];
  /** Matching seeds are enabled unless explicitly disabled. */
  crn?: boolean;
  previousGeneration?: string;
  supersededBy?: string;
  migratedAt?: number;
  legacyFactors?: unknown[];
}

/** Frozen configuration of a run; legacy results have no verified identity. */
export interface ReplicationColumnFields {
  provenance?: {
    variantId: string | null; variantRevision: number; overridesHash: string;
    baseKey: string | null; endTime: number; statResetTime: number;
    rngVersion: 1 | 2; crn: boolean; seed: number;
  } | { unverified: true };
  configKey?: string;
  seriesRef?: string;
  seriesError?: string;
  seriesEvicted?: boolean;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}
function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Defensive whitelist shared by create/parse/patch within this layer. */
export function parseExperimentColumnFields(value: unknown): ExperimentColumnFields {
  const r = record(value) ?? {};
  const out: ExperimentColumnFields = { crn: typeof r.crn === 'boolean' ? r.crn : true };
  if (r.variantId === null || typeof r.variantId === 'string') out.variantId = r.variantId;
  const s = record(r.variantSnapshot);
  if (s && typeof s.id === 'string' && typeof s.name === 'string'
    && finite(s.revision) && Number.isInteger(s.revision) && s.revision >= 0 && Array.isArray(s.overrides)) {
    const overrides: VariantOverride[] = [];
    for (const entry of s.overrides) {
      const o = record(entry);
      if (o && typeof o.address === 'string' && typeof o.component === 'string' && typeof o.field === 'string'
        && (finite(o.value) || typeof o.value === 'boolean' || typeof o.value === 'string')) {
        overrides.push({ address: o.address, component: o.component, field: o.field, value: o.value });
      }
    }
    out.variantSnapshot = { id: s.id, name: s.name, revision: s.revision, overrides,
      ...(typeof s.description === 'string' ? { description: s.description } : {}) };
  }
  if (Array.isArray(r.pinnedRows)) out.pinnedRows = r.pinnedRows.flatMap((entry) => {
    const p = record(entry);
    return p && typeof p.address === 'string' && typeof p.component === 'string' && typeof p.field === 'string'
      ? [{ address: p.address, component: p.component, field: p.field, ...(typeof p.path === 'string' ? { path: p.path } : {}) }] : [];
  });
  if (Array.isArray(r.kpiRows)) out.kpiRows = r.kpiRows.filter((v): v is string => typeof v === 'string');
  if (Array.isArray(r.kpiDefs)) out.kpiDefs = normalizeKpiDefs(r.kpiDefs);
  if (typeof r.baseDescription === 'string') out.baseDescription = r.baseDescription;
  for (const key of ['previousGeneration', 'supersededBy'] as const) {
    if (typeof r[key] === 'string') out[key] = r[key];
  }
  if (finite(r.migratedAt)) out.migratedAt = r.migratedAt;
  if (Array.isArray(r.legacyFactors)) out.legacyFactors = [...r.legacyFactors];
  return out;
}

/** Invalid optional run fields are discarded without inventing provenance. */
export function parseReplicationColumnFields(value: unknown): ReplicationColumnFields {
  const r = record(value) ?? {};
  const out: ReplicationColumnFields = {};
  for (const key of ['configKey', 'seriesRef', 'seriesError'] as const) {
    if (typeof r[key] === 'string') out[key] = r[key];
  }
  if (typeof r.seriesEvicted === 'boolean') out.seriesEvicted = r.seriesEvicted;
  const p = record(r.provenance);
  if (p?.unverified === true) out.provenance = { unverified: true };
  else if (p && (p.variantId === null || typeof p.variantId === 'string')
    && finite(p.variantRevision) && Number.isInteger(p.variantRevision) && p.variantRevision >= 0
    && typeof p.overridesHash === 'string' && (p.baseKey === null || typeof p.baseKey === 'string')
    && finite(p.endTime) && finite(p.statResetTime) && (p.rngVersion === 1 || p.rngVersion === 2)
    && typeof p.crn === 'boolean' && finite(p.seed)) {
    out.provenance = { variantId: p.variantId, variantRevision: p.variantRevision, overridesHash: p.overridesHash,
      baseKey: p.baseKey, endTime: p.endTime, statResetTime: p.statResetTime,
      rngVersion: p.rngVersion, crn: p.crn, seed: p.seed };
  }
  return out;
}

/** One run (= plan-261 replication carrying run metadata). */
export interface RunInfo extends ReplicationColumnFields {
  readonly rngVersion: RngVersion;
  /** Replication index (storage key component). */
  readonly index: number;
  readonly seed: number;
  readonly runId?: string;
  readonly status?: RunStatus;
  readonly startedAt?: number;
  readonly endedAt?: number;
  /** Sim time (seconds) reached when the run was archived. */
  readonly simTimeReached?: number;
  readonly reason?: RunEndReason;
  /** Statistics snapshot at archive time (public pure-data shape). */
  readonly stats?: SimDesStatistics;
  /** Points of the KPI sources tracked during this run (warm-up end, end, mean, max). */
  readonly kpiTrack?: KpiTrack;
  readonly checkpoints: CheckpointInfo[];
}

/**
 * One parameter override (public projection, plan-265 F3). Primitive-only — it
 * crosses the repo boundary as part of the manifest JSON string, never as a
 * private type.
 */
export type ParamOverrideInfo =
  | {
    /** Component field (also: no `kind`, every manifest before plan-2005 Phase 7). */
    readonly kind?: 'extras';
    /** Full NodeRegistry address `<occurrence>#<NodeId>`; absent on old manifests. */
    readonly address?: string;
    readonly path: string;
    readonly component: string;
    readonly field: string;
    readonly value: boolean | number | string | null;
  }
  | {
    /** A declared planning parameter (plan-2005 Phase 7), by its effective key. */
    readonly kind: 'planning';
    readonly key: string;
    readonly value: boolean | number | string | null;
  };

/** Parsed experiment manifest (public projection of the private manifest). */
export interface ExperimentInfo extends ExperimentColumnFields {
  readonly rngVersion?: RngVersion;
  readonly model: string;
  readonly experiment: string;
  readonly projectId?: string;
  readonly glbHash?: string;
  readonly baseSeed: number;
  readonly createdAt: number;
  readonly runs: RunInfo[];
  // ── plan-265 (Experiment Matrix) projections ──
  /** Replication count ("seed runs N", F2). Defaults to 1. */
  readonly replicationCount: number;
  readonly batchRunIds?: readonly string[];
  /** Parameter overrides applied before each replication (F3). Defaults to []. */
  readonly paramOverrides: ParamOverrideInfo[];
  /** Setter-only parametrisation script (F4); absent when unset. */
  readonly paramScript?: string;
  /** false ⇒ skipped by "Run all" (F16). Defaults to true. */
  readonly enabled: boolean;
  /** Per-experiment sim end in seconds (0 = unset — the batch refuses to run it). */
  readonly endTime: number;
  /** Per-experiment statistics-reset (warmup) time in seconds (0 = off). */
  readonly statResetTime: number;
}

/** Defensive projection of a raw paramOverrides array from the manifest JSON. */
function projectParamOverrides(raw: unknown): ParamOverrideInfo[] {
  if (!Array.isArray(raw)) return [];
  const out: ParamOverrideInfo[] = [];
  for (const e of raw as Array<Record<string, unknown>>) {
    if (!e || typeof e !== 'object') continue;
    const v = e.value;
    if (v !== null && typeof v !== 'boolean' && typeof v !== 'number' && typeof v !== 'string') continue;
    const value = v as boolean | number | string | null;
    if (e.kind === 'planning') {
      if (typeof e.key === 'string' && e.key) out.push({ kind: 'planning', key: e.key, value });
      continue;
    }
    if (e.kind !== undefined && e.kind !== 'extras') continue;
    if (typeof e.path !== 'string' || typeof e.component !== 'string' || typeof e.field !== 'string') continue;
    out.push({
      ...(e.kind === 'extras' ? { kind: 'extras' as const } : {}),
      ...(typeof e.address === 'string' && e.address ? { address: e.address } : {}),
      path: e.path, component: e.component, field: e.field, value,
    });
  }
  return out;
}

/**
 * Defensive parse of a manifest JSON string (from `SimDesControl.
 * readManifestJson`) into the public projection. Returns null on garbage.
 */
export function parseExperimentInfo(json: string): ExperimentInfo | null {
  try {
    const raw = JSON.parse(json) as Record<string, unknown> | null;
    if (!raw || typeof raw !== 'object') return null;
    if (typeof raw.model !== 'string' || typeof raw.experiment !== 'string') return null;
    const replications = Array.isArray(raw.replications) ? raw.replications : [];
    const runs: RunInfo[] = [];
    for (const r of replications as Array<Record<string, unknown>>) {
      if (!r || typeof r !== 'object') continue;
      if (r.rngVersion !== undefined && r.rngVersion !== 1 && r.rngVersion !== 2) continue;
      const snapshots = Array.isArray(r.snapshots) ? r.snapshots : [];
      runs.push({
        ...parseReplicationColumnFields(r),
        rngVersion: r.rngVersion === 2 ? 2 : 1,
        index: typeof r.index === 'number' ? r.index : 0,
        seed: typeof r.masterSeed === 'number' ? r.masterSeed : 0,
        ...(typeof r.runId === 'string' ? { runId: r.runId } : {}),
        ...(r.status === 'running' || r.status === 'completed' || r.status === 'aborted'
          ? { status: r.status as RunStatus } : {}),
        ...(typeof r.startedAt === 'number' ? { startedAt: r.startedAt } : {}),
        ...(typeof r.endedAt === 'number' ? { endedAt: r.endedAt } : {}),
        ...(typeof r.simTimeReached === 'number' ? { simTimeReached: r.simTimeReached } : {}),
        ...(r.reason === 'reset' || r.reason === 'duration-reached' || r.reason === 'manual'
          ? { reason: r.reason as RunEndReason } : {}),
        ...(r.stats && typeof r.stats === 'object' ? { stats: r.stats as SimDesStatistics } : {}),
        ...(parseKpiTrack(r.kpiTrack) ? { kpiTrack: parseKpiTrack(r.kpiTrack) } : {}),
        checkpoints: (snapshots as Array<Record<string, unknown>>)
          .filter((s) => s && typeof s.simTime === 'number')
          .map((s) => ({
            simTime: s.simTime as number,
            ...(typeof s.label === 'string' ? { label: s.label } : {}),
            bytes: typeof s.bytes === 'number' ? s.bytes : 0,
            createdAt: typeof s.createdAt === 'number' ? s.createdAt : 0,
          })),
      });
    }
    return {
      ...parseExperimentColumnFields(raw),
      model: raw.model,
      experiment: raw.experiment,
      ...(typeof raw.projectId === 'string' ? { projectId: raw.projectId } : {}),
      ...(typeof raw.glbHash === 'string' ? { glbHash: raw.glbHash } : {}),
      baseSeed: typeof raw.baseSeed === 'number' ? raw.baseSeed : 42,
      createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : 0,
      ...(raw.rngVersion === 1 || raw.rngVersion === 2 ? { rngVersion: raw.rngVersion } : raw.rngVersion === undefined && runs.length > 0 && runs.every((r) => r.rngVersion === runs[0].rngVersion) ? { rngVersion: runs[0].rngVersion } : {}),
      runs,
      replicationCount: typeof raw.replicationCount === 'number' && raw.replicationCount > 0
        ? Math.floor(raw.replicationCount) : 1,
      paramOverrides: projectParamOverrides(raw.paramOverrides),
      ...(Array.isArray(raw.batchRunIds) ? { batchRunIds: raw.batchRunIds.filter((id): id is string => typeof id === 'string') } : {}),
      ...(typeof raw.paramScript === 'string' ? { paramScript: raw.paramScript } : {}),
      enabled: typeof raw.enabled === 'boolean' ? raw.enabled : true,
      endTime: typeof raw.endTime === 'number' && raw.endTime > 0 ? raw.endTime : 0,
      statResetTime: typeof raw.statResetTime === 'number' && raw.statResetTime > 0 ? raw.statResetTime : 0,
    };
  } catch {
    return null;
  }
}

/** The current run of the active session (parsed `activeRunInfoJson`). */
export interface ActiveRunInfo {
  readonly runId: string;
  readonly seed: number;
  readonly startedAt: number;
}

/** Defensive parse of `SimDesControl.activeRunInfoJson()`. */
export function parseActiveRunInfo(json: string | null | undefined): ActiveRunInfo | null {
  if (!json) return null;
  try {
    const raw = JSON.parse(json) as Record<string, unknown> | null;
    if (!raw || typeof raw.runId !== 'string') return null;
    return {
      runId: raw.runId,
      seed: typeof raw.seed === 'number' ? raw.seed : 0,
      startedAt: typeof raw.startedAt === 'number' ? raw.startedAt : 0,
    };
  } catch {
    return null;
  }
}
