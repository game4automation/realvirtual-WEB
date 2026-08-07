// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * drive-offset-kinematic-pivot.test.ts — LOP-68 repro.
 *
 * Customer report: with a NESTED kinematic, setting an `Offset` on the
 * superordinate LINEAR drive does not move the pivot of the subordinate
 * ROTARY axis along with it, so that axis rotates about the wrong point.
 *
 * The suspicion under test is the loader's home-pose window
 * (rv-scene-loader.ts Phase 8a, ~line 1634):
 *
 *     drive.currentPosition = drive.StartPosition;
 *     drive.applyToNode();
 *
 * This neutralises `StartPosition` but NOT `Offset` — `applyToNode()` keeps
 * adding it (rv-drive.ts:610). A drive carrying an Offset therefore stands
 * displaced by exactly that Offset while Phase 8b re-parents the kinematic
 * group with world-preserving `attach()`. The child's local transform is
 * then measured against the displaced parent, and `refreshBaseTransform()`
 * caches that as its home — the Offset is frozen out of the child.
 *
 * The scene is built so both parts are COINCIDENT as authored: `DirectPart`
 * is a plain child of the linear drive, `RotPart` reaches the same drive
 * through the kinematic group. Whatever the Offset does, it must do to both.
 */

import { describe, it, expect } from 'vitest';
import {
  BoxGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  Scene,
  Vector3,
} from 'three';
import { loadGLB } from '../src/core/engine/rv-scene-loader';
import { objectToGlb } from '../src/core/import/rv-import-object';

/** mm → m, mirrors MM_TO_METERS in rv-constants. */
const MM = 1 / 1000;

/**
 * Nested kinematic: a linear X drive that carries a rotary Y drive through a
 * kinematic group, plus a directly-parented reference part.
 *
 *   Cell
 *   ├── Axis1                    Drive LinearX (Offset = `offsetMm`)
 *   │   └── DirectPart           plain child — moves with the drive node
 *   └── RotAxis                  Drive RotationY, member of group "RotGroup"
 *       └── RotPart              offset along +Z so a rotation is measurable
 *
 * `Axis1` additionally carries the Kinematic component that pulls "RotGroup"
 * underneath it during Phase 8b.
 */
async function buildFixture(offsetMm: number): Promise<ArrayBuffer> {
  const root = new Group();
  root.name = 'Cell';

  const axis1 = new Object3D();
  axis1.name = 'Axis1';
  axis1.userData.realvirtual = {
    Drive: { Direction: 'LinearX', Offset: offsetMm },
    Kinematic: { IntegrateGroupEnable: true, GroupName: 'RotGroup' },
  };
  const directPart = new Mesh(new BoxGeometry(0.2, 0.2, 0.2), new MeshStandardMaterial());
  directPart.name = 'DirectPart';
  axis1.add(directPart);
  root.add(axis1);

  const rotAxis = new Object3D();
  rotAxis.name = 'RotAxis';
  rotAxis.userData.realvirtual = {
    Drive: { Direction: 'RotationY' },
    Group: { GroupName: 'RotGroup' },
  };
  const rotPart = new Mesh(new BoxGeometry(0.2, 0.2, 0.2), new MeshStandardMaterial());
  rotPart.name = 'RotPart';
  rotPart.position.set(0, 0, 0.5);
  rotAxis.add(rotPart);
  root.add(rotAxis);

  return objectToGlb(root);
}

async function loadFixture(offsetMm: number): Promise<{
  axis1World: Vector3;
  pivotWorld: Vector3;
  directWorld: Vector3;
}> {
  const glb = await buildFixture(offsetMm);
  const scene = new Scene();
  const result = await loadGLB(`memory://lop68-offset-${offsetMm}.glb`, scene, { data: glb });
  result.root.updateMatrixWorld(true);

  const axis1 = result.root.getObjectByName('Axis1')!;
  const rotAxis = result.root.getObjectByName('RotAxis')!;
  const directPart = result.root.getObjectByName('DirectPart')!;
  expect(rotAxis.parent).toBe(axis1); // Phase 8b really ran

  return {
    axis1World: axis1.getWorldPosition(new Vector3()),
    pivotWorld: rotAxis.getWorldPosition(new Vector3()),
    directWorld: directPart.getWorldPosition(new Vector3()),
  };
}

describe('LOP-68 — Drive.Offset and the pivot of a nested rotary axis', () => {
  // Control: without an Offset the two paths into the drive must agree.
  // If this fails the fixture is wrong, not the loader.
  it('without Offset the group-attached pivot sits on the direct child', async () => {
    const { axis1World, pivotWorld, directWorld } = await loadFixture(0);

    expect(pivotWorld.distanceTo(directWorld)).toBeLessThan(1e-6);
    expect(pivotWorld.distanceTo(axis1World)).toBeLessThan(1e-6);
  });

  it('with Offset the pivot travels with the drive, like the direct child does', async () => {
    const offsetMm = 100;
    const { axis1World, pivotWorld, directWorld } = await loadFixture(offsetMm);

    // Measured before the fix (Offset 100 mm = 0.1 m; -X is the expected
    // LinearX → glTF handedness flip):
    //   axis1  = [-0.2, 0, 0]   ← TWICE the Offset
    //   direct = [-0.2, 0, 0]   ← rides along with the node, consistent
    //   pivot  = [-0.1, 0, 0]   ← one Offset behind the part it belongs to
    //
    // Two distinct defects, one root cause — Phase 8a leaves `Offset` applied:
    //  1. applyKinematicParenting Pass 3 calls refreshBaseTransform() on EVERY
    //     drive in the affected subtree, including the kinematic node's own
    //     drive, which was never re-parented. It stands at basePosition+Offset,
    //     so that becomes the new basePosition and Phase 10e adds the Offset a
    //     second time.
    //  2. The group member is attached world-preserving against that displaced
    //     parent, so the Offset is frozen out of the child — its pivot lags by
    //     exactly one Offset, and the rotary axis turns about the wrong point.
    expect(axis1World.length()).toBeCloseTo(offsetMm * MM, 6);
    // A plain child rides along, by construction of the scene graph.
    expect(directWorld.distanceTo(axis1World)).toBeLessThan(1e-6);

    // The claim under test: the group-attached rotary axis must end up in the
    // same place as the coincident direct child.
    expect(pivotWorld.distanceTo(directWorld)).toBeLessThan(1e-6);
  });
});
