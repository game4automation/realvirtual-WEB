// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * RapierPhysicsPlugin — Replaces kinematic transport with Rapier.js physics.
 *
 * When active (handlesTransport=true), transportManager.update() is skipped
 * and this plugin handles all MU movement, sensor detection, and sink removal
 * via the Rapier physics world.
 *
 * Lifecycle:
 *   preload() → WASM init (call BEFORE viewer.use())
 *   onModelLoaded → build Rapier world from scene
 *   onFixedUpdatePost → step, sync, process events, sources, sinks
 *   onModelCleared → dispose physics world
 *   dispose → cleanup WASM resources
 */

import type { RVViewerPlugin } from '../rv-plugin';
import type { RVViewer } from '../rv-viewer';
import type { LoadResult } from './rv-scene-loader';
import { RVPhysicsWorld } from './rv-physics-world';
import type { AABB } from './rv-aabb';
import type { RVTransportSurface } from './rv-transport-surface';
import type { RVSensor } from './rv-sensor';
import type { RVSink } from './rv-sink';
import type { RVMovingUnit, InstancedMovingUnit, MUInstancePool } from './rv-mu';
import type { RVTransportManager } from './rv-transport-manager';
import {
  Vector3, Quaternion, MathUtils, Box3,
  BoxGeometry, EdgesGeometry, LineSegments, LineBasicMaterial,
  Object3D, Group,
} from 'three';
import type { PhysicsSettings } from '../hmi/physics-settings-store';
import { debug, debugWarn } from './rv-debug';

/** Provider function that returns the current physics settings. */
export type PhysicsSettingsProvider = () => PhysicsSettings;

// Pre-allocated temp vectors for zero-GC hot path
const _muWorldPos = new Vector3();
const _worldQuat = new Quaternion();
const _localCenter = new Vector3();
const _worldScale = new Vector3();
const _tmpVec3 = new Vector3();
const _rayOrigin = new Vector3();
const _rayDir = new Vector3();

export class RapierPhysicsPlugin implements RVViewerPlugin {
  readonly id = 'rapier-physics';
  readonly core = true;
  readonly order = 50; // Before sensor-monitor (100) and transport-stats (100)
  handlesTransport = true;

  private _getPhysicsSettings: PhysicsSettingsProvider;

  constructor(getPhysicsSettings?: PhysicsSettingsProvider) {
    this._getPhysicsSettings = getPhysicsSettings ?? (() => ({
      enabled: false, gravity: 9.81, friction: 1.5, substeps: 1, debugWireframes: false,
    }));
  }

  private _rapier: typeof import('@dimforge/rapier3d-compat') | null = null;
  private _physicsWorld: RVPhysicsWorld | null = null;
  private _viewer: RVViewer | null = null;

  /** Maps surface node name/path → surface ID used in physics world */
  private _surfaceIds = new Map<RVTransportSurface, string>();
  /** Maps sensor node name/path → sensor ID used in physics world */
  private _sensorIds = new Map<RVSensor, string>();
  /** Maps MU ID → MU instance (for sync and removal) */
  private _muMap = new Map<string, RVMovingUnit | InstancedMovingUnit>();
  /** Maps sensor ID → RVSensor (for event dispatch) */
  private _sensorLookup = new Map<string, RVSensor>();
  /** Maps sink sensor ID → RVSink */
  private _sinkSensors = new Map<string, RVSink>();
  /** MU ID counter for unique identification */
  private _muIdCounter = 0;
  /** Maps MU → MU ID in physics world */
  private _muToId = new Map<RVMovingUnit | InstancedMovingUnit, string>();

  /** Node sync map: MU ID → { position, quaternion } for Rapier → Three.js sync */
  private _nodeSyncMap = new Map<string, { position: Vector3; quaternion: Quaternion }>();

  /**
   * Instanced MU sync entries: muId → { mu, syncPos, syncQuat }.
   * After Rapier sync(), these values must be pushed back to the pool's Float32Arrays.
   * Clone-based MUs don't need this — sync writes directly to node.position/quaternion.
   */
  private _instancedSyncEntries = new Map<string, {
    mu: InstancedMovingUnit;
    syncPos: Vector3;
    syncQuat: Quaternion;
  }>();

  /** Cache last conveyor speed per surface to avoid redundant Rapier calls */
  private _lastSpeed = new Map<RVTransportSurface, number>();
  /** Cache normalized transport direction per surface (computed once at model load) */
  private _cachedDirs = new Map<RVTransportSurface, { x: number; y: number; z: number }>();
  /** Cache parent inverse matrices for MU sync (for static parents) */
  private _parentInverseCache = new WeakMap<Object3D, { matrix: import('three').Matrix4; dirty: boolean }>();

  /** Debug wireframe group (added to scene when debugWireframes is enabled) */
  private _debugGroup: Group | null = null;
  /** Debug wireframe materials by type */
  private static _debugMaterials: Record<string, LineBasicMaterial> | null = null;

  // ─── WASM Preloading ──────────────────────────────────────────

  /**
   * Load and initialize Rapier WASM. Call this BEFORE viewer.use().
   * If this fails, handlesTransport is set to false and the viewer
   * falls back to kinematic transport.
   */
  async preload(): Promise<void> {
    try {
      const RAPIER = await import('@dimforge/rapier3d-compat');
      await RAPIER.init();
      this._rapier = RAPIER;
      debug('physics', 'WASM loaded successfully');
    } catch (e) {
      console.warn('[RapierPhysicsPlugin] WASM init failed, falling back to kinematic transport:', e);
      this.handlesTransport = false;
      this._rapier = null;
    }
  }

  /** Whether Rapier WASM is ready */
  get isReady(): boolean {
    return this._rapier !== null && this._physicsWorld?.physicsReady === true;
  }

  /** Expose physics world for testing/debugging */
  get physicsWorld(): RVPhysicsWorld | null {
    return this._physicsWorld;
  }

  // ─── Plugin Lifecycle ─────────────────────────────────────────

  onModelLoaded(result: LoadResult, viewer: RVViewer): void {
    if (!this._rapier) return;
    this._viewer = viewer;

    const settings = this._getPhysicsSettings();

    // If physics is disabled in settings, revert to kinematic
    if (!settings.enabled) {
      this.handlesTransport = false;
      return;
    }
    this.handlesTransport = true;

    // Create physics world
    this._physicsWorld = new RVPhysicsWorld(this._rapier);
    this._physicsWorld.init({
      gravity: { x: 0, y: -settings.gravity, z: 0 },
      friction: settings.friction,
      substeps: settings.substeps,
    });

    // Add ground plane collider so MUs don't fall through the void
    this._physicsWorld.addGroundPlane(settings.friction);

    const tm = viewer.transportManager;
    if (!tm) return;

    type Vec3 = { x: number; y: number; z: number };
    type Quat = { x: number; y: number; z: number; w: number };

    /**
     * Compute collider shape (center, rotation, halfExtents) from BoxCollider
     * AABB data + the node's own world quaternion.
     *
     * This mirrors how sensor visualizations work (rv-sensor.ts createVisualization):
     * BoxCollider center/size are in the node's local space. The node's world
     * quaternion gives the correct orientation. Scale is applied from worldScale.
     *
     * Previous attempts using mesh geometry failed because node.traverse() could
     * pick the wrong mesh child (e.g. a roller rotated 90° relative to the belt).
     */
    const computeColliderFromAABB = (
      node: Object3D,
      aabb: AABB,
    ): { center: Vec3; quat: Quat; halfExtents: Vec3 } => {
      node.updateWorldMatrix(true, false);

      // Transform BoxCollider center from node-local to world space
      _localCenter.copy(aabb.localCenter);
      node.localToWorld(_localCenter);

      // Node's world rotation = collider orientation
      node.getWorldQuaternion(_worldQuat);

      // Scale halfExtents by world scale (BoxCollider size is in unscaled local space)
      node.getWorldScale(_worldScale);

      return {
        center: { x: _localCenter.x, y: _localCenter.y, z: _localCenter.z },
        quat: { x: _worldQuat.x, y: _worldQuat.y, z: _worldQuat.z, w: _worldQuat.w },
        halfExtents: {
          x: aabb.halfSize.x * Math.abs(_worldScale.x),
          y: aabb.halfSize.y * Math.abs(_worldScale.y),
          z: aabb.halfSize.z * Math.abs(_worldScale.z),
        },
      };
    };

    // Build conveyor surfaces as kinematic bodies
    for (const surface of tm.surfaces) {
      const surfaceId = `surface_${surface.node.name}_${surface.node.id}`;
      this._surfaceIds.set(surface, surfaceId);

      // Refresh AABB to ensure it's computed with current world matrix
      surface.node.updateWorldMatrix(true, false);
      surface.updateAABB();

      // Compute collider from BoxCollider AABB + node quaternion
      const collider = computeColliderFromAABB(surface.node, surface.aabb);

      // Speed in m/s (currentSpeed is in mm/s)
      const speedMs = surface.speed / 1000;
      // Pre-normalize and cache transport direction (avoid clone().normalize() GC in hot path)
      _tmpVec3.copy(surface.TransportDirection).normalize();
      const dir = { x: _tmpVec3.x, y: _tmpVec3.y, z: _tmpVec3.z };
      this._cachedDirs.set(surface, dir);

      this._physicsWorld.addConveyorSurface(
        surfaceId,
        collider.center,
        collider.quat,
        collider.halfExtents,
        { x: dir.x, y: dir.y, z: dir.z },
        speedMs,
        settings.friction,
      );

      debug('transport',
        `[Rapier] Surface "${surface.node.name}" → kinematic body` +
        ` pos=(${collider.center.x.toFixed(3)}, ${collider.center.y.toFixed(3)}, ${collider.center.z.toFixed(3)})` +
        ` he=(${collider.halfExtents.x.toFixed(3)}, ${collider.halfExtents.y.toFixed(3)}, ${collider.halfExtents.z.toFixed(3)})` +
        ` speed=${speedMs.toFixed(3)} m/s`,
      );
    }

    // Build sensors as fixed bodies with sensor colliders
    for (const sensor of tm.sensors) {
      if (sensor.mode === 'Collision') {
        const sensorId = `sensor_${sensor.node.name}_${sensor.node.id}`;
        this._sensorIds.set(sensor, sensorId);
        this._sensorLookup.set(sensorId, sensor);

        sensor.node.updateWorldMatrix(true, false);
        sensor.updateAABB();
        const collider = computeColliderFromAABB(sensor.node, sensor.aabb);

        this._physicsWorld.addSensor(
          sensorId,
          collider.center,
          collider.quat,
          collider.halfExtents,
        );

        debug('sensor', `[Rapier] Sensor "${sensor.node.name}" → sensor collider`);
      }
      // Raycast sensors use world.castRay() — no collider needed
    }

    // Build sinks as sensor colliders (detect MU entry to trigger removal)
    for (const sink of tm.sinks) {
      const sinkId = `sink_${sink.node.name}_${sink.node.id}`;
      this._sinkSensors.set(sinkId, sink);

      sink.node.updateWorldMatrix(true, false);
      sink.updateAABB();
      const collider = computeColliderFromAABB(sink.node, sink.aabb);

      this._physicsWorld.addSensor(
        sinkId,
        collider.center,
        collider.quat,
        collider.halfExtents,
      );

      debug('transport', `[Rapier] Sink "${sink.node.name}" → sensor collider`);
    }

    // Wire up sensor event callback
    this._physicsWorld.onSensorEvent = (sensorId: string, muId: string, entered: boolean) => {
      // Check if it is a regular sensor
      const sensor = this._sensorLookup.get(sensorId);
      if (sensor) {
        this._handleSensorEvent(sensor, sensorId, muId, entered);
      }

      // Check if it is a sink sensor
      const sink = this._sinkSensors.get(sensorId);
      if (sink && entered) {
        this._handleSinkEvent(sink, muId);
      }
    };

    // Diagnostic: validate collider positions against mesh bounding boxes
    if (settings.debugWireframes) {
      this._validateColliderPositions(tm);
      this._buildDebugWireframes(viewer);
    }

    debug('physics',
      `World built: ${tm.surfaces.length} surfaces, ` +
      `${tm.sensors.length} sensors, ${tm.sinks.length} sinks` +
      (settings.debugWireframes ? ' (debug wireframes ON)' : ''),
    );
  }

  onFixedUpdatePost(dt: number): void {
    if (!this._physicsWorld?.physicsReady || !this._viewer) return;
    const tm = this._viewer.transportManager;
    if (!tm) return;

    // 1. Sources: spawn new MUs (with Rapier bodies)
    for (const source of tm.sources) {
      const mu = source.update(dt);
      if (mu) {
        tm.mus.push(mu);
        tm.totalSpawned++;
        this._addMUToPhysics(mu);
        debug('transport', `[Rapier] Source "${source.node.name}" spawned MU "${mu.getName()}"`);
      }
    }

    // 2. Update conveyor velocities from drive speeds (skip unchanged)
    for (const surface of tm.surfaces) {
      const surfaceId = this._surfaceIds.get(surface);
      if (!surfaceId) continue;

      // Skip Rapier call when speed hasn't changed
      const lastSpeed = this._lastSpeed.get(surface);
      if (lastSpeed === surface.speed) continue;
      this._lastSpeed.set(surface, surface.speed);

      const speedMs = surface.speed / 1000;
      if (surface.Radial) {
        // Radial: angular velocity
        const angularSpeed = MathUtils.degToRad(surface.speed); // speed is in deg/s for radial
        const dir = surface.TransportDirection;
        this._physicsWorld.updateConveyorAngularVelocity(
          surfaceId,
          { x: dir.x, y: dir.y, z: dir.z },
          angularSpeed,
        );
      } else {
        // Linear: use pre-cached normalized direction (avoids clone().normalize() GC)
        const dir = this._cachedDirs.get(surface) ?? { x: 1, y: 0, z: 0 };
        this._physicsWorld.updateConveyorVelocity(
          surfaceId,
          dir,
          speedMs,
        );
      }
    }

    // 3. Step physics
    this._physicsWorld.step(dt);

    // 4. Sync physics → Three.js (sync writes world positions to local position refs)
    this._physicsWorld.sync(this._nodeSyncMap);

    // 4a. Push synced values from dedicated sync vectors back to instanced MU pools.
    // For clone MUs, sync() writes directly to node.position/quaternion (by reference).
    // For instanced MUs, sync() writes to dedicated Vector3/Quaternion objects;
    // we must push those values to the pool's Float32Arrays.
    for (const entry of this._instancedSyncEntries.values()) {
      if (!entry.mu.markedForRemoval) {
        entry.mu.setPosition(entry.syncPos);
        entry.mu.setQuaternion(entry.syncQuat);
      }
    }

    // 4b. Convert synced world positions to parent-local space (clone MUs only).
    // Clone MUs live in the scene graph with potentially non-identity parent transforms.
    // Instanced MUs store world-space positions directly (pool's Float32Arrays).
    for (const mu of tm.mus) {
      if (!mu.markedForRemoval && !mu.isInstanced && mu.node.parent) {
        mu.node.parent.updateWorldMatrix(true, false);
        const pos = mu.getPosition();
        mu.node.parent.worldToLocal(pos);
        mu.setPosition(pos);
      }
    }

    // 5. Update MU AABBs (for any non-physics checks)
    for (const mu of tm.mus) {
      if (!mu.markedForRemoval) {
        mu.updateAABB();
      }
    }

    // 6. Process sensor/sink events
    this._physicsWorld.processEvents();

    // 7. Raycast sensors (use Rapier ray queries)
    for (const sensor of tm.sensors) {
      if (sensor.mode === 'Raycast') {
        this._updateRaycastSensor(sensor, tm.mus);
      }
    }

    // 8. Process out-of-bounds MUs
    const oob = this._physicsWorld.processOutOfBounds();
    for (const muId of oob) {
      const mu = this._muMap.get(muId);
      if (mu && !mu.markedForRemoval) {
        mu.markedForRemoval = true;
        debug('transport', `[Rapier] MU "${mu.getName()}" fell out of bounds, removing`);
      }
    }

    // 9. Remove marked MUs (swap-and-pop as in kinematic mode)
    for (let i = tm.mus.length - 1; i >= 0; i--) {
      if (tm.mus[i].markedForRemoval) {
        const mu = tm.mus[i];
        this._removeMUFromPhysics(mu);
        mu.dispose();
        tm.totalConsumed++;
        // Swap with last element and pop
        tm.mus[i] = tm.mus[tm.mus.length - 1];
        tm.mus.pop();
      }
    }

    // 10. Batch-update instance pool matrices after all physics position changes
    tm.updatePoolMatrices();
  }

  onModelCleared(): void {
    this._cleanup();
  }

  dispose(): void {
    this._cleanup();
  }

  // ─── Private Helpers ──────────────────────────────────────────

  private _addMUToPhysics(mu: RVMovingUnit | InstancedMovingUnit): void {
    if (!this._physicsWorld) return;

    const muId = `mu_${this._muIdCounter++}`;
    this._muMap.set(muId, mu);
    this._muToId.set(mu, muId);

    mu.getWorldPosition(_muWorldPos);

    this._physicsWorld.addMU(
      muId,
      { x: _muWorldPos.x, y: _muWorldPos.y, z: _muWorldPos.z },
      { x: mu.aabb.halfSize.x, y: mu.aabb.halfSize.y, z: mu.aabb.halfSize.z },
    );

    if (mu.isInstanced) {
      // Instanced MU: create dedicated Vector3/Quaternion for Rapier to write into.
      // After sync(), we push these values back to the pool's Float32Arrays.
      const syncPos = mu.getWorldPosition(new Vector3());
      const syncQuat = mu.getQuaternion().clone();
      this._nodeSyncMap.set(muId, { position: syncPos, quaternion: syncQuat });
      this._instancedSyncEntries.set(muId, { mu: mu as InstancedMovingUnit, syncPos, syncQuat });
    } else {
      // Clone MU: sync writes directly to node.position/quaternion (by reference)
      this._nodeSyncMap.set(muId, {
        position: mu.getPosition(),
        quaternion: mu.getQuaternion(),
      });
    }
  }

  private _removeMUFromPhysics(mu: RVMovingUnit | InstancedMovingUnit): void {
    if (!this._physicsWorld) return;

    const muId = this._muToId.get(mu);
    if (!muId) return;

    this._physicsWorld.removeMU(muId);
    this._muMap.delete(muId);
    this._muToId.delete(mu);
    this._nodeSyncMap.delete(muId);
    this._instancedSyncEntries.delete(muId);
  }

  private _handleSensorEvent(sensor: RVSensor, sensorId: string, muId: string, entered: boolean): void {
    if (!this._physicsWorld) return;

    const occupantCount = this._physicsWorld.getSensorOccupantCount(sensorId);
    const wasOccupied = sensor.occupied;
    const rawOccupied = occupantCount > 0;
    const newOccupied = sensor.invertSignal ? !rawOccupied : rawOccupied;

    // Update occupiedMU reference
    if (rawOccupied) {
      const mu = this._muMap.get(muId);
      sensor.occupiedMU = mu ?? null;
    } else {
      sensor.occupiedMU = null;
    }

    if (newOccupied !== wasOccupied) {
      sensor.occupied = newOccupied;
      debug('sensor', `[Rapier] Sensor "${sensor.node.name}" → ${newOccupied ? 'OCCUPIED' : 'CLEARED'}`);
      // Fire onChanged callback (SensorMonitorPlugin wraps this)
      sensor.onChanged?.(newOccupied, sensor);
    }
  }

  private _handleSinkEvent(sink: RVSink, muId: string): void {
    const mu = this._muMap.get(muId);
    if (!mu || mu.markedForRemoval) return;

    mu.markedForRemoval = true;
    sink.onConsumed?.(mu, sink);
    debug('transport', `[Rapier] Sink "${sink.node.name}" consumed MU "${mu.getName()}"`);
  }

  private _updateRaycastSensor(sensor: RVSensor, mus: (RVMovingUnit | InstancedMovingUnit)[]): void {
    if (!this._physicsWorld) {
      // Fallback to AABB raycast
      sensor.checkOverlap(mus);
      return;
    }

    // Compute world-space ray
    const d = sensor.RayCastDirection;
    const maxDist = sensor.RayCastLength / 1000; // mm → meters

    sensor.node.updateWorldMatrix(true, false);
    // Use pre-allocated vectors to avoid GC in hot path
    const origin = _rayOrigin.setFromMatrixPosition(sensor.node.matrixWorld);
    const dir = _rayDir.set(d.x, d.y, d.z).transformDirection(sensor.node.matrixWorld).normalize();

    const hit = this._physicsWorld.castRay(
      { x: origin.x, y: origin.y, z: origin.z },
      { x: dir.x, y: dir.y, z: dir.z },
      maxDist,
    );

    const foundMU = hit?.muId ? (this._muMap.get(hit.muId) ?? null) : null;
    const rawOccupied = foundMU !== null;
    const newOccupied = sensor.invertSignal ? !rawOccupied : rawOccupied;

    if (newOccupied !== sensor.occupied) {
      sensor.occupied = newOccupied;
      sensor.occupiedMU = foundMU;
      debug('sensor', `[Rapier] Raycast Sensor "${sensor.node.name}" → ${newOccupied ? 'OCCUPIED' : 'CLEARED'}`);
      sensor.onChanged?.(newOccupied, sensor);
    }
  }

  // ─── Debug Wireframes ─────────────────────────────────────────

  /**
   * Build Three.js wireframe boxes from the Rapier collider info and add to scene.
   * Colors: green = conveyor surface, cyan = sensor/sink, yellow = MU.
   */
  private _buildDebugWireframes(viewer: RVViewer): void {
    if (!this._physicsWorld) return;

    this._disposeDebugWireframes(viewer);

    // Lazy-init shared materials
    if (!RapierPhysicsPlugin._debugMaterials) {
      RapierPhysicsPlugin._debugMaterials = {
        surface: new LineBasicMaterial({ color: 0x00ff00, depthTest: false }),
        sensor: new LineBasicMaterial({ color: 0x00ffff, depthTest: false }),
        mu: new LineBasicMaterial({ color: 0xffff00, depthTest: false }),
      };
    }

    this._debugGroup = new Group();
    this._debugGroup.name = '__rapier_debug__';
    this._debugGroup.renderOrder = 9999;

    const bodies = this._physicsWorld.getDebugBodies();
    for (const b of bodies) {
      const geo = new BoxGeometry(b.halfExtents.x * 2, b.halfExtents.y * 2, b.halfExtents.z * 2);
      const edges = new EdgesGeometry(geo);
      const mat = RapierPhysicsPlugin._debugMaterials[b.type] ?? RapierPhysicsPlugin._debugMaterials.sensor;
      const line = new LineSegments(edges, mat);
      line.position.set(b.position.x, b.position.y, b.position.z);
      line.quaternion.set(b.rotation.x, b.rotation.y, b.rotation.z, b.rotation.w);
      line.frustumCulled = false;
      this._debugGroup.add(line);
      geo.dispose();
    }

    viewer.scene?.add(this._debugGroup);
    debug('physics', `Debug wireframes: ${bodies.length} colliders visualized`);
  }

  /**
   * Remove and dispose debug wireframe group from scene.
   */
  private _disposeDebugWireframes(viewer?: RVViewer): void {
    if (!this._debugGroup) return;

    // Remove all children geometries
    for (const child of this._debugGroup.children) {
      if (child instanceof LineSegments) {
        child.geometry.dispose();
      }
    }
    this._debugGroup.removeFromParent();
    this._debugGroup = null;
  }

  /**
   * Diagnostic: compare each Rapier collider against the mesh bounding box.
   * Logs position, rotation, and size comparisons to help debug alignment issues.
   */
  private _validateColliderPositions(tm: RVTransportManager): void {
    if (!this._physicsWorld) return;

    const bodies = this._physicsWorld.getDebugBodies();
    const _box = new Box3();
    const _meshCenter = new Vector3();
    const _nodeQuat = new Quaternion();
    const _mQuat = new Quaternion();
    const _boxSize = new Vector3();
    let maxPosDelta = 0;

    const allNodes = new Map<string, Object3D>();
    for (const s of tm.surfaces) allNodes.set(`surface_${s.node.name}_${s.node.id}`, s.node);
    for (const s of tm.sensors) allNodes.set(`sensor_${s.node.name}_${s.node.id}`, s.node);
    for (const s of tm.sinks) allNodes.set(`sink_${s.node.name}_${s.node.id}`, s.node);

    for (const b of bodies) {
      if (b.type === 'mu') continue;
      const node = allNodes.get(b.id);
      if (!node) continue;

      node.updateWorldMatrix(true, false);

      // Position check: collider center vs mesh world AABB center
      _box.setFromObject(node);
      _box.getCenter(_meshCenter);
      _box.getSize(_boxSize);

      const dx = b.position.x - _meshCenter.x;
      const dy = b.position.y - _meshCenter.y;
      const dz = b.position.z - _meshCenter.z;
      const posDelta = Math.sqrt(dx * dx + dy * dy + dz * dz);
      maxPosDelta = Math.max(maxPosDelta, posDelta);

      // Rotation check: Rapier body vs node quaternion
      node.getWorldQuaternion(_nodeQuat);
      const bodyQuat = new Quaternion(b.rotation.x, b.rotation.y, b.rotation.z, b.rotation.w);
      const bodyVsNode = _nodeQuat.angleTo(bodyQuat) * (180 / Math.PI);

      // Mesh info: find first mesh, check its rotation vs node
      let meshInfo = '(no mesh)';
      node.traverse((child) => {
        if (meshInfo !== '(no mesh)') return;
        if ((child as { isMesh?: boolean }).isMesh) {
          (child as Object3D).getWorldQuaternion(_mQuat);
          const meshVsNode = _nodeQuat.angleTo(_mQuat) * (180 / Math.PI);
          const meshVsBody = bodyQuat.angleTo(_mQuat) * (180 / Math.PI);
          const isSelf = child === node;
          meshInfo = `mesh${isSelf ? '(=node)' : `="${child.name}"`} nodeΔ=${meshVsNode.toFixed(1)}° bodyΔ=${meshVsBody.toFixed(1)}°`;
        }
      });

      // Size ratio: Rapier halfExtents vs mesh AABB
      const heRatioX = _boxSize.x > 0.001 ? (b.halfExtents.x * 2) / _boxSize.x : 1;
      const heRatioY = _boxSize.y > 0.001 ? (b.halfExtents.y * 2) / _boxSize.y : 1;
      const heRatioZ = _boxSize.z > 0.001 ? (b.halfExtents.z * 2) / _boxSize.z : 1;

      const hasIssue = posDelta > 0.05 || bodyVsNode > 1;
      const msg =
        `${hasIssue ? '⚠' : '✓'} "${b.id}" (${b.type}):` +
        `\n  pos: delta=${(posDelta * 1000).toFixed(1)}mm` +
        `\n  rot: body→node=${bodyVsNode.toFixed(1)}° ${meshInfo}` +
        `\n  he: (${b.halfExtents.x.toFixed(3)}, ${b.halfExtents.y.toFixed(3)}, ${b.halfExtents.z.toFixed(3)})` +
        ` meshAABB/2=(${(_boxSize.x / 2).toFixed(3)}, ${(_boxSize.y / 2).toFixed(3)}, ${(_boxSize.z / 2).toFixed(3)})` +
        ` ratio=(${heRatioX.toFixed(2)}, ${heRatioY.toFixed(2)}, ${heRatioZ.toFixed(2)})`;
      if (hasIssue) {
        debugWarn('physics', msg);
      } else {
        debug('physics', msg);
      }
    }

    debug('physics',
      `Validation summary: ${bodies.length - Array.from(this._physicsWorld.getDebugBodies()).filter(b => b.type === 'mu').length} colliders, max pos delta=${(maxPosDelta * 1000).toFixed(1)}mm`,
    );
  }

  private _cleanup(): void {
    this._disposeDebugWireframes(this._viewer ?? undefined);
    this._physicsWorld?.dispose();
    this._physicsWorld = null;
    this._viewer = null;
    this._surfaceIds.clear();
    this._sensorIds.clear();
    this._sensorLookup.clear();
    this._sinkSensors.clear();
    this._muMap.clear();
    this._muToId.clear();
    this._nodeSyncMap.clear();
    this._instancedSyncEntries.clear();
    this._muIdCounter = 0;
  }
}
