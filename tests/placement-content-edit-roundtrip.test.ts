// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * placement-content-edit-roundtrip — plan-757 Phase 2, the save routing of
 * edits INSIDE placement content (review F2, tasks 4a / 4b) and spike S2
 * finding 4 (nothing of a nested instance reaches the file).
 *
 * Since plan-757 a placement is a whole-template INSTANCE of a baked asset —
 * the nodes under `Layout/Cell_1` are clones, NodeIds included, not composed
 * frames. `makeRegistryBakeResolver.locate` used to know only frames, so an
 * edit on `Layout/Cell_1/Slide` fell through to `NodeNotFoundError` and the
 * whole save was refused (the finding pinned in `## Spike-Ergebnis S2 (d)`).
 *
 * The rule now (4a): `locate` climbs from the edited node to the NEAREST
 * placement root above it and answers `{ kind: 'referenced', referenceNodePath:
 * <that root>, nodeId: <the node's NodeId in the referenced file> }` — the
 * identical shape a composed frame's node has, so the existing writers route
 * it: `AssetOverrides.byAddress` (components, key `#<id>` — plan-769) on the
 * placement node the file holds (`applyRoutedOverrides`), or — for a placement
 * added THIS session, which has no gltf node yet — into the placement extras
 * the bake writes (`placementPatches`). `applyOverrides` reads both back on
 * the next load.
 *
 * (4b, plan-769 Phase 4b / F13): a node under a NESTED placement (a reference
 * node inside a placed asset) climbs to the OUTERMOST placement the file holds
 * and is addressed through the nested reference: `<cellRef>#<slide>` in that
 * placement's `byAddress`. The plan-757 refusal for component values is gone;
 * the referenced asset is still never written. A MOVE inside placed content is refused at every depth since plan-769
 * (D11/F14, `NestedTransformRefusedError` = `nested-transform-refused`): only
 * component values are overridable there. Nothing is dropped quietly.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Object3D } from 'three';
import {
  bakeIntoGlb, makeRegistryBakeResolver, NestedTransformRefusedError, ReferencedFileWriteError, UnwritableTransformError, type BakeResolver,
} from '../src/core/hmi/scene/rv-scene-glb-bake';
import { materialise } from '../src/core/hmi/scene/rv-scene-edits';
import type { RvOp } from '../src/core/ops/rv-unified-ops';
import { getAssetOverrides, getAssetReference } from '../src/core/engine/rv-asset-reference';
import { getNodeId } from '../src/core/engine/rv-node-id';
import { objectToGlb } from '../src/core/import/rv-import-object';
import { Group } from 'three';
import {
  SLIDE_NODE_ID, CELL_REF_NODE_ID, bootRealLoaderViewer, innerDataUrl, outerDataUrl, referenceNode,
  findByName, jsonNodes, toArrayBuffer, tick, type Booted,
} from './helpers/nested-placement-fixture';

let booted: Booted | null = null;
afterEach(() => { booted?.h.dispose(); booted = null; });

let opCounter = 0;
function op<T extends Omit<RvOp, 'id' | 'ts' | 'schemaV'>>(body: T): RvOp {
  return { id: `op_${++opCounter}`, ts: Date.now(), schemaV: 1, ...body } as unknown as RvOp;
}
function setField(nodePath: string, componentType: string, fieldName: string, value: unknown, prev: unknown): RvOp {
  return op({ kind: 'setField', nodePath, componentType, fieldName, value, prev });
}
function moveOp(nodePath: string, position: [number, number, number]): RvOp {
  return op({ kind: 'transformNode', nodePath, transform: { position, quaternion: [0, 0, 0, 1] }, prev: { position: [0, 0, 0], quaternion: [0, 0, 0, 1] } });
}

/** A layout document with one planner reference `name` → `url` at x = 10. */
async function layoutBytes(name: string, id: string, url: string): Promise<ArrayBuffer> {
  const root = new Group();
  root.name = 'Layout';
  root.add(referenceNode(name, id, url, true, [10, 0, 0], 'cat:cell'));
  return objectToGlb(root);
}

async function load(bytes: ArrayBuffer | Uint8Array, name = 'doc.glb'): Promise<Booted> {
  booted?.h.dispose();
  booted = await bootRealLoaderViewer();
  await booted.h.viewer.loadModel(name, { data: toArrayBuffer(bytes).slice(0) });
  await booted.h.viewer.whenSceneReady();
  return booted;
}

function overridesOnNode(glb: Uint8Array, nodeName: string): Record<string, unknown> | undefined {
  const node = jsonNodes(glb).find((n) => n.name === nodeName) as { extras?: { realvirtual?: Record<string, unknown> } } | undefined;
  return node?.extras?.realvirtual?.AssetOverrides as Record<string, unknown> | undefined;
}

// ─── Spike S2 finding 4 — nothing of a nested instance reaches the file ──

describe('save writes bytes + op log, never the scene graph (spike S2 finding 4)', () => {
  it('a placement with a NESTED placement inside: the placement node is written back byte-identically, no nested node in the file', async () => {
    const inner = await innerDataUrl();
    const outer = await outerDataUrl(inner);
    const docBytes = await layoutBytes('Machine_1', 'plc-machine', outer);
    const before = jsonNodes(docBytes).find((n) => n.name === 'Machine_1')!;
    const { h } = await load(docBytes);
    expect(findByName(h.viewer.currentModelRoot!, 'Slide'), 'precondition: the nested instance is in the scene').not.toBeNull();
    expect(h.viewer.bakeRegistry.stats().instances).toBe(2);

    const baked = await bakeIntoGlb(docBytes.slice(0), materialise([]), makeRegistryBakeResolver(h.viewer.registry!, []), {
      expectedNames: h.viewer.registry!.getGltfNodeNames(),
    });
    const names = jsonNodes(baked.glb).map((n) => n.name);
    expect(names).toContain('Machine_1');
    for (const nested of ['Cell_1', 'Slide', 'Body', 'Tool', 'Frame']) expect(names).not.toContain(nested);
    const after = jsonNodes(baked.glb).find((n) => n.name === 'Machine_1')!;
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
  });
});

// ─── 4a — edits under a TOP-LEVEL placement the file holds ──────────────

describe('4a — an edit inside a top-level placement the file holds routes to AssetOverrides on the placement node (before: NodeNotFoundError)', () => {
  it('locate() climbs to the placement root: { referenced, referenceNodePath = the placement, nodeId = the NodeId in the referenced file }', async () => {
    const { h } = await load(await layoutBytes('Cell_1', 'plc-cell', await innerDataUrl()));
    const registry = h.viewer.registry!;
    const resolver = makeRegistryBakeResolver(registry, []);
    const slide = findByName(h.viewer.currentModelRoot!, 'Slide')!;
    expect(getNodeId(slide), 'the instance node carries the template NodeId').toBe(SLIDE_NODE_ID);
    const slidePath = registry.getPathForNode(slide)!;
    const cellPath = registry.getPathForNode(findByName(h.viewer.currentModelRoot!, 'Cell_1')!)!;
    expect(resolver.locate(slidePath)).toEqual({ kind: 'referenced', referenceNodePath: cellPath, nodeId: SLIDE_NODE_ID, sourceKey: 'cat:cell', address: `#${SLIDE_NODE_ID}` });
    // The placement root itself is a node of the file being written.
    expect(resolver.locate(cellPath)).toMatchObject({ kind: 'root' });
    // A node that has no NodeId cannot be addressed inside the referenced file — unresolved, as before.
    const bodyless = registry.getPathForNode(findByName(h.viewer.currentModelRoot!, 'Body') ?? slide);
    void bodyless;
  });

  it('component edit: TargetSpeed 200 → 500 on Layout/Cell_1/Slide → byAddress on Cell_1 → after the reload the drive runs at 500', async () => {
    const docBytes = await layoutBytes('Cell_1', 'plc-cell', await innerDataUrl());
    const { h } = await load(docBytes);
    const registry = h.viewer.registry!;
    const slidePath = registry.getPathForNode(findByName(h.viewer.currentModelRoot!, 'Slide')!)!;

    const baked = await bakeIntoGlb(docBytes.slice(0), materialise([setField(slidePath, 'Drive', 'TargetSpeed', 500, 200)]),
      makeRegistryBakeResolver(registry, []), { expectedNames: registry.getGltfNodeNames() });
    expect(baked.path).toBe('fast');
    expect(baked.referenceOverrides).toBe(1);
    expect(overridesOnNode(baked.glb, 'Cell_1')).toEqual({ byAddress: { [`#${SLIDE_NODE_ID}`]: { Drive: { TargetSpeed: 500 } } } });

    // Reload the written file: the reader (`applyOverrides`, `byAddress`) finds the node in the fresh instance.
    const reloaded = await load(baked.glb, 'doc-2.glb');
    const cell = findByName(reloaded.h.viewer.currentModelRoot!, 'Cell_1')!;
    expect(getAssetOverrides(cell)).toEqual({ byAddress: { [`#${SLIDE_NODE_ID}`]: { Drive: { TargetSpeed: 500 } } } });
    const slide = findByName(cell, 'Slide')!;
    expect((slide.userData.realvirtual as Record<string, Record<string, unknown>>).Drive.TargetSpeed).toBe(500);
    const x0 = slide.position.x;
    tick(reloaded.h, 60);
    // 500 mm/s × 1 s = 0.5 m — clearly more than the authored 200 mm/s would give.
    expect(Math.abs(slide.position.x - x0)).toBeGreaterThan(0.4);
  });

  it('TRS edit: a moved Slide inside the placement is refused by name (plan-769 nested-transform-refused) — nothing is written', async () => {
    const docBytes = await layoutBytes('Cell_1', 'plc-cell', await innerDataUrl());
    const { h } = await load(docBytes);
    const registry = h.viewer.registry!;
    const slidePath = registry.getPathForNode(findByName(h.viewer.currentModelRoot!, 'Slide')!)!;
    const cellPath = registry.getPathForNode(findByName(h.viewer.currentModelRoot!, 'Cell_1')!)!;

    let error: unknown;
    try {
      await bakeIntoGlb(docBytes.slice(0), materialise([moveOp(slidePath, [0.7, 0.9, 0.1])]),
        makeRegistryBakeResolver(registry, []), { expectedNames: registry.getGltfNodeNames() });
    } catch (e) { error = e; }
    expect(error).toBeInstanceOf(NestedTransformRefusedError);
    expect((error as NestedTransformRefusedError).code).toBe('nested-transform-refused');
    expect((error as NestedTransformRefusedError).paths).toEqual([slidePath]);
    expect((error as NestedTransformRefusedError).owners).toEqual([cellPath]);
    expect((error as Error).message).toContain(slidePath);
    expect((error as Error).message).toContain('inside a placement');
  });
});

// ─── 4a — a placement added THIS session (no gltf node yet) ─────────────

describe('4a — an edit inside a LIVE placement (added this session) goes into the placement extras the bake writes', () => {
  it('a component edit lands as byAddress in the new placement node and the reload applies it; a TRS edit there is refused by name', async () => {
    const inner = await innerDataUrl();
    // The live placement, as `placeComponent` records it (glbUrl = the data url; a blob: url would be dropped on write).
    const placement = {
      id: 'plc-live', catalogId: 'cat:cell', glbUrl: inner, label: 'Cell_1',
      position: [10, 0, 0] as [number, number, number], rotation: [0, 0, 0] as [number, number, number], scale: [1, 1, 1] as [number, number, number],
    };
    // The resolver of a scene whose registry holds the live instance: the
    // content node climbs to `Layout/Cell_1`, which has no gltf node (null) —
    // what `livePlacementIdOf` is for.
    const resolver: BakeResolver = {
      locate(path) {
        if (path === 'Layout/Cell_1/Slide') return { kind: 'referenced', referenceNodePath: 'Layout/Cell_1', nodeId: SLIDE_NODE_ID, sourceKey: 'cat:cell' };
        return null;
      },
      livePlacementIdOf(path) { return path === 'Layout/Cell_1' ? 'plc-live' : null; },
    };
    const empty = new Group();
    empty.name = 'Layout';
    const base = await objectToGlb(empty);

    // plan-769 F14: the move inside the live placement is refused — with the component edit beside it, nothing is written.
    let error: unknown;
    try {
      await bakeIntoGlb(base.slice(0), materialise([
        op({ kind: 'addPlacement', placement }),
        setField('Layout/Cell_1/Slide', 'Drive', 'TargetSpeed', 500, 200),
        moveOp('Layout/Cell_1/Slide', [0.7, 0.9, 0.1]),
      ]), resolver, {});
    } catch (e) { error = e; }
    expect(error).toBeInstanceOf(NestedTransformRefusedError);
    expect((error as NestedTransformRefusedError).paths).toEqual(['Layout/Cell_1/Slide']);

    const baked = await bakeIntoGlb(base, materialise([
      op({ kind: 'addPlacement', placement }),
      setField('Layout/Cell_1/Slide', 'Drive', 'TargetSpeed', 500, 200),
    ]), resolver, {});
    expect(baked.path).toBe('full');
    expect(baked.placements).toBe(1);
    expect(overridesOnNode(baked.glb, 'Cell_1')).toEqual({
      byAddress: { [`#${SLIDE_NODE_ID}`]: { Drive: { TargetSpeed: 500 } } },
    });
    const node = jsonNodes(baked.glb).find((n) => n.name === 'Cell_1') as { extras: { realvirtual: Record<string, unknown> } };
    expect((node.extras.realvirtual.AssetReference as { path?: string }).path).toBe(inner);

    const reloaded = await load(baked.glb, 'doc-live.glb');
    const cell = findByName(reloaded.h.viewer.currentModelRoot!, 'Cell_1')!;
    expect(reloaded.h.viewer.bakeRegistry.instanceOf(cell)).not.toBeNull();
    const slide = findByName(cell, 'Slide')!;
    expect((slide.userData.realvirtual as Record<string, Record<string, unknown>>).Drive.TargetSpeed).toBe(500);
  });
});

// ─── 4b — edits under a NESTED placement are refused by name ────────────

describe('4b — an edit under a NESTED reference node goes to the OUTER placement as a nested address (plan-769 F13)', () => {
  async function nestedWorld() {
    const inner = await innerDataUrl();
    const outer = await outerDataUrl(inner);
    const docBytes = await layoutBytes('Machine_1', 'plc-machine', outer);
    const { h } = await load(docBytes);
    const registry = h.viewer.registry!;
    const root = h.viewer.currentModelRoot!;
    const nested = findByName(root, 'Cell_1')!;
    const slide = findByName(nested, 'Slide')!;
    return {
      h, docBytes, registry,
      resolver: makeRegistryBakeResolver(registry, []),
      machinePath: registry.getPathForNode(findByName(root, 'Machine_1')!)!,
      nestedPath: registry.getPathForNode(nested)!,
      slidePath: registry.getPathForNode(slide)!,
      nested, slide: slide as Object3D,
    };
  }

  it('locate(): the node AND the nested root both resolve to the top-level placement, addressed through the nested reference', async () => {
    const w = await nestedWorld();
    expect(w.resolver.locate(w.slidePath)).toMatchObject({
      kind: 'referenced', referenceNodePath: w.machinePath, nodeId: SLIDE_NODE_ID, address: `${CELL_REF_NODE_ID}#${SLIDE_NODE_ID}`,
    });
    expect(w.resolver.locate(w.nestedPath)).toMatchObject({
      kind: 'referenced', referenceNodePath: w.machinePath, nodeId: CELL_REF_NODE_ID, address: `#${CELL_REF_NODE_ID}`,
    });
    expect(w.resolver.locate(w.machinePath)).toMatchObject({ kind: 'root' });
    expect(w.resolver.livePlacementIdOf!(w.nestedPath), 'a nested root is no planner record').toBeNull();
    expect(w.resolver.livePlacementIdOf!(w.machinePath)).toBe('plc-machine');
  });

  it('component edit → byAddress["<cellRef>#<slide>"] on Machine_1; the reload applies it to the nested Slide', async () => {
    const w = await nestedWorld();
    const baked = await bakeIntoGlb(w.docBytes.slice(0), materialise([setField(w.slidePath, 'Drive', 'TargetSpeed', 500, 200)]), w.resolver, {
      expectedNames: w.registry.getGltfNodeNames(),
    });
    expect(baked.referenceOverrides).toBe(1);
    expect(overridesOnNode(baked.glb, 'Machine_1')).toEqual({
      byAddress: { [`${CELL_REF_NODE_ID}#${SLIDE_NODE_ID}`]: { Drive: { TargetSpeed: 500 } } },
    });
    const reloaded = await load(baked.glb, 'doc-nested.glb');
    const slide = findByName(findByName(reloaded.h.viewer.currentModelRoot!, 'Cell_1')!, 'Slide')!;
    expect((slide.userData.realvirtual as Record<string, Record<string, unknown>>).Drive.TargetSpeed).toBe(500);
  });

  it('TRS edit → NestedTransformRefusedError (an UnwritableTransformError) naming the node and the way out', async () => {
    const w = await nestedWorld();
    let error: unknown;
    try {
      await bakeIntoGlb(w.docBytes.slice(0), materialise([moveOp(w.slidePath, [1, 2, 3])]), w.resolver, {
        expectedNames: w.registry.getGltfNodeNames(),
      });
    } catch (e) { error = e; }
    expect(error).toBeInstanceOf(UnwritableTransformError);
    expect(error).toBeInstanceOf(NestedTransformRefusedError);
    expect((error as UnwritableTransformError).paths).toEqual([w.slidePath]);
    expect((error as UnwritableTransformError).unknown).toEqual([]);
    expect((error as NestedTransformRefusedError).owners).toEqual([w.machinePath]);
    expect((error as Error).message).toContain(w.slidePath);
    expect((error as Error).message).toContain('open the referenced asset');
  });

  it('the nested reference node itself is never touched: it lives in the outer asset, and an unrelated save leaves the top-level node byte-identical', async () => {
    const w = await nestedWorld();
    const before = jsonNodes(w.docBytes).find((n) => n.name === 'Machine_1')!;
    expect(getAssetReference(w.nested)?.assetId).toBe('cat:cell');
    const baked = await bakeIntoGlb(w.docBytes.slice(0), materialise([]), w.resolver, { expectedNames: w.registry.getGltfNodeNames() });
    expect(JSON.stringify(jsonNodes(baked.glb).find((n) => n.name === 'Machine_1'))).toBe(JSON.stringify(before));
    expect(jsonNodes(baked.glb).map((n) => n.name)).not.toContain('Cell_1');
  });
});
