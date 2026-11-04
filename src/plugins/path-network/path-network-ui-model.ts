// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * path-network-ui-model — the pure geometry of the path-network planner UI
 * (plan-628 Phase 5). No Three.js scene, no DOM: the interaction controller
 * feeds pointer points in and turns the answers into `layout.path.*` command
 * arguments and preview lines. Everything here is what the tests pin.
 *
 * - catalog: the built-in "Path Network" entries (P1) and their block specs
 * - ghost:   free pose or tangent-true snap onto a free path end (P5, M5 — no
 *            cardinal rounding, the block takes the port tangent exactly)
 * - project: closest point on a spec list (junction tool, junction slide)
 * - rotate:  15° raster for the block gizmo, Shift = free
 * - picker:  the "Path blocks" section of the snap picker (plan-628 8.4)
 * - library: the built-in path-block library entries (plan-628 8.1)
 * - drop:    chain-drag drop targets + tangent-true re-snap (plan-628 8.8)
 * - click:   click layout from a free end + typed dimensions (plan-628 8.11b/c)
 */

import type { PathSegmentSpec } from '../../core/engine/rv-path';
import type { Vec3Tuple } from '../../core/engine/rv-path-edit';
import type { LibraryCatalogEntry } from '../../core/library/library-types';
import type { NetworkInput } from '../../core/engine/rv-path-network-ops';
import { parsePathExtras } from '../../core/engine/rv-path';
import { cloneSegmentSpecs, specListLength } from '../../core/engine/rv-path-edit';
import {
  applyRigidToPoint,
  blockSpecs,
  directionOf,
  endFollowMotion,
  headingOf,
  MERGE_OUT_M,
  MERGE_PRE_FALLBACK_M,
  type RigidXZ,
  placedTemplate,
  poseForPort,
  resolveBlockParams,
  specEnds,
  transformSpecs,
  wrapDeg,
  type BlockPose,
  type PathBlockKind,
  type PathBlockSpec,
  type PortPose,
} from '../../core/engine/rv-path-blocks';

// ─── Catalog ─────────────────────────────────────────────────────────────

/** One entry of the built-in "Path Network" catalog. */
export interface PathCatalogEntry {
  /** Stable id (`straight-2`, `curve-90-l`, …). */
  readonly id: string;
  readonly label: string;
  readonly spec: PathBlockSpec;
}

/** The catalog of plan §3.1 (stub with dock is plan-636; a plain stub is offered). */
export const PATH_CATALOG: readonly PathCatalogEntry[] = Object.freeze([
  { id: 'straight-2', label: 'Straight 2 m', spec: { kind: 'straight', lengthM: 2 } },
  { id: 'straight-1', label: 'Straight 1 m', spec: { kind: 'straight', lengthM: 1 } },
  { id: 'curve-90-l', label: 'Curve 90° left', spec: { kind: 'curve', degrees: 90, side: 'left' } },
  { id: 'curve-90-r', label: 'Curve 90° right', spec: { kind: 'curve', degrees: 90, side: 'right' } },
  { id: 'curve-45-l', label: 'Curve 45° left', spec: { kind: 'curve', degrees: 45, side: 'left' } },
  { id: 'curve-45-r', label: 'Curve 45° right', spec: { kind: 'curve', degrees: 45, side: 'right' } },
  { id: 'diverge', label: 'Diverge', spec: { kind: 'diverge' } },
  { id: 'merge', label: 'Merge', spec: { kind: 'merge' } },
  { id: 'stub', label: 'Stub', spec: { kind: 'stub' } },
] as PathCatalogEntry[]);

/** True for entries that are set ONTO a path (junction tool) instead of at an end. */
export function isJunctionEntry(spec: PathBlockSpec): boolean {
  return spec.kind === 'diverge' || spec.kind === 'merge' || spec.kind === 'stub';
}

// ─── Ghost ───────────────────────────────────────────────────────────────

/** Snap radius (m) of the ghost onto a free path end — 447 F4. */
export const GHOST_SNAP_RADIUS_M = 0.35;

/**
 * A free path end as `layout.path.list` reports it — or (plan-628 8.3) a free
 * `path`-typed port of a placement (`snapId` set, `pathId` empty), which the
 * snap plugin lists in the same shape (`listPathPlacementPorts`).
 */
export interface FreePort {
  readonly pathId: string;
  readonly end: 'start' | 'end';
  readonly position: readonly number[];
  readonly headingDeg: number;
  /** plan-628 8.3: id of the placement snap this port is (absent = a path end). */
  readonly snapId?: string;
}

/** Where a straight/curve ghost sits and how it would be placed. */
export type GhostPlacement =
  | { readonly mode: 'port'; readonly port: FreePort; readonly pose?: BlockPose; readonly y?: number; readonly specs: PathSegmentSpec[] }
  | { readonly mode: 'free'; readonly pose: BlockPose; readonly y: number; readonly specs: PathSegmentSpec[] };

/** The free end within `radius` (XZ distance) of `point`, nearest first. */
export function nearestFreePort(ports: readonly FreePort[], point: Vec3Tuple, radius = GHOST_SNAP_RADIUS_M): FreePort | null {
  let best: FreePort | null = null;
  let bestD = radius;
  for (const p of ports) {
    const d = Math.hypot(p.position[0] - point[0], p.position[2] - point[2]);
    if (d <= bestD) { best = p; bestD = d; }
  }
  return best;
}

function portPose(p: FreePort): PortPose {
  const h = p.headingDeg * Math.PI / 180;
  return { position: [p.position[0], p.position[1] ?? 0, p.position[2]], tangent: [Math.cos(h), 0, Math.sin(h)] };
}

/**
 * The ghost of a straight/curve block: snapped tangent-true onto the nearest
 * free end, else free at `point` with `headingDeg`. At an `end` port the block
 * STARTS there; at a `start` port it ENDS there (built backwards).
 */
export function ghostPlacement(
  spec: PathBlockSpec,
  point: Vec3Tuple,
  headingDeg: number,
  ports: readonly FreePort[],
  radius = GHOST_SNAP_RADIUS_M,
): GhostPlacement | null {
  const local = blockSpecs(spec);
  const ends = specEnds(local);
  if (!ends) return null;
  const port = nearestFreePort(ports, point, radius);
  if (port) {
    const pp = portPose(port);
    const anchor = port.end === 'end' ? ends.start : ends.end;
    const pose = poseForPort(pp, anchor.position, headingOf(anchor.tangent));
    return { mode: 'port', port, pose, y: pp.position[1], specs: transformSpecs(local, pose, pp.position[1]) };
  }
  const pose: BlockPose = [point[0], point[2], wrapDeg(headingDeg)];
  return { mode: 'free', pose, y: point[1], specs: transformSpecs(local, pose, point[1]) };
}

/** `layout.path.place` arguments for a ghost placement. */
export function placeArgsFor(spec: PathBlockSpec, g: GhostPlacement): Record<string, unknown> {
  const base: Record<string, unknown> = { block: spec.kind };
  if (spec.lengthM !== undefined) base.lengthM = spec.lengthM;
  if (spec.radiusM !== undefined) base.radiusM = spec.radiusM;
  if (spec.degrees !== undefined) base.degrees = spec.degrees;
  if (spec.side !== undefined) base.side = spec.side;
  // A path end links through the command (auto-link, successors); a placement
  // port is not a path, so the block goes to the exact tangent-true FREE pose.
  if (g.mode === 'port' && (!g.port.snapId || !g.pose)) return { ...base, atPath: g.port.pathId, atEnd: g.port.end };
  const pose = g.pose!;
  return { ...base, x: round4(pose[0]), z: round4(pose[1]), y: round4(g.y ?? 0), headingDeg: round4(pose[2]) };
}

/** The free end of a selection to append to ("weiterbauen", §3.3): the `end` of the last path first. */
export function appendPortFor(ports: readonly FreePort[], pathIds: readonly string[]): FreePort | null {
  const own = new Set(pathIds);
  return ports.find((p) => own.has(p.pathId) && p.end === 'end')
    ?? ports.find((p) => own.has(p.pathId) && p.end === 'start')
    ?? null;
}

// ─── Projection ──────────────────────────────────────────────────────────

/** Closest point of a spec list to a world point (XZ distance). */
export interface PathProjection {
  /** Arc length in meters. */
  readonly s: number;
  /** XZ distance in meters from the point to the line. */
  readonly distance: number;
  readonly position: Vec3Tuple;
  readonly tangent: Vec3Tuple;
  /** Side of the point relative to travel (E3: left = up × f). */
  readonly side: 'left' | 'right';
  readonly length: number;
}

/** A spec list prepared for repeated projection (built once per hover target). */
export interface ProjectableLine {
  readonly length: number;
  project(point: Vec3Tuple): PathProjection | null;
}

/** Sampling step (m) of the coarse pass; refined by a golden-section search. */
const PROJECT_STEP_M = 0.05;

export function projectableLine(specs: readonly PathSegmentSpec[]): ProjectableLine | null {
  if (specs.length === 0) return null;
  const path = parsePathExtras({ segments: cloneSegmentSpecs(specs) }, '__project');
  if (!path || !(path.length > 0)) return null;
  const L = path.length;
  const d2 = (s: number, p: Vec3Tuple): number => {
    const q = path.getAbsPosition(s);
    return (q.x - p[0]) ** 2 + (q.z - p[2]) ** 2;
  };
  return {
    length: L,
    project(point: Vec3Tuple): PathProjection | null {
      const n = Math.max(2, Math.ceil(L / PROJECT_STEP_M));
      let bi = 0;
      let bd = Infinity;
      for (let i = 0; i <= n; i++) {
        const v = d2((L * i) / n, point);
        if (v < bd) { bd = v; bi = i; }
      }
      let a = (L * Math.max(0, bi - 1)) / n;
      let b = (L * Math.min(n, bi + 1)) / n;
      const g = (Math.sqrt(5) - 1) / 2;
      for (let k = 0; k < 30; k++) {
        const c = b - g * (b - a);
        const d = a + g * (b - a);
        if (d2(c, point) < d2(d, point)) b = d; else a = c;
      }
      const s = (a + b) / 2;
      const q = path.getAbsPosition(s);
      const t = path.getAbsDirection(s);
      // E3: left of travel f = up × f = (f.z, 0, −f.x).
      const lx = t.z;
      const lz = -t.x;
      const side = (point[0] - q.x) * lx + (point[2] - q.z) * lz >= 0 ? 'left' : 'right';
      return {
        s,
        distance: Math.sqrt(d2(s, point)),
        position: [q.x, q.y, q.z],
        tangent: [t.x, t.y, t.z],
        side,
        length: L,
      };
    },
  };
}

/** Preview of a junction at a projection (branch pieces of the template, world frame). */
export function junctionPreview(spec: PathBlockSpec, at: PathProjection, side: 'left' | 'right'): PathSegmentSpec[] {
  const pose: BlockPose = [at.position[0], at.position[2], headingOf(at.tangent)];
  return placedTemplate({ ...spec, side }, pose, at.position[1]).flatMap((p) => p.specs);
}

// ─── Gizmo ───────────────────────────────────────────────────────────────

/** Rotation raster of the block gizmo (degrees). */
export const ROTATE_STEP_DEG = 15;

/** plan-628 8.9c: `R` / the context menu turn a SELECTED block by this much (Shift+R the other way). */
export const ROTATE_SELECTED_STEP_DEG = 90;

/** Refusal hint while the simulation runs (plan §3.3) — toolbar tooltip, toast, context menu. */
export const PATH_NETWORK_LOCKED_HINT = 'Stop the simulation to edit the path network';

/** Round an angle to the 15° raster unless `free`. */
export function snapAngle(deg: number, free: boolean, step = ROTATE_STEP_DEG): number {
  return free ? deg : Math.round(deg / step) * step;
}

/** Signed heading change (degrees) from pivot→a to pivot→b in the XZ plane. */
export function headingDelta(pivot: readonly [number, number], a: Vec3Tuple, b: Vec3Tuple): number {
  const h0 = Math.atan2(a[2] - pivot[1], a[0] - pivot[0]);
  const h1 = Math.atan2(b[2] - pivot[1], b[0] - pivot[0]);
  return wrapDeg((h1 - h0) * 180 / Math.PI);
}

/** Kinds that the block gizmo moves freely (junctions slide along the host). */
export function isFreeMovable(kind: PathBlockKind): boolean {
  return kind === 'straight' || kind === 'curve';
}

function round4(v: number): number {
  return Math.round(v * 1e4) / 1e4;
}

// ─── Snap picker "Path blocks" (plan-628 8.4) ───────────────────────────

/** The entries of the snap picker's "Path blocks" section (G3), in display order. */
export const PATH_PICKER_ENTRY_IDS: readonly string[] = Object.freeze(['straight-2', 'curve-90-l', 'curve-90-r', 'diverge', 'merge', 'stub']);

/** Short picker labels (the section header already says "Path blocks"). */
const PICKER_LABELS: Readonly<Record<string, string>> = Object.freeze({
  'straight-2': 'Straight', 'curve-90-l': 'Curve L', 'curve-90-r': 'Curve R', diverge: 'Branch', merge: 'Merge', stub: 'Stub',
});

/** One entry of the picker's path-block section. */
export interface PathPickerEntry {
  readonly id: string;
  readonly label: string;
  readonly spec: PathBlockSpec;
}

/** The picker's path-block entries (catalog specs, short labels). */
export function pathPickerEntries(): PathPickerEntry[] {
  return PATH_PICKER_ENTRY_IDS.map((id) => {
    const e = PATH_CATALOG.find((c) => c.id === id)!;
    return { id, label: PICKER_LABELS[id] ?? e.label, spec: e.spec };
  });
}

/** Clearance (m) kept between a junction set from a snap and the path end. */
const PICKER_JUNCTION_MARGIN_M = 0.1;

/**
 * Arc length (m) at which a junction chosen at a path-end snap sits on that
 * path: a diverge in the middle, a merge / stub as close to the clicked end as
 * lead-in (fallback 1.8 m) and run-out (0.6 m) allow. The command still checks
 * the host (`host-too-short` is its refusal, shown in the picker).
 */
export function junctionSFromSnap(kind: PathBlockKind, end: 'start' | 'end', lengthM: number): number {
  if (kind === 'diverge') return round4(lengthM / 2);
  if (end === 'end') return round4(Math.max(0, lengthM - MERGE_OUT_M - PICKER_JUNCTION_MARGIN_M));
  return round4(Math.min(lengthM, MERGE_PRE_FALLBACK_M + PICKER_JUNCTION_MARGIN_M));
}

/** Parse a path-end snap id (`path-snap:<pathId>:<start|end>`); null for any other snap. */
export function parsePathSnapId(snapId: string): { pathId: string; end: 'start' | 'end' } | null {
  const prefix = 'path-snap:';
  if (!snapId.startsWith(prefix)) return null;
  const rest = snapId.slice(prefix.length);
  const i = rest.lastIndexOf(':');
  if (i <= 0) return null;
  const end = rest.slice(i + 1);
  if (end !== 'start' && end !== 'end') return null;
  return { pathId: rest.slice(0, i), end };
}

/**
 * The command that places picker entry `spec` at a free snap: straight/curve
 * through `layout.path.place` at the port (a path end links through the
 * command, a placement port gets the tangent-true free pose); a junction
 * through `layout.path.junction` on the path the snap sits on (null at a
 * placement port, which has no path).
 */
export function pickerCommandFor(
  spec: PathBlockSpec,
  port: FreePort,
  pathSpecs: readonly PathSegmentSpec[] | null,
): { id: 'layout.path.place' | 'layout.path.junction'; args: Record<string, unknown> } | null {
  if (isJunctionEntry(spec)) {
    if (!port.pathId || !pathSpecs) return null;
    const s = junctionSFromSnap(spec.kind, port.end, specListLength(pathSpecs));
    const args: Record<string, unknown> = { kind: spec.kind, pathId: port.pathId, s };
    if (spec.side) args.side = spec.side;
    return { id: 'layout.path.junction', args };
  }
  const g = ghostPlacement(spec, [port.position[0], port.position[1] ?? 0, port.position[2]], 0, [port], Number.POSITIVE_INFINITY);
  if (!g) return null;
  return { id: 'layout.path.place', args: placeArgsFor(spec, g) };
}

// ─── Library entries (plan-628 8.1) ──────────────────────────────────────

/** Key of the built-in path-block catalog in the planner library. */
export const PATH_LIBRARY_CATALOG_KEY = 'path-blocks';

/** Prefix of every built-in path-block library entry id. */
export const PATH_LIBRARY_ID_PREFIX = 'path-block:';

/** The five kinds of the library (G8): one entry each, the catalog defaults. */
const LIBRARY_CATALOG_IDS: readonly string[] = Object.freeze(['straight-2', 'curve-90-l', 'diverge', 'merge', 'stub']);

/** Inline-SVG thumbnail of a block (accent stroke on transparent, like the toolbar thumbnails). */
export function pathBlockThumbnailSvg(spec: PathBlockSpec): string {
  let d = '';
  switch (spec.kind) {
    case 'straight': d = 'M4 16 H28'; break;
    case 'curve': d = (spec.degrees ?? 90) <= 45 ? 'M4 22 H12 Q20 22 25 14' : 'M4 26 H10 Q24 26 24 6'; break;
    case 'diverge': d = 'M4 22 H28 M10 22 Q22 22 24 8'; break;
    case 'merge': d = 'M4 22 H28 M8 8 Q10 22 22 22'; break;
    case 'stub': d = 'M4 24 H28 M16 4 V14 Q16 24 24 24'; break;
  }
  const flip = spec.side === 'right' ? ' transform="translate(0 32) scale(1 -1)"' : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 32 32"><g${flip}><path d="${d}" fill="none" stroke="#4fc3f7" stroke-width="2.2" stroke-linecap="round"/></g></svg>`;
}

/** The built-in path-block library entries — a second entry into `layout.path.place` / `layout.path.junction` (E31 supersedes E27). */
export function pathBlockLibraryEntries(): LibraryCatalogEntry[] {
  return LIBRARY_CATALOG_IDS.map((id) => {
    const e = PATH_CATALOG.find((c) => c.id === id)!;
    const { kind, ...params } = e.spec;
    return {
      id: `${PATH_LIBRARY_ID_PREFIX}${id}`,
      name: kind === 'curve' ? 'Curve 90°' : e.label,
      category: 'des',
      glbUrl: '',
      thumbnailUrl: `data:image/svg+xml;utf8,${encodeURIComponent(pathBlockThumbnailSvg(e.spec))}`,
      tags: ['path', 'path-network', kind],
      noPrefetch: true,
      pathBlock: { kind, params: { ...params } },
    };
  });
}

/**
 * The tool entry a library `pathBlock` arms: the built-in catalog entry with an
 * equal spec, else a transient entry (`lib:<kind>:<params>`) for a foreign
 * catalog's parameters. Null for an unknown kind.
 */
export function catalogEntryForPathBlock(pb: { kind: string; params?: Readonly<Record<string, unknown>> }): PathCatalogEntry | null {
  const kinds: readonly string[] = ['straight', 'curve', 'diverge', 'merge', 'stub'];
  if (!kinds.includes(pb.kind)) return null;
  const spec: PathBlockSpec = { kind: pb.kind as PathBlockKind };
  const p = pb.params ?? {};
  if (typeof p.lengthM === 'number') spec.lengthM = p.lengthM;
  if (typeof p.radiusM === 'number') spec.radiusM = p.radiusM;
  if (typeof p.degrees === 'number') spec.degrees = p.degrees;
  if (p.side === 'left' || p.side === 'right') spec.side = p.side;
  if (p.twin === true) spec.twin = true;
  if (typeof p.stubStraightM === 'number') spec.stubStraightM = p.stubStraightM;
  const same = PATH_CATALOG.find((c) => JSON.stringify(c.spec) === JSON.stringify(spec));
  if (same) return same;
  const { kind, ...rest } = spec;
  return { id: `lib:${kind}:${JSON.stringify(rest)}`, label: kind, spec };
}

// ─── Chain drag: drop targets + re-snap (plan-628 8.8) ──────────────────

/**
 * A free end of the MOVING set (start without a predecessor inside the set,
 * end without a successor inside it) — after the P6 release these are the ends
 * that can re-snap on drop.
 */
export interface MovingEnd {
  readonly pathId: string;
  readonly end: 'start' | 'end';
  readonly position: Vec3Tuple;
  readonly headingDeg: number;
}

/** Free ends of the moving paths `moving` (pure, from the snapshot). */
export function movingFreeEnds(net: NetworkInput, moving: ReadonlySet<string>): MovingEnd[] {
  const hasPredInside = new Set<string>();
  for (const p of net.paths) {
    if (!moving.has(p.id)) continue;
    for (const s of p.successors) if (moving.has(s)) hasPredInside.add(s);
  }
  const out: MovingEnd[] = [];
  for (const p of net.paths) {
    if (!moving.has(p.id) || p.closed) continue;
    const ends = specEnds(p.segments);
    if (!ends) continue;
    if (!hasPredInside.has(p.id)) out.push({ pathId: p.id, end: 'start', position: ends.start.position, headingDeg: headingOf(ends.start.tangent) });
    if (!p.successors.some((s) => moving.has(s))) out.push({ pathId: p.id, end: 'end', position: ends.end.position, headingDeg: headingOf(ends.end.tangent) });
  }
  return out;
}

/**
 * The ends of the NOT moving paths that are free once the moving set's port
 * edges are released (P6): an END whose successors all move, a START whose
 * predecessors all move — plus `extra` (free `path`-typed placement ports).
 */
export function dropTargets(net: NetworkInput, moving: ReadonlySet<string>, extra: readonly FreePort[] = []): FreePort[] {
  const preds = new Map<string, string[]>();
  for (const p of net.paths) {
    for (const s of p.successors) {
      const l = preds.get(s);
      if (l) l.push(p.id); else preds.set(s, [p.id]);
    }
  }
  const out: FreePort[] = [];
  for (const p of net.paths) {
    if (moving.has(p.id) || p.closed) continue;
    const ends = specEnds(p.segments);
    if (!ends) continue;
    if (p.successors.every((s) => moving.has(s))) {
      out.push({ pathId: p.id, end: 'end', position: ends.end.position, headingDeg: headingOf(ends.end.tangent) });
    }
    if ((preds.get(p.id) ?? []).every((q) => moving.has(q))) {
      out.push({ pathId: p.id, end: 'start', position: ends.start.position, headingDeg: headingOf(ends.start.tangent) });
    }
  }
  return [...out, ...extra];
}

/** The re-snap of a drop: the corrected rigid motion and the port it snapped to. */
export interface DropSnap {
  readonly motion: RigidXZ;
  readonly target: FreePort;
  readonly movingEnd: MovingEnd;
}

/**
 * plan-628 8.8 (E35): tangent-true re-snap of a dragged set. Applies `motion`
 * to every moving free end; the nearest compatible free port within `radius`
 * (XZ) wins — a moving START mates a target END (or an emitting placement
 * port), a moving END mates a target START (or a consuming one). The answer is
 * the corrected motion (same pivot) that puts that end EXACTLY on the port
 * with the port's travel heading; null when nothing is in reach.
 */
export function dropSnap(
  moving: readonly MovingEnd[],
  targets: readonly FreePort[],
  motion: RigidXZ,
  radius = GHOST_SNAP_RADIUS_M,
): DropSnap | null {
  let best: DropSnap | null = null;
  let bestD = radius;
  for (const m of moving) {
    const p = applyRigidToPoint(m.position, motion);
    for (const t of targets) {
      // A target 'end' port is where a block STARTS, a 'start' port where one ENDS.
      if ((m.end === 'start') !== (t.end === 'end')) continue;
      const d = Math.hypot(p[0] - t.position[0], p[2] - t.position[2]);
      if (d > bestD) continue;
      const dHeadingDeg = wrapDeg(t.headingDeg - m.headingDeg);
      const rotated = applyRigidToPoint(m.position, { dx: 0, dz: 0, dHeadingDeg, pivot: motion.pivot });
      best = {
        motion: { dx: t.position[0] - rotated[0], dz: t.position[2] - rotated[2], dHeadingDeg, pivot: motion.pivot },
        target: t,
        movingEnd: m,
      };
      bestD = d;
    }
  }
  return best;
}

// ─── Click layout (plan-628 8.11b / 8.11c) ──────────────────────────────

/** A click deviating less than this (deg) from the travel direction places a straight. */
export const CLICK_LAYOUT_STRAIGHT_DEG = 5;
/** Length raster (m) of a click-layout straight. */
export const CLICK_LAYOUT_LENGTH_STEP_M = 0.25;
/** Angle raster (deg) of a click-layout curve — the 15° steps contain 45° and 90°. */
export const CLICK_LAYOUT_ANGLE_STEP_DEG = 15;
/** Largest click-layout curve angle (deg). */
export const CLICK_LAYOUT_MAX_DEG = 180;
/** Smallest radius (m) a tangential connection onto a foreign free end may solve to. */
export const CLICK_LAYOUT_MIN_CONNECT_RADIUS_M = 0.5;
/** Screen radius (px) within which hover / click takes a foreign free end as the target. */
export const CLICK_LAYOUT_TARGET_PX = 16;
/** A press-release shorter than this (px) is a click (longer = marquee / orbit). */
export const CLICK_LAYOUT_CLICK_PX = 5;

/** One block a click places (in order, each at the end of the previous one). */
export interface ClickLayoutStep {
  readonly kind: 'straight' | 'curve';
  readonly lengthM?: number;
  readonly radiusM?: number;
  readonly degrees?: number;
  readonly side?: 'left' | 'right';
}

/** What a click at the current pointer would place. */
export interface ClickLayoutPlan {
  readonly steps: readonly ClickLayoutStep[];
  /** World preview of all steps (ghost). */
  readonly specs: PathSegmentSpec[];
  /** The new free end after the steps. */
  readonly end: { readonly position: Vec3Tuple; readonly headingDeg: number };
  /** Set when the plan docks tangent-true onto this foreign free end. */
  readonly target?: FreePort;
  /** Turning side of the curve (absent: a straight only). */
  readonly side?: 'left' | 'right';
}

/** Typed dimensions (8.11c): override the matching part of the plan. */
export interface ClickLayoutTyped {
  readonly lengthM?: number;
  readonly degrees?: number;
}

/** The radius a click-layout curve takes: the library curve entry's (catalog default). */
export function clickLayoutDefaultRadius(): number {
  const curve = pathBlockLibraryEntries().find((e) => e.pathBlock?.kind === 'curve');
  return resolveBlockParams((curve?.pathBlock?.params ?? {}) as Omit<PathBlockSpec, 'kind'>).radiusM;
}

/** The `layout.path.place` arguments of one step attached at the END of `atPath`. */
export function clickStepArgs(step: ClickLayoutStep, atPath: string): Record<string, unknown> {
  const a: Record<string, unknown> = { block: step.kind, atPath, atEnd: 'end' };
  if (step.lengthM !== undefined) a.lengthM = round4(step.lengthM);
  if (step.radiusM !== undefined) a.radiusM = round4(step.radiusM);
  if (step.degrees !== undefined) a.degrees = round4(step.degrees);
  if (step.side !== undefined) a.side = step.side;
  return a;
}

/** Chain the steps from a port: world specs + the final free end. */
function chainSteps(
  origin: { readonly position: readonly number[]; readonly headingDeg: number },
  steps: readonly ClickLayoutStep[],
): { specs: PathSegmentSpec[]; end: { position: Vec3Tuple; headingDeg: number } } | null {
  let port: PortPose = { position: [origin.position[0], origin.position[1] ?? 0, origin.position[2]], tangent: directionOf(origin.headingDeg) };
  const specs: PathSegmentSpec[] = [];
  for (const st of steps) {
    const spec: PathBlockSpec = { kind: st.kind };
    if (st.lengthM !== undefined) spec.lengthM = st.lengthM;
    if (st.radiusM !== undefined) spec.radiusM = st.radiusM;
    if (st.degrees !== undefined) spec.degrees = st.degrees;
    if (st.side !== undefined) spec.side = st.side;
    const world = transformSpecs(blockSpecs(spec), poseForPort(port), port.position[1]);
    const e = specEnds(world);
    if (!e) return null;
    specs.push(...world);
    port = e.end;
  }
  return { specs, end: { position: port.position, headingDeg: headingOf(port.tangent) } };
}

function planOf(origin: FreePort, steps: ClickLayoutStep[], target?: FreePort): ClickLayoutPlan | null {
  if (steps.length === 0) return null;
  const c = chainSteps(origin, steps);
  if (!c) return null;
  const curve = steps.find((s) => s.kind === 'curve');
  return { steps, specs: c.specs, end: c.end, ...(target ? { target } : {}), ...(curve?.side ? { side: curve.side } : {}) };
}

const snapLen = (v: number): number => Math.max(0, Math.round(v / CLICK_LAYOUT_LENGTH_STEP_M) * CLICK_LAYOUT_LENGTH_STEP_M);

/** Where a point lies in the frame of a port: along travel, and to its left (E3: up × f = (f.z, 0, −f.x)). */
function frameOf(origin: FreePort, point: Vec3Tuple): { along: number; lat: number } {
  const t = directionOf(origin.headingDeg);
  const dx = point[0] - origin.position[0];
  const dz = point[2] - origin.position[2];
  return { along: dx * t[0] + dz * t[2], lat: dx * t[2] - dz * t[0] };
}

/**
 * plan-628 8.11b: what a click on the floor at `point` places at the free END
 * `origin`: a straight when the click deviates less than
 * {@link CLICK_LAYOUT_STRAIGHT_DEG} from the travel direction (length on the
 * 0.25 m raster), else a tangential curve (angle on the 15° raster, radius
 * `radiusM`) plus the straight towards the click. `typed` (8.11c) overrides
 * the straight length and / or the curve angle (angle 0 = no curve).
 */
export function clickLayoutPlan(origin: FreePort, point: Vec3Tuple, radiusM: number, typed: ClickLayoutTyped = {}): ClickLayoutPlan | null {
  const { along, lat } = frameOf(origin, point);
  const side: 'left' | 'right' = lat >= 0 ? 'left' : 'right';
  const devDeg = Math.atan2(lat, along) * 180 / Math.PI;
  const steps: ClickLayoutStep[] = [];
  const straight = (l: number): void => { if (l >= CLICK_LAYOUT_LENGTH_STEP_M / 2) steps.push({ kind: 'straight', lengthM: l }); };
  const straightOnly = along > 0 && Math.abs(devDeg) < CLICK_LAYOUT_STRAIGHT_DEG;
  if (typed.degrees !== undefined) {
    const deg = Math.min(CLICK_LAYOUT_MAX_DEG, Math.abs(typed.degrees));
    if (deg > 1e-6) steps.push({ kind: 'curve', radiusM, degrees: deg, side });
    if (typed.lengthM !== undefined) straight(typed.lengthM);
    if (steps.length === 0) straight(Math.max(CLICK_LAYOUT_LENGTH_STEP_M, snapLen(along)));
    return planOf(origin, steps);
  }
  if (straightOnly) {
    straight(typed.lengthM ?? Math.max(CLICK_LAYOUT_LENGTH_STEP_M, snapLen(along)));
    return planOf(origin, steps);
  }
  // The raster angle whose tangent ray passes closest to the click (ahead of the arc end).
  let best: { deg: number; along: number; score: number } | null = null;
  for (let deg = CLICK_LAYOUT_ANGLE_STEP_DEG; deg <= CLICK_LAYOUT_MAX_DEG + 1e-9; deg += CLICK_LAYOUT_ANGLE_STEP_DEG) {
    const c = chainSteps(origin, [{ kind: 'curve', radiusM, degrees: deg, side }]);
    if (!c) continue;
    const t = directionOf(c.end.headingDeg);
    const wx = point[0] - c.end.position[0];
    const wz = point[2] - c.end.position[2];
    const a = wx * t[0] + wz * t[2];
    const perp = Math.abs(wx * t[2] - wz * t[0]);
    const score = perp + (a < -CLICK_LAYOUT_LENGTH_STEP_M / 2 ? 1e3 - a : 0);
    if (!best || score < best.score - 1e-9) best = { deg, along: a, score };
  }
  if (!best) return null;
  steps.push({ kind: 'curve', radiusM, degrees: best.deg, side });
  straight(typed.lengthM ?? snapLen(best.along));
  return planOf(origin, steps);
}

/**
 * plan-628 8.11b: a tangential connection from the free END `origin` onto the
 * foreign free START (or consuming port) `target` — a straight when both are
 * aligned, else ONE curve plus ONE straight (curve first or straight first,
 * the radius solved exactly; the solution with the radius closest to
 * `radiusM` wins). Null when no such pair exists (e.g. an S-bend, a radius
 * below {@link CLICK_LAYOUT_MIN_CONNECT_RADIUS_M}).
 */
export function clickConnectPlan(origin: FreePort, target: FreePort, radiusM: number): ClickLayoutPlan | null {
  if (target.end !== 'start') return null;
  const hA = origin.headingDeg;
  const theta = wrapDeg(target.headingDeg - hA);
  const tA = directionOf(hA);
  const tB = directionOf(target.headingDeg);
  const dx = target.position[0] - origin.position[0];
  const dz = target.position[2] - origin.position[2];
  const candidates: ClickLayoutStep[][] = [];
  if (Math.abs(theta) < 0.5) {
    const along = dx * tA[0] + dz * tA[2];
    const lat = Math.abs(dx * tA[2] - dz * tA[0]);
    if (along > 1e-3 && lat <= 0.005) candidates.push([{ kind: 'straight', lengthM: along }]);
  } else {
    const deg = Math.abs(theta);
    // Unit-radius arc end in the origin frame, per side; the side whose end heading is theta.
    for (const side of ['left', 'right'] as const) {
      const unit = chainSteps({ position: [0, 0, 0], headingDeg: 0 }, [{ kind: 'curve', radiusM: 1, degrees: deg, side }]);
      if (!unit || Math.abs(wrapDeg(unit.end.headingDeg - theta)) > 0.01) continue;
      const c = Math.cos(hA * Math.PI / 180);
      const s = Math.sin(hA * Math.PI / 180);
      const gx = unit.end.position[0] * c - unit.end.position[2] * s;
      const gz = unit.end.position[0] * s + unit.end.position[2] * c;
      // curve then straight: d = R·g + L·tB
      const det1 = gx * tB[2] - gz * tB[0];
      if (Math.abs(det1) > 1e-9) {
        const R = (dx * tB[2] - dz * tB[0]) / det1;
        const L = (gx * dz - gz * dx) / det1;
        if (R >= CLICK_LAYOUT_MIN_CONNECT_RADIUS_M && L >= -1e-4) {
          const st: ClickLayoutStep[] = [{ kind: 'curve', radiusM: R, degrees: deg, side }];
          if (L > 1e-3) st.push({ kind: 'straight', lengthM: L });
          candidates.push(st);
        }
      }
      // straight then curve: d = L·tA + R·g
      const det2 = tA[0] * gz - tA[2] * gx;
      if (Math.abs(det2) > 1e-9) {
        const L = (dx * gz - dz * gx) / det2;
        const R = (tA[0] * dz - tA[2] * dx) / det2;
        if (R >= CLICK_LAYOUT_MIN_CONNECT_RADIUS_M && L >= -1e-4) {
          const st: ClickLayoutStep[] = [];
          if (L > 1e-3) st.push({ kind: 'straight', lengthM: L });
          st.push({ kind: 'curve', radiusM: R, degrees: deg, side });
          candidates.push(st);
        }
      }
    }
  }
  const radiusOf = (st: ClickLayoutStep[]): number => st.find((x) => x.kind === 'curve')?.radiusM ?? radiusM;
  candidates.sort((a, b) => Math.abs(radiusOf(a) - radiusM) - Math.abs(radiusOf(b) - radiusM));
  for (const st of candidates) {
    const p = planOf(origin, st, target);
    if (!p) continue;
    // Verify: the end lands on the target (<= 1 mm) with its heading (<= 0.1 deg).
    const gap = Math.hypot(p.end.position[0] - target.position[0], p.end.position[2] - target.position[2]);
    if (gap <= 1e-3 && Math.abs(wrapDeg(p.end.headingDeg - target.headingDeg)) <= 0.1) return p;
  }
  return null;
}

/** 8.11c: which field a typed number fills. */
export type TypedField = 'length' | 'angle';

/**
 * 8.11c: parse a typed dimension buffer. A trailing `m` forces the length, a
 * trailing `°` / `d` the angle; otherwise `field` decides. Null when the
 * buffer holds no finite, non-negative number.
 */
export function parseTypedDimension(buffer: string, field: TypedField): { field: TypedField; value: number } | null {
  const raw = buffer.trim().replace(',', '.');
  let f = field;
  let body = raw;
  if (/m$/i.test(body)) { f = 'length'; body = body.slice(0, -1); } else if (/[°d]$/i.test(body)) { f = 'angle'; body = body.slice(0, -1); }
  if (!/^\d*\.?\d+$|^\d+\.$/.test(body)) return null;
  const v = Number(body);
  return Number.isFinite(v) && v >= 0 ? { field: f, value: v } : null;
}

// ─── Length / radius handle (plan-628 8.11d) ────────────────────────────

/** Raster (m) of the length / radius handle; Shift = free. */
export const PARAM_DRAG_STEP_M = 0.25;
/** Shortest straight (m) the length handle can drag to. */
export const PARAM_DRAG_MIN_LENGTH_M = 0.25;
/** Smallest curve radius (m) the radius handle can drag to. */
export const PARAM_DRAG_MIN_RADIUS_M = 0.25;

/** The block data a handle / preview reads (a `PathBlockExtras` subset). */
export interface HandleBlock {
  readonly kind: PathBlockKind;
  readonly params: Omit<PathBlockSpec, 'kind'>;
  readonly pose: BlockPose;
  readonly y?: number;
}

/**
 * The handle of a selected straight (its END, sliding along the travel
 * direction) or curve (its arc MIDPOINT, sliding on the fixed ray from the
 * block start through the midpoint — the midpoint of an arc with the same
 * angle lies on that ray for every radius, at `unit` × radius).
 */
export interface ParamHandle {
  readonly field: 'lengthM' | 'radiusM';
  readonly origin: Vec3Tuple;
  /** Unit direction (XZ) the handle slides along. */
  readonly dir: readonly [number, number];
  /** Distance along `dir` per meter of the parameter. */
  readonly unit: number;
  /** Current parameter value (m). */
  readonly value: number;
  /** Where the handle is drawn (world). */
  readonly position: Vec3Tuple;
}

/** The parameter handle of a straight / curve block (null for junctions or a degenerate curve). */
export function paramHandle(b: HandleBlock): ParamHandle | null {
  const y = b.y ?? 0;
  const p = resolveBlockParams(b.params);
  const origin: Vec3Tuple = [b.pose[0], y, b.pose[1]];
  let dir: [number, number];
  let unit: number;
  let field: ParamHandle['field'];
  let value: number;
  if (b.kind === 'straight') {
    const d = directionOf(b.pose[2]);
    dir = [d[0], d[2]];
    unit = 1;
    field = 'lengthM';
    value = p.lengthM;
  } else if (b.kind === 'curve') {
    // Midpoint of the unit-radius arc = end of the half-angle arc.
    const half = specEnds(placedTemplate({ kind: 'curve', radiusM: 1, degrees: p.degrees / 2, side: p.side }, b.pose, y)[0].specs);
    if (!half) return null;
    const vx = half.end.position[0] - origin[0];
    const vz = half.end.position[2] - origin[2];
    unit = Math.hypot(vx, vz);
    if (unit < 1e-9) return null;
    dir = [vx / unit, vz / unit];
    field = 'radiusM';
    value = p.radiusM;
  } else {
    return null;
  }
  const at = value * unit;
  return { field, origin, dir, unit, value, position: [origin[0] + dir[0] * at, y, origin[2] + dir[1] * at] };
}

/** The parameter a pointer at `point` drags the handle to: 0.25 m raster (`free` = Shift: none), clamped to the minimum. */
export function paramFromPointer(h: ParamHandle, point: Vec3Tuple, free: boolean): number {
  const along = (point[0] - h.origin[0]) * h.dir[0] + (point[2] - h.origin[2]) * h.dir[1];
  const raw = along / h.unit;
  const min = h.field === 'lengthM' ? PARAM_DRAG_MIN_LENGTH_M : PARAM_DRAG_MIN_RADIUS_M;
  const v = free ? raw : Math.round(raw / PARAM_DRAG_STEP_M) * PARAM_DRAG_STEP_M;
  return round4(Math.max(min, v));
}

/**
 * Preview of a parameter drag: the block's new world geometry and the rigid
 * motion its downstream chain follows (old end → new end, `endFollowMotion`).
 */
export function paramDragPreview(b: HandleBlock, field: ParamHandle['field'], value: number): { specs: PathSegmentSpec[]; chain: RigidXZ } | null {
  const line = (params: Omit<PathBlockSpec, 'kind'>): PathSegmentSpec[] => placedTemplate({ ...params, kind: b.kind }, b.pose, b.y ?? 0).flatMap((x) => x.specs);
  const before = specEnds(line(b.params));
  const specs = line({ ...b.params, [field]: value });
  const after = specEnds(specs);
  if (!before || !after) return null;
  return { specs, chain: endFollowMotion(before.end, after.end) };
}

// ─── Replace with … (plan-628 8.11e) ────────────────────────────────────

/** One "Replace with …" choice of the block context menu. */
export interface ReplaceOption {
  readonly id: 'straight' | 'curve-l' | 'curve-r';
  readonly label: string;
  readonly spec: PathBlockSpec;
}

/**
 * The replacements offered for a straight / curve block: Straight, Curve left,
 * Curve right — a straight takes the catalog default (2 m), a curve replacing
 * a straight the catalog curve (90°, library radius), a curve flipping its
 * side keeps radius and angle. The choice equal to the block (same kind, same
 * side) is left out. Junctions: none (they live on their host).
 */
export function replaceOptions(b: { kind: PathBlockKind; params: Omit<PathBlockSpec, 'kind'> }): ReplaceOption[] {
  if (b.kind !== 'straight' && b.kind !== 'curve') return [];
  const straight = PATH_CATALOG.find((e) => e.id === 'straight-2')!.spec;
  const cur = b.kind === 'curve' ? resolveBlockParams(b.params) : null;
  const curve = (side: 'left' | 'right'): PathBlockSpec => (cur
    ? { kind: 'curve', radiusM: cur.radiusM, degrees: cur.degrees, side }
    : { kind: 'curve', radiusM: clickLayoutDefaultRadius(), degrees: 90, side });
  const out: ReplaceOption[] = [];
  if (b.kind !== 'straight') out.push({ id: 'straight', label: 'Straight', spec: { ...straight } });
  if (cur?.side !== 'left') out.push({ id: 'curve-l', label: 'Curve left', spec: curve('left') });
  if (cur?.side !== 'right') out.push({ id: 'curve-r', label: 'Curve right', spec: curve('right') });
  return out;
}

/** The `layout.path.replace` arguments of a replace option (the chain follows, 8.11e / E70). */
export function replaceArgs(blockId: string, spec: PathBlockSpec): Record<string, unknown> {
  const a: Record<string, unknown> = { blockId, block: spec.kind, chain: true };
  if (spec.lengthM !== undefined) a.lengthM = round4(spec.lengthM);
  if (spec.radiusM !== undefined) a.radiusM = round4(spec.radiusM);
  if (spec.degrees !== undefined) a.degrees = round4(spec.degrees);
  if (spec.side !== undefined) a.side = spec.side;
  return a;
}

// ─── Paste (plan-628 8.11f) ─────────────────────────────────────────────

/**
 * Where a paste lands: docked onto `target` (a free END / emitting port — the
 * copy's first free start takes its position AND heading), else free at
 * `cursor` (the anchor moves there, heading and relative layout unchanged).
 */
export function pasteMotion(
  anchor: { readonly position: readonly number[]; readonly headingDeg: number },
  target: FreePort | null,
  cursor: Vec3Tuple,
): RigidXZ {
  const pivot: [number, number] = [anchor.position[0], anchor.position[2]];
  if (target) {
    return {
      pivot,
      dHeadingDeg: wrapDeg(target.headingDeg - anchor.headingDeg),
      dx: target.position[0] - anchor.position[0],
      dz: target.position[2] - anchor.position[2],
    };
  }
  return { pivot, dHeadingDeg: 0, dx: round4(cursor[0] - anchor.position[0]), dz: round4(cursor[2] - anchor.position[2]) };
}
