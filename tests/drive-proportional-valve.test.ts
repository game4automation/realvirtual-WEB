// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * RVDriveProportionalValve — port of Drive_ProportionalValve.cs. Pins setpoint
 * scaling, the dead band rescale, hysteresis, the spool response ramp, the flow
 * exponent (the stand-in for Unity's FlowCurve) and the speed / direction mapping.
 */

import { describe, expect, it } from 'vitest';
import { RVDriveProportionalValve } from '../src/core/engine/rv-drive-proportional-valve';
import { buildBehaviorRig, type SignalSpec } from './fixtures/drive-behavior-harness';

const SIGNALS: SignalSpec = {
  SignalSetpoint: 'PLCOutputFloat',
  SignalSpoolPosition: 'PLCInputFloat',
  SignalCurrentSpeed: 'PLCInputFloat',
  SignalCurrentPosition: 'PLCInputFloat',
};

function rig(overrides: Record<string, unknown> = {}) {
  // ResponseTime 0 by default in the tests so the spool follows instantly.
  const r = buildBehaviorRig<RVDriveProportionalValve>('Drive_ProportionalValve', SIGNALS, { ResponseTime: 0, ...overrides });
  const tick = (setpoint: number, dt = 1 / 60) => {
    r.set('SignalSetpoint', setpoint);
    r.behavior.update(dt);
  };
  return { ...r, tick };
}

describe('RVDriveProportionalValve', () => {
  it('scales ±10 V to a −1..1 command and maps flow to speed and direction', () => {
    const r = rig({ Deadband: 0, MaxSpeed: 200 });
    r.tick(10);
    expect(r.behavior.Flow).toBeCloseTo(1, 6);
    expect(r.drive.targetSpeed).toBeCloseTo(200, 6);
    expect(r.drive.jogForward).toBe(true);
    r.tick(-5);
    expect(r.behavior.Flow).toBeCloseTo(-0.5, 6);
    expect(r.drive.targetSpeed).toBeCloseTo(100, 6);
    expect(r.drive.jogBackward).toBe(true);
    expect(r.drive.jogForward).toBe(false);
    r.tick(0);
    expect(r.drive.jogForward).toBe(false);
    expect(r.drive.jogBackward).toBe(false);
  });

  it('supports 4–20 mA scaling (12 mA = neutral) and clamps beyond full scale', () => {
    const r = rig({ SetpointZero: 12, SetpointFull: 20, Deadband: 0 });
    r.tick(16);
    expect(r.behavior.Command).toBeCloseTo(0.5, 6);
    r.tick(4);
    expect(r.behavior.Command).toBeCloseTo(-1, 6);
    r.tick(30);
    expect(r.behavior.Command).toBeCloseTo(1, 6);
  });

  it('dead band: below it no flow, above it the command is rescaled to start at zero', () => {
    const r = rig({ Deadband: 0.2 });
    r.tick(1.5); // 15 % < 20 %
    expect(r.behavior.Command).toBe(0);
    expect(r.drive.jogForward).toBe(false);
    r.tick(6); // 60 % → (0.6 - 0.2) / 0.8 = 0.5
    expect(r.behavior.Command).toBeCloseTo(0.5, 6);
    r.tick(-10);
    expect(r.behavior.Command).toBeCloseTo(-1, 6);
  });

  it('hysteresis holds the command until the change exceeds the band', () => {
    const r = rig({ Deadband: 0, EnableHysteresis: true, Hysteresis: 0.1 });
    r.tick(5);
    expect(r.behavior.SpoolPosition).toBeCloseTo(0.5, 6);
    r.tick(5.5); // +0.05 < 0.1 → held
    expect(r.behavior.SpoolPosition).toBeCloseTo(0.5, 6);
    r.tick(6.5); // +0.15 ≥ 0.1 → follows
    expect(r.behavior.SpoolPosition).toBeCloseTo(0.65, 6);
  });

  it('spool response: full stroke takes ResponseTime seconds', () => {
    const r = rig({ Deadband: 0, ResponseTime: 0.5 });
    r.tick(10, 0.1);
    expect(r.behavior.SpoolPosition).toBeCloseTo(0.2, 6);
    r.tick(10, 0.1);
    expect(r.behavior.SpoolPosition).toBeCloseTo(0.4, 6);
    r.tick(10, 1);
    expect(r.behavior.SpoolPosition).toBeCloseTo(1, 6);
    r.tick(-10, 0.25);
    expect(r.behavior.SpoolPosition).toBeCloseTo(0.5, 6);
    expect(r.num('SignalSpoolPosition')).toBeCloseTo(0.5, 6);
  });

  it('FlowExponent shapes the characteristic (1 linear, 2 progressive) and keeps the sign', () => {
    const r = rig({ Deadband: 0, FlowExponent: 2 });
    r.tick(5);
    expect(r.behavior.Flow).toBeCloseTo(0.25, 6);
    r.tick(-5);
    expect(r.behavior.Flow).toBeCloseTo(-0.25, 6);
    const lin = rig({ Deadband: 0, FlowExponent: 1 });
    lin.tick(5);
    expect(lin.behavior.Flow).toBeCloseTo(0.5, 6);
  });

  it('writes speed and position feedback from the drive', () => {
    const r = rig();
    r.drive.currentSpeed = 12;
    r.drive.currentPosition = 34;
    r.tick(0);
    expect(r.num('SignalCurrentSpeed')).toBe(12);
    expect(r.num('SignalCurrentPosition')).toBe(34);
  });
});
