// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-physics-lifecycle.test.ts — plan-276 test 9.4 (Phase-1 subset).
 *
 * Provider lifecycle guards against the REAL RapierPhysicsProvider with a
 * mocked RapierLibLoader (fake World/Body in pure TS — no WASM): init/dispose,
 * double init (promise reuse), dispose during pending init, fail-off after a
 * step() exception, idempotent two-phase removal, settle/upright detection,
 * sensor-event handle mapping.
 *
 * Plus two integration tests against REAL Rapier WASM via the out-of-band URL
 * import (skip pattern from `physics-spike-handover.test.ts` — the suite skips
 * gracefully when `@dimforge/rapier3d-compat` is not installed).
 *
 * Phase 3 adds the PhysicsZonePlugin lifecycle guards (plan-276 9.4 rest):
 * reset-chokepoint ordering (F14), DES mode switch end-to-end (F11),
 * multiuser disable (F12), model-clear teardown and the F16 WholeScene
 * synthesis — driven with a fake viewer + real EventEmitter (pattern:
 * clipping-plugin-lifecycle.test.ts) against a MockPhysicsProvider.
 *
 * Runs only in the private build (imports `@rv-private/physics/*`).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Box3, Object3D, Scene, Vector3 } from 'three';
import { RapierPhysicsProvider } from '@rv-private/physics/rv-rapier-provider';
import { PhysicsZonePlugin } from '@rv-private/plugins/physics-zone-plugin';
import { EventEmitter } from '../src/core/rv-events';
import { AABB } from '../src/core/engine/rv-aabb';
import { RVMovingUnit } from '../src/core/engine/rv-mu';
import { RVSensor } from '../src/core/engine/rv-sensor';
import { RVTransportManager } from '../src/core/engine/rv-transport-manager';
import { RVPhysicsZone } from '../src/core/engine/rv-physics-zone';
import {
  physicsRegistry,
  physicsSettings,
  type IPhysicsMUHook,
  type PhysicsAABB,
  type PhysicsProvider,
  type PhysicsRayHit,
  type PhysicsVec3 as PubPhysicsVec3,
  type PhysicsZoneConfig,
} from '../src/core/engine/rv-physics-registry';
import type { ComponentContext } from '../src/core/engine/rv-component-registry';
import type { RVViewer } from '../src/core/rv-viewer';
import type { LoadResult } from '../src/core/engine/rv-scene-loader';
import {
  setRapierLibLoader,
  type RapierColliderDesc,
  type RapierEventQueue,
  type RapierLib,
  type RapierQuat,
  type RapierRigidBody,
  type RapierRigidBodyDesc,
  type RapierVec3,
} from '@rv-private/physics/rapier-lib-loader';
import {
  PHYSICS_FIXED_DT,
  PHYSICS_SETTLE_FRAMES,
  PHYSICS_SETTLE_LIN_VEL,
  PHYSICS_UPRIGHT_TOLERANCE_DEG,
} from '../src/core/engine/rv-physics-constants';
import type { PhysicsPose, PhysicsQuat, PhysicsVec3 } from '../src/core/engine/rv-physics-registry';

// ─── Shared fixtures ─────────────────────────────────────────────────────────

const Q_IDENT: PhysicsQuat = { x: 0, y: 0, z: 0, w: 1 };
/** 90° roll about Z — clearly beyond the 25° upright tolerance. */
const Q_TIPPED: PhysicsQuat = { x: 0, y: 0, z: Math.SQRT1_2, w: Math.SQRT1_2 };
const HE: PhysicsVec3 = { x: 0.1, y: 0.1, z: 0.1 };
const V0: PhysicsVec3 = { x: 0, y: 0, z: 0 };

function pose(x: number, y: number, z: number, quat: PhysicsQuat = Q_IDENT): PhysicsPose {
  return { pos: { x, y, z }, quat };
}

// ─── Minimal fake Rapier (pure TS — tests provider LOGIC without WASM) ──────

let nextColliderHandle = 0;

class FakeBody implements RapierRigidBody {
  pos: RapierVec3;
  rot: RapierQuat;
  vel: RapierVec3;
  constructor(pos: RapierVec3, rot: RapierQuat, vel: RapierVec3) {
    this.pos = { ...pos };
    this.rot = { ...rot };
    this.vel = { ...vel };
  }
  translation(): RapierVec3 { return this.pos; }
  rotation(): RapierQuat { return this.rot; }
  linvel(): RapierVec3 { return this.vel; }
  setLinvel(vel: RapierVec3, _wakeUp: boolean): void { this.vel = { ...vel }; }
  setTranslation(t: RapierVec3, _wakeUp: boolean): void { this.pos = { ...t }; }
}

class FakeDesc implements RapierRigidBodyDesc {
  pos: RapierVec3 = { x: 0, y: 0, z: 0 };
  rot: RapierQuat = { x: 0, y: 0, z: 0, w: 1 };
  vel: RapierVec3 = { x: 0, y: 0, z: 0 };
  constructor(readonly kind: 'dynamic' | 'fixed' | 'kinematic') {}
  setTranslation(x: number, y: number, z: number): FakeDesc { this.pos = { x, y, z }; return this; }
  setRotation(q: RapierQuat): FakeDesc { this.rot = { ...q }; return this; }
  setLinvel(x: number, y: number, z: number): FakeDesc { this.vel = { x, y, z }; return this; }
}

class FakeColliderDesc implements RapierColliderDesc {
  sensor = false;
  friction: number | null = null;
  restitution: number | null = null;
  activeEvents: number | null = null;
  constructor(readonly hx: number, readonly hy: number, readonly hz: number) {}
  setFriction(f: number): FakeColliderDesc { this.friction = f; return this; }
  setFrictionCombineRule(_r: number): FakeColliderDesc { return this; }
  setRestitution(r: number): FakeColliderDesc { this.restitution = r; return this; }
  setSensor(s: boolean): FakeColliderDesc { this.sensor = s; return this; }
  setActiveEvents(e: number): FakeColliderDesc { this.activeEvents = e; return this; }
}

class FakeEventQueue implements RapierEventQueue {
  freed = false;
  pending: Array<[number, number, boolean]> = [];
  drainCollisionEvents(cb: (h1: number, h2: number, started: boolean) => void): void {
    const events = this.pending;
    this.pending = [];
    for (const [h1, h2, started] of events) cb(h1, h2, started);
  }
  free(): void { this.freed = true; }
}

class FakeWorld {
  static instances: FakeWorld[] = [];
  timestep = 0;
  gravity: RapierVec3;
  bodies = new Set<FakeBody>();
  colliderHandles: number[] = [];
  stepCount = 0;
  removeCalls = 0;
  freed = false;
  throwOnStep = false;
  constructor(gravity: RapierVec3) {
    this.gravity = { ...gravity };
    FakeWorld.instances.push(this);
  }
  step(_eventQueue?: RapierEventQueue): void {
    this.stepCount++;
    if (this.throwOnStep) throw new Error('fake WASM panic');
  }
  createRigidBody(desc: RapierRigidBodyDesc): FakeBody {
    const d = desc as FakeDesc;
    const body = new FakeBody(d.pos, d.rot, d.vel);
    this.bodies.add(body);
    return body;
  }
  createCollider(_desc: RapierColliderDesc, _parent?: RapierRigidBody): { handle: number } {
    const handle = nextColliderHandle++;
    this.colliderHandles.push(handle);
    return { handle };
  }
  removeRigidBody(body: RapierRigidBody): void {
    this.removeCalls++;
    this.bodies.delete(body as FakeBody);
  }
  castRay(): null { return null; }
  free(): void { this.freed = true; }
}

class FakeRay {
  constructor(public origin: RapierVec3, public dir: RapierVec3) {}
}

const fakeQueues: FakeEventQueue[] = [];

function makeFakeLib(): RapierLib {
  return {
    init: async () => {},
    World: FakeWorld as unknown as RapierLib['World'],
    EventQueue: class extends FakeEventQueue {
      constructor(_autoDrain: boolean) {
        super();
        fakeQueues.push(this);
      }
    } as unknown as RapierLib['EventQueue'],
    Ray: FakeRay as unknown as RapierLib['Ray'],
    RigidBodyDesc: {
      dynamic: () => new FakeDesc('dynamic'),
      fixed: () => new FakeDesc('fixed'),
      kinematicVelocityBased: () => new FakeDesc('kinematic'),
    },
    ColliderDesc: {
      cuboid: (hx: number, hy: number, hz: number) => new FakeColliderDesc(hx, hy, hz),
    },
    CoefficientCombineRule: { Max: 3 },
    ActiveEvents: { COLLISION_EVENTS: 1 },
    QueryFilterFlags: { EXCLUDE_SENSORS: 8 },
  };
}

// ─── Lifecycle against the fake lib ──────────────────────────────────────────

describe('RapierPhysicsProvider lifecycle (mocked RapierLibLoader — no WASM)', () => {
  let loaderCalls = 0;

  beforeEach(() => {
    FakeWorld.instances.length = 0;
    fakeQueues.length = 0;
    nextColliderHandle = 0;
    loaderCalls = 0;
    setRapierLibLoader(async () => {
      loaderCalls++;
      return makeFakeLib();
    });
  });

  afterEach(() => {
    setRapierLibLoader(null); // restore default URL loader + clear cache
    vi.restoreAllMocks();
  });

  it('init creates ONE world with fixed timestep and sets ready', async () => {
    const provider = new RapierPhysicsProvider();
    expect(provider.ready).toBe(false);
    await provider.init();
    expect(provider.ready).toBe(true);
    expect(provider.failed).toBe(false);
    expect(FakeWorld.instances.length).toBe(1);
    expect(FakeWorld.instances[0].timestep).toBe(PHYSICS_FIXED_DT);
  });

  it('gravity comes from the FIRST registered zone (default when omitted)', async () => {
    const provider = new RapierPhysicsProvider();
    provider.addZone(
      'z1',
      { min: { x: -1, y: -1, z: -1 }, max: { x: 1, y: 1, z: 1 } },
      { friction: 0.5, restitution: 0, removeBelowY: -10, gravity: { x: 0, y: -1.62, z: 0 } },
    );
    await provider.init();
    expect(FakeWorld.instances[0].gravity.y).toBeCloseTo(-1.62);
    provider.dispose();

    const provider2 = new RapierPhysicsProvider();
    await provider2.init();
    expect(FakeWorld.instances[1].gravity.y).toBeCloseTo(-9.81);
    provider2.dispose();
  });

  it('double init reuses the SAME promise — loader runs once, one world', async () => {
    const provider = new RapierPhysicsProvider();
    const p1 = provider.init();
    const p2 = provider.init();
    expect(p2).toBe(p1);
    await Promise.all([p1, p2]);
    await provider.init(); // post-completion init reuses the resolved promise
    expect(loaderCalls).toBe(1);
    expect(FakeWorld.instances.length).toBe(1);
  });

  it('dispose during pending init aborts cleanly (no world, not ready)', async () => {
    let release: ((lib: RapierLib) => void) | null = null;
    setRapierLibLoader(() => new Promise<RapierLib>((resolve) => { release = resolve; }));
    const provider = new RapierPhysicsProvider();
    const pending = provider.init();
    provider.dispose(); // while the loader promise is still pending
    release!(makeFakeLib());
    await pending;
    expect(provider.ready).toBe(false);
    expect(FakeWorld.instances.length).toBe(0); // world was never created
  });

  it('dispose frees world + event queue, clears handles, allows re-init', async () => {
    const provider = new RapierPhysicsProvider();
    await provider.init();
    provider.addDynamicMU('mu1', pose(0, 1, 0), HE, V0);
    provider.dispose();
    expect(provider.ready).toBe(false);
    expect(FakeWorld.instances[0].freed).toBe(true);
    expect(fakeQueues[0].freed).toBe(true);

    // All handles cleared: nothing left to sync.
    const synced: string[] = [];
    provider.syncPoses((muId) => synced.push(muId));
    expect(synced).toEqual([]);

    // Fresh init after dispose builds a NEW world.
    await provider.init();
    expect(provider.ready).toBe(true);
    expect(FakeWorld.instances.length).toBe(2);
    provider.dispose();
  });

  it('fail-off: first step() exception → failed=true, ONE error log, never steps again', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const provider = new RapierPhysicsProvider();
    await provider.init();
    provider.addDynamicMU('mu1', pose(0, 1, 0), HE, V0);
    FakeWorld.instances[0].throwOnStep = true;

    provider.step(PHYSICS_FIXED_DT);
    expect(provider.failed).toBe(true);
    expect(errSpy).toHaveBeenCalledTimes(1);

    provider.step(PHYSICS_FIXED_DT);
    provider.step(PHYSICS_FIXED_DT);
    expect(FakeWorld.instances[0].stepCount).toBe(1); // no-op after fail-off
    expect(errSpy).toHaveBeenCalledTimes(1);          // no log spam

    // failed also gates the other entry points.
    provider.addDynamicMU('mu2', pose(0, 1, 0), HE, V0);
    const synced: string[] = [];
    provider.syncPoses((muId) => synced.push(muId));
    expect(synced).toEqual([]);
    expect(provider.getSettledBodies(0.01, 25)).toEqual([]);
  });

  it('removeBody is idempotent two-phase: exactly one removeRigidBody at end of step', async () => {
    const provider = new RapierPhysicsProvider();
    await provider.init();
    provider.addDynamicMU('mu1', pose(0, 1, 0), HE, V0);
    const world = FakeWorld.instances[0];

    provider.removeBody('mu1');
    provider.removeBody('mu1'); // double mark — harmless (Set)
    expect(world.removeCalls).toBe(0); // not yet — two-phase

    // Marked bodies are logically gone before the flush.
    const synced: string[] = [];
    provider.syncPoses((muId) => synced.push(muId));
    expect(synced).toEqual([]);

    provider.step(PHYSICS_FIXED_DT); // flush at end of step
    expect(world.removeCalls).toBe(1);

    provider.removeBody('mu1'); // unknown now — no-op
    provider.step(PHYSICS_FIXED_DT);
    expect(world.removeCalls).toBe(1);
  });

  it('step skips the solver when no dynamic bodies exist', async () => {
    const provider = new RapierPhysicsProvider();
    await provider.init();
    provider.addStaticBox('floor', { x: 0, y: -0.1, z: 0 }, { x: 5, y: 0.1, z: 5 }, Q_IDENT);
    provider.step(PHYSICS_FIXED_DT);
    expect(FakeWorld.instances[0].stepCount).toBe(0);
    provider.addDynamicMU('mu1', pose(0, 1, 0), HE, V0);
    provider.step(PHYSICS_FIXED_DT); // handed over THIS tick — steps immediately
    expect(FakeWorld.instances[0].stepCount).toBe(1);
  });

  it('getSettledBodies: N consecutive calm ticks + upright discriminator', async () => {
    const provider = new RapierPhysicsProvider();
    await provider.init();
    provider.addDynamicMU('calm-upright', pose(0, 0.1, 0), HE, V0);
    provider.addDynamicMU('calm-tipped', pose(1, 0.1, 0, Q_TIPPED), HE, V0);
    provider.addDynamicMU('moving', pose(2, 0.1, 0), HE, { x: 0.5, y: 0, z: 0 });

    for (let t = 1; t < PHYSICS_SETTLE_FRAMES; t++) {
      expect(provider.getSettledBodies(PHYSICS_SETTLE_LIN_VEL, PHYSICS_UPRIGHT_TOLERANCE_DEG)).toEqual([]);
    }
    const settled = provider.getSettledBodies(PHYSICS_SETTLE_LIN_VEL, PHYSICS_UPRIGHT_TOLERANCE_DEG);
    expect(settled).toEqual(['calm-upright']); // tipped stays physicsOwned (F7), moving is not calm
  });

  it('sensor events map collider handles to sensorId/muId in both orders', async () => {
    const provider = new RapierPhysicsProvider();
    await provider.init();
    provider.addSensorBox('s1', { x: 0, y: 0.3, z: 0 }, { x: 0.2, y: 0.05, z: 0.2 }, Q_IDENT); // handle 0
    provider.addDynamicMU('mu1', pose(0, 1, 0), HE, V0); // handle 1
    const events: Array<[string, string, boolean]> = [];
    provider.onSensorEvent = (sensorId, muId, entered) => events.push([sensorId, muId, entered]);

    fakeQueues[0].pending.push([0, 1, true]);  // sensor first
    provider.step(PHYSICS_FIXED_DT);
    fakeQueues[0].pending.push([1, 0, false]); // MU first (swapped order)
    provider.step(PHYSICS_FIXED_DT);

    expect(events).toEqual([
      ['s1', 'mu1', true],
      ['s1', 'mu1', false],
    ]);
  });

  it('MU friction/restitution come from the containing zone config', async () => {
    const provider = new RapierPhysicsProvider();
    provider.addZone(
      'z1',
      { min: { x: -5, y: -5, z: -5 }, max: { x: 5, y: 5, z: 5 } },
      { friction: 0.33, restitution: 0.25, removeBelowY: -10 },
    );
    await provider.init();
    // FakeColliderDesc records what the provider set — verify via world colliders.
    const descSpy: FakeColliderDesc[] = [];
    const world = FakeWorld.instances[0];
    const origCreate = world.createCollider.bind(world);
    world.createCollider = (desc, parent) => {
      descSpy.push(desc as FakeColliderDesc);
      return origCreate(desc, parent);
    };
    provider.addDynamicMU('mu1', pose(0, 1, 0), HE, V0);
    expect(descSpy[0].friction).toBeCloseTo(0.33);
    expect(descSpy[0].restitution).toBeCloseTo(0.25);
  });
});

// ─── Integration against REAL Rapier WASM (out-of-band, graceful skip) ──────

describe('RapierPhysicsProvider × real Rapier WASM (out-of-band)', () => {
  beforeEach(() => setRapierLibLoader(null)); // default URL-import loader
  afterEach(() => setRapierLibLoader(null));

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

  it('full lifecycle: drop MU on static floor → settle upright → remove → dispose', async () => {
    const provider = await initRealProvider();
    if (!provider) return;
    try {
      // Floor top at y=0; MU (half extent 0.1) dropped from y=0.5 with belt velocity.
      provider.addStaticBox('floor', { x: 0, y: -0.1, z: 0 }, { x: 5, y: 0.1, z: 5 }, Q_IDENT);
      provider.addDynamicMU('mu1', pose(0, 0.5, 0), HE, { x: 0.5, y: 0, z: 0 });

      let lastY = Number.NaN;
      let settled: string[] = [];
      for (let t = 0; t < 240 && settled.length === 0; t++) {
        provider.step(PHYSICS_FIXED_DT);
        provider.syncPoses((muId, pos) => {
          if (muId === 'mu1') lastY = pos.y;
        });
        settled = provider.getSettledBodies(PHYSICS_SETTLE_LIN_VEL, PHYSICS_UPRIGHT_TOLERANCE_DEG);
      }
      expect(settled).toContain('mu1');
      // Rest center ≈ half extent 0.1 (± solver penetration slack, spike: ~1.3 mm).
      expect(Math.abs(lastY - 0.1)).toBeLessThan(0.02);

      provider.removeBody('mu1');
      provider.removeBody('mu1'); // idempotent against real WASM
      provider.step(PHYSICS_FIXED_DT); // flush + world keeps stepping cleanly
      const synced: string[] = [];
      provider.syncPoses((muId) => synced.push(muId));
      expect(synced).toEqual([]);
      for (let t = 0; t < 10; t++) provider.step(PHYSICS_FIXED_DT);
      expect(provider.failed).toBe(false);
    } finally {
      provider.dispose();
      expect(provider.ready).toBe(false);
    }
  }, 30000);

  it('real sensor events: falling MU fires enter and leave through the EventQueue', async () => {
    const provider = await initRealProvider();
    if (!provider) return;
    try {
      provider.addStaticBox('floor', { x: 0, y: -0.1, z: 0 }, { x: 5, y: 0.1, z: 5 }, Q_IDENT);
      // Sensor volume on the fall path (center y=0.3) — the cube passes through
      // and finally rests below it (cube top 0.2 < sensor bottom 0.25).
      provider.addSensorBox('s1', { x: 0, y: 0.3, z: 0 }, { x: 0.3, y: 0.05, z: 0.3 }, Q_IDENT);
      const events: Array<[string, string, boolean]> = [];
      provider.onSensorEvent = (sensorId, muId, entered) => events.push([sensorId, muId, entered]);

      provider.addDynamicMU('mu1', pose(0, 0.8, 0), HE, V0);
      for (let t = 0; t < 240; t++) provider.step(PHYSICS_FIXED_DT);

      expect(events.length).toBeGreaterThanOrEqual(2);
      expect(events[0]).toEqual(['s1', 'mu1', true]);
      expect(events[events.length - 1]).toEqual(['s1', 'mu1', false]);
      expect(provider.failed).toBe(false);
    } finally {
      provider.dispose();
    }
  }, 30000);
});

// ─── PhysicsZonePlugin lifecycle guards (plan-276 Phase 3, 9.4 rest) ────────

const DT = 1 / 60;

/** Compact recording mock against the PUBLIC provider contract. */
class PluginMockProvider implements PhysicsProvider {
  ready = false;
  failed = false;
  initCalls = 0;
  disposeCalls = 0;
  stepCalls = 0;
  addedZones: string[] = [];
  addedMUs: string[] = [];
  removedMUs: string[] = [];
  sensorBoxes: string[] = [];
  onSensorEvent: ((sensorId: string, muId: string, entered: boolean) => void) | null = null;
  async init(): Promise<void> { this.initCalls++; this.ready = true; }
  dispose(): void { this.disposeCalls++; this.ready = false; this.addedZones = []; }
  addZone(id: string, _aabb: PhysicsAABB, _cfg: PhysicsZoneConfig): void { this.addedZones.push(id); }
  addStaticBox(): void {}
  addConveyor(): void {}
  setConveyorVelocity(): void {}
  addDynamicMU(muId: string): void { this.addedMUs.push(muId); }
  removeBody(muId: string): void { this.removedMUs.push(muId); }
  addSensorBox(id: string): void { this.sensorBoxes.push(id); }
  castRay(): PhysicsRayHit | null { return null; }
  step(): void { this.stepCalls++; }
  syncPoses(_out: (muId: string, pos: PubPhysicsVec3, quat: PhysicsQuat) => void): void {}
  getSettledBodies(): string[] { return []; }
}

interface FakeViewerHandle {
  viewer: RVViewer;
  emit: (event: string, data: unknown) => void;
  multiuser: { isConnected: boolean } | undefined;
}

function makeFakeViewer(tm: RVTransportManager): FakeViewerHandle {
  const emitter = new EventEmitter();
  const handle: FakeViewerHandle = {
    multiuser: undefined,
    emit: (event, data) => emitter.emit(event, data),
    viewer: {
      transportManager: tm,
      registry: { getNode: () => null },
      gizmoManager: undefined,
      simulationKernel: null,
      getPlugin: (id: string) => (id === 'multiuser' ? handle.multiuser : undefined),
      on: emitter.on.bind(emitter),
      emit: emitter.emit.bind(emitter),
    } as unknown as RVViewer,
  };
  return handle;
}

function makeLoadResult(tm: RVTransportManager, bbox?: Box3): LoadResult {
  return {
    root: new Object3D(),
    boundingBox: bbox ?? new Box3(new Vector3(-5, -1, -5), new Vector3(5, 4, 5)),
    transportManager: tm,
    registry: { getNode: () => null },
    drives: [],
  } as unknown as LoadResult;
}

function makeTM(): RVTransportManager {
  const tm = new RVTransportManager();
  tm.scene = new Scene();
  return tm;
}

function ownedMU(tm: RVTransportManager, name: string, x = 0, y = 1, z = 0): RVMovingUnit {
  const node = new Object3D();
  node.name = name;
  node.position.set(x, y, z);
  const mu = new RVMovingUnit(node, 'test-source', new Vector3(0.05, 0.05, 0.05));
  mu.physicsOwned = true;
  mu.physicsBodyId = String(mu.id);
  tm.mus.push(mu);
  return mu;
}

/** Register an explicit box zone (loader-equivalent init). */
function makeZone(center: [number, number, number], size: [number, number, number]): RVPhysicsZone {
  const node = new Object3D();
  node.name = 'Zone';
  node.position.set(...center);
  node.updateMatrixWorld(true);
  const aabb = AABB.fromBoxCollider(node, { x: 0, y: 0, z: 0 }, { x: size[0], y: size[1], z: size[2] });
  const zone = new RVPhysicsZone(node, aabb);
  zone.ShowGizmo = false;
  zone.init({ gizmoManager: undefined } as unknown as ComponentContext);
  return zone;
}

describe('PhysicsZonePlugin lifecycle guards (plan-276 Phase 3)', () => {
  let mock: PluginMockProvider;

  beforeEach(() => {
    RVPhysicsZone.clearAll();
    mock = new PluginMockProvider();
    physicsRegistry.register(mock);
    physicsSettings.enabled = true;
  });

  afterEach(() => {
    RVPhysicsZone.clearAll();
    physicsRegistry.register(null);
    physicsSettings.enabled = false;
  });

  it('sim reset (transportManager.reset) calls onMUDisposed for every physicsOwned MU BEFORE dispose', () => {
    const tm = makeTM();
    const a = ownedMU(tm, 'a');
    const b = ownedMU(tm, 'b');
    const free = ownedMU(tm, 'free');
    free.physicsOwned = false; // one non-owned MU — the hook must stay harmless
    free.physicsBodyId = null;

    const sequence: string[] = [];
    const hook: IPhysicsMUHook = {
      onMUDisposed(mu) {
        sequence.push(`hook:${mu.getName()}`);
        if (mu.physicsBodyId) mock.removeBody(mu.physicsBodyId);
        mu.physicsBodyId = null;
        mu.physicsOwned = false;
      },
    };
    tm.physicsMUHook = hook;
    for (const mu of [a, b, free]) {
      const orig = mu.dispose.bind(mu);
      mu.dispose = () => { sequence.push(`dispose:${mu.getName()}`); orig(); };
    }

    tm.reset();

    // Hook precedes dispose for EVERY MU (F14 — reset chokepoint order).
    expect(sequence).toEqual([
      'hook:a', 'dispose:a',
      'hook:b', 'dispose:b',
      'hook:free', 'dispose:free',
    ]);
    expect(mock.removedMUs.sort()).toEqual([String(a.id), String(b.id)].sort());
    expect(tm.mus).toHaveLength(0);
  });

  it('kernel setMode("des") ends with zero live bodies and disposed provider (world.free)', async () => {
    const tm = makeTM();
    makeZone([0, 1, 0], [4, 4, 4]);
    const fake = makeFakeViewer(tm);
    const plugin = new PhysicsZonePlugin();
    plugin.onModelLoaded(makeLoadResult(tm), fake.viewer);
    await plugin.buildPromise;
    expect(mock.initCalls).toBe(1);
    expect(tm.physicsMUHook).toBe(plugin);

    const mu = ownedMU(tm, 'part');
    plugin.onFixedUpdatePost(DT); // adopts the MU + steps once
    expect(mock.stepCalls).toBe(1);

    // setMode('des') runs clearMUs() BEFORE the mode event fires (plan-276
    // §2.2) — simulated in that exact order here.
    tm.reset();
    expect(mock.removedMUs).toContain(String(mu.id)); // body freed by the chokepoint
    fake.emit('simulation-mode-changed', { mode: 'des' });

    expect(mock.disposeCalls).toBe(1); // world.free() equivalent
    expect(tm.physicsMUHook).toBeNull();
    const steps = mock.stepCalls;
    plugin.onFixedUpdatePost(DT); // plugin is inactive — never steps again
    expect(mock.stepCalls).toBe(steps);

    plugin.dispose();
  });

  it('return to continuous mode rebuilds the physics world from zones', async () => {
    const tm = makeTM();
    makeZone([0, 1, 0], [4, 4, 4]);
    const fake = makeFakeViewer(tm);
    const plugin = new PhysicsZonePlugin();
    plugin.onModelLoaded(makeLoadResult(tm), fake.viewer);
    await plugin.buildPromise;
    expect(mock.addedZones).toHaveLength(1);

    tm.reset();
    fake.emit('simulation-mode-changed', { mode: 'des' });
    expect(mock.disposeCalls).toBe(1);

    fake.emit('simulation-mode-changed', { mode: 'continuous' });
    await plugin.buildPromise;

    expect(mock.initCalls).toBe(2);          // world rebuilt
    expect(mock.addedZones).toHaveLength(1); // zones re-added after dispose cleared them
    expect(tm.physicsMUHook).toBe(plugin);

    plugin.dispose();
  });

  it('model cleared disposes provider and clears all body handles', async () => {
    const tm = makeTM();
    makeZone([0, 1, 0], [4, 4, 4]);
    const fake = makeFakeViewer(tm);
    const plugin = new PhysicsZonePlugin();
    plugin.onModelLoaded(makeLoadResult(tm), fake.viewer);
    await plugin.buildPromise;
    ownedMU(tm, 'part');
    plugin.onFixedUpdatePost(DT);

    plugin.onModelCleared(fake.viewer);

    expect(mock.disposeCalls).toBe(1);
    expect(RVPhysicsZone.zones).toHaveLength(0); // module-static registry cleared (gotcha 1)
    expect(tm.physicsMUHook).toBeNull();
    const steps = mock.stepCalls;
    plugin.onFixedUpdatePost(DT);
    expect(mock.stepCalls).toBe(steps);
  });

  it('active multiuser/live connection disables physics entirely (no init, no step)', async () => {
    const tm = makeTM();
    makeZone([0, 1, 0], [4, 4, 4]);
    const fake = makeFakeViewer(tm);
    fake.multiuser = { isConnected: true }; // Unity is authority (mu_sync ~50 Hz)

    const plugin = new PhysicsZonePlugin();
    plugin.onModelLoaded(makeLoadResult(tm), fake.viewer);
    await plugin.buildPromise; // null — but await keeps the test honest

    expect(mock.initCalls).toBe(0);
    plugin.onFixedUpdatePost(DT);
    expect(mock.stepCalls).toBe(0);

    // Disconnect → rebuild (F12).
    fake.multiuser = { isConnected: false };
    fake.emit('multiuser-changed', { connected: false });
    await plugin.buildPromise;
    expect(mock.initCalls).toBe(1);

    // Reconnect → full teardown.
    fake.multiuser = { isConnected: true };
    fake.emit('multiuser-changed', { connected: true });
    expect(mock.disposeCalls).toBe(1);

    plugin.dispose();
  });

  it('F16: toggle ON + no zones in the model → synthetic WholeScene zone from scene bounds', async () => {
    const tm = makeTM();
    const fake = makeFakeViewer(tm);
    const plugin = new PhysicsZonePlugin();
    const bbox = new Box3(new Vector3(-3, 0.5, -2), new Vector3(3, 2.5, 2));
    plugin.onModelLoaded(makeLoadResult(tm, bbox), fake.viewer);
    await plugin.buildPromise;

    expect(RVPhysicsZone.zones).toHaveLength(1);
    const zone = RVPhysicsZone.zones[0];
    expect(zone.WholeScene).toBe(true);
    expect(zone.active).toBe(true);
    expect(zone.worldAabb).toEqual({
      min: { x: -3, y: 0.5, z: -2 },
      max: { x: 3, y: 2.5, z: 2 },
    });
    // F16 defaults: Friction 0.8, Restitution 0, RemoveBelowY = min.y − 10, no gizmo.
    expect(zone.Friction).toBeCloseTo(0.8);
    expect(zone.Restitution).toBe(0);
    expect(zone.RemoveBelowY).toBeCloseTo(0.5 - 10);
    expect(zone.ShowGizmo).toBe(false);
    expect(mock.initCalls).toBe(1);
    expect(mock.addedZones).toHaveLength(1);

    plugin.dispose();
  });

  it('F16: toggle OFF → strict no-op (no synthesis, no init)', async () => {
    physicsSettings.enabled = false;
    const tm = makeTM();
    const fake = makeFakeViewer(tm);
    const plugin = new PhysicsZonePlugin();
    plugin.onModelLoaded(makeLoadResult(tm), fake.viewer);
    await plugin.buildPromise;

    expect(RVPhysicsZone.zones).toHaveLength(0); // nothing synthesized
    expect(mock.initCalls).toBe(0);
    plugin.onFixedUpdatePost(DT);
    expect(mock.stepCalls).toBe(0);

    plugin.dispose();
  });

  it('sensor onChanged fires from provider sensor events (SensorMonitor + recorder compat)', async () => {
    const tm = makeTM();
    makeZone([0, 1, 0], [4, 4, 4]);
    // Collision-mode physics sensor inside the zone. onChanged is the seam
    // SensorMonitorPlugin and rv-sensor-recorder hang off (F6).
    const node = new Object3D();
    node.name = 'S1';
    node.position.set(0, 1, 0);
    node.updateMatrixWorld(true);
    const sensor = new RVSensor(node, AABB.fromHalfSize(node, new Vector3(0.2, 0.1, 0.2)));
    sensor.PhysicsMode = true;
    tm.sensors.push(sensor);
    const changes: boolean[] = [];
    sensor.onChanged = (occupied) => changes.push(occupied);

    const fake = makeFakeViewer(tm);
    const plugin = new PhysicsZonePlugin();
    plugin.onModelLoaded(makeLoadResult(tm), fake.viewer);
    await plugin.buildPromise;

    expect(mock.sensorBoxes).toHaveLength(1);
    const sensorId = mock.sensorBoxes[0];
    expect(tm.physicsManagedSensors?.has(sensor)).toBe(true);
    // The plugin wired ITS handler into the provider (fired during step()).
    expect(mock.onSensorEvent).not.toBeNull();

    const mu = ownedMU(tm, 'part', 3, 1, 0); // physics-owned, away from the sensor
    plugin.onFixedUpdatePost(DT); // adopts the MU into the body map

    // Enter event (drained during step) → occupied + onChanged(true).
    mock.onSensorEvent!(sensorId, String(mu.id), true);
    plugin.onFixedUpdatePost(DT);
    expect(sensor.occupied).toBe(true);
    expect(sensor.occupiedMU).toBe(mu);
    expect(changes).toEqual([true]);

    // Leave event → cleared + onChanged(false); no re-fire on further ticks.
    mock.onSensorEvent!(sensorId, String(mu.id), false);
    plugin.onFixedUpdatePost(DT);
    plugin.onFixedUpdatePost(DT);
    expect(sensor.occupied).toBe(false);
    expect(changes).toEqual([true, false]);

    plugin.dispose();
    expect(mock.onSensorEvent).toBeNull(); // teardown unwires its own handler
    expect(tm.physicsManagedSensors).toBeNull();
  });
});
