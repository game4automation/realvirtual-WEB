// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-physics-kinematic-body.test.ts — plan-467 test 9.2 (Phase 2).
 *
 * The REAL `RapierPhysicsProvider` against a FAKE Rapier lib (pure TS, no
 * WASM — pattern: rv-physics-lifecycle.test.ts). What it pins is the provider's
 * own decisions, all of which are invisible from the outside and expensive to
 * get wrong:
 *
 *  - moving parts become `kinematicPositionBased` bodies, NOT
 *    `kinematicVelocityBased` (those integrate and drift — that is the conveyor
 *    body type),
 *  - the Unity BoxCollider `center` reaches Rapier as a collider translation
 *    RELATIVE to the body (SOL R1 #6: without it an off-centre box collides at
 *    the node origin),
 *  - a degenerate convex hull skips ONE part with a warning instead of taking
 *    physics down (F2),
 *  - the pose push uses `setNextKinematic*` — a plain `setTranslation` would
 *    teleport and push nothing (F3),
 *  - MUs get an EXPLICIT mass and CCD (F16; Rapier's density default gives the
 *    0.2 m demo cube 8 g, and there is no CCD between kinematic and dynamic
 *    bodies — rapier#303).
 *
 * Runs only in the private build (imports `@rv-private/physics/*`).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RapierPhysicsProvider } from '@rv-private/physics/rv-rapier-provider';
import {
  setRapierLibLoader,
  type RapierCollider,
  type RapierColliderDesc,
  type RapierContactManifold,
  type RapierEventQueue,
  type RapierLib,
  type RapierQuat,
  type RapierRay,
  type RapierRigidBody,
  type RapierRigidBodyDesc,
  type RapierVec3,
  type RapierWorld,
} from '@rv-private/physics/rapier-lib-loader';
import { PHYSICS_DEFAULT_MU_MASS_KG } from '../src/core/engine/rv-physics-constants';
import type { PhysicsPose, PhysicsQuat, PhysicsShape, PhysicsVec3 } from '../src/core/engine/rv-physics-registry';

const Q_IDENT: PhysicsQuat = { x: 0, y: 0, z: 0, w: 1 };
const HE: PhysicsVec3 = { x: 0.1, y: 0.1, z: 0.1 };
const V0: PhysicsVec3 = { x: 0, y: 0, z: 0 };

function pose(x: number, y: number, z: number, quat: PhysicsQuat = Q_IDENT): PhysicsPose {
  return { pos: { x, y, z }, quat };
}

function cuboid(localOffset: PhysicsVec3 = { x: 0, y: 0, z: 0 }): PhysicsShape {
  return { kind: 'cuboid', halfExtents: { x: 0.5, y: 0.2, z: 0.3 }, localOffset };
}

// ─── Fake Rapier ────────────────────────────────────────────────────────────

let nextColliderHandle = 0;
/** Set to `true` to make `ColliderDesc.convexHull()` report a degenerate hull. */
let hullIsDegenerate = false;

class FakeBody implements RapierRigidBody {
  pos: RapierVec3;
  rot: RapierQuat;
  vel: RapierVec3 = { x: 0, y: 0, z: 0 };
  /** Every `setNextKinematic*` target, in call order. */
  readonly nextTranslations: RapierVec3[] = [];
  readonly nextRotations: RapierQuat[] = [];
  /** Teleports — must stay EMPTY for a moving part (F3). */
  readonly teleports: RapierVec3[] = [];
  sleeping = false;
  constructor(readonly desc: FakeDesc) {
    this.pos = { ...desc.pos };
    this.rot = { ...desc.rot };
    this.vel = { ...desc.vel };
  }
  translation(): RapierVec3 { return this.pos; }
  rotation(): RapierQuat { return this.rot; }
  linvel(): RapierVec3 { return this.vel; }
  mass(): number { return 1; }
  isSleeping(): boolean { return this.sleeping; }
  setLinvel(vel: RapierVec3): void { this.vel = { ...vel }; }
  setTranslation(t: RapierVec3): void { this.teleports.push({ ...t }); this.pos = { ...t }; }
  // Snapshot, not reference: the provider hands out module-lifetime scratch.
  setNextKinematicTranslation(t: RapierVec3): void { this.nextTranslations.push({ ...t }); }
  setNextKinematicRotation(r: RapierQuat): void { this.nextRotations.push({ ...r }); }
  setSoftCcdPrediction(_distance: number): void { /* not under test here */ }
  setRotation(_r: RapierQuat, _wake: boolean): void { /* not under test here */ }
}

type BodyKind = 'dynamic' | 'fixed' | 'kinematicVelocity' | 'kinematicPosition';

class FakeDesc implements RapierRigidBodyDesc {
  pos: RapierVec3 = { x: 0, y: 0, z: 0 };
  rot: RapierQuat = { x: 0, y: 0, z: 0, w: 1 };
  vel: RapierVec3 = { x: 0, y: 0, z: 0 };
  ccd = false;
  constructor(readonly kind: BodyKind) {}
  setTranslation(x: number, y: number, z: number): FakeDesc { this.pos = { x, y, z }; return this; }
  setRotation(q: RapierQuat): FakeDesc { this.rot = { ...q }; return this; }
  setLinvel(x: number, y: number, z: number): FakeDesc { this.vel = { x, y, z }; return this; }
  setCcdEnabled(e: boolean): FakeDesc { this.ccd = e; return this; }
  /** plan-2219: soft-CCD look-ahead of the dynamic MU (recorded, not simulated). */
  softCcd = 0;
  setSoftCcdPrediction(d: number): FakeDesc { this.softCcd = d; return this; }
}

class FakeColliderDesc implements RapierColliderDesc {
  friction: number | null = null;
  restitution: number | null = null;
  sensor = false;
  activeEvents: number | null = null;
  mass: number | null = null;
  translation: RapierVec3 | null = null;
  constructor(
    readonly shape: 'cuboid' | 'convexHull',
    readonly half: RapierVec3 | null,
    readonly points: Float32Array | null,
  ) {}
  setFriction(f: number): FakeColliderDesc { this.friction = f; return this; }
  setFrictionCombineRule(): FakeColliderDesc { return this; }
  setRestitution(r: number): FakeColliderDesc { this.restitution = r; return this; }
  setSensor(s: boolean): FakeColliderDesc { this.sensor = s; return this; }
  setActiveEvents(e: number): FakeColliderDesc { this.activeEvents = e; return this; }
  setTranslation(x: number, y: number, z: number): FakeColliderDesc { this.translation = { x, y, z }; return this; }
  setMass(m: number): FakeColliderDesc { this.mass = m; return this; }
}

interface FakeColliderRec extends RapierCollider { desc: FakeColliderDesc; body: FakeBody }

class FakeWorld implements RapierWorld {
  timestep = 1 / 60;
  gravity: RapierVec3 = { x: 0, y: -9.81, z: 0 };
  integrationParameters = { numSolverIterations: 4 };
  readonly bodies: FakeBody[] = [];
  readonly colliders: FakeColliderRec[] = [];
  readonly removed: FakeBody[] = [];
  step(): void {}
  createRigidBody(desc: RapierRigidBodyDesc): RapierRigidBody {
    const body = new FakeBody(desc as FakeDesc);
    this.bodies.push(body);
    return body;
  }
  createCollider(desc: RapierColliderDesc, parent?: RapierRigidBody): RapierCollider {
    const rec: FakeColliderRec = {
      handle: nextColliderHandle++,
      desc: desc as FakeColliderDesc,
      body: parent as FakeBody,
    };
    this.colliders.push(rec);
    return rec;
  }
  removeRigidBody(body: RapierRigidBody): void {
    this.removed.push(body as FakeBody);
    const i = this.bodies.indexOf(body as FakeBody);
    if (i >= 0) this.bodies.splice(i, 1);
  }
  castRay(): null { return null; }
  contactPairsWith(_c: RapierCollider, _f: (c2: RapierCollider) => void): void {}
  contactPair(
    _c1: RapierCollider,
    _c2: RapierCollider,
    _f: (m: RapierContactManifold, flipped: boolean) => void,
  ): void {}
  free(): void {}
}

let world: FakeWorld;

const FAKE_LIB: RapierLib = {
  init: async () => undefined,
  World: class {
    constructor() { world = new FakeWorld(); return world as unknown as FakeWorld; }
  } as unknown as RapierLib['World'],
  EventQueue: class { drainCollisionEvents(): void {} free(): void {} } as unknown as new (a: boolean) => RapierEventQueue,
  Ray: class { constructor(public origin: RapierVec3, public dir: RapierVec3) {} } as unknown as new (o: RapierVec3, d: RapierVec3) => RapierRay,
  RigidBodyDesc: {
    dynamic: () => new FakeDesc('dynamic'),
    fixed: () => new FakeDesc('fixed'),
    kinematicVelocityBased: () => new FakeDesc('kinematicVelocity'),
    kinematicPositionBased: () => new FakeDesc('kinematicPosition'),
  },
  ColliderDesc: {
    cuboid: (hx, hy, hz) => new FakeColliderDesc('cuboid', { x: hx, y: hy, z: hz }, null),
    convexHull: (points) => (hullIsDegenerate ? null : new FakeColliderDesc('convexHull', null, points)),
  },
  CoefficientCombineRule: { Max: 2 },
  ActiveEvents: { COLLISION_EVENTS: 1 },
  QueryFilterFlags: { EXCLUDE_SENSORS: 8 },
};

async function makeProvider(): Promise<RapierPhysicsProvider> {
  const provider = new RapierPhysicsProvider();
  await provider.init();
  return provider;
}

/** The collider record created for a body id (the LAST one wins — one per body). */
function colliderOf(provider: RapierPhysicsProvider, id: string): FakeColliderRec | undefined {
  void provider;
  return world.colliders[world.colliders.length - 1];
}

beforeEach(() => {
  nextColliderHandle = 0;
  hullIsDegenerate = false;
  setRapierLibLoader(async () => FAKE_LIB);
});

afterEach(() => setRapierLibLoader(null));

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('RapierPhysicsProvider — kinematic moving-part bodies (plan-467 F1/F2)', () => {
  it('addKinematicBody(cuboid) creates a kinematicPositionBased body with a cuboid collider', async () => {
    const provider = await makeProvider();
    provider.addKinematicBody('kin:Arm', cuboid(), pose(1, 2, 3), false);

    expect(world.bodies).toHaveLength(1);
    // NOT kinematicVelocityBased — that body type integrates its velocity and
    // physically drifts (the conveyor path has to snap it back every tick).
    expect(world.bodies[0].desc.kind).toBe('kinematicPosition');
    expect(world.bodies[0].desc.pos).toEqual({ x: 1, y: 2, z: 3 });

    const col = colliderOf(provider, 'kin:Arm')!;
    expect(col.desc.shape).toBe('cuboid');
    expect(col.desc.half).toEqual({ x: 0.5, y: 0.2, z: 0.3 });
    expect(provider.kinematicBodyCount).toBe(1);
    provider.dispose();
  });

  it('passes the BoxCollider center as a collider translation RELATIVE to the body (SOL R1 #6)', async () => {
    const provider = await makeProvider();
    provider.addKinematicBody('kin:Off', cuboid({ x: -0.25, y: 0.1, z: 0.75 }), pose(0, 0, 0), false);
    // The BODY sits at the node origin; only the COLLIDER is offset — otherwise
    // an off-centre box would collide where the node is, not where it looks.
    expect(world.bodies[0].desc.pos).toEqual({ x: 0, y: 0, z: 0 });
    expect(colliderOf(provider, 'kin:Off')!.desc.translation).toEqual({ x: -0.25, y: 0.1, z: 0.75 });
    provider.dispose();
  });

  it('addKinematicBody(convexHull) forwards the point buffer verbatim', async () => {
    const provider = await makeProvider();
    const points = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]);
    provider.addKinematicBody('kin:Hull', { kind: 'convexHull', points }, pose(0, 1, 0), true);

    const col = colliderOf(provider, 'kin:Hull')!;
    expect(col.desc.shape).toBe('convexHull');
    expect(col.desc.points).toBe(points); // no copy, no re-order
    expect(provider.kinematicBodyCount).toBe(1);
    provider.dispose();
  });

  it('a degenerate hull skips ONE part with a warning — no body, physics keeps running', async () => {
    const provider = await makeProvider();
    hullIsDegenerate = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    provider.addKinematicBody('kin:Flat', { kind: 'convexHull', points: new Float32Array(9) }, pose(0, 0, 0), false);

    expect(provider.kinematicBodyCount).toBe(0);
    expect(world.bodies).toHaveLength(0); // no orphan body left behind either
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('kin:Flat');

    // The provider is still fully usable afterwards.
    hullIsDegenerate = false;
    provider.addKinematicBody('kin:Ok', cuboid(), pose(0, 0, 0), false);
    expect(provider.kinematicBodyCount).toBe(1);
    expect(provider.failed).toBe(false);
    warn.mockRestore();
    provider.dispose();
  });

  it('setKinematicPose uses setNextKinematic* (never a teleport) and allocates nothing', async () => {
    const provider = await makeProvider();
    provider.addKinematicBody('kin:Arm', cuboid(), pose(0, 0, 0), false);
    const body = world.bodies[0];

    // Caller scratch, MUTATED between the two pushes — the provider must copy
    // the values through, not retain the object.
    const scratch: PhysicsPose = { pos: { x: 0, y: 0, z: 0 }, quat: { x: 0, y: 0, z: 0, w: 1 } };
    scratch.pos.x = 1; scratch.pos.y = 2; scratch.pos.z = 3;
    provider.setKinematicPose('kin:Arm', scratch);
    scratch.pos.x = 9; scratch.quat.y = Math.SQRT1_2; scratch.quat.w = Math.SQRT1_2;
    provider.setKinematicPose('kin:Arm', scratch);

    expect(body.teleports).toHaveLength(0); // a teleport pushes nothing (F3)
    expect(body.nextTranslations).toEqual([{ x: 1, y: 2, z: 3 }, { x: 9, y: 2, z: 3 }]);
    expect(body.nextRotations[1].y).toBeCloseTo(Math.SQRT1_2, 12);
    provider.dispose();
  });

  it('setKinematicPose on an unknown id is a silent no-op', async () => {
    const provider = await makeProvider();
    expect(() => provider.setKinematicPose('kin:ghost', pose(1, 1, 1))).not.toThrow();
    provider.dispose();
  });

  it('addKinematicBody is idempotent on the same id', async () => {
    const provider = await makeProvider();
    provider.addKinematicBody('kin:Arm', cuboid(), pose(0, 0, 0), false);
    provider.addKinematicBody('kin:Arm', cuboid(), pose(5, 5, 5), false);
    expect(provider.kinematicBodyCount).toBe(1);
    expect(world.bodies).toHaveLength(1);
    provider.dispose();
  });

  it('removeBody frees the kinematic body IMMEDIATELY and drops its collider mapping', async () => {
    const provider = await makeProvider();
    provider.addKinematicBody('kin:Arm', cuboid(), pose(0, 0, 0), false);
    const body = world.bodies[0];

    provider.removeBody('kin:Arm');
    // Immediate, not two-phase: kinematic bodies are only ever removed from the
    // zone-build / topology-change path, never mid-tick, and a rebuild must be
    // able to re-add the same id in the same breath.
    expect(world.removed).toEqual([body]);
    expect(provider.kinematicBodyCount).toBe(0);
    // Re-adding the id works right away.
    provider.addKinematicBody('kin:Arm', cuboid(), pose(1, 1, 1), false);
    expect(provider.kinematicBodyCount).toBe(1);
    provider.dispose();
  });

  it('dispose drops every kinematic body', async () => {
    const provider = await makeProvider();
    provider.addKinematicBody('kin:A', cuboid(), pose(0, 0, 0), false);
    provider.addKinematicBody('kin:B', cuboid(), pose(1, 0, 0), true);
    expect(provider.kinematicBodyCount).toBe(2);
    provider.dispose();
    expect(provider.kinematicBodyCount).toBe(0);
  });

  it('reportContactForces is recorded per body, and only those bodies get a load slot', async () => {
    const provider = await makeProvider();
    provider.addKinematicBody('kin:Link', cuboid(), pose(0, 0, 0), true);
    provider.addKinematicBody('kin:DriveOnly', cuboid(), pose(1, 0, 0), false);
    expect(provider.reportsContactForces('kin:Link')).toBe(true);
    expect(provider.reportsContactForces('kin:DriveOnly')).toBe(false);
    expect(provider.reportsContactForces('kin:nope')).toBeNull();

    // A reporting body appears (with a zero load — this fake world has no
    // contacts); a drive-only body never does, no matter what it touches.
    provider.step(1 / 60);
    const seen: string[] = [];
    provider.forEachContactLoad((l) => seen.push(l.bodyId));
    expect(seen).toEqual(['kin:Link']);
    provider.dispose();
  });
});

describe('RapierPhysicsProvider — MU mass and CCD (plan-467 F16)', () => {
  it('addDynamicMU sets the EXPLICIT mass on the collider and enables CCD on the body', async () => {
    const provider = await makeProvider();
    provider.addDynamicMU('mu1', pose(0, 1, 0), HE, V0, 2.5);
    expect(colliderOf(provider, 'mu1')!.desc.mass).toBe(2.5);
    // CCD lives on the DYNAMIC body: Rapier runs none between kinematic and
    // dynamic (rapier#303), so a fast gripper would tunnel through the MU.
    expect(world.bodies[0].desc.ccd).toBe(true);
    provider.dispose();
  });

  it('falls back to the documented default for a non-finite or non-positive mass', async () => {
    const provider = await makeProvider();
    provider.addDynamicMU('mu-nan', pose(0, 1, 0), HE, V0, Number.NaN);
    expect(colliderOf(provider, 'mu-nan')!.desc.mass).toBe(PHYSICS_DEFAULT_MU_MASS_KG);
    provider.addDynamicMU('mu-zero', pose(0, 2, 0), HE, V0, 0);
    expect(colliderOf(provider, 'mu-zero')!.desc.mass).toBe(PHYSICS_DEFAULT_MU_MASS_KG);
    provider.dispose();
  });
});
