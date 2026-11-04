// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-traffic-registries.ts — ONE reset point for the AGV traffic world
 * (plan-647 D1, LOP #214).
 *
 * The traffic world lives in module-wide singletons: path network, zones,
 * spacing controller, dock registry, the two movement authorities (DES and
 * continuous, with the continuous event clock) and the fleet. They are NOT
 * scoped to a model, so somebody has to empty them when a model goes —
 * otherwise the next model routes over the paths of the previous one
 * (`successors` resolving onto old paths, `net.get(oldId)` returning old
 * objects).
 *
 * {@link resetTrafficRegistries} is that somebody, and the ONLY one:
 *  - `RVViewer.clearModel()` calls it as its LAST step, after
 *    `emit('model-cleared')` — the behaviour teardowns run synchronously in
 *    that emit and release their own entries against still-filled registries
 *    first; the reset then drops whatever no teardown owned (direct path
 *    registrations, plugin docks, waiters);
 *  - the embed reset (`resetEmbedEngineRegistries`) delegates to it;
 *  - the test helper `clearShared()` delegates to it (plus the subscriber
 *    drop of `AgvFleet.clear()` that only tests want).
 *
 * What survives on purpose: listeners (network path-changed listeners, zone
 * availability listeners, fleet subscribers) — they belong to plugins and
 * authorities that outlive a model. `resetSimulation()` does NOT call this:
 * a simulation reset keeps the model and therefore its paths.
 */

import { getDefaultPathNetwork } from './rv-path-network';
import { getDefaultZoneRegistry } from './rv-zone-registry';
import { getDefaultSpacingController } from './rv-spacing-controller';
import { getDefaultPathDockRegistry } from './rv-path-dock';
import { getDefaultMovementAuthority } from './rv-movement-authority';
import { getDefaultAgvFleet } from './rv-agv-fleet';

/**
 * Extra resets that belong to the traffic world but live outside the engine —
 * the Agv behaviour's diagnostics (merge-entry check statistics, fleet step
 * counters). The engine must not import the behaviour (the embed bundle has no
 * behaviours), so the owner registers them here: `RVViewer` registers the Agv
 * diagnostics, the test helper resets them itself. A Set, so registering the
 * same function twice (several viewers) runs it once.
 */
const extraResets = new Set<() => void>();

/** The kernel whose vehicle instances may own traffic ids (plan-648). */
export type TrafficKernel = 'continuous' | 'des';

/**
 * The ACTIVE traffic kernel (plan-648 §2.1): exactly the vehicle instances of
 * this kernel may acquire a vehicle id in fleet, spacing, zones and planner.
 * `null` = unbound (no `SimulationKernel` set a mode — direct `DESRunner` use in
 * tests, or between a model clear and the next kernel): every instance may
 * acquire, the first one wins. `SimulationKernel` sets it in its constructor
 * and on every mode switch; {@link resetTrafficRegistries} drops it to `null`.
 */
let activeTrafficKernel: TrafficKernel | null = null;

/** The active traffic kernel (plan-648) — `null` = unbound. */
export function getActiveTrafficKernel(): TrafficKernel | null {
  return activeTrafficKernel;
}

/** Set the active traffic kernel (plan-648) — `SimulationKernel` only (constructor, `setMode`). */
export function setActiveTrafficKernel(kernel: TrafficKernel | null): void {
  activeTrafficKernel = kernel;
}

/** Register an additional reset that {@link resetTrafficRegistries} runs. Returns the unregister function. */
export function onTrafficRegistriesReset(reset: () => void): () => void {
  extraResets.add(reset);
  return () => { extraResets.delete(reset); };
}

/** Sizes of every traffic registry (plan-647 F5) — internal, for tests and diagnosis. */
export interface TrafficRegistryStats {
  /** Registered paths in the network. */
  paths: number;
  /** Known zones (declared, ensured or claimed). */
  zones: number;
  /** Claims over all zones. */
  zoneHolders: number;
  /** Travelers in the spacing controller. */
  spacing: number;
  /** Bound path docks. */
  docks: number;
  /** Vehicles registered in each movement authority. */
  authorityVehicles: { des: number; continuous: number };
  /** Scheduled, not yet run events of the authorities' event clocks. */
  pendingClockEvents: number;
  /** Fleet handles. */
  fleetHandles: number;
}

/**
 * Empty every traffic registry for the next model (plan-647 D1): network,
 * zones (with declarations and claims), spacing, docks, both movement
 * authorities (with the clock), the fleet HANDLES (subscribers stay — D2) and
 * the registered extra resets (the Agv diagnostics: merge-entry check
 * statistics, fleet step counters, the vehicle-id ownership — see
 * {@link onTrafficRegistriesReset}), and the active traffic kernel goes back
 * to `null` (plan-648).
 * O(registry size); never called per tick.
 */
export function resetTrafficRegistries(): void {
  getDefaultPathNetwork().clear();
  getDefaultZoneRegistry().clear();
  getDefaultSpacingController().clear();
  getDefaultPathDockRegistry().clear();
  getDefaultMovementAuthority('des').clear();
  getDefaultMovementAuthority('continuous').clear();
  getDefaultAgvFleet().resetHandles();
  activeTrafficKernel = null; // plan-648: the next kernel sets its mode anew
  for (const reset of extraResets) {
    try { reset(); } catch (e) { console.error('[traffic-registries] reset hook failed:', e); }
  }
}

/** Current sizes of every traffic registry (plan-647 F5). Read only. */
export function trafficRegistryStats(): TrafficRegistryStats {
  const des = getDefaultMovementAuthority('des');
  const continuous = getDefaultMovementAuthority('continuous');
  const zones = getDefaultZoneRegistry();
  return {
    paths: getDefaultPathNetwork().size,
    zones: zones.size,
    zoneHolders: zones.totalHolderCount(),
    spacing: getDefaultSpacingController().size,
    docks: getDefaultPathDockRegistry().size,
    authorityVehicles: { des: des.size, continuous: continuous.size },
    pendingClockEvents: des.clock.pendingCount + continuous.clock.pendingCount,
    fleetHandles: getDefaultAgvFleet().size,
  };
}

/** Subscriber counts of the traffic registries (plan-645 N3) — internal, for tests and diagnosis. */
export interface TrafficListenerStats {
  /** Availability subscribers of the zone registry (survive {@link resetTrafficRegistries}). */
  zoneListeners: number;
}

/**
 * Current subscriber counts (plan-645 N3). Kept apart from
 * {@link trafficRegistryStats} on purpose: subscribers survive a reset by
 * design (D2), so they are not part of the "empty after reset" sizes. A test
 * compares the count before a run and after its dispose — a forgotten
 * unsubscribe (e.g. a runtime that was never disposed) shows as a difference.
 */
export function trafficListenerStats(): TrafficListenerStats {
  return { zoneListeners: getDefaultZoneRegistry().listenerCount };
}
