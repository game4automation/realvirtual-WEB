// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-498 §9.9 — the asset writer embeds FMU packages as bufferViews and
 * prunes the runtime signal children; a package missing from the store is a
 * warning with `bufferView: -1`.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshStandardMaterial, Object3D } from 'three';
import { exportAssetGlb, embedFmuPackages, pruneRuntimeHelpers } from '../src/core/editor/rv-asset-glb-export';
import { binaryResources, collectFmuEmbeds, extractGlbBufferViews, readGlbJson } from '../src/core/engine/rv-binary-resources';
import { parseGlbSubtree } from '../src/core/engine/rv-glb-parse';
import { RV_FMU_SIGNAL } from '../src/core/engine/rv-fmu';
import { sha256HexOf } from './helpers/glb-fixture';

function fmuRecord(sha: string, bufferView = -1): Record<string, unknown> {
  return {
    StepSize: 0.01, Tolerance: 0.000001, AllowViewerToFmu: true,
    FmuEmbed: { fileName: 'p.fmu', sha256: sha, guid: '{g}', modelName: 'P', fmiVersion: '2.0', byteLength: 0, bufferView },
    FmuVariables: [{ name: 'x', valueReference: 1, causality: 'input', variability: 'continuous', type: 'Real', start: '0' }],
  };
}

/** Asset with a mesh (so the GLB has geometry bufferViews too) and one FMU node. */
function asset(sha: string, staleView = -1): { root: Group; fmuNode: Object3D } {
  const root = new Group();
  root.name = 'Asset';
  const box = new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial());
  box.name = 'Box';
  root.add(box);
  const fmuNode = new Object3D();
  fmuNode.name = 'Hyd';
  fmuNode.userData.realvirtual = { Fmu: fmuRecord(sha, staleView) };
  // A runtime signal child, as RVFmu creates it.
  const signals = new Object3D();
  signals.name = 'Signals';
  signals.userData[RV_FMU_SIGNAL] = true;
  const leaf = new Object3D();
  leaf.name = 'x';
  leaf.userData[RV_FMU_SIGNAL] = true;
  leaf.userData.realvirtual = { PLCInputFloat: { Name: 'Hyd.x', Status: { Value: 0 } } };
  signals.add(leaf);
  fmuNode.add(signals);
  root.add(fmuNode);
  return { root, fmuNode };
}

beforeEach(() => binaryResources._resetForTesting());

describe('asset writer — FMU packages', () => {
  it('save → reload: new indices, FmuEmbed rewritten (stale index replaced), SHA identical', async () => {
    const payload = new Uint8Array(1001).map((_, i) => (i * 7) & 0xff);
    const sha = await sha256HexOf(payload);
    binaryResources.put(sha, payload, 'doc');
    const { root } = asset(sha, 99); // a stale index from an older file

    const glb = await exportAssetGlb(root, 'Asset');
    const json = readGlbJson(glb)!;
    const [wanted] = collectFmuEmbeds(json);
    expect(wanted.sha256).toBe(sha);
    expect(wanted.bufferView).not.toBe(99);
    expect(wanted.byteLength).toBe(1001);
    expect((json.asset as any).extras.realvirtual.fmuBufferViews).toEqual([wanted.bufferView]);
    // Geometry views came first; the package view is appended after them.
    expect(wanted.bufferView).toBeGreaterThan(0);
    const [res] = extractGlbBufferViews(glb, [wanted]);
    expect(await sha256HexOf(res.bytes)).toBe(sha);

    binaryResources._resetForTesting();
    const reloaded = await parseGlbSubtree(glb, 'reloaded');
    expect(binaryResources.get(sha)?.byteLength).toBe(1001);
    const hyd = reloaded.getObjectByName('Hyd')!;
    expect(hyd.children.some((c) => c.name === 'Signals')).toBe(false);
    expect(reloaded.getObjectByName('Box')).toBeTruthy();
  });

  it('package missing from the store → warning, bufferView -1, file still written', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sha = 'c'.repeat(64);
    const { root } = asset(sha, 3);
    const glb = await exportAssetGlb(root, 'Asset');
    const json = readGlbJson(glb)!;
    const node = (json.nodes as Array<any>).find((n) => n.name === 'Hyd');
    expect(node.extras.realvirtual.Fmu.FmuEmbed.bufferView).toBe(-1);
    expect((json.asset as any).extras.realvirtual.fmuBufferViews).toEqual([]);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('saved without its bytes'))).toBe(true);
    warn.mockRestore();
  });

  it('embedFmuPackages leaves a GLB without FMUs untouched', async () => {
    const { objectToGlb } = await import('../src/core/import/rv-import-object');
    const g = new Group();
    g.add(new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial()));
    const glb = await objectToGlb(g);
    const r = embedFmuPackages(glb);
    expect(r.glb).toBe(glb);
    expect(r.embedded).toEqual([]);
  });

  it('pruneRuntimeHelpers drops FMU leaves, and a shared Signals container keeps its other signals', () => {
    const { root, fmuNode } = asset('d'.repeat(64));
    const signals = fmuNode.children.find((c) => c.name === 'Signals')!;
    const foreign = new Object3D();
    foreign.name = 'DriveSpeed';
    foreign.userData.realvirtual = { PLCOutputFloat: { Name: 'DriveSpeed' } };
    signals.add(foreign);
    pruneRuntimeHelpers(root);
    expect(fmuNode.children.find((c) => c.name === 'Signals')?.children.map((c) => c.name)).toEqual(['DriveSpeed']);

    const clean = asset('e'.repeat(64));
    pruneRuntimeHelpers(clean.root);
    expect(clean.fmuNode.children).toHaveLength(0);
  });
});
