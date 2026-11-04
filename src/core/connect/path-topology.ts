// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * path-topology.ts — the path network's topology, derived from geometry and
 * compared with the authored `successors` (plan-633 Phase 4).
 *
 * Three functions, one contract (shared with plan-628 P5):
 *
 *   - {@link pairPathEnds} — EVERY directed neighbourhood END(A) → START(B)
 *     within {@link PATH_LINK_TOLERANCE} (5 mm, travel tangents ≤ 2°). NOT
 *     exclusive: a branch (A → B, A → C) and a merge (B → D, C → D) are all
 *     reported, and the result does not depend on the order of the paths.
 *     Never START/START or END/END, never a path onto itself. It reads the
 *     network directly (`getPathEndpoints`) — the exclusive snap pairing of
 *     the planner is for placements only (Gate R1 #1).
 *   - {@link diffSuccessors} — per path: geometric links that are not declared
 *     (missing), declared links without geometry (extra) and declared links
 *     whose geometry runs the other way (reversed). Paths opted out with
 *     `rv_extras.Path.connectCheck: false` are skipped in both directions.
 *   - {@link applySuccessorLink} — the write seam: the node's extras plus the
 *     re-registration in the network (`RVPathComponent.reapplyConfig()`), and
 *     an awaitable `setField` op when an edit target is available. The
 *     `readonly successorIds` array of an `RVPath` is never mutated — a fresh
 *     path replaces it.
 *
 * Pure apart from {@link applySuccessorLink}; nothing here runs in the tick.
 */

import type { Object3D } from 'three';
import { getPathEndpoints, RVPathComponent, type RVPath, type PathEndpoint } from '../engine/rv-path';
import type { RVPathNetwork } from '../engine/rv-path-network';
import { getComponentInstances } from '../engine/rv-component-registry';
import type { EditTarget } from '../hmi/rv-edit-target';
import type { AABB } from '../engine/rv-aabb';
import { SpatialGridXZ } from '../engine/rv-spatial-grid';
import {
  PATH_END_NEAR_MISS_M,
  PATH_LINK_BOUND_EPS,
  PATH_LINK_TOLERANCE,
  isPathLink,
  tangentAngleDeg,
} from './path-link-tolerance';

/** One geometric link END(from) → START(to). */
export interface PathLinkPair {
  readonly from: string;
  readonly to: string;
  /** END → START distance in metres. */
  readonly distance: number;
  /** Angle between the END tangent of `from` and the START tangent of `to`, degrees. */
  readonly angleDeg: number;
}

/** END(from) → START(to) closer than the near-miss bound but outside the link tolerance. */
export interface PathNearMiss {
  readonly from: string;
  readonly to: string;
  readonly distance: number;
}

/** Everything {@link analysePathEnds} found. */
export interface PathEndAnalysis {
  readonly links: readonly PathLinkPair[];
  readonly nearMisses: readonly PathNearMiss[];
}

/** One finding of {@link analysePathEnd}: a link or a near miss touching the asked end. */
export type PathEndFinding =
  | ({ readonly kind: 'link' } & PathLinkPair)
  | ({ readonly kind: 'near-miss' } & PathNearMiss);

/** Options of {@link analysePathEnd}. */
export interface AnalysePathEndOptions {
  /** Link tolerance. Default {@link PATH_LINK_TOLERANCE}. */
  readonly tol?: Readonly<{ distM: number; tangentDeg: number }>;
}

/** Per-path difference between geometry and the authored `successors`. */
export interface SuccessorDiff {
  readonly pathId: string;
  /** Geometric links END(path) → START(x) that `successors` does not name. */
  readonly missing: readonly string[];
  /** Declared successors without a geometric link in either direction. */
  readonly extra: readonly string[];
  /** Declared successors whose geometric link runs the other way (x → path). */
  readonly reversed: readonly string[];
  /** Declared successor ids that name no registered path. */
  readonly unknown: readonly string[];
}

type Tolerance = Readonly<{ distM: number; tangentDeg: number }>;

/** Paths of a network or a plain list, sorted by id (order-independent results). */
function sortedPaths(source: RVPathNetwork | readonly RVPath[]): RVPath[] {
  const list = Array.isArray(source) ? [...source] : (source as RVPathNetwork).all();
  return list.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

type Ends = { start: PathEndpoint; end: PathEndpoint } | null;

/**
 * The ONE pair rule: END(`fromId`) → START(`toId`) is a link, a near miss or
 * nothing. Shared by {@link analysePathEnds} (grid and fallback) and
 * {@link analysePathEnd}, so every path computes it identically.
 */
function classifyEnds(
  fromId: string,
  a: { position: PathEndpoint['position']; tangent: PathEndpoint['tangent'] },
  toId: string,
  b: { position: PathEndpoint['position']; tangent: PathEndpoint['tangent'] },
  tol: Tolerance,
  links: PathLinkPair[],
  nearMisses: PathNearMiss[],
): void {
  const distance = a.position.distanceTo(b.position);
  if (isPathLink(a.position, a.tangent, b.position, b.tangent, tol)) {
    links.push({ from: fromId, to: toId, distance, angleDeg: tangentAngleDeg(a.tangent, b.tangent) });
  } else if (distance > tol.distM && distance <= PATH_END_NEAR_MISS_M) {
    nearMisses.push({ from: fromId, to: toId, distance });
  }
}

/**
 * Search radius that covers both findings of {@link classifyEnds}: a link
 * (`distance <= distM + PATH_LINK_BOUND_EPS`) and a near miss
 * (`distM < distance <= PATH_END_NEAR_MISS_M`). NaN for a tolerance the grid
 * cannot serve (the caller then takes the O(P²) scan).
 */
function pathEndSearchRadius(tol: Tolerance): number {
  return Math.max(PATH_END_NEAR_MISS_M, tol.distM + PATH_LINK_BOUND_EPS);
}

/** Max |coordinate| / cell size the XZ grid indexes without clamping. */
const GRID_MAX_CELL_COORD = 100_000;

/** A path START as a point box for the grid; `j` = index in the sorted path list. */
interface StartItem { readonly j: number; readonly aabb: AABB }
interface MutableBox { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } }

function pointBox(x: number, y: number, z: number, r: number): MutableBox {
  return { min: { x: x - r, y: y - r, z: z - r }, max: { x: x + r, y: y + r, z: z + r } };
}

/**
 * Geometric links AND near misses of every open path pair, in one pass.
 * Deterministic: sorted by `from`, then `to`, whatever the input order.
 *
 * Candidates come from a {@link SpatialGridXZ} over the path STARTS (plan-644
 * Phase 2.6): inserted in sorted order (`seq` = index), each END queries a box
 * of the search radius (link tolerance or near-miss band, whichever is wider);
 * the seq-sorted hits are visited in the former pair order with the unchanged
 * 3D predicates. Same findings, same order. A tolerance or coordinates the
 * grid cannot serve keep the O(P²) scan.
 */
export function analysePathEnds(
  source: RVPathNetwork | readonly RVPath[],
  tol: Tolerance = PATH_LINK_TOLERANCE,
): PathEndAnalysis {
  const paths = sortedPaths(source);
  const ends: Ends[] = paths.map((p) => getPathEndpoints(p));
  const links: PathLinkPair[] = [];
  const nearMisses: PathNearMiss[] = [];
  const radius = pathEndSearchRadius(tol);
  if (!pathGridApplicable(ends, radius)) {
    for (let i = 0; i < paths.length; i++) {
      const a = ends[i];
      if (!a) continue;
      for (let j = 0; j < paths.length; j++) {
        if (i === j) continue;
        const b = ends[j];
        if (!b) continue;
        classifyEnds(paths[i].id, a.end, paths[j].id, b.start, tol, links, nearMisses);
      }
    }
    return { links, nearMisses };
  }

  const grid = new SpatialGridXZ<StartItem>(radius);
  for (let j = 0; j < paths.length; j++) {
    const b = ends[j];
    if (!b) continue;
    const p = b.start.position;
    grid.insert({ j, aabb: pointBox(p.x, p.y, p.z, 0) as unknown as AABB });
  }
  // Padded query: may only ADD candidates (the 3D predicates filter them).
  const r = radius * (1 + 1e-9) + 1e-12;
  const query = pointBox(0, 0, 0, r);
  const hits: StartItem[] = [];
  for (let i = 0; i < paths.length; i++) {
    const a = ends[i];
    if (!a) continue;
    const p = a.end.position;
    query.min.x = p.x - r; query.min.y = p.y - r; query.min.z = p.z - r;
    query.max.x = p.x + r; query.max.y = p.y + r; query.max.z = p.z + r;
    grid.queryXZ(query as unknown as AABB, hits);
    for (let k = 0; k < hits.length; k++) {
      const j = hits[k].j;   // seq-sorted === ascending j, the former inner loop order
      if (j === i) continue;
      classifyEnds(paths[i].id, a.end, paths[j].id, ends[j]!.start, tol, links, nearMisses);
    }
  }
  return { links, nearMisses };
}

/** The grid serves a finite positive radius and finite ends inside its cell range. */
function pathGridApplicable(ends: readonly Ends[], radius: number): boolean {
  if (!(radius > 0) || !Number.isFinite(radius)) return false;
  const limit = GRID_MAX_CELL_COORD * radius;
  for (const e of ends) {
    if (!e) continue;
    for (const pt of [e.start.position, e.end.position]) {
      if (!(Math.abs(pt.x) < limit) || !(Math.abs(pt.z) < limit) || !Number.isFinite(pt.y)) return false;
    }
  }
  return true;
}

/**
 * The findings of ONE path end (plan-644): with `end === 'end'` every
 * END(`pathId`) → START(x), with `'start'` every END(x) → START(`pathId`) —
 * exactly the subset of {@link analysePathEnds} that touches this end, in the
 * same order (by the other path's id), links and near misses interleaved in
 * that order and tagged by `kind`. O(P) instead of O(P²) for a handle drag.
 * Empty when the path is unknown, closed or has no segments.
 */
export function analysePathEnd(
  source: RVPathNetwork | readonly RVPath[],
  pathId: string,
  end: 'start' | 'end',
  opts: AnalysePathEndOptions = {},
): PathEndFinding[] {
  const tol = opts.tol ?? PATH_LINK_TOLERANCE;
  const paths = sortedPaths(source);
  const self = paths.find((p) => p.id === pathId);
  const own = self ? getPathEndpoints(self) : null;
  const out: PathEndFinding[] = [];
  if (!self || !own) return out;
  const links: PathLinkPair[] = [];
  const nearMisses: PathNearMiss[] = [];
  for (const other of paths) {
    if (other === self) continue;
    const e = getPathEndpoints(other);
    if (!e) continue;
    links.length = 0;
    nearMisses.length = 0;
    if (end === 'end') classifyEnds(pathId, own.end, other.id, e.start, tol, links, nearMisses);
    else classifyEnds(other.id, e.end, pathId, own.start, tol, links, nearMisses);
    if (links.length) out.push({ kind: 'link', ...links[0] });
    else if (nearMisses.length) out.push({ kind: 'near-miss', ...nearMisses[0] });
  }
  return out;
}

/**
 * ALL directed links END(A) → START(B) within `tol` (default
 * {@link PATH_LINK_TOLERANCE}). Branches and merges are complete, the order of
 * the input is irrelevant. This is the plan-628 P5 contract.
 */
export function pairPathEnds(
  source: RVPathNetwork | readonly RVPath[],
  tol: Tolerance = PATH_LINK_TOLERANCE,
): PathLinkPair[] {
  return analysePathEnds(source, tol).links as PathLinkPair[];
}

/**
 * Compare the authored `successors` with the geometric `pairs` (from
 * {@link pairPathEnds}). Returns only paths with at least one finding, sorted
 * by id. A link that runs the wrong way is reported ONCE, as `reversed` on the
 * path that declares it — not again as `missing` on the other side.
 *
 * Opt-out: a path with `connectCheck === false` is left out in both
 * directions — its own successors are not checked, and links to or from it
 * are neither expected nor reported.
 */
export function diffSuccessors(
  source: RVPathNetwork | readonly RVPath[],
  pairs: readonly PathLinkPair[],
): SuccessorDiff[] {
  const paths = sortedPaths(source);
  const byId = new Map<string, RVPath>();
  for (const p of paths) byId.set(p.id, p);
  const optedOut = (id: string): boolean => byId.get(id)?.connectCheck === false;

  const geometric = new Set<string>();
  for (const { from, to } of pairs) geometric.add(`${from}\u0000${to}`);
  const declared = new Set<string>();
  for (const p of paths) for (const s of p.successorIds) declared.add(`${p.id}\u0000${s}`);

  const out: SuccessorDiff[] = [];
  for (const p of paths) {
    if (optedOut(p.id)) continue;
    const missing: string[] = [];
    const extra: string[] = [];
    const reversed: string[] = [];
    const unknown: string[] = [];
    // Declared side — in authored order, duplicates collapsed.
    const seen = new Set<string>();
    for (const s of p.successorIds) {
      if (seen.has(s)) continue;
      seen.add(s);
      if (!byId.has(s)) { unknown.push(s); continue; }
      if (optedOut(s)) continue;
      if (geometric.has(`${p.id}\u0000${s}`)) continue;
      if (geometric.has(`${s}\u0000${p.id}`)) reversed.push(s);
      else extra.push(s);
    }
    // Geometric side — sorted by target id (pairs are sorted already).
    for (const { from, to } of pairs) {
      if (from !== p.id || optedOut(to)) continue;
      if (declared.has(`${from}\u0000${to}`)) continue;
      // Reported as `reversed` on `to` — once is enough.
      if (declared.has(`${to}\u0000${from}`)) continue;
      missing.push(to);
    }
    if (missing.length + extra.length + reversed.length + unknown.length > 0) {
      out.push({ pathId: p.id, missing, extra, reversed, unknown });
    }
  }
  return out;
}

// ─── Write seam ─────────────────────────────────────────────────────────

/** The node of a path as the write seam needs it. */
export type PathNodeLike = Pick<Object3D, 'userData'>;

/** One `successors` write: the path, its node, its document path and both lists. */
export interface SuccessorWrite {
  readonly pathId: string;
  readonly node: PathNodeLike;
  /** Document node path for the op — null = runtime only (tests / pre-boot). */
  readonly nodePath: string | null;
  readonly prev: readonly string[];
  readonly next: readonly string[];
}

/**
 * The successor list of `path` after adding (`'add'`) or removing (`'remove'`)
 * `toId` — null when nothing changes. Order is kept; an added id is appended.
 */
export function planSuccessorChange(
  path: RVPath,
  toId: string,
  op: 'add' | 'remove',
): { prev: string[]; next: string[] } | null {
  const prev = [...path.successorIds];
  if (op === 'add') {
    if (prev.includes(toId)) return null;
    return { prev, next: [...prev, toId] };
  }
  if (!prev.includes(toId)) return null;
  return { prev, next: prev.filter((s) => s !== toId) };
}

/**
 * Fold several successor changes of ONE path in order (plan-644, the list form
 * of {@link planSuccessorChange}, whose single signature stays): an `add` of an
 * id already present and a `remove` of an id not present are skipped, every
 * other op is applied to the running list. `applied[k]` tells whether `ops[k]`
 * changed the list. Null when no op changed anything.
 */
export function planSuccessorChanges(
  path: RVPath,
  ops: ReadonlyArray<{ toId: string; op: 'add' | 'remove' }>,
): { prev: string[]; next: string[]; applied: boolean[] } | null {
  const prev = [...path.successorIds];
  let next = [...prev];
  const applied: boolean[] = [];
  let any = false;
  for (const { toId, op } of ops) {
    const has = next.includes(toId);
    if (op === 'add' ? has : !has) { applied.push(false); continue; }
    next = op === 'add' ? [...next, toId] : next.filter((s) => s !== toId);
    applied.push(true);
    any = true;
  }
  return any ? { prev, next, applied } : null;
}

/** Write `ids` into `rv_extras.Path.successors` of `node` and re-register the path. */
export function writeSuccessorsRuntime(node: PathNodeLike, ids: readonly string[]): void {
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
  payload['successors'] = [...ids];
  // Re-registration: a FRESH RVPath replaces the old one in the network.
  for (const inst of getComponentInstances(node as Object3D)) {
    if (inst instanceof RVPathComponent) inst.reapplyConfig();
  }
}

/**
 * Apply one successor write: runtime extras + network re-registration first
 * (the network sees it at once), then — when `target` is available and the
 * node has a document path — the durable, undoable `setField` op. Inside an
 * open transaction of `target` the op joins it, so a caller that also writes
 * `segments` gets ONE undo step.
 *
 * On a failed op the runtime write is reverted before the error propagates:
 * nothing stays half written.
 */
export async function applySuccessorLink(
  write: SuccessorWrite,
  target: EditTarget | null = null,
): Promise<void> {
  writeSuccessorsRuntime(write.node, write.next);
  if (!target || !target.available || !write.nodePath) return;
  try {
    if (target.setFieldAsync) {
      await target.setFieldAsync(write.nodePath, 'Path', 'successors', [...write.next], [...write.prev]);
    } else {
      target.setField(write.nodePath, 'Path', 'successors', [...write.next], [...write.prev]);
    }
  } catch (e) {
    writeSuccessorsRuntime(write.node, write.prev);
    throw e;
  }
}
