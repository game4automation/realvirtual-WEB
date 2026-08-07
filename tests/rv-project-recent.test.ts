// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Recent projects — the list behind the dashboard's PROJECTS group.
 *
 * Split out of the former rv-project-scoping.test.ts by plan-372 Phase 13.
 * `rv-project-recent.ts` survives that phase and would otherwise have been
 * left with no coverage at all.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FakeDir, asDirHandle } from './helpers/fake-fs-handles';
import { createProjectFromScenes } from '../src/core/project/rv-project-create';
import {
  LS_KEY_RECENT_PROJECTS,
  MAX_RECENT_PROJECTS,
  forgetRecentProject,
  listAvailableRecentProjects,
  readRecentProjects,
  recordRecentProject,
} from '../src/core/project/rv-project-recent';
import {
  deleteStoredHandle,
  projectHandleKey,
  putHandle,
} from '../src/core/engine/rv-local-filesystem';
import { clearAllScenes, readScene, writeScene } from '../src/core/hmi/scene/rv-scene-storage';
import { sceneRelPathFor } from '../src/core/project/rv-project-types';
import type { RvScene } from '../src/core/hmi/scene/rv-scene-types';

// ─── Fixtures ───────────────────────────────────────────────────────────

const scene = (id: string, name: string): RvScene => ({
  id,
  name,
  createdAt: '2025-01-01T00:00:00.000Z',
  modifiedAt: '2025-01-01T00:00:00.000Z',
  schemaVersion: 2,
  base: { kind: 'empty' },
  edits: { ops: [], settings: { catalogUrls: [], gridSizeMm: 500 } },
});

const meta = (id: string) => ({ id, name: id });

/** A plain object survives IndexedDB's structured clone; a FakeDir does not. */
const cloneableHandle = (name: string) =>
  ({ name, kind: 'directory' }) as unknown as FileSystemDirectoryHandle;

beforeEach(() => {
  clearAllScenes();
  localStorage.removeItem(LS_KEY_RECENT_PROJECTS);
});

afterEach(() => {
  clearAllScenes();
  localStorage.removeItem(LS_KEY_RECENT_PROJECTS);
});

// ─── scopeSceneMetas ────────────────────────────────────────────────────

describe('recent projects', () => {
  it('starts empty and tolerates junk in localStorage', () => {
    expect(readRecentProjects()).toEqual([]);
    localStorage.setItem(LS_KEY_RECENT_PROJECTS, 'not json');
    expect(readRecentProjects()).toEqual([]);
    localStorage.setItem(LS_KEY_RECENT_PROJECTS, '{"nope":1}');
    expect(readRecentProjects()).toEqual([]);
  });

  it('moves a re-opened project to the front instead of duplicating it', () => {
    recordRecentProject({ id: 'prj_a', name: 'A' });
    recordRecentProject({ id: 'prj_b', name: 'B' });
    recordRecentProject({ id: 'prj_a', name: 'A renamed' });

    const rows = readRecentProjects();
    expect(rows.map(r => r.id)).toEqual(['prj_a', 'prj_b']);
    expect(rows[0].name).toBe('A renamed');
  });

  it('caps the list', () => {
    for (let i = 0; i < MAX_RECENT_PROJECTS + 5; i++) {
      recordRecentProject({ id: `prj_${i}`, name: `P${i}` });
    }
    expect(readRecentProjects()).toHaveLength(MAX_RECENT_PROJECTS);
  });

  it('forgets one project and leaves the rest', () => {
    recordRecentProject({ id: 'prj_a', name: 'A' });
    recordRecentProject({ id: 'prj_b', name: 'B' });
    forgetRecentProject('prj_a');
    expect(readRecentProjects().map(r => r.id)).toEqual(['prj_b']);
  });

  it('lists only projects that still have a stored handle', async () => {
    recordRecentProject({ id: 'prj_live', name: 'Live', folderName: 'live-folder' });
    recordRecentProject({ id: 'prj_dead', name: 'Dead' });
    await putHandle(cloneableHandle('live-folder'), projectHandleKey('prj_live'));
    try {
      const ids = (await listAvailableRecentProjects()).map(r => r.id);
      // A display row without a handle cannot be reopened, so it must not be
      // offered — clicking it would do nothing. (Asserted per id rather than as
      // a whole list: the handle store is one shared IndexedDB and sibling test
      // files legitimately leave their own project handles in it.)
      expect(ids).toContain('prj_live');
      expect(ids).not.toContain('prj_dead');
      const live = (await listAvailableRecentProjects()).find(r => r.id === 'prj_live')!;
      expect(live.folderName).toBe('live-folder');
    } finally {
      await deleteStoredHandle(projectHandleKey('prj_live'));
    }
  });

  it('still offers a handle whose display row was lost', async () => {
    await putHandle(cloneableHandle('orphan'), projectHandleKey('prj_orphan'));
    try {
      const rows = await listAvailableRecentProjects();
      expect(rows.map(r => r.id)).toContain('prj_orphan');
    } finally {
      await deleteStoredHandle(projectHandleKey('prj_orphan'));
    }
  });
});
