// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * drive-feedback-chaining.test.ts — Plan 232, Phase 3 (Step A).
 *
 * Validates the `addAfterUpdate` callback LIST replacing the old single-slot
 * `onAfterUpdate`: two behaviors on the SAME drive must both receive feedback
 * ticks without one overwriting the other (R6). Also covers the deprecated
 * setter shim + `removeAfterUpdate`.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Object3D } from 'three';
import { RVDrive, DriveDirection } from '../src/core/engine/rv-drive';

function makeDrive(): RVDrive {
  const node = new Object3D();
  node.name = 'DriveNode';
  const drive = new RVDrive(node);
  drive.Direction = DriveDirection.LinearX;
  drive.UseAcceleration = false;
  drive.TargetSpeed = 1000;
  drive.initDrive();
  return drive;
}

describe('Drive addAfterUpdate chaining (plan-232 Phase 3)', () => {
  let drive: RVDrive;

  beforeEach(() => {
    drive = makeDrive();
  });

  it('runs BOTH registered afterUpdate callbacks on a normal update tick', () => {
    let a = 0;
    let b = 0;
    drive.addAfterUpdate(() => { a++; });
    drive.addAfterUpdate(() => { b++; });

    drive.startMove(50);
    drive.update(0.016);

    expect(a).toBe(1);
    expect(b).toBe(1);
  });

  it('runs both callbacks on the stop-at-target tick', () => {
    let a = 0;
    let b = 0;
    drive.addAfterUpdate(() => { a++; });
    drive.addAfterUpdate(() => { b++; });

    // Target is within one step so the drive reaches it and stops this tick.
    drive.startMove(0.001);
    drive.update(1.0);

    expect(drive.isRunning).toBe(false);
    expect(a).toBeGreaterThanOrEqual(1);
    expect(b).toBeGreaterThanOrEqual(1);
    expect(a).toBe(b);
  });

  it('runs both callbacks in positionOverwrite mode', () => {
    let a = 0;
    let b = 0;
    drive.addAfterUpdate(() => { a++; });
    drive.addAfterUpdate(() => { b++; });

    drive.positionOverwrite = true;
    drive.currentPosition = 10;
    drive.update(0.016);

    expect(a).toBe(1);
    expect(b).toBe(1);
  });

  it('deprecated onAfterUpdate setter APPENDS (does not clobber a sibling)', () => {
    let a = 0;
    let b = 0;
    drive.addAfterUpdate(() => { a++; });
    // Legacy assignment must NOT replace the first callback.
    drive.onAfterUpdate = () => { b++; };

    drive.startMove(50);
    drive.update(0.016);

    expect(a).toBe(1);
    expect(b).toBe(1);
    // Getter returns the last registered callback (the legacy one).
    expect(drive.onAfterUpdate).not.toBeNull();
  });

  it('removeAfterUpdate detaches one callback only', () => {
    let a = 0;
    let b = 0;
    const cbA = () => { a++; };
    const cbB = () => { b++; };
    drive.addAfterUpdate(cbA);
    drive.addAfterUpdate(cbB);

    drive.removeAfterUpdate(cbA);

    drive.startMove(50);
    drive.update(0.016);

    expect(a).toBe(0);
    expect(b).toBe(1);
  });

  it('addAfterUpdate is idempotent (no duplicate dispatch)', () => {
    let a = 0;
    const cb = () => { a++; };
    drive.addAfterUpdate(cb);
    drive.addAfterUpdate(cb);

    drive.startMove(50);
    drive.update(0.016);

    expect(a).toBe(1);
  });
});
