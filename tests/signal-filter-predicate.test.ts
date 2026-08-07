// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * signal-filter-predicate.test.ts — plan-234 §3.4 / F8.
 *
 * Pure filtering for the ConnectPanel signal filter panel:
 *  - matchesSignalFilter for every facet in isolation and combined
 *    (empty types = all, text on name/address, active/connected mapping across
 *    all five SignalActivity states)
 *  - the active-facet counter (activeFilterCount) as a pure function
 *  - plcTypeKind reduction + filterNeedsActivity guard
 */
import { describe, it, expect } from 'vitest';
import type { SignalActivity } from '../src/core/engine/rv-signal-activity';
import {
  type SignalFilterState,
  type SignalBindingKind,
  type PlcTypeKind,
  emptySignalFilterState,
  matchesSignalFilter,
  plcTypeKind,
  activityIsActive,
  activeFilterCount,
  isSignalFilterActive,
  filterNeedsActivity,
} from '../src/core/hmi/signal-list-filter';

const ALL_BINDINGS: SignalBindingKind[] = ['auto', 'manual', 'none'];

const ALL_ACTIVITIES: SignalActivity[] = ['live', 'supplied', 'local', 'stale', 'no-source'];

function input(over: Partial<Parameters<typeof matchesSignalFilter>[0]> = {}) {
  return {
    name: 'MC06_No_overload',
    protocolAddress: '%I2.1',
    plcTypeKind: 'Bool' as PlcTypeKind,
    activity: 'live' as SignalActivity,
    connected: true,
    binding: 'auto' as SignalBindingKind,
    recorded: false,
    ...over,
  };
}

function state(over: Partial<SignalFilterState> = {}): SignalFilterState {
  return { ...emptySignalFilterState(), ...over };
}

describe('plcTypeKind', () => {
  it('reduces full PLC types to coarse kinds', () => {
    expect(plcTypeKind('PLCInputBool')).toBe('Bool');
    expect(plcTypeKind('PLCOutputBool')).toBe('Bool');
    expect(plcTypeKind('PLCInputInt')).toBe('Int');
    expect(plcTypeKind('PLCOutputFloat')).toBe('Float');
    expect(plcTypeKind('')).toBe('');
    expect(plcTypeKind(undefined)).toBe('');
    expect(plcTypeKind('Something')).toBe('');
  });
});

describe('activityIsActive — mapping across all five states', () => {
  it('live / supplied / local are active; stale / no-source are inactive', () => {
    expect(activityIsActive('live')).toBe(true);
    expect(activityIsActive('supplied')).toBe(true);
    expect(activityIsActive('local')).toBe(true);
    expect(activityIsActive('stale')).toBe(false);
    expect(activityIsActive('no-source')).toBe(false);
  });
});

describe('matchesSignalFilter — empty filter', () => {
  it('empty state matches everything (any activity, any type, any connected)', () => {
    for (const activity of ALL_ACTIVITIES) {
      expect(matchesSignalFilter(input({ activity, connected: true }), emptySignalFilterState())).toBe(true);
      expect(matchesSignalFilter(input({ activity, connected: false }), emptySignalFilterState())).toBe(true);
    }
  });
});

describe('matchesSignalFilter — text facet', () => {
  it('matches on name (case-insensitive substring)', () => {
    expect(matchesSignalFilter(input({ name: 'MC06_Overload' }), state({ text: 'overload' }))).toBe(true);
    expect(matchesSignalFilter(input({ name: 'MC06_Overload' }), state({ text: 'MC06' }))).toBe(true);
  });
  it('matches on protocolAddress', () => {
    expect(matchesSignalFilter(input({ name: 'X', protocolAddress: '%I2.3' }), state({ text: '%i2.3' }))).toBe(true);
  });
  it('fails when neither name nor address contains the text', () => {
    expect(matchesSignalFilter(input({ name: 'ABC', protocolAddress: '%Q0.0' }), state({ text: 'zzz' }))).toBe(false);
  });
  it('whitespace-only text is treated as no filter', () => {
    expect(matchesSignalFilter(input({ name: 'ABC' }), state({ text: '   ' }))).toBe(true);
  });
});

describe('matchesSignalFilter — active facet across all five activity states', () => {
  it("'active' keeps live/supplied/local, drops stale/no-source", () => {
    const f = state({ active: 'active' });
    expect(ALL_ACTIVITIES.filter((a) => matchesSignalFilter(input({ activity: a }), f))).toEqual([
      'live', 'supplied', 'local',
    ]);
  });
  it("'inactive' keeps only stale/no-source", () => {
    const f = state({ active: 'inactive' });
    expect(ALL_ACTIVITIES.filter((a) => matchesSignalFilter(input({ activity: a }), f))).toEqual([
      'stale', 'no-source',
    ]);
  });
  it("'all' keeps every activity", () => {
    const f = state({ active: 'all' });
    expect(ALL_ACTIVITIES.every((a) => matchesSignalFilter(input({ activity: a }), f))).toBe(true);
  });
});

describe('matchesSignalFilter — type facet', () => {
  it('empty type set matches every kind', () => {
    for (const k of ['Bool', 'Int', 'Float', ''] as PlcTypeKind[]) {
      expect(matchesSignalFilter(input({ plcTypeKind: k }), state({ types: new Set() }))).toBe(true);
    }
  });
  it('single type only matches that kind', () => {
    const f = state({ types: new Set<PlcTypeKind>(['Bool']) });
    expect(matchesSignalFilter(input({ plcTypeKind: 'Bool' }), f)).toBe(true);
    expect(matchesSignalFilter(input({ plcTypeKind: 'Int' }), f)).toBe(false);
    expect(matchesSignalFilter(input({ plcTypeKind: 'Float' }), f)).toBe(false);
  });
  it('multi-select matches any member', () => {
    const f = state({ types: new Set<PlcTypeKind>(['Int', 'Float']) });
    expect(matchesSignalFilter(input({ plcTypeKind: 'Int' }), f)).toBe(true);
    expect(matchesSignalFilter(input({ plcTypeKind: 'Float' }), f)).toBe(true);
    expect(matchesSignalFilter(input({ plcTypeKind: 'Bool' }), f)).toBe(false);
  });
});

describe('matchesSignalFilter — connected facet', () => {
  it("'connected' requires connected === true", () => {
    const f = state({ connected: 'connected' });
    expect(matchesSignalFilter(input({ connected: true }), f)).toBe(true);
    expect(matchesSignalFilter(input({ connected: false }), f)).toBe(false);
  });
  it("'disconnected' requires connected === false", () => {
    const f = state({ connected: 'disconnected' });
    expect(matchesSignalFilter(input({ connected: false }), f)).toBe(true);
    expect(matchesSignalFilter(input({ connected: true }), f)).toBe(false);
  });
  it("'all' ignores connection", () => {
    const f = state({ connected: 'all' });
    expect(matchesSignalFilter(input({ connected: true }), f)).toBe(true);
    expect(matchesSignalFilter(input({ connected: false }), f)).toBe(true);
  });
});

describe('matchesSignalFilter — binding (model coupling) facet', () => {
  it("'auto' keeps only auto-bound signals", () => {
    const f = state({ binding: 'auto' });
    expect(ALL_BINDINGS.filter((b) => matchesSignalFilter(input({ binding: b }), f))).toEqual(['auto']);
  });
  it("'manual' keeps only manually-linked signals", () => {
    const f = state({ binding: 'manual' });
    expect(ALL_BINDINGS.filter((b) => matchesSignalFilter(input({ binding: b }), f))).toEqual(['manual']);
  });
  it("'none' keeps only unbound signals", () => {
    const f = state({ binding: 'none' });
    expect(ALL_BINDINGS.filter((b) => matchesSignalFilter(input({ binding: b }), f))).toEqual(['none']);
  });
  it("'all' keeps every coupling kind", () => {
    const f = state({ binding: 'all' });
    expect(ALL_BINDINGS.every((b) => matchesSignalFilter(input({ binding: b }), f))).toBe(true);
  });
});

describe('matchesSignalFilter — combined facets are ANDed', () => {
  it('all facets must pass', () => {
    const f = state({
      text: 'mc06',
      active: 'active',
      types: new Set<PlcTypeKind>(['Bool']),
      connected: 'connected',
    });
    // matches everything
    expect(matchesSignalFilter(
      input({ name: 'MC06', activity: 'live', plcTypeKind: 'Bool', connected: true }), f,
    )).toBe(true);
    // fails on type
    expect(matchesSignalFilter(
      input({ name: 'MC06', activity: 'live', plcTypeKind: 'Int', connected: true }), f,
    )).toBe(false);
    // fails on active
    expect(matchesSignalFilter(
      input({ name: 'MC06', activity: 'stale', plcTypeKind: 'Bool', connected: true }), f,
    )).toBe(false);
    // fails on connected
    expect(matchesSignalFilter(
      input({ name: 'MC06', activity: 'live', plcTypeKind: 'Bool', connected: false }), f,
    )).toBe(false);
    // fails on text
    expect(matchesSignalFilter(
      input({ name: 'ZZ', activity: 'live', plcTypeKind: 'Bool', connected: true }), f,
    )).toBe(false);
  });
});

describe('activeFilterCount', () => {
  it('empty state → 0', () => {
    expect(activeFilterCount(emptySignalFilterState())).toBe(0);
    expect(isSignalFilterActive(emptySignalFilterState())).toBe(false);
  });
  it('non-empty text counts as one', () => {
    expect(activeFilterCount(state({ text: 'x' }))).toBe(1);
    expect(activeFilterCount(state({ text: '   ' }))).toBe(0); // whitespace only doesn't count
  });
  it('active/connected count when not "all"', () => {
    expect(activeFilterCount(state({ active: 'active' }))).toBe(1);
    expect(activeFilterCount(state({ active: 'all' }))).toBe(0);
    expect(activeFilterCount(state({ connected: 'disconnected' }))).toBe(1);
    expect(activeFilterCount(state({ connected: 'all' }))).toBe(0);
  });
  it('binding counts when not "all"', () => {
    expect(activeFilterCount(state({ binding: 'auto' }))).toBe(1);
    expect(activeFilterCount(state({ binding: 'manual' }))).toBe(1);
    expect(activeFilterCount(state({ binding: 'none' }))).toBe(1);
    expect(activeFilterCount(state({ binding: 'all' }))).toBe(0);
  });
  it('non-empty types set counts as one (regardless of members)', () => {
    expect(activeFilterCount(state({ types: new Set<PlcTypeKind>(['Bool']) }))).toBe(1);
    expect(activeFilterCount(state({ types: new Set<PlcTypeKind>(['Bool', 'Int', 'Float']) }))).toBe(1);
    expect(activeFilterCount(state({ types: new Set() }))).toBe(0);
  });
  it('recorded counts when not "all"', () => {
    expect(activeFilterCount(state({ recorded: 'recorded' }))).toBe(1);
    expect(activeFilterCount(state({ recorded: 'all' }))).toBe(0);
  });
  it('sums all active facets', () => {
    const f = state({ text: 'x', active: 'active', types: new Set<PlcTypeKind>(['Bool']), connected: 'connected', binding: 'auto', recorded: 'recorded' });
    expect(activeFilterCount(f)).toBe(6);
    expect(isSignalFilterActive(f)).toBe(true);
  });
});

describe('matchesSignalFilter — recorded facet (historian, plan-209)', () => {
  it("'recorded' keeps only signals with the Record flag", () => {
    const f = state({ recorded: 'recorded' });
    expect(matchesSignalFilter(input({ recorded: true }), f)).toBe(true);
    expect(matchesSignalFilter(input({ recorded: false }), f)).toBe(false);
  });
  it("'all' passes regardless of the flag", () => {
    expect(matchesSignalFilter(input({ recorded: true }), state())).toBe(true);
    expect(matchesSignalFilter(input({ recorded: false }), state())).toBe(true);
  });
  it('is a static facet — does not trigger the activity re-evaluation path', () => {
    expect(filterNeedsActivity(state({ recorded: 'recorded' }))).toBe(false);
  });
});

describe('filterNeedsActivity — performance guard', () => {
  it('is false for purely static (text/type/binding) filters', () => {
    expect(filterNeedsActivity(emptySignalFilterState())).toBe(false);
    expect(filterNeedsActivity(state({ text: 'x' }))).toBe(false);
    expect(filterNeedsActivity(state({ types: new Set<PlcTypeKind>(['Bool']) }))).toBe(false);
    expect(filterNeedsActivity(state({ binding: 'auto' }))).toBe(false);
    expect(filterNeedsActivity(state({ binding: 'none' }))).toBe(false);
  });
  it('is true when a time-variant facet (active/connected) is engaged', () => {
    expect(filterNeedsActivity(state({ active: 'active' }))).toBe(true);
    expect(filterNeedsActivity(state({ active: 'inactive' }))).toBe(true);
    expect(filterNeedsActivity(state({ connected: 'connected' }))).toBe(true);
    expect(filterNeedsActivity(state({ connected: 'disconnected' }))).toBe(true);
  });
});
