// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-261 test §9.5 — NDJSON.gz export/import round-trip (F7), including the
 * CompressionStream existence proof the review demanded (gzip in the vitest
 * browser environment), an EMPTY experiment and a multi-snapshot experiment.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { IndexedDBSnapshotStore } from '@rv-private/plugins/des/rv-des-experiment-store';
import { createExperimentMeta } from '@rv-private/plugins/des/rv-des-experiment-model';
import type { DESSnapshot } from '@rv-private/plugins/des/rv-des-snapshot';
import { hasCompressionStream, gzipString, gunzipToString } from '../../src/core/persistence/rv-gzip-utils';

function makeSnapshot(simTime: number, marker: string): DESSnapshot {
  return {
    version: 2, simTime, masterSeed: 42, nextEventId: 0,
    rngStates: { __manager__: [simTime, 1, 2, 3] },
    components: { Comp: {
      path: 'Comp', type: 'DESStation', state: 1, currentLoad: 1, totalProcessed: simTime,
      isBlocked: false, isWorking: true, isFailure: false, exitBlocked: false,
      muIds: [], prop: { marker }, stateTimings: { Working: { duration: simTime, entries: 1 } },
      currentStateName: 'Working', statBaselineTime: 0, processedBaseline: 0,
    } },
    mus: [], drives: {}, signalValues: { 'Sig.A': true }, eventQueue: [],
    statisticsCurrent: {}, scriptStates: { 'Cell/S': { rng: simTime, state: { n: simTime } } },
  };
}

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

describe('gzip utils — CompressionStream existence proof', () => {
  it('CompressionStream is available and round-trips a string', async () => {
    expect(hasCompressionStream()).toBe(true);
    const input = 'plan-261 gzip round-trip ✓ '.repeat(1000);
    const packed = await gzipString(input);
    expect(packed.byteLength).toBeLessThan(input.length);
    expect(await gunzipToString(packed)).toBe(input);
  });
});

describe('DES experiment — NDJSON.gz export/import round-trip (9.5)', () => {
  let store: IndexedDBSnapshotStore;
  beforeEach(async () => { store = await freshStore(); });

  it('multi-snapshot experiment exports and re-imports byte-faithfully', async () => {
    await store.writeSnapshot('M', 'Round', 0, 100, makeSnapshot(100, 'a'), { replicationSeed: 42, label: 'first' });
    await store.writeSnapshot('M', 'Round', 0, 200, makeSnapshot(200, 'b'));
    await store.writeSnapshot('M', 'Round', 1, 100, makeSnapshot(100, 'c'), { replicationSeed: 1042 });

    const blob = await store.exportExperiment('M', 'Round');
    expect(blob.size).toBeGreaterThan(0);

    // Import collides with the existing name → renamed copy.
    const { model, exp } = await store.importExperiment(blob);
    expect(model).toBe('M');
    expect(exp).not.toBe('Round');

    const orig = await store.readManifest('M', 'Round');
    const copy = await store.readManifest('M', exp);
    expect(copy!.replications.map((r) => r.index)).toEqual(orig!.replications.map((r) => r.index));
    expect(copy!.baseSeed).toBe(orig!.baseSeed);

    // Every snapshot round-trips content-identically.
    for (const r of orig!.replications) {
      for (const s of r.snapshots) {
        const a = await store.readSnapshot('M', 'Round', r.index, s.simTime);
        const b = await store.readSnapshot('M', exp, r.index, s.simTime);
        expect(b).toEqual(a);
      }
    }
  });

  it('empty experiment (manifest only) round-trips', async () => {
    await store.writeManifest(createExperimentMeta({ model: 'M', experiment: 'Empty', baseSeed: 7 }));
    const blob = await store.exportExperiment('M', 'Empty');
    const { exp } = await store.importExperiment(blob);
    const copy = await store.readManifest('M', exp);
    expect(copy).not.toBeNull();
    expect(copy!.baseSeed).toBe(7);
    expect(copy!.replications).toEqual([]);
  });

  it('import into a store WITHOUT the experiment keeps the original name', async () => {
    await store.writeSnapshot('M', 'Solo', 0, 10, makeSnapshot(10, 's'));
    const blob = await store.exportExperiment('M', 'Solo');
    await store.deleteExperiment('M', 'Solo');
    const { exp } = await store.importExperiment(blob);
    expect(exp).toBe('Solo');
    expect(await store.readSnapshot('M', 'Solo', 0, 10)).not.toBeNull();
  });

  it('rejects a non-experiment file', async () => {
    await expect(store.importExperiment(new Blob(['{"nope":true}'])))
      .rejects.toThrow(/not a rv-des-experiment/);
  });
});
