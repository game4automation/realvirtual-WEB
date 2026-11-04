// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-project-linked — the list that replaced the workspace (plan-743 §9.1).
 *
 * The cases here are the ones the old recents list could not have: order that
 * comes out of the timestamps rather than out of write order, a `linkedAt` that
 * survives every reopen, an unlink that takes the handle with it, and the
 * duplicate guard that stops a copied project folder from silently stealing an
 * existing row.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * The handle store is faked, not driven through IndexedDB.
 *
 * `isSameEntry` is a METHOD, and structured clone refuses to store an object
 * that carries one — so a fake handle that can answer the duplicate guard can
 * never make the round trip through the real store. The real IDB path is
 * covered by the storage test beside this one; what matters here is the list logic
 * on top of it.
 */
const HANDLES = new Map<string, FileSystemDirectoryHandle>();
/** Makes the fake store's delete reject, as a real IndexedDB failure would. */
const STORE = { failDelete: false };

vi.mock('../src/core/engine/rv-local-filesystem', () => ({
  projectHandleKey: (id: string) => `projectfolder:${id}`,
  listHandleKeys: async () => [...HANDLES.keys()],
  getHandle: async (key: string) => HANDLES.get(key) ?? null,
  putHandle: async (h: FileSystemDirectoryHandle, key: string) => { HANDLES.set(key, h); },
  deleteStoredHandle: async (key: string) => {
    if (STORE.failDelete) throw new Error('IndexedDB delete failed');
    HANDLES.delete(key);
  },
}));

const {
  LS_KEY_LINKED_PROJECTS,
  isSameLinkedFolder,
  listLinkedProjects,
  readLinkedProjects,
  recordLinkedProject,
  relinkProject,
  unlinkProject,
} = await import('../src/core/project/rv-project-linked');
const { getHandle, projectHandleKey, putHandle } =
  await import('../src/core/engine/rv-local-filesystem');

/** A directory handle whose identity is the marker, as `isSameEntry` reports it. */
const fakeHandle = (name: string, marker = name) =>
  ({
    name,
    kind: 'directory',
    marker,
    isSameEntry: async (other: unknown) => (other as { marker?: string })?.marker === marker,
  }) as unknown as FileSystemDirectoryHandle;

async function link(id: string, folder: string, marker = folder): Promise<void> {
  await putHandle(fakeHandle(folder, marker), projectHandleKey(id));
}

beforeEach(() => {
  localStorage.removeItem(LS_KEY_LINKED_PROJECTS);
  HANDLES.clear();
  STORE.failDelete = false;
});

describe('listLinkedProjects ordering', () => {
  it('sorts by lastOpenedAt desc, then linkedAt desc', async () => {
    localStorage.setItem(LS_KEY_LINKED_PROJECTS, JSON.stringify([
      // Deliberately stored in an order that contradicts every sort key, so a
      // passing assertion cannot be an accident of write order.
      { id: 'a', name: 'A', slug: 'a', folderName: 'a', linkedAt: '2025-01-01T00:00:00.000Z', lastOpenedAt: '2025-03-01T00:00:00.000Z' },
      { id: 'never_old', name: 'NeverOld', slug: '', folderName: '', linkedAt: '2025-01-05T00:00:00.000Z' },
      { id: 'b', name: 'B', slug: 'b', folderName: 'b', linkedAt: '2025-01-02T00:00:00.000Z', lastOpenedAt: '2025-06-01T00:00:00.000Z' },
      { id: 'never_new', name: 'NeverNew', slug: '', folderName: '', linkedAt: '2025-02-05T00:00:00.000Z' },
    ]));
    for (const id of ['a', 'never_old', 'b', 'never_new']) await link(id, id);

    const rows = await listLinkedProjects();
    // Opened rows first (newest open wins), then the never-opened ones by
    // linkedAt — a project linked in bulk by the `parent` Add must not outrank
    // one the user actually worked in.
    expect(rows.map(r => r.id)).toEqual(['b', 'a', 'never_new', 'never_old']);
  });

  it('has no cap at 25 entries', async () => {
    for (let i = 0; i < 25; i++) {
      recordLinkedProject({ id: `prj_cap_${i}`, name: `P${i}` });
      await link(`prj_cap_${i}`, `f${i}`);
    }
    const rows = await listLinkedProjects();
    expect(rows.filter(r => r.id.startsWith('prj_cap_'))).toHaveLength(25);
  });
});

describe('recordLinkedProject', () => {
  it('keeps linkedAt across an upsert and refreshes the rest', () => {
    recordLinkedProject({ id: 'p1', name: 'First', slug: 'first', folderName: 'f1' });
    const first = readLinkedProjects()[0]!;

    recordLinkedProject({ id: 'p1', name: 'Renamed', slug: 'renamed', folderName: 'f2' });
    const after = readLinkedProjects();

    expect(after).toHaveLength(1);
    expect(after[0]!.linkedAt).toBe(first.linkedAt);
    expect(after[0]!.name).toBe('Renamed');
    expect(after[0]!.slug).toBe('renamed');
    expect(after[0]!.folderName).toBe('f2');
  });

  it('stamps lastOpenedAt only when the project was actually opened', () => {
    recordLinkedProject({ id: 'p_linked', name: 'Linked only', opened: false });
    expect(readLinkedProjects()[0]!.lastOpenedAt).toBeUndefined();

    recordLinkedProject({ id: 'p_opened', name: 'Opened', opened: true });
    expect(readLinkedProjects().find(r => r.id === 'p_opened')!.lastOpenedAt).toBeTruthy();
  });

  it('does not erase an existing lastOpenedAt when re-linked without opening', () => {
    recordLinkedProject({ id: 'p1', name: 'P', opened: true });
    const opened = readLinkedProjects()[0]!.lastOpenedAt;
    recordLinkedProject({ id: 'p1', name: 'P', opened: false });
    expect(readLinkedProjects()[0]!.lastOpenedAt).toBe(opened);
  });
});

describe('unlinkProject / relinkProject', () => {
  it('unlink removes the row AND the handle', async () => {
    recordLinkedProject({ id: 'p_gone', name: 'Gone' });
    await link('p_gone', 'gone-folder');

    await unlinkProject('p_gone');

    expect(readLinkedProjects().map(r => r.id)).not.toContain('p_gone');
    // Both halves, or the orphan fallback would put the project straight back
    // into the list under "Untitled project".
    expect(await getHandle(projectHandleKey('p_gone'))).toBeNull();
  });

  it('a failing handle delete keeps the row, never an orphan handle', async () => {
    recordLinkedProject({ id: 'p_stuck', name: 'Stuck' });
    await link('p_stuck', 'stuck-folder');
    STORE.failDelete = true;

    await expect(unlinkProject('p_stuck')).rejects.toThrow('IndexedDB delete failed');

    // Row gone with the handle left would resurface as "Untitled project";
    // both staying lets the verb report the failure and be retried.
    expect(readLinkedProjects().map(r => r.id)).toContain('p_stuck');
    expect(await getHandle(projectHandleKey('p_stuck'))).not.toBeNull();
  });

  it('relink replaces only the handle and leaves the row identical', async () => {
    recordLinkedProject({ id: 'p_moved', name: 'Moved', slug: 'moved', folderName: 'old' });
    await link('p_moved', 'old-folder', 'old');
    const before = readLinkedProjects()[0]!;

    await relinkProject('p_moved', fakeHandle('new-folder', 'new'));

    expect(readLinkedProjects()[0]).toEqual(before);
    expect((await getHandle(projectHandleKey('p_moved')))?.name).toBe('new-folder');
  });
});

describe('isSameLinkedFolder', () => {
  it('answers true for the linked folder and false for a copy under the same id', async () => {
    await link('p_dup', 'project-a', 'A');

    expect(await isSameLinkedFolder('p_dup', fakeHandle('project-a', 'A'))).toBe(true);
    // Same manifest id, different folder — a copied project. The dashboard must
    // confirm rather than silently repoint the row.
    expect(await isSameLinkedFolder('p_dup', fakeHandle('project-a-copy', 'B'))).toBe(false);
  });

  it('answers false when nothing is linked under that id', async () => {
    expect(await isSameLinkedFolder('p_unknown', fakeHandle('x', 'x'))).toBe(false);
  });
});

describe('orphan handles', () => {
  it('lists a handle whose display row was lost, under a fallback label', async () => {
    await link('p_orphan', 'orphan-folder');
    const rows = await listLinkedProjects();
    const hit = rows.find(r => r.id === 'p_orphan');
    expect(hit).toBeTruthy();
    expect(hit!.name).toBe('Untitled project');
  });
});
