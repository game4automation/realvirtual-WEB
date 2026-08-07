// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import {
  Object3D,
  Mesh,
  BoxGeometry,
  CylinderGeometry,
  MeshBasicMaterial,
  MeshStandardMaterial,
  DoubleSide,
  EdgesGeometry,
  LineSegments,
  LineBasicMaterial,
  Vector3,
  Quaternion,
  Box3,
  Matrix4,
} from 'three';
import { AABB } from './rv-aabb';
import type { RVMovingUnit, InstancedMovingUnit, IMUAccessor } from './rv-mu';
import type { ComponentSchema, ComponentContext, RVComponent } from './rv-component-registry';
import { registerComponent, loadSchemaFromSpec } from './rv-component-registry';
import { NodeRegistry } from './rv-node-registry';
import { unityPositionToGltf } from './rv-coordinate-utils';
import { debug } from './rv-debug';
import { MM_TO_METERS } from './rv-constants';
import { RVTransportSurface } from './rv-transport-surface';
import { createSignalWriter } from './rv-signal-store';

// Shared materials (reused across all sensors to save GPU resources)
const YELLOW = 0xffcc00;
const RED = 0xff2222;
const BLUE = 0x2277ff; // idle ray color

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

// ─── Auto-ray beam from bounding box (for convention sensors) ─────────

export interface SensorBeam {
  /** Ray start in the sensor node's LOCAL space — centre of the min face along the longest axis. */
  originOffset: Vector3;
  /** Ray direction in local space — unit vector along the longest box axis. */
  direction: { x: number; y: number; z: number };
  /** Beam length in millimetres — the longest box extent. */
  lengthMm: number;
}

/**
 * AABB enclosing all mesh geometry under `source`, expressed in `node`'s LOCAL
 * frame (empty Box3 if none). `source` defaults to `node`; pass a descendant
 * (e.g. a "Ray" marker) to derive the beam from just that sub-tree while keeping
 * the result in the sensor node's local space — the frame `computeRay` expects.
 */
function localGeometryBounds(node: Object3D, source: Object3D = node): Box3 {
  node.updateWorldMatrix(true, true);
  const inv = new Matrix4().copy(node.matrixWorld).invert();
  const box = new Box3();
  const childBox = new Box3();
  const m = new Matrix4();
  source.traverse((child) => {
    const mesh = child as Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
    const gb = mesh.geometry.boundingBox;
    if (!gb) return;
    m.multiplyMatrices(inv, mesh.matrixWorld);   // child geometry → node-local
    childBox.copy(gb).applyMatrix4(m);
    box.union(childBox);
  });
  return box;
}

/** Matches a "Ray" child name, tolerating duplicate-name suffixes: the glTF
 *  loader appends `_N` to disambiguate colliding node names (two sensors each
 *  with a "Ray" child → "Ray", "Ray_1", …), and Unity exports "(N)" duplicates.
 *  So `Ray`, `Ray_1`, `Ray (1)`, `Ray_(1)` all match; `RayCast`/`Ray_Beam` don't. */
const RAY_CHILD_NAME = /^Ray(_\d+|[_ ]?\(\d+\))?$/;

/** First descendant matching the "Ray" convention (node itself excluded), or null. */
export function findRayChild(node: Object3D): Object3D | null {
  let found: Object3D | null = null;
  node.traverse((o) => { if (!found && o !== node && RAY_CHILD_NAME.test(o.name)) found = o; });
  return found;
}

/**
 * Derive a raycast beam spanning the LONGEST edge of the node's bounding box —
 * from the centre of one end face to the centre of the opposite face. Returns
 * null when the node has no geometry. Assumes ~unit world scale (placed library
 * objects use scale 1); the beam length is the local extent.
 *
 * Pass `boundsSource` (e.g. a "Ray" marker child) to span just that sub-tree
 * instead of the whole node. If that source has no geometry, falls back to the
 * full node bounds so a misauthored marker never suppresses the beam.
 */
export function computeBeamFromBounds(node: Object3D, boundsSource?: Object3D | null): SensorBeam | null {
  const source = boundsSource ?? node;
  let box = localGeometryBounds(node, source);
  if (box.isEmpty() && source !== node) box = localGeometryBounds(node);   // fall back to full node
  if (box.isEmpty()) return null;
  const size = box.getSize(new Vector3());
  const center = box.getCenter(new Vector3());

  let axis: 'x' | 'y' | 'z' = 'x';
  let extent = size.x;
  if (size.y > extent) { axis = 'y'; extent = size.y; }
  if (size.z > extent) { axis = 'z'; extent = size.z; }
  if (extent < 1e-5) return null;

  const originOffset = center.clone();
  originOffset[axis] = box.min[axis];   // centre of the min-face along the longest axis
  const direction = { x: axis === 'x' ? 1 : 0, y: axis === 'y' ? 1 : 0, z: axis === 'z' ? 1 : 0 };
  return { originOffset, direction, lengthMm: extent * 1000 };
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
  // Loaded from the rv-ODT specification (schema/v1/rv-odt.json, plan-187).
  static readonly schema: ComponentSchema = loadSchemaFromSpec('Sensor');

  readonly node: Object3D;
  readonly aabb: AABB;
  isOwner = true;

  // Properties — exact C# Inspector field names
  UseRaycast = false;
  RayCastDirection: Vector3 | { x: number; y: number; z: number } = { x: -1, y: 0, z: 0 };
  RayCastLength = 1000;
  /** When true, the ray beam is auto-derived from the node bounding box (convention sensors). */
  AutoRay = false;
  /** Ray start in node-local space. (0,0,0) = node origin; set by AutoRay to a box-face centre. */
  private rayOriginOffset = new Vector3();

  // Derived mode for backward compat with callers checking mode
  get mode(): 'Raycast' | 'Collision' { return this.UseRaycast ? 'Raycast' : 'Collision'; }

  /** Authoritative current runtime value for UI display (live source of truth). */
  getLiveState(): Record<string, unknown> {
    return { Occupied: this.occupied };
  }

  /** Resolved signal address for SensorOccupied PLCInputBool (null if not connected) */
  SensorOccupied: string | null = null;
  /** Resolved signal address for SensorNotOccupied PLCInputBool (null if not connected) */
  SensorNotOccupied: string | null = null;

  /** InvertSignal — not in C# Sensor.cs, but needed for internal logic */
  invertSignal = false;

  /** Physics mode (plan-276 Phase 5, F6): when true AND the sensor overlaps a
   *  physics zone (overlap suffices — sensors are thin and may sit on the zone
   *  edge) AND the physics provider is ready, the sensor is physics-managed:
   *  collision mode becomes a Rapier sensor collider (enter/leave events),
   *  raycast mode a per-tick `provider.castRay()`. A physics-managed sensor is
   *  SKIPPED by the kinematic detection loop; the physics plugin drives
   *  `occupied` through `applyPhysicsResult()` so `onChanged` keeps firing
   *  (SensorMonitorPlugin/recorder compatibility). NOTE: a physics-managed
   *  sensor only sees physics-owned MUs (provider bodies) — sensors that must
   *  detect kinematic MUs stay on the default AABB path (PhysicsMode false).
   *  The zone-overlap check runs in the physics plugin's world build. */
  PhysicsMode = false;

  /** Current occupied state */
  occupied = false;
  /** The MU currently occupying this sensor (first one found) */
  occupiedMU: (RVMovingUnit | InstancedMovingUnit) | null = null;

  /** Planner Signal Linking: when live-controlled, the AABB/raycast detection is
   *  skipped and `occupied` is driven by the CONNECT relay (overrideOccupied
   *  path). The onChanged writeback is also gated so the live value is not
   *  overwritten. Set by SignalBindingManager. */
  liveControlled = false;
  /** Callback for state change (for UI/visualization updates) */
  onChanged?: (occupied: boolean, sensor: RVSensor) => void;
  private readonly feedbackListeners: (() => void)[] = [];

  /** Visual mesh for sensor zone — Collision mode (child of sensor node) */
  private visMesh: Mesh | null = null;
  /** Wireframe edges for sensor zone — Collision mode */
  private visEdges: LineSegments | null = null;

  /** Ray tube visualization — Raycast mode (added to scene, world-space) */
  private rayTube: Mesh | null = null;

  /** BoxCollider data from GLB extras, stored during construction for use in init() */
  boxColliderData: { center: { x: number; y: number; z: number }; size: { x: number; y: number; z: number } } | null = null;

  /** Unsub for 'layout-transform-update' — refreshes AABB when an ancestor moves. */
  private _layoutUnsub: (() => void) | null = null;

  /** Node path captured at init — used to match `layout-transform-update` events
   *  against ancestors of this sensor's node. */
  private _nodePath = '';

  constructor(node: Object3D, aabb: AABB) {
    this.node = node;
    this.aabb = aabb;
  }

  addFeedbackListener(cb: () => void): void {
    if (!this.feedbackListeners.includes(cb)) this.feedbackListeners.push(cb);
  }

  removeFeedbackListener(cb: () => void): void {
    const index = this.feedbackListeners.indexOf(cb);
    if (index >= 0) this.feedbackListeners.splice(index, 1);
  }

  readFeedbackSlot(slot: string): boolean | number {
    if (slot === 'SensorOccupied') return this.occupied;
    if (slot === 'SensorNotOccupied') return !this.occupied;
    throw new Error(`[Sensor] Unknown feedback slot "${slot}"`);
  }

  /**
   * Wire sensor into SignalStore and create visualization.
   * Called after applySchema + resolveComponentRefs.
   */
  init(context: ComponentContext): void {
    const path = NodeRegistry.computeNodePath(this.node);
    const writer = createSignalWriter(
      context.signalStore,
      `component:Sensor:${path}`,
      'component',
      { slotContext: path },
    );
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
    this._nodePath = sensorPath;
    // Resolve SensorOccupied/SensorNotOccupied signal addresses
    const sensorOccupiedAddr = typeof this.SensorOccupied === 'string' ? this.SensorOccupied : null;
    const sensorNotOccupiedAddr = typeof this.SensorNotOccupied === 'string' ? this.SensorNotOccupied : null;

    this.onChanged = (occupied) => {
      // Live override (Planner Signal Linking): when a CONNECT source drives this
      // sensor's occupied signal, the relay owns the value — do NOT write the
      // AABB-derived value back over it (two-stage guard: AABB skip + this gate).
      if (this.liveControlled) return;
      // Mirror C# Sensor.cs: write to connected PLC signals
      if (sensorOccupiedAddr) {
        writer.setByPath(sensorOccupiedAddr, occupied);
      }
      if (sensorNotOccupiedAddr) {
        writer.setByPath(sensorNotOccupiedAddr, !occupied);
      }
    };

    // Convention sensors (bare Sensor/Sensor-* nodes, no authored BoxCollider):
    // derive a raycast beam along the longest bounding-box edge.
    if (this.AutoRay && !this.boxColliderData) {
      this.autoConfigureRay();
    }

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

    // Refresh the AABB whenever an ancestor LayoutObject is moved/rotated by
    // the planner, inspector, snap-flip, etc. The fixed-loop already refreshes
    // it during sim, but in paused/edit mode the AABB would otherwise stay
    // frozen at its last-tick centre — the visMesh follows via the scene graph,
    // so the visual and detection volume would drift apart.
    if (context.events) {
      this._layoutUnsub = context.events.on('layout-transform-update', (data: { path: string }) => {
        if (!data || typeof data.path !== 'string') return;
        // Match self OR an ancestor: sensor at path "Root/A/B" must react to
        // moves of "Root", "Root/A", and "Root/A/B".
        if (this._nodePath === data.path || this._nodePath.startsWith(`${data.path}/`)) {
          // World matrices may not be up-to-date yet — refresh ancestors first.
          this.node.updateWorldMatrix(true, false);
          this.updateAABB();
        }
      });
    }

    debug('sensor', `Sensor: ${this.node.name} mode=${this.mode} dir=${this.UseRaycast ? JSON.stringify(this.RayCastDirection) : 'N/A'} len=${this.RayCastLength}mm${sensorOccupiedAddr ? ` → ${sensorOccupiedAddr}` : ''}`);
  }

  /** Run subscriptions cleanup. The scene loader calls this when reloading. */
  dispose(): void {
    if (this._layoutUnsub) {
      this._layoutUnsub();
      this._layoutUnsub = null;
    }
    this.feedbackListeners.length = 0;
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

  /** Shared ray-tube materials — opaque & emissive (glow under bloom).
   *  Black base color + emissive carries the visible color so the beam renders
   *  self-lit regardless of scene lighting. UnrealBloomPass runs on the LINEAR
   *  scene (tone mapping is none), so intensities are sized to push linear
   *  luminance well past 1.0 (Rec.709): blue ≈0.21/unit, red ≈0.225/unit
   *  → ~1.75 luminance each, comfortably above a bloom threshold of 1. */
  private static readonly rayMatBlue = new MeshStandardMaterial({
    color: 0x000000, emissive: BLUE, emissiveIntensity: 8.5,
    transparent: false, toneMapped: true,
  });
  private static readonly rayMatRed = new MeshStandardMaterial({
    color: 0x000000, emissive: RED, emissiveIntensity: 8.0,
    transparent: false, toneMapped: true,
  });

  /** Create the ray tube visualization for Raycast mode. */
  createRayVisualization(): void {
    if (!this.UseRaycast) return;

    const maxDist = this.RayCastLength / MM_TO_METERS;
    const radius = 0.002; // 2mm radius — visible but not obtrusive
    const indexedGeo = new CylinderGeometry(radius, radius, maxDist, 6, 1);
    // CylinderGeometry is along Y by default; we orient it along the
    // sensor's LOCAL +Z forward (the geometry's intrinsic direction after
    // the rotation below) and let Three.js' scene graph carry the rest.
    indexedGeo.translate(0, maxDist / 2, 0); // pivot at bottom (origin = ray start)
    indexedGeo.rotateX(Math.PI / 2); // point along +Z as default forward

    // Convert to non-indexed to avoid WebGPU index buffer format issues
    const geo = indexedGeo.toNonIndexed();
    indexedGeo.dispose();

    this.rayTube = new Mesh(geo, RVSensor.rayMatBlue);
    this.rayTube.renderOrder = 999;
    this.rayTube.frustumCulled = false;
    this.rayTube.name = `${this.node.name}_sensorRay`;

    // Parent the tube to `this.node` and set its pose in LOCAL space. The
    // scene graph then carries any ancestor translation/rotation — no per-tick
    // world-space refresh needed. Mirrors the TransportSurface arrow gizmo
    // which uses the same local-parented pattern.
    const d = this.RayCastDirection;
    const localDir = new Vector3(d.x, d.y, d.z);
    if (localDir.lengthSq() < 1e-12) {
      localDir.set(0, 0, 1); // safe fallback: forward
    } else {
      localDir.normalize();
    }
    this.rayTube.position.copy(this.rayOriginOffset);
    _forward.set(0, 0, 1);
    _quat.setFromUnitVectors(_forward, localDir);
    this.rayTube.quaternion.copy(_quat);
    this.node.add(this.rayTube);
  }

  /**
   * Fill `out.min`/`out.max` with a world AABB enclosing the FULL raycast
   * beam segment (origin → origin + dir·maxDist). The transport manager uses
   * this as the broad-phase (spatial grid) query bounds in UseRaycast mode —
   * the sensor's own AABB does NOT cover the beam, which extends
   * `RayCastLength` beyond the node. Conservative by construction: every MU
   * AABB the ray can hit within `maxDist` overlaps these bounds. Only
   * min/max are written (all a grid query reads); the exact ray-vs-AABB test
   * stays in `checkRaycast`.
   */
  computeRayQueryBounds(out: AABB): void {
    // Fresh compute + tick stamp: `checkRaycast` in the SAME transport tick
    // (the manager calls bounds → grid query → checkOverlap) reuses the ray
    // instead of re-running updateWorldMatrix + the direction transform.
    const { origin, dir, maxDist } = this.computeRayFresh();
    this._rayTickId = RVTransportSurface.currentTickId;
    const ex = origin.x + dir.x * maxDist;
    const ey = origin.y + dir.y * maxDist;
    const ez = origin.z + dir.z * maxDist;
    out.min.set(Math.min(origin.x, ex), Math.min(origin.y, ey), Math.min(origin.z, ez));
    out.max.set(Math.max(origin.x, ex), Math.max(origin.y, ey), Math.max(origin.z, ez));
  }

  /** Tick id of the last `computeRayQueryBounds` — gates the per-tick ray reuse. */
  private _rayTickId = -1;
  private readonly _rayOrigin = new Vector3();
  private readonly _rayDir = new Vector3();
  private _rayMaxDist = 0;

  /** World-space ray, reusing this tick's `computeRayQueryBounds` result when available. */
  private computeRay(): { origin: Vector3; dir: Vector3; maxDist: number } {
    if (this._rayTickId === RVTransportSurface.currentTickId) {
      return { origin: this._rayOrigin, dir: this._rayDir, maxDist: this._rayMaxDist };
    }
    return this.computeRayFresh();
  }

  /** Compute world-space ray origin and direction (always fresh). */
  private computeRayFresh(): { origin: Vector3; dir: Vector3; maxDist: number } {
    const d = this.RayCastDirection;
    this._rayMaxDist = this.RayCastLength / MM_TO_METERS;

    this.node.updateWorldMatrix(true, false);
    // Ray start = local origin offset transformed to world (offset (0,0,0) → node origin).
    this._rayOrigin.copy(this.rayOriginOffset).applyMatrix4(this.node.matrixWorld);
    this._rayDir.set(d.x, d.y, d.z).transformDirection(this.node.matrixWorld).normalize();

    return { origin: this._rayOrigin, dir: this._rayDir, maxDist: this._rayMaxDist };
  }

  /** Derive the raycast beam from the bounding box (longest edge, face → face).
   *  Prefers a child named "Ray" as the bounds source and hides that marker. */
  private autoConfigureRay(): void {
    const rayNode = findRayChild(this.node);
    const beam = computeBeamFromBounds(this.node, rayNode);
    if (!beam) return;
    this.rayOriginOffset.copy(beam.originOffset);
    this.RayCastDirection = beam.direction;
    this.RayCastLength = beam.lengthMm;
    this.UseRaycast = true;
    if (rayNode) rayNode.visible = false;   // helper marker — hide once used
  }

  /** Update only the ray tube color — position/orientation are baked into the
   *  node-parented local transform at construction (carried by the scene graph). */
  private updateRayTube(): void {
    if (!this.rayTube) return;
    this.rayTube.material = this.occupied ? RVSensor.rayMatRed : RVSensor.rayMatBlue;
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
    // Live override: a CONNECT-driven sensor ignores local AABB/raycast detection
    // entirely — `occupied` is set from the relayed signal value (overrideOccupied).
    if (this.liveControlled) return;
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
      for (let i = 0; i < this.feedbackListeners.length; i++) this.feedbackListeners[i]();
    } else if (this.UseRaycast) {
      // Still update ray line even if state didn't change (MU might be moving)
      // updateRayTube is called from checkRaycast already
    }
  }

  // ─── Physics-managed detection (plan-276 Phase 5, F6) ───────────────

  /**
   * Apply an EXTERNALLY computed detection result (physics provider path).
   * Runs the exact same state/callback pipeline as the internal AABB/raycast
   * checks — invertSignal, occupiedMU, visualization and, on a state change,
   * `onChanged` (SensorMonitorPlugin + rv-sensor-recorder hang off it, F6).
   * Live-controlled sensors ignore it (the CONNECT relay owns the value),
   * mirroring the `checkOverlap` gate.
   */
  applyPhysicsResult(foundMU: (RVMovingUnit | InstancedMovingUnit) | null): void {
    if (this.liveControlled) return;
    this.applyResult(foundMU);
    if (this.UseRaycast) this.updateRayTube();
  }

  /**
   * Copy this tick's WORLD-space ray into `outOrigin`/`outDir` (unit) and
   * return the max distance in meters — the physics plugin feeds this into
   * `provider.castRay()` for raycast sensors in physics mode. Reuses the
   * per-tick cached ray (same tick id as `computeRayQueryBounds`), so the
   * matrix work runs at most once per tick per sensor.
   */
  getWorldRay(outOrigin: Vector3, outDir: Vector3): number {
    if (this._rayTickId !== RVTransportSurface.currentTickId) {
      this.computeRayFresh();
      this._rayTickId = RVTransportSurface.currentTickId;
    }
    outOrigin.copy(this._rayOrigin);
    outDir.copy(this._rayDir);
    return this._rayMaxDist;
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
    authorable: true,   // addable in the asset editor (schema-complete)
    hoverable: true,
    selectable: true,
    tooltipType: 'sensor',
    badgeColor: '#66bb6a',
    filterLabel: 'Sensors',
    hoverEnabledByDefault: true,
    exclusiveHoverGroup: true,
  },
  create: (node, aabb) => new RVSensor(node, aabb!),
  afterCreate: (_inst, node) => { node.userData._rvType = 'Sensor'; },
});
