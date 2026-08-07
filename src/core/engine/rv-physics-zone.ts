// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-physics-zone.ts — RVPhysicsZone, TypeScript counterpart of Unity
 * `WebPhysicsZone.cs` (plan-276 Phase 2).
 *
 * A physics zone is a 3D BOX VOLUME inside which MUs become free dynamic
 * rigid bodies (falling, sliding, tipping, stacking in bins). The zone
 * volume comes from the node's BoxCollider extras (`AABB.fromBoxCollider`
 * via the loader's `needsAABB` path); with `WholeScene` the scene bounding
 * box is applied later by the physics plugin (`applySceneBounds`, Phase 3).
 *
 * Naming disambiguation: NOT to be confused with `ZoneRegistry` in
 * `rv-zone-registry.ts` (plan-268) — that manages 1D AGV path-segment
 * CAPACITY for vehicle routing. RVPhysicsZone is a spatial 3D volume.
 *
 * Phase-2 scope (this file): extras parsing, zone AABB, WholeScene flag,
 * registration order + first-wins overlap rule (F2), overlap/containment
 * helpers and the wireframe gizmo (F13). Body creation, handover and all
 * lifecycle guards live in the physics-zone plugin (Phase 3, Private~).
 *
 * Phase-3 gotchas (for the plugin):
 * - `RVPhysicsZone.zones` is a static module-level collection: the plugin
 *   MUST call `RVPhysicsZone.clearAll()` on model load/clear — components
 *   have no reliable per-instance dispose call on model switches.
 * - `StaticColliders` holds RAW node paths (strings). Resolve them with the
 *   public `registry.getNode(path)` — NOT via resolveComponentRefs (plan-276
 *   §2.4: it only knows Drive/Sensor/Signal types and would spam the console).
 * - WholeScene zones have `worldAabb === null` until `applySceneBounds()` is
 *   called with `LoadResult.boundingBox` (they still hold their registration
 *   slot for the F2 first-wins order).
 */

import { Object3D } from 'three';
import type { ComponentContext, ComponentSchema, RVComponent } from './rv-component-registry';
import { registerComponent, loadSchemaFromSpec } from './rv-component-registry';
import type { AABB } from './rv-aabb';
import type { GizmoHandle, GizmoOverlayManager } from './rv-gizmo-manager';
import type { PhysicsAABB, PhysicsZoneConfig } from './rv-physics-registry';

// ─── Gizmo styling (plan-276 §3.2: cyan, semi-transparent wireframe) ───────

const ZONE_GIZMO_COLOR = 0x26c6da; // cyan
const ZONE_GIZMO_OPACITY = 0.5;

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Pure AABB overlap test on structural min/max boxes (no allocations). */
function aabbsOverlap(a: PhysicsAABB, b: PhysicsAABB): boolean {
  return (
    a.min.x <= b.max.x && a.max.x >= b.min.x &&
    a.min.y <= b.max.y && a.max.y >= b.min.y &&
    a.min.z <= b.max.z && a.max.z >= b.min.z
  );
}

/** True when `inner` is FULLY contained in `outer` (surface assignment, §2.4). */
function aabbContains(outer: PhysicsAABB, inner: PhysicsAABB): boolean {
  return (
    inner.min.x >= outer.min.x && inner.max.x <= outer.max.x &&
    inner.min.y >= outer.min.y && inner.max.y <= outer.max.y &&
    inner.min.z >= outer.min.z && inner.max.z <= outer.max.z
  );
}

/**
 * Defensive parse of the raw `StaticColliders` extras value into node paths.
 * Accepts plain strings and ComponentReference-shaped objects (`{ path }`) —
 * the Unity catch-all export may serialize `List<GameObject>` either way.
 * Anything else is dropped silently (defensive parsing, no throw).
 */
export function parseStaticColliderPaths(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item === 'string') {
      if (item.length > 0) out.push(item);
    } else if (item && typeof item === 'object') {
      const path = (item as { path?: unknown }).path;
      if (typeof path === 'string' && path.length > 0) out.push(path);
    }
  }
  return out;
}

// ─── RVPhysicsZone ──────────────────────────────────────────────────────────

export class RVPhysicsZone implements RVComponent {
  // Loaded from the rv-ODT specification (schema/v1/rv-odt.json).
  // NOTE: StaticColliders (string[]) is NOT a schema field — the schema mapper
  //       has no string-array type; it is a `rawFields` entry captured in the
  //       factory's beforeSchema hook (pattern: IKTarget.AxisPos).
  static readonly schema: ComponentSchema = loadSchemaFromSpec('WebPhysicsZone');

  /** All registered zones in REGISTRATION ORDER — the first registered zone
   *  wins on overlap (F2, deterministic; configs are never mixed). Zones
   *  without a volume (no BoxCollider extras AND not WholeScene) are never
   *  registered (plan-276 §5.4: warning + zone ignored). */
  static readonly zones: RVPhysicsZone[] = [];

  /**
   * First registered zone whose volume overlaps `aabb`, or `null`.
   * Deliberately an AABB-OVERLAP test, NOT full containment (F4): an MU that
   * lost its driving surface but has only partially reached the zone box must
   * still be handed over — full containment would freeze it mid-air at the
   * zone edge. Disabled zones and zones without a resolved volume (WholeScene
   * before `applySceneBounds`) never win.
   */
  static findZoneOverlapping(aabb: PhysicsAABB): RVPhysicsZone | null {
    for (const zone of RVPhysicsZone.zones) {
      if (!zone.ZoneEnabled) continue;
      const volume = zone.worldAabb;
      if (!volume) continue;
      if (aabbsOverlap(volume, aabb)) return zone; // first registered wins (F2)
    }
    return null;
  }

  /** Dispose every zone (gizmos included) and empty the registration list.
   *  Called on model switches (Phase-3 plugin) and in tests. */
  static clearAll(): void {
    for (const zone of [...RVPhysicsZone.zones]) zone.dispose();
    RVPhysicsZone.zones.length = 0;
  }

  /**
   * Create + register a SYNTHETIC WholeScene zone (F16, scope change
   * 2026-07-11): when the Settings-panel physics toggle is ON and the loaded
   * model contains NO explicit `WebPhysicsZone` extras, the physics plugin
   * calls this so the toggle alone makes the whole scene physics-capable.
   *
   * The zone is NOT loader-created: it has no GLB node and no extras — a
   * detached placeholder Object3D is created internally so callers never
   * fabricate fake scene nodes. Defaults per F16: Friction 0.8, Restitution 0,
   * ShowGizmo false; `RemoveBelowY` should be set by the caller from the scene
   * bounds (min.y − 10) before/after `applySceneBounds(LoadResult.boundingBox)`.
   * The zone registers immediately (holding its F2 first-wins slot) but stays
   * inactive (`worldAabb === null`) until `applySceneBounds()` is applied.
   */
  static createSynthetic(config?: {
    friction?: number;
    restitution?: number;
    removeBelowY?: number;
    showGizmo?: boolean;
  }): RVPhysicsZone {
    const node = new Object3D();
    node.name = '__SyntheticWholeScenePhysicsZone';
    const zone = new RVPhysicsZone(node, null);
    zone.WholeScene = true;
    zone.Friction = config?.friction ?? 0.8;
    zone.Restitution = config?.restitution ?? 0.0;
    zone.RemoveBelowY = config?.removeBelowY ?? -10;
    zone.ShowGizmo = config?.showGizmo ?? false;
    zone._registered = true;
    RVPhysicsZone.zones.push(zone); // registration order = F2 priority
    return zone;
  }

  readonly node: Object3D;
  isOwner = true;

  // ── Schema-populated (exact C# field names; initializers are the defensive
  //    fallback — applySchema stamps the rv-odt.json defaults on top) ──
  ZoneEnabled = true;   // enables physics simulation inside this zone
  WholeScene = false;   // ignore the box volume, whole scene = zone (F3)
  Friction = 0.8;       // default friction for MUs inside the zone
  Restitution = 0.0;    // bounciness of MUs inside the zone (0 = none)
  RemoveBelowY = -10;   // MUs below this world Y (m) are removed (F9)
  ShowGizmo = true;     // wireframe box in the viewer (F13)

  /** RAW node paths of additional static collision geometry (chutes, bins).
   *  Stored as-is in Phase 2; resolved via `registry.getNode(path)` with a
   *  null-check + one warning per missing entry in Phase 3 (F8). */
  StaticColliders: string[] = [];

  /** Loader-provided box volume (BoxCollider extras / mesh bounds); `null`
   *  when the loader AABB was degenerate (no volume information). */
  private readonly _boxAabb: AABB | null;
  /** Scene bounds snapshot for WholeScene zones (set by `applySceneBounds`). */
  private _sceneBounds: PhysicsAABB | null = null;
  private _registered = false;
  private _gizmo: GizmoHandle | null = null;
  private _gizmoManager: GizmoOverlayManager | null = null;

  constructor(node: Object3D, aabb: AABB | null) {
    this.node = node;
    // A degenerate AABB (empty node without BoxCollider extras) carries no
    // volume — treat as absent so init() can warn + ignore the zone (§5.4).
    this._boxAabb = aabb && aabb.halfSize.lengthSq() > 0 ? aabb : null;
  }

  /** Effective zone volume in world meters, or `null` when unknown
   *  (zone without volume, or WholeScene before `applySceneBounds`). */
  get worldAabb(): PhysicsAABB | null {
    if (this.WholeScene) return this._sceneBounds;
    // The engine AABB is structurally a PhysicsAABB (min/max carry x/y/z).
    return this._boxAabb;
  }

  init(ctx: ComponentContext): void {
    this.node.userData._rvType = 'WebPhysicsZone';

    // Zone without a box volume AND without WholeScene: warning + ignored
    // (plan-276 §5.4). WholeScene zones register now (holding their F2 slot)
    // and receive their volume later via applySceneBounds().
    if (!this.WholeScene && !this._boxAabb) {
      console.warn(
        `[WebPhysicsZone] "${this.node.name}": no BoxCollider extras and WholeScene=false — zone is ignored`,
      );
      return;
    }

    if (!this._registered) {
      this._registered = true;
      RVPhysicsZone.zones.push(this); // registration order = F2 priority
    }

    if (ctx.gizmoManager) this.attachGizmo(ctx.gizmoManager);
  }

  /** True when this zone participates in overlap queries. */
  get active(): boolean {
    return this._registered && this.ZoneEnabled && this.worldAabb !== null;
  }

  /**
   * Apply the scene bounding box as this zone's volume (F3). Only WholeScene
   * zones accept it; called by the physics plugin (Phase 3) with
   * `LoadResult.boundingBox` (a THREE.Box3 satisfies the structural type).
   * The bounds are snapshot-copied — the caller may reuse its Box3.
   */
  applySceneBounds(bounds: PhysicsAABB): void {
    if (!this.WholeScene) return;
    this._sceneBounds = {
      min: { x: bounds.min.x, y: bounds.min.y, z: bounds.min.z },
      max: { x: bounds.max.x, y: bounds.max.y, z: bounds.max.z },
    };
    this._refreshGizmo();
  }

  /** AABB-overlap test against this zone's volume (F4 handover criterion). */
  overlapsAABB(aabb: PhysicsAABB): boolean {
    const volume = this.worldAabb;
    return volume !== null && aabbsOverlap(volume, aabb);
  }

  /** Full-containment test (surface assignment §2.4: a surface must lie
   *  FULLY inside the zone to run in physics mode — belts are never cut). */
  containsAABB(aabb: PhysicsAABB): boolean {
    const volume = this.worldAabb;
    return volume !== null && aabbContains(volume, aabb);
  }

  /** Per-zone provider config (plan-276 §2.3 → `PhysicsProvider.addZone`). */
  toZoneConfig(): PhysicsZoneConfig {
    return {
      friction: this.Friction,
      restitution: this.Restitution,
      removeBelowY: this.RemoveBelowY,
    };
  }

  /**
   * Create (or refresh) the wireframe-box gizmo via the shared
   * GizmoOverlayManager (F13, pattern: RVSafetyDoor halo). Idempotent; safe
   * to call before the volume is known (no-op until `worldAabb` resolves —
   * the plugin calls it again after `applySceneBounds`).
   */
  attachGizmo(gizmoManager: GizmoOverlayManager): void {
    this._gizmoManager = gizmoManager;
    this._refreshGizmo();
  }

  /** Show/hide the zone wireframe (Settings toggle, F13). */
  setGizmoVisible(visible: boolean): void {
    this._gizmo?.setVisible(visible);
  }

  private _refreshGizmo(): void {
    if (!this._gizmoManager || !this.ShowGizmo) return;
    const volume = this.worldAabb;
    if (!volume) return;

    if (!this._gizmo) {
      this._gizmo = this._gizmoManager.create(this.node, {
        shape: 'box',
        color: ZONE_GIZMO_COLOR,
        opacity: ZONE_GIZMO_OPACITY,
        category: 'status',
      });
    }
    // Zone nodes are typically meshless empties — the manager's subtree-AABB
    // fallback is a 0.1 m cube at the node origin. Size the wireframe from
    // the zone volume instead: the 'box' shape root is scene-parented (world
    // space) and exposed for exactly this kind of caller-side transform.
    const root = this._gizmo.root;
    root.position.set(
      (volume.min.x + volume.max.x) / 2,
      (volume.min.y + volume.max.y) / 2,
      (volume.min.z + volume.max.z) / 2,
    );
    root.scale.set(
      Math.max(volume.max.x - volume.min.x, 0.001),
      Math.max(volume.max.y - volume.min.y, 0.001),
      Math.max(volume.max.z - volume.min.z, 0.001),
    );
  }

  dispose(): void {
    this._gizmo?.dispose();
    this._gizmo = null;
    this._gizmoManager = null;
    if (this._registered) {
      this._registered = false;
      const idx = RVPhysicsZone.zones.indexOf(this);
      if (idx !== -1) RVPhysicsZone.zones.splice(idx, 1);
    }
  }
}

// ─── Self-register for auto-discovery by the scene loader ───────────────────
// `type` matches the GLB extras key (Unity class name `WebPhysicsZone`);
// `displayName` is what the hierarchy/inspector shows.

registerComponent({
  type: 'WebPhysicsZone',
  displayName: 'PhysicsZone',
  schema: RVPhysicsZone.schema,
  needsAABB: true,
  capabilities: {
    hoverable: false,
    selectable: false,
    badgeColor: '#26c6da', // cyan — matches the zone wireframe
  },
  create: (node, aabb) => new RVPhysicsZone(node, aabb),
  beforeSchema: (inst, extras) => {
    // rawFields capture (schema mapper has no string-array type) — see class note.
    (inst as RVPhysicsZone).StaticColliders = parseStaticColliderPaths(extras['StaticColliders']);
  },
});
