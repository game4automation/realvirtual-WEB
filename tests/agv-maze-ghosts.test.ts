// Copyright (C) 2026 realvirtual GmbH. All rights reserved.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RVPathNetwork } from '@rv/core/engine/rv-path-network';
import { PathTraveler } from '@rv/core/engine/rv-path-traveler';
import { buildMazeGraph } from '../src/plugins/models/agv-maze/maze-builder';
import { DEFAULT_MAZE, parseMazeMap, type Cell, type Dir } from '../src/plugins/models/agv-maze/maze-map';
import { GHOSTS, GhostRouter } from '../src/plugins/models/agv-maze/ghost-router';

const RING = '#######\n#P.o.G#\n#.###.#\n#..D..#\n#######';
function setup(ascii = RING) {
  const map = parseMazeMap(ascii), network = new RVPathNetwork(), graph = buildMazeGraph(map, network);
  const ghosts = GHOSTS.map(config => new PathTraveler(config.travelerId, graph.edges[0].path, network));
  const player = { cell: { r: 1, c: 1 }, direction: 'E' as Dir };
  const router = new GhostRouter(map, graph, network, ghosts, player);
  return { map, network, graph, ghosts, player, router };
}
afterEach(() => vi.restoreAllMocks());
describe('AGV Maze directed ghost routing', () => {
  it('chooses the reachable opposite entrance on the ring (hand-computed counterexample)', () => {
    const f = setup(), path = f.network.get('e_r1c1_r1c2')!;
    f.ghosts[0].path = path; f.router.modes[0] = 'chase';
    expect(f.router.targetSegment(path, { r: 1, c: 1 })!.id).toBe('e_r2c1_r1c1');
    expect(f.network.next(path, 1, undefined, GHOSTS[0].travelerId)!.id).toBe('e_r1c2_r1c3');
  });
  it('uses the nearer of two entrances, including a player on the opposing ring lane', () => {
    const f = setup(), path = f.network.get('e_r1c1_r1c2')!;
    expect(f.router.targetSegment(path, { r: 1, c: 4 })!.id).toBe('e_r1c3_r1c4');
    f.player.cell = { r: 1, c: 4 }; f.player.direction = 'W'; f.router.modes[0] = 'chase';
    expect(f.network.next(path, 1, undefined, GHOSTS[0].travelerId)!.id).toBe('e_r1c2_r1c3');
  });
  it('picks the shortest chaser branch using an independent grid-distance oracle', () => {
    const f = setup('#########\n#P.....G#\n#.##.##.#\n#...D...#\n#########');
    const path = f.network.get('e_r1c3_r1c4')!;
    f.player.cell = { r: 3, c: 4 }; f.router.modes[0] = 'chase';
    // Independent cell BFS: south is two cells away; east must go around the right block.
    const distances = new Map<string, number>(), queue: Cell[] = [f.player.cell]; distances.set('3,4', 0);
    for (let head = 0; head < queue.length; head++) {
      const cell = queue[head];
      for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const r = cell.r + dr, c = cell.c + dc, key = `${r},${c}`;
        if (f.map.walkable[r]?.[c] && !distances.has(key)) { distances.set(key, distances.get(`${cell.r},${cell.c}`)! + 1); queue.push({ r, c }); }
      }
    }
    const expected = [...path.successors].sort((a, b) => {
      const ac = f.graph.cellOfPathEnd.get(a.id)!, bc = f.graph.cellOfPathEnd.get(b.id)!;
      return distances.get(`${ac.r},${ac.c}`)! - distances.get(`${bc.r},${bc.c}`)!;
    })[0];
    expect(f.network.next(path, 1, undefined, GHOSTS[0].travelerId)).toBe(expected);
    expect(expected.id).toBe('e_r1c4_r2c4');
  });
  it('clamps Ambusher and Flanker targets and handles coincident chaser/player', () => {
    const f = setup(), out = { r: 0, c: 0 }; f.router.modes.fill('chase');
    f.player.cell = { r: 1, c: 3 }; f.player.direction = 'S';
    const target = f.router.targetFor(1, out); expect(f.map.walkable[target.r][target.c]).toBe(true);
    f.ghosts[0].path = f.network.get('e_r1c2_r1c3');
    f.player.cell = { r: 1, c: 3 }; expect(f.router.targetFor(2, out)).toEqual({ r: 1, c: 4 });
    f.ghosts[0].path = f.network.get('e_r1c3_r1c4');
    expect(f.router.targetFor(2, out)).toEqual(f.player.cell);
  });
  it('switches Wildcard at both sides of the eight-cell threshold', () => {
    const f = setup('#############\n#P.........G#\n#.#########.#\n#.....D.....#\n#############');
    f.router.modes.fill('chase'); const out = { r: 0, c: 0 };
    f.ghosts[3].path = f.network.get('e_r1c9_r1c10');
    expect(f.router.targetFor(3, out)).toEqual(f.player.cell);
    f.ghosts[3].path = f.network.get('e_r1c8_r1c9');
    expect(f.router.targetFor(3, out)).toEqual(f.map.corners[3]);
  });
  it('pauses phase time for Frightened and resumes the previous phase', () => {
    const f = setup(); f.router.tick(6); f.router.setFrightened(true); f.router.tick(8);
    expect(f.router.phaseElapsed).toBe(6); f.router.setFrightened(false); expect(f.router.phaseMode).toBe('scatter');
    f.router.tick(1); expect(f.router.phaseMode).toBe('chase'); expect(f.router.modes).toEqual(['chase', 'chase', 'chase', 'chase']);
  });
  it('repeats seeded random decisions after restart', () => {
    const f = setup(); const ctx = { travelerId: GHOSTS[0].travelerId, currentPathId: f.ghosts[0].path!.id, direction: 1 as const };
    f.router.setFrightened(true); const first = Array.from({ length: 20 }, () => f.router.selectNextPath(['a', 'b', 'c'], ctx));
    f.router.reset(); f.router.setFrightened(true);
    expect(Array.from({ length: 20 }, () => f.router.selectNextPath(['a', 'b', 'c'], ctx))).toEqual(first);
    expect(new Set(first).size).toBeGreaterThan(1);
  });
  it('routes Eaten to the depot and restores the running phase on arrival', () => {
    const f = setup(); f.router.tick(7); f.router.eat(0);
    expect(f.router.targetFor(0, { r: 0, c: 0 })).toEqual(f.map.depot); expect(f.router.speed(0)).toBe(1800);
    f.router.onArrive('e_r3c2_r3c3', GHOSTS[0].travelerId); expect(f.router.modes[0]).toBe('chase');
  });
  it('unregisters only its router and restores the default successor', () => {
    const f = setup(); f.router.dispose(); f.router.dispose(); expect(f.network.hasRouter).toBe(false);
    const path = f.graph.edges[0].path; expect(f.network.next(path, 1, undefined, GHOSTS[0].travelerId)).toBe(path.successors[0]);
  });
  it('routes 200 cold-cache decisions on the default map in under 100 ms', () => {
    const f = setup(DEFAULT_MAZE); f.router.modes.fill('chase'); let elapsed = 0;
    const ctx = { travelerId: GHOSTS[0].travelerId, currentPathId: '', direction: 1 as const };
    for (let i = 0; i < 200; i++) {
      const path = f.graph.edges[i % f.graph.edges.length].path;
      f.network.register(path); f.network.resolveGraph(); ctx.currentPathId = path.id;
      const candidates = path.successorIds.slice(); const start = performance.now();
      f.router.selectNextPath(candidates, ctx); elapsed += performance.now() - start;
    }
    console.info(`AGV Maze: ${f.graph.edges.length} directed segments; 200 cold routes: ${elapsed.toFixed(2)} ms`);
    expect(elapsed).toBeLessThan(100);
  });
});
