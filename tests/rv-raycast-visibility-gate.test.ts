// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

// Runtime-visibility pick gate: subtrees hidden at runtime (WebVisibility PLC
// signal, Groups panel — `node.visible = false`) keep their triangles in the
// merged pick BVH but must NOT be hoverable/clickable. Hits behind them (from
// other raycast targets) must win instead.

import { describe, it, expect } from 'vitest';
import {
  Group, Mesh, BoxGeometry, BufferGeometry, MeshBasicMaterial,
  PerspectiveCamera, Scene, Vector3,
} from 'three';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';
import { buildRaycastGeometries } from '../src/core/engine/rv-raycast-geometry';
import { RaycastManager } from '../src/core/engine/rv-raycast-manager';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { registerComponentSchema } from '../src/core/engine/rv-component-registry';

BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
Mesh.prototype.raycast = acceleratedRaycast;

registerComponentSchema('VisGateTestType', {}, { hoverable: true, selectable: true });

function makeHighlighterMock() {
  return {
    highlight() {},
    highlightInstancedMU() {},
    clear() {},
  };
}

/**
 * Ray travels -Z from z=10:
 *   root → frontWrapper → FrontBox → mesh at z=2  (kinematic group)
 *   root → RearBox → mesh at z=0                  (static group)
 * Front and rear live in SEPARATE raycast targets, so hiding the front lets
 * the shared hits array fall through to the rear.
 */
function buildScene() {
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
  front.userData._rvType = 'VisGateTestType';
  const frontMesh = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial());
  frontMesh.name = 'FrontMesh';
  frontMesh.position.set(0, 0, 2);
  front.add(frontMesh);
  frontWrapper.add(front);
  root.add(frontWrapper);

  root.updateMatrixWorld(true);

  const registry = new NodeRegistry();
  root.traverse((n) => registry.registerNode(NodeRegistry.computeNodePath(n), n));

  const driveNodeSet = new Set<import('three').Object3D>([front]);
  const geo = buildRaycastGeometries(root, [{ node: front }], registry, driveNodeSet);

  return { root, registry, geo, rear, front, frontWrapper };
}

function makeManager(registry: NodeRegistry, canvas?: HTMLCanvasElement, camera?: PerspectiveCamera) {
  const cv = canvas ?? document.createElement('canvas');
  const renderer = { domElement: cv };
  const cam = camera ?? new PerspectiveCamera();
  return new RaycastManager(
    renderer as unknown as { readonly domElement: HTMLCanvasElement },
    () => cam, new Scene(), registry,
    makeHighlighterMock() as unknown as import('../src/core/engine/rv-highlight-manager').RVHighlightManager,
    { emit() {} },
  );
}

const RAY_ORIGIN = new Vector3(0, 0, 10);
const RAY_DIR = new Vector3(0, 0, -1);

describe('runtime-visibility pick gate', () => {
  it('picks the front node while everything is visible', () => {
    const { registry, geo, front } = buildScene();
    const rm = makeManager(registry);
    rm.setRaycastGeometry(geo, []);
    rm.enableHoverType('VisGateTestType', true);

    rm.updateFromXRController(RAY_ORIGIN, RAY_DIR);
    expect(rm.hoveredNodePath).toBe(registry.getPathForNode(front));
    rm.dispose();
  });

  it('falls through to the rear node when the front node is hidden', () => {
    const { registry, geo, rear, front } = buildScene();
    front.visible = false; // WebVisibility / Groups panel semantics

    const rm = makeManager(registry);
    rm.setRaycastGeometry(geo, []);
    rm.enableHoverType('VisGateTestType', true);

    rm.updateFromXRController(RAY_ORIGIN, RAY_DIR);
    expect(rm.hoveredNodePath).toBe(registry.getPathForNode(rear));
    rm.dispose();
  });

  it('gates on ANCESTOR visibility (resolved node itself stays visible)', () => {
    const { registry, geo, rear, front, frontWrapper } = buildScene();
    frontWrapper.visible = false; // hide via a plain ancestor group
    expect(front.visible).toBe(true);

    const rm = makeManager(registry);
    rm.setRaycastGeometry(geo, []);
    rm.enableHoverType('VisGateTestType', true);

    rm.updateFromXRController(RAY_ORIGIN, RAY_DIR);
    expect(rm.hoveredNodePath).toBe(registry.getPathForNode(rear));
    rm.dispose();
  });

  it('misses entirely when both nodes are hidden', () => {
    const { registry, geo, rear, front } = buildScene();
    front.visible = false;
    rear.visible = false;

    const rm = makeManager(registry);
    rm.setRaycastGeometry(geo, []);
    rm.enableHoverType('VisGateTestType', true);

    rm.updateFromXRController(RAY_ORIGIN, RAY_DIR);
    expect(rm.hoveredNodePath).toBeNull();
    rm.dispose();
  });

  it('click path (raycastForRVNodeDetailed) applies the same gate', () => {
    const { registry, geo, rear, front } = buildScene();
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

    const rm = makeManager(registry, canvas, camera);
    rm.setRaycastGeometry(geo, []);
    rm.enableHoverType('VisGateTestType', true);

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
