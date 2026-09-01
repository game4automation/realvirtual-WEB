// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-odt-drive-smooth.test.ts — the rv-ODT surface of jerk-limited motion
 * (plan-281 F11, §2.6, §9.9).
 *
 * `SmoothAcceleration`, `Jerk`, `SpeedOverride` and `JumpToLowerLimitOnUpperLimit`
 * used to sit on the validator's "not implemented" list, which means they were
 * DROPPED at load: an authored jerk never reached the engine. They are now real
 * schema fields, and this file pins the three things that have to hold together
 * for that to stay true — the $def, the specification table and the validator —
 * plus the backward-compatibility rule that a GLB written before this change
 * still loads with its previous behaviour.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { Group } from 'three';
import { applySchema, loadSchemaFromSpec } from '../src/core/engine/rv-component-registry';
import { DriveDirection, RVDrive } from '../src/core/engine/rv-drive';
import {
  getConsumedFields,
  getIgnoredFields,
  printParitySummary,
  resetParityValidator,
  validateExtras,
} from '../src/core/engine/rv-extras-validator';
import rvOdt from '../schema/v1/rv-odt.json';
import specification from '../schema/v1/specification.md?raw';

const SMOOTH_FIELDS = ['SmoothAcceleration', 'Jerk', 'SpeedOverride', 'JumpToLowerLimitOnUpperLimit'] as const;

const driveDef = (rvOdt as unknown as {
  $defs: { Drive: { properties: Record<string, { type: string; default?: unknown; unit?: string }> } };
}).$defs.Drive.properties;

describe('rv-ODT Drive smooth-motion fields', () => {
  it('declares all four fields in the $def with the Unity defaults', () => {
    expect(driveDef.SmoothAcceleration).toMatchObject({ type: 'boolean', default: false });
    expect(driveDef.Jerk).toMatchObject({ type: 'number', default: 1000, unit: 'mm/s3' });
    expect(driveDef.SpeedOverride).toMatchObject({ type: 'number', default: 1 });
    expect(driveDef.JumpToLowerLimitOnUpperLimit).toMatchObject({ type: 'boolean', default: false });
  });

  it('loads them into the runtime schema', () => {
    const schema = loadSchemaFromSpec('Drive');
    for (const field of SMOOTH_FIELDS) {
      expect(schema[field], `${field} missing from the loaded Drive schema`).toBeDefined();
    }
    expect(schema.Jerk.default).toBe(1000);
    expect(schema.SpeedOverride.default).toBe(1);
  });

  it('documents them in specification.md — the human half of the contract', () => {
    for (const field of SMOOTH_FIELDS) {
      expect(specification, `${field} missing from specification.md`).toContain(`| \`${field}\` |`);
    }
  });

  it('matches the RVDrive field defaults exactly', () => {
    // A default that differs between spec and class silently changes behaviour
    // for every GLB that omits the field.
    const drive = new RVDrive(new Group());
    expect(drive.SmoothAcceleration).toBe(driveDef.SmoothAcceleration.default);
    expect(drive.Jerk).toBe(driveDef.Jerk.default);
    expect(drive.SpeedOverride).toBe(driveDef.SpeedOverride.default);
    expect(drive.JumpToLowerLimitOnUpperLimit).toBe(driveDef.JumpToLowerLimitOnUpperLimit.default);
  });
});

describe('applying authored smooth values', () => {
  it('reaches the component instead of being dropped', () => {
    const drive = new RVDrive(new Group());
    applySchema(drive as unknown as Record<string, unknown>, RVDrive.schema, {
      Direction: 'RotationZ',
      UseAcceleration: true,
      SmoothAcceleration: true,
      Jerk: 2500,
      SpeedOverride: 0.75,
      JumpToLowerLimitOnUpperLimit: true,
    });

    expect(drive.Direction).toBe(DriveDirection.RotationZ);
    expect(drive.SmoothAcceleration).toBe(true);
    expect(drive.Jerk).toBe(2500);
    expect(drive.SpeedOverride).toBe(0.75);
    expect(drive.JumpToLowerLimitOnUpperLimit).toBe(true);
    expect(drive.smoothRequested).toBe(true);
  });

  it('keeps the previous behaviour for a GLB written before this change', () => {
    // Backward compatibility: an old export carries none of the four fields.
    const drive = new RVDrive(new Group());
    applySchema(drive as unknown as Record<string, unknown>, RVDrive.schema, { Direction: 'LinearX', UseAcceleration: true, Acceleration: 300 });

    expect(drive.SmoothAcceleration).toBe(false);
    expect(drive.smoothRequested).toBe(false);
    expect(drive.Jerk).toBe(1000);
    expect(drive.SpeedOverride).toBe(1);
    expect(drive.JumpToLowerLimitOnUpperLimit).toBe(false);
  });

  it('does not enable smooth motion from SmoothAcceleration alone', () => {
    // Unity shows it as a sub-toggle of UseAcceleration; without the parent
    // there is no acceleration model at all to make jerk-limited.
    const drive = new RVDrive(new Group());
    applySchema(drive as unknown as Record<string, unknown>, RVDrive.schema, { SmoothAcceleration: true });
    expect(drive.smoothRequested).toBe(false);
  });
});

describe('rv_extras validator', () => {
  afterEach(() => {
    resetParityValidator();
    vi.restoreAllMocks();
  });

  it('treats the smooth fields as CONSUMED, not as ignored leftovers', () => {
    const consumed = getConsumedFields('Drive');
    const ignored = getIgnoredFields('Drive');
    for (const field of SMOOTH_FIELDS) {
      expect(consumed, `${field} must be consumed`).toContain(field);
      expect(ignored, `${field} must no longer be on the ignore list`).not.toContain(field);
    }
  });

  it('still ignores the serialized C# solver object', () => {
    // `smoothMotion` is Unity's internal SmoothMotion instance, not an end-user
    // property — it must stay out of rv-ODT (plan-281 §3.2).
    expect(getIgnoredFields('Drive')).toContain('smoothMotion');
    expect(getConsumedFields('Drive')).not.toContain('smoothMotion');
    expect(driveDef.smoothMotion).toBeUndefined();
  });

  it('reports nothing unhandled for a fully authored smooth drive', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    validateExtras('Drive', {
      Direction: 'LinearX',
      UseAcceleration: true,
      SmoothAcceleration: true,
      Jerk: 1500,
      SpeedOverride: 1,
      JumpToLowerLimitOnUpperLimit: false,
      smoothMotion: { maxVelocity: 500, jerk: 1000 },
    });
    printParitySummary();
    expect(warn).not.toHaveBeenCalled();
  });

  it('still reports a genuinely unknown Drive field', () => {
    // Guard against the fix being "delete the check": the parity check must keep
    // catching fields nothing consumes.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    validateExtras('Drive', { Direction: 'LinearX', NotARealDriveField: 7 });
    printParitySummary();
    expect(warn.mock.calls.some((c) => String(c[0]).includes('NotARealDriveField'))).toBe(true);
  });
});
