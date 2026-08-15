// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * A document is a FILE with a PATH, and saving it writes THAT file — the
 * consistency rule this suite pins after the field findings of 2026-08-14:
 *
 *  1. **In place, silently.** A named document whose identity carries a path
 *     saves to exactly that path — no name prompt, no `_1` copy, no new
 *     identity. (Field finding: opening a project's own asset handed the
 *     editor a `providerAsset` identity, so every save forked a copy.)
 *  2. **The first name is a rename, not a fork.** An "Untitled" document is
 *     asked for a name ONCE, and the picked name renames the document itself;
 *     the bytes still go to the document's own path. (Field finding: the
 *     picked name differed from `doc.name`, which `saveAssetAs` read as
 *     "Save as…" and forked a new file — an unnamed document could never be
 *     saved in place.)
 *  3. **"Save as…" is the only fork.** The explicit verb keeps its copy
 *     semantics; nothing else may reach them.
 *  4. **A BOUND document saves through the scene writer.** Its bytes are the
 *     op-log bake against the base bytes; routing it through the asset
 *     exporter would write the authored tree and desync the scene store's
 *     revision state. Since the identity carries the row's path, the routing
 *     discriminant is `isBound` (plus the legacy path-less form) — never the
 *     path alone.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => ({
  /** Scene store handed to `sceneSaveTargetFor` — set per test, default none. */
  sceneStore: null as unknown,
  sceneSaves: 0,
}));

vi.mock('../src/core/project/project-store', () => ({
  getProjectStore: () => ({
    getBackend: () => backend,
    getProject: () => ({ id: 'prj_in_place' }),
  }),
}));
vi.mock('../src/core/engine/rv-local-filesystem', () => ({ isSupported: () => true }));
vi.mock('../src/core/editor/rv-asset-glb-export', () => ({
  exportAssetGlb: async () => new TextEncoder().encode('GLB').buffer,
}));
vi.mock('../src/core/thumbnails/thumbnail-renderer', () => ({
  ThumbnailRenderer: class {
    render(): string | null { return null; }
    dispose(): void {}
  },
}));
vi.mock('../src/core/hmi/scene/scene-store-singleton', () => ({
  getSceneStore: () => h.sceneStore,
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

import { runSaveFlow } from '@rv-private/plugins/asset-editor/save-flow';
import { saveDocument } from '../src/core/editor/rv-save-document';
import { documentBase } from '../src/core/editor/active-asset-store';
import type { AssetBase } from '../src/core/editor/rv-asset-document';
import {
  getPendingDialog,
  subscribeEditorDialogs,
} from '@rv-private/plugins/asset-editor/editor-dialog-store';

/**
 * Answer name prompts with `answer`, and RECORD every one — so a test can
 * assert that no prompt appeared at all, not merely survive one.
 */
function watchNamePrompts(answer: string | null): { prompts: string[]; off: () => void } {
  const prompts: string[] = [];
  const off = subscribeEditorDialogs(() => {
    const pending = getPendingDialog();
    if (pending?.kind === 'name') {
      prompts.push('asked');
      (pending as unknown as { resolve: (v: unknown) => void }).resolve(answer);
    }
  });
  return { prompts, off };
}

interface SavedCall { base: AssetBase; name?: string }

function context(name: string, base: AssetBase, opts?: { bound?: boolean }) {
  const saved: SavedCall[] = [];
  const doc = {
    name,
    base,
    dirty: true,
    renameDocument(n: string) { this.name = n; },
    whenIdle: async () => {},
    markSaved: async (b: AssetBase, n?: string) => { saved.push({ base: b, name: n }); },
    get isBound() { return opts?.bound === true; },
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
    emit: () => {},
    getPlugin: () => undefined,
  };
  return { ctx: { viewer, doc } as never, viewer, doc, saved };
}

beforeEach(() => {
  writes.length = 0;
  h.sceneStore = null;
  h.sceneSaves = 0;
});

describe('a document with a path saves in place', () => {
  it('writes exactly the document path — no prompt, no copy, no new identity', async () => {
    const base = documentBase('doc_belt', 'Belt', 'Belt.glb');
    const { ctx, saved } = context('Belt', base);
    const { prompts, off } = watchNamePrompts('never used');
    try {
      expect(await runSaveFlow(ctx)).toBe(true);
    } finally { off(); }

    expect(prompts).toEqual([]);                     // named → nothing to ask
    expect(writes).toEqual(['Belt.glb']);            // in place, exactly once
    // The identity survives the save: same document id, same path. A minted
    // second identity here is the copy bug this suite exists to keep dead.
    expect(saved[0].base).toEqual({
      kind: 'document', documentId: 'doc_belt', path: 'Belt.glb', name: 'Belt',
    });
  });

  it('holds wherever the file sits — a library path is a place, not a type', async () => {
    const base = documentBase('doc_press', 'Press', 'library/Custom/Press.glb');
    const { ctx, saved } = context('Press', base);
    expect(await runSaveFlow(ctx)).toBe(true);
    expect(writes[0]).toBe('library/Custom/Press.glb');
    expect(writes).not.toContain('library/Custom/Press_1.glb');
    expect(saved[0].base).toEqual({
      kind: 'document', documentId: 'doc_press', path: 'library/Custom/Press.glb', name: 'Press',
    });
  });
});

describe('the first name is a rename, not a fork', () => {
  it('asks once, renames the document, and still saves to its own path', async () => {
    const base = documentBase('doc_new', 'Untitled', 'Untitled.glb');
    const { ctx, doc, saved } = context('Untitled', base);
    const { prompts, off } = watchNamePrompts('Rolling Mill');
    try {
      expect(await runSaveFlow(ctx)).toBe(true);
    } finally { off(); }

    expect(prompts).toEqual(['asked']);              // unnamed → asked once
    expect(doc.name).toBe('Rolling Mill');           // the name IS the document's
    expect(writes).toEqual(['Untitled.glb']);        // bytes to the document's path
    // Renamed, not re-identified: same id, same path, new name.
    expect(saved[0]).toEqual({
      base: { kind: 'document', documentId: 'doc_new', path: 'Untitled.glb', name: 'Rolling Mill' },
      name: 'Rolling Mill',
    });
  });

  it('cancelling the prompt writes nothing', async () => {
    const base = documentBase('doc_new', 'Untitled', 'Untitled.glb');
    const { ctx, saved } = context('Untitled', base);
    const { off } = watchNamePrompts(null);
    try {
      expect(await runSaveFlow(ctx)).toBe(false);
    } finally { off(); }
    expect(writes).toEqual([]);
    expect(saved).toEqual([]);
  });
});

describe('"Save as…" is the only fork', () => {
  it('the explicit verb copies into the Custom library under the picked name', async () => {
    const base = documentBase('doc_belt', 'Belt', 'Belt.glb');
    const { ctx } = context('Belt', base);
    const { off } = watchNamePrompts('Belt Copy');
    try {
      expect(await runSaveFlow(ctx, { forceNamePrompt: true })).toBe(true);
    } finally { off(); }
    expect(writes).toEqual(['library/Custom/Belt Copy.glb']);
  });
});

describe('a bound document saves through the scene writer', () => {
  function sceneStoreFor(documentId: string) {
    return {
      lineage: 'scene' as const,
      getSnapshot: () => ({
        draft: { name: 'Line' },
        saved: { id: documentId },
        isDraft: false,
        dirty: true,
        transient: false,
      }),
      save: async () => { h.sceneSaves++; return 'saved' as const; },
      saveAs: async () => { throw new Error('saveAs must not be reached for a saved document'); },
    };
  }

  it('routes by isBound even though the identity carries a path', async () => {
    const base = documentBase('doc_line', 'Line', 'Line.glb');
    const { viewer, doc } = context('Line', base, { bound: true });
    h.sceneStore = sceneStoreFor('doc_line');

    const result = await saveDocument(viewer as never, doc as never);

    expect(h.sceneSaves).toBe(1);                    // the scene writer ran
    expect(writes).toEqual([]);                      // the asset writer did NOT
    expect(result).toEqual({
      kind: 'saved', base, relPath: 'Line.glb', copied: false,
    });
  });

  it('an UNBOUND document with the same identity uses the asset writer', async () => {
    const base = documentBase('doc_line', 'Line', 'Line.glb');
    const { viewer, doc } = context('Line', base);
    h.sceneStore = sceneStoreFor('doc_line');        // present, but not consulted

    const result = await saveDocument(viewer as never, doc as never);

    expect(h.sceneSaves).toBe(0);
    expect(writes).toEqual(['Line.glb']);
    expect(result.kind).toBe('saved');
  });

  it('a bound document whose scene moved away is blocked, not mis-saved', async () => {
    const base = documentBase('doc_line', 'Line', 'Line.glb');
    const { viewer, doc } = context('Line', base, { bound: true });
    h.sceneStore = sceneStoreFor('doc_other');       // another document is open

    const result = await saveDocument(viewer as never, doc as never);

    expect(result.kind).toBe('blocked');
    expect(h.sceneSaves).toBe(0);
    expect(writes).toEqual([]);
  });
});
