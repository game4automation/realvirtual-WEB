// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Planner drag overlay (2026-11-05, Vincent): the neighbor distances belong to
 * magnetic snap — with magnetic snap off they are not drawn at all — and while
 * they are drawn, the dragged object's bounding-box footprint (its bottom
 * rectangle on the floor) is drawn with the same thin line.
 */
import { describe, it, expect } from 'vitest';
import { BoxGeometry, Mesh, MeshBasicMaterial, Object3D, Scene } from 'three';
import { BboxSnapController } from '../src/plugins/layout-planner/bbox-snap';
import type { LayoutStore } from '../src/plugins/layout-planner/rv-layout-store';

function setup(opts: { snap: boolean; distances: boolean }) {
  const scene = new Scene();
  const box = () => new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial());
  const moving = box(); moving.position.set(0, 0.5, 0);
  const neighbor = box(); neighbor.position.set(3, 0.5, 0);
  scene.add(moving, neighbor);
  const store = {
    bboxSnapEnabled: opts.snap,
    showNeighborDistances: opts.distances,
    neighborDistanceMaxMm: 10_000,
    bboxSnapToleranceMm: 30,
    bboxSnapMid: true,
    bboxSnapSide: true,
  } as unknown as LayoutStore;
  const snap = new BboxSnapController({
    scene, store,
    getAllPlaced: () => [moving, neighbor],
    markRenderDirty: () => {},
    markAsFixture: () => {},
    unmarkAsFixture: () => {},
  });
  return { scene, moving, snap };
}

const visibleNamed = (scene: Scene, name: string): Object3D[] =>
  scene.children.filter((c) => c.name === name && c.visible);

describe('planner drag overlay: neighbor distances + footprint', () => {
  it('magnetic snap off → no distances and no footprint', () => {
    const { scene, moving, snap } = setup({ snap: false, distances: true });
    snap.armForDrag(moving);
    snap.applySnap(0.2, 0, 'free');
    expect(visibleNamed(scene, '_layoutNeighborGuide')).toHaveLength(0);
    expect(visibleNamed(scene, '_layoutNeighborDistance')).toHaveLength(0);
    expect(visibleNamed(scene, '_layoutFootprint')).toHaveLength(0);
    snap.dispose();
  });

  it('magnetic snap on + distances on → distances and the footprint on the floor', () => {
    const { scene, moving, snap } = setup({ snap: true, distances: true });
    snap.armForDrag(moving);
    snap.applySnap(0.2, 0, 'free');
    expect(visibleNamed(scene, '_layoutNeighborGuide').length).toBeGreaterThan(0);
    const [footprint] = visibleNamed(scene, '_layoutFootprint') as Mesh[];
    expect(footprint).toBeDefined();
    footprint.geometry.computeBoundingBox();
    const bb = footprint.geometry.boundingBox!;
    // The 1 m × 1 m bottom face of the dragged box, flat on the floor.
    expect(bb.max.x - bb.min.x).toBeCloseTo(1, 5);
    expect(bb.max.z - bb.min.z).toBeCloseTo(1, 5);
    expect(bb.max.y - bb.min.y).toBeCloseTo(0, 5);
    snap.disarm();
    expect(visibleNamed(scene, '_layoutFootprint')).toHaveLength(0);
    snap.dispose();
    expect(scene.children.some((c) => c.name === '_layoutFootprint')).toBe(false);
  });

  it('magnetic snap on + distances switched off → no footprint either', () => {
    const { scene, moving, snap } = setup({ snap: true, distances: false });
    snap.armForDrag(moving);
    snap.applySnap(0.2, 0, 'free');
    expect(visibleNamed(scene, '_layoutNeighborGuide')).toHaveLength(0);
    expect(visibleNamed(scene, '_layoutFootprint')).toHaveLength(0);
    snap.dispose();
  });
});
