// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-513 §9.2 — the last-mode store against a REAL IndexedDB: record and
 * read, a project-wide forget that respects the backend, the cross-instance
 * subscription, the one-time copy of the recents ring's modes, and failure as
 * "unknown" instead of an exception.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import {
  DOCUMENT_MODES_DB_NAME,
  __closeDocumentModesDb,
  __setDocumentModesDbFactory,
  createDocumentModeStore,
  forgetDocumentModesOfProject,
  loadDocumentModes,
  readDocumentMode,
  recordDocumentMode,
  setDocumentMode,
  subscribeDocumentModes,
} from '../src/core/project/rv-document-mode-store';
import {
  LS_KEY_RECENT_DOCUMENTS,
  __resetRecentsSnapshot,
  recordRecentForOpen,
  withOpenIntentMode,
} from '../src/core/project/rv-project-recents-store';

function dropDb(): Promise<void> {
  return new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase(DOCUMENT_MODES_DB_NAME);
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  });
}

beforeEach(async () => {
  __closeDocumentModesDb();
  await dropDb();
  localStorage.removeItem(LS_KEY_RECENT_DOCUMENTS);
  __resetRecentsSnapshot();
});

afterEach(async () => {
  __setDocumentModesDbFactory(null);
  __closeDocumentModesDb();
  await dropDb();
  localStorage.removeItem(LS_KEY_RECENT_DOCUMENTS);
  __resetRecentsSnapshot();
  vi.restoreAllMocks();
});

const facts = (over: Partial<Parameters<typeof recordDocumentMode>[0]> = {}) => ({
  projectId: 'prj_a', backend: 'folder' as const, documentId: 'd1',
  activeMode: 'hmi', lockedMode: null, isDemo: false, ...over,
});

describe('record and read', () => {
  it('records the live mode and reads it back', async () => {
    await recordDocumentMode(facts());
    expect(await readDocumentMode('folder', 'prj_a', 'd1')).toBe('hmi');
  });

  it('the open-intent mode wins over the live mode', async () => {
    await withOpenIntentMode('editor', async () => {
      await recordDocumentMode(facts({ activeMode: 'viewer' }));
    });
    expect(await readDocumentMode('folder', 'prj_a', 'd1')).toBe('editor');
  });

  it('loadDocumentModes returns every entry, keyed by the document key', async () => {
    await recordDocumentMode(facts());
    await setDocumentMode('bundled', 'prj_a', 'd2', 'planner');
    const all = await loadDocumentModes();
    expect([...all.keys()].sort()).toEqual(['bundled:prj_a:d2', 'folder:prj_a:d1']);
    expect(all.get('bundled:prj_a:d2')).toMatchObject({ mode: 'planner' });
    expect(typeof all.get('folder:prj_a:d1')?.usedAt).toBe('string');
  });

  it('absent is null', async () => {
    expect(await readDocumentMode('folder', 'nope', 'nope')).toBeNull();
  });

  it('a kiosk records nothing; missing ids and no mode record nothing', async () => {
    await recordDocumentMode(facts({ lockedMode: 'hmi' }));
    await recordDocumentMode(facts({ projectId: null }));
    await recordDocumentMode(facts({ activeMode: null }));
    expect((await loadDocumentModes()).size).toBe(0);
  });

  it('a demo records nothing and loses what the project had', async () => {
    await setDocumentMode('bundled', 'prj_demo', 'd1', 'editor');
    await setDocumentMode('bundled', 'prj_demo', 'd2', 'planner');
    await recordDocumentMode(facts({ backend: 'bundled', projectId: 'prj_demo', isDemo: true }));
    expect((await loadDocumentModes()).size).toBe(0);
  });
});

describe('forgetDocumentModesOfProject', () => {
  it('drops folder:<id>:… and leaves bundled:<id>:… and other projects alone', async () => {
    await setDocumentMode('folder', 'prj_a', 'd1', 'hmi');
    await setDocumentMode('folder', 'prj_a', 'd2', 'editor');
    await setDocumentMode('bundled', 'prj_a', 'd1', 'planner');
    await setDocumentMode('folder', 'prj_ab', 'd1', 'des');

    await forgetDocumentModesOfProject('folder', 'prj_a');

    expect([...(await loadDocumentModes()).keys()].sort())
      .toEqual(['bundled:prj_a:d1', 'folder:prj_ab:d1']);
  });
});

describe('subscription', () => {
  it('a change made through a SECOND store instance reaches the listener', async () => {
    // Open the default instance first, so its channel exists before the post.
    await loadDocumentModes();
    const listener = vi.fn();
    const off = subscribeDocumentModes(listener);
    const other = createDocumentModeStore();
    try {
      await other.setDocumentMode('folder', 'prj_a', 'd1', 'editor');
      await vi.waitFor(() => expect(listener).toHaveBeenCalled());
      expect(await readDocumentMode('folder', 'prj_a', 'd1')).toBe('editor');
    } finally {
      off();
      other.close();
    }
  });
});

describe('the one-time copy from the recents ring', () => {
  function ring(projectId: string, documentId: string, mode: string | null) {
    recordRecentForOpen({
      projectId, backend: 'folder', documentId, documentName: documentId,
      documentPath: `${documentId}.glb`, projectName: projectId, activeMode: mode,
    });
  }

  it('copies entries with a mode, never the demo project, and only once', async () => {
    ring('prj_a', 'd1', 'editor');
    ring('prj_sample', 'd9', 'planner');     // DEMO_PROJECT_ID
    ring('prj_a', 'd2', null);               // no mode: nothing to copy

    const all = await loadDocumentModes();
    expect([...all.keys()]).toEqual(['folder:prj_a:d1']);
    expect(all.get('folder:prj_a:d1')?.mode).toBe('editor');

    // A second load — also after a reconnect — copies nothing again, even
    // when the ring holds new modes since.
    ring('prj_b', 'd3', 'des');
    __closeDocumentModesDb();
    expect([...(await loadDocumentModes()).keys()]).toEqual(['folder:prj_a:d1']);
  });

  it('after the first open the ring is never a source again', async () => {
    // The store is opened (and marked as seeded, from an empty ring) by this write …
    await setDocumentMode('folder', 'prj_a', 'd1', 'planner');
    ring('prj_a', 'd1', 'editor');
    __closeDocumentModesDb();
    // … so a later ring mode never lands over the store's own entry.
    expect(await readDocumentMode('folder', 'prj_a', 'd1')).toBe('planner');
  });
});

describe('failure is "unknown", never an exception', () => {
  it('a database that cannot be opened reads null and loads an empty map', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    __setDocumentModesDbFactory(() => Promise.reject(new Error('blocked')));
    expect(await readDocumentMode('folder', 'prj_a', 'd1')).toBeNull();
    expect((await loadDocumentModes()).size).toBe(0);
    await expect(recordDocumentMode(facts())).resolves.toBeUndefined();
    await expect(forgetDocumentModesOfProject('folder', 'prj_a')).resolves.toBeUndefined();
  });
});
