// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-769 Phase 0 — memory of the per-node identity strings (spike, measurement).
 *
 * Question: may `_rvAuthoredPath` (and the seeded `NodeId`) live in
 * `userData`, or must the authored path sit in a per-TEMPLATE side table?
 * `userData` is JSON-cloned per placement instance (`cloneLogicNode` in
 * `BakeRegistry.instantiate`, `Object3D.clone`), so every string in it is paid
 * once per node AND per instance; a side table keyed by the template node is
 * paid once per asset.
 *
 * Sizes mirror the real files: the main model has Mauser Cageline30's node
 * count (70 437) and mean canonical path length (125 chars, Phase-0 seed
 * spike); the placed asset is a 1 000-node library asset with 60-char paths,
 * placed 10 and 100 times. Retained heap via CDP after a forced GC
 * (`Runtime.getHeapUsage`). The numbers go into the plan; the assertions only
 * pin the direction (side table ≪ per-instance userData), never a byte budget.
 */
import { describe, it, expect } from 'vitest';
import { cdp } from 'vitest/browser';
import { Object3D } from 'three';

type Sender = { send(method: string, params?: unknown): Promise<any> };

async function usedHeap(): Promise<number | null> {
  let s: Sender;
  try { s = cdp() as unknown as Sender; } catch { return null; }
  try {
    await s.send('HeapProfiler.enable');
    await s.send('HeapProfiler.collectGarbage');
    await s.send('HeapProfiler.collectGarbage');
    const u = await s.send('Runtime.getHeapUsage') as { usedSize: number };
    return u.usedSize;
  } catch { return null; }
}

/** Unique path strings of a given mean length (fresh string objects, like JSON.parse makes). */
function makePaths(n: number, meanLen: number): string[] {
  const out = new Array<string>(n);
  for (let i = 0; i < n; i++) {
    const seg = `Seg${i.toString(36)}`;
    out[i] = ('CAD_Objects/Module/' + seg + '/').repeat(Math.ceil(meanLen / 24)).slice(0, meanLen - 1) + String(i % 10);
  }
  return out;
}

function makeNodes(n: number): Object3D[] {
  const nodes = new Array<Object3D>(n);
  for (let i = 0; i < n; i++) {
    const o = new Object3D();
    o.userData.realvirtual = { layer: 0 };
    nodes[i] = o;
  }
  return nodes;
}

/** `cloneLogicNode`-style instance copy: JSON round trip of userData. */
function instanceCopy(template: Object3D[]): Object3D[] {
  return template.map((t) => {
    const o = new Object3D();
    o.userData = JSON.parse(JSON.stringify(t.userData));
    return o;
  });
}

const MB = 1024 * 1024;

describe('plan-769 Phase 0 — memory of _rvAuthoredPath / NodeId', () => {
  it('measures main model (Mauser size) and 10/100 placements', async () => {
    const results: Record<string, number> = {};
    const keep: unknown[] = [];

    // ── Main model: 70 437 nodes, 125-char paths ──
    const h0 = await usedHeap();
    if (h0 === null) { console.warn('[spike-769-memory] CDP unavailable — not measured'); return; }
    const main = makeNodes(70_437);
    keep.push(main);
    const h1 = (await usedHeap())!;
    const mainPaths = makePaths(70_437, 125);
    for (let i = 0; i < main.length; i++) main[i]!.userData._rvAuthoredPath = mainPaths[i];
    mainPaths.length = 0;
    const h2 = (await usedHeap())!;
    for (let i = 0; i < main.length; i++) (main[i]!.userData.realvirtual as Record<string, unknown>).NodeId = crypto.randomUUID();
    const h3 = (await usedHeap())!;
    results.mainNodesMB = (h1 - h0) / MB;
    results.mainAuthoredPathMB = (h2 - h1) / MB;
    results.mainNodeIdMB = (h3 - h2) / MB;
    results.mainAuthoredPathBytesPerNode = (h2 - h1) / 70_437;
    results.mainNodeIdBytesPerNode = (h3 - h2) / 70_437;

    // ── Placements: 1 000-node asset, 60-char paths, JSON-cloned per instance ──
    const asset = makeNodes(1000);
    const assetPaths = makePaths(1000, 60);
    keep.push(asset);
    for (const count of [10, 100]) {
      const bare = (await usedHeap())!;
      const plain: Object3D[][] = [];
      for (let k = 0; k < count; k++) plain.push(instanceCopy(asset));
      const withoutPath = (await usedHeap())!;
      for (let i = 0; i < asset.length; i++) asset[i]!.userData._rvAuthoredPath = assetPaths[i];
      const tagged: Object3D[][] = [];
      for (let k = 0; k < count; k++) tagged.push(instanceCopy(asset));
      const withPath = (await usedHeap())!;
      // Side table: ONE WeakMap entry per template node, nothing per instance.
      for (const n of asset) delete n.userData._rvAuthoredPath;
      const side = new WeakMap<Object3D, string>();
      for (let i = 0; i < asset.length; i++) side.set(asset[i]!, assetPaths[i]!);
      const withSide = (await usedHeap())!;
      keep.push(plain, tagged, side);
      results[`placements${count}InstanceMB`] = (withoutPath - bare) / MB;
      results[`placements${count}UserDataPathMB`] = ((withPath - withoutPath) - (withoutPath - bare)) / MB;
      results[`placements${count}SideTableMB`] = (withSide - withPath) / MB;
    }
    console.log('[spike-769-memory]', JSON.stringify(results, (_k, v) => (typeof v === 'number' ? Math.round(v * 1000) / 1000 : v)));
    expect(keep.length).toBeGreaterThan(0);
    expect(results.mainAuthoredPathBytesPerNode).toBeGreaterThan(0);
    expect(results.placements100UserDataPathMB!).toBeGreaterThan(results.placements10UserDataPathMB!);
  }, 120_000);
});
