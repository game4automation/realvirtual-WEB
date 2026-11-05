// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-780 9.1 / 9.2 — the planner inside a LIBRARY document (Edit in library,
 * `viewer.currentModelScope` = library B). Real planner, real
 * `PlacementInstancer` + `ModelCache`; the fake GLTF loader names every bake
 * after the marker in the bytes it was handed, so each assertion knows WHOSE
 * bytes were used. The open project A holds a same-id `models/pump` ('a:pump'),
 * so a lookup that loses B's scope lands visibly in A.
 *
 *  - R2: copy and undo (delete → restore through `placeFromRecord`, the op
 *    replay) of an unqualified placement in B's document resolve in B — never
 *    in the open project; the same record with a null scope does land in A
 *    (the control that makes the test discriminate).
 *  - A1: placing a document of the open project A, which B does not list,
 *    is qualified into A and raises the visible Problems warning; a part of the
 *    realvirtual library is always allowed (qualified, no warning).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { Group, Scene } from 'three';
import type { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { ModelCache } from '../src/plugins/layout-planner/model-cache';
import { BakeRegistry } from '../src/core/engine/rv-bake-registry';
import { createPickBuildPort } from '../src/core/engine/rv-pick-build-port';
import { RVUberMaterial } from '../src/core/engine/rv-uber-material';
import { loadGLB } from '../src/core/engine/rv-scene-loader';
import {
  getLibrarySource,
  registerLibrarySourceProvider,
  resetLibrarySourceRegistryForTests,
  type LibrarySource,
} from '../src/core/library/library-source-registry';
import type { LibraryCatalogEntry } from '../src/core/library/library-types';
import type { RvProject } from '../src/core/project/rv-project-types';
import type { ProjectBackend } from '../src/core/project/backends/project-backend';
import { LibraryProjectLoader } from '../src/core/library/library-project-loader';
import {
  LIBRARY_PROJECTS_PROVIDER_ID,
  installLibraryProjectsProvider,
  uninstallLibraryProjectsProvider,
} from '../src/core/library/library-projects-provider';
import { OPEN_PROJECT_PROVIDER_ID, REALVIRTUAL_LIBRARY_PROJECT_ID, type DocumentScope } from '../src/core/library/library-origin';
import { getProjectStore } from '../src/core/project/project-store';
import { clearAllProblems, getProblem, getProblems } from '../src/core/hmi/problems-store';
import { group, uberMesh } from './fixtures/bake-fixture';
import { fakeGlb, fakeLibraryProject } from './helpers/fake-document-project';
import { setupPlanner, internals } from './_layout-planner-async-harness';
import { documentBytes as nestedDocumentBytes } from './helpers/nested-placement-fixture';

const uber = new RVUberMaterial(false);
const PUMP = 'models/pump';
const LIB_B: DocumentScope = { providerId: LIBRARY_PROJECTS_PROVIDER_ID, sourceId: 'prj_b' };

function markerOfBytes(bytes: ArrayBuffer): string {
  const view = new DataView(bytes);
  const jsonLen = view.getUint32(12, true);
  return JSON.parse(new TextDecoder().decode(new Uint8Array(bytes, 20, jsonLen)).trim()).nodes[0].name;
}

/** A GLTF loader that builds a bakeable tree named after the marker in the bytes. */
function markerLoader(): GLTFLoader {
  return {
    loadAsync: async (url: string): Promise<{ scene: Group }> => {
      const marker = markerOfBytes(await (await fetch(url)).arrayBuffer());
      const root = group(marker);
      root.add(uberMesh(uber, `${marker}-mesh`, [0, 0.5, 0]));
      return { scene: root };
    },
  } as unknown as GLTFLoader;
}

/** The open project A as a library source: `models/pump` ('a:pump') and an A-only document. */
function openProjectA(): () => void {
  const entries: LibraryCatalogEntry[] = [
    { id: PUMP, documentId: PUMP, name: 'A pump', category: 'custom', glbUrl: '', localPath: 'models/pump.glb' },
    { id: 'doc_a_only', documentId: 'doc_a_only', name: 'A only', category: 'custom', glbUrl: '', localPath: 'models/a-only.glb' },
  ];
  const source: LibrarySource = {
    id: 'prj_a', label: 'Plant A', kind: 'project', writable: true, loaded: true,
    listEntries: () => entries,
    getEntry: (id) => entries.find((e) => e.id === id) ?? null,
    resolveAsset: async (assetId) => ({
      url: URL.createObjectURL(new Blob([fakeGlb(assetId === PUMP ? 'a:pump' : 'a:only') as unknown as BlobPart])),
    }),
  };
  return registerLibrarySourceProvider({ id: OPEN_PROJECT_PROVIDER_ID, listSources: () => [source], subscribe: () => () => {} });
}

/** A lists library B (which does NOT list A); the realvirtual library is always there. */
async function world(): Promise<LibraryProjectLoader> {
  const b = fakeLibraryProject({
    id: 'prj_b', name: 'SharedConveyors', kind: 'browser',
    documents: [{ id: PUMP, path: 'models/pump.glb', marker: 'b:pump' }],
  });
  const rv = fakeLibraryProject({
    id: REALVIRTUAL_LIBRARY_PROJECT_ID, name: 'realvirtual Library',
    documents: [{ id: 'rv-belt', path: 'conveyors/belt.glb', marker: 'rv:belt' }],
  });
  const loader = new LibraryProjectLoader({
    factory: {
      folder: () => { throw new Error('no folders'); },
      browser: (id) => (id === 'prj_b' ? b.backend : null),
      remote: () => rv.backend as unknown as ProjectBackend,
    },
    builtinBaseUrl: () => 'https://rv.test/library/',
  });
  installLibraryProjectsProvider(loader);
  loader.setProject({ schemaVersion: 2, id: 'prj_a', name: 'Plant A', canonicalName: 'a', libraries: [{ projectId: 'prj_b' }] } as unknown as RvProject);
  await loader.whenSettled();
  return loader;
}

/** A planner over a loaded (empty) layout document whose scope is `scope`. */
async function plannerIn(scope: DocumentScope): Promise<{ h: ReturnType<typeof setupPlanner>; registry: BakeRegistry }> {
  localStorage.clear();
  const h = setupPlanner();
  h.plugin.placements.setModelCache(new ModelCache(markerLoader(), { uber: () => uber, pickPort: () => createPickBuildPort({ createWorker: () => null }) }));
  const registry = new BakeRegistry();
  const result = await loadGLB('layout.glb', new Scene(), {
    data: await nestedDocumentBytes([]),
    referenceResolver: (async () => null) as never,
    deferPlacements: true, bakeRegistry: registry, bakePickPort: createPickBuildPort({ createWorker: () => null }), loadKinematicsSidecar: false,
  });
  const v = h.viewer as unknown as Record<string, unknown>;
  h.viewer.scene.add(result.root);
  v.currentModel = result.root;
  v.registry = result.registry;
  v.signalStore = result.signalStore;
  v.transportManager = result.transportManager;
  v.bakeRegistry = registry;
  v.currentModelScope = scope;
  h.plugin.onModelLoaded(result, h.viewer as never);
  await h.plugin.whenPlacementsMaterialized();
  return { h, registry };
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
  uninstallLibraryProjectsProvider();
  resetLibrarySourceRegistryForTests();
  clearAllProblems();
  vi.restoreAllMocks();
});

describe('plan-780 R2 — copy and undo inside a library document keep B\'s scope', () => {
  it('place → copy → undo of the delete: every bake is B\'s; the same record without a scope lands in A', async () => {
    await world();
    cleanups.push(openProjectA());
    const { h, registry } = await plannerIn(LIB_B);
    const objects = internals(h.plugin)._objectMap;
    const bakedOf = (id: string): string | null => registry.instanceOf(objects.get(id)!)?.baked.template.name ?? null;

    // A2: B's own document is written UNQUALIFIED into B's document.
    const entry = getLibrarySource(LIBRARY_PROJECTS_PROVIDER_ID, 'prj_b')!.getEntry(PUMP)!;
    const id = await h.plugin.placeComponent(entry, [1, 0, 0]);
    const rec = h.plugin.store.getSnapshot().placed.find((p) => p.id === id)!;
    expect([rec.catalogId, rec.providerId, rec.sourceId]).toEqual([PUMP, undefined, undefined]);
    expect(bakedOf(id)).toBe('b:pump');

    // Copy (Ctrl+D / paste) of the unqualified record: resolved in B.
    const copyId = (await internals(h.plugin)._clonePlacement(rec))!;
    const copy = h.plugin.store.getSnapshot().placed.find((p) => p.id === copyId)!;
    expect([copy.catalogId, copy.providerId, copy.sourceId]).toEqual([PUMP, undefined, undefined]);
    expect(bakedOf(copyId)).toBe('b:pump');

    // Undo of the copy's delete: the op replay rebuilds it from its record — in B.
    const copyRecord = { ...copy };
    await h.plugin.removeByIds([copyId]);
    expect(objects.has(copyId)).toBe(false);
    await h.plugin.placeFromRecord(copyRecord);
    await h.plugin.whenPlacementsMaterialized();
    expect(bakedOf(copyId)).toBe('b:pump');

    // Control: the SAME unqualified record in a document of the open project resolves in A.
    (h.viewer as unknown as Record<string, unknown>).currentModelScope = null;
    await h.plugin.placeFromRecord({ ...copyRecord, id: 'control', label: 'control' });
    expect(bakedOf('control')).toBe('a:pump');
  });
});

describe('plan-780 A1 — placing into a library document', () => {
  it('an open-project document B does not list: qualified into A + the visible Problems warning', async () => {
    await world();
    cleanups.push(openProjectA());
    vi.spyOn(getProjectStore(), 'getProject').mockReturnValue({ id: 'prj_a', name: 'Plant A' } as unknown as RvProject);
    const { h } = await plannerIn(LIB_B);

    const entry = getLibrarySource(OPEN_PROJECT_PROVIDER_ID, 'prj_a')!.getEntry('doc_a_only')!;
    const id = await h.plugin.placeComponent(entry, [2, 0, 0]);
    const rec = h.plugin.store.getSnapshot().placed.find((p) => p.id === id)!;
    expect([rec.catalogId, rec.providerId, rec.sourceId]).toEqual(['doc_a_only', LIBRARY_PROJECTS_PROVIDER_ID, 'prj_a']);

    const problem = getProblem('library-scope-placement:prj_b:doc_a_only');
    expect(problem, JSON.stringify(getProblems())).toBeTruthy();
    expect(problem!.severity).toBe('warning');
    expect(problem!.title).toBe("Placed outside library 'prj_b'");
    expect(problem!.detail).toMatch(/open project 'prj_a', which library 'prj_b' does not list/);
  });

  it('a part of the realvirtual library is always allowed: qualified, no warning', async () => {
    await world();
    cleanups.push(openProjectA());
    vi.spyOn(getProjectStore(), 'getProject').mockReturnValue({ id: 'prj_a', name: 'Plant A' } as unknown as RvProject);
    const { h, registry } = await plannerIn(LIB_B);

    const entry = getLibrarySource(LIBRARY_PROJECTS_PROVIDER_ID, REALVIRTUAL_LIBRARY_PROJECT_ID)!.getEntry('rv-belt')!;
    const id = await h.plugin.placeComponent(entry, [3, 0, 0]);
    const rec = h.plugin.store.getSnapshot().placed.find((p) => p.id === id)!;
    expect([rec.catalogId, rec.providerId, rec.sourceId]).toEqual(['rv-belt', LIBRARY_PROJECTS_PROVIDER_ID, REALVIRTUAL_LIBRARY_PROJECT_ID]);
    expect(registry.instanceOf(internals(h.plugin)._objectMap.get(id)!)?.baked.template.name).toBe('rv:belt');
    expect(getProblems().filter((p) => p.code === 'library-scope-placement')).toEqual([]);
  });
});
