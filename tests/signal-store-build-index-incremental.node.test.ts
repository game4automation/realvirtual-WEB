// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-774 Phase 4 — `SignalStore.buildIndex()` is incremental.
 *
 * Every materialised placement, library component and drive-behaviour
 * construction calls `buildIndex()` after registering its signals; the full
 * rebuild re-split every path each time (PlannerGate30 in the editor: ~480 ms
 * of a 1.8 s open). The incremental build must leave EXACTLY the path index a
 * full rebuild leaves — including first-wins suffix claims after a removal
 * freed a suffix. Pinned by running the same operation sequence on two stores:
 * one incremental, one forced to rebuild fully before every `buildIndex()`.
 */
import { describe, expect, it } from 'vitest';
import { SignalStore } from '../src/core/engine/rv-signal-store';

type Internals = { pathToName: Map<string, string>; _indexedPaths: Set<string> };

function indexOf(store: SignalStore): Array<[string, string]> {
  return [...(store as unknown as Internals).pathToName.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/** Apply `step` to both stores; the reference forgets its incremental state before every build. */
function both(inc: SignalStore, full: SignalStore, step: (s: SignalStore, isFull: boolean) => void): void {
  step(inc, false);
  step(full, true);
}

function build(s: SignalStore, isFull: boolean): void {
  if (isFull) (s as unknown as Internals)._indexedPaths.clear();
  s.buildIndex();
}

describe('plan-774 — SignalStore.buildIndex incremental = full rebuild', () => {
  it('additions across many builds (the per-placement pattern)', () => {
    const inc = new SignalStore();
    const full = new SignalStore();
    for (let p = 0; p < 20; p++) {
      both(inc, full, (s, f) => {
        s.register(`Sig_${p}_a`, `Layout/Gate_${p}/Conveyor/Drive/Speed`, 0, 'PLCOutputFloat');
        s.register(`Sig_${p}_b`, `Layout/Gate_${p}/Sensor/Occupied`, false, 'PLCInputBool');
        build(s, f);
      });
      expect(indexOf(inc)).toEqual(indexOf(full));
    }
    // A shared suffix (`Sensor/Occupied`) stays with the FIRST claimant, as before.
    expect((inc as unknown as Internals).pathToName.get('Sensor/Occupied')).toBe('Sig_0_b');
  });

  it('a removal that frees a suffix: the next build re-claims it exactly like a full rebuild', () => {
    const inc = new SignalStore();
    const full = new SignalStore();
    both(inc, full, (s, f) => {
      s.register('A', 'A/x/Speed', 0);
      s.register('B', 'B/x/Speed', 0);
      build(s, f);
    });
    expect(indexOf(inc)).toEqual(indexOf(full));
    both(inc, full, (s, f) => {
      s.unregisterPath('A/x/Speed', 'A');
      build(s, f);
    });
    expect(indexOf(inc)).toEqual(indexOf(full));
    expect((inc as unknown as Internals).pathToName.get('x/Speed')).toBe('B');
    both(inc, full, (s, f) => {
      s.register('C', 'C/y/x/Speed', 0);
      build(s, f);
    });
    expect(indexOf(inc)).toEqual(indexOf(full));
  });

  it('prefix unregister, rename and remap in between keep both stores equal', () => {
    const inc = new SignalStore();
    const full = new SignalStore();
    both(inc, full, (s, f) => {
      for (let i = 0; i < 5; i++) s.register(`P${i}`, `Root/Cell_${i}/Slide/Pos`, i);
      build(s, f);
    });
    both(inc, full, (s, f) => {
      s.unregisterByPrefix('Root/Cell_1');
      build(s, f);
    });
    expect(indexOf(inc)).toEqual(indexOf(full));
    both(inc, full, (s, f) => {
      s.renameSignal('P2', 'P2b');
      s.remapPaths(new Map([['Root/Cell_3/Slide/Pos', 'Root/Moved/Cell_3/Slide/Pos']]));
      s.register('Q', 'Other/Slide/Pos', 0);
      build(s, f);
    });
    expect(indexOf(inc)).toEqual(indexOf(full));
    both(inc, full, (s, f) => {
      s.clear();
      s.register('Z', 'Z/a/b', 0);
      build(s, f);
    });
    expect(indexOf(inc)).toEqual(indexOf(full));
  });
});
