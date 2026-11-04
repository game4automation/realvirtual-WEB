// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { YardKpiRun, fleetKpiParticipant } from './yard-order-kpis';
import type { FleetSceneBinder } from '@rv/plugins/fleet-plugin';
import { clearProblem, reportProblem } from '@rv/core/hmi/problems-store';
import { findByNameInSubtree } from '@rv/core/engine/rv-traverse-utils';
import { FleetStatusOutput, type StatusSignalSink } from '@rv/core/fleet/exec/status-output';
import type { OrderSignalStore } from '@rv/core/fleet/exec/order-request';
import { PluginOwnerRegistry } from '@rv/plugins/des/fleet/des-handover';
import { NO_ACTIVE_AGV_PROBLEM_CODE, readActiveYardVehicles } from './active-vehicles';
import { bindContinuousYard } from './continuous-bind';
import { bindDesYard, createYardRun, yardConfigOf, yardChargingView, reportSnapshotProblem, BIND_PROBLEM_CODE } from './yard-runtime';
import { ChargerLabels, type ChargingView } from './charger-label';
import type { YardPlanning } from './yard-planning';
import { registerPalletYardSchema } from './yard-schema';

/** Thin calls into the existing bind functions; geometry and planning remain project-owned. */
export function createYardBinder(planning: YardPlanning, labels = new ChargerLabels()): FleetSceneBinder {
  registerPalletYardSchema();
  let charging: ChargingView | null = null;
  let lastMissing = '';
  // Own the DES owner registry here, not in FleetPlugin (plan-680 §9: startup code reaches DES
  // only through the on-demand workspace shell, never a static import of the body) — one per
  // binder so rebinds on the same manager still reuse the owners.
  const owners = new PluginOwnerRegistry();
  // The active vehicles the current binding was made with (plan-630 6b): a reset rebinds only when
  // `Agv.Active` changed since — otherwise the reset is exactly the old one.
  let bound: { root: Parameters<typeof readActiveYardVehicles>[0]; ids: string[] } | null = null;
  return {
    snapshotParticipants: runtime => runtime instanceof YardKpiRun ? [fleetKpiParticipant(runtime.orderKpis)] : [],
    rebindOnReset: () => {
      if (!bound) return false;
      const now = readActiveYardVehicles(bound.root, planning.currentConfig().vehicles);
      return now.length !== bound.ids.length || now.some((id, i) => id !== bound!.ids[i]);
    },
    bindDes: ({ runner, root, viewer }) => bindDesYard({
      runner, root, drives: viewer.drives, owners, cfg: planning.currentConfig(), geometry: planning.yard.geometry,
    }),
    bindContinuous: ({ root, viewer }) => bindContinuousYard({
      root, transportManager: viewer.transportManager, drives: viewer.drives,
      simTime: () => viewer.simTime, signals: viewer.signalStore ?? null, cfg: planning.currentConfig(),
    }),
    createRun: (adapters, ctx) => createYardRun(adapters, {
      cfg: planning.currentConfig(), yard: planning.yard, definition: ctx.definition,
      signals: ctx.viewer.signalStore as (StatusSignalSink & OrderSignalStore) | null,
    }),
    reconfigure: (runtime, config) => {
      const cfg = yardConfigOf(runtime);
      if (config.pauses) { Object.assign(cfg.shippingPauses, structuredClone(config.pauses)); runtime.replanPauses(); }
      if (config.takts) {
        const picks = cfg.stations.filter(s => s.kind === 'pick');
        const intervals = cfg.production.intervalPerOutput ??= picks.map(() => cfg.production.intervalSec);
        for (const takt of config.takts) {
          const i = picks.findIndex(s => s.id === takt.station);
          if (i < 0) continue;
          intervals[i] = takt.intervalSec;
          if (takt.startSec !== undefined) cfg.production.phaseSec[i] = takt.startSec;
          runtime.retimeTakt(i);
        }
      }
    },
    onBound: (runtime, { viewer, root }) => {
      bound = { root, ids: readActiveYardVehicles(root, planning.currentConfig().vehicles) };
      lastMissing = '';
      clearProblem(BIND_PROBLEM_CODE);
      charging = yardChargingView(runtime, planning.yard.geometry);
      labels.attach(viewer.scene, findByNameInSubtree(root, 'PalletYardRoot') ?? root);
    },
    onFrame: () => { if (charging) labels.update(charging); },
    onReset: () => labels.clear(),
    onUnbind: () => { labels.detach(); charging = null; owners.clear(); bound = null; },
    reportSnapshot: reportSnapshotProblem,
    reportBindGap: (missing, { root }) => {
      const key = missing.join(',');
      if (key === lastMissing) return;
      lastMissing = key;
      if (missing.includes(NO_ACTIVE_AGV_PROBLEM_CODE)) clearProblem(BIND_PROBLEM_CODE);
      else reportProblem({ id: BIND_PROBLEM_CODE, severity: 'warning', code: BIND_PROBLEM_CODE,
        title: 'PalletYard: scene incomplete — the yard does not run', detail: `Missing: ${missing.join(', ')}.` });
      const lamps = new FleetStatusOutput(null);
      const found = planning.yard.config.vehicles.map(id => ({ id, root: findByNameInSubtree(root, id) }));
      lamps.scan(found);
      for (const f of found) lamps.apply(f.id, { free: false, orderActive: false, busy: false, handling: false, charging: false, fault: true, moving: false }, 0);
    },
  };
}
