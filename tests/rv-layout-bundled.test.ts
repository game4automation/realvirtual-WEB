// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Tests for GLB wrapper unwrapping and pivotToFloor helpers.
 */
import { describe, test, expect } from 'vitest';
import { Group, Mesh, BoxGeometry, MeshBasicMaterial, PerspectiveCamera, DirectionalLight } from 'three';
import { unwrapGltfRoot, pivotToFloorCenter } from '../../realvirtual-WebViewer-Private~/src/plugins/layout-planner';

// Helper to create a simple mesh
function makeMesh(name: string): Mesh {
  const m = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial());
  m.name = name;
  return m;
}

function makeGroup(name: string, ...children: THREE.Object3D[]): Group {
  const g = new Group();
  g.name = name;
  for (const c of children) g.add(c);
  return g;
}

// Import THREE namespace for type
import type * as THREE from 'three';

describe('unwrapGltfRoot', () => {
  test('strips __root__ wrapper with single content child', () => {
    const content = makeGroup('MyRobot', makeMesh('arm'), makeMesh('base'));
    const root = makeGroup('__root__', content);

    const result = unwrapGltfRoot(root);
    expect(result.name).toBe('MyRobot');
    expect(result.children).toHaveLength(2);
  });

  test('strips __root__ + default camera + hdrSkyBox', () => {
    const content = makeGroup('Conveyor', makeMesh('belt'));
    const camera = new PerspectiveCamera();
    camera.name = 'default camera';
    const skybox = new Group();
    skybox.name = 'hdrSkyBox';

    const root = makeGroup('__root__', content, camera, skybox);

    const result = unwrapGltfRoot(root);
    expect(result.name).toBe('Conveyor');
    expect(result.children).toHaveLength(1);
    expect(result.children[0].name).toBe('belt');
  });

  test('returns root as-is if no wrapper', () => {
    const root = makeGroup('Scene', makeMesh('objectA'), makeMesh('objectB'));
    const result = unwrapGltfRoot(root);
    expect(result.name).toBe('Scene');
    expect(result.children).toHaveLength(2);
  });

  test('strips lights from wrapper', () => {
    const content = makeGroup('Machine', makeMesh('body'));
    const light = new DirectionalLight();
    light.name = 'Sun';

    const root = makeGroup('__root__', content, light);
    const result = unwrapGltfRoot(root);
    expect(result.name).toBe('Machine');
  });

  test('preserves userData on unwrapped nodes', () => {
    const content = makeGroup('Robot');
    content.userData.realvirtual = { type: 'kinematic' };
    const mesh = makeMesh('arm');
    mesh.userData.realvirtual = { type: 'drive' };
    content.add(mesh);

    const root = makeGroup('__root__', content);
    const result = unwrapGltfRoot(root);

    expect(result.userData.realvirtual).toEqual({ type: 'kinematic' });
    expect(result.children[0].userData.realvirtual).toEqual({ type: 'drive' });
  });
});

describe('pivotToFloorCenter', () => {
  test('shifts children so pivot is at bottom-center', () => {
    // Create a group with a mesh that has its center at (2, 3, 4)
    const geo = new BoxGeometry(2, 2, 2); // size 2x2x2
    const mesh = new Mesh(geo, new MeshBasicMaterial());
    mesh.position.set(2, 3, 4); // Center at (2,3,4), so bounds: x[1,3] y[2,4] z[3,5]

    const group = new Group();
    group.add(mesh);

    pivotToFloorCenter(group);

    // After pivotToFloor: XZ center should be at 0, Y min should be at 0
    // Original center X=2, center Z=4, min Y=2
    // Offset: X=-2, Z=-4, Y=-2
    expect(mesh.position.x).toBeCloseTo(0);
    expect(mesh.position.y).toBeCloseTo(1); // was 3, min was 2, so offset=-2, new pos=3-2=1
    expect(mesh.position.z).toBeCloseTo(0);
  });

  test('handles empty group without error', () => {
    const group = new Group();
    expect(() => pivotToFloorCenter(group)).not.toThrow();
  });

  test('handles group already at origin', () => {
    const mesh = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial());
    mesh.position.set(0, 0.5, 0); // Bottom at Y=0, centered at XZ origin

    const group = new Group();
    group.add(mesh);

    pivotToFloorCenter(group);

    // Should barely change — already centered
    expect(mesh.position.x).toBeCloseTo(0);
    expect(mesh.position.z).toBeCloseTo(0);
    expect(mesh.position.y).toBeCloseTo(0.5);
  });
});
