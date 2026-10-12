// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-589 Test 9.3 — a newly created signal gets a FREE default name.
 *
 * The rule the asset editor's `createSignalNode` uses: `isSignalNameTaken` +
 * `freeSignalName`. The point of a dedicated occupancy check is that
 * `isDuplicateSignalName` cannot answer this question — it reports a name used
 * MORE THAN ONCE (the fail-closed bind-slot rule), so it is `false` for a name
 * taken exactly once, which is precisely the case a default name must avoid.
 *
 * The second half is the one-transaction case: two signals created inside ONE
 * `withTransaction` have no store entries yet when the second default is picked,
 * so the reservation set carries the first name.
 */

import { describe, expect, it } from 'vitest';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import {
  freeSignalName, isDuplicateSignalName, isSignalNameTaken,
} from '../src/core/engine/rv-signal-construction';

describe('isSignalNameTaken', () => {
  it('is true for a name taken exactly ONCE — where isDuplicateSignalName is false', () => {
    const store = new SignalStore();
    store.register('PLCOutputBool', 'M/A/PLCOutputBool', false, 'PLCOutputBool');
    expect(isSignalNameTaken(store, 'PLCOutputBool')).toBe(true);
    expect(isDuplicateSignalName(store, 'PLCOutputBool')).toBe(false);
  });

  it('is false for an unknown name, and true for a reserved one', () => {
    const store = new SignalStore();
    expect(isSignalNameTaken(store, 'Fresh')).toBe(false);
    expect(isSignalNameTaken(store, 'Fresh', ['Fresh'])).toBe(true);
    expect(isSignalNameTaken(store, '')).toBe(false);
  });

  it('sees a name that only exists as a value (an interface-only symbol)', () => {
    const store = new SignalStore();
    store.set('Iface.Only', true);
    expect(isSignalNameTaken(store, 'Iface.Only')).toBe(true);
  });
});

describe('freeSignalName', () => {
  it('returns the base when it is free', () => {
    expect(freeSignalName(new SignalStore(), 'PLCOutputBool')).toBe('PLCOutputBool');
  });

  it('a SECOND signal with the taken default name gets a free one', () => {
    const store = new SignalStore();
    store.register('PLCOutputBool', 'M/A/PLCOutputBool', false, 'PLCOutputBool');
    expect(freeSignalName(store, 'PLCOutputBool')).toBe('PLCOutputBool_1');
  });

  it('skips a whole run of taken names', () => {
    const store = new SignalStore();
    store.register('Sig', 'M/A', false, 'PLCOutputBool');
    store.register('Sig_1', 'M/B', false, 'PLCOutputBool');
    store.register('Sig_2', 'M/C', false, 'PLCOutputBool');
    expect(freeSignalName(store, 'Sig')).toBe('Sig_3');
  });

  it('several signals created in ONE transaction never collide', () => {
    const store = new SignalStore();
    const reserved = new Set<string>();
    const picked: string[] = [];
    // Nothing reaches the store in between — the reservation set is the only
    // thing that keeps the three apart.
    for (let i = 0; i < 3; i++) {
      const name = freeSignalName(store, 'PLCInputBool', reserved);
      reserved.add(name);
      picked.push(name);
    }
    expect(picked).toEqual(['PLCInputBool', 'PLCInputBool_1', 'PLCInputBool_2']);
    expect(new Set(picked).size).toBe(3);
  });

  it('combines store occupancy and reservations', () => {
    const store = new SignalStore();
    store.register('Sig_1', 'M/A', false, 'PLCOutputBool');
    expect(freeSignalName(store, 'Sig', ['Sig'])).toBe('Sig_2');
  });
});
