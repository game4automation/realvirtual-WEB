// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2059 Phase 6b-2 - scene acceptance: the REAL PalletYard (three Agv forklifts, takt, pauses, dispatcher,
 * lift, hand-over, KPIs) is captured at several cuts and continued (modes A, B, B-immediate), bit-exact incl. the
 * fleet participants and the KPI. Phase 8 enables these AGV snapshots in production.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { DesLift } from '../../src/plugins/des/fleet/des-lift';
import { fleetSnapshotProvider } from '../../src/plugins/fleet-snapshot-participants';
import { fleetJobsProvider } from '../../src/plugins/fleet-job-participants';
import { fleetKpiParticipant, YardKpiRun } from '../../src/plugins/models/PalletYard/yard-order-kpis';
import { getDefaultPathNetwork } from '../../src/core/engine/rv-path-network';
import { getDefaultZoneRegistry } from '../../src/core/engine/rv-zone-registry';
import { clearShared } from '../helpers/agv-harness';
import { assertContinuation, ContinuationMismatch } from '../helpers/des-continuation-harness';
import { continuationWorld } from './continuation-world-fixture';
import { buildYard } from './pallet-yard-harness';

afterEach(() => { clearShared(); });

/** One PalletYard world with the same snapshot providers the FleetPlugin registers. */
export function yardWorld(hidden = false) {

  // Independent worlds must draw the same page-wide clock generations (the number is part of fleet.clock).
  (globalThis as { __rvFleetDesClockGen?: number }).__rvFleetDesClockGen = 0;
  const y = buildYard('animated', { snapshotAddresses: true });
  const rt = y.rt as YardKpiRun;
  const dispatcher = rt.dispatcher;
  y.runner.registerSnapshotProvider('yard:fleet', fleetSnapshotProvider({
    orders: dispatcher.orders, stationKnown: id => { try { dispatcher.station(id); return true; } catch { return false; } },
    zones: getDefaultZoneRegistry(), paths: getDefaultPathNetwork(),
  }));
  y.runner.registerSnapshotProvider('yard:jobs', ({ raw }) =>
    [...fleetJobsProvider(rt, y.backend.lift as unknown as DesLift, y.backend, raw), fleetKpiParticipant(rt.orderKpis)]);
  const base = continuationWorld(y.runner);
  const restore = y.runner.restoreFull.bind(y.runner);
  // Mode A exercises the JSON wire format too.
  y.runner.restoreFull = raw => restore(JSON.parse(JSON.stringify(raw)));
  let driverCounter = 0;
  return {
    ...base,
    step(toT: number) {
      while (y.runner.getManager().currentTime < toT) {
        const next = Math.min(y.runner.getManager().currentTime + 0.25, toT);
        base.step(next);
        y.runner.tick(0); y.runner.lateTick(0);
        y.rt.frame();
        if (hidden) driverCounter++;
      }
    },
    kpis: () => ({
      ...base.kpis(),
      'fleet.runner': { stats: rt.fleetStats(), counters: { ...rt.counters }, firstJobs: [...rt.firstJobs] },
      'fleet.kpis': { meanOrderSec: rt.orderKpis.meanOrderSec() },
      'lift.drives': Object.fromEntries(rt.vehicleIds.map(id => [id, rt.lift.position(id)])),
      ...(hidden ? { hidden: driverCounter } : {}),
    }),
    dispose: () => y.dispose(),
  };
}

const CUTS = [
  { name: 'early', T: 30, TPrime: 36, T2: 90 },
  { name: 'mid-run', T: 150, TPrime: 160, T2: 240 },
  { name: 'after warm-up', T: 400, TPrime: 410, T2: 500 },
];

describe('PalletYard snapshot continuation (real runner + Agv)', () => {
  for (const mode of ['A', 'B', 'B-immediate'] as const) {
    for (const cut of CUTS) {
      it(`${mode}: ${cut.name} (T=${cut.T})`, async () => {
        await assertContinuation({ buildWorld: () => yardWorld(), mode, T: cut.T, TPrime: cut.TPrime, T2: cut.T2 });
      }, 240_000);
    }
  }
  it('detects undeclared driver state in the scene (negative control)', async () => {
    await expect(assertContinuation({ buildWorld: () => yardWorld(true), mode: 'B', T: 150, TPrime: 160, T2: 240 }))
      .rejects.toBeInstanceOf(ContinuationMismatch);
  }, 240_000);
  it('a capture in the scene needs no restart: pool, completed count and takt survive an immediate restore', () => {
    const w = yardWorld();
    try {
      w.step(150);
      const before = w.runner.fullSnapshot();
      w.runner.restoreFull(before);
      const after = w.runner.fullSnapshot();
      expect(JSON.stringify(after)).toBe(JSON.stringify(before));
    } finally { w.dispose(); }
  }, 240_000);
});

it('mode B: PalletYard at 1800 restores the terminal delivery stay and continues', async () => {
  await assertContinuation({ buildWorld: () => yardWorld(), mode: 'B', T: 1800, TPrime: 1805, T2: 1830 });
}, 300_000);
