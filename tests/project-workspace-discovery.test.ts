// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * project-workspace-discovery.test — plan-372 §9.17 (Phase 3).
 *
 * The workspace is one pick, one `readwrite` grant, one handle, and the
 * project list is a plain directory listing of its direct children. What this
 * file pins:
 *
 *  - a subfolder **with** `project.json` is a project; one **without** is not,
 *    and that is not an error — a workspace also holds notes and exports;
 *  - an empty workspace yields an empty list, never a throw;
 *  - a subfolder whose `project.json` cannot be parsed is skipped and reported
 *    **once**, because "silently missing" and "not a project" must not look
 *    the same to the user;
 *  - **one grant covers everything:** `queryPermission` is never called on a
 *    subfolder. Per-project re-grants would mean one browser prompt per
 *    project after every reload, which is exactly what §2.2.4 rules out;
 *  - projects **outside** the workspace reach the menu only through *Recent*,
 *    and `forgetRecentProject()` drops exactly one of them while leaving the
 *    workspace listing untouched;
 *  - **§9.27 coupling:** a discovered, never-activated backend does not write.
 *    Discovery builds one backend per candidate folder against a global,
 *    unscoped mutation bus; if one of them could write, every save would land
 *    in every folder.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { glbWriteFor } from './helpers/scene-write';
import { FakeDir, asDirHandle } from './helpers/fake-fs-handles';
import { discoverWorkspaceProjects } from '../src/core/project/rv-project-workspace';
import { BackendNotWritableError } from '../src/core/project/backends/project-backend';
import {
  LS_KEY_RECENT_PROJECTS,
  forgetRecentProject,
  readRecentProjects,
  recordRecentProject,
} from '../src/core/project/rv-project-recent';
import type { RvScene } from '../src/core/hmi/scene/rv-scene-types';
import { sceneDocumentsOf } from '../src/core/project/rv-project-documents';
import { writeSceneDocument, writeBlobDocument } from './helpers/document-io';

// ─── Fixtures ───────────────────────────────────────────────────────────

function manifestText(id: string, name: string): string {
  return JSON.stringify({
    schemaVersion: 1,
    id,
    name,
    canonicalName: undefined,
    scenes: [],
    activeSceneId: null,
  });
}

/** Seed a project subfolder inside `root`. */
function seedProject(root: FakeDir, folder: string, id: string, name: string): FakeDir {
  const dir = root.seedDir(folder);
  dir.seedText('project.json', manifestText(id, name));
  return dir;
}

const scene = (id: string): RvScene => ({
  id,
  name: id,
  createdAt: '2025-01-01T00:00:00.000Z',
  modifiedAt: '2025-01-01T00:00:00.000Z',
  schemaVersion: 3,
  base: { kind: 'empty' },
  edits: { ops: [], settings: { catalogUrls: [], gridSizeMm: 500 } },
});

beforeEach(() => {
  localStorage.removeItem(LS_KEY_RECENT_PROJECTS);
});

// ─── Discovery = a directory listing ────────────────────────────────────

describe('discoverWorkspaceProjects — what counts as a project', () => {
  it('lists every direct subfolder that holds a project.json', async () => {
    const root = new FakeDir('workspace');
    seedProject(root, 'alpha', 'prj_a', 'Alpha Line');
    seedProject(root, 'beta', 'prj_b', 'Beta Cell');

    const found = await discoverWorkspaceProjects(asDirHandle(root));

    expect(found.projects.map(p => p.id)).toEqual(['prj_a', 'prj_b']);
    expect(found.projects.map(p => p.folderName)).toEqual(['alpha', 'beta']);
    expect(found.warnings).toEqual([]);
  });

  it('ignores a folder without a project.json — silently, not as an error', async () => {
    const root = new FakeDir('workspace');
    seedProject(root, 'alpha', 'prj_a', 'Alpha');
    root.seedDir('exports').seedText('notes.txt', 'scratch');
    root.seedDir('empty-folder');

    const found = await discoverWorkspaceProjects(asDirHandle(root));

    expect(found.projects.map(p => p.folderName)).toEqual(['alpha']);
    expect(found.warnings).toEqual([]);
  });

  it('ignores loose files at the workspace root', async () => {
    const root = new FakeDir('workspace');
    root.seedText('README.md', '# workspace');
    root.seedText('project.json', manifestText('prj_root', 'Root'));
    seedProject(root, 'alpha', 'prj_a', 'Alpha');

    const found = await discoverWorkspaceProjects(asDirHandle(root));

    // The root's own manifest is not a child project; only subfolders count.
    expect(found.projects.map(p => p.id)).toEqual(['prj_a']);
  });

  it('does not recurse — a project nested two levels deep is not listed', async () => {
    const root = new FakeDir('workspace');
    const outer = root.seedDir('customers');
    seedProject(outer, 'deep', 'prj_deep', 'Deep');

    const found = await discoverWorkspaceProjects(asDirHandle(root));

    expect(found.projects).toEqual([]);
    expect(found.warnings).toEqual([]);
  });

  it('returns an empty list for an empty workspace instead of throwing', async () => {
    const root = new FakeDir('workspace');

    const found = await discoverWorkspaceProjects(asDirHandle(root));

    expect(found.projects).toEqual([]);
    expect(found.warnings).toEqual([]);
  });

  it('derives the slug from the manifest name when canonicalName is absent', async () => {
    const root = new FakeDir('workspace');
    seedProject(root, 'a', 'prj_a', 'Customer X — Line 3!');

    const found = await discoverWorkspaceProjects(asDirHandle(root));

    // CONNECT ProjectPaths.ValidateProjectName rules (§2.2.3).
    expect(found.projects[0].slug).toBe('customer-x-line-3');
  });
});

// ─── Broken manifests ───────────────────────────────────────────────────

describe('discoverWorkspaceProjects — a broken manifest', () => {
  it('skips the folder and reports it exactly once', async () => {
    const root = new FakeDir('workspace');
    seedProject(root, 'alpha', 'prj_a', 'Alpha');
    root.seedDir('broken').seedText('project.json', '{ this is not json');

    const found = await discoverWorkspaceProjects(asDirHandle(root));

    expect(found.projects.map(p => p.id)).toEqual(['prj_a']);
    expect(found.warnings).toHaveLength(1);
    expect(found.warnings[0]).toContain('broken');
  });

  it('reports one warning per broken folder, and no more', async () => {
    const root = new FakeDir('workspace');
    root.seedDir('broken-a').seedText('project.json', 'nope');
    root.seedDir('broken-b').seedText('project.json', '[]');
    seedProject(root, 'good', 'prj_g', 'Good');

    const found = await discoverWorkspaceProjects(asDirHandle(root));

    expect(found.projects.map(p => p.id)).toEqual(['prj_g']);
    expect(found.warnings).toHaveLength(2);
  });

  it('keeps a broken folder distinguishable from a plain non-project folder', async () => {
    const root = new FakeDir('workspace');
    root.seedDir('broken').seedText('project.json', '<<<');
    root.seedDir('just-a-folder');

    const found = await discoverWorkspaceProjects(asDirHandle(root));

    expect(found.projects).toEqual([]);
    expect(found.warnings).toHaveLength(1);
    expect(found.warnings[0]).toContain('broken');
    expect(found.warnings[0]).not.toContain('just-a-folder');
  });
});

// ─── One grant, not one per project ─────────────────────────────────────

describe('discoverWorkspaceProjects — permissions', () => {
  it('never calls queryPermission on a subfolder', async () => {
    const root = new FakeDir('workspace');
    const a = seedProject(root, 'alpha', 'prj_a', 'Alpha');
    const b = seedProject(root, 'beta', 'prj_b', 'Beta');
    a.queryPermissionCalls = 0;
    b.queryPermissionCalls = 0;

    const found = await discoverWorkspaceProjects(asDirHandle(root));

    expect(found.projects).toHaveLength(2);
    expect(a.queryPermissionCalls).toBe(0);
    expect(b.queryPermissionCalls).toBe(0);
  });

  it('never prompts for a permission during discovery', async () => {
    const root = new FakeDir('workspace');
    const a = seedProject(root, 'alpha', 'prj_a', 'Alpha');
    const b = seedProject(root, 'beta', 'prj_b', 'Beta');

    await discoverWorkspaceProjects(asDirHandle(root));

    expect(root.requestPermissionCalls).toBe(0);
    expect(a.requestPermissionCalls).toBe(0);
    expect(b.requestPermissionCalls).toBe(0);
  });

  it('scales the grant cost with the workspace, not with the project count', async () => {
    const root = new FakeDir('workspace');
    const subs = ['a', 'b', 'c', 'd', 'e'].map((n, i) =>
      seedProject(root, n, `prj_${i}`, `P${i}`),
    );
    root.queryPermissionCalls = 0;

    await discoverWorkspaceProjects(asDirHandle(root));

    // Discovery itself asks nothing; the single grant was taken at pick time.
    expect(root.queryPermissionCalls).toBe(0);
    expect(subs.reduce((n, s) => n + s.queryPermissionCalls, 0)).toBe(0);
  });
});

// ─── Discovered backends stay inert (§2.2.1b / §9.27 coupling) ──────────

describe('discoverWorkspaceProjects — the backends it constructs', () => {
  it('constructs them read-only, inactive and without a writer', async () => {
    const root = new FakeDir('workspace');
    seedProject(root, 'alpha', 'prj_a', 'Alpha');

    const [entry] = (await discoverWorkspaceProjects(asDirHandle(root))).projects;

    expect(entry.backend.isActive).toBe(false);
    expect(entry.backend.writable).toBe(false);
    expect(entry.backend.hasWriter).toBe(false);
  });

  it('refuses every write from a discovered, never-activated backend', async () => {
    const root = new FakeDir('workspace');
    seedProject(root, 'alpha', 'prj_a', 'Alpha');

    const [entry] = (await discoverWorkspaceProjects(asDirHandle(root))).projects;

    await expect(writeSceneDocument(entry.backend, 'scenes/x.scene.glb', glbWriteFor(scene('scn_x'))))
      .rejects.toBeInstanceOf(BackendNotWritableError);
    await expect(writeBlobDocument(entry.backend, 'models/x.glb', new Blob(['x'])))
      .rejects.toBeInstanceOf(BackendNotWritableError);
    await expect(entry.backend.deleteDocument('scenes/x.scene.glb'))
      .rejects.toBeInstanceOf(BackendNotWritableError);
  });

  it('leaves the folder byte-identical after a refused write', async () => {
    const root = new FakeDir('workspace');
    const dir = seedProject(root, 'alpha', 'prj_a', 'Alpha');
    const before = dir.childNames();

    const [entry] = (await discoverWorkspaceProjects(asDirHandle(root))).projects;
    await writeSceneDocument(entry.backend, 'scenes/x.scene.glb', glbWriteFor(scene('scn_x'))).catch(() => {});

    expect(dir.childNames()).toEqual(before);
    expect(dir.has('scenes')).toBe(false);
  });

  it('still reads — discovery is read-only, not inert to reads', async () => {
    const root = new FakeDir('workspace');
    seedProject(root, 'alpha', 'prj_a', 'Alpha');

    const [entry] = (await discoverWorkspaceProjects(asDirHandle(root))).projects;

    expect((await entry.backend.readManifest())?.id).toBe('prj_a');
    expect(sceneDocumentsOf(await entry.backend.readManifest())).toEqual([]);
  });
});

// ─── Recent carries what the workspace cannot ───────────────────────────

describe('Recent — projects outside the workspace', () => {
  it('does not appear in a workspace listing', async () => {
    const root = new FakeDir('workspace');
    seedProject(root, 'inside', 'prj_in', 'Inside');
    recordRecentProject({ id: 'prj_out', name: 'Outside', folderName: 'elsewhere' });

    const found = await discoverWorkspaceProjects(asDirHandle(root));

    expect(found.projects.map(p => p.id)).toEqual(['prj_in']);
    expect(readRecentProjects().map(e => e.id)).toEqual(['prj_out']);
  });

  it('forgetRecentProject removes exactly one entry', () => {
    recordRecentProject({ id: 'prj_a', name: 'A' });
    recordRecentProject({ id: 'prj_b', name: 'B' });
    recordRecentProject({ id: 'prj_c', name: 'C' });

    forgetRecentProject('prj_b');

    expect(readRecentProjects().map(e => e.id).sort()).toEqual(['prj_a', 'prj_c']);
  });

  it('forgetRecentProject leaves the workspace listing untouched', async () => {
    const root = new FakeDir('workspace');
    seedProject(root, 'alpha', 'prj_a', 'Alpha');
    seedProject(root, 'beta', 'prj_b', 'Beta');
    recordRecentProject({ id: 'prj_a', name: 'Alpha (also recent)' });

    forgetRecentProject('prj_a');

    const found = await discoverWorkspaceProjects(asDirHandle(root));
    expect(found.projects.map(p => p.id)).toEqual(['prj_a', 'prj_b']);
    expect(readRecentProjects()).toEqual([]);
  });

  it('forgetting an unknown id is a no-op, not a throw', () => {
    recordRecentProject({ id: 'prj_a', name: 'A' });

    expect(() => forgetRecentProject('nope')).not.toThrow();
    expect(readRecentProjects().map(e => e.id)).toEqual(['prj_a']);
  });
});
