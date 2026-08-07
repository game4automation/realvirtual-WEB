// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-energy-chain-path.ts — closed-form geometry of an energy chain
 * (cable carrier / Schleppkette), plan-362.
 *
 * DELIBERATELY FREE OF THREE.JS. Everything in here works on plain numbers and
 * `Float32Array`s so the whole motion model and the auto-calibration can be
 * unit-tested without a viewer, a DOM or a GPU. `rv-energy-chain.ts` is the
 * only place that translates between this 2D chain plane and Three.js objects.
 *
 * ## The model
 *
 * An energy chain is fully determined by four scalars — it needs no solver:
 *
 *   `a`  anchor position on the drive axis   (fixed end)
 *   `m`  follower position on the drive axis (moving end)
 *   `R`  bend radius of the centerline
 *   `L`  total centerline length (constant)
 *
 * All four live in the CHAIN-LOCAL BIND FRAME (see 2.8 of the plan), never in
 * world space: `u` is the drive axis, `v` the transverse (height) axis.
 *
 * The centerline is `straight strand → half circle → straight strand`. With the
 * bend center at `c` the path closes exactly when
 *
 *   c = (L − πR + a + m) / 2      ⇒  dc/dm = ½   (the bend travels at HALF the
 *                                                  follower speed — the defining
 *                                                  property of a cable carrier)
 *   l1 = c − a   (fixed strand)
 *   l2 = c − m   (moving strand)
 *
 * and `l1 + πR + l2 == L` identically. `l1 < 0` or `l2 < 0` means the chain is
 * overstretched — reported as a status, never as an exception or a NaN.
 *
 * Canonical orientation: the bend always bulges toward **+u**, the fixed strand
 * runs at `v = vc − R·vSign`, the moving strand at `v = vc + R·vSign`. A real
 * chain that turns the other way is handled by choosing the bind-frame `u` axis
 * direction during calibration, not by a second set of formulas.
 */

// ─── Configuration ───────────────────────────────────────────────

/** The four scalars (plus frame offsets) that define one chain pose. */
export interface ChainPathConfig {
  /** Anchor (fixed end) position along the drive axis, bind-frame units. */
  a: number;
  /** Follower (moving end) position along the drive axis, bind-frame units. */
  m: number;
  /** Centerline bend radius. */
  R: number;
  /** Total centerline length — constant over the whole stroke. */
  L: number;
  /** Transverse coordinate of the bend center. Default 0. */
  vc?: number;
  /** `+1` moving strand above the fixed one, `-1` mirrored. Default `+1`. */
  vSign?: 1 | -1;
}

/** A point (or tangent) in the 2D chain plane. */
export interface ChainPoint {
  u: number;
  v: number;
}

export type ChainStatus = 'ok' | 'overstretched';

const TWO_PI_HALF = Math.PI;

// ─── Core formula ────────────────────────────────────────────────

/**
 * Position of the bend center along the drive axis.
 *
 * Pure arithmetic — cannot produce NaN for finite inputs, which is why an
 * overstretched chain is detected via {@link strandLengths} instead of by
 * checking the result of this function.
 */
export function solveBend(cfg: ChainPathConfig): number {
  return (cfg.L - TWO_PI_HALF * cfg.R + cfg.a + cfg.m) / 2;
}

/** Lengths of the fixed (`l1`) and moving (`l2`) strand. Either may go negative. */
export function strandLengths(cfg: ChainPathConfig): { l1: number; l2: number; c: number } {
  const c = solveBend(cfg);
  return { l1: c - cfg.a, l2: c - cfg.m, c };
}

/** `'overstretched'` when either strand would need a negative length. */
export function chainStatus(cfg: ChainPathConfig): ChainStatus {
  const { l1, l2 } = strandLengths(cfg);
  return l1 < 0 || l2 < 0 ? 'overstretched' : 'ok';
}

/**
 * Geometric length of the constructed centerline: `|fixed strand| + πR +
 * |moving strand|`, measured from the solved bend position rather than
 * returning `L` verbatim. Equals `L` exactly when {@link solveBend} is correct,
 * which is what makes it a meaningful invariant to assert in tests.
 */
export function arcLengthTotal(cfg: ChainPathConfig): number {
  const { l1, l2 } = strandLengths(cfg);
  return l1 + TWO_PI_HALF * cfg.R + l2;
}

/**
 * Range of follower positions the chain can reach without overstretching.
 *
 * From `l1 ≥ 0` and `l2 ≥ 0`:
 *   `m ∈ [ a − (L − πR),  a + (L − πR) ]`
 *
 * SYMMETRIC on purpose — the travel direction is not known in advance (a chain
 * may just as well run toward negative `u`), so a one-sided bound would be
 * plainly wrong for half of all installations. Independent of any drive limit,
 * which is what makes it usable in drive-free operation.
 */
export function followerRange(cfg: Pick<ChainPathConfig, 'a' | 'R' | 'L'>): { min: number; max: number } {
  const reach = cfg.L - TWO_PI_HALF * cfg.R;
  return { min: cfg.a - reach, max: cfg.a + reach };
}

/**
 * Point on the centerline at arc length `s ∈ [0, L]`, measured from the anchor.
 * `s` is clamped. Pass `out` to stay allocation-free in the per-frame path.
 */
export function pointAt(cfg: ChainPathConfig, s: number, out?: ChainPoint): ChainPoint {
  const res = out ?? { u: 0, v: 0 };
  const R = cfg.R;
  const vc = cfg.vc ?? 0;
  const vSign = cfg.vSign ?? 1;
  const { l1, c } = strandLengths(cfg);
  const arc = TWO_PI_HALF * R;
  const t = s < 0 ? 0 : (s > cfg.L ? cfg.L : s);

  if (t <= l1) {
    res.u = cfg.a + t;
    res.v = vc - R * vSign;
  } else if (t <= l1 + arc) {
    const theta = (t - l1) / R;
    res.u = c + R * Math.sin(theta);
    res.v = vc - R * Math.cos(theta) * vSign;
  } else {
    res.u = c - (t - l1 - arc);
    res.v = vc + R * vSign;
  }
  return res;
}

/**
 * Unit tangent of the centerline at arc length `s`, in the direction of
 * increasing `s` (anchor → follower). Closed form, no differentiation.
 */
export function tangentAt(cfg: ChainPathConfig, s: number, out?: ChainPoint): ChainPoint {
  const res = out ?? { u: 0, v: 0 };
  const R = cfg.R;
  const vSign = cfg.vSign ?? 1;
  const { l1 } = strandLengths(cfg);
  const arc = TWO_PI_HALF * R;
  const t = s < 0 ? 0 : (s > cfg.L ? cfg.L : s);

  if (t <= l1) {
    res.u = 1;
    res.v = 0;
  } else if (t <= l1 + arc) {
    const theta = (t - l1) / R;
    res.u = Math.cos(theta);
    res.v = Math.sin(theta) * vSign;
  } else {
    res.u = -1;
    res.v = 0;
  }
  return res;
}

/**
 * Arc length of the point on the centerline closest to `(u, v)` — the inverse
 * of {@link pointAt}, used once per vertex when the rig is built (never per
 * frame). Evaluates all three segments in closed form and returns the nearest.
 *
 * Also returns the signed transverse offset of `(u, v)` from that point, which
 * is what carries a chain's cross-section (link height, side plates) through
 * the deformation unchanged.
 */
export function projectToPath(
  cfg: ChainPathConfig,
  u: number,
  v: number,
): { s: number; distance: number } {
  const R = cfg.R;
  const vc = cfg.vc ?? 0;
  const vSign = cfg.vSign ?? 1;
  const { l1, l2, c } = strandLengths(cfg);
  const arc = TWO_PI_HALF * R;

  let bestS = 0;
  let bestD2 = Infinity;

  // Fixed strand: from (a, vc − R·vSign) to (c, vc − R·vSign)
  if (l1 > 0) {
    const t = clamp(u - cfg.a, 0, l1);
    const du = u - (cfg.a + t);
    const dv = v - (vc - R * vSign);
    const d2 = du * du + dv * dv;
    if (d2 < bestD2) { bestD2 = d2; bestS = t; }
  }

  // Half circle: center (c, vc), θ ∈ [0, π], point = (c + R sinθ, vc − R cosθ·vSign)
  {
    const dx = u - c;
    const dy = (v - vc) * vSign;
    // point − center = (R sinθ, −R cosθ)  ⇒  θ = atan2(dx, −dy)
    let theta = Math.atan2(dx, -dy);
    theta = clamp(theta, 0, TWO_PI_HALF);
    const pu = c + R * Math.sin(theta);
    const pv = vc - R * Math.cos(theta) * vSign;
    const du = u - pu;
    const dv = v - pv;
    const d2 = du * du + dv * dv;
    if (d2 < bestD2) { bestD2 = d2; bestS = l1 + R * theta; }
  }

  // Moving strand: from (c, vc + R·vSign) back to (m, vc + R·vSign)
  if (l2 > 0) {
    const t = clamp(c - u, 0, l2);
    const du = u - (c - t);
    const dv = v - (vc + R * vSign);
    const d2 = du * du + dv * dv;
    if (d2 < bestD2) { bestD2 = d2; bestS = l1 + arc + t; }
  }

  return { s: clamp(bestS, 0, cfg.L), distance: Math.sqrt(bestD2) };
}

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : (x > hi ? hi : x);
}

// ─── Bone distribution ───────────────────────────────────────────

/** Largest relative rotation two neighbouring bones may have (degrees). */
export const MAX_BONE_DELTA_DEG = 15;

/**
 * Minimum number of bones a chain rig needs, DERIVED rather than guessed.
 *
 * Linear blend skinning degenerates (the "candy wrapper" collapse) once two
 * neighbouring bones differ by something approaching 180° — and the two strands
 * of an energy chain are exactly antiparallel. Capping the relative angle at
 * `MAX_BONE_DELTA_DEG` gives:
 *
 * | section        | bones                    |
 * |----------------|--------------------------|
 * | bend (180°)    | ⌈180/15⌉ + 1 = 13        |
 * | fixed strand   | 3                        |
 * | moving strand  | 3                        |
 * | transitions    | 2                        |
 * | **total**      | **21**                   |
 *
 * The schema cannot enforce this — `FieldDescriptor` carries no min/max — so the
 * component clamps to this value and says so in its status line.
 */
export function minimumBoneCount(maxDeltaDeg: number = MAX_BONE_DELTA_DEG): number {
  const bendBones = Math.ceil(180 / Math.max(1, maxDeltaDeg)) + 1;
  return bendBones + 3 + 3 + 2;
}

/**
 * Arc-length sample positions for the bone joints, concentrated on the bend.
 *
 * A uniform distribution would spend most bones on the straight strands (where
 * nothing rotates) and too few on the half circle (where everything does). The
 * split follows the same budget as {@link minimumBoneCount}: a fixed share of
 * the bones covers the two strands, everything else is spread evenly over the
 * bend in ARC LENGTH, which makes the angular step uniform there.
 *
 * Returns `count` strictly increasing values in `[0, L]`, starting at 0 and
 * ending at `L`.
 */
export function boneArcLengths(cfg: ChainPathConfig, count: number): Float64Array {
  const n = Math.max(2, Math.floor(count));
  const out = new Float64Array(n);
  const { l1, l2 } = strandLengths(cfg);
  const arc = TWO_PI_HALF * cfg.R;
  const L = cfg.L;

  // Guard: a degenerate/overstretched pose still has to yield a monotone ramp.
  if (!(L > 0) || !(arc > 0) || l1 < 0 || l2 < 0) {
    for (let i = 0; i < n; i++) out[i] = (L * i) / (n - 1);
    return out;
  }

  // Bone budget. Reserve the strand bones first (they only need endpoints plus
  // one interior sample each), give the remainder to the bend.
  const strandBones = 3;
  const perStrand = l1 > 0 ? strandBones : 1;
  const perStrand2 = l2 > 0 ? strandBones : 1;
  let bendBones = n - perStrand - perStrand2;
  if (bendBones < 2) bendBones = 2;

  const samples: number[] = [];
  // Fixed strand: 0 … l1 (exclusive of l1, the bend start owns it)
  for (let i = 0; i < perStrand; i++) samples.push((l1 * i) / perStrand);
  // Bend: l1 … l1+arc inclusive on both ends
  for (let i = 0; i < bendBones; i++) samples.push(l1 + (arc * i) / (bendBones - 1));
  // Moving strand: after the bend up to L, excluding the bend end
  for (let i = 1; i <= perStrand2; i++) samples.push(l1 + arc + (l2 * i) / perStrand2);

  // The three sections together may over/undershoot `n` by one or two entries
  // (integer division). Resample onto exactly `n` monotone values.
  samples.sort((x, y) => x - y);
  samples[0] = 0;
  samples[samples.length - 1] = L;
  if (samples.length === n) {
    for (let i = 0; i < n; i++) out[i] = samples[i];
    return out;
  }
  for (let i = 0; i < n; i++) {
    const f = (i * (samples.length - 1)) / (n - 1);
    const lo = Math.floor(f);
    const hi = Math.min(samples.length - 1, lo + 1);
    out[i] = samples[lo] + (samples[hi] - samples[lo]) * (f - lo);
  }
  out[0] = 0;
  out[n - 1] = L;
  return out;
}

// ─── Auto-calibration ────────────────────────────────────────────

export type CalibrationStatus = 'ok' | 'degraded-calibration';

/** Everything the calibration needs: one merged bind-frame point cloud. */
export interface CalibrationInput {
  /**
   * Concatenated `x, y, z` triples of EVERY source mesh vertex, already
   * transformed into the chain-local bind frame. Multi-mesh chains (the
   * reference case has the strands in one mesh and the bend in another) merge
   * into this one array — after the bind-frame transform the meshes are simply
   * different parts of the same cloud.
   */
  points: Float32Array;
  /** Scale factor from bind-frame units to millimetres. Default 1000 (metres). */
  unitsToMm?: number;
  /** Force the drive axis instead of measuring it. */
  axis?: 'Auto' | 'X' | 'Y' | 'Z';
}

export interface CalibrationResult {
  status: CalibrationStatus;
  /** Human-readable reason when `status !== 'ok'` — feeds the status line. */
  reason?: string;
  /** Measured (or forced) drive axis. */
  axis: 'X' | 'Y' | 'Z';
  /** Index of the drive axis in the bind frame (0/1/2). */
  axisIndex: number;
  /** Index of the transverse (height) axis in the bind frame. */
  upIndex: number;
  /** `+1` when the bend sits at the larger `u`, `-1` when at the smaller. */
  bendDir: 1 | -1;
  /** `+1` when the moving strand runs at the larger `v`. */
  vSign: 1 | -1;
  bendRadiusMm: number;
  linkHeightMm: number;
  chainLengthMm: number;
  /** Bend center along the drive axis in the rest pose, bind-frame units. */
  bendCenter: number;
  /** Transverse coordinate of the bend center, bind-frame units. */
  bendCenterV: number;
  /** Drive-axis coordinate of the low-`v` strand's open end, bind-frame units. */
  lowEnd: number;
  /** Drive-axis coordinate of the high-`v` strand's open end, bind-frame units. */
  highEnd: number;
}

const AXIS_NAMES: ReadonlyArray<'X' | 'Y' | 'Z'> = ['X', 'Y', 'Z'];
/** Below this ratio between the two longest AABB extents the axis is ambiguous. */
const AXIS_RATIO_MIN = 1.5;

/**
 * Measure bend radius, link height, chain length and drive axis from the CAD
 * rest pose. Never throws and never guesses: an input the heuristic cannot read
 * comes back as `degraded-calibration` with a reason, and the caller leaves the
 * chain in its rest pose (F5).
 *
 * Deliberately GEOMETRIC, never name-based: the reference chain's children are
 * called `28`/`29`/`30`/`31` (CAD import order), and kinematic re-parenting
 * rewrites paths after the fact. Child names and indices are not evidence.
 */
export function calibrate(input: CalibrationInput): CalibrationResult {
  const pts = input.points;
  const toMm = input.unitsToMm ?? 1000;
  const n = Math.floor(pts.length / 3);

  const fail = (reason: string, partial?: Partial<CalibrationResult>): CalibrationResult => ({
    status: 'degraded-calibration',
    reason,
    axis: 'Z', axisIndex: 2, upIndex: 1, bendDir: 1, vSign: 1,
    bendRadiusMm: 0, linkHeightMm: 0, chainLengthMm: 0,
    bendCenter: 0, bendCenterV: 0, lowEnd: 0, highEnd: 0,
    ...partial,
  });

  if (n < 8) return fail('too few vertices to measure a chain');

  // ── 1. AABB + drive axis ────────────────────────────────────────
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < 3; k++) {
      const val = pts[i * 3 + k];
      if (val < min[k]) min[k] = val;
      if (val > max[k]) max[k] = val;
    }
  }
  const extent = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  const order = [0, 1, 2].sort((x, y) => extent[y] - extent[x]);

  let axisIndex: number;
  if (input.axis && input.axis !== 'Auto') {
    axisIndex = AXIS_NAMES.indexOf(input.axis);
  } else {
    if (extent[order[1]] <= 0 || extent[order[0]] / extent[order[1]] < AXIS_RATIO_MIN) {
      return fail(
        `drive axis ambiguous (extents ${extent.map(e => (e * toMm).toFixed(0)).join('/')} mm)`,
      );
    }
    axisIndex = order[0];
  }

  // Transverse axis = the longer of the two remaining: a chain is 2R + h tall
  // and only as wide as its link plates.
  const rest = [0, 1, 2].filter(k => k !== axisIndex);
  const upIndex = extent[rest[0]] >= extent[rest[1]] ? rest[0] : rest[1];

  // ── 2. Cross-section slice → two strand clusters ────────────────
  const uMin = min[axisIndex];
  const uMax = max[axisIndex];
  const uSpan = uMax - uMin;
  if (!(uSpan > 0)) return fail('degenerate extent along the drive axis');

  const vExtent = extent[upIndex];
  // Gap threshold between the two strands. The strands are 2R apart and h tall,
  // so the inner gap is 2R − h; 15 % of the total height separates them
  // reliably while surviving ±0.2 mm vertex noise.
  const gapThreshold = vExtent * 0.15;

  // Try slices at increasing inset from BOTH ends. The open end has two
  // clusters, the bend end has one continuous band — that asymmetry is what
  // identifies which end carries the bend.
  const insets = [0.02, 0.05, 0.10, 0.16, 0.24];
  const sliceWidth = uSpan * 0.03;
  const vBuf: number[] = [];

  let openAtMin = false;
  let clusters: Cluster[] | null = null;
  outer:
  for (const inset of insets) {
    for (const fromMin of [true, false]) {
      const base = fromMin ? uMin + uSpan * inset : uMax - uSpan * inset - sliceWidth;
      const lo = base;
      const hi = base + sliceWidth;
      vBuf.length = 0;
      for (let i = 0; i < n; i++) {
        const u = pts[i * 3 + axisIndex];
        if (u < lo || u > hi) continue;
        vBuf.push(pts[i * 3 + upIndex]);
      }
      if (vBuf.length < 8) continue;
      const found = clusterSorted(vBuf, gapThreshold);
      if (found.length === 2) {
        clusters = found;
        openAtMin = fromMin;
        break outer;
      }
    }
  }

  if (!clusters) {
    return fail('cross-section shows no two strands (bend-only slice or noisy geometry)');
  }

  const [low, high] = clusters;
  const rMm = ((high.center - low.center) / 2) * toMm;
  const linkMm = ((low.width + high.width) / 2) * toMm;
  if (!(rMm > 0) || !(linkMm > 0)) return fail('measured bend radius or link height is not positive');

  // Closure probe: a chain is exactly `2R + h` tall. This is the one check that
  // separates two REAL strands from two accidental bands — a slice through a
  // curved surface (e.g. a subtree holding only the bend) can easily split into
  // two clusters, and those numbers then look plausible in isolation but do not
  // add up to the height of the part. 10 % covers vertex noise and a slightly
  // chamfered outer link plate; anything beyond that is not a chain profile.
  const heightMm = vExtent * toMm;
  if (Math.abs(2 * rMm + linkMm - heightMm) > heightMm * 0.1) {
    return fail(
      `cross-section does not close: 2R + h = ${(2 * rMm + linkMm).toFixed(1)} mm `
      + `but the part is ${heightMm.toFixed(1)} mm tall`,
    );
  }

  // ── 3. Bend location ────────────────────────────────────────────
  // The bend sits at the end OPPOSITE the two-cluster slice.
  const bendDir: 1 | -1 = openAtMin ? 1 : -1;
  const rUnits = rMm / toMm;
  const hUnits = linkMm / toMm;
  const outerEdge = bendDir === 1 ? uMax : uMin;
  const bendCenter = outerEdge - bendDir * (rUnits + hUnits / 2);
  const bendCenterV = (low.center + high.center) / 2;

  // ── 4. Strand ends and total length ─────────────────────────────
  // Split the whole cloud by transverse coordinate and take each strand's own
  // extreme at the open end — the rest pose need not be symmetric.
  const vMid = bendCenterV;
  let lowEnd = bendDir === 1 ? Infinity : -Infinity;
  let highEnd = lowEnd;
  const strandBand = rUnits * 0.6;
  for (let i = 0; i < n; i++) {
    const u = pts[i * 3 + axisIndex];
    const v = pts[i * 3 + upIndex];
    if (v < vMid - strandBand) {
      lowEnd = bendDir === 1 ? Math.min(lowEnd, u) : Math.max(lowEnd, u);
    } else if (v > vMid + strandBand) {
      highEnd = bendDir === 1 ? Math.min(highEnd, u) : Math.max(highEnd, u);
    }
  }
  if (!Number.isFinite(lowEnd) || !Number.isFinite(highEnd)) {
    return fail('could not locate both strand ends');
  }

  const l1 = Math.abs(bendCenter - lowEnd);
  const l2 = Math.abs(bendCenter - highEnd);
  const chainLengthMm = (l1 + l2) * toMm + Math.PI * rMm;

  // `vSign` describes which strand is "up" in the canonical formula. The
  // component decides which physical strand is anchor vs. follower (2.5); the
  // calibration only reports the geometry it can see.
  return {
    status: 'ok',
    axis: AXIS_NAMES[axisIndex],
    axisIndex,
    upIndex,
    bendDir,
    vSign: 1,
    bendRadiusMm: rMm,
    linkHeightMm: linkMm,
    chainLengthMm,
    bendCenter,
    bendCenterV,
    lowEnd,
    highEnd,
  };
}

interface Cluster {
  center: number;
  width: number;
  count: number;
}

/**
 * 1D gap clustering: sort the values and cut wherever the gap to the next
 * value exceeds `gap`. Clusters holding less than 5 % of the samples are
 * dropped as noise (stray anchor brackets, mounting plates) — without that a
 * single outlier vertex would masquerade as a third strand.
 */
function clusterSorted(values: number[], gap: number): Cluster[] {
  const sorted = values.slice().sort((a, b) => a - b);
  const out: Cluster[] = [];
  let start = 0;
  for (let i = 1; i <= sorted.length; i++) {
    if (i === sorted.length || sorted[i] - sorted[i - 1] > gap) {
      const lo = sorted[start];
      const hi = sorted[i - 1];
      out.push({ center: (lo + hi) / 2, width: hi - lo, count: i - start });
      start = i;
    }
  }
  const minCount = Math.max(2, Math.floor(sorted.length * 0.05));
  return out.filter(c => c.count >= minCount);
}
