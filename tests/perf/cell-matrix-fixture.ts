// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Shared boot for the plan-492 cell-matrix tests.
 *
 * The generator builds into an OPEN document, and a viewer only has a
 * registry / signal store / transport manager once something is loaded — so
 * every cell-matrix test starts from the synthesized EMPTY document, which is
 * also what the headless runner opens (plan-492 R10).
 *
 * The assets are the real, committed library GLBs served out of `public/`:
 * measuring a bake on a synthetic box would defeat the point of the benchmark,
 * and the same files are what a customer layout places.
 */
import { getEmptyGlbUrl } from '../../src/core/hmi/scene/empty-glb';
import { createTestViewer, type TestViewerHandle } from '../helpers/create-test-viewer';
import type { RVViewer } from '../../src/core/rv-viewer';
import type { RVDrive } from '../../src/core/engine/rv-drive';
import type { Object3D } from 'three';

/** Boot a real viewer with the empty document open. */
export async function bootEmptyDocument(): Promise<TestViewerHandle> {
  const handle = await createTestViewer('webgl');
  try {
    await handle.viewer.loadModel(getEmptyGlbUrl());
  } catch (err) {
    handle.dispose();
    throw err;
  }
  return handle;
}

/** Advance the simulation by `seconds` in 1/60 s fixed steps. */
export function stepSim(viewer: RVViewer, seconds: number, dt = 1 / 60): void {
  const steps = Math.max(1, Math.round(seconds / dt));
  for (let i = 0; i < steps; i++) {
    for (const drive of viewer.drives) drive.update(dt);
  }
}

/** Global counts the cell matrix must leave at zero (plan-492 F2b / R10). */
export function materialFlowCounts(viewer: RVViewer): { mus: number; sources: number; sinks: number; sensors: number } {
  const tm = viewer.transportManager;
  return {
    mus: tm?.mus.length ?? 0,
    sources: tm?.sources.length ?? 0,
    sinks: tm?.sinks.length ?? 0,
    sensors: tm?.sensors.length ?? 0,
  };
}

/** The `RVDrive` on the node called `name` inside `root` (the placement's own). */
export function driveUnder(viewer: RVViewer, root: Object3D, name: string): RVDrive {
  const node = root.getObjectByName(name);
  if (!node) throw new Error(`no node "${name}" under ${root.name}`);
  for (const { instance } of viewer.registry!.getAll<RVDrive>('Drive')) {
    if ((instance as unknown as { node?: Object3D }).node === node) return instance;
  }
  throw new Error(`no Drive on "${name}" under ${root.name}`);
}

/** The lane group `Lane<i>` of the live matrix. */
export function laneOf(viewer: RVViewer, i: number): Object3D {
  const root = viewer.scene.getObjectByName('CellMatrix');
  const lane = root?.getObjectByName(`Lane${i}`);
  if (!lane) throw new Error(`no Lane${i} in the cell matrix`);
  return lane;
}
