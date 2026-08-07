// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Drive axis gizmo — pure axis/orientation math (plan-249 §9.1, refined §10.6).
 *
 * Covers `RVDrive.getAxis()` for every DriveDirection × ReverseDirection
 * combination (returned as a COPY, never the internal reference) and the
 * pure world-space composition helper `resolveWorldAxis` (rotated parent via
 * a real Object3D tree + updateMatrixWorld — no renderer needed).
 */

import { describe, it, expect } from 'vitest';
import { Object3D, Quaternion, Vector3 } from 'three';
import { RVDrive, DriveDirection } from '../src/core/engine/rv-drive';
import { isRotation } from '../src/core/engine/rv-coordinate-utils';
import {
  resolveWorldAxis, perspectiveViewportWorldHeight, computeGizmoScale, minGizmoScale,
  GIZMO_MAX_SCREEN_FRAC, GIZMO_MIN_SCREEN_FRAC, GIZMO_DESIGN_HEIGHT,
} from '../src/plugins/drive-axis-math';

function makeDrive(direction: DriveDirection, reverse = false): RVDrive {
  const drive = new RVDrive(new Object3D());
  drive.Direction = direction;
  drive.ReverseDirection = reverse;
  drive.initDrive();
  return drive;
}

function expectVec(v: Vector3, x: number, y: number, z: number): void {
  expect(v.x).toBeCloseTo(x, 6);
  expect(v.y).toBeCloseTo(y, 6);
  expect(v.z).toBeCloseTo(z, 6);
}

describe('RVDrive.getAxis', () => {
  // Expected glTF-space axes (see directionToGltfAxis docs — X-negation for
  // linear, Y/Z-negation for rotation come from the UnityGLTF handedness flip).
  const EXPECTED: Array<[DriveDirection, [number, number, number]]> = [
    [DriveDirection.LinearX, [-1, 0, 0]],
    [DriveDirection.LinearY, [0, 1, 0]],
    [DriveDirection.LinearZ, [0, 0, 1]],
    [DriveDirection.RotationX, [1, 0, 0]],
    [DriveDirection.RotationY, [0, -1, 0]],
    [DriveDirection.RotationZ, [0, 0, -1]],
    [DriveDirection.Virtual, [0, 0, 0]],
  ];

  for (const [dir, [x, y, z]] of EXPECTED) {
    it(`derives the correct axis for ${dir}`, () => {
      expectVec(makeDrive(dir).getAxis(), x, y, z);
    });

    it(`derives the negated axis for ${dir} with ReverseDirection`, () => {
      // Virtual stays the zero vector even when reversed.
      expectVec(makeDrive(dir, true).getAxis(), -x, -y, -z);
    });
  }

  it('LinearY + ReverseDirection yields exactly (0,-1,0)', () => {
    expectVec(makeDrive(DriveDirection.LinearY, true).getAxis(), 0, -1, 0);
  });

  it('returns a COPY — mutating the result does not change the drive axis', () => {
    const drive = makeDrive(DriveDirection.LinearZ);
    const a = drive.getAxis();
    a.set(9, 9, 9);
    expectVec(drive.getAxis(), 0, 0, 1);
  });

  it('writes into the provided out vector and returns it', () => {
    const drive = makeDrive(DriveDirection.LinearX);
    const out = new Vector3();
    const ret = drive.getAxis(out);
    expect(ret).toBe(out);
    expectVec(out, -1, 0, 0);
  });

  it('Virtual is detected as a zero vector (gizmo guard)', () => {
    expect(makeDrive(DriveDirection.Virtual).getAxis().lengthSq()).toBeLessThan(1e-6);
    expect(makeDrive(DriveDirection.Virtual, true).getAxis().lengthSq()).toBeLessThan(1e-6);
  });

  it('classifies rotary vs linear', () => {
    expect(isRotation(DriveDirection.RotationZ)).toBe(true);
    expect(isRotation(DriveDirection.LinearY)).toBe(false);
    expect(makeDrive(DriveDirection.RotationX).isRotary).toBe(true);
    expect(makeDrive(DriveDirection.LinearX).isRotary).toBe(false);
  });
});

describe('resolveWorldAxis', () => {
  /** Decompose a node's parent world rotation like the plugin does per frame. */
  function parentWorldQuat(node: Object3D): Quaternion {
    const q = new Quaternion();
    node.parent!.matrixWorld.decompose(new Vector3(), q, new Vector3());
    return q;
  }

  it('composes a rotated parent into world space (Object3D tree + updateMatrixWorld)', () => {
    const root = new Object3D();
    const parent = new Object3D();
    parent.rotation.y = Math.PI / 2; // +90° about Y
    root.add(parent);
    const node = new Object3D();
    parent.add(node);
    root.updateMatrixWorld(true);

    const out = new Vector3();
    resolveWorldAxis(new Vector3(0, 0, 1), parentWorldQuat(node), null, out);
    expectVec(out, 1, 0, 0); // R_y(90°)·(0,0,1) = (1,0,0)
  });

  it('applies the base (home) quaternion before the parent rotation (rotary path)', () => {
    const base = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), Math.PI / 2);
    const out = new Vector3();
    resolveWorldAxis(new Vector3(0, 1, 0), new Quaternion(), base, out);
    expectVec(out, 0, 0, 1); // R_x(90°)·(0,1,0) = (0,0,1)
  });

  it('composes parent ⊗ base ⊗ axis in the right order', () => {
    const root = new Object3D();
    const parent = new Object3D();
    parent.rotation.y = Math.PI / 2;
    root.add(parent);
    const node = new Object3D();
    parent.add(node);
    root.updateMatrixWorld(true);

    const base = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), Math.PI / 2);
    const out = new Vector3();
    resolveWorldAxis(new Vector3(0, 1, 0), parentWorldQuat(node), base, out);
    // base: (0,1,0) → (0,0,1); parent R_y(90°): (0,0,1) → (1,0,0)
    expectVec(out, 1, 0, 0);
  });

  it('normalizes under a scaled parent world quaternion input', () => {
    const out = new Vector3();
    resolveWorldAxis(new Vector3(0, 0, 1), new Quaternion(), null, out);
    expect(out.length()).toBeCloseTo(1, 6);
  });

  it('produces no NaN through the gizmo orientation pipeline for an antiparallel axis', () => {
    // Plugin pipeline: worldAxis → setFromUnitVectors(UP, worldAxis).
    // (0,-1,0) is exactly antiparallel to UP — three >= 0.171 handles this
    // internally, the plugin adds no manual special-case (plan-249 §10.7).
    const out = new Vector3();
    resolveWorldAxis(new Vector3(0, -1, 0), new Quaternion(), null, out);
    const q = new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), out);
    expect(Number.isNaN(q.x)).toBe(false);
    expect(Number.isNaN(q.y)).toBe(false);
    expect(Number.isNaN(q.z)).toBe(false);
    expect(Number.isNaN(q.w)).toBe(false);
    const check = new Vector3(0, 1, 0).applyQuaternion(q);
    expectVec(check, 0, -1, 0);
  });
});

describe('screen-constant gizmo scaling', () => {
  it('perspectiveViewportWorldHeight grows linearly with distance', () => {
    const h1 = perspectiveViewportWorldHeight(50, 10);
    const h2 = perspectiveViewportWorldHeight(50, 20);
    expect(h2).toBeCloseTo(2 * h1, 6);
    // 2 * tan(25°) * 10 for fov=50, dist=10
    expect(h1).toBeCloseTo(2 * Math.tan((25 * Math.PI) / 180) * 10, 6);
  });

  it('wider FOV yields a larger world height at the same distance', () => {
    expect(perspectiveViewportWorldHeight(70, 10))
      .toBeGreaterThan(perspectiveViewportWorldHeight(40, 10));
  });

  it('computeGizmoScale maps the design height onto the max screen fraction', () => {
    const vwh = perspectiveViewportWorldHeight(50, 12);
    const s = computeGizmoScale(vwh);
    // A gizmo of GIZMO_DESIGN_HEIGHT design units, scaled by s, spans this
    // fraction of the viewport height:
    const fraction = (s * GIZMO_DESIGN_HEIGHT) / vwh;
    expect(fraction).toBeCloseTo(GIZMO_MAX_SCREEN_FRAC, 6);
  });

  it('minGizmoScale maps the design height onto the min screen fraction', () => {
    const vwh = perspectiveViewportWorldHeight(50, 12);
    const fraction = (minGizmoScale(vwh) * GIZMO_DESIGN_HEIGHT) / vwh;
    expect(fraction).toBeCloseTo(GIZMO_MIN_SCREEN_FRAC, 6);
  });

  it('scale is screen-constant: cap/distance is invariant across distances', () => {
    const capNear = computeGizmoScale(perspectiveViewportWorldHeight(50, 5));
    const capFar = computeGizmoScale(perspectiveViewportWorldHeight(50, 50));
    expect(capNear / 5).toBeCloseTo(capFar / 50, 9);
  });
});
