// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-509 §9.4 — the model-index writer: what triggers a write, what never
 * does, the bundled manifest path, and the two guards that keep a deleted
 * snapshot deleted (the cancelled timer and the linked check at commit).
 *
 * Runs against the real IndexedDB store; only the project store is a fake.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  MODEL_INDEX_WRITE_DEBOUNCE_MS, __resetModelIndexWriter, indexBundledProject, startModelIndexWriter,
  type ModelIndexSource,
} from '../src/core/project/rv-model-index-writer';
import {
  MODEL_INDEX_DB_NAME, __closeModelIndexDb, forgetModelIndexOfProject, loadModelIndex, putSnapshot,
  readSnapshot,
} from '../src/core/project/rv-model-index-store';
import type { RvDocumentEntry, RvProject } from '../src/core/project/rv-project-types';
import type { ModelIndexSnapshot } from '../src/core/project/rv-model-index';

type Snap = ReturnType<ModelIndexSource['getSnapshot']>;

/** A ProjectStore stand-in: `publish` is `_publish()`. */
function fakeStore(initial: Snap) {
  let snap = initial;
  const listeners = new Set<() => void>();
  return {
    subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l); }; },
    getSnapshot: () => snap,
    publish(next: Partial<Snap> = {}) {
      snap = { ...snap, ...next };
      for (const l of [...listeners]) l();
    },
  };
}

function docs(...ids: string[]): RvDocumentEntry[] {
  return ids.map(id => ({ id, name: id, path: `models/${id}.glb` }) as RvDocumentEntry);
}

async function deleteDb(): Promise<void> {
  __closeModelIndexDb();
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase(MODEL_INDEX_DB_NAME);
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  });
}

let stop: (() => void) | null = null;

beforeEach(async () => {
  __resetModelIndexWriter();
  await deleteDb();
});
afterEach(async () => {
  stop?.();
  stop = null;
  vi.useRealTimers();
  __resetModelIndexWriter();
  await deleteDb();
});

/** Real put, observable: resolves once the write has landed. */
function trackedPut() {
  const writes: Promise<boolean>[] = [];
  const put = vi.fn((s: ModelIndexSnapshot) => {
    const p = putSnapshot(s);
    writes.push(p);
    return p;
  });
  return { put, settled: () => Promise.all(writes) };
}

describe('startModelIndexWriter', () => {
  it('writes a snapshot after a publish with documents, and not again for the same signature', async () => {
    vi.useFakeTimers();
    const store = fakeStore({ project: { id: 'p1', name: 'P1' }, backendKind: 'folder', documents: docs('a', 'b') });
    const { put, settled } = trackedPut();
    stop = startModelIndexWriter(store, { put, isLinked: () => true });
    await vi.advanceTimersByTimeAsync(MODEL_INDEX_WRITE_DEBOUNCE_MS + 10);
    await settled();
    expect(put).toHaveBeenCalledTimes(1);
    expect((await readSnapshot('folder', 'p1'))?.docs.map(d => d.id)).toEqual(['a', 'b']);

    // A publish that changes nothing about the documents (a new array, same rows).
    store.publish({ documents: docs('b', 'a') });
    await vi.advanceTimersByTimeAsync(MODEL_INDEX_WRITE_DEBOUNCE_MS + 10);
    expect(put).toHaveBeenCalledTimes(1);

    // A real change is written — once, after the debounce.
    store.publish({ documents: docs('a', 'b', 'c') });
    store.publish({ documents: docs('a', 'b', 'c', 'd') });
    await vi.advanceTimersByTimeAsync(MODEL_INDEX_WRITE_DEBOUNCE_MS - 100);
    expect(put).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(200);
    await settled();
    expect(put).toHaveBeenCalledTimes(2);
    expect((await readSnapshot('folder', 'p1'))?.docs.map(d => d.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('a renamed project is a change', async () => {
    vi.useFakeTimers();
    const store = fakeStore({ project: { id: 'p1', name: 'Old' }, backendKind: 'folder', documents: docs('a') });
    const { put, settled } = trackedPut();
    stop = startModelIndexWriter(store, { put, isLinked: () => true });
    await vi.advanceTimersByTimeAsync(MODEL_INDEX_WRITE_DEBOUNCE_MS + 10);
    store.publish({ project: { id: 'p1', name: 'New' } });
    await vi.advanceTimersByTimeAsync(MODEL_INDEX_WRITE_DEBOUNCE_MS + 10);
    await settled();
    expect(put).toHaveBeenCalledTimes(2);
    expect((await readSnapshot('folder', 'p1'))?.projectName).toBe('New');
  });

  it('`project: null` writes nothing', async () => {
    vi.useFakeTimers();
    const store = fakeStore({ project: null, backendKind: null, documents: docs('a') });
    const put = vi.fn(async () => true);
    stop = startModelIndexWriter(store, { put, isLinked: () => true });
    store.publish();
    await vi.advanceTimersByTimeAsync(MODEL_INDEX_WRITE_DEBOUNCE_MS * 3);
    expect(put).not.toHaveBeenCalled();
  });

  it('never asks for a permission', async () => {
    vi.useFakeTimers();
    const requestPermission = vi.fn(async () => 'granted');
    const queryPermission = vi.fn(async () => 'granted');
    const proto = (globalThis as unknown as { FileSystemHandle?: { prototype: Record<string, unknown> } })
      .FileSystemHandle?.prototype;
    const saved = proto ? { r: proto.requestPermission, q: proto.queryPermission } : null;
    if (proto) { proto.requestPermission = requestPermission; proto.queryPermission = queryPermission; }
    const pickers = vi.fn();
    const savedPicker = (window as { showDirectoryPicker?: unknown }).showDirectoryPicker;
    (window as { showDirectoryPicker?: unknown }).showDirectoryPicker = pickers;
    try {
      const store = fakeStore({ project: { id: 'p1', name: 'P1' }, backendKind: 'folder', documents: docs('a') });
      const { put, settled } = trackedPut();
      stop = startModelIndexWriter(store, { put });   // the REAL linked check
      store.publish({ documents: docs('a', 'b') });
      await vi.advanceTimersByTimeAsync(MODEL_INDEX_WRITE_DEBOUNCE_MS + 10);
      await settled();
      await indexBundledProject({ readManifest: async () => null });
      expect(requestPermission).not.toHaveBeenCalled();
      expect(queryPermission).not.toHaveBeenCalled();
      expect(pickers).not.toHaveBeenCalled();
    } finally {
      if (proto && saved) { proto.requestPermission = saved.r; proto.queryPermission = saved.q; }
      (window as { showDirectoryPicker?: unknown }).showDirectoryPicker = savedPicker;
    }
  });

  it('a forget before the debounce ends cancels the pending write', async () => {
    vi.useFakeTimers();
    const store = fakeStore({ project: { id: 'p1', name: 'P1' }, backendKind: 'folder', documents: docs('a') });
    const { put } = trackedPut();
    stop = startModelIndexWriter(store, { put, isLinked: () => true });
    store.publish({ documents: docs('a', 'b') });
    await forgetModelIndexOfProject('folder', 'p1');
    await vi.runAllTimersAsync();
    expect(put).not.toHaveBeenCalled();
    expect((await loadModelIndex()).snapshots).toEqual([]);
  });

  it('after an unlink, a further publish of the still-open folder project writes nothing', async () => {
    vi.useFakeTimers();
    let linked = true;
    const store = fakeStore({ project: { id: 'p1', name: 'P1' }, backendKind: 'folder', documents: docs('a') });
    const { put, settled } = trackedPut();
    stop = startModelIndexWriter(store, { put, isLinked: () => linked });
    await vi.advanceTimersByTimeAsync(MODEL_INDEX_WRITE_DEBOUNCE_MS + 10);
    await settled();
    expect(put).toHaveBeenCalledTimes(1);

    linked = false;
    await forgetModelIndexOfProject('folder', 'p1');
    store.publish({ documents: docs('a', 'b') });
    store.publish();   // and the same list again
    await vi.runAllTimersAsync();
    expect(put).toHaveBeenCalledTimes(1);
    expect(await readSnapshot('folder', 'p1')).toBeNull();
  });

  it('a bundled project is not subject to the linked check', async () => {
    vi.useFakeTimers();
    const store = fakeStore({ project: { id: 'prj_sample', name: 'Demo' }, backendKind: 'bundled', documents: docs('a') });
    const { put, settled } = trackedPut();
    stop = startModelIndexWriter(store, { put, isLinked: () => false });
    await vi.advanceTimersByTimeAsync(MODEL_INDEX_WRITE_DEBOUNCE_MS + 10);
    await settled();
    expect((await readSnapshot('bundled', 'prj_sample'))?.source).toBe('open');
  });
});

describe('indexBundledProject', () => {
  const manifest = {
    schemaVersion: 1, id: 'prj_sample', name: 'DemoRealvirtual',
    documents: [{ id: 'd1', name: 'Conveyor_Line', path: 'models/lines/conveyor.glb' }],
  } as unknown as RvProject;

  it('writes `bundled:<id>` without the project ever being opened', async () => {
    await indexBundledProject({ readManifest: async () => manifest });
    const s = await readSnapshot('bundled', 'prj_sample');
    expect(s?.source).toBe('manifest');
    expect(s?.docs.map(d => d.name)).toEqual(['Conveyor_Line']);
  });

  it('a failing manifest read does not throw', async () => {
    await expect(indexBundledProject({ readManifest: async () => { throw new Error('offline'); } }))
      .resolves.toBeUndefined();
    await expect(indexBundledProject({ readManifest: async () => null })).resolves.toBeUndefined();
    expect((await loadModelIndex()).snapshots).toEqual([]);
  });

  it('never replaces a snapshot the live project wrote', async () => {
    await putSnapshot({
      version: 1, projectId: 'prj_sample', projectName: 'DemoRealvirtual', backend: 'bundled',
      updatedAt: '', source: 'open',
      docs: [{ id: 'user1', name: 'My saved line', path: 'user/line.glb', tags: [] }],
    });
    await indexBundledProject({ readManifest: async () => manifest });
    expect((await readSnapshot('bundled', 'prj_sample'))?.docs.map(d => d.id)).toEqual(['user1']);
  });
});
