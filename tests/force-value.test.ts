// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * force-value.test.ts — value-forcing of numeric (Int/Float) signals.
 *
 * Exercises the SignalStore contract the value-entry popover relies on:
 * - forcing an Int/Float to an operator-entered value pins it and holds it
 *   against subsequent interface updates (`set` = the interface-update path
 *   that is ignored while forced).
 * - re-forcing updates the held value.
 * - the bool path keeps toggling.
 * Also covers the input-parsing rules the popover uses (int rounding,
 * empty/invalid rejection).
 */
import { describe, it, expect } from 'vitest';
import { SignalStore } from '../src/core/engine/rv-signal-store';

// Mirrors the popover's parse: trim → finite number → round for int.
function parseForceInput(s: string, intOnly: boolean): number | null {
  const t = s.trim();
  if (t === '') return null;
  const n = Number(t);
  if (!Number.isFinite(n)) return null;
  return intOnly ? Math.round(n) : n;
}

describe('force value — numeric signals', () => {
  it('forces an Int signal to an entered value and holds it against the interface', () => {
    const store = new SignalStore();
    store.register('Count', 'sig/Count', 0, 'PLCOutputInt');

    // Operator types "42" into the popover, intOnly true.
    const v = parseForceInput('42', true);
    expect(v).toBe(42);
    store.forceSignal('Count', v!);

    expect(store.isForced('Count')).toBe(true);
    expect(store.getInt('Count')).toBe(42);

    // Interface keeps pushing live updates — they must be ignored.
    store.set('Count', 7);
    expect(store.getInt('Count')).toBe(42);
  });

  it('re-forcing an Int updates the held value', () => {
    const store = new SignalStore();
    store.register('Count', 'sig/Count', 0, 'PLCOutputInt');
    store.forceSignal('Count', 42);
    store.forceSignal('Count', 99);
    expect(store.getInt('Count')).toBe(99);
    expect(store.getForcedValue('Count')).toBe(99);
  });

  it('forces a Float signal with decimals and holds it', () => {
    const store = new SignalStore();
    store.register('Speed', 'sig/Speed', 0, 'PLCOutputFloat');

    const v = parseForceInput('3.75', false);
    expect(v).toBeCloseTo(3.75);
    store.forceSignal('Speed', v!);

    expect(store.getFloat('Speed')).toBeCloseTo(3.75);
    store.set('Speed', 12.5);                 // interface update ignored
    expect(store.getFloat('Speed')).toBeCloseTo(3.75);
  });

  it('rounds Int input and leaves Float input untouched', () => {
    expect(parseForceInput('2.7', true)).toBe(3);   // int rounds
    expect(parseForceInput('-2.7', true)).toBe(-3);
    expect(parseForceInput('2.7', false)).toBeCloseTo(2.7); // float keeps decimals
  });

  it('rejects empty and invalid input (no force)', () => {
    expect(parseForceInput('', false)).toBeNull();
    expect(parseForceInput('   ', false)).toBeNull();
    expect(parseForceInput('abc', false)).toBeNull();
    expect(parseForceInput('NaN', false)).toBeNull();
  });

  it('releasing the force lets interface updates flow again', () => {
    const store = new SignalStore();
    store.register('Count', 'sig/Count', 0, 'PLCOutputInt');
    store.forceSignal('Count', 42);
    store.unforce('Count');
    expect(store.isForced('Count')).toBe(false);
    store.set('Count', 7);
    expect(store.getInt('Count')).toBe(7);
  });
});

describe('force value — bool path still toggles', () => {
  it('forcing a bool flips and holds, releasing restores interface control', () => {
    const store = new SignalStore();
    store.register('Run', 'sig/Run', false, 'PLCOutputBool');

    // Toggle = force the opposite of the current value.
    const cur = store.getBool('Run');
    store.forceSignal('Run', !cur);
    expect(store.getBool('Run')).toBe(true);
    expect(store.isForced('Run')).toBe(true);

    store.set('Run', false);                  // interface ignored while forced
    expect(store.getBool('Run')).toBe(true);

    store.unforce('Run');
    store.set('Run', false);
    expect(store.getBool('Run')).toBe(false);
  });
});
