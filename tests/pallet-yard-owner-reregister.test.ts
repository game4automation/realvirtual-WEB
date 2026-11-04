// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { expect, it } from 'vitest';
import { Object3D, Scene } from 'three';
import { DesHandoverBackend, PluginOwnerRegistry } from '../src/plugins/des/fleet/des-handover';
import { composeYard } from '../src/plugins/models/PalletYard/yard-compose';
import { defineMaterialFlow } from '../src/core/material-flow/define-material-flow';
import { registerMaterialFlow } from '../src/core/material-flow/registry';
import { sceneFixture } from './des/phase6-scene-fixture';

/** Real backend ownership binding; no GLB or private scene loader is needed. */
function yard() {
  const scene = new Scene();
  const def = defineMaterialFlow({ type: 'Phase6YardPart', kind: 'station', schema: {}, continuous: {}, des: {} });
  registerMaterialFlow(def);
  const nodes = new Map<string, Object3D>();
  let composition = composeYard(4);
  const resize = (size: number) => {
    composition = composeYard(size);
    const required = new Set<string>();
    const add = (name: string, adapter = false) => {
      required.add(name);
      if (nodes.has(name)) return;
      const node = new Object3D(); node.name = name;
      if (adapter) node.userData.realvirtual = { [def.type]: {} };
      scene.add(node); nodes.set(name, node);
    };
    for (const slot of composition.slots) add(slot.node);
    for (const vehicle of composition.vehicles) add(vehicle.id);
    for (const station of composition.stations.filter(s => s.kind === 'pick')) {
      add(`Conveyor_${station.id}`, true); add(`Source_${station.id}`, true);
    }
    for (const [name, node] of nodes) if (!required.has(name)) { scene.remove(node); nodes.delete(name); }
  };
  resize(4);
  const f = sceneFixture(scene);
  const owners = new PluginOwnerRegistry();
  const bind = () => {
    const component = (name: string) => f.runner.liveInstances.find(i => i.adapter.node === nodes.get(name))!.adapter;
    const outputs = new Map(composition.stations.filter(s => s.kind === 'pick').map(s => [s.id, {
      conveyor: component(`Conveyor_${s.id}`), source: component(`Source_${s.id}`),
    }]));
    const vehicles = new Map(composition.vehicles.map(v => [v.id, {
      root: nodes.get(v.id)!, anchor: nodes.get(v.id)!, lift: null,
    }]));
    const slots = new Map(composition.slots.map(s => [s.station, nodes.get(s.node)!]));
    return new DesHandoverBackend(f.runner, scene, outputs, new Map(), vehicles, slots, owners);
  };
  return { ...f, owners, bind, resize };
}

it('9.23 re-registers every reused owner after an empty-queue reset and rebind', () => {
  const f = yard();
  let backend = f.bind();
  try {
    const original = [...backend.ownersInUse];
    const c = composeYard(4).counts;
    expect(original).toHaveLength(c.outputs + c.vehicles + c.slots);
    for (const operation of ['reset', 'rebindScene'] as const) {
      backend.dispose();
      expect(f.manager.queuedEventCount).toBe(0);
      f.runner[operation]();
      backend = f.bind();
      expect(backend.ownersInUse).toEqual(original);
      for (const owner of backend.ownersInUse) {
        expect.soft(f.manager.getComponentByEntityId(owner.entityId), `${operation}: ${owner.node.name}`).toBe(owner);
      }
    }
  } finally { backend.dispose(); f.owners.clear(); }
});

it('9.23 shrinking composeYard from size four to two releases removed node owners', () => {
  const f = yard();
  let backend = f.bind();
  try {
    const original = [...backend.ownersInUse];
    backend.dispose();
    f.resize(2);
    f.runner.rebindScene();
    backend = f.bind();
    const c = composeYard(2).counts;
    const count = c.outputs + c.vehicles + c.slots;
    const removed = original.filter(owner => !backend.ownersInUse.includes(owner));
    expect(removed.length).toBeGreaterThan(0);
    expect(backend.ownersInUse).toHaveLength(count);
    expect.soft(f.owners.all()).toHaveLength(count);
    for (const owner of removed) expect.soft(f.owners.all()).not.toContain(owner);
    for (const owner of backend.ownersInUse) {
      expect.soft(f.manager.getComponentByEntityId(owner.entityId)).toBe(owner);
    }
  } finally { backend.dispose(); f.owners.clear(); }
});
