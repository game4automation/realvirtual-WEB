// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshStandardMaterial, Scene } from 'three';
import type { RVViewer } from '../src/core/rv-viewer';
import { RVLamp } from '../src/core/engine/rv-lamp';
import { LampManager } from '../src/core/engine/rv-lamp-manager';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { RVTransportManager } from '../src/core/engine/rv-transport-manager';
import { processExtras } from '../src/core/engine/rv-scene-loader';
import {
  removePlacedFromScene,
  type SceneMutationDeps,
} from '../src/plugins/layout-planner/scene-mutations';

function setup() {
  const scene = new Scene();
  const root = new Group();
  root.name = 'Layout';
  scene.add(root);
  const placement = new Group();
  placement.name = 'Beacon';
  placement.userData.realvirtual = {
    Lamp: {
      LampOn: false,
    },
  };
  const original = new MeshStandardMaterial();
  const mesh = new Mesh(new BoxGeometry(), original);
  mesh.name = 'Lens';
  placement.add(mesh);
  root.add(placement);

  const registry = new NodeRegistry();
  const signalStore = new SignalStore();
  signalStore.register('LampOn', 'Signals/LampOn', false);
  const transportManager = new RVTransportManager();
  transportManager.scene = scene;
  const lampManager = new LampManager();
  processExtras(
    placement,
    registry,
    signalStore,
    transportManager,
    scene,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    lampManager,
  );
  const lamp = placement.userData._rvLamp as RVLamp;
  lamp.SignalLampOn = 'Signals/LampOn';
  lamp.reapplyConfig();

  const viewer = {
    scene,
    registry,
    signalStore,
    transportManager,
    lampManager,
    drives: [],
    raycastManager: null,
    signalBindingManager: null,
    behaviors: null,
    logicEngine: null,
    rebuildGroupedBvh() {},
    getPlugin() { return undefined; },
  } as unknown as RVViewer;
  const objectMap = new Map([['beacon-1', placement]]);
  const idByObject = new WeakMap([[placement, 'beacon-1']]);
  const deps: SceneMutationDeps = {
    getViewer: () => viewer,
    objectMap,
    idByObject,
    getLayoutRoot: () => root,
    getTransformControls: () => null,
    getModelRoot: () => root,
  };
  return {
    scene,
    root,
    placement,
    mesh,
    original,
    registry,
    signalStore,
    transportManager,
    lampManager,
    lamp,
    objectMap,
    idByObject,
    deps,
  };
}

describe('RVLamp removal cleanup', () => {
  it('Planner removal disposes before unregister and leaves no runtime state', () => {
    const h = setup();
    const runtimeMaterial = h.mesh.material as MeshStandardMaterial;
    expect(runtimeMaterial).not.toBe(h.original);
    expect(h.lampManager.size).toBe(1);
    h.signalStore.set('LampOn', true);
    expect(h.lamp.isLit()).toBe(true);
    h.signalStore.set('LampOn', false);
    expect(h.lamp.isLit()).toBe(false);

    removePlacedFromScene(h.deps, 'beacon-1');
    expect(h.lampManager.size).toBe(0);
    expect(h.mesh.material).toBe(h.original);
    expect(h.mesh.userData._rvLampMesh).toBeUndefined();
    expect(h.placement.userData._rvLamp).toBeUndefined();
    expect(h.placement.userData._rvType).toBeUndefined();
    expect(h.objectMap.has('beacon-1')).toBe(false);

    h.signalStore.set('LampOn', true);
    expect(h.lamp.isLit()).toBe(false);
    expect(runtimeMaterial.emissive.getHex()).toBe(0x000000);
  });

  it('the same placement can be restored by undo and removed again cleanly', () => {
    const h = setup();
    removePlacedFromScene(h.deps, 'beacon-1');
    h.root.add(h.placement);
    h.objectMap.set('beacon-1', h.placement);
    h.idByObject.set(h.placement, 'beacon-1');
    processExtras(
      h.placement,
      h.registry,
      h.signalStore,
      h.transportManager,
      h.scene,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      h.lampManager,
    );
    expect(h.lampManager.size).toBe(1);
    expect(h.mesh.userData._rvLampMesh).toBe(true);
    removePlacedFromScene(h.deps, 'beacon-1');
    expect(h.lampManager.size).toBe(0);
    expect(h.mesh.material).toBe(h.original);
  });

  it('model-switch clear disposes every registered Lamp', () => {
    const h = setup();
    h.lampManager.clear();
    expect(h.lampManager.size).toBe(0);
    expect(h.mesh.material).toBe(h.original);
    expect(h.mesh.userData._rvLampMesh).toBeUndefined();
  });
});
