// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-757 Phase 1a — `BakeRegistry.instantiate()` clones the WHOLE template
 * (D2 / F3). Before: only logic nodes, keep meshes and chunk parents — a
 * survivor without a registered capability (`LogicStep_*`, `PLC*`), a bare
 * reference target and a plugin-claimed leaf never reached a placement.
 *
 *  - an unregistered component type, a bare reference target and a claimed
 *    node reach the instance, with the template's extras;
 *  - `nodeOf` covers every non-chunk template node, so a hit on a bare pick
 *    owner resolves to ITS instance node, not the root (plan-756 table);
 *  - the alias table is resolved per instance (D4);
 *  - `release()` leaves no node under the root, no registry entry, no alias;
 *  - two documents in sequence leak nothing.
 */
import { describe, it, expect } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshStandardMaterial, Object3D } from 'three';
import '../src/core/engine/rv-scene-loader';
import { detectRenamedNodes, gltfLoader, type GltfParserLike } from '../src/core/engine/rv-glb-parse';
import { objectToGlb, sceneMirroringLoad } from '../src/core/import/rv-import-object';
import { prepareAndBake } from '../src/core/engine/rv-prepare-and-bake';
import { BakeRegistry, RV_BAKE_CHUNK_KEY } from '../src/core/engine/rv-bake-registry';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { RVUberMaterial } from '../src/core/engine/rv-uber-material';
import { GroupRegistry } from '../src/core/engine/rv-group-registry';
import { releasePlacedGroups } from '../src/core/engine/rv-placement-integrate';
import { setAssetReference, setPlacementMeta } from '../src/core/engine/rv-asset-reference';
import { setNodeId } from '../src/core/engine/rv-node-id';
import type { RVViewer } from '../src/core/rv-viewer';
import { inlinePickPort } from './fixtures/bake-fixture';

const uber = new RVUberMaterial(false);

function box(name: string, pos: [number, number, number], color: number, extras?: Record<string, unknown>): Mesh {
  const m = new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial({ color }));
  m.name = name;
  m.position.set(...pos);
  if (extras) m.userData.realvirtual = extras;
  return m;
}

function node(name: string, pos: [number, number, number] = [0, 0, 0], extras?: Record<string, unknown>): Object3D {
  const n = new Object3D();
  n.name = name;
  n.position.set(...pos);
  if (extras) n.userData.realvirtual = extras;
  return n;
}

/**
 *   Machine
 *   ├─ Frame                    bare mesh → merged, removed
 *   ├─ Mount                    BARE node, target of Kine's KinematicParent → survives as a reference target
 *   ├─ Cad
 *   │   └─ Kine {Kinematic→Mount, Drive}  re-parented under Mount by the hook
 *   │       └─ Tool             mesh → mover chunk (the NODE is merged away)
 *   ├─ Axis {Drive}             boundary
 *   │   └─ Axis {Drive}         SAME NAME as its parent → glTF dedups it (`Axis_1`) → alias
 *   │       └─ arm              mesh → mover chunk (the NODE is merged away)
 *   ├─ Seq {LogicStep_SerialContainer}   unregistered component type
 *   │   └─ Go {LogicStep_DriveTo}
 *   ├─ Signals/Speed {PLCOutputFloat}
 *   └─ Label                    bare mesh a plugin claims (main model only, D5)
 */
function buildMachine(): Group {
  const root = new Group();
  root.name = 'Machine';
  root.add(box('Frame', [0, 0, 0], 0x777777));
  root.add(node('Mount', [0, 0.5, 0]));
  const cad = node('Cad', [1, 0, 0]);
  const kine = node('Kine', [0, 0.4, 0], {
    Kinematic: { KinematicParentEnable: true, Parent: 'Machine/Mount' },
    Drive: { Direction: 'LinearX', TargetSpeed: 100 },
  });
  kine.add(box('Tool', [0, 0.1, 0], 0x99cc33));
  cad.add(kine);
  root.add(cad);
  const axis = node('Axis', [-2, 0, 0], { Drive: { Direction: 'LinearY', TargetSpeed: 100 } });
  const inner = node('Axis', [0, 0.2, 0], { Drive: { Direction: 'LinearX', TargetSpeed: 50 } });
  inner.add(box('arm', [0, 0.5, 0], 0x3366cc));
  axis.add(inner);
  root.add(axis);
  const seq = node('Seq', [0, 0, 0], { LogicStep_SerialContainer: { AutoLoop: true } });
  seq.add(node('Go', [0, 0, 0], { LogicStep_DriveTo: { drive: { type: 'ComponentReference', path: 'Machine/Axis', componentType: 'realvirtual.Drive' }, Destination: 100 } }));
  root.add(seq);
  const signals = node('Signals');
  signals.add(node('Speed', [0, 0, 0], { PLCOutputFloat: { Name: 'Speed', Status: { Value: 1 } } }));
  root.add(signals);
  root.add(box('Label', [0, 2, 0], 0xffffff));
  return root;
}

async function bakeMachine(assetId: string, claims?: Array<{ path: string; role: 'merge' | 'chunk' }>) {
  // The root becomes the file's scene — what `_decode` hands the recipe as `tmp`.
  const gltf = await gltfLoader.parseAsync(await objectToGlb(sceneMirroringLoad(buildMachine())), '');
  // The parser's reconciliation, as `_decode` / `loadAndPrepareGLTF` run it.
  const renamedNodes = detectRenamedNodes((gltf as unknown as { parser?: GltfParserLike }).parser);
  return prepareAndBake(gltf.scene, {
    assetId, renamedNodes, signatureState: 'none', uber, isWebGPU: false, pickPort: inlinePickPort(),
    claims: claims ? { list: claims, complete: true } : undefined,
  });
}

function names(root: Object3D): string[] {
  const out: string[] = [];
  root.traverse((n) => { if (n !== root && n.userData?.[RV_BAKE_CHUNK_KEY] !== true) out.push(n.name); });
  return out.sort();
}

describe('instantiate() clones the whole template (plan-757 D2 / F3)', () => {
  it('unregistered component type, bare reference target and claimed node reach the instance, with their extras', async () => {
    const baked = await bakeMachine('whole', [{ path: 'Label', role: 'merge' }]);
    const reg = new BakeRegistry();
    const root = new Group();
    const inst = reg.instantiate(baked, root);

    const got = names(root);
    for (const n of ['Mount', 'Kine', 'Axis', 'Axis_1', 'Seq', 'Go', 'Signals', 'Speed', 'Label']) {
      expect(got, n).toContain(n);
    }
    // Merged, unclaimed geometry is not a node — on the template nor on the
    // instance: the bare frame, and the meshes under a boundary (their
    // triangles live in the mover chunks).
    for (const n of ['Frame', 'Tool', 'arm', 'Cad']) expect(got, n).not.toContain(n);
    expect(names(root)).toEqual(names(baked.template));
    // The hook re-parented on tmp; the instance carries the FINAL hierarchy.
    expect(root.getObjectByName('Kine')!.parent!.name).toBe('Mount');
    // Extras travel (JSON-cloned) and are the instance's own.
    const seq = root.getObjectByName('Seq')!;
    expect((seq.userData.realvirtual as Record<string, unknown>).LogicStep_SerialContainer).toEqual({ AutoLoop: true });
    expect(seq.userData.realvirtual).not.toBe(baked.template.getObjectByName('Seq')!.userData.realvirtual);
    // `logicNodes` stays an INDEX into the clone (same order as the asset's).
    expect(inst.logicNodes.length).toBe(baked.logicNodes.length);
    for (let i = 0; i < inst.logicNodes.length; i++) {
      expect(inst.nodeOf.get(baked.logicNodes[i].template)).toBe(inst.logicNodes[i]);
    }
    // Every non-chunk template node is mapped.
    let templateNodes = 0;
    baked.template.traverse((t) => { if (t.userData?.[RV_BAKE_CHUNK_KEY] !== true) templateNodes++; });
    expect(inst.nodeOf.size).toBe(templateNodes);
    reg.release(inst);
    baked.dispose();
  });

  it('the pick structure answers over the larger instance: hits, highlight targets, bare survivors', async () => {
    const baked = await bakeMachine('pick');
    const reg = new BakeRegistry();
    const root = new Group();
    const inst = reg.instantiate(baked, root);
    // A hit on the re-parented `Kine` mover (its ordinal → its INSTANCE node,
    // under the instance's Mount — not the root, not the template).
    const kineT = baked.template.getObjectByName('Kine')!;
    const ordinal = baked.nodeTable.ordinalOf.get(kineT);
    expect(ordinal).toBeDefined();
    const kineChunk = inst.chunks.find((m) => inst.chunkOf.get(m)!.owner === kineT)!;
    const hit = reg.resolveHit(kineChunk, ordinal!);
    expect(hit).toBe(root.getObjectByName('Kine'));
    expect((hit as Object3D).parent).toBe(root.getObjectByName('Mount'));
    // The nested renamed drive owns its own chunk, resolved through `_templateOf`.
    const inner = root.getObjectByName('Axis_1')!;
    const innerTargets = reg.chunkTargetsOf(inner)!;
    expect(innerTargets.map((t) => t.mesh)).toEqual([inst.chunks.find((m) => inst.chunkOf.get(m)!.ownerPath === 'Axis/Axis_1')]);
    // The bare reference target `Mount` now PARENTS the re-parented mover: its
    // subtree's chunk geometry is Kine's whole chunk (a descendant boundary).
    expect(reg.chunkTargetsOf(root.getObjectByName('Mount')!)!.map((t) => t.mesh)).toEqual([kineChunk]);
    // A bare survivor without geometry below it (`Signals`) is an instance node
    // the table knows: nothing to draw → null, never a throw or 'none'.
    expect(reg.chunkTargetsOf(root.getObjectByName('Signals')!)).toBeNull();
    expect(reg.placementOf(root.getObjectByName('Speed')!)).toBe(root);
    reg.release(inst);
    baked.dispose();
  });

  it('the alias table is resolved per instance and registered under the instance root path (D4)', async () => {
    const baked = await bakeMachine('alias');
    const paths = baked.aliases.map((a) => a.path).sort();
    // Re-parented authored path + the renamed inner drive (both spellings
    // collapse to one here) + the chunk mesh under it.
    expect(paths).toContain('Cad/Kine');
    expect(paths).toContain('Axis/Axis');
    expect(paths.some((p) => p.startsWith('Axis/Axis/mover:'))).toBe(true);

    const reg = new BakeRegistry();
    const scene = new Group(); scene.name = 'Layout';
    const root = new Group(); root.name = 'Machine_1';
    scene.add(root);
    const inst = reg.instantiate(baked, root);
    expect(inst.aliases.map((a) => a.path).sort()).toEqual(paths);
    expect(inst.aliases.find((a) => a.path === 'Cad/Kine')!.node).toBe(root.getObjectByName('Kine'));

    // What the place step does with them (`initSubtree` step 2b), against a runtime registry.
    const registry = new NodeRegistry();
    root.traverse((n) => registry.registerNode(NodeRegistry.computeNodePath(n), n));
    const rootPath = registry.getPathForNode(root)!;
    for (const { path, node } of inst.aliases) registry.registerAlias(`${rootPath}/${path}`, node);
    expect(registry.getNode('Machine_1/Cad/Kine')).toBe(root.getObjectByName('Kine'));
    expect(registry.getNode('Machine_1/Axis/Axis')).toBe(root.getObjectByName('Axis_1'));

    // The runtime registry drops the aliases with the subtree (the host
    // unregisters BEFORE the instance is taken apart, as the planner does) …
    registry.unregisterSubtree(root);
    expect(registry.getNode('Machine_1/Cad/Kine')).toBeNull();
    expect(registry.getNode('Machine_1/Axis/Axis')).toBeNull();
    expect(registry.getPathForNode(root.getObjectByName('Axis_1')!)).toBeNull();
    // … and release leaves no node, no registry entry, no alias.
    const chunk = inst.chunks[0];
    reg.release(inst);
    expect(root.children.length).toBe(0);
    expect(reg.instanceOf(root)).toBeNull();
    expect(reg.instanceOfMesh(chunk)).toBeNull();
    expect(reg.pickMeshes).not.toContain(chunk);
    expect(inst.aliases).toEqual([]);
    baked.dispose();
  });

  it('two documents in sequence leak nothing', async () => {
    const reg = new BakeRegistry();
    for (const doc of ['doc-1', 'doc-2']) {
      const baked = await bakeMachine(doc);
      const roots = [new Group(), new Group(), new Group()];
      const insts = roots.map((r) => reg.instantiate(baked, r));
      expect(reg.stats().instances).toBe(3);
      expect(baked.instances).toBe(3);
      for (const inst of insts) reg.release(inst);
      expect(reg.stats()).toMatchObject({ instances: 0, assets: 0, chunkMeshes: 0, keepMeshes: 0 });
      expect(baked.instances).toBe(0);
      for (const r of roots) expect(r.children.length).toBe(0);
      baked.retired = true;
      baked.release(); // refcount already 0 on a retired asset → disposed by the last release below
      expect(baked.disposed).toBe(true);
    }
    expect(reg.pickMeshes).toEqual([]);
  });

  it('removing a placement takes its nodes out of the viewer-wide groups — no dead members (plan-757 1b)', async () => {
    const baked = await bakeMachine('groups-release');
    const reg = new BakeRegistry();
    const root = new Group();
    root.name = 'Machine_1';
    const inst = reg.instantiate(baked, root);
    // What `integratePlacedContent` does for a placement: its group members
    // join the viewer-wide registry by NAME. Two placements' members share one name.
    const groups = new GroupRegistry();
    const other = new Object3D();
    other.name = 'Machine_2/Axis';
    groups.register('Carriage', root.getObjectByName('Axis')!);
    groups.register('Carriage', root.getObjectByName('Kine')!);
    groups.register('Carriage', other);
    groups.register('OnlyHere', root.getObjectByName('Mount')!);
    const emitted: unknown[] = [];
    const viewer = { groups, registry: null, emit: (name: string, data: unknown) => emitted.push([name, data]) } as unknown as RVViewer;

    expect(releasePlacedGroups(viewer, root)).toBe(true);
    // The other placement's member stays; the group emptied by the release is gone.
    expect(groups.get('Carriage')!.nodes).toEqual([other]);
    expect(groups.get('OnlyHere')).toBeUndefined();
    let dead = 0;
    for (const g of groups.getAll()) for (const n of g.nodes) if (n === root || root.getObjectById(n.id) === n) dead++;
    expect(dead).toBe(0);
    expect(emitted).toEqual([['groups-changed', { source: 'placement' }]]);
    // Idempotent: a second release moves nothing and says nothing.
    expect(releasePlacedGroups(viewer, root)).toBe(false);
    expect(emitted).toHaveLength(1);
    reg.release(inst);
    baked.dispose();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// plan-757 Phase 2 (F4) — a nested instance goes with its owner
// ═══════════════════════════════════════════════════════════════════════

describe('releaseSubtree — removing a placement takes its NESTED instances apart too (plan-757 Phase 2, F4)', () => {
  /** Outer asset: a frame mesh + one planner reference node (kept EMPTY by the recipe — `AssetReference` claims it, F15). */
  async function bakeOuter(assetId: string) {
    const root = new Group();
    root.name = 'Line';
    root.add(box('Floor', [0, 0, 0], 0x555555));
    const ref = new Object3D();
    ref.name = 'Machine_1';
    ref.position.set(4, 0, 0);
    setNodeId(ref, 'nid-machine');
    setAssetReference(ref, { assetId: 'cat:machine', path: 'blob:rv-test/whole-template-machine.glb' });
    setPlacementMeta(ref, {});
    root.add(ref);
    const gltf = await gltfLoader.parseAsync(await objectToGlb(sceneMirroringLoad(root)), '');
    const renamedNodes = detectRenamedNodes((gltf as unknown as { parser?: GltfParserLike }).parser);
    return prepareAndBake(gltf.scene, {
      assetId, renamedNodes, signatureState: 'none', uber, isWebGPU: false, pickPort: inlinePickPort(),
    });
  }

  it('instances −(1 + M), pick meshes, drives, groups, both assets retired — innermost first, idempotent', async () => {
    const outer = await bakeOuter('release-outer');
    const inner = await bakeMachine('release-inner');
    const templateRef = outer.template.getObjectByName('Machine_1')!;
    expect(templateRef, 'the reference node survived the bake, empty').toBeDefined();
    expect(templateRef.children.filter((c) => c.userData?.[RV_BAKE_CHUNK_KEY] !== true)).toHaveLength(0);

    const reg = new BakeRegistry();
    const root = new Group();
    root.name = 'Line_1';
    const outerInst = reg.instantiate(outer, root);
    // What the instancer does with the clone of the reference node: it is the
    // ROOT of a nested instance of the inner asset.
    const nestedRoot = outerInst.nodeOf.get(templateRef)!;
    expect(nestedRoot.parent).toBe(root);
    const innerInst = reg.instantiate(inner, nestedRoot);
    expect(reg.stats()).toMatchObject({ instances: 2, assets: 2 });
    expect(outer.instances).toBe(1);
    expect(inner.instances).toBe(1);
    const innerChunk = innerInst.chunks[0];
    const outerChunk = outerInst.chunks[0];

    // Innermost first: the nested root before the outer root.
    expect(reg.instanceRootsUnder(root)).toEqual([nestedRoot, root]);
    expect(reg.instanceRootsUnder(nestedRoot)).toEqual([nestedRoot]);
    expect(reg.instanceRootsUnder(new Group())).toEqual([]);

    // The viewer-wide groups (names global): a nested node is a member too.
    const groups = new GroupRegistry();
    groups.register('Carriage', nestedRoot.getObjectByName('Axis')!);
    groups.register('Carriage', nestedRoot.getObjectByName('Kine')!);
    const viewer = { groups, registry: null, emit: () => {} } as unknown as RVViewer;
    expect(releasePlacedGroups(viewer, root), 'the subtree sync reaches nested content').toBe(true);
    expect(groups.get('Carriage')).toBeUndefined();

    // THE release.
    expect(reg.releaseSubtree(root)).toBe(2);
    expect(reg.stats()).toMatchObject({ instances: 0, assets: 0, chunkMeshes: 0, keepMeshes: 0 });
    expect(reg.instanceOf(root)).toBeNull();
    expect(reg.instanceOf(nestedRoot)).toBeNull();
    expect(reg.instanceOfMesh(innerChunk)).toBeNull();
    expect(reg.instanceOfMesh(outerChunk)).toBeNull();
    expect(reg.pickMeshes).toEqual([]);
    expect(innerInst.released).toBe(true);
    expect(outerInst.released).toBe(true);
    // Nothing of the nested instance is left under the (now detached) nested root; the outer root is empty.
    expect(nestedRoot.children).toHaveLength(0);
    expect(root.children).toHaveLength(0);
    // Refcounts back to 0 — a retired asset would now dispose.
    expect(outer.instances).toBe(0);
    expect(inner.instances).toBe(0);
    // Idempotent.
    expect(reg.releaseSubtree(root)).toBe(0);
    for (const b of [outer, inner]) { b.retired = true; b.release(); expect(b.disposed).toBe(true); }
  });
});
