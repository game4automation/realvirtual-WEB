// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-512 §9.1 — the unit kernel without a viewer: factors, aliases,
 * compatibility, offsets, source definitions before the table, quantity tokens.
 */

import { describe, it, expect } from 'vitest';
import {
  BUILTIN_UNITS,
  approxEqualFactor,
  conversion,
  normalizeUnitName,
  parseUnit,
  resolveSignalUnit,
  unitDefFromBaseUnit,
  unitDefsFromBaseUnits,
} from '../src/core/engine/rv-units';
import { DriveDirection } from '../src/core/engine/rv-coordinate-utils';

function factorOf(from: string, to: string, opts?: Parameters<typeof conversion>[2]): number {
  const c = conversion(from, to, opts);
  if (!c.ok) throw new Error(`${from} → ${to}: ${c.reason}`);
  return c.factor;
}

describe('rv-units', () => {
  it('converts length, angle, speed, acceleration', () => {
    expect(conversion('m', 'mm')).toEqual({ ok: true, factor: 1000 });
    expect(conversion('mm', 'm')).toEqual({ ok: true, factor: 0.001 });
    expect(factorOf('rad', 'deg')).toBeCloseTo(57.29578, 4);
    expect(conversion('m/s', 'mm/s')).toEqual({ ok: true, factor: 1000 });
    expect(factorOf('1/min', 'deg/s')).toBeCloseTo(6, 9);
    expect(conversion('m/s2', 'mm/s²')).toEqual({ ok: true, factor: 1000 });
    expect(conversion('cm', 'mm')).toEqual({ ok: true, factor: 10 });
    expect(conversion('mm', 'mm')).toEqual({ ok: true, factor: 1 });
    expect(factorOf('deg/s2', 'rad/s2')).toBeCloseTo(Math.PI / 180, 12);
  });

  it('normalizes aliases', () => {
    expect(normalizeUnitName('mm/s²')).toBe('mm/s2');
    expect(normalizeUnitName('m/s^2')).toBe('m/s2');
    expect(normalizeUnitName('°')).toBe('deg');
    expect(normalizeUnitName('°/s')).toBe('deg/s');
    expect(normalizeUnitName('rpm')).toBe('1/min');
    expect(normalizeUnitName('/min')).toBe('1/min');
    expect(normalizeUnitName('Cel')).toBe('degC');
    expect(normalizeUnitName('  mm ')).toBe('mm');
    expect(normalizeUnitName('furlong')).toBe('furlong');
  });

  it('rejects incompatible, unknown and offset units', () => {
    expect(conversion('rad', 'mm')).toEqual({ ok: false, reason: 'incompatible' });
    expect(conversion('m', 'mm/s')).toEqual({ ok: false, reason: 'incompatible' });
    expect(conversion('furlong', 'mm')).toEqual({ ok: false, reason: 'unknown-source' });
    expect(conversion('mm', 'furlong')).toEqual({ ok: false, reason: 'unknown-target' });
    expect(conversion('degC', 'K')).toEqual({ ok: false, reason: 'offset' });
    // Same offset unit on both sides is the identity, not a refusal.
    expect(conversion('degC', 'Cel')).toEqual({ ok: true, factor: 1 });
  });

  it('prefers the source unitDef over the builtin table', () => {
    const fromDef = { dims: { m: 1 }, factor: 0.0254, offset: 0 };   // a FMU calls inch "in"
    expect(factorOf('in', 'mm', { fromDef })).toBeCloseTo(25.4, 9);
    const odd = { dims: { m: 1 }, factor: 0.5, offset: 0 };          // another FMU defines "in" differently
    expect(factorOf('in', 'mm', { fromDef: odd })).toBeCloseTo(500, 9);
    // A source definition makes an otherwise unknown name usable.
    expect(factorOf('furlong', 'm', { fromDef: { dims: { m: 1 }, factor: 201.168, offset: 0 } })).toBeCloseTo(201.168, 9);
    // ...and a different exponent vector is still incompatible.
    expect(conversion('m', 'mm', { fromDef: { dims: { m: 1, s: -1 }, factor: 1, offset: 0 } }))
      .toEqual({ ok: false, reason: 'incompatible' });
  });

  it('resolves quantity tokens by drive direction', () => {
    expect(resolveSignalUnit('@drive-position', { driveDirection: DriveDirection.LinearX })).toBe('mm');
    expect(resolveSignalUnit('@drive-speed', { driveDirection: DriveDirection.RotationZ })).toBe('deg/s');
    expect(resolveSignalUnit('@drive-acceleration', { driveDirection: DriveDirection.LinearY })).toBe('mm/s2');
    expect(resolveSignalUnit('@drive-acceleration', { driveDirection: DriveDirection.RotationX })).toBe('deg/s2');
    expect(resolveSignalUnit('@drive-position', {})).toBeUndefined();
    expect(resolveSignalUnit('@drive-position', { driveDirection: DriveDirection.Virtual })).toBeUndefined();
    expect(resolveSignalUnit('@unknown-token', { driveDirection: DriveDirection.LinearX })).toBeUndefined();
    expect(resolveSignalUnit('mm', {})).toBe('mm');
  });

  it('reads FMI BaseUnit records (Fmu.FmuUnits) defensively', () => {
    expect(unitDefFromBaseUnit({ m: 1, s: -1 })).toEqual({ dims: { m: 1, s: -1 }, factor: 1, offset: 0 });
    expect(unitDefFromBaseUnit({ K: 1, offset: 273.15 })).toEqual({ dims: { K: 1 }, factor: 1, offset: 273.15 });
    expect(unitDefFromBaseUnit('m')).toBeUndefined();
    const defs = unitDefsFromBaseUnits({ m: { m: 1 }, bad: 7, in: { m: 1, factor: 0.0254 } });
    expect(Object.keys(defs).sort()).toEqual(['in', 'm']);
    expect(factorOf('in', 'mm', { fromDef: defs.in })).toBeCloseTo(25.4, 9);
  });

  it('parseUnit consults extra definitions first and the table covers every token target', () => {
    expect(parseUnit('m')).toBe(BUILTIN_UNITS.m);
    expect(parseUnit('mm/s²')).toBe(BUILTIN_UNITS['mm/s2']);
    expect(parseUnit(undefined)).toBeUndefined();
    const extra = { m: { dims: { m: 1 }, factor: 2, offset: 0 } };
    expect(parseUnit('m', extra)).toBe(extra.m);
    for (const u of ['mm', 'deg', 'mm/s', 'deg/s', 'mm/s2', 'deg/s2']) expect(BUILTIN_UNITS[u]).toBeDefined();
  });

  it('approxEqualFactor is relative and tolerant of non-numbers', () => {
    expect(approxEqualFactor(1000, 1000 + 1e-7)).toBe(true);
    expect(approxEqualFactor(1000, 1001)).toBe(false);
    expect(approxEqualFactor(undefined, 1)).toBe(false);
    expect(approxEqualFactor('1000', 1000)).toBe(false);
  });
});
