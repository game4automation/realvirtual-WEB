// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Regression tests for the review-driven simulation-engine fixes:
 *   #1  instanced MU linear transport writes back via setPosition
 *   #2  MUs attach to stopped (inactive) surfaces (turntable / pre-start hand-off)
 *   #3  reverse jog produces negative belt speed; reversed belt counts as active
 *   #5  acceleration ramps down when the target speed is lowered mid-motion
 *   #10a live-MU safety cap holds sources at the ceiling
 *   #4  grip auto-place rotation aligns to the GripTarget in world space
 */
import { describe, it, expect } from 'vitest';
import { Object3D, Vector3, Quaternion, Scene, MathUtils } from 'three';
import { AABB } from '../src/core/engine/rv-aabb';
import { RVMovingUnit } from '../src/core/engine/rv-mu';
import { RVTransportSurface } from '../src/core/engine/rv-transport-surface';
import { RVTransportManager } from '../src/core/engine/rv-transport-manager';
import { RVDrive } from '../src/core/engine/rv-drive';
import { RVGrip } from '../src/core/engine/rv-grip';
import { RVGripTarget } from '../src/core/engine/rv-grip-target';
import type { ComponentContext } from '../src/core/engine/rv-component-registry';

/** Minimal stub context — exercises transport math, not drives/registry. */
function stubContext(): ComponentContext {
  return {
    registry: { findInParent: () => null } as unknown as ComponentContext['registry'],
    signalStore: null as unknown as ComponentContext['signalStore'],
    scene: null as unknown as ComponentContext['scene'],
    transportManager: { surfaces: [] } as unknown as ComponentContext['transportManager'],
    root: new Object3D(),
  };
}

/** Build a TransportSurface on an identity node with a mock drive at a fixed speed.
 *  Uses full init() so `localDirection` is seeded (the lazy world-direction refresh
 *  derives `direction` from it on each new tick). */
function makeSurface(speed: number, dir = new Vector3(0, 0, 1)): RVTransportSurface {
  const node = new Object3D();
  node.updateMatrixWorld(true);
  const aabb = AABB.fromHalfSize(node, new Vector3(2, 0.1, 0.5));
  const surface = new RVTransportSurface(node, aabb);
  surface.TransportDirection.copy(dir);
  surface.Radial = false;
  surface.init(stubContext());
  surface.drive = { currentSpeed: speed, name: 'mock' } as unknown as RVDrive;
  return surface;
}

describe('FIX #1 — instanced MU linear transport writes back via setPosition', () => {
  it('advances an instanced-style MU whose getPosition() returns a temp copy', () => {
    const surface = makeSurface(1000); // 1000 mm/s = 1 m/s, +Z
    // Instanced contract: getPosition() returns a COPY, so mutating it in place is
    // lost — only setPosition() persists. The pre-fix code mutated the copy and
    // never wrote back, freezing instanced MUs on the belt.
    const stored = new Vector3(0, 0, 0);
    let setCalls = 0;
    const mu = {
      isInstanced: true,
      currentSurface: null,
      getPosition: () => stored.clone(),
      setPosition: (v: Vector3) => { stored.copy(v); setCalls++; },
      getQuaternion: () => new Quaternion(),
      setQuaternion: () => {},
    };
    for (let i = 0; i < 60; i++) {
      RVTransportSurface.beginTick(i + 1);
      surface.transportMU(mu as unknown as RVMovingUnit, 1 / 60);
    }
    expect(setCalls).toBeGreaterThan(0);   // write-back actually happened
    expect(stored.z).toBeCloseTo(1.0, 1);  // moved ~1 m in +Z
  });

  it('skips the position write entirely when the belt is stopped (speed 0)', () => {
    const surface = makeSurface(0);
    let setCalls = 0;
    const mu = {
      isInstanced: true,
      currentSurface: null,
      getPosition: () => new Vector3(),
      setPosition: () => { setCalls++; },
    };
    RVTransportSurface.beginTick(1);
    surface.transportMU(mu as unknown as RVMovingUnit, 1 / 60);
    expect(setCalls).toBe(0);
  });
});

describe('FIX #2 — MUs attach to stopped (inactive) surfaces', () => {
  it('attaches an overlapping MU to a stopped surface (so it can be carried / restarted)', () => {
    const manager = new RVTransportManager();
    manager.scene = new Scene();
    const surface = makeSurface(0); // stopped belt
    manager.surfaces.push(surface);

    const mu = new RVMovingUnit(new Object3D(), 'src', new Vector3(0.05, 0.05, 0.05));
    manager.mus.push(mu);

    expect(surface.isActive).toBe(false);
    manager.update(1 / 60);
    expect(mu.currentSurface).toBe(surface); // attached despite being stopped
  });
});

describe('FIX #3 — reverse jog produces negative speed', () => {
  it('jogBackward sets a negative currentSpeed', () => {
    const drive = new RVDrive(new Object3D());
    drive.targetSpeed = 200;
    drive.jogBackward = true;
    drive.update(1 / 60);
    expect(drive.currentSpeed).toBe(-200);
  });

  it('jogForward keeps a positive currentSpeed', () => {
    const drive = new RVDrive(new Object3D());
    drive.targetSpeed = 200;
    drive.jogForward = true;
    drive.update(1 / 60);
    expect(drive.currentSpeed).toBe(200);
  });

  it('a reversed belt (negative speed) still counts as active', () => {
    const surface = makeSurface(-200);
    expect(surface.speed).toBe(-200);
    expect(surface.isActive).toBe(true);
  });
});

describe('FIX #5 — acceleration ramps down when target speed is lowered mid-motion', () => {
  it('reduces currentSpeed toward the lower target instead of holding it', () => {
    const drive = new RVDrive(new Object3D());
    drive.UseAcceleration = true;
    drive.Acceleration = 100;
    drive.targetSpeed = 200;     // target was just lowered…
    drive.currentSpeed = 500;    // …while we were running faster
    drive.currentPosition = 0;
    drive.targetPosition = 5000; // far enough that we are NOT yet in the braking zone
    drive.isRunning = true;
    drive.update(1 / 60);
    expect(drive.currentSpeed).toBeLessThan(500);
    expect(drive.currentSpeed).toBeGreaterThanOrEqual(200);
  });
});

describe('FIX #10a — live-MU safety cap holds sources at the ceiling', () => {
  function makeFakeSource(record: (enabled: boolean) => void) {
    return {
      node: new Object3D(),
      update: (_dt: number, enabled: boolean) => { record(enabled); return null; },
    } as unknown as never;
  }

  it('passes spawningEnabled=false to sources once the cap is reached', () => {
    const manager = new RVTransportManager();
    manager.scene = new Scene();
    manager.setSpawnEnabled(true);
    manager.maxLiveMUs = 2;
    let lastEnabled: boolean | undefined;
    manager.sources.push(makeFakeSource((e) => { lastEnabled = e; }));
    manager.mus.push(
      new RVMovingUnit(new Object3D(), 's', new Vector3(0.05, 0.05, 0.05)),
      new RVMovingUnit(new Object3D(), 's', new Vector3(0.05, 0.05, 0.05)),
    );
    manager.update(1 / 60);
    expect(lastEnabled).toBe(false);
  });

  it('lets sources spawn while below the cap', () => {
    const manager = new RVTransportManager();
    manager.scene = new Scene();
    manager.setSpawnEnabled(true);
    manager.maxLiveMUs = 5;
    let lastEnabled: boolean | undefined;
    manager.sources.push(makeFakeSource((e) => { lastEnabled = e; }));
    manager.update(1 / 60);
    expect(lastEnabled).toBe(true);
  });
});

describe('FIX #4 — grip auto-place rotation aligns in world space', () => {
  it('places the MU at the GripTarget world rotation even under a rotated parent', () => {
    const scene = new Scene();
    // Intermediate parent the MU is re-parked under during unfix() — rotated 90° Y.
    const interim = new Object3D(); interim.rotation.y = MathUtils.degToRad(90); scene.add(interim);
    // GripTarget with a non-trivial world rotation, near the origin.
    const tParent = new Object3D(); tParent.rotation.y = MathUtils.degToRad(30); scene.add(tParent);
    const tNode = new Object3D(); tNode.rotation.y = MathUtils.degToRad(15); tNode.position.set(0.1, 0, 0); tParent.add(tNode);
    scene.updateMatrixWorld(true);
    const target = new RVGripTarget(tNode);
    target.AlignPosition = true;
    target.AlignRotation = true;

    const muNode = new Object3D(); scene.add(muNode);
    const mu = new RVMovingUnit(muNode, 'src', new Vector3(0.05, 0.05, 0.05));
    mu.parentBeforeGrip = interim;
    mu.heldBy = 'grip';

    const grip = new RVGrip(new Object3D());
    scene.add(grip.node);
    (grip as unknown as { allGripTargets: () => RVGripTarget[] }).allGripTargets = () => [target];
    grip.PlaceMode = 'Auto';
    grip.GripTargetSearchRadius = 100000;
    grip.grippedMUs.push(mu);
    scene.updateMatrixWorld(true);

    grip.place();

    const muQ = new Quaternion(); muNode.getWorldQuaternion(muQ);
    const tQ = new Quaternion(); tNode.getWorldQuaternion(tQ);
    expect(muQ.angleTo(tQ)).toBeLessThan(1e-4); // orientation matches the target

    const muP = new Vector3(); muNode.getWorldPosition(muP);
    const tP = new Vector3(); tNode.getWorldPosition(tP);
    expect(muP.distanceTo(tP)).toBeLessThan(1e-4); // position matches the target
  });
});
