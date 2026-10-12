// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import {
  Object3D,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  DoubleSide,
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
import { RV_SENSOR_BEAM_KEY, type PreBakedSensorBeam } from './rv-pre-bake-keys';
import { RVTransportSurface } from './rv-transport-surface';
import { createSignalWriter } from './rv-signal-store';
import {
  acquireRayTubeGeometry,
  acquireSensorBoxGeometry,
  acquireSensorEdgesGeometry,
  releaseSharedVizGeometry,
} from './rv-shared-viz-geometry';
import { syncColliderGizmo } from './rv-collider-gizmo-sync';
import { isSensorRuntimeVizName } from './rv-sensor-viz-names';

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

/** Drop visualisation children a file saved before the `_sensorRay` export
 *  prune carries. Detached only, not disposed: after the bake's dedup or a
 *  placement clone their geometry may be shared with the template. */
function removePersistedSensorViz(node: Object3D): void {
  const stale = node.children.filter((c) => isSensorRuntimeVizName(c.name));
  for (const child of stale) child.removeFromParent();
}

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
  /** Detects only MUs with this tag or name; empty detects all MUs. */
  LimitSensorToTag = '';

  accepts(mu: RVMovingUnit | InstancedMovingUnit): boolean {
    return !this.LimitSensorToTag || mu.node.userData.tag === this.LimitSensorToTag || mu.getName() === this.LimitSensorToTag;
  }
  /** Displays the detection volume in the web viewer without affecting detection. */
  private showGizmo = true;
  get ShowGizmo(): boolean { return this.showGizmo; }
  set ShowGizmo(value: boolean) {
    this.showGizmo = value;
    if (this.visMesh) this.visMesh.visible = value;
    if (this.visEdges) this.visEdges.visible = value;
    if (this.rayTube) this.rayTube.visible = value;
    syncColliderGizmo(this.node);
  }
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

  /** The ACTIVE MU list whose passive load trees a tag-limited sensor also
   *  checks (plan-516 F6). Injected by the transport manager every tick
   *  (self-healing, like the surfaces' accumulation provider); null =
   *  standalone, loads are not seen. */
  loadRoots: readonly (RVMovingUnit | InstancedMovingUnit)[] | null = null;

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

    // Create sensor visualization — on a clean node. A repeated init must not
    // stack a second beam on the first, and a file saved before the export
    // pruned `_sensorRay` still carries copies of earlier beams as children.
    this.releaseVisualization();
    removePersistedSensorViz(this.node);
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

  /** Run subscriptions cleanup and release the visualisation helpers. The
   *  scene loader calls this when reloading. The viz geometries are SHARED
   *  across sensors with identical parameters (rv-shared-viz-geometry) and the
   *  tree dispose helpers skip them — this is the one place that releases
   *  this sensor's reference; the geometry is freed with the last user. */
  dispose(): void {
    if (this._layoutUnsub) {
      this._layoutUnsub();
      this._layoutUnsub = null;
    }
    this.feedbackListeners.length = 0;
    this.releaseVisualization();
  }

  private releaseVisualization(): void {
    if (this.rayTube) {
      this.rayTube.removeFromParent();
      releaseSharedVizGeometry(this.rayTube.geometry);
      this.rayTube = null;
    }
    if (this.visMesh) {
      this.visMesh.removeFromParent();
      releaseSharedVizGeometry(this.visMesh.geometry);
      this.visMesh = null;
    }
    if (this.visEdges) {
      this.visEdges.removeFromParent();
      releaseSharedVizGeometry(this.visEdges.geometry);
      this.visEdges = null;
    }
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

    // Shared per (sx, sy, sz) — see rv-shared-viz-geometry; released in dispose().
    const geo = acquireSensorBoxGeometry(sx, sy, sz);
    this.visMesh = new Mesh(geo, matYellow);
    this.visMesh.position.set(localCenter.x, localCenter.y, localCenter.z);
    this.visMesh.renderOrder = 999; // render on top of scene geometry
    this.visMesh.name = `${this.node.name}_sensorViz`;

    const edgesGeo = acquireSensorEdgesGeometry(geo);
    this.visEdges = new LineSegments(edgesGeo, wireYellow);
    this.visEdges.name = `${this.node.name}_sensorViz_edges`;
    this.visEdges.position.copy(this.visMesh.position);
    this.visEdges.renderOrder = 999;

    this.node.add(this.visMesh);
    this.node.add(this.visEdges);
    this.ShowGizmo = this.showGizmo;
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
    // One geometry per (radius, length) shared by every sensor with the same
    // beam — pivot at the ray origin, pointing along the sensor's LOCAL +Z;
    // the scene graph carries the rest. Released in dispose().
    const geo = acquireRayTubeGeometry(radius, maxDist, 6);

    this.rayTube = new Mesh(geo, RVSensor.rayMatBlue);
    this.rayTube.visible = this.ShowGizmo;
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
    // plan-754 D18: the destructive bake merges the sensor's own source meshes
    // into a chunk, so the fallback bounds walk finds nothing. The `Sensor`
    // pre-bake hook computed the beam while the sources were still there and
    // stamped it as plain data; prefer it. Non-baking loads have no stamp and
    // derive the beam live, exactly as before.
    const stored = this.node.userData?.[RV_SENSOR_BEAM_KEY] as PreBakedSensorBeam | undefined;
    const beam = stored && Array.isArray(stored.originOffset)
      ? {
          originOffset: new Vector3(stored.originOffset[0], stored.originOffset[1], stored.originOffset[2]),
          direction: stored.direction,
          lengthMm: stored.lengthMm,
        }
      : computeBeamFromBounds(this.node, rayNode);
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
      if (mu.markedForRemoval || !this.accepts(mu)) continue;
      if (this.aabb.overlaps(mu.aabb)) {
        foundMU = mu;
        break; // First overlap is enough
      }
    }
    if (!foundMU && this.LimitSensorToTag) foundMU = this.findTaggedLoad(-1);

    this.applyResult(foundMU);
  }

  // ─── Passive loads (plan-516 F6) ──────────────────────────────────

  /** Scratch for the load-tree ray test (hit distance). */
  private _loadHitDist = 0;

  /**
   * A tag-limited sensor also detects PASSIVE loads (they are not in the
   * ticked MU list): walk every active MU's load tree, on demand and
   * independent of the transport AABB of the carrier. `rayMax < 0` = box
   * overlap, else a ray test up to `rayMax` (the nearest hit wins).
   * Only tag-limited sensors pay for it — an unlimited sensor already sees
   * the carrier.
   */
  private findTaggedLoad(rayMax: number): RVMovingUnit | null {
    const roots = this.loadRoots;
    if (!roots) return null;
    this._loadHitDist = rayMax;
    let found: RVMovingUnit | null = null;
    for (let i = 0; i < roots.length; i++) {
      const r = roots[i];
      if (r.isInstanced || r.markedForRemoval) continue;
      const carrier = r as RVMovingUnit;
      if (carrier.loadedMus.length === 0) continue;
      const hit = this.findInLoadTree(carrier, rayMax);
      if (hit) {
        found = hit;
        if (rayMax < 0) break;
      }
    }
    return found;
  }

  private findInLoadTree(carrier: RVMovingUnit, rayMax: number): RVMovingUnit | null {
    let found: RVMovingUnit | null = null;
    const loads = carrier.loadedMus;
    for (let i = 0; i < loads.length; i++) {
      const load = loads[i];
      if (this.accepts(load)) {
        load.updateAABB();
        if (rayMax < 0) {
          if (this.aabb.overlaps(load.aabb)) return load;
        } else {
          const { origin, dir } = this.computeRay();
          const d = rayIntersectsAABB(
            origin.x, origin.y, origin.z, dir.x, dir.y, dir.z,
            this._loadHitDist, load.aabb.min, load.aabb.max,
          );
          if (d >= 0 && d < this._loadHitDist) { this._loadHitDist = d; found = load; }
        }
      }
      const inner = this.findInLoadTree(load, rayMax);
      if (inner) {
        if (rayMax < 0) return inner;
        found = inner;
      }
    }
    return found;
  }

  /** Raycast mode: ray-AABB intersection against all MUs. */
  private checkRaycast(mus: (RVMovingUnit | InstancedMovingUnit)[]): void {
    const { origin, dir, maxDist } = this.computeRay();

    let foundMU: (RVMovingUnit | InstancedMovingUnit) | null = null;
    let hitDist = maxDist;

    for (const mu of mus) {
      if (mu.markedForRemoval || !this.accepts(mu)) continue;
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
    if (!foundMU && this.LimitSensorToTag) foundMU = this.findTaggedLoad(maxDist);

    this.applyResult(foundMU);
    this.updateRayTube();
  }

  /**
   * Simulation reset: back to "nothing detected" THROUGH the change pipeline, so a
   * bound SensorOccupied / SensorNotOccupied signal follows. Writing `occupied`
   * directly left such a signal at its pre-reset value: the re-evaluation after the
   * reset then saw "free → free" and fired nothing (plan-569, engine gap 2).
   */
  resetDetection(): void {
    this.applyResult(null);
    this.occupiedMU = null;
  }

  /** Apply detection result and fire callback if state changed. */
  private applyResult(foundMU: (RVMovingUnit | InstancedMovingUnit) | null): void {
    if (foundMU && !this.accepts(foundMU)) foundMU = null;
    // The nearest part can change while the occupied boolean stays true.
    this.occupiedMU = foundMU;
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
    pick: 'select',
    // bake stays 'merge': only the `_sensorViz` ray mesh must survive as an
    // individual mesh, and that is a MESH-level exclusion (isExcludedMesh in
    // rv-bake-pipeline.ts). A type-level 'keep' would pull the whole sensor
    // housing out of the arenas.
    ui: { tooltip: 'sensor', badge: '#66bb6a', filter: 'Sensors', category: 'sensors' },
  },
  create: (node, aabb) => new RVSensor(node, aabb!),
  afterCreate: (_inst, node) => { node.userData._rvType = 'Sensor'; },
});
