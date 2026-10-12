// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-bake-timings.ts — Ring of per-bake phase timings (plan-753 Phase 0).
 *
 * The third measurement ring next to the decode ring (`getDecodeTimings`,
 * layout-planner/model-cache.ts) and the placement ring
 * (`getPlacementTimings`, layout-planner/scene-mutations.ts). One record per
 * `bake()` run of one asset: how long the role scan, the chunk split, the
 * geometry staging and the BVH build took, plus what came out. Read via the
 * `web_layout_timings` MCP tool, emptied by its `clear` flag.
 *
 * Phase 0 ships the API only; Phase 2's `bake()` records into it.
 */

/** Bake phases in pipeline order (plan-753 §2.4). */
export type BakePhase = 'roles' | 'split' | 'stage' | 'pick' | 'template';

export interface BakeTiming {
  /** Cache key of the baked asset (same fallback chain as the decode ring). */
  assetId: string;
  /** Per-phase durations in ms, pipeline order. */
  phases: Array<{ phase: BakePhase; ms: number }>;
  /** Wall time of the whole bake in ms (roles → template ready; the `pick`
   *  phase is inside it — plan-756 gates the bake on the pick structures). */
  totalMs: number;
  /** Chunks the bake produced (empty chunks are dropped before counting). */
  chunks: number;
  /** Vertices staged into chunk geometries. */
  vertices: number;
  /** Triangles staged into chunk geometries. */
  triangles: number;
}

const BAKE_TIMING_CAP = 64;
const _bakeTimings: BakeTiming[] = [];

/** The recorded bake timings, oldest first. Treat as read-only. */
export function getBakeTimings(): readonly BakeTiming[] {
  return _bakeTimings;
}

/** Empty the ring (the `clear` flag of `web_layout_timings`). */
export function clearBakeTimings(): void {
  _bakeTimings.length = 0;
}

/** Append one finished bake record; the ring keeps the newest 64. */
export function recordBakeTiming(record: BakeTiming): void {
  _bakeTimings.push(record);
  if (_bakeTimings.length > BAKE_TIMING_CAP) _bakeTimings.shift();
}

/**
 * Phase profiler for one bake — `mark(phase)` stamps the time since the
 * previous mark, `finish(stats)` records the row. Same shape as the decode
 * ring's inline `mark` so the two rings read alike in the tool output.
 */
export function beginBakeTiming(assetId: string): {
  mark(phase: BakePhase): void;
  finish(stats: { chunks: number; vertices: number; triangles: number }): BakeTiming;
} {
  const t0 = performance.now();
  let tLast = t0;
  const record: BakeTiming = { assetId, phases: [], totalMs: 0, chunks: 0, vertices: 0, triangles: 0 };
  return {
    mark(phase: BakePhase): void {
      const now = performance.now();
      record.phases.push({ phase, ms: now - tLast });
      tLast = now;
    },
    finish(stats): BakeTiming {
      record.totalMs = performance.now() - t0;
      record.chunks = stats.chunks;
      record.vertices = stats.vertices;
      record.triangles = stats.triangles;
      recordBakeTiming(record);
      return record;
    },
  };
}
