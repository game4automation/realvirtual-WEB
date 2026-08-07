// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it } from 'vitest';
import { Object3D } from 'three';
import { RVDrive } from '../src/core/engine/rv-drive';
import { RVDelay, RVDriveTo, RVSerialContainer, StepState } from '../src/core/engine/rv-logic-step';

describe('mid-step live handover', () => {
  it('stops a blocking drive step as suppressed and advances its serial container', () => {
    const drive = new RVDrive(new Object3D());
    drive.TargetSpeed = 100;
    drive.initDrive();
    const move = new RVDriveTo(drive, 100, false);
    const container = new RVSerialContainer([move, new RVDelay(1)], false);

    container.start();
    expect(drive.isRunning).toBe(true);
    drive.stop();
    drive.liveControlled = true;
    container.fixedUpdate(1 / 60);

    expect(move.state).toBe(StepState.Finished);
    expect(move.reason).toBe('suppressed-live');
    expect(container.currentIndex).toBe(1);
    expect(container.children[1].state).toBe(StepState.Active);
  });
});
