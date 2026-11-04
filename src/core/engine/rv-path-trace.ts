// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-path-trace.ts — the congestion trace accumulator (plan-629).
 *
 * Pure bookkeeping, no Three.js scene objects and no simulation access: the
 * path pieces of the network are cut into buckets of about
 * {@link TRACE_BUCKET_M} metres, and on a fixed sim-time grid
 * `t_k = k · TRACE_SAMPLE_SEC` (k ≥ 1) a sampler reports, per vehicle, the
 * body interval it covers on its piece and whether it is BLOCKED (stands
 * although it wants to move). Two views are counted per bucket:
 *
 * - `utilization` — at least one body covers the bucket at `t_k`;
 * - `blocked`     — at least one blocked body covers the bucket at `t_k`.
 *
 * Each bucket counts at most once per grid point and view (stamp de-dupe).
 * The counts are kept for two sliding windows at once — the last hour and the
 * last day of sim time, each a ring of {@link TRACE_SLOTS} slots (60 s / 24 min
 * per slot, so the storage is bounded: 2 × 60 × buckets per view) — and since
 * start. Switching the displayed window only selects one; nothing is emptied. Integer counters only — the division
 * happens when a value is read — so two runs that sample the same states give
 * bit-identical results, independent of frame rate or FastForward.
 *
 * Grid contract: `advanceTo(T)` samples every `t_k < T` that has not been
 * sampled yet, in ascending order. The number of grid points of a run up to the
 * horizon `T` is therefore `ceil(T / Δ) − 1` (= `floor(T / Δ)` for a horizon
 * off the grid; a point exactly AT the horizon is still pending). The time
 * drivers (`rv-path-trace-sources.ts`) only call it where every plan is valid
 * for all those points.
 */

import type { RVPath } from './rv-path';
import { Vector3 } from 'three';

/** Nominal bucket length (m) — a piece of length L gets `max(1, round(L / 2))` equal buckets. */
export const TRACE_BUCKET_M = 2;
/** Sim-time sampling grid Δ (s). */
export const TRACE_SAMPLE_SEC = 0.5;
/** Number of ring slots of the sliding window. */
export const TRACE_SLOTS = 60;
/** The sliding windows kept in parallel (s of sim time): last hour, last day. */
export const TRACE_WINDOW_HOUR_SEC = 3600;
export const TRACE_WINDOW_DAY_SEC = 86400;
export const TRACE_WINDOWS_SEC: readonly number[] = [TRACE_WINDOW_HOUR_SEC, TRACE_WINDOW_DAY_SEC];
/** Default sliding window (s of sim time). */
export const TRACE_WINDOW_DEFAULT_SEC = TRACE_WINDOW_HOUR_SEC;
/** Allowed window range (s) — any other length snaps to the nearer of the two windows. */
export const TRACE_WINDOW_MIN_SEC = TRACE_WINDOW_HOUR_SEC;
export const TRACE_WINDOW_MAX_SEC = TRACE_WINDOW_DAY_SEC;

/** Snap a requested window length to the nearer kept window (geometric mean as the border). */
export function snapTraceWindowSec(sec: number): number {
  if (!Number.isFinite(sec)) return TRACE_WINDOW_DEFAULT_SEC;
  return sec > Math.sqrt(TRACE_WINDOW_HOUR_SEC * TRACE_WINDOW_DAY_SEC) ? TRACE_WINDOW_DAY_SEC : TRACE_WINDOW_HOUR_SEC;
}

/** One sliding window: a ring of {@link TRACE_SLOTS} slots plus the running sum. */
class SlidingWindow {
  readonly slotSec: number;
  ring: [Uint16Array, Uint16Array] = [new Uint16Array(0), new Uint16Array(0)];
  sum: [Uint32Array, Uint32Array] = [new Uint32Array(0), new Uint32Array(0)];
  readonly slotSamples = new Uint32Array(TRACE_SLOTS);
  samples = 0;
  curSlot = 0;
  /** Offset of the current slot in `ring` (curSlot % SLOTS × B). */
  off = 0;
  constructor(readonly sec: number) { this.slotSec = sec / TRACE_SLOTS; }
}
/** Speed (m/s) below which a vehicle "stands". */
export const TRACE_V_EPS = 0.01;

export type TraceView = 'blocked' | 'utilization';
export type TraceRange = 'window' | 'start';

/** One reported bucket (MCP / tests). */
export interface TraceRow {
  pathId: string;
  fromM: number;
  toM: number;
  value: number;
  pos: [number, number, number];
}

/**
 * Deterministic work counters (plan-629 gate R2-4) — what the sampling costs,
 * counted, not timed. Includes the search and ring work, not only the writes.
 */
export interface TraceWork {
  /** Grid points sampled. */
  samples: number;
  /** Vehicle evaluations (one per vehicle and grid point that reached a source). */
  vehicleEvals: number;
  /** Bucket visits of `cover()` (both views, every visit — written or de-duped). */
  bucketVisits: number;
  /** `cover()` calls. */
  covers: number;
  /** Ring slot changes. */
  slotChanges: number;
  /** Buckets cleared by slot changes (O(buckets) per change). */
  slotClearBuckets: number;
  /** Live source: grid cells probed. */
  searchCells: number;
  /** Live source: polyline segments tested. */
  searchCandidates: number;
}

/** Sink the sampler writes into — one call per vehicle and grid point. */
export interface TraceSink {
  /** Current grid time (s) of the sample being written. */
  readonly sampleTime: number;
  /**
   * Body interval `[sFrom, sTo]` (geometric arc length, m) on bucket-table piece
   * `pathIdx`, clamped to the piece. `blocked` adds the interval to the blocked view.
   */
  cover(pathIdx: number, sFrom: number, sTo: number, blocked: boolean): void;
}

/** Sampler: report every vehicle at grid time `tk` into `sink`. */
export type TraceSampler = (tk: number, sink: TraceSink) => void;

/**
 * "Blocked" classifier, shared by every source: the vehicle stands although
 * it wants to move, or the source reports an explicit blocked flag.
 */
export function classifyBlocked(speed: number, wantsToMove: boolean, blockedFlag: boolean): boolean {
  return blockedFlag || (wantsToMove && Math.abs(speed) < TRACE_V_EPS);
}

export function newTraceWork(): TraceWork {
  return {
    samples: 0, vehicleEvals: 0, bucketVisits: 0, covers: 0, slotChanges: 0, slotClearBuckets: 0,
    searchCells: 0, searchCandidates: 0,
  };
}

const _v = new Vector3();

/** The congestion trace accumulator — see the module doc. */
export class PathTrace implements TraceSink {
  // ── Bucket table ────────────────────────────────────────────────────────
  /** Pieces in bucket-table order (sorted by id). */
  private _paths: RVPath[] = [];
  private readonly byPath = new Map<RVPath, number>();
  private readonly byId = new Map<string, number>();
  private pathFirst = new Int32Array(0);
  private pathCount = new Int32Array(0);
  private pathBucketLen = new Float64Array(0);
  /** Bucket → piece index. */
  private bucketPath = new Int32Array(0);
  /** Bucket centre world position (x, y, z). */
  private bucketPos = new Float64Array(0);
  private B = 0;

  // ── Counters (index 0 = blocked, 1 = utilization) ───────────────────────
  /** Last hour and last day, always both counted; `active` is the one `'window'` reads. */
  private readonly wins: SlidingWindow[] = TRACE_WINDOWS_SEC.map((sec) => new SlidingWindow(sec));
  private active = 0;
  private total: [Uint32Array, Uint32Array] = [new Uint32Array(0), new Uint32Array(0)];
  private stamp: [Uint32Array, Uint32Array] = [new Uint32Array(0), new Uint32Array(0)];
  private _samplesTotal = 0;
  private stampNo = 0;
  /** Bumps on every counter change, reset and window change (colour invalidation). */
  private _version = 0;

  // ── Grid cursor ─────────────────────────────────────────────────────────
  private lastK = 0;
  private _time = 0;
  private _sampleTime = 0;

  /** Deterministic work counters (never reset by {@link reset} — the caller owns them). */
  readonly work: TraceWork = newTraceWork();

  /** Sim time up to which the trace has been advanced (s). */
  get simTime(): number { return this._time; }
  /** Grid points counted since start (or since the last reset / geometry change). */
  get samplesTotal(): number { return this._samplesTotal; }
  /** Grid points inside the current window. */
  get samplesWindow(): number { return this.wins[this.active].samples; }
  get windowSec(): number { return this.wins[this.active].sec; }
  get bucketCount(): number { return this.B; }
  get paths(): readonly RVPath[] { return this._paths; }
  /** Index of the last sampled grid point (k). */
  get lastSampleIndex(): number { return this.lastK; }
  /** Bumps whenever a displayed value may have changed. */
  get version(): number { return this._version; }
  get sampleTime(): number { return this._sampleTime; }

  /**
   * (Re)build the bucket table from `paths` and zero every counter. The grid
   * cursor and the sim time stay — after a geometry change the measurement
   * starts NOW, nothing is re-sampled (gate R1-5).
   */
  rebuild(paths: readonly RVPath[]): void {
    const sorted = [...paths].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    this._paths = sorted;
    this.byPath.clear();
    this.byId.clear();
    const n = sorted.length;
    this.pathFirst = new Int32Array(n);
    this.pathCount = new Int32Array(n);
    this.pathBucketLen = new Float64Array(n);
    let B = 0;
    for (let i = 0; i < n; i++) {
      const p = sorted[i];
      this.byPath.set(p, i);
      this.byId.set(p.id, i);
      const L = Math.max(0, p.length);
      const c = Math.max(1, Math.round(L / TRACE_BUCKET_M));
      this.pathFirst[i] = B;
      this.pathCount[i] = c;
      this.pathBucketLen[i] = L > 0 ? L / c : 0;
      B += c;
    }
    this.B = B;
    this.bucketPath = new Int32Array(B);
    this.bucketPos = new Float64Array(B * 3);
    for (let i = 0; i < n; i++) {
      const p = sorted[i];
      const f = this.pathFirst[i];
      for (let j = 0; j < this.pathCount[i]; j++) {
        this.bucketPath[f + j] = i;
        p.getAbsPosition((j + 0.5) * this.pathBucketLen[i], _v);
        this.bucketPos[(f + j) * 3] = _v.x;
        this.bucketPos[(f + j) * 3 + 1] = _v.y;
        this.bucketPos[(f + j) * 3 + 2] = _v.z;
      }
    }
    for (const win of this.wins) {
      win.ring = [new Uint16Array(TRACE_SLOTS * B), new Uint16Array(TRACE_SLOTS * B)];
      win.sum = [new Uint32Array(B), new Uint32Array(B)];
      win.off = (win.curSlot % TRACE_SLOTS) * B;
    }
    for (let w = 0; w < 2; w++) {
      this.total[w] = new Uint32Array(B);
      this.stamp[w] = new Uint32Array(B);
    }
    this.zeroCounters();
  }

  /** Bucket-table index of a piece (−1 = not in the table). Object first, then id (an edited piece). */
  indexOfPath(path: RVPath): number {
    const i = this.byPath.get(path);
    if (i !== undefined) return i;
    return this.byId.get(path.id) ?? -1;
  }

  /** Bucket-table index of a piece id (−1 = unknown). */
  indexOfPathId(id: string): number {
    return this.byId.get(id) ?? -1;
  }

  /** First bucket / bucket count / bucket length (m) of a piece. */
  pathBuckets(pathIdx: number): { first: number; count: number; length: number } {
    return { first: this.pathFirst[pathIdx], count: this.pathCount[pathIdx], length: this.pathBucketLen[pathIdx] };
  }

  /** Piece index of a bucket. */
  pathOfBucket(bucket: number): number { return this.bucketPath[bucket]; }

  /** Bucket range [fromM, toM] on its piece. */
  bucketRange(bucket: number): [number, number] {
    const p = this.bucketPath[bucket];
    const j = bucket - this.pathFirst[p];
    const l = this.pathBucketLen[p];
    return [j * l, (j + 1) * l];
  }

  /** Full reset to sim time 0 (sim reset / time ran backwards / model switch). */
  reset(): void {
    this.lastK = 0;
    this._time = 0;
    for (const win of this.wins) { win.curSlot = 0; win.off = 0; }
    this.zeroCounters();
  }

  /**
   * Start measuring at `now` without sampling the past: counters stay as they
   * are (call after {@link reset} / {@link rebuild}), the grid cursor jumps to
   * the last point before `now`. A `now` behind the cursor is a no-op.
   */
  beginAt(now: number): void {
    if (!(now > this._time)) return;
    const k = Math.max(0, Math.ceil(now / TRACE_SAMPLE_SEC) - 1);
    if (k > this.lastK) this.lastK = k;
    this._time = now;
    for (const win of this.wins) {
      const slot = Math.floor((this.lastK * TRACE_SAMPLE_SEC) / win.slotSec);
      if (slot !== win.curSlot) this.rotateTo(win, slot);
    }
  }

  /**
   * Select the displayed window: the last hour or the last day (any other
   * length snaps to the nearer one). Both are always counted, so a switch
   * shows the full history at once — nothing is emptied.
   */
  setWindowSec(sec: number): void {
    const want = snapTraceWindowSec(sec);
    this.active = Math.max(0, this.wins.findIndex((w) => w.sec === want));
    this._version++;
  }

  /**
   * Sample every grid point `t_k < t` not sampled yet, ascending. A `t` behind
   * the current time is a sim reset: everything restarts at 0 first.
   */
  advanceTo(t: number, sampler: TraceSampler): void {
    if (t < this._time - 1e-9) this.reset();
    if (t > this._time) this._time = t;
    for (;;) {
      const k = this.lastK + 1;
      const tk = k * TRACE_SAMPLE_SEC;
      if (!(tk < t)) break;
      for (const win of this.wins) {
        const slot = Math.floor(tk / win.slotSec);
        if (slot !== win.curSlot) this.rotateTo(win, slot);
      }
      this.lastK = k;
      this._sampleTime = tk;
      this.stampNo = (this.stampNo + 1) >>> 0;
      if (this.stampNo === 0) { this.stamp[0].fill(0); this.stamp[1].fill(0); this.stampNo = 1; }
      sampler(tk, this);
      this._samplesTotal++;
      for (const win of this.wins) {
        win.samples++;
        win.slotSamples[win.curSlot % TRACE_SLOTS]++;
      }
      this.work.samples++;
      this._version++;
    }
  }

  /** IMPLEMENTS TraceSink::cover — see the interface. */
  cover(pathIdx: number, sFrom: number, sTo: number, blocked: boolean): void {
    if (pathIdx < 0 || pathIdx >= this._paths.length) return;
    this.work.covers++;
    const n = this.pathCount[pathIdx];
    const bl = this.pathBucketLen[pathIdx];
    const L = bl * n;
    let a = Math.min(sFrom, sTo), b = Math.max(sFrom, sTo);
    if (b < 0 || a > L) return;
    a = Math.max(0, a); b = Math.min(L, b);
    let j0 = bl > 0 ? Math.floor(a / bl) : 0;
    let j1 = bl > 0 ? Math.ceil(b / bl) - 1 : 0;
    if (j0 > n - 1) j0 = n - 1;
    if (j1 > n - 1) j1 = n - 1;
    if (j1 < j0) j1 = j0;
    const first = this.pathFirst[pathIdx];
    const st = this.stampNo;
    for (let j = j0; j <= j1; j++) {
      const bk = first + j;
      this.work.bucketVisits++;
      this.bump(1, bk, st);
      if (blocked) this.bump(0, bk, st);
    }
  }

  /** Value of `bucket` in `view` / `range` ∈ [0, 1]; NaN = no grid point in the range. */
  value(view: TraceView, range: TraceRange, bucket: number): number {
    const w = view === 'blocked' ? 0 : 1;
    if (range === 'window') {
      const win = this.wins[this.active];
      return win.samples > 0 ? win.sum[w][bucket] / win.samples : Number.NaN;
    }
    return this._samplesTotal > 0 ? this.total[w][bucket] / this._samplesTotal : Number.NaN;
  }

  /** Raw counter of `bucket` (tests / determinism). */
  count(view: TraceView, range: TraceRange, bucket: number): number {
    const w = view === 'blocked' ? 0 : 1;
    return range === 'window' ? this.wins[this.active].sum[w][bucket] : this.total[w][bucket];
  }

  /**
   * The `n` highest buckets of `view` / `range` into `out` (row objects reused),
   * sorted by value desc, then piece id, then fromM asc; zeros omitted.
   * Returns the row count.
   */
  topN(view: TraceView, range: TraceRange, n: number, out: TraceRow[]): number {
    const w = view === 'blocked' ? 0 : 1;
    const cnt = range === 'window' ? this.wins[this.active].sum[w] : this.total[w];
    const den = range === 'window' ? this.wins[this.active].samples : this._samplesTotal;
    const lim = Math.max(0, Math.floor(n));
    if (den === 0 || lim === 0) { out.length = 0; return 0; }
    // Bucket order == (piece id, fromM) order — ties resolve by the lower bucket index.
    const pick: number[] = [];
    for (let b = 0; b < this.B; b++) {
      const c = cnt[b];
      if (c === 0) continue;
      if (pick.length === lim && c <= cnt[pick[lim - 1]]) continue;
      let i = pick.length < lim ? pick.length : lim - 1;
      if (pick.length < lim) pick.push(b); else pick[i] = b;
      while (i > 0 && cnt[pick[i - 1]] < c) { pick[i] = pick[i - 1]; i--; }
      pick[i] = b;
    }
    out.length = pick.length;
    for (let i = 0; i < pick.length; i++) {
      const b = pick[i];
      const row = out[i] ?? ({ pathId: '', fromM: 0, toM: 0, value: 0, pos: [0, 0, 0] } as TraceRow);
      const [from, to] = this.bucketRange(b);
      row.pathId = this._paths[this.bucketPath[b]].id;
      row.fromM = from;
      row.toM = to;
      row.value = cnt[b] / den;
      row.pos[0] = this.bucketPos[b * 3]; row.pos[1] = this.bucketPos[b * 3 + 1]; row.pos[2] = this.bucketPos[b * 3 + 2];
      out[i] = row;
    }
    return pick.length;
  }

  /** Bucket centre world position into `out` ([x, y, z]). */
  bucketPosition(bucket: number, out: [number, number, number]): [number, number, number] {
    out[0] = this.bucketPos[bucket * 3]; out[1] = this.bucketPos[bucket * 3 + 1]; out[2] = this.bucketPos[bucket * 3 + 2];
    return out;
  }

  /** Copy of a counter array (tests / determinism comparison). */
  snapshotCounts(view: TraceView, range: TraceRange): Uint32Array {
    const w = view === 'blocked' ? 0 : 1;
    return Uint32Array.from(range === 'window' ? this.wins[this.active].sum[w] : this.total[w]);
  }

  // ── Internals ───────────────────────────────────────────────────────────

  private bump(w: 0 | 1, bk: number, st: number): void {
    const s = this.stamp[w];
    if (s[bk] === st) return;
    s[bk] = st;
    for (const win of this.wins) {
      win.ring[w][win.off + bk]++;
      win.sum[w][bk]++;
    }
    this.total[w][bk]++;
  }

  /** Advance a window's ring to `slot`: each newly entered slot drops its old contents from the window. */
  private rotateTo(win: SlidingWindow, slot: number): void {
    const steps = Math.min(TRACE_SLOTS, Math.max(1, slot - win.curSlot));
    for (let i = 1; i <= steps; i++) {
      const r = ((win.curSlot + i) % TRACE_SLOTS);
      const off = r * this.B;
      for (let w = 0; w < 2; w++) {
        const ring = win.ring[w];
        const sum = win.sum[w];
        for (let b = 0; b < this.B; b++) {
          const c = ring[off + b];
          if (c !== 0) { sum[b] -= c; ring[off + b] = 0; }
        }
      }
      win.samples -= win.slotSamples[r];
      win.slotSamples[r] = 0;
      this.work.slotChanges++;
      this.work.slotClearBuckets += this.B;
    }
    win.curSlot = slot;
    win.off = (slot % TRACE_SLOTS) * this.B;
  }

  private zeroCounters(): void {
    for (let w = 0; w < 2; w++) { this.total[w].fill(0); this.stamp[w].fill(0); }
    for (const win of this.wins) {
      win.ring[0].fill(0); win.ring[1].fill(0); win.sum[0].fill(0); win.sum[1].fill(0);
      win.slotSamples.fill(0);
      win.samples = 0;
    }
    this._samplesTotal = 0;
    this.stampNo = 0;
    this._version++;
  }
}
