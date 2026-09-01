// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-709 §2.2/§2.4/§9.2 — `saveDocument()` routes by IDENTITY, and survives
 * a save button the user can press at any moment.
 *
 * Two halves, and the second is the one the plan calls the risk:
 *
 *  1. **Routing.** Where the bytes go is decided by what the open document IS,
 *     not by which mode is active: a project document to its own path, a
 *     library asset to `library/<relPath>`, a source that cannot be written
 *     back to a COPY in the project (§2.4) — announced by the verb before the
 *     click, never as a surprise afterwards.
 *  2. **Concurrency.** Until this plan a save only ever ran from the exit
 *     dialog, which had sequenced everything before it. That accident is gone,
 *     so the guarantees are asserted: the destination is bound at the start and
 *     verified at the end, a second click during a save is a no-op, a clean
 *     document is a true no-op that mints no new identity, and a conflict is
 *     reported instead of overwriting somebody else's bytes.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => ({
  /** Project path → stored text. The whole "disk" of these tests. */
  files: new Map<string, string>(),
  /** Swapped in mid-write by the project-switch test. */
  currentBackendId: 'backend-1',
  projectId: 'prj_one' as string | null,
  /** Resolves when the next writeBlob is allowed to complete. */
  gate: null as null | (() => void),
}));

vi.mock('../src/core/project/project-store', () => ({
  getProjectStore: () => store,
}));

// The exporter is mocked to keep this a routing test — but it is mocked around
// the REAL module, so the assertion "the export that prunes composed references
// is the one that ran" (§9.6's Lauf-11 guarantee) stays meaningful.
const exportSpy = vi.fn();
vi.mock('../src/core/editor/rv-asset-glb-export', async (original) => {
  const actual = await original<typeof import('../src/core/editor/rv-asset-glb-export')>();
  return {
    ...actual,
    exportAssetGlb: async (root: unknown, name?: string) => {
      exportSpy(root, name);
      return new TextEncoder().encode(`GLB:${name}`).buffer;
    },
  };
});

// Thumbnails need a WebGL renderer; they are best-effort in the code and noise
// here. Rendering `null` is the documented WebGPU path — no thumbnail write.
vi.mock('../src/core/thumbnails/thumbnail-renderer', () => ({
  ThumbnailRenderer: class {
    render(): string | null { return null; }
    dispose(): void {}
  },
}));

const writes: { path: string; expected: string | null | undefined }[] = [];

function makeBackend(id: string) {
  return {
    kind: 'browser' as const,
    id,
    writable: true,
    isActive: true,
    async writeBlob(relPath: string, blob: Blob, opts?: { expectedRevision?: string | null }) {
      if (h.gate) {
        await new Promise<void>(resolve => { h.gate = resolve; });
      }
      const actual = h.files.has(relPath) ? await revisionOf(h.files.get(relPath)!) : null;
      const expected = opts?.expectedRevision;
      if (expected !== undefined && (expected ?? null) !== actual) {
        const { SceneRevisionConflictError } =
          await import('../src/core/project/rv-scene-record');
        throw new SceneRevisionConflictError(relPath, expected ?? null, actual);
      }
      writes.push({ path: relPath, expected });
      h.files.set(relPath, await blob.text());
    },
    async readBlobUrl(relPath: string) {
      const value = h.files.get(relPath);
      if (value === undefined) return null;
      const url = URL.createObjectURL(new Blob([value]));
      return { url, release: () => URL.revokeObjectURL(url) };
    },
    async listDocuments() {
      return [...h.files.keys()].map((path, i) => ({ id: `doc-${i}`, name: path, path }));
    },
  };
}

let backend = makeBackend('backend-1');

const store = {
  getBackend: () => backend,
  getProject: () => (h.projectId ? { id: h.projectId, documents: [] } : null),
};

import { saveDocument, decideSaveVerb, forgetSavedRevisions } from '../src/core/editor/rv-save-document';
import { revisionOfBytes } from '../src/core/project/rv-scene-record';
import type { AssetBase } from '../src/core/editor/rv-asset-document';
import {
  libraryDocumentBase,
  projectDocumentBase,
} from '../src/core/editor/active-asset-store';

async function revisionOf(value: string): Promise<string> {
  return revisionOfBytes(new TextEncoder().encode(value));
}

// ─── Doubles ──────────────────────────────────────────────────────────────

interface FakeDoc {
  name: string;
  base: AssetBase;
  dirty: boolean;
  markSavedCalls: { base: AssetBase; name?: string }[];
  document: {
    opCount: number;
    runExclusive<T>(work: () => Promise<T>): Promise<T>;
    markSaved(opts?: { floor?: number }): void;
    savedFloors: number[];
  };
  markSaved(base: AssetBase, name?: string): Promise<void>;
}

function makeDoc(base: AssetBase, name = 'Belt', dirty = true): FakeDoc {
  const markSavedCalls: FakeDoc['markSavedCalls'] = [];
  const doc: FakeDoc = {
    name,
    base,
    dirty,
    markSavedCalls,
    document: {
      opCount: 3,
      savedFloors: [] as number[],
      runExclusive<T>(work: () => Promise<T>): Promise<T> { return work(); },
      markSaved(opts?: { floor?: number }) {
        if (opts?.floor !== undefined) doc.document.savedFloors.push(opts.floor);
      },
    },
    async markSaved(next: AssetBase, n?: string) {
      markSavedCalls.push({ base: next, name: n });
      doc.base = next;
    },
  };
  return doc;
}

function makeViewer() {
  const emitted: string[] = [];
  return {
    emitted,
    currentModelRoot: { name: 'Belt' },
    renderer: {},
    scene: {},
    emit: (event: string) => { emitted.push(event); },
    getPlugin: () => undefined,
  };
}

const save = (doc: FakeDoc, viewer = makeViewer(), opts = {}) =>
  saveDocument(viewer as never, doc as never, opts);

beforeEach(() => {
  h.files.clear();
  h.projectId = 'prj_one';
  h.gate = null;
  backend = makeBackend('backend-1');
  writes.length = 0;
  exportSpy.mockClear();
  forgetSavedRevisions();
});

// ─── The verb, before the click ───────────────────────────────────────────

describe('decideSaveVerb', () => {
  it('routes each identity to its own origin', () => {
    expect(decideSaveVerb(
      {
        lineage: 'asset',
        base: projectDocumentBase('models/Cell.glb', 'Cell'),
        name: 'Cell',
      },
      backend as never,
    )).toMatchObject({ verb: 'save', relPath: 'models/Cell.glb' });

    expect(decideSaveVerb(
      {
        lineage: 'asset',
        base: libraryDocumentBase('Custom/Belt.glb'),
        name: 'Belt',
      },
      backend as never,
    )).toMatchObject({ verb: 'save', relPath: 'library/Custom/Belt.glb' });
  });

  it('announces the COPY before the click for a source that cannot be written back', () => {
    const decision = decideSaveVerb(
      {
        lineage: 'asset',
        base: { kind: 'builtinModel', url: '/models/Demo.glb', name: 'Demo' },
        name: 'Demo',
      },
      backend as never,
    );
    expect(decision.verb).toBe('save-into-project');
    expect(decision.copies).toBe(true);
    expect(decision.relPath).toBe('models/Demo.glb');
  });

  it('is blocked — with a reason — when there is nowhere to write', () => {
    // Any identity does here: the refusal is about the PROJECT, not the
    // document, which is exactly why both lineages share these three sentences.
    const someDocument = projectDocumentBase('models/Cell.glb', 'Cell');
    expect(decideSaveVerb(
      { lineage: 'asset', base: someDocument, name: 'X' }, null,
    )).toMatchObject({ verb: 'blocked' });
    const readOnly = { ...backend, writable: false, kind: 'bundled' as const };
    const decision = decideSaveVerb(
      { lineage: 'asset', base: someDocument, name: 'X' }, readOnly as never,
    );
    expect(decision.verb).toBe('blocked');
    expect(decision.reason).toMatch(/ships with the application/i);
  });

  /**
   * plan-710 F5 — the scene lineage asks the SAME function.
   *
   * The point of the merge is not that a scene can be routed, it is that the
   * refusals cannot drift: these are the identical sentences the asset cases
   * above assert, produced by one switch instead of two.
   */
  it('answers for the scene lineage out of the same refusals', () => {
    expect(decideSaveVerb({ lineage: 'scene', open: false, transient: false }, backend as never))
      .toMatchObject({ verb: 'blocked', reason: 'Nothing is open.' });

    expect(decideSaveVerb({ lineage: 'scene', open: true, transient: false }, null))
      .toMatchObject({ verb: 'blocked', reason: /No project is open/ });

    const readOnly = { ...backend, writable: false, kind: 'bundled' as const };
    expect(decideSaveVerb({ lineage: 'scene', open: true, transient: false }, readOnly as never))
      .toMatchObject({ verb: 'blocked', reason: /ships with the application/i });

    expect(decideSaveVerb({ lineage: 'scene', open: true, transient: true }, backend as never))
      .toMatchObject({ verb: 'blocked', reason: /holds shared content/i });

    // A saveable scene carries no relPath: it is addressed by slot, not path.
    expect(decideSaveVerb({ lineage: 'scene', open: true, transient: false }, backend as never))
      .toEqual({ verb: 'save' });
  });
});

// ─── Routing ──────────────────────────────────────────────────────────────

describe('saveDocument — routing by identity', () => {
  it('a project document is written back to its own path, under a precondition', async () => {
    h.files.set('models/Cell.glb', 'old bytes');
    const doc = makeDoc(projectDocumentBase('models/Cell.glb', 'Cell'), 'Cell');

    const result = await save(doc);

    expect(result.kind).toBe('saved');
    expect(writes).toHaveLength(1);
    expect(writes[0].path).toBe('models/Cell.glb');
    // The compare-and-swap token: the revision of what was there before.
    expect(writes[0].expected).toBe(await revisionOf('old bytes'));
    expect(h.files.get('models/Cell.glb')).toBe('GLB:Cell');
  });

  it('a library asset is written to library/<relPath>, identity unchanged', async () => {
    h.files.set('library/Custom/Belt.glb', 'old');
    const doc = makeDoc(libraryDocumentBase('Custom/Belt.glb'));

    const result = await save(doc);

    expect(writes[0].path).toBe('library/Custom/Belt.glb');
    expect(result.kind === 'saved' && result.base).toEqual(libraryDocumentBase('Custom/Belt.glb'));
    expect(result.kind === 'saved' && result.copied).toBe(false);
  });

  /**
   * plan-719 F2/F3 — what this test used to say went with the case it
   * described. There is no "new Untitled asset" that has to invent a home at
   * its first save: a document is created WITH a path before the editor opens
   * it. The prompt that survived is the one for a READ-ONLY source, and this
   * is its routing half — the copy lands under the name the user confirmed,
   * and it becomes a document, which is what makes every later save silent.
   */
  it('a read-only source is copied in under the confirmed name', async () => {
    const doc = makeDoc(
      { kind: 'builtinModel', url: '/models/Demo.glb', name: 'Demo' }, 'Demo');
    const result = await save(doc, makeViewer(), { requestName: async () => 'Gripper' });
    expect(writes[0].path).toBe('models/Gripper.glb');
    expect(result.kind === 'saved' && result.base)
      .toMatchObject({ kind: 'document', path: 'models/Gripper.glb' });
    expect(result.kind === 'saved' && result.copied).toBe(true);
  });

  it('"Save as…" still names a NEW asset in the project Custom library', async () => {
    const doc = makeDoc(libraryDocumentBase('Custom/Belt.glb'));
    const result = await save(doc, makeViewer(), {
      forceNamePrompt: true, requestName: async () => 'Gripper',
    });
    expect(writes[0].path).toBe('library/Custom/Gripper.glb');
    expect(result.kind === 'saved' && result.base)
      .toMatchObject({ kind: 'document', path: 'library/Custom/Gripper.glb' });
  });

  it('goes through the exporter that prunes composed references (§9.6)', async () => {
    // The Lauf-11 fix lives inside `exportAssetGlb` (it runs
    // `pruneComposedReferenceSubtrees` first). The one way the new save path
    // could reintroduce reference melting is by exporting some OTHER way, so
    // what is pinned here is that this is the exporter it uses.
    const doc = makeDoc(libraryDocumentBase('Custom/Belt.glb'));
    const viewer = makeViewer();
    await save(doc, viewer);
    expect(exportSpy).toHaveBeenCalledWith(viewer.currentModelRoot, 'Belt');
    // …and live previews were told to restore BEFORE the clone.
    expect(viewer.emitted).toContain('asset-editor-pre-export');
  });

  it('is blocked, not silently failing, when nothing can be written', async () => {
    backend = { ...makeBackend('ro'), writable: false } as never;
    const doc = makeDoc(libraryDocumentBase('Custom/Belt.glb'));
    const result = await save(doc);
    expect(result.kind).toBe('blocked');
    expect(writes).toHaveLength(0);
  });
});

// ─── §2.4 — read-only source becomes a copy in the project ────────────────

/**
 * plan-719 F2 changed HOW this copy is reached, not what it produces: the
 * destination is confirmed in one "Save into project as…" prompt instead of
 * being chosen silently. Every assertion below is unchanged; what each test
 * gained is the `requestName` that answers that prompt. A save with no way to
 * ask is now `blocked` rather than a silent copy, which is pinned separately
 * in `save-into-project-prompt.test.ts`.
 */
const confirmName = (name: string) => ({ requestName: async () => name });

describe('saveDocument — "save into project" (§2.4)', () => {
  it('copies under models/ and MOVES the identity onto the copy', async () => {
    const doc = makeDoc({ kind: 'builtinModel', url: '/models/Demo.glb', name: 'Demo' }, 'Demo');

    const result = await save(doc, makeViewer(), confirmName('Demo'));

    expect(writes[0].path).toBe('models/Demo.glb');
    // "create only" — the copy must never land on top of an existing document.
    expect(writes[0].expected).toBeNull();
    expect(result.kind === 'saved' && result.copied).toBe(true);
    // The session continues on the copy: identity, breadcrumb and draft
    // keyspace all follow, which is what handing the new base to `markSaved`
    // does (§2.4).
    expect(doc.markSavedCalls[0].base).toEqual(projectDocumentBase('models/Demo.glb', 'Demo'));
    expect(doc.base).toMatchObject({ kind: 'document', path: 'models/Demo.glb' });
  });

  it('deduplicates the target name instead of overwriting a namesake', async () => {
    h.files.set('models/Demo.glb', 'somebody else');
    const doc = makeDoc({ kind: 'builtinModel', url: '/models/Demo.glb', name: 'Demo' }, 'Demo');

    const result = await save(doc, makeViewer(), confirmName('Demo'));

    expect(result.kind === 'saved' && result.relPath).toBe('models/Demo_1.glb');
    // The namesake is untouched — the whole point of the dedup.
    expect(h.files.get('models/Demo.glb')).toBe('somebody else');
  });

  it('a catalog asset is a copy too — its source cannot be written back', async () => {
    const doc = makeDoc({
      kind: 'providerAsset', providerId: 'p', sourceId: 's', assetId: 'a', label: 'Roller',
    } as AssetBase, 'Roller');
    const result = await save(doc, makeViewer(), confirmName('Roller'));
    expect(result.kind === 'saved' && result.copied).toBe(true);
    expect(writes[0].path).toBe('models/Roller.glb');
  });

  /**
   * F2's other half, stated where the routing lives: without a way to ask, the
   * copy does NOT happen. A silent copy was the old behaviour, and reverting
   * to it "just for callers that cannot prompt" would put the surprise back
   * for exactly the callers least able to notice it.
   */
  it('refuses to copy silently when there is no way to ask', async () => {
    const doc = makeDoc({ kind: 'builtinModel', url: '/models/Demo.glb', name: 'Demo' }, 'Demo');
    const result = await save(doc);
    expect(result.kind).toBe('blocked');
    expect(writes).toHaveLength(0);
  });
});

// ─── §2.2.1 — the concurrency rules ───────────────────────────────────────

describe('saveDocument — binding and reihung (§2.2.1)', () => {
  it('a clean document is a TRUE no-op and mints no new identity', async () => {
    h.files.set('library/Custom/Belt.glb', 'stored');
    const doc = makeDoc(
      libraryDocumentBase('Custom/Belt.glb'), 'Belt', false);

    const result = await save(doc);

    expect(result.kind).toBe('no-op');
    expect(writes).toHaveLength(0);
    expect(doc.markSavedCalls).toHaveLength(0);
  });

  it('a second click while a save runs is a no-op, not a second writer', async () => {
    const doc = makeDoc(libraryDocumentBase('Custom/Belt.glb'));
    h.gate = () => {};                       // arm: the next write blocks
    const first = save(doc);
    await Promise.resolve();

    const second = await save(doc);
    expect(second.kind).toBe('busy');

    h.gate?.();                              // let the first one finish
    h.gate = null;
    expect((await first).kind).toBe('saved');
    expect(writes).toHaveLength(1);
  });

  it('declares saved only the ops that were in the file — the floor before the bake', async () => {
    const doc = makeDoc(libraryDocumentBase('Custom/Belt.glb'));
    doc.document.opCount = 7;
    await save(doc);
    expect(doc.document.savedFloors).toEqual([7]);
  });

  it('discards the result when the PROJECT changed while writing', async () => {
    const doc = makeDoc(libraryDocumentBase('Custom/Belt.glb'));
    h.gate = () => {};
    const pending = save(doc);
    await Promise.resolve();

    h.projectId = 'prj_two';                 // the user opened another project
    h.gate?.();
    h.gate = null;

    const result = await pending;
    expect(result.kind).toBe('target-changed');
    // Nothing is entered into the project the user moved to.
    expect(doc.markSavedCalls).toHaveLength(0);
  });

  it('discards the result when the BACKEND was replaced while writing', async () => {
    const doc = makeDoc(libraryDocumentBase('Custom/Belt.glb'));
    h.gate = () => {};
    const pending = save(doc);
    await Promise.resolve();

    backend = makeBackend('backend-2');      // `_adoptProject` swaps the instance
    h.gate?.();
    h.gate = null;

    expect((await pending).kind).toBe('target-changed');
    expect(doc.markSavedCalls).toHaveLength(0);
  });

  it('reports a revision conflict instead of overwriting the other write', async () => {
    h.files.set('models/Cell.glb', 'v1');
    const doc = makeDoc(projectDocumentBase('models/Cell.glb', 'Cell'), 'Cell');

    // First save: learns the revision.
    expect((await save(doc)).kind).toBe('saved');
    // Somebody else replaces the file behind our back.
    h.files.set('models/Cell.glb', 'theirs');

    doc.dirty = true;
    const result = await save(doc);

    expect(result.kind).toBe('conflict');
    expect(h.files.get('models/Cell.glb')).toBe('theirs');   // untouched
    expect(doc.markSavedCalls).toHaveLength(1);              // only the first save
  });
});
