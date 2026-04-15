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

export class DriveOrderPlugin implements RVViewerPlugin {
  readonly id = 'drive-order';
  readonly core = true;
  /** Run early so drives are sorted before other plugins see them. */
  readonly order = 0;

  onModelLoaded(_result: LoadResult, viewer: RVViewer): void {
    const sorted = this.topologicalSort(viewer.drives);
    viewer.drives.length = 0;
    viewer.drives.push(...sorted);
  }

  private topologicalSort(drives: RVDrive[]): RVDrive[] {
    // Build dependency graph: drivePath -> [dependsOnPaths...]
    const driveByPath = new Map<string, RVDrive>();
    const deps = new Map<string, string[]>();

    for (const d of drives) {
      const path = (d.node.userData?.rv as Record<string, unknown> | undefined)?.['path'] as string
        ?? d.name;
      driveByPath.set(path, d);

      const camExtras = d.BehaviorExtras['Drive_CAM'];
      const gearExtras = d.BehaviorExtras['Drive_Gear'];
      const masterRefs: string[] = [];
      if (camExtras?.['MasterDrive']) masterRefs.push(camExtras['MasterDrive'] as string);
      if (gearExtras?.['MasterDrive']) masterRefs.push(gearExtras['MasterDrive'] as string);
      if (masterRefs.length > 0) deps.set(path, masterRefs);
    }

    // No dependencies? Return as-is (no sorting needed)
    if (deps.size === 0) return drives;

    // Kahn's algorithm for topological sort
    const inDegree = new Map<string, number>();
    for (const [, d] of driveByPath) {
      const p = (d.node.userData?.rv as Record<string, unknown> | undefined)?.['path'] as string ?? d.name;
      inDegree.set(p, 0);
    }
    for (const [path, masters] of deps) {
      let degree = 0;
      for (const m of masters) {
        if (driveByPath.has(m)) degree++;
      }
      inDegree.set(path, degree);
    }

    const queue: string[] = [];
    for (const [path, deg] of inDegree) {
      if (deg === 0) queue.push(path);
    }

    const result: RVDrive[] = [];
    const visited = new Set<string>();

    while (queue.length > 0) {
      const path = queue.shift()!;
      if (visited.has(path)) continue;
      visited.add(path);
      const drive = driveByPath.get(path);
      if (drive) result.push(drive);

      // Find drives that depend on this one and decrement their in-degree
      for (const [depPath, masters] of deps) {
        if (masters.includes(path) && !visited.has(depPath)) {
          const newDeg = (inDegree.get(depPath) ?? 0) - 1;
          inDegree.set(depPath, newDeg);
          if (newDeg <= 0) queue.push(depPath);
        }
      }
    }

    // Add any drives not in the graph (shouldn't happen, but be safe)
    for (const d of drives) {
      const p = (d.node.userData?.rv as Record<string, unknown> | undefined)?.['path'] as string ?? d.name;
      if (!visited.has(p)) result.push(d);
    }

    return result;
  }
}
