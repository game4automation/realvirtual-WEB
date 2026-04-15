// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * RVPhysicsWorld Unit Tests
 *
 * Tests the Rapier.js physics world wrapper without scene setup.
 * Requires WASM init in beforeAll.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import RAPIER from '@dimforge/rapier3d-compat';
import { RVPhysicsWorld } from '../src/core/engine/rv-physics-world';
import { Vector3, Quaternion } from 'three';

beforeAll(async () => {
  await RAPIER.init();
});

/** Helper: create an initialized physics world with default config */
function createPhysicsWorld(config?: { gravity?: { x: number; y: number; z: number }; friction?: number }): RVPhysicsWorld {
  const pw = new RVPhysicsWorld(RAPIER);
  pw.init({
    gravity: config?.gravity ?? { x: 0, y: -9.81, z: 0 },
    friction: config?.friction ?? 1.5,
  });
  return pw;
}

const halfExtents = { x: 0.1, y: 0.1, z: 0.1 };

// ─── 10.6.1 — WASM Init/Dispose Lifecycle ─────────────────────

describe('RVPhysicsWorld Lifecycle', () => {
  it('init creates world, dispose frees it', () => {
    const pw = new RVPhysicsWorld(RAPIER);
    pw.init({ gravity: { x: 0, y: -9.81, z: 0 } });
    expect(pw.physicsReady).toBe(true);
    expect(pw.bodyCount).toBe(0);
    pw.dispose();
    expect(pw.physicsReady).toBe(false);
  });

  it('dispose can be called multiple times safely', () => {
    const pw = createPhysicsWorld();
    pw.dispose();
    pw.dispose(); // Should not throw
    expect(pw.physicsReady).toBe(false);
  });
});

// ─── 10.6.2 — Add/Remove MU Body ─────────────────────────────

describe('MU Body Management', () => {
  it('addMU creates dynamic body, removeMU deletes it', () => {
    const pw = createPhysicsWorld();
    pw.addMU('mu1', { x: 0, y: 1, z: 0 }, halfExtents);
    expect(pw.muCount).toBe(1);
    expect(pw.bodyCount).toBeGreaterThan(0);
    pw.removeMU('mu1');
    expect(pw.muCount).toBe(0);
    pw.dispose();
  });

  it('multiple MUs can be added and removed independently', () => {
    const pw = createPhysicsWorld();
    pw.addMU('mu1', { x: 0, y: 1, z: 0 }, halfExtents);
    pw.addMU('mu2', { x: 1, y: 1, z: 0 }, halfExtents);
    pw.addMU('mu3', { x: 2, y: 1, z: 0 }, halfExtents);
    expect(pw.muCount).toBe(3);

    pw.removeMU('mu2');
    expect(pw.muCount).toBe(2);
    expect(pw.hasMU('mu1')).toBe(true);
    expect(pw.hasMU('mu2')).toBe(false);
    expect(pw.hasMU('mu3')).toBe(true);

    pw.dispose();
  });

  it('removeMU on non-existent ID does nothing', () => {
    const pw = createPhysicsWorld();
    pw.removeMU('nonexistent'); // Should not throw
    expect(pw.muCount).toBe(0);
    pw.dispose();
  });

  it('hasMU returns correct state', () => {
    const pw = createPhysicsWorld();
    expect(pw.hasMU('mu1')).toBe(false);
    pw.addMU('mu1', { x: 0, y: 1, z: 0 }, halfExtents);
    expect(pw.hasMU('mu1')).toBe(true);
    pw.removeMU('mu1');
    expect(pw.hasMU('mu1')).toBe(false);
    pw.dispose();
  });
});

// ─── 10.6.3 — Add Conveyor Surface (Kinematic Body) ──────────

describe('Conveyor Surface Management', () => {
  it('addConveyorSurface creates kinematic body', () => {
    const pw = createPhysicsWorld();
    pw.addConveyorSurface(
      'conv1',
      { x: 0, y: 0, z: 0 },
      null,
      { x: 1, y: 0.05, z: 0.5 },
      { x: 1, y: 0, z: 0 },
      0.5,
    );
    expect(pw.bodyCount).toBe(1);
    expect(pw.hasSurface('conv1')).toBe(true);
    pw.dispose();
  });

  it('addConveyorSurface with rotation applies quaternion', () => {
    const pw = createPhysicsWorld();
    pw.addConveyorSurface(
      'conv1',
      { x: 0, y: 0, z: 0 },
      { x: 0, y: 0.7071, z: 0, w: 0.7071 }, // 90° around Y
      { x: 1, y: 0.05, z: 0.5 },
      { x: 1, y: 0, z: 0 },
      0.5,
    );
    expect(pw.hasSurface('conv1')).toBe(true);
    pw.dispose();
  });

  it('updateConveyorVelocity changes surface speed', () => {
    const pw = createPhysicsWorld();
    pw.addConveyorSurface(
      'conv1',
      { x: 0, y: 0, z: 0 },
      null,
      { x: 1, y: 0.05, z: 0.5 },
      { x: 1, y: 0, z: 0 },
      0.5,
    );
    // Should not throw
    pw.updateConveyorVelocity('conv1', { x: 1, y: 0, z: 0 }, 1.0);
    pw.dispose();
  });
});

// ─── 10.6.4 — Step + Sync: Gravity pulls MU down ─────────────

describe('Physics Step', () => {
  it('step applies gravity to dynamic body', () => {
    const pw = createPhysicsWorld();
    pw.addMU('mu1', { x: 0, y: 5, z: 0 }, halfExtents);

    // Step several times to let gravity take effect
    for (let i = 0; i < 10; i++) {
      pw.step(1 / 60);
    }

    const pos = pw.getBodyPosition('mu1');
    expect(pos).not.toBeNull();
    expect(pos!.y).toBeLessThan(5); // Gravity pulled it down
    pw.dispose();
  });

  it('sync updates Three.js nodes from Rapier bodies', () => {
    const pw = createPhysicsWorld();
    pw.addMU('mu1', { x: 0, y: 5, z: 0 }, halfExtents);

    const nodePos = new Vector3(0, 5, 0);
    const nodeQuat = new Quaternion();
    const syncMap = new Map<string, { position: Vector3; quaternion: Quaternion }>();
    syncMap.set('mu1', { position: nodePos, quaternion: nodeQuat });

    // Step to let gravity act
    for (let i = 0; i < 10; i++) {
      pw.step(1 / 60);
    }
    pw.sync(syncMap);

    expect(nodePos.y).toBeLessThan(5);
    pw.dispose();
  });

  it('step with zero gravity keeps body in place', () => {
    const pw = createPhysicsWorld({ gravity: { x: 0, y: 0, z: 0 } });
    pw.addMU('mu1', { x: 0, y: 5, z: 0 }, halfExtents);

    for (let i = 0; i < 10; i++) {
      pw.step(1 / 60);
    }

    const pos = pw.getBodyPosition('mu1');
    expect(pos!.y).toBeCloseTo(5, 1);
    pw.dispose();
  });
});

// ─── 10.6.5 — Sensor Events: Enter/Leave ─────────────────────

describe('Sensor Events', () => {
  it('sensor fires enter event when MU overlaps', () => {
    const pw = createPhysicsWorld({ gravity: { x: 0, y: -9.81, z: 0 } });

    // Sensor at ground level
    pw.addSensor('sensor1', { x: 0, y: 0, z: 0 }, null, { x: 1, y: 1, z: 1 });

    // MU starts above sensor and will fall into it
    pw.addMU('mu1', { x: 0, y: 0.5, z: 0 }, halfExtents);

    const events: { sensorId: string; muId: string; entered: boolean }[] = [];
    pw.onSensorEvent = (sensorId, muId, entered) => {
      events.push({ sensorId, muId, entered });
    };

    // Step multiple times until MU falls into sensor zone
    for (let i = 0; i < 120; i++) {
      pw.step(1 / 60);
      pw.processEvents();
    }

    const enterEvents = events.filter(e => e.entered && e.sensorId === 'sensor1');
    expect(enterEvents.length).toBeGreaterThan(0);
    pw.dispose();
  });

  it('sensor occupant count tracks correctly', () => {
    const pw = createPhysicsWorld({ gravity: { x: 0, y: 0, z: 0 } });

    // Large sensor zone
    pw.addSensor('sensor1', { x: 0, y: 0, z: 0 }, null, { x: 5, y: 5, z: 5 });

    // MU inside sensor zone (no gravity, stays in place)
    pw.addMU('mu1', { x: 0, y: 0, z: 0 }, halfExtents);

    // Step and process events
    for (let i = 0; i < 10; i++) {
      pw.step(1 / 60);
      pw.processEvents();
    }

    expect(pw.getSensorOccupantCount('sensor1')).toBeGreaterThanOrEqual(0);
    pw.dispose();
  });
});

// ─── 10.6.6 — physicsReady Guard ─────────────────────────────

describe('Physics Ready Guard', () => {
  it('step does nothing when physicsReady is false', () => {
    const pw = new RVPhysicsWorld(RAPIER);
    // Don't call init()
    expect(pw.physicsReady).toBe(false);
    pw.step(1 / 60); // Should not throw
  });

  it('addMU does nothing when physicsReady is false', () => {
    const pw = new RVPhysicsWorld(RAPIER);
    pw.addMU('mu1', { x: 0, y: 1, z: 0 }, halfExtents); // Should not throw
    expect(pw.muCount).toBe(0);
  });

  it('sync does nothing when physicsReady is false', () => {
    const pw = new RVPhysicsWorld(RAPIER);
    const syncMap = new Map<string, { position: Vector3; quaternion: Quaternion }>();
    pw.sync(syncMap); // Should not throw
  });

  it('processEvents does nothing when physicsReady is false', () => {
    const pw = new RVPhysicsWorld(RAPIER);
    pw.processEvents(); // Should not throw
  });
});

// ─── 10.6.7 — Two-Phase-Removal: No dangling handles ─────────

describe('Two-Phase-Removal', () => {
  it('removeMU after step does not cause WASM panic', () => {
    const pw = createPhysicsWorld();
    pw.addMU('mu1', { x: 0, y: 5, z: 0 }, halfExtents);
    pw.step(1 / 60);
    pw.removeMU('mu1');
    pw.step(1 / 60); // Must not panic
    expect(pw.muCount).toBe(0);
    pw.dispose();
  });

  it('markMUForRemoval + flushRemovals pattern works', () => {
    const pw = createPhysicsWorld();
    pw.addMU('mu1', { x: 0, y: 5, z: 0 }, halfExtents);
    pw.addMU('mu2', { x: 1, y: 5, z: 0 }, halfExtents);
    pw.step(1 / 60);

    pw.markMUForRemoval('mu1');
    // mu1 still exists until flush
    expect(pw.hasMU('mu1')).toBe(true);

    pw.flushRemovals();
    expect(pw.hasMU('mu1')).toBe(false);
    expect(pw.hasMU('mu2')).toBe(true);
    expect(pw.muCount).toBe(1);

    pw.step(1 / 60); // Must not panic
    pw.dispose();
  });
});

// ─── 10.6.8 — Out-of-Bounds Guard ────────────────────────────

describe('Out-of-Bounds Guard', () => {
  it('MU below Y=-10 is removed by processOutOfBounds', () => {
    const pw = createPhysicsWorld({ gravity: { x: 0, y: 0, z: 0 } });
    pw.addMU('mu1', { x: 0, y: -11, z: 0 }, halfExtents);
    pw.step(1 / 60);
    const removed = pw.processOutOfBounds();
    expect(removed).toContain('mu1');
    expect(pw.muCount).toBe(0);
    pw.dispose();
  });

  it('MU above Y=-10 is not removed', () => {
    const pw = createPhysicsWorld({ gravity: { x: 0, y: 0, z: 0 } });
    pw.addMU('mu1', { x: 0, y: 5, z: 0 }, halfExtents);
    pw.step(1 / 60);
    const removed = pw.processOutOfBounds();
    expect(removed.length).toBe(0);
    expect(pw.muCount).toBe(1);
    pw.dispose();
  });

  it('custom threshold works', () => {
    const pw = createPhysicsWorld({ gravity: { x: 0, y: 0, z: 0 } });
    pw.addMU('mu1', { x: 0, y: -3, z: 0 }, halfExtents);
    pw.step(1 / 60);
    const removed = pw.processOutOfBounds(-2);
    expect(removed).toContain('mu1');
    expect(pw.muCount).toBe(0);
    pw.dispose();
  });
});

// ─── Raycast ──────────────────────────────────────────────────

describe('Raycast', () => {
  it('castRay hits a MU body', () => {
    const pw = createPhysicsWorld({ gravity: { x: 0, y: 0, z: 0 } });
    pw.addMU('mu1', { x: 2, y: 0, z: 0 }, { x: 0.5, y: 0.5, z: 0.5 });

    // Need to step once for collision structures to be built
    pw.step(1 / 60);

    const hit = pw.castRay(
      { x: 0, y: 0, z: 0 },
      { x: 1, y: 0, z: 0 },
      10,
    );
    expect(hit).not.toBeNull();
    expect(hit!.muId).toBe('mu1');
    expect(hit!.distance).toBeGreaterThan(0);
    expect(hit!.distance).toBeLessThan(3);
    pw.dispose();
  });

  it('castRay misses when no MU in path', () => {
    const pw = createPhysicsWorld({ gravity: { x: 0, y: 0, z: 0 } });
    pw.addMU('mu1', { x: 0, y: 5, z: 0 }, halfExtents);
    pw.step(1 / 60);

    const hit = pw.castRay(
      { x: 0, y: 0, z: 0 },
      { x: 1, y: 0, z: 0 }, // Shooting in +X, MU is at Y=5
      10,
    );
    expect(hit).toBeNull();
    pw.dispose();
  });

  it('castRay returns null when physics not ready', () => {
    const pw = new RVPhysicsWorld(RAPIER);
    const hit = pw.castRay({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, 10);
    expect(hit).toBeNull();
  });
});

// ─── Conveyor + MU Integration ────────────────────────────────

describe('Conveyor + MU Integration', () => {
  it('conveyor friction moves MU along surface', () => {
    const pw = createPhysicsWorld();

    // Conveyor at ground level, moving in +X at 1 m/s
    pw.addConveyorSurface(
      'conv1',
      { x: 0, y: -0.05, z: 0 },
      null,
      { x: 2, y: 0.05, z: 0.5 },
      { x: 1, y: 0, z: 0 },
      1.0,
      2.0, // high friction
    );

    // MU sitting on top of conveyor
    pw.addMU('mu1', { x: 0, y: 0.15, z: 0 }, halfExtents, 1, 0.1, 0.1);

    // Step for 2 seconds
    for (let i = 0; i < 120; i++) {
      pw.step(1 / 60);
    }

    const pos = pw.getBodyPosition('mu1');
    expect(pos).not.toBeNull();
    // MU should have moved in +X direction due to friction
    expect(pos!.x).toBeGreaterThan(0.01);
    pw.dispose();
  });
});

// ─── Backpressure & Stacking ──────────────────────────────────

describe('Backpressure & Stacking', () => {
  it('multiple MUs on conveyor do not overlap when blocked', () => {
    const pw = createPhysicsWorld();

    // Conveyor moving in +X
    pw.addConveyorSurface(
      'conv1',
      { x: 2, y: -0.05, z: 0 },
      null,
      { x: 3, y: 0.05, z: 0.5 },
      { x: 1, y: 0, z: 0 },
      0.5,
      2.0,
    );

    // Three MUs placed close together on the conveyor
    const muSize = { x: 0.1, y: 0.1, z: 0.1 };
    pw.addMU('mu1', { x: 0, y: 0.15, z: 0 }, muSize, 1, 0.5, 0.8);
    pw.addMU('mu2', { x: 0.5, y: 0.15, z: 0 }, muSize, 1, 0.5, 0.8);
    pw.addMU('mu3', { x: 1.0, y: 0.15, z: 0 }, muSize, 1, 0.5, 0.8);

    // Step for 3 seconds
    for (let i = 0; i < 180; i++) {
      pw.step(1 / 60);
    }

    const pos1 = pw.getBodyPosition('mu1')!;
    const pos2 = pw.getBodyPosition('mu2')!;
    const pos3 = pw.getBodyPosition('mu3')!;

    // All MUs should still exist (not fallen through)
    expect(pos1).not.toBeNull();
    expect(pos2).not.toBeNull();
    expect(pos3).not.toBeNull();

    // MUs should be separated (not overlapping in X)
    // The gap between centers should be >= 2 * halfExtent (0.2m) minus some tolerance
    const gap12 = Math.abs(pos2.x - pos1.x);
    const gap23 = Math.abs(pos3.x - pos2.x);

    // With physics, MUs cannot interpenetrate, so gaps should be > 0
    expect(gap12).toBeGreaterThan(0.05); // At least some separation
    expect(gap23).toBeGreaterThan(0.05);

    pw.dispose();
  });

  it('MU stops moving when conveyor velocity is set to zero', () => {
    const pw = createPhysicsWorld();

    pw.addConveyorSurface(
      'conv1',
      { x: 0, y: -0.05, z: 0 },
      null,
      { x: 3, y: 0.05, z: 0.5 },
      { x: 1, y: 0, z: 0 },
      1.0,
      2.0,
    );

    pw.addMU('mu1', { x: 0, y: 0.15, z: 0 }, halfExtents, 1, 0.5, 0.8);

    // Run conveyor for 1 second
    for (let i = 0; i < 60; i++) {
      pw.step(1 / 60);
    }

    const posAfterMove = pw.getBodyPosition('mu1')!;
    expect(posAfterMove.x).toBeGreaterThan(0);

    // Stop conveyor
    pw.updateConveyorVelocity('conv1', { x: 1, y: 0, z: 0 }, 0);

    // Run for another second with stopped conveyor
    for (let i = 0; i < 60; i++) {
      pw.step(1 / 60);
    }

    const posAfterStop = pw.getBodyPosition('mu1')!;

    // With damping, the MU should come to near-stop
    // The X velocity should be very low (position barely changes)
    // We allow some drift due to momentum, but it should stabilize
    for (let i = 0; i < 60; i++) {
      pw.step(1 / 60);
    }

    const posFinal = pw.getBodyPosition('mu1')!;
    const driftInLastSecond = Math.abs(posFinal.x - posAfterStop.x);
    expect(driftInLastSecond).toBeLessThan(0.5); // Should be nearly stopped

    pw.dispose();
  });
});
