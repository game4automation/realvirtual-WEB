// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-723 §9.5 — placing a library-REGISTRY entry.
 *
 * A project document arrives with `glbUrl: ''`, and before this plan every
 * placement path treated that as "unplaceable": the pending load failed fast
 * with "Catalog entry has no glbUrl", `placeAtSnap` returned `null` without a
 * word, and a duplicate reached for a `blob:` URL the cache had already
 * revoked. This file drives the real plugin through those paths with a real
 * `ModelCache` (harness precedent) and a fake project provider in the registry.
 *
 * What the assertions watch is mostly the RESOLVE COUNT: the placement working
 * is necessary but not sufficient — it has to work off ONE backend read per
 * asset per session, or the stable-key design is decorative.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Group, Mesh, BoxGeometry, MeshBasicMaterial, type Object3D } from 'three';

import {
  setupPlanner,
  internals,
  flush,
  type PlannerHarness,
} from './_layout-planner-async-harness';
import { ModelCache, resolvedCacheKey } from '../src/plugins/layout-planner/model-cache';
import {
  registerLibrarySourceProvider,
  resetLibrarySourceRegistryForTests,
  type LibrarySource,
} from '../src/core/library/library-source-registry';
import type {
  LibraryCatalogEntry,
  PlacedComponent,
} from '../src/plugins/layout-planner/rv-layout-store';

const PROJECT_SOURCE_ID = 'proj-1';
const BELT_ID = 'project:library/Belt.glb';
const GLTF_ID = 'project:library/Legacy.gltf';
const RESOLVED_URL = 'blob:rv-test/project-belt';

const BELT_ENTRY: LibraryCatalogEntry = {
  id: BELT_ID,
  name: 'Belt',
  category: 'custom',
  glbUrl: '',
  localPath: 'library/Belt.glb',
  footprintMm: [1200, 400],
};

const GLTF_ENTRY: LibraryCatalogEntry = {
  id: GLTF_ID,
  name: 'Legacy',
  category: 'custom',
  glbUrl: '',
  localPath: 'library/Legacy.gltf',
};

// ─── A project provider whose resolves and revokes are counted ──────────

interface FakeProject {
  resolves: string[];
  revokes: number;
  /** Make `resolveAsset` reject for this id. */
  failResolveFor: Set<string>;
}

function installFakeProject(): FakeProject {
  const state: FakeProject = { resolves: [], revokes: 0, failResolveFor: new Set() };
  const entries = [BELT_ENTRY, GLTF_ENTRY];
  const source: LibrarySource = {
    id: PROJECT_SOURCE_ID,
    label: 'MeinProjekt',
    kind: 'project',
    writable: true,
    loaded: true,
    listEntries: () => entries,
    getEntry: (assetId) => entries.find(e => e.id === assetId) ?? null,
    resolveAsset: async (assetId) => {
      state.resolves.push(assetId);
      if (state.failResolveFor.has(assetId)) throw new Error('backend refused ' + assetId);
      // A REAL provider mints a new handle per call; that is the whole reason
      // the cache may not key on it. The string is stable here only so the
      // fake loader can recognise it.
      return { url: assetId === GLTF_ID ? 'blob:rv-test/legacy-gltf' : RESOLVED_URL,
               revokeUrl: () => { state.revokes++; } };
    },
  };
  registerLibrarySourceProvider({
    id: 'project',
    listSources: () => [source],
    subscribe: () => () => {},
  });
  return state;
}

// ─── A loader that answers the resolved blob url ────────────────────────

function makeProjectLoader() {
  const decodes: string[] = [];
  const loadAsync = vi.fn(async (url: string) => {
    decodes.push(url);
    if (url.endsWith('legacy-gltf')) {
      // What a `.gltf` really does against an opaque blob url: its external
      // buffer/image URIs cannot be resolved, and the parse blows up.
      throw new Error('Could not load buffer.bin: relative URI against a blob url');
    }
    const group = new Group();
    group.name = 'ProjectBeltRoot';
    group.add(new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial()));
    return { scene: group };
  });
  return { loader: { loadAsync }, loadAsync, decodes };
}

/** Swap the harness's URL-oriented cache for one that answers the blob url. */
function withProjectCache(h: PlannerHarness) {
  const ctl = makeProjectLoader();
  const cache = new ModelCache(ctl.loader as never);
  (h.plugin as unknown as { _modelCache: ModelCache })._modelCache = cache;
  return { ...ctl, cache };
}

type SavedHandler = (e: { relPath?: string }) => void;

/**
 * The `document-saved` handler the plugin registered on the mock viewer.
 *
 * The harness's `viewer.on` is a bare `vi.fn(() => vi.fn())`, so its recorded
 * calls are untyped — hence the cast, which is narrower than mocking the whole
 * event bus just to fire one event.
 */
function documentSavedHandler(h: PlannerHarness): SavedHandler {
  const calls = h.viewer.on.mock.calls as unknown as [string, SavedHandler][];
  const call = calls.find(c => c[0] === 'document-saved');
  if (!call) throw new Error('planner never subscribed to document-saved');
  return call[1];
}

// ─── Tests ──────────────────────────────────────────────────────────────

describe('plan-723 §9.5 — registry entry placement', () => {
  beforeEach(() => { resetLibrarySourceRegistryForTests(); localStorage.clear(); });
  afterEach(() => resetLibrarySourceRegistryForTests());

  it('_runPendingLoad places a glbUrl-less project entry via resolveAsset (placeholder swaps to geometry)', async () => {
    const project = installFakeProject();
    const h = setupPlanner();
    const loader = withProjectCache(h);
    const p = internals(h.plugin);

    await p._startDraft(BELT_ENTRY);
    const id = p._draft!.id;
    // The placeholder is registered synchronously — that part is unchanged.
    expect(p._objectMap.get(id)).toBeDefined();

    await flush(12);

    // Resolved exactly once, decoded exactly once, and the placeholder was
    // swapped for real geometry rather than painted as failed.
    expect(project.resolves).toEqual([BELT_ID]);
    expect(loader.decodes).toEqual([RESOLVED_URL]);
    expect(project.revokes).toBe(1);
    expect(p._pending.statusOf(id)).toBeUndefined();   // swapped, not failed

    let hasMesh = false;
    p._objectMap.get(id)!.traverse((n: Object3D) => { if ((n as Mesh).isMesh) hasMesh = true; });
    expect(hasMesh).toBe(true);
  });

  it('a second placement of the same project entry reuses the cache (ONE backend read)', async () => {
    const project = installFakeProject();
    const h = setupPlanner();
    const loader = withProjectCache(h);
    const p = internals(h.plugin);

    await p._startDraft(BELT_ENTRY);
    await flush(12);
    p._cancelDraft();
    await h.plugin.placeComponent(BELT_ENTRY, [1, 0, 1]);
    await flush(12);

    expect(project.resolves).toEqual([BELT_ID]);   // NOT twice
    expect(loader.decodes).toEqual([RESOLVED_URL]);
  });

  it('placeComponent places a project entry and records catalogId as its identity', async () => {
    installFakeProject();
    const h = setupPlanner();
    withProjectCache(h);

    const id = await h.plugin.placeComponent(BELT_ENTRY, [2, 0, 3]);
    const comp = h.store.placed.find(c => c.id === id)!;

    expect(comp.catalogId).toBe(BELT_ID);
    // Never the volatile handle: the cache revokes it, and a persisted dead
    // blob url is exactly what F5 exists to avoid.
    expect(comp.glbUrl).toBe('');
  });

  it('placeAtSnap places a project entry instead of silently returning null', async () => {
    const project = installFakeProject();
    const h = setupPlanner();
    const loader = withProjectCache(h);
    // A snap registry is all `placeAtSnapPoint` needs before it looks for the
    // asset's own snap node; the fake geometry has none, so the call still ends
    // in `null` — but only AFTER the asset was resolved and decoded. That is
    // the whole regression: the old `if (!entry.glbUrl) return null` guard
    // short-circuited two steps earlier and the backend was never asked.
    h.viewer.getPlugin.mockImplementation((id?: string) =>
      (id === 'snap-point' ? { getRegistry: () => ({}) } : undefined) as never);

    const target = { occupied: false } as never;
    await h.plugin.placeAtSnap(BELT_ENTRY, target, 'SNAP_OUT');

    expect(project.resolves).toEqual([BELT_ID]);
    expect(loader.decodes).toEqual([RESOLVED_URL]);

    // An entry that is in NO registry source still short-circuits — the guard
    // was narrowed, not removed.
    const orphan: LibraryCatalogEntry = { id: 'project:library/Nope.glb', name: 'Nope', category: 'custom', glbUrl: '' };
    await expect(h.plugin.placeAtSnap(orphan, target, 'SNAP_OUT')).resolves.toBeNull();
    expect(project.resolves).toEqual([BELT_ID]);
  });

  it('copySelected duplicates a project placement via the stable cache key (no dead blob url access)', async () => {
    const project = installFakeProject();
    const h = setupPlanner();
    const loader = withProjectCache(h);
    const p = internals(h.plugin);

    const id = await h.plugin.placeComponent(BELT_ENTRY, [0, 0, 0]);
    await flush(12);
    const original = h.store.placed.find(c => c.id === id)!;

    const copyId = await p._clonePlacement(original);
    await flush(12);

    expect(copyId).not.toBeNull();
    expect(copyId).not.toBe(id);
    // The copy came out of the cache: no second resolve, no second decode, and
    // above all no reach for the revoked handle sitting in `comp.glbUrl`.
    expect(project.resolves).toEqual([BELT_ID]);
    expect(loader.decodes).toEqual([RESOLVED_URL]);
    expect(h.store.placed.find(c => c.id === copyId)!.label).toBe('Belt (copy)');
  });

  it('copySelected skips a project placement whose document left the project', async () => {
    installFakeProject();
    const h = setupPlanner();
    withProjectCache(h);
    const p = internals(h.plugin);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const orphan: PlacedComponent = {
      id: 'x', catalogId: 'project:library/Gone.glb', glbUrl: '', label: 'Gone',
      position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
    };

    await expect(p._clonePlacement(orphan)).resolves.toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('a .gltf project entry fails the pending load with a message (no crash)', async () => {
    installFakeProject();
    const h = setupPlanner();
    withProjectCache(h);
    const p = internals(h.plugin);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await p._startDraft(GLTF_ENTRY);
    const id = p._draft!.id;
    await flush(12);

    // The placeholder survives and carries the failure; nothing threw out of
    // the fire-and-forget load.
    expect(p._objectMap.get(id)).toBeDefined();
    expect(p._pending.statusOf(id)).toBe('error');
    expect(p._pending.get(id)?.error).toMatch(/buffer\.bin/);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('an entry with neither a glbUrl nor a registry origin fails the pending load with a described error', async () => {
    installFakeProject();
    const h = setupPlanner();
    withProjectCache(h);
    const p = internals(h.plugin);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await p._startDraft({ id: 'cat:orphan', name: 'Orphan', category: 'custom', glbUrl: '' });
    const id = p._draft!.id;
    await flush(12);

    expect(p._pending.statusOf(id)).toBe('error');
    expect(p._pending.get(id)?.error).toMatch(/no registry origin/);
    warn.mockRestore();
  });

  it('document-saved evicts the stable cache key so the next placement re-resolves', async () => {
    const project = installFakeProject();
    const h = setupPlanner();
    const loader = withProjectCache(h);

    await h.plugin.placeComponent(BELT_ENTRY, [0, 0, 0]);
    await flush(12);
    expect(project.resolves).toEqual([BELT_ID]);

    // The editor just wrote the document. Without the registry arm of this hook
    // the walk over `store.catalogs` would find nothing — the project's
    // documents were never in the store — and the whole session would keep
    // placing pre-save geometry.
    documentSavedHandler(h)({ relPath: 'library/Belt.glb' });

    await h.plugin.placeComponent(BELT_ENTRY, [1, 0, 1]);
    await flush(12);

    expect(project.resolves).toEqual([BELT_ID, BELT_ID]);
    expect(loader.decodes).toHaveLength(2);
  });

  it('the stable cache key is namespaced per provider + source + entry', () => {
    expect(resolvedCacheKey('project', PROJECT_SOURCE_ID, BELT_ID))
      .toBe(`resolved:project:${PROJECT_SOURCE_ID}:${BELT_ID}`);
    expect(resolvedCacheKey('project', 'other-project', BELT_ID))
      .not.toBe(resolvedCacheKey('project', PROJECT_SOURCE_ID, BELT_ID));
  });
});
