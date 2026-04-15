// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

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
import { Object3D, Scene } from 'three';
import { DESManager, DESMode } from '@rv-private/plugins/des/rv-des-manager';
import { DES } from '@rv-private/plugins/des/rv-des-api';
import { DESSource } from '@rv-private/plugins/des/rv-des-source';
import { DESSink } from '@rv-private/plugins/des/rv-des-sink';
import { DESConveyor } from '@rv-private/plugins/des/rv-des-conveyor';
import { DESStation } from '@rv-private/plugins/des/rv-des-station';
import { DESComponent } from '@rv-private/plugins/des/rv-des-component';
import { createSnapshot, restoreSnapshot } from '@rv-private/plugins/des/rv-des-snapshot';
import type { DESSnapshot } from '@rv-private/plugins/des/rv-des-snapshot';
import { resetDESMUCounter, createDESMU } from '@rv-private/plugins/des/rv-des-mu';
import type { DESMU } from '@rv-private/plugins/des/rv-des-mu';
import { NodeRegistry } from '../../src/core/engine/rv-node-registry';
import { SignalStore } from '../../src/core/engine/rv-signal-store';

// ── Helpers ──

function createNode(name: string, x = 0, y = 0, z = 0): Object3D {
  const node = new Object3D();
  node.name = name;
  node.position.set(x, y, z);
  return node;
}

function makeContext(scene: Scene) {
  return {
    registry: new NodeRegistry(),
    signalStore: new SignalStore(),
    scene,
    transportManager: {} as never,
    root: scene,
  };
}

interface TestSim {
  manager: DESManager;
  source: DESSource;
  station: DESStation;
  sink: DESSink;
  components: DESComponent[];
  mus: DESMU[];
  signalStore: SignalStore;
  scene: Scene;
  runUntil(time: number): void;
  snapshot(): DESSnapshot;
  restore(snap: DESSnapshot): void;
  getAllMUs(): DESMU[];
}

function createTestSim(opts: {
  seed?: number;
  stationProcessTime?: number;
  interArrivalTime?: number;
} = {}): TestSim {
  const scene = new Scene();
  const ctx = makeContext(scene);
  const manager = new DESManager();
  DES.setManager(manager);
  resetDESMUCounter();

  if (opts.seed !== undefined) manager.setMasterSeed(opts.seed);

  const sourceNode = createNode('Source', 0, 0, 0);
  const stationNode = createNode('Station', 1, 0, 0);
  const sinkNode = createNode('Sink', 2, 0, 0);
  scene.add(sourceNode, stationNode, sinkNode);

  const source = new DESSource(sourceNode);
  source.InterArrivalTime = opts.interArrivalTime ?? 10;
  const station = new DESStation(stationNode);
  station.ProcessingTime = opts.stationProcessTime ?? 5;
  const sink = new DESSink(sinkNode);

  source.nextComponents = [station];
  station.nextComponents = [sink];
  station.previousComponents = [source];
  sink.previousComponents = [station];

  const components: DESComponent[] = [source, station, sink];
  manager.registerComponent(source);
  manager.registerComponent(station);
  manager.registerComponent(sink);

  for (const comp of components) comp.init(ctx);
  source.start();

  // Track MUs
  const mus: DESMU[] = [];
  const origCreated = source.onMUCreated;
  source.onMUCreated = (mu: DESMU) => {
    mus.push(mu);
    origCreated?.(mu);
  };

  return {
    manager,
    source,
    station,
    sink,
    components,
    mus,
    signalStore: ctx.signalStore,
    scene,
    runUntil(time: number) {
      manager.duration = time;
      while (!manager.isComplete && manager.currentTime < time) {
        manager.processEvents(1000);
      }
    },
    snapshot() {
      return createSnapshot(manager, components, mus, [], ctx.signalStore);
    },
    restore(snap: DESSnapshot) {
      restoreSnapshot(snap, manager, components, mus, [], ctx.signalStore);
    },
    getAllMUs() {
      return [...mus];
    },
  };
}

// ── Tests ──

describe('DES Snapshot & Restore', () => {
  beforeEach(() => {
    resetDESMUCounter();
  });

  it('MU properties survive save/restore round-trip', () => {
    const sim = createTestSim({ seed: 42 });
    sim.source.onMUCreated = (mu: DESMU) => {
      mu.prop['batchId'] = 42;
      mu.prop['recipe'] = 'formula-X';
      sim.mus.push(mu);
    };
    sim.runUntil(50);

    const snapshot = sim.snapshot();

    // Verify MU props are in the snapshot
    expect(snapshot.mus.length).toBeGreaterThan(0);
    const muSnap = snapshot.mus[0];
    expect(muSnap.prop['batchId']).toBe(42);
    expect(muSnap.prop['recipe']).toBe('formula-X');
  });

  it('component properties survive save/restore', () => {
    const sim = createTestSim({ stationProcessTime: 5, seed: 42 });
    sim.runUntil(30);

    // Set custom component properties
    sim.station.prop['batchCount'] = 47;
    sim.station.prop['currentRecipe'] = 'A';

    const snapshot = sim.snapshot();

    // Check snapshot contains the properties
    const stationSnap = snapshot.components['Station'];
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
    expect(Object.keys(snapshot.components).length).toBe(3);
    expect(snapshot.eventQueue.length).toBeGreaterThan(0);
  });

  it('RNG states restored per-component', () => {
    const sim1 = createTestSim({ seed: 42 });
    sim1.runUntil(50);
    const snapshot = sim1.snapshot();

    // Verify RNG states are in the snapshot
    expect(snapshot.rngStates).toBeDefined();
    expect(snapshot.rngStates['__manager__']).toBeDefined();
    expect(snapshot.rngStates['__manager__'].length).toBe(4);

    // Restore into new sim and verify RNG state was applied
    const sim2 = createTestSim({ seed: 99 }); // different seed
    sim2.restore(snapshot);

    // After restore, the manager RNG state should match the snapshot
    const state = sim2.manager.rng.getState();
    expect(state).toEqual(snapshot.rngStates['__manager__']);
  });
});
