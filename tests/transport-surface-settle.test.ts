// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
import { describe, it, expect } from 'vitest';
import { BoxGeometry, MeshBasicMaterial, Object3D, Quaternion, Scene, Vector3 } from 'three';
import { AABB } from '../src/core/engine/rv-aabb';
import { MUInstancePool, RVMovingUnit } from '../src/core/engine/rv-mu';
import { RVTransportManager } from '../src/core/engine/rv-transport-manager';
import { RVTransportSurface } from '../src/core/engine/rv-transport-surface';

const DT = 1 / 120;
const TOP = 0.86;
function fixture(gap = 0.08, instanced = false) {
  const manager = new RVTransportManager();
  manager.scene = new Scene();
  const node = new Object3D();
  node.position.y = TOP - 0.04;
  const surface = new RVTransportSurface(node, AABB.fromHalfSize(node, new Vector3(2, 0.04, 2)));
  surface.TransportDirection.set(0, 0, 1);
  surface.reapplyConfig();
  surface.initTransport();
  surface.drive = { currentSpeed: 300 } as never;
  manager.surfaces.push(surface);
  const muNode = new Object3D();
  muNode.position.set(0, TOP + gap + 0.05, 0);
  const pool = instanced ? new MUInstancePool(new BoxGeometry(0.1, 0.1, 0.1), new MeshBasicMaterial(), 'box', new Vector3(0.05, 0.05, 0.05)) : null;
  const mu = pool ? pool.spawn(muNode.position, new Quaternion(), 'box', 'test') : new RVMovingUnit(muNode, 'test', new Vector3(0.05, 0.05, 0.05));
  mu.updateAABB();
  manager.mus.push(mu);
  const tick = (n = 1) => { for (let i = 0; i < n; i++) manager.update(DT); };
  return { manager, surface, mu, tick, pool };
}

describe('kinematic transport surface settle', () => {
  for (const instanced of [false, true]) {
    it(`80 mm descends with gravity and lands without overshoot (${instanced ? 'instance' : 'clone'})`, () => {
      const { mu, surface, tick, pool } = fixture(0.08, instanced);
      let elapsed = 0;
      let lastGap = 0.08;
      while (elapsed < 0.3 && mu.aabb.min.y - TOP > 1e-6) {
        tick(); elapsed += DT;
        const gap = mu.aabb.min.y - TOP;
        expect(gap).toBeGreaterThanOrEqual(-1e-6);
        expect(gap).toBeLessThan(lastGap + 1e-6);
        lastGap = gap;
      }
      expect(elapsed).toBeGreaterThan(0.10);
      expect(elapsed).toBeLessThan(0.15); // sqrt(2 * .08 / 9.81) = .128 s
      expect(mu.aabb.min.y).toBeCloseTo(TOP, 6);
      expect(mu.currentSurface).toBe(surface);
      expect(mu.settleSpeed).toBe(0);
      tick(30);
      expect(mu.aabb.min.y).toBeCloseTo(TOP, 6);
      pool?.dispose();
    });
    for (const gap of [0, 0.0004, 0.101]) {
      it(`leaves gap ${gap} unchanged (instance=${instanced})`, () => {
        const { mu, tick, pool } = fixture(gap, instanced);
        const y = mu.getPosition().y;
        tick(30);
        expect(mu.getPosition().y).toBe(y);
        if (gap > 0.1) expect(mu.currentSurface).toBeNull();
        pool?.dispose();
      });
    }
  }
  it('off switch preserves the old floating transport', () => {
    const { manager, mu, tick } = fixture();
    manager.settleEnabled = false;
    tick(30);
    expect(mu.aabb.min.y - TOP).toBeCloseTo(0.08, 9);
    expect(mu.getPosition().z).toBeGreaterThan(0);
  });
  for (const owner of ['rapier', 'box2d'] as const) {
    it(`does not move a ${owner}-owned MU`, () => {
      const { mu, tick } = fixture();
      mu.owner = owner;
      tick(30);
      expect(mu.aabb.min.y - TOP).toBeCloseTo(0.08, 9);
    });
  }
  for (const kind of ['grip', 'zone'] as const) {
    it(`resets a fall while ${kind}-held and restarts from rest`, () => {
      const { mu, tick } = fixture();
      if (mu.isInstanced) throw new Error('clone required');
      tick(4);
      mu.heldBy = { kind } as never;
      const y = mu.getPosition().y;
      tick(10);
      expect(mu.getPosition().y).toBe(y);
      expect(mu.settleSpeed).toBe(0);
      mu.heldBy = null;
      tick();
      expect(y - mu.getPosition().y).toBeCloseTo(9.81 * DT * DT, 9);
    });
  }
  it('does not settle passive loads', () => {
    const { mu, tick } = fixture();
    if (mu.isInstanced) throw new Error('clone required');
    mu.loadedOn = new RVMovingUnit(new Object3D(), 'carrier', new Vector3(1, 1, 1));
    tick(10);
    expect(mu.aabb.min.y - TOP).toBeCloseTo(0.08, 9);
  });
  for (const radial of [false, true]) {
    it(`skips ${radial ? 'radial' : 'inclined'} surfaces`, () => {
      const { surface, mu, tick } = fixture();
      surface.drive = null; // isolate settle from the ramp/radial transport motion
      if (radial) surface.Radial = true;
      else surface.node.rotation.z = 0.01;
      tick(30);
      expect(mu.currentSurface).toBe(surface);
      expect(mu.aabb.min.y - TOP).toBeCloseTo(0.08, 9);
    });
  }
  it('settles on a Z-up CAD surface whose local X is vertical (Festo belts)', () => {
    const manager = new RVTransportManager();
    manager.scene = new Scene();
    const node = new Object3D();
    node.rotation.z = -Math.PI / 2; // local X -> world -Y, local Y -> world +X
    node.position.y = TOP - 0.04;
    node.updateMatrixWorld(true);
    const surface = new RVTransportSurface(node, AABB.fromHalfSize(node, new Vector3(2, 0.04, 2)));
    surface.TransportDirection.set(0, 0, 1);
    surface.reapplyConfig();
    surface.initTransport();
    surface.drive = { currentSpeed: 300 } as never;
    manager.surfaces.push(surface);
    const muNode = new Object3D();
    muNode.position.set(0, TOP + 0.08 + 0.05, 0);
    const mu = new RVMovingUnit(muNode, 'test', new Vector3(0.05, 0.05, 0.05));
    mu.updateAABB();
    manager.mus.push(mu);
    expect(surface.aabb.max.y).toBeCloseTo(TOP, 6);
    for (let i = 0; i < 60; i++) manager.update(DT);
    expect(mu.currentSurface).toBe(surface);
    expect(mu.aabb.min.y).toBeCloseTo(TOP, 6);
  });
  it('resets velocity when the surface changes or is left', () => {
    const { manager, surface, mu, tick } = fixture();
    tick(4);
    const replacement = new RVTransportSurface(surface.node, surface.aabb);
    manager.surfaces.splice(0, 1, replacement);
    const y = mu.getPosition().y;
    tick();
    expect(y - mu.getPosition().y).toBeCloseTo(9.81 * DT * DT, 9);
    manager.surfaces.length = 0;
    tick();
    expect(mu.settleSpeed).toBe(0);
    expect(mu.settleSurface).toBeNull();
  });
  it('skips custom transport paths, including guided curves with their own height contract', () => {
    const { surface, mu, tick } = fixture();
    class GuidedSurface extends RVTransportSurface {
      override transportMU(): void { /* custom guide owns the pose */ }
    }
    Object.setPrototypeOf(surface, GuidedSurface.prototype);
    tick(30);
    expect(mu.currentSurface).toBe(surface);
    expect(mu.aabb.min.y - TOP).toBeCloseTo(0.08, 9);
  });
  it('uses world vertical under a rotated and scaled MU parent', () => {
    const { mu, tick } = fixture();
    const parent = new Object3D();
    parent.rotation.z = 0.3;
    parent.scale.setScalar(2);
    parent.updateMatrixWorld(true);
    parent.attach(mu.node);
    mu.updateAABB();
    tick(30);
    expect(mu.aabb.min.y).toBeCloseTo(TOP, 6);
  });

  // Codex review 2026-11-04: placeOnGripTarget sets neither heldBy nor loadedOn, so a
  // part seated on a target above a belt was pulled 80 mm down out of its seat.
  it('never settles a part seated on a GripTarget', () => {
    const { manager, mu, tick } = fixture(0.08);
    manager.gripTargets.push({ occupiedBy: mu } as never);
    tick(30);
    expect(mu.aabb.min.y - TOP).toBeCloseTo(0.08, 9);
    expect(mu.settleSpeed).toBe(0);
  });

  it('a simulation reset forgets the carriage history of a pre-placed part', () => {
    const { manager, mu } = fixture(0);
    const clone = mu as RVMovingUnit;
    clone.snapshot = { parent: manager.scene!, position: clone.node.position.clone(), quaternion: clone.node.quaternion.clone(), scale: clone.node.scale.clone() } as never;
    manager.registerPreplaced(clone, manager.scene!);
    clone.wasCarried = true;
    clone.unsupportedTime = 3;
    manager.restorePreplaced(false);
    expect(clone.wasCarried).toBeUndefined();
    expect(clone.unsupportedTime).toBeUndefined();
  });
});
