// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Mesh separator — op / executor layer (plan-331, section 9: tests 9.6, 9.7,
 * 9.10, 9.11, 9.12, 9.14, 9.15, 9.16).
 *
 * The geometry core is covered by `rv-mesh-separator.test.ts`; what is at stake
 * here is the INTEGRATION — the part the plan review kept finding holes in:
 * the Group replacement (transform, children, userData, components), undo/redo
 * ordering, verbatim child names on replay, and the BVH abort.
 *
 * The mock viewer follows `rv-asset-create-reparent.test.ts`: a real
 * `NodeRegistry` and a real three `Scene`, no renderer.
 */

import { describe, it, expect } from 'vitest';
import {
  BufferAttribute,
  BufferGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  Scene,
  Vector3,
} from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { RVViewer } from '../src/core/rv-viewer';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { AssetDocument } from '../src/core/editor/rv-asset-document';
import {
  assetOpHeader,
  assetOpTouchesHierarchy,
  classifyAssetOpRaycastImpact,
  type SeparateMeshOp,
} from '../src/core/editor/rv-asset-ops';
import { canCoalesceRvOps, describeRvOp, type RvAssetOp } from '../src/core/ops/rv-unified-ops';
import { exportAssetGlb } from '../src/core/editor/rv-asset-glb-export';
import { computeBVHAsync } from '../src/core/engine/rv-scene-loader';
import type { BVHBuildPort } from '../src/core/engine/rv-bvh-build-port';
import {
  registerComponent,
  type ComponentContext,
  type RVComponent,
} from '../src/core/engine/rv-component-registry';

// ─── Fixtures ───────────────────────────────────────────────────────────

/** Two disjoint triangles 10 units apart — the canonical two-island geometry. */
function twoIslandGeometry(): BufferGeometry {
  const geom = new BufferGeometry();
  geom.setAttribute('position', new BufferAttribute(new Float32Array([
    0, 0, 0, 1, 0, 0, 0, 1, 0,
    10, 0, 0, 11, 0, 0, 10, 1, 0,
  ]), 3));
  geom.setIndex(new BufferAttribute(new Uint32Array([0, 1, 2, 3, 4, 5]), 1));
  return geom;
}

/** One triangle — a single island, nothing to separate. */
function oneIslandGeometry(): BufferGeometry {
  const geom = new BufferGeometry();
  geom.setAttribute('position', new BufferAttribute(new Float32Array([
    0, 0, 0, 1, 0, 0, 0, 1, 0,
  ]), 3));
  geom.setIndex(new BufferAttribute(new Uint32Array([0, 1, 2]), 1));
  return geom;
}

interface MockViewer {
  viewer: RVViewer;
  scene: Scene;
  model: Group;
  registry: NodeRegistry;
  /** (root, isAlive) pairs handed to `buildMeshBvhsAsync`. */
  bvhCalls: { root: Object3D; isAlive?: () => boolean }[];
  register(): void;
}

function makeMockViewer(opts?: { runtime?: boolean }): MockViewer {
  const scene = new Scene();
  const model = new Group();
  model.name = 'Asset';
  scene.add(model);

  const registry = new NodeRegistry();
  const register = (): void => {
    model.traverse((n) => registry.registerNode(NodeRegistry.computeNodePath(n), n));
  };

  const bvhCalls: { root: Object3D; isAlive?: () => boolean }[] = [];
  const runtime = opts?.runtime === true;

  const viewer = {
    scene,
    registry,
    // A stub SignalStore/TransportManager is enough to unlock the component
    // rebuild: `processExtras` only touches them for signals and topology.
    // The six collections are REAL arrays, not omitted: the teardown prunes the
    // components it disposed out of them, exactly as the layout planner does on
    // removal, and the real manager always carries them.
    signalStore: runtime ? { buildIndex() {}, remapPaths() {} } : null,
    transportManager: runtime
      ? {
        notifyTopologyChanged() {},
        sensors: [], surfaces: [], sources: [], sinks: [], grips: [], gripTargets: [],
      }
      : null,
    drives: [] as unknown[],
    logicRunState: 'active',
    get currentModelRoot() { return model; },
    // The index itself is not under test; its presence is what gates the BVH
    // call, and `removeSubtree`/`addSubtree` must be tolerated.
    instancePickIndex: {
      addSubtree() {}, removeSubtree() {}, bumpResolutionEpoch() {},
    },
    buildMeshBvhsAsync(root: Object3D, isAlive?: () => boolean) {
      bvhCalls.push({ root, isAlive });
    },
    registerDeferredLogic() {},
    markRenderDirty() {},
    markShadowsDirty() {},
    emit() {},
    on() { return () => {}; },
    rebuildGroupedBvh() {},
    selectionManager: { select() {} },
  } as unknown as RVViewer;

  return { viewer, scene, model, registry, bvhCalls, register };
}

function addMesh(
  parent: Object3D,
  name: string,
  geometry: BufferGeometry = twoIslandGeometry(),
): Mesh {
  const mesh = new Mesh(geometry, new MeshStandardMaterial({ color: 0x336699 }));
  mesh.name = name;
  parent.add(mesh);
  return mesh;
}

function childNames(node: Object3D): string[] {
  return node.children.map((c) => c.name);
}

function trashGroup(scene: Scene): Object3D | null {
  return scene.children.find((c) => c.name === '_rvAssetTrash') ?? null;
}

// ─── 9.6 — op semantics across all five places ──────────────────────────

describe('9.6 separateMesh op semantics', () => {
  const op: SeparateMeshOp = {
    ...assetOpHeader(),
    kind: 'separateMesh',
    sourcePath: 'Asset/Box',
    mode: 'islands',
    weldThreshold: 0.0001,
    childNames: ['Box_part0', 'Box_part1'],
  };

  it('never coalesces — a split is one deliberate action', () => {
    const next: SeparateMeshOp = { ...op, ...assetOpHeader() };
    expect(canCoalesceRvOps(op, next)).toBe(false);
    // Also not against a different kind, and not in either order.
    const other: RvAssetOp = {
      ...assetOpHeader(), kind: 'renameNode', nodePath: 'Asset/Box', name: 'B', prevName: 'Box',
    };
    expect(canCoalesceRvOps(op, other)).toBe(false);
    expect(canCoalesceRvOps(other, op)).toBe(false);
  });

  it('touches the hierarchy, forces a raycast rebuild, and describes itself', () => {
    expect(assetOpTouchesHierarchy(op)).toBe(true);
    const impact = classifyAssetOpRaycastImpact(op);
    expect(impact.rebuild).toBe(true);
    expect(impact.refitPaths).toEqual([]);
    expect(describeRvOp(op)).toBe('Separate Box (2 parts)');
  });

  it('propagates through a composite', () => {
    const composite: RvAssetOp = {
      ...assetOpHeader(), kind: 'composite', label: 'Batch', ops: [op],
    };
    expect(assetOpTouchesHierarchy(composite)).toBe(true);
    expect(classifyAssetOpRaycastImpact(composite).rebuild).toBe(true);
  });
});

// ─── 9.7 — undo / redo / replay ─────────────────────────────────────────

describe('9.7 undo, redo and replay', () => {
  it('undo restores the exact source mesh; redo leaves exactly one live node at the path', async () => {
    const { viewer, scene, model, registry, register } = makeMockViewer();
    const source = addMesh(model, 'Box');
    register();
    const doc = AssetDocument.newUntitled(viewer);

    const names = await doc.separateMesh('Asset/Box', 'islands');
    expect(names).toEqual(['Box_part0', 'Box_part1']);

    for (let cycle = 0; cycle < 3; cycle++) {
      // ── applied state ──
      const group = registry.getNode('Asset/Box')!;
      expect(group).not.toBeNull();
      expect((group as Mesh).isMesh).toBeUndefined();
      expect(childNames(group)).toEqual(['Box_part0', 'Box_part1']);
      expect(registry.getNode('Asset/Box/Box_part0')).not.toBeNull();
      // Exactly ONE node named Box under the model — the parked original must
      // not be a live sibling.
      expect(model.children.filter((c) => c.name === 'Box')).toHaveLength(1);
      expect(source.parent?.name).toBe('_rvAssetTrash');

      await doc.undo();
      // ── undone state ──
      expect(registry.getNode('Asset/Box')).toBe(source);
      expect(source.parent).toBe(model);
      expect(model.children.filter((c) => c.name === 'Box')).toHaveLength(1);
      expect(registry.getNode('Asset/Box/Box_part0')).toBeNull();
      expect(trashGroup(scene)!.children.some((c) => c.name === 'Box')).toBe(true);

      await doc.redo();
    }

    expect(registry.getNode('Asset/Box')).not.toBe(source);
    doc.dispose();
  });

  it('replays as the first op on a loaded base AND after other ops', async () => {
    // (a) split is the very first op — the "libraryGlb base" entry path.
    {
      const { viewer, model, registry, register } = makeMockViewer();
      addMesh(model, 'Box');
      register();
      const doc = AssetDocument.newUntitled(viewer);
      const op: SeparateMeshOp = {
        ...assetOpHeader(), kind: 'separateMesh', sourcePath: 'Asset/Box',
        mode: 'islands', weldThreshold: 0.0001, childNames: ['Box_part0', 'Box_part1'],
      };
      await doc.replayOps([op]);
      expect(childNames(registry.getNode('Asset/Box')!)).toEqual(['Box_part0', 'Box_part1']);
      doc.dispose();
    }
    // (b) split after a preceding op on the same node.
    {
      const { viewer, model, registry, register } = makeMockViewer();
      addMesh(model, 'Raw');
      register();
      const doc = AssetDocument.newUntitled(viewer);
      const rename: RvAssetOp = {
        ...assetOpHeader(), kind: 'renameNode', nodePath: 'Asset/Raw', name: 'Box', prevName: 'Raw',
      };
      const split: SeparateMeshOp = {
        ...assetOpHeader(), kind: 'separateMesh', sourcePath: 'Asset/Box',
        mode: 'islands', weldThreshold: 0.0001, childNames: ['Box_part0', 'Box_part1'],
      };
      await doc.replayOps([rename, split]);
      expect(childNames(registry.getNode('Asset/Box')!)).toEqual(['Box_part0', 'Box_part1']);
      doc.dispose();
    }
  });
});

// ─── 9.10 — transform and matrix flags ──────────────────────────────────

describe('9.10 transform preservation', () => {
  it('parts stay world-identical under a transformed parent with non-uniform, negative scale', async () => {
    const { viewer, model, registry, register } = makeMockViewer();
    const holder = new Object3D();
    holder.name = 'Holder';
    holder.position.set(3, -2, 7);
    holder.rotation.set(0.4, 1.1, -0.7);
    holder.scale.set(2, -1.5, 0.5); // non-uniform AND mirrored
    model.add(holder);
    const source = addMesh(holder, 'Box');
    source.position.set(0.25, 1, -0.5);
    source.scale.set(1.5, 1, 3);
    register();
    model.updateMatrixWorld(true);

    const worldBefore = source.localToWorld(new Vector3(10, 0, 0)); // a vertex of island B

    const doc = AssetDocument.newUntitled(viewer);
    await doc.separateMesh('Asset/Holder/Box', 'islands');

    const group = registry.getNode('Asset/Holder/Box')!;
    group.updateMatrixWorld(true);
    const part = registry.getNode('Asset/Holder/Box/Box_part1')!;
    const worldAfter = part.localToWorld(new Vector3(10, 0, 0));
    expect(worldAfter.distanceTo(worldBefore)).toBeLessThan(1e-4);
    doc.dispose();
  });

  it('carries BOTH auto-update flags over, and a later updateMatrixWorld moves nothing', async () => {
    const { viewer, model, registry, register } = makeMockViewer();
    const source = addMesh(model, 'Box');
    source.position.set(5, 6, 7);
    register();
    model.updateMatrixWorld(true);
    // What `freezeStaticMatrices()` leaves behind on a static node.
    source.matrixAutoUpdate = false;
    source.matrixWorldAutoUpdate = false;
    const bakedWorld = source.matrixWorld.clone();

    const doc = AssetDocument.newUntitled(viewer);
    await doc.separateMesh('Asset/Box', 'islands');

    const group = registry.getNode('Asset/Box')!;
    expect(group.matrixAutoUpdate).toBe(false);
    expect(group.matrixWorldAutoUpdate).toBe(false);
    expect(group.matrixWorld.elements).toEqual(bakedWorld.elements);

    // A later forced pass must not shift the frozen group.
    model.updateMatrixWorld(true);
    expect(group.matrixWorld.elements).toEqual(bakedWorld.elements);
    doc.dispose();
  });
});

// ─── 9.11 — GLB export round-trip ───────────────────────────────────────

describe('9.11 GLB export round-trip', () => {
  it('group path, part geometries, extras and existing children survive export + re-parse', async () => {
    const { viewer, model, register } = makeMockViewer();
    const source = addMesh(model, 'Box');
    source.userData['realvirtual'] = { CADLink: { File: 'box.step', Sha256: 'deadbeef', Quality: 'standard', ImportScaleFactor: 0.001, ZIsUpVector: true } };
    const pivot = new Object3D();
    pivot.name = 'Pivot';
    source.add(pivot);
    register();
    model.updateMatrixWorld(true);

    const doc = AssetDocument.newUntitled(viewer);
    await doc.separateMesh('Asset/Box', 'islands');

    const glb = await exportAssetGlb(model);
    const gltf = await new GLTFLoader().parseAsync(glb, '');

    const findByName = (root: Object3D, name: string): Object3D | null => {
      let hit: Object3D | null = null;
      root.traverse((n) => { if (!hit && n.name === name) hit = n; });
      return hit;
    };

    const group = findByName(gltf.scene, 'Box') as Object3D | null;
    expect(group).not.toBeNull();
    // The source's rv_extras rode along on the deep-copied userData.
    expect((group!.userData['realvirtual'] as Record<string, unknown>)['CADLink']).toBeDefined();
    // The pre-existing child node is still there, next to the two parts.
    expect(findByName(group!, 'Pivot')).not.toBeNull();

    for (const name of ['Box_part0', 'Box_part1']) {
      const part = findByName(gltf.scene, name) as Mesh | null;
      expect(part, name).not.toBeNull();
      expect(part!.parent?.name).toBe('Box');
      const geom = part!.geometry as BufferGeometry;
      expect(geom.getAttribute('position').count).toBe(3);
      expect(geom.index!.count).toBe(3);
      expect(part!.material).toBeTruthy();
    }
    doc.dispose();
  });
});

// ─── 9.12 — missing source geometry ─────────────────────────────────────

describe('9.12 missing source', () => {
  it('replays as a COLLECTED, user-recoverable failure — never a silent no-op', async () => {
    const { viewer, model, registry, register } = makeMockViewer();
    addMesh(model, 'Box');
    register();
    const doc = AssetDocument.newUntitled(viewer);

    const op: SeparateMeshOp = {
      ...assetOpHeader(), kind: 'separateMesh', sourcePath: 'Asset/Gone',
      mode: 'islands', weldThreshold: 0.0001, childNames: ['Gone_part0', 'Gone_part1'],
    };
    // Does not reject: the rest of the draft must still replay …
    await expect(doc.replayOps([op])).resolves.toBeUndefined();
    // … and the draft is NOT emptied.
    expect(doc.getSnapshot().opCount).toBe(1);
    // The rest of the tree is untouched.
    expect((registry.getNode('Asset/Box') as Mesh).isMesh).toBe(true);

    // The point of the rewrite: the split that never happened is REPORTED, so
    // the user can re-import instead of editing a tree the draft misdescribes.
    const unapplied = doc.executor.takeUnappliedSeparations();
    expect(unapplied).toHaveLength(1);
    expect(unapplied[0].sourcePath).toBe('Asset/Gone');
    expect(unapplied[0].opId).toBe(op.id);
    expect(unapplied[0].reason).toMatch(/not a live mesh/);
    // Draining is one-shot, like `takeMissingCadGeometry`.
    expect(doc.executor.takeUnappliedSeparations()).toEqual([]);
    doc.dispose();
  });

  it('a replay divergence in the part count is reported too', async () => {
    const { viewer, model, registry, register } = makeMockViewer();
    addMesh(model, 'Box'); // two islands
    register();
    const doc = AssetDocument.newUntitled(viewer);

    const op: SeparateMeshOp = {
      ...assetOpHeader(), kind: 'separateMesh', sourcePath: 'Asset/Box',
      mode: 'islands', weldThreshold: 0.0001,
      // Three recorded names against a geometry that yields two parts.
      childNames: ['Box_part0', 'Box_part1', 'Box_part2'],
    };
    await doc.replayOps([op]);

    expect((registry.getNode('Asset/Box') as Mesh).isMesh).toBe(true);
    const unapplied = doc.executor.takeUnappliedSeparations();
    expect(unapplied).toHaveLength(1);
    expect(unapplied[0].reason).toMatch(/2 parts but 3 recorded names/);
    doc.dispose();
  });

  it('a single-island mesh produces no op at all', async () => {
    const { viewer, model, registry, register } = makeMockViewer();
    addMesh(model, 'Solid', oneIslandGeometry());
    register();
    const doc = AssetDocument.newUntitled(viewer);

    expect(await doc.separateMesh('Asset/Solid', 'islands')).toEqual([]);
    expect(doc.getSnapshot().opCount).toBe(0);
    expect((registry.getNode('Asset/Solid') as Mesh).isMesh).toBe(true);
    doc.dispose();
  });
});

// ─── 9.14 — children and components ─────────────────────────────────────

/** Probe component: records construction and disposal so the test can assert
 *  that the OLD instance died and a NEW one was built — not that the extras
 *  merely still read the right way. */
const built: SeparatorProbe[] = [];
class SeparatorProbe implements RVComponent {
  isOwner = true;
  disposed = false;
  constructor(readonly node: Object3D) { built.push(this); }
  init(_context: ComponentContext): void { /* nothing to wire */ }
  dispose(): void { this.disposed = true; }
}
registerComponent({
  type: 'SeparatorProbe',
  schema: {},
  create: (node) => new SeparatorProbe(node),
});

describe('9.14 children, userData and components', () => {
  it('children move under the group, extras are deep-copied, components are rebuilt', async () => {
    built.length = 0;
    const { viewer, model, registry, register } = makeMockViewer({ runtime: true });
    const source = addMesh(model, 'Box');
    source.userData['realvirtual'] = { SeparatorProbe: {}, Note: { text: 'source' } };
    const child = new Object3D();
    child.name = 'Bracket';
    child.userData['realvirtual'] = { SeparatorProbe: {} };
    source.add(child);
    register();
    model.updateMatrixWorld(true);

    // Components as they exist BEFORE the split.
    const doc = AssetDocument.newUntitled(viewer);
    const beforeCount = built.length;

    await doc.separateMesh('Asset/Box', 'islands');

    const group = registry.getNode('Asset/Box')!;
    // Children first, then the generated parts — a stable, documented order.
    expect(childNames(group)).toEqual(['Bracket', 'Box_part0', 'Box_part1']);
    expect(registry.getNode('Asset/Box/Bracket')).toBe(child);

    // userData survived AND is a distinct object from the parked original's.
    const groupRv = group.userData['realvirtual'] as Record<string, unknown>;
    expect(groupRv['Note']).toEqual({ text: 'source' });
    expect(groupRv).not.toBe(source.userData['realvirtual']);
    (groupRv['Note'] as Record<string, unknown>)['text'] = 'edited';
    expect((source.userData['realvirtual'] as Record<string, Record<string, unknown>>)['Note']['text'])
      .toBe('source');

    // Real registry instances: fresh ones exist, and no duplicates at a path.
    const fresh = built.slice(beforeCount);
    expect(fresh.length).toBeGreaterThanOrEqual(2); // group + bracket
    expect(registry.getComponentsAt('Asset/Box').filter(([t]) => t === 'SeparatorProbe'))
      .toHaveLength(1);
    expect(registry.getComponentsAt('Asset/Box/Bracket').filter(([t]) => t === 'SeparatorProbe'))
      .toHaveLength(1);

    // Undo tears the group's instances down again and gives the children back.
    const groupInstances = fresh.filter((c) => !c.disposed);
    await doc.undo();
    expect(groupInstances.every((c) => c.disposed)).toBe(true);
    expect(registry.getNode('Asset/Box')).toBe(source);
    expect(child.parent).toBe(source);
    doc.dispose();
  });

  it('redo carries a child that was added while the split was undone', async () => {
    const { viewer, model, registry, register } = makeMockViewer();
    const source = addMesh(model, 'Box');
    register();
    const doc = AssetDocument.newUntitled(viewer);

    await doc.separateMesh('Asset/Box', 'islands');
    await doc.undo();

    const late = new Object3D();
    late.name = 'Late';
    source.add(late);
    registry.registerNode(NodeRegistry.computeNodePath(late), late);

    await doc.redo();
    const group = registry.getNode('Asset/Box')!;
    // Same layout the forward pass produces: authored children first, parts after.
    expect(childNames(group)).toEqual(['Late', 'Box_part0', 'Box_part1']);
    // Nothing was left behind in the trash.
    expect(late.parent).toBe(group);
    doc.dispose();
  });

  it('undo → redo reproduces the forward tree exactly, children included', async () => {
    const { viewer, model, registry, register } = makeMockViewer();
    const source = addMesh(model, 'Box');
    const bracket = new Object3D();
    bracket.name = 'Bracket';
    source.add(bracket);
    register();
    const doc = AssetDocument.newUntitled(viewer);

    await doc.separateMesh('Asset/Box', 'islands');
    const forward = childNames(registry.getNode('Asset/Box')!);
    expect(forward).toEqual(['Bracket', 'Box_part0', 'Box_part1']);

    await doc.undo();
    await doc.redo();
    expect(childNames(registry.getNode('Asset/Box')!)).toEqual(forward);
    doc.dispose();
  });
});

// ─── runtime-collection / logic symmetry ────────────────────────────────

/**
 * Probe that enrols itself in a transport-manager collection on `init()`,
 * exactly as RVSensor/RVTransportSurface/RVSource do. Nothing but the teardown
 * un-enrols it — `dispose()` deliberately does not, which is what made the
 * collections grow on every separate/undo/redo cycle.
 */
class EnrollingProbe implements RVComponent {
  isOwner = true;
  constructor(readonly node: Object3D) {}
  init(context: ComponentContext): void {
    (context.transportManager.sensors as unknown[]).push(this);
  }
  dispose(): void { /* mirrors the real components: no self-removal */ }
}
registerComponent({
  type: 'EnrollingProbe',
  schema: {},
  create: (node) => new EnrollingProbe(node),
});

describe('runtime lifecycle symmetry', () => {
  it('separate → undo → redo does not grow the runtime collections', async () => {
    const { viewer, model, register } = makeMockViewer({ runtime: true });
    const source = addMesh(model, 'Box');
    source.userData['realvirtual'] = { EnrollingProbe: {} };
    register();
    const doc = AssetDocument.newUntitled(viewer);
    const tm = viewer.transportManager as unknown as { sensors: unknown[] };

    await doc.separateMesh('Asset/Box', 'islands');
    expect(tm.sensors).toHaveLength(1);

    // Every cycle rebuilds one probe and must retire the previous one. Before
    // the teardown pruned the collections this counted 2, 3, 4, …
    for (let i = 0; i < 3; i++) {
      await doc.undo();
      expect(tm.sensors).toHaveLength(1);
      await doc.redo();
      expect(tm.sensors).toHaveLength(1);
    }
    doc.dispose();
  });

  it('drops a torn-down drive out of viewer.drives', async () => {
    const { viewer, model, registry, register } = makeMockViewer({ runtime: true });
    const source = addMesh(model, 'Box');
    register();
    const doc = AssetDocument.newUntitled(viewer);
    // A drive sitting on the source mesh, as the loader would have left it.
    (viewer.drives as unknown[]).push({ node: source });

    await doc.separateMesh('Asset/Box', 'islands');

    // The source was parked in the trash and unregistered — its drive goes too.
    expect(registry.getPathForNode(source)).toBeNull();
    expect(viewer.drives).toHaveLength(0);
    doc.dispose();
  });

  it('removes and re-adds the subtree LogicSteps in pairs', async () => {
    const { viewer, model, register } = makeMockViewer({ runtime: true });
    const source = addMesh(model, 'Box');
    const step = new Object3D();
    step.name = 'Seq';
    step.userData['realvirtual'] = { LogicStep_SerialContainer: {} };
    source.add(step);
    register();

    // `processExtras` rebuilds components but explicitly NOT logic, so the
    // executor owns both halves. Record them rather than run the real engine.
    const calls: string[] = [];
    (viewer as unknown as { logicEngine: unknown }).logicEngine = {
      removeSubtree: () => { calls.push('remove'); return 1; },
      addSubtree: () => { calls.push('add'); return 1; },
    };

    const doc = AssetDocument.newUntitled(viewer);
    await doc.separateMesh('Asset/Box', 'islands');
    expect(calls).toEqual(['remove', 'add']);

    await doc.undo();
    expect(calls).toEqual(['remove', 'add', 'remove', 'add']);

    await doc.redo();
    expect(calls).toEqual(['remove', 'add', 'remove', 'add', 'remove', 'add']);
    doc.dispose();
  });
});

// ─── group mode through the executor ────────────────────────────────────

describe('group mode via the op', () => {
  it('gives every part the material of its own slot', async () => {
    const { viewer, model, registry, register } = makeMockViewer();
    // One connected quad, but two material groups over its two triangles.
    const geom = new BufferGeometry();
    geom.setAttribute('position', new BufferAttribute(new Float32Array([
      0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0,
    ]), 3));
    geom.setIndex(new BufferAttribute(new Uint32Array([0, 1, 2, 0, 2, 3]), 1));
    geom.addGroup(0, 3, 0);
    geom.addGroup(3, 3, 1);

    const red = new MeshStandardMaterial({ color: 0xff0000 });
    const blue = new MeshStandardMaterial({ color: 0x0000ff });
    const mesh = new Mesh(geom, [red, blue]);
    mesh.name = 'Plate';
    model.add(mesh);
    register();

    const doc = AssetDocument.newUntitled(viewer);
    const names = await doc.separateMesh('Asset/Plate', 'groups');
    expect(names).toEqual(['Plate_part0', 'Plate_part1']);

    const part0 = registry.getNode('Asset/Plate/Plate_part0') as Mesh;
    const part1 = registry.getNode('Asset/Plate/Plate_part1') as Mesh;
    // Shared by REFERENCE — the separator never clones a material.
    expect(part0.material).toBe(red);
    expect(part1.material).toBe(blue);
    doc.dispose();
  });
});

// ─── 9.15 — BVH race ────────────────────────────────────────────────────

describe('9.15 BVH abort', () => {
  it('computeBVHAsync assigns no boundsTree once the abort predicate flips', async () => {
    const root = new Group();
    const mesh = addMesh(root, 'Part', twoIslandGeometry());
    let release!: (value: unknown) => void;
    const blocked = new Promise((resolve) => { release = resolve; });
    const port: BVHBuildPort = {
      generate: async () => { await blocked; return { fake: true }; },
      dispose() {},
    } as unknown as BVHBuildPort;

    let alive = true;
    const done = computeBVHAsync(root, port, { shouldAbort: () => !alive });
    // The geometry is disposed while the build is still in flight.
    alive = false;
    release(null);
    expect(await done).toBe(false);
    expect((mesh.geometry as BufferGeometry).boundsTree).toBeUndefined();
  });

  it('the executor hands a predicate that goes false when the trash is flushed', async () => {
    const { viewer, model, bvhCalls, register } = makeMockViewer();
    addMesh(model, 'Box');
    register();
    const doc = AssetDocument.newUntitled(viewer);

    await doc.separateMesh('Asset/Box', 'islands');
    const call = bvhCalls.at(-1)!;
    expect(call.isAlive).toBeTypeOf('function');
    expect(call.isAlive!()).toBe(true);

    // Undo parks the group (and its part geometries) in the trash; the flush
    // then disposes them — from that moment no tree may be written any more.
    await doc.undo();
    expect(call.isAlive!()).toBe(true); // still restorable by redo
    doc.dispose();                      // dispose → flushTrash → geometries gone
    expect(call.isAlive!()).toBe(false);
  });
});

// ─── 9.16 — verbatim child names ────────────────────────────────────────

describe('9.16 name stability on replay', () => {
  it('reports a colliding recorded name instead of silently renaming', async () => {
    const { viewer, model, registry, register } = makeMockViewer();
    const source = addMesh(model, 'Box');
    const squatter = new Object3D();
    squatter.name = 'Box_part0'; // an existing child claims the recorded name
    source.add(squatter);
    register();
    const doc = AssetDocument.newUntitled(viewer);

    const op: SeparateMeshOp = {
      ...assetOpHeader(), kind: 'separateMesh', sourcePath: 'Asset/Box',
      mode: 'islands', weldThreshold: 0.0001, childNames: ['Box_part0', 'Box_part1'],
    };
    await doc.replayOps([op]);

    // The mesh is still a mesh and the squatter kept its name …
    expect((registry.getNode('Asset/Box') as Mesh).isMesh).toBe(true);
    expect(squatter.name).toBe('Box_part0');
    expect(squatter.parent).toBe(source);

    // … and the skipped split is REPORTED, not merely logged: the draft still
    // holds the op, so the user has to learn the tree diverged from it.
    const unapplied = doc.executor.takeUnappliedSeparations();
    expect(unapplied).toHaveLength(1);
    expect(unapplied[0].sourcePath).toBe('Asset/Box');
    expect(unapplied[0].reason).toMatch(/"Box_part0" collides/);
    doc.dispose();
  });

  it('op creation dedupes once, against the children the source already has', async () => {
    const { viewer, model, register } = makeMockViewer();
    const source = addMesh(model, 'Box');
    const squatter = new Object3D();
    squatter.name = 'Box_part0';
    source.add(squatter);
    register();
    const doc = AssetDocument.newUntitled(viewer);

    // Live creation sidesteps the collision by claiming a free name ONCE …
    const names = await doc.separateMesh('Asset/Box', 'islands');
    expect(names).toEqual(['Box_part0_1', 'Box_part1']);
    // … and the executor applies exactly those, no second dedup pass.
    expect(childNames(model.children.find((c) => c.name === 'Box')!))
      .toEqual(['Box_part0', 'Box_part0_1', 'Box_part1']);
    doc.dispose();
  });
});
