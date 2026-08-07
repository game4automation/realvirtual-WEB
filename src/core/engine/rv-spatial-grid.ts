// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import type { AABB } from './rv-aabb';

/**
 * Internal per-item bookkeeping. Entries are keyed by OBJECT IDENTITY
 * (`Map<T, GridEntry<T>>`) — never by array index, because the transport
 * manager's swap-and-pop removal makes indices unstable.
 */
interface GridEntry<T> {
  /** The indexed item itself (cells store entries, so queries need no Map lookups). */
  item: T;
  /** The item's AABB — an existing, externally-mutated instance; the grid only reads it. */
  aabb: AABB;
  /** Currently occupied cell span (inclusive), for incremental updates + removal. */
  cellMinX: number;
  cellMinZ: number;
  cellMaxX: number;
  cellMaxZ: number;
  /** Stable insertion ordinal — monotonically assigned at insert. Query results are
   *  sorted by this so first-hit scans (sensor occupancy) stay deterministic even
   *  though items live in unordered cell buckets (F1). */
  seq: number;
  /** Tick stamp of the last query that already emitted this entry — allocation-free
   *  deduplication for items spanning multiple cells (no Set per query). */
  lastQueryId: number;
}

/** Cell coordinates are clamped to ±(CELL_RANGE-1); beyond that the packed key
 *  scheme would collide. With a 1 m cell size that is a ±131 km world — any
 *  breach indicates corrupt AABB data, reported via console.error (debug assert). */
const CELL_RANGE = 0x20000; // 131072 cells in each direction
/** Stride for the packed cell key: `key = cx * 0x40000 + (cz + CELL_RANGE)`.
 *  With cz + CELL_RANGE ∈ [0, 0x40000) the mapping is injective for any integer
 *  cx; |key| stays < 2^36, far inside Number's 2^53 safe-integer range.
 *  (A `(cx << 16) | cz` scheme would overflow/collide at small cell sizes.) */
const KEY_STRIDE = 0x40000;

/** A surface occupying more than this many cells triggers a one-time debug
 *  warning — a hint to pick a larger cell size for that grid (long-AABB
 *  degeneration, see plan-240 §5.2). */
const LARGE_SPAN_WARN_CELLS = 32;

/**
 * SpatialGridXZ — allocation-free uniform grid over the world XZ plane.
 *
 * Broad-phase index for the transport hot path (sensors/sinks vs. MUs, MU vs.
 * surfaces). Y is ignored on purpose: transport overlap semantics are XZ-based
 * (`AABB.overlapsXZ`), and conveyor layouts are essentially planar.
 *
 * Design points (plan-240 §2.3):
 * - Entries are keyed by object identity; `seq` gives a stable, deterministic
 *   candidate order independent of the caller's (swap-and-pop-mutated) arrays.
 * - Cell buckets are pooled arrays (`.length = 0` reset) — no per-tick GC.
 * - `update()` is a no-op while the item's cell span is unchanged and performs a
 *   LAZY INSERT for unknown items — this is the self-healing hook that absorbs
 *   external `mus.push(...)` mutations (multiuser followers, tests) without
 *   explicit registration (plan-240 §2.6).
 * - The new cell span is always computed from the item's CURRENT AABB, so an
 *   item jumping across multiple cells in one tick lands correctly.
 * - `queryXZ()` writes deduplicated, seq-sorted candidates into a caller-owned
 *   scratch buffer and returns the count — zero allocation per query.
 *
 * `T` must expose its (externally updated) `aabb`; both MU flavours and
 * `RVTransportSurface` do.
 */
export class SpatialGridXZ<T extends { readonly aabb: AABB }> {
  /** Cell key → entries whose AABB overlaps that cell. Arrays are pooled. */
  private readonly _cells = new Map<number, GridEntry<T>[]>();
  /** Item → entry (object identity — indices are never used as keys). */
  private readonly _entries = new Map<T, GridEntry<T>>();
  /** Pool of empty cell arrays, recycled when cells drain. */
  private readonly _arrayPool: GridEntry<T>[][] = [];
  /** Reused scratch holding the entries of the current query (sorted by seq). */
  private readonly _queryScratch: GridEntry<T>[] = [];

  /** Monotonic insertion ordinal. Reset only by `clear()`/`rebuild()` — a
   *  rebuild reassigns seq in the order of the supplied items array (documented
   *  behaviour: rebuild = fresh deterministic ordering, not seq preservation). */
  private _seqCounter = 0;
  /** Monotonic query stamp for allocation-free dedup. */
  private _queryId = 0;
  /** One-time long-span warning latch (per grid instance). */
  private _largeSpanWarned = false;

  private readonly _cellSize: number;
  private readonly _invCellSize: number;

  /** @param cellSize Cell edge length in metres — pick ~1–2× the typical item
   *  footprint (MU grid ≈ 1 m; surface grid larger, e.g. 4 m, so long belts
   *  span few cells). */
  constructor(cellSize: number) {
    if (!(cellSize > 0)) throw new Error(`SpatialGridXZ: cellSize must be > 0 (got ${cellSize})`);
    this._cellSize = cellSize;
    this._invCellSize = 1 / cellSize;
  }

  /** Number of indexed items (test/introspection helper). */
  get size(): number {
    return this._entries.size;
  }

  /** True when `item` is currently indexed (test/introspection helper). */
  has(item: T): boolean {
    return this._entries.has(item);
  }

  /** Index `item` under its current AABB and assign the next seq ordinal.
   *  No-op when the item is already indexed (use `update()` to move it). */
  insert(item: T): void {
    if (this._entries.has(item)) return;
    const aabb = item.aabb;
    const entry: GridEntry<T> = {
      item,
      aabb,
      cellMinX: this._cellCoord(aabb.min.x),
      cellMinZ: this._cellCoord(aabb.min.z),
      cellMaxX: this._cellCoord(aabb.max.x),
      cellMaxZ: this._cellCoord(aabb.max.z),
      seq: this._seqCounter++,
      lastQueryId: -1,
    };
    this._entries.set(item, entry);
    this._addToCells(entry);
    this._warnLargeSpan(entry);
  }

  /**
   * Re-index `item` after its AABB changed. No-op while the covered cell span
   * is unchanged (the common case for coherent motion). Unknown items are
   * lazily inserted (self-healing against external array pushes). The new span
   * is always derived from the CURRENT AABB, so multi-cell jumps are exact.
   */
  update(item: T): void {
    const entry = this._entries.get(item);
    if (!entry) {
      this.insert(item);
      return;
    }
    const aabb = entry.aabb;
    const minX = this._cellCoord(aabb.min.x);
    const minZ = this._cellCoord(aabb.min.z);
    const maxX = this._cellCoord(aabb.max.x);
    const maxZ = this._cellCoord(aabb.max.z);
    if (
      minX === entry.cellMinX && minZ === entry.cellMinZ &&
      maxX === entry.cellMaxX && maxZ === entry.cellMaxZ
    ) {
      return; // same cell span — nothing to move
    }
    this._removeFromCells(entry);
    entry.cellMinX = minX;
    entry.cellMinZ = minZ;
    entry.cellMaxX = maxX;
    entry.cellMaxZ = maxZ;
    this._addToCells(entry);
    this._warnLargeSpan(entry);
  }

  /** Remove `item` from the index (uses the STORED cell span, so removal is
   *  correct even when the AABB has moved since the last update). No-op for
   *  unknown items. */
  remove(item: T): void {
    const entry = this._entries.get(item);
    if (!entry) return;
    this._removeFromCells(entry);
    this._entries.delete(item);
  }

  /** Drop everything and re-index `items` in array order. seq ordinals are
   *  REASSIGNED 0..n-1 following the array order (rebuild defines a fresh
   *  deterministic ordering; previous ordinals are not preserved). */
  rebuild(items: readonly T[]): void {
    this.clear();
    for (const item of items) this.insert(item);
  }

  /** Remove all items and recycle every cell bucket. Resets the seq counter
   *  (the grid is empty, so no ordering constraint survives). */
  clear(): void {
    for (const bucket of this._cells.values()) {
      bucket.length = 0;
      this._arrayPool.push(bucket);
    }
    this._cells.clear();
    this._entries.clear();
    this._seqCounter = 0;
  }

  /**
   * Collect all items whose AABB overlaps `aabb` in XZ (same predicate as
   * `AABB.overlapsXZ`, boundary-inclusive) into `out`. Results are
   * DEDUPLICATED (tick-stamp per entry, no Set) and SORTED ascending by `seq`
   * (insertion sort — candidate sets are small and mostly pre-sorted).
   * Returns the candidate count; `out` is reset via `.length = 0` and reused,
   * never reallocated by the grid.
   *
   * The XZ overlap vs. the QUERY bounds is exact; callers keep any further
   * per-item filtering (3D `overlaps`, ray tests, `markedForRemoval`,
   * `isGripped`, ...) — the grid filters nothing beyond query-bounds overlap.
   */
  queryXZ(aabb: AABB, out: T[]): number {
    out.length = 0;
    if (this._entries.size === 0) return 0;

    const minX = this._cellCoord(aabb.min.x);
    const minZ = this._cellCoord(aabb.min.z);
    const maxX = this._cellCoord(aabb.max.x);
    const maxZ = this._cellCoord(aabb.max.z);
    const qMinX = aabb.min.x;
    const qMaxX = aabb.max.x;
    const qMinZ = aabb.min.z;
    const qMaxZ = aabb.max.z;
    const queryId = ++this._queryId;
    const scratch = this._queryScratch;
    scratch.length = 0;

    for (let cx = minX; cx <= maxX; cx++) {
      const rowKey = cx * KEY_STRIDE + CELL_RANGE;
      for (let cz = minZ; cz <= maxZ; cz++) {
        const bucket = this._cells.get(rowKey + cz);
        if (!bucket) continue;
        for (let i = 0; i < bucket.length; i++) {
          const entry = bucket[i];
          if (entry.lastQueryId === queryId) continue; // already emitted this query
          entry.lastQueryId = queryId; // stamp BEFORE the exact test — a miss here misses in every cell
          const ea = entry.aabb;
          if (ea.min.x > qMaxX || ea.max.x < qMinX || ea.min.z > qMaxZ || ea.max.z < qMinZ) continue;
          // Insertion sort by seq while collecting (small, mostly-sorted sets).
          let j = scratch.length - 1;
          scratch.length = scratch.length + 1;
          while (j >= 0 && scratch[j].seq > entry.seq) {
            scratch[j + 1] = scratch[j];
            j--;
          }
          scratch[j + 1] = entry;
        }
      }
    }

    for (let i = 0; i < scratch.length; i++) out.push(scratch[i].item);
    const count = scratch.length;
    scratch.length = 0; // don't retain entry references between queries
    return count;
  }

  // ─── internals ─────────────────────────────────────────────────────

  /** World coordinate → clamped integer cell coordinate. */
  private _cellCoord(v: number): number {
    const c = Math.floor(v * this._invCellSize);
    if (c >= CELL_RANGE || c < -CELL_RANGE || Number.isNaN(c)) {
      // Debug assertion (plan-240 §2.3): outside the documented ±131071-cell
      // range the packed key would collide. Clamp to keep the grid coherent.
      console.error(`[SpatialGridXZ] cell coordinate ${c} out of range ±${CELL_RANGE - 1} (coord=${v}, cellSize=${this._cellSize}) — clamping`);
      return c >= CELL_RANGE ? CELL_RANGE - 1 : -CELL_RANGE;
    }
    return c;
  }

  private _addToCells(entry: GridEntry<T>): void {
    for (let cx = entry.cellMinX; cx <= entry.cellMaxX; cx++) {
      const rowKey = cx * KEY_STRIDE + CELL_RANGE;
      for (let cz = entry.cellMinZ; cz <= entry.cellMaxZ; cz++) {
        const key = rowKey + cz;
        let bucket = this._cells.get(key);
        if (!bucket) {
          bucket = this._arrayPool.pop() ?? [];
          this._cells.set(key, bucket);
        }
        bucket.push(entry);
      }
    }
  }

  private _removeFromCells(entry: GridEntry<T>): void {
    for (let cx = entry.cellMinX; cx <= entry.cellMaxX; cx++) {
      const rowKey = cx * KEY_STRIDE + CELL_RANGE;
      for (let cz = entry.cellMinZ; cz <= entry.cellMaxZ; cz++) {
        const key = rowKey + cz;
        const bucket = this._cells.get(key);
        if (!bucket) continue;
        const idx = bucket.indexOf(entry);
        if (idx >= 0) {
          // Swap-and-pop (project convention) — bucket order is irrelevant,
          // queries re-sort by seq.
          bucket[idx] = bucket[bucket.length - 1];
          bucket.pop();
        }
        if (bucket.length === 0) {
          this._cells.delete(key);
          this._arrayPool.push(bucket);
        }
      }
    }
  }

  private _warnLargeSpan(entry: GridEntry<T>): void {
    if (this._largeSpanWarned) return;
    const cells = (entry.cellMaxX - entry.cellMinX + 1) * (entry.cellMaxZ - entry.cellMinZ + 1);
    if (cells > LARGE_SPAN_WARN_CELLS) {
      this._largeSpanWarned = true;
      console.warn(`[SpatialGridXZ] an item spans ${cells} cells (cellSize=${this._cellSize} m) — consider a larger cell size for this grid`);
    }
  }
}
