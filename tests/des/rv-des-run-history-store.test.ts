// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-260 tests §9.2 — run archiving in the unified plan-261 store:
 *  - recordRun: seed → replication mapping (new seed = next index, same seed
 *    = same replication / result overwrite)
 *  - retention: oldest archived runs pruned beyond maxRuns (incl. blobs);
 *    plain snapshot replications are never pruned
 *  - patchManifestMeta: create + patch projectId / glbHash (F5/F6)
 *  - F4 session persistence: a NEW store instance (DB reopen as reload proxy)
 *    reads the archived runs back
 *  - public parse projection: parseExperimentInfo reads runs + checkpoints
 */

import { describe, it, expect } from 'vitest';
import { IndexedDBSnapshotStore } from '@rv-private/plugins/des/rv-des-experiment-store';
import type { RunResult } from '@rv-private/plugins/des/rv-des-experiment-model';
import type { DESSnapshot } from '@rv-private/plugins/des/rv-des-snapshot';
import { parseExperimentInfo } from '../../src/core/material-flow/rv-run-history-store';

function makeRun(runId: string, over: Partial<RunResult> = {}): RunResult {
  return {
    runId,
    status: 'completed',
    startedAt: 1000,
    endedAt: 2000,
    simTimeReached: 3600,
    reason: 'duration-reached',
    stats: { simTime: 3600, components: [], bottleneck: null, meanUtilization: 42, throughputPerHour: 120 },
    ...over,
  };
}

function makeSnapshot(simTime: number): DESSnapshot {
  return {
    version: 2, simTime, masterSeed: 42, nextEventId: 0,
    rngStates: { __manager__: [1, 2, 3, 4] },
    components: {}, mus: [], drives: {}, signalValues: {}, eventQueue: [],
    statisticsCurrent: {}, scriptStates: {},
  } as unknown as DESSnapshot;
}

/** Fresh DB per test — close previous connection so delete never blocks. */
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

describe('experiment store — recordRun (plan-260)', () => {
  it('maps a new seed to the next replication index; same seed overwrites', async () => {
    const store = await freshStore();
    const i0 = await store.recordRun('M', 'E', 42, makeRun('r1'));
    const i1 = await store.recordRun('M', 'E', 43, makeRun('r2'));
    expect(i0).toBe(0);
    expect(i1).toBe(1);

    // Same seed again → same replication, result overwritten.
    const i2 = await store.recordRun('M', 'E', 42, makeRun('r3', { status: 'aborted', reason: 'reset' }));
    expect(i2).toBe(0);
    const meta = await store.readManifest('M', 'E');
    expect(meta?.replications).toHaveLength(2);
    const repl0 = meta?.replications.find((r) => r.index === 0);
    expect(repl0?.runId).toBe('r3');
    expect(repl0?.status).toBe('aborted');
    expect(repl0?.masterSeed).toBe(42);
  });

  it('enforces retention: oldest archived runs pruned beyond maxRuns (incl. blobs)', async () => {
    const store = await freshStore();
    for (let i = 0; i < 5; i++) {
      const seed = 100 + i;
      // A checkpoint blob per run (proves the prune cascades to blobs).
      await store.writeSnapshot('M', 'E', i, 10, makeSnapshot(10), { replicationSeed: seed });
      await store.recordRun('M', 'E', seed, makeRun(`r${i}`, { endedAt: 1000 + i }), { maxRuns: 3 });
    }
    const meta = await store.readManifest('M', 'E');
    const archived = meta!.replications.filter((r) => r.status !== undefined);
    expect(archived).toHaveLength(3);
    // The two OLDEST (endedAt 1000, 1001) are gone.
    expect(archived.map((r) => r.runId).sort()).toEqual(['r2', 'r3', 'r4']);
    // Their blobs are gone too; surviving replication blobs remain.
    expect(await store.readSnapshot('M', 'E', 0, 10)).toBeNull();
    expect(await store.readSnapshot('M', 'E', 1, 10)).toBeNull();
    expect(await store.readSnapshot('M', 'E', 4, 10)).not.toBeNull();
  });

  it('patchManifestMeta creates a manifest and tags projectId/glbHash (F5/F6)', async () => {
    const store = await freshStore();
    await store.patchManifestMeta('M', 'E', { projectId: 'p1', glbHash: 'h1', baseSeed: 7 });
    let meta = await store.readManifest('M', 'E');
    expect(meta?.projectId).toBe('p1');
    expect(meta?.glbHash).toBe('h1');
    expect(meta?.baseSeed).toBe(7);

    // Patch on an existing manifest only overwrites the given fields.
    await store.patchManifestMeta('M', 'E', { glbHash: 'h2' });
    meta = await store.readManifest('M', 'E');
    expect(meta?.projectId).toBe('p1');
    expect(meta?.glbHash).toBe('h2');
    expect(meta?.baseSeed).toBe(7);
  });

  it('F4: a fresh store instance (DB reopen) reads archived runs back', async () => {
    const store = await freshStore();
    await store.recordRun('M', 'E', 42, makeRun('persisted'));
    await store.close();

    const reopened = new IndexedDBSnapshotStore();
    _lastStore = reopened;
    const meta = await reopened.readManifest('M', 'E');
    expect(meta?.replications[0]?.runId).toBe('persisted');
    expect(meta?.replications[0]?.simTimeReached).toBe(3600);
  });

  it('parseExperimentInfo projects runs + checkpoints for the public UI', async () => {
    const store = await freshStore();
    await store.patchManifestMeta('M', 'E', { projectId: 'p1', glbHash: 'h1' });
    await store.writeSnapshot('M', 'E', 0, 60, makeSnapshot(60), { label: 'auto', replicationSeed: 42 });
    await store.recordRun('M', 'E', 42, makeRun('r1'));
    const meta = await store.readManifest('M', 'E');

    const info = parseExperimentInfo(JSON.stringify(meta));
    expect(info).not.toBeNull();
    expect(info!.projectId).toBe('p1');
    expect(info!.glbHash).toBe('h1');
    expect(info!.runs).toHaveLength(1);
    expect(info!.runs[0].seed).toBe(42);
    expect(info!.runs[0].status).toBe('completed');
    expect(info!.runs[0].simTimeReached).toBe(3600);
    expect(info!.runs[0].checkpoints).toEqual([
      expect.objectContaining({ simTime: 60, label: 'auto' }),
    ]);
    expect(info!.runs[0].stats?.meanUtilization).toBe(42);
  });

  it('parseExperimentInfo returns null on malformed input', () => {
    expect(parseExperimentInfo('not json')).toBeNull();
    expect(parseExperimentInfo('42')).toBeNull();
    expect(parseExperimentInfo('{"model":"M"}')).toBeNull();
  });
});
