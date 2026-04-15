// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import {
  Object3D,
  Mesh,
  BoxGeometry,
  CylinderGeometry,
  MeshBasicMaterial,
  DoubleSide,
  EdgesGeometry,
  LineSegments,
  LineBasicMaterial,
  Vector3,
  Quaternion,
} from 'three';
import { AABB } from './rv-aabb';
import type { RVMovingUnit, InstancedMovingUnit, IMUAccessor } from './rv-mu';
import type { ComponentSchema, ComponentContext, RVComponent } from './rv-component-registry';
import { registerComponent } from './rv-component-registry';
import { NodeRegistry } from './rv-node-registry';
import { unityPositionToGltf } from './rv-coordinate-utils';
import { debug } from './rv-debug';

// Shared materials (reused across all sensors to save GPU resources)
const YELLOW = 0xffcc00;
const RED = 0xff2222;

const matYellow = new MeshBasicMaterial({
  color: YELLOW,
  transparent: true,
  opacity: 0.18,
  side: DoubleSide,
  depthWrite: false,
});

const matRed = new MeshBasicMaterial({
  color: RED,
  transparent: true,
  opacity: 0.35,
  side: DoubleSide,
  depthWrite: false,
});

const wireYellow = new LineBasicMaterial({ color: YELLOW, transparent: true, opacity: 0.6 });
const wireRed = new LineBasicMaterial({ color: RED, transparent: true, opacity: 0.8 });

// ─── Ray-AABB intersection (slab method) ─────────────────────────────

/** Reusable temporaries to avoid per-frame allocation */
const _origin = new Vector3();
const _dir = new Vector3();
const _forward = new Vector3(0, 0, 1);
const _quat = new Quaternion();

/**
 * Fast ray vs AABB intersection test (slab method).
 * Returns distance to closest hit, or -1 if no intersection.
 * O(1) per test — no mesh traversal.
 */
function rayIntersectsAABB(
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  maxDist: number,
  aabbMin: Vector3, aabbMax: Vector3,
): number {
  let tmin = 0;
  let tmax = maxDist;

  // X slab
  if (Math.abs(dx) < 1e-8) {
    if (ox < aabbMin.x || ox > aabbMax.x) return -1;
  } else {
    let t1 = (aabbMin.x - ox) / dx;
    let t2 = (aabbMax.x - ox) / dx;
    if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return -1;
  }

  // Y slab
  if (Math.abs(dy) < 1e-8) {
    if (oy < aabbMin.y || oy > aabbMax.y) return -1;
  } else {
    let t1 = (aabbMin.y - oy) / dy;
    let t2 = (aabbMax.y - oy) / dy;
    if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return -1;
  }

  // Z slab
  if (Math.abs(dz) < 1e-8) {
    if (oz < aabbMin.z || oz > aabbMax.z) return -1;
  } else {
    let t1 = (aabbMin.z - oz) / dz;
    let t2 = (aabbMax.z - oz) / dz;
    if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return -1;
  }

  return tmin;
}

/**
 * RVSensor - Detects MU presence via AABB overlap or raycast.
 *
 * Collision mode: uses AABB overlap (BoxCollider-based).
 * Raycast mode: casts a ray from the sensor origin in a configured direction
 * and checks intersection with MU bounding boxes (fast slab method).
 *
 * Visualization:
 * - Collision: semi-transparent box (yellow = idle, red = occupied)
 * - Raycast: line from origin to ray end/hit (yellow = idle, red = occupied)
 */
export class RVSensor implements RVComponent {
  static readonly schema: ComponentSchema = {
    UseRaycast: { type: 'boolean', default: false },
    RayCastDirection: { type: 'vector3', unityCoords: true },
    RayCastLength: { type: 'number', default: 1000 },
    SensorOccupied: { type: 'componentRef' },
    SensorNotOccupied: { type: 'componentRef' },
  };

  readonly node: Object3D;
  readonly aabb: AABB;
  isOwner = true;

  // Properties — exact C# Inspector field names
  UseRaycast = false;
  RayCastDirection: Vector3 | { x: number; y: number; z: number } = { x: -1, y: 0, z: 0 };
  RayCastLength = 1000;

  // Derived mode for backward compat with callers checking mode
  get mode(): 'Raycast' | 'Collision' { return this.UseRaycast ? 'Raycast' : 'Collision'; }

  /** Resolved signal address for SensorOccupied PLCInputBool (null if not connected) */
  SensorOccupied: string | null = null;
  /** Resolved signal address for SensorNotOccupied PLCInputBool (null if not connected) */
  SensorNotOccupied: string | null = null;

  /** InvertSignal — not in C# Sensor.cs, but needed for internal logic */
  invertSignal = false;

  /** Current occupied state */
  occupied = false;
  /** The MU currently occupying this sensor (first one found) */
  occupiedMU: (RVMovingUnit | InstancedMovingUnit) | null = null;

  /** Callback for state change (for UI/visualization updates) */
  onChanged?: (occupied: boolean, sensor: RVSensor) => void;

  /** Visual mesh for sensor zone — Collision mode (child of sensor node) */
  private visMesh: Mesh | null = null;
  /** Wireframe edges for sensor zone — Collision mode */
  private visEdges: LineSegments | null = null;

  /** Ray tube visualization — Raycast mode (added to scene, world-space) */
  private rayTube: Mesh | null = null;

  /** BoxCollider data from GLB extras, stored during construction for use in init() */
  boxColliderData: { center: { x: number; y: number; z: number }; size: { x: number; y: number; z: number } } | null = null;

  constructor(node: Object3D, aabb: AABB) {
    this.node = node;
    this.aabb = aabb;
  }

  /**
   * Wire sensor into SignalStore and create visualization.
   * Called after applySchema + resolveComponentRefs.
   */
  init(context: ComponentContext): void {
    // Read raw extras from node for legacy Mode conversion and BoxCollider data
    const rv = this.node.userData?.realvirtual as Record<string, unknown> | undefined;
    if (rv) {
      const sensorData = rv['Sensor'] as Record<string, unknown> | undefined;
      if (sensorData) {
        const modeStr = sensorData['Mode'] as string | undefined;
        if (modeStr && sensorData['UseRaycast'] === undefined) {
          this.UseRaycast = modeStr === 'Raycast';
        }
      }
      const bc = rv['BoxCollider'] as { center?: { x: number; y: number; z: number }; size?: { x: number; y: number; z: number } } | undefined;
      if (bc?.center && bc?.size) {
        this.boxColliderData = { center: bc.center, size: bc.size };
      }
    }

    const sensorPath = NodeRegistry.computeNodePath(this.node);
    const sensorName = this.node.name;

    // Register sensor signal in SignalStore
    context.signalStore.register(sensorName, sensorPath, false);

    // Resolve SensorOccupied/SensorNotOccupied signal addresses
    const sensorOccupiedAddr = typeof this.SensorOccupied === 'string' ? this.SensorOccupied : null;
    const sensorNotOccupiedAddr = typeof this.SensorNotOccupied === 'string' ? this.SensorNotOccupied : null;

    this.onChanged = (occupied) => {
      context.signalStore.set(sensorName, occupied);
      // Mirror C# Sensor.cs: write to connected PLC signals
      if (sensorOccupiedAddr) {
        context.signalStore.setByPath(sensorOccupiedAddr, occupied);
      }
      if (sensorNotOccupiedAddr) {
        context.signalStore.setByPath(sensorNotOccupiedAddr, !occupied);
      }
    };

    // Create sensor visualization
    if (this.UseRaycast) {
      this.createRayVisualization();
    } else if (this.boxColliderData) {
      const bc = this.boxColliderData;
      const gltfCenter = unityPositionToGltf(bc.center.x, bc.center.y, bc.center.z);
      const halfSize = {
        x: Math.abs(bc.size.x) / 2,
        y: Math.abs(bc.size.y) / 2,
        z: Math.abs(bc.size.z) / 2,
      };
      this.createVisualization(gltfCenter, halfSize);
    }

    // Register in transport manager
    context.transportManager.sensors.push(this);

    debug('sensor', `Sensor: ${this.node.name} mode=${this.mode} dir=${this.UseRaycast ? JSON.stringify(this.RayCastDirection) : 'N/A'} len=${this.RayCastLength}mm${sensorOccupiedAddr ? ` → ${sensorOccupiedAddr}` : ''}`);
  }

  // ─── Collision-mode visualization (box) ────────────────────────────

  /**
   * Create the visual indicator mesh for Collision mode.
   * Must be called after construction with the BoxCollider center/size
   * from the GLB extras (in glTF space, matching the AABB).
   */
  createVisualization(localCenter: { x: number; y: number; z: number }, halfSize: { x: number; y: number; z: number }): void {
    const sx = halfSize.x * 2;
    const sy = halfSize.y * 2;
    const sz = halfSize.z * 2;
    if (sx < 0.0001 && sy < 0.0001 && sz < 0.0001) return;

    const geo = new BoxGeometry(sx, sy, sz);
    this.visMesh = new Mesh(geo, matYellow);
    this.visMesh.position.set(localCenter.x, localCenter.y, localCenter.z);
    this.visMesh.renderOrder = 999; // render on top of scene geometry
    this.visMesh.name = `${this.node.name}_sensorViz`;

    const edgesGeo = new EdgesGeometry(geo);
    this.visEdges = new LineSegments(edgesGeo, wireYellow);
    this.visEdges.position.copy(this.visMesh.position);
    this.visEdges.renderOrder = 999;

    this.node.add(this.visMesh);
    this.node.add(this.visEdges);
  }

  // ─── Raycast-mode visualization (tube) ──────────────────────────────

  /** Shared ray tube materials (more visible than Line which has no width on WebGL) */
  private static readonly rayMatYellow = new MeshBasicMaterial({
    color: YELLOW, transparent: true, opacity: 0.5, depthWrite: false,
  });
  private static readonly rayMatRed = new MeshBasicMaterial({
    color: RED, transparent: true, opacity: 0.7, depthWrite: false,
  });

  /** Create the ray tube visualization for Raycast mode. */
  createRayVisualization(): void {
    if (!this.UseRaycast) return;

    const maxDist = this.RayCastLength / 1000;
    const radius = 0.002; // 2mm radius — visible but not obtrusive
    const indexedGeo = new CylinderGeometry(radius, radius, maxDist, 6, 1);
    // CylinderGeometry is along Y by default; we'll orient it per-frame
    indexedGeo.translate(0, maxDist / 2, 0); // pivot at bottom (origin = ray start)
    indexedGeo.rotateX(Math.PI / 2); // point along +Z as default forward

    // Convert to non-indexed to avoid WebGPU index buffer format issues
    const geo = indexedGeo.toNonIndexed();
    indexedGeo.dispose();

    this.rayTube = new Mesh(geo, RVSensor.rayMatYellow);
    this.rayTube.renderOrder = 999;
    this.rayTube.frustumCulled = false;
    this.rayTube.name = `${this.node.name}_sensorRay`;

    // Add to scene root (world-space transform)
    let root: Object3D = this.node;
    while (root.parent && root.parent.parent) root = root.parent;
    root.add(this.rayTube);

    // Initialize position/orientation
    this.updateRayTube();
  }

  /** Compute world-space ray origin and direction. */
  private computeRay(): { origin: Vector3; dir: Vector3; maxDist: number } {
    const d = this.RayCastDirection;
    const maxDist = this.RayCastLength / 1000; // mm → meters

    this.node.updateWorldMatrix(true, false);
    _origin.setFromMatrixPosition(this.node.matrixWorld);
    _dir.set(d.x, d.y, d.z).transformDirection(this.node.matrixWorld).normalize();

    return { origin: _origin, dir: _dir, maxDist };
  }

  /** Update the ray tube position, orientation, and color. Always full length. */
  private updateRayTube(): void {
    if (!this.rayTube) return;

    const { origin, dir } = this.computeRay();

    // Position at ray origin
    this.rayTube.position.copy(origin);

    // Orient tube to point along ray direction
    // The tube geometry points along +Z after our rotateX(PI/2)
    _forward.set(0, 0, 1);
    _quat.setFromUnitVectors(_forward, dir);
    this.rayTube.quaternion.copy(_quat);

    // Color: yellow=idle, red=occupied
    this.rayTube.material = this.occupied ? RVSensor.rayMatRed : RVSensor.rayMatYellow;
  }

  // ─── Visualization update (both modes) ─────────────────────────────

  /** Update visualization color based on occupied state */
  private updateVisualization(): void {
    // Collision mode (box)
    if (this.visMesh && this.visEdges) {
      this.visMesh.material = this.occupied ? matRed : matYellow;
      this.visEdges.material = this.occupied ? wireRed : wireYellow;
    }
    // Raycast mode (tube color updated in updateRayTube)
  }

  // ─── Detection ─────────────────────────────────────────────────────

  /**
   * Check for MU presence and update occupied state.
   * Called once per fixed timestep.
   * Dispatches to collision (AABB) or raycast check based on mode.
   */
  checkOverlap(mus: (RVMovingUnit | InstancedMovingUnit)[]): void {
    if (this.UseRaycast) {
      this.checkRaycast(mus);
    } else {
      this.checkCollision(mus);
    }
  }

  /** Collision mode: AABB overlap check. */
  private checkCollision(mus: (RVMovingUnit | InstancedMovingUnit)[]): void {
    let foundMU: (RVMovingUnit | InstancedMovingUnit) | null = null;

    for (const mu of mus) {
      if (mu.markedForRemoval) continue;
      if (this.aabb.overlaps(mu.aabb)) {
        foundMU = mu;
        break; // First overlap is enough
      }
    }

    this.applyResult(foundMU);
  }

  /** Raycast mode: ray-AABB intersection against all MUs. */
  private checkRaycast(mus: (RVMovingUnit | InstancedMovingUnit)[]): void {
    const { origin, dir, maxDist } = this.computeRay();

    let foundMU: (RVMovingUnit | InstancedMovingUnit) | null = null;
    let hitDist = maxDist;

    for (const mu of mus) {
      if (mu.markedForRemoval) continue;
      const d = rayIntersectsAABB(
        origin.x, origin.y, origin.z,
        dir.x, dir.y, dir.z,
        maxDist,
        mu.aabb.min, mu.aabb.max,
      );
      if (d >= 0 && d < hitDist) {
        hitDist = d;
        foundMU = mu;
      }
    }

    this.applyResult(foundMU);
    this.updateRayTube();
  }

  /** Apply detection result and fire callback if state changed. */
  private applyResult(foundMU: (RVMovingUnit | InstancedMovingUnit) | null): void {
    const rawOccupied = foundMU !== null;
    const newOccupied = this.invertSignal ? !rawOccupied : rawOccupied;

    if (newOccupied !== this.occupied) {
      this.occupied = newOccupied;
      this.occupiedMU = foundMU;
      debug('sensor', `Sensor "${this.node.name}" → ${newOccupied ? 'OCCUPIED' : 'CLEARED'}${foundMU ? ` by "${foundMU.getName()}"` : ''}`);
      this.updateVisualization();
      this.onChanged?.(this.occupied, this);
    } else if (this.UseRaycast) {
      // Still update ray line even if state didn't change (MU might be moving)
      // updateRayTube is called from checkRaycast already
    }
  }

  /** Update AABB world position */
  updateAABB(): void {
    this.aabb.update();
  }
}

// Self-register for auto-discovery by scene loader
registerComponent({
  type: 'Sensor',
  schema: RVSensor.schema,
  needsAABB: true,
  capabilities: {
    hoverable: true,
    selectable: true,
    tooltipType: 'sensor',
    badgeColor: '#66bb6a',
    filterLabel: 'Sensors',
    simulationActive: true,
    hoverEnabledByDefault: true,
    exclusiveHoverGroup: true,
  },
  create: (node, aabb) => new RVSensor(node, aabb!),
  afterCreate: (_inst, node) => { node.userData._rvType = 'Sensor'; },
});
