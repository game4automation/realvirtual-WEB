// Copyright (C) 2026 realvirtual GmbH. All rights reserved.
import { Vector3 } from 'three';
import { LineSegment, RVPath } from '@rv/core/engine/rv-path';
import type { RVPathNetwork } from '@rv/core/engine/rv-path-network';
import { cellCenter, cellIndex, edgeId, neighborsOf, sameCell, type Cell, type Dir, type MazeMap } from './maze-map';

export interface MazeEdge { path: RVPath; from: Cell; to: Cell; dir: Dir; opposite: RVPath; index: number; }
export interface MazeGraph {
  pathIds: string[]; byEdge: Map<string, RVPath>; cellOfPathEnd: Map<string, Cell>;
  edges: MazeEdge[]; metadata: Map<string, MazeEdge>;
  outgoing: Array<Partial<Record<Dir, RVPath>>>;
  dispose(): void;
}

export function buildMazeGraph(map: MazeMap, network: RVPathNetwork): MazeGraph {
  const edges: MazeEdge[] = [], byEdge = new Map<string, RVPath>(), cellOfPathEnd = new Map<string, Cell>();
  const metadata = new Map<string, MazeEdge>();
  const outgoing: MazeGraph['outgoing'] = Array.from({ length: map.rows * map.cols }, () => ({}));
  const fromPos = new Vector3(), toPos = new Vector3();
  for (let r = 0; r < map.rows; r++) for (let c = 0; c < map.cols; c++) {
    if (!map.walkable[r][c]) continue;
    const from = { r, c };
    for (const neighbor of neighborsOf(map, from)) {
      const to = neighbor.cell, id = edgeId(from, to);
      if (network.get(id)) throw new Error(`Maze path already registered: ${id}`);
      const exits = neighborsOf(map, to);
      const successors = exits.filter(exit => !sameCell(exit.cell, from));
      const path = new RVPath(id, [new LineSegment(cellCenter(map, from, fromPos), cellCenter(map, to, toPos))], {
        successorIds: (successors.length ? successors : exits).map(exit => edgeId(to, exit.cell)),
      });
      const edge: MazeEdge = { path, from, to, dir: neighbor.dir, opposite: path, index: edges.length };
      edges.push(edge); byEdge.set(id, path); cellOfPathEnd.set(id, to); metadata.set(id, edge);
      outgoing[cellIndex(map, from)][neighbor.dir] = path;
    }
  }
  for (const edge of edges) edge.opposite = byEdge.get(edgeId(edge.to, edge.from))!;
  const pathIds = edges.map(edge => edge.path.id);
  for (const edge of edges) network.register(edge.path);
  network.resolveGraph();
  let disposed = false;
  return { pathIds, byEdge, cellOfPathEnd, edges, metadata, outgoing, dispose() {
    if (disposed) return;
    disposed = true;
    for (const id of pathIds) network.unregister(id);
    network.resolveGraph();
  } };
}
