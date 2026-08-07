// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-spacing-controller.ts — raycast-free 1D arc-length headway
 * (plan-268 Phase 2, F4).
 *
 * Distance keeping the way professional material-flow tools do it (FlexSim /
 * Plant Simulation / AnyLogic): the distance to the carrier ahead is the
 * 1D ARC-LENGTH difference along the path graph — NEVER euclidean, NO
 * physics raycast, NO colliders. Vehicles are treated as points; the desired
 * standstill separation is the follower's `safetyDistance`.
 *
 * Per refresh, all registered travelers are grouped by path and SORTED by
 * arc-length position `s` (cheaper than N² pair scans — plan-268 §2.4):
 *   - same path        → the leader is simply the next entry in the sorted group;
 *   - closed path      → the frontmost wraps around to the hindmost (gap mod L);
 *   - across path ends → the frontmost walks the graph successors (using the
 *     follower's OWN routing, `PathTraveler.peekNext` — same hook dispatch as
 *     the actual carry) accumulating arc length up to its `lookAhead` distance.
 *
 * Refresh cadence: `gapOf()` auto-refreshes once per tick round — the first
 * reader that reads TWICE (i.e. a new tick round started) triggers a re-sort,
 * so every follower in one tick sees the SAME start-of-tick snapshot
 * (deterministic and order-independent, exactly like the transport-surface
 * accumulation clamp reading last tick's grid state). Followers therefore act
 * on positions the leaders have only moved AWAY from — conservatively safe.
 *
 * The car-following ramp itself is the pure function
 * {@link computeCarFollowingSpeed}: `v_target = clamp((gap − safety)·k, 0, v_max)`
 * — smooth braking down to standstill at `safetyDistance`, smooth restart when
 * the leader departs. The hard no-penetration clamp (arc-length gap never
 * below `minGap`) is applied by the consumer (Agv.ts) on top of the ramp.
 *
 * Units: the controller is purely GEOMETRIC and works in METERS (path space).
 * `computeCarFollowingSpeed` works in mm / mm/s (drive parity) — the consumer
 * converts (×1000). All hot-path buffers are pre-allocated (no GC in the tick).
 */

import type { RVPath } from './rv-path';
import type { PathTraveler } from './rv-path-traveler';

/** Bound on the successor walk (pathological graphs / zero-length chains). */
const MAX_LOOKAHEAD_PATHS = 16;

/**
 * Below this car-following result (mm/s) the target snaps to exactly 0 —
 * terminates the exponential approach in finite ticks so `Blocked` (v == 0 by
 * the vehicle ahead) is deterministic instead of asymptotic.
 */
export const HEADWAY_STOP_EPS_MM_S = 0.5;

/** Default graph look-ahead for the leader search, in meters. */
export const DEFAULT_LOOKAHEAD_M = 5;

/**
 * The car-following ramp target (plan-268 §2.4):
 * `v_target = clamp((gap − safetyDistance)·gain, 0, vMax)`.
 *
 * @param gapMm            arc-length gap to the leader in mm (Infinity = free)
 * @param safetyDistanceMm desired standstill separation in mm
 * @param gain             proportional gain in 1/s
 * @param vMaxMmS          the vehicle's commanded speed limit in mm/s
 * @returns the headway-limited target speed in mm/s (0 = hold)
 */
export function computeCarFollowingSpeed(
  gapMm: number,
  safetyDistanceMm: number,
  gain: number,
  vMaxMmS: number,
): number {
  if (!Number.isFinite(gapMm)) return vMaxMmS;
  const v = (gapMm - safetyDistanceMm) * gain;
  if (v <= HEADWAY_STOP_EPS_MM_S) return 0;
  return v < vMaxMmS ? v : vMaxMmS;
}

export interface SpacingAddOptions {
  /** Leader search distance across path ends, in METERS. Default {@link DEFAULT_LOOKAHEAD_M}. */
  lookAhead?: number;
}

interface SpacingEntry {
  traveler: PathTraveler;
  lookAheadM: number;
  /** Result: arc-length gap to the leader in METERS (Infinity = no leader). */
  gapM: number;
  /** Result: id of the leader (null = no leader). */
  leaderId: string | null;
}

function compareByS(a: SpacingEntry, b: SpacingEntry): number {
  const d = a.traveler.s - b.traveler.s;
  if (d !== 0) return d;
  // Deterministic tie-break for identical positions (gap == 0 pairs): the id
  // decides who is the follower — one waits, the other departs, no deadlock.
  return a.traveler.id < b.traveler.id ? -1 : a.traveler.id > b.traveler.id ? 1 : 0;
}

/**
 * Headway bookkeeping for a fleet of {@link PathTraveler}s. The shared
 * instance is {@link defaultSpacingController}; tests may construct their own.
 */
export class SpacingController {
  private readonly entries: SpacingEntry[] = [];
  private readonly byId = new Map<string, SpacingEntry>();
  /** Per-path sorted member lists — lists are REUSED across refreshes (length reset). */
  private readonly groups = new Map<string, SpacingEntry[]>();
  /** Read-round detection for the auto-refresh (see module JSDoc). */
  private readonly readSet = new Set<string>();
  private dirty = true;
  /** Reused visited buffer for the successor walk (no allocation in the tick). */
  private readonly visited: string[] = [];
  private visitedLen = 0;

  /** Number of registered travelers. */
  get size(): number {
    return this.entries.length;
  }

  /** Register a traveler (id must be unique across the fleet). */
  add(traveler: PathTraveler, opts: SpacingAddOptions = {}): void {
    if (this.byId.has(traveler.id)) {
      console.warn(`[SpacingController] duplicate traveler id '${traveler.id}' — replacing`);
      this.remove(traveler.id);
    }
    const entry: SpacingEntry = {
      traveler,
      lookAheadM: Number.isFinite(opts.lookAhead) && (opts.lookAhead as number) >= 0
        ? (opts.lookAhead as number)
        : DEFAULT_LOOKAHEAD_M,
      gapM: Number.POSITIVE_INFINITY,
      leaderId: null,
    };
    this.entries.push(entry);
    this.byId.set(traveler.id, entry);
    this.dirty = true;
  }

  /** Unregister a traveler by id (or by instance). */
  remove(ref: string | PathTraveler): void {
    const id = typeof ref === 'string' ? ref : ref.id;
    const entry = this.byId.get(id);
    if (!entry) return;
    this.byId.delete(id);
    const i = this.entries.indexOf(entry);
    if (i >= 0) this.entries.splice(i, 1);
    this.dirty = true;
  }

  /** Drop every traveler (model switch / test reset). */
  clear(): void {
    this.entries.length = 0;
    this.byId.clear();
    this.groups.clear();
    this.readSet.clear();
    this.dirty = true;
  }

  /**
   * Arc-length gap (METERS) from this traveler to the carrier ahead of it —
   * Infinity when the way is free within the look-ahead. Auto-refreshes once
   * per tick round (see module JSDoc); call {@link refresh} for manual control.
   */
  gapOf(ref: string | PathTraveler): number {
    const entry = this.resolve(ref);
    if (!entry) return Number.POSITIVE_INFINITY;
    if (this.dirty || this.readSet.has(entry.traveler.id)) this.refresh();
    this.readSet.add(entry.traveler.id);
    return entry.gapM;
  }

  /** Id of the current leader of this traveler (null = none). Uses the last refresh. */
  leaderOf(ref: string | PathTraveler): string | null {
    return this.resolve(ref)?.leaderId ?? null;
  }

  private resolve(ref: string | PathTraveler): SpacingEntry | undefined {
    return this.byId.get(typeof ref === 'string' ? ref : ref.id);
  }

  /**
   * Re-sort the fleet by arc-length position and recompute every gap from the
   * CURRENT traveler positions. One call per tick is enough (and what the
   * auto-refresh does) — all consumers then see the same snapshot.
   */
  refresh(): void {
    this.dirty = false;
    this.readSet.clear();
    for (const list of this.groups.values()) list.length = 0;
    for (const e of this.entries) {
      e.gapM = Number.POSITIVE_INFINITY;
      e.leaderId = null;
      const p = e.traveler.path;
      if (!p) continue;
      let list = this.groups.get(p.id);
      if (!list) {
        list = [];
        this.groups.set(p.id, list);
      }
      list.push(e);
    }
    for (const list of this.groups.values()) {
      if (list.length > 1) list.sort(compareByS);
    }
    for (const list of this.groups.values()) {
      for (let i = 0; i < list.length; i++) this.computeGap(list, i);
    }
  }

  private seen(id: string): boolean {
    for (let i = 0; i < this.visitedLen; i++) if (this.visited[i] === id) return true;
    return false;
  }

  /** Gap for the entry at `i` of a group sorted ascending by `s`. */
  private computeGap(group: SpacingEntry[], i: number): void {
    const e = group[i];
    const p = e.traveler.path as RVPath; // grouped ⇒ non-null

    // Same path: the leader is simply the next entry in the sorted order.
    if (i < group.length - 1) {
      const leader = group[i + 1];
      e.gapM = leader.traveler.s - e.traveler.s;
      e.leaderId = leader.traveler.id;
      return;
    }

    // Frontmost on a CLOSED path: wrap around to the hindmost (gap mod L).
    if (p.closed) {
      if (group.length > 1 && p.length > 0) {
        const leader = group[0];
        e.gapM = leader.traveler.s + p.length - e.traveler.s;
        e.leaderId = leader.traveler.id;
      }
      return; // a single traveler on a loop never follows itself
    }

    // Frontmost on an open path: walk the graph successors (the follower's own
    // routing — peekNext dispatches the same selectNextPath hook as the carry)
    // accumulating arc length until lookAhead is exhausted.
    let acc = p.length - e.traveler.s;
    let cur = p;
    this.visitedLen = 0;
    for (let step = 0; step < MAX_LOOKAHEAD_PATHS && acc <= e.lookAheadM; step++) {
      const next = e.traveler.peekNext(cur, 1);
      if (!next) return; // dead end — free
      if (next.id === p.id) {
        // The route rings back onto the own path: the nearest carrier "ahead"
        // is the hindmost of the own group — unless that is ourselves.
        const cand = group[0];
        if (cand !== e) {
          e.gapM = acc + cand.traveler.s;
          e.leaderId = cand.traveler.id;
        }
        return;
      }
      if (this.seen(next.id)) return; // foreign cycle — bounded, free
      this.visited[this.visitedLen++] = next.id;
      const members = this.groups.get(next.id);
      if (members && members.length > 0) {
        const cand = members[0]; // min-s occupant of that path
        const gap = acc + cand.traveler.s;
        if (gap <= e.lookAheadM) {
          e.gapM = gap;
          e.leaderId = cand.traveler.id;
        }
        // beyond lookAhead → free (and anything further is farther still)
        return;
      }
      acc += next.length;
      cur = next;
    }
  }
}

/** The shared controller the Agv library component registers its travelers into. */
export const defaultSpacingController = new SpacingController();

/** Accessor for the shared controller (symmetry with the other engine singletons). */
export function getDefaultSpacingController(): SpacingController {
  return defaultSpacingController;
}
