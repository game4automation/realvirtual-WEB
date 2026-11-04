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
 *
 * plan-628 8.2 (G4): an end that is CONNECTED (the END of a path with a
 * successor, the START of a path some other path lists as successor) is
 * `occupied`, exactly like a mated GLB snap: the standard marker shows only on
 * free ends. Occupancy is topology, so it is re-derived for every registered
 * end after each change (a successor write on A frees or takes B's start).
 * {@link PathSnapSourceOptions.onChange} tells the owner when the set of ends or
 * their occupancy changed (marker rebuild / refresh).
 *
 * plan-628 8.3 (G2/G5): {@link pathPlacementPorts} lists the `path`-typed ports
 * of placements (`Snap-<axis><N|P|B>-path`) as tangent-true attach targets for
 * path building blocks. The exact heading comes from the port node's world
 * frame, never from the cardinal axis code.
 */

import { Object3D, Quaternion, Vector3 } from 'three';
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
  /**
   * Called after a sync changed the registered ends (`idsChanged`: ends added or
   * removed) or only their occupancy / positions. The snap plugin rebuilds or
   * refreshes its markers here.
   */
  onChange?: (idsChanged: boolean) => void;
  /**
   * plan-628 8.2: scene node the per-path holders are parented to. The marker
   * renderer attaches its sprite to the snap node, so a holder outside the
   * scene draws nothing; the snap plugin passes an overlay container in the
   * viewer scene. Absent (tests): holders stay detached.
   */
  holderParent?: Object3D | null;
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
  private readonly onChange: ((idsChanged: boolean) => void) | null;
  private readonly holderParent: Object3D | null;

  constructor(registry: SnapPointRegistry, opts: PathSnapSourceOptions = {}) {
    this.registry = registry;
    this.network = opts.network ?? defaultPathNetwork;
    this.typeId = opts.typeId ?? PATH_END_SNAP_TYPE_ID;
    this.onChange = opts.onChange ?? null;
    this.holderParent = opts.holderParent ?? null;
    this.unsubChanged = this.network.onPathChanged((pathId) => this.syncPath(pathId));
  }

  /** The holder Object3D (snap `ownerRoot`) of a path's ends, null when it has none. */
  holderOf(pathId: string): Object3D | null {
    return this.registered.has(pathId) ? (this.holders.get(pathId) ?? null) : null;
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
    const before = this.idSignature();
    const live = new Set<string>();
    for (const path of this.network.all()) {
      live.add(path.id);
      this.applyPath(path.id, path);
    }
    for (const pathId of [...this.registered.keys()]) {
      if (!live.has(pathId)) this.removePath(pathId);
    }
    this.refreshOccupancy();
    this.onChange?.(this.idSignature() !== before);
  }

  /**
   * Re-register the ends of ONE path (plan-447 F2: data-bound snaps are
   * re-registered on every geometry edit). Removing the path from the network
   * drops its snaps.
   */
  syncPath(pathId: string): void {
    const before = this.idSignature();
    const path = this.network.get(pathId);
    if (!path) this.removePath(pathId);
    else this.applyPath(pathId, path);
    this.refreshOccupancy();
    this.onChange?.(this.idSignature() !== before);
  }

  /**
   * Re-derive `occupied` of every registered end from the topology (8.2): an
   * END with a successor, a START listed as someone's successor, or an end
   * mated through the snap pairing (`pairedSnapId`). O(paths + successors).
   */
  refreshOccupancy(): void {
    const hasPred = new Set<string>();
    for (const p of this.network.all()) for (const s of p.successorIds) hasPred.add(s);
    for (const [pathId, ids] of this.registered) {
      const path = this.network.get(pathId);
      for (const id of ids) {
        const sp = this.registry.getById(id);
        if (!sp) continue;
        const linked = id.endsWith(':start') ? hasPred.has(pathId) : (path?.successorIds.length ?? 0) > 0;
        sp.occupied = linked || !!sp.pairedSnapId;
      }
    }
  }

  private idSignature(): string {
    let h = '';
    for (const [pathId, ids] of this.registered) h += `${pathId}:${ids.length};`;
    return h;
  }

  /** Drop every path snap (model switch / test reset). */
  clear(): void {
    for (const pathId of [...this.registered.keys()]) this.removePath(pathId);
    for (const h of this.holders.values()) h.removeFromParent();
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
    this.holders.get(pathId)?.removeFromParent();
    this.holders.delete(pathId);
  }

  private holderFor(pathId: string): Object3D {
    let holder = this.holders.get(pathId);
    if (!holder) {
      holder = new Object3D();
      holder.name = `__pathSnaps:${pathId}`;
      // Visible: it carries no geometry, but the snap markers are attached
      // BELOW it and an invisible parent would hide them (8.2).
      holder.userData._rvPathSnapHolder = pathId;
      this.holders.set(pathId, holder);
    }
    if (this.holderParent && holder.parent !== this.holderParent) {
      this.holderParent.add(holder);
      holder.updateMatrixWorld(true);
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
      this.holders.get(pathId)?.removeFromParent();
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

// --- Path-typed placement ports (plan-628 8.3) ---------------------------

/**
 * A `path`-typed port of a placement as an attach target of a path block, in
 * the shape of a free path end (`layout.path.list` freePorts): `end: 'end'`
 * means a block STARTS here (the port emits or is bidirectional), `end:
 * 'start'` means a block ENDS here (the port consumes). `headingDeg` is the
 * travel direction in the XZ plane (0 deg = +X, 90 deg = +Z), exact from the
 * port node's world frame.
 */
export interface PathPlacementPort {
  readonly snapId: string;
  readonly pathId: '';
  readonly end: 'start' | 'end';
  readonly position: readonly number[];
  readonly headingDeg: number;
}

const _pos = new Vector3();
const _rel = new Vector3();
const _q = new Quaternion();
const _qInv = new Quaternion();
const _out = new Vector3();

/**
 * World outward direction of a placement snap: the named axis of the OWNER's
 * frame, signed by the port's position on that axis relative to the owner
 * (robust against the Unity to glTF X flip, the same rule `snap-alignment.ts`
 * uses), falling back to the name's sign letter at the centre.
 */
export function placementSnapOutwardWorld(sp: SnapPoint, out: Vector3 = new Vector3()): Vector3 {
  const owner = sp.ownerRoot;
  owner.updateWorldMatrix(true, false);
  sp.object3D.updateWorldMatrix(true, false);
  _pos.setFromMatrixPosition(sp.object3D.matrixWorld);
  _rel.setFromMatrixPosition(owner.matrixWorld);
  _q.setFromRotationMatrix(owner.matrixWorld);
  _qInv.copy(_q).invert();
  _rel.subVectors(_pos, _rel).applyQuaternion(_qInv);
  const axis = sp.dir.axis;
  const comp = axis === 'X' ? _rel.x : axis === 'Y' ? _rel.y : _rel.z;
  const sign = Math.abs(comp) > 1e-9 ? Math.sign(comp) : (sp.dir.sign === 'N' ? -1 : 1);
  out.set(axis === 'X' ? sign : 0, axis === 'Y' ? sign : 0, axis === 'Z' ? sign : 0).applyQuaternion(_q);
  return out.normalize();
}

/**
 * Every FREE `path`-typed port of a placement (not a path end itself) as a
 * tangent-true attach target. Ports whose outward direction is vertical are
 * skipped: a path runs on the floor plane.
 */
export function pathPlacementPorts(registry: SnapPointRegistry, typeId = PATH_END_SNAP_TYPE_ID): PathPlacementPort[] {
  const out: PathPlacementPort[] = [];
  for (const sp of registry.getAll()) {
    if (sp.typeId !== typeId || sp.occupied) continue;
    if (sp.id.startsWith(`${PATH_SNAP_ID_PREFIX}:`)) continue;
    placementSnapOutwardWorld(sp, _out);
    if (Math.hypot(_out.x, _out.z) < 1e-6) continue;
    sp.object3D.getWorldPosition(_pos);
    const consumes = sp.flow === 'in';
    // Travel direction: away from an emitting port, into a consuming one.
    const tx = consumes ? -_out.x : _out.x;
    const tz = consumes ? -_out.z : _out.z;
    out.push({
      snapId: sp.id,
      pathId: '',
      end: consumes ? 'start' : 'end',
      position: [_pos.x, _pos.y, _pos.z],
      headingDeg: (Math.atan2(tz, tx) * 180) / Math.PI,
    });
  }
  return out;
}
