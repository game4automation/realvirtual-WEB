// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * signal-chip-variants.test.ts — plan-246 Phase 1.
 *
 * Covers the pure chip-label builder for the three display variants
 * ('full' | 'standard' | 'minimal') across value kinds (bool ●/○, int, float,
 * undefined —) and the legacy chipTypeLabel → chipVariant persistence migration.
 */
import { describe, it, expect } from 'vitest';
import { buildChipLabel } from '../src/core/hmi/rv-signal-badge';
import { migrateChipVariant } from '../src/core/hmi/signal-display-store';

describe('buildChipLabel — variant matrix', () => {
  const bool = { displayName: 'Conveyor.Start', plcType: 'PLCOutputBool', direction: 'output' as const };

  it('full: name + type label + value', () => {
    expect(buildChipLabel('full', { ...bool, valueStr: '●' })).toBe('Conveyor.Start  OutBool ●');
    expect(buildChipLabel('full', { ...bool, valueStr: '○' })).toBe('Conveyor.Start  OutBool ○');
  });

  it('standard: name + value', () => {
    expect(buildChipLabel('standard', { ...bool, valueStr: '●' })).toBe('Conveyor.Start  ●');
  });

  it('minimal: direction letter + value, name dropped', () => {
    expect(buildChipLabel('minimal', { ...bool, valueStr: '●' })).toBe('O ●');
    expect(buildChipLabel('minimal', {
      displayName: 'Sensor.Occupied', plcType: 'PLCInputBool', direction: 'input', valueStr: '○',
    })).toBe('I ○');
  });

  it('int/float values render across all variants', () => {
    const num = { displayName: 'Drive.Position', plcType: 'PLCInputFloat', direction: 'input' as const };
    expect(buildChipLabel('full', { ...num, valueStr: '42.5' })).toBe('Drive.Position  InFloat 42.5');
    expect(buildChipLabel('standard', { ...num, valueStr: '42.5' })).toBe('Drive.Position  42.5');
    expect(buildChipLabel('minimal', { ...num, valueStr: '42.5' })).toBe('I 42.5');

    const int = { displayName: 'Counter', plcType: 'PLCOutputInt', direction: 'output' as const };
    expect(buildChipLabel('full', { ...int, valueStr: '7' })).toBe('Counter  OutInt 7');
    expect(buildChipLabel('standard', { ...int, valueStr: '7' })).toBe('Counter  7');
    expect(buildChipLabel('minimal', { ...int, valueStr: '7' })).toBe('O 7');
  });

  it('undefined value (—) renders across all variants', () => {
    expect(buildChipLabel('full', { ...bool, valueStr: '—' })).toBe('Conveyor.Start  OutBool —');
    expect(buildChipLabel('standard', { ...bool, valueStr: '—' })).toBe('Conveyor.Start  —');
    expect(buildChipLabel('minimal', { ...bool, valueStr: '—' })).toBe('O —');
  });

  it('full without displayName degrades to type + value (anonymous status chip)', () => {
    expect(buildChipLabel('full', { plcType: 'PLCOutputBool', direction: 'output', valueStr: '●' })).toBe('OutBool ●');
  });

  it('full without plcType falls back to Out/In direction word', () => {
    expect(buildChipLabel('full', { direction: 'output', valueStr: '●' })).toBe('Out ●');
    expect(buildChipLabel('full', { direction: 'input', valueStr: '○' })).toBe('In ○');
  });

  it('standard without any name is value only', () => {
    expect(buildChipLabel('standard', { plcType: 'PLCOutputBool', direction: 'output', valueStr: '●' })).toBe('●');
  });

  it('full/standard without displayName fall back to the store signalName (dot notation)', () => {
    expect(buildChipLabel('full', {
      signalName: 'Turntable.Start', plcType: 'PLCOutputBool', direction: 'output', valueStr: '●',
    })).toBe('Turntable.Start  OutBool ●');
    expect(buildChipLabel('standard', {
      signalName: 'Turntable.Start', plcType: 'PLCOutputBool', direction: 'output', valueStr: '●',
    })).toBe('Turntable.Start  ●');
    // displayName wins over signalName when both are present.
    expect(buildChipLabel('full', {
      displayName: 'Start', signalName: 'Turntable.Start', plcType: 'PLCOutputBool', direction: 'output', valueStr: '●',
    })).toBe('Start  OutBool ●');
    // minimal never shows a name, even with a signalName present.
    expect(buildChipLabel('minimal', {
      signalName: 'Turntable.Start', plcType: 'PLCOutputBool', direction: 'output', valueStr: '●',
    })).toBe('O ●');
  });

  it('unknown direction: minimal is value only, full is value only without type', () => {
    expect(buildChipLabel('minimal', { direction: 'unknown', valueStr: '●' })).toBe('●');
    expect(buildChipLabel('full', { direction: 'unknown', valueStr: '●' })).toBe('●');
  });

  it('non-standard PLC types keep the generic Out:/In: label in full', () => {
    expect(buildChipLabel('full', { plcType: 'PLCOutputWord', direction: 'output', valueStr: '3' })).toBe('Out:Word 3');
  });
});

describe('migrateChipVariant — legacy chipTypeLabel persistence', () => {
  it('maps legacy values: full→full, short→standard, none→minimal', () => {
    expect(migrateChipVariant({ chipTypeLabel: 'full' })).toBe('full');
    expect(migrateChipVariant({ chipTypeLabel: 'short' })).toBe('standard');
    expect(migrateChipVariant({ chipTypeLabel: 'none' })).toBe('minimal');
  });

  it('prefers the new chipVariant key over a legacy value', () => {
    expect(migrateChipVariant({ chipVariant: 'minimal', chipTypeLabel: 'full' })).toBe('minimal');
    expect(migrateChipVariant({ chipVariant: 'standard' })).toBe('standard');
  });

  it('falls back to the default for unknown/absent values', () => {
    expect(migrateChipVariant({})).toBe('full');
    expect(migrateChipVariant({ chipVariant: 'bogus' })).toBe('full');
    expect(migrateChipVariant({ chipTypeLabel: 42 })).toBe('full');
  });
});
