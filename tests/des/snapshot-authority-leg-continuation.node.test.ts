// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { afterEach, expect, it } from 'vitest';
import { Object3D } from 'three';
import { DESRunner } from '../../src/plugins/des/des-runner';
import '../../src/behaviors/Agv';
import { getDefaultMovementAuthority } from '../../src/core/engine/rv-movement-authority';
import { decodeAuthorityData, record } from '../../src/core/engine/rv-movement-authority-snapshot';
import { getDefaultPathNetwork } from '../../src/core/engine/rv-path-network';
import { parsePathExtras } from '../../src/core/engine/rv-path';
import { positionAt } from '../../src/core/engine/rv-motion-profile';
import { assertContinuation, compareFullSnapshots, type ContinuationWorld } from '../helpers/des-continuation-harness';
import { clearShared, makeAgvRoot } from '../helpers/agv-harness';
import { runnerFixture } from './runner-fixture';
import { decodeHookPayload, encodeHookPayload } from '../../src/plugins/des/rv-des-hook-payload-codec';
import { tagLegTween, type LegDescriptor } from '../../src/core/engine/rv-leg-tween';

afterEach(() => { clearShared(); });

function buildWorld(): ContinuationWorld & { runner: DESRunner } {
  clearShared();

  const net = getDefaultPathNetwork();
  net.register(parsePathExtras({ type: 'Path', id: 'Entry', successors: ['Bend'],
    segments: [{ kind: 'line', from: [10, 0, -4], to: [10, 0, 0] }] }, 'Entry')!);
  net.register(parsePathExtras({ type: 'Path', id: 'Bend',
    segments: [{ kind: 'arc', center: [0, 0, 0], radius: 10, startAngle: 0, degrees: 90 }] }, 'Bend')!);
  net.resolveGraph();
  const scene = new Object3D();
  const vehicle = makeAgvRoot('LegVehicle', { PathId: 'Entry', StartPosition: 1000,
    TargetSpeed: 2000, Destination: 'Bend', ServiceTime: 100,
    VehicleLength: 1000, VehicleWidth: 600, ScannerFields: false });
  scene.add(vehicle);
  const { runner, manager, host } = runnerFixture(scene);
  runner.start([], { root: scene, host });
  // Bind the vehicle/host via the initial Generate/flush at time zero. Mode B
  // then restores into new services without advancing an existing journey.
  runner.tick(0); runner.lateTick(0);
  const authority = getDefaultMovementAuthority('des');
  return {
    runner,
    step(toT) {
      while (manager.currentTime < toT) {
        const before = manager.currentTime;
        const dt = Math.min(0.25, toT - before);
        // Advance the event clock on an exact grid, then synchronize the
        // runner's render clock without advancing it a second time.
        manager.processAnimated(dt);
        runner.tick(0); runner.lateTick(0);
        if (manager.currentTime === before) throw new Error(`AGV world stopped before ${toT}`);
      }
      if (toT === 2 || toT === 8) {
        const plan = authority.planOf('LegVehicle')!;
        const saved = record(decodeAuthorityData(authority.exportState())).vehicles[0];
        expect(plan.route.map(r => r.path.id)).toEqual(['Entry', 'Bend']);
        expect(saved.legEvent).toBeGreaterThanOrEqual(0);
        expect(manager.currentTime).toBeLessThan(plan.profile.tEnd);
        expect(positionAt(plan.profile, manager.currentTime)).toBeGreaterThan(plan.profile.x0);
        expect(vehicle.position.toArray()).not.toEqual([10, 0, -3]);
      }
    },
    kpis: () => ({
      'fleet.authority': authority.exportState(),
      vehicle: { position: vehicle.position.toArray(), quaternion: vehicle.quaternion.toArray() },
      statistics: Object.fromEntries(runner.liveInstances.map(i => [i.desId!, i.adapter.getStatistics()])),
      activeTweens: runner.getTweenRegistry().activeCount,
    }),
    trace: () => [],
    dispose() { runner.dispose(); clearShared(); },
  };
}

// Compare every participant first (with the harness's first divergent path),
// then the full envelope, including queue ids, event counters and simTime.
for (const mode of ['A', 'B'] as const) {
  it.each([2, 8])(`${mode}: exact multi-path curved-leg continuation at %s`, async T => {
    await assertContinuation({ buildWorld: () => {
      const world = buildWorld();
      // Require JSON transport in mode A as well as the harness's mode B.
      const restore = world.runner.restoreFull.bind(world.runner);
      world.runner.restoreFull = raw => restore(JSON.parse(JSON.stringify(raw)));
      return world;
    }, mode, T, TPrime: 30, T2: 60 });
  });
}

it('retains the leg window and pose immediately, without a second arrival or duplicate tween', () => {
  const world = buildWorld();
  try {
    world.step(8);
    const saved = world.runner.fullSnapshot();
    const before = world.kpis();
    expect(before.activeTweens).toBe(1);
    const arrival = saved.eventQueue.find(e => e.action === 'MF.Agv.Arrival')!;
    expect(arrival).toBeDefined();
    const payload = (arrival.data as { data: { leg: unknown; legWindow: unknown; tween?: unknown } }).data;
    expect(payload.leg).toBeDefined(); expect(payload.legWindow).toBeDefined(); expect(payload.tween).toBeUndefined();
    world.step(30);
    world.runner.restoreFull(JSON.parse(JSON.stringify(saved)));
    compareFullSnapshots(saved, world.runner.fullSnapshot());
    expect(world.kpis()).toEqual(before);
    const authorityPart = saved.parts.find(p => p.key === 'fleet.authority')!;
    const legEvent = record(decodeAuthorityData(authorityPart.state)).vehicles[0].legEvent;
    world.runner.liveInstances[0].self.cancel(legEvent);
    expect(world.kpis().activeTweens).toBe(0);
  } finally { world.dispose?.(); }
});

it('roundtrips the inner leg tween of Replan(stop) without serializing runtime closures', () => {
  const world = buildWorld();
  try {
    world.step(2);
    const raw = world.runner.fullSnapshot();
    const event = raw.eventQueue.find(e => e.action === 'MF.Agv.Arrival')!;
    const saved = (event.data as unknown as { data: { leg: LegDescriptor;
      legWindow: { t0: number; t1: number; duration: number } } }).data;
    const leg = saved.leg;
    const tween = getDefaultMovementAuthority('des').rebuildLegTween(
      leg.vehicleId, leg.planVersion, leg.fromX, leg.toX);
    tagLegTween(tween, { leg, ...saved.legWindow });
    const stop = { kind: 'stop', ...(tween as object) };
    const wire = JSON.parse(JSON.stringify(encodeHookPayload(stop)!.value));
    expect(wire).toEqual({ kind: 'stop', ...saved });
    const live = decodeHookPayload(wire, { raw, componentId: event.componentId, eventId: event.id, time: event.time });
    expect(encodeHookPayload(live)!.value).toEqual(wire);
    expect(world.runner.fullSnapshot()).toEqual(raw);
  } finally { world.dispose?.(); }
});

it.each(['planVersion', 'fromX', 'duration'] as const)('rejects corrupt leg %s before mutation', field => {
  const world = buildWorld();
  try {
    world.step(8);
    const before = world.runner.fullSnapshot();
    const corrupt = JSON.parse(JSON.stringify(before));
    const payload = corrupt.eventQueue.find((e: { action: string }) => e.action === 'MF.Agv.Arrival').data.data;
    if (field === 'duration') payload.legWindow.duration += 0.125;
    else payload.leg[field] += 1;
    expect(() => world.runner.restoreFull(corrupt)).toThrow();
    compareFullSnapshots(before, world.runner.fullSnapshot());
  } finally { world.dispose?.(); }
});
