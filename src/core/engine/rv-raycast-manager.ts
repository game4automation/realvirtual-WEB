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
import type { Camera, PerspectiveCamera, Scene } from 'three';
import type { NodeRegistry } from './rv-node-registry';
import type { RVHighlightManager } from './rv-highlight-manager';
import type { MUInstancePool, InstancedMovingUnit } from './rv-mu';
import {
  resolveHit,
  type RaycastGeometrySet,
  type RaycastGroup,
} from './rv-raycast-geometry';
import { getCapabilities } from './rv-component-registry';

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

// ─── Hoverable type check via capabilities registry ─────────────────

/** Check if a type is a known hoverable type (from capabilities registry). */
export function isKnownHoverableType(type: string): boolean {
  return getCapabilities(type).hoverable;
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
  /** Cached raycast target list (rebuilt when geometry or instanced meshes change). */
  private _targets: Object3D[] = [];
  /** Map from raycast BVH mesh → RaycastGroup (for face-range lookup). */
  private _meshToGroup = new Map<Object3D, RaycastGroup>();

  private readonly onPointerMove: (e: PointerEvent) => void;

  // Pre-allocated vectors for XR
  private readonly _xrOrigin = new Vector3();
  private readonly _xrDir = new Vector3();

  constructor(
    private readonly renderer: { readonly domElement: HTMLCanvasElement },
    private readonly camera: Camera,
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

    // Default exclude filters
    this._excludeFilters.push(
      (obj) => !!obj.userData?._highlightOverlay,
      (obj) => !!obj.userData?._driveHoverOverlay,
      (obj) => obj.name.endsWith('_sensorViz'),
      (obj) => !!obj.userData?._tankFillViz,
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

  /**
   * Provide the grouped BVH raycast geometry and instanced MU meshes.
   * Called once after scene load.
   */
  setRaycastGeometry(geo: RaycastGeometrySet, instancedMeshes: InstancedMesh[]): void {
    this._raycastGeo = geo;
    this._instancedMeshes = [...instancedMeshes];
    this._rebuildTargetList();
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
    if (!this.registry || this._targets.length === 0) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObjects(this._targets, false);

    for (const hit of hits) {
      if (this._isExcluded(hit.object)) continue;

      const resolved = this._resolveHit(hit);
      if (!resolved) continue; // Unresolved mesh — skip, don't block hits behind it

      if (this._isTypeEnabled(resolved.nodeType)) {
        const normal = hit.face?.normal?.clone().transformDirection(hit.object.matrixWorld);
        return {
          path: resolved.nodePath,
          hitPoint: [hit.point.x, hit.point.y, hit.point.z],
          hitNormal: normal ? [normal.x, normal.y, normal.z] : [0, 1, 0],
        };
      }
    }
    return null;
  }

  /**
   * Perform AR tap selection with 9-point sampling for touch tolerance.
   * Returns { node, nodeType, nodePath } of the best hit, or null.
   */
  arTapRaycast(clientX: number, clientY: number, xrCamera?: PerspectiveCamera): {
    node: Object3D; nodeType: string; nodePath: string;
  } | null {
    if (this._targets.length === 0) return null;
    const cam = xrCamera ?? this.camera;
    const w = window.innerWidth;
    const h = window.innerHeight;

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
      this.pointer.x = ((clientX + ox) / w) * 2 - 1;
      this.pointer.y = -((clientY + oy) / h) * 2 + 1;
      this.raycaster.setFromCamera(this.pointer, cam);

      const hits = this.raycaster.intersectObjects(this._targets, false);
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
    this._clearHover();
  }

  // ─── Private ──────────────────────────────────────────────────────

  /** Rebuild the cached target list and mesh→group map from current geometry set. */
  private _rebuildTargetList(): void {
    this._targets = [];
    this._meshToGroup.clear();

    if (this._raycastGeo) {
      if (this._raycastGeo.staticGroup) {
        this._targets.push(this._raycastGeo.staticGroup.mesh);
        this._meshToGroup.set(
          this._raycastGeo.staticGroup.mesh,
          this._raycastGeo.staticGroup,
        );
      }
      for (const group of this._raycastGeo.kinematicGroups.values()) {
        this._targets.push(group.mesh);
        this._meshToGroup.set(group.mesh, group);
      }
    }

    for (const im of this._instancedMeshes) {
      this._targets.push(im);
    }
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

    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

    this.raycaster.setFromCamera(this.pointer, this.camera);
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

    // Look up the BVH group for this mesh
    const group = this._meshToGroup.get(hit.object);
    if (!group || hit.faceIndex == null) return null;

    // Binary search face ranges
    const objectPath = resolveHit(group.faceRanges, hit.faceIndex);
    if (!objectPath) return null;

    // Resolve to Object3D via registry
    const node = this.registry.getNode(objectPath);
    if (!node) return null;

    // Check ancestor overrides (e.g. layout planner full-object selection)
    for (const override of this._ancestorOverrides) {
      const overrideNode = override(node);
      if (overrideNode) {
        const overridePath = this.registry.getPathForNode(overrideNode);
        if (overridePath) {
          const nodeType = this._resolveNodeType(overrideNode);
          return { node: overrideNode, nodeType, nodePath: overridePath };
        }
      }
    }

    const nodeType = this._resolveNodeType(node);
    return { node, nodeType, nodePath: objectPath };
  }

  /** Determine the primary node type from cached data or registry. */
  private _resolveNodeType(node: Object3D): string {
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

    // Walk up parent chain to find a hoverable type
    const hoverableTypes = ['Drive', 'Sensor', 'MU', 'Pipe', 'Tank', 'Pump', 'ProcessingUnit'];
    for (const type of hoverableTypes) {
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

  /**
   * Walk up from `node` to find the ancestor that actually owns the
   * component of the given type. Mirrors what the click handler does
   * (e.g. findInParent<RVDrive>) so hover highlights the same subtree.
   */
  private _findComponentOwner(node: Object3D, nodeType: string): Object3D | null {
    if (!isKnownHoverableType(nodeType)) return null;
    let current: Object3D | null = node;
    while (current) {
      const path = this.registry.getPathForNode(current);
      if (path) {
        const types = this.registry.getComponentTypes(path);
        if (types.includes(nodeType)) return current;
      }
      current = current.parent;
    }
    return null;
  }

  /** Check if a node type is allowed by the current enabled hover types. */
  private _isTypeEnabled(nodeType: string): boolean {
    // If the type isn't a known hoverable type, always allow it
    if (!isKnownHoverableType(nodeType)) return true;
    return this._enabledTypes.has(nodeType);
  }

  /** Core raycast logic shared between pointer and XR. */
  private _doRaycast(): void {
    if (this._targets.length === 0) {
      this._clearHover();
      return;
    }

    const hits = this.raycaster.intersectObjects(this._targets, false);

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

    if (!hitNode) {
      this._clearHover();
      return;
    }

    // Walk up to the component-owning parent to match click/selection behavior.
    // _resolveNodeType uses findInParent which may report a type from an ancestor
    // (e.g. 'Drive' for a child mesh under a Drive). The click handler walks up
    // to that ancestor for selection, so hover should highlight the same node.
    const highlightNode = (hitType ? this._findComponentOwner(hitNode, hitType) : null) ?? hitNode;
    const highlightPath = this.registry.getPathForNode(highlightNode) ?? hitPath;

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
