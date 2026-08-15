// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-709 §2.3 / §9.8 — `writeBlob` grows a precondition, in ALL THREE
 * backends or in none.
 *
 * The plan's finding was that the missing compare-and-swap on the asset surface
 * was not a missing *call site* but a missing *capability*: `writeScene` had
 * one, `writeBlob` did not, and every asset write in the product was therefore
 * a last-writer-wins overwrite. Adding it to one backend and forgetting another
 * would be worse than not adding it, because callers would start trusting a
 * guarantee that holds on Chromium and silently does not on Safari.
 *
 * So this is a CONTRACT test: one `describe.each` over every implementation,
 * each with the shared fixture that constructs it (the three have genuinely
 * different construction — a project id, a directory handle, a fetch root).
 *
 * Three properties, and the first is the one that keeps the change non-breaking:
 *
 *  1. **without `opts` nothing changes** — same single write, same overwrite,
 *     same absence of any extra read;
 *  2. **with a revision that no longer holds** the write is REFUSED and the
 *     stored bytes are untouched — not overwritten, not truncated;
 *  3. **with `expectedRevision: null`** ("create only", the mode the phase-5
 *     migration needs) an existing path is a conflict rather than a silent
 *     replacement.
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
    const resolved = await backend.readBlobUrl(relPath);
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
    const resolved = await backend.readBlobUrl(relPath);
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

function text(value: string): Blob {
  return new Blob([new TextEncoder().encode(value)]);
}

async function revisionOf(value: string): Promise<string> {
  return revisionOfBytes(new TextEncoder().encode(value));
}

// ─── The two writable backends share every property ───────────────────────

describe.each([
  ['browser', browserFixture],
  ['folder', folderFixture],
] as const)('writeBlob contract — %s backend', (_name, fixture) => {
  beforeEach(async () => { await fixture.reset(); });
  afterEach(async () => { await fixture.reset(); });

  it('without opts: writes, and overwrites, exactly as before', async () => {
    const backend = await fixture.open();
    await backend.writeBlob('library/Custom/Belt.glb', text('one'));
    expect(await fixture.read(backend, 'library/Custom/Belt.glb')).toBe('one');

    // No precondition passed → last writer wins, which is what every existing
    // caller relies on and what makes this change non-breaking.
    await backend.writeBlob('library/Custom/Belt.glb', text('two'));
    expect(await fixture.read(backend, 'library/Custom/Belt.glb')).toBe('two');
  });

  it('accepts a write whose expected revision still holds', async () => {
    const backend = await fixture.open();
    await backend.writeBlob('models/Press.glb', text('v1'));

    await backend.writeBlob('models/Press.glb', text('v2'), {
      expectedRevision: await revisionOf('v1'),
    });
    expect(await fixture.read(backend, 'models/Press.glb')).toBe('v2');
  });

  it('REFUSES a write whose basis somebody else replaced, and keeps their bytes', async () => {
    const backend = await fixture.open();
    await backend.writeBlob('models/Press.glb', text('mine'));
    const stale = await revisionOf('mine');

    // Somebody else (another verb, another tab) got there first.
    await backend.writeBlob('models/Press.glb', text('theirs'));

    await expect(
      backend.writeBlob('models/Press.glb', text('mine again'), { expectedRevision: stale }),
    ).rejects.toBeInstanceOf(SceneRevisionConflictError);
    // The point of the refusal: their bytes are still there.
    expect(await fixture.read(backend, 'models/Press.glb')).toBe('theirs');
  });

  it('expectedRevision null means CREATE ONLY — an existing path is a conflict', async () => {
    const backend = await fixture.open();
    // The migration's mode: copy in, never overwrite.
    await backend.writeBlob('knowledge/Sheet.pdf', text('fresh'), { expectedRevision: null });
    expect(await fixture.read(backend, 'knowledge/Sheet.pdf')).toBe('fresh');

    await expect(
      backend.writeBlob('knowledge/Sheet.pdf', text('second'), { expectedRevision: null }),
    ).rejects.toBeInstanceOf(SceneRevisionConflictError);
    expect(await fixture.read(backend, 'knowledge/Sheet.pdf')).toBe('fresh');
  });

  it('a revision on a path that does not exist is a conflict, not a create', async () => {
    const backend = await fixture.open();
    await expect(
      backend.writeBlob('models/Ghost.glb', text('x'), { expectedRevision: await revisionOf('y') }),
    ).rejects.toBeInstanceOf(SceneRevisionConflictError);
    expect(await fixture.read(backend, 'models/Ghost.glb')).toBeNull();
  });

  it('serialises concurrent writes to DIFFERENT paths — both stay addressable', async () => {
    // §2.2.1-3. Without the per-instance write queue the browser backend's
    // read-modify-write of its one localStorage index loses one of these.
    const backend = await fixture.open();
    await Promise.all([
      backend.writeBlob('models/A.glb', text('a')),
      backend.writeBlob('models/B.glb', text('b')),
      backend.writeBlob('models/C.glb', text('c')),
    ]);
    expect(await fixture.read(backend, 'models/A.glb')).toBe('a');
    expect(await fixture.read(backend, 'models/B.glb')).toBe('b');
    expect(await fixture.read(backend, 'models/C.glb')).toBe('c');
  });

  it('a refused write does not wedge the queue for the next one', async () => {
    const backend = await fixture.open();
    await expect(
      backend.writeBlob('models/X.glb', text('x'), { expectedRevision: await revisionOf('nope') }),
    ).rejects.toBeInstanceOf(SceneRevisionConflictError);
    await backend.writeBlob('models/X.glb', text('after'));
    expect(await fixture.read(backend, 'models/X.glb')).toBe('after');
  });

  it('flush awaits the queued writes', async () => {
    const backend = await fixture.open();
    void backend.writeBlob('models/Late.glb', text('late'));
    await backend.flush();
    expect(await fixture.read(backend, 'models/Late.glb')).toBe('late');
  });
});

// ─── The read-only one refuses before the precondition matters ─────────────

describe('writeBlob contract — bundled backend', () => {
  it('refuses every write, with and without a precondition', async () => {
    const backend = await bundledFixture.open();
    await expect(backend.writeBlob('models/A.glb', text('a')))
      .rejects.toBeInstanceOf(BackendNotWritableError);
    // "Create only" does not sneak past read-only either.
    await expect(backend.writeBlob('models/A.glb', text('a'), { expectedRevision: null }))
      .rejects.toBeInstanceOf(BackendNotWritableError);
  });
});

// ─── The gate still comes first ───────────────────────────────────────────

describe('writeBlob contract — the writable/active gate', () => {
  it('an inactive writable backend refuses regardless of the precondition', async () => {
    const backend = new BrowserBackend(PROJECT_ID, { requestPersistence: false });
    await expect(backend.writeBlob('models/A.glb', text('a'), { expectedRevision: null }))
      .rejects.toBeInstanceOf(BackendNotWritableError);
  });
});
