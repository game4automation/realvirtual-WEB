// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Geometry-based snap-pairing reconstruction.
 *
 * Lives in `src/core/connect/` since plan-633 (F2): the connection core owns
 * the snap vocabulary; `src/plugins/snap-point/` re-exports it unchanged.
 *
 * Layout restore replays each placement's saved transform but does NOT recreate
 * the runtime snap-registry connection state (`pairedSnapId` / `occupied`). As a
 * result, chained ("enchained") assemblies lose their snap connections on reload
 * — chain-mode dragging, occupancy, and reverse-direction all stop working even
 * though the objects still look connected.
 *
 * Because two mated snap points are placed *exactly coincident* in world space
 * (both `placeAtSnapPoint` and the magnetic drag controller land one snap onto
 * the other), we can reconstruct every connection purely from geometry: pair any
 * two compatible snaps from different owners whose world positions coincide.
 *
 * This pure function does the matching; its two callers apply the result: the
 * planner to the live `SnapPointRegistry` (snap-point plugin), and the headless
 * connection registry (`rv-connection-registry.ts`, DES without the plugin) to
 * the registry it builds per binding. Unit-tested in
 * `tests/snap-pairing-rebuild.test.ts` (via the plugin re-export) and in
 * `tests/connect/snap-pairing-grid.node.test.ts` (grid vs. O(n²) reference).
 */

import { flowsCompatible, type SnapFlow } from './snap-name-parser';
import type { AABB } from '../engine/rv-aabb';
import { SpatialGridXZ } from '../engine/rv-spatial-grid';

/**
 * World-space distance (m) below which two snaps count as mated when the
 * connection graph is reconstructed from geometry. The planner re-exports it as
 * `SNAP_PAIR_REBUILD_EPS_M` (rationale for 30 mm documented there); the headless
 * connection registry (`rv-connection-registry.ts`) uses the same value.
 */
export const SNAP_PAIR_EPS_M = 0.03;

/** Minimal snap shape the matcher needs (no Three.js dependency). */
export interface RebuildSnapInput {
  /** Registry id (Object3D.uuid). */
  id: string;
  /** Connection type — only equal typeIds may mate. */
  typeId: string;
  /** Flow semantics (in/out/bidi). Undefined is treated as bidi. */
  flow?: SnapFlow;
  /** Identity of the owning placed asset — snaps with the same owner never pair. */
  owner: unknown;
  /** Snap world position. */
  x: number;
  y: number;
  z: number;
}

export interface RebuiltPair {
  aId: string;
  bId: string;
}

/**
 * Pair compatible, coincident snaps from different owners. Greedy nearest-match:
 * each snap is paired at most once, to its closest compatible partner within
 * `epsilon` (world units). Stable: scans in input order; the first snap claims
 * its nearest free partner (a tie keeps the FIRST candidate in input order).
 *
 * Candidates come from a {@link SpatialGridXZ} (plan-644 Phase 2.5): snaps are
 * indexed as points in input order (`seq` = input index) and each snap queries
 * a box of ±`epsilon` around itself; the hits arrive seq-sorted, so only later
 * snaps are visited, in exactly the order of the former O(n²) scan, and the
 * predicates are the unchanged ones. Same pairs, same order. `epsilon <= 0`
 * (valid, but no cell size), non-finite input, or coordinates beyond the grid's
 * cell range keep the O(n²) scan.
 *
 * @param snaps   Candidate snaps (typically every *unoccupied* registry snap).
 * @param epsilon Max world-space distance to consider two snaps mated.
 */
export function computeProximityPairings(
  snaps: readonly RebuildSnapInput[],
  epsilon: number,
): RebuiltPair[] {
  if (!gridApplicable(snaps, epsilon)) return pairQuadratic(snaps, epsilon);
  const eps2 = epsilon * epsilon;
  const claimed = new Set<string>();
  const pairs: RebuiltPair[] = [];

  const grid = new SpatialGridXZ<PointItem>(epsilon);
  for (let i = 0; i < snaps.length; i++) {
    const s = snaps[i];
    grid.insert(pointItem(i, s.x, s.y, s.z, 0)); // seq === i (fresh grid)
  }
  // The query box is padded by a few ULP-scale units: it may only ADD
  // candidates (the exact 3D test below filters them), never lose one at the
  // boundary through rounding of `x ± epsilon`.
  const r = epsilon * (1 + 1e-9) + 1e-12;
  const query = pointItem(-1, 0, 0, 0, r);
  const hits: PointItem[] = [];

  for (let i = 0; i < snaps.length; i++) {
    const a = snaps[i];
    if (claimed.has(a.id)) continue;
    setPointBox(query, a.x, a.y, a.z, r);
    grid.queryXZ(query.aabb, hits);

    let best: RebuildSnapInput | null = null;
    let bestD2 = Infinity;
    for (let k = 0; k < hits.length; k++) {
      const j = hits[k].i;
      if (j <= i) continue; // the O(n²) scan only looked forward
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

/** A snap (or the query) as a point box for the grid; `i` = input index. */
interface PointItem {
  readonly i: number;
  readonly aabb: AABB;
}

interface MutableBox { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } }

/** The grid reads only `aabb.min` / `aabb.max` — a structural box suffices. */
function pointItem(i: number, x: number, y: number, z: number, r: number): PointItem {
  const box: MutableBox = { min: { x: x - r, y: y - r, z: z - r }, max: { x: x + r, y: y + r, z: z + r } };
  return { i, aabb: box as unknown as AABB };
}

function setPointBox(item: PointItem, x: number, y: number, z: number, r: number): void {
  const box = item.aabb as unknown as MutableBox;
  box.min.x = x - r; box.min.y = y - r; box.min.z = z - r;
  box.max.x = x + r; box.max.y = y + r; box.max.z = z + r;
}

/** Max |coordinate| / cell size the grid indexes without clamping (its range is ±131071 cells). */
const GRID_MAX_CELL_COORD = 100_000;

/** The grid path is exact only for a positive finite `epsilon` and finite coordinates within its cell range. */
function gridApplicable(snaps: readonly RebuildSnapInput[], epsilon: number): boolean {
  if (!(epsilon > 0) || !Number.isFinite(epsilon)) return false;
  if (snaps.length < 2) return false;
  const limit = GRID_MAX_CELL_COORD * epsilon;
  for (const s of snaps) {
    if (!(Math.abs(s.x) < limit) || !(Math.abs(s.z) < limit) || !Number.isFinite(s.y)) return false;
  }
  return true;
}

/** The original O(n²) greedy scan (fallback where the grid is not applicable). */
function pairQuadratic(
  snaps: readonly RebuildSnapInput[],
  epsilon: number,
): RebuiltPair[] {
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
