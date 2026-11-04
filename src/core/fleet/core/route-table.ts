// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * route-table.ts — driving distance from a vehicle to the SERVICE POSITION of
 * a station (plan-559 §2.3, SOL round 2 S2). Pure: works against the small
 * {@link RouteGraph} interface, no Three/DOM. {@link pathNetworkRouteGraph}
 * adapts the engine's `RVPathNetwork` (type-only import).
 *
 * Distance semantics (S2):
 *
 *   distanceM(loc, station) = rest on the current path
 *                           + shortest network way from that path's END to the END of `station.viaPathId`
 *                           + `station.approachM` (END of the via path → service position)
 *
 *  - Location `{ pathId, s, dir }` is an ARC position (meters from the path
 *    start), so two vehicles on the same path at different `s` get different
 *    distances.
 *  - `dir = 1` (forward): rest = `L − s`.
 *  - `dir = −1` (reversing): the vehicle is inside a stub manoeuvre (plan-595:
 *    reverse over the turn piece and the stub chain to the stub START, serve
 *    there, leave FORWARD over the same pieces). rest = `s` (back to the
 *    current piece's start) `+ 2·B` (the chain BELOW the current piece, down to
 *    the stub start and up again) `+ L` (forward out to the current piece's
 *    end). B = 0 on the stub itself. B comes from `loc.stubId` (the reverse
 *    task's destination) when given; without it the table infers the one stub
 *    chain below the piece (a back-walk over single-predecessor /
 *    single-successor pieces ending at a piece without predecessors) and falls
 *    back to B = 0 when that is not unique (e.g. two stubs into one merge
 *    piece). Measured against a real Agv run in
 *    `tests/fleet/fleet-reverse-approach-real.test.ts`.
 *  - The network way follows SUCCESSOR edges only (vehicles cruise forward);
 *    entering a successor costs its full length — the same metric as
 *    `RVPathNetwork.nextHopToward` (plan-921). From the end of a path to the
 *    end of the same path the network way is 0 ("already there").
 *  - Forward approach: `{ viaPathId: destination, approachM: 0 }` — served at
 *    the destination END (Agv task contract).
 *  - Reverse approach (`approach: 'reverse'`, plan-595): forward to the END of
 *    the merge piece (turn), then reverse over the turn piece and the stub
 *    chain to the stub START — {@link reverseApproach} builds that description
 *    from the graph with the same chain rule as the Agv's stub manoeuvre.
 *  - Unknown path, unknown via path, unreachable: `Infinity`.
 *
 * Determinism: shortest distances are unique numbers; the Dijkstra pop order
 * breaks ties by the path's index in the id-sorted path list. {@link nearestOf}
 * breaks distance ties by the candidate id.
 *
 * Allocation: per source path one `Float64Array` of distances, built on its
 * first query and cached until {@link RouteTable.invalidate}; every later
 * query is allocation-free.
 */

import type { RVPathNetwork } from '../../engine/rv-path-network';

/** The graph the route table needs: path ids, lengths (m), forward successors. */
export interface RouteGraph {
  /** All path ids. Order is irrelevant — the table sorts them. */
  pathIds(): readonly string[];
  /** Length of a path in meters (unknown id: NaN or any — never asked). */
  length(pathId: string): number;
  /** Ids of the forward successors (driving continues from the path's END). */
  successors(pathId: string): readonly string[];
  /** Number of predecessors (a merge piece has >= 2). */
  predecessorCount(pathId: string): number;
}

/** Arc position of a vehicle (plan-559 S2; mirrors `AgvHandle.locate`). */
export interface VehicleLocation {
  readonly pathId: string;
  /** Meters from the path START. Clamped into [0, L]. */
  readonly s: number;
  /** 1 = driving forward, −1 = reversing (stub manoeuvre). */
  readonly dir: 1 | -1;
  /**
   * Only for `dir = −1`: the stub the reverse manoeuvre runs into (the task's
   * `destination`). Makes the rest exact on the turn piece when several stubs
   * share it; without it the stub chain is inferred from the graph.
   */
  readonly stubId?: string;
}

/** How a station's service position is reached from the network. */
export interface StationApproach {
  /** The path whose END the network way must reach. */
  readonly viaPathId: string;
  /** Meters from the END of `viaPathId` to the service position (>= 0). */
  readonly approachM: number;
}

/** Forward approach: served at the END of `pathId`. */
export function forwardApproach(pathId: string): StationApproach {
  return { viaPathId: pathId, approachM: 0 };
}

/** Maximal stub chain length walked by {@link reverseApproach} (guards cycles). */
const MAX_CHAIN = 64;

/**
 * Reverse approach to the stub `stubId` (plan-595 chain rule): the chain runs
 * from the stub over single-successor pieces until the next piece has >= 2
 * predecessors — that merge piece is the TURN. The vehicle drives forward to
 * the turn's END, then reverses over the turn and the whole chain to the stub
 * START. Null when there is no such chain (the Agv then approaches forward —
 * the caller decides whether to fall back to {@link forwardApproach}).
 */
export function reverseApproach(graph: RouteGraph, stubId: string): StationApproach | null {
  if (!hasPath(graph, stubId)) return null;
  let chainM = 0;
  let q: string = stubId;
  for (let i = 0; i < MAX_CHAIN; i++) {
    chainM += graph.length(q);
    const succ = graph.successors(q);
    if (succ.length !== 1) return null;
    const nx = succ[0];
    if (!hasPath(graph, nx)) return null;
    if (graph.predecessorCount(nx) >= 2) {
      return { viaPathId: nx, approachM: graph.length(nx) + chainM };
    }
    q = nx;
  }
  return null;
}

function hasPath(graph: RouteGraph, id: string): boolean {
  return graph.pathIds().includes(id);
}

/** Distance table over a {@link RouteGraph} (plan-559 §2.3 `RouteTable`). */
export class RouteTable {
  private ids: string[] = [];
  private readonly index = new Map<string, number>();
  private lengths = new Float64Array(0);
  /** succ[i] = successor indices of path i (dangling ids dropped). */
  private succ: Int32Array[] = [];
  /** pred[i] = predecessor indices of path i (the inverse of `succ`). */
  private pred: Int32Array[] = [];
  /** Cached distances from the END of path i to the END of every path. */
  private readonly fromEnd = new Map<number, Float64Array>();
  private done = new Uint8Array(0);
  private dijkstraRuns = 0;

  constructor(private readonly graph: RouteGraph) {
    this.invalidate();
  }

  /** Re-read the graph (path added/removed/edited) and drop every cached row. */
  invalidate(): void {
    const ids = [...this.graph.pathIds()].sort();
    this.ids = ids;
    this.index.clear();
    for (let i = 0; i < ids.length; i++) this.index.set(ids[i], i);
    this.lengths = new Float64Array(ids.length);
    this.succ = [];
    for (let i = 0; i < ids.length; i++) {
      const L = this.graph.length(ids[i]);
      this.lengths[i] = Number.isFinite(L) && L > 0 ? L : 0;
      const out: number[] = [];
      for (const sid of this.graph.successors(ids[i])) {
        const j = this.index.get(sid);
        if (j !== undefined) out.push(j);
      }
      this.succ.push(Int32Array.from(out));
    }
    const preds: number[][] = ids.map(() => []);
    for (let i = 0; i < ids.length; i++) for (const j of this.succ[i]) preds[j].push(i);
    this.pred = preds.map((p) => Int32Array.from(p));
    this.fromEnd.clear();
    this.done = new Uint8Array(ids.length);
  }

  /** Number of Dijkstra runs so far (deterministic work counter; one per source path). */
  get runs(): number {
    return this.dijkstraRuns;
  }

  /** Shortest network way (m) from the END of `fromPathId` to the END of `toPathId`; Infinity = unreachable. */
  networkM(fromPathId: string, toPathId: string): number {
    const a = this.index.get(fromPathId);
    const b = this.index.get(toPathId);
    if (a === undefined || b === undefined) return Infinity;
    return this.row(a)[b];
  }

  /** Remaining way on the current path before the network way starts (m). */
  restOnPathM(loc: VehicleLocation): number {
    const i = this.index.get(loc.pathId);
    if (i === undefined) return Infinity;
    const L = this.lengths[i];
    const s = Number.isFinite(loc.s) ? Math.min(L, Math.max(0, loc.s)) : 0;
    if (loc.dir !== -1) return L - s;
    return s + 2 * this.chainBelowM(i, loc.stubId) + L;
  }

  /**
   * Length (m) of the stub chain BELOW path i that a reversing vehicle on i
   * still runs down (and back up): the pieces from the stub START up to, not
   * including, i. 0 when i is the stub or no unique chain is found.
   */
  private chainBelowM(i: number, stubId: string | undefined): number {
    const st = stubId === undefined ? undefined : this.index.get(stubId);
    if (st !== undefined) {
      // walk the stub chain upward (single successors) until it reaches i
      let sum = 0;
      for (let q = st, k = 0; k < MAX_CHAIN; k++) {
        if (q === i) return sum;
        sum += this.lengths[q];
        const out = this.succ[q];
        if (out.length !== 1) break;
        q = out[0];
      }
      // stubId does not lead to i — fall through to the inference
    }
    let found = -1;
    let foundM = 0;
    const preds = this.pred[i];
    for (let k = 0; k < preds.length; k++) {
      const m = this.stubChainM(preds[k], i);
      if (m < 0) continue;
      if (found !== -1) return 0; // ambiguous (two stubs into one piece)
      found = preds[k];
      foundM = m;
    }
    return found === -1 ? 0 : foundM;
  }

  /**
   * Length of the chain ending in `top` (whose only successor is `into`) when
   * it is a stub chain: single-successor pieces with one predecessor each,
   * down to a piece without predecessors (the stub). −1 when it is not.
   */
  private stubChainM(top: number, into: number): number {
    let sum = 0;
    let next = into;
    for (let q = top, k = 0; k < MAX_CHAIN; k++) {
      const out = this.succ[q];
      if (out.length !== 1 || out[0] !== next) return -1;
      sum += this.lengths[q];
      const p = this.pred[q];
      if (p.length === 0) return sum;
      if (p.length !== 1) return -1;
      next = q;
      q = p[0];
    }
    return -1;
  }

  /** Driving distance (m) from `loc` to the service position of `station` (S2); Infinity = unreachable. */
  distanceM(loc: VehicleLocation, station: StationApproach): number {
    const rest = this.restOnPathM(loc);
    if (rest === Infinity) return Infinity;
    const net = this.networkM(loc.pathId, station.viaPathId);
    if (net === Infinity) return Infinity;
    return rest + net + Math.max(0, station.approachM);
  }

  /**
   * The candidate with the smallest {@link distanceM}; ties → smallest id
   * (string order). Null when no candidate is reachable.
   */
  nearestOf(
    loc: VehicleLocation,
    candidates: readonly { readonly id: string; readonly approach: StationApproach }[],
  ): { id: string; distanceM: number } | null {
    let bestId: string | null = null;
    let bestD = Infinity;
    for (const c of candidates) {
      const d = this.distanceM(loc, c.approach);
      if (d === Infinity) continue;
      if (bestId === null || d < bestD || (d === bestD && c.id < bestId)) {
        bestId = c.id;
        bestD = d;
      }
    }
    return bestId === null ? null : { id: bestId, distanceM: bestD };
  }

  /** Distances from the END of path `a` (cached Dijkstra, O(n²) scan — small graphs). */
  private row(a: number): Float64Array {
    const cached = this.fromEnd.get(a);
    if (cached) return cached;
    const n = this.ids.length;
    const dist = new Float64Array(n).fill(Infinity);
    const done = this.done;
    done.fill(0);
    dist[a] = 0;
    for (;;) {
      let u = -1;
      for (let i = 0; i < n; i++) {
        if (done[i] === 0 && dist[i] !== Infinity && (u === -1 || dist[i] < dist[u])) u = i;
      }
      if (u === -1) break;
      done[u] = 1;
      const base = dist[u];
      const out = this.succ[u];
      for (let k = 0; k < out.length; k++) {
        const v = out[k];
        const cand = base + this.lengths[v];
        if (cand < dist[v]) dist[v] = cand;
      }
    }
    this.dijkstraRuns++;
    this.fromEnd.set(a, dist);
    return dist;
  }
}

/**
 * Snapshot adapter: an `RVPathNetwork` as {@link RouteGraph}. The snapshot is
 * taken now — after a path edit (`onPathChanged`) build a new one and call
 * {@link RouteTable.invalidate} on a table built over it.
 */
export function pathNetworkRouteGraph(net: RVPathNetwork): RouteGraph {
  net.resolveGraph();
  const ids: string[] = [];
  const len = new Map<string, number>();
  const succ = new Map<string, readonly string[]>();
  const preds = new Map<string, number>();
  for (const p of net.all()) {
    ids.push(p.id);
    len.set(p.id, p.length);
    succ.set(p.id, p.successors.map((q) => q.id));
    preds.set(p.id, p.predecessors.length);
  }
  return {
    pathIds: () => ids,
    length: (id) => len.get(id) ?? NaN,
    successors: (id) => succ.get(id) ?? [],
    predecessorCount: (id) => preds.get(id) ?? 0,
  };
}
