// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * mu-load.test.ts — plan-516 §9.3: collider-based passive loads (F2/F3).
 *
 * An MU whose collider bottom rests on another MU's collider top (±5 mm, XZ
 * centre inside) becomes that MU's passive load: a child of the carrier's
 * node, NOT in `mus`, never ticked. Any number of loads per carrier; stacks
 * resolve to the nearest MU below.
 */

import { describe, it, expect } from 'vitest';
import { Object3D, Vector3 } from 'three';
import { AABB } from '../src/core/engine/rv-aabb';
import { RVTransportSurface } from '../src/core/engine/rv-transport-surface';
import { LOAD_TOLERANCE_MM, resolveLoads } from '../src/core/engine/rv-mu-load';
import {
  PALLET, PART, classifiedScene, muNode, muOf, palletRow, preplacedMU, worldPos,
} from './_mu-preplaced-fixture';

const DT = 1 / 60;

function createSurface(x: number, y: number, halfSize: Vector3, speed: number): RVTransportSurface {
  const node = new Object3D();
  node.position.set(x, y, 0);
  const aabb = AABB.fromHalfSize(node, halfSize);
  const surface = new RVTransportSurface(node, aabb);
  surface.TransportDirection.set(1, 0, 0);
  surface.Radial = false;
  surface.TextureScale = 1;
  surface.HeightOffsetOverride = 0;
  surface.reapplyConfig();
  surface.initTransport();
  surface.drive = { currentSpeed: speed, name: 'mock-drive' } as unknown as RVTransportSurface['drive'];
  return surface;
}

describe('pre-placed loads by collider (plan-516 F2/F3)', () => {
  it('a product resting on a pallet becomes its load and is not in mus', () => {
    const { root, pallets, parts } = palletRow(1, 1);
    const { tm } = classifiedScene(root);
    expect(tm.activatePreplaced()).toBe(1);
    const pallet = muOf(tm, pallets[0]);
    const part = muOf(tm, parts[0][0]);
    expect(tm.mus).toEqual([pallet]);
    expect(part.loadedOn).toBe(pallet);
    expect(pallet.loadedMus).toEqual([part]);
    expect(part.node.parent).toBe(pallet.node);
    // world pose unchanged by the re-parent
    expect(worldPos(part.node).y).toBeCloseTo(PALLET[1], 6);
  });

  it('a tray with 4 MUs carries all four', () => {
    const { root, pallets } = palletRow(1, 4);
    const { tm } = classifiedScene(root);
    tm.activatePreplaced();
    expect(muOf(tm, pallets[0]).loadedMus.length).toBe(4);
    expect(tm.mus.length).toBe(1);
  });

  it('14 carriers with 3 loads each → mus.length === 14', () => {
    const { root } = palletRow(14, 3);
    const { tm } = classifiedScene(root);
    expect(tm.preplacedMUs.length).toBe(14 * 4);
    tm.activatePreplaced();
    expect(tm.mus.length).toBe(14);
    for (const mu of tm.mus) expect((mu as { loadedMus: unknown[] }).loadedMus.length).toBe(3);
  });

  it('a third stack level rests on the MU directly below it', () => {
    const root = new Object3D();
    const pallet = muNode('Pallet', PALLET, [0, 0, 0]);
    const a = muNode('A', PART, [0, PALLET[1], 0]);
    const b = muNode('B', PART, [0, PALLET[1] + PART[1], 0]);
    const c = muNode('C', PART, [0, PALLET[1] + 2 * PART[1], 0]);
    root.add(pallet, a, b, c);
    const { tm } = classifiedScene(root);
    tm.activatePreplaced();
    expect(tm.mus.length).toBe(1);
    expect(muOf(tm, a).loadedOn).toBe(muOf(tm, pallet));
    expect(muOf(tm, b).loadedOn).toBe(muOf(tm, a));
    expect(muOf(tm, c).loadedOn).toBe(muOf(tm, b));
    expect(c.parent).toBe(b);
  });

  it(`more than ${LOAD_TOLERANCE_MM} mm above the carrier stays free, within it is a load`, () => {
    const root = new Object3D();
    const pallet = muNode('Pallet', PALLET, [0, 0, 0]);
    const far = muNode('Far', PART, [-0.2, PALLET[1] + 0.006, 0]);
    const near = muNode('Near', PART, [0.2, PALLET[1] + 0.004, 0]);
    root.add(pallet, far, near);
    const { tm } = classifiedScene(root);
    tm.activatePreplaced();
    expect(muOf(tm, far).loadedOn).toBeNull();
    expect(tm.mus).toContain(muOf(tm, far));
    expect(muOf(tm, near).loadedOn).toBe(muOf(tm, pallet));
  });

  it('XZ centre outside the carrier footprint stays free', () => {
    const root = new Object3D();
    const pallet = muNode('Pallet', PALLET, [0, 0, 0]);
    const beside = muNode('Beside', PART, [0.35, PALLET[1], 0]); // centre x 0.35 > half 0.3
    root.add(pallet, beside);
    const { tm } = classifiedScene(root);
    tm.activatePreplaced();
    expect(muOf(tm, beside).loadedOn).toBeNull();
  });

  it('pallet on a belt and on a lift: the load world pose follows 1:1, the load is never ticked', () => {
    const { root, pallets, parts } = palletRow(1, 1);
    const { tm } = classifiedScene(root);
    const surface = createSurface(0, -0.05, new Vector3(3, 0.05, 0.5), 500);
    tm.surfaces.push(surface);
    tm.activatePreplaced();
    const pallet = muOf(tm, pallets[0]);
    const part = muOf(tm, parts[0][0]);
    const p0 = worldPos(pallet.node);
    const l0 = worldPos(part.node);
    for (let i = 0; i < 60; i++) tm.update(DT);
    const p1 = worldPos(pallet.node);
    const l1 = worldPos(part.node);
    expect(p1.x - p0.x).toBeGreaterThan(0.3); // the belt moved the pallet
    expect(l1.x - l0.x).toBeCloseTo(p1.x - p0.x, 6);
    expect(l1.y - l0.y).toBeCloseTo(p1.y - p0.y, 6);
    expect(part.currentSurface).toBeNull(); // passive: never picked up by a surface
    expect(tm.mus).not.toContain(part);

    // Lift: the carrier's parent moves up — the load follows through the graph.
    const lift = new Object3D();
    (pallet.node.parent as Object3D).add(lift);
    lift.attach(pallet.node);
    lift.position.y += 0.5;
    expect(worldPos(part.node).y - l1.y).toBeCloseTo(0.5, 6);
  });

  it('1000 MUs resolve in measured time (logged, not asserted tight)', () => {
    const { root } = palletRow(250, 3);
    root.updateMatrixWorld(true);
    const mus = [];
    for (const child of root.children) mus.push(preplacedMU(child));
    expect(mus.length).toBe(1000);
    const t0 = performance.now();
    const free = resolveLoads(mus, null);
    const ms = performance.now() - t0;
    console.log(`[plan-516] resolveLoads(1000 MUs) = ${ms.toFixed(2)} ms`);
    expect(free.length).toBe(250);
    expect(ms).toBeLessThan(2000); // sanity bound only; target < 50 ms
  });
});
