// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * RVDriveUniDriveMotor — port of Drive_UniDriveMotor.cs. Pins the Run gate,
 * the jog priority and speed selection, the rising-edge positioning start with
 * scaled integer setpoints, the 0-ramp guard and the integer feedback.
 */

import { describe, expect, it } from 'vitest';
import { RVDriveUniDriveMotor } from '../src/core/engine/rv-drive-unidrive-motor';
import { buildBehaviorRig, type SignalSpec } from './fixtures/drive-behavior-harness';

const SIGNALS: SignalSpec = {
  Run: 'PLCOutputBool',
  JogPlus: 'PLCOutputBool',
  JogMinus: 'PLCOutputBool',
  StartCalibration: 'PLCOutputBool',
  SpeedSelection: 'PLCOutputBool',
  StartPositioning: 'PLCOutputBool',
  ResetFault: 'PLCOutputBool',
  SetPosition: 'PLCOutputInt',
  SetSpeed: 'PLCOutputInt',
  SetAcceleration: 'PLCOutputInt',
  SetDeceleration: 'PLCOutputInt',
  IsReady: 'PLCInputBool',
  IsReferenced: 'PLCInputBool',
  IsAtPosition1: 'PLCInputBool',
  ActualPosition: 'PLCInputInt',
  ActualSpeed: 'PLCInputInt',
};

function rig(overrides: Record<string, unknown> = {}) {
  const r = buildBehaviorRig<RVDriveUniDriveMotor>('Drive_UniDriveMotor', SIGNALS, overrides);
  r.set('Run', true);
  r.set('SetSpeed', 100);
  r.set('SetAcceleration', 500);
  const tick = () => r.behavior.update(1 / 60);
  return { ...r, tick };
}

describe('RVDriveUniDriveMotor', () => {
  it('Run low stops the drive and holds it', () => {
    const r = rig();
    r.set('JogPlus', true);
    r.tick();
    expect(r.drive.jogForward).toBe(true);
    r.set('Run', false);
    r.tick();
    expect(r.drive.jogForward).toBe(false);
    expect(r.drive.isRunning).toBe(false);
  });

  it('jogs at SetupSpeed without SpeedSelection and at SetSpeed · SpeedScale with it; forward wins', () => {
    const r = rig({ SetupSpeed: 25, SpeedScale: 2 });
    r.set('JogMinus', true);
    r.tick();
    expect(r.drive.targetSpeed).toBe(25);
    expect(r.drive.jogBackward).toBe(true);

    r.set('SpeedSelection', true);
    r.tick();
    expect(r.drive.targetSpeed).toBe(200);

    r.set('JogPlus', true);
    r.tick();
    expect(r.drive.jogForward).toBe(true);
    expect(r.drive.jogBackward).toBe(false);
    expect(r.bool('IsAtPosition1')).toBe(false); // never "at position" while jogging
  });

  it('positions on the rising edge of StartPositioning with scaled position, speed and ramp', () => {
    const r = rig({ PositionScale: 0.5, PositionOffset: 3, SpeedScale: 0.1, AccelerationScale: 10 });
    r.set('SetPosition', 200); // 100 + 3
    r.set('SetSpeed', 1500);   // 150 mm/s
    r.set('SetAcceleration', 80); // 800 mm/s²
    r.set('SetDeceleration', 40);
    r.set('StartPositioning', true);
    r.tick();
    expect(r.drive.targetPosition).toBeCloseTo(103, 6);
    expect(r.drive.targetSpeed).toBeCloseTo(150, 6);
    expect(r.drive.Acceleration).toBeCloseTo(800, 6);
    expect(r.behavior.CurrentDeceleration).toBeCloseTo(400, 6);
    expect(r.drive.isRunning).toBe(true);

    // Held high: no second start even when the setpoint changes.
    r.drive.isRunning = false;
    r.set('SetPosition', 10);
    r.tick();
    expect(r.drive.isRunning).toBe(false);
    expect(r.drive.targetPosition).toBeCloseTo(8, 6); // setpoint is still forwarded
  });

  it('ignores a zero acceleration ramp from the PLC', () => {
    const r = rig();
    r.drive.Acceleration = 123;
    r.set('SetAcceleration', 0);
    r.tick();
    expect(r.drive.Acceleration).toBe(123);
  });

  it('feedback: ready / referenced from the settings, integer position and speed', () => {
    const r = rig({ PositionScale: 0.25, PositionOffset: 1, SpeedScale: 0.5 });
    r.drive.currentPosition = 26; // (26 - 1) / 0.25 = 100
    r.drive.currentSpeed = 7.4;   // / 0.5 = 14.8 → 15
    r.tick();
    expect(r.bool('IsReady')).toBe(true);
    expect(r.bool('IsReferenced')).toBe(true);
    expect(r.num('ActualPosition')).toBe(100);
    expect(r.num('ActualSpeed')).toBe(15);

    r.behavior.Ready = false;
    r.behavior.Referenced = false;
    r.tick();
    expect(r.bool('IsReady')).toBe(false);
    expect(r.bool('IsReferenced')).toBe(false);
  });

  it('IsAtPosition1 follows the drive being at its target while not jogging', () => {
    const r = rig();
    r.set('SetPosition', 50);
    r.set('StartPositioning', true);
    r.tick();
    expect(r.bool('IsAtPosition1')).toBe(false);
    r.drive.currentPosition = 50;
    r.tick();
    expect(r.bool('IsAtPosition1')).toBe(true);
  });
});
