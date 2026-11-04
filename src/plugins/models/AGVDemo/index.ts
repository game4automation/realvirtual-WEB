// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
/**
 * DiscreteEventSimulation — TypeScript fleet-logic example (plan-921).
 *
 * Demonstrates the LOW-LEVEL AGV control surface from a project plugin (the
 * full-TypeScript alternative to JS-in-GLB scripts): a minimal round-robin
 * "Arbeitsplan" that sends every vehicle around the AGVDemo oval with a
 * service stop at each straight, plus a dock-bound station that decides its
 * own handling time on the east-curve exit.
 *
 * The three seams used here are THE seams every project fleet logic builds on:
 *   - `getDefaultAgvFleet()`   — assign tasks {destination, serviceSec,
 *     onArrive, onServiceEnd}; chain the next task inside onServiceEnd.
 *   - `getDefaultPathDockRegistry()` — a station bound to a path segment
 *     controls the stay itself (release() when done) — also the adapter a
 *     conveyor end would use.
 *   - `getDefaultPathNetwork().setRouter(...)` — (not used here) full junction
 *     control for congestion-aware routing.
 */

import type { RVViewer } from '@rv/core/rv-viewer';
import { getDefaultAgvFleet, type AgvTask } from '@rv/core/engine/rv-agv-fleet';
import { getDefaultPathDockRegistry } from '@rv/core/engine/rv-path-dock';

import { ACTION_INDEX, registerAction } from '@rv/plugins/des/rv-des-named-actions';
import type { DESRunner } from '@rv/plugins/des/des-runner';

const DOCK_RELEASE_ACTION = 'AGVDemo.DockRelease';
if (!ACTION_INDEX.has(DOCK_RELEASE_ACTION)) registerAction(DOCK_RELEASE_ACTION, ctx => {
  // The stay epoch guards an abandoned stay: a late event must not end a LATER stay of the vehicle.
  const { agvId, epoch } = ctx.data as { agvId: string; epoch: number };
  getDefaultAgvFleet().get(agvId)?.releaseStay?.(epoch);
}, { owner: 'AGVDemo', payload: data => {
  return data !== null && typeof data === 'object' && !Array.isArray(data)
    && Object.keys(data).length === 2 && typeof data.agvId === 'string' && Number.isSafeInteger(data.epoch)
    ? [] : ['expected {agvId:string, epoch:integer}'];
} });

/** Model filenames (without .glb) this module handles. */
export const models = ['AGVCourse', 'Course'];

/** The work plan IS the simulation logic — keep it registered in DES mode. */
export const runInAuthoringModes = ['des'];

/** The work plan: each vehicle cycles these stops forever. */
const STOPS: Array<{ destination: string; serviceSec: number }> = [
  { destination: 'PathSouth', serviceSec: 2 },
  { destination: 'PathNorth', serviceSec: 1 },
];

let disposers: Array<() => void> = [];

/** Handling time of the east-curve station (simulation seconds). */
const EAST_SERVICE_SEC = 1.5;
/** Id of the tick plugin that ends continuous-mode stays on simulation time. */
const DOCK_CLOCK_PLUGIN_ID = 'agv-course-dock-clock';

/**
 * Continuous-mode stays in flight: released once the simulation clock reaches
 * `due` (checked every fixed tick). A reset / start drops them with the run
 * (plan-2006 LOW #30: the handling time is simulation time, never a wall-clock
 * timer — it scales with the speed, stands still while paused, runs in DES).
 */
let pendingStays: Array<{ due: number; release: () => void }> = [];

function taskFor(agvId: string, index: number): AgvTask {
  const stop = STOPS[index % STOPS.length];
  return {
    ...stop,
    data: { example: 'AGVDemo', agvId, index },
    onServiceEnd: () => {
      // Chain the next stop — a real project would pull the next order here.
      getDefaultAgvFleet().get(agvId)?.assign(taskFor(agvId, index + 1));
    },
  };
}

export function registerModelPlugins(viewer: RVViewer): void {
  const fleet = getDefaultAgvFleet();
  const docks = getDefaultPathDockRegistry();
  disposers.push(fleet.registerTaskCodec({
    owns: task => {
      const data = task.data as { example?: string; agvId?: string } | undefined;
      return data?.example === 'AGVDemo' && typeof data.agvId === 'string' && !!fleet.get(data.agvId);
    },
    validate: (task, vehicleId) => {
      const data = task.data as { agvId: string; index: number };
      if (data.agvId !== vehicleId) return 'task vehicle differs from owner';
      if (!Number.isSafeInteger(data.index) || data.index < 0) return 'invalid task continuation';
      const expected = taskFor(data.agvId, data.index);
      return task.destination === expected.destination && task.serviceSec === expected.serviceSec
        ? null : 'task differs from work plan';
    },
    attach: task => {
      const data = task.data as { agvId: string; index: number };
      task.onServiceEnd = taskFor(data.agvId, data.index).onServiceEnd;
    },
    exportData: data => ({ ...(data as { example: string; agvId: string; index: number }) }),
  }));

  const registeredRunners = new WeakSet<DESRunner>();
  const registerOwner = (runner: DESRunner): void => {
    if (registeredRunners.has(runner)) return;
    disposers.push(runner.registerSnapshotProvider('AGVDemo', () => [{
      key: 'AGVDemo', version: 1, owner: {}, stateKeys: [],
      capture: () => ({}),
      validate: state => state !== null && typeof state === 'object' && !Array.isArray(state)
        && Object.keys(state).length === 0 ? [] : ['expected empty AGVDemo state'],
      prepare: () => ({}), commit: () => {},
    }]));
    registeredRunners.add(runner);
  };
  const initialDes = viewer.simulationKernel?.desControl();
  if (initialDes) registerOwner(initialDes as DESRunner);

  // Station adapter: the EAST curve exit services every passing vehicle for
  // 1.5 s of simulation time — the STATION owns the time, not the vehicle's task.
  // DES: one runner callback (exact event order, FastForward too; a reset drops it).
  // Continuous: released by the fixed tick once the simulation clock is there.
  disposers.push(docks.register('PathEast', {
    onVehicleArrive: (agvId, release) => {
      // stand-in for real handling (MU load, PLC, …)
      const due = viewer.simTime + EAST_SERVICE_SEC;
      const des = viewer.simulationKernel?.desControl() ?? null;
      if (des?.scheduleCallback) {
        const runner = des as DESRunner;
        registerOwner(runner);
        runner.getManager().scheduleEvent(Math.max(runner.getManager().currentTime, due), DOCK_RELEASE_ACTION, -1, -1, 0,
          { agvId, epoch: getDefaultAgvFleet().get(agvId)?.stayEpoch?.() ?? -1 });
        return;
      }
      pendingStays.push({ due, release });
    },
  }));
  viewer.use({
    id: DOCK_CLOCK_PLUGIN_ID,
    onFixedUpdatePost: () => {
      if (pendingStays.length === 0) return;
      const now = viewer.simTime;
      const due = pendingStays.filter((p) => p.due <= now);
      if (due.length === 0) return;
      pendingStays = pendingStays.filter((p) => p.due > now);
      for (const p of due) p.release();
    },
  });
  disposers.push(() => viewer.removePlugin(DOCK_CLOCK_PLUGIN_ID));
  disposers.push(viewer.on('simulation-reset', () => { pendingStays = []; }));

  // Kick the work plan once the simulation starts (and after every reset).
  const start = (): void => {
    let i = 0;
    for (const agv of fleet.all()) agv.assign(taskFor(agv.id, i++));
  };
  disposers.push(viewer.on('simulation-start', () => { pendingStays = []; start(); }));
}

export function unregisterModelPlugins(): void {
  // Pending stays first: a disposer may tear down the fleet a release() would reach for.
  pendingStays = [];
  for (const d of disposers) { try { d(); } catch { /* ignore */ } }
  disposers = [];
}
