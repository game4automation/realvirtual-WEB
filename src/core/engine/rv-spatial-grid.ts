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
  /** `aabb.max.y` as of the last (re)indexing — the change detector that keeps
   *  the per-cell `maxTopY` metadata honest for surfaces that only move in Y
   *  (a lift, a raised chain) and therefore never change their cell span
   *  (plan-469 §2.4 / SOL R1#1). */
  maxY: number;
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

  // ── plan-469 metadata (spike) ────────────────────────────────────
  /** Cell key -> tick at which the cell's CONTENT last changed (insert, update
   *  that moved the item, remove, rebuild/clear). Read by the plan-469 cell-union
   *  cache to decide whether a cached stage-1 union is still exact. Cells that
   *  never changed report `-1`, which is below every real tick stamp. */
  private readonly _cellChangeTick = new Map<number, number>();
  /** Cell key -> max `aabb.max.y` over the cell's entries, or `NaN` when the
   *  cached value is stale and must be recomputed from the bucket on read.
   *  Only meaningful for the SURFACE grid; the MU grid simply never asks. */
  private readonly _cellMaxTopY = new Map<number, number>();
  /** Tick stamp written into `_cellChangeTick` by the next mutation. The owner
   *  (RVTransportManager) advances it once per fixed step. */
  currentTick = 0;
  /** Tick of the last `clear()`/`rebuild()`. `clear()` drops the per-cell change
   *  stamps together with the cells, so cells that ended up EMPTY would report
   *  "never changed" afterwards; the epoch is folded into every
   *  `maxCellChangeTick()` so a wholesale rebuild invalidates every cache. */
  private _epochTick = -1;

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
      maxY: aabb.max.y,
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
  update(item: T): boolean {
    const entry = this._entries.get(item);
    if (!entry) {
      this.insert(item);
      return true;
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
      // Same cell span — nothing to move. A pure Y change still has to refresh
      // the per-cell `maxTopY` metadata (plan-469): a lift raising a chain never
      // changes its XZ footprint, but it does change which surface is "on top".
      if (aabb.max.y !== entry.maxY) this._noteMaxYChanged(entry, aabb.max.y);
      return false;
    }
    this._removeFromCells(entry);
    entry.cellMinX = minX;
    entry.cellMinZ = minZ;
    entry.cellMaxX = maxX;
    entry.cellMaxZ = maxZ;
    entry.maxY = aabb.max.y;
    this._addToCells(entry);
    this._warnLargeSpan(entry);
    return true;
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
    this._cellChangeTick.clear();
    this._cellMaxTopY.clear();
    this._epochTick = this.currentTick;
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

  // ─── plan-469 spike: cell metadata + stage-1 union ──────────────────

  /**
   * Stage 1 of {@link queryXZ} alone: the deduplicated, seq-sorted UNION of the
   * entries of every cell the query AABB's span touches — WITHOUT the exact
   * per-item AABB test and without any caller filter.
   *
   * This is the only part of a query that is a pure function of (cell span,
   * cell content), and therefore the only part the plan-469 cell-union cache may
   * keep across ticks (SOL R2#1: stage 2 depends on the exact query AABB, which
   * moves inside an unchanged span). Callers MUST re-run the exact overlap test
   * and every exclusion on the returned union on every single call.
   */
  queryCellUnion(aabb: AABB, out: T[]): number {
    out.length = 0;
    if (this._entries.size === 0) return 0;
    const minX = this._cellCoord(aabb.min.x);
    const minZ = this._cellCoord(aabb.min.z);
    const maxX = this._cellCoord(aabb.max.x);
    const maxZ = this._cellCoord(aabb.max.z);
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
          if (entry.lastQueryId === queryId) continue;
          entry.lastQueryId = queryId;
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
    scratch.length = 0;
    return count;
  }

  /**
   * Collision-free packing of the cell span of `aabb` into ONE safe integer.
   *
   * Layout (52 bits, inside Number's 2^53 exact range):
   * `((minX + CELL_RANGE) * 2^18 + (minZ + CELL_RANGE)) * 2^16 + dx * 2^8 + dz`
   * with `dx = maxX - minX`, `dz = maxZ - minZ`.
   *
   * `minX`/`minZ` are already clamped to +-(CELL_RANGE-1) by `_cellCoord`, so the
   * biased values fit 18 bits exactly. The two extents get 8 bits each; a span
   * wider than 255 cells is FOLDED to 255 and therefore only ever produces a
   * FALSE EQUALITY between two >=255-cell spans sharing a corner — such spans
   * already trip the `LARGE_SPAN_WARN_CELLS` diagnostic (a 255-cell run is a
   * 255 m belt on the 1 m MU grid) and never occur in a transport scene.
   *
   * (Deviation from the plan's "4x16-bit" sketch, which is NOT collision-free
   * over the documented +-131071 cell range: 4x16 = 64 bits > 53.)
   */
  spanKey(aabb: AABB): number {
    const minX = this._cellCoord(aabb.min.x);
    const minZ = this._cellCoord(aabb.min.z);
    let dx = this._cellCoord(aabb.max.x) - minX;
    let dz = this._cellCoord(aabb.max.z) - minZ;
    if (dx > 255) dx = 255;
    if (dz > 255) dz = 255;
    const bx = minX + CELL_RANGE;
    const bz = minZ + CELL_RANGE;
    return (bx * 0x40000 + bz) * 0x10000 + dx * 0x100 + dz;
  }

  /** Tick at which the given cell's content last changed (`-1` if never). */
  cellLastChangeTick(cx: number, cz: number): number {
    const t = this._cellChangeTick.get(cx * KEY_STRIDE + CELL_RANGE + cz);
    return t === undefined ? -1 : t;
  }

  /** Highest `cellLastChangeTick` over every cell of `aabb`'s span (`-1` when
   *  none of them ever changed). The cell-union cache is valid exactly while
   *  this is BELOW the tick the cache was stamped at. */
  maxCellChangeTick(aabb: AABB): number {
    const minX = this._cellCoord(aabb.min.x);
    const minZ = this._cellCoord(aabb.min.z);
    const maxX = this._cellCoord(aabb.max.x);
    const maxZ = this._cellCoord(aabb.max.z);
    let latest = this._epochTick;
    for (let cx = minX; cx <= maxX; cx++) {
      const rowKey = cx * KEY_STRIDE + CELL_RANGE;
      for (let cz = minZ; cz <= maxZ; cz++) {
        const t = this._cellChangeTick.get(rowKey + cz);
        if (t !== undefined && t > latest) latest = t;
      }
    }
    return latest;
  }

  /** Max `aabb.max.y` over the entries of one cell (`-Infinity` when empty).
   *  Lazily recomputed when a removal invalidated the cached value. */
  cellMaxTopY(cx: number, cz: number): number {
    return this._cellMaxTopYByKey(cx * KEY_STRIDE + CELL_RANGE + cz);
  }

  /** Max `aabb.max.y` over every cell touched by `aabb`'s span
   *  (`-Infinity` when the span is empty) — the fast-path's `topYUpper`. */
  maxTopYOverSpan(aabb: AABB): number {
    const minX = this._cellCoord(aabb.min.x);
    const minZ = this._cellCoord(aabb.min.z);
    const maxX = this._cellCoord(aabb.max.x);
    const maxZ = this._cellCoord(aabb.max.z);
    let top = -Infinity;
    for (let cx = minX; cx <= maxX; cx++) {
      const rowKey = cx * KEY_STRIDE + CELL_RANGE;
      for (let cz = minZ; cz <= maxZ; cz++) {
        const t = this._cellMaxTopYByKey(rowKey + cz);
        if (t > top) top = t;
      }
    }
    return top;
  }

  private _cellMaxTopYByKey(key: number): number {
    const cached = this._cellMaxTopY.get(key);
    if (cached !== undefined && !Number.isNaN(cached)) return cached;
    const bucket = this._cells.get(key);
    if (!bucket || bucket.length === 0) return -Infinity;
    let top = -Infinity;
    for (let i = 0; i < bucket.length; i++) {
      if (bucket[i].maxY > top) top = bucket[i].maxY;
    }
    this._cellMaxTopY.set(key, top);
    return top;
  }

  /** A pure Y move (unchanged cell span): refresh the metadata of every cell the
   *  entry occupies and stamp them as changed. */
  private _noteMaxYChanged(entry: GridEntry<T>, newMaxY: number): void {
    const rising = newMaxY > entry.maxY;
    entry.maxY = newMaxY;
    for (let cx = entry.cellMinX; cx <= entry.cellMaxX; cx++) {
      const rowKey = cx * KEY_STRIDE + CELL_RANGE;
      for (let cz = entry.cellMinZ; cz <= entry.cellMaxZ; cz++) {
        const key = rowKey + cz;
        this._cellChangeTick.set(key, this.currentTick);
        if (rising) {
          const top = this._cellMaxTopY.get(key);
          if (top === undefined || newMaxY > top) this._cellMaxTopY.set(key, newMaxY);
        } else {
          // The entry may have BEEN the maximum -> recompute lazily on read.
          this._cellMaxTopY.set(key, NaN);
        }
      }
    }
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
        this._cellChangeTick.set(key, this.currentTick);
        const top = this._cellMaxTopY.get(key);
        // undefined (fresh cell) or a smaller max -> this entry defines it;
        // a NaN sentinel stays NaN (recomputed lazily on read).
        if (top === undefined || entry.maxY > top) this._cellMaxTopY.set(key, entry.maxY);
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
        this._cellChangeTick.set(key, this.currentTick);
        if (bucket.length === 0) {
          this._cells.delete(key);
          this._cellMaxTopY.delete(key);
          this._arrayPool.push(bucket);
        } else if (idx >= 0) {
          // The removed entry may have been the maximum — invalidate.
          this._cellMaxTopY.set(key, NaN);
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
