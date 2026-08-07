// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * search-result-grouping.test.ts — pure grouping of global-search results
 * for the BottomBar dropdown (plan-283 review: "shows too much").
 */

import { describe, it, expect } from 'vitest';
import {
  searchGroupLabel,
  groupSearchResults,
  flattenGroupedResults,
  OBJECTS_GROUP,
  type GroupableResult,
} from '../src/core/hmi/search-result-grouping';

function r(types: string[], matchedBy?: string): GroupableResult & { id: number } {
  return { types, matchedBy, id: ++_id };
}
let _id = 0;

describe('searchGroupLabel', () => {
  it('maps drives, sensors, conveyors, signals and logic to their categories', () => {
    expect(searchGroupLabel(r(['Drive']))).toBe('Drives');
    expect(searchGroupLabel(r(['Drive_Gear']))).toBe('Drives');
    expect(searchGroupLabel(r(['DrivesRecorder']))).toBe('Drives');
    expect(searchGroupLabel(r(['Sensor']))).toBe('Sensors');
    expect(searchGroupLabel(r(['TransportSurface']))).toBe('Conveyors');
    expect(searchGroupLabel(r(['PLCInputBool']))).toBe('Signals');
    expect(searchGroupLabel(r(['PLCOutputFloat']))).toBe('Signals');
    expect(searchGroupLabel(r(['ConnectSignal']))).toBe('Signals');
    expect(searchGroupLabel(r(['LogicStep_Drive']))).toBe('Logic');
  });

  it('maps untyped results to Objects', () => {
    expect(searchGroupLabel(r([]))).toBe(OBJECTS_GROUP);
  });

  it('prefers matchedBy over the primary type', () => {
    expect(searchGroupLabel(r(['Drive'], 'PLCInputBool'))).toBe('Signals');
  });

  it('groups unknown component types under their own type key', () => {
    expect(searchGroupLabel(r(['AASLink']))).toBe('AASLink');
  });
});

describe('groupSearchResults', () => {
  it('groups by category with counts and priority order, Objects last', () => {
    const results = [
      r([]),                    // Objects
      r(['PLCInputBool']),      // Signals
      r(['Drive']),             // Drives
      r([]),                    // Objects
      r(['Drive_Gear']),        // Drives
      r(['AASLink']),           // AASLink (other)
    ];
    const groups = groupSearchResults(results);
    expect(groups.map(g => g.label)).toEqual(['Drives', 'Signals', 'AASLink', 'Objects']);
    expect(groups.map(g => g.items.length)).toEqual([2, 1, 1, 2]);
  });

  it('preserves input (relevance) order inside each group', () => {
    const a = r(['Drive']);
    const b = r(['Sensor']);
    const c = r(['Drive']);
    const groups = groupSearchResults([a, b, c]);
    expect(groups[0].items).toEqual([a, c]);
    expect(groups[1].items).toEqual([b]);
  });

  it('startIndex maps each group into the flattened order', () => {
    const groups = groupSearchResults([
      r([]), r(['Drive']), r(['Sensor']), r(['Drive']),
    ]);
    const flat = flattenGroupedResults(groups);
    expect(flat).toHaveLength(4);
    for (const g of groups) {
      g.items.forEach((item, gi) => {
        expect(flat[g.startIndex + gi]).toBe(item);
      });
    }
  });

  it('sorts non-priority groups alphabetically before Objects', () => {
    const groups = groupSearchResults([
      r([]), r(['Zeta']), r(['Alpha']),
    ]);
    expect(groups.map(g => g.label)).toEqual(['Alpha', 'Zeta', 'Objects']);
  });

  it('returns an empty array for no results', () => {
    expect(groupSearchResults([])).toEqual([]);
  });
});
