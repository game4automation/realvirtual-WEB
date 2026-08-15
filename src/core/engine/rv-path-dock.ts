// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-path-dock.ts — the generic PATH ↔ STATION adapter (plan-921).
 *
 * A dock binds ANY handling endpoint to the END of a path segment: a DES
 * work station, a conveyor head/tail, a charging bay, project code. The dock
 * — not the vehicle — defines what happens there ("die Arbeitsstation
 * definiert selbst, was sie macht"):
 *
 *   registerDock('StationPath7', {
 *     onVehicleArrive(agvId, release) {
 *       // ... start handling: own timer, DES event, MU handshake, PLC wait …
 *       somethingAsync().then(release);   // release() → the vehicle drives on
 *     },
 *   });
 *
 * Semantics (deliberately simple):
 * - A dock acts on EVERY vehicle that completes the linked segment — exactly
 *   like a station on a conveyor line handles every part that reaches it.
 *   Place docks on dedicated station/stub segments (or on through segments
 *   where every vehicle must be serviced).
 * - The vehicle stops hard at the segment end, `onVehicleArrive` fires with a
 *   `release` callback; until `release()` is called the vehicle holds
 *   (continuous: parked; DES: no next leg scheduled). `release` is idempotent.
 * - A dock OVERRIDES the task's own `serviceSec` at that segment (the station
 *   knows its handling time better than the fleet order does). Task callbacks
 *   (`onArrive` / `onServiceEnd`) still fire around the stay.
 *
 * The registry is engine-level and dumb — mirror of the zone registry: docks
 * register per path id; the Agv asks `dockAt(pathId)` at segment completion.
 */

export interface PathDock {
  /** Optional stable id for diagnostics (defaults to the path id). */
  readonly id?: string;
  /**
   * A vehicle completed the linked segment and is parked at its end. Start
   * the handling; call `release()` (idempotent, any time — synchronously for
   * zero-time handling) to let the vehicle continue.
   */
  onVehicleArrive(agvId: string, release: () => void): void;
}

export class PathDockRegistry {
  private readonly docks = new Map<string, PathDock>();

  /** Bind a dock to a path segment (one dock per segment — a second
   *  registration replaces the first with a warning). Returns unregister. */
  register(pathId: string, dock: PathDock): () => void {
    if (this.docks.has(pathId)) {
      console.warn(`[path-dock] segment '${pathId}' already has a dock — replacing`);
    }
    this.docks.set(pathId, dock);
    return () => {
      if (this.docks.get(pathId) === dock) this.docks.delete(pathId);
    };
  }

  /** The dock bound to a segment (null = none). */
  dockAt(pathId: string): PathDock | null {
    return this.docks.get(pathId) ?? null;
  }

  /** Test/model-cleared reset. */
  clear(): void {
    this.docks.clear();
  }
}

const defaultRegistry = new PathDockRegistry();

/** The shared dock registry (stations, conveyor ends, project adapters). */
export function getDefaultPathDockRegistry(): PathDockRegistry {
  return defaultRegistry;
}
