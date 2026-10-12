// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-509 §9.2 — the model index against a REAL IndexedDB (browser config):
 * round trip, the two forgets, the backend/id pair, overlapping mutations in
 * one transaction each, and "an IDB failure is no index, not an exception".
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  MODEL_INDEX_DB_NAME,
  __closeModelIndexDb, __setModelIndexDbFactory,
  forgetModelIndexEntry, forgetModelIndexOfProject, loadModelIndex, putSnapshot,
  readSnapshot, subscribeModelIndex,
} from '../src/core/project/rv-model-index-store';
import { idbUpdate, openIdb } from '../src/core/persistence/rv-idb-utils';
import {
  MODEL_INDEX_SCHEMA_VERSION, type ModelIndexBackend, type ModelIndexSnapshot,
} from '../src/core/project/rv-model-index';

function snap(projectId: string, backend: ModelIndexBackend, docIds: string[]): ModelIndexSnapshot {
  return {
    version: MODEL_INDEX_SCHEMA_VERSION, projectId, projectName: projectId, backend,
    updatedAt: '2026-09-27T00:00:00.000Z',
    docs: docIds.map(id => ({ id, name: id.toUpperCase(), path: `models/${id}.glb`, tags: [] })),
  };
}

async function deleteDb(): Promise<void> {
  __closeModelIndexDb();
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase(MODEL_INDEX_DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
}

beforeEach(async () => {
  __setModelIndexDbFactory(null);
  await deleteDb();
});
afterEach(async () => {
  __setModelIndexDbFactory(null);
  await deleteDb();
});

describe('rv-model-index-store', () => {
  it('putSnapshot + loadModelIndex round-trip', async () => {
    const s = snap('prj_a', 'folder', ['a', 'b']);
    expect(await putSnapshot(s)).toBe(true);
    const loaded = await loadModelIndex();
    expect(loaded.ok).toBe(true);
    expect(loaded.snapshots).toEqual([s]);
    expect(await readSnapshot('folder', 'prj_a')).toEqual(s);
  });

  it('forgetModelIndexEntry removes exactly one document', async () => {
    await putSnapshot(snap('prj_a', 'folder', ['a', 'b', 'c']));
    await forgetModelIndexEntry('folder', 'prj_a', 'b');
    expect((await readSnapshot('folder', 'prj_a'))?.docs.map(d => d.id)).toEqual(['a', 'c']);
  });

  it('forgetModelIndexOfProject removes the whole snapshot', async () => {
    await putSnapshot(snap('prj_a', 'folder', ['a']));
    await putSnapshot(snap('prj_b', 'folder', ['b']));
    await forgetModelIndexOfProject('folder', 'prj_a');
    const { snapshots } = await loadModelIndex();
    expect(snapshots.map(s => s.projectId)).toEqual(['prj_b']);
  });

  it('bundled and folder snapshots of one id live side by side; unlinking the folder keeps the bundled one', async () => {
    await putSnapshot(snap('prj_sample', 'bundled', ['demo']));
    await putSnapshot(snap('prj_sample', 'folder', ['mine']));
    expect((await loadModelIndex()).snapshots).toHaveLength(2);
    await forgetModelIndexOfProject('folder', 'prj_sample');
    const { snapshots } = await loadModelIndex();
    expect(snapshots.map(s => `${s.backend}:${s.projectId}`)).toEqual(['bundled:prj_sample']);
  });

  it('two overlapping entry removals lose neither change', async () => {
    await putSnapshot(snap('prj_a', 'folder', ['a', 'b', 'c']));
    // No await in between: both read-modify-writes are in flight at once.
    await Promise.all([
      forgetModelIndexEntry('folder', 'prj_a', 'a'),
      forgetModelIndexEntry('folder', 'prj_a', 'b'),
    ]);
    expect((await readSnapshot('folder', 'prj_a'))?.docs.map(d => d.id)).toEqual(['c']);
  });

  it('idbUpdate serialises overlapping updates on a second connection too (another tab)', async () => {
    await putSnapshot(snap('prj_a', 'folder', ['a', 'b', 'c']));
    const other = await openIdb(MODEL_INDEX_DB_NAME, 1, ['snapshots']);
    try {
      await Promise.all([
        forgetModelIndexEntry('folder', 'prj_a', 'a'),
        idbUpdate<ModelIndexSnapshot>(other, 'snapshots', 'folder:prj_a',
          cur => cur && { ...cur, docs: cur.docs.filter(d => d.id !== 'c') }),
      ]);
    } finally {
      other.close();
    }
    expect((await readSnapshot('folder', 'prj_a'))?.docs.map(d => d.id)).toEqual(['b']);
  });

  it('an IndexedDB failure is { ok: false, snapshots: [] }, never a throw', async () => {
    __setModelIndexDbFactory(() => Promise.reject(new DOMException('blocked', 'SecurityError')));
    await expect(loadModelIndex()).resolves.toEqual({ ok: false, snapshots: [] });
    await expect(putSnapshot(snap('prj_a', 'folder', ['a']))).resolves.toBe(false);
    await expect(forgetModelIndexOfProject('folder', 'prj_a')).resolves.toBeUndefined();
    await expect(forgetModelIndexEntry('folder', 'prj_a', 'a')).resolves.toBeUndefined();
    await expect(readSnapshot('folder', 'prj_a')).resolves.toBeNull();
  });

  it('a stored snapshot of another schema version is skipped, not an error', async () => {
    await putSnapshot(snap('prj_a', 'folder', ['a']));
    const db = await openIdb(MODEL_INDEX_DB_NAME, 1, ['snapshots']);
    try {
      await idbUpdate(db, 'snapshots', 'folder:prj_old', () => ({ version: 99, projectId: 'prj_old' }));
    } finally {
      db.close();
    }
    const loaded = await loadModelIndex();
    expect(loaded.ok).toBe(true);
    expect(loaded.snapshots.map(s => s.projectId)).toEqual(['prj_a']);
  });

  it('notifies subscribers on every change', async () => {
    let calls = 0;
    const off = subscribeModelIndex(() => { calls++; });
    try {
      await putSnapshot(snap('prj_a', 'folder', ['a']));
      await forgetModelIndexEntry('folder', 'prj_a', 'a');
      await forgetModelIndexOfProject('folder', 'prj_a');
    } finally {
      off();
    }
    expect(calls).toBe(3);
  });
});
