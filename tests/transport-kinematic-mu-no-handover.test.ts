// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Object3D, Scene, Vector3 } from 'three';
import { AABB } from '../src/core/engine/rv-aabb';
import type { ComponentContext } from '../src/core/engine/rv-component-registry';
import { RVMovingUnit } from '../src/core/engine/rv-mu';
import { physicsRegistry, physicsSettings, type PhysicsProvider } from '../src/core/engine/rv-physics-registry';
import { RVPhysicsZone } from '../src/core/engine/rv-physics-zone';
import { RVTransportManager } from '../src/core/engine/rv-transport-manager';
import { RVTransportSurface } from '../src/core/engine/rv-transport-surface';

class MockProvider implements PhysicsProvider {
  ready = true;
  failed = false;
  onSensorEvent = null;
  async init(): Promise<void> {}
  dispose(): void {}
  addZone(): void {}
  addStaticBox(): void {}
  addConveyor(): void {}
  setConveyorVelocity(): void {}
  addDynamicMU = vi.fn<PhysicsProvider['addDynamicMU']>();
  removeBody(): void {}
  addSensorBox(): void {}
  castRay(): null { return null; }
  step(): void {}
  syncPoses(): void {}
  getSettledBodies(): string[] { return []; }
  addKinematicBody(): void {}
  setKinematicPose(): void {}
  forEachContactLoad(): void {}
}

let provider: MockProvider;
const previousSettings = { enabled: physicsSettings.enabled, full: physicsSettings.full };

beforeEach(() => {
  RVPhysicsZone.clearAll();
  provider = new MockProvider();
  physicsRegistry.register(provider);
  physicsSettings.enabled = true;
  physicsSettings.full = false;
});

afterEach(() => {
  RVPhysicsZone.clearAll();
  physicsRegistry.register(null);
  physicsSettings.enabled = previousSettings.enabled;
  physicsSettings.full = previousSettings.full;
});

function setup(): { manager: RVTransportManager; mu: RVMovingUnit } {
  const manager = new RVTransportManager();
  manager.scene = new Scene();

  const zoneNode = new Object3D();
  zoneNode.position.set(0, 0.5, 0);
  zoneNode.updateMatrixWorld(true);
  const zone = new RVPhysicsZone(zoneNode, AABB.fromBoxCollider(
    zoneNode, { x: 0, y: 0, z: 0 }, { x: 2, y: 2, z: 5 },
  ));
  zone.ShowGizmo = false;
  zone.init({ gizmoManager: undefined } as unknown as ComponentContext);

  const node = new Object3D();
  node.name = 'PreplacedBox';
  node.position.set(0, 0.1, 0);
  // The model-load plugin stamps authored kinematic Rigidbody + BoxColliders.
  node.userData.physicsBody = {
    isKinematic: true,
    shapes: [{
      kind: 'cuboid',
      halfExtents: { x: 0.05, y: 0.05, z: 0.05 },
      localOffset: { x: 0, y: 0, z: 0 },
    }],
  };
  node.updateMatrixWorld(true);
  const mu = new RVMovingUnit(node, 'preplaced', new Vector3(0.05, 0.05, 0.05));
  mu.updateAABB();
  manager.mus.push(mu);
  return { manager, mu };
}

describe('authored kinematic MUs never hand over to dynamic physics', () => {
  it('keeps a stamped MU on a PhysicsMode surface; removing the stamp allows handover', () => {
    const { manager, mu } = setup();
    const node = new Object3D();
    node.name = 'PhysicsBelt';
    node.updateMatrixWorld(true);
    const surface = new RVTransportSurface(node, AABB.fromHalfSize(node, new Vector3(0.4, 0.05, 2)));
    surface.PhysicsMode = true;
    surface.TransportDirection.set(0, 0, -1);
    surface.Radial = false;
    surface.TextureScale = 1;
    surface.HeightOffsetOverride = 0;
    surface.reapplyConfig();
    surface.initTransport();
    surface.drive = { currentSpeed: 0, name: 'test-drive' } as unknown as RVTransportSurface['drive'];
    manager.surfaces.push(surface);
    // Simulate the plugin marking this surface as fully inside the zone.
    manager.physicsManagedSurfaces = new Set([surface]);

    for (let tick = 0; tick < 3; tick++) manager.update(1 / 60);

    expect(mu.currentSurface).toBe(surface);
    expect(mu.owner).toBe('transport');
    expect(mu.physicsBodyId).toBeNull();
    expect(provider.addDynamicMU).not.toHaveBeenCalled();

    delete mu.node.userData.physicsBody;
    manager.update(1 / 60);

    expect(mu.owner).toBe('rapier');
    expect(provider.addDynamicMU).toHaveBeenCalledTimes(1);
    expect(provider.addDynamicMU.mock.calls[0][0]).toBe(String(mu.id));
  });

  it('also excludes the stamped MU from explicit and no-driver zone handover', () => {
    const { manager, mu } = setup();

    expect(manager.tryHandoverToPhysics(mu)).toBe(false);
    manager.update(1 / 60);
    expect(mu.owner).toBe('transport');
    expect(provider.addDynamicMU).not.toHaveBeenCalled();

    // An authored dynamic Rigidbody still takes the early free-fall path.
    mu.node.userData.physicsBody.isKinematic = false;
    manager.update(1 / 60);
    expect(mu.owner).toBe('rapier');
    expect(provider.addDynamicMU).toHaveBeenCalledTimes(1);
  });
});
