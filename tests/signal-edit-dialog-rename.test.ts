// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2025 F10 / SOL #4, §9 `signal-edit-dialog-rename` — a dialog save that renames is an explicit,
 * resumable two-step: (1) `/config/signals/rename` (unchanged contract, operation id), (2) a
 * `signal.upsert` of the other fields under the new name, based on the rename's `storeRevision`.
 *
 * Covered: the happy path uses the rename's store revision; a failing step 2 keeps the rename and
 * reports "Renamed to X — other changes not saved", and Retry repeats only step 2 (idempotent); a lost
 * rename answer is resumed by operation id; a conflicting write between the steps → 409 → Retry works.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetConnectStore,
  fetchInterfaces,
  saveSignalFromDialog,
  setServerUrl,
  type ConnectInterface,
  type ConnectInterfaceSignal,
} from '../src/core/hmi/connect-store';
import { installFakeGateway, type FakeGateway } from './_connect-ops-fake-gateway';

const IFACE: ConnectInterface = {
  id: 'tc-1', type: 'TwinCat', enabled: true,
  signals: [{ name: 'Old', protocolAddress: 'MAIN.a', type: 'PLCOutputBool', record: false }],
} as ConnectInterface;

const edited: ConnectInterfaceSignal = { name: 'New', protocolAddress: 'MAIN.b', type: 'PLCOutputBool', comment: 'edited', record: true };

let gw: FakeGateway;
beforeEach(async () => {
  _resetConnectStore();
  setServerUrl('http://gw.test:5100');
  gw = installFakeGateway({ interfaces: [IFACE], revision: 5 });
  await fetchInterfaces();
});
afterEach(() => { vi.restoreAllMocks(); _resetConnectStore(); });

const renameCalls = () => gw.calls.filter(c => c.path === '/config/signals/rename');

describe('dialog save with rename', () => {
  it('renames through /config/signals/rename, then upserts on the rename\'s store revision', async () => {
    const outcome = await saveSignalFromDialog({ interfaceId: 'tc-1', originalName: 'Old', signal: edited });
    expect(outcome).toEqual({ kind: 'saved' });
    expect(renameCalls().map(c => (c.body as { preview: boolean }).preview)).toEqual([true, false]);
    const [upsert] = gw.opsCalls();
    expect(upsert.expectedRevision).toBe(6); // the rename commit's storeRevision
    expect(upsert.ops[0]).toMatchObject({ op: 'signal.upsert', name: 'New', protocolAddress: 'MAIN.b', comment: 'edited', record: true });
    expect(gw.interfaces[0].signals).toEqual([
      expect.objectContaining({ name: 'New', protocolAddress: 'MAIN.b', comment: 'edited', record: true }),
    ]);
  });

  it('step 2 fails → "Renamed to X — other changes not saved", draft kept; Retry repeats only step 2', async () => {
    gw.failOps.push({ status: 400, body: { code: 'ops-rejected', errors: ['ops[0] signal.upsert: address-required'], results: [] } });
    const first = await saveSignalFromDialog({ interfaceId: 'tc-1', originalName: 'Old', signal: edited });
    expect(first.kind).toBe('renamed-not-saved');
    if (first.kind !== 'renamed-not-saved') return;
    expect(first.message).toMatch(/^Renamed to 'New' — other changes not saved: /);
    expect(first.progress).toMatchObject({ from: 'Old', to: 'New', committed: true });
    expect(gw.interfaces[0].signals[0]).toMatchObject({ name: 'New', protocolAddress: 'MAIN.a' });

    const renamesBefore = renameCalls().length;
    const retry = await saveSignalFromDialog({ interfaceId: 'tc-1', originalName: 'Old', signal: edited, resume: first.progress });
    expect(retry).toEqual({ kind: 'saved' });
    expect(renameCalls().length).toBe(renamesBefore); // no second rename
    expect(gw.interfaces[0].signals[0]).toMatchObject({ name: 'New', protocolAddress: 'MAIN.b', comment: 'edited' });

    // Idempotent: the same Retry once more changes nothing.
    const revision = gw.revision;
    expect(await saveSignalFromDialog({ interfaceId: 'tc-1', originalName: 'Old', signal: edited, resume: first.progress })).toEqual({ kind: 'saved' });
    expect(gw.revision).toBe(revision);
  });

  it('a write between rename and upsert → 409 → reported, Retry on the reloaded revision succeeds', async () => {
    // Another client writes right after the rename commit: the rename's storeRevision is stale.
    const fake = vi.mocked(globalThis.fetch).getMockImplementation()!;
    let armed = true;
    vi.mocked(globalThis.fetch).mockImplementation(async (url, init) => {
      const resp = await fake(url, init);
      if (armed && String(url).endsWith('/config/signals/rename') && JSON.parse(String(init?.body)).preview === false) {
        armed = false;
        gw.bump();
      }
      return resp;
    });
    const first = await saveSignalFromDialog({ interfaceId: 'tc-1', originalName: 'Old', signal: edited });
    expect(first.kind).toBe('renamed-not-saved');
    if (first.kind !== 'renamed-not-saved') return;
    expect(first.message).toMatch(/changed elsewhere/);
    const retry = await saveSignalFromDialog({ interfaceId: 'tc-1', originalName: 'Old', signal: edited, resume: first.progress });
    expect(retry).toEqual({ kind: 'saved' });
    expect(gw.interfaces[0].signals[0]).toMatchObject({ name: 'New', protocolAddress: 'MAIN.b' });
  });

  it('a lost rename answer is resumed by operation id, without renaming twice', async () => {
    gw.loseRenameAnswer = true;
    const outcome = await saveSignalFromDialog({ interfaceId: 'tc-1', originalName: 'Old', signal: edited });
    // The status endpoint knows the operation id as committed → step 2 runs in the same save.
    expect(outcome).toEqual({ kind: 'saved' });
    const statusAsks = gw.calls.filter(c => c.method === 'GET' && c.path.startsWith('/config/signals/rename/'));
    expect(statusAsks).toHaveLength(1);
    // The result is fetched again by repeating the apply under the SAME operation id (CONNECT answers
    // with the remembered outcome) — the rename itself happened once.
    const applies = renameCalls().filter(c => (c.body as { preview: boolean }).preview === false);
    expect(applies).toHaveLength(2);
    expect(new Set(applies.map(c => (c.body as { operationId: string }).operationId)).size).toBe(1);
    expect(gw.opsCalls()[0].expectedRevision).toBe(6); // the rename commit's revision, from the replayed result
    expect(gw.interfaces[0].signals[0]).toMatchObject({ name: 'New', protocolAddress: 'MAIN.b' });
  });

  it('lost rename answer + a write by someone else → step 2 on the RENAME revision → 409, nothing overwritten', async () => {
    gw.loseRenameAnswer = true;
    // Another client changes the renamed signal right after the rename commit.
    gw.afterRenameCommit = () => {
      gw.afterRenameCommit = null;
      gw.interfaces[0].signals[0].comment = 'by someone else';
      gw.bump();
    };
    const outcome = await saveSignalFromDialog({ interfaceId: 'tc-1', originalName: 'Old', signal: edited });
    expect(outcome.kind).toBe('renamed-not-saved');
    if (outcome.kind !== 'renamed-not-saved') return;
    expect(outcome.message).toMatch(/changed elsewhere/);
    expect(gw.opsCalls()[0].expectedRevision).toBe(6); // not the 7 a GET would have shown
    expect(gw.interfaces[0].signals[0]).toMatchObject({ name: 'New', protocolAddress: 'MAIN.a', comment: 'by someone else' });
  });

  it('resume after "not confirmed": the result is fetched by operation id and its revision used', async () => {
    gw.loseRenameAnswer = true;
    // The status route cannot be asked at first → the save stops in "rename-unconfirmed".
    const fake = vi.mocked(globalThis.fetch).getMockImplementation()!;
    let statusDown = true;
    vi.mocked(globalThis.fetch).mockImplementation(async (url, init) => {
      if (statusDown && String(url).includes('/config/signals/rename/')) return Promise.reject(new TypeError('Failed to fetch'));
      return fake(url, init);
    });
    const first = await saveSignalFromDialog({ interfaceId: 'tc-1', originalName: 'Old', signal: edited });
    expect(first.kind).toBe('rename-unconfirmed');
    if (first.kind !== 'rename-unconfirmed') return;
    expect(gw.opsCalls()).toHaveLength(0);
    gw.bump(); // a later write elsewhere: a GET would now show revision 7
    statusDown = false;
    const retry = await saveSignalFromDialog({ interfaceId: 'tc-1', originalName: 'Old', signal: edited, resume: first.progress });
    expect(retry.kind).toBe('renamed-not-saved'); // step 2 ran on revision 6 → 409, nothing overwritten
    expect(gw.opsCalls()[0].expectedRevision).toBe(6);
  });

  it('CONNECT no longer has the result (restart / evicted) → step 2 is NOT run, the user checks', async () => {
    gw.loseRenameAnswer = true;
    gw.afterRenameCommit = () => { gw.afterRenameCommit = null; gw.forgetRenames(); };
    const outcome = await saveSignalFromDialog({ interfaceId: 'tc-1', originalName: 'Old', signal: edited });
    expect(outcome.kind).toBe('rename-unverified');
    if (outcome.kind !== 'rename-unverified') return;
    expect(outcome.progress).toBeNull();
    expect(outcome.message).toMatch(/check whether the signal is renamed/);
    expect(gw.opsCalls()).toHaveLength(0);
    expect(gw.interfaces[0].signals[0]).toMatchObject({ name: 'New', protocolAddress: 'MAIN.a' });
  });

  it('a name collision is refused before anything is written', async () => {
    gw.interfaces[0].signals.push({ name: 'Taken', protocolAddress: 'MAIN.t', type: 'PLCOutputBool', record: false });
    await fetchInterfaces();
    await expect(saveSignalFromDialog({ interfaceId: 'tc-1', originalName: 'Old', signal: { ...edited, name: 'Taken' } }))
      .rejects.toThrow(/already exists/);
    expect(gw.opsCalls()).toHaveLength(0);
  });
});
