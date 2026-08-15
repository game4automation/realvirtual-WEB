// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * A KinematicMechanism moves its PASSIVE links (a Delta's rods and platform) by
 * writing their node transforms every tick. Those links carry `Kinematic` — a
 * rigid group — and no Drive of their own.
 *
 * Before this was fixed, `processMeshes()` classified "not under a Drive" as
 * static and set `matrixAutoUpdate = false`, so the solver's writes never
 * reached matrixWorld. The same classification feeds the arena partition, which
 * parked those meshes in the root-parented static arena. Net effect: a mechanism
 * that jogs perfectly in the asset editor (which skips both passes) shows frozen
 * rods in every merged load.
 */

import { describe, it, expect } from 'vitest';
import { Object3D, Mesh, BoxGeometry, MeshStandardMaterial } from 'three';
import { processMeshes } from '../src/core/engine/rv-scene-loader';

function meshNode(name: string, extras?: Record<string, unknown>): Mesh {
  const mesh = new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial());
  mesh.name = name;
  if (extras) mesh.userData.realvirtual = extras;
  return mesh;
}

function groupNode(name: string, extras?: Record<string, unknown>): Object3D {
  const node = new Object3D();
  node.name = name;
  if (extras) node.userData.realvirtual = extras;
  return node;
}

describe('processMeshes — motion classification', () => {
  it('keeps meshes under a Kinematic rigid group matrix-dynamic', () => {
    const root = new Object3D();
    const rodBody = groupNode('RodBody_000_p', { Kinematic: { GroupName: 'RodBody_000_p' } });
    const rodMesh = meshNode('MT_WST00069206_4');
    rodBody.add(rodMesh);
    root.add(rodBody);

    const { driveNodeSet } = processMeshes(root);

    expect(driveNodeSet.has(rodBody)).toBe(true);
    // The decisive assertion: a frozen mesh can never be moved by the solver.
    expect(rodMesh.matrixAutoUpdate).toBe(true);
  });

  it('still freezes genuinely static geometry', () => {
    const root = new Object3D();
    const frame = groupNode('Frame');
    const frameMesh = meshNode('MT_WST00054870');
    frame.add(frameMesh);
    root.add(frame);

    processMeshes(root);

    expect(frameMesh.matrixAutoUpdate).toBe(false);
  });

  it('keeps Drive subtrees dynamic (unchanged behaviour)', () => {
    const root = new Object3D();
    const axis = groupNode('AxisArm_000', {
      Kinematic: { GroupName: 'AxisArm_000' },
      Drive: { Direction: 'RotationZ' },
    });
    const armMesh = meshNode('MT_WST00061379_2');
    axis.add(armMesh);
    root.add(axis);

    const { driveNodeSet } = processMeshes(root);

    expect(driveNodeSet.has(axis)).toBe(true);
    expect(armMesh.matrixAutoUpdate).toBe(true);
  });

  it('does NOT anchor on descriptive kinematic nodes', () => {
    // A mechanism container is typically an ancestor of the whole asset; making
    // it an anchor would pull every mesh into one motion blob.
    const root = new Object3D();
    const mechanism = groupNode('DeltaMechanism', {
      KinematicMechanism: { SolverIterations: 4 },
    });
    const joint = groupNode('J_Rev_000', { KinematicJoint: { JointType: 'Revolute' } });
    mechanism.add(joint);
    root.add(mechanism);

    const { driveNodeSet } = processMeshes(root);

    expect(driveNodeSet.has(mechanism)).toBe(false);
    expect(driveNodeSet.has(joint)).toBe(false);
  });
});
