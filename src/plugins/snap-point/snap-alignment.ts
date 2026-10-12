// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Pure-math snap alignment.
 *
 * Two snap points are compatible whenever they share a TypeId. The named
 * direction suffix (ZN, ZP, XN, XP, YN, YP) only describes the outward
 * direction of that snap in its OWN local frame — it does NOT restrict
 * which other snap it can mate with.
 *
 * To place `newSnap` against `targetSnap` we therefore:
 *
 *   1. Compute each snap's outward direction in its OWN local frame from
 *      the name suffix (ZN -> -Z, ZP -> +Z, …).
 *   2. Rotate `newAssetRoot` so newSnap's outward axis ends up anti-parallel
 *      to targetSnap's outward axis in world space. This is a free single
 *      "swing" rotation (Rodrigues / quaternion-from-unit-vectors). There is
 *      a remaining "roll" degree of freedom around the outward axis; we
 *      resolve it by preserving the new asset's world-Y up vector when
 *      possible (good default for horizontal-floor scenes — conveyors stay
 *      upright, robots stay rooted to the floor).
 *   3. Translate so newSnap.worldPosition == targetSnap.worldPosition.
 *
 * Inputs are Three.js Object3D nodes; outputs are pure Matrix4 — caller
 * decomposes and applies. No scene mutation.
 */

import { Matrix4, Quaternion, Vector3 } from 'three';
import type { Object3D } from 'three';
import type { SnapAxis, SnapDirection } from './snap-name-parser';
import { recordRootOf } from '../../core/engine/rv-placement-instancer';

/**
 * @deprecated Kept for backwards compat with older call sites. Always returns
 *  identity — alignment now uses outward-axis vectors derived from the snap
 *  direction suffix, no fixed per-axis flip is needed.
 */
export function flipMatrixForAxis(_axis: SnapAxis): Matrix4 {
  return new Matrix4();
}

/**
 * Compute the outward direction of a snap in the snap's OWN LOCAL FRAME.
 *
 *   - the snap NAME's axis letter (X/Y/Z) picks the axis
 *   - the Empty's POSITION on that axis (in the owner's local frame) picks
 *     the sign — robust against Unity → glTF X-flip
 *   - NO world-space transformation here; that's the caller's job
 *
 * Returning the local-frame outward (instead of pre-rotating to world)
 * lets the alignment math reason cleanly about basePlacement, which
 * applies target's rotation to the new asset before any swing fixes the
 * orientation. Mixing "current world rotation" and "post-basePlacement
 * rotation" was the source of a double-rotation bug for rotated targets.
 *
 * Falls back to the name's sign-letter if the position on the named
 * axis is exactly zero (snap at the asset centre on that axis).
 */
function outwardLocalByPosition(
  snap: Object3D,
  ownerRoot: Object3D,
  axis: SnapAxis,
  fallbackSign: SnapDirection['sign'],
  out: Vector3 = new Vector3(),
): Vector3 {
  ownerRoot.updateMatrixWorld(true);
  snap.updateWorldMatrix(true, false);

  // Snap position relative to owner in world.
  _vTmp.setFromMatrixPosition(snap.matrixWorld);
  _vTmp2.setFromMatrixPosition(ownerRoot.matrixWorld);
  _vTmp.sub(_vTmp2);
  // Express in the owner's local frame.
  const rootInvQ = _qTmp.setFromRotationMatrix(ownerRoot.matrixWorld).invert();
  _vTmp.applyQuaternion(rootInvQ);

  let comp = 0;
  if (axis === 'X') comp = _vTmp.x;
  else if (axis === 'Y') comp = _vTmp.y;
  else comp = _vTmp.z;

  let sign: 1 | -1;
  if (Math.abs(comp) < 1e-4) {
    sign = fallbackSign === 'N' ? -1 : 1;
  } else {
    sign = comp > 0 ? 1 : -1;
  }

  if (axis === 'X') out.set(sign, 0, 0);
  else if (axis === 'Y') out.set(0, sign, 0);
  else out.set(0, 0, sign);
  return out;
}

/**
 * Fallback: name-derived local-frame outward (used only when the Empty sits
 * exactly at the asset centre and `outwardVectorByPosition` cannot pick an
 * axis from translation). Same axis as the name; sign is taken at face
 * value without Unity-X-flip compensation, since at the centre there is
 * no geometric truth to fall back to anyway.
 */
function outwardVectorByName(dir: SnapDirection, out: Vector3 = new Vector3()): Vector3 {
  const s = dir.sign === 'P' ? 1 : dir.sign === 'N' ? -1 : 0;
  if (dir.axis === 'X') return out.set(s, 0, 0);
  if (dir.axis === 'Y') return out.set(0, s, 0);
  return out.set(0, 0, s);
}

const _vTmp = new Vector3();
const _vTmp2 = new Vector3();
const _qTmp = new Quaternion();

/**
 * Walk up from a snap empty to the asset root.
 *
 * Stops at the first ancestor carrying `userData._layoutId` (set only on the
 * placed-component root by `addPlacedToScene` / `placeAtSnapPoint`). We do
 * NOT key off `_layoutObject` because that flag is propagated to EVERY
 * descendant of a placed asset — including the snap empties themselves —
 * so a walk starting at the snap would terminate at the snap as "owner",
 * leaving diff=0 in `outwardLocalByPosition` and falling back to the
 * name-sign (which is unreliable for X-axis snaps due to Unity → glTF
 * X-flip).
 *
 * plan-757 Phase 2 (F5): the owner is the RECORD root (`recordRootOf`) — a
 * snap empty inside a NESTED placement (a reference node inside a placed
 * asset, marked `_layoutNestedOf`, never `_layoutId`) belongs to the top-level
 * placement the planner's store knows, and it is THAT root the alignment
 * moves. Snap ports of nested content thus align the outer record.
 *
 * Falls back to the topmost ancestor when no record root is found
 * (test fixtures / unplaced ghost subtrees).
 */
function _resolveOwnerRoot(snap: Object3D): Object3D {
  const record = snap.parent ? recordRootOf(snap.parent) : null;
  if (record) return record;
  let cur: Object3D | null = snap.parent;
  let topmost: Object3D = snap;
  while (cur) {
    topmost = cur;
    cur = cur.parent;
  }
  return topmost;
}

// Module-level temps — `computeSnapAlignedWorldMatrix` runs every drag-tick
// (60 FPS) so every per-call `new Matrix4/Vector3/Quaternion` is a measurable
// GC pressure. Reuse these instead.
const _v1 = new Vector3();
const _v2 = new Vector3();
const _vTargetLocalOut = new Vector3();
const _vNewLocalOut = new Vector3();
const _vDesired = new Vector3();
const _vYLocal = new Vector3(0, 1, 0);
const _vUpInPlane = new Vector3();
const _vUpProj = new Vector3();
const _q = new Quaternion();
const _qSwing = new Quaternion();
const _qSwingLocal = new Quaternion();
const _qRoll = new Quaternion();
const _qTargetWorld = new Quaternion();
const _qTargetWorldInv = new Quaternion();
const _mRot = new Matrix4();
const _mTrans = new Matrix4();
const _mInv = new Matrix4();
const _mNewSnapLocal = new Matrix4();
const _mBase = new Matrix4();
const _mT1 = new Matrix4();
const _mT2 = new Matrix4();
const _mResult = new Matrix4();
const _mTmpCompose = new Matrix4();

/**
 * Compute the world matrix for `newAssetRoot` so that:
 *   - newSnap.worldPosition == targetSnap.worldPosition
 *   - newSnap's outward direction in world == -targetSnap's outward direction
 *
 * @param targetSnap    Snap already in the scene (worldMatrix must be current).
 * @param targetDir     Parsed direction of `targetSnap` (e.g. {axis:'X', sign:'P'}).
 * @param newAssetRoot  Asset to place (its current world matrix is the basis).
 * @param newSnap       Empty node inside newAssetRoot.
 * @param newDir        Parsed direction of `newSnap`.
 */
export function computeSnapAlignedWorldMatrix(
  targetSnap: Object3D,
  newAssetRoot: Object3D,
  newSnap: Object3D,
  arg5?: SnapAxis | SnapDirection,
  arg6?: SnapDirection,
): Matrix4 {
  // Back-compat: the old 4-arg signature accepted just an axis. New 5-arg form
  // takes (targetSnap, newAssetRoot, newSnap, targetDir, newDir). If only one
  // SnapDirection-shaped object is passed, treat it as the target direction
  // and infer newDir from the legacy "opposite-sign" rule.
  let targetDir: SnapDirection;
  let newDir: SnapDirection;
  if (arg5 && typeof arg5 === 'object' && 'axis' in arg5) {
    targetDir = arg5 as SnapDirection;
    if (arg6) {
      newDir = arg6;
    } else {
      newDir = {
        axis: targetDir.axis,
        sign: targetDir.sign === 'N' ? 'P' : 'N',
        code: `${targetDir.axis}${targetDir.sign === 'N' ? 'P' : 'N'}` as SnapDirection['code'],
      };
    }
  } else {
    // Pure-axis legacy call — assume both snaps share the axis, opposite signs.
    const ax = (arg5 as SnapAxis | undefined) ?? 'Z';
    targetDir = { axis: ax, sign: 'P', code: `${ax}P` as SnapDirection['code'] };
    newDir    = { axis: ax, sign: 'N', code: `${ax}N` as SnapDirection['code'] };
  }

  targetSnap.updateWorldMatrix(true, false);
  newAssetRoot.updateMatrixWorld(true);

  // newSnap-local-in-asset (reused temp, no per-call allocation).
  _mInv.copy(newAssetRoot.matrixWorld).invert();
  _mNewSnapLocal.multiplyMatrices(_mInv, newSnap.matrixWorld);

  // Outward axes in EACH snap's own LOCAL frame.
  //
  // Computing the swing in local frame is the key correctness step:
  // `basePlacement = target.matrixWorld * inv(newSnapLocal)` already
  // assigns target's rotation to the new asset (newSnap.world ends up
  // equal to target.world). Reasoning about the swing in target's local
  // frame avoids the double-rotation bug that hit the previous version,
  // which mixed "current world outward" (pre-basePlacement) with
  // "post-basePlacement" expectations.
  //
  // For the TARGET, the owning asset root is the registered SnapPoint's
  // `ownerRoot` — but this function only receives the Object3D, so we walk
  // up to the layout root by looking at the snap's chain of ancestors and
  // stopping at the first one carrying `userData._layoutId` (placed-root
  // marker — `_layoutObject` is not usable here because it also propagates
  // to descendants, including the snap empty itself).
  const targetOwnerRoot = _resolveOwnerRoot(targetSnap);
  outwardLocalByPosition(
    targetSnap, targetOwnerRoot, targetDir.axis, targetDir.sign, _vTargetLocalOut,
  );
  outwardLocalByPosition(
    newSnap, newAssetRoot, newDir.axis, newDir.sign, _vNewLocalOut,
  );

  // In target's local frame: after basePlacement, newSnap's axes equal
  // target's axes. We want the new asset's outward (expressed in target's
  // frame) to be -targetLocalOut. Note: `_vDesired` aliases `outAxis` below.
  _vDesired.copy(_vTargetLocalOut).multiplyScalar(-1);
  _qSwingLocal.setFromUnitVectors(_vNewLocalOut, _vDesired);

  // Roll disambiguation in target's local frame: after the swing, the new
  // asset can still spin freely around the outward axis. Prefer the roll
  // that keeps world-up aligned. Skip when the outward axis is itself
  // along ±Y (singular). `outAxis` === `_vDesired` here.
  if (Math.abs(_vDesired.dot(_vYLocal)) < 0.99) {
    // targetUpInPlane = Y projected onto plane perpendicular to outAxis
    _vUpInPlane.copy(_vYLocal);
    _v1.copy(_vYLocal).projectOnVector(_vDesired);
    _vUpInPlane.sub(_v1);
    if (_vUpInPlane.lengthSq() > 1e-8) {
      _vUpInPlane.normalize();
      // newUpAfterSwing = swing-rotated Y, projected onto same plane
      _vUpProj.copy(_vYLocal).applyQuaternion(_qSwingLocal);
      _v2.copy(_vUpProj).projectOnVector(_vDesired);
      _vUpProj.sub(_v2);
      if (_vUpProj.lengthSq() > 1e-8) {
        _vUpProj.normalize();
        _qRoll.setFromUnitVectors(_vUpProj, _vUpInPlane);
        _qSwingLocal.premultiply(_qRoll);
      }
    }
  }

  // Convert local swing to world: worldSwing = targetQ * swingLocal * targetQ⁻¹.
  _qTargetWorld.setFromRotationMatrix(targetSnap.matrixWorld);
  _qTargetWorldInv.copy(_qTargetWorld).invert();
  _qSwing.copy(_qTargetWorld).multiply(_qSwingLocal).multiply(_qTargetWorldInv);
  _mRot.makeRotationFromQuaternion(_qSwing);

  // basePlacement: place newAsset so newSnap.world equals target.world.
  // _mInv is the inverse of _mNewSnapLocal computed inline (reuses _mInv).
  _mInv.copy(_mNewSnapLocal).invert();
  _mBase.multiplyMatrices(targetSnap.matrixWorld, _mInv);

  // Apply the world-space swing rotation around the target snap world
  // position. Right-to-left multiplication keeps temps alive across steps.
  _v1.setFromMatrixPosition(targetSnap.matrixWorld);
  _mT1.makeTranslation(-_v1.x, -_v1.y, -_v1.z);
  _mT2.makeTranslation(_v1.x, _v1.y, _v1.z);
  _mTmpCompose.multiplyMatrices(_mT1, _mBase);     // T1 * base
  _mResult.multiplyMatrices(_mRot, _mTmpCompose);  // R * T1 * base
  // Final allocation is unavoidable — callers expect to own the returned
  // Matrix4 (decompose mutates components from it). Single per-call alloc.
  return new Matrix4().multiplyMatrices(_mT2, _mResult);
}

const _2a = new Vector3();
const _2b = new Vector3();
const _2ap = new Vector3();
const _2bp = new Vector3();
const _2u = new Vector3();
const _2v = new Vector3();
const _2q = new Quaternion();
const _2R = new Matrix4();
const _2T1 = new Matrix4();
const _2T2 = new Matrix4();
const _2tmp = new Matrix4();

/**
 * Two-snap (auto-rotating) alignment for a two-port connection.
 *
 * Rotates + translates `movingRoot` so that BOTH `snapA→targetA` and the
 * direction `snapA→snapB` align with `targetA→targetB`. snapA lands exactly on
 * targetA; snapB lands on targetB when the snap spacing matches the port
 * spacing (the normal case for a part designed to bridge two ports). Unlike the
 * single-pair `computeSnapAlignedWorldMatrix` — whose leftover roll is resolved
 * to world-up — the orientation here is fully constrained by the two ports, so
 * a part inserted between two neighbours auto-rotates to mate both.
 *
 * The roll about the connection axis is inherited from `movingRoot`'s current
 * orientation (kept upright for floor parts), as the two points leave that one
 * rotational DOF free.
 *
 * Returns the new world matrix for `movingRoot`; caller decomposes + applies.
 */
export function computeTwoSnapAlignedWorldMatrix(
  targetA: Object3D,
  snapA: Object3D,
  targetB: Object3D,
  snapB: Object3D,
  movingRoot: Object3D,
): Matrix4 {
  movingRoot.updateMatrixWorld(true);
  snapA.updateWorldMatrix(true, false);
  snapB.updateWorldMatrix(true, false);
  targetA.updateWorldMatrix(true, false);
  targetB.updateWorldMatrix(true, false);
  _2a.setFromMatrixPosition(snapA.matrixWorld);
  _2b.setFromMatrixPosition(snapB.matrixWorld);
  _2ap.setFromMatrixPosition(targetA.matrixWorld);
  _2bp.setFromMatrixPosition(targetB.matrixWorld);

  _2u.subVectors(_2b, _2a);
  _2v.subVectors(_2bp, _2ap);
  if (_2u.lengthSq() < 1e-10 || _2v.lengthSq() < 1e-10) {
    // Degenerate (coincident snaps) → translate snapA onto targetA, keep rotation.
    const M = movingRoot.matrixWorld.clone();
    M.elements[12] += _2ap.x - _2a.x;
    M.elements[13] += _2ap.y - _2a.y;
    M.elements[14] += _2ap.z - _2a.z;
    return M;
  }
  _2u.normalize();
  _2v.normalize();
  _2q.setFromUnitVectors(_2u, _2v);              // swing that aligns the A→B axes
  _2R.makeRotationFromQuaternion(_2q);

  // M = T(targetA) · R · T(-snapA) · currentWorld
  //   → rotate the object about snapA by the swing, then move snapA onto targetA.
  _2T1.makeTranslation(-_2a.x, -_2a.y, -_2a.z);
  _2T2.makeTranslation(_2ap.x, _2ap.y, _2ap.z);
  _2tmp.multiplyMatrices(_2T1, movingRoot.matrixWorld); // T(-a) · world
  _2tmp.premultiply(_2R);                                 // R · T(-a) · world
  _2tmp.premultiply(_2T2);                                // T(a') · R · T(-a) · world
  return _2tmp.clone();
}

const _pvPivot = new Vector3();
const _pvTarget = new Vector3();
const _pvMovOut = new Vector3();
const _pvTgtOut = new Vector3();
const _pvDesired = new Vector3();
const _pvQ = new Quaternion();
const _pvOwnerQ = new Quaternion();
const _pvR = new Matrix4();
const _pvT1 = new Matrix4();
const _pvT2 = new Matrix4();
const _pvTmp = new Matrix4();

/**
 * Single-pair snap that rotates the asset around ITS OWN snap point.
 *
 * Unlike `computeSnapAlignedWorldMatrix` — which re-orients the asset to the
 * target's frame (a full reorientation that pivots the body to a new pose) —
 * this keeps the asset's current orientation and applies only the MINIMAL swing
 * needed to make its outward axis anti-parallel to the target's, pivoting about
 * the moving snap point so that point stays put while the body rotates around
 * it. The moving snap then translates onto the target. This matches the user's
 * expectation when dragging an already-oriented part onto a port: it rotates
 * around its snap, it doesn't flip to the target's frame.
 *
 * Used by the drag-time magnetic snap; the snap PICKER still uses the
 * frame-reorienting variant (a fresh pick has no meaningful prior orientation).
 *
 * Returns the new world matrix for `movingRoot`; caller decomposes + applies.
 */
export function computeSnapPivotAlignedWorldMatrix(
  targetSnap: Object3D,
  movingRoot: Object3D,
  movingSnap: Object3D,
  targetDir: SnapDirection,
  movingDir: SnapDirection,
): Matrix4 {
  movingRoot.updateMatrixWorld(true);
  targetSnap.updateWorldMatrix(true, false);
  movingSnap.updateWorldMatrix(true, false);

  _pvPivot.setFromMatrixPosition(movingSnap.matrixWorld);
  _pvTarget.setFromMatrixPosition(targetSnap.matrixWorld);

  // Moving snap outward in WORLD = its local-frame outward rotated by the
  // asset's current world orientation.
  outwardLocalByPosition(movingSnap, movingRoot, movingDir.axis, movingDir.sign, _pvMovOut);
  _pvOwnerQ.setFromRotationMatrix(movingRoot.matrixWorld);
  _pvMovOut.applyQuaternion(_pvOwnerQ).normalize();

  // Target snap outward in WORLD (resolve its owning placed root).
  const targetOwner = _resolveOwnerRoot(targetSnap);
  targetOwner.updateWorldMatrix(true, false);
  outwardLocalByPosition(targetSnap, targetOwner, targetDir.axis, targetDir.sign, _pvTgtOut);
  _pvOwnerQ.setFromRotationMatrix(targetOwner.matrixWorld);
  _pvTgtOut.applyQuaternion(_pvOwnerQ).normalize();

  // Minimal swing so the asset's outward becomes anti-parallel to the target's.
  _pvDesired.copy(_pvTgtOut).multiplyScalar(-1);
  _pvQ.setFromUnitVectors(_pvMovOut, _pvDesired);
  _pvR.makeRotationFromQuaternion(_pvQ);

  // M = T(target) · R · T(-pivot) · currentWorld
  //   → rotate the asset about its own snap (pivot), then move that snap onto
  //     the target. Orientation otherwise preserved (no roll reset).
  _pvT1.makeTranslation(-_pvPivot.x, -_pvPivot.y, -_pvPivot.z);
  _pvT2.makeTranslation(_pvTarget.x, _pvTarget.y, _pvTarget.z);
  _pvTmp.multiplyMatrices(_pvT1, movingRoot.matrixWorld);
  _pvTmp.premultiply(_pvR);
  _pvTmp.premultiply(_pvT2);
  return _pvTmp.clone();
}
