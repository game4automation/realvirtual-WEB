// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-479 §9.9c / F11 — the shipped projects keep working.
 *
 * Phase 3 changes two things that a delivered customer project depends on
 * without knowing it: the discovery glob now matches every file under
 * `plugins/`, and both halves of the deprecated name resolver refuse to import
 * anything that is not an `index.` module.
 *
 * The promise being pinned here is the negative one — nothing that resolved
 * before stops resolving:
 *
 *  - a project with NO `scriptRef` at all, binding through `models: []` in its
 *    `plugins/index.ts`, still resolves through the `index.` filter (the filter
 *    is safe precisely because a `models[]` declaration lives only in an
 *    aggregator: verified across all five private projects, where none of the
 *    17 helper files exports the plugin pair);
 *  - a project that binds by PROJECT FOLDER name, with no `models[]` at all,
 *    still resolves;
 *  - N:1 — two documents naming one file share one cache entry without
 *    disturbing each other. `rv-model-plugin-manager.ts` keys the cache by
 *    module path for exactly this reason, and the bug it fixed (two entries,
 *    one reachable invalidation) is easy to reintroduce.
 *
 * wmyb is deliberately absent: it carries no `scriptRef`, no `models[]` and an
 * orphan `plugins/index.ts`, so the F11 promise is empty for it rather than
 * untested (Finding I3).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
  ModelPluginManager,
  type ModelPluginModule,
} from '../src/core/rv-model-plugin-manager';
import type { RVViewer } from '../src/core/rv-viewer';

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

function fakeViewer(): RVViewer {
  return {
    pendingModelUrl: null,
    projectAssetsPath: import.meta.env.BASE_URL,
    withDefaultOrigin: (_origin: string, fn: () => void) => fn(),
  } as unknown as RVViewer;
}

const ROOT = '../../../realvirtual-WebViewer-Private~/projects';

interface SpyModule extends ModelPluginModule {
  registered: number;
  unregistered: number;
}

function spyModule(models?: string[]): SpyModule {
  const mod: SpyModule = {
    registered: 0,
    unregistered: 0,
    ...(models ? { models } : {}),
    registerModelPlugins: () => { mod.registered += 1; },
    unregisterModelPlugins: () => { mod.unregistered += 1; },
  };
  return mod;
}

/**
 * A shipped project as the OPENED glob now sees it: the aggregator that carries
 * the legacy declaration, plus the helper files that were invisible before.
 */
function shippedProject(models: string[]) {
  const aggregate = spyModule(models);
  const imported: string[] = [];
  const importers: Record<string, () => Promise<ModelPluginModule>> = {
    [`${ROOT}/Toray/plugins/tension-math.ts`]: async () => {
      imported.push('tension-math');
      return {} as unknown as ModelPluginModule;
    },
    [`${ROOT}/Toray/plugins/hmi/winder-panel.tsx`]: async () => {
      imported.push('winder-panel');
      return {} as unknown as ModelPluginModule;
    },
    [`${ROOT}/Toray/plugins/index.ts`]: async () => {
      imported.push('index');
      return aggregate;
    },
  };
  return { aggregate, imported, importers };
}

describe('plan-479 F11 — legacy models[] resolution survives the index. filter', () => {
  it('resolves a model declared in the aggregator, and imports nothing else', async () => {
    const p = shippedProject(['Winder', 'Slitter']);
    const mgr = new ModelPluginManager({ importers: p.importers });

    await mgr.onModelLoading(`${ROOT}/Toray/Winder.glb`, fakeViewer());

    expect(p.aggregate.registered).toBe(1);
    // The helpers the opened glob newly discovered were not run. Before the
    // guard they would have been, on this very path.
    expect(p.imported).toEqual(['index']);
  });

  it('resolves the SECOND model of the same declaration', async () => {
    const p = shippedProject(['Winder', 'Slitter']);
    const mgr = new ModelPluginManager({ importers: p.importers });

    await mgr.onModelLoading(`${ROOT}/Toray/Slitter.glb`, fakeViewer());

    expect(p.aggregate.registered).toBe(1);
    expect(p.imported).toEqual(['index']);
  });

  it('switching between two declared models re-uses the ONE cached module', async () => {
    const p = shippedProject(['Winder', 'Slitter']);
    const viewer = fakeViewer();
    const mgr = new ModelPluginManager({ importers: p.importers });

    await mgr.onModelLoading(`${ROOT}/Toray/Winder.glb`, viewer);
    await mgr.onModelLoading(`${ROOT}/Toray/Slitter.glb`, viewer);

    // Imported once, registered twice, unregistered once in between: the
    // module cache is keyed by module PATH, so every name the declaration
    // carries lands on one entry (the plan-718 §2.6 F8 fix).
    expect(p.imported).toEqual(['index']);
    expect(p.aggregate.registered).toBe(2);
    expect(p.aggregate.unregistered).toBe(1);
  });

  it('resolves by PROJECT FOLDER name with no models[] at all', async () => {
    const aggregate = spyModule();
    const imported: string[] = [];
    const mgr = new ModelPluginManager({
      importers: {
        [`${ROOT}/Toray/plugins/tension-math.ts`]: async () => {
          imported.push('tension-math');
          return {} as unknown as ModelPluginModule;
        },
        [`${ROOT}/Toray/plugins/index.ts`]: async () => {
          imported.push('index');
          return aggregate;
        },
      },
    });

    await mgr.onModelLoading(`${ROOT}/Toray/Toray.glb`, fakeViewer());

    expect(aggregate.registered).toBe(1);
    expect(imported).toEqual(['index']);
  });
});

describe('plan-479 F11 — N:1, two documents on one module', () => {
  it('two scriptRefs to the same file share one cached module', async () => {
    const shared = spyModule();
    let imports = 0;
    const viewer = fakeViewer();
    const mgr = new ModelPluginManager({
      importers: {
        [`${ROOT}/Development/plugins/shared-panel.tsx`]: async () => {
          imports += 1;
          return shared;
        },
      },
      scriptRefProvider: () => 'plugins/shared-panel.tsx',
      projectFolderProvider: () => 'Development',
    });

    await mgr.onModelLoading(`${ROOT}/Development/DocumentA.glb`, viewer);
    await mgr.onModelLoading(`${ROOT}/Development/DocumentB.glb`, viewer);

    // ONE import for two documents — the whole reason the cache is keyed by
    // module path rather than by model name.
    expect(imports).toBe(1);
    // …and the handover happened properly: A was unregistered before B ran.
    expect(shared.registered).toBe(2);
    expect(shared.unregistered).toBe(1);
  });

  it('two projects with the same file name do NOT share an entry', async () => {
    const development = spyModule();
    const toray = spyModule();
    let folder = 'Development';
    const mgr = new ModelPluginManager({
      importers: {
        [`${ROOT}/Development/plugins/panel.tsx`]: async () => development,
        [`${ROOT}/Toray/plugins/panel.tsx`]: async () => toray,
      },
      scriptRefProvider: () => 'plugins/panel.tsx',
      projectFolderProvider: () => folder,
    });

    await mgr.onModelLoading(`${ROOT}/Development/A.glb`, fakeViewer());
    folder = 'Toray';
    await mgr.onModelLoading(`${ROOT}/Toray/B.glb`, fakeViewer());

    expect(development.registered).toBe(1);
    expect(toray.registered).toBe(1);
  });
});
