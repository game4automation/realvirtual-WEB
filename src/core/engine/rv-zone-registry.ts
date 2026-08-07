// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-zone-registry.ts — control-point / zone reservation (plan-268 Phase 2).
 *
 * Zones model mutual exclusion at junctions/crossings the way professional
 * material-flow tools do (FlexSim control points, Plant Simulation occupancy):
 * a vehicle CLAIMS a zone before entering and RELEASES it after leaving — no
 * physics, no raycast. A zone has a capacity (default 1); `claim` fails when
 * the capacity is exhausted and the vehicle holds at the zone entrance via the
 * headway stop mechanics (Agv.ts).
 *
 * Zones are declared in the WebViewer-native `rv_extras.Path` schema as the
 * path-level attributes `zone` (id) + `zoneCapacity` (see rv-path.ts, the
 * TS-SSOT of the schema): a zone is the set of paths sharing the same `zone`
 * id — a crossing is simply two crossing paths tagged with the same id.
 *
 * MANDATORY lifecycle rules (plan-268 §2.4, review finding 2):
 *   - Claims are indexed PER HOLDER (`releaseAll(agvId)`) so a reset, dispose
 *     or despawn can always free everything an AGV holds. A held claim that
 *     survives its holder would block the crossing PERMANENTLY — and a timeout
 *     can never heal that (in DES/FastForward no wall-clock time passes).
 *   - `clear()` drops every zone and claim (model switch / test reset).
 *   - `claim`/`release` are public API — project scripts may reserve zones
 *     (stations, charging bays) with the exact same calls the Agv uses.
 */

/** Capacity used for zones that were never explicitly declared. */
export const DEFAULT_ZONE_CAPACITY = 1;

interface ZoneState {
  /** Explicitly declared capacity (max of all explicit declarations); undefined = never declared. */
  capacity: number | undefined;
  /** Current holders (agv/actor ids). */
  holders: Set<string>;
}

/**
 * Zone claim registry. The shared instance is {@link defaultZoneRegistry};
 * tests may construct their own isolated registry.
 */
export class ZoneRegistry {
  private readonly zones = new Map<string, ZoneState>();
  private readonly byHolder = new Map<string, Set<string>>();

  private zone(zoneId: string): ZoneState {
    let z = this.zones.get(zoneId);
    if (!z) {
      z = { capacity: undefined, holders: new Set() };
      this.zones.set(zoneId, z);
    }
    return z;
  }

  /**
   * Declare a zone (idempotent). When several paths declare the same zone with
   * different explicit capacities, the MAXIMUM explicit declaration wins —
   * deterministic regardless of load order. `capacity` undefined only ensures
   * the zone exists (capacity stays "undeclared" → {@link DEFAULT_ZONE_CAPACITY}).
   */
  define(zoneId: string, capacity?: number): void {
    const z = this.zone(zoneId);
    if (capacity === undefined || !Number.isFinite(capacity)) return;
    const c = Math.max(0, Math.floor(capacity));
    z.capacity = z.capacity === undefined ? c : Math.max(z.capacity, c);
  }

  /** Drop a zone entirely (definition AND holders) — model-cleared path dispose. */
  undefine(zoneId: string): void {
    const z = this.zones.get(zoneId);
    if (!z) return;
    for (const holder of z.holders) this.byHolder.get(holder)?.delete(zoneId);
    this.zones.delete(zoneId);
  }

  /** Effective capacity: explicit declaration, else {@link DEFAULT_ZONE_CAPACITY}. */
  capacityOf(zoneId: string): number {
    return this.zones.get(zoneId)?.capacity ?? DEFAULT_ZONE_CAPACITY;
  }

  /**
   * Try to claim `zoneId` for `agvId`. Idempotent for the current holder
   * (re-claiming a zone you already hold is `true` and does not double-count).
   * Returns `false` when the capacity is exhausted (capacity 0 always fails).
   */
  claim(zoneId: string, agvId: string): boolean {
    const z = this.zone(zoneId);
    if (z.holders.has(agvId)) return true;
    if (z.holders.size >= (z.capacity ?? DEFAULT_ZONE_CAPACITY)) return false;
    z.holders.add(agvId);
    let held = this.byHolder.get(agvId);
    if (!held) {
      held = new Set();
      this.byHolder.set(agvId, held);
    }
    held.add(zoneId);
    return true;
  }

  /** Release one claim. No-op when `agvId` does not hold `zoneId`. */
  release(zoneId: string, agvId: string): void {
    this.zones.get(zoneId)?.holders.delete(agvId);
    this.byHolder.get(agvId)?.delete(zoneId);
  }

  /**
   * Release EVERY zone held by `agvId` — MUST be called from the component's
   * reset/dispose/despawn hooks (plan-268 review finding 2: a stale claim is a
   * permanent deadlock; no timeout can heal it in DES/FastForward).
   */
  releaseAll(agvId: string): void {
    const held = this.byHolder.get(agvId);
    if (!held) return;
    for (const zoneId of held) this.zones.get(zoneId)?.holders.delete(agvId);
    held.clear();
  }

  /** Drop every zone and claim (model switch / test reset). */
  clear(): void {
    this.zones.clear();
    this.byHolder.clear();
  }

  /** True when `agvId` currently holds `zoneId`. */
  isHolder(zoneId: string, agvId: string): boolean {
    return this.zones.get(zoneId)?.holders.has(agvId) ?? false;
  }

  /** Number of current holders of `zoneId` (0 for unknown zones). */
  holderCount(zoneId: string): number {
    return this.zones.get(zoneId)?.holders.size ?? 0;
  }

  /**
   * Copy the ids of all zones held by `agvId` into `out` (reused caller
   * buffer — no allocation in the tick). Returns the count. Use this instead
   * of iterating internal state when releases happen during the scan.
   */
  collectHeld(agvId: string, out: string[]): number {
    out.length = 0;
    const held = this.byHolder.get(agvId);
    if (!held) return 0;
    for (const zoneId of held) out.push(zoneId);
    return out.length;
  }
}

/** The shared registry the scene loader's Path components declare zones into. */
export const defaultZoneRegistry = new ZoneRegistry();

/** Accessor for the shared registry (symmetry with the other engine singletons). */
export function getDefaultZoneRegistry(): ZoneRegistry {
  return defaultZoneRegistry;
}
