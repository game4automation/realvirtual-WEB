// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * A small asset-editor world for the plan-525 authoring tests: a real
 * `AssetDocument` over a narrow fake viewer that DOES carry a registry, a
 * signal store, a transport manager and a gizmo manager, so the executors'
 * `addComponent` builds live `RVBoxCollider` / `RVPhysicsZone` instances
 * exactly as in the editor (`constructComponentOnNode`).
 */

import {
  BoxGeometry, Group, Mesh, MeshBasicMaterial, Object3D, PerspectiveCamera, Scene,
} from 'three';
// Registers every built-in component type (BoxCollider, WebPhysicsZone, …).
import '../../src/core/engine/rv-scene-loader';
import { NodeRegistry } from '../../src/core/engine/rv-node-registry';
import { GizmoOverlayManager } from '../../src/core/engine/rv-gizmo-manager';
import { RVTransportManager } from '../../src/core/engine/rv-transport-manager';
import { SignalStore } from '../../src/core/engine/rv-signal-store';
import { RVPhysicsZone } from '../../src/core/engine/rv-physics-zone';
import type { RVViewer } from '../../src/core/rv-viewer';
import type { AssetDocument } from '../../src/core/editor/rv-asset-document';
import { scratchAssetDocument } from './scratch-asset-document';

export const RIG_W = 400;
export const RIG_H = 300;

export interface AuthoringRig {
  scene: Scene;
  root: Group;
  registry: NodeRegistry;
  gizmos: GizmoOverlayManager;
  viewer: RVViewer;
  doc: AssetDocument;
  canvas: HTMLCanvasElement;
  camera: PerspectiveCamera;
  /** Current primary selection path. */
  readonly primaryPath: string | null;
  select(path: string | null): void;
  /** Add an empty node (or a unit-cube mesh) under `parent` and register it. */
  addNode(name: string, opts?: { parent?: Object3D; mesh?: boolean; extras?: Record<string, unknown> }): Object3D;
  pathOf(node: Object3D): string;
  dispose(): void;
}

export function makeAuthoringRig(): AuthoringRig {
  RVPhysicsZone.clearAll();
  const scene = new Scene();
  const root = new Group();
  root.name = 'Asset';
  scene.add(root);
  const registry = new NodeRegistry();
  registry.registerNode('Asset', root);
  const gizmos = new GizmoOverlayManager(scene);

  const canvas = document.createElement('canvas');
  canvas.style.cssText = `position:fixed;left:0;top:0;width:${RIG_W}px;height:${RIG_H}px`;
  document.body.appendChild(canvas);
  const camera = new PerspectiveCamera(50, RIG_W / RIG_H, 0.01, 100);
  camera.position.set(1.2, 0.9, 1.5);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();

  let primary: string | null = null;
  const listeners = new Set<() => void>();
  const selectionManager = {
    get primaryPath() { return primary; },
    subscribe(fn: () => void) { listeners.add(fn); return () => listeners.delete(fn); },
    select(path: string | null) { primary = path; for (const fn of listeners) fn(); },
    getSnapshot() { return { primaryPath: primary, selectedPaths: primary ? [primary] : [] }; },
    clear() { primary = null; for (const fn of listeners) fn(); },
  };
  const viewer = {
    scene, registry, camera,
    renderer: { domElement: canvas },
    controls: { enabled: true },
    selectionManager,
    signalStore: new SignalStore(),
    transportManager: new RVTransportManager(),
    gizmoManager: gizmos,
    instancePickIndex: null,
    get currentModelRoot() { return root; },
    markRenderDirty() {}, markShadowsDirty() {},
    emit() {}, on() { return () => {}; },
    rebuildGroupedBvh() {}, refitRaycastSubtrees() {}, rebuildIKPaths() {},
    getPlugin: () => undefined,
  } as unknown as RVViewer;
  const doc = scratchAssetDocument(viewer);

  const rig: AuthoringRig = {
    scene, root, registry, gizmos, viewer, doc, canvas, camera,
    get primaryPath() { return primary; },
    select(path) { selectionManager.select(path); },
    addNode(name, opts = {}) {
      const node = opts.mesh
        ? new Mesh(new BoxGeometry(0.2, 0.2, 0.2), new MeshBasicMaterial())
        : new Object3D();
      node.name = name;
      if (opts.extras) node.userData.realvirtual = opts.extras;
      (opts.parent ?? root).add(node);
      node.updateMatrixWorld(true);
      registry.registerNode(NodeRegistry.computeNodePath(node), node);
      return node;
    },
    pathOf(node) { return NodeRegistry.computeNodePath(node); },
    dispose() {
      doc.dispose();
      RVPhysicsZone.clearAll();
      gizmos.destroy();
      canvas.remove();
    },
  };
  return rig;
}

/** The node's rv_extras (empty object when none). */
export function rvOf(node: Object3D | null | undefined): Record<string, Record<string, unknown>> {
  return (node?.userData?.realvirtual ?? {}) as Record<string, Record<string, unknown>>;
}
