// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Transport Simulation Tests
 *
 * Tests the transport surface, sensor, source, sink, and MU lifecycle.
 * Runs in browser via Vitest + Playwright (like glb-extras.test.ts).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { Object3D, Vector3, Scene } from 'three';
import { AABB } from '../src/core/engine/rv-aabb';
import { RVMovingUnit } from '../src/core/engine/rv-mu';
import { RVTransportSurface } from '../src/core/engine/rv-transport-surface';
import { RVSensor } from '../src/core/engine/rv-sensor';
import { RVSink } from '../src/core/engine/rv-sink';
import { RVTransportManager } from '../src/core/engine/rv-transport-manager';

// ─── Helpers ──────────────────────────────────────────────────────

function createMU(name: string, x: number, y: number, z: number): RVMovingUnit {
  const node = new Object3D();
  node.name = name;
  node.position.set(x, y, z);
  return new RVMovingUnit(node, 'test-source', new Vector3(0.05, 0.05, 0.05));
}

function createSurface(
  x: number, y: number, z: number,
  halfSize: Vector3,
  direction: Vector3,
  speed: number,
): RVTransportSurface {
  const node = new Object3D();
  node.position.set(x, y, z);

  const aabb = AABB.fromHalfSize(node, halfSize);
  const surface = new RVTransportSurface(node, aabb);
  surface.TransportDirection.copy(direction);
  surface.Radial = false;
  surface.TextureScale = 1;
  surface.HeightOffsetOverride = 0;
  surface.initTransport();

  // Mock drive with configurable speed (currentSpeed is what TransportSurface reads)
  surface.drive = {
    currentSpeed: speed,
    name: 'mock-drive',
  } as any;

  return surface;
}

function createSensor(x: number, y: number, z: number, halfSize: Vector3): RVSensor {
  const node = new Object3D();
  node.position.set(x, y, z);
  const aabb = AABB.fromHalfSize(node, halfSize);
  const sensor = new RVSensor(node, aabb);
  sensor.invertSignal = false;
  sensor.UseRaycast = false;
  return sensor;
}

function createSink(x: number, y: number, z: number, halfSize: Vector3): RVSink {
  const node = new Object3D();
  node.position.set(x, y, z);
  const aabb = AABB.fromHalfSize(node, halfSize);
  return new RVSink(node, aabb);
}

// ─── Transport Surface Tests ─────────────────────────────────────

describe('RVTransportSurface', () => {
  it('should move MU along transport direction', () => {
    const surface = createSurface(0, 0, 0, new Vector3(2, 0.1, 0.5), new Vector3(1, 0, 0), 1000);
    const mu = createMU('part1', 0, 0, 0);

    const startX = mu.getPosition().x;

    // Simulate 1 second at 1000 mm/s = 1 m/s
    const dt = 1 / 60;
    for (let i = 0; i < 60; i++) {
      surface.transportMU(mu, dt);
    }

    // Should have moved ~1 meter in X
    const movedX = mu.getPosition().x - startX;
    expect(movedX).toBeCloseTo(1.0, 1);
  });

  it('should not transport when no drive assigned', () => {
    const surface = createSurface(0, 0, 0, new Vector3(2, 0.1, 0.5), new Vector3(1, 0, 0), 0);
    surface.drive = null;

    expect(surface.isActive).toBe(false);
    expect(surface.speed).toBe(0);
  });

  it('should report correct speed from drive', () => {
    const surface = createSurface(0, 0, 0, new Vector3(1, 0.1, 0.5), new Vector3(1, 0, 0), 500);
    expect(surface.speed).toBe(500);
  });
});

// ─── Sensor Tests ────────────────────────────────────────────────

describe('RVSensor', () => {
  it('should detect MU inside sensor area', () => {
    const sensor = createSensor(0, 0, 0, new Vector3(0.5, 0.5, 0.5));
    const mu = createMU('part1', 0, 0, 0);

    sensor.checkOverlap([mu]);
    expect(sensor.occupied).toBe(true);
    expect(sensor.occupiedMU).toBe(mu);
  });

  it('should not detect MU outside sensor area', () => {
    const sensor = createSensor(0, 0, 0, new Vector3(0.5, 0.5, 0.5));
    const mu = createMU('part1', 5, 0, 0);

    sensor.checkOverlap([mu]);
    expect(sensor.occupied).toBe(false);
    expect(sensor.occupiedMU).toBeNull();
  });

  it('should invert signal when configured', () => {
    const node = new Object3D();
    node.position.set(0, 0, 0);
    const aabb = AABB.fromHalfSize(node, new Vector3(0.5, 0.5, 0.5));
    const sensor = new RVSensor(node, aabb);
    sensor.invertSignal = true;
    sensor.UseRaycast = false;

    // MU is inside, but signal is inverted
    const mu = createMU('part1', 0, 0, 0);
    sensor.checkOverlap([mu]);
    expect(sensor.occupied).toBe(false); // Inverted!

    // MU is outside, inverted = occupied
    const mu2 = createMU('part2', 5, 0, 0);
    sensor.checkOverlap([mu2]);
    expect(sensor.occupied).toBe(true); // Inverted!
  });

  it('should fire onChanged callback on state change', () => {
    const sensor = createSensor(0, 0, 0, new Vector3(0.5, 0.5, 0.5));
    let callCount = 0;
    sensor.onChanged = () => { callCount++; };

    const mu = createMU('part1', 0, 0, 0);

    // First check: MU inside -> occupied (change from false to true)
    sensor.checkOverlap([mu]);
    expect(callCount).toBe(1);

    // Second check: MU still inside -> no change
    sensor.checkOverlap([mu]);
    expect(callCount).toBe(1);

    // Third check: MU gone -> unoccupied (change)
    sensor.checkOverlap([]);
    expect(callCount).toBe(2);
  });
});

// ─── Sink Tests ──────────────────────────────────────────────────

describe('RVSink', () => {
  it('should mark overlapping MUs for removal', () => {
    const sink = createSink(0, 0, 0, new Vector3(0.5, 0.5, 0.5));
    const mu = createMU('part1', 0, 0, 0);

    sink.markOverlapping([mu]);
    expect(mu.markedForRemoval).toBe(true);
  });

  it('should not mark MUs outside sink area', () => {
    const sink = createSink(0, 0, 0, new Vector3(0.5, 0.5, 0.5));
    const mu = createMU('part1', 5, 0, 0);

    sink.markOverlapping([mu]);
    expect(mu.markedForRemoval).toBe(false);
  });

  it('should not double-mark already marked MUs', () => {
    const sink = createSink(0, 0, 0, new Vector3(0.5, 0.5, 0.5));
    const mu = createMU('part1', 0, 0, 0);
    mu.markedForRemoval = true;

    sink.markOverlapping([mu]);
    // Should remain marked but callback should not fire again
    expect(mu.markedForRemoval).toBe(true);
  });
});

// ─── Transport Manager Tests ─────────────────────────────────────

describe('RVTransportManager', () => {
  let manager: RVTransportManager;

  beforeEach(() => {
    manager = new RVTransportManager();
    manager.scene = new Scene();
  });

  it('should transport MUs on active surfaces', () => {
    const surface = createSurface(0, 0, 0, new Vector3(5, 0.5, 0.5), new Vector3(1, 0, 0), 1000);
    manager.surfaces.push(surface);

    const mu = createMU('part1', 0, 0, 0);
    manager.mus.push(mu);

    const startX = mu.getPosition().x;
    manager.update(1 / 60);

    expect(mu.getPosition().x).toBeGreaterThan(startX);
  });

  it('should detect sensor overlap after transport', () => {
    const sensor = createSensor(1, 0, 0, new Vector3(0.2, 0.5, 0.5));
    manager.sensors.push(sensor);

    // MU starts at sensor position
    const mu = createMU('part1', 1, 0, 0);
    manager.mus.push(mu);

    manager.update(1 / 60);

    expect(sensor.occupied).toBe(true);
  });

  it('should remove MUs at sink via swap-and-pop', () => {
    const sink = createSink(0, 0, 0, new Vector3(0.5, 0.5, 0.5));
    manager.sinks.push(sink);

    const mu1 = createMU('part1', 0, 0, 0); // At sink
    const mu2 = createMU('part2', 5, 0, 0); // Far away
    manager.mus.push(mu1, mu2);

    manager.update(1 / 60);

    // mu1 should be removed, mu2 should remain
    expect(manager.mus.length).toBe(1);
    expect(manager.mus[0].getName()).toBe('part2');
    expect(manager.totalConsumed).toBe(1);
  });

  it('should handle multiple MUs at sink correctly', () => {
    const sink = createSink(0, 0, 0, new Vector3(1, 1, 1));
    manager.sinks.push(sink);

    // Three MUs at sink, one far away
    manager.mus.push(
      createMU('a', 0, 0, 0),
      createMU('b', 0.1, 0, 0),
      createMU('c', 5, 0, 0), // Not at sink
      createMU('d', -0.1, 0, 0),
    );

    manager.update(1 / 60);

    expect(manager.mus.length).toBe(1);
    expect(manager.mus[0].getName()).toBe('c');
    expect(manager.totalConsumed).toBe(3);
  });

  it('should report correct stats', () => {
    manager.surfaces.push(createSurface(0, 0, 0, new Vector3(1, 0.1, 0.5), new Vector3(1, 0, 0), 500));
    manager.sensors.push(createSensor(0, 0, 0, new Vector3(0.5, 0.5, 0.5)));
    manager.sinks.push(createSink(5, 0, 0, new Vector3(0.5, 0.5, 0.5)));

    const s = manager.stats;
    expect(s.surfaces).toBe(1);
    expect(s.sensors).toBe(1);
    expect(s.sinks).toBe(1);
    expect(s.mus).toBe(0);
  });

  it('should reset all state', () => {
    manager.mus.push(createMU('a', 0, 0, 0));
    manager.totalSpawned = 10;
    manager.totalConsumed = 5;

    const sensor = createSensor(0, 0, 0, new Vector3(0.5, 0.5, 0.5));
    sensor.occupied = true;
    manager.sensors.push(sensor);

    manager.reset();

    expect(manager.mus.length).toBe(0);
    expect(manager.totalSpawned).toBe(0);
    expect(manager.totalConsumed).toBe(0);
    expect(sensor.occupied).toBe(false);
  });
});

// ─── End-to-End: Surface -> Sensor -> Sink ───────────────────────

describe('End-to-end transport', () => {
  it('should transport MU from surface through sensor to sink', () => {
    const manager = new RVTransportManager();
    manager.scene = new Scene();

    // Conveyor surface at origin, 5m long, moving in +X at 2000 mm/s
    const surface = createSurface(2.5, 0, 0, new Vector3(2.5, 0.1, 0.5), new Vector3(1, 0, 0), 2000);
    manager.surfaces.push(surface);

    // Sensor at x=2
    const sensor = createSensor(2, 0, 0, new Vector3(0.2, 0.5, 0.5));
    manager.sensors.push(sensor);

    // Sink at x=5
    const sink = createSink(5, 0, 0, new Vector3(0.3, 0.5, 0.5));
    manager.sinks.push(sink);

    // MU starts at x=0 (on the conveyor)
    const mu = createMU('part1', 0, 0, 0);
    manager.mus.push(mu);

    const dt = 1 / 60;
    let sensorTriggered = false;
    let sinkConsumed = false;

    sensor.onChanged = (occupied) => {
      if (occupied) sensorTriggered = true;
    };
    sink.onConsumed = () => {
      sinkConsumed = true;
    };

    // Run for up to 5 seconds of sim time
    for (let i = 0; i < 300; i++) {
      manager.update(dt);
      if (manager.mus.length === 0) break;
    }

    expect(sensorTriggered).toBe(true);
    expect(sinkConsumed).toBe(true);
    expect(manager.mus.length).toBe(0);
    expect(manager.totalConsumed).toBe(1);
  });
});
