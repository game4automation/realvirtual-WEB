// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-collider-extras.test.ts — plan-467 test 9.1 (Phase 1).
 *
 * The ONE parser for Unity's `userData.realvirtual` collider metadata: the
 * legacy top-level `BoxCollider` key, the modern `colliders[]` array with Box
 * and MeshCollider entries, the enabled/isTrigger flags, degenerate-box
 * rejection, and `renderPrimitivesOf` for multi-material (multi-primitive)
 * nodes.
 */

import { describe, it, expect } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshBasicMaterial, Object3D, Scene } from 'three';
import '../src/core/engine/rv-scene-loader';
import { createRuntimeNode } from '../src/core/engine/rv-scene-loader';
import { AABB } from '../src/core/engine/rv-aabb';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { RVTransportManager } from '../src/core/engine/rv-transport-manager';
import { RVSensor } from '../src/core/engine/rv-sensor';
import { RVBoxCollider } from '../src/core/engine/rv-box-collider';
import {
  firstBoxCollider,
  getColliderExtras,
  getColliderExtrasFrom,
  isSolidCollider,
  isValidBoxDef,
  renderPrimitivesOf,
} from '../src/core/engine/rv-collider-extras';

function nodeWith(rv: Record<string, unknown>): Object3D {
  const node = new Object3D();
  node.userData.realvirtual = rv;
  return node;
}

const BOX = { center: { x: 0, y: 0, z: 0 }, size: { x: 1, y: 2, z: 3 } };

describe('getColliderExtras — legacy top-level BoxCollider', () => {
  it('parses the legacy key as a permissive (enabled, non-trigger) box', () => {
    const cols = getColliderExtras(nodeWith({ BoxCollider: BOX }));
    expect(cols).toHaveLength(1);
    expect(cols[0]).toMatchObject({ kind: 'box', enabled: true, isTrigger: false });
    expect((cols[0] as { size: { y: number } }).size.y).toBe(2);
  });

  it('hands back center/size in UNITY space — the X flip happens in AABB.fromBoxCollider', () => {
    const cols = getColliderExtras(nodeWith({ BoxCollider: { center: { x: 5, y: 0, z: 0 }, size: BOX.size } }));
    expect((cols[0] as { center: { x: number } }).center.x).toBe(5); // NOT negated here
  });

  it('rejects a degenerate legacy box (zero/negative size, NaN center)', () => {
    expect(getColliderExtras(nodeWith({ BoxCollider: { center: BOX.center, size: { x: 0, y: 1, z: 1 } } }))).toHaveLength(0);
    expect(getColliderExtras(nodeWith({ BoxCollider: { center: { x: NaN, y: 0, z: 0 }, size: BOX.size } }))).toHaveLength(0);
  });
});

describe('getColliderExtras — colliders[] array', () => {
  it('parses Box and BoxCollider type spellings', () => {
    const cols = getColliderExtras(nodeWith({
      colliders: [
        { type: 'Box', ...BOX, enabled: true, isTrigger: false },
        { type: 'BoxCollider', ...BOX, enabled: true, isTrigger: false },
      ],
    }));
    expect(cols).toHaveLength(2);
    expect(cols.every((c) => c.kind === 'box')).toBe(true);
  });

  it('parses MeshCollider entries with the convex flag', () => {
    const cols = getColliderExtras(nodeWith({
      colliders: [
        { type: 'MeshCollider', convex: true, enabled: true, isTrigger: false },
        { type: 'MeshCollider', convex: false, enabled: true, isTrigger: false },
      ],
    }));
    expect(cols).toHaveLength(2);
    expect(cols[0]).toMatchObject({ kind: 'mesh', convex: true });
    expect(cols[1]).toMatchObject({ kind: 'mesh', convex: false });
  });

  it('reports enabled:false and isTrigger:true instead of dropping them', () => {
    const cols = getColliderExtras(nodeWith({
      colliders: [
        { type: 'BoxCollider', ...BOX, enabled: false, isTrigger: false },
        { type: 'BoxCollider', ...BOX, enabled: true, isTrigger: true },
      ],
    }));
    expect(cols).toHaveLength(2);
    expect(cols.map(isSolidCollider)).toEqual([false, false]);
  });

  it('ignores collider types the WebViewer has no shape for', () => {
    const cols = getColliderExtras(nodeWith({
      colliders: [
        { type: 'SphereCollider', center: BOX.center, radius: 1, enabled: true },
        { type: 'CapsuleCollider', center: BOX.center, radius: 1, height: 2, enabled: true },
        { type: 'TerrainCollider', enabled: true },
      ],
    }));
    expect(cols).toHaveLength(0);
  });

  it('skips degenerate box entries but keeps the valid ones', () => {
    const cols = getColliderExtras(nodeWith({
      colliders: [
        { type: 'BoxCollider', center: BOX.center, size: { x: 0, y: 0, z: 0 } },
        { type: 'BoxCollider', ...BOX },
      ],
    }));
    expect(cols).toHaveLength(1);
    expect((cols[0] as { size: { y: number } }).size.y).toBe(2);
  });

  it('returns an empty list without extras, without colliders, or for junk entries', () => {
    expect(getColliderExtras(new Object3D())).toHaveLength(0);
    expect(getColliderExtrasFrom(undefined)).toHaveLength(0);
    expect(getColliderExtras(nodeWith({ Drive: {} }))).toHaveLength(0);
    expect(getColliderExtras(nodeWith({ colliders: 'not-an-array' }))).toHaveLength(0);
    expect(getColliderExtras(nodeWith({ colliders: [null, 42, {}] }))).toHaveLength(0);
  });

  it('keeps the legacy key FIRST, then the array in export order (precedence contract)', () => {
    const cols = getColliderExtras(nodeWith({
      BoxCollider: { center: BOX.center, size: { x: 9, y: 9, z: 9 } },
      colliders: [{ type: 'BoxCollider', ...BOX }],
    }));
    expect(cols).toHaveLength(2);
    expect((cols[0] as { size: { x: number } }).size.x).toBe(9);
  });
});

describe('firstBoxCollider', () => {
  it('returns the first box and skips mesh entries', () => {
    const node = nodeWith({
      colliders: [
        { type: 'MeshCollider', convex: true },
        { type: 'BoxCollider', ...BOX },
      ],
    });
    expect(firstBoxCollider(node)?.size.y).toBe(2);
  });

  it('solidOnly skips disabled and trigger boxes', () => {
    const node = nodeWith({
      colliders: [
        { type: 'BoxCollider', center: BOX.center, size: { x: 7, y: 7, z: 7 }, isTrigger: true },
        { type: 'BoxCollider', ...BOX },
      ],
    });
    expect(firstBoxCollider(node)?.size.x).toBe(7);          // unfiltered: trigger wins
    expect(firstBoxCollider(node, true)?.size.x).toBe(1);    // solid only: skipped
  });

  it('returns null without any box', () => {
    expect(firstBoxCollider(nodeWith({ colliders: [{ type: 'MeshCollider' }] }))).toBeNull();
  });
});

describe('isValidBoxDef', () => {
  it('accepts a finite, strictly positive box and rejects the rest', () => {
    expect(isValidBoxDef({ x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 1 })).toBe(true);
    expect(isValidBoxDef({ x: 0, y: 0, z: 0 }, { x: -1, y: 1, z: 1 })).toBe(false);
    expect(isValidBoxDef({ x: 0, y: 0, z: 0 }, { x: Infinity, y: 1, z: 1 })).toBe(false);
  });
});

describe('renderPrimitivesOf', () => {
  const geo = (): BoxGeometry => new BoxGeometry(1, 1, 1);
  const mat = (): MeshBasicMaterial => new MeshBasicMaterial();

  it('returns the node itself when it IS a mesh', () => {
    const mesh = new Mesh(geo(), mat());
    expect(renderPrimitivesOf(mesh)).toEqual([mesh]);
  });

  it('returns the primitive children of a multi-material Group (GLTFLoader shape)', () => {
    const group = new Group();
    const p1 = new Mesh(geo(), mat());
    const p2 = new Mesh(geo(), mat());
    group.add(p1, p2);
    expect(renderPrimitivesOf(group)).toEqual([p1, p2]);
  });

  it('skips children that are objects in their own right (own rv extras)', () => {
    const group = new Group();
    const primitive = new Mesh(geo(), mat());
    const child = new Mesh(geo(), mat());
    child.userData.realvirtual = { Drive: {} };
    group.add(primitive, child);
    expect(renderPrimitivesOf(group)).toEqual([primitive]);
  });

  it('never recurses past one level — a grandchild is a separate object', () => {
    const group = new Group();
    const inner = new Group();
    inner.add(new Mesh(geo(), mat()));
    group.add(inner);
    expect(renderPrimitivesOf(group)).toEqual([]);
  });

  it('returns an empty list for a geometry-less node', () => {
    expect(renderPrimitivesOf(new Object3D())).toEqual([]);
  });
});

// ─── plan-525 T2: BoxCollider became a component — the data meaning did not ──

describe('plan-525 T2: authorable BoxCollider leaves the shared $def untouched', () => {
  const SENSOR_BOX = { center: { x: 0.2, y: 0.05, z: -0.1 }, size: { x: 0.3, y: 0.1, z: 0.4 } };

  it('the parser reads a web-authored box exactly like a Unity export', () => {
    const cols = getColliderExtras(nodeWith({ BoxCollider: SENSOR_BOX }));
    expect(cols).toEqual([{ kind: 'box', center: SENSOR_BOX.center, size: SENSOR_BOX.size, enabled: true, isTrigger: false }]);
  });

  it('a Sensor with a BoxCollider keeps its AABB and stays the primary instance of its node', () => {
    const scene = new Scene();
    const root = new Group(); root.name = 'Root'; scene.add(root);
    root.position.set(1, 0.5, -2);
    root.updateMatrixWorld(true);
    const registry = new NodeRegistry();
    registry.registerNode('Root', root);
    const node = createRuntimeNode(
      { registry, signalStore: new SignalStore(), scene, transportManager: new RVTransportManager() },
      {
        parentPath: 'Root', name: 'Light', position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1],
        components: { Sensor: { UseRaycast: false }, BoxCollider: SENSOR_BOX },
      },
    )!;
    expect(node).not.toBeNull();
    const sensor = registry.getByPath<RVSensor>('Sensor', 'Root/Light')!;
    const box = registry.getByPath<RVBoxCollider>('BoxCollider', 'Root/Light')!;
    expect(sensor).toBeInstanceOf(RVSensor);
    expect(box).toBeInstanceOf(RVBoxCollider);
    // Same AABB as the Unity-export path always produced (AABB.fromBoxCollider).
    const expected = AABB.fromBoxCollider(node, SENSOR_BOX.center, SENSOR_BOX.size);
    sensor.updateAABB();
    expect(sensor.aabb.center.toArray()).toEqual(expected.center.toArray());
    expect(sensor.aabb.halfSize.toArray()).toEqual(expected.halfSize.toArray());
    // The collider is an annotation: the sensor keeps the primary slot.
    expect(node.userData._rvComponentInstance).toBe(sensor);
    // The collider instance holds glTF-local metres (X negated on read).
    expect(box.center.toArray()).toEqual([-0.2, 0.05, -0.1]);
    expect(box.size.toArray()).toEqual([0.3, 0.1, 0.4]);
  });
});
