// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * signal-drop-accept.test.ts — plan-246 Phase 4 (F9).
 *
 * Pure type/direction accept matrix for dropping a dragged signal onto a
 * bindable slot: bool/int/float × plcInput/plcOutput × payload direction.
 */
import { describe, it, expect } from 'vitest';
import { slotAcceptsSignal, plcKindOf, kindFitsSlot } from '../src/plugins/signal-bind/drop-accept';

describe('plcKindOf', () => {
  it('derives the kind from PLC type strings', () => {
    expect(plcKindOf('PLCInputBool')).toBe('bool');
    expect(plcKindOf('PLCOutputInt')).toBe('int');
    expect(plcKindOf('PLCOutputFloat')).toBe('float');
    expect(plcKindOf('Real')).toBe('float');
    expect(plcKindOf(undefined)).toBe('unknown');
    expect(plcKindOf('')).toBe('unknown');
    expect(plcKindOf('PLCOutputWord')).toBe('unknown');
  });
});

describe('kindFitsSlot — equal kinds plus the Int→Float widening', () => {
  it('accepts equal kinds', () => {
    expect(kindFitsSlot('bool', 'bool')).toBe(true);
    expect(kindFitsSlot('int', 'int')).toBe(true);
    expect(kindFitsSlot('float', 'float')).toBe(true);
  });

  it('widens Int into a Float slot — the DINT setpoint case', () => {
    expect(kindFitsSlot('float', 'int')).toBe(true);
  });

  it('does NOT narrow Float into an Int slot, and never touches Bool', () => {
    expect(kindFitsSlot('int', 'float')).toBe(false);
    expect(kindFitsSlot('bool', 'int')).toBe(false);
    expect(kindFitsSlot('int', 'bool')).toBe(false);
    expect(kindFitsSlot('float', 'bool')).toBe(false);
    expect(kindFitsSlot('bool', 'float')).toBe(false);
  });

  it('rejects an underivable kind for every slot', () => {
    expect(kindFitsSlot('bool', 'unknown')).toBe(false);
    expect(kindFitsSlot('int', 'unknown')).toBe(false);
    expect(kindFitsSlot('float', 'unknown')).toBe(false);
  });
});

describe('slotAcceptsSignal — kind × direction matrix', () => {
  const boolIn = { type: 'bool', direction: 'plcInput' } as const;
  const boolOut = { type: 'bool', direction: 'plcOutput' } as const;
  const intIn = { type: 'int', direction: 'plcInput' } as const;
  const floatOut = { type: 'float', direction: 'plcOutput' } as const;
  const floatIn = { type: 'float', direction: 'plcInput' } as const;

  it('matching kind + matching direction is accepted', () => {
    expect(slotAcceptsSignal(boolOut, { plcType: 'PLCOutputBool', direction: 'output', origin: 'connect', interfaceId: 'i1' })).toBe(true);
    expect(slotAcceptsSignal(boolIn, { plcType: 'PLCInputBool', direction: 'input', origin: 'connect', interfaceId: 'i1' })).toBe(true);
    expect(slotAcceptsSignal(intIn, { plcType: 'PLCInputInt', direction: 'input', origin: 'connect', interfaceId: 'i1' })).toBe(true);
    expect(slotAcceptsSignal(floatOut, { plcType: 'PLCOutputFloat', direction: 'output', origin: 'connect', interfaceId: 'i1' })).toBe(true);
  });

  it('an Int signal lands on a Float slot — a DINT drive setpoint', () => {
    // The case this rule exists for: a PLC that addresses drive positions as
    // DINT (%QD4012) feeding a float Destination/Position slot. The runtime
    // (_slotConflict) and the CONNECT gateway (SignalCoercion) both allow it.
    expect(slotAcceptsSignal(floatOut, { plcType: 'PLCOutputInt', direction: 'output', origin: 'connect', interfaceId: 'i1' })).toBe(true);
    expect(slotAcceptsSignal(floatIn, { plcType: 'PLCInputInt', direction: 'input', origin: 'connect', interfaceId: 'i1' })).toBe(true);
  });

  it('kind mismatch is rejected', () => {
    expect(slotAcceptsSignal(boolOut, { plcType: 'PLCOutputInt', direction: 'output', origin: 'connect', interfaceId: 'i1' })).toBe(false);
    // Float→int would have to truncate — still refused, in both directions.
    expect(slotAcceptsSignal(intIn, { plcType: 'PLCInputFloat', direction: 'input', origin: 'connect', interfaceId: 'i1' })).toBe(false);
    expect(slotAcceptsSignal(floatOut, { plcType: 'PLCOutputBool', direction: 'output', origin: 'connect', interfaceId: 'i1' })).toBe(false);
  });

  it('direction conflict is rejected', () => {
    // PLC output signal (read by viewer) cannot land on a plcInput slot.
    expect(slotAcceptsSignal(boolIn, { plcType: 'PLCOutputBool', direction: 'output', origin: 'connect', interfaceId: 'i1' })).toBe(false);
    // Viewer-written input signal cannot land on a plcOutput slot.
    expect(slotAcceptsSignal(boolOut, { plcType: 'PLCInputBool', direction: 'input', origin: 'connect', interfaceId: 'i1' })).toBe(false);
  });

  it('unknown payload direction fails closed for both slot directions', () => {
    expect(slotAcceptsSignal(boolIn, { plcType: 'PLCInputBool', direction: 'unknown', origin: 'connect', interfaceId: 'i1' })).toBe(false);
    expect(slotAcceptsSignal(boolOut, { plcType: 'PLCOutputBool', direction: 'unknown', origin: 'connect', interfaceId: 'i1' })).toBe(false);
  });

  it('unknown payload kind fails closed', () => {
    expect(slotAcceptsSignal(boolIn, { direction: 'input', origin: 'connect', interfaceId: 'i1' })).toBe(false);
    expect(slotAcceptsSignal(intIn, { plcType: 'PLCInputWord', direction: 'input', origin: 'connect', interfaceId: 'i1' })).toBe(false);
  });
});
