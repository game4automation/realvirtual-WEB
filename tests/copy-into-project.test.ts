// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-778 9.18 — Copy into project (F17, Decision 3).
 *
 *  1. The fork: B's document lands in the open project A as a NEW document
 *     (new id, `copiedFrom: { projectId, documentId }`), byte-identical, at A's
 *     root under B's file name (numbered when taken), without B's file facts
 *     (hash, revision, thumbnail pointer, legacy aliases). B is untouched; a
 *     read-only A and an unavailable B are refused and write nothing.
 *  2. The repoint: the selected placement now places A's copy at the SAME
 *     transform, as ONE undo step — undo brings the library placement (with
 *     its qualifier) back, redo the copy. Runs a REAL planner over a REAL op
 *     log (the `planner-commands-undo` pattern).
 *  3. The Inspector origin: a placement made from a library project is found
 *     through its planner record (a live root has no AssetReference yet).
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => ({ store: null as unknown }));

vi.mock('../src/core/hmi/scene/scene-store-singleton', () => ({
  getSceneStore: () => h.store,
}));

import { Object3D } from 'three';
import { FolderBackend } from '../src/core/project/backends/folder-backend';
import type { ProjectBackend } from '../src/core/project/backends/project-backend';
import type { RvDocumentEntry, RvProject } from '../src/core/project/rv-project-types';
import { readDocuments } from '../src/core/project/rv-project-documents';
import { LibraryProjectLoader, setLibraryProjectLoader } from '../src/core/library/library-project-loader';
import {
  LIBRARY_PROJECTS_PROVIDER_ID,
  installLibraryProjectsProvider,
  uninstallLibraryProjectsProvider,
} from '../src/core/library/library-projects-provider';
import { getLibrarySource, resetLibrarySourceRegistryForTests } from '../src/core/library/library-source-registry';
import { copyLibraryDocumentIntoProject, type CopyTargetStore } from '../src/core/library/library-copy-into-project';
import { placementLibraryOrigin } from '../src/core/hmi/rv-library-origin-inspector';
import { setAssetReference } from '../src/core/engine/rv-asset-reference';
import { RvDocument } from '../src/core/ops/rv-document';
import type { RvOp, RvSceneOp } from '../src/core/ops/rv-unified-ops';
import { applyForward, applyInverse } from '../src/core/hmi/scene/rv-scene-executors';
import type { RVViewer } from '../src/core/rv-viewer';
import { setupPlanner, flush, GLB_ENTRY, type PlannerHarness } from './_layout-planner-async-harness';
import { FakeDir, asDirHandle } from './helpers/fake-fs-handles';
import { fakeGlb } from './helpers/fake-document-project';

const PUMP = 'models/pump';

/** Library B (linked folder, read-only to A) with `models/pump.glb`. */
async function libraryB(): Promise<{ b: FakeDir; loader: LibraryProjectLoader }> {
  const b = new FakeDir('Shared');
  b.seedText('project.json', JSON.stringify({
    schemaVersion: 2, id: 'prj_b', name: 'SharedConveyors', canonicalName: 'shared', createdAt: 'x', modifiedAt: 'x',
    documents: [{
      id: PUMP, path: 'models/pump.glb', name: 'Pump', sha256: 'e'.repeat(64), sizeBytes: 1,
      thumbnail: '.thumbnails/pump.1.webp', aliases: ['legacy-pump-id'], collections: ['Pumps'],
    }],
  }));
  b.seedDir('models').seedBytes('pump.glb', fakeGlb('b:pump'));
  const loader = new LibraryProjectLoader({
    factory: {
      folder: (handle, id) => new FolderBackend(handle, { writable: false, id: `folder:${id}` }),
      browser: () => null,
      remote: () => ({ readManifest: async () => null }) as unknown as ProjectBackend,
    },
    getLinkedHandle: async (id) => (id === 'prj_b' ? asDirHandle(b) : null),
    hasReadPermission: async () => true,
    builtinBaseUrl: () => null,
  });
  setLibraryProjectLoader(loader);
  installLibraryProjectsProvider(loader);
  loader.setProject({ schemaVersion: 2, id: 'prj_a', name: 'A', canonicalName: 'a', libraries: [{ projectId: 'prj_b' }] } as unknown as RvProject);
  await loader.whenSettled();
  return { b, loader };
}

/** Open project A: a writable folder plus an in-memory manifest the store keeps. */
async function projectA(opts: { writable?: boolean } = {}): Promise<{ a: FakeDir; store: CopyTargetStore & { project: RvProject } }> {
  const a = new FakeDir('PlantA');
  a.seedDir('models').seedBytes('pump.glb', fakeGlb('a:pump'));
  const backend = new FolderBackend(asDirHandle(a), { writable: opts.writable ?? true });
  await backend.activate();
  const store = {
    project: {
      schemaVersion: 2, id: 'prj_a', name: 'A', canonicalName: 'a',
      documents: [{ id: PUMP, path: 'models/pump.glb', name: 'Local pump' }],
    } as unknown as RvProject,
    getBackend: () => backend as ProjectBackend,
    getProject: () => store.project,
    applyManifestDelta: async (apply: (p: RvProject) => RvProject) => { store.project = apply(store.project); return store.project; },
  };
  return { a, store };
}

afterEach(() => {
  uninstallLibraryProjectsProvider();
  resetLibrarySourceRegistryForTests();
  setLibraryProjectLoader(null);
  h.store = null;
});

describe('plan-778 9.18 — the fork into A', () => {
  it('copies B\'s document as a new document with copiedFrom {projectId, documentId}; B is untouched', async () => {
    const { b } = await libraryB();
    const { a, store } = await projectA();

    const r = await copyLibraryDocumentIntoProject('prj_b', PUMP, store);
    expect(r.kind).toBe('ok');
    const row = (r as { row: RvDocumentEntry }).row;
    expect(row.id).not.toBe(PUMP);
    expect(row.copiedFrom).toEqual({ projectId: 'prj_b', documentId: PUMP });
    expect(row.path).toBe('pump.glb');
    expect(row.name).toBe('Pump');
    expect(row.collections).toEqual(['Pumps']);
    for (const field of ['sha256', 'thumbnail', 'aliases', 'revision', 'mtimeMs']) {
      expect(row, field).not.toHaveProperty(field);
    }
    expect(await a.readText('pump.glb')).toBe(new TextDecoder().decode(fakeGlb('b:pump')));
    expect(readDocuments(store.project)!.map((d) => d.id)).toEqual([PUMP, row.id]);
    // A's own same-id document is untouched.
    expect(await a.readTextAt('models', 'pump.glb')).toBe(new TextDecoder().decode(fakeGlb('a:pump')));
    // B: same bytes, same rows.
    expect(await b.readTextAt('models', 'pump.glb')).toBe(new TextDecoder().decode(fakeGlb('b:pump')));
    expect(JSON.parse((await b.readText('project.json'))!).documents).toHaveLength(1);

    // A second copy never overwrites the first.
    const again = await copyLibraryDocumentIntoProject('prj_b', PUMP, store);
    expect((again as { row: RvDocumentEntry }).row.path).toBe('pump 2.glb');
  });

  it('refuses a read-only A and an unavailable library, writing nothing', async () => {
    await libraryB();
    const { a, store } = await projectA({ writable: false });
    expect(await copyLibraryDocumentIntoProject('prj_b', PUMP, store)).toMatchObject({ kind: 'error' });
    expect(a.has('pump.glb')).toBe(false);

    const { a: a2, store: store2 } = await projectA();
    expect(await copyLibraryDocumentIntoProject('prj_unknown', PUMP, store2)).toMatchObject({ kind: 'error' });
    expect(await copyLibraryDocumentIntoProject('prj_b', 'models/nothing', store2)).toMatchObject({ kind: 'error' });
    expect(a2.has('pump.glb')).toBe(false);
    expect(readDocuments(store2.project)).toHaveLength(1);
  });

  it('review E4: a project switch during the copy records nothing in the other project and removes the written file', async () => {
    await libraryB();
    const { a, store } = await projectA();
    const other = { schemaVersion: 2, id: 'prj_other', name: 'Other', documents: [] } as unknown as RvProject;
    // The switch lands while the delta is queued: the delta runs on the NEXT project.
    store.applyManifestDelta = async (apply) => { store.project = apply(other); return store.project; };
    const r = await copyLibraryDocumentIntoProject('prj_b', PUMP, store);
    expect(r).toMatchObject({ kind: 'error' });
    expect((r as { message: string }).message).toMatch(/project changed/);
    expect(readDocuments(store.project)).toHaveLength(0);
    expect(a.has('pump.glb')).toBe(false);

    // A read-only answer (null) leaves no orphan either.
    const { a: a2, store: store2 } = await projectA();
    store2.applyManifestDelta = async () => null as unknown as RvProject;
    expect(await copyLibraryDocumentIntoProject('prj_b', PUMP, store2)).toMatchObject({ kind: 'error' });
    expect(a2.has('pump.glb')).toBe(false);
  });
});

describe('plan-778 9.18 — the repoint is one undo step', () => {
  let doc: RvDocument;
  let harness: PlannerHarness;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    localStorage.removeItem('rv-layout-autosave');
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => { warn.mockRestore(); localStorage.removeItem('rv-layout-autosave'); });

  function installHistory(viewer: unknown): RvDocument {
    const ctx = { viewer: viewer as RVViewer };
    const d = new RvDocument({
      id: 'plan-778-copy-into-project', name: 'undo', mode: 'scene',
      executor: {
        applyForward: (op: RvOp) => applyForward(op as RvSceneOp, ctx),
        applyInverse: (op: RvOp) => applyInverse(op as RvSceneOp, ctx),
      },
    });
    h.store = {
      applyOp: (op: RvOp) => d.applyOp(op),
      withTransaction: <T>(label: string, fn: () => T | Promise<T>) => d.withTransaction(label, fn),
      undo: () => d.undo(), redo: () => d.redo(), canUndo: () => d.canUndo(), canRedo: () => d.canRedo(),
      describeUndo: () => d.describeUndo(), describeRedo: () => d.describeRedo(), subscribe: () => () => {},
    };
    return d;
  }

  async function boot(): Promise<void> {
    await libraryB();
    harness = setupPlanner();
    const lookup = harness.viewer.getPlugin.getMockImplementation();
    harness.viewer.getPlugin.mockImplementation(((id?: string) =>
      (id === 'layout-planner' ? harness.plugin : lookup?.(id))) as never);
    doc = installHistory(harness.viewer);
  }

  const records = () => harness.store.getSnapshot().placed;

  it('places A\'s copy at the same transform; undo restores the library placement; redo the copy', async () => {
    await boot();
    const libraryEntry = getLibrarySource(LIBRARY_PROJECTS_PROVIDER_ID, 'prj_b')!.getEntry(PUMP)!;
    const id = await harness.plugin.placeComponent(libraryEntry, [2, 0, 1]);
    await flush();
    await harness.plugin.moveById(id, [2, 0.5, 1], [0, 90, 0]);
    await flush();
    expect(records()[0]).toMatchObject({ id, catalogId: PUMP, providerId: LIBRARY_PROJECTS_PROVIDER_ID, sourceId: 'prj_b' });
    const before = doc.opCount;

    // The Inspector finds the origin through the planner record.
    const root = harness.plugin.getPlacedRootById(id)!;
    expect(placementLibraryOrigin(harness.viewer as unknown as RVViewer, root))
      .toEqual({ placementId: id, libraryProjectId: 'prj_b', documentId: PUMP });

    const copyEntry = { ...GLB_ENTRY, id: 'doc_copy_of_pump', name: 'Pump' };
    const next = await harness.plugin.repointPlacement(id, copyEntry, 'Copy into project');
    await flush();
    expect(next).toBeTruthy();
    expect(doc.opCount).toBe(before + 1);
    expect(doc.describeUndo()).toContain('Copy into project');
    expect(records()).toHaveLength(1);
    const copied = records()[0];
    expect(copied.id).toBe(next);
    expect(copied.catalogId).toBe('doc_copy_of_pump');
    expect(copied.providerId).toBeUndefined();
    expect(copied.sourceId).toBeUndefined();
    expect(copied.position[0]).toBeCloseTo(2, 5);
    expect(copied.position[1]).toBeCloseTo(0.5, 5);
    expect(copied.position[2]).toBeCloseTo(1, 5);
    expect(copied.rotation[1]).toBeCloseTo(90, 5);
    expect(placementLibraryOrigin(harness.viewer as unknown as RVViewer, harness.plugin.getPlacedRootById(next!)!)).toBeNull();

    await doc.undo();
    await flush();
    expect(records()).toHaveLength(1);
    expect(records()[0]).toMatchObject({ id, catalogId: PUMP, providerId: LIBRARY_PROJECTS_PROVIDER_ID, sourceId: 'prj_b' });
    expect(records()[0].position[1]).toBeCloseTo(0.5, 5);
    expect(harness.plugin.getPlacedRootById(next!)).toBeNull();

    await doc.redo();
    await flush();
    expect(records().map((p) => p.catalogId)).toEqual(['doc_copy_of_pump']);
  });

  it('an unknown placement id is refused without touching the history', async () => {
    await boot();
    const before = doc.opCount;
    expect(await harness.plugin.repointPlacement('nope', { ...GLB_ENTRY })).toBeNull();
    expect(doc.opCount).toBe(before);
  });
});

describe('plan-778 9.18 — the Inspector origin of a reloaded placement', () => {
  it('reads a qualified AssetReference; a legacy or unqualified one is not a library origin', () => {
    const node = new Object3D();
    setAssetReference(node, { assetId: PUMP, providerId: LIBRARY_PROJECTS_PROVIDER_ID, sourceId: 'prj_b' });
    expect(placementLibraryOrigin(null, node)).toEqual({ placementId: null, libraryProjectId: 'prj_b', documentId: PUMP });
    const legacy = new Object3D();
    setAssetReference(legacy, { assetId: 'pallethandling-chainconveyor-1m' });
    expect(placementLibraryOrigin(null, legacy)).toBeNull();
  });
});
