// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import type { LiftDone } from '../../src/core/fleet/exec/backends';
/**
 * plan-2051 §9.1 — stochastic production takt of the fleet core.
 *
 * `TaktPlan.stochastic` + a seeded SFC32 on the TaktSource draws every interval
 * after a release from `exponential(rng, intervalOf(p, i))`. Proven here:
 *  - same seed → identical release sequence; different seed → different one;
 *  - default (stochastic off, or no RNG) → the exact fixed takt, unchanged;
 *  - RNG lifecycle (SOL round 2, finding 2): a reset + restart WITHOUT
 *    reconstruction replays the same stream, on the TaktSource and on the real
 *    FleetJobRunner (whose start() resets the clock, the way an engine reset does).
 *
 * Node test on the real TaktSource / FleetJobRunner / ContinuousSimClock; the
 * runner's hand-over, lift, docks and zones are fakes (no vehicles: only the takt runs).
 */
import { describe, expect, it } from 'vitest';
import { TaktSource, type TaktPlan } from '../../src/core/fleet/core/order-sources';
import { ContinuousSimClock } from '../../src/core/fleet/core/sim-clock';
import { SFC32 } from '../../src/core/rv-rng-distribution';
import { AgvFleet } from '../../src/core/engine/rv-agv-fleet';
import type { PathDockRegistry } from '../../src/core/engine/rv-path-dock';
import type { ZoneRegistry } from '../../src/core/engine/rv-zone-registry';
import { createBatteryModel, type BatteryRates } from '../../src/core/fleet/core/battery';
import { FleetDispatcher } from '../../src/core/fleet/core/dispatcher';
import type { FleetStation } from '../../src/core/fleet/core/orders';
import type { RouteTable } from '../../src/core/fleet/core/route-table';
import { forkliftConsumption } from '../../src/core/fleet/core/strategies';
import type { HandoverBackend, LiftBackend } from '../../src/core/fleet/exec/backends';
import { FleetJobRunner, type FleetSite } from '../../src/core/fleet/exec/job-runner';

const HORIZON = 3600;

// ── TaktSource level ────────────────────────────────────────────────────────

/** Release instants per output of one TaktSource run up to `until` (head always free). */
function runTakt(plan: TaktPlan, rng: SFC32 | null, count: number, until = HORIZON) {
  const clock = new ContinuousSimClock();
  const log: number[][] = Array.from({ length: count }, () => []);
  const source = new TaktSource(clock, plan, count, {
    headFree: () => true,
    release: (i) => { log[i].push(clock.now()); },
    blocked: () => { throw new Error('unexpected blocked takt'); },
  }, rng);
  source.start();
  clock.advanceTo(until);
  return { clock, source, log };
}

/** The fixed grid `phase, phase + I, ...` up to `until`. */
function grid(phase: number, interval: number, until = HORIZON): number[] {
  const out: number[] = [];
  for (let t = phase; t <= until; t += interval) out.push(t);
  return out;
}

const plan = (over: Partial<TaktPlan> = {}): TaktPlan => ({ intervalSec: 60, phaseSec: [0, 30], ...over });

describe('TaktSource stochastic interval (plan-2051)', () => {
  it('same seed -> identical release sequence; it is not the fixed grid', () => {
    const a = runTakt(plan({ stochastic: true }), new SFC32(7), 2).log;
    const b = runTakt(plan({ stochastic: true }), new SFC32(7), 2).log;
    expect(b).toEqual(a);
    expect(a[0].length).toBeGreaterThan(10);
    expect(a[0]).not.toEqual(grid(0, 60));
    expect(a[0][0]).toBe(0);   // the first release stays at its phase
    expect(a[1][0]).toBe(30);
  });

  it('different seeds -> different release sequences', () => {
    const seqs = [1, 2, 3, 4, 5].map(seed => JSON.stringify(runTakt(plan({ stochastic: true }), new SFC32(seed), 2).log));
    expect(new Set(seqs).size).toBe(5);
  });

  it('intervals stay strictly positive and average the configured interval', () => {
    const { log } = runTakt(plan({ intervalSec: 10, phaseSec: [0], stochastic: true }), new SFC32(42), 1, 50_000);
    const gaps = log[0].slice(1).map((t, k) => t - log[0][k]);
    expect(gaps.length).toBeGreaterThan(4000);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(0.001); // exponential() clamp
    const mean = gaps.reduce((s, g) => s + g, 0) / gaps.length;
    expect(mean).toBeGreaterThan(9);
    expect(mean).toBeLessThan(11);
  });

  it('default (off / no rng) -> unchanged fixed interval', () => {
    const fixed = [grid(0, 60), grid(30, 60)];
    expect(runTakt(plan(), null, 2).log).toEqual(fixed);                          // no flag, no rng
    expect(runTakt(plan(), new SFC32(7), 2).log).toEqual(fixed);                  // rng set, flag off
    expect(runTakt(plan({ stochastic: false }), new SFC32(7), 2).log).toEqual(fixed);
    expect(runTakt(plan({ stochastic: true }), null, 2).log).toEqual(fixed);      // flag on, no seed
  });

  it('a flag-off run with an rng does not consume it', () => {
    const rng = new SFC32(9);
    const before = rng.getState();
    runTakt(plan(), rng, 2);
    expect(rng.getState()).toEqual(before);
  });

  it('uses the per-output interval as the mean; a disabled output stays disabled', () => {
    const { log } = runTakt(plan({ intervalPerOutput: [Infinity, 20], stochastic: true }), new SFC32(3), 2, 20_000);
    expect(log[0]).toEqual([]);
    const gaps = log[1].slice(1).map((t, k) => t - log[1][k]);
    const mean = gaps.reduce((s, g) => s + g, 0) / gaps.length;
    expect(mean).toBeGreaterThan(18);
    expect(mean).toBeLessThan(22);
  });

  it('reset without reconstruction, same seed -> identical sequence again', () => {
    const run = runTakt(plan({ stochastic: true }), new SFC32(11), 2);
    const first = run.log.map(l => [...l]);
    for (const l of run.log) l.length = 0;
    run.clock.reset();          // the engine reset — the source is kept
    run.source.start();
    run.clock.advanceTo(HORIZON);
    expect(run.log).toEqual(first);
  });

  it('setRng replaces the stream; the new state is the start of every later run', () => {
    const run = runTakt(plan({ stochastic: true }), new SFC32(1), 2);
    const seed1 = run.log.map(l => [...l]);
    const reference = runTakt(plan({ stochastic: true }), new SFC32(2), 2).log;
    for (const seq of [0, 1]) {
      for (const l of run.log) l.length = 0;
      if (seq === 0) run.source.setRng(new SFC32(2));
      run.clock.reset();
      run.source.start();
      run.clock.advanceTo(HORIZON);
      expect(run.log).toEqual(reference);
    }
    expect(reference).not.toEqual(seed1);
  });
});

// ── FleetJobRunner level ────────────────────────────────────────────────────

const STATIONS: FleetStation[] = [
  { id: 'A1', role: 'pick', pathId: 'S_A1', storageGroup: 'Buffer', approachM: 4, handlingHeightMm: 500 },
  { id: 'A2', role: 'pick', pathId: 'S_A2', storageGroup: 'Buffer', approachM: 4, handlingHeightMm: 500 },
  { id: 'V1', role: 'drop', pathId: 'S_V1', approachM: 4, handlingHeightMm: 500 },
  { id: 'P1', role: 'storage', pathId: 'S_P1', storageGroup: 'Buffer', approachM: 4, handlingHeightMm: 100 },
];
const RATES: BatteryRates = {
  drivePerMin: 0.01, liftPerM: 0.01, idlePerMin: 0.001, chargePerMin: 5, threshold: 30, target: 80,
  reserveToCharger: 1, chargerWaitReserveSec: 0,
};
const FORK = { travelHeightMm: 150, handlingDeltaMm: 30, liftSpeedLoadedMmS: 150, liftSpeedEmptyMmS: 300 };

/** Fake hand-over: the head is always free; every produce() is recorded. */
class RecordingHandover implements HandoverBackend {
  onPalletReady: ((station: string, mu: string) => void) | null = null;
  onInputFreed: ((station: string) => void) | null = null;
  readonly produced: string[] = [];
  constructor(private readonly clock: ContinuousSimClock) {}
  produce(station: string): boolean { this.produced.push(`${station}@${this.clock.now()}`); return true; }
  headFree(): boolean { return true; }
  setPickHandler(): void {}
  awaitPick(): void { /* no vehicles */ }
  cancelPick(): void { /* no vehicles */ }
  inputFree(): boolean { return true; }
  putOnHead(): boolean { return false; }
  setInputRun(): void { /* no pauses */ }
  store(): boolean { return false; }
  retrieve(): string | null { return null; }
  carried(): string | null { return null; }
  onSlot(): string | null { return null; }
  reconcile(): number { return 0; }
  vehicleNode(): null { return null; }
  releaseVisuals(): void { /* none */ }
  resetState(): void { /* stateless */ }
  dispose(): void { /* none */ }
}

class IdleLift implements LiftBackend {
  position(): number { return 0; }
  private doneHandler: (v: string, d: LiftDone) => void = () => {};
  setDoneHandler(h: (v: string, d: LiftDone) => void): void { this.doneHandler = h; }
  move(v: string, _to: number, _speed: number, done: LiftDone): void { this.doneHandler(v, done); }
  cancel(): void { /* none */ }
  snap(): void { /* none */ }
}

function yardlessRunner(production: TaktPlan, rng: SFC32 | null) {
  const clock = new ContinuousSimClock();
  const ho = new RecordingHandover(clock);
  const docks = { register: () => () => {} } as unknown as PathDockRegistry;
  const zones = { onAvailabilityChanged: () => () => {}, isHolder: () => false, holderCount: () => 0 } as unknown as ZoneRegistry;
  const routes = { networkM: () => 10 } as unknown as RouteTable;
  const dispatcher = new FleetDispatcher({
    stations: STATIONS, battery: createBatteryModel(RATES),
    consumption: forkliftConsumption(() => ({ ...FORK, travelSpeedMmS: 1000, reverseSpeedMmS: 300, travelSlack: 1, idleReserveSec: 0 })),
  });
  const site: FleetSite = {
    stations: STATIONS, turnOf: new Map(STATIONS.map(s => [s.pathId, `T_${s.id}`])), nextOf: new Map(),
    zoneOf: (id) => `Stich_${id}`, waitPointPathId: 'S_W', stichLengthM: 4, vehicles: [],
  };
  const rt = new FleetJobRunner({ kind: 'continuous', clock, lift: new IdleLift(), handover: ho }, site, dispatcher, {
    fork: FORK, battery: RATES, startSoc: [], production,
    pauses: { everySec: 1e9, durationSec: 0, offsetSec: [1e9] },
  }, { fleet: new AgvFleet(), docks, zones, routes, rng });
  /** One run: start (clock reset inside), advance, the produced log of this run. */
  const run = (): string[] => {
    ho.produced.length = 0;
    rt.start();
    clock.advanceTo(HORIZON);
    return [...ho.produced];
  };
  return { rt, run };
}

const PROD = (stochastic?: boolean): TaktPlan => ({ intervalSec: 90, phaseSec: [0, 45], stochastic });

describe('FleetJobRunner stochastic takt (plan-2051)', () => {
  it('JobRunnerOptions.rng reaches the takt: same seed identical, different seed different', () => {
    const a = yardlessRunner(PROD(true), new SFC32(5)).run();
    const b = yardlessRunner(PROD(true), new SFC32(5)).run();
    const c = yardlessRunner(PROD(true), new SFC32(6)).run();
    expect(b).toEqual(a);
    expect(c).not.toEqual(a);
  });

  it('default -> exactly the fixed takt (no flag, flag without seed, seed without flag)', () => {
    const fixed = yardlessRunner(PROD(), null).run();
    expect(fixed.filter(s => s.startsWith('A1@'))).toEqual(grid(0, 90).map(t => `A1@${t}`));
    expect(fixed.filter(s => s.startsWith('A2@'))).toEqual(grid(45, 90).map(t => `A2@${t}`));
    expect(yardlessRunner(PROD(true), null).run()).toEqual(fixed);
    expect(yardlessRunner(PROD(false), new SFC32(5)).run()).toEqual(fixed);
  });

  it('restart without reconstruction (start() again) with the same seed is bit-identical', () => {
    const w = yardlessRunner(PROD(true), new SFC32(8));
    const first = w.run();
    expect(w.run()).toEqual(first);
    expect(w.run()).toEqual(first);
  });

  it('setRng with a freshly derived same-seed RNG before a restart keeps it bit-identical', () => {
    const w = yardlessRunner(PROD(true), new SFC32(8));
    const first = w.run();
    w.rt.setRng(new SFC32(8)); // what FleetPlugin does on every bind / kept-binding restart
    expect(w.run()).toEqual(first);
    w.rt.setRng(new SFC32(9));
    expect(w.run()).not.toEqual(first);
  });
});
