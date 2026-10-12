// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-492 §9.3 — the motion modes do what their names say, and switching
 * between them is free (no rebuild, no reload).
 *
 * The two traps this pins down:
 *
 *  - **`SignalEnable` is not a pause button.** It binds once in `init()` and,
 *    when false, drives the axis back to zero (rv-erratic.ts). A robot "turned
 *    off" that way folds itself up, which changes the very geometry the
 *    benchmark is measuring. Stopping is therefore detach + `drive.stop()`,
 *    and the test asserts the pose is HELD.
 *  - **Re-attaching alone does not restart the sweep (R1).** The behavior still
 *    believes it is driving towards a target the stop made unreachable, so it
 *    waits forever. `RVErraticDriver.resume()` is what makes `robot` after
 *    `none` actually move again.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildCellMatrix,
  setCellMotion,
  disposeCellMatrix,
  cellMatrixStats,
} from '../../src/core/engine/perf/rv-cell-matrix';
import type { TestViewerHandle } from '../helpers/create-test-viewer';
import { bootEmptyDocument, stepSim, driveUnder, laneOf } from './cell-matrix-fixture';
import type { RVViewer } from '../../src/core/rv-viewer';

let handle: TestViewerHandle | null = null;
afterEach(() => { handle?.dispose(); handle = null; });

const a1 = (viewer: RVViewer, lane: number): number =>
  driveUnder(viewer, laneOf(viewer, lane).getObjectByName('Robot')!, 'A1').currentPosition;

describe('cell-matrix motion modes (plan-492 Phase 1)', () => {
  it('none holds the pose, robot sweeps, sparse runs every n-th, and the chain of switches survives', async () => {
    handle = await bootEmptyDocument();
    const viewer = handle.viewer;
    await buildCellMatrix(viewer, { cells: 4, conveyorsPerLane: 2, motion: 'none', sparseEvery: 2 });

    // none — nothing moves.
    stepSim(viewer, 1);
    expect(a1(viewer, 0)).toBe(0);
    expect(a1(viewer, 1)).toBe(0);

    // robot — every axis of every cell sweeps.
    setCellMotion(viewer, 'robot');
    expect(cellMatrixStats(viewer)!.movingRobots).toBe(4);
    stepSim(viewer, 1);
    const moved = [0, 1, 2, 3].map((i) => a1(viewer, i));
    for (const p of moved) expect(Math.abs(p), 'A1 left zero').toBeGreaterThan(5);

    // Stop mid-stroke: the pose is HELD, not driven back to zero.
    setCellMotion(viewer, 'none');
    stepSim(viewer, 1);
    for (let i = 0; i < 4; i++) expect(a1(viewer, i)).toBeCloseTo(moved[i], 6);

    // sparse — every 2nd lane resumes, the others keep standing (R1: the
    // resumed ones really move again, they do not wait for a dead target).
    setCellMotion(viewer, 'sparse');
    const beforeSparse = [0, 1, 2, 3].map((i) => a1(viewer, i));
    stepSim(viewer, 2);
    expect(Math.abs(a1(viewer, 0) - beforeSparse[0]), 'lane 0 runs').toBeGreaterThan(1);
    expect(Math.abs(a1(viewer, 2) - beforeSparse[2]), 'lane 2 runs').toBeGreaterThan(1);
    expect(a1(viewer, 1), 'lane 1 is parked').toBeCloseTo(beforeSparse[1], 6);
    expect(a1(viewer, 3), 'lane 3 is parked').toBeCloseTo(beforeSparse[3], 6);

    // The whole mode chain, back to back — nothing throws, everything runs again.
    for (const mode of ['none', 'all', 'conveyor', 'robot', 'none', 'all'] as const) setCellMotion(viewer, mode);
    const beforeAll = [0, 1, 2, 3].map((i) => a1(viewer, i));
    stepSim(viewer, 2);
    for (let i = 0; i < 4; i++) {
      expect(Math.abs(a1(viewer, i) - beforeAll[i]), `lane ${i} runs under "all"`).toBeGreaterThan(0.5);
    }
    disposeCellMatrix(viewer);
  }, 180_000);

  it('conveyor mode jogs the belt drives and none stops them', async () => {
    handle = await bootEmptyDocument();
    const viewer = handle.viewer;
    await buildCellMatrix(viewer, { cells: 2, conveyorsPerLane: 2, motion: 'conveyor' });
    const stats = cellMatrixStats(viewer)!;
    expect(stats.movingConveyors).toBe(stats.transportSurfaces);
    expect(stats.movingRobots).toBe(0);

    const belt = driveUnder(viewer, laneOf(viewer, 0).getObjectByName('Conv0')!, 'Transport-Z');
    expect(belt.JogForward).toBe(true);
    stepSim(viewer, 0.5);
    expect(Math.abs(belt.currentSpeed), 'the belt is running').toBeGreaterThan(0);

    setCellMotion(viewer, 'none');
    expect(belt.JogForward).toBe(false);
    stepSim(viewer, 1);
    expect(cellMatrixStats(viewer)!.movingConveyors).toBe(0);
    disposeCellMatrix(viewer);
  }, 120_000);

  it('two runs with the same configuration produce the same A1 trajectory', async () => {
    const trajectory = async (): Promise<number[]> => {
      const h = await bootEmptyDocument();
      handle = h;
      await buildCellMatrix(h.viewer, { cells: 1, conveyorsPerLane: 1, motion: 'robot' });
      const out: number[] = [];
      for (let i = 0; i < 20; i++) { stepSim(h.viewer, 0.1); out.push(a1(h.viewer, 0)); }
      disposeCellMatrix(h.viewer);
      h.dispose();
      handle = null;
      return out;
    };
    // The iterate sweep has no `Math.random` in it (that is the whole reason
    // `IterateBetweenMaxAndMin` is baked into the asset), so two builds must
    // trace the same path step for step.
    const first = await trajectory();
    const second = await trajectory();
    expect(second).toEqual(first);
    expect(first.some((p) => Math.abs(p) > 5), 'the axis actually moved').toBe(true);
  }, 180_000);

  it('two placements of the robot each resolve their OWN gripper (R4)', async () => {
    handle = await bootEmptyDocument();
    const viewer = handle.viewer;
    await buildCellMatrix(viewer, { cells: 2, conveyorsPerLane: 1, motion: 'none' });

    // Every gear-style drive reference inside a robot must point at a drive of
    // the SAME placement. Without the placement-scoped rewrite the asset-internal
    // `FanucCRX-10iA-L/…` path suffix-matches across placements and a finger
    // binds to the neighbouring cell's gripper.
    const robots = [0, 1].map((i) => laneOf(viewer, i).getObjectByName('Robot')!);
    const reg = viewer.registry!;
    let checked = 0;
    for (const [index, robot] of robots.entries()) {
      robot.traverse((node) => {
        const path = reg.getPathForNode(node);
        if (!path) return;
        for (const [, instance] of reg.getComponentsAt(path)) {
          const master = (instance as { MasterDrive?: unknown }).MasterDrive;
          if (!master || typeof master !== 'object') continue;
          const masterNode = (master as { node?: { parent: unknown } }).node;
          if (!masterNode) continue;
          checked++;
          // The referenced drive's node has to live under THIS robot.
          let under = false;
          for (let cur: unknown = masterNode; cur; cur = (cur as { parent?: unknown }).parent) {
            if (cur === robot) { under = true; break; }
          }
          expect(under, `robot ${index}: ${path} resolved outside its own placement`).toBe(true);
        }
      });
    }
    expect(checked, 'the asset carries at least one internal drive reference').toBeGreaterThan(0);
    disposeCellMatrix(viewer);
  }, 120_000);
});
