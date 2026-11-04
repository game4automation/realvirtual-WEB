// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-path-edit.ts — PURE geometry ops for planner-side path editing
 * (plan-447 Phase 3).
 *
 * Everything here works on the `rv_extras.Path` SEGMENT SPEC list
 * (`PathSegmentSpec[]`, the TS-SSOT lives in rv-path.ts) — plain JSON, no
 * Three.js scene, no `RVPath` instance. That is deliberate:
 *
 * - a drag commit is an ordinary `setField` op on the generic `'json'` field
 *   `segments` (undo/redo and save/load come for free — no new op kind, no
 *   schema change, see plan-447 §2.3);
 * - the maths is unit-testable headless (tests/path/path-edit-ops.test.ts);
 * - the interactive layer (path-visualizer-plugin.ts) only maps pointer rays to
 *   world points and calls into here.
 *
 * Handle model (plan-447 Entscheidungs-Log):
 * - **vertex** — a chain VERTEX between two consecutive segments, and the two
 *   free chain ends. Dragging it updates BOTH adjacent line segments in one
 *   coordinated write (`prev.to` and `next.from` stay identical, so the chain
 *   never tears).
 * - **arc-center** / **arc-radius** — arcs are edited through center and radius
 *   handles. `PathArcSpec` has no `from`/`to`, so a free arc-endpoint drag is
 *   mathematically underdetermined without a tangent constraint; that is an
 *   explicit NON-goal of plan-447 — and it STAYS one (plan-453 did not reverse
 *   it).
 * - **arc-sweep** (plan-453 F1) — a third arc handle, at the arc END. It changes
 *   ONLY `degrees`: the point runs on the circle (center, radius, start angle,
 *   plane and turning sense stay), so it is not the free endpoint drag above.
 *
 * Structural verbs (plan-453 §2.6) — the spec list changes LENGTH:
 * `setArcDegrees`, `appendSegment` (tangential, inheriting the neighbour's
 * dimensions), `removeEndSegment` (only at a chain end) and `splitSegment`
 * (geometry-neutral). The reads `projectToSegment`, `locateArcLength` and
 * `pickSegmentPoint` map a world point / pointer ray onto a segment. The lock
 * ("only in the reset state") and the undoable commit live in the plugin
 * (path-visualizer-plugin.ts); this file stays pure geometry.
 *
 * Every mutation returns a NEW spec list (structural copy) — the caller keeps
 * the pre-drag list as the `prev` value of the undoable op.
 */

import { Vector3 } from 'three';
import type { ArcPlane, PathArcSpec, PathLineSpec, PathSegmentSpec } from './rv-path';

/** Position triple as it appears in the `rv_extras.Path` JSON. */
export type Vec3Tuple = [number, number, number];

/** What a handle does when dragged. */
export type PathHandleKind = 'vertex' | 'arc-center' | 'arc-radius' | 'arc-sweep';

/** One draggable point of a path, derived from the segment spec list. */
export interface PathHandle {
  /** Stable within one path (`v3`, `c1`, `r1`) — the drag key. */
  readonly id: string;
  readonly kind: PathHandleKind;
  /** World position of the handle. */
  readonly position: Vec3Tuple;
  /**
   * `vertex`: index of the segment ENDING here (−1 at the chain start).
   * `arc-*`: the arc's segment index.
   */
  readonly prevSegIndex: number;
  /** `vertex`: index of the segment STARTING here (−1 at the chain end). */
  readonly nextSegIndex: number;
  /** True for the two free ends of an open chain (F3 "Endpunkte"). */
  readonly endpoint: boolean;
}

const EPS = 1e-9;

// ─── Spec helpers ────────────────────────────────────────────────────────

function isLine(s: PathSegmentSpec | undefined): s is PathLineSpec {
  return !!s && s.kind === 'line';
}

function isArc(s: PathSegmentSpec | undefined): s is PathArcSpec {
  return !!s && s.kind === 'arc';
}

function tuple(v: unknown, def: Vec3Tuple = [0, 0, 0]): Vec3Tuple {
  if (!Array.isArray(v)) return [def[0], def[1], def[2]];
  const n = (x: unknown, d: number): number => {
    const f = Number(x);
    return Number.isFinite(f) ? f : d;
  };
  return [n(v[0], def[0]), n(v[1], def[1]), n(v[2], def[2])];
}

/** Plane basis (u, v) for an arc — mirrors `ArcSegment` in rv-path.ts. */
function planeBasis(plane: ArcPlane | undefined): { u: Vector3; v: Vector3 } {
  switch (plane) {
    case 'XY': return { u: new Vector3(1, 0, 0), v: new Vector3(0, 1, 0) };
    case 'YZ': return { u: new Vector3(0, 1, 0), v: new Vector3(0, 0, 1) };
    default:   return { u: new Vector3(1, 0, 0), v: new Vector3(0, 0, 1) }; // 'XZ'
  }
}

/** World point on an arc at normalised `t01` — mirrors `ArcSegment.getPosition`. */
export function arcPointAt(spec: PathArcSpec, t01: number): Vec3Tuple {
  const { u, v } = planeBasis(spec.plane);
  const c = tuple(spec.center);
  const r = Number.isFinite(spec.radius) ? Math.max(0, spec.radius) : 0;
  const startRad = ((Number.isFinite(spec.startAngle) ? spec.startAngle : 0) * Math.PI) / 180;
  const sweepDeg = Number.isFinite(spec.degrees) ? spec.degrees : 0;
  const sweepRad = (spec.clockwise === true ? -1 : 1) * ((sweepDeg * Math.PI) / 180);
  const t = t01 < 0 ? 0 : t01 > 1 ? 1 : t01;
  const a = startRad + sweepRad * t;
  return [
    c[0] + u.x * r * Math.cos(a) + v.x * r * Math.sin(a),
    c[1] + u.y * r * Math.cos(a) + v.y * r * Math.sin(a),
    c[2] + u.z * r * Math.cos(a) + v.z * r * Math.sin(a),
  ];
}

/** Analytic arc length in meters (`R·|sweep|`) — mirrors `ArcSegment.length`. */
export function arcLength(spec: PathArcSpec): number {
  const r = Number.isFinite(spec.radius) ? Math.max(0, spec.radius) : 0;
  const deg = Number.isFinite(spec.degrees) ? Math.abs(spec.degrees) : 0;
  return (r * deg * Math.PI) / 180;
}

/** Total arc length of a spec list — the same sum `RVPath` caches. */
export function specListLength(specs: readonly PathSegmentSpec[]): number {
  let sum = 0;
  for (const s of specs) {
    if (isLine(s)) {
      const a = tuple(s.from);
      const b = tuple(s.to);
      sum += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    } else if (isArc(s)) {
      sum += arcLength(s);
    }
  }
  return sum;
}

/** Structural copy of one spec (no shared array references). */
export function cloneSegmentSpec(s: PathSegmentSpec): PathSegmentSpec {
  if (s.kind === 'line') {
    return { kind: 'line', from: tuple(s.from), to: tuple(s.to) };
  }
  const out: PathArcSpec = {
    kind: 'arc',
    center: tuple(s.center),
    radius: Number.isFinite(s.radius) ? s.radius : 0,
    startAngle: Number.isFinite(s.startAngle) ? s.startAngle : 0,
    degrees: Number.isFinite(s.degrees) ? s.degrees : 0,
  };
  if (s.clockwise !== undefined) out.clockwise = s.clockwise === true;
  if (s.plane !== undefined) out.plane = s.plane;
  return out;
}

/** Structural copy of a whole spec list. */
export function cloneSegmentSpecs(specs: readonly PathSegmentSpec[]): PathSegmentSpec[] {
  return specs.map(cloneSegmentSpec);
}

/**
 * Read the (defensively normalised) segment spec list off a node's
 * `rv_extras.Path` payload. Unknown segment kinds are dropped — the same
 * tolerance `parsePathExtras` applies.
 */
export function readSegmentSpecs(node: { userData: Record<string, unknown> }): PathSegmentSpec[] {
  const rv = node.userData?.realvirtual as Record<string, unknown> | undefined;
  const payload = rv?.['Path'] as Record<string, unknown> | undefined;
  const raw = payload?.['segments'];
  if (!Array.isArray(raw)) return [];
  const out: PathSegmentSpec[] = [];
  for (const s of raw) {
    if (!s || typeof s !== 'object') continue;
    const kind = (s as Record<string, unknown>).kind;
    if (kind === 'line' || kind === 'arc') out.push(cloneSegmentSpec(s as PathSegmentSpec));
  }
  return out;
}

/**
 * Write a segment spec list into a node's `rv_extras.Path` payload — the
 * OPTIMISTIC runtime half of a drag commit (the durable/undoable half is the
 * `setField` op the caller records through `persistFieldOp`). The caller must
 * still run `RVPathComponent.reapplyConfig()` afterwards.
 */
export function writeSegmentSpecs(
  node: { userData: Record<string, unknown> },
  specs: readonly PathSegmentSpec[],
): void {
  const ud = node.userData as Record<string, unknown>;
  let rv = ud.realvirtual as Record<string, unknown> | undefined;
  if (!rv || typeof rv !== 'object') {
    rv = {};
    ud.realvirtual = rv;
  }
  let payload = rv['Path'] as Record<string, unknown> | undefined;
  if (!payload || typeof payload !== 'object') {
    payload = {};
    rv['Path'] = payload;
  }
  payload['segments'] = cloneSegmentSpecs(specs);
}

// ─── Handle derivation ───────────────────────────────────────────────────

/** Position of chain vertex slot `k` (0..n) — null when neither neighbour is a line. */
function vertexPosition(specs: readonly PathSegmentSpec[], k: number): Vec3Tuple | null {
  const prev = specs[k - 1];
  const next = specs[k];
  if (isLine(prev)) return tuple(prev.to);
  if (isLine(next)) return tuple(next.from);
  // Arc↔arc junction (or arc at a chain end): no free vertex handle — the arc
  // is edited through its own center/radius handles (plan-447 Entscheidungs-Log).
  return null;
}

/** Options of {@link derivePathHandles}. */
export interface DerivePathHandlesOptions {
  /**
   * Also derive the `arc-sweep` handle of every arc (plan-453 F1). Opt-in: the
   * sweep handle is a STRUCTURAL verb that only exists while structural path
   * edits are allowed (the reset state) — the plugin passes the lock result.
   */
  readonly sweep?: boolean;
}

/**
 * Every draggable handle of a segment spec list (plan-447 F3).
 *
 * Vertex handles are indexed by CHAIN SLOT `k ∈ [0..n]`: slot `k` sits between
 * `specs[k-1]` (ending there) and `specs[k]` (starting there). Slots 0 and n
 * are the free chain ENDPOINTS. A slot only produces a handle when at least one
 * of its neighbours is a line segment — that is exactly the case in which the
 * move is well defined.
 */
export function derivePathHandles(
  specs: readonly PathSegmentSpec[],
  opts: DerivePathHandlesOptions = {},
): PathHandle[] {
  const out: PathHandle[] = [];
  const n = specs.length;
  if (n === 0) return out;
  for (let k = 0; k <= n; k++) {
    const pos = vertexPosition(specs, k);
    if (!pos) continue;
    out.push({
      id: `v${k}`,
      kind: 'vertex',
      position: pos,
      prevSegIndex: k - 1 >= 0 ? k - 1 : -1,
      nextSegIndex: k < n ? k : -1,
      endpoint: k === 0 || k === n,
    });
  }
  for (let i = 0; i < n; i++) {
    const s = specs[i];
    if (!isArc(s)) continue;
    out.push({
      id: `c${i}`,
      kind: 'arc-center',
      position: tuple(s.center),
      prevSegIndex: i,
      nextSegIndex: i,
      endpoint: false,
    });
    out.push({
      id: `r${i}`,
      kind: 'arc-radius',
      position: arcPointAt(s, 0.5),
      prevSegIndex: i,
      nextSegIndex: i,
      endpoint: false,
    });
    // plan-453 F1: the sweep handle sits at the arc END and changes `degrees` only.
    if (opts.sweep !== true) continue;
    out.push({
      id: `s${i}`,
      kind: 'arc-sweep',
      position: arcPointAt(s, 1),
      prevSegIndex: i,
      nextSegIndex: i,
      endpoint: false,
    });
  }
  return out;
}

/** Look one handle up by id (null when the id is unknown for this spec list). */
export function findPathHandle(
  specs: readonly PathSegmentSpec[],
  handleId: string,
): PathHandle | null {
  for (const h of derivePathHandles(specs, { sweep: true })) if (h.id === handleId) return h;
  return null;
}

// ─── Handle mutation ─────────────────────────────────────────────────────

/**
 * Move one handle to `target` and return the RESULTING spec list (a fresh copy;
 * the input is never mutated). Unknown handle ids return an unchanged copy.
 *
 * - `vertex`: writes `specs[k-1].to` AND `specs[k].from` — both adjacent line
 *   segments are updated in ONE coordinated step so the chain stays connected
 *   (an arc neighbour is left alone: its shape is owned by its own handles).
 * - `arc-center`: translates the arc (radius, angles and sweep unchanged).
 * - `arc-radius`: sets the radius to the in-plane distance from the arc center
 *   to `target` (out-of-plane components are ignored, never NaN, never
 *   negative). The start angle and sweep are preserved, so the arc grows/shrinks
 *   around its own center.
 */
export function movePathHandle(
  specs: readonly PathSegmentSpec[],
  handleId: string,
  target: Vec3Tuple,
): PathSegmentSpec[] {
  const out = cloneSegmentSpecs(specs);
  const t = tuple(target);
  const kind = handleId.charAt(0);
  const idx = Number.parseInt(handleId.slice(1), 10);
  if (!Number.isInteger(idx) || idx < 0) return out;

  if (kind === 'v') {
    if (idx > out.length) return out;
    const prev = out[idx - 1];
    const next = out[idx];
    let touched = false;
    if (isLine(prev)) {
      prev.to = [t[0], t[1], t[2]];
      touched = true;
    }
    if (isLine(next)) {
      next.from = [t[0], t[1], t[2]];
      touched = true;
    }
    return touched ? out : cloneSegmentSpecs(specs);
  }

  const seg = out[idx];
  if (!isArc(seg)) return out;

  if (kind === 'c') {
    seg.center = [t[0], t[1], t[2]];
    return out;
  }

  if (kind === 'r') {
    const { u, v } = planeBasis(seg.plane);
    const c = tuple(seg.center);
    const dx = t[0] - c[0];
    const dy = t[1] - c[1];
    const dz = t[2] - c[2];
    const du = dx * u.x + dy * u.y + dz * u.z;
    const dv = dx * v.x + dy * v.y + dz * v.z;
    const r = Math.hypot(du, dv);
    seg.radius = Number.isFinite(r) && r > EPS ? r : 0;
    return out;
  }

  if (kind === 's') {
    // plan-453 F1: one-shot form of the sweep drag (no unwrap history — the
    // nearest wrap to the current sweep wins). The plugin's drag keeps its own
    // unwrap state and calls `sweepFromPoint` + `setArcDegrees` directly.
    const deg = sweepFromPoint(seg, t, Math.abs(seg.degrees));
    return setArcDegrees(out, idx, deg) ?? out;
  }

  return out;
}

// ─── Structural verbs (plan-453 §2.3 / §2.6) ─────────────────────────────

/** Smallest arc sweep a verb or the sweep handle produces, in degrees. */
export const MIN_SWEEP_DEG = 1;
/** Largest arc sweep, in degrees (one full turn). */
export const MAX_SWEEP_DEG = 360;
/** Shortest piece a split may leave, in meters (1 mm) — shorter → `degenerate`. */
export const MIN_PIECE_M = 0.001;

/** Arc length of one segment spec in meters (0 for unknown kinds). */
export function segmentLength(s: PathSegmentSpec | undefined): number {
  if (isLine(s)) {
    const a = tuple(s.from);
    const b = tuple(s.to);
    return Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  }
  if (isArc(s)) return arcLength(s);
  return 0;
}

/** Signed sweep σ in DEGREES — the quantity `arcPointAt` / `ArcSegment` turn by. */
function signedSweepDeg(spec: PathArcSpec): number {
  const d = Number.isFinite(spec.degrees) ? spec.degrees : 0;
  return (spec.clockwise === true ? -1 : 1) * d;
}

function clampSweepMagnitude(deg: number): number {
  const m = Number.isFinite(deg) ? Math.abs(deg) : MIN_SWEEP_DEG;
  return m < MIN_SWEEP_DEG ? MIN_SWEEP_DEG : m > MAX_SWEEP_DEG ? MAX_SWEEP_DEG : m;
}

/**
 * Set the opening angle of arc `index` (F1). Only `degrees` changes; its
 * MAGNITUDE is clamped to [{@link MIN_SWEEP_DEG}, {@link MAX_SWEEP_DEG}] and the
 * SIGN of the original `degrees` is kept (center, radius, start angle, plane and
 * `clockwise` stay untouched). Returns null when `index` is not an arc.
 */
export function setArcDegrees(
  specs: readonly PathSegmentSpec[],
  index: number,
  degrees: number,
): PathSegmentSpec[] | null {
  if (!isArc(specs[index])) return null;
  const out = cloneSegmentSpecs(specs);
  const seg = out[index] as PathArcSpec;
  const sign = seg.degrees < 0 ? -1 : 1;
  seg.degrees = sign * clampSweepMagnitude(degrees);
  return out;
}

/** In-plane angle (degrees) of `point` around the arc center, in the arc's plane basis. */
function angleAroundCenter(spec: PathArcSpec, point: Vec3Tuple): number | null {
  const { u, v } = planeBasis(spec.plane);
  const c = tuple(spec.center);
  const q = [point[0] - c[0], point[1] - c[1], point[2] - c[2]];
  const du = q[0] * u.x + q[1] * u.y + q[2] * u.z;
  const dv = q[0] * v.x + q[1] * v.y + q[2] * v.z;
  if (Math.hypot(du, dv) < EPS) return null;
  return (Math.atan2(dv, du) * 180) / Math.PI;
}

/**
 * Sweep magnitude (degrees, UNCLAMPED, in the arc's own turning direction) that
 * puts the arc end at the angle of `point` — continuously UNWRAPPED: of all
 * `rel + k·360°` the one nearest to `prevSweepDeg` wins, so a drag never jumps
 * at ±180° (plan-453 §2.7). A point on the center returns `prevSweepDeg`.
 */
export function sweepFromPoint(spec: PathArcSpec, point: Vec3Tuple, prevSweepDeg: number): number {
  const ang = angleAroundCenter(spec, tuple(point));
  if (ang === null) return prevSweepDeg;
  const a0 = Number.isFinite(spec.startAngle) ? spec.startAngle : 0;
  const dir = signedSweepDeg(spec) < 0 ? -1 : 1;
  // Relative angle measured in the arc's turning direction.
  const rel = dir * (ang - a0);
  const k = Math.round((prevSweepDeg - rel) / 360);
  return rel + k * 360;
}

/**
 * Append one segment at the free `end` of the chain (F2, plan-453 §2.4a/§2.6):
 * the SAME kind and the SAME dimensions as its neighbour, continued tangentially
 * (a line `from→to` gets `to → to + d`, an arc continues on its own circle with
 * `startAngle = a₀ ± σ`). An empty list gets the documented fallback, a 1 m line
 * along +X. Returns null when the neighbour is degenerate (shorter than
 * {@link MIN_PIECE_M}) — there is no tangent to continue.
 */
export function appendSegment(
  specs: readonly PathSegmentSpec[],
  end: 'start' | 'end',
): PathSegmentSpec[] | null {
  const out = cloneSegmentSpecs(specs);
  if (out.length === 0) {
    out.push({ kind: 'line', from: [0, 0, 0], to: [1, 0, 0] });
    return out;
  }
  const nb = end === 'end' ? out[out.length - 1] : out[0];
  if (segmentLength(nb) < MIN_PIECE_M) return null;
  let added: PathSegmentSpec;
  if (isLine(nb)) {
    const a = tuple(nb.from);
    const b = tuple(nb.to);
    const d: Vec3Tuple = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    added = end === 'end'
      ? { kind: 'line', from: [b[0], b[1], b[2]], to: [b[0] + d[0], b[1] + d[1], b[2] + d[2]] }
      : { kind: 'line', from: [a[0] - d[0], a[1] - d[1], a[2] - d[2]], to: [a[0], a[1], a[2]] };
  } else {
    const arc = cloneSegmentSpec(nb) as PathArcSpec;
    const sigma = signedSweepDeg(arc);
    arc.startAngle = end === 'end' ? arc.startAngle + sigma : arc.startAngle - sigma;
    added = arc;
  }
  if (end === 'end') out.push(added);
  else out.unshift(added);
  return out;
}

/**
 * Remove the segment at chain `end` (F3). Null when the list has ≤ 1 segment —
 * a path never becomes empty through this verb. Deleting from the MIDDLE is a
 * non-goal (it would tear the chain).
 */
export function removeEndSegment(
  specs: readonly PathSegmentSpec[],
  end: 'start' | 'end',
): PathSegmentSpec[] | null {
  if (specs.length <= 1) return null;
  const out = cloneSegmentSpecs(specs);
  if (end === 'end') out.pop();
  else out.shift();
  return out;
}

/**
 * Split segment `index` at `t01` into two (F4, formulas plan-453 §2.3). The
 * geometry is unchanged: a line becomes `from→p`, `p→to`; an arc keeps every
 * field and divides the sweep — first `degrees·t`, second `startAngle + σ·t`,
 * `degrees·(1−t)` with the SIGNED sweep σ, so `clockwise` and negative
 * `degrees` stay exact. Null for an unknown index, `t ∉ (0, 1)` or a piece
 * shorter than {@link MIN_PIECE_M} (`degenerate`).
 */
export function splitSegment(
  specs: readonly PathSegmentSpec[],
  index: number,
  t01: number,
): PathSegmentSpec[] | null {
  const seg = specs[index];
  if (!seg || !Number.isFinite(t01) || t01 <= 0 || t01 >= 1) return null;
  const len = segmentLength(seg);
  if (len * t01 < MIN_PIECE_M || len * (1 - t01) < MIN_PIECE_M) return null;
  let first: PathSegmentSpec;
  let second: PathSegmentSpec;
  if (isLine(seg)) {
    const a = tuple(seg.from);
    const b = tuple(seg.to);
    const p: Vec3Tuple = [a[0] + t01 * (b[0] - a[0]), a[1] + t01 * (b[1] - a[1]), a[2] + t01 * (b[2] - a[2])];
    first = { kind: 'line', from: a, to: [p[0], p[1], p[2]] };
    second = { kind: 'line', from: [p[0], p[1], p[2]], to: b };
  } else if (isArc(seg)) {
    const d = Number.isFinite(seg.degrees) ? seg.degrees : 0;
    const a0 = Number.isFinite(seg.startAngle) ? seg.startAngle : 0;
    const f = cloneSegmentSpec(seg) as PathArcSpec;
    const s2 = cloneSegmentSpec(seg) as PathArcSpec;
    f.degrees = d * t01;
    s2.startAngle = a0 + signedSweepDeg(seg) * t01;
    s2.degrees = d * (1 - t01);
    first = f;
    second = s2;
  } else {
    return null;
  }
  const out = cloneSegmentSpecs(specs);
  out.splice(index, 1, first, second);
  return out;
}

/** Result of {@link projectToSegment}. */
export interface SegmentProjection {
  /** Normalised position on the segment, [0, 1]. */
  readonly t01: number;
  /** World distance from the point to the segment point at `t01`. */
  readonly distance: number;
}

/**
 * Closest point of one segment to `point` (plan-453 §2.7), analytic. A line
 * projects onto its direction and clamps; an arc maps the point into its own
 * plane basis (XZ, XY or YZ), measures the angle against the start angle in
 * the sweep direction and clamps to the NEARER end when it falls outside the
 * sweep. The inverse of `arcPointAt` / line interpolation on the segment.
 */
export function projectToSegment(spec: PathSegmentSpec, point: Vec3Tuple): SegmentProjection {
  const p = tuple(point);
  if (isLine(spec)) {
    const a = tuple(spec.from);
    const b = tuple(spec.to);
    const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const dd = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
    let t = dd > EPS * EPS ? ((p[0] - a[0]) * d[0] + (p[1] - a[1]) * d[1] + (p[2] - a[2]) * d[2]) / dd : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const q = [a[0] + t * d[0], a[1] + t * d[1], a[2] + t * d[2]];
    return { t01: t, distance: Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) };
  }
  if (isArc(spec)) {
    const sigma = Math.abs(signedSweepDeg(spec));
    let t = 0;
    const ang = angleAroundCenter(spec, p);
    if (ang !== null && sigma > EPS) {
      const a0 = Number.isFinite(spec.startAngle) ? spec.startAngle : 0;
      const dir = signedSweepDeg(spec) < 0 ? -1 : 1;
      let rel = (dir * (ang - a0)) % 360;
      if (rel < 0) rel += 360;
      t = rel / sigma;
      if (t > 1) {
        // Outside the sweep: clamp to the angularly nearer end.
        t = rel - sigma < 360 - rel ? 1 : 0;
      }
    }
    const q = arcPointAt(spec, t);
    return { t01: t, distance: Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) };
  }
  return { t01: 0, distance: Number.POSITIVE_INFINITY };
}

/**
 * Where an arc length `s` (meters from the chain start) lies: segment index and
 * normalised `t01` — the same convention as `RVPath.locate` (a boundary belongs
 * to the LATER segment at `t01 = 0`; `s` is clamped to [0, total]). Null for an
 * empty list. plan-628 P7 turns a node position into a `splitSegment` call with it.
 */
export function locateArcLength(
  specs: readonly PathSegmentSpec[],
  s: number,
): { index: number; t01: number } | null {
  const n = specs.length;
  if (n === 0) return null;
  const total = specListLength(specs);
  const m = !Number.isFinite(s) || s < 0 ? 0 : s > total ? total : s;
  // Greatest i with prefix[i] <= m (prefixes are monotonic).
  let acc = 0;
  let index = 0;
  let start = 0;
  for (let i = 0; i < n; i++) {
    if (acc > m) break;
    index = i;
    start = acc;
    acc += segmentLength(specs[i]);
  }
  const len = segmentLength(specs[index]);
  const t = len > 0 ? (m - start) / len : 0;
  return { index, t01: t < 0 ? 0 : t > 1 ? 1 : t };
}

/**
 * Point of one segment hit by a pointer ray (plan-453 §2.7). A LINE takes the
 * closest points between ray and segment (analytic); an ARC intersects the ray
 * with the arc's OWN plane (normal `u × v` through the center) and projects
 * that point. Null when the ray runs parallel to the arc plane or points away.
 * `point` is ON the segment (at `t01`) — the caller measures its screen
 * distance to the pointer.
 */
export function pickSegmentPoint(
  spec: PathSegmentSpec,
  rayOrigin: Vec3Tuple,
  rayDir: Vec3Tuple,
): { t01: number; point: Vec3Tuple } | null {
  const o = tuple(rayOrigin);
  const r = tuple(rayDir);
  if (isLine(spec)) {
    const a = tuple(spec.from);
    const b = tuple(spec.to);
    const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const w = [o[0] - a[0], o[1] - a[1], o[2] - a[2]];
    const dot = (x: number[], y: number[]): number => x[0] * y[0] + x[1] * y[1] + x[2] * y[2];
    const aa = dot(r, r);
    const bb = dot(r, d);
    const cc = dot(d, d);
    const dd = dot(r, w);
    const ee = dot(d, w);
    const den = aa * cc - bb * bb;
    let t: number;
    if (cc < EPS * EPS) t = 0;
    else if (Math.abs(den) < EPS) t = ee / cc; // parallel: project the ray origin
    else t = (aa * ee - bb * dd) / den;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    return { t01: t, point: [a[0] + t * d[0], a[1] + t * d[1], a[2] + t * d[2]] };
  }
  if (isArc(spec)) {
    const hit = rayOnArcPlane(spec, o, r);
    if (!hit) return null;
    const proj = projectToSegment(spec, hit);
    return { t01: proj.t01, point: arcPointAt(spec, proj.t01) };
  }
  return null;
}

/**
 * Point of a pointer ray on an arc's OWN plane (the sweep-drag plane, plan-453
 * §2.7) — null when the ray is parallel to it or points away.
 */
export function rayOnArcPlane(spec: PathArcSpec, rayOrigin: Vec3Tuple, rayDir: Vec3Tuple): Vec3Tuple | null {
  const { u, v } = planeBasis(spec.plane);
  const n = new Vector3().crossVectors(u, v);
  const o = tuple(rayOrigin);
  const r = tuple(rayDir);
  const c = tuple(spec.center);
  const denom = n.x * r[0] + n.y * r[1] + n.z * r[2];
  if (Math.abs(denom) < EPS) return null;
  const k = (n.x * (c[0] - o[0]) + n.y * (c[1] - o[1]) + n.z * (c[2] - o[2])) / denom;
  if (k < 0) return null;
  return [o[0] + k * r[0], o[1] + k * r[1], o[2] + k * r[2]];
}

// ─── Snap rastung while dragging an endpoint (F4) ────────────────────────

/** Default rastung radius in meters for a path-endpoint drag. */
export const DEFAULT_PATH_SNAP_RADIUS_M = 0.35;

/** One candidate the dragged endpoint may rast onto. */
export interface PathSnapCandidate {
  /** Diagnostic id (path-end snap id, station snap id, …). */
  readonly id: string;
  readonly position: Vec3Tuple;
  /**
   * Set when the candidate IS a path end (plan-633 F7): which path and which
   * end. A drag that rasts onto it writes the `successors` link on commit.
   * Absent for foreign targets (station snappoints).
   */
  readonly pathEnd?: { readonly pathId: string; readonly which: 'start' | 'end' };
}

export interface PathSnapResult {
  /** The (possibly rasted) drag target. */
  readonly position: Vec3Tuple;
  /** The candidate that captured the drag — null when the drag stayed free. */
  readonly snappedTo: PathSnapCandidate | null;
  /** Distance to `snappedTo` before the rastung (Infinity when free). */
  readonly distance: number;
}

/**
 * Rast a raw drag target onto the NEAREST candidate within `radiusM`
 * (plan-447 F4). Pure and deterministic: ties break on the candidate id, so a
 * drag never flickers between two coincident snap points.
 */
export function snapDragTarget(
  target: Vec3Tuple,
  candidates: readonly PathSnapCandidate[],
  radiusM: number = DEFAULT_PATH_SNAP_RADIUS_M,
): PathSnapResult {
  const t = tuple(target);
  let best: PathSnapCandidate | null = null;
  let bestD = Number.POSITIVE_INFINITY;
  const r = Number.isFinite(radiusM) && radiusM > 0 ? radiusM : 0;
  for (const c of candidates) {
    const p = tuple(c.position);
    const d = Math.hypot(p[0] - t[0], p[1] - t[1], p[2] - t[2]);
    if (d > r) continue;
    if (d < bestD || (d === bestD && best !== null && c.id < best.id)) {
      best = c;
      bestD = d;
    }
  }
  if (!best) return { position: t, snappedTo: null, distance: Number.POSITIVE_INFINITY };
  return { position: tuple(best.position), snappedTo: best, distance: bestD };
}
