// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Physics Collider Position Tests
 *
 * Integration tests verifying that Rapier collider positions computed via
 * `localToWorld(localCenter)` match the expected world-space positions
 * under various transform scenarios (identity, rotated, scaled, nested).
 *
 * These tests catch coordinate system mismatches (Unity LHS → glTF RHS)
 * and transform chain issues without needing a full GLB scene.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import RAPIER from '@dimforge/rapier3d-compat';
import { Vector3, Quaternion, Object3D, MathUtils } from 'three';
import { AABB } from '../src/core/engine/rv-aabb';
import { RVPhysicsWorld } from '../src/core/engine/rv-physics-world';

beforeAll(async () => {
  await RAPIER.init();
});

// ─── Helper: simulate computeWorldCenter (same logic as rapier-physics-plugin.ts) ───

const _localCenter = new Vector3();

function computeWorldCenter(node: Object3D, aabb: AABB): { x: number; y: number; z: number } {
  node.updateWorldMatrix(true, false);
  _localCenter.copy(aabb.localCenter);
  node.localToWorld(_localCenter);
  return { x: _localCenter.x, y: _localCenter.y, z: _localCenter.z };
}

function getScaledHalfExtents(node: Object3D, aabb: AABB) {
  const _worldScale = new Vector3();
  node.getWorldScale(_worldScale);
  return {
    x: aabb.halfSize.x * Math.abs(_worldScale.x),
    y: aabb.halfSize.y * Math.abs(_worldScale.y),
    z: aabb.halfSize.z * Math.abs(_worldScale.z),
  };
}

// ─── 1. Identity Transform ───────────────────────────────────────

describe('Collider Position: Identity Transform', () => {
  it('BoxCollider center at origin → world center equals node position', () => {
    const node = new Object3D();
    node.position.set(2, 0.5, 3);
    node.updateMatrixWorld(true);

    // Unity BoxCollider.center = (0, 0, 0)
    const aabb = AABB.fromBoxCollider(node, { x: 0, y: 0, z: 0 }, { x: 1, y: 0.5, z: 2 });
    const center = computeWorldCenter(node, aabb);

    expect(center.x).toBeCloseTo(2);
    expect(center.y).toBeCloseTo(0.5);
    expect(center.z).toBeCloseTo(3);
  });

  it('BoxCollider center offset in Y → collider is above node pivot', () => {
    const node = new Object3D();
    node.position.set(1, 0, 2);
    node.updateMatrixWorld(true);

    // Unity BoxCollider.center = (0, 0.1, 0) — slightly above pivot
    const aabb = AABB.fromBoxCollider(node, { x: 0, y: 0.1, z: 0 }, { x: 1, y: 0.2, z: 1 });
    const center = computeWorldCenter(node, aabb);

    expect(center.x).toBeCloseTo(1);
    expect(center.y).toBeCloseTo(0.1); // 0 + 0.1
    expect(center.z).toBeCloseTo(2);
  });

  it('BoxCollider center offset in X → X is negated for glTF', () => {
    const node = new Object3D();
    node.position.set(0, 0, 0);
    node.updateMatrixWorld(true);

    // Unity BoxCollider.center = (0.5, 0, 0) → glTF localCenter = (-0.5, 0, 0)
    const aabb = AABB.fromBoxCollider(node, { x: 0.5, y: 0, z: 0 }, { x: 1, y: 1, z: 1 });
    const center = computeWorldCenter(node, aabb);

    expect(center.x).toBeCloseTo(-0.5); // Negated X
    expect(center.y).toBeCloseTo(0);
    expect(center.z).toBeCloseTo(0);
  });
});

// ─── 2. Rotated Node ─────────────────────────────────────────────

describe('Collider Position: Rotated Node', () => {
  it('90° rotation around Y → X offset becomes Z offset', () => {
    const node = new Object3D();
    node.position.set(0, 0, 0);
    node.quaternion.setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2);
    node.updateMatrixWorld(true);

    // Unity BoxCollider.center = (0, 0, 1) → glTF localCenter = (0, 0, 1)
    const aabb = AABB.fromBoxCollider(node, { x: 0, y: 0, z: 1 }, { x: 1, y: 1, z: 1 });
    const center = computeWorldCenter(node, aabb);

    // After 90° Y rotation, local Z=1 maps to world X direction
    // (exact mapping depends on rotation direction)
    const dist = Math.sqrt(center.x * center.x + center.z * center.z);
    expect(dist).toBeCloseTo(1, 3); // Should be 1 unit away
    expect(center.y).toBeCloseTo(0);
  });

  it('180° rotation around Y → X offset is reflected', () => {
    const node = new Object3D();
    node.position.set(5, 0, 0);
    node.quaternion.setFromAxisAngle(new Vector3(0, 1, 0), Math.PI);
    node.updateMatrixWorld(true);

    // Unity BoxCollider.center = (0.5, 0, 0) → glTF localCenter = (-0.5, 0, 0)
    const aabb = AABB.fromBoxCollider(node, { x: 0.5, y: 0, z: 0 }, { x: 1, y: 1, z: 1 });
    const center = computeWorldCenter(node, aabb);

    // After 180° Y rotation, local X=-0.5 rotates to world X=+0.5
    expect(center.x).toBeCloseTo(5.5, 3);
    expect(center.y).toBeCloseTo(0);
    expect(center.z).toBeCloseTo(0, 3);
  });
});

// ─── 3. Scaled Node ──────────────────────────────────────────────

describe('Collider Position: Scaled Node', () => {
  it('uniform scale 2x → offset doubles', () => {
    const node = new Object3D();
    node.position.set(0, 0, 0);
    node.scale.set(2, 2, 2);
    node.updateMatrixWorld(true);

    // Unity BoxCollider.center = (0, 0.1, 0) → glTF localCenter = (0, 0.1, 0)
    const aabb = AABB.fromBoxCollider(node, { x: 0, y: 0.1, z: 0 }, { x: 1, y: 0.2, z: 1 });
    const center = computeWorldCenter(node, aabb);

    expect(center.x).toBeCloseTo(0);
    expect(center.y).toBeCloseTo(0.2); // 0.1 * 2
    expect(center.z).toBeCloseTo(0);
  });

  it('non-uniform scale → offset scaled per axis', () => {
    const node = new Object3D();
    node.position.set(1, 0, 0);
    node.scale.set(3, 1, 2);
    node.updateMatrixWorld(true);

    // Unity BoxCollider.center = (1, 0.5, 0.5) → glTF localCenter = (-1, 0.5, 0.5)
    const aabb = AABB.fromBoxCollider(node, { x: 1, y: 0.5, z: 0.5 }, { x: 2, y: 1, z: 1 });
    const center = computeWorldCenter(node, aabb);

    // localCenter (-1, 0.5, 0.5) × scale (3, 1, 2) = (-3, 0.5, 1)
    expect(center.x).toBeCloseTo(1 + (-3)); // -2
    expect(center.y).toBeCloseTo(0.5);
    expect(center.z).toBeCloseTo(1);
  });

  it('halfExtents are scaled by world scale', () => {
    const node = new Object3D();
    node.scale.set(2, 3, 0.5);
    node.updateMatrixWorld(true);

    const aabb = AABB.fromBoxCollider(node, { x: 0, y: 0, z: 0 }, { x: 1, y: 2, z: 4 });
    const he = getScaledHalfExtents(node, aabb);

    expect(he.x).toBeCloseTo(0.5 * 2);  // halfSize.x * scale.x
    expect(he.y).toBeCloseTo(1.0 * 3);  // halfSize.y * scale.y
    expect(he.z).toBeCloseTo(2.0 * 0.5); // halfSize.z * scale.z
  });
});

// ─── 4. Nested Parent-Child Transforms ───────────────────────────

describe('Collider Position: Nested Transforms', () => {
  it('parent translated → child position is additive', () => {
    const parent = new Object3D();
    parent.position.set(10, 0, 0);

    const child = new Object3D();
    child.position.set(1, 0, 0);
    parent.add(child);
    parent.updateMatrixWorld(true);

    const aabb = AABB.fromBoxCollider(child, { x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 1 });
    const center = computeWorldCenter(child, aabb);

    expect(center.x).toBeCloseTo(11); // 10 + 1
    expect(center.y).toBeCloseTo(0);
    expect(center.z).toBeCloseTo(0);
  });

  it('parent rotated 90° Y → child position is rotated', () => {
    const parent = new Object3D();
    parent.position.set(0, 0, 0);
    parent.quaternion.setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2);

    const child = new Object3D();
    child.position.set(2, 0, 0); // 2 units in child local X
    parent.add(child);
    parent.updateMatrixWorld(true);

    // No BoxCollider offset
    const aabb = AABB.fromBoxCollider(child, { x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 1 });
    const center = computeWorldCenter(child, aabb);

    // After parent 90° Y rotation, child local X=2 maps to world Z=-2 (or similar)
    const dist = Math.sqrt(center.x * center.x + center.z * center.z);
    expect(dist).toBeCloseTo(2, 3);
    expect(center.y).toBeCloseTo(0);
  });

  it('parent scaled → child halfExtents and offset are scaled', () => {
    const parent = new Object3D();
    parent.position.set(0, 0, 0);
    parent.scale.set(2, 2, 2);

    const child = new Object3D();
    child.position.set(1, 0, 0);
    parent.add(child);
    parent.updateMatrixWorld(true);

    // Unity center = (0, 0.05, 0)
    const aabb = AABB.fromBoxCollider(child, { x: 0, y: 0.05, z: 0 }, { x: 0.5, y: 0.1, z: 0.5 });
    const center = computeWorldCenter(child, aabb);

    // child world position = (0,0,0) + 2*(1,0,0) = (2,0,0)
    // localCenter offset = (0, 0.05, 0) scaled by worldScale(2,2,2) = (0, 0.1, 0)
    expect(center.x).toBeCloseTo(2);
    expect(center.y).toBeCloseTo(0.1);
    expect(center.z).toBeCloseTo(0);

    // halfExtents should be scaled too
    const he = getScaledHalfExtents(child, aabb);
    expect(he.x).toBeCloseTo(0.25 * 2); // 0.5
    expect(he.y).toBeCloseTo(0.05 * 2); // 0.1
    expect(he.z).toBeCloseTo(0.25 * 2); // 0.5
  });

  it('parent rotated + child rotated + offset → correct world position', () => {
    const parent = new Object3D();
    parent.position.set(5, 0, 5);
    parent.quaternion.setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 4); // 45° Y

    const child = new Object3D();
    child.position.set(1, 0, 0);
    parent.add(child);
    parent.updateMatrixWorld(true);

    // Unity center = (0, 0.1, 0) → glTF localCenter = (0, 0.1, 0)
    const aabb = AABB.fromBoxCollider(child, { x: 0, y: 0.1, z: 0 }, { x: 1, y: 0.2, z: 1 });
    const center = computeWorldCenter(child, aabb);

    // Verify against Three.js built-in localToWorld
    const expectedCenter = new Vector3(0, 0.1, 0);
    child.localToWorld(expectedCenter);

    expect(center.x).toBeCloseTo(expectedCenter.x, 4);
    expect(center.y).toBeCloseTo(expectedCenter.y, 4);
    expect(center.z).toBeCloseTo(expectedCenter.z, 4);
  });
});

// ─── 5. Rapier Body Position Matches computeWorldCenter ──────────

describe('Rapier Body Position Matches Computed Center', () => {
  let pw: RVPhysicsWorld;

  beforeEach(() => {
    pw = new RVPhysicsWorld(RAPIER);
    pw.init({ gravity: { x: 0, y: -9.81, z: 0 }, friction: 1.5 });
  });

  it('surface body position matches localToWorld result', () => {
    const node = new Object3D();
    node.position.set(3, 0.5, -2);
    node.quaternion.setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 6); // 30° Y
    node.updateMatrixWorld(true);

    // Unity center = (0, 0.05, 0) → small Y offset
    const aabb = AABB.fromBoxCollider(node, { x: 0, y: 0.05, z: 0 }, { x: 2, y: 0.1, z: 1 });

    const center = computeWorldCenter(node, aabb);
    const rotation = new Quaternion();
    node.getWorldQuaternion(rotation);
    const he = getScaledHalfExtents(node, aabb);

    pw.addConveyorSurface(
      'test_surface',
      center,
      { x: rotation.x, y: rotation.y, z: rotation.z, w: rotation.w },
      he,
      { x: 0, y: 0, z: 1 },
      0.5,
    );

    // Read back from Rapier
    const bodies = pw.getDebugBodies();
    const surfaceBody = bodies.find(b => b.id === 'test_surface');
    expect(surfaceBody).toBeDefined();

    expect(surfaceBody!.position.x).toBeCloseTo(center.x, 4);
    expect(surfaceBody!.position.y).toBeCloseTo(center.y, 4);
    expect(surfaceBody!.position.z).toBeCloseTo(center.z, 4);

    pw.dispose();
  });

  it('sensor body position matches localToWorld result', () => {
    const parent = new Object3D();
    parent.position.set(0, 0, 5);
    parent.scale.set(1.5, 1.5, 1.5);

    const node = new Object3D();
    node.position.set(0, 0.3, 0);
    parent.add(node);
    parent.updateMatrixWorld(true);

    const aabb = AABB.fromBoxCollider(node, { x: 0, y: 0, z: 0 }, { x: 0.2, y: 0.4, z: 0.2 });
    const center = computeWorldCenter(node, aabb);
    const rotation = new Quaternion();
    node.getWorldQuaternion(rotation);
    const he = getScaledHalfExtents(node, aabb);

    pw.addSensor(
      'test_sensor',
      center,
      { x: rotation.x, y: rotation.y, z: rotation.z, w: rotation.w },
      he,
    );

    const bodies = pw.getDebugBodies();
    const sensorBody = bodies.find(b => b.id === 'test_sensor');
    expect(sensorBody).toBeDefined();

    expect(sensorBody!.position.x).toBeCloseTo(center.x, 4);
    expect(sensorBody!.position.y).toBeCloseTo(center.y, 4);
    expect(sensorBody!.position.z).toBeCloseTo(center.z, 4);

    // halfExtents should reflect parent scale
    expect(sensorBody!.halfExtents.x).toBeCloseTo(0.1 * 1.5, 3);
    expect(sensorBody!.halfExtents.y).toBeCloseTo(0.2 * 1.5, 3);

    pw.dispose();
  });
});

// ─── 6. LHS → RHS Coordinate System Consistency ─────────────────

describe('Collider Position: LHS/RHS Coordinate Consistency', () => {
  it('Unity X=1 offset → glTF X=-1 offset (X negated)', () => {
    const node = new Object3D();
    node.position.set(0, 0, 0);
    node.updateMatrixWorld(true);

    const aabb = AABB.fromBoxCollider(node, { x: 1, y: 0, z: 0 }, { x: 1, y: 1, z: 1 });

    // localCenter should have X negated
    expect(aabb.localCenter.x).toBeCloseTo(-1);
    expect(aabb.localCenter.y).toBeCloseTo(0);
    expect(aabb.localCenter.z).toBeCloseTo(0);

    const center = computeWorldCenter(node, aabb);
    expect(center.x).toBeCloseTo(-1);
  });

  it('Unity Z offset → glTF Z offset (Z unchanged)', () => {
    const node = new Object3D();
    node.position.set(0, 0, 0);
    node.updateMatrixWorld(true);

    const aabb = AABB.fromBoxCollider(node, { x: 0, y: 0, z: 0.5 }, { x: 1, y: 1, z: 1 });

    expect(aabb.localCenter.z).toBeCloseTo(0.5);

    const center = computeWorldCenter(node, aabb);
    expect(center.z).toBeCloseTo(0.5);
  });

  it('rotated node with Unity X offset → consistent glTF world position', () => {
    // This tests the full LHS→RHS pipeline with rotation
    const node = new Object3D();
    node.position.set(5, 0, 0);
    node.quaternion.setFromAxisAngle(new Vector3(0, 1, 0), Math.PI); // 180° Y
    node.updateMatrixWorld(true);

    // Unity: center=(1, 0, 0) → glTF localCenter=(-1, 0, 0)
    const aabb = AABB.fromBoxCollider(node, { x: 1, y: 0, z: 0 }, { x: 1, y: 1, z: 1 });

    // After 180° Y rotation, local X=-1 rotates to world X=+1
    // World center = (5, 0, 0) + rotated(-1, 0, 0) = (5, 0, 0) + (1, 0, 0) = (6, 0, 0)
    const center = computeWorldCenter(node, aabb);
    expect(center.x).toBeCloseTo(6, 3);
    expect(center.y).toBeCloseTo(0, 3);
    expect(center.z).toBeCloseTo(0, 3);
  });
});
