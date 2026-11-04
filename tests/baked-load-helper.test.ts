// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * baked-load-helper.test.ts — proves the helper every bake-relevant test now
 * loads through really loads the BAKED tree (plan-772 F2, test spec 8.1).
 *
 * The enforcement half of 8.1 is a filesystem scan and therefore a node test
 * (`tests/bake-test-path-enforced.node.test.ts`); this half needs a real
 * browser, a real GLB and the real loader, so it lives here. Splitting them is
 * not cosmetic: `vitest.node.config.ts` only picks up `*.node.test.ts`, and a
 * browser test misnamed that way runs silently nowhere and looks green
 * (plan-772 N6).
 *
 * What it pins, measured on `DemoRobotIK.glb`:
 *
 * | load | nodes |
 * |---|---|
 * | `loadGLB(url, scene, { data })` | 117 |
 * | `loadGLB(url, scene, { data, preserveHierarchy: true })` | 117 — the flag alone changes NOTHING |
 * | `loadBakedGLB(url, scene, { data })` | 78 |
 *
 * The numbers are the measurement, not the assertion: the assertions are
 * "strictly fewer nodes than the authoring load" and "chunk meshes exist", so
 * a legitimate change to what survives does not need a test edit, while a
 * helper that silently stopped baking fails immediately.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { Scene } from 'three';
import { loadGLB, type LoadResult } from '../src/core/engine/rv-scene-loader';
import { loadBakedGLB, countNodes } from './helpers/load-baked-glb';
import { DEV_GLB } from './fixtures/glb-paths.mjs';
import { devAssetAvailable } from './fixtures/dev-asset-available';

const DEV_ASSETS = await devAssetAvailable(DEV_GLB.robotIK);
const GLB_URL = DEV_GLB.robotIK;

let authoring: LoadResult | null = null;
let authoringWithFlag: LoadResult | null = null;
let baked: LoadResult | null = null;

describe.skipIf(!DEV_ASSETS)('loadBakedGLB loads what production loads', () => {
  beforeAll(async () => {
    const bytes = await (await fetch(GLB_URL)).arrayBuffer();
    // The three loads of the measurement above, same bytes, fresh scenes.
    authoring = await loadGLB(GLB_URL, new Scene(), { data: bytes });
    authoringWithFlag = await loadGLB(GLB_URL, new Scene(), { data: bytes, preserveHierarchy: true });
    baked = await loadBakedGLB(GLB_URL, new Scene(), { data: bytes });
  }, 180000);

  it('preserveHierarchy alone changes nothing — the bake hangs on the registry', () => {
    // This is the whole reason 49 test files were blind: the flag everybody
    // reached for is not the switch.
    expect(countNodes(authoringWithFlag!.root)).toBe(countNodes(authoring!.root));
    expect(authoring!.bakedAsset ?? null).toBeNull();
    expect(authoring!.placementBakeAllowed ?? false).toBe(false);
  });

  it('the helper bakes: fewer nodes than the authoring tree, and chunk meshes', () => {
    const authored = countNodes(authoring!.root);
    const bakedNodes = countNodes(baked!.root);
    // Printed, not asserted: the run itself carries the number the plan quotes.
    console.info(`[baked-load] ${GLB_URL}: authoring ${authored} nodes, baked ${bakedNodes} nodes, `
      + `${baked!.bakedAsset?.chunks.length ?? 0} chunks`);
    expect(bakedNodes, `baked ${bakedNodes} vs authored ${authored} nodes`).toBeLessThan(authored);
    expect(baked!.placementBakeAllowed).toBe(true);
    expect(baked!.bakedAsset).toBeTruthy();
    expect(baked!.bakedAsset!.destructive).toBe(true);
    expect(baked!.bakedAsset!.chunks.length).toBeGreaterThan(0);
  });

  it('refuses an authoring flag instead of quietly loading the wrong tree', async () => {
    await expect(
      // The cast is the point: the flag is banned at the type level, so this
      // reproduces the only way it can still arrive — through a spread.
      loadBakedGLB(GLB_URL, new Scene(), { preserveHierarchy: true } as never),
    ).rejects.toThrow(/preserveHierarchy/);
  });
});
