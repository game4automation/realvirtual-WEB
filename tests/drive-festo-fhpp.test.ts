// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * RVDriveFestoFHPP — port of Drive_FestoFHPP.cs. Pins the CCON / CPOS decode
 * (STOP and HALT are active low), the ENABLE gate, Direct mode vs Record
 * Select positioning, jog, homing, the sticky fault with rising-edge reset and
 * the SCON / SPOS status bytes against the C# reference.
 */

import { describe, expect, it } from 'vitest';
import { RVDriveFestoFHPP } from '../src/core/engine/rv-drive-festo-fhpp';
import { buildBehaviorRig, type SignalSpec } from './fixtures/drive-behavior-harness';

const SIGNALS: SignalSpec = {
  Ccon: 'PLCOutputInt',
  Cpos: 'PLCOutputInt',
  RecordOrCdir: 'PLCOutputInt',
  VelocityPercent: 'PLCOutputInt',
  TargetPosition: 'PLCOutputInt',
  Scon: 'PLCInputInt',
  Spos: 'PLCInputInt',
  RecordOrSdir: 'PLCInputInt',
  PositionActual: 'PLCInputInt',
};

// CCON
const ENABLE = 1 << 0;
const STOP = 1 << 1;       // 1 = operation enabled
const RESET = 1 << 3;
const OPM_DIRECT = 1 << 6; // OPM = 01
// CPOS
const HALT = 1 << 0;       // 1 = not halted
const START = 1 << 1;
const HOM = 1 << 2;
const JOGP = 1 << 3;
const JOGN = 1 << 4;
// SCON
const S_ENABLED = 1 << 0;
const S_OPEN = 1 << 1;
const S_WARN = 1 << 2;
const S_FAULT = 1 << 3;
const S_VLOAD = 1 << 4;
const S_OPM = 1 << 6;
// SPOS
const P_HALT = 1 << 0;
const P_ACK = 1 << 1;
const P_MC = 1 << 2;
const P_MOV = 1 << 4;
const P_REF = 1 << 7;

const CCON_RUN = ENABLE | STOP;
const CPOS_RUN = HALT;

function rig(overrides: Record<string, unknown> = {}) {
  const r = buildBehaviorRig<RVDriveFestoFHPP>('Drive_FestoFHPP', SIGNALS, overrides);
  const tick = (ccon: number, cpos: number) => {
    r.set('Ccon', ccon);
    r.set('Cpos', cpos);
    r.behavior.update(1 / 60);
  };
  return { ...r, tick };
}

describe('RVDriveFestoFHPP', () => {
  it('reports VLOAD always, ENABLED and OPEN once enabled and not halted', () => {
    const r = rig();
    r.tick(0, 0);
    expect(r.num('Scon')).toBe(S_VLOAD);
    expect(r.num('Spos') & P_HALT).toBe(0);
    r.tick(CCON_RUN, CPOS_RUN);
    expect(r.num('Scon') & (S_ENABLED | S_OPEN | S_VLOAD)).toBe(S_ENABLED | S_OPEN | S_VLOAD);
    expect(r.num('Spos') & P_HALT).toBe(P_HALT);
  });

  it('Direct mode: START rising edge drives to TargetPosition · PositionScale + offset at velocity % of BaseVelocity', () => {
    const r = rig({ PositionScale: 0.1, PositionOffset: 2, BaseVelocity: 400 });
    r.set('TargetPosition', 1000); // 100 mm + 2
    r.set('VelocityPercent', 25);   // 100 mm/s
    r.tick(CCON_RUN | OPM_DIRECT, CPOS_RUN);
    r.tick(CCON_RUN | OPM_DIRECT, CPOS_RUN | START);
    expect(r.drive.targetPosition).toBeCloseTo(102, 6);
    expect(r.drive.targetSpeed).toBeCloseTo(100, 6);
    expect(r.drive.isRunning).toBe(true);
    expect(r.num('Spos') & P_ACK).toBe(P_ACK);     // task active
    expect(r.num('Spos') & P_MC).toBe(0);
    expect(r.num('Scon') & S_OPM).toBe(S_OPM);     // OPM echo

    // Held START: no second start
    r.set('TargetPosition', 5);
    r.tick(CCON_RUN | OPM_DIRECT, CPOS_RUN | START);
    expect(r.drive.targetPosition).toBeCloseTo(102, 6);

    // Arrive: task done, motion complete
    r.drive.currentPosition = 102;
    r.tick(CCON_RUN | OPM_DIRECT, CPOS_RUN | START);
    expect(r.num('Spos') & P_ACK).toBe(0);
    expect(r.num('Spos') & P_MC).toBe(P_MC);
  });

  it('Direct mode: CDIR.0 makes the target relative to the current position', () => {
    const r = rig();
    r.drive.currentPosition = 30;
    r.set('TargetPosition', 15);
    r.set('RecordOrCdir', 1);
    r.tick(CCON_RUN | OPM_DIRECT, CPOS_RUN);
    r.tick(CCON_RUN | OPM_DIRECT, CPOS_RUN | START);
    expect(r.drive.targetPosition).toBeCloseTo(45, 6);
    expect(r.num('RecordOrSdir')).toBe(1); // byte 2 echo
  });

  it('Record Select: byte 2 picks the record, unknown records ignore the start', () => {
    const r = rig({
      PositionOffset: 1,
      Records: [
        { Position: 0, Velocity: 100, Relative: false },
        { Position: 200, Velocity: 250, Relative: false },
        { Position: 5, Velocity: 20, Relative: true },
      ],
    });
    r.set('RecordOrCdir', 1);
    r.tick(CCON_RUN, CPOS_RUN);
    r.tick(CCON_RUN, CPOS_RUN | START);
    expect(r.drive.targetPosition).toBeCloseTo(201, 6);
    expect(r.drive.targetSpeed).toBeCloseTo(250, 6);

    r.drive.currentPosition = 201;
    r.set('RecordOrCdir', 2); // relative
    r.tick(CCON_RUN, CPOS_RUN);
    r.tick(CCON_RUN, CPOS_RUN | START);
    expect(r.drive.targetPosition).toBeCloseTo(206, 6);

    r.drive.currentPosition = 206; // arrive → task done
    r.set('RecordOrCdir', 7); // unknown record: the start is ignored, nothing becomes active
    r.tick(CCON_RUN, CPOS_RUN);
    expect(r.num('Spos') & P_ACK).toBe(0);
    r.tick(CCON_RUN, CPOS_RUN | START);
    expect(r.drive.targetPosition).toBeCloseTo(206, 6);
    expect(r.num('Spos') & P_ACK).toBe(0);
  });

  it('jog: JOGP / JOGN at JogSpeed, both set = no direction', () => {
    const r = rig({ JogSpeed: 42 });
    r.tick(CCON_RUN, CPOS_RUN | JOGP);
    expect(r.drive.targetSpeed).toBe(42);
    expect(r.drive.jogForward).toBe(true);
    r.tick(CCON_RUN, CPOS_RUN | JOGN);
    expect(r.drive.jogBackward).toBe(true);
    expect(r.drive.jogForward).toBe(false);
    r.tick(CCON_RUN, CPOS_RUN | JOGP | JOGN);
    expect(r.drive.jogForward).toBe(false);
    expect(r.drive.jogBackward).toBe(false);
    expect(r.num('Spos') & P_MC).toBe(0); // never "motion complete" while jogging
  });

  it('homing (HOM rising) sets the position to PositionOffset and the REF bit', () => {
    const r = rig({ PositionOffset: 7 });
    r.drive.currentPosition = 123;
    r.tick(CCON_RUN, CPOS_RUN);
    expect(r.num('Spos') & P_REF).toBe(0);
    r.tick(CCON_RUN, CPOS_RUN | HOM);
    expect(r.drive.currentPosition).toBe(7);
    expect(r.num('Spos') & P_REF).toBe(P_REF);
    expect(r.num('PositionActual')).toBe(0); // (7 - 7) / 1
  });

  it('STOP low aborts the task, HALT low only pauses it', () => {
    const r = rig();
    r.set('TargetPosition', 50);
    r.tick(CCON_RUN | OPM_DIRECT, CPOS_RUN);
    r.tick(CCON_RUN | OPM_DIRECT, CPOS_RUN | START);
    expect(r.num('Spos') & P_ACK).toBe(P_ACK);

    r.tick(CCON_RUN | OPM_DIRECT, START); // HALT = 0 → paused, task kept
    expect(r.num('Spos') & P_ACK).toBe(P_ACK);
    expect(r.num('Scon') & S_OPEN).toBe(0);

    r.tick((CCON_RUN | OPM_DIRECT) & ~STOP, CPOS_RUN | START); // STOP = 0 → aborted
    expect(r.num('Spos') & P_ACK).toBe(0);
  });

  it('ENABLE low stops the drive and drops the task', () => {
    const r = rig();
    r.set('TargetPosition', 50);
    r.tick(CCON_RUN | OPM_DIRECT, CPOS_RUN);
    r.tick(CCON_RUN | OPM_DIRECT, CPOS_RUN | START);
    expect(r.drive.isRunning).toBe(true);
    r.tick(STOP | OPM_DIRECT, CPOS_RUN | START);
    expect(r.drive.isRunning).toBe(false);
    expect(r.num('Scon') & S_ENABLED).toBe(0);
    expect(r.num('Spos') & P_ACK).toBe(0);
  });

  it('fault is sticky until a rising edge of CCON.RESET; warning follows SimulateWarning', () => {
    const r = rig();
    r.behavior.SimulateFault = true;
    r.behavior.SimulateWarning = true;
    r.tick(CCON_RUN, CPOS_RUN | JOGP);
    expect(r.num('Scon') & (S_FAULT | S_WARN)).toBe(S_FAULT | S_WARN);
    expect(r.num('Scon') & S_ENABLED).toBe(0);
    expect(r.drive.jogForward).toBe(false);

    r.behavior.SimulateFault = false;
    r.tick(CCON_RUN, CPOS_RUN);
    expect(r.num('Scon') & S_FAULT).toBe(S_FAULT); // still faulted without a reset edge
    r.tick(CCON_RUN | RESET, CPOS_RUN);
    expect(r.num('Scon') & S_FAULT).toBe(0);
    expect(r.num('Scon') & S_ENABLED).toBe(S_ENABLED);
  });

  it('reports MOV while the drive has speed', () => {
    const r = rig();
    r.drive.currentSpeed = 10;
    r.tick(CCON_RUN, CPOS_RUN);
    expect(r.num('Spos') & P_MOV).toBe(P_MOV);
    r.drive.currentSpeed = 0;
    r.tick(CCON_RUN, CPOS_RUN);
    expect(r.num('Spos') & P_MOV).toBe(0);
  });
});
