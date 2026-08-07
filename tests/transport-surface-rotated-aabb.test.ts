// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Rotation-aware transport-surface AABB footprint.
 *
 * Regression guard for the turntable corner-discharge bug: when a turntable
 * platform rotates its (elongated) belt 90°, the surface's collision AABB must
 * follow the rotation so a good can hand off to the perpendicular conveyor. The
 * same code path also fixes the reload case, where the surface AABB is built
 * before the saved layout rotation is applied — the footprint must still end up
 * matching the final world orientation, not the pose it was first constructed at.
 */

import { describe, it, expect } from 'vitest';
import { Object3D, Mesh, BoxGeometry, MeshBasicMaterial, MathUtils } from 'three';
import { RVTransportSurface } from '../src/core/engine/rv-transport-surface';
import { AABB } from '../src/core/engine/rv-aabb';
import type { ComponentContext } from '../src/core/engine/rv-component-registry';

function stubContext(): ComponentContext {
  return {
    registry: { findInParent: () => null } as unknown as ComponentContext['registry'],
    signalStore: null as unknown as ComponentContext['signalStore'],
    scene: null as unknown as ComponentContext['scene'],
    transportManager: { surfaces: [] } as unknown as ComponentContext['transportManager'],
    root: new Object3D(),
  };
}

/**
 * A belt surface elongated along local Z (half-extents ≈ 0.1 × 0.05 × 1.0),
 * built while the parent is at `initialParentRotY`. Returns the surface plus
 * the parent so the test can rotate it after construction.
 */
function makeBeltSurface(initialParentRotY = 0): { surface: RVTransportSurface; parent: Object3D; node: Object3D } {
  const parent = new Object3D();
  parent.rotation.y = initialParentRotY;
  parent.updateMatrixWorld(true);

  const node = new Object3D();
  node.name = 'Transport-Z';
  const mesh = new Mesh(new BoxGeometry(0.2, 0.1, 2.0), new MeshBasicMaterial()); // long in Z
  node.add(mesh);
  parent.add(node);
  parent.updateMatrixWorld(true);

  const aabb = AABB.fromNode(node);
  const surface = new RVTransportSurface(node, aabb);
  surface.init(stubContext());
  return { surface, parent, node };
}

describe('RVTransportSurface — rotation-aware AABB footprint', () => {
  it('keeps the long axis on Z for an un-rotated belt (no change for plain conveyors)', () => {
    const { surface } = makeBeltSurface(0);
    surface.updateAABB();
    expect(surface.aabb.halfSize.x).toBeCloseTo(0.1, 3);
    expect(surface.aabb.halfSize.z).toBeCloseTo(1.0, 3);
  });

  it('swaps the footprint to the X axis after the parent rotates 90° (corner discharge)', () => {
    const { surface, parent, node } = makeBeltSurface(0);
    // Rotate the platform 90° AFTER the AABB was built — the footprint must follow.
    parent.rotation.y = MathUtils.degToRad(90);
    parent.updateMatrixWorld(true);
    node.updateMatrixWorld(true);

    surface.updateAABB();
    // Long axis is now world-X; short axis world-Z.
    expect(surface.aabb.halfSize.x).toBeCloseTo(1.0, 3);
    expect(surface.aabb.halfSize.z).toBeCloseTo(0.1, 3);
  });

  it('reload case: AABB built at identity, then rotated 90°, still matches the final orientation', () => {
    // Mirrors placeFromRecord: the surface (and its AABB) is constructed while the
    // node is un-rotated, and the saved rotation is applied afterwards.
    const { surface, parent, node } = makeBeltSurface(0);
    parent.rotation.y = MathUtils.degToRad(90); // saved layout rotation, applied post-construction
    parent.updateMatrixWorld(true);
    node.updateMatrixWorld(true);

    surface.updateAABB();
    expect(surface.aabb.halfSize.x).toBeCloseTo(1.0, 3);
    expect(surface.aabb.halfSize.z).toBeCloseTo(0.1, 3);
  });
});

describe('RVTransportSurface — child-sensor geometry excluded from footprint', () => {
  // A Transport-Z belt (half 0.1 × 0.05 × 1.0) with one extra child node attached.
  function makeSurfaceWithChild(child: Object3D): RVTransportSurface {
    const parent = new Object3D();
    parent.updateMatrixWorld(true);

    const node = new Object3D();
    node.name = 'Transport-Z';
    node.add(new Mesh(new BoxGeometry(0.2, 0.1, 2.0), new MeshBasicMaterial())); // belt
    node.add(child);
    parent.add(node);
    parent.updateMatrixWorld(true);

    const surface = new RVTransportSurface(node, AABB.fromNode(node));
    surface.init(stubContext());
    return surface;
  }

  it('excludes a child sensor subtree (and its children) from the footprint', () => {
    // Sensor node carries the canonical marker; a WIDE child (half-X 1.5) and a
    // LONG grandchild (half-Z 3.0) would dominate the footprint if not pruned.
    const sensor = new Object3D();
    sensor.name = 'Sensor_(1)';
    sensor.userData.realvirtual = { Sensor: {} };
    const ray = new Mesh(new BoxGeometry(3.0, 0.1, 0.2), new MeshBasicMaterial());
    ray.add(new Mesh(new BoxGeometry(0.1, 0.1, 6.0), new MeshBasicMaterial())); // grandchild
    sensor.add(ray);

    const surface = makeSurfaceWithChild(sensor);
    surface.updateAABB();
    // Belt only — the sensor's wide/long geometry is excluded.
    expect(surface.aabb.halfSize.x).toBeCloseTo(0.1, 3);
    expect(surface.aabb.halfSize.z).toBeCloseTo(1.0, 3);
  });

  it('still includes ordinary (non-sensor) child meshes', () => {
    // The same wide mesh, but NOT marked as a sensor, must widen the footprint
    // (guards against pruning more than just sensors).
    const extra = new Mesh(new BoxGeometry(3.0, 0.1, 0.2), new MeshBasicMaterial());
    const surface = makeSurfaceWithChild(extra);
    surface.updateAABB();
    expect(surface.aabb.halfSize.x).toBeCloseTo(1.5, 3);
  });

  it('excludes a baked raycast-BVH helper (it re-bundles belt + sensor geometry)', () => {
    // The per-Drive raycast BVH bakes the whole drive subtree (belt + sensor)
    // into one mesh under the surface; counting it would re-add the sensor.
    const bvh = new Mesh(new BoxGeometry(3.0, 0.5, 0.2), new MeshBasicMaterial());
    bvh.name = '__raycastBVH_Transport-Z';
    bvh.userData._rvRaycastBVH = true;
    const surface = makeSurfaceWithChild(bvh);
    surface.updateAABB();
    expect(surface.aabb.halfSize.x).toBeCloseTo(0.1, 3); // belt only, not 1.5
    expect(surface.aabb.halfSize.y).toBeCloseTo(0.05, 3);
  });

  it('excludes a BatchedMesh render arena', () => {
    const arena = new Mesh(new BoxGeometry(3.0, 0.5, 0.2), new MeshBasicMaterial());
    arena.name = '__driveUberBatch_Transport-Z';
    arena.userData._rvBatchedRender = true;
    const surface = makeSurfaceWithChild(arena);
    surface.updateAABB();
    expect(surface.aabb.halfSize.x).toBeCloseTo(0.1, 3);
  });
});
