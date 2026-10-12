// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-492 §9.2 (lane geometry) — the lane is derived from the conveyor's own
 * snap ports, not from its catalog name.
 *
 * `ChainConveyor-2m.glb` puts its root at `[-3.03, 0, 1.43]` with −90° about Y,
 * and the placement pivot shifts the content again. Every naive formula
 * (`z = j · 2 m`, "length from the asset name") therefore builds a lane whose
 * segments neither touch nor point the same way — and a benchmark on a lane
 * like that measures a scattered pile of conveyors, which is a different scene
 * from the one a customer has.
 *
 * The check is the physical one: conveyor `j`'s ZN port has to sit on conveyor
 * `j−1`'s ZP port, within a millimetre, with both conveyors conveying the same
 * way.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { Vector3, Box3, Frustum, Matrix4 } from 'three';
import type { Object3D } from 'three';
import { buildCellMatrix, disposeCellMatrix, cellMatrixBounds } from '../../src/core/engine/perf/rv-cell-matrix';
import type { TestViewerHandle } from '../helpers/create-test-viewer';
import { bootEmptyDocument, laneOf } from './cell-matrix-fixture';

let handle: TestViewerHandle | null = null;
afterEach(() => { handle?.dispose(); handle = null; });

const MM = 0.001;

function portWorld(conveyor: Object3D, prefix: string): Vector3 {
  let node: Object3D | null = null;
  conveyor.traverse((n) => { if (!node && n.name.startsWith(prefix)) node = n; });
  if (!node) throw new Error(`no ${prefix}* port under ${conveyor.name}`);
  conveyor.updateWorldMatrix(true, true);
  return (node as Object3D).getWorldPosition(new Vector3());
}

describe('cell-matrix lane geometry (plan-492 Phase 1)', () => {
  it('conveyor j ZN port sits on conveyor j-1 ZP port (<= 1 mm), same conveying direction', async () => {
    handle = await bootEmptyDocument();
    const viewer = handle.viewer;
    await buildCellMatrix(viewer, { cells: 2, conveyorsPerLane: 4, motion: 'none' });

    for (let i = 0; i < 2; i++) {
      const lane = laneOf(viewer, i);
      const convs = [0, 1, 2, 3].map((j) => {
        const c = lane.getObjectByName(`Conv${j}`);
        if (!c) throw new Error(`Lane${i}/Conv${j} missing`);
        return c;
      });
      const dir0 = portWorld(convs[0], 'Snap-ZP').sub(portWorld(convs[0], 'Snap-ZN')).normalize();
      for (let j = 1; j < convs.length; j++) {
        const gap = portWorld(convs[j], 'Snap-ZN').distanceTo(portWorld(convs[j - 1], 'Snap-ZP'));
        expect(gap, `Lane${i}: Conv${j}.ZN meets Conv${j - 1}.ZP`).toBeLessThanOrEqual(1 * MM);
        const dir = portWorld(convs[j], 'Snap-ZP').sub(portWorld(convs[j], 'Snap-ZN')).normalize();
        expect(dir.dot(dir0), `Lane${i}/Conv${j} conveys the same way`).toBeGreaterThan(0.999);
      }
    }
    disposeCellMatrix(viewer);
  }, 120_000);

  it('lanes do not overlap and the robot stands beside its lane', async () => {
    handle = await bootEmptyDocument();
    const viewer = handle.viewer;
    const spacing = 4;
    await buildCellMatrix(viewer, { cells: 3, conveyorsPerLane: 2, laneSpacingM: spacing, motion: 'none' });

    const laneCentre = (i: number): Vector3 => {
      const box = new Box3().setFromObject(laneOf(viewer, i).getObjectByName('Conv0')!);
      return box.getCenter(new Vector3());
    };
    const d01 = laneCentre(0).distanceTo(laneCentre(1));
    const d12 = laneCentre(1).distanceTo(laneCentre(2));
    expect(d01).toBeCloseTo(spacing, 3);
    expect(d12).toBeCloseTo(spacing, 3);

    // The robot is offset ACROSS the lane, not sitting on a conveyor.
    const robot = laneOf(viewer, 0).getObjectByName('Robot')!;
    const robotPos = robot.getWorldPosition(new Vector3());
    const convPos = laneOf(viewer, 0).getObjectByName('Conv0')!.getWorldPosition(new Vector3());
    expect(robotPos.distanceTo(convPos)).toBeGreaterThan(0.5);
    disposeCellMatrix(viewer);
  }, 120_000);

  it('the camera fit after materialisation contains every placement bound', async () => {
    handle = await bootEmptyDocument();
    const viewer = handle.viewer;
    await buildCellMatrix(viewer, { cells: 4, conveyorsPerLane: 3, motion: 'none' });

    // Without the deterministic fit the camera still frames the EMPTY document
    // it was loaded with, and frustum culling would silently drop most of the
    // matrix out of the measurement.
    viewer.camera.updateMatrixWorld(true);
    viewer.camera.updateProjectionMatrix();
    const frustum = new Frustum().setFromProjectionMatrix(
      new Matrix4().multiplyMatrices(viewer.camera.projectionMatrix, viewer.camera.matrixWorldInverse),
    );
    const bounds = cellMatrixBounds(viewer)!;
    expect(frustum.intersectsBox(bounds), 'the whole matrix is inside the frustum').toBe(true);
    // Every corner, not just an intersection of the whole box.
    const corners = [
      new Vector3(bounds.min.x, bounds.min.y, bounds.min.z),
      new Vector3(bounds.max.x, bounds.min.y, bounds.min.z),
      new Vector3(bounds.min.x, bounds.min.y, bounds.max.z),
      new Vector3(bounds.max.x, bounds.max.y, bounds.max.z),
    ];
    for (const c of corners) expect(frustum.containsPoint(c), `corner ${c.toArray().join(',')}`).toBe(true);
    disposeCellMatrix(viewer);
  }, 120_000);
});
