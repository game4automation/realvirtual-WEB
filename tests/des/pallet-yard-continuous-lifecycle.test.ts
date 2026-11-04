// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
// plan-612 CP2 (CP2-Gate G4) — lifecycle of the continuous PalletYard on the REAL scene
// through the REAL plugin:
//   - reset (`resetSimulation`) DURING a lift stroke, a loaded drive and a refused drop:
//     no callback of the old clock generation fires, no pallet is left (no rest MU, no hold
//     on a fork), every lift at travel height and stopped, the vehicles back at their start
//     pose, exactly ONE new production — and the run after the reset is the run of a fresh
//     start (same jobs);
//   - mode switch continuous → DES → continuous: never two runtimes (no dock registered
//     twice), the old backend is disposed (its tick does nothing), no orphaned hold, each
//     kernel runs the yard;
//   - plan-648 (LOP #219): after continuous → DES → continuous the yard picks and delivers
//     again — the fleet handles belong to the continuous instances, the zone claims equal
//     those of the first session.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Vector3, type Object3D } from 'three';
import type { DESRunner } from '@rv/plugins/des/des-runner';
import { placeMUOnSurface } from '../../src/core/engine/rv-mu-manipulation';
import { getDefaultAgvFleet } from '../../src/core/engine/rv-agv-fleet';
import { trafficRegistryStats } from '../../src/core/engine/rv-traffic-registries';
import { devAssetAvailable } from '../fixtures/dev-asset-available';
import { PALLET_YARD_CONFIG } from '../../src/plugins/models/PalletYard/layout';
import type { ContinuousHandover } from '@rv/core/fleet/continuous/handover';
import type { DesHandoverBackend } from '@rv/plugins/des/fleet/des-handover';
import { loadContinuousYard, type ContinuousYard } from './pallet-yard-continuous-scene';
import { PALLET_YARD_URL } from './pallet-yard-scene-load';

const AVAILABLE = await devAssetAvailable(PALLET_YARD_URL);
const TRAVEL = PALLET_YARD_CONFIG.vehicle.travelHeightMm;
const world = (n: Object3D): Vector3 => { n.updateWorldMatrix(true, false); return n.getWorldPosition(new Vector3()); };

describe.skipIf(!AVAILABLE)('PalletYard continuous lifecycle (CP2 G4) — real scene, real plugin', () => {
  let y: ContinuousYard;
  let startPose: Map<string, Vector3>;
  let freshJobs: string[];
  const anchorKids = new Map<string, number>();
  beforeAll(async () => {
    y = await loadContinuousYard({ plugin: true });
    startPose = new Map(y.rt.vehicleIds.map((v) => [v, world(y.be.vehicleNode(v)!)]));
    for (const v of y.rt.vehicleIds) anchorKids.set(v, y.be.anchorOf(v)!.children.length);
    y.runTo(120);
    freshJobs = y.rt.jobLog;
  }, 240_000);
  afterAll(() => { y?.dispose(); });

  const STATES: Array<{ name: string; prepare?: (be: ContinuousHandover) => void; reach: () => boolean }> = [
    { name: 'a lift stroke', reach: () => y.rt.vehicleIds.some((v) => y.be.lift.moving(v)) },
    { name: 'a loaded drive', reach: () => y.rt.vehicleIds.some((v) => y.rt.stats(v)!.leg === 'toTo' && y.be.carried(v) !== null) },
    {
      name: 'a refused drop',
      prepare: (be) => { be.placeImpl = () => ({ ok: false, reason: 'test: refused' }); },
      reach: () => y.be.counters.rollbacks > 0,
    },
  ];

  for (const st of STATES) {
    it(`reset during ${st.name}: no old callback, no rest MU / hold, start pose, exactly one new production, the fresh run again`, () => {
      y.viewer.resetSimulation();
      const be = y.be;
      st.prepare?.(be);
      expect(y.runUntil(st.reach, 400), `state "${st.name}" reached`).toBe(true);
      // An old-generation callback and the state before the reset.
      let ghost = 0;
      be.clock.schedule(be.clock.now() + 0.5, () => { ghost++; });
      const epoch = y.rt.epoch;
      y.viewer.resetSimulation();
      expect(y.be, 'same backend (no rebind)').toBe(be);
      expect(y.rt.epoch).toBeGreaterThan(epoch);
      be.placeImpl = placeMUOnSurface;
      // Right after the reset: nothing held, nothing left, lifts home and stopped.
      for (const v of y.rt.vehicleIds) {
        expect(be.carried(v), `${v} carries nothing`).toBeNull();
        expect(be.anchorOf(v)!.children.length, `${v}: nothing below ForkAnchor`).toBe(anchorKids.get(v));
        expect(be.lift.position(v), `${v} lift at travel height`).toBeCloseTo(TRAVEL, 3);
        expect(be.lift.moving(v), `${v} lift stopped`).toBe(false);
        expect(world(be.vehicleNode(v)!).distanceTo(startPose.get(v)!) * 1000, `${v} start pose (mm)`).toBeLessThan(1);
      }
      for (const s of ['P1', 'P2', 'P3', 'P4', 'P5', 'P6']) expect(be.onSlot(s), s).toBeNull();
      expect(be.livePallets(), 'no rest MU').toBe(0);
      y.tick(3);
      expect(be.counters.edges, 'exactly one new production (A1 at t=0)').toBe(1);
      expect(be.counters.spawned).toBe(1);
      expect(be.livePallets()).toBe(1);
      y.runTo(120);
      expect(ghost, 'no callback of the old generation').toBe(0);
      expect(y.rt.jobLog, 'the run after the reset is the fresh run').toEqual(freshJobs);
    }, 240_000);
  }

  it('mode switch continuous → DES → continuous: one runtime at a time, old backend disposed, no orphaned hold', async () => {
    const warn = vi.spyOn(console, 'warn');
    try {
      y.viewer.resetSimulation();
      const contBe = y.be;
      expect(y.runUntil(() => y.rt.vehicleIds.some((v) => y.rt.stats(v)!.leg === 'toTo' && contBe.carried(v) !== null), 400), 'loaded drive').toBe(true);
      // → DES
      y.viewer.simulationKernel!.setMode('des');
      await Promise.resolve();
      const plugin = y.plugin!;
      expect(plugin.runtime?.adapters.kind, 'DES bound').toBe('des');
      for (const v of plugin.runtime!.vehicleIds) {
        expect(contBe.anchorOf(v)!.children.length, `${v}: no orphaned hold`).toBe(anchorKids.get(v));
      }
      const t0 = contBe.clock.now();
      contBe.tick();                                   // disposed: does nothing
      expect(contBe.clock.now()).toBe(t0);
      const desBe = plugin.runtime!.adapters as DesHandoverBackend;
      const runner = y.viewer.simulationKernel!.desControl() as unknown as DESRunner;
      const m = runner.getManager();
      const end = Math.ceil(m.currentTime) + 120;
      for (let t = Math.ceil(m.currentTime) + 1; t <= end; t++) {
        desBe.clock.schedule(t, () => {}); m.processUpTo(t, 1e8); plugin.runtime!.frame();
      }
      expect(plugin.runtime!.counters.picks, 'DES runs the yard').toBeGreaterThan(0);
      // → continuous again
      y.viewer.simulationKernel!.setMode('continuous');
      await Promise.resolve();
      expect(plugin.runtime?.adapters.kind, 'continuous bound again').toBe('continuous');
      expect(plugin.runtime!.adapters, 'a new continuous backend').not.toBe(contBe);
      const be2 = y.be;
      const p0 = new Map(y.rt.vehicleIds.map((v) => [v, world(be2.vehicleNode(v)!)]));
      y.runTo(y.now() + 150);
      console.info(`[G4] after DES → continuous: moved ${y.rt.vehicleIds.map((v) => `${v} ${world(be2.vehicleNode(v)!).distanceTo(p0.get(v)!).toFixed(2)} m ${y.rt.stats(v)!.leg}`).join(', ')}; spawned ${be2.counters.spawned}; jobs ${y.rt.jobLog.join(' | ')}`);
      expect(be2.counters.spawned, 'continuous produces again').toBeGreaterThan(0);
      // The stackers drive again (that they also deliver again: plan-648 test below).
      expect(y.rt.vehicleIds.some((v) => world(be2.vehicleNode(v)!).distanceTo(p0.get(v)!) > 1), 'the fleet drives again').toBe(true);
      for (const v of y.rt.vehicleIds) {
        const held = be2.anchorOf(v)!.children.length - anchorKids.get(v)!;
        expect(held, `${v}: only its own carried pallet below the fork`).toBe(be2.carried(v) ? 1 : 0);
      }
      const doubles = warn.mock.calls.filter((c) => String(c[0]).includes('already has a dock'));
      expect(doubles, 'no dock registered twice (no double bind)').toEqual([]);
    } finally {
      warn.mockRestore();
    }
  }, 240_000);

  // plan-648 (LOP #219, formerly the it.todo of plan-612 CP2 G6): before plan-648 the DES
  // instances kept the fleet handles after the switch back — the yard's tasks landed in the
  // un-ticked DES instance, the ticked continuous one stayed at its old service stop (0 picks).
  it('after continuous → DES → continuous the yard picks and delivers again (plan-648, LOP #219)', async () => {
    const warn = vi.spyOn(console, 'warn');
    try {
      y.viewer.resetSimulation();
      const p0 = y.rt.counters.picks;
      y.runTo(y.now() + 150);
      const picks1 = y.rt.counters.picks - p0;
      const zones1 = trafficRegistryStats().zoneHolders;
      expect(picks1, 'session 1 picks').toBeGreaterThan(0);
      // → DES (the driving pattern of the repro)
      y.viewer.simulationKernel!.setMode('des');
      await Promise.resolve();
      const plugin = y.plugin!;
      for (const v of plugin.runtime!.vehicleIds) expect(getDefaultAgvFleet().get(v)?.kernel, `${v} handle in DES`).toBe('des');
      const desBe = plugin.runtime!.adapters as DesHandoverBackend;
      const runner = y.viewer.simulationKernel!.desControl() as unknown as DESRunner;
      const m = runner.getManager();
      const end = Math.ceil(m.currentTime) + 120;
      for (let t = Math.ceil(m.currentTime) + 1; t <= end; t++) {
        desBe.clock.schedule(t, () => {}); m.processUpTo(t, 1e8); plugin.runtime!.frame();
      }
      // → continuous again
      y.viewer.simulationKernel!.setMode('continuous');
      await Promise.resolve();
      for (const v of y.rt.vehicleIds) expect(getDefaultAgvFleet().get(v)?.kernel, `${v} handle back`).toBe('continuous');
      const p2 = y.rt.counters.picks;
      y.runTo(y.now() + 150);
      const picks2 = y.rt.counters.picks - p2;
      const zones2 = trafficRegistryStats().zoneHolders;
      console.info(`[648] picks session 1 ${picks1}, session 2 ${picks2}; zoneHolders ${zones1} / ${zones2}`);
      expect(picks2, 'the yard picks again after the round trip').toBeGreaterThan(0);
      expect(zones2, 'zone claims as in session 1 (no leaked holder per switch)').toBe(zones1);
      const doubles = warn.mock.calls.filter((c) => String(c[0]).includes('already has a dock'));
      expect(doubles, 'no dock registered twice').toEqual([]);
    } finally {
      warn.mockRestore();
    }
  }, 240_000);
});
