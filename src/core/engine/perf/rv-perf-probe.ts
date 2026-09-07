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
}

/** The part of `RVTransportManager` the probe needs. */
export interface PerfProbeTransportLike {
  update(dt: number): void;
  readonly mus: readonly unknown[];
  readonly sources: readonly { pool: { maxInstances?: number } | null }[];
  readonly totalSpawned: number;
  readonly totalConsumed: number;
  readonly maxLiveMUs: number;
}

export interface PerfProbeHost {
  loop: PerfProbeLoopLike;
  transport?: PerfProbeTransportLike | null;
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
    this._origFixedUpdate = loop.onFixedUpdate;
    this._origRender = loop.onRender;
    loop.onFixedUpdate = (dt: number) => this.wrapStep(dt);
    loop.onRender = (frameTime: number) => this.wrapRender(frameTime);

    const transport = host.transport;
    if (transport) {
      this._origTransportUpdate = transport.update.bind(transport);
      (transport as { update: (dt: number) => void }).update = (dt: number) => this.wrapTransport(dt);
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
      if (host.transport && this._origTransportUpdate) {
        (host.transport as { update: (dt: number) => void }).update = this._origTransportUpdate;
      }
    }
    this._origFixedUpdate = null;
    this._origRender = null;
    this._origTransportUpdate = null;
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
    try {
      this._origRender?.(frameTime);
    } finally {
      if (t - this._windowStart >= this._windowMs) this.emitSample(t);
    }
  }

  private wrapStep(dt: number): void {
    const t0 = this.now();
    try {
      this._origFixedUpdate?.(dt);
    } finally {
      const ms = this.now() - t0;
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
    const t0 = this.now();
    try {
      this._origTransportUpdate?.(dt);
    } finally {
      const ms = this.now() - t0;
      if (this.valid) { histAdd(this.transportHist, ms); histAdd(this.transportWin, ms); }
      else histAdd(this.transportHistExcl, ms);
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
