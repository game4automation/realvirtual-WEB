// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-physics-implicit-statics.test.ts — plan-428 tests T1-T7.
 *
 * Robustness of the implicit static collision geometry (`addImplicitStaticBoxes`)
 * and the automatic floor plate of the SYNTHETIC WholeScene zone:
 *
 *  - T1 visible chain, T2 `activeSelf` chain (Unity activeInHierarchy semantics)
 *  - T3 oversize guard (threshold, single axis, planar/empty scene, warn-once)
 *  - T4 degenerate box definitions (legacy key AND colliders[] entries)
 *  - T5/T6 floor plate geometry + scope (synthetic zone only)
 *  - T7 real Rapier: a body rests ON the plate, never falls through, gains no
 *    lateral velocity (regression guard for the depenetration kick)
 *
 * T1-T6 run against a MockPhysicsProvider through the public registry (test kit
 * from rv-physics-handover.test.ts); T7 loads the OUT-OF-BAND Rapier package via
 * the URL seam and skips gracefully when it is absent
 * (pattern: physics-spike-handover.test.ts).
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, vi } from 'vitest';
import { Box3, Object3D, Scene, Vector3 } from 'three';
import { AABB } from '../src/core/engine/rv-aabb';
import { RVTransportManager } from '../src/core/engine/rv-transport-manager';
import { RVPhysicsZone } from '../src/core/engine/rv-physics-zone';
import { EventEmitter } from '../src/core/rv-events';
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
import {
  PHYSICS_FIXED_DT,
  PHYSICS_FLOOR_MARGIN,
  PHYSICS_FLOOR_THICKNESS,
} from '../src/core/engine/rv-physics-constants';
import type { ComponentContext } from '../src/core/engine/rv-component-registry';
import { PhysicsZonePlugin } from '@rv-private/plugins/physics-zone-plugin';
import type { RVViewer } from '../src/core/rv-viewer';
import type { LoadResult } from '../src/core/engine/rv-scene-loader';

interface Vec3Like { x: number; y: number; z: number }

/** Default scene bounds of the fake load result: 20 × 6 × 20 m. */
const SCENE_MIN = new Vector3(-10, -1, -10);
const SCENE_MAX = new Vector3(10, 5, 10);

// ─── Mock provider (records static boxes; handover kit) ─────────────────────

class MockPhysicsProvider implements PhysicsProvider {
  ready = true;
  failed = false;
  zones: Array<{ id: string; aabb: PhysicsAABB; cfg: PhysicsZoneConfig }> = [];
  staticBoxes: Array<{ id: string; center: PhysicsVec3; half: PhysicsVec3 }> = [];
  onSensorEvent: ((sensorId: string, muId: string, entered: boolean) => void) | null = null;

  async init(): Promise<void> { this.ready = true; }
  dispose(): void { this.ready = false; }
  addZone(id: string, aabb: PhysicsAABB, cfg: PhysicsZoneConfig): void {
    this.zones.push({ id, aabb: { min: { ...aabb.min }, max: { ...aabb.max } }, cfg: { ...cfg } });
  }
  addStaticBox(id: string, center: PhysicsVec3, halfExtents: PhysicsVec3): void {
    this.staticBoxes.push({ id, center: { ...center }, half: { ...halfExtents } });
  }
  addConveyor(): void {}
  setConveyorVelocity(): void {}
  addDynamicMU(_muId: string, _pose: PhysicsPose, _half: PhysicsVec3, _vel: PhysicsVec3): void {}
  removeBody(): void {}
  addSensorBox(): void {}
  castRay(): PhysicsRayHit | null { return null; }
  step(): void {}
  syncPoses(): void {}
  getSettledBodies(): string[] { return []; }

  /** Ids of implicit static boxes (excludes the synthetic floor plate). */
  get implicitIds(): string[] {
    return this.staticBoxes.filter((b) => b.id.startsWith('staticbox:')).map((b) => b.id);
  }
  floor(): { id: string; center: PhysicsVec3; half: PhysicsVec3 } | undefined {
    return this.staticBoxes.find((b) => b.id === 'floor:synthetic');
  }
}

// ─── Fakes (handover-test kit) ──────────────────────────────────────────────

function createManager(): RVTransportManager {
  const manager = new RVTransportManager();
  manager.scene = new Scene();
  return manager;
}

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

function fakeLoadResult(tm: RVTransportManager, root: Object3D, boundingBox?: Box3): LoadResult {
  return {
    root,
    boundingBox: boundingBox ?? new Box3(SCENE_MIN.clone(), SCENE_MAX.clone()),
    transportManager: tm,
    registry: { getNode: () => null },
    drives: [],
  } as unknown as LoadResult;
}

/** Build the plugin against `root`/`bbox` and await the async world build. */
async function builtPlugin(
  root: Object3D,
  boundingBox?: Box3,
): Promise<{ plugin: PhysicsZonePlugin; viewer: RVViewer; result: LoadResult }> {
  const tm = createManager();
  const viewer = fakeViewer(tm);
  const result = fakeLoadResult(tm, root, boundingBox);
  const plugin = new PhysicsZonePlugin();
  plugin.onModelLoaded(result, viewer);
  await plugin.buildPromise;
  return { plugin, viewer, result };
}

/** Explicit box zone registered like the loader does (init pass). */
function createZone(center: [number, number, number], size: [number, number, number]): RVPhysicsZone {
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

/** A zone large enough to contain every fixture box of T1-T4. */
function bigZone(): RVPhysicsZone {
  return createZone([0, 0, 0], [200, 200, 200]);
}

/** Node with a `colliders[]` BoxCollider entry (the modern export format). */
function boxColliderNode(
  name: string,
  size: Vec3Like = { x: 1, y: 1, z: 1 },
  extra?: Record<string, unknown>,
): Object3D {
  const node = new Object3D();
  node.name = name;
  node.userData.realvirtual = {
    colliders: [{ type: 'BoxCollider', center: { x: 0, y: 0, z: 0 }, size }],
    ...extra,
  };
  return node;
}

/** Scene root carrying the given collider nodes. */
function rootWith(...children: Object3D[]): Object3D {
  const root = new Object3D();
  root.name = 'Root';
  for (const c of children) root.add(c);
  root.updateMatrixWorld(true);
  return root;
}

// ─── Shared setup/teardown ──────────────────────────────────────────────────

let mock: MockPhysicsProvider;

beforeEach(() => {
  RVPhysicsZone.clearAll();
  mock = new MockPhysicsProvider();
  physicsRegistry.register(mock);
  physicsSettings.enabled = true;
  physicsSettings.full = false;
});

afterEach(() => {
  RVPhysicsZone.clearAll();
  physicsRegistry.register(null);
  physicsSettings.enabled = false;
  physicsSettings.full = false;
  vi.restoreAllMocks();
});

// ─── T1 — visible chain ─────────────────────────────────────────────────────

describe('T1 implicit static boxes: visibility guard', () => {
  it('skips implicit static boxes on invisible nodes', async () => {
    bigZone();
    const child = boxColliderNode('Deko');
    child.visible = false;
    const { plugin } = await builtPlugin(rootWith(child));

    expect(mock.staticBoxes).toHaveLength(0);
    plugin.dispose();
  });

  it('skips a VISIBLE node whose ancestor is invisible', async () => {
    bigZone();
    const group = new Object3D();
    group.name = 'HiddenGroup';
    group.visible = false;
    const child = boxColliderNode('Deko');
    group.add(child);
    const { plugin } = await builtPlugin(rootWith(group));

    expect(child.visible).toBe(true); // the node itself IS visible
    expect(mock.staticBoxes).toHaveLength(0);
    plugin.dispose();
  });

  it('registers the box when the whole chain is visible (guard is specific)', async () => {
    bigZone();
    const { plugin } = await builtPlugin(rootWith(boxColliderNode('Deko')));

    expect(mock.implicitIds).toHaveLength(1);
    expect(mock.staticBoxes[0].id).toContain('Deko');
    plugin.dispose();
  });
});

// ─── T2 — activeSelf chain ──────────────────────────────────────────────────

describe('T2 implicit static boxes: activeSelf guard', () => {
  it('skips a node with activeSelf === false', async () => {
    bigZone();
    const node = boxColliderNode('Deko', { x: 1, y: 1, z: 1 }, { activeSelf: false });
    const { plugin } = await builtPlugin(rootWith(node));

    expect(mock.staticBoxes).toHaveLength(0);
    plugin.dispose();
  });

  it('(a) skips a node whose ANCESTOR carries activeSelf === false', async () => {
    bigZone();
    const group = new Object3D();
    group.name = 'DisabledGroup';
    group.userData.realvirtual = { activeSelf: false };
    const child = boxColliderNode('Deko'); // no activeSelf field of its own
    group.add(child);
    const { plugin } = await builtPlugin(rootWith(group));

    expect(mock.staticBoxes).toHaveLength(0);
    plugin.dispose();
  });

  it('(b) registers when the field is missing everywhere (missing !== false)', async () => {
    bigZone();
    const { plugin } = await builtPlugin(rootWith(boxColliderNode('Deko')));

    expect(mock.implicitIds).toHaveLength(1);
    plugin.dispose();
  });

  it('(c) child activeSelf === true does NOT override a false ancestor', async () => {
    bigZone();
    const group = new Object3D();
    group.name = 'DisabledGroup';
    group.userData.realvirtual = { activeSelf: false };
    const child = boxColliderNode('Deko', { x: 1, y: 1, z: 1 }, { activeSelf: true });
    group.add(child);
    const { plugin } = await builtPlugin(rootWith(group));

    expect(mock.staticBoxes).toHaveLength(0);
    plugin.dispose();
  });
});

// ─── T3 — oversize guard ────────────────────────────────────────────────────

describe('T3 implicit static boxes: oversize guard', () => {
  // Scene extents of the default fake result: x = 20, y = 6, z = 20
  // → 0.9 threshold = 18 (x/z) and 5.4 (y).

  it('(a) discards a box spanning the scene in two axes with exactly one warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    bigZone();
    const { plugin } = await builtPlugin(rootWith(boxColliderNode('Turbine-cut', { x: 19, y: 0.5, z: 19 })));

    expect(mock.staticBoxes).toHaveLength(0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/implicit static box "Turbine-cut".*spans the scene/);
    expect(warn.mock.calls[0][0]).toContain('19.0×0.5×19.0 m');
    plugin.dispose();
  });

  it('(b) registers a box just below the threshold in every axis, no warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    bigZone();
    const { plugin } = await builtPlugin(rootWith(boxColliderNode('Frame', { x: 17, y: 5, z: 17 })));

    expect(mock.implicitIds).toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();
    plugin.dispose();
  });

  it('(c) registers a long beam spanning only ONE axis', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    bigZone();
    const { plugin } = await builtPlugin(rootWith(boxColliderNode('Beam', { x: 19, y: 0.2, z: 0.2 })));

    expect(mock.implicitIds).toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();
    plugin.dispose();
  });

  it('(d1) planar scene bounds: only x/z comparable — a big x/z box is still discarded', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    bigZone();
    const planar = new Box3(new Vector3(-10, 0, -10), new Vector3(10, 0, 10));
    const { plugin } = await builtPlugin(rootWith(boxColliderNode('Flat', { x: 19, y: 1, z: 19 })), planar);

    expect(mock.staticBoxes).toHaveLength(0);
    expect(warn).toHaveBeenCalledTimes(1);
    plugin.dispose();
  });

  it('(d2) empty scene bounds: fewer than two comparable axes — guard fails OPEN', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    bigZone();
    const empty = new Box3(); // makeEmpty(): min = +Inf, max = -Inf
    const { plugin } = await builtPlugin(rootWith(boxColliderNode('Huge', { x: 500, y: 500, z: 500 })), empty);

    expect(mock.implicitIds).toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();
    plugin.dispose();
  });

  it('(e) warn-once set is reset on onModelCleared — the warning reappears', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    bigZone();
    const root = rootWith(boxColliderNode('Turbine-cut', { x: 19, y: 0.5, z: 19 }));
    const { plugin, viewer, result } = await builtPlugin(root);
    expect(warn).toHaveBeenCalledTimes(1);

    plugin.onModelCleared(viewer); // clears zones + the warn set
    bigZone();
    plugin.onModelLoaded(result, viewer);
    await plugin.buildPromise;

    expect(warn).toHaveBeenCalledTimes(2);
    plugin.dispose();
  });

  it('(f) two SAME-NAMED oversize nodes produce two warnings (keyed on uuid)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    bigZone();
    const a = boxColliderNode('Turbine-cut', { x: 19, y: 0.5, z: 19 });
    const b = boxColliderNode('Turbine-cut', { x: 19, y: 0.5, z: 19 });
    b.position.set(1, 0, 0);
    const { plugin } = await builtPlugin(rootWith(a, b));

    expect(a.uuid).not.toBe(b.uuid);
    expect(mock.staticBoxes).toHaveLength(0);
    expect(warn).toHaveBeenCalledTimes(2);
    plugin.dispose();
  });
});

// ─── T4 — degenerate box definitions ────────────────────────────────────────

describe('T4 implicit static boxes: degenerate collider entries', () => {
  it('(a) single colliders[] entry with a zero/NaN component → no box, no throw', async () => {
    bigZone();
    const zeroSize = boxColliderNode('Zero', { x: 0, y: 1, z: 1 });
    const nanCenter = new Object3D();
    nanCenter.name = 'NaNCenter';
    nanCenter.userData.realvirtual = {
      colliders: [{ type: 'BoxCollider', center: { x: NaN, y: 0, z: 0 }, size: { x: 1, y: 1, z: 1 } }],
    };
    const { plugin } = await builtPlugin(rootWith(zeroSize, nanCenter));

    expect(mock.staticBoxes).toHaveLength(0);
    plugin.dispose();
  });

  it('(b) first entry degenerate, second valid → the VALID entry is registered', async () => {
    bigZone();
    const node = new Object3D();
    node.name = 'MixedColliders';
    node.userData.realvirtual = {
      colliders: [
        { type: 'BoxCollider', center: { x: 0, y: 0, z: 0 }, size: { x: 0, y: 0, z: 0 } },
        { type: 'BoxCollider', center: { x: 0, y: 0, z: 0 }, size: { x: 2, y: 2, z: 2 } },
      ],
    };
    const { plugin } = await builtPlugin(rootWith(node));

    expect(mock.implicitIds).toHaveLength(1);
    expect(mock.staticBoxes[0].half.x).toBeCloseTo(1, 6); // size 2 → half extent 1
    plugin.dispose();
  });

  it('(c) degenerate LEGACY rv.BoxCollider as the only entry → no box, no throw', async () => {
    bigZone();
    const node = new Object3D();
    node.name = 'LegacyBroken';
    node.userData.realvirtual = {
      BoxCollider: { center: { x: 0, y: 0, z: 0 }, size: { x: 1, y: -1, z: 1 } },
    };
    const { plugin } = await builtPlugin(rootWith(node));

    expect(mock.staticBoxes).toHaveLength(0);
    plugin.dispose();
  });

  it('(d) degenerate legacy entry no longer masks a valid colliders[] entry', async () => {
    bigZone();
    const node = new Object3D();
    node.name = 'LegacyPlusArray';
    node.userData.realvirtual = {
      BoxCollider: { center: { x: 0, y: 0, z: 0 }, size: { x: 0, y: 0, z: 0 } },
      colliders: [{ type: 'BoxCollider', center: { x: 0, y: 0, z: 0 }, size: { x: 3, y: 3, z: 3 } }],
    };
    const { plugin } = await builtPlugin(rootWith(node));

    expect(mock.implicitIds).toHaveLength(1);
    expect(mock.staticBoxes[0].half.x).toBeCloseTo(1.5, 6);
    plugin.dispose();
  });
});

// ─── T5/T6 — synthetic floor plate ──────────────────────────────────────────

describe('T5/T6 synthetic floor plate', () => {
  it('T5 adds floor:synthetic flush under the scene bounds when the zone is synthetic', async () => {
    const { plugin } = await builtPlugin(rootWith()); // no authored zone → synthetic

    const floor = mock.floor();
    expect(floor).toBeDefined();
    expect(floor!.center.x).toBeCloseTo(0, 6);
    expect(floor!.center.z).toBeCloseTo(0, 6);
    expect(floor!.center.y).toBeCloseTo(SCENE_MIN.y - PHYSICS_FLOOR_THICKNESS / 2, 6);
    expect(floor!.half.y).toBeCloseTo(PHYSICS_FLOOR_THICKNESS / 2, 6);
    expect(floor!.half.x).toBeCloseTo((SCENE_MAX.x - SCENE_MIN.x) / 2 + PHYSICS_FLOOR_MARGIN, 6);
    expect(floor!.half.z).toBeCloseTo((SCENE_MAX.z - SCENE_MIN.z) / 2 + PHYSICS_FLOOR_MARGIN, 6);
    // Top face is EXACTLY at bbox.min.y — never above (never cuts geometry).
    expect(floor!.center.y + floor!.half.y).toBeCloseTo(SCENE_MIN.y, 6);
    plugin.dispose();
  });

  it('T5 geometry below the working level: the plate sits at bbox.min.y, never above', async () => {
    // Pit/basement fixture: render geometry reaches down to y = -3 although the
    // visible hall floor is at y = 0 (documented fallback semantics).
    const deep = new Box3(new Vector3(-5, -3, -5), new Vector3(5, 4, 5));
    const { plugin } = await builtPlugin(rootWith(), deep);

    const floor = mock.floor();
    expect(floor).toBeDefined();
    expect(floor!.center.y + floor!.half.y).toBeCloseTo(-3, 6);
    expect(floor!.center.y + floor!.half.y).toBeLessThanOrEqual(deep.min.y + 1e-9);
    plugin.dispose();
  });

  it('T6 adds NO floor plate when only an authored zone exists', async () => {
    bigZone();
    const { plugin } = await builtPlugin(rootWith());

    expect(mock.floor()).toBeUndefined();
    expect(mock.staticBoxes).toHaveLength(0);
    plugin.dispose();
  });
});

// ─── T7 — real Rapier integration (graceful skip) ───────────────────────────
//
// Minimal structural types only: the out-of-band package must never become a
// type dependency (plan-276 § 2.8) — see physics-spike-handover.test.ts.

interface RapierVec3 { x: number; y: number; z: number }

interface T7RigidBody {
  translation(): RapierVec3;
  linvel(): RapierVec3;
}

interface T7BodyDesc {
  setTranslation(x: number, y: number, z: number): T7BodyDesc;
}

interface T7ColliderDesc {
  setRestitution(r: number): T7ColliderDesc;
}

interface T7World {
  timestep: number;
  step(): void;
  createRigidBody(desc: T7BodyDesc): T7RigidBody;
  createCollider(desc: T7ColliderDesc, parent?: T7RigidBody): unknown;
  free(): void;
}

interface T7Rapier {
  init(): Promise<void>;
  World: new (gravity: RapierVec3) => T7World;
  RigidBodyDesc: { dynamic(): T7BodyDesc; fixed(): T7BodyDesc };
  ColliderDesc: { cuboid(hx: number, hy: number, hz: number): T7ColliderDesc };
}

/** Out-of-band import seam — URL path, resolved by the vitest browser server. */
const RAPIER_MJS_URL = '/node_modules/@dimforge/rapier3d-compat/rapier.mjs';

let RAPIER: T7Rapier | null = null;

beforeAll(async () => {
  try {
    const mod = (await import(/* @vite-ignore */ RAPIER_MJS_URL)) as T7Rapier;
    await mod.init();
    RAPIER = mod;
  } catch {
    RAPIER = null; // package not installed (out-of-band) — test skips gracefully
  }
}, 30000);

describe('T7 real Rapier: MU rests on the synthetic floor plate', () => {
  it('body dropped over the plate rests on its top face, never falls through, gains no lateral velocity', () => {
    if (!RAPIER) {
      console.warn('[plan-428 T7] @dimforge/rapier3d-compat not installed (out-of-band) — skipping');
      return;
    }
    const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    world.timestep = PHYSICS_FIXED_DT;
    try {
      // Floor plate exactly as addSyntheticFloor builds it: top face flush with
      // the scene bbox.min.y (= 0 here), real thickness, scene footprint + margin.
      const floorTopY = SCENE_MIN.y - SCENE_MIN.y; // 0 — plate top of a bbox.min.y = 0 scene
      const halfX = (SCENE_MAX.x - SCENE_MIN.x) / 2 + PHYSICS_FLOOR_MARGIN;
      const halfZ = (SCENE_MAX.z - SCENE_MIN.z) / 2 + PHYSICS_FLOOR_MARGIN;
      const halfY = PHYSICS_FLOOR_THICKNESS / 2;
      const plate = world.createRigidBody(
        RAPIER.RigidBodyDesc.fixed().setTranslation(0, floorTopY - halfY, 0),
      );
      world.createCollider(RAPIER.ColliderDesc.cuboid(halfX, halfY, halfZ), plate);

      // Dynamic MU stand-in (half extent 0.05 m) 0.5 m above the plate top.
      const muHalf = 0.05;
      const body = world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic().setTranslation(0, floorTopY + 0.5 + muHalf, 0),
      );
      world.createCollider(RAPIER.ColliderDesc.cuboid(muHalf, muHalf, muHalf).setRestitution(0), body);

      let minY = Infinity;
      for (let t = 0; t < 120; t++) {
        world.step();
        minY = Math.min(minY, body.translation().y);
      }

      const pos = body.translation();
      const vel = body.linvel();
      // (a) rests with its bottom face on the plate top (± solver slack)
      expect(Math.abs(pos.y - (floorTopY + muHalf))).toBeLessThan(0.01);
      // (b) never dropped through the plate
      expect(minY).toBeGreaterThan(floorTopY - muHalf);
      // (c) no lateral kick in an otherwise empty world (depenetration guard)
      expect(Math.abs(vel.x)).toBeLessThan(0.01);
      expect(Math.abs(vel.z)).toBeLessThan(0.01);
      console.log(
        `[plan-428 T7] restY=${pos.y.toFixed(4)} minY=${minY.toFixed(4)} ` +
          `vx=${vel.x.toExponential(2)} vz=${vel.z.toExponential(2)}`,
      );
    } finally {
      world.free();
    }
  }, 30000);
});
