// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-498 §9.5 — FMU bytes reach the binary resource store on every parse
 * entry (main model, placement master, compose/editor subtree), no clone
 * carries bytes in `userData`, and two placements are two instances with
 * disjoint wire names.
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshStandardMaterial, Object3D } from 'three';
import { objectToGlb } from '../src/core/import/rv-import-object';
import { embedFmuPackages } from '../src/core/editor/rv-asset-glb-export';
import { binaryResources } from '../src/core/engine/rv-binary-resources';
import { parseGlbSubtreeWithMeta } from '../src/core/engine/rv-glb-parse';
import { fmuOf, getFmuInstances, type RVFmu } from '../src/core/engine/rv-fmu';
import { modelCacheDocumentId } from '../src/core/engine/rv-model-cache';
import { mainDocumentIdOf } from '../src/core/engine/rv-scene-loader';
import { buildFmuGlb, sha256HexOf } from './helpers/glb-fixture';
import {
  bootRealLoaderViewer, dataUrlOf, documentBytes, findByName, type Booted,
} from './helpers/nested-placement-fixture';

const VARS = [
  { name: 'x', valueReference: 1, causality: 'input', variability: 'continuous', type: 'Real', start: '1.5' },
  { name: 'y', valueReference: 2, causality: 'output', variability: 'continuous', type: 'Real' },
];

let booted: Booted | null = null;
let payload: Uint8Array;
let sha: string;

/** A drawn asset (box) with an FMU node, written by the real writer path. */
async function drawnFmuAssetBytes(): Promise<ArrayBuffer> {
  const root = new Group();
  root.name = 'FmuCell';
  const body = new Mesh(new BoxGeometry(1, 0.5, 1), new MeshStandardMaterial({ color: 0x336699 }));
  body.name = 'Body';
  body.position.set(0, 0.25, 0);
  root.add(body);
  const hyd = new Object3D();
  hyd.name = 'Hyd';
  hyd.userData.realvirtual = { Fmu: {
    StepSize: 0.01, Tolerance: 0.000001, AllowViewerToFmu: true,
    FmuEmbed: { fileName: 'p.fmu', sha256: sha, guid: '{g}', modelName: 'P', fmiVersion: '2.0', byteLength: 0, bufferView: -1 },
    FmuVariables: VARS,
  } };
  root.add(hyd);
  binaryResources.put(sha, payload, 'writer');
  const glb = embedFmuPackages(await objectToGlb(root)).glb;
  binaryResources._resetForTesting();
  return glb;
}

async function fmuAssetBytes(rootName = 'FmuCell'): Promise<ArrayBuffer> {
  return buildFmuGlb([{
    name: 'Hyd',
    payload,
    fmu: {
      StepSize: 0.01, Tolerance: 0.000001, AllowViewerToFmu: true,
      FmuEmbed: { fileName: 'p.fmu', sha256: sha, guid: '{g}', modelName: 'P', fmiVersion: '2.0', byteLength: 0, bufferView: -1 },
      FmuVariables: VARS,
    },
  }], rootName);
}

/** No node's (enumerable) userData holds a typed array or ArrayBuffer. */
function assertNoBytesInUserData(root: Object3D): void {
  root.traverse((n) => {
    const text = JSON.stringify(n.userData, (_k, v) => {
      if (v instanceof ArrayBuffer || ArrayBuffer.isView(v)) throw new Error(`bytes in userData of ${n.name}`);
      return v;
    });
    expect(text.length).toBeLessThan(10_000);
  });
}

beforeEach(async () => {
  binaryResources._resetForTesting();
  payload = new Uint8Array(333).map((_, i) => (i * 13) & 0xff);
  sha = await sha256HexOf(payload);
});

afterEach(() => {
  booted?.h.dispose();
  booted = null;
});

describe('FMU bytes at every parse entry', () => {
  it('main model: store holds the SHA under the load document, the instance is standalone, no bytes in userData', async () => {
    booted = await bootRealLoaderViewer();
    const bytes = await fmuAssetBytes();
    await booted.h.viewer.loadModel('fmu-main.glb', { data: bytes.slice(0) });
    await booted.h.viewer.whenSceneReady();

    const entry = binaryResources.get(sha);
    expect(entry?.byteLength).toBe(333);
    expect(entry?.documentIds.has(mainDocumentIdOf('fmu-main.glb'))).toBe(true);
    const root = booted.h.viewer.scene;
    const hyd = findByName(root, 'Hyd')!;
    expect(hyd).toBeTruthy();
    const fmu = fmuOf(hyd)!;
    expect(fmu.state).toBe('standalone');
    expect(fmu.signalNames.sort()).toEqual(['Hyd.x', 'Hyd.y']);
    expect(booted.h.viewer.signalStore!.get('Hyd.x')).toBe(1.5);
    assertNoBytesInUserData(root);
  });

  it('placements: two placements of the FMU asset → one store entry, two instances with disjoint wire names and keys', async () => {
    booted = await bootRealLoaderViewer();
    // A DRAWN asset: a placed asset that draws nothing arrives without content
    // (plan-757 recipe; see the plan-498 progress notes) — not what is tested here.
    const assetUrl = dataUrlOf(await drawnFmuAssetBytes());
    const doc = await documentBytes([
      { id: 'rec-1', name: 'FmuCell_1', url: assetUrl, pos: [0, 0, 0] },
      { id: 'rec-2', name: 'FmuCell_2', url: assetUrl, pos: [5, 0, 0] },
    ]);
    await booted.h.viewer.loadModel('fmu-layout.glb', { data: doc });
    await booted.h.viewer.whenSceneReady();

    expect(binaryResources.size).toBe(1);
    const holders = [...(binaryResources.get(sha)?.documentIds ?? [])];
    expect(holders.some((d) => d.startsWith('model-cache:'))).toBe(true);
    expect(holders).toContain(modelCacheDocumentId(holders.find((d) => d.startsWith('model-cache:'))!.slice('model-cache:'.length)));

    // Only THIS viewer's instances (a disposed viewer of an earlier test may
    // leave instances whose nodes are no longer in any scene).
    const inScene = new Set<Object3D>();
    booted.h.viewer.scene.traverse((n) => inScene.add(n));
    const instances = getFmuInstances().filter((i) => i.node.name === 'Hyd' && inScene.has(i.node)) as RVFmu[];
    expect(instances).toHaveLength(2);
    const names = instances.flatMap((i) => i.signalNames).sort();
    expect(new Set(names).size).toBe(4);
    expect(names.every((n) => /^FmuCell_[12]\.Hyd\.[xy]$/.test(n))).toBe(true);
    const keys = instances.map((i) => i.instanceKey);
    expect(new Set(keys).size).toBe(2);
    // `<documentId>#<_layoutId>#<path below the placement root>`.
    expect(keys.sort()).toEqual(['document#rec-1#Hyd', 'document#rec-2#Hyd']);
    for (const i of instances) expect(i.state).toBe('standalone');
    // Independent writes.
    const store = booted.h.viewer.signalStore!;
    const [n1, n2] = instances.map((i) => i.signalNames.find((n) => n.endsWith('.x'))!);
    store.set(n1, 9);
    expect(store.get(n2)).toBe(1.5);
    assertNoBytesInUserData(booted.h.viewer.scene);
  });

  it('compose / editor subtree parse: the store gets the SHA under the named document', async () => {
    const parsed = await parseGlbSubtreeWithMeta(await fmuAssetBytes(), 'compose-doc');
    expect(binaryResources.get(sha)?.documentIds.has('compose-doc')).toBe(true);
    assertNoBytesInUserData(parsed.root);
    // A clone (placement template copy) carries the SHA, never the bytes.
    const clone = parsed.root.clone(true);
    const hyd = findByName(clone, 'Hyd')!;
    const embed = (hyd.userData.realvirtual as Record<string, any>).Fmu.FmuEmbed;
    expect(embed.sha256).toBe(sha);
    expect(embed.bufferView).toBeGreaterThanOrEqual(0);
    assertNoBytesInUserData(clone);
  });
});
