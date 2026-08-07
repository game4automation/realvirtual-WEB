// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it } from 'vitest';
import { Object3D } from 'three';
import { RVDrive } from '../src/core/engine/rv-drive';
import { RVLogicEngine } from '../src/core/engine/rv-logic-engine';
import { RVDriveTo, StepState } from '../src/core/engine/rv-logic-step';

describe('LogicStep suppression status', () => {
  it('exposes suppressed-live and clears it on reset', () => {
    const drive = new RVDrive(new Object3D());
    drive.initDrive();
    drive.liveControlled = true;
    const step = new RVDriveTo(drive, 10, false);
    step.start();
    const engine = new RVLogicEngine();
    engine.stepByPath.set('Logic/Move', step);

    expect(engine.getStepInfo('Logic/Move')).toMatchObject({
      state: StepState.Finished,
      reason: 'suppressed-live',
    });
    step.reset();
    expect(engine.getStepInfo('Logic/Move')?.reason).toBeUndefined();
  });
});
