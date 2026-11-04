// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-path-blocks.ts — pure geometry of the path-network building blocks
 * (plan-628 Phase 2, P1/P4/P8/P10).
 *
 * A block is a procedural template in a LOCAL frame: origin = the block's
 * reference point, heading 0 = local +X, y = 0. Placing it means transforming
 * the template by a pose `[x, z, headingDeg]` (+ an elevation `y`). Path
 * segments stay ABSOLUTE world coordinates (B1) — the pose is data on the
 * `PathBlock` node, never a node transform.
 *
 * Conventions (XZ plane, Y up, the segment-data space of `rv_extras.Path`, which
 * the loader does NOT mirror):
 *   - heading h (degrees) of a direction (tx, tz) = atan2(tz, tx); local +X maps
 *     to world (cos h, 0, sin h).
 *   - LEFT of travel direction f is `up × f` = (f.z, 0, −f.x); a LEFT turn
 *     DECREASES the heading. For heading 0 (+X) left is −Z.
 *   - an arc angle a is measured in the arc's plane basis (XZ: u = +X, v = +Z),
 *     so a world rotation by Δh shifts `startAngle` by +Δh.
 *
 * Everything here is deterministic and side-effect free. The topology ops
 * (`rv-path-network-ops.ts`) build on these helpers.
 */

import type { PathArcSpec, PathSegmentSpec } from './rv-path';
import { getPathEndpoints, parsePathExtras } from './rv-path';
import {
  cloneSegmentSpec,
  cloneSegmentSpecs,
  locateArcLength,
  segmentLength,
  specListLength,
  splitSegment,
  type Vec3Tuple,
} from './rv-path-edit';

// ─── Block specs ─────────────────────────────────────────────────────────

/** The five block kinds of the built-in "Path Network" catalog (F2). */
export type PathBlockKind = 'straight' | 'curve' | 'diverge' | 'merge' | 'stub';

/** Kinds that are set ONTO an existing path (a node, P7) instead of at a free end. */
export const JUNCTION_KINDS: ReadonlySet<PathBlockKind> = new Set(['diverge', 'merge', 'stub']);

/**
 * Parameters of a block (catalog entry `pathBlock`, `PathBlock.params`).
 * Absent fields take {@link PATH_BLOCK_DEFAULTS}.
 */
export interface PathBlockSpec {
  kind: PathBlockKind;
  /** straight: length in meters (default 2.0). */
  lengthM?: number;
  /** curve / diverge / merge branch / stub mouth: radius in meters (default 1.5). */
  radiusM?: number;
  /** curve / diverge / merge branch: opening angle in degrees (default 90). */
  degrees?: number;
  /** Turning side relative to travel (curve/diverge) or the side the branch/stub lies on. */
  side?: 'left' | 'right';
  /** stub: length of the straight from the handling point to the mouth (default 1.5 m). */
  stubStraightM?: number;
  /** stub: a twin stub on both sides at the same node (PalletYard pattern). */
  twin?: boolean;
}

/** Defaults of the block parameters (PalletYard measures, plan-628 P8). */
export const PATH_BLOCK_DEFAULTS = Object.freeze({
  lengthM: 2.0,
  radiusM: 1.5,
  degrees: 90,
  side: 'left' as 'left' | 'right',
  stubStraightM: 1.5,
  twin: false,
});

/** Merge piece after the junction (`outM`, PalletYard) in meters. */
export const MERGE_OUT_M = 0.6;
/** Lead-in (`preM`) without a known envelope — PalletYard value (#194: 1.68 m < 1.8 m). */
export const MERGE_PRE_FALLBACK_M = 1.8;
/** Smallest lead-in the sizing tries (meters). */
export const MERGE_PRE_MIN_M = 1.0;
/** Sizing step (meters) and the maximum number of steps (plan §5.2). */
export const MERGE_PRE_STEP_M = 0.1;
export const MERGE_PRE_MAX_STEPS = 30;

/** Fully resolved parameters (every field set). */
export type ResolvedBlockParams = Required<Omit<PathBlockSpec, 'kind'>>;

/** Fill absent parameters with the defaults; non-finite / non-positive numbers fall back too. */
export function resolveBlockParams(spec: Omit<PathBlockSpec, 'kind'> & { kind?: PathBlockKind }): ResolvedBlockParams {
  const pos = (v: unknown, d: number): number => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : d;
  };
  const deg = pos(spec.degrees, PATH_BLOCK_DEFAULTS.degrees);
  return {
    lengthM: pos(spec.lengthM, PATH_BLOCK_DEFAULTS.lengthM),
    radiusM: pos(spec.radiusM, PATH_BLOCK_DEFAULTS.radiusM),
    degrees: deg > 360 ? 360 : deg,
    side: spec.side === 'right' ? 'right' : 'left',
    stubStraightM: pos(spec.stubStraightM, PATH_BLOCK_DEFAULTS.stubStraightM),
    twin: spec.twin === true,
  };
}

// ─── Poses and planar transforms ─────────────────────────────────────────

/** A block pose: `[x, z, headingDeg]` in meters / degrees (plan §2.3). */
export type BlockPose = [number, number, number];

/** A port in world space: position plus the travel tangent. */
export interface PortPose {
  position: Vec3Tuple;
  tangent: Vec3Tuple;
}

/** Rigid planar motion: rotate about `pivot` (x, z) by `dHeadingDeg`, then translate. */
export interface RigidXZ {
  dx: number;
  dz: number;
  dHeadingDeg: number;
  pivot: [number, number];
}

const DEG = Math.PI / 180;

/** Heading (degrees, (−180, 180]) of a direction in the XZ plane. */
export function headingOf(t: Vec3Tuple): number {
  return Math.atan2(t[2], t[0]) / DEG;
}

/** Unit direction for a heading in degrees. */
export function directionOf(headingDeg: number): Vec3Tuple {
  return [Math.cos(headingDeg * DEG), 0, Math.sin(headingDeg * DEG)];
}

/** Normalise an angle into (−180, 180]. */
export function wrapDeg(a: number): number {
  let r = a % 360;
  if (r <= -180) r += 360;
  if (r > 180) r -= 360;
  return r;
}

/** Rotate (x, z) by `deg` (heading sense: +X towards +Z). */
function rot(x: number, z: number, deg: number): [number, number] {
  const c = Math.cos(deg * DEG);
  const s = Math.sin(deg * DEG);
  return [x * c - z * s, x * s + z * c];
}

/** Apply a point map to every point-like field of a spec list; arcs also shift their start angle. */
function mapSpecs(
  specs: readonly PathSegmentSpec[],
  point: (p: Vec3Tuple) => Vec3Tuple,
  dAngleDeg: number,
): PathSegmentSpec[] {
  return specs.map((s) => {
    const c = cloneSegmentSpec(s);
    if (c.kind === 'line') {
      c.from = point(c.from);
      c.to = point(c.to);
    } else {
      c.center = point(c.center);
      // Only XZ arcs turn with a rotation about Y; other planes keep their angle
      // (catalog blocks are XZ only — plan §2.4a).
      if ((c.plane ?? 'XZ') === 'XZ') c.startAngle = c.startAngle + dAngleDeg;
    }
    return c;
  });
}

/** Local template → world: rotate by the pose heading, translate by (x, y, z). */
export function transformSpecs(specs: readonly PathSegmentSpec[], pose: BlockPose, y = 0): PathSegmentSpec[] {
  const [px, pz, h] = pose;
  return mapSpecs(specs, (p) => {
    const [rx, rz] = rot(p[0], p[2], h);
    return [rx + px, p[1] + y, rz + pz];
  }, h);
}

/** Apply a rigid planar motion to world specs (plan §2.4a). Y values stay. */
export function applyRigidXZ(specs: readonly PathSegmentSpec[], m: RigidXZ): PathSegmentSpec[] {
  return mapSpecs(specs, (p) => applyRigidToPoint(p, m), m.dHeadingDeg);
}

/** Apply a rigid planar motion to one point. */
export function applyRigidToPoint(p: Vec3Tuple, m: RigidXZ): Vec3Tuple {
  const [rx, rz] = rot(p[0] - m.pivot[0], p[2] - m.pivot[1], m.dHeadingDeg);
  return [rx + m.pivot[0] + m.dx, p[1], rz + m.pivot[1] + m.dz];
}

/** Apply a rigid planar motion to a block pose. */
export function applyRigidToPose(pose: BlockPose, m: RigidXZ): BlockPose {
  const p = applyRigidToPoint([pose[0], 0, pose[1]], m);
  return [p[0], p[2], wrapDeg(pose[2] + m.dHeadingDeg)];
}

/**
 * plan-628 8.11d/e: the rigid motion that carries a port from `from` onto `to`
 * — rotate about `from` by the heading change, then translate. A chain hanging
 * on a block's end follows a length / radius / kind change with it, so the
 * edge stays coincident AND tangential.
 */
export function endFollowMotion(from: PortPose, to: PortPose): RigidXZ {
  return {
    pivot: [from.position[0], from.position[2]],
    dHeadingDeg: wrapDeg(headingOf(to.tangent) - headingOf(from.tangent)),
    dx: to.position[0] - from.position[0],
    dz: to.position[2] - from.position[2],
  };
}

// ─── Ends ────────────────────────────────────────────────────────────────

/** Start and end pose (position + travel tangent) of a spec list — derived through `RVPath`. */
export function specEnds(specs: readonly PathSegmentSpec[]): { start: PortPose; end: PortPose } | null {
  if (specs.length === 0) return null;
  const path = parsePathExtras({ segments: cloneSegmentSpecs(specs) }, '__ends');
  if (!path) return null;
  const e = getPathEndpoints(path);
  if (!e) return null;
  const t = (v: { x: number; y: number; z: number }): Vec3Tuple => [v.x, v.y, v.z];
  return {
    start: { position: t(e.start.position), tangent: t(e.start.tangent) },
    end: { position: t(e.end.position), tangent: t(e.end.tangent) },
  };
}

/** Position and tangent at arc length `s` (meters) of a spec list. */
export function poseAtArcLength(specs: readonly PathSegmentSpec[], s: number): PortPose | null {
  if (specs.length === 0) return null;
  const path = parsePathExtras({ segments: cloneSegmentSpecs(specs) }, '__pose');
  if (!path) return null;
  const p = path.getAbsPosition(s);
  const d = path.getAbsDirection(s);
  return { position: [p.x, p.y, p.z], tangent: [d.x, d.y, d.z] };
}

// ─── Templates ───────────────────────────────────────────────────────────

/** Role of one template piece. */
export type BlockPieceRole = 'main' | 'branch' | 'stub' | 'mouth';

/** One path of a block template (local frame). */
export interface BlockPiece {
  role: BlockPieceRole;
  /** Side of a branch / stub / mouth piece (left/right of the host travel). */
  side?: 'left' | 'right';
  specs: PathSegmentSpec[];
}

/** Arc that LEAVES the origin heading +X and turns to `side` (curve / diverge branch). */
function turnArc(r: number, deg: number, side: 'left' | 'right'): PathArcSpec {
  const sigma = side === 'left' ? -1 : 1;
  return { kind: 'arc', center: [0, 0, sigma * r], radius: r, startAngle: -sigma * 90, degrees: deg, clockwise: side === 'left', plane: 'XZ' };
}

/** Arc that ARRIVES at the origin heading +X, coming from `side` (merge branch / stub mouth). */
function joinArc(r: number, deg: number, side: 'left' | 'right'): PathArcSpec {
  const sigma = side === 'left' ? -1 : 1;
  return { kind: 'arc', center: [0, 0, sigma * r], radius: r, startAngle: -sigma * 90 - sigma * deg, degrees: deg, clockwise: side === 'left', plane: 'XZ' };
}

/** Stub on one side: straight from the handling point, then a 90° mouth into the lane. */
function stubPieces(p: ResolvedBlockParams, side: 'left' | 'right'): BlockPiece[] {
  const mouth = joinArc(p.radiusM, 90, side);
  const ends = specEnds([mouth])!;
  const s0 = ends.start.position;
  const t0 = ends.start.tangent;
  const from: Vec3Tuple = [s0[0] - t0[0] * p.stubStraightM, 0, s0[2] - t0[2] * p.stubStraightM];
  return [
    { role: 'stub', side, specs: [{ kind: 'line', from, to: [s0[0], 0, s0[2]] }] },
    { role: 'mouth', side, specs: [mouth] },
  ];
}

/**
 * The template of a block in its LOCAL frame (plan-628 P1).
 *
 * - straight / curve: origin = input port, the whole block (`main`).
 * - diverge / merge / stub: origin = the node on the host path, heading = host
 *   tangent there; only the BRANCH pieces — the in-line pieces (`_In` / `_Out`,
 *   front, rest) are cut from the host and are no template geometry.
 */
export function blockTemplate(spec: PathBlockSpec): BlockPiece[] {
  const p = resolveBlockParams(spec);
  switch (spec.kind) {
    case 'straight':
      return [{ role: 'main', specs: [{ kind: 'line', from: [0, 0, 0], to: [p.lengthM, 0, 0] }] }];
    case 'curve':
      return [{ role: 'main', specs: [turnArc(p.radiusM, p.degrees, p.side)] }];
    case 'diverge':
      return [{ role: 'branch', side: p.side, specs: [turnArc(p.radiusM, p.degrees, p.side)] }];
    case 'merge':
      return [{ role: 'branch', side: p.side, specs: [joinArc(p.radiusM, p.degrees, p.side)] }];
    case 'stub': {
      const out = stubPieces(p, p.side);
      if (p.twin) out.push(...stubPieces(p, p.side === 'left' ? 'right' : 'left'));
      return out;
    }
    default:
      return [];
  }
}

/** The template placed at `pose` (world frame) — `template(kind, params, pose)` of plan §4 Phase 2. */
export function placedTemplate(spec: PathBlockSpec, pose: BlockPose, y = 0): BlockPiece[] {
  return blockTemplate(spec).map((pc) => ({ ...pc, specs: transformSpecs(pc.specs, pose, y) }));
}

/**
 * Pose that puts a local template point/heading (`local`, `localHeadingDeg`)
 * onto a world port. Arbitrary angle — no cardinal snapping (B8).
 */
export function poseForPort(port: PortPose, local: Vec3Tuple = [0, 0, 0], localHeadingDeg = 0): BlockPose {
  const h = wrapDeg(headingOf(port.tangent) - localHeadingDeg);
  const [rx, rz] = rot(local[0], local[2], h);
  return [port.position[0] - rx, port.position[2] - rz, h];
}

/**
 * Align a local spec list so that its START sits on `port` with the port
 * tangent (plan §9.1 `alignToPort`). The y of the port is applied as elevation.
 */
export function alignToPort(localSpecs: readonly PathSegmentSpec[], port: PortPose): PathSegmentSpec[] {
  const ends = specEnds(localSpecs);
  if (!ends) return [];
  const pose = poseForPort(port, ends.start.position, headingOf(ends.start.tangent));
  return transformSpecs(localSpecs, pose, port.position[1]);
}

/** Template specs of a straight/curve block (convenience for tests and the catalog). */
export function blockSpecs(spec: PathBlockSpec): PathSegmentSpec[] {
  return blockTemplate(spec).flatMap((p) => p.specs);
}

// ─── Cutting and coalescing ──────────────────────────────────────────────

/**
 * Cut a spec list at the given arc lengths (ascending, strictly inside
 * (0, length)) into `cuts.length + 1` pieces via `locateArcLength` +
 * `splitSegment` (plan-628 N1). Null when a piece would be shorter than 1 mm.
 */
export function cutSpecs(specs: readonly PathSegmentSpec[], cuts: readonly number[]): PathSegmentSpec[][] | null {
  const total = specListLength(specs);
  const out: PathSegmentSpec[][] = [];
  let rest = cloneSegmentSpecs(specs);
  let consumed = 0;
  for (const c of cuts) {
    const local = c - consumed;
    const restLen = total - consumed;
    if (!(local > 1e-3) || !(restLen - local > 1e-3)) return null;
    const loc = locateArcLength(rest, local);
    if (!loc) return null;
    let idx = loc.index;
    let work = rest;
    if (loc.t01 > 1e-12 && loc.t01 < 1 - 1e-12) {
      const sp = splitSegment(rest, loc.index, loc.t01);
      if (!sp) return null;
      work = sp;
      idx = loc.index + 1;
    } else if (loc.t01 >= 1 - 1e-12) {
      idx = loc.index + 1;
    }
    out.push(work.slice(0, idx));
    rest = work.slice(idx);
    consumed = c;
  }
  out.push(rest);
  return out.every((p) => p.length > 0) ? out : null;
}

const COALESCE_EPS = 1e-7;

function near(a: Vec3Tuple, b: Vec3Tuple, eps = COALESCE_EPS): boolean {
  return Math.abs(a[0] - b[0]) < eps && Math.abs(a[1] - b[1]) < eps && Math.abs(a[2] - b[2]) < eps;
}

/**
 * Merge adjacent collinear lines and adjacent pieces of the same circle back
 * into one segment — the inverse of `splitSegment`, used when a junction is
 * removed and its host heals (plan §2.4a).
 */
export function coalesceSpecs(specs: readonly PathSegmentSpec[]): PathSegmentSpec[] {
  const out: PathSegmentSpec[] = [];
  for (const s of cloneSegmentSpecs(specs)) {
    const prev = out[out.length - 1];
    if (prev && prev.kind === 'line' && s.kind === 'line' && near(prev.to, s.from)) {
      const d1 = [prev.to[0] - prev.from[0], prev.to[1] - prev.from[1], prev.to[2] - prev.from[2]];
      const d2 = [s.to[0] - s.from[0], s.to[1] - s.from[1], s.to[2] - s.from[2]];
      const l1 = Math.hypot(d1[0], d1[1], d1[2]);
      const l2 = Math.hypot(d2[0], d2[1], d2[2]);
      if (l1 > 0 && l2 > 0) {
        const cx = d1[1] * d2[2] - d1[2] * d2[1];
        const cy = d1[2] * d2[0] - d1[0] * d2[2];
        const cz = d1[0] * d2[1] - d1[1] * d2[0];
        const dot = d1[0] * d2[0] + d1[1] * d2[1] + d1[2] * d2[2];
        if (Math.hypot(cx, cy, cz) / (l1 * l2) < 1e-9 && dot > 0) {
          prev.to = [s.to[0], s.to[1], s.to[2]];
          continue;
        }
      }
    }
    if (prev && prev.kind === 'arc' && s.kind === 'arc'
      && near(prev.center, s.center) && Math.abs(prev.radius - s.radius) < COALESCE_EPS
      && (prev.plane ?? 'XZ') === (s.plane ?? 'XZ') && (prev.clockwise === true) === (s.clockwise === true)
      && Math.sign(prev.degrees) === Math.sign(s.degrees)) {
      const sigma = (prev.clockwise === true ? -1 : 1) * prev.degrees;
      if (Math.abs(wrapDeg(prev.startAngle + sigma - s.startAngle)) < 1e-6
        && Math.abs(prev.degrees + s.degrees) <= 360 + 1e-9) {
        prev.degrees = prev.degrees + s.degrees;
        continue;
      }
    }
    out.push(s);
  }
  return out;
}

// ─── Geometry comparison ─────────────────────────────────────────────────

/** True when two spec lists describe the same curve (length + 33 sampled points within `eps` m). */
export function sameGeometry(a: readonly PathSegmentSpec[], b: readonly PathSegmentSpec[], eps = 1e-6): boolean {
  const la = specListLength(a);
  const lb = specListLength(b);
  if (Math.abs(la - lb) > eps) return false;
  if (a.length === 0 || b.length === 0) return a.length === b.length;
  const pa = parsePathExtras({ segments: cloneSegmentSpecs(a) }, '__a');
  const pb = parsePathExtras({ segments: cloneSegmentSpecs(b) }, '__b');
  if (!pa || !pb) return false;
  const n = 32;
  for (let i = 0; i <= n; i++) {
    const s = (la * i) / n;
    if (pa.getAbsPosition(s).distanceTo(pb.getAbsPosition(s)) > eps) return false;
  }
  return true;
}

/** Arc length of one segment (re-export for the ops module). */
export { segmentLength };

// ─── Ids (P4) ────────────────────────────────────────────────────────────

/** Id prefixes of the network pieces (P4). */
export const PN_PREFIX = Object.freeze({
  straight: 'PN_S',
  curve: 'PN_C',
  junction: 'PN_J',
  stub: 'PN_K',
  mergeZone: 'PN_M',
  block: 'PN_Block_',
});

/**
 * Smallest n >= 1 such that `prefix + n + suffix` is free for every suffix
 * (P4: free over network ids AND node names — the caller passes both in `taken`).
 */
export function nextFreeIndex(prefix: string, taken: ReadonlySet<string>, suffixes: readonly string[] = ['']): number {
  for (let n = 1; ; n++) {
    if (suffixes.every((s) => !taken.has(`${prefix}${n}${s}`))) return n;
  }
}

/** `prefix + n` for the smallest free n (see {@link nextFreeIndex}). */
export function nextFreeId(prefix: string, taken: ReadonlySet<string>): string {
  return `${prefix}${nextFreeIndex(prefix, taken)}`;
}
