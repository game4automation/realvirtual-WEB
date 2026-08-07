// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-mesh-merge-batch.test.ts — plan-274 9.1: staging correctness.
 *
 * The bulk-copy staging must produce the same data the legacy per-mesh
 * clone path produced, canonicalized to f32/u8/u32:
 *   - concatenation in descriptor order with correct offsets
 *   - toNonIndexed-parity expansion when the pass is non-indexed
 *   - de-interleave of InterleavedBufferAttribute inputs
 *   - dequantization of normalized (KHR_mesh_quantization-style) attributes
 *   - mixed hasNormal/hasColor/hasRm flags in one batch (missing → filled)
 *   - per-mesh groupId + group inverse table (B1)
 *   - slice split respecting chunk/group boundaries (B2)
 *   - sources never mutated or detached
 */

import { describe, it, expect } from 'vitest';
import {
  BufferAttribute,
  BufferGeometry,
  InterleavedBuffer,
  InterleavedBufferAttribute,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Vector3,
} from 'three';
import { buildMergeBatches, type MeshMergeCandidate } from '../src/core/engine/rv-mesh-merge-batch';

// ─── Helpers ────────────────────────────────────────────────────────────

/** Simple indexed triangle-pair geometry with distinct positions. */
function makeGeometry(offset = 0, withNormal = true, withColor = true, withRm = true): BufferGeometry {
  const geo = new BufferGeometry();
  const pos = new Float32Array([
    offset, 0, 0,
    offset + 1, 0, 0,
    offset, 1, 0,
    offset + 1, 1, 0,
  ]);
  geo.setAttribute('position', new BufferAttribute(pos, 3));
  if (withNormal) {
    geo.setAttribute('normal', new BufferAttribute(new Float32Array([
      0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1,
    ]), 3));
  }
  if (withColor) {
    geo.setAttribute('color', new BufferAttribute(new Uint8Array([
      255, 0, 0, 0, 255, 0, 0, 0, 255, 128, 128, 128,
    ]), 3, true));
  }
  if (withRm) {
    geo.setAttribute('rmPacked', new BufferAttribute(new Uint8Array([
      128, 0, 128, 0, 128, 0, 128, 0,
    ]), 2, true));
  }
  geo.setIndex(new BufferAttribute(new Uint16Array([0, 1, 2, 2, 1, 3]), 1));
  return geo;
}

function makeMesh(geo: BufferGeometry, position = new Vector3()): Mesh {
  const mesh = new Mesh(geo, new MeshStandardMaterial());
  mesh.position.copy(position);
  mesh.updateMatrix();
  mesh.updateMatrixWorld(true);
  return mesh;
}

const identity = [new Matrix4()];

function candidatesOf(meshes: Mesh[], groupId = 0): MeshMergeCandidate[] {
  return meshes.map((mesh) => ({ mesh, groupId }));
}

// ─── Tests ──────────────────────────────────────────────────────────────

describe('MergeBatch staging', () => {
  it('concatenates attributes in descriptor order with correct offsets', () => {
    const meshes = [makeGeometry(0), makeGeometry(10), makeGeometry(20)].map((g) => makeMesh(g));
    const batches = buildMergeBatches(candidatesOf(meshes), identity, {
      keepIndexed: true,
      chunkVertexBudget: 500_000,
    });

    expect(batches).toHaveLength(1);
    const batch = batches[0];
    expect(batch.descriptors).toHaveLength(3);
    const totalVerts = 12;
    expect(batch.position.length).toBe(totalVerts * 3);
    expect(batch.normal.length).toBe(totalVerts * 3);
    expect(batch.color!.length).toBe(totalVerts * 3);
    expect(batch.rmPacked!.length).toBe(totalVerts * 2);
    expect(batch.index!.length).toBe(18);
    expect(batch.keepIndexed).toBe(true);

    // Descriptor order = candidate order; offsets implicit and contiguous.
    // First vertex x of mesh 1 (offset 10) sits at vertex 4 in the payload.
    expect(batch.position[0]).toBe(0);
    expect(batch.position[4 * 3]).toBe(10);
    expect(batch.position[8 * 3]).toBe(20);
    // Index values are staged mesh-LOCAL (the port rebases).
    expect(Array.from(batch.index!.subarray(0, 6))).toEqual([0, 1, 2, 2, 1, 3]);
    expect(Array.from(batch.index!.subarray(6, 12))).toEqual([0, 1, 2, 2, 1, 3]);
    // Colors staged verbatim (u8 fast path).
    expect(Array.from(batch.color!.subarray(0, 3))).toEqual([255, 0, 0]);
  });

  it('expands indexed inputs when keepIndexed is false (toNonIndexed parity)', () => {
    const meshes = [makeMesh(makeGeometry(0))];
    const batches = buildMergeBatches(candidatesOf(meshes), identity, {
      keepIndexed: false,
      chunkVertexBudget: 500_000,
    });
    const batch = batches[0];

    // 6 index entries → 6 expanded vertices.
    expect(batch.descriptors[0].vertexCount).toBe(6);
    expect(batch.descriptors[0].indexCount).toBe(0);
    expect(batch.index).toBeNull();
    // Expanded positions follow the index order 0,1,2,2,1,3.
    const px = (v: number): number => batch.position[v * 3];
    const py = (v: number): number => batch.position[v * 3 + 1];
    expect([px(0), py(0)]).toEqual([0, 0]);
    expect([px(1), py(1)]).toEqual([1, 0]);
    expect([px(2), py(2)]).toEqual([0, 1]);
    expect([px(3), py(3)]).toEqual([0, 1]); // index 2 repeated
    expect([px(4), py(4)]).toEqual([1, 0]); // index 1 repeated
    expect([px(5), py(5)]).toEqual([1, 1]); // index 3
    // Colors expanded through the same index.
    expect(Array.from(batch.color!.subarray(0, 3))).toEqual([255, 0, 0]);
    expect(Array.from(batch.color!.subarray(9, 12))).toEqual([0, 0, 255]); // vertex 2 (blue)
  });

  it('de-interleaves InterleavedBufferAttribute inputs', () => {
    // position + normal interleaved in one buffer (stride 6).
    const data = new Float32Array([
      // x, y, z, nx, ny, nz
      1, 2, 3, 0, 0, 1,
      4, 5, 6, 0, 1, 0,
      7, 8, 9, 1, 0, 0,
    ]);
    const ib = new InterleavedBuffer(data, 6);
    const geo = new BufferGeometry();
    geo.setAttribute('position', new InterleavedBufferAttribute(ib, 3, 0));
    geo.setAttribute('normal', new InterleavedBufferAttribute(ib, 3, 3));
    geo.setIndex(new BufferAttribute(new Uint16Array([0, 1, 2]), 1));
    const mesh = makeMesh(geo);

    const batch = buildMergeBatches(candidatesOf([mesh]), identity, {
      keepIndexed: true,
      chunkVertexBudget: 500_000,
    })[0];

    expect(Array.from(batch.position)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(Array.from(batch.normal)).toEqual([0, 0, 1, 0, 1, 0, 1, 0, 0]);
  });

  it('dequantizes normalized (KHR_mesh_quantization-style) attributes to f32', () => {
    // Int16 normalized position — getX/getY/getZ denormalize to [-1, 1].
    const geo = new BufferGeometry();
    const quantized = new Int16Array([
      0, 0, 0,
      32767, 0, 0,
      0, 16384, 0,
    ]);
    geo.setAttribute('position', new BufferAttribute(quantized, 3, true));
    geo.setIndex(new BufferAttribute(new Uint16Array([0, 1, 2]), 1));
    // Float colors in 0..1 (non-u8) must be quantized to u8.
    geo.setAttribute('color', new BufferAttribute(new Float32Array([
      1, 0, 0, 0, 0.5, 0, 0, 0, 1,
    ]), 3));
    const mesh = makeMesh(geo);

    const batch = buildMergeBatches(candidatesOf([mesh]), identity, {
      keepIndexed: true,
      chunkVertexBudget: 500_000,
    })[0];

    expect(batch.position[0]).toBeCloseTo(0, 6);
    expect(batch.position[3]).toBeCloseTo(1, 4);          // 32767 → 1.0
    expect(batch.position[7]).toBeCloseTo(16384 / 32767, 4);
    // Float color → u8.
    expect(batch.color![0]).toBe(255);
    expect(batch.color![4]).toBe(128); // 0.5 * 255 rounded
    expect(batch.color![8]).toBe(255);
  });

  it('handles mixed hasNormal/hasColor/hasRm flags across meshes in one batch', () => {
    const full = makeMesh(makeGeometry(0, true, true, true));
    const noNormal = makeMesh(makeGeometry(10, false, true, true), new Vector3(1, 0, 0));
    const noColorRm = makeMesh(makeGeometry(20, true, false, false), new Vector3(2, 0, 0));

    const batch = buildMergeBatches(candidatesOf([full, noNormal, noColorRm]), identity, {
      keepIndexed: true,
      chunkVertexBudget: 500_000,
    })[0];

    expect(batch.descriptors.map((d) => d.hasNormal)).toEqual([true, false, true]);
    expect(batch.descriptors.map((d) => d.hasColor)).toEqual([true, true, false]);
    expect(batch.descriptors.map((d) => d.hasRm)).toEqual([true, true, false]);

    // Missing normals were COMPUTED (computeVertexNormals parity): the quad
    // in the XY plane gets ±Z normals, not zeros.
    const nz = batch.normal[4 * 3 + 2]; // first vertex of mesh 1
    expect(Math.abs(nz)).toBeCloseTo(1, 4);

    // Missing color filled with 255 (white), missing rm with [255, 0].
    expect(Array.from(batch.color!.subarray(8 * 3, 8 * 3 + 3))).toEqual([255, 255, 255]);
    expect(Array.from(batch.rmPacked!.subarray(8 * 2, 8 * 2 + 2))).toEqual([255, 0]);
    // Present attributes staged verbatim.
    expect(Array.from(batch.color!.subarray(0, 3))).toEqual([255, 0, 0]);
  });

  it('assigns correct per-mesh groupId and builds the group inverse table (B1)', () => {
    const g0a = makeMesh(makeGeometry(0));
    const g0b = makeMesh(makeGeometry(1));
    const g1a = makeMesh(makeGeometry(2));
    const inv0 = new Matrix4();
    const inv1 = new Matrix4().makeTranslation(-5, -6, -7);

    const batch = buildMergeBatches(
      [
        { mesh: g0a, groupId: 0 },
        { mesh: g0b, groupId: 0 },
        { mesh: g1a, groupId: 1 },
      ],
      [inv0, inv1],
      { keepIndexed: true, chunkVertexBudget: 500_000 },
    )[0];

    expect(batch.groupCount).toBe(2);
    expect(batch.descriptors.map((d) => d.groupId)).toEqual([0, 0, 1]);
    expect(batch.groupInverses.length).toBe(2 * 16);
    // Column-major translation slots 12..14 of group 1.
    expect(batch.groupInverses[16 + 12]).toBe(-5);
    expect(batch.groupInverses[16 + 13]).toBe(-6);
    expect(batch.groupInverses[16 + 14]).toBe(-7);
    // World matrices captured per descriptor.
    expect(batch.descriptors[0].worldMatrix.length).toBe(16);
  });

  it('splits candidates into slices at chunk boundaries respecting group boundaries (B2)', () => {
    // 6 meshes of 4 verts each; chunk budget 8 → chunks of 2 meshes;
    // slice budget 8 → one chunk per slice → 3 slices.
    const meshes = Array.from({ length: 6 }, (_, i) => makeMesh(makeGeometry(i * 5)));
    const batches = buildMergeBatches(candidatesOf(meshes), identity, {
      keepIndexed: true,
      chunkVertexBudget: 8,
      sliceVertexBudget: 8,
    });

    expect(batches).toHaveLength(3);
    for (const batch of batches) {
      expect(batch.descriptors).toHaveLength(2);
      expect(batch.position.length).toBe(8 * 3);
    }

    // Group boundaries: last mesh in its own group → its chunk (and slice)
    // never mixes with group 0 even when the budget would allow it.
    const grouped = [
      { mesh: meshes[0], groupId: 0 },
      { mesh: meshes[1], groupId: 0 },
      { mesh: meshes[2], groupId: 1 },
    ];
    const inv = [new Matrix4(), new Matrix4()];
    const groupedBatches = buildMergeBatches(grouped, inv, {
      keepIndexed: true,
      chunkVertexBudget: 500_000,
      sliceVertexBudget: 8,
    });
    // Chunks: [m0, m1] (group 0, 8 verts), [m2] (group 1, 4 verts).
    // Slice budget 8 → slice 1 = chunk 1, slice 2 = chunk 2.
    expect(groupedBatches).toHaveLength(2);
    expect(groupedBatches[0].descriptors.map((d) => d.groupId)).toEqual([0, 0]);
    expect(groupedBatches[1].descriptors.map((d) => d.groupId)).toEqual([0]); // slice-local id
    expect(groupedBatches[1].groupCount).toBe(1);
  });

  it('never mutates or detaches source geometry buffers', () => {
    const interleavedData = new Float32Array([
      1, 2, 3, 0, 0, 1,
      4, 5, 6, 0, 1, 0,
      7, 8, 9, 1, 0, 0,
    ]);
    const ib = new InterleavedBuffer(interleavedData, 6);
    const interleavedGeo = new BufferGeometry();
    interleavedGeo.setAttribute('position', new InterleavedBufferAttribute(ib, 3, 0));
    interleavedGeo.setIndex(new BufferAttribute(new Uint16Array([0, 1, 2]), 1));

    const plainGeo = makeGeometry(0);
    const meshes = [makeMesh(plainGeo), makeMesh(interleavedGeo)];

    const posBefore = plainGeo.attributes.position.array;
    const posCopy = Float32Array.from(posBefore as Float32Array);
    const idxBefore = plainGeo.index!.array;
    const interleavedCopy = Float32Array.from(interleavedData);

    buildMergeBatches(candidatesOf(meshes), identity, {
      keepIndexed: false, // exercise the expansion path too
      chunkVertexBudget: 500_000,
    });

    expect(plainGeo.attributes.position.array).toBe(posBefore); // not replaced
    expect(Array.from(posBefore as Float32Array)).toEqual(Array.from(posCopy)); // not mutated
    expect(plainGeo.index!.array).toBe(idxBefore);
    expect(Array.from(interleavedData)).toEqual(Array.from(interleavedCopy));
    // Buffers not detached (length still readable, non-zero).
    expect((posBefore as Float32Array).length).toBeGreaterThan(0);
  });
});
