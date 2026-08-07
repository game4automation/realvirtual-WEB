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
import type { SimDesStatistics } from './simulation-kernel';

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
  readonly model: string;
  readonly exp: string;
  readonly projectId: string | null;
}

/** Shared active-scope store. `null` = run archiving disabled. */
export const runScopeStore: Store<RunScope | null> = createStore<RunScope | null>(null);

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

/** One run (= plan-261 replication carrying run metadata). */
export interface RunInfo {
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
  readonly checkpoints: CheckpointInfo[];
}

/**
 * One parameter override (public projection, plan-265 F3). Primitive-only — it
 * crosses the repo boundary as part of the manifest JSON string, never as a
 * private type.
 */
export interface ParamOverrideInfo {
  readonly path: string;
  readonly component: string;
  readonly field: string;
  readonly value: boolean | number | string | null;
}

/** Parsed experiment manifest (public projection of the private manifest). */
export interface ExperimentInfo {
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
    if (typeof e.path !== 'string' || typeof e.component !== 'string' || typeof e.field !== 'string') continue;
    const v = e.value;
    if (v !== null && typeof v !== 'boolean' && typeof v !== 'number' && typeof v !== 'string') continue;
    out.push({ path: e.path, component: e.component, field: e.field, value: v as boolean | number | string | null });
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
      const snapshots = Array.isArray(r.snapshots) ? r.snapshots : [];
      runs.push({
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
      model: raw.model,
      experiment: raw.experiment,
      ...(typeof raw.projectId === 'string' ? { projectId: raw.projectId } : {}),
      ...(typeof raw.glbHash === 'string' ? { glbHash: raw.glbHash } : {}),
      baseSeed: typeof raw.baseSeed === 'number' ? raw.baseSeed : 42,
      createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : 0,
      runs,
      replicationCount: typeof raw.replicationCount === 'number' && raw.replicationCount > 0
        ? Math.floor(raw.replicationCount) : 1,
      paramOverrides: projectParamOverrides(raw.paramOverrides),
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
