// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-729 Phase 4 — the Autonox-Delta pick-and-place demo, verified headless.
 *
 * Loads the REAL KinematicTest asset (`projects/KinematicTest/Autonox-DELTA-
 * RL5-1900-6kg.glb` in the private sibling, served under `/private-assets/`)
 * through the normal viewer load, and proves the authored demo end to end:
 * the MechanismPath and its six MechanismTargets come out of the rv_extras,
 * `LogicStep_MechanismPath` is built through the public registry seam, and one
 * full loop of the path puts the platform origin on every waypoint without a
 * stop — with the driving arms inside the asset's safe demo band.
 *
 * Kinematics only: whether the MERGED render moves the passive links is
 * plan-730's business, not this test's (the node transforms are asserted).
 *
 * Skips loudly without the private asset or the solver artifact.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Vector3 } from 'three';
import { createTestViewer, type TestViewerHandle } from './helpers/create-test-viewer';
import {
  register as registerMechanismFeature,
  unregister as unregisterMechanismFeature,
  getActiveMechanismManager,
} from '@rv-private/features/kinematic-mechanism.register';
import { RVMechanismPathStep } from '@rv-private/kinematic-mechanism/rv-mechanism-path';
import { devAssetsAvailable } from './fixtures/dev-asset-available';
import { releaseAllAxes } from '../src/core/engine/rv-axis-ownership';
import type { RVLogicStep } from '../src/core/engine/rv-logic-step';

const DELTA_URL = '/private-assets/KinematicTest/Autonox-DELTA-RL5-1900-6kg.glb';
const HAS_ASSET = await devAssetsAvailable(DELTA_URL);
const DT = 1 / 60;

let handle: TestViewerHandle;
let solverAvailable = false;

beforeAll(async () => {
  if (!HAS_ASSET) return;
  handle = await createTestViewer('webgl');
  await registerMechanismFeature(handle.viewer);
  solverAvailable = (await getActiveMechanismManager()?.ensureSolverLoaded()) ?? false;
}, 60_000);

afterAll(() => {
  if (!HAS_ASSET) return;
  releaseAllAxes();
  unregisterMechanismFeature();
  handle?.dispose();
});

function collectSteps(step: RVLogicStep, out: RVLogicStep[]): RVLogicStep[] {
  out.push(step);
  const children = (step as unknown as { children?: RVLogicStep[] }).children;
  if (Array.isArray(children)) for (const c of children) collectSteps(c, out);
  return out;
}

describe.skipIf(!HAS_ASSET)('plan-729 Phase 4 — Autonox-Delta MechanismPath demo', () => {
  it('runs one full pick-and-place loop through every waypoint without a stop', async (ctx) => {
    if (!solverAvailable) {
      ctx.skip('rv_kinematic_solver.wasm unavailable');
      return;
    }
    const viewer = handle.viewer;
    await viewer.loadModel(DELTA_URL);
    const manager = getActiveMechanismManager()!;
    const paths = manager.listPaths();
    expect(paths.map((p) => p.node.name)).toEqual(['PickPlace']);
    const path = paths[0];
    path.rebuildTargets();
    expect(path.targets.map((t) => t.node.name)).toEqual([
      'WP_AbovePick', 'WP_Pick', 'WP_AbovePick2', 'WP_AbovePlace', 'WP_Place', 'WP_AbovePlace2',
    ]);
    expect(path.mechanism?.node.name).toBe('DeltaMechanism');
    expect(path.targetLink?.name).toBe('PlatformBody');
    expect(path.LoopPath).toBe(true);

    // The demo sequence: LogicStep_MechanismPath built through the registry seam.
    const steps = (viewer.logicEngine?.roots ?? []).flatMap((r) => collectSteps(r, []));
    expect(steps.some((s) => s instanceof RVMechanismPathStep)).toBe(true);

    // Drive the fixed-step order by hand (deterministic, independent of RAF).
    if (!path.PathIsActive) path.startPath();
    const drives = path.drives;
    expect(drives.length).toBe(3);
    const platform = path.targetLink!;
    const tip = new Vector3();
    const wp = new Vector3();
    const arrivalErrMm: number[] = [];
    let minDrive = Infinity;
    let maxDrive = -Infinity;
    let lastNum = path.NumTarget;
    let arrivals = 0;
    for (let i = 0; i < 60 * 40 && arrivals < path.targets.length; i++) {
      manager.tickPaths(DT);
      manager.tickTargets();
      for (const d of viewer.drives) d.update(DT);
      manager.tickMechanisms(DT);
      for (const d of drives) {
        minDrive = Math.min(minDrive, d.currentPosition);
        maxDrive = Math.max(maxDrive, d.currentPosition);
      }
      if (path.NumTarget !== lastNum) {
        // Arrival at the waypoint just passed (NumTarget advanced by one).
        const reached = path.targets[(path.NumTarget - 1 + path.targets.length) % path.targets.length];
        reached.node.getWorldPosition(wp);
        platform.getWorldPosition(tip);
        arrivalErrMm.push(tip.distanceTo(wp) * 1000);
        arrivals++;
        lastNum = path.NumTarget;
      }
      expect(path.PathFailed, path.LastError).toBe(false);
    }

    expect(arrivals).toBe(path.targets.length);
    // The platform origin lands on every waypoint (mm).
    for (const e of arrivalErrMm) expect(e).toBeLessThan(1);
    // Inside the verified safe band of the asset (arms −30…0°, see knowledge.md).
    expect(minDrive).toBeGreaterThan(-31);
    expect(maxDrive).toBeLessThan(1);
    console.log(`[plan-729 demo] arms ${minDrive.toFixed(1)}…${maxDrive.toFixed(1)} deg, `
      + `arrival error max ${Math.max(...arrivalErrMm).toFixed(3)} mm`);
  }, 120_000);
});
