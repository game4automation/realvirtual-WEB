// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * RVPhysicsWorld — Rapier.js physics world wrapper for transport simulation.
 *
 * Encapsulates a Rapier WASM world with maps for MU bodies, conveyor surfaces,
 * and sensor colliders. Designed as an instance variable (NOT a singleton) to
 * support multiple RVViewer instances (e.g. tests, thumbnails).
 *
 * Zero-GC hot path: pre-allocated Vector3/Quaternion for sync operations.
 */

import { Vector3, Quaternion } from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';

// ─── Types ───────────────────────────────────────────────────────────

export interface PhysicsWorldConfig {
  gravity?: { x: number; y: number; z: number };
  friction?: number;
  substeps?: number;
}

export interface MUBodyInfo {
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
}

export interface SurfaceBodyInfo {
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
}

export interface SensorColliderInfo {
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
  /** MU IDs currently inside this sensor */
  occupants: Set<string>;
}

/** Callback signature for sensor events */
export type SensorEventCallback = (sensorId: string, muId: string, entered: boolean) => void;

// ─── RVPhysicsWorld ──────────────────────────────────────────────────

export class RVPhysicsWorld {
  private _rapier: typeof RAPIER;
  private _world: RAPIER.World | null = null;
  private _eventQueue: RAPIER.EventQueue | null = null;

  /** Maps MU ID → Rapier RigidBody + Collider */
  private _bodyMap = new Map<string, MUBodyInfo>();
  /** Maps Surface ID → Kinematic RigidBody + Collider */
  private _surfaceMap = new Map<string, SurfaceBodyInfo>();
  /** Maps Collider handle → sensor info (for event dispatch) */
  private _sensorMap = new Map<number, { sensorId: string; info: SensorColliderInfo }>();
  /** Maps Sensor ID → SensorColliderInfo (for lookup by ID) */
  private _sensorById = new Map<string, SensorColliderInfo>();
  /** Maps Collider handle → MU ID (for reverse lookup in events) */
  private _colliderToMU = new Map<number, string>();

  /** MU IDs marked for removal (Two-Phase-Removal) */
  private _markedForRemoval: string[] = [];

  /** Pre-allocated vectors for zero-GC sync */
  private _syncPos = new Vector3();
  private _syncQuat = new Quaternion();

  /** Guard: true after successful init() */
  physicsReady = false;

  /** Configuration */
  private _friction = 1.5;
  private _substeps = 1;

  /** Callback for sensor enter/leave events */
  onSensorEvent: SensorEventCallback | null = null;

  constructor(rapier: typeof RAPIER) {
    this._rapier = rapier;
  }

  // ─── Lifecycle ───────────────────────────────────────────────────

  /**
   * Initialize the physics world with the given configuration.
   * Must be called after RAPIER.init() has completed.
   */
  init(config?: PhysicsWorldConfig): void {
    const R = this._rapier;
    const grav = config?.gravity ?? { x: 0, y: -9.81, z: 0 };
    this._friction = config?.friction ?? 1.5;
    this._substeps = config?.substeps ?? 1;

    this._world = new R.World({ x: grav.x, y: grav.y, z: grav.z });
    this._eventQueue = new R.EventQueue(true);
    this.physicsReady = true;
  }

  /**
   * Dispose the physics world and free all WASM resources.
   */
  dispose(): void {
    if (this._world) {
      this._world.free();
      this._world = null;
    }
    if (this._eventQueue) {
      this._eventQueue.free();
      this._eventQueue = null;
    }
    this._bodyMap.clear();
    this._surfaceMap.clear();
    this._sensorMap.clear();
    this._sensorById.clear();
    this._colliderToMU.clear();
    this._markedForRemoval.length = 0;
    this.physicsReady = false;
  }

  // ─── Ground Plane ───────────────────────────────────────────────

  /**
   * Add a static ground plane at y=0. This prevents MUs from falling
   * through the void when they miss or leave a conveyor surface.
   * Uses a large thin cuboid (50m × 0.01m × 50m).
   */
  addGroundPlane(friction?: number): void {
    if (!this._world || !this.physicsReady) return;
    const R = this._rapier;

    const bodyDesc = R.RigidBodyDesc.fixed()
      .setTranslation(0, -0.01, 0); // bottom of cuboid at y=-0.02, top at y=0
    const body = this._world.createRigidBody(bodyDesc);

    const f = friction ?? this._friction;
    R.ColliderDesc
      .cuboid(50, 0.01, 50)
      .setFriction(f)
      .setFrictionCombineRule(R.CoefficientCombineRule.Max);
    const colliderDesc = R.ColliderDesc
      .cuboid(50, 0.01, 50)
      .setFriction(f)
      .setFrictionCombineRule(R.CoefficientCombineRule.Max);
    this._world.createCollider(colliderDesc, body);
  }

  // ─── Body Count ──────────────────────────────────────────────────

  /** Total number of rigid bodies in the world (MUs + surfaces + sensor bodies). */
  get bodyCount(): number {
    if (!this._world) return 0;
    return this._world.bodies.len();
  }

  /** Number of MU bodies currently tracked. */
  get muCount(): number {
    return this._bodyMap.size;
  }

  // ─── MU Management ──────────────────────────────────────────────

  /**
   * Add a dynamic body for a Moving Unit.
   * @param muId Unique MU identifier
   * @param position World position {x, y, z} in meters
   * @param halfExtents Half-size of the box collider {x, y, z} in meters
   * @param mass Mass in kg (default 1)
   * @param linearDamping Linear damping (default 0.5)
   * @param angularDamping Angular damping (default 0.8)
   */
  addMU(
    muId: string,
    position: { x: number; y: number; z: number },
    halfExtents: { x: number; y: number; z: number },
    mass = 1,
    linearDamping = 0.5,
    angularDamping = 0.8,
  ): void {
    if (!this._world || !this.physicsReady) return;
    const R = this._rapier;

    const bodyDesc = R.RigidBodyDesc.dynamic()
      .setTranslation(position.x, position.y, position.z)
      .setLinearDamping(linearDamping)
      .setAngularDamping(angularDamping);
    const body = this._world.createRigidBody(bodyDesc);

    const colliderDesc = R.ColliderDesc
      .cuboid(halfExtents.x, halfExtents.y, halfExtents.z)
      .setMass(mass)
      .setFriction(0.8)
      .setRestitution(0.05);
    const collider = this._world.createCollider(colliderDesc, body);

    this._bodyMap.set(muId, { body, collider });
    this._colliderToMU.set(collider.handle, muId);
  }

  /**
   * Remove a MU body immediately (Two-Phase: call markMUForRemoval in event processing,
   * then flushRemovals at frame end).
   */
  removeMU(muId: string): void {
    if (!this._world) return;
    const info = this._bodyMap.get(muId);
    if (!info) return;

    // Remove collider→MU mapping
    this._colliderToMU.delete(info.collider.handle);

    // Remove from all sensor occupant sets
    for (const [, entry] of this._sensorMap) {
      entry.info.occupants.delete(muId);
    }

    // Remove rigid body (also removes its colliders automatically)
    this._world.removeRigidBody(info.body);
    this._bodyMap.delete(muId);
  }

  /**
   * Mark a MU for removal at end of frame (Two-Phase-Removal pattern).
   */
  markMUForRemoval(muId: string): void {
    this._markedForRemoval.push(muId);
  }

  /**
   * Flush all marked MU removals. Call at end of frame, after sync.
   */
  flushRemovals(): void {
    for (const muId of this._markedForRemoval) {
      this.removeMU(muId);
    }
    this._markedForRemoval.length = 0;
  }

  /**
   * Get the world-space position of a MU body.
   * Returns null if MU not found.
   */
  getBodyPosition(muId: string): { x: number; y: number; z: number } | null {
    const info = this._bodyMap.get(muId);
    if (!info) return null;
    const t = info.body.translation();
    return { x: t.x, y: t.y, z: t.z };
  }

  /**
   * Get the world-space rotation of a MU body as quaternion.
   * Returns null if MU not found.
   */
  getBodyRotation(muId: string): { x: number; y: number; z: number; w: number } | null {
    const info = this._bodyMap.get(muId);
    if (!info) return null;
    const r = info.body.rotation();
    return { x: r.x, y: r.y, z: r.z, w: r.w };
  }

  /**
   * Set the linear velocity of a MU body.
   */
  setMUVelocity(muId: string, velocity: { x: number; y: number; z: number }): void {
    const info = this._bodyMap.get(muId);
    if (!info) return;
    info.body.setLinvel({ x: velocity.x, y: velocity.y, z: velocity.z }, true);
  }

  /** Check if a MU body exists */
  hasMU(muId: string): boolean {
    return this._bodyMap.has(muId);
  }

  // ─── Conveyor Surface Management ────────────────────────────────

  /**
   * Add a kinematic-velocity-based body for a conveyor surface.
   * The body's linear velocity drives MUs via friction.
   *
   * @param surfaceId Unique surface identifier
   * @param position World position {x, y, z} in meters
   * @param rotation World rotation quaternion (default: identity)
   * @param halfExtents Half-size of the collider box in meters (local space)
   * @param direction Normalized transport direction
   * @param speed Speed in m/s (already converted from mm/s)
   * @param friction Friction coefficient (default uses world config)
   */
  addConveyorSurface(
    surfaceId: string,
    position: { x: number; y: number; z: number },
    rotation: { x: number; y: number; z: number; w: number } | null,
    halfExtents: { x: number; y: number; z: number },
    direction: { x: number; y: number; z: number },
    speed: number,
    friction?: number,
  ): void {
    if (!this._world || !this.physicsReady) return;
    const R = this._rapier;

    const bodyDesc = R.RigidBodyDesc.kinematicVelocityBased()
      .setTranslation(position.x, position.y, position.z);
    if (rotation) {
      bodyDesc.setRotation({ x: rotation.x, y: rotation.y, z: rotation.z, w: rotation.w });
    }
    const body = this._world.createRigidBody(bodyDesc);

    const f = friction ?? this._friction;
    const colliderDesc = R.ColliderDesc
      .cuboid(halfExtents.x, halfExtents.y, halfExtents.z)
      .setFriction(f)
      .setFrictionCombineRule(R.CoefficientCombineRule.Max);
    const collider = this._world.createCollider(colliderDesc, body);

    // Set initial velocity (all 3 components — y matters for inclined conveyors)
    body.setLinvel({ x: direction.x * speed, y: direction.y * speed, z: direction.z * speed }, true);

    this._surfaceMap.set(surfaceId, { body, collider });
  }

  /**
   * Update the velocity of a conveyor surface.
   * @param surfaceId Surface identifier
   * @param direction Normalized transport direction
   * @param speed Speed in m/s
   */
  updateConveyorVelocity(
    surfaceId: string,
    direction: { x: number; y: number; z: number },
    speed: number,
  ): void {
    const info = this._surfaceMap.get(surfaceId);
    if (!info) return;
    info.body.setLinvel({ x: direction.x * speed, y: direction.y * speed, z: direction.z * speed }, true);
  }

  /**
   * Update the angular velocity of a radial conveyor surface.
   * @param surfaceId Surface identifier
   * @param axis Rotation axis (normalized)
   * @param angularSpeed Angular speed in rad/s
   */
  updateConveyorAngularVelocity(
    surfaceId: string,
    axis: { x: number; y: number; z: number },
    angularSpeed: number,
  ): void {
    const info = this._surfaceMap.get(surfaceId);
    if (!info) return;
    info.body.setAngvel(
      { x: axis.x * angularSpeed, y: axis.y * angularSpeed, z: axis.z * angularSpeed },
      true,
    );
  }

  /** Check if a surface body exists */
  hasSurface(surfaceId: string): boolean {
    return this._surfaceMap.has(surfaceId);
  }

  // ─── Sensor Management ──────────────────────────────────────────

  /**
   * Add a sensor collider (isSensor=true) on a fixed body.
   * Sensor events are dispatched via onSensorEvent callback.
   *
   * @param sensorId Unique sensor identifier
   * @param position World position in meters
   * @param rotation World rotation quaternion (default: identity)
   * @param halfExtents Half-size of sensor zone in meters (local space)
   */
  addSensor(
    sensorId: string,
    position: { x: number; y: number; z: number },
    rotation: { x: number; y: number; z: number; w: number } | null,
    halfExtents: { x: number; y: number; z: number },
  ): void {
    if (!this._world || !this.physicsReady) return;
    const R = this._rapier;

    const bodyDesc = R.RigidBodyDesc.fixed()
      .setTranslation(position.x, position.y, position.z);
    if (rotation) {
      bodyDesc.setRotation({ x: rotation.x, y: rotation.y, z: rotation.z, w: rotation.w });
    }
    const body = this._world.createRigidBody(bodyDesc);

    const colliderDesc = R.ColliderDesc
      .cuboid(halfExtents.x, halfExtents.y, halfExtents.z)
      .setSensor(true)
      .setActiveEvents(R.ActiveEvents.COLLISION_EVENTS);
    const collider = this._world.createCollider(colliderDesc, body);

    const info: SensorColliderInfo = { body, collider, occupants: new Set() };
    this._sensorMap.set(collider.handle, { sensorId, info });
    this._sensorById.set(sensorId, info);
  }

  /**
   * Get the number of MUs currently inside a sensor.
   */
  getSensorOccupantCount(sensorId: string): number {
    const info = this._sensorById.get(sensorId);
    return info ? info.occupants.size : 0;
  }

  /** Check if a sensor exists */
  hasSensor(sensorId: string): boolean {
    return this._sensorById.has(sensorId);
  }

  // ─── Simulation Step ────────────────────────────────────────────

  /**
   * Step the physics world. Does nothing if physicsReady is false.
   * @param dt Fixed timestep in seconds
   */
  step(dt: number): void {
    if (!this._world || !this._eventQueue || !this.physicsReady) return;

    this._world.timestep = dt;

    for (let i = 0; i < this._substeps; i++) {
      this._world.step(this._eventQueue);
    }
  }

  /**
   * Synchronize Rapier body positions → Three.js node transforms.
   * @param muNodeMap Maps MU ID → Three.js Object3D position/quaternion to update
   */
  sync(muNodeMap: Map<string, { position: Vector3; quaternion: Quaternion }>): void {
    if (!this._world || !this.physicsReady) return;

    for (const [muId, info] of this._bodyMap) {
      const node = muNodeMap.get(muId);
      if (!node) continue;

      const t = info.body.translation();
      node.position.set(t.x, t.y, t.z);

      const r = info.body.rotation();
      node.quaternion.set(r.x, r.y, r.z, r.w);
    }
  }

  /**
   * Process collision events from the EventQueue.
   * Dispatches sensor enter/leave callbacks.
   */
  processEvents(): void {
    if (!this._eventQueue || !this.physicsReady) return;

    this._eventQueue.drainCollisionEvents((handle1: number, handle2: number, started: boolean) => {
      // Find which handle is a sensor and which is an MU
      const sensor1 = this._sensorMap.get(handle1);
      const sensor2 = this._sensorMap.get(handle2);
      const mu1 = this._colliderToMU.get(handle1);
      const mu2 = this._colliderToMU.get(handle2);

      let sensorEntry: { sensorId: string; info: SensorColliderInfo } | undefined;
      let muId: string | undefined;

      if (sensor1 && mu2) {
        sensorEntry = sensor1;
        muId = mu2;
      } else if (sensor2 && mu1) {
        sensorEntry = sensor2;
        muId = mu1;
      }

      if (sensorEntry && muId) {
        if (started) {
          sensorEntry.info.occupants.add(muId);
        } else {
          sensorEntry.info.occupants.delete(muId);
        }
        this.onSensorEvent?.(sensorEntry.sensorId, muId, started);
      }
    });
  }

  // ─── Safety Guards ──────────────────────────────────────────────

  /**
   * Check for MUs that have fallen below the world bounds (Y < -10).
   * Marks them for removal.
   * @returns Array of MU IDs that were marked for removal
   */
  processOutOfBounds(yThreshold = -10): string[] {
    const removed: string[] = [];
    for (const [muId, info] of this._bodyMap) {
      const t = info.body.translation();
      if (t.y < yThreshold) {
        this._markedForRemoval.push(muId);
        removed.push(muId);
      }
    }
    this.flushRemovals();
    return removed;
  }

  // ─── Raycast ────────────────────────────────────────────────────

  /**
   * Cast a ray into the physics world.
   * @param origin Ray origin in world space
   * @param direction Normalized ray direction
   * @param maxDistance Maximum ray distance in meters
   * @returns MU ID of the first hit body, or null if no hit
   */
  castRay(
    origin: { x: number; y: number; z: number },
    direction: { x: number; y: number; z: number },
    maxDistance: number,
  ): { muId: string | null; distance: number } | null {
    if (!this._world || !this.physicsReady) return null;
    const R = this._rapier;

    const ray = new R.Ray(origin, direction);
    const hit = this._world.castRay(ray, maxDistance, true);

    if (hit) {
      const colliderHandle = hit.collider.handle;
      const muId = this._colliderToMU.get(colliderHandle) ?? null;
      return { muId, distance: hit.timeOfImpact };
    }

    return null;
  }

  // ─── World access (for advanced use) ────────────────────────────

  /** Get the underlying Rapier world (null if not initialized). */
  get world(): RAPIER.World | null {
    return this._world;
  }

  /** Get the Rapier module reference. */
  get rapier(): typeof RAPIER {
    return this._rapier;
  }

  // ─── Debug Info ────────────────────────────────────────────────

  /** Get all collider info for debug visualization. */
  getDebugBodies(): Array<{
    type: 'surface' | 'mu' | 'sensor';
    id: string;
    position: { x: number; y: number; z: number };
    rotation: { x: number; y: number; z: number; w: number };
    halfExtents: { x: number; y: number; z: number };
  }> {
    if (!this._world) return [];
    const result: Array<{
      type: 'surface' | 'mu' | 'sensor';
      id: string;
      position: { x: number; y: number; z: number };
      rotation: { x: number; y: number; z: number; w: number };
      halfExtents: { x: number; y: number; z: number };
    }> = [];

    for (const [id, info] of this._surfaceMap) {
      const t = info.body.translation();
      const r = info.body.rotation();
      const shape = info.collider.shape;
      const he = (shape as unknown as { halfExtents: { x: number; y: number; z: number } }).halfExtents;
      result.push({
        type: 'surface',
        id,
        position: { x: t.x, y: t.y, z: t.z },
        rotation: { x: r.x, y: r.y, z: r.z, w: r.w },
        halfExtents: he ? { x: he.x, y: he.y, z: he.z } : { x: 0.1, y: 0.1, z: 0.1 },
      });
    }

    for (const [id, info] of this._bodyMap) {
      const t = info.body.translation();
      const r = info.body.rotation();
      const shape = info.collider.shape;
      const he = (shape as unknown as { halfExtents: { x: number; y: number; z: number } }).halfExtents;
      result.push({
        type: 'mu',
        id,
        position: { x: t.x, y: t.y, z: t.z },
        rotation: { x: r.x, y: r.y, z: r.z, w: r.w },
        halfExtents: he ? { x: he.x, y: he.y, z: he.z } : { x: 0.1, y: 0.1, z: 0.1 },
      });
    }

    for (const [, entry] of this._sensorMap) {
      const t = entry.info.body.translation();
      const r = entry.info.body.rotation();
      const shape = entry.info.collider.shape;
      const he = (shape as unknown as { halfExtents: { x: number; y: number; z: number } }).halfExtents;
      result.push({
        type: 'sensor',
        id: entry.sensorId,
        position: { x: t.x, y: t.y, z: t.z },
        rotation: { x: r.x, y: r.y, z: r.z, w: r.w },
        halfExtents: he ? { x: he.x, y: he.y, z: he.z } : { x: 0.1, y: 0.1, z: 0.1 },
      });
    }

    return result;
  }
}
