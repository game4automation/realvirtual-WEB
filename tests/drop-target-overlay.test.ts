// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BoxGeometry, Mesh, MeshBasicMaterial, Object3D, PerspectiveCamera, Scene, Vector3, Quaternion } from 'three';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { SignalBindingManager } from '../src/core/engine/rv-signal-binding-manager';
import { GizmoOverlayManager } from '../src/core/engine/rv-gizmo-manager';
import { ContextMenuStore } from '../src/core/hmi/context-menu-store';
import type { ResolvedSlot } from '../src/core/engine/rv-binding-slot-resolver';
import type { RVViewer } from '../src/core/rv-viewer';
import type { LoadResult } from '../src/core/engine/rv-scene-loader';
import {
  armSignalDrag, cancelSignalDrag, endSignalDrag, updateSignalDrag,
} from '../src/core/hmi/signal-drag-store';
import { createSignalDropTarget } from '../src/core/hmi/signal-drop-target';
import { setOverlayVisible, showAllOverlays, resetOverlayProducers } from '../src/core/overlay-visibility-store';
import { DropTargetOverlayController, MAX_HIGHLIGHTS } from '../src/plugins/signal-bind/drop-target-overlay';
import { SignalBindPlugin } from '../src/plugins/signal-bind/SignalBindPlugin';
import { SceneDragOpenController } from '../src/plugins/signal-bind/scene-drag-open';
import { signalBindStore } from '../src/plugins/signal-bind/signal-bind-store';
import { makePortMarkerTexture } from '../src/plugins/signal-bind/port-marker-texture';
import { setSignalLinkModeExplicit } from '../src/plugins/signal-bind/signal-link-mode-store';

const BOOL_CONTROL: ResolvedSlot = {
  slot: 'Flow.Run', targetName: 'Flow.Run', type: 'bool', direction: 'plcOutput', aliases: [], instance: null,
};
const PAYLOAD = { name: 'Run', direction: 'output' as const, plcType: 'PLCOutputBool', origin: 'connect' as const, interfaceId: 'iface-1' };

interface Harness {
  viewer: RVViewer;
  scene: Scene;
  gizmoManager: GizmoOverlayManager;
  nodes: Object3D[];
  dirty: ReturnType<typeof vi.fn>;
  setBackend(backend: 'three' | 'omniverse'): void;
  dispose(): void;
}

function makeHarness(
  count = 1,
  backend: 'three' | 'omniverse' = 'three',
  withManager = true,
  totalRegistryNodes = count,
): Harness {
  const scene = new Scene();
  const registry = new NodeRegistry();
  const store = new SignalStore();
  const realManager = new SignalBindingManager(store, registry);
  const slots = new Map<string, ResolvedSlot[]>();
  const nodes: Object3D[] = [];
  for (let i = 0; i < count; i++) {
    const node = new Mesh(new BoxGeometry(0.5, 0.5, 0.5), new MeshBasicMaterial());
    node.name = `Target-${i}`;
    node.position.set((i % 10) * 0.25, Math.floor(i / 10) * 0.25, 0);
    node.userData.realvirtual = { Conveyor: {} };
    scene.add(node);
    registry.registerNode(node.name, node);
    slots.set(node.name, [BOOL_CONTROL]);
    nodes.push(node);
  }
  for (let i = count; i < totalRegistryNodes; i++) {
    const node = new Object3D();
    node.name = `Plain-${i}`;
    registry.registerNode(node.name, node);
  }
  Object.assign(realManager, { getElementSlots: (id: string) => slots.get(id) ?? [] });

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
  const dirty = vi.fn();
  let currentBackend = backend;
  const viewer = {
    scene,
    registry,
    signalBindingManager: withManager ? realManager : null,
    behaviors: { getActiveBinds: () => [] },
    getPlugin: () => undefined,
    gizmoManager,
    camera,
    renderer: { domElement: canvas },
    get renderBackend() { return currentBackend; },
    markRenderDirty: dirty,
    on: () => () => {},
    raycastManager: null,
    // Real viewers always own one (rv-viewer.ts) — the plugin registers its
    // "Link signal…" tree item against it in init() (plan-418).
    contextMenu: new ContextMenuStore(),
  } as unknown as RVViewer;
  return {
    viewer, scene, gizmoManager, nodes, dirty,
    setBackend(value) { currentBackend = value; },
    dispose() {
      gizmoManager.destroy();
      canvas.remove();
      for (const node of nodes) {
        (node as Mesh).geometry.dispose();
        ((node as Mesh).material as MeshBasicMaterial).dispose();
      }
    },
  };
}

function startDrag(x = 320, y = 240): void {
  armSignalDrag(PAYLOAD, x - 10, y);
  updateSignalDrag(x, y);
}

describe('DropTargetOverlayController', () => {
  const harnesses: Harness[] = [];

  beforeEach(() => {
    cancelSignalDrag();
    localStorage.clear();
    setSignalLinkModeExplicit(false);
    resetOverlayProducers();
    showAllOverlays();
    signalBindStore.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    cancelSignalDrag();
    for (const harness of harnesses.splice(0)) harness.dispose();
    resetOverlayProducers();
    showAllOverlays();
  });

  const harness = (...args: Parameters<typeof makeHarness>) => {
    const h = makeHarness(...args);
    harnesses.push(h);
    return h;
  };

  it('creates sprite handles for all targets and box highlights for at most 50', () => {
    const h = harness(60);
    const controller = new DropTargetOverlayController(h.viewer);
    startDrag();
    expect(controller.targetCount).toBe(60);
    expect(controller.boxHighlightCount).toBe(MAX_HIGHLIGHTS);
    const entries = [...(h.gizmoManager as any)._entries.values()] as Array<{ shape: string; category?: string }>;
    expect(entries.filter((entry) => entry.shape === 'sprite')).toHaveLength(60);
    expect(entries.filter((entry) => entry.shape === 'box')).toHaveLength(50);
    expect(entries.every((entry) => entry.category === 'signals')).toBe(true);
    controller.dispose();
  });

  it('disposes all handles on cancel and on a successful drop', () => {
    const h = harness(2);
    const controller = new DropTargetOverlayController(h.viewer);
    startDrag();
    expect(controller.targetCount).toBe(2);
    cancelSignalDrag();
    expect(controller.targetCount).toBe(0);

    const el = document.createElement('div');
    el.getBoundingClientRect = () => ({
      left: 100, top: 100, right: 200, bottom: 150, width: 100, height: 50,
      x: 100, y: 100, toJSON: () => ({}),
    });
    document.body.appendChild(el);
    const drop = createSignalDropTarget({ accepts: () => true, onDrop: () => {} });
    drop.attach(el);
    startDrag(150, 125);
    expect(endSignalDrag(150, 125)).toBe('dropped');
    expect(controller.targetCount).toBe(0);
    drop.dispose();
    el.remove();
    controller.dispose();
  });

  it('tears down cleanly on model-clear during an active drag', () => {
    const h = harness(3);
    const controller = new DropTargetOverlayController(h.viewer);
    startDrag();
    expect(controller.targetCount).toBe(3);
    expect(() => controller.dispose()).not.toThrow();
    expect((h.gizmoManager as any)._entries.size).toBe(0);
  });

  it('survives rapid cancel then restart without leaking handles', () => {
    const h = harness(4);
    const controller = new DropTargetOverlayController(h.viewer);
    startDrag();
    expect((h.gizmoManager as any)._entries.size).toBe(8);
    cancelSignalDrag();
    startDrag();
    expect(controller.targetCount).toBe(4);
    expect((h.gizmoManager as any)._entries.size).toBe(8);
    controller.dispose();
  });

  it('honors the signals overlay category visibility', () => {
    const h = harness(2);
    const controller = new DropTargetOverlayController(h.viewer);
    startDrag();
    setOverlayVisible('signals', false);
    const entries = [...(h.gizmoManager as any)._entries.values()] as Array<{ root: Object3D }>;
    expect(entries.every((entry) => entry.root.visible === false)).toBe(true);
    controller.dispose();
  });

  it('is inert when viewer has no signalBindingManager', () => {
    const h = harness(2, 'three', false);
    const controller = new DropTargetOverlayController(h.viewer);
    startDrag();
    expect(controller.targetCount).toBe(0);
    expect((h.gizmoManager as any)._entries.size).toBe(0);
    controller.dispose();
  });

  it('is inert on omniverse and rebuilds when switching back to three', () => {
    const h = harness(2, 'omniverse');
    const controller = new DropTargetOverlayController(h.viewer);
    startDrag();
    expect(controller.targetCount).toBe(0);
    h.setBackend('three');
    controller.onRenderBackendChanged('three');
    expect(controller.targetCount).toBe(2);
    h.setBackend('omniverse');
    controller.onRenderBackendChanged('omniverse');
    expect(controller.targetCount).toBe(0);
    controller.dispose();
  });

  it('runs through the real SignalBindPlugin lifecycle including onRender forwarding', () => {
    const h = harness(1);
    const plugin = new SignalBindPlugin();
    plugin.init(h.viewer);
    plugin.onModelLoaded({ root: h.scene } as unknown as LoadResult, h.viewer);
    startDrag();
    const marker = h.nodes[0].children.find((child) =>
      child.userData._rvGizmo && child.type === 'Sprite' && !child.userData.rvSignalBadge);
    expect(marker).toBeDefined();
    const before = marker!.scale.x;
    plugin.onRender();
    expect(marker!.scale.x).not.toBe(before);
    plugin.onModelCleared();
    expect((h.gizmoManager as any)._entries.size).toBe(0);
    plugin.dispose();
  });

  it('keeps attachToNode box highlights aligned through target translation and rotation', () => {
    const h = harness(1);
    const controller = new DropTargetOverlayController(h.viewer);
    startDrag();
    const box = ([...(h.gizmoManager as any)._entries.values()] as Array<{
      shape: string; root: Object3D;
    }>).find((entry) => entry.shape === 'box')!;
    const target = h.nodes[0];
    target.position.set(3, 2, -1);
    target.rotation.set(0, Math.PI / 2, 0);
    target.updateMatrixWorld(true);
    const boxPosition = box.root.getWorldPosition(new Vector3());
    const targetPosition = target.getWorldPosition(new Vector3());
    const boxRotation = box.root.getWorldQuaternion(new Quaternion());
    const targetRotation = target.getWorldQuaternion(new Quaternion());
    expect(boxPosition.distanceTo(targetPosition)).toBeLessThan(1e-6);
    expect(boxRotation.angleTo(targetRotation)).toBeLessThan(1e-6);
    controller.dispose();
  });

  it('runs auto-open popover and overlay in parallel and preserves a successful drop', () => {
    vi.useFakeTimers();
    const h = harness(1);
    const canvas = h.viewer.renderer.domElement;
    const elementFromPoint = vi.spyOn(document, 'elementFromPoint').mockReturnValue(canvas);
    (h.viewer as any).raycastManager = {
      raycastForRVNodeDetailed: () => ({ path: h.nodes[0].name }),
    };
    const overlay = new DropTargetOverlayController(h.viewer);
    const autoOpen = new SceneDragOpenController(h.viewer);
    startDrag(320, 240);
    expect(overlay.targetCount).toBe(1);
    vi.advanceTimersByTime(51);
    updateSignalDrag(321, 240);
    vi.advanceTimersByTime(251);
    expect(signalBindStore.getSnapshot()).toMatchObject({ kind: 'node', nodePath: h.nodes[0].name });

    const dropEl = document.createElement('div');
    dropEl.getBoundingClientRect = () => ({
      left: 300, top: 220, right: 360, bottom: 260, width: 60, height: 40,
      x: 300, y: 220, toJSON: () => ({}),
    });
    document.body.appendChild(dropEl);
    const onDrop = vi.fn();
    const drop = createSignalDropTarget({ accepts: () => true, onDrop });
    drop.attach(dropEl);
    expect(endSignalDrag(330, 240)).toBe('dropped');
    expect(onDrop).toHaveBeenCalledOnce();
    expect(overlay.targetCount).toBe(0);
    expect(signalBindStore.getSnapshot()).not.toBeNull();
    drop.dispose();
    dropEl.remove();
    autoOpen.dispose();
    overlay.dispose();
    elementFromPoint.mockRestore();
    vi.useRealTimers();
  });

  it('meets the drag-start build budget for 5000 registry nodes and 100 targets', () => {
    const h = harness(100, 'three', true, 5_000);
    const controller = new DropTargetOverlayController(h.viewer);
    makePortMarkerTexture('idle'); // normal app lifetime: shared texture is already warm
    const started = performance.now();
    startDrag();
    const elapsedMs = performance.now() - started;
    console.info(`[drop-target-overlay perf] 5000 nodes / 100 targets: ${elapsedMs.toFixed(2)} ms`);
    expect(controller.targetCount).toBe(100);
    expect(elapsedMs).toBeLessThan(20);
    controller.onRender(); // warm projection/material state
    const renderStarted = performance.now();
    for (let i = 0; i < 120; i++) controller.onRender();
    const averageRenderMs = (performance.now() - renderStarted) / 120;
    console.info(`[drop-target-overlay perf] 100-target onRender average: ${averageRenderMs.toFixed(3)} ms`);
    controller.dispose();
  });
});
