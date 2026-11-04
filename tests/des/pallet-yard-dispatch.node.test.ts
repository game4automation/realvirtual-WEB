// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
// plan-612 §9.1 + §9.1e — PalletYard order rule, buffer FIFO, reservations,
// vehicle choice and the energy admission (pure logic).
import { describe, expect, it } from 'vitest';
import type { FleetDispatcher } from '../../src/core/fleet/core/dispatcher';
import { forkliftConsumption, type DispatchEnv, type Job, type VehicleView } from '../../src/core/fleet/core/strategies';
import { consume, energyOf, minSocFor, reserveAfterOrder } from '../../src/core/fleet/core/battery';
import { isPaused } from '../../src/core/fleet/core/order-sources';
import { createYardDispatcher, fleetStationsOf } from '../../src/plugins/models/PalletYard/dispatch-policy';
import { PALLET_YARD_CONFIG, type PalletYardConfig } from '../../src/plugins/models/PalletYard/layout';

const CFG = PALLET_YARD_CONFIG;
const drops = CFG.stations.filter((s) => s.kind === 'drop').map((s) => s.id);
const stations = fleetStationsOf(CFG);
const station = (id: string) => stations.find((s) => s.id === id)!;
const consumption = (cfg: PalletYardConfig) => forkliftConsumption(() => ({
  ...cfg.vehicle, travelSlack: cfg.battery.travelSlack, idleReserveSec: cfg.shippingPauses.durationSec,
}));

/** A 1-D stand-in for the route length: every path id sits at one coordinate (m). */
const POS: Record<string, number> = {
  Stich_A1: 0, Stich_P1: 2, Stich_P2: 3, Stich_P3: 4, Stich_P4: 5, Stich_P5: 6, Stich_P6: 7,
  Stich_A2: 10, Stich_W: 14, Stich_L1: 15, Stich_L2: 16, Stich_V1: 20, Stich_V2: 25,
  atA1: 0, atA2: 10, atW: 14, atV1: 20,
};

function env(t = 0, busyInputs: string[] = []): DispatchEnv {
  return {
    t,
    distanceM: (a, b) => Math.abs((POS[a] ?? 0) - (POS[b] ?? 0)),
    canReceive: (s, now) => !busyInputs.includes(s) && !isPaused(CFG.shippingPauses, drops.indexOf(s), now),
  };
}
const veh = (id: string, soc: number, at = 'atW'): VehicleView => ({ id, soc, at });
const byVehicle = (jobs: Job[]): Record<string, Job> => Object.fromEntries(jobs.map((j) => [j.vehicle, j]));

/** Complete a pick/retrieve: picked then delivered. */
function finish(d: FleetDispatcher, vehicle: string, t: number): void {
  d.picked(vehicle, t);
  d.delivered(vehicle, t + 1);
}

describe('PalletYard order rule', () => {
  it('equal readiness times keep config order even when notifications arrive in reverse order', () => {
    const d = createYardDispatcher(CFG);
    d.orderReady('A2', 10, 'second');
    d.orderReady('A1', 10, 'first');
    const jobs = d.dispatch([veh('Stapler_1', 90)], env(10));
    expect(byVehicle(jobs).Stapler_1).toMatchObject({ kind: 'pick', from: 'A1', pallet: 'first' });
    expect(d.waitingSources()).toEqual(['A2']);
  });

  it('a free shipping input is the direct destination (nearest input)', () => {
    const d = createYardDispatcher(CFG);
    d.orderReady('A1', 10, 'p1');
    const jobs = byVehicle(d.dispatch([veh('Stapler_1', 90)], env(10)));
    expect(jobs.Stapler_1).toMatchObject({ kind: 'pick', from: 'A1', to: { kind: 'drop', station: 'V1' }, pallet: 'p1' });
    expect(d.reservedBy('A1')).toBe('Stapler_1');
    expect(d.reservedBy('V1')).toBe('Stapler_1');
  });

  it('both inputs occupied → the floor slot that has been free the longest', () => {
    const d = createYardDispatcher(CFG);
    // P1 held a pallet until t=50; every other slot has never been used.
    d.storage('Buffer').commitStore('P1', 'old', 0);
    d.storage('Buffer').commitRetrieve('P1', 50);
    d.storage('Buffer').commitStore('P2', 'x', 1);
    d.orderReady('A1', 60, 'p1');
    const jobs = byVehicle(d.dispatch([veh('Stapler_1', 90)], env(60, ['V1', 'V2'])));
    expect(jobs.Stapler_1).toMatchObject({ kind: 'pick', to: { kind: 'buffer', station: 'P3' } });
    expect(d.reservedBy('P3')).toBe('Stapler_1');
  });

  it('buffer full and inputs occupied → no order, the output jams, the vehicle parks', () => {
    const d = createYardDispatcher(CFG);
    ['P1', 'P2', 'P3', 'P4', 'P5', 'P6'].forEach((s, i) => d.storage('Buffer').commitStore(s, `b${i}`, i));
    d.orderReady('A1', 10, 'p1');
    const jobs = d.dispatch([veh('Stapler_1', 60)], env(10, ['V1', 'V2']));
    expect(jobs).toEqual([{ kind: 'park', vehicle: 'Stapler_1' }]);   // no Opportunity Charging: an order is open
    expect(d.waitingSources()).toEqual(['A1']);
    expect(d.dispatch([veh('Stapler_1', 60)], env(11, ['V1', 'V2']))).toEqual([]); // idempotent
  });

  it('a paused input counts as not free', () => {
    const d = createYardDispatcher(CFG);
    d.orderReady('A1', 400, 'p1');                     // V1 pauses 300..600
    const jobs = byVehicle(d.dispatch([veh('Stapler_1', 90)], env(400)));
    expect(jobs.Stapler_1).toMatchObject({ kind: 'pick', to: { kind: 'drop', station: 'V2' } });
    const d2 = createYardDispatcher(CFG);
    d2.orderReady('A1', 400, 'p1');
    const jobs2 = byVehicle(d2.dispatch([veh('Stapler_1', 90)], env(400, ['V2'])));
    expect(jobs2.Stapler_1).toMatchObject({ kind: 'pick', to: { kind: 'buffer' } });
  });

  it('FIFO: an input frees and no output waits → the pallet stored first leaves first', () => {
    const d = createYardDispatcher(CFG);
    d.storage('Buffer').commitStore('P4', 'third', 30);
    d.storage('Buffer').commitStore('P2', 'first', 10);
    d.storage('Buffer').commitStore('P6', 'second', 20);
    const jobs = byVehicle(d.dispatch([veh('Stapler_1', 90)], env(40, ['V2'])));
    expect(jobs.Stapler_1).toMatchObject({ kind: 'retrieve', from: 'P2', to: 'V1' });
    d.picked('Stapler_1', 50);
    expect(d.jobOf('Stapler_1')).toMatchObject({ pallet: 'first', loaded: true });
    d.delivered('Stapler_1', 60);
    expect(d.storage('Buffer').occupancy()).toBe(2);
    expect(d.reservedBy('V1')).toBeNull();
  });

  it('a pallet waiting at an output has precedence over a retrieval', () => {
    const d = createYardDispatcher(CFG);
    d.storage('Buffer').commitStore('P1', 'stored', 1);
    d.orderReady('A2', 5, 'fresh');
    const jobs = d.dispatch([veh('Stapler_1', 90, 'atW'), veh('Stapler_2', 90, 'atW')], env(10, ['V2']));
    expect(jobs.filter((j) => j.kind === 'pick')).toHaveLength(1);
    expect(jobs.filter((j) => j.kind === 'retrieve')).toHaveLength(0);
    expect(byVehicle(jobs).Stapler_1).toMatchObject({ kind: 'pick', from: 'A2', to: { kind: 'drop', station: 'V1' } });
  });

  it('two simultaneous assignments never get the same target', () => {
    const d = createYardDispatcher(CFG);
    d.orderReady('A1', 10, 'a');
    d.orderReady('A2', 10, 'b');
    const jobs = d.dispatch([veh('Stapler_1', 90), veh('Stapler_2', 90), veh('Stapler_3', 90)], env(10, ['V2']));
    const picks = jobs.filter((j): j is Extract<Job, { kind: 'pick' }> => j.kind === 'pick');
    expect(picks).toHaveLength(2);
    expect(new Set(picks.map((p) => p.to.station)).size).toBe(2);
    expect(new Set(picks.map((p) => p.vehicle)).size).toBe(2);
    expect(picks.map((p) => p.to.kind).sort()).toEqual(['buffer', 'drop']);

    // Two buffer stores at once get two different slots.
    const d2 = createYardDispatcher(CFG);
    d2.orderReady('A1', 10, 'a');
    d2.orderReady('A2', 11, 'b');
    const j2 = d2.dispatch([veh('Stapler_1', 90), veh('Stapler_2', 90)], env(12, ['V1', 'V2']));
    const slots = j2.map((j) => (j.kind === 'pick' ? j.to.station : null));
    expect(slots[0]).not.toBeNull();
    expect(slots[0]).not.toBe(slots[1]);
  });

  it('the nearest admissible vehicle wins; a tie goes to the smallest id', () => {
    const d = createYardDispatcher(CFG);
    d.orderReady('A2', 10, 'p');
    const near = byVehicle(d.dispatch([veh('Stapler_1', 90, 'atV1'), veh('Stapler_3', 90, 'atA2')], env(10)));
    expect(near.Stapler_3).toMatchObject({ kind: 'pick' });

    const t = createYardDispatcher(CFG);
    t.orderReady('A1', 10, 'p');
    const tie = byVehicle(t.dispatch([veh('Stapler_3', 90, 'atW'), veh('Stapler_2', 90, 'atW')], env(10)));
    expect(tie.Stapler_2).toMatchObject({ kind: 'pick' });
    expect(tie.Stapler_3).toMatchObject({ kind: 'park' });
  });

  it('jobs complete and release their reservations', () => {
    const d = createYardDispatcher(CFG);
    d.orderReady('A1', 10, 'p');
    d.dispatch([veh('Stapler_1', 90)], env(10, ['V1', 'V2']));
    const job = d.jobOf('Stapler_1') as Extract<Job, { kind: 'pick' }>;
    finish(d, 'Stapler_1', 20);
    expect(d.jobOf('Stapler_1')).toBeNull();
    expect(d.reservedBy('A1')).toBeNull();
    expect(d.storage('Buffer').place(job.to.station)).toMatchObject({ unit: 'p', storedAt: 21, reservedBy: null });
  });
});

describe('PalletYard energy admission (SOL #8)', () => {
  it('reads live battery and consumption parameters after construction', () => {
    const cfg = structuredClone(CFG);
    const d = createYardDispatcher(cfg);
    cfg.battery.target = 95;
    expect(byVehicle(d.dispatch([veh('Stapler_1', 90)], env(10))).Stapler_1)
      .toMatchObject({ kind: 'charge', untilSoc: 95 });
    d.reset();
    cfg.battery.target = 80;
    cfg.vehicle.travelSpeedMmS = 1;
    d.orderReady('A1', 10, 'p');
    expect(byVehicle(d.dispatch([veh('Stapler_1', 90)], env(10))).Stapler_1)
      .toMatchObject({ kind: 'charge' });
    expect(d.waitingSources()).toEqual(['A1']);
  });

  // With the demo values the admission boundary (~10 %) lies below the charge
  // threshold (30 %); a lower threshold isolates the admission rule itself.
  const LOW: PalletYardConfig = { ...CFG, battery: { ...CFG.battery, threshold: 5 } };

  /** SOC that exactly admits the A1 → V1 order for a vehicle at the wait point. */
  function boundarySoc(cfg: PalletYardConfig = LOW): number {
    const a1 = station('A1');
    const v1 = station('V1');
    const l2 = station('L2');
    const e = env(10);
    const travel = e.distanceM('atW', a1.pathId) + e.distanceM(a1.pathId, v1.pathId);
    const order = consumption(cfg).order(travel, a1, v1, true);
    const toCharger = consumption(cfg).toCharger(e.distanceM(v1.pathId, l2.pathId), l2);
    return minSocFor(order, toCharger, cfg.battery);
  }

  it('a vehicle whose SOC does not cover order + way to charger + wait reserve is charged at once', () => {
    const soc = boundarySoc();
    expect(soc - 0.01).toBeGreaterThan(LOW.battery.threshold); // not a threshold charge — the admission rejects
    const d = createYardDispatcher(LOW);
    d.orderReady('A1', 10, 'p');
    const jobs = byVehicle(d.dispatch([veh('Stapler_1', soc - 0.01)], env(10)));
    expect(jobs.Stapler_1).toMatchObject({ kind: 'charge', untilSoc: LOW.battery.target });
    expect(d.waitingSources()).toEqual(['A1']);
  });

  it('exactly on the boundary the order is admitted', () => {
    const d = createYardDispatcher(LOW);
    d.orderReady('A1', 10, 'p');
    const jobs = byVehicle(d.dispatch([veh('Stapler_1', boundarySoc())], env(10)));
    expect(jobs.Stapler_1).toMatchObject({ kind: 'pick' });
  });

  it('both chargers busy → wait point + FIFO charger queue; a freed charger goes to the queue head', () => {
    const d = createYardDispatcher(CFG);
    const low = [veh('Stapler_1', 20), veh('Stapler_2', 25), veh('Stapler_3', 28)];
    const jobs = byVehicle(d.dispatch(low, env(10)));
    const kinds = Object.values(jobs).map((j) => j.kind).sort();
    expect(kinds).toEqual(['charge', 'charge', 'queue']);               // two charge, one waits
    expect(jobs.Stapler_3).toEqual({ kind: 'queue', vehicle: 'Stapler_3' });
    expect(d.chargerQueue).toEqual(['Stapler_3']);
    expect(d.dispatch(low, env(11))).toEqual([]);                       // nobody without a follow-up
    const charging = (jobs.Stapler_1 as Extract<Job, { kind: 'charge' }>).charger;
    d.chargeDone('Stapler_1');
    const next = byVehicle(d.dispatch([veh('Stapler_1', 80), veh('Stapler_2', 25), veh('Stapler_3', 28)], env(700)));
    expect(next.Stapler_3).toMatchObject({ kind: 'charge', charger: charging });
    expect(d.chargerQueue).toEqual([]);
    expect(next.Stapler_1).toMatchObject({ kind: 'park' });
  });

  it('a queued vehicle has precedence over a new charge request', () => {
    const d = createYardDispatcher(CFG);
    d.dispatch([veh('Stapler_1', 20), veh('Stapler_2', 21), veh('Stapler_3', 22)], env(0));
    d.chargeDone('Stapler_2');
    const jobs = byVehicle(d.dispatch([veh('Stapler_1', 20), veh('Stapler_2', 25), veh('Stapler_3', 22)], env(5)));
    expect(jobs.Stapler_3).toMatchObject({ kind: 'charge' });
    expect(jobs.Stapler_2).toEqual({ kind: 'queue', vehicle: 'Stapler_2' });   // threshold still undercut → queues
  });

  it('Opportunity Charging only when no order is open and the SOC is below target', () => {
    const d = createYardDispatcher(CFG);
    expect(byVehicle(d.dispatch([veh('Stapler_1', 70)], env(0))).Stapler_1).toMatchObject({ kind: 'charge' });
    const full = createYardDispatcher(CFG);
    expect(byVehicle(full.dispatch([veh('Stapler_1', 85)], env(0))).Stapler_1).toEqual({ kind: 'park', vehicle: 'Stapler_1' });
  });

  it('9.1e: a just-admitted vehicle waits out a full pause in the dock and still reaches the charger', () => {
    // Plan: admitted at the boundary (+0.1), the pause begins during the approach, the vehicle
    // stands the FULL pause in the dock, delivers, drives to the charger and waits there for the
    // assumed maximum. Actual travel is the plain route (the admission used travelSlack).
    const cfg: PalletYardConfig = LOW;
    const a1 = station('A1');
    const v1 = station('V1');
    const l2 = station('L2');
    let soc = boundarySoc() + 0.1;
    const e = env(10);
    const plain: PalletYardConfig = { ...cfg, battery: { ...cfg.battery, travelSlack: 1 } };
    const travel = e.distanceM('atW', a1.pathId) + e.distanceM(a1.pathId, v1.pathId);
    soc = consume(soc, consumption(plain).order(travel, a1, v1, false), cfg.battery);
    soc = consume(soc, { driveSec: 0, liftM: 0, idleSec: cfg.shippingPauses.durationSec }, cfg.battery); // the pause in the dock
    soc = consume(soc, consumption(plain).toCharger(e.distanceM(v1.pathId, l2.pathId), l2), cfg.battery);
    soc = consume(soc, { driveSec: 0, liftM: 0, idleSec: cfg.battery.chargerWaitReserveSec }, cfg.battery);
    expect(soc).toBeGreaterThan(0);
    // positive reserve: at least the reserveToCharger floor minus the real way is left
    const realWay = energyOf(consumption(plain).toCharger(e.distanceM(v1.pathId, l2.pathId), l2), cfg.battery);
    expect(soc).toBeGreaterThanOrEqual(cfg.battery.reserveToCharger - realWay);
    // Without the pause term the admission would have let a vehicle in that cannot wait the pause out.
    const noPause = minSocFor(
      consumption(cfg).order(travel, a1, v1, false),
      consumption(cfg).toCharger(e.distanceM(v1.pathId, l2.pathId), l2), cfg.battery);
    expect(boundarySoc(cfg) - noPause).toBeCloseTo((cfg.shippingPauses.durationSec / 60) * cfg.battery.idlePerMin, 9);
    expect(reserveAfterOrder(consumption(cfg).toCharger(0, l2), cfg.battery)).toBeGreaterThan(0);
  });
});

describe('PalletYard retrieval policies', () => {
  for (const retrieval of ['legacy-fifo', 'when-inbound-free'] as const) {
    it(`${retrieval}: an unassigned output controls retrieval`, () => {
      const d = createYardDispatcher({ ...CFG, retrieval });
      d.storage('Buffer').commitStore('P1', 'stored', 1);
      // A pending output with a future release stays unassigned this round.
      d.orders.add({ source: 'A1', mu: 'waiting', earliest: 100 }, 5);
      const jobs = d.dispatch([veh('Stapler_1', 90)], env(10, ['V2']));
      expect(d.waitingSources()).toEqual(['A1']);
      expect(jobs.filter((j) => j.kind === 'retrieve')).toHaveLength(retrieval === 'legacy-fifo' ? 0 : 1);
      if (retrieval === 'when-inbound-free') {
        expect(byVehicle(jobs).Stapler_1).toMatchObject({ kind: 'retrieve', from: 'P1', to: 'V1' });
      }
    });
  }
});
