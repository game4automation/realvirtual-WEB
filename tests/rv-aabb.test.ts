// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * AABB Unit Tests
 *
 * Tests the Axis-Aligned Bounding Box overlap detection used by
 * TransportSurface, Sensor, Source, and Sink components.
 */
import { describe, it, expect } from 'vitest';
import { Vector3, Object3D } from 'three';
import { AABB } from '../src/core/engine/rv-aabb';

describe('AABB', () => {
  it('should create AABB with correct min/max from halfSize', () => {
    const node = new Object3D();
    node.position.set(1, 2, 3);

    const aabb = AABB.fromHalfSize(node, new Vector3(0.5, 0.5, 0.5));

    expect(aabb.center.x).toBeCloseTo(1);
    expect(aabb.center.y).toBeCloseTo(2);
    expect(aabb.center.z).toBeCloseTo(3);
    expect(aabb.min.x).toBeCloseTo(0.5);
    expect(aabb.min.y).toBeCloseTo(1.5);
    expect(aabb.min.z).toBeCloseTo(2.5);
    expect(aabb.max.x).toBeCloseTo(1.5);
    expect(aabb.max.y).toBeCloseTo(2.5);
    expect(aabb.max.z).toBeCloseTo(3.5);
  });

  it('should detect overlapping AABBs', () => {
    const nodeA = new Object3D();
    nodeA.position.set(0, 0, 0);
    const aabbA = AABB.fromHalfSize(nodeA, new Vector3(1, 1, 1));

    const nodeB = new Object3D();
    nodeB.position.set(1.5, 0, 0);
    const aabbB = AABB.fromHalfSize(nodeB, new Vector3(1, 1, 1));

    expect(aabbA.overlaps(aabbB)).toBe(true);
    expect(aabbB.overlaps(aabbA)).toBe(true);
  });

  it('should detect non-overlapping AABBs', () => {
    const nodeA = new Object3D();
    nodeA.position.set(0, 0, 0);
    const aabbA = AABB.fromHalfSize(nodeA, new Vector3(1, 1, 1));

    const nodeB = new Object3D();
    nodeB.position.set(3, 0, 0);
    const aabbB = AABB.fromHalfSize(nodeB, new Vector3(1, 1, 1));

    expect(aabbA.overlaps(aabbB)).toBe(false);
  });

  it('should detect edge-touching AABBs as overlapping', () => {
    const nodeA = new Object3D();
    nodeA.position.set(0, 0, 0);
    const aabbA = AABB.fromHalfSize(nodeA, new Vector3(1, 1, 1));

    const nodeB = new Object3D();
    nodeB.position.set(2, 0, 0); // Exactly touching at x=1
    const aabbB = AABB.fromHalfSize(nodeB, new Vector3(1, 1, 1));

    expect(aabbA.overlaps(aabbB)).toBe(true);
  });

  it('should update position after node moves', () => {
    const node = new Object3D();
    node.position.set(0, 0, 0);
    const aabb = AABB.fromHalfSize(node, new Vector3(0.5, 0.5, 0.5));

    expect(aabb.center.x).toBeCloseTo(0);

    // Move node
    node.position.set(5, 0, 0);
    aabb.update();

    expect(aabb.center.x).toBeCloseTo(5);
    expect(aabb.min.x).toBeCloseTo(4.5);
    expect(aabb.max.x).toBeCloseTo(5.5);
  });

  it('should handle BoxCollider with center offset and X-flip', () => {
    const node = new Object3D();
    node.position.set(0, 0, 0);

    // BoxCollider center (in GLB space, X already negated from Unity)
    const center = { x: 0.5, y: 0, z: 0 };
    const size = { x: 2, y: 1, z: 1 };

    const aabb = AABB.fromBoxCollider(node, center, size);

    // X should be negated for glTF coordinate conversion
    expect(aabb.center.x).toBeCloseTo(-0.5);
    expect(aabb.halfSize.x).toBeCloseTo(1);
    expect(aabb.halfSize.y).toBeCloseTo(0.5);
  });

  it('should detect XZ overlap even when Y does not overlap', () => {
    // Simulates MU sitting ON a transport surface belt — Y gap but XZ overlap
    const surface = new Object3D();
    surface.position.set(2, 0.38, -2);
    const surfaceAABB = AABB.fromHalfSize(surface, new Vector3(0.25, 0.025, 0.8));

    const mu = new Object3D();
    mu.position.set(2, 0.53, -2);
    const muAABB = AABB.fromHalfSize(mu, new Vector3(0.19, 0.12, 0.19));

    // Full 3D overlap fails (Y gap)
    expect(surfaceAABB.overlaps(muAABB)).toBe(false);
    // XZ overlap succeeds (MU is above the belt)
    expect(surfaceAABB.overlapsXZ(muAABB)).toBe(true);
  });

  it('should correctly overlap after both AABBs move', () => {
    const nodeA = new Object3D();
    nodeA.position.set(0, 0, 0);
    const aabbA = AABB.fromHalfSize(nodeA, new Vector3(0.5, 0.5, 0.5));

    const nodeB = new Object3D();
    nodeB.position.set(10, 0, 0);
    const aabbB = AABB.fromHalfSize(nodeB, new Vector3(0.5, 0.5, 0.5));

    expect(aabbA.overlaps(aabbB)).toBe(false);

    // Move B next to A
    nodeB.position.set(0.5, 0, 0);
    aabbB.update();

    expect(aabbA.overlaps(aabbB)).toBe(true);
  });
});
