// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-376 — characterisation of the five placement paths.
 *
 * The planner builds "a living placement out of a `PlacedComponent` record" in
 * five separate places: three restore paths (`placeFromRecord`, the
 * `_restorePlacements` loop, the legacy autosave loop inside `_loadCatalogs`)
 * and two creation paths (`duplicateSelected`, `pasteClipboard`). They drifted
 * apart. This file runs ONE fixture through all five and pins what each of them
 * actually does — INCLUDING the gaps, so the consolidation cannot silently
 * change something nobody was looking at.
 *
 * Assertions that flip from "is" to "should" during Phase 2/3 carry a grep-able
 * `// §2.4 #N — BEHAVIOR CHANGE (Fx)` marker and keep the previous expectation
 * as a `// war (pre-PhaseN): …` comment. §7 of the plan makes that mandatory:
 * a deliberately updated assertion must not read like a loosened one.
 *
 * Three harness decisions worth knowing:
 *
 * 1. **The fixture uses a STABLE (https) url, not a `blob:` one.** All three
 *    restore paths re-resolve the saved url, and `resolvePlacementUrl` rejects
 *    `blob:` as stale by design — a blob fixture would be skipped before ever
 *    reaching the placement code. A stable url needs `fetch` (for
 *    `RVAssetBlobCache`), hence the mock.
 * 2. **The legacy autosave loop is driven for real**, by seeding
 *    `localStorage['rv-layout-autosave']` BEFORE `setupPlanner()` and awaiting
 *    `internals(plugin)._catalogsLoaded`. A re-implemented loop body would only
 *    ever test the copy.
 * 3. **"Did the virtual-DES branch run?" is asserted through the desType
 *    marker, never through "did it throw".** With `fetch` mocked, the buggy
 *    `getOrLoad('')` fallback happily returns a bogus decoded Group instead of
 *    failing, so absence-of-error proves nothing. The `realvirtual.<desType>`
 *    key is written ONLY by the virtual branch.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MathUtils } from 'three';
import type { Object3D } from 'three';

import {
  setupPlanner,
  internals,
  flush,
  TINY_PNG,
} from './_layout-planner-async-harness';
import type { LayoutPlannerPlugin } from '../src/plugins/layout-planner';
import type {
  LibraryCatalogEntry,
  PlacedComponent,
  SignalMapping,
} from '../src/plugins/layout-planner/rv-layout-store';

// ─── Fixtures ───────────────────────────────────────────────────────────

const STABLE_URL = 'https://rv-test.invalid/plan376-belt.glb';
const BROKEN_URL = 'https://rv-test.invalid/plan376-broken.glb';
const SPLAT_URL = 'https://rv-test.invalid/plan376-cloud.ply';
const CATALOG_URL = 'test://plan376-catalog';
const AUTOSAVE_KEY = 'rv-layout-autosave';
const DES_TYPE = 'UnregisteredTestType';

const BELT_ENTRY: LibraryCatalogEntry = {
  id: 'cat:plan376-belt',
  name: 'Belt',
  category: 'conveyor',
  glbUrl: STABLE_URL,
  thumbnailUrl: TINY_PNG,
  footprintMm: [1200, 400],
};

const SPLAT_ENTRY: LibraryCatalogEntry = {
  id: 'cat:plan376-splat',
  name: 'Cloud',
  category: 'splat',
  splatUrl: SPLAT_URL,
};

/** Virtual DES entry with an unregistered desType → wireframe placeholder. */
const VIRTUAL_ENTRY: LibraryCatalogEntry = {
  id: 'cat:plan376-virtual',
  name: 'VirtualBox',
  category: 'des',
  glbUrl: '',
  thumbnailUrl: '',
  virtual: true,
  desType: DES_TYPE,
  gizmoSize: [500, 500, 500],
};

const MAPPING: SignalMapping = {
  kind: 'mapped-signal',
  componentPath: 'BeltMesh',
  slot: 'Forward',
  sourceKind: 'connect',
  signal: 'ConveyorMotor.Run',
  interfaceId: 'iface-1',
  direction: 'plcInput',
  enabled: true,
};

/** The full fixture: every optional field populated. */
function fullRecord(id = 'p376-full'): PlacedComponent {
  return {
    id,
    catalogId: BELT_ENTRY.id,
    glbUrl: STABLE_URL,
    label: 'Belt',
    position: [1, 0.5, 2],
    rotation: [0, 90, 0],
    scale: [2, 2, 2],
    visible: false,
    signalMappings: [{ ...MAPPING }],
  };
}

/** The legacy fixture: no `visible`, no `signalMappings` (pre-6.x autosave). */
function leanRecord(id = 'p376-lean', glbUrl = STABLE_URL): PlacedComponent {
  return {
    id,
    catalogId: BELT_ENTRY.id,
    glbUrl,
    label: 'Belt',
    position: [3, 0, 4],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
  };
}

function splatRecord(id = 'p376-splat'): PlacedComponent {
  return {
    id,
    catalogId: SPLAT_ENTRY.id,
    glbUrl: '',
    splatUrl: SPLAT_URL,
    label: 'Cloud',
    position: [5, 1, 6],
    rotation: [0, 45, 0],
    scale: [1, 1, 1],
    visible: false,
  };
}

function virtualRecord(id = 'p376-virtual'): PlacedComponent {
  return {
    id,
    catalogId: VIRTUAL_ENTRY.id,
    glbUrl: '',
    label: 'VirtualBox',
    position: [7, 0, 8],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
  };
}

function seedCatalog(plugin: LayoutPlannerPlugin): void {
  plugin.store.addCatalogDirect(CATALOG_URL, {
    version: '1.0',
    name: 'plan376',
    entries: [BELT_ENTRY, SPLAT_ENTRY, VIRTUAL_ENTRY],
  });
}

/**
 * Boot a planner and WAIT for `_loadCatalogs` to finish before returning.
 *
 * Not optional hygiene — `_loadCatalogs` is kicked off unawaited by
 * `onModelLoaded`, and it ends with `store.autoSave()` whenever the store
 * already holds placements. Left running, it lands in the NEXT test, writes
 * `rv-layout-autosave` after that test's `beforeEach` cleared it, and the next
 * planner boot then silently restores a foreign placement — whose `_objectMap`
 * entry makes the restore loop's dedup guard skip the real one. That produced
 * exactly one confusing symptom: a restored node with the right transform but
 * no `visible` and no marker sync.
 */
async function bootPlanner(opts?: Parameters<typeof setupPlanner>[0]) {
  const harness = setupPlanner(opts);
  seedCatalog(harness.plugin);
  await internals(harness.plugin)._catalogsLoaded;
  await flush();
  return harness;
}

function seedAutosave(components: PlacedComponent[], gridSizeMm = 100): void {
  localStorage.setItem(AUTOSAVE_KEY, JSON.stringify({
    version: '1.0',
    name: 'autosave',
    createdAt: new Date().toISOString(),
    catalogUrls: [],
    gridSizeMm,
    components,
  }));
}

// ─── Observables ────────────────────────────────────────────────────────

function rvExtras(node: Object3D): Record<string, Record<string, unknown>> | undefined {
  return node.userData.realvirtual as Record<string, Record<string, unknown>> | undefined;
}

/** The `LayoutObject.Visible` marker — written ONLY by
 *  `syncLayoutMarkerComponents`, so its presence is a direct probe for
 *  "did this path run the marker sync?". */
function markerVisible(node: Object3D): boolean | undefined {
  return rvExtras(node)?.LayoutObject?.Visible as boolean | undefined;
}

/** The DES config key — written ONLY by the virtual-DES branch. */
function desMarker(node: Object3D): unknown {
  return rvExtras(node)?.[DES_TYPE];
}

function placedIn(plugin: LayoutPlannerPlugin, id: string): Object3D | undefined {
  return internals(plugin)._objectMap.get(id);
}

function storeRecord(plugin: LayoutPlannerPlugin, id: string): PlacedComponent | undefined {
  return plugin.store.getSnapshot().placed.find(c => c.id === id);
}

// ─── Suite ──────────────────────────────────────────────────────────────

describe('plan-376 — placement parity across the five paths', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    localStorage.removeItem(AUTOSAVE_KEY);
    // `RVAssetBlobCache` fetches every non-blob url. The bytes never reach a
    // real GLTF parser (the harness loader is stubbed), so any body will do.
    //
    // The fetch layer is ALSO where a load failure has to be injected. The
    // harness's `cache.fail(url)` keys on the url the GLTFLoader is handed —
    // and for a non-blob source url that is the blob-cache's object url, not
    // the source url. Failing the fetch is the only reliable seam here.
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes(BROKEN_URL)) throw new TypeError('network down (test)');
      return new Response(new Blob([new Uint8Array([0])]), {
        status: 200,
        headers: { 'Content-Type': 'model/gltf-binary' },
      });
    }) as ReturnType<typeof vi.spyOn>;
    // The restore paths log expected warnings (unresolvable url, missing splat
    // plugin, per-item failure). Silence them; individual tests assert on the spy.
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    warnSpy.mockRestore();
    localStorage.removeItem(AUTOSAVE_KEY);
  });

  // ── Restore path 1: placeFromRecord (op executor) ─────────────────────

  describe('placeFromRecord (op forward executor)', () => {
    it('applies position, degrees→radians rotation, scale, visible and marker sync', async () => {
      const { plugin } = await bootPlanner();
      const rec = fullRecord();

      await plugin.placeFromRecord(rec);

      const node = placedIn(plugin, rec.id);
      expect(node).toBeDefined();
      expect(node!.position.toArray()).toEqual([1, 0.5, 2]);
      expect(node!.rotation.y).toBeCloseTo(MathUtils.degToRad(90), 6);
      expect(node!.scale.toArray()).toEqual([2, 2, 2]);
      expect(node!.visible).toBe(false);
      expect(markerVisible(node!)).toBe(false);
    });

    it('mirrors the record into the store and applies element bindings', async () => {
      const { plugin } = await bootPlanner();
      const spy = vi.spyOn(internals(plugin), '_applyElementBindings');
      const rec = fullRecord();

      await plugin.placeFromRecord(rec);

      expect(storeRecord(plugin, rec.id)?.signalMappings).toEqual([MAPPING]);
      expect(spy).toHaveBeenCalledWith(rec.id, expect.anything(), [MAPPING]);
    });

    it('is idempotent — a second forward apply adds nothing', async () => {
      const { plugin } = await bootPlanner();
      const rec = fullRecord();

      await plugin.placeFromRecord(rec);
      await plugin.placeFromRecord(rec);

      expect(internals(plugin)._objectMap.size).toBe(1);
      expect(plugin.store.getSnapshot().placed.filter(c => c.id === rec.id).length).toBe(1);
    });

    it('legacy record without visible/signalMappings stays visible', async () => {
      const { plugin } = await bootPlanner();

      await plugin.placeFromRecord(leanRecord());

      const node = placedIn(plugin, 'p376-lean')!;
      expect(node.visible).toBe(true);
      expect(markerVisible(node)).toBe(true);
    });

    it('rebuilds a virtual DES record as a gizmo', async () => {
      const { plugin } = await bootPlanner();

      await plugin.placeFromRecord(virtualRecord());

      const node = placedIn(plugin, 'p376-virtual');
      expect(node).toBeDefined();
      // §2.4 #9 — BEHAVIOR CHANGE (F7b): the shared helper carries the
      // virtual-DES branch, so a virtual record is no longer handed to
      // `getOrLoad('')`.
      expect(desMarker(node!)).toBeDefined();
      // war (pre-Phase2): undefined — no virtual branch on any restore path.
    });

    it('skips (and warns) when the splat plugin is unavailable', async () => {
      const { plugin } = await bootPlanner(); // no splat plugin injected

      await plugin.placeFromRecord(splatRecord());

      expect(placedIn(plugin, 'p376-splat')).toBeUndefined();
      expect(storeRecord(plugin, 'p376-splat')).toBeUndefined();
      expect(warnSpy).toHaveBeenCalled();
    });

    it('restores a splat placement when the plugin IS available', async () => {
      const { plugin, viewer } = await bootPlanner({ withSplatPlugin: true });

      await plugin.placeFromRecord(splatRecord());

      const node = placedIn(plugin, 'p376-splat');
      expect(node).toBeDefined();
      expect(viewer.splatPlugin!.loadedUrls).toEqual([SPLAT_URL]);
      expect(node!.position.toArray()).toEqual([5, 1, 6]);
      expect(node!.visible).toBe(false);
      expect(markerVisible(node!)).toBe(false);
      // The splat branch broadcasts the restored transform for loosely-coupled
      // subscribers (the splat plugin's own off-graph mesh).
      expect(viewer.emit).toHaveBeenCalledWith(
        'layout-transform-update',
        expect.objectContaining({ position: [5, 1, 6], rotation: [0, 45, 0] }),
      );
    });
  });

  // ── Restore path 2: applyPlacements → _restorePlacements ──────────────

  describe('_restorePlacements (applyPlacements / applyLayoutFile)', () => {
    it('applies position, rotation, scale, visible and marker sync', async () => {
      const { plugin } = await bootPlanner();
      const rec = fullRecord();

      await plugin.applyPlacements({ placements: [rec], catalogUrls: [], gridSizeMm: 100 });

      const node = placedIn(plugin, rec.id);
      expect(node).toBeDefined();
      expect(node!.position.toArray()).toEqual([1, 0.5, 2]);
      expect(node!.rotation.y).toBeCloseTo(MathUtils.degToRad(90), 6);
      expect(node!.scale.toArray()).toEqual([2, 2, 2]);
      expect(node!.visible).toBe(false);
      expect(markerVisible(node!)).toBe(false);
    });

    it('applies element bindings and bulk-writes the snapshot into the store', async () => {
      const { plugin } = await bootPlanner();
      const spy = vi.spyOn(internals(plugin), '_applyElementBindings');
      const rec = fullRecord();

      await plugin.applyPlacements({ placements: [rec], catalogUrls: [], gridSizeMm: 100 });

      expect(spy).toHaveBeenCalledWith(rec.id, expect.anything(), [MAPPING]);
      expect(storeRecord(plugin, rec.id)?.signalMappings).toEqual([MAPPING]);
    });

    it('isolates a failing item — the rest of the bulk restore still lands', async () => {
      const { plugin } = await bootPlanner(); // BROKEN_URL fails at the fetch mock

      await plugin.applyPlacements({
        placements: [
          leanRecord('p376-a'),
          leanRecord('p376-bad', BROKEN_URL),
          leanRecord('p376-b'),
        ],
        catalogUrls: [],
        gridSizeMm: 100,
      });

      expect(placedIn(plugin, 'p376-a')).toBeDefined();
      expect(placedIn(plugin, 'p376-b')).toBeDefined();
      expect(placedIn(plugin, 'p376-bad')).toBeUndefined();
    });

    it('skips a record whose url cannot be resolved', async () => {
      const { plugin } = await bootPlanner();

      // A dead blob: url with no catalog fallback → `resolvePlacementUrl` → null.
      const stale: PlacedComponent = {
        ...leanRecord('p376-stale'),
        catalogId: 'cat:gone',
        glbUrl: 'blob:rv-test/dead',
      };
      await plugin.applyPlacements({ placements: [stale], catalogUrls: [], gridSizeMm: 100 });

      expect(placedIn(plugin, 'p376-stale')).toBeUndefined();
      expect(warnSpy).toHaveBeenCalled();
    });

    it('restores a virtual DES record even though it has no url', async () => {
      const { plugin } = await bootPlanner();

      await plugin.applyPlacements({
        placements: [virtualRecord()],
        catalogUrls: [],
        gridSizeMm: 100,
      });

      // §2.4 #9 — BEHAVIOR CHANGE (F7c): `resolvePlacementUrl` still returns
      // null for a virtual record, but the `!url` guard now exempts virtual
      // catalog entries and lets them reach the helper. Without this a
      // duplicated virtual component disappeared on the next reload.
      const node = placedIn(plugin, 'p376-virtual');
      expect(node).toBeDefined();
      expect(desMarker(node!)).toBeDefined();
      // war (pre-Phase2): undefined — warn-and-skip before any placement ran.
    });

    it('notify count for a bulk restore does not grow with the item count', async () => {
      const measure = async (n: number): Promise<number> => {
        const fresh = await bootPlanner();
        let count = 0;
        const unsub = fresh.plugin.store.subscribe(() => { count++; });
        await fresh.plugin.applyPlacements({
          placements: Array.from({ length: n }, (_, i) => leanRecord(`p376-bulk-${i}`)),
          catalogUrls: [],
          gridSizeMm: 100,
        });
        unsub();
        return count;
      };

      const one = await measure(1);
      const five = await measure(5);

      // The bulk restore batches through a single `setComponents`; the per-item
      // `updateGlbUrl` fires only when the resolved url CHANGED, which it does
      // not here. So the count must be identical for 1 and for 5 items — that
      // is the NFR "load time must not rise" in its measurable form.
      expect(five).toBe(one);
    });
  });

  // ── Restore path 3: the legacy autosave loop in _loadCatalogs ─────────

  describe('_loadCatalogs legacy autosave restore (real boot path)', () => {
    it('restores position, rotation and scale', async () => {
      seedAutosave([fullRecord()]);
      const { plugin } = setupPlanner();
      await internals(plugin)._catalogsLoaded;
      await flush();

      const node = placedIn(plugin, 'p376-full');
      expect(node).toBeDefined();
      expect(node!.position.toArray()).toEqual([1, 0.5, 2]);
      expect(node!.rotation.y).toBeCloseTo(MathUtils.degToRad(90), 6);
      expect(node!.scale.toArray()).toEqual([2, 2, 2]);
    });

    it('respects visible === false and runs the marker sync', async () => {
      seedAutosave([fullRecord()]);
      const { plugin } = setupPlanner();
      await internals(plugin)._catalogsLoaded;
      await flush();

      const node = placedIn(plugin, 'p376-full')!;
      // §2.4 #1 — BEHAVIOR CHANGE (F4): the legacy loop honours the saved flag.
      expect(node.visible).toBe(false);
      // war (pre-Phase2): true — the field was ignored on this path entirely.

      // §2.4 #2 — BEHAVIOR CHANGE (F4): …and mirrors it into the Inspector marker.
      expect(markerVisible(node)).toBe(false);
      // war (pre-Phase2): undefined — `syncLayoutMarkerComponents` was never called.
    });

    it('applies element bindings', async () => {
      seedAutosave([fullRecord()]);
      const { plugin } = setupPlanner();
      const spy = vi.spyOn(internals(plugin), '_applyElementBindings');
      await internals(plugin)._catalogsLoaded;
      await flush();

      expect(spy).toHaveBeenCalledWith('p376-full', expect.anything(), [MAPPING]);
    });

    it('restores a splat record through the splat plugin', async () => {
      seedAutosave([splatRecord()]);
      const { plugin, viewer } = setupPlanner({ withSplatPlugin: true });
      await internals(plugin)._catalogsLoaded;
      await flush();

      // §2.4 #3 — BEHAVIOR CHANGE (F5): the legacy loop has a splat branch now.
      // Before this, a splat that only lived in the autosave (no accompanying
      // scene-op log) was lost on every reload.
      expect(viewer.splatPlugin!.loadedUrls).toEqual([SPLAT_URL]);
      expect(placedIn(plugin, 'p376-splat')?.userData._isSplat).toBe(true);
      // war (pre-Phase2): loadedUrls [] and `_isSplat` undefined — the record
      // fell into the GLB path and decoded its (empty) glbUrl instead.
    });

    it('isolates a failing item — the healthy one still lands', async () => {
      seedAutosave([leanRecord('p376-bad', BROKEN_URL), leanRecord('p376-good')]);
      const { plugin } = setupPlanner(); // BROKEN_URL fails at the fetch mock
      await internals(plugin)._catalogsLoaded;
      await flush();

      expect(placedIn(plugin, 'p376-bad')).toBeUndefined();
      expect(placedIn(plugin, 'p376-good')).toBeDefined();
    });
  });

  // ── Creation path 1: duplicateSelected ────────────────────────────────

  describe('duplicateSelected', () => {
    it('offsets by +0.5 on X/Z and keeps rotation and scale', async () => {
      const { plugin } = await bootPlanner();
      await plugin.placeFromRecord(fullRecord());
      plugin.store.selectComponent('p376-full');

      const newId = await plugin.duplicateSelected();

      expect(newId).not.toBeNull();
      const copy = storeRecord(plugin, newId!)!;
      expect(copy.position[0]).toBeCloseTo(1.5, 6);
      expect(copy.position[2]).toBeCloseTo(2.5, 6);
      expect(copy.rotation).toEqual([0, 90, 0]);
      expect(copy.scale).toEqual([2, 2, 2]);
      expect(copy.label).toBe('Belt (copy)');
    });

    it('carries signalMappings into the copy and re-applies the bindings', async () => {
      const { plugin } = await bootPlanner();
      await plugin.placeFromRecord(fullRecord());
      plugin.store.selectComponent('p376-full');
      const spy = vi.spyOn(internals(plugin), '_applyElementBindings');

      const newId = await plugin.duplicateSelected();

      // §2.4 #5 — BEHAVIOR CHANGE (F10): the copy inherits the bindings.
      expect(storeRecord(plugin, newId!)?.signalMappings).toEqual([MAPPING]);
      // war (pre-Phase3): undefined — the field was never copied.
      expect(spy).toHaveBeenCalledWith(newId, expect.anything(), [MAPPING]);
      // war (pre-Phase3): not called at all for the copy.
    });

    it('rebuilds a virtual DES component as a gizmo', async () => {
      const { plugin } = await bootPlanner();
      const id = await plugin.placeComponent(VIRTUAL_ENTRY, [0, 0, 0]);
      plugin.store.selectComponent(id);

      const newId = await plugin.duplicateSelected();

      expect(newId).not.toBeNull();
      // §2.4 #4 — BEHAVIOR CHANGE (F7): `duplicateSelected` inherits the
      // virtual-DES branch it never had, so the copy is a real DES gizmo
      // instead of a decode of the empty glbUrl.
      expect(desMarker(placedIn(plugin, newId!)!)).toBeDefined();
      // war (pre-Phase3): undefined.
    });

    it('does not select or autosave when the splat plugin is missing', async () => {
      const { plugin } = await bootPlanner(); // no splat plugin
      // Seed the splat record directly into the store — the scene node is
      // irrelevant for this path, only the record lookup matters.
      plugin.store.addComponent(splatRecord());
      plugin.store.selectComponent('p376-splat');
      const autoSave = vi.spyOn(plugin.store, 'autoSave');

      const newId = await plugin.duplicateSelected();

      expect(newId).toBeNull();
      expect(autoSave).not.toHaveBeenCalled();
      autoSave.mockRestore();
    });
  });

  // ── Creation path 2: pasteClipboard ───────────────────────────────────

  describe('pasteClipboard', () => {
    it('offsets by +0.5 on X/Z and keeps rotation and scale', async () => {
      const { plugin } = await bootPlanner();
      await plugin.placeFromRecord(fullRecord());
      plugin.store.selectComponent('p376-full');
      expect(plugin.copySelected()).toBe(1);

      const ids = await plugin.pasteClipboard();
      await flush();

      expect(ids.length).toBe(1);
      const copy = storeRecord(plugin, ids[0])!;
      expect(copy.position[0]).toBeCloseTo(1.5, 6);
      expect(copy.position[2]).toBeCloseTo(2.5, 6);
      expect(copy.rotation).toEqual([0, 90, 0]);
      expect(copy.scale).toEqual([2, 2, 2]);
      expect(copy.label).toBe('Belt (copy)');
    });

    it('carries signalMappings into the pasted record and re-applies the bindings', async () => {
      const { plugin } = await bootPlanner();
      await plugin.placeFromRecord(fullRecord());
      plugin.store.selectComponent('p376-full');
      plugin.copySelected();
      const spy = vi.spyOn(internals(plugin), '_applyElementBindings');

      const ids = await plugin.pasteClipboard();
      await flush();

      // §2.4 #5 — BEHAVIOR CHANGE (F10): paste keeps the bindings too.
      expect(storeRecord(plugin, ids[0])?.signalMappings).toEqual([MAPPING]);
      // war (pre-Phase3): undefined.
      expect(spy).toHaveBeenCalledWith(ids[0], expect.anything(), [MAPPING]);
      // war (pre-Phase3): not called at all for the pasted item.
    });

    it('pastes a virtual DES component (this path already has the branch)', async () => {
      const { plugin } = await bootPlanner();
      const id = await plugin.placeComponent(VIRTUAL_ENTRY, [0, 0, 0]);
      plugin.store.selectComponent(id);
      plugin.copySelected();

      const ids = await plugin.pasteClipboard();
      await flush();

      expect(ids.length).toBe(1);
      expect(desMarker(placedIn(plugin, ids[0])!)).toBeDefined();
    });

    it('skips a splat entry when the plugin is missing and returns no ids', async () => {
      const { plugin } = await bootPlanner(); // no splat plugin
      plugin.store.addComponent(splatRecord());
      plugin.store.selectComponent('p376-splat');
      plugin.copySelected();

      const ids = await plugin.pasteClipboard();

      expect(ids).toEqual([]);
    });
  });
});
