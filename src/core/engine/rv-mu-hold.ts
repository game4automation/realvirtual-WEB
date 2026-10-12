// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-mu-hold.ts — the shared MU hold kernel (plan-521 Phase 3).
 *
 * Extracted from `RVGrip.fix()` / `RVGrip.unfix()` so a gripper and a `Zone`
 * with the Hold effect attach and detach MUs through exactly ONE code path.
 * Only the MECHANICS live here: re-parenting with `Object3D.attach()` (world
 * pose kept), the owner tag `heldBy`, `parentBeforeGrip`, the transport state
 * (`currentSurface`), a GripTarget the MU was sitting on, a passive-load link
 * (plan-516) and the collision-registry invalidate (plan-394).
 *
 * The PLACEMENT POLICY stays with each caller (plan-521 SOL R1 #3):
 *  - `RVGrip.autoPlace()` — GripTarget → MU carrier → at the current place;
 *  - `RVZone` release — surface below → GripTarget → at the current place.
 * The two only share the free helpers below ({@link findNearestGripTarget},
 * {@link placeOnGripTarget}, {@link sceneRootOf}); the grip's `LoadOnCarrier`
 * place (plan-577) uses {@link alignToGripTarget} alone.
 */

import { Quaternion, Vector3 } from 'three';
import type { Object3D } from 'three';
import type { MuHolder, RVMovingUnit } from './rv-mu';
import type { RVGripTarget } from './rv-grip-target';
import { MM_TO_METERS } from './rv-constants';
import { unloadMu, type MULoadHost } from './rv-mu-load';

// Pre-allocated scratch (no GC).
const _tmpVec = new Vector3();
const _tmpQuat = new Quaternion();
const _tmpParentQuat = new Quaternion();
const _scalePos = new Vector3();
const _scaleQuat = new Quaternion();
const _scale = new Vector3();

/** What the hold kernel needs from its caller's context. All optional. */
export interface MuHoldEnv {
  /** GripTargets whose occupancy by the MU is released on hold. */
  readonly gripTargets?: readonly RVGripTarget[] | null;
  /** Where a passive load (plan-516) rejoins the ticked MU set on hold. */
  readonly loadHost?: MULoadHost | null;
  /** Collision registry (plan-394) — its ancestor relation goes stale on re-parent. */
  readonly collision?: { invalidate(): void } | null;
}

/**
 * Attach `mu` to `node` (world pose kept) and tag it as held by `owner`.
 *
 * Mechanics only — the caller decides WHETHER the MU may be taken (instanced,
 * physics-owned, already held) and keeps its own list of held MUs.
 */
export function holdMU(mu: RVMovingUnit, node: Object3D, owner: MuHolder, env: MuHoldEnv = {}): void {
  // Free the GripTarget this MU was sitting on (if any). The C# Grip clears the
  // source Fixer/GripTarget when it picks a part; without this the target stays
  // occupied forever, which (a) blocks follow-up parts from ever being parented
  // onto it (so they no longer co-move with a moving target / machine axis), and
  // (b) leaves parentBeforeGrip pointing at the target node — so a later fallback
  // release would drop the part right back onto the (moving) target.
  const sourceTargets = env.gripTargets;
  if (sourceTargets) {
    for (const t of sourceTargets) {
      if (t.occupiedBy === mu) t.clearOccupied();
    }
  }

  // A passive load (plan-516) leaves its carrier and becomes an active MU
  // again (it is held now, so transport still skips it).
  if (mu.loadedOn) unloadMu(mu, env.loadHost);

  // Save parent before holding
  mu.parentBeforeGrip = mu.node.parent;

  // Three.js attach() preserves world transform while reparenting
  node.attach(mu.node);

  mu.heldBy = owner;
  mu.currentSurface = null;
  mu.lastSurfaceTickId = undefined;
  // The MU now lives in the holder's subtree — refresh the F16 relation.
  env.collision?.invalidate();
}

/**
 * Release `mu` from `owner`: the owner tag is cleared only when `owner` really
 * holds it (plan-259 O1b — nobody frees another subsystem's MU), the node is
 * re-attached to `restoreParent` (world pose kept) and `parentBeforeGrip` is
 * forgotten.
 */
export function detachMU(
  mu: RVMovingUnit,
  owner: MuHolder,
  restoreParent: Object3D | null,
  collision?: { invalidate(): void } | null,
): void {
  if (mu.heldBy === owner) mu.heldBy = null;

  // Reparent preserving world transform.
  if (restoreParent) {
    restoreParent.attach(mu.node);
  }
  mu.parentBeforeGrip = null;

  // The MU left the holder's subtree — refresh the F16 relation. A placement
  // policy may re-parent once more (onto a GripTarget) in the same synchronous
  // call; the dirty flag is read only at the next tick head, so one invalidate
  // covers the final hierarchy.
  collision?.invalidate();
}

/**
 * Nearest FREE GripTarget within `radiusMm` of `origin` (world, metres), or
 * null. Strictly-less comparison: a target exactly at the radius is outside.
 */
export function findNearestGripTarget(
  targets: readonly RVGripTarget[] | null | undefined,
  origin: Vector3,
  radiusMm: number,
): RVGripTarget | null {
  if (!targets) return null;
  const rangeM = radiusMm / MM_TO_METERS;
  let nearest: RVGripTarget | null = null;
  let minDist = rangeM;
  for (const target of targets) {
    if (!target.isFree) continue;
    target.node.getWorldPosition(_tmpVec);
    const dist = origin.distanceTo(_tmpVec);
    if (dist < minDist) {
      minDist = dist;
      nearest = target;
    }
  }
  return nearest;
}

/**
 * Put `mu` onto `target`: optional position/rotation alignment, then
 * re-parent to the target (the MU follows a moving target) and mark it
 * occupied. The MU must already be released from its holder.
 */
export function placeOnGripTarget(mu: RVMovingUnit, target: RVGripTarget): void {
  alignToGripTarget(mu, target);
  // Reparent MU to GripTarget (matches C# Grip.AutoPlace behavior).
  // If the GripTarget is on a moving object, the MU follows it.
  target.node.attach(mu.node);
  target.setOccupied(mu);
}

/**
 * Pose `mu` at `target` (`AlignPosition` / `AlignRotation`) under its CURRENT
 * parent — no re-parenting, no occupancy (plan-577: the `LoadOnCarrier` place
 * checks the aligned pose before it commits anything).
 */
export function alignToGripTarget(mu: RVMovingUnit, target: RVGripTarget): void {
  if (target.AlignPosition) {
    target.node.getWorldPosition(_tmpVec);
    mu.node.position.copy(_tmpVec);
    mu.node.parent?.worldToLocal(mu.node.position);
  }
  if (target.AlignRotation) {
    // Want the MU's WORLD rotation to equal the GripTarget's after attach()
    // (which preserves world transform). So set the MU's LOCAL quaternion to
    // parentWorld⁻¹ ⊗ targetWorld. Copying the target's world quaternion
    // straight into the (local) quaternion double-rotated the part whenever
    // the MU's current parent was itself rotated.
    target.node.getWorldQuaternion(_tmpQuat);
    mu.node.quaternion.copy(_tmpQuat);
    if (mu.node.parent) {
      mu.node.parent.getWorldQuaternion(_tmpParentQuat);
      mu.node.quaternion.premultiply(_tmpParentQuat.invert());
    }
  }
  // The TRS write must reach the local matrix also for a node the loader froze
  // (`matrixAutoUpdate` false) — `attach()` and `updateWorldMatrix()` read it.
  if (target.AlignPosition || target.AlignRotation) mu.node.updateMatrix();
}

/** Top-level scene root above `node` — a stable, non-moving container to
 *  release parts into at their current world position (the StandardParent-null
 *  equivalent of C# ReparentToStandardParent). */
export function sceneRootOf(node: Object3D): Object3D {
  let n: Object3D = node;
  while (n.parent) n = n.parent;
  return n;
}

/** True when `node`'s world scale is uniform — `attach()` below a non-uniformly
 *  scaled ancestor shears a child (plan-521 §5.1). */
export function hasUniformWorldScale(node: Object3D): boolean {
  node.updateWorldMatrix(true, false);
  node.matrixWorld.decompose(_scalePos, _scaleQuat, _scale);
  const ax = Math.abs(_scale.x);
  const ay = Math.abs(_scale.y);
  const az = Math.abs(_scale.z);
  const max = Math.max(ax, ay, az);
  if (max === 0) return false;
  return (max - Math.min(ax, ay, az)) / max < 1e-4;
}
