// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * saveAssetToCustomLibrary — the save target is the active project
 * (plan-372 §2.9, Phase 10).
 *
 * The regression these tests exist for: the function used to open with a File
 * System Access check as its very first statement. On Firefox and Safari - where
 * that API does not exist and the browser backend is the ONLY writable route -
 * every save of a user's own asset failed with 'unsupported'. The guard now
 * lives inside the folder branch, so the browser backend reaches OPFS.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({
  backend: null as null | {
    kind: 'bundled' | 'browser' | 'folder';
    writable: boolean;
    writeBlob: (relPath: string, blob: Blob) => Promise<void>;
  },
  fsSupported: true,
}));

vi.mock('../src/core/project/project-store', () => ({
  getProjectStore: () => ({ getBackend: () => h.backend }),
}));
vi.mock('../src/core/engine/rv-local-filesystem', () => ({
  isSupported: () => h.fsSupported,
}));
// The GLB exporter needs a real scene; the save path's branching is what is
// under test, so a fixed buffer keeps this a unit test.
vi.mock('../src/core/editor/rv-asset-glb-export', () => ({
  exportAssetGlb: async () => new ArrayBuffer(8),
}));

import { saveAssetToCustomLibrary } from '../src/core/editor/rv-asset-library-save';

const doc = { whenIdle: async () => {} } as never;
const viewer = {
  currentModelRoot: { name: 'root' },
  renderer: {},
  scene: {},
} as never;

function backend(kind: 'bundled' | 'browser' | 'folder', writable: boolean) {
  const writes: string[] = [];
  h.backend = {
    kind,
    writable,
    writeBlob: async (relPath: string) => { writes.push(relPath); },
  };
  return writes;
}

beforeEach(() => { h.fsSupported = true; h.backend = null; });
afterEach(() => vi.restoreAllMocks());

describe('save target selection', () => {
  it('reports no writable project when nothing is open', async () => {
    const out = await saveAssetToCustomLibrary(viewer, doc, 'Belt');
    expect(out.kind).toBe('no-writable-project');
  });

  it('refuses a bundled project WITH a reason the user can act on', async () => {
    backend('bundled', false);
    const out = await saveAssetToCustomLibrary(viewer, doc, 'Belt');
    expect(out.kind).toBe('no-writable-project');
    if (out.kind === 'no-writable-project') {
      expect(out.reason).toMatch(/ships with the application/i);
      expect(out.reason).toMatch(/create or open your own project/i);
    }
  });

  it('writes a browser project even when File System Access is missing', async () => {
    // This is the Firefox / Safari case that used to fail outright.
    h.fsSupported = false;
    const writes = backend('browser', true);
    const out = await saveAssetToCustomLibrary(viewer, doc, 'Belt');
    expect(out.kind).toBe('saved');
    expect(writes[0]).toBe('library/Custom/Belt.glb');
  });

  it("reports 'unsupported' only for a folder project without the API", async () => {
    h.fsSupported = false;
    backend('folder', true);
    const out = await saveAssetToCustomLibrary(viewer, doc, 'Belt');
    expect(out.kind).toBe('unsupported');
  });

  it('writes into the project library for a folder project', async () => {
    const writes = backend('folder', true);
    const out = await saveAssetToCustomLibrary(viewer, doc, 'Belt');
    expect(out.kind).toBe('saved');
    if (out.kind === 'saved') expect(out.relPath).toBe('Custom/Belt.glb');
    expect(writes[0]).toBe('library/Custom/Belt.glb');
  });

  it('sanitises the file name before it reaches the backend', async () => {
    const writes = backend('browser', true);
    await saveAssetToCustomLibrary(viewer, doc, 'a/b:c*d');
    expect(writes[0]).toBe('library/Custom/a_b_c_d.glb');
  });
});
