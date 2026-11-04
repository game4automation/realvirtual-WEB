// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { DESManager } from './rv-des-manager';
import { getDesRunSettings, rollSeed } from '../../core/hmi/des-run-settings-store';
import { isParamApplyBusy } from '../../core/params/rv-param-apply';
import { KpiTracker, kpiSourceProviderList, setTrackedKpiSources, trackedKpiSources, type KpiSourceReader } from './des-kpi-track';
import type { KpiTrack } from '../sim-controller/des-kpi-defs';

/**
 * KPI recording inputs of a run (G4): the model key the tracked sources are published under,
 * the run's project (asked of a source provider) and the reader of one source key
 * (`prop:` component property or `row:` value row). Without them a RunIdentity records no KPIs.
 */
export interface RunIdentityKpiOptions {
  modelKey(): string | null;
  projectId?(): string | null;
  readSource(key: string): KpiSourceReader | null;
}

export interface RunIdentityValue { readonly runId: string; readonly seed: number; readonly startedAt: number }
export type RunIdentityEvent = { type: 'start' | 'reopen'; run: RunIdentityValue } |
  { type: 'end'; run: RunIdentityValue; reason: string; status: 'completed' | 'aborted'; simTime: number } |
  { type: 'reset'; info: { currentTime: number; totalEventsProcessed: number; isComplete: boolean } };
/** Core run identity, independent of archives and experiment selection. */
export class RunIdentity {
  private run: RunIdentityValue | null = null;
  private completed: RunIdentityValue | null = null;
  private suppressed = 0;
  private listeners = new Set<(event: RunIdentityEvent) => void>();
  private off: () => void;
  private tracker: KpiTracker | null = null;
  private offTracker: (() => void) | null = null;
  private lastTrack: KpiTrack | undefined;
  private trackGeneration = 0;
  private sourcesPending: Promise<void> | null = null;
  /** Why this run's KPI tracking is incomplete (a provider timeout), else undefined. */
  private incomplete: KpiTrack['incomplete'];
  constructor(private manager: DESManager, private emit?: (event: string, data: unknown) => void,
    private kpi?: RunIdentityKpiOptions) {
    const previous = manager.onBeforeReset;
    const hook: NonNullable<DESManager['onBeforeReset']> = info => { previous?.(info); this.reset(info); };
    manager.onBeforeReset = hook;
    this.off = () => { if (manager.onBeforeReset === hook) manager.onBeforeReset = previous; };
  }
  get activeRun(): RunIdentityValue | null { return this.run; }
  get runId(): string | null { return this.run?.runId ?? this.completed?.runId ?? null; }
  get seed(): number { return this.run?.seed ?? this.completed?.seed ?? this.manager.masterSeed; }
  subscribe(listener: (event: RunIdentityEvent) => void, attachRunning = true): () => void {
    this.listeners.add(listener);
    if (attachRunning && this.run) listener({ type: 'start', run: this.run });
    return () => { this.listeners.delete(listener); };
  }
  private notify(event: RunIdentityEvent): void {
    for (const fn of [...this.listeners]) {
      try { fn(event); } catch (error) { console.error('[DES runs] identity listener threw:', error); }
    }
  }
  private publish(event: string, data: unknown): void {
    try { this.emit?.(event, data); } catch (error) { console.error('[DES runs] listener threw:', error); }
  }
  start(): void {
    if (this.suppressed) return;
    this.completed = null;
    this.run = { runId: freshIdentityId(), seed: this.manager.masterSeed, startedAt: Date.now() };
    this.startKpiTrack();
    this.notify({ type: 'start', run: this.run });
    this.publish('simulation-run-started', { runId: this.run.runId, seed: this.run.seed });
  }
  complete(reason = 'duration-reached'): void { this.end('completed', reason); }
  private end(status: 'completed' | 'aborted', reason: string): void {
    if (!this.run || this.suppressed) return;
    const run = this.run;
    this.completed = status === 'completed' ? run : null;
    // Finalize BEFORE the end listeners: persistence reads kpiTrack() while archiving.
    this.finishKpiTrack(this.manager.currentTime);
    if (status !== 'completed') this.stopKpiTrack();
    this.notify({ type: 'end', run, reason, status, simTime: this.manager.currentTime });
    this.run = null;
    this.publish('simulation-run-ending', { runId: run.runId, seed: run.seed, simTime: this.manager.currentTime, status, reason });
  }
  reopen(): boolean {
    if (this.suppressed || this.run || !this.completed) return false;
    this.run = this.completed; this.completed = null;
    // Continue: the same tracker keeps integrating from the previous end.
    if (!this.tracker) this.startKpiTrack();
    this.notify({ type: 'reopen', run: this.run }); return true;
  }
  beginRestore(): void { this.suppressed++; }
  endRestore(): void {
    const was = this.suppressed;
    this.suppressed = Math.max(0, this.suppressed - 1);
    // A restore replaces the measured state: the open run's tracking starts over.
    if (was > 0 && this.suppressed === 0 && this.run) this.startKpiTrack();
  }
  archiveOpenRun(): void {
    if ((this.manager.isComplete || !isParamApplyBusy()) && this.manager.totalEventsProcessed > 0 && this.manager.currentTime > 0)
      this.end(this.manager.isComplete ? 'completed' : 'aborted', 'reset');
  }
  reset(info = { currentTime: this.manager.currentTime, totalEventsProcessed: this.manager.totalEventsProcessed, isComplete: this.manager.isComplete }): void {
    if (this.suppressed) return;
    this.archiveOpenRun();
    this.run = null; this.completed = null;
    this.stopKpiTrack();
    if (getDesRunSettings().seedMode === 'auto') this.manager.setMasterSeed(rollSeed());
    this.notify({ type: 'reset', info });
  }
  dispose(): void { this.off(); this.stopKpiTrack(); this.listeners.clear(); this.run = this.completed = null; }

  /**
   * KPI points of the run: the live state of the open run up to now, else the finalized track
   * of the run that ended last. Undefined when no source is tracked.
   */
  kpiTrack(): KpiTrack | undefined {
    if (this.run && this.tracker) {
      try { return this.marked(this.tracker.finish(this.manager.currentTime), this.manager.currentTime); }
      catch (error) { console.error('[DES runs] KPI tracking failed:', error); return undefined; }
    }
    return this.lastTrack;
  }

  /** A timed-out source lookup is part of the result: the track says so (also when empty). */
  private marked(track: KpiTrack | undefined, t1: number): KpiTrack | undefined {
    if (!this.incomplete) return track;
    return { ...(track ?? { t0: Math.max(0, this.manager.statResetTime), t1, values: {} }), incomplete: this.incomplete };
  }

  private stopKpiTrack(): void {
    this.offTracker?.(); this.offTracker = null; this.tracker = null; this.trackGeneration++;
    this.sourcesPending = null;
  }

  /**
   * Readiness barrier (plan-2211 review #4): while a source provider is still answering for the
   * open run, no simulation time may advance — otherwise a FastForward with warm-up 0 would pass
   * the warm-up end before the sources are added and the run would record no KPIs. Null when
   * nothing is pending. The runner holds every progress path (tick, step, FastForward) on it.
   */
  get kpiSourcesPending(): Promise<void> | null { return this.sourcesPending; }

  private finishKpiTrack(simTime: number): void {
    this.lastTrack = undefined;
    if (!this.tracker) return;
    try { this.lastTrack = this.marked(this.tracker.finish(simTime), simTime); }
    catch (error) { console.error('[DES runs] KPI tracking failed:', error); }
  }

  /** Track the KPI sources published for the run's model; without sources nothing subscribes. */
  private startKpiTrack(): void {
    this.stopKpiTrack();
    this.lastTrack = undefined;
    this.incomplete = undefined;
    const kpi = this.kpi;
    if (!kpi) return;
    let model: string | null = null;
    try { model = kpi.modelKey(); } catch { model = null; }
    if (!model) return;
    const tracker = new KpiTracker(Math.max(0, this.manager.statResetTime));
    const generation = this.trackGeneration;
    this.tracker = tracker;
    const add = (keys: readonly string[]): void => {
      if (this.tracker !== tracker || this.trackGeneration !== generation) return;
      for (const key of keys) {
        if (tracker.has(key)) continue;
        let read: KpiSourceReader | null = null;
        try { read = kpi.readSource(key); } catch { read = null; }
        if (read) tracker.add(key, read, this.manager.currentTime);
      }
      if (tracker.size && !this.offTracker) {
        this.offTracker = this.manager.addTimeAdvanceListener(t => {
          if (this.tracker !== tracker) return;
          try { tracker.advance(t); }
          catch (error) { console.error('[DES runs] KPI tracking failed:', error); this.stopKpiTrack(); }
        });
      }
    };
    const known = trackedKpiSources(model);
    if (known) { add(known); return; }
    const providers = kpiSourceProviderList();
    if (!providers.length) return;
    let projectId: string | null = null;
    try { projectId = kpi.projectId?.() ?? null; } catch { projectId = null; }
    const request = { model, projectId };
    // One query per run start; the timeout is its terminal state (Codex re-check #2): a late
    // answer still fills the session cache for the NEXT run, never this run's tracker.
    const query = { settled: false };
    const lookup = (async () => {
      for (const provider of providers) {
        const keys = await provider(request);
        if (!keys) continue;
        if (trackedKpiSources(model) === undefined) setTrackedKpiSources(model, keys);
        if (!query.settled) add(keys);
        return;
      }
      // Every provider answered "none": remember it for this session, so the next run of the
      // model (reset, restore) does not wait again. A later publish (matrix) replaces it.
      if (trackedKpiSources(model) === undefined) setTrackedKpiSources(model, []);
    })().catch(() => { /* a failing provider: nothing to track */ });
    // A provider that never answers must not freeze the simulation: give up after a bound.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bounded = Promise.race([lookup, new Promise<void>(resolve => {
      timer = setTimeout(() => {
        if (query.settled || this.trackGeneration !== generation) { resolve(); return; }
        this.incomplete = 'kpi-sources-timeout';
        if (!warnedTimeouts.has(model)) {
          warnedTimeouts.add(model);
          console.warn(`[DES runs] KPI source provider did not answer within ${kpiProviderTimeoutMs} ms; this run of '${model}' records no KPIs (kpi-sources-timeout)`);
        }
        resolve();
      }, kpiProviderTimeoutMs);
    })]);
    const pending = bounded.then(() => {
      query.settled = true;
      clearTimeout(timer);
      if (this.sourcesPending === pending) this.sourcesPending = null;
    });
    this.sourcesPending = pending;
  }
}

/** Upper bound of the KPI readiness barrier (a provider that hangs must not freeze DES). */
let kpiProviderTimeoutMs = 5000;
/** Models whose provider timeout was already warned about (one warning per model and session). */
const warnedTimeouts = new Set<string>();
/** Test seam: shorten the provider timeout; returns the restore function. */
export function __setKpiProviderTimeoutForTest(ms: number): () => void {
  const previous = kpiProviderTimeoutMs;
  kpiProviderTimeoutMs = ms;
  return () => { kpiProviderTimeoutMs = previous; };
}

/** Same UUID/fallback contract as the previous lifecycle, without loading storage. */
function freshIdentityId(): string {
  try { if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID(); } catch { /* fallback */ }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
