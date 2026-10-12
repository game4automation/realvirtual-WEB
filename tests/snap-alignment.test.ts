// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect } from 'vitest';
import { Object3D, Vector3, Quaternion } from 'three';
import { Group, Matrix4 } from 'three';
import {
  computeSnapAlignedWorldMatrix,
  computeTwoSnapAlignedWorldMatrix,
  computeSnapPivotAlignedWorldMatrix,
  flipMatrixForAxis,
} from '../src/plugins/snap-point/snap-alignment';

/** Apply a Matrix4 to a newly-constructed root and update worlds. */
function applyMatrix(asset: Object3D, M: ReturnType<typeof computeSnapAlignedWorldMatrix>): void {
  asset.matrixAutoUpdate = false;
  asset.matrix.copy(M);
  M.decompose(asset.position, asset.quaternion, asset.scale);
  asset.matrixAutoUpdate = true;
  asset.updateMatrixWorld(true);
}

describe('computeSnapAlignedWorldMatrix', () => {
  it('places newAsset so newSnap world-position matches targetSnap world-position', () => {
    // Target snap at world (5, 0, 0)
    const targetRoot = new Object3D();
    targetRoot.position.set(5, 0, 0);
    targetRoot.updateMatrixWorld(true);
    const targetSnap = new Object3D();
    targetRoot.add(targetSnap);
    targetSnap.updateMatrixWorld(true);

    // New asset with snap offset (0, 0, 1) inside
    const newAsset = new Object3D();
    const newSnap = new Object3D();
    newSnap.position.set(0, 0, 1);
    newAsset.add(newSnap);
    newAsset.updateMatrixWorld(true);

    const M = computeSnapAlignedWorldMatrix(targetSnap, newAsset, newSnap, 'Z');
    applyMatrix(newAsset, M);
    newSnap.updateMatrixWorld(true);

    const got = newSnap.getWorldPosition(new Vector3());
    expect(got.x).toBeCloseTo(5, 5);
    expect(got.y).toBeCloseTo(0, 5);
    expect(got.z).toBeCloseTo(0, 5);
  });

  it('computeTwoSnapAlignedWorldMatrix auto-rotates to mate BOTH ports', () => {
    // Two ports 2 m apart along world X.
    const targetA = new Object3D(); targetA.position.set(0, 0, 0);
    const targetB = new Object3D(); targetB.position.set(2, 0, 0);
    targetA.updateMatrixWorld(true); targetB.updateMatrixWorld(true);

    // A part 2 m long with snaps at local ±Z, placed off to the side and
    // rotated arbitrarily (its snap axis does NOT yet point along X).
    const mover = new Object3D();
    mover.position.set(5, 0, 5);
    mover.quaternion.setFromAxisAngle(new Vector3(0, 1, 0), (50 * Math.PI) / 180);
    const snapA = new Object3D(); snapA.position.set(0, 0, -1);
    const snapB = new Object3D(); snapB.position.set(0, 0, 1);
    mover.add(snapA); mover.add(snapB);
    mover.updateMatrixWorld(true);

    const M = computeTwoSnapAlignedWorldMatrix(targetA, snapA, targetB, snapB, mover);
    applyMatrix(mover, M);
    snapA.updateMatrixWorld(true); snapB.updateMatrixWorld(true);

    // snapA → targetA, snapB → targetB (rotation solved from the two ports).
    const a = snapA.getWorldPosition(new Vector3());
    const b = snapB.getWorldPosition(new Vector3());
    expect(a.x).toBeCloseTo(0, 4); expect(a.y).toBeCloseTo(0, 4); expect(a.z).toBeCloseTo(0, 4);
    expect(b.x).toBeCloseTo(2, 4); expect(b.y).toBeCloseTo(0, 4); expect(b.z).toBeCloseTo(0, 4);
  });

  it('snap lands on target under a TRANSFORMED parent (world→local applied)', () => {
    // Target snap at world (0,0,0).
    const targetRoot = new Object3D();
    const targetSnap = new Object3D();
    targetRoot.add(targetSnap);
    targetRoot.updateMatrixWorld(true);

    // Moving object under a translated parent (e.g. the loaded model root).
    const parent = new Group();
    parent.position.set(10, 0, -4);
    const obj = new Object3D();
    parent.add(obj);
    const snap = new Object3D();
    snap.position.set(0, 0, 1);
    obj.add(snap);
    parent.updateMatrixWorld(true);

    const M = computeSnapAlignedWorldMatrix(targetSnap, obj, snap, 'Z');
    // The fix: convert the WORLD matrix to the object's parent-local frame
    // before assigning (what the magnetic tick / ghost path now do).
    const local = new Matrix4().copy(parent.matrixWorld).invert().multiply(M);
    applyMatrix(obj, local);
    snap.updateMatrixWorld(true);

    const got = snap.getWorldPosition(new Vector3());
    expect(got.x).toBeCloseTo(0, 4);
    expect(got.y).toBeCloseTo(0, 4);
    expect(got.z).toBeCloseTo(0, 4);
  });

  it('computeSnapPivotAlignedWorldMatrix mates by rotating around the moving snap', () => {
    // Target: owner at world (5,0,0) with a ZN snap at local (0,0,-0.5) → outward -Z.
    const targetOwner = new Object3D();
    targetOwner.position.set(5, 0, 0);
    targetOwner.userData._layoutId = 'tgt';
    const targetSnap = new Object3D();
    targetSnap.position.set(0, 0, -0.5);
    targetOwner.add(targetSnap);
    targetOwner.updateMatrixWorld(true);

    // Moving asset, arbitrarily placed + rotated, with a ZP snap (outward +Z).
    const obj = new Object3D();
    obj.position.set(1, 0, 1);
    obj.quaternion.setFromAxisAngle(new Vector3(0, 1, 0), (30 * Math.PI) / 180);
    obj.userData._layoutId = 'mov';
    const movingSnap = new Object3D();
    movingSnap.position.set(0, 0, 0.5);
    obj.add(movingSnap);
    obj.updateMatrixWorld(true);

    const M = computeSnapPivotAlignedWorldMatrix(
      targetSnap, obj, movingSnap,
      { axis: 'Z', sign: 'N', code: 'ZN' },
      { axis: 'Z', sign: 'P', code: 'ZP' },
    );
    applyMatrix(obj, M);
    movingSnap.updateMatrixWorld(true);

    // Moving snap lands exactly on the target snap.
    const got = movingSnap.getWorldPosition(new Vector3());
    expect(got.x).toBeCloseTo(5, 4);
    expect(got.y).toBeCloseTo(0, 4);
    expect(got.z).toBeCloseTo(-0.5, 4);

    // Outward axis now anti-parallel to the target's (-Z) → moving outward = +Z.
    const out = new Vector3(0, 0, 1).applyQuaternion(obj.getWorldQuaternion(new Quaternion()));
    expect(out.x).toBeCloseTo(0, 4);
    expect(out.y).toBeCloseTo(0, 4);
    expect(out.z).toBeCloseTo(1, 4);
  });

  it('the target snap inside NESTED placement content aligns against the RECORD root, not the nested root (plan-757 Phase 2, F5)', () => {
    // Record root at the origin; a nested placement root (a reference node
    // inside the placed asset — `_layoutNestedOf`, never `_layoutId`) sits at
    // z = −2 inside it; the snap sits at +0.5 in the nested root's frame.
    // Relative to the NESTED root the snap is at +Z (outward +Z); relative to
    // the RECORD root it is at z = −1.5 (outward −Z). The planner moves the
    // record, so the record's reading is the right one: the moving asset's
    // outward must end up anti-parallel to −Z, i.e. +Z.
    const record = new Object3D();
    record.userData._layoutId = 'rec';
    const nested = new Object3D();
    nested.position.set(0, 0, -2);
    nested.userData._layoutObject = true;
    nested.userData._layoutNestedOf = 'rec';
    record.add(nested);
    const targetSnap = new Object3D();
    targetSnap.position.set(0, 0, 0.5);
    nested.add(targetSnap);
    record.updateMatrixWorld(true);

    const obj = new Object3D();
    obj.position.set(4, 0, 4);
    obj.userData._layoutId = 'mov';
    const movingSnap = new Object3D();
    movingSnap.position.set(0, 0, 0.5);
    obj.add(movingSnap);
    obj.updateMatrixWorld(true);

    const M = computeSnapPivotAlignedWorldMatrix(
      targetSnap, obj, movingSnap,
      { axis: 'Z', sign: 'P', code: 'ZP' },
      { axis: 'Z', sign: 'P', code: 'ZP' },
    );
    applyMatrix(obj, M);
    movingSnap.updateMatrixWorld(true);

    const got = movingSnap.getWorldPosition(new Vector3());
    expect(got.x).toBeCloseTo(0, 4);
    expect(got.z).toBeCloseTo(-1.5, 4);
    const out = new Vector3(0, 0, 1).applyQuaternion(obj.getWorldQuaternion(new Quaternion()));
    expect(out.z, 'anti-parallel to the RECORD reading (−Z) → +Z; the nested reading would give −Z').toBeCloseTo(1, 4);
  });

  it('flipMatrixForAxis is identity (current convention has no flip)', () => {
    // Opposite-sign snaps already face each other when their world matrices
    // align; same-sign mates would need a flip but the matcher prohibits them.
    for (const axis of ['X', 'Y', 'Z'] as const) {
      const m = flipMatrixForAxis(axis);
      const v = new Vector3(0, 0, 1).applyMatrix4(m);
      expect(v.x).toBeCloseTo(0, 6);
      expect(v.y).toBeCloseTo(0, 6);
      expect(v.z).toBeCloseTo(1, 6);
    }
  });

  it('places assets end-to-end (no overlap) for opposite-sign Z snaps', () => {
    // Target: conveyor A at origin, length 1, ZP snap at world (0,0,+0.5).
    const A = new Object3D();
    const aZp = new Object3D();
    aZp.position.set(0, 0, 0.5);
    A.add(aZp);
    A.updateMatrixWorld(true);

    // New: conveyor B at origin, length 1, ZN snap at local (0,0,-0.5).
    const B = new Object3D();
    const bZn = new Object3D();
    bZn.position.set(0, 0, -0.5);
    B.add(bZn);
    B.updateMatrixWorld(true);

    const M = computeSnapAlignedWorldMatrix(aZp, B, bZn, 'Z');
    applyMatrix(B, M);

    // B's CENTER must end up at world (0, 0, 1) — one unit past A's centre,
    // not stacked on top of it.
    expect(B.position.x).toBeCloseTo(0, 5);
    expect(B.position.y).toBeCloseTo(0, 5);
    expect(B.position.z).toBeCloseTo(1, 5);
    // B's local +Z direction matches A's local +Z (both forward).
    const bZ = new Vector3(0, 0, 1).applyQuaternion(B.quaternion).normalize();
    expect(bZ.z).toBeCloseTo(1, 5);
  });

  it('chained snap placement: stacking 3 modules preserves alignment', () => {
    // Module A: snap-out at +Z (offset 1)
    const A = new Object3D();
    A.position.set(0, 0, 0);
    const ASnapOut = new Object3D();
    ASnapOut.position.set(0, 0, 1);
    A.add(ASnapOut);
    A.updateMatrixWorld(true);

    // Module B template: snap-in at +Z 0, snap-out at +Z 2 (length 2 in local Z)
    // After alignment, B's snap-in lands on A's snap-out.
    function makeModule(length: number): { root: Object3D; snapIn: Object3D; snapOut: Object3D } {
      const root = new Object3D();
      const snapIn = new Object3D();
      const snapOut = new Object3D();
      snapOut.position.set(0, 0, length);
      root.add(snapIn, snapOut);
      return { root, snapIn, snapOut };
    }

    const B = makeModule(2);
    const M = computeSnapAlignedWorldMatrix(ASnapOut, B.root, B.snapIn, 'Z');
    applyMatrix(B.root, M);
    B.snapIn.updateMatrixWorld(true);
    B.snapOut.updateMatrixWorld(true);

    // B's snap-in should match A's snap-out world pos
    const inPos = B.snapIn.getWorldPosition(new Vector3());
    const aOutPos = ASnapOut.getWorldPosition(new Vector3());
    expect(inPos.x).toBeCloseTo(aOutPos.x, 5);
    expect(inPos.y).toBeCloseTo(aOutPos.y, 5);
    expect(inPos.z).toBeCloseTo(aOutPos.z, 5);

    // Now place C on B's snap-out
    const C = makeModule(3);
    const M2 = computeSnapAlignedWorldMatrix(B.snapOut, C.root, C.snapIn, 'Z');
    applyMatrix(C.root, M2);
    C.snapIn.updateMatrixWorld(true);

    const cInPos = C.snapIn.getWorldPosition(new Vector3());
    const bOutPos = B.snapOut.getWorldPosition(new Vector3());
    expect(cInPos.x).toBeCloseTo(bOutPos.x, 5);
    expect(cInPos.y).toBeCloseTo(bOutPos.y, 5);
    expect(cInPos.z).toBeCloseTo(bOutPos.z, 5);
  });

  it('respects a translated newAsset starting transform when computing offset', () => {
    // newAsset starts somewhere far away; result must still end up at target.
    const targetSnap = new Object3D();
    targetSnap.position.set(10, 0, 0);
    targetSnap.updateMatrixWorld(true);

    const newAsset = new Object3D();
    newAsset.position.set(-50, 4, 7);
    const newSnap = new Object3D();
    newSnap.position.set(0, 0, 0.25);
    newAsset.add(newSnap);
    newAsset.updateMatrixWorld(true);

    const M = computeSnapAlignedWorldMatrix(targetSnap, newAsset, newSnap, 'Z');
    applyMatrix(newAsset, M);
    newSnap.updateMatrixWorld(true);

    const got = newSnap.getWorldPosition(new Vector3());
    expect(got.x).toBeCloseTo(10, 5);
    expect(got.y).toBeCloseTo(0, 5);
    expect(got.z).toBeCloseTo(0, 5);
  });
});
