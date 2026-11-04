// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-653 T3/T4 — transport surface and collision sensor on a SolidCraft node.
 *
 * SolidCraft bodies arrive with world quaternion −90° about X and world scale
 * 0.001 (mm geometry, local Z up). Before plan-653 their world AABB landed far
 * away from the visible mesh, so an MU in the scene root was never picked up by
 * a radial curve (`currentSurface: null`) and a sensor never switched.
 *
 * T3: a radial surface on such a node picks up an MU in the scene root and turns
 *     it about the node origin.
 * T4: a collision sensor on such a node reports occupied while an MU intersects
 *     its volume (and free while the MU is elsewhere).
 */

import { describe, it, expect } from 'vitest';
import { Object3D, Mesh, BoxGeometry, MeshBasicMaterial, Scene, Vector3 } from 'three';
import { AABB } from '../src/core/engine/rv-aabb';
import { RVMovingUnit } from '../src/core/engine/rv-mu';
import { RVTransportSurface } from '../src/core/engine/rv-transport-surface';
import { RVSensor } from '../src/core/engine/rv-sensor';
import { RVTransportManager } from '../src/core/engine/rv-transport-manager';
import type { ComponentContext } from '../src/core/engine/rv-component-registry';

const MM = 0.001;
const dt = 1 / 60;

function stubContext(): ComponentContext {
  return {
    registry: { findInParent: () => null } as unknown as ComponentContext['registry'],
    signalStore: null as unknown as ComponentContext['signalStore'],
    scene: null as unknown as ComponentContext['scene'],
    transportManager: { surfaces: [] } as unknown as ComponentContext['transportManager'],
    root: new Object3D(),
  };
}

/** SolidCraft-like body at `pos`: quaternion −90° X, scale 0.001, one mm box mesh. */
function makeSolidCraftNode(
  scene: Scene, name: string, pos: Vector3,
  boxMm: { min: [number, number, number]; max: [number, number, number] },
): Object3D {
  const node = new Object3D();
  node.name = name;
  node.position.copy(pos);
  node.quaternion.setFromAxisAngle(new Vector3(1, 0, 0), -Math.PI / 2);
  node.scale.setScalar(MM);
  const [x0, y0, z0] = boxMm.min;
  const [x1, y1, z1] = boxMm.max;
  const geo = new BoxGeometry(x1 - x0, y1 - y0, z1 - z0);
  geo.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  node.add(new Mesh(geo, new MeshBasicMaterial()));
  scene.add(node);
  scene.updateMatrixWorld(true);
  return node;
}

function createMU(name: string, x: number, y: number, z: number, half = 0.05): RVMovingUnit {
  const node = new Object3D();
  node.name = name;
  node.position.set(x, y, z);
  return new RVMovingUnit(node, 'test-source', new Vector3(half, half, half));
}

function makeManager(): RVTransportManager {
  const m = new RVTransportManager();
  m.scene = new Scene();
  return m;
}

describe('plan-653 T3 — radial transport surface on a scaled Z-up node', () => {
  it('picks up an MU in the scene root and turns it about the node origin', () => {
    const m = makeManager();
    const origin = new Vector3(2, 0, 1);
    // RM-8320-like quarter: 0..1440 × 0..1440 mm footprint, top at 750 mm.
    const node = makeSolidCraftNode(m.scene!, 'Curve', origin, { min: [0, 0, 748], max: [1440, 1440, 750] });

    const surface = new RVTransportSurface(node, AABB.fromNode(node));
    surface.Radial = true;
    surface.TransportDirection.set(0, 0, 1); // local Z (up in SolidCraft) = rotation axis
    surface.init(stubContext());
    surface.drive = { currentSpeed: 90, name: 'curve-drive' } as never; // 90 °/s
    m.surfaces.push(surface);

    // The world rotation axis is world +Y (local Z under −90° X).
    expect(surface.getWorldDirection().y).toBeCloseTo(1, 6);

    // MU resting on the curve top (y 0.75), 1.0 m out along +X, 0.2 m toward −Z.
    const mu = createMU('carton', origin.x + 1.0, 0.8, origin.z - 0.2);
    m.mus.push(mu);

    m.update(dt);
    expect(mu.currentSurface).toBe(surface);

    for (let i = 1; i < 30; i++) m.update(dt);
    expect(mu.currentSurface).toBe(surface);

    const p = mu.getPosition();
    const dx = p.x - origin.x;
    const dz = p.z - origin.z;
    // Radius about the node origin is preserved…
    expect(Math.hypot(dx, dz)).toBeCloseTo(Math.hypot(1.0, -0.2), 6);
    expect(p.y).toBeCloseTo(0.8, 9);
    // …and the MU swept ≈ 45° (30 ticks × 1.5°) about +Y.
    const a0 = Math.atan2(-(-0.2), 1.0);
    const a1 = Math.atan2(-dz, dx);
    const sweptDeg = (a1 - a0) * 180 / Math.PI;
    expect(sweptDeg).toBeGreaterThan(40);
    expect(sweptDeg).toBeLessThan(46);
  });
});

describe('plan-653 T4 — collision sensor on a scaled Z-up node', () => {
  function makeSensorScene(): { m: RVTransportManager; sensor: RVSensor } {
    const m = makeManager();
    // A 100 × 100 × 150 mm detection volume (local), 750..900 mm above the node origin.
    const node = makeSolidCraftNode(m.scene!, 'EndSensor', new Vector3(4, 0, -2), {
      min: [0, 0, 750], max: [100, 100, 900],
    });
    const sensor = new RVSensor(node, AABB.fromNode(node));
    sensor.invertSignal = false;
    sensor.UseRaycast = false;
    m.sensors.push(sensor);
    return { m, sensor };
  }

  it('reports occupied while an MU intersects the detection volume', () => {
    const { m, sensor } = makeSensorScene();
    // Volume in world: x 4..4.1, y 0.75..0.9, z −2.1..−2.
    m.mus.push(createMU('carton', 4.05, 0.8, -2.05, 0.02));
    m.update(dt);
    expect(sensor.occupied).toBe(true);
  });

  it('stays free while the MU is beside the volume', () => {
    const { m, sensor } = makeSensorScene();
    m.mus.push(createMU('carton', 4.5, 0.8, -2.05, 0.02));
    m.update(dt);
    expect(sensor.occupied).toBe(false);
  });
});
