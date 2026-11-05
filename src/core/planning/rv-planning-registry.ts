// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-planning-registry — the one place that holds declared planning parameters, their values,
 * the pending reset values, the live queue and the change log (plan-630 §2.4 / §2.5).
 *
 * ## Pure, time injected
 *
 * The registry knows no viewer and no clock. Sim time comes in through `options.simTime`, the
 * Problems panel through `options.problems` (default: the React-free problems store), and the
 * storage of display switches through `options.displayStorage`. The plugin that owns the
 * registry in the viewer (plan-630 Phase 2) wires those up; tests inject fakes.
 *
 * ## Three kinds of value per parameter
 *
 * - **committed** — what `values()` returns and the model runs with;
 * - **pending** — a `reset` value waiting for the structural reset (§2.5a). A normal sim reset
 *   (toolbar) does NOT take it over;
 * - **queued** — a `live` value handed to the owner's `onLive`, visible only after the owner
 *   reports `applied(simTime)`. Only queued (unapplied) changes of the same key are folded; a
 *   reset drops the queue, and a dropped change never reaches the log of the new run.
 *
 * ## Atomic writes
 *
 * Every write path (UI, MCP, scenario switch, experiment) goes through {@link PlanningRegistry.setMany}:
 * the full candidate state (committed + pending + queued + new) is checked — type, range, option
 * and the owner's `validate` — and one error leaves everything untouched, without a snapshot change.
 *
 * ## Dormant values
 *
 * Scenario values for keys nobody has declared yet are kept dormant and take effect on
 * `declare` / `redeclare` (load order does not matter). Keys still dormant when the scene is
 * ready are reported as `planning-param-orphaned` by {@link PlanningRegistry.reportOrphans};
 * their values are never deleted.
 *
 * ## No allocation per tick
 *
 * Nothing here runs per frame. The snapshot is rebuilt only when something changed, so
 * `useSyncExternalStore` gets the same object until then.
 */

import { isVariantInScene } from '../hmi/rv-run-lease';
import { clearProblem as clearProblemDefault, reportProblem as reportProblemDefault } from '../hmi/problems-store';
import type { ProblemInput } from '../hmi/problems-store';
import {
  checkPlanningValue,
  effectivePlanningKey,
  parsePlanningDeclaration,
  planningRoleOf,
} from './rv-planning-params';
import type {
  PendingLiveChange,
  PlanningApply,
  PlanningDeclaration,
  PlanningKpiKind,
  PlanningOrigin,
  PlanningParamDef,
  PlanningRole,
  PlanningValue,
  StructuralResetContext,
} from './rv-planning-params';

// ─── Public types ──────────────────────────────────────────────────────────

/** What one owner gets back from `declare`. */
export interface PlanningHandle {
  /** Owner-local keys → committed values only (no pending, no queued). Value-stable object. */
  values(): Readonly<Record<string, PlanningValue>>;
  /** Committed value of an owner-local key (`undefined` for an undeclared key). */
  get<T extends PlanningValue>(key: string): T;
  /** Takes this owner's pending values over. Idempotent; only from the structural reset / experiment. */
  commitPending(): void;
  /**
   * Only from the owner's structural reset, after its structure fell back to `values`
   * (plan-681 F2). Commits exactly these keys; factor values the cross rules then reject
   * go to their default. Pending stays; no log, no apply. Problems entry either way.
   */
  recoverCommitted(values: Readonly<Record<string, PlanningValue>>): { ok: boolean; reset: string[]; error?: string };
  /** Replaces the declared parameters (instance keys change only in the structural reset). */
  redeclare(params: readonly PlanningParamDef[]): void;
  /** Removes the declaration; non-default committed values stay dormant for a later declare. */
  dispose(): void;
}

/** State of one parameter as the overlay / MCP see it. */
export interface PlanningParamState {
  owner: string;
  /** Effective key `owner.key`. */
  key: string;
  def: PlanningParamDef;
  role: PlanningRole;
  apply: PlanningApply;
  value: PlanningValue;
  /** Pending reset value or queued live value; absent when none. */
  pending?: PlanningValue;
  pendingKind?: 'reset' | 'live';
  /** Current cross-rule finding on committed + pending values. */
  error?: string;
  source: PlanningOrigin;
}

/** One change-log row; the log is totally ordered by `(simTime, seq)`. */
export interface PlanningChange {
  simTime: number;
  seq: number;
  /** Effective key. */
  key: string;
  from: PlanningValue;
  to: PlanningValue;
  origin: PlanningOrigin;
}

/** How a single key of a write ended. */
export type PlanningSetOutcome =
  | 'applied'   // live without onLive: committed now
  | 'queued'    // live with onLive: waiting for applied(simTime)
  | 'pending'   // reset: waiting for the structural reset
  | 'display'   // display switch: set now, not logged
  | 'reverted'  // back to the committed value: pending/queued value withdrawn
  | 'unchanged'
  | 'dormant';  // scenario value for an undeclared key

/** Result for one key of a write. */
export interface PlanningSetResult {
  ok: boolean;
  applied?: PlanningSetOutcome;
  error?: string;
}

/** Result of an atomic multi-key write. */
export interface PlanningSetManyResult {
  ok: boolean;
  /** Per requested effective key. */
  results: Record<string, PlanningSetResult>;
  /** Cross-rule findings on keys that were not part of the request. */
  errors?: Record<string, string>;
}

/** Result of the structural reset (§2.5a). */
export interface PlanningApplyResult {
  ok: boolean;
  /** Number of successful applies so far. */
  generation: number;
  error?: 'apply-in-progress' | 'materialize-failed' | 'document-changed' | string;
  detail?: string;
}

/** A key figure as read now. */
export interface PlanningKpiState {
  owner: string;
  /** Effective key. */
  key: string;
  label: string;
  unit?: string;
  kind: PlanningKpiKind;
  decimals?: number;
  value: number | null;
}

/** Value-stable snapshot for `useSyncExternalStore`. */
export interface PlanningSnapshot {
  /** Increments on every published change. */
  version: number;
  owners: ReadonlyArray<{ owner: string; title: string }>;
  params: readonly PlanningParamState[];
  /** Number of pending reset values. */
  pendingCount: number;
  changeLog: readonly PlanningChange[];
  experimentRunning: boolean;
}

/** Undo record of {@link PlanningRegistry.commitAllPending}. */
export interface PlanningCommitRecord {
  /** Owners whose committed values changed, with the values after the commit (owner-local keys). */
  readonly changed: ReadonlyArray<{ owner: string; committed: Readonly<Record<string, PlanningValue>> }>;
  /** Internal restore state. */
  readonly _restore: ReadonlyArray<{
    owner: string;
    committed: Map<string, PlanningValue>;
    pending: Map<string, PlanningValue>;
    sources: Map<string, PlanningOrigin>;
  }>;
  readonly _logLength: number;
}

/** Primitives a structural-reset runner (Phase 2 `structural-reset.ts`) works with. */
export interface PlanningApplyContext {
  /** Clears the log, drops the live queue, restarts `seq` at 0 (new run). */
  startNewRun(): void;
  /** Takes all pending values over (log rows at `simTime = 0`). */
  commitAllPending(): PlanningCommitRecord;
  /** Restores the state before `commitAllPending` (values pending again). */
  revertCommit(record: PlanningCommitRecord): void;
  /** The owner's declaration with its `onStructuralReset`, if any. */
  declarationOf(owner: string): PlanningDeclaration | undefined;
  /** Committed owner-local values of an owner. */
  valuesOf(owner: string): Readonly<Record<string, PlanningValue>>;
  report(problem: Omit<ProblemInput, 'at'>): void;
  /**
   * Owners the runner must call even when they have NO pending value
   * ({@link PlanningRegistry.reconcileStructure}, Gate-R2 #4 of plan-681): the
   * load-time comparison of a document against its declared structure. Empty
   * for an ordinary apply.
   */
  readonly reconcile: readonly string[];
}

/** A runner of the structural reset. The registry serialises calls (`apply-in-progress`). */
export type PlanningApplyRunner = (ctx: PlanningApplyContext) => Promise<Omit<PlanningApplyResult, 'generation'>>;

/** Storage for display switches (localStorage per owner in the viewer). */
export interface PlanningDisplayStorage {
  load(owner: string): Record<string, unknown> | null;
  save(owner: string, values: Record<string, PlanningValue>): void;
}

/** Problems sink (default: the problems store). */
export interface PlanningProblemSink {
  report(problem: Omit<ProblemInput, 'at'>): void;
  clear(id: string): void;
}

/** Construction options. */
export interface PlanningRegistryOptions {
  /** Current sim time in seconds (used for live changes without `onLive`). Default `() => 0`. */
  simTime?: () => number;
  problems?: PlanningProblemSink;
  displayStorage?: PlanningDisplayStorage;
  /** Runner of `applyPendingAndReset`; default = configuration-only reset (commit + `onStructuralReset`). */
  applyRunner?: PlanningApplyRunner;
  /** `documentLoadId` handed to `onStructuralReset` by the default runner. */
  documentLoadId?: () => string;
}

/** The registry (§2.4). */
export interface PlanningRegistry {
  declare(decl: PlanningDeclaration): PlanningHandle;
  list(): readonly PlanningParamState[];
  set(key: string, value: unknown, origin: PlanningOrigin): PlanningSetResult;
  setMany(values: Readonly<Record<string, unknown>>, origin: PlanningOrigin): PlanningSetManyResult;
  /** Withdraws a pending / queued value of one effective key. */
  revertPending(key: string): boolean;
  /**
   * Effective keys of `owner`'s FACTOR parameters whose effective value — the
   * pending / queued value if any, else the committed one — differs from the
   * declared default. Empty = "Reset to defaults" has nothing to do.
   */
  nonDefaultKeys(owner: string): string[];
  /**
   * "Reset to defaults" (Thomas 2026-10-26): every factor parameter of `owner`
   * back to its declared default, as ONE atomic {@link setMany} — so each
   * parameter takes its usual path: `live` ones are applied at the next sim
   * instant, `reset` ones (the PalletYard size) go pending and need the
   * structural apply (rebuild + one sim reset). Display switches are not
   * touched. Nothing to do → `{ ok: true, results: {} }`.
   */
  resetToDefaults(owner: string, origin: PlanningOrigin): PlanningSetManyResult;
  /**
   * Structural reset (§2.5a); a second call while one runs answers `apply-in-progress`.
   * `origin` (plan-2005 Phase 7, default `'ui'`) tells the experiment lock apart: while a
   * batch runs only `'experiment'` may apply — everyone else gets `experiment-running`.
   */
  applyPendingAndReset(origin?: PlanningOrigin): Promise<PlanningApplyResult>;
  /** Is a structural reset in flight right now? (Batch start check, plan-2005 Phase 7.) */
  isApplyInProgress(): boolean;
  /**
   * The same structural reset, but for ONE owner and WITHOUT pending values
   * (plan-681 Gate-R2 #4): the load-time reconciliation of a document whose
   * stored structural values do not match what the document itself carries.
   * `committed` handed to `onStructuralReset` is the owner's current `values()`.
   * Answers `unknown-owner` when nothing is declared under that name, and
   * `experiment-running` while a batch holds the lock (plan-2005 Phase 7) — the
   * caller tries again when the lock is released ({@link whenExperimentDone}).
   */
  reconcileStructure(owner: string, origin?: PlanningOrigin): Promise<PlanningApplyResult>;
  /** Resolves once no experiment batch holds the lock (immediately when none does). */
  whenExperimentDone(): Promise<void>;
  /**
   * Resolves once no structural reset runs (immediately when none does). For an owner
   * whose own reconciliation met `apply-in-progress` (plan-630 Phase 8: the `component`
   * owner's load-time write while PalletYard rebuilds) — wait, then try again.
   */
  whenApplyIdle(): Promise<void>;
  kpis(): PlanningKpiState[];
  changeLog(): readonly PlanningChange[];
  /**
   * Replay a recorded protocol in (simTime, seq) order on the owner-provided run
   * scheduler, after model events. Preserve each row exactly; bypass UI set/folding.
   * onLive receives alreadyScheduled and must apply directly. Reset drops pending
   * rows; missing owners and non-live keys warn and are skipped.
   */
  replayChanges(log: readonly PlanningChange[], schedule: (at: number, apply: () => void, opts: { afterModelEvents: boolean }) => void): void;
  subscribe(cb: () => void): () => void;
  getSnapshot(): PlanningSnapshot;

  /** A normal (toolbar) sim reset: new run, live queue dropped, pending values KEPT. */
  notifySimulationReset(): void;
  /**
   * The experiment lock (plan-2005 Phase 7): while a batch runs, every mutating entry
   * refuses an origin other than `'experiment'` with `experiment-running` — `set`,
   * `setMany`, `resetToDefaults`, `applyPendingAndReset`, `applyScenario` — and the entries
   * without an origin (`revertPending`, `loadScenario`) refuse outright. Display switches
   * (`role: 'display'`) stay free: they are views, not part of any run.
   */
  setExperimentRunning(running: boolean): void;
  /**
   * Dormant values (effective keys): scenario values whose key nobody has declared yet.
   * Kept until declared; a value the declaration rejects is dropped and reported.
   */
  dormant(): Readonly<Record<string, unknown>>;
  /**
   * Drops dormant values of the given effective keys (plan-630 Phase 8: a component
   * property taken OUT of the planning window takes its scenario value with it instead
   * of leaving an orphan behind). Returns whether anything was dropped.
   */
  forgetDormant(keys: readonly string[]): boolean;
  /**
   * The start values of a freshly loaded DOCUMENT (plan-630 §2.8): the active scenario of
   * its `PlanningScenarios` block, or `{}` for none. Replaces every dormant value (the
   * previous document's values do not leak into this one); a declared owner goes back to
   * its defaults and takes the values that are its own as COMMITTED start values (source
   * `scenario`) — invalid ones dropped and reported. Undeclared keys wait dormant. Not
   * logged: a load starts a document, not a run.
   */
  loadScenario(values: Readonly<Record<string, unknown>>): boolean;
  /**
   * Switch the session to another scenario's values (overlay, `web_scenario_load`): ONE
   * atomic {@link setMany} with the scenario's value — or the default — for every declared
   * factor parameter, so `live` values apply at the next sim instant and `reset` values go
   * pending. A value the declaration rejects is dropped (default instead) and reported.
   * Undeclared keys replace the dormant ones. A cross-rule failure changes nothing.
   * Returns `false` (nothing changed) while an experiment batch runs — the caller retries
   * when the lock is released.
   */
  applyScenario(values: Readonly<Record<string, unknown>>, origin: PlanningOrigin): PlanningSetManyResult;
  /** Reports every still-dormant key as `planning-param-orphaned` (call after `whenSceneReady`). */
  reportOrphans(): string[];
  /** Replaces the structural-reset runner (the viewer plugin installs §2.5a). */
  setApplyRunner(runner: PlanningApplyRunner | null): void;
}

// ─── Implementation ────────────────────────────────────────────────────────

interface OwnerEntry {
  decl: PlanningDeclaration;
  defs: Map<string, PlanningParamDef>;  // owner-local key → def, declaration order
  committed: Map<string, PlanningValue>;
  sources: Map<string, PlanningOrigin>;
  pending: Map<string, PlanningValue>;
  queued: Map<string, PendingLiveChange>;
  valuesCache: Readonly<Record<string, PlanningValue>> | null;
  handle: PlanningHandle;
}

const PROBLEM_DECL = 'planning-declaration-invalid';
const PROBLEM_ORPHAN = 'planning-param-orphaned';
const PROBLEM_SCENARIO = 'planning-scenario-value-invalid';
const PROBLEM_APPLY = 'planning-apply-failed';
const PROBLEM_ROLLBACK = 'planning-apply-rollback-failed';
const PROBLEM_RECOVERED = 'planning-committed-recovered';

function compareChanges(a: PlanningChange, b: PlanningChange): number {
  return a.simTime !== b.simTime ? a.simTime - b.simTime : a.seq - b.seq;
}

/**
 * Which owners one apply reconfigures, and with which values: the owners whose
 * pending values were just committed, plus the owners named in `ctx.reconcile`
 * that had nothing pending (plan-681 Gate-R2 #4 — a reconcile owner is called
 * with its CURRENT values, which is the point: the document changed, not the
 * parameter). An owner in both appears once, with its committed values, in
 * commit order first.
 *
 * Exported because the viewer-side runner (`structural-reset.ts`) walks the same
 * list: the two must never disagree about who gets called.
 */
export function structuralApplyTargets(
  ctx: Pick<PlanningApplyContext, 'valuesOf' | 'reconcile'>,
  record: PlanningCommitRecord,
): ReadonlyArray<{ owner: string; committed: Readonly<Record<string, PlanningValue>> }> {
  const out = record.changed.slice();
  const seen = new Set(out.map((c) => c.owner));
  for (const owner of ctx.reconcile) {
    if (seen.has(owner)) continue;
    seen.add(owner);
    out.push({ owner, committed: ctx.valuesOf(owner) });
  }
  return out;
}

/** The value a freshly declared parameter starts with: its `initial`, else its `default`. */
function startValueOf(def: PlanningParamDef): PlanningValue {
  return def.initial !== undefined ? def.initial : def.default;
}

/**
 * Does a committed factor value survive a retire/redeclare as a dormant value? When it
 * differs from the default OR from the start value — with an `initial`, a value set back
 * to the default would otherwise come back as the `initial` (Phase 8 review #5).
 */
function keepsAsDormant(def: PlanningParamDef, value: PlanningValue): boolean {
  return planningRoleOf(def) === 'factor' && (value !== def.default || value !== startValueOf(def));
}

/** The answer of a write the experiment lock refused: every named key `experiment-running`. */
function lockedResult(keys: readonly string[]): PlanningSetManyResult {
  const results: Record<string, PlanningSetResult> = {};
  for (const k of keys) results[k] = { ok: false, error: 'experiment-running' };
  return { ok: false, results, errors: { '': 'experiment-running' } };
}

function splitKey(effective: string): { owner: string; key: string } | null {
  const dot = effective.indexOf('.');
  if (dot <= 0 || dot === effective.length - 1) return null;
  return { owner: effective.slice(0, dot), key: effective.slice(dot + 1) };
}

const NEVER_ABORTED: AbortSignal = new AbortController().signal;

/** Creates an empty registry. */
export function createPlanningRegistry(options: PlanningRegistryOptions = {}): PlanningRegistry {
  const simTime = options.simTime ?? (() => 0);
  const problems: PlanningProblemSink = options.problems ?? {
    report: (p) => { reportProblemDefault(p); },
    clear: (id) => { clearProblemDefault(id); },
  };
  const displayStorage = options.displayStorage;
  const documentLoadId = options.documentLoadId ?? (() => '');

  const owners = new Map<string, OwnerEntry>();
  const dormantValues = new Map<string, unknown>();   // effective key → raw value
  const lastPendingOrigin = new Map<string, PlanningOrigin>(); // effective key → origin of the pending value
  const listeners = new Set<() => void>();
  let log: PlanningChange[] = [];
  let seq = 0;
  let runEpoch = 0;
  let experimentRunning = false;
  let applyInProgress = false;
  let generation = 0;
  let version = 0;
  let snapshot: PlanningSnapshot | null = null;
  let applyRunner: PlanningApplyRunner = options.applyRunner ?? defaultApplyRunner;

  // ── publishing ───────────────────────────────────────────────────────────
  function publish(): void {
    version++;
    snapshot = null;
    for (const entry of owners.values()) entry.valuesCache = null;
    for (const l of listeners) {
      try { l(); } catch { /* a subscriber must never break the registry */ }
    }
  }

  function crossErrors(entry: OwnerEntry, candidate: Map<string, PlanningValue>): Record<string, string> {
    if (!entry.decl.validate) return {};
    try {
      return entry.decl.validate(Object.freeze(Object.fromEntries(candidate))) ?? {};
    } catch (err) {
      return { '': `validate threw: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  /** committed overlaid by queued and pending — the state a new write is checked against. */
  function effectiveState(entry: OwnerEntry): Map<string, PlanningValue> {
    const m = new Map(entry.committed);
    for (const [k, c] of entry.queued) m.set(k, c.to);
    for (const [k, v] of entry.pending) m.set(k, v);
    return m;
  }

  function buildSnapshot(): PlanningSnapshot {
    const params: PlanningParamState[] = [];
    let pendingCount = 0;
    for (const entry of owners.values()) {
      const errs = crossErrors(entry, effectiveState(entry));
      for (const [key, def] of entry.defs) {
        const state: PlanningParamState = {
          owner: entry.decl.owner,
          key: effectivePlanningKey(entry.decl.owner, key),
          def,
          role: planningRoleOf(def),
          apply: def.apply,
          value: entry.committed.get(key) as PlanningValue,
          source: entry.sources.get(key) ?? 'default',
        };
        if (entry.pending.has(key)) {
          state.pending = entry.pending.get(key);
          state.pendingKind = 'reset';
          pendingCount++;
        } else if (entry.queued.has(key)) {
          state.pending = entry.queued.get(key)!.to;
          state.pendingKind = 'live';
        }
        if (errs[key]) state.error = errs[key];
        params.push(state);
      }
    }
    return Object.freeze({
      version,
      owners: Object.freeze([...owners.values()].map((e) => ({ owner: e.decl.owner, title: e.decl.title }))),
      params: Object.freeze(params),
      pendingCount,
      changeLog: Object.freeze(log.slice()),
      experimentRunning,
    });
  }

  function appendLog(change: PlanningChange): void {
    // Insert sorted by (simTime, seq): an owner may report two same-instant changes out of order.
    let i = log.length;
    while (i > 0 && compareChanges(log[i - 1], change) > 0) i--;
    log.splice(i, 0, change);
  }

  // ── declare / redeclare ─────────────────────────────────────────────────
  function reportDeclarationErrors(owner: string, errs: ReturnType<typeof parsePlanningDeclaration>['errors']): void {
    for (const e of errs) {
      problems.report({
        id: `${PROBLEM_DECL}:${owner}:${e.key ?? ''}:${e.code}`,
        severity: 'warning',
        code: PROBLEM_DECL,
        title: `Planning parameter declaration of '${owner}' is invalid`,
        detail: e.message,
      });
    }
  }

  /** Fills `defs`, keeps values of still-declared keys, moves values of dropped keys to dormant,
   *  then applies dormant values of the (new) keys. */
  function installParams(entry: OwnerEntry, params: readonly PlanningParamDef[]): void {
    const owner = entry.decl.owner;
    const next = new Map<string, PlanningParamDef>();
    for (const p of params) next.set(p.key, p);

    for (const [key, value] of entry.committed) {
      const def = entry.defs.get(key);
      if (!next.has(key) && def && keepsAsDormant(def, value)) {
        dormantValues.set(effectivePlanningKey(owner, key), value);
      }
    }
    const committed = new Map<string, PlanningValue>();
    const sources = new Map<string, PlanningOrigin>();
    const pending = new Map<string, PlanningValue>();
    const queued = new Map<string, PendingLiveChange>();
    for (const [key, def] of next) {
      const prev = entry.committed.get(key);
      const keep = prev !== undefined && checkPlanningValue(def, prev).ok;
      // A NEW key starts at its `initial` (Phase 8, §2.14) — committed, source `default`,
      // no pending value, no log row: declaring changes nothing about the running model.
      committed.set(key, keep ? prev! : startValueOf(def));
      sources.set(key, keep ? entry.sources.get(key) ?? 'default' : 'default');
      const pend = entry.pending.get(key);
      if (pend !== undefined && checkPlanningValue(def, pend).ok) pending.set(key, pend);
      const q = entry.queued.get(key);
      if (q !== undefined && checkPlanningValue(def, q.to).ok) queued.set(key, q);
    }
    entry.defs = next;
    entry.committed = committed;
    entry.sources = sources;
    entry.pending = pending;
    entry.queued = queued;

    // Display switches: restore from storage.
    const stored = displayStorage?.load(owner) ?? null;
    if (stored) {
      for (const [key, def] of next) {
        if (planningRoleOf(def) !== 'display' || !(key in stored)) continue;
        const r = checkPlanningValue(def, stored[key]);
        if (r.ok) committed.set(key, r.value);
      }
    }

    applyDormant(entry);
  }

  function applyDormant(entry: OwnerEntry): void {
    const owner = entry.decl.owner;
    const taken = new Map<string, PlanningValue>();
    for (const [key, def] of entry.defs) {
      const eff = effectivePlanningKey(owner, key);
      if (!dormantValues.has(eff) || planningRoleOf(def) !== 'factor') continue;
      const r = checkPlanningValue(def, dormantValues.get(eff));
      if (r.ok) {
        taken.set(key, r.value);
        problems.clear(`${PROBLEM_SCENARIO}:${eff}`);
      } else {
        // Dropped, never clamped (plan-630 Phase 3): the default stays in effect and a later
        // save does not write the value back.
        dormantValues.delete(eff);
        problems.report({
          id: `${PROBLEM_SCENARIO}:${eff}`,
          severity: 'warning',
          code: PROBLEM_SCENARIO,
          title: `Scenario value of '${eff}' is not valid — dropped`,
          detail: `${r.error}. The default ${String(def.default)} is used instead.`,
        });
      }
    }
    if (taken.size === 0) return;
    const candidate = new Map(entry.committed);
    for (const [k, v] of taken) candidate.set(k, v);
    const errs = crossErrors(entry, candidate);
    let crossError = '';
    if (Object.values(errs).some(Boolean)) {
      // Drop the named values first, then check that the surviving set is valid.
      for (const key of taken.keys()) {
        if (errs[key]) candidate.set(key, entry.committed.get(key)!);
      }
      crossError = Object.values(crossErrors(entry, candidate)).filter(Boolean).join('; ');
    }
    for (const [key, value] of taken) {
      const eff = effectivePlanningKey(owner, key);
      const error = errs[key] || crossError;
      if (error) {
        dormantValues.delete(eff);
        problems.report({
          id: `${PROBLEM_SCENARIO}:${eff}`,
          severity: 'warning',
          code: PROBLEM_SCENARIO,
          title: `Scenario value of '${eff}' violates a rule — dropped`,
          detail: error,
        });
        continue; // dropped, the default stays in effect
      }
      entry.committed.set(key, value);
      entry.sources.set(key, 'scenario');
      dormantValues.delete(eff);
      problems.clear(`${PROBLEM_ORPHAN}:${eff}`);
    }
  }

  function makeHandle(entry: OwnerEntry): PlanningHandle {
    return {
      values() {
        if (!entry.valuesCache) entry.valuesCache = Object.freeze(Object.fromEntries(entry.committed));
        return entry.valuesCache;
      },
      get<T extends PlanningValue>(key: string): T {
        return entry.committed.get(key) as T;
      },
      commitPending() {
        if (owners.get(entry.decl.owner) !== entry || entry.pending.size === 0) return;
        commitOwner(entry);
        publish();
      },
      recoverCommitted(values) {
        const owner = entry.decl.owner;
        const fail = (error: string) => {
          problems.report({ id: `${PROBLEM_RECOVERED}:${owner}`, severity: 'error', code: 'planning-committed-recovery-failed',
            title: `Planning values of '${owner}' not recovered`, detail: error });
          return { ok: false, reset: [], error };
        };
        if (owners.get(owner) !== entry) return fail('not declared');
        const cand = new Map(entry.committed);
        for (const [key, raw] of Object.entries(values)) {
          const def = entry.defs.get(key);
          const r = def ? checkPlanningValue(def, raw) : null;
          if (!r?.ok) return fail(`${key}: ${r ? r.error : 'unknown key'}`);
          cand.set(key, r.value);
        }
        const reset = new Set<string>();
        for (let pass = 0; ; pass++) {
          const bad = Object.entries(crossErrors(entry, cand)).filter(([, e]) => e);
          if (!bad.length) break;
          for (const [key, e] of bad) {
            const def = entry.defs.get(key);
            if (pass > 8 || !def || key in values || planningRoleOf(def) !== 'factor' || cand.get(key) === def.default) return fail(`${key || owner}: ${e}`);
            cand.set(key, def.default);
            reset.add(key);
          }
        }
        for (const [key, v] of cand) {
          if (entry.committed.get(key) === v) continue;
          entry.committed.set(key, v);
          entry.sources.set(key, 'default');
        }
        problems.report({ id: `${PROBLEM_RECOVERED}:${owner}`, severity: 'warning', code: PROBLEM_RECOVERED,
          title: `Planning values of '${owner}' recovered`,
          detail: `${JSON.stringify(values)}${reset.size ? `; default: ${[...reset].join(', ')}` : ''}` });
        publish();
        return { ok: true, reset: [...reset] };
      },
      redeclare(params) {
        if (owners.get(entry.decl.owner) !== entry) return;
        const parsed = parsePlanningDeclaration({ ...entry.decl, params });
        reportDeclarationErrors(entry.decl.owner, parsed.errors);
        installParams(entry, parsed.declaration?.params ?? []);
        entry.decl = { ...entry.decl, params: parsed.declaration?.params ?? [] };
        publish();
      },
      dispose() {
        if (owners.get(entry.decl.owner) !== entry) return;
        retire(entry);
        publish();
      },
    };
  }

  /** Moves non-default committed factor values to dormant and removes the owner. */
  function retire(entry: OwnerEntry): void {
    const owner = entry.decl.owner;
    for (const [key, value] of entry.committed) {
      const def = entry.defs.get(key);
      if (def && keepsAsDormant(def, value)) {
        dormantValues.set(effectivePlanningKey(owner, key), value);
      }
    }
    owners.delete(owner);
    problems.clear(`${PROBLEM_RECOVERED}:${owner}`);
  }

  function inertHandle(): PlanningHandle {
    const empty = Object.freeze({}) as Readonly<Record<string, PlanningValue>>;
    return {
      values: () => empty,
      get: <T extends PlanningValue>() => undefined as unknown as T,
      commitPending: () => {},
      recoverCommitted: () => ({ ok: false, reset: [], error: 'not declared' }),
      redeclare: () => {},
      dispose: () => {},
    };
  }

  // ── commit ───────────────────────────────────────────────────────────────
  function commitOwner(entry: OwnerEntry): void {
    const owner = entry.decl.owner;
    for (const [key, value] of entry.pending) {
      const from = entry.committed.get(key) as PlanningValue;
      entry.committed.set(key, value);
      entry.sources.set(key, lastPendingOrigin.get(effectivePlanningKey(owner, key)) ?? 'ui');
      appendLog({ simTime: 0, seq: seq++, key: effectivePlanningKey(owner, key), from, to: value, origin: entry.sources.get(key)! });
      lastPendingOrigin.delete(effectivePlanningKey(owner, key));
    }
    entry.pending.clear();
  }

  function commitAllPending(): PlanningCommitRecord {
    const restore: Array<PlanningCommitRecord['_restore'][number]> = [];
    const changed: Array<{ owner: string; committed: Readonly<Record<string, PlanningValue>> }> = [];
    const logLength = log.length;
    for (const entry of owners.values()) {
      if (entry.pending.size === 0) continue;
      restore.push({
        owner: entry.decl.owner,
        committed: new Map(entry.committed),
        pending: new Map(entry.pending),
        sources: new Map(entry.sources),
      });
      commitOwner(entry);
      changed.push({ owner: entry.decl.owner, committed: Object.freeze(Object.fromEntries(entry.committed)) });
    }
    if (restore.length > 0) publish();
    return { changed, _restore: restore, _logLength: logLength };
  }

  function revertCommit(record: PlanningCommitRecord): void {
    for (const r of record._restore) {
      const entry = owners.get(r.owner);
      if (!entry) continue;
      entry.committed = new Map(r.committed);
      entry.pending = new Map(r.pending);
      entry.sources = new Map(r.sources);
    }
    log = log.slice(0, Math.min(record._logLength, log.length));
    publish();
  }

  function startNewRun(): void {
    runEpoch++;
    log = [];
    seq = 0;
    for (const entry of owners.values()) entry.queued.clear();
    publish();
  }

  // ── default runner: configuration-only structural reset ──────────────────
  async function defaultApplyRunner(ctx: PlanningApplyContext): Promise<Omit<PlanningApplyResult, 'generation'>> {
    ctx.startNewRun();
    const record = ctx.commitAllPending();
    const resetCtx: StructuralResetContext = {
      documentLoadId: documentLoadId(),
      awaitPlacements: () => Promise.resolve(),
      signal: NEVER_ABORTED,
    };
    try {
      for (const { owner, committed } of structuralApplyTargets(ctx, record)) {
        await ctx.declarationOf(owner)?.onStructuralReset?.(committed, resetCtx);
      }
      problems.clear(PROBLEM_APPLY);
      return { ok: true };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      ctx.revertCommit(record);
      ctx.report({ id: PROBLEM_APPLY, severity: 'error', code: PROBLEM_APPLY, title: 'Applying planning parameters failed', detail });
      try {
        for (const r of record._restore) {
          await ctx.declarationOf(r.owner)?.onStructuralReset?.(ctx.valuesOf(r.owner), resetCtx);
        }
      } catch (rollbackErr) {
        ctx.report({
          id: PROBLEM_ROLLBACK,
          severity: 'error',
          code: PROBLEM_ROLLBACK,
          title: 'Restoring the previous planning configuration failed — reload the document',
          detail: rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr),
        });
      }
      return { ok: false, error: 'materialize-failed', detail };
    }
  }

  /** Owners of the apply currently in flight that must run without pending values. */
  let reconcileOwners: readonly string[] = [];

  const applyContext: PlanningApplyContext = {
    startNewRun,
    commitAllPending,
    revertCommit,
    declarationOf: (owner) => owners.get(owner)?.decl,
    valuesOf: (owner) => {
      const e = owners.get(owner);
      return e ? e.handle.values() : Object.freeze({});
    },
    report: (p) => problems.report(p),
    get reconcile() { return reconcileOwners; },
  };

  /** The one serialised entry into the runner; `reconcile` scopes it to one owner. */
  /** Resolves when the apply in flight has finished (immediately when none runs). */
  let applyIdle: Promise<void> = Promise.resolve();

  async function runApply(reconcile: readonly string[]): Promise<PlanningApplyResult> {
    if (applyInProgress) return { ok: false, generation, error: 'apply-in-progress' };
    // Committed may have moved under a pending value (`recoverCommitted`): the whole
    // candidate is checked before anything is committed; refused = nothing changes.
    for (const entry of owners.values()) {
      if (!entry.pending.size) continue;
      const cand = new Map([...entry.committed, ...entry.pending]);
      const bad = Object.entries(crossErrors(entry, cand)).filter(([, e]) => e);
      if (!bad.length) continue;
      const detail = `${entry.decl.owner}: ${bad.map(([k, e]) => `${k} ${e}`).join('; ')}`;
      problems.report({ id: PROBLEM_APPLY, severity: 'error', code: PROBLEM_APPLY, title: 'Applying planning parameters failed', detail });
      return { ok: false, generation, error: 'invalid-values', detail };
    }
    applyInProgress = true;
    reconcileOwners = reconcile;
    let release!: () => void;
    applyIdle = new Promise<void>((resolve) => { release = resolve; });
    try {
      const r = await applyRunner(applyContext);
      if (r.ok) {
        generation++;
        for (const o of owners.keys()) problems.clear(`${PROBLEM_RECOVERED}:${o}`);
      }
      return { ...r, generation };
    } catch (err) {
      return { ok: false, generation, error: 'materialize-failed', detail: err instanceof Error ? err.message : String(err) };
    } finally {
      applyInProgress = false;
      reconcileOwners = [];
      release();
    }
  }

  // ── writes ───────────────────────────────────────────────────────────────
  function setMany(values: Readonly<Record<string, unknown>>, origin: PlanningOrigin): PlanningSetManyResult {
    // plan-2013 §2.6 (Gate R2 #5): a variant's values are in the scene — the same fields
    // must not get a second truth through this registry. Nothing is written.
    if (isVariantInScene()) {
      const refused: Record<string, PlanningSetResult> = {};
      for (const k of Object.keys(values)) refused[k] = { ok: false, error: 'variant-active' };
      return { ok: false, results: refused, errors: { '': 'variant-active' } };
    }
    const results: Record<string, PlanningSetResult> = {};
    let failed = false;
    type Planned = { entry: OwnerEntry; key: string; def: PlanningParamDef; value: PlanningValue };
    const planned: Planned[] = [];
    const dormantPlanned: Array<[string, unknown]> = [];

    for (const [effKey, raw] of Object.entries(values)) {
      const parts = splitKey(effKey);
      const entry = parts ? owners.get(parts.owner) : undefined;
      const def = entry && parts ? entry.defs.get(parts.key) : undefined;
      if (!entry || !def || !parts) {
        if (origin === 'scenario' && parts) {
          dormantPlanned.push([effKey, raw]);
          results[effKey] = { ok: true, applied: 'dormant' };
        } else {
          results[effKey] = { ok: false, error: 'unknown-key' };
          failed = true;
        }
        continue;
      }
      if (experimentRunning && origin !== 'experiment' && planningRoleOf(def) === 'factor') {
        results[effKey] = { ok: false, error: 'experiment-running' };
        failed = true;
        continue;
      }
      const r = checkPlanningValue(def, raw);
      if (!r.ok) {
        results[effKey] = { ok: false, error: r.error };
        failed = true;
        continue;
      }
      planned.push({ entry, key: parts.key, def, value: r.value });
    }

    // Cross rules on the full candidate per affected owner.
    const extraErrors: Record<string, string> = {};
    const affected = new Set(planned.map((p) => p.entry));
    for (const entry of affected) {
      const candidate = effectiveState(entry);
      for (const p of planned) if (p.entry === entry) candidate.set(p.key, p.value);
      const errs = crossErrors(entry, candidate);
      for (const [key, msg] of Object.entries(errs)) {
        if (!msg) continue;
        const eff = key === '' ? entry.decl.owner : effectivePlanningKey(entry.decl.owner, key);
        if (results[eff] || planned.some((p) => p.entry === entry && p.key === key)) {
          results[eff] = { ok: false, error: msg };
        } else {
          extraErrors[eff] = msg;
        }
        failed = true;
      }
    }

    if (failed) {
      for (const p of planned) {
        const eff = effectivePlanningKey(p.entry.decl.owner, p.key);
        if (!results[eff]) results[eff] = { ok: false, error: 'not-applied' };
      }
      for (const [eff] of dormantPlanned) results[eff] = { ok: false, error: 'not-applied' };
      return Object.keys(extraErrors).length > 0
        ? { ok: false, results, errors: extraErrors }
        : { ok: false, results };
    }

    // Commit the write.
    let changed = dormantPlanned.length > 0;
    for (const [eff, raw] of dormantPlanned) dormantValues.set(eff, raw);
    const liveCalls: Array<{ entry: OwnerEntry; change: PendingLiveChange }> = [];
    const displayOwners = new Set<OwnerEntry>();

    for (const p of planned) {
      const { entry, key, def, value } = p;
      const eff = effectivePlanningKey(entry.decl.owner, key);
      const committed = entry.committed.get(key) as PlanningValue;
      const role = planningRoleOf(def);

      if (role === 'display') {
        if (committed === value) { results[eff] = { ok: true, applied: 'unchanged' }; continue; }
        entry.committed.set(key, value);
        entry.sources.set(key, origin);
        displayOwners.add(entry);
        results[eff] = { ok: true, applied: 'display' };
        changed = true;
        continue;
      }

      // Experiment: every factor (live included) becomes a start value at the structural reset.
      const asPending = def.apply === 'reset' || origin === 'experiment';
      if (asPending) {
        entry.queued.delete(key);
        if (value === committed) {
          const had = entry.pending.delete(key);
          lastPendingOrigin.delete(eff);
          results[eff] = { ok: true, applied: had ? 'reverted' : 'unchanged' };
          changed = changed || had;
          continue;
        }
        if (entry.pending.get(key) === value) { results[eff] = { ok: true, applied: 'pending' }; continue; }
        entry.pending.set(key, value);
        lastPendingOrigin.set(eff, origin);
        results[eff] = { ok: true, applied: 'pending' };
        changed = true;
        continue;
      }

      // live
      const queuedNow = entry.queued.get(key);
      if (value === committed && !queuedNow) { results[eff] = { ok: true, applied: 'unchanged' }; continue; }
      if (queuedNow && queuedNow.to === value) { results[eff] = { ok: true, applied: 'queued' }; continue; }
      if (value === committed && queuedNow) {
        entry.queued.delete(key);
        results[eff] = { ok: true, applied: 'reverted' };
        changed = true;
        continue;
      }
      if (entry.decl.onLive) {
        const change: PendingLiveChange = Object.freeze({ key, effectiveKey: eff, from: committed, to: value, origin, seq: seq++ });
        entry.queued.set(key, change); // folds an unapplied change of the same key
        liveCalls.push({ entry, change });
        results[eff] = { ok: true, applied: 'queued' };
      } else {
        entry.committed.set(key, value);
        entry.sources.set(key, origin);
        appendLog({ simTime: simTime(), seq: seq++, key: eff, from: committed, to: value, origin });
        results[eff] = { ok: true, applied: 'applied' };
      }
      changed = true;
    }

    for (const entry of displayOwners) {
      if (!displayStorage) continue;
      const stored: Record<string, PlanningValue> = {};
      for (const [key, def] of entry.defs) {
        if (planningRoleOf(def) === 'display') stored[key] = entry.committed.get(key) as PlanningValue;
      }
      try { displayStorage.save(entry.decl.owner, stored); } catch { /* storage may be unavailable */ }
    }

    if (changed) publish();

    // onLive after publishing: the owner may answer synchronously with applied(t).
    for (const { entry, change } of liveCalls) {
      try {
        entry.decl.onLive!(change, (t: number) => applyLive(entry, change, t), () => isLiveValid(entry, change));
      } catch (err) {
        problems.report({
          id: `${PROBLEM_APPLY}:live:${change.effectiveKey}`,
          severity: 'error',
          code: PROBLEM_APPLY,
          title: `Live change of '${change.effectiveKey}' failed`,
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return { ok: true, results };
  }

  function isLiveValid(entry: OwnerEntry, change: PendingLiveChange): boolean {
    return owners.get(entry.decl.owner) === entry && entry.queued.get(change.key) === change;
  }

  function applyLive(entry: OwnerEntry, change: PendingLiveChange, t: number): void {
    // Superseded (folded), dropped by a reset, or owner re-declared: the change has expired.
    if (!isLiveValid(entry, change)) return;
    entry.queued.delete(change.key);
    const from = entry.committed.get(change.key) as PlanningValue;
    entry.committed.set(change.key, change.to);
    entry.sources.set(change.key, change.origin);
    appendLog({ simTime: t, seq: change.seq, key: change.effectiveKey, from, to: change.to, origin: change.origin });
    publish();
  }

  // ── registry object ──────────────────────────────────────────────────────
  const registry: PlanningRegistry = {
    replayChanges(rows, schedule) {
      const epoch = runEpoch;
      for (const row of rows.map(row => ({ ...row })).sort(compareChanges)) {
        const parts = splitKey(row.key);
        const entry = parts && owners.get(parts.owner);
        const def = entry && parts && entry.defs.get(parts.key);
        const eligible = () => !!(parts && entry && owners.get(parts.owner) === entry
          && entry.defs.get(parts.key) === def && def?.apply === 'live' && planningRoleOf(def) === 'factor');
        const warn = () => console.warn(`Planning replay skipped ${row.key}: owner missing or key is not live`);
        if (!eligible() || !entry || !parts) { warn(); continue; }
        seq = Math.max(seq, row.seq + 1);
        schedule(row.simTime, () => {
          if (epoch !== runEpoch) return;
          if (!eligible()) { warn(); return; }
          let done = false;
          const valid = () => epoch === runEpoch && eligible() && !done;
          const applied = () => {
            if (!valid()) return;
            done = true;
            entry.committed.set(parts.key, row.to);
            entry.sources.set(parts.key, row.origin);
            appendLog({ ...row });
            publish();
          };
          const change: PendingLiveChange = { ...row, key: parts.key, effectiveKey: row.key };
          if (entry.decl.onLive) entry.decl.onLive(change, applied, valid, { alreadyScheduled: true });
          else applied();
        }, { afterModelEvents: true });
      }
    },
    declare(input) {
      const parsed = parsePlanningDeclaration(input);
      const owner = parsed.declaration?.owner ?? String((input as { owner?: unknown } | null)?.owner ?? '');
      reportDeclarationErrors(owner, parsed.errors);
      if (!parsed.declaration) return inertHandle();
      const decl = parsed.declaration;
      const previous = owners.get(decl.owner);
      if (previous) retire(previous);
      const entry: OwnerEntry = {
        decl,
        defs: new Map(),
        committed: new Map(),
        sources: new Map(),
        pending: new Map(),
        queued: new Map(),
        valuesCache: null,
        handle: null as unknown as PlanningHandle,
      };
      entry.handle = makeHandle(entry);
      owners.set(decl.owner, entry);
      installParams(entry, decl.params);
      publish();
      return entry.handle;
    },

    list() {
      return registry.getSnapshot().params;
    },

    set(key, value, origin) {
      const r = setMany({ [key]: value }, origin);
      return r.results[key] ?? { ok: false, error: 'not-applied' };
    },

    setMany,

    nonDefaultKeys(owner) {
      const entry = owners.get(owner);
      if (!entry) return [];
      const out: string[] = [];
      for (const [key, def] of entry.defs) {
        if (planningRoleOf(def) !== 'factor') continue;
        const effective = entry.pending.has(key) ? entry.pending.get(key)
          : entry.queued.has(key) ? entry.queued.get(key)!.to
          : entry.committed.get(key);
        if (effective !== def.default) out.push(effectivePlanningKey(owner, key));
      }
      return out;
    },

    resetToDefaults(owner, origin) {
      if (experimentRunning && origin !== 'experiment') return lockedResult(registry.nonDefaultKeys(owner));
      const entry = owners.get(owner);
      const values: Record<string, unknown> = {};
      for (const eff of registry.nonDefaultKeys(owner)) {
        const def = entry!.defs.get(splitKey(eff)!.key)!;
        values[eff] = def.default;
      }
      if (Object.keys(values).length === 0) return { ok: true, results: {} };
      return setMany(values, origin);
    },

    revertPending(key) {
      if (experimentRunning) return false;
      const parts = splitKey(key);
      const entry = parts ? owners.get(parts.owner) : undefined;
      if (!entry || !parts) return false;
      const had = entry.pending.delete(parts.key) || entry.queued.delete(parts.key);
      lastPendingOrigin.delete(key);
      if (had) publish();
      return had;
    },

    applyPendingAndReset(origin = 'ui') {
      if (isVariantInScene()) return Promise.resolve({ ok: false, generation, error: 'variant-active' });
      if (experimentRunning && origin !== 'experiment') {
        return Promise.resolve({ ok: false, generation, error: 'experiment-running' });
      }
      return runApply([]);
    },

    isApplyInProgress() {
      return applyInProgress;
    },

    reconcileStructure(owner, origin = 'ui') {
      if (!owners.has(owner)) return Promise.resolve({ ok: false, generation, error: 'unknown-owner' });
      if (isVariantInScene()) return Promise.resolve({ ok: false, generation, error: 'variant-active' });
      if (experimentRunning && origin !== 'experiment') {
        return Promise.resolve({ ok: false, generation, error: 'experiment-running' });
      }
      return runApply([owner]);
    },

    whenExperimentDone() {
      if (!experimentRunning) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const off = registry.subscribe(() => { if (!experimentRunning) { off(); resolve(); } });
      });
    },

    whenApplyIdle() {
      return applyInProgress ? applyIdle : Promise.resolve();
    },

    kpis() {
      const out: PlanningKpiState[] = [];
      for (const entry of owners.values()) {
        for (const k of entry.decl.kpis ?? []) {
          let value: number | null;
          try {
            const v = k.read();
            value = typeof v === 'number' && Number.isFinite(v) ? v : null;
          } catch {
            value = null;
          }
          out.push({
            owner: entry.decl.owner,
            key: effectivePlanningKey(entry.decl.owner, k.key),
            label: k.label,
            unit: k.unit,
            kind: k.kind,
            decimals: k.decimals,
            value,
          });
        }
      }
      return out;
    },

    changeLog() {
      return registry.getSnapshot().changeLog;
    },

    subscribe(cb) {
      listeners.add(cb);
      return () => { listeners.delete(cb); };
    },

    getSnapshot() {
      if (!snapshot) snapshot = buildSnapshot();
      return snapshot;
    },

    notifySimulationReset() {
      startNewRun();
    },

    setExperimentRunning(running) {
      if (experimentRunning === running) return;
      experimentRunning = running;
      publish();
    },

    dormant() {
      return Object.freeze(Object.fromEntries(dormantValues));
    },

    forgetDormant(keys) {
      let dropped = false;
      for (const key of keys) {
        if (dormantValues.delete(key)) {
          dropped = true;
          problems.clear(`${PROBLEM_ORPHAN}:${key}`);
        }
      }
      if (dropped) publish();
      return dropped;
    },

    loadScenario(values) {
      if (experimentRunning) return false;
      dormantValues.clear();
      for (const [eff, raw] of Object.entries(values)) {
        if (splitKey(eff)) dormantValues.set(eff, raw);
      }
      for (const entry of owners.values()) {
        for (const [key, def] of entry.defs) {
          if (planningRoleOf(def) !== 'factor') continue;
          entry.committed.set(key, startValueOf(def));
          entry.sources.set(key, 'default');
          entry.pending.delete(key);
          entry.queued.delete(key);
          lastPendingOrigin.delete(effectivePlanningKey(entry.decl.owner, key));
        }
        applyDormant(entry);
      }
      publish();
      return true;
    },

    applyScenario(values, origin) {
      if (experimentRunning && origin !== 'experiment') return lockedResult(Object.keys(values));
      const request: Record<string, unknown> = {};
      const undeclared: Record<string, unknown> = {};
      for (const [eff, raw] of Object.entries(values)) {
        const parts = splitKey(eff);
        if (!parts) continue;
        const def = owners.get(parts.owner)?.defs.get(parts.key);
        if (!def) { undeclared[eff] = raw; continue; }
        if (planningRoleOf(def) !== 'factor') continue;
        const r = checkPlanningValue(def, raw);
        if (!r.ok) {
          problems.report({
            id: `${PROBLEM_SCENARIO}:${eff}`,
            severity: 'warning',
            code: PROBLEM_SCENARIO,
            title: `Scenario value of '${eff}' is not valid — dropped`,
            detail: `${r.error}. The default ${String(def.default)} is used instead.`,
          });
          continue;
        }
        request[eff] = r.value;
      }
      for (const entry of owners.values()) {
        for (const [key, def] of entry.defs) {
          if (planningRoleOf(def) !== 'factor') continue;
          const eff = effectivePlanningKey(entry.decl.owner, key);
          if (!(eff in request)) request[eff] = def.default;
        }
      }
      // Undeclared keys ride along as 'scenario' (→ dormant); declared ones take the caller's origin.
      const result = setMany(request, origin);
      if (!result.ok) return result;
      const parked = Object.keys(undeclared).length > 0 ? setMany(undeclared, 'scenario') : null;
      let dropped = false;
      for (const eff of [...dormantValues.keys()]) {
        if (!(eff in undeclared)) { dormantValues.delete(eff); dropped = true; }
      }
      if (dropped) publish();
      return parked ? { ok: true, results: { ...result.results, ...parked.results } } : result;
    },

    reportOrphans() {
      const keys = [...dormantValues.keys()];
      for (const eff of keys) {
        problems.report({
          id: `${PROBLEM_ORPHAN}:${eff}`,
          severity: 'warning',
          code: PROBLEM_ORPHAN,
          title: `Planning value '${eff}' has no declared parameter`,
          detail: `The scenario sets '${eff}', but no loaded model declares it. The value is kept.`,
        });
      }
      return keys;
    },

    setApplyRunner(runner) {
      applyRunner = runner ?? defaultApplyRunner;
    },
  };
  return registry;
}
