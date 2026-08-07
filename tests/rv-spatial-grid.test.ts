// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * SpatialGridXZ unit tests (plan-240 §9.1).
 *
 * Correctness is checked against a brute-force overlap reference with seeded
 * random AABBs (deterministic LCG — reproducible failures), plus targeted
 * cases for seq ordering/dedup, incremental cell moves, multi-cell jumps,
 * long AABBs, empty grids, buffer reuse and rebuild parity.
 */
import { describe, it, expect } from 'vitest';
import { SpatialGridXZ } from '../src/core/engine/rv-spatial-grid';
import { AABB } from '../src/core/engine/rv-aabb';

// ─── Helpers ──────────────────────────────────────────────────────

/** Deterministic LCG (numerical recipes constants) — NO unseeded Math.random. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

interface GridItem {
  readonly aabb: AABB;
  readonly id: number;
}

function setBounds(aabb: AABB, minX: number, minZ: number, maxX: number, maxZ: number): void {
  aabb.min.set(minX, 0, minZ);
  aabb.max.set(maxX, 1, maxZ);
  aabb.center.set((minX + maxX) / 2, 0.5, (minZ + maxZ) / 2);
  aabb.halfSize.set((maxX - minX) / 2, 0.5, (maxZ - minZ) / 2);
}

function makeItem(id: number, minX: number, minZ: number, maxX: number, maxZ: number): GridItem {
  const aabb = new AABB();
  setBounds(aabb, minX, minZ, maxX, maxZ);
  return { aabb, id };
}

function makeQuery(minX: number, minZ: number, maxX: number, maxZ: number): AABB {
  const aabb = new AABB();
  setBounds(aabb, minX, minZ, maxX, maxZ);
  return aabb;
}

/** Brute-force XZ overlap reference (same predicate as AABB.overlapsXZ). */
function bruteForce(items: readonly GridItem[], query: AABB): GridItem[] {
  return items.filter((i) => query.overlapsXZ(i.aabb));
}

// ─── Tests ────────────────────────────────────────────────────────

describe('SpatialGridXZ', () => {
  it('queryXZ returns exactly the brute-force overlap set (randomized)', () => {
    const rand = lcg(42);
    const grid = new SpatialGridXZ<GridItem>(1.0);
    const items: GridItem[] = [];
    for (let i = 0; i < 200; i++) {
      const x = (rand() - 0.5) * 40;
      const z = (rand() - 0.5) * 40;
      const w = 0.05 + rand() * 3;
      const d = 0.05 + rand() * 3;
      const item = makeItem(i, x, z, x + w, z + d);
      items.push(item);
      grid.insert(item);
    }

    const out: GridItem[] = [];
    for (let q = 0; q < 100; q++) {
      const x = (rand() - 0.5) * 44;
      const z = (rand() - 0.5) * 44;
      const w = 0.05 + rand() * 6;
      const d = 0.05 + rand() * 6;
      const query = makeQuery(x, z, x + w, z + d);

      const count = grid.queryXZ(query, out);
      const expected = bruteForce(items, query);

      expect(count).toBe(expected.length);
      expect(new Set(out.map((i) => i.id))).toEqual(new Set(expected.map((i) => i.id)));
    }
  });

  it('queryXZ candidates are seq-ordered and deduplicated across cells', () => {
    const grid = new SpatialGridXZ<GridItem>(1.0);
    // Each item spans MANY cells (4×4 m at 1 m cells) and all overlap each
    // other — every item is reachable from many buckets, so dedup must kick in.
    const items: GridItem[] = [];
    for (let i = 0; i < 10; i++) {
      const item = makeItem(i, -2 + i * 0.1, -2, 2 + i * 0.1, 2);
      items.push(item);
      grid.insert(item);
    }

    const out: GridItem[] = [];
    const count = grid.queryXZ(makeQuery(-3, -3, 3, 3), out);

    expect(count).toBe(10);
    expect(out.length).toBe(10);
    // No duplicates + strictly ascending insertion (seq) order.
    expect(out.map((i) => i.id)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('incremental update moves entries across cell boundaries correctly', () => {
    const grid = new SpatialGridXZ<GridItem>(1.0);
    const item = makeItem(0, 0.3, 0.3, 0.7, 0.7); // fully inside cell (0,0)
    grid.insert(item);

    const out: GridItem[] = [];
    expect(grid.queryXZ(makeQuery(0.4, 0.4, 0.6, 0.6), out)).toBe(1);

    // Slide across the x=1 cell boundary into cell (1,0).
    setBounds(item.aabb, 1.3, 0.3, 1.7, 0.7);
    grid.update(item);

    expect(grid.queryXZ(makeQuery(0.0, 0.0, 0.9, 0.9), out)).toBe(0); // old cell empty
    expect(grid.queryXZ(makeQuery(1.2, 0.2, 1.8, 0.8), out)).toBe(1); // found in new cell
    expect(out[0]).toBe(item);
  });

  it('multi-cell jump in one update lands in correct cells (fast MU case)', () => {
    const grid = new SpatialGridXZ<GridItem>(1.0);
    const item = makeItem(0, 0.2, 0.2, 0.8, 0.8);
    grid.insert(item);

    // Teleport 10 cells away in a single update (fast MU / large dt).
    setBounds(item.aabb, 10.2, 5.2, 10.8, 5.8);
    grid.update(item);

    const out: GridItem[] = [];
    expect(grid.queryXZ(makeQuery(0, 0, 1, 1), out)).toBe(0);       // origin cleared
    expect(grid.queryXZ(makeQuery(5, 2.5, 5.9, 3), out)).toBe(0);   // no stale intermediate cells
    expect(grid.queryXZ(makeQuery(10, 5, 11, 6), out)).toBe(1);     // exact landing cells
    expect(out[0]).toBe(item);
  });

  it('long AABB spanning 20+ cells is found from every overlapped cell', () => {
    const grid = new SpatialGridXZ<GridItem>(1.0);
    // 25 m long belt along X at 1 m cells → 26 cells in X.
    const belt = makeItem(0, 0.0, 0.0, 25.0, 0.5);
    grid.insert(belt);

    const out: GridItem[] = [];
    for (let x = 0; x < 25; x++) {
      const count = grid.queryXZ(makeQuery(x + 0.4, 0.1, x + 0.6, 0.4), out);
      expect(count).toBe(1);
      expect(out[0]).toBe(belt);
    }
    // And a query just beyond either end misses it.
    expect(grid.queryXZ(makeQuery(-1.5, 0.1, -0.5, 0.4), out)).toBe(0);
    expect(grid.queryXZ(makeQuery(25.5, 0.1, 26.5, 0.4), out)).toBe(0);
  });

  it('empty grid query returns 0 without growing internal maps', () => {
    const grid = new SpatialGridXZ<GridItem>(1.0);
    const out: GridItem[] = [];

    expect(grid.queryXZ(makeQuery(-100, -100, 100, 100), out)).toBe(0);
    expect(out.length).toBe(0);
    expect(grid.size).toBe(0);
    // Queries must never materialize cells.
    const cells = (grid as unknown as { _cells: Map<number, unknown> })._cells;
    expect(cells.size).toBe(0);

    // Same holds after items were inserted and removed again.
    const item = makeItem(0, 0, 0, 1, 1);
    grid.insert(item);
    grid.remove(item);
    expect(grid.queryXZ(makeQuery(-100, -100, 100, 100), out)).toBe(0);
    expect(cells.size).toBe(0);
  });

  it('queryXZ does not allocate (reuses out buffer)', () => {
    const grid = new SpatialGridXZ<GridItem>(1.0);
    for (let i = 0; i < 20; i++) grid.insert(makeItem(i, i * 0.4, 0, i * 0.4 + 0.3, 0.3));

    const out: GridItem[] = [];
    const outRef = out;
    const query = makeQuery(-1, -1, 9, 1);

    const c1 = grid.queryXZ(query, out);
    expect(out).toBe(outRef);          // same buffer object — grid never swaps it
    expect(out.length).toBe(c1);       // length reset + refilled, not reallocated

    const c2 = grid.queryXZ(query, out);
    expect(out).toBe(outRef);
    expect(c2).toBe(c1);
    // Internal scratch must not leak entries between queries.
    const scratch = (grid as unknown as { _queryScratch: unknown[] })._queryScratch;
    expect(scratch.length).toBe(0);
  });

  it('rebuild after bulk removal matches fresh grid', () => {
    const rand = lcg(1234);
    const makeItems = (): GridItem[] => {
      const r = lcg(777); // independent, fixed stream for the geometry
      const items: GridItem[] = [];
      for (let i = 0; i < 120; i++) {
        const x = (r() - 0.5) * 30;
        const z = (r() - 0.5) * 30;
        items.push(makeItem(i, x, z, x + 0.2 + r() * 2, z + 0.2 + r() * 2));
      }
      return items;
    };

    const items = makeItems();
    const used = new SpatialGridXZ<GridItem>(1.0);
    for (const item of items) used.insert(item);
    // Bulk-remove more than half, then rebuild with the survivors.
    const survivors = items.filter((_, i) => i % 3 === 0);
    for (const item of items) { if (!survivors.includes(item)) used.remove(item); }
    used.rebuild(survivors);

    const fresh = new SpatialGridXZ<GridItem>(1.0);
    fresh.rebuild(survivors);

    expect(used.size).toBe(fresh.size);
    const outA: GridItem[] = [];
    const outB: GridItem[] = [];
    for (let q = 0; q < 50; q++) {
      const x = (rand() - 0.5) * 34;
      const z = (rand() - 0.5) * 34;
      const query = makeQuery(x, z, x + rand() * 5, z + rand() * 5);
      const ca = used.queryXZ(query, outA);
      const cb = fresh.queryXZ(query, outB);
      expect(ca).toBe(cb);
      // Identical ORDER too — rebuild reassigns seq in items order on both.
      expect(outA.map((i) => i.id)).toEqual(outB.map((i) => i.id));
    }
  });
});
