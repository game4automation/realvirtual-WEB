// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-path-traveler.ts — continuous movement along an `RVPath` graph
 * (plan-268 Phase 1).
 *
 * The traveler owns ONE movement scalar `s` (arc length in METERS on the
 * current path) and a speed `v` in mm/s (drive parity — the ramp itself lives
 * in `computeRampedSpeed`, `rv-drive.ts`): `s += v/1000 · dt`.
 *
 * Path hand-off is a WHILE-carry: when `v·dt` overshoots the current path end
 * (possibly across SEVERAL short paths in one tick), the overflow transfers
 * to the routed successor each iteration — and symmetrically to predecessors
 * when `s < 0` (backward travel). Routing goes through the id-based
 * `selectNextPath` hook (default `candidateIds[0]`, see rv-path-network.ts);
 * `onArrive(nodeId, travelerId)` fires whenever the END node of a path is
 * reached (every forward hand-off and the final dead-end stop).
 *
 * Phase 6: every `onArrive` is ALSO forwarded to the network's registered
 * project router (`network.notifyArrive`), and a dead-end stop additionally
 * fires `network.requestDispatch(travelerId)` — once per stop, the dispatch
 * trigger for project fleet logic. Both are allocation-free no-ops without a
 * registered router.
 *
 * Pose comes from `lookRotation(tangent, path.align)` (rv-pose-align.ts).
 * All temps are pre-allocated — no GC in the tick.
 */

import { Quaternion, Vector3 } from 'three';
import type { RVPath } from './rv-path';
import type { RVPathNetwork, SelectNextPathHook } from './rv-path-network';
import { lookRotation } from './rv-pose-align';

/** Carry-loop guard: bounds pathological graphs (e.g. zero-length loops). */
const MAX_CARRY = 64;

export interface PathTravelerHooks {
  /** Routing at a path end — id-based, injectable from project code (F6). */
  selectNextPath?: SelectNextPathHook;
  /**
   * Fired when the traveler reaches the END node of a path (forward travel):
   * on every path→successor hand-off and once at a dead-end stop.
   * `nodeId` is the id of the COMPLETED path (its end node).
   */
  onArrive?: (nodeId: string, travelerId: string) => void;
}

/** FTS/AGV movement state along the path graph (plan-268 §2.3). */
export class PathTraveler {
  readonly id: string;
  /** Current route (null = not placed on a path). */
  path: RVPath | null;
  /** Arc length on `path` in METERS. */
  s = 0;
  /** Current speed in mm/s (drive parity) — signed, negative = backward. */
  v = 0;
  /** Spacing control holds the traveler (Phase 2 — unused in Phase 1). */
  blocked = false;
  /** True after stopping at a dead end (no successors). Cleared on hand-off. */
  atEnd = false;
  /** Injectable routing / arrival hooks. */
  hooks: PathTravelerHooks = {};
  /** Graph used to resolve successors/predecessors (may be null for a single path). */
  readonly network: RVPathNetwork | null;

  private readonly _dir = new Vector3();

  constructor(id: string, path: RVPath | null = null, network: RVPathNetwork | null = null) {
    this.id = id;
    this.path = path;
    this.network = network;
  }

  /**
   * Advance the movement scalar by one tick: `s += v/1000 · dt`
   * (v in mm/s, path lengths in meters), then carry across path ends.
   */
  advance(dt: number): void {
    if (!this.path) return;
    const ds = (this.v / 1000) * dt;
    if (ds === 0) return;
    this.s += ds;
    this.carry();
  }

  /** World position at the current `s` (no allocation with `out`). */
  getPosition(out: Vector3): Vector3 {
    return this.path ? this.path.getAbsPosition(this.s, out) : out.set(0, 0, 0);
  }

  /** Normalised world tangent at the current `s`. */
  getDirection(out: Vector3): Vector3 {
    return this.path ? this.path.getAbsDirection(this.s, out) : out.set(0, 0, 1);
  }

  /**
   * Full pose at the current `s`: position + `lookRotation(tangent, align)`
   * (local +Z along the travel direction, up from the path's align vector).
   */
  getPose(outPos: Vector3, outQuat: Quaternion): void {
    if (!this.path) {
      outPos.set(0, 0, 0);
      outQuat.identity();
      return;
    }
    this.path.getAbsPosition(this.s, outPos);
    this.path.getAbsDirection(this.s, this._dir);
    lookRotation(this._dir, this.path.align, outQuat);
  }

  /**
   * Peek the routed next path FROM `from` in `direction` WITHOUT moving —
   * the exact same hook dispatch the actual carry uses. Public for the
   * look-ahead consumers (SpacingController leader search, Agv zone walk,
   * plan-268 Phase 2), so their route prediction can never diverge from the
   * hand-off (assuming a deterministic `selectNextPath` hook).
   */
  peekNext(from: RVPath, direction: 1 | -1): RVPath | null {
    if (this.network) return this.network.next(from, direction, this.hooks.selectNextPath, this.id);
    // Network-less fallback (synthetic tests / single chains with pre-linked
    // successors): same hook contract over the already-resolved graph arrays.
    const linked = direction === 1 ? from.successors : from.predecessors;
    if (linked.length === 0) return null;
    let chosen = linked[0];
    const hook = this.hooks.selectNextPath;
    if (hook) {
      const ids = linked.map((c) => c.id);
      const picked = hook(ids, { travelerId: this.id, currentPathId: from.id, direction });
      const match = typeof picked === 'string' ? linked.find((c) => c.id === picked) : undefined;
      if (match) chosen = match;
    }
    return chosen;
  }

  /** Resolve the next path in `direction` (hook-dispatched; see network.next). */
  private pick(direction: 1 | -1): RVPath | null {
    return this.path ? this.peekNext(this.path, direction) : null;
  }

  /**
   * WHILE-carry across path boundaries (plan-268 §2.4): one tick may cross
   * several short paths; `s < 0` carries backward to predecessors. Degenerate
   * cases are guarded — zero-length paths consume carry iterations (bounded
   * by MAX_CARRY), empty successor lists clamp at the end (no crash), closed
   * paths wrap `s` modulo length.
   */
  private carry(): void {
    for (let guard = 0; guard < MAX_CARRY; guard++) {
      const p = this.path;
      if (!p) return;
      const L = p.length;

      if (this.s > L) {
        if (p.closed) {
          // Loop wrap — a closed chain has no end node, no arrival event.
          this.s = L > 0 ? this.s % L : 0;
          return;
        }
        this.hooks.onArrive?.(p.id, this.id);
        this.network?.notifyArrive(p.id, this.id);
        const next = this.pick(1);
        if (!next) {
          // Dead end: clamp + stop. Strict `>` above prevents re-firing
          // onArrive / requestDispatch on subsequent zero-movement ticks.
          this.s = L;
          this.v = 0;
          this.atEnd = true;
          // Phase 6: idle at a path end without successor → dispatch trigger.
          this.network?.requestDispatch(this.id);
          return;
        }
        this.s -= L;
        this.path = next;
        this.atEnd = false;
        continue;
      }

      if (this.s < 0) {
        if (p.closed) {
          this.s = L > 0 ? ((this.s % L) + L) % L : 0;
          return;
        }
        const prev = this.pick(-1);
        if (!prev) {
          // Start of the graph: clamp + stop (mirror of the dead end).
          this.s = 0;
          this.v = 0;
          return;
        }
        this.path = prev;
        this.s += prev.length;
        this.atEnd = false;
        continue;
      }

      this.atEnd = false;
      return;
    }
    // Guard exceeded (pathological zero-length loop) — clamp defensively.
    const p = this.path;
    if (p) this.s = Math.min(Math.max(this.s, 0), p.length);
  }
}
