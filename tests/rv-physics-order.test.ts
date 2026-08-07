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
  addStaticBox(): void {}
  addConveyor(): void {}
  setConveyorVelocity(): void {}
  addDynamicMU(muId: string, pose: { pos: PhysicsVec3; quat: PhysicsQuat }): void {
    this.poses.set(muId, { pos: { ...pose.pos }, quat: { ...pose.quat } });
  }
  removeBody(muId: string): void { this.poses.delete(muId); }
  addSensorBox(): void {}
  castRay(): PhysicsRayHit | null { return null; }
  step(): void { this.stepCalls++; this.onStep?.(); }
  syncPoses(out: (muId: string, pos: PhysicsVec3, quat: PhysicsQuat) => void): void {
    for (const [muId, p] of this.poses) {
      this._outPos.x = p.pos.x; this._outPos.y = p.pos.y; this._outPos.z = p.pos.z;
      this._outQuat.x = p.quat.x; this._outQuat.y = p.quat.y;
      this._outQuat.z = p.quat.z; this._outQuat.w = p.quat.w;
      out(muId, this._outPos, this._outQuat);
    }
  }
  getSettledBodies(): string[] { return []; }
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

async function builtPlugin(tm: RVTransportManager, _mock: MockPhysicsProvider): Promise<PhysicsZonePlugin> {
  const plugin = new PhysicsZonePlugin();
  plugin.onModelLoaded(fakeLoadResult(tm), fakeViewer(tm));
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
    tm.sources.push({ pool, node: new Object3D(), update: () => null } as unknown as (typeof tm.sources)[number]);

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
