// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-709 phase 0 — what the editor Save does TODAY, written down before it
 * is rebuilt.
 *
 * This is a characterisation test, not a specification: every assertion here
 * describes behaviour that already exists, so that the phase-2 rewrite of the
 * save path (`saveDocument()`) has to keep it or say out loud that it does not.
 * The three promises the plan names are pinned:
 *
 *  1. an **Untitled** document asks for a name before anything is written, and
 *     cancelling the prompt writes nothing at all;
 *  2. a save writes **two** blobs — the GLB and the thumbnail beside it in
 *     `library/.thumbnails/` — and the thumbnail failing does not fail the save;
 *  3. after a successful save the planner's decoded copy of the asset is
 *     dropped and the document is re-based onto a `libraryGlb` identity
 *     carrying the library-relative path.
 *
 * Plus one boundary the plan needs (§5, risk "Registry-Löschung bricht
 * Share-Overlay"): the share card hangs in the `'overlay'` UI slot and never
 * depended on the hierarchy-header registry that phase 6 deleted.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => ({
  thumbnail: 'data:image/png;base64,iVBORw0KGgo=' as string | null,
}));

vi.mock('../src/core/project/project-store', () => ({
  getProjectStore: () => ({
    getBackend: () => backend,
    getProject: () => ({ id: 'prj_characterisation' }),
  }),
}));
vi.mock('../src/core/engine/rv-local-filesystem', () => ({ isSupported: () => true }));
vi.mock('../src/core/editor/rv-asset-glb-export', () => ({
  exportAssetGlb: async () => new TextEncoder().encode('GLB').buffer,
}));
vi.mock('../src/core/thumbnails/thumbnail-renderer', () => ({
  ThumbnailRenderer: class {
    render(): string | null { return h.thumbnail; }
    dispose(): void {}
  },
}));

const writes: string[] = [];
const backend = {
  kind: 'browser' as const,
  id: 'fake',
  writable: true,
  isActive: true,
  async writeBlob(relPath: string) { writes.push(relPath); },
  // Nothing is stored, so every save is a first save of its path.
  async readBlobUrl() { return null; },
  async listDocuments() { return []; },
};

import { runSaveFlow, saveAssetAs } from '@rv-private/plugins/asset-editor/save-flow';
import {
  getPendingDialog,
  subscribeEditorDialogs,
} from '@rv-private/plugins/asset-editor/editor-dialog-store';
import { SharePlugin } from '../src/core/share/share-plugin';
import hierarchyBrowserSource from '../src/core/hmi/rv-hierarchy-browser.tsx?raw';
import type { AssetBase } from '../src/core/editor/rv-asset-document';
import { libraryDocumentBase } from '../src/core/editor/active-asset-store';

/** Answer the next dialog of `kind`; returns an unsubscribe. */
function autoAnswer(kind: string, answer: unknown): () => void {
  return subscribeEditorDialogs(() => {
    const pending = getPendingDialog();
    if (pending?.kind === kind) {
      (pending as unknown as { resolve: (v: unknown) => void }).resolve(answer);
    }
  });
}

interface SavedCall { base: AssetBase; name?: string }

function context(name: string) {
  const saved: SavedCall[] = [];
  const refreshed: string[] = [];
  const invalidated: string[] = [];
  const emitted: string[] = [];
  const doc = {
    name,
    // A fresh, unsaved asset: the shape the editor opens on and the one the
    // name prompt exists for.
    base: { kind: 'empty' } as AssetBase,
    dirty: true,
    // The implicit name prompt names the DOCUMENT (save-flow renames before
    // saving, so an unnamed document's first save stays in place).
    renameDocument(n: string) { this.name = n; },
    whenIdle: async () => {},
    markSaved: async (base: AssetBase, n?: string) => { saved.push({ base, name: n }); },
    // The unified document underneath. `runExclusive` really does run the work
    // (the save must not be skipped) and the op floor never moves here.
    document: {
      opCount: 0,
      runExclusive: <T,>(work: () => Promise<T>) => work(),
      markSaved: () => {},
    },
  };
  const viewer = {
    currentModelRoot: { name: 'root' },
    renderer: {},
    scene: {},
    emit: (event: string) => { emitted.push(event); },
    getPlugin: () => ({
      store: {
        getSnapshot: () => ({
          catalogs: new Map([['lib', {
            entries: [{ localPath: 'Custom/Belt.glb', glbUrl: 'blob:belt' }],
          }]]),
        }),
        // Kept on the double although production no longer calls it: if a
        // folder re-scan ever comes back, this test says so.
        refreshLocalFolder: async () => { refreshed.push('local'); },
      },
      modelCache: { invalidate: (url: string) => { invalidated.push(url === 'blob:belt' ? 'Custom/Belt.glb' : url); } },
    }),
  };
  return { ctx: { viewer, doc } as never, saved, refreshed, invalidated, emitted };
}

beforeEach(() => {
  writes.length = 0;
  h.thumbnail = 'data:image/png;base64,iVBORw0KGgo=';
});

describe('editor save flow — the name prompt', () => {
  it('asks for a name when the document is Untitled', async () => {
    const { ctx, saved } = context('Untitled');
    const off = autoAnswer('name', 'Belt');
    try {
      expect(await runSaveFlow(ctx)).toBe(true);
    } finally { off(); }
    expect(writes[0]).toBe('library/Custom/Belt.glb');
    expect(saved[0].name).toBe('Belt');
  });

  it('cancelling the prompt writes NOTHING and reports failure', async () => {
    const { ctx, saved } = context('Untitled');
    const off = autoAnswer('name', null);
    try {
      expect(await runSaveFlow(ctx)).toBe(false);
    } finally { off(); }
    expect(writes).toEqual([]);
    expect(saved).toEqual([]);
  });

  it('a named document saves without asking', async () => {
    const { ctx } = context('Gripper');
    expect(await runSaveFlow(ctx)).toBe(true);
    expect(writes[0]).toBe('library/Custom/Gripper.glb');
  });
});

describe('editor save flow — what reaches the project', () => {
  it('writes the GLB and the thumbnail beside it', async () => {
    const { ctx } = context('Belt');
    await saveAssetAs(ctx, 'Belt');
    expect(writes).toEqual([
      'library/Custom/Belt.glb',
      'library/.thumbnails/Custom/Belt.png',
    ]);
  });

  it('a missing thumbnail does not fail the save', async () => {
    h.thumbnail = null;                       // WebGPU: no classic renderer
    const { ctx, saved } = context('Belt');
    const outcome = await saveAssetAs(ctx, 'Belt');
    expect(outcome.kind).toBe('saved');
    expect(writes).toEqual(['library/Custom/Belt.glb']);
    expect(saved).toHaveLength(1);
  });

  it('lets live-preview holders restore before the tree is cloned', async () => {
    const { ctx, emitted } = context('Belt');
    await saveAssetAs(ctx, 'Belt');
    expect(emitted).toContain('asset-editor-pre-export');
  });
});

describe('editor save flow — after the write', () => {
  it('re-bases the document onto the saved library path', async () => {
    const { ctx, saved } = context('Belt');
    await saveAssetAs(ctx, 'Belt');
    expect(saved[0].base).toEqual(libraryDocumentBase('Custom/Belt.glb'));
  });

  // The save used to end by re-scanning a local working folder so the new asset
  // appeared in the planner. That folder is gone (plan-709 §2.6) and the save
  // writes into the project's own library, so there is nothing to re-scan —
  // only the planner's DECODED copy of the old bytes to drop, or the next
  // placement would silently use the pre-save geometry.
  it('drops the planner cache for the saved asset, and scans no folder', async () => {
    const { ctx, refreshed, invalidated } = context('Belt');
    await saveAssetAs(ctx, 'Belt');
    expect(refreshed).toEqual([]);
    expect(invalidated).toEqual(['Custom/Belt.glb']);
  });
});

// ─── The boundary phase 6 must not break ─────────────────────────────────

describe('share overlay is independent of the hierarchy-header registry', () => {
  it('the share card hangs in the overlay slot', () => {
    const slots = new SharePlugin().slots;
    expect(slots.map(s => s.slot)).toEqual(['overlay']);
  });

  it('no mode-keyed header registry exists to compete with the overlay', () => {
    // Since plan-709 phase 3 there is ONE document card for every mode, mounted
    // directly by the hierarchy browser, so the mode-keyed registry had nothing
    // left to carry and went in phase 6. This pins that it does not come back:
    // a second header mechanism is exactly what would displace the share card.
    expect(hierarchyBrowserSource).not.toContain('getHierarchyHeader');
    expect(hierarchyBrowserSource).toContain('DocumentCard');
  });
});
