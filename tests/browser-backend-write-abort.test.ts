// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2229 Phase 3 review — `BrowserBackend.writeDocument` honours the
 * optional `signal` with the same semantics as the folder backend
 * (`project-write-abort.test.ts`): aborted while queued or before the commit
 * point (the path-index update), the write rejects with `AbortError
 * {committed: false}` and the existing document keeps its bytes; aborted after
 * the commit, the write has resolved and the new bytes are the document.
 * documents-projects 6: the expectation stays required; the signal is additive.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BrowserBackend } from '../src/core/project/backends/browser-backend';
import { clearAllBlobs } from '../src/core/storage/rv-opfs-blobs';
import { clearAllScenes } from '../src/core/hmi/scene/rv-scene-storage';
import { clearAllSceneOwners } from '../src/core/project/rv-scene-owner';
import { clearSceneMutationListeners } from '../src/core/hmi/scene/rv-scene-mutations';

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);
const PATH = 'exports/take.usdz';

async function open(): Promise<BrowserBackend> {
  const backend = new BrowserBackend('prj_2229', { requestPersistence: false });
  await backend.activate();
  await backend.writeDocument(PATH, enc('OLD'), { expectedRevision: 'any' });
  return backend;
}

async function bytesOf(backend: BrowserBackend): Promise<string> {
  const rec = await backend.readDocument(PATH);
  return rec ? dec(rec.bytes) : '<none>';
}

/** A signal that turns aborted on its n-th read (1 = the queued-start check). */
function abortsOnRead(n: number): AbortSignal {
  let reads = 0;
  return { get aborted() { return ++reads >= n; } } as unknown as AbortSignal;
}

beforeEach(async () => {
  clearSceneMutationListeners();
  localStorage.clear();
  clearAllScenes();
  clearAllSceneOwners();
  await clearAllBlobs();
});

afterEach(async () => {
  clearSceneMutationListeners();
  localStorage.clear();
  await clearAllBlobs();
});

describe('BrowserBackend.writeDocument — signal up to the commit (plan-2229)', () => {
  it('aborted while queued behind another write: the existing document stays as it was', async () => {
    const backend = await open();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const held = (backend as unknown as { _writes: { run(w: () => Promise<void>): Promise<void> } })._writes.run(() => gate);
    const ac = new AbortController();
    const take = backend.writeDocument(PATH, enc('NEW'), { expectedRevision: 'any', signal: ac.signal });
    ac.abort();
    release();
    await held;
    await expect(take).rejects.toMatchObject({ name: 'AbortError', committed: false });
    expect(await bytesOf(backend)).toBe('OLD');
  });

  it('aborted after the queued write started but before the index update: document untouched', async () => {
    const backend = await open();
    for (const read of [2, 3]) { // before the digest put, after it (before the index commit)
      await expect(backend.writeDocument(PATH, enc('NEW'), { expectedRevision: 'any', signal: abortsOnRead(read) }))
        .rejects.toMatchObject({ committed: false });
      expect(await bytesOf(backend)).toBe('OLD');
    }
  });

  it('a cancel after the commit changes nothing: the write resolved (committed)', async () => {
    const backend = await open();
    const ac = new AbortController();
    await expect(backend.writeDocument(PATH, enc('NEW'), { expectedRevision: 'any', signal: ac.signal }))
      .resolves.toHaveProperty('revision');
    ac.abort();
    expect(await bytesOf(backend)).toBe('NEW');
  });

  it('without a signal everything behaves as before', async () => {
    const backend = await open();
    await backend.writeDocument(PATH, enc('NEW'), { expectedRevision: 'any' });
    expect(await bytesOf(backend)).toBe('NEW');
  });
});
