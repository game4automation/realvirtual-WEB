// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Shared fixture for the plan-419 marker-key normalization suites.
 *
 * The point of these tests is the PATH MATRIX: the same extras must produce the
 * same single `RVCollisionRole` no matter which of the three construction paths
 * built the node (`traverseAndRegister` = loadGLB, `processExtras` = placed
 * subtree, `createRuntimeNode` = op-log `addNode`). So the fixture exposes one
 * runner per path with an identical result shape, and the suites iterate it.
 */

import { Object3D, Scene } from 'three';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { RVTransportManager } from '../src/core/engine/rv-transport-manager';
import {
  traverseAndRegister,
  initializeComponents,
  processExtras,
  createRuntimeNode,
  type RuntimeNodeDeps,
} from '../src/core/engine/rv-scene-loader';
import type {
  CollisionRoleName,
  CollisionRoleRegistrar,
} from '../src/core/engine/rv-collision-role';

/** Records what the component told the collision manager, in order. */
export class FakeCollisionRegistrar implements CollisionRoleRegistrar {
  readonly registered: { node: Object3D; role: CollisionRoleName }[] = [];
  readonly unregistered: Object3D[] = [];
  invalidations = 0;

  register(node: Object3D, role: CollisionRoleName): void {
    this.registered.push({ node, role });
  }
  unregister(node: Object3D): void {
    this.unregistered.push(node);
  }
  invalidate(): void {
    this.invalidations++;
  }
  /** Role of the most recent registration, or null when there was none. */
  get lastRole(): CollisionRoleName | null {
    return this.registered.length > 0
      ? this.registered[this.registered.length - 1].role
      : null;
  }
}

/** What every path runner returns, so the suites can assert path-independently. */
export interface PathResult {
  node: Object3D;
  path: string;
  registry: NodeRegistry;
  registrar: FakeCollisionRegistrar;
  /** Every component registered at `path`, canonical key included. */
  componentsAt(): Array<[string, unknown]>;
  /** The live rv_extras of the node AFTER the path ran. */
  extras(): Record<string, unknown>;
}

export type PathRunner = (extras: Record<string, unknown>) => PathResult;

/** `Root/Door` with the given rv_extras — the shape all three paths consume. */
function buildScene(extras: Record<string, unknown>): {
  scene: Scene; root: Object3D; node: Object3D;
} {
  const scene = new Scene();
  const root = new Object3D();
  root.name = 'Root';
  const node = new Object3D();
  node.name = 'Door';
  node.userData.realvirtual = extras;
  root.add(node);
  scene.add(root);
  scene.updateMatrixWorld(true);
  return { scene, root, node };
}

function commonResult(
  node: Object3D, registry: NodeRegistry, registrar: FakeCollisionRegistrar,
): PathResult {
  const path = NodeRegistry.computeNodePath(node);
  return {
    node,
    path,
    registry,
    registrar,
    componentsAt: () => registry.getComponentsAt(path),
    extras: () => node.userData.realvirtual as Record<string, unknown>,
  };
}

/** Path 1 — the normal `loadGLB` traverse (STEP 1 + STEP 2). */
export const runLoadGLBPath: PathRunner = (extras) => {
  const { scene, root, node } = buildScene(extras);
  const registry = new NodeRegistry();
  const signalStore = new SignalStore();
  const transportManager = new RVTransportManager();
  const registrar = new FakeCollisionRegistrar();

  const result = traverseAndRegister(root, registry, signalStore, new Map());
  initializeComponents(result.pending, {
    registry, signalStore, scene, transportManager, root,
    collisionManager: registrar,
  });
  return commonResult(node, registry, registrar);
};

/** Path 2 — `processExtras()`, the placed-subtree / layout-planner path. */
export const runProcessExtrasPath: PathRunner = (extras) => {
  const { scene, root, node } = buildScene(extras);
  const registry = new NodeRegistry();
  const signalStore = new SignalStore();
  const registrar = new FakeCollisionRegistrar();

  processExtras(
    root, registry, signalStore, new RVTransportManager(), scene,
    undefined, undefined, undefined, undefined, { collisionManager: registrar },
  );
  return commonResult(node, registry, registrar);
};

/** Path 3 — `createRuntimeNode()`, the op-log `addNode` path. */
export const runCreateRuntimeNodePath: PathRunner = (extras) => {
  const { scene, root } = buildScene({});
  const registry = new NodeRegistry();
  const signalStore = new SignalStore();
  const registrar = new FakeCollisionRegistrar();
  registry.registerNode(NodeRegistry.computeNodePath(root), root);

  const deps: RuntimeNodeDeps = {
    registry, signalStore, scene,
    transportManager: new RVTransportManager(),
    collisionManager: registrar,
  };
  const node = createRuntimeNode(deps, {
    parentPath: NodeRegistry.computeNodePath(root),
    name: 'Door2',
    position: [0, 0, 0],
    quaternion: [0, 0, 0, 1],
    scale: [1, 1, 1],
    components: extras as Record<string, Record<string, unknown>>,
  });
  if (!node) throw new Error('createRuntimeNode returned null');
  return commonResult(node, registry, registrar);
};

/** The path matrix every plan-419 suite iterates. */
export const CONSTRUCTION_PATHS: ReadonlyArray<readonly [name: string, run: PathRunner]> = [
  ['loadGLB traverse', runLoadGLBPath],
  ['processExtras', runProcessExtrasPath],
  ['createRuntimeNode', runCreateRuntimeNodePath],
];
