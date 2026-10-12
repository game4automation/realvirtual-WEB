// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * folder-backend-lazy-classification — the header scan reads headers (plan-751).
 *
 * `classificationOfGlbBlob` already promises this in its own doc comment:
 * "two slices, twenty bytes and then the JSON chunk — the BIN tail, which is
 * all of the size, is never touched". The promise only holds if what it slices
 * is still a HANDLE. A `File` from the File System Access API is one; the same
 * file put through `fetch(objectUrl).blob()` is not — that materialises every
 * byte first and then hands the slice something already paid for.
 *
 * The store used to reach classification through {@link readDocumentUrl} and
 * did exactly that, so opening a folder project read every byte of every GLB
 * to look at their headers. On a local NVMe that is ~1 s and invisible; on a
 * project opened over a network share it is the open. Hence
 * {@link FolderBackend.readDocumentBlob} and the lazy-first branch in
 * `ProjectStore._scanClassifications`.
 *
 * The last test is the one that would catch a revert: it asserts on the
 * ABSENCE of the old mechanism (no `blob:` URL is ever fetched during an open),
 * because the visible behaviour — a correctly classified document — is
 * identical either way. Only the cost differs, and cost is what regressed.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FakeDir, asDirHandle } from './helpers/fake-fs-handles';
import { FolderBackend } from '../src/core/project/backends/folder-backend';
import { ProjectStore, resetProjectStore } from '../src/core/project/project-store';
import { classificationOfGlbBlob } from '../src/core/project/rv-project-documents';
import { RV_CLASSIFICATION_KEY } from '../src/core/project/rv-document-classification';

// ─── A GLB, built by hand ───────────────────────────────────────────────

/**
 * A structurally valid GLB carrying `extras.realvirtual.Classification`.
 *
 * `binBytes` pads a BIN chunk onto the tail. Nothing asserts on its contents —
 * it is there so that "read the header" and "read the file" are different
 * amounts of work even in a fake, which is the whole point of the exercise.
 */
function glbWithClassification(level: string, binBytes: number): Blob {
  const json = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ extras: { realvirtual: { [RV_CLASSIFICATION_KEY]: { v: 1, level } } } }],
  };
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const pad = (4 - (jsonBytes.length % 4)) % 4;
  const jsonLen = jsonBytes.length + pad;
  const binChunk = binBytes > 0 ? 8 + binBytes : 0;
  const total = 12 + 8 + jsonLen + binChunk;

  const buf = new ArrayBuffer(total);
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);

  view.setUint32(0, 0x46546c67, true);        // 'glTF'
  view.setUint32(4, 2, true);                 // version
  view.setUint32(8, total, true);             // total length
  view.setUint32(12, jsonLen, true);          // JSON chunk length
  view.setUint32(16, 0x4e4f534a, true);       // 'JSON'
  bytes.set(jsonBytes, 20);
  bytes.fill(0x20, 20 + jsonBytes.length, 20 + jsonLen);   // pad with spaces

  if (binBytes > 0) {
    const at = 20 + jsonLen;
    view.setUint32(at, binBytes, true);
    view.setUint32(at + 4, 0x004e4942, true); // 'BIN\0'
  }
  return new Blob([buf]);
}

/** Seed a binary file through the writable stream — `seedText` is text-only. */
async function seedBlob(dir: FakeDir, name: string, blob: Blob): Promise<void> {
  const handle = await dir.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  await writable.write(blob);
  await writable.close();
}

/** A project folder with one classified GLB under `models/`. */
async function seedProject(binBytes = 4096): Promise<FakeDir> {
  const root = new FakeDir('lazy-project');
  root.seedText('project.json', JSON.stringify({
    schemaVersion: 3, id: 'prj_lazy', name: 'Lazy', documents: [],
  }));
  const models = root.seedDir('models');
  await seedBlob(models, 'plant.glb', glbWithClassification('plant', binBytes));
  return root;
}

// ─── The seam ───────────────────────────────────────────────────────────

describe('FolderBackend.readDocumentBlob', () => {
  it('hands back the handle\'s own file, not a copy of it', async () => {
    const root = await seedProject();
    const backend = new FolderBackend(asDirHandle(root));
    await backend.activate();

    const models = await root.getDirectoryHandle('models');
    const fromHandle = await (await models.getFileHandle('plant.glb')).getFile();
    const fromBackend = await backend.readDocumentBlob('models/plant.glb');

    // Identity, not equality: a copy would read the bytes to make itself.
    expect(fromBackend).toBe(fromHandle);
    await backend.deactivate();
  });

  it('reads the classification out of the header', async () => {
    const root = await seedProject();
    const backend = new FolderBackend(asDirHandle(root));
    await backend.activate();

    const blob = await backend.readDocumentBlob('models/plant.glb');
    expect(blob).not.toBeNull();
    expect(await classificationOfGlbBlob(blob!)).toEqual({ v: 1, level: 'plant' });
    await backend.deactivate();
  });

  it('answers null for a document the folder does not hold', async () => {
    const root = await seedProject();
    const backend = new FolderBackend(asDirHandle(root));
    await backend.activate();

    expect(await backend.readDocumentBlob('models/absent.glb')).toBeNull();
    await backend.deactivate();
  });
});

// ─── The regression guard ───────────────────────────────────────────────

describe('opening a folder project', () => {
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

  it('classifies its documents without fetching a single blob: URL', async () => {
    const root = await seedProject();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    expect(await store.openProjectFolder(asDirHandle(root))).toBe(true);

    const document = store.getSnapshot().documents
      .find(d => d.path === 'models/plant.glb');
    expect(document?.classification).toEqual({ v: 1, level: 'plant' });

    // The old path was `fetch(URL.createObjectURL(file)).blob()` — one blob:
    // fetch per unclassified document, each one the whole file. Any reappearing
    // here means the lazy branch was routed around again.
    const blobFetches = fetchSpy.mock.calls
      .filter(call => String(call[0]).startsWith('blob:'));
    expect(blobFetches).toEqual([]);
  });
});
