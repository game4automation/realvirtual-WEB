// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it } from 'vitest';
import { createBatteryModel } from '../../src/core/fleet/core/battery';
import { FleetDispatcher, type FleetDispatcherOptions } from '../../src/core/fleet/core/dispatcher';
import { OrderPool, type FleetStation } from '../../src/core/fleet/core/orders';
import {
  forkliftConsumption, resolveBuiltinStrategy,
  type ConsumptionModel, type DispatchEnv, type VehicleView,
} from '../../src/core/fleet/core/strategies';

const stations: FleetStation[] = [
  { id: 'P1', role: 'pick', pathId: 'P1', storageGroup: 'Buffer', approachM: 2, handlingHeightMm: 1000 },
  { id: 'P2', role: 'pick', pathId: 'P2', storageGroup: 'Buffer', approachM: 2, handlingHeightMm: 1000 },
  { id: 'D1', role: 'drop', pathId: 'D1', approachM: 3, handlingHeightMm: 500 },
  { id: 'D2', role: 'drop', pathId: 'D2', approachM: 3, handlingHeightMm: 500 },
  { id: 'S1', role: 'storage', pathId: 'S1', storageGroup: 'Buffer', approachM: 1, handlingHeightMm: 0 },
  { id: 'S2', role: 'storage', pathId: 'S2', storageGroup: 'Buffer', approachM: 1, handlingHeightMm: 0 },
  { id: 'C1', role: 'charger', pathId: 'C1', approachM: 3, handlingHeightMm: 0 },
];
const consumption: ConsumptionModel = {
  order: () => ({ driveSec: 600, liftM: 0, idleSec: 0 }),
  toCharger: () => ({ driveSec: 60, liftM: 0, idleSec: 0 }),
};
function rates() {
  return {
    startSoc: [100, 100], travelSlack: 1.25,
    drivePerMin: 1, liftPerM: 0, idlePerMin: 0, chargePerMin: 5,
    threshold: 20, target: 80, reserveToCharger: 2, chargerWaitReserveSec: 0,
  };
}
function dispatcher(extra: Partial<FleetDispatcherOptions> = {}): FleetDispatcher {
  return new FleetDispatcher({ stations, battery: createBatteryModel(rates()), consumption, ...extra });
}
const vehicle = (id = 'V1', soc = 100): VehicleView => ({ id, soc, at: 'home' });
const env = (t = 0, receive = true): DispatchEnv => ({
  t, distanceM: (from, to) => from === to ? 0 : 10,
  canReceive: () => receive,
});

describe('OrderPool', () => {
  it('sorts priority before creation time before id', () => {
    const pool = new OrderPool();
    const low = pool.add({ source: 'P1', priority: 0 }, 0);
    const later = pool.add({ source: 'P2', priority: 1 }, 2);
    const firstTie = pool.add({ source: 'P1', priority: 1 }, 1);
    const secondTie = pool.add({ source: 'P2', priority: 1 }, 1);
    expect(pool.pending(3)).toEqual([firstTie, secondTie, later, low]);
  });

  it('deduplicates event offers until pickup, completes, cancels, and resets ids', () => {
    const pool = new OrderPool();
    const first = pool.offer('P1', 'MU1', 0)!;
    expect(first.id).toBe(1);
    expect(pool.offer('P1', 'duplicate', 1)).toBeNull();
    pool.assign(first, 'V1', 2);
    expect(pool.openOf('P1')).toBe(first);
    expect(pool.offer('P1', 'duplicate', 3)).toBeNull();
    pool.markPicked(first, 4);
    const next = pool.offer('P1', 'MU2', 5)!;
    expect(next.id).toBe(2);
    pool.complete(first, 6);
    expect(first.times).toEqual({ created: 0, assigned: 2, picked: 4, done: 6 });
    pool.cancel(next);
    expect(next.state).toBe('cancelled');
    expect(pool.openOf('P1')).toBeNull();
    expect(pool.pending(10)).toEqual([]);
    pool.reset();
    expect(pool.add({ source: 'P1' }, 11).id).toBe(1);
  });
});

describe('FleetDispatcher', () => {
  it('assigns higher priority first, with config-order drops and id-order vehicles on ties', () => {
    const d = dispatcher();
    d.orders.add({ source: 'P1', mu: 'low' }, 0);
    const high = d.orders.add({ source: 'P2', mu: 'high', priority: 1 }, 1);
    const jobs = d.dispatch([vehicle('V2'), vehicle('V1')], env(2));
    expect(jobs.map((j) => [j.kind, j.vehicle, j.kind === 'pick' ? j.from : null]))
      .toEqual([['pick', 'V1', 'P2'], ['pick', 'V2', 'P1']]);
    expect(jobs[0]).toMatchObject({ to: { kind: 'drop', station: 'D1' }, order: high });
    expect(d.reservedBy('P2')).toBe('V1');
    expect(d.reservedBy('D1')).toBe('V1');
  });

  it('holds earliest until the boundary and reports latest once, also while carrying', () => {
    const late: number[] = [];
    const d = dispatcher({ onLate: (order) => late.push(order.id) });
    const order = d.orders.add({ source: 'P1', earliest: 10, latest: 12, mu: 'MU' }, 0);
    expect(d.dispatch([vehicle()], env(9))[0].kind).toBe('park');
    expect(order.state).toBe('pending');
    expect(d.dispatch([vehicle()], env(10))[0].kind).toBe('pick');
    d.picked('V1', 11);
    d.dispatch([vehicle()], env(12));
    expect(late).toEqual([]);
    d.dispatch([vehicle()], env(13));
    d.dispatch([vehicle()], env(14));
    expect(late).toEqual([order.id]);
    d.delivered('V1', 15);
    expect(d.orders.overdue(16)).toEqual([]);
    d.reset();
    d.orders.add({ source: 'P1', latest: 0 }, 0);
    d.dispatch([], env(1));
    expect(late).toEqual([1, 1]);
  });

  it('reports an overdue pending order only once without assigning it', () => {
    let calls = 0;
    const d = dispatcher({ onLate: () => calls++ });
    const order = d.orders.add({ source: 'P1', latest: 0 }, 0);
    d.dispatch([], env(1));
    d.dispatch([], env(2));
    expect(calls).toBe(1);
    expect(order.state).toBe('pending');
  });

  it('charges rejected vehicles, queues FIFO, and gives the queue precedence', () => {
    const d = dispatcher();
    d.orderReady('P1', 0, 'MU');
    expect(d.dispatch([vehicle('V2', 5), vehicle('V1', 5)], env()).map((j) => [j.kind, j.vehicle]))
      .toEqual([['charge', 'V1'], ['queue', 'V2']]);
    expect(d.orders.openOf('P1')?.state).toBe('pending');
    expect(d.chargerQueue).toEqual(['V2']);
    d.chargeDone('V1');
    const jobs = d.dispatch([vehicle('V0', 5), vehicle('V2', 5)], env(1));
    expect(jobs.map((j) => [j.kind, j.vehicle])).toEqual([['charge', 'V2'], ['queue', 'V0']]);
    expect(d.reservedBy('C1')).toBe('V2');
  });

  it('keeps rejection for the whole round even if a later order is cheap enough', () => {
    const d = dispatcher({ consumption: {
      ...consumption,
      order: (_m, from) => ({ driveSec: from.id === 'P1' ? 6000 : 0, liftM: 0, idleSec: 0 }),
    } });
    d.orderReady('P1', 0, 'MU1');
    d.orderReady('P2', 1, 'MU2');
    expect(d.dispatch([vehicle('V1', 50)], env(1))[0].kind).toBe('charge');
    expect(d.waitingSources()).toEqual(['P1', 'P2']);
  });

  it('uses direct drops, else the source storage group, and leaves full-buffer orders pending', () => {
    const direct = dispatcher();
    direct.orderReady('P1', 0, 'MU');
    expect(direct.dispatch([vehicle()], env())[0]).toMatchObject({ to: { kind: 'drop', station: 'D1' } });
    const d = dispatcher();
    d.orderReady('P1', 0, 'MU1');
    d.orderReady('P2', 0, 'MU2');
    const jobs = d.dispatch([vehicle('V2'), vehicle('V1')], env(0, false));
    expect(jobs).toMatchObject([
      { kind: 'pick', to: { kind: 'buffer', station: 'S1' } },
      { kind: 'pick', to: { kind: 'buffer', station: 'S2' } },
    ]);
    expect(d.reservedBy('S1')).toBe('V1');
    for (const v of ['V1', 'V2']) { d.picked(v, 1); d.delivered(v, 2); }
    expect(d.storage('Buffer').occupancy()).toBe(2);
    expect(d.reservedBy('P1')).toBeNull();
    expect(d.reservedBy('S1')).toBeNull();
    d.orderReady('P1', 3, 'MU3');
    expect(d.dispatch([vehicle()], env(3, false))[0].kind).toBe('park');
    expect(d.orders.openOf('P1')?.state).toBe('pending');
  });

  it('calls retrieval once per round, passes waiting sources, and commits FIFO retrieval', () => {
    const calls: { t: number; waiting: readonly string[] }[] = [];
    const d = dispatcher({ retrieval: (ctx) => {
      calls.push({ t: ctx.t, waiting: ctx.waitingSources() });
      return true;
    } });
    d.storage('Buffer').commitStore('S2', 'older', 0);
    d.storage('Buffer').commitStore('S1', 'newer', 1);
    expect(d.dispatch([vehicle()], env(2))[0]).toMatchObject({ kind: 'retrieve', from: 'S2', to: 'D1' });
    expect(calls).toEqual([{ t: 2, waiting: [] }]);
    d.picked('V1', 3);
    expect(d.jobOf('V1')).toMatchObject({ pallet: 'older', loaded: true });
    expect(d.reservedBy('S2')).toBeNull();
    d.delivered('V1', 4);
    expect(d.reservedBy('D1')).toBeNull();
    d.dispatch([vehicle()], env(5));
    expect(calls).toHaveLength(2);
    const noRule = dispatcher();
    noRule.storage('Buffer').commitStore('S1', 'MU', 0);
    expect(noRule.dispatch([vehicle()], env())[0].kind).toBe('park');
    expect(noRule.storage('Buffer').occupancy()).toBe(1);
  });

  it('produces identical job sequences for identical events and after reset', () => {
    const sequence = (d: FleetDispatcher): string[] => {
      const log: string[] = [];
      for (let t = 0; t < 5; t++) {
        d.orderReady('P2', t, `MU${t}`);
        log.push(JSON.stringify(d.dispatch([vehicle('V2'), vehicle('V1')], env(t))));
        d.picked('V1', t + 0.25);
        d.delivered('V1', t + 0.5);
      }
      return log;
    };
    const a = dispatcher(), b = dispatcher();
    const expected = sequence(a);
    expect(sequence(b)).toEqual(expected);
    a.reset();
    expect(a.reservations.size).toBe(0);
    expect(a.jobOf('V1')).toBeNull();
    expect(sequence(a)).toEqual(expected);
  });

  it('uses a drop\'s named storage group, otherwise the first group', () => {
    const grouped = stations.map((s) => s.id === 'S2' || s.id === 'D1'
      ? { ...s, storageGroup: 'Other' } : s);
    const d = dispatcher({ stations: grouped, retrieval: () => true });
    d.storage('Buffer').commitStore('S1', 'first-group', 0);
    d.storage('Other').commitStore('S2', 'named-group', 1);
    expect(d.dispatch([vehicle('V1'), vehicle('V2')], env(2))).toMatchObject([
      { kind: 'retrieve', from: 'S2', to: 'D1' },
      { kind: 'retrieve', from: 'S1', to: 'D2' },
    ]);
  });

  it('lets the retrieval rule veto the round and observes pending sources in config order', () => {
    const waiting: (readonly string[])[] = [];
    const d = dispatcher({ retrieval: (ctx) => { waiting.push(ctx.waitingSources()); return false; } });
    d.storage('Buffer').commitStore('S1', 'MU', 0);
    d.orders.add({ source: 'P2', earliest: 10 }, 0);
    d.orders.add({ source: 'P1', earliest: 10 }, 0);
    expect(d.dispatch([vehicle()], env())[0].kind).toBe('park');
    expect(waiting).toEqual([['P1', 'P2']]);
    expect(d.storage('Buffer').occupancy()).toBe(1);
  });
});

describe('built-in strategies and live planning parameters', () => {
  it('resolves names by kind, reports unknown names, and defaults empty names silently', () => {
    const reports: string[][] = [];
    const report = (code: string, detail: string) => reports.push([code, detail]);
    expect(resolveBuiltinStrategy('vehicleSelection', 'nearest-feasible', report)).toBe('nearest-feasible');
    expect(resolveBuiltinStrategy('charging', 'threshold-opportunity', report)).toBe('threshold-opportunity');
    for (const name of ['', null, undefined]) expect(resolveBuiltinStrategy('charging', name, report)).toBe('threshold-opportunity');
    expect(reports).toEqual([]);
    expect(resolveBuiltinStrategy('vehicleSelection', 'unknown', report)).toBe('nearest-feasible');
    expect(reports[0][0]).toBe('fleet-strategy-unknown');
    for (const part of ['vehicleSelection', 'unknown', 'nearest-feasible']) expect(reports[0][1]).toContain(part);
    expect(resolveBuiltinStrategy('charging', 'nearest-feasible', report)).toBe('threshold-opportunity');
    expect(reports).toHaveLength(2);
  });

  it('reads battery threshold and target from the passed project object at call time', () => {
    const cfg = rates();
    const battery = createBatteryModel(cfg);
    expect(battery.config).toBe(cfg);
    expect(battery.needsCharge(30)).toBe(false);
    cfg.threshold = 40; cfg.target = 90;
    expect(battery.needsCharge(30)).toBe(true);
    expect(battery.chargeTimeSec(80)).toBe(120);
    const d = dispatcher({ battery });
    expect(d.dispatch([vehicle('V1', 80)], env())[0]).toMatchObject({ kind: 'charge', untilSoc: 90, durationSec: 120 });
  });

  it('preserves forklift strokes and reads current consumption parameters', () => {
    const params = {
      travelSpeedMmS: 2000, reverseSpeedMmS: 500, liftSpeedLoadedMmS: 50,
      liftSpeedEmptyMmS: 100, travelHeightMm: 100, handlingDeltaMm: 100,
      travelSlack: 1.25, idleReserveSec: 120,
    };
    const model = forkliftConsumption(() => params);
    expect(model.order(10, stations[0], stations[2], true)).toEqual({ driveSec: 26.25, liftM: 3, idleSec: 167 });
    expect(model.order(10, stations[0], stations[2], false).idleSec).toBe(47);
    expect(model.toCharger(10, stations[6])).toEqual({ driveSec: 12.25, liftM: 0, idleSec: 0 });
    params.travelSlack = 2; params.idleReserveSec = 60;
    expect(model.order(10, stations[0], stations[2], true)).toEqual({ driveSec: 30, liftM: 3, idleSec: 107 });
    expect(model.toCharger(10, stations[6]).driveSec).toBe(16);
  });
});
