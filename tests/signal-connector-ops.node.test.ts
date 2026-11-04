// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2227 Phase 2 — the pure authoring rules of the SignalConnector:
 * which fields a Mode shows, which slots a Mode change clears, the bit list
 * and the child names of *Create bit connectors…*, the inspector's binary view.
 */

import { describe, expect, it } from 'vitest';
import {
  MODE_OPTION_FIELDS,
  bitChildName,
  formatBinary,
  isSignalConnectorFieldVisible,
  isSlotAuthored,
  parseBitList,
  slotsClearedBySetMode,
  slotsUsableIn,
} from '../src/core/engine/rv-signal-connector-ops';
import { SIGNAL_CONNECTOR_MODES } from '../src/core/engine/rv-signal-conversion';

const ref = (path: string) => ({ type: 'ComponentReference', path });
const addr = (id: string) => ({ type: 'ComponentReference', address: `#${id}` });

describe('Mode → visible fields', () => {
  it('shows Mode, Enabled and only the options of the Mode', () => {
    for (const mode of SIGNAL_CONNECTOR_MODES) {
      const data = { Mode: mode, Condition: 'Equals' };
      expect(isSignalConnectorFieldVisible(data, 'Mode')).toBe(true);
      expect(isSignalConnectorFieldVisible(data, 'Enabled')).toBe(true);
      for (const f of ['Condition', 'CompareValue', 'TrueValue', 'FalseValue', 'Bit', 'Width', 'Signed', 'Factor', 'Offset', 'Rounding', 'Invert']) {
        expect(isSignalConnectorFieldVisible(data, f), `${mode}.${f}`).toBe(MODE_OPTION_FIELDS[mode].includes(f));
      }
    }
  });

  it('CompareValue only for a comparing Condition', () => {
    expect(isSignalConnectorFieldVisible({ Mode: 'IntToBool', Condition: 'NotZero' }, 'CompareValue')).toBe(false);
    expect(isSignalConnectorFieldVisible({ Mode: 'IntToBool', Condition: 'GreaterOrEqual' }, 'CompareValue')).toBe(true);
  });

  it('shows the slots the Mode can use, plus a stray set slot', () => {
    const bits = { Mode: 'BitFromWord' };
    expect(isSignalConnectorFieldVisible(bits, 'SourceInt')).toBe(true);
    expect(isSignalConnectorFieldVisible(bits, 'TargetBool')).toBe(true);
    for (const s of ['SourceBool', 'SourceFloat', 'TargetInt', 'TargetFloat']) expect(isSignalConnectorFieldVisible(bits, s), s).toBe(false);
    expect(isSignalConnectorFieldVisible({ ...bits, TargetFloat: addr('x') }, 'TargetFloat')).toBe(true);
    expect([...slotsUsableIn('Copy')].sort()).toEqual(['SourceBool', 'SourceFloat', 'SourceInt', 'TargetBool', 'TargetFloat', 'TargetInt']);
  });

  it('a missing / unknown Mode reads as Copy, unknown fields pass', () => {
    expect(isSignalConnectorFieldVisible({}, 'Invert')).toBe(true);
    expect(isSignalConnectorFieldVisible({ Mode: 'Bogus' }, 'Bit')).toBe(false);
    expect(isSignalConnectorFieldVisible({ Mode: 'Scale' }, 'SomethingNew')).toBe(true);
  });
});

describe('setMode clears exactly the slots the new Mode does not use', () => {
  it('Copy BOOL → BitFromWord clears both BOOL-pair slots it cannot use', () => {
    expect(slotsClearedBySetMode('BitFromWord', { SourceBool: ref('a'), TargetBool: ref('b') })).toEqual(['SourceBool']);
  });
  it('BoolToInt → Copy: the pair is no Copy pair, one side goes', () => {
    expect(slotsClearedBySetMode('Copy', { SourceBool: ref('a'), TargetInt: addr('t') })).toEqual(['TargetInt']);
  });
  it('a complete matching pair keeps everything, empty values do not count', () => {
    expect(slotsClearedBySetMode('Scale', { SourceInt: ref('a'), TargetFloat: ref('b'), SourceBool: null, TargetBool: '' })).toEqual([]);
  });
  it('isSlotAuthored reads address, path, unresolvedPath and strings', () => {
    expect(isSlotAuthored(addr('x'))).toBe(true);
    expect(isSlotAuthored({ type: 'ComponentReference', unresolvedPath: 'a/b', reason: 'missing' })).toBe(true);
    expect(isSlotAuthored('a/b')).toBe(true);
    expect(isSlotAuthored({ type: 'ComponentReference' })).toBe(false);
    expect(isSlotAuthored(null)).toBe(false);
  });
});

describe('Create bit connectors — bit list and names', () => {
  it('parses ranges and lists in the given order', () => {
    expect(parseBitList('0-3, 8', 'Word')).toEqual({ bits: [0, 1, 2, 3, 8] });
    expect(parseBitList([5, 2], 'Byte')).toEqual({ bits: [5, 2] });
    expect(parseBitList('0-31', 'DWord')).toMatchObject({ bits: expect.arrayContaining([0, 31]) });
  });
  it('refuses bits beyond the width, repeats, garbage and an empty list', () => {
    expect(parseBitList('0-8', 'Byte')).toEqual({ error: 'bit 8 is outside a Byte (valid 0..7)' });
    expect(parseBitList('1,1', 'Word')).toEqual({ error: 'bit 1 is listed twice' });
    expect(parseBitList('x', 'Word')).toMatchObject({ error: expect.stringContaining('not a bit number') });
    expect(parseBitList('5-2', 'Word')).toMatchObject({ error: expect.stringContaining('backwards') });
    expect(parseBitList('', 'Word')).toEqual({ error: 'no bits given' });
  });
  it('names children Bit00 … Bit31', () => {
    expect(bitChildName(0)).toBe('Bit00');
    expect(bitChildName(15)).toBe('Bit15');
    expect(bitChildName(31)).toBe('Bit31');
  });
});

describe('inspector binary view', () => {
  it('groups by 4 at the Width, signed 32 bit storage', () => {
    expect(formatBinary(37, 'Byte')).toBe('0010 0101');
    expect(formatBinary(-1, 'Word')).toBe('1111 1111 1111 1111');
    expect(formatBinary(-2147483648, 'DWord')).toBe('1000 0000 0000 0000 0000 0000 0000 0000');
  });
});
