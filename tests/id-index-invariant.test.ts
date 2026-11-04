// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-769 9.21 — the id index equals the traversal (F5), Phase-1a part: after a
 * load (main model, placements at depth 1 and 2, composed frames) every node a
 * document walk reaches that has an identity is indexed under exactly its address,
 * and nothing indexed is detached. Phase 2: the same holds after every op, undo and redo
 * of an editing session (create, clone, separate, merge, import, rename, reparent, delete).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { Group, Mesh, BoxGeometry, MeshStandardMaterial, Object3D, Scene } from 'three';
import { createTestViewer, type TestViewerHandle } from './helpers/create-test-viewer';
import { identityIdOf } from '../src/core/engine/rv-decode-identity';
import { setNodeId } from '../src/core/engine/rv-node-id';
import { setAssetReference } from '../src/core/engine/rv-asset-reference';
import { objectToGlb } from '../src/core/import/rv-import-object';
import { loadGLB, resetSidecarProbeCache } from '../src/core/engine/rv-scene-loader';
import { buildMauserCoreGlb } from './helpers/migrate-769-fixtures';
import { identities, loadOpIdentityFixture, tri } from './helpers/op-identity-fixture';
import { OUTER_URL, bootNestedViewer, findByName, referenceNode, type Booted } from './helpers/nested-placement-fixture';

const CLEAN = { unindexed: [], stale: [], wrong: [] };

describe('plan-769 9.21 — id index == traversal', () => {
  let h: TestViewerHandle | null = null;
  let booted: Booted | null = null;
  afterEach(() => { h?.dispose(); h = null; booted?.h.dispose(); booted = null; });

  it('main model: every decoded node that survived the bake is indexed under occurrence ""', async () => {
    h = await createTestViewer('webgl');
    await h.viewer.loadModel('mauser-core.glb', { data: await buildMauserCoreGlb() });
    const reg = h.viewer.registry!;
    expect(reg.auditIdIndex()).toEqual(CLEAN);
    let withId = 0;
    h.viewer.currentModelRoot!.traverse((n) => { if (identityIdOf(n)) withId++; });
    expect(withId).toBeGreaterThan(5);
    expect(reg.getRegisteredOccurrences()).toEqual(['']);
  });

  it('placements at depth 1 and 2: content under its occurrence, reference nodes in their parent file; a removal leaves nothing stale', async () => {
    booted = await bootNestedViewer();
    const root = new Group();
    root.name = 'Layout';
    setNodeId(root, 'nid-layout');
    root.add(referenceNode('Machine_1', 'nid-p1', OUTER_URL, true, [10, 0, 0]));
    root.add(referenceNode('Machine_2', 'nid-p2', OUTER_URL, true, [20, 0, 0]));
    await booted.h.viewer.loadModel('layout.glb', { data: await objectToGlb(root) });
    await booted.h.viewer.whenSceneReady();
    const reg = booted.h.viewer.registry!;
    expect(reg.auditIdIndex()).toEqual(CLEAN);
    expect(reg.getRegisteredOccurrences().sort()).toEqual(['', 'nid-p1', 'nid-p1/nid-cell', 'nid-p2', 'nid-p2/nid-cell']);
    // Remove one placement the way the planner does: detach, then unregister its subtree.
    const m1 = findByName(booted.h.viewer.currentModelRoot!, 'Machine_1')!;
    m1.removeFromParent();
    reg.unregisterSubtree(m1);
    expect(reg.auditIdIndex()).toEqual(CLEAN);
    expect(reg.getRegisteredOccurrences().sort()).toEqual(['', 'nid-p2', 'nid-p2/nid-cell']);
    expect(reg.getRegisteredAddresses().some((a) => a.startsWith('nid-p1'))).toBe(false);
  });

  it('composed frames: the grafted content under the frame occurrence, the plant under ""', async () => {
    resetSidecarProbeCache();
    const mat = new MeshStandardMaterial();
    const press = new Group();
    press.name = 'Press';
    const ram = new Mesh(new BoxGeometry(1, 1, 1), mat);
    ram.name = 'Ram';
    ram.userData.realvirtual = { Drive: { Direction: 'LinearY' } };
    press.add(ram);
    const pressBytes = await objectToGlb(press);
    const plant = new Group();
    plant.name = 'Plant';
    const floor = new Mesh(new BoxGeometry(2, 2, 2), mat);
    floor.name = 'Floor';
    plant.add(floor);
    for (const name of ['Press_0', 'Press_1']) {
      const ref = new Object3D();
      ref.name = name;
      setAssetReference(ref, { assetId: 'press' });
      plant.add(ref);
    }
    const result = await loadGLB('plant.glb', new Scene(), {
      data: await objectToGlb(plant),
      referenceResolver: async () => ({ bytes: pressBytes, url: 'lib/press.glb', signatureState: 'none', signaturePresent: false }),
      preserveHierarchy: true,
      loadKinematicsSidecar: false,
    });
    expect(result.composition!.frames).toHaveLength(2);
    expect(result.registry.auditIdIndex()).toEqual(CLEAN);
    // Two occurrences of one file: the same ids, two addresses.
    const rams = [] as Object3D[];
    result.root.traverse((n) => { if (n.name === 'Ram') rams.push(n); });
    expect(rams).toHaveLength(2);
    expect(identityIdOf(rams[0]!)).toBe(identityIdOf(rams[1]!));
    expect(result.registry.getAddressForNode(rams[0]!)).not.toBe(result.registry.getAddressForNode(rams[1]!));
    // plan-769 F12 (Phase 1b): the occurrence segment IS the reference node's identity
    // (its decode seed here — the file wrote no NodeId), never a positional `@ordinal`.
    const refs = ['Press_0', 'Press_1'].map((name) => {
      let hit: Object3D | null = null;
      result.root.traverse((n) => { if (!hit && n.name === name) hit = n; });
      return hit as Object3D | null;
    });
    expect(refs.every((r) => r && identityIdOf(r))).toBe(true);
    expect(result.composition!.frames.map((f) => f.occurrence).sort())
      .toEqual(refs.map((r) => identityIdOf(r!)!).sort());
    expect(result.composition!.frames.some((f) => f.occurrence.includes('@'))).toBe(false);
  });
});

describe('plan-769 9.21 — id index == traversal after every op, undo and redo (Phase 2)', () => {
  it('an editing session: every step, every undo, every redo keeps the invariant and no identity twice', async () => {
    const { registry, root, doc } = await loadOpIdentityFixture();
    const audit = (label: string): void => {
      expect(registry.auditIdIndex(), label).toEqual(CLEAN);
      const ids = [...identities(root).values()];
      expect(ids.length - new Set(ids).size, `${label}: an identity twice`).toBe(0);
    };
    audit('load');
    const part = new Group();
    part.name = 'Part';
    const body = new Mesh(tri(3), new MeshStandardMaterial());
    body.name = 'Body';
    part.add(body);
    const cad = { glb: await objectToGlb(part), cadlink: { File: 'p.step', Sha256: 'sha-921', Quality: 'source', ImportScaleFactor: 0.001, ZIsUpVector: false } };
    const steps: Array<[string, () => Promise<unknown>]> = [
      ['createNode', () => doc.createEmptyNode(null, 'Empty')],
      ['cloneNode', () => doc.cloneNode('Cell/Sep')],
      ['cloneNode of the copy', () => doc.cloneNode('Cell/Sep_1')],
      ['separateMesh', () => doc.separateMesh('Cell/Islands', 'islands')],
      ['mergeMesh', () => doc.mergeMesh('Cell/Asm')],
      ['importCad', () => doc.importCad(cad as never)],
      ['importCad again', () => doc.importCad(cad as never)],
      ['renameNode', () => doc.renameNodeAwaited('Cell/Cylinder', 'Roller')],
      ['reparentNode', () => doc.reparentNodes(['Cell/Roller'], 'Cell/Empty')],
      ['deleteNode', async () => { doc.deleteNode('Cell/Sep'); await doc.whenIdle(); }],
    ];
    for (const [label, run] of steps) { await run(); await doc.whenIdle(); audit(label); }
    for (const [label] of [...steps].reverse()) { await doc.undo(); audit(`undo ${label}`); }
    for (const [label] of steps) { await doc.redo(); audit(`redo ${label}`); }
    doc.dispose();
  });
});
