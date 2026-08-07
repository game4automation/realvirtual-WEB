// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-260 tests §9.3 — run lifecycle & archiving:
 *  - archive on manager.reset() (B1) with the correct sim time + statistics
 *  - status: 'aborted' on early reset, 'completed' on duration-reached
 *  - once-per-run: a second reset archives nothing (no double archive)
 *  - S1 guard: resets without processed events produce NO run entries
 *  - `des:complete` once-per-run edge detection (markCompleteNotified)
 *  - auto seed mode assigns a fresh seed on reset (F12)
 *  - restore suppression: manager.reset() inside a restore does not archive
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Object3D, Scene } from 'three';
import { DESManager } from '@rv-private/plugins/des/rv-des-manager';
import { DES } from '@rv-private/plugins/des/rv-des-api';
import { DESSource } from '@rv-private/plugins/des/rv-des-source';
import { DESSink } from '@rv-private/plugins/des/rv-des-sink';
import { DESStation } from '@rv-private/plugins/des/rv-des-station';
import type { DESComponent } from '@rv-private/plugins/des/rv-des-component';
import { resetDESMUCounter } from '@rv-private/plugins/des/rv-des-mu';
import { RunLifecycleController } from '@rv-private/plugins/des/rv-des-run-lifecycle';
import type { SnapshotStore } from '@rv-private/plugins/des/rv-des-experiment-store';
import type { RunResult } from '@rv-private/plugins/des/rv-des-experiment-model';
import { NodeRegistry } from '../../src/core/engine/rv-node-registry';
import { SignalStore } from '../../src/core/engine/rv-signal-store';
import {
  __resetDesRunSettingsForTest,
  updateDesRunSettings,
} from '../../src/core/hmi/des-run-settings-store';
import type { RunScope } from '../../src/core/material-flow/rv-run-history-store';
import type { SimDesStatistics } from '../../src/core/material-flow/simulation-kernel';

// ── In-memory store stub: captures recordRun calls ──

interface Recorded { model: string; exp: string; seed: number; run: RunResult }

function makeStoreStub(): { store: SnapshotStore; recorded: Recorded[] } {
  const recorded: Recorded[] = [];
  const store = {
    recordRun: (model: string, exp: string, seed: number, run: RunResult): Promise<number> => {
      recorded.push({ model, exp, seed, run });
      return Promise.resolve(recorded.length - 1);
    },
  } as unknown as SnapshotStore;
  return { store, recorded };
}

// ── Small source→station→sink harness (baseline-test pattern) ──

function createNode(name: string, x = 0): Object3D {
  const node = new Object3D();
  node.name = name;
  node.position.set(x, 0, 0);
  return node;
}

function createSim(seed = 42) {
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
  manager.setMasterSeed(seed);

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

  const runUntil = (time: number): void => {
    manager.duration = time;
    let guard = 0;
    while (manager.currentTime < time && guard++ < 1000000) manager.processAnimated(0.5);
  };

  const stats = (): SimDesStatistics => ({
    simTime: manager.currentTime,
    components: [], bottleneck: null, meanUtilization: 50, throughputPerHour: 100,
  });

  return { manager, source, station, sink, runUntil, stats };
}

const SCOPE: RunScope = { model: 'TestModel', exp: 'Exp A', projectId: 'p1' };

describe('RunLifecycleController (plan-260 §9.3)', () => {
  beforeEach(() => {
    __resetDesRunSettingsForTest();
    resetDESMUCounter();
  });

  it('archives the current run on manager.reset() with correct sim time (B1)', async () => {
    const sim = createSim(42);
    const { store, recorded } = makeStoreStub();
    const events: Array<{ event: string; data: unknown }> = [];
    const lifecycle = new RunLifecycleController({
      manager: sim.manager,
      getStatistics: sim.stats,
      store,
      emit: (event, data) => events.push({ event, data }),
      getScope: () => SCOPE,
    });
    lifecycle.attach();
    lifecycle.startRun();
    expect(events.some((e) => e.event === 'simulation-run-started')).toBe(true);
    expect(lifecycle.activeRun?.seed).toBe(42);

    sim.runUntil(100);
    const reached = sim.manager.currentTime;
    sim.manager.reset();
    await Promise.resolve();

    expect(recorded).toHaveLength(1);
    expect(recorded[0].model).toBe('TestModel');
    expect(recorded[0].exp).toBe('Exp A');
    expect(recorded[0].seed).toBe(42);
    expect(recorded[0].run.simTimeReached).toBeCloseTo(reached, 6);
    expect(recorded[0].run.reason).toBe('reset');
    expect(recorded[0].run.stats).toBeDefined();
    const ending = events.find((e) => e.event === 'simulation-run-ending');
    expect(ending).toBeDefined();
    expect((ending!.data as { simTime: number }).simTime).toBeCloseTo(reached, 6);
  });

  it('reset before the end archives as aborted; duration-reached completes', async () => {
    const sim = createSim(42);
    const { store, recorded } = makeStoreStub();
    const lifecycle = new RunLifecycleController({
      manager: sim.manager, getStatistics: sim.stats, store, getScope: () => SCOPE,
    });
    lifecycle.attach();

    // Run 1: aborted by an early reset (duration not reached).
    lifecycle.startRun();
    sim.manager.duration = 10000;
    let guard = 0;
    while (sim.manager.currentTime < 100 && guard++ < 100000) sim.manager.processAnimated(0.5);
    sim.manager.reset();
    await Promise.resolve();
    expect(recorded[0].run.status).toBe('aborted');

    // Run 2: completed via explicit completion edge (duration reached).
    lifecycle.startRun();
    sim.runUntil(50);
    expect(sim.manager.markCompleteNotified()).toBe(true);
    lifecycle.completeRun('duration-reached');
    await Promise.resolve();
    expect(recorded).toHaveLength(2);
    expect(recorded[1].run.status).toBe('completed');
    expect(recorded[1].run.reason).toBe('duration-reached');
  });

  it('archives exactly once per run (second reset is a no-op)', async () => {
    const sim = createSim(42);
    const { store, recorded } = makeStoreStub();
    const lifecycle = new RunLifecycleController({
      manager: sim.manager, getStatistics: sim.stats, store, getScope: () => SCOPE,
    });
    lifecycle.attach();
    lifecycle.startRun();
    sim.runUntil(50);
    sim.manager.reset();
    sim.manager.reset();   // no run open, no events processed → no archive
    await Promise.resolve();
    expect(recorded).toHaveLength(1);
  });

  it('S1 guard: a reset without processed events archives nothing', async () => {
    const sim = createSim(42);
    const { store, recorded } = makeStoreStub();
    const lifecycle = new RunLifecycleController({
      manager: sim.manager, getStatistics: sim.stats, store, getScope: () => SCOPE,
    });
    lifecycle.attach();
    lifecycle.startRun();
    sim.manager.reset();   // 0 events processed → empty run, not archived
    await Promise.resolve();
    expect(recorded).toHaveLength(0);
  });

  it('null scope skips archiving (non-project sessions lose nothing silently)', async () => {
    const sim = createSim(42);
    const { store, recorded } = makeStoreStub();
    const lifecycle = new RunLifecycleController({
      manager: sim.manager, getStatistics: sim.stats, store, getScope: () => null,
    });
    lifecycle.attach();
    lifecycle.startRun();
    sim.runUntil(50);
    sim.manager.reset();
    await Promise.resolve();
    expect(recorded).toHaveLength(0);
  });

  it('des:complete edge detection fires exactly once per run (A3)', () => {
    const sim = createSim(42);
    expect(sim.manager.markCompleteNotified()).toBe(true);
    expect(sim.manager.markCompleteNotified()).toBe(false);
    sim.manager.reset();   // re-arms the guard
    expect(sim.manager.markCompleteNotified()).toBe(true);
  });

  it('auto seed mode assigns a fresh seed on reset (F12)', async () => {
    updateDesRunSettings({ seedMode: 'auto' });
    const sim = createSim(42);
    const { store } = makeStoreStub();
    const lifecycle = new RunLifecycleController({
      manager: sim.manager, getStatistics: sim.stats, store, getScope: () => SCOPE,
    });
    lifecycle.attach();
    lifecycle.startRun();
    sim.runUntil(50);
    sim.manager.reset();
    await Promise.resolve();
    expect(sim.manager.masterSeed).not.toBe(42);
    expect(sim.manager.masterSeed).toBeGreaterThan(0);
  });

  it('fixed seed mode keeps the seed on reset (F2)', async () => {
    const sim = createSim(42);
    const { store } = makeStoreStub();
    const lifecycle = new RunLifecycleController({
      manager: sim.manager, getStatistics: sim.stats, store, getScope: () => SCOPE,
    });
    lifecycle.attach();
    lifecycle.startRun();
    sim.runUntil(50);
    sim.manager.reset();
    expect(sim.manager.masterSeed).toBe(42);
  });

  it('restore suppression: manager.reset() during a restore does not archive', async () => {
    const sim = createSim(42);
    const { store, recorded } = makeStoreStub();
    const lifecycle = new RunLifecycleController({
      manager: sim.manager, getStatistics: sim.stats, store, getScope: () => SCOPE,
    });
    lifecycle.attach();
    lifecycle.startRun();
    sim.runUntil(50);
    lifecycle.beginRestore();
    sim.manager.reset();   // internal reset of a restoreFull — must not archive
    lifecycle.endRestore();
    await Promise.resolve();
    expect(recorded).toHaveLength(0);
    // The run stays open and archives normally afterwards? — No: restore
    // replaces the state; the lifecycle keeps the run open for continuation.
    expect(lifecycle.activeRun).not.toBeNull();
  });
});
