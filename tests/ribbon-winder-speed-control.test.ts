// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * ribbon-winder-speed-control.test.ts — `RibbonWinder.SpeedControl`.
 *
 * The problem this exists for: a winder is the one roller in a line whose radius
 * moves, so a drive at a constant angular speed changes its surface speed as the
 * roll builds. A rewinder starting on a 76 mm core and growing to 400 mm ends up
 * running five times too fast, and the dancer that is supposed to absorb the
 * difference is on its end stop long before that.
 *
 * What is asserted here is therefore the LOOP, not a formula: the control writes
 * a set-point, the fixture's drive integrates it, and the roller reads the result
 * back out of the axis position on the next tick. `drive.follow(name)` is what
 * hands a roller over to that loop — without it the fixture keeps commanding a
 * surface speed itself and would overwrite the thing under test.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ribbonHarness, type RibbonHarness, type RollerSpec } from './ribbon-fixture';
import type { RVRibbonWinder } from '../src/core/engine/rv-ribbon-winder';

const DT = 1 / 60;
const LINE_SPEED = 800;

/** Unwinder — nip — dancer — rewinder: the smallest machine with a real store. */
const LAYOUT: RollerSpec[] = [
  { name: 'Unwinder', xMm: 0, yMm: 0, radiusMm: 400, winder: true, driven: true },
  { name: 'Nip', xMm: 1600, yMm: 0, radiusMm: 100, driven: true },
  { name: 'Dancer', xMm: 2400, yMm: 600, radiusMm: 60, dancer: true },
  { name: 'Rewinder', xMm: 3200, yMm: 0, radiusMm: 90, winder: true, driven: true },
];

function machine(unwind: Record<string, unknown> = {}, rewind: Record<string, unknown> = {}): RibbonHarness {
  const specs = LAYOUT.map((r) => ({ ...r }));
  specs[0].extras = {
    CoreRadiusMm: 76.2, RibbonThicknessMm: 3, InitialWoundLengthMm: -1, ...unwind,
  };
  specs[2].extras = { TravelAxis: 'Y', TravelMinMm: -150, TravelMaxMm: 150, Strands: 2 };
  specs[3].extras = {
    CoreRadiusMm: 76.2, RibbonThicknessMm: 3, InitialWoundLengthMm: 0, ...rewind,
  };
  const h = ribbonHarness(specs);
  h.buildPath({ RibbonWidthMm: 400 });
  // The nip is the master and keeps being commanded directly; the two winders
  // are handed over to their own set-point, which is what the control writes.
  h.drive.jogRoller('Nip', LINE_SPEED);
  h.drive.follow('Unwinder');
  h.drive.follow('Rewinder');
  return h;
}

function run(h: RibbonHarness, seconds: number): void {
  const ticks = Math.round(seconds / DT);
  for (let i = 0; i < ticks; i++) h.step(DT);
}

const winderOf = (h: RibbonHarness, name: string): RVRibbonWinder =>
  h.roller(name) as unknown as RVRibbonWinder;

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => { warn = vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { warn.mockRestore(); });

describe('RibbonWinder.SpeedControl', () => {
  it('writes nothing at all while it is None — the authored speed stands', () => {
    const h = machine();
    const drive = h.drive.driveOf('Unwinder')!;
    drive.targetSpeed = 12;
    run(h, 1);
    expect(drive.targetSpeed).toBe(12);
    expect(winderOf(h, 'Unwinder').controlledSpeedMmPerS).toBe(0);
  });

  it('LineSpeed holds the winder SURFACE speed at the line speed', () => {
    const h = machine({ SpeedControl: 'LineSpeed' });
    const unwinder = winderOf(h, 'Unwinder');
    run(h, 2);
    expect(unwinder.surfaceSpeedMmPerS).toBeCloseTo(LINE_SPEED, 0);
    expect(unwinder.controlledSpeedMmPerS).toBeCloseTo(LINE_SPEED, 0);
  });

  it('keeps holding it while the radius moves — which is the whole point', () => {
    // The rewinder is regulated too, or the dancer fills, clamps the group and
    // the parent roll never empties enough for this to be a question.
    const h = machine({ SpeedControl: 'LineSpeed' }, { SpeedControl: 'Dancer' });
    const unwinder = winderOf(h, 'Unwinder');
    const startRadius = unwinder.radiusMm;
    const startOmega = h.drive.driveOf('Unwinder')!.targetSpeed;
    run(h, 40);
    // The parent roll visibly emptied, so this is not a trivially static case.
    expect(unwinder.radiusMm).toBeLessThan(startRadius - 5);
    // A smaller roll has to turn FASTER for the same surface speed...
    expect(h.drive.driveOf('Unwinder')!.targetSpeed).toBeGreaterThan(startOmega);
    // ...and the surface speed is what actually stayed put.
    expect(unwinder.surfaceSpeedMmPerS).toBeCloseTo(LINE_SPEED, 0);
  });

  it('a fixed-speed rewinder runs its dancer into a stop; Dancer control does not', () => {
    const fixed = machine({ SpeedControl: 'LineSpeed' });
    // 'None' on the rewinder, started at the angular speed that matches the line
    // on its bare core — exactly how the demo was authored before this field.
    // The roll then grows, its surface speed grows with it, and it takes up more
    // than the nip feeds until the store below it is empty.
    fixed.drive.driveOf('Rewinder')!.targetSpeed = (LINE_SPEED / 76.2) * (180 / Math.PI);
    run(fixed, 60);
    expect(fixed.dancer('Dancer').atMin).toBe(true);

    const held = machine({ SpeedControl: 'LineSpeed' }, { SpeedControl: 'Dancer' });
    run(held, 60);
    const dancer = held.dancer('Dancer');
    expect(dancer.atMin).toBe(false);
    expect(dancer.atMax).toBe(false);
    // And not merely inside the range: held near its home position.
    expect(Math.abs(dancer.positionMm - dancer.HomeMm)).toBeLessThan(50);
  });

  it('never trims further off the line speed than MaxTrimPercent', () => {
    const h = machine({ SpeedControl: 'LineSpeed' }, {
      SpeedControl: 'Dancer', DancerGainPerMm: 1000, MaxTrimPercent: 10,
    });
    run(h, 20);
    const commanded = winderOf(h, 'Rewinder').controlledSpeedMmPerS;
    expect(Math.abs(commanded - LINE_SPEED)).toBeLessThanOrEqual(LINE_SPEED * 0.1 + 1e-6);
  });

  it('steps aside the moment a signal owns the drive — and takes it back after', () => {
    const h = machine({ SpeedControl: 'LineSpeed' });
    const unwinder = winderOf(h, 'Unwinder');
    const drive = h.drive.driveOf('Unwinder')!;
    run(h, 1);
    expect(unwinder.isSpeedControlOverridden).toBe(false);

    // A `Drive_FollowPosition` with a BOUND Position slot: the real drive's
    // position is the truth now, and the internal control must not write.
    drive.driveBehaviors.push({ Position: 'PLC.Unwinder.ActualPosition' });
    const frozen = drive.targetSpeed;
    run(h, 1);
    expect(unwinder.isSpeedControlOverridden).toBe(true);
    expect(drive.targetSpeed).toBe(frozen);

    drive.driveBehaviors.length = 0;
    run(h, 1);
    expect(unwinder.isSpeedControlOverridden).toBe(false);
    expect(drive.targetSpeed).not.toBe(frozen);
  });

  it('an UNBOUND Drive_FollowPosition changes nothing', () => {
    const h = machine({ SpeedControl: 'LineSpeed' });
    h.drive.driveOf('Unwinder')!.driveBehaviors.push({ Position: null });
    run(h, 1);
    expect(winderOf(h, 'Unwinder').isSpeedControlOverridden).toBe(false);
    expect(winderOf(h, 'Unwinder').surfaceSpeedMmPerS).toBeCloseTo(LINE_SPEED, 0);
  });

  it('`positionOverwrite` and `liveControlled` hand the axis over too', () => {
    for (const flag of ['positionOverwrite', 'liveControlled'] as const) {
      const h = machine({ SpeedControl: 'LineSpeed' });
      run(h, 0.5);
      h.drive.driveOf('Unwinder')![flag] = true;
      const frozen = h.drive.driveOf('Unwinder')!.targetSpeed;
      run(h, 0.5);
      expect(winderOf(h, 'Unwinder').isSpeedControlOverridden, flag).toBe(true);
      expect(h.drive.driveOf('Unwinder')!.targetSpeed, flag).toBe(frozen);
    }
  });

  it('warns once when there is nothing to control', () => {
    const specs = LAYOUT.map((r) => ({ ...r }));
    specs[0].driven = false;              // SpeedControl, but no drive on the node
    specs[0].extras = {
      CoreRadiusMm: 76.2, RibbonThicknessMm: 3, InitialWoundLengthMm: -1,
      SpeedControl: 'LineSpeed',
    };
    specs[3].extras = { CoreRadiusMm: 76.2, RibbonThicknessMm: 3, InitialWoundLengthMm: 0 };
    const h = ribbonHarness(specs);
    h.buildPath({ RibbonWidthMm: 400 });
    h.drive.jogRoller('Nip', LINE_SPEED);
    run(h, 1);
    const hits = warn.mock.calls.filter(
      (c: unknown[]) => String(c[0]).includes('no rotational Drive to control'),
    );
    expect(hits).toHaveLength(1);
  });
});

/**
 * The disturbances — the reason a regulated demo is still worth watching.
 *
 * Regulation is what makes the effects hard to see: a winder held at line speed
 * and trimmed on its own carriage absorbs a line-speed change without the web
 * leaving its tolerance band. That is the machine working, and it is also a demo
 * that shows nothing. So what has to be pinned here is that each fault DEFEATS
 * one half of the control and the web visibly reacts.
 */
describe('disturbances in a regulated line', () => {
  const REGULATED = [{ SpeedControl: 'LineSpeed' }, { SpeedControl: 'Dancer' }] as const;

  /** The path's worst zone state, which is what the tint and the labels show. */
  function worstState(h: RibbonHarness): string {
    const path = h.ribbonManager.groups[0].paths[0];
    const rank: Record<string, number> = {
      inBand: 0, below: 1, above: 1, slack: 2, over: 3, broken: 4,
    };
    let worst = 'inBand';
    for (const zone of path.zones) if (rank[zone.state] > rank[worst]) worst = zone.state;
    return worst;
  }

  function tensionMachine(unwind = REGULATED[0], rewind = REGULATED[1]): RibbonHarness {
    const h = machine({ ...unwind }, { ...rewind });
    const path = h.ribbonManager.groups[0].paths[0];
    Object.assign(path, {
      TensileStiffnessNPerMmWidth: 10, TargetTensionNPerM: 100,
      MinStrainPercent: 0, MaxStrainPercent: 2, ToleranceBandPercent: 10,
      BreakForceNPer50mm: 35,
    });
    h.dancer('Dancer').LoadN = 80;
    return h;
  }

  it('a regulated line stays in its band — which is the problem', () => {
    const h = tensionMachine();
    run(h, 30);
    expect(worstState(h)).toBe('inBand');
    expect(h.dancer('Dancer').atMin).toBe(false);
    expect(h.dancer('Dancer').atMax).toBe(false);
  });

  it('BRAKE FAULT: the unwinder regulator off takes the web out of its band', () => {
    const h = tensionMachine();
    run(h, 5);
    expect(worstState(h)).toBe('inBand');

    // The regulator stops writing; the drive holds the angular speed it had. The
    // roll keeps shrinking, so its surface speed falls away from the line — and
    // the span before the nip has no carriage to absorb it.
    winderOf(h, 'Unwinder').SpeedControl = 'None';
    run(h, 60);
    expect(['above', 'over', 'broken', 'slack']).toContain(worstState(h));
  });

  it('STUCK DANCER: a seized carriage turns the speed difference into strain', () => {
    const h = tensionMachine();
    run(h, 5);
    const before = h.dancer('Dancer').positionMm;

    h.dancer('Dancer').jammed = true;
    // Pull the downstream section off the line so there IS a difference to store.
    h.drive.driveOf('Rewinder')!.targetSpeed *= 1.25;
    winderOf(h, 'Rewinder').SpeedControl = 'None';
    run(h, 20);

    // The carriage did not move — that is what "seized" means.
    expect(h.dancer('Dancer').positionMm).toBeCloseTo(before, 6);
    // And the web took the difference instead.
    expect(worstState(h)).not.toBe('inBand');
  });

  it('a jam never latches: clearing it hands the store back', () => {
    const h = tensionMachine();
    const dancer = h.dancer('Dancer');
    dancer.jammed = true;
    h.drive.driveOf('Rewinder')!.targetSpeed *= 1.2;
    winderOf(h, 'Rewinder').SpeedControl = 'None';
    run(h, 5);
    const stuckAt = dancer.positionMm;

    dancer.jammed = false;
    run(h, 5);
    expect(Math.abs(dancer.positionMm - stuckAt)).toBeGreaterThan(1);
  });

  it('a reset repairs a jam, because a fault is not a configuration', () => {
    const h = tensionMachine();
    h.dancer('Dancer').jammed = true;
    h.ribbonManager.resetAll();
    expect(h.dancer('Dancer').jammed).toBe(false);
  });
});

/**
 * The alarm registry — the same one `WebError` reports into, so a web fault
 * reaches the message panel and `web_errors` and not only the 3D view.
 */
describe('alarm reporting', () => {
  /** The smallest thing `RibbonPath` asks of an ErrorStore. */
  function stubStore() {
    const entries = new Map<string, string>();
    return {
      entries,
      setActive(path: string, active: boolean, text: string) {
        if (active) entries.set(path, text); else entries.delete(path);
      },
      remove(path: string) { entries.delete(path); },
      texts() { return [...entries.values()]; },
    };
  }

  function reportingMachine(report: boolean) {
    const h = machine({ SpeedControl: 'LineSpeed' }, { SpeedControl: 'Dancer' });
    const store = stubStore();
    const path = h.ribbonManager.groups[0].paths[0];
    Object.assign(path, {
      TensileStiffnessNPerMmWidth: 10, TargetTensionNPerM: 100,
      MinStrainPercent: 0, MaxStrainPercent: 2, ToleranceBandPercent: 10,
      BreakForceNPer50mm: 35, ReportAlarms: report,
    });
    (path as unknown as { _errors: unknown })._errors = store;
    h.dancer('Dancer').LoadN = 80;
    return { h, store, path };
  }

  it('reports faults even if a legacy document set ReportAlarms false', () => {
    const { h, store } = reportingMachine(false);
    winderOf(h, 'Unwinder').SpeedControl = 'None';
    run(h, 60);
    expect(store.texts()).toHaveLength(1);
  });

  it('files one entry for the worst zone once it is switched on', () => {
    const { h, store } = reportingMachine(true);
    run(h, 5);
    expect(store.texts()).toHaveLength(0);          // a healthy line says nothing

    winderOf(h, 'Unwinder').SpeedControl = 'None';
    run(h, 60);
    // ONE entry, not one per zone: a machine with three bad spans is one fault.
    expect(store.texts()).toHaveLength(1);
    expect(store.texts()[0]).toMatch(/web (is overstretched|is slack|has torn)/);
  });

  it('reports a TORN web without figures — there is no true number left', () => {
    const { h, store, path } = reportingMachine(true);
    // Torn by running the NIP away, not by a jam: the carriage is loaded, and a
    // loaded dancer SETS the tension of both zones beside it algebraically, so
    // in this four-roller fixture those two zones cannot be pulled anywhere. The
    // zone before the nip is the one the integrator still owns.
    // The unwinder regulator has to be defeated FIRST, and that is worth seeing:
    // while it is on it simply follows the nip to 4000 mm/s and the web never
    // strains at all — the regulation working, in one line.
    h.dancer('Dancer').LoadN = 0;
    winderOf(h, 'Unwinder').SpeedControl = 'None';
    h.drive.jogRoller('Nip', 4000);
    run(h, 20);
    expect(path.zones.some((z) => z.state === 'broken')).toBe(true);
    expect(store.texts()[0]).toBe(`${path.node.name}: web has torn`);
    expect(store.texts()[0]).not.toMatch(/%|N\/m/);
  });
});
