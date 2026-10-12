// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

// Runtime-visibility pick gate: subtrees hidden at runtime (WebVisibility PLC
// signal, Groups panel — `node.visible = false`) may still have triangles in a
// chunk BVH (the merge does not care about `.visible`)
// but must NOT be hoverable/clickable. Hits behind them (from other chunk
// meshes) must win instead.
//
// plan-754 Phase 1c: the scene is baked destructively and picked through the
// PickBackend — the same path a loaded model takes.

import { describe, it, expect } from 'vitest';
import {
  Group, Mesh, BoxGeometry, BufferGeometry, MeshBasicMaterial,
  PerspectiveCamera, Scene, Vector3,
} from 'three';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';
import { RaycastManager } from '../src/core/engine/rv-raycast-manager';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { registerComponentSchema } from '../src/core/engine/rv-component-registry';
import { BakeRegistry } from '../src/core/engine/rv-bake-registry';
import { PickBackend } from '../src/core/engine/rv-pick-backend';
import { bakeAndPlace } from './fixtures/bake-fixture';

BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
Mesh.prototype.raycast = acceleratedRaycast;

// A mover: every box is its own chunk, so the hit behind a rejected one is a
// separate intersection the resolution loop can fall through to.
registerComponentSchema('VisGateTestType', {}, { pick: 'select', bake: 'chunk' });

function makeHighlighterMock() {
  return {
    highlight() {},
    highlightInstancedMU() {},
    clear() {},
  };
}

/**
 * Ray travels -Z from z=10:
 *   root → frontWrapper → FrontBox → mesh at z=2  (own mover chunk)
 *   root → RearBox → mesh at z=0                  (own mover chunk)
 */
async function buildScene() {
  const root = new Group();
  root.name = 'Root';

  const rear = new Group();
  rear.name = 'RearBox';
  rear.userData.realvirtual = { VisGateTestType: {} };
  rear.userData._rvType = 'VisGateTestType';
  const rearMesh = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial());
  rearMesh.name = 'RearMesh';
  rear.add(rearMesh);
  root.add(rear);

  const frontWrapper = new Group();
  frontWrapper.name = 'FrontWrapper';
  const front = new Group();
  front.name = 'FrontBox';
  front.userData.realvirtual = { VisGateTestType: {} };
  front.userData._rvType = 'VisGateTestType';
  const frontMesh = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial());
  frontMesh.name = 'FrontMesh';
  frontMesh.position.set(0, 0, 2);
  front.add(frontMesh);
  frontWrapper.add(front);
  root.add(frontWrapper);

  root.updateMatrixWorld(true);

  // plan-754: the bake is destructive and the template is what gets placed, so
  // the registry is built from the TEMPLATE and the nodes under test are the
  // template's — `rear` / `front` above are consumed with `root`.
  const bakeRegistry = new BakeRegistry();
  const placed = await bakeAndPlace(root, bakeRegistry);

  const registry = new NodeRegistry();
  placed.template.traverse((n) => registry.registerNode(NodeRegistry.computeNodePath(n), n));

  return {
    root: placed.template,
    registry,
    bakeRegistry,
    rear: placed.node('RearBox'),
    front: placed.node('FrontBox'),
    frontWrapper: placed.node('FrontWrapper'),
  };
}

function makeManager(registry: NodeRegistry, bakeRegistry: BakeRegistry, canvas?: HTMLCanvasElement, camera?: PerspectiveCamera) {
  const cv = canvas ?? document.createElement('canvas');
  const renderer = { domElement: cv };
  const cam = camera ?? new PerspectiveCamera();
  const rm = new RaycastManager(
    renderer as unknown as { readonly domElement: HTMLCanvasElement },
    () => cam, new Scene(), registry,
    makeHighlighterMock() as unknown as import('../src/core/engine/rv-highlight-manager').RVHighlightManager,
    { emit() {} },
  );
  rm.addBackend(new PickBackend(bakeRegistry));
  rm.enableHoverType('VisGateTestType', true);
  return rm;
}

const RAY_ORIGIN = new Vector3(0, 0, 10);
const RAY_DIR = new Vector3(0, 0, -1);

describe('runtime-visibility pick gate', () => {
  it('picks the front node while everything is visible', async () => {
    const { registry, bakeRegistry, front } = await buildScene();
    const rm = makeManager(registry, bakeRegistry);

    rm.updateFromXRController(RAY_ORIGIN, RAY_DIR);
    expect(rm.hoveredNodePath).toBe(registry.getPathForNode(front));
    rm.dispose();
  });

  it('falls through to the rear node when the front node is hidden', async () => {
    const { registry, bakeRegistry, rear, front } = await buildScene();
    front.visible = false; // WebVisibility / Groups panel semantics

    const rm = makeManager(registry, bakeRegistry);
    rm.updateFromXRController(RAY_ORIGIN, RAY_DIR);
    expect(rm.hoveredNodePath).toBe(registry.getPathForNode(rear));
    rm.dispose();
  });

  it('gates on ANCESTOR visibility (resolved node itself stays visible)', async () => {
    const { registry, bakeRegistry, rear, front, frontWrapper } = await buildScene();
    frontWrapper.visible = false; // hide via a plain ancestor group
    expect(front.visible).toBe(true);

    const rm = makeManager(registry, bakeRegistry);
    rm.updateFromXRController(RAY_ORIGIN, RAY_DIR);
    expect(rm.hoveredNodePath).toBe(registry.getPathForNode(rear));
    rm.dispose();
  });

  it('misses entirely when both nodes are hidden', async () => {
    const { registry, bakeRegistry, rear, front } = await buildScene();
    front.visible = false;
    rear.visible = false;

    const rm = makeManager(registry, bakeRegistry);
    rm.updateFromXRController(RAY_ORIGIN, RAY_DIR);
    expect(rm.hoveredNodePath).toBeNull();
    rm.dispose();
  });

  it('click path (raycastForRVNodeDetailed) applies the same gate', async () => {
    const { registry, bakeRegistry, rear, front } = await buildScene();
    front.visible = false;

    // Real canvas with layout so pointerToNDC works: click the canvas center,
    // camera on +Z looking at the origin → ray identical to RAY_ORIGIN/DIR.
    const canvas = document.createElement('canvas');
    canvas.style.width = '200px';
    canvas.style.height = '200px';
    canvas.style.position = 'fixed';
    canvas.style.left = '0';
    canvas.style.top = '0';
    document.body.appendChild(canvas);

    const camera = new PerspectiveCamera(50, 1, 0.1, 100);
    camera.position.set(0, 0, 10);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld(true);

    const rm = makeManager(registry, bakeRegistry, canvas, camera);

    const rect = canvas.getBoundingClientRect();
    const result = rm.raycastForRVNodeDetailed({
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
    });
    expect(result?.path).toBe(registry.getPathForNode(rear));

    rm.dispose();
    canvas.remove();
  });
});
