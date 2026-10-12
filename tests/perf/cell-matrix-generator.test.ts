// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-492 §9.2 — the cell-matrix generator builds on the production placement
 * path and gives everything back.
 *
 * What is actually at stake here, finding by finding:
 *  - R2: `materialize()` returns geometry and markers only — without the
 *    caller's `integratePlacedContent` the placements would carry no drives,
 *    no transport surfaces and no registry paths, and a "benchmark" would be
 *    measuring an inert scene graph.
 *  - R3: `PlacementInstancer.release()` does not unwind the runtime, so a
 *    rebuild leak is invisible in `BakeRegistry.stats().instances`. The lists
 *    are compared against the pre-build state after three rebuilds.
 *  - R4: two placements of the robot must each resolve their own gripper.
 *  - R5: the library conveyor carries a `Sensor` the naming scan activates.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Object3D } from 'three';
import {
  buildCellMatrix,
  disposeCellMatrix,
  cellMatrixStats,
  cellMatrixBounds,
  CELL_MATRIX_ROOT_NAME,
} from '../../src/core/engine/perf/rv-cell-matrix';
import type { TestViewerHandle } from '../helpers/create-test-viewer';
import { bootEmptyDocument, materialFlowCounts } from './cell-matrix-fixture';

let handle: TestViewerHandle | null = null;
afterEach(() => { handle?.dispose(); handle = null; });

const CELLS = 4;
const CONV = 3;

describe('cell-matrix generator (plan-492 Phase 1)', () => {
  it('4 cells x 3 conveyors = 16 placements from 2 bakes, sensors off, runtime registered', async () => {
    handle = await bootEmptyDocument();
    const viewer = handle.viewer;

    const stats = await buildCellMatrix(viewer, { cells: CELLS, conveyorsPerLane: CONV, motion: 'none' });

    expect(stats.placements).toBe(CELLS * (CONV + 1));
    expect(stats.bakes, 'one bake per asset — the cache deduplicates').toBe(2);
    expect(viewer.placements.getBakeStats().assets).toBe(2);
    expect(viewer.placements.bakeRegistry.stats().instances).toBe(stats.placements);

    // R5 — the library conveyor's Sensor is out of the manager list.
    expect(stats.activeSensors).toBe(0);
    // R10 — a conveying lane, not a material-flow scene.
    const counts = materialFlowCounts(viewer);
    expect({ mus: counts.mus, sources: counts.sources, sinks: counts.sinks })
      .toEqual({ mus: 0, sources: 0, sinks: 0 });

    // R2 — the runtime a placement produces, per placement.
    expect(stats.erraticDrivers, 'six sweeping axes per robot').toBe(CELLS * 6);
    expect(stats.transportSurfaces, 'one transport surface per conveyor').toBe(CELLS * CONV);
    expect(stats.drives).toBeGreaterThanOrEqual(stats.erraticDrivers);
    expect(viewer.drives.length).toBeGreaterThanOrEqual(stats.drives);

    // Chunk geometry really is shared: N instances, a handful of chunks.
    expect(stats.chunkMeshes).toBeGreaterThan(0);
    expect(stats.pickOk, 'every chunk got its pick structure').toBe(true);
    expect(stats.bvhWaitMs).toBeGreaterThanOrEqual(0);

    // Unique registry paths — a name collision would silently overwrite an
    // entry, so each placement is resolved back through its OWN root.
    const reg = viewer.registry!;
    const root = viewer.scene.getObjectByName(CELL_MATRIX_ROOT_NAME)!;
    expect(root).toBeTruthy();
    const paths = new Set<string>();
    let placementRoots = 0;
    root.traverse((n: Object3D) => {
      if (!n.userData._layoutId) return;
      if (!(n.userData._layoutId as string).startsWith('cellmatrix:')) return;
      if (n.parent && n.parent.userData._layoutId) return; // nested marker
      placementRoots++;
      const path = reg.getPathForNode(n);
      expect(path, `${n.name} is registered`).toBeTruthy();
      paths.add(path!);
    });
    expect(placementRoots).toBe(stats.placements);
    expect(paths.size, 'every placement has its own registry path').toBe(stats.placements);

    // The camera sees what was built (plan-492 §2.4 step 6).
    const bounds = cellMatrixBounds(viewer)!;
    expect(bounds).toBeTruthy();
    expect(bounds.isEmpty()).toBe(false);
  }, 120_000);

  it('dispose gives every instance, drive, surface and registry path back — after three rebuilds', async () => {
    handle = await bootEmptyDocument();
    const viewer = handle.viewer;
    const reg = viewer.registry!;
    const tm = viewer.transportManager!;

    const before = {
      instances: viewer.placements.bakeRegistry.stats().instances,
      drives: viewer.drives.length,
      surfaces: tm.surfaces.length,
      sensors: tm.sensors.length,
      nodes: reg.size.nodes,
      components: reg.size.components,
    };

    for (let round = 0; round < 3; round++) {
      const stats = await buildCellMatrix(viewer, { cells: 2, conveyorsPerLane: 2, motion: 'none' });
      expect(stats.placements).toBe(6);
      disposeCellMatrix(viewer);
      expect(cellMatrixStats(viewer)).toBeNull();
      expect({
        instances: viewer.placements.bakeRegistry.stats().instances,
        drives: viewer.drives.length,
        surfaces: tm.surfaces.length,
        sensors: tm.sensors.length,
        nodes: reg.size.nodes,
        components: reg.size.components,
      }, `round ${round + 1} left nothing behind`).toEqual(before);
    }

    // Rebuilding over a live matrix is the same teardown (idempotent build).
    await buildCellMatrix(viewer, { cells: 2, conveyorsPerLane: 2, motion: 'none' });
    const stats = await buildCellMatrix(viewer, { cells: 3, conveyorsPerLane: 2, motion: 'none' });
    expect(stats.placements).toBe(9);
    expect(viewer.placements.bakeRegistry.stats().instances).toBe(9);
    disposeCellMatrix(viewer);
  }, 180_000);

  it('rejects a configuration it cannot build', async () => {
    handle = await bootEmptyDocument();
    const viewer = handle.viewer;
    await expect(buildCellMatrix(viewer, { cells: 0 })).rejects.toThrow(/cells must be/);
    await expect(buildCellMatrix(viewer, { conveyorsPerLane: 0 })).rejects.toThrow(/conveyorsPerLane must be/);
    await expect(buildCellMatrix(viewer, { motion: 'sideways' as never })).rejects.toThrow(/unknown motion/);
  }, 60_000);
});
