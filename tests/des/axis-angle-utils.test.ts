// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it } from 'vitest';
import { DriveDirection } from '../../src/core/engine/rv-drive';
import {
  axisTargetPosition,
  unwrapAngleToReference,
  validateAxisPos,
} from '../../src/core/engine/rv-axis-angle-utils';

describe('axis angle utils', () => {
  it('unwraps +170 to -170 by the nearest representation', () => {
    const drive = { Direction: DriveDirection.RotationZ, currentPosition: 170, UseLimits: false, LowerLimit: -360, UpperLimit: 360 };
    expect(axisTargetPosition(-170, drive)).toBe(190);
  });

  it('passes linear axes through and respects rotary limits', () => {
    const linear = { Direction: DriveDirection.LinearX, currentPosition: 170, UseLimits: true, LowerLimit: -180, UpperLimit: 180 };
    expect(axisTargetPosition(-170, linear)).toBe(-170);
    expect(unwrapAngleToReference(-170, 170, { UseLimits: true, LowerLimit: -180, UpperLimit: 180 })).toBe(-170);
  });

  it('rejects NaN and wrong count but accepts an explicit all-zero pose', () => {
    expect(validateAxisPos([0, 0, 0], 3)).toBe(true);
    expect(validateAxisPos([0, Number.NaN, 0], 3)).toBe(false);
    expect(validateAxisPos([0, 0], 3)).toBe(false);
  });
});
