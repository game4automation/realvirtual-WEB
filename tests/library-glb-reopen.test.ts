// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-709 §2.6.1 / §9.7 — a saved Custom asset must re-open from the PROJECT.
 *
 * The defect this file was written against (red on HEAD, green after phase 1):
 * `saveAssetToCustomLibrary` already writes through the project backend
 * (`library/Custom/<Name>.glb`, pinned by `asset-save-target.test.ts`), while
 * re-opening the very same `libraryGlb` base resolved through the old
 * work-folder API. The two halves address different stores, so in a
 * **browser-backend project** — the only writable backend on Firefox, Safari
 * and every iPad — a freshly saved asset could not be opened again at all: the
 * open path asks for a work folder that such a project never has.
 *
 * The test therefore does the round trip rather than asserting on either half:
 * save through the real save function, then re-open through the editor's real
 * `_loadBase`, with one fake backend serving both. Anything that keeps the two
 * ends on the same store passes; anything that reintroduces a second store
 * fails, whichever store it picks.
 *
 * Second assertion (§9.7, second half): the DRAFT FORM does not change. A base
 * written by a pre-phase-1 build carries exactly the same `relPath`, so a draft
 * saved before the change opens identically after it — only the resolution path
 * moves, never the field.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => ({
  /** `library/Custom/Belt.glb` → bytes, i.e. the project's blob store. */
  blobs: new Map<string, Blob>(),
  /** Handed back by the mocked work-folder API — a browser project HAS none. */
  workFolder: null as unknown,
}));

// A browser-backend project has no File System Access handle at all. This is
// not a convenience stub: `getWorkFolder()` genuinely returns null there, which
// is exactly why the old resolution path could not work.
// Spread the real module and override only the four functions this test steers.
// A bare factory silently drops every OTHER export, and the modules under test
// (folder-backend, rv-project-storage) import more of them than this test names —
// omitting one turns the whole file into an import error, which is how this guard
// went dark once already.
vi.mock('../src/core/engine/rv-local-filesystem', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/core/engine/rv-local-filesystem')>()),
  isSupported: () => false,
  getWorkFolder: async () => h.workFolder,
  getSubfolder: async () => null,
  readFileAsUrl: async () => { throw new Error('no work folder'); },
}));

vi.mock('../src/core/project/project-store', () => ({
  getProjectStore: () => store,
}));

// The exporter needs a real Three scene; the ROUND TRIP is what is under test.
vi.mock('../src/core/editor/rv-asset-glb-export', () => ({
  exportAssetGlb: async () => new TextEncoder().encode('GLB-BELT-BYTES').buffer,
}));

const writes: string[] = [];

const backend = {
  kind: 'browser' as const,
  id: 'fake-browser',
  writable: true,
  isActive: true,
  async writeBlob(relPath: string, blob: Blob) {
    writes.push(relPath);
    h.blobs.set(relPath, blob);
  },
  async readBlobUrl(relPath: string) {
    const blob = h.blobs.get(relPath);
    if (!blob) return null;
    const url = URL.createObjectURL(blob);
    return { url, release: () => URL.revokeObjectURL(url) };
  },
};

const store = {
  getBackend: () => backend,
  getProject: () => ({ id: 'prj_browser' }),
  async resolveAssetUrl(relPath: string) {
    return (await backend.readBlobUrl(relPath))?.url ?? null;
  },
  setDirtyDocumentsProbe: () => {},
  mintReferencedAssetIdentities: async () => {},
};

import { saveDocument } from '../src/core/editor/rv-save-document';
import { AssetEditorPlugin } from '@rv-private/plugins/asset-editor/index';
import type { AssetBase } from '../src/core/editor/rv-asset-document';
import {
  libraryDocumentBase,
} from '../src/core/editor/active-asset-store';

/** A viewer stub that records what `_loadBase` asked it to load. */
function loaderViewer() {
  const loaded: string[] = [];
  return {
    loaded,
    currentModelRoot: { name: 'Belt' },
    renderer: {},
    scene: {},
    // The save path announces itself now (plan-719 F8) and emits the
    // pre-export hook before cloning the tree; both go nowhere here.
    emit: () => {},
    getPlugin: () => undefined,
    async loadModel(url: string) { loaded.push(url); },
  };
}

/**
 * A document over `library/Custom/Belt.glb`, as `createDocument` would have
 * left it: a real path, a real id, nothing to invent at save time.
 *
 * plan-719 F9 deleted `saveAssetToCustomLibrary`, which is what this round trip
 * used to save through. The BROWSER-BACKEND pin it carries is not about that
 * function though — it is about the two ends of the trip addressing the same
 * store, which is the only thing that works on Firefox, Safari and every iPad
 * (plan-709 §2.6.1). So the save half moves to the one save path and the pin
 * survives intact, rather than being deleted along with the function.
 */
function beltDocument() {
  const doc = {
    name: 'Belt',
    base: libraryDocumentBase('Custom/Belt.glb'),
    dirty: true,
    whenIdle: async () => {},
    async markSaved(next: AssetBase) { doc.base = next; },
    document: {
      opCount: 0,
      runExclusive: <T,>(work: () => Promise<T>) => work(),
      markSaved() {},
    },
  };
  return doc;
}

/** `_loadBase` is private by design; the test drives it deliberately. */
function loadBase(plugin: AssetEditorPlugin, viewer: unknown, base: AssetBase): Promise<void> {
  return (plugin as unknown as {
    _loadBase(v: unknown, b: AssetBase): Promise<void>;
  })._loadBase(viewer, base);
}

beforeEach(() => {
  h.blobs.clear();
  h.workFolder = null;
  writes.length = 0;
});

describe('libraryGlb round trip in a browser-backend project', () => {
  it('saves into the project and re-opens from the project', async () => {
    const saver = loaderViewer();
    const outcome = await saveDocument(saver as never, beltDocument() as never);

    expect(outcome.kind).toBe('saved');
    if (outcome.kind !== 'saved') return;
    expect(outcome.relPath).toBe('library/Custom/Belt.glb');
    expect(writes).toContain('library/Custom/Belt.glb');

    // A new session: the document is gone, only the base survives.
    const reopen = loaderViewer();
    const base: AssetBase = libraryDocumentBase('Custom/Belt.glb');
    await loadBase(new AssetEditorPlugin(), reopen, base);

    expect(reopen.loaded).toHaveLength(1);
    const bytes = await (await fetch(reopen.loaded[0])).text();
    expect(bytes).toBe('GLB-BELT-BYTES');
  });

  it('resolves a base persisted by an older build unchanged (draft form is stable)', async () => {
    // Exactly the shape `save-flow.ts` has always written into the draft: a
    // LIBRARY-relative relPath. No migration, no second field.
    h.blobs.set(
      'library/Custom/Gripper.glb',
      new Blob([new TextEncoder().encode('GLB-GRIPPER')]),
    );
    const stored: AssetBase = libraryDocumentBase('Custom/Gripper.glb');

    const reopen = loaderViewer();
    await loadBase(new AssetEditorPlugin(), reopen, stored);

    expect(await (await fetch(reopen.loaded[0])).text()).toBe('GLB-GRIPPER');
  });

  it('says which path could not be read when the asset is gone', async () => {
    const reopen = loaderViewer();
    await expect(loadBase(new AssetEditorPlugin(), reopen, libraryDocumentBase('Custom/Ghost.glb'))).rejects.toThrow(/library\/Custom\/Ghost\.glb/);
    expect(reopen.loaded).toHaveLength(0);
  });
});
