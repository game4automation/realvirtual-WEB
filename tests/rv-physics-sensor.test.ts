// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-physics-sensor.test.ts — plan-276 Phase 5 (F6): Sensor physics mode.
 *
 * Covers: `PhysicsMode` extras parsing (schema), the world-build sensor
 * assignment (collision sensor → `addSensorBox` incl. oriented boxes, zone
 * OVERLAP suffices, outside every zone → kinematic), the kinematic-loop skip
 * for physics-managed sensors (`physicsManagedSensors` seam), the enter/leave
 * balance from provider sensor events (robust against duplicate events),
 * the raycast physics path (`provider.castRay` per tick), the AABB fallback
 * (a NON-managed sensor still detects physics-owned MUs via the synced node
 * position, 1 tick stale), the event-based zone-sink consumption (§2.4) and
 * the teardown rules (presence sets cleared, seam nulled, handler unwired).
 *
 * All unit tests run against a MockPhysicsProvider through the public
 * registry (factories from rv-physics-surface.test.ts). One integration test
 * runs END-TO-END against REAL Rapier WASM (graceful skip when the
 * out-of-band package is missing): an MU falls through a physics-managed
 * sensor and `onChanged` fires enter and leave in order.
 *
 * Runs only in the private build (imports `@rv-private/...`).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Box3, Object3D, Scene, Vector3 } from 'three';
import { AABB } from '../src/core/engine/rv-aabb';
import { RVMovingUnit } from '../src/core/engine/rv-mu';
import { RVSensor } from '../src/core/engine/rv-sensor';
import { RVSink } from '../src/core/engine/rv-sink';
import { RVTransportManager } from '../src/core/engine/rv-transport-manager';
import { RVPhysicsZone } from '../src/core/engine/rv-physics-zone';
import { EventEmitter } from '../src/core/rv-events';
import { applySchema } from '../src/core/engine/rv-component-registry';
import {
  physicsRegistry,
  physicsSettings,
  type PhysicsAABB,
  type PhysicsPose,
  type PhysicsProvider,
  type PhysicsQuat,
  type PhysicsRayHit,
  type PhysicsVec3,
  type PhysicsZoneConfig,
} from '../src/core/engine/rv-physics-registry';
import type { ComponentContext } from '../src/core/engine/rv-component-registry';
import { PhysicsZonePlugin } from '@rv-private/plugins/physics-zone-plugin';
import { RapierPhysicsProvider } from '@rv-private/physics/rv-rapier-provider';
import type { RVViewer } from '../src/core/rv-viewer';
import type { LoadResult } from '../src/core/engine/rv-scene-loader';

const DT = 1 / 60;
const MU_HALF = new Vector3(0.05, 0.05, 0.05);
const Q_IDENT: PhysicsQuat = { x: 0, y: 0, z: 0, w: 1 };

// ─── Factories (rv-physics-surface.test.ts pattern) ────────────────────────

function createMU(name: string, x: number, y: number, z: number): RVMovingUnit {
  const node = new Object3D();
  node.name = name;
  node.position.set(x, y, z);
  return new RVMovingUnit(node, 'test-source', MU_HALF.clone());
}

/** Physics-owned MU (already handed over — the plugin adopts it on the next tick). */
function ownedMU(manager: RVTransportManager, name: string, x: number, y: number, z: number): RVMovingUnit {
  const mu = createMU(name, x, y, z);
  mu.physicsOwned = true;
  mu.physicsBodyId = String(mu.id);
  manager.mus.push(mu);
  return mu;
}

function createManager(): RVTransportManager {
  const manager = new RVTransportManager();
  manager.scene = new Scene();
  return manager;
}

/** Collision-mode sensor with authored BoxCollider extras (local half extents). */
function createCollisionSensor(
  name: string,
  x: number, y: number, z: number,
  half: Vector3,
  rotateY = 0,
): RVSensor {
  const node = new Object3D();
  node.name = name;
  node.position.set(x, y, z);
  if (rotateY !== 0) node.rotation.y = rotateY;
  node.updateMatrixWorld(true);
  const size = { x: half.x * 2, y: half.y * 2, z: half.z * 2 };
  const sensor = new RVSensor(node, AABB.fromBoxCollider(node, { x: 0, y: 0, z: 0 }, size));
  sensor.boxColliderData = { center: { x: 0, y: 0, z: 0 }, size };
  return sensor;
}

/** Raycast-mode sensor (beam from the node origin along a local direction). */
function createRaycastSensor(
  name: string,
  x: number, y: number, z: number,
  dir: { x: number; y: number; z: number } = { x: 0, y: 0, z: 1 },
  lengthMm = 2000,
): RVSensor {
  const node = new Object3D();
  node.name = name;
  node.position.set(x, y, z);
  node.updateMatrixWorld(true);
  const sensor = new RVSensor(node, AABB.fromHalfSize(node, new Vector3(0.05, 0.05, 0.05)));
  sensor.UseRaycast = true;
  sensor.RayCastDirection = dir;
  sensor.RayCastLength = lengthMm;
  return sensor;
}

/** Sink with an authored box volume. */
function createSink(name: string, x: number, y: number, z: number, half: Vector3): RVSink {
  const node = new Object3D();
  node.name = name;
  node.position.set(x, y, z);
  node.updateMatrixWorld(true);
  const size = { x: half.x * 2, y: half.y * 2, z: half.z * 2 };
  return new RVSink(node, AABB.fromBoxCollider(node, { x: 0, y: 0, z: 0 }, size));
}

/** Explicit box zone registered like the loader does (init pass). */
function createZone(
  center: [number, number, number],
  size: [number, number, number],
): RVPhysicsZone {
  const node = new Object3D();
  node.name = 'Zone';
  node.position.set(...center);
  node.updateMatrixWorld(true);
  const aabb = AABB.fromBoxCollider(
    node,
    { x: 0, y: 0, z: 0 },
    { x: size[0], y: size[1], z: size[2] },
  );
  const zone = new RVPhysicsZone(node, aabb);
  zone.ShowGizmo = false;
  zone.init({ gizmoManager: undefined } as unknown as ComponentContext);
  return zone;
}

// ─── Mock provider (surface-test mock + sensor-box/raycast recording) ───────

class MockPhysicsProvider implements PhysicsProvider {
  ready = true;
  failed = false;
  /** Deep-copied snapshots — callers hand in REUSED scratch objects. */
  sensorBoxes: Array<{ id: string; center: PhysicsVec3; half: PhysicsVec3; quat: PhysicsQuat }> = [];
  rayCalls: Array<{ origin: PhysicsVec3; dir: PhysicsVec3; maxDist: number }> = [];
  /** Next castRay result (test-controlled). */
  rayHit: PhysicsRayHit | null = null;
  added: Array<{ muId: string }> = [];
  removed: string[] = [];
  poses = new Map<string, { pos: PhysicsVec3; quat: PhysicsQuat }>();
  settled: string[] = [];
  stepCalls = 0;
  onSensorEvent: ((sensorId: string, muId: string, entered: boolean) => void) | null = null;

  private readonly _outPos: PhysicsVec3 = { x: 0, y: 0, z: 0 };
  private readonly _outQuat: PhysicsQuat = { x: 0, y: 0, z: 0, w: 1 };

  async init(): Promise<void> { this.ready = true; }
  dispose(): void { this.ready = false; this.poses.clear(); }
  addZone(_id: string, _aabb: PhysicsAABB, _cfg: PhysicsZoneConfig): void {}
  addStaticBox(): void {}
  addConveyor(): void {}
  setConveyorVelocity(): void {}
  addDynamicMU(muId: string, pose: PhysicsPose): void {
    this.added.push({ muId });
    this.poses.set(muId, { pos: { ...pose.pos }, quat: { ...pose.quat } });
  }
  removeBody(muId: string): void {
    this.removed.push(muId);
    this.poses.delete(muId);
  }
  addSensorBox(id: string, center: PhysicsVec3, halfExtents: PhysicsVec3, quat: PhysicsQuat): void {
    this.sensorBoxes.push({
      id,
      center: { x: center.x, y: center.y, z: center.z },
      half: { x: halfExtents.x, y: halfExtents.y, z: halfExtents.z },
      quat: { x: quat.x, y: quat.y, z: quat.z, w: quat.w },
    });
  }
  castRay(origin: PhysicsVec3, dir: PhysicsVec3, maxDist: number): PhysicsRayHit | null {
    this.rayCalls.push({
      origin: { x: origin.x, y: origin.y, z: origin.z },
      dir: { x: dir.x, y: dir.y, z: dir.z },
      maxDist,
    });
    return this.rayHit;
  }
  step(): void { this.stepCalls++; }
  syncPoses(out: (muId: string, pos: PhysicsVec3, quat: PhysicsQuat) => void): void {
    for (const [muId, p] of this.poses) {
      this._outPos.x = p.pos.x; this._outPos.y = p.pos.y; this._outPos.z = p.pos.z;
      this._outQuat.x = p.quat.x; this._outQuat.y = p.quat.y;
      this._outQuat.z = p.quat.z; this._outQuat.w = p.quat.w;
      out(muId, this._outPos, this._outQuat);
    }
  }
  getSettledBodies(): string[] { return [...this.settled]; }
}

// ─── Fake viewer + plugin build (rv-physics-surface.test.ts pattern) ────────

function fakeViewer(tm: RVTransportManager): RVViewer {
  const emitter = new EventEmitter();
  return {
    transportManager: tm,
    registry: { getNode: () => null },
    gizmoManager: undefined,
    simulationKernel: null,
    getPlugin: () => undefined,
    on: emitter.on.bind(emitter),
    emit: emitter.emit.bind(emitter),
  } as unknown as RVViewer;
}

function fakeLoadResult(tm: RVTransportManager): LoadResult {
  return {
    root: new Object3D(),
    boundingBox: new Box3(new Vector3(-10, -5, -10), new Vector3(10, 10, 10)),
    transportManager: tm,
    registry: { getNode: () => null },
    drives: [],
  } as unknown as LoadResult;
}

/** Build the plugin against `tm` and await the async world build. */
async function builtPlugin(tm: RVTransportManager): Promise<PhysicsZonePlugin> {
  const plugin = new PhysicsZonePlugin();
  plugin.onModelLoaded(fakeLoadResult(tm), fakeViewer(tm));
  await plugin.buildPromise;
  return plugin;
}

// ─── Shared setup/teardown ──────────────────────────────────────────────────

let mock: MockPhysicsProvider;

beforeEach(() => {
  RVPhysicsZone.clearAll();
  mock = new MockPhysicsProvider();
  physicsRegistry.register(mock);
  physicsSettings.enabled = true;
});

afterEach(() => {
  RVPhysicsZone.clearAll();
  physicsRegistry.register(null);
  physicsSettings.enabled = false;
  vi.restoreAllMocks();
});

// ─── Tests (plan-276 Phase 5) ───────────────────────────────────────────────

describe('Sensor PhysicsMode (Phase 5, F6)', () => {
  it('PhysicsMode parses from extras with a defensive false default (schema)', () => {
    const node = new Object3D();
    const sensor = new RVSensor(node, AABB.fromHalfSize(node, new Vector3(0.1, 0.1, 0.1)));

    // Defensive default — untouched by empty extras.
    expect(sensor.PhysicsMode).toBe(false);
    applySchema(sensor as unknown as Record<string, unknown>, RVSensor.schema, {});
    expect(sensor.PhysicsMode).toBe(false);

    // Authored extras set it.
    applySchema(
      sensor as unknown as Record<string, unknown>,
      RVSensor.schema,
      { PhysicsMode: true },
    );
    expect(sensor.PhysicsMode).toBe(true);
  });

  it('collision sensor overlapping a zone → addSensorBox at build (oriented via world quat)', async () => {
    const manager = createManager();
    // 45° about Y — the provider box must carry the ORIENTATION, with the
    // LOCAL half extents (not a rotated axis-aligned envelope).
    const rot = Math.PI / 4;
    const sensor = createCollisionSensor('S1', 0.5, 1, 0, new Vector3(0.2, 0.1, 0.3), rot);
    sensor.PhysicsMode = true;
    manager.sensors.push(sensor);
    // Zone only PARTIALLY covers the sensor — overlap suffices (sensors are
    // thin and may sit exactly on the zone edge; plan-276 Phase 5).
    createZone([0.5 + 0.15, 1, 0], [0.4, 2, 2]);

    const plugin = await builtPlugin(manager);

    expect(mock.sensorBoxes).toHaveLength(1);
    const box = mock.sensorBoxes[0];
    expect(box.id).toMatch(/^sensor:0:/);
    expect(box.center.x).toBeCloseTo(0.5, 6);
    expect(box.center.y).toBeCloseTo(1, 6);
    expect(box.half.x).toBeCloseTo(0.2, 6);
    expect(box.half.y).toBeCloseTo(0.1, 6);
    expect(box.half.z).toBeCloseTo(0.3, 6);
    expect(box.quat.y).toBeCloseTo(Math.sin(rot / 2), 6);
    expect(box.quat.w).toBeCloseTo(Math.cos(rot / 2), 6);
    // Narrow seam injected: the manager knows this sensor is physics-managed.
    expect(manager.physicsManagedSensors?.has(sensor)).toBe(true);

    plugin.dispose();
    expect(manager.physicsManagedSensors).toBeNull(); // teardown unhooks
  });

  it('PhysicsMode sensor OUTSIDE every zone stays kinematic (no sensor box, no seam)', async () => {
    const manager = createManager();
    const sensor = createCollisionSensor('Far', 8, 1, 0, new Vector3(0.2, 0.1, 0.2));
    sensor.PhysicsMode = true;
    manager.sensors.push(sensor);
    createZone([0, 1, 0], [4, 4, 4]); // sensor at x=8 — no overlap

    const plugin = await builtPlugin(manager);

    expect(mock.sensorBoxes).toHaveLength(0);
    expect(manager.physicsManagedSensors).toBeNull();

    plugin.dispose();
  });

  it('physics-managed sensor is SKIPPED by the kinematic loop; a plain one still detects', async () => {
    const manager = createManager();
    const managed = createCollisionSensor('Managed', 0, 1, 0, new Vector3(0.3, 0.3, 0.3));
    managed.PhysicsMode = true;
    const plain = createCollisionSensor('Plain', 0, 1, 0, new Vector3(0.3, 0.3, 0.3));
    manager.sensors.push(managed, plain);
    createZone([0, 1, 0], [4, 4, 4]);
    const plugin = await builtPlugin(manager);

    // Kinematic MU inside BOTH sensor volumes.
    const mu = createMU('part', 0, 1, 0);
    manager.mus.push(mu);
    manager.update(DT);

    expect(plain.occupied).toBe(true);    // kinematic AABB path
    expect(managed.occupied).toBe(false); // provider owns it — loop skipped it

    plugin.dispose();

    // Self-healing after teardown: the kinematic loop takes over again.
    manager.update(DT);
    expect(managed.occupied).toBe(true);
  });

  it('enter/leave events drive occupied + onChanged (enter → true, leave → false)', async () => {
    const manager = createManager();
    const sensor = createCollisionSensor('S1', 0, 1, 0, new Vector3(0.2, 0.1, 0.2));
    sensor.PhysicsMode = true;
    manager.sensors.push(sensor);
    createZone([0, 1, 0], [6, 6, 6]);
    const plugin = await builtPlugin(manager);
    const sensorId = mock.sensorBoxes[0].id;

    const changes: boolean[] = [];
    sensor.onChanged = (occupied) => changes.push(occupied);

    const mu = ownedMU(manager, 'part', 2, 1, 0); // owned, away from the sensor volume
    plugin.onFixedUpdatePost(DT); // adopt — no events yet
    expect(sensor.occupied).toBe(false);
    expect(changes).toEqual([]);

    mock.onSensorEvent!(sensorId, String(mu.id), true); // drained during step()
    plugin.onFixedUpdatePost(DT);
    expect(sensor.occupied).toBe(true);
    expect(sensor.occupiedMU).toBe(mu);
    expect(changes).toEqual([true]);

    mock.onSensorEvent!(sensorId, String(mu.id), false);
    plugin.onFixedUpdatePost(DT);
    expect(sensor.occupied).toBe(false);
    expect(sensor.occupiedMU).toBeNull();
    expect(changes).toEqual([true, false]);

    plugin.dispose();
  });

  it('enter/leave balance is robust: duplicate enter, leave without enter, multi-MU', async () => {
    const manager = createManager();
    const sensor = createCollisionSensor('S1', 0, 1, 0, new Vector3(0.2, 0.1, 0.2));
    sensor.PhysicsMode = true;
    manager.sensors.push(sensor);
    createZone([0, 1, 0], [6, 6, 6]);
    const plugin = await builtPlugin(manager);
    const sensorId = mock.sensorBoxes[0].id;

    const a = ownedMU(manager, 'a', 2, 1, 0);
    const b = ownedMU(manager, 'b', 2.5, 1, 0);
    plugin.onFixedUpdatePost(DT); // adopt both

    // Leave WITHOUT enter — harmless no-op.
    mock.onSensorEvent!(sensorId, String(a.id), false);
    plugin.onFixedUpdatePost(DT);
    expect(sensor.occupied).toBe(false);

    // DOUBLE enter for A + enter for B, then ONE leave for A → B keeps it occupied.
    mock.onSensorEvent!(sensorId, String(a.id), true);
    mock.onSensorEvent!(sensorId, String(a.id), true); // duplicate — Set semantics
    mock.onSensorEvent!(sensorId, String(b.id), true);
    plugin.onFixedUpdatePost(DT);
    expect(sensor.occupied).toBe(true);

    mock.onSensorEvent!(sensorId, String(a.id), false);
    plugin.onFixedUpdatePost(DT);
    expect(sensor.occupied).toBe(true); // B still present
    // NOTE: occupiedMU updates only on STATE CHANGES (occupied stayed true) —
    // exact parity with the kinematic applyResult semantics.

    mock.onSensorEvent!(sensorId, String(b.id), false);
    plugin.onFixedUpdatePost(DT);
    expect(sensor.occupied).toBe(false);

    plugin.dispose();
  });

  it('presence is pruned when the body vanishes WITHOUT a leave event (sink/settle)', async () => {
    const manager = createManager();
    const sensor = createCollisionSensor('S1', 0, 1, 0, new Vector3(0.2, 0.1, 0.2));
    sensor.PhysicsMode = true;
    manager.sensors.push(sensor);
    createZone([0, 1, 0], [6, 6, 6]);
    const plugin = await builtPlugin(manager);
    const sensorId = mock.sensorBoxes[0].id;

    const mu = ownedMU(manager, 'part', 2, 1, 0);
    plugin.onFixedUpdatePost(DT);
    mock.onSensorEvent!(sensorId, String(mu.id), true);
    plugin.onFixedUpdatePost(DT);
    expect(sensor.occupied).toBe(true);

    // Consumed inside the sensor volume: the removed body never drains a
    // stopped event (the world skips stepping at 0 bodies) — the per-tick
    // prune must clear the sensor anyway.
    mu.markedForRemoval = true;
    plugin.onFixedUpdatePost(DT);
    expect(sensor.occupied).toBe(false);

    plugin.dispose();
  });

  it('raycast physics sensor: castRay per tick — MU hit → occupied, non-MU/no hit → free', async () => {
    const manager = createManager();
    const sensor = createRaycastSensor('Ray1', 0, 1, 0, { x: 0, y: 0, z: 1 }, 2000);
    sensor.PhysicsMode = true;
    manager.sensors.push(sensor);
    createZone([0, 1, 1], [6, 6, 6]); // the beam bounds overlap the zone
    const plugin = await builtPlugin(manager);

    expect(mock.sensorBoxes).toHaveLength(0); // raycast mode — no sensor collider
    expect(manager.physicsManagedSensors?.has(sensor)).toBe(true);

    const changes: boolean[] = [];
    sensor.onChanged = (occupied) => changes.push(occupied);
    const mu = ownedMU(manager, 'part', 0, 1, 1);

    // No hit → free.
    plugin.onFixedUpdatePost(DT);
    expect(mock.rayCalls).toHaveLength(1);
    const ray = mock.rayCalls[0];
    expect(ray.origin.x).toBeCloseTo(0, 6);
    expect(ray.origin.y).toBeCloseTo(1, 6);
    expect(ray.dir.z).toBeCloseTo(1, 6);
    expect(ray.maxDist).toBeCloseTo(2, 6); // 2000 mm → 2 m
    expect(sensor.occupied).toBe(false);

    // Hit on the MU body → occupied with the correct MU.
    mock.rayHit = { distance: 1, bodyId: String(mu.id) };
    plugin.onFixedUpdatePost(DT);
    expect(sensor.occupied).toBe(true);
    expect(sensor.occupiedMU).toBe(mu);

    // Hit on a NON-MU body (static box blocks the beam) → free.
    mock.rayHit = { distance: 0.4, bodyId: 'staticbox:0:frame' };
    plugin.onFixedUpdatePost(DT);
    expect(sensor.occupied).toBe(false);

    // No hit again → stays free, no extra onChanged.
    mock.rayHit = null;
    plugin.onFixedUpdatePost(DT);
    expect(changes).toEqual([true, false]);

    plugin.dispose();
  });

  it('AABB fallback: a NON-managed sensor detects a physics-owned MU via the synced node position (1 tick stale)', async () => {
    const manager = createManager();
    const sensor = createCollisionSensor('Plain', 0, 1, 0, new Vector3(0.3, 0.3, 0.3)); // PhysicsMode = false
    manager.sensors.push(sensor);
    createZone([0, 1, 0], [8, 8, 8]);
    const plugin = await builtPlugin(manager);
    expect(manager.physicsManagedSensors).toBeNull(); // nothing physics-managed

    const mu = ownedMU(manager, 'part', 3, 1, 0); // node still away from the sensor
    // The provider moved the body INTO the sensor volume this tick.
    mock.poses.set(String(mu.id), { pos: { x: 0, y: 1, z: 0 }, quat: { ...Q_IDENT } });

    manager.update(DT); // node not yet synced — sensor still free
    expect(sensor.occupied).toBe(false);

    plugin.onFixedUpdatePost(DT); // syncPoses writes the node position + AABB

    manager.update(DT); // next kinematic tick sees it (documented 1-tick lag)
    expect(sensor.occupied).toBe(true);
    expect(sensor.occupiedMU).toBe(mu);

    plugin.dispose();
  });

  it('zone sink gets a sensor collider; enter event consumes the physics MU (idempotent)', async () => {
    const manager = createManager();
    const sink = createSink('Sink1', 0, 0.5, 0, new Vector3(0.2, 0.2, 0.2));
    manager.sinks.push(sink);
    createZone([0, 1, 0], [6, 6, 6]);
    const plugin = await builtPlugin(manager);

    expect(mock.sensorBoxes).toHaveLength(1);
    const box = mock.sensorBoxes[0];
    expect(box.id).toMatch(/^sink:0:/);
    expect(box.center.y).toBeCloseTo(0.5, 6);
    expect(box.half.x).toBeCloseTo(0.2, 6);

    const consumed: RVMovingUnit[] = [];
    sink.onConsumed = (mu) => consumed.push(mu as RVMovingUnit);

    // MU away from the sink's XZ footprint — the kinematic fallback stays
    // silent; the EVENT path alone consumes.
    const mu = ownedMU(manager, 'part', 2, 1, 0);
    plugin.onFixedUpdatePost(DT); // adopt

    mock.onSensorEvent!(box.id, String(mu.id), true);
    expect(mu.markedForRemoval).toBe(true);
    expect(consumed).toEqual([mu]);

    // Duplicate enter (or the AABB fallback double-marking) is idempotent.
    mock.onSensorEvent!(box.id, String(mu.id), true);
    expect(consumed).toHaveLength(1);

    plugin.dispose();
  });

  it('sink OUTSIDE every zone gets NO sensor collider (kinematic path only)', async () => {
    const manager = createManager();
    const sink = createSink('FarSink', 9, 0.5, 0, new Vector3(0.2, 0.2, 0.2));
    manager.sinks.push(sink);
    createZone([0, 1, 0], [4, 4, 4]);
    const plugin = await builtPlugin(manager);

    expect(mock.sensorBoxes).toHaveLength(0);

    plugin.dispose();
  });

  it('teardown clears presence state and unwires the event handler', async () => {
    const manager = createManager();
    const sensor = createCollisionSensor('S1', 0, 1, 0, new Vector3(0.2, 0.1, 0.2));
    sensor.PhysicsMode = true;
    manager.sensors.push(sensor);
    createZone([0, 1, 0], [6, 6, 6]);
    const plugin = await builtPlugin(manager);
    const sensorId = mock.sensorBoxes[0].id;
    expect(mock.onSensorEvent).not.toBeNull(); // plugin wired its handler

    const mu = ownedMU(manager, 'part', 2, 1, 0);
    plugin.onFixedUpdatePost(DT);
    mock.onSensorEvent!(sensorId, String(mu.id), true);
    plugin.onFixedUpdatePost(DT);
    expect(sensor.occupied).toBe(true);

    plugin.dispose();

    expect(mock.onSensorEvent).toBeNull();               // handler unwired (identity rule)
    expect(manager.physicsManagedSensors).toBeNull();    // seam nulled (own set only)
    // The stale presence never leaks into a rebuild: a fresh build starts free.
    mock.sensorBoxes.length = 0;
    physicsSettings.enabled = true;
    const plugin2 = await builtPlugin(manager);
    mu.physicsOwned = true; // still owned; no events fired in the new world
    plugin2.onFixedUpdatePost(DT);
    expect(sensor.occupied).toBe(false);
    plugin2.dispose();
  });
});

// ─── Real Rapier WASM: end-to-end sensor fall-through (Phase 5) ─────────────
//
// An MU free-falls through a physics-managed collision sensor: the provider
// drains enter/leave through the EventQueue, the plugin's per-tick scan feeds
// `applyPhysicsResult`, and `sensor.onChanged` fires TRUE then FALSE in order.

describe('real Rapier WASM — sensor fall-through (skips when not installed)', () => {
  beforeEach(() => {
    RVPhysicsZone.clearAll();
    physicsSettings.enabled = true;
  });

  afterEach(() => {
    RVPhysicsZone.clearAll();
    physicsRegistry.register(null);
    physicsSettings.enabled = false;
  });

  it('falling MU fires onChanged enter then leave in order', async () => {
    const provider = new RapierPhysicsProvider();
    physicsRegistry.register(provider);

    const manager = createManager();
    // Thin light-curtain volume on the fall path (the MU passes through and
    // keeps falling — no floor needed).
    const sensor = createCollisionSensor('S1', 0, 1, 0, new Vector3(0.3, 0.05, 0.3));
    sensor.PhysicsMode = true;
    manager.sensors.push(sensor);
    createZone([0, 1, 0], [10, 10, 10]); // y ∈ [-4, 6]

    const plugin = new PhysicsZonePlugin();
    plugin.onModelLoaded(fakeLoadResult(manager), fakeViewer(manager));
    await plugin.buildPromise;
    if (!provider.ready) {
      console.warn('[physics] @dimforge/rapier3d-compat not installed (out-of-band) — skipping');
      plugin.dispose();
      return;
    }

    const changes: boolean[] = [];
    sensor.onChanged = (occupied) => changes.push(occupied);

    // Free MU above the sensor — the no-driver branch hands it over on the
    // first tick (zone overlap, v = 0) and gravity does the rest.
    const mu = createMU('part', 0, 2, 0);
    manager.mus.push(mu);

    for (let t = 0; t < 120; t++) { // 2 s — falls ~19.6 m, well past the sensor
      manager.update(DT);
      plugin.onFixedUpdatePost(DT);
    }

    expect(changes).toEqual([true, false]); // enter, then leave — exactly once each
    expect(provider.failed).toBe(false);

    plugin.dispose();
  }, 30000);
});
