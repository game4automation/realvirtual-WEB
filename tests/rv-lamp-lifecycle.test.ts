// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it } from 'vitest';
import {
  BoxGeometry,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  Scene,
} from 'three';
import {
  constructComponentOnNode,
  createRuntimeNode,
  processExtras,
  type RuntimeNodeDeps,
} from '../src/core/engine/rv-scene-loader';
import { RVLamp } from '../src/core/engine/rv-lamp';
import { LampManager } from '../src/core/engine/rv-lamp-manager';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { RVTransportManager } from '../src/core/engine/rv-transport-manager';

function harness() {
  const scene = new Scene();
  const root = new Object3D();
  root.name = 'Root';
  scene.add(root);
  const registry = new NodeRegistry();
  registry.registerNode('Root', root);
  const signalStore = new SignalStore();
  const transportManager = new RVTransportManager();
  transportManager.scene = scene;
  const lampManager = new LampManager();
  const deps: RuntimeNodeDeps = {
    registry,
    signalStore,
    scene,
    transportManager,
    lampManager,
  };
  return { scene, root, registry, signalStore, transportManager, lampManager, deps };
}

function lens(name = 'Lens', materials = 1): Mesh {
  const material = Array.from(
    { length: materials },
    () => new MeshStandardMaterial({ color: 0x777777 }),
  );
  const mesh = new Mesh(new BoxGeometry(), materials === 1 ? material[0] : material);
  mesh.name = name;
  return mesh;
}

describe('RVLamp lifecycle paths', () => {
  it('binds through the real Add Component constructor and is idempotent', () => {
    const h = harness();
    const node = new Object3D();
    node.name = 'Beacon';
    const mesh = lens();
    node.add(mesh);
    h.root.add(node);
    h.registry.registerNode('Root/Beacon', node);
    node.userData.realvirtual = { Lamp: { LampOn: true } };

    const lamp = constructComponentOnNode(
      h.deps,
      node,
      'Lamp',
      { LampOn: true },
    ) as RVLamp;
    const cloned = mesh.material;
    lamp.onSceneReady!({
      ...h.deps,
      root: h.root,
    } as any);
    expect(mesh.material).toBe(cloned);
    expect(lamp.isLit()).toBe(true);
    expect(h.lampManager.size).toBe(1);
  });

  it('late-binds after kinematic re-parenting', () => {
    const h = harness();
    const placement = new Object3D();
    placement.name = 'KinematicFixture';
    const lampNode = new Object3D();
    lampNode.name = 'BeaconAxis';
    lampNode.userData.realvirtual = {
      Lamp: { LampOn: true },
      Kinematic: { IntegrateGroupEnable: true, GroupName: 'BeaconLens' },
    };
    const mesh = lens();
    mesh.userData.realvirtual = { Group: { GroupName: 'BeaconLens' } };
    placement.add(lampNode, mesh);
    h.root.add(placement);

    processExtras(
      placement,
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
    const lamp = lampNode.userData._rvLamp as RVLamp;
    expect(mesh.parent).toBe(lampNode);
    expect(mesh.userData._rvLampMesh).toBe(true);
    expect(lamp.isLit()).toBe(true);
  });

  it('binds a runtime node after geometry is attached and config reapplied', () => {
    const h = harness();
    const node = createRuntimeNode(h.deps, {
      parentPath: 'Root',
      name: 'RuntimeBeacon',
      position: [0, 0, 0],
      quaternion: [0, 0, 0, 1],
      scale: [1, 1, 1],
      components: { Lamp: { LampOn: true } },
    })!;
    const mesh = lens();
    node.add(mesh);
    const lamp = node.userData._rvLamp as RVLamp;
    lamp.reapplyConfig();
    expect(mesh.userData._rvLampMesh).toBe(true);
    expect(lamp.isLit()).toBe(true);
  });

  it('selects the first eligible mesh, supports self meshes and clones array slots', () => {
    const h = harness();
    const node = new Object3D();
    node.name = 'Selection';
    const helper = lens('_Helper');
    const first = lens('First', 2);
    const second = lens('Second');
    node.add(helper, first, second);
    h.root.add(node);
    h.registry.registerNode('Root/Selection', node);
    const originals = first.material as MeshStandardMaterial[];
    const lamp = constructComponentOnNode(h.deps, node, 'Lamp', {}) as RVLamp;
    const slots = first.material as MeshStandardMaterial[];
    expect(helper.userData._rvLampMesh).toBeUndefined();
    expect(first.userData._rvLampMesh).toBe(true);
    expect(second.userData._rvLampMesh).toBeUndefined();
    expect(slots).toHaveLength(2);
    expect(slots[0]).not.toBe(originals[0]);
    expect(slots[1]).not.toBe(originals[1]);
    lamp.dispose();

    const self = lens('Self');
    self.userData.realvirtual = { Lamp: { LampOn: true } };
    h.root.add(self);
    h.registry.registerNode('Root/Self', self);
    const selfLamp = constructComponentOnNode(h.deps, self, 'Lamp', { LampOn: true }) as RVLamp;
    expect(self.userData._rvLampMesh).toBe(true);
    expect(selfLamp.isLit()).toBe(true);
  });
});
