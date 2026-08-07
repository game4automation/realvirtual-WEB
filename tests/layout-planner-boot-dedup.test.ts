// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-376 F3 — one placement id, one instance, on a real boot.
 *
 * Two restore paths run on the SAME app start: the planner's own legacy
 * autosave restore inside `_loadCatalogs`, and the Scene model's op replay
 * (`applyPlacements` / `placeFromRecord`). Both walk the same saved records.
 * Each carries an `_objectMap.has(id)` guard, and `_addPlacedToScene`
 * OVERWRITES the map entry while leaving the earlier clone in the scene tree —
 * so a lost guard shows up as a doubled render, not as an error.
 *
 * The guards were never covered on the store side, which is the half that
 * actually persists: a second `store.addComponent` for the same id would be
 * written straight back into the autosave. This file covers both halves.
 *
 * The boot path is driven for REAL — `localStorage['rv-layout-autosave']` is
 * seeded BEFORE `setupPlanner()` and `internals(plugin)._catalogsLoaded` is
 * awaited afterwards. Re-implementing the loop body here would only ever prove
 * that the copy is consistent with itself.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { setupPlanner, internals, flush, TINY_PNG } from './_layout-planner-async-harness';
import type { LayoutPlannerPlugin } from '../src/plugins/layout-planner';
import type {
  LibraryCatalogEntry,
  PlacedComponent,
} from '../src/plugins/layout-planner/rv-layout-store';

const STABLE_URL = 'https://rv-test.invalid/plan376-dedup.glb';
const AUTOSAVE_KEY = 'rv-layout-autosave';
const ID = 'p376-dedup';

const ENTRY: LibraryCatalogEntry = {
  id: 'cat:plan376-dedup',
  name: 'Belt',
  category: 'conveyor',
  glbUrl: STABLE_URL,
  thumbnailUrl: TINY_PNG,
  footprintMm: [1200, 400],
};

function record(id = ID): PlacedComponent {
  return {
    id,
    catalogId: ENTRY.id,
    glbUrl: STABLE_URL,
    label: 'Belt',
    position: [1, 0, 2],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
  };
}

function seedAutosave(components: PlacedComponent[]): void {
  localStorage.setItem(AUTOSAVE_KEY, JSON.stringify({
    version: '1.0',
    name: 'autosave',
    createdAt: new Date().toISOString(),
    catalogUrls: [],
    gridSizeMm: 100,
    components,
  }));
}

function countInStore(plugin: LayoutPlannerPlugin, id: string): number {
  return plugin.store.getSnapshot().placed.filter(c => c.id === id).length;
}

/** How many nodes below the scene root carry this placement's marker — the
 *  half `_objectMap` cannot see, because `_addPlacedToScene` overwrites the
 *  map entry and orphans the previous clone in the tree. */
function countInScene(viewer: { scene: { traverse(cb: (n: { userData: Record<string, unknown> }) => void): void } }, id: string): number {
  let n = 0;
  viewer.scene.traverse((node) => { if (node.userData?._layoutId === id) n++; });
  return n;
}

describe('plan-376 F3 — boot restore places each id exactly once', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    localStorage.removeItem(AUTOSAVE_KEY);
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(new Blob([new Uint8Array([0])]), {
        status: 200,
        headers: { 'Content-Type': 'model/gltf-binary' },
      }),
    ) as ReturnType<typeof vi.spyOn>;
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    warnSpy.mockRestore();
    localStorage.removeItem(AUTOSAVE_KEY);
  });

  it('autosave restore alone places the record once', async () => {
    seedAutosave([record()]);
    const { plugin, viewer } = setupPlanner();
    await internals(plugin)._catalogsLoaded;
    await flush();

    expect(internals(plugin)._objectMap.size).toBe(1);
    expect(countInScene(viewer, ID)).toBe(1);
    expect(countInStore(plugin, ID)).toBe(1);
  });

  it('autosave restore + applyPlacements for the same id → one instance', async () => {
    seedAutosave([record()]);
    const { plugin, viewer } = setupPlanner();

    // Deliberately NOT awaiting `_catalogsLoaded` first: on a real boot the
    // Scene model's placement replay (loadScene Phase 4) is kicked off while
    // `_loadCatalogs` is still in flight.
    const replay = plugin.applyPlacements({
      placements: [record()],
      catalogUrls: [],
      gridSizeMm: 100,
    });
    await Promise.all([replay, internals(plugin)._catalogsLoaded]);
    await flush();

    expect(internals(plugin)._objectMap.size).toBe(1);
    expect(countInScene(viewer, ID)).toBe(1);
    // The store half — untested before plan-376. A missing guard here writes
    // the duplicate straight back into the next autosave.
    expect(countInStore(plugin, ID)).toBe(1);
  });

  it('autosave restore + placeFromRecord op replay for the same id → one instance', async () => {
    seedAutosave([record()]);
    const { plugin, viewer } = setupPlanner();

    // `placeFromRecord` is the single-op executor `rv-scene-executors` calls
    // for an `addPlacement` op. Started concurrently with the boot restore,
    // both reach their `_objectMap.has` guard before either has placed
    // anything — this is the overlapping-await case.
    const replay = plugin.placeFromRecord(record());
    await Promise.all([replay, internals(plugin)._catalogsLoaded]);
    await flush();

    expect(internals(plugin)._objectMap.size).toBe(1);
    expect(countInScene(viewer, ID)).toBe(1);
    expect(countInStore(plugin, ID)).toBe(1);
  });

  it('a second applyPlacements after boot does not duplicate either', async () => {
    seedAutosave([record()]);
    const { plugin, viewer } = setupPlanner();
    await internals(plugin)._catalogsLoaded;
    await flush();

    await plugin.applyPlacements({
      placements: [record()],
      catalogUrls: [],
      gridSizeMm: 100,
    });
    await flush();

    expect(internals(plugin)._objectMap.size).toBe(1);
    expect(countInScene(viewer, ID)).toBe(1);
    expect(countInStore(plugin, ID)).toBe(1);
  });
});
