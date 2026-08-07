// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * sdk-nodehandle.test.ts — plan-210 §6 S1 (value boundary).
 *
 * The `SdkBridge` node ops are the host half of `NodeHandle`: every world
 * read must return PLAIN data (POJOs / arrays) — never three.js instances —
 * and the transform reads must agree with three.js as reference.
 */

import { describe, it, expect } from 'vitest';
import { Object3D, Quaternion, Scene, Vector3 } from 'three';
import { SdkBridge, type SdkEnvironment } from '../src/core/sdk/rv-sdk-self';
import type { SdkScheduler } from '../src/core/sdk/rv-script-hook';

const nullScheduler: SdkScheduler = {
  in: () => 0,
  at: () => 0,
  cancel: () => {},
  now: 0,
};

function makeScene() {
  const scene = new Scene();
  const line = new Object3D();
  line.name = 'Line1';
  const conveyor = new Object3D();
  conveyor.name = 'Conveyor1';
  conveyor.position.set(1, 2, 3);
  conveyor.rotateY(Math.PI / 2);
  const sensorNode = new Object3D();
  sensorNode.name = 'Sensor';
  sensorNode.position.set(0.5, 0, 0);
  scene.add(line);
  line.add(conveyor);
  conveyor.add(sensorNode);
  scene.updateMatrixWorld(true);
  return { scene, line, conveyor, sensorNode };
}

function makeBridge(node: Object3D, extra: Partial<SdkEnvironment> = {}) {
  const env: SdkEnvironment = {
    name: node.name,
    path: `Line1/${node.name}`,
    node,
    scheduler: nullScheduler,
    ...extra,
  };
  return new SdkBridge(env);
}

/** True for plain data only (POJO tree / arrays / primitives). */
function isPlain(v: unknown): boolean {
  if (v === null || typeof v !== 'object') return true;
  if (Array.isArray(v)) return v.every(isPlain);
  if (Object.getPrototypeOf(v) !== Object.prototype) return false;
  return Object.values(v).every(isPlain);
}

describe('SdkBridge node reads — POJOs only, never three.js instances', () => {
  it('worldPosition/worldQuaternion/scale/bounds/worldMatrix are plain data', () => {
    const { conveyor } = makeScene();
    const b = makeBridge(conveyor);
    const h = b.hostCall('node.self');
    for (const what of ['worldPosition', 'worldQuaternion', 'localPosition', 'localQuaternion', 'scale', 'bounds', 'worldMatrix']) {
      const v = b.hostCall('node.read', h, what);
      expect(isPlain(v), `${what} leaked a class instance`).toBe(true);
      expect(v instanceof Vector3).toBe(false);
      expect(v instanceof Quaternion).toBe(false);
    }
    expect(b.hostCall('node.read', h, 'worldMatrix')).toHaveLength(16);
  });

  it('worldPosition matches three.js getWorldPosition', () => {
    const { conveyor, sensorNode } = makeScene();
    const b = makeBridge(conveyor, { resolveNode: () => sensorNode });
    const h = b.hostCall('node.resolve', 'Sensor');
    const got = b.hostCall('node.read', h, 'worldPosition') as { x: number; y: number; z: number };
    const ref = sensorNode.getWorldPosition(new Vector3());
    expect(got.x).toBeCloseTo(ref.x, 12);
    expect(got.y).toBeCloseTo(ref.y, 12);
    expect(got.z).toBeCloseTo(ref.z, 12);
  });

  it('worldDirection applies the world rotation to the local axis (default +Z)', () => {
    const { conveyor } = makeScene(); // rotated 90° about Y → +Z maps to +X
    const b = makeBridge(conveyor);
    const h = b.hostCall('node.self');
    const dir = b.hostCall('node.worldDirection', h, null) as { x: number; y: number; z: number };
    expect(dir.x).toBeCloseTo(1, 9);
    expect(dir.z).toBeCloseTo(0, 9);
    const up = b.hostCall('node.worldDirection', h, { x: 0, y: 1, z: 0 }) as { y: number };
    expect(up.y).toBeCloseTo(1, 9);
  });

  it('worldToLocal / localToWorld round-trip', () => {
    const { conveyor } = makeScene();
    const b = makeBridge(conveyor);
    const h = b.hostCall('node.self');
    const p = { x: 4, y: -1, z: 2 };
    const local = b.hostCall('node.worldToLocal', h, p) as { x: number; y: number; z: number };
    const back = b.hostCall('node.localToWorld', h, local) as { x: number; y: number; z: number };
    expect(back.x).toBeCloseTo(p.x, 9);
    expect(back.y).toBeCloseTo(p.y, 9);
    expect(back.z).toBeCloseTo(p.z, 9);
    expect(isPlain(local) && isPlain(back)).toBe(true);
  });

  it('parent() walks up but stops at (excludes) the scene; ids are stable', () => {
    const { conveyor } = makeScene();
    const b = makeBridge(conveyor);
    const h = b.hostCall('node.self');
    const parent = b.hostCall('node.parent', h);
    expect(parent).not.toBeNull();
    expect(b.hostCall('node.read', parent, 'name')).toBe('Line1');
    expect(b.hostCall('node.parent', parent)).toBeNull(); // scene excluded
    expect(b.hostCall('node.self')).toBe(h); // stable id for the same node
  });

  it('path read builds the full hierarchy path; occupied uses the env probe', () => {
    const { conveyor, sensorNode } = makeScene();
    const b = makeBridge(conveyor, {
      resolveNode: () => sensorNode,
      occupied: (n) => n === sensorNode,
    });
    const h = b.hostCall('node.resolve', 'Sensor');
    expect(b.hostCall('node.read', h, 'path')).toBe('Line1/Conveyor1/Sensor');
    expect(b.hostCall('node.read', h, 'occupied')).toBe(true);
    expect(b.hostCall('node.read', b.hostCall('node.self'), 'occupied')).toBe(false);
  });

  it('unresolvable nodes return null (never throw)', () => {
    const { conveyor } = makeScene();
    const b = makeBridge(conveyor, { resolveNode: () => null });
    expect(b.hostCall('node.resolve', 'Missing')).toBeNull();
    expect(b.hostCall('node.read', 9999, 'worldPosition')).toBeNull();
  });
});
