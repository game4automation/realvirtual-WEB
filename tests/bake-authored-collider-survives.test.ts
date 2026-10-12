// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * A collider on a node that draws nothing is authored physics geometry and
 * survives the bake (2026-09-24).
 *
 * The Festo hopper's closure plate is an empty `BoxCollider` node under the
 * slide mesh of the `AxisHopper_Push` group; the physics plugin finds moving
 * colliders by traversing the drive's SURVIVING subtree. `BoxCollider` is a
 * `claimsNode: false` annotation (plan-755 frozen set), so the node was pruned,
 * no body existed for the closed slide, and the logos fell through. The mesh
 * test keeps the Unity export markers on CAD meshes (Mauser: thousands) pure
 * annotation.
 */
import { describe, it, expect } from 'vitest';
import '../src/core/engine/rv-scene-loader';
import { RVUberMaterial } from '../src/core/engine/rv-uber-material';
import { carriesAuthoredCollider, computeSurvival } from '../src/core/engine/rv-bake-survival';
import { group, uberMesh, withComponent } from './fixtures/bake-fixture';
import { registryFor } from './helpers/bake-survival';

const uber = new RVUberMaterial(false);
const BOX = { center: { x: 0, y: 0, z: 0 }, size: { x: 0.08, y: 0.002, z: 0.1 } };

describe('authored collider nodes survive the bake', () => {
  it('an empty BoxCollider node under a drive survives as component; the same marker on a mesh does not claim', () => {
    const root = group('Festo');
    const axis = withComponent(group('AxisHopper_Push'), 'Drive', { Direction: 'LinearX' });
    const slide = withComponent(uberMesh(uber, '91'), 'Group', { GroupName: 'AxisHopper_Push' });
    const plate = withComponent(group('PayloadPlate'), 'BoxCollider', BOX);
    slide.add(plate);
    axis.add(slide);
    // A CAD mesh with the Unity export marker only — annotation, stays merged.
    const casing = uberMesh(uber, 'Casing');
    casing.userData.realvirtual = { colliders: [{ type: 'box', center: [0, 0, 0], size: [1, 1, 1] }] };
    root.add(axis, casing);

    const model = computeSurvival(root, registryFor(root));
    expect(model.reasonOf(plate)).toBe('component');
    expect(model.reasonOf(casing)).toBeNull();
    // The slide mesh itself is kept only as the plate's ancestor.
    expect(model.reasonOf(slide)).toBe('ancestor');
  });

  it('carriesAuthoredCollider reads BoxCollider and a non-empty colliders list, nothing else', () => {
    expect(carriesAuthoredCollider({ BoxCollider: BOX })).toBe(true);
    expect(carriesAuthoredCollider({ colliders: [{ type: 'box' }] })).toBe(true);
    expect(carriesAuthoredCollider({ colliders: [] })).toBe(false);
    expect(carriesAuthoredCollider({ rigidbody: { mass: 1 } })).toBe(false);
    expect(carriesAuthoredCollider({})).toBe(false);
  });
});
