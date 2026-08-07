// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it, vi } from 'vitest';
import { BoxGeometry, Mesh, MeshStandardMaterial, Object3D, Scene } from 'three';
import type { RVViewer } from '../src/core/rv-viewer';
import { AssetExecutorContext } from '../src/core/editor/rv-asset-executors';
import type { AssetSetFieldOp } from '../src/core/editor/rv-asset-ops';
import { constructComponentOnNode } from '../src/core/engine/rv-scene-loader';
import { RVLamp } from '../src/core/engine/rv-lamp';
import { LampManager } from '../src/core/engine/rv-lamp-manager';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { RVTransportManager } from '../src/core/engine/rv-transport-manager';

const signalRef = (path: string) => ({
  type: 'ComponentReference',
  path,
  componentType: 'realvirtual.PLCOutputBool',
});

function setup() {
  const scene = new Scene();
  const root = new Object3D();
  root.name = 'Asset';
  const node = new Object3D();
  node.name = 'Beacon';
  const mesh = new Mesh(new BoxGeometry(), new MeshStandardMaterial());
  mesh.name = 'Lens';
  node.add(mesh);
  root.add(node);
  scene.add(root);
  const path = 'Asset/Beacon';
  const registry = new NodeRegistry();
  registry.registerNode('Asset', root);
  registry.registerNode(path, node);
  const signalStore = new SignalStore();
  signalStore.register('OnA', 'Signals/OnA', false);
  signalStore.register('OnB', 'Signals/OnB', false);
  const transportManager = new RVTransportManager();
  transportManager.scene = scene;
  const lampManager = new LampManager();
  const data = {
    SignalLampOn: signalRef('Signals/OnA'),
    Period: 1,
    OnColor: { r: 1, g: 0, b: 0, a: 1 },
  };
  node.userData.realvirtual = { Lamp: { ...data } };
  const lamp = constructComponentOnNode(
    { registry, signalStore, scene, transportManager, lampManager },
    node,
    'Lamp',
    data,
  ) as RVLamp;
  const viewer = {
    scene,
    registry,
    signalStore,
    transportManager,
    lampManager,
    instancePickIndex: null,
    get currentModelRoot() { return root; },
    markRenderDirty() {},
    markShadowsDirty() {},
    emit() {},
  } as unknown as RVViewer;
  return {
    lamp,
    mesh,
    path,
    signalStore,
    executor: new AssetExecutorContext(viewer),
  };
}

function setField(
  fieldName: string,
  value: unknown,
  prev: unknown,
  id = fieldName,
): AssetSetFieldOp {
  return {
    id,
    ts: 1,
    schemaV: 1,
    kind: 'setField',
    nodePath: 'Asset/Beacon',
    componentType: 'Lamp',
    fieldName,
    value,
    prev,
  };
}

describe('RVLamp reapplyConfig through the real asset executor', () => {
  it('rebinds color, period and signal without leaking the old subscription', async () => {
    const h = setup();
    const spy = vi.spyOn(h.lamp, 'reapplyConfig');
    const green = { r: 0, g: 1, b: 0, a: 1 };
    await h.executor.applyForward(setField('OnColor', green, { r: 1, g: 0, b: 0, a: 1 }));
    await h.executor.applyForward(setField('Period', 2, 1));
    await h.executor.applyForward(setField(
      'SignalLampOn',
      signalRef('Signals/OnB'),
      signalRef('Signals/OnA'),
    ));

    expect(spy).toHaveBeenCalledTimes(3);
    expect(spy.mock.calls.every((args) => args.length === 0)).toBe(true);
    expect(h.lamp.Period).toBe(2);
    h.signalStore.set('OnA', true);
    expect(h.lamp.isLit()).toBe(false);
    h.signalStore.set('OnB', true);
    expect(h.lamp.isLit()).toBe(true);
    const material = h.mesh.material as MeshStandardMaterial;
    expect(material.emissive.getHex()).toBe(0x00ff00);
  });

  it('undo and redo rebind to exactly the active signal', async () => {
    const h = setup();
    const op = setField(
      'SignalLampOn',
      signalRef('Signals/OnB'),
      signalRef('Signals/OnA'),
      'signal-switch',
    );
    await h.executor.applyForward(op);
    h.signalStore.set('OnB', true);
    expect(h.lamp.isLit()).toBe(true);

    h.signalStore.set('OnA', false);
    await h.executor.applyInverse(op);
    h.signalStore.set('OnB', false);
    expect(h.lamp.isLit()).toBe(false);
    h.signalStore.set('OnA', true);
    expect(h.lamp.isLit()).toBe(true);

    await h.executor.applyForward(op);
    h.signalStore.set('OnA', false);
    expect(h.lamp.isLit()).toBe(false);
    h.signalStore.set('OnB', true);
    expect(h.lamp.isLit()).toBe(true);
  });
});
