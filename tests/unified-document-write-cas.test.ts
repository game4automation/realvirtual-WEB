// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-736 §9.1 — `writeDocument` is ONE protocol with a MANDATORY
 * compare-and-swap, in every backend or in none.
 *
 * ## What this file was, and what changed about its contract
 *
 * It was `write-blob-cas.contract.test.ts`, and its first property was
 * "**without `opts` nothing changes** — same single write, same overwrite".
 * That property was the whole point of plan-709: the precondition had to be
 * addable without touching a single existing caller, so its default had to be
 * "unconditional".
 *
 * plan-736 deliberately breaks it. The default was doing real harm — every
 * caller that had simply never thought about concurrency got the unsafe mode by
 * accident, and the manifest's `section` field decided which of two write
 * protocols a document even went through. There is now one
 * `writeDocument(ref, bytes, { expectedRevision })`, the field is required, and
 * "unconditional" has to be *said* (`'any'`). This is a contract change, not a
 * regression: the assertion below no longer says "no opts means overwrite", it
 * says "`'any'` means overwrite, and there is no way to avoid stating which you
 * meant".
 *
 * ## Why it stays a contract test
 *
 * Adding a guarantee to one backend and forgetting another is worse than not
 * adding it, because callers start trusting something that holds on Chromium
 * and silently does not on Safari. So: one `describe.each` over every
 * implementation, each with the shared fixture that constructs it (the three
 * have genuinely different construction — a project id, a directory handle, a
 * fetch root).
 *
 * Four properties:
 *
 *  1. **`'any'`** overwrites, and costs no extra read;
 *  2. **a revision that no longer holds** is REFUSED and the stored bytes are
 *     untouched — not overwritten, not truncated;
 *  3. **`'create'`** (the mode every migration and every free-name probe needs)
 *     makes an existing path a conflict rather than a silent replacement;
 *  4. **a scene body and a library body behave identically** — the property
 *     that used to be false, because a scene went through `writeScene` and
 *     everything else through `writeBlob`.
 *
 * Plus the serialisation the CAS cannot provide on its own (§2.2.1-3): two
 * concurrent writes to two DIFFERENT paths must both end up addressable. That
 * is the browser backend's non-atomic index read-modify-write, and it is the
 * reason the write queue lives on the backend instance.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FakeDir, asDirHandle } from './helpers/fake-fs-handles';
import { BrowserBackend, browserBlobIndexKey } from '../src/core/project/backends/browser-backend';
import { FolderBackend } from '../src/core/project/backends/folder-backend';
import { BundledBackend } from '../src/core/project/backends/bundled-backend';
import {
  BackendNotWritableError,
  type ProjectBackend,
} from '../src/core/project/backends/project-backend';
import {
  revisionOfBytes,
  SceneRevisionConflictError,
} from '../src/core/project/rv-scene-record';
import { clearAllBlobs } from '../src/core/storage/rv-opfs-blobs';


// ─── The shared construction fixture (§9.8: "braucht einen neuen Helfer") ──

interface BackendFixture {
  /** An ACTIVATED backend — the only state in which writes are allowed. */
  open(): Promise<ProjectBackend>;
  /** Bytes stored at `relPath`, or null. Reads through the backend's own eyes. */
  read(backend: ProjectBackend, relPath: string): Promise<string | null>;
  reset(): Promise<void>;
}

const PROJECT_ID = 'prj_cas_contract';

const browserFixture: BackendFixture = {
  async open() {
    const backend = new BrowserBackend(PROJECT_ID, { requestPersistence: false });
    await backend.activate();
    return backend;
  },
  async read(backend, relPath) {
    const resolved = await backend.readDocumentUrl(relPath);
    if (!resolved) return null;
    try {
      return await (await fetch(resolved.url)).text();
    } finally { resolved.release(); }
  },
  async reset() {
    localStorage.removeItem(browserBlobIndexKey(PROJECT_ID));
    await clearAllBlobs();
  },
};

let folderRoot = new FakeDir('customer');

const folderFixture: BackendFixture = {
  async open() {
    const backend = new FolderBackend(asDirHandle(folderRoot), { writable: true });
    await backend.activate();
    return backend;
  },
  async read(backend, relPath) {
    const resolved = await backend.readDocumentUrl(relPath);
    if (!resolved) return null;
    try {
      return await (await fetch(resolved.url)).text();
    } finally { resolved.release(); }
  },
  async reset() { folderRoot = new FakeDir('customer'); },
};

const bundledFixture: BackendFixture = {
  async open() {
    const backend = new BundledBackend({
      fetchImpl: (async () => ({ ok: false, status: 404 })) as unknown as typeof fetch,
    });
    await backend.activate();
    return backend;
  },
  async read() { return null; },
  async reset() {},
};

function text(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

async function revisionOf(value: string): Promise<string> {
  return revisionOfBytes(new TextEncoder().encode(value));
}

// ─── The two writable backends share every property ───────────────────────

describe.each([
  ['browser', browserFixture],
  ['folder', folderFixture],
] as const)('writeDocument contract — %s backend', (_name, fixture) => {
  beforeEach(async () => { await fixture.reset(); });
  afterEach(async () => { await fixture.reset(); });

  it("'any': writes, and overwrites — the mode that must now be stated", async () => {
    const backend = await fixture.open();
    await backend.writeDocument('library/Custom/Belt.glb', text('one'), { expectedRevision: 'any' });
    expect(await fixture.read(backend, 'library/Custom/Belt.glb')).toBe('one');

    // `'any'` is last-writer-wins — the old no-opts default, except that a
    // caller now has to write it down, which is the point of the change.
    await backend.writeDocument('library/Custom/Belt.glb', text('two'), { expectedRevision: 'any' });
    expect(await fixture.read(backend, 'library/Custom/Belt.glb')).toBe('two');
  });

  it('accepts a write whose expected revision still holds', async () => {
    const backend = await fixture.open();
    await backend.writeDocument('models/Press.glb', text('v1'), { expectedRevision: 'any' });

    await backend.writeDocument('models/Press.glb', text('v2'), { expectedRevision: await revisionOf('v1') });
    expect(await fixture.read(backend, 'models/Press.glb')).toBe('v2');
  });

  it('REFUSES a write whose basis somebody else replaced, and keeps their bytes', async () => {
    const backend = await fixture.open();
    await backend.writeDocument('models/Press.glb', text('mine'), { expectedRevision: 'any' });
    const stale = await revisionOf('mine');

    // Somebody else (another verb, another tab) got there first.
    await backend.writeDocument('models/Press.glb', text('theirs'), { expectedRevision: 'any' });

    await expect(
      backend.writeDocument('models/Press.glb', text('mine again'), { expectedRevision: stale }),
    ).rejects.toBeInstanceOf(SceneRevisionConflictError);
    // The point of the refusal: their bytes are still there.
    expect(await fixture.read(backend, 'models/Press.glb')).toBe('theirs');
  });

  it("'create' means CREATE ONLY — an existing path is a conflict", async () => {
    const backend = await fixture.open();
    // The migration's mode: copy in, never overwrite.
    await backend.writeDocument('knowledge/Sheet.pdf', text('fresh'), { expectedRevision: 'create' });
    expect(await fixture.read(backend, 'knowledge/Sheet.pdf')).toBe('fresh');

    await expect(
      backend.writeDocument('knowledge/Sheet.pdf', text('second'), { expectedRevision: 'create' }),
    ).rejects.toBeInstanceOf(SceneRevisionConflictError);
    expect(await fixture.read(backend, 'knowledge/Sheet.pdf')).toBe('fresh');
  });

  it('a revision on a path that does not exist is a conflict, not a create', async () => {
    const backend = await fixture.open();
    await expect(
      backend.writeDocument('models/Ghost.glb', text('x'), { expectedRevision: await revisionOf('y') }),
    ).rejects.toBeInstanceOf(SceneRevisionConflictError);
    expect(await fixture.read(backend, 'models/Ghost.glb')).toBeNull();
  });

  it('serialises concurrent writes to DIFFERENT paths — both stay addressable', async () => {
    // §2.2.1-3. Without the per-instance write queue the browser backend's
    // read-modify-write of its one localStorage index loses one of these.
    const backend = await fixture.open();
    await Promise.all([
      backend.writeDocument('models/A.glb', text('a'), { expectedRevision: 'any' }),
      backend.writeDocument('models/B.glb', text('b'), { expectedRevision: 'any' }),
      backend.writeDocument('models/C.glb', text('c'), { expectedRevision: 'any' }),
    ]);
    expect(await fixture.read(backend, 'models/A.glb')).toBe('a');
    expect(await fixture.read(backend, 'models/B.glb')).toBe('b');
    expect(await fixture.read(backend, 'models/C.glb')).toBe('c');
  });

  it('a refused write does not wedge the queue for the next one', async () => {
    const backend = await fixture.open();
    await expect(
      backend.writeDocument('models/X.glb', text('x'), { expectedRevision: await revisionOf('nope') }),
    ).rejects.toBeInstanceOf(SceneRevisionConflictError);
    await backend.writeDocument('models/X.glb', text('after'), { expectedRevision: 'any' });
    expect(await fixture.read(backend, 'models/X.glb')).toBe('after');
  });

  it('flush awaits the queued writes', async () => {
    const backend = await fixture.open();
    void backend.writeDocument('models/Late.glb', text('late'), { expectedRevision: 'any' });
    await backend.flush();
    expect(await fixture.read(backend, 'models/Late.glb')).toBe('late');
  });

  // ── plan-736 §9.1: the scene half keeps the CAS it always had ──────────

  it('a scene document keeps its pre-existing compare-and-swap behaviour', async () => {
    // Characterisation. The browser backend routes this into its scene-GLB
    // store (because the write carries a scene row) and the folder backend
    // writes an ordinary file; the OBSERVABLE contract has to be the same
    // either way, which is the whole claim of the unification.
    const backend = await fixture.open();
    const meta = { id: 'scn_cas', name: 'Line', path: 'scn_cas' };

    const first = await backend.writeDocument(
      { path: meta.path, id: meta.id, meta }, text('v1'), { expectedRevision: 'create' });
    expect(first.revision).toBe(await revisionOf('v1'));

    // A second 'create' on the same scene is a conflict, exactly as for a blob.
    await expect(
      backend.writeDocument(
        { path: meta.path, id: meta.id, meta }, text('v2'), { expectedRevision: 'create' }),
    ).rejects.toBeInstanceOf(SceneRevisionConflictError);

    // The revision it handed back is the token the next write is accepted on…
    const second = await backend.writeDocument(
      { path: meta.path, id: meta.id, meta }, text('v2'), { expectedRevision: first.revision });
    expect(second.revision).toBe(await revisionOf('v2'));

    // …and the one it replaced is now stale.
    await expect(
      backend.writeDocument(
        { path: meta.path, id: meta.id, meta }, text('v3'), { expectedRevision: first.revision }),
    ).rejects.toBeInstanceOf(SceneRevisionConflictError);

    const record = await backend.readDocument({ path: meta.path, id: meta.id });
    expect(new TextDecoder().decode(record!.bytes)).toBe('v2');
    expect(record!.revision).toBe(second.revision);
  });

  it('reads a scene body and a library body through the same one method', async () => {
    const backend = await fixture.open();
    const meta = { id: 'scn_same', name: 'Line', path: 'scn_same' };
    await backend.writeDocument(
      { path: meta.path, id: meta.id, meta }, text('scene'), { expectedRevision: 'create' });
    await backend.writeDocument(
      'library/Custom/Belt.glb', text('library'), { expectedRevision: 'create' });

    // No caller branches on what kind of document it holds — that branch was
    // `sectionOfDocument`, and it is gone (plan-736 §2.3 #1).
    const scene = await backend.readDocument({ path: meta.path, id: meta.id });
    const library = await backend.readDocument('library/Custom/Belt.glb');
    expect(new TextDecoder().decode(scene!.bytes)).toBe('scene');
    expect(new TextDecoder().decode(library!.bytes)).toBe('library');
  });

  it('deleteDocument removes either kind, and is idempotent', async () => {
    const backend = await fixture.open();
    const meta = { id: 'scn_gone', name: 'Line', path: 'scn_gone' };
    await backend.writeDocument(
      { path: meta.path, id: meta.id, meta }, text('bye'), { expectedRevision: 'create' });
    await backend.writeDocument('library/Gone.glb', text('bye'), { expectedRevision: 'create' });

    await backend.deleteDocument({ path: meta.path, id: meta.id });
    await backend.deleteDocument('library/Gone.glb');
    expect(await backend.readDocument({ path: meta.path, id: meta.id })).toBeNull();
    expect(await backend.readDocument('library/Gone.glb')).toBeNull();

    // A second delete is the caller's intent already satisfied, never an error.
    // `deleteScene` used to throw here for an unowned path while `deleteBlob`
    // did not — the same section split, on the delete path.
    await expect(backend.deleteDocument('library/Gone.glb')).resolves.toBeUndefined();
  });
});

// ─── The read-only one refuses before the precondition matters ─────────────

describe('writeDocument contract — bundled backend', () => {
  it('refuses every write, with and without a precondition', async () => {
    const backend = await bundledFixture.open();
    await expect(backend.writeDocument('models/A.glb', text('a'), { expectedRevision: 'any' }))
      .rejects.toBeInstanceOf(BackendNotWritableError);
    // "Create only" does not sneak past read-only either.
    await expect(backend.writeDocument('models/A.glb', text('a'), { expectedRevision: 'create' }))
      .rejects.toBeInstanceOf(BackendNotWritableError);
  });
});

// ─── The gate still comes first ───────────────────────────────────────────

describe('writeDocument contract — the writable/active gate', () => {
  it('an inactive writable backend refuses regardless of the precondition', async () => {
    const backend = new BrowserBackend(PROJECT_ID, { requestPersistence: false });
    await expect(backend.writeDocument('models/A.glb', text('a'), { expectedRevision: 'create' }))
      .rejects.toBeInstanceOf(BackendNotWritableError);
  });
});
