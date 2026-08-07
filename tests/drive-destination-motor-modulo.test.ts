// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * drive-destination-motor-modulo.test.ts — Plan 232, Phase 1 (Step B), §9.5.
 *
 * Turntable shortest-path normalization (F8): for a rotary axis the commanded
 * destination is wrapped to the shortest path relative to the current position.
 */

import { describe, it, expect } from 'vitest';
import { makeMotorFixture } from './_destination-motor-fixture';

describe('RVDriveDestinationMotor modulo / shortest path (plan-232 F8)', () => {
  it('rotary: 350° → 10° turns +20° (not -340°)', () => {
    const { drive, store } = makeMotorFixture({ rotary: true, startPosition: 350 });
    expect(drive.currentPosition).toBe(350);
    store.set('DriveNode.Destination', 10);    // command 10°
    // targetPosition = 350 + wrap(10 - 350) = 350 + 20 = 370
    expect(drive.targetPosition).toBeCloseTo(370, 6);
  });

  it('rotary: 10° → 350° turns -20° (not +340°)', () => {
    const { drive, store } = makeMotorFixture({ rotary: true, startPosition: 10 });
    store.set('DriveNode.Destination', 350);
    // targetPosition = 10 + wrap(350 - 10) = 10 + (-20) = -10
    expect(drive.targetPosition).toBeCloseTo(-10, 6);
  });

  it('rotary: command > 360° wraps onto shortest path', () => {
    const { drive, store } = makeMotorFixture({ rotary: true, startPosition: 0 });
    store.set('DriveNode.Destination', 370);   // 370° == 10°
    // wrap(370 - 0) = 10 → target 10
    expect(drive.targetPosition).toBeCloseTo(10, 6);
  });

  it('rotary: exact 180° delta wraps consistently', () => {
    const { drive, store } = makeMotorFixture({ rotary: true, startPosition: 0 });
    store.set('DriveNode.Destination', 180);
    expect(drive.targetPosition).toBeCloseTo(180, 6);
  });

  it('linear axis is NOT wrapped (passes through unchanged)', () => {
    const { drive, store } = makeMotorFixture({ rotary: false });
    store.set('DriveNode.Destination', 350);
    expect(drive.targetPosition).toBeCloseTo(350, 6);
  });
});
