// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-610 fixture — a renderer-free asset-editor viewer with a REAL
 * NodeRegistry, a real three Scene and hand-registered live components, so the
 * reference rewrite and the executor's re-binding can be observed by INSTANCE
 * IDENTITY. (Born in the plan-610 spike, kept as the shared harness of the
 * Phase 2 tests.)
 *
 * The model root is registered as a reference scope exactly like the loader's
 * `initSubtree` does (`registry.registerScopeNames(subtreeRoot, …)`), and a
 * "placement" root carries an `AssetReference` marker plus its own scope
 * registration, like the PlacementInstancer leaves it.
 *
 * `{ signals: true }` adds a REAL `SignalStore`: `register()` then runs the
 * loader traversal (`traverseAndRegister`) over the model, so signal nodes
 * declared BEFORE `register()` (see `signalNode`) are store signals.
 */
import { Group, Object3D, Scene } from 'three';
import type { RVViewer } from '../../src/core/rv-viewer';
import { NodeRegistry } from '../../src/core/engine/rv-node-registry';
import { RVDrive } from '../../src/core/engine/rv-drive';
import { SignalStore } from '../../src/core/engine/rv-signal-store';
import { traverseAndRegister } from '../../src/core/engine/rv-scene-loader';
import { registerComponent, getRegisteredFactories, applySchema, resolveComponentRefs } from '../../src/core/engine/rv-component-registry';
import { assetOpHeader } from '../../src/core/editor/rv-asset-ops';
import type { RvAssetPrimitiveOp } from '../../src/core/ops/rv-unified-ops';

/** A test-only component with several reference fields (scalar Drive refs, a signal ref, an array). */
export const HOLDER = 'SpikeRefHolder';
if (!getRegisteredFactories().has(HOLDER)) {
  registerComponent({
    type: HOLDER,
    schema: {
      DriveA: { type: 'componentRef' },
      DriveB: { type: 'componentRef' },
      Sig: { type: 'componentRef' },
      Tools: { type: 'componentRefArray' },
      Label: { type: 'string', default: '' },
    },
    create(node: Object3D) {
      return { node, init() {} } as never;
    },
  });
}

export function ref(path: string, componentType: string) {
  return { type: 'ComponentReference', path, componentType };
}

export interface SpikeViewerOptions {
  /** A real SignalStore filled by the loader traversal in `register()`. */
  signals?: boolean;
}

export function makeSpikeViewer(opts: SpikeViewerOptions = {}) {
  const scene = new Scene();
  const model = new Group();
  model.name = 'Asset';
  scene.add(model);
  const registry = new NodeRegistry();
  const store = opts.signals ? new SignalStore() : null;
  const events: Array<{ name: string; data: unknown }> = [];
  const viewer = {
    scene,
    registry,
    signalStore: store,
    transportManager: null,
    get currentModelRoot() { return model; },
    drives: [],
    markRenderDirty() {},
    markShadowsDirty() {},
    emit(name: string, data: unknown) { events.push({ name, data }); },
    on() { return () => {}; },
    rebuildGroupedBvh() {},
    refitRaycastSubtrees() {},
    rebuildIKPaths() {},
    getPlugin: () => undefined,
    instancePickIndex: undefined,
    buildMeshBvhsAsync() {},
    selectionManager: { select() {} },
  } as unknown as RVViewer;

  /** Register every node under the model + declare the model root a scope (loader parity). */
  const register = () => {
    model.traverse((n) => registry.registerNode(NodeRegistry.computeNodePath(n), n));
    registry.registerScopeNames(model, ['Asset']);
    if (store) {
      traverseAndRegister(model, registry, store, new Map());
      store.buildIndex();
    }
    model.updateMatrixWorld(true);
  };

  const add = (parent: Object3D, name: string): Object3D => {
    const n = new Group();
    n.name = name;
    parent.add(n);
    return n;
  };

  /** A live RVDrive on `node`, registered under its current path. */
  const drive = (node: Object3D): RVDrive => {
    const d = new RVDrive(node);
    d.initDrive();
    registry.register('Drive', NodeRegistry.computeNodePath(node), d);
    return d;
  };

  /**
   * A signal node (PLCOutputBool), registered like the loader registers one —
   * AFTER `register()`, registry only. `name` sets the `Name` field (absent =
   * the signal name hangs on the node name).
   */
  const signal = (node: Object3D, name?: string) => {
    const path = NodeRegistry.computeNodePath(node);
    const data: Record<string, unknown> = name === undefined ? {} : { Name: name };
    node.userData.realvirtual = { ...(node.userData.realvirtual ?? {}), PLCOutputBool: data };
    registry.register('PLCOutputBool', path, { address: path, signalName: name || node.name });
  };

  /**
   * A signal node declared BEFORE `register()` — with `{ signals: true }` the
   * loader traversal registers it in the real store.
   */
  const signalNode = (parent: Object3D, nodeName: string, signalName?: string, type = 'PLCOutputBool'): Object3D => {
    const n = add(parent, nodeName);
    const data: Record<string, unknown> = { Status: { Value: type.includes('Bool') ? false : 0 } };
    if (signalName !== undefined) data.Name = signalName;
    n.userData.realvirtual = { ...(n.userData.realvirtual ?? {}), [type]: data };
    return n;
  };

  /**
   * A live component of `type` on `node` with `extras` as its rv extras block,
   * built the way the loader builds it: applySchema, then resolveComponentRefs
   * WITH the authoring scope (`node` -> enclosing registered scope root).
   * Call after `register()`.
   */
  const component = (node: Object3D, type: string, extras: Record<string, unknown>): Record<string, unknown> => {
    const path = NodeRegistry.computeNodePath(node);
    node.userData.realvirtual = { ...(node.userData.realvirtual ?? {}), [type]: { ...extras } };
    const factory = getRegisteredFactories().get(type);
    if (!factory) throw new Error(`no factory for ${type}`);
    const inst = { node } as Record<string, unknown>;
    applySchema(inst, factory.schema, extras);
    resolveComponentRefs(inst, registry, node);
    registry.register(type, path, inst);
    return inst;
  };

  return { scene, model, registry, store, viewer, events, register, add, drive, signal, signalNode, component };
}

export type SpikeFixture = ReturnType<typeof makeSpikeViewer>;

export function op<T extends Omit<RvAssetPrimitiveOp, 'id' | 'ts' | 'schemaV'>>(body: T): RvAssetPrimitiveOp {
  return { ...assetOpHeader(), ...body } as unknown as RvAssetPrimitiveOp;
}

export const IDENTITY_T = {
  position: [0, 0, 0] as [number, number, number],
  quaternion: [0, 0, 0, 1] as [number, number, number, number],
  scale: [1, 1, 1] as [number, number, number],
};

/** The rv extras block of `type` on `node`. */
export function extrasOf(node: Object3D, type: string): Record<string, unknown> {
  return ((node.userData.realvirtual ?? {}) as Record<string, Record<string, unknown>>)[type] ?? {};
}
