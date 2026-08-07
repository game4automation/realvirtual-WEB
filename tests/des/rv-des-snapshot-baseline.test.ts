// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-261 tests §9.2 / §9.9 / §9.10:
 *  - 9.2  statistics baseline: KPIs after restore == before snapshot (incl.
 *         warmup stats-reset baseline).
 *  - 9.9  v1→v2 migration: a v1 snapshot (no scriptStates / statBaselineTime)
 *         loads without crash and KPIs stay numbers (no NaN).
 *  - 9.10 restore into a model with a renamed/removed station warns and does
 *         not crash.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Object3D, Scene } from 'three';
import { DESManager } from '@rv-private/plugins/des/rv-des-manager';
import { DES } from '@rv-private/plugins/des/rv-des-api';
import { DESSource } from '@rv-private/plugins/des/rv-des-source';
import { DESSink } from '@rv-private/plugins/des/rv-des-sink';
import { DESStation } from '@rv-private/plugins/des/rv-des-station';
import type { DESComponent } from '@rv-private/plugins/des/rv-des-component';
import { createSnapshot, restoreSnapshot } from '@rv-private/plugins/des/rv-des-snapshot';
import type { DESSnapshot } from '@rv-private/plugins/des/rv-des-snapshot';
import { resetDESMUCounter, createDESMU } from '@rv-private/plugins/des/rv-des-mu';
import type { DESMUSnapshot } from '@rv-private/plugins/des/rv-des-mu';
import type { DESMU } from '@rv-private/plugins/des/rv-des-mu';
import { NodeRegistry } from '../../src/core/engine/rv-node-registry';
import { SignalStore } from '../../src/core/engine/rv-signal-store';

function createNode(name: string, x = 0): Object3D {
  const node = new Object3D();
  node.name = name;
  node.position.set(x, 0, 0);
  return node;
}

interface Sim {
  manager: DESManager;
  source: DESSource;
  station: DESStation;
  sink: DESSink;
  components: DESComponent[];
  mus: DESMU[];
  signalStore: SignalStore;
  runUntil(time: number): void;
  snapshot(): DESSnapshot;
  restore(snap: DESSnapshot): void;
}

function createSim(opts: { seed?: number; statResetTime?: number } = {}): Sim {
  const scene = new Scene();
  const ctx = {
    registry: new NodeRegistry(),
    signalStore: new SignalStore(),
    scene,
    transportManager: {} as never,
    root: scene,
  };
  const manager = new DESManager();
  DES.setManager(manager);
  resetDESMUCounter();
  if (opts.seed !== undefined) manager.setMasterSeed(opts.seed);
  if (opts.statResetTime !== undefined) manager.statResetTime = opts.statResetTime;

  const sourceNode = createNode('Source', 0);
  const stationNode = createNode('Station', 1);
  const sinkNode = createNode('Sink', 2);
  scene.add(sourceNode, stationNode, sinkNode);

  const source = new DESSource(sourceNode);
  source.InterArrivalTime = 10;
  const station = new DESStation(stationNode);
  station.ProcessingTime = 5;
  const sink = new DESSink(sinkNode);

  source.nextComponents = [station];
  station.nextComponents = [sink];
  station.previousComponents = [source];
  sink.previousComponents = [station];

  const components: DESComponent[] = [source, station, sink];
  for (const c of components) manager.registerComponent(c);
  for (const c of components) c.init(ctx);
  source.start();

  const mus: DESMU[] = [];
  source.onMUCreated = (mu: DESMU) => { mus.push(mu); };

  return {
    manager, source, station, sink, components, mus, signalStore: ctx.signalStore,
    runUntil(time: number) {
      manager.duration = time;
      // Fine-grained Animated stepping: the warmup stats-reset fires per batch,
      // so small dt slices keep the reset baseline at (almost exactly) its time.
      let guard = 0;
      while (manager.currentTime < time && guard++ < 1000000) manager.processAnimated(0.5);
    },
    snapshot: () => createSnapshot(manager, components, mus, [], ctx.signalStore),
    restore(snap: DESSnapshot) {
      // MU factory: re-create every serialized MU at its ORIGINAL slot id.
      const muFactory = (muSnap: DESMUSnapshot) => {
        const mu = createDESMU(muSnap.creationTime);
        mu.customId = muSnap.customId;
        manager.registerMUAt(mu, muSnap.id);
        mus.push(mu);
        return mu;
      };
      restoreSnapshot(snap, manager, components, mus, [], ctx.signalStore, muFactory);
    },
  };
}

describe('DES snapshot — statistics baseline (9.2)', () => {
  beforeEach(() => resetDESMUCounter());

  it('KPIs after restore equal KPIs before snapshot (baseline fields round-trip)', () => {
    const sim = createSim({ seed: 42, statResetTime: 40 });
    sim.runUntil(100);   // crosses the warmup reset at t=40
    const before = sim.station.getStatistics();
    expect(before.outputPerHour).toBeGreaterThan(0);

    const snap = sim.snapshot();
    // Baseline fields are v2 snapshot content now.
    const stationSnap = snap.components['Station'];
    expect(stationSnap.statBaselineTime).toBeCloseTo(40, 6);
    expect(typeof stationSnap.processedBaseline).toBe('number');

    const sim2 = createSim({ seed: 99 });
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

    const fresh = createSim({ seed: 7 });   // different seed — must not matter
    fresh.restore(snap);
    expect(fresh.manager.currentTime).toBeCloseTo(snap.simTime, 9);
    fresh.runUntil(300);
    expect(fresh.sink.totalProcessed).toBe(refProcessed);
    expect(fresh.manager.totalEventsProcessed).toBe(ref.manager.totalEventsProcessed);
  });
});

describe('DES snapshot — v1→v2 migration defaults (9.9)', () => {
  beforeEach(() => resetDESMUCounter());

  it('a v1 snapshot (no scriptStates / statBaselineTime) restores without NaN KPIs', () => {
    const sim = createSim({ seed: 42 });
    sim.runUntil(100);
    const snap = sim.snapshot();

    // Strip v2 fields → simulate a stored v1 snapshot.
    const v1 = JSON.parse(JSON.stringify(snap)) as DESSnapshot;
    (v1 as { version: number }).version = 1;
    delete v1.scriptStates;
    for (const comp of Object.values(v1.components)) {
      delete comp.statBaselineTime;
      delete comp.processedBaseline;
    }

    const sim2 = createSim({ seed: 42 });
    expect(() => sim2.restore(v1)).not.toThrow();
    sim2.runUntil(150);
    const stats = sim2.station.getStatistics();
    expect(Number.isFinite(stats.utilization)).toBe(true);
    expect(Number.isFinite(stats.outputPerHour)).toBe(true);
    expect(Number.isNaN(stats.workingPercent)).toBe(false);
  });
});

describe('DES snapshot — restore path mismatch (9.10)', () => {
  beforeEach(() => resetDESMUCounter());

  it('unknown component path warns and is discarded (no crash)', () => {
    const sim = createSim({ seed: 42 });
    sim.runUntil(50);
    const snap = sim.snapshot();

    // Rename a station in the snapshot → the live model has no such path.
    snap.components['RenamedStation'] = { ...snap.components['Station'], path: 'RenamedStation' };
    delete snap.components['Station'];

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sim2 = createSim({ seed: 42 });
    expect(() => sim2.restore(snap)).not.toThrow();
    expect(warn.mock.calls.some((c) => String(c[0]).includes('Unknown component path'))).toBe(true);
    warn.mockRestore();
  });
});
