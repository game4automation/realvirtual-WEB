// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-506 §9.10 — an old stat cache is read again until the marker lands (F13).
 *
 * Every manifest written before plan-506 carries `(size, mtime, sha256)` from
 * the classification-only scan. Trusting them would hide a `DocumentInfo` block
 * forever, so the pre-filter only clears a row that also says `extrasScan: 2`.
 *
 * The honest part (SOL R2-4): the scan never writes — opening a project stays a
 * read — so the marker cannot land on open. It lands with the next REGULAR
 * manifest write, whatever verb that is. Until then every open reads the row
 * again, header only. Two independent store/backend instances over one folder
 * prove that nothing in memory is carrying the result between opens.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FakeDir, asDirHandle } from './helpers/fake-fs-handles';
import { glbWithSceneExtras, seedBlob } from './helpers/glb-scene-extras';
import { FolderBackend } from '../src/core/project/backends/folder-backend';
import { ProjectStore, resetProjectStore } from '../src/core/project/project-store';
import { reconcileSceneExtrasCache } from '../src/core/project/rv-project-documents';
import { revisionOfBytes } from '../src/core/project/rv-scene-record';
import type { DocumentInfo } from '../src/core/project/rv-document-info';

const INFO: DocumentInfo = { v: 1, summary: 'Press 400 t', updatedAt: '2026-09-26T10:00:00.000Z' };
const MTIME = 1_700_000_000_000;

async function statRow(id: string, path: string, blob: Blob) {
  return {
    id, path, name: id,
    sizeBytes: blob.size, mtimeMs: MTIME,
    sha256: await revisionOfBytes(new Uint8Array(await blob.arrayBuffer())),
  };
}

/** A folder whose manifest has the pre-plan-506 stat cache: matching stats, no marker. */
async function seedLegacyProject(): Promise<FakeDir> {
  const root = new FakeDir('legacy-project');
  const models = root.seedDir('models');
  const a = glbWithSceneExtras({ DocumentInfo: INFO }, 4096, MTIME);
  const b = glbWithSceneExtras({ Classification: { v: 1, level: 'part' } }, 4096, MTIME);
  await seedBlob(models, 'a.glb', a);
  await seedBlob(models, 'b.glb', b);
  root.seedText('project.json', JSON.stringify({
    schemaVersion: 3, id: 'prj_legacy', name: 'Legacy',
    documents: [await statRow('doc-a', 'models/a.glb', a), await statRow('doc-b', 'models/b.glb', b)],
  }));
  return root;
}

async function manifestText(root: FakeDir): Promise<string> {
  return (await (await root.getFileHandle('project.json')).getFile()).text();
}

describe('plan-506 §9.10 — legacy stat cache migration', () => {
  let stores: ProjectStore[] = [];

  beforeEach(() => {
    localStorage.removeItem('rv-project/last');
    resetProjectStore();
    stores = [];
  });

  afterEach(async () => {
    for (const s of stores) await s.closeProject();
    vi.restoreAllMocks();
  });

  /** A fresh store AND a fresh backend over the same folder — nothing shared in memory. */
  async function open(root: FakeDir): Promise<{ store: ProjectStore; readsOfA: number }> {
    const blobReads = vi.spyOn(FolderBackend.prototype, 'readDocumentBlob');
    const store = new ProjectStore();
    stores.push(store);
    expect(await store.openProjectFolder(asDirHandle(root))).toBe(true);
    const readsOfA = blobReads.mock.calls.filter(c => c[0] === 'models/a.glb').length;
    blobReads.mockRestore();
    return { store, readsOfA };
  }

  it('reads until a regular manifest write persists the marker, then stops', async () => {
    const root = await seedLegacyProject();
    const before = await manifestText(root);

    // Open #1 — the stats match, but no marker: read, and show the block.
    const first = await open(root);
    expect(first.readsOfA).toBe(1);
    expect(first.store.getSnapshot().documents.find(d => d.id === 'doc-a')?.documentInfo).toEqual(INFO);
    // …and opening stayed a read.
    expect(await manifestText(root)).toBe(before);
    await first.store.closeProject();

    // Open #2 — a second, independent instance reads AGAIN: the marker is
    // honestly not persisted yet.
    const second = await open(root);
    expect(second.readsOfA).toBe(1);

    // Any regular manifest write — here, classifying the OTHER document —
    // carries the scan result of doc-a along.
    await second.store.setDocumentClassification('doc-b', { v: 1, level: 'plant' });
    await second.store.closeProject();
    const rowA = (JSON.parse(await manifestText(root)).documents as Record<string, unknown>[])
      .find(r => r.id === 'doc-a')!;
    expect(rowA.extrasScan).toBe(2);
    expect(rowA.documentInfo).toEqual(INFO);

    // Open #3 — the pre-filter now clears doc-a without reading it.
    const third = await open(root);
    expect(third.readsOfA).toBe(0);
    expect(third.store.getSnapshot().documents.find(d => d.id === 'doc-a')?.documentInfo).toEqual(INFO);
  });

  it('never reads a document the backend cannot stat (bundled): the manifest stays the truth', async () => {
    const result = await reconcileSceneExtrasCache(
      [{ id: 'd', path: 'models/a.glb', name: 'a', documentInfo: INFO }],
      { stats: [], readExtras: async () => { throw new Error('must not be called'); } },
    );
    expect(result.read).toEqual([]);
    expect(result.documents[0]!.documentInfo).toEqual(INFO);
  });
});
