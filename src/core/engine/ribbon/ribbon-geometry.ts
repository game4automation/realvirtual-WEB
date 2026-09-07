// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * ribbon-geometry.ts — the taut-web path over a chain of parallel rollers
 * (plan-459, Phase 1).
 *
 * PORTABLE BY CONTRACT: this module imports NOTHING — no `three`, no engine
 * module. It works on plain `{x, y}` tuples and numbers so the later Unity/C#
 * port is a mechanical transcription rather than a re-derivation. The guard is
 * a grep: `rg -n "from 'three'" src/core/engine/ribbon/` must stay empty.
 *
 * ## Units
 *
 * **Millimetres throughout** (plan-459 unit contract). Angles are radians
 * internally. The ONE conversion to glTF metres happens in
 * `RVRibbonBandMesh.write()` — never here.
 *
 * ## The open path contract (plan §2.3)
 *
 * A `RibbonPath` is an OPEN run from roller `0` to roller `n-1`, both usually
 * winders. Every roller is a circle in the plane perpendicular to the common
 * axis, plus a side:
 *
 *   `side = +1` (Left)  → the web wraps the roller COUNTER-CLOCKWISE
 *   `side = -1` (Right) → the web wraps the roller CLOCKWISE
 *
 * ### Why the tangent branch is never ambiguous here
 *
 * Textbook two-circle tangent code picks between two "external" and two
 * "crossed" solutions with a sign heuristic. That choice does not exist once
 * both sides are given, and the derivation is worth writing down because it is
 * what the Unity port must reproduce:
 *
 * At a contact point the web travels along the roller surface. For a CCW wrap
 * the travel direction `t` and the outward contact normal `n` satisfy
 * `t = rot90ccw(n)`, i.e. `n = rot90cw(t)`; for a CW wrap `n = rot90ccw(t)`.
 * Both collapse into `n = side * rot90cw(t)` with `rot90cw((x,y)) = (y,-x)`.
 *
 * With `P_a = c_a + r_a·n_a` and `P_b = c_b + r_b·n_b`, both normals derived
 * from the SAME `t`, writing `L·t = D + k·rot90cw(t)` with `D = c_b - c_a` and
 * `k = side_b·r_b − side_a·r_a`, and dotting with `rot90cw(t)` (orthogonal to
 * `t`), gives
 *
 *   `D · rot90cw(t) = −k`   ⟺   `d · sin(θ − φ) = −k`
 *
 * where `θ = atan2(t)`, `φ = atan2(D)`, `d = |D|`. The tangent LENGTH is
 * `L = D·t = d·cos(θ − φ)`, so the physically meaningful solution is the one
 * with `cos(θ−φ) > 0` — exactly the principal `asin` branch. There is no second
 * candidate to choose between, and `L = sqrt(d² − k²)`.
 *
 * Degeneracies fall straight out of `|k| ≥ d`:
 *   - same side, `|r_a − r_b| ≥ d` → one roller swallows the other;
 *   - opposite sides, `r_a + r_b ≥ d` → the crossed tangent needs the circles
 *     to be disjoint;
 *   - `d < EPS_MM` → coincident centres.
 * Each returns `null` (or an `error` string from {@link buildRibbonSegments}) and
 * the owning `RibbonPath` goes inert with a warning — never a NaN in the scene.
 */

/** Two-dimensional point / direction, in millimetres (points) or unitless (dirs). */
export interface Vec2 {
  x: number;
  y: number;
}

/** A roller reduced to its circle in the plane perpendicular to the web axis. */
export interface Circle2 {
  /** mm — centre in the path's 2D frame. */
  cx: number;
  /** mm — centre in the path's 2D frame. */
  cy: number;
  /** mm — contact radius (roller radius, plus half the web thickness). */
  r: number;
  /** `+1` = Left (web wraps counter-clockwise), `-1` = Right (clockwise),
   *  `0` = Auto: resolved by {@link resolveAutoSides} from the roller's position
   *  relative to its neighbours (the wrap under 180 deg, the only one a real web can take). */
  side: 1 | -1 | 0;
}

/** A straight run between two contact points. */
export interface LineSegment2 {
  kind: 'line';
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** mm */
  lengthMm: number;
}

/** A wrap arc on one roller. */
export interface ArcSegment2 {
  kind: 'arc';
  cx: number;
  cy: number;
  r: number;
  /** rad — angle of the INCOMING contact point, measured from +x. */
  a0: number;
  /** rad — SIGNED sweep: positive = counter-clockwise (`side = +1`). */
  sweep: number;
  /** mm */
  lengthMm: number;
}

export type RibbonSegment2 = LineSegment2 | ArcSegment2;

/** Successful path build. */
export interface RibbonPathGeometry {
  segments: RibbonSegment2[];
  /** mm — total arc length of the open path. */
  lengthMm: number;
}

/** Failed path build — the reason is surfaced verbatim in the component warning. */
export interface RibbonPathError {
  error: string;
}

/** Floats per sample written by {@link sampleArcLength}: `[px, py, tx, ty]`. */
export const RIBBON_SAMPLE_STRIDE = 4;

/** mm — below this a distance counts as zero (coincident centres, empty path). */
const EPS_MM = 1e-6;

const TWO_PI = Math.PI * 2;

// Scratch reused by tangentBetween — this runs on the rebuild path, not per
// frame, but staying allocation-free costs nothing here.
const _n: Vec2 = { x: 0, y: 0 };

/** Rotate a direction by −90° (clockwise): `(x, y) → (y, −x)`. */
function rot90cw(x: number, y: number, out: Vec2): Vec2 {
  out.x = y;
  out.y = -x;
  return out;
}

/**
 * The single tangent segment that runs from circle `a` to circle `b` while
 * respecting both `side` values (see the file header for the derivation).
 *
 * Returns the two contact points, or `null` when no tangent of positive length
 * exists.
 */
export function tangentBetween(a: Circle2, b: Circle2): { p0: Vec2; p1: Vec2 } | null {
  const dx = b.cx - a.cx;
  const dy = b.cy - a.cy;
  const d = Math.hypot(dx, dy);
  if (!(d > EPS_MM)) return null;

  const k = b.side * b.r - a.side * a.r;
  const s = -k / d;
  if (!(Math.abs(s) < 1)) return null; // |k| >= d — no tangent of positive length

  const theta = Math.atan2(dy, dx) + Math.asin(s);
  rot90cw(Math.cos(theta), Math.sin(theta), _n);

  return {
    p0: { x: a.cx + a.r * a.side * _n.x, y: a.cy + a.r * a.side * _n.y },
    p1: { x: b.cx + b.r * b.side * _n.x, y: b.cy + b.r * b.side * _n.y },
  };
}

/** rad — the (unsigned) wrap angle of an arc segment. */
export function wrapAngle(seg: ArcSegment2): number {
  return Math.abs(seg.sweep);
}

/**
 * Build the OPEN path `line, arc, line, arc, …, line` over `rollers`
 * (in running order).
 *
 * The first and last roller carry NO arc: the path starts at the contact point
 * of the first tangent and ends at the contact point of the last one — that is
 * what "open" means (a winder pays the web out at a tangent point and takes it
 * up at one; it does not wrap all the way round).
 *
 * Every intermediate roller contributes exactly one arc, swept in the direction
 * its `side` prescribes and normalised into `[0, 2π)`. A wrap of `0` (three
 * collinear equal rollers) is legal and costs one zero-length segment.
 */
export function buildRibbonSegments(rollers: readonly Circle2[]): RibbonPathGeometry | RibbonPathError {
  if (rollers.length < 2) {
    return { error: `a web path needs at least two rollers, got ${rollers.length}` };
  }
  resolveAutoSides(rollers);
  for (let i = 0; i < rollers.length; i++) {
    const c = rollers[i];
    if (!Number.isFinite(c.cx) || !Number.isFinite(c.cy) || !(c.r > 0)) {
      return { error: `roller ${i} has a non-positive or non-finite radius (${c.r} mm)` };
    }
  }

  // Pass 1: every tangent. Collected first so a single failure aborts before
  // any segment is built — an inert path must never be half-built.
  const tangents: Array<{ p0: Vec2; p1: Vec2 }> = [];
  for (let i = 0; i < rollers.length - 1; i++) {
    const t = tangentBetween(rollers[i], rollers[i + 1]);
    if (!t) return { error: tangentFailure(rollers[i], rollers[i + 1], i) };
    tangents.push(t);
  }

  const segments: RibbonSegment2[] = [];
  let lengthMm = 0;

  for (let i = 0; i < tangents.length; i++) {
    // Arc on roller i, between the incoming tangent (i-1) and this one.
    if (i > 0) {
      const c = rollers[i];
      const inP = tangents[i - 1].p1;
      const outP = tangents[i].p0;
      const a0 = Math.atan2(inP.y - c.cy, inP.x - c.cx);
      const a1 = Math.atan2(outP.y - c.cy, outP.x - c.cx);
      // Normalise the sweep into [0, 2pi) in the direction the side prescribes.
      let sweep = c.side > 0 ? a1 - a0 : a0 - a1;
      sweep -= Math.floor(sweep / TWO_PI) * TWO_PI;
      const arcLen = c.r * sweep;
      segments.push({
        kind: 'arc',
        cx: c.cx,
        cy: c.cy,
        r: c.r,
        a0,
        sweep: c.side > 0 ? sweep : -sweep,
        lengthMm: arcLen,
      });
      lengthMm += arcLen;
    }

    const t = tangents[i];
    const len = Math.hypot(t.p1.x - t.p0.x, t.p1.y - t.p0.y);
    segments.push({ kind: 'line', x0: t.p0.x, y0: t.p0.y, x1: t.p1.x, y1: t.p1.y, lengthMm: len });
    lengthMm += len;
  }

  return { segments, lengthMm };
}

/**
 * Resolve every `side: 0` (Auto) in place. An inner roller is wrapped on the
 * face that looks at the chord between its neighbours' centres - the wrap under
 * 180 deg, the only one a real web can take (the far face would make the strands
 * cross). In this frame's sign convention a roller LEFT of the chord (running
 * direction prev -> next, positive cross product) wraps clockwise (`-1`) and a
 * roller right of it counter-clockwise (`+1`); the geometry test pins that down
 * on the demo S-layout. A roller ON the chord (no deflection) and the two end
 * rollers, which have no arc, default to Left.
 */
export function resolveAutoSides(rollers: readonly Circle2[]): void {
  const n = rollers.length;
  for (let i = 0; i < n; i++) {
    const c = rollers[i];
    if (c.side !== 0) continue;
    if (i === 0 || i === n - 1) { c.side = 1; continue; }
    const p = rollers[i - 1];
    const q = rollers[i + 1];
    const dx = q.cx - p.cx;
    const dy = q.cy - p.cy;
    const wx = c.cx - p.cx;
    const wy = c.cy - p.cy;
    const cross = dx * wy - dy * wx;
    c.side = cross > 0 ? -1 : 1;
  }
}

/** The human-readable reason a tangent could not be built (F5 warning text). */
function tangentFailure(a: Circle2, b: Circle2, i: number): string {
  const d = Math.hypot(b.cx - a.cx, b.cy - a.cy);
  let reason: string;
  if (d <= EPS_MM) {
    reason = 'their centres coincide';
  } else if (a.side === b.side) {
    reason = `|r1 - r2| (${Math.abs(a.r - b.r).toFixed(3)} mm) is not smaller than the centre distance (${d.toFixed(3)} mm)`;
  } else {
    reason = `r1 + r2 (${(a.r + b.r).toFixed(3)} mm) is not smaller than the centre distance (${d.toFixed(3)} mm)`;
  }
  return `no tangent between roller ${i} and ${i + 1}: ${reason}`;
}

/** Evaluate one segment at arc-length `s` (mm from its start) into `out`. */
function evalSegment(seg: RibbonSegment2, s: number, out: Float32Array, at: number): void {
  if (seg.kind === 'line') {
    const inv = seg.lengthMm > EPS_MM ? s / seg.lengthMm : 0;
    const dx = seg.x1 - seg.x0;
    const dy = seg.y1 - seg.y0;
    const n = Math.hypot(dx, dy) || 1;
    out[at] = seg.x0 + dx * inv;
    out[at + 1] = seg.y0 + dy * inv;
    out[at + 2] = dx / n;
    out[at + 3] = dy / n;
    return;
  }
  const dir = seg.sweep >= 0 ? 1 : -1;
  const a = seg.a0 + (seg.r > EPS_MM ? dir * (s / seg.r) : 0);
  const nx = Math.cos(a);
  const ny = Math.sin(a);
  out[at] = seg.cx + seg.r * nx;
  out[at + 1] = seg.cy + seg.r * ny;
  // Travel direction on a CCW arc is rot90ccw(n); on a CW arc rot90cw(n).
  out[at + 2] = dir > 0 ? -ny : ny;
  out[at + 3] = dir > 0 ? nx : -nx;
}

/** What {@link sampleArcLength} wrote: how many samples, and on which grid. */
export interface RibbonSampling {
  /** Number of samples written (not the float count); 0 when nothing was. */
  count: number;
  /**
   * mm — the step ACTUALLY used, which is `stepMm` unless the path did not fit
   * in `out` and the grid had to be coarsened. Every consumer that converts an
   * arc length to a sample index must use this and not the requested step.
   */
  stepMm: number;
}

/**
 * The sample count of an absolute `i * step` grid over `total`: one sample per
 * full step, plus the path end unless it already lands on the grid (a remainder
 * below EPS is the same point).
 */
function gridCount(total: number, step: number): number {
  const whole = Math.floor(total / step);
  return Math.max(2, whole + (total - whole * step > EPS_MM ? 2 : 1));
}

/**
 * Write samples `[px, py, tx, ty]` onto an ABSOLUTE arc-length grid — sample `i`
 * at exactly `i * step` — into `out`. The LAST sample always sits on the end of
 * the path, so its interval is SHORTER than a step (never longer). Returns the
 * count and the step actually used.
 *
 * ## Why the grid is absolute
 *
 * The obvious alternative — `spacing = total / (count - 1)`, which this function
 * used until the plan-460 follow-up — makes the sample positions depend on the
 * TOTAL length. Two slit strips share every roller up to the cutter but end at
 * different rewinders, so their totals differ, and the same physical point then
 * landed on grids offset by up to half a step (~10 mm at 48 samples/m). The
 * consequence was visible on the demo slitter: the strip drawing the shared
 * full-width web narrowed a sample BEFORE the cut while its sibling started a
 * sample after it, leaving a gap or an overlap at the blade.
 *
 * With an absolute grid, two paths with the same `SamplesPerMeter` sample the
 * shared part at identical arc lengths, so a shared point rounds to the same
 * index and the same 3D position for both — bit for bit, since the segments up
 * to that roller are computed from the same circles.
 *
 * The price is the last interval, which is `total mod step` long. It is bounded
 * by one step by construction, and the owner's texture mapping accounts for it
 * (see `RVRibbonBandMesh.setTextureLength`).
 *
 * ## When the path does not fit
 *
 * `out` is caller-owned and never reallocated (the capacity rule of plan §NFA).
 * The grid is then COARSENED by an integer factor until it fits, and the factor
 * is returned in {@link RibbonSampling.stepMm}.
 *
 * Truncating the count instead — what the first absolute-grid version did — is
 * silently wrong in a way the old length-derived spacing never was: the interior
 * samples keep the requested step and only the LAST one jumps to `total`, so
 * everything past `(capacity - 2) * step` collapses into one straight segment
 * and every slit / section boundary in that remainder clamps to the path end.
 * An INTEGER factor rather than `total / (capacity - 1)` keeps the coarser grid
 * a subset of the requested one, so a path that fits and a sibling that had to
 * coarsen still share every sample position the coarse grid has.
 */
export function sampleArcLength(
  segs: readonly RibbonSegment2[],
  stepMm: number,
  out: Float32Array,
): RibbonSampling {
  const capacity = Math.floor(out.length / RIBBON_SAMPLE_STRIDE);
  if (capacity < 2 || segs.length === 0) return { count: 0, stepMm: 0 };

  let total = 0;
  for (const s of segs) total += s.lengthMm;
  if (!(total > EPS_MM)) return { count: 0, stepMm: 0 };

  const base = stepMm > EPS_MM ? stepMm : total;
  let step = base;
  let count = gridCount(total, step);
  if (count > capacity) {
    // The estimate lands on `capacity` or one above it, so the loop runs at most
    // once or twice; it is a loop rather than a formula because `gridCount`'s
    // end-of-path sample makes the exact answer depend on the remainder.
    let k = Math.max(1, Math.ceil((total / base) / (capacity - 1)));
    step = base * k;
    while (gridCount(total, step) > capacity) { k++; step = base * k; }
    count = gridCount(total, step);
  }
  if (count > capacity) count = capacity;   // capacity 2, or a degenerate step

  let segIndex = 0;
  let segStart = 0;
  for (let i = 0; i < count; i++) {
    const s = i === count - 1 ? total : Math.min(i * step, total);
    while (segIndex < segs.length - 1 && s > segStart + segs[segIndex].lengthMm) {
      segStart += segs[segIndex].lengthMm;
      segIndex++;
    }
    evalSegment(segs[segIndex], s - segStart, out, i * RIBBON_SAMPLE_STRIDE);
  }
  return { count, stepMm: step };
}
