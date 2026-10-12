// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-motion-profile.ts — closed-form time-optimal speed profiles along a 1D
 * route coordinate (plan-558). Pure: no Three.js, no clock, no allocation in
 * the evaluators (`positionAt`, `speedAt`, `timeAt`, `minSeparation`).
 *
 * UNITS: METERS and SECONDS throughout (m, m/s, m/s²). Callers holding the
 * inspector units (mm, mm/s, mm/s²) convert at the boundary.
 *
 * Model: the admissible speed is a piecewise-LINEAR function of v² over
 * position (`LimitPiece`: v²(x) ≤ c0 + c1·(x − x0) on [x0, x1]). Constant
 * speed limits (cruise, curve `√(aLat·R)`, docking crawl) are pieces with
 * c1 = 0; the shifted planned trajectory of a leading vehicle is ALSO such a
 * function, because every constant-acceleration phase is linear in v² over x
 * (v² = v0² + 2a·Δx). The planner takes the lower envelope of
 *   - the limits L(x),
 *   - the forward pass  F(x) = min(L, v0² + 2a·Δx … per piece),
 *   - the backward pass B(x) = min(L, vEnd² + 2b·(xEnd − x) … per piece),
 * which is again piecewise linear in v², i.e. a sequence of constant-
 * acceleration PHASES with accelerations in [−b, a]. Each phase converts to
 * time in closed form. The reference semantics are `computeRampedSpeed`
 * (rv-drive.ts, braking point v²/2a) — the same physics, evaluated exactly
 * instead of per tick.
 *
 * Result contract: `feasible: true` — the profile reaches `xEnd` with `vEnd`
 * and respects every limit. `feasible: false` — the start state cannot honour
 * the end condition (the vehicle is too fast to stop in time): the profile is
 * an EMERGENCY STOP with the full deceleration `b` from (x0, v0) instead, and
 * its `xStop` lies beyond the requested end. Callers count that as `forced`.
 */

/** v² ≤ c0 + c1·(x − x0) on [x0, x1] (m, m²/s², m/s²·2). `c0 = Infinity` = no limit. */
export interface LimitPiece { x0: number; x1: number; c0: number; c1: number }

/** One constant-acceleration phase (t0 s, x0 m, v0 m/s, a m/s², dt s, x1 m). */
export interface ProfilePhase { t0: number; x0: number; v0: number; a: number; dt: number; x1: number }

/** A planned 1D trajectory: closed-form phases from (t0, x0, v0) to the end state. */
export interface MotionProfile {
  /** Sim time (s) the profile starts at. */
  readonly t0: number;
  /** Route coordinate (m) at `t0`. */
  readonly x0: number;
  /** Speed (m/s) at `t0`. */
  readonly v0: number;
  readonly phases: readonly ProfilePhase[];
  /** Route coordinate (m) of the profile END — the stop position when `vEnd` = 0. */
  readonly xStop: number;
  /** Sim time (s) the end is reached. */
  readonly tEnd: number;
  /** Speed (m/s) at the end; the vehicle keeps it after `tEnd` (0 = standstill). */
  readonly vEnd: number;
  /** False = the requested end was unreachable; the profile is an emergency stop. */
  readonly feasible: boolean;
}

/** Optional planner inputs beyond the start state. */
export interface PlanProfileOptions {
  /** Speed (m/s) at `xEnd` (default 0 = a stop). Clamped to the limits there. */
  vEnd?: number;
  /** `limits` are already contiguous and non-overlapping over [x0, xEnd] (skips the min pass). */
  disjoint?: boolean;
}

const EPS_X = 1e-9;

/** Validate a planner input — throws instead of producing NaN profiles. */
function assertFinite(name: string, v: number): void {
  if (!Number.isFinite(v)) throw new RangeError(`[rv-motion-profile] ${name} must be finite (got ${v})`);
}

/** A profile that stands still at `x` from `t0` on. */
export function stationaryProfile(t0: number, x: number): MotionProfile {
  return { t0, x0: x, v0: 0, phases: [], xStop: x, tEnd: t0, vEnd: 0, feasible: true };
}

// Scratch for the envelope sweeps (planning is synchronous, never re-entrant).
const _bps: number[] = [];
const _xs: number[] = [];
const _lineC: number[] = [];
const _lineS: number[] = [];

const _ptr: number[] = [];

/**
 * Pointwise minimum of several piecewise-linear v² functions over [xa, xb].
 * Each function is a list of pieces SORTED by x0 and non-overlapping (gaps
 * allowed — missing coverage counts as +∞). The result pieces are contiguous
 * over [xa, xb]; +∞ gaps get `c0 = Infinity`. One sweep with a cursor per
 * function: O((breakpoints + pieces) · functions).
 */
export function minLimits(fns: readonly (readonly LimitPiece[])[], xa: number, xb: number): LimitPiece[] {
  const bps = _bps;
  bps.length = 0;
  bps.push(xa, xb);
  for (const f of fns) {
    for (const p of f) {
      if (p.x0 > xa && p.x0 < xb) bps.push(p.x0);
      if (p.x1 > xa && p.x1 < xb) bps.push(p.x1);
    }
  }
  bps.sort((u, v) => u - v);
  const xs = _xs;
  xs.length = 0;
  for (const x of bps) if (xs.length === 0 || x - xs[xs.length - 1] > EPS_X) xs.push(x);
  const out: LimitPiece[] = [];
  const ptr = _ptr;
  ptr.length = fns.length;
  ptr.fill(0);
  for (let k = 0; k + 1 < xs.length; k++) {
    const l = xs[k], r = xs[k + 1];
    const mid = (l + r) / 2;
    _lineC.length = 0;
    _lineS.length = 0;
    for (let fi = 0; fi < fns.length; fi++) {
      const f = fns[fi];
      let j = ptr[fi];
      while (j < f.length && f[j].x1 < mid) j++;
      ptr[fi] = j;
      if (j < f.length && f[j].x0 <= mid) { const p = f[j]; _lineC.push(p.c0 + p.c1 * (l - p.x0)); _lineS.push(p.c1); }
    }
    if (_lineC.length === 0) { out.push({ x0: l, x1: r, c0: Infinity, c1: 0 }); continue; }
    lowerEnvelope(_lineC, _lineS, l, r, out);
  }
  return out;
}

/**
 * Lower envelope of the lines (value at `l`, slope) on [l, r], appended to
 * `out` split at the crossings. Ties prefer the smaller slope (it stays lower
 * to the right).
 */
function lowerEnvelope(cs: readonly number[], ss: readonly number[], l: number, r: number, out: LimitPiece[]): void {
  let x = l;
  while (r - x > EPS_X) {
    let best = 0;
    let bestV = cs[0] + ss[0] * (x - l);
    for (let i = 1; i < cs.length; i++) {
      const v = cs[i] + ss[i] * (x - l);
      const tol = 1e-12 + EPS_X * (Math.abs(ss[i]) + Math.abs(ss[best]));
      if (v < bestV - tol || (Math.abs(v - bestV) <= tol && ss[i] < ss[best])) { best = i; bestV = v; }
    }
    let xn = r;
    for (let i = 0; i < cs.length; i++) {
      if (i === best) continue;
      const ds = ss[i] - ss[best];
      if (ds >= 0) continue; // never gets lower to the right
      const vi = cs[i] + ss[i] * (x - l);
      const xc = x + (vi - bestV) / -ds;
      if (xc > x + EPS_X && xc < xn) xn = xc;
    }
    out.push({ x0: x, x1: xn, c0: bestV, c1: ss[best] });
    x = xn;
  }
}

/**
 * Plan the time-optimal profile from (x0, v0) at t0 to the end `xEnd` (a STOP
 * unless `opts.vEnd` > 0) under `limits` (gaps = +∞), acceleration `a` ≥ 0
 * and deceleration `b` > 0 (m/s²). `a = 0` means the vehicle cannot speed up
 * (it may still coast at v0 and brake). Throws `RangeError` on non-finite
 * inputs, a negative `a` or a non-positive `b`. A boolean `opts` is the
 * legacy `disjoint` flag.
 */
export function planProfile(
  t0: number, x0: number, v0: number, limits: readonly LimitPiece[],
  a: number, b: number, xEnd: number, opts: PlanProfileOptions | boolean = {},
): MotionProfile {
  const o: PlanProfileOptions = typeof opts === 'boolean' ? { disjoint: opts } : opts;
  assertFinite('t0', t0);
  assertFinite('x0', x0);
  assertFinite('v0', v0);
  assertFinite('xEnd', xEnd);
  assertFinite('a', a);
  assertFinite('b', b);
  if (a < 0) throw new RangeError(`[rv-motion-profile] acceleration must be >= 0 (got ${a})`);
  if (b <= 0) throw new RangeError(`[rv-motion-profile] deceleration must be > 0 (got ${b})`);
  const vEndReq = Math.max(0, o.vEnd ?? 0);
  assertFinite('vEnd', vEndReq);
  v0 = Math.max(0, v0);
  if (xEnd <= x0 + EPS_X) {
    if (v0 > vEndReq + 1e-6) return emergencyStop(t0, x0, v0, b);
    if (v0 > 1e-9) return { t0, x0, v0, phases: [], xStop: x0, tEnd: t0, vEnd: v0, feasible: true };
    return stationaryProfile(t0, x0);
  }
  // Every piece is its own function: overlapping pieces take the pointwise min.
  const L = o.disjoint ? clipLimits(limits, x0, xEnd) : minLimits(limits.map((q) => [q]), x0, xEnd);
  const n = L.length;
  // The end speed can never exceed the limit at the end.
  const lastP = L[n - 1];
  const vEnd2 = Math.min(vEndReq * vEndReq, lastP.c0 + lastP.c1 * (lastP.x1 - lastP.x0));
  // Forward pass: F at the left (right-limit) of each piece.
  const fLeft = new Array<number>(n);
  let fPrev = v0 * v0;
  for (let i = 0; i < n; i++) {
    const p = L[i];
    const fl = i === 0 ? fPrev : Math.min(fPrev, p.c0);
    fLeft[i] = fl;
    const len = p.x1 - p.x0;
    fPrev = Math.min(p.c0 + p.c1 * len, fl + 2 * a * len);
  }
  // Backward pass: B at the right (left-limit) of each piece.
  const bRight = new Array<number>(n);
  let bNext = vEnd2;
  for (let i = n - 1; i >= 0; i--) {
    const p = L[i];
    const len = p.x1 - p.x0;
    const br = i === n - 1 ? vEnd2 : Math.min(bNext, p.c0 + p.c1 * len);
    bRight[i] = br;
    bNext = Math.min(p.c0, br + 2 * b * len);
  }
  // Feasibility at the start: v0² must not exceed B(x0) nor L(x0).
  const startCap = Math.min(bNext, L[0].c0);
  if (v0 * v0 > startCap + 1e-6) return emergencyStop(t0, x0, v0, b);
  fLeft[0] = Math.min(fLeft[0], startCap);

  // Envelope pieces: min of (limit line, forward line, backward line) per piece.
  const phases: ProfilePhase[] = [];
  let t = t0;
  let vLast = Math.sqrt(Math.max(0, fLeft[0]));
  const cs = _lineC, ss = _lineS;
  for (let i = 0; i < n; i++) {
    const p = L[i];
    const len = p.x1 - p.x0;
    cs.length = 0;
    ss.length = 0;
    if (Number.isFinite(p.c0)) { cs.push(p.c0); ss.push(p.c1); }
    cs.push(fLeft[i]); ss.push(2 * a);
    cs.push(bRight[i] + 2 * b * len); ss.push(-2 * b);
    let x = p.x0;
    while (p.x1 - x > EPS_X) {
      let best = 0;
      let bestV = cs[0] + ss[0] * (x - p.x0);
      for (let k = 1; k < cs.length; k++) {
        const v = cs[k] + ss[k] * (x - p.x0);
        // Ties within the position resolution (EPS_X · slopes — matters for
        // the near-instant ramps of UseAcceleration = false) prefer the smaller slope.
        const tol = 1e-12 + EPS_X * (Math.abs(ss[k]) + Math.abs(ss[best]));
        if (v < bestV - tol || (Math.abs(v - bestV) <= tol && ss[k] < ss[best])) { best = k; bestV = v; }
      }
      let xn = p.x1;
      for (let k = 0; k < cs.length; k++) {
        if (k === best) continue;
        const ds = ss[k] - ss[best];
        if (ds >= 0) continue;
        const vk = cs[k] + ss[k] * (x - p.x0);
        const xc = x + (vk - bestV) / -ds;
        if (xc > x + EPS_X && xc < xn) xn = xc;
      }
      const va = Math.sqrt(Math.max(0, bestV));
      const vb = Math.sqrt(Math.max(0, cs[best] + ss[best] * (xn - p.x0)));
      if (va < 1e-6 && vb < 1e-6) {
        // Zero admissible speed over an interval → the vehicle cannot pass: it stops here.
        return finish(t0, x0, v0, phases, x, 0);
      }
      const acc = ss[best] / 2;
      const dt = Math.abs(acc) < 1e-12 ? (xn - x) / va : (vb - va) / acc;
      // Merge with the previous phase when continuous with the same acceleration.
      const prev = phases[phases.length - 1];
      if (prev && Math.abs(prev.a - acc) < 1e-12 && Math.abs(prev.x1 - x) < 1e-9) {
        prev.dt += dt;
        prev.x1 = xn;
      } else {
        phases.push({ t0: t, x0: x, v0: va, a: acc, dt, x1: xn });
      }
      t += dt;
      vLast = vb;
      x = xn;
    }
  }
  return finish(t0, x0, v0, phases, xEnd, vLast < 1e-6 ? 0 : vLast);
}

/** Clip an already contiguous, non-overlapping limit list to [xa, xb]. */
export function clipLimits(limits: readonly LimitPiece[], xa: number, xb: number): LimitPiece[] {
  const out: LimitPiece[] = [];
  for (const p of limits) {
    const a0 = Math.max(p.x0, xa), a1 = Math.min(p.x1, xb);
    if (a1 - a0 <= EPS_X) continue;
    out.push(a0 === p.x0
      ? (a1 === p.x1 ? p : { x0: p.x0, x1: a1, c0: p.c0, c1: p.c1 })
      : { x0: a0, x1: a1, c0: p.c0 + p.c1 * (a0 - p.x0), c1: p.c1 });
  }
  if (out.length === 0) out.push({ x0: xa, x1: xb, c0: Infinity, c1: 0 });
  return out;
}

function finish(t0: number, x0: number, v0: number, phases: ProfilePhase[], xEnd: number, vEnd: number): MotionProfile {
  // Re-anchor phase start times cumulatively (merged phases changed dt).
  let t = t0;
  for (const ph of phases) { ph.t0 = t; t += ph.dt; }
  return { t0, x0, v0, phases, xStop: xEnd, tEnd: t, vEnd, feasible: true };
}

/** Emergency stop with `b` from (x0, v0) — the result of an infeasible plan. */
export function emergencyStop(t0: number, x0: number, v0: number, b: number): MotionProfile {
  if (v0 <= 1e-9) return { ...stationaryProfile(t0, x0), feasible: false };
  const dt = v0 / b;
  const x1 = x0 + (v0 * v0) / (2 * b);
  return { t0, x0, v0, phases: [{ t0, x0, v0, a: -b, dt, x1 }], xStop: x1, tEnd: t0 + dt, vEnd: 0, feasible: false };
}

function phaseIndexAtTime(p: MotionProfile, t: number): number {
  const ph = p.phases;
  let lo = 0, hi = ph.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ph[mid].t0 <= t) lo = mid; else hi = mid - 1;
  }
  return lo;
}

/** Route position (m) at sim time t (before t0 → x0; after tEnd → xStop + vEnd·Δt). */
export function positionAt(p: MotionProfile, t: number): number {
  if (t <= p.t0) return p.x0;
  if (t >= p.tEnd) return p.vEnd > 0 ? p.xStop + p.vEnd * (t - p.tEnd) : p.xStop;
  const ph = p.phases[phaseIndexAtTime(p, t)];
  const tau = Math.min(Math.max(0, t - ph.t0), ph.dt);
  const x = ph.x0 + ph.v0 * tau + 0.5 * ph.a * tau * tau;
  return x > ph.x1 ? ph.x1 : x;
}

/** Speed (m/s) at sim time t. */
export function speedAt(p: MotionProfile, t: number): number {
  if (t >= p.tEnd) return p.vEnd;
  if (t <= p.t0) return p.v0;
  const ph = p.phases[phaseIndexAtTime(p, t)];
  const tau = Math.min(Math.max(0, t - ph.t0), ph.dt);
  return Math.max(0, ph.v0 + ph.a * tau);
}

/** Acceleration (m/s²) at sim time t (0 outside the phases). */
export function accelerationAt(p: MotionProfile, t: number): number {
  if (p.phases.length === 0 || t >= p.tEnd || t < p.t0) return 0;
  return p.phases[phaseIndexAtTime(p, t)].a;
}

/** Sim time at which route position x is reached (Infinity if never). */
export function timeAt(p: MotionProfile, x: number): number {
  if (x <= p.x0 + EPS_X) return p.t0;
  if (x > p.xStop + 1e-7) return p.vEnd > 0 ? p.tEnd + (x - p.xStop) / p.vEnd : Infinity;
  if (x >= p.xStop) return p.tEnd;
  const ph = p.phases;
  let lo = 0, hi = ph.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ph[mid].x0 <= x) lo = mid; else hi = mid - 1;
  }
  const q = ph[lo];
  const dx = x - q.x0;
  if (Math.abs(q.a) < 1e-12) return q.t0 + Math.min(dx / q.v0, q.dt);
  const disc = Math.max(0, q.v0 * q.v0 + 2 * q.a * dx);
  const tau = (Math.sqrt(disc) - q.v0) / q.a;
  return q.t0 + Math.min(Math.max(0, tau), q.dt);
}

/** A copy of `p` with every route coordinate shifted by `dx` (route re-anchoring). */
export function shiftProfile(p: MotionProfile, dx: number): MotionProfile {
  return {
    ...p, x0: p.x0 + dx, xStop: p.xStop + dx,
    phases: p.phases.map((ph) => ({ t0: ph.t0, x0: ph.x0 + dx, v0: ph.v0, a: ph.a, dt: ph.dt, x1: ph.x1 + dx })),
  };
}

/**
 * The profile as a v²-over-x limit function shifted by `shift` (for a
 * follower: shift = δ − G), restricted to route coords [xFrom, xTo] of THIS
 * profile. Used as the leader envelope of a follower.
 */
export function profileAsLimit(p: MotionProfile, shift: number, xFrom: number, xTo: number): LimitPiece[] {
  const out: LimitPiece[] = [];
  for (const ph of p.phases) {
    const a0 = Math.max(ph.x0, xFrom), a1 = Math.min(ph.x1, xTo);
    if (a1 - a0 <= EPS_X) continue;
    const c0 = Math.max(0, ph.v0 * ph.v0 + 2 * ph.a * (a0 - ph.x0));
    out.push({ x0: a0 + shift, x1: a1 + shift, c0, c1: 2 * ph.a });
  }
  return out;
}

/** Phase index holding time t (−1 = before the first phase, n = after the end). */
function phaseCursor(p: MotionProfile, t: number): number {
  const n = p.phases.length;
  if (n === 0 || t >= p.tEnd) return n;
  if (t < p.t0) return -1;
  return phaseIndexAtTime(p, t);
}

/** Start time of the segment AFTER cursor `i` (Infinity after the end). */
function nextBoundary(p: MotionProfile, i: number): number {
  const n = p.phases.length;
  if (i >= n) return Infinity;
  if (i < 0) return n > 0 ? p.t0 : Infinity;
  return i + 1 < n ? p.phases[i + 1].t0 : p.tEnd;
}

// Kinematic state scratch of one profile at a time (position, speed, accel).
let _kx = 0, _kv = 0, _ka = 0;

/** State of profile `p` at time t inside cursor segment `i` → _kx/_kv/_ka. */
function stateAt(p: MotionProfile, i: number, t: number): void {
  const n = p.phases.length;
  if (i >= n) { _kx = p.vEnd > 0 ? p.xStop + p.vEnd * (t - p.tEnd) : p.xStop; _kv = p.vEnd; _ka = 0; return; }
  if (i < 0) { _kx = p.x0; _kv = 0; _ka = 0; return; } // undefined before t0: frozen at x0
  const ph = p.phases[i];
  const tau = Math.min(Math.max(0, t - ph.t0), ph.dt);
  _kx = ph.x0 + ph.v0 * tau + 0.5 * ph.a * tau * tau;
  _kv = Math.max(0, ph.v0 + ph.a * tau);
  _ka = ph.a;
}

/**
 * Minimum over t ≥ tFrom of (lead(t) + shift) − follow(t), restricted to the
 * time domain in which the leader is still at or before `leadMaxX` (its own
 * route coordinate — e.g. the point where it has branched clear of the
 * follower's route). The domain is CUT at `timeAt(lead, leadMaxX)` and that
 * boundary is evaluated itself (plan-558 R2-1: a check that merely skipped
 * samples beyond the branch missed a gap that closes right before it). Exact
 * on the piecewise-quadratic difference: one merge walk over both phase
 * lists evaluates every breakpoint, every interval vertex and the cut — no
 * sampling, no allocation. Returns Infinity for an empty domain and −Infinity
 * when the follower keeps a higher end speed than the leader on an unbounded
 * domain.
 */
export function minSeparation(
  follow: MotionProfile, lead: MotionProfile, shift: number, tFrom: number, leadMaxX = Infinity,
): number {
  let tCut = Infinity;
  if (leadMaxX < Infinity) {
    if (positionAt(lead, tFrom) > leadMaxX + 1e-12) return Infinity;
    tCut = timeAt(lead, leadMaxX);
  }
  let iF = phaseCursor(follow, tFrom);
  let iL = phaseCursor(lead, tFrom);
  let t = tFrom;
  let min = Infinity;
  for (let guard = 0; guard < 100000; guard++) {
    const t2 = Math.min(nextBoundary(follow, iF), nextBoundary(lead, iL), tCut);
    stateAt(lead, iL, t);
    const xL = _kx, vL = _kv, aL = _ka;
    stateAt(follow, iF, t);
    const d0 = xL + shift - _kx;
    if (d0 < min) min = d0;
    if (t2 === Infinity) {
      // Both at their end speeds from here on (uncut domain).
      if (_kv > vL + 1e-12) return -Infinity;
      return min;
    }
    const dt = t2 - t;
    if (dt > 1e-12) {
      // d(τ) = d0 + (vL − vF)·τ + ½(aL − aF)·τ² on [0, dt]: endpoint + vertex.
      const dv = vL - _kv, da = aL - _ka;
      const d1 = d0 + dv * dt + 0.5 * da * dt * dt;
      if (d1 < min) min = d1;
      if (Math.abs(da) > 1e-12) {
        const tv = -dv / da;
        if (tv > 0 && tv < dt) {
          const dvx = d0 + dv * tv + 0.5 * da * tv * tv;
          if (dvx < min) min = dvx;
        }
      }
    }
    if (t2 >= tCut) {
      // Evaluate the cut itself with the exact state (phase clamps included).
      const dc = positionAt(lead, tCut) + shift - positionAt(follow, tCut);
      if (dc < min) min = dc;
      return min;
    }
    t = t2;
    if (nextBoundary(follow, iF) <= t + 1e-15) iF = iF < 0 ? 0 : iF + 1;
    if (nextBoundary(lead, iL) <= t + 1e-15) iL = iL < 0 ? 0 : iL + 1;
  }
  return min;
}

/**
 * Earliest t ≥ tFrom at which g(t) = (lead(t) + shift − follow(t)) − K(v_F(t))
 * crosses zero in direction `dir` (−1: falls below 0 — e.g. a scanner field
 * entry; +1: rises above 0 — a field exit), with
 * K(v) = useSpeed·(v·tr + v²/(2b)) + margin. g is piecewise QUADRATIC in t
 * (v_F is linear per phase), so every crossing is solved exactly in one merge
 * walk over both phase lists. Restricted to the leader domain (`leadMaxX`):
 * for an exit (+1) the leader leaving the domain counts as the crossing, for
 * an entry it ends the search. Infinity = never.
 */
export function earliestGapCrossing(
  follow: MotionProfile, lead: MotionProfile, shift: number, tFrom: number, leadMaxX: number,
  useSpeed: 0 | 1, tr: number, b: number, margin: number, dir: 1 | -1,
): number {
  const tCut = leadMaxX < Infinity ? timeAt(lead, leadMaxX) : Infinity;
  const gone = dir > 0 && tCut < Infinity ? Math.max(tCut, tFrom) : Infinity;
  if (tCut <= tFrom) return gone;
  let iF = phaseCursor(follow, tFrom);
  let iL = phaseCursor(lead, tFrom);
  let t = tFrom;
  for (let guard = 0; guard < 100000; guard++) {
    const nb = Math.min(nextBoundary(follow, iF), nextBoundary(lead, iL));
    const t2 = Math.min(nb, tCut);
    stateAt(lead, iL, t);
    const xL = _kx, vL = _kv, aL = _ka;
    stateAt(follow, iF, t);
    const xF = _kx, vF = _kv, aF = _ka;
    const c0 = xL + shift - xF - (useSpeed * (vF * tr + (vF * vF) / (2 * b)) + margin);
    if (t === tFrom && (dir < 0 ? c0 < -1e-9 : c0 > 1e-9)) return tFrom;
    const T = t2 === Infinity ? 1e6 : t2 - t;
    if (T > 1e-12) {
      const c1 = (vL - vF) - useSpeed * (tr * aF + (vF * aF) / b);
      const c2 = 0.5 * (aL - aF) - useSpeed * ((aF * aF) / (2 * b));
      const r = dir < 0 ? firstNegative(c2, c1, c0, T) : firstNegative(-c2, -c1, -c0, T);
      if (r >= 0) return t + r;
    }
    if (t2 >= tCut || t2 === Infinity) return gone;
    t = t2;
    if (nextBoundary(follow, iF) <= t + 1e-15) iF = iF < 0 ? 0 : iF + 1;
    if (nextBoundary(lead, iL) <= t + 1e-15) iL = iL < 0 ? 0 : iL + 1;
  }
  return gone;
}

/** Smallest τ in (0, T] with c2·τ² + c1·τ + c0 < 0 (−1 = none); c0 ≥ 0 expected. */
function firstNegative(c2: number, c1: number, c0: number, T: number): number {
  let best = -1;
  if (Math.abs(c2) < 1e-14) {
    if (c1 < -1e-14) {
      const r = -c0 / c1;
      if (r > 1e-12 && r <= T) best = r;
    }
  } else {
    const disc = c1 * c1 - 4 * c2 * c0;
    if (disc >= 0) {
      const sq = Math.sqrt(disc);
      let r1 = (-c1 - sq) / (2 * c2), r2 = (-c1 + sq) / (2 * c2);
      if (r1 > r2) { const tmp = r1; r1 = r2; r2 = tmp; }
      const after = (x: number): number => { const y = Math.min(T, x + 1e-9); return (c2 * y + c1) * y + c0; };
      if (r1 > 1e-12 && r1 <= T && after(r1) < 0) best = r1;
      else if (r2 > 1e-12 && r2 <= T && after(r2) < 0) best = r2;
    }
  }
  if (best < 0 && (c2 * T + c1) * T + c0 < -1e-9) best = T;
  return best;
}
