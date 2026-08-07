// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Shared fixtures for the plan-394 collision test suites.
 *
 * Everything here builds REAL Three.js objects with REAL `three-mesh-bvh`
 * trees — the point of these tests is to catch the two failure modes the plan
 * review found (a narrowphase that never looks at a triangle, a body box frozen
 * in its build pose), and a mocked BVH would hide both.
 */

import { BoxGeometry, Mesh, MeshBasicMaterial, Object3D, Scene, Vector3 } from 'three';
import type { BufferGeometry } from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { AABB } from '../src/core/engine/rv-aabb';
import type { CollisionHighlightHost } from '../src/core/engine/rv-collision-manager';

const MAT = new MeshBasicMaterial();

/** Attach a real MeshBVH to a geometry (what the loader does at load time). */
export function withBVH<T extends BufferGeometry>(geo: T): T {
  geo.boundsTree = new MeshBVH(geo);
  return geo;
}

export interface MeshOpts {
  size?: [number, number, number];
  pos?: [number, number, number];
  rotY?: number;
  scale?: number;
  bvh?: boolean;
  name?: string;
}

/** A box mesh, by default with a BVH, already world-matrix updated. */
export function boxMesh(opts: MeshOpts = {}): Mesh {
  const [sx, sy, sz] = opts.size ?? [1, 1, 1];
  const geo = new BoxGeometry(sx, sy, sz);
  if (opts.bvh !== false) withBVH(geo);
  const mesh = new Mesh(geo, MAT);
  mesh.name = opts.name ?? 'box';
  if (opts.pos) mesh.position.set(...opts.pos);
  if (opts.rotY) mesh.rotation.y = opts.rotY;
  if (opts.scale) mesh.scale.setScalar(opts.scale);
  mesh.updateMatrixWorld(true);
  return mesh;
}

/** Records show/hide calls so tests can assert highlight lifetime. */
export class FakeHighlightHost implements CollisionHighlightHost {
  readonly calls: { roots: readonly Object3D[] | null }[] = [];
  showCollision(roots: readonly Object3D[]): void {
    this.calls.push({ roots: [...roots] });
  }
  hideCollision(): void {
    this.calls.push({ roots: null });
  }
  /** Roots of the most recent call, or null when the outline was cleared. */
  get current(): readonly Object3D[] | null {
    return this.calls.length > 0 ? this.calls[this.calls.length - 1].roots : null;
  }
}

/**
 * Minimal MU stand-in implementing the accessor surface the collision manager
 * reads. `isInstanced` decides whether the body is aabbOnly (§2.8): an
 * instanced MU shares its pool's InstancedMesh, so only its own AABB carries
 * per-instance truth.
 */
export class FakeMU {
  readonly id: number;
  readonly node: Object3D;
  readonly aabb: AABB;
  readonly isInstanced: boolean;
  physicsOwned = false;
  physicsBodyId: string | null = null;

  private readonly _pos = new Vector3();
  private readonly _half: Vector3;

  constructor(id: number, node: Object3D, half: Vector3, isInstanced: boolean) {
    this.id = id;
    this.node = node;
    this.isInstanced = isInstanced;
    this._half = half.clone();
    this.aabb = AABB.fromPositionFn((out) => out.copy(this._pos), half);
  }

  /** Move the instance and refresh its own AABB (what transport does per tick). */
  moveTo(x: number, y: number, z: number): void {
    this._pos.set(x, y, z);
    this.aabb.halfSize.copy(this._half);
    this.aabb.update();
  }

  getWorldPosition(out: Vector3): Vector3 { return out.copy(this._pos); }
  getPosition(): Vector3 { return this._pos; }
  setPosition(v: Vector3): void { this._pos.copy(v); }
  getQuaternion() { return this.node.quaternion; }
  setQuaternion(q: { x: number; y: number; z: number; w: number }): void {
    this.node.quaternion.set(q.x, q.y, q.z, q.w);
  }
  rotateOnAxis(): void { /* not needed by the collision manager */ }
  getName(): string { return `mu#${this.id}`; }
}

/**
 * Scene with two independent bodies whose meshes can be pushed into each other:
 *
 *   scene / Robot   (role Robot)   → RobotMesh
 *   scene / Machine (role Machine) → MachineMesh
 */
export function twoBodyScene(gap = 5): {
  scene: Scene; robot: Object3D; machine: Object3D;
  robotMesh: Mesh; machineMesh: Mesh;
} {
  const scene = new Scene();
  const robot = new Object3D();
  robot.name = 'Robot';
  const robotMesh = boxMesh({ name: 'RobotMesh' });
  robot.add(robotMesh);

  const machine = new Object3D();
  machine.name = 'Machine';
  machine.position.x = gap;
  const machineMesh = boxMesh({ name: 'MachineMesh' });
  machine.add(machineMesh);

  scene.add(robot, machine);
  scene.updateMatrixWorld(true);
  return { scene, robot, machine, robotMesh, machineMesh };
}
