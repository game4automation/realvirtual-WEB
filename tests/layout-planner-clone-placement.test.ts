// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-376 F6/F7/F10 — the "new id, same content, small offset" contract.
 *
 * `duplicateSelected` and `pasteClipboard` each carry their own copy of it:
 * fresh UUID, `' (copy)'` label, splat-vs-virtual-vs-GLB routing, +0.5 m on
 * X/Z, a re-drop when drop-to-surface is on, the new `PlacedComponent` literal,
 * `store.addComponent` and the op-log emit. Phase 3 folds both into
 * `_clonePlacement`, so this file pins the contract at the two PUBLIC entry
 * points — the only place it can be observed before AND after the change.
 *
 * The two paths already disagree today, and the disagreement is the point:
 * `pasteClipboard` has a virtual-DES branch, `duplicateSelected` does not
 * (F7), and NEITHER carries `signalMappings` across (F10). Assertions that
 * flip in Phase 3 carry a `// §2.4 #N — BEHAVIOR CHANGE (Fx)` marker and keep
 * the old expectation as a `// war (pre-Phase3): …` comment.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Object3D } from 'three';

import {
  setupPlanner,
  internals,
  flush,
  addElevatedSurface,
  TINY_PNG,
} from './_layout-planner-async-harness';
import type { LayoutPlannerPlugin } from '../src/plugins/layout-planner';
import type {
  LibraryCatalogEntry,
  PlacedComponent,
  SignalMapping,
} from '../src/plugins/layout-planner/rv-layout-store';

const STABLE_URL = 'https://rv-test.invalid/plan376-clone.glb';
const SPLAT_URL = 'https://rv-test.invalid/plan376-clone.ply';
const CATALOG_URL = 'test://plan376-clone';
const AUTOSAVE_KEY = 'rv-layout-autosave';
const DES_TYPE = 'UnregisteredTestType';

const GLB_ENTRY: LibraryCatalogEntry = {
  id: 'cat:clone-belt',
  name: 'Belt',
  category: 'conveyor',
  glbUrl: STABLE_URL,
  thumbnailUrl: TINY_PNG,
  footprintMm: [1200, 400],
};

const SPLAT_ENTRY: LibraryCatalogEntry = {
  id: 'cat:clone-splat',
  name: 'Cloud',
  category: 'splat',
  splatUrl: SPLAT_URL,
};

const VIRTUAL_ENTRY: LibraryCatalogEntry = {
  id: 'cat:clone-virtual',
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

function splatRecord(id: string): PlacedComponent {
  return {
    id,
    catalogId: SPLAT_ENTRY.id,
    glbUrl: '',
    splatUrl: SPLAT_URL,
    label: 'Cloud',
    position: [5, 1, 6],
    rotation: [0, 45, 0],
    scale: [1, 1, 1],
  };
}

/** Boot a planner and wait out `_loadCatalogs` — see the note in
 *  `layout-planner-placement-parity.test.ts`: an un-awaited boot writes the
 *  autosave key into the NEXT test. */
async function bootPlanner(opts?: Parameters<typeof setupPlanner>[0]) {
  const harness = setupPlanner(opts);
  harness.plugin.store.addCatalogDirect(CATALOG_URL, {
    version: '1.0',
    name: 'plan376-clone',
    entries: [GLB_ENTRY, SPLAT_ENTRY, VIRTUAL_ENTRY],
  });
  await internals(harness.plugin)._catalogsLoaded;
  await flush();
  return harness;
}

function rvExtras(node: Object3D): Record<string, Record<string, unknown>> | undefined {
  return node.userData.realvirtual as Record<string, Record<string, unknown>> | undefined;
}

/** Written ONLY by the virtual-DES branch. */
function desMarker(node: Object3D): unknown {
  return rvExtras(node)?.[DES_TYPE];
}

function storeRecord(plugin: LayoutPlannerPlugin, id: string): PlacedComponent | undefined {
  return plugin.store.getSnapshot().placed.find(c => c.id === id);
}

describe('plan-376 — duplicate / paste clone contract', () => {
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

  // ── Shared clone contract, asserted at both entry points ──────────────

  describe('GLB branch', () => {
    it('duplicateSelected gives a fresh id, a "(copy)" label and a +0.5 X/Z offset', async () => {
      const { plugin } = await bootPlanner();
      const srcId = await plugin.placeComponent(GLB_ENTRY, [2, 0, 3]);
      plugin.store.selectComponent(srcId);

      const newId = await plugin.duplicateSelected();

      expect(newId).not.toBeNull();
      expect(newId).not.toBe(srcId);
      const src = storeRecord(plugin, srcId)!;
      const copy = storeRecord(plugin, newId!)!;
      expect(copy.label).toBe(`${src.label} (copy)`);
      expect(copy.catalogId).toBe(src.catalogId);
      expect(copy.glbUrl).toBe(src.glbUrl);
      expect(copy.position[0]).toBeCloseTo(src.position[0] + 0.5, 6);
      expect(copy.position[2]).toBeCloseTo(src.position[2] + 0.5, 6);
    });

    it('pasteClipboard produces the identical clone shape', async () => {
      const { plugin } = await bootPlanner();
      const srcId = await plugin.placeComponent(GLB_ENTRY, [2, 0, 3]);
      plugin.store.selectComponent(srcId);
      plugin.copySelected();

      const ids = await plugin.pasteClipboard();
      await flush();

      expect(ids.length).toBe(1);
      expect(ids[0]).not.toBe(srcId);
      const src = storeRecord(plugin, srcId)!;
      const copy = storeRecord(plugin, ids[0])!;
      expect(copy.label).toBe(`${src.label} (copy)`);
      expect(copy.position[0]).toBeCloseTo(src.position[0] + 0.5, 6);
      expect(copy.position[2]).toBeCloseTo(src.position[2] + 0.5, 6);
    });

    it('re-drops the copy onto an elevated surface when drop-to-surface is on', async () => {
      const { plugin, viewer } = await bootPlanner();
      // The harness pins dropToSurface = true.
      addElevatedSurface(viewer, { y: 2 });
      const srcId = await plugin.placeComponent(GLB_ENTRY, [0, 0, 0]);
      plugin.store.selectComponent(srcId);

      const newId = await plugin.duplicateSelected();

      // The copy is moved to (+0.5, ?, +0.5) FIRST and re-dropped afterwards,
      // so it must land on the platform rather than keep the source's Y.
      expect(storeRecord(plugin, newId!)!.position[1]).toBeGreaterThan(1.9);
    });

    it('pastes every clipboard entry and selects them all', async () => {
      const { plugin, viewer } = await bootPlanner();
      const a = await plugin.placeComponent(GLB_ENTRY, [0, 0, 0]);
      const b = await plugin.placeComponent(GLB_ENTRY, [4, 0, 0]);
      viewer.selectionManager.selectPaths([
        viewer.registry.getPathForNode(internals(plugin)._objectMap.get(a)!)!,
        viewer.registry.getPathForNode(internals(plugin)._objectMap.get(b)!)!,
      ]);
      expect(plugin.copySelected()).toBe(2);

      const ids = await plugin.pasteClipboard();
      await flush();

      expect(ids.length).toBe(2);
      expect(new Set(ids).size).toBe(2);
      expect(viewer.selectionManager.getSnapshot().selectedPaths.length).toBe(2);
    });
  });

  // ── Splat branch ──────────────────────────────────────────────────────

  describe('splat branch', () => {
    it('duplicateSelected loads a second splat instance and keeps splatUrl', async () => {
      const { plugin, viewer } = await bootPlanner({ withSplatPlugin: true });
      const srcId = await plugin.placeComponent(SPLAT_ENTRY, [0, 0, 0]);
      plugin.store.selectComponent(srcId);

      const newId = await plugin.duplicateSelected();

      expect(newId).not.toBeNull();
      expect(viewer.splatPlugin!.loadedUrls).toEqual([SPLAT_URL, SPLAT_URL]);
      expect(storeRecord(plugin, newId!)?.splatUrl).toBe(SPLAT_URL);
      expect(internals(plugin)._objectMap.get(newId!)!.userData._isSplat).toBe(true);
    });

    it('duplicateSelected bails out — no autosave, no re-selection — without the plugin', async () => {
      const { plugin, viewer } = await bootPlanner(); // no splat plugin
      plugin.store.addComponent(splatRecord('p376-clone-splat'));
      plugin.store.selectComponent('p376-clone-splat');
      const autoSave = vi.spyOn(plugin.store, 'autoSave');
      (viewer.selectionManager.select as ReturnType<typeof vi.fn>).mockClear();

      const newId = await plugin.duplicateSelected();

      expect(newId).toBeNull();
      expect(autoSave).not.toHaveBeenCalled();
      expect(viewer.selectionManager.select).not.toHaveBeenCalled();
      autoSave.mockRestore();
    });

    it('pasteClipboard skips the splat entry without the plugin', async () => {
      const { plugin } = await bootPlanner(); // no splat plugin
      plugin.store.addComponent(splatRecord('p376-clone-splat'));
      plugin.store.selectComponent('p376-clone-splat');
      plugin.copySelected();

      expect(await plugin.pasteClipboard()).toEqual([]);
    });
  });

  // ── Virtual DES branch — the F7 asymmetry ─────────────────────────────

  describe('virtual DES branch', () => {
    it('pasteClipboard rebuilds the DES gizmo (branch already present)', async () => {
      const { plugin } = await bootPlanner();
      const srcId = await plugin.placeComponent(VIRTUAL_ENTRY, [0, 0, 0]);
      plugin.store.selectComponent(srcId);
      plugin.copySelected();

      const ids = await plugin.pasteClipboard();
      await flush();

      expect(ids.length).toBe(1);
      expect(desMarker(internals(plugin)._objectMap.get(ids[0])!)).toBeDefined();
    });

    it('duplicateSelected rebuilds it the same way', async () => {
      const { plugin } = await bootPlanner();
      const srcId = await plugin.placeComponent(VIRTUAL_ENTRY, [0, 0, 0]);
      plugin.store.selectComponent(srcId);

      const newId = await plugin.duplicateSelected();

      // §2.4 #4 — BEHAVIOR CHANGE (F7): both creation paths now share the same
      // virtual-DES branch. Before, `duplicateSelected` handed the empty glbUrl
      // to the model cache — a broken load in a browser, and here a bogus but
      // silent one, which is why this asserts the marker rather than a throw.
      expect(desMarker(internals(plugin)._objectMap.get(newId!)!)).toBeDefined();
      // war (pre-Phase3): undefined.
    });
  });

  // ── signalMappings — the F10 gap on BOTH paths ────────────────────────

  describe('signalMappings', () => {
    it('duplicateSelected carries them over and re-applies the bindings', async () => {
      const { plugin } = await bootPlanner();
      const srcId = await plugin.placeComponent(GLB_ENTRY, [0, 0, 0]);
      plugin.store.updateSignalMappings(srcId, [{ ...MAPPING }]);
      plugin.store.selectComponent(srcId);
      const spy = vi.spyOn(internals(plugin), '_applyElementBindings');

      const newId = await plugin.duplicateSelected();

      // §2.4 #5 — BEHAVIOR CHANGE (F10)
      expect(storeRecord(plugin, newId!)?.signalMappings).toEqual([MAPPING]);
      // war (pre-Phase3): undefined.
      expect(spy).toHaveBeenCalledWith(newId, expect.anything(), [MAPPING]);
      // war (pre-Phase3): not called at all.
    });

    it('copies the mappings rather than sharing them with the source', async () => {
      const { plugin } = await bootPlanner();
      const srcId = await plugin.placeComponent(GLB_ENTRY, [0, 0, 0]);
      plugin.store.updateSignalMappings(srcId, [{ ...MAPPING }]);
      plugin.store.selectComponent(srcId);

      const newId = await plugin.duplicateSelected();

      const src = storeRecord(plugin, srcId)!.signalMappings!;
      const copy = storeRecord(plugin, newId!)!.signalMappings!;
      expect(copy).toEqual(src);
      expect(copy[0]).not.toBe(src[0]);
    });

    it('pasteClipboard carries them over and re-applies the bindings', async () => {
      const { plugin } = await bootPlanner();
      const srcId = await plugin.placeComponent(GLB_ENTRY, [0, 0, 0]);
      plugin.store.updateSignalMappings(srcId, [{ ...MAPPING }]);
      plugin.store.selectComponent(srcId);
      plugin.copySelected();
      const spy = vi.spyOn(internals(plugin), '_applyElementBindings');

      const ids = await plugin.pasteClipboard();
      await flush();

      // §2.4 #5 — BEHAVIOR CHANGE (F10)
      expect(storeRecord(plugin, ids[0])?.signalMappings).toEqual([MAPPING]);
      // war (pre-Phase3): undefined.
      expect(spy).toHaveBeenCalledWith(ids[0], expect.anything(), [MAPPING]);
      // war (pre-Phase3): not called at all.
    });
  });

  // ── The `_clonePlacement` helper itself (plan-376 Phase 3) ────────────

  describe('_clonePlacement', () => {
    it('is the single routine behind both entry points', async () => {
      const { plugin } = await bootPlanner();
      const srcId = await plugin.placeComponent(GLB_ENTRY, [1, 0, 1]);
      plugin.store.selectComponent(srcId);
      plugin.copySelected();
      const spy = vi.spyOn(internals(plugin), '_clonePlacement');

      await plugin.duplicateSelected();
      await plugin.pasteClipboard();
      await flush();

      expect(spy).toHaveBeenCalledTimes(2);
    });

    it('returns null (and writes nothing) for a record with neither url nor virtual entry', async () => {
      const { plugin } = await bootPlanner();
      const orphan: PlacedComponent = {
        id: 'p376-orphan',
        catalogId: 'cat:gone',
        glbUrl: '',
        label: 'Orphan',
        position: [0, 0, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
      };
      const before = plugin.store.getSnapshot().placed.length;

      expect(await internals(plugin)._clonePlacement(orphan)).toBeNull();
      expect(plugin.store.getSnapshot().placed.length).toBe(before);
      expect(warnSpy).toHaveBeenCalled();
    });
  });
});
