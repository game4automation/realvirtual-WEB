// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-778 9.5 — qualified placements (F4 / F8).
 *
 * A placement made from a library project stores `providerId:
 * 'library-projects'` + `sourceId` (the library's project id) + `assetId` (the
 * document id) and no `path`. It resolves in that ONE library: two libraries
 * with the same document id never mix, a stored path is ignored, a missing
 * library is a placeholder, and the placeholder comes back without a reload
 * when the library becomes ready. Runs the REAL `PlacementInstancer` +
 * `ModelCache` + `BakeRegistry` (fake GLTF loader that reads the marker out of
 * the bytes it is handed, so every assertion knows WHOSE bytes were used).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { Group, Object3D, Scene } from 'three';
import type { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { ModelCache } from '../src/core/engine/rv-model-cache';
import { BakeRegistry } from '../src/core/engine/rv-bake-registry';
import { createPickBuildPort } from '../src/core/engine/rv-pick-build-port';
import { RVUberMaterial } from '../src/core/engine/rv-uber-material';
import {
  PlacementInstancer,
  collectDeferredPlacements,
  collectNestedReferences,
} from '../src/core/engine/rv-placement-instancer';
import {
  getAssetReference,
  markDeferredPlacement,
  setAssetReference,
  setPlacementMeta,
  type AssetOverrides,
  type AssetReference,
} from '../src/core/engine/rv-asset-reference';
import { setNodeId } from '../src/core/engine/rv-node-id';
import {
  buildMissingReferencePlaceholder,
  isMissingReferencePlaceholder,
  missingPlacementLabel,
} from '../src/core/engine/rv-missing-reference-placeholder';
import { compose, ReferenceCycleError } from '../src/core/engine/rv-glb-compose';
import { objectToGlb } from '../src/core/import/rv-import-object';
import { loadGLB } from '../src/core/engine/rv-scene-loader';
import { getLibrarySource, registerLibrarySourceProvider, resetLibrarySourceRegistryForTests, resolveAsset, type LibrarySource } from '../src/core/library/library-source-registry';
import type { LibraryCatalogEntry } from '../src/core/library/library-types';
import { FolderBackend } from '../src/core/project/backends/folder-backend';
import { ensureHandlePermission } from '../src/core/engine/rv-local-filesystem';
import type { ProjectBackend } from '../src/core/project/backends/project-backend';
import type { RvProject } from '../src/core/project/rv-project-types';
import { LibraryProjectLoader } from '../src/core/library/library-project-loader';
import {
  LIBRARY_PROJECTS_PROVIDER_ID,
  installLibraryProjectsProvider,
  uninstallLibraryProjectsProvider,
} from '../src/core/library/library-projects-provider';
import { entryOriginOf } from '../src/core/library/library-origin';
import { placementExtras } from '../src/core/hmi/scene/rv-scene-glb-bake';
import { readPlacementsFromScene } from '../src/core/hmi/scene/rv-scene-glb-read';
import { deserializeLayout, serializeLayout, type PlacedComponent } from '../src/plugins/layout-planner/rv-layout-store';
import { planReferencedAssetOpen } from '../src/core/project/rv-referenced-asset-open';
import { ensurePlannerCommandsRegistered, resolvePlaceEntry } from '../src/plugins/layout-planner/planner-commands';
import { CommandRegistry } from '../src/core/hmi/rv-command-registry';
import type { LayoutPlannerPlugin } from '../src/plugins/layout-planner/index';
import { group, uberMesh } from './fixtures/bake-fixture';
import { FakeDir, asDirHandle } from './helpers/fake-fs-handles';
import { fakeGlb, fakeLibraryProject, type FakeLibraryProject } from './helpers/fake-document-project';
import { setupPlanner, internals } from './_layout-planner-async-harness';
import { documentBytes as nestedDocumentBytes } from './helpers/nested-placement-fixture';

const uber = new RVUberMaterial(false);
const PUMP = 'models/pump';

/** The node name a `fakeGlb(marker)` carries. */
function markerOfBytes(bytes: ArrayBuffer): string {
  const view = new DataView(bytes);
  const jsonLen = view.getUint32(12, true);
  return JSON.parse(new TextDecoder().decode(new Uint8Array(bytes, 20, jsonLen)).trim()).nodes[0].name;
}

/** A GLTF loader that builds a bakeable tree named after the marker in the bytes. */
function markerLoader(): { loader: GLTFLoader; decoded: string[]; urls: string[] } {
  const decoded: string[] = [];
  const urls: string[] = [];
  const loader = {
    loadAsync: async (url: string): Promise<{ scene: Group }> => {
      urls.push(url);
      const marker = markerOfBytes(await (await fetch(url)).arrayBuffer());
      decoded.push(marker);
      const root = group(marker);
      root.add(uberMesh(uber, `${marker}-mesh`, [0, 0.5, 0]));
      return { scene: root };
    },
  } as unknown as GLTFLoader;
  return { loader, decoded, urls };
}

function projectA(libraries: unknown[]): RvProject {
  return { schemaVersion: 2, id: 'prj_a', name: 'A', canonicalName: 'a', libraries } as unknown as RvProject;
}

interface World {
  loader: LibraryProjectLoader;
  instancer: PlacementInstancer;
  registry: BakeRegistry;
  decoded: string[];
  urls: string[];
  reresolved: string[];
  lost: string[];
  libs: Record<string, FakeLibraryProject>;
  folders: Map<string, FakeDir>;
}

/** Libraries B and C both hold `models/pump`; A lists both. */
async function world(opts: { lockedB?: boolean } = {}): Promise<World> {
  const libs: Record<string, FakeLibraryProject> = {
    prj_c: fakeLibraryProject({ id: 'prj_c', name: 'Motors', documents: [{ id: PUMP, path: 'models/pump.glb', marker: 'c:pump' }] }),
  };
  const folders = new Map<string, FakeDir>();
  const bFolder = new FakeDir('Shared');
  bFolder.seedText('project.json', JSON.stringify({
    schemaVersion: 2, id: 'prj_b', name: 'SharedConveyors', canonicalName: 'shared', createdAt: 'x', modifiedAt: 'x',
    documents: [{ id: PUMP, path: 'models/pump.glb', name: 'Pump' }],
  }));
  bFolder.seedDir('models').seedBytes('pump.glb', fakeGlb('b:pump'));
  if (opts.lockedB) bFolder.permissions.read = 'prompt';
  folders.set('prj_b', bFolder);

  const loader = new LibraryProjectLoader({
    factory: {
      folder: (h, id) => new FolderBackend(h, { writable: false, id: `folder:${id}` }),
      browser: (id) => libs[id]?.backend ?? null,
      remote: () => ({ readManifest: async () => null }) as unknown as ProjectBackend,
    },
    getLinkedHandle: async (id) => (folders.has(id) ? asDirHandle(folders.get(id)!) : null),
    hasReadPermission: async (h) => (await ensureHandlePermission(h, { mode: 'read', prompt: false })) !== null,
    builtinBaseUrl: () => null,
  });
  installLibraryProjectsProvider(loader);
  loader.setProject(projectA([{ projectId: 'prj_b' }, { projectId: 'prj_c' }]));
  await loader.whenSettled();

  const { loader: gltf, decoded, urls } = markerLoader();
  const registry = new BakeRegistry();
  const reresolved: string[] = [];
  const lost: string[] = [];
  const instancer = new PlacementInstancer({
    bakeRegistry: () => registry,
    uber: () => uber,
    pickPort: () => createPickBuildPort({ createWorker: () => null }),
    isLive: () => true,
    missingDefault: (entry) => {
      entry.node.add(buildMissingReferencePlaceholder({
        label: missingPlacementLabel({ assetId: entry.ref.catalogId, path: entry.ref.glbUrl, providerId: entry.ref.providerId, sourceId: entry.ref.sourceId }),
        assetId: entry.ref.catalogId,
      }));
    },
    onReresolve: (entry) => { reresolved.push(entry.id); },
    // plan-778 Decision D: the host's half of "the library went away" (undo of registration).
    lostDefault: (entry) => { lost.push(entry.id); },
  });
  instancer.setModelCache(new ModelCache(gltf, { uber: () => uber, pickPort: () => createPickBuildPort({ createWorker: () => null }) }));
  return { loader, instancer, registry, decoded, urls, reresolved, lost, libs, folders };
}

/** A document root with deferred reference nodes, as `loadGLB({deferPlacements})` leaves it. */
function documentWith(refs: Array<{ id: string; ref: AssetReference }>): Group {
  const root = new Group();
  for (const { id, ref } of refs) {
    const node = new Object3D();
    node.name = id;
    setNodeId(node, id);
    setAssetReference(node, ref);
    setPlacementMeta(node, {});
    markDeferredPlacement(node, id);
    root.add(node);
  }
  return root;
}

function bakedName(w: World, node: Object3D): string | null {
  return w.registry.instanceOf(node)?.baked.template.name ?? null;
}

const QUAL = (sourceId: string, extra: Partial<AssetReference> = {}): AssetReference => ({
  assetId: PUMP, providerId: LIBRARY_PROJECTS_PROVIDER_ID, sourceId, ...extra,
});

afterEach(() => {
  uninstallLibraryProjectsProvider();
  resetLibrarySourceRegistryForTests();
  vi.unstubAllGlobals();
});

describe('plan-778 9.5 — the real instancer', () => {
  it('two libraries with document id models/pump: each qualified placement gets ITS library\'s bytes', async () => {
    const w = await world();
    const root = documentWith([{ id: 'p_b', ref: QUAL('prj_b') }, { id: 'p_c', ref: QUAL('prj_c') }]);
    w.instancer.materializeDeferred(collectDeferredPlacements(root));
    await w.instancer.whenMaterialized();
    expect(bakedName(w, root.children[0])).toBe('b:pump');
    expect(bakedName(w, root.children[1])).toBe('c:pump');
    expect(w.decoded.sort()).toEqual(['b:pump', 'c:pump']);
    // Every object URL the libraries handed out was released (ModelCache release).
    expect(w.libs.prj_c.outstandingUrls()).toBe(0);
  });

  it('a stored path beside the qualifier is ignored — the library wins, the path is never fetched', async () => {
    const w = await world();
    const fetched: string[] = [];
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => { fetched.push(String(url)); return realFetch(url, init); });
    const root = documentWith([{ id: 'p', ref: QUAL('prj_c', { path: 'https://elsewhere.invalid/pump.glb' }) }]);
    const [entry] = collectDeferredPlacements(root);
    expect(entry.ref.glbUrl).toBe('');
    w.instancer.materializeDeferred([entry]);
    await w.instancer.whenMaterialized();
    expect(bakedName(w, root.children[0])).toBe('c:pump');
    expect(fetched.some((u) => u.includes('elsewhere.invalid'))).toBe(false);
  });

  it('qualified + missing document: placeholder naming the library, no fallback anywhere', async () => {
    const w = await world();
    const root = documentWith([{ id: 'p', ref: { ...QUAL('prj_c'), assetId: 'models/absent' } }]);
    w.instancer.materializeDeferred(collectDeferredPlacements(root));
    await w.instancer.whenMaterialized();
    const node = root.children[0];
    expect(w.registry.instanceOf(node)).toBeNull();
    const ph = node.children.find(isMissingReferencePlaceholder)!;
    expect(ph.name).toBe('Missing: models/absent from library Motors');
  });

  it('qualified into a LOCKED library: placeholder at once; Grant → replaced in place without reload (F8), no negative cache', async () => {
    const w = await world({ lockedB: true });
    expect(getLibrarySource(LIBRARY_PROJECTS_PROVIDER_ID, 'prj_b')!.needsPermission).toBe(true);
    const root = documentWith([{ id: 'p', ref: QUAL('prj_b') }]);
    w.instancer.materializeDeferred(collectDeferredPlacements(root));
    await w.instancer.whenMaterialized();
    const node = root.children[0];
    expect(w.registry.instanceOf(node)).toBeNull();
    expect(node.children.some(isMissingReferencePlaceholder)).toBe(true);
    expect(w.instancer.unresolvedCount).toBe(1);

    // Grant (Phase 2's click) = permission + loader invalidation.
    w.folders.get('prj_b')!.permissions.read = 'granted';
    w.loader.invalidate('prj_b');
    await w.loader.whenSettled();
    await new Promise((r) => setTimeout(r, 0));
    await w.instancer.whenMaterialized();
    expect(w.reresolved).toEqual(['p']);
    expect(node.children.some(isMissingReferencePlaceholder)).toBe(false);
    expect(bakedName(w, node)).toBe('b:pump');
    expect(w.instancer.unresolvedCount).toBe(0);
  });

  it('Decision D: detaching a library turns its STANDING placements into placeholders without a reload; re-attach restores them', async () => {
    const w = await world();
    const root = documentWith([{ id: 'p_b', ref: QUAL('prj_b') }, { id: 'p_c', ref: QUAL('prj_c') }]);
    w.instancer.materializeDeferred(collectDeferredPlacements(root));
    await w.instancer.whenMaterialized();
    const [nodeB, nodeC] = [root.children[0], root.children[1]];
    expect(bakedName(w, nodeB)).toBe('b:pump');
    expect(bakedName(w, nodeC)).toBe('c:pump');

    // Detach B (library.detach = a manifest delta + the loader following the project).
    w.loader.setProject(projectA([{ projectId: 'prj_c' }]));
    await w.loader.whenSettled();
    await new Promise((r) => setTimeout(r, 0));

    expect(w.lost).toEqual(['p_b']);                                   // the host was asked to undo its registration
    expect(w.registry.instanceOf(nodeB)).toBeNull();                   // instance released
    const ph = nodeB.children.filter(isMissingReferencePlaceholder);
    expect(ph).toHaveLength(1);
    expect(ph[0].name).toBe('Missing: models/pump from library prj_b');
    expect(nodeB.children).toHaveLength(1);                            // no leftover content
    expect(w.instancer.unresolvedCount).toBe(1);
    expect(bakedName(w, nodeC)).toBe('c:pump');                        // another library's placement is untouched
    expect(nodeC.children.some(isMissingReferencePlaceholder)).toBe(false);

    // Re-attach: the same node gets its content back, nothing was deleted in between.
    w.loader.setProject(projectA([{ projectId: 'prj_b' }, { projectId: 'prj_c' }]));
    await w.loader.whenSettled();
    await new Promise((r) => setTimeout(r, 0));
    await w.instancer.whenMaterialized();
    expect(w.reresolved).toEqual(['p_b']);
    expect(nodeB.children.some(isMissingReferencePlaceholder)).toBe(false);
    expect(bakedName(w, nodeB)).toBe('b:pump');
    expect(w.instancer.unresolvedCount).toBe(0);
  });

  it('nested references INSIDE a library document are that library\'s: project:<path> and a bare id get its qualifier', async () => {
    const w = await world();
    const ref = (id: string, assetId: string): Object3D => {
      const n = new Object3D(); n.name = id; setNodeId(n, id); setAssetReference(n, { assetId }); return n;
    };
    const nodes = [
      ref('byPath', 'project:models/pump.glb'),   // the library's document at that path → its id
      ref('byId', PUMP),                          // a bare id the library holds
      ref('foreign', 'realvirtual-conveyor-glb'),  // not the library's → as written
      ref('unknownPath', 'project:nope.glb'),     // still the library's: the error must name it, not the open project
    ];
    const lib = { providerId: LIBRARY_PROJECTS_PROVIDER_ID, sourceId: 'prj_c' };
    const scan = (parentLibrary?: typeof lib) => collectNestedReferences(
      { node: new Group(), id: 'p', occurrence: 'p' },
      { parentKey: 'k', parentUrl: '', parentState: 'none', keyOf: (r) => r.catalogId, nodes, ...(parentLibrary ? { parentLibrary } : {}) },
    ).entries.map((e) => ({ catalogId: e.ref.catalogId, sourceId: e.ref.sourceId ?? null }));
    expect(scan(lib)).toEqual([
      { catalogId: PUMP, sourceId: 'prj_c' },
      { catalogId: PUMP, sourceId: 'prj_c' },
      { catalogId: 'realvirtual-conveyor-glb', sourceId: null },
      { catalogId: 'project:nope.glb', sourceId: 'prj_c' },
    ]);
    // A document of the open project (no parent library) keeps every reference as written.
    expect(scan().map((e) => e.sourceId)).toEqual([null, null, null, null]);
    void w;
  });

  it('Phase 3 residual: a placement whose values live only in the host record is restored with THOSE overrides, not the standard variant', async () => {
    const w = await world();
    const root = documentWith([{ id: 'p_b', ref: QUAL('prj_b') }]);
    const nodeB = root.children[0];
    const values = { byAddress: { '#fam': { ParametricComponent: { Values: { Length: 2400 } } } } } as unknown as AssetOverrides;
    const record = new Map<string, AssetOverrides>([['p_b', values]]);
    const seen: Array<AssetOverrides | null | undefined> = [];
    const original = w.instancer.resolveBaked.bind(w.instancer);
    vi.spyOn(w.instancer, 'resolveBaked').mockImplementation((ref, opts) => {
      seen.push(opts?.overrides);
      return original(ref, { ...opts, overrides: null });   // the marker loader knows no families
    });
    w.instancer.materializeDeferred(collectDeferredPlacements(root), { overridesOf: (e) => record.get(e.id) ?? null });
    await w.instancer.whenMaterialized();
    expect(seen).toEqual([values]);

    w.loader.setProject(projectA([{ projectId: 'prj_c' }]));            // the library goes away
    await w.loader.whenSettled();
    await new Promise((r) => setTimeout(r, 0));
    expect(w.registry.instanceOf(nodeB)).toBeNull();

    const changed = { byAddress: { '#fam': { ParametricComponent: { Values: { Length: 3000 } } } } } as unknown as AssetOverrides;
    record.set('p_b', changed);                                         // edited meanwhile: the CURRENT value wins
    w.loader.setProject(projectA([{ projectId: 'prj_b' }, { projectId: 'prj_c' }]));
    await w.loader.whenSettled();
    await new Promise((r) => setTimeout(r, 0));
    await w.instancer.whenMaterialized();
    expect(bakedName(w, nodeB)).toBe('b:pump');
    expect(seen).toEqual([values, changed]);
  });

  it('Decision D: a runtime ready -> error of the library does the same (folder moved / deleted); a retry restores', async () => {
    const w = await world();
    const root = documentWith([{ id: 'p_b', ref: QUAL('prj_b') }]);
    w.instancer.materializeDeferred(collectDeferredPlacements(root));
    await w.instancer.whenMaterialized();
    const node = root.children[0];
    expect(bakedName(w, node)).toBe('b:pump');

    w.loader.markError('prj_b', 'folder is gone');
    await new Promise((r) => setTimeout(r, 0));
    expect(w.registry.instanceOf(node)).toBeNull();
    expect(node.children.filter(isMissingReferencePlaceholder)).toHaveLength(1);
    expect(w.instancer.unresolvedCount).toBe(1);

    w.loader.invalidate('prj_b');
    await w.loader.whenSettled();
    await new Promise((r) => setTimeout(r, 0));
    await w.instancer.whenMaterialized();
    expect(bakedName(w, node)).toBe('b:pump');
    expect(node.children.some(isMissingReferencePlaceholder)).toBe(false);
  });

  it('Decision D: a library that stays listed keeps its placements when the project is set again', async () => {
    const w = await world();
    const root = documentWith([{ id: 'p_c', ref: QUAL('prj_c') }]);
    w.instancer.materializeDeferred(collectDeferredPlacements(root));
    await w.instancer.whenMaterialized();
    const node = root.children[0];
    w.loader.setProject(projectA([{ projectId: 'prj_b' }, { projectId: 'prj_c' }]));
    await w.loader.whenSettled();
    await new Promise((r) => setTimeout(r, 0));
    expect(w.lost).toEqual([]);
    expect(bakedName(w, node)).toBe('c:pump');
  });

  it('review C5: a provider that rebuilds its source OBJECTS per notify does not re-fetch a failing legacy placeholder', async () => {
    const w = await world();
    let resolveCalls = 0;
    const listeners = new Set<() => void>();
    const makeSource = (): LibrarySource => {
      const entry = { id: 'legacy-pump', name: 'Legacy pump', category: 'x', localPath: 'models/legacy.glb' } as unknown as LibraryCatalogEntry;
      return {
        id: 'prj_open', label: 'Open project', kind: 'project', writable: true, loaded: true, error: null,
        listEntries: () => [entry],
        getEntry: (id) => (id === 'legacy-pump' ? entry : null),
        resolveAsset: async () => { resolveCalls++; throw new Error('Asset "models/legacy.glb" could not be read.'); },
      };
    };
    let sources = [makeSource()];
    const unregister = registerLibrarySourceProvider({
      id: 'project',
      listSources: () => sources,
      subscribe: (l) => { listeners.add(l); return () => listeners.delete(l); },
    });
    try {
      const root = documentWith([{ id: 'p_legacy', ref: { assetId: 'legacy-pump' } }]);
      w.instancer.materializeDeferred(collectDeferredPlacements(root));
      await w.instancer.whenMaterialized();
      expect(root.children[0].children.some(isMissingReferencePlaceholder)).toBe(true);
      expect(w.instancer.unresolvedCount).toBe(1);
      const before = resolveCalls;
      // Three store notifies, each with fresh-but-equal source objects.
      for (let i = 0; i < 3; i++) {
        sources = [makeSource()];
        for (const l of listeners) l();
        await new Promise((r) => setTimeout(r, 0));
        await w.instancer.whenMaterialized();
      }
      expect(resolveCalls).toBe(before);
      expect(w.reresolved).toEqual([]);
      expect(w.instancer.unresolvedCount).toBe(1);
    } finally {
      unregister();
    }
  });


  it('compose: B\'s models/pump placing C\'s models/pump is NOT a reference cycle', async () => {
    const inner = new Group();
    inner.name = 'B-pump';
    const ref = new Object3D();
    ref.name = 'motor';
    setNodeId(ref, 'n-motor');
    setAssetReference(ref, QUAL('prj_c'));
    inner.add(ref);
    const bBytes = await objectToGlb(inner);
    const cBytes = fakeGlb('c:pump').buffer as ArrayBuffer;

    const top = new Group();
    const placed = new Object3D();
    placed.name = 'pump';
    setNodeId(placed, 'n-pump');
    setAssetReference(placed, QUAL('prj_b'));
    top.add(placed);
    const resolve = async (r: AssetReference) => {
      const bytes = r.sourceId === 'prj_b' ? bBytes : cBytes;
      return { bytes, url: `mem:${r.sourceId}/${r.assetId}`, sha256: '', signatureState: 'none' as const };
    };
    await expect(compose(top, { baseUrl: 'mem:root', resolve: resolve as never })).resolves.toBeDefined();
    // The same reference without qualifiers WOULD be a cycle — the key really is (library, id).
    const topLegacy = new Group();
    const placedLegacy = new Object3D();
    setNodeId(placedLegacy, 'n-pump2');
    setAssetReference(placedLegacy, { assetId: PUMP });
    topLegacy.add(placedLegacy);
    const innerLegacy = new Group();
    const refLegacy = new Object3D();
    setNodeId(refLegacy, 'n-motor2');
    setAssetReference(refLegacy, { assetId: PUMP });
    innerLegacy.add(refLegacy);
    const legacyBytes = await objectToGlb(innerLegacy);
    await expect(compose(topLegacy, {
      baseUrl: 'mem:root',
      resolve: (async () => ({ bytes: legacyBytes, url: 'mem:x', sha256: '', signatureState: 'none' as const })) as never,
    })).rejects.toBeInstanceOf(ReferenceCycleError);
  });
});

describe('plan-778 9.5 — writing and reading the qualifier', () => {
  const qualified: PlacedComponent = {
    id: 'plc_1', catalogId: PUMP, glbUrl: '', label: 'Pump',
    providerId: LIBRARY_PROJECTS_PROVIDER_ID, sourceId: 'prj_b',
    position: [1, 0, 2], rotation: [0, 90, 0], scale: [1, 1, 1],
  };

  it('the bake writes the qualifier WITHOUT a path; the reload reads it back (save → reload round trip)', () => {
    const extras = placementExtras({ ...qualified, glbUrl: 'https://stale/should-not-be-written.glb' });
    expect(extras.AssetReference).toEqual({ assetId: PUMP, providerId: LIBRARY_PROJECTS_PROVIDER_ID, sourceId: 'prj_b' });
    const root = new Group();
    const node = new Object3D();
    node.name = 'Pump';
    node.userData.realvirtual = extras;
    root.add(node);
    const [back] = readPlacementsFromScene(root);
    expect([back.catalogId, back.glbUrl, back.providerId, back.sourceId]).toEqual([PUMP, '', LIBRARY_PROJECTS_PROVIDER_ID, 'prj_b']);
  });

  it('a legacy placement keeps its form (never upgraded on save)', () => {
    const legacy: PlacedComponent = { ...qualified, providerId: undefined, sourceId: undefined, catalogId: 'pallethandling-x', glbUrl: '/library/x.glb' };
    delete legacy.providerId; delete legacy.sourceId;
    expect(placementExtras(legacy).AssetReference).toEqual({ assetId: 'pallethandling-x', path: '/library/x.glb' });
    const global = { ...legacy, providerId: 'global', sourceId: 'library/catalog.json' };
    expect(placementExtras(global).AssetReference).toEqual({
      assetId: 'pallethandling-x', providerId: 'global', sourceId: 'library/catalog.json', path: '/library/x.glb',
    });
  });

  it('a splat placement carries its qualifier in PlacementMeta', () => {
    const splat: PlacedComponent = { ...qualified, splatUrl: 'https://cdn/x.splat' };
    const extras = placementExtras(splat);
    expect(extras.AssetReference).toBeUndefined();
    expect(extras.PlacementMeta).toMatchObject({ catalogId: PUMP, providerId: LIBRARY_PROJECTS_PROVIDER_ID, sourceId: 'prj_b' });
    const root = new Group();
    const node = new Object3D();
    node.userData.realvirtual = extras;
    root.add(node);
    const [back] = readPlacementsFromScene(root);
    expect([back.providerId, back.sourceId]).toEqual([LIBRARY_PROJECTS_PROVIDER_ID, 'prj_b']);
  });

  it('the layout JSON round trip keeps the qualifier', () => {
    const json = JSON.stringify(serializeLayout('L', [qualified], [], 100));
    expect(deserializeLayout(json).components[0]).toMatchObject({ providerId: LIBRARY_PROJECTS_PROVIDER_ID, sourceId: 'prj_b', glbUrl: '' });
  });

  it('referenced-asset-open of a qualified ref plans B\'s row through the library source, never A\'s same-id row', async () => {
    const w = await world();
    const projectWithSameId = { ...projectA([]), documents: [{ id: PUMP, path: 'local/pump.glb', name: 'local' }] } as unknown as RvProject;
    const plan = planReferencedAssetOpen(QUAL('prj_b'), projectWithSameId, null);
    // Phase 5: a qualified ref plans a `libraryDocument` open (`via:'library'`),
    // still B's row through B's library source — the bytes below prove it.
    expect(plan).toEqual({ via: 'library', libraryProjectId: 'prj_b', documentId: PUMP });
    const resolved = await resolveAsset(LIBRARY_PROJECTS_PROVIDER_ID, 'prj_b', PUMP, 'edit');
    expect(markerOfBytes(await (await fetch(resolved.url)).arrayBuffer())).toBe('b:pump');
    resolved.revokeUrl?.();
    void w;
  });

  it('resolvePlaceEntry with libraryProjectId picks that library; a transitive (hidden) one is not placeable', async () => {
    await world();
    const planner = { store: { getSnapshot: () => ({ catalogs: new Map() }) } } as unknown as LayoutPlannerPlugin;
    const fromC = resolvePlaceEntry(planner, PUMP, 'prj_c')!;
    expect(entryOriginOf(fromC)).toEqual({ assetId: PUMP, providerId: LIBRARY_PROJECTS_PROVIDER_ID, sourceId: 'prj_c' });
    const fromB = resolvePlaceEntry(planner, PUMP, 'prj_b')!;
    expect(entryOriginOf(fromB).sourceId).toBe('prj_b');
    expect(resolvePlaceEntry(planner, PUMP, 'prj_unknown')).toBeUndefined();
  });
});

describe('plan-778 9.5 — planner creation sites write the qualifier', () => {
  it('placeComponent (live drop / layout.place / MCP place) records providerId + sourceId and no url; duplicate keeps it', async () => {
    const w = await world();
    localStorage.clear();
    const h = setupPlanner();
    const { loader } = markerLoader();
    h.plugin.placements.setModelCache(new ModelCache(loader, { uber: () => uber, pickPort: () => createPickBuildPort({ createWorker: () => null }) }));
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
    h.plugin.onModelLoaded(result, h.viewer as never);
    await h.plugin.whenPlacementsMaterialized();

    const entry = getLibrarySource(LIBRARY_PROJECTS_PROVIDER_ID, 'prj_c')!.getEntry(PUMP)!;
    const id = await h.plugin.placeComponent(entry, [3, 0, 0]);
    const rec = h.plugin.store.getSnapshot().placed.find((p) => p.id === id)!;
    expect([rec.catalogId, rec.glbUrl, rec.providerId, rec.sourceId]).toEqual([PUMP, '', LIBRARY_PROJECTS_PROVIDER_ID, 'prj_c']);
    const root = internals(h.plugin)._objectMap.get(id)!;
    expect(registry.instanceOf(root)?.baked.template.name).toBe('c:pump');
    expect(placementExtras(rec).AssetReference).toMatchObject({ providerId: LIBRARY_PROJECTS_PROVIDER_ID, sourceId: 'prj_c' });
    expect(getAssetReference(root)).toBeNull();   // the live root is not a file node yet; the bake writes it from the record

    // Duplicate (Ctrl+D / paste): the copy keeps the original's reference form.
    const copyId = await internals(h.plugin)._clonePlacement(rec);
    const copy = h.plugin.store.getSnapshot().placed.find((p) => p.id === copyId)!;
    expect([copy.providerId, copy.sourceId, copy.glbUrl]).toEqual([LIBRARY_PROJECTS_PROVIDER_ID, 'prj_c', '']);
    expect(registry.instanceOf(internals(h.plugin)._objectMap.get(copyId!)!)?.baked.template.name).toBe('c:pump');
    void w;
  });
});

describe('plan-778 Decision D — placements made LIVE in this session', () => {
  /** A planner over a loaded (empty) layout document, wired to the world's registry. */
  async function livePlanner(): Promise<{ h: ReturnType<typeof setupPlanner>; registry: BakeRegistry }> {
    localStorage.clear();
    const h = setupPlanner();
    const { loader } = markerLoader();
    h.plugin.placements.setModelCache(new ModelCache(loader, { uber: () => uber, pickPort: () => createPickBuildPort({ createWorker: () => null }) }));
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
    h.plugin.onModelLoaded(result, h.viewer as never);
    await h.plugin.whenPlacementsMaterialized();
    return { h, registry };
  }

  const settle = async (w: World, h: ReturnType<typeof setupPlanner>): Promise<void> => {
    await w.loader.whenSettled();
    await new Promise((r) => setTimeout(r, 0));
    await h.plugin.whenPlacementsMaterialized();
  };

  it('drop (placeComponent) and MCP layout.place: detach -> placeholder, re-attach -> restored in place, no reload', async () => {
    const w = await world();
    const { h, registry } = await livePlanner();
    const objects = internals(h.plugin)._objectMap;

    // A drop commits through placeComponent …
    const entry = getLibrarySource(LIBRARY_PROJECTS_PROVIDER_ID, 'prj_c')!.getEntry(PUMP)!;
    const dropId = await h.plugin.placeComponent(entry, [3, 0, 0]);
    // … and MCP `web_execute("layout.place", {catalogId, libraryProjectId})` through the registry command.
    (h.viewer.getPlugin as unknown as { mockImplementation(fn: (id?: string) => unknown): void })
      .mockImplementation((id?: string) => (id === 'layout-planner' ? h.plugin : undefined));
    const reg = new CommandRegistry();
    ensurePlannerCommandsRegistered(reg);
    const placed = await reg.execute<Record<string, unknown>>('layout.place',
      { catalogId: PUMP, libraryProjectId: 'prj_c', x: 6, y: 0, z: 0 }, { origin: 'mcp', viewer: h.viewer as never });
    expect(placed.ok, JSON.stringify(placed)).toBe(true);
    const mcpId = h.plugin.store.getSnapshot().placed.map((p) => p.id).find((id) => id !== dropId)!;
    expect(mcpId).toBeTruthy();

    const roots = [objects.get(dropId)!, objects.get(mcpId)!];
    for (const root of roots) expect(registry.instanceOf(root)?.baked.template.name).toBe('c:pump');
    const parents = roots.map((r) => r.parent);

    // Detach C (library.detach = the loader following the project) — no reload.
    w.loader.setProject(projectA([{ projectId: 'prj_b' }]));
    await settle(w, h);

    for (const [i, root] of roots.entries()) {
      expect(registry.instanceOf(root), `instance ${i} released`).toBeNull();
      const ph = root.children.filter(isMissingReferencePlaceholder);
      expect(ph, `placeholder ${i}`).toHaveLength(1);
      expect(ph[0].name).toBe('Missing: models/pump from library prj_c');
      expect(root.children).toHaveLength(1);                         // no leftover content
      expect(root.parent, `node ${i} stays where it was`).toBe(parents[i]);
    }
    // The records are untouched: still qualified, still two placements.
    expect(h.plugin.store.getSnapshot().placed.map((p) => [p.providerId, p.sourceId]))
      .toEqual([[LIBRARY_PROJECTS_PROVIDER_ID, 'prj_c'], [LIBRARY_PROJECTS_PROVIDER_ID, 'prj_c']]);
    expect(objects.get(dropId)).toBe(roots[0]);
    expect(objects.get(mcpId)).toBe(roots[1]);

    // Re-attach: the SAME nodes get their content back.
    w.loader.setProject(projectA([{ projectId: 'prj_b' }, { projectId: 'prj_c' }]));
    await settle(w, h);
    for (const [i, root] of roots.entries()) {
      expect(root.children.some(isMissingReferencePlaceholder), `placeholder ${i} gone`).toBe(false);
      expect(registry.instanceOf(root)?.baked.template.name, `content ${i} back`).toBe('c:pump');
    }
    expect(objects.get(dropId)).toBe(roots[0]);
    expect(objects.get(mcpId)).toBe(roots[1]);
    expect(h.plugin.placements.unresolvedCount).toBe(0);

    // And it keeps working: a second detach unseats the restored placements again.
    w.loader.setProject(projectA([{ projectId: 'prj_b' }]));
    await settle(w, h);
    for (const root of roots) expect(root.children.filter(isMissingReferencePlaceholder)).toHaveLength(1);
  });

  it('a live placement of a library that stays listed is never touched; a removed placement is not watched any more', async () => {
    const w = await world();
    const { h, registry } = await livePlanner();
    const entry = getLibrarySource(LIBRARY_PROJECTS_PROVIDER_ID, 'prj_c')!.getEntry(PUMP)!;
    const id = await h.plugin.placeComponent(entry, [3, 0, 0]);
    const root = internals(h.plugin)._objectMap.get(id)!;

    // Detaching ANOTHER library: the C placement stands.
    w.loader.setProject(projectA([{ projectId: 'prj_c' }]));
    await settle(w, h);
    expect(registry.instanceOf(root)?.baked.template.name).toBe('c:pump');
    expect(root.children.some(isMissingReferencePlaceholder)).toBe(false);
    expect(h.plugin.placements.isWatchingQualified(id)).toBe(true);

    // Deleting the placement releases it — the watch goes with it.
    await h.plugin.removeByIds([id]);
    expect(h.plugin.placements.isWatchingQualified(id)).toBe(false);
  });
});
