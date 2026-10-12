// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-477 Phase 0 — `scriptRef` resolution is project-bound (F15, E8).
 *
 * The measurement comes first. Every private project binds its code with the
 * SAME reference — `plugins/index.ts` — because that is the only entry the
 * discovery glob loads (`rv-model-plugin-manager.ts`, `privatePluginModuleImporters`).
 * So the reference alone cannot name a module: it names one per project. The
 * first describe pins what that used to mean (first importer in iteration order
 * wins, whichever project it belongs to); the rest pin the fix.
 *
 * Node, not browser: this is manager logic with no DOM in it. `localStorage` is
 * the one browser global the manager path touches (persisted panel state,
 * visual settings), so it is stubbed in-memory below.
 */

import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import {
  ModelPluginManager,
  discoveredPluginModulePaths,
  type ModelPluginModule,
} from '../src/core/rv-model-plugin-manager';
import type { RVViewer } from '../src/core/rv-viewer';

// ─── Node has no localStorage; the manager path reads it through try/catch,
//     but `applyEnvironmentPreset` writes unguarded. In-memory stub. ────────

beforeAll(() => {
  if (typeof (globalThis as { localStorage?: unknown }).localStorage === 'undefined') {
    const store = new Map<string, string>();
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => { store.set(k, String(v)); },
      removeItem: (k: string) => { store.delete(k); },
      clear: () => { store.clear(); },
      key: (i: number) => [...store.keys()][i] ?? null,
      get length() { return store.size; },
    };
  }
});

// ─── Fixtures ───────────────────────────────────────────────────────────

interface SpyModule extends ModelPluginModule {
  registered: number;
  unregistered: number;
}

function spyModule(): SpyModule {
  const mod: SpyModule = {
    registered: 0,
    unregistered: 0,
    registerModelPlugins: () => { mod.registered += 1; },
    unregisterModelPlugins: () => { mod.unregistered += 1; },
  };
  return mod;
}

function fakeViewer(): RVViewer & { pendingModelUrl: string | null } {
  return {
    pendingModelUrl: null,
    projectAssetsPath: import.meta.env.BASE_URL,
    withDefaultOrigin: (_origin: string, fn: () => void) => fn(),
  } as unknown as RVViewer & { pendingModelUrl: string | null };
}

const PRIVATE_ROOT = '../../../realvirtual-WebViewer-Private~/projects';

/**
 * The inventory: three projects, one reference. Insertion order is the order
 * `Object.entries` yields, and therefore the order the old resolver scanned.
 */
function threeProjectInventory() {
  const toray = spyModule();
  const mauser = spyModule();
  const development = spyModule();
  const importedPaths: string[] = [];
  const importers: Record<string, () => Promise<ModelPluginModule>> = {
    [PRIVATE_ROOT + '/Toray/plugins/index.ts']: () => {
      importedPaths.push('Toray'); return Promise.resolve(toray);
    },
    [PRIVATE_ROOT + '/mauser3dhmi/plugins/index.ts']: () => {
      importedPaths.push('mauser3dhmi'); return Promise.resolve(mauser);
    },
    [PRIVATE_ROOT + '/Development/plugins/index.ts']: () => {
      importedPaths.push('Development'); return Promise.resolve(development);
    },
  };
  return { toray, mauser, development, importers, importedPaths };
}

const SCRIPT_REF = 'plugins/index.ts';

beforeEach(() => { localStorage.clear(); });

// ─── Characterization: what the reference alone resolves to ─────────────

describe('characterization — a reference three projects share', () => {
  it('all three projects carry the identical scriptRef', () => {
    const { importers } = threeProjectInventory();
    for (const path of Object.keys(importers)) {
      expect(path.endsWith('/' + SCRIPT_REF)).toBe(true);
    }
  });

  it('without a project folder the FIRST matching importer wins, whatever project it is', async () => {
    const inv = threeProjectInventory();
    const mgr = new ModelPluginManager({
      importers: inv.importers,
      scriptRefProvider: () => SCRIPT_REF,
      // No projectFolderProvider — this is the shape the resolver had before.
    });
    await mgr.onModelLoading('/private-models/Development/models/DemoRibbonTension.glb', fakeViewer());

    expect(inv.toray.registered).toBe(1);
    expect(inv.development.registered).toBe(0);
    expect(inv.importedPaths).toEqual(['Toray']);
  });
});

// ─── The fix: the open project decides ──────────────────────────────────

describe('project-bound resolution', () => {
  it('binds the module of the OPEN project, not the first match', async () => {
    const inv = threeProjectInventory();
    const viewer = fakeViewer();
    const mgr = new ModelPluginManager({
      importers: inv.importers,
      scriptRefProvider: () => SCRIPT_REF,
      projectFolderProvider: () => 'Development',
    });
    await mgr.onModelLoading('/private-models/Development/models/DemoRibbonTension.glb', viewer);

    expect(inv.development.registered).toBe(1);
    expect(inv.toray.registered).toBe(0);
    expect(inv.mauser.registered).toBe(0);
    expect(inv.importedPaths).toEqual(['Development']);
    expect(viewer.projectAssetsPath).toBe('/private-assets/Development/');
  });

  it('ignores a foreign module with the same suffix — an unreferenced project contributes nothing', async () => {
    const inv = threeProjectInventory();
    const mgr = new ModelPluginManager({
      importers: inv.importers,
      scriptRefProvider: () => SCRIPT_REF,
      projectFolderProvider: () => 'wmyb', // a real project, absent from this inventory
    });
    await mgr.onModelLoading('/private-models/wmyb/models/Anything.glb', fakeViewer());

    expect(inv.toray.registered).toBe(0);
    expect(inv.mauser.registered).toBe(0);
    expect(inv.development.registered).toBe(0);
    expect(inv.importedPaths).toEqual([]);
  });

  it('falls back to the old first-match when no project folder is known', async () => {
    const inv = threeProjectInventory();
    const mgr = new ModelPluginManager({
      importers: inv.importers,
      scriptRefProvider: () => SCRIPT_REF,
      projectFolderProvider: () => null,
    });
    await mgr.onModelLoading('/models/Whatever.glb', fakeViewer());

    expect(inv.toray.registered).toBe(1);
    expect(inv.importedPaths).toEqual(['Toray']);
  });

  it('matches the folder case-insensitively — canonicalName and folder legitimately differ in case', async () => {
    const inv = threeProjectInventory();
    const mgr = new ModelPluginManager({
      importers: inv.importers,
      scriptRefProvider: () => SCRIPT_REF,
      projectFolderProvider: () => 'toray', // canonicalName; the folder is `Toray`
    });
    await mgr.onModelLoading('/private-models/Toray/models/Toray.glb', fakeViewer());

    expect(inv.toray.registered).toBe(1);
    expect(inv.development.registered).toBe(0);
  });

  it('a reference that resolves to nothing yields no plugins — never a name fallback', async () => {
    const inv = threeProjectInventory();
    const mgr = new ModelPluginManager({
      importers: inv.importers,
      scriptRefProvider: () => 'plugins/does-not-exist.ts',
      projectFolderProvider: () => 'Development',
    });
    await mgr.onModelLoading('/private-models/Development/models/DemoRibbonTension.glb', fakeViewer());

    expect(inv.development.registered).toBe(0);
    expect(inv.importedPaths).toEqual([]);
  });

  it('caches per project — switching projects re-resolves, in both directions', async () => {
    const inv = threeProjectInventory();
    let folder = 'Development';
    const mgr = new ModelPluginManager({
      importers: inv.importers,
      scriptRefProvider: () => SCRIPT_REF,
      projectFolderProvider: () => folder,
    });

    await mgr.onModelLoading('/private-models/Development/models/DemoRibbonTension.glb', fakeViewer());
    expect(inv.development.registered).toBe(1);

    folder = 'Toray';
    await mgr.onModelLoading('/private-models/Toray/models/Toray.glb', fakeViewer());
    expect(inv.development.unregistered).toBe(1);
    expect(inv.toray.registered).toBe(1);

    folder = 'Development';
    await mgr.onModelLoading('/private-models/Development/models/DemoRibbonTension.glb', fakeViewer());
    expect(inv.toray.unregistered).toBe(1);
    expect(inv.development.registered).toBe(2);

    // Each module was imported exactly once; the per-project cache key held.
    expect(inv.importedPaths).toEqual(['Development', 'Toray']);
  });
});

// ─── plan-479 Phase 3: the reference may name the file itself ───────────

describe('plan-479 F5 — a document points at its OWN script, not at an aggregator', () => {
  /**
   * The inventory the opened glob produces: the project's collecting
   * `index.ts` NEXT TO its individual plugin files and a helper that is no
   * plugin at all. Before Phase 3 only the first of these was discoverable.
   */
  function openGlobInventory() {
    const aggregate = spyModule();
    const ribbon = spyModule();
    const deep = spyModule();
    const importedPaths: string[] = [];
    const importers: Record<string, () => Promise<ModelPluginModule>> = {
      [PRIVATE_ROOT + '/Development/plugins/index.ts']: () => {
        importedPaths.push('index'); return Promise.resolve(aggregate);
      },
      [PRIVATE_ROOT + '/Development/plugins/ribbon-tension-controls-plugin.tsx']: () => {
        importedPaths.push('ribbon'); return Promise.resolve(ribbon);
      },
      [PRIVATE_ROOT + '/Development/plugins/hmi/deep/panel.tsx']: () => {
        importedPaths.push('deep'); return Promise.resolve(deep);
      },
      [PRIVATE_ROOT + '/Development/plugins/tension-math.ts']: () => {
        importedPaths.push('helper');
        return Promise.resolve({} as unknown as ModelPluginModule);
      },
      // The same FILE NAME in a second project — the case the reference tail
      // alone cannot tell apart, and the reason `projectFolder` exists.
      [PRIVATE_ROOT + '/Toray/plugins/ribbon-tension-controls-plugin.tsx']: () => {
        importedPaths.push('toray-ribbon');
        return Promise.resolve(spyModule());
      },
    };
    return { aggregate, ribbon, deep, importers, importedPaths };
  }

  it('binds a plugin file directly, without going through plugins/index.ts', async () => {
    const inv = openGlobInventory();
    const mgr = new ModelPluginManager({
      importers: inv.importers,
      scriptRefProvider: () => 'plugins/ribbon-tension-controls-plugin.tsx',
      projectFolderProvider: () => 'Development',
    });
    await mgr.onModelLoading('/private-models/Development/DemoRibbonTension.glb', fakeViewer());

    expect(inv.ribbon.registered).toBe(1);
    // The aggregator is not loaded at all — the point of F5: the second
    // document with its own script costs no edit in a collecting index.
    expect(inv.aggregate.registered).toBe(0);
    expect(inv.importedPaths).toEqual(['ribbon']);
  });

  it('resolves a reference several folders deep', async () => {
    const inv = openGlobInventory();
    const mgr = new ModelPluginManager({
      importers: inv.importers,
      scriptRefProvider: () => 'plugins/hmi/deep/panel.tsx',
      projectFolderProvider: () => 'Development',
    });
    await mgr.onModelLoading('/private-models/Development/Deep.glb', fakeViewer());

    expect(inv.deep.registered).toBe(1);
    expect(inv.importedPaths).toEqual(['deep']);
  });

  it('still picks the OPEN project when two projects hold the same file name', async () => {
    const inv = openGlobInventory();
    const mgr = new ModelPluginManager({
      importers: inv.importers,
      scriptRefProvider: () => 'plugins/ribbon-tension-controls-plugin.tsx',
      projectFolderProvider: () => 'Toray',
    });
    await mgr.onModelLoading('/private-models/Toray/Winder.glb', fakeViewer());

    expect(inv.ribbon.registered).toBe(0);
    expect(inv.importedPaths).toEqual(['toray-ribbon']);
  });

  it('a reference to a NON-plugin file loads nothing and breaks nothing', async () => {
    // The case the opened glob makes reachable and F4 exists to warn about:
    // the file is in the build, it imports fine, and it has no pair to call.
    const inv = openGlobInventory();
    const mgr = new ModelPluginManager({
      importers: inv.importers,
      scriptRefProvider: () => 'plugins/tension-math.ts',
      projectFolderProvider: () => 'Development',
    });

    await expect(
      mgr.onModelLoading('/private-models/Development/Whatever.glb', fakeViewer()),
    ).resolves.toBeUndefined();

    expect(inv.importedPaths).toEqual(['helper']);
    expect(inv.aggregate.registered).toBe(0);
  });

  it('the tail stays case-SENSITIVE (K3) — a case-only difference is a dead ref', async () => {
    const inv = openGlobInventory();
    const mgr = new ModelPluginManager({
      importers: inv.importers,
      scriptRefProvider: () => 'plugins/Ribbon-Tension-Controls-Plugin.tsx',
      projectFolderProvider: () => 'Development',
    });
    await mgr.onModelLoading('/private-models/Development/DemoRibbonTension.glb', fakeViewer());

    expect(inv.ribbon.registered).toBe(0);
    expect(inv.importedPaths).toEqual([]);
  });
});

describe('plan-479 Finding T6 — the guard rule against the REAL glob', () => {
  it('discovers only paths under a plugins/ folder', () => {
    // Whatever this checkout holds, the opened glob must not have reached
    // outside `plugins/` — the classification the drag offers and the
    // classification the build performs have to describe the same set.
    for (const path of discoveredPluginModulePaths()) {
      expect(path.replace(/\\/g, '/')).toMatch(/\/plugins\//);
      expect(path).toMatch(/\.tsx?$/);
    }
  });
});
