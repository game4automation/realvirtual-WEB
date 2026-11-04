// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import type { DESRunner } from '../../src/plugins/des/des-runner';
import type { DESManager } from '../../src/plugins/des/rv-des-manager';
import { registerAction } from '../../src/plugins/des/rv-des-named-actions';
import { fleetSnapshotProvider, zoneSnapshotParticipant } from '../../src/plugins/fleet-snapshot-participants';
import { OrderPool } from '../../src/core/fleet/core/orders';
import { ZoneRegistry } from '../../src/core/engine/rv-zone-registry';
import { RVPath } from '../../src/core/engine/rv-path';
import { robotDemoWorld, continuationWorld } from './continuation-world-fixture';
import { assertContinuation, canonicalJson, compareFullSnapshots, ContinuationMismatch } from '../helpers/des-continuation-harness';

interface Driver {
  pool: OrderPool;
  zones: ZoneRegistry;
  hidden: number;
  hiddenState: boolean;
}
const drivers = new WeakMap<DESManager, Driver>();
const tick = 'Fleet.Test.Tick', retry = 'Fleet.Test.Retry';
type Retry = { vehicle: string; zone: string; orderId: number };
function record(data: unknown): data is Record<string, unknown> {
  return data !== null && typeof data === 'object' && !Array.isArray(data);
}
registerAction(tick, ctx => {
  const manager = ctx.manager as DESManager;
  const d = drivers.get(manager)!;
  const { n } = ctx.data as { n: number };
  const now = manager.currentTime, draw = manager.rng.next();
  if (d.hiddenState) d.hidden++;
  d.pool.add({ source: 'S' + n % 3, destination: draw > 0.7 ? 'D1' : null,
    priority: d.hiddenState && d.hidden % 5 === 0 ? 2 : draw < 0.3 ? 1 : 0 }, now);
  if (n % 2 === 0) {
    const order = d.pool.pending(now)[0];
    if (order) {
      const vehicle = n % 4 === 0 ? 'V1' : 'V2';
      d.pool.assign(order, vehicle, now);
      if (!d.zones.claim('crossing', vehicle)) manager.scheduleEvent(now + 0.5, retry, -1, -1, 0,
        { vehicle, zone: 'crossing', orderId: order.id });
    }
  }
  if (n % 3 === 0) {
    // openOf returns live orders; exportState returns detached copies which
    // must not be passed to markPicked (the source index uses identity).
    const order = ['S0', 'S1', 'S2'].map(source => d.pool.openOf(source))
      .filter(o => o !== null && o.state === 'assigned')
      .sort((a, b) => a!.times.created - b!.times.created)[0];
    if (order) {
      d.pool.markPicked(order, now); d.pool.complete(order, now);
      d.zones.releaseAll(order.vehicle!);
    }
  }
  if (n % 2 === 1) {
    // Release the previous odd tick's bay claim after two ticks.
    d.zones.releaseAll('V1');
    d.zones.claim('bay', 'V' + n % 2);
  } else d.zones.releaseAll('V0');
  if (n < 60) manager.scheduleEvent(n + 1, tick, -1, -1, 0, { n: n + 1 });
}, { owner: 'fleet.orders', payload: data => record(data) && Object.keys(data).length === 1
  && Number.isSafeInteger(data.n) && (data.n as number) >= 1 && (data.n as number) <= 60 ? [] : ['expected {n: integer 1..60}'] });

registerAction(retry, ctx => {
  const manager = ctx.manager as DESManager, d = drivers.get(manager)!;
  const data = ctx.data as Retry;
  if (!d.zones.claim(data.zone, data.vehicle))
    manager.scheduleEvent(manager.currentTime + 0.5, retry, -1, -1, 0, { ...data });
}, { owner: 'fleet.orders', payload: data => record(data) && Object.keys(data).length === 3
  && typeof data.vehicle === 'string' && data.vehicle.length > 0
  && typeof data.zone === 'string' && data.zone.length > 0
  && Number.isSafeInteger(data.orderId) && (data.orderId as number) > 0 ? [] : ['expected {vehicle, zone, orderId}'] });

function fleetWorld(opts: { hiddenState?: boolean } = {}) {
  const runner = robotDemoWorld().runner as unknown as DESRunner;
  const manager = runner.getManager(), pool = new OrderPool(), zones = new ZoneRegistry();
  const paths = new Map<string, RVPath>(['lane-1', 'lane-2'].map(id => [id, new RVPath(id, [])]));
  zones.declare('crossing', paths.get('lane-1')!, 1);
  zones.declare('bay', paths.get('lane-2')!, 2);
  const listenerCalls: { time: number; zone: string }[] = [];
  zones.onAvailabilityChanged(zone => listenerCalls.push({ time: manager.currentTime, zone }));
  const driver: Driver = { pool, zones, hidden: 0, hiddenState: opts.hiddenState ?? false };
  drivers.set(manager, driver);
  const fleetWorld = { orders: pool, zones, paths, stationKnown: (id: string) => ['S0', 'S1', 'S2', 'D1'].includes(id) };
  const ordersProvider = fleetSnapshotProvider(fleetWorld);
  runner.registerSnapshotProvider('plant:fleet', ctx => [...ordersProvider(ctx), zoneSnapshotParticipant(fleetWorld)]);
  manager.scheduleEvent(1, tick, -1, -1, 0, { n: 1 });
  const world = continuationWorld(runner);
  return { ...world, runner, pool, zones, listenerCalls,
    kpis: () => ({ ...world.kpis(), 'fleet.test': { completed: pool.doneCount,
      // Only the negative control exposes this deliberately undeclared state.
      ...(driver.hiddenState ? { hidden: driver.hidden } : {}) } }),
    dispose: () => { drivers.delete(manager); runner.dispose(); } };
}

describe('fleet orders and zones continuation', () => {
  for (const mode of ['A', 'B', 'B-immediate'] as const) {
    it.each([0.5, 7.25, 20])(`${mode}: full continuation at %s`, async T => {
      await assertContinuation({ buildWorld: fleetWorld, mode, T, TPrime: T + 9, T2: 40 });
    });
    it(`${mode}: detects the hidden driver counter`, async () => {
      // A/B can first differ in fleet.orders due to biased priorities. The
      // immediate mode observes the hidden counter through fleet.test KPIs.
      let mismatch: unknown;
      try {
        await assertContinuation({ buildWorld: () => fleetWorld({ hiddenState: true }),
          mode, T: 20, TPrime: 29, T2: 40 });
      } catch (error) { mismatch = error; }
      expect(mismatch).toBeInstanceOf(ContinuationMismatch);
      const failure = mismatch as ContinuationMismatch;
      expect(failure.code).toBe('des-state-not-declared');
      // The biased priority changes assignment order, so the first differing part in A can be the
      // manager (event counters) before fleet.orders: a consequence of the hidden counter, still named.
      expect(['des.manager', 'fleet.orders', 'fleet.zones', 'fleet.test']).toContain(failure.participant);
      if (mode === 'B-immediate') expect(failure.participant).toBe('fleet.test');
    });
  }

  it('restores silently with a queued waiter and preserves continuation and listeners', () => {
    const world = fleetWorld();
    try {
      world.step(20);
      expect(world.pool.pendingCount).toBeGreaterThan(0);
      expect(world.pool.exportState().open.some(o => o.state === 'assigned')).toBe(true);
      expect(world.zones.holdersOf('crossing')).toHaveLength(1);
      const manager = world.runner.getManager();
      expect(manager.snapshot().events.some(e => e.action === retry)).toBe(true);
      // A waiter is still queued when the holder frees the zone. Restoring
      // this cut must not wake it early or allocate a replacement event.
      world.zones.release('crossing', world.zones.holdersOf('crossing')[0]!);
      const saved = world.runner.fullSnapshot();
      const before = { nextEventId: manager.nextEventId, processed: manager.totalEventsProcessed,
        rng: manager.snapshot().rngState };
      const calls = world.listenerCalls.length;
      world.step(40);
      const uninterrupted = world.runner.fullSnapshot();
      const callsBeforeRestore = world.listenerCalls.length;
      world.runner.restoreFull(saved);
      expect(canonicalJson(world.runner.fullSnapshot())).toBe(canonicalJson(saved));
      expect({ nextEventId: manager.nextEventId, processed: manager.totalEventsProcessed,
        rng: manager.snapshot().rngState }).toEqual(before);
      expect(callsBeforeRestore).toBeGreaterThanOrEqual(calls);
      expect(world.listenerCalls).toHaveLength(callsBeforeRestore);
      world.step(40);
      const continued = world.runner.fullSnapshot();
      compareFullSnapshots(uninterrupted, continued);
      // Replay the same cut without adding a release to either trajectory.
      world.runner.restoreFull(saved);
      world.step(40);
      compareFullSnapshots(continued, world.runner.fullSnapshot());
      const holder = world.zones.holdersOf('crossing')[0]!;
      const count = world.listenerCalls.length;
      world.zones.release('crossing', holder);
      expect(world.listenerCalls.slice(count)).toEqual([{ time: 40, zone: 'crossing' }]);
    } finally { world.dispose(); }
  });
});
