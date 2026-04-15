// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Tests for Bounds Alignment — verify bounding box bottom alignment to floor.
 */
import { describe, test, expect } from 'vitest';
import { Group, Mesh, BoxGeometry, MeshBasicMaterial } from 'three';
import { alignToFloor } from '../../realvirtual-WebViewer-Private~/src/plugins/layout-planner';

// Helper: create a Group with a child Mesh whose bounding box matches the given extents.
// BoxGeometry is centered at origin, so we offset the mesh position to achieve desired min/max.
function createObjectWithBounds(minY: number, maxY: number): Group {
  const height = maxY - minY;
  const centerY = (maxY + minY) / 2;
  const group = new Group();
  const mesh = new Mesh(new BoxGeometry(100, height, 100), new MeshBasicMaterial());
  mesh.position.set(50, centerY, 50); // Center mesh so bounds span [0..100] x [minY..maxY] x [0..100]
  group.add(mesh);
  return group;
}

describe('Bounds Alignment', () => {
  test('alignToFloor places bottom of bounds at Y=0', () => {
    const obj = createObjectWithBounds(-50, 150); // bottom at -50
    alignToFloor(obj);
    expect(obj.position.y).toBeCloseTo(50, 5); // Shift up by 50 to put bottom at Y=0
  });

  test('alignToFloor handles already-grounded objects', () => {
    const obj = createObjectWithBounds(0, 100); // bottom already at 0
    alignToFloor(obj);
    expect(obj.position.y).toBeCloseTo(0, 5);
  });

  test('alignToFloor handles elevated objects', () => {
    const obj = createObjectWithBounds(20, 120); // bottom at 20
    alignToFloor(obj);
    expect(obj.position.y).toBeCloseTo(-20, 5); // Shift down by 20
  });

  test('alignToFloor handles empty group (no geometry)', () => {
    const group = new Group();
    group.position.y = 5;
    alignToFloor(group);
    // Should restore saved Y since bounds are empty
    expect(group.position.y).toBe(5);
  });
});
