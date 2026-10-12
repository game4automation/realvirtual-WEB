// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-492 Phase 6 — library robots as placements beside the Perf Line.
 *
 * Same fixture as the cell matrix (an empty document in a real viewer), so the
 * robots go through the production placement path: bake, materialise, scoped
 * component references, erratic drivers, and a teardown that leaves nothing in
 * the registry, the drive list or the bake registry.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { placeLibraryRobots } from '../../src/core/engine/perf/rv-robot-placements';
import type { TestViewerHandle } from '../helpers/create-test-viewer';
import { bootEmptyDocument } from './cell-matrix-fixture';

let handle: TestViewerHandle | null = null;
afterEach(() => { handle?.dispose(); handle = null; });

describe('placeLibraryRobots', () => {
  it('places N real robots where asked, with six erratic axes each, and gives them back', async () => {
    handle = await bootEmptyDocument();
    const viewer = handle.viewer;
    const drivesBefore = viewer.drives.length;

    const robots = await placeLibraryRobots(viewer, {
      count: 3,
      motion: 'static',
      place: (i, out) => out.set(i * 4, 0, i % 2 === 0 ? -2 : 12),
      yaw: (i) => (i % 2 === 0 ? 0 : Math.PI),
    });

    expect(robots.stats.robots).toBe(3);
    expect(robots.roots).toHaveLength(3);
    expect(robots.stats.erraticAxes, 'six sweeping axes per robot').toBe(18);
    expect(robots.stats.drives).toBeGreaterThanOrEqual(18);
    expect(viewer.placements.bakeRegistry.stats().instances).toBe(3);
    expect(viewer.drives.length).toBe(drivesBefore + robots.stats.drives);

    // Positioned after materialisation, so the pivot did not shift them back.
    const p1 = robots.roots[1].getWorldPosition(new Vector3());
    expect(p1.x).toBeCloseTo(4, 3);
    expect(p1.z).toBeCloseTo(12, 3);
    expect(robots.roots[1].rotation.y).toBeCloseTo(Math.PI, 6);

    // Random targets, not the asset's min↔max toggle, and a per-robot tempo so
    // three copies of one asset do not move in lockstep.
    const registry = viewer.registry!;
    const drivers = registry.getAll<{ node: { name: string }; IterateBetweenMaxAndMin: boolean; Speed: number }>('Drive_ErraticPosition')
      .map(({ instance }) => instance);
    expect(drivers.every((d) => d.IterateBetweenMaxAndMin === false)).toBe(true);
    const a1Speeds = drivers.filter((d) => d.node.name === 'A1').map((d) => d.Speed);
    expect(a1Speeds).toHaveLength(3);
    expect(new Set(a1Speeds).size, 'each robot has its own tempo').toBe(3);
    for (const s of a1Speeds) { expect(s).toBeGreaterThanOrEqual(40 * 0.7); expect(s).toBeLessThanOrEqual(40 * 1.3); }
    const attached = (): number => registry.getAll<{ drive?: { driveBehaviors: unknown[] } }>('Drive_ErraticPosition')
      .filter(({ instance }) => instance.drive && (instance.drive.driveBehaviors as unknown[]).includes(instance)).length;
    expect(attached()).toBe(0);
    robots.setMotion('erratic');
    expect(attached()).toBe(18);
    expect(robots.stats.motion).toBe('erratic');
    robots.setMotion('static');
    expect(attached()).toBe(0);

    robots.dispose();
    expect(viewer.placements.bakeRegistry.stats().instances).toBe(0);
    expect(viewer.drives.length).toBe(drivesBefore);
    expect(viewer.scene.getObjectByName('PerfRobots')).toBeUndefined();
    expect(registry.getAll('Drive_ErraticPosition')).toHaveLength(0);
  });

  it('count 0 is a valid, empty row', async () => {
    handle = await bootEmptyDocument();
    const robots = await placeLibraryRobots(handle.viewer, { count: 0, motion: 'static', place: (_i, out) => out.set(0, 0, 0) });
    expect(robots.stats.robots).toBe(0);
    robots.dispose();
  });
});
