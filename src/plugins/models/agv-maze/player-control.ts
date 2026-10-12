// Copyright (C) 2026 realvirtual GmbH. All rights reserved.
import type { PathTraveler } from '@rv/core/engine/rv-path-traveler';
import type { RVPath } from '@rv/core/engine/rv-path';
import type { MazeGraph } from './maze-builder';
import { cellIndex, OPPOSITE, type Cell, type Dir, type MazeMap } from './maze-map';

export const PLAYER_SPEED = 1200; // mm/s
const KEYS: Readonly<Record<string, Dir>> = { ArrowUp: 'N', ArrowRight: 'E', ArrowDown: 'S', ArrowLeft: 'W', w: 'N', d: 'E', s: 'S', a: 'W' };

/** Owns node arrival. The traveler's onArrive hook deliberately stays unused. */
export class PlayerControl {
  desired: Dir | null = null;
  private arrived = false;
  private selected: RVPath | null = null;
  private readonly selectNext = (): string | undefined => this.selected?.id;
  constructor(readonly traveler: PathTraveler, private readonly map: MazeMap, private readonly graph: MazeGraph,
    private readonly arriveAt: (cell: Cell) => void) {
    traveler.hooks.selectNextPath = this.selectNext;
  }
  get direction(): Dir { return this.graph.metadata.get(this.traveler.path!.id)!.dir; }
  get cell(): Cell {
    const edge = this.graph.metadata.get(this.traveler.path!.id)!;
    return this.traveler.s === this.traveler.path!.length ? edge.to : edge.from;
  }
  setDesired(dir: Dir): void {
    this.desired = dir;
    const t = this.traveler;
    if (t.v > 0 && dir === OPPOSITE[this.direction]) {
      const opposite = this.graph.metadata.get(t.path!.id)!.opposite;
      t.s = opposite.length - t.s; t.path = opposite; t.atEnd = false;
      // At s=L after a reversal at a starting node, that node is already counted.
      this.arrived = t.s === opposite.length;
      this.selected = null;
    }
  }
  reset(): void { this.desired = null; this.arrived = false; this.selected = null; }
  start(): void {
    const t = this.traveler, exits = this.graph.outgoing[cellIndex(this.map, this.cell)];
    if (t.s === 0 && this.desired && exits[this.desired]) t.path = exits[this.desired]!;
    t.v = PLAYER_SPEED;
  }
  tick(dt: number): void {
    const t = this.traveler;
    if (t.v === 0) {
      if (!this.desired) return;
      const next = this.graph.outgoing[cellIndex(this.map, this.cell)][this.desired];
      if (!next) return;
      t.path = next; t.s = 0; t.v = PLAYER_SPEED; t.atEnd = false; this.arrived = false;
      return; // Restart at the node; no second arrival and no movement this tick.
    }
    let time = dt;
    // Each advance crosses at most one boundary, so large dt also keeps every pickup.
    while (time > 0) {
      const path = t.path!, remaining = path.length - t.s;
      const step = t.v / 1000 * time;
      // Decimal cell sizes produce sub-nanometer endpoint roundoff.
      if (step + 1e-9 < remaining) { t.advance(time); return; }
      const edge = this.graph.metadata.get(path.id)!;
      if (!this.arrived) { this.arrived = true; this.arriveAt(edge.to); }
      const exits = this.graph.outgoing[cellIndex(this.map, edge.to)];
      this.selected = (this.desired ? exits[this.desired] : undefined) ?? exits[edge.dir] ?? null;
      if (!this.selected) { t.s = path.length; t.v = 0; return; }
      // Exact equality never carries in PathTraveler. Keep the arrival latch until it does.
      const distance = Math.min(step, remaining + this.selected.length * 0.5);
      const slice = distance / (t.v / 1000);
      t.advance(slice); time = Math.max(0, time - slice);
      if (t.path !== path) this.arrived = false;
      if (distance === 0) return;
    }
  }
  bindKeyboard(target: Window, accept: () => boolean, input: (dir: Dir) => void): () => void {
    const keydown = (event: KeyboardEvent): void => {
      if (event.altKey || event.ctrlKey || event.metaKey || !accept()) return;
      const element = event.target;
      if (element instanceof HTMLElement && (element.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(element.tagName))) return;
      const dir = KEYS[event.key] ?? KEYS[event.key.toLowerCase()];
      if (!dir) return;
      input(dir);
      if (event.key.startsWith('Arrow')) event.preventDefault();
    };
    target.addEventListener('keydown', keydown);
    return () => target.removeEventListener('keydown', keydown);
  }
  dispose(): void { if (this.traveler.hooks.selectNextPath === this.selectNext) delete this.traveler.hooks.selectNextPath; }
}
