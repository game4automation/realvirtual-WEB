// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { componentState } from './snapshot-test-utils';
/** v4 statistics continuation and mutation-free refusal of legacy or invalid data. */

import { describe, it, expect, beforeEach } from 'vitest';
import { lineFixture } from './runner-fixture';
import { resetDESMUCounter } from '@rv/plugins/des/rv-des-mu';

const createSim = lineFixture;

describe('DES snapshot — statistics baseline (9.2)', () => {
  beforeEach(() => resetDESMUCounter());

  it('KPIs after restore equal KPIs before snapshot (baseline fields round-trip)', () => {
    const sim = createSim({ seed: 42, statResetTime: 40 });
    sim.runUntil(100);   // crosses the warmup reset at t=40
    const before = sim.station.getStatistics();
    expect(before.outputPerHour).toBeGreaterThan(0);

    const snap = sim.snapshot();
    // Baseline fields live in the component participant.
    const stationSnap = componentState(snap, 'Station');
    expect(stationSnap.statBaselineTime).toBeCloseTo(40, 6);
    expect(typeof stationSnap.processedBaseline).toBe('number');

    const sim2 = createSim({ seed: 42, statResetTime: 40 });
    sim2.restore(snap);
    const after = sim2.station.getStatistics();
    expect(after.utilization).toBeCloseTo(before.utilization, 6);
    expect(after.outputPerHour).toBeCloseTo(before.outputPerHour, 6);
    expect(after.totalProcessed).toBe(before.totalProcessed);
  });

  it('restore + continue produces identical sink throughput as an uninterrupted run (9.2/F3)', () => {
    const ref = createSim({ seed: 42 });
    ref.runUntil(300);
    const refProcessed = ref.sink.totalProcessed;

    const cut = createSim({ seed: 42 });
    cut.runUntil(150);
    const snap = cut.snapshot();

    const fresh = createSim({ seed: 42 });   // different seed — must not matter
    fresh.restore(snap);
    expect(fresh.manager.currentTime).toBeCloseTo(snap.simTime, 9);
    fresh.runUntil(300);
    expect(fresh.sink.totalProcessed).toBe(refProcessed);
    expect(fresh.manager.totalEventsProcessed).toBe(ref.manager.totalEventsProcessed);
  });
});

describe('DES snapshot legacy refusal', () => {
  it.each([1, 2, 3])('refuses v%s without changing the world', version => {
    const sim = createSim(); sim.runUntil(100);
    const before = sim.runner.snapshotJson();
    expect(() => sim.restore({ version, simTime: 999 })).toThrow('des-snapshot-legacy');
    expect(sim.runner.snapshotJson()).toBe(before);
  });
  it('refuses an unknown component id without changing the world', () => {
    const sim = createSim(); sim.runUntil(50);
    const before = sim.runner.snapshotJson(), snap = sim.snapshot();
    snap.parts.find(p => p.key.includes('Station'))!.key = 'RenamedStation@Station';
    expect(() => sim.restore(snap)).toThrow('des-snapshot-contract');
    expect(sim.runner.snapshotJson()).toBe(before);
  });
});
