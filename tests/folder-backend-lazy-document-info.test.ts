// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-506 §9.4 — one header slice, two keys, the file wins (F3, F15).
 *
 * Template: `folder-backend-lazy-classification.test.ts`. Opening a folder
 * project reads each changed GLB's JSON chunk exactly once and takes BOTH
 * cached blocks — Classification and DocumentInfo — out of it. Asserted on the
 * real `store.getSnapshot()`, not on the reconcile result: the R2-3 finding was
 * that a correct scan result could still be invisible, because the tiers merge
 * (`_liveUserDocuments`) and the snapshot equality (`sameDocuments`) looked at
 * `classification` only.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FakeDir, asDirHandle } from './helpers/fake-fs-handles';
import { glbWithSceneExtras, seedBlob } from './helpers/glb-scene-extras';
import { FolderBackend } from '../src/core/project/backends/folder-backend';
import { ProjectStore, resetProjectStore } from '../src/core/project/project-store';
import { sceneExtrasOfGlbBlob } from '../src/core/project/rv-project-documents';
import type { DocumentInfo } from '../src/core/project/rv-document-info';

const T1 = '2026-09-01T10:00:00.000Z';
const T2 = '2026-09-26T10:00:00.000Z';
const MTIME = 1_700_000_000_000;

const FROM_FILE: DocumentInfo = { v: 1, summary: 'from the file', description: 'Body', updatedAt: T2 };
const STALE: DocumentInfo = { v: 1, summary: 'stale manifest text', updatedAt: T1 };
const SAME_TEXT_OLD_STAMP: DocumentInfo = { v: 1, summary: 'same words', updatedAt: T1 };
const SAME_TEXT_NEW_STAMP: DocumentInfo = { v: 1, summary: 'same words', updatedAt: T2 };
const CACHED: DocumentInfo = { v: 1, summary: 'cached, trusted by the marker', updatedAt: T1 };

async function seedProject(): Promise<{ root: FakeDir; dSize: number }> {
  const root = new FakeDir('info-project');
  const models = root.seedDir('models');
  await seedBlob(models, 'a.glb', glbWithSceneExtras({
    Classification: { v: 1, level: 'plant' }, DocumentInfo: FROM_FILE }));
  await seedBlob(models, 'b.glb', glbWithSceneExtras({ Classification: { v: 1, level: 'part' } }));
  await seedBlob(models, 'c.glb', glbWithSceneExtras({ DocumentInfo: SAME_TEXT_NEW_STAMP }));
  const d = glbWithSceneExtras({ DocumentInfo: FROM_FILE }, 4096, MTIME);
  await seedBlob(models, 'd.glb', d);
  root.seedText('project.json', JSON.stringify({
    schemaVersion: 3, id: 'prj_info', name: 'Info',
    documents: [
      { id: 'doc-a', path: 'models/a.glb', name: 'a', documentInfo: STALE },
      { id: 'doc-b', path: 'models/b.glb', name: 'b', documentInfo: STALE },
      { id: 'doc-c', path: 'models/c.glb', name: 'c', documentInfo: SAME_TEXT_OLD_STAMP },
      {
        id: 'doc-d', path: 'models/d.glb', name: 'd', documentInfo: CACHED,
        sizeBytes: d.size, mtimeMs: MTIME, extrasScan: 2,
      },
    ],
  }));
  return { root, dSize: d.size };
}

describe('sceneExtrasOfGlbBlob', () => {
  it('reads both keys out of one header', async () => {
    const extras = await sceneExtrasOfGlbBlob(glbWithSceneExtras({
      Classification: { v: 1, level: 'plant' }, DocumentInfo: FROM_FILE }));
    expect(extras).toEqual({ classification: { v: 1, level: 'plant' }, documentInfo: FROM_FILE });
  });

  it('answers null for something that is not a GLB', async () => {
    expect(await sceneExtrasOfGlbBlob(new Blob(['not a glb at all, just text']))).toBeNull();
  });
});

describe('plan-506 §9.4 — opening a folder project', () => {
  let store: ProjectStore;

  beforeEach(() => {
    localStorage.removeItem('rv-project/last');
    resetProjectStore();
    store = new ProjectStore();
  });

  afterEach(async () => {
    await store.closeProject();
    vi.restoreAllMocks();
  });

  it('reads each changed document once, and the snapshot shows what the FILE says', async () => {
    const { root } = await seedProject();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const blobReads = vi.spyOn(FolderBackend.prototype, 'readDocumentBlob');

    expect(await store.openProjectFolder(asDirHandle(root))).toBe(true);
    const byPath = new Map(store.getSnapshot().documents.map(d => [d.path, d]));

    // One lazy header read per changed document, BOTH keys from it — and none
    // for the row whose stats still match under the scan marker.
    const readPaths = blobReads.mock.calls.map(c => c[0]);
    expect(readPaths.filter(p => p === 'models/a.glb')).toHaveLength(1);
    expect(readPaths.filter(p => p === 'models/b.glb')).toHaveLength(1);
    expect(readPaths.filter(p => p === 'models/c.glb')).toHaveLength(1);
    expect(readPaths).not.toContain('models/d.glb');
    expect(fetchSpy.mock.calls.filter(call => String(call[0]).startsWith('blob:'))).toEqual([]);

    // a — the manifest's old text is REPLACED by the file's, classification too.
    expect(byPath.get('models/a.glb')?.documentInfo).toEqual(FROM_FILE);
    expect(byPath.get('models/a.glb')?.classification).toEqual({ v: 1, level: 'plant' });
    // b — the file carries no block: removal wins over the manifest (F15).
    expect(byPath.get('models/b.glb')?.documentInfo).toBeUndefined();
    // c — same words, newer stamp: the snapshot carries the new stamp.
    expect(byPath.get('models/c.glb')?.documentInfo?.updatedAt).toBe(T2);
    // d — pre-filter cleared under the marker: the cache stands, unread.
    expect(byPath.get('models/d.glb')?.documentInfo).toEqual(CACHED);
  });
});
