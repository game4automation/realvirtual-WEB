// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-512 §9.3 — the rv-ODT schema is the SSOT of units:
 *  - `getFieldUnit` answers from the schema's `unit`, `FIELD_UNITS` only as a
 *    fallback, and every `FIELD_UNITS` row with a schema pendant agrees with it
 *    (compared through `normalizeUnitName`: `mm/s²` ≙ `mm/s2`);
 *  - the slot table of plan §2.3 holds POSITIVELY (every row, exactly these
 *    attributes) and NEGATIVELY (no other slot carries a `scaleField`);
 *  - every `scaleField` names a number field of the same component, every
 *    `signalUnit` is a table unit or a known quantity token;
 *  - the registry carries the attributes into the descriptors.
 */

import { describe, it, expect } from 'vitest';
import rvOdt from '../schema/v1/rv-odt.json';
import '../src/core/engine/rv-scene-loader';
import { getFieldDescriptor, getRegisteredSchemaTypes, loadSchemaFromSpec } from '../src/core/engine/rv-component-registry';
import { FIELD_UNITS, getFieldUnit } from '../src/core/hmi/rv-inspector-helpers';
import { BUILTIN_UNITS, QUANTITY_TOKENS, normalizeUnitName } from '../src/core/engine/rv-units';

interface OdtProp { type?: string; $ref?: string; signal?: string; unit?: string; signalUnit?: string; scaleField?: string }
const DEFS = (rvOdt as unknown as { $defs: Record<string, { properties?: Record<string, OdtProp> }> }).$defs;

/** plan-512 §2.3 — component → slot → [signalUnit, scaleField]. */
const TABLE: Record<string, Record<string, [string, string]>> = {
  Drive_FollowPosition: {
    Position: ['@drive-position', 'Scale'],
    CurrentPosition: ['@drive-position', 'Scale'],
  },
  Drive_Simple: {
    Speed: ['@drive-speed', 'ScaleSpeed'],
    Accelaration: ['@drive-acceleration', 'ScaleSpeed'],
    IsAtSpeed: ['@drive-speed', 'ScaleSpeed'],
    IsAtPosition: ['@drive-position', 'CurrentPositionScale'],
  },
  Drive_Speed: { SignalCurrentPosition: ['@drive-position', 'CurrentPositionScale'] },
  Drive_DestinationMotor: {
    Destination: ['@drive-position', 'CurrentPositionScale'],
    IsAtPosition: ['@drive-position', 'CurrentPositionScale'],
  },
  Drive_ContinousDestination: {
    SignalDestination: ['@drive-position', 'CurrentPositionScale'],
    SignalIsAtPosition: ['@drive-position', 'CurrentPositionScale'],
  },
  Drive_UniDriveMotor: {
    SetPosition: ['@drive-position', 'PositionScale'],
    ActualPosition: ['@drive-position', 'PositionScale'],
    SetSpeed: ['@drive-speed', 'SpeedScale'],
    ActualSpeed: ['@drive-speed', 'SpeedScale'],
    SetAcceleration: ['@drive-acceleration', 'AccelerationScale'],
    SetDeceleration: ['@drive-acceleration', 'AccelerationScale'],
  },
  Drive_ProfidrivePos: {
    MdiTargetPosition: ['@drive-position', 'PositionScale'],
    PositionActual: ['@drive-position', 'PositionScale'],
    MdiVelocity: ['@drive-speed', 'VelocityScale'],
  },
  Drive_FestoFHPP: {
    TargetPosition: ['@drive-position', 'PositionScale'],
    PositionActual: ['@drive-position', 'PositionScale'],
  },
};

describe('field units — schema is the SSOT (plan-512 F10)', () => {
  it('getFieldUnit answers from the schema unit', () => {
    expect(getFieldUnit('Drive', 'TargetSpeed')).toBe('mm/s');
    expect(normalizeUnitName(getFieldUnit('Drive', 'Acceleration')!)).toBe('mm/s2');
    expect(getFieldUnit('Drive_FollowPosition', 'Offset')).toBe('mm');
    expect(getFieldUnit('Drive_Cylinder', 'TimeOut')).toBe('s');
    // A dedup-suffixed component key resolves like its base type.
    expect(getFieldUnit('Drive_FollowPosition_2', 'Offset')).toBe('mm');
    // Scale fields are dimensionless factors — no suffix.
    expect(getFieldUnit('Drive_FollowPosition', 'Scale')).toBeUndefined();
  });

  it('FIELD_UNITS answers only where the schema has no unit', () => {
    expect(getFieldDescriptor('KinematicJoint', 'LowerLimit')?.unit).toBeUndefined();
    expect(getFieldUnit('KinematicJoint', 'LowerLimit')).toBe(FIELD_UNITS.LowerLimit);
  });

  it('every FIELD_UNITS row with a schema pendant agrees with the schema (alias-normalised)', () => {
    const disagreements: string[] = [];
    for (const [key, unit] of Object.entries(FIELD_UNITS)) {
      const [comp, field] = key.includes('.') ? key.split('.') : [undefined, key];
      const types = comp ? [comp] : getRegisteredSchemaTypes();
      for (const type of types) {
        const schemaUnit = getFieldDescriptor(type, field)?.unit;
        if (!schemaUnit) continue;
        if (normalizeUnitName(schemaUnit) !== normalizeUnitName(unit)) {
          disagreements.push(`${type}.${field}: schema ${schemaUnit} vs FIELD_UNITS ${unit}`);
        }
      }
    }
    expect(disagreements).toEqual([]);
  });

  it('the slot table of plan §2.3 holds positively', () => {
    for (const [comp, slots] of Object.entries(TABLE)) {
      for (const [slot, [signalUnit, scaleField]] of Object.entries(slots)) {
        const p = DEFS[comp]?.properties?.[slot];
        expect(p, `${comp}.${slot} exists`).toBeDefined();
        expect(p!.$ref).toBe('#/$defs/ComponentReference');
        expect(typeof p!.signal).toBe('string');
        expect({ signalUnit: p!.signalUnit, scaleField: p!.scaleField }, `${comp}.${slot}`)
          .toEqual({ signalUnit, scaleField });
        // ...and the registry carries both into the descriptor.
        const d = loadSchemaFromSpec(comp)[slot];
        expect(d.signalUnit).toBe(signalUnit);
        expect(d.scaleField).toBe(scaleField);
      }
    }
  });

  it('no slot outside the table carries signalUnit/scaleField (negative)', () => {
    const extra: string[] = [];
    for (const [comp, def] of Object.entries(DEFS)) {
      for (const [field, p] of Object.entries(def.properties ?? {})) {
        if (p.scaleField === undefined && p.signalUnit === undefined) continue;
        if (!TABLE[comp]?.[field]) extra.push(`${comp}.${field}`);
      }
    }
    expect(extra).toEqual([]);
  });

  it('every scaleField is a number field of the same component; every signalUnit is known', () => {
    for (const [comp, def] of Object.entries(DEFS)) {
      for (const [field, p] of Object.entries(def.properties ?? {})) {
        if (p.scaleField !== undefined) {
          const target = def.properties?.[p.scaleField];
          expect(target?.type, `${comp}.${field} → ${p.scaleField}`).toBe('number');
          // A scale field is a pure factor: no unit of its own.
          expect(target?.unit, `${comp}.${p.scaleField} has no unit`).toBeUndefined();
        }
        if (p.signalUnit !== undefined) {
          const known = p.signalUnit in QUANTITY_TOKENS || normalizeUnitName(p.signalUnit) in BUILTIN_UNITS;
          expect(known, `${comp}.${field} signalUnit ${p.signalUnit}`).toBe(true);
          expect(p.scaleField, `${comp}.${field} pairs signalUnit with scaleField`).toBeDefined();
        }
      }
    }
  });

  it('unit is carried only on number fields; signalUnit/scaleField only on signal slots', () => {
    const d = loadSchemaFromSpec('Drive');
    expect(d.TargetSpeed.unit).toBe('mm/s');
    expect(d.Direction.unit).toBeUndefined();
    const f = loadSchemaFromSpec('Drive_FollowPosition');
    expect(f.Position).toEqual({ type: 'componentRef', signal: 'PLCOutputFloat', signalUnit: '@drive-position', scaleField: 'Scale' });
    expect(f.Scale).toEqual({ type: 'number', default: 1 });
  });
});
