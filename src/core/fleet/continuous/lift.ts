// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Continuous fork lift (plan-559 Phase 5; moved unchanged from the PalletYard
 * project, plan-612 CP2): `RVDrive.startMove(target)` at the stroke speed, the
 * end polled once per fixed tick ({@link ContinuousLift.tick}, `isAtTarget`).
 * The DES counterpart is `src/plugins/des/fleet/des-lift.ts`.
 */

import type { ClockHandle, SimClock } from '../core/sim-clock';
import type { LiftBackend, LiftDrive, LiftDone } from '../exec/backends';

/** The part of an `RVDrive` the continuous lift drives. */
export interface ContinuousLiftDrive extends LiftDrive {
  TargetSpeed: number;
  targetPosition: number;
  readonly isAtTarget: boolean;
  startMove(destination?: number): void;
  stop(): void;
}

interface LiftSlot {
  readonly vehicle: string;
  readonly drive: ContinuousLiftDrive;
  active: boolean;
  done: LiftDone | null;
}

/**
 * Continuous lift backend. One preallocated slot per vehicle — the tick walks
 * an array, it allocates nothing. `cancel` and `snap` STOP the drive (an aborted
 * stroke must not run on to its old target), and both hand the axis back from a
 * DES `positionOverwrite` to the drive's own physics. A vehicle without a lift
 * keeps the timing contract: `done` as a clock event at now.
 */
export class ContinuousLift implements LiftBackend {
  private readonly slots: LiftSlot[] = [];
  private readonly byVehicle = new Map<string, LiftSlot>();
  /** The `done` event of a vehicle without a lift (cancellable like a stroke). */
  private readonly noDrive = new Map<string, ClockHandle>();

  constructor(drives: ReadonlyMap<string, ContinuousLiftDrive>, private readonly clock: SimClock) {
    for (const [vehicle, drive] of drives) {
      const slot: LiftSlot = { vehicle, drive, active: false, done: null };
      this.slots.push(slot);
      this.byVehicle.set(vehicle, slot);
    }
  }

  private doneHandler: (vehicle: string, done: LiftDone) => void = () => {};
  setDoneHandler(handler: (vehicle: string, done: LiftDone) => void): void { this.doneHandler = handler; }

  position(vehicle: string): number { return this.byVehicle.get(vehicle)?.drive.currentPosition ?? 0; }

  move(vehicle: string, toMm: number, speedMmS: number, done: LiftDone): void {
    const s = this.byVehicle.get(vehicle);
    this.cancel(vehicle);
    if (!s) {
      this.noDrive.set(vehicle, this.clock.schedule(this.clock.now(), () => { this.noDrive.delete(vehicle); this.doneHandler(vehicle, done); }));
      return;
    }
    const d = s.drive;
    d.positionOverwrite = false;
    d.TargetSpeed = speedMmS;
    d.startMove(toMm);
    s.active = true;
    s.done = done;
  }

  cancel(vehicle: string): void {
    const h = this.noDrive.get(vehicle);
    if (h) { this.noDrive.delete(vehicle); this.clock.cancel(h); }
    const s = this.byVehicle.get(vehicle);
    if (!s || !s.active) return;
    s.active = false;
    s.done = null;
    s.drive.stop();
  }

  snap(vehicle: string, mm: number): void {
    const h = this.noDrive.get(vehicle);
    if (h) { this.noDrive.delete(vehicle); this.clock.cancel(h); }
    const s = this.byVehicle.get(vehicle);
    if (!s) return;
    s.active = false;
    s.done = null;
    const d = s.drive;
    d.positionOverwrite = false;
    d.currentPosition = mm;
    d.targetPosition = mm;
    d.stop();          // also re-bases a smooth-motion profile at `mm`
    d.applyToNode();
  }

  /** True while a stroke of `vehicle` runs (tests, diagnostics). */
  moving(vehicle: string): boolean { return this.byVehicle.get(vehicle)?.active ?? false; }

  /** Forget every running stroke and stop the drives (reset / dispose). */
  clear(): void {
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i];
      if (s.active) s.drive.stop();
      s.active = false;
      s.done = null;
    }
  }

  /** Call once per fixed tick, after the drives moved: a stroke at its target calls `done`. */
  tick(): void {
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i];
      if (!s.active || !s.drive.isAtTarget) continue;
      const done = s.done;
      s.active = false;
      s.done = null;
      if (done) this.doneHandler(s.vehicle, done);
    }
  }
}
