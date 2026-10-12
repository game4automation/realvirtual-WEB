// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * zone-block.test.ts — plan-521 §9.2: the Block effect on the shared swept-AABB
 * kernel, Block+Detect as a singulator, two zones in a row, and the parity of
 * the kernel extracted from TransportStopper.
 */

import { describe, it, expect } from 'vitest';
import { Object3D, Scene, Vector3 } from 'three';
import { RVZone } from '../src/core/engine/rv-zone';
import { sweptClamp } from '../src/core/engine/rv-swept-aabb';
import { RVTransportStopper } from '../src/core/engine/rv-transport-stopper';
import { RVWaitForZone, StepState } from '../src/core/engine/rv-logic-step';
import { AABB } from '../src/core/engine/rv-aabb';
import { RVMovingUnit } from '../src/core/engine/rv-mu';
import { RVTransportSurface } from '../src/core/engine/rv-transport-surface';
import { RVTransportManager } from '../src/core/engine/rv-transport-manager';

const DT = 1 / 60;
const MU_HALF = new Vector3(0.05, 0.05, 0.05);

function createMU(name: string, x: number, y: number, z: number): RVMovingUnit {
  const node = new Object3D();
  node.name = name;
  node.position.set(x, y, z);
  return new RVMovingUnit(node, 'test-source', MU_HALF.clone());
}

function createSurface(x: number, speed: number, halfX = 2): RVTransportSurface {
  const node = new Object3D();
  node.position.set(x, 0, 0);
  const surface = new RVTransportSurface(node, AABB.fromHalfSize(node, new Vector3(halfX, 0.1, 0.5)));
  surface.TransportDirection.set(1, 0, 0);
  surface.Radial = false;
  surface.TextureScale = 1;
  surface.HeightOffsetOverride = 0;
  surface.reapplyConfig();
  surface.initTransport();
  surface.drive = { currentSpeed: speed, name: 'mock-drive' } as unknown as RVTransportSurface['drive'];
  return surface;
}

function setSpeed(surface: RVTransportSurface, speed: number): void {
  (surface.drive as unknown as { currentSpeed: number }).currentSpeed = speed;
}

function createManager(): RVTransportManager {
  const m = new RVTransportManager();
  m.scene = new Scene();
  return m;
}

/** A 20 mm thick Block zone across the belt at world x, on its own axis node. */
function blockZone(manager: RVTransportManager, x: number, detect = false): { zone: RVZone; axis: Object3D } {
  const axis = new Object3D();
  axis.position.set(x, 0, 0);
  const zone = new RVZone(axis);
  zone.Size.set(20, 300, 300);
  zone.Block = true;
  zone.Detect = detect;
  manager.zones.add(zone);
  return { zone, axis };
}

function run(manager: RVTransportManager, ticks: number): void {
  for (let i = 0; i < ticks; i++) manager.update(DT);
}

describe('Zone Block (F5)', () => {
  it('an active Block zone stops a 5 m/s part before contact (no tunnelling); an inactive one lets it pass', () => {
    const manager = createManager();
    manager.surfaces.push(createSurface(0, 5000));
    const { zone } = blockZone(manager, 1);
    const mu = createMU('fast', -1.5, 0, 0);
    manager.mus.push(mu);
    run(manager, 60);
    // Zone front face at x = 0.99; the part's leading face stops 0.1 mm short.
    expect(mu.aabb.max.x).toBeLessThanOrEqual(0.99);
    expect(mu.aabb.max.x).toBeGreaterThan(0.989);
    expect(mu.blocked).toBe(true);

    zone.Activation = 'Signal'; // no signal wired → inactive
    run(manager, 10);
    expect(mu.aabb.min.x).toBeGreaterThan(1.01);
  });

  it('a box coming down onto a part does not trap it (pre-overlap rule)', () => {
    const manager = createManager();
    manager.surfaces.push(createSurface(0, 500));
    const { axis } = blockZone(manager, 0);
    axis.position.y = 1; // raised clear
    const mu = createMU('under', 0, 0, 0);
    manager.mus.push(mu);
    run(manager, 1);
    axis.position.y = 0; // lowered onto the part while it passes below
    run(manager, 30);
    expect(mu.aabb.min.x).toBeGreaterThan(0.01);
  });

  it('Block + Detect singulator: stopped part is occupied, WaitForZone ends, stays occupied after a belt stop, free once removed', () => {
    const manager = createManager();
    const belt = createSurface(0, 500);
    manager.surfaces.push(belt);
    const { zone } = blockZone(manager, 1, true);
    const wait = new RVWaitForZone(zone, true);
    wait.start();
    expect(wait.state).toBe(StepState.Waiting);
    const mu = createMU('part', 0, 0, 0);
    manager.mus.push(mu);
    run(manager, 180);
    expect(mu.blocked).toBe(true);
    expect(zone.occupied).toBe(true);
    wait.fixedUpdate(DT);
    expect(wait.state).toBe(StepState.Finished);

    setSpeed(belt, 0); // belt stops: the clamp no longer runs, contact is geometric
    run(manager, 30);
    expect(zone.occupied).toBe(true);

    manager.removeMU(mu);
    run(manager, 1);
    expect(zone.occupied).toBe(false);
  });

  it('two Block zones in a row, both registration orders: only the touched one reports occupied', () => {
    for (const order of ['front-first', 'back-first'] as const) {
      const manager = createManager();
      manager.surfaces.push(createSurface(0, 500));
      const front = new Object3D(); front.position.set(0.8, 0, 0);
      const back = new Object3D(); back.position.set(1.2, 0, 0);
      const mk = (n: Object3D): RVZone => {
        const z = new RVZone(n);
        z.Size.set(20, 300, 300);
        z.Block = true;
        return z;
      };
      const zf = mk(front);
      const zb = mk(back);
      if (order === 'front-first') { manager.zones.add(zf); manager.zones.add(zb); }
      else { manager.zones.add(zb); manager.zones.add(zf); }
      manager.mus.push(createMU('part', 0, 0, 0));
      run(manager, 180);
      expect(zf.occupied, order).toBe(true);
      expect(zb.occupied, order).toBe(false);
    }
  });
});

describe('swept-AABB kernel parity (Phase 2)', () => {
  it('RVTransportStopper.clampTravel is exactly sweptClamp over its bounds', () => {
    const node = new Object3D();
    node.position.set(0.5, 0.1, 0.2);
    node.rotation.y = 0.3;
    const stopper = new RVTransportStopper(node);
    stopper.Size.set(40, 120, 90);
    stopper.updateBounds();
    const dirs = [new Vector3(1, 0, 0), new Vector3(-1, 0, 0), new Vector3(0, 0, 1), new Vector3(1, 0, 1).normalize()];
    let seed = 7;
    const rnd = (): number => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    for (let i = 0; i < 400; i++) {
      const mu = createMU('m', rnd() * 2 - 0.5, rnd() * 0.3 - 0.1, rnd() * 1 - 0.3);
      const dir = dirs[i % dirs.length];
      const dist = rnd() * 2;
      expect(stopper.clampTravel(mu.aabb, dir, dist)).toBe(sweptClamp(stopper.bounds, mu.aabb, dir, dist));
    }
  });
});
