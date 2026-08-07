// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-341 §9.7 — the value-colour migration is SURGICAL.
 *
 * Per surface (ConnectPanel row, hierarchy entry, inspector field, slot row)
 * the change must reach ONLY the signal-value path. The three neighbouring
 * meanings that happen to use the same literals — sensor state, element
 * binding state, component type — stay exactly as they were.
 *
 * This is the whole point of the migration table in §2.8 (b): after it, the
 * literals look alike but mean different things, and only a test can hold that
 * line.
 */
import { describe, expect, it } from 'vitest';
import {
  SIGNAL_VALUE_COLOR,
  SIGNAL_VALUE_NEUTRAL,
} from '../src/core/hmi/signal-colors';
import {
  BADGE_COLORS,
  componentColor,
  getRefSignalColor,
  getSensorRefColor,
  getSignalHeaderColor,
} from '../src/core/hmi/rv-inspector-helpers';
import { signalBadgeColor } from '../src/core/hmi/hierarchy-utils';
import popoverSource from '../src/plugins/signal-bind/SignalBindPopover.tsx?raw';
import badgeControllerSource from '../src/plugins/signal-bind/SignalBadgeController.ts?raw';

/** Minimal SignalStore stand-in — only `getByPath` is consulted here. */
function store(values: Record<string, unknown>) {
  return {
    getByPath: (p: string) => values[p],
  } as unknown as Parameters<typeof signalBadgeColor>[1];
}

const LEGACY = ['#66bb6a', '#ef5350', '#808080'];

describe('surface: hierarchy entry (signalBadgeColor)', () => {
  it('carries direction in the hue and state in the intensity', () => {
    expect(signalBadgeColor('PLCOutputBool', store({ X: true }), 'X'))
      .toBe(SIGNAL_VALUE_COLOR.output.strong);
    expect(signalBadgeColor('PLCOutputBool', store({ X: false }), 'X'))
      .toBe(SIGNAL_VALUE_COLOR.output.weak);
    expect(signalBadgeColor('PLCInputBool', store({ X: true }), 'X'))
      .toBe(SIGNAL_VALUE_COLOR.input.strong);
    expect(signalBadgeColor('PLCInputBool', store({ X: false }), 'X'))
      .toBe(SIGNAL_VALUE_COLOR.input.weak);
  });

  it('treats a missing reading as NO VALUE, not as the direction', () => {
    expect(signalBadgeColor('PLCInputBool', store({}), 'X')).toBe(SIGNAL_VALUE_NEUTRAL);
    expect(signalBadgeColor('PLCInputBool', null, 'X')).toBe(SIGNAL_VALUE_NEUTRAL);
    expect(signalBadgeColor('PLCInputBool', store({ X: true }), null)).toBe(SIGNAL_VALUE_NEUTRAL);
  });

  it('applies the numeric rule (0 = weak, non-zero = strong, NaN = neutral)', () => {
    expect(signalBadgeColor('PLCOutputFloat', store({ X: 0 }), 'X'))
      .toBe(SIGNAL_VALUE_COLOR.output.weak);
    expect(signalBadgeColor('PLCOutputFloat', store({ X: 12.5 }), 'X'))
      .toBe(SIGNAL_VALUE_COLOR.output.strong);
    expect(signalBadgeColor('PLCOutputFloat', store({ X: NaN }), 'X'))
      .toBe(SIGNAL_VALUE_NEUTRAL);
  });

  it('UNTOUCHED: a non-signal type keeps its component-type colour', () => {
    expect(signalBadgeColor('Drive', store({ X: true }), 'X')).toBe(componentColor('Drive'));
    expect(signalBadgeColor('Sensor', store({ X: true }), 'X')).toBe(BADGE_COLORS['Sensor']);
  });
});

describe('surface: inspector field (getSignalHeaderColor / getRefSignalColor)', () => {
  it('uses the two-axis rule for the live signal value', () => {
    expect(getSignalHeaderColor('PLCOutputBool', 'true')).toBe(SIGNAL_VALUE_COLOR.output.strong);
    expect(getSignalHeaderColor('PLCOutputBool', 'false')).toBe(SIGNAL_VALUE_COLOR.output.weak);
    expect(getSignalHeaderColor('PLCInputBool', 'true')).toBe(SIGNAL_VALUE_COLOR.input.strong);
    expect(getSignalHeaderColor('PLCInputFloat', '0')).toBe(SIGNAL_VALUE_COLOR.input.weak);
    expect(getSignalHeaderColor('PLCInputFloat', '7')).toBe(SIGNAL_VALUE_COLOR.input.strong);
  });

  it('shows an empty reading or an em dash as NO VALUE', () => {
    expect(getSignalHeaderColor('PLCInputFloat', '')).toBe(SIGNAL_VALUE_NEUTRAL);
    expect(getSignalHeaderColor('PLCInputFloat', '—')).toBe(SIGNAL_VALUE_NEUTRAL);
    expect(getSignalHeaderColor('PLCInputBool', '')).toBe(SIGNAL_VALUE_NEUTRAL);
  });

  it('applies the same rule to signal reference chips', () => {
    expect(getRefSignalColor('PLCOutputBool', store({ P: true }), 'P'))
      .toBe(SIGNAL_VALUE_COLOR.output.strong);
    expect(getRefSignalColor('PLCOutputBool', store({ P: false }), 'P'))
      .toBe(SIGNAL_VALUE_COLOR.output.weak);
    expect(getRefSignalColor('PLCOutputBool', null, 'P')).toBe(SIGNAL_VALUE_NEUTRAL);
  });

  it('UNTOUCHED: SENSOR state keeps its own palette and its own grey', () => {
    // Sensor occupancy is not a signal value — migration table says "nein".
    expect(getSensorRefColor(store({ S: true }), 'S')).toBe(BADGE_COLORS['Sensor']);
    expect(getSensorRefColor(store({ S: false }), 'S')).toBe('#808080');
    expect(getSensorRefColor(null, 'S')).toBe('#808080');
  });

  it('UNTOUCHED: COMPONENT TYPE colours keep their literals', () => {
    expect(componentColor('Drive')).toBe('#4fc3f7');
    expect(componentColor('Sensor')).toBe('#66bb6a');
    expect(componentColor('Sink')).toBe('#ef5350');
    expect(componentColor('PLCInputBool')).toBe('#ef5350');
    expect(componentColor('PLCOutputBool')).toBe('#66bb6a');
  });
});

describe('surface: bind popover + 3D badges', () => {
  it('UNTOUCHED: element BINDING STATE keeps its own colour map', () => {
    // STATE_COLOR describes whether an element is bound/live/pending, not a
    // signal value — migration table says "nein".
    expect(popoverSource).toMatch(/const STATE_COLOR[\s\S]*?unbound: '#808080'/);
    expect(popoverSource).toMatch(/live: '#66bb6a'/);
    expect(popoverSource).toMatch(/conflict: '#ef5350'/);
    expect(popoverSource).not.toMatch(/signal-colors/);
  });

  it('UNTOUCHED: the 3D badge palette stays separate (User decision 29.07.)', () => {
    // 3D badges show the binding state of a whole element and the drop
    // affordance of a connector — never a signal value.
    expect(badgeControllerSource).not.toMatch(/signal-colors/);
    expect(badgeControllerSource).not.toMatch(/signalValueColor/);
  });
});

describe('the migrated value paths dropped the legacy literals', () => {
  it('no signal-value call returns a pre-migration colour', () => {
    const produced = [
      signalBadgeColor('PLCOutputBool', store({ X: true }), 'X'),
      signalBadgeColor('PLCOutputBool', store({ X: false }), 'X'),
      signalBadgeColor('PLCInputBool', store({ X: true }), 'X'),
      signalBadgeColor('PLCInputBool', store({ X: false }), 'X'),
      signalBadgeColor('PLCInputBool', null, 'X'),
      getSignalHeaderColor('PLCOutputBool', 'true'),
      getSignalHeaderColor('PLCOutputBool', 'false'),
      getSignalHeaderColor('PLCInputFloat', ''),
      getRefSignalColor('PLCInputBool', store({ P: true }), 'P'),
      getRefSignalColor('PLCInputBool', store({ P: false }), 'P'),
    ];
    for (const colour of produced) {
      expect(LEGACY).not.toContain(colour.toLowerCase());
    }
  });
});
