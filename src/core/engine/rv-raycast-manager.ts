// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * RaycastManager — Unified raycast system for the realvirtual Web Viewer.
 *
 * Uses grouped BVH raycast geometries:
 *   - ONE merged BVH for all static meshes
 *   - ONE merged BVH per kinematic Drive group
 *   - InstancedMesh targets for MU pools
 *
 * Hit resolution uses face-range binary search (O(log n)) instead of
 * ancestor chain walk-up. Only objects with a content-providing ancestor
 * (userData.realvirtual) are included.
 *
 * This class does NOT touch rv-sensor.ts — that remains a separate
 * O(1) physics raycast system.
 */

import {
  Raycaster,
  Vector2,
  Vector3,
  Mesh,
  InstancedMesh,
  Object3D,
} from 'three';
import type { Camera, Intersection, PerspectiveCamera, Scene } from 'three';
import type { NodeRegistry } from './rv-node-registry';
import type { RVHighlightManager } from './rv-highlight-manager';
import type { MUInstancePool, InstancedMovingUnit } from './rv-mu';
import type { PickMetrics } from './rv-pick-metrics';
import {
  resolveHit,
  type RaycastGeometrySet,
  type RaycastGroup,
} from './rv-raycast-geometry';
import { getCapabilities, getTypesWithCapability } from './rv-component-registry';
import { pointerToNDC } from './rv-pointer-utils';

/** Ascending-distance comparator (matches three's internal raycast sort). */
function _byDistance(a: Intersection<Object3D>, b: Intersection<Object3D>): number {
  return a.distance - b.distance;
}

// ─── Public types ───────────────────────────────────────────────────

/** Hoverable node types — now a string alias for backwards compatibility. */
export type HoverableType = string;

/** Data emitted with 'object-hover'. */
export interface ObjectHoverData {
  /** The hovered node (Object3D with realvirtual userData). */
  node: Object3D;
  /** Type of the node (e.g. 'Drive', 'Sensor', 'MU'). */
  nodeType: string;
  /** Hierarchy path of the node. */
  nodePath: string;
  /** Mouse/touch position in screen coordinates. */
  pointer: { x: number; y: number };
  /** 3D world-space hit point on the mesh surface. */
  hitPoint: [number, number, number] | null;
  /** The actual mesh that was hit (not the node itself). */
  mesh: Object3D;
}

/** Data emitted with 'object-unhover'. */
export interface ObjectUnhoverData {
  node: Object3D;
  nodeType: string;
}

/** Data emitted with 'object-click'. */
export interface ObjectClickData {
  node: Object3D;
  nodeType: string;
  nodePath: string;
  pointer: { x: number; y: number };
}

/** Minimal event emitter interface to avoid circular dependency with RVViewer. */
interface ViewerEmitter {
  emit(event: string, data?: unknown): void;
}

/** Filter function to exclude meshes from raycasting (overlays, etc.). */
export type ExcludeFilter = (mesh: Object3D) => boolean;

/**
 * Override function for ancestor resolution.
 * Given a resolved node (from face-range lookup), return a different
 * node to use as the resolved target, or null to skip.
 */
export type AncestorOverrideFn = (node: Object3D) => Object3D | null;

const THROTTLE_MS = 50;

/**
 * True when `node` and every ancestor have `.visible === true`.
 *
 * Runtime-hidden subtrees (WebVisibility PLC signal, Groups panel) keep their
 * triangles in the merged pick BVH — this gate makes them un-hoverable and
 * un-clickable at hit-resolution time. Applied to the RESOLVED node (content
 * ancestor), never to the pick mesh itself (the merged BVH meshes are always
 * `visible = false`). O(tree depth) property reads per hit, allocation-free.
 *
 * Known limitations of the MERGED-GROUP path (documented, not built —
 * escalate only if they matter; the editor instance pick backend has NEITHER:
 * per-mesh hits fall through past hidden meshes, and its broad-phase
 * visibility walk excludes hidden source meshes themselves):
 * - Within ONE merged group, `firstHitOnly` returns only the closest triangle;
 *   if that triangle belongs to a hidden node, geometry behind it in the SAME
 *   group is not reported (small dead-zone). Escalation: bounded re-cast
 *   continuation past `hit.point + ε`.
 * - A hidden plain-group child under a visible content ancestor still picks
 *   via the ancestor (face ranges don't carry the source-mesh identity).
 */
function isEffectivelyVisible(node: Object3D): boolean {
  for (let c: Object3D | null = node; c; c = c.parent) {
    if (!c.visible) return false;
  }
  return true;
}

// ─── Hoverable type check via capabilities registry ─────────────────

/** Check if a type is a known hoverable type (from capabilities registry). */
export function isKnownHoverableType(type: string): boolean {
  return getCapabilities(type).hoverable;
}

/**
 * Pluggable pick-geometry backend (editor instance pick index). When
 * installed, it is intersected ALONGSIDE the classic target list (merged
 * groups are absent in editor mode, so in practice it replaces them) and its
 * meshes resolve via `resolvePath` instead of the face-range tables. The
 * entire gate pipeline (ancestor overrides → metadata promotion → visibility
 * → isolation → allow → hover-type) applies unchanged to backend hits.
 */
export interface RaycastBackend {
  /** Append intersections for the current ray. The CALLER sorts by distance. */
  raycast(raycaster: Raycaster, out: Intersection<Object3D>[]): void;
  /** Resolve a hit mesh to its content path; null = not a backend entry. */
  resolvePath(mesh: Object3D): string | null;
}

export class RaycastManager {
  private readonly raycaster = new Raycaster();
  private readonly pointer = new Vector2();
  private lastRaycastMs = 0;

  /** Currently hovered realvirtual node (not the mesh, but its registered ancestor). */
  private _hoveredNode: Object3D | null = null;
  /** Node type of the currently hovered node. */
  private _hoveredNodeType: string | null = null;
  /** Path of the currently hovered node. */
  private _hoveredNodePath: string | null = null;
  private _hoveredHitPoint: [number, number, number] | null = null;

  /** Currently hovered instanced MU (for identity comparison). */
  private _hoveredInstancedMU: InstancedMovingUnit | null = null;

  /** When false, hover raycasting is suppressed (e.g. during orbit/pinch). */
  private _enabled = true;
  /** When true, hover highlight is held (not cleared). Used while context menu is open. */
  private _holdHover = false;
  /** Last known pointer position for UI tooltip positioning. */
  pointerClientX = 0;
  pointerClientY = 0;

  /** Last XR controller ray origin (for ray visualization). */
  lastRayOrigin: Vector3 | null = null;
  /** Last XR controller ray direction (for ray visualization). */
  lastRayDirection: Vector3 | null = null;

  /** Grouped BVH raycast geometry set (set after scene load). */
  private _raycastGeo: RaycastGeometrySet | null = null;
  /** InstancedMesh targets for MU pools. */
  private _instancedMeshes: InstancedMesh[] = [];
  /** Exclude filters applied to intersections. */
  private _excludeFilters: ExcludeFilter[] = [];
  /** Which hover types are currently enabled. */
  private _enabledTypes = new Set<HoverableType>();
  /** Ancestor override callbacks — first non-null result wins. */
  private _ancestorOverrides: AncestorOverrideFn[] = [];
  /** Optional allow filter — when set, only nodes passing this filter are hoverable/clickable. */
  private _allowFilter: ((node: Object3D) => boolean) | null = null;
  /**
   * Isolation gate — installed by RVViewer once both registries exist.
   * Returns false for nodes outside any active isolation, regardless of
   * which provider (group/auto-filter/external) requested the isolate.
   * Stacked with `_allowFilter` (gate AND filter must pass).
   */
  private _isolationGate: ((node: Object3D) => boolean) | null = null;
  /** Cached raycast target list (rebuilt when geometry or instanced meshes change). */
  private _targets: Object3D[] = [];
  /** Category boundaries inside `_targets` for timed picking:
   *  [0, _staticTargetCount) = static merged BVH,
   *  [_staticTargetCount, _staticTargetCount + _kinematicTargetCount) = per-drive BVHs,
   *  rest = InstancedMesh MU pools + aux gizmo targets. Aux targets are only
   *  ever appended/removed in the tail, so the boundaries stay valid. */
  private _staticTargetCount = 0;
  private _kinematicTargetCount = 0;
  /** Optional pick-path timing sink (DevTools "Picking & Highlight"). */
  private _metrics: PickMetrics | null = null;
  /** Per-category timings of the last _timedIntersect call (ms). */
  private readonly _lastIntersectTimings = { total: 0, static: 0, kinematic: 0, other: 0 };
  /** Auxiliary raycast targets registered by plugins/components (e.g. gizmo spheres).
   *  When a ray hits one of these, it is resolved to the owner via _auxOwners. */
  private _auxTargets: Object3D[] = [];
  private _auxOwners = new WeakMap<Object3D, Object3D>();
  /** Map from raycast BVH mesh → RaycastGroup (for face-range lookup). */
  private _meshToGroup = new Map<Object3D, RaycastGroup>();
  /** Pluggable pick backend (editor instance pick index); null = merged groups only. */
  private _backend: RaycastBackend | null = null;

  private readonly onPointerMove: (e: PointerEvent) => void;
  private readonly onPointerLeave: () => void;

  // Pre-allocated vectors for XR
  private readonly _xrOrigin = new Vector3();
  private readonly _xrDir = new Vector3();

  constructor(
    private readonly renderer: { readonly domElement: HTMLCanvasElement },
    /**
     * Getter that returns the CURRENTLY ACTIVE camera — never capture by
     * reference. The viewer can swap perspective ↔ orthographic at runtime
     * (`viewer.projection = ...` / `viewer.animateProjectionTo(...)`), and
     * Three.js's `Raycaster.setFromCamera` constructs different rays for
     * each projection type. A captured stale reference produces wrong rays
     * after a projection swap → wrong selection / hover hits.
     */
    private readonly getCamera: () => Camera,
    private readonly scene: Scene,
    private readonly registry: NodeRegistry,
    private readonly highlighter: RVHighlightManager,
    private readonly emitter: ViewerEmitter,
  ) {
    // Enable firstHitOnly for BVH-accelerated raycasting (massive speedup)
    this.raycaster.firstHitOnly = true;
    // Enable all layers on the raycaster — filtering is done via the explicit
    // target list, not Three.js layer bits.
    this.raycaster.layers.enableAll();

    this.onPointerMove = this._handlePointerMove.bind(this);
    renderer.domElement.addEventListener('pointermove', this.onPointerMove);
    // When the pointer leaves the canvas (into the hierarchy, inspector or any
    // other HMI panel), the last hover state would go stale — hover tooltips
    // and highlights would stay open. Clear it explicitly.
    this.onPointerLeave = () => this._clearHover();
    renderer.domElement.addEventListener('pointerleave', this.onPointerLeave);

    // Default exclude filters
    this._excludeFilters.push(
      (obj) => !!obj.userData?._highlightOverlay,
      (obj) => !!obj.userData?._driveHoverOverlay,
      (obj) => obj.name.endsWith('_sensorViz'),
      (obj) => !!obj.userData?._tankFillViz,
      // Source pause-ghost (plan-180) and floor-marker (plan-181). Both are
      // children of `RVSource.node` and should never block selection of the
      // pallet/layout-object below them — they're purely visual identifiers.
      (obj) => !!obj.userData?._isSourceGhost,
      (obj) => !!obj.userData?._isGhostOverlay,
      (obj) => !!obj.userData?._isSourceMarker,
    );

    // Default: only drives are hoverable
    this.enableHoverType('Drive', true);
  }

  // ─── Public API ──────────────────────────────────────────────────

  /** The currently hovered realvirtual node (null if nothing hovered). */
  get hoveredNode(): Object3D | null { return this._hoveredNode; }

  /** The type of the currently hovered node (e.g. 'Drive'). */
  get hoveredNodeType(): string | null { return this._hoveredNodeType; }

  /** The hierarchy path of the currently hovered node. */
  get hoveredNodePath(): string | null { return this._hoveredNodePath; }
  /** 3D world-space hit point on the mesh surface during current hover. */
  get hoveredHitPoint(): [number, number, number] | null { return this._hoveredHitPoint; }

  /** Enable/disable all hover detection (e.g. during orbit gestures). */
  setEnabled(enabled: boolean): void {
    this._enabled = enabled;
    if (!enabled) this._clearHover();
  }

  /** Whether hover detection is currently enabled. */
  get enabled(): boolean { return this._enabled; }

  /** Hold the current hover highlight (prevents clearing). Used while context menu is open. */
  set holdHover(hold: boolean) { this._holdHover = hold; }
  get holdHover(): boolean { return this._holdHover; }

  /** Install the pick-path timing sink (null to disable). */
  setMetrics(metrics: PickMetrics | null): void {
    this._metrics = metrics;
  }

  /**
   * Provide the grouped BVH raycast geometry and instanced MU meshes.
   * Called once after scene load.
   */
  setRaycastGeometry(geo: RaycastGeometrySet, instancedMeshes: InstancedMesh[]): void {
    this._raycastGeo = geo;
    this._instancedMeshes = [...instancedMeshes];
    this._rebuildTargetList();
  }

  /** The current grouped raycast geometry (null before the first scene load). */
  get raycastGeometry(): RaycastGeometrySet | null {
    return this._raycastGeo;
  }

  /**
   * Install (or clear) the pluggable pick backend. Editor mode installs the
   * instance pick index here INSTEAD of merged groups; MU pools, aux targets
   * and every gate keep working unchanged.
   */
  setBackend(backend: RaycastBackend | null): void {
    this._backend = backend;
  }

  /** The installed pick backend (null outside editor mode). */
  get backend(): RaycastBackend | null {
    return this._backend;
  }

  /**
   * Notify that an MU pool replaced its InstancedMesh (e.g. during growth).
   */
  notifyInstancedMeshChanged(oldMesh: InstancedMesh, newMesh: InstancedMesh): void {
    const idx = this._instancedMeshes.indexOf(oldMesh);
    if (idx >= 0) {
      this._instancedMeshes[idx] = newMesh;
    } else {
      this._instancedMeshes.push(newMesh);
    }
    this._rebuildTargetList();
  }

  /** Enable or disable hover detection for a given node type. */
  enableHoverType(nodeType: HoverableType, enabled: boolean): void {
    if (enabled) {
      this._enabledTypes.add(nodeType);
    } else {
      this._enabledTypes.delete(nodeType);
    }
  }

  /** Returns the currently enabled hover types. */
  getEnabledHoverTypes(): HoverableType[] {
    return [...this._enabledTypes];
  }

  /** Add an exclude filter for mesh intersection results. */
  addExcludeFilter(filter: ExcludeFilter): void {
    this._excludeFilters.push(filter);
  }

  /**
   * Register an auxiliary mesh as raycast target whose hit resolves to a
   * different "owner" node. Used by gizmo systems (sphere overlays, glow
   * meshes, etc.) so hover/click on the visual gizmo behaves as if the
   * underlying realvirtual node was hit. Owner must be a registered node
   * (NodeRegistry) so the standard resolution pipeline works.
   *
   * Idempotent: calling twice with the same mesh just refreshes the owner.
   */
  addAuxRaycastTarget(mesh: Object3D, owner: Object3D): void {
    if (!this._auxOwners.has(mesh)) {
      this._auxTargets.push(mesh);
      this._targets.push(mesh);
    }
    this._auxOwners.set(mesh, owner);
  }

  /** Remove an auxiliary raycast target. Safe to call with an unregistered mesh. */
  removeAuxRaycastTarget(mesh: Object3D): void {
    const i = this._auxTargets.indexOf(mesh);
    if (i >= 0) this._auxTargets.splice(i, 1);
    const j = this._targets.indexOf(mesh);
    if (j >= 0) this._targets.splice(j, 1);
    this._auxOwners.delete(mesh);
  }

  /**
   * Set an allow filter — when set, only resolved nodes passing this filter
   * are hoverable/clickable. Pass null to remove the filter.
   *
   * This is a plugin-specific extra filter (e.g. docs-browser restricts to
   * doc-bearing nodes). Stacked atop the isolation gate — both must pass.
   */
  setAllowFilter(filter: ((node: Object3D) => boolean) | null): void {
    this._allowFilter = filter;
  }

  /**
   * Read the current allow filter (or null if none).
   * Useful for plugins that need to save/restore the filter so they can coexist
   * with other plugins also using setAllowFilter.
   */
  getAllowFilter(): ((node: Object3D) => boolean) | null {
    return this._allowFilter;
  }

  /**
   * Set the isolation gate — when set, only nodes passing this gate are
   * hoverable/clickable. Wired by RVViewer from GroupRegistry +
   * AutoFilterRegistry so isolation enforcement is a single invariant rather
   * than a per-provider concern.
   */
  setIsolationGate(gate: ((node: Object3D) => boolean) | null): void {
    this._isolationGate = gate;
  }

  /**
   * Add an ancestor override function.
   * When resolving a raycast hit, overrides are checked after face-range
   * resolution. If any override returns a non-null Object3D, that node
   * is used instead of the face-range resolved node.
   */
  addAncestorOverride(fn: AncestorOverrideFn): void {
    this._ancestorOverrides.push(fn);
  }

  /** Remove a previously added ancestor override. */
  removeAncestorOverride(fn: AncestorOverrideFn): void {
    const idx = this._ancestorOverrides.indexOf(fn);
    if (idx >= 0) this._ancestorOverrides.splice(idx, 1);
  }

  /**
   * Perform hover raycast using an XR controller ray.
   * Call each frame from the XR render loop for each active controller.
   */
  updateFromXRController(origin: Vector3, direction: Vector3): void {
    this._xrOrigin.copy(origin);
    this._xrDir.copy(direction);
    this.lastRayOrigin = this._xrOrigin.clone();
    this.lastRayDirection = this._xrDir.clone();

    this.raycaster.set(this._xrOrigin, this._xrDir);
    this._doRaycast();
  }

  /**
   * Perform a click/select raycast from a mouse/pointer event.
   * Returns the hovered node path, or null.
   * Does NOT alter hover state — this is for click handlers only.
   */
  raycastForRVNode(e: MouseEvent): string | null {
    const result = this.raycastForRVNodeDetailed(e);
    return result?.path ?? null;
  }

  /**
   * Raycast for RV node with detailed hit info (point, normal).
   * Used by context menu to pass hit coordinates to actions like Annotate.
   */
  raycastForRVNodeDetailed(e: MouseEvent | { clientX: number; clientY: number }): {
    path: string;
    hitPoint: [number, number, number];
    hitNormal: [number, number, number];
  } | null {
    // Empty targets is NOT "nothing pickable" when a backend is installed
    // (editor mode: no merged groups, no MU pools).
    if (!this.registry || (this._targets.length === 0 && !this._backend)) return null;
    pointerToNDC(e.clientX, e.clientY, this.renderer.domElement, this.pointer);

    this.raycaster.setFromCamera(this.pointer, this.getCamera());
    const hits = this._timedIntersect();
    const resolveStart = this._metrics ? performance.now() : 0;

    for (const hit of hits) {
      if (this._isExcluded(hit.object)) continue;

      const resolved = this._resolveHit(hit);
      if (!resolved) continue; // Unresolved mesh — skip, don't block hits behind it

      if (this._isTypeEnabled(resolved.nodeType)) {
        const normal = hit.face?.normal?.clone().transformDirection(hit.object.matrixWorld);
        if (this._metrics) this._reportPick(performance.now() - resolveStart, true);
        return {
          path: resolved.nodePath,
          hitPoint: [hit.point.x, hit.point.y, hit.point.z],
          hitNormal: normal ? [normal.x, normal.y, normal.z] : [0, 1, 0],
        };
      }
    }
    if (this._metrics) this._reportPick(performance.now() - resolveStart, false);
    return null;
  }

  /**
   * Perform AR tap selection with 9-point sampling for touch tolerance.
   * Returns { node, nodeType, nodePath } of the best hit, or null.
   */
  arTapRaycast(clientX: number, clientY: number, xrCamera?: PerspectiveCamera): {
    node: Object3D; nodeType: string; nodePath: string;
  } | null {
    if (this._targets.length === 0 && !this._backend) return null;
    const cam = xrCamera ?? this.getCamera();
    // Map taps against the canvas rect (not the window) so picking stays correct
    // when the canvas is confined to a sub-region of the viewport.
    const rect = this.renderer.domElement.getBoundingClientRect();

    const TAP_RADIUS = 20;
    const offsets = [
      [0, 0], [-TAP_RADIUS, 0], [TAP_RADIUS, 0], [0, -TAP_RADIUS], [0, TAP_RADIUS],
      [-TAP_RADIUS * 0.7, -TAP_RADIUS * 0.7], [TAP_RADIUS * 0.7, -TAP_RADIUS * 0.7],
      [-TAP_RADIUS * 0.7, TAP_RADIUS * 0.7], [TAP_RADIUS * 0.7, TAP_RADIUS * 0.7],
    ];

    let bestNode: Object3D | null = null;
    let bestType: string | null = null;
    let bestPath: string | null = null;
    let bestDist = Infinity;

    for (const [ox, oy] of offsets) {
      this.pointer.x = ((clientX + ox - rect.left) / rect.width) * 2 - 1;
      this.pointer.y = -((clientY + oy - rect.top) / rect.height) * 2 + 1;
      this.raycaster.setFromCamera(this.pointer, cam);

      // Shared hit collection — includes the pick backend (editor mode).
      const hits = this._collectHits();
      for (const hit of hits) {
        if (this._isExcluded(hit.object)) continue;

        const resolved = this._resolveHit(hit);
        if (resolved && hit.distance < bestDist) {
          bestDist = hit.distance;
          bestNode = resolved.node;
          bestType = resolved.nodeType;
          bestPath = resolved.nodePath;
        }
        break; // First non-excluded hit per sample (structural or interactive)
      }
    }

    if (bestNode && bestType && bestPath) {
      return { node: bestNode, nodeType: bestType, nodePath: bestPath };
    }
    return null;
  }

  dispose(): void {
    this.renderer.domElement.removeEventListener('pointermove', this.onPointerMove);
    this.renderer.domElement.removeEventListener('pointerleave', this.onPointerLeave);
    this._clearHover();
  }

  // ─── Private ──────────────────────────────────────────────────────

  /** Rebuild the cached target list and mesh→group map from current geometry set. */
  private _rebuildTargetList(): void {
    this._targets = [];
    this._meshToGroup.clear();
    this._staticTargetCount = 0;
    this._kinematicTargetCount = 0;

    if (this._raycastGeo) {
      if (this._raycastGeo.staticGroup) {
        this._targets.push(this._raycastGeo.staticGroup.mesh);
        this._meshToGroup.set(
          this._raycastGeo.staticGroup.mesh,
          this._raycastGeo.staticGroup,
        );
        this._staticTargetCount = 1;
      }
      for (const group of this._raycastGeo.kinematicGroups.values()) {
        this._targets.push(group.mesh);
        this._meshToGroup.set(group.mesh, group);
        this._kinematicTargetCount++;
      }
    }

    for (const im of this._instancedMeshes) {
      this._targets.push(im);
    }

    // Aux targets (gizmo spheres etc.) are appended last so they don't take
    // precedence over real geometry at the same depth — but raycaster sorts
    // by distance anyway, so closest hit always wins.
    for (const m of this._auxTargets) this._targets.push(m);
  }

  private _handlePointerMove(e: PointerEvent): void {
    // Always track pointer position (for external tooltip positioning)
    this.pointerClientX = e.clientX;
    this.pointerClientY = e.clientY;

    if (!this._enabled) {
      this._clearHover();
      return;
    }

    const now = performance.now();
    if (now - this.lastRaycastMs < THROTTLE_MS) return;
    this.lastRaycastMs = now;

    pointerToNDC(e.clientX, e.clientY, this.renderer.domElement, this.pointer);

    this.raycaster.setFromCamera(this.pointer, this.getCamera());
    this._doRaycast();
  }

  /**
   * Resolve a raycast intersection to a realvirtual node.
   * Handles both BVH group hits (face-range lookup) and InstancedMesh MU hits.
   */
  private _resolveHit(hit: { object: Object3D; faceIndex?: number | null; instanceId?: number }): {
    node: Object3D;
    nodeType: string;
    nodePath: string;
    instancedMU?: InstancedMovingUnit;
  } | null {
    // Check for InstancedMesh MU pool hit
    const pool = hit.object.userData?._muPool as MUInstancePool | undefined;
    if (pool && hit.instanceId !== undefined && hit.instanceId >= 0) {
      if (!isEffectivelyVisible(hit.object)) return null;
      const mu = pool.getMUAtSlot(hit.instanceId);
      if (mu) {
        return {
          node: hit.object,
          nodeType: 'MU',
          nodePath: mu.getName(),
          instancedMU: mu,
        };
      }
      return null;
    }

    // Auxiliary target hit: resolve to registered owner node (gizmo overlays etc.)
    const auxOwner = this._auxOwners.get(hit.object);
    if (auxOwner) {
      const ownerPath = this.registry.getPathForNode(auxOwner);
      if (!ownerPath) return null;
      if (!isEffectivelyVisible(auxOwner)) return null;
      // Apply isolation gate + allow filter
      if (this._isolationGate && !this._isolationGate(auxOwner)) return null;
      if (this._allowFilter && !this._allowFilter(auxOwner)) return null;
      return {
        node: auxOwner,
        nodeType: this._resolveNodeType(auxOwner),
        nodePath: ownerPath,
      };
    }

    // Instance-pick backend hit (editor mode): the backend resolves the mesh
    // to its EXACT node path (no ancestor promotion); the shared gate tail
    // below applies unchanged, but the node type must come from the node
    // itself — a parent walk would relabel a plain sub-mesh as e.g. 'Drive'
    // and wrongly subject it to that type's hover gate.
    const backendPath = this._backend?.resolvePath(hit.object);
    if (backendPath) return this._resolveFromPath(backendPath, true);

    // Look up the BVH group for this mesh
    const group = this._meshToGroup.get(hit.object);
    if (!group || hit.faceIndex == null) return null;

    // Binary search face ranges
    const objectPath = resolveHit(group.faceRanges, hit.faceIndex);
    if (!objectPath) return null;

    return this._resolveFromPath(objectPath);
  }

  /**
   * Shared resolution tail for every path-resolved hit (merged-group face
   * ranges AND the pick backend): registry lookup → ancestor overrides →
   * metadata promotion → visibility gate → isolation gate → allow filter.
   */
  private _resolveFromPath(objectPath: string, ownNodeTypeOnly = false): {
    node: Object3D;
    nodeType: string;
    nodePath: string;
  } | null {
    // Resolve to Object3D via registry
    const node = this.registry.getNode(objectPath);
    if (!node) return null;

    // Check ancestor overrides (e.g. layout planner full-object selection)
    for (const override of this._ancestorOverrides) {
      const overrideNode = override(node);
      if (overrideNode) {
        const overridePath = this.registry.getPathForNode(overrideNode);
        if (overridePath) {
          // Apply visibility + isolation gate + allow filter before returning override result
          if (!isEffectivelyVisible(overrideNode)) return null;
          if (this._isolationGate && !this._isolationGate(overrideNode)) return null;
          if (this._allowFilter && !this._allowFilter(overrideNode)) return null;
          const nodeType = this._resolveNodeType(overrideNode);
          return { node: overrideNode, nodeType, nodePath: overridePath };
        }
      }
    }

    // Promote to the NEAREST RuntimeMetadata node, including the hit object
    // itself (an object with its own metadata counts — no walk past it). Stop at
    // the first node up the chain that carries metadata and highlight EVERYTHING
    // under it. No-op when there is no metadata in the chain, so non-metadata
    // objects (drives, sensors, …) are unaffected.
    let resolvedNode = node;
    let resolvedPath = objectPath;
    const meta = this._nearestMetadataAncestor(node);
    if (meta) {
      const metaPath = this.registry.getPathForNode(meta);
      if (metaPath) { resolvedNode = meta; resolvedPath = metaPath; }
    }

    // Runtime-hidden subtrees (WebVisibility signal, Groups panel) must not
    // be hoverable/clickable — returning null lets the hit loop fall through
    // to whatever is behind (hits from OTHER targets still win).
    if (!isEffectivelyVisible(resolvedNode)) return null;

    // Apply isolation gate (group/auto-filter/external) and any plugin-specific filter
    if (this._isolationGate && !this._isolationGate(resolvedNode)) return null;
    if (this._allowFilter && !this._allowFilter(resolvedNode)) return null;

    const nodeType = this._resolveNodeType(resolvedNode, ownNodeTypeOnly);
    return { node: resolvedNode, nodeType, nodePath: resolvedPath };
  }

  /**
   * Walk up from `node` and return the FIRST node that carries RuntimeMetadata
   * (`userData._rvMetadata`, stamped by the RVMetadata component) — including
   * `node` itself (an object with its own metadata stops the walk immediately).
   * Returns null when no node in the chain has metadata.
   */
  private _nearestMetadataAncestor(node: Object3D): Object3D | null {
    let cur: Object3D | null = node;
    while (cur) {
      if (cur.userData?._rvMetadata) return cur;
      cur = cur.parent;
    }
    return null;
  }

  /**
   * Determine the primary node type from cached data or registry.
   * `ownNodeOnly` (editor exact-node picks) skips the parent-chain walk —
   * the type must describe the resolved node itself, not an ancestor.
   */
  private _resolveNodeType(node: Object3D, ownNodeOnly = false): string {
    // Fast path: check cached type from scene loader
    const cachedType = node.userData?._rvType as string | undefined;
    if (cachedType) return cachedType;

    // Check registered component types on this node via registry
    const path = this.registry.getPathForNode(node);
    if (path) {
      const types = this.registry.getComponentTypes(path);
      for (const t of types) {
        if (getCapabilities(t).hoverable) return t;
      }
      if (types.length > 0) return types[0];
    }

    if (ownNodeOnly) {
      const rv = node.userData?.realvirtual;
      if (rv && typeof rv === 'object') {
        const keys = Object.keys(rv as Record<string, unknown>);
        if (keys.length > 0) return keys[0];
      }
      return 'Unknown';
    }

    // Walk up parent chain to find a hoverable type — derived from the
    // capabilities registry (no hardcoded type list, no per-type special-case).
    for (const type of getTypesWithCapability('hoverable')) {
      if (this.registry.findInParent(node, type)) return type;
    }

    // Fallback: check realvirtual userData keys
    const rv = node.userData?.realvirtual;
    if (rv && typeof rv === 'object') {
      const keys = Object.keys(rv as Record<string, unknown>);
      if (keys.length > 0) return keys[0];
    }

    return 'Unknown';
  }

  /** Check if a node type is allowed by the current enabled hover types. */
  private _isTypeEnabled(nodeType: string): boolean {
    // If the type isn't a known hoverable type, always allow it
    if (!isKnownHoverableType(nodeType)) return true;
    return this._enabledTypes.has(nodeType);
  }

  /**
   * Intersect the backend (if installed) + all classic targets into one
   * distance-sorted hit array — the ONE hit-collection path shared by hover,
   * click and AR tap. The backend appends unsorted; `intersectObject` into
   * the shared array re-sorts on every call, so an explicit final sort is
   * only needed when the backend contributed hits.
   */
  private _collectHits(): Intersection<Object3D>[] {
    if (!this._backend) {
      return this.raycaster.intersectObjects(this._targets, false);
    }
    const hits: Intersection<Object3D>[] = [];
    this._backend.raycast(this.raycaster, hits);
    for (let i = 0; i < this._targets.length; i++) {
      this.raycaster.intersectObject(this._targets[i], false, hits);
    }
    hits.sort(_byDistance);
    return hits;
  }

  /**
   * `_collectHits` with per-category timing (backend/static BVH / per-drive
   * BVHs / other). Backend time lands in the `static` slot (in editor mode
   * the backend IS the whole scene geometry). Timings land in
   * `_lastIntersectTimings`; the caller reports them via
   * `_metrics.recordRaycast(...)` once the hit outcome is known.
   */
  private _timedIntersect(): Intersection<Object3D>[] {
    if (!this._metrics) {
      return this._collectHits();
    }
    const hits: Intersection<Object3D>[] = [];
    const staticEnd = this._staticTargetCount;
    const kinematicEnd = staticEnd + this._kinematicTargetCount;
    let i = 0;
    const t0 = performance.now();
    this._backend?.raycast(this.raycaster, hits);
    for (; i < staticEnd; i++) this.raycaster.intersectObject(this._targets[i], false, hits);
    const t1 = performance.now();
    for (; i < kinematicEnd; i++) this.raycaster.intersectObject(this._targets[i], false, hits);
    const t2 = performance.now();
    for (; i < this._targets.length; i++) this.raycaster.intersectObject(this._targets[i], false, hits);
    if (this._backend) hits.sort(_byDistance);
    const t3 = performance.now();
    const t = this._lastIntersectTimings;
    t.static = t1 - t0;
    t.kinematic = t2 - t1;
    t.other = t3 - t2;
    t.total = t3 - t0;
    return hits;
  }

  /** Report the last intersect timings + resolve duration to the metrics sink. */
  private _reportPick(resolveMs: number, hit: boolean): void {
    if (!this._metrics) return;
    const t = this._lastIntersectTimings;
    this._metrics.recordRaycast(t.total, t.static, t.kinematic, t.other, hit);
    this._metrics.recordResolve(resolveMs);
  }

  /** Core raycast logic shared between pointer and XR. */
  private _doRaycast(): void {
    if (this._targets.length === 0 && !this._backend) {
      this._clearHover();
      return;
    }

    const hits = this._timedIntersect();
    const resolveStart = this._metrics ? performance.now() : 0;

    let hitNode: Object3D | null = null;
    let hitType: string | null = null;
    let hitPath: string | null = null;
    let hitInstancedMU: InstancedMovingUnit | null = null;
    let hitPoint: [number, number, number] | null = null;

    for (const hit of hits) {
      if (this._isExcluded(hit.object)) continue;

      const resolved = this._resolveHit(hit);
      if (!resolved) continue; // Unresolved mesh — skip, don't block hits behind it

      // Enforce exclusive hover mode: skip nodes whose type is not enabled
      if (!this._isTypeEnabled(resolved.nodeType)) continue;

      hitNode = resolved.node;
      hitType = resolved.nodeType;
      hitPath = resolved.nodePath;
      hitInstancedMU = resolved.instancedMU ?? null;
      hitPoint = [hit.point.x, hit.point.y, hit.point.z];
      break;
    }

    if (this._metrics) this._reportPick(performance.now() - resolveStart, hitNode !== null);

    if (!hitNode) {
      this._clearHover();
      return;
    }

    // The node from _resolveHit IS the canonical interactive owner: the BVH
    // face-ranges were built by findContentAncestor (nearest hoverable ancestor),
    // so hover and click/selection share this exact resolution. No extra walk-up
    // here — that used to diverge from the click path and is the unification point.
    const highlightNode = hitNode;
    const highlightPath = this.registry.getPathForNode(highlightNode) ?? hitPath;

    // Apply isolation gate + allow filter on the final highlight node (after component owner resolution)
    if (this._isolationGate && !this._isolationGate(highlightNode)) {
      this._clearHover();
      return;
    }
    if (this._allowFilter && !this._allowFilter(highlightNode)) {
      this._clearHover();
      return;
    }

    if (highlightNode === this._hoveredNode && !hitInstancedMU) return;
    // For instanced MUs, check if same MU is still highlighted
    if (hitInstancedMU && this._hoveredInstancedMU === hitInstancedMU) return;

    this._clearHover();
    this._hoveredNode = highlightNode;
    this._hoveredNodeType = hitType;
    this._hoveredNodePath = highlightPath;
    this._hoveredHitPoint = hitPoint;
    this._hoveredInstancedMU = hitInstancedMU;

    if (hitInstancedMU) {
      this.highlighter.highlightInstancedMU(hitInstancedMU);
    } else {
      // LayoutObject nodes need includeChildDrives to highlight the full subtree
      const isLayout = !!(highlightNode.userData?.realvirtual as Record<string, unknown> | undefined)?.LayoutObject;
      this.highlighter.highlight(highlightNode, false, { includeChildDrives: isLayout });
    }
    this.renderer.domElement.style.cursor = 'pointer';
  }

  /** Check if a mesh should be excluded from raycast results. */
  private _isExcluded(mesh: Object3D): boolean {
    for (const filter of this._excludeFilters) {
      if (filter(mesh)) return true;
    }
    return false;
  }

  /** Clear hover state and restore cursor. */
  private _clearHover(): void {
    if (this._holdHover) return; // Keep highlight while context menu is open
    if (this._hoveredNode) {
      const prevNode = this._hoveredNode;
      const prevType = this._hoveredNodeType ?? 'Unknown';
      this.highlighter.clear();
      this._hoveredNode = null;
      this._hoveredNodeType = null;
      this._hoveredNodePath = null;
      this._hoveredHitPoint = null;
      this._hoveredInstancedMU = null;
      this.renderer.domElement.style.cursor = '';

      this.emitter.emit('object-unhover', { node: prevNode, nodeType: prevType });
    }
  }
}
