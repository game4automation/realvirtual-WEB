// Copyright (C) 2026 realvirtual GmbH. All rights reserved.
import { cellIndex, type Cell, type MazeMap } from './maze-map';

export type GameState = 0 | 1 | 2 | 3 | 4;
export type GhostMode = 'scatter' | 'chase' | 'frightened' | 'eaten';
export interface MazeSignalSink { setMany(values: Record<string, number | boolean>): void; }
export interface GameSignals extends Record<string, number | boolean> {
  'Maze.Score': number; 'Maze.Lives': number; 'Maze.PelletsLeft': number;
  'Maze.State': GameState; 'Maze.Frightened': boolean;
}
export interface GameEvents {
  resetPositions(): void;
  resetGhosts(): void;
  frightened(active: boolean): void;
  eatGhost(index: number): void;
  pellet(index: number, power: boolean): void;
  resetPellets(): void;
  captured?(): void;
}
export class MazeGame {
  readonly signals: GameSignals = { 'Maze.Score': 0, 'Maze.Lives': 3, 'Maze.PelletsLeft': 0, 'Maze.State': 0, 'Maze.Frightened': false };
  readonly pellets: Uint8Array;
  frightenedLeft = 0;
  private dyingLeft = 0;
  constructor(readonly map: MazeMap, private readonly store: MazeSignalSink, private readonly events: GameEvents) {
    this.pellets = new Uint8Array(map.rows * map.cols);
    this.restart();
  }
  get state(): GameState { return this.signals['Maze.State']; }
  start(): void { if (this.state === 0) { this.signals['Maze.State'] = 1; this.publish(); } }
  setMuted(muted: boolean): void { this.signals['Maze.Muted'] = muted; this.publish(); }
  restart(): void {
    this.pellets.fill(0);
    for (const cell of this.map.pellets) this.pellets[cellIndex(this.map, cell)] = 1;
    for (const cell of this.map.powerPellets) this.pellets[cellIndex(this.map, cell)] = 2;
    this.signals['Maze.Score'] = 0; this.signals['Maze.Lives'] = 3;
    this.signals['Maze.PelletsLeft'] = this.map.pellets.length + this.map.powerPellets.length;
    this.signals['Maze.State'] = 0; this.signals['Maze.Frightened'] = false;
    this.frightenedLeft = 0; this.dyingLeft = 0;
    this.events.resetGhosts(); this.events.resetPositions(); this.events.resetPellets();
    this.arriveAt(this.map.playerStart); this.publish();
  }
  arriveAt(cell: Cell): void {
    const index = cellIndex(this.map, cell), kind = this.pellets[index];
    if (!kind) return;
    this.pellets[index] = 0; this.signals['Maze.Score'] += kind === 2 ? 50 : 10;
    this.signals['Maze.PelletsLeft']--;
    this.events.pellet(index, kind === 2);
    if (kind === 2) {
      this.frightenedLeft = 8; this.signals['Maze.Frightened'] = true; this.events.frightened(true);
    }
    if (this.signals['Maze.PelletsLeft'] === 0) this.signals['Maze.State'] = 4;
    this.publish();
  }
  contact(index: number, mode: GhostMode): void {
    if (this.state !== 1 || mode === 'eaten') return;
    if (mode === 'frightened') { this.signals['Maze.Score'] += 200; this.events.eatGhost(index); }
    else {
      this.signals['Maze.Lives']--; this.signals['Maze.State'] = this.signals['Maze.Lives'] === 0 ? 3 : 2;
      this.dyingLeft = 1.5;
      this.events.captured?.();
    }
    this.publish();
  }
  tick(dt: number): void {
    if (this.state === 2) {
      this.dyingLeft -= dt;
      if (this.dyingLeft <= 1e-9) {
        this.events.resetPositions(); this.events.resetGhosts(); this.frightenedLeft = 0;
        this.signals['Maze.Frightened'] = false; this.signals['Maze.State'] = 0; this.publish();
      }
      return;
    }
    if (this.state !== 1 || this.frightenedLeft === 0) return;
    this.frightenedLeft = Math.max(0, this.frightenedLeft - dt);
    if (this.frightenedLeft < 1e-9) {
      this.frightenedLeft = 0; this.signals['Maze.Frightened'] = false;
      this.events.frightened(false); this.publish();
    }
  }
  private publish(): void { this.store.setMany(this.signals); }
}

/** Fixed ticks enqueue numbers; audio nodes are created only by the render callback. */
export class MazeAudio {
  muted = false;
  private context: AudioContext | null = null;
  private readonly pending = new Uint8Array(32);
  private count = 0;
  unlock(): void {
    if (this.muted || typeof AudioContext === 'undefined') return;
    try { this.context ??= new AudioContext(); void this.context.resume().catch(() => {}); } catch { /* Sound is optional. */ }
  }
  enqueue(kind: number): void { if (this.count < this.pending.length) this.pending[this.count++] = kind; }
  flush(): void {
    if (!this.context || this.context.state !== 'running' || this.muted) { this.count = 0; return; }
    if (this.count === 0) return;
    const kind = this.pending[this.count - 1]; this.count = 0;
    const oscillator = this.context.createOscillator(), gain = this.context.createGain(), now = this.context.currentTime;
    const frequency = kind === 1 ? 540 : kind === 2 ? 150 : 340;
    oscillator.type = 'sine'; oscillator.frequency.setValueAtTime(frequency, now);
    oscillator.frequency.exponentialRampToValueAtTime(kind === 2 ? 75 : frequency * 1.35, now + 0.09);
    gain.gain.setValueAtTime(0.0001, now); gain.gain.exponentialRampToValueAtTime(0.06, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.12);
    oscillator.connect(gain); gain.connect(this.context.destination);
    oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
    oscillator.start(now); oscillator.stop(now + 0.13);
  }
  clear(): void { this.count = 0; }
  dispose(): void { this.clear(); void this.context?.close().catch(() => {}); this.context = null; }
}
