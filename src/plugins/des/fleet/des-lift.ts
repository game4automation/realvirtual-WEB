// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * DES fork lift of the fleet executor (plan-559 Phase 5, V6; moved from the
 * PalletYard project, plan-612 §2.4 "Hub" — behaviour unchanged): fork strokes
 * on SIMULATION time, duration from way / speed. The active `DESRunner` carries
 * a `{kind:'drive'}` tween on its TweenRegistry for [now, now + dt] — the visual
 * stroke in Animated — plus one clock event at the end that snaps the drive to
 * the target and calls `done`. A stroke is only started from inside a DES event
 * (a dock or clock callback). The continuous counterpart is
 * `src/core/fleet/continuous/lift.ts`.
 */

import type { ClockHandle, SimClock } from '../../../core/fleet/core/sim-clock';
import type { LiftBackend, LiftDrive, LiftDone } from '../../../core/fleet/exec/backends';
import { validateLiftState } from '../../../core/fleet/exec/backend-state';
import type { DESRunner } from '../des-runner';

/** Duration (s) of a stroke — never zero (a DES tween needs a positive window). */
export function strokeSec(fromMm: number, toMm: number, speedMmS: number): number {
  return Math.max(0.001, Math.abs(toMm - fromMm) / Math.max(0.001, speedMmS));
}

export interface Stroke { handle: ClockHandle; toMm: number; done: LiftDone; from: number; startAt: number; dt: number }
export interface LiftState { strokes: [string, Stroke][]; positions: [string, number][] }
export interface PreparedLift { strokes: Map<string, Stroke>; positions: [string, number][] }

/** DES lift backend — see the module doc. */
export class DesLift implements LiftBackend {
  private strokes = new Map<string, Stroke>();

  private tweenIds = new Map<string, number>();
  private subscribedRunner: DESRunner | null = null;
  private offLifecycle: (() => void) | null = null;
  private disposed = false;

  private bindRunner(): DESRunner | null {
    const runner = this.runner();
    if (this.disposed) return null;
    if (runner !== this.subscribedRunner) {
      this.offLifecycle?.();
      this.tweenIds.clear();
      this.subscribedRunner = runner;
      this.offLifecycle = runner ? runner.onLifecycle(event => {
        if (event.type !== 'restored') return;
        this.tweenIds.clear();
        for (const [vehicle, stroke] of this.strokes) {
          const drive = this.drives.get(vehicle);
          if (!drive) continue;
          const id = runner.getTweenRegistry().addDrive({
            setPosition(v: number): void { drive.positionOverwrite = true; drive.currentPosition = v; drive.applyToNode(); },
          }, stroke.from, stroke.toMm, stroke.startAt, stroke.dt);
          this.tweenIds.set(vehicle, id);
        }
      }) : null;
    }
    return runner;
  }

  dispose(): void {
    this.offLifecycle?.();
    this.offLifecycle = null;
    this.subscribedRunner = null;
    this.tweenIds.clear();
    this.disposed = true;
  }

  constructor(
    private readonly runner: () => DESRunner | null,
    private readonly clock: SimClock,
    private readonly drives: ReadonlyMap<string, LiftDrive>,
  ) {
    this.bindRunner();
    clock.registerAction('fleet.lift.end', data => {
      const { vehicle, toMm, done } = data as unknown as { vehicle: string; toMm: number; done: LiftDone };
      if (!this.strokes.delete(vehicle)) return;
      this.tweenIds.delete(vehicle);
      const drive = this.drives.get(vehicle);
      if (drive) {
        drive.positionOverwrite = true;
        drive.currentPosition = toMm;
        drive.applyToNode();
      }
      this.doneHandler(vehicle, done);
    });
  }
  private doneHandler: (vehicle: string, done: LiftDone) => void = () => {};
  setDoneHandler(handler: (vehicle: string, done: LiftDone) => void): void { this.doneHandler = handler; }

  exportState(): LiftState { this.bindRunner(); return structuredClone({ strokes: [...this.strokes], positions: [...this.drives].sort(([a], [b]) => a.localeCompare(b)).map(([id, d]): [string, number] => [id, d.currentPosition]) }); }
  claimsDrives(): readonly object[] { return [...this.drives.values()]; }
  validateState(json: unknown): string[] {
    const errors = validateLiftState(json && typeof json === 'object' ? { strokes: (json as LiftState).strokes } : json);
    if (json && typeof json === 'object' && Object.keys(json).sort().join(',') !== 'positions,strokes') errors.push('fleet.lift: unknown fields');
    const positions = (json as Partial<LiftState> | null)?.positions;
    if (!Array.isArray(positions) || positions.length !== this.drives.size || new Set(positions.map(p => p?.[0])).size !== this.drives.size
      || positions.some(p => !Array.isArray(p) || p.length !== 2 || !this.drives.has(p[0]) || !Number.isFinite(p[1]))) errors.push('fleet.lift: invalid positions');
    return errors;
  }
  prepareState(json: unknown): PreparedLift {
    this.bindRunner();
    const errors = this.validateState(json);
    if (errors.length) throw new Error('fleet.lift: ' + errors.join('; '));
    const state = structuredClone(json as LiftState);
    return { strokes: new Map(state.strokes), positions: state.positions };
  }
  swapState(prepared: PreparedLift): void {
    this.strokes = prepared.strokes;
    for (const [vehicle, value] of prepared.positions) {
      const drive = this.drives.get(vehicle)!;
      drive.positionOverwrite = true; drive.currentPosition = value; drive.applyToNode();
    }
  }


  position(vehicle: string): number { return this.drives.get(vehicle)?.currentPosition ?? 0; }

  move(vehicle: string, toMm: number, speedMmS: number, done: LiftDone): void {
    this.cancel(vehicle);
    const drive = this.drives.get(vehicle);
    const now = this.clock.now();
    if (!drive) {   // no lift bound: keep the timing contract — `done` as a (cancellable) event at now
      this.strokes.set(vehicle, { handle: this.clock.scheduleAction(now, 'fleet.lift.end', { vehicle, toMm, done }), toMm, done, from: 0, startAt: now, dt: 0 });
      return;
    }
    const from = drive.currentPosition;
    const dt = strokeSec(from, toMm, speedMmS);
    const runner = this.bindRunner();
    const tween = runner
      ? runner.getTweenRegistry().addDrive({
        setPosition(v: number): void { drive.positionOverwrite = true; drive.currentPosition = v; drive.applyToNode(); },
      }, from, toMm, now, dt)
      : -1;
    if (tween >= 0) this.tweenIds.set(vehicle, tween);
    const handle = this.clock.scheduleAction(now + dt, 'fleet.lift.end', { vehicle, toMm, done });
    this.strokes.set(vehicle, { handle, toMm, done, from, startAt: now, dt });
  }

  cancel(vehicle: string): void {
    const s = this.strokes.get(vehicle);
    if (!s) return;
    this.strokes.delete(vehicle);
    this.clock.cancel(s.handle);
    const runner = this.bindRunner();
    const tween = this.tweenIds.get(vehicle);
    this.tweenIds.delete(vehicle);
    if (tween !== undefined) runner?.getTweenRegistry().cancel(tween);
  }

  snap(vehicle: string, mm: number): void {
    this.cancel(vehicle);
    const drive = this.drives.get(vehicle);
    if (!drive) return;
    drive.positionOverwrite = true;
    drive.currentPosition = mm;
    drive.applyToNode();
  }

  /** Forget every running stroke (reset — the clock generation is already new). */
  clear(): void { this.strokes.clear(); this.tweenIds.clear(); }
}
