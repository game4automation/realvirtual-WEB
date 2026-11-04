// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { componentState, managerState, muRecords } from './snapshot-test-utils';
/**
 * TestDESSnapshot -- Save/restore round-trip tests.
 *
 * Tests from §9.6:
 * - MU properties survive save/restore
 * - Component properties survive save/restore
 * - Restore continues with identical results as uninterrupted run
 * - RNG states restored per-component
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { lineFixture } from './runner-fixture';
import { resetDESMUCounter } from '@rv/plugins/des/rv-des-mu';

// ── Helpers ──

const createTestSim = lineFixture;

describe('DES Snapshot & Restore', () => {
  beforeEach(() => {
    resetDESMUCounter();
  });

  it('MU properties survive save/restore round-trip', () => {
    const sim = createTestSim({ seed: 42 });
    sim.runUntil(52);
    const mu = sim.station.self.mus[0];
    expect(mu).toBeDefined();
    mu.prop!['batchId'] = 42;
    mu.prop!['recipe'] = 'formula-X';

    const snapshot = sim.snapshot();

    // Verify MU props are in the snapshot
    expect(muRecords(snapshot).length).toBeGreaterThan(0);
    const muSnap = muRecords(snapshot).find(saved => saved.id === mu.id)!;
    expect(muSnap.prop['batchId']).toBe(42);
    expect(muSnap.prop['recipe']).toBe('formula-X');
    const restored = createTestSim({ seed: 42 });
    restored.restore(snapshot);
    const restoredMU = restored.station.self.mus.find(saved => saved.id === mu.id)!;
    expect(restoredMU.prop!['batchId']).toBe(42);
    expect(restoredMU.prop!['recipe']).toBe('formula-X');
  });

  it('component properties survive save/restore', () => {
    const sim = createTestSim({ stationProcessTime: 5, seed: 42 });
    sim.runUntil(30);

    // Set custom component properties
    sim.station.prop['batchCount'] = 47;
    sim.station.prop['currentRecipe'] = 'A';

    const snapshot = sim.snapshot();

    // Check snapshot contains the properties
    const stationSnap = componentState(snapshot, 'Station');
    expect(stationSnap).toBeDefined();
    expect(stationSnap.prop['batchCount']).toBe(47);
    expect(stationSnap.prop['currentRecipe']).toBe('A');

    // Create new sim and restore
    const sim2 = createTestSim({ stationProcessTime: 5, seed: 42 });
    sim2.restore(snapshot);

    expect(sim2.station.prop['batchCount']).toBe(47);
    expect(sim2.station.prop['currentRecipe']).toBe('A');
  });

  it('restore continues with identical results as uninterrupted run', () => {
    // Run sim1 uninterrupted to t=200
    const sim1 = createTestSim({ seed: 42, stationProcessTime: 5, interArrivalTime: 10 });
    sim1.runUntil(100);
    const snapshot = sim1.snapshot();

    // Record the state at t=100
    const eventsAt100 = sim1.manager.totalEventsProcessed;
    const sinkAt100 = sim1.sink.totalProcessed;

    sim1.runUntil(200);
    const resultA = sim1.sink.totalProcessed;
    const eventsAt200 = sim1.manager.totalEventsProcessed;

    // Verify sim actually progressed
    expect(resultA).toBeGreaterThan(sinkAt100);
    expect(eventsAt200).toBeGreaterThan(eventsAt100);

    // Verify snapshot captured the right simTime
    expect(snapshot.simTime).toBeGreaterThanOrEqual(100);

    // Verify snapshot has components and events
    expect(snapshot.fingerprint.components.length).toBe(3);
    expect(snapshot.eventQueue.length).toBeGreaterThan(0);
    const restored = createTestSim({ seed: 42, stationProcessTime: 5, interArrivalTime: 10 });
    restored.restore(snapshot);
    restored.runUntil(200);
    expect(restored.sink.totalProcessed).toBe(resultA);
    expect(restored.manager.totalEventsProcessed).toBe(eventsAt200);
  });

  it('RNG states restored per-component', () => {
    const sim1 = createTestSim({ seed: 42 });
    sim1.runUntil(50);
    const snapshot = sim1.snapshot();

    // Verify RNG states are in the snapshot
    expect(managerState(snapshot).rngState).toBeDefined();
    expect(managerState(snapshot).rngState).toBeDefined();
    expect(managerState(snapshot).rngState.length).toBe(4);

    // Restore into new sim and verify RNG state was applied
    const sim2 = createTestSim({ seed: 42 }); // different seed
    sim2.restore(snapshot);

    // After restore, the manager RNG state should match the snapshot
    const state = sim2.manager.rng.getState();
    expect(state).toEqual(managerState(snapshot).rngState);
  });
});
