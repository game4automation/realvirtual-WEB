// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Snap-Point Registry — indexed lookup of all snap points discovered in the
 * scene. A snap point is an empty Object3D whose name matches the
 * Snap-<DIR>-<TYPEID> naming convention (see core/connect/snap-name-parser.ts).
 *
 * The registry is the single source of truth for runtime snap state:
 *   - Indexed by typeId for fast compatibility lookup
 *   - Indexed by id (Object3D.uuid) for direct access
 *   - Tracks occupancy so a snap cannot accept a second asset
 *
 * Compatibility:
 *   typeId(a) === typeId(b)  AND  dir(a) is the opposite axis-sign of dir(b)
 */

import type { Object3D } from 'three';
// The snap vocabulary lives in the connection core (plan-633 F2) — the engine
// no longer reaches into the plugin folder for it.
import type { SnapDirection, SnapDirectionCode, SnapFlow } from '../connect/snap-name-parser';
import { flowsCompatible } from '../connect/snap-name-parser';

/** Opaque placement id (matches PlacedComponent.id from rv-layout-store). */
export type PlacedComponentId = string;

/** Runtime snap-point entity living in the registry. */
export interface SnapPoint {
  /**
   * Stable id == Three.js Object3D.uuid. Three.js generates collision-free
   * UUIDs automatically; this avoids the duplicate-name collision problem.
   */
  readonly id: string;
  /** The empty node in the GLB hierarchy. */
  readonly object3D: Object3D;
  readonly dir: SnapDirection;
  readonly typeId: string;
  /** Flow semantics derived from the sign letter of the name:
   *    N → 'in'   (input port)
   *    P → 'out'  (output port)
   *    B → 'bidi' (either; the bidirectional choice)
   *  Two snaps may only mate if their flows are compatible:
   *    in ↔ out, bidi ↔ anything; in ↔ in and out ↔ out are NOT compatible.
   *  Optional for backwards compat — callers that omit it are treated as
   *  bidi by `flowsCompatible`. */
  readonly flow?: SnapFlow;
  /** Asset root (e.g. the placed library object) this snap lives under. */
  readonly ownerRoot: Object3D;
  /** Scene-relative path. For debug/persistence only — never used as a key. */
  readonly scenePath: string;
  /** True iff something has been placed on this snap. */
  occupied: boolean;
  /** Backref to the placed component that occupies this snap. */
  occupiedBy?: PlacedComponentId;
  /** Snap-id of the opposite half of the connection. Set in pairs whenever
   *  two snaps engage (placement OR magnetic drag-snap) so the connection
   *  graph can be walked bidirectionally for chain-mode dragging. Cleared
   *  on free / unregister of either end. */
  pairedSnapId?: string;
}

export class SnapPointRegistry {
  private readonly _byTypeId = new Map<string, SnapPoint[]>();
  private readonly _byId = new Map<string, SnapPoint>();
  /** Index by owning asset root — used by chain walks and per-owner scans
   *  to avoid the previous O(n × deg) full registry traversal. */
  private readonly _byOwnerRoot = new Map<Object3D, SnapPoint[]>();
  private readonly _all: SnapPoint[] = [];
  private _version = 0;

  /**
   * Mutation counter (plan-644): raised by every mutator that changes the snap
   * set or a snap's connection state — `register`, `unregister`,
   * `unregisterUnder`, `markOccupied`, `markFree`, `pair`, `clear`. Readers
   * never raise it. Caches keyed on a registry (e.g. the DES port cache in
   * `material-flow-self.ts`) compare it together with the registry IDENTITY;
   * the fields `occupied` / `occupiedBy` / `pairedSnapId` must therefore only
   * be written through these mutators.
   */
  get version(): number {
    return this._version;
  }

  /** Register a snap point. Idempotent on id. */
  register(sp: SnapPoint): void {
    if (this._byId.has(sp.id)) return;
    this._version++;
    this._byId.set(sp.id, sp);
    this._all.push(sp);
    const bucket = this._byTypeId.get(sp.typeId);
    if (bucket) bucket.push(sp);
    else this._byTypeId.set(sp.typeId, [sp]);
    const ownerBucket = this._byOwnerRoot.get(sp.ownerRoot);
    if (ownerBucket) ownerBucket.push(sp);
    else this._byOwnerRoot.set(sp.ownerRoot, [sp]);
  }

  /** Remove a single snap by id. */
  unregister(id: string): void {
    const sp = this._byId.get(id);
    if (!sp) return;
    this._version++;
    // Free the partner's pairing reference before deleting this end.
    if (sp.pairedSnapId) {
      const other = this._byId.get(sp.pairedSnapId);
      if (other && other.pairedSnapId === sp.id) {
        other.pairedSnapId = undefined;
        // Partner's occupancy was bookkept against THIS snap's owner; the
        // slot is now free again.
        other.occupied = false;
        other.occupiedBy = undefined;
      }
    }
    this._byId.delete(id);
    const idx = this._all.indexOf(sp);
    if (idx >= 0) this._all.splice(idx, 1);
    const bucket = this._byTypeId.get(sp.typeId);
    if (bucket) {
      const bi = bucket.indexOf(sp);
      if (bi >= 0) bucket.splice(bi, 1);
      if (bucket.length === 0) this._byTypeId.delete(sp.typeId);
    }
    const ownerBucket = this._byOwnerRoot.get(sp.ownerRoot);
    if (ownerBucket) {
      const oi = ownerBucket.indexOf(sp);
      if (oi >= 0) ownerBucket.splice(oi, 1);
      if (ownerBucket.length === 0) this._byOwnerRoot.delete(sp.ownerRoot);
    }
  }

  /**
   * Remove every snap that lives under `root` (root itself or any
   * descendant). Walks the registry, not the scene graph — safe to call
   * after the subtree has been detached.
   */
  unregisterUnder(root: Object3D): void {
    const victims: string[] = [];
    for (const sp of this._all) {
      if (sp.ownerRoot === root || isDescendantOf(sp.object3D, root)) {
        victims.push(sp.id);
      }
    }
    if (victims.length === 0) return;
    this._version++;
    for (const id of victims) this.unregister(id);
  }

  /**
   * Compatible snap points = same typeId AND compatible flow.
   *
   * Flow compatibility (encoded in the snap name's sign letter — N/P/B):
   *   in ↔ out         ✓
   *   in ↔ bidi        ✓
   *   out ↔ bidi       ✓
   *   bidi ↔ bidi      ✓
   *   in ↔ in          ✗  (two inputs — material flow clash)
   *   out ↔ out        ✗  (two outputs — material flow clash)
   *
   * The axis direction code is NOT a filter — the outward direction is
   * derived from the snap's POSITION inside its asset, not from the name.
   *
   * The `oppositeDirCode` argument is preserved for API stability but is
   * ignored; callers that still pass it work unchanged. Snaps belonging
   * to the same `ownerRoot` as `target` are excluded.
   */
  getCompatible(typeId: string, _oppositeDirCode?: SnapDirectionCode, target?: SnapPoint): SnapPoint[] {
    const bucket = this._byTypeId.get(typeId);
    if (!bucket) return [];
    const out: SnapPoint[] = [];
    for (const sp of bucket) {
      if (target && sp.id === target.id) continue;
      if (target && sp.ownerRoot === target.ownerRoot) continue;
      if (target && !flowsCompatible(target.flow, sp.flow)) continue;
      out.push(sp);
    }
    return out;
  }

  getAll(): readonly SnapPoint[] {
    return this._all;
  }

  getById(id: string): SnapPoint | undefined {
    return this._byId.get(id);
  }

  /** O(deg) lookup of every snap belonging to `root`. Returns an empty
   *  array for unknown roots; never null. */
  getByOwnerRoot(root: Object3D): readonly SnapPoint[] {
    return this._byOwnerRoot.get(root) ?? EMPTY_SNAP_ARRAY;
  }

  /** Set of every asset root that currently owns at least one snap. Live
   *  reference — callers must NOT mutate. */
  getOwnerRoots(): ReadonlySet<Object3D> {
    return new Set(this._byOwnerRoot.keys());
  }

  /**
   * BFS the paired-snap graph from `start` and return every transitively
   * connected asset root (including `start` itself). Uses the byOwnerRoot
   * index for O(degree) per step instead of full registry scans.
   */
  walkChain(start: Object3D): Set<Object3D> {
    const out = new Set<Object3D>([start]);
    const queue: Object3D[] = [start];
    while (queue.length > 0) {
      const root = queue.shift()!;
      for (const sp of this.getByOwnerRoot(root)) {
        if (!sp.pairedSnapId) continue;
        const partner = this._byId.get(sp.pairedSnapId);
        if (!partner || out.has(partner.ownerRoot)) continue;
        out.add(partner.ownerRoot);
        queue.push(partner.ownerRoot);
      }
    }
    return out;
  }

  markOccupied(id: string, by: PlacedComponentId): void {
    const sp = this._byId.get(id);
    if (!sp) return;
    this._version++;
    sp.occupied = true;
    sp.occupiedBy = by;
  }

  markFree(id: string): void {
    const sp = this._byId.get(id);
    if (!sp) return;
    this._version++;
    // Free both ends symmetrically. When one end of a pair is freed the
    // partner is, by definition, no longer occupied either — its
    // `occupiedBy` referred to the asset on THIS side. Without this the
    // partner snap would stay greyed out / hidden even after an ALT-drag
    // detached the moving asset.
    if (sp.pairedSnapId) {
      const other = this._byId.get(sp.pairedSnapId);
      if (other) {
        other.occupied = false;
        other.occupiedBy = undefined;
        other.pairedSnapId = undefined;
      }
    }
    sp.occupied = false;
    sp.occupiedBy = undefined;
    sp.pairedSnapId = undefined;
  }

  /** Establish a bidirectional pairing between two snaps. Both must already
   *  be registered. Idempotent — if the same pair is bound twice nothing
   *  changes. */
  pair(idA: string, idB: string): void {
    const a = this._byId.get(idA);
    const b = this._byId.get(idB);
    if (!a || !b || a === b) return;
    this._version++;
    a.pairedSnapId = b.id;
    b.pairedSnapId = a.id;
  }

  /** Drop everything (e.g. on model unload). */
  clear(): void {
    this._version++;
    this._byId.clear();
    this._byTypeId.clear();
    this._byOwnerRoot.clear();
    this._all.length = 0;
  }

  /** Current snap-point count. */
  get size(): number {
    return this._all.length;
  }
}

const EMPTY_SNAP_ARRAY: readonly SnapPoint[] = Object.freeze([]);

function isDescendantOf(child: Object3D, ancestor: Object3D): boolean {
  let p: Object3D | null = child.parent;
  while (p) {
    if (p === ancestor) return true;
    p = p.parent;
  }
  return false;
}
