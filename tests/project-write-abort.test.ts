// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2229 Phase 3 review — an aborted project write commits nothing.
 *
 * `WriteDocumentOptions.signal` (optional) travels through the FolderBackend's
 * write queue into the atomic writer: checked when the queued write starts
 * (before any filesystem mutation) and again before the swap file commits
 * (`close()`). An aborted, uncommitted write leaves an existing destination
 * byte-identical, removes an entry it created, and rejects with
 * `AbortError {committed: false}`. A cancel after the commit changes nothing:
 * the write resolves (committed). Callers without a signal are unaffected.
 * documents-projects 6: the expectation stays required; the signal is additive.
 */

import { describe, expect, it } from 'vitest';
import { FolderBackend } from '../src/core/project/backends/folder-backend';
import { FakeDir, FakeFile, asDirHandle } from './helpers/fake-fs-handles';

const enc = (s: string) => new TextEncoder().encode(s);

async function rig(existing: string | null) {
  const root = new FakeDir('customer');
  const exportsDir = root.seedDir('exports');
  if (existing !== null) exportsDir.seedText('take.usdz', existing);
  const backend = new FolderBackend(asDirHandle(root), { writable: true });
  await backend.activate();
  // Hold an earlier write in the queue (block.glb) until released.
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  const original = exportsDir.getFileHandle.bind(exportsDir);
  const hooks: Record<string, () => void> = {};
  (exportsDir as unknown as { getFileHandle: FakeDir['getFileHandle'] }).getFileHandle = async (name, opts) => {
    if (name === 'block.glb') await gate;
    const h = await original(name, opts);
    hooks[name]?.();
    return h;
  };
  return { root, exportsDir, backend, release, hooks };
}

const text = async (dir: FakeDir, name: string) => ((await dir.getFileHandle(name)) as FakeFile).text();

describe('FolderBackend.writeDocument — signal up to the commit (plan-2229)', () => {
  it('aborted while queued behind another write: the existing file stays byte-identical, no extra entries', async () => {
    const r = await rig('OLD');
    const first = r.backend.writeDocument('exports/block.glb', enc('B'), { expectedRevision: 'any' });
    const ac = new AbortController();
    const take = r.backend.writeDocument('exports/take.usdz', enc('NEW'), { expectedRevision: 'any', signal: ac.signal });
    ac.abort();
    r.release();
    await first;
    await expect(take).rejects.toMatchObject({ name: 'AbortError', committed: false });
    expect(await text(r.exportsDir, 'take.usdz')).toBe('OLD');
    expect(r.exportsDir.childNames()).toEqual(['block.glb', 'take.usdz']);
  });

  it('aborted after the queued write started but before the commit: destination untouched', async () => {
    const r = await rig('OLD');
    r.release();
    const ac = new AbortController();
    r.hooks['take.usdz'] = () => ac.abort(); // the handle is open, the swap file not committed yet
    const take = r.backend.writeDocument('exports/take.usdz', enc('NEW'), { expectedRevision: 'any', signal: ac.signal });
    await expect(take).rejects.toMatchObject({ committed: false });
    expect(await text(r.exportsDir, 'take.usdz')).toBe('OLD');
  });

  it('a new file aborted before the commit leaves no (empty) entry behind', async () => {
    const r = await rig(null);
    r.release();
    const ac = new AbortController();
    r.hooks['take.usdz'] = () => ac.abort();
    await expect(r.backend.writeDocument('exports/take.usdz', enc('NEW'), { expectedRevision: 'any', signal: ac.signal }))
      .rejects.toMatchObject({ committed: false });
    expect(r.exportsDir.childNames()).toEqual([]);
  });

  it('a cancel after the commit changes nothing: the write resolved (committed)', async () => {
    const r = await rig('OLD');
    r.release();
    const ac = new AbortController();
    await expect(r.backend.writeDocument('exports/take.usdz', enc('NEW'), { expectedRevision: 'any', signal: ac.signal }))
      .resolves.toHaveProperty('revision');
    ac.abort();
    expect(await text(r.exportsDir, 'take.usdz')).toBe('NEW');
  });

  it('without a signal everything behaves as before', async () => {
    const r = await rig('OLD');
    r.release();
    await r.backend.writeDocument('exports/take.usdz', enc('NEW'), { expectedRevision: 'any' });
    expect(await text(r.exportsDir, 'take.usdz')).toBe('NEW');
  });
});
