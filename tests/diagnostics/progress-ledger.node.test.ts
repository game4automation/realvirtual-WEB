// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it, vi } from 'vitest';
import { ProgressLedger } from '../../src/core/diagnostics/rv-progress-ledger';

function setup() {
  let now = 0;
  let ids = ['A', 'B', 'C'];
  const ledger = new ProgressLedger({ clock: { now: () => now } });
  ledger.addPopulation({ id: 'fleet', kind: 'vehicle', expected: () => ids });
  for (const id of ids) ledger.register(id, 'vehicle', 'vehicle');
  return { ledger, time: (t: number) => { now = t; }, population: (v: string[]) => { ids = v; } };
}

describe('ProgressLedger', () => {
  it('counts monotonically and only armed entries become candidates', () => {
    const { ledger, time } = setup();
    ledger.arm('A'); ledger.arm('B'); ledger.complete('B');
    time(10);
    ledger.bump('A', 'vehicle', 5);
    ledger.bump('A', 'vehicle', -1); ledger.bump('A', 'vehicle', NaN);
    ledger.register('A', 'vehicle', 'duplicate');
    expect(ledger.entry('A')?.count).toBe(5);
    expect(ledger.sample(5).candidates).toEqual([]);
    time(15);
    const result = ledger.sample(5);
    expect(result.candidates.map(e => e.unitId)).toEqual(['A']);
    expect(result.coverage).toMatchObject({ armed: 1, complete: 1, inactive: 1 });
    ledger.complete('A');
    expect(result.candidates[0].state).toBe('armed');
    expect(ledger.sample(0).candidates).toEqual([]);
    ledger.arm('C'); time(20); ledger.inactive('C');
    expect(ledger.sample(0).candidates).toEqual([]);
  });

  it('detaches entries, resets idle age on rearm, and removes departing population', () => {
    const { ledger, time, population } = setup();
    ledger.arm('A');
    const entry = ledger.entry('A')!;
    time(100); ledger.inactive('A'); ledger.arm('A');
    expect(entry.lastChangeSec).toBe(0);
    expect(ledger.sample(1).candidates).toEqual([]);
    population(['B', 'C']);
    expect(ledger.sample(0).coverage.registered).toBe(2);
    expect(ledger.entry('A')).toBeNull();
    ledger.reset();
    expect(ledger.sample(0).coverage.missing).toEqual(['B', 'C']);
  });

  it('handles 100000 bumps without rebuilding entries or reading population', () => {
    const { ledger } = setup();
    const expected = vi.fn(() => ['A']);
    ledger.addPopulation({ id: 'extra', kind: 'vehicle', expected });
    for (let i = 0; i < 100000; i++) ledger.bump('A', 'vehicle');
    expect(expected).not.toHaveBeenCalled();
    expect(ledger.entry('A')?.count).toBe(100000);
    ledger.bump('foreign', 'other');
    expect(ledger.entry('foreign')).toBeNull();
    expect(ledger.sample(0).coverage.unknown).toEqual(['foreign']);
  });

  it('samples 1000 units with one population read and one clock read', () => {
    const now = vi.fn(() => 10);
    const ids = Array.from({ length: 1000 }, (_, i) => `V${i}`);
    const expected = vi.fn(() => ids);
    const ledger = new ProgressLedger({ clock: { now } });
    ledger.addPopulation({ id: 'fleet', kind: 'vehicle', expected });
    for (const id of ids) { ledger.register(id, 'vehicle', 'vehicle'); ledger.arm(id); }
    now.mockClear();
    const result = ledger.sample(0);
    expect(result.candidates).toHaveLength(1000);
    expect(result.candidates.map(e => e.unitId)).toEqual([...ids].sort());
    expect(expected).toHaveBeenCalledTimes(1);
    expect(now).toHaveBeenCalledTimes(1);
  });
});
