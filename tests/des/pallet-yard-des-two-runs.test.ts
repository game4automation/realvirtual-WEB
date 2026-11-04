// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
// plan-648 §9.3b (finding realvirtual-d0, plan-559 M3, 2026-10-21) — two PalletYard DES
// FastForward runs one after the other IN THE SAME vitest process must give identical
// numbers. Before plan-648 the second run shipped 1 pallet instead of 419: process-wide state
// survived `runner.dispose()` + `y.dispose()`. Script: plan-559 M3 (`runOnce()`, 8 h sim time
// per run, ~5 s wall per run).
//
// Cause (plan-645 spike, 2026-10-21): the harness never disposed run 1's YardRun. Its
// constructor subscribes to the process-wide zone registry, and ZoneRegistry.clear() keeps
// listeners, so the dead runtime kept reacting in run 2 (13131 zone-freed calls, a re-run of its
// start(), orders to the same vehicle ids). Production unbind() disposes the runtime
// (pallet-yard index.ts); the harness now does the same, in the same order (runtime before
// runner). The listener contract itself (clear() keeping subscribers) is plan-645 Phase 2.
import { describe, expect, it } from 'vitest';
import { DESRunner } from '@rv/plugins/des/des-runner';
import '@rv/behaviors/Conveyor';
import '@rv/behaviors/Source';
import '@rv/behaviors/Sink';
import '@rv/behaviors/Agv';
import { devAssetAvailable } from '../fixtures/dev-asset-available';
import { trafficListenerStats, trafficRegistryStats } from '../../src/core/engine/rv-traffic-registries';
import { PluginOwnerRegistry } from '@rv/plugins/des/fleet/des-handover';
import { bindDesYard, startDesRuntime } from '@rv/plugins/models/PalletYard/yard-runtime';
import { PALLET_YARD_URL, loadPalletYardScene } from './pallet-yard-scene-load';

const AVAILABLE = await devAssetAvailable(PALLET_YARD_URL);
const SIM_SEC = 8 * 3600;
const VEHICLES = ['Stapler_1', 'Stapler_2', 'Stapler_3'];
/** Hard bound of the tick loop (8 h FastForward needs a few hundred ticks). */
const MAX_TICKS = 200_000;
const EMPTY = {
  paths: 0, zones: 0, zoneHolders: 0, spacing: 0, docks: 0,
  authorityVehicles: { des: 0, continuous: 0 }, pendingClockEvents: 0, fleetHandles: 0,
};
const afterDispose: unknown[] = [];
/** plan-645 N3: zone-registry subscribers before each run and after its dispose. */
const zoneListeners: Array<{ before: number; after: number }> = [];

async function runOnce(label: string) {
  const y = await loadPalletYardScene();
  const listenersBefore = trafficListenerStats().zoneListeners;
  const runner = new DESRunner({ subMode: 'fastforward', durationSeconds: SIM_SEC });
  let rt: ReturnType<typeof startDesRuntime> | null = null;
  try {
    runner.start([], { root: y.root, host: y.host as never });
    const r = bindDesYard({ runner, root: y.root, drives: y.drives, owners: new PluginOwnerRegistry() });
    if (!r.ok) throw new Error('bind: ' + r.missing.join(', '));
    rt = startDesRuntime(r.backend, () => {});
    const live = rt;
    const mgr = runner.getManager() as unknown as { currentTime: number; isComplete: boolean; totalEventsProcessed: number };
    const shipped = (): number => r.backend.sinkOf('V1')!.totalProcessed + r.backend.sinkOf('V2')!.totalProcessed;
    const first50: Array<{ i: number; t: number; job: string }> = [];
    const rtAny = live as unknown as { logJob: (e: string) => void };
    const origLog = rtAny.logJob.bind(live);
    let jobs = 0;
    rtAny.logJob = (e: string) => { if (first50.length < 50) first50.push({ i: jobs, t: r.backend.clock.now(), job: e }); jobs++; origLog(e); };
    let ticks = 0, idle = 0;
    while (!mgr.isComplete && ticks < MAX_TICKS) {
      const before = mgr.totalEventsProcessed;
      runner.tick(1 / 60); runner.lateTick(1 / 60); live.frame(); ticks++;
      idle = mgr.totalEventsProcessed === before ? idle + 1 : 0;
      if (idle >= 3) throw new Error(`${label}: stall at sim t=${mgr.currentTime.toFixed(0)}`);
    }
    const c = live.counters;
    const perVehicle = Object.fromEntries(VEHICLES.map((id) => {
      const s = live.stats(id)!;
      return [id, { ordersDone: s.ordersDone, charges: s.charges, minSoc: Math.round(s.minSoc * 1e6) / 1e6 }];
    }));
    return {
      simTimeSec: mgr.currentTime, palletsShipped: shipped(), counters: { ...c }, perVehicle, first50,
      workCounters: { desEvents: mgr.totalEventsProcessed, jobsStarted: jobs, runnerTicks: ticks },
    };
  } finally {
    console.info(`[648 9.3b] ${label} registries before dispose ${JSON.stringify(trafficRegistryStats())}`);
    rt?.dispose();
    runner.dispose();
    y.dispose();
    const after = trafficRegistryStats();
    afterDispose.push(after);
    zoneListeners.push({ before: listenersBefore, after: trafficListenerStats().zoneListeners });
    console.info(`[648 9.3b] ${label} registries after dispose ${JSON.stringify(after)}`);
  }
}

describe.skipIf(!AVAILABLE)('plan-648 §9.3b — two PalletYard DES runs in one process', () => {
  it('two runs in one process give identical numbers, every traffic registry empty after each dispose', async () => {
    const a = await runOnce('run 1');
    const b = await runOnce('run 2');
    console.info(`[648 9.3b] shipped run 1 ${a.palletsShipped}, run 2 ${b.palletsShipped}; events ${a.workCounters.desEvents} / ${b.workCounters.desEvents}`);
    expect(a.simTimeSec).toBeGreaterThanOrEqual(SIM_SEC - 1);
    expect(a.palletsShipped).toBeGreaterThan(0);
    expect(b.simTimeSec).toBeGreaterThanOrEqual(SIM_SEC - 1);
    expect(afterDispose, 'no traffic state survives a dispose').toEqual([EMPTY, EMPTY]);
    // plan-645 N3: a forgotten runtime dispose would leave its zone subscription behind. The
    // DES movement authority subscribes ONCE per page on first use (a singleton, D2), so run 1
    // may add exactly that one; from then on a run must not add any.
    expect(zoneListeners[0].after - zoneListeners[0].before, 'run 1: at most the authority').toBeLessThanOrEqual(1);
    expect(zoneListeners[1].after, 'run 2 leaves no zone subscriber behind').toBe(zoneListeners[1].before);
    expect(zoneListeners[1].before, 'no growth between the runs').toBe(zoneListeners[0].after);
    // Identity: everything the run produces (shipped, counters, per vehicle, first 50 jobs with
    // their sim times, DES events, jobs) is the same in run 2 as in run 1.
    // runnerTicks measures real-time slice work and varies with machine load.
    const identity = ({ workCounters: { runnerTicks, ...workCounters }, ...result }: typeof a) => {
      console.info(`[648 9.3b] runnerTicks (informative): ${runnerTicks}`);
      return { ...result, workCounters };
    };
    expect(identity(b), 'run 2 in the same process equals run 1').toEqual(identity(a));
  }, 900_000);
});
