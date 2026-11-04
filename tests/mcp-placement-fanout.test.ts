// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-757 F12 — MCP over placements: `web_signal_set_*` fans out to "all
 * instances of asset X" (the path is the address, D9), and `web_status`
 * reports the placements' survival (what the ONE recipe removed and kept).
 *
 * Two placements of fixture (a) (Arburg shape, `Signals/MachineSpeed` = 55):
 *  - `asset` = the asset's root name / the reference's assetId / the file stem
 *    → every instance's own `MachineSpeed` is written, `previous` is kept as
 *    the single-signal contract, the fan-out detail is additive;
 *  - an unknown asset / a signal no instance carries → an error, nothing written;
 *  - `placementsStatus().survival` sums the removal reports of the placed assets.
 */
import { executeDelegateValue } from './helpers/execute-value';
import { describe, it, expect, afterEach } from 'vitest';
import { McpRuntimeTools } from '../src/plugins/mcp-bridge/rv-mcp-runtime-tools';
import { placementsStatus } from '../src/plugins/mcp-bridge/rv-mcp-scene-ready';
import { parityFixture } from './fixtures/parity-fixtures';
import { createParityHost, fixtureBytes, loadAsPlacements, type ParityHost } from './helpers/parity-harness';
import {
  bootNestedViewer, documentBytes as nestedDocumentBytes, OUTER_SIGNAL_URL, SIGNAL_INNER_URL, type Booted,
} from './helpers/nested-placement-fixture';

describe('web_signal_set_* fan-out to every placed instance of an asset (F12)', () => {
  let host: ParityHost | null = null;
  afterEach(() => { host?.dispose(); host = null; });

  it('writes MachineSpeed inside both Arburgs, keeps the single-signal fields, reports survival', async () => {
    host = await createParityHost();
    const { viewer } = host;
    const fixture = parityFixture('a');
    const bytes = await fixtureBytes(fixture.build());
    const placed = await loadAsPlacements(host, bytes, fixture.rootName, 2);
    const tools = new McpRuntimeTools(() => viewer);
    const store = viewer.signalStore!;
    const paths = placed.map((p) => `${p.rootPath}/Signals/MachineSpeed`);
    for (const p of paths) expect(store.getByPath(p)).toBe(55);

    // By the asset's root name.
    const byRoot = JSON.parse(await executeDelegateValue(tools, 'signal.setFloat', { name: 'MachineSpeed', value: 77, asset: 'Arburg' })) as Record<string, unknown>;
    expect(byRoot.error).toBeUndefined();
    expect(byRoot.name).toBe('MachineSpeed');
    expect(byRoot.value).toBe(77);
    expect(byRoot.previous).toBe(55);
    expect(byRoot.asset).toBe('Arburg');
    expect(byRoot.instances).toBe(2);
    const written = byRoot.written as Array<{ root: string; path: string; previous: number }>;
    expect(written.map((w) => w.path).sort()).toEqual([...paths].sort());
    expect(written.map((w) => w.root).sort()).toEqual(placed.map((p) => p.rootPath).sort());
    for (const p of paths) expect(store.getByPath(p)).toBe(77);

    // By the reference's assetId (`cat:parity-N`) and by the blob url's file stem.
    const assetId = (placed[0].assetRoot.userData.realvirtual as { AssetReference: { assetId: string } }).AssetReference.assetId;
    const byId = JSON.parse(await executeDelegateValue(tools, 'signal.setFloat', { name: 'MachineSpeed', value: 78, asset: assetId })) as Record<string, unknown>;
    expect(byId.instances).toBe(2);
    for (const p of paths) expect(store.getByPath(p)).toBe(78);
    const byKey = JSON.parse(await executeDelegateValue(tools, 'signal.setFloat', { name: 'MachineSpeed', value: 79, asset: placed[0].baked!.assetId })) as Record<string, unknown>;
    expect(byKey.instances).toBe(2);
    for (const p of paths) expect(store.getByPath(p)).toBe(79);

    // The bool tool takes the same fan-out; a bool value onto a float signal is
    // the store's business — here only the addressing is under test.
    const bool = JSON.parse(await executeDelegateValue(tools, 'signal.setBool', { name: 'MachineSpeed', value: true, asset: 'Arburg' })) as Record<string, unknown>;
    expect(bool.instances).toBe(2);

    // Unknown asset / unknown signal: an error, nothing written.
    const noAsset = JSON.parse(await executeDelegateValue(tools, 'signal.setFloat', { name: 'MachineSpeed', value: 1, asset: 'Krauss' })) as Record<string, unknown>;
    expect(String(noAsset.error)).toContain('Krauss');
    const noSignal = JSON.parse(await executeDelegateValue(tools, 'signal.setFloat', { name: 'NoSuchSignal', value: 1, asset: 'Arburg' })) as Record<string, unknown>;
    expect(String(noSignal.error)).toContain('NoSuchSignal');
    expect((noSignal.instances as string[]).length).toBe(2);

    // Without `asset` the tool behaves exactly as before (result fields unchanged).
    const single = JSON.parse(await executeDelegateValue(tools, 'signal.setFloat', { name: 'MachineSpeed', value: 5 })) as Record<string, unknown>;
    expect(Object.keys(single).sort()).toEqual(['name', 'previous', 'value']);

    // web_status.placements.survival: one distinct asset behind the two instances.
    const status = placementsStatus(viewer)!;
    expect(status.pending).toBe(0);
    const survival = status.survival!;
    expect(survival.assets).toBe(1);
    expect(survival.reported).toBe(1);
    expect(survival.nodes).toBeGreaterThan(survival.survivors);
    expect(survival.survivors).toBeGreaterThan(0);
    expect(survival.unresolvedReferences).toBe(0);
    expect(survival.unresolvedClaims).toBe(0);
    expect(survival.g1Violations).toBe(0);
    for (const p of placed) p.release();
  });
});

describe('nested instances are instances — the fan-out and the placement counts include them (plan-757 Phase 2b)', () => {
  let booted: Booted | null = null;
  afterEach(() => { booted?.h.dispose(); booted = null; });

  it('two placed Machines × two nested SignalCells: asset=<inner> writes four signals; web_status.placements counts 6', async () => {
    booted = await bootNestedViewer();
    const { h } = booted;
    await h.viewer.loadModel('doc.glb', { data: await nestedDocumentBytes([
      { id: 'plc-m1', name: 'Machine_1', url: OUTER_SIGNAL_URL, pos: [0, 0, 0] },
      { id: 'plc-m2', name: 'Machine_2', url: OUTER_SIGNAL_URL, pos: [20, 0, 0] },
    ]) });
    await h.viewer.whenSceneReady();
    const viewer = h.viewer;
    const store = viewer.signalStore!;
    const reg = viewer.registry!;
    const paths: string[] = [];
    viewer.currentModelRoot!.traverse((o) => { if (o.name === 'Speed') paths.push(reg.getPathForNode(o)!); });
    expect(paths.sort()).toHaveLength(4);
    expect(paths.filter((p) => /Machine_1[/]SignalCell_[12][/]Signals[/]Speed$/.test(p))).toHaveLength(2);
    expect(paths.filter((p) => /Machine_2[/]SignalCell_[12][/]Signals[/]Speed$/.test(p))).toHaveLength(2);
    for (const p of paths) expect(store.getByPath(p), p).toBe(55);

    // The path is the address (D9): every INSTANCE of the inner asset, nested or not.
    const tools = new McpRuntimeTools(() => viewer);
    const res = JSON.parse(await executeDelegateValue(tools, 'signal.setFloat', { name: 'Speed', value: 7, asset: `cat:${SIGNAL_INNER_URL.split('/').pop()}` })) as Record<string, unknown>;
    expect(res.error).toBeUndefined();
    expect(res.instances).toBe(4);
    expect((res.written as Array<{ path: string }>).map((w) => w.path).sort()).toEqual([...paths].sort());
    for (const p of paths) expect(store.getByPath(p)).toBe(7);
    // The OUTER asset carries no `Speed` of its own: addressed by the outer asset, the signal is missing in both.
    const outer = JSON.parse(await executeDelegateValue(tools, 'signal.setFloat', { name: 'Speed', value: 8, asset: 'SignalMachine' })) as Record<string, unknown>;
    expect(String(outer.error)).toContain('Speed');
    expect((outer.instances as string[]).length).toBe(2);

    // `total` / `materialized` count nested placements (documented in help/simulation.md); survival sums both assets.
    const status = placementsStatus(viewer)!;
    expect(status).toMatchObject({ total: 6, materialized: 6, pending: 0, missing: 0 });
    expect(status.survival).toMatchObject({ assets: 2, reported: 2 });
  });
});
