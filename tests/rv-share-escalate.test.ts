// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-386 §9.5 — escalation into the full app, and the bookmark that outlives
 * the visit.
 *
 * Unlike §9.4 the executors are **not** mocked here: the whole question of
 * `escalate_LevelAssembly_OpensAsPlacement` is whether the real chain
 * `AddPlacementOp` → `addPlacementForward()` → `placeFromRecord()` runs and
 * hands the planner a complete record. A mocked executor would assert that the
 * test author can build an object literal.
 *
 * The scene-store singleton is process-wide and has no reset, so one store
 * serves the file and the planner is swapped underneath it — which is also how
 * `escalate_MissingPlannerPlugin_FailsClearly` gets its "no planner" case
 * without a second store.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../src/core/hmi/scene/rv-scene-glb-io', () => ({
  readSceneGlbBody: vi.fn(async () => null),
  writeSceneGlbBody: vi.fn(async () => ({ revision: 'rev1', target: 'opfs' })),
  dropSceneGlbBody: vi.fn(async () => undefined),
  sceneGlbBodyRevision: vi.fn(async () => null),
}));

import { initSceneStore, getSceneStore } from '../src/core/hmi/scene/scene-store-singleton';
import type { RvScene } from '../src/core/hmi/scene/rv-scene-types';
import type { PlacedComponent } from '../src/plugins/layout-planner/rv-layout-store';
import {
  escalateSharedGlb,
  escalationKindFor,
  makeSharedGlbScene,
  makeSharedPlacement,
} from '../src/core/share/rv-share-escalate';
import { buildSharedGlbInfo, type SharedGlbInfo } from '../src/core/share/rv-share-meta';
import {
  SHARED_BOOKMARKS_KEY,
  SHARED_BOOKMARKS_CATALOG_KEY,
  addSharedAssetBookmark,
  listSharedAssetBookmarks,
  markSharedAssetBookmarkExpired,
  publishSharedBookmarks,
  removeSharedAssetBookmark,
  resetSharedBookmarkCache,
  sharedBookmarkCatalog,
} from '../src/core/share/shared-asset-bookmarks';

const SHARE_URL = 'https://files.example.test/pick-and-place.glb';

function infoFor(level?: 'component' | 'assembly' | 'model', extra: Record<string, unknown> = {}): SharedGlbInfo {
  return buildSharedGlbInfo({
    url: SHARE_URL,
    userData: {
      rv_share: {
        v: 1, name: 'Pick & Place Cell', author: 'Thomas Strigl',
        ...(level ? { level } : {}), ...extra,
      },
    },
  });
}

// ─── The fake app the escalation lands in ──────────────────────────────────

interface FakePlanner {
  placed: PlacedComponent[];
  placeFromRecord: (p: PlacedComponent) => Promise<void>;
  removePlacementById: (id: string) => void;
}

let planner: FakePlanner | null;
let loaded: RvScene[];

function makePlanner(): FakePlanner {
  const p: FakePlanner = {
    placed: [],
    placeFromRecord: vi.fn(async (rec: PlacedComponent) => { p.placed.push(rec); }),
    removePlacementById: vi.fn((id: string) => { p.placed = p.placed.filter(c => c.id !== id); }),
  };
  return p;
}

const viewer = {
  loadScene: vi.fn(async (s: RvScene) => { loaded.push(s); }),
  getPlugin: <T,>(id: string): T | undefined =>
    (id === 'layout-planner' ? (planner as unknown as T) ?? undefined : undefined),
  availableModels: [],
  availablePublishedScenes: [],
  currentScene: null,
  currentModelUrl: SHARE_URL,
  currentModelRoot: null,
  registry: { getGltfNodeNames: () => [], getGltfNodeIndex: () => -1 },
  lastLoadResult: null,
  modes: { has: () => true, setMode: vi.fn() },
};

beforeEach(() => {
  localStorage.clear();
  resetSharedBookmarkCache();
  loaded = [];
  planner = makePlanner();
  viewer.loadScene.mockClear();
  initSceneStore(viewer as unknown as Parameters<typeof initSceneStore>[0]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── Escalation ────────────────────────────────────────────────────────────

describe('plan-386 §9.5 — escalation', () => {
  it('escalate_LevelModel_OpensAsScene', async () => {
    const result = await escalateSharedGlb(infoFor('model'), { viewer });

    expect(result.kind).toBe('scene');
    expect(result.placementId).toBeUndefined();
    // The GLB *is* the scene: it becomes the workspace base, not a placement.
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.base).toMatchObject({ kind: 'builtin', url: SHARE_URL });
    expect(planner!.placed).toHaveLength(0);
    // And it stays transient: escalating is not the same as adopting (F7).
    expect(getSceneStore()!.isTransient()).toBe(true);
  });

  it('escalate_LevelAssembly_OpensAsPlacement', async () => {
    const result = await escalateSharedGlb(infoFor('assembly'));

    expect(result.kind).toBe('placement');
    // Exactly one, and complete: a half-filled record survives addComponent()
    // and then sits at the origin with no scale and no label (R8).
    expect(planner!.placed).toHaveLength(1);
    const placed = planner!.placed[0]!;
    expect(placed.id).toBe(result.placementId);
    expect(placed.glbUrl).toBe(SHARE_URL);
    expect(placed.label).toBe('Pick & Place Cell');
    expect(placed.position).toEqual([0, 0, 0]);
    expect(placed.rotation).toEqual([0, 0, 0]);
    expect(placed.scale).toEqual([1, 1, 1]);
    expect(placed.catalogId).toContain(SHARE_URL);
    expect(getSceneStore()!.isTransient()).toBe(true);

    // The op is a normal entry in the in-memory log, so undo works and the
    // placement disappears again.
    expect(getSceneStore()!.getSnapshot().canUndo).toBe(true);
    await getSceneStore()!.undo();
    expect(planner!.placed).toHaveLength(0);
  });

  it('escalate_DefaultsToPlacementWithoutLevel', async () => {
    // An unstamped file must not silently replace whatever the visitor had
    // open — the recoverable outcome is the default.
    expect(escalationKindFor(null)).toBe('placement');
    expect(escalationKindFor({ v: 2 })).toBe('placement');
    expect(escalationKindFor({ v: 2, level: 'plant' })).toBe('scene');
    expect(escalationKindFor({ v: 2, level: 'scene' })).toBe('scene');
    expect(escalationKindFor({ v: 2, level: 'part' })).toBe('placement');

    // plan-413: a v1 link that said `model` must still escalate to a scene.
    // The mapping happens in `parseShareMeta`, so the proof has to run through
    // a raw block rather than a hand-built meta object.
    expect(escalationKindFor(infoFor('model').meta)).toBe('scene');
    expect(escalationKindFor(infoFor('component').meta)).toBe('placement');

    const result = await escalateSharedGlb(infoFor(), { viewer });
    expect(result.kind).toBe('placement');
  });

  it('escalate_MissingPlannerPlugin_FailsClearly', async () => {
    planner = null;
    const loadsBefore = loaded.length;

    await expect(escalateSharedGlb(infoFor('assembly'), { viewer }))
      .rejects.toThrow(/LayoutPlannerPlugin not registered/);

    // And it failed BEFORE replacing the workspace. `applyOp` swallows a
    // failing executor by design, so a post-hoc check would have left the
    // visitor in an empty scene with the explanation only in the console.
    expect(loaded).toHaveLength(loadsBefore);
  });

  it('escalate_SyntheticSceneIsComplete', () => {
    // makeDraftScene, not a hand-rolled literal: isValidSceneV2 checks four
    // truthy fields while RvScene needs considerably more (R8).
    const scene = makeSharedGlbScene(SHARE_URL, { v: 1, name: 'Cell' });
    expect(scene).toMatchObject({
      id: 'draft',
      name: 'Cell',
      base: { kind: 'builtin', url: SHARE_URL, label: 'Cell' },
    });
    expect(scene.schemaVersion).toBeGreaterThan(0);
    expect(scene.createdAt).toBeTruthy();
    expect(scene.edits.settings).toBeTruthy();

    // No rv_share name → the filename carries the label.
    expect(makeSharedGlbScene(SHARE_URL, null).name).toBe('pick-and-place');

    const placement = makeSharedPlacement({ url: SHARE_URL, name: 'Cell', meta: null });
    for (const field of ['id', 'catalogId', 'glbUrl', 'label', 'position', 'rotation', 'scale'] as const) {
      expect(placement[field]).toBeDefined();
    }
  });
});

// ─── Bookmarks ─────────────────────────────────────────────────────────────

describe('plan-386 §9.5 — shared-asset bookmarks', () => {
  it('bookmark_PersistsAcrossReload', () => {
    expect(addSharedAssetBookmark(infoFor('assembly'))).toBe(true);

    // "Reload": drop every in-memory trace and read storage again.
    resetSharedBookmarkCache();
    const after = listSharedAssetBookmarks();

    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ url: SHARE_URL, name: 'Pick & Place Cell' });
    expect(localStorage.getItem(SHARED_BOOKMARKS_KEY)).toBeTruthy();

    // Adding the same link twice refreshes it rather than duplicating the row.
    addSharedAssetBookmark(infoFor('assembly'));
    resetSharedBookmarkCache();
    expect(listSharedAssetBookmarks()).toHaveLength(1);

    removeSharedAssetBookmark(SHARE_URL);
    resetSharedBookmarkCache();
    expect(listSharedAssetBookmarks()).toHaveLength(0);
  });

  it('bookmark_NotPersisted_WithoutAdd', async () => {
    // The consumer path — and now the escalation too — writes nothing here.
    // Only the explicit click does.
    await escalateSharedGlb(infoFor('assembly'));

    resetSharedBookmarkCache();
    expect(listSharedAssetBookmarks()).toHaveLength(0);
    expect(localStorage.getItem(SHARED_BOOKMARKS_KEY)).toBeNull();
  });

  it('bookmark_ExpiredMarkedVisibly', () => {
    addSharedAssetBookmark(infoFor('assembly', { expiresAt: '2026-09-04T00:00:00.000Z' }));
    expect(listSharedAssetBookmarks()[0]!.expiresAt).toBe('2026-09-04T00:00:00.000Z');

    markSharedAssetBookmarkExpired(SHARE_URL);

    // Still there — an entry that vanishes reads as a bug, one that is labelled
    // tells the visitor to ask the sender again (R14).
    const list = listSharedAssetBookmarks();
    expect(list).toHaveLength(1);
    expect(list[0]!.expired).toBe(true);

    // And the marking is in the projected NAME, because the library grid that
    // renders it knows nothing about sharing.
    const catalog = sharedBookmarkCatalog();
    expect(catalog.entries).toHaveLength(1);
    expect(catalog.entries[0]!.name).toContain('no longer available');
    expect(catalog.entries[0]!.glbUrl).toBe(SHARE_URL);
  });

  it('bookmark_QuotaExceeded_FailsSoftly', () => {
    const original = localStorage.setItem.bind(localStorage);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation((k: string, v: string) => {
      if (k === SHARED_BOOKMARKS_KEY) {
        const e = new Error('QuotaExceededError');
        e.name = 'QuotaExceededError';
        throw e;
      }
      original(k, v);
    });

    // No exception out of a button handler; the caller learns it did not stick.
    expect(() => addSharedAssetBookmark(infoFor('assembly'))).not.toThrow();
    expect(addSharedAssetBookmark(infoFor('assembly'))).toBe(false);
    // The session still shows it, which is the honest half-success.
    expect(listSharedAssetBookmarks()).toHaveLength(1);
  });

  it('bookmark_ProjectsAsOneCatalogTab', () => {
    addSharedAssetBookmark(infoFor('assembly'));
    const host = { addCatalogDirect: vi.fn() };

    publishSharedBookmarks(host);

    expect(host.addCatalogDirect).toHaveBeenCalledTimes(1);
    const [key, catalog] = host.addCatalogDirect.mock.calls[0]!;
    // One tab under a scheme, not a URL — `addCatalog(url)` would fetch the
    // .glb and try to parse it as a JSON catalogue.
    expect(key).toBe(SHARED_BOOKMARKS_CATALOG_KEY);
    expect(catalog.version).toBe('1.0');
    expect(catalog.entries).toHaveLength(1);
  });
});
