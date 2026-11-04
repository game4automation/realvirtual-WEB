// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-ray-colliders.ts — the one ray-vs-box test raycast sensors use
 * ({@link rayObbDistance}), and the non-MU collider index that went with the
 * withdrawn blocking rule.
 *
 * **WITHDRAWN (Thomas' decision 2026-10-29, plan-2016 point (c)):** a raycast
 * sensor no longer consults non-MU colliders at all. Measured on the blow-moulding line
 * the blocking colliders changed nothing (no blocker on any of the 18 beams), while
 * on the standard demo they helped silence both light barriers.
 * {@link collectRayColliders} and {@link rayColliderDistance} are kept unused so the
 * rule can be reinstated with a measurement behind it; nothing in the engine calls them.
 *
 * **REINSTATED (2026-10-30, plan-2016 point (c2)):** a collider that CONTAINS the
 * ray origin is not reported — see {@link rayObbDistance} for the measurement. It is
 * the rule that bounds a DirectlyGrip grip, and it is independent of point (c).
 *
 * For the record, the rule of Unity's `Sensor.Raycast` (ONE
 * `Physics.Raycast(origin, dir, out hit, length, layermask)`) that point (c)
 * modelled: every collider blocks — `Sensor.OnTriggerEnter` then decides what the
 * hit means.
 *
 * The non-MU colliders are collected per scene topology ({@link collectRayColliders}):
 * enabled colliders outside every MU subtree (an MU's colliders belong to its
 * detection shape, `RVMovingUnit.detectParts`), INACTIVE nodes included. Whether a
 * collider takes part is decided per tick, before its ray test
 * ({@link refreshRayCollider}): a node switched off (`setNodeActive`, Unity
 * `SetActive(false)`) or taken out of the scene does not block the beam, one
 * switched on again does. A collider on a moving node follows it — the world box
 * is re-read once per tick. The transport manager re-collects when the topology
 * revision changes (`notifyTopologyChanged`), the sensor set changes or the model
 * is unloaded (plan-2016 Codex review).
 *
 * Limitation: the destructive bake drops a plain CAD mesh that carries only a
 * Unity `colliders[]` export annotation (rv-bake-survival.ts); such a collider
 * cannot be collected. Colliders on component nodes and on empty nodes survive.
 */

import { Box3, Matrix4, Vector3 } from 'three';
import type { Object3D } from 'three';
import { colliderExtrasOfNode, renderPrimitivesOf } from './rv-collider-extras';
import { unityPositionToGltf } from './rv-coordinate-utils';
import { RV_INACTIVE_KEY } from './rv-authored-inactive';
import { isMUNode } from './rv-mu-collider-bounds';
import { layerOfNode } from './rv-layers';
import { refreshWorldMatrix } from './rv-world-matrix';

/**
 * Distance along the ray (origin `o`, unit direction `d`) to an oriented box,
 * or -1 for a miss — and also -1 when `o` lies INSIDE the box (Unity / PhysX: the
 * ray does not report a collider it starts in; plan-2016 point (c2)).
 *
 * Withdrawn on 2026-10-29 and REINSTATED on 2026-10-30, because it is what BOUNDS a
 * DirectlyGrip grip. Without it the blow-moulding line loading gripper
 * (`KinematicPortalBeladung/…/GripperLeft`) saw every hose whose collider box
 * contains its sensor's ray origin, gripped each one and held 60 at a time, so the
 * QC line ran 0/0/0 instead of 20/19/19. Neither Unity's `Grip.cs` nor ours caps
 * the hold list (`PickedMUs` is an unbounded `List` with a `Contains` guard, and
 * `EventExit → Unfix` is wired for `PickBasedOnSensor` only, not for `PartToGrip`):
 * the bound is this query rule, not a capacity field. The 20/19/19 reference run of
 * 2026-10-29 03:15 (`85cabf8d`) carried it.
 *
 * The box: world centre `c`, axes = the first three COLUMNS of the column-major
 * 3×3 in `e` (`e[0..2]`, `e[4..6]`, `e[8..10]`, the layout of `Matrix4.elements`;
 * they may carry scale, which then scales the half extents), half extents
 * `hx, hy, hz` along them. Allocation-free.
 */
export function rayObbDistance(
  o: Vector3, d: Vector3, maxDist: number,
  c: Vector3, e: ArrayLike<number>, hx: number, hy: number, hz: number,
): number {
  let tmin = 0;
  let tmax = maxDist;
  let inside = true;
  for (let i = 0; i < 3; i++) {
    const k = i * 4;
    let ax = e[k], ay = e[k + 1], az = e[k + 2];
    const len = Math.sqrt(ax * ax + ay * ay + az * az);
    if (len < 1e-12) return -1;
    ax /= len; ay /= len; az /= len;
    const h = (i === 0 ? hx : i === 1 ? hy : hz) * len;
    // Signed distance of the box centre from the origin along this axis.
    const proj = ax * (c.x - o.x) + ay * (c.y - o.y) + az * (c.z - o.z);
    const slope = ax * d.x + ay * d.y + az * d.z;
    if (proj - h >= 0 || proj + h <= 0) inside = false;
    if (Math.abs(slope) < 1e-12) {
      if (proj - h > 0 || proj + h < 0) return -1;   // parallel and outside the slab
      continue;
    }
    let t1 = (proj - h) / slope;
    let t2 = (proj + h) / slope;
    if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return -1;
  }
  return inside ? -1 : tmin;
}

/** One non-MU collider a raycast sensor can hit. */
export interface RayCollider {
  readonly node: Object3D;
  /** Box centre in the node's LOCAL frame. */
  readonly localCenter: Vector3;
  /** Half extents in the node's LOCAL frame (scaled by the node's world matrix). */
  readonly localHalf: Vector3;
  /** Unity layer of the node (-1 = unknown, never filtered). */
  readonly layer: number;
  /** The node carries a `Sensor`: the hit blocks the ray but never occupies (Unity `OnTriggerEnter`). */
  readonly isSensor: boolean;
  /** World centre, refreshed once per tick ({@link refreshRayCollider}). */
  readonly worldCenter: Vector3;
  /** Tick of the last refresh. */
  tick: number;
  /** Scene root the collider was collected under — it is active only while its
   *  node still hangs below it. */
  readonly root: Object3D;
  /** Active (node and every ancestor up to {@link root} active, still attached) at
   *  the last refresh. An inactive collider is never hit. */
  active: boolean;
}

/** Is `node` attached below `root` with no node on the way switched inactive? Allocation-free. */
function attachedAndActive(node: Object3D, root: Object3D): boolean {
  for (let n: Object3D | null = node; n; n = n.parent) {
    if (n === root) return true;
    if (n.userData?.[RV_INACTIVE_KEY] === true) return false;
  }
  return false;
}

const _inv = new Matrix4();
const _rel = new Matrix4();
const _box = new Box3();
const _part = new Box3();

/** The local box of a MeshCollider: the bounds of the node's render primitives, null without geometry. */
function meshLocalBox(node: Object3D): Box3 | null {
  _box.makeEmpty();
  _inv.copy(node.matrixWorld).invert();
  for (const mesh of renderPrimitivesOf(node)) {
    const g = mesh.geometry;
    if (!g.boundingBox) g.computeBoundingBox();
    if (!g.boundingBox || g.boundingBox.isEmpty()) continue;
    _rel.multiplyMatrices(_inv, mesh.matrixWorld);
    _part.copy(g.boundingBox).applyMatrix4(_rel);
    _box.union(_part);
  }
  return _box.isEmpty() ? null : _box;
}

/**
 * Every enabled collider of `root`'s tree that does not belong to an MU (the walk
 * stops at MU roots — Source templates included, whose solid colliders Unity
 * disables at start), on active AND inactive nodes — activity is checked per tick.
 * Box colliders as authored, MeshColliders as the bounds of their render primitives
 * (Unity: the convex hull; the box encloses it).
 */
export function collectRayColliders(root: Object3D): RayCollider[] {
  const out: RayCollider[] = [];
  root.updateWorldMatrix(true, true);
  const visit = (node: Object3D): void => {
    if (isMUNode(node)) return;
    const cols = colliderExtrasOfNode(node);
    if (cols.length > 0) {
      const rv = node.userData?.realvirtual as Record<string, unknown> | undefined;
      const isSensor = !!rv && typeof rv === 'object' && !!rv['Sensor'];
      const layer = layerOfNode(node);
      for (const col of cols) {
        if (!col.enabled) continue;
        let center: Vector3;
        let half: Vector3;
        if (col.kind === 'box') {
          center = unityPositionToGltf(col.center.x, col.center.y, col.center.z).clone();
          half = new Vector3(Math.abs(col.size.x) / 2, Math.abs(col.size.y) / 2, Math.abs(col.size.z) / 2);
        } else {
          const b = meshLocalBox(node);
          if (!b) continue;
          center = b.getCenter(new Vector3());
          half = b.getSize(new Vector3()).multiplyScalar(0.5);
        }
        out.push({ node, localCenter: center, localHalf: half, layer, isSensor, worldCenter: new Vector3(), tick: -1, root, active: true });
      }
    }
    for (const child of node.children) visit(child);
  };
  visit(root);
  return out;
}

/** Bring a collider's activity and world centre to the node's current state (once per `tick`). */
export function refreshRayCollider(col: RayCollider, tick: number): void {
  if (col.tick === tick) return;
  col.tick = tick;
  col.active = attachedAndActive(col.node, col.root);
  if (!col.active) return;
  refreshWorldMatrix(col.node);
  col.worldCenter.copy(col.localCenter).applyMatrix4(col.node.matrixWorld);
}

/** Ray distance to a non-MU collider ({@link rayObbDistance} semantics); -1 while it is inactive. */
export function rayColliderDistance(col: RayCollider, o: Vector3, d: Vector3, maxDist: number, tick: number): number {
  refreshRayCollider(col, tick);
  if (!col.active) return -1;
  const h = col.localHalf;
  return rayObbDistance(o, d, maxDist, col.worldCenter, col.node.matrixWorld.elements, h.x, h.y, h.z);
}
