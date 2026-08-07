// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * drive-destination-motor-move.test.ts — Plan 232, Phase 1 (Step B), §9.1.
 *
 * Destination + StartDrive → drive moves → feedback (IsAtPosition with
 * Scale/Offset, IsAtDestination, IsDriving, IsAtSpeed).
 */

import { describe, it, expect } from 'vitest';
import { makeMotorFixture, tickDrive } from './_destination-motor-fixture';

describe('RVDriveDestinationMotor move + feedback (plan-232 Phase 1)', () => {
  it('moves to Destination on StartDrive and reaches it', () => {
    const { drive, store } = makeMotorFixture();
    store.set('DriveNode.Destination', 90);   // command 90mm
    store.set('DriveNode.StartDrive', true);   // rising edge → startMove()
    expect(drive.isRunning).toBe(true);

    tickDrive(drive, 100);
    expect(drive.isAtTarget).toBe(true);
    expect(drive.currentPosition).toBeCloseTo(90, 3);
  });

  it('writes feedback signals: IsAtDestination, IsAtPosition, IsDriving', () => {
    const { drive, store } = makeMotorFixture();
    store.set('DriveNode.Destination', 50);
    store.set('DriveNode.StartDrive', true);

    // mid-move: IsDriving true after at least one tick
    drive.update(0.001);
    expect(store.getBool('DriveNode.IsDriving')).toBe(true);
    expect(store.getBool('DriveNode.IsAtDestination')).toBe(false);

    tickDrive(drive, 200);
    expect(store.getBool('DriveNode.IsAtDestination')).toBe(true);
    expect(store.getBool('DriveNode.IsDriving')).toBe(false);
    expect(store.getFloat('DriveNode.IsAtPosition')).toBeCloseTo(50, 1);
  });

  it('applies Scale and Offset to command and feedback (Scale != 1, Offset != 0)', () => {
    // Command = raw * Scale + Offset; feedback = (pos - Offset)/Scale.
    const { drive, store } = makeMotorFixture({ scale: 2, offset: 10 });
    store.set('DriveNode.Destination', 40);     // → targetPosition = 40*2 + 10 = 90
    store.set('DriveNode.StartDrive', true);

    tickDrive(drive, 200);
    expect(drive.currentPosition).toBeCloseTo(90, 1);
    // feedback maps back: (90 - 10)/2 = 40
    expect(store.getFloat('DriveNode.IsAtPosition')).toBeCloseTo(40, 1);
  });

  it('ScaleFeedbackPosition=false reports raw current position', () => {
    const { drive, store } = makeMotorFixture({ scale: 2, offset: 10, scaleFeedback: false });
    store.set('DriveNode.Destination', 40);
    store.set('DriveNode.StartDrive', true);
    tickDrive(drive, 200);
    expect(store.getFloat('DriveNode.IsAtPosition')).toBeCloseTo(drive.currentPosition, 3);
  });

  it('TargetSpeed and Acceleration signals are forwarded to the drive', () => {
    const { drive, store } = makeMotorFixture();
    store.set('DriveNode.TargetSpeed', 250);
    store.set('DriveNode.Acceleration', 500);
    expect(drive.targetSpeed).toBe(250);
    expect(drive.Acceleration).toBe(500);
    expect(drive.UseAcceleration).toBe(true);
  });
});
