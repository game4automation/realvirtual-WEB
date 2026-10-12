// Copyright (C) 2026 realvirtual GmbH. All rights reserved.
import type { RVPath } from '@rv/core/engine/rv-path';
import type { PathTraveler } from '@rv/core/engine/rv-path-traveler';
import type { PathNetworkRouter, RVPathNetwork, SelectNextPathContext } from '@rv/core/engine/rv-path-network';
import type { MazeGraph } from './maze-builder';
import { cellIndex, DELTAS, DIRECTIONS, MAZE_SEED, sameCell, type Cell, type Dir, type MazeMap } from './maze-map';
import type { GhostMode } from './game-state';
import { MAZE_PALETTE } from './maze-palette';

export type GhostRole = 'chaser' | 'ambusher' | 'flanker' | 'wildcard';
export interface GhostConfig { role: GhostRole; displayName: string; color: number; travelerId: string; }
export const GHOSTS: readonly GhostConfig[] = [
  { role: 'chaser', displayName: 'Simans', color: MAZE_PALETTE['RAL 5015'].color, travelerId: 'ghost-simans' },
  { role: 'ambusher', displayName: 'Rockwall', color: MAZE_PALETTE['RAL 7016'].color, travelerId: 'ghost-rockwall' },
  { role: 'flanker', displayName: 'Schnitter', color: MAZE_PALETTE['RAL 6018'].color, travelerId: 'ghost-schnitter' },
  { role: 'wildcard', displayName: 'Kuckuck', color: MAZE_PALETTE['RAL 1023'].color, travelerId: 'ghost-kuckuck' },
];
export const PHASE_PLAN_SEC = [7, 20, 7, 20, 5, 20, 5, Infinity] as const;
export const GHOST_SPEED = 1080, FRIGHTENED_SPEED = 660, EATEN_SPEED = 1800; // mm/s

/** Directed segment BFS picks a reachable entrance; production Dijkstra supplies the next hop. */
export class GhostRouter implements PathNetworkRouter {
  readonly modes: GhostMode[] = ['scatter', 'scatter', 'scatter', 'scatter'];
  phaseIndex = 0;
  phaseElapsed = 0;
  private frightened = false;
  private seed: number;
  private readonly target: Cell = { r: 0, c: 0 };
  private readonly queue: Int32Array;
  private readonly seen: Uint8Array;
  private readonly cellQueue: Int32Array;
  private readonly cellSeen: Uint8Array;
  private readonly targetCache = new Map<RVPath, Int32Array>();
  private readonly cellDistances: Int32Array[];
  private unregister: (() => void) | null;
  constructor(readonly map: MazeMap, readonly graph: MazeGraph, readonly network: RVPathNetwork,
    private readonly ghosts: readonly PathTraveler[], private readonly player: { readonly cell: Cell; readonly direction: Dir },
    private readonly initialSeed = MAZE_SEED) {
    this.seed = initialSeed;
    this.queue = new Int32Array(graph.edges.length); this.seen = new Uint8Array(graph.edges.length);
    const count = map.rows * map.cols;
    this.cellQueue = new Int32Array(count); this.cellSeen = new Uint8Array(count);
    for (const edge of graph.edges) this.targetCache.set(edge.path, new Int32Array(count).fill(-2));
    this.cellDistances = Array.from({ length: count }, () => new Int32Array(count).fill(-1));
    // All-pairs grid distances are only for the Wildcard threshold, never for selecting a target segment.
    for (let start = 0; start < count; start++) {
      if (!map.walkable[Math.floor(start / map.cols)][start % map.cols]) continue;
      const distances = this.cellDistances[start]; distances[start] = 0; this.cellQueue[0] = start;
      let tail = 1;
      for (let head = 0; head < tail; head++) {
        const index = this.cellQueue[head], r = Math.floor(index / map.cols), c = index % map.cols;
        for (const dir of DIRECTIONS) {
          const [dr, dc] = DELTAS[dir], nr = r + dr, nc = c + dc, next = nr * map.cols + nc;
          if (map.walkable[nr]?.[nc] && distances[next] < 0) { distances[next] = distances[index] + 1; this.cellQueue[tail++] = next; }
        }
      }
    }
    this.unregister = network.setRouter(this, 'agv-maze');
  }
  get phaseMode(): 'scatter' | 'chase' { return this.phaseIndex % 2 === 0 ? 'scatter' : 'chase'; }
  reset(): void {
    this.seed = this.initialSeed; this.phaseIndex = 0; this.phaseElapsed = 0; this.frightened = false;
    this.modes.fill('scatter'); for (const cache of this.targetCache.values()) cache.fill(-2);
  }
  setFrightened(active: boolean): void {
    this.frightened = active;
    for (let i = 0; i < 4; i++) if (this.modes[i] !== 'eaten') this.modes[i] = active ? 'frightened' : this.phaseMode;
  }
  eat(index: number): void { this.modes[index] = 'eaten'; }
  speed(index: number): number { return this.modes[index] === 'eaten' ? EATEN_SPEED : this.modes[index] === 'frightened' ? FRIGHTENED_SPEED : GHOST_SPEED; }
  tick(dt: number): void {
    if (this.frightened) return;
    this.phaseElapsed += dt;
    while (this.phaseElapsed + 1e-9 >= PHASE_PLAN_SEC[this.phaseIndex] && this.phaseIndex < PHASE_PLAN_SEC.length - 1) {
      this.phaseElapsed = Math.max(0, this.phaseElapsed - PHASE_PLAN_SEC[this.phaseIndex]); this.phaseIndex++;
      for (let i = 0; i < 4; i++) if (this.modes[i] !== 'eaten') this.modes[i] = this.phaseMode;
    }
  }
  private ghostCell(index: number): Cell {
    const traveler = this.ghosts[index], edge = this.graph.metadata.get(traveler.path!.id)!;
    return traveler.s >= traveler.path!.length ? edge.to : edge.from;
  }
  distance(a: Cell, b: Cell): number { return this.cellDistances[cellIndex(this.map, a)][cellIndex(this.map, b)]; }
  clampTarget(r: number, c: number, out: Cell): Cell {
    r = Math.max(0, Math.min(this.map.rows - 1, r)); c = Math.max(0, Math.min(this.map.cols - 1, c));
    this.cellSeen.fill(0); let tail = 1; const start = r * this.map.cols + c;
    this.cellQueue[0] = start; this.cellSeen[start] = 1;
    for (let head = 0; head < tail; head++) {
      const index = this.cellQueue[head], row = Math.floor(index / this.map.cols), column = index % this.map.cols;
      if (this.map.walkable[row][column]) { out.r = row; out.c = column; return out; }
      for (const dir of DIRECTIONS) {
        const [dr, dc] = DELTAS[dir], nr = row + dr, nc = column + dc, next = nr * this.map.cols + nc;
        if (nr >= 0 && nr < this.map.rows && nc >= 0 && nc < this.map.cols && !this.cellSeen[next]) {
          this.cellSeen[next] = 1; this.cellQueue[tail++] = next;
        }
      }
    }
    return out; // Parser guarantees a nonempty connected walkable component.
  }
  targetFor(index: number, out: Cell): Cell {
    const mode = this.modes[index], player = this.player.cell;
    if (mode === 'eaten') { out.r = this.map.depot.r; out.c = this.map.depot.c; return out; }
    let target = player, r = player.r, c = player.c;
    if (mode === 'scatter') target = this.map.corners[index];
    else if (GHOSTS[index].role === 'ambusher') {
      const delta = DELTAS[this.player.direction]; return this.clampTarget(r + 4 * delta[0], c + 4 * delta[1], out);
    } else if (GHOSTS[index].role === 'flanker') {
      const chaser = this.ghostCell(0); return this.clampTarget(2 * r - chaser.r, 2 * c - chaser.c, out);
    } else if (GHOSTS[index].role === 'wildcard' && this.distance(this.ghostCell(index), player) < 8) target = this.map.corners[index];
    out.r = target.r; out.c = target.c; return out;
  }
  targetSegment(from: RVPath, target: Cell): RVPath | null {
    const cache = this.targetCache.get(from)!, targetIndex = cellIndex(this.map, target), cached = cache[targetIndex];
    if (cached !== -2) return cached < 0 ? null : this.graph.edges[cached].path;
    this.seen.fill(0); const start = this.graph.metadata.get(from.id)!.index;
    this.queue[0] = start; this.seen[start] = 1; let tail = 1;
    for (let head = 0; head < tail; head++) {
      const index = this.queue[head], edge = this.graph.edges[index];
      if (sameCell(edge.to, target)) { cache[targetIndex] = index; return edge.path; }
      for (const successor of edge.path.successors) {
        const next = this.graph.metadata.get(successor.id)!.index;
        if (!this.seen[next]) { this.seen[next] = 1; this.queue[tail++] = next; }
      }
    }
    cache[targetIndex] = -1; return null;
  }
  readonly selectNextPath = (candidateIds: string[], ctx: SelectNextPathContext): string | undefined => {
    let index = -1;
    for (let i = 0; i < GHOSTS.length; i++) if (GHOSTS[i].travelerId === ctx.travelerId) { index = i; break; }
    if (index < 0 || candidateIds.length === 0) return undefined;
    if (this.modes[index] === 'frightened') return candidateIds[Math.floor(this.random() * candidateIds.length)];
    const current = this.graph.byEdge.get(ctx.currentPathId)!;
    const target = this.targetSegment(current, this.targetFor(index, this.target));
    if (target === current || candidateIds.length === 1) return candidateIds[0];
    const next = target ? this.network.nextHopToward(current, target.id) : null;
    if (next && candidateIds.includes(next.id)) return next.id;
    if (import.meta.env.DEV) console.warn('AGV Maze: unreachable route target', ctx.currentPathId, this.target.r, this.target.c);
    return candidateIds[0];
  };
  onArrive(pathId: string, travelerId: string): void {
    for (let i = 0; i < GHOSTS.length; i++) {
      if (GHOSTS[i].travelerId === travelerId && this.modes[i] === 'eaten' && sameCell(this.graph.cellOfPathEnd.get(pathId)!, this.map.depot)) {
        this.modes[i] = this.phaseMode;
      }
    }
  }
  private random(): number {
    let value = this.seed += 0x6d2b79f5;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  }
  dispose(): void { this.unregister?.(); this.unregister = null; }
}
