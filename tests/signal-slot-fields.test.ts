// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-325 §9.2 — getSignalSlotFields(): the schema-introspected signal-slot
 * universe of a component type, independent of any GLB value.
 */
import { describe, expect, it } from 'vitest';
// Side effect: registers the Drive_* behavior schemas + Sensor factory schema.
import '../src/core/engine/rv-signal-construction';
import '../src/core/engine/rv-sensor';
import {
  getSignalSlotFields,
  isSignalSlotField,
  registerComponentSchema,
} from '../src/core/engine/rv-component-registry';

describe('getSignalSlotFields (plan-325 9.2)', () => {
  it('lists Forward AND Backward for Drive_Simple with their PLC directions — without any GLB value', () => {
    const fields = getSignalSlotFields('Drive_Simple');
    const byName = new Map(fields.map((f) => [f.field, f]));
    expect(byName.get('Forward')).toEqual({ field: 'Forward', signal: 'PLCOutputBool', direction: 'plcOutput' });
    expect(byName.get('Backward')).toEqual({ field: 'Backward', signal: 'PLCOutputBool', direction: 'plcOutput' });
    // Feedback slots carry the plcInput direction.
    expect(byName.get('IsDriving')?.direction).toBe('plcInput');
  });

  it('lists the Sensor feedback slots', () => {
    const fields = getSignalSlotFields('Sensor');
    expect(fields.map((f) => f.field)).toEqual(
      expect.arrayContaining(['SensorOccupied', 'SensorNotOccupied']),
    );
    expect(fields.every((f) => f.direction === 'plcInput')).toBe(true);
  });

  it('returns a frozen empty list for unknown types and types without componentRef+signal fields', () => {
    expect(getSignalSlotFields('NoSuchType')).toEqual([]);
    registerComponentSchema('PlainWidget325', { Speed: { type: 'number' } });
    expect(getSignalSlotFields('PlainWidget325')).toEqual([]);
  });

  it('invalidates the per-type cache when a schema is re-registered', () => {
    registerComponentSchema('CacheWidget325', { Run: { type: 'componentRef', signal: 'PLCOutputBool' } });
    expect(getSignalSlotFields('CacheWidget325')).toHaveLength(1);
    registerComponentSchema('CacheWidget325', {
      Run: { type: 'componentRef', signal: 'PLCOutputBool' },
      Done: { type: 'componentRef', signal: 'PLCInputBool' },
    });
    expect(getSignalSlotFields('CacheWidget325')).toHaveLength(2);
  });

  it('isSignalSlotField resolves direct names and aliases, and rejects plain refs', () => {
    registerComponentSchema('AliasWidget325', {
      Run: { type: 'componentRef', signal: 'PLCOutputBool', aliases: ['Start'] },
      SensorRef: { type: 'componentRef' },
    });
    expect(isSignalSlotField('AliasWidget325', 'Run')).toBe(true);
    expect(isSignalSlotField('AliasWidget325', 'Start')).toBe(true);
    expect(isSignalSlotField('AliasWidget325', 'SensorRef')).toBe(false);
    expect(isSignalSlotField('AliasWidget325', 'Missing')).toBe(false);
  });
});
