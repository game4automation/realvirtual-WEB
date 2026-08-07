// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * SimLoopFacadeImpl — pause-control + tick subscription.
 *
 * Phase 4a: onTick stores callbacks in an in-memory registry, but the
 * integration with fixedUpdate() comes in Phase 5. Plugins can register now;
 * callbacks will actually fire once Phase 5 ships.
 */

import type { SimLoopFacade } from '../rv-plugin-context';
import { TickStage } from '../rv-tick-stages';
import type { RVDrive } from '../engine/rv-drive';
import type { RVViewer } from '../rv-viewer';

export interface TickEntry {
  callback: (dt: number) => void;
  order: number;
  insertIdx: number;  // for stable secondary sort
}

export class SimLoopFacadeImpl implements SimLoopFacade {
  // Public so RVViewer (Phase 5) can read & iterate during fixedUpdate.
  readonly _ticks: Map<TickStage, TickEntry[]> = new Map([
    [TickStage.PRE, []],
    [TickStage.SIM, []],
    [TickStage.POST, []],
  ]);
  // Cached defensive snapshots — rebuilt lazily after (un)subscribe instead of
  // allocating a copy on every fixedUpdate tick (3 stages × 60 Hz).
  private readonly _tickSnapshots: Map<TickStage, TickEntry[] | null> = new Map([
    [TickStage.PRE, null],
    [TickStage.SIM, null],
    [TickStage.POST, null],
  ]);
  private _insertCounter = 0;

  constructor(private readonly _viewer: RVViewer) {}

  setPaused(reason: string, paused: boolean): void {
    this._viewer.setSimulationPaused(reason, paused);
  }

  clearPauseReasons(reason?: string): void {
    this._viewer.clearPauseReasons(reason);
  }

  isPaused(): boolean {
    return this._viewer.isSimulationPaused;
  }

  onTick(stage: TickStage, callback: (dt: number) => void, order = 100): () => void {
    const entry: TickEntry = { callback, order, insertIdx: this._insertCounter++ };
    const list = this._ticks.get(stage)!;
    list.push(entry);
    // Stable sort: primary by order, secondary by insert index.
    list.sort((a, b) => a.order - b.order || a.insertIdx - b.insertIdx);
    this._tickSnapshots.set(stage, null);
    return () => {
      const idx = list.indexOf(entry);
      if (idx >= 0) {
        list.splice(idx, 1);
        this._tickSnapshots.set(stage, null);
      }
    };
  }

  /** Snapshot for defensive iteration during fixedUpdate — a running iteration
   *  keeps its copy while (un)subscribes only invalidate the cache.
   *  @internal */
  _snapshotTicks(stage: TickStage): readonly TickEntry[] {
    let snap = this._tickSnapshots.get(stage);
    if (!snap) {
      snap = this._ticks.get(stage)!.slice();
      this._tickSnapshots.set(stage, snap);
    }
    return snap;
  }

  eachDrive(fn: (drive: RVDrive, index: number) => void): void {
    const drives = this._viewer.drives;
    if (!drives) return;
    for (let i = 0; i < drives.length; i++) fn(drives[i], i);
  }

  get driveCount(): number {
    return this._viewer.drives?.length ?? 0;
  }
}
