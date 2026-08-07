// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-physics-handover.test.ts — plan-276 test 9.3 (Phase 3).
 *
 * The core of the feature: kinematic → physics handover at conveyor ends
 * (F4), the physicsOwned ownership exclusions (transport skip, accumulation
 * queries, grips — F15), the physics → kinematic settle return (F7), sink
 * consumption + RemoveBelowY (F9).
 *
 * All tests run against a MockPhysicsProvider through the public registry —
 * no WASM (factories from rv-transport.test.ts; the settle/RemoveBelowY
 * scenarios drive the real PhysicsZonePlugin with a fake viewer, pattern:
 * clipping-plugin-lifecycle.test.ts).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Box3, Object3D, Scene, Vector3 } from 'three';
import { AABB } from '../src/core/engine/rv-aabb';
import { RVMovingUnit } from '../src/core/engine/rv-mu';
import { RVTransportSurface } from '../src/core/engine/rv-transport-surface';
import { RVTransportManager } from '../src/core/engine/rv-transport-manager';
import { RVSink } from '../src/core/engine/rv-sink';
import { RVGrip } from '../src/core/engine/rv-grip';
import { RVPhysicsZone } from '../src/core/engine/rv-physics-zone';
import { EventEmitter } from '../src/core/rv-events';
import {
  physicsRegistry,
  physicsSettings,
  type IPhysicsMUHook,
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
import type { RVViewer } from '../src/core/rv-viewer';
import type { LoadResult } from '../src/core/engine/rv-scene-loader';

const DT = 1 / 60;
const MU_HALF = new Vector3(0.05, 0.05, 0.05);

// ─── Factories (rv-transport.test.ts pattern) ───────────────────────────────

function createMU(name: string, x: number, y: number, z: number): RVMovingUnit {
  const node = new Object3D();
  node.name = name;
  node.position.set(x, y, z);
  return new RVMovingUnit(node, 'test-source', MU_HALF.clone());
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
  surface.reapplyConfig();
  surface.initTransport();
  surface.drive = { currentSpeed: speed, name: 'mock-drive' } as unknown as RVTransportSurface['drive'];
  return surface;
}

function createManager(): RVTransportManager {
  const manager = new RVTransportManager();
  manager.scene = new Scene();
  return manager;
}

/** Explicit box zone registered like the loader does (init pass). */
function createZone(
  center: [number, number, number],
  size: [number, number, number],
  extras?: Partial<Pick<RVPhysicsZone, 'Friction' | 'Restitution' | 'RemoveBelowY' | 'ZoneEnabled'>>,
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
  Object.assign(zone, extras);
  zone.ShowGizmo = false;
  zone.init({ gizmoManager: undefined } as unknown as ComponentContext);
  return zone;
}

// ─── Mock provider (records calls; test-controlled poses/settled set) ───────

class MockPhysicsProvider implements PhysicsProvider {
  ready = true;
  failed = false;
  initCalls = 0;
  stepCalls = 0;
  /** Deep-copied snapshots — the manager hands in REUSED scratch objects. */
  added: Array<{ muId: string; pose: PhysicsPose; half: PhysicsVec3; vel: PhysicsVec3 }> = [];
  removed: string[] = [];
  zones: Array<{ id: string; aabb: PhysicsAABB; cfg: PhysicsZoneConfig }> = [];
  staticBoxes: Array<{ id: string; center: PhysicsVec3; half: PhysicsVec3 }> = [];
  /** Test-controlled world state consumed by syncPoses/getSettledBodies. */
  poses = new Map<string, { pos: PhysicsVec3; quat: PhysicsQuat }>();
  settled: string[] = [];
  disposeCalls = 0;
  onSensorEvent: ((sensorId: string, muId: string, entered: boolean) => void) | null = null;

  private readonly _outPos: PhysicsVec3 = { x: 0, y: 0, z: 0 };
  private readonly _outQuat: PhysicsQuat = { x: 0, y: 0, z: 0, w: 1 };

  async init(): Promise<void> { this.initCalls++; this.ready = true; }
  dispose(): void { this.disposeCalls++; this.ready = false; this.poses.clear(); }
  addZone(id: string, aabb: PhysicsAABB, cfg: PhysicsZoneConfig): void {
    this.zones.push({ id, aabb: { min: { ...aabb.min }, max: { ...aabb.max } }, cfg: { ...cfg } });
  }
  addStaticBox(id: string, center: PhysicsVec3, halfExtents: PhysicsVec3): void {
    this.staticBoxes.push({ id, center: { ...center }, half: { ...halfExtents } });
  }
  addConveyor(): void {}
  setConveyorVelocity(): void {}
  addDynamicMU(muId: string, pose: PhysicsPose, halfExtents: PhysicsVec3, initialVel: PhysicsVec3): void {
    this.added.push({
      muId,
      pose: { pos: { ...pose.pos }, quat: { ...pose.quat } },
      half: { x: halfExtents.x, y: halfExtents.y, z: halfExtents.z },
      vel: { x: initialVel.x, y: initialVel.y, z: initialVel.z },
    });
    this.poses.set(muId, { pos: { ...pose.pos }, quat: { ...pose.quat } });
  }
  removeBody(muId: string): void {
    this.removed.push(muId);
    this.poses.delete(muId);
  }
  addSensorBox(): void {}
  castRay(): PhysicsRayHit | null { return null; }
  step(): void { this.stepCalls++; }
  syncPoses(out: (muId: string, pos: PhysicsVec3, quat: PhysicsQuat) => void): void {
    for (const [muId, p] of this.poses) {
      // Reused objects — mirrors the real provider's zero-GC contract.
      this._outPos.x = p.pos.x; this._outPos.y = p.pos.y; this._outPos.z = p.pos.z;
      this._outQuat.x = p.quat.x; this._outQuat.y = p.quat.y;
      this._outQuat.z = p.quat.z; this._outQuat.w = p.quat.w;
      out(muId, this._outPos, this._outQuat);
    }
  }
  getSettledBodies(): string[] { return [...this.settled]; }
}

// ─── Fake viewer for the PhysicsZonePlugin (clipping-plugin pattern) ────────

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
    boundingBox: new Box3(new Vector3(-10, -1, -10), new Vector3(10, 5, 10)),
    transportManager: tm,
    registry: { getNode: () => null },
    drives: [],
  } as unknown as LoadResult;
}

/** Build the plugin against `tm` + `mock` and await the async world build. */
async function builtPlugin(tm: RVTransportManager, mock: MockPhysicsProvider): Promise<PhysicsZonePlugin> {
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
});

// ─── Tests (plan-276 §9.3) ──────────────────────────────────────────────────

describe('physics handover', () => {
  it('MU reaching conveyor end inside zone becomes physicsOwned with belt velocity', () => {
    const manager = createManager();
    // Belt x ∈ [-1, 1] running +X at 1 m/s; zone box covers the discharge area.
    const surface = createSurface(0, 0, 0, new Vector3(1, 0.1, 0.5), new Vector3(1, 0, 0), 1000);
    manager.surfaces.push(surface);
    createZone([1.5, 0, 0], [2, 2, 2]);

    const mu = createMU('part', 0.9, 0, 0);
    manager.mus.push(mu);

    for (let i = 0; i < 30 && !mu.physicsOwned; i++) manager.update(DT);

    expect(mu.physicsOwned).toBe(true);
    expect(mu.physicsBodyId).toBe(String(mu.id));
    expect(mock.added).toHaveLength(1);
    const call = mock.added[0];
    expect(call.muId).toBe(String(mu.id));
    // Belt velocity handover: direction (+X) × 1000 mm/s → 1 m/s.
    expect(call.vel.x).toBeCloseTo(1.0, 5);
    expect(call.vel.y).toBeCloseTo(0, 5);
    expect(call.vel.z).toBeCloseTo(0, 5);
    // Pose = the MU's world pose at the handover moment; half extents = AABB.
    expect(call.pose.pos.x).toBeCloseTo(mu.getPosition().x, 6);
    expect(call.half.x).toBeCloseTo(0.05, 6);

    // Ownership: the kinematic pipeline no longer advances it.
    const x = mu.getPosition().x;
    manager.update(DT);
    expect(mu.getPosition().x).toBe(x);
    expect(mock.added).toHaveLength(1); // no double handover
  });

  it('handover with stopped belt (speed=0) passes zero velocity, still hands over', () => {
    const manager = createManager();
    const surface = createSurface(0, 0, 0, new Vector3(1, 0.1, 0.5), new Vector3(1, 0, 0), 0);
    manager.surfaces.push(surface);
    createZone([1.5, 0, 0], [2, 2, 2]);

    // Parked beyond the belt end (e.g. pushed there before the belt stopped);
    // the sticky lastSurface is what the velocity is derived from (F4).
    const mu = createMU('part', 1.2, 0, 0);
    mu.lastSurface = surface;
    manager.mus.push(mu);

    manager.update(DT);

    expect(mu.physicsOwned).toBe(true);
    expect(mock.added).toHaveLength(1);
    expect(mock.added[0].vel).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('MU with zone AABB-overlap only (not fully contained) still hands over — no mid-air freeze', () => {
    const manager = createManager();
    // Zone starts at x = 1.18: the MU AABB [1.15, 1.25] only PARTIALLY
    // reaches it — full containment would freeze the MU mid-air (F4).
    createZone([2.18, 0, 0], [2, 2, 2]); // x ∈ [1.18, 3.18]
    const mu = createMU('part', 1.2, 0, 0);
    manager.mus.push(mu);

    manager.update(DT);

    expect(mu.aabb.min.x).toBeLessThan(1.18); // truly only partial overlap
    expect(mu.physicsOwned).toBe(true);
    expect(mock.added).toHaveLength(1);
  });

  it('provider not ready at conveyor end → MU stays kinematic, retries next tick, no crash', () => {
    const manager = createManager();
    createZone([1.5, 0, 0], [2, 2, 2]);
    const mu = createMU('part', 1.2, 0, 0);
    manager.mus.push(mu);

    mock.ready = false; // provider still loading
    manager.update(DT);
    manager.update(DT);
    expect(mu.physicsOwned).toBe(false);
    expect(mock.added).toHaveLength(0);

    mock.ready = true; // self-healing every-tick retry (F4)
    manager.update(DT);
    expect(mu.physicsOwned).toBe(true);
    expect(mock.added).toHaveLength(1);

    // failed provider (fail-off) also blocks the handover permanently.
    mock.failed = true;
    const mu2 = createMU('part2', 1.4, 0, 0);
    manager.mus.push(mu2);
    manager.update(DT);
    expect(mu2.physicsOwned).toBe(false);
    expect(mock.added).toHaveLength(1);
  });

  it('physicsOwned MU is skipped by kinematic transport AND by queryLeadingMU/isAreaOccupiedByMU', () => {
    const manager = createManager();
    const surface = createSurface(0, 0, 0, new Vector3(2, 0.1, 0.5), new Vector3(1, 0, 0), 1000);
    manager.surfaces.push(surface);

    const owned = createMU('owned', 0.5, 0, 0);
    owned.physicsOwned = true;
    owned.physicsBodyId = String(owned.id);
    const free = createMU('free', 0, 0, 0);
    manager.mus.push(owned, free);

    const ownedX = owned.getPosition().x;
    manager.update(DT);
    expect(owned.getPosition().x).toBe(ownedX);          // not transported
    expect(free.getPosition().x).toBeGreaterThan(0);     // kinematic path unchanged

    // Accumulation queries ignore physics-owned MUs (no gap-clamp double logic).
    const out: (typeof owned)[] = [];
    const n = manager.queryLeadingMU(free, new Vector3(1, 0, 0), 2, out);
    expect(n).toBe(0);
    expect(out).toHaveLength(0);

    const area = new AABB();
    area.min.set(0.4, -0.1, -0.1);
    area.max.set(0.6, 0.1, 0.1);
    expect(manager.isAreaOccupiedByMU(area)).toBe(false);
  });

  it('physicsOwned skip happens AFTER mu.blocked=false reset (no stale blocked flags)', () => {
    const manager = createManager();
    const mu = createMU('part', 0, 0, 0);
    mu.physicsOwned = true;
    mu.blocked = true; // stale flag from the tick before the handover
    manager.mus.push(mu);

    manager.update(DT);

    expect(mu.blocked).toBe(false); // reset ran BEFORE the ownership skip
    expect(manager.blockedMuCount).toBe(0);
  });

  it('settled upright MU over kinematic surface returns to kinematic pipeline with exact pose', async () => {
    const manager = createManager();
    // Surface top at y = 0.1; return pose rests the MU bottom exactly there.
    const surface = createSurface(0, 0, 0, new Vector3(1, 0.1, 0.5), new Vector3(1, 0, 0), 0);
    manager.surfaces.push(surface);
    createZone([0, 1, 0], [4, 4, 4]);

    const plugin = await builtPlugin(manager, mock);
    const mu = createMU('part', 0.5, 1, 0);
    mu.physicsOwned = true;
    mu.physicsBodyId = String(mu.id);
    manager.mus.push(mu);
    manager.update(DT); // AABB/grid bookkeeping

    // Rest pose from the provider: y = 0.148 (solver slack — NOT the "ideal"
    // 0.15). The return must take it 1:1, no snap.
    const id = String(mu.id);
    mock.poses.set(id, {
      pos: { x: 0.5, y: 0.148, z: 0.01 },
      quat: { x: 0, y: 0, z: 0, w: 1 },
    });
    plugin.onFixedUpdatePost(DT); // adopt + sync (not yet settled)
    expect(mu.physicsOwned).toBe(true);

    mock.settled = [id];
    plugin.onFixedUpdatePost(DT);

    expect(mu.physicsOwned).toBe(false);
    expect(mu.physicsBodyId).toBeNull();
    expect(mock.removed).toContain(id);
    // Pose 1:1 — the solver's rest pose is kept exactly (no snap).
    expect(mu.getPosition().x).toBeCloseTo(0.5, 6);
    expect(mu.getPosition().y).toBeCloseTo(0.148, 6);
    expect(mu.getPosition().z).toBeCloseTo(0.01, 6);

    plugin.dispose();
  });

  it('tipped-over MU (upright check fails) stays physicsOwned and rests', async () => {
    const manager = createManager();
    const surface = createSurface(0, 0, 0, new Vector3(1, 0.1, 0.5), new Vector3(1, 0, 0), 0);
    manager.surfaces.push(surface);
    createZone([0, 1, 0], [4, 4, 4]);

    const plugin = await builtPlugin(manager, mock);
    const mu = createMU('part', 0.5, 0.15, 0);
    mu.physicsOwned = true;
    mu.physicsBodyId = String(mu.id);
    manager.mus.push(mu);
    manager.update(DT);

    const id = String(mu.id);
    mock.poses.set(id, { pos: { x: 0.5, y: 0.148, z: 0 }, quat: { x: 0, y: 0, z: 0, w: 1 } });
    // The provider filters tipped bodies itself (upright discriminator) —
    // getSettledBodies never returns them, so the MU keeps resting owned.
    mock.settled = [];
    for (let i = 0; i < 30; i++) plugin.onFixedUpdatePost(DT);

    expect(mu.physicsOwned).toBe(true);
    expect(mock.removed).not.toContain(id);

    // Same for a settled body with NO surface underneath (rests inside the zone).
    mock.poses.set(id, { pos: { x: 0.5, y: 2.0, z: 3 }, quat: { x: 0, y: 0, z: 0, w: 1 } });
    mock.settled = [id];
    plugin.onFixedUpdatePost(DT);
    expect(mu.physicsOwned).toBe(true);

    plugin.dispose();
  });

  it('MU reaching conveyor end OUTSIDE any zone keeps legacy behavior', () => {
    const manager = createManager();
    const surface = createSurface(0, 0, 0, new Vector3(1, 0.1, 0.5), new Vector3(1, 0, 0), 1000);
    manager.surfaces.push(surface);
    createZone([50, 0, 0], [2, 2, 2]); // zone far away

    const mu = createMU('part', 0.9, 0, 0);
    manager.mus.push(mu);

    for (let i = 0; i < 60; i++) manager.update(DT);

    expect(mu.physicsOwned).toBe(false);
    expect(mock.added).toHaveLength(0);
    expect(mu.currentSurface).toBeNull(); // ran off the end — legacy rest
  });

  it('sink consumes physicsOwned MU: removeBody before mu.dispose; double-mark is idempotent', () => {
    const manager = createManager();
    const sinkNode = new Object3D();
    sinkNode.position.set(2, 0, 0);
    const sink = new RVSink(sinkNode, AABB.fromHalfSize(sinkNode, new Vector3(0.5, 0.5, 0.5)));
    manager.sinks.push(sink);

    const mu = createMU('part', 2, 0, 0);
    mu.physicsOwned = true;
    mu.physicsBodyId = String(mu.id);
    manager.mus.push(mu);

    // Recording chokepoint hook (F14) + dispose-order probe.
    const sequence: string[] = [];
    const hook: IPhysicsMUHook = {
      onMUDisposed(m) {
        sequence.push('hook');
        if (m.physicsBodyId) mock.removeBody(m.physicsBodyId);
        m.physicsBodyId = null;
        m.physicsOwned = false;
      },
    };
    manager.physicsMUHook = hook;
    const origDispose = mu.dispose.bind(mu);
    mu.dispose = () => { sequence.push('dispose'); origDispose(); };

    // External sink path stays active for physics-owned MUs (F9): AABB overlap
    // marks it; double-marking (sink again next tick) is idempotent.
    sink.markOverlapping([mu]); // pre-mark — proves idempotence
    manager.update(DT);

    expect(sequence).toEqual(['hook', 'dispose']); // body freed BEFORE dispose
    expect(mock.removed).toEqual([String(mu.id)]); // exactly once
    expect(manager.mus).toHaveLength(0);
    expect(manager.totalConsumed).toBe(1);
  });

  it('MU below RemoveBelowY is marked for removal', async () => {
    const manager = createManager();
    createZone([0, 1, 0], [4, 4, 4], { RemoveBelowY: -2 });

    const plugin = await builtPlugin(manager, mock);
    const mu = createMU('part', 0, 1, 0);
    mu.physicsOwned = true;
    mu.physicsBodyId = String(mu.id);
    manager.mus.push(mu);
    manager.update(DT);

    const id = String(mu.id);
    // Fell OUT of the zone box and below the limit (fallback = min RemoveBelowY).
    mock.poses.set(id, { pos: { x: 0, y: -3, z: 0 }, quat: { x: 0, y: 0, z: 0, w: 1 } });
    plugin.onFixedUpdatePost(DT);
    expect(mu.markedForRemoval).toBe(true);

    // Next transport tick removes it through the chokepoint hook (F14).
    manager.update(DT);
    expect(manager.mus).toHaveLength(0);
    expect(mock.removed).toContain(id);

    plugin.dispose();
  });

  it('grip pick/autoPlace/findNearestMU ignore physicsOwned MUs', () => {
    const gripNode = new Object3D();
    gripNode.position.set(0, 0, 0);
    const grip = new RVGrip(gripNode);

    const owned = createMU('owned', 0, 0, 0);
    owned.updateAABB();
    owned.physicsOwned = true;
    const free = createMU('free', 0.02, 0, 0);
    free.updateAABB();

    grip.allMUs = () => [owned];
    grip.allGripTargets = () => [];

    // pick()/findNearestMU: the only candidate is physics-owned → no grip.
    grip.pick();
    expect(grip.grippedMUs).toHaveLength(0);
    expect(owned.isGripped).toBe(false);

    // A free MU IS picked under identical conditions (gate is specific).
    grip.allMUs = () => [owned, free];
    grip.pick();
    expect(grip.grippedMUs).toEqual([free]);

    // autoPlace ignores the impossible physics-owned combination defensively:
    // force the state and place — the MU is neither re-parented nor released.
    free.physicsOwned = true;
    const parentBefore = free.node.parent;
    grip.place();
    expect(free.node.parent).toBe(parentBefore);
    expect(grip.grippedMUs).toEqual([free]); // still held (place was refused)
  });
});
