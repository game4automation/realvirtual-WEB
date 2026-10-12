// Copyright (C) 2026 realvirtual GmbH. All rights reserved.
import type { Vector3 } from 'three';

export type Cell = { r: number; c: number };
export type Dir = 'N' | 'E' | 'S' | 'W';
export const MAZE_SEED = 42;
export const DIRECTIONS: readonly Dir[] = ['N', 'E', 'S', 'W'];
export const DELTAS: Readonly<Record<Dir, readonly [number, number]>> = {
  N: [-1, 0], E: [0, 1], S: [1, 0], W: [0, -1],
};
export const OPPOSITE: Readonly<Record<Dir, Dir>> = { N: 'S', E: 'W', S: 'N', W: 'E' };
export interface MazeMap {
  rows: number; cols: number; cellSize: number;
  walkable: boolean[][];
  pellets: Cell[]; powerPellets: Cell[];
  playerStart: Cell; ghostStarts: Cell[]; depot: Cell;
  corners: [Cell, Cell, Cell, Cell];
}

// Original warehouse layout, 15 columns x 13 rows. The charging spur is at the bottom.
export const DEFAULT_MAZE = [
  '###############',
  '#P....#...o...#',
  '#.##..#.###.#.#',
  '#o....#.....#.#',
  '#.###...###...#',
  '#...#.G...#.#.#',
  '###...#G#...#.#',
  '#...#..G..#...#',
  '#.#.###G###.#.#',
  '#.#.........#o#',
  '#o..###.###...#',
  '#######D#######',
  '###############',
].join('\n');

export function sameCell(a: Cell, b: Cell): boolean { return a.r === b.r && a.c === b.c; }
export function cellIndex(map: MazeMap, cell: Cell): number { return cell.r * map.cols + cell.c; }
export function cellCenter(map: MazeMap, cell: Cell, out: Vector3): Vector3 {
  return out.set(cell.c * map.cellSize, 0, cell.r * map.cellSize);
}
export function edgeId(from: Cell, to: Cell): string { return `e_r${from.r}c${from.c}_r${to.r}c${to.c}`; }
export function neighborsOf(map: MazeMap, cell: Cell): Array<{ dir: Dir; cell: Cell }> {
  const result: Array<{ dir: Dir; cell: Cell }> = [];
  for (const dir of DIRECTIONS) {
    const [dr, dc] = DELTAS[dir];
    const r = cell.r + dr, c = cell.c + dc;
    if (map.walkable[r]?.[c]) result.push({ dir, cell: { r, c } });
  }
  return result;
}

export function parseMazeMap(ascii: string, cellSize = 1.2): MazeMap {
  const lines = ascii.replace(/\r/g, '').split('\n');
  if (!Number.isFinite(cellSize) || cellSize <= 0) throw new Error('Maze cellSize must be positive (meters).');
  if (lines.length < 3 || lines[0].length < 3 || lines.some(line => line.length !== lines[0].length)) {
    throw new Error('Maze must be a rectangular grid of at least 3 x 3 cells.');
  }
  const pellets: Cell[] = [], powerPellets: Cell[] = [], players: Cell[] = [], ghostStarts: Cell[] = [], depots: Cell[] = [];
  const walkable = lines.map((line, r) => Array.from(line, (symbol, c) => {
    if (!'#.o PGD'.includes(symbol)) throw new Error(`Unknown maze symbol at ${r},${c}.`);
    if ((r === 0 || c === 0 || r === lines.length - 1 || c === line.length - 1) && symbol !== '#') {
      throw new Error('Maze boundary must be closed by walls.');
    }
    const cell = { r, c };
    if (symbol === '.') pellets.push(cell);
    if (symbol === 'o') powerPellets.push(cell);
    if (symbol === 'P') players.push(cell);
    if (symbol === 'G') ghostStarts.push(cell);
    if (symbol === 'D') depots.push(cell);
    return symbol !== '#';
  }));
  if (players.length !== 1 || depots.length !== 1 || ghostStarts.length === 0) {
    throw new Error('Maze requires exactly one P, exactly one D and at least one G.');
  }
  const map: MazeMap = {
    rows: lines.length, cols: lines[0].length, cellSize, walkable, pellets, powerPellets,
    playerStart: players[0], ghostStarts, depot: depots[0], corners: [players[0], players[0], players[0], players[0]],
  };
  const visited = new Set<number>([cellIndex(map, players[0])]);
  const queue = [players[0]];
  for (let head = 0; head < queue.length; head++) {
    for (const next of neighborsOf(map, queue[head])) {
      const key = cellIndex(map, next.cell);
      if (!visited.has(key)) { visited.add(key); queue.push(next.cell); }
    }
  }
  if (queue.length !== walkable.flat().filter(Boolean).length || queue.length < 2) {
    throw new Error('All walkable maze cells must be connected.');
  }
  const extremes: Cell[] = [{ r: 0, c: 0 }, { r: 0, c: map.cols - 1 },
    { r: map.rows - 1, c: map.cols - 1 }, { r: map.rows - 1, c: 0 }];
  map.corners = extremes.map(target => queue.reduce((best, cell) =>
    Math.abs(cell.r - target.r) + Math.abs(cell.c - target.c) < Math.abs(best.r - target.r) + Math.abs(best.c - target.c)
      ? cell : best)) as MazeMap['corners'];
  return map;
}
