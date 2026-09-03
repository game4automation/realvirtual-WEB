// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * What the editor Save does — restated for plan-719's target semantics.
 *
 * Written as a plan-709 characterisation of the pre-`saveDocument()` flow, and
 * rebuilt here rather than patched, because two of its three original promises
 * described cases that no longer exist:
 *
 *  - the **Untitled** document that asked for a name before anything was
 *    written is gone with base kind `'empty'` (F3): a document is created with
 *    a path before the editor opens it, so an unnamed one saves to ITS OWN
 *    file. What replaced that prompt is the one for a read-only source, and it
 *    is pinned in `save-into-project-prompt.test.ts`;
 *  - the planner-cache invalidation is no longer performed BY the save flow
 *    (Defect b): it hangs off `viewer.emit('document-saved', …)`, so what this
 *    file pins is that the event is emitted, not that a plugin was poked.
 *
 * What survives unchanged, and is still the reason this file exists:
 *
 *  1. a named document saves without asking anything, and "Save as…" is the
 *     only thing that prompts;
 *  2. a save writes **two** blobs — the GLB and the thumbnail beside it in
 *     `library/.thumbnails/` — and the thumbnail failing does not fail it;
 *  3. live-preview holders get to restore before the tree is cloned;
 *  4. after a successful save the document is re-based onto the identity it
 *     now has.
 *
 * Plus one boundary (plan-709 §5, risk "Registry-Löschung bricht
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
  async readDocumentUrl() { return null; },
  async listDocuments() { return []; },
};

import { runSaveFlow, saveAssetAs } from '@rv-private/plugins/asset-editor/save-flow';
// The save prompt lives in the PUBLIC store since plan-719 §2.10 — one pending
// slot per document, whichever entry point asks — so this is where the test
// answers it from too.
import {
  getPendingSaveDialog,
  resetSaveDialogsForTests,
  subscribeSaveDialogs,
} from '../src/core/hmi/scene/save-dialog-store';
import { SharePlugin } from '../src/core/share/share-plugin';
import hierarchyBrowserSource from '../src/core/hmi/rv-hierarchy-browser.tsx?raw';
import type { AssetBase } from '../src/core/editor/rv-asset-document';
import { libraryDocumentBase } from '../src/core/editor/active-asset-store';

/** Answer the next save dialog of `kind`; returns an unsubscribe. */
function autoAnswer(kind: string, answer: unknown): () => void {
  return subscribeSaveDialogs(() => {
    const pending = getPendingSaveDialog();
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
    // A document of the project's Custom library. Since plan-719 F3 there is
    // no other shape the editor can open on: every document has a path from
    // the moment it is created.
    base: libraryDocumentBase(`Custom/${name}.glb`) as AssetBase,
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
  /**
   * F1: a document saves to itself, in silence. This is the rule the whole
   * plan collapses to, and the case that used to be a prompt.
   */
  it('a named document saves without asking anything', async () => {
    let asked = 0;
    const off = subscribeSaveDialogs(() => { if (getPendingSaveDialog()) asked++; });
    const { ctx } = context('Gripper');
    try {
      expect(await runSaveFlow(ctx)).toBe(true);
    } finally { off(); }
    expect(asked).toBe(0);
    expect(writes[0]).toBe('library/Custom/Gripper.glb');
  });

  it('"Save as…" is the one verb that prompts, and it names a new file', async () => {
    const { ctx, saved } = context('Belt');
    const off = autoAnswer('name', 'Belt v2');
    try {
      expect(await runSaveFlow(ctx, { forceNamePrompt: true })).toBe(true);
    } finally { off(); }
    expect(writes[0]).toBe('library/Custom/Belt v2.glb');
    expect(saved[0].name).toBe('Belt v2');
  });

  it('cancelling that prompt writes NOTHING and reports failure', async () => {
    const { ctx, saved } = context('Belt');
    const off = autoAnswer('name', null);
    try {
      expect(await runSaveFlow(ctx, { forceNamePrompt: true })).toBe(false);
    } finally { off(); }
    expect(writes).toEqual([]);
    expect(saved).toEqual([]);
  });

  /**
   * plan-719 §2.2, row 3. A name that merely DIFFERS from the document's own
   * used to be read as a Save-As and forked a new file — so renaming a
   * document and then saving it silently left the original behind and moved
   * the session onto a copy nobody asked for.
   */
  it('a differing name alone does NOT fork a new file', async () => {
    const { ctx } = context('Belt');
    const outcome = await saveAssetAs(ctx, 'Belt renamed');
    expect(outcome.kind).toBe('saved');
    expect(writes[0]).toBe('library/Custom/Belt.glb');
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

  /**
   * plan-719 F8 / Defect (b). The save used to drop the planner's decoded copy
   * itself, by reaching into the plugin and matching the saved path against
   * its catalog — which only ever matched `library/**`, so a document under
   * `models/` was placed from pre-save geometry afterwards. What the save flow
   * owes the rest of the app is now an ANNOUNCEMENT; who listens is their
   * business, and the planner's own subscription is pinned where the planner
   * is.
   */
  it('announces the save and no longer reaches into the planner', async () => {
    const { ctx, refreshed, invalidated, emitted } = context('Belt');
    await saveAssetAs(ctx, 'Belt');
    expect(emitted).toContain('document-saved');
    expect(refreshed).toEqual([]);
    expect(invalidated).toEqual([]);
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
