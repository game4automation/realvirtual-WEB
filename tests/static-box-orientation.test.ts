// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * static-box-orientation.test.ts — plan-525 T7: implicit static boxes are
 * registered ORIENTED (centre, world scale, world rotation), like the explicit
 * `StaticColliders` path always was.
 *
 *  - a tilted thin box keeps its rotation and thin half extent (before plan-525
 *    it became the world AABB with an identity rotation — a solid block that
 *    filled the chute);
 *  - an offset centre is carried through the node's world matrix;
 *  - a scaled parent scales the half extents;
 *  - an axis-parallel, unscaled legacy box is BIT-identical to the AABB it
 *    replaced, and the number of static bodies does not change;
 *  - real Rapier: a part dropped onto a tilted thin chute slides down it and
 *    never falls through.
 *
 * Mock part: PhysicsZonePlugin against a recording provider. Rapier part: the
 * out-of-band package; skips unless `RV_PHYSICS_REQUIRE_WASM=1`.
 * PRIVATE-DEPENDENT: listed in `tests/private-dependent-tests.json`.
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest';
import { Box3, Euler, Matrix4, Object3D, Quaternion, Scene, Vector3 } from 'three';
import { AABB } from '../src/core/engine/rv-aabb';
import { RVTransportManager } from '../src/core/engine/rv-transport-manager';
import { RVPhysicsZone } from '../src/core/engine/rv-physics-zone';
import { EventEmitter } from '../src/core/rv-events';
import {
  physicsRegistry, physicsSettings,
  type PhysicsAABB, type PhysicsProvider, type PhysicsQuat, type PhysicsRayHit, type PhysicsVec3, type PhysicsZoneConfig,
} from '../src/core/engine/rv-physics-registry';
import { PHYSICS_FIXED_DT } from '../src/core/engine/rv-physics-constants';
import type { ComponentContext } from '../src/core/engine/rv-component-registry';
import type { RVViewer } from '../src/core/rv-viewer';
import type { LoadResult } from '../src/core/engine/rv-scene-loader';
import { PhysicsZonePlugin, addOrientedStaticBox } from '@rv-private/plugins/physics-zone-plugin';
import { RapierPhysicsProvider } from '@rv-private/physics/rv-rapier-provider';

const REQUIRE_WASM = typeof __RV_PHYSICS_REQUIRE_WASM__ !== 'undefined' && __RV_PHYSICS_REQUIRE_WASM__;

interface StaticBox { id: string; center: PhysicsVec3; half: PhysicsVec3; quat: PhysicsQuat }

class RecordingProvider implements PhysicsProvider {
  ready = true;
  failed = false;
  statics: StaticBox[] = [];
  onSensorEvent: ((sensorId: string, muId: string, entered: boolean) => void) | null = null;
  async init(): Promise<void> { this.ready = true; }
  dispose(): void {}
  addZone(_id: string, _aabb: PhysicsAABB, _cfg: PhysicsZoneConfig): void {}
  addStaticBox(id: string, center: PhysicsVec3, half: PhysicsVec3, quat: PhysicsQuat): void {
    this.statics.push({
      id, center: { x: center.x, y: center.y, z: center.z }, half: { x: half.x, y: half.y, z: half.z },
      quat: { x: quat.x, y: quat.y, z: quat.z, w: quat.w },
    });
  }
  addConveyor(): void {}
  setConveyorVelocity(): void {}
  addDynamicMU(): void {}
  removeBody(): void {}
  addSensorBox(): void {}
  castRay(): PhysicsRayHit | null { return null; }
  step(): void {}
  syncPoses(): void {}
  getSettledBodies(): string[] { return []; }
  addKinematicBody(): void {}
  setKinematicPose(): void {}
  forEachContactLoad(): void {}
  implicit(): StaticBox[] { return this.statics.filter((b) => b.id.startsWith('staticbox:')); }
}

let rec: RecordingProvider;
beforeEach(() => {
  RVPhysicsZone.clearAll();
  rec = new RecordingProvider();
  physicsRegistry.register(rec);
  physicsSettings.enabled = true;
  physicsSettings.full = false;
});
afterEach(() => {
  RVPhysicsZone.clearAll();
  physicsRegistry.register(null);
  physicsSettings.enabled = false;
  physicsSettings.full = false;
});

function bigZone(): void {
  const node = new Object3D();
  node.name = 'Zone';
  node.updateMatrixWorld(true);
  const zone = new RVPhysicsZone(node, AABB.fromBoxCollider(node, { x: 0, y: 0, z: 0 }, { x: 100, y: 100, z: 100 }));
  zone.ShowGizmo = false;
  zone.init({ gizmoManager: undefined } as unknown as ComponentContext);
}

function colliderNode(name: string, box: { center: PhysicsVec3; size: PhysicsVec3 }): Object3D {
  const n = new Object3D();
  n.name = name;
  n.userData.realvirtual = { BoxCollider: box };
  return n;
}

async function build(root: Object3D): Promise<PhysicsZonePlugin> {
  root.updateMatrixWorld(true);
  const tm = new RVTransportManager();
  tm.scene = new Scene();
  const emitter = new EventEmitter();
  const viewer = {
    transportManager: tm, registry: { getNode: () => null }, gizmoManager: undefined,
    simulationKernel: null, getPlugin: () => undefined, drives: [],
    on: emitter.on.bind(emitter), emit: emitter.emit.bind(emitter),
  } as unknown as RVViewer;
  const result = {
    root, transportManager: tm, registry: { getNode: () => null }, drives: [],
    boundingBox: new Box3(new Vector3(-20, -5, -20), new Vector3(20, 10, 20)),
  } as unknown as LoadResult;
  const plugin = new PhysicsZonePlugin();
  plugin.onModelLoaded(result, viewer);
  await plugin.buildPromise;
  return plugin;
}

describe('plan-525 T7: oriented implicit static boxes (mock provider)', () => {
  it('a tilted thin wall keeps its rotation and its thin half extent', async () => {
    bigZone();
    const root = new Object3D();
    const wall = colliderNode('ChuteFloor', { center: { x: 0, y: 0, z: 0 }, size: { x: 1, y: 0.004, z: 0.3 } });
    wall.position.set(0.5, 1, 0);
    wall.rotation.set(0, 0, -Math.PI / 6);
    root.add(wall);
    const plugin = await build(root);

    const [box] = rec.implicit();
    expect(box).toBeDefined();
    const q = new Quaternion().setFromEuler(new Euler(0, 0, -Math.PI / 6));
    expect(box.quat.z).toBeCloseTo(q.z, 9);
    expect(box.quat.w).toBeCloseTo(q.w, 9);
    expect(box.half.y).toBeCloseTo(0.002, 9); // thin wall, not the tilted AABB (~0.25 m)
    expect(box.half.x).toBeCloseTo(0.5, 9);
    expect(box.center).toEqual({ x: 0.5, y: 1, z: 0 });
    plugin.dispose();
  });

  it('an offset centre goes through the world matrix (X negated, rotated)', async () => {
    bigZone();
    const root = new Object3D();
    const n = colliderNode('Offset', { center: { x: 0.2, y: 0.1, z: 0 }, size: { x: 0.1, y: 0.1, z: 0.1 } });
    n.position.set(1, 0, 0);
    n.rotation.set(0, Math.PI / 2, 0);
    root.add(n);
    const plugin = await build(root);
    const [box] = rec.implicit();
    // glTF local (-0.2, 0.1, 0) rotated +90° about Y → (0, 0.1, 0.2), then + (1, 0, 0).
    expect(box.center.x).toBeCloseTo(1, 9);
    expect(box.center.y).toBeCloseTo(0.1, 9);
    expect(box.center.z).toBeCloseTo(0.2, 9);
    plugin.dispose();
  });

  it('a scaled parent scales the half extents and the centre offset', async () => {
    bigZone();
    const root = new Object3D();
    const parent = new Object3D();
    parent.scale.set(2, 2, 2);
    const n = colliderNode('Scaled', { center: { x: 0, y: 0.1, z: 0 }, size: { x: 0.2, y: 0.02, z: 0.4 } });
    parent.add(n);
    root.add(parent);
    const plugin = await build(root);
    const [box] = rec.implicit();
    expect(box.half.x).toBeCloseTo(0.2, 9);
    expect(box.half.y).toBeCloseTo(0.02, 9);
    expect(box.half.z).toBeCloseTo(0.4, 9);
    expect(box.center.y).toBeCloseTo(0.2, 9);
    plugin.dispose();
  });

  it('an axis-parallel legacy box is bit-identical to the former AABB; the body count is unchanged', async () => {
    bigZone();
    const root = new Object3D();
    const boxes = [
      { center: { x: 0.1, y: 0.2, z: 0.3 }, size: { x: 0.5, y: 0.25, z: 1 }, pos: [1.25, 0.3, -2.1] },
      { center: { x: 0, y: 0, z: 0 }, size: { x: 2, y: 0.05, z: 2 }, pos: [0, 0, 0] },
      { center: { x: -0.35, y: 0, z: 0.125 }, size: { x: 0.3, y: 0.3, z: 0.3 }, pos: [-3.5, 1.75, 0.5] },
    ];
    const nodes = boxes.map((b, i) => {
      const n = colliderNode(`Legacy${i}`, { center: b.center, size: b.size });
      n.position.set(b.pos[0], b.pos[1], b.pos[2]);
      root.add(n);
      return n;
    });
    const plugin = await build(root);
    const implicit = rec.implicit();
    expect(implicit).toHaveLength(boxes.length); // one body per collider node, as before
    for (let i = 0; i < boxes.length; i++) {
      const former = AABB.fromBoxCollider(nodes[i], boxes[i].center, boxes[i].size);
      const got = implicit.find((b) => b.id.endsWith(`Legacy${i}`))!;
      expect(got.center).toEqual({ x: former.center.x, y: former.center.y, z: former.center.z });
      expect(got.half).toEqual({ x: former.halfSize.x, y: former.halfSize.y, z: former.halfSize.z });
      expect(got.quat).toEqual({ x: 0, y: 0, z: 0, w: 1 });
    }
    plugin.dispose();
  });
});

// ─── Real Rapier ────────────────────────────────────────────────────────────

let rapierAvailable = false;
beforeAll(async () => {
  const probe = new RapierPhysicsProvider();
  try { await probe.init(); rapierAvailable = probe.ready; } catch { rapierAvailable = false; }
  probe.dispose();
}, 30000);

describe('plan-525 T7: a part slides down a tilted thin chute (real Rapier)', () => {
  it('slides along the slope and never falls through the 4 mm floor', async () => {
    if (!rapierAvailable) {
      if (REQUIRE_WASM) {
        throw new Error('[plan-525 T7] RV_PHYSICS_REQUIRE_WASM=1 but @dimforge/rapier3d-compat is not usable');
      }
      console.warn('[plan-525 T7] @dimforge/rapier3d-compat not installed (out-of-band) — skipping');
      return;
    }
    const provider = new RapierPhysicsProvider();
    await provider.init();
    try {
      provider.addZone('zone', { min: { x: -5, y: -5, z: -5 }, max: { x: 5, y: 5, z: 5 } },
        { friction: 0.2, restitution: 0, removeBelowY: -10 });
      // A 1.2 m long, 4 mm thin chute floor, tilted 35° (tan 35° > friction).
      const chute = new Object3D();
      chute.position.set(0, 1, 0);
      chute.rotation.set(0, 0, -35 * Math.PI / 180);
      chute.updateMatrixWorld(true);
      addOrientedStaticBox(provider, 'chute', chute, { center: { x: 0, y: 0, z: 0 }, size: { x: 1.2, y: 0.004, z: 0.3 } });

      // A 50 mm part resting flat on the uphill end of the chute.
      const half = 0.025;
      const start = new Vector3(-0.45, 0.002 + half + 0.001, 0).applyMatrix4(chute.matrixWorld);
      const quat = chute.getWorldQuaternion(new Quaternion());
      provider.addDynamicMU('part', { pos: start, quat }, { x: half, y: half, z: half }, { x: 0, y: 0, z: 0 }, 0.1);

      const inv = new Matrix4().copy(chute.matrixWorld).invert();
      const pos = new Vector3();
      let minLocalY = Infinity;
      for (let i = 0; i < 45; i++) {
        provider.step(PHYSICS_FIXED_DT);
        provider.syncPoses((_id, p) => { pos.set(p.x, p.y, p.z); });
        const local = pos.clone().applyMatrix4(inv);
        minLocalY = Math.min(minLocalY, local.y);
      }
      const local = pos.clone().applyMatrix4(inv);
      // Downhill is local +X (the chute falls toward +X): it moved along the slope …
      expect(local.x - (-0.45)).toBeGreaterThan(0.05);
      // … and stayed ON the thin floor (never tunnelled below its top face).
      expect(minLocalY).toBeGreaterThan(0.002 + half - 0.01);
    } finally {
      provider.dispose();
    }
  }, 30000);
});
