// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-path-trace-sources.ts — what the congestion trace (plan-629) samples and
 * WHEN it samples.
 *
 * Sources (one per vehicle, chosen by `AgvHandle.traceSource`):
 *
 * - **planned** — the movement authority's plan, read analytically with
 *   `locate(id, t_k)` (geometric `s`). Body interval `[s − rear, s + front]`
 *   straight from the body extents: a planned vehicle's orientation follows the
 *   positive path tangent, also while reversing — no object pose is read
 *   (gate R2-3), so the result does not depend on rendering.
 * - **legacy** — the continuous step mode: the traveler state (position,
 *   speed), never the authority's standstill obstacle plan (gate R1-2).
 * - **live** — an interface moves the vehicle: the node's world position,
 *   searched in a grid (candidates only), then PROJECTED onto the path
 *   geometry (≤ {@link TRACE_LIVE_MAX_LATERAL_M} lateral); the body interval
 *   follows the vehicle's physical heading relative to the path tangent. Equal
 *   distance to two pieces: the smaller piece id wins (gate R1-7).
 *
 * "Wants to move": planned / legacy = `Run` and phase driving / cruising (and
 * not at a service / dead-end stop); live = `Run && !Moving`. Live and legacy
 * also count the `Agv.Blocked` signal.
 *
 * Time drivers (the sampling invariant: when `t_k` is sampled, every event
 * ≤ `t_k` is processed and none after it):
 *
 * - **continuous** — `MotionEventClock.onBeforeAdvance` inside
 *   `advanceTo()`: before every due event and for the end horizon, i.e. before
 *   the vehicles' `syncTo` (gate R2-1). Authority time, not drawn poses.
 * - **DES** — the manager's time-advance listener (before the first event of a
 *   new time) plus, at render time, the horizon `H = min(renderClock,
 *   nextEventTime)` (gate R1-4).
 * - **legacy / live without planned vehicles** — the sum of the fixed `dt`.
 *
 * A clock that runs BACKWARDS (sim reset) restarts the trace at 0; a geometry
 * rebuild and a (re)attach start measuring NOW — nothing is re-sampled
 * (gate R1-5).
 */

import { Vector3 } from 'three';
import type { RVPath } from './rv-path';
import {
  getDefaultAgvFleet,
  type AgvFleet, type AgvHandle, type AgvBodyInfo, type AgvSignalStatus, type AgvTravelerState,
} from './rv-agv-fleet';
import { getDefaultMovementAuthority, type MovementAuthority } from './rv-movement-authority';
import { PathTrace, classifyBlocked, TRACE_V_EPS, type TraceSink } from './rv-path-trace';

/** Maximum lateral distance (m) of a live vehicle from a path to count. */
export const TRACE_LIVE_MAX_LATERAL_M = 1.5;
/** Grid cell (m) of the live candidate search. */
export const TRACE_LIVE_CELL_M = 2;
/** Chord length (m) of the projection polyline. */
export const TRACE_LIVE_CHORD_M = 0.25;

/** The DES time surface the trace needs (structural subset of `SimDesControl`). */
export interface TraceDesClock {
  readonly simTime: number;
  readonly renderClock?: number;
  readonly nextEventTime?: number;
  addTimeAdvanceListener?(fn: (time: number) => void): () => void;
}

/** Projection result of {@link PathProjector.project}. */
export interface TraceProjection {
  pathIdx: number;
  s: number;
  /** Lateral distance (m, XZ plane). */
  dist: number;
  /** Path tangent at the point (XZ, normalised). */
  tx: number;
  tz: number;
}

const CELL_KEY_SPAN = 1 << 20;

/**
 * Projection of a world point onto the trace's pieces: a chord polyline per
 * piece, indexed by a uniform XZ grid (cell = {@link TRACE_LIVE_CELL_M}). A
 * chord is registered in the cell of its START point; with chords ≤ 0.25 m
 * and a 1.5 m limit, the 3×3 cells around the query point hold every
 * reachable chord.
 */
export class PathProjector {
  private ax = new Float64Array(0);
  private az = new Float64Array(0);
  private bx = new Float64Array(0);
  private bz = new Float64Array(0);
  private s0 = new Float64Array(0);
  private s1 = new Float64Array(0);
  private segPath = new Int32Array(0);
  /** Sorted unique cell keys and CSR offsets into `cellSeg`. */
  private cellKeys = new Float64Array(0);
  private cellStart = new Int32Array(0);
  private cellSeg = new Int32Array(0);

  build(paths: readonly RVPath[]): void {
    const v = new Vector3();
    const ax: number[] = [], az: number[] = [], bx: number[] = [], bz: number[] = [];
    const s0: number[] = [], s1: number[] = [], sp: number[] = [];
    for (let p = 0; p < paths.length; p++) {
      const path = paths[p];
      const L = path.length;
      if (!(L > 0)) continue;
      const n = Math.max(1, Math.ceil(L / TRACE_LIVE_CHORD_M));
      path.getAbsPosition(0, v);
      let px = v.x, pz = v.z, ps = 0;
      for (let i = 1; i <= n; i++) {
        const s = (L * i) / n;
        path.getAbsPosition(s, v);
        ax.push(px); az.push(pz); bx.push(v.x); bz.push(v.z); s0.push(ps); s1.push(s); sp.push(p);
        px = v.x; pz = v.z; ps = s;
      }
    }
    const N = ax.length;
    this.ax = Float64Array.from(ax); this.az = Float64Array.from(az);
    this.bx = Float64Array.from(bx); this.bz = Float64Array.from(bz);
    this.s0 = Float64Array.from(s0); this.s1 = Float64Array.from(s1);
    this.segPath = Int32Array.from(sp);
    const order = new Array<number>(N);
    const keys = new Float64Array(N);
    for (let i = 0; i < N; i++) { order[i] = i; keys[i] = this.keyOf(this.ax[i], this.az[i]); }
    order.sort((a, b) => keys[a] - keys[b] || a - b);
    const uk: number[] = [], us: number[] = [];
    this.cellSeg = new Int32Array(N);
    for (let i = 0; i < N; i++) {
      const k = keys[order[i]];
      if (uk.length === 0 || uk[uk.length - 1] !== k) { uk.push(k); us.push(i); }
      this.cellSeg[i] = order[i];
    }
    us.push(N);
    this.cellKeys = Float64Array.from(uk);
    this.cellStart = Int32Array.from(us);
  }

  /**
   * Nearest piece point to (x, z) within `maxDist` → `out` (false = none).
   * `work` counts the probed cells and tested chords.
   */
  project(x: number, z: number, maxDist: number, out: TraceProjection,
    work: { searchCells: number; searchCandidates: number }): boolean {
    const cx = Math.floor(x / TRACE_LIVE_CELL_M), cz = Math.floor(z / TRACE_LIVE_CELL_M);
    let best = Number.POSITIVE_INFINITY, bestPath = -1;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        work.searchCells++;
        const c = this.findCell((cx + dx) * CELL_KEY_SPAN + (cz + dz));
        if (c < 0) continue;
        for (let j = this.cellStart[c]; j < this.cellStart[c + 1]; j++) {
          const i = this.cellSeg[j];
          work.searchCandidates++;
          const ex = this.bx[i] - this.ax[i], ez = this.bz[i] - this.az[i];
          const len2 = ex * ex + ez * ez;
          let u = len2 > 0 ? ((x - this.ax[i]) * ex + (z - this.az[i]) * ez) / len2 : 0;
          u = u < 0 ? 0 : u > 1 ? 1 : u;
          const qx = this.ax[i] + u * ex - x, qz = this.az[i] + u * ez - z;
          const d = Math.sqrt(qx * qx + qz * qz);
          if (d > maxDist) continue;
          const p = this.segPath[i];
          // Strictly nearer wins; an equal distance goes to the smaller piece index (= smaller id).
          if (d < best - 1e-9 || (Math.abs(d - best) <= 1e-9 && p < bestPath)) {
            best = d; bestPath = p;
            const len = Math.sqrt(len2);
            out.pathIdx = p;
            out.s = this.s0[i] + u * (this.s1[i] - this.s0[i]);
            out.dist = d;
            out.tx = len > 0 ? ex / len : 1;
            out.tz = len > 0 ? ez / len : 0;
          }
        }
      }
    }
    return bestPath >= 0;
  }

  private keyOf(x: number, z: number): number {
    return Math.floor(x / TRACE_LIVE_CELL_M) * CELL_KEY_SPAN + Math.floor(z / TRACE_LIVE_CELL_M);
  }

  private findCell(key: number): number {
    const k = this.cellKeys;
    let lo = 0, hi = k.length - 1;
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      if (k[m] === key) return m;
      if (k[m] < key) lo = m + 1; else hi = m - 1;
    }
    return -1;
  }
}

const _pos = new Vector3();
const _fwd = new Vector3();

/**
 * Samples every vehicle of the fleet into the trace (the {@link TraceSampler}
 * of {@link PathTraceDriver}). Allocation-free per sample.
 */
export class TraceVehicleSampler {
  /** Authority of the `planned` vehicles (set by the attached driver). */
  planned: MovementAuthority | null = null;
  readonly projector = new PathProjector();
  private readonly bodyOut: AgvBodyInfo = { front: 0, rear: 0, width: 0 };
  private readonly sigOut: AgvSignalStatus = { run: false, moving: false, blocked: false, speed: 0 };
  private readonly travOut: AgvTravelerState = { path: null, s: 0, speed: 0, atEnd: false };
  private readonly projOut: TraceProjection = { pathIdx: -1, s: 0, dist: 0, tx: 1, tz: 0 };

  constructor(readonly trace: PathTrace, readonly fleet: AgvFleet = getDefaultAgvFleet()) {}

  /** The sampler callback — bound once, passed to `PathTrace.advanceTo`. */
  readonly sample = (tk: number, sink: TraceSink): void => {
    const hs = this.fleet.handleList;
    for (let i = 0; i < hs.length; i++) this.sampleOne(hs[i], tk, sink);
  };

  private sampleOne(h: AgvHandle, tk: number, sink: TraceSink): void {
    const src = h.traceSource;
    if (src === undefined || !h.body || !h.signalStatus) return;
    const body = this.bodyOut;
    const sig = this.sigOut;
    if (src === 'planned') {
      const mb = this.planned;
      if (!mb || !mb.has(h.id)) return;
      const loc = mb.locate(h.id, tk);
      if (!loc) return;
      const p = this.trace.indexOfPath(loc.path);
      if (p < 0) return;
      h.body(body);
      // "Wants to move" only matters while the vehicle stands — the cheap checks first,
      // the Run signal last (classifyBlocked with blockedFlag = false, evaluated lazily).
      let blocked = false;
      if (Math.abs(loc.v) < TRACE_V_EPS) {
        const phase = h.phase;
        if (phase === 'driving' || phase === 'cruising') {
          const cause = mb.stopCauseOf(h.id);
          if (cause !== 'service' && cause !== 'deadend') {
            h.signalStatus(sig);
            blocked = classifyBlocked(loc.v, sig.run, false);
          }
        }
      }
      this.trace.work.vehicleEvals++;
      sink.cover(p, loc.s - body.rear, loc.s + body.front, blocked);
      return;
    }
    if (src === 'legacy') {
      const tr = this.travOut;
      if (!h.travelerState || !h.travelerState(tr) || !tr.path) return;
      const p = this.trace.indexOfPath(tr.path);
      if (p < 0) return;
      h.body(body);
      h.signalStatus(sig);
      const phase = h.phase;
      const wants = sig.run && (phase === 'driving' || phase === 'cruising') && !tr.atEnd;
      this.trace.work.vehicleEvals++;
      sink.cover(p, tr.s - body.rear, tr.s + body.front, classifyBlocked(tr.speed, wants, sig.blocked));
      return;
    }
    // live: world pose → projection onto the path geometry.
    const node = h.node;
    if (!node) return;
    node.getWorldPosition(_pos);
    const pr = this.projOut;
    if (!this.projector.project(_pos.x, _pos.z, TRACE_LIVE_MAX_LATERAL_M, pr, this.trace.work)) return;
    h.body(body);
    h.signalStatus(sig);
    node.getWorldDirection(_fwd);
    const aligned = _fwd.x * pr.tx + _fwd.z * pr.tz >= 0;
    const ahead = aligned ? body.front : body.rear;
    const behind = aligned ? body.rear : body.front;
    const wants = sig.run && !sig.moving;
    this.trace.work.vehicleEvals++;
    sink.cover(pr.pathIdx, pr.s - behind, pr.s + ahead, classifyBlocked(sig.speed, wants, sig.blocked));
  }
}

/**
 * Drives a {@link PathTrace} from the simulation clocks — see the module doc.
 * One driver serves one trace; attach the clock of the active kernel.
 */
export class PathTraceDriver {
  readonly sampler: TraceVehicleSampler;
  private detachers: (() => void)[] = [];
  private lastClockT = Number.NEGATIVE_INFINITY;
  private lastDesT = Number.NEGATIVE_INFINITY;
  private clockFired = false;
  /** Never sample at or beyond this sim time (s) — "measure until" (studies, equal-horizon comparisons). */
  horizonLimit = Number.POSITIVE_INFINITY;

  constructor(readonly trace: PathTrace = new PathTrace(), fleet: AgvFleet = getDefaultAgvFleet()) {
    this.sampler = new TraceVehicleSampler(trace, fleet);
  }

  /** Bucket table + projection from `paths`; the measurement restarts at `now` (default: the trace time). */
  rebuild(paths: readonly RVPath[], now = this.trace.simTime): void {
    this.trace.rebuild(paths);
    this.sampler.projector.build(this.trace.paths);
    this.align(now);
  }

  /** Sim reset: zero everything and measure from `now` (0 = a run that restarts at 0). */
  reset(now = 0): void {
    this.trace.reset();
    this.lastClockT = Number.NEGATIVE_INFINITY;
    this.lastDesT = Number.NEGATIVE_INFINITY;
    this.trace.beginAt(now);
  }

  /**
   * Continuous kernel: observe the authority clock (`onBeforeAdvance`) — the
   * planned vehicles are sampled before every event and the end horizon.
   */
  attachContinuous(mb: MovementAuthority = getDefaultMovementAuthority('continuous')): () => void {
    this.sampler.planned = mb;
    this.align(mb.clock.now);
    this.lastClockT = mb.clock.now;
    const off = mb.clock.onBeforeAdvance((t) => this.onClock(t));
    return this.keep(off);
  }

  /**
   * DES kernel: the manager's time-advance listener (before each new event
   * time). Call {@link renderDes} once per frame for the render horizon.
   */
  attachDes(ctl: TraceDesClock, mb: MovementAuthority = getDefaultMovementAuthority('des')): () => void {
    this.sampler.planned = mb;
    this.align(ctl.simTime);
    this.lastDesT = ctl.simTime;
    const off = ctl.addTimeAdvanceListener ? ctl.addTimeAdvanceListener((t) => this.onDesEvent(t)) : () => {};
    return this.keep(off);
  }

  /** DES render tick: sample up to `H = min(renderClock, nextEventTime)` (forward only). */
  renderDes(ctl: TraceDesClock): void {
    const rc = ctl.renderClock ?? ctl.simTime;
    const ne = ctl.nextEventTime ?? ctl.simTime;
    const h = rc < ne ? rc : ne;
    this.forward(h);
  }

  /**
   * Fixed tick of the continuous / live kernel (after every vehicle moved):
   * without a clock-driven sample in this tick (no planned vehicle), the trace
   * advances by `dt` (legacy / live time base).
   */
  tickFixed(dt: number): void {
    if (this.clockFired) { this.clockFired = false; return; }
    if (dt > 0) this.forward(this.trace.simTime + dt);
  }

  /** Remove every clock subscription. */
  detach(): void {
    for (const off of this.detachers) off();
    this.detachers = [];
    this.sampler.planned = null;
  }

  private onClock(t: number): void {
    this.clockFired = true;
    if (t < this.lastClockT - 1e-9) this.trace.reset();
    this.lastClockT = t;
    this.forward(t);
  }

  private onDesEvent(t: number): void {
    if (t < this.lastDesT - 1e-9) this.trace.reset();
    this.lastDesT = t;
    this.forward(t);
  }

  /** Advance the trace forward to `t` (capped by {@link horizonLimit}); never backwards. */
  private forward(t: number): void {
    const h = t < this.horizonLimit ? t : this.horizonLimit;
    if (h > this.trace.simTime) this.trace.advanceTo(h, this.sampler.sample);
  }

  /** A clock behind the trace is a new run (reset); then measure from `now` on. */
  private align(now: number): void {
    if (now < this.trace.simTime - 1e-9) this.trace.reset();
    this.trace.beginAt(now);
  }

  private keep(off: () => void): () => void {
    this.detachers.push(off);
    return () => {
      off();
      const i = this.detachers.indexOf(off);
      if (i >= 0) this.detachers.splice(i, 1);
    };
  }
}
