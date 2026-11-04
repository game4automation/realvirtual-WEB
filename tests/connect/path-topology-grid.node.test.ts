// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * path-topology-grid.node.test.ts — plan-644 § 9.3.
 *
 * `analysePathEnds` finds its candidates through a `SpatialGridXZ` since
 * plan-644 Phase 2.6. These tests pin that the result is IDENTICAL — finding
 * for finding, in the same order — to the former O(P²) pair scan, kept here as
 * the reference: seed-fixed random networks of 50 and 500 paths, ties,
 * negative coordinates on cell boundaries, equal XZ with different Y, free
 * tolerances and the exact bound cases of SOL R2 #2. `analysePathEnd` must
 * return the subset of one end, in the same order.
 */

import { describe, it, expect } from 'vitest';
import { parsePathExtras, getPathEndpoints, type RVPath } from '../../src/core/engine/rv-path';
import {
  analysePathEnd,
  analysePathEnds,
  type PathEndAnalysis,
  type PathLinkPair,
  type PathNearMiss,
} from '../../src/core/connect/path-topology';
import {
  PATH_END_NEAR_MISS_M,
  PATH_LINK_TOLERANCE,
  isPathLink,
  tangentAngleDeg,
} from '../../src/core/connect/path-link-tolerance';

type V3 = [number, number, number];
type Tol = Readonly<{ distM: number; tangentDeg: number }>;

function line(id: string, from: V3, to: V3): RVPath {
  const p = parsePathExtras({ type: 'Path', id, segments: [{ kind: 'line', from, to }] }, id);
  expect(p, `path ${id} parses`).not.toBeNull();
  return p!;
}

/** The pre-plan-644 O(P²) scan, verbatim — the reference. */
function referenceAnalyse(source: readonly RVPath[], tol: Tol = PATH_LINK_TOLERANCE): PathEndAnalysis {
  const paths = [...source].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const ends = paths.map((p) => getPathEndpoints(p));
  const links: PathLinkPair[] = [];
  const nearMisses: PathNearMiss[] = [];
  for (let i = 0; i < paths.length; i++) {
    const a = ends[i];
    if (!a) continue;
    for (let j = 0; j < paths.length; j++) {
      if (i === j) continue;
      const b = ends[j];
      if (!b) continue;
      const distance = a.end.position.distanceTo(b.start.position);
      if (isPathLink(a.end.position, a.end.tangent, b.start.position, b.start.tangent, tol)) {
        links.push({ from: paths[i].id, to: paths[j].id, distance, angleDeg: tangentAngleDeg(a.end.tangent, b.start.tangent) });
      } else if (distance > tol.distM && distance <= PATH_END_NEAR_MISS_M) {
        nearMisses.push({ from: paths[i].id, to: paths[j].id, distance });
      }
    }
  }
  return { links, nearMisses };
}

/** Deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A dense random network: ends on a coarse lattice (incl. negative
 * coordinates) with millimetre jitter, so links, near misses, branches,
 * merges and misses all occur in quantity.
 */
function randomNetwork(n: number, seed: number): RVPath[] {
  const r = rng(seed);
  const side = Math.max(3, Math.round(Math.sqrt(n / 3)));
  const jitter = (): number => (r() < 0.5 ? 0 : (r() - 0.5) * 0.05);
  const lattice = (): number => Math.floor(r() * side) - Math.floor(side / 2);
  const paths: RVPath[] = [];
  for (let k = 0; k < n; k++) {
    const x = lattice(), z = lattice();
    const axis = r() < 0.5;
    const sign = r() < 0.5 ? 1 : -1;
    const from: V3 = [x + jitter(), r() < 0.1 ? 0.01 : 0, z + jitter()];
    const to: V3 = axis ? [x + sign + jitter(), 0, z + jitter()] : [x + jitter(), 0, z + sign + jitter()];
    paths.push(line(`P${String(k).padStart(4, '0')}`, from, to));
  }
  return paths;
}

const key = (a: PathEndAnalysis): unknown => ({
  links: a.links.map((l) => [l.from, l.to, l.distance, l.angleDeg]),
  nearMisses: a.nearMisses.map((n) => [n.from, n.to, n.distance]),
});

describe('analysePathEnds over the grid === the O(P²) reference', () => {
  for (const [n, seed] of [[50, 1], [50, 7], [500, 42], [500, 2026]] as const) {
    it(`random network: ${n} paths, seed ${seed}`, () => {
      const paths = randomNetwork(n, seed);
      const ref = referenceAnalyse(paths);
      // The fixture must exercise both findings, otherwise equality proves little.
      expect(ref.links.length).toBeGreaterThan(0);
      expect(ref.nearMisses.length).toBeGreaterThan(0);
      expect(key(analysePathEnds(paths))).toEqual(key(ref));
    });
  }

  it('free tolerances (wider, narrower, steeper) on the same network', () => {
    const paths = randomNetwork(200, 11);
    for (const tol of [
      { distM: 0.1, tangentDeg: 2 },
      { distM: 0.5, tangentDeg: 10 },
      { distM: 0.001, tangentDeg: 1 },
      { distM: 0.02, tangentDeg: 45 },
    ]) {
      expect(key(analysePathEnds(paths, tol)), JSON.stringify(tol)).toEqual(key(referenceAnalyse(paths, tol)));
    }
  });

  it('ties: two starts at the same distance are both reported, in id order', () => {
    const a = line('A', [0, 0, 0], [1, 0, 0]);
    const b = line('B', [1.002, 0, 0], [2, 0, 0]);
    const c = line('C', [0.998, 0, 0], [0, 0, 0.001]); // same distance, other tangent
    const d = line('D', [1, 0, 0.002], [2, 0, 0.002]);
    const paths = [d, c, b, a];
    expect(key(analysePathEnds(paths))).toEqual(key(referenceAnalyse(paths)));
  });

  it('negative coordinates exactly on cell boundaries', () => {
    const cell = 0.03; // the default search radius = the grid cell
    const paths: RVPath[] = [];
    for (let k = -5; k <= 5; k++) {
      const x = k * cell;
      paths.push(line(`E${k + 10}`, [x - 1, 0, -cell], [x, 0, -cell]));
      paths.push(line(`S${k + 10}`, [x + 0.004, 0, -cell], [x + 1, 0, -cell]));
      paths.push(line(`N${k + 10}`, [x - cell, 0, -2 * cell], [x - cell + 1, 0, -2 * cell]));
    }
    const ref = referenceAnalyse(paths);
    expect(ref.links.length).toBeGreaterThan(0);
    expect(key(analysePathEnds(paths))).toEqual(key(ref));
  });

  it('equal XZ, different Y: the 3D distance decides, as before', () => {
    const a = line('A', [0, 0, 0], [1, 0, 0]);
    const b = line('B', [1, 0.004, 0], [2, 0.004, 0]); // link (4 mm up)
    const c = line('C', [1, 0.02, 0], [2, 0.02, 0]);   // near miss (20 mm up)
    const d = line('D', [1, 0.5, 0], [2, 0.5, 0]);     // nothing (same XZ, far in Y)
    const paths = [a, b, c, d];
    const ref = referenceAnalyse(paths);
    expect(ref.links.map((l) => l.to)).toEqual(['B']);
    expect(ref.nearMisses.map((n) => n.to)).toEqual(['C']);
    expect(key(analysePathEnds(paths))).toEqual(key(ref));
  });

  it('SOL R2 #2: distM 0.1 at 0.1 + 0.5e-9 is a link; a default near miss at 20 mm is found', () => {
    const tol = { distM: 0.1, tangentDeg: 2 };
    const a = line('A', [0, 0, 0], [1, 0, 0]);
    const b = line('B', [1 + 0.1 + 0.5e-9, 0, 0], [2, 0, 0]);
    const wide = analysePathEnds([a, b], tol);
    expect(wide.links.map((l) => `${l.from}>${l.to}`)).toEqual(['A>B']);
    expect(key(wide)).toEqual(key(referenceAnalyse([a, b], tol)));

    const c = line('C', [1.02, 0, 0], [2, 0, 0]);
    const near = analysePathEnds([a, c]);
    expect(near.links).toEqual([]);
    expect(near.nearMisses.map((n) => `${n.from}>${n.to}`)).toEqual(['A>C']);
    expect(near.nearMisses[0].distance).toBeCloseTo(0.02, 9);
  });

  it('closed and degenerate paths are skipped exactly like before', () => {
    const paths = randomNetwork(40, 5);
    const closed = parsePathExtras({
      type: 'Path', id: 'Z', closed: true,
      segments: [{ kind: 'line', from: [0, 0, 0], to: [1, 0, 0] }, { kind: 'line', from: [1, 0, 0], to: [0, 0, 0] }],
    }, 'Z');
    if (closed) paths.push(closed);
    expect(key(analysePathEnds(paths))).toEqual(key(referenceAnalyse(paths)));
  });
});

describe('analysePathEnd — the findings of one end', () => {
  it('equals the subset of analysePathEnds for every end, in order', () => {
    const paths = randomNetwork(120, 99);
    const all = analysePathEnds(paths);
    for (const p of paths) {
      for (const end of ['start', 'end'] as const) {
        const mine = (l: { from: string; to: string }): boolean => (end === 'end' ? l.from === p.id : l.to === p.id);
        const got = analysePathEnd(paths, p.id, end);
        expect(got.filter((f) => f.kind === 'link').map((f) => [f.from, f.to, f.distance]),
          `${p.id}.${end} links`).toEqual(all.links.filter(mine).map((l) => [l.from, l.to, l.distance]));
        expect(got.filter((f) => f.kind === 'near-miss').map((f) => [f.from, f.to, f.distance]),
          `${p.id}.${end} near misses`).toEqual(all.nearMisses.filter(mine).map((n) => [n.from, n.to, n.distance]));
      }
    }
  });

  it('an unknown path id gives no findings', () => {
    expect(analysePathEnd(randomNetwork(10, 3), 'nope', 'end')).toEqual([]);
  });
});
