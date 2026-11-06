// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import type { WaitEdge, WaitEdgeSource } from '../../diagnostics/rv-wait-registry';
/**
 * wait-watch.ts — wait states report themselves (plan-559 §2.4, F8). Pure:
 * no Three/DOM; time comes from the injected {@link SimClock}, problems go to
 * an injected {@link WaitProblemSink}.
 *
 * Per wait `kind` (`fork`, `target`, `exit`, …) the watch keeps a counter, the
 * accumulated and the maximal duration in SIMULATION seconds and the number of
 * limit hits. A wait that is still active when the clock reaches
 * `start + limit` raises exactly ONE Problems entry
 * `fleet-wait-timeout:<vehicle>:<kind>`; it is cleared when that wait ends.
 * The limit is the step's `waitLimitSec` (passed to {@link WaitWatch.begin}),
 * else the default (`Fleet.WaitLimitSec`). A limit <= 0 or non-finite never
 * reports.
 *
 * Passive waits are checked at existing events / frames. Scheduled waits keep
 * their legacy limit events, including no-op events with cancelOnEnd: false.
 */

import type { JsonValue } from '../../material-flow/material-flow-self';
import type { ClockHandle, SimClock } from '../core/sim-clock';
import { copyHandle, validHandle, integer, validateShape, exportNumber, importNumber, validNumber, type StateNumber } from '../core/source-state';
import { clearProblem, reportProblem } from '../../hmi/problems-store';

/** Problems code of a wait over its limit. */
export const FLEET_WAIT_TIMEOUT_CODE = 'fleet-wait-timeout';

/** Stable Problems id of the wait `kind` of `vehicle`. */
export function waitTimeoutProblemId(vehicle: string, kind: string): string {
  return `${FLEET_WAIT_TIMEOUT_CODE}:${vehicle}:${kind}`;
}

/** `ownerMUs`: the owners are MU ids (an occupied drop input), not vehicles - never mapped onto units. */
export interface WaitCause { order?: string; waitingFor: string; heldBy?: string; extra?: string; waiterId?: string; resourceId?: string; ownerIds?: string[]; nodePath?: string; ownerMUs?: boolean }
export function formatWaitCause(vehicle: string, cause: WaitCause): string {
  return `Vehicle: ${vehicle}\nOrder: ${cause.order ?? 'none'}\nWaiting for: ${cause.waitingFor}\nHeld by: ${cause.heldBy ?? 'unknown'}`
    + (cause.extra ? `\n${cause.extra}` : '');
}
const STATUS_WAIT_ORDER = ['fork', 'exit', 'target', 'charge', 'standstill'] as const;

/** What the watch hands to the Problems list. */
export interface WaitProblem {
  readonly id: string;
  readonly code: string;
  readonly severity: 'warning';
  readonly title: string;
  readonly detail: string;
}

/** Injected Problems sink (report / clear by id). */
export interface WaitProblemSink {
  report(p: WaitProblem): void;
  clear(id: string): void;
}

/** Default sink: the viewer's Problems store (React-/DOM-free module). */
export const problemsStoreWaitSink: WaitProblemSink = {
  report: (p) => { reportProblem(p); },
  clear: (id) => { clearProblem(id); },
};

/** Counters of one wait kind (fleet-wide). */
export interface WaitKindStats {
  /** Waits begun. */
  count: number;
  /** Waits currently active. */
  active: number;
  /** Sum of the durations of ENDED waits (sim-s). */
  totalSec: number;
  /** Longest ENDED wait (sim-s). */
  maxSec: number;
  /** Waits that reached their limit. */
  timeouts: number;
}

interface ActiveWait {
  vehicle: string;
  kind: string;
  active: boolean;
  start: number;
  pausedAt: number | null;
  /** Episode memory: once a foreign blocker is seen, keep it until resume. Missing in older snapshots means self. */
  pauseReason?: 'self' | 'blocker';
  limit: number;
  handle: ClockHandle | null;
  reported: boolean;
  /** Bumped per begin — a stale clock callback compares it. */
  token: number;
  /** Extra detail for the Problems entry (read at the timeout). */
  desc: JsonValue;
  /** Detected by {@link WaitWatch.poll} only - no clock event. */
  passive: boolean;
  lastTimeout: WaitProblem | null;
}

/** Options of a {@link WaitWatch}. */
export interface WaitResolver {
  detail(vehicle: string, kind: string, desc: JsonValue): WaitCause | string | undefined;
  valid(vehicle: string, kind: string, desc: JsonValue): boolean;
  /** Last chance to pause a due wait, without mutating read-only validity / edge queries. */
  beforeTimeout?(vehicle: string, kind: string, desc: JsonValue): void;
}

export interface WaitWatchOptions {
  readonly clock: SimClock;
  /** Default limit (sim-s) when a wait brings none (`Fleet.WaitLimitSec`). */
  readonly defaultLimitSec: number;
  /** Problems sink; default {@link problemsStoreWaitSink}. */
  readonly problems?: WaitProblemSink;
  /** Cancel the limit event when a wait ends (default true); false = it fires as a no-op. */
  readonly cancelOnEnd?: boolean;
  /** Called once when a wait reaches its limit (before the Problems entry). */
  readonly onTimeout?: (vehicle: string, kind: string, limitSec: number) => void;
}

function isJson(v: unknown): v is JsonValue {
  return v === null || typeof v === 'string' || typeof v === 'boolean' || typeof v === 'number' && Number.isFinite(v)
    || Array.isArray(v) && v.every(isJson) || !!v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype && Object.values(v).every(isJson);
}

/** The generic watcher of all wait states (plan-559 F8). */
export class WaitWatch implements WaitEdgeSource {
  readonly id = 'fleet';
  /** Waiters and vehicle owners are fleet ids: the registry maps DES-bound ones onto their units (plan-2241). */
  readonly vehicles = true;

  /** Read-only pull: do not poll deadlines or invalidate waits while diagnosing. */
  edges(_now: number): readonly WaitEdge[] {
    const out: WaitEdge[] = [];
    for (const waits of this.waits.values()) for (const w of waits.values()) {
      if (!w.active || !this.valid(w)) continue;
      const cause = this.detail(w);
      if (!cause || typeof cause === 'string' || !cause.resourceId) continue;
      out.push({ waiterId: cause.waiterId ?? w.vehicle, resourceId: cause.resourceId,
        ownerIds: [...(cause.ownerIds ?? [])], kind: `fleet:${w.kind}`, sinceSimSec: w.start,
        analysed: true, nodePath: cause.nodePath, ...(cause.ownerMUs ? { ownerMUs: true } : {}) });
    }
    return out;
  }

  private resolver: WaitResolver | null = null;
  setResolver(resolver: WaitResolver): void { this.resolver = resolver; }
  private valid(w: ActiveWait): boolean { return this.resolver?.valid(w.vehicle, w.kind, w.desc) ?? true; }
  private detail(w: ActiveWait): WaitCause | string | undefined { return this.resolver?.detail(w.vehicle, w.kind, w.desc); }

  private readonly clock: SimClock;
  private readonly sink: WaitProblemSink;
  private defaultLimit: number;
  private nextToken = 0;
  /** vehicle → kind → wait record (records are reused). */
  private waits = new Map<string, Map<string, ActiveWait>>();
  private kindStats = new Map<string, WaitKindStats>();
  private readonly cancelOnEnd: boolean;
  private readonly onTimeout: ((vehicle: string, kind: string, limitSec: number) => void) | null;

  constructor(opts: WaitWatchOptions) {
    this.clock = opts.clock;
    this.sink = opts.problems ?? problemsStoreWaitSink;
    this.defaultLimit = opts.defaultLimitSec;
    this.cancelOnEnd = opts.cancelOnEnd ?? true;
    this.onTimeout = opts.onTimeout ?? null;
    this.clock.registerAction('fleet.wait.limit', data => {
      const { vehicle, kind, token } = data as { vehicle: string; kind: string; token: number };
      const w = this.waits.get(vehicle)?.get(kind);
      if (w) this.onLimit(w, token);
    });
  }

  exportState(): WaitWatchState {
    const entries: WaitEntryState[] = [];
    for (const m of this.waits.values()) for (const w of m.values()) {
      entries.push({ ...w, desc: structuredClone(w.desc), limit: exportNumber(w.limit), handle: copyHandle(w.handle), lastTimeout: w.lastTimeout ? { ...w.lastTimeout } : null });
    }
    return { nextToken: this.nextToken, defaultLimit: exportNumber(this.defaultLimit), entries, stats: [...this.kindStats].map(([kind, stats]) => ({ kind, ...stats })) };
  }

  validateState(value: unknown): string[] {
    const sample = { nextToken: 0, defaultLimit: 0, entries: [{ vehicle: '', kind: '', active: false, start: 0, pausedAt: null, pauseReason: '',
      limit: 0, handle: null, reported: false, token: 0, desc: null, passive: false, lastTimeout: null }],
      stats: [{ kind: '', count: 0, active: 0, totalSec: 0, maxSec: 0, timeouts: 0 }] };
    // Normalize encoded numbers and optional legacy pause fields for structural validation.
    const raw = value as WaitWatchState | null;
    const normalized = raw && typeof raw === 'object' ? { ...raw, defaultLimit: 0,
      entries: Array.isArray(raw.entries) ? raw.entries.map(w => w && typeof w === 'object' ? { ...w, pausedAt: w.pausedAt ?? null,
        pauseReason: w.pauseReason === undefined ? 'self' : w.pauseReason, limit: 0, desc: null } : w) : raw.entries } : raw;
    const errors = validateShape(normalized, sample);
    if (!raw || !validNumber(raw.defaultLimit)) errors.push('wait: invalid default limit');
    if (errors.length) return errors;
    const s = value as WaitWatchState, keys = new Set<string>(), kinds = new Set<string>();
    if (!integer(s.nextToken)) errors.push('wait: invalid next token');
    for (const w of s.entries) {
      const key = JSON.stringify([w.vehicle, w.kind]);
      if (!isJson(w.desc) || !validNumber(w.limit) || !w.vehicle || !w.kind || keys.has(key) || !integer(w.token) || w.token > s.nextToken || !validHandle(w.handle)) errors.push('wait: invalid entry');
      // Snapshots written before the failure pause carry no `pausedAt` (= not paused).
      if (w.pausedAt != null && (!Number.isFinite(w.pausedAt) || w.pausedAt < w.start)) errors.push('wait: invalid pause time');
      if (w.pauseReason !== undefined && w.pauseReason !== 'self' && w.pauseReason !== 'blocker') errors.push('wait: invalid pause reason');
      keys.add(key);
      if (w.lastTimeout !== null) errors.push(...validateShape(w.lastTimeout,
        { id: '', ['code']: '', severity: '', title: '', detail: '' } /* shape template, not a Problems entry */));
    }
    for (const st of s.stats) {
      if (!st.kind || kinds.has(st.kind) || !integer(st.count) || !integer(st.active) || !integer(st.timeouts)
        || st.active > st.count || st.timeouts > st.count || st.totalSec < 0 || st.maxSec < 0
        || st.active !== s.entries.filter(w => w.kind === st.kind && w.active).length) errors.push('wait: invalid stats');
      kinds.add(st.kind);
    }
    if (s.entries.some(w => !kinds.has(w.kind))) errors.push('wait: missing stats');
    return errors;
  }

  prepareState(value: unknown): PreparedWaitWatch {
    const errors = this.validateState(value);
    if (errors.length) throw new Error(errors.join('; '));
    const s = structuredClone(value as WaitWatchState);
    const waits = new Map<string, Map<string, ActiveWait>>();
    for (const w of s.entries) {
      let m = waits.get(w.vehicle);
      if (!m) { m = new Map(); waits.set(w.vehicle, m); }
      m.set(w.kind, { ...w, pausedAt: w.pausedAt ?? null, limit: importNumber(w.limit) });
    }
    return { nextToken: s.nextToken, defaultLimit: importNumber(s.defaultLimit), waits,
      kindStats: new Map(s.stats.map(({ kind, ...st }) => [kind, st])) };
  }

  swapState(s: PreparedWaitWatch): void {
    this.nextToken = s.nextToken;
    this.defaultLimit = s.defaultLimit;
    this.waits = s.waits;
    this.kindStats = s.kindStats;
  }

  /** Change the default limit (applies to waits begun afterwards). */
  setDefaultLimit(sec: number): void {
    this.defaultLimit = sec;
  }

  /**
   * `vehicle` starts waiting in `kind`. A wait already active for the same
   * vehicle and kind is NOT counted again (no-op). `limitSec` = the step's
   * `waitLimitSec`; omitted → default. `detail` adds a line to the Problems
   * entry (read at the timeout). Passive sample validity is checked before deadlines;
   * a changed location/motion ends the sample instead of reporting stale standstill.
   */
  begin(vehicle: string, kind: string, limitSec?: number, desc: JsonValue = null, opts?: { passive?: boolean }): void {
    this.poll();
    const w = this.record(vehicle, kind);
    if (w.active) return;
    const st = this.statsFor(kind);
    st.count++;
    st.active++;
    w.active = true;
    w.start = this.clock.now();
    w.pausedAt = null;
    delete w.pauseReason;
    w.limit = limitSec ?? this.defaultLimit;
    w.reported = false;
    w.token = ++this.nextToken;
    w.handle = null;
    w.desc = structuredClone(desc);
    w.passive = opts?.passive === true;
    if (!w.passive && Number.isFinite(w.limit) && w.limit > 0) {
      const token = w.token;
      w.handle = this.clock.scheduleAction(w.start + w.limit, 'fleet.wait.limit', { vehicle, kind, token });
    }
  }

  /** Only a pure self-failure episode preserves elapsed budget; any foreign blocker grants a full limit on resume. */
  setPaused(vehicle: string, kind: string, paused: boolean, reason: 'self' | 'blocker' = 'self'): void {
    const w = this.waits.get(vehicle)?.get(kind);
    if (!w?.active || w.reported) return;
    if (paused) {
      w.pauseReason = w.pauseReason === 'blocker' ? 'blocker' : reason;
      if (w.pausedAt !== null) return;
      w.pausedAt = this.clock.now();
      this.clock.cancel(w.handle);
      w.handle = null;
    } else {
      if (w.pausedAt === null) return;
      w.start = w.pauseReason === 'blocker' ? this.clock.now() : w.start + (this.clock.now() - w.pausedAt);
      w.pausedAt = null;
      delete w.pauseReason;
      if (!w.passive && Number.isFinite(w.limit) && w.limit > 0)
        w.handle = this.clock.scheduleAction(w.start + w.limit, 'fleet.wait.limit', { vehicle, kind, token: w.token });
    }
  }

  /** The wait ends. No-op when it is not active. Clears its Problems entry. */
  end(vehicle: string, kind: string): void {
    const w = this.waits.get(vehicle)?.get(kind);
    const token = w?.token;
    this.poll();   // an onTimeout hook may end / restart this very wait: act on the original only
    if (!w || !w.active || w.token !== token) return;
    const dur = (w.pausedAt ?? this.clock.now()) - w.start;
    const st = this.statsFor(kind);
    st.active--;
    st.totalSec += dur;
    if (dur > st.maxSec) st.maxSec = dur;
    this.close(w);
  }

  /** No clock events: invalidate sampled waits before checking their deadlines. */
  poll(now = this.clock.now()): void {
    for (const m of this.waits.values()) for (const w of m.values()) {
      if (!w.active || !w.passive) continue;   // scheduled waits fire on their own clock event (M3 order)
      if (!this.valid(w)) {
        const st = this.statsFor(w.kind), duration = now - w.start;
        st.active--; st.totalSec += duration; st.maxSec = Math.max(st.maxSec, duration);
        this.close(w);
      } else if (!w.reported && Number.isFinite(w.limit) && w.limit > 0 && w.pausedAt === null && now >= w.start + w.limit) {
        this.onLimit(w, w.token);
      }
    }
  }

  /** Last timeout per vehicle/kind survives clearing; bounded diagnostics for run guards. */
  timeoutProblems(): WaitProblem[] {
    const out: WaitProblem[] = [];
    for (const m of this.waits.values()) for (const w of m.values()) if (w.lastTimeout) out.push(w.lastTimeout);
    return out;
  }

  firstReportedKind(vehicle: string): string | null {
    for (let i = 0; i < STATUS_WAIT_ORDER.length; i++) {
      const kind = STATUS_WAIT_ORDER[i];
      if (this.isReported(vehicle, kind)) return kind;
    }
    return null;
  }

  /** End every active wait of `vehicle` (order aborted, vehicle removed). */
  endAllOf(vehicle: string): void {
    const m = this.waits.get(vehicle);
    if (!m) return;
    for (const kind of [...m.keys()].sort()) this.end(vehicle, kind);
  }

  /** True while `vehicle` waits in `kind`. */
  isWaiting(vehicle: string, kind: string): boolean {
    return this.waits.get(vehicle)?.get(kind)?.active === true;
  }

  /** True while the wait `kind` of `vehicle` is active and over its limit. */
  isReported(vehicle: string, kind: string): boolean {
    const w = this.waits.get(vehicle)?.get(kind);
    return !!w && w.active && w.reported;
  }

  /** True while a wait of `vehicle` is over its limit (status flag `fault`). */
  isOverLimit(vehicle: string): boolean {
    const m = this.waits.get(vehicle);
    if (!m) return false;
    for (const w of m.values()) if (w.active && w.reported) return true;
    return false;
  }

  /** Duration of the running wait (sim-s), 0 when not waiting. */
  currentSec(vehicle: string, kind: string): number {
    const w = this.waits.get(vehicle)?.get(kind);
    return w && w.active ? (w.pausedAt ?? this.clock.now()) - w.start : 0;
  }

  /** Counters of `kind` (zeros when never seen). */
  stats(kind: string): Readonly<WaitKindStats> {
    return this.kindStats.get(kind) ?? { count: 0, active: 0, totalSec: 0, maxSec: 0, timeouts: 0 };
  }

  /** All kinds seen, sorted. */
  kinds(): string[] {
    return [...this.kindStats.keys()].sort();
  }

  /** Back to zero: cancel pending limit events, clear raised problems, drop counters. */
  reset(): void {
    for (const m of this.waits.values()) {
      for (const w of m.values()) if (w.active) this.close(w);
    }
    this.waits.clear();
    this.kindStats.clear();
  }

  private onLimit(w: ActiveWait, token: number): void {
    if (!w.active || w.pausedAt !== null || w.token !== token || w.reported) return;
    this.resolver?.beforeTimeout?.(w.vehicle, w.kind, w.desc);
    if (!w.active || w.pausedAt !== null || w.token !== token || w.reported) return;
    w.reported = true;
    this.statsFor(w.kind).timeouts++;
    this.onTimeout?.(w.vehicle, w.kind, w.limit);
    if (!w.active || w.token !== token) return;   // the hook ended / replaced the wait
    const cause = this.detail(w);
    const extra = cause ? `\n${typeof cause === 'string' ? cause : formatWaitCause(w.vehicle, cause)}` : '';
    const problem: WaitProblem = {
      id: waitTimeoutProblemId(w.vehicle, w.kind),
      code: FLEET_WAIT_TIMEOUT_CODE,
      severity: 'warning',
      title: `Vehicle '${w.vehicle}' waits too long (${w.kind})`,
      detail: `Wait state '${w.kind}' of vehicle '${w.vehicle}' is active since sim time ${w.start} s `
        + `and reached its limit of ${w.limit} s (sim time).${extra}`,
    };
    w.lastTimeout = problem;
    this.sink.report(problem);
  }

  private close(w: ActiveWait): void {
    w.active = false;
    delete w.pauseReason;
    w.token = ++this.nextToken;
    if (this.cancelOnEnd) this.clock.cancel(w.handle);
    w.handle = null;
    w.desc = null;
    if (w.reported) {
      w.reported = false;
      this.sink.clear(waitTimeoutProblemId(w.vehicle, w.kind));
    }
  }

  private record(vehicle: string, kind: string): ActiveWait {
    let m = this.waits.get(vehicle);
    if (!m) { m = new Map(); this.waits.set(vehicle, m); }
    let w = m.get(kind);
    if (!w) {
      w = { vehicle, kind, active: false, start: 0, pausedAt: null, limit: 0, handle: null, reported: false, token: 0, desc: null, passive: false, lastTimeout: null };
      m.set(kind, w);
    }
    return w;
  }

  private statsFor(kind: string): WaitKindStats {
    let st = this.kindStats.get(kind);
    if (!st) { st = { count: 0, active: 0, totalSec: 0, maxSec: 0, timeouts: 0 }; this.kindStats.set(kind, st); }
    return st;
  }
}

export type WaitEntryState = Omit<ActiveWait, 'limit'> & { limit: StateNumber };
export interface WaitWatchState { nextToken: number; defaultLimit: StateNumber; entries: WaitEntryState[]; stats: (WaitKindStats & { kind: string })[] }
export interface PreparedWaitWatch { nextToken: number; defaultLimit: number; waits: Map<string, Map<string, ActiveWait>>; kindStats: Map<string, WaitKindStats> }
