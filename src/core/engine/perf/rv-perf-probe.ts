// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * RVPerfProbe — per-frame / per-step performance instrumentation (plan-465).
 *
 * DEV-ONLY. Nothing imports this module outside an `import.meta.env.DEV` guard,
 * so it contributes 0 KB to the production bundle.
 *
 * Why it exists: `RVViewer.currentFps` / `currentFrameTime` average over 500 ms
 * AND read a frame delta that is already clamped to 0.1 s (rv-viewer.ts render()).
 * Neither can answer "how bad is the 99th percentile frame" — which is precisely
 * the question a large-scale scaling matrix has to answer. This probe therefore
 * takes its own UNCLAMPED `performance.now()` delta per frame and wraps the
 * fixed-update and transport calls to get their real execution time.
 *
 * Two aggregation levels, on purpose (SOL R2#3):
 *   - **Whole-run histograms** of fixed resolution per metric. Percentiles of the
 *     run come from these (error <= one bin width), never from averaging window
 *     percentiles — window percentiles are mathematically not mergeable.
 *   - **Windows** of >= 500 ms producing a {@link PerfSample} time series for the
 *     soak log (heap, counts, trend).
 *
 * Validity is decided PER VALUE at insertion time: a value recorded while the
 * tab is hidden or while the runner holds `markGc(true)` goes into the excluded
 * histograms instead of the valid ones, so a forced GC or a backgrounded tab can
 * never contaminate the reported percentiles (SOL #9).
 *
 * Hot paths allocate nothing: typed ring buffers and Uint32Array histograms are
 * pre-allocated and only ever written into.
 */

import type { SignalStoreStats } from '../rv-signal-store';
import { SIM_STAGES, simStageProbe } from './rv-sim-stage-hooks';
import type { SimStage, SimStageHooks } from './rv-sim-stage-hooks';

// ── Histograms ───────────────────────────────────────────────────────────

/** Fixed-resolution histogram. Values above `binWidthMs * bins.length` land in `overflow`. */
export interface PerfHistogram {
  binWidthMs: number;
  bins: Uint32Array;
  overflow: number;
  count: number;
  max: number;
}

/** Percentile summary derived from a histogram (or a raw array). */
export interface Pct {
  p50: number;
  p95: number;
  p99: number;
  max: number;
  count: number;
}

const EMPTY_PCT: Pct = { p50: 0, p95: 0, p99: 0, max: 0, count: 0 };

/** Frame/step timing resolution: 0.25 ms bins up to 500 ms. */
export const TIMING_BIN_MS = 0.25;
export const TIMING_MAX_MS = 500;
/** Latency resolution: 1 ms bins up to 5 s. */
export const LATENCY_BIN_MS = 1;
export const LATENCY_MAX_MS = 5000;

export function createHistogram(binWidthMs: number, maxMs: number): PerfHistogram {
  return {
    binWidthMs,
    bins: new Uint32Array(Math.ceil(maxMs / binWidthMs)),
    overflow: 0,
    count: 0,
    max: 0,
  };
}

/** Record one value. Allocation-free. Negative and NaN values are ignored. */
export function histAdd(h: PerfHistogram, valueMs: number): void {
  if (!(valueMs >= 0)) return;
  const bin = Math.floor(valueMs / h.binWidthMs);
  if (bin >= h.bins.length) h.overflow++;
  else h.bins[bin]++;
  h.count++;
  if (valueMs > h.max) h.max = valueMs;
}

export function histReset(h: PerfHistogram): void {
  h.bins.fill(0);
  h.overflow = 0;
  h.count = 0;
  h.max = 0;
}

/**
 * Nearest-rank percentile on the histogram (`p` in 0..1).
 *
 * Definition fixed by the plan (SOL R2#7): rank = ceil(p * count), the value
 * returned is the UPPER edge of the bin holding that rank — so the answer is
 * never below the true quantile and is at most one bin width above it. A single
 * outlier in 1000 samples therefore does NOT move p99 (rank 990), which is the
 * behaviour the test asserts.
 */
export function histPercentile(h: PerfHistogram, p: number): number {
  if (h.count === 0) return 0;
  const rank = Math.max(1, Math.ceil(p * h.count));
  let seen = 0;
  for (let i = 0; i < h.bins.length; i++) {
    seen += h.bins[i];
    if (seen >= rank) return (i + 1) * h.binWidthMs;
  }
  return h.max;
}

export function histPct(h: PerfHistogram): Pct {
  if (h.count === 0) return { ...EMPTY_PCT };
  return {
    p50: histPercentile(h, 0.5),
    p95: histPercentile(h, 0.95),
    p99: histPercentile(h, 0.99),
    max: h.max,
    count: h.count,
  };
}

// ── Pure statistics ──────────────────────────────────────────────────────
// The Node bench lib (scripts/lib/perf-bench-lib.mjs) carries an intentional
// copy of `percentile`/`heapSlope`: it cannot import TypeScript, and pulling a
// build step into a benchmark runner would be worse than five duplicated lines.

/** Nearest-rank percentile of a raw numeric array (`p` in 0..1). Sorts a copy. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil(p * sorted.length));
  return sorted[rank - 1];
}

export function percentiles(values: readonly number[]): Pct {
  if (values.length === 0) return { ...EMPTY_PCT };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number) => sorted[Math.max(1, Math.ceil(p * sorted.length)) - 1];
  return {
    p50: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
    max: sorted[sorted.length - 1],
    count: sorted.length,
  };
}

/**
 * Least-squares slope of `(t, heapUsed)` samples, expressed in MiB per hour.
 *
 * The soak leak criterion (§1.3) is a slope, not a delta, because a sawtooth
 * heap without drift must come out at ~0 while a steady climb must not be
 * hidden by whichever point the run happened to end on.
 */
export function heapSlopeMiBPerHour(samples: readonly { t: number; heapUsed?: number }[]): number {
  let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const s of samples) {
    if (typeof s.heapUsed !== 'number') continue;
    n++; sx += s.t; sy += s.heapUsed; sxx += s.t * s.t; sxy += s.t * s.heapUsed;
  }
  if (n < 2) return 0;
  const denom = n * sxx - sx * sx;
  if (denom === 0) return 0;
  const bytesPerMs = (n * sxy - sx * sy) / denom;
  return (bytesPerMs * 3_600_000) / (1024 * 1024);
}

// ── Transport-step attribution (plan-469 Phase 0a) ───────────────────────

/**
 * The regions the transport fixed step is attributed to. Names follow the step's
 * own numbered phases (`RVTransportManager.update`), plus the two cold paths
 * that are suspected behind the rare 400-800 ms steps (`adjacency`, `growth`).
 *
 * `transportExcl` is the per-MU transport body MINUS the nested regions
 * (`accumulation` and, when it is entered inside it, `adjacency`) — the region
 * stack below makes every reported number EXCLUSIVE by construction, so the
 * regions sum to at most the step.
 */
export type PerfRegion =
  | 'sources' | 'surfaceGrid' | 'pick' | 'transportExcl' | 'accumulation'
  | 'muAabbGrid' | 'sensors' | 'sinks' | 'removal' | 'poolMatrices'
  | 'adjacency' | 'growth';

export const PERF_REGIONS: readonly PerfRegion[] = [
  'sources', 'surfaceGrid', 'pick', 'transportExcl', 'accumulation',
  'muAabbGrid', 'sensors', 'sinks', 'removal', 'poolMatrices',
  'adjacency', 'growth',
];

/**
 * The seam `RVTransportManager` calls into. Assigned to
 * `transportManager.regionHooks`; **null in production**, where the whole
 * instrumentation reduces to one null check per region boundary.
 *
 * Regions that run PER MU are entered N times per tick and accumulate — the
 * probe reports the per-tick SUM, never a per-MU value.
 */
export interface RegionHooks {
  enter(r: PerfRegion): void;
  leave(r: PerfRegion): void;
  /** Charge an already-measured span to a region without entering it. Used for
   *  the pool-growth path, which measures itself inside `rv-mu.ts` and is
   *  reported to the manager as a per-tick delta. */
  addExclusive?(r: PerfRegion, ms: number): void;
}

/**
 * Hit-rate + flag counters the manager writes directly (a plain mutable object,
 * so the hot path never allocates). `null` in production.
 */
export interface TransportProbeCounters {
  /** F1b(a): MUs that reached `_pickDrivingSurface` this tick. */
  pickTotal: number;
  /** F1b(a): of those, how many satisfy the REAL fast-path predicates (i)-(vi). */
  pickFastPathHit: number;
  /** F1b(b): `queryLeadingMU` calls that took the grid path this tick. */
  accumTotal: number;
  /** F1b(b): of those, how many had an unchanged cell span over unchanged cells. */
  accumSpanStable: number;
  /** F1b(c): MU-AABB updates split by backing representation. */
  cloneAabb: number;
  instAabb: number;
  /** Long-step flags for this tick. */
  poolGrew: boolean;
  adjacencyRebuilt: boolean;
  surfaceGridRebuilt: boolean;
  liveMUs: number;
}

export function createProbeCounters(): TransportProbeCounters {
  return {
    pickTotal: 0, pickFastPathHit: 0,
    accumTotal: 0, accumSpanStable: 0,
    cloneAabb: 0, instAabb: 0,
    poolGrew: false, adjacencyRebuilt: false, surfaceGridRebuilt: false,
    liveMUs: 0,
  };
}

export function resetProbeCounters(c: TransportProbeCounters): void {
  c.pickTotal = 0; c.pickFastPathHit = 0;
  c.accumTotal = 0; c.accumSpanStable = 0;
  c.cloneAabb = 0; c.instAabb = 0;
  c.poolGrew = false; c.adjacencyRebuilt = false; c.surfaceGridRebuilt = false;
  c.liveMUs = 0;
}

/** One transport step slower than {@link LONG_STEP_MS}, with its attribution. */
export interface LongStepRecord {
  tick: number;
  totalMs: number;
  /** Exclusive ms per region — the same numbers that feed the histograms. */
  exclusiveByRegion: Record<string, number>;
  /** Sum of the exclusive regions (`totalMs - sumExclusiveMs` = unattributed). */
  sumExclusiveMs: number;
  liveMUs: number;
  cloneMUs: number;
  poolGrew: boolean;
  adjacencyRebuilt: boolean;
  surfaceGridRebuilt: boolean;
}

export const LONG_STEP_MS = 100;
/** Cap on retained long-step records — a pathological run must not turn the
 *  report into a heap dump. */
const MAX_LONG_STEPS = 200;

export interface HitRates {
  /** F1b(a) fraction over the whole run. */
  pickFastPath: number;
  /** F1b(b) fraction over the whole run. */
  accumSpanStable: number;
  /** F1b(c) clone share of MU-AABB updates over the whole run. */
  cloneShare: number;
  pickSamples: number;
  accumSamples: number;
  aabbSamples: number;
}

export interface RegionReport {
  /** Exclusive per-tick sums, as percentiles over the run. */
  exclusive: Record<string, Pct>;
  /** Inclusive per-tick sums (a nested region is counted in its parent too). */
  inclusive: Record<string, Pct>;
  /** Percentiles of `sum(exclusive regions)` per tick. */
  sumExclusive: Pct;
  /** Percentiles of the instrumented transport step itself. */
  total: Pct;
  /** `p50/p95` of `sumExclusive / total` — the attribution coverage (§1.3 wants >= 90 %). */
  coverageP50: number;
  coverageP95: number;
  ticks: number;
  hitRates: HitRates;
  longSteps: LongStepRecord[];
  longStepsTruncated: number;
}

/**
 * Accumulating region timer with EXCLUSIVE accounting.
 *
 * A small explicit stack: `enter` charges the time elapsed since the last
 * boundary to whatever region is currently on top, then pushes; `leave` charges
 * the region being left and pops. A nested region is therefore subtracted from
 * its parent automatically (`accumulation` from `transportExcl`), while the
 * inclusive figure is tracked separately from the enter/leave delta.
 *
 * Allocation-free after construction: fixed Float64Arrays indexed by region,
 * a fixed Int32Array stack, and one histogram per region.
 */
/**
 * Bin width for the REGION histograms. Deliberately finer than
 * {@link TIMING_BIN_MS}: a region is a fraction of a step, and with twelve of
 * them a 0.25 ms bin would report 0.25 ms for a region that never ran at all
 * (`histPercentile` returns the bin's UPPER edge) — three phantom milliseconds
 * of "attribution" across the table.
 *
 * 0.05 ms is half the browser's clock granularity (`performance.now()` is
 * clamped to 100 us outside a cross-origin-isolated context — measured, not
 * assumed), so it cannot coarsen anything the clock can actually resolve.
 */
export const REGION_BIN_MS = 0.05;

/**
 * Percentile of a region histogram, clamped to the largest value the histogram
 * actually saw. `histPercentile` answers with the bin's upper edge, which is
 * correct as an upper bound but reports a positive number for an all-zero
 * region; a percentile can never exceed the observed maximum, so the clamp is
 * strictly more accurate and never hides a real value.
 */
function regionPct(h: PerfHistogram): Pct {
  const p = histPct(h);
  return {
    p50: Math.min(p.p50, h.max),
    p95: Math.min(p.p95, h.max),
    p99: Math.min(p.p99, h.max),
    max: h.max,
    count: h.count,
  };
}

/**
 * NOTE on clock granularity (measured on the reference machine, Chromium 145,
 * not cross-origin isolated): `performance.now()` advances in 100 us steps.
 * Every individual enter/leave delta is therefore a multiple of 0.1 ms and a
 * single per-MU region visit (~2 us) reads as either 0 or 0.1 ms.
 *
 * That does NOT bias the attribution, because the boundaries CHAIN: `enter`
 * charges the span since the previous boundary and then becomes the new
 * boundary, so the per-tick sum telescopes to `t_last - t_first` and is exact to
 * one clock tick. What the clock does is turn the split BETWEEN regions into a
 * stratified sample — each 0.1 ms clock tick is charged to whichever region was
 * open when it was crossed — which is unbiased and, over a 300 s run
 * (~18 000 ticks), converges on the true share. Only a single tick's per-region
 * value is coarse, which is why the report leans on p50/p95 over the run and not
 * on any one tick.
 */
export class RVRegionTimer implements RegionHooks {
  private readonly _index = new Map<string, number>();
  /** Exclusive ms accumulated in the CURRENT tick, per region. */
  private readonly _tickExcl: Float64Array;
  private readonly _tickIncl: Float64Array;
  /** Wall-clock at which the currently-open region started accruing. */
  private _lastBoundary = 0;
  private readonly _stack: Int32Array;
  private _depth = 0;
  /** Inclusive start times, parallel to `_stack`. */
  private readonly _stackT0: Float64Array;

  readonly exclusiveHist: PerfHistogram[] = [];
  readonly inclusiveHist: PerfHistogram[] = [];
  readonly totalHist = createHistogram(REGION_BIN_MS, TIMING_MAX_MS);
  readonly sumExclusiveHist = createHistogram(REGION_BIN_MS, TIMING_MAX_MS);

  private _ticks = 0;
  private _coverage: number[] = [];
  private readonly _longSteps: LongStepRecord[] = [];
  private _longStepsSeen = 0;

  // Hit-rate totals over the run.
  private _pickTotal = 0; private _pickHit = 0;
  private _accumTotal = 0; private _accumStable = 0;
  private _cloneAabb = 0; private _instAabb = 0;

  private _now: () => number;

  constructor(now: () => number = () => performance.now()) {
    this._now = now;
    const n = PERF_REGIONS.length;
    this._tickExcl = new Float64Array(n);
    this._tickIncl = new Float64Array(n);
    this._stack = new Int32Array(32);
    this._stackT0 = new Float64Array(32);
    for (let i = 0; i < n; i++) {
      this._index.set(PERF_REGIONS[i], i);
      this.exclusiveHist.push(createHistogram(REGION_BIN_MS, TIMING_MAX_MS));
      this.inclusiveHist.push(createHistogram(REGION_BIN_MS, TIMING_MAX_MS));
    }
  }

  enter(r: PerfRegion): void {
    const idx = this._index.get(r);
    if (idx === undefined) return;
    const t = this._now();
    if (this._depth > 0) this._tickExcl[this._stack[this._depth - 1]] += t - this._lastBoundary;
    this._lastBoundary = t;
    if (this._depth < this._stack.length) {
      this._stack[this._depth] = idx;
      this._stackT0[this._depth] = t;
      this._depth++;
    }
  }

  leave(r: PerfRegion): void {
    const idx = this._index.get(r);
    if (idx === undefined || this._depth === 0) return;
    // Defensive: an unbalanced leave (an early `continue` in the MU loop) must
    // not corrupt the stack — unwind to the matching frame.
    let top = this._depth - 1;
    while (top >= 0 && this._stack[top] !== idx) top--;
    if (top < 0) return;
    const t = this._now();
    this._tickExcl[this._stack[this._depth - 1]] += t - this._lastBoundary;
    this._lastBoundary = t;
    this._tickIncl[idx] += t - this._stackT0[top];
    this._depth = top;
  }

  addExclusive(r: PerfRegion, ms: number): void {
    const idx = this._index.get(r);
    if (idx === undefined || !(ms > 0)) return;
    this._tickExcl[idx] += ms;
    this._tickIncl[idx] += ms;
  }

  /** Called by the probe right before the instrumented step runs. */
  beginTick(): void {
    this._tickExcl.fill(0);
    this._tickIncl.fill(0);
    this._depth = 0;
    this._lastBoundary = this._now();
  }

  /** Called after the step; `totalMs` is the measured step duration. */
  endTick(totalMs: number, tick: number, counters: TransportProbeCounters | null, valid: boolean): void {
    this._depth = 0;
    let sum = 0;
    for (let i = 0; i < this._tickExcl.length; i++) sum += this._tickExcl[i];
    if (valid) {
      for (let i = 0; i < this._tickExcl.length; i++) {
        histAdd(this.exclusiveHist[i], this._tickExcl[i]);
        histAdd(this.inclusiveHist[i], this._tickIncl[i]);
      }
      histAdd(this.totalHist, totalMs);
      histAdd(this.sumExclusiveHist, sum);
      if (totalMs > 0.05) this._coverage.push(sum / totalMs);
      this._ticks++;
    }
    if (counters) {
      this._pickTotal += counters.pickTotal;
      this._pickHit += counters.pickFastPathHit;
      this._accumTotal += counters.accumTotal;
      this._accumStable += counters.accumSpanStable;
      this._cloneAabb += counters.cloneAabb;
      this._instAabb += counters.instAabb;
    }
    if (totalMs > LONG_STEP_MS) {
      this._longStepsSeen++;
      if (this._longSteps.length < MAX_LONG_STEPS) {
        const byRegion: Record<string, number> = {};
        for (let i = 0; i < PERF_REGIONS.length; i++) {
          byRegion[PERF_REGIONS[i]] = Math.round(this._tickExcl[i] * 1000) / 1000;
        }
        this._longSteps.push({
          tick,
          totalMs: Math.round(totalMs * 1000) / 1000,
          exclusiveByRegion: byRegion,
          sumExclusiveMs: Math.round(sum * 1000) / 1000,
          liveMUs: counters?.liveMUs ?? 0,
          cloneMUs: counters?.cloneAabb ?? 0,
          poolGrew: counters?.poolGrew ?? false,
          adjacencyRebuilt: counters?.adjacencyRebuilt ?? false,
          surfaceGridRebuilt: counters?.surfaceGridRebuilt ?? false,
        });
      }
    }
  }

  reset(): void {
    for (const h of this.exclusiveHist) histReset(h);
    for (const h of this.inclusiveHist) histReset(h);
    histReset(this.totalHist);
    histReset(this.sumExclusiveHist);
    this._tickExcl.fill(0);
    this._tickIncl.fill(0);
    this._depth = 0;
    this._ticks = 0;
    this._coverage = [];
    this._longSteps.length = 0;
    this._longStepsSeen = 0;
    this._pickTotal = 0; this._pickHit = 0;
    this._accumTotal = 0; this._accumStable = 0;
    this._cloneAabb = 0; this._instAabb = 0;
  }

  report(): RegionReport {
    const exclusive: Record<string, Pct> = {};
    const inclusive: Record<string, Pct> = {};
    for (let i = 0; i < PERF_REGIONS.length; i++) {
      exclusive[PERF_REGIONS[i]] = regionPct(this.exclusiveHist[i]);
      inclusive[PERF_REGIONS[i]] = regionPct(this.inclusiveHist[i]);
    }
    return {
      exclusive,
      inclusive,
      sumExclusive: regionPct(this.sumExclusiveHist),
      total: regionPct(this.totalHist),
      coverageP50: percentile(this._coverage, 0.5),
      coverageP95: percentile(this._coverage, 0.95),
      ticks: this._ticks,
      hitRates: {
        pickFastPath: this._pickTotal > 0 ? this._pickHit / this._pickTotal : 0,
        accumSpanStable: this._accumTotal > 0 ? this._accumStable / this._accumTotal : 0,
        cloneShare: (this._cloneAabb + this._instAabb) > 0
          ? this._cloneAabb / (this._cloneAabb + this._instAabb) : 0,
        pickSamples: this._pickTotal,
        accumSamples: this._accumTotal,
        aabbSamples: this._cloneAabb + this._instAabb,
      },
      longSteps: this._longSteps.slice(),
      longStepsTruncated: Math.max(0, this._longStepsSeen - this._longSteps.length),
    };
  }
}


// ── Simulation-stage attribution (plan-469 Phase 0d) ─────────────────────

/** Per-tick exclusive ms of each `ContinuousRunner.tick()` stage. */
export interface StageReport {
  /** Exclusive per-tick percentiles, keyed by stage. */
  perTick: Record<string, Pct>;
  ticks: number;
}

/**
 * Timer for the four sibling simulation stages.
 *
 * Deliberately NOT an `RVRegionTimer`: the stages never nest, so the exclusive
 * accounting needs no stack, and a flat enter/leave pair is both cheaper and
 * immune to the unbalanced-leave defence the region stack has to carry.
 *
 * The `transport` stage measured here and the `total` of the region report are
 * the SAME span measured by two instruments — they must agree to within one
 * clock tick, which is what makes the two tables comparable.
 */
export class RVStageTimer implements SimStageHooks {
  private readonly _tick = new Float64Array(SIM_STAGES.length);
  private readonly _open = new Float64Array(SIM_STAGES.length);
  readonly hist: PerfHistogram[] = [];
  private _ticks = 0;
  private readonly _now: () => number;

  constructor(now: () => number = () => performance.now()) {
    this._now = now;
    for (let i = 0; i < SIM_STAGES.length; i++) {
      this.hist.push(createHistogram(REGION_BIN_MS, TIMING_MAX_MS));
    }
  }

  /** Index without a Map lookup — four names, resolved by a switch. */
  private idx(stage: SimStage): number {
    switch (stage) {
      case 'drives': return 0;
      case 'transport': return 1;
      case 'behaviors': return 2;
      case 'visuals': return 3;
      default: return -1;
    }
  }

  enter(stage: SimStage): void {
    const i = this.idx(stage);
    if (i >= 0) this._open[i] = this._now();
  }

  leave(stage: SimStage): void {
    const i = this.idx(stage);
    if (i >= 0) this._tick[i] += this._now() - this._open[i];
  }

  beginTick(): void { this._tick.fill(0); }

  endTick(valid: boolean): void {
    if (!valid) return;
    for (let i = 0; i < this._tick.length; i++) histAdd(this.hist[i], this._tick[i]);
    this._ticks++;
  }

  reset(): void {
    for (const h of this.hist) histReset(h);
    this._tick.fill(0);
    this._ticks = 0;
  }

  report(): StageReport {
    const perTick: Record<string, Pct> = {};
    for (let i = 0; i < SIM_STAGES.length; i++) perTick[SIM_STAGES[i]] = regionPct(this.hist[i]);
    return { perTick, ticks: this._ticks };
  }
}

// ── Render-pass split (plan-469 Phase 0d) ────────────────────────────────

/** What the probe needs off the `WebGLRenderer` to split the render passes. */
export interface PerfProbeRendererLike {
  info: {
    autoReset: boolean;
    reset(): void;
    render: { calls: number; triangles: number };
  };
  shadowMap: { enabled: boolean; render?: (...args: never[]) => void };
}

export interface RenderPassReport {
  /** CPU ms of the whole render callback (main pass + everything the viewer
   *  does inside it), MINUS the shadow pass. */
  mainMs: Pct;
  /** CPU ms measured across `WebGLShadowMap.render` alone. */
  shadowMs: Pct;
  /** CPU ms of the whole render callback. */
  totalMs: Pct;
  /** Draw calls and triangles issued OUTSIDE the shadow pass, per frame. */
  mainDraws: Pct;
  mainTriangles: Pct;
  /** Draw calls and triangles issued INSIDE the shadow pass, per frame. */
  shadowDraws: Pct;
  shadowTriangles: Pct;
  frames: number;
  /** False when the renderer never called `shadowMap.render` (shadows off) —
   *  the split is then trivially "everything is main pass". */
  shadowPassObserved: boolean;
}

/**
 * plan-473 F4: the draw-call metric with a DEFINED pass scope and a DEFINED
 * temporal aggregation — the two things the plan-469 figure lacked (it was
 * `renderer.info.render.calls` as it happened to stand in the LAST sample, i.e.
 * an end-state snapshot of whichever pass three.js reset last).
 *
 * Scope: every draw call issued inside one render callback — main pass, shadow
 * pass and every post-processing pass together. `info.autoReset` is turned off
 * for the run and `info.reset()` is called exactly once per render callback, so
 * the counter accumulates across all passes of that frame instead of being
 * zeroed by each `renderer.render()`.
 *
 * Aggregation: a per-frame histogram over the whole measurement window; the
 * reported figure is its MEDIAN (`calls.p50`), not the last frame.
 *
 * Hook independence: installed unconditionally whenever the host hands in a
 * renderer, i.e. also under `hooks=off`. It wraps nothing and costs one
 * `info.reset()` plus two counter reads per FRAME (never per tick, never per
 * MU), which is why it may run in an acceptance measurement.
 */
export interface DrawMetricReport {
  /** Human-readable pass scope — part of the report so a number is never
   *  compared against one measured with a different scope. */
  scope: 'frame-all-passes';
  /** Human-readable temporal aggregation. */
  aggregation: 'median-over-window';
  /** Draw calls per frame. `p50` is THE draw-call figure of the run. */
  calls: Pct;
  /** Triangles per frame, in THOUSANDS (same binning as the pass split). */
  triangles: Pct;
  /** Frames that contributed to the histogram (valid frames only). */
  frames: number;
  /** Always false — the metric is available under `hooks=off` (plan-473 F4). */
  requiresHooks: false;
}

// ── World-matrix work (plan-469 Phase 0d) ────────────────────────────────

/**
 * Counters filled by the dev-only `Object3D.prototype` wrappers.
 *
 * NOT a patch of three.js in `node_modules`: the two methods are replaced on the
 * live prototype for the duration of a run and restored on `stop()`. Recursion
 * inside `updateMatrixWorld` goes through `children[i].updateMatrixWorld(...)`,
 * i.e. through the prototype, so the fan-out is counted too.
 */
export interface WorldMatrixCounters {
  /** `updateWorldMatrix(...)` invocations (the explicit, upward-then-downward form). */
  updateWorldMatrix: number;
  /** `updateMatrixWorld(...)` invocations, including the recursive fan-out. */
  updateMatrixWorld: number;
  /** Of those, the nodes that actually recomposed their world matrix
   *  (`matrixWorldNeedsUpdate` was set, or the call was forced). */
  recomposed: number;
}

export interface WorldMatrixReport {
  /** Totals over the observation window. */
  total: WorldMatrixCounters;
  /** Attributed to the fixed step (simulation). */
  step: WorldMatrixCounters;
  /** Attributed to the render callback. */
  render: WorldMatrixCounters;
  /** Per fixed step / per frame averages — the numbers the plan quotes. */
  perTick: WorldMatrixCounters;
  perFrame: WorldMatrixCounters;
  ticks: number;
  frames: number;
  /** False when the wrappers were not installed (`--hooks off`). */
  installed: boolean;
}

function zeroWm(): WorldMatrixCounters {
  return { updateWorldMatrix: 0, updateMatrixWorld: 0, recomposed: 0 };
}

// ── Latency clock (CONNECT cell) ─────────────────────────────────────────

export interface LatencyReport {
  jitter: Pct;
  flush: Pct;
  /** Samples fed in. */
  samples: number;
  /** Missing sequence numbers = updates the worker/CONNECT coalesced away. */
  coalescedGaps: number;
  /** Publisher restarts observed (SEQ went backwards) — each resets the minimum. */
  restarts: number;
  /** The running minimum of `tRecv - tPublisher`, in the publisher's arbitrary base. */
  minOffsetMs: number;
}

/**
 * Relative-latency bookkeeping for the CONNECT cell (plan-465 §2.4, SOL R1#6 / R2#1).
 *
 * There is no clock synchronisation between the Python publisher and the browser,
 * so an ABSOLUTE latency is not measurable and is deliberately not reported. What
 * IS exact is the deviation of `tRecv - tPublisher` from its running minimum —
 * the jitter — plus the flush latency `tCommit - tRecv`, which is measured
 * entirely inside the browser.
 *
 * The documented consequence: a CONSTANT transport delay present from the very
 * first sample is invisible here. That is a limitation of the method, not an
 * error bar, and `latency-clock.test.ts` pins it as such.
 */
export class RVLatencyClock {
  readonly jitter = createHistogram(LATENCY_BIN_MS, LATENCY_MAX_MS);
  readonly flush = createHistogram(TIMING_BIN_MS, TIMING_MAX_MS);
  private _min = Number.POSITIVE_INFINITY;
  private readonly _lastSeq = new Map<number, number>();
  private _samples = 0;
  private _gaps = 0;
  private _restarts = 0;

  /**
   * @param plc          PLC index the sample came from (each has its own SEQ run).
   * @param seq          Monotonic sequence number written by the publisher.
   * @param tPublisherMs Publisher timestamp (arbitrary but monotonic base).
   * @param tRecvMs      Main-thread arrival time (`performance.now()`).
   */
  record(plc: number, seq: number, tPublisherMs: number, tRecvMs: number): void {
    const last = this._lastSeq.get(plc);
    if (last !== undefined) {
      if (seq < last) {
        // Publisher restarted: its time base moved, so the old minimum is
        // meaningless and would turn every later sample into huge "jitter".
        this._restarts++;
        this._min = Number.POSITIVE_INFINITY;
      } else if (seq > last + 1) {
        this._gaps += seq - last - 1;
      }
    }
    this._lastSeq.set(plc, seq);

    const delta = tRecvMs - tPublisherMs;
    if (delta < this._min) this._min = delta;
    histAdd(this.jitter, delta - this._min);
    this._samples++;
  }

  /** Record one `tCommit - tRecv` flush latency (exact, single-clock). */
  recordFlush(ms: number): void {
    histAdd(this.flush, ms);
  }

  reset(): void {
    histReset(this.jitter);
    histReset(this.flush);
    this._min = Number.POSITIVE_INFINITY;
    this._lastSeq.clear();
    this._samples = 0;
    this._gaps = 0;
    this._restarts = 0;
  }

  report(): LatencyReport {
    return {
      jitter: histPct(this.jitter),
      flush: histPct(this.flush),
      samples: this._samples,
      coalescedGaps: this._gaps,
      restarts: this._restarts,
      minOffsetMs: Number.isFinite(this._min) ? this._min : 0,
    };
  }
}

// ── Samples & report ─────────────────────────────────────────────────────

export interface PerfSample {
  /** Milliseconds since `start()`. */
  t: number;
  visible: boolean;
  gcForced: boolean;
  frames: number;
  frameMsP50: number;
  frameMsP95: number;
  frameMsP99: number;
  frameMsMax: number;
  steps: number;
  stepMsP95: number;
  stepMsMax: number;
  transportMsP95: number;
  drawCalls: number;
  triangles: number;
  geometries: number;
  textures: number;
  liveMUs: number;
  pools: number;
  poolCapacity: number;
  spawned: number;
  consumed: number;
  maxLiveMUs: number;
  signals: number;
  listeners: number;
  resolveCache: number;
  forced: number;
  /** Cumulative, read straight off the simulation loop. */
  clampedSeconds: number;
  droppedBacklogSeconds: number;
  pausedSeconds: number;
  longTasks: number;
  longTaskMsMax: number;
  heapUsed?: number;
}

export interface PerfProbeReport {
  durationMs: number;
  frameMs: Pct;
  stepMs: Pct;
  transportMs: Pct;
  jitterMs: Pct;
  flushMs: Pct;
  /** Same metrics over the EXCLUDED values (hidden tab / forced GC), for audit. */
  excluded: { frameMs: Pct; stepMs: Pct; transportMs: Pct };
  histograms: Record<string, PerfHistogram>;
  latency: LatencyReport;
  lostSimSeconds: number;
  clampedSeconds: number;
  droppedBacklogSeconds: number;
  pausedSeconds: number;
  longTasks: number;
  longTaskMsMax: number;
  samples: number;
  first: PerfSample | null;
  last: PerfSample | null;
  heapSlopeMiBPerHour: number;
  /** plan-469 transport-step attribution. `null` when region hooks were not
   *  installed for this run (`--hooks off`, or a host without a transport). */
  regions: RegionReport | null;
  /** Diagnostic for an empty attribution (see `RVPerfProbe.report`). */
  regionsDiag?: { enabled: boolean; installed: boolean; recorded: boolean; hasTransport: boolean };
  /** plan-469 Phase 0d: the four simulation stages. `null` without hooks. */
  stages: StageReport | null;
  /** plan-469 Phase 0d: main vs shadow render pass. `null` without a renderer. */
  renderPasses: RenderPassReport | null;
  /** plan-473 F4: draw calls per frame with a defined pass scope and median
   *  aggregation, measurable WITHOUT the instrumentation hooks. `null` without
   *  a renderer. */
  drawMetric: DrawMetricReport | null;
  /** plan-469 Phase 0d: world-matrix work per tick / per frame. */
  worldMatrix: WorldMatrixReport | null;
}

// ── Host seams ───────────────────────────────────────────────────────────

/** The part of `SimulationLoop` the probe needs (structural, so tests can fake it). */
export interface PerfProbeLoopLike {
  onFixedUpdate: (dt: number) => void;
  onRender: (frameTime: number) => void;
  readonly clampedSeconds: number;
  readonly droppedBacklogSeconds: number;
  readonly pausedSeconds: number;
  /** Optional so a test fake can omit it; the real loop always has it. */
  resetLostTimeCounters?(): void;
  /** plan-568: the render frame-rate cap is effectively off while true. The
   *  probe sets it for the duration of a run and restores the previous value on
   *  `stop()`, so measurements are comparable and the user's stored cap is
   *  untouched. Optional so a test fake can omit it. */
  renderCapSuppressed?: boolean;
}

/** The part of `RVTransportManager` the probe needs. */
export interface PerfProbeTransportLike {
  update(dt: number): void;
  /** plan-469: the probe installs its {@link RVRegionTimer} here for the run
   *  and restores `null` on `stop()`. Optional so a test fake can omit it. */
  regionHooks?: RegionHooks | null;
  /** plan-469: the probe installs its per-tick counter block here. */
  probeCounters?: TransportProbeCounters | null;
  readonly mus: readonly unknown[];
  readonly sources: readonly { pool: { maxInstances?: number } | null }[];
  readonly totalSpawned: number;
  readonly totalConsumed: number;
  readonly maxLiveMUs: number;
}

export interface PerfProbeHost {
  loop: PerfProbeLoopLike;
  transport?: PerfProbeTransportLike | null;
  /** plan-469 Phase 0d: the live `WebGLRenderer`, for the main/shadow pass split.
   *  Optional — without it `renderPasses` is null and nothing is wrapped. */
  renderer?: PerfProbeRendererLike | null;
  /** plan-469 Phase 0d: the `Object3D` CONSTRUCTOR whose prototype carries the
   *  matrix methods. Passed in rather than imported so the probe never pulls
   *  three.js into its own module graph and a test can hand in a stub. */
  object3D?: { prototype: Record<string, unknown> } | null;
  rendererInfo?: () => { triangles: number; drawCalls: number; geometries: number; textures: number };
  signalStats?: () => SignalStoreStats;
  /**
   * Read one signal's current value. Used ONLY to close the flush-latency loop:
   * the probe stamps a `delta` on arrival and then watches for its `TS` value to
   * become visible in the store, which is the `tCommit` of the time contract.
   */
  readSignal?: (name: string) => boolean | number | undefined;
  /** Injectable clock (tests). Defaults to `performance.now`. */
  now?: () => number;
  /** Injectable visibility predicate (tests). Defaults to `document.visibilityState`. */
  isVisible?: () => boolean;
  /** Minimum window length before a {@link PerfSample} is emitted. */
  windowMs?: number;
  /** Raw-value ring capacity per metric (detail view only). */
  ringCapacity?: number;
  /** Cap on retained samples; oldest are dropped (an 8 h soak at 2 Hz is 57 600). */
  maxSamples?: number;
}

const DEFAULT_WINDOW_MS = 500;
const DEFAULT_RING = 4096;
const DEFAULT_MAX_SAMPLES = 200_000;
/** Arrivals kept waiting for their store commit before the oldest is dropped. */
const MAX_PENDING_ARRIVALS = 64;

/** Pre-allocated ring of raw values; never grows, never allocates after construction. */
export class PerfRing {
  readonly values: Float32Array;
  private _write = 0;
  private _filled = 0;
  constructor(capacity: number) { this.values = new Float32Array(capacity); }
  push(v: number): void {
    this.values[this._write] = v;
    this._write = (this._write + 1) % this.values.length;
    if (this._filled < this.values.length) this._filled++;
  }
  get length(): number { return this._filled; }
  reset(): void { this._write = 0; this._filled = 0; }
}

export class RVPerfProbe {
  private host: PerfProbeHost | null = null;
  private now: () => number = () => performance.now();
  private isVisible: () => boolean = () =>
    typeof document === 'undefined' || document.visibilityState !== 'hidden';

  // Whole-run histograms (valid values only).
  readonly frameHist = createHistogram(TIMING_BIN_MS, TIMING_MAX_MS);
  readonly stepHist = createHistogram(TIMING_BIN_MS, TIMING_MAX_MS);
  readonly transportHist = createHistogram(TIMING_BIN_MS, TIMING_MAX_MS);
  // Excluded values (hidden tab / forced GC) — kept so a report can prove how
  // much was thrown away instead of silently dropping it.
  private readonly frameHistExcl = createHistogram(TIMING_BIN_MS, TIMING_MAX_MS);
  private readonly stepHistExcl = createHistogram(TIMING_BIN_MS, TIMING_MAX_MS);
  private readonly transportHistExcl = createHistogram(TIMING_BIN_MS, TIMING_MAX_MS);
  // Per-window scratch histograms (reset every window, never reallocated).
  private readonly frameWin = createHistogram(TIMING_BIN_MS, TIMING_MAX_MS);
  private readonly stepWin = createHistogram(TIMING_BIN_MS, TIMING_MAX_MS);
  private readonly transportWin = createHistogram(TIMING_BIN_MS, TIMING_MAX_MS);

  readonly latency = new RVLatencyClock();

  /** plan-469 transport-step attribution. Installed on the transport manager
   *  for the duration of a run unless `regionHooksEnabled` is false. */
  readonly regions = new RVRegionTimer(() => this.now());
  /** Runner switch (`--hooks off` / `?hooks=off`): with the hooks uninstalled the
   *  manager keeps its production null checks and the run measures the
   *  instrumentation overhead by difference. */
  regionHooksEnabled = true;
  private readonly _counters = createProbeCounters();
  /** plan-469 Phase 0d — stage / render-pass / world-matrix instruments. They
   *  are armed by the SAME `regionHooksEnabled` switch as the region hooks, so
   *  the `--hooks off` cell prices the whole instrumentation, not a part of it. */
  readonly stages = new RVStageTimer(() => this.now());
  private _stagesInstalled = false;
  private _stagesRecorded = false;
  private readonly _renderMainHist = createHistogram(REGION_BIN_MS, TIMING_MAX_MS);
  private readonly _renderShadowHist = createHistogram(REGION_BIN_MS, TIMING_MAX_MS);
  private readonly _renderTotalHist = createHistogram(REGION_BIN_MS, TIMING_MAX_MS);
  /** Counts, not milliseconds — 1-wide bins up to 65 536 draws / 4 M triangles.
   *  Triangles are binned in THOUSANDS so the same 65 536-bin array covers a
   *  65 M-triangle frame without overflowing. */
  private readonly _mainDrawHist = createHistogram(1, 65_536);
  private readonly _shadowDrawHist = createHistogram(1, 65_536);
  private readonly _mainTriHist = createHistogram(1, 65_536);
  private readonly _shadowTriHist = createHistogram(1, 65_536);
  private _renderFrames = 0;
  private _shadowPassObserved = false;
  private _shadowMs = 0;
  private _shadowDraws = 0;
  private _shadowTris = 0;
  private _renderInstrumented = false;
  private _origShadowRender: ((...args: never[]) => void) | null = null;
  private _origAutoReset = true;
  // ── plan-473 F4: hook-independent draw metric ──────────────────
  /** Per-frame draw calls over the whole run (1-wide bins, see below). */
  private readonly _frameDrawHist = createHistogram(1, 65_536);
  /** Per-frame triangles in THOUSANDS. */
  private readonly _frameTriHist = createHistogram(1, 65_536);
  private _drawFrames = 0;
  /** True while `info.autoReset` is overridden for the run. Set by the draw
   *  metric, which is installed for EVERY run that has a renderer — including
   *  `hooks=off`. */
  private _drawMetricInstalled = false;
  private readonly _wm = zeroWm();
  private readonly _wmStep = zeroWm();
  private readonly _wmRender = zeroWm();
  private _wmInstalled = false;
  /** Survives `stop()`: the harness reports AFTER stopping the probe, and
   *  `installed: false` on a run that WAS instrumented reads as a bug. */
  private _wmRecorded = false;
  private _origUpdateWorldMatrix: unknown = null;
  private _origUpdateMatrixWorld: unknown = null;
  private _wmTicks = 0;
  private _wmFrames = 0;
  /** Boundary snapshot of the running world-matrix counters. Work is charged to
   *  whichever of step / render closed last — the same chaining rule the region
   *  timer uses, so nothing is double-counted and nothing is lost. */
  private _wmMarkUWM = 0;
  private _wmMarkUMW = 0;
  private _wmMarkRec = 0;
  private _regionsInstalled = false;
  /** Whether the CURRENT run recorded regions. Unlike `_regionsInstalled` this
   *  survives `stop()`: the harness reports AFTER stopping the probe, and a
   *  report that dropped its attribution at that moment would be silently empty. */
  private _regionsRecorded = false;
  private _tickId = 0;

  frameRing = new PerfRing(DEFAULT_RING);
  stepRing = new PerfRing(DEFAULT_RING);

  private _samples: PerfSample[] = [];
  private _maxSamples = DEFAULT_MAX_SAMPLES;
  private _windowMs = DEFAULT_WINDOW_MS;

  private _running = false;
  private _t0 = 0;
  private _windowStart = 0;
  private _lastFrameAt = 0;
  private _gcForced = false;
  private _longTasks = 0;
  private _longTaskMsMax = 0;
  private _windowLongTasks = 0;
  private _windowLongTaskMax = 0;
  private _heapUsed: number | undefined;

  private _origFixedUpdate: ((dt: number) => void) | null = null;
  private _origRender: ((frameTime: number) => void) | null = null;
  /** plan-568: the loop's `renderCapSuppressed` before `start()`; undefined = not touched. */
  private _origCapSuppressed: boolean | undefined = undefined;
  private _origTransportUpdate: ((dt: number) => void) | null = null;
  private _observer: PerformanceObserver | null = null;
  private _deltaHookInstalled = false;
  /**
   * Deltas stamped on arrival but not yet observed in the store. Bounded: under
   * a fast publisher the store may never show an individual TS value (a later
   * one overwrites it inside the same tick), and an unbounded list would then
   * grow for the whole soak.
   */
  private readonly _pendingArrivals: { name: string; ts: number; tRecv: number }[] = [];

  get running(): boolean { return this._running; }

  /** Install the wrappers and begin recording. Idempotent. */
  start(host: PerfProbeHost): void {
    if (this._running) this.stop();
    this.host = host;
    if (host.now) this.now = host.now;
    if (host.isVisible) this.isVisible = host.isVisible;
    this._windowMs = host.windowMs ?? DEFAULT_WINDOW_MS;
    this._maxSamples = host.maxSamples ?? DEFAULT_MAX_SAMPLES;
    const ring = host.ringCapacity ?? DEFAULT_RING;
    if (ring !== this.frameRing.values.length) {
      this.frameRing = new PerfRing(ring);
      this.stepRing = new PerfRing(ring);
    }

    this.reset();
    // The loop counts lost time from page load. A run that inherits the model's
    // own load hitches would report them as ITS drift, so the criterion in §1.3
    // is measured from the moment the probe starts.
    host.loop.resetLostTimeCounters?.();
    this._t0 = this.now();
    this._windowStart = this._t0;
    this._lastFrameAt = this._t0;

    const loop = host.loop;
    // plan-568: no frame-rate cap during a measurement (restored in stop()).
    this._origCapSuppressed = loop.renderCapSuppressed;
    if (this._origCapSuppressed !== undefined) loop.renderCapSuppressed = true;
    this._origFixedUpdate = loop.onFixedUpdate;
    this._origRender = loop.onRender;
    loop.onFixedUpdate = (dt: number) => this.wrapStep(dt);
    loop.onRender = (frameTime: number) => this.wrapRender(frameTime);

    const transport = host.transport;
    if (transport) {
      this._origTransportUpdate = transport.update.bind(transport);
      (transport as { update: (dt: number) => void }).update = (dt: number) => this.wrapTransport(dt);
      if (this.regionHooksEnabled) {
        const t = transport as {
          regionHooks?: RegionHooks | null;
          probeCounters?: TransportProbeCounters | null;
        };
        t.regionHooks = this.regions;
        t.probeCounters = this._counters;
        this._regionsInstalled = true;
        this._regionsRecorded = true;
      }
    }

    // plan-473 F4: the draw metric is installed UNCONDITIONALLY — it is the one
    // render-side instrument that must survive `hooks=off`, because acceptance
    // runs are measured there. It must come BEFORE the block below, which
    // relies on `info.autoReset` already being off.
    this.installDrawMetric(host.renderer ?? null);

    if (this.regionHooksEnabled) {
      simStageProbe.hooks = this.stages;
      this._stagesInstalled = true;
      this._stagesRecorded = true;
      this.installRenderInstrumentation(host.renderer ?? null);
      this.installWorldMatrixInstrumentation(host.object3D ?? null);
    }

    this.installLongTaskObserver();
    this.installDeltaHook();
    this._running = true;
  }

  /** Restore every wrapper. Safe to call when not running. */
  stop(): void {
    const host = this.host;
    if (host) {
      if (this._origFixedUpdate) host.loop.onFixedUpdate = this._origFixedUpdate;
      if (this._origRender) host.loop.onRender = this._origRender;
      if (this._origCapSuppressed !== undefined) host.loop.renderCapSuppressed = this._origCapSuppressed;
      if (host.transport && this._origTransportUpdate) {
        (host.transport as { update: (dt: number) => void }).update = this._origTransportUpdate;
      }
      if (this._regionsInstalled && host.transport) {
        const t = host.transport as {
          regionHooks?: RegionHooks | null;
          probeCounters?: TransportProbeCounters | null;
        };
        t.regionHooks = null;
        t.probeCounters = null;
      }
    }
    if (this._stagesInstalled) {
      if (simStageProbe.hooks === this.stages) simStageProbe.hooks = null;
      this._stagesInstalled = false;
    }
    this.removeRenderInstrumentation();
    this.removeDrawMetric();
    this.removeWorldMatrixInstrumentation();
    this._origFixedUpdate = null;
    this._origRender = null;
    this._origCapSuppressed = undefined;
    this._origTransportUpdate = null;
    this._regionsInstalled = false;
    this._observer?.disconnect();
    this._observer = null;
    if (this._deltaHookInstalled) {
      delete (globalThis as { __rvDeltaArrival?: unknown }).__rvDeltaArrival;
      this._deltaHookInstalled = false;
    }
    this._running = false;
    this.host = null;
  }

  /**
   * Zero every accumulator without touching the wrappers.
   *
   * Re-baselines the CLOCK as well (plan-465 fix 2026-09-06). A `reset()` after
   * warmup is the harness saying "the observation window starts here"; if the
   * clock kept running from `start()`, `durationMs` would report the fill phase
   * plus the window (374 s instead of 120 s) and the lost-sim-time criterion in
   * §1.3 would be charged with the hitches of a line that was still filling.
   * `_t0` is only moved while running — a `reset()` before `start()` must leave
   * the clock for `start()` to set.
   */
  reset(): void {
    if (this._running) {
      this._t0 = this.now();
      this._windowStart = this._t0;
      this._lastFrameAt = this._t0;
      this.host?.loop.resetLostTimeCounters?.();
    }
    const all = [
      this.frameHist, this.stepHist, this.transportHist,
      this.frameHistExcl, this.stepHistExcl, this.transportHistExcl,
      this.frameWin, this.stepWin, this.transportWin,
    ];
    for (const h of all) histReset(h);
    this.regions.reset();
    this.stages.reset();
    for (const h of [
      this._renderMainHist, this._renderShadowHist, this._renderTotalHist,
      this._mainDrawHist, this._shadowDrawHist, this._mainTriHist, this._shadowTriHist,
    ]) histReset(h);
    this._renderFrames = 0;
    this._shadowPassObserved = false;
    // plan-473 F4 draw metric (hook-independent — reset like every other window).
    histReset(this._frameDrawHist);
    histReset(this._frameTriHist);
    this._drawFrames = 0;
    this._wmTicks = 0;
    this._wmFrames = 0;
    for (const c of [this._wm, this._wmStep, this._wmRender]) {
      c.updateWorldMatrix = 0; c.updateMatrixWorld = 0; c.recomposed = 0;
    }
    resetProbeCounters(this._counters);
    if (!this._regionsInstalled) this._regionsRecorded = false;
    if (!this._stagesInstalled) this._stagesRecorded = false;
    this._tickId = 0;
    this.latency.reset();
    this.frameRing.reset();
    this.stepRing.reset();
    this._samples = [];
    this._pendingArrivals.length = 0;
    this._longTasks = 0;
    this._longTaskMsMax = 0;
    this._windowLongTasks = 0;
    this._windowLongTaskMax = 0;
    this._heapUsed = undefined;
    this._gcForced = false;
  }

  /**
   * Mark the current values as GC-contaminated. The soak runner raises this
   * immediately before a CDP `HeapProfiler.collectGarbage` and lowers it
   * afterwards, so the forced collection never lands in the timing percentiles
   * (§1.3 / SOL #9).
   */
  markGc(forced: boolean): void { this._gcForced = forced; }

  /** Runner-supplied heap reading (bytes), stamped onto the next sample. */
  setHeapUsed(bytes: number | undefined): void { this._heapUsed = bytes; }

  private get valid(): boolean { return !this._gcForced && this.isVisible(); }

  private wrapRender(frameTime: number): void {
    const t = this.now();
    const dtMs = t - this._lastFrameAt;
    this._lastFrameAt = t;
    // Deliberately NOT `frameTime`: that one is clamped to 0.1 s by the loop, so
    // every hitch beyond 100 ms would read as exactly 100 ms (SOL #1).
    if (dtMs >= 0) {
      if (this.valid) { histAdd(this.frameHist, dtMs); histAdd(this.frameWin, dtMs); }
      else histAdd(this.frameHistExcl, dtMs);
      this.frameRing.push(dtMs);
    }
    const wmBefore = this._renderFrameBegin();
    const tRender0 = this.now();
    try {
      this._origRender?.(frameTime);
    } finally {
      this._renderFrameEnd(tRender0, wmBefore);
      if (t - this._windowStart >= this._windowMs) this.emitSample(t);
    }
  }

  /**
   * Open a render frame: zero the shadow accumulators and the renderer's own
   * counters (`info.autoReset` is off for the run, so the split can be read as a
   * DELTA across the shadow pass instead of a total that has already been reset
   * by three.js itself).
   *
   * Returns the world-matrix counter snapshot the frame is charged against.
   */
  private _renderFrameBegin(): number {
    if (this._renderInstrumented) {
      this._shadowMs = 0;
      this._shadowDraws = 0;
      this._shadowTris = 0;
    }
    // ONE reset per render callback (plan-473 F4). With `info.autoReset` off,
    // the counters then accumulate over every pass of this frame — that is the
    // metric's defined scope. Also the reset the main/shadow split relies on.
    if (this._drawMetricInstalled) this.host?.renderer?.info.reset();
    return this._wm.updateWorldMatrix + this._wm.updateMatrixWorld;
  }

  private _renderFrameEnd(t0: number, _wmBefore: number): void {
    if (this._wmInstalled) {
      this._wmFrames++;
      // Everything the wrappers counted since the last boundary belongs to this
      // render callback: the fixed step charges its own share in `wrapStep`.
      this._wmRender.updateWorldMatrix += this._wm.updateWorldMatrix - this._wmMarkUWM;
      this._wmRender.updateMatrixWorld += this._wm.updateMatrixWorld - this._wmMarkUMW;
      this._wmRender.recomposed += this._wm.recomposed - this._wmMarkRec;
      this._wmMark();
    }
    // plan-473 F4: the hook-independent per-frame draw sample.
    if (this._drawMetricInstalled && this.valid) {
      const di = this.host?.renderer?.info.render;
      if (di) {
        histAdd(this._frameDrawHist, di.calls);
        histAdd(this._frameTriHist, di.triangles / 1000);
        this._drawFrames++;
      }
    }
    if (!this._renderInstrumented || !this.valid) return;
    const total = this.now() - t0;
    const info = this.host?.renderer?.info.render;
    const draws = info?.calls ?? 0;
    const tris = info?.triangles ?? 0;
    histAdd(this._renderTotalHist, total);
    histAdd(this._renderShadowHist, this._shadowMs);
    histAdd(this._renderMainHist, Math.max(0, total - this._shadowMs));
    histAdd(this._shadowDrawHist, this._shadowDraws);
    histAdd(this._mainDrawHist, Math.max(0, draws - this._shadowDraws));
    // Triangles are binned in thousands (see the histogram declaration).
    histAdd(this._shadowTriHist, this._shadowTris / 1000);
    histAdd(this._mainTriHist, Math.max(0, tris - this._shadowTris) / 1000);
    this._renderFrames++;
  }

  private wrapStep(dt: number): void {
    if (this._stagesInstalled) this.stages.beginTick();
    if (this._wmInstalled) this._wmMark();
    const t0 = this.now();
    try {
      this._origFixedUpdate?.(dt);
    } finally {
      const ms = this.now() - t0;
      if (this._stagesInstalled) this.stages.endTick(this.valid);
      if (this._wmInstalled) {
        this._wmTicks++;
        this._wmStep.updateWorldMatrix += this._wm.updateWorldMatrix - this._wmMarkUWM;
        this._wmStep.updateMatrixWorld += this._wm.updateMatrixWorld - this._wmMarkUMW;
        this._wmStep.recomposed += this._wm.recomposed - this._wmMarkRec;
        this._wmMark();
      }
      if (this.valid) { histAdd(this.stepHist, ms); histAdd(this.stepWin, ms); }
      else histAdd(this.stepHistExcl, ms);
      this.stepRing.push(ms);
      // The interface flush runs inside the fixed step we just executed, so this
      // is the first instant at which a value that arrived earlier can be
      // visible in the store — `tCommit` of the time contract (§2.4).
      this.resolveFlushLatencies();
    }
  }

  /**
   * Close the flush half of the latency contract: any stamped arrival whose `TS`
   * value is now readable in the store has completed `tRecv -> tCommit`.
   *
   * Unlike the jitter, this is measured entirely on ONE clock, so it is exact.
   * Entries that never become visible (a later delta overwrote the value inside
   * the same tick) are dropped by the bound below rather than waited on forever.
   */
  private resolveFlushLatencies(): void {
    const read = this.host?.readSignal;
    if (!read || this._pendingArrivals.length === 0) return;
    const now = this.now();
    for (let i = this._pendingArrivals.length - 1; i >= 0; i--) {
      const pending = this._pendingArrivals[i];
      if (read(pending.name) !== pending.ts) continue;
      this.latency.recordFlush(now - pending.tRecv);
      this._pendingArrivals.splice(i, 1);
    }
  }

  private wrapTransport(dt: number): void {
    const active = this._regionsInstalled;
    if (active) {
      resetProbeCounters(this._counters);
      this.regions.beginTick();
    }
    const t0 = this.now();
    try {
      this._origTransportUpdate?.(dt);
    } finally {
      const ms = this.now() - t0;
      if (this.valid) { histAdd(this.transportHist, ms); histAdd(this.transportWin, ms); }
      else histAdd(this.transportHistExcl, ms);
      // The attribution is charged against the transport step, which the
      // plan-465 baseline showed to carry practically the whole fixed step.
      if (active) this.regions.endTick(ms, ++this._tickId, this._counters, this.valid);
    }
  }

  private emitSample(t: number): void {
    const host = this.host;
    const loop = host?.loop;
    const transport = host?.transport ?? null;
    const info = host?.rendererInfo?.();
    const store = host?.signalStats?.();

    let poolCapacity = 0;
    let pools = 0;
    if (transport) {
      for (const source of transport.sources) {
        if (!source.pool) continue;
        pools++;
        poolCapacity += source.pool.maxInstances ?? 0;
      }
    }

    const sample: PerfSample = {
      t: t - this._t0,
      visible: this.isVisible(),
      gcForced: this._gcForced,
      frames: this.frameWin.count,
      frameMsP50: histPercentile(this.frameWin, 0.5),
      frameMsP95: histPercentile(this.frameWin, 0.95),
      frameMsP99: histPercentile(this.frameWin, 0.99),
      frameMsMax: this.frameWin.max,
      steps: this.stepWin.count,
      stepMsP95: histPercentile(this.stepWin, 0.95),
      stepMsMax: this.stepWin.max,
      transportMsP95: histPercentile(this.transportWin, 0.95),
      drawCalls: info?.drawCalls ?? 0,
      triangles: info?.triangles ?? 0,
      geometries: info?.geometries ?? 0,
      textures: info?.textures ?? 0,
      liveMUs: transport?.mus.length ?? 0,
      pools,
      poolCapacity,
      spawned: transport?.totalSpawned ?? 0,
      consumed: transport?.totalConsumed ?? 0,
      maxLiveMUs: transport?.maxLiveMUs ?? 0,
      signals: store?.signals ?? 0,
      listeners: store?.listeners ?? 0,
      resolveCache: store?.resolveCache ?? 0,
      forced: store?.forced ?? 0,
      clampedSeconds: loop?.clampedSeconds ?? 0,
      droppedBacklogSeconds: loop?.droppedBacklogSeconds ?? 0,
      pausedSeconds: loop?.pausedSeconds ?? 0,
      longTasks: this._windowLongTasks,
      longTaskMsMax: this._windowLongTaskMax,
      ...(this._heapUsed !== undefined ? { heapUsed: this._heapUsed } : {}),
    };

    if (this._samples.length >= this._maxSamples) this._samples.shift();
    this._samples.push(sample);

    histReset(this.frameWin);
    histReset(this.stepWin);
    histReset(this.transportWin);
    this._windowLongTasks = 0;
    this._windowLongTaskMax = 0;
    this._heapUsed = undefined;
    this._windowStart = t;
  }

  private _wmMark(): void {
    this._wmMarkUWM = this._wm.updateWorldMatrix;
    this._wmMarkUMW = this._wm.updateMatrixWorld;
    this._wmMarkRec = this._wm.recomposed;
  }

  /**
   * Wrap `WebGLShadowMap.render` so the shadow pass can be subtracted from the
   * render callback.
   *
   * `renderer.shadowMap.render` is an OWN property of the shadow-map object
   * (three.js assigns it inside `WebGLShadowMap`), so replacing it touches
   * nothing shared and nothing in `node_modules`. `info.autoReset` is turned off
   * for the run: three.js otherwise zeroes `info.render` at the start of every
   * `renderer.render()`, which would make the before/after delta across the
   * shadow pass meaningless.
   */
  private installRenderInstrumentation(renderer: PerfProbeRendererLike | null): void {
    if (!renderer || typeof renderer.shadowMap?.render !== 'function') return;
    // `info.autoReset` is owned by `installDrawMetric` (plan-473 F4), which runs
    // first for every run — including `hooks=off`. Nothing to do here.
    const orig = renderer.shadowMap.render.bind(renderer.shadowMap);
    this._origShadowRender = renderer.shadowMap.render;
    renderer.shadowMap.render = ((...args: never[]) => {
      const c0 = renderer.info.render.calls;
      const t0 = renderer.info.render.triangles;
      const s0 = this.now();
      try {
        orig(...args);
      } finally {
        this._shadowMs += this.now() - s0;
        this._shadowDraws += renderer.info.render.calls - c0;
        this._shadowTris += renderer.info.render.triangles - t0;
        this._shadowPassObserved = true;
      }
    }) as PerfProbeRendererLike['shadowMap']['render'];
    this._renderInstrumented = true;
  }

  private removeRenderInstrumentation(): void {
    const renderer = this.host?.renderer;
    if (this._renderInstrumented && renderer && this._origShadowRender) {
      renderer.shadowMap.render = this._origShadowRender;
    }
    this._origShadowRender = null;
    this._renderInstrumented = false;
  }

  /**
   * plan-473 F4 — arm the hook-independent draw metric.
   *
   * Turns `info.autoReset` off so the per-frame counters survive across the
   * frame's passes (three.js otherwise zeroes them at the start of every single
   * `renderer.render()` call, which is what made the old figure a statement
   * about whichever pass happened to run last). The reset then happens exactly
   * once per render callback in {@link _renderFrameBegin}.
   */
  private installDrawMetric(renderer: PerfProbeRendererLike | null): void {
    if (!renderer?.info || typeof renderer.info.reset !== 'function') return;
    this._origAutoReset = renderer.info.autoReset;
    renderer.info.autoReset = false;
    this._drawMetricInstalled = true;
  }

  private removeDrawMetric(): void {
    const renderer = this.host?.renderer;
    if (this._drawMetricInstalled && renderer?.info) {
      renderer.info.autoReset = this._origAutoReset;
    }
    this._drawMetricInstalled = false;
  }

  /**
   * Count world-matrix work by replacing two `Object3D.prototype` methods for
   * the duration of the run.
   *
   * The constructor is handed in by the host (never imported) so this module
   * keeps its zero three.js dependency, and a unit test can pass a stub class.
   * `recomposed` counts the nodes whose world matrix was ACTUALLY recomputed —
   * `matrixWorldNeedsUpdate` set, or the call forced — which is the quantity the
   * plan is after; the raw call count alone hides a fan-out that walks a
   * thousand clean nodes.
   */
  private installWorldMatrixInstrumentation(ctor: { prototype: Record<string, unknown> } | null): void {
    if (!ctor?.prototype) return;
    const proto = ctor.prototype;
    const origUWM = proto.updateWorldMatrix as ((a?: boolean, b?: boolean) => void) | undefined;
    const origUMW = proto.updateMatrixWorld as ((force?: boolean) => void) | undefined;
    if (typeof origUWM !== 'function' || typeof origUMW !== 'function') return;
    this._origUpdateWorldMatrix = origUWM;
    this._origUpdateMatrixWorld = origUMW;
    const wm = this._wm;
    proto.updateWorldMatrix = function (this: { matrixWorldNeedsUpdate?: boolean }, a?: boolean, b?: boolean): void {
      wm.updateWorldMatrix++;
      origUWM.call(this, a, b);
    };
    proto.updateMatrixWorld = function (this: { matrixWorldNeedsUpdate?: boolean }, force?: boolean): void {
      wm.updateMatrixWorld++;
      if (this.matrixWorldNeedsUpdate === true || force === true) wm.recomposed++;
      origUMW.call(this, force);
    };
    this._wmInstalled = true;
    this._wmRecorded = true;
    this._wmMark();
  }

  private removeWorldMatrixInstrumentation(): void {
    if (!this._wmInstalled) return;
    const proto = this.host?.object3D?.prototype;
    if (proto) {
      if (this._origUpdateWorldMatrix) proto.updateWorldMatrix = this._origUpdateWorldMatrix;
      if (this._origUpdateMatrixWorld) proto.updateMatrixWorld = this._origUpdateMatrixWorld;
    }
    this._origUpdateWorldMatrix = null;
    this._origUpdateMatrixWorld = null;
    this._wmInstalled = false;
  }

  private installLongTaskObserver(): void {
    if (typeof PerformanceObserver === 'undefined') return;
    if (!PerformanceObserver.supportedEntryTypes?.includes('longtask')) return;
    this._observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        this._longTasks++;
        this._windowLongTasks++;
        if (entry.duration > this._longTaskMsMax) this._longTaskMsMax = entry.duration;
        if (entry.duration > this._windowLongTaskMax) this._windowLongTaskMax = entry.duration;
      }
    });
    try { this._observer.observe({ type: 'longtask', buffered: false }); }
    catch { this._observer = null; }
  }

  /**
   * Claim the dev-only `delta`-arrival slot the WebSocket facade stamps into.
   * The facade posts the raw signal payload plus the main-thread arrival time;
   * we pick the `LINE/PLC<p>/TS` + `.../SEQ` pair out of it (see
   * `publish-load-plcs.py`) and feed the latency clock.
   */
  private installDeltaHook(): void {
    const g = globalThis as {
      __rvDeltaArrival?: (signals: Record<string, boolean | number>, tRecvMs: number) => void;
    };
    g.__rvDeltaArrival = (signals, tRecvMs) => this.onDeltaArrival(signals, tRecvMs);
    this._deltaHookInstalled = true;
  }

  /** @internal Exposed for the integration test — same entry point as the hook. */
  onDeltaArrival(signals: Record<string, boolean | number>, tRecvMs: number): void {
    for (const name in signals) {
      if (!name.endsWith('/TS')) continue;
      const seqName = `${name.slice(0, -3)}/SEQ`;
      const seq = signals[seqName];
      if (typeof seq !== 'number') continue;
      const ts = signals[name];
      if (typeof ts !== 'number') continue;
      const m = /PLC(\d+)/.exec(name);
      this.latency.record(m ? Number(m[1]) : 0, seq, ts, tRecvMs);
      if (this.host?.readSignal) {
        this._pendingArrivals.push({ name, ts, tRecv: tRecvMs });
        if (this._pendingArrivals.length > MAX_PENDING_ARRIVALS) this._pendingArrivals.shift();
      }
    }
  }

  samples(): readonly PerfSample[] { return this._samples; }

  report(): PerfProbeReport {
    const loop = this.host?.loop;
    const lastSample = this._samples[this._samples.length - 1];
    const clamped = loop?.clampedSeconds ?? lastSample?.clampedSeconds ?? 0;
    const dropped = loop?.droppedBacklogSeconds ?? lastSample?.droppedBacklogSeconds ?? 0;
    const latency = this.latency.report();
    return {
      durationMs: lastSample ? lastSample.t : 0,
      frameMs: histPct(this.frameHist),
      stepMs: histPct(this.stepHist),
      transportMs: histPct(this.transportHist),
      jitterMs: latency.jitter,
      flushMs: latency.flush,
      excluded: {
        frameMs: histPct(this.frameHistExcl),
        stepMs: histPct(this.stepHistExcl),
        transportMs: histPct(this.transportHistExcl),
      },
      histograms: {
        frameMs: this.frameHist,
        stepMs: this.stepHist,
        transportMs: this.transportHist,
        jitterMs: this.latency.jitter,
        flushMs: this.latency.flush,
      },
      latency,
      lostSimSeconds: clamped + dropped,
      clampedSeconds: clamped,
      droppedBacklogSeconds: dropped,
      pausedSeconds: loop?.pausedSeconds ?? 0,
      longTasks: this._longTasks,
      longTaskMsMax: this._longTaskMsMax,
      samples: this._samples.length,
      first: this._samples[0] ?? null,
      last: lastSample ?? null,
      heapSlopeMiBPerHour: heapSlopeMiBPerHour(this._samples),
      regions: this._regionsRecorded ? this.regions.report() : null,
      stages: this._stagesRecorded ? this.stages.report() : null,
      renderPasses: this._renderFrames > 0 ? {
        mainMs: regionPct(this._renderMainHist),
        shadowMs: regionPct(this._renderShadowHist),
        totalMs: regionPct(this._renderTotalHist),
        // `regionPct`, not `histPct`: a count histogram's bin upper edge would
        // report 176 draws for a frame that issued 175 (the percentile can never
        // exceed the observed maximum).
        mainDraws: regionPct(this._mainDrawHist),
        mainTriangles: regionPct(this._mainTriHist),
        shadowDraws: regionPct(this._shadowDrawHist),
        shadowTriangles: regionPct(this._shadowTriHist),
        frames: this._renderFrames,
        shadowPassObserved: this._shadowPassObserved,
      } : null,
      // plan-473 F4 — see DrawMetricReport. Present whenever a renderer was
      // handed in, INCLUDING `hooks=off`.
      drawMetric: this._drawFrames > 0 ? {
        scope: 'frame-all-passes',
        aggregation: 'median-over-window',
        // `regionPct`, not `histPct`: a count histogram's bin upper edge would
        // otherwise report more draws than the frame ever issued.
        calls: regionPct(this._frameDrawHist),
        triangles: regionPct(this._frameTriHist),
        frames: this._drawFrames,
        requiresHooks: false,
      } : null,
      worldMatrix: (this._wmTicks > 0 || this._wmFrames > 0) ? {
        total: { ...this._wm },
        step: { ...this._wmStep },
        render: { ...this._wmRender },
        perTick: {
          updateWorldMatrix: this._wmTicks > 0 ? this._wmStep.updateWorldMatrix / this._wmTicks : 0,
          updateMatrixWorld: this._wmTicks > 0 ? this._wmStep.updateMatrixWorld / this._wmTicks : 0,
          recomposed: this._wmTicks > 0 ? this._wmStep.recomposed / this._wmTicks : 0,
        },
        perFrame: {
          updateWorldMatrix: this._wmFrames > 0 ? this._wmRender.updateWorldMatrix / this._wmFrames : 0,
          updateMatrixWorld: this._wmFrames > 0 ? this._wmRender.updateMatrixWorld / this._wmFrames : 0,
          recomposed: this._wmFrames > 0 ? this._wmRender.recomposed / this._wmFrames : 0,
        },
        ticks: this._wmTicks,
        frames: this._wmFrames,
        installed: this._wmRecorded,
      } : null,
      /** Diagnostic: why `regions` may be null (hooks disabled, or no transport). */
      regionsDiag: {
        enabled: this.regionHooksEnabled,
        installed: this._regionsInstalled,
        recorded: this._regionsRecorded,
        hasTransport: !!this.host?.transport,
      },
    };
  }

  /**
   * JSON-safe report for `page.evaluate` transfer.
   *
   * Histograms are reduced to their scalars (a `Uint32Array` crosses the bridge
   * as an object with 2000 numeric keys), and the per-window sample list is
   * deliberately NOT included: an 8 h soak holds ~57 000 samples, which would
   * turn every report into tens of megabytes. The soak runner already streams
   * that series to its `.jsonl`; callers that want it in-page use `samples()`.
   */
  reportJSON(): Record<string, unknown> {
    const r = this.report();
    const histograms: Record<string, unknown> = {};
    for (const key in r.histograms) {
      const h = r.histograms[key];
      histograms[key] = { binWidthMs: h.binWidthMs, overflow: h.overflow, count: h.count, max: h.max };
    }
    return { ...r, histograms };
  }
}
