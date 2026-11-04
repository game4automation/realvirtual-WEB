// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { BoxGeometry, Mesh, Object3D, Scene } from 'three';
import { ChainTransferFlow, type ChainTransferLocal } from '../../src/behaviors/ChainTransfer';
import { chainTransferRunState, chainTransferServices, chainTransferDerived, chainTransferScratch } from '../../src/behaviors/_shared/chain-transfer-snapshot';
import { runnerFixture } from './runner-fixture';

it('classifies every local field exactly once', () => {
  const keys = [...chainTransferRunState, ...chainTransferServices, ...chainTransferDerived, ...chainTransferScratch];
  expect(new Set(keys).size).toBe(keys.length);
  expect([...keys].sort()).toEqual(Object.keys(ChainTransferFlow.state()).sort());
});

function world() {
  const scene = new Scene();
  const add = (name: string, type: string, props = {}) => {
    const node = new Object3D(); node.name = name;
    node.userData.realvirtual = { [type]: props }; scene.add(node); return node;
  };
  add('Source', 'Source', { Interval: 10000, AutomaticGeneration: false });
  const root = add('Transfer', 'ChainTransfer');
  for (const name of ['Transport-Z', 'Transport-X']) {
    const mesh = new Mesh(new BoxGeometry(1, 0.1, 1)); mesh.name = name; root.add(mesh);
  }
  for (const name of ['Sensor', 'Drive-Lin-Y']) {
    const node = new Object3D(); node.name = name; root.add(node);
  }
  const gateRoot = add('Gate', 'Station', { ProcessingTime: 10000 });
  gateRoot.position.z = 1;
  for (const [owner, name, z] of [[root, 'Snap-ZP-convroll', 0.5], [gateRoot, 'Snap-ZN-convroll', -0.5]] as const) {
    const snap = new Object3D(); snap.name = name; snap.position.z = z; owner.add(snap);
  }
  const f = runnerFixture(scene);
  const [source, transfer, gate] = ['Source', 'Transfer', 'Gate'].map(name => f.components.find(c => c.node.name === name)!);
  source.nextComponents = [transfer]; transfer.previousComponents = [source];
  transfer.nextComponents = [gate]; gate.previousComponents = [transfer];
  f.runner.start([], { root: scene, host: f.host });
  transfer.MaxCapacity = 2;
  const local = transfer.self.local as unknown as ChainTransferLocal;
  return { ...f, transfer, gate, local };
}

it('restores parked and in-flight MUs in a fresh world with membership and sentinel handles', () => {
  const a = world();
  expect(a.gate.acceptMU(a.runner.createMU())).toBe(true);
  expect(a.transfer.acceptMU(a.runner.createMU())).toBe(true);
  a.manager.processAnimated(100);
  expect(a.local.blockedMUs.length).toBeGreaterThan(0);
  const flying = a.runner.createMU();
  expect(a.transfer.acceptMU(flying)).toBe(true);
  const snapshot = a.runner.fullSnapshot();
  const handles = [...a.local.transitMUs];
  const b = world();
  b.runner.restoreFull(snapshot);
  expect(b.local.blockedMUs.map(mu => [mu.id, mu.generation])).toEqual(a.local.blockedMUs.map(mu => [mu.id, mu.generation]));
  expect([...b.local.transitMUs]).toEqual(handles.map(([id]) => [id, -1]));
  for (const [muId, id] of handles) expect(snapshot.eventQueue).toContainEqual(expect.objectContaining({ id, muId, action: 'MF.ChainTransfer.Arrival' }));
  b.manager.processAnimated(100);
  expect(b.local.transitMUs.size).toBe(0);
  expect(b.local.blockedMUs.some(mu => mu.id === flying.id)).toBe(true);
  for (let i = 0; i < 2; i++) {
    expect(b.gate.heldMUs).toHaveLength(1);
    b.gate.releaseMU(b.gate.heldMUs[0]);
    b.manager.processAnimated(0.1);
  }
  expect(b.local.blockedMUs).toHaveLength(0);
  expect(b.gate.heldMUs.some(mu => mu.id === flying.id)).toBe(true);
});

it('rejects unknown saved MU references in prepare before changing the fresh world', () => {
  const a = world();
  a.gate.acceptMU(a.runner.createMU());
  a.transfer.acceptMU(a.runner.createMU());
  a.manager.processAnimated(100);
  const snapshot = a.runner.fullSnapshot();
  const corrupt = (value: unknown): boolean => {
    if (!value || typeof value !== 'object') return false;
    const obj = value as Record<string, unknown>;
    if (Array.isArray(obj.blockedMUs) && obj.blockedMUs[0]?.muRef) {
      obj.blockedMUs[0].muRef.id = 999999;
      return true;
    }
    return Object.values(obj).some(corrupt);
  };
  expect(corrupt(snapshot)).toBe(true);
  const b = world();
  const before = b.runner.fullSnapshot();
  expect(() => b.runner.restoreFull(snapshot)).toThrow(/unknown MU/);
  expect(b.runner.fullSnapshot()).toEqual(before);
});
