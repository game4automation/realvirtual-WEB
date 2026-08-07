// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-265 Phase 2 primitive — patchManifestMeta persists the experiment-matrix
 * fields (replicationCount / paramOverrides / paramScript / enabled) through a
 * real IndexedDB roundtrip, so the matrix can save parameter overrides. Also
 * checks the manifest survives via the PUBLIC projection (parseExperimentInfo).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { IndexedDBSnapshotStore } from '@rv-private/plugins/des/rv-des-experiment-store';
import type { ParamOverride } from '@rv-private/plugins/des/rv-des-experiment-model';
import { parseExperimentInfo } from '../../src/core/material-flow/rv-run-history-store';

const OV: ParamOverride = { path: 'Src', component: 'DESSource', field: 'InterArrivalTime', value: 3.0 };

let _last: IndexedDBSnapshotStore | null = null;
async function freshStore(): Promise<IndexedDBSnapshotStore> {
  await _last?.close();
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase('rv-des-experiments');
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
  _last = new IndexedDBSnapshotStore();
  return _last;
}

describe('DES experiment matrix — manifest persistence (plan-265)', () => {
  let store: IndexedDBSnapshotStore;
  beforeEach(async () => { store = await freshStore(); });

  it('patchManifestMeta persists replicationCount / paramOverrides / paramScript / enabled', async () => {
    await store.patchManifestMeta('M', 'E', {
      baseSeed: 42, replicationCount: 10, paramOverrides: [OV],
      paramScript: "self.setField('Src','DESSource','InterArrivalTime',3)", enabled: false,
    });
    const meta = await store.readManifest('M', 'E');
    expect(meta).not.toBeNull();
    expect(meta!.replicationCount).toBe(10);
    expect(meta!.paramOverrides).toEqual([OV]);
    expect(meta!.paramScript).toContain('setField');
    expect(meta!.enabled).toBe(false);
  });

  it('a later patch updates only the given fields (merge, not replace)', async () => {
    await store.patchManifestMeta('M', 'E', { replicationCount: 5, paramOverrides: [OV] });
    await store.patchManifestMeta('M', 'E', { enabled: false }); // does not clear overrides
    const meta = await store.readManifest('M', 'E');
    expect(meta!.replicationCount).toBe(5);
    expect(meta!.paramOverrides).toEqual([OV]);
    expect(meta!.enabled).toBe(false);
  });

  it('persisted fields survive the PUBLIC projection (parseExperimentInfo)', async () => {
    await store.patchManifestMeta('M', 'E', { replicationCount: 7, paramOverrides: [OV], enabled: true });
    const meta = await store.readManifest('M', 'E');
    const info = parseExperimentInfo(JSON.stringify(meta));
    expect(info).not.toBeNull();
    expect(info!.replicationCount).toBe(7);
    expect(info!.paramOverrides).toEqual([OV]);
    expect(info!.enabled).toBe(true);
  });

  it('clamps a non-positive replicationCount to 1', async () => {
    await store.patchManifestMeta('M', 'E', { replicationCount: 0 });
    const meta = await store.readManifest('M', 'E');
    expect(meta!.replicationCount).toBe(1);
  });
});
