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
 *   explicit NON-goal of plan-447.
 *
 * Every mutation returns a NEW spec list (structural copy) — the caller keeps
 * the pre-drag list as the `prev` value of the undoable op.
 */

import { Vector3 } from 'three';
import type { ArcPlane, PathArcSpec, PathLineSpec, PathSegmentSpec } from './rv-path';

/** Position triple as it appears in the `rv_extras.Path` JSON. */
export type Vec3Tuple = [number, number, number];

/** What a handle does when dragged. */
export type PathHandleKind = 'vertex' | 'arc-center' | 'arc-radius';

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

/**
 * Every draggable handle of a segment spec list (plan-447 F3).
 *
 * Vertex handles are indexed by CHAIN SLOT `k ∈ [0..n]`: slot `k` sits between
 * `specs[k-1]` (ending there) and `specs[k]` (starting there). Slots 0 and n
 * are the free chain ENDPOINTS. A slot only produces a handle when at least one
 * of its neighbours is a line segment — that is exactly the case in which the
 * move is well defined.
 */
export function derivePathHandles(specs: readonly PathSegmentSpec[]): PathHandle[] {
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
  }
  return out;
}

/** Look one handle up by id (null when the id is unknown for this spec list). */
export function findPathHandle(
  specs: readonly PathSegmentSpec[],
  handleId: string,
): PathHandle | null {
  for (const h of derivePathHandles(specs)) if (h.id === handleId) return h;
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

  return out;
}

// ─── Snap rastung while dragging an endpoint (F4) ────────────────────────

/** Default rastung radius in meters for a path-endpoint drag. */
export const DEFAULT_PATH_SNAP_RADIUS_M = 0.35;

/** One candidate the dragged endpoint may rast onto. */
export interface PathSnapCandidate {
  /** Diagnostic id (path-end snap id, station snap id, …). */
  readonly id: string;
  readonly position: Vec3Tuple;
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
