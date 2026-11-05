// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it } from 'vitest';
import { SignalStore } from '../../src/core/engine/rv-signal-store';

// plan-2207 Phase 1 (Codex review 5): observer batches must never end on a value the store no longer holds.
describe('SignalStore write batches with re-entrant listeners', () => {
  const lastSeen = (batches: Map<string, boolean | number>[], name: string) =>
    batches.filter(b => b.has(name)).at(-1)?.get(name);

  it('a listener that clears the signal leaves the observer on the final value (set)', () => {
    const store = new SignalStore();
    store.register('a', 'Signals/a', false, 'PLCOutputBool');
    store.subscribe('a', v => { if (v === true) store.set('a', false); });
    const batches: Map<string, boolean | number>[] = [];
    store.observeWrites(b => batches.push(new Map(b)));
    store.set('a', true);
    expect(store.get('a')).toBe(false);
    expect(lastSeen(batches, 'a')).toBe(false);
  });

  it('the same holds for setMany', () => {
    const store = new SignalStore();
    store.register('a', 'Signals/a', false, 'PLCOutputBool');
    store.register('b', 'Signals/b', 0, 'PLCOutputInt');
    store.subscribe('a', v => { if (v === true) store.set('a', false); });
    const batches: Map<string, boolean | number>[] = [];
    store.observeWrites(b => batches.push(new Map(b)));
    store.setMany({ a: true, b: 3 });
    expect(store.get('a')).toBe(false);
    expect(lastSeen(batches, 'a')).toBe(false);
    expect(lastSeen(batches, 'b')).toBe(3);
  });
});
