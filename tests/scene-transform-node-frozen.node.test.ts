// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Scene `transformNode` executor must refresh the world matrices of a matrix-frozen
 * subtree (baked placement content), exactly like the transform gizmo does.
 */
import { describe, expect, it } from 'vitest';
import { Object3D } from 'three';
import { applyForward, applyInverse } from '../src/core/hmi/scene/rv-scene-executors';

function rig() {
  const root = new Object3D();
  const station = new Object3D();
  const child = new Object3D();
  child.position.set(0, 0, 0.5);
  station.add(child);
  root.add(station);
  root.updateMatrixWorld(true);
  // loader freeze: static subtree no longer auto-updates its world matrix
  station.matrixWorldAutoUpdate = false;
  child.matrixWorldAutoUpdate = false;
  const viewer = { registry: { getNode: (p: string) => (p === 'Station' ? station : null) },
    signalStore: undefined, markRenderDirty: () => {} } as never;
  return { station, child, ctx: { viewer } };
}
const op = (position: number[], prev: number[]) => ({ id: 'o1', ts: 0, schemaV: 1, kind: 'transformNode', nodePath: 'Station',
  transform: { position, quaternion: [0, 0, 0, 1] }, prev: { position: prev, quaternion: [0, 0, 0, 1] } }) as never;

describe('scene transformNode on a frozen subtree', () => {
  it('moves the frozen descendants world pose forward and back', async () => {
    const { station, child, ctx } = rig();
    await applyForward(op([2, 0, 0], [0, 0, 0]), ctx);
    expect(station.matrixWorld.elements[12]).toBeCloseTo(2, 6);
    expect(child.matrixWorld.elements[12]).toBeCloseTo(2, 6);
    expect(child.matrixWorld.elements[14]).toBeCloseTo(0.5, 6);
    await applyInverse(op([2, 0, 0], [0, 0, 0]), ctx);
    expect(child.matrixWorld.elements[12]).toBeCloseTo(0, 6);
  });
});
