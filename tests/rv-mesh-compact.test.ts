// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Import-time vertex-pool compaction: meshes that index into one oversized shared vertex
 * buffer (OBJ → GLB converters) get their own vertices, and with them their own bounds.
 */

import { describe, expect, it } from 'vitest';
import { BufferAttribute, BufferGeometry, Group, Mesh, MeshStandardMaterial } from 'three';
import { compactSharedVertexPools } from '../src/core/editor/rv-mesh-compact';

/** One pool of two far-apart quads; every mesh gets its own index but the SAME attributes. */
function pooledMeshes(): { root: Group; a: Mesh; b: Mesh } {
  const positions = new BufferAttribute(new Float32Array([
    0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0,             // quad A at the origin
    100, 0, 0, 101, 0, 0, 101, 1, 0, 100, 1, 0,     // quad B 100 m away
    50, 50, 50, 51, 50, 50, 51, 51, 50,             // unreferenced filler
  ]), 3);
  const make = (indices: number[], name: string): Mesh => {
    const geom = new BufferGeometry();
    geom.setAttribute('position', positions);
    geom.setIndex(new BufferAttribute(new Uint32Array(indices), 1));
    const mesh = new Mesh(geom, new MeshStandardMaterial());
    mesh.name = name;
    return mesh;
  };
  const a = make([0, 1, 2, 0, 2, 3], 'A');
  const b = make([4, 5, 6, 4, 6, 7], 'B');
  const root = new Group();
  root.add(a, b);
  return { root, a, b };
}

describe('compactSharedVertexPools', () => {
  it('gives each mesh on a shared pool its own vertices and bounds', () => {
    const { root, a, b } = pooledMeshes();

    const stats = compactSharedVertexPools(root);

    expect(stats.compactedMeshes).toBe(2);
    expect(a.geometry.getAttribute('position').count).toBe(4);
    expect(b.geometry.getAttribute('position').count).toBe(4);
    expect(a.geometry.getAttribute('position')).not.toBe(b.geometry.getAttribute('position'));
    expect(a.geometry.boundingBox!.max.x).toBe(1);
    expect(b.geometry.boundingBox!.min.x).toBe(100);
  });

  it('keeps the triangle order, so triangle-indexed ops replay identically', () => {
    const { root, b } = pooledMeshes();
    compactSharedVertexPools(root);

    expect(Array.from(b.geometry.index!.array)).toEqual([0, 1, 2, 0, 2, 3]);
    expect(b.geometry.getAttribute('position').getX(1)).toBe(101);
  });

  it('leaves a mesh alone that uses most of its buffer', () => {
    const geom = new BufferGeometry();
    geom.setAttribute('position', new BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]), 3));
    geom.setIndex(new BufferAttribute(new Uint16Array([0, 1, 2]), 1));
    const mesh = new Mesh(geom, new MeshStandardMaterial());

    expect(compactSharedVertexPools(mesh).compactedMeshes).toBe(0);
    expect(mesh.geometry).toBe(geom);
  });

  it('leaves non-indexed and grouped geometry alone', () => {
    const { root, a, b } = pooledMeshes();
    const before = b.geometry;
    a.geometry = a.geometry.toNonIndexed();
    const nonIndexed = a.geometry;
    b.geometry.addGroup(0, 6, 0);

    expect(compactSharedVertexPools(root).compactedMeshes).toBe(0);
    expect(a.geometry).toBe(nonIndexed);
    expect(b.geometry).toBe(before);
  });

  it('keeps instanced meshes on ONE compacted geometry', () => {
    const { root, a } = pooledMeshes();
    const twin = new Mesh(a.geometry, a.material);
    root.add(twin);

    compactSharedVertexPools(root);

    expect(twin.geometry).toBe(a.geometry);
    expect(twin.geometry.getAttribute('position').count).toBe(4);
  });
});
