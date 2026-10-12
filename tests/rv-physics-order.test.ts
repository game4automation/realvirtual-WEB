// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-physics-order.test.ts — plan-276 test 9.5 (Phase 3).
 *
 * Order-of-operations (pattern: kernel-tick-order.test.ts):
 *  1. The physics step runs AFTER transport.update within the SAME tick —
 *     mirrors rv-viewer.ts fixedUpdate: kernel.tick(dt) (SIM) → POST plugins
 *     (PhysicsZonePlugin.onFixedUpdatePost).
 *  2. `updatePoolMatrices()` is called AGAIN after syncPoses — the regular
 *     call runs inside transport.update BEFORE the plugin hook; without the
 *     second call instanced MUs would render one tick behind (review finding).
 *  3. Instanced and clone MUs receive the identical physics pose (dual
 *     pattern from transport-accumulation.test.ts).
 *
 * plan-467 test 9.4 extends this with the MOVING-COLLIDER contract:
 *     mechanism write-back -> setKinematicPose -> step -> forEachContactLoad
 *                          -> syncPoses
 * Every one of those edges is load-bearing and none of them is enforced by a
 * type: Rapier derives a kinematic body's contact velocity from
 * `next - current`, so a pose pushed AFTER `step()` is one tick late and pushes
 * nothing at all; and a contact load read after `syncPoses` would describe the
 * world before the MU poses were applied. Today the order is right by
 * construction (the physics plugin is a POST plugin, the mechanism ticks in
 * TickStage.SIM at order 200) - this test makes it a checked contract instead
 * of an accident a future re-ordering could quietly undo.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  Box3, BoxGeometry, Matrix4, MeshBasicMaterial, Object3D, Quaternion, Scene, Vector3,
} from 'three';
import { AABB } from '../src/core/engine/rv-aabb';
import { RVMovingUnit, MUInstancePool } from '../src/core/engine/rv-mu';
import { RVTransportManager } from '../src/core/engine/rv-transport-manager';
import { RVPhysicsZone } from '../src/core/engine/rv-physics-zone';
import { ContinuousRunner } from '../src/core/material-flow/continuous-runner';
import { SimulationKernel } from '../src/core/material-flow/simulation-kernel';
import { EventEmitter } from '../src/core/rv-events';
import {
  physicsRegistry,
  physicsSettings,
  type PhysicsAABB,
  type PhysicsProvider,
  type PhysicsQuat,
  type PhysicsRayHit,
  type PhysicsVec3,
  type PhysicsZoneConfig,
} from '../src/core/engine/rv-physics-registry';
import type { ComponentContext } from '../src/core/engine/rv-component-registry';
import { PhysicsZonePlugin } from '@rv-private/plugins/physics-zone-plugin';
import { setKinematicManager } from '../src/core/engine/rv-kinematic-registry';
import type {
  KinematicManagerLike,
  KinematicMechanismHandle,
} from '../src/core/engine/rv-kinematic-registry';
import type { RVViewer } from '../src/core/rv-viewer';
import type { LoadResult } from '../src/core/engine/rv-scene-loader';

const DT = 1 / 60;
const MU_HALF = new Vector3(0.05, 0.05, 0.05);

// ─── Helpers ────────────────────────────────────────────────────────────────

class MockPhysicsProvider implements PhysicsProvider {
  ready = true;
  failed = false;
  stepCalls = 0;
  onStep: (() => void) | null = null;
  poses = new Map<string, { pos: PhysicsVec3; quat: PhysicsQuat }>();
  onSensorEvent: ((sensorId: string, muId: string, entered: boolean) => void) | null = null;
  private readonly _outPos: PhysicsVec3 = { x: 0, y: 0, z: 0 };
  private readonly _outQuat: PhysicsQuat = { x: 0, y: 0, z: 0, w: 1 };

  async init(): Promise<void> { this.ready = true; }
  dispose(): void { this.ready = false; }
  addZone(_id: string, _aabb: PhysicsAABB, _cfg: PhysicsZoneConfig): void {}
  addStaticBox(id: string): void { this.staticIds.push(id); }
  addConveyor(): void {}
  setConveyorVelocity(): void {}
  addDynamicMU(muId: string, pose: { pos: PhysicsVec3; quat: PhysicsQuat }): void {
    this.poses.set(muId, { pos: { ...pose.pos }, quat: { ...pose.quat } });
  }
  removeBody(muId: string): void { this.removedIds.push(muId); this.poses.delete(muId); }
  addSensorBox(): void {}
  castRay(): PhysicsRayHit | null { return null; }
  /** Call log for the plan-467 9.4 order contract. */
  calls: string[] = [];
  kinematicPoses: Array<{ id: string; x: number; y: number; z: number }> = [];
  kinematicIds: string[] = [];
  staticIds: string[] = [];
  removedIds: string[] = [];
  step(): void { this.stepCalls++; this.calls.push('step'); this.onStep?.(); }
  syncPoses(out: (muId: string, pos: PhysicsVec3, quat: PhysicsQuat) => void): void {
    this.calls.push('syncPoses');
    for (const [muId, p] of this.poses) {
      this._outPos.x = p.pos.x; this._outPos.y = p.pos.y; this._outPos.z = p.pos.z;
      this._outQuat.x = p.quat.x; this._outQuat.y = p.quat.y;
      this._outQuat.z = p.quat.z; this._outQuat.w = p.quat.w;
      out(muId, this._outPos, this._outQuat);
    }
  }
  getSettledBodies(): string[] { return []; }
  // plan-467 moving colliders - recorded, so the tick order below is checkable.
  addKinematicBody(id: string): void { this.kinematicIds.push(id); }
  setKinematicPose(id: string, pose: { pos: PhysicsVec3 }): void {
    this.calls.push('setKinematicPose');
    this.kinematicPoses.push({ id, x: pose.pos.x, y: pose.pos.y, z: pose.pos.z });
  }
  forEachContactLoad(): void { this.calls.push('forEachContactLoad'); }
}

function makeTM(): RVTransportManager {
  const tm = new RVTransportManager();
  tm.scene = new Scene();
  return tm;
}

function makeZone(): RVPhysicsZone {
  const node = new Object3D();
  node.name = 'Zone';
  node.updateMatrixWorld(true);
  const aabb = AABB.fromBoxCollider(node, { x: 0, y: 1, z: 0 }, { x: 10, y: 4, z: 10 });
  const zone = new RVPhysicsZone(node, aabb);
  zone.ShowGizmo = false;
  zone.init({ gizmoManager: undefined } as unknown as ComponentContext);
  return zone;
}

function fakeViewer(tm: RVTransportManager, drives: Array<{ node: Object3D }> = []): RVViewer {
  const emitter = new EventEmitter();
  return {
    drives,
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

async function builtPlugin(
  tm: RVTransportManager,
  _mock: MockPhysicsProvider,
  opts: { root?: Object3D; drives?: Array<{ node: Object3D }> } = {},
): Promise<PhysicsZonePlugin> {
  const plugin = new PhysicsZonePlugin();
  const result = fakeLoadResult(tm);
  if (opts.root) (result as { root: Object3D }).root = opts.root;
  plugin.onModelLoaded(result, fakeViewer(tm, opts.drives ?? []));
  await plugin.buildPromise;
  return plugin;
}

function cloneMU(name: string, x: number, y: number, z: number): RVMovingUnit {
  const node = new Object3D();
  node.name = name;
  node.position.set(x, y, z);
  return new RVMovingUnit(node, 'test-source', MU_HALF.clone());
}

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
  setKinematicManager(null);
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('physics tick order (plan-276 §2.4)', () => {
  it('physics step runs AFTER transport.update (and behaviours) within the same tick', async () => {
    const tm = makeTM();
    makeZone();
    const plugin = await builtPlugin(tm, mock);

    const seq: string[] = [];
    const origUpdate = tm.update.bind(tm);
    tm.update = (dt: number) => { seq.push('transport.update'); origUpdate(dt); };
    mock.onStep = () => seq.push('physics.step');

    const kernel = new SimulationKernel({
      continuousRunner: new ContinuousRunner(tm, { tick: () => { seq.push('behaviors.tick'); } }),
      topology: { root: {} as never },
    });

    // Mirrors rv-viewer.ts fixedUpdate: kernel.tick (SIM stage) → POST plugins.
    for (let i = 0; i < 3; i++) {
      kernel.tick(DT);
      plugin.onFixedUpdatePost(DT);
    }

    expect(seq).toEqual([
      'transport.update', 'behaviors.tick', 'physics.step',
      'transport.update', 'behaviors.tick', 'physics.step',
      'transport.update', 'behaviors.tick', 'physics.step',
    ]);

    plugin.dispose();
  });

  it('updatePoolMatrices runs AGAIN after syncPoses — instanced MUs render this tick\'s physics pose', async () => {
    const tm = makeTM();
    makeZone();
    const plugin = await builtPlugin(tm, mock);

    const pool = new MUInstancePool(
      new BoxGeometry(0.1, 0.1, 0.1), new MeshBasicMaterial(), 'box', MU_HALF.clone(),
    );
    const imu = pool.spawn(new Vector3(0, 1, 0), new Quaternion(), 'imu1', 'test-source');
    imu.physicsOwned = true;
    imu.physicsBodyId = String(imu.id);
    tm.mus.push(imu);
    // Wire the pool the way production does: `updatePoolMatrices()` reaches
    // pools through the sources list (fake source — never spawns).
    tm.sources.push({ pool, node: new Object3D(), update: () => null, drainGenerated: () => [] } as unknown as (typeof tm.sources)[number]);

    let poolMatrixCalls = 0;
    const origPool = tm.updatePoolMatrices.bind(tm);
    tm.updatePoolMatrices = () => { poolMatrixCalls++; origPool(); };

    mock.poses.set(String(imu.id), {
      pos: { x: 0.3, y: 0.42, z: -0.2 },
      quat: { x: 0, y: 0, z: 0, w: 1 },
    });

    const m = new Matrix4();
    const p = new Vector3();

    // Transport tick FIRST — the REGULAR updatePoolMatrices composes the
    // pre-physics (spawn) pose into the instance matrix.
    tm.update(DT);
    expect(poolMatrixCalls).toBe(1);
    pool.instancedMesh.getMatrixAt(imu.slotIndex, m);
    p.setFromMatrixPosition(m);
    expect(p.y).toBeCloseTo(1, 5); // still the spawn pose — physics not applied yet

    // …then the plugin hook: step → syncPoses → SECOND updatePoolMatrices.
    plugin.onFixedUpdatePost(DT);
    expect(poolMatrixCalls).toBe(2);

    // The pool arrays AND the recomposed instance matrix now carry THIS
    // tick's physics pose (float32 storage → closeTo).
    imu.getWorldPosition(p);
    expect(p.x).toBeCloseTo(0.3, 6);
    expect(p.y).toBeCloseTo(0.42, 6);
    expect(p.z).toBeCloseTo(-0.2, 6);
    pool.instancedMesh.getMatrixAt(imu.slotIndex, m);
    p.setFromMatrixPosition(m);
    expect(p.x).toBeCloseTo(0.3, 6);
    expect(p.y).toBeCloseTo(0.42, 6);
    expect(p.z).toBeCloseTo(-0.2, 6);

    plugin.dispose();
    pool.dispose();
  });

  it('instanced and clone MUs receive the identical physics pose (parity)', async () => {
    const tm = makeTM();
    makeZone();
    const plugin = await builtPlugin(tm, mock);

    const clone = cloneMU('clone', 0, 1, 0);
    clone.physicsOwned = true;
    clone.physicsBodyId = String(clone.id);

    const pool = new MUInstancePool(
      new BoxGeometry(0.1, 0.1, 0.1), new MeshBasicMaterial(), 'box', MU_HALF.clone(),
    );
    const imu = pool.spawn(new Vector3(0, 1, 0), new Quaternion(), 'imu1', 'test-source');
    imu.physicsOwned = true;
    imu.physicsBodyId = String(imu.id);

    tm.mus.push(clone, imu);

    const pose = {
      pos: { x: 1.25, y: 0.6, z: -0.4 },
      quat: { x: 0, y: Math.SQRT1_2, z: 0, w: Math.SQRT1_2 }, // 90° yaw
    };
    mock.poses.set(String(clone.id), { pos: { ...pose.pos }, quat: { ...pose.quat } });
    mock.poses.set(String(imu.id), { pos: { ...pose.pos }, quat: { ...pose.quat } });

    tm.update(DT);
    plugin.onFixedUpdatePost(DT);

    const pc = new Vector3();
    const pi = new Vector3();
    clone.getWorldPosition(pc);
    imu.getWorldPosition(pi);
    // Instanced storage is float32 — compare component-wise with tolerance.
    expect(pc.x).toBeCloseTo(pi.x, 6);
    expect(pc.y).toBeCloseTo(pi.y, 6);
    expect(pc.z).toBeCloseTo(pi.z, 6);
    expect(pc.y).toBeCloseTo(0.6, 6);

    const qc = clone.getQuaternion().clone();
    const qi = imu.getQuaternion().clone();
    // Pool quaternions are float32 — a normalized SQRT1_2 quantizes to ~4e-4
    // rad; anything below a millirad is identical for rendering purposes.
    expect(qc.angleTo(qi)).toBeLessThan(1e-3);
    expect(Math.abs(qc.y)).toBeCloseTo(Math.SQRT1_2, 6);

    plugin.dispose();
    pool.dispose();
  });
});

// --- plan-467 9.4: moving-collider tick contract ---------------------------

/** A drive node carrying one solid BoxCollider child - the minimal moving part. */
function driveWithCollider(name: string): { root: Object3D; driveNode: Object3D; part: Object3D } {
  const root = new Object3D();
  root.name = 'Root';
  const driveNode = new Object3D();
  driveNode.name = name;
  const part = new Object3D();
  part.name = name + 'Plate';
  part.userData.realvirtual = {
    colliders: [{
      type: 'BoxCollider',
      center: { x: 0, y: 0, z: 0 },
      size: { x: 0.5, y: 0.5, z: 0.5 },
      enabled: true,
      isTrigger: false,
    }],
  };
  driveNode.add(part);
  root.add(driveNode);
  root.updateMatrixWorld(true);
  return { root, driveNode, part };
}

/**
 * Install a mechanism manager whose single mechanism owns `link` as link 0 —
 * the minimal setup in which the payload channel is live at all.
 */
function installMechanismManager(link: Object3D): void {
  const mechanism: KinematicMechanismHandle = {
    node: link,
    topologyVersion: 1,
    forEachOwnedNode(cb: (node: Object3D, linkIndex: number) => void): void {
      link.traverse((n) => cb(n, 0));
    },
  };
  setKinematicManager({
    register(): void {},
    unregister(): void {},
    get size(): number { return 1; },
    listMechanisms: () => [mechanism],
    setExternalLinkLoad(): void {},
  } as unknown as KinematicManagerLike);
}

describe('moving-collider tick order (plan-467 F4 / 9.4)', () => {
  it('setKinematicPose runs BEFORE step, and forEachContactLoad between step and syncPoses', async () => {
    const tm = makeTM();
    makeZone();
    // A LINK-owned part, not a drive-only one: the contact-load query only
    // exists for parts that have a link to attribute a payload to, so that is
    // the fixture in which the step -> forEachContactLoad -> syncPoses edge is
    // real (a drive-only world skips the query entirely, on purpose).
    const { driveNode } = driveWithCollider('Gripper');
    installMechanismManager(driveNode);
    const plugin = await builtPlugin(tm, mock, {});

    expect(mock.kinematicIds).toHaveLength(1); // the part became a kinematic body

    mock.calls.length = 0;
    plugin.onFixedUpdatePost(DT);

    // A pose written after step() would be one tick late and push nothing;
    // a load read after syncPoses would describe the pre-sync world.
    expect(mock.calls).toEqual(['setKinematicPose', 'step', 'forEachContactLoad', 'syncPoses']);

    plugin.dispose();
  });

  it('a drive-only world skips the contact query entirely (nothing can consume it)', async () => {
    const tm = makeTM();
    makeZone();
    const { driveNode } = driveWithCollider('Pusher');
    const plugin = await builtPlugin(tm, mock, { drives: [{ node: driveNode }] });

    mock.calls.length = 0;
    plugin.onFixedUpdatePost(DT);
    expect(mock.calls).toEqual(['setKinematicPose', 'step', 'syncPoses']);

    plugin.dispose();
  });

  it('pushes THIS tick pose - the drive moved before the plugin hook ran', async () => {
    const tm = makeTM();
    makeZone();
    const { driveNode } = driveWithCollider('Pusher');
    const plugin = await builtPlugin(tm, mock, { drives: [{ node: driveNode }] });

    // Stand-in for the drive / mechanism write-back in TickStage.SIM, which
    // always runs before the POST plugin hook.
    driveNode.position.set(0.25, 0, 0);
    driveNode.updateMatrixWorld(true);
    plugin.onFixedUpdatePost(DT);

    expect(mock.kinematicPoses).toHaveLength(1);
    expect(mock.kinematicPoses[0].x).toBeCloseTo(0.25, 6);

    driveNode.position.set(0.5, 0, 0);
    driveNode.updateMatrixWorld(true);
    plugin.onFixedUpdatePost(DT);
    expect(mock.kinematicPoses[1].x).toBeCloseTo(0.5, 6);

    plugin.dispose();
  });

  it('a moving part is NOT also registered as an implicit static box (F1, SOL R1 #5)', async () => {
    const tm = makeTM();
    makeZone();
    const { root, driveNode, part } = driveWithCollider('Pusher');
    // The plugin traverses `result.root` for implicit statics - hand it the
    // same subtree the drive owns, which is the real-model situation.
    const plugin = await builtPlugin(tm, mock, { root, drives: [{ node: driveNode }] });

    expect(mock.kinematicIds).toHaveLength(1);
    // Without the exclusion the part would ALSO be a fixed box and would leave
    // a ghost wall at its start position the moment the drive moved away.
    expect(mock.staticIds.filter((id) => id.includes(part.name))).toHaveLength(0);

    plugin.dispose();
  });

  it('teardown frees the kinematic bodies and stops pushing poses', async () => {
    const tm = makeTM();
    makeZone();
    const { driveNode } = driveWithCollider('Pusher');
    const plugin = await builtPlugin(tm, mock, { drives: [{ node: driveNode }] });
    expect(mock.kinematicIds).toHaveLength(1);

    plugin.dispose();
    mock.calls.length = 0;
    plugin.onFixedUpdatePost(DT);
    expect(mock.calls).toEqual([]); // plugin inactive - nothing pushed, nothing stepped
    expect(mock.removedIds).toContain(mock.kinematicIds[0]);
  });
});
