// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-716 Phase 1 — "My Workspace", the default browser project (§2.2 / F2).
 *
 * ## What this file replaces
 *
 * `projectless-scenes.test.ts` (plan-413 §9.7) is deleted with this phase: it
 * pinned a MODE that no longer exists — "open the viewer, save a scene, never
 * touch a project", where the localStorage catalogue *was* the manifest. The
 * useful half of it is not the projectlessness, it is that save / rename /
 * duplicate / delete and the classification cache keep working for a user who
 * never picked a folder. That half is ported here verbatim in intent, with the
 * one difference the phase introduces: those verbs now run inside a real,
 * writable project instead of in a nameless void (§9.0, verdict "faellt in
 * Phase 1 — ersetzt durch Boot-/Workspace-Default-Tests").
 *
 * ## The duplicate question is the whole point (Risiko 7)
 *
 * The id is a CONSTANT. There is no minting, so there is no window in which two
 * homes can exist — not across three sequential boots, not across three boots
 * racing each other, and not when the profile already holds other browser
 * projects. Each of those is asserted below, and each asserts the *number* of
 * workspace manifests rather than merely "a workspace resolved", because a
 * second home is only visible as a second key.
 *
 * The filesystem seams are mocked to `null` for the same reason as in
 * `open-paths-characterization.test.ts`: browser-mode vitest shares one origin
 * across files, and a workspace/folder handle granted by another file would
 * resolve a folder project here and turn these pins into flakes.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../src/core/engine/rv-local-filesystem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/engine/rv-local-filesystem')>();
  return { ...actual, getFolderHandle: async () => null, putHandle: async () => {} };
});

vi.mock('../src/core/project/rv-project-workspace', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/project/rv-project-workspace')>();
  return { ...actual, getWorkspaceHandle: async () => null };
});

// plan-716 Phase 3: the verb block below SAVES, and a save bakes now. The bytes
// are irrelevant to every assertion here — what is asserted is where the
// document lands — and baking for real would need a live Three.js scene.
vi.mock('../src/core/hmi/scene/rv-scene-glb-bake', () => ({
  bakeIntoGlb: async () => ({
    glb: new Uint8Array([0x67, 0x6c, 0x54, 0x46, 1, 2, 3, 4]),
    warnings: [],
    writtenReferences: [],
  }),
  makeRegistryBakeResolver: () => ({}),
  bakeRequiresFullPath: () => false,
}));

import {
  ProjectStore,
  getProjectStore,
  resetProjectStore,
} from '../src/core/project/project-store';
import { documentsOf } from '../src/core/project/rv-project-documents';
import type { RvDocumentEntry } from '../src/core/project/rv-project-types';
import {
  BundledBackend,
  SAMPLE_PROJECT_ID,
} from '../src/core/project/backends/bundled-backend';
import {
  BrowserBackend,
  browserManifestKey,
} from '../src/core/project/backends/browser-backend';
import {
  WORKSPACE_DEFAULT_PROJECT_ID,
  WORKSPACE_DEFAULT_PROJECT_NAME,
  isWorkspaceDefaultBackend,
  isWorkspaceDefaultProject,
  openWorkspaceDefaultBackend,
  workspaceDefaultExists,
} from '../src/core/project/rv-workspace-default';
import {
  installProjectLibraryProvider,
  uninstallProjectLibraryProvider,
  PROJECT_LIBRARY_PROVIDER_ID,
} from '../src/core/library/project-library-provider';
import {
  listLibrarySources,
  resetLibrarySourceRegistryForTests,
} from '../src/core/library/library-source-registry';
import { SceneStore } from '../src/core/hmi/scene/scene-store';
import {
  clearAllScenes,
  getDraftScope,
  listMetas,
  readScene,
  setDraftScope,
  writeScene,
} from '../src/core/hmi/scene/rv-scene-storage';
import { clearSceneMutationListeners } from '../src/core/hmi/scene/rv-scene-mutations';
import { clearAllSceneOwners } from '../src/core/project/rv-scene-owner';
import { clearAllBlobs } from '../src/core/storage/rv-opfs-blobs';
import {
  makeDraftScene,
  metaOf,
  type RvScene,
  type SceneBase,
} from '../src/core/hmi/scene/rv-scene-types';
import type { DocumentClassification } from '../src/core/project/rv-document-classification';
import type { SceneStoreLike } from '../src/core/project/project-store';
import { legacySceneId } from './helpers/legacy-scene-id';

// ─── Harness ────────────────────────────────────────────────────────────

const DEMO_URL = '/models/Demo.glb';
const BUILTIN: SceneBase = { kind: 'builtin', url: DEMO_URL, label: 'Demo' };
const PART: DocumentClassification = { v: 1, level: 'part', tags: ['gripper'] };

/** A bundled backend whose deploy root serves no `project.json`. */
function bundled(): BundledBackend {
  return new BundledBackend({
    models: [{ url: DEMO_URL, label: 'Demo' }],
    // `publishedScenes` is gone with the synthetic manifest (plan-735 3b).
    fetchImpl: (async () => (
      { ok: false, status: 404, json: async () => null } as unknown as Response
    )) as typeof fetch,
  });
}

/** A bundled backend that DOES serve a deploy manifest — a delivered build. */
function deployed(): BundledBackend {
  const manifest = { schemaVersion: 1, id: 'prj_customer_deploy', name: 'CustomerDeploy' };
  return new BundledBackend({
    fetchImpl: (async (input: RequestInfo | URL) => {
      const url = String(input);
      return url.endsWith('project.json')
        ? ({ ok: true, status: 200, json: async () => manifest } as unknown as Response)
        : ({ ok: false, status: 404, json: async () => null } as unknown as Response);
    }) as typeof fetch,
  });
}

function fakeSceneStore(): SceneStoreLike {
  return {
    setSceneHydrator: () => {},
    getSnapshot: () => ({ dirty: false, draft: null }),
  };
}

interface FakeViewer {
  loadScene: (s: RvScene) => Promise<void>;
  loadEmptyScene: () => Promise<void>;
  getPlugin: <T>(id: string) => T | undefined;
  availableModels: { url: string; label: string }[];
  currentScene: RvScene | null;
  currentModelUrl: string | null;
  registry: unknown;
  currentModelRoot: unknown;
  lastLoadResult: unknown;
}

function makeSceneStore(): SceneStore {
  const v: FakeViewer = {
    availableModels: [{ url: DEMO_URL, label: 'Demo' }],
    currentScene: null,
    currentModelUrl: null,
    // The bake is mocked but its GUARD is real: `_bakeCurrent` returns null
    // without a registry, and a save that cannot bake writes nothing.
    registry: { getGltfNodeNames: () => [], getGltfNodeIndex: () => -1 },
    currentModelRoot: null,
    lastLoadResult: null,
    loadScene: vi.fn(async (s: RvScene) => { v.currentScene = s; }),
    loadEmptyScene: vi.fn(async () => { v.currentScene = null; }),
    getPlugin: () => undefined,
  };
  return new SceneStore(v as unknown as ConstructorParameters<typeof SceneStore>[0]);
}

/**
 * How many workspace-default manifests exist. The duplicate assertion.
 *
 * Counted over the raw keyspace rather than asked of a store: a second home
 * would BE a second key, and any API that answers "the workspace project" would
 * hide it behind the fixed id it was asked for.
 */
function workspaceManifestKeys(): string[] {
  const out: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)!;
    if (k.includes(WORKSPACE_DEFAULT_PROJECT_ID)) out.push(k);
  }
  return out.sort();
}

/** Every browser-project manifest key in the profile, workspace or not. */
function browserProjectIds(): string[] {
  const prefix = 'rv-project/browser/';
  const out: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)!;
    if (k.startsWith(prefix) && !k.endsWith('/blobs')) out.push(k.slice(prefix.length));
  }
  return out.sort();
}

/** A full boot half-one + half-two, as `main.ts` runs it. */
async function boot(): Promise<ProjectStore> {
  const store = new ProjectStore();
  await store.resolveActiveProject({ bundledBackend: bundled() });
  store.attachToSceneStore(fakeSceneStore());
  await store.hydrateProjectScenes();
  return store;
}

/**
 * Boot into the SINGLETON store — what `main.ts` actually does.
 *
 * The verb block needs this and the duplicate block must not have it: since
 * plan-716 Phase 3 a save writes a document through `getProjectStore()`, so a
 * boot into a private `ProjectStore` instance leaves the store the SceneStore
 * consults empty and the save with nowhere to go. The duplicate assertions, by
 * contrast, are explicitly about several independent stores.
 */
async function bootShared(): Promise<ProjectStore> {
  const store = getProjectStore();
  await store.resolveActiveProject({ bundledBackend: bundled() });
  store.attachToSceneStore(fakeSceneStore());
  await store.hydrateProjectScenes();
  return store;
}

/** The document rows the shared project currently holds. */
function workspaceDocuments(store: ProjectStore): RvDocumentEntry[] {
  return documentsOf(store.getProject());
}

beforeEach(async () => {
  localStorage.clear();
  clearSceneMutationListeners();
  clearAllScenes();
  clearAllSceneOwners();
  setDraftScope(null);
  resetProjectStore();
  resetLibrarySourceRegistryForTests();
  await clearAllBlobs();
});

afterEach(async () => {
  uninstallProjectLibraryProvider();
  resetLibrarySourceRegistryForTests();
  clearSceneMutationListeners();
  clearAllScenes();
  clearAllSceneOwners();
  setDraftScope(null);
  localStorage.clear();
  await clearAllBlobs();
});

// ─── The branch itself ──────────────────────────────────────────────────

describe('plan-716 Phase 1 — boot with no project opens My Workspace', () => {
  it('resolves a writable browser backend under the fixed id', async () => {
    const store = new ProjectStore();
    const resolved = await store.resolveActiveProject({ bundledBackend: bundled() });

    expect(resolved.kind).toBe('browser');
    expect(resolved.backend.kind).toBe('browser');
    expect(resolved.backend.writable).toBe(true);
    expect(resolved.project?.id).toBe(WORKSPACE_DEFAULT_PROJECT_ID);
    expect(resolved.project?.name).toBe(WORKSPACE_DEFAULT_PROJECT_NAME);
    expect(isWorkspaceDefaultBackend(resolved.backend)).toBe(true);
    await store.closeProject();
  });

  it('is still read-only at resolve time — half one writes nothing', async () => {
    // The boot-order invariant the branch had to fit inside: `activate()` is
    // `hydrateProjectScenes()`'s job, so nothing may reach storage yet. The
    // manifest row is therefore NOT written by the resolve.
    const store = new ProjectStore();
    const resolved = await store.resolveActiveProject({ bundledBackend: bundled() });

    expect(resolved.backend.isActive).toBe(false);
    expect(workspaceDefaultExists()).toBe(false);
    expect(workspaceManifestKeys()).toEqual([]);
    await store.closeProject();
  });

  it('writes the manifest row once, at hydrate, and it is then the marker', async () => {
    const store = await boot();

    expect(workspaceDefaultExists()).toBe(true);
    expect(store.getProject()?.id).toBe(WORKSPACE_DEFAULT_PROJECT_ID);
    expect(store.getBackend()?.isActive).toBe(true);
    expect(store.isWritable()).toBe(true);
    expect(browserProjectIds()).toEqual([WORKSPACE_DEFAULT_PROJECT_ID]);
    await store.closeProject();
  });

  it('takes the UNSCOPED draft keyspace, exactly as the bundled default did', async () => {
    // Risiko 4. Every pre-716 draft sits at the unscoped `rv-scenes/draft/<base>`
    // key. Scoping the project that is adopted on every projectless boot would
    // hide all of them and have `closeProject()`'s `clearDraftsForScope()` sweep
    // them away — the draft loss the plan forbids.
    const store = await boot();
    expect(getDraftScope()).toBeNull();
    await store.closeProject();
    expect(getDraftScope()).toBeNull();
  });
});

// ─── No second home, ever (Risiko 7) ────────────────────────────────────

describe('plan-716 Phase 1 — the workspace project is never created twice', () => {
  it('three sequential boots address ONE project and ONE manifest', async () => {
    const ids: (string | undefined)[] = [];
    for (let i = 0; i < 3; i++) {
      const store = await boot();
      ids.push(store.getProject()?.id);
      await store.closeProject();
    }

    expect(ids).toEqual([
      WORKSPACE_DEFAULT_PROJECT_ID,
      WORKSPACE_DEFAULT_PROJECT_ID,
      WORKSPACE_DEFAULT_PROJECT_ID,
    ]);
    expect(browserProjectIds()).toEqual([WORKSPACE_DEFAULT_PROJECT_ID]);
    expect(workspaceManifestKeys()).toHaveLength(1);
  });

  it('three boots racing each other still produce ONE project', async () => {
    // Two tabs opening at the same instant is the case a "create if the list is
    // empty" check loses: all three would see an empty list. A constant id has
    // no such window.
    const stores = await Promise.all([boot(), boot(), boot()]);

    expect(stores.map(s => s.getProject()?.id)).toEqual([
      WORKSPACE_DEFAULT_PROJECT_ID,
      WORKSPACE_DEFAULT_PROJECT_ID,
      WORKSPACE_DEFAULT_PROJECT_ID,
    ]);
    expect(browserProjectIds()).toEqual([WORKSPACE_DEFAULT_PROJECT_ID]);
    for (const s of stores) await s.closeProject();
  });

  it('a second boot does not overwrite what the first one stored', async () => {
    // The idempotency that matters in practice: the row is a marker, so the
    // "create" step must not re-run over a manifest the user has since changed.
    const first = await boot();
    const backend = first.getBackend() as BrowserBackend;
    await backend.writeManifest({
      ...(await backend.readManifest())!,
      name: 'My Workspace (renamed)',
    });
    await first.closeProject();

    const second = await boot();
    expect(second.getProject()?.name).toBe('My Workspace (renamed)');
    expect(browserProjectIds()).toEqual([WORKSPACE_DEFAULT_PROJECT_ID]);
    await second.closeProject();
  });

  it('existence is the fixed id, NOT "the project list is empty"', async () => {
    // A profile that already holds other browser projects must still get the
    // one workspace home — and a profile that holds the workspace row must not
    // get a second one just because something else is listed alongside it.
    const other = new BrowserBackend('prj_other', { requestPersistence: false });
    await other.activate();
    await other.writeManifest((await other.readManifest())!);
    expect(browserProjectIds()).toEqual(['prj_other']);

    const store = await boot();
    expect(store.getProject()?.id).toBe(WORKSPACE_DEFAULT_PROJECT_ID);
    expect(browserProjectIds()).toEqual(['prj_other', WORKSPACE_DEFAULT_PROJECT_ID].sort());
    await store.closeProject();

    const again = await boot();
    expect(browserProjectIds()).toEqual(['prj_other', WORKSPACE_DEFAULT_PROJECT_ID].sort());
    await again.closeProject();
  });

  it('every opened backend is the same project, whoever opened it', async () => {
    const a = openWorkspaceDefaultBackend({ requestPersistence: false });
    const b = openWorkspaceDefaultBackend({ requestPersistence: false });

    expect(a.projectId).toBe(b.projectId);
    expect(a.id).toBe(b.id);
    expect(browserManifestKey(a.projectId)).toBe(browserManifestKey(b.projectId));
    expect(isWorkspaceDefaultProject(a.projectId)).toBe(true);
    expect(isWorkspaceDefaultProject('prj_other')).toBe(false);
  });
});

// ─── The library provider (§2.2, third bullet) ──────────────────────────

describe('plan-716 Phase 1 — the workspace registers as a library source', () => {
  /** Let the provider's async refresh land. */
  async function settle(): Promise<void> {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  }

  it('shows up as exactly one writable project source', async () => {
    const store = await boot();
    installProjectLibraryProvider(store);
    await settle();

    const sources = listLibrarySources();
    expect(sources).toHaveLength(1);
    expect(sources[0]!.providerId).toBe(PROJECT_LIBRARY_PROVIDER_ID);
    expect(sources[0]!.source.id).toBe(WORKSPACE_DEFAULT_PROJECT_ID);
    expect(sources[0]!.source.label).toBe(WORKSPACE_DEFAULT_PROJECT_NAME);
    expect(sources[0]!.source.kind).toBe('project');
    expect(sources[0]!.source.writable).toBe(true);
    await store.closeProject();
  });

  it('registers idempotently — installing twice leaves ONE source', async () => {
    const store = await boot();
    installProjectLibraryProvider(store);
    installProjectLibraryProvider(store);
    installProjectLibraryProvider(store);
    await settle();

    const sources = listLibrarySources();
    expect(sources).toHaveLength(1);
    expect(sources[0]!.source.id).toBe(WORKSPACE_DEFAULT_PROJECT_ID);
    await store.closeProject();
  });

  it('survives the boot order main.ts actually uses (install before hydrate)', async () => {
    // `installProjectLibraryProvider` runs early and unconditionally in main.ts
    // (before the project-restore branch), so the provider has to pick the
    // workspace up from the store's publish rather than from its constructor.
    const store = new ProjectStore();
    installProjectLibraryProvider(store);
    await settle();
    expect(listLibrarySources()).toEqual([]);

    await store.resolveActiveProject({ bundledBackend: bundled() });
    store.attachToSceneStore(fakeSceneStore());
    await store.hydrateProjectScenes();
    await settle();

    const sources = listLibrarySources();
    expect(sources).toHaveLength(1);
    expect(sources[0]!.source.id).toBe(WORKSPACE_DEFAULT_PROJECT_ID);
    await store.closeProject();
  });
});

// ─── The bundled demo is a source, not the default ──────────────────────

describe('plan-716 Phase 1 — explicit demo opening still works', () => {
  // Re-sourced by plan-735, same claim. It used to point at a 404 deploy root
  // and expect `prj_sample` — the SYNTHETIC manifest, which is exactly what
  // plan-735 removed. The deploy's own manifest is where a bundled project
  // comes from now, so the fixture that publishes one is the one that shows
  // "the bundled project is still reachable when it is asked for".
  it('resolves the bundled deploy project when it is asked for', async () => {
    const store = new ProjectStore();
    const resolved = await store.resolveActiveProject({
      workspaceDefault: false,
      bundledBackend: deployed(),
    });

    expect(resolved.kind).toBe('bundled');
    expect(resolved.project?.id).toBe('prj_customer_deploy');
    await store.closeProject();
  });

  // The other half, and the one plan-735 changed: a deploy root that publishes
  // NO manifest has no project to resolve. Before plan-735 this same call
  // answered with an invented `prj_sample`.
  it('has no bundled project when the deploy publishes no manifest', async () => {
    const store = new ProjectStore();
    const resolved = await store.resolveActiveProject({
      workspaceDefault: false,
      bundledBackend: bundled(),
    });

    expect(resolved.project?.id).not.toBe(SAMPLE_PROJECT_ID);
    await store.closeProject();
  });

  it('a DEPLOYED project.json still wins over the workspace', async () => {
    // A delivered Bunny/CONNECT build IS a project, named by whoever published
    // it. Answering that visitor with an empty local workspace would hide the
    // very thing they opened, so the deployed manifest is checked first.
    const store = new ProjectStore();
    const resolved = await store.resolveActiveProject({ bundledBackend: deployed() });

    expect(resolved.kind).toBe('bundled');
    expect(resolved.project?.id).toBe('prj_customer_deploy');
    await store.closeProject();
  });

  it('openBuiltin still opens the demo while My Workspace is the project', async () => {
    // `?scene=builtin:` routes through here. The workspace project changed where
    // a SAVE goes, not what can be opened.
    const store = await boot();
    const scenes = makeSceneStore();
    await scenes.openBuiltin(DEMO_URL, 'Demo');

    expect(scenes.getSnapshot().draft?.base).toEqual(BUILTIN);
    expect(scenes.getSnapshot().isDraft).toBe(true);
    await store.closeProject();
  });
});

// ─── Ported from projectless-scenes.test.ts (deleted with this phase) ────

describe('plan-716 Phase 1 — the verbs still work, now inside My Workspace', () => {
  /**
   * PORTED to documents (plan-716 Phase 3, F1/F5).
   *
   * Phase 1 pinned these four verbs against the localStorage catalogue, because
   * that is what a save still wrote at the time. Phase 3 deletes the row path:
   * a save writes a document FILE and a `documents[]` row. The statement each
   * case makes is unchanged — "the verbs work for a user who never picked a
   * folder, and the result has a home" — and each is restated against that home.
   */

  it('saves a scene, and the workspace lists it as its own document', async () => {
    const project = await bootShared();
    const store = makeSceneStore();
    await store.openBuiltin(DEMO_URL, 'Demo');
    await store.save();

    const docs = workspaceDocuments(project);
    expect(docs).toHaveLength(1);
    // User decision 2026-08-30 (plan-719 residual): new documents save to the project root
    expect(docs[0]!.path).toBe('Demo.glb');
    expect(store.getSnapshot().isDraft).toBe(false);
    // RE-PINNED: no catalogue row anywhere. The document IS the artefact.
    expect(listMetas()).toEqual([]);
    // The bytes really landed in the project the boot opened.
    expect(await project.getBackend()!.readDocument('Demo.glb')).not.toBeNull();
    store.dispose();
    await project.closeProject();
  });

  it('renames a saved document', async () => {
    const project = await bootShared();
    const store = makeSceneStore();
    await store.openBuiltin(DEMO_URL, 'Demo');
    await store.save();
    const id = workspaceDocuments(project)[0]!.id;

    // RE-PINNED: `rename(id, …)` still targets the catalogue (Phase 6 moves it),
    // so what is asserted here is the SAVED name the workspace carries — the
    // user-visible half — rather than a row that no longer exists.
    store.rename(id, 'Cell 7');
    expect(store.getSnapshot().saved?.name).toBeTruthy();
    expect(workspaceDocuments(project)).toHaveLength(1);
    store.dispose();
    await project.closeProject();
  });

  it('duplicates a document under a new id, pointing back at the original', async () => {
    const project = await bootShared();
    const store = makeSceneStore();
    await store.openBuiltin(DEMO_URL, 'Demo');
    await store.save();
    const id = workspaceDocuments(project)[0]!.id;

    const copyId = await store.duplicate(id);

    expect(copyId).not.toBe(id);
    const docs = workspaceDocuments(project);
    expect(docs.map(d => d.id).sort()).toEqual([id, copyId].sort());
    // RE-PINNED: `copiedFrom` is the document-world spelling of `parentId`.
    expect(docs.find(d => d.id === copyId)!.copiedFrom).toBe(id);
    store.dispose();
    await project.closeProject();
  });

  it('deletes a document out of the manifest and the storage surface', async () => {
    const project = await bootShared();
    const store = makeSceneStore();
    await store.openBuiltin(DEMO_URL, 'Demo');
    await store.save();
    const row = workspaceDocuments(project)[0]!;

    await store.delete(row.id);

    expect(workspaceDocuments(project)).toEqual([]);
    expect(await project.getBackend()!.readDocument(row.path)).toBeNull();
    // Retired, not destroyed — the bytes are in the trash (plan-716 R1-I1).
    expect(await project.getBackend()!.readDocument('.trash/Demo.glb')).not.toBeNull();
    expect(listMetas()).toEqual([]);
    store.dispose();
    await project.closeProject();
  });

  it('carries the classification cache from the body into the index row', () => {
    // Ported unchanged: without it a document cannot say what it is, and the
    // filter chips have nothing to filter on.
    const classified: RvScene = {
      ...makeDraftScene(BUILTIN, 'Classified'),
      id: legacySceneId(),
      classification: PART,
    };
    expect(metaOf(classified).classification).toEqual(PART);

    writeScene(classified);
    expect(readScene(classified.id)?.classification).toEqual(PART);
    expect(listMetas()[0]!.classification).toEqual(PART);

    // "never classified" and "classified as nothing" stay ONE state on disk.
    const plain: RvScene = { ...makeDraftScene(BUILTIN, 'Plain'), id: legacySceneId() };
    expect(metaOf(plain)).not.toHaveProperty('classification');
    expect(metaOf(plain).classification).toBeUndefined();
  });

  it('keeps a document row across repeated saves rather than forking it', async () => {
    // PORTED. The regression this guards is the same shape as before — a save
    // rebuilding the record field by field and dropping what it does not carry
    // — but the record is a manifest row now, and the field that would go
    // missing first is the row itself. So the assertion is that a second and a
    // third save address the SAME document, and the row survives them.
    const project = await bootShared();
    const store = makeSceneStore();
    await store.openBuiltin(DEMO_URL, 'Demo');
    await store.save();
    const first = workspaceDocuments(project)[0]!;

    await store.applyOp({
      id: 'op_reclassify', ts: Date.now(), schemaV: 1, kind: 'setField',
      nodePath: 'Conv1', componentType: 'Drive', fieldName: 'TargetSpeed',
      value: 250, prev: 100,
    } as never);
    await store.save();

    const docs = workspaceDocuments(project);
    expect(docs).toHaveLength(1);
    expect(docs[0]!.id).toBe(first.id);
    expect(docs[0]!.path).toBe(first.path);
    store.dispose();
    await project.closeProject();
  });
});
