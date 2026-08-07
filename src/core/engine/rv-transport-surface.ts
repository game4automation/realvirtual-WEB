// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { Box3, Object3D, Vector2, Vector3, Quaternion, MathUtils, Matrix4, Mesh, MeshBasicMaterial, PlaneGeometry, Shape, ShapeGeometry, DoubleSide, RepeatWrapping, EdgesGeometry, LineSegments, LineBasicMaterial } from 'three';
import { debug } from './rv-debug';
import { MM_TO_METERS } from './rv-constants';
import type { MeshStandardMaterial, Texture } from 'three';
import { AABB } from './rv-aabb';
import type { PhysicsAABB } from './rv-physics-registry';
import type { RVDrive } from './rv-drive';
import type { RVMovingUnit, InstancedMovingUnit } from './rv-mu';
import type { ComponentSchema, ComponentContext, RVComponent } from './rv-component-registry';
import { registerComponent, loadSchemaFromSpec } from './rv-component-registry';
import { traverseMeshes } from './rv-traverse-utils';
import type { GizmoOverlayManager } from './rv-gizmo-manager';
import { subscribeOverlayVisibility, isOverlayVisible } from '../overlay-visibility-store';

// Pre-allocated temp vectors (no GC in hot path)
const _movement = new Vector3();
const _offset = new Vector3();
// Pre-allocated scratch for the per-tick matrix-delta refresh.
const _scratchInv = new Matrix4();
const _quatCarry = new Quaternion();
// Scratch for the parent-local↔world carry conversion in transportMU.
const _scratchVecA = new Vector3();
const _scratchQuatA = new Quaternion();
const _scratchQuatB = new Quaternion();
// Scratch for the rotation-aware AABB-extent recompute in updateAABB().
const _aabbQuat = new Quaternion();
const _aabbRotMat = new Matrix4();
// Lateral belt-centering: world up + scratch cross axis, and the per-tick lerp
// fraction pulling MUs toward the belt's center line (see transportMU).
const WORLD_UP = new Vector3(0, 1, 0);
const _crossAxis = new Vector3();
/** Per-tick lerp fraction pulling MUs toward the belt center line. */
const CENTER_MU_LERP = 0.1;
// Scratch for snapToCenterLine()'s world-direction read.
const _centerLineDir = new Vector3();

// ── Accumulation (plan-255): gap-clamp scratch — pre-allocated, no GC in the
// per-MU transport hot path (single-threaded reuse is safe).
/** SIGNED world move direction (`direction * sign(speed)`) — reversal-safe. */
const _accumDir = new Vector3();
/** Reused candidate buffer for `IAccumulationQuery.queryLeadingMU`. */
const _accumCandidates: (RVMovingUnit | InstancedMovingUnit)[] = [];
/** Contact epsilon (~0.1 mm) subtracted in the clamp so `allowed` stays a
 *  stable 0 at exact contact instead of jittering around the float boundary. */
const ACCUM_CONTACT_EPS = 1e-4;

/**
 * IAccumulationQuery — narrow injection seam for the MU-accumulation gap clamp
 * (plan-255). Implemented by `RVTransportManager`, which injects itself into
 * every registered surface's `accumulationProvider`. Defined HERE (not in the
 * manager module) so the surface never imports the manager — the manager
 * already imports the surface, and a reverse import would be a cycle.
 *
 * Without a provider (`accumulationProvider === null`) `transportMU()` behaves
 * exactly as before the feature existed — standalone call sites (unit tests,
 * tools) need no manager and no changes.
 */
export interface IAccumulationQuery {
  /**
   * Collect candidate MUs ahead of `mu` along `moveDir` (world, unit, SIGNED
   * move direction) within `lookahead` metres beyond the MU's AABB, into the
   * caller-owned `out` scratch array (reused, never reallocated). Self,
   * `markedForRemoval` and gripped MUs are already filtered out; all geometric
   * filtering (in-front projection, lateral lane overlap, gap) is the caller's.
   * Returns the candidate count.
   */
  queryLeadingMU(
    mu: RVMovingUnit | InstancedMovingUnit,
    moveDir: Vector3,
    lookahead: number,
    out: (RVMovingUnit | InstancedMovingUnit)[],
  ): number;
}

/** Identity-matrix element pattern (column-major), used by `matrixIsIdentity`. */
const _identityElements = new Matrix4().elements;
const MATRIX_EPS = 1e-6;
/** True when every element of `m` is within ε of the identity matrix. */
function matrixIsIdentity(m: Matrix4): boolean {
  const e = m.elements;
  for (let i = 0; i < 16; i++) {
    if (Math.abs(e[i] - _identityElements[i]) > MATRIX_EPS) return false;
  }
  return true;
}

// Shared geometry/material for transport-surface drop planes. These transient
// planes are NEVER added to the scene (never rendered, never selectable) — they
// are handed to the planner's drop-to-surface raycast as candidate targets so
// objects can be placed on a conveyor top even when it has no solid top mesh.
const _dropPlaneGeometry = new PlaneGeometry(1, 1);
_dropPlaneGeometry.rotateX(-Math.PI / 2); // unit quad, lying flat (normal = +Y)
const _dropPlaneMaterial = new MeshBasicMaterial({ side: DoubleSide });

/**
 * RVTransportSurface - Moves MUs along a direction at the associated Drive's speed.
 *
 * TransportDirection comes from GLB extras (computed by Unity at export time).
 * Speed comes from the associated RVDrive's currentSpeed.
 */
export class RVTransportSurface implements RVComponent {
  // Loaded from the rv-ODT specification (schema/v1/rv-odt.json, plan-187).
  static readonly schema: ComponentSchema = loadSchemaFromSpec('TransportSurface');

  readonly node: Object3D;
  readonly aabb: AABB;
  isOwner = true;

  // Properties — exact C# Inspector field names
  TransportDirection = new Vector3(1, 0, 0);
  Radial = false;
  TextureScale = 1;
  HeightOffsetOverride = 0;
  AnimateSurface = true;
  DriveReference: RVDrive | null = null;
  /** Accumulation (plan-255): when true, MUs on this surface clamp their advance
   *  against the next MU in move direction (no penetration, jam builds up and
   *  releases). Ignored on `Radial` surfaces (v1 exclusion — the radial path
   *  returns before the clamp hook). */
  Accumulate = true;
  /** Minimum front gap in millimetres kept between accumulated MUs. */
  MinGap = 0;

  /** Physics mode (plan-276 Phase 4, F5): when true AND the surface lies FULLY
   *  inside a physics zone, the surface is physics-managed — the provider runs
   *  it as a kinematic conveyor body and MUs on it become dynamic bodies the
   *  moment they enter (friction take-along; jam/stacking simulated physically).
   *  Ignored on `Radial` surfaces (documented v1 exclusion, like `Accumulate`)
   *  and when the deployment kill-switch `physicsDefault` is off. The actual
   *  zone-containment check runs in the physics plugin's world build. */
  PhysicsMode = false;

  /**
   * Global kill-switch for the accumulation clamp (plan-255 §2.8): lets a
   * deployment disable the feature without re-exporting scenes or reverting
   * code (settings.json `simulation.accumulateDefault`, applied at boot in
   * main.ts). The per-surface `Accumulate` flag is ANDed with this — when the
   * switch is off, no surface clamps regardless of its authored value.
   */
  static accumulateDefault = true;

  /**
   * Global kill-switch for the surface physics mode (plan-276 Phase 4, F5 —
   * `accumulateDefault` pattern): settings.json `simulation.physicsSurfaceDefault`,
   * applied at boot in main.ts. The per-surface `PhysicsMode` flag is ANDed
   * with this — when the switch is off, every surface stays kinematic
   * regardless of its authored value. Independent of the zone-level
   * `simulation.physicsEnabled` gate (which turns off ALL physics).
   */
  static physicsDefault = true;

  /**
   * Effective surface physics gate (plan-276 §2.3):
   * `PhysicsMode && RVTransportSurface.physicsDefault && zone.containsAABB(surface)`.
   * FULL containment, never overlap — belts are never cut by a zone boundary
   * (§2.4). Called by the physics plugin during the world build with each
   * active zone; `Radial` surfaces are excluded there (v1) with a warning.
   */
  isPhysicsManaged(zone: { containsAABB(aabb: PhysicsAABB): boolean }): boolean {
    return this.PhysicsMode && RVTransportSurface.physicsDefault && zone.containsAABB(this.aabb);
  }

  /**
   * Injected by `RVTransportManager` when the surface is registered (see the
   * per-tick surface loop in `update()`). Null for standalone `transportMU()`
   * call sites (unit tests) — then the gap clamp is skipped entirely and the
   * legacy behavior is preserved.
   */
  accumulationProvider: IAccumulationQuery | null = null;

  /** Raw Unity local transport direction for UV animation (before coordinate conversion) */
  rawLocalDir: { x: number; y: number; z: number } = { x: 1, y: 0, z: 0 };

  /** Associated drive (provides speed). Found during scene loading. */
  drive: RVDrive | null = null;

  /**
   * Local transport axis — source of truth. Captured at `init()` from the
   * authored `TransportDirection` (Unity-coords) and NEVER mutated afterwards.
   * The current world direction is derived from this every tick.
   */
  private localDirection = new Vector3(1, 0, 0);
  /**
   * Normalized transport direction in WORLD space — derived from
   * `localDirection × node.getWorldQuaternion()`, refreshed once per tick (or
   * on demand). Stale between `init()` and the first `_refreshWorldDirection()`
   * call within a tick — callers must go through `transportMU()` which
   * refreshes lazily, or call `_refreshWorldDirection()` explicitly.
   */
  private direction = new Vector3();
  /** Last tickId for which `direction` was refreshed (manager bumps this). */
  private _directionTickId = -1;
  /** Rotation axis for radial transport */
  private rotationAxis = new Vector3();

  // ── Per-tick world-matrix delta — carries MUs along with a rotating platform.
  /** Snapshot of `node.matrixWorld` at the end of the previous tick. */
  private _lastWorldMatrix = new Matrix4();
  /** `currentWorldMatrix * _lastWorldMatrix^-1` — the world transform applied
   *  to the surface between the previous and current tick. Identity when the
   *  surface didn't move (the common case for static conveyors). */
  private _matrixDelta = new Matrix4();
  /** Quaternion extracted from `_matrixDelta` — applied to MU orientation. */
  private _deltaQuat = new Quaternion();
  /** Whether `_matrixDelta` is non-identity within ε (i.e. carry the MU). */
  private _hasTransformDelta = false;
  /** True once we have a previous-tick matrix to diff against. */
  private _lastMatrixCaptured = false;

  /**
   * Belt half-extents in the node's LOCAL frame (pose-independent), captured
   * once at `init()`. `updateAABB()` re-derives the world-axis-aligned half-size
   * from this every tick, so the collision footprint follows the node's CURRENT
   * rotation — both while a parent drive spins the platform AND when the AABB
   * was first built at the wrong pose (the reload path constructs the surface
   * before the saved rotation is applied). Null when the subtree has no mesh
   * geometry (collider-only sinks), in which case the static halfSize is kept.
   */
  private _localHalfExtents: Vector3 | null = null;

  /**
   * Whether this surface belongs to a placed library object (a `LayoutObject`
   * rv-extra marker sits on the node or any ancestor). Only library belts
   * (conveyor, turntable, chain transfer) pull their MUs onto the belt centre
   * line; conveyors authored directly in the scene transport MUs without lateral
   * correction. Captured once at `init()` — the planner stamps the `LayoutObject`
   * marker before `processExtras` constructs this component, so it is reliably
   * present by the time we look.
   */
  private _belongsToLibraryObject = false;

  /** Cloned textures for independent conveyor belt animation */
  private _texMaps: Texture[] = [];
  /** Raw Unity local direction X component for UV animation */
  private _uvDirX = 0;
  /** Raw Unity local direction Z component for UV animation */
  private _uvDirZ = 0;
  /** Raw Unity local direction Y component for radial UV direction sign */
  private _uvDirY = 0;
  /** Accumulated radial texture offset (wraps to avoid precision loss) */
  private _radialOffsetX = 0;

  // ── Selection-gizmo state (managed by our own selection subscription) ──
  /** Blue edge outline around the top face of the surface while selected.
   *  Lives under `this.node` so it follows the asset's transform. */
  private _selTopSurface: LineSegments | null = null;
  /** Flat direction arrow lying on the top surface. Lives under `this.node`. */
  private _selArrow: Mesh | null = null;
  /** Captured at init() so we can build the gizmo without the full context. */
  private _selGizmoMgr: GizmoOverlayManager | null = null;
  /** Unsubscribe handle for the direct 'selection-changed' subscription. */
  private _selUnsub: (() => void) | null = null;
  /** Whether this surface is currently implied by the selection (plan-250: so
   *  the overlay-visibility toggle can re-show/hide the gizmo without a reselect). */
  private _selSelected = false;
  /** Unsubscribe from the overlay-visibility store (plan-250). */
  private _selCatUnsub: (() => void) | null = null;
  /** Captured registry — maps selection paths back to nodes and lets the gizmo
   *  detect nested transport-surface nodes (to prune them from its bounds). */
  private _selRegistry: {
    getNode(path: string): Object3D | null | undefined;
    getByPath?<T = unknown>(type: string, path: string): T | null;
    getPathForNode?(node: Object3D): string | null;
  } | null = null;

  constructor(node: Object3D, aabb: AABB) {
    this.node = node;
    this.aabb = aabb;
  }

  /** Reusable quaternion for world-space direction transform */
  private static _worldQuat = new Quaternion();

  /**
   * Transform transport direction to world space, resolve drive, initialize transport.
   * Called after applySchema + resolveComponentRefs.
   */
  /** Capture the LOCAL transport axis from the (Unity→Three converted)
   *  `TransportDirection` config. Source of truth for per-tick world-direction
   *  derivation; safe to re-run after a live edit. */
  private _deriveLocalDirection(): void {
    this.localDirection.copy(this.TransportDirection).normalize();
    if (this.localDirection.lengthSq() === 0) this.localDirection.set(1, 0, 0);
  }

  /** Re-derive runtime state after an inspector edit re-applied the schema.
   *  IMPLEMENTS RVComponent::reapplyConfig */
  reapplyConfig(): void {
    this._deriveLocalDirection();
    this._refreshWorldDirection();
  }

  init(context: ComponentContext): void {
    // Capture the LOCAL transport axis as the source of truth — derived per
    // tick from this × the node's CURRENT world quaternion, so MUs keep moving
    // along the belt even when a parent drive rotates the platform.
    this._deriveLocalDirection();

    // Seed `this.direction` (world) immediately so consumers that don't go
    // through `transportMU` (gizmo, debug logs) see a sensible value at init.
    this._refreshWorldDirection();

    // Capture the belt's half-extents in NODE-LOCAL space (pose-independent) so
    // `updateAABB()` can keep the collision footprint aligned with the surface's
    // CURRENT world rotation. Without this, a turntable platform that rotates 90°
    // (or a surface whose AABB was built before its reload rotation was applied)
    // keeps a stale axis-aligned footprint and goods fail to hand off at the seam.
    this.node.updateMatrixWorld(true);
    const localBox = this._computeLocalAABB();
    if (localBox) {
      this._localHalfExtents = localBox.getSize(new Vector3()).multiplyScalar(0.5);
      localBox.getCenter(this.aabb.localCenter); // keep centre consistent with the local extents
    }

    // Lateral belt-centering is LIBRARY-ONLY: a placed library object (conveyor,
    // turntable, chain transfer) pulls its MUs onto the centre line; a conveyor
    // authored directly in the scene must not. Resolve once here — the planner
    // stamps the LayoutObject marker before this component is constructed.
    this._belongsToLibraryObject = this._isUnderLibraryObject();

    // Initialize transport internals (radial, texture animation)
    this.initTransport();

    // Find associated drive: DriveReference first (explicit ref resolved by resolveComponentRefs),
    // then parent hierarchy walk-up
    if (this.DriveReference) {
      this.drive = this.DriveReference;
    }
    if (!this.drive) {
      this.drive = context.registry.findInParent<RVDrive>(this.node, 'Drive');
    }
    if (!this.drive) {
      console.warn(`  TransportSurface "${this.node.name}": no Drive found - will not transport`);
    }

    // Mark drive as transport surface drive (matches Unity's _istransportsurface flag).
    // This is used by multiuser sync to distinguish conveyor drives from positioning drives.
    if (this.drive) {
      this.drive.isTransportSurface = true;
    }

    // Stash a reference to the GizmoOverlayManager + node registry so the
    // selection-gizmo logic can build the visualisation without holding
    // the full context.
    this._selGizmoMgr = context.gizmoManager ?? null;
    this._selRegistry = context.registry;

    // Subscribe to selection events DIRECTLY. We can't use the standard
    // `onSelect(selected)` lifecycle hook here because the
    // ComponentEventDispatcher honours only ONE component per node
    // (first-writer wins — see `_rvComponentInstance` in
    // rv-component-registry.ts). Since auto-bound library assets place
    // both `Drive` AND `TransportSurface` on the same node (Transport-Z),
    // the Drive grabs the slot and our `onSelect` would never fire. The
    // direct subscription side-steps that limitation.
    if (context.events) {
      this._selUnsub = context.events.on('selection-changed', (snap) => {
        const nowSelected = this._isSurfaceImpliedBySelection(snap.selectedPaths ?? []);
        if (nowSelected === this._selSelected) return;
        this._selSelected = nowSelected;
        if (nowSelected) this._showSelectionGizmo();
        else this._hideSelectionGizmo();
      });
    }
    // Overlay-visibility gate (plan-250): the selection gizmo belongs to the
    // 'highlights' category. Re-show/hide it when the user toggles the category.
    this._selCatUnsub = subscribeOverlayVisibility(() => {
      if (!this._selSelected) return;
      if (isOverlayVisible('highlights')) this._showSelectionGizmo();
      else this._hideSelectionGizmo();
    });

    // Register in transport manager
    context.transportManager.surfaces.push(this);

    debug('transport',
      `TransportSurface: ${this.node.name}` +
      ` dir=(${this.TransportDirection.x.toFixed(2)}, ${this.TransportDirection.y.toFixed(2)}, ${this.TransportDirection.z.toFixed(2)})` +
      ` radial=${this.Radial}` +
      (this.drive ? ` drive=${this.drive.name} jogFwd=${this.drive.jogForward}` : ' NO DRIVE')
    );
  }

  /**
   * Whether the current selection should reveal this surface's gizmo. The
   * surface is shown when it sits on the SAME branch as a selected node:
   * either a selected ancestor contains this surface (the common case — the
   * conveyor click resolves to the parent Drive node, which is an ancestor of
   * the child surface node), or a selected child mesh lives under this surface.
   */
  private _isSurfaceImpliedBySelection(paths: readonly string[]): boolean {
    for (const p of paths) {
      const selNode = this._selRegistry?.getNode(p);
      if (!selNode) continue;
      // Selected a parent: the surface is at-or-below the selected node.
      if (this._isAncestorOrSelf(selNode, this.node)) return true;
      // Selected a child mesh: the selection is at-or-below the surface.
      if (this._isAncestorOrSelf(this.node, selNode)) return true;
    }
    return false;
  }

  /** True if `ancestor` is `node` itself or any of its parents. */
  private _isAncestorOrSelf(ancestor: Object3D, node: Object3D): boolean {
    let cur: Object3D | null = node;
    while (cur) {
      if (cur === ancestor) return true;
      cur = cur.parent;
    }
    return false;
  }

  /**
   * True when a `LayoutObject` rv-extra marker sits on this surface node or any
   * ancestor — i.e. the surface is part of a placed library object. This is the
   * same canonical marker `BehaviorManager.isLayoutObjectRoot` keys off; it lives
   * only on the placed asset's root, so we walk the parent chain to find it.
   */
  private _isUnderLibraryObject(): boolean {
    let cur: Object3D | null = this.node;
    while (cur) {
      const rv = cur.userData?.realvirtual as Record<string, unknown> | undefined;
      if (rv && rv.LayoutObject) return true;
      cur = cur.parent;
    }
    return false;
  }

  /**
   * Selection-driven visualisation: a wireframe AABB box plus a cyan
   * direction arrow at the AABB centre, both rendered always-on-top and
   * opt-out of raycasting so they never steal hover/click.
   *
   * Subscription is installed in `init()` directly on the viewer event bus
   * (see comment there for why we bypass the standard `onSelect` lifecycle
   * hook). Cleaned up in `dispose()`.
   */
  dispose(): void {
    this._hideSelectionGizmo();
    if (this._selUnsub) { this._selUnsub(); this._selUnsub = null; }
    if (this._selCatUnsub) { this._selCatUnsub(); this._selCatUnsub = null; }
  }

  private _showSelectionGizmo(): void {
    this._hideSelectionGizmo();
    if (!this._selGizmoMgr) return;
    if (!isOverlayVisible('highlights')) return; // 'highlights' category off (plan-250)

    // Blue edge outline around the TOP face of the surface's bounding box.
    // Built in the node's LOCAL frame and parented to `this.node`, so it
    // follows (and rotates with) the asset.
    this.node.updateMatrixWorld(true);
    // Gizmo bounds EXCLUDE nested transport surfaces, so a parent surface's
    // gizmo reflects only its own belt (collision AABB is untouched).
    const localBox = this._computeGizmoAABB();
    if (!localBox || localBox.isEmpty()) return;
    const lmin = localBox.min;
    const lmax = localBox.max;
    const cx = (lmin.x + lmax.x) / 2;
    const cz = (lmin.z + lmax.z) / 2;
    {
      const sx = Math.max(lmax.x - lmin.x, 1e-4);
      const sz = Math.max(lmax.z - lmin.z, 1e-4);
      const planeGeo = new PlaneGeometry(sx, sz);
      planeGeo.rotateX(-Math.PI / 2); // lie flat in the local XZ plane (normal = +Y)
      // Edges only (no filled overlay) — EdgesGeometry of a quad yields just the
      // 4 border segments (the shared diagonal is coplanar and dropped).
      const geo = new EdgesGeometry(planeGeo);
      planeGeo.dispose(); // EdgesGeometry copied the positions; source no longer needed
      const mat = new LineBasicMaterial({
        color: 0x8ec5ff,         // light blue
        transparent: true,
        opacity: 0.6,
        depthTest: false,
        depthWrite: false,
      });
      const surf = new LineSegments(geo, mat);
      surf.position.set(cx, lmax.y, cz);
      surf.renderOrder = 2001;
      surf.userData._highlightOverlay = true;
      surf.raycast = () => { /* never a click target */ };
      this.node.add(surf);
      this._selTopSurface = surf;
    }

    // ── Flat block arrow lying on the top face, pointing along the belt. ──
    // Use the surface's LOCAL transport axis directly — the arrow sits under
    // `this.node` and inherits its world transform, so the local axis is
    // exactly the right input. This is what keeps the gizmo glued to the
    // belt's true direction even after a parent drive rotates the platform.
    const localDir = this.localDirection.clone();
    if (localDir.lengthSq() === 0) localDir.copy(this.TransportDirection);
    if (localDir.lengthSq() === 0) return;
    localDir.normalize();

    // Project onto the local XZ plane (the arrow lies flat). Skip when the
    // transport is (near-)vertical — a flat arrow would be meaningless.
    const dx = localDir.x;
    const dz = localDir.z;
    const dlen = Math.hypot(dx, dz);
    if (dlen < 1e-4) return;
    const ndx = dx / dlen;
    const ndz = dz / dlen;

    // Fixed 0.5 m arrow in WORLD space. The arrow is parented to `this.node`,
    // so its size is interpreted in node-local units — divide by the node's
    // world scale along the arrow direction so it renders at a true 0.5 m
    // regardless of any scale baked into the surface (e.g. library placements).
    const ARROW_WORLD_LENGTH = 0.5; // metres
    const ws = new Vector3();
    this.node.getWorldScale(ws);
    const scaleAlongDir = Math.hypot(ws.x * ndx, ws.z * ndz) || 1;
    const L = ARROW_WORLD_LENGTH / scaleAlongDir;

    const arrow = new Mesh(this._buildArrowGeometry(L), new MeshBasicMaterial({
      color: 0x33b5ff,           // bright blue
      transparent: true,
      opacity: 0.6,
      side: DoubleSide,
      depthTest: false,
      depthWrite: false,
    }));
    // Aim local +X along the (XZ-projected) transport direction. A +Y rotation
    // by φ maps +X → (cosφ, 0, -sinφ), so φ = atan2(-dz, dx).
    arrow.rotation.y = Math.atan2(-ndz, ndx);
    // Sit just above the belt top so it never z-fights with the surface.
    const eps = Math.max(lmax.y - lmin.y, 1e-3) * 0.02 + 1e-4;
    arrow.position.set(cx, lmax.y + eps, cz);
    arrow.renderOrder = 2002;
    arrow.userData._highlightOverlay = true;
    arrow.raycast = () => { /* never a click target */ };
    this.node.add(arrow);
    this._selArrow = arrow;
  }

  /**
   * Flat block-arrow geometry of total length `L`, pointing +X and lying in the
   * local XZ plane (normal +Y). Classic wide silhouette — rectangular shaft
   * tipped by a triangular head — with softly ROUNDED corners for a modern look.
   * Centred on the origin along its length.
   */
  private _buildArrowGeometry(L: number): ShapeGeometry {
    const headLen = L * 0.42;
    const shaftLen = L - headLen;
    const halfShaft = L * 0.18 * 0.5; // shaft width ≈ 0.18·L (slimmer)
    const halfHead = L * 0.46 * 0.5;  // head  width ≈ 0.46·L (slimmer)
    const x0 = -L / 2;                // tail
    const xShaft = x0 + shaftLen;     // shaft → head transition
    const xTip = L / 2;               // tip

    // CCW outline (7 corners): tail-bottom → shaft → barb → tip → barb → shaft → tail-top.
    const pts = [
      new Vector2(x0, -halfShaft),
      new Vector2(xShaft, -halfShaft),
      new Vector2(xShaft, -halfHead),
      new Vector2(xTip, 0),
      new Vector2(xShaft, halfHead),
      new Vector2(xShaft, halfShaft),
      new Vector2(x0, halfShaft),
    ];

    const shape = this._roundedShape(pts, L * 0.07); // fillet radius ≈ 7% of length
    const geo = new ShapeGeometry(shape, 16);        // 16 segments per fillet → smooth arcs
    geo.rotateX(-Math.PI / 2);                       // XY shape → flat in XZ (still points +X)
    return geo;
  }

  /**
   * Build a closed `Shape` from an ordered polygon with each corner rounded by a
   * quadratic fillet of radius `r` (clamped per-corner so it never overruns a
   * short edge). The corner vertex is the curve's control point.
   */
  private _roundedShape(points: Vector2[], r: number): Shape {
    const s = new Shape();
    const n = points.length;
    const vPrev = new Vector2();
    const vNext = new Vector2();
    const before = new Vector2();
    const after = new Vector2();
    for (let i = 0; i < n; i++) {
      const prev = points[(i - 1 + n) % n];
      const curr = points[i];
      const next = points[(i + 1) % n];
      vPrev.subVectors(prev, curr);
      vNext.subVectors(next, curr);
      const rEff = Math.min(r, vPrev.length() * 0.5, vNext.length() * 0.5);
      before.copy(curr).addScaledVector(vPrev.normalize(), rEff);
      after.copy(curr).addScaledVector(vNext.normalize(), rEff);
      if (i === 0) s.moveTo(before.x, before.y);
      else s.lineTo(before.x, before.y);
      s.quadraticCurveTo(curr.x, curr.y, after.x, after.y);
    }
    s.closePath();
    return s;
  }

  private _hideSelectionGizmo(): void {
    if (this._selTopSurface) {
      this._selTopSurface.parent?.remove(this._selTopSurface);
      this._selTopSurface.geometry.dispose();
      (this._selTopSurface.material as LineBasicMaterial).dispose();
      this._selTopSurface = null;
    }
    if (this._selArrow) {
      this._selArrow.parent?.remove(this._selArrow);
      this._selArrow.geometry.dispose();
      (this._selArrow.material as MeshBasicMaterial).dispose();
      this._selArrow = null;
    }
  }

  /** True if `node` (a descendant of `this.node`) carries its own
   *  TransportSurface component — i.e. it's a NESTED surface to prune. */
  private _isNestedSurfaceNode(node: Object3D): boolean {
    const reg = this._selRegistry;
    if (!reg?.getPathForNode || !reg.getByPath) return false;
    const path = reg.getPathForNode(node);
    return path ? reg.getByPath('TransportSurface', path) != null : false;
  }

  /** True if `node` carries a Sensor component. A sensor parented under the
   *  surface BELONGS to it, so its (and its children's) geometry must not bloat
   *  the belt footprint. The marker is written by the naming-convention scan
   *  (`applyKinematicsSpec`) before any component `init`, so it is already
   *  present when the collision AABB is built — no registry lookup needed. */
  private _isSensorNode(node: Object3D): boolean {
    return node.userData?.realvirtual?.Sensor != null;
  }

  /** Baked geometry duplicates created by the raycast-BVH / merge passes
   *  (`__raycastBVH_*`, `__kinGroupMerge_*`, static-uber merges). They bundle the
   *  WHOLE drive subtree — including the sensor — into one child of the surface,
   *  so counting them would re-add the sensor geometry the sensor-prune already
   *  removed. The original source meshes (hidden by the merge, but with geometry
   *  intact) are still traversed, so the real belt bounds are unaffected. These
   *  helpers are built AFTER init, so excluding them also makes the bounds
   *  order-independent (correct whether computed before or after those passes). */
  private _isBakedHelper(node: Object3D): boolean {
    const ud = node.userData;
    return !!(ud && (ud._rvRaycastBVH || ud._rvBatchedRender));
  }

  /** Accumulate the local-frame AABB of all mesh descendants, PRUNING any
   *  subtree whose root satisfies `prune` or is a baked grouping helper (the
   *  surface node itself is never pruned). Returns null if no mesh geometry found. */
  private _accumulateLocalAABB(prune: (obj: Object3D) => boolean): Box3 | null {
    const box = new Box3();
    const invNode = new Matrix4().copy(this.node.matrixWorld).invert();
    const m = new Matrix4();
    const tmp = new Box3();
    let found = false;
    const visit = (obj: Object3D) => {
      if (obj !== this.node && (this._isBakedHelper(obj) || prune(obj))) return; // skip this subtree
      const mesh = obj as Mesh;
      if (mesh.isMesh && mesh.geometry) {
        if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
        const gb = mesh.geometry.boundingBox;
        if (gb) {
          m.multiplyMatrices(invNode, mesh.matrixWorld);
          tmp.copy(gb).applyMatrix4(m);
          box.union(tmp);
          found = true;
        }
      }
      for (const c of obj.children) visit(c);
    };
    visit(this.node);
    return found ? box : null;
  }

  /** Like `_computeLocalAABB` but ALSO prunes nested transport-surface subtrees,
   *  so the selection gizmo of a parent surface reflects only its own belt
   *  (child sensors are excluded by both, keeping gizmo and collision in sync). */
  private _computeGizmoAABB(): Box3 | null {
    return this._accumulateLocalAABB(
      (o) => this._isSensorNode(o) || this._isNestedSurfaceNode(o),
    );
  }

  /** AABB of all mesh descendants expressed in `this.node`'s LOCAL frame, with
   *  child-sensor subtrees excluded (a sensor under the surface belongs to it
   *  and must not inflate the belt footprint). Returns null if no mesh geometry
   *  was found. Nested transport surfaces are intentionally still included here
   *  (the collision footprint, unlike the gizmo, keeps them). */
  private _computeLocalAABB(): Box3 | null {
    return this._accumulateLocalAABB((o) => this._isSensorNode(o));
  }

  /**
   * Build a transient horizontal drop-target plane at the TOP of this surface's
   * AABB, in WORLD space. Used by the planner's drop-to-surface so objects can
   * be placed on the conveyor top even when the surface has no solid top mesh
   * (e.g. an AABB-only / virtual conveyor). The returned mesh is NOT added to
   * the scene — it is only a raycast candidate for the duration of a drag.
   * Returns null for a degenerate (zero-area) footprint.
   */
  createDropPlane(): Mesh | null {
    this.aabb.update();
    const min = this.aabb.min;
    const max = this.aabb.max;
    const sx = max.x - min.x;
    const sz = max.z - min.z;
    if (!Number.isFinite(sx) || !Number.isFinite(sz) || sx <= 1e-4 || sz <= 1e-4) return null;
    const plane = new Mesh(_dropPlaneGeometry, _dropPlaneMaterial);
    plane.position.set((min.x + max.x) / 2, max.y, (min.z + max.z) / 2);
    plane.scale.set(sx, 1, sz);
    plane.userData._rvDropSurface = true;
    // Back-reference so a drop raycast hit can recover this surface (e.g. the
    // planner's lateral snap-to-centre when an object lands on the belt).
    plane.userData._rvDropSurfaceInstance = this;
    plane.updateMatrixWorld(true);
    return plane;
  }

  /**
   * Initialize transport after properties are set (direction, radial, texture animation).
   * Called by the loader after applySchema + quaternion transform.
   */
  initTransport(): void {
    // Note: `this.direction` (world) is already seeded by `init()` via
    // `_refreshWorldDirection()`. We DO NOT mutate it from
    // `TransportDirection` here — `TransportDirection` is the LOCAL axis
    // (Unity-coords) and overwriting `direction` from it would clobber the
    // world-space derivation. The radial axis stays in WORLD space for
    // consistency with `transportMURadial`'s coordinate frame.
    if (this.Radial) {
      this.rotationAxis.copy(this.direction);
    }

    // Texture animation setup
    if (this.AnimateSurface !== false) {
      this._uvDirX = this.rawLocalDir?.x ?? 0;
      this._uvDirY = this.rawLocalDir?.y ?? 0;
      this._uvDirZ = this.rawLocalDir?.z ?? 0;
      this._initTextureAnimation();
    }
  }

  /**
   * Restore the belt to its freshly-loaded look for a fresh run
   * (`resetSimulation()` via `RVTransportManager.reset()`): rewind the scrolled
   * conveyor textures + the radial accumulator to 0, and drop the per-tick
   * world-matrix delta tracking so a platform that moved (turntable) doesn't
   * carry MUs by a stale delta on the first tick after the reset. The associated
   * Drive's speed/position is reset separately by `RVDrive.reset()`.
   */
  reset(): void {
    for (const tex of this._texMaps) tex.offset.set(0, 0);
    this._radialOffsetX = 0;
    this._lastMatrixCaptured = false;
    this._hasTransformDelta = false;
    this._matrixDelta.identity();
    this._deltaQuat.identity();
  }

  /** Current transport speed in mm/s from the associated Drive */
  get speed(): number {
    if (!this.drive) return 0;
    // Use drive's actual current speed (respects acceleration ramps)
    return this.drive.currentSpeed;
  }

  /** Is the surface actively transporting? (either direction — a reversed belt
   *  has negative speed but is still moving). */
  get isActive(): boolean {
    return this.drive != null && this.speed !== 0;
  }

  /** Authoritative current runtime value for UI display (live source of truth). */
  getLiveState(): Record<string, unknown> {
    return { Speed: this.speed };
  }

  /**
   * Move a MU along the transport direction.
   * Linear transport: direct position offset (+ optional carry by the surface's
   * own world-transform delta when the platform itself moved between ticks —
   * e.g. a turntable rotating under the MU).
   */
  transportMU(mu: RVMovingUnit | InstancedMovingUnit, dt: number): void {
    // Refresh per-tick state (world direction + world-matrix delta) once per
    // tick. Multiple MUs on the same surface share one compute.
    this._refreshWorldDirectionLazy();

    if (this.Radial) {
      // Radial surfaces explicitly rotate MUs around the surface centre —
      // don't ALSO carry by `_matrixDelta` here or we'd double-rotate.
      this.transportMURadial(mu, dt);
      return;
    }

    // Carry the MU along with the surface's own world transform when:
    //   1. The surface actually moved this tick (`_hasTransformDelta`), AND
    //   2. The MU was already on THIS surface in the immediately previous tick
    //      (`lastSurfaceTickId === currentTickId - 1` AND `mu.currentSurface === this`)
    //      — so a freshly-entered MU isn't snapped by a phantom delta.
    if (
      this._hasTransformDelta &&
      mu.currentSurface === this &&
      mu.lastSurfaceTickId === RVTransportSurface._currentTickId - 1
    ) {
      // `mu.getPosition()` / `mu.getQuaternion()` return values in the MU's
      // PARENT-local frame for clone MUs (Source spawns under `spawnParent`,
      // which can itself be a transformed LayoutObject). For instanced MUs
      // the position is world-space, and `getPosition()` returns a temp —
      // we must round-trip via `setPosition` for the write to land in the
      // pool's Float32Array. Either way we drive both via the IMUAccessor's
      // explicit setters: read into scratch, transform, write back.
      const muNode: Object3D | null = (mu as RVMovingUnit).node ?? null;
      const muParent: Object3D | null = (muNode && !(mu as { isInstanced?: boolean }).isInstanced)
        ? muNode.parent
        : null;
      if (muParent) {
        // Clone MU under a (possibly transformed) parent. Convert local→world,
        // apply world-space delta, convert world→local, write via setPosition.
        _scratchVecA.copy(mu.getPosition());
        muParent.localToWorld(_scratchVecA);
        _scratchVecA.applyMatrix4(this._matrixDelta);
        muParent.worldToLocal(_scratchVecA);
        mu.setPosition(_scratchVecA);

        // ORIENTATION: world = parentWorld * local. After carry:
        //   newWorld = delta * world  →  newLocal = parentWorld^-1 * delta * parentWorld * local
        muParent.getWorldQuaternion(_scratchQuatA);             // parentWorld
        _scratchQuatB.copy(_scratchQuatA).invert();             // parentWorld^-1
        _scratchQuatB.multiply(this._deltaQuat).multiply(_scratchQuatA).multiply(mu.getQuaternion());
        mu.setQuaternion(_scratchQuatB);
      } else {
        // Scene-root parented (clone with no parent set yet, or instanced MU
        // whose pool positions are already in world space). Carry in world.
        _scratchVecA.copy(mu.getPosition()).applyMatrix4(this._matrixDelta);
        mu.setPosition(_scratchVecA);
        mu.setQuaternion(_quatCarry.copy(this._deltaQuat).multiply(mu.getQuaternion()));
      }
    }

    // Linear transport: position += direction * speed * dt
    // Speed is in mm/s, Three.js positions are in meters -> divide by MM_TO_METERS
    const speedM = this.speed / MM_TO_METERS;
    if (speedM !== 0 && dt !== 0) {
      // Signed decomposition: `sgn * moveDist` ≡ `speedM * dt`. The accumulation
      // clamp below shortens `moveDist` (never flips it), so a clamped MU stops
      // instead of tunneling — and the SIGNED direction makes a reversed belt
      // (negative speed) clamp against the MU BEHIND it (F5a, reversal-safe).
      const sgn = Math.sign(speedM);
      let moveDist = Math.abs(speedM) * dt;

      // ── Accumulation gap clamp (plan-255) ─────────────────────────────
      // Clamp the advance to the free distance up to the next MU ahead in the
      // actual move direction. Position-only (immune to forced drive signals),
      // computed from candidate AABBs (never `candidate.getPosition()` — the
      // InstancedMovingUnit pool shares ONE temp vector across all instances).
      // The query reads last tick's grid/AABB state (manager step 4 runs after
      // transport) — conservatively safe: the leader only ever moves AWAY.
      // Radial surfaces never reach this hook (transportMURadial returned above).
      if (
        this.Accumulate &&
        RVTransportSurface.accumulateDefault &&
        this.accumulationProvider !== null
      ) {
        _accumDir.copy(this.direction).multiplyScalar(sgn);
        const minGapM = this.MinGap / MM_TO_METERS;
        const muA = mu.aabb;
        // Projected AABB half-extent of the moving MU along the move direction
        // (|dir.x|·halfX + |dir.z|·halfZ) — valid for arbitrarily rotated belts.
        const muHalfAlong =
          Math.abs(_accumDir.x) * muA.halfSize.x + Math.abs(_accumDir.z) * muA.halfSize.z;
        // Lateral half-extent perpendicular to the move direction (XZ plane).
        const muHalfLat =
          Math.abs(_accumDir.z) * muA.halfSize.x + Math.abs(_accumDir.x) * muA.halfSize.z;
        // Query window: this tick's travel + own half-extent + gap (covers
        // tunneling — a leader within reach this substep is always found).
        const lookahead = moveDist + muHalfAlong + minGapM;
        const n = this.accumulationProvider.queryLeadingMU(mu, _accumDir, lookahead, _accumCandidates);

        let minFrontGap = Infinity;
        for (let i = 0; i < n; i++) {
          const ca = _accumCandidates[i].aabb;
          const dx = ca.center.x - muA.center.x;
          const dz = ca.center.z - muA.center.z;
          // 1D projection along the SIGNED move direction — only MUs in front.
          const proj = dx * _accumDir.x + dz * _accumDir.z;
          if (proj <= 0) continue;
          // Lateral lane test QUER to the move direction (of the MOVING MU):
          // no cross-track AABB overlap → parallel lane, never blocks.
          const lat = dx * -_accumDir.z + dz * _accumDir.x;
          const caHalfLat =
            Math.abs(_accumDir.z) * ca.halfSize.x + Math.abs(_accumDir.x) * ca.halfSize.z;
          if (Math.abs(lat) >= muHalfLat + caHalfLat) continue;
          const caHalfAlong =
            Math.abs(_accumDir.x) * ca.halfSize.x + Math.abs(_accumDir.z) * ca.halfSize.z;
          const frontGap = proj - muHalfAlong - caHalfAlong;
          // Pre-existing overlap (spawn/legacy scene): IGNORE the candidate —
          // only NEW penetration is prevented; the pair frees itself by driving
          // apart (F5b, no permanent deadlock, no push-back).
          if (frontGap < 0) continue;
          if (frontGap < minFrontGap) minFrontGap = frontGap;
        }

        if (minFrontGap !== Infinity) {
          const allowed = Math.max(0, minFrontGap - minGapM - ACCUM_CONTACT_EPS);
          mu.blocked = allowed < moveDist;
          if (mu.blocked) moveDist = allowed;
        }
      }

      _movement.copy(this.direction).multiplyScalar(sgn * moveDist);
      // Use the explicit get-mutate-set round-trip (matching the carry path above):
      // `getPosition()` returns the live `node.position` reference for clone MUs but
      // a shared TEMP Vector3 for instanced MUs — mutating that temp in place would
      // be lost on return, freezing instanced MUs on the belt. `setPosition()` writes
      // back into the pool's Float32Array, so both backends advance correctly.
      _scratchVecA.copy(mu.getPosition()).add(_movement);

      // Drag the MU toward the belt's center line (lateral only — keep height &
      // forward progress) — LIBRARY OBJECTS ONLY. Placed library belts (conveyor,
      // turntable, chain transfer) ease their MUs back onto the centre line;
      // scene-authored conveyors leave the MU's lateral position untouched.
      // cross = horizontal axis ⟂ transport direction; the MU is eased back along
      // it by CENTER_MU_LERP each tick so off-centre parts settle to the middle of
      // the belt while moving. `this.aabb.center` is the world-space belt centre,
      // refreshed by updateAABB() earlier this tick.
      if (this._belongsToLibraryObject) {
        _crossAxis.copy(this.direction).cross(WORLD_UP);
        const crossLen = _crossAxis.length();
        if (crossLen > 1e-4) {
          _crossAxis.multiplyScalar(1 / crossLen);
          // Signed lateral offset of the MU from the centre line, then ease back.
          const lateral = _scratchVecA.dot(_crossAxis) - this.aabb.center.dot(_crossAxis);
          _scratchVecA.addScaledVector(_crossAxis, -lateral * CENTER_MU_LERP);
        }
      }

      mu.setPosition(_scratchVecA);
    }
  }

  /** Recompute `this.direction` (world) from `this.localDirection` × current world quaternion. */
  private _refreshWorldDirection(): void {
    this.node.getWorldQuaternion(RVTransportSurface._worldQuat);
    this.direction.copy(this.localDirection).applyQuaternion(RVTransportSurface._worldQuat).normalize();
  }

  /**
   * World-space transport direction (unit vector), recomputed on demand from the
   * authored local axis × the node's current world orientation. Used by topology
   * consumers (e.g. the Turntable classifying connected conveyors as in/out).
   */
  getWorldDirection(out: Vector3 = new Vector3()): Vector3 {
    this._refreshWorldDirection();
    return out.copy(this.direction);
  }

  /**
   * Snap a world-space point onto the belt's lateral centre line — the line
   * through the surface centre running along the transport direction. Only the
   * cross-belt (lateral) offset is removed; the point keeps its along-belt
   * position and its Y. Mutates and returns `point`. Used by the planner to
   * centre objects dropped onto the belt. No-op for a (near-)vertical transport
   * direction (no horizontal centre line exists).
   */
  snapToCenterLine(point: Vector3): Vector3 {
    const dir = this.getWorldDirection(_centerLineDir);
    let dx = dir.x;
    let dz = dir.z;
    const len = Math.hypot(dx, dz);
    if (len < 1e-4) return point;
    dx /= len;
    dz /= len;
    const cx = this.aabb.center.x;
    const cz = this.aabb.center.z;
    // Project the point onto the centre line and drop the perpendicular offset.
    const along = (point.x - cx) * dx + (point.z - cz) * dz;
    point.x = cx + along * dx;
    point.z = cz + along * dz;
    return point;
  }

  /**
   * Refresh once per tick (manager bumps `RVTransportSurface._currentTickId`):
   *   • the world transport direction (used by every MU advance), and
   *   • the world-matrix delta vs. the previous tick (used to carry MUs along
   *     with a rotating/translating platform — e.g. a turntable).
   */
  private _refreshWorldDirectionLazy(): void {
    if (this._directionTickId === RVTransportSurface._currentTickId) return;
    this._directionTickId = RVTransportSurface._currentTickId;

    // Make sure the ancestor chain's matrices are current before snapshotting.
    this.node.updateWorldMatrix(true, false);

    // Refresh world direction from local axis × current world quaternion.
    this._refreshWorldDirection();

    // Compute matrix delta = currentWorldMatrix * lastWorldMatrix^-1.
    if (this._lastMatrixCaptured) {
      _scratchInv.copy(this._lastWorldMatrix).invert();
      this._matrixDelta.multiplyMatrices(this.node.matrixWorld, _scratchInv);
      this._hasTransformDelta = !matrixIsIdentity(this._matrixDelta);
      if (this._hasTransformDelta) {
        // Extract rotation part for orientation carry.
        this._deltaQuat.setFromRotationMatrix(this._matrixDelta);
      } else {
        this._deltaQuat.identity();
      }
    } else {
      this._matrixDelta.identity();
      this._deltaQuat.identity();
      this._hasTransformDelta = false;
      this._lastMatrixCaptured = true;
    }
    this._lastWorldMatrix.copy(this.node.matrixWorld);
  }

  /** Called by `RVTransportManager.update()` at the top of each tick. */
  static beginTick(tickId: number): void {
    RVTransportSurface._currentTickId = tickId;
  }
  static get currentTickId(): number { return RVTransportSurface._currentTickId; }
  private static _currentTickId = 0;

  /**
   * Rotate a MU around the surface center (turntable).
   */
  private transportMURadial(mu: RVMovingUnit | InstancedMovingUnit, dt: number): void {
    // Speed is in degrees/s for rotational drives
    const angleDeg = this.speed * dt;
    const angleRad = MathUtils.degToRad(angleDeg);

    // Get surface center in world space
    const surfacePos = this.node.getWorldPosition(_offset);

    // Offset from surface center to MU
    _movement.copy(mu.getPosition()).sub(surfacePos);
    // Rotate offset around axis
    _movement.applyAxisAngle(this.rotationAxis, angleRad);
    // Apply new position
    _offset.copy(surfacePos).add(_movement);
    mu.setPosition(_offset);

    // Also rotate the MU itself
    mu.rotateOnAxis(this.rotationAxis, angleRad);
  }

  /**
   * Animate conveyor belt texture based on drive speed.
   * Mirrors Unity's TransportSurface.UpdateTextureAnimation().
   */
  updateTextureAnimation(dt: number): void {
    if (this._texMaps.length === 0 || !this.drive || this.speed === 0) return;

    if (this.Radial) {
      this._updateRadialTexture(dt);
    } else {
      this._updateLinearTexture(dt);
    }
  }

  /** Update AABB (call once per frame, before overlap checks).
   *
   *  Re-derives the world axis-aligned half-size from the belt's LOCAL extents
   *  under the node's CURRENT world rotation (`worldHalf_i = Σ_j |R_ij|·localHalf_j`),
   *  so the footprint follows the surface as a parent drive rotates it (turntable
   *  platform) and is correct regardless of the pose the AABB was first built at.
   *  At 0°/180° this is identical to the static footprint (no change for plain
   *  conveyors); at 90° it swaps the long/short axes so handoff to a perpendicular
   *  neighbour works. */
  updateAABB(): void {
    const h = this._localHalfExtents;
    if (h) {
      this.node.getWorldQuaternion(_aabbQuat);
      const e = _aabbRotMat.makeRotationFromQuaternion(_aabbQuat).elements;
      this.aabb.halfSize.set(
        Math.abs(e[0]) * h.x + Math.abs(e[4]) * h.y + Math.abs(e[8]) * h.z,
        Math.abs(e[1]) * h.x + Math.abs(e[5]) * h.y + Math.abs(e[9]) * h.z,
        Math.abs(e[2]) * h.x + Math.abs(e[6]) * h.y + Math.abs(e[10]) * h.z,
      );
    }
    this.aabb.update();
  }

  // ── Texture Animation (private) ──────────────────────────────────

  /**
   * Find mesh children with textures and clone their maps for independent offset control.
   * Mirrors Unity creating material instances for texture animation.
   */
  private _initTextureAnimation(): void {
    let meshCount = 0;
    let texCount = 0;
    traverseMeshes(this.node, (mesh) => {
      meshCount++;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (let i = 0; i < mats.length; i++) {
        const mat = mats[i] as MeshStandardMaterial;
        if (mat.map) {
          // Clone texture to get independent offset (image data stays shared on GPU)
          const tex = mat.map.clone();
          tex.wrapS = RepeatWrapping;
          tex.wrapT = RepeatWrapping;
          tex.needsUpdate = true;
          mat.map = tex;
          this._texMaps.push(tex);
          texCount++;
        }
      }
    });
    if (texCount > 0) {
      debug('transport', `TransportSurface "${this.node.name}": texture animation enabled (${texCount} textures on ${meshCount} meshes, uvDir=(${this._uvDirX.toFixed(2)}, ${this._uvDirZ.toFixed(2)}))`);
    } else {
      debug('transport', `TransportSurface "${this.node.name}": no textures found for animation (${meshCount} meshes, all without map)`);
    }
  }

  /**
   * Linear texture animation: scroll UV based on drive speed and transport direction.
   * Matches Unity: uvOffset = (localDir.x, localDir.z) * TextureScale * dt * speed / Scale
   */
  private _updateLinearTexture(dt: number): void {
    // speed is mm/s, /MM_TO_METERS converts to m/s (matches Unity's /Scale)
    const speedFactor = this.TextureScale * dt * this.speed / MM_TO_METERS;
    // Use raw Unity local direction for UV (UV coords are in Unity space)
    const du = this._uvDirX * speedFactor;
    const dv = this._uvDirZ * speedFactor;

    for (const tex of this._texMaps) {
      tex.offset.x += du;
      tex.offset.y += dv;
    }
  }

  /**
   * Radial texture animation: scroll U based on angular speed.
   * Matches Unity: rotationSpeed = speed/360, offset.x += movement * sign(localDir.y)
   */
  private _updateRadialTexture(dt: number): void {
    // speed is degrees/s for rotational drives
    const rotationSpeed = this.speed / 360; // revolutions per second
    const movement = rotationSpeed * dt;
    const direction = Math.sign(this._uvDirY);

    this._radialOffsetX += movement * direction;
    // Wrap to [0, 1] to avoid float precision loss over long runs
    this._radialOffsetX -= Math.floor(this._radialOffsetX);

    for (const tex of this._texMaps) {
      tex.offset.x = this._radialOffsetX;
    }
  }
}

// Self-register for auto-discovery by scene loader
registerComponent({
  type: 'TransportSurface',
  schema: RVTransportSurface.schema,
  needsAABB: true,
  capabilities: {
    authorable: true,   // addable in the asset editor (schema-complete)
    badgeColor: '#ffa726',
    filterLabel: 'Conveyors',
  },
  create: (node, aabb) => new RVTransportSurface(node, aabb!),
  beforeSchema: (inst, extras) => {
    const rawDir = extras['TransportDirection'] as { x: number; y: number; z: number } | undefined;
    (inst as RVTransportSurface).rawLocalDir = rawDir
      ? { x: rawDir.x, y: rawDir.y, z: rawDir.z } : { x: 1, y: 0, z: 0 };
  },
});
