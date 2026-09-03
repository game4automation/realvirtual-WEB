// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * §9.8 — `ModelPluginManager`, first direct coverage (plan-718 stage 2.2).
 *
 * This file was written BEFORE the `scriptRef` rewrite and against the behaviour
 * as it stood, for one reason: the plan promises that the
 * `__RV_HAS_PRIVATE__` gate and the planner-suppression state machine are
 * "untouched", and without a baseline that claim is not checkable — it is a
 * hope. The first four describes are that baseline; the last two are the new
 * binding.
 *
 * The importers are injected rather than globbed. `import.meta.glob` resolves to
 * whatever happens to be on the machine, so a test that used the real set would
 * assert a different thing in a public-only checkout than in a full one.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  ModelPluginManager,
  discoveredPluginModulePaths,
  moduleMatchesScriptRef,
  normalizeScriptRef,
  resolveModelName,
  type ModelPluginModule,
} from '../src/core/rv-model-plugin-manager';
import { setContext, _resetStore } from '../src/core/hmi/ui-context-store';
import type { RVViewer } from '../src/core/rv-viewer';

// ─── Fixtures ───────────────────────────────────────────────────────────

interface SpyModule extends ModelPluginModule {
  registered: string[];
  unregistered: string[];
}

function moduleWith(models?: string[]): SpyModule {
  const mod: SpyModule = {
    registered: [],
    unregistered: [],
    registerModelPlugins: () => { mod.registered.push('x'); },
    unregisterModelPlugins: () => { mod.unregistered.push('x'); },
  };
  if (models) mod.models = models;
  return mod;
}

/** Everything the manager touches on a viewer, and nothing more. */
function fakeViewer(): RVViewer & { pendingModelUrl: string | null } {
  return {
    pendingModelUrl: null,
    // The production default. The manager only fills in a dev assets path when
    // settings.json has not already provided a project-specific one, and this is
    // what "has not" looks like.
    projectAssetsPath: import.meta.env.BASE_URL,
    withDefaultOrigin: (_origin: string, fn: () => void) => fn(),
  } as unknown as RVViewer & { pendingModelUrl: string | null };
}

let imports: string[] = [];

/** An importer set that records every import, so double-loading is visible. */
function importers(modules: Record<string, SpyModule>) {
  const out: Record<string, () => Promise<ModelPluginModule>> = {};
  for (const [path, mod] of Object.entries(modules)) {
    out[path] = () => { imports.push(path); return Promise.resolve(mod); };
  }
  return out;
}

beforeEach(() => { imports = []; localStorage.clear(); });
afterEach(() => { setContext('planner', false); _resetStore(); localStorage.clear(); });

// ─── Baseline: the legacy name-based binding ────────────────────────────

describe('baseline — fast path (folder/project name)', () => {
  it('binds a public module whose folder name equals the model name', async () => {
    const mod = moduleWith();
    const mgr = new ModelPluginManager({
      importers: importers({ '/src/plugins/models/Toray/index.ts': mod }),
    });
    await mgr.onModelLoading('/models/Toray.glb', fakeViewer());
    expect(mod.registered).toHaveLength(1);
  });

  it('binds a private project module through the folder before "plugins"', async () => {
    const mod = moduleWith();
    const viewer = fakeViewer();
    const mgr = new ModelPluginManager({
      importers: importers({
        '../../../realvirtual-WebViewer-Private~/projects/Toray/plugins/index.ts': mod,
      }),
    });
    await mgr.onModelLoading('/models/Toray.glb', viewer);
    expect(mod.registered).toHaveLength(1);
    // The private path also sets the dev assets path, keyed off the project folder.
    expect(viewer.projectAssetsPath).toBe('/private-assets/Toray/');
  });

  it('is case-SENSITIVE — K3, and deliberately so', async () => {
    const mod = moduleWith();
    const mgr = new ModelPluginManager({
      importers: importers({ '/src/plugins/models/Toray/index.ts': mod }),
    });
    await mgr.onModelLoading('/models/toray.glb', fakeViewer());
    expect(mod.registered).toHaveLength(0);
  });
});

describe('baseline — slow path (models[] declaration)', () => {
  it('binds through a declared model name the folder does not carry', async () => {
    const mod = moduleWith(['Line1', 'Line2']);
    const mgr = new ModelPluginManager({
      importers: importers({ '/src/plugins/models/DiscreteEventSimulation/index.ts': mod }),
    });
    await mgr.onModelLoading('/models/Line1.glb', fakeViewer());
    expect(mod.registered).toHaveLength(1);
  });

  it('caches the module for every name it declares — one import, not two', async () => {
    const mod = moduleWith(['Line1', 'Line2']);
    const path = '/src/plugins/models/DiscreteEventSimulation/index.ts';
    const mgr = new ModelPluginManager({ importers: importers({ [path]: mod }) });
    const viewer = fakeViewer();
    await mgr.onModelLoading('/models/Line1.glb', viewer);
    await mgr.onModelLoading('/models/Line2.glb', viewer);
    expect(imports.filter(p => p === path)).toHaveLength(1);
    expect(mod.registered).toHaveLength(2);
    expect(mod.unregistered).toHaveLength(1); // Line1 unloaded before Line2 loaded
  });

  it('leaves an unknown model without plugins, and does not throw', async () => {
    const mod = moduleWith(['Line1']);
    const mgr = new ModelPluginManager({
      importers: importers({ '/src/plugins/models/Whatever/index.ts': mod }),
    });
    await mgr.onModelLoading('/models/Nothing.glb', fakeViewer());
    expect(mod.registered).toHaveLength(0);
  });
});

describe('baseline — the __RV_HAS_PRIVATE__ gate', () => {
  it('never discovers a private project module in a public build', () => {
    const paths = discoveredPluginModulePaths();
    if (__RV_HAS_PRIVATE__) {
      // Nothing to assert about content — this machine legitimately has them.
      expect(Array.isArray(paths)).toBe(true);
    } else {
      expect(paths.filter(p => p.includes('/projects/'))).toEqual([]);
    }
  });
});

describe('baseline — planner suppression', () => {
  it('resolves the module but defers registration while the planner is active', async () => {
    const mod = moduleWith();
    const mgr = new ModelPluginManager({
      importers: importers({ '/src/plugins/models/Toray/index.ts': mod }),
    });
    setContext('planner', true);
    await mgr.onModelLoading('/models/Toray.glb', fakeViewer());
    expect(imports).toHaveLength(1);      // resolved …
    expect(mod.registered).toHaveLength(0); // … but not registered
  });

  it('registers the deferred module when the planner closes, and pulls it on re-entry', async () => {
    const mod = moduleWith();
    const mgr = new ModelPluginManager({
      importers: importers({ '/src/plugins/models/Toray/index.ts': mod }),
    });
    setContext('planner', true);
    await mgr.onModelLoading('/models/Toray.glb', fakeViewer());

    setContext('planner', false);
    expect(mod.registered).toHaveLength(1);
    setContext('planner', true);
    expect(mod.unregistered).toHaveLength(1);
  });

  it('does not unregister a module that was never registered', async () => {
    const mod = moduleWith();
    const mgr = new ModelPluginManager({
      importers: importers({
        '/src/plugins/models/Toray/index.ts': mod,
        '/src/plugins/models/Other/index.ts': moduleWith(),
      }),
    });
    setContext('planner', true);
    const viewer = fakeViewer();
    await mgr.onModelLoading('/models/Toray.glb', viewer);
    await mgr.onModelLoading('/models/Other.glb', viewer);
    expect(mod.unregistered).toHaveLength(0);
  });
});

// ─── The new binding: scriptRef ─────────────────────────────────────────

describe('scriptRef resolution', () => {
  const REF = 'plugins/index.ts';
  const PATH = '../../../realvirtual-WebViewer-Private~/projects/Toray/plugins/index.ts';

  it('matches a module path on a segment-aligned suffix', () => {
    expect(moduleMatchesScriptRef(PATH, 'projects/Toray/plugins/index.ts')).toBe(true);
    expect(moduleMatchesScriptRef(PATH, 'Toray/plugins/index.ts')).toBe(true);
    expect(moduleMatchesScriptRef(PATH, 'plugins/index.ts')).toBe(true);
    // A suffix that is not segment-aligned is a different file.
    expect(moduleMatchesScriptRef(PATH, 'ugins/index.ts')).toBe(false);
    expect(moduleMatchesScriptRef(PATH, 'Plugins/index.ts')).toBe(false); // case (K3)
    expect(moduleMatchesScriptRef(PATH, '')).toBe(false);
    expect(normalizeScriptRef('.\\scripts\\a.ts')).toBe('scripts/a.ts');
  });

  it('binds through the reference even when no name matches', async () => {
    const mod = moduleWith();
    const mgr = new ModelPluginManager({
      importers: importers({ [PATH]: mod }),
      scriptRefProvider: () => REF,
    });
    // The model name matches nothing — the reference is the whole binding.
    await mgr.onModelLoading('/models/some-unrelated-name.glb', fakeViewer());
    expect(mod.registered).toHaveLength(1);
  });

  it('two documents sharing a scriptRef import the module ONCE (N:1)', async () => {
    const mod = moduleWith();
    const mgr = new ModelPluginManager({
      importers: importers({ [PATH]: mod }),
      scriptRefProvider: () => REF,
    });
    const viewer = fakeViewer();
    await mgr.onModelLoading('/models/linie1.glb', viewer);
    await mgr.onModelLoading('/models/linie1-detail.glb', viewer);
    expect(imports.filter(p => p === PATH)).toHaveLength(1);
    expect(mod.registered).toHaveLength(2);
  });

  it('a survives a rename: the reference does not mention the file name', async () => {
    const mod = moduleWith();
    const mgr = new ModelPluginManager({
      importers: importers({ [PATH]: mod }),
      scriptRefProvider: () => REF,
    });
    await mgr.onModelLoading('/models/Linie 1 (renamed).glb', fakeViewer());
    expect(mod.registered).toHaveLength(1);
  });

  it('does NOT fall back to the name match when the reference resolves to nothing', async () => {
    const mod = moduleWith();
    const mgr = new ModelPluginManager({
      // The name WOULD match this module. The reference does not.
      importers: importers({ '/src/plugins/models/Toray/index.ts': mod }),
      scriptRefProvider: () => 'scripts/gone.ts',
    });
    await mgr.onModelLoading('/models/Toray.glb', fakeViewer());
    expect(mod.registered).toHaveLength(0);
  });

  it('falls through to the legacy paths when the row has no reference (F10)', async () => {
    const mod = moduleWith(['Line1']);
    const mgr = new ModelPluginManager({
      importers: importers({ '/src/plugins/models/Anything/index.ts': mod }),
      scriptRefProvider: () => null,
    });
    await mgr.onModelLoading('/models/Line1.glb', fakeViewer());
    expect(mod.registered).toHaveLength(1);
  });

  it('a throwing provider costs the plugins, never the model load', async () => {
    const mod = moduleWith();
    const mgr = new ModelPluginManager({
      importers: importers({ '/src/plugins/models/Toray/index.ts': mod }),
      scriptRefProvider: () => { throw new Error('store not ready'); },
    });
    await expect(mgr.onModelLoading('/models/Toray.glb', fakeViewer())).resolves.toBeUndefined();
    // No reference was obtained, so the legacy name match runs — as for a row
    // that simply has none.
    expect(mod.registered).toHaveLength(1);
  });
});

describe('module cache invalidation (R13 seam)', () => {
  it('re-imports after the referenced script is invalidated', async () => {
    const mod = moduleWith();
    const PATH = '/src/plugins/models/Toray/index.ts';
    const mgr = new ModelPluginManager({
      importers: importers({ [PATH]: mod }),
      scriptRefProvider: () => 'models/Toray/index.ts',
    });
    const viewer = fakeViewer();
    await mgr.onModelLoading('/models/a.glb', viewer);
    await mgr.onModelLoading('/models/b.glb', viewer);
    expect(imports).toHaveLength(1);

    mgr.invalidateScript('models/Toray/index.ts');
    await mgr.onModelLoading('/models/c.glb', viewer);
    expect(imports).toHaveLength(2);
  });
});

describe('resolveModelName', () => {
  it('is the file stem, without query and without .glb', () => {
    expect(resolveModelName('/models/Linie1.glb?v=2')).toBe('Linie1');
    expect(resolveModelName('Linie1')).toBe('Linie1');
  });

  it('strips the rvproject: scheme — a root-level document must still match', () => {
    // plan-737 made the demo documents root-level: no slash in the path, so the
    // scheme leaked into the "basename" and no model plugin matched (/demo lost
    // its failure-message show, 2026-09-02).
    expect(resolveModelName('rvproject:DemoRealvirtualWeb.glb')).toBe('DemoRealvirtualWeb');
    expect(resolveModelName('rvproject:models/Linie1.glb')).toBe('Linie1');
  });
});
