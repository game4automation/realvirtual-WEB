// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * DriveOrderPlugin — Topological sort of viewer.drives for CAM/Gear dependencies.
 *
 * Runs in onModelLoaded AND on every runtime change of the drive collection
 * (`drives-changed`, plan-411 Phase 1): re-orders the drives array so that
 * master drives are updated before their slaves. Independent drives
 * keep their original order (stable sort).
 *
 * Reacting to the runtime event is not cosmetic — a Gear/CAM slave added in the
 * editor is APPENDED to the tick list, i.e. behind nothing and before nothing,
 * so without the re-sort it would read its master's position one tick late for
 * the rest of the session.
 */

import type { RVViewerPlugin } from '../core/rv-plugin';
import type { RVViewer } from '../core/rv-viewer';
import type { LoadResult } from '../core/engine/rv-scene-loader';
import type { RVDrive } from '../core/engine/rv-drive';
import { NodeRegistry } from '../core/engine/rv-node-registry';
import { storedReferenceValue } from '../core/engine/rv-node-path-rewrite.mjs';

export class DriveOrderPlugin implements RVViewerPlugin {
  readonly id = 'drive-order';
  readonly core = true;
  /** Run early so drives are sorted before other plugins see them. */
  readonly order = 0;

  /** Unsubscribe handle of the `drives-changed` subscription. */
  private _off: (() => void) | null = null;

  onModelLoaded(_result: LoadResult, viewer: RVViewer): void {
    this.sort(viewer);
    // Re-sort whenever the collection changes at runtime. The sort itself
    // mutates `viewer.drives` IN PLACE without going through addDrive/
    // removeDrive, so it cannot re-enter this handler.
    this._off?.();
    this._off = viewer.on('drives-changed', () => this.sort(viewer));
  }

  onModelCleared(): void {
    this._off?.();
    this._off = null;
  }

  dispose(): void {
    this._off?.();
    this._off = null;
  }

  /** Re-run the topological sort over the viewer's current drive list. */
  sort(viewer: RVViewer): void {
    const sorted = this.topologicalSort(viewer.drives, viewer.registry ?? null);
    // `topologicalSort` returns the SAME array instance when there is nothing to
    // reorder (no CAM/Gear dependencies). `sorted` would then alias viewer.drives,
    // so `length = 0` empties BOTH and the push re-adds nothing — silently wiping
    // every drive from the simulation (they stop ticking, jog does nothing).
    // Identity-check before the destructive in-place rewrite.
    if (sorted === viewer.drives) return;
    viewer.drives.length = 0;
    viewer.drives.push(...sorted);
  }

  private topologicalSort(drives: RVDrive[], registry: NodeRegistry | null = null): RVDrive[] {
    // Index drives by full node path and by name for master-ref resolution.
    const byPath = new Map<string, RVDrive>();
    const byName = new Map<string, RVDrive[]>();
    const byNode = new Map<object, RVDrive>();
    for (const d of drives) {
      byNode.set(d.node, d);
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
        const raw = d.BehaviorExtras[key]?.['MasterDrive'];
        const refPath = extractPath(raw);
        // plan-769 Phase 3: a web-saved `MasterDrive` is `{ type, address, … }` — no path.
        const stored = storedReferenceValue(raw);
        if (!refPath && (stored === null || !registry)) continue;
        // plan-769 Phase 1b: `MasterDrive` is a stored reference of the slave's
        // file — the file's verdict names the master node (no name guess); only a
        // path the file does not carry (or no registry / identity) keeps the old match.
        let m: RVDrive | null;
        if (registry) {
          const r = registry.readStoredRef(d.node, raw as Parameters<NodeRegistry['readStoredRef']>[1]);
          m = r.status === 'resolved' ? (byNode.get(r.node) ?? null)
            : r.status === 'legacy' ? resolveMaster(r.path) : null;
        } else {
          m = resolveMaster(refPath!);
        }
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
