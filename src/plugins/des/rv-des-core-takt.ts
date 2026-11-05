// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import type { CoreSubsystemsHost, DriveLike } from '../../core/engine/rv-core-subsystems';
import type { RVDrive } from '../../core/engine/rv-drive';
import { RVDriveGear } from '../../core/engine/rv-drive-gear';
import { driveSignalAdapters } from './rv-des-drive-state';
import { isActiveForState } from '../../core/engine/rv-active-only';

type IsTakt = (drive: DriveLike) => boolean;
const arrivedListeners = new WeakMap<CoreSubsystemsHost, Set<(drive: DriveLike) => void>>();

function gearMaster(drive: DriveLike): DriveLike | null | undefined {
  return drive.driveBehaviors?.find(b => b instanceof RVDriveGear)?.masterDrive;
}

/** A gear chain follows its master's clock, including externally moved masters. */
export function collectTaktDrives(h: CoreSubsystemsHost, desOwn: ReadonlySet<object>): Set<DriveLike> {
  const takt = new Set(h.drives.filter(d => !desOwn.has(d)));
  // Removing external followers to a fixed point also handles unordered chains.
  let changed: boolean;
  do {
    changed = false;
    for (const drive of takt) {
      const master = gearMaster(drive);
      if (master !== undefined && (master === null || !takt.has(master))) {
        takt.delete(drive); changed = true;
      }
    }
  } while (changed);
  return takt;
}

export function followsNonTaktMaster(drive: DriveLike, isTakt: IsTakt): boolean {
  const master = gearMaster(drive);
  return master !== undefined && (master === null || !isTakt(master));
}

export function resetCycleOwners(h: CoreSubsystemsHost, isTakt: IsTakt, resetLogic = true): void {
  h.playback?.stop?.();
  for (const path of h.ikPaths) path.reset?.();
  for (const replay of h.replayRecordings) replay.reset?.();
  for (const drive of h.drives) if (isTakt(drive)) drive.reset?.();
  h.sceneButtonManager?.resetAll?.();
  if (resetLogic) {
    h.logicEngine?.reset?.();
    h.logicEngine?.resetOwnedOutputs?.();
    if (h.logicEngine?.isStarted) h.logicEngine.start?.(h.isConnected);
  }
  h.signalReapply?.reapplyAll();
}

/** All ownership inputs are read live, including placement add/remove. A transport surface's
 *  signal-only adapter (belt Forward/Backward) does not open a cycle: DES moves its MUs. */
export function hasTaktSubsystems(h: CoreSubsystemsHost, isTakt: IsTakt): boolean {
  return (h.logicEngine?.roots?.length ?? h.logicEngine?.batchPresence?.().length ?? 0) > 0
    || h.ikPaths.length > 0 || h.replayRecordings.length > 0
    || !!h.playback && h.playback.hasRecording !== false
    || h.drives.some(d => isTakt(d) && (hasDriveBehavior(d) || !d.isTransportSurface && driveSignalAdapters(d as RVDrive).length > 0));
}

export function cycleAlive(h: CoreSubsystemsHost, isTakt: IsTakt): boolean {
  return h.ikPaths.some(p => p.PathIsActive || p.hasPendingWork)
    || !!h.playback && isActiveForState(h.playback.activeOnly, h.isConnected)
      && !!(h.playback.isPlaying || h.playback.hasPendingWork)
    || h.replayRecordings.some(r => isActiveForState(r.activeOnly, h.isConnected) && (r.isActive || r.waitingForStart))
    || h.drives.some(d => isTakt(d) && (d.isRunning || d.jogForward || d.jogBackward
      || d.driveBehaviors?.some(b => b.cycleAlive)));
}

export function commandedDrives(h: CoreSubsystemsHost): ReadonlySet<object> {
  return new Set([...h.ikPaths.flatMap(p => [...(p.robot?.getAxisDrives() ?? [])]),
    ...(h.logicEngine?.commandedDrives?.() ?? [])]);
}

export function addArrivedListener(h: CoreSubsystemsHost, fn: (drive: DriveLike) => void): () => void {
  let listeners = arrivedListeners.get(h);
  if (!listeners) arrivedListeners.set(h, listeners = new Set());
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Returns motion even when a behavior starts and finishes a move in one update. */
export function taktDrives(h: CoreSubsystemsHost, dt: number, isTakt: IsTakt): boolean {
  let moved = false;
  for (const drive of h.drives) {
    if (!isTakt(drive)) continue;
    const wasAtTarget = drive.isAtTarget;
    const position = (drive as RVDrive).currentPosition;
    drive.update(dt);
    if ((drive as RVDrive).currentPosition !== position) moved = true;
    if (drive.isRunning || drive.positionOverwrite || drive.claimedMoveThisTick) {
      h.markRenderDirty();
      if (!drive.isTransportSurface) h.markShadowsDirty();
    }
    if (wasAtTarget === false && Boolean(drive.isAtTarget) || (drive as RVDrive).arrivedThisUpdate)
      for (const fn of arrivedListeners.get(h) ?? []) fn(drive);
  }
  return moved;
}

// Only authored/motion behaviors establish a competing tick owner. Turntable.setup
// attaches signal-only adapters for its own exposed IO; these do not tick.
export function hasDriveBehavior(drive: DriveLike): boolean {
  return !!(drive.Behaviors?.length || Object.keys(drive.BehaviorExtras ?? {}).length
    || drive.driveBehaviors?.length);
}
