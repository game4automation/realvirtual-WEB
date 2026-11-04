// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
// plan-612 Phase 4 CP1c — fork first, and the extended shipping line, on the real
// DESRunner (pallet-yard-harness.ts):
//   (a) every reverse task into a handling stich is handed out only once the fork
//       stands at the APPROACH height (pick / retrieve: handling − delta, delivery
//       to a conveyor or a floor slot: handling + delta) — checked at the moment
//       of the assignment AND continuously while a vehicle reverses (Reverse signal);
//   (b) a deliberately slow lift makes the vehicle wait at the turn point: the wait
//       is counted (forkWaits, maxForkWaitSec), visible in stats().forkWait, and past
//       the limit reported (console.warn + Problems `pallet-yard-fork-wait-timeout`
//       with vehicle, station, target and actual height); the job then completes;
//   (c) shipping runs input conveyor → ConveyorOut → sink; a shipping pause holds
//       the pallet on the input conveyor, in front of ConveyorOut;
//   (d) STICH EXIT: in no simulation step does the fork go down while the vehicle,
//       outside its handling stay, still holds a handling stich zone (Stich_<id>);
//       a missing exit is reported and cleared once the vehicle is out.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Object3D } from 'three';
import { LAMP_ROLES } from '../../src/core/fleet/exec/lamp-map';
import { getDefaultAgvFleet, type AgvTask } from '@rv/core/engine/rv-agv-fleet';
import { clearAllProblems, getProblems } from '@rv/core/hmi/problems-store';
import { sig } from '../helpers/agv-harness';
import {
  PALLET_YARD_CONFIG, junctionOfStation, mergeZoneOf, type PalletYardConfig,
} from '../../src/plugins/models/PalletYard/layout';
import { yardConfigOf } from '@rv/plugins/models/PalletYard/yard-runtime';
import { FLEET_WAIT_TIMEOUT_CODE, waitTimeoutProblemId } from '@rv/core/fleet/exec/wait-watch';
/** The fleet executor's wait reports (plan-559 Phase 5): code `fleet-wait-timeout`, id `…:<vehicle>:<kind>`. */
const isForkWait = (p: { code: string; id: string }): boolean => p.code === FLEET_WAIT_TIMEOUT_CODE && p.id.endsWith(':fork');
const isExitWait = (p: { code: string; id: string }): boolean => p.code === FLEET_WAIT_TIMEOUT_CODE && p.id.endsWith(':exit');
import { getDefaultZoneRegistry } from '@rv/core/engine/rv-zone-registry';
import { buildYard, type YardMode, type YardWorld } from './pallet-yard-harness';

let w: YardWorld | null = null;
afterEach(() => { w?.dispose(); w = null; clearAllProblems(); vi.restoreAllMocks(); });

const MODES: YardMode[] = ['animated', 'fastforward'];
const DELTA = PALLET_YARD_CONFIG.vehicle.handlingDeltaMm;

function cfgWith(over: Partial<PalletYardConfig> = {}): PalletYardConfig {
  return {
    ...PALLET_YARD_CONFIG,
    production: { intervalSec: 1e6, phaseSec: [0, 1e6] },
    shippingPauses: { everySec: 1e6, durationSec: 0, offsetSec: [0, 0] },
    battery: { ...PALLET_YARD_CONFIG.battery, startSoc: [90, 90, 90] },
    ...over,
  };
}

/** Approach height a vehicle must have for its current leg, or null (no handling leg). */
function expectedApproach(y: YardWorld, v: string): { kind: string; station: string; mm: number } | null {
  const st = y.rt.stats(v)!;
  const job = y.rt.dispatcher.jobOf(v);
  if (!job || (job.kind !== 'pick' && job.kind !== 'retrieve')) return null;
  if (st.leg === 'toFrom') {
    const s = y.rt.dispatcher.station(job.from);
    return { kind: job.kind, station: s.id, mm: Math.max(0, s.handlingHeightMm - DELTA) };
  }
  if (st.leg === 'toTo') {
    const s = y.rt.dispatcher.station(job.kind === 'pick' ? job.to.station : job.to);
    return { kind: `deliver-${s.role === 'storage' ? 'buffer' : s.role}`, station: s.id, mm: s.handlingHeightMm + DELTA };
  }
  return null;
}

/** Wrap every vehicle's fleet handle: record the fork height at each REVERSE task into a handling stich. */
function watchReverseTasks(y: YardWorld): ReverseTask[] {
  const out: ReverseTask[] = [];
  for (const v of y.rt.vehicleIds) {
    const h = getDefaultAgvFleet().get(v)!;
    const assign = h.assign;
    (h as { assign: (t: AgvTask) => void }).assign = (t: AgvTask) => {
      if (t.approach === 'reverse') {
        const e = expectedApproach(y, v);
        if (e && y.rt.dispatcher.station(e.station).pathId === t.destination) {
          out.push({ v, kind: e.kind, station: e.station, liftMm: y.vehicle(v).lift.currentPosition, expectMm: e.mm });
        }
      }
      assign(t);
    };
  }
  return out;
}

type ReverseTask = { v: string; kind: string; station: string; liftMm: number; expectMm: number };
type Sample = { v: string; kind: string; liftMm: number; expectMm: number };
type Drop = { v: string; t: number; zone: string; fromMm: number; toMm: number; leg: string; loaded: boolean };

/** Handling stich zones a vehicle holds (pick / drop / buffer stations). */
function handlingZonesHeld(y: YardWorld, v: string): string[] {
  const z = getDefaultZoneRegistry();
  return yardConfigOf(y.rt).stations.filter((s) => s.kind !== 'charger' && z.isHolder(`Stich_${s.id}`, v)).map((s) => `Stich_${s.id}`);
}

/** Watch every step: the fork must not go down while a vehicle outside its stay still holds a handling stich zone. */
function watchExits(y: YardWorld): { drops: Drop[]; step: () => void; lowered: { loaded: number; empty: number } } {
  const prev = new Map<string, number>();
  const prevLeg = new Map<string, string>();
  const drops: Drop[] = [];
  const lowered = { loaded: 0, empty: 0 };
  return {
    drops, lowered,
    step: () => {
      for (const v of y.rt.vehicleIds) {
        const mm = y.vehicle(v).lift.currentPosition;
        const before = prev.get(v) ?? mm;
        prev.set(v, mm);
        const leg = y.rt.stats(v)!.leg;
        const lastLeg = prevLeg.get(v) ?? leg;
        prevLeg.set(v, leg);
        if (mm >= before - 0.5) continue;
        // the hand-over stroke in the dock (incl. its last animated frame after the stay ended)
        if (lastLeg === 'atFrom' || lastLeg === 'atTo') continue;
        const loaded = y.backend.carried(v) !== null;
        if (loaded) lowered.loaded++; else lowered.empty++;
        if (leg === 'atFrom' || leg === 'atTo') continue;             // the hand-over stroke in the dock
        // The approach stroke at the turn point of the TARGET stich is checked by the fork-first tests.
        const target = expectedApproach(y, v)?.station;
        for (const zone of handlingZonesHeld(y, v)) {
          if (target && zone === `Stich_${target}`) continue;
          drops.push({ v, t: y.now(), zone, fromMm: before, toMm: mm, leg, loaded });
        }
      }
    },
  };
}

/** Run `y` for `sec` sim seconds in 0.5 s steps: reverse tasks (at assignment) and fork heights while reversing. */
function observe(y: YardWorld, sec: number, tasks: ReverseTask[], reversing: Sample[], exits?: ReturnType<typeof watchExits>, step = 0.5): void {
  const mine = watchReverseTasks(y);
  const end = y.now() + sec;
  while (y.now() < end) {
    y.runTo(y.now() + step);
    exits?.step();
    for (const v of y.rt.vehicleIds) {
      // Moving rear first (the Reverse signal alone stays set while a vehicle stands in a dock).
      if (sig(y.host, v, 'Reverse') !== true || sig(y.host, v, 'Moving') !== true) continue;
      const e = expectedApproach(y, v);
      // ... into THIS leg's handling stich (a vehicle may still back into the wait point
      // when its job comes — the engine finishes that manoeuvre first).
      const task = getDefaultAgvFleet().get(v)?.task;
      if (!e || task?.approach !== 'reverse' || task.destination !== y.rt.dispatcher.station(e.station).pathId) continue;
      reversing.push({ v, kind: e.kind, liftMm: y.vehicle(v).lift.currentPosition, expectMm: e.mm });
    }
  }
  tasks.push(...mine);
}

describe('PalletYard fork first (CP1c)', () => {
  it('[fastforward] every reverse task into a handling stich starts with the fork at approach height; reversing vehicles keep it', () => {
    const tasks: ReverseTask[] = [];
    const reversing: Sample[] = [];
    let maxWait = 0;
    let waits = 0;
    // Scenario 1 — nominal yard (production, pauses, buffer): pick, delivery to conveyor and floor slot.
    w = buildYard('fastforward');
    observe(w, 1800, tasks, reversing);
    waits += w.rt.counters.forkWaits;
    maxWait = Math.max(maxWait, w.rt.counters.maxForkWaitSec);
    w.dispose();
    // Scenario 2 — one pallet, both inputs paused 0..400 s: store, then retrieve after the pause.
    w = buildYard('fastforward', { cfg: cfgWith({ shippingPauses: { everySec: 1e6, durationSec: 400, offsetSec: [0, 0] } }) });
    observe(w, 900, tasks, reversing);
    expect(w.rt.counters).toMatchObject({ stored: 1, retrieved: 1, delivered: 1 });
    waits += w.rt.counters.forkWaits;
    maxWait = Math.max(maxWait, w.rt.counters.maxForkWaitSec);
    const kinds = new Set(tasks.map((t) => t.kind));
    for (const k of ['pick', 'retrieve', 'deliver-drop', 'deliver-buffer']) expect([...kinds], k).toContain(k);
    expect(tasks.filter((t) => Math.abs(t.liftMm - t.expectMm) > 0.5)).toEqual([]);
    expect(reversing.length).toBeGreaterThan(50);
    expect(new Set(reversing.map((r) => r.kind))).toEqual(kinds);
    expect(reversing.filter((r) => Math.abs(r.liftMm - r.expectMm) > 0.5)).toEqual([]);
    // The pre-stroke runs at the turn point: one counted stand per handling approach, never
    // longer than the longest stroke (travel 150 → 542 mm loaded at 150 mm/s = 2.6 s), never reported.
    expect(waits).toBe(tasks.length);
    expect(maxWait).toBeGreaterThan(0.5);
    expect(maxWait).toBeLessThan(3.5);
    expect(getProblems().filter(isForkWait)).toEqual([]);
  }, 240_000);

  for (const mode of MODES) {
    it(`[${mode}] the first pick and its delivery enter with the fork at approach height`, () => {
      w = buildYard(mode, { cfg: cfgWith() });
      const tasks = watchReverseTasks(w);
      expect(w.runUntil(() => Object.values(w!.shipped).some((l) => l.length > 0), 800, 0.5)).toBe(true);
      expect(tasks.map((t) => t.kind)).toEqual(['pick', 'deliver-drop']);
      for (const t of tasks) expect(t.liftMm, `${t.kind} ${t.station}`).toBeCloseTo(t.expectMm, 1);
      expect(tasks[0].expectMm).toBe(PALLET_YARD_CONFIG.stations.find((s) => s.id === 'A1')!.handlingHeightMm - DELTA);
    }, 120_000);
  }

  it('[fastforward] a slow lift → the vehicle waits at the turn point, is counted, visible and reported past the limit, then enters', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // 1 mm/s empty: the pre-stroke 150 → 482 mm takes 332 s — far longer than the drive to A1.
    w = buildYard('fastforward', {
      cfg: cfgWith({ vehicle: { ...PALLET_YARD_CONFIG.vehicle, liftSpeedEmptyMmS: 1 } }),
      runtime: { forkWaitLimitSec: 30, signals: { set: (name, value) => w?.host.signalStore!.set(name, value) } },
    });
    const waiting = (): string | null => w!.rt.vehicleIds.find((v) => w!.rt.stats(v)!.forkWait !== null) ?? null;
    expect(w.runUntil(() => waiting() !== null, 200, 0.5)).toBe(true);
    const v = waiting()!;
    const fw = w.rt.stats(v)!.forkWait!;
    expect(fw).toMatchObject({ station: 'A1', targetMm: PALLET_YARD_CONFIG.stations.find((s) => s.id === 'A1')!.handlingHeightMm - DELTA });
    expect(fw.actualMm).toBeLessThan(fw.targetMm);
    expect(w.rt.counters.forkWaits).toBe(1);
    expect(w.rt.stats(v)!.leg).toBe('toFrom');
    // Before the limit: nothing reported.
    const t0 = w.now() - fw.sinceSec;
    w.runTo(t0 + 29);
    expect(getProblems().filter(isForkWait)).toEqual([]);
    w.runTo(t0 + 31);
    const probs = getProblems().filter(isForkWait);
    expect(probs).toHaveLength(1);
    expect(probs[0].id).toBe(waitTimeoutProblemId(v, 'fork'));
    expect(w.host.signalStore!.get(`${v}.Status.Fault`)).toBe(true);
    expect(w.host.signalStore!.get(`${v}.Status.FaultCode`)).toBe(1);
    expect(probs[0].detail).toContain(v);
    expect(probs[0].detail).toContain('A1');
    expect(probs[0].detail).toContain(`fork to reach ${fw.targetMm} mm`);
    expect(probs[0].detail).toMatch(/actual \d+ mm/);
    expect(warn.mock.calls.some((c) => String(c[0]).includes(`${v} waits at the turn point of stich A1`))).toBe(true);
    expect(w.rt.counters.maxForkWaitSec).toBeGreaterThanOrEqual(30);
    // Still the same, distinguishable state — not forgotten: it enters once the fork is up.
    expect(w.rt.stats(v)!.forkWait).not.toBeNull();
    expect(w.runUntil(() => w!.rt.counters.picks >= 1, 600, 1)).toBe(true);
    expect(w.rt.stats(v)!.forkWait).toBeNull();
    expect(w.rt.counters.maxForkWaitSec).toBeGreaterThan(200);
    expect(w.rt.counters.forkWaits).toBe(1);
  }, 120_000);
});

describe('PalletYard shipping line with ConveyorOut (CP1c)', () => {
  for (const mode of MODES) {
    it(`[${mode}] input → ConveyorOut → sink; a pause holds the pallet on the input, in front of ConveyorOut`, () => {
      w = buildYard(mode, { cfg: cfgWith({ production: { intervalSec: 1e6, phaseSec: [1e6, 1e6] } }) });
      const input = w.backend.inputConveyor('V1')!;
      const out = w.backend.conveyorOutOf('V1')!;
      expect(out).not.toBeNull();
      expect(input.nextComponents).toEqual([out]);
      expect(out.nextComponents).toEqual([w.backend.sinkOf('V1')]);
      // Pause, then a pallet on the input conveyor (from inside a DES event).
      let mu: { id: number } | null = null;
      w.backend.clock.schedule(w.now() + 1, () => {
        w!.backend.setInputRun('V1', false);
        mu = w!.runner.createMU() as unknown as { id: number };
        expect(input.acceptMU(mu as never)).toBe(true);
      });
      w.runTo(w.now() + 60);
      // CP1d-b: the pause is `Conveyor_V1.Flow.Run` (per instance) — the successor stays wired,
      // the other input and both production outputs keep running.
      expect(input.nextComponents).toEqual([out]);
      expect(w.backend.inputRunSignal('V1')).toBe('Conveyor_V1.Flow.Run');
      const store = w.host.signalStore!;
      expect(store.get('Conveyor_V1.Flow.Run')).toBe(false);
      for (const other of ['Conveyor_V2', 'Conveyor_A1', 'Conveyor_A2', 'ConveyorOut_V1']) expect(store.get(`${other}.Flow.Run`), other).toBe(true);
      expect(input.currentLoad).toBe(1);
      expect(out.currentLoad).toBe(0);
      expect(w.shipped.V1).toEqual([]);
      // Pause end: onto ConveyorOut at once, then into the sink.
      w.backend.clock.schedule(w.now() + 1, () => w!.backend.setInputRun('V1', true));
      expect(w.runUntil(() => out.currentLoad === 1, 30, 0.25)).toBe(true);
      expect(input.currentLoad).toBe(0);
      expect(w.runUntil(() => w!.shipped.V1.length === 1, 120, 0.5)).toBe(true);
      expect(w.shipped.V1).toEqual([mu!.id]);
      expect(out.currentLoad).toBe(0);
      expect(out.totalProcessed).toBe(1);
    }, 120_000);
  }
});

describe('PalletYard stich exit (CP1c)', () => {
  it('[fastforward] the fork never goes down while a vehicle (outside its stay) still holds a handling stich zone', () => {
    const tasks: ReverseTask[] = [];
    const reversing: Sample[] = [];
    w = buildYard('fastforward');
    const ex = watchExits(w);
    observe(w, 1800, tasks, reversing, ex, 0.1);
    expect(ex.drops).toEqual([]);
    expect(ex.lowered.loaded).toBeGreaterThan(5);                   // pick → floor slot: down with the load, after the exit
    expect(ex.lowered.empty).toBeGreaterThan(5);
    w.dispose();
    w = buildYard('fastforward', { cfg: cfgWith({ shippingPauses: { everySec: 1e6, durationSec: 400, offsetSec: [0, 0] } }) });
    const ex2 = watchExits(w);
    observe(w, 900, tasks, reversing, ex2, 0.1);
    expect(w.rt.counters).toMatchObject({ stored: 1, retrieved: 1, delivered: 1 });
    expect(ex2.drops).toEqual([]);
    expect(getProblems().filter(isExitWait)).toEqual([]);
  }, 240_000);

  it('[animated] the same, frame by frame, for one pick and its delivery', () => {
    const tasks: ReverseTask[] = [];
    const reversing: Sample[] = [];
    w = buildYard('animated', { cfg: cfgWith() });
    const ex = watchExits(w);
    observe(w, 300, tasks, reversing, ex, 1 / 30);
    expect(Object.values(w.shipped).flat()).toHaveLength(1);
    expect(ex.drops).toEqual([]);
    expect(ex.lowered.empty + ex.lowered.loaded).toBeGreaterThan(0);
  }, 240_000);

  it('[fastforward] an exit that does not come in time is reported; the report clears when the vehicle is out', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // A limit shorter than any real exit: every stay end is "late" for a moment.
    w = buildYard('fastforward', { cfg: cfgWith(), runtime: { stichExitLimitSec: 0.2 } });
    let seen: string | null = null;
    expect(w.runUntil(() => {
      const p = getProblems().find(isExitWait);
      if (p) seen = p.detail ?? '';
      return p !== undefined;
    }, 400, 0.1)).toBe(true);
    expect(seen).toContain('A1');
    expect(seen).toMatch(/fork stays at \d+ mm/);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('has not left stich A1'))).toBe(true);
    expect(w.runUntil(() => !getProblems().some(isExitWait), 60, 0.1)).toBe(true);
  }, 120_000);
});

describe('PalletYard travel height on the loop (CP1c)', () => {
  /** Merge zone of a station's junction. */
  const mergeOf = (id: string): string => mergeZoneOf(junctionOfStation(id).id);

  it('[fastforward] driving on loop pieces (not a stich, not the merge piece of the target / last stich) the fork is at travel height, loaded and empty', () => {
    const travel = PALLET_YARD_CONFIG.vehicle.travelHeightMm;
    const z = getDefaultZoneRegistry();
    const bad: Array<{ v: string; t: number; mm: number; loaded: boolean; job: string | null }> = [];
    let loaded = 0, empty = 0, descending = 0;
    const run = (y: YardWorld, sec: number): void => {
      const last = new Map<string, string>();           // last handling stich a vehicle held
      const exitAt = new Map<string, number>();         // sim time it released that stich
      const prevMm = new Map<string, number>();
      const end = y.now() + sec;
      while (y.now() < end) {
        y.runTo(y.now() + 0.1);
        for (const v of y.rt.vehicleIds) {
          const st = y.rt.stats(v)!;
          const mm = y.vehicle(v).lift.currentPosition;
          const before = prevMm.get(v) ?? mm;
          prevMm.set(v, mm);
          const inStich = yardConfigOf(y.rt).stations.find((s) => z.isHolder(`Stich_${s.id}`, v));
          if (inStich) { last.set(v, inStich.id); exitAt.delete(v); continue; }
          if (z.isHolder('Stich_W', v)) continue;
          if (last.has(v) && !exitAt.has(v)) exitAt.set(v, y.now());
          if (st.leg === 'atFrom' || st.leg === 'atTo' || sig(y.host, v, 'Moving') !== true) continue;
          const near = [expectedApproach(y, v)?.station, last.get(v)].filter((x): x is string => !!x);
          if (near.some((id) => z.isHolder(mergeOf(id), v))) continue;
          const isLoaded = y.backend.carried(v) !== null;
          if (isLoaded) loaded++; else empty++;
          if (Math.abs(mm - travel) <= 1) continue;
          // The descent that starts at the exit may still run (≤ 2.6 s loaded): monotonic toward travel only.
          const sinceExit = y.now() - (exitAt.get(v) ?? -1e9);
          if (sinceExit <= 3 && Math.abs(mm - travel) < Math.abs(before - travel)) { descending++; continue; }
          bad.push({ v, t: y.now(), mm, loaded: isLoaded, job: st.job });
        }
      }
    };
    w = buildYard('fastforward');
    run(w, 1800);
    w.dispose();
    w = buildYard('fastforward', { cfg: cfgWith({ shippingPauses: { everySec: 1e6, durationSec: 400, offsetSec: [0, 0] } }) });
    run(w, 900);
    expect(bad.slice(0, 10)).toEqual([]);
    console.log(`[travel-height] samples loaded=${loaded} empty=${empty}, still descending after exit=${descending}`);
    expect(loaded).toBeGreaterThan(200);
    expect(empty).toBeGreaterThan(200);
  }, 240_000);
});

describe('PalletYard status lamps on the vehicles (CP1c)', () => {
  /** Stub RVLamps under each vehicle (the harness vehicles have none) — records the displayed state. */
  function addLamps(y: YardWorld): Map<string, Map<string, { lit: boolean; LampOn: boolean; Flashing: boolean; Period: number }>> {
    const out = new Map<string, Map<string, { lit: boolean; LampOn: boolean; Flashing: boolean; Period: number }>>();
    for (const v of y.rt.vehicleIds) {
      const m = new Map<string, { lit: boolean; LampOn: boolean; Flashing: boolean; Period: number }>();
      for (const role of LAMP_ROLES) {
        const n = new Object3D(); n.name = `Lamp_${role}`;
        const lamp = { lit: false, LampOn: false, Flashing: true, Period: 1, setDisplayedLit(l: boolean) { const c = this.lit !== l; this.lit = l; return c; } };
        n.userData._rvLamp = lamp;
        y.vehicle(v).root.add(n);
        m.set(role, lamp);
      }
      out.set(v, m);
    }
    y.rt.lamps.scan(y.rt.vehicleIds.map((id) => ({ id, root: y.vehicle(id).root })));
    return out;
  }

  it('[fastforward] state changes of a vehicle give the expected lamps and Status signals', () => {
    const signals = new Map<string, boolean | number>();
    w = buildYard('fastforward', { cfg: cfgWith(), runtime: { signals: { set: (n, v) => { signals.set(n, v); } } } });
    const lamps = addLamps(w);
    for (const m of lamps.values()) for (const l of m.values()) expect(l.Flashing).toBe(false);   // the plugin owns them
    const seen = new Map<string, Set<string>>();                                                  // vehicle → "green/amber/red/beacon" combos
    const key = (v: string): string => {
      const st = w!.rt.lamps.states.get(v)!;
      const f = (s: { on: boolean; flashing: boolean }): string => (s.on ? (s.flashing ? 'blink' : 'on') : 'off');
      return `G:${f(st.StackGreen)} A:${f(st.StackAmber)} R:${f(st.StackRed)} B:${f(st.Beacon)} E:${f(st.EyeL)}`;
    };
    let handlingSeen: string | null = null;
    while (w.now() < 300) {
      w.runTo(w.now() + 0.25);
      for (const v of w.rt.vehicleIds) {
        const s = seen.get(v) ?? new Set<string>(); s.add(key(v)); seen.set(v, s);
        const st = w.rt.statusOf(v)!;
        // displayed = table + sim-time blink
        const lamp = lamps.get(v)!.get('StackGreen')!;
        const expectLit = w.rt.lamps.states.get(v)!.StackGreen.on
          && (!w.rt.lamps.states.get(v)!.StackGreen.flashing || (w.now() % 1) < 0.5);
        expect(lamp.lit, `${v} t=${w.now()}`).toBe(expectLit);
        if (st.handling && !handlingSeen) {
          handlingSeen = v;
          expect(signals.get(`${v}.Status.Handling`)).toBe(true);
          expect(lamps.get(v)!.get('StackAmber')!.lit).toBe(true);
        }
      }
    }
    const picker = handlingSeen!;
    expect(picker).not.toBeNull();
    const combos = seen.get(picker)!;
    expect(combos).toContain('G:on A:off R:off B:off E:on');          // free, standing
    expect(combos).toContain('G:blink A:off R:off B:blink E:on');     // order, driving
    expect(combos).toContain('G:off A:on R:off B:off E:on');          // fork / hand-over in the dock
    expect(signals.get(`${picker}.Status.Busy`)).toBe(false);          // the one pallet is shipped
    expect(signals.get(`${picker}.Status.Free`)).toBe(true);
  }, 120_000);

  it('[fastforward] charging blinks amber; a reported fork wait turns red with the eyes off', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    w = buildYard('fastforward', { cfg: cfgWith({ battery: { ...PALLET_YARD_CONFIG.battery, startSoc: [20, 90, 90] } }) });
    addLamps(w);
    expect(w.runUntil(() => w!.rt.statusOf('Stapler_1')!.charging, 300, 0.25)).toBe(true);
    expect(w.rt.lamps.states.get('Stapler_1')!.StackAmber).toEqual({ on: true, flashing: true });
    w.dispose();
    w = buildYard('fastforward', {
      cfg: cfgWith({ vehicle: { ...PALLET_YARD_CONFIG.vehicle, liftSpeedEmptyMmS: 1 } }), runtime: { forkWaitLimitSec: 30 },
    });
    const lamps = addLamps(w);
    expect(w.runUntil(() => w!.rt.vehicleIds.some((v) => w!.rt.statusOf(v)!.fault), 300, 0.25)).toBe(true);
    const v = w.rt.vehicleIds.find((x) => w!.rt.statusOf(x)!.fault)!;
    expect(w.rt.lamps.states.get(v)).toMatchObject({ StackRed: { on: true, flashing: false }, EyeL: { on: false } });
    expect(lamps.get(v)!.get('StackRed')!.lit).toBe(true);
    expect(lamps.get(v)!.get('EyeL')!.lit).toBe(false);
  }, 120_000);
});
