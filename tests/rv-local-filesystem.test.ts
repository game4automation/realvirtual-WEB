// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-local-filesystem.test — the multi-key handle store and the readwrite
 * permission path.
 *
 * This module had **no test at all** before plan-370, and the store was a
 * single slot keyed by the constant `'workfolder'`. The first project pick
 * would therefore have overwritten the working-folder handle in place and
 * the planner would have lost its library — silently, and only noticed on
 * the next reload. That is what the first block here pins down.
 *
 * (Note: `tests/import-file-handle-store.test.ts` covers a *different*
 * module — `src/core/hmi/import-file-handle-store.ts`, its own IndexedDB,
 * already multi-key. It was never a test of this file.)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  HANDLE_KEY_WORKFOLDER,
  HANDLE_KEY_WORKSPACE,
  deleteStoredHandle,
  ensureHandlePermission,
  getFolderHandle,
  getHandle,
  isSupported,
  listHandleKeys,
  pickFolderForKey,
  projectHandleKey,
  putHandle,
  readTextFile,
  removeFileEntry,
  requestWriteAccess,
  selectFolderForKey,
  tryGetSubfolder,
  writeTextFile,
} from '../src/core/engine/rv-local-filesystem';
import { FakeDir, asDirHandle, namedError } from './helpers/fake-fs-handles';

// IndexedDB stores structured clones. A FakeDir is not cloneable, so the
// handle-store tests use plain cloneable stand-ins — the store itself is
// agnostic about what it holds.
const stub = (name: string) => ({ name, kind: 'directory' }) as unknown as FileSystemDirectoryHandle;

const KEYS = [
  HANDLE_KEY_WORKFOLDER,
  HANDLE_KEY_WORKSPACE,
  projectHandleKey('prj_a'),
  projectHandleKey('prj_b'),
];

async function wipe(): Promise<void> {
  for (const k of KEYS) await deleteStoredHandle(k);
}

beforeEach(wipe);
afterEach(wipe);

// ─── Multi-key handle store (§4a, R6) ───────────────────────────────────

describe('handle store — multi-key', () => {
  it('defaults to the legacy workfolder slot, so no existing caller changes', async () => {
    await putHandle(stub('legacy'));
    expect((await getHandle())?.name).toBe('legacy');
    expect((await getHandle(HANDLE_KEY_WORKFOLDER))?.name).toBe('legacy');
  });

  it('two handles under two keys survive each other', async () => {
    await putHandle(stub('work'), HANDLE_KEY_WORKFOLDER);
    await putHandle(stub('space'), HANDLE_KEY_WORKSPACE);

    expect((await getHandle(HANDLE_KEY_WORKFOLDER))?.name).toBe('work');
    expect((await getHandle(HANDLE_KEY_WORKSPACE))?.name).toBe('space');
  });

  it('a project pick does NOT clobber the working folder (the bug this prevents)', async () => {
    await putHandle(stub('my-work-folder'), HANDLE_KEY_WORKFOLDER);
    await putHandle(stub('customer-project'), projectHandleKey('prj_a'));

    // Before the multi-key rebuild this assertion would have read
    // 'customer-project' and the planner library would be gone.
    expect((await getHandle(HANDLE_KEY_WORKFOLDER))?.name).toBe('my-work-folder');
  });

  it('keeps several projects side by side', async () => {
    await putHandle(stub('A'), projectHandleKey('prj_a'));
    await putHandle(stub('B'), projectHandleKey('prj_b'));
    expect((await getHandle(projectHandleKey('prj_a')))?.name).toBe('A');
    expect((await getHandle(projectHandleKey('prj_b')))?.name).toBe('B');
  });

  it('returns null for an empty slot', async () => {
    expect(await getHandle(projectHandleKey('never-stored'))).toBeNull();
  });

  it('deleting one slot leaves the others intact', async () => {
    await putHandle(stub('work'), HANDLE_KEY_WORKFOLDER);
    await putHandle(stub('A'), projectHandleKey('prj_a'));

    await deleteStoredHandle(projectHandleKey('prj_a'));

    expect(await getHandle(projectHandleKey('prj_a'))).toBeNull();
    expect((await getHandle(HANDLE_KEY_WORKFOLDER))?.name).toBe('work');
  });

  it('overwrites in place when the same key is reused', async () => {
    await putHandle(stub('first'), HANDLE_KEY_WORKSPACE);
    await putHandle(stub('second'), HANDLE_KEY_WORKSPACE);
    expect((await getHandle(HANDLE_KEY_WORKSPACE))?.name).toBe('second');
  });

  it('lists the occupied slots', async () => {
    await putHandle(stub('work'), HANDLE_KEY_WORKFOLDER);
    await putHandle(stub('A'), projectHandleKey('prj_a'));
    const keys = await listHandleKeys();
    expect(keys).toContain(HANDLE_KEY_WORKFOLDER);
    expect(keys).toContain(projectHandleKey('prj_a'));
  });

  it('builds a distinct key per project id', () => {
    expect(projectHandleKey('prj_a')).not.toBe(projectHandleKey('prj_b'));
    expect(projectHandleKey('prj_a')).not.toBe(HANDLE_KEY_WORKFOLDER);
  });
});

// ─── Permission paths (R7 — untestable before the fake gained them) ─────

describe('requestWriteAccess', () => {
  it('is a no-op when readwrite is already granted', async () => {
    const dir = new FakeDir('p');
    dir.permissions.readwrite = 'granted';
    expect(await requestWriteAccess(asDirHandle(dir))).toBe(true);
    expect(dir.requestPermissionCalls).toBe(0);
  });

  it('prompts and succeeds when the state is prompt', async () => {
    const dir = new FakeDir('p');
    dir.permissions.readwrite = 'prompt';
    expect(await requestWriteAccess(asDirHandle(dir))).toBe(true);
    expect(dir.requestPermissionCalls).toBe(1);
  });

  it('returns false when the user declines — caller must degrade, not throw', async () => {
    const dir = new FakeDir('p');
    dir.permissions.readwrite = 'denied';
    expect(await requestWriteAccess(asDirHandle(dir))).toBe(false);
  });
});

/**
 * The permission half is tested through `ensureHandlePermission`, not
 * through `getFolderHandle`: IndexedDB stores structured clones, and a fake
 * handle carrying methods is not cloneable, so no test could ever push one
 * through the store. Splitting the function is what makes the deciding half
 * — "may we write into this customer's folder?" — reachable at all.
 */
describe('ensureHandlePermission', () => {
  it('returns the handle without prompting when already granted', async () => {
    const dir = new FakeDir('p');
    expect(await ensureHandlePermission(asDirHandle(dir), { mode: 'readwrite' })).not.toBeNull();
    expect(dir.requestPermissionCalls).toBe(0);
  });

  it('re-grants on reload when permission has lapsed to prompt', async () => {
    const dir = new FakeDir('p');
    dir.permissions.readwrite = 'prompt';
    expect(await ensureHandlePermission(asDirHandle(dir), { mode: 'readwrite' })).not.toBeNull();
    expect(dir.requestPermissionCalls).toBe(1);
  });

  it('does not prompt when prompt:false — boot must never pop a dialog', async () => {
    const dir = new FakeDir('p');
    dir.permissions.readwrite = 'prompt';
    expect(
      await ensureHandlePermission(asDirHandle(dir), { mode: 'readwrite', prompt: false }),
    ).toBeNull();
    expect(dir.requestPermissionCalls).toBe(0);
  });

  it('returns null when the grant is refused', async () => {
    const dir = new FakeDir('p');
    dir.permissions.readwrite = 'denied';
    expect(await ensureHandlePermission(asDirHandle(dir), { mode: 'readwrite' })).toBeNull();
  });

  it('treats a stale handle as unavailable rather than throwing', async () => {
    const dir = new FakeDir('p');
    dir.queryPermission = async () => { throw namedError('NotFoundError'); };
    expect(await ensureHandlePermission(asDirHandle(dir), { mode: 'readwrite' })).toBeNull();
  });

  it('checks read and readwrite independently', async () => {
    const dir = new FakeDir('p');
    dir.permissions.read = 'granted';
    dir.permissions.readwrite = 'denied';
    expect(await ensureHandlePermission(asDirHandle(dir), { mode: 'read' })).not.toBeNull();
    expect(await ensureHandlePermission(asDirHandle(dir), { mode: 'readwrite' })).toBeNull();
  });
});

describe('getFolderHandle', () => {
  it('returns null when the slot is empty', async () => {
    expect(await getFolderHandle(projectHandleKey('prj_a'))).toBeNull();
  });
});

// ─── Text primitives ────────────────────────────────────────────────────

describe('text file primitives', () => {
  it('round-trips text', async () => {
    const dir = new FakeDir('p');
    await writeTextFile(asDirHandle(dir), 'a.json', '{"x":1}');
    expect(await readTextFile(asDirHandle(dir), 'a.json')).toBe('{"x":1}');
  });

  it('reports a missing file as null, not as a throw', async () => {
    const dir = new FakeDir('p');
    expect(await readTextFile(asDirHandle(dir), 'nope.json')).toBeNull();
  });

  it('rethrows a real read failure — absent and broken must not look alike', async () => {
    const dir = new FakeDir('p');
    dir.seedText('a.json', 'x');
    dir.failures.fail({ point: 'getFile', name: 'a.json', error: namedError('NotAllowedError') });
    await expect(readTextFile(asDirHandle(dir), 'a.json')).rejects.toThrow();
  });

  it('removes idempotently', async () => {
    const dir = new FakeDir('p');
    dir.seedText('a.json', 'x');
    await removeFileEntry(asDirHandle(dir), 'a.json');
    await expect(removeFileEntry(asDirHandle(dir), 'a.json')).resolves.toBeUndefined();
  });

  it('tryGetSubfolder returns null instead of throwing for an absent folder', async () => {
    const dir = new FakeDir('p');
    expect(await tryGetSubfolder(asDirHandle(dir), 'docs')).toBeNull();
    dir.seedDir('docs');
    expect(await tryGetSubfolder(asDirHandle(dir), 'docs')).not.toBeNull();
  });
});

// ─── Directory picker — every empty outcome names itself ────────────────

/**
 * The regression these pin down: `selectFolderForKey` answered `handle | null`,
 * and that one `null` covered *cancelled*, *no API in this browser* and
 * *picker refused to open*. The dashboard could only read it as "cancelled",
 * so "Open workspace…" on Firefox — or after a picker got stuck — was a button
 * that did nothing at all, with no dialog and no message.
 */
describe('pickFolderForKey', () => {
  const KEY = projectHandleKey('prj_a');
  // The real Chromium picker would open a native dialog no test can answer, so
  // the API itself is the seam: swapped for a canned outcome, and *removed* to
  // stand in for a browser that never had it.
  const w = window as unknown as { showDirectoryPicker?: unknown };
  let original: unknown;

  beforeEach(() => { original = w.showDirectoryPicker; });
  afterEach(() => {
    if (original === undefined) delete w.showDirectoryPicker;
    else w.showDirectoryPicker = original;
  });

  /** Replace the picker with a canned outcome. `null` removes it entirely. */
  function picker(outcome: (() => Promise<unknown>) | null): void {
    if (outcome === null) delete w.showDirectoryPicker;
    else w.showDirectoryPicker = outcome;
  }

  it('returns the handle and persists it under the caller key', async () => {
    const dir = stub('picked');
    picker(async () => dir);
    const pick = await pickFolderForKey(KEY);
    expect(pick.kind).toBe('picked');
    expect(await getHandle(KEY)).toEqual(dir);
  });

  it('reports a dismissed dialog as cancelled — the one silent outcome', async () => {
    picker(async () => { throw new DOMException('The user aborted a request.', 'AbortError'); });
    expect((await pickFolderForKey(KEY)).kind).toBe('cancelled');
  });

  it('separates a stuck picker from a cancel, though both arrive as AbortError', async () => {
    picker(async () => { throw new DOMException('File picker already active.', 'AbortError'); });
    const pick = await pickFolderForKey(KEY);
    expect(pick.kind).toBe('blocked');
    if (pick.kind === 'blocked') expect(pick.reason).toMatch(/reload/i);
  });

  it('reports a refusal (policy, cross-origin frame) with its reason', async () => {
    picker(async () => { throw new DOMException('blocked by policy', 'NotAllowedError'); });
    const pick = await pickFolderForKey(KEY);
    expect(pick.kind).toBe('blocked');
    if (pick.kind === 'blocked') expect(pick.reason).toBe('blocked by policy');
  });

  it('reports a browser without the API as unsupported, not as a cancel', async () => {
    picker(null);
    expect(isSupported()).toBe(false);
    expect((await pickFolderForKey(KEY)).kind).toBe('unsupported');
  });

  it('keeps selectFolderForKey lenient — every empty outcome is still null', async () => {
    picker(null);
    expect(await selectFolderForKey(KEY)).toBeNull();
    picker(async () => { throw new DOMException('The user aborted a request.', 'AbortError'); });
    expect(await selectFolderForKey(KEY)).toBeNull();
  });
});
