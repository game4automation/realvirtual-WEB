// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Mesh merger — op / executor layer (plan-372 section 9: tests 9.8, 9.9, 9.11, 9.12,
 * 9.13, 9.14, 9.15, 9.17, 9.18, 9.19, 9.20 plus the op-semantics gate).
 *
 * The geometry core is covered by `rv-mesh-merge.test.ts`; what is at stake here is the
 * INTEGRATION: owner zones, the replacement node's property parity, bit-exact undo, the
 * replay contract and the runtime lifecycle.
 *
 * The mock viewer follows `rv-mesh-separator-op.test.ts`: a real `NodeRegistry` and a
 * real three `Scene`, no renderer.
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
import { AssetDocument, planMergeMesh } from '../src/core/editor/rv-asset-document';
import {
  assetOpHeader,
  assetOpTouchesHierarchy,
  classifyAssetOpRaycastImpact,
  type MergeMeshOp,
} from '../src/core/editor/rv-asset-ops';
import { canCoalesceRvOps, describeRvOp, type RvAssetOp } from '../src/core/ops/rv-unified-ops';
import { materialFingerprint } from '../src/core/editor/rv-mesh-merge';
import { exportAssetGlb } from '../src/core/editor/rv-asset-glb-export';
import { computeBVHAsync } from '../src/core/engine/rv-scene-loader';
import type { BVHBuildPort } from '../src/core/engine/rv-bvh-build-port';
import { GroupRegistry } from '../src/core/engine/rv-group-registry';
import {
  registerComponent,
  type ComponentContext,
  type RVComponent,
} from '../src/core/engine/rv-component-registry';

// ─── Fixtures ───────────────────────────────────────────────────────────

function triangleGeometry(offset = 0): BufferGeometry {
  const geom = new BufferGeometry();
  geom.setAttribute('position', new BufferAttribute(new Float32Array([
    offset, 0, 0, offset + 1, 0, 0, offset, 1, 0,
  ]), 3));
  geom.setAttribute('normal', new BufferAttribute(new Float32Array([
    0, 0, 1, 0, 0, 1, 0, 0, 1,
  ]), 3));
  geom.setIndex(new BufferAttribute(new Uint32Array([0, 1, 2]), 1));
  return geom;
}

interface MockViewer {
  viewer: RVViewer;
  scene: Scene;
  model: Group;
  registry: NodeRegistry;
  bvhCalls: { root: Object3D; isAlive?: () => boolean }[];
  register(): void;
}

function makeMockViewer(opts?: { runtime?: boolean; groups?: boolean }): MockViewer {
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
    groups: opts?.groups === true ? new GroupRegistry() : null,
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
  geometry: BufferGeometry = triangleGeometry(),
  material?: MeshStandardMaterial,
): Mesh {
  const mesh = new Mesh(geometry, material ?? new MeshStandardMaterial({ name: 'Steel', color: 0x336699 }));
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

/** The canonical fixture: an Assembly of two same-material parts under a Group node. */
function simpleAssembly(mock: MockViewer): { root: Group; a: Mesh; b: Mesh; material: MeshStandardMaterial } {
  const root = new Group();
  root.name = 'Assembly';
  mock.model.add(root);
  const material = new MeshStandardMaterial({ name: 'Steel', color: 0x336699 });
  const a = addMesh(root, 'PartA', triangleGeometry(0), material);
  const b = addMesh(root, 'PartB', triangleGeometry(5), material);
  mock.register();
  mock.model.updateMatrixWorld(true);
  return { root, a, b, material };
}

function findByName(root: Object3D, name: string): Object3D | null {
  let hit: Object3D | null = null;
  root.traverse((n) => { if (!hit && n.name === name) hit = n; });
  return hit;
}

// ─── material fingerprint over a REAL GLB round-trip ────────────────────
//
// Plan-372 names this the first task of Phase 3: the whole replay contract rests on
// `materialKey` surviving an export/re-import, and that was argued rather than measured.

describe('materialKey stability across a GLB round-trip', () => {
  it('survives exportAssetGlb → GLTFLoader.parse unchanged', async () => {
    const { viewer, model, register } = makeMockViewer();
    const material = new MeshStandardMaterial({
      name: 'Steel', color: 0x336699, metalness: 0.8, roughness: 0.35,
      transparent: true, opacity: 0.6,
    });
    const mesh = addMesh(model, 'Part', triangleGeometry(), material);
    register();
    model.updateMatrixWorld(true);

    const before = materialFingerprint(mesh.material as MeshStandardMaterial);

    const glb = await exportAssetGlb(model);
    const gltf = await new GLTFLoader().parseAsync(glb, '');
    const reloaded = findByName(gltf.scene, 'Part') as Mesh | null;
    expect(reloaded).not.toBeNull();

    const after = materialFingerprint(reloaded!.material as MeshStandardMaterial);
    // The uuid diverges — that is exactly why the fingerprint is value-based.
    expect((reloaded!.material as MeshStandardMaterial).uuid)
      .not.toBe(material.uuid);
    expect(after).toBe(before);
    void viewer;
  });

  it('still distinguishes two materials after the round-trip', async () => {
    const { model, register } = makeMockViewer();
    addMesh(model, 'A', triangleGeometry(0), new MeshStandardMaterial({ name: 'Steel', color: 0x336699 }));
    addMesh(model, 'B', triangleGeometry(5), new MeshStandardMaterial({ name: 'Brass', color: 0xbb9944 }));
    register();
    model.updateMatrixWorld(true);

    const glb = await exportAssetGlb(model);
    const gltf = await new GLTFLoader().parseAsync(glb, '');
    const a = findByName(gltf.scene, 'A') as Mesh;
    const b = findByName(gltf.scene, 'B') as Mesh;
    expect(materialFingerprint(a.material as MeshStandardMaterial))
      .not.toBe(materialFingerprint(b.material as MeshStandardMaterial));
  });
});

// ─── op semantics across all five places ────────────────────────────────

describe('mergeMesh op semantics', () => {
  const op: MergeMeshOp = {
    ...assetOpHeader(),
    kind: 'mergeMesh',
    rootPath: 'Asset/Assembly',
    sourcePaths: ['Asset/Assembly/PartA', 'Asset/Assembly/PartB'],
    sourceSignatures: [
      { materialKey: 'aaaa0000', vertexCount: 3, triangleCount: 1 },
      { materialKey: 'aaaa0000', vertexCount: 3, triangleCount: 1 },
    ],
    outputs: [{ sourceIndices: [0, 1], role: 'root', ownerPath: 'Asset/Assembly', name: 'Assembly', groupNames: [] }],
    kept: [],
  };

  it('never coalesces — a merge is one deliberate action', () => {
    expect(canCoalesceRvOps(op, { ...op, ...assetOpHeader() })).toBe(false);
    const other: RvAssetOp = {
      ...assetOpHeader(), kind: 'renameNode', nodePath: 'Asset/X', name: 'Y', prevName: 'X',
    };
    expect(canCoalesceRvOps(op, other)).toBe(false);
    expect(canCoalesceRvOps(other, op)).toBe(false);
  });

  it('touches the hierarchy, forces a raycast rebuild, and describes itself', () => {
    expect(assetOpTouchesHierarchy(op)).toBe(true);
    const impact = classifyAssetOpRaycastImpact(op);
    expect(impact.rebuild).toBe(true);
    expect(impact.refitPaths).toEqual([]);
    expect(describeRvOp(op)).toBe('Merge Assembly (2 → 1 mesh)');
  });

  it('propagates through a composite', () => {
    const composite: RvAssetOp = { ...assetOpHeader(), kind: 'composite', label: 'Batch', ops: [op] };
    expect(assetOpTouchesHierarchy(composite)).toBe(true);
    expect(classifyAssetOpRaycastImpact(composite).rebuild).toBe(true);
  });
});

// ─── 9.8 — undo / redo / replay ─────────────────────────────────────────

describe('9.8 undo, redo and replay', () => {
  it('replaces the root with a same-named mesh and survives three cycles', async () => {
    const mock = makeMockViewer();
    const { root, a } = simpleAssembly(mock);
    const { viewer, scene, model, registry } = mock;
    const doc = AssetDocument.newUntitled(viewer);

    const plan = await doc.mergeMesh('Asset/Assembly');
    expect(plan).not.toBeNull();
    expect(plan!.outputs).toHaveLength(1);

    for (let cycle = 0; cycle < 3; cycle++) {
      const merged = registry.getNode('Asset/Assembly') as Mesh;
      expect((merged as { isMesh?: boolean }).isMesh).toBe(true);
      expect(merged.name).toBe('Assembly');
      // Two source triangles landed in ONE geometry.
      expect(merged.geometry.getAttribute('position').count).toBe(6);
      expect(registry.getNode('Asset/Assembly/PartA')).toBeNull();
      expect(model.children.filter((c) => c.name === 'Assembly')).toHaveLength(1);
      expect(a.parent?.name).toBe('Assembly');
      expect(a.parent).toBe(root);
      expect(root.parent?.name).toBe('_rvAssetTrash');

      await doc.undo();
      expect(registry.getNode('Asset/Assembly')).toBe(root);
      expect(childNames(root)).toEqual(['PartA', 'PartB']);
      expect(registry.getNode('Asset/Assembly/PartA')).toBe(a);
      expect(model.children.filter((c) => c.name === 'Assembly')).toHaveLength(1);
      expect(trashGroup(scene)!.children.some((c) => c.name === 'Assembly')).toBe(true);

      await doc.redo();
    }
    doc.dispose();
  });

  it('replays from a recorded op onto a freshly loaded base', async () => {
    const mock = makeMockViewer();
    simpleAssembly(mock);
    const doc = AssetDocument.newUntitled(mock.viewer);
    const plan = planMergeMesh(mock.viewer, 'Asset/Assembly')!;
    const op: MergeMeshOp = {
      ...assetOpHeader(), kind: 'mergeMesh', rootPath: 'Asset/Assembly',
      sourcePaths: plan.sourcePaths, sourceSignatures: plan.sourceSignatures,
      outputs: plan.outputs, kept: plan.kept,
    };
    await doc.replayOps([op]);
    const merged = mock.registry.getNode('Asset/Assembly') as Mesh;
    expect((merged as { isMesh?: boolean }).isMesh).toBe(true);
    expect(merged.geometry.getAttribute('position').count).toBe(6);
    expect(doc.executor.takeUnappliedMerges()).toEqual([]);
    doc.dispose();
  });

  it('keeps the RECORDED buckets when the material changed in between', async () => {
    // The reason the op stores its partition: re-classifying on replay would split the
    // one bucket in two as soon as a setMaterial op ran between recording and replay.
    const mock = makeMockViewer();
    const { a } = simpleAssembly(mock);
    const doc = AssetDocument.newUntitled(mock.viewer);
    const plan = planMergeMesh(mock.viewer, 'Asset/Assembly')!;
    expect(plan.outputs).toHaveLength(1);

    // A different material — but the op's signatures pin the recorded state, so the
    // replay must REFUSE rather than quietly produce a different tree.
    a.material = new MeshStandardMaterial({ name: 'Brass', color: 0xbb9944 });
    const op: MergeMeshOp = {
      ...assetOpHeader(), kind: 'mergeMesh', rootPath: 'Asset/Assembly',
      sourcePaths: plan.sourcePaths, sourceSignatures: plan.sourceSignatures,
      outputs: plan.outputs, kept: plan.kept,
    };
    await doc.replayOps([op]);
    const unapplied = doc.executor.takeUnappliedMerges();
    expect(unapplied).toHaveLength(1);
    expect(unapplied[0].reason).toMatch(/no longer carries the recorded material/);
    // The tree is untouched — a second output mesh was never invented.
    expect(mock.registry.getNode('Asset/Assembly/PartA')).toBe(a);
    doc.dispose();
  });
});

// ─── 9.9 — geometry ownership ───────────────────────────────────────────

describe('9.9 no geometry or BVH leak', () => {
  it('disposes only the geometries the merge built, never the originals', async () => {
    const mock = makeMockViewer();
    const { a, b } = simpleAssembly(mock);
    const doc = AssetDocument.newUntitled(mock.viewer);

    const disposed: BufferGeometry[] = [];
    const boundsDisposed: BufferGeometry[] = [];
    const instrument = (geom: BufferGeometry): void => {
      const original = geom.dispose.bind(geom);
      geom.dispose = () => { disposed.push(geom); original(); };
      (geom as unknown as { disposeBoundsTree: () => void }).disposeBoundsTree = () => {
        boundsDisposed.push(geom);
      };
    };
    instrument(a.geometry as BufferGeometry);
    instrument(b.geometry as BufferGeometry);

    const built: BufferGeometry[] = [];
    for (let i = 0; i < 3; i++) {
      await doc.mergeMesh('Asset/Assembly').catch(() => null);
      if (i === 0) {
        const merged = mock.registry.getNode('Asset/Assembly') as Mesh;
        built.push(merged.geometry as BufferGeometry);
        instrument(merged.geometry as BufferGeometry);
      }
      await doc.undo();
      await doc.redo();
      await doc.undo();
    }

    // Only ONE merge op exists (the later mergeMesh calls run on the undone tree and
    // create their own ops) — what matters is the invariant below.
    doc.dispose(); // → flushTrash

    for (const geom of built) {
      expect(disposed.filter((g) => g === geom)).toHaveLength(1);
      expect(boundsDisposed).toContain(geom);
    }
    // The ORIGINAL geometries may be shared with other meshes and come back on undo.
    expect(disposed).not.toContain(a.geometry as BufferGeometry);
    expect(disposed).not.toContain(b.geometry as BufferGeometry);
  });
});

// ─── 9.11 — GLB export round-trip ───────────────────────────────────────

describe('9.11 GLB export round-trip', () => {
  it('mesh path, geometry, material, extras and kept children survive', async () => {
    const mock = makeMockViewer();
    const root = new Group();
    root.name = 'Assembly';
    root.userData['realvirtual'] = { CADLink: { File: 'box.step', Sha256: 'deadbeef', Quality: 'standard', ImportScaleFactor: 0.001, ZIsUpVector: true } };
    mock.model.add(root);
    const material = new MeshStandardMaterial({ name: 'Steel', color: 0x336699 });
    addMesh(root, 'PartA', triangleGeometry(0), material);
    addMesh(root, 'PartB', triangleGeometry(5), material);
    const sensor = new Object3D();
    sensor.name = 'Eye';
    sensor.userData['realvirtual'] = { Sensor: { Level: 3 } };
    root.add(sensor);
    mock.register();
    mock.model.updateMatrixWorld(true);

    const doc = AssetDocument.newUntitled(mock.viewer);
    await doc.mergeMesh('Asset/Assembly');

    const glb = await exportAssetGlb(mock.model);
    const gltf = await new GLTFLoader().parseAsync(glb, '');

    const merged = findByName(gltf.scene, 'Assembly') as Mesh | null;
    expect(merged).not.toBeNull();
    expect((merged as unknown as { isMesh?: boolean }).isMesh).toBe(true);
    expect(merged!.geometry.getAttribute('position').count).toBe(6);
    expect(merged!.material).toBeTruthy();
    // The root's rv_extras rode along on the deep-copied userData …
    expect((merged!.userData['realvirtual'] as Record<string, unknown>)['CADLink']).toBeDefined();
    // … and the protected child kept its own.
    const eye = findByName(merged!, 'Eye');
    expect(eye).not.toBeNull();
    expect((eye!.userData['realvirtual'] as Record<string, Record<string, unknown>>)['Sensor']['Level'])
      .toBe(3);
    doc.dispose();
  });
});

// ─── 9.12 — ineligibility produces no op ────────────────────────────────

describe('9.12 ineligibility', () => {
  it('creates NO op for a single mergeable mesh', async () => {
    const mock = makeMockViewer();
    const root = new Group();
    root.name = 'Assembly';
    mock.model.add(root);
    addMesh(root, 'Only');
    mock.register();
    const doc = AssetDocument.newUntitled(mock.viewer);

    expect(await doc.mergeMesh('Asset/Assembly')).toBeNull();
    expect(doc.getSnapshot().opCount).toBe(0);
    expect(mock.registry.getNode('Asset/Assembly')).toBe(root);
    doc.dispose();
  });

  it('creates NO op for a multi-material source', async () => {
    const mock = makeMockViewer();
    const root = new Group();
    root.name = 'Assembly';
    mock.model.add(root);
    const geom = triangleGeometry();
    geom.addGroup(0, 3, 0);
    const multi = new Mesh(geom, [new MeshStandardMaterial(), new MeshStandardMaterial()]);
    multi.name = 'Plate';
    root.add(multi);
    addMesh(root, 'Base', triangleGeometry(5));
    mock.register();
    const doc = AssetDocument.newUntitled(mock.viewer);

    const plan = planMergeMesh(mock.viewer, 'Asset/Assembly')!;
    expect(plan.ineligibleReason).toMatch(/Separate/);
    expect(await doc.mergeMesh('Asset/Assembly')).toBeNull();
    expect(doc.getSnapshot().opCount).toBe(0);
    doc.dispose();
  });
});

// ─── 9.13 — BVH race ────────────────────────────────────────────────────

describe('9.13 BVH abort', () => {
  it('computeBVHAsync writes no boundsTree once the predicate flips', async () => {
    const root = new Group();
    const mesh = addMesh(root, 'Part');
    let release!: (value: unknown) => void;
    const blocked = new Promise((resolve) => { release = resolve; });
    const port: BVHBuildPort = {
      generate: async () => { await blocked; return { fake: true }; },
      dispose() {},
    } as unknown as BVHBuildPort;

    let alive = true;
    const done = computeBVHAsync(root, port, { shouldAbort: () => !alive });
    alive = false;
    release(null);
    expect(await done).toBe(false);
    expect((mesh.geometry as BufferGeometry).boundsTree).toBeUndefined();
  });

  it('the executor hands a predicate that goes false when the trash is flushed', async () => {
    const mock = makeMockViewer();
    simpleAssembly(mock);
    const doc = AssetDocument.newUntitled(mock.viewer);

    await doc.mergeMesh('Asset/Assembly');
    const call = mock.bvhCalls.at(-1)!;
    expect(call.isAlive).toBeTypeOf('function');
    expect(call.isAlive!()).toBe(true);

    await doc.undo();
    expect(call.isAlive!()).toBe(true); // still restorable by redo
    doc.dispose();                      // dispose → flushTrash → output geometries gone
    expect(call.isAlive!()).toBe(false);
  });
});

// ─── 9.14 — runtime lifecycle ───────────────────────────────────────────

class MergeEnrollingProbe implements RVComponent {
  isOwner = true;
  constructor(readonly node: Object3D) {}
  init(context: ComponentContext): void {
    (context.transportManager.sensors as unknown[]).push(this);
  }
  dispose(): void { /* mirrors the real components: no self-removal */ }
}
registerComponent({
  type: 'MergeEnrollingProbe',
  schema: {},
  create: (node) => new MergeEnrollingProbe(node),
});

describe('9.14 runtime lifecycle symmetry', () => {
  it('merge → undo → redo does not grow the runtime collections', async () => {
    const mock = makeMockViewer({ runtime: true });
    const root = new Group();
    root.name = 'Assembly';
    mock.model.add(root);
    const carrier = new Object3D();
    carrier.name = 'Eye';
    carrier.userData['realvirtual'] = { MergeEnrollingProbe: {} };
    root.add(carrier);
    addMesh(root, 'PartA', triangleGeometry(0));
    addMesh(root, 'PartB', triangleGeometry(5));
    mock.register();
    mock.model.updateMatrixWorld(true);

    const doc = AssetDocument.newUntitled(mock.viewer);
    const tm = mock.viewer.transportManager as unknown as { sensors: unknown[] };

    await doc.mergeMesh('Asset/Assembly');
    expect(tm.sensors).toHaveLength(1);

    for (let i = 0; i < 3; i++) {
      await doc.undo();
      expect(tm.sensors).toHaveLength(1);
      await doc.redo();
      expect(tm.sensors).toHaveLength(1);
    }
    doc.dispose();
  });

  it('drops a torn-down drive out of viewer.drives', async () => {
    const mock = makeMockViewer({ runtime: true });
    const { a } = simpleAssembly(mock);
    const doc = AssetDocument.newUntitled(mock.viewer);
    (mock.viewer.drives as unknown[]).push({ node: a });

    await doc.mergeMesh('Asset/Assembly');

    expect(mock.registry.getPathForNode(a)).toBeNull();
    expect(mock.viewer.drives).toHaveLength(0);
    doc.dispose();
  });

  it('removes and re-adds the subtree LogicSteps in pairs', async () => {
    const mock = makeMockViewer({ runtime: true });
    const root = new Group();
    root.name = 'Assembly';
    mock.model.add(root);
    const step = new Object3D();
    step.name = 'Seq';
    step.userData['realvirtual'] = { LogicStep_SerialContainer: {} };
    root.add(step);
    addMesh(root, 'PartA', triangleGeometry(0));
    addMesh(root, 'PartB', triangleGeometry(5));
    mock.register();
    mock.model.updateMatrixWorld(true);

    const calls: string[] = [];
    (mock.viewer as unknown as { logicEngine: unknown }).logicEngine = {
      removeSubtree: () => { calls.push('remove'); return 1; },
      addSubtree: () => { calls.push('add'); return 1; },
    };

    const doc = AssetDocument.newUntitled(mock.viewer);
    await doc.mergeMesh('Asset/Assembly');
    expect(calls).toEqual(['remove', 'add']);
    await doc.undo();
    expect(calls).toEqual(['remove', 'add', 'remove', 'add']);
    await doc.redo();
    expect(calls).toEqual(['remove', 'add', 'remove', 'add', 'remove', 'add']);
    doc.dispose();
  });
});

// ─── 9.15 — replay divergence ───────────────────────────────────────────

describe('9.15 replay divergence is a collected failure, never a no-op', () => {
  const cases: { name: string; mutate: (op: MergeMeshOp) => void; expect: RegExp }[] = [
    {
      name: 'a missing source path',
      mutate: (op) => { op.sourcePaths = ['Asset/Assembly/Gone', op.sourcePaths[1]]; },
      expect: /is not a live mesh/,
    },
    {
      name: 'a diverged vertex count',
      mutate: (op) => { op.sourceSignatures[0] = { ...op.sourceSignatures[0], vertexCount: 99 }; },
      expect: /diverged/,
    },
    {
      name: 'a missing owner path',
      mutate: (op) => { op.outputs = op.outputs.map((o) => ({ ...o, ownerPath: 'Asset/Assembly/Nowhere', role: 'child' as const })); },
      expect: /root output|not a live anchor/,
    },
  ];

  for (const testCase of cases) {
    it(`reports ${testCase.name} and leaves the draft intact`, async () => {
      const mock = makeMockViewer();
      const { root } = simpleAssembly(mock);
      const doc = AssetDocument.newUntitled(mock.viewer);
      const plan = planMergeMesh(mock.viewer, 'Asset/Assembly')!;
      const op: MergeMeshOp = {
        ...assetOpHeader(), kind: 'mergeMesh', rootPath: 'Asset/Assembly',
        sourcePaths: [...plan.sourcePaths],
        sourceSignatures: plan.sourceSignatures.map((s) => ({ ...s })),
        outputs: plan.outputs.map((o) => ({ ...o })),
        kept: [...plan.kept],
      };
      testCase.mutate(op);

      // Does not reject — the rest of the draft must still replay …
      await expect(doc.replayOps([op])).resolves.toBeUndefined();
      // … and the draft is NOT emptied.
      expect(doc.getSnapshot().opCount).toBe(1);
      // The tree is untouched.
      expect(mock.registry.getNode('Asset/Assembly')).toBe(root);
      expect(childNames(root)).toEqual(['PartA', 'PartB']);

      const unapplied = doc.executor.takeUnappliedMerges();
      expect(unapplied).toHaveLength(1);
      expect(unapplied[0].rootPath).toBe('Asset/Assembly');
      expect(unapplied[0].opId).toBe(op.id);
      expect(unapplied[0].reason).toMatch(testCase.expect);
      // Draining is one-shot.
      expect(doc.executor.takeUnappliedMerges()).toEqual([]);
      doc.dispose();
    });
  }
});

// ─── 9.17 — the anchor moves its own output ─────────────────────────────

describe('9.17 owner zones (regression gate)', () => {
  it('geometry under a Drive anchor stays its child and moves with it', async () => {
    const mock = makeMockViewer();
    const root = new Group();
    root.name = 'Assembly';
    mock.model.add(root);
    const anchor = new Object3D();
    anchor.name = 'Axis';
    anchor.userData['realvirtual'] = { Drive: { Direction: 'LinearX' } };
    root.add(anchor);
    addMesh(anchor, 'Shell', triangleGeometry(0));
    addMesh(anchor, 'Rib', triangleGeometry(2));
    addMesh(root, 'Base', triangleGeometry(6));
    addMesh(root, 'Cover', triangleGeometry(8));
    mock.register();
    mock.model.updateMatrixWorld(true);

    const doc = AssetDocument.newUntitled(mock.viewer);
    const plan = await doc.mergeMesh('Asset/Assembly');
    expect(plan).not.toBeNull();
    // One output per zone: the root replacement and the anchor's own mesh.
    expect(plan!.outputs).toHaveLength(2);
    expect(plan!.outputs.filter((o) => o.role === 'root')).toHaveLength(1);

    const merged = mock.registry.getNode('Asset/Assembly') as Mesh;
    expect(merged.geometry.getAttribute('position').count).toBe(6); // Base + Cover
    const liveAnchor = mock.registry.getNode('Asset/Assembly/Axis')!;
    expect(liveAnchor).toBe(anchor);
    expect(liveAnchor.parent).toBe(merged);
    const anchorOutput = liveAnchor.children.find((c) => (c as Mesh).isMesh) as Mesh;
    expect(anchorOutput).toBeDefined();
    expect(anchorOutput.geometry.getAttribute('position').count).toBe(6); // Shell + Rib

    // The point of the whole owner-zone machinery: moving the anchor moves its geometry.
    const before = anchorOutput.localToWorld(new Vector3(0, 0, 0));
    liveAnchor.position.x += 10;
    liveAnchor.updateMatrixWorld(true);
    const after = anchorOutput.localToWorld(new Vector3(0, 0, 0));
    expect(after.x - before.x).toBeCloseTo(10, 5);
    doc.dispose();
  });
});

// ─── 9.18 — parent / index restoration ──────────────────────────────────

describe('9.18 bit-exact undo of the surviving nodes', () => {
  it('restores deeply nested kept nodes at the SAME parent and sibling index', async () => {
    const mock = makeMockViewer();
    const root = new Group();
    root.name = 'Assembly';
    mock.model.add(root);

    const anchor = new Object3D();
    anchor.name = 'Axis';
    anchor.userData['realvirtual'] = { Drive: {} };
    root.add(anchor);
    const inner = addMesh(anchor, 'Shell', triangleGeometry(0));
    // A protected node BELOW a consumed mesh below an anchor — the deepest case.
    const sensor = new Object3D();
    sensor.name = 'Sensor-Inner';
    inner.add(sensor);
    addMesh(anchor, 'Rib', triangleGeometry(2));
    addMesh(root, 'Base', triangleGeometry(6));
    addMesh(root, 'Cover', triangleGeometry(8));
    mock.register();
    mock.model.updateMatrixWorld(true);

    const before = {
      anchorParent: anchor.parent, anchorIndex: root.children.indexOf(anchor),
      sensorParent: sensor.parent, sensorIndex: inner.children.indexOf(sensor),
      rootChildren: childNames(root),
      anchorChildren: childNames(anchor),
    };

    const doc = AssetDocument.newUntitled(mock.viewer);
    await doc.mergeMesh('Asset/Assembly');

    // While merged, the sensor is a child of the ANCHOR (its owner zone) …
    expect(sensor.parent).toBe(anchor);
    // … and a child authored AFTER the merge must survive the undo.
    const late = new Object3D();
    late.name = 'Late';
    (mock.registry.getNode('Asset/Assembly') as Mesh).add(late);

    await doc.undo();
    expect(anchor.parent).toBe(before.anchorParent);
    expect(root.children.indexOf(anchor)).toBe(before.anchorIndex);
    expect(sensor.parent).toBe(before.sensorParent);
    expect(inner.children.indexOf(sensor)).toBe(before.sensorIndex);
    expect(childNames(root).filter((n) => n !== 'Late')).toEqual(before.rootChildren);
    expect(childNames(anchor)).toEqual(before.anchorChildren);
    // The late child went home to the origin owner rather than into the trash.
    expect(late.parent).toBe(root);
    doc.dispose();
  });

  it('undo → redo reproduces the merged tree exactly', async () => {
    const mock = makeMockViewer();
    const root = new Group();
    root.name = 'Assembly';
    mock.model.add(root);
    const anchor = new Object3D();
    anchor.name = 'Axis';
    anchor.userData['realvirtual'] = { Drive: {} };
    root.add(anchor);
    addMesh(anchor, 'Shell', triangleGeometry(0));
    addMesh(anchor, 'Rib', triangleGeometry(2));
    addMesh(root, 'Base', triangleGeometry(6));
    addMesh(root, 'Cover', triangleGeometry(8));
    mock.register();
    mock.model.updateMatrixWorld(true);

    const doc = AssetDocument.newUntitled(mock.viewer);
    await doc.mergeMesh('Asset/Assembly');
    const forwardRoot = childNames(mock.registry.getNode('Asset/Assembly')!);
    const forwardAnchor = childNames(anchor);

    await doc.undo();
    await doc.redo();
    expect(childNames(mock.registry.getNode('Asset/Assembly')!)).toEqual(forwardRoot);
    expect(childNames(anchor)).toEqual(forwardAnchor);
    doc.dispose();
  });
});

// ─── 9.19 — GroupRegistry round-trip ────────────────────────────────────

describe('9.19 Group membership survives the merge', () => {
  it('is live in the GroupRegistry and survives export + re-import', async () => {
    const mock = makeMockViewer({ groups: true });
    const root = new Group();
    root.name = 'Assembly';
    mock.model.add(root);
    const material = new MeshStandardMaterial({ name: 'Steel', color: 0x336699 });
    const a = addMesh(root, 'PartA', triangleGeometry(0), material);
    a.userData['realvirtual'] = { Group: { GroupName: 'Frame' } };
    const b = addMesh(root, 'PartB', triangleGeometry(5), material);
    b.userData['realvirtual'] = { Group: { GroupName: 'Frame' } };
    mock.register();
    mock.model.updateMatrixWorld(true);

    const doc = AssetDocument.newUntitled(mock.viewer);
    await doc.mergeMesh('Asset/Assembly');

    const merged = mock.registry.getNode('Asset/Assembly') as Mesh;
    const rv = merged.userData['realvirtual'] as Record<string, Record<string, unknown>>;
    const groupKeys = Object.keys(rv).filter((k) => /^Group(_\d+)?$/.test(k));
    expect(groupKeys).toHaveLength(1);
    expect(rv[groupKeys[0]]['GroupName']).toBe('Frame');
    // Live registry membership, not just extras.
    expect(mock.viewer.groups!.getGroupNamesForNode(merged)).toContain('Frame');

    const glb = await exportAssetGlb(mock.model);
    const gltf = await new GLTFLoader().parseAsync(glb, '');
    const reloaded = findByName(gltf.scene, 'Assembly')!;
    const reloadedRv = reloaded.userData['realvirtual'] as Record<string, Record<string, unknown>>;
    expect(reloadedRv['Group']['GroupName']).toBe('Frame');
    doc.dispose();
  });
});

// ─── 9.20 — property parity of the replacement node ─────────────────────

describe('9.20 property parity', () => {
  it('carries transform, visibility, layers, shadows, render order and both auto-update flags', async () => {
    const mock = makeMockViewer();
    const root = new Group();
    root.name = 'Assembly';
    root.position.set(5, 6, 7);
    root.rotation.set(0.2, -0.4, 0.6);
    root.scale.set(2, 1.5, 0.5);
    mock.model.add(root);
    const material = new MeshStandardMaterial({ name: 'Steel', color: 0x336699 });
    addMesh(root, 'PartA', triangleGeometry(0), material);
    addMesh(root, 'PartB', triangleGeometry(5), material);
    mock.register();
    mock.model.updateMatrixWorld(true);

    root.visible = false;
    root.layers.set(3);
    root.castShadow = true;
    root.receiveShadow = true;
    root.renderOrder = 7;
    root.frustumCulled = false;
    // What `freezeStaticMatrices()` leaves behind on a static node.
    root.matrixAutoUpdate = false;
    root.matrixWorldAutoUpdate = false;
    const bakedWorld = root.matrixWorld.clone();

    const doc = AssetDocument.newUntitled(mock.viewer);
    await doc.mergeMesh('Asset/Assembly');

    const merged = mock.registry.getNode('Asset/Assembly') as Mesh;
    expect(merged.visible).toBe(false);
    expect(merged.layers.mask).toBe(root.layers.mask);
    expect(merged.castShadow).toBe(true);
    expect(merged.receiveShadow).toBe(true);
    expect(merged.renderOrder).toBe(7);
    expect(merged.frustumCulled).toBe(false);
    expect(merged.matrixAutoUpdate).toBe(false);
    expect(merged.matrixWorldAutoUpdate).toBe(false);
    expect(merged.matrixWorld.elements).toEqual(bakedWorld.elements);

    // A later forced pass must not shift the frozen replacement.
    mock.model.updateMatrixWorld(true);
    expect(merged.matrixWorld.elements).toEqual(bakedWorld.elements);
    doc.dispose();
  });

  it('keeps the world position of every merged vertex', async () => {
    const mock = makeMockViewer();
    const root = new Group();
    root.name = 'Assembly';
    root.position.set(3, -2, 7);
    root.rotation.set(0.4, 1.1, -0.7);
    root.scale.set(2, 1.5, 0.5);
    mock.model.add(root);
    const holder = new Object3D();
    holder.name = 'Holder';
    holder.position.set(1, 2, 3);
    holder.rotation.set(0.3, 0, -0.2);
    root.add(holder);
    const material = new MeshStandardMaterial({ name: 'Steel', color: 0x336699 });
    const a = addMesh(holder, 'PartA', triangleGeometry(0), material);
    a.position.set(0.5, 0, -0.25);
    addMesh(root, 'PartB', triangleGeometry(5), material);
    mock.register();
    mock.model.updateMatrixWorld(true);

    const worldBefore = a.localToWorld(new Vector3(1, 0, 0));

    const doc = AssetDocument.newUntitled(mock.viewer);
    await doc.mergeMesh('Asset/Assembly');

    const merged = mock.registry.getNode('Asset/Assembly') as Mesh;
    merged.updateMatrixWorld(true);
    const pos = merged.geometry.getAttribute('position');
    let best = Infinity;
    for (let i = 0; i < pos.count; i++) {
      const world = new Vector3(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(merged.matrixWorld);
      best = Math.min(best, world.distanceTo(worldBefore));
    }
    expect(best).toBeLessThan(1e-4);
    doc.dispose();
  });
});
