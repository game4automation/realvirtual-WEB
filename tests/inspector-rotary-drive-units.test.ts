// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * The rv-ODT schema declares Drive units for a LINEAR axis (`mm`, `mm/s`,
 * `mm/s2`, `mm/s3`). A rotary drive stores the same fields in degrees, so the
 * inspector must follow `Drive.Direction` — a `RotationZ` drive read "mm" on
 * Offset, limits, speed and acceleration.
 */
import { describe, it, expect } from 'vitest';
// Registers the component schemas — the units must come from the schema, not the fallback table.
import '../src/core/engine/rv-scene-loader';
import { getFieldUnit } from '../src/core/hmi/rv-inspector-helpers';

describe('getFieldUnit — Drive units follow Direction', () => {
  it('a linear drive keeps the schema units', () => {
    const data = { Direction: 'LinearX' };
    expect(getFieldUnit('Drive', 'TargetPosition', data)).toBe('mm');
    expect(getFieldUnit('Drive', 'TargetSpeed', data)).toBe('mm/s');
    expect(getFieldUnit('Drive', 'Acceleration', data)).toBe('mm/s²');
    expect(getFieldUnit('Drive', 'Jerk', data)).toBe('mm/s³');
  });

  it('a rotary drive shows degrees with the same time part', () => {
    const data = { Direction: 'RotationZ' };
    expect(getFieldUnit('Drive', 'TargetPosition', data)).toBe('°');
    expect(getFieldUnit('Drive', 'LowerLimit', data)).toBe('°');
    expect(getFieldUnit('Drive', 'TargetSpeed', data)).toBe('°/s');
    expect(getFieldUnit('Drive', 'Acceleration', data)).toBe('°/s²');
    expect(getFieldUnit('Drive', 'Jerk', data)).toBe('°/s³');
  });

  it('without field data (or on a Virtual drive) the schema unit stands', () => {
    expect(getFieldUnit('Drive', 'TargetSpeed')).toBe('mm/s');
    expect(getFieldUnit('Drive', 'TargetSpeed', { Direction: 'Virtual' })).toBe('mm/s');
  });

  it('other components on the node are not touched', () => {
    expect(getFieldUnit('Source', 'GenerateIfDistance', { Direction: 'RotationZ' })).toBe('mm');
  });
});
