// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * DriveOrderPlugin — Topological sort of viewer.drives for CAM/Gear dependencies.
 *
 * Runs once in onModelLoaded: re-orders the drives array so that
 * master drives are updated before their slaves. Independent drives
 * keep their original order (stable sort).
 */

import type { RVViewerPlugin } from '../core/rv-plugin';
import type { RVViewer } from '../core/rv-viewer';
import type { LoadResult } from '../core/engine/rv-scene-loader';
import type { RVDrive } from '../core/engine/rv-drive';
import { NodeRegistry } from '../core/engine/rv-node-registry';

export class DriveOrderPlugin implements RVViewerPlugin {
  readonly id = 'drive-order';
  readonly core = true;
  /** Run early so drives are sorted before other plugins see them. */
  readonly order = 0;

  onModelLoaded(_result: LoadResult, viewer: RVViewer): void {
    const sorted = this.topologicalSort(viewer.drives);
    // `topologicalSort` returns the SAME array instance when there is nothing to
    // reorder (no CAM/Gear dependencies). `sorted` would then alias viewer.drives,
    // so `length = 0` empties BOTH and the push re-adds nothing — silently wiping
    // every drive from the simulation (they stop ticking, jog does nothing).
    // Identity-check before the destructive in-place rewrite.
    if (sorted === viewer.drives) return;
    viewer.drives.length = 0;
    viewer.drives.push(...sorted);
  }

  private topologicalSort(drives: RVDrive[]): RVDrive[] {
    // Index drives by full node path and by name for master-ref resolution.
    const byPath = new Map<string, RVDrive>();
    const byName = new Map<string, RVDrive[]>();
    for (const d of drives) {
      byPath.set(NodeRegistry.computeNodePath(d.node), d);
      const list = byName.get(d.name) ?? [];
      list.push(d);
      byName.set(d.name, list);
    }

    // MasterDrive in the behavior extras is a raw ComponentReference object
    // ({ type, path, componentType }); older callers may hand us a bare string.
    const extractPath = (ref: unknown): string | null => {
      if (!ref) return null;
      if (typeof ref === 'string') return ref;
      const p = (ref as { path?: string }).path;
      return typeof p === 'string' ? p : null;
    };
    const resolveMaster = (refPath: string): RVDrive | null => {
      const exact = byPath.get(refPath);
      if (exact) return exact;
      // Fallback: match by node name (last path segment). Robust to kinematic
      // re-parenting, which rewrites the path prefix but not the drive node name.
      // Only accept an unambiguous single match.
      const name = refPath.split('/').pop() ?? refPath;
      const named = byName.get(name);
      return named && named.length === 1 ? named[0] : null;
    };

    // Build dependency edges (slave → its masters) as RVDrive references, so the
    // sort never relies on fragile string-key equality.
    const masters = new Map<RVDrive, RVDrive[]>();
    let hasDeps = false;
    for (const d of drives) {
      const refs: RVDrive[] = [];
      for (const key of ['Drive_CAM', 'Drive_Gear']) {
        const refPath = extractPath(d.BehaviorExtras[key]?.['MasterDrive']);
        if (!refPath) continue;
        const m = resolveMaster(refPath);
        if (m && m !== d && !refs.includes(m)) refs.push(m);
      }
      if (refs.length > 0) { masters.set(d, refs); hasDeps = true; }
    }

    // No dependencies? Return as-is (no sorting needed)
    if (!hasDeps) return drives;

    // Kahn's algorithm over RVDrive nodes. Seeding the queue from `drives` (input
    // order) keeps the sort stable for independent drives.
    const inDegree = new Map<RVDrive, number>();
    for (const d of drives) inDegree.set(d, masters.get(d)?.length ?? 0);

    const result: RVDrive[] = [];
    const visited = new Set<RVDrive>();
    const queue: RVDrive[] = drives.filter(d => (inDegree.get(d) ?? 0) === 0);

    while (queue.length > 0) {
      const d = queue.shift()!;
      if (visited.has(d)) continue;
      visited.add(d);
      result.push(d);

      // Any slave whose master is d loses one in-degree.
      for (const [slave, ms] of masters) {
        if (!visited.has(slave) && ms.includes(d)) {
          const nd = (inDegree.get(slave) ?? 0) - 1;
          inDegree.set(slave, nd);
          if (nd <= 0) queue.push(slave);
        }
      }
    }

    // Append any leftovers (cycles / unresolved masters), preserving input order.
    for (const d of drives) if (!visited.has(d)) result.push(d);

    return result;
  }
}
