// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2016 — vertical reach of a transport surface. A part released well above
 * a belt (blow-moulding line: GripperLeft_1 lets the barrel go 0.87 m above the garbage
 * conveyor while the deflash grip takes it) must NOT be captured by that belt;
 * the old XZ-only overlap test claimed it and the barrel left the deflash grip's
 * sensor. A part resting on (or just above) the belt is still carried.
 */
import { describe, it, expect } from 'vitest';
import { Object3D, Scene, Vector3 } from 'three';
import { AABB } from '../src/core/engine/rv-aabb';
import { RVMovingUnit } from '../src/core/engine/rv-mu';
import { RVTransportSurface } from '../src/core/engine/rv-transport-surface';
import { RVTransportManager } from '../src/core/engine/rv-transport-manager';

const DT = 1 / 60;
const TOP = 0.41;

function belt(): RVTransportSurface {
  const node = new Object3D();
  node.name = 'Garbage';
  node.position.set(0, TOP - 0.04, 0);
  node.updateMatrixWorld(true);
  const s = new RVTransportSurface(node, AABB.fromHalfSize(node, new Vector3(0.4, 0.04, 2.3)));
  s.TransportDirection.set(0, 0, 1);
  s.reapplyConfig();
  s.initTransport();
  s.drive = { currentSpeed: 300, name: 'drive' } as never;
  return s;
}

/** An MU with half height 0.4 m whose collider bottom sits `gap` m above the belt top. */
function muAbove(gap: number): RVMovingUnit {
  const node = new Object3D();
  node.name = 'Fass';
  node.position.set(0, TOP + gap + 0.4, 0);
  return new RVMovingUnit(node, 'test-source', new Vector3(0.3, 0.4, 0.3));
}

function run(gap: number, opts: { grid?: boolean; reach?: number; surfaceReachMm?: number } = {}) {
  const manager = new RVTransportManager();
  manager.scene = new Scene();
  if (opts.grid) manager.bruteForceThreshold = 0;
  if (opts.reach !== undefined) manager.surfaceVerticalReach = opts.reach;
  const s = belt();
  if (opts.surfaceReachMm !== undefined) s.VerticalReach = opts.surfaceReachMm;
  manager.surfaces.push(s);
  const mu = muAbove(gap);
  mu.updateAABB();
  manager.mus.push(mu);
  const start = mu.getPosition().clone();
  for (let i = 0; i < 30; i++) manager.update(DT);
  return { mu, s, start, end: mu.getPosition().clone() };
}

describe('plan-2016 — transport surface vertical reach', () => {
  for (const grid of [false, true]) {
    const tag = grid ? 'grid path' : 'brute-force path';

    it(`a part released 0.87 m above the belt is not taken over (${tag})`, () => {
      const { mu, start, end } = run(0.87, { grid });
      expect(mu.currentSurface).toBeNull();
      expect(end.distanceTo(start)).toBeLessThan(1e-9); // neither carried nor dropped
    });

    it(`a part resting on the belt (or a few cm above) is still carried (${tag})`, () => {
      for (const gap of [0, 0.03]) {
        const { mu, s, start, end } = run(gap, { grid });
        expect(mu.currentSurface).toBe(s);
        expect(end.z - start.z).toBeCloseTo(30 * DT * 0.3, 6);
        expect(end.y).toBeCloseTo(start.y - gap, 9); // captured parts settle onto the belt
      }
    });
  }

  it('the sticky fast path also drops a carried part that is lifted out of reach', () => {
    const manager = new RVTransportManager();
    manager.scene = new Scene();
    const s = belt();
    manager.surfaces.push(s);
    const mu = muAbove(0);
    mu.updateAABB();
    manager.mus.push(mu);
    manager.update(DT);
    expect(mu.currentSurface).toBe(s);
    const p = mu.getPosition().clone();
    p.y += 0.6;
    mu.setPosition(p);
    mu.updateAABB();
    manager.update(DT);
    expect(mu.currentSurface).toBeNull();
    expect(mu.getPosition().z).toBeCloseTo(p.z, 9);
  });

  it('surfaceVerticalReach = Infinity restores the XZ-only capture', () => {
    const { mu, s } = run(0.87, { reach: Infinity });
    expect(mu.currentSurface).toBe(s);
  });

  // Festo 2026-11-04: the EHPS let a box go 80 mm above the front belt, inside the default
  // 100 mm, and the belt carried it on in mid-air - so the drop detection saw it as carried.
  for (const grid of [false, true]) {
    const tag = grid ? 'grid path' : 'brute-force path';
    it(`a surface's own VerticalReach overrides the transport default (${tag})`, () => {
      expect(run(0.08, { grid }).mu.currentSurface, 'default 100 mm catches a part 80 mm up').not.toBeNull();
      const high = run(0.08, { grid, surfaceReachMm: 10 });
      expect(high.mu.currentSurface, 'VerticalReach 10 mm: 80 mm up is not caught').toBeNull();
      expect(high.end.distanceTo(high.start)).toBeLessThan(1e-9);
      const low = run(0.005, { grid, surfaceReachMm: 10 });
      expect(low.mu.currentSurface, 'VerticalReach 10 mm: 5 mm up is still carried').toBe(low.s);
    });
  }

  it('the sticky fast path honours the surface VerticalReach too', () => {
    const manager = new RVTransportManager();
    manager.scene = new Scene();
    const s = belt();
    s.VerticalReach = 10;
    manager.surfaces.push(s);
    const mu = muAbove(0);
    mu.updateAABB();
    manager.mus.push(mu);
    manager.update(DT);
    expect(mu.currentSurface).toBe(s);
    const p = mu.getPosition().clone();
    p.y += 0.05; // 50 mm: inside the default, outside this surface's 10 mm
    mu.setPosition(p);
    mu.updateAABB();
    manager.update(DT);
    expect(mu.currentSurface).toBeNull();
  });
});
