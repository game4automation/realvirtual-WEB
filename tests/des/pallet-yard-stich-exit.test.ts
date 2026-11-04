// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it, vi } from 'vitest';
import { DESRunner } from '@rv/plugins/des/des-runner';
import '@rv/behaviors/Conveyor';
import '@rv/behaviors/Source';
import '@rv/behaviors/Sink';
import '@rv/behaviors/Agv';
import { registerAllBehaviors } from '@rv/core/behaviors';
import { PlanningParametersPlugin } from '@rv/plugins/planning-parameters';
import { getDefaultAgvFleet, type AgvTask } from '@rv/core/engine/rv-agv-fleet';
import { getDefaultMovementAuthority } from '@rv/core/engine/rv-movement-authority';
import { getDefaultZoneRegistry } from '@rv/core/engine/rv-zone-registry';
import { getProblems, resetProblemsForTests } from '@rv/core/hmi/problems-store';
import { PalletYardPlugin } from '@rv/plugins/models/PalletYard/index';
import { bindDesYard, startDesRuntime, STICH_EXIT_LIMIT_SEC, yardConfigOf, type YardRun } from '@rv/plugins/models/PalletYard/yard-runtime';
import { PluginOwnerRegistry } from '@rv/plugins/des/fleet/des-handover';
import type { DesHandoverBackend } from '@rv/plugins/des/fleet/des-handover';
import { FLEET_WAIT_TIMEOUT_CODE } from '@rv/core/fleet/exec/wait-watch';
/** The fleet executor's exit-wait report (plan-559 Phase 5). */
const isExitWait = (p: { code: string; id: string }): boolean => p.code === FLEET_WAIT_TIMEOUT_CODE && p.id.endsWith(':exit');
import { devAssetAvailable } from '../fixtures/dev-asset-available';
import { loadPalletYardScene } from './pallet-yard-scene-load';

const URL = '/demo-realvirtual/PalletYard.glb';
const AVAILABLE = await devAssetAvailable(URL);
const DAY = 24 * 3600;

// Read-only diagnostic seam except for the deliberate startJob injection below.
interface VehicleProbe {
  id: string;
  unassigned: AgvTask | null;
  job: unknown;
  leg: string;
  exiting: { zone: string; station: string; since: number; reported?: boolean } | null;
}
interface RuntimeProbe {
  vehicles: Map<string, VehicleProbe>;
  endExit(v: VehicleProbe): void;
  startJob(v: VehicleProbe, job: {
    kind: 'charge'; vehicle: string; charger: string; untilSoc: number; durationSec: number;
  }): void;
}
const probe = (rt: YardRun) => rt as unknown as RuntimeProbe;

function dump(rt: YardRun): string {
  const authority = getDefaultMovementAuthority('des');
  return JSON.stringify({ simTime: rt.clock.now(), vehicles: [...probe(rt).vehicles.values()].map(v => {
    const held: string[] = [];
    getDefaultZoneRegistry().collectHeld(v.id, held);
    const plan = authority.planOf(v.id);
    return {
      id: v.id, phase: getDefaultAgvFleet().get(v.id)?.phase ?? 'missing',
      unassigned: v.unassigned, heldZones: held, stopCauseOf: authority.stopCauseOf(v.id),
      // RVPath has cyclic predecessor/successor references. Keep the full
      // numeric plan, but identify its route pieces without serializing the graph.
      planOf: plan ? { ...plan, route: plan.route.map(r => ({ path: r.path.id, x0: r.x0 })) } : null,
      job: v.job, leg: v.leg, exiting: v.exiting,
    };
  }) }, null, 2);
}

function advance(runner: DESRunner, rt: YardRun, target: number): void {
  const be = rt.adapters as DesHandoverBackend;
  be.clock.schedule(target, () => {});
  runner.getManager().processUpTo(target, 1e8);
  rt.frame();
}

function soak(runner: DESRunner, rt: YardRun): void {
  runner.setSubMode('fastforward');
  runner.getManager().duration = Infinity;
  const end = rt.clock.now() + DAY;
  let firstFailure = '';
  // Check during the run as well as at its end: endExit clears Problems.
  for (let t = rt.clock.now() + 1; t <= end; t++) {
    advance(runner, rt, t);
    if (!firstFailure && ([...probe(rt).vehicles.values()].some(v =>
      v.exiting?.reported && t - v.exiting.since >= STICH_EXIT_LIMIT_SEC)
      || getProblems().some(isExitWait))) firstFailure = dump(rt);
  }
  expect(rt.clock.now(), dump(rt)).toBeGreaterThanOrEqual(end);
  expect(firstFailure, `Node-DES-Dump at first stuck exit:\n${firstFailure || dump(rt)}`).toBe('');
  expect(getProblems().filter(isExitWait), dump(rt)).toEqual([]);
  expect(rt.counters.delivered, dump(rt)).toBeGreaterThan(0);
}

async function waitForRuntime(plugin: PalletYardPlugin): Promise<void> {
  for (let i = 0; i < 1000 && !plugin.runtime; i++) await new Promise(resolve => setTimeout(resolve, 20));
  expect(plugin.runtime, 'runtime bound after planning apply').not.toBeNull();
}

describe.skipIf(!AVAILABLE)('9.35 PalletYard STICH EXIT', () => {
  it.each([4, 2])('24 h after planning apply 2 → %s has no stranded exit', async size => {
    resetProblemsForTests();
    const planning = new PlanningParametersPlugin();
    const plugin = new PalletYardPlugin();
    const y = await loadPalletYardScene({ url: URL, before(viewer) {
      registerAllBehaviors(viewer.behaviors); viewer.use(planning); viewer.use(plugin);
    } });
    try {
      y.viewer.simulationKernel!.setMode('des');
      await Promise.resolve(); y.viewer.resetSimulation(); await waitForRuntime(plugin);
      expect(plugin.yard.size).toBe(2);
      let runner = y.viewer.simulationKernel!.desControl() as unknown as DESRunner;
      runner.setSubMode('fastforward');
      advance(runner, plugin.runtime!, 600); // apply while the original size has been running
      expect(planning.registry.set('palletYard.size', size, 'ui').ok).toBe(true);
      const applied = await planning.applyPendingAndReset();
      expect(applied.ok, JSON.stringify(applied)).toBe(true);
      await waitForRuntime(plugin);
      expect(plugin.yard.size).toBe(size);
      runner = y.viewer.simulationKernel!.desControl() as unknown as DESRunner;
      soak(runner, plugin.runtime!);
    } finally { y.dispose(); }
  }, 900_000);

  it('24 h size 2 without apply uses the M3 runner binding', async () => {
    resetProblemsForTests();
    const y = await loadPalletYardScene({ url: URL });
    const runner = new DESRunner({ subMode: 'fastforward', durationSeconds: DAY });
    let rt: YardRun | undefined;
    try {
      runner.start([], { root: y.root, host: y.host as never });
      const bound = bindDesYard({ runner, root: y.root, drives: y.drives, owners: new PluginOwnerRegistry() });
      if (!bound.ok) throw new Error(`bind: ${bound.missing.join(', ')}`);
      rt = startDesRuntime(bound.backend, () => {});
      soak(runner, rt);
    } finally { rt?.dispose(); runner.dispose(); y.dispose(); }
  }, 900_000);

  it('a breakdown during exit pauses the watchdog through a 600 s repair', async () => {
    resetProblemsForTests();
    const y = await loadPalletYardScene({ url: URL });
    const runner = new DESRunner({ subMode: 'fastforward', durationSeconds: DAY });
    let rt: YardRun | undefined;
    try {
      runner.start([], { root: y.root, host: y.host as never });
      const bound = bindDesYard({ runner, root: y.root, drives: y.drives, owners: new PluginOwnerRegistry() });
      if (!bound.ok) throw new Error(`bind: ${bound.missing.join(', ')}`);
      rt = startDesRuntime(bound.backend, () => {});
      let vehicle: VehicleProbe | undefined;
      for (let t = 0.25; t <= 3600 && !vehicle; t += 0.25) {
        advance(runner, rt, t);
        vehicle = [...probe(rt).vehicles.values()].find(v => v.exiting && getDefaultZoneRegistry().isHolder(v.exiting.zone, v.id));
      }
      expect(vehicle, dump(rt)).toBeDefined();
      const adapter = runner.liveInstances.find(i => i.def.type === 'Agv' && i.self.root.name === vehicle!.id)!.adapter;
      adapter.setFailure(true);
      const repairAt = rt.clock.now() + 600;
      for (let t = rt.clock.now() + 1; t <= repairAt; t++) {
        advance(runner, rt, t);
        expect(getProblems().filter(isExitWait), dump(rt)).toEqual([]);
      }
      adapter.setFailure(false);
      for (let t = repairAt + 1; t <= repairAt + 120; t++) advance(runner, rt, t);
      expect(getProblems().filter(isExitWait), dump(rt)).toEqual([]);
    } finally { rt?.dispose(); runner.dispose(); y.dispose(); }
  }, 900_000);

  it('a forced charging job during exit frees the old stich and ends that exit once', async () => {
    resetProblemsForTests();
    const y = await loadPalletYardScene({ url: URL });
    const runner = new DESRunner({ subMode: 'fastforward', durationSeconds: DAY });
    let rt: YardRun | undefined;
    try {
      runner.start([], { root: y.root, host: y.host as never });
      const bound = bindDesYard({ runner, root: y.root, drives: y.drives, owners: new PluginOwnerRegistry() });
      if (!bound.ok) throw new Error(`bind: ${bound.missing.join(', ')}`);
      rt = startDesRuntime(bound.backend, () => {});
      let vehicle: VehicleProbe | undefined;
      for (let t = 0.25; t <= 3600 && !vehicle; t += 0.25) {
        advance(runner, rt, t);
        vehicle = [...probe(rt).vehicles.values()].find(v => v.exiting && getDefaultZoneRegistry().isHolder(v.exiting.zone, v.id));
      }
      expect(vehicle, dump(rt)).toBeDefined();
      const v = vehicle!;
      const exit = v.exiting!;
      const internal = probe(rt);
      let ended = 0;
      const original = internal.endExit.bind(rt);
      const spy = vi.spyOn(internal, 'endExit').mockImplementation(current => {
        if (current === v) ended++;
        original(current);
      });
      try {
        const charger = yardConfigOf(rt).stations.find(s => s.kind === 'charger')!;
        internal.startJob(v, { kind: 'charge', vehicle: v.id, charger: charger.id, untilSoc: 1, durationSec: 600 });
        const end = rt.clock.now() + STICH_EXIT_LIMIT_SEC + 5;
        for (let t = rt.clock.now() + 0.25; t <= end; t += 0.25) advance(runner, rt, t);
        expect(getDefaultZoneRegistry().isHolder(exit.zone, v.id), dump(rt)).toBe(false);
        expect(ended, dump(rt)).toBe(1);
        expect(v.exiting, dump(rt)).not.toBe(exit);
        expect(getProblems().filter(isExitWait), dump(rt)).toEqual([]);
      } finally { spy.mockRestore(); }
    } finally { rt?.dispose(); runner.dispose(); y.dispose(); }
  }, 900_000);
});
