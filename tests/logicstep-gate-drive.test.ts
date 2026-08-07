// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it } from 'vitest';
import { Object3D } from 'three';
import { RVDrive } from '../src/core/engine/rv-drive';
import {
  RVDriveTo, RVSetDriveSpeed, RVStartDriveTo, RVWaitForDrivesAtTarget, StepState,
} from '../src/core/engine/rv-logic-step';

function drive(): RVDrive {
  const result = new RVDrive(new Object3D());
  result.TargetSpeed = 100;
  result.initDrive();
  return result;
}

describe('LogicStep drive live-control gate', () => {
  it('suppresses all drive writers and treats live drives as at target', () => {
    const d = drive();
    d.liveControlled = true;
    const blocking = new RVDriveTo(d, 100, false);
    const start = new RVStartDriveTo(d, 100, false);
    const speed = new RVSetDriveSpeed(d, 500);
    const wait = new RVWaitForDrivesAtTarget([d]);

    blocking.start();
    start.start();
    speed.start();
    wait.start();

    expect(blocking.reason).toBe('suppressed-live');
    expect(start.reason).toBe('suppressed-live');
    expect(speed.reason).toBe('suppressed-live');
    expect(d.isRunning).toBe(false);
    expect(d.targetSpeed).toBe(100);
    expect(wait.state).toBe(StepState.Finished);
  });
});
