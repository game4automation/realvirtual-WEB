// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Shared fixtures for the collision suites (plan-394, rebuilt for plan-781).
 *
 * Scenes go through the BAKED path: a tree of role nodes is baked destructively
 * and placed (`bakeAndPlace`), exactly like a loaded model, so a static role
 * node's triangles live in the asset's root chunk and a mover's in its own
 * chunk — the shape the collision bodies resolve through the bake registry.
 * Nothing here builds a three-mesh-bvh tree any more: collision reads the pick
 * structure the bake built.
 *
 * A body node carries `CollisionRole` extras (a component — it survives the
 * bake) and, when it must move on its own, the test capability
 * `TestCollisionMover` (`bake: 'chunk'` — it becomes a chunk boundary, like a
 * Drive). The role the tests check is still registered explicitly with
 * `manager.register()`, as the component's `init()` would.
 */

import { BoxGeometry, Group, Mesh, MeshBasicMaterial, Object3D, Scene, Vector3 } from 'three';
import type { BufferGeometry } from 'three';
import '../src/core/engine/rv-scene-loader';   // side effect: capabilities, schemas
import { registerComponentSchema } from '../src/core/engine/rv-component-registry';
import { RVUberMaterial } from '../src/core/engine/rv-uber-material';
import { BakeRegistry } from '../src/core/engine/rv-bake-registry';
import { AABB } from '../src/core/engine/rv-aabb';
import { RVCollisionManager, type CollisionHighlightHost } from '../src/core/engine/rv-collision-manager';
import type { CollisionRoleName } from '../src/core/engine/rv-collision-role';
import { bakeAndPlace, uberBakeGeometry } from './fixtures/bake-fixture';

/** A chunk-boundary capability for test bodies that must move (like a Drive). */
registerComponentSchema('TestCollisionMover', {}, { bake: 'chunk' });

const MAT = new MeshBasicMaterial();
export const COLLISION_UBER = new RVUberMaterial(false);

export interface MeshOpts {
  size?: [number, number, number];
  pos?: [number, number, number];
  rotY?: number;
  scale?: number;
  name?: string;
  /** Segments per axis (more triangles). */
  segments?: number;
}

/**
 * A plain box mesh (NOT baked) — for scenes that test real meshes on purpose
 * (a keep mesh, an MU clone, an unbaked context). Already world-matrix updated.
 */
export function boxMesh(opts: MeshOpts = {}): Mesh {
  const [sx, sy, sz] = opts.size ?? [1, 1, 1];
  const n = opts.segments ?? 1;
  const geo: BufferGeometry = new BoxGeometry(sx, sy, sz, n, n, n);
  const mesh = new Mesh(geo, MAT);
  mesh.name = opts.name ?? 'box';
  if (opts.pos) mesh.position.set(...opts.pos);
  if (opts.rotY) mesh.rotation.y = opts.rotY;
  if (opts.scale) mesh.scale.setScalar(opts.scale);
  mesh.updateMatrixWorld(true);
  return mesh;
}

/** An uber-baked box mesh — what the bake merges into a chunk. */
export function uberBox(name: string, opts: MeshOpts = {}): Mesh {
  const [sx, sy, sz] = opts.size ?? [1, 1, 1];
  const n = opts.segments ?? 1;
  const mesh = new Mesh(uberBakeGeometry(new BoxGeometry(sx, sy, sz, n, n, n)), COLLISION_UBER);
  mesh.name = name;
  mesh.userData._rvUberBaked = true;
  if (opts.pos) mesh.position.set(...opts.pos);
  if (opts.rotY) mesh.rotation.y = opts.rotY;
  if (opts.scale) mesh.scale.setScalar(opts.scale);
  return mesh;
}

export interface BodyOpts extends MeshOpts {
  /** The role written as `CollisionRole` extras (keeps the node through the bake). */
  role?: CollisionRoleName;
  /** A chunk boundary — the node can move on its own. */
  mover?: boolean;
  /** Node position (the mesh sits at the node origin unless `meshPos`). */
  at?: [number, number, number];
  /** No own mesh. */
  noMesh?: boolean;
}

/** A body node: `CollisionRole` extras, optional mover capability, one uber box child. */
export function bodyNode(name: string, opts: BodyOpts = {}, ...children: Object3D[]): Group {
  const g = new Group();
  g.name = name;
  const rv: Record<string, unknown> = { CollisionRole: { CollisionRole: opts.role ?? 'Machine' } };
  if (opts.mover) rv.TestCollisionMover = { enabled: true };
  g.userData.realvirtual = rv;
  if (opts.at) g.position.set(...opts.at);
  if (!opts.noMesh) g.add(uberBox(`${name}Mesh`, opts));
  for (const c of children) g.add(c);
  return g;
}

/** A plain group (merged away unless something claims it). */
export function plainGroup(name: string, ...children: Object3D[]): Group {
  const g = new Group();
  g.name = name;
  for (const c of children) g.add(c);
  return g;
}

export interface BakedCollisionScene {
  scene: Scene;
  bakeRegistry: BakeRegistry;
  template: Object3D;
  /** A surviving node by name (the bake re-creates every node — look them up AFTER it). */
  node(name: string): Object3D;
  /** A manager wired to this scene's registry (and a highlight fake). */
  manager: RVCollisionManager;
  highlight: FakeHighlightHost;
}

/** Bake `root` destructively, place it in a scene and wire a collision manager. */
export async function bakeCollisionScene(root: Object3D): Promise<BakedCollisionScene> {
  const bakeRegistry = new BakeRegistry();
  const placed = await bakeAndPlace(root, bakeRegistry, { uber: COLLISION_UBER });
  const scene = new Scene();
  scene.add(placed.template);
  scene.updateMatrixWorld(true);
  const manager = new RVCollisionManager();
  manager.setGeometrySource(bakeRegistry);
  const highlight = new FakeHighlightHost();
  manager.setHighlightHost(highlight);
  return { scene, bakeRegistry, template: placed.template, node: placed.node, manager, highlight };
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
 * reads. An INSTANCED one passes the pool `InstancedMesh` as `node` and is posed
 * by `moveTo` (its slot pose); a clone one passes its own node.
 */
export class FakeMU {
  readonly id: number;
  readonly node: Object3D;
  readonly aabb: AABB;
  readonly isInstanced: boolean;
  physicsOwned = false;
  physicsBodyId: string | null = null;
  owner = 'transport' as const;

  private readonly _pos = new Vector3();
  private readonly _half: Vector3;

  constructor(id: number, node: Object3D, half: Vector3, isInstanced: boolean) {
    this.id = id;
    this.node = node;
    this.isInstanced = isInstanced;
    this._half = half.clone();
    this.aabb = AABB.fromPositionFn((out) => out.copy(this._pos), half);
  }

  /** Move the instance (slot pose) and refresh its own AABB (what transport does per tick).
   *  A clone MU moves its node. */
  moveTo(x: number, y: number, z: number): void {
    this._pos.set(x, y, z);
    if (!this.isInstanced) {
      this.node.position.set(x, y, z);
      this.node.updateMatrixWorld(true);
    }
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
 * Baked scene with two independent bodies that can be pushed into each other:
 *
 *   Asset / Robot   (role Robot, mover)   → RobotMesh   at the origin
 *   Asset / Machine (role Machine, mover) → MachineMesh at x = gap
 */
export async function twoBodyScene(gap = 5): Promise<{
  scene: Scene; robot: Object3D; machine: Object3D; bakeRegistry: BakeRegistry; template: Object3D;
  node(name: string): Object3D;
}> {
  const root = plainGroup('Asset',
    bodyNode('Robot', { role: 'Robot', mover: true }),
    bodyNode('Machine', { role: 'Machine', mover: true, at: [gap, 0, 0] }),
  );
  const s = await bakeCollisionScene(root);
  return {
    scene: s.scene, robot: s.node('Robot'), machine: s.node('Machine'),
    bakeRegistry: s.bakeRegistry, template: s.template, node: s.node,
  };
}
