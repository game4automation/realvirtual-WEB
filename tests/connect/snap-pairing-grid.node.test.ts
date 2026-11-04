// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * snap-pairing-grid.node.test.ts — plan-644 § 9.4.
 *
 * `computeProximityPairings` finds its candidates through a `SpatialGridXZ`
 * since plan-644 Phase 2.5. The greedy result must be IDENTICAL to the former
 * O(n²) scan (kept here as the reference): same pairs in the same order on
 * seed-fixed data, ties ("first candidate wins"), negative coordinates on cell
 * boundaries, equal XZ with different Y, free tolerances, and `epsilon <= 0`.
 */

import { describe, it, expect } from 'vitest';
import {
  computeProximityPairings,
  type RebuildSnapInput,
  type RebuiltPair,
} from '../../src/core/connect/snap-pairing';
import { flowsCompatible, type SnapFlow } from '../../src/core/connect/snap-name-parser';

/** The pre-plan-644 O(n²) greedy scan, verbatim — the reference. */
function referencePairings(snaps: readonly RebuildSnapInput[], epsilon: number): RebuiltPair[] {
  const eps2 = epsilon * epsilon;
  const claimed = new Set<string>();
  const pairs: RebuiltPair[] = [];
  for (let i = 0; i < snaps.length; i++) {
    const a = snaps[i];
    if (claimed.has(a.id)) continue;
    let best: RebuildSnapInput | null = null;
    let bestD2 = Infinity;
    for (let j = i + 1; j < snaps.length; j++) {
      const b = snaps[j];
      if (claimed.has(b.id)) continue;
      if (b.owner === a.owner) continue;
      if (b.typeId !== a.typeId) continue;
      if (!flowsCompatible(a.flow, b.flow)) continue;
      const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 <= eps2 && d2 < bestD2) { bestD2 = d2; best = b; }
    }
    if (best) {
      claimed.add(a.id);
      claimed.add(best.id);
      pairs.push({ aId: a.id, bId: best.id });
    }
  }
  return pairs;
}

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

const FLOWS: (SnapFlow | undefined)[] = ['in', 'out', 'bidi', undefined];

/** Snaps clustered on a coarse lattice (negative coordinates included) with sub-epsilon jitter. */
function randomSnaps(n: number, seed: number, eps: number): RebuildSnapInput[] {
  const r = rng(seed);
  const side = Math.max(3, Math.round(Math.sqrt(n / 4)));
  const owners = Array.from({ length: Math.max(2, Math.floor(n / 3)) }, (_, k) => ({ k }));
  const out: RebuildSnapInput[] = [];
  for (let i = 0; i < n; i++) {
    const cx = Math.floor(r() * side) - Math.floor(side / 2);
    const cz = Math.floor(r() * side) - Math.floor(side / 2);
    const j = (): number => (r() < 0.3 ? 0 : (r() - 0.5) * eps * 2.5);
    out.push({
      id: `s${i}`,
      typeId: r() < 0.8 ? 'Conv' : 'Pallet',
      flow: FLOWS[Math.floor(r() * FLOWS.length)],
      owner: owners[Math.floor(r() * owners.length)],
      x: cx + j(),
      y: r() < 0.1 ? eps * 0.5 : 0,
      z: cz + j(),
    });
  }
  return out;
}

describe('computeProximityPairings over the grid === the O(n²) reference', () => {
  for (const [n, seed, eps] of [[60, 1, 0.03], [600, 42, 0.03], [600, 7, 0.005], [300, 2026, 0.2]] as const) {
    it(`random snaps: ${n}, seed ${seed}, epsilon ${eps}`, () => {
      const snaps = randomSnaps(n, seed, eps);
      const ref = referencePairings(snaps, eps);
      expect(ref.length).toBeGreaterThan(0);
      expect(computeProximityPairings(snaps, eps)).toEqual(ref);
    });
  }

  it('tie: the FIRST candidate in input order wins', () => {
    const o1 = {}, o2 = {}, o3 = {};
    const snaps: RebuildSnapInput[] = [
      { id: 'a', typeId: 'T', flow: 'out', owner: o1, x: 0, y: 0, z: 0 },
      { id: 'b', typeId: 'T', flow: 'in', owner: o2, x: 0.01, y: 0, z: 0 },
      { id: 'c', typeId: 'T', flow: 'in', owner: o3, x: -0.01, y: 0, z: 0 },
      { id: 'd', typeId: 'T', flow: 'in', owner: o3, x: 0, y: 0, z: 0.01 },
    ];
    const got = computeProximityPairings(snaps, 0.03);
    expect(got).toEqual([{ aId: 'a', bId: 'b' }]);
    expect(got).toEqual(referencePairings(snaps, 0.03));
  });

  it('negative coordinates exactly on cell boundaries', () => {
    const eps = 0.03;
    const snaps: RebuildSnapInput[] = [];
    for (let k = -6; k <= 6; k++) {
      const x = k * eps;
      snaps.push({ id: `o${k}`, typeId: 'T', flow: 'out', owner: { k, s: 'o' }, x, y: 0, z: -eps });
      snaps.push({ id: `i${k}`, typeId: 'T', flow: 'in', owner: { k, s: 'i' }, x: x + eps, y: 0, z: -eps });
      snaps.push({ id: `j${k}`, typeId: 'T', flow: 'in', owner: { k, s: 'j' }, x: x - eps * 0.999, y: 0, z: -2 * eps });
    }
    const ref = referencePairings(snaps, eps);
    expect(ref.length).toBeGreaterThan(0);
    expect(computeProximityPairings(snaps, eps)).toEqual(ref);
  });

  it('equal XZ, different Y: only the 3D distance pairs', () => {
    const snaps: RebuildSnapInput[] = [
      { id: 'a', typeId: 'T', flow: 'out', owner: 1, x: 0, y: 0, z: 0 },
      { id: 'far', typeId: 'T', flow: 'in', owner: 2, x: 0, y: 0.5, z: 0 },
      { id: 'near', typeId: 'T', flow: 'in', owner: 3, x: 0, y: 0.02, z: 0 },
    ];
    const got = computeProximityPairings(snaps, 0.03);
    expect(got).toEqual([{ aId: 'a', bId: 'near' }]);
    expect(got).toEqual(referencePairings(snaps, 0.03));
  });

  it('exact epsilon bound is inclusive, as before', () => {
    const snaps: RebuildSnapInput[] = [
      { id: 'a', typeId: 'T', owner: 1, x: 0.1, y: 0, z: -0.2 },
      { id: 'b', typeId: 'T', owner: 2, x: 0.1 + 0.03, y: 0, z: -0.2 },
    ];
    expect(computeProximityPairings(snaps, 0.03)).toEqual(referencePairings(snaps, 0.03));
  });

  it('epsilon = 0 (and negative) gives exactly the old result', () => {
    const snaps = randomSnaps(120, 3, 0.03);
    // Two exactly coincident snaps of different owners pair with epsilon 0.
    snaps.push({ id: 'z1', typeId: 'T', flow: 'out', owner: 'A', x: 5, y: 0, z: 5 });
    snaps.push({ id: 'z2', typeId: 'T', flow: 'in', owner: 'B', x: 5, y: 0, z: 5 });
    for (const eps of [0, -0.01]) {
      const ref = referencePairings(snaps, eps);
      expect(computeProximityPairings(snaps, eps), `eps ${eps}`).toEqual(ref);
    }
    expect(computeProximityPairings(snaps, 0)).toContainEqual({ aId: 'z1', bId: 'z2' });
  });

  it('far coordinates beyond the grid range fall back and still match', () => {
    const snaps: RebuildSnapInput[] = [
      { id: 'a', typeId: 'T', owner: 1, x: 1e6, y: 0, z: 0 },
      { id: 'b', typeId: 'T', owner: 2, x: 1e6 + 0.01, y: 0, z: 0 },
    ];
    expect(computeProximityPairings(snaps, 0.03)).toEqual(referencePairings(snaps, 0.03));
  });
});
