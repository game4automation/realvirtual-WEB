// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * project-store.test — opening a project, lazy hydration and the two
 * cross-cutting risks the review flagged as blockers.
 *
 *  - **RR2:** with lazy hydration a project scene is not in the cache when
 *    the user clicks it, and `openScene()` throws `Scene <id> not found`.
 *    Both unguarded callers (the Models-panel row and the `web_scene_open`
 *    MCP tool) go through `SceneStore.openScene()`, so the pre-fetch hook
 *    installed here is what keeps them working.
 *  - **RR4:** `rv-scenes/draft/<baseKey>` carries no project reference, so
 *    an unsaved draft made in project A would resurrect in project B.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FakeDir, asDirHandle } from './helpers/fake-fs-handles';
import { ProjectStore, resetProjectStore } from '../src/core/project/project-store';
import { clearSceneMutationListeners } from '../src/core/hmi/scene/rv-scene-mutations';
import {
  clearAllScenes,
  clearDraftsForScope,
  getDraftScope,
  readActiveId,
  readDraft,
  readScene,
  readSceneDraft,
  setDraftScope,
  writeDraft,
  writeSceneDraft,
} from '../src/core/hmi/scene/rv-scene-storage';
import { sceneRelPathFor, type RvProject } from '../src/core/project/rv-project-types';
import type { RvScene, SceneBase } from '../src/core/hmi/scene/rv-scene-types';

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

/** Build a folder holding a manifest plus the given scene bodies. */
function makeFolder(project: Partial<RvProject>, bodies: RvScene[] = []): FakeDir {
  const root = new FakeDir('customer-project');
  const manifest: RvProject = {
    schemaVersion: 1,
    id: 'prj_1',
    name: 'Customer project',
    ...project,
  } as RvProject;
  root.seedText('project.json', JSON.stringify(manifest));
  if (bodies.length > 0) {
    const scenes = root.seedDir('scenes');
    for (const b of bodies) {
      scenes.seedText(sceneRelPathFor(b).split('/')[1], JSON.stringify(b));
    }
  }
  return root;
}

function entryFor(s: RvScene) {
  return { id: s.id, name: s.name, path: sceneRelPathFor(s), baseKind: s.base.kind };
}

let store: ProjectStore;
const opened: ProjectStore[] = [];

beforeEach(() => {
  clearSceneMutationListeners();
  clearAllScenes();
  setDraftScope(null);
  localStorage.removeItem('rv-project/last');
  resetProjectStore();
  store = new ProjectStore();
  opened.length = 0;
  opened.push(store);
});

afterEach(async () => {
  for (const s of opened) await s.closeProject();
  clearSceneMutationListeners();
  clearAllScenes();
  setDraftScope(null);
});

// ─── Open ───────────────────────────────────────────────────────────────

describe('openProjectFolder', () => {
  it('opens a folder that has a manifest', async () => {
    const root = makeFolder({ name: 'Demo' });
    expect(await store.openProjectFolder(asDirHandle(root))).toBe(true);
    expect(store.getProject()?.name).toBe('Demo');
    expect(store.isWritable()).toBe(true);
    expect(store.getSnapshot().folderName).toBe('customer-project');
  });

  it('migrates a legacy deploy manifest on open (R4 — Phase 1 precedes the CLI migrator)', async () => {
    const root = new FakeDir('toray');
    root.seedText('project.json', JSON.stringify({ name: 'Toray', code: 'toray' }));
    expect(await store.openProjectFolder(asDirHandle(root))).toBe(true);
    expect(store.getProject()?.code).toBe('toray');
    expect(store.getProject()?.schemaVersion).toBe(1);
  });

  it('refuses a folder without a manifest unless asked to create one', async () => {
    const root = new FakeDir('empty-folder');
    expect(await store.openProjectFolder(asDirHandle(root))).toBe(false);
    expect(store.getProject()).toBeNull();
    expect(store.getSnapshot().warnings.join(' ')).toContain('No readable project.json');
    // R2 — nothing was written into the stranger's folder.
    expect(root.childNames()).toEqual([]);
  });

  it('creates a manifest when explicitly asked', async () => {
    const root = new FakeDir('new-folder');
    expect(await store.openProjectFolder(asDirHandle(root), { createIfMissing: true })).toBe(true);
    expect(root.has('project.json')).toBe(true);
    expect(store.getProject()?.name).toBe('new-folder');
  });

  it('degrades to read-only when write access is declined, instead of throwing', async () => {
    const root = makeFolder({});
    root.permissions.readwrite = 'denied';
    expect(await store.openProjectFolder(asDirHandle(root))).toBe(true);
    expect(store.isWritable()).toBe(false);
    expect(store.getSnapshot().warnings.join(' ')).toContain('read-only');
  });

  it('will not create a project in a folder it cannot write to', async () => {
    const root = new FakeDir('ro');
    root.permissions.readwrite = 'denied';
    expect(await store.openProjectFolder(asDirHandle(root), { createIfMissing: true })).toBe(false);
    expect(root.has('project.json')).toBe(false);
  });
});

// ─── Conditional load steps (§1.1 R1) ───────────────────────────────────

describe('every load step is conditional', () => {
  it('a project of only project.json + scenes/ opens without a NotFoundError', async () => {
    const s = scene('scn_a', 'A');
    const root = makeFolder({ scenes: [entryFor(s)] }, [s]);
    // No docs/, aasx/, connect/, rag/, settings/ anywhere.
    await expect(store.openProjectFolder(asDirHandle(root))).resolves.toBe(true);
    expect(store.getSnapshot().warnings).toEqual([]);
  });

  it('a manifest with no scenes[] at all opens cleanly', async () => {
    const root = makeFolder({});
    expect(await store.openProjectFolder(asDirHandle(root))).toBe(true);
    expect(store.getProjectSceneIds().size).toBe(0);
  });

  it('applies a settings bundle when one is present', async () => {
    const s = scene('scn_a', 'A');
    const root = makeFolder({
      scenes: [entryFor(s)],
      settingsRef: { ref: 'settings/project-settings.json' },
    }, [s]);
    root.seedDir('settings').seedText(
      'project-settings.json',
      JSON.stringify({
        $schema: 'rv-settings-bundle/1.0',
        exportedAt: '2025-01-01T00:00:00.000Z',
        settings: { search: { fuzzy: true } },
      }),
    );
    await store.openProjectFolder(asDirHandle(root));
    expect(localStorage.getItem('rv-search-settings')).toContain('fuzzy');
  });

  it('ignores a settings file with a foreign schema instead of applying it', async () => {
    const root = makeFolder({ settingsRef: { ref: 'settings/project-settings.json' } });
    root.seedDir('settings').seedText('project-settings.json', JSON.stringify({ $schema: 'other/9.9' }));
    await expect(store.openProjectFolder(asDirHandle(root))).resolves.toBe(true);
  });

  it('does not fail when settingsRef points at a file that is not there', async () => {
    const root = makeFolder({ settingsRef: { ref: 'settings/project-settings.json' } });
    await expect(store.openProjectFolder(asDirHandle(root))).resolves.toBe(true);
  });
});

// ─── Lazy hydration (§4b) ───────────────────────────────────────────────

describe('hydration is lazy', () => {
  it('seeds the active scene but NOT the rest', async () => {
    const a = scene('scn_a', 'A');
    const b = scene('scn_b', 'B');
    const c = scene('scn_c', 'C');
    const root = makeFolder(
      { scenes: [entryFor(a), entryFor(b), entryFor(c)], activeSceneId: 'scn_b' },
      [a, b, c],
    );

    await store.openProjectFolder(asDirHandle(root));

    expect(readScene('scn_b')).not.toBeNull();   // the active one
    expect(readScene('scn_a')).toBeNull();       // deliberately not cached
    expect(readScene('scn_c')).toBeNull();
    expect(readActiveId()).toBe('scn_b');
  });

  it('seeds nothing when the manifest declares no active scene', async () => {
    const a = scene('scn_a', 'A');
    const root = makeFolder({ scenes: [entryFor(a)] }, [a]);
    await store.openProjectFolder(asDirHandle(root));
    expect(readScene('scn_a')).toBeNull();
  });

  it('hydrateScene pulls a body on demand and keeps its id', async () => {
    const a = scene('scn_a', 'A');
    const root = makeFolder({ scenes: [entryFor(a)] }, [a]);
    await store.openProjectFolder(asDirHandle(root));

    expect(await store.hydrateScene('scn_a')).toBe(true);
    const cached = readScene('scn_a')!;
    expect(cached.id).toBe('scn_a');       // NOT a fresh id — same scene, not a copy
    expect(cached.name).toBe('A');
  });

  it('hydrateScene is a cheap no-op for an already-cached scene', async () => {
    const a = scene('scn_a', 'A');
    const root = makeFolder({ scenes: [entryFor(a)], activeSceneId: 'scn_a' }, [a]);
    await store.openProjectFolder(asDirHandle(root));
    expect(await store.hydrateScene('scn_a')).toBe(true);
  });

  it('reports an unknown id rather than inventing a scene', async () => {
    const root = makeFolder({});
    await store.openProjectFolder(asDirHandle(root));
    expect(await store.hydrateScene('scn_nope')).toBe(false);
  });

  it('surfaces a missing body file as a warning instead of failing silently', async () => {
    const a = scene('scn_a', 'A');
    const root = makeFolder({ scenes: [entryFor(a)], activeSceneId: 'scn_a' }, []);  // no body
    await store.openProjectFolder(asDirHandle(root));
    expect(store.getSnapshot().warnings.join(' ')).toContain('missing or not a valid scene');
  });

  it('exposes the project scene id set for Models-panel scoping', async () => {
    const a = scene('scn_a', 'A');
    const b = scene('scn_b', 'B');
    const root = makeFolder({ scenes: [entryFor(a), entryFor(b)] }, [a, b]);
    await store.openProjectFolder(asDirHandle(root));
    expect([...store.getProjectSceneIds()].sort()).toEqual(['scn_a', 'scn_b']);
  });
});

// ─── RR2 ────────────────────────────────────────────────────────────────

describe('RR2 — openScene() must not throw on a lazily-hydrated project scene', () => {
  /** Stand-in with the exact hook surface ProjectStore drives. */
  function fakeSceneStore() {
    let hydrator: ((id: string) => Promise<boolean>) | null = null;
    return {
      setSceneHydrator(fn: ((id: string) => Promise<boolean>) | null) { hydrator = fn; },
      refreshScenesFromStorage: vi.fn(),
      /** Mirrors the real openScene() pre-fetch + throw. */
      async openScene(id: string) {
        if (!readScene(id) && hydrator) await hydrator(id);
        if (!readScene(id)) throw new Error(`Scene ${id} not found`);
        return readScene(id)!;
      },
      hasHydrator: () => hydrator !== null,
    };
  }

  it('without the hook the click throws — the failure being guarded against', async () => {
    const a = scene('scn_a', 'A');
    const root = makeFolder({ scenes: [entryFor(a)] }, [a]);
    await store.openProjectFolder(asDirHandle(root));

    const ss = fakeSceneStore();   // NOT attached
    await expect(ss.openScene('scn_a')).rejects.toThrow('Scene scn_a not found');
  });

  it('with the hook attached the same click resolves from the folder', async () => {
    const a = scene('scn_a', 'A');
    const root = makeFolder({ scenes: [entryFor(a)] }, [a]);
    await store.openProjectFolder(asDirHandle(root));

    const ss = fakeSceneStore();
    store.attachToSceneStore(ss);
    const opened = await ss.openScene('scn_a');
    expect(opened.name).toBe('A');
  });

  it('still throws for an id the project genuinely does not have', async () => {
    const root = makeFolder({});
    await store.openProjectFolder(asDirHandle(root));
    const ss = fakeSceneStore();
    store.attachToSceneStore(ss);
    await expect(ss.openScene('scn_ghost')).rejects.toThrow('not found');
  });

  it('detaching restores the plain cache-only behaviour', async () => {
    const a = scene('scn_a', 'A');
    const root = makeFolder({ scenes: [entryFor(a)] }, [a]);
    await store.openProjectFolder(asDirHandle(root));
    const ss = fakeSceneStore();
    store.attachToSceneStore(ss);
    store.detachFromSceneStore();
    expect(ss.hasHydrator()).toBe(false);
  });
});

// ─── RR4 ────────────────────────────────────────────────────────────────

describe('RR4 — an unsaved draft from project A must not appear in project B', () => {
  const base: SceneBase = { kind: 'builtin', url: '/models/conveyor.glb', label: 'Conveyor' };

  it('scopes the per-base draft slot to the open project', async () => {
    const rootA = makeFolder({ id: 'prj_A', name: 'A' });
    await store.openProjectFolder(asDirHandle(rootA));
    expect(getDraftScope()).toBe('prj_A');

    // Unsaved edits on a built-in inside project A.
    writeDraft(base, { ...scene('draft', 'Secret work in A'), base });
    expect(readDraft(base)?.name).toBe('Secret work in A');

    // Switch to project B — same built-in, different project.
    const rootB = makeFolder({ id: 'prj_B', name: 'B' });
    const storeB = new ProjectStore();
    opened.push(storeB);
    await store.closeProject();
    await storeB.openProjectFolder(asDirHandle(rootB));

    expect(getDraftScope()).toBe('prj_B');
    expect(readDraft(base)).toBeNull();          // ← the leak, closed
  });

  it('does not leak into "no project" either', async () => {
    const rootA = makeFolder({ id: 'prj_A', name: 'A' });
    await store.openProjectFolder(asDirHandle(rootA));
    writeDraft(base, { ...scene('draft', 'Secret work in A'), base });

    await store.closeProject();

    expect(getDraftScope()).toBeNull();
    expect(readDraft(base)).toBeNull();
  });

  it('keeps the historic unscoped key when no project is open', () => {
    setDraftScope(null);
    writeDraft(base, { ...scene('draft', 'Global draft'), base });
    expect(readDraft(base)?.name).toBe('Global draft');
    expect(localStorage.getItem(`rv-scenes/draft/builtin:${encodeURIComponent(base.url)}`)).toBeTruthy();
  });

  it('a scoped draft is written under a project-prefixed key', () => {
    setDraftScope('prj_A');
    writeDraft(base, { ...scene('draft', 'Scoped'), base });
    const scopedKey = `rv-scenes/draft/prj_A:builtin:${encodeURIComponent(base.url)}`;
    expect(localStorage.getItem(scopedKey)).toBeTruthy();
    setDraftScope(null);
    expect(readDraft(base)).toBeNull();
  });

  it('clearDraftsForScope removes only that project’s drafts', () => {
    setDraftScope('prj_A');
    writeDraft(base, { ...scene('draft', 'A'), base });
    setDraftScope('prj_B');
    writeDraft(base, { ...scene('draft', 'B'), base });

    clearDraftsForScope('prj_A');

    expect(readDraft(base)?.name).toBe('B');     // still in scope B
    setDraftScope('prj_A');
    expect(readDraft(base)).toBeNull();
  });
});

// ─── Close / flush ──────────────────────────────────────────────────────

describe('closeProject', () => {
  it('drops the project and the draft scope, and keeps the cache', async () => {
    const a = scene('scn_a', 'A');
    const root = makeFolder({ scenes: [entryFor(a)], activeSceneId: 'scn_a' }, [a]);
    await store.openProjectFolder(asDirHandle(root));
    expect(readScene('scn_a')).not.toBeNull();

    await store.closeProject();

    expect(store.getProject()).toBeNull();
    expect(getDraftScope()).toBeNull();
    expect(readScene('scn_a')).not.toBeNull();   // R2 in spirit — nothing destroyed
  });

  it('is safe to call twice', async () => {
    await store.closeProject();
    await expect(store.closeProject()).resolves.toBeUndefined();
  });

  it('flush() resolves even with nothing queued', async () => {
    const root = makeFolder({});
    await store.openProjectFolder(asDirHandle(root));
    await expect(store.flush()).resolves.toBeUndefined();
  });
});

// ─── Boot restore ───────────────────────────────────────────────────────

describe('restoreLastProject', () => {
  it('is a no-op when nothing was open last session', async () => {
    expect(await store.restoreLastProject()).toBe(false);
  });

  it('is a no-op when the pointer exists but the handle does not', async () => {
    localStorage.setItem('rv-project/last', 'prj_gone');
    expect(await store.restoreLastProject()).toBe(false);
  });
});

// ─── Phase 2: conflict reconciliation (§4c) ─────────────────────────────

/**
 * Seed the cache directly rather than through `writeScene()`, which rewrites
 * `modifiedAt` to "now" — these tests need to own both timestamps.
 */
function seedCache(s: RvScene): void {
  localStorage.setItem(`rv-scenes/${s.id}`, JSON.stringify(s));
}

/**
 * `clearAllScenes()` walks the index, so a body seeded straight into
 * localStorage (which is the point of {@link seedCache}) outlives it. Wipe the
 * raw keyspace as well, or one test's fixture becomes the next one's cache.
 */
function clearRawScenes(): void {
  const doomed: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith('rv-scenes/') && k !== 'rv-scenes/active') doomed.push(k);
  }
  for (const k of doomed) localStorage.removeItem(k);
}

const OLD = '2025-01-01T10:00:00.000Z';
const NEW = '2025-06-01T10:00:00.000Z';

function entryAt(s: RvScene, modifiedAt: string) {
  return { ...entryFor(s), modifiedAt };
}

describe('conflict reconciliation on open', () => {
  beforeEach(clearRawScenes);

  it('folder newer with different content overwrites the cache', async () => {
    const cached = { ...scene('scn_a', 'Cell A'), modifiedAt: OLD };
    const onDisk = { ...scene('scn_a', 'Cell A (from git)'), modifiedAt: NEW };
    seedCache(cached);
    const root = makeFolder({ scenes: [entryAt(onDisk, NEW)] }, [onDisk]);

    await store.openProjectFolder(asDirHandle(root));

    expect(readScene('scn_a')?.name).toBe('Cell A (from git)');
  });

  it('B3 — "folder wins" also clears the draft, so openScene cannot resurrect it', async () => {
    const cached = { ...scene('scn_a', 'Cell A'), modifiedAt: OLD };
    const onDisk = { ...scene('scn_a', 'Cell A (from git)'), modifiedAt: NEW };
    seedCache(cached);
    // A stale per-saved-scene draft that matches the saved record — no unsaved
    // work, so this is a clean folder-wins, and the draft must not survive it.
    writeSceneDraft('scn_a', cached);
    const root = makeFolder({ scenes: [entryAt(onDisk, NEW)] }, [onDisk]);

    await store.openProjectFolder(asDirHandle(root));

    expect(readSceneDraft('scn_a')).toBeNull();
    // What `openScene()` would load — `readSceneDraft(id) ?? scene` — is now
    // unambiguously the folder version.
    expect((readSceneDraft('scn_a') ?? readScene('scn_a'))?.name).toBe('Cell A (from git)');
  });

  it('leaves an identical scene alone — no conflict, no prompt', async () => {
    const s = { ...scene('scn_a', 'Cell A'), modifiedAt: OLD };
    seedCache(s);
    const prompt = vi.fn();
    store.setConflictPrompt(prompt);
    // Folder is newer by timestamp but byte-identical in content: this is the
    // ordinary reopen after a hydration bumped the cache stamp.
    const root = makeFolder({ scenes: [entryAt(s, NEW)] }, [{ ...s, modifiedAt: NEW }]);

    await store.openProjectFolder(asDirHandle(root));

    expect(prompt).not.toHaveBeenCalled();
    expect(store.getLastConflicts()).toEqual([]);
    expect(readScene('scn_a')?.name).toBe('Cell A');
  });

  it('never touches a scene the cache does not hold — lazy hydration stays lazy', async () => {
    const a = scene('scn_a', 'A');
    const root = makeFolder({ scenes: [entryAt(a, NEW)] }, [a]);
    const prompt = vi.fn();
    store.setConflictPrompt(prompt);

    await store.openProjectFolder(asDirHandle(root));

    expect(prompt).not.toHaveBeenCalled();
    expect(readScene('scn_a')).toBeNull();
  });

  it('keeps the cache when the folder body cannot be read', async () => {
    const cached = { ...scene('scn_a', 'Local'), modifiedAt: OLD };
    seedCache(cached);
    const root = makeFolder({ scenes: [entryAt(cached, NEW)] }, []);   // manifest lies

    await store.openProjectFolder(asDirHandle(root));

    expect(readScene('scn_a')?.name).toBe('Local');
    expect(store.getSnapshot().warnings.join(' ')).toContain('missing or not a valid scene');
  });
});

describe('conflict prompt', () => {
  beforeEach(clearRawScenes);

  it('prompts when the cache is newer, and applies nothing before the answer', async () => {
    const cached = { ...scene('scn_a', 'Local edit'), modifiedAt: NEW };
    const onDisk = { ...scene('scn_a', 'Folder version'), modifiedAt: OLD };
    seedCache(cached);
    const root = makeFolder({ scenes: [entryAt(onDisk, OLD)] }, [onDisk]);

    let sawDuringPrompt: string | undefined;
    store.setConflictPrompt(items => {
      // The decision has not been applied yet — the cache is still untouched.
      sawDuringPrompt = readScene('scn_a')?.name;
      return Object.fromEntries(items.map(i => [i.id, 'use-folder' as const]));
    });

    await store.openProjectFolder(asDirHandle(root));

    expect(sawDuringPrompt).toBe('Local edit');
    expect(readScene('scn_a')?.name).toBe('Folder version');
  });

  it('"keep my edits" leaves cache and draft exactly as they were', async () => {
    const cached = { ...scene('scn_a', 'Local edit'), modifiedAt: NEW };
    const onDisk = { ...scene('scn_a', 'Folder version'), modifiedAt: OLD };
    seedCache(cached);
    const root = makeFolder({ scenes: [entryAt(onDisk, OLD)] }, [onDisk]);

    store.setConflictPrompt(items => Object.fromEntries(items.map(i => [i.id, 'keep-cache' as const])));
    await store.openProjectFolder(asDirHandle(root));

    expect(readScene('scn_a')?.name).toBe('Local edit');
  });

  it('with no prompt installed the cache is kept — silence never destroys work', async () => {
    const cached = { ...scene('scn_a', 'Local edit'), modifiedAt: NEW };
    const onDisk = { ...scene('scn_a', 'Folder version'), modifiedAt: OLD };
    seedCache(cached);
    const root = makeFolder({ scenes: [entryAt(onDisk, OLD)] }, [onDisk]);

    await store.openProjectFolder(asDirHandle(root));

    expect(readScene('scn_a')?.name).toBe('Local edit');
    expect(store.getLastConflicts().map(c => c.id)).toEqual(['scn_a']);
  });

  it('B3 — an unsaved draft prompts even though the folder is newer', async () => {
    const cached = { ...scene('scn_a', 'Cell A'), modifiedAt: OLD };
    const onDisk = { ...scene('scn_a', 'Folder version'), modifiedAt: NEW };
    seedCache(cached);
    writeSceneDraft('scn_a', { ...cached, name: 'Cell A — unsaved work' });
    const root = makeFolder({ scenes: [entryAt(onDisk, NEW)] }, [onDisk]);

    const seen: unknown[] = [];
    store.setConflictPrompt(items => { seen.push(...items); return {}; });

    await store.openProjectFolder(asDirHandle(root));

    expect(seen).toEqual([expect.objectContaining({ id: 'scn_a', hasUnsavedDraft: true })]);
    // Nothing chosen → the unsaved work is still there.
    expect(readSceneDraft('scn_a')?.name).toBe('Cell A — unsaved work');
  });

  it('choosing the folder for an unsaved draft reads the body and clears the draft', async () => {
    const cached = { ...scene('scn_a', 'Cell A'), modifiedAt: OLD };
    const onDisk = { ...scene('scn_a', 'Folder version'), modifiedAt: NEW };
    seedCache(cached);
    writeSceneDraft('scn_a', { ...cached, name: 'Cell A — unsaved work' });
    const root = makeFolder({ scenes: [entryAt(onDisk, NEW)] }, [onDisk]);

    store.setConflictPrompt(items => Object.fromEntries(items.map(i => [i.id, 'use-folder' as const])));
    await store.openProjectFolder(asDirHandle(root));

    expect(readScene('scn_a')?.name).toBe('Folder version');
    expect(readSceneDraft('scn_a')).toBeNull();
  });

  it('a prompt that throws keeps the cache instead of guessing', async () => {
    const cached = { ...scene('scn_a', 'Local edit'), modifiedAt: NEW };
    const onDisk = { ...scene('scn_a', 'Folder version'), modifiedAt: OLD };
    seedCache(cached);
    const root = makeFolder({ scenes: [entryAt(onDisk, OLD)] }, [onDisk]);

    store.setConflictPrompt(() => { throw new Error('dialog exploded'); });
    await expect(store.openProjectFolder(asDirHandle(root))).resolves.toBe(true);
    expect(readScene('scn_a')?.name).toBe('Local edit');
  });
});

// ─── Phase 2: dirty guard on project switch (§4e) ───────────────────────

describe('dirty guard', () => {
  /** Scene-store stand-in that reports a dirty workspace. */
  function dirtySceneStore(dirty: boolean) {
    return {
      setSceneHydrator() { /* unused here */ },
      refreshScenesFromStorage: vi.fn(),
      getSnapshot: () => ({ dirty, draft: { name: 'Cell A' } }),
    };
  }

  it('asks before switching away from unsaved work, and a cancel keeps the project open', async () => {
    const rootA = makeFolder({ id: 'prj_A', name: 'A' });
    await store.openProjectFolder(asDirHandle(rootA));
    store.attachToSceneStore(dirtySceneStore(true));

    const guard = vi.fn(() => 'cancel' as const);
    store.setDirtyGuard(guard);

    const rootB = makeFolder({ id: 'prj_B', name: 'B' });
    expect(await store.openProjectFolder(asDirHandle(rootB))).toBe(false);

    expect(guard).toHaveBeenCalledWith(expect.objectContaining({
      reason: 'switch', projectName: 'A', sceneName: 'Cell A', sceneDirty: true,
    }));
    expect(store.getProject()?.id).toBe('prj_A');     // still open, untouched
  });

  it('proceeds with the switch when the guard says so', async () => {
    const rootA = makeFolder({ id: 'prj_A', name: 'A' });
    await store.openProjectFolder(asDirHandle(rootA));
    store.attachToSceneStore(dirtySceneStore(true));
    store.setDirtyGuard(() => 'proceed');

    const rootB = makeFolder({ id: 'prj_B', name: 'B' });
    expect(await store.openProjectFolder(asDirHandle(rootB))).toBe(true);
    expect(store.getProject()?.id).toBe('prj_B');
  });

  it('does not ask when there is nothing unsaved', async () => {
    const rootA = makeFolder({ id: 'prj_A', name: 'A' });
    await store.openProjectFolder(asDirHandle(rootA));
    store.attachToSceneStore(dirtySceneStore(false));

    const guard = vi.fn(() => 'cancel' as const);
    store.setDirtyGuard(guard);

    const rootB = makeFolder({ id: 'prj_B', name: 'B' });
    expect(await store.openProjectFolder(asDirHandle(rootB))).toBe(true);
    expect(guard).not.toHaveBeenCalled();
  });

  it('skipDirtyGuard bypasses it — for callers that already asked', async () => {
    const rootA = makeFolder({ id: 'prj_A', name: 'A' });
    await store.openProjectFolder(asDirHandle(rootA));
    store.attachToSceneStore(dirtySceneStore(true));
    const guard = vi.fn(() => 'cancel' as const);
    store.setDirtyGuard(guard);

    const rootB = makeFolder({ id: 'prj_B', name: 'B' });
    expect(await store.openProjectFolder(asDirHandle(rootB), { skipDirtyGuard: true })).toBe(true);
    expect(guard).not.toHaveBeenCalled();
  });

  it('requestCloseProject runs the same gate; closeProject stays unguarded', async () => {
    const rootA = makeFolder({ id: 'prj_A', name: 'A' });
    await store.openProjectFolder(asDirHandle(rootA));
    store.attachToSceneStore(dirtySceneStore(true));
    store.setDirtyGuard(ctx => (ctx.reason === 'close' ? 'cancel' : 'proceed'));

    expect(await store.requestCloseProject()).toBe(false);
    expect(store.getProject()?.id).toBe('prj_A');

    await store.closeProject();                       // teardown path, no gate
    expect(store.getProject()).toBeNull();
  });

  it('a guard that throws cancels rather than losing the work', async () => {
    const rootA = makeFolder({ id: 'prj_A', name: 'A' });
    await store.openProjectFolder(asDirHandle(rootA));
    store.attachToSceneStore(dirtySceneStore(true));
    store.setDirtyGuard(() => { throw new Error('dialog exploded'); });

    const rootB = makeFolder({ id: 'prj_B', name: 'B' });
    expect(await store.openProjectFolder(asDirHandle(rootB))).toBe(false);
    expect(store.getProject()?.id).toBe('prj_A');
  });

  it('with no guard installed a switch proceeds — a headless caller must not hang', async () => {
    const rootA = makeFolder({ id: 'prj_A', name: 'A' });
    await store.openProjectFolder(asDirHandle(rootA));
    store.attachToSceneStore(dirtySceneStore(true));

    const rootB = makeFolder({ id: 'prj_B', name: 'B' });
    expect(await store.openProjectFolder(asDirHandle(rootB))).toBe(true);
  });
});
