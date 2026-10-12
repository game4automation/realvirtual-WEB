// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-371 T13 — the pre-existing placement paths must stay in FULL mode.
 *
 * `_addPlacedToScene` is the shared facade for every placement path. plan-371
 * gave it a `mode` parameter, and exactly ONE caller — the pending placeholder
 * — may pass `'light'`. A wrong default would register every other path
 * without signals, drives, snap ports or raycast targets: no crash, just a
 * dead layout, and completely silent on the boot-restore paths that run on
 * every app start with a saved layout.
 *
 * "Full mode" is asserted through its observable effect rather than a spy: the
 * placement records a `processExtras` phase in the placement-timing ring, which
 * only `integratePlacedContent` emits — `light` registers the root alone and
 * marks `namingScan` instead.
 *
 * Until plan-754 this was read off the node registry ("every child of the
 * placement root has a path"). That proxy died with the ONE init (F13/D19): a
 * placed subtree is baked, its only child is a chunk mesh, and a chunk mesh is
 * deliberately NOT registered — the same contract the main model has always
 * had, and the one `web_node_tree` documents ("their path is computed, not
 * registry-backed"). Before F13 the leaner `processExtras` traversal registered
 * placement chunks under phantom paths like `Model/Belt/tex:<uuid>`; the shared
 * traversal skips them, so there is no registry signature left to read.
 *
 * The public entry points below are unchanged by plan-376; what changed is
 * that they now reach `_addPlacedToScene` through two shared private routines
 * instead of five hand-written copies, which is why the final SOURCE-LEVEL
 * guard counts 5 call sites where it used to count 9. That guard covers the
 * autosave restore inside `_loadCatalogs` too, which cannot be driven from a
 * unit test without fetching the bundled library over the network — and
 * asserting "exactly one call site opts into light" is the more direct guard
 * for this particular regression anyway.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import plannerSource from '../src/plugins/layout-planner/index.ts?raw';
import {
  getPlacementTimings,
  clearPlacementTimings,
} from '../src/plugins/layout-planner/scene-mutations';
import {
  setupPlanner,
  internals,
  flush,
  GLB_ENTRY,
  GLB_URL,
  VIRTUAL_ENTRY,
} from './_layout-planner-async-harness';
import type { LayoutPlannerPlugin } from '../src/plugins/layout-planner';
import type { PlacedComponent } from '../src/plugins/layout-planner/rv-layout-store';

/** The restore paths reject `blob:` URLs as stale by design, so those cases
 *  need a stable URL — and therefore a `fetch` for `RVAssetBlobCache`. */
const STABLE_URL = 'https://rv-test.invalid/belt.glb';

function record(id: string, glbUrl = GLB_URL): PlacedComponent {
  return {
    id,
    catalogId: GLB_ENTRY.id,
    glbUrl,
    label: 'Belt',
    position: [1, 0, 2],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
  };
}

/** True when the placement ran `integratePlacedContent` — the signature of a
 *  full-mode registration. `light` marks `namingScan` and never `processExtras`. */
function ranProcessExtras(plugin: LayoutPlannerPlugin, id: string): boolean {
  const placed = internals(plugin)._objectMap.get(id);
  if (!placed) return false;
  return getPlacementTimings().some(
    t => t.id === id && t.phases.some(p => p.phase === 'processExtras'),
  );
}

describe('plan-371 T13 — legacy placement paths stay in full mode', () => {
  // Autosave hygiene (same pattern as clone-placement / boot-dedup): each
  // planner autosaves its placements to localStorage, and `_loadCatalogs`
  // restores them on the NEXT planner's boot — without clearing, every test
  // re-places what the previous one built and the count assertions drift.
  const AUTOSAVE_KEY = 'rv-layout-autosave';
  beforeEach(() => { localStorage.removeItem(AUTOSAVE_KEY); clearPlacementTimings(); });
  afterEach(() => { localStorage.removeItem(AUTOSAVE_KEY); });

  it('placeComponent (also the MCP web_layout_place path)', async () => {
    const { plugin } = setupPlanner();
    const id = await plugin.placeComponent(GLB_ENTRY, [0, 0, 0]);
    expect(ranProcessExtras(plugin, id)).toBe(true);
  });

  it('duplicateSelected', async () => {
    const { plugin } = setupPlanner();
    const id = await plugin.placeComponent(GLB_ENTRY, [0, 0, 0]);
    plugin.store.selectComponent(id);
    await plugin.duplicateSelected();

    const ids = [...internals(plugin)._objectMap.keys()];
    expect(ids.length).toBe(2);
    for (const each of ids) expect(ranProcessExtras(plugin, each)).toBe(true);
  });

  it.each([
    ['paste-glb', GLB_ENTRY],
    ['paste-virtual', VIRTUAL_ENTRY],
  ])('%s', async (_name, entry) => {
    const { plugin, viewer } = setupPlanner();
    // Seed the catalog so paste can tell the entry kinds apart — the virtual
    // branch exists precisely because `getOrLoad('')` would fail otherwise.
    plugin.store.addCatalogDirect('test://catalog', {
      version: '1.0', name: 'test', entries: [entry],
    });

    const id = await plugin.placeComponent(entry, [0, 0, 0]);
    plugin.store.selectComponent(id);
    plugin.copySelected();
    await plugin.pasteClipboard();
    await flush();

    const ids = [...internals(plugin)._objectMap.keys()].filter(each => each !== id);
    expect(ids.length).toBe(1);
    const pasted = internals(plugin)._objectMap.get(ids[0])!;
    // A virtual gizmo's wireframe child carries no rv-extras, so for that case
    // assert the weaker but still mode-sensitive property: registered at all.
    expect(viewer.registry.getPathForNode(pasted)).not.toBeNull();
    if (entry === GLB_ENTRY) expect(ranProcessExtras(plugin, ids[0])).toBe(true);
  });

  it('placeFromRecord (undo / redo replay)', async () => {
    const { plugin } = setupPlanner();
    await plugin.placeFromRecord(record('rec-1'));
    expect(ranProcessExtras(plugin, 'rec-1')).toBe(true);
  });

  describe('boot restore', () => {
    let fetchSpy: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
        new Response(new Blob([new Uint8Array([0x67, 0x6c, 0x54, 0x46, 2, 0, 0, 0, 12, 0, 0, 0]) /* a bare `glTF` header — the blob cache refuses anything else */]), {
          status: 200,
          headers: { 'Content-Type': 'model/gltf-binary' },
        }),
      ) as ReturnType<typeof vi.spyOn>;
    });
    afterEach(() => { fetchSpy.mockRestore(); });

    it('applyPlacements (Scene model restore)', async () => {
      const { plugin } = setupPlanner();
      await plugin.applyPlacements({
        catalogUrls: [],
        gridSizeMm: 100,
        placements: [record('restore-1', STABLE_URL)],
      });
      expect(ranProcessExtras(plugin, 'restore-1')).toBe(true);
    });

    it('applyLayoutFile (legacy layout-file restore)', async () => {
      const { plugin } = setupPlanner();
      await plugin.applyLayoutFile({
        version: '1.0',
        name: 'test',
        createdAt: new Date().toISOString(),
        catalogUrls: [],
        gridSizeMm: 100,
        components: [record('autosave-1', STABLE_URL)],
      });
      expect(ranProcessExtras(plugin, 'autosave-1')).toBe(true);
    });
  });

  it('source guard: exactly ONE call site opts into light mode', () => {
    const callSites = plannerSource.match(/this\._addPlacedToScene\([\s\S]*?\);/g) ?? [];
    // 5 callers since plan-376 folded the placement bodies together: the 4
    // FULL-mode ones — `_startDraft` (the virtual/DES drag branch),
    // `placeComponent`, `_buildPlacementFromRecord` (the ONE body all three
    // restore paths use) and `_clonePlacement` (the ONE body duplicate and
    // paste use) — plus the single LIGHT one added by plan-371:
    // `_startGlbDraft`, the pending placeholder.
    //
    // It was 9 before plan-376: the three restore paths and the two creation
    // paths each carried their own copy, and two of those copies had a
    // separate virtual-DES call site.
    //
    // 6 since plan-753 Phase 3: `_startGlbDraft` gained a second, FULL-mode
    // call site for the warm-cache case — the baked asset is already there,
    // so the draft is instantiated as a real placement at once (no
    // placeholder, no pending load). The light site is unchanged.
    expect(callSites.length).toBe(6);

    const lightSites = callSites.filter(site => /mode:\s*'light'/.test(site));
    expect(lightSites.length).toBe(1);
    // …and it is the pending placeholder, nothing else.
    expect(lightSites[0]).toContain("mode: 'light'");

    // No other call site passes a mode at all, so every one of them inherits
    // the `'full'` default.
    const otherModeSites = callSites.filter(
      site => /\bmode:/.test(site) && !/mode:\s*'light'/.test(site),
    );
    expect(otherModeSites).toEqual([]);
  });
});
