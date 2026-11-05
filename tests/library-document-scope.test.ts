// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-780 9.1 — a document always knows its project, and so does every
 * placement queued from it (contract documents-projects 4, node-identity 1/2/4/8).
 *
 * Phase 1 pins three things:
 *
 *  1. **THE resolver** `resolveDocumentRef(ref, scope)` — hit / pending / missing,
 *     in the order qualified → legacy mapping → library scope (D2) → open
 *     project, and it never reads a source that is still loading.
 *  2. **Scope is data**: every deferred entry captures it at queue time, nested
 *     entries take their parent's resolved library, the re-resolve asks the
 *     entry's scope — so an unqualified part of a library that was still
 *     loading materialises once it settles, and a document switch in between
 *     cannot hand one document's scope to another.
 *  3. **The viewer pairs URL and scope**: set together, rolled back together on
 *     a failed load, reused by `reloadModel`; every load without `library` is
 *     the open project.
 *
 * Runs the REAL `PlacementInstancer` + `ModelCache` + `BakeRegistry` against
 * hand-made library sources whose `loaded` state the test drives, with a GLTF
 * loader that names each bake after the marker in the bytes it decoded — so
 * every assertion knows WHOSE bytes were used.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { Group, Object3D } from 'three';
import type { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import shareBootSource from '../src/core/share/rv-share-boot.ts?raw';
import pluginContextSource from '../src/core/rv-plugin-context.ts?raw';
import mainSource from '../src/main.ts?raw';
import viewerSource from '../src/core/rv-viewer.ts?raw';
import { ModelCache } from '../src/core/engine/rv-model-cache';
import { BakeRegistry } from '../src/core/engine/rv-bake-registry';
import { createPickBuildPort } from '../src/core/engine/rv-pick-build-port';
import { RVUberMaterial } from '../src/core/engine/rv-uber-material';
import {
  PlacementInstancer,
  collectDeferredPlacements,
  scopeOfAssetKey,
} from '../src/core/engine/rv-placement-instancer';
import { placeMissingPlacement, type PlacementHost } from '../src/core/engine/rv-placement-integrate';
import {
  markDeferredPlacement,
  setAssetReference,
  setPlacementMeta,
  type AssetReference,
} from '../src/core/engine/rv-asset-reference';
import { setNodeId } from '../src/core/engine/rv-node-id';
import { isMissingReferencePlaceholder } from '../src/core/engine/rv-missing-reference-placeholder';
import { objectToGlb } from '../src/core/import/rv-import-object';
import {
  registerLibrarySourceProvider,
  resetLibrarySourceRegistryForTests,
  type LibrarySource,
} from '../src/core/library/library-source-registry';
import type { LibraryCatalogEntry } from '../src/core/library/library-types';
import {
  LIBRARY_PROJECTS_PROVIDER_ID,
  OPEN_PROJECT_PROVIDER_ID,
  REALVIRTUAL_LIBRARY_PROJECT_ID,
  resetLegacyPathMigrationsForTests,
  resolveDocumentRef,
  resolveDocumentRefSettled,
  type DocumentScope,
  type RefResolution,
} from '../src/core/library/library-origin';
import { documentIdForWrite } from '../src/core/library/rv-placement-source';
import { getProblems, resetProblemsForTests } from '../src/core/hmi/problems-store';
import { group, uberMesh } from './fixtures/bake-fixture';
import { fakeGlb } from './helpers/fake-document-project';
import { createTestViewer, type TestViewerHandle } from './helpers/create-test-viewer';

const uber = new RVUberMaterial(false);
const PUMP = 'doc_pump';
const LIB_B: DocumentScope = { providerId: LIBRARY_PROJECTS_PROVIDER_ID, sourceId: 'prj_b' };
const LIB_C: DocumentScope = { providerId: LIBRARY_PROJECTS_PROVIDER_ID, sourceId: 'prj_c' };

// ─── Fakes ──────────────────────────────────────────────────────────────

interface FakeDoc { id: string; path: string; marker?: string; aliases?: string[] }

/** A library source whose state the test drives; counts reads made while it was NOT loaded. */
interface FakeSource extends LibrarySource {
  docs: FakeDoc[];
  readsWhileUnloaded: number;
  set(patch: Partial<Pick<LibrarySource, 'loaded' | 'error' | 'needsPermission'>> & { docs?: FakeDoc[] }): void;
}

function fakeSource(id: string, label: string, docs: FakeDoc[], opts: { loaded?: boolean; pathKeys?: boolean } = {}): FakeSource {
  const entryOf = (d: FakeDoc): LibraryCatalogEntry => ({
    id: d.id, name: d.id, category: 'custom', glbUrl: '', localPath: d.path, documentId: d.id,
    ...(d.aliases ? { aliases: d.aliases } : {}),
  } as LibraryCatalogEntry);
  let entries = docs.map(entryOf);
  const src: FakeSource = {
    id, label, kind: 'project', writable: false, loaded: opts.loaded ?? true, error: null,
    docs,
    readsWhileUnloaded: 0,
    listEntries() { if (!src.loaded) src.readsWhileUnloaded++; return entries; },
    getEntry(assetId) {
      if (!src.loaded) src.readsWhileUnloaded++;
      return entries.find((e) => e.id === assetId || (opts.pathKeys === true && `project:${e.localPath}` === assetId)) ?? null;
    },
    getAliasEntry(alias) {
      if (!src.loaded) src.readsWhileUnloaded++;
      return entries.find((e) => (e.aliases ?? []).includes(alias)) ?? null;
    },
    async resolveAsset(assetId) {
      const e = entries.find((x) => x.id === assetId || (x.aliases ?? []).includes(assetId)
        || (opts.pathKeys === true && `project:${x.localPath}` === assetId));
      const doc = e ? src.docs.find((d) => d.id === e.id) : undefined;
      if (!doc) throw new Error(`Asset "${assetId}" is not in "${label}".`);
      const url = URL.createObjectURL(new Blob([fakeGlb(doc.marker ?? `${id}:${doc.id}`) as unknown as BlobPart], { type: 'model/gltf-binary' }));
      return { url, revokeUrl: () => URL.revokeObjectURL(url) };
    },
    set(patch) {
      if (patch.docs) { src.docs = patch.docs; entries = patch.docs.map(entryOf); }
      if (patch.loaded !== undefined) src.loaded = patch.loaded;
      if (patch.error !== undefined) src.error = patch.error;
      if (patch.needsPermission !== undefined) src.needsPermission = patch.needsPermission;
    },
  };
  return src;
}

/** One provider with mutable sources. `notify()` = the registry's change signal. */
function fakeProvider(providerId: string, sources: FakeSource[]): { sources: FakeSource[]; notify(): void } {
  const listeners = new Set<() => void>();
  registerLibrarySourceProvider({
    id: providerId,
    listSources: () => sources,
    subscribe: (l) => { listeners.add(l); return () => { listeners.delete(l); }; },
  });
  return { sources, notify: () => { for (const l of [...listeners]) l(); } };
}

/** The node name a `fakeGlb(marker)` carries. */
function markerOfBytes(bytes: ArrayBuffer): string {
  const view = new DataView(bytes);
  const jsonLen = view.getUint32(12, true);
  return JSON.parse(new TextDecoder().decode(new Uint8Array(bytes, 20, jsonLen)).trim()).nodes[0].name;
}

/** A GLTF loader that builds a bakeable tree named after the marker; a marker `nest:<a>,<b>` adds unqualified reference nodes. */
function markerLoader(): { loader: GLTFLoader; decoded: string[] } {
  const decoded: string[] = [];
  const loader = {
    loadAsync: async (url: string): Promise<{ scene: Group }> => {
      const marker = markerOfBytes(await (await fetch(url)).arrayBuffer());
      decoded.push(marker);
      const [name, nest] = marker.split('|');
      const root = group(name);
      root.add(uberMesh(uber, `${name}-mesh`, [0, 0.5, 0]));
      for (const childId of (nest ?? '').split(',').filter(Boolean)) {
        const n = new Object3D();
        n.name = `ref-${childId}`;
        setNodeId(n, `nid-${childId}`);
        setAssetReference(n, { assetId: childId });
        setPlacementMeta(n, {});
        root.add(n);
      }
      return { scene: root };
    },
  } as unknown as GLTFLoader;
  return { loader, decoded };
}

interface World {
  instancer: PlacementInstancer;
  registry: BakeRegistry;
  decoded: string[];
  missing: Array<{ id: string; reason: string }>;
}

function world(opts: { problems?: boolean } = {}): World {
  const { loader, decoded } = markerLoader();
  const registry = new BakeRegistry();
  const missing: World['missing'] = [];
  const host = { reportProblems: opts.problems === true } as unknown as PlacementHost;
  const instancer = new PlacementInstancer({
    bakeRegistry: () => registry,
    uber: () => uber,
    pickPort: () => createPickBuildPort({ createWorker: () => null }),
    isLive: () => true,
    missingDefault: (entry, err) => {
      missing.push({ id: entry.id, reason: err instanceof Error ? err.message : String(err) });
      placeMissingPlacement(host, entry, err);
    },
  });
  instancer.setModelCache(new ModelCache(loader, { uber: () => uber, pickPort: () => createPickBuildPort({ createWorker: () => null }) }));
  return { instancer, registry, decoded, missing };
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

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** A `library:` option inside a `loadModel(…)` argument list. */
const LIBRARY_OPTION = /\blibrary\s*:/;

/** Every `.loadModel(…)` call in `text`, argument list included (balanced parentheses). */
function loadModelCalls(text: string): string[] {
  const out: string[] = [];
  const re = /\.loadModel\(/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    let depth = 0;
    let i = m.index + '.loadModel'.length;
    for (; i < text.length; i++) {
      if (text[i] === '(') depth++;
      else if (text[i] === ')' && --depth === 0) break;
    }
    out.push(text.slice(m.index, i + 1));
  }
  return out;
}

function verdict(r: RefResolution): string {
  if ('hit' in r) return `hit:${r.hit.registered.providerId}/${r.hit.registered.source.id}:${r.hit.assetId}${r.hit.qualified ? ':strict' : ''}`;
  if ('pending' in r) return `pending:${r.source ? r.source.sourceId : '*'}`;
  return `missing:${r.code}${r.strict ? ':strict' : ''}`;
}

afterEach(() => {
  resetLibrarySourceRegistryForTests();
  resetLegacyPathMigrationsForTests();
  resetProblemsForTests();
  vi.restoreAllMocks();
});

// ─── 1. The resolver ────────────────────────────────────────────────────

describe('plan-780 R1 — resolveDocumentRef(ref, scope)', () => {
  /** Open project A + libraries B, C and the realvirtual library; B and C both hold doc_pump. */
  function registry(opts: { bLoaded?: boolean } = {}) {
    const open = fakeSource('prj_a', 'Plant A', [
      { id: PUMP, path: 'models/pump.glb', marker: 'a:pump' },
      { id: 'doc_a_only', path: 'models/a-only.glb' },
    ], { pathKeys: true });
    const b = fakeSource('prj_b', 'Shared conveyors', [
      { id: PUMP, path: 'models/pump.glb', marker: 'b:pump' },
      { id: 'doc_belt', path: 'library/Belt.glb', aliases: ['old-belt-id'] },
    ], { loaded: opts.bLoaded ?? true });
    const c = fakeSource('prj_c', 'Motors', [{ id: PUMP, path: 'models/pump.glb', marker: 'c:pump' }]);
    const rv = fakeSource(REALVIRTUAL_LIBRARY_PROJECT_ID, 'realvirtual', [
      { id: 'doc_rv_conveyor', path: 'library/Conveyor.glb', aliases: ['realvirtual-conveyor-glb'] },
    ]);
    fakeProvider(OPEN_PROJECT_PROVIDER_ID, [open]);
    const libs = fakeProvider(LIBRARY_PROJECTS_PROVIDER_ID, [b, c, rv]);
    return { open, b, c, rv, libs };
  }

  it('the table: qualified, legacy forms, library scope (D2), open project', () => {
    registry();
    const table: Array<[string, Parameters<typeof resolveDocumentRef>[0], DocumentScope, string]> = [
      ['qualified → its ONE library', { catalogId: PUMP, ...LIB_C }, null, `hit:library-projects/prj_c:${PUMP}:strict`],
      ['qualified, unknown id → missing in that library', { catalogId: 'doc_nope', ...LIB_C }, LIB_B, 'missing:not-in-library:strict'],
      ['legacy project:<path> in library B → B\'s document id', { catalogId: 'project:models/pump.glb' }, LIB_B, `hit:library-projects/prj_b:${PUMP}:strict`],
      ['legacy project:<path>, open project → its document id (R3)', { catalogId: 'project:Models/Pump.glb' }, null, `hit:project/prj_a:${PUMP}`],
      ['global + realvirtual catalog URL → the realvirtual library', { catalogId: 'realvirtual-conveyor-glb', providerId: 'global', sourceId: 'library/catalog.json' }, LIB_B, 'hit:library-projects/prj_realvirtual_library:realvirtual-conveyor-glb'],
      ['old realvirtual id inside library B → the realvirtual library (D2 exception)', { catalogId: 'realvirtual-conveyor-glb' }, LIB_B, 'hit:library-projects/prj_realvirtual_library:doc_rv_conveyor:strict'],
      ['unqualified id inside B → B (not A\'s same id)', { catalogId: PUMP }, LIB_B, `hit:library-projects/prj_b:${PUMP}:strict`],
      ['unqualified alias inside B → B\'s renamed document', { catalogId: 'old-belt-id' }, LIB_B, 'hit:library-projects/prj_b:doc_belt:strict'],
      ['unqualified id B does not hold → missing in B, never A (D2)', { catalogId: 'doc_a_only' }, LIB_B, 'missing:not-in-library:strict'],
      ['unqualified + null scope → the open project', { catalogId: PUMP }, null, `hit:project/prj_a:${PUMP}`],
      ['unknown everywhere, null scope → missing, not strict (url / manifest fallbacks stay)', { catalogId: 'doc_nowhere' }, null, 'missing:not-found'],
    ];
    for (const [label, ref, scope, expected] of table) {
      expect(verdict(resolveDocumentRef(ref, scope)), label).toBe(expected);
    }
  });

  it('missing in B carries the library\'s name — the Problems row\'s text', () => {
    registry();
    const r = resolveDocumentRef({ catalogId: 'doc_a_only' }, LIB_B);
    expect('missing' in r && r.reason).toBe('"doc_a_only" is missing in library "Shared conveyors".');
  });

  it('pending before settle, missing only after: a loading library is never read and never a verdict', async () => {
    const { b, libs } = registry({ bLoaded: false });
    expect(verdict(resolveDocumentRef({ catalogId: 'doc_a_only' }, LIB_B))).toBe('pending:prj_b');
    expect(verdict(resolveDocumentRef({ catalogId: 'project:models/pump.glb' }, LIB_B))).toBe('pending:prj_b');
    expect(verdict(resolveDocumentRef({ catalogId: PUMP, ...LIB_B }, null))).toBe('pending:prj_b');
    // The legacy search skips it too (it would answer "nothing", which is not "not there").
    expect(verdict(resolveDocumentRef({ catalogId: 'doc_belt' }, null))).toBe('pending:*');
    expect(b.readsWhileUnloaded).toBe(0);

    const settled = resolveDocumentRefSettled({ catalogId: 'doc_a_only' }, LIB_B);
    b.set({ loaded: true });
    libs.notify();
    expect(verdict(await settled)).toBe('missing:not-in-library:strict');
    expect(b.readsWhileUnloaded).toBe(0);
  });

  it('a locked / failed library is a settled "unavailable" — missing, strict, naming the library', () => {
    const { b } = registry();
    b.set({ loaded: false, error: 'folder is gone' });
    const r = resolveDocumentRef({ catalogId: PUMP }, LIB_B);
    expect(verdict(r)).toBe('missing:library-unavailable:strict');
  });
});

// ─── 2. R3 — legacy paths: once, never guessed ──────────────────────────

describe('plan-780 R3 — legacy project:<path>, in memory, once', () => {
  it('ambiguous (two rows per normalized path) → kept as written + Problems row, never guessed', async () => {
    const open = fakeSource('prj_a', 'Plant A', [
      { id: 'doc_upper', path: 'Models/Pump.glb' },
      { id: 'doc_lower', path: 'models/pump.glb' },
    ], { pathKeys: true });
    fakeProvider(OPEN_PROJECT_PROVIDER_ID, [open]);
    const r = resolveDocumentRef({ catalogId: 'project:models/pump.glb' }, null);
    expect(verdict(r)).toBe('missing:legacy-path-ambiguous:strict');
    expect(documentIdForWrite('project:models/pump.glb')).toBe('project:models/pump.glb');

    const w = world({ problems: true });
    const root = documentWith([{ id: 'p', ref: { assetId: 'project:models/pump.glb' } }]);
    w.instancer.materializeDeferred(collectDeferredPlacements(root));
    await w.instancer.whenMaterialized();
    expect(w.registry.instanceOf(root.children[0])).toBeNull();
    expect(root.children[0].children.some(isMissingReferencePlaceholder)).toBe(true);
    const problem = getProblems().find((p) => p.code === 'missing-reference');
    expect(problem?.detail).toMatch(/Ambiguous legacy path "project:models\/pump\.glb": 2 documents/);
    // Kept as written: the reference node still names the path.
    expect(w.missing).toHaveLength(1);
  });

  it('renamed before load (the path names nothing) inside a library → kept + Problems row naming the library', async () => {
    const b = fakeSource('prj_b', 'Shared conveyors', [{ id: PUMP, path: 'models/pump-v2.glb', marker: 'b:pump' }]);
    fakeProvider(LIBRARY_PROJECTS_PROVIDER_ID, [b]);
    const w = world({ problems: true });
    const root = documentWith([{ id: 'p', ref: { assetId: 'project:models/pump.glb' } }]);
    w.instancer.materializeDeferred(collectDeferredPlacements(root, LIB_B));
    await w.instancer.whenMaterialized();
    expect(w.registry.instanceOf(root.children[0])).toBeNull();
    const problem = getProblems().find((p) => p.code === 'missing-reference');
    expect(problem?.detail).toContain('Legacy path "project:models/pump.glb" names no document of "Shared conveyors"');
  });

  it('a rename in the same session keeps the placement, and the save writes the document id', async () => {
    const open = fakeSource('prj_a', 'Plant A', [{ id: PUMP, path: 'models/pump.glb', marker: 'a:pump' }], { pathKeys: true });
    const provider = fakeProvider(OPEN_PROJECT_PROVIDER_ID, [open]);
    expect(documentIdForWrite('project:models/pump.glb')).toBe(PUMP);   // first resolve migrates (R3)
    open.set({ docs: [{ id: PUMP, path: 'models/renamed/pump.glb', marker: 'a:pump' }] });
    provider.notify();
    // The old path no longer names a row — the session's migration still answers by id.
    expect(verdict(resolveDocumentRef({ catalogId: 'project:models/pump.glb' }, null))).toBe(`hit:project/prj_a:${PUMP}`);
    expect(documentIdForWrite('project:models/pump.glb')).toBe(PUMP);

    const w = world();
    const root = documentWith([{ id: 'p', ref: { assetId: 'project:models/pump.glb' } }]);
    w.instancer.materializeDeferred(collectDeferredPlacements(root));
    await w.instancer.whenMaterialized();
    expect(bakedName(w, root.children[0])).toBe('a:pump');
  });

  it('invalidateDocument keys by document id — a project:<path> placement and an id placement are ONE bake', async () => {
    const open = fakeSource('prj_a', 'Plant A', [{ id: PUMP, path: 'models/pump.glb', marker: 'a:pump' }], { pathKeys: true });
    fakeProvider(OPEN_PROJECT_PROVIDER_ID, [open]);
    const w = world();
    const root = documentWith([
      { id: 'byPath', ref: { assetId: 'project:models/pump.glb' } },
      { id: 'byId', ref: { assetId: PUMP } },
    ]);
    w.instancer.materializeDeferred(collectDeferredPlacements(root));
    await w.instancer.whenMaterialized();
    expect(w.decoded).toEqual(['a:pump']);   // one decode: the legacy path is keyed by the id it migrated to
    expect(w.instancer.keyOf({ catalogId: 'project:models/pump.glb' }, null)).toBe(w.instancer.keyOf({ catalogId: PUMP }, null));
    const keys = w.instancer.invalidateDocument({ documentId: PUMP });
    expect(keys).toContain(w.instancer.keyOf({ catalogId: PUMP }, null));
    expect(keys.some((k) => k.endsWith(':project:models/pump.glb'))).toBe(false);   // no path key is built
  });
});

// ─── 3. The instancer: scope is data ────────────────────────────────────

describe('plan-780 R2 — every placement carries its scope', () => {
  it('an unqualified part of a PENDING library waits, then materialises from it — never missing, never the open project', async () => {
    const open = fakeSource('prj_a', 'Plant A', [{ id: PUMP, path: 'models/pump.glb', marker: 'a:pump' }]);
    const b = fakeSource('prj_b', 'Shared conveyors', [{ id: PUMP, path: 'models/pump.glb', marker: 'b:pump' }], { loaded: false });
    fakeProvider(OPEN_PROJECT_PROVIDER_ID, [open]);
    const libs = fakeProvider(LIBRARY_PROJECTS_PROVIDER_ID, [b]);
    const w = world();
    const root = documentWith([{ id: 'part', ref: { assetId: PUMP } }]);
    w.instancer.materializeDeferred(collectDeferredPlacements(root, LIB_B));
    await tick();
    expect(w.instancer.state).toBe('materializing');
    expect(b.readsWhileUnloaded).toBe(0);
    b.set({ loaded: true });
    libs.notify();
    await w.instancer.whenMaterialized();
    expect(bakedName(w, root.children[0])).toBe('b:pump');
    expect(w.missing).toEqual([]);
    expect(w.decoded).toEqual(['b:pump']);
  });

  it('re-resolve is scope-aware: a part that fell into its placeholder (library unavailable) comes back when THAT library is ready', async () => {
    const open = fakeSource('prj_a', 'Plant A', [{ id: PUMP, path: 'models/pump.glb', marker: 'a:pump' }]);
    const b = fakeSource('prj_b', 'Shared conveyors', [{ id: PUMP, path: 'models/pump.glb', marker: 'b:pump' }], { loaded: false });
    b.set({ needsPermission: true });   // a permission prompt: settled, not pending
    fakeProvider(OPEN_PROJECT_PROVIDER_ID, [open]);
    const libs = fakeProvider(LIBRARY_PROJECTS_PROVIDER_ID, [b]);
    const w = world();
    const root = documentWith([{ id: 'part', ref: { assetId: PUMP } }]);
    w.instancer.materializeDeferred(collectDeferredPlacements(root, LIB_B));
    await w.instancer.whenMaterialized();
    expect(w.missing.map((m) => m.reason)).toEqual(['Library "prj_b" is not available — "doc_pump" cannot be placed.']);
    expect(w.instancer.unresolvedCount).toBe(1);
    expect(w.registry.instanceOf(root.children[0])).toBeNull();

    // Grant: the library turns ready — the remembered entry asks ITS scope again.
    b.set({ loaded: true, needsPermission: false });
    libs.notify();
    await tick();
    await w.instancer.whenMaterialized();
    expect(bakedName(w, root.children[0])).toBe('b:pump');
    expect(root.children[0].children.some(isMissingReferencePlaceholder)).toBe(false);
    expect(w.instancer.unresolvedCount).toBe(0);
  });

  it('a legacy-resolved library parent\'s nested parts resolve in the library, not in the open project', async () => {
    // B's assembly holds an unqualified reference to its own doc_pump; A has a doc_pump too.
    const open = fakeSource('prj_a', 'Plant A', [{ id: PUMP, path: 'models/pump.glb', marker: 'a:pump' }]);
    const b = fakeSource('prj_b', 'Shared conveyors', [
      { id: 'doc_cell', path: 'models/cell.glb', marker: `b:cell|${PUMP}` },
      { id: PUMP, path: 'models/pump.glb', marker: 'b:pump' },
    ]);
    fakeProvider(OPEN_PROJECT_PROVIDER_ID, [open]);
    fakeProvider(LIBRARY_PROJECTS_PROVIDER_ID, [b]);
    const w = world();
    // The library document's own legacy reference to its cell (Edit in library of B).
    const root = documentWith([{ id: 'cell', ref: { assetId: 'project:models/cell.glb' } }]);
    w.instancer.materializeDeferred(collectDeferredPlacements(root, LIB_B));
    await w.instancer.whenMaterialized();
    const cell = root.children[0];
    expect(bakedName(w, cell)).toBe('b:cell');
    const nested = cell.getObjectByName(`ref-${PUMP}`)!;
    expect(bakedName(w, nested)).toBe('b:pump');
    expect(w.decoded.map((m) => m.split('|')[0]).sort()).toEqual(['b:cell', 'b:pump']);   // never A's pump
    expect(scopeOfAssetKey(w.registry.instanceOf(cell)!.baked.assetId)).toEqual(LIB_B);
  });

  it('an old realvirtual catalog id inside a library document resolves in the realvirtual library', async () => {
    const b = fakeSource('prj_b', 'Shared conveyors', [{ id: PUMP, path: 'models/pump.glb' }]);
    const rv = fakeSource(REALVIRTUAL_LIBRARY_PROJECT_ID, 'realvirtual', [
      { id: 'doc_rv_conveyor', path: 'library/Conveyor.glb', marker: 'rv:conveyor', aliases: ['realvirtual-conveyor-glb'] },
    ]);
    fakeProvider(LIBRARY_PROJECTS_PROVIDER_ID, [b, rv]);
    const w = world();
    const root = documentWith([{ id: 'conv', ref: { assetId: 'realvirtual-conveyor-glb' } }]);
    w.instancer.materializeDeferred(collectDeferredPlacements(root, LIB_B));
    await w.instancer.whenMaterialized();
    expect(bakedName(w, root.children[0])).toBe('rv:conveyor');
  });

  it('generation race: a late library settle after a document switch writes nothing; the new document uses ITS scope', async () => {
    const b = fakeSource('prj_b', 'B', [{ id: PUMP, path: 'models/pump.glb', marker: 'b:pump' }], { loaded: false });
    const c = fakeSource('prj_c', 'C', [{ id: PUMP, path: 'models/pump.glb', marker: 'c:pump' }]);
    const libs = fakeProvider(LIBRARY_PROJECTS_PROVIDER_ID, [b, c]);
    const w = world();
    const doc1 = documentWith([{ id: 'part1', ref: { assetId: PUMP } }]);
    w.instancer.materializeDeferred(collectDeferredPlacements(doc1, LIB_B));
    await tick();
    w.instancer.clearDocument();                        // the user opens another library's document
    const doc2 = documentWith([{ id: 'part2', ref: { assetId: PUMP } }]);
    w.instancer.materializeDeferred(collectDeferredPlacements(doc2, LIB_C));
    await w.instancer.whenMaterialized();
    expect(bakedName(w, doc2.children[0])).toBe('c:pump');
    b.set({ loaded: true });                             // the first document's library settles late
    libs.notify();
    await tick();
    await tick();
    expect(w.registry.instanceOf(doc1.children[0])).toBeNull();
    expect(w.decoded).toEqual(['c:pump']);
    expect(w.missing).toEqual([]);
  });

  it('two libraries with the same document id: the entries\' scopes keep them apart (one bake each)', async () => {
    const b = fakeSource('prj_b', 'B', [{ id: PUMP, path: 'models/pump.glb', marker: 'b:pump' }]);
    const c = fakeSource('prj_c', 'C', [{ id: PUMP, path: 'models/pump.glb', marker: 'c:pump' }]);
    fakeProvider(LIBRARY_PROJECTS_PROVIDER_ID, [b, c]);
    const w = world();
    const inB = documentWith([{ id: 'pb', ref: { assetId: PUMP } }]);
    const inC = documentWith([{ id: 'pc', ref: { assetId: PUMP } }]);
    w.instancer.materializeDeferred([...collectDeferredPlacements(inB, LIB_B), ...collectDeferredPlacements(inC, LIB_C)]);
    await w.instancer.whenMaterialized();
    expect(bakedName(w, inB.children[0])).toBe('b:pump');
    expect(bakedName(w, inC.children[0])).toBe('c:pump');
  });
});

// ─── 4. The viewer pairs URL and scope ──────────────────────────────────

describe('plan-780 R2 — RVViewer.currentModelScope', () => {
  let h: TestViewerHandle | null = null;
  afterEach(() => { h?.dispose(); h = null; });

  async function docBytes(refs: Array<{ id: string; assetId: string }>): Promise<ArrayBuffer> {
    const root = new Group();
    root.name = 'LibraryDoc';
    for (const r of refs) {
      const n = new Object3D();
      n.name = r.id;
      setNodeId(n, `nid-${r.id}`);
      setAssetReference(n, { assetId: r.assetId });
      setPlacementMeta(n, {});
      n.position.set(2, 0, 0);
      root.add(n);
    }
    return objectToGlb(root);
  }

  async function boot(): Promise<{ h: TestViewerHandle; decoded: string[] }> {
    const open = fakeSource('prj_a', 'Plant A', [{ id: PUMP, path: 'models/pump.glb', marker: 'a:pump' }]);
    const b = fakeSource('prj_b', 'Shared conveyors', [{ id: PUMP, path: 'models/pump.glb', marker: 'b:pump' }]);
    fakeProvider(OPEN_PROJECT_PROVIDER_ID, [open]);
    fakeProvider(LIBRARY_PROJECTS_PROVIDER_ID, [b]);
    const handle = await createTestViewer('webgl');
    const { loader, decoded } = markerLoader();
    handle.viewer.placements.setModelCache(new ModelCache(loader, {
      uber: () => handle.viewer.placementUberMaterial,
      isWebGPU: () => handle.viewer.isWebGPU,
      pickPort: () => createPickBuildPort({ createWorker: () => null }),
    }));
    handle.viewer.setSimulationPaused('library-document-scope', true);
    return { h: handle, decoded };
  }

  it('loadModel({ library }) places the document\'s parts from that library; reloadModel keeps the scope', async () => {
    const booted = await boot();
    h = booted.h;
    const v = h.viewer;
    const url = URL.createObjectURL(new Blob([await docBytes([{ id: 'Part', assetId: PUMP }])], { type: 'model/gltf-binary' }));
    try {
      await v.loadModel(url, { library: { ...LIB_B! } });
      await v.placements.whenMaterialized();
      expect(v.currentModelUrl).toBe(url);
      expect(v.currentModelScope).toEqual(LIB_B);
      expect(booted.decoded).toEqual(['b:pump']);

      const spy = vi.spyOn(v, 'loadModel');
      await v.reloadModel();
      await v.placements.whenMaterialized();
      expect(spy).toHaveBeenCalledWith(url, { library: LIB_B });
      expect(v.currentModelScope).toEqual(LIB_B);
      expect(booted.decoded.every((m) => m === 'b:pump')).toBe(true);
    } finally {
      URL.revokeObjectURL(url);
    }
  });

  it('a load without `library` is the open project (null scope), and a FAILED load rolls URL and scope back together', async () => {
    const booted = await boot();
    h = booted.h;
    const v = h.viewer;
    const bytes = await docBytes([{ id: 'Part', assetId: PUMP }]);
    await v.loadModel('lib-doc.glb', { data: bytes.slice(0), library: { ...LIB_B! } });
    expect(v.currentModelScope).toEqual(LIB_B);

    // A failed load commits nothing: the previous URL and scope come back, as a pair.
    await expect(v.loadModel('broken.glb', { data: new Uint8Array([1, 2, 3, 4]).buffer })).rejects.toBeTruthy();
    expect(v.currentModelUrl).toBe('lib-doc.glb');
    expect(v.currentModelScope).toEqual(LIB_B);

    // Any load without `library` (empty GLB, scene path, share boot, plugins) is the open project.
    await v.loadModel('plant.glb', { data: bytes.slice(0) });
    await v.placements.whenMaterialized();
    expect(v.currentModelScope).toBeNull();
    expect(booted.decoded).toContain('a:pump');
  });

  it('guard: the scope-null loaders never pass `library` (share boot, plugin context, main boot, scene path)', () => {
    // Re-check #4: the loads that MUST stay null-scoped name no `library` option.
    const sources: Array<[string, string]> = [
      ['src/core/share/rv-share-boot.ts', shareBootSource],
      ['src/core/rv-plugin-context.ts', pluginContextSource],
      ['src/main.ts', mainSource],
    ];
    let seen = 0;
    for (const [file, text] of sources) {
      for (const call of loadModelCalls(text)) {
        seen++;
        expect(call, `${file}: ${call.slice(0, 120)}`).not.toMatch(LIBRARY_OPTION);
      }
    }
    expect(seen).toBeGreaterThan(0);
    // The viewer's own scene path loads without `library` → null scope.
    const marker = viewerSource.indexOf('Phase 4 — planner placements');
    const scenePath = viewerSource.slice(Math.max(0, marker - 1500), marker);
    const sceneCalls = loadModelCalls(scenePath);
    expect(sceneCalls.length).toBeGreaterThan(0);
    for (const call of sceneCalls) expect(call).not.toMatch(LIBRARY_OPTION);
  });
});
