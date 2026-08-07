// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Checkpoint autosave on GRID-ALIGNED sim times (plan-260 F15/F16/F17,
 * rasterized): the CheckpointController plans a neutral checkpoint SYSTEM
 * event exactly onto every interval boundary of the DESManager's event queue.
 *
 *  - checkpoints land EXACTLY on interval boundaries (t = n·interval),
 *    independent of the model's event times (F15)
 *  - the boundary snapshot contains the effect of ALL time-equal model events
 *    (checkpoint priority = Int32 min → fires last at its time)
 *  - model behavior/statistics are bit-identical with autosave on vs off
 *    (the system event is never counted, never serialized, never dispatched
 *    through the action table)
 *  - the wall-clock rate limit (S3) skips the SAVE only — the chain of
 *    boundary events never breaks; skipped boundaries are not made up
 *  - runtime `autoSaveInterval` changes re-plan; 0 stops; re-activation re-arms
 *  - the ring buffer keeps only the newest `checkpointMax` autosaves (F17)
 *  - restore + continue is deterministic vs. an uninterrupted reference run
 *    (3-way, F16) and re-arms the chain without ghost events / double saves
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
import type { DESMU, DESMUSnapshot } from '@rv-private/plugins/des/rv-des-mu';
import {
  RunLifecycleController, CheckpointController, CHECKPOINT_LABEL, nextCheckpointBoundary,
} from '@rv-private/plugins/des/rv-des-run-lifecycle';
import { CHECKPOINT_ACTION } from '@rv-private/plugins/des/rv-des-event';
import { registerAction, ACTION_INDEX } from '@rv-private/plugins/des/rv-des-named-actions';
import { IndexedDBSnapshotStore } from '@rv-private/plugins/des/rv-des-experiment-store';
import type { SnapshotStore } from '@rv-private/plugins/des/rv-des-experiment-store';
import { NodeRegistry } from '../../src/core/engine/rv-node-registry';
import { SignalStore } from '../../src/core/engine/rv-signal-store';
import {
  __resetDesRunSettingsForTest, updateDesRunSettings,
} from '../../src/core/hmi/des-run-settings-store';
import type { RunScope } from '../../src/core/material-flow/rv-run-history-store';

const SCOPE: RunScope = { model: 'CkptModel', exp: 'E', projectId: 'p1' };

function createNode(name: string, x = 0): Object3D {
  const node = new Object3D();
  node.name = name;
  node.position.set(x, 0, 0);
  return node;
}

interface Sim {
  manager: DESManager;
  sink: DESSink;
  components: DESComponent[];
  mus: DESMU[];
  runUntil(time: number): void;
  snapshot(): DESSnapshot;
  restore(snap: DESSnapshot): void;
}

function createSim(seed = 42): Sim {
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
  // Duration is FIXED and far away: the orphan-drop rule (checkpoint events
  // past the model's end are discarded) must never fire in these component
  // tests — the sources generate indefinitely.
  manager.duration = 1e12;

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
    manager, sink, components, mus,
    runUntil(time: number) {
      let guard = 0;
      while (manager.currentTime < time && guard++ < 1000000) manager.processAnimated(0.5);
    },
    snapshot: () => createSnapshot(manager, components, mus, [], ctx.signalStore),
    restore(snap: DESSnapshot) {
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

/** Fresh experiment DB per test. */
let _lastStore: IndexedDBSnapshotStore | null = null;
async function freshStore(): Promise<IndexedDBSnapshotStore> {
  await _lastStore?.close();
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase('rv-des-experiments');
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
  _lastStore = new IndexedDBSnapshotStore();
  return _lastStore;
}

/** Controllers wired during a test — disposed in afterEach so their settings
 *  subscriptions never leak into the next test. */
const _wired: Array<{ dispose(): void }> = [];

/** Build lifecycle + checkpoint controller for a sim on a store. */
function wireCheckpoints(sim: Sim, store: SnapshotStore, opts?: {
  minWallMs?: number;
  onSnapshot?: (simTime: number) => void;
}) {
  const lifecycle = new RunLifecycleController({
    manager: sim.manager,
    getStatistics: () => null,
    store,
    getScope: () => SCOPE,
  });
  lifecycle.attach();
  const checkpoints = new CheckpointController({
    manager: sim.manager,
    lifecycle,
    store,
    getSnapshot: () => {
      const snap = sim.snapshot();
      opts?.onSnapshot?.(snap.simTime);
      return snap;
    },
    getScope: () => SCOPE,
    minWallMs: opts?.minWallMs ?? 0, // rate limit off by default (S3 is wall-clock in prod)
  });
  checkpoints.attach();
  lifecycle.startRun();
  _wired.push(checkpoints, lifecycle);
  return { lifecycle, checkpoints };
}

/** Drain the controller's serialized write chain. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 10));
}

/** Advance in slices, yielding between them so async IDB writes complete —
 *  a long sync loop never yields, which would trip the controller's
 *  back-pressure skip (intended for FastForward, S3). */
async function runChunked(sim: Sim, to: number, step = 20): Promise<void> {
  for (let t = step; t <= to; t += step) {
    sim.runUntil(Math.min(t, to));
    await settle();
  }
  sim.runUntil(to);
  await settle();
}

async function autoTimes(store: SnapshotStore): Promise<number[]> {
  const metas = await store.listSnapshots(SCOPE.model, SCOPE.exp, 0);
  return metas
    .filter((s) => s.label === CHECKPOINT_LABEL)
    .map((s) => s.simTime)
    .sort((a, b) => a - b);
}

describe('CheckpointController — grid-aligned autosaves', () => {
  beforeEach(() => {
    __resetDesRunSettingsForTest();
    resetDESMUCounter();
  });

  afterEach(() => {
    for (const c of _wired.splice(0)) c.dispose();
    vi.restoreAllMocks();
  });

  it('computes the next boundary strictly after t', () => {
    expect(nextCheckpointBoundary(0, 3600)).toBe(3600);
    expect(nextCheckpointBoundary(3599.9, 3600)).toBe(3600);
    expect(nextCheckpointBoundary(3600, 3600)).toBe(7200);
    expect(nextCheckpointBoundary(15678.4, 3600)).toBe(18000);
  });

  it('writes checkpoints EXACTLY on interval boundaries (F15)', async () => {
    updateDesRunSettings({ autoSaveInterval: 30, checkpointMax: 100 });
    const store = await freshStore();
    const sim = createSim(42);
    wireCheckpoints(sim, store);

    await runChunked(sim, 100);

    // Boundaries 30/60/90 — exact, independent of the model's event times
    // (arrivals every 10 s, station completions on odd 5 s offsets).
    expect(await autoTimes(store)).toEqual([30, 60, 90]);
  });

  it('boundary snapshot contains the effect of time-equal model events', async () => {
    // Arrivals land every 10 s → one arrival EXACTLY on the 30 s boundary.
    updateDesRunSettings({ autoSaveInterval: 30, checkpointMax: 100 });
    const store = await freshStore();
    const sim = createSim(42);
    wireCheckpoints(sim, store);
    await runChunked(sim, 70);

    const stored = await store.readSnapshot(SCOPE.model, SCOPE.exp, 0, 30);
    expect(stored).not.toBeNull();
    expect(stored!.simTime).toBe(30);

    // Reference: an autosave-free run processed through ALL events at t <= 30
    // (the checkpoint fires with minimum priority → after every time-equal
    // model event). The full snapshots must be identical — same MUs, same
    // event queue, same RNG streams, same statistics.
    const ref = createSim(42);
    ref.manager.duration = 30;
    ref.manager.processEvents(1e9);
    expect(ref.manager.currentTime).toBe(30); // an arrival sits exactly on 30
    ref.manager.duration = 1e12;
    expect(stored).toEqual(ref.snapshot());
  });

  it('model behavior & statistics identical with autosave on vs off', async () => {
    updateDesRunSettings({ autoSaveInterval: 30, checkpointMax: 100 });
    const store = await freshStore();

    const off = createSim(42); // no controller
    off.runUntil(200);

    const on = createSim(42);
    wireCheckpoints(on, store);
    await runChunked(on, 200);

    expect(on.sink.totalProcessed).toBe(off.sink.totalProcessed);
    // System events are NOT counted as processed model events.
    expect(on.manager.totalEventsProcessed).toBe(off.manager.totalEventsProcessed);
    // Full state (components, MUs, RNG streams, queue, statistics) identical —
    // the pending checkpoint system event is never serialized.
    expect(on.snapshot()).toEqual(off.snapshot());
  });

  it('autoSaveInterval = 0 disables checkpointing (F15)', async () => {
    updateDesRunSettings({ autoSaveInterval: 0 });
    const store = await freshStore();
    const sim = createSim(42);
    wireCheckpoints(sim, store);

    sim.runUntil(100);
    await settle();

    expect(sim.manager.hasScheduledCheckpoint).toBe(false);
    const meta = await store.readManifest(SCOPE.model, SCOPE.exp);
    const snaps = meta?.replications.flatMap((r) => r.snapshots) ?? [];
    expect(snaps).toHaveLength(0);
  });

  it('wall-clock throttle skips the SAVE but never breaks the chain (S3)', async () => {
    updateDesRunSettings({ autoSaveInterval: 30, checkpointMax: 100 });
    const store = await freshStore();
    const sim = createSim(42);

    let wall = 1000;
    vi.spyOn(Date, 'now').mockImplementation(() => wall);
    wireCheckpoints(sim, store, { minWallMs: 500 });

    sim.runUntil(40);   // boundary 30: 1000 - 0 >= 500 → saved
    await settle();
    sim.runUntil(70);   // boundary 60: wall unchanged → SAVE skipped, chain re-armed
    await settle();
    wall = 2000;
    sim.runUntil(100);  // boundary 90: 2000 - 1000 >= 500 → saved again
    await settle();

    // 60 was skipped and is NOT made up; the chain continued to 90.
    expect(await autoTimes(store)).toEqual([30, 90]);
  });

  it('runtime interval change re-plans; 0 stops; re-activation re-arms', async () => {
    updateDesRunSettings({ autoSaveInterval: 0 });
    const store = await freshStore();
    const sim = createSim(42);
    wireCheckpoints(sim, store);

    await runChunked(sim, 60);                        // off → nothing
    expect(await autoTimes(store)).toEqual([]);

    updateDesRunSettings({ autoSaveInterval: 25 });   // arm: next boundary after 60 = 75
    await runChunked(sim, 140);                       // saves 75 / 100 / 125
    expect(await autoTimes(store)).toEqual([75, 100, 125]);

    updateDesRunSettings({ autoSaveInterval: 0 });    // stop
    expect(sim.manager.hasScheduledCheckpoint).toBe(false);
    await runChunked(sim, 200);
    expect(await autoTimes(store)).toEqual([75, 100, 125]);

    updateDesRunSettings({ autoSaveInterval: 50 });   // re-arm: boundary after 200 = 250
    await runChunked(sim, 260);
    expect(await autoTimes(store)).toEqual([75, 100, 125, 250]);
  });

  it('ring buffer keeps only checkpointMax newest autosaves per run (F17)', async () => {
    updateDesRunSettings({ autoSaveInterval: 10, checkpointMax: 3 });
    const store = await freshStore();
    const sim = createSim(42);
    wireCheckpoints(sim, store);

    await runChunked(sim, 200);

    expect(await autoTimes(store)).toEqual([180, 190, 200]);
  });

  it('restore from an autosaved checkpoint + continue equals the uninterrupted run (F16)', async () => {
    updateDesRunSettings({ autoSaveInterval: 50, checkpointMax: 10 });
    const store = await freshStore();

    // Reference: uninterrupted run to t=300.
    const ref = createSim(42);
    ref.runUntil(300);
    const refProcessed = ref.sink.totalProcessed;
    const refEvents = ref.manager.totalEventsProcessed;

    // Autosaved run to 150 (grid checkpoints at exactly 50 / 100 / 150).
    const cut = createSim(42);
    wireCheckpoints(cut, store);
    await runChunked(cut, 150, 25);

    const autos = await autoTimes(store);
    expect(autos).toEqual([50, 100, 150]);
    const snap = await store.readSnapshot(SCOPE.model, SCOPE.exp, 0, 150);
    expect(snap).not.toBeNull();
    expect(snap!.simTime).toBe(150);

    // Restore into a FRESH sim (different seed — must not matter) + continue.
    const fresh = createSim(7);
    fresh.restore(snap!);
    expect(fresh.manager.currentTime).toBe(150);
    fresh.runUntil(300);
    expect(fresh.sink.totalProcessed).toBe(refProcessed);
    expect(fresh.manager.totalEventsProcessed).toBe(refEvents);
  });

  it('restore re-arms the chain — no ghost event, no double save', async () => {
    updateDesRunSettings({ autoSaveInterval: 50, checkpointMax: 10 });
    const store = await freshStore();
    const sim = createSim(42);
    const snapCalls: number[] = [];
    wireCheckpoints(sim, store, { onSnapshot: (t) => snapCalls.push(t) });

    await runChunked(sim, 120);
    expect(snapCalls).toEqual([50, 100]);
    // The upcoming boundary rides the event queue as the system event.
    expect(sim.manager.hasScheduledCheckpoint).toBe(true);
    expect(sim.manager.getEventQueueSnapshot().some(
      (e) => e.actionName === CHECKPOINT_ACTION && !e.cancelled && e.time === 150,
    )).toBe(true);

    // Restore back to the t=50 checkpoint. The snapshot never carries the
    // system event — the restored queue must be ghost-free …
    const snap50 = await store.readSnapshot(SCOPE.model, SCOPE.exp, 0, 50);
    expect(snap50!.eventQueue.every((e) => e.action !== CHECKPOINT_ACTION)).toBe(true);
    sim.restore(snap50!);
    expect(sim.manager.currentTime).toBe(50);
    expect(sim.manager.hasScheduledCheckpoint).toBe(false);
    expect(sim.manager.getEventQueueSnapshot().some(
      (e) => e.actionName === CHECKPOINT_ACTION && !e.cancelled,
    )).toBe(false);

    // … and the chain re-arms off the time-advance fallback: boundaries at
    // 100 / 150 / 200 fire exactly once each (100 overwrites its earlier
    // copy in the store — same sim time, no duplicate entry).
    await runChunked(sim, 220);
    expect(snapCalls).toEqual([50, 100, 100, 150, 200]);
    const times = await autoTimes(store);
    expect(times).toEqual([50, 100, 150, 200]);
  });
});

// ── Manager-level system-event semantics ──

/** Log of dispatched test events (reset per test). */
const _log: string[] = [];
if (!ACTION_INDEX.has('CkptTest.Ping')) {
  registerAction('CkptTest.Ping', (ctx) => { _log.push(`model@${ctx.simTime}`); });
}

describe('DESManager checkpoint system event', () => {
  let m: DESManager;

  beforeEach(() => {
    _log.length = 0;
    m = new DESManager();
    m.duration = 100;
    m.onCheckpoint = (t) => { _log.push(`ckpt@${t}`); };
  });

  it('fires exactly on the boundary AFTER all time-equal model events', () => {
    m.scheduleCheckpoint(10);
    m.scheduleEvent(5, 'CkptTest.Ping', -1);
    m.scheduleEvent(10, 'CkptTest.Ping', -1); // same time, default priority → first
    m.scheduleEvent(15, 'CkptTest.Ping', -1);
    m.processEvents(1e6);
    expect(_log).toEqual(['model@5', 'model@10', 'ckpt@10', 'model@15']);
    // System events are never counted as processed model events.
    expect(m.totalEventsProcessed).toBe(3);
  });

  it('drops an orphan checkpoint when no model event remains (no clock advance)', () => {
    m.scheduleEvent(5, 'CkptTest.Ping', -1);
    m.scheduleCheckpoint(10);
    m.processEvents(1e6);
    expect(_log).toEqual(['model@5']);
    expect(m.currentTime).toBe(5);
    expect(m.hasScheduledCheckpoint).toBe(false);
    expect(m.isComplete).toBe(true);
  });

  it('drops an orphan checkpoint when all remaining model events lie past the duration', () => {
    m.scheduleEvent(5, 'CkptTest.Ping', -1);
    m.scheduleEvent(200, 'CkptTest.Ping', -1); // beyond duration 100
    m.scheduleCheckpoint(10);
    m.processEvents(1e6);
    expect(_log).toEqual(['model@5']);
    expect(m.currentTime).toBe(5);
    expect(m.hasScheduledCheckpoint).toBe(false);
    expect(m.isComplete).toBe(true);
  });

  it('a pending checkpoint never keeps a finished run alive (isComplete)', () => {
    m.scheduleCheckpoint(10);
    expect(m.nextModelEventTime).toBe(Number.POSITIVE_INFINITY);
    expect(m.isComplete).toBe(true);
  });

  it('re-scheduling replaces the pending checkpoint (single slot)', () => {
    m.scheduleCheckpoint(10);
    m.scheduleCheckpoint(20);
    m.scheduleEvent(30, 'CkptTest.Ping', -1);
    m.processEvents(1e6);
    expect(_log).toEqual(['ckpt@20', 'model@30']);
  });

  it('is excluded from snapshots and filtered on restore', () => {
    m.scheduleCheckpoint(10);
    m.scheduleEvent(20, 'CkptTest.Ping', -1);
    const snap = m.snapshot();
    expect(snap.events).toHaveLength(1);
    expect(snap.events[0].action).toBe('CkptTest.Ping');

    // A (legacy) snapshot carrying a serialized system event must not restore it.
    m.restore({
      currentTime: 0,
      masterSeed: 42,
      rngState: [1, 2, 3, 4],
      totalEventsProcessed: 0,
      events: [{
        time: 10, action: CHECKPOINT_ACTION, componentPath: '', muId: -1,
        priority: -0x80000000, data: null,
      }],
    });
    expect(m.pendingEventCount).toBe(0);
    expect(m.hasScheduledCheckpoint).toBe(false);
  });
});
