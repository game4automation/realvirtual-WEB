// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * signal-meta.test.ts — descriptive signal metadata (address/comment/source)
 * stored in the SignalStore and rendered by the SignalBadge hover tooltip.
 *
 * Covers:
 *  - setSignalMeta / getSignalMeta merge + partial-update behavior
 *  - undefined for signals without metadata
 *  - clear() drops metadata
 *  - the pure tooltip-model builder (name/type/value/address/source/comment/hint)
 */
import { describe, it, expect } from 'vitest';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import {
  buildSignalTooltipModel,
  signalTypePhrase,
  formatSignalValue,
} from '../src/core/hmi/rv-signal-badge';

describe('SignalStore — signal metadata', () => {
  it('returns undefined for a signal with no metadata', () => {
    const store = new SignalStore();
    store.register('s', 'sig/s', false, 'PLCOutputBool');
    expect(store.getSignalMeta('s')).toBeUndefined();
  });

  it('stores and returns metadata', () => {
    const store = new SignalStore();
    store.setSignalMeta('s', { address: '%I0.0', comment: 'Start button', source: 'S7 · DB1' });
    expect(store.getSignalMeta('s')).toEqual({
      address: '%I0.0',
      comment: 'Start button',
      source: 'S7 · DB1',
    });
  });

  it('merges partial updates without clobbering existing fields', () => {
    const store = new SignalStore();
    store.setSignalMeta('s', { address: '%QW2800' });
    store.setSignalMeta('s', { comment: 'Conveyor speed' });
    store.setSignalMeta('s', { source: 'MQTT · Data_Q_1' });
    expect(store.getSignalMeta('s')).toEqual({
      address: '%QW2800',
      comment: 'Conveyor speed',
      source: 'MQTT · Data_Q_1',
    });
  });

  it('only overwrites the fields that are actually supplied', () => {
    const store = new SignalStore();
    store.setSignalMeta('s', { address: '%I0.0', comment: 'orig' });
    store.setSignalMeta('s', { comment: 'updated' }); // address untouched
    expect(store.getSignalMeta('s')).toEqual({ address: '%I0.0', comment: 'updated' });
  });

  it('ignores empty signal name', () => {
    const store = new SignalStore();
    store.setSignalMeta('', { address: 'x' });
    expect(store.getSignalMeta('')).toBeUndefined();
  });

  it('clear() drops metadata', () => {
    const store = new SignalStore();
    store.setSignalMeta('s', { address: '%I0.0' });
    store.clear();
    expect(store.getSignalMeta('s')).toBeUndefined();
  });
});

describe('SignalBadge tooltip — pure helpers', () => {
  it('signalTypePhrase combines direction and kind', () => {
    expect(signalTypePhrase('PLCOutputInt', 'output')).toBe('Output · Int');
    expect(signalTypePhrase('PLCInputBool', 'input')).toBe('Input · Bool');
    expect(signalTypePhrase('PLCOutputFloat', 'output')).toBe('Output · Float');
  });

  it('signalTypePhrase falls back gracefully', () => {
    expect(signalTypePhrase('', 'output')).toBe('Output');
    expect(signalTypePhrase('PLCInputInt', 'unknown')).toBe('Int');
    expect(signalTypePhrase('', 'unknown')).toBe('');
  });

  it('formatSignalValue renders bool/number/undefined', () => {
    expect(formatSignalValue(true)).toBe('True');
    expect(formatSignalValue(false)).toBe('False');
    expect(formatSignalValue(42)).toBe('42');
    expect(formatSignalValue(3.14159)).toBe('3.14');
    expect(formatSignalValue(undefined)).toBe('—');
  });

  it('buildSignalTooltipModel always carries name/type/value/hint', () => {
    const model = buildSignalTooltipModel({
      name: 'ConveyorStart',
      plcType: 'PLCOutputBool',
      direction: 'output',
      shown: true,
      forced: false,
      meta: undefined,
      hint: 'Click to force',
    });
    expect(model.name).toBe('ConveyorStart');
    expect(model.typePhrase).toBe('Output · Bool');
    expect(model.value).toBe('True');
    expect(model.hint).toBe('Click to force');
    // No metadata → no address/source/comment.
    expect(model.address).toBeUndefined();
    expect(model.source).toBeUndefined();
    expect(model.comment).toBeUndefined();
  });

  it('buildSignalTooltipModel surfaces metadata when present', () => {
    const model = buildSignalTooltipModel({
      name: 'Speed',
      plcType: 'PLCOutputInt',
      direction: 'output',
      shown: 1500,
      forced: true,
      meta: { address: '%QW2800', source: 'MQTT · Data_Q_1', comment: 'Belt speed mm/s' },
      hint: 'Click to change value, ✕ to release',
    });
    expect(model.typePhrase).toBe('Output · Int');
    expect(model.value).toBe('1500');
    expect(model.forced).toBe(true);
    expect(model.address).toBe('%QW2800');
    expect(model.source).toBe('MQTT · Data_Q_1');
    expect(model.comment).toBe('Belt speed mm/s');
  });
});
