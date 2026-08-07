// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Editor pick-index maintenance — asset ops keep the InstancePickIndex
 * correct WITHOUT any full rebuild:
 *
 *   - transformNode: zero notifications (per-pick AABB recompute)
 *   - deleteNode → trash detach removes entries; undo restores them
 *   - trash aliasing: deleted geometry must NEVER resolve to a node later
 *     created at the same path
 *   - renameNode: epoch bump → hits resolve the NEW path
 *   - setNodeVisible: zero maintenance (broad-phase visibility walk)
 *   - addComponent: resolution stays on the exact part (no bubbling — editor
 *     picking is exact-node, see rv-instance-pick-index.ts)
 *
 * Runs the REAL AssetDocument + executors against a minimal mock viewer
 * carrying a REAL InstancePickIndex (pattern: rv-asset-create-reparent.test.ts).
 */
import { describe, it, expect } from 'vitest';
import {
  BoxGeometry, BufferGeometry, Group, Mesh, MeshBasicMaterial, Raycaster, Scene, Vector3,
} from 'three';
import type { Intersection, Object3D } from 'three';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';
import type { RVViewer } from '../src/core/rv-viewer';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { InstancePickIndex } from '../src/core/engine/rv-instance-pick-index';
import { AssetDocument } from '../src/core/editor/rv-asset-document';
import { registerComponentSchema } from '../src/core/engine/rv-component-registry';
import '../src/core/editor/rv-cadlink'; // CADLink capability registration

BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
Mesh.prototype.raycast = acceleratedRaycast;

registerComponentSchema('MaintTestType', {}, { hoverable: true, selectable: true });

const IDENTITY = { position: [0, 0, 0] as [number, number, number], quaternion: [0, 0, 0, 1] as [number, number, number, number], scale: [1, 1, 1] as [number, number, number] };

function makeMockViewer() {
  const scene = new Scene();
  const model = new Group();
  model.name = 'Asset';
  scene.add(model);
  const registry = new NodeRegistry();
  const index = new InstancePickIndex(registry);
  const viewer = {
    scene,
    registry,
    signalStore: null,
    transportManager: null,
    get currentModelRoot() { return model; },
    get instancePickIndex() { return index; },
    buildMeshBvhsAsync() {},
    markRenderDirty() {},
    markShadowsDirty() {},
    emit() {},
    on() { return () => {}; },
    rebuildGroupedBvh() { throw new Error('legacy rebuild must not run with the instance index'); },
    refitRaycastSubtrees() { throw new Error('legacy refit must not run with the instance index'); },
    selectionManager: { select() {} },
  } as unknown as RVViewer;
  const register = () => {
    model.traverse((n) => registry.registerNode(NodeRegistry.computeNodePath(n), n));
  };
  return { viewer, scene, model, registry, index, register };
}

function hoverableBox(name: string, x: number): { node: Group; mesh: Mesh } {
  const node = new Group();
  node.name = name;
  node.userData.realvirtual = { MaintTestType: {} };
  const mesh = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial());
  mesh.name = `${name}Mesh`;
  node.position.set(x, 0, 0);
  node.add(mesh);
  return { node, mesh };
}

function pick(index: InstancePickIndex, x: number): string | null {
  const ray = new Raycaster(new Vector3(x, 10, 0), new Vector3(0, -1, 0));
  const out: Intersection<Object3D>[] = [];
  index.raycast(ray, out);
  out.sort((a, b) => a.distance - b.distance);
  for (const hit of out) {
    const path = index.resolvePath(hit.object);
    if (path) return path;
  }
  return null;
}

function setup() {
  const ctx = makeMockViewer();
  const a = hoverableBox('A', 0);
  const b = hoverableBox('B', 5);
  ctx.model.add(a.node, b.node);
  ctx.model.updateMatrixWorld(true);
  ctx.register();
  ctx.index.addSubtree(ctx.model);
  const doc = AssetDocument.newUntitled(ctx.viewer);
  return { ...ctx, a, b, doc };
}

describe('editor pick-index maintenance (ops → index)', () => {
  it('transformNode needs zero index notifications', async () => {
    const { doc, index, registry, a } = setup();
    doc.transformNode('Asset/A', { ...IDENTITY, position: [10, 0, 0] }, IDENTITY);
    await doc.whenIdle();
    expect(pick(index, 10)).toBe(registry.getPathForNode(a.mesh));
    expect(pick(index, 0)).toBeNull();
  });

  it('delete → unpickable; undo → pickable again (trash detach/restore)', async () => {
    const { doc, index, registry, a } = setup();
    await doc.deleteNodes(['Asset/A']);
    expect(pick(index, 0)).toBeNull();
    expect(index.size).toBe(1);

    await doc.undo();
    expect(index.size).toBe(2);
    expect(pick(index, 0)).toBe(registry.getPathForNode(a.mesh));
  });

  it('trash aliasing: deleted geometry never resolves to a node recreated at the same path', async () => {
    const { doc, index, a } = setup();
    await doc.deleteNodes(['Asset/A']);
    await doc.createEmptyNode(null, 'A'); // NEW node at the old path
    await doc.whenIdle();

    // The trashed mesh is out of the index — no stale-path resolution…
    expect(index.resolvePath(a.mesh)).toBeNull();
    // …and its geometry doesn't pick anything (trash group is invisible).
    expect(pick(index, 0)).toBeNull();
  });

  it('rename resolves hits to the NEW path (epoch bump)', async () => {
    const { doc, index, registry, a } = setup();
    const oldPath = registry.getPathForNode(a.mesh)!;
    expect(pick(index, 0)).toBe(oldPath); // cache the path
    doc.renameNode('Asset/A', 'Renamed', 'A');
    await doc.whenIdle();
    expect(pick(index, 0)).toBe('Asset/Renamed/AMesh');
  });

  it('setNodeVisible toggles pickability with zero index maintenance', async () => {
    const { doc, index } = setup();
    doc.setNodeVisible('Asset/A', false);
    await doc.whenIdle();
    expect(pick(index, 0)).toBeNull();
    doc.setNodeVisible('Asset/A', true);
    await doc.whenIdle();
    expect(pick(index, 0)).toBe('Asset/A/AMesh');
  });

  it('addComponent keeps exact-part resolution (no bubbling to the component node)', async () => {
    const ctx = makeMockViewer();
    const cadRoot = new Group();
    cadRoot.name = 'Gearbox';
    cadRoot.userData.realvirtual = { CADLink: { File: 'g.step' } };
    const part = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial());
    part.name = 'Shaft';
    cadRoot.add(part);
    ctx.model.add(cadRoot);
    ctx.model.updateMatrixWorld(true);
    ctx.register();
    ctx.index.addSubtree(ctx.model);
    const doc = AssetDocument.newUntitled(ctx.viewer);

    expect(pick(ctx.index, 0)).toBe('Asset/Gearbox/Shaft'); // per-part

    doc.addComponent('Asset/Gearbox', 'MaintTestType', {});
    await doc.whenIdle();
    expect(pick(ctx.index, 0)).toBe('Asset/Gearbox/Shaft'); // still the exact part
  });
});
