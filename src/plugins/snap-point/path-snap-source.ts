// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * path-snap-source.ts — DES/AGV path ends as snappoints (plan-447 Phase 2, F2).
 *
 * Every open `RVPath` exposes two snappoints: one at the START (flow `in`) and
 * one at the END (flow `out`). They speak the ordinary snap vocabulary
 * (`typeId` / `flow` / axis code, snap-name-parser.ts), so `SnapPointRegistry`,
 * the marker renderer, the magnetic controller and the MCP snap tools treat
 * them like any other port — no special case anywhere downstream.
 *
 * The ONE difference to GLB-authored snaps: path snaps are DATA-BOUND. Their
 * position comes from the segment data (`getPathEndpoints`, rv-path.ts), not
 * from a node's `matrixWorld`, so they must be RE-REGISTERED after every
 * geometry edit. That happens automatically — the source subscribes to the
 * network's per-pathId change channel (`RVPathNetwork.onPathChanged`, the same
 * event `RVPathComponent.reapplyConfig()` fires after a planner drag commit).
 *
 * A CLOSED path (loop) has no free ends and therefore no snappoints.
 */

import { Object3D } from 'three';
import type { SnapPoint, SnapPointRegistry } from '../../core/engine/rv-snap-point-registry';
import type { SnapAxis, SnapDirection, SnapDirectionCode, SnapSign } from './snap-name-parser';
import { getPathEndpoints, type PathEndpoint, type RVPath } from '../../core/engine/rv-path';
import { defaultPathNetwork, type RVPathNetwork } from '../../core/engine/rv-path-network';

/** Default snap `typeId` of a path end — path ends mate with path ends. */
export const PATH_END_SNAP_TYPE_ID = 'path';

/** Prefix of every synthesised path-end snap id (`path-snap:<pathId>:start`). */
export const PATH_SNAP_ID_PREFIX = 'path-snap';

export interface PathSnapSourceOptions {
  /** Snap type id the ends are registered under. Default {@link PATH_END_SNAP_TYPE_ID}. */
  typeId?: string;
  /** Path network to mirror. Default: the shared `defaultPathNetwork`. */
  network?: RVPathNetwork;
}

/** Stable snap id for one path end. */
export function pathSnapId(pathId: string, which: 'start' | 'end'): string {
  return `${PATH_SNAP_ID_PREFIX}:${pathId}:${which}`;
}

/** Dominant cardinal axis of a direction vector (ties resolve X → Y → Z). */
function dominantAxis(x: number, y: number, z: number): SnapAxis {
  const ax = Math.abs(x);
  const ay = Math.abs(y);
  const az = Math.abs(z);
  if (ax >= ay && ax >= az) return 'X';
  if (ay >= az) return 'Y';
  return 'Z';
}

/** Snap direction code for a path end: axis from the outward vector, sign from the flow. */
export function pathEndDirection(end: PathEndpoint): SnapDirection {
  const axis = dominantAxis(end.outward.x, end.outward.y, end.outward.z);
  const sign: SnapSign = end.flow === 'in' ? 'N' : 'P';
  return { axis, sign, code: `${axis}${sign}` as SnapDirectionCode };
}

/**
 * Mirrors the path network's free ends into a {@link SnapPointRegistry} and
 * keeps them in step with live geometry edits.
 */
export class PathSnapSource {
  private readonly registry: SnapPointRegistry;
  private readonly network: RVPathNetwork;
  private readonly typeId: string;
  /** One invisible holder Object3D per path — the snaps' `ownerRoot`. */
  private readonly holders = new Map<string, Object3D>();
  /** Snap ids currently registered per path (for surgical unregistration). */
  private readonly registered = new Map<string, string[]>();
  private unsubChanged: (() => void) | null = null;

  constructor(registry: SnapPointRegistry, opts: PathSnapSourceOptions = {}) {
    this.registry = registry;
    this.network = opts.network ?? defaultPathNetwork;
    this.typeId = opts.typeId ?? PATH_END_SNAP_TYPE_ID;
    this.unsubChanged = this.network.onPathChanged((pathId) => this.syncPath(pathId));
  }

  /** Snap ids currently registered for `pathId` (empty for unknown/closed paths). */
  snapIdsFor(pathId: string): readonly string[] {
    return this.registered.get(pathId) ?? EMPTY;
  }

  /** Total number of registered path-end snaps. */
  get size(): number {
    let n = 0;
    for (const ids of this.registered.values()) n += ids.length;
    return n;
  }

  /**
   * Full re-derivation: register the ends of every path in the network and drop
   * the snaps of paths that are gone. Call after a model load.
   */
  syncAll(): void {
    const live = new Set<string>();
    for (const path of this.network.all()) {
      live.add(path.id);
      this.applyPath(path.id, path);
    }
    for (const pathId of [...this.registered.keys()]) {
      if (!live.has(pathId)) this.removePath(pathId);
    }
  }

  /**
   * Re-register the ends of ONE path (plan-447 F2: data-bound snaps are
   * re-registered on every geometry edit). Removing the path from the network
   * drops its snaps.
   */
  syncPath(pathId: string): void {
    const path = this.network.get(pathId);
    if (!path) {
      this.removePath(pathId);
      return;
    }
    this.applyPath(pathId, path);
  }

  /** Drop every path snap (model switch / test reset). */
  clear(): void {
    for (const pathId of [...this.registered.keys()]) this.removePath(pathId);
    this.holders.clear();
  }

  /** Unsubscribe from the change channel and drop every snap. */
  dispose(): void {
    this.unsubChanged?.();
    this.unsubChanged = null;
    this.clear();
  }

  // ── internals ──────────────────────────────────────────────────────────

  private removePath(pathId: string): void {
    const ids = this.registered.get(pathId);
    if (ids) for (const id of ids) this.registry.unregister(id);
    this.registered.delete(pathId);
    this.holders.delete(pathId);
  }

  private holderFor(pathId: string): Object3D {
    let holder = this.holders.get(pathId);
    if (!holder) {
      holder = new Object3D();
      holder.name = `__pathSnaps:${pathId}`;
      holder.visible = false;
      holder.userData._rvPathSnapHolder = pathId;
      this.holders.set(pathId, holder);
    }
    return holder;
  }

  private applyPath(pathId: string, path: RVPath): void {
    // Data-bound: ALWAYS unregister first, then re-register at the new
    // position — `SnapPointRegistry.register` is idempotent on id and would
    // otherwise keep the stale coordinates of the pre-edit geometry.
    const previous = this.registered.get(pathId);
    if (previous) for (const id of previous) this.registry.unregister(id);
    this.registered.delete(pathId);

    const ends = getPathEndpoints(path);
    if (!ends) {
      // Closed loop or empty chain — no free ends, keep the holder out of the map.
      this.holders.delete(pathId);
      return;
    }

    const holder = this.holderFor(pathId);
    const ids: string[] = [];
    for (const end of [ends.start, ends.end]) {
      const id = pathSnapId(pathId, end.which);
      const node = this.nodeFor(holder, end);
      const snap: SnapPoint = {
        id,
        object3D: node,
        dir: pathEndDirection(end),
        typeId: this.typeId,
        flow: end.flow,
        ownerRoot: holder,
        scenePath: `path:${pathId}/${end.which}`,
        occupied: false,
      };
      this.registry.register(snap);
      ids.push(id);
    }
    this.registered.set(pathId, ids);
    holder.updateMatrixWorld(true);
  }

  /** Reuse (or create) the marker node for one end and place it at the data position. */
  private nodeFor(holder: Object3D, end: PathEndpoint): Object3D {
    const name = `Snap-${pathEndDirection(end).code}-${this.typeId}`;
    let node = holder.children.find((c) => c.userData._rvPathEnd === end.which) ?? null;
    if (!node) {
      node = new Object3D();
      node.userData._rvPathEnd = end.which;
      holder.add(node);
    }
    node.name = name;
    node.position.copy(end.position);
    node.userData._rvPathOutward = [end.outward.x, end.outward.y, end.outward.z];
    node.updateMatrix();
    return node;
  }
}

const EMPTY: readonly string[] = Object.freeze([]);
