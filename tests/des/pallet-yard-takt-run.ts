// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
// plan-686 §9.4 — shared driver of the PalletYard takt runs (`pallet-yard-takt-150/-180.test.ts`):
// the REAL scenes/PalletYard.glb (the Phase-0 measurement found the plain harness does NOT reproduce
// the 180 s deadlock, so the acceptance runs on the GLB scene) in DES FastForward for `hours` sim
// hours with a fixed production takt. Every sim hour the wait-cycle query must be empty; every
// hour after the warm-up must ship pallets; every zone released by the plan-686 step 4 is checked
// geometrically (body OBB vs. zone corridor, independent of the engine's occupancy check).
// One takt per test FILE = one vitest process per takt (singleton state, M3 rule).

import { expectNoWaitTimeouts } from './pallet-yard-soak-bounds';
import { vi } from 'vitest';
import '@rv/behaviors/Conveyor';
import '@rv/behaviors/Source';
import '@rv/behaviors/Sink';
import '@rv/behaviors/Agv';
import { DESRunner } from '@rv/plugins/des/des-runner';
import { PluginOwnerRegistry } from '@rv/plugins/des/fleet/des-handover';
import { bindDesYard, startDesRuntime } from '@rv/plugins/models/PalletYard/yard-runtime';
import { PALLET_YARD_CONFIG, type PalletYardConfig } from '../../src/plugins/models/PalletYard/layout';
import { getDefaultMovementAuthority, type MovementAuthority, type ZoneWaitCycle } from '../../src/core/engine/rv-movement-authority';
import { watchStaleReleases } from '../helpers/agv-release-safety';
import { loadPalletYardScene } from './pallet-yard-scene-load';

const VEHICLES = ['Stapler_1', 'Stapler_2', 'Stapler_3'];
const SLOTS = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6'];
const HOUR = 3600;

export interface TaktResult {
  intervalSec: number;
  simTimeSec: number;
  shipped: number;
  shippedPerHour: number[];
  events: number;
  produced: number;
  blockedTakts: number;
  staleClaimsReleased: number;
  /** Orphans released by the safety net (no known origin) — must stay 0. */
  staleClaimsUnexpected: number;
  /** Share (%) of the sim time with all buffer slots occupied. */
  bufferFullSharePct: number;
  bufferPeak: number;
  /** Turn points not reached exactly (plan-634 F5) — the vehicle stays where it is. */
  turnGuardTrips: number;
  /** First non-empty wait-cycle sample (sim hour + cycles), null = none. */
  firstCycle: { hour: number; cycles: ZoneWaitCycle[] } | null;
  safetyViolations: string[];
  mbViolations: number;
}

/**
 * Run the yard with `production = { intervalSec, phaseSec: [0, intervalSec / 2] }` for `hours` sim
 * hours. `setup` (measurement scripts only) runs once against the authority before the first tick.
 */
export async function runTakt(intervalSec: number, hours = 8, setup?: (mb: MovementAuthority) => void): Promise<TaktResult> {
  const simSec = hours * HOUR;
  const cfg: PalletYardConfig = { ...PALLET_YARD_CONFIG, production: { intervalSec, phaseSec: [0, intervalSec / 2] } };
  const y = await loadPalletYardScene();
  const runner = new DESRunner({ subMode: 'fastforward', durationSeconds: simSec });
  try {
    runner.start([], { root: y.root, host: y.host as never });
    const r = bindDesYard({ runner, root: y.root, drives: y.drives, owners: new PluginOwnerRegistry(), cfg });
    if (!r.ok) throw new Error('bind: ' + r.missing.join(', '));
    const rt = startDesRuntime(r.backend, () => {}, { cfg });
    const mb = getDefaultMovementAuthority('des');
    setup?.(mb);
    const safety = watchStaleReleases(mb, () => VEHICLES);
    const mgr = runner.getManager() as unknown as { currentTime: number; isComplete: boolean; totalEventsProcessed: number };
    const shipped = (): number => r.backend.sinkOf('V1')!.totalProcessed + r.backend.sinkOf('V2')!.totalProcessed;
    const perHour: number[] = [];
    let nextH = HOUR, lastShip = 0, idle = 0;
    let firstCycle: TaktResult['firstCycle'] = null;
    let tPrev = mgr.currentTime, fullSec = 0;
    try {
      while (!mgr.isComplete) {
        const before = mgr.totalEventsProcessed;
        // As in the soak, fixed inner-batch boundaries keep post-tick hourly
        // and buffer observations independent of the host's real-time budget.
        let budgetTime = 0;
        const budgetClock = vi.spyOn(performance, 'now').mockImplementation(() => (budgetTime += 1000));
        try { runner.tick(1 / 60); } finally { budgetClock.mockRestore(); }
        runner.lateTick(1 / 60); rt.frame(); expectNoWaitTimeouts(rt);
        idle = mgr.totalEventsProcessed === before ? idle + 1 : 0;
        if (idle >= 3) throw new Error('stall at sim t=' + mgr.currentTime.toFixed(0));
        let inBuf = 0;
        for (const sl of SLOTS) if (r.backend.onSlot(sl) !== null) inBuf++;
        if (inBuf === SLOTS.length) fullSec += mgr.currentTime - tPrev;
        tPrev = mgr.currentTime;
        while (mgr.currentTime >= nextH) {
          perHour.push(shipped() - lastShip);
          lastShip = shipped();
          const cycles = mb.findZoneWaitCycles();
          if (cycles.length > 0 && !firstCycle) firstCycle = { hour: nextH / HOUR, cycles };
          nextH += HOUR;
        }
      }
    } finally {
      safety.restore();
    }
    const res: TaktResult = {
      intervalSec, simTimeSec: mgr.currentTime, shipped: shipped(), shippedPerHour: perHour,
      events: mgr.totalEventsProcessed, produced: rt.counters.produced, blockedTakts: rt.counters.blockedTakts,
      staleClaimsReleased: mb.stats.staleClaimsReleased, staleClaimsUnexpected: mb.stats.staleClaimsUnexpected,
      bufferFullSharePct: Math.round((fullSec / Math.max(1, mgr.currentTime)) * 1000) / 10, bufferPeak: rt.counters.bufferPeak,
      turnGuardTrips: mb.stats.turnGuardTrips,
      firstCycle, safetyViolations: safety.violations,
      mbViolations: mb.stats.violations,
    };
    (rt as unknown as { dispose?: () => void }).dispose?.();
    return res;
  } finally {
    runner.dispose();
    y.dispose();
  }
}
