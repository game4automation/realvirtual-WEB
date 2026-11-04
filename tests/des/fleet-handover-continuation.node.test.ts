// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { Object3D } from 'three';
import { RVMovingUnit } from '../../src/core/engine/rv-mu';
import type { DESRunner } from '../../src/plugins/des/des-runner';
import { DesHandoverBackend, PluginOwnerRegistry, CarrierOwner, EndProbe, seatOn } from '../../src/plugins/des/fleet/des-handover';
import { fleetHandoverParticipant } from '../../src/plugins/fleet-job-participants';
import { assertContinuation } from '../helpers/des-continuation-harness';
import { robotDemoWorld, continuationWorld } from './continuation-world-fixture';

function handoverWorld(docked = false, load: 'none' | 'carrier' | 'slot' = 'none') {
  const runner = robotDemoWorld().runner as DESRunner;
  const find = (name: string) => runner.liveInstances.find(i => i.adapter.node.name === name)!.adapter;
  const conveyor = find('Station'), source = find('IndexingConveyor');
  const root = new Object3D(), anchor = new Object3D(); root.add(anchor); root.name = 'Fleet'; anchor.name = 'Anchor';
  const slot = new Object3D(); slot.name = 'FloorSlot'; root.add(slot);
  const backend = new DesHandoverBackend(runner, root,
    new Map([['S', { conveyor, source }]]), new Map(),
    new Map([['V', { root, anchor, lift: null }]]), new Map([['P', slot]]), new PluginOwnerRegistry());
  backend.clock.restoreGeneration(1);
  runner.registerMuVisualFactory('fleet-test', () => new RVMovingUnit(new Object3D(), 'fleet-test'));
  if (load !== 'none') {
    const carrier = backend.carrierOf('V')!;
    carrier.acceptMU(runner.createMU('fleet-test'));
    seatOn(carrier.held!, carrier);
    if (load === 'slot') backend.store('V', 'P');
  }
  let picked = 0;
  backend.setPickHandler(() => {
    picked++;
    const carrier = backend.carrierOf('V')!;
    const mu = carrier.held!;
    carrier.releaseMU(mu);
    runner.getManager().retireMU(mu);
  });
  backend.clock.registerAction('test.handover.pick', () => {
    expect(backend.exportState().outputs[0][1].waiting.length).toBeGreaterThan(0);
    backend.awaitPick('S', 'V', { v: 'V', h: 0, hj: 0 });
  });
  runner.registerSnapshotProvider('test:handover', () => [
    fleetHandoverParticipant(backend), {
      key: 'test.picks', version: 1, capture: () => ({ picked }), validate: () => [],
      prepare: json => (json as { picked: number }).picked,
      commit: p => { picked = p as number; },
    }]);
  if (docked) backend.awaitPick('S', 'V', { v: 'V', h: 0, hj: 0 });
  else if (load === 'none') backend.clock.scheduleAction(310, 'test.handover.pick');
  const world = continuationWorld(runner);
  return { ...world, backend,
    kpis: () => ({ ...world.kpis(), 'test.picks': picked }),
    dispose: () => { backend.dispose(); runner.dispose(); } };
}

describe('fleet handover continuation', () => {
  for (const mode of ['A', 'B', 'B-immediate'] as const) {
    for (const [name, docked, load, T] of [
      ['blocked output', false, 'none', 300],
      ['empty docked carrier', true, 'none', 0],
      ['carried load', false, 'carrier', 0],
      ['occupied floor slot', false, 'slot', 0],
    ] as const) {
      it(`${mode}: ${name}`, async () => {
        await assertContinuation({ buildWorld: () => handoverWorld(docked, load),
          mode, T, TPrime: 320, T2: 350 });
      });
    }
  }
  it('restores a carried MU seated on its carrier', () => {
    const world = handoverWorld(false, 'carrier');
    try {
      const saved = world.runner.fullSnapshot();
      world.backend.store('V', 'P');
      world.runner.restoreFull(saved);
      const carrier = world.backend.carrierOf('V')!;
      expect(carrier.held).not.toBeNull();
      const visual = carrier.held!.visual as { node?: Object3D } | null;
      expect(visual?.node).toBeDefined();
      expect(visual!.node!.parent).toBe(carrier.node);
      expect(visual!.node!.position.toArray()).toEqual(carrier.seatPosition.toArray());
    } finally { world.dispose(); }
  });
  it('restores waiting order and dock wiring without calling listeners', () => {
    const world = handoverWorld();
    try {
      const { backend } = world;
      const probe = backend.ownersInUse.find(o => o instanceof EndProbe)!;
      const saved = backend.exportState();
      saved.outputs[0][1].waiting = [7, 3];
      saved.outputs[0][1].dockedVehicle = 'V';
      const calls: unknown[] = [];
      backend.onPalletReady = (...args) => calls.push(args);
      backend.setPickHandler((...args) => calls.push(args));
      backend.swapState(backend.prepareState(saved));
      expect(backend.exportState().outputs).toEqual(saved.outputs);
      expect(backend.outputConveyor('S')!.nextComponents).toEqual([backend.carrierOf('V')]);
      expect(calls).toEqual([]);
      expect(probe).toBeDefined();
    } finally { world.dispose(); }
  });
});

it('keeps owner ids when the concrete class name changes', () => {
  class RenamedCarrier extends CarrierOwner {}
  const world = handoverWorld(false, 'carrier');
  try {
    const before = world.runner.fullSnapshot();
    const carrier = world.backend.carrierOf('V')!;
    Object.setPrototypeOf(carrier, RenamedCarrier.prototype);
    expect(carrier.constructor.name).toBe('RenamedCarrier');
    expect(carrier.role).toBe('CarrierOwner');
    expect(world.runner.fullSnapshot()).toEqual(before);
    expect(before.parts.some(p => p.key.endsWith('@CarrierOwner'))).toBe(true);
  } finally { world.dispose(); }
});
