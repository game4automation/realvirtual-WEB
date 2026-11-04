// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-769 Phase 2 follow-up — a node an op (re)attaches carries its runtime
 * components in the registry after undo / redo, not only after the first apply.
 *
 * Live finding (Autonox DELTA, CONNECT): `editor.clone` of `DeltaPaths` → the copy's
 * `PickPlace` has its `MechanismPath`; `undo` → copy gone; `redo` → the node is back,
 * but `web_component_get_all` on it answered `components: []`. The trash detach
 * (`_detachToTrash` → `unregisterSubtree`) drops the component entries of the parked
 * subtree, and the trash restore re-registered only the NODES. The same restore serves
 * the redo of `cloneNode` / `createNode` / `importCad` and the undo of `deleteNode`.
 *
 * Asserted on what `web_component_get_all` / `web_component_list` read:
 * `registry.getComponentsAt(path)` and `registry.getAll(type)`.
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  BufferAttribute, BufferGeometry, Group, Mesh, MeshStandardMaterial, Object3D, Scene,
} from 'three';
import type { RVViewer } from '../src/core/rv-viewer';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { buildInitContext, type InitContextDeps } from '../src/core/engine/rv-init-context';
import { registerComponent, type ComponentContext, type RVComponent } from '../src/core/engine/rv-component-registry';
import { objectToGlb } from '../src/core/import/rv-import-object';
import { applyForward as sceneForward, applyInverse as sceneInverse } from '../src/core/hmi/scene/rv-scene-executors';
import { createTestViewer, type TestViewerHandle } from './helpers/create-test-viewer';
import { scratchAssetDocument } from './helpers/scratch-asset-document';

const PROBE = 'RedoProbe';
const built: RedoProbe[] = [];
class RedoProbe implements RVComponent {
  isOwner = true;
  disposed = false;
  constructor(readonly node: Object3D) { built.push(this); }
  init(_context: ComponentContext): void { /* nothing to wire */ }
  dispose(): void { this.disposed = true; }
}
registerComponent({ type: PROBE, schema: {}, create: (node) => new RedoProbe(node) });

function tri(offset: number): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array([
    offset, 0, 0, offset + 1, 0, 0, offset, 1, 0,
  ]), 3));
  g.setIndex([0, 1, 2]);
  return g;
}

function twoIslands(): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array([
    0, 0, 0, 1, 0, 0, 0, 1, 0,
    10, 0, 0, 11, 0, 0, 10, 1, 0,
  ]), 3));
  g.setIndex([0, 1, 2, 3, 4, 5]);
  return g;
}

/**
 *  Asset
 *   ├─ Src / P            (P: RedoProbe, added by the editor)
 *   ├─ Islands            two-island mesh (separate)
 *   └─ Asm / M1, M2       two materials (merge)
 */
function makeRuntimeViewer(): { viewer: RVViewer; registry: NodeRegistry; model: Group } {
  const scene = new Scene();
  const model = new Group();
  model.name = 'Asset';
  scene.add(model);
  const src = new Object3D();
  src.name = 'Src';
  const p = new Object3D();
  p.name = 'P';
  src.add(p);
  model.add(src);
  const islands = new Mesh(twoIslands(), new MeshStandardMaterial({ color: 0x808080 }));
  islands.name = 'Islands';
  model.add(islands);
  const asm = new Object3D();
  asm.name = 'Asm';
  const m1 = new Mesh(tri(0), new MeshStandardMaterial({ color: 0xff0000 }));
  m1.name = 'M1';
  const m2 = new Mesh(tri(5), new MeshStandardMaterial({ color: 0x0000ff }));
  m2.name = 'M2';
  asm.add(m1, m2);
  model.add(asm);
  model.updateMatrixWorld(true);

  const registry = new NodeRegistry();
  model.traverse((n) => registry.registerNode(NodeRegistry.computeNodePath(n), n));
  const viewer = {
    scene,
    registry,
    signalStore: { buildIndex() {}, remapPaths() {} },
    transportManager: {
      notifyTopologyChanged() {},
      sensors: [], surfaces: [], sources: [], sinks: [], grips: [], gripTargets: [],
    },
    drives: [] as unknown[],
    logicRunState: 'active',
    initContext(this: { registry: NodeRegistry; signalStore: unknown; transportManager: unknown }) {
      return buildInitContext({
        registry: this.registry,
        signalStore: this.signalStore as InitContextDeps['signalStore'],
        transportManager: this.transportManager as InitContextDeps['transportManager'],
        scene,
      });
    },
    get currentModelRoot() { return model; },
    instancePickIndex: { addSubtree() {}, removeSubtree() {}, bumpResolutionEpoch() {} },
    buildMeshBvhsAsync() {},
    registerDeferredLogic() {},
    markRenderDirty() {}, markShadowsDirty() {},
    emit() {}, on() { return () => {}; },
    rebuildGroupedBvh() {}, refitRaycastSubtrees() {}, rebuildIKPaths() {},
    getPlugin: () => undefined,
    selectionManager: { select() {} },
  } as unknown as RVViewer;
  return { viewer, registry, model };
}

/** The probe types registered at `path` — what `web_component_get_all` lists. */
function probesAt(registry: NodeRegistry, path: string): unknown[] {
  return registry.getComponentsAt(path).filter(([t]) => t === PROBE).map(([, i]) => i);
}

/** Every live probe instance the registry lists — what `web_component_list` lists. */
function probePaths(registry: NodeRegistry): string[] {
  return registry.getAll(PROBE).map((e) => e.path).sort();
}

describe('plan-769 Phase 2 follow-up — components survive undo / redo of node-creating ops', () => {
  it('cloneNode: after undo → redo the copy has its component again (the DeltaPaths finding)', async () => {
    const { viewer, registry } = makeRuntimeViewer();
    const doc = scratchAssetDocument(viewer);
    doc.addComponent('Asset/Src/P', PROBE, {});
    await doc.whenIdle();
    const copyPath = await doc.cloneNode('Asset/Src', { name: 'SrcCopy' });
    expect(copyPath).toBe('Asset/SrcCopy');
    expect(probesAt(registry, 'Asset/SrcCopy/P')).toHaveLength(1);
    const copyProbe = probesAt(registry, 'Asset/SrcCopy/P')[0];
    expect(probePaths(registry)).toEqual(['Asset/Src/P', 'Asset/SrcCopy/P']);

    await doc.undo();
    expect(registry.getNode('Asset/SrcCopy')).toBeNull();
    expect(probePaths(registry)).toEqual(['Asset/Src/P']);

    await doc.redo();
    expect(registry.getNode('Asset/SrcCopy/P')).not.toBeNull();
    expect(probesAt(registry, 'Asset/SrcCopy/P')).toEqual([copyProbe]); // the SAME instance is back
    expect(probePaths(registry)).toEqual(['Asset/Src/P', 'Asset/SrcCopy/P']);

    // and a second cycle stays symmetric
    await doc.undo();
    await doc.redo();
    expect(probePaths(registry)).toEqual(['Asset/Src/P', 'Asset/SrcCopy/P']);
    doc.dispose();
  });

  it('deleteNode: undo brings the subtree back WITH its components', async () => {
    const { viewer, registry } = makeRuntimeViewer();
    const doc = scratchAssetDocument(viewer);
    doc.addComponent('Asset/Src/P', PROBE, {});
    await doc.whenIdle();
    const probe = probesAt(registry, 'Asset/Src/P')[0];
    expect(probe).toBeTruthy();
    await doc.deleteNodes(['Asset/Src']);
    expect(probePaths(registry)).toEqual([]);
    await doc.undo();
    expect(probesAt(registry, 'Asset/Src/P')).toEqual([probe]);
    await doc.redo();
    expect(probePaths(registry)).toEqual([]);
    await doc.undo();
    expect(probesAt(registry, 'Asset/Src/P')).toEqual([probe]);
    doc.dispose();
  });

  it('createNode (+ addComponent on it): undo ×2 → redo ×2 restores node and component', async () => {
    const { viewer, registry } = makeRuntimeViewer();
    const doc = scratchAssetDocument(viewer);
    const path = await doc.createEmptyNode(null, 'Empty');
    doc.addComponent(path, PROBE, {});
    await doc.whenIdle();
    expect(probesAt(registry, path)).toHaveLength(1);
    await doc.undo();
    await doc.undo();
    expect(registry.getNode(path)).toBeNull();
    expect(probePaths(registry)).toEqual([]);
    await doc.redo();
    await doc.redo();
    expect(probesAt(registry, path)).toHaveLength(1);
    expect(probePaths(registry)).toEqual([path]);
    doc.dispose();
  });

  it('separateMesh: undo → redo keeps exactly one component on the Group', async () => {
    const { viewer, registry } = makeRuntimeViewer();
    const doc = scratchAssetDocument(viewer);
    doc.addComponent('Asset/Islands', PROBE, {});
    await doc.whenIdle();
    await doc.separateMesh('Asset/Islands', 'islands');
    expect(probesAt(registry, 'Asset/Islands')).toHaveLength(1);
    await doc.undo();
    expect(probesAt(registry, 'Asset/Islands')).toHaveLength(1);
    await doc.redo();
    expect(probesAt(registry, 'Asset/Islands')).toHaveLength(1);
    expect(probePaths(registry)).toEqual(['Asset/Islands']);
    doc.dispose();
  });

  it('mergeMesh: undo → redo keeps exactly one component on the merged root', async () => {
    const { viewer, registry } = makeRuntimeViewer();
    const doc = scratchAssetDocument(viewer);
    doc.addComponent('Asset/Asm', PROBE, {});
    await doc.whenIdle();
    const plan = await doc.mergeMesh('Asset/Asm');
    expect(plan).not.toBeNull();
    expect(probesAt(registry, 'Asset/Asm')).toHaveLength(1);
    await doc.undo();
    expect(probesAt(registry, 'Asset/Asm')).toHaveLength(1);
    await doc.redo();
    expect(probesAt(registry, 'Asset/Asm')).toHaveLength(1);
    expect(probePaths(registry)).toEqual(['Asset/Asm']);
    doc.dispose();
  });
});

describe('plan-769 Phase 2 follow-up — scene addNode / removeNode re-create components', () => {
  let h: TestViewerHandle | null = null;
  afterEach(() => { h?.dispose(); h = null; });

  it('addNode: undo → redo, removeNode → undo: the node has its component each time', async () => {
    h = await createTestViewer('webgl');
    const base = new Group();
    base.name = 'Plant';
    const box = new Mesh(tri(0), new MeshStandardMaterial());
    box.name = 'Box';
    base.add(box);
    await h.viewer.loadModel('scene-redo-components.glb', { data: await objectToGlb(base) });
    const reg = h.viewer.registry!;
    const ctx = { viewer: h.viewer };
    const rootPath = reg.getPathForNode(h.viewer.currentModelRoot!)!;
    const nodePath = `${rootPath}/Waypoint`;
    const spec = {
      parentPath: rootPath, name: 'Waypoint', position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1],
      components: { [PROBE]: {} },
    };
    const add = { id: 'op-add-c', ts: 0, schemaV: 1, kind: 'addNode', nodePath, spec } as Record<string, unknown>;
    await sceneForward(add as never, ctx);
    expect(probesAt(reg, nodePath)).toHaveLength(1);
    await sceneInverse(add as never, ctx);
    expect(reg.getNode(nodePath)).toBeNull();
    expect(probePaths(reg)).toEqual([]);
    await sceneForward(add as never, ctx);
    expect(probesAt(reg, nodePath)).toHaveLength(1);
    const remove = { id: 'op-rm-c', ts: 0, schemaV: 1, kind: 'removeNode', nodePath, spec } as Record<string, unknown>;
    await sceneForward(remove as never, ctx);
    expect(probePaths(reg)).toEqual([]);
    await sceneInverse(remove as never, ctx);
    expect(probesAt(reg, nodePath)).toHaveLength(1);
    expect(probePaths(reg)).toEqual([nodePath]);
  });
});
