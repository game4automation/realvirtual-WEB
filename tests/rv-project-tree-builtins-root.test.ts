// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * §9.4 — the built-in demos are a root you can see and cannot change
 * (plan-445 F6).
 *
 * Three promises, and the third is the one that was nearly got wrong. The root
 * is read-only through the ORDINARY rule (`writable: false`, which
 * `canMoveInTree` / `canRenameInTree` already refuse — no special case). A dev
 * checkout that carries the same demo inside its project folder shows the
 * project's copy, not both. And activating a demo row must load it the way the
 * `?model=` deep link does — the generic `catalogAsset` kind would have taken
 * it to the asset EDITOR instead, which is why bundled rows carry a ref kind of
 * their own.
 */

import { describe, it, expect } from 'vitest';
import {
  BUILTIN_CATALOG_LABEL,
  BUILTIN_CATALOG_PROVIDER_ID,
  BUILTIN_CATALOG_SOURCE_ID,
  bundledCatalogEntries,
  dedupeBundledEntries,
} from '../src/core/project/backends/bundled-backend';
import {
  buildDashboardTree,
  catalogRootId,
  type CatalogRootInput,
} from '../src/core/project/rv-project-tree-sources';
import {
  buildProjectTree,
  canMoveInTree,
  canRenameInTree,
  findTreeNode,
  isRenamableInTree,
} from '../src/core/project/rv-project-tree';
import type { RvProjectAssetEntry } from '../src/core/project/rv-project-types';

const DEMO_URL = '/models/DemoRealvirtualWeb.glb';

const MODELS: RvProjectAssetEntry[] = [
  { path: DEMO_URL, label: 'DemoRealvirtualWeb' },
  { path: '/models/Palletizer.glb' },
];

const ROOT_ID = catalogRootId(BUILTIN_CATALOG_PROVIDER_ID, BUILTIN_CATALOG_SOURCE_ID);

async function builtinRoot(projectPaths: string[] = []): Promise<CatalogRootInput> {
  const entries = await bundledCatalogEntries({ listModels: async () => MODELS });
  return {
    providerId: BUILTIN_CATALOG_PROVIDER_ID,
    sourceId: BUILTIN_CATALOG_SOURCE_ID,
    label: BUILTIN_CATALOG_LABEL,
    writable: false,
    remote: false,
    entries: dedupeBundledEntries(entries, projectPaths),
    refKind: 'bundledDocument',
  };
}

describe('§9.4 — the adapter', () => {
  it('turns the bundled model listing into flat catalog rows', async () => {
    expect(await bundledCatalogEntries({ listModels: async () => MODELS })).toEqual([
      { assetId: DEMO_URL, name: 'DemoRealvirtualWeb', path: 'DemoRealvirtualWeb.glb' },
      { assetId: '/models/Palletizer.glb', name: 'Palletizer', path: 'Palletizer.glb' },
    ]);
  });

  it('carries the model URL as the id — that is what opening one needs', async () => {
    const [demo] = await bundledCatalogEntries({ listModels: async () => MODELS });
    expect(demo.assetId).toBe(DEMO_URL);
  });

  it('a deploy that cannot answer simply has no demos', async () => {
    expect(await bundledCatalogEntries({
      listModels: async () => { throw new Error('404'); },
    })).toEqual([]);
  });
});

describe('§9.4 — the dev-installation dedupe', () => {
  it('the project row wins when the same file sits in both places', () => {
    const entries = [
      { assetId: DEMO_URL, name: 'DemoRealvirtualWeb', path: 'DemoRealvirtualWeb.glb' },
      { assetId: '/models/Palletizer.glb', name: 'Palletizer', path: 'Palletizer.glb' },
    ];
    // Matched on the FILE NAME: one side is a deploy URL, the other a project
    // path, and they agree on nothing else.
    const kept = dedupeBundledEntries(entries, ['models/DemoRealvirtualWeb.glb']);
    expect(kept.map(e => e.path)).toEqual(['Palletizer.glb']);
  });

  it('keeps everything when the project holds none of them', () => {
    const entries = [{ assetId: DEMO_URL, name: 'Demo', path: 'DemoRealvirtualWeb.glb' }];
    expect(dedupeBundledEntries(entries, ['models/Plant.glb'])).toHaveLength(1);
  });
});

describe('§9.4 — the root refuses every edit', () => {
  it('is a catalog root marked read-only', async () => {
    const roots = buildProjectTree(buildDashboardTree({
      project: null, catalogs: [await builtinRoot()],
    }).roots);
    const root = findTreeNode(roots, ROOT_ID);
    expect(root?.kind).toBe('root');
    expect(root?.rootKind).toBe('catalog');
    expect(root?.writable).toBe(false);
    expect(root?.name).toBe('Built-in demos');
  });

  it('refuses move and rename through the ordinary rules', async () => {
    const roots = buildProjectTree(buildDashboardTree({
      project: {
        id: 'proj', name: 'P', writable: true,
        documents: [{ id: 'd', path: 'models/Plant.glb' }],
      },
      catalogs: [await builtinRoot()],
    }).roots);
    const row = `${ROOT_ID}/DemoRealvirtualWeb.glb`;
    expect(findTreeNode(roots, row)?.writable).toBe(false);
    expect(canRenameInTree(roots, row, 'Mine')).toEqual({ ok: false, reason: 'read-only' });
    expect(isRenamableInTree(roots, row)).toBe(false);
    expect(canMoveInTree(roots, row, ROOT_ID)).toEqual({ ok: false, reason: 'read-only' });
    // …and it cannot be dragged into the project either — that is an import.
    expect(canMoveInTree(roots, row, 'proj')).toEqual({ ok: false, reason: 'read-only' });
  });
});

describe('§9.4 — opening a demo', () => {
  it('the row points at the deep link URL, not at an editor asset', async () => {
    const tree = buildDashboardTree({ project: null, catalogs: [await builtinRoot()] });
    const ref = tree.refs.get(`${ROOT_ID}/DemoRealvirtualWeb.glb`);
    // `catalogAsset` would have sent a double-click to `openAssetInEditor`.
    expect(ref).toEqual({
      kind: 'bundledDocument',
      url: DEMO_URL,
      path: 'DemoRealvirtualWeb.glb',
    });
  });

  it('an ordinary catalog keeps the catalogAsset kind', () => {
    const tree = buildDashboardTree({
      project: null,
      catalogs: [{
        providerId: 'p', sourceId: 's', label: 'Lib', writable: true, remote: false,
        entries: [{ assetId: 'a1', name: 'Roll', path: 'Roll.glb' }],
      }],
    });
    expect(tree.refs.get('p:s/Roll.glb')).toEqual({
      kind: 'catalogAsset', providerId: 'p', sourceId: 's', assetId: 'a1',
    });
  });
});
