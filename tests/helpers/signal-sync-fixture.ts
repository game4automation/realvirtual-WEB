// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-589 spike — shared fixture for the editor ↔ SignalStore sync tests.
 *
 * A minimal viewer with a REAL `SignalStore`, a REAL `NodeRegistry` and the
 * REAL `AssetExecutorContext`. `transportManager` stays null, so component
 * construction is skipped exactly as in the other headless executor tests —
 * PLC signals are not components, so nothing the sync needs is lost.
 */

import { Group, Object3D, Scene } from 'three';
import { NodeRegistry } from '../../src/core/engine/rv-node-registry';
import { SignalStore } from '../../src/core/engine/rv-signal-store';
import { traverseAndRegister } from '../../src/core/engine/rv-scene-loader';
import { AssetExecutorContext } from '../../src/core/editor/rv-asset-executors';
import type { NodeTransform } from '../../src/core/editor/rv-asset-ops';
import type { RvAssetOp } from '../../src/core/ops/rv-unified-ops';
import type { RVViewer } from '../../src/core/rv-viewer';

export interface SyncFixture {
  scene: Scene;
  root: Group;
  registry: NodeRegistry;
  store: SignalStore;
  viewer: RVViewer;
  exec: AssetExecutorContext;
}

let seq = 0;
export const head = () => ({ id: `op_s589_${++seq}`, ts: 1, schemaV: 1 as const });
export const IDENTITY: NodeTransform = { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] };

export function node(name: string, parent: Object3D | null, rv?: Record<string, unknown>): Object3D {
  const n = new Object3D();
  n.name = name;
  if (rv) n.userData.realvirtual = rv;
  parent?.add(n);
  return n;
}

export function plc(type: string, name: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { [type]: { Name: name, Status: { Value: type.includes('Bool') ? false : 0 }, ...extra } };
}

/** Build scene → `Asset` root, let the caller populate it, run the REAL loader traversal. */
export function makeSyncFixture(populate: (root: Group) => void): SyncFixture {
  const scene = new Scene();
  const root = new Group();
  root.name = 'Asset';
  scene.add(root);
  populate(root);
  const registry = new NodeRegistry();
  const store = new SignalStore();
  root.traverse((n) => registry.registerNode(NodeRegistry.computeNodePath(n), n));
  traverseAndRegister(root, registry, store, new Map());
  store.buildIndex();
  const viewer = {
    scene, registry, signalStore: store, transportManager: null,
    get currentModelRoot() { return root; },
    drives: [],
    markRenderDirty() {}, markShadowsDirty() {},
    emit() {}, on() { return () => {}; },
    rebuildGroupedBvh() {}, refitRaycastSubtrees() {}, rebuildIKPaths() {},
    getPlugin: () => undefined,
  } as unknown as RVViewer;
  const exec = new AssetExecutorContext(viewer);
  return { scene, root, registry, store, viewer, exec };
}

export async function fwd(f: SyncFixture, op: RvAssetOp): Promise<void> { await f.exec.applyForward(op); }
export async function inv(f: SyncFixture, op: RvAssetOp): Promise<void> { await f.exec.applyInverse(op); }

/** Every (name → canonical path) pair the store would hand to `getPath`, plus value presence. */
export function storeView(store: SignalStore, name: string) {
  return {
    known: store.get(name) !== undefined,
    path: store.getPath(name),
  };
}
