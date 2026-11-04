// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { vi } from 'vitest';
import { BoxGeometry, Mesh, Object3D, Scene } from 'three';
import { ConveyorFlow } from '../../src/behaviors/Conveyor';
import { registerMaterialFlow } from '../../src/core/material-flow/registry';
import type { MaterialFlowDefinition } from '../../src/core/material-flow/define-material-flow';
import { RVSource, registerEngineSourceForNode } from '../../src/core/engine/rv-source';
import { runnerFixture } from './runner-fixture';

/** Production source binding and engine visual factory; topology is explicit. */
export function sourceFixture(mode: 'animated' | 'fastforward', belts = 0, limited = false, contained = false) {
  registerMaterialFlow(ConveyorFlow as unknown as MaterialFlowDefinition);
  const scene = new Scene();
  const add = (name: string, type: string, props = {}) => {
    const node = new Object3D(); node.name = name;
    node.position.x = scene.children.length * 10; // no accidental contained/snap links
    node.userData.realvirtual = { [type]: props };
    scene.add(node);
    return node;
  };
  const source = add('Source', 'Source', { Interval: 1, LimitNumber: limited, MaxNumberMUs: 5 });
  source.add(new Mesh(new BoxGeometry(0.2, 0.2, 0.2)));
  const engine = new RVSource(source);
  engine.LimitNumber = limited; engine.MaxNumberMUs = 5;
  engine.computeSpawnConfig({ AutomaticGeneration: true, Interval: 1, LimitNumber: limited, MaxNumberMUs: 5 });
  engine.spawnParent = scene;
  engine.setTemplate(source);
  registerEngineSourceForNode(source, engine);
  for (let i = 0; i < belts; i++) {
    const node = add(`Conveyor${i}`, 'Conveyor');
    const belt = new Mesh(new BoxGeometry(0.8, 0.1, 1)); belt.name = 'Transport-Z';
    const sensor = new Object3D(); sensor.name = 'Sensor';
    node.add(belt, sensor);
    if (contained && i === 0) {
      // PalletYard-style source on the first belt. The resolver must establish
      // the contained link before runnerFixture clears the explicit topology.
      source.position.set(node.position.x, 0.05, -0.2);
      for (const x of [-0.42, 0.42]) {
        const guide = new Mesh(new BoxGeometry(0.04, 0.6, 1));
        guide.position.set(x, 0.25, 0);
        node.add(guide);
      }
    }
  }
  add('Storage', 'Storage', { MaxCapacity: 50, AutoRelease: true, AutoReleaseDelay: 10000 });
  add('Sink', 'Sink');
  add('SlowConsumer', 'Station', { ProcessingTime: 10000 });
  const f = runnerFixture(scene);
  const part = (name: string) => f.components.find(c => c.node.name === name)!;
  const connect = (from: string, to: string) => {
    part(from).nextComponents.push(part(to));
    part(to).previousComponents.push(part(from));
  };
  const created = vi.spyOn(f.runner, 'createMU');
  return {
    ...f, scene, part, connect, created,
    start() {
      f.runner.setSubMode(mode);
      f.manager.duration = 300;
      f.runner.start([], { root: scene });
    },
    advance(t: number) {
      if (mode === 'fastforward') f.manager.processUpTo(t, 1000000);
      else { for (let i = 0; i < t * 10; i++) { f.runner.tick(0.1); f.runner.lateTick(0.1); } }
    },
  };
}
