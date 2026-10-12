// Copyright (C) 2026 realvirtual GmbH. All rights reserved.
import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { RVPathNetwork } from '@rv/core/engine/rv-path-network';
import { DEFAULT_MAZE, cellCenter, neighborsOf, parseMazeMap } from '../src/plugins/models/agv-maze/maze-map';
import { buildMazeGraph } from '../src/plugins/models/agv-maze/maze-builder';

const RING = ['#######', '#P.o.G#', '#.###.#', '#..D..#', '#######'].join('\n');
const STUB = ['#####', '#P.G#', '#D###', '#####'].join('\n');
describe('AGV Maze map and graph', () => {
  it('parses pellets and specials', () => {
    const map = parseMazeMap(RING);
    expect(map.playerStart).toEqual({ r: 1, c: 1 }); expect(map.pellets).toHaveLength(8);
    expect(map.powerPellets).toEqual([{ r: 1, c: 3 }]); expect(map.depot).toEqual({ r: 3, c: 3 });
  });
  it('registers two directed edges per corridor, without junction reversals', () => {
    const network = new RVPathNetwork(), graph = buildMazeGraph(parseMazeMap(RING), network);
    expect(graph.pathIds).toHaveLength(24);
    expect(network.get('e_r1c1_r1c2')!.successorIds).toEqual(['e_r1c2_r1c3']);
    graph.dispose(); graph.dispose(); expect(network.all()).toHaveLength(0);
  });
  it('keeps the reverse edge at real dead ends', () => {
    const network = new RVPathNetwork(); buildMazeGraph(parseMazeMap(STUB), network);
    expect(network.get('e_r1c1_r2c1')!.successorIds).toEqual(['e_r2c1_r1c1']);
  });
  it('uses cell centers as exact path endpoints', () => {
    const map = parseMazeMap(RING), network = new RVPathNetwork(); buildMazeGraph(map, network);
    const path = network.get('e_r1c1_r1c2')!;
    expect(path.getAbsPosition(0, new Vector3())).toEqual(cellCenter(map, { r: 1, c: 1 }, new Vector3()));
    expect(path.getAbsPosition(path.length, new Vector3())).toEqual(cellCenter(map, { r: 1, c: 2 }, new Vector3()));
  });
  it('validates the original default layout, including four spawns and charging spur', () => {
    const map = parseMazeMap(DEFAULT_MAZE);
    expect([map.cols, map.rows]).toEqual([15, 13]); expect(map.ghostStarts).toHaveLength(4);
    expect(neighborsOf(map, map.depot)).toHaveLength(1);
    const graph = buildMazeGraph(map, new RVPathNetwork());
    expect(graph.edges.every(edge => edge.path.successors.length > 0)).toBe(true);
  });
  it('rejects invalid size, symbols, missing specials, open boundaries and disconnected cells', () => {
    expect(() => parseMazeMap(RING, 0)).toThrow(); expect(() => parseMazeMap(RING.replace('o', '?'))).toThrow();
    expect(() => parseMazeMap(RING.replace('P', '.'))).toThrow();
    expect(() => parseMazeMap(RING.substring(1))).toThrow();
    expect(() => parseMazeMap(RING.replace('#######', '###.###'))).toThrow();
    expect(() => parseMazeMap('#######\n#P#G#D#\n#######')).toThrow();
  });
  it('refuses collisions without modifying an existing graph', () => {
    const map = parseMazeMap(RING), network = new RVPathNetwork(); buildMazeGraph(map, network);
    expect(() => buildMazeGraph(map, network)).toThrow('already registered'); expect(network.all()).toHaveLength(24);
  });
});
