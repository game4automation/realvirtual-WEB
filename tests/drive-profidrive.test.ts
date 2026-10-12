// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * RVDriveProfidriveSpeed / RVDriveProfidrivePos — ports of Drive_ProfidriveSpeed.cs
 * and Drive_ProfidrivePos.cs. Pins the PROFIdrive state machine walk (the drive
 * only moves after OFF1 low → high → enable operation), the OFF2 / OFF3 priority,
 * the sticky fault with rising-edge acknowledge, the NSOLL_A normalization and
 * the ZSW1 bits against the C# reference, plus the EPOS cascade of the
 * positioning variant (jog, MDI absolute / relative, setup, reference point).
 */

import { describe, expect, it } from 'vitest';
import { RVDriveProfidriveSpeed } from '../src/core/engine/rv-drive-profidrive-speed';
import { RVDriveProfidrivePos } from '../src/core/engine/rv-drive-profidrive-pos';
import { buildBehaviorRig, type SignalSpec } from './fixtures/drive-behavior-harness';

const SPEED_SIGNALS: SignalSpec = {
  ControlWord: 'PLCOutputInt',
  SpeedSetpoint: 'PLCOutputInt',
  StatusWord: 'PLCInputInt',
  SpeedActual: 'PLCInputInt',
};

// STW1 bit masks (telegram 1 / 111)
const ON_OFF1 = 1 << 0;
const NO_OFF2 = 1 << 1;
const NO_OFF3 = 1 << 2;
const ENABLE_OP = 1 << 3;
const ENABLE_RAMP = 1 << 4;
const CONTINUE_RAMP = 1 << 5;
const ENABLE_SETPOINT = 1 << 6;
const ACK = 1 << 7;
const JOG1 = 1 << 8;
const JOG2 = 1 << 9;
const CTRL_PLC = 1 << 10;
const HOMING = 1 << 11;
const INVERT = 1 << 11;

/** The classic SINAMICS enable word: 0x047E without ON, 0x047F with ON. */
const READY_WORD = NO_OFF2 | NO_OFF3 | ENABLE_OP | ENABLE_RAMP | CONTINUE_RAMP | ENABLE_SETPOINT | CTRL_PLC; // 0x047E
const RUN_WORD = READY_WORD | ON_OFF1; // 0x047F

// ZSW1 bits
const Z_READY_SWITCH_ON = 1 << 0;
const Z_READY_OPERATE = 1 << 1;
const Z_OP_ENABLED = 1 << 2;
const Z_FAULT = 1 << 3;
const Z_NO_OFF2 = 1 << 4;
const Z_NO_OFF3 = 1 << 5;
const Z_INHIBITED = 1 << 6;
const Z_CTRL_REQ = 1 << 9;
const Z_SETPOINT_REACHED = 1 << 10;

function speedRig(overrides: Record<string, unknown> = {}) {
  const r = buildBehaviorRig<RVDriveProfidriveSpeed>('Drive_ProfidriveSpeed', SPEED_SIGNALS, overrides);
  const tick = (stw1: number, nsoll = 0) => {
    r.set('ControlWord', stw1);
    r.set('SpeedSetpoint', nsoll);
    r.behavior.update(1 / 60);
  };
  /** Walk the state machine into Operation: OFF1 low first, then the run word.
   *  Like C#, the tick that ENTERS Operation does not move yet — motion starts
   *  on the next one, hence the fourth tick. */
  const enable = (nsoll = 0) => { tick(READY_WORD, nsoll); tick(RUN_WORD, nsoll); tick(RUN_WORD, nsoll); tick(RUN_WORD, nsoll); };
  return { ...r, tick, enable };
}

describe('RVDriveProfidriveSpeed', () => {
  it('starts switching-on inhibited and stays there while ON/OFF1 is set', () => {
    const r = speedRig();
    expect(r.behavior.State).toBe('SwitchingOnInhibited');
    r.tick(RUN_WORD, 0x4000); // ON already set: the inhibit is NOT cleared
    expect(r.behavior.State).toBe('SwitchingOnInhibited');
    expect(r.drive.jogForward).toBe(false);
    expect(r.num('StatusWord') & Z_INHIBITED).toBe(Z_INHIBITED);
    expect(r.num('StatusWord') & Z_READY_SWITCH_ON).toBe(0);
  });

  it('walks inhibited → ready for switching on → ready to operate → operation', () => {
    const r = speedRig();
    r.tick(READY_WORD);
    expect(r.behavior.State).toBe('ReadyForSwitchingOn');
    expect(r.num('StatusWord') & (Z_READY_SWITCH_ON | Z_NO_OFF2 | Z_NO_OFF3 | Z_CTRL_REQ))
      .toBe(Z_READY_SWITCH_ON | Z_NO_OFF2 | Z_NO_OFF3 | Z_CTRL_REQ);
    r.tick(RUN_WORD);
    expect(r.behavior.State).toBe('ReadyToOperate');
    r.tick(RUN_WORD);
    expect(r.behavior.State).toBe('Operation');
    expect(r.num('StatusWord') & (Z_READY_OPERATE | Z_OP_ENABLED)).toBe(Z_READY_OPERATE | Z_OP_ENABLED);
  });

  it('applies NSOLL_A: 0x4000 = 100 % of ReferenceSpeed, negative reverses, STW1.11 inverts', () => {
    const r = speedRig({ ReferenceSpeed: 1500 });
    r.enable(0x4000);
    expect(r.drive.targetSpeed).toBeCloseTo(1500, 6);
    expect(r.drive.jogForward).toBe(true);
    expect(r.drive.jogBackward).toBe(false);

    r.tick(RUN_WORD, -0x2000);
    expect(r.drive.targetSpeed).toBeCloseTo(750, 6);
    expect(r.drive.jogBackward).toBe(true);

    r.tick(RUN_WORD | INVERT, 0x2000);
    expect(r.drive.jogBackward).toBe(true);
    expect(r.drive.jogForward).toBe(false);
  });

  it('honours SetpointScale for the ABB Drives profile (REF1 = 20000)', () => {
    const r = speedRig({ ReferenceSpeed: 100, SetpointScale: 20000 });
    r.enable(10000);
    expect(r.drive.targetSpeed).toBeCloseTo(50, 6);
  });

  it('holds zero speed in operation while the setpoint is not enabled', () => {
    const r = speedRig();
    r.enable(0x4000);
    expect(r.drive.jogForward).toBe(true);
    r.tick(RUN_WORD & ~ENABLE_SETPOINT, 0x4000);
    expect(r.behavior.State).toBe('Operation');
    expect(r.drive.jogForward).toBe(false);
    expect(r.drive.jogBackward).toBe(false);
  });

  it('OFF2 coasts immediately back to inhibited, OFF3 ramps down first', () => {
    const r = speedRig();
    r.enable(0x4000);
    r.tick(RUN_WORD & ~NO_OFF2, 0x4000);
    expect(r.behavior.State).toBe('SwitchingOnInhibited');
    expect(r.drive.jogForward).toBe(false);

    const r2 = speedRig();
    r2.enable(0x4000);
    r2.drive.currentSpeed = 50; // still moving when OFF3 arrives
    r2.tick(RUN_WORD & ~NO_OFF3, 0x4000);
    expect(r2.behavior.State).toBe('Operation'); // not yet at standstill
    expect(r2.drive.jogForward).toBe(false);
    r2.drive.currentSpeed = 0;
    r2.tick(RUN_WORD & ~NO_OFF3, 0x4000);
    expect(r2.behavior.State).toBe('SwitchingOnInhibited');
  });

  it('fault is sticky and cleared only by a RISING edge of STW1.7 once SimulateFault is off', () => {
    const r = speedRig();
    r.enable(0x4000);
    r.behavior.SimulateFault = true;
    r.tick(RUN_WORD, 0x4000);
    expect(r.behavior.State).toBe('Fault');
    expect(r.num('StatusWord') & Z_FAULT).toBe(Z_FAULT);
    expect(r.drive.jogForward).toBe(false);

    r.behavior.SimulateFault = false;
    r.tick(RUN_WORD | ACK, 0x4000); // rising edge — wait, the previous tick had ACK low
    expect(r.behavior.State).toBe('SwitchingOnInhibited');
    r.tick(RUN_WORD | ACK, 0x4000); // held high: no second edge, and ON is set → stays inhibited
    expect(r.behavior.State).toBe('SwitchingOnInhibited');
  });

  it('reports setpoint reached and NIST_A with the setpoint scale', () => {
    const r = speedRig({ ReferenceSpeed: 100 });
    r.enable(0x4000);
    r.drive.currentSpeed = 100;
    r.tick(RUN_WORD, 0x4000);
    expect(r.num('StatusWord') & Z_SETPOINT_REACHED).toBe(Z_SETPOINT_REACHED);
    expect(r.num('SpeedActual')).toBe(0x4000);
    r.drive.currentSpeed = -50;
    r.tick(RUN_WORD, 0x4000);
    expect(r.num('SpeedActual')).toBe(-0x2000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

const POS_SIGNALS: SignalSpec = {
  ControlWord: 'PLCOutputInt',
  PosControlWord1: 'PLCOutputInt',
  PosControlWord2: 'PLCOutputInt',
  Override: 'PLCOutputInt',
  MdiTargetPosition: 'PLCOutputInt',
  MdiVelocity: 'PLCOutputInt',
  StatusWord: 'PLCInputInt',
  PosStatusWord1: 'PLCInputInt',
  PosStatusWord2: 'PLCInputInt',
  PositionActual: 'PLCInputInt',
  SpeedActual: 'PLCInputInt',
};

// STW1 telegram 111 bits (4 = do not reject task, 5 = no intermediate stop, 6 = activate traversing)
const NO_REJECT = 1 << 4;
const NO_INTERMEDIATE_STOP = 1 << 5;
const ACTIVATE = 1 << 6;
const POS_READY = NO_OFF2 | NO_OFF3 | ENABLE_OP | NO_REJECT | NO_INTERMEDIATE_STOP | CTRL_PLC;
const POS_RUN = POS_READY | ON_OFF1;

// POS_STW1 bits
const MDI_ABS = 1 << 8;
const MDI_DIR_POS = 1 << 9;
const MDI_DIR_NEG = 1 << 10;
const MDI_CONTINUOUS = 1 << 12;
const MDI_SETUP = 1 << 14;
const MDI_MODE = 1 << 15;

// ZSW1 / POS_ZSW2 bits
const Z_TARGET_REACHED = 1 << 10;
const Z_REF_SET = 1 << 11;
const Z_STANDSTILL = 1 << 13;
const PZ_FWD = 1 << 4;
const PZ_BWD = 1 << 5;
const PZ_ACTIVE = 1 << 15;

function posRig(overrides: Record<string, unknown> = {}) {
  const r = buildBehaviorRig<RVDriveProfidrivePos>('Drive_ProfidrivePos', POS_SIGNALS, overrides);
  r.set('Override', 0x4000);
  const tick = (stw1: number, posStw1 = 0, posStw2 = 0) => {
    r.set('ControlWord', stw1);
    r.set('PosControlWord1', posStw1);
    r.set('PosControlWord2', posStw2);
    r.behavior.update(1 / 60);
  };
  const enable = () => { tick(POS_READY); tick(POS_RUN); tick(POS_RUN); };
  return { ...r, tick, enable };
}

describe('RVDriveProfidrivePos', () => {
  it('walks the same state machine into operation and reports standstill + following error ok', () => {
    const r = posRig();
    r.enable();
    expect(r.behavior.State).toBe('Operation');
    const zsw = r.num('StatusWord');
    expect(zsw & Z_OP_ENABLED).toBe(Z_OP_ENABLED);
    expect(zsw & Z_STANDSTILL).toBe(Z_STANDSTILL);
    expect(zsw & (1 << 8)).toBe(1 << 8);
    expect(r.num('PosStatusWord1')).toBe(zsw); // POS_ZSW1 mirrors ZSW1
  });

  it('jog 1 / jog 2 jog at JogSpeed, jog 1 wins when both are set', () => {
    const r = posRig({ JogSpeed: 33 });
    r.enable();
    r.tick(POS_RUN | JOG2);
    expect(r.drive.targetSpeed).toBe(33);
    expect(r.drive.jogBackward).toBe(true);
    r.tick(POS_RUN | JOG1 | JOG2);
    expect(r.drive.jogForward).toBe(true);
    expect(r.drive.jogBackward).toBe(false);
    expect(r.num('StatusWord') & Z_TARGET_REACHED).toBe(0); // never "reached" while jogging
  });

  it('MDI absolute positioning on the rising edge of STW1.6 scales MDI_TARPOS and MDI_VELOCITY', () => {
    const r = posRig({ PositionScale: 0.01, PositionOffset: 5, VelocityScale: 2 });
    r.enable();
    r.set('MdiTargetPosition', 12000); // 120 mm + offset 5
    r.set('MdiVelocity', 150);          // 300 mm/s
    r.tick(POS_RUN | ACTIVATE, MDI_MODE | MDI_ABS);
    expect(r.drive.targetPosition).toBeCloseTo(125, 6);
    expect(r.drive.targetSpeed).toBeCloseTo(300, 6);
    expect(r.drive.isRunning).toBe(true);

    // Held high: no second start, a new target is ignored until the next edge.
    r.set('MdiTargetPosition', 1);
    r.tick(POS_RUN | ACTIVATE, MDI_MODE | MDI_ABS);
    expect(r.drive.targetPosition).toBeCloseTo(125, 6);
  });

  it('MDI relative positioning adds to the current position and applies the override', () => {
    const r = posRig();
    r.enable();
    r.drive.currentPosition = 40;
    r.set('MdiTargetPosition', 10);
    r.set('MdiVelocity', 100);
    r.set('Override', 0x2000); // 50 %
    r.tick(POS_RUN | ACTIVATE, MDI_MODE);
    expect(r.drive.targetPosition).toBeCloseTo(50, 6);
    expect(r.drive.targetSpeed).toBeCloseTo(50, 6);
  });

  it('continuous transfer (POS_STW1.12) restarts on every tick without an edge', () => {
    const r = posRig();
    r.enable();
    r.set('MdiTargetPosition', 10);
    r.tick(POS_RUN, MDI_MODE | MDI_ABS | MDI_CONTINUOUS);
    expect(r.drive.targetPosition).toBe(10);
    r.set('MdiTargetPosition', 20);
    r.tick(POS_RUN, MDI_MODE | MDI_ABS | MDI_CONTINUOUS);
    expect(r.drive.targetPosition).toBe(20);
  });

  it('setup mode travels endlessly in the selected direction', () => {
    const r = posRig();
    r.enable();
    r.set('MdiVelocity', 80);
    r.tick(POS_RUN, MDI_MODE | MDI_SETUP | MDI_DIR_NEG);
    expect(r.drive.jogBackward).toBe(true);
    expect(r.drive.targetSpeed).toBeCloseTo(80, 6);
    r.tick(POS_RUN, MDI_MODE | MDI_SETUP | MDI_DIR_POS | MDI_DIR_NEG); // both set: no direction
    expect(r.drive.jogForward).toBe(false);
    expect(r.drive.jogBackward).toBe(false);
  });

  it('reject task (STW1.4 = 0) and intermediate stop (STW1.5 = 0) brake without leaving operation', () => {
    const r = posRig();
    r.enable();
    r.tick(POS_RUN | JOG1);
    expect(r.drive.jogForward).toBe(true);
    r.tick((POS_RUN | JOG1) & ~NO_INTERMEDIATE_STOP);
    expect(r.drive.jogForward).toBe(false);
    expect(r.behavior.State).toBe('Operation');
    r.tick((POS_RUN | JOG1) & ~NO_REJECT);
    expect(r.drive.jogForward).toBe(false);
    expect(r.behavior.State).toBe('Operation');
  });

  it('homing and "set reference point" (POS_STW2.1 rising) set ZSW1.11', () => {
    const r = posRig();
    r.enable();
    expect(r.num('StatusWord') & Z_REF_SET).toBe(0);
    r.tick(POS_RUN, 0, 1 << 1);
    expect(r.num('StatusWord') & Z_REF_SET).toBe(Z_REF_SET);

    const r2 = posRig();
    r2.enable();
    r2.tick(POS_RUN | HOMING);
    expect(r2.num('StatusWord') & Z_REF_SET).toBe(Z_REF_SET);
  });

  it('feedback: XIST_A in LU with offset, NIST_B 0x40000000 = 100 %, POS_ZSW2 direction bits', () => {
    const r = posRig({ PositionScale: 0.5, PositionOffset: 10, ReferenceSpeed: 200 });
    r.enable();
    r.drive.currentPosition = 60; // (60 - 10) / 0.5 = 100 LU
    r.drive.currentSpeed = 100;   // 50 % → 0x20000000
    r.tick(POS_RUN);
    expect(r.num('PositionActual')).toBe(100);
    expect(r.num('SpeedActual')).toBe(0x20000000);
    expect(r.num('PosStatusWord2') & (PZ_FWD | PZ_ACTIVE)).toBe(PZ_FWD | PZ_ACTIVE);
    expect(r.num('StatusWord') & (1 << 14)).toBe(1 << 14); // accelerating (0 → 100)
    r.drive.currentSpeed = -100;
    r.tick(POS_RUN);
    expect(r.num('PosStatusWord2') & PZ_BWD).toBe(PZ_BWD);
    expect(r.num('SpeedActual')).toBe(-0x20000000);
  });
});
