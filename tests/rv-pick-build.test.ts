// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-756 §9.2 / §9.4a — the BUILD of the pick structure.
 *
 * Everything asserted here is a structural invariant the traversal and the
 * later bake rely on, not a performance property:
 *
 *   - the radix sort is a PERMUTATION inside each segment (winding intact) and
 *     segment boundaries never move,
 *   - every triangle sits in exactly one cluster,
 *   - every box contains what it claims to contain (cluster → segment → tree),
 *   - the wide 60-bit code path is a permutation too and quantises TIGHTER,
 *   - degenerate inputs (empty, flat, NaN) neither throw nor divide by zero,
 *   - the build is deterministic, and the sync and async drivers produce
 *     identical arrays (the precondition for worker == inline in step 1b).
 */

import { describe, expect, it } from 'vitest';
import {
  CLUSTER_TRIS,
  DEFAULT_SLICE_TRIS,
  LARGE_SEGMENT_CLUSTERS,
  buildPickStructure,
  buildPickStructureAsync,
  type PickBuildProgress,
  type PickSegmentInput,
} from '../src/core/engine/rv-pick-build';
import { PICK_LEAF_FLAG, type ChunkPickData } from '../src/core/engine/rv-pick-structure';
import {
  makeDegenerateCorpus,
  makeMicroFeatureBlock,
  makeMillionTriangleFixture,
  makePrimitiveAssembly,
  type PickFixture,
} from './helpers/pick-geometry';

/** Winding-preserving canonical form of one triangle (rotate smallest first). */
function triangleKey(index: Uint32Array, i: number): string {
  const a = index[i];
  const b = index[i + 1];
  const c = index[i + 2];
  if (a <= b && a <= c) return `${a},${b},${c}`;
  if (b <= a && b <= c) return `${b},${c},${a}`;
  return `${c},${a},${b}`;
}

function triangleKeys(index: Uint32Array, start: number, count: number): string[] {
  const keys: string[] = [];
  for (let i = start; i < start + count; i += 3) keys.push(triangleKey(index, i));
  keys.sort();
  return keys;
}

function boxContainsPoint(box: Float32Array, o: number, x: number, y: number, z: number): boolean {
  return (
    x >= box[o] && x <= box[o + 3] &&
    y >= box[o + 1] && y <= box[o + 4] &&
    z >= box[o + 2] && z <= box[o + 5]
  );
}

function boxContainsBox(outer: Float32Array, o: number, inner: Float32Array, i: number): boolean {
  // An empty inner box (never populated) is contained by definition.
  if (inner[i] > inner[i + 3]) return true;
  return (
    outer[o] <= inner[i] && outer[o + 3] >= inner[i + 3] &&
    outer[o + 1] <= inner[i + 1] && outer[o + 4] >= inner[i + 4] &&
    outer[o + 2] <= inner[i + 2] && outer[o + 5] >= inner[i + 5]
  );
}

/**
 * MEDIAN half surface area of the cluster boxes — the quantisation quality
 * metric. The median, not the sum: a handful of clusters inevitably straddle
 * two far-apart detail regions and their metre-sized boxes would drown out the
 * property under test.
 */
function medianClusterBoxArea(data: ChunkPickData): number {
  const areas: number[] = [];
  for (let c = 0; c < data.clusterCount; c++) {
    const o = c * 6;
    const x = data.clusterBox[o + 3] - data.clusterBox[o];
    const y = data.clusterBox[o + 4] - data.clusterBox[o + 1];
    const z = data.clusterBox[o + 5] - data.clusterBox[o + 2];
    if (x < 0 || y < 0 || z < 0) continue;
    areas.push(x * y + y * z + z * x);
  }
  areas.sort((a, b) => a - b);
  return areas.length === 0 ? 0 : areas[areas.length >> 1];
}

/** Index range of one cluster inside its segment. */
function clusterRange(data: ChunkPickData, cluster: number): { start: number; end: number } {
  const segment = data.clusterSeg[cluster];
  const segStart = data.segIndexStart[segment];
  const start = segStart + (cluster - data.segFirstCluster[segment]) * data.clusterTris * 3;
  const segEnd = segStart + data.segIndexCount[segment];
  const span = start + data.clusterTris * 3;
  return { start, end: span < segEnd ? span : segEnd };
}

function assertStructureInvariants(fixture: PickFixture, data: ChunkPickData, index: Uint32Array): void {
  // segment table unchanged
  expect(data.segmentCount).toBe(fixture.segments.length);
  for (let s = 0; s < data.segmentCount; s++) {
    expect(data.segIndexStart[s]).toBe(fixture.segments[s].indexStart);
    expect(data.segIndexCount[s]).toBe(fixture.segments[s].indexCount - (fixture.segments[s].indexCount % 3));
  }

  // every triangle in exactly one cluster: the clusters of a segment tile it
  const covered = new Uint8Array(index.length / 3);
  for (let s = 0; s < data.segmentCount; s++) {
    let cursor = data.segIndexStart[s];
    const end = cursor + data.segIndexCount[s];
    for (let c = data.segFirstCluster[s]; c < data.segFirstCluster[s + 1]; c++) {
      expect(data.clusterSeg[c]).toBe(s);
      const range = clusterRange(data, c);
      expect(range.start).toBe(cursor);
      expect(range.end).toBeGreaterThan(range.start);
      expect(range.end - range.start).toBeLessThanOrEqual(data.clusterTris * 3);
      for (let i = range.start; i < range.end; i += 3) {
        expect(covered[i / 3]).toBe(0);
        covered[i / 3] = 1;
      }
      cursor = range.end;
    }
    expect(cursor).toBe(end);
  }
  let coveredCount = 0;
  for (let t = 0; t < covered.length; t++) coveredCount += covered[t];
  let expectedCount = 0;
  for (let s = 0; s < data.segmentCount; s++) expectedCount += data.segIndexCount[s] / 3;
  expect(coveredCount).toBe(expectedCount);

  // cluster boxes contain their triangles; segment boxes contain their clusters
  for (let c = 0; c < data.clusterCount; c++) {
    const range = clusterRange(data, c);
    for (let i = range.start; i < range.end; i++) {
      const v = index[i] * 3;
      expect(
        boxContainsPoint(data.clusterBox, c * 6, fixture.position[v], fixture.position[v + 1], fixture.position[v + 2]),
      ).toBe(true);
    }
    expect(boxContainsBox(data.segBox, data.clusterSeg[c] * 6, data.clusterBox, c * 6)).toBe(true);
  }

  // clusterOrder is a permutation of all clusters
  const seen = new Uint8Array(data.clusterCount);
  expect(data.clusterOrder.length).toBe(data.clusterCount);
  for (let p = 0; p < data.clusterOrder.length; p++) {
    const c = data.clusterOrder[p];
    expect(seen[c]).toBe(0);
    seen[c] = 1;
  }

  // tree: every node's box contains its children / its clusters, leaves tile
  // clusterOrder exactly once, and the recorded depth is not under-reported
  const leafCovered = new Uint8Array(data.clusterCount);
  let deepest = 0;
  const stack: Array<{ node: number; depth: number }> = data.treeNodeCount > 0 ? [{ node: data.treeRoot, depth: 1 }] : [];
  let visited = 0;
  while (stack.length > 0) {
    const { node, depth } = stack.pop() as { node: number; depth: number };
    visited++;
    if (depth > deepest) deepest = depth;
    const link0 = data.treeLink[2 * node];
    if (link0 >= PICK_LEAF_FLAG) {
      const first = link0 & 0x7fffffff;
      const count = data.treeLink[2 * node + 1];
      expect(count).toBeGreaterThan(0);
      for (let p = first; p < first + count; p++) {
        expect(leafCovered[p]).toBe(0);
        leafCovered[p] = 1;
        expect(boxContainsBox(data.treeBox, node * 6, data.clusterBox, data.clusterOrder[p] * 6)).toBe(true);
      }
    } else {
      const right = data.treeLink[2 * node + 1];
      expect(boxContainsBox(data.treeBox, node * 6, data.treeBox, link0 * 6)).toBe(true);
      expect(boxContainsBox(data.treeBox, node * 6, data.treeBox, right * 6)).toBe(true);
      stack.push({ node: link0, depth: depth + 1 });
      stack.push({ node: right, depth: depth + 1 });
    }
  }
  expect(visited).toBe(data.treeNodeCount);
  expect(deepest).toBeLessThanOrEqual(data.treeMaxDepth);
  for (let p = 0; p < data.clusterCount; p++) expect(leafCovered[p]).toBe(1);
}

function copyFixture(fixture: PickFixture): { position: Float32Array; index: Uint32Array; segments: PickSegmentInput[] } {
  return { position: fixture.position, index: fixture.index.slice(), segments: fixture.segments.map((s) => ({ ...s })) };
}

describe('buildPickStructure — structural invariants', () => {
  const fixtures: PickFixture[] = [makePrimitiveAssembly(), makeDegenerateCorpus(), makeMicroFeatureBlock(2000)];

  for (const fixture of fixtures) {
    it(`${fixture.label}: sort is a per-segment permutation, clusters tile, boxes contain`, () => {
      const work = copyFixture(fixture);
      const before = fixture.segments.map((s) =>
        triangleKeys(fixture.index, s.indexStart, s.indexCount - (s.indexCount % 3)),
      );
      const result = buildPickStructure(work.position, work.index, work.segments);

      // Permutation INSIDE each segment, winding preserved, boundaries fixed.
      for (let s = 0; s < work.segments.length; s++) {
        const count = result.data.segIndexCount[s];
        const after = triangleKeys(result.index, result.data.segIndexStart[s], count);
        expect(after).toEqual(before[s]);
      }
      assertStructureInvariants(fixture, result.data, result.index);
    });
  }

  it('sorting a segment never moves a triangle across a segment boundary', () => {
    // Two segments of the SAME geometry side by side: if the sort escaped its
    // segment, the two key sets would mix.
    const base = makePrimitiveAssembly();
    const work = copyFixture(base);
    const keysPerSegment = base.segments.map((s) =>
      new Set(triangleKeys(base.index, s.indexStart, s.indexCount - (s.indexCount % 3))),
    );
    const result = buildPickStructure(work.position, work.index, work.segments);
    for (let s = 0; s < work.segments.length; s++) {
      const start = result.data.segIndexStart[s];
      const end = start + result.data.segIndexCount[s];
      for (let i = start; i < end; i += 3) {
        expect(keysPerSegment[s].has(triangleKey(result.index, i))).toBe(true);
      }
    }
  });

  it('is deterministic and identical between the sync and the async driver', async () => {
    const fixture = makePrimitiveAssembly();
    const a = buildPickStructure(fixture.position, fixture.index.slice(), fixture.segments.map((s) => ({ ...s })));
    const b = buildPickStructure(fixture.position, fixture.index.slice(), fixture.segments.map((s) => ({ ...s })));
    const c = await buildPickStructureAsync(
      fixture.position,
      fixture.index.slice(),
      fixture.segments.map((s) => ({ ...s })),
      { onYield: async () => { await Promise.resolve(); } },
    );
    expect(Array.from(b.index)).toEqual(Array.from(a.index));
    expect(Array.from(c.index)).toEqual(Array.from(a.index));
    for (const key of ['clusterBox', 'clusterSeg', 'clusterOrder', 'treeBox', 'treeLink', 'segBox'] as const) {
      expect(Array.from(b.data[key])).toEqual(Array.from(a.data[key]));
      expect(Array.from(c.data[key])).toEqual(Array.from(a.data[key]));
    }
    expect(b.data.treeNodeCount).toBe(a.data.treeNodeCount);
    expect(c.data.treeNodeCount).toBe(a.data.treeNodeCount);
  });

  it('keeps node / owner ordinals and the material flags verbatim', () => {
    const fixture = makePrimitiveAssembly();
    const result = buildPickStructure(
      fixture.position,
      fixture.index.slice(),
      fixture.segments.map((s) => ({ ...s })),
      { blocks: false, doubleSided: true },
    );
    expect(result.data.blocks).toBe(false);
    expect(result.data.doubleSided).toBe(true);
    for (let s = 0; s < fixture.segments.length; s++) {
      expect(result.data.segNode[s]).toBe(fixture.segments[s].node);
      expect(result.data.segOwner[s]).toBe(fixture.segments[s].owner);
    }
  });
});

describe('buildPickStructure — size-dependent paths', () => {
  it('skips Morton and sort for segments of at most CLUSTER_TRIS triangles', () => {
    // 100 triangles in one segment: one cluster, original order untouched.
    const fixture = makeDegenerateCorpus();
    const index = fixture.index.slice(0, 100 * 3);
    const before = Array.from(index);
    const result = buildPickStructure(fixture.position, index, [{ indexStart: 0, indexCount: index.length }]);
    expect(result.data.clusterCount).toBe(1);
    expect(result.stats.sortedSegments).toBe(0);
    expect(Array.from(result.index)).toEqual(before);
    expect(100).toBeLessThanOrEqual(CLUSTER_TRIS);
  });

  it('the wide 60-bit path is a permutation and quantises tighter than 30 bit', () => {
    // 1 m plate with 0.2 mm ribs: at this size a 30-bit grid has ~1 mm cells
    // and cannot separate the ribs, the 60-bit grid has ~1 µm cells.
    const fixture = makeMicroFeatureBlock();
    expect(fixture.triangles).toBeGreaterThan(LARGE_SEGMENT_CLUSTERS * CLUSTER_TRIS);

    const wide = buildPickStructure(fixture.position, fixture.index.slice(), fixture.segments.map((s) => ({ ...s })), {
      wideCodes: 'always',
    });
    const narrow = buildPickStructure(fixture.position, fixture.index.slice(), fixture.segments.map((s) => ({ ...s })), {
      wideCodes: 'never',
    });
    expect(wide.stats.wideSegments).toBe(1);
    expect(narrow.stats.wideSegments).toBe(0);

    // permutation (winding preserved) for BOTH paths
    const before = triangleKeys(fixture.index, 0, fixture.index.length);
    expect(triangleKeys(wide.index, 0, wide.index.length)).toEqual(before);
    expect(triangleKeys(narrow.index, 0, narrow.index.length)).toEqual(before);
    assertStructureInvariants(fixture, wide.data, wide.index);

    const wideArea = medianClusterBoxArea(wide.data);
    const narrowArea = medianClusterBoxArea(narrow.data);
    // eslint-disable-next-line no-console
    console.log(
      `PICK756 wide-vs-narrow medianClusterArea wide=${wideArea.toExponential(3)} ` +
        `narrow=${narrowArea.toExponential(3)} factor=${(narrowArea / wideArea).toFixed(1)}`,
    );
    // Not merely "smaller": at 1 mm cells over a metre-sized box the 30-bit
    // grid cannot order inside a 2 mm detail cube at all.
    expect(wideArea).toBeLessThan(narrowArea * 0.5);
  });

  it('auto mode picks the wide path exactly above LARGE_SEGMENT_CLUSTERS × CLUSTER_TRIS', () => {
    const fixture = makeMicroFeatureBlock(9000);
    const small = buildPickStructure(fixture.position, fixture.index.slice(), [
      { indexStart: 0, indexCount: LARGE_SEGMENT_CLUSTERS * CLUSTER_TRIS * 3 },
    ]);
    expect(small.stats.wideSegments).toBe(0);
    const large = buildPickStructure(fixture.position, fixture.index.slice(), [
      { indexStart: 0, indexCount: (LARGE_SEGMENT_CLUSTERS * CLUSTER_TRIS + 1) * 3 },
    ]);
    expect(large.stats.wideSegments).toBe(1);
  });
});

describe('buildPickStructure — degenerate inputs', () => {
  it('an empty segment list and a zero-triangle chunk build an empty structure', () => {
    const empty = buildPickStructure(new Float32Array(0), new Uint32Array(0), []);
    expect(empty.data.segmentCount).toBe(0);
    expect(empty.data.clusterCount).toBe(0);
    expect(empty.data.treeNodeCount).toBe(0);
    expect(empty.data.triangleCount).toBe(0);

    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const zeroTris = buildPickStructure(positions, new Uint32Array(0), [{ indexStart: 0, indexCount: 0 }]);
    expect(zeroTris.data.segmentCount).toBe(1);
    expect(zeroTris.data.clusterCount).toBe(0);
    expect(zeroTris.data.treeNodeCount).toBe(0);
  });

  it('a truncated index count is rounded down to whole triangles', () => {
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]);
    const index = new Uint32Array([0, 1, 2, 0, 2, 3]);
    const result = buildPickStructure(positions, index, [{ indexStart: 0, indexCount: 5 }]);
    expect(result.data.segIndexCount[0]).toBe(3);
    expect(result.data.clusterCount).toBe(1);
  });

  it('a flat (zero-extent) segment box does not divide by zero', () => {
    // 4000 coplanar triangles, all z = 0 → one extent is exactly 0, and the
    // segment is large enough to be Morton-sorted.
    const count = 4000;
    const positions = new Float32Array(count * 9);
    const index = new Uint32Array(count * 3);
    const random = (() => { let a = 1; return () => { a = (a * 1103515245 + 12345) & 0x7fffffff; return a / 0x7fffffff; }; })();
    for (let t = 0; t < count; t++) {
      const x = random();
      const y = random();
      positions.set([x, y, 0, x + 0.01, y, 0, x, y + 0.01, 0], t * 9);
      index.set([3 * t, 3 * t + 1, 3 * t + 2], t * 3);
    }
    const result = buildPickStructure(positions, index, [{ indexStart: 0, indexCount: index.length }]);
    expect(result.stats.sortedSegments).toBe(1);
    expect(Number.isFinite(result.data.segBox[2])).toBe(true);
    expect(result.data.segBox[2]).toBe(0);
    expect(result.data.segBox[5]).toBe(0);
    for (let i = 0; i < result.data.treeBox.length; i++) expect(Number.isFinite(result.data.treeBox[i])).toBe(true);
  });

  it('a fully degenerate (single point) segment builds without dividing by zero', () => {
    const count = 500;
    const positions = new Float32Array(count * 9);
    const index = new Uint32Array(count * 3);
    for (let t = 0; t < count; t++) index.set([3 * t, 3 * t + 1, 3 * t + 2], t * 3);
    const result = buildPickStructure(positions, index, [{ indexStart: 0, indexCount: index.length }]);
    expect(result.data.segBox[0]).toBe(0);
    expect(result.data.segBox[3]).toBe(0);
    expect(result.data.clusterCount).toBe(Math.ceil(count / CLUSTER_TRIS));
  });

  it('NaN positions neither throw nor poison a box', () => {
    const count = 600;
    const positions = new Float32Array(count * 9);
    const index = new Uint32Array(count * 3);
    for (let t = 0; t < count; t++) {
      const x = t * 0.01;
      positions.set([x, 0, 0, x + 0.005, 0, 0, x, 0.005, 0], t * 9);
      index.set([3 * t, 3 * t + 1, 3 * t + 2], t * 3);
    }
    // Poison every 7th vertex.
    for (let v = 0; v < count * 3; v += 7) positions[v * 3] = NaN;
    const result = buildPickStructure(positions, index, [{ indexStart: 0, indexCount: index.length }]);
    // A NaN never enters a box (every comparison against it is false), so the
    // boxes stay finite and the structure is usable.
    expect(Number.isNaN(result.data.segBox[0])).toBe(false);
    expect(Number.isNaN(result.data.segBox[3])).toBe(false);
    for (let i = 0; i < result.data.clusterBox.length; i++) expect(Number.isNaN(result.data.clusterBox[i])).toBe(false);
    for (let i = 0; i < result.data.treeBox.length; i++) expect(Number.isNaN(result.data.treeBox[i])).toBe(false);
  });

  it('an all-NaN segment yields an empty box instead of throwing', () => {
    const count = 300;
    const positions = new Float32Array(count * 9).fill(NaN);
    const index = new Uint32Array(count * 3);
    for (let t = 0; t < count; t++) index.set([3 * t, 3 * t + 1, 3 * t + 2], t * 3);
    const result = buildPickStructure(positions, index, [{ indexStart: 0, indexCount: index.length }]);
    expect(result.data.segBox[0]).toBe(Infinity);
    expect(result.data.segBox[3]).toBe(-Infinity);
    expect(result.data.clusterCount).toBeGreaterThan(0);
  });
});

describe('buildPickStructure — yield hook (step 1b input)', () => {
  it('reports at least one checkpoint per segment and never exceeds the slice budget', () => {
    const fixture = makePrimitiveAssembly();
    const seen: PickBuildProgress[] = [];
    const result = buildPickStructure(
      fixture.position,
      fixture.index.slice(),
      fixture.segments.map((s) => ({ ...s })),
      { onYield: (p) => seen.push({ ...p }) },
    );
    expect(seen.length).toBe(result.stats.checkpoints);
    // One 'cluster' end-of-segment checkpoint per segment, plus tree phases.
    const perSegment = new Set(seen.filter((p) => p.segment >= 0).map((p) => p.segment));
    expect(perSegment.size).toBe(fixture.segments.length);
    expect(seen.some((p) => p.phase === 'tree')).toBe(true);
  });

  it('slices a huge single segment into small pieces (no long main-thread block)', () => {
    const fixture = makeMillionTriangleFixture();
    const sliceTris = 65536;
    // Measured from the FIRST checkpoint on: the interval before it also
    // contains the one-off scratch allocation (~60 MB of zeroed typed arrays),
    // which is not a slice of work and is reported separately below.
    let last = 0;
    let allocMs = 0;
    const started = performance.now();
    let maxSliceMs = 0;
    let maxSlicePhase = '';
    let checkpointsInSegment = 0;
    const sliceMs: number[] = [];
    const result = buildPickStructure(
      fixture.position,
      fixture.index.slice(),
      fixture.segments.map((s) => ({ ...s })),
      {
        sliceTris,
        onYield: (p) => {
          const now = performance.now();
          if (last === 0) allocMs = now - started;
          else {
            const dt = now - last;
            sliceMs.push(dt);
            if (dt > maxSliceMs) { maxSliceMs = dt; maxSlicePhase = p.phase; }
          }
          last = now;
          if (p.segment === 0) checkpointsInSegment++;
        },
      },
    );
    const sorted = sliceMs.slice().sort((a, b) => a - b);
    const quantile = (q: number): number => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
    // eslint-disable-next-line no-console
    console.log(
      `PICK756 slice tris=${fixture.triangles} checkpoints=${result.stats.checkpoints} ` +
        `inSegment=${checkpointsInSegment} sliceMs p50=${quantile(0.5).toFixed(2)} p95=${quantile(0.95).toFixed(2)} ` +
        `max=${maxSliceMs.toFixed(2)} (phase ${maxSlicePhase}) allocMs=${allocMs.toFixed(2)} ` +
        `buildMs=${result.stats.buildMs.toFixed(1)} transientMB=${(result.stats.transientBytes / 1048576).toFixed(1)}`,
    );
    expect(result.stats.wideSegments).toBe(1);
    // A single segment of ~1 M triangles must be chopped up, not built in one go.
    expect(checkpointsInSegment).toBeGreaterThan(fixture.triangles / sliceTris);
    // A slice of work is small; the occasional outlier is a GC pause on the
    // 35 MB of scratch, not a slice that does too much. Step 1b replaces the
    // triangle budget with a real time budget, which is where the plan's
    // 100 ms main-thread gate is actually enforced.
    expect(quantile(0.5)).toBeLessThan(10);
    expect(quantile(0.95)).toBeLessThan(50);
    expect(maxSliceMs).toBeLessThan(150);
    expect(DEFAULT_SLICE_TRIS).toBeGreaterThan(0);
  }, 120_000);
});
