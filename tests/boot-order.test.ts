// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * boot-order.test — plan-372 §9.28 (review findings S8 / M6).
 *
 * Boot has a cycle. `entries` must stand before the `SceneStore` constructor
 * reads it (`scene-store.ts`), but the only pre-existing project resolution
 * (`restoreLastProject`) required an already-attached store. A line swap would
 * crash `attachToSceneStore`.
 *
 * **One of the two ordered lists is gone (plan-731 Phase 2).** The cycle used
 * to have a second horn: `availablePublishedScenes` had to stand before the
 * same constructor, because the store mirrored it into an Examples section.
 * There is no such list and no such mirror — the examples are `documents[]`
 * rows, read where every document is read — so that half of the invariant went
 * with its cause rather than being left here as a green assertion about
 * nothing. What is pinned in its place is the property that OUTLIVED it: the
 * resolution yields a project with its documents while no store exists.
 *
 * The fix is a split, and these are its terms:
 *
 *  - `resolveActiveProject()` runs with **no** SceneStore in existence and
 *    still yields `models[]` / `scenes[]`;
 *  - it opens the backend **read-only** — nothing is written, no writer
 *    exists, so nothing can reach disk before the store is attached;
 *  - `hydrateProjectScenes()` runs after `attachToSceneStore()` and is the
 *    first point at which `activate()` falls;
 *  - with neither `?project=` nor a last-opened project, **"My Workspace"** is
 *    the answer. There is always a project.
 *
 * That last term changed in plan-716 Phase 1 (§2.2 / F2): the answer used to be
 * the read-only bundled demo. The bundled resolution itself is unchanged and is
 * still pinned here — the cases that are about the bundled TIER rather than
 * about the projectless boot say `workspaceDefault: false` and explain why.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { deadDraftKey, deadSlotExists, seedDeadDraft } from './helpers/dead-draft-slots';
import { FakeDir, asDirHandle } from './helpers/fake-fs-handles';

/**
 * Persisted handles are faked at the module seam rather than through
 * IndexedDB: structured-cloning a `FakeDir` strips its methods, so a stored
 * fake comes back as a plain object whose `queryPermission` does not exist —
 * which `ensureHandlePermission` correctly reads as "stale handle". That
 * would test the fake, not the boot order.
 */
const grantedHandles = new Map<string, FileSystemDirectoryHandle>();

vi.mock('../src/core/engine/rv-local-filesystem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/engine/rv-local-filesystem')>();
  return {
    ...actual,
    getFolderHandle: async (key: string) => grantedHandles.get(key) ?? null,
    putHandle: async () => {},
  };
});
import {
  LS_KEY_LAST_PROJECT,
  ProjectStore,
  resetProjectStore,
  type SceneStoreLike,
} from '../src/core/project/project-store';
import { BundledBackend } from '../src/core/project/backends/bundled-backend';
import {
  WORKSPACE_DEFAULT_PROJECT_ID,
  WORKSPACE_DEFAULT_PROJECT_NAME,
} from '../src/core/project/rv-workspace-default';
import { FolderBackend } from '../src/core/project/backends/folder-backend';
import { documentsOf } from '../src/core/project/rv-project-documents';
import { clearSceneMutationListeners } from '../src/core/hmi/scene/rv-scene-mutations';
import {
  clearAllScenes,
  getDraftScope,
  setDraftScope,
} from '../src/core/hmi/scene/rv-scene-storage';
import { projectHandleKey } from '../src/core/engine/rv-local-filesystem';
import { sceneGlbRelPathFor, type RvProject } from '../src/core/project/rv-project-types';
import type { RvScene, SceneBase } from '../src/core/hmi/scene/rv-scene-types';

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

/**
 * A bundled backend, over a deploy that publishes what it was given (plan-735 3b/5d).
 *
 * It used to be a 404 root plus injected `models`/`publishedScenes`, which the
 * backend turned into a synthetic project. Both the synthesis and the
 * `publishedScenes` injection are gone, so the fixture says the same thing the
 * honest way: a deploy with documents DECLARES them in its `project.json`.
 *
 * Called with nothing it is still a 404 root — and that now means what it says:
 * a deploy that publishes no manifest has no project, so the resolution falls
 * through to "My Workspace". Several tests below depend on exactly that, which
 * is why the empty case must not be given an empty manifest instead.
 */
function bundled(
  models: Array<{ url: string; label: string }> = [],
  scenes: Array<{ path: string; label: string; mode?: string }> = [],
) {
  const publishesNothing = models.length === 0 && scenes.length === 0;
  const project = {
    schemaVersion: 2,
    id: 'prj_deploy',
    name: 'Deploy',
    documents: [
      ...scenes.map(s => ({
        id: `doc_${s.path.replace(/[^a-z0-9]+/gi, '_')}`,
        name: s.label,
        path: s.path,
        section: 'scenes',
        ...(s.mode ? { mode: s.mode } : {}),
      })),
      ...models.map(m => ({
        id: `doc_${m.url.replace(/[^a-z0-9]+/gi, '_')}`,
        name: m.label,
        // `label` too: `assetDocumentsOf()` projects a document row onto the
        // asset-entry shape, which reads `label` rather than `name`.
        label: m.label,
        path: m.url,
        section: 'models',
      })),
    ],
  };
  return new BundledBackend({
    fetchImpl: (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (publishesNothing || !url.endsWith('project.json')) {
        return { ok: false, status: 404, json: async () => null } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => project } as unknown as Response;
    }) as typeof fetch,
  });
}

/** A folder project whose handle is already granted, as after a reload. */
async function grantedFolder(projectId: string, scenes: RvScene[] = []): Promise<FakeDir> {
  const root = new FakeDir(projectId);
  const manifest: RvProject = {
    schemaVersion: 1,
    id: projectId,
    name: 'CustomerX',
    scenes: scenes.map(s => ({ id: s.id, name: s.name, path: sceneGlbRelPathFor(s) })),
    models: [{ path: 'models/line.glb', label: 'Line' }],
  };
  root.seedText('project.json', JSON.stringify(manifest));
  const dir = root.seedDir('scenes');
  for (const s of scenes) dir.seedText(sceneGlbRelPathFor(s).split('/')[1]!, JSON.stringify(s));
  grantedHandles.set(projectHandleKey(projectId), asDirHandle(root));
  return root;
}

/** A SceneStore stand-in that records when it was wired up. */
function fakeSceneStore(log: string[]): SceneStoreLike {
  return {
    setSceneHydrator: () => { log.push('attach'); },
    getSnapshot: () => ({ dirty: false, draft: null }),
  };
}

let store: ProjectStore;

beforeEach(() => {
  clearSceneMutationListeners();
  clearAllScenes();
  setDraftScope(null);
  localStorage.removeItem(LS_KEY_LAST_PROJECT);
  grantedHandles.clear();
  resetProjectStore();
  store = new ProjectStore();
});

afterEach(async () => {
  await store.closeProject();
  clearSceneMutationListeners();
  clearAllScenes();
  setDraftScope(null);
  localStorage.removeItem(LS_KEY_LAST_PROJECT);
  grantedHandles.clear();
});

// ─── Half one ───────────────────────────────────────────────────────────

describe('resolveActiveProject', () => {
  it('runs with no SceneStore at all and still yields models and scenes', async () => {
    // `workspaceDefault: false` on purpose: what this asserts is that half one
    // produces models[] and scenes[] with no store in existence, and the bundled
    // fixture is the one that HAS both. Which project a projectless boot opens
    // is the separate question below (plan-716 F2).
    //
    // The scene row here comes from the deploy's own manifest (plan-735): the
    // synthetic manifest and its `publishedScenes` injection are gone, so the
    // fixture declares what it ships. What is pinned is unchanged — that half
    // one completes, with models and scenes, without a store in existence.
    const resolved = await store.resolveActiveProject({
      workspaceDefault: false,
      bundledBackend: bundled(
        [{ url: '/models/Demo.glb', label: 'Demo' }],
        [{ path: 'scenes/A.glb', label: 'Demo A' }],
      ),
    });
    expect(resolved.kind).toBe('bundled');
    // The DEPLOY's id — the synthetic `prj_sample` is gone (plan-735 F6).
    expect(resolved.project?.id).toBe('prj_deploy');
    expect(resolved.models.map(m => m.label)).toEqual(['Demo']);
    expect(resolved.scenes.map(s => s.name)).toEqual(['Demo A']);
  });

  it('opens My Workspace with neither ?project= nor a last-opened project', async () => {
    // plan-716 Phase 1 (§2.2 / F2) — RE-PINNED. This used to read "falls back to
    // bundled": the read-only demo was the answer to "no folder project", so the
    // boot's active project and the place the user's bytes went were different
    // things. Now the answer is a writable browser project with a fixed id.
    const resolved = await store.resolveActiveProject({ bundledBackend: bundled() });
    expect(resolved.backend.kind).toBe('browser');
    expect(resolved.project?.id).toBe(WORKSPACE_DEFAULT_PROJECT_ID);
    expect(resolved.project?.name).toBe(WORKSPACE_DEFAULT_PROJECT_NAME);
    expect(resolved.project).not.toBeNull();   // there is ALWAYS a project
    // Still read-only at this point in boot — the branch writes nothing.
    expect(resolved.backend.isActive).toBe(false);
  });

  it('the bundled deploy stays reachable — it is a source, not the boot default', async () => {
    // F2's other half: the deploy's project did not go away, it stopped being
    // the default. Re-sourced by plan-735 — the reachable project is the one the
    // deploy PUBLISHES, not a `prj_sample` invented for a deploy that published
    // nothing.
    const resolved = await store.resolveActiveProject({
      workspaceDefault: false,
      bundledBackend: bundled([{ url: '/models/Demo.glb', label: 'Demo' }]),
    });
    expect(resolved.backend.kind).toBe('bundled');
    expect(resolved.project?.id).toBe('prj_deploy');
  });

  it('prefers the last-opened folder project when its grant survived', async () => {
    await grantedFolder('prj_customer', [scene('scn_a', 'A')]);
    localStorage.setItem(LS_KEY_LAST_PROJECT, 'prj_customer');

    const resolved = await store.resolveActiveProject({ bundledBackend: bundled() });
    expect(resolved.kind).toBe('folder');
    expect(resolved.project?.name).toBe('CustomerX');
    expect(resolved.models.map(m => m.path)).toEqual(['models/line.glb']);
  });

  it('an explicit projectId beats the recorded one — the ?project= path', async () => {
    await grantedFolder('prj_a');
    await grantedFolder('prj_b');
    localStorage.setItem(LS_KEY_LAST_PROJECT, 'prj_a');

    const resolved = await store.resolveActiveProject({
      projectId: 'prj_b',
      bundledBackend: bundled(),
    });
    expect(resolved.project?.id).toBe('prj_b');
  });

  it('a lapsed grant degrades to My Workspace instead of failing boot', async () => {
    // plan-716 Phase 1 — RE-PINNED from `'bundled'`. The property under test is
    // unchanged: a project whose folder grant is gone must not fail the boot. It
    // now degrades to the writable workspace rather than to the read-only demo,
    // which is strictly better for the user standing in front of it.
    localStorage.setItem(LS_KEY_LAST_PROJECT, 'prj_never_granted');
    const resolved = await store.resolveActiveProject({ bundledBackend: bundled() });
    expect(resolved.kind).toBe('browser');
    expect(resolved.project?.id).toBe(WORKSPACE_DEFAULT_PROJECT_ID);
  });

  it('opens the backend READ-ONLY — nothing may reach disk yet', async () => {
    await grantedFolder('prj_customer');
    localStorage.setItem(LS_KEY_LAST_PROJECT, 'prj_customer');

    const resolved = await store.resolveActiveProject({ bundledBackend: bundled() });
    expect(resolved.backend.isActive).toBe(false);
    expect((resolved.backend as FolderBackend).hasWriter).toBe(false);
  });

  it('does not touch the SceneStore, because there is not one yet', async () => {
    const log: string[] = [];
    await store.resolveActiveProject({ bundledBackend: bundled() });
    expect(log).toEqual([]);
    // Attaching afterwards is what half two needs, and it still works.
    store.attachToSceneStore(fakeSceneStore(log));
    expect(log).toEqual(['attach']);
  });

  it('yields the project and its documents before any store exists', async () => {
    // What survives of the §2.10 invariant after plan-731: the resolution is
    // complete at this point in boot — a project, its backend and its document
    // list — while the SceneStore constructor has not run. The published half
    // of the old assertion is deliberately NOT restated: there is no second
    // list to sequence, and asserting one from a foreign `scenes/index.json`
    // would test the `discover` boundary, not the boot order.
    const resolved = await store.resolveActiveProject({
      // The bundled tier, so this net keeps resolving to it and not to
      // "My Workspace" (plan-716 §2.2 — the option exists for exactly this).
      workspaceDefault: false,
      bundledBackend: bundled([
        { url: '/models/A.glb', label: 'A' },
        { url: '/models/B.glb', label: 'B' },
      ]),
    });
    expect(resolved.project).toBeTruthy();
    expect(resolved.kind).toBe('bundled');
    expect(resolved.models).toHaveLength(2);
    expect(documentsOf(resolved.project).map((d) => d.path))
      .toEqual(expect.arrayContaining(['/models/A.glb', '/models/B.glb']));
  });

  // The other half of the same statement — "no source declares a second list
  // to order against" — is a SOURCE guard and lives where source guards can be
  // read from disk: `demo-manifest-invariants.node.test.ts`. A `?raw` import of
  // a `.ts` module does not resolve in this browser-mode suite.
});

// ─── Half two ───────────────────────────────────────────────────────────

describe('hydrateProjectScenes', () => {
  it('is a no-op without a resolve, rather than a throw', async () => {
    expect(await store.hydrateProjectScenes()).toBe(false);
  });

  it('is where activate() falls, and not one step earlier', async () => {
    await grantedFolder('prj_customer');
    localStorage.setItem(LS_KEY_LAST_PROJECT, 'prj_customer');

    const resolved = await store.resolveActiveProject({ bundledBackend: bundled() });
    expect(resolved.backend.isActive).toBe(false);

    const log: string[] = [];
    store.attachToSceneStore(fakeSceneStore(log));
    expect(await store.hydrateProjectScenes()).toBe(true);

    expect(log).toEqual(['attach']);
    expect(store.getBackend()?.isActive).toBe(true);
    expect((store.getBackend() as FolderBackend).hasWriter).toBe(true);
  });

  it('adopts the bundled project when that is what resolved', async () => {
    await store.resolveActiveProject({
      workspaceDefault: false,
      bundledBackend: bundled([], [{ path: 'scenes/A.glb', label: 'A' }]),
    });
    store.attachToSceneStore(fakeSceneStore([]));
    expect(await store.hydrateProjectScenes()).toBe(true);
    // The DEPLOY's project id, not the synthetic demo's: since plan-735 the
    // bundled backend adopts what the deploy published and never mints one.
    expect(store.getProject()?.id).toBe('prj_deploy');
    expect(store.getSnapshot().backendKind).toBe('bundled');
  });

  it('records the folder project for the next boot, and the bundled one never', async () => {
    await store.resolveActiveProject({ bundledBackend: bundled() });
    store.attachToSceneStore(fakeSceneStore([]));
    await store.hydrateProjectScenes();
    expect(localStorage.getItem(LS_KEY_LAST_PROJECT)).toBeNull();

    await grantedFolder('prj_customer');
    localStorage.setItem(LS_KEY_LAST_PROJECT, 'prj_customer');
    const s2 = new ProjectStore();
    await s2.resolveActiveProject({ bundledBackend: bundled() });
    s2.attachToSceneStore(fakeSceneStore([]));
    await s2.hydrateProjectScenes();
    expect(localStorage.getItem(LS_KEY_LAST_PROJECT)).toBe('prj_customer');
    await s2.closeProject();
  });
});

// ─── The draft keyspace, which the always-present Sample could have eaten ──

describe('draft scope under the always-present Sample project', () => {
  const base: SceneBase = { kind: 'empty' };

  it('the bundled project takes NO draft scope', async () => {
    await store.resolveActiveProject({ bundledBackend: bundled() });
    store.attachToSceneStore(fakeSceneStore([]));
    await store.hydrateProjectScenes();
    expect(getDraftScope()).toBeNull();
  });

  it('a pre-existing unscoped draft slot survives adoption and the close after it', async () => {
    // Nothing reads this slot any more (plan-413 phase 6), but the close path
    // must still not reach into the unscoped keyspace: `clearDraftsForScope`
    // deletes by project prefix, and a slot with no prefix belongs to nobody's
    // project. Deleting it here would be the store tidying away data it does
    // not own.
    const key = seedDeadDraft(base);

    await store.resolveActiveProject({ bundledBackend: bundled() });
    store.attachToSceneStore(fakeSceneStore([]));
    await store.hydrateProjectScenes();
    expect(deadSlotExists(key)).toBe(true);

    await store.closeProject();
    expect(deadSlotExists(key)).toBe(true);
    expect(deadDraftKey(base)).toBe(key);   // still unscoped after the close
  });

  it('a folder project still gets its own scope (RR4 intact)', async () => {
    await grantedFolder('prj_customer');
    localStorage.setItem(LS_KEY_LAST_PROJECT, 'prj_customer');
    await store.resolveActiveProject({ bundledBackend: bundled() });
    store.attachToSceneStore(fakeSceneStore([]));
    await store.hydrateProjectScenes();
    expect(getDraftScope()).toBe('prj_customer');
  });

  it('closing the bundled project does not forget the last folder project', async () => {
    // A user whose folder grant lapsed boots into Sample. Closing it must not
    // erase the pointer to the folder they actually work in.
    localStorage.setItem(LS_KEY_LAST_PROJECT, 'prj_customer');
    await store.resolveActiveProject({ bundledBackend: bundled() });
    store.attachToSceneStore(fakeSceneStore([]));
    await store.hydrateProjectScenes();
    await store.closeProject();
    expect(localStorage.getItem(LS_KEY_LAST_PROJECT)).toBe('prj_customer');
  });
});
