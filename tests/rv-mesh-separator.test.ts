// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Geometry core of the mesh separator (plan-331, section 9: tests 9.1-9.5, 9.8, 9.9, 9.13).
 *
 * Fixtures are built locally: the plan pointed at `tests/helpers/condense-fixtures.ts`,
 * which does not exist in this tree (same class of drifted anchor as the `isGuardedMesh`
 * evidence correction the plan itself records).
 */

import { describe, expect, it } from 'vitest';
import {
  BufferAttribute,
  BufferGeometry,
  InstancedMesh,
  InterleavedBuffer,
  InterleavedBufferAttribute,
  Mesh,
  MeshStandardMaterial,
  SkinnedMesh,
} from 'three';
import {
  DEFAULT_WELD_THRESHOLD,
  REASON_MALFORMED_GROUPS,
  REASON_MISSING_MATERIAL,
  REASON_MULTI_MATERIAL,
  REASON_NO_GROUPS,
  REASON_SINGLE_PART,
  computeGroupPartitions,
  computeMeshIslands,
  extractSubGeometry,
  groupModeIneligibility,
  islandModeIneligibility,
  weldVertexIds,
} from '../src/core/editor/rv-mesh-separator';
import {
  MESH_GUARD_INSTANCED_SKINNED,
  MESH_GUARD_INTERLEAVED,
  MESH_GUARD_SKIN_MORPH,
} from '../src/core/engine/rv-mesh-guards';

// ─── Fixtures ───────────────────────────────────────────────────────────

/** Indexed geometry from a flat position list plus a triangle index list. */
function indexedGeometry(positions: number[], indices: number[]): BufferGeometry {
  const geom = new BufferGeometry();
  geom.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geom.setIndex(new BufferAttribute(new Uint32Array(indices), 1));
  return geom;
}

/** Non-indexed geometry — three consecutive vertices form one triangle. */
function nonIndexedGeometry(positions: number[]): BufferGeometry {
  const geom = new BufferGeometry();
  geom.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  return geom;
}

/** Two triangles that share no vertex and sit far apart. */
function twoDisjointTriangles(): BufferGeometry {
  return indexedGeometry(
    [
      0, 0, 0, 1, 0, 0, 0, 1, 0, // triangle A
      10, 0, 0, 11, 0, 0, 10, 1, 0, // triangle B
    ],
    [0, 1, 2, 3, 4, 5],
  );
}

/**
 * A hard-edged cube: every face carries its own four vertices with its own normal, so the
 * eight geometric corners appear as 24 distinct vertices. This is what a CAD export looks
 * like, and it is the regression gate for position-only welding — attribute-wide hashing
 * would report six islands here.
 */
function hardEdgedCube(size = 1): BufferGeometry {
  const h = size / 2;
  const corners: [number, number, number][] = [
    [-h, -h, -h], [h, -h, -h], [h, h, -h], [-h, h, -h],
    [-h, -h, h], [h, -h, h], [h, h, h], [-h, h, h],
  ];
  const faces: [number, number, number, number, [number, number, number]][] = [
    [0, 3, 2, 1, [0, 0, -1]], // back
    [4, 5, 6, 7, [0, 0, 1]],  // front
    [0, 1, 5, 4, [0, -1, 0]], // bottom
    [3, 7, 6, 2, [0, 1, 0]],  // top
    [0, 4, 7, 3, [-1, 0, 0]], // left
    [1, 2, 6, 5, [1, 0, 0]],  // right
  ];

  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];

  for (const [a, b, c, d, normal] of faces) {
    const base = positions.length / 3;
    for (const corner of [a, b, c, d]) {
      positions.push(...corners[corner]);
      normals.push(...normal);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  const geom = new BufferGeometry();
  geom.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geom.setAttribute('normal', new BufferAttribute(new Float32Array(normals), 3));
  geom.setIndex(new BufferAttribute(new Uint32Array(indices), 1));
  return geom;
}

/** A non-indexed cube (36 vertices, 12 triangles) translated by `offset` on X. */
function nonIndexedCube(offset: number): number[] {
  const indexed = hardEdgedCube(1);
  const pos = indexed.getAttribute('position');
  const index = indexed.index!;
  const out: number[] = [];
  for (let i = 0; i < index.count; i++) {
    const v = index.getX(i);
    out.push(pos.getX(v) + offset, pos.getY(v), pos.getZ(v));
  }
  return out;
}

function meshOf(geom: BufferGeometry, material: MeshStandardMaterial | MeshStandardMaterial[] = new MeshStandardMaterial()): Mesh {
  return new Mesh(geom, material as MeshStandardMaterial);
}

// ─── 9.1 ────────────────────────────────────────────────────────────────

describe('9.1 island detection', () => {
  it('splits two disjoint triangles into two islands', () => {
    const partitions = computeMeshIslands(twoDisjointTriangles(), DEFAULT_WELD_THRESHOLD);
    expect(partitions.length).toBe(2);
    expect(partitions.map((p) => p.length).sort()).toEqual([1, 1]);
    // Every triangle is accounted for exactly once.
    expect(partitions.flat().sort()).toEqual([0, 1]);
  });

  it('keeps two triangles sharing an edge in one island', () => {
    const quad = indexedGeometry(
      [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0],
      [0, 1, 2, 0, 2, 3],
    );
    expect(computeMeshIslands(quad, DEFAULT_WELD_THRESHOLD)).toEqual([]);
  });
});

// ─── 9.2 — the regression gate ──────────────────────────────────────────

describe('9.2 hard-edged cube', () => {
  it('reports ONE island for a cube with per-face normals', () => {
    const cube = hardEdgedCube();
    // Sanity: the fixture really has split vertices, otherwise the test proves nothing.
    expect(cube.getAttribute('position').count).toBe(24);

    const partitions = computeMeshIslands(cube, DEFAULT_WELD_THRESHOLD);

    // Empty == a single connected part. Attribute-wide hashing would give 6 partitions.
    expect(partitions).toEqual([]);
    expect(islandModeIneligibility(meshOf(cube))).toBe(REASON_SINGLE_PART);
  });

  it('welds the eight geometric corners down from 24 vertices', () => {
    const canon = weldVertexIds(hardEdgedCube(), DEFAULT_WELD_THRESHOLD);
    expect(canon.length).toBe(24);
    expect(new Set(canon).size).toBe(8);
  });

  it('separates two hard-edged cubes into two islands', () => {
    const a = hardEdgedCube();
    const b = hardEdgedCube();
    const positions: number[] = [];
    const indices: number[] = [];
    for (const [geom, dx] of [[a, 0], [b, 10]] as const) {
      const pos = geom.getAttribute('position');
      const base = positions.length / 3;
      for (let i = 0; i < pos.count; i++) positions.push(pos.getX(i) + dx, pos.getY(i), pos.getZ(i));
      const idx = geom.index!;
      for (let i = 0; i < idx.count; i++) indices.push(idx.getX(i) + base);
    }
    expect(computeMeshIslands(indexedGeometry(positions, indices), DEFAULT_WELD_THRESHOLD).length).toBe(2);
  });
});

// ─── 9.3 — the quantization contract ────────────────────────────────────

describe('9.3 quantization contract', () => {
  /**
   * Two triangles whose only candidate meeting point is one vertex, placed at `x = d`
   * against a vertex at the origin. With resolution 1 the cell index is `Math.round(d)`.
   */
  function twoShellsWithGap(d: number): BufferGeometry {
    return indexedGeometry(
      [
        0, 0, 0, 10, 0, 0, 0, 10, 0, // shell A
        d, 0, 0, -10, 0, 0, 0, -10, 0, // shell B
      ],
      [0, 1, 2, 3, 4, 5],
    );
  }

  it('joins two shells whose vertices land in the SAME cell', () => {
    // round(0.4 / 1) === 0 === round(0 / 1) -> same cell -> welded -> one island.
    expect(computeMeshIslands(twoShellsWithGap(0.4), 1)).toEqual([]);
  });

  it('keeps two shells apart when their vertices land in DIFFERENT cells', () => {
    // round(0.6 / 1) === 1 !== 0 -> different cell -> not welded -> two islands.
    expect(computeMeshIslands(twoShellsWithGap(0.6), 1).length).toBe(2);
  });

  it('is a grid snap, not a distance tolerance', () => {
    // Distance 0.2 with resolution 1: closer than the resolution, yet on opposite sides
    // of a cell boundary (round(0.4)=0, round(0.6)=1), so they stay separate. This is the
    // documented Unity-identical behaviour and must not be "fixed" into a distance test.
    const geom = indexedGeometry(
      [
        0.4, 0, 0, 10, 0, 0, 0, 10, 0,
        0.6, 0, 0, -10, 0, 0, 0, -10, 0,
      ],
      [0, 1, 2, 3, 4, 5],
    );
    expect(computeMeshIslands(geom, 1).length).toBe(2);
  });

  it.each([0, -1, NaN, Infinity, -Infinity])('rejects resolution %p', (resolution) => {
    expect(() => weldVertexIds(twoDisjointTriangles(), resolution as number)).toThrow(RangeError);
  });

  it('rejects coordinates that would overflow the grid', () => {
    const geom = indexedGeometry([0, 0, 0, 1, 0, 0, 0, 1, 0], [0, 1, 2]);
    expect(() => weldVertexIds(geom, 1e-30)).toThrow(RangeError);
  });
});

// ─── 9.4 ────────────────────────────────────────────────────────────────

describe('9.4 non-indexed geometry', () => {
  it('finds two islands in two non-indexed cubes', () => {
    const geom = nonIndexedGeometry([...nonIndexedCube(0), ...nonIndexedCube(10)]);
    expect(geom.index).toBeNull();
    expect(geom.getAttribute('position').count).toBe(72); // 2 x 36

    const partitions = computeMeshIslands(geom, DEFAULT_WELD_THRESHOLD);

    // Without welding every one of the 24 triangles would be its own island.
    expect(partitions.length).toBe(2);
    expect(partitions[0].length).toBe(12);
    expect(partitions[1].length).toBe(12);
  });
});

// ─── 9.5 ────────────────────────────────────────────────────────────────

describe('9.5 attribute preservation', () => {
  function attributedGeometry(): BufferGeometry {
    const geom = twoDisjointTriangles();
    geom.setAttribute(
      'uv',
      new BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 0.25, 0.25, 0.75, 0.25, 0.25, 0.75]), 2),
    );
    // The STEP import bakes per-face colours into a normalized Uint8 colour attribute.
    geom.setAttribute(
      'color',
      new BufferAttribute(
        new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255, 10, 20, 30, 40, 50, 60, 70, 80, 90]),
        3,
        true,
      ),
    );
    return geom;
  }

  it('carries uv and normalized Uint8 color through extraction', () => {
    const geom = attributedGeometry();
    const partitions = computeMeshIslands(geom, DEFAULT_WELD_THRESHOLD);
    expect(partitions.length).toBe(2);

    // Island containing triangle 1 -> original vertices 3,4,5.
    const which = partitions.findIndex((p) => p.includes(1));
    const part = extractSubGeometry(geom, partitions[which]);

    const uv = part.getAttribute('uv') as BufferAttribute;
    const color = part.getAttribute('color') as BufferAttribute;
    const srcUv = geom.getAttribute('uv') as BufferAttribute;
    const srcColor = geom.getAttribute('color') as BufferAttribute;

    expect(part.getAttribute('position').count).toBe(3);

    expect(uv.itemSize).toBe(2);
    expect(uv.normalized).toBe(false);
    expect(uv.array).toBeInstanceOf(Float32Array);

    expect(color.itemSize).toBe(3);
    expect(color.normalized).toBe(true);
    expect(color.array).toBeInstanceOf(Uint8Array);

    // Values match the originals for the mapped vertices, exactly.
    for (let i = 0; i < 3; i++) {
      const original = 3 + i;
      expect(uv.getX(i)).toBeCloseTo(srcUv.getX(original), 6);
      expect(uv.getY(i)).toBeCloseTo(srcUv.getY(original), 6);
      // Raw storage must be byte-identical, not just approximately equal after decoding.
      expect((color.array as Uint8Array)[i * 3]).toBe((srcColor.array as Uint8Array)[original * 3]);
      expect((color.array as Uint8Array)[i * 3 + 1]).toBe((srcColor.array as Uint8Array)[original * 3 + 1]);
      expect((color.array as Uint8Array)[i * 3 + 2]).toBe((srcColor.array as Uint8Array)[original * 3 + 2]);
    }
  });

  it('produces bounds and a right-sized index for every part', () => {
    const geom = attributedGeometry();
    for (const partition of computeMeshIslands(geom, DEFAULT_WELD_THRESHOLD)) {
      const part = extractSubGeometry(geom, partition);
      expect(part.boundingSphere).not.toBeNull();
      expect(part.boundingBox).not.toBeNull();
      // Three vertices fit in Uint16 even though the source index was Uint32.
      expect(part.index!.array).toBeInstanceOf(Uint16Array);
      expect(part.index!.count).toBe(partition.length * 3);
    }
  });

  it('leaves the source geometry untouched', () => {
    const geom = attributedGeometry();
    const before = (geom.getAttribute('position').array as Float32Array).slice();
    extractSubGeometry(geom, [0]);
    expect(geom.getAttribute('position').array).toEqual(before);
    expect(geom.getAttribute('position').count).toBe(6);
  });
});

// ─── 9.8 ────────────────────────────────────────────────────────────────

describe('9.8 group mode', () => {
  function twoGroupMesh(): Mesh {
    const geom = twoDisjointTriangles();
    geom.addGroup(0, 3, 0);
    geom.addGroup(3, 3, 1);
    return meshOf(geom, [new MeshStandardMaterial(), new MeshStandardMaterial()]);
  }

  it('accepts a material array and splits along geometry.groups', () => {
    const mesh = twoGroupMesh();
    expect(Array.isArray(mesh.material)).toBe(true);
    expect(groupModeIneligibility(mesh)).toBeNull();

    const partitions = computeGroupPartitions(mesh.geometry);
    expect(partitions).toEqual([[0], [1]]);

    const parts = partitions.map((p) => extractSubGeometry(mesh.geometry, p));
    expect(parts.length).toBe(2);
    for (const part of parts) {
      expect(part.getAttribute('position').count).toBe(3);
      expect(part.index!.count).toBe(3);
      // Each output carries a single material slot, so it needs no groups of its own.
      expect(part.groups.length).toBe(0);
    }
  });

  it('returns no partitions for fewer than two groups', () => {
    const geom = twoDisjointTriangles();
    geom.addGroup(0, 6, 0);
    expect(computeGroupPartitions(geom)).toEqual([]);
  });
});

// ─── 9.9 ────────────────────────────────────────────────────────────────

describe('9.9 single-island case', () => {
  it('reports a reason and produces no partitions', () => {
    const single = indexedGeometry([0, 0, 0, 1, 0, 0, 0, 1, 0], [0, 1, 2]);
    expect(computeMeshIslands(single, DEFAULT_WELD_THRESHOLD)).toEqual([]);
    expect(islandModeIneligibility(meshOf(single))).toBe(REASON_SINGLE_PART);
  });

  it('reports a reason for empty geometry rather than throwing', () => {
    const empty = new BufferGeometry();
    empty.setAttribute('position', new BufferAttribute(new Float32Array(0), 3));
    expect(computeMeshIslands(empty, DEFAULT_WELD_THRESHOLD)).toEqual([]);
    expect(islandModeIneligibility(meshOf(empty))).toBe(REASON_SINGLE_PART);
  });
});

// ─── 9.13 ───────────────────────────────────────────────────────────────

describe('9.13 guards, per mode', () => {
  function interleavedGeometry(): BufferGeometry {
    const geom = new BufferGeometry();
    const data = new Float32Array([0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0]);
    const buffer = new InterleavedBuffer(data, 4);
    geom.setAttribute('position', new InterleavedBufferAttribute(buffer, 3, 0) as unknown as BufferAttribute);
    return geom;
  }

  function morphGeometry(): BufferGeometry {
    const geom = twoDisjointTriangles();
    geom.morphAttributes.position = [
      new BufferAttribute(new Float32Array(18), 3),
    ];
    return geom;
  }

  function skinGeometry(): BufferGeometry {
    const geom = twoDisjointTriangles();
    geom.setAttribute('skinIndex', new BufferAttribute(new Uint16Array(24), 4));
    geom.setAttribute('skinWeight', new BufferAttribute(new Float32Array(24), 4));
    return geom;
  }

  describe('island mode', () => {
    it('rejects instanced meshes', () => {
      const mesh = new InstancedMesh(twoDisjointTriangles(), new MeshStandardMaterial(), 2);
      expect(islandModeIneligibility(mesh)).toBe(MESH_GUARD_INSTANCED_SKINNED);
    });

    it('rejects skinned meshes', () => {
      const mesh = new SkinnedMesh(twoDisjointTriangles(), new MeshStandardMaterial());
      expect(islandModeIneligibility(mesh)).toBe(MESH_GUARD_INSTANCED_SKINNED);
    });

    it('rejects skinning attributes', () => {
      expect(islandModeIneligibility(meshOf(skinGeometry()))).toBe(MESH_GUARD_SKIN_MORPH);
    });

    it('rejects morph targets', () => {
      expect(islandModeIneligibility(meshOf(morphGeometry()))).toBe(MESH_GUARD_SKIN_MORPH);
    });

    it('rejects interleaved geometry', () => {
      expect(islandModeIneligibility(meshOf(interleavedGeometry()))).toBe(MESH_GUARD_INTERLEAVED);
    });

    it('rejects a multi-material mesh and points at the group mode', () => {
      const mesh = meshOf(twoDisjointTriangles(), [new MeshStandardMaterial(), new MeshStandardMaterial()]);
      expect(islandModeIneligibility(mesh)).toBe(REASON_MULTI_MATERIAL);
    });

    it('accepts a plain separable mesh', () => {
      expect(islandModeIneligibility(meshOf(twoDisjointTriangles()))).toBeNull();
    });
  });

  describe('group mode', () => {
    it('rejects the same exotic shapes as the island mode', () => {
      expect(groupModeIneligibility(meshOf(skinGeometry()))).toBe(MESH_GUARD_SKIN_MORPH);
      expect(groupModeIneligibility(meshOf(morphGeometry()))).toBe(MESH_GUARD_SKIN_MORPH);
      expect(groupModeIneligibility(meshOf(interleavedGeometry()))).toBe(MESH_GUARD_INTERLEAVED);
      expect(
        groupModeIneligibility(new InstancedMesh(twoDisjointTriangles(), new MeshStandardMaterial(), 2)),
      ).toBe(MESH_GUARD_INSTANCED_SKINNED);
    });

    it('rejects fewer than two groups', () => {
      const geom = twoDisjointTriangles();
      geom.addGroup(0, 6, 0);
      expect(groupModeIneligibility(meshOf(geom, [new MeshStandardMaterial()]))).toBe(REASON_NO_GROUPS);
    });

    it('rejects ranges beyond the triangle bounds', () => {
      const geom = twoDisjointTriangles();
      geom.addGroup(0, 3, 0);
      geom.addGroup(3, 30, 1);
      expect(
        groupModeIneligibility(meshOf(geom, [new MeshStandardMaterial(), new MeshStandardMaterial()])),
      ).toBe(REASON_MALFORMED_GROUPS);
    });

    it('rejects overlapping ranges', () => {
      const geom = twoDisjointTriangles();
      geom.addGroup(0, 6, 0);
      geom.addGroup(3, 3, 1);
      expect(
        groupModeIneligibility(meshOf(geom, [new MeshStandardMaterial(), new MeshStandardMaterial()])),
      ).toBe(REASON_MALFORMED_GROUPS);
    });

    it('rejects a materialIndex without a matching slot', () => {
      const geom = twoDisjointTriangles();
      geom.addGroup(0, 3, 0);
      geom.addGroup(3, 3, 5);
      expect(
        groupModeIneligibility(meshOf(geom, [new MeshStandardMaterial(), new MeshStandardMaterial()])),
      ).toBe(REASON_MISSING_MATERIAL);
    });

    it('accepts a well-formed two-group mesh', () => {
      const geom = twoDisjointTriangles();
      geom.addGroup(0, 3, 0);
      geom.addGroup(3, 3, 1);
      expect(
        groupModeIneligibility(meshOf(geom, [new MeshStandardMaterial(), new MeshStandardMaterial()])),
      ).toBeNull();
    });
  });
});
