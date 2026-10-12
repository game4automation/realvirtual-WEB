// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * The project list behind the dashboard's PROJECTS group.
 *
 * Split out of the former rv-project-scoping.test.ts by plan-372 Phase 13 and
 * retargeted by plan-743, which turned the capped "recent projects" cache into
 * the uncapped, authoritative LINKED list. The cases here are the ones that
 * survived that change unchanged in meaning — junk tolerance, upsert instead of
 * duplicate, the handle intersection and the orphan fallback. The behaviour
 * that is new (sorting, `linkedAt`, unlink/relink, the duplicate guard) is
 * covered in `rv-project-linked.test.ts`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  LS_KEY_LINKED_PROJECTS,
  forgetLinkedRow,
  listLinkedProjects,
  readLinkedProjects,
  recordLinkedProject,
} from '../src/core/project/rv-project-linked';
import {
  deleteStoredHandle,
  projectHandleKey,
  putHandle,
} from '../src/core/engine/rv-local-filesystem';
import { clearAllScenes } from '../src/core/hmi/scene/rv-scene-storage';

// ─── Fixtures ───────────────────────────────────────────────────────────

/** A plain object survives IndexedDB's structured clone; a FakeDir does not. */
const cloneableHandle = (name: string) =>
  ({ name, kind: 'directory' }) as unknown as FileSystemDirectoryHandle;

beforeEach(() => {
  clearAllScenes();
  localStorage.removeItem(LS_KEY_LINKED_PROJECTS);
});

afterEach(() => {
  clearAllScenes();
  localStorage.removeItem(LS_KEY_LINKED_PROJECTS);
});

describe('linked projects', () => {
  it('starts empty and tolerates junk in localStorage', () => {
    expect(readLinkedProjects()).toEqual([]);
    localStorage.setItem(LS_KEY_LINKED_PROJECTS, 'not json');
    expect(readLinkedProjects()).toEqual([]);
    localStorage.setItem(LS_KEY_LINKED_PROJECTS, '{"nope":1}');
    expect(readLinkedProjects()).toEqual([]);
  });

  it('updates a re-opened project instead of duplicating it', () => {
    recordLinkedProject({ id: 'prj_a', name: 'A' });
    recordLinkedProject({ id: 'prj_b', name: 'B' });
    recordLinkedProject({ id: 'prj_a', name: 'A renamed' });

    const rows = readLinkedProjects();
    expect(rows.map(r => r.id).sort()).toEqual(['prj_a', 'prj_b']);
    expect(rows.find(r => r.id === 'prj_a')!.name).toBe('A renamed');
  });

  it('does not cap the list', () => {
    for (let i = 0; i < 25; i++) {
      recordLinkedProject({ id: `prj_${i}`, name: `P${i}` });
    }
    expect(readLinkedProjects()).toHaveLength(25);
  });

  it('forgets one row and leaves the rest', () => {
    recordLinkedProject({ id: 'prj_a', name: 'A' });
    recordLinkedProject({ id: 'prj_b', name: 'B' });
    forgetLinkedRow('prj_a');
    expect(readLinkedProjects().map(r => r.id)).toEqual(['prj_b']);
  });

  it('lists only projects that still have a stored handle', async () => {
    recordLinkedProject({ id: 'prj_live', name: 'Live', folderName: 'live-folder' });
    recordLinkedProject({ id: 'prj_dead', name: 'Dead' });
    await putHandle(cloneableHandle('live-folder'), projectHandleKey('prj_live'));
    try {
      const ids = (await listLinkedProjects()).map(r => r.id);
      // A display row without a handle cannot be reopened, so it must not be
      // offered — clicking it would do nothing. (Asserted per id rather than as
      // a whole list: the handle store is one shared IndexedDB and sibling test
      // files legitimately leave their own project handles in it.)
      expect(ids).toContain('prj_live');
      expect(ids).not.toContain('prj_dead');
      const live = (await listLinkedProjects()).find(r => r.id === 'prj_live')!;
      expect(live.folderName).toBe('live-folder');
    } finally {
      await deleteStoredHandle(projectHandleKey('prj_live'));
    }
  });

  it('still offers a handle whose display row was lost', async () => {
    await putHandle(cloneableHandle('orphan'), projectHandleKey('prj_orphan'));
    try {
      const rows = await listLinkedProjects();
      expect(rows.map(r => r.id)).toContain('prj_orphan');
    } finally {
      await deleteStoredHandle(projectHandleKey('prj_orphan'));
    }
  });
});
