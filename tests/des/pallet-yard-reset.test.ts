// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
// plan-612 §9.1c — reset of the PalletYard runtime (SOL #9) with the real DESRunner:
// reset during (a) a loaded drive, (b) a lift stroke, (c) charging, (d) waiting in
// the dock at a paused input, and a rebind on the same runner. After every reset:
// no clock callback of the old generation fires, no pallet hangs on a fork, no
// reservation is left, SOC = start values — and the run after the reset is
// IDENTICAL to a run without one.
import { afterEach, describe, expect, it } from 'vitest';
import { PALLET_YARD_CONFIG, type PalletYardConfig } from '../../src/plugins/models/PalletYard/layout';
import { bindDesYard, startDesRuntime } from '@rv/plugins/models/PalletYard/yard-runtime';
import { FIRST_JOBS_KEPT, JOB_LOG_LIMIT } from '@rv/core/fleet/exec/job-runner';
import { buildYard, type YardMode, type YardWorld } from './pallet-yard-harness';

const worlds: YardWorld[] = [];
afterEach(() => { for (const w of worlds.splice(0)) w.dispose(); });
const yard = (mode: YardMode, cfg: PalletYardConfig): YardWorld => { const w = buildYard(mode, { cfg }); worlds.push(w); return w; };

/** Everything the run decides, rounded where it is a float. */
function fingerprint(w: YardWorld): Record<string, unknown> {
  return JSON.parse(JSON.stringify({
    c: w.rt.counters,
    log: w.rt.jobLog,
    v: w.rt.vehicleIds.map((id) => { const s = w.rt.stats(id)!; return [s.ordersDone, s.charges, s.leg, s.soc.toFixed(6)]; }),
    shipped: w.shipped,
    // State shares per component (stress-test 2026-11-03: a run after Reset booked its
    // initial empty period as Blocked) and the raw processed counter (TotalProcessed KPI).
    states: w.runner.liveInstances.map((i) => {
      const s = i.adapter.getStatistics();
      return [i.adapter.path, s.currentState, i.adapter.totalProcessed,
        Object.entries(s.states).map(([k, v]) => [k, v.entries, v.percent.toFixed(6)])];
    }),
  }));
}

/** Post-reset invariants at t = 0 of the new run. */
function expectClean(w: YardWorld, cfg: PalletYardConfig): void {
  for (const [i, id] of w.rt.vehicleIds.entries()) {
    expect(w.backend.carried(id), id).toBeNull();
    expect(w.vehicle(id).anchor.children, `${id} ForkAnchor`).toHaveLength(0);
    expect(w.rt.stats(id)!.soc, id).toBe(cfg.battery.startSoc[i]);
    expect(w.rt.stats(id)!.ordersDone).toBe(0);
  }
  for (const s of ['P1', 'P2', 'P3', 'P4', 'P5', 'P6']) {
    expect(w.backend.onSlot(s), s).toBeNull();
    expect(w.rt.dispatcher.storage('Buffer').place(s).reservedBy, s).toBeNull();
  }
  expect(w.rt.counters.picks).toBe(0);
}

const T = 1500;

interface Scenario { name: string; cfg: () => PalletYardConfig; reach: (w: YardWorld) => boolean; limit: number }

const nominal = (): PalletYardConfig => PALLET_YARD_CONFIG;
const lowSoc = (): PalletYardConfig => ({ ...PALLET_YARD_CONFIG, battery: { ...PALLET_YARD_CONFIG.battery, startSoc: [20, 22, 24] } });
/** Both inputs pause 200..500 s — a loaded stacker heading for an input meets the pause in the dock. */
const pauseAt200 = (): PalletYardConfig => ({ ...PALLET_YARD_CONFIG, shippingPauses: { everySec: 1e6, durationSec: 300, offsetSec: [200, 200] } });

const SCENARIOS: Scenario[] = [
  { name: '(a) loaded drive', cfg: nominal, limit: 400,
    reach: (w) => w.rt.vehicleIds.some((v) => w.rt.stats(v)!.leg === 'toTo' && w.backend.carried(v) !== null) },
  { name: '(b) lift stroke in the dock', cfg: nominal, limit: 400,
    reach: (w) => w.rt.vehicleIds.some((v) => w.rt.stats(v)!.leg === 'atFrom') },
  { name: '(c) charging', cfg: lowSoc, limit: 400,
    reach: (w) => w.rt.vehicleIds.some((v) => w.rt.stats(v)!.leg === 'charging') },
  { name: '(d) waiting in the dock at a paused input', cfg: pauseAt200, limit: 600,
    reach: (w) => w.rt.vehicleIds.some((v) => w.rt.stats(v)!.waitingAt !== null && w.backend.carried(v) !== null) },
];

describe('PalletYard reset (9.1c)', () => {
  for (const sc of SCENARIOS) {
    for (const mode of (sc.name.startsWith('(a)') ? ['fastforward', 'animated'] : ['fastforward']) as YardMode[]) {
      it(`[${mode}] reset during ${sc.name}: no ghost callbacks / pallets / reservations, run identical to a fresh one`, () => {
        const cfg = sc.cfg();
        const fresh = yard(mode, cfg);
        fresh.runTo(T);
        const expected = fingerprint(fresh);

        const w = yard(mode, cfg);
        expect(w.runUntil(() => sc.reach(w), sc.limit, 0.25), `state ${sc.name} not reached`).toBe(true);
        const genBefore = w.backend.clock.generation;
        let ghost = 0;
        w.backend.clock.schedule(w.now() + 5, () => { ghost++; });   // an old-generation callback
        w.reset();
        expect(w.backend.clock.generation).toBeGreaterThan(genBefore);
        expect(w.now()).toBe(0);
        expectClean(w, cfg);
        w.runTo(T);
        expect(ghost).toBe(0);
        expect(fingerprint(w)).toEqual(expected);
      }, 120_000);
    }
  }

  // CP2 E9 / G5: the job log is a ring of JOB_LOG_LIMIT entries; the first FIRST_JOBS_KEPT
  // jobs of the run stay in their own field (the parity test compares them).
  it('[fastforward] the job log is bounded (ring) and the first jobs are kept apart; a reset clears both (E9)', () => {
    const cfg = nominal();
    const w = yard('fastforward', cfg);
    w.runTo(600);
    const early = w.rt.jobLog;
    expect(early.length, 'jobs within 10 min').toBeGreaterThan(FIRST_JOBS_KEPT);
    expect(w.rt.firstJobs).toEqual(early.slice(0, FIRST_JOBS_KEPT));
    w.runTo(8 * 3600);
    const log = w.rt.jobLog;
    console.info(`[E9] jobs after 8 h: ring ${log.length}, first ${w.rt.firstJobs.length}`);
    expect(log.length, 'ring full').toBe(JOB_LOG_LIMIT);
    expect(w.rt.firstJobs, 'first jobs kept after the ring wrapped').toEqual(early.slice(0, FIRST_JOBS_KEPT));
    expect(log[0], 'the ring dropped the oldest').not.toBe(early[0]);
    w.reset();   // the restart dispatches at t = 0 at once: only those jobs are left
    expect(w.rt.jobLog.length, 'ring cleared').toBeLessThanOrEqual(w.rt.vehicleIds.length);
    expect(w.rt.firstJobs, 'first jobs restart with the run').toEqual(w.rt.jobLog);
  }, 120_000);

  it('[fastforward] two resets in a row and a rebind on the same runner keep the run identical', () => {
    const cfg = nominal();
    const fresh = yard('fastforward', cfg);
    fresh.runTo(T);
    const expected = fingerprint(fresh);

    const w = yard('fastforward', cfg);
    w.runTo(250);
    w.reset();
    w.runTo(120);
    // Rebind (scene re-entered / plugin re-registered): a NEW runtime on the SAME runner,
    // the same owner registry — old clock events stay in the queue and must fall through.
    let ghost = 0;
    w.backend.clock.schedule(w.now() + 3, () => { ghost++; });
    const owned = w.owners.created;
    w.rt.dispose();
    const r = bindDesYard({ runner: w.runner, root: w.root, drives: w.rt.vehicleIds.map((id) => w.vehicle(id).lift), cfg, owners: w.owners });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(w.owners.created).toBe(owned);                // reused (same manager, same nodes)
    w.backend = r.backend;
    w.rt = startDesRuntime(r.backend, () => {}, { cfg });
    w.reset();
    expectClean(w, cfg);
    w.runTo(T);
    expect(ghost).toBe(0);
    expect(fingerprint(w)).toEqual(expected);
  }, 120_000);
});
