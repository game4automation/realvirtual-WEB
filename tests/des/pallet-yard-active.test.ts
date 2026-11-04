// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it } from 'vitest';
import { getProblems, clearProblem } from '@rv/core/hmi/problems-store';
import { bindDesYard, startDesRuntime, yardConfigOf } from '@rv/plugins/models/PalletYard/yard-runtime';
import { activeYardVehicles, NO_ACTIVE_AGV_PROBLEM_CODE } from '@rv/plugins/models/PalletYard/active-vehicles';
import { PALLET_YARD_CONFIG } from '@rv/plugins/models/PalletYard/layout';
import { buildYard } from './pallet-yard-harness';
import { loadContinuousYard } from './pallet-yard-continuous-scene';
import { devAssetAvailable } from '../fixtures/dev-asset-available';
import { PALLET_YARD_URL } from './pallet-yard-scene-load';

const problem = () => getProblems().find(p => p.code === NO_ACTIVE_AGV_PROBLEM_CODE);

describe('PalletYard active vehicles in DES', () => {
  it('snapshots availability, keeps config order and SOC, blocks an empty run and recovers', () => {
    const w = buildYard('fastforward');
    const ids = [...PALLET_YARD_CONFIG.vehicles];
    const cfg = structuredClone(PALLET_YARD_CONFIG);
    cfg.battery.startSoc = [81, 82, 83];
    const bind = () => bindDesYard({ runner: w.runner, root: w.root,
      drives: ids.map(id => w.vehicle(id).lift), cfg, owners: w.owners });
    try {
      expect(activeYardVehicles(w.root, ids)).toEqual(ids);
      expect(w.rt.vehicleIds).toEqual(ids);
      w.rt.prepareReset();
      w.rt.dispose();
      w.runner.reset();
      w.runner.setSubMode('fastforward');
      w.vehicle(ids[1]).root.userData.realvirtual.Agv.Active = false;
      const bound = bind();
      expect(bound.ok).toBe(true);
      if (!bound.ok) throw new Error(bound.missing.join(', '));
      expect(bound.backend.vehicleNode(ids[1])).toBeNull();
      // A property edit after binding must not change this run's snapshot.
      w.vehicle(ids[1]).root.userData.realvirtual.Agv.Active = true;
      const rt = startDesRuntime(bound.backend, undefined, { cfg });
      w.rt = rt;
      w.backend = bound.backend;
      try {
        expect(rt.vehicleIds).toEqual([ids[0], ids[2]]);
        expect(yardConfigOf(rt).vehicles).toEqual(ids);
        expect(rt.socAt(ids[2])).toBe(83);
        w.runTo(600);
        expect(rt.jobLog.length).toBeGreaterThan(0);
        expect(rt.jobLog.every(j => !j.startsWith(`${ids[1]}:`))).toBe(true);
      } finally { rt.dispose(); }
      for (const id of ids) w.vehicle(id).root.userData.realvirtual.Agv.Active = false;
      expect(bind()).toEqual({ ok: false, missing: [NO_ACTIVE_AGV_PROBLEM_CODE], pending: false });
      expect(problem()?.severity).toBe('warning');
      w.vehicle(ids[2]).root.userData.realvirtual.Agv.Active = true;
      const recovered = bind();
      expect(recovered.ok).toBe(true);
      expect(problem()).toBeUndefined();
      if (recovered.ok) recovered.backend.dispose();
      expect(cfg.vehicles).toEqual(ids);
    } finally { w.dispose(); clearProblem(NO_ACTIVE_AGV_PROBLEM_CODE); }
  });
});

const AVAILABLE = await devAssetAvailable(PALLET_YARD_URL);
describe.skipIf(!AVAILABLE)('PalletYard active vehicles in continuous mode', () => {
  it('rebuilds the plugin run on reset, excludes inactive maps/orders, blocks and recovers', async () => {
    const y = await loadContinuousYard({ plugin: true });
    const ids = [...yardConfigOf(y.rt).vehicles];
    const setActive = (id: string, active: boolean) => {
      const node = y.root.getObjectByName(id);
      expect(node).toBeTruthy();
      node!.userData.realvirtual.Agv.Active = active;
    };
    try {
      expect(y.rt.vehicleIds).toEqual(ids);
      setActive(ids[1], false);
      expect(y.rt.vehicleIds).toEqual(ids);
      y.viewer.resetSimulation();
      y.tick(2);
      expect(y.rt.vehicleIds).toEqual([ids[0], ids[2]]);
      expect(y.be.vehicleNode(ids[1])).toBeNull();
      expect(yardConfigOf(y.rt).vehicles).toEqual(ids);
      y.runTo(600);
      expect(y.rt.jobLog.length).toBeGreaterThan(0);
      expect(y.rt.jobLog.every(j => !j.startsWith(`${ids[1]}:`))).toBe(true);
      for (const id of ids) setActive(id, false);
      y.viewer.resetSimulation();
      y.tick(2);
      expect(y.plugin!.runtime).toBeNull();
      expect(problem()?.detail).toBe('No active AGV — the pallet yard cannot run. Switch Active on for at least one vehicle and reset.');
      setActive(ids[2], true);
      y.viewer.resetSimulation();
      y.tick(2);
      expect(y.rt.vehicleIds).toEqual([ids[2]]);
      expect(problem()).toBeUndefined();
    } finally { y.dispose(); clearProblem(NO_ACTIVE_AGV_PROBLEM_CODE); }
  }, 480_000);
});
