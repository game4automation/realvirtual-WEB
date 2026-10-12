// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-756 §9.1 / §9.4a — PARITY of the own traversal against three-mesh-bvh.
 *
 * This is the safety net of the hard cut (plan risk R1): with no runtime
 * fallback left after step 1d, the only thing that can justify deleting a
 * proven traversal is a suite that proves the replacement answers the same
 * question. Two independent oracles are used on purpose:
 *
 *   1. **Brute force with the SAME watertight triangle test** — proves the
 *      TRAVERSAL (tree, clusters, pruning, hidden skip, NaN slab). Must be
 *      bit-identical, no tolerance.
 *   2. **`MeshBVH.raycastFirst`** — proves the whole thing against the library
 *      being replaced, including its Möller–Trumbore triangle test. Compared
 *      with a relative tolerance, because the two triangle tests legitimately
 *      disagree on degenerate and edge-exact geometry (which is the reason the
 *      watertight test was chosen at all).
 *
 * Ray sets: seeded random, exactly axis-parallel (the `0 · ∞` NaN case), and
 * rays aimed at shared edges and vertices (the watertightness case). Every
 * clean geometry runs both `FrontSide` and `DoubleSide`.
 */

import { describe, expect, it } from 'vitest';
import { BufferAttribute, BufferGeometry, DoubleSide, FrontSide, Ray, type Side } from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { buildPickStructure } from '../src/core/engine/rv-pick-build';
import {
  createPickCounters,
  raycastPickNearest,
  raycastRangeBruteForceSided,
  raycastSurfaceNearest,
  pickStructureBytes,
  type ChunkPickData,
} from '../src/core/engine/rv-pick-structure';
import {
  axisParallelRays,
  edgeAndVertexRays,
  makeDegenerateCorpus,
  makeMillionTriangleFixture,
  makePrimitiveAssembly,
  makeThinSheet,
  mirrorFixture,
  randomRays,
  reverseWinding,
  type PickFixture,
} from './helpers/pick-geometry';

const RELATIVE_TOLERANCE = 1e-4;

interface Built {
  fixture: PickFixture;
  data: ChunkPickData;
  index: Uint32Array;
  bvh: MeshBVH;
}

function build(fixture: PickFixture, doubleSided: boolean): Built {
  const index = fixture.index.slice();
  const result = buildPickStructure(fixture.position, index, fixture.segments.map((s) => ({ ...s })), { doubleSided });
  // The oracle gets its OWN geometry: a default MeshBVH build reorders the
  // index in place, which would destroy the segment layout (plan §2.4a.10).
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(fixture.position, 3));
  geometry.setIndex(new BufferAttribute(fixture.index.slice(), 1));
  return { fixture, data: result.data, index: result.index, bvh: new MeshBVH(geometry) };
}

const scratchRay = new Ray();

function oracleDistance(bvh: MeshBVH, rays: Float64Array, i: number, side: Side): number {
  const o = i * 6;
  scratchRay.origin.set(rays[o], rays[o + 1], rays[o + 2]);
  scratchRay.direction.set(rays[o + 3], rays[o + 4], rays[o + 5]);
  const hit = bvh.raycastFirst(scratchRay, side);
  return hit ? hit.distance : Infinity;
}

function ownDistance(built: Built, rays: Float64Array, i: number, flipWinding = false): number {
  const o = i * 6;
  const hit = raycastSurfaceNearest(
    built.data,
    built.fixture.position,
    built.index,
    rays[o], rays[o + 1], rays[o + 2],
    rays[o + 3], rays[o + 4], rays[o + 5],
    { flipWinding },
  );
  return hit === null ? Infinity : hit.distance;
}

function agree(a: number, b: number): boolean {
  if (a === Infinity && b === Infinity) return true;
  if (a === Infinity || b === Infinity) return false;
  return Math.abs(a - b) <= RELATIVE_TOLERANCE * Math.max(Math.abs(a), Math.abs(b));
}

interface Comparison {
  rays: number;
  hits: number;
  oracleHits: number;
  mismatches: number;
  maxRelative: number;
}

function compareToOracle(built: Built, rays: Float64Array, side: Side): Comparison {
  const count = rays.length / 6;
  let hits = 0;
  let oracleHits = 0;
  let mismatches = 0;
  let maxRelative = 0;
  for (let i = 0; i < count; i++) {
    const mine = ownDistance(built, rays, i);
    const theirs = oracleDistance(built.bvh, rays, i, side);
    if (mine !== Infinity) hits++;
    if (theirs !== Infinity) oracleHits++;
    if (!agree(mine, theirs)) {
      mismatches++;
      continue;
    }
    if (mine !== Infinity) {
      const rel = Math.abs(mine - theirs) / Math.max(mine, theirs);
      if (rel > maxRelative) maxRelative = rel;
    }
  }
  return { rays: count, hits, oracleHits, mismatches, maxRelative };
}

/** The traversal's own oracle: same triangle test, every triangle, no tree. */
function compareToBruteForce(built: Built, rays: Float64Array, count: number, frontSign: number): number {
  let differences = 0;
  const limit = Math.min(count, rays.length / 6);
  for (let i = 0; i < limit; i++) {
    const o = i * 6;
    const mine = raycastSurfaceNearest(
      built.data,
      built.fixture.position,
      built.index,
      rays[o], rays[o + 1], rays[o + 2],
      rays[o + 3], rays[o + 4], rays[o + 5],
    );
    const brute = raycastRangeBruteForceSided(
      built.fixture.position,
      built.index,
      0,
      built.index.length,
      rays[o], rays[o + 1], rays[o + 2],
      rays[o + 3], rays[o + 4], rays[o + 5],
      frontSign,
    );
    const a = mine === null ? Infinity : mine.distance;
    const b = brute === null ? Infinity : brute.distance;
    // Bit-identical: same set of triangles, same test — the tree may only
    // change WHICH of two exactly-equidistant triangles wins, and that cannot
    // change the distance.
    if (a !== b) differences++;
  }
  return differences;
}

function log(line: string): void {
  // eslint-disable-next-line no-console
  console.log(`PICK756 ${line}`);
}

describe('pick structure == MeshBVH oracle', () => {
  const clean: PickFixture[] = [makePrimitiveAssembly(), makeThinSheet(), mirrorFixture(makePrimitiveAssembly())];

  for (const fixture of clean) {
    it(`${fixture.label}: 10 000 random rays agree, both sides`, () => {
      const random = randomRays(fixture, 10_000, 756);
      for (const doubleSided of [true, false]) {
        const built = build(fixture, doubleSided);
        const side = doubleSided ? DoubleSide : FrontSide;
        const result = compareToOracle(built, random, side);
        log(
          `parity ${fixture.label} side=${doubleSided ? 'double' : 'front'} rays=${result.rays} ` +
            `hitRate=${(result.hits / result.rays).toFixed(3)} mismatches=${result.mismatches} ` +
            `maxRel=${result.maxRelative.toExponential(2)} structureBytes=${pickStructureBytes(built.data)}`,
        );
        expect(result.hits).toBeGreaterThan(result.rays * 0.2);
        expect(result.mismatches).toBe(0);
        // The traversal itself must be exact against brute force.
        expect(compareToBruteForce(built, random, 150, doubleSided ? 0 : 1)).toBe(0);
      }
    }, 180_000);

    it(`${fixture.label}: 1 000 axis-parallel + 1 000 edge/vertex rays agree`, () => {
      const built = build(fixture, true);
      const axis = axisParallelRays(fixture, 1000, 757);
      const edges = edgeAndVertexRays(fixture, 1000, 758);
      const axisResult = compareToOracle(built, axis, DoubleSide);
      const edgeResult = compareToOracle(built, edges, DoubleSide);
      log(
        `parity ${fixture.label} axisParallel mismatches=${axisResult.mismatches}/${axisResult.rays} ` +
          `edgeVertex mismatches=${edgeResult.mismatches}/${edgeResult.rays} ` +
          `edgeHits=${edgeResult.hits} oracleEdgeHits=${edgeResult.oracleHits}`,
      );
      // Axis-parallel rays are the NaN slab case — no tolerance at all.
      expect(compareToBruteForce(built, axis, 1000, 0)).toBe(0);
      expect(axisResult.mismatches).toBe(0);
      // Edge/vertex rays: the traversal must be EXACT against the same
      // triangle test. Against three-mesh-bvh a few percent disagree by
      // construction — Möller–Trumbore leaks on an exactly-hit shared edge,
      // which is the whole reason the watertight test was chosen (plan P5).
      // The assertion that carries the meaning is therefore not "they agree"
      // but "we never lose a surface the library finds".
      expect(compareToBruteForce(built, edges, 1000, 0)).toBe(0);
      expect(edgeResult.hits).toBeGreaterThanOrEqual(edgeResult.oracleHits * 0.99);
      expect(edgeResult.hits).toBeGreaterThan(edgeResult.rays * 0.95);
      expect(edgeResult.mismatches).toBeLessThanOrEqual(edgeResult.rays * 0.06);
    }, 180_000);
  }

  it('degenerate corpus (zero-area, needles, duplicates): traversal exact, oracle close', () => {
    const fixture = makeDegenerateCorpus();
    const built = build(fixture, true);
    const random = randomRays(fixture, 10_000, 759);
    const result = compareToOracle(built, random, DoubleSide);
    log(
      `parity ${fixture.label} rays=${result.rays} hitRate=${(result.hits / result.rays).toFixed(3)} ` +
        `mismatches=${result.mismatches} maxRel=${result.maxRelative.toExponential(2)}`,
    );
    // Against the same triangle test: exact, every ray.
    expect(compareToBruteForce(built, random, 2000, 0)).toBe(0);
    // Against three-mesh-bvh: the two triangle tests disagree exactly where
    // the corpus is degenerate. Recorded bound, not a free pass.
    expect(result.mismatches).toBeLessThanOrEqual(result.rays * 0.02);
  }, 180_000);

  it('flipWinding is equivalent to reversing the winding of the geometry', () => {
    const fixture = makePrimitiveAssembly();
    const reversed = reverseWinding(fixture);
    const straight = build(fixture, false);
    const flipped = build(reversed, false);
    const rays = randomRays(fixture, 4000, 760);
    let differences = 0;
    let hitMissDiffers = 0;
    let maxRelative = 0;
    for (let i = 0; i < rays.length / 6; i++) {
      // Front-face culling with flipped winding on the ORIGINAL geometry must
      // answer what the reversed geometry answers without the flag.
      const a = ownDistance(straight, rays, i, true);
      const b = ownDistance(flipped, rays, i, false);
      if ((a === Infinity) !== (b === Infinity)) {
        hitMissDiffers++;
        continue;
      }
      if (a === Infinity) continue;
      const rel = Math.abs(a - b) / Math.max(a, b);
      if (rel > maxRelative) maxRelative = rel;
      // Reversing the winding reassociates the float sums of the watertight
      // test (B and C swap roles), so identical geometry legitimately differs
      // in the last ulp. The SET of accepted triangles must be identical.
      if (rel > 1e-12) differences++;
    }
    log(`parity flipWinding hitMissDiffers=${hitMissDiffers} beyond1e12=${differences}/${rays.length / 6} maxRel=${maxRelative.toExponential(2)}`);
    expect(hitMissDiffers).toBe(0);
    expect(differences).toBe(0);
    // And it really is front-face culling: the flipped run must differ from
    // the unflipped one on a closed body.
    let flippedDiffers = 0;
    for (let i = 0; i < 500; i++) {
      if (!agree(ownDistance(straight, rays, i, true), ownDistance(straight, rays, i, false))) flippedDiffers++;
    }
    expect(flippedDiffers).toBeGreaterThan(0);
  }, 120_000);

  it('records triangles tested per ray on the thin curved sheet (plan risk R3)', () => {
    const fixture = makeThinSheet();
    const built = build(fixture, true);
    const rays = randomRays(fixture, 5000, 761);
    const counters = createPickCounters();
    for (let i = 0; i < rays.length / 6; i++) {
      const o = i * 6;
      raycastSurfaceNearest(
        built.data,
        fixture.position,
        built.index,
        rays[o], rays[o + 1], rays[o + 2],
        rays[o + 3], rays[o + 4], rays[o + 5],
        { counters },
      );
    }
    const perRay = counters.trianglesTested / counters.rays;
    const boxesPerRay = counters.boxesTested / counters.rays;
    log(
      `R3 thinSheet tris=${fixture.triangles} trianglesPerRay=${perRay.toFixed(1)} ` +
        `boxesPerRay=${boxesPerRay.toFixed(1)} structurePct=` +
        `${((100 * pickStructureBytes(built.data)) / (fixture.position.byteLength + built.index.byteLength)).toFixed(2)}`,
    );
    // Bounded brute force, not a whole-chunk scan: the recorded bound for this
    // worst case. Tuning CLUSTER_TRIS in step 1e moves this number.
    expect(perRay).toBeLessThan(4000);
    expect(perRay).toBeLessThan(fixture.triangles * 0.05);
  }, 120_000);

  it('pick mode marks an unowned segment of an opaque chunk as blocked', () => {
    // The thin sheet's outer skin owns nothing (owner -1); the inner one does.
    const fixture = makeThinSheet(60, 40);
    const index = fixture.index.slice();
    const built = buildPickStructure(fixture.position, index, fixture.segments.map((s) => ({ ...s })), {
      doubleSided: true,
      blocks: true,
    });
    const rays = randomRays(fixture, 2000, 762);
    let blocked = 0;
    let owned = 0;
    for (let i = 0; i < rays.length / 6; i++) {
      const o = i * 6;
      const hit = raycastPickNearest(
        built.data,
        fixture.position,
        built.index,
        rays[o], rays[o + 1], rays[o + 2],
        rays[o + 3], rays[o + 4], rays[o + 5],
      );
      if (hit === null) continue;
      if (hit.blocked) {
        expect(hit.owner).toBe(-1);
        blocked++;
      } else {
        expect(hit.owner).toBeGreaterThanOrEqual(0);
        owned++;
      }
    }
    log(`semantics thinSheet blockedHits=${blocked} ownedHits=${owned}`);
    expect(blocked).toBeGreaterThan(0);
    expect(owned).toBeGreaterThan(0);

    // Skipping the unowned (front) segment must let the owned one through.
    let skippedToOwned = 0;
    for (let i = 0; i < 500; i++) {
      const o = i * 6;
      const hit = raycastPickNearest(
        built.data,
        fixture.position,
        built.index,
        rays[o], rays[o + 1], rays[o + 2],
        rays[o + 3], rays[o + 4], rays[o + 5],
        { hiddenSegments: new Set([1]) },
      );
      if (hit !== null) {
        expect(hit.segment).toBe(0);
        skippedToOwned++;
      }
    }
    expect(skippedToOwned).toBeGreaterThan(0);
  }, 120_000);

  it('measures build and ray cost on a ~1 M triangle geometry', () => {
    const fixture = makeMillionTriangleFixture();
    const index = fixture.index.slice();
    const t0 = performance.now();
    const result = buildPickStructure(fixture.position, index, fixture.segments.map((s) => ({ ...s })), {
      doubleSided: true,
    });
    const buildMs = performance.now() - t0;

    const rays = randomRays(fixture, 5000, 763);
    const counters = createPickCounters();
    const cast = (i: number): void => {
      const o = i * 6;
      raycastSurfaceNearest(
        result.data,
        fixture.position,
        result.index,
        rays[o], rays[o + 1], rays[o + 2],
        rays[o + 3], rays[o + 4], rays[o + 5],
        { counters },
      );
    };
    for (let i = 0; i < 500; i++) cast(i);
    const t1 = performance.now();
    for (let i = 0; i < 5000; i++) cast(i);
    const meanRayMs = (performance.now() - t1) / 5000;

    const geometryBytes = fixture.position.byteLength + result.index.byteLength;
    log(
      `perf 1M triangles=${fixture.triangles} buildMs=${buildMs.toFixed(1)} ` +
        `(stats ${result.stats.buildMs.toFixed(1)}, tree ${result.stats.treeNodes} nodes depth ${result.stats.treeMaxDepth}) ` +
        `meanRayMs=${meanRayMs.toFixed(4)} trianglesPerRay=${(counters.trianglesTested / counters.rays).toFixed(1)} ` +
        `boxesPerRay=${(counters.boxesTested / counters.rays).toFixed(1)} ` +
        `structureBytes=${pickStructureBytes(result.data)} pctOfGeometry=` +
        `${((100 * pickStructureBytes(result.data)) / geometryBytes).toFixed(2)}`,
    );
    // Not a gate (plan §9.6 owns the gates) — but a regression this coarse
    // would mean something is structurally wrong.
    expect(meanRayMs).toBeLessThan(1);
    expect(result.stats.clusters).toBeGreaterThan(0);
  }, 300_000);
});
