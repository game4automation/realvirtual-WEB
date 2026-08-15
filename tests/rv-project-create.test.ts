// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * createProjectFromScenes — "New Project from current scenes…".
 *
 * Split out of the former rv-project-scoping.test.ts by plan-372 Phase 13:
 * that file also covered `rv-project-scoping.ts`, which the phase deletes, and
 * this coverage must outlive it. The subject module is untouched.
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
import {
  RV_PROJECT_SCHEMA_VERSION,
  sceneGlbRelPathFor,
} from '../src/core/project/rv-project-types';
import { sceneDocumentsOf } from '../src/core/project/rv-project-documents';
import type { RvScene } from '../src/core/hmi/scene/rv-scene-types';

// ─── Fixtures ───────────────────────────────────────────────────────────

const scene = (id: string, name: string): RvScene => ({
  id,
  name,
  createdAt: '2025-01-01T00:00:00.000Z',
  modifiedAt: '2025-01-01T00:00:00.000Z',
  schemaVersion: 3,
  base: { kind: 'empty' },
  edits: { ops: [], settings: { catalogUrls: [], gridSizeMm: 500 } },
});

const meta = (id: string) => ({ id, name: id });

/**
 * The GLB bodies the migration will find, keyed by scene id.
 *
 * Since plan-413 phase 6 a scene the user selects has to have BYTES, not just a
 * catalogue row: the row alone describes a body it does not carry, so writing
 * it into the new project would produce a card that opens to nothing. The
 * injected reader stands in for the OPFS store.
 */
let bodies: Map<string, Uint8Array>;

function seedBody(id: string, marker = id): void {
  bodies.set(id, new TextEncoder().encode('glb:' + marker));
}

const readSceneGlb = async (id: string) => bodies.get(id) ?? null;

/** Every option the migration needs to see the seeded bodies. */
const withBodies = <T extends Record<string, unknown>>(opts?: T) =>
  ({ ...(opts ?? {}), readSceneGlb }) as T & { readSceneGlb: typeof readSceneGlb };

/** A plain object survives IndexedDB's structured clone; a FakeDir does not. */
const cloneableHandle = (name: string) =>
  ({ name, kind: 'directory' }) as unknown as FileSystemDirectoryHandle;

beforeEach(() => {
  bodies = new Map();
  clearAllScenes();
  localStorage.removeItem(LS_KEY_RECENT_PROJECTS);
});

afterEach(() => {
  clearAllScenes();
  localStorage.removeItem(LS_KEY_RECENT_PROJECTS);
});

// ─── scopeSceneMetas ────────────────────────────────────────────────────

describe('createProjectFromScenes', () => {
  it('writes a manifest and one file per selected scene', async () => {
    const a = scene('scn_a', 'Cell A');
    const b = scene('scn_b', 'Cell B');
    writeScene(a);
    seedBody(a.id);
    writeScene(b);
    seedBody(b.id);
    const dir = new FakeDir('my-project');

    const result = await createProjectFromScenes(
      asDirHandle(dir), 'My project', ['scn_a', 'scn_b'], withBodies());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.written).toEqual(['scn_a', 'scn_b']);
    expect(result.project.name).toBe('My project');
    expect(dir.has('project.json')).toBe(true);

    const manifest = JSON.parse((await dir.readText('project.json'))!);
    expect(manifest.schemaVersion).toBe(RV_PROJECT_SCHEMA_VERSION);
    expect(sceneDocumentsOf(manifest).map(e => e.id)).toEqual(['scn_a', 'scn_b']);

    // Bodies before manifest: every path the manifest references exists.
    for (const entry of sceneDocumentsOf(manifest)) {
      const file = entry.path.split('/')[1];
      expect(await dir.readTextAt('scenes', file)).toBeTruthy();
    }
  });

  it('leaves the browser cache completely intact', async () => {
    writeScene(scene('scn_a', 'Cell A'));
    seedBody('scn_a');
    const dir = new FakeDir('my-project');

    await createProjectFromScenes(asDirHandle(dir), 'My project', ['scn_a'], withBodies());

    // The migration copies. Clearing the cache here would be exactly the kind
    // of "helpful" destruction R2 forbids.
    expect(readScene('scn_a')).toBeTruthy();
    expect(readScene('scn_a')!.name).toBe('Cell A');
  });

  it('writes only the selected subset', async () => {
    writeScene(scene('scn_a', 'Cell A'));
    seedBody('scn_a');
    writeScene(scene('scn_b', 'Cell B'));
    seedBody('scn_b');
    const dir = new FakeDir('my-project');

    const result = await createProjectFromScenes(
      asDirHandle(dir), 'Subset', ['scn_b'], withBodies());

    expect(result.ok).toBe(true);
    const manifest = JSON.parse((await dir.readText('project.json'))!);
    expect(sceneDocumentsOf(manifest).map(e => e.id)).toEqual(['scn_b']);
    // …and the unselected scene is still cached.
    expect(readScene('scn_a')).toBeTruthy();
  });

  it('reports ids whose body is not cached instead of writing a stub', async () => {
    writeScene(scene('scn_a', 'Cell A'));
    seedBody('scn_a');
    const dir = new FakeDir('my-project');

    const result = await createProjectFromScenes(
      asDirHandle(dir), 'P', ['scn_a', 'scn_gone'], withBodies());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.written).toEqual(['scn_a']);
    expect(result.skipped).toEqual(['scn_gone']);
  });

  it('skips a row whose GLB body is missing rather than writing a card with nothing behind it', async () => {
    writeScene(scene('scn_a', 'Cell A'));
    seedBody('scn_a');
    writeScene(scene('scn_bodyless', 'No bytes'));   // …deliberately no body
    const dir = new FakeDir('my-project');

    const result = await createProjectFromScenes(
      asDirHandle(dir), 'P', ['scn_a', 'scn_bodyless'], withBodies());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.written).toEqual(['scn_a']);
    expect(result.skipped).toEqual(['scn_bodyless']);
  });

  it('refuses a folder that already holds a project and changes nothing', async () => {
    const dir = new FakeDir('existing');
    dir.seedText('project.json', JSON.stringify({
      schemaVersion: 1, id: 'prj_old', name: 'Existing project',
    }));
    writeScene(scene('scn_a', 'Cell A'));
    seedBody('scn_a');

    const result = await createProjectFromScenes(
      asDirHandle(dir), 'New', ['scn_a'], withBodies());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('project-exists');
    expect(result.message).toContain('Existing project');
    // Untouched: same manifest, no scenes/ folder created.
    const manifest = JSON.parse((await dir.readText('project.json'))!);
    expect(manifest.id).toBe('prj_old');
    expect(dir.has('scenes')).toBe(false);
  });

  it('adds to a non-empty foreign folder without disturbing it', async () => {
    const dir = new FakeDir('customer-cad');
    dir.seedText('README.txt', 'do not touch');
    const spec = dir.seedDir('spec');
    spec.seedText('layout.pdf', 'binary-ish');
    writeScene(scene('scn_a', 'Cell A'));
    seedBody('scn_a');

    const result = await createProjectFromScenes(
      asDirHandle(dir), 'Added', ['scn_a'], withBodies());

    expect(result.ok).toBe(true);
    expect(await dir.readText('README.txt')).toBe('do not touch');
    expect(await dir.readTextAt('spec', 'layout.pdf')).toBe('binary-ish');
    expect(dir.has('project.json')).toBe(true);
  });

  it('records activeSceneId only when that scene was actually written', async () => {
    writeScene(scene('scn_a', 'Cell A'));
    seedBody('scn_a');
    const dir = new FakeDir('p1');
    await createProjectFromScenes(
      asDirHandle(dir), 'P', ['scn_a'], withBodies({ activeSceneId: 'scn_a' }));
    expect(JSON.parse((await dir.readText('project.json'))!).activeSceneId).toBe('scn_a');

    writeScene(scene('scn_b', 'Cell B'));
    seedBody('scn_b');
    const dir2 = new FakeDir('p2');
    await createProjectFromScenes(
      asDirHandle(dir2), 'P', ['scn_b'], withBodies({ activeSceneId: 'scn_missing' }));
    expect(JSON.parse((await dir2.readText('project.json'))!).activeSceneId).toBeNull();
  });

  it('falls back to the folder name when no name is given', async () => {
    writeScene(scene('scn_a', 'Cell A'));
    seedBody('scn_a');
    const dir = new FakeDir('warehouse-2');
    const result = await createProjectFromScenes(
      asDirHandle(dir), '   ', ['scn_a'], withBodies());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.project.name).toBe('warehouse-2');
  });

  it('derives filenames from the id, so two same-named scenes cannot collide (RR1)', async () => {
    const a = scene('scn_a', 'Cell');
    const b = scene('scn_b', 'Cell');
    writeScene(a);
    seedBody(a.id);
    writeScene(b);
    seedBody(b.id);
    const dir = new FakeDir('p');

    await createProjectFromScenes(asDirHandle(dir), 'P', ['scn_a', 'scn_b'], withBodies());

    expect(sceneGlbRelPathFor(a)).not.toBe(sceneGlbRelPathFor(b));
    const manifest = JSON.parse((await dir.readText('project.json'))!);
    const paths = sceneDocumentsOf(manifest).map(e => e.path);
    expect(new Set(paths).size).toBe(2);
  });
});

// ─── Recent projects ────────────────────────────────────────────────────
