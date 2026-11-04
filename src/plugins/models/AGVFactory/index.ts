// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
/**
 * AGVFactory — work plan for scenes/AGVFactory.glb.
 *
 * Four AGVs share a main oval with a loading spur (north, outside) and three
 * work-station sidings (WS1/WS2 south, WS3 north). Each vehicle alternates two
 * products, every order starting at the loading station:
 *   - Product A: Load → WS1 → WS3
 *   - Product B: Load → WS2 → WS3
 * Routing is the Agv's own shortest hop toward the task destination; a station
 * segment holds one vehicle (segment occupancy), the LoadQueue lane buffers one
 * more in front of the loading station. Service times are task `serviceSec`, so
 * they run on SIMULATION time in both kernels (no wall-clock timers).
 */

import type { DESRunner } from '@rv/plugins/des/des-runner';
import type { RVViewer } from '@rv/core/rv-viewer';
import { getDefaultAgvFleet, type AgvTask } from '@rv/core/engine/rv-agv-fleet';

/** The work plan IS the simulation logic — keep it registered in DES mode. */
export const runInAuthoringModes = ['des'];

/** Stops per product: destination path id + service time in seconds. */
const ROUTES: Record<'A' | 'B', Array<{ destination: string; serviceSec: number }>> = {
  A: [
    { destination: 'Load', serviceSec: 4 },
    { destination: 'WS1', serviceSec: 8 },
    { destination: 'WS3', serviceSec: 5 },
  ],
  B: [
    { destination: 'Load', serviceSec: 4 },
    { destination: 'WS2', serviceSec: 8 },
    { destination: 'WS3', serviceSec: 5 },
  ],
};

/** Order sequence per vehicle — A and B alternate, offset per vehicle. */
function productFor(order: number): 'A' | 'B' {
  return order % 2 === 0 ? 'A' : 'B';
}

let disposers: Array<() => void> = [];
/** Next order number per vehicle — survives a re-bind (new handle, same id). */
const orderState = { nextOrder: new Map<string, number>() };

function taskFor(agvId: string, order: number, step: number): AgvTask {
  const route = ROUTES[productFor(order)];
  return {
    ...route[step],
    data: { example: 'AGVFactory', agvId, order, step },
    onServiceEnd: () => {
      const last = step + 1 >= route.length;
      if (last) orderState.nextOrder.set(agvId, order + 1);
      getDefaultAgvFleet().get(agvId)?.assign(last ? taskFor(agvId, order + 1, 0) : taskFor(agvId, order, step + 1));
    },
  };
}

/**
 * Give every vehicle without a task its next order. Idempotent, so it is safe
 * to call from every lifecycle point: the vehicles are bound after the plugin
 * registers, and the DES runner re-binds them (fresh handles, no task) after
 * `scene-loaded` and on every reset.
 */
function dispatchIdle(): void {
  const fleet = getDefaultAgvFleet();
  fleet.all().forEach((agv, i) => {
    if (agv.task) return;
    if (!orderState.nextOrder.has(agv.id)) orderState.nextOrder.set(agv.id, i); // offset: A/B alternate across vehicles
    agv.assign(taskFor(agv.id, orderState.nextOrder.get(agv.id)!, 0));
  });
}

export function registerModelPlugins(viewer: RVViewer): void {
  const fleet = getDefaultAgvFleet();
  disposers.push(fleet.registerTaskCodec({
    owns: task => {
      const data = task.data as { example?: string; agvId?: string } | undefined;
      return data?.example === 'AGVFactory' && typeof data.agvId === 'string' && !!fleet.get(data.agvId);
    },
    validate: (task, vehicleId) => {
      const data = task.data as { agvId: string; order: number; step: number };
      if (data.agvId !== vehicleId) return 'task vehicle differs from owner';
      if (!Number.isSafeInteger(data.order) || data.order < 0 || !Number.isInteger(data.step) || data.step < 0 || data.step >= ROUTES[productFor(data.order)].length) return 'invalid task continuation';
      const expected = taskFor(data.agvId, data.order, data.step);
      return task.destination === expected.destination && task.serviceSec === expected.serviceSec
        ? null : 'task differs from work plan';
    },
    attach: task => {
      const data = task.data as { agvId: string; order: number; step: number };
      task.onServiceEnd = taskFor(data.agvId, data.order, data.step).onServiceEnd;
    },
    exportData: data => ({ ...(data as { example: string; agvId: string; order: number; step: number }) }),
  }));
  const registered = new WeakSet<DESRunner>();
  const registerOwner = (): void => {
    const runner = viewer.simulationKernel?.desControl() as DESRunner | null | undefined;
    if (!runner || registered.has(runner)) return;
    disposers.push(runner.registerSnapshotProvider('AGVFactory', () => [{
      key: 'AGVFactory', version: 1, owner: orderState, stateKeys: ['nextOrder'],
      capture: () => [...orderState.nextOrder].sort(([a], [b]) => a.localeCompare(b)),
      validate: state => {
        const rows = state as unknown;
        return Array.isArray(rows) && rows.every(row => Array.isArray(row) && row.length === 2
          && typeof row[0] === 'string' && Number.isSafeInteger(row[1]) && (row[1] as number) >= 0)
          && new Set(rows.map(row => (row as unknown[])[0])).size === rows.length ? [] : ['expected unique [agvId, order] entries'];
      },
      prepare: state => new Map(state as Array<[string, number]>),
      commit: prepared => { orderState.nextOrder = prepared as Map<string, number>; },
    }]));
    registered.add(runner);
  };
  registerOwner();
  disposers.push(viewer.on('simulation-run-started', registerOwner));

  let watchdog: ReturnType<typeof setInterval> | undefined;
  const dispatch = (): void => {
    registerOwner();
    dispatchIdle();
    if (fleet.all().some(agv => agv.task) && watchdog !== undefined) {
      clearInterval(watchdog);
      watchdog = undefined;
    }
  };
  const restart = (): void => { orderState.nextOrder = new Map(); dispatch(); };
  disposers.push(viewer.on('simulation-start', restart));
  disposers.push(viewer.on('scene-loaded', dispatch));
  disposers.push(viewer.on('simulation-run-started', dispatch));
  // Only bridge the first bind. Once dispatched, lifecycle events own later work;
  // wall time must not dispatch orders behind a DES snapshot's back.
  watchdog = setInterval(dispatch, 500);
  disposers.push(() => { if (watchdog !== undefined) clearInterval(watchdog); });
}

export function unregisterModelPlugins(): void {
  for (const d of disposers) { try { d(); } catch { /* ignore */ } }
  disposers = [];
  orderState.nextOrder = new Map();
}
