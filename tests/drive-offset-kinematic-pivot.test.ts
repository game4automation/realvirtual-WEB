// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * drive-offset-kinematic-pivot.test.ts — LOP-68 repro.
 *
 * Customer report: with a NESTED kinematic, setting an `Offset` on the
 * superordinate LINEAR drive does not move the pivot of the subordinate
 * ROTARY axis along with it, so that axis rotates about the wrong point.
 *
 * History of the defect: the loader's home-pose window (Phase 8a) used to run
 *
 *     drive.currentPosition = drive.StartPosition;
 *     drive.applyToNode();
 *
 * which neutralised `StartPosition` but NOT `Offset` — `applyToNode()` keeps
 * adding it. A drive carrying an Offset therefore stood displaced by exactly
 * that Offset while Phase 8b re-parented the kinematic group with
 * world-preserving `attach()`; the child's local transform was measured
 * against the displaced parent and cached as its home — the Offset was frozen
 * out of the child.
 *
 * Since plan-754/757 the re-parenting happens in `prepare` of the recipe (the
 * `Kinematic` pre-bake hook), BEFORE any drive exists, and the `Drive` hook
 * stamps the authored home the init reads; the runtime home-pose window is
 * gone (plan-757 Phase 3 commit B). The claim is the same, the load is the
 * BAKED one now: the scene is built so both parts are COINCIDENT as authored —
 * `DirectPart` is a plain child of the linear drive, `RotPart` reaches the same
 * drive through the kinematic group. Whatever the Offset does, it must do to
 * both. `DirectPart` is claimed `chunk` so it survives the bake as a node.
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
import { BakeRegistry } from '../src/core/engine/rv-bake-registry';
import { createPickBuildPort } from '../src/core/engine/rv-pick-build-port';
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
  const result = await loadGLB(`memory://lop68-offset-${offsetMm}.glb`, scene, {
    data: glb,
    bakeRegistry: new BakeRegistry(),
    bakePickPort: createPickBuildPort({ createWorker: () => null }),
    // A plain mesh would be merged into Axis1's mover chunk; the claim keeps
    // it a node so its world position can be read (plan-754 D17).
    bakeClaims: [{ path: 'Cell/Axis1/DirectPart', role: 'chunk' }],
  });
  result.root.updateMatrixWorld(true);
  expect(result.bakedAsset).not.toBeNull();

  const axis1 = result.root.getObjectByName('Axis1')!;
  const rotAxis = result.root.getObjectByName('RotAxis')!;
  const directPart = result.root.getObjectByName('DirectPart');
  expect(directPart, 'the claimed DirectPart survives the bake as a node').toBeDefined();
  expect(rotAxis.parent).toBe(axis1); // the Kinematic hook really ran

  return {
    axis1World: axis1.getWorldPosition(new Vector3()),
    pivotWorld: rotAxis.getWorldPosition(new Vector3()),
    directWorld: directPart!.getWorldPosition(new Vector3()),
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
    // Two distinct defects, one root cause — the old Phase 8a left `Offset`
    // applied while the runtime re-parent pass ran (both deleted since):
    //  1. its Pass 3 called refreshBaseTransform() on EVERY drive in the
    //     affected subtree, including the kinematic node's own drive, which
    //     was never re-parented. It stood at basePosition+Offset, so that
    //     became the new basePosition and the restore added the Offset again.
    //  2. The group member was attached world-preserving against that
    //     displaced parent, so the Offset was frozen out of the child — its
    //     pivot lagged by exactly one Offset, and the rotary axis turned about
    //     the wrong point.
    // In the recipe the hook re-parents before any drive exists, so neither
    // can happen — this pins that it stays so.
    expect(axis1World.length()).toBeCloseTo(offsetMm * MM, 6);
    // A plain child rides along, by construction of the scene graph.
    expect(directWorld.distanceTo(axis1World)).toBeLessThan(1e-6);

    // The claim under test: the group-attached rotary axis must end up in the
    // same place as the coincident direct child.
    expect(pivotWorld.distanceTo(directWorld)).toBeLessThan(1e-6);
  });
});
