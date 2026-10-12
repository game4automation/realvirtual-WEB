// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-753 §9.2 / plan-756 §9.4 — the SEGMENT table of a chunk.
 *
 * This file used to assert the `nodes[]` index-window table and `bsearchNode`.
 * Step 1d deleted both: a chunk's table of contents is its pick structure's
 * segments (`segNode` / `segOwner` / `segIndexStart` / `segIndexCount`), and the
 * geometry of a node is its subtree's segment interval in the asset's node
 * table. What the file asserts is unchanged in substance:
 *
 *  - segments tile the chunk's index in order and never overlap;
 *  - every triangle resolves to the surviving node its mesh sat under;
 *  - only a GENUINE pick owner owns a segment (plan Q5: everything else is
 *    `segOwner === -1`, which is what makes an opaque chunk block);
 *  - the index is `Uint32Array` also at exactly 65 536 and 65 537 vertices;
 *  - a keep-only asset has zero chunks;
 *  - every chunk geometry is registered in `chunkMetaOf` and a range proxy never
 *    touches the chunk's own `drawRange`.
 *
 * plan-756 P1/Q11 also changed WHAT is contiguous: items are ordered by the
 * pre-order ordinal of a mesh's nearest SURVIVING ancestor-or-self, so the
 * guaranteed unit is "the SUBTREE of any surviving node is one contiguous run of
 * segments per chunk" — a pick node's OWN triangles may be split
 * (`rv-pick-node-table.test.ts` builds that case and pins it).
 */
import { describe, it, expect } from 'vitest';
import { BufferAttribute, BufferGeometry, Mesh, Vector3 } from 'three';
import type { Object3D } from 'three';
import '../src/core/engine/rv-scene-loader';
import { registerCapabilities } from '../src/core/engine/rv-component-registry';
import { RVUberMaterial } from '../src/core/engine/rv-uber-material';
import { makeRangeProxyGeometry, chunkMetaOf, type BakedAsset, type BakedChunk } from '../src/core/engine/rv-bake-chunk';
import { segmentRange, type ChunkPickData } from '../src/core/engine/rv-pick-structure';
import {
  bakeTree, chunkKeys, chunkByKey, group, uberMesh, withComponent, uberBakeGeometry, trianglesOf,
} from './fixtures/bake-fixture';

// A pick-only test type — decoupled from any real component's role.
registerCapabilities('TestPick', { pick: 'select' });

const uber = new RVUberMaterial(false);
const _c = new Vector3();
const _a = new Vector3();
const _b = new Vector3();

/** Centroid x of face `f` of a chunk geometry. */
function faceCentroidX(geometry: BufferGeometry, f: number): number {
  const pos = geometry.getAttribute('position');
  const idx = geometry.index!;
  _a.fromBufferAttribute(pos, idx.getX(f * 3));
  _b.fromBufferAttribute(pos, idx.getX(f * 3 + 1));
  _c.fromBufferAttribute(pos, idx.getX(f * 3 + 2));
  return (_a.x + _b.x + _c.x) / 3;
}

/** The segment that owns index entry `i` (= `faceIndex * 3`), or -1. */
function segmentOfIndex(pick: ChunkPickData, i: number): number {
  for (let s = 0; s < pick.segmentCount; s++) {
    if (i >= pick.segIndexStart[s] && i < pick.segIndexStart[s] + pick.segIndexCount[s]) return s;
  }
  return -1;
}

function assertSegmentsTileTheChunk(pick: ChunkPickData, indexCount: number): void {
  let cursor = 0;
  for (let s = 0; s < pick.segmentCount; s++) {
    expect(pick.segIndexStart[s]).toBe(cursor);
    expect(pick.segIndexCount[s] % 3).toBe(0);
    expect(pick.segIndexCount[s]).toBeGreaterThan(0);
    cursor = pick.segIndexStart[s] + pick.segIndexCount[s];
  }
  expect(cursor).toBe(indexCount);
}

/** Triangles of `node`'s SUBTREE inside `chunk`, from the CSR node table. */
function subtreeIndexCount(asset: BakedAsset, chunk: BakedChunk, node: Object3D): number {
  const table = asset.nodeTable;
  const ordinal = table.ordinalOf.get(node);
  if (ordinal === undefined) return 0;
  const chunkOrdinal = table.chunks.indexOf(chunk);
  for (let r = table.rowStart[ordinal]; r < table.rowStart[ordinal + 1]; r++) {
    if (table.rowChunk[r] !== chunkOrdinal) continue;
    return segmentRange(chunk.pick, table.rowFirstSeg[r], table.rowLastSeg[r])!.indexCount;
  }
  return 0;
}

describe('bake() — chunk segments (plan-753 §9.2, plan-756 §9.4)', () => {
  it('the subtree of a surviving node stays contiguous; a nested pick node does not split its parent run', async () => {
    const root = group('Asset');
    const p1 = withComponent(group('P1'), 'TestPick');
    const p2 = withComponent(group('P2'), 'TestPick');
    // DFS: m1, m2, [P2: m3], m4 — a naive DFS write would split P1 around P2.
    p1.add(uberMesh(uber, 'm1', [10, 0, 0]));
    p1.add(uberMesh(uber, 'm2', [20, 0, 0]));
    p1.add(p2); p2.add(uberMesh(uber, 'm3', [30, 0, 0]));
    p1.add(uberMesh(uber, 'm4', [40, 0, 0]));
    root.add(p1);
    root.add(uberMesh(uber, 'loose', [50, 0, 0])); // no pick ancestor → unowned

    const asset = await bakeTree(root, { uber });
    const chunk = chunkByKey(asset, 'static');
    const { geometry, pick } = chunk;
    expect(geometry.index!.array).toBeInstanceOf(Uint32Array);
    assertSegmentsTileTheChunk(pick, geometry.index!.count);

    // Runs: P1 (m1, m2, m4 = 36 faces), P2 (m3 = 12 faces), root (loose = 12).
    // m1/m2/m4 have no surviving node between them and P1, so they share P1's
    // ordinal and stay ONE run although P2 sits between them in DFS order —
    // that is the pre-order ordering of plan-756 P1.
    expect(pick.segmentCount).toBe(3);
    const table = asset.nodeTable;
    const ordinalOf = (n: Object3D): number => table.ordinalOf.get(n)!;
    // Segments are ordered by the pre-order ordinal of their node, so `loose`
    // (whose nearest survivor is the ROOT, ordinal 0) comes first even though it
    // is the last child in DFS order.
    expect([...pick.segNode]).toEqual([ordinalOf(root), ordinalOf(p1), ordinalOf(p2)]);
    // `loose` has no pickable ancestor: unowned, which is what makes an opaque
    // chunk BLOCK there instead of letting the ray through (plan Q5).
    expect([...pick.segOwner]).toEqual([-1, ordinalOf(p1), ordinalOf(p2)]);
    expect([...pick.segIndexCount]).toEqual([12 * 3, 36 * 3, 12 * 3]);
    // P1's SUBTREE covers P2 as well — one contiguous range of 48 faces.
    expect(subtreeIndexCount(asset, chunk, p1)).toBe(48 * 3);
    expect(subtreeIndexCount(asset, chunk, p2)).toBe(12 * 3);
    expect(subtreeIndexCount(asset, chunk, root)).toBe(geometry.index!.count);

    // Every triangle resolves to the node its mesh sits under. Positions are
    // permuted INSIDE a segment, so the centroid is read from the final index.
    const faces = trianglesOf(geometry);
    for (let f = 0; f < faces; f++) {
      const x = faceCentroidX(geometry, f);
      const expected = x < 15 || (x > 15 && x < 25) || (x > 35 && x < 45) ? p1 : x < 35 ? p2 : root;
      const s = segmentOfIndex(pick, f * 3);
      expect(s, `face ${f} @x=${x}`).toBeGreaterThanOrEqual(0);
      expect(table.nodes[pick.segNode[s]], `face ${f} @x=${x}`).toBe(expected);
    }
    // Out of range → no segment.
    expect(segmentOfIndex(pick, geometry.index!.count)).toBe(-1);
    expect(segmentOfIndex(pick, -3)).toBe(-1);
  });

  it('only a pick !== none node owns a segment — plain groups and unknown components do not', async () => {
    const root = group('Asset');
    const plain = group('Plain');
    const odd = withComponent(group('Odd'), 'NotRegisteredAnywhere');
    plain.add(uberMesh(uber, 'a'));
    odd.add(uberMesh(uber, 'b', [3, 0, 0]));
    root.add(plain, odd);

    const asset = await bakeTree(root, { uber });
    const chunk = chunkByKey(asset, 'static');
    // Nothing pickable and nothing surviving below the root → ONE unowned
    // segment covering the whole chunk.
    expect(chunk.pick.segmentCount).toBe(1);
    expect(chunk.pick.segNode[0]).toBe(asset.nodeTable.ordinalOf.get(root));
    expect(chunk.pick.segOwner[0]).toBe(-1);
    expect(chunk.pick.segIndexStart[0]).toBe(0);
    expect(chunk.pick.segIndexCount[0]).toBe(chunk.geometry.index!.count);
  });

  it('a mover chunk\'s segments name the mover node', async () => {
    const root = group('Asset');
    const drive = withComponent(group('D'), 'Drive');
    drive.add(uberMesh(uber, 'arm'));
    root.add(drive);

    const asset = await bakeTree(root, { uber });
    const chunk = chunkByKey(asset, 'mover:D');
    const ordinal = asset.nodeTable.ordinalOf.get(drive)!;
    expect([...chunk.pick.segNode]).toEqual(new Array(chunk.pick.segmentCount).fill(ordinal));
  });

  it.each([65_536, 65_537])('keeps a Uint32 index at exactly %i vertices', async (n) => {
    const root = group('Asset');
    const positions = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { positions[i * 3] = i; positions[i * 3 + 1] = (i % 7); positions[i * 3 + 2] = 0; }
    const triCount = Math.floor(n / 3);
    const index = new Uint32Array(triCount * 3);
    for (let i = 0; i < triCount * 3; i++) index[i] = i;
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(positions, 3));
    geo.setIndex(new BufferAttribute(index, 1));
    geo.computeVertexNormals();
    uberBakeGeometry(geo);
    const mesh = new Mesh(geo, uber);
    mesh.name = 'big';
    mesh.userData._rvUberBaked = true;
    root.add(mesh);

    const asset = await bakeTree(root, { uber });
    const chunk = chunkByKey(asset, 'static');
    expect(chunk.geometry.getAttribute('position').count).toBe(n);
    expect(chunk.geometry.index!.array).toBeInstanceOf(Uint32Array);
    expect(chunk.geometry.index!.count).toBe(triCount * 3);
    expect(chunk.triangles).toBe(triCount);
  });

  it('a keep-only asset has zero chunks and is complete when bake() resolves', async () => {
    const root = group('Asset');
    const lamp = withComponent(group('Lamp'), 'Lamp');
    lamp.add(uberMesh(uber, 'bulb'));
    root.add(lamp);

    // plan-756 step 1d: there is no `asset.ready` to observe any more — the
    // resolution of `bake()` IS the readiness (F1), so a keep-only asset is
    // simply a resolved asset with no chunks.
    const asset = await bakeTree(root, { uber });
    expect(chunkKeys(asset)).toEqual([]);
    expect(asset.keep).toHaveLength(1);
  });

  it('registers every chunk geometry in chunkMetaOf and never touches the chunk drawRange via a proxy', async () => {
    const root = group('Asset');
    const p = withComponent(group('P'), 'TestPick');
    p.add(uberMesh(uber, 'a'), uberMesh(uber, 'b', [2, 0, 0]));
    root.add(p, uberMesh(uber, 'loose', [9, 0, 0]));

    const asset = await bakeTree(root, { uber });
    const chunk = chunkByKey(asset, 'static');
    expect(chunkMetaOf.get(chunk.geometry)?.asset).toBe(asset);
    expect(chunkMetaOf.get(chunk.geometry)?.chunk).toBe(chunk);

    const table = asset.nodeTable;
    const ordinal = table.ordinalOf.get(p)!;
    const row = table.rowStart[ordinal];
    const range = segmentRange(chunk.pick, table.rowFirstSeg[row], table.rowLastSeg[row])!;
    const proxy = makeRangeProxyGeometry(chunk, range);
    expect(proxy).not.toBe(chunk.geometry);
    expect(proxy.getAttribute('position')).toBe(chunk.geometry.getAttribute('position'));
    expect(proxy.index).toBe(chunk.geometry.index);
    expect(proxy.drawRange).toEqual({ start: range.indexStart, count: range.indexCount });
    expect(chunk.geometry.drawRange).toEqual({ start: 0, count: Infinity });
    // Sphere from the segment BOXES of the range (two unit boxes at x=0 and x=2),
    // not from the chunk (which reaches x=9) and no longer from a vertex sweep.
    expect(proxy.boundingSphere!.center.x).toBeCloseTo(1, 5);
    expect(proxy.boundingSphere!.radius).toBeLessThan(2.5);
  });
});
