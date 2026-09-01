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
 *  2. **A name is a name — "Untitled" included.** (Field decision 2026-08-19:
 *     saving must never branch on what a document is called.) A document
 *     called Untitled saves in place silently like any other; only a document
 *     with NO name at all is asked, and the picked name renames the document
 *     itself rather than forking a copy.
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
// The save prompt lives in the PUBLIC store since plan-719 §2.10 — one pending
// slot per document, so that every entry point (card, menu, Ctrl+S, exit guard,
// MCP) shares one reentrancy guard. The rules this suite pins are unchanged;
// only the store the prompt is answered from moved.
import {
  getPendingSaveDialog,
  resetSaveDialogsForTests,
  subscribeSaveDialogs,
} from '../src/core/hmi/scene/save-dialog-store';

/**
 * Answer name prompts with `answer`, and RECORD every one — so a test can
 * assert that no prompt appeared at all, not merely survive one.
 */
function watchNamePrompts(answer: string | null): {
  prompts: string[];
  /** title/description of each prompt, for the wording assertions. */
  asked: { title: string; description?: string }[];
  off: () => void;
} {
  const prompts: string[] = [];
  const asked: { title: string; description?: string }[] = [];
  const off = subscribeSaveDialogs(() => {
    const pending = getPendingSaveDialog();
    if (pending?.kind === 'name') {
      prompts.push('asked');
      asked.push({ title: pending.title, description: pending.description });
      (pending as unknown as { resolve: (v: unknown) => void }).resolve(answer);
    }
  });
  return { prompts, asked, off };
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
  // The pending slot is per DOCUMENT and keyed by name, so a prompt a previous
  // test left open would make the next one answer `busy` instead of asking.
  resetSaveDialogsForTests();
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

describe('"Untitled" is a name, not a state (field decision 2026-08-19)', () => {
  it('a document called Untitled saves in place, silently, like any other', async () => {
    const base = documentBase('doc_new', 'Untitled', 'Untitled.glb');
    const { ctx, doc, saved } = context('Untitled', base);
    const { prompts, off } = watchNamePrompts('never used');
    try {
      expect(await runSaveFlow(ctx)).toBe(true);
    } finally { off(); }

    expect(prompts).toEqual([]);                     // NO prompt — the name is a name
    expect(doc.name).toBe('Untitled');               // and it stays the document's name
    expect(writes).toEqual(['Untitled.glb']);        // bytes to the document's path
    expect(saved[0]).toEqual({
      base: { kind: 'document', documentId: 'doc_new', path: 'Untitled.glb', name: 'Untitled' },
      name: 'Untitled',
    });
  });

  it('a document with NO name at all still asks, and cancelling writes nothing', async () => {
    const base = documentBase('doc_new', '', 'part.glb');
    const { ctx, saved } = context('', base);
    const { prompts, off } = watchNamePrompts(null);
    try {
      expect(await runSaveFlow(ctx)).toBe(false);
    } finally { off(); }
    expect(prompts).toEqual(['asked']);              // empty string = a real state
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

describe('the bound-save guard matches by document IDENTITY (field finding 2026-08-18)', () => {
  /**
   * A document workspace opens with `saved = null` — only a scene-side save in
   * the SAME session fills it. The guard therefore may not key on `saved.id`
   * alone: the mode-transition bind compared `documentIdentity()`, and a save
   * of the very document that bind just handed over was refused as "not the
   * scene that is open" until the planner had saved once.
   */
  function identityStoreFor(identityId: string | null, savedId: string | null) {
    return {
      lineage: 'scene' as const,
      getSnapshot: () => ({
        draft: { name: 'Line' },
        saved: savedId ? { id: savedId } : null,
        isDraft: false,
        dirty: true,
        transient: false,
      }),
      documentIdentity: () =>
        identityId ? documentBase(identityId, 'Line', 'Line.glb') : null,
      save: async () => { h.sceneSaves++; return 'saved' as const; },
      saveAs: async () => { throw new Error('saveAs must not be reached'); },
    };
  }

  it('saves a bound document that was never scene-saved this session (saved = null)', async () => {
    const base = documentBase('doc_line', 'Line', 'Line.glb');
    const { viewer, doc } = context('Line', base, { bound: true });
    h.sceneStore = identityStoreFor('doc_line', null);   // identity matches, saved empty

    const result = await saveDocument(viewer as never, doc as never);

    expect(h.sceneSaves).toBe(1);                    // the scene writer ran
    expect(writes).toEqual([]);                      // the asset writer did NOT
    expect(result).toEqual({
      kind: 'saved', base, relPath: 'Line.glb', copied: false,
    });
  });

  it('still blocks when the identity names ANOTHER document and saved is empty', async () => {
    const base = documentBase('doc_line', 'Line', 'Line.glb');
    const { viewer, doc } = context('Line', base, { bound: true });
    h.sceneStore = identityStoreFor('doc_other', null);

    const result = await saveDocument(viewer as never, doc as never);

    expect(result.kind).toBe('blocked');
    expect(h.sceneSaves).toBe(0);
    expect(writes).toEqual([]);
  });

  it('still blocks when the store can state no identity at all', async () => {
    const base = documentBase('doc_line', 'Line', 'Line.glb');
    const { viewer, doc } = context('Line', base, { bound: true });
    h.sceneStore = identityStoreFor(null, null);     // fork/transient: identity null

    const result = await saveDocument(viewer as never, doc as never);

    expect(result.kind).toBe('blocked');
    expect(h.sceneSaves).toBe(0);
  });

  it('a facade WITHOUT documentIdentity still routes by saved.id (legacy shape)', async () => {
    const base = documentBase('doc_line', 'Line', 'Line.glb');
    const { viewer, doc } = context('Line', base, { bound: true });
    h.sceneStore = {                                 // the plain facade shape
      lineage: 'scene' as const,
      getSnapshot: () => ({
        draft: { name: 'Line' }, saved: { id: 'doc_line' },
        isDraft: false, dirty: true, transient: false,
      }),
      save: async () => { h.sceneSaves++; return 'saved' as const; },
      saveAs: async () => { throw new Error('saveAs must not be reached'); },
    };

    const result = await saveDocument(viewer as never, doc as never);

    expect(h.sceneSaves).toBe(1);
    expect(result.kind).toBe('saved');
  });
});

describe('the name prompt says WHY it is open (field finding 2026-08-18)', () => {
  /**
   * The prompt has three reasons — Save as…, a read-only source, a document
   * with no name of its own — and the dialog used to show the read-only copy
   * sentence for all of them. A user saving their OWN new document was told
   * "This asset is read-only", which is false on every word. The flow now
   * passes the sentence that matches the reason; the store carries it.
   */
  it('a NAMELESS own document asks under "Save", not "Save into project"', async () => {
    const base = documentBase('doc_new', '', 'part.glb');
    const { ctx } = context('', base);
    const { asked, off } = watchNamePrompts('Mill');
    try {
      expect(await runSaveFlow(ctx)).toBe(true);
    } finally { off(); }

    expect(asked).toEqual([{
      title: 'Save',
      description: 'Name this asset to save it into your project.',
    }]);
  });

  it('"Save as…" on an own document says it makes a copy', async () => {
    const base = documentBase('doc_belt', 'Belt', 'Belt.glb');
    const { ctx } = context('Belt', base);
    const { asked, off } = watchNamePrompts('Belt Copy');
    try {
      expect(await runSaveFlow(ctx, { forceNamePrompt: true })).toBe(true);
    } finally { off(); }

    expect(asked).toEqual([{
      title: 'Save as',
      description: 'Saves a copy of this asset as a new library asset in your project.',
    }]);
  });

  it('a prompt WITHOUT a description keeps the read-only default in the dialog', async () => {
    // The store-level contract for every caller that does not pass one — the
    // dialog component renders `description ?? <read-only sentence>`, so a
    // catalog/builtin copy keeps exactly the wording it had.
    const { askSaveName } = await import('../src/core/hmi/scene/save-dialog-store');
    const p = askSaveName({ documentKey: 'k', initial: '' });
    const pending = getPendingSaveDialog();
    expect(pending?.kind).toBe('name');
    expect((pending as { description?: string }).description).toBeUndefined();
    (pending as unknown as { resolve: (v: unknown) => void }).resolve(null);
    await p;
  });
});
