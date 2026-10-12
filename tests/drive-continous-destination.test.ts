// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * RVDriveContinousDestination — port of Drive_ContinousDestination.cs. Pins the
 * "destination change = start" rule, the command scaling and the feedback set.
 */

import { describe, expect, it } from 'vitest';
import { RVDriveContinousDestination } from '../src/core/engine/rv-drive-continous-destination';
import { buildBehaviorRig, type SignalSpec } from './fixtures/drive-behavior-harness';

const SIGNALS: SignalSpec = {
  SignalDestination: 'PLCOutputFloat',
  SignalAcceleration: 'PLCOutputFloat',
  SignalTargetSpeed: 'PLCOutputFloat',
  SignalIsAtPosition: 'PLCInputFloat',
  SignalIsAtSpeed: 'PLCInputFloat',
  SignalIsAtDestination: 'PLCInputBool',
  SignalIsDriving: 'PLCInputBool',
};

function rig(overrides: Record<string, unknown> = {}) {
  const r = buildBehaviorRig<RVDriveContinousDestination>('Drive_ContinousDestination', SIGNALS, overrides);
  r.set('SignalTargetSpeed', 100);
  r.set('SignalAcceleration', 100);
  const tick = () => r.behavior.update(1 / 60);
  return { ...r, tick };
}

describe('RVDriveContinousDestination', () => {
  it('starts a move whenever the destination changes and forwards speed / acceleration every tick', () => {
    const r = rig();
    r.tick(); // destination 0 == destinationBefore 0 → no start
    expect(r.drive.isRunning).toBe(false);

    r.set('SignalDestination', 120);
    r.set('SignalTargetSpeed', 250);
    r.set('SignalAcceleration', 900);
    r.tick();
    expect(r.drive.isRunning).toBe(true);
    expect(r.drive.targetPosition).toBe(120);
    expect(r.drive.targetSpeed).toBe(250);
    expect(r.drive.Acceleration).toBe(900);

    // Unchanged destination: no restart (a finished move stays finished).
    r.drive.isRunning = false;
    r.tick();
    expect(r.drive.isRunning).toBe(false);

    r.set('SignalDestination', 30);
    r.tick();
    expect(r.drive.isRunning).toBe(true);
    expect(r.drive.targetPosition).toBe(30);
  });

  it('applies CurrentPositionScale / Offset to the command and the position feedback', () => {
    const r = rig({ CurrentPositionScale: 0.5, CurrentPositionOffset: 10 });
    r.set('SignalDestination', 100); // 100 · 0.5 + 10
    r.tick();
    expect(r.drive.targetPosition).toBe(60);
    r.drive.currentPosition = 60;
    r.tick();
    expect(r.num('SignalIsAtPosition')).toBe(100); // (60 - 10) / 0.5
    r.behavior.ScaleFeedbackPosition = false;
    r.tick();
    expect(r.num('SignalIsAtPosition')).toBe(60);
  });

  it('writes IsAtDestination, IsDriving and IsAtSpeed from the drive state', () => {
    const r = rig();
    r.set('SignalDestination', 50);
    r.tick();
    expect(r.bool('SignalIsDriving')).toBe(true);
    expect(r.bool('SignalIsAtDestination')).toBe(false);
    r.drive.currentPosition = 50;
    r.drive.currentSpeed = 12.5;
    r.drive.isRunning = false;
    r.tick();
    expect(r.bool('SignalIsAtDestination')).toBe(true);
    expect(r.bool('SignalIsDriving')).toBe(false);
    expect(r.num('SignalIsAtSpeed')).toBe(12.5);
  });
});
