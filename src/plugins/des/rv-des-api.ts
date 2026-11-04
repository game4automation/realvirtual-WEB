// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-des-api.ts -- Static convenience API for DES operations.
 *
 * Provides a global DES namespace with shorthand methods that delegate
 * to the active DESManager singleton. This allows user code to write:
 *
 *   DES.in(5.0, 'Station.ProcessComplete', this, mu)
 *   DES.at(100.0, 'Source.Generate', this)
 *   if (DES.now > 3600) { ... }
 *
 * The active manager must be set via DES.setManager() before use
 * (done automatically by the DES runner on init).
 */

import type { DESManager, IDESComponent, IDESMU } from './rv-des-manager';

/** Singleton reference to the active DESManager. */
let _manager: DESManager | null = null;

function requireManager(): DESManager {
  if (!_manager) {
    throw new Error('DES: no active manager. Ensure the DES runner is initialized.');
  }
  return _manager;
}

/**
 * Static DES convenience API.
 */
export const DES = {
  // ── Manager lifecycle ──

  /** Set the active DESManager (called by the DES runner). */
  setManager(manager: DESManager | null): void {
    _manager = manager;
  },

  /** Get the active DESManager (or null). */
  getManager(): DESManager | null {
    return _manager;
  },

  // ── Time ──

  /** Current simulation time in seconds. */
  get now(): number {
    return _manager?.currentTime ?? 0;
  },

  // ── Scheduling ──

  /**
   * Schedule an event at an absolute simulation time.
   *
   * @param time - Absolute simulation time (seconds)
   * @param actionName - Registered Named Action string
   * @param component - Owning component (or entityId number)
   * @param mu - Associated MU (or muId number, or null)
   * @param priority - Higher fires first at same time (default 0)
   * @param data - Optional JSON-serializable payload
   * @returns Event ID for cancellation
   */
  at(
    time: number,
    actionName: string,
    component: IDESComponent | number,
    mu?: IDESMU | number | null,
    priority = 0,
    data: unknown = null,
  ): number {
    const m = requireManager();
    const entityId = typeof component === 'number' ? component : component.entityId;
    const muId = mu == null ? -1 : typeof mu === 'number' ? mu : mu.id;
    return m.scheduleEvent(time, actionName, entityId, muId, priority, data);
  },

  /**
   * Schedule an event relative to the current simulation time.
   *
   * @param delay - Delay in seconds from now
   * @param actionName - Registered Named Action string
   * @param component - Owning component (or entityId number)
   * @param mu - Associated MU (or muId number, or null)
   * @param priority - Higher fires first at same time (default 0)
   * @param data - Optional JSON-serializable payload
   * @returns Event ID for cancellation
   */
  in(
    delay: number,
    actionName: string,
    component: IDESComponent | number,
    mu?: IDESMU | number | null,
    priority = 0,
    data: unknown = null,
  ): number {
    const m = requireManager();
    const entityId = typeof component === 'number' ? component : component.entityId;
    const muId = mu == null ? -1 : typeof mu === 'number' ? mu : mu.id;
    return m.scheduleIn(delay, actionName, entityId, muId, priority, data);
  },

  /**
   * Cancel a scheduled event by ID.
   * @returns true if the event was found and cancelled
   */
  cancel(eventId: number): boolean {
    return _manager?.cancelEvent(eventId) ?? false;
  },

  // ── Simulation control ──

  /** Pause the simulation. */
  pause(): void {
    _manager?.pause();
  },

  /** Resume the simulation. */
  resume(): void {
    _manager?.resume();
  },

  /** Reset the simulation to time 0. */
  reset(): void {
    _manager?.reset();
  },

  /** True when the simulation has completed (past duration or empty queue). */
  get isComplete(): boolean {
    return _manager?.isComplete ?? true;
  },

  /** True when the simulation is paused. */
  get isPaused(): boolean {
    return _manager?.isPaused ?? false;
  },

  /** Total number of events processed since last reset. */
  get totalEventsProcessed(): number {
    return _manager?.totalEventsProcessed ?? 0;
  },

  // ── Component / MU access ──

  /**
   * Get a component by hierarchy path.
   * Returns null if not found.
   */
  getComponent<T extends IDESComponent = IDESComponent>(path: string): T | null {
    return (_manager?.getComponentByPath(path) as T) ?? null;
  },

  /**
   * Get an MU by integer ID.
   * Returns null if not found.
   */
  getMU(muId: number): IDESMU | null {
    return _manager?.getMU(muId) ?? null;
  },
};
