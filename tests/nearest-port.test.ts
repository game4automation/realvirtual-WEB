// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { afterEach, describe, expect, it, vi } from 'vitest';
import { BoxGeometry, Mesh, MeshBasicMaterial, PerspectiveCamera, Scene, Vector3, type Object3D } from 'three';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { SignalBindingManager } from '../src/core/engine/rv-signal-binding-manager';
import { GizmoOverlayManager } from '../src/core/engine/rv-gizmo-manager';
import type { ResolvedSlot } from '../src/core/engine/rv-binding-slot-resolver';
import type { RVViewer } from '../src/core/rv-viewer';
import { armSignalDrag, cancelSignalDrag, updateSignalDrag } from '../src/core/hmi/signal-drag-store';
import {
  DropTargetOverlayController,
  nearestCompatibleTarget,
  type NearestPortCandidate,
} from '../src/plugins/signal-bind/drop-target-overlay';

function candidate(id: string, screenX: number, screenY: number, ndcX = 0, ndcY = 0, ndcZ = 0) {
  return { id, screen: { x: screenX, y: screenY }, world: new Vector3(ndcX, ndcY, ndcZ) };
}

const SLOT: ResolvedSlot = {
  slot: 'Flow.Run', targetName: 'Flow.Run', type: 'bool', direction: 'plcOutput', aliases: [], instance: null,
};

function makeControllerHarness(positions: Array<[number, number, number]>) {
  const scene = new Scene();
  const registry = new NodeRegistry();
  const store = new SignalStore();
  const manager = new SignalBindingManager(store, registry);
  const slots = new Map<string, ResolvedSlot[]>();
  const nodes = positions.map((position, index) => {
    const node = new Mesh(new BoxGeometry(0.2, 0.2, 0.2), new MeshBasicMaterial());
    node.name = `T${index}`;
    node.position.set(...position);
    node.userData.realvirtual = { Conveyor: {} };
    scene.add(node);
    registry.registerNode(node.name, node);
    slots.set(node.name, [SLOT]);
    return node;
  });
  Object.assign(manager, { getElementSlots: (id: string) => slots.get(id) ?? [] });
  const camera = new PerspectiveCamera(50, 4 / 3, 0.1, 100);
  camera.position.set(0, 0, 10);
  camera.lookAt(0, 0, 0);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:fixed;left:0;top:0;width:640px;height:480px;z-index:1';
  canvas.width = 640;
  canvas.height = 480;
  document.body.appendChild(canvas);
  Object.defineProperty(canvas, 'clientHeight', { configurable: true, value: 480 });
  canvas.getBoundingClientRect = () => ({
    left: 0, top: 0, right: 640, bottom: 480, width: 640, height: 480,
    x: 0, y: 0, toJSON: () => ({}),
  });
  const gizmoManager = new GizmoOverlayManager(scene, () => null);
  const markRenderDirty = vi.fn();
  const viewer = {
    registry, signalBindingManager: manager, behaviors: { getActiveBinds: () => [] },
    getPlugin: () => undefined, gizmoManager, camera, renderer: { domElement: canvas },
    renderBackend: 'three', markRenderDirty,
  } as unknown as RVViewer;
  const controller = new DropTargetOverlayController(viewer);
  armSignalDrag({ name: 'Run', direction: 'output', plcType: 'PLCOutputBool', origin: 'connect', interfaceId: 'iface-1' }, 310, 240);
  updateSignalDrag(320, 240);
  const dispose = () => {
    controller.dispose();
    gizmoManager.destroy();
    canvas.remove();
    for (const node of nodes) {
      node.geometry.dispose();
      (node.material as MeshBasicMaterial).dispose();
    }
  };
  return { controller, nodes, gizmoManager, markRenderDirty, dispose };
}

afterEach(() => cancelSignalDrag());

describe('nearestCompatibleTarget', () => {
  it('picks the target with the smallest screen distance to the cursor', () => {
    const items = [candidate('far', 80, 50), candidate('near', 52, 50)];
    expect(nearestCompatibleTarget(items, 50, 50, 100)?.id).toBe('near');
  });

  it('uses a magnetic hit radius larger than the 18 px icon', () => {
    const item = candidate('magnetic', 80, 50);
    expect(nearestCompatibleTarget([item], 50, 50, 42)?.id).toBe('magnetic');
    expect(nearestCompatibleTarget([item], 50, 50, 18)).toBeNull();
  });

  it('excludes left, right, top, bottom, near-plane and behind-camera projections', () => {
    const offscreen = [
      candidate('left', 0, 0, -1.01, 0, 0), candidate('right', 0, 0, 1.01, 0, 0),
      candidate('top', 0, 0, 0, 1.01, 0), candidate('bottom', 0, 0, 0, -1.01, 0),
      candidate('near', 0, 0, 0, 0, -1), candidate('behind', 0, 0, 0, 0, 1),
    ];
    expect(nearestCompatibleTarget(offscreen, 0, 0, 100)).toBeNull();
  });

  it('returns null when no target passes the frustum test', () => {
    expect(nearestCompatibleTarget([candidate('off', 10, 10, 2, 0, 0)], 10, 10)).toBeNull();
  });

  it('tracks targets that move during the drag by re-reading world positions', () => {
    const h = makeControllerHarness([[0, 0, 0], [2, 0, 0]]);
    h.controller.onRender();
    expect(h.controller.nearestTargetId).toBe('T0');
    h.nodes[0].position.x = -2;
    h.nodes[1].position.x = 0;
    h.nodes[0].updateMatrixWorld(true);
    h.nodes[1].updateMatrixWorld(true);
    h.controller.onRender();
    expect(h.controller.nearestTargetId).toBe('T1');
    h.dispose();
  });

  it('considers targets beyond the 50-box cap', () => {
    const positions: Array<[number, number, number]> = Array.from({ length: 50 }, () => [6, 0, 3]);
    positions.push([0, 0, 0]);
    const h = makeControllerHarness(positions);
    h.controller.onRender();
    expect(h.controller.boxHighlightCount).toBe(50);
    expect(h.controller.nearestTargetId).toBe('T50');
    h.dispose();
  });

  it('switches active markers by dispose/recreate under the new target', () => {
    const h = makeControllerHarness([[0, 0, 0], [2, 0, 0]]);
    h.controller.onRender();
    const first = h.controller.activeMarkerHandle!;
    expect(first.root.parent).toBe(h.nodes[0]);
    const countWithActive = (h.gizmoManager as any)._entries.size;

    h.nodes[0].position.x = -2;
    h.nodes[1].position.x = 0;
    h.nodes[0].updateMatrixWorld(true);
    h.nodes[1].updateMatrixWorld(true);
    h.controller.onRender();
    const second = h.controller.activeMarkerHandle!;
    expect(second).not.toBe(first);
    expect(first.root.parent).toBeNull();
    expect(second.root.parent).toBe(h.nodes[1]);
    expect((h.gizmoManager as any)._entries.size).toBe(countWithActive);
    h.dispose();
  });
});
