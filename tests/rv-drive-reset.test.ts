// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-drive-reset.test.ts — RVDrive.reset() restores the authored start pose.
 *
 * `resetSimulation()` calls `drive.reset()` on every drive so a fresh run looks
 * exactly like a reload: position back to StartPosition, no speed, not running,
 * jog cleared for every drive. Drive behaviors may issue a new command afterward.
 */

import { describe, it, expect } from 'vitest';
import { Object3D } from 'three';
import { RVDrive, DriveDirection } from '../src/core/engine/rv-drive';

function makeLinearDrive(start = 0): RVDrive {
  const node = new Object3D();
  node.name = 'Drive-Lin-X';
  const drive = new RVDrive(node);
  drive.Direction = DriveDirection.LinearX;
  drive.StartPosition = start;
  drive.TargetSpeed = 200;
  drive.initDrive();
  return drive;
}

describe('RVDrive.reset()', () => {
  it('restores currentPosition to StartPosition after motion', () => {
    const drive = makeLinearDrive(50);
    drive.startMove(500);
    drive.update(1); // advances toward 500 at 200 mm/s
    expect(drive.currentPosition).toBeGreaterThan(50);

    drive.reset();
    expect(drive.currentPosition).toBe(50);
    expect(drive.targetPosition).toBe(50);
    expect(drive.currentSpeed).toBe(0);
    expect(drive.isRunning).toBe(false);
  });

  it('re-seeds targetSpeed from TargetSpeed', () => {
    const drive = makeLinearDrive(0);
    drive.targetSpeed = 0; // simulate a mid-run change
    drive.reset();
    expect(drive.targetSpeed).toBe(200);
  });

  it('clears jog flags for a positioning drive', () => {
    const drive = makeLinearDrive(0);
    drive.jogForward = true;
    drive.reset();
    expect(drive.jogForward).toBe(false);
    expect(drive.jogBackward).toBe(false);
  });

  it('clears jog flags for a transport-surface drive too', () => {
    const drive = makeLinearDrive(0);
    drive.isTransportSurface = true;
    drive.jogForward = true;
    drive.reset();
    expect(drive.jogForward).toBe(false);
    expect(drive.jogBackward).toBe(false);
  });

  it('snaps the Three.js node transform back to the start pose', () => {
    const drive = makeLinearDrive(100);
    // The authored "home" pose is whatever initDrive() applied for StartPosition.
    const homeX = drive.node.position.x;
    expect(homeX).not.toBe(0); // StartPosition 100 mm offsets the node

    drive.startMove(900);
    drive.update(1);
    const movedX = drive.node.position.x;
    expect(movedX).not.toBeCloseTo(homeX, 6);

    drive.reset();
    expect(drive.node.position.x).toBeCloseTo(homeX, 6);
  });

  it('clears positionOverwrite mode', () => {
    const drive = makeLinearDrive(0);
    drive.positionOverwrite = true;
    drive.reset();
    expect(drive.positionOverwrite).toBe(false);
  });
});
