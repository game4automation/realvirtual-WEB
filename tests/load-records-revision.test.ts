// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-710 §9.7 / F6 — the compare-and-swap token starts at the LOAD.
 *
 * plan-709 gave every write an `expectedRevision` and named the gap it did not
 * close, in its own module header: "a change made by ANOTHER TAB before this
 * session's first save of a path is not detected, because nothing records a
 * revision at load time yet."
 *
 * That gap had teeth. The first save formed its precondition by reading the
 * file *at save time* — so if another tab had written in the meantime, this tab
 * read THEIR bytes, adopted their revision as its own expectation, and the
 * compare-and-swap passed. The one mechanism meant to prevent silent
 * overwriting waved the silent overwrite through, and only for the case it was
 * most needed: the user who opened a file, worked on it, and saved once.
 *
 * `noteLoadedRevision()` closes it, and these tests are the difference:
 *   1. what was LOADED becomes the first save's expectation;
 *   2. a foreign write between load and first save is a CONFLICT, and the
 *      stored bytes stay the other writer's;
 *   3. the later saves plan-709 already covered keep working from what this
 *      session wrote last.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => ({
  /** Project path → stored text. The whole "disk" of these tests. */
  files: new Map<string, string>(),
  projectId: 'prj_one' as string | null,
}));

vi.mock('../src/core/project/project-store', () => ({
  getProjectStore: () => store,
}));

vi.mock('../src/core/editor/rv-asset-glb-export', async (original) => {
  const actual = await original<typeof import('../src/core/editor/rv-asset-glb-export')>();
  return {
    ...actual,
    exportAssetGlb: async (_root: unknown, name?: string) =>
      new TextEncoder().encode(`GLB:${name}`).buffer,
  };
});

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
    async readBlobBytes(relPath: string) {
      const value = h.files.get(relPath);
      if (value === undefined) return null;
      return new TextEncoder().encode(value).buffer;
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

import {
  saveDocument,
  noteLoadedRevision,
  forgetSavedRevisions,
} from '../src/core/editor/rv-save-document';
import { revisionOfBytes } from '../src/core/project/rv-scene-record';
import type { AssetBase } from '../src/core/editor/rv-asset-document';
import {
  libraryDocumentBase,
} from '../src/core/editor/active-asset-store';

async function revisionOf(value: string): Promise<string> {
  return revisionOfBytes(new TextEncoder().encode(value));
}

// ─── Doubles ──────────────────────────────────────────────────────────────

function makeDoc(base: AssetBase, name = 'Belt') {
  const doc = {
    name,
    base,
    dirty: true,
    document: {
      opCount: 3,
      runExclusive<T>(work: () => Promise<T>): Promise<T> { return work(); },
      markSaved(): void {},
    },
    async markSaved(next: AssetBase): Promise<void> { doc.base = next; },
  };
  return doc;
}

function makeViewer() {
  return {
    currentModelRoot: { name: 'Belt' },
    renderer: {},
    scene: {},
    emit: () => {},
    getPlugin: () => undefined,
  };
}

const save = (doc: ReturnType<typeof makeDoc>) =>
  saveDocument(makeViewer() as never, doc as never, {});

const LIB_PATH = 'library/Custom/Belt.glb';
const libraryBase: AssetBase = libraryDocumentBase('Custom/Belt.glb');

beforeEach(() => {
  h.files.clear();
  h.projectId = 'prj_one';
  backend = makeBackend('backend-1');
  writes.length = 0;
  forgetSavedRevisions();
});

// ─── The fix ──────────────────────────────────────────────────────────────

describe('the load records the revision (F6)', () => {
  it('the FIRST save is checked against what was loaded', async () => {
    h.files.set(LIB_PATH, 'ORIGINAL');
    const loadedRevision = await revisionOf('ORIGINAL');

    await noteLoadedRevision(backend as never, LIB_PATH);
    const result = await save(makeDoc(libraryBase));

    expect(result.kind).toBe('saved');
    expect(writes).toHaveLength(1);
    // Not "whatever was there when I got round to saving" — what the user
    // actually opened.
    expect(writes[0].expected).toBe(loadedRevision);
  });

  it('a foreign write between load and first save is a CONFLICT, not an overwrite', async () => {
    h.files.set(LIB_PATH, 'ORIGINAL');
    await noteLoadedRevision(backend as never, LIB_PATH);

    // Another tab (or an editor in the project folder) commits first.
    h.files.set(LIB_PATH, 'SOMEBODY ELSE');

    const result = await save(makeDoc(libraryBase));

    expect(result.kind).toBe('conflict');
    // The decisive assertion: THEIR bytes are still there. Before this fix the
    // save read those very bytes to build its own precondition and wrote over
    // them, reporting success.
    expect(h.files.get(LIB_PATH)).toBe('SOMEBODY ELSE');
  });

  it('without a recorded load the pre-plan-710 behaviour still applies', async () => {
    // The path this session never read — a copy into a fresh name, an import,
    // anything that was not opened. The precondition is then formed from the
    // stored bytes, which is exactly the plan-709 fallback and is safe *inside*
    // this tab through the per-backend write queue.
    h.files.set(LIB_PATH, 'ORIGINAL');
    const result = await save(makeDoc(libraryBase));

    expect(result.kind).toBe('saved');
    expect(writes[0].expected).toBe(await revisionOf('ORIGINAL'));
  });

  it('a path that holds nothing writes create-only, never unconditionally', async () => {
    await noteLoadedRevision(backend as never, LIB_PATH);   // nothing stored yet
    const result = await save(makeDoc(libraryBase));

    expect(result.kind).toBe('saved');
    // `null` — "expect nothing to be there" — is a precondition of its own, and
    // is what stops a create from silently replacing a file that appeared in
    // between.
    expect(writes[0].expected).toBeNull();
  });

  it('later saves keep chaining on what this session wrote last', async () => {
    h.files.set(LIB_PATH, 'ORIGINAL');
    await noteLoadedRevision(backend as never, LIB_PATH);

    const doc = makeDoc(libraryBase);
    await save(doc);
    const afterFirst = await revisionOf(h.files.get(LIB_PATH)!);

    writes.length = 0;
    await save(doc);

    expect(writes[0].expected).toBe(afterFirst);
  });

  it('never fails an open: an unreadable path leaves the ledger empty', async () => {
    const broken = {
      ...makeBackend('backend-broken'),
      readBlobBytes: async () => { throw new Error('disk went away'); },
    };
    // The load must not blow up because a revision could not be taken — a
    // missing CAS token degrades to plan-709 behaviour, never to a failed open.
    await expect(noteLoadedRevision(broken as never, LIB_PATH)).resolves.toBeUndefined();
  });

  it('a revision from one backend is never handed to another', async () => {
    h.files.set(LIB_PATH, 'ORIGINAL');
    await noteLoadedRevision(backend as never, LIB_PATH);

    // A project switch replaces the backend object. Its entries stop matching
    // rather than leaking a revision from one project into a write against
    // another — the ledger is keyed by backend id for exactly this.
    backend = makeBackend('backend-2');
    h.files.set(LIB_PATH, 'DIFFERENT PROJECT, SAME PATH');

    const result = await save(makeDoc(libraryBase));
    // Re-read under the new backend, so this succeeds rather than reporting a
    // phantom conflict against the OTHER project's revision.
    expect(result.kind).toBe('saved');
  });
});
