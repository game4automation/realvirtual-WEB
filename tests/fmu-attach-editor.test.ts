// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-498 §9.4 — attaching / detaching an FMU in the asset editor through the
 * document op protocol: component, signal children, store entry, Dirty,
 * Undo/Redo, draft recovery before the first save, save → bufferView, reload.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Group, Object3D, Scene } from 'three';
import type { RVViewer } from '../src/core/rv-viewer';
import feedthroughUrl from './fixtures/Feedthrough.fmu?url';
import { scratchAssetDocument } from './helpers/scratch-asset-document';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { constructComponentOnNode } from '../src/core/engine/rv-scene-loader';
import { binaryResources, extractGlbBufferViews, readGlbJson } from '../src/core/engine/rv-binary-resources';
import { fmuOf, getFmuInstances } from '../src/core/engine/rv-fmu';
import { attachFmu, detachFmu, fmuDocumentResourceId, type FmuPackage } from '../src/core/ops/rv-fmu-ops';
import { exportAssetGlb } from '../src/core/editor/rv-asset-glb-export';
import { parseGlbSubtree } from '../src/core/engine/rv-glb-parse';
import { _forgetDraftFmuMemoryForTesting, deleteDraftFmuPackage, getDraftFmuPackage } from '../src/core/editor/rv-asset-draft-storage';
import { sha256HexOf } from './helpers/glb-fixture';

interface MockEnv {
  viewer: RVViewer;
  model: Group;
  registry: NodeRegistry;
  store: SignalStore;
  pathOf(name: string): string;
  node(name: string): Object3D;
}

/** A minimal viewer the asset executors can construct components against. */
function mockViewer(nodeNames = ['A', 'B']): MockEnv {
  const scene = new Scene();
  const model = new Group();
  model.name = 'Asset';
  scene.add(model);
  for (const n of nodeNames) {
    const o = new Object3D();
    o.name = n;
    model.add(o);
  }
  const registry = new NodeRegistry();
  model.traverse((n) => registry.registerNode(NodeRegistry.computeNodePath(n), n));
  const store = new SignalStore();
  const viewer = {
    scene,
    registry,
    signalStore: store,
    transportManager: {},
    get currentModelRoot() { return model; },
    markRenderDirty() {},
    markShadowsDirty() {},
    emit() {},
    on() { return () => {}; },
    rebuildGroupedBvh() {},
  } as unknown as RVViewer;
  return {
    viewer, model, registry, store,
    pathOf: (name) => NodeRegistry.computeNodePath(model.getObjectByName(name)!),
    node: (name) => model.getObjectByName(name)!,
  };
}

let pkgCache: FmuPackage | null = null;
async function feedthroughPackage(): Promise<FmuPackage> {
  if (pkgCache) return pkgCache;
  const bytes = new Uint8Array(await (await fetch(feedthroughUrl)).arrayBuffer());
  // The editor path: the parser is a LAZY module.
  const { readModelDescription } = await import('../src/core/engine/rv-fmu-model-description');
  pkgCache = {
    fileName: 'Feedthrough.fmu',
    sha256: await sha256HexOf(bytes),
    bytes,
    description: await readModelDescription(bytes),
  };
  return pkgCache;
}

function leafNames(node: Object3D): string[] {
  return (node.children.find((c) => c.name === 'Signals')?.children ?? []).map((c) => c.name).sort();
}

beforeEach(async () => {
  binaryResources._resetForTesting();
  for (const i of [...getFmuInstances()]) i.dispose();
  if (pkgCache) await deleteDraftFmuPackage(pkgCache.sha256);
  _forgetDraftFmuMemoryForTesting();
});

describe('attach-fmu / detach-fmu (editor op protocol)', () => {
  it('attach → component, children, store entry, Dirty; Undo removes; Redo restores from the store', async () => {
    const env = mockViewer();
    const doc = scratchAssetDocument(env.viewer);
    const pkg = await feedthroughPackage();
    const a = env.pathOf('A');

    const key = await attachFmu(doc, a, pkg);
    expect(key).toBe('Fmu');
    const fmu = fmuOf(env.node('A'))!;
    expect(fmu).toBeTruthy();
    expect(fmu.state).toBe('standalone');
    expect(fmu.embed?.modelName).toBe('Feedthrough');
    expect(leafNames(env.node('A'))).toContain('Float64_continuous_input');
    expect(leafNames(env.node('A'))).not.toContain('String_input');
    expect(binaryResources.get(pkg.sha256)?.documentIds.has(fmuDocumentResourceId(doc.id))).toBe(true);
    expect(doc.getSnapshot().dirty).toBe(true);

    await doc.undo();
    expect((env.node('A').userData.realvirtual as Record<string, unknown> | undefined)?.Fmu).toBeUndefined();
    expect(leafNames(env.node('A'))).toEqual([]);
    expect(env.store.get('A.Float64_continuous_input')).toBeUndefined();
    // The package stays while the document is open — Undo must find it again.
    expect(binaryResources.has(pkg.sha256)).toBe(true);

    await doc.redo();
    expect(fmuOf(env.node('A'))?.state).toBe('standalone');
    expect(leafNames(env.node('A'))).toContain('Int32_output');
    doc.dispose();
    // Closing the document releases its hold on the package.
    expect(binaryResources.has(pkg.sha256)).toBe(false);
  });

  it('detach → Undo brings the FMU and its children back', async () => {
    const env = mockViewer();
    const doc = scratchAssetDocument(env.viewer);
    const pkg = await feedthroughPackage();
    const a = env.pathOf('A');
    await attachFmu(doc, a, pkg);
    const before = leafNames(env.node('A'));

    expect(await detachFmu(doc, a)).toBe(true);
    expect(fmuOf(env.node('A'))).toBeNull();
    expect(leafNames(env.node('A'))).toEqual([]);
    expect(await detachFmu(doc, env.pathOf('B'))).toBe(false);

    await doc.undo();
    expect(fmuOf(env.node('A'))?.state).toBe('standalone');
    expect(leafNames(env.node('A'))).toEqual(before);
    doc.dispose();
  });

  it('two FMUs with the same variable → wire names A.x / B.x with independent writes', async () => {
    const env = mockViewer();
    const doc = scratchAssetDocument(env.viewer);
    const pkg = await feedthroughPackage();
    await attachFmu(doc, env.pathOf('A'), pkg);
    await attachFmu(doc, env.pathOf('B'), pkg);
    const x = 'Float64_continuous_input';
    expect(env.store.getPath(`A.${x}`)).toBe(`Asset/A/Signals/${x}`);
    expect(env.store.getPath(`B.${x}`)).toBe(`Asset/B/Signals/${x}`);
    env.store.set(`A.${x}`, 4.5);
    expect(env.store.get(`A.${x}`)).toBe(4.5);
    expect(env.store.get(`B.${x}`)).toBe(0);
    // Same package twice → one store entry.
    expect(binaryResources.size).toBe(1);
    doc.dispose();
  });

  it('draft recovery before the first save: a replay after a page reload restores the package and the children', async () => {
    const pkg = await feedthroughPackage();
    const env1 = mockViewer();
    const doc1 = scratchAssetDocument(env1.viewer);
    await attachFmu(doc1, env1.pathOf('A'), pkg);
    const draft = doc1.toDraft();
    doc1.dispose();
    for (const i of [...getFmuInstances()]) i.dispose();

    // "Reload": the store and the in-memory draft tier are gone; only the
    // durable draft side-store (Cache API) survives.
    binaryResources._resetForTesting();
    _forgetDraftFmuMemoryForTesting();

    const env2 = mockViewer();
    const doc2 = scratchAssetDocument(env2.viewer);
    await doc2.replayOps(draft.ops);
    await doc2.whenIdle();
    expect(binaryResources.has(pkg.sha256)).toBe(true);
    const fmu = fmuOf(env2.node('A'))!;
    expect(fmu.state).toBe('standalone');
    expect(leafNames(env2.node('A'))).toContain('Boolean_input');
    doc2.dispose();
  });

  it('a successful save drops the package from the draft side-store (the file carries it now)', async () => {
    const pkg = await feedthroughPackage();
    const env = mockViewer();
    const doc = scratchAssetDocument(env.viewer);
    await attachFmu(doc, env.pathOf('A'), pkg);
    // Before the first save the draft side-store is the only durable copy.
    expect(await getDraftFmuPackage(pkg.sha256)).not.toBeNull();
    await doc.markSaved(doc.base);
    _forgetDraftFmuMemoryForTesting();
    expect(await getDraftFmuPackage(pkg.sha256)).toBeNull();
    // The open document still holds the bytes (Undo after save needs them).
    expect(binaryResources.has(pkg.sha256)).toBe(true);
    doc.dispose();
  });

  it('a save whose package is NOT in the store keeps the draft copy (nothing was embedded)', async () => {
    const pkg = await feedthroughPackage();
    const env = mockViewer();
    const doc = scratchAssetDocument(env.viewer);
    await attachFmu(doc, env.pathOf('A'), pkg);
    binaryResources._resetForTesting();
    await doc.markSaved(doc.base);
    expect(await getDraftFmuPackage(pkg.sha256)).not.toBeNull();
    doc.dispose();
  });

  it('save → one bufferView per SHA with the right bytes, fmuBufferViews, no signal children; reload → same children', async () => {
    const env = mockViewer(['A', 'B', 'C']);
    const doc = scratchAssetDocument(env.viewer);
    const pkg = await feedthroughPackage();
    await attachFmu(doc, env.pathOf('A'), pkg);
    await attachFmu(doc, env.pathOf('B'), pkg); // same file on another node
    const childrenBefore = leafNames(env.node('A'));

    const glb = await exportAssetGlb(env.model, 'Asset');
    const json = readGlbJson(glb)!;
    const nodes = json.nodes as Array<{ name?: string; extras?: { realvirtual?: Record<string, any> } }>;
    // No FMU signal child reached the file.
    expect(nodes.some((n) => n.name === 'Signals')).toBe(false);
    expect(nodes.some((n) => n.name === 'Float64_continuous_input')).toBe(false);
    const fmuNodes = nodes.filter((n) => n.extras?.realvirtual?.Fmu);
    expect(fmuNodes.map((n) => n.name).sort()).toEqual(['A', 'B']);
    const views = new Set(fmuNodes.map((n) => n.extras!.realvirtual!.Fmu.FmuEmbed.bufferView));
    expect(views.size).toBe(1);
    const view = [...views][0] as number;
    expect((json.asset as any).extras.realvirtual.fmuBufferViews).toEqual([view]);
    const [slice] = extractGlbBufferViews(glb, [{ bufferView: view, byteLength: pkg.bytes.byteLength, sha256: pkg.sha256 }]);
    expect(await sha256HexOf(slice.bytes)).toBe(pkg.sha256);

    // Reload in a fresh session: bytes come back from the GLB, children are re-created.
    doc.dispose();
    for (const i of [...getFmuInstances()]) i.dispose();
    binaryResources._resetForTesting();
    const root = await parseGlbSubtree(glb, 'reload');
    expect(binaryResources.has(pkg.sha256)).toBe(true);
    const scene = new Scene();
    scene.add(root);
    const registry = new NodeRegistry();
    root.traverse((n) => registry.registerNode(NodeRegistry.computeNodePath(n), n));
    const store = new SignalStore();
    const a = root.getObjectByName('A')!;
    expect(a.children.find((c) => c.name === 'Signals')).toBeUndefined();
    constructComponentOnNode(
      { registry, signalStore: store, scene, transportManager: {} } as never,
      a, 'Fmu', (a.userData.realvirtual as Record<string, Record<string, unknown>>).Fmu,
    );
    expect(fmuOf(a)?.state).toBe('standalone');
    expect(leafNames(a)).toEqual(childrenBefore);
  });
});
