// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import {
  BufferGeometry, Material, Mesh, Object3D, Quaternion, Scene, Vector3,
} from 'three';
import { computeTemplateAABBInfo, MUInstancePool, type InstancedMovingUnit } from './rv-mu';
import type { GroupRegistry } from './rv-group-registry';

/** Construction options for an externally posed entity pool. */
export interface EntityPoolOptions {
  template?: Object3D;
  geometry?: BufferGeometry;
  material?: Material | Material[];
  name?: string;
  groupName?: string;
  pickable?: boolean;
  initialCapacity?: number;
  growth?: number;
}

/** Viewer capabilities used by {@link EntityPool}. */
export interface EntityPoolHost {
  readonly scene: Scene;
  groups: GroupRegistry | null;
  refreshInstancedPickTargets(): void;
  ensureGroups(): GroupRegistry;
}

/** Instanced pool for objects whose poses are supplied by an external stream. */
export class EntityPool {
  private readonly mus = new Map<string, InstancedMovingUnit>();
  private readonly ids: (string | null)[] = [];
  private readonly pool: MUInstancePool;
  private readonly groupName: string | null;
  private readonly pickable: boolean;
  private disposed = false;

  constructor(private readonly host: EntityPoolHost, options: EntityPoolOptions) {
    const template = options.template;
    const mesh = template ? findMesh(template) : null;
    const geometry = options.geometry ?? mesh?.geometry;
    const material = options.material ?? mesh?.material;
    if (!geometry || !material) throw new Error('EntityPool requires a mesh template or geometry and material.');
    const bounds = template ? computeTemplateAABBInfo(template) : geometryBounds(geometry);
    this.pool = new MUInstancePool(
      geometry, material, options.name ?? template?.name ?? mesh?.name ?? 'Entities',
      bounds.halfSize, bounds.localCenter, Math.max(1, Math.floor(options.initialCapacity ?? 128)),
    );
    this.pool.growthFactor = Math.max(1.01, options.growth ?? 2);
    this.pickable = options.pickable ?? true;
    this.groupName = options.groupName ?? null;
    this.pool.onMeshChanged = (oldMesh, newMesh) => {
      if (this.groupName) {
        const groups = this.host.ensureGroups();
        groups.unregister(this.groupName, oldMesh);
        groups.register(this.groupName, newMesh);
      }
      if (this.pickable) this.host.refreshInstancedPickTargets();
    };
    this.host.scene.add(this.pool.instancedMesh);
    if (this.groupName) this.host.ensureGroups().register(this.groupName, this.pool.instancedMesh);
    if (this.pickable) this.host.refreshInstancedPickTargets();
  }

  /** Number of live entities. */
  get count(): number { return this.pool.activeCount; }

  /** Instanced mesh used for rendering and raycast registration. */
  get mesh() { return this.pool.instancedMesh; }

  /** Sets an entity pose, allocating an instance when needed. */
  set(id: string, position: Vector3, quaternion: Quaternion): void {
    if (this.disposed) throw new Error('EntityPool is disposed.');
    let mu = this.mus.get(id);
    if (!mu) {
      mu = this.pool.spawn(position, quaternion, id, this.pool.templateName);
      this.mus.set(id, mu);
      this.ids[mu.slotIndex] = id;
    } else {
      mu.setPosition(position);
      mu.setQuaternion(quaternion);
    }
  }

  /** Uploads all poses changed since the previous flush. */
  flush(): void { this.pool.updateInstanceMatrix(); }

  /** Removes an entity and returns whether it existed. */
  remove(id: string): boolean {
    const mu = this.mus.get(id);
    if (!mu) return false;
    const removedSlot = mu.slotIndex;
    const lastSlot = this.pool.activeCount - 1;
    const movedId = this.ids[lastSlot] ?? null;
    this.pool.release(mu);
    this.mus.delete(id);
    if (removedSlot !== lastSlot) this.ids[removedSlot] = movedId;
    this.ids.length = this.pool.activeCount;
    this.pool.updateInstanceMatrix();
    return true;
  }

  /** Returns whether an entity is allocated. */
  has(id: string): boolean { return this.mus.has(id); }

  /** Resolves a raycast instance id to the external entity id. */
  idAt(instanceId: number): string | null { return this.ids[instanceId] ?? null; }

  /** Removes every entity while retaining GPU capacity. */
  clear(): void {
    for (const id of [...this.mus.keys()]) this.remove(id);
  }

  /** Releases the pool and unregisters its scene and group entries. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const mesh = this.pool.instancedMesh;
    if (this.groupName) this.host.groups?.unregister(this.groupName, mesh);
    this.mus.clear(); this.ids.length = 0;
    this.pool.dispose();
    if (this.pickable) this.host.refreshInstancedPickTargets();
  }
}

function findMesh(root: Object3D): Mesh | null {
  if ((root as Mesh).isMesh) return root as Mesh;
  let result: Mesh | null = null;
  root.traverse((node) => { if (!result && (node as Mesh).isMesh) result = node as Mesh; });
  return result;
}

function geometryBounds(geometry: BufferGeometry): { halfSize: Vector3; localCenter: Vector3 } {
  geometry.computeBoundingBox();
  const box = geometry.boundingBox;
  if (!box) return { halfSize: new Vector3(), localCenter: new Vector3() };
  return { halfSize: box.getSize(new Vector3()).multiplyScalar(0.5), localCenter: box.getCenter(new Vector3()) };
}
