// SPDX-License-Identifier: AGPL-3.0-only
import { beforeEach, expect, it } from 'vitest';
import { Object3D, Scene, Vector3 } from 'three';
import { registerMaterialFlow } from '../../src/core/material-flow/registry';
import type { MaterialFlowDefinition } from '../../src/core/material-flow/define-material-flow';
import { getDefaultPathNetwork } from '../../src/core/engine/rv-path-network';
import { TweenRegistry } from '../../src/core/material-flow/tween-registry';
import { RVMovingUnit } from '../../src/core/engine/rv-mu';
import { PathTransport } from '../../src/plugins/des/material-flow/PathTransport';
import { Downtime } from '../../src/plugins/des/material-flow/Downtime';
import { resetDESMUCounter } from '../../src/plugins/des/rv-des-mu';
import { assertContinuation } from '../helpers/des-continuation-harness';
import { continuationWorld } from './continuation-world-fixture';
import { runnerFixture } from './runner-fixture';
import { componentState } from './snapshot-test-utils';

function pathWorld() {
  getDefaultPathNetwork().clear();
  resetDESMUCounter();
  registerMaterialFlow(PathTransport as unknown as MaterialFlowDefinition);
  registerMaterialFlow(Downtime as unknown as MaterialFlowDefinition);
  const scene = new Scene();
  const add = (name: string, type: string, props: object) => {
    const node = new Object3D(); node.name = name;
    node.userData.realvirtual = { [type]: props }; scene.add(node); return node;
  };
  const transfer = add('Transfer', 'PathTransport', { speed: 1000, capacity: 1 });
  const path = new Object3D(); path.name = 'Path';
  path.userData.realvirtual = { Path: { type: 'Path', id: 'FreezePath',
    segments: [{ kind: 'line', from: [0, 0, 0], to: [0, 0, 8] }] } };
  transfer.add(path);
  add('Sink', 'Sink', {});
  // Failure at 7, repair at 17, arrival at 18 instead of 8.
  add('Failure', 'Downtime', { TargetComponentPath: 'Transfer', MTBF: 7, MTTR: 10, Stochastic: false });
  const f = runnerFixture(scene);
  const transport = f.components.find(c => c.node.name === 'Transfer')!;
  const sink = f.components.find(c => c.node.name === 'Sink')!;
  transport.nextComponents = [sink]; sink.previousComponents = [transport];
  f.runner.registerMuVisualFactory('part', () => new RVMovingUnit(new Object3D(), 'part'));
  f.runner.start([], { root: scene, host: f.host });
  const mu = f.runner.createMU('part');
  expect(transport.acceptMU(mu)).toBe(true);
  return { ...continuationWorld(f.runner), runner: f.runner, transport, mu };
}

beforeEach(() => getDefaultPathNetwork().clear());

it('Downtime holds the current path position and delays arrival by its duration', async () => {
  const w = pathWorld();
  try {
    const registry = w.runner.getTweenRegistry();
    // Render immediately before the failure dispatch on a binary-exact grid.
    const beforeFailure = 7 - 2 ** -30;
    await w.step(beforeFailure); registry.settle(beforeFailure);
    const held = w.mu.visual!.node.position.clone();
    await w.step(10);
    expect(w.mu.visual!.node.position.distanceTo(held)).toBe(0);
    expect(w.transport.isFailure).toBe(true);
    expect(w.runner.getTweenRegistry().activeCount).toBe(0);
    const frozen = componentState(w.runner.fullSnapshot(), 'Transfer').frozen!;
    expect(frozen).toHaveLength(1);
    expect(frozen[0]).toMatchObject({ remaining: 1, tween: { kind: 'path', fromS: 7 },
      payload: { tween: { kind: 'path', fromS: 7 } } });
    await w.step(17);
    registry.settle(17);
    expect(w.mu.visual!.node.position.distanceTo(held)).toBeLessThan(1e-8);
    expect(w.transport.isFailure).toBe(false);
    expect(registry.pathSForMu(w.mu.id, 17)).toBe(7);
    expect(w.mu.visual!.node.position.z).toBeCloseTo(7, 12);
    await w.step(17.5); registry.settle(17.5);
    expect(w.mu.visual!.node.position.z).toBeCloseTo(7.5, 12);
    expect(w.transport.currentLoad).toBe(1);
    await w.step(18);
    expect(w.transport.currentLoad).toBe(0);
  } finally { w.runner.dispose(); }
});

for (const mode of ['A', 'B', 'B-immediate'] as const) {
  it.each([10, 17.25])(`${mode}: path continuation at %s`, async T => {
    await assertContinuation({ buildWorld: pathWorld, mode, T, TPrime: 20, T2: 23 });
  });
}

it('samples the latest active path window, including motion profiles and endpoints', () => {
  const r = new TweenRegistry();
  const sampler = { getAbsPosition: (s: number, out: Vector3) => out.set(0, 0, s) };
  r.addPath(sampler, null, 0, 10, 0, 10, 1);
  expect(r.pathSForMu(1, 5)).toBe(5);
  const latest = r.addPath(sampler, null, 10, 20, 2, 4, 1, 'P', t => 10 + (t - 2) ** 2 / 2);
  expect(r.pathSForMu(1, 2)).toBe(10);
  expect(r.pathSForMu(1, 4)).toBe(12);
  expect(r.pathSForMu(1, 6)).toBe(18);
  r.cancel(latest);
  expect(r.pathSForMu(1, 4)).toBe(4);
  expect(r.pathSForMu(1, 10)).toBe(10);
  expect(r.pathSForMu(1, 11)).toBeNull();
  expect(r.pathSForMu(-1, 4)).toBeNull();
  expect(r.pathSForMu(2, 4)).toBeNull();
});
