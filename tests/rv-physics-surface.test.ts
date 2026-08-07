// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-physics-surface.test.ts — plan-276 Phase 4 (F5): TransportSurface
 * physics mode.
 *
 * Covers: `PhysicsMode` extras parsing (schema), the world-build surface
 * assignment (full containment → `addConveyor`, partial overlap → kinematic +
 * warning, radial → documented v1 exclusion + warning, `physicsDefault`
 * kill-switch), the immediate handover the moment an MU ENTERS a
 * physics-managed surface, the per-tick `setConveyorVelocity` feed and the
 * settle-return exclusion (an MU resting on a physics surface never returns
 * to the kinematic pipeline).
 *
 * All unit tests run against a MockPhysicsProvider through the public
 * registry (factories from rv-physics-handover.test.ts). One integration test
 * runs against REAL Rapier WASM (skip pattern from rv-physics-lifecycle
 * .test.ts) and validates the conveyor-origin reset strategy: a
 * KinematicVelocityBased belt body carries a dynamic MU for seconds WITHOUT
 * wandering off its authored position.
 *
 * Runs only in the private build (imports `@rv-private/...`).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Box3, Object3D, Scene, Vector3 } from 'three';
import { AABB } from '../src/core/engine/rv-aabb';
import { RVMovingUnit } from '../src/core/engine/rv-mu';
import { RVTransportSurface } from '../src/core/engine/rv-transport-surface';
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
import { PHYSICS_FIXED_DT } from '../src/core/engine/rv-physics-constants';
import type { ComponentContext } from '../src/core/engine/rv-component-registry';
import { PhysicsZonePlugin } from '@rv-private/plugins/physics-zone-plugin';
import { RapierPhysicsProvider } from '@rv-private/physics/rv-rapier-provider';
import type { RVViewer } from '../src/core/rv-viewer';
import type { LoadResult } from '../src/core/engine/rv-scene-loader';

const DT = 1 / 60;
const MU_HALF = new Vector3(0.05, 0.05, 0.05);

// ─── Factories (rv-physics-handover.test.ts pattern) ────────────────────────

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
  name = 'Belt',
): RVTransportSurface {
  const node = new Object3D();
  node.name = name;
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

// ─── Mock provider (extends the handover-test mock by conveyor recording) ───

class MockPhysicsProvider implements PhysicsProvider {
  ready = true;
  failed = false;
  /** Deep-copied snapshots — callers hand in REUSED scratch objects. */
  added: Array<{ muId: string; pose: PhysicsPose; half: PhysicsVec3; vel: PhysicsVec3 }> = [];
  removed: string[] = [];
  conveyors: Array<{ id: string; center: PhysicsVec3; half: PhysicsVec3; quat: PhysicsQuat; friction: number }> = [];
  velocities: Array<{ id: string; vel: PhysicsVec3 }> = [];
  poses = new Map<string, { pos: PhysicsVec3; quat: PhysicsQuat }>();
  settled: string[] = [];
  stepCalls = 0;
  disposeCalls = 0;
  onSensorEvent: ((sensorId: string, muId: string, entered: boolean) => void) | null = null;

  private readonly _outPos: PhysicsVec3 = { x: 0, y: 0, z: 0 };
  private readonly _outQuat: PhysicsQuat = { x: 0, y: 0, z: 0, w: 1 };

  async init(): Promise<void> { this.ready = true; }
  dispose(): void { this.disposeCalls++; this.ready = false; this.poses.clear(); this.conveyors.length = 0; }
  addZone(_id: string, _aabb: PhysicsAABB, _cfg: PhysicsZoneConfig): void {}
  addStaticBox(): void {}
  addConveyor(id: string, center: PhysicsVec3, halfExtents: PhysicsVec3, quat: PhysicsQuat, friction: number): void {
    this.conveyors.push({
      id,
      center: { ...center },
      half: { ...halfExtents },
      quat: { ...quat },
      friction,
    });
  }
  setConveyorVelocity(id: string, vel: PhysicsVec3): void {
    this.velocities.push({ id, vel: { ...vel } });
  }
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
  RVTransportSurface.physicsDefault = true;
  mock = new MockPhysicsProvider();
  physicsRegistry.register(mock);
  physicsSettings.enabled = true;
  physicsSettings.full = false;
});

afterEach(() => {
  RVPhysicsZone.clearAll();
  RVTransportSurface.physicsDefault = true;
  physicsRegistry.register(null);
  physicsSettings.enabled = false;
  physicsSettings.full = false;
  vi.restoreAllMocks();
});

// ─── Tests (plan-276 Phase 4) ───────────────────────────────────────────────

describe('TransportSurface PhysicsMode (Phase 4, F5)', () => {
  it('PhysicsMode parses from extras with a defensive false default (schema)', () => {
    const node = new Object3D();
    const surface = new RVTransportSurface(node, AABB.fromHalfSize(node, new Vector3(1, 0.1, 0.5)));

    // Defensive default — untouched by empty extras.
    expect(surface.PhysicsMode).toBe(false);
    applySchema(surface as unknown as Record<string, unknown>, RVTransportSurface.schema, {});
    expect(surface.PhysicsMode).toBe(false);

    // Authored extras set it.
    applySchema(
      surface as unknown as Record<string, unknown>,
      RVTransportSurface.schema,
      { PhysicsMode: true },
    );
    expect(surface.PhysicsMode).toBe(true);
  });

  it('surface fully inside a zone → addConveyor at build with the zone friction', async () => {
    const manager = createManager();
    const surface = createSurface(0, 0, 0, new Vector3(1, 0.1, 0.5), new Vector3(1, 0, 0), 1000);
    surface.PhysicsMode = true;
    manager.surfaces.push(surface);
    createZone([0, 0.5, 0], [4, 4, 4], { Friction: 0.42 }); // contains the surface fully

    const plugin = await builtPlugin(manager);

    expect(mock.conveyors).toHaveLength(1);
    const belt = mock.conveyors[0];
    expect(belt.friction).toBeCloseTo(0.42);
    expect(belt.center.x).toBeCloseTo(0);
    expect(belt.center.y).toBeCloseTo(0);
    expect(belt.half.x).toBeCloseTo(1);
    expect(belt.half.y).toBeCloseTo(0.1);
    expect(belt.half.z).toBeCloseTo(0.5);
    // Narrow seam injected: the manager knows this surface is physics-managed.
    expect(manager.physicsManagedSurfaces?.has(surface)).toBe(true);

    plugin.dispose();
    expect(manager.physicsManagedSurfaces).toBeNull(); // teardown unhooks
  });

  it('surface partially overlapping a zone stays kinematic (warning, no conveyor)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const manager = createManager();
    // Zone x ∈ [-2, 2]; surface x ∈ [1, 3] → partial overlap only.
    const surface = createSurface(2, 0, 0, new Vector3(1, 0.1, 0.5), new Vector3(1, 0, 0), 1000);
    surface.PhysicsMode = true;
    manager.surfaces.push(surface);
    createZone([0, 0.5, 0], [4, 4, 4]);

    const plugin = await builtPlugin(manager);

    expect(mock.conveyors).toHaveLength(0);
    expect(manager.physicsManagedSurfaces).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/partially overlaps a physics zone/));

    plugin.dispose();
  });

  it('radial surface with PhysicsMode stays kinematic (v1 exclusion, warning)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const manager = createManager();
    const surface = createSurface(0, 0, 0, new Vector3(1, 0.1, 1), new Vector3(0, 1, 0), 90, 'Turntable');
    surface.Radial = true;
    surface.PhysicsMode = true;
    manager.surfaces.push(surface);
    createZone([0, 0.5, 0], [4, 4, 4]);

    const plugin = await builtPlugin(manager);

    expect(mock.conveyors).toHaveLength(0);
    expect(manager.physicsManagedSurfaces).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/radial surface .*not supported \(v1 exclusion\)/));

    plugin.dispose();
  });

  it('physicsDefault=false (deployment kill-switch) keeps every surface kinematic', async () => {
    const manager = createManager();
    const surface = createSurface(0, 0, 0, new Vector3(1, 0.1, 0.5), new Vector3(1, 0, 0), 1000);
    surface.PhysicsMode = true;
    manager.surfaces.push(surface);
    createZone([0, 0.5, 0], [4, 4, 4]);

    RVTransportSurface.physicsDefault = false;
    const plugin = await builtPlugin(manager);

    expect(mock.conveyors).toHaveLength(0);
    expect(manager.physicsManagedSurfaces).toBeNull();

    plugin.dispose();
  });

  it('MU entering a physics-managed surface is handed over IMMEDIATELY with belt velocity', async () => {
    const manager = createManager();
    // Belt x ∈ [-1, 1] running +X at 1 m/s, fully inside the zone.
    const surface = createSurface(0, 0, 0, new Vector3(1, 0.1, 0.5), new Vector3(1, 0, 0), 1000);
    surface.PhysicsMode = true;
    manager.surfaces.push(surface);
    createZone([0, 0.5, 0], [4, 4, 4]);
    const plugin = await builtPlugin(manager);

    // MU at the belt START — NOT the belt end (this is the F5 entry handover).
    const mu = createMU('part', -0.9, 0.15, 0);
    manager.mus.push(mu);
    manager.update(DT);

    expect(mu.physicsOwned).toBe(true);
    expect(mu.physicsBodyId).toBe(String(mu.id));
    expect(mock.added).toHaveLength(1);
    const call = mock.added[0];
    // Belt velocity handover: direction (+X) × 1000 mm/s → 1 m/s.
    expect(call.vel.x).toBeCloseTo(1.0, 5);
    expect(call.vel.y).toBeCloseTo(0, 5);
    expect(call.vel.z).toBeCloseTo(0, 5);
    // Handover ran BEFORE any kinematic advance — pose is the entry pose.
    expect(call.pose.pos.x).toBeCloseTo(-0.9, 6);
    expect(mu.getPosition().x).toBeCloseTo(-0.9, 6);

    // Never re-handed, never kinematically transported afterwards.
    manager.update(DT);
    expect(mock.added).toHaveLength(1);
    expect(mu.getPosition().x).toBeCloseTo(-0.9, 6);

    plugin.dispose();
  });

  it('provider not ready → MU keeps moving kinematically on the surface, hands over once ready', async () => {
    const manager = createManager();
    const surface = createSurface(0, 0, 0, new Vector3(1, 0.1, 0.5), new Vector3(1, 0, 0), 1000);
    surface.PhysicsMode = true;
    manager.surfaces.push(surface);
    createZone([0, 0.5, 0], [4, 4, 4]);
    const plugin = await builtPlugin(manager);

    const mu = createMU('part', -0.9, 0.15, 0);
    manager.mus.push(mu);

    mock.ready = false; // provider (re)loading — self-healing retry (F4 pattern)
    manager.update(DT);
    expect(mu.physicsOwned).toBe(false);
    expect(mu.getPosition().x).toBeGreaterThan(-0.9); // kinematic transport kept it moving

    mock.ready = true;
    manager.update(DT);
    expect(mu.physicsOwned).toBe(true);
    expect(mock.added).toHaveLength(1);

    plugin.dispose();
  });

  it('setConveyorVelocity is fed per tick from the drive speed (direction × speed/1000)', async () => {
    const manager = createManager();
    const surface = createSurface(0, 0, 0, new Vector3(1, 0.1, 0.5), new Vector3(0, 0, 1), 1000);
    surface.PhysicsMode = true;
    manager.surfaces.push(surface);
    createZone([0, 0.5, 0], [4, 4, 4]);
    const plugin = await builtPlugin(manager);
    const conveyorId = mock.conveyors[0].id;

    plugin.onFixedUpdatePost(DT);
    expect(mock.velocities).toHaveLength(1);
    expect(mock.velocities[0].id).toBe(conveyorId);
    expect(mock.velocities[0].vel.z).toBeCloseTo(1.0, 5); // +Z belt at 1 m/s
    expect(mock.velocities[0].vel.x).toBeCloseTo(0, 5);

    // Drive speed change (incl. reversal) is reflected on the NEXT tick.
    (surface.drive as unknown as { currentSpeed: number }).currentSpeed = -500;
    plugin.onFixedUpdatePost(DT);
    expect(mock.velocities).toHaveLength(2);
    expect(mock.velocities[1].vel.z).toBeCloseTo(-0.5, 5);

    plugin.dispose();
  });

  it('settle return ignores physics-managed surfaces — MU resting there stays physicsOwned', async () => {
    const manager = createManager();
    // Physics-managed belt (top y = 0.1) + a KINEMATIC control belt far away.
    const physSurface = createSurface(0, 0, 0, new Vector3(1, 0.1, 0.5), new Vector3(1, 0, 0), 0);
    physSurface.PhysicsMode = true;
    manager.surfaces.push(physSurface);
    const kinSurface = createSurface(6, 0, 0, new Vector3(1, 0.1, 0.5), new Vector3(1, 0, 0), 0, 'KinBelt');
    manager.surfaces.push(kinSurface);
    createZone([0, 0.5, 0], [4, 4, 4]);
    const plugin = await builtPlugin(manager);

    const mu = createMU('part', 0.5, 0.15, 0);
    mu.physicsOwned = true;
    mu.physicsBodyId = String(mu.id);
    manager.mus.push(mu);
    manager.update(DT);

    const id = String(mu.id);
    // Resting exactly on the PHYSICS surface top (would satisfy the return
    // criterion if the surface were kinematic).
    mock.poses.set(id, { pos: { x: 0.5, y: 0.15, z: 0 }, quat: { x: 0, y: 0, z: 0, w: 1 } });
    mock.settled = [id];
    plugin.onFixedUpdatePost(DT);

    expect(mu.physicsOwned).toBe(true); // physics surface — MU is correct there
    expect(mock.removed).not.toContain(id);

    // Control: the SAME pose over the kinematic belt DOES return.
    mock.poses.set(id, { pos: { x: 6.5, y: 0.15, z: 0 }, quat: { x: 0, y: 0, z: 0, w: 1 } });
    plugin.onFixedUpdatePost(DT);
    expect(mu.physicsOwned).toBe(false);
    expect(mock.removed).toContain(id);

    plugin.dispose();
  });
});

// ─── Full physics (F17, Beta) ───────────────────────────────────────────────

describe('Full physics — all conveyors (F17, Beta)', () => {
  it('full+enabled: ALL non-radial surfaces become conveyors despite PhysicsMode=false', async () => {
    physicsSettings.full = true;
    const manager = createManager();
    const beltA = createSurface(0, 0, 0, new Vector3(1, 0.1, 0.5), new Vector3(1, 0, 0), 1000, 'BeltA');
    const beltB = createSurface(4, 0, 0, new Vector3(1, 0.1, 0.5), new Vector3(1, 0, 0), 500, 'BeltB');
    expect(beltA.PhysicsMode).toBe(false); // instance flag overridden by full
    manager.surfaces.push(beltA, beltB);
    // NO explicit zone: full ensures the synthetic WholeScene zone.

    const plugin = await builtPlugin(manager);

    expect(RVPhysicsZone.zones.some((z) => z.WholeScene)).toBe(true);
    expect(mock.conveyors).toHaveLength(2);
    expect(manager.physicsManagedSurfaces?.has(beltA)).toBe(true);
    expect(manager.physicsManagedSurfaces?.has(beltB)).toBe(true);

    plugin.dispose();
    expect(manager.physicsManagedSurfaces).toBeNull();
  });

  it('full overrides explicit box zones: synthetic WholeScene zone is added anyway', async () => {
    physicsSettings.full = true;
    const manager = createManager();
    // Explicit zone x ∈ [-2, 2] with custom friction — first-wins priority.
    createZone([0, 0.5, 0], [4, 4, 4], { Friction: 0.42 });
    const inside = createSurface(0, 0, 0, new Vector3(1, 0.1, 0.5), new Vector3(1, 0, 0), 1000, 'Inside');
    // Outside the explicit zone — only the synthetic WholeScene zone covers it.
    const outside = createSurface(6, 0, 0, new Vector3(1, 0.1, 0.5), new Vector3(1, 0, 0), 1000, 'Outside');
    manager.surfaces.push(inside, outside);

    const plugin = await builtPlugin(manager);

    expect(RVPhysicsZone.zones.some((z) => z.WholeScene)).toBe(true);
    expect(mock.conveyors).toHaveLength(2);
    // First-wins (F2): the surface inside the explicit zone keeps ITS config;
    // the outside surface falls to the synthetic zone's F16 default (0.8).
    const byName = new Map(mock.conveyors.map((c) => [c.id.split(':')[2], c.friction]));
    expect(byName.get('Inside')).toBeCloseTo(0.42);
    expect(byName.get('Outside')).toBeCloseTo(0.8);

    plugin.dispose();
  });

  it('radial surfaces stay kinematic with ONE collective warning (not per surface)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    physicsSettings.full = true;
    const manager = createManager();
    const turntableA = createSurface(0, 0, 0, new Vector3(1, 0.1, 1), new Vector3(0, 1, 0), 90, 'TurntableA');
    turntableA.Radial = true;
    const turntableB = createSurface(4, 0, 0, new Vector3(1, 0.1, 1), new Vector3(0, 1, 0), 90, 'TurntableB');
    turntableB.Radial = true;
    manager.surfaces.push(turntableA, turntableB);

    const plugin = await builtPlugin(manager);

    expect(mock.conveyors).toHaveLength(0);
    expect(manager.physicsManagedSurfaces).toBeNull();
    const radialWarnings = warn.mock.calls.filter(
      (c) => typeof c[0] === 'string' && /full physics \(Beta\).*radial/.test(c[0] as string),
    );
    expect(radialWarnings).toHaveLength(1); // ONE collective warning
    expect(radialWarnings[0][0]).toContain('2 radial surface(s)');

    plugin.dispose();
  });

  it('physicsDefault=false (deployment kill-switch) wins over full physics', async () => {
    physicsSettings.full = true;
    RVTransportSurface.physicsDefault = false;
    const manager = createManager();
    const belt = createSurface(0, 0, 0, new Vector3(1, 0.1, 0.5), new Vector3(1, 0, 0), 1000);
    belt.PhysicsMode = true; // even an authored flag stays ineffective
    manager.surfaces.push(belt);

    const plugin = await builtPlugin(manager);

    expect(mock.conveyors).toHaveLength(0);
    expect(manager.physicsManagedSurfaces).toBeNull();

    plugin.dispose();
  });

  it('full without enabled: the plugin never builds (strict AND, F17)', async () => {
    physicsSettings.enabled = false;
    physicsSettings.full = true; // must be ineffective on its own
    const manager = createManager();
    const belt = createSurface(0, 0, 0, new Vector3(1, 0.1, 0.5), new Vector3(1, 0, 0), 1000);
    manager.surfaces.push(belt);

    const plugin = new PhysicsZonePlugin();
    plugin.onModelLoaded(fakeLoadResult(manager), fakeViewer(manager));
    expect(plugin.buildPromise).toBeNull(); // gate closed — no async build
    await plugin.buildPromise;

    expect(RVPhysicsZone.zones).toHaveLength(0); // no synthetic zone either
    expect(mock.conveyors).toHaveLength(0);
    expect(manager.physicsManagedSurfaces).toBeNull();

    plugin.dispose();
  });

  it('full=false regression: PhysicsMode=false surface inside a zone stays kinematic', async () => {
    const manager = createManager();
    const belt = createSurface(0, 0, 0, new Vector3(1, 0.1, 0.5), new Vector3(1, 0, 0), 1000);
    manager.surfaces.push(belt); // PhysicsMode defaults to false
    createZone([0, 0.5, 0], [4, 4, 4]);

    const plugin = await builtPlugin(manager);

    expect(mock.conveyors).toHaveLength(0);
    expect(manager.physicsManagedSurfaces).toBeNull();

    plugin.dispose();
  });
});

// ─── Real Rapier WASM: conveyor-origin reset strategy (Phase 4) ─────────────
//
// Validates the plan gotcha: KinematicVelocityBased bodies physically
// TRANSLATE with their velocity (spike: 0.9 m in 3 s). The provider snaps a
// moving belt back onto its spawn origin every tick BEFORE world.step() while
// the velocity keeps producing the friction take-along — the MU must be
// carried for seconds WITHOUT the conveyor body wandering away.

describe('real Rapier WASM — conveyor origin reset (skips when not installed)', () => {
  async function initRealProvider(): Promise<RapierPhysicsProvider | null> {
    const provider = new RapierPhysicsProvider();
    provider.addZone(
      'z1',
      { min: { x: -5, y: -1, z: -5 }, max: { x: 5, y: 5, z: 5 } },
      { friction: 0.8, restitution: 0, removeBelowY: -10 },
    );
    try {
      await provider.init();
    } catch {
      console.warn('[physics] @dimforge/rapier3d-compat not installed (out-of-band) — skipping');
      return null;
    }
    return provider;
  }

  it('dynamic MU is carried for 3 s while the belt body stays on its origin', async () => {
    const provider = await initRealProvider();
    if (!provider) return;
    try {
      // Belt top at y = 0, x ∈ [-2, 2]; MU (half 0.1) starts at the belt start.
      provider.addConveyor(
        'belt',
        { x: 0, y: -0.05, z: 0 },
        { x: 2, y: 0.05, z: 0.5 },
        { x: 0, y: 0, z: 0, w: 1 },
        1.5,
      );
      provider.addDynamicMU(
        'mu1',
        { pos: { x: -1.5, y: 0.1, z: 0 }, quat: { x: 0, y: 0, z: 0, w: 1 } },
        { x: 0.1, y: 0.1, z: 0.1 },
        { x: 0, y: 0, z: 0 },
      );

      const belt: PhysicsVec3 = { x: 0.5, y: 0, z: 0 }; // 0.5 m/s +X
      let posX = 0;
      let posY = 0;
      const read = (): void => {
        provider.syncPoses((id, p) => {
          if (id === 'mu1') { posX = p.x; posY = p.y; }
        });
      };

      let xAfter2s = 0;
      for (let i = 0; i < 180; i++) { // 3 s @ 60 Hz
        provider.setConveyorVelocity('belt', belt);
        provider.step(PHYSICS_FIXED_DT);
        if (i === 119) { read(); xAfter2s = posX; }
      }
      read();

      // 1. The belt body did NOT wander: without the reset it would sit at
      //    x ≈ 1.5 after 3 s (spike measurement). With the per-tick origin
      //    reset it stays within one tick of travel (0.5 m/s / 60 ≈ 8.3 mm).
      const t = provider.getConveyorTranslation('belt');
      expect(t).not.toBeNull();
      expect(Math.abs(t!.x)).toBeLessThan(0.02);
      expect(t!.y).toBeCloseTo(-0.05, 3);
      expect(Math.abs(t!.z)).toBeLessThan(0.001);

      // 2. Friction take-along works across the resets: over the final second
      //    the MU travels ≈ belt speed (0.5 m ± 20%)...
      const lastSecondTravel = posX - xAfter2s;
      expect(lastSecondTravel).toBeGreaterThan(0.4);
      expect(lastSecondTravel).toBeLessThan(0.6);
      // ...with substantial net travel from the start (pickup is near-instant
      //    per the Phase-0 spike, so ~1.5 m in 3 s).
      expect(posX).toBeGreaterThan(-0.5);

      // 3. The MU never fell through the belt (rest height ≈ half extent).
      expect(posY).toBeGreaterThan(0.05);
      expect(posY).toBeLessThan(0.15);
    } finally {
      provider.dispose();
    }
  }, 30000);
});
