// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-629 §9.3 (+ gate R1-4 / R1-8 / R2-2 / R2-3 / R2-4) — the congestion
 * trace in DES, through the real private `DESRunner`:
 *
 * - **Phase 0 / R1-8** — the AGV FastForward budget scenario (factory, 8 AGVs,
 *   one simulated day) with the trace ON and OFF: identical movement (counter
 *   fingerprint, event trace hash, end poses), deterministic work counters
 *   within the R2-4 bounds — also with a large bucket table (> 2000 buckets) —
 *   and the wall clock as information only (alternating off / on).
 * - **R1-4** — horizon `H = min(renderClock, nextEventTime)`: FastForward,
 *   Animated (1/60 and 1/24 render ticks), an exhausted per-frame event
 *   budget, Pause and Step give identical counters at the same horizon; the
 *   trace never runs ahead of an unprocessed event; the band grows between
 *   events (long event-poor drive).
 * - **R2-2** — DES with UseAcceleration = false is a PLANNED source.
 * - **R2-3** — asymmetric bodies on curves, different render frequencies →
 *   identical counters (no object pose is read).
 * - DES reset (time runs backwards) clears the trace; the rerun is identical.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { getDefaultMovementAuthority, type MbStats } from '../../src/core/engine/rv-movement-authority';
import { getDefaultPathNetwork } from '../../src/core/engine/rv-path-network';
import { getDefaultAgvFleet } from '../../src/core/engine/rv-agv-fleet';
import { parsePathExtras, type RVPath } from '../../src/core/engine/rv-path';
import { PathTraceDriver } from '../../src/core/engine/rv-path-trace-sources';
import { TRACE_SAMPLE_SEC, TRACE_SLOTS, type TraceRow, type TraceWork } from '../../src/core/engine/rv-path-trace';
import { DESRunner } from '@rv/plugins/des/des-runner';
import { AGV_DEF, TICK, Object3D, makeHost, makeAgvRoot, bindDes, clearShared } from '../helpers/agv-harness';
import { registerFactory, factoryAgvConfigs, installWorkPlan } from '../fixtures/agv-factory-fixture';

const DAY = 86400;
const N_AGV = 8;
const log = (...a: unknown[]): void => { console.log('[path-trace]', ...a); };
const gridPoints = (T: number): number => Math.max(0, Math.ceil(T / TRACE_SAMPLE_SEC) - 1);

beforeEach(() => clearShared());

function fnv(s: string, h = 0x811c9dc5): number {
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h;
}

/** Same canonical trace hash as agv-ff-budget.test.ts (same-instant events sorted by kind, vehicle). */
function hashTrace(trace: readonly { t: number; kind: string; id: string }[]): string {
  const sorted = [...trace].sort((a, b) => a.t - b.t
    || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  let h = 0x811c9dc5;
  for (const e of sorted) { h = fnv(e.t.toFixed(9), h); h = fnv(e.kind, h); h = fnv(e.id, h); }
  return `${trace.length}:${h.toString(16)}`;
}

/** Synthetic pieces that are NOT in the network (a large bucket table without changing the traffic). */
function extraPieces(n: number): RVPath[] {
  const out: RVPath[] = [];
  for (let i = 0; i < n; i++) {
    out.push(parsePathExtras({
      type: 'Path', version: 1, id: `zz_extra_${i}`, closed: false, align: [0, 1, 0], successors: [],
      segments: [{ kind: 'line', from: [0, 0, 500 + i], to: [4, 0, 500 + i] }],
    }, `zz_extra_${i}`)!);
  }
  return out;
}

interface DayResult {
  fingerprint: string;
  traceHash: string;
  wallMs: number;
  work: TraceWork | null;
  buckets: number;
  horizon: number;
  samples: number;
  maxVisitsOverBound: number;
}

/** The agv-ff-budget scenario (same router, configs and work plan), optionally with the trace attached. */
function ffDay(opts: { trace: boolean; mbTrace?: boolean; extra?: number }): DayResult {
  clearShared();
  const layout = registerFactory();
  getDefaultPathNetwork().setRouter({ onArrive: () => { /* subscriber only */ } }, 'agv-ff-test');
  const mb = getDefaultMovementAuthority('des');
  mb.trace = opts.mbTrace ? [] : null;
  const runner = new DESRunner({ subMode: 'fastforward', durationSeconds: DAY });
  let driver: PathTraceDriver | null = null;
  let maxVisitsOverBound = 0;
  try {
    const host = makeHost();
    const roots = factoryAgvConfigs(layout, N_AGV).map(([n, c]) => makeAgvRoot(n, c));
    roots.forEach((r) => bindDes(runner, r, host, AGV_DEF));
    if (opts.trace) {
      driver = new PathTraceDriver();
      driver.rebuild([...getDefaultPathNetwork().all(), ...extraPieces(opts.extra ?? 0)]);
      driver.attachDes(runner, mb);
      // R2-4: bucket visits per cover ≤ ceil((front + rear) / bucket length) + 1 (piece-local).
      const tr = driver.trace;
      const orig = tr.cover.bind(tr);
      tr.cover = (p, a, b, blocked) => {
        const v0 = tr.work.bucketVisits;
        orig(p, a, b, blocked);
        const pb = tr.pathBuckets(p);
        const bound = Math.min(pb.count, Math.ceil(Math.abs(b - a) / pb.length) + 1);
        maxVisitsOverBound = Math.max(maxVisitsOverBound, tr.work.bucketVisits - v0 - bound);
      };
    }
    runner.start([AGV_DEF], { root: new Object3D() });
    installWorkPlan().dispatch();
    const mgr = runner.getManager();
    const w0 = performance.now();
    let idle = 0;
    while (!mgr.isComplete) {
      const before = mgr.totalEventsProcessed;
      runner.tick(TICK);
      runner.lateTick(TICK);
      driver?.renderDes(runner);
      if (mgr.totalEventsProcessed === before && ++idle > 3) throw new Error('stall');
    }
    const wallMs = performance.now() - w0;
    const s: MbStats = mb.stats;
    const sorted = [...roots].sort((a, b) => (a.name < b.name ? -1 : 1));
    const poses = sorted.map((r) => `${r.name}:${r.position.x.toFixed(6)},${r.position.z.toFixed(6)}`).join(' ');
    const fingerprint = `events=${mgr.totalEventsProcessed} replans=${s.replans} changed=${s.replansChanged}`
      + ` bisections=${s.bisections} fieldEvents=${s.fieldEvents} violations=${s.violations}`
      + ` forced=${s.forced} watchdog=${s.watchdogFires} poses=${fnv(poses).toString(16)}`;
    return {
      fingerprint, traceHash: mb.trace ? hashTrace(mb.trace) : '', wallMs,
      work: driver ? { ...driver.trace.work } : null,
      buckets: driver?.trace.bucketCount ?? 0,
      horizon: driver?.trace.simTime ?? 0,
      samples: driver?.trace.samplesTotal ?? 0,
      maxVisitsOverBound,
    };
  } finally {
    mb.trace = null;
    driver?.detach();
    runner.dispose();
  }
}

describe('Phase 0 / R1-8 — trace ON vs OFF in the AGV FastForward budget scenario', () => {
  it('identical movement; deterministic work counters within the R2-4 bounds; wall clock as info', () => {
    const offA = ffDay({ trace: false, mbTrace: true });
    const onA = ffDay({ trace: true, mbTrace: true });
    expect(onA.traceHash).toBe(offA.traceHash);
    expect(onA.fingerprint).toBe(offA.fingerprint);
    // Alternating wall-clock pairs (information only, plan-629 R1-8 / #201).
    const offB = ffDay({ trace: false });
    const onB = ffDay({ trace: true });
    const big = ffDay({ trace: true, extra: 1000 });
    const offC = ffDay({ trace: false });
    expect(onB.fingerprint).toBe(offA.fingerprint);
    expect(big.fingerprint).toBe(offA.fingerprint);
    expect(offB.fingerprint).toBe(offA.fingerprint);
    expect(offC.fingerprint).toBe(offA.fingerprint);
    for (const r of [onA, onB, big]) {
      const w = r.work!;
      expect(r.samples).toBe(gridPoints(r.horizon));                      // exact
      expect(w.samples).toBe(r.samples);
      expect(w.vehicleEvals).toBeLessThanOrEqual(N_AGV * w.samples);
      expect(w.vehicleEvals).toBeGreaterThan(0.99 * N_AGV * w.samples);   // every vehicle on the network
      expect(r.maxVisitsOverBound).toBeLessThanOrEqual(0);
      const tEnd = r.samples * TRACE_SAMPLE_SEC;
      expect(w.slotChanges).toBe(Math.floor(tEnd / (3600 / TRACE_SLOTS)) + Math.floor(tEnd / (86400 / TRACE_SLOTS)));
      expect(w.slotClearBuckets).toBe(w.slotChanges * r.buckets);
      expect(w.searchCells).toBe(0);                                      // no live vehicle, no grid search
    }
    expect(big.buckets).toBeGreaterThan(2000);
    // Determinism of the work itself: the same run counts the same work.
    expect(JSON.stringify(onB.work)).toBe(JSON.stringify(onA.work));
    const offMs = [offA.wallMs, offB.wallMs, offC.wallMs], onMs = [onA.wallMs, onB.wallMs];
    log(`PHASE0 horizon=${onA.horizon.toFixed(3)}s buckets=${onA.buckets} work=${JSON.stringify(onA.work)}`);
    log(`PHASE0 big buckets=${big.buckets} work=${JSON.stringify(big.work)}`);
    log(`PHASE0 wall (info) off=${offMs.map((x) => x.toFixed(0)).join('/')} ms on=${onMs.map((x) => x.toFixed(0)).join('/')} ms`
      + ` big=${big.wallMs.toFixed(0)} ms`);
  }, 600_000);
});

// ── Mode parity at one horizon ────────────────────────────────────────────

type Mode = 'fastforward' | 'animated' | 'step';

interface ModeRun { counts: string; samples: number; top: string; aheadViolations: number; frozenFrames: number; maxGap: number; gapTraceAtRc: boolean; sources: string[] }

const FORK_BODY = { length: 2.4, width: 1.0, rootOffset: -0.4 }; // front 0.8 / rear 1.6 (forks at the rear)

function longLayout(): void {
  const net = getDefaultPathNetwork();
  net.register(parsePathExtras({
    type: 'Path', version: 1, id: 'Long', closed: false, align: [0, 1, 0], successors: [],
    segments: [{ kind: 'line', from: [0, 0, 0], to: [300, 0, 0] }],
  }, 'Long')!);
  net.resolveGraph();
}

function modeRun(scene: 'factory' | 'long', mode: Mode, horizon: number, opts: {
  tick?: number; budget?: number; pauseAt?: number; pauseFrames?: number; steps?: number; reset?: boolean;
} = {}): ModeRun {
  clearShared();
  const roots: Object3D[] = [];
  const host = makeHost();
  let runnerOpts: ConstructorParameters<typeof DESRunner>[0] = { subMode: mode, durationSeconds: horizon };
  if (opts.budget) runnerOpts = { ...runnerOpts, frameEventBudget: opts.budget };
  const runner = new DESRunner(runnerOpts);
  const mb = getDefaultMovementAuthority('des');
  let wp: { dispatch: () => void } | null = null;
  if (scene === 'factory') {
    const layout = registerFactory();
    for (const [n, c] of factoryAgvConfigs(layout, N_AGV, { VehicleLength: 0, VehicleWidth: 0 })) roots.push(makeAgvRoot(n, c, FORK_BODY));
    wp = installWorkPlan();
  } else {
    longLayout();
    roots.push(makeAgvRoot('L1', { PathId: 'Long', StartPosition: 1000, TargetSpeed: 1000, UseAcceleration: false,
      Destination: 'Long', ServiceTime: 1000, VehicleLength: 1200, VehicleWidth: 800 }));
  }
  roots.forEach((r) => bindDes(runner, r, host, AGV_DEF));
  const driver = new PathTraceDriver();
  driver.rebuild(getDefaultPathNetwork().all());
  driver.attachDes(runner, mb);
  driver.horizonLimit = horizon;
  const tr = driver.trace;
  const out: ModeRun = { counts: '', samples: 0, top: '', aheadViolations: 0, frozenFrames: 0, maxGap: 0, gapTraceAtRc: true, sources: [] };
  try {
    runner.start([AGV_DEF], { root: new Object3D() });
    wp?.dispatch();
    out.sources = getDefaultAgvFleet().handleList.map((h) => `${h.id}:${h.traceSource}`);
    const mgr = runner.getManager();
    const dt = opts.tick ?? TICK;
    const check = (): void => {
      if (tr.simTime > runner.nextEventTime + 1e-9) out.aheadViolations++;
      const gap = runner.renderClock - mgr.currentTime;
      if (mode === 'animated' && gap > out.maxGap && runner.renderClock < horizon) {
        out.maxGap = gap;
        out.gapTraceAtRc = Math.abs(tr.simTime - Math.min(runner.renderClock, runner.nextEventTime)) < 1e-9;
      }
    };
    if (mode === 'step') {
      for (let i = 0; i < (opts.steps ?? 0); i++) { runner.step(); driver.renderDes(runner); check(); }
    } else {
      let frames = 0, paused = false, pausedFrames = 0, simT = 0;
      for (;;) {
        if (opts.pauseAt !== undefined && !paused && runner.renderClock >= opts.pauseAt) { mgr.pause(); paused = true; }
        if (paused && pausedFrames < (opts.pauseFrames ?? 0)) {
          const t0 = tr.simTime, rc0 = runner.renderClock;
          runner.tick(dt); runner.lateTick(dt); driver.renderDes(runner); check();
          expect(tr.simTime).toBe(t0);          // paused: nothing is sampled
          expect(runner.renderClock).toBe(rc0);
          if (++pausedFrames === (opts.pauseFrames ?? 0)) mgr.resume();
          continue;
        }
        runner.tick(dt); runner.lateTick(dt); driver.renderDes(runner); check();
        simT += dt;
        if (mode === 'animated' && runner.renderClock < Math.min(simT, horizon) - 1e-6) out.frozenFrames++;
        frames++;
        const done = mode === 'fastforward' ? mgr.isComplete
          : runner.renderClock >= horizon - 1e-9 && runner.nextEventTime > horizon;
        if (done) break;
        if (frames > 4_000_000) throw new Error('frame cap');
      }
      // Same final horizon in every mode: no event lies in (currentTime, horizon] any more.
      expect(runner.nextEventTime).toBeGreaterThan(horizon - 1e-9);
      driver.renderDes({ simTime: mgr.currentTime, renderClock: horizon, nextEventTime: runner.nextEventTime });
    }
    if (opts.reset) {
      // DES reset: the time runs backwards → the trace restarts at 0; the rerun is identical.
      const firstCounts = countsOf(driver);
      runner.reset();
      wp?.dispatch();
      let idle = 0;
      while (!runner.getManager().isComplete) {
        const before = runner.getManager().totalEventsProcessed;
        runner.tick(TICK); runner.lateTick(TICK); driver.renderDes(runner); check();
        if (runner.getManager().totalEventsProcessed === before && ++idle > 3) throw new Error('stall after reset');
      }
      expect(tr.samplesTotal).toBe(gridPoints(tr.simTime));
      driver.renderDes({ simTime: runner.getManager().currentTime, renderClock: horizon, nextEventTime: runner.nextEventTime });
      expect(countsOf(driver)).toBe(firstCounts);
    }
    out.counts = countsOf(driver);
    out.samples = tr.samplesTotal;
    const rows: TraceRow[] = [];
    tr.topN('blocked', 'start', 10, rows);
    out.top = JSON.stringify(rows);
    return out;
  } finally {
    driver.detach();
    runner.dispose();
  }
}

function countsOf(driver: PathTraceDriver): string {
  const tr = driver.trace;
  return (['blocked', 'utilization'] as const)
    .map((v) => (['window', 'start'] as const).map((r) => Array.from(tr.snapshotCounts(v, r)).join(',')).join(';')).join('#')
    + `|n=${tr.samplesTotal}|w=${tr.samplesWindow}`;
}

describe('DES horizon H = min(renderClock, nextEventTime) — mode parity (gate R1-4 / R2-3)', () => {
  it('factory, asymmetric bodies on curves: FastForward ≡ Animated 1/60 ≡ Animated 1/24 ≡ exhausted budget ≡ paused', () => {
    const T = 900;
    const ff = modeRun('factory', 'fastforward', T);
    expect(ff.samples).toBe(gridPoints(T));
    expect(ff.counts).toContain('|n=');
    const variants: Array<[string, ModeRun]> = [
      ['animated 1/60', modeRun('factory', 'animated', T)],
      ['animated 1/24', modeRun('factory', 'animated', T, { tick: 1 / 24 })],
      ['budget 1', modeRun('factory', 'animated', T, { budget: 1 })],
      ['paused', modeRun('factory', 'animated', T, { pauseAt: 300, pauseFrames: 120 })],
    ];
    for (const [label, r] of variants) {
      expect(r.aheadViolations, label).toBe(0);
      expect(r.samples, label).toBe(ff.samples);
      expect(r.counts, label).toBe(ff.counts);
      expect(r.top, label).toBe(ff.top);
    }
    expect(ff.aheadViolations).toBe(0);
    expect(variants[2][1].frozenFrames).toBeGreaterThan(0); // the budget really ran out at least once
    expect(JSON.parse(ff.top).length).toBeGreaterThan(0);   // the factory has congestion to compare
  }, 600_000);

  it('UseAcceleration = false is a planned source; the band grows between events; FastForward ≡ Animated; DES reset clears', () => {
    const T = 250;
    const ff = modeRun('long', 'fastforward', T, { reset: true });
    const an = modeRun('long', 'animated', T);
    expect(ff.sources).toEqual(['L1:planned']);
    expect(an.sources).toEqual(['L1:planned']);
    expect(an.maxGap).toBeGreaterThan(5);     // long event-poor stretch
    expect(an.gapTraceAtRc).toBe(true);       // …and the trace stood at the render horizon there
    expect(an.aheadViolations).toBe(0);
    expect(an.counts).toBe(ff.counts);
    expect(an.samples).toBe(gridPoints(T));
  }, 600_000);

  it('Step mode: the trace follows each step and never runs ahead of the next event', () => {
    const r = modeRun('factory', 'step', 900, { steps: 400 });
    expect(r.aheadViolations).toBe(0);
    expect(r.samples).toBeGreaterThan(0);
  }, 600_000);
});
