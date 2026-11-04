// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { expect, it } from 'vitest';
import { BoxGeometry, Mesh, Object3D, Scene } from 'three';
import { ConveyorFlow } from '../../src/behaviors/Conveyor';
import type { MaterialFlowDefinition } from '../../src/core/material-flow/define-material-flow';
import { registerMaterialFlow } from '../../src/core/material-flow/registry';
import { runnerFixture } from './runner-fixture';

it('9.24 restores parked conveyor and Storage MUs and releases both when successors free', () => {
  registerMaterialFlow(ConveyorFlow as unknown as MaterialFlowDefinition);
  const scene = new Scene();
  const add = (name: string, type: string, props = {}) => {
    const node = new Object3D(); node.name = name;
    node.userData.realvirtual = { [type]: props }; scene.add(node); return node;
  };
  const belt = add('Belt', 'Conveyor');
  const transport = new Mesh(new BoxGeometry(1, 0.1, 0.2)); transport.name = 'Transport-X';
  const sensor = new Object3D(); sensor.name = 'Sensor'; belt.add(transport, sensor);
  add('Buffer', 'Storage', { MaxCapacity: 2, AutoRelease: false });
  add('BeltGate', 'Station', { ProcessingTime: 10000 });
  add('BufferGate', 'Station', { ProcessingTime: 10000 });
  const f = runnerFixture(scene);
  const part = (name: string) => f.components.find(c => c.node.name === name)!;
  const pairs = [[part('Belt'), part('BeltGate')], [part('Buffer'), part('BufferGate')]];
  for (const [upstream, gate] of pairs) {
    upstream.nextComponents = [gate]; gate.previousComponents = [upstream];
  }
  f.runner.start([], { root: scene });
  const ids: number[] = [];
  for (const [upstream, gate] of pairs) {
    expect(gate.acceptMU(f.runner.createMU())).toBe(true);
    const mu = f.runner.createMU(); ids.push(mu.id);
    expect(upstream.acceptMU(mu)).toBe(true);
  }
  f.manager.processAnimated(100);
  expect((part('Belt').self.local as unknown as { blockedMUs: unknown[] }).blockedMUs).toHaveLength(1);
  expect(part('Buffer').currentLoad).toBe(1);
  const snapshot = f.runner.fullSnapshot();
  // Empty the live queues after saving; restore must rebuild from saved state,
  // not accidentally retain a reference to the old parked MU.
  for (const [, gate] of pairs) gate.releaseMU(gate.heldMUs[0]);
  expect(part('Belt').currentLoad).toBe(0);
  expect(part('Buffer').currentLoad).toBe(0);
  f.runner.restoreFull(snapshot);
  for (const [upstream] of pairs) expect(upstream.currentLoad).toBe(1);
  pairs.forEach(([upstream, gate], i) => {
    gate.releaseMU(gate.heldMUs[0]);
    expect.soft(upstream.currentLoad, upstream.node.name).toBe(0);
    expect.soft(gate.heldMUs.map(mu => mu.id), gate.node.name).toEqual([ids[i]]);
  });
  transport.geometry.dispose();
});
