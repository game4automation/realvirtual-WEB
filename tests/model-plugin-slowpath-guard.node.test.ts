// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-479 Phase 3 / R2 — the deprecated name resolver may not EXECUTE
 * arbitrary project files.
 *
 * `_findByModelName` has two halves. The fast one matches a folder name against
 * the model name and never touches a file it does not match. The slow one — the
 * legacy `models: string[]` path — calls `importer()` on every entry it sees,
 * purely to read one array off the module. Running a module has side effects
 * and fetches a chunk; doing it for every candidate was tolerable only because
 * the discovery glob matched exactly one file per project (`plugins/index.ts`).
 *
 * Phase 3 opens that glob to `plugins/**​/*.ts|tsx`. Without this guard, opening
 * it would mean: every model without a `scriptRef` executes every helper file
 * of every private project — nine for Toray, four for mauser3dhmi — as a side
 * effect of being looked up by name.
 *
 * That is why the guard is not an optimisation and does not travel with the
 * glob (R15): it is correct on its own, and it must survive a rollback of the
 * glob change. This file is what makes that survivable — it fails whether or
 * not the glob is open.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
  ModelPluginManager,
  discoveredPluginModulePaths,
  isAggregatorModulePath,
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

/** Same stub the resolution suite uses — the manager wants very little. */
function fakeViewer(): RVViewer {
  return {
    pendingModelUrl: null,
    projectAssetsPath: import.meta.env.BASE_URL,
    withDefaultOrigin: (_origin: string, fn: () => void) => fn(),
  } as unknown as RVViewer;
}

const ROOT = '../../../realvirtual-WebViewer-Private~/projects';

/**
 * One project whose aggregator declares a model, plus helper files that would
 * blow up if anybody executed them — the loudest possible failure mode for a
 * guard that stopped working.
 */
function inventory() {
  const executed: string[] = [];
  const helper = (path: string) => async (): Promise<ModelPluginModule> => {
    executed.push(path);
    throw new Error(`${path} must never be imported by the name resolver`);
  };
  const importers: Record<string, () => Promise<ModelPluginModule>> = {
    [`${ROOT}/Toray/plugins/tension-math.ts`]: helper('tension-math.ts'),
    [`${ROOT}/Toray/plugins/hmi/deep/panel.tsx`]: helper('deep/panel.tsx'),
    [`${ROOT}/Toray/plugins/index.ts`]: async () => {
      executed.push('index.ts');
      return {
        models: ['Winder'],
        registerModelPlugins: () => undefined,
        unregisterModelPlugins: () => undefined,
      };
    },
    [`${ROOT}/Toray/plugins/util.ts`]: helper('util.ts'),
  };
  return { executed, importers };
}

describe('plan-479 R2 — the slow path executes only aggregator modules', () => {
  it('resolves through the index and imports no helper file', async () => {
    const { executed, importers } = inventory();
    const mgr = new ModelPluginManager({ importers });

    await mgr.onModelLoading(`${ROOT}/Toray/Winder.glb`, fakeViewer());

    // The legacy declaration still resolves — that is the compatibility half.
    expect(executed).toContain('index.ts');
    // …and nothing else ran. Before the guard, `tension-math.ts` came FIRST in
    // iteration order and threw before the index was ever reached.
    expect(executed).toEqual(['index.ts']);
  });

  it('finds nothing, quietly, when only helper files are on offer', async () => {
    const { executed, importers } = inventory();
    delete importers[`${ROOT}/Toray/plugins/index.ts`];
    const mgr = new ModelPluginManager({ importers });

    await expect(mgr.onModelLoading(`${ROOT}/Toray/Winder.glb`, fakeViewer()))
      .resolves.toBeUndefined();

    expect(executed).toEqual([]);
  });

  it('guards the FAST path too — a project-name match may not run a helper', async () => {
    let ran = false;
    const mgr = new ModelPluginManager({
      importers: {
        [`${ROOT}/Toray/plugins/helper.ts`]: async () => {
          throw new Error('helper must not be imported');
        },
        [`${ROOT}/Toray/plugins/index.ts`]: async () => {
          ran = true;
          return {
            registerModelPlugins: () => undefined,
            unregisterModelPlugins: () => undefined,
          };
        },
      },
    });

    // Matched by the PROJECT folder name, before the slow path is reached —
    // and note the module declares no `models[]` at all.
    //
    // The plan believed the fast path was already safe because `folderName` is
    // null for a non-index file. It is not: the `projectName` half reads the
    // segment before `plugins/`, which `helper.ts` shares with `index.ts`. With
    // the glob opened, iteration order alone decided whether a helper was
    // executed — and a helper that throws aborts the resolution entirely,
    // because the catch returns null instead of continuing. Hence the same
    // guard on both halves.
    await mgr.onModelLoading(`${ROOT}/Toray/Toray.glb`, fakeViewer());

    expect(ran).toBe(true);
  });
});

describe('plan-479 Finding T6 — the rule holds against the REAL glob result', () => {
  it('classifies each discovered path the way the resolver will treat it', () => {
    // The injected inventories above prove the rule; this proves the rule is
    // asked of the paths Vite actually produced. Whatever the glob currently
    // matches, an `index.` file must classify as an aggregator and any other
    // file must not — that is the whole contract the guard rests on.
    for (const path of discoveredPluginModulePaths()) {
      const leaf = path.replace(/\\/g, '/').split('/').pop() ?? '';
      expect(isAggregatorModulePath(path)).toBe(leaf.startsWith('index.'));
    }
  });

  it('never calls a bare filename an aggregator', () => {
    // `index.ts` with no folder in front of it has no project to belong to, and
    // the fast path's `indexIdx > 0` says the same thing.
    expect(isAggregatorModulePath('index.ts')).toBe(false);
    expect(isAggregatorModulePath('plugins/index.ts')).toBe(true);
    expect(isAggregatorModulePath('plugins/index.tsx')).toBe(true);
    expect(isAggregatorModulePath('plugins/deep/index.ts')).toBe(true);
    expect(isAggregatorModulePath('plugins/util.ts')).toBe(false);
    // Not a prefix match on the folder — `indexes/` is not an index file.
    expect(isAggregatorModulePath('plugins/indexes/util.ts')).toBe(false);
  });
});
