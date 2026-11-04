// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
// plan-612 Phase 6 (9.5/9.6) — long run of the REAL scenes/PalletYard.glb in DES FastForward:
// does the yard keep flowing over several simulated days, or does it block?
//   - every simulated hour after the warm-up ships pallets (no hour without throughput);
//   - no BLOCKADE: no vehicle STANDS (plan ended, speed 0) at a TRAFFIC stop (zone / zonePending /
//     leader / hold) continuously for longer than STUCK_SEC sim seconds. Service stops (handling,
//     wait point, charger) do not count — waits for the belt, a charge or a buffer slot are legitimate
//     and can last longer than STUCK_SEC (plan-634 probe: up to ~6500 s on pick/toTo, 559 D9);
//   - plan-634 invariants of the movement authority: serviceOvershoot === 0, turnGuardTrips === 0;
//   - no pallet-yard / fleet Problems (fork-wait / stich-exit timeouts, hijacked tasks);
//   - upper bounds (plan-612 Phase 6, #211): every SAMPLE_H sim hours the event queue
//     (`DESManager.queuedEventCount`), live MUs, MU slots, scene-graph nodes, the size of the
//     statistics and the JS heap after a forced GC (CDP) are sampled; `checkSoakBounds` asserts an
//     absolute cap per figure and no growth between the first and the last third of the run. An
//     unreadable figure FAILS (the former queue assert read an accessor the manager did not have
//     and silently never ran). The node test pallet-yard-soak-bounds proves the checks bite.
// Sim time only — the wall clock never decides anything here.
//
// Length: 3 sim days by default (part of the suite, pinned by the plan-645 S10 manifest through the
// unchanged `SOAK_RESULT` line). `RV_SOAK_DAYS=7` (build constant `__RV_SOAK_DAYS__`) runs a week.
// The same checks also run in DES Animated (default 600 sim seconds, ~6 s wall; 1/60 s ticks, headless —
// sim time, not wall time). `RV_SOAK_ANIMATED_SEC=3600` (`__RV_SOAK_ANIMATED_SEC__`) runs an hour.
//
// The former deadlock at sim t ≈ 9837 s (LOP #204: a turn point assigned closer than the braking
// distance, planned as a stop beyond the piece end) is fixed by plan-634 — an unreachable service
// stop is missed and served on the next visit. The loop stops at the first blockade (fail fast).
// The longest duration per job/leg combination and per vehicle is logged (information for 559 D9).
// Since CP1d-b the scene is loaded through the viewer (stacker / conveyor placements).
import { expectNoWaitTimeouts } from './pallet-yard-soak-bounds';
import { describe, expect, it, vi } from 'vitest';
import type { Object3D } from 'three';
import { DESRunner } from '@rv/plugins/des/des-runner';
import '@rv/behaviors/Conveyor';
import '@rv/behaviors/Source';
import '@rv/behaviors/Sink';
import '@rv/behaviors/Agv';
import { getProblems } from '../../src/core/hmi/problems-store';
import { devAssetAvailable } from '../fixtures/dev-asset-available';
import { getDefaultMovementAuthority, type StopCause } from '../../src/core/engine/rv-movement-authority';
import { PluginOwnerRegistry } from '@rv/plugins/des/fleet/des-handover';
import { bindDesYard, startDesRuntime } from '@rv/plugins/models/PalletYard/yard-runtime';
import { PALLET_YARD_URL as URL, loadPalletYardScene } from './pallet-yard-scene-load';
import { heapUsedAfterGc } from '../helpers/heap-sampling';
import { checkSoakBounds, summariseSoak, type SoakSample } from './pallet-yard-soak-bounds';

const AVAILABLE = await devAssetAvailable(URL);
const DAYS = (typeof __RV_SOAK_DAYS__ !== 'undefined' && __RV_SOAK_DAYS__ > 0) ? __RV_SOAK_DAYS__ : 3;
const ANIMATED_SEC = (typeof __RV_SOAK_ANIMATED_SEC__ !== 'undefined' && __RV_SOAK_ANIMATED_SEC__ > 0) ? __RV_SOAK_ANIMATED_SEC__ : 600;
const HOUR = 3600;
const WARMUP_H = 1;
const STUCK_SEC = 1800;
/** Resource sampling grid (sim hours); samples before BOUNDS_WARMUP_H are not judged. */
const SAMPLE_H = 6;
const BOUNDS_WARMUP_H = 6;
const VEHICLES = ['Stapler_1', 'Stapler_2', 'Stapler_3'];
/** Stop causes of a TRAFFIC standstill — a blockade candidate (service stops never are). */
const TRAFFIC: ReadonlySet<StopCause> = new Set<StopCause>(['zone', 'zonePending', 'leader', 'hold']);

interface SoakManager {
  currentTime: number; isComplete: boolean; totalEventsProcessed: number;
  queuedEventCount: number; liveMuCount: number; muCount: number; componentCount: number;
  getComponentByEntityId(i: number): { getStatistics(): unknown } | null;
}

describe.skipIf(!AVAILABLE)('PalletYard soak: no blocking over several sim days (Phase 6)', () => {
  const run = async (mode: 'fastforward' | 'animated', durationSec: number, tag: string): Promise<void> => {
    const y = await loadPalletYardScene();
    const root: Object3D = y.root;
    const host = y.host;
    const runner = new DESRunner({ subMode: mode, durationSeconds: durationSec });
    const animated = mode === 'animated';
    let runtime: ReturnType<typeof startDesRuntime> | null = null;
    try {
      runner.start([], { root, host: host as never });
      const r = bindDesYard({ runner, root, drives: y.drives, owners: new PluginOwnerRegistry() });
      if (!r.ok) throw new Error(`bind: ${r.missing.join(', ')}`);
      const rt = runtime = startDesRuntime(r.backend, () => {});
      const mgr = runner.getManager() as unknown as SoakManager;
      const shipped = (): number => r.backend.sinkOf('V1')!.totalProcessed + r.backend.sinkOf('V2')!.totalProcessed;
      const queue = (): number => mgr.queuedEventCount;
      const statsBytes = (): number => {
        let n = 0;
        for (let i = 0; i < mgr.componentCount; i++) n += JSON.stringify(mgr.getComponentByEntityId(i)?.getStatistics() ?? null).length;
        return n + JSON.stringify(rt.jobLog).length + JSON.stringify(getProblems()).length;
      };
      const countNodes = (): number => { let n = 0; y.scene.traverse(() => { n++; }); return n; };
      const samples: SoakSample[] = [];
      const sample = async (t: number): Promise<void> => {
        samples.push({ t, queue: queue(), liveMus: mgr.liveMuCount, muSlots: mgr.muCount, nodes: countNodes(), statsBytes: statsBytes(), heapBytes: await heapUsedAfterGc() });
      };
      const sampleEvery = animated ? 600 : SAMPLE_H * HOUR;
      let nextSample = sampleEvery;
      const wall0 = performance.now();

      const perHour: Array<{ h: number; shipped: number; produced: number; picks: number; stored: number; retrieved: number; queue: number }> = [];
      const mb = getDefaultMovementAuthority('des');
      /** Start of the current continuous traffic standstill per vehicle. */
      const standSince = new Map<string, number>();
      const stuck: string[] = [];
      /** Current job/leg combination per vehicle and the longest durations seen (559 D9 information). */
      const combo = new Map<string, { key: string; since: number }>();
      const maxByCombo = new Map<string, { sec: number; id: string; at: number }>();
      const maxByVehicle = new Map<string, { sec: number; key: string }>();
      const closeCombo = (id: string, key: string, sec: number, at: number): void => {
        const mc = maxByCombo.get(key);
        if (!mc || sec > mc.sec) maxByCombo.set(key, { sec, id, at });
        const mv = maxByVehicle.get(id);
        if (!mv || sec > mv.sec) maxByVehicle.set(id, { sec, key });
      };
      let nextHour = HOUR, lastShipped = 0, lastProduced = 0, lastPicks = 0, lastStored = 0, lastRetrieved = 0;
      let idle = 0;
      const done = (): boolean => (animated ? mgr.currentTime >= durationSec : mgr.isComplete);
      for (let k = 0; !done(); k++) {
        const before = mgr.totalEventsProcessed;
        // FF's real-time slice can cross a different number of grid points under
        // load. Expire its budget after one inner batch: all post-tick probes
        // (resources, hours, standstills) then see deterministic event boundaries.
        // No observation events are inserted; model order/times/counts stay intact.
        let budgetTime = 0;
        const budgetClock = animated ? null : vi.spyOn(performance, 'now').mockImplementation(() => (budgetTime += 1000));
        try { runner.tick(1 / 60); } finally { budgetClock?.mockRestore(); }
        runner.lateTick(1 / 60); rt.frame(); expectNoWaitTimeouts(rt);
        if (animated) y.scene.updateMatrixWorld(); // the viewer's render loop does this every frame
        idle = mgr.totalEventsProcessed === before ? idle + 1 : 0;
        if (!animated && idle >= 3) throw new Error(`stall at sim t=${mgr.currentTime.toFixed(0)} s (no event in 3 ticks)`);
        const t = mgr.currentTime;
        while (t >= nextSample) { await sample(nextSample); nextSample += sampleEvery; }
        for (const id of VEHICLES) {
          const s = rt.stats(id);
          if (!s) continue;
          const key = `${s.job ?? '-'}/${s.leg}`;
          const cur = combo.get(id);
          if (!cur || cur.key !== key) {
            if (cur) closeCombo(id, cur.key, t - cur.since, cur.since);
            combo.set(id, { key, since: t });
          }
          // Blockade = standing at a TRAFFIC stop without interruption (plan ended, speed 0).
          const plan = mb.planOf(id);
          const cause = mb.stopCauseOf(id);
          const standing = plan !== null && plan.profile.tEnd <= t + 1e-9 && mb.speedOf(id, t) < 1e-9
            && cause !== null && TRAFFIC.has(cause);
          if (!standing) { standSince.delete(id); continue; }
          const since = standSince.get(id) ?? t;
          standSince.set(id, since);
          if (t - since > STUCK_SEC && !stuck.some((x) => x.startsWith(id))) {
            stuck.push(`${id} stands at a '${cause}' stop since ${since.toFixed(0)} s (t=${t.toFixed(0)}) job=${key} waitingAt=${s.waitingAt}`);
          }
        }
        if (stuck.length > 0) break; // fail fast — the blockade is the finding, not the remaining days
        while (t >= nextHour) {
          const c = rt.counters;
          perHour.push({
            h: nextHour / HOUR, shipped: shipped() - lastShipped, produced: c.produced - lastProduced,
            picks: c.picks - lastPicks, stored: c.stored - lastStored, retrieved: c.retrieved - lastRetrieved, queue: queue(),
          });
          lastShipped = shipped(); lastProduced = c.produced; lastPicks = c.picks; lastStored = c.stored; lastRetrieved = c.retrieved;
          nextHour += HOUR;
        }
      }
      const wallMs = performance.now() - wall0;
      const c = rt.counters;
      const problems = getProblems().filter((p) => p.code.startsWith('pallet-yard') || p.code.startsWith('fleet-')).map((p) => `${p.code}:${p.id}`);
      const deadHours = perHour.filter((h) => h.h > WARMUP_H && h.shipped === 0).map((h) => h.h);
      const q = perHour.map((h) => h.queue);
      console.log(`[soak] ${tag}: wall=${(wallMs / 1000).toFixed(0)} s, ${perHour.length} sim hours`);
      console.log(`[soak] ${tag}: produced=${c.produced} shipped=${shipped()} picks=${c.picks} stored=${c.stored} retrieved=${c.retrieved} `
        + `bufferPeak=${c.bufferPeak} blockedTakts=${c.blockedTakts} forkWaits=${c.forkWaits} maxForkWait=${c.maxForkWaitSec.toFixed(1)}s goArounds=${c.goArounds}`);
      console.log(`[soak] shipped/h min=${perHour.length > WARMUP_H ? Math.min(...perHour.slice(WARMUP_H).map((h) => h.shipped)) : '-'} max=${perHour.length ? Math.max(...perHour.map((h) => h.shipped)) : "-"} `
        + `queue first=${q[0]} last=${q[q.length - 1]} max=${q.length ? Math.max(...q) : -1}`);
      console.log(`[soak] per vehicle: ${VEHICLES.map((id) => { const s = rt.stats(id)!; return `${id} orders=${s.ordersDone} charges=${s.charges} minSoc=${s.minSoc.toFixed(2)}`; }).join(' | ')}`);
      console.log(`[soak] deadHours=${JSON.stringify(deadHours)} stuck=${JSON.stringify(stuck)} problems=${JSON.stringify(problems)}`);
      for (const [id, cur] of combo) closeCombo(id, cur.key, mgr.currentTime - cur.since, cur.since);
      const top = [...maxByCombo].sort((a, b) => b[1].sec - a[1].sec).slice(0, 8);
      console.log(`[soak] longest job/leg (top 8): ${top.map(([k, v]) => `${k}=${v.sec.toFixed(0)}s(${v.id}@${v.at.toFixed(0)})`).join(' ')}`);
      console.log(`[soak] longest per vehicle: ${VEHICLES.map((id) => { const m = maxByVehicle.get(id); return `${id}=${m ? `${m.sec.toFixed(0)}s ${m.key}` : '-'}`; }).join(' | ')}`);
      const ms = mb.stats;
      console.log(`[soak] plan-634: serviceStopsMissed=${ms.serviceStopsMissed} serviceOvershoot=${ms.serviceOvershoot} `
        + `serviceUndershoot=${ms.serviceUndershoot} turnGuardTrips=${ms.turnGuardTrips} dirRefused=${ms.dirRefused}`);
      console.log(`[soak] hours: ${perHour.map((h) => `${h.h}:${h.shipped}/${h.stored}/${h.retrieved}`).join(' ')}`);
      const judged = samples.filter((x) => x.t >= (animated ? 600 : BOUNDS_WARMUP_H * HOUR));
      const bounds = checkSoakBounds(judged, undefined, samples.every((x) => x.heapBytes === null));
      console.log('SOAK_BOUNDS ' + JSON.stringify({ tag, wallSec: Math.round(wallMs / 1000), samples: judged.length, summary: summariseSoak(judged), violations: bounds }));
      console.log(`[soak] samples: ${samples.map((x) => `${(x.t / HOUR).toFixed(1)}h q=${x.queue} mu=${x.liveMus}/${x.muSlots} n=${x.nodes} st=${x.statsBytes} heap=${x.heapBytes === null ? '-' : (x.heapBytes / 1048576).toFixed(1)}M`).join(' | ')}`);
      if (animated) {
        console.log(`[soak] ${tag} result: shipped=${shipped()} produced=${c.produced} simTime=${mgr.currentTime.toFixed(0)}`);
        expect(mgr.currentTime).toBeGreaterThanOrEqual(durationSec - 1);
        expect(shipped()).toBeGreaterThan(0);
        // steady FastForward hours ship 37-60; an Animated hour (warm-up included) shipped 47 (2026-10-24)
        if (durationSec >= HOUR) expect(shipped()).toBeGreaterThanOrEqual(30 * Math.floor(durationSec / HOUR));
        expect(deadHours).toEqual([]);
        expect(stuck).toEqual([]);
        expect(problems).toEqual([]);
        expect(ms.serviceOvershoot).toBe(0);
        expect(ms.turnGuardTrips).toBe(0);
        expect(bounds).toEqual([]);
        return;
      }
      // plan-645 L8 / R2-5: one machine-readable line for pallet-yard-s10-compare.node.test.ts.
      console.log('SOAK_RESULT ' + JSON.stringify({
        days: DAYS, simTimeSec: mgr.currentTime, produced: c.produced, shipped: shipped(), picks: c.picks,
        stored: c.stored, retrieved: c.retrieved, desEvents: mgr.totalEventsProcessed,
        perVehicle: Object.fromEntries(VEHICLES.map((id) => { const s = rt.stats(id)!; return [id, { ordersDone: s.ordersDone, charges: s.charges, minSoc: Math.round(s.minSoc * 1e6) / 1e6 }]; })),
        deadHours, stuck, problems, serviceOvershoot: ms.serviceOvershoot, turnGuardTrips: ms.turnGuardTrips,
      }));
      expect(mgr.currentTime).toBeGreaterThanOrEqual(DAYS * 24 * HOUR - 1);
      expect(deadHours).toEqual([]);
      expect(stuck).toEqual([]);
      expect(problems).toEqual([]);
      expect(ms.serviceOvershoot).toBe(0);
      expect(ms.turnGuardTrips).toBe(0);
      expect(bounds).toEqual([]);
    } finally {
      runtime?.dispose();
      runner.dispose();
      y.dispose();
    }
  };

  it(`runs ${DAYS} sim days in FastForward without a blockade, within the upper bounds`, async () => {
    await run('fastforward', DAYS * 24 * HOUR, `${DAYS} d FastForward`);
  }, Math.max(900_000, DAYS * 360_000));

  it(`runs ${ANIMATED_SEC} sim seconds in Animated without a blockade, within the upper bounds`, async () => {
    await run('animated', ANIMATED_SEC, `${ANIMATED_SEC} s Animated`);
  }, Math.max(900_000, ANIMATED_SEC * 2_000));
});
