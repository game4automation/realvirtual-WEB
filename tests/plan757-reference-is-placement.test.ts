// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-757 Phase 2b — "a reference is a placement, always" on the MAIN MODEL
 * (mental model 3/4, D7): a runtime load (`viewer.loadModel`) grafts nothing.
 *
 *  - a main model that has geometry of its own AND references BAKES (the
 *    `composition === null` gate is gone: a composition without frames bakes)
 *    — its own meshes become chunk meshes, its references become placements
 *    through the viewer's instancer, recursively;
 *  - a HAND-AUTHORED document-level reference (`AssetReference` without
 *    `PlacementMeta`, without a NodeId) is a placement too — unpivoted, as
 *    `compose()` would have grafted it;
 *  - placed content is addressable by NodeId under the placement's occurrence
 *    (`NodeRegistry.getNodeByAddress`, F10), nested content under the chain;
 *  - a `byPath` override that leads INTO a nested reference is an
 *    `override-orphaned` problem that says so (F6 boundary), never silent;
 *  - save → reload → the same structure, nested included (Phase 2 exit).
 *
 * Real loader, `data:` urls (`tests/helpers/nested-placement-fixture.ts`).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { Group, Object3D } from 'three';
import { objectToGlb } from '../src/core/import/rv-import-object';
import { setAssetOverrides, setAssetReference } from '../src/core/engine/rv-asset-reference';
import { getNodeId } from '../src/core/engine/rv-node-id';
import { RV_BAKE_CHUNK_KEY } from '../src/core/engine/rv-bake-registry';
import { bakeIntoGlb, makeRegistryBakeResolver } from '../src/core/hmi/scene/rv-scene-glb-bake';
import { materialise } from '../src/core/hmi/scene/rv-scene-edits';
import { getProblems, resetProblemsForTests } from '../src/core/hmi/problems-store';
import {
  bootRealLoaderViewer, findByName, innerDataUrl, makeOuter, outerDataUrl, referenceNode, tick, toArrayBuffer,
  CELL_REF_NODE_ID, SLIDE_NODE_ID, type Booted,
} from './helpers/nested-placement-fixture';

let booted: Booted | null = null;
afterEach(() => { booted?.h.dispose(); booted = null; resetProblemsForTests(); });

async function load(bytes: ArrayBuffer | Uint8Array, name = 'doc.glb'): Promise<Booted> {
  booted?.h.dispose();
  booted = await bootRealLoaderViewer();
  await booted.h.viewer.loadModel(name, { data: toArrayBuffer(bytes).slice(0) });
  await booted.h.viewer.whenSceneReady();
  return booted;
}

function chunkMeshesUnder(root: Object3D): number {
  let n = 0;
  root.traverse((o) => { if (o.userData?.[RV_BAKE_CHUNK_KEY] === true) n++; });
  return n;
}

/** Registry paths under the model root, relative, sorted — the structure a reload must reproduce. */
function relativePaths(b: Booted): string[] {
  const reg = b.h.viewer.registry!;
  const root = b.h.viewer.currentModelRoot!;
  const rootPath = reg.getPathForNode(root)!;
  const out: string[] = [];
  root.traverse((o) => {
    if (o === root || o.userData?.[RV_BAKE_CHUNK_KEY] === true) return;
    const p = reg.getPathForNode(o);
    if (p && p.startsWith(rootPath + '/')) out.push(p.slice(rootPath.length + 1));
  });
  return out.sort();
}

describe('the main model is the placement at the origin — its references are placements (Phase 2b)', () => {
  it('a main model with own geometry AND a planner reference bakes; the reference is a placement whose drive moves', async () => {
    // The OUTER asset itself as the document: Frame (own mesh) + `Cell_1` → inner.
    const bytes = await objectToGlb(makeOuter('Machine', [{ name: 'Cell_1', id: CELL_REF_NODE_ID, url: await innerDataUrl(), planner: true, assetId: 'cat:cell' }]));
    const { h } = await load(bytes, 'machine.glb');
    const viewer = h.viewer;
    const result = viewer.lastLoadResult!;
    expect(result.bakedAsset, 'the main model BAKED although it has a reference').not.toBeNull();
    expect(result.bakeInstance?.identity).toBe(true);
    expect(chunkMeshesUnder(result.root), 'own geometry = chunk meshes on the model').toBeGreaterThan(0);
    expect(findByName(result.root, 'Frame'), 'the bare Frame mesh was merged away, as on any baked model').toBeNull();

    const cell = findByName(result.root, 'Cell_1')!;
    const inst = viewer.bakeRegistry.instanceOf(cell);
    expect(inst, 'the reference node is a placement instance').not.toBeNull();
    expect(inst!.identity).toBe(false);
    expect(viewer.bakeRegistry.stats().instances, 'identity + one placement').toBe(2);
    const reg = viewer.registry!;
    const slide = findByName(cell, 'Slide')!;
    const slidePath = reg.getPathForNode(slide);
    expect(slidePath, 'the placed Slide is registered').toMatch(/[/]Cell_1[/]Slide$/);
    expect(reg.getNode(slidePath!)).toBe(slide);
    // Pivoted (PlacementMeta): the Slide sits AT the reference node.
    expect(slide!.position.x).toBeCloseTo(0, 6);
    const before = slide!.position.x;
    tick(h, 60);
    expect(Math.abs(slide!.position.x - before), 'the placed drive moves (m)').toBeGreaterThan(0.1);
  });

  it('a HAND-AUTHORED document-level reference (no PlacementMeta, no NodeId) is a placement too — unpivoted', async () => {
    const root = new Group();
    root.name = 'Layout';
    const ref = new Object3D();
    ref.name = 'CellRef';
    ref.position.set(3, 0, 0);
    setAssetReference(ref, { assetId: 'cat:cell', path: await innerDataUrl() });
    root.add(ref);
    const { h } = await load(await objectToGlb(root), 'hand.glb');
    const viewer = h.viewer;
    const node = findByName(viewer.currentModelRoot!, 'CellRef')!;
    expect(getNodeId(node), 'precondition: the reference carries no NodeId').toBeNull();
    const inst = viewer.bakeRegistry.instanceOf(node);
    expect(inst, 'a hand-authored reference IS a placement').not.toBeNull();
    const slide = findByName(node, 'Slide')!;
    // Not pivoted: the inner Slide keeps its authored x = 2 under the reference.
    expect(slide.position.x).toBeCloseTo(2, 6);
    const slidePath = viewer.registry!.getPathForNode(slide);
    expect(slidePath).toMatch(/Layout[/]CellRef[/]Slide$/);
    expect(viewer.registry!.getNode(slidePath!)).toBe(slide);
    tick(h, 60);
    expect(Math.abs(slide.position.x - 2)).toBeGreaterThan(0.1);
  });

  it('F10: placed content is addressable by NodeId under the placement occurrence — nested under the chain', async () => {
    const inner = await innerDataUrl();
    const outer = await outerDataUrl(inner);
    const doc = new Group();
    doc.name = 'Layout';
    doc.add(referenceNode('Machine_1', 'plc-machine', outer, true, [10, 0, 0], 'cat:machine'));
    doc.add(referenceNode('Cell_9', 'plc-cell', inner, true, [0, 0, 10], 'cat:cell'));
    const { h } = await load(await objectToGlb(doc), 'addr.glb');
    const reg = h.viewer.registry!;
    const model = h.viewer.currentModelRoot!;
    // Top-level placement: occurrence = the reference's NodeId.
    const cell9Slide = findByName(findByName(model, 'Cell_9')!, 'Slide')!;
    expect(reg.getNodeByAddress(SLIDE_NODE_ID, 'plc-cell')).toBe(cell9Slide);
    // Nested placement: occurrence = the chain `<outer occurrence>/<reference NodeId>`.
    const nestedSlide = findByName(findByName(model, 'Machine_1')!, 'Slide')!;
    expect(nestedSlide).not.toBe(cell9Slide);
    expect(reg.getNodeByAddress(SLIDE_NODE_ID, `plc-machine/${CELL_REF_NODE_ID}`)).toBe(nestedSlide);
    expect(reg.getNodeByAddress(SLIDE_NODE_ID, 'nowhere')).toBeNull();
  });

  it('a byPath override that leads INTO a nested reference orphans with the reason "nested-reference" (F6 boundary)', async () => {
    const outer = await outerDataUrl(await innerDataUrl());
    const doc = new Group();
    doc.name = 'Layout';
    const ref = referenceNode('Machine_1', 'plc-machine', outer, true, [10, 0, 0], 'cat:machine');
    setAssetOverrides(ref, { byNodeId: {}, byPath: { 'Cell_1/Slide': { Drive: { TargetSpeed: 9 } } } });
    doc.add(ref);
    const { h } = await load(await objectToGlb(doc), 'ovr.glb');
    const orphans = getProblems().filter((p) => p.code === 'override-orphaned');
    expect(orphans).toHaveLength(1);
    expect(orphans[0].title).toContain('nested reference');
    expect(orphans[0].detail).toContain('"Cell_1"');
    expect(orphans[0].detail).toContain('nested placement');
    expect(orphans[0].nodePath).toMatch(/Layout[/]Machine_1$/);
    // The nested drive keeps its authored speed — nothing was applied silently.
    const slide = findByName(h.viewer.currentModelRoot!, 'Slide')!;
    expect((slide.userData.realvirtual as { Drive: { TargetSpeed: number } }).Drive.TargetSpeed).toBe(200);
  });

  it('Phase 2 exit: save → reload → the same structure, nested included; the nested drive still moves', async () => {
    const outer = await outerDataUrl(await innerDataUrl());
    const doc = new Group();
    doc.name = 'Layout';
    doc.add(referenceNode('Machine_1', 'plc-machine', outer, true, [10, 0, 0], 'cat:machine'));
    const docBytes = await objectToGlb(doc);
    const first = await load(docBytes, 'rt.glb');
    const pathsBefore = relativePaths(first);
    expect(pathsBefore.some((p) => /Layout[/]Machine_1[/]Cell_1[/]Slide$/.test(p))).toBe(true);
    expect(first.h.viewer.bakeRegistry.stats().instances).toBe(2);
    const registry = first.h.viewer.registry!;
    const saved = await bakeIntoGlb(docBytes.slice(0), materialise([]), makeRegistryBakeResolver(registry, []), {
      expectedNames: registry.getGltfNodeNames(),
    });

    const second = await load(saved.glb, 'rt-2.glb');
    expect(relativePaths(second)).toEqual(pathsBefore);
    expect(second.h.viewer.bakeRegistry.stats().instances).toBe(2);
    const slide = findByName(findByName(second.h.viewer.currentModelRoot!, 'Machine_1')!, 'Slide')!;
    expect(second.h.viewer.registry!.getPathForNode(slide)).toMatch(/Layout[/]Machine_1[/]Cell_1[/]Slide$/);
    const x0 = slide.position.x;
    tick(second.h, 60);
    expect(Math.abs(slide.position.x - x0)).toBeGreaterThan(0.1);
  });
});
