// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-261 tests §9.3 / §9.4 / §9.8 — chunked experiment storage:
 *
 *  - 9.3 CRUD: manifest/snapshot write/list/read/delete; index consistency;
 *        model separation (F6); cascading deletes (snapshot → replication →
 *        experiment); rename.
 *  - 9.4 seed derivation: replication r uses baseSeed + r*SEED_STRIDE; same
 *        seed ⇒ identical run, different seeds ⇒ different runs.
 *  - 9.8 atomicity/concurrency: blob-before-manifest ordering; parallel saves
 *        lose no snapshot; optimistic manifest locking rejects stale writes.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  IndexedDBSnapshotStore,
  ManifestVersionConflictError,
} from '@rv-private/plugins/des/rv-des-experiment-store';
import {
  SEED_STRIDE,
  replicationSeed,
  createExperimentMeta,
} from '@rv-private/plugins/des/rv-des-experiment-model';
import type { DESSnapshot } from '@rv-private/plugins/des/rv-des-snapshot';
import { SFC32 } from '@rv-private/plugins/des/rv-des-distribution';

function makeSnapshot(simTime: number, payload = 'x'): DESSnapshot {
  return {
    version: 2,
    simTime,
    masterSeed: 42,
    nextEventId: 0,
    rngStates: { __manager__: [1, 2, 3, 4] },
    components: { Comp: {
      path: 'Comp', type: 'DESStation', state: 0, currentLoad: 0, totalProcessed: 0,
      isBlocked: false, isWorking: false, isFailure: false, exitBlocked: false,
      muIds: [], prop: { payload }, stateTimings: {}, currentStateName: 'Empty',
      statBaselineTime: 0, processedBaseline: 0,
    } },
    mus: [],
    drives: {},
    signalValues: {},
    eventQueue: [],
    statisticsCurrent: {},
    scriptStates: {},
  };
}

/** Fresh DB per test run — close the previous connection so delete never blocks. */
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

describe('DES experiment store — CRUD + model separation (9.3)', () => {
  let store: IndexedDBSnapshotStore;
  beforeEach(async () => { store = await freshStore(); });

  it('write/list/read/delete keeps the index consistent and models separated', async () => {
    await store.writeSnapshot('ModelA', 'Baseline', 0, 100, makeSnapshot(100), { replicationSeed: 1000 });
    await store.writeSnapshot('ModelA', 'Baseline', 0, 200, makeSnapshot(200));
    await store.writeSnapshot('ModelB', 'Baseline', 0, 100, makeSnapshot(100, 'modelB'));

    // Index: two distinct model/experiment pairs.
    const idx = await store.listIndex();
    expect(idx).toHaveLength(2);
    expect(idx).toContainEqual({ model: 'ModelA', experiment: 'Baseline' });
    expect(idx).toContainEqual({ model: 'ModelB', experiment: 'Baseline' });

    // Manifest: replication + time-sorted snapshot metas, no blob loads.
    const meta = await store.readManifest('ModelA', 'Baseline');
    expect(meta).not.toBeNull();
    expect(meta!.replications).toHaveLength(1);
    expect(meta!.replications[0].masterSeed).toBe(1000);
    expect(meta!.replications[0].snapshots.map((s) => s.simTime)).toEqual([100, 200]);

    // Lazy listing.
    const metas = await store.listSnapshots('ModelA', 'Baseline', 0);
    expect(metas.map((s) => s.simTime)).toEqual([100, 200]);

    // Model separation (F6): same experiment/repl/t on another model is distinct.
    const a = await store.readSnapshot('ModelA', 'Baseline', 0, 100);
    const b = await store.readSnapshot('ModelB', 'Baseline', 0, 100);
    expect(a!.components['Comp'].prop['payload']).toBe('x');
    expect(b!.components['Comp'].prop['payload']).toBe('modelB');

    // Delete one snapshot → blob gone + manifest updated.
    await store.deleteSnapshot('ModelA', 'Baseline', 0, 100);
    expect(await store.readSnapshot('ModelA', 'Baseline', 0, 100)).toBeNull();
    expect((await store.listSnapshots('ModelA', 'Baseline', 0)).map((s) => s.simTime)).toEqual([200]);
  });

  it('cascading deletes: replication and experiment remove all their records', async () => {
    await store.writeSnapshot('M', 'Exp', 0, 10, makeSnapshot(10));
    await store.writeSnapshot('M', 'Exp', 0, 20, makeSnapshot(20));
    await store.writeSnapshot('M', 'Exp', 1, 10, makeSnapshot(10));

    await store.deleteReplication('M', 'Exp', 0);
    expect(await store.readSnapshot('M', 'Exp', 0, 10)).toBeNull();
    expect(await store.readSnapshot('M', 'Exp', 0, 20)).toBeNull();
    expect(await store.readSnapshot('M', 'Exp', 1, 10)).not.toBeNull();
    const meta = await store.readManifest('M', 'Exp');
    expect(meta!.replications.map((r) => r.index)).toEqual([1]);

    await store.deleteExperiment('M', 'Exp');
    expect(await store.readManifest('M', 'Exp')).toBeNull();
    expect(await store.readSnapshot('M', 'Exp', 1, 10)).toBeNull();
    expect(await store.listIndex()).toHaveLength(0);
  });

  it('renameExperiment moves manifest + all blobs', async () => {
    await store.writeSnapshot('M', 'Old', 0, 10, makeSnapshot(10));
    await store.writeSnapshot('M', 'Old', 1, 20, makeSnapshot(20));
    await store.renameExperiment('M', 'Old', 'New');

    expect(await store.readManifest('M', 'Old')).toBeNull();
    const renamed = await store.readManifest('M', 'New');
    expect(renamed).not.toBeNull();
    expect(renamed!.experiment).toBe('New');
    expect(await store.readSnapshot('M', 'New', 0, 10)).not.toBeNull();
    expect(await store.readSnapshot('M', 'New', 1, 20)).not.toBeNull();
    expect(await store.readSnapshot('M', 'Old', 0, 10)).toBeNull();
  });
});

describe('DES experiment — seed derivation (9.4)', () => {
  it('replication r derives baseSeed + r*SEED_STRIDE (Unity parity)', () => {
    expect(SEED_STRIDE).toBe(1000);
    expect(replicationSeed(1000, 0)).toBe(1000);
    expect(replicationSeed(1000, 3)).toBe(4000);
  });

  it('same seed ⇒ identical RNG stream; different seeds ⇒ different streams', () => {
    const stream = (seed: number): number[] => {
      const rng = new SFC32(seed);
      return Array.from({ length: 16 }, () => rng.next());
    };
    expect(stream(replicationSeed(42, 1))).toEqual(stream(replicationSeed(42, 1)));
    expect(stream(replicationSeed(42, 1))).not.toEqual(stream(replicationSeed(42, 2)));
    // No collision between two experiments' derived seeds inside a stride.
    expect(replicationSeed(42, 0)).not.toBe(replicationSeed(43, 0));
  });
});

describe('DES experiment store — atomicity + concurrency (9.8)', () => {
  let store: IndexedDBSnapshotStore;
  beforeEach(async () => { store = await freshStore(); });

  it('two parallel saves lose no snapshot (manifest RMW inside one txn)', async () => {
    await Promise.all([
      store.writeSnapshot('M', 'Par', 0, 10, makeSnapshot(10)),
      store.writeSnapshot('M', 'Par', 0, 20, makeSnapshot(20)),
      store.writeSnapshot('M', 'Par', 1, 10, makeSnapshot(10)),
    ]);
    const meta = await store.readManifest('M', 'Par');
    const all = meta!.replications.flatMap((r) => r.snapshots.map((s) => `${r.index}:${s.simTime}`)).sort();
    expect(all).toEqual(['0:10', '0:20', '1:10']);
  });

  it('optimistic locking: a stale manifest write throws ManifestVersionConflictError', async () => {
    await store.writeSnapshot('M', 'Lock', 0, 10, makeSnapshot(10));
    const stale = await store.readManifest('M', 'Lock');
    // A concurrent writer bumps the version…
    await store.writeSnapshot('M', 'Lock', 0, 20, makeSnapshot(20));
    // …so the stale write must be rejected (retry-with-re-read contract).
    await expect(store.writeManifest(stale!)).rejects.toThrow(ManifestVersionConflictError);
    // Fresh read-modify-write succeeds.
    const fresh = await store.readManifest('M', 'Lock');
    fresh!.note = 'updated';
    await expect(store.writeManifest(fresh!)).resolves.toBeUndefined();
    expect((await store.readManifest('M', 'Lock'))!.note).toBe('updated');
  });

  it('write order is blob-before-manifest: every manifest entry has a readable blob', async () => {
    const meta0 = createExperimentMeta({ model: 'M', experiment: 'Order', baseSeed: 42 });
    await store.writeManifest(meta0);   // manifest without snapshots is fine
    await store.writeSnapshot('M', 'Order', 0, 10, makeSnapshot(10));
    const meta = await store.readManifest('M', 'Order');
    for (const r of meta!.replications) {
      for (const s of r.snapshots) {
        expect(await store.readSnapshot('M', 'Order', r.index, s.simTime)).not.toBeNull();
      }
    }
  });
});
