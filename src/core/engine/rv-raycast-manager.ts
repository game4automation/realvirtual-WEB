// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * RaycastManager — Unified raycast system for the realvirtual Web Viewer.
 *
 * Pick geometry:
 *   - the baked pick backend (rv-pick-backend.ts) — realvirtual's own CPU pick
 *     structure per chunk (the loaded model and every planner placement),
 *     resolved to the owner node of the hit SEGMENT (plan-756),
 *   - the instance pick index backend — real meshes with per-mesh BVHs
 *     (authoring loads, and every load that did not bake),
 *   - InstancedMesh targets for MU pools and aux targets (gizmos, hulls).
 *
 * Only objects with a content-providing ancestor (userData.realvirtual) or a
 * segment owner resolve; everything else lets the ray pass — except OPAQUE baked
 * geometry that owns nothing, which occludes ({@link RAYCAST_BLOCKED}).
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
  Matrix3,
  Matrix4,
} from 'three';
import type { Camera, Intersection, PerspectiveCamera, Scene } from 'three';
import type { NodeRegistry } from './rv-node-registry';
import type { RVHighlightManager } from './rv-highlight-manager';
import { rankHitsByWireProximity } from './rv-wire-pick';
import type { MUInstancePool, InstancedMovingUnit } from './rv-mu';
import type { PickMetrics } from './rv-pick-metrics';
import { getCapabilities, getPickableTypes } from './rv-component-registry';
import { pointerToNDC } from './rv-pointer-utils';
import { RV_CHAIN_PROXY } from './rv-traverse-utils';

/** Ascending-distance comparator (matches three's internal raycast sort). */
function _byDistance(a: Intersection<Object3D>, b: Intersection<Object3D>): number {
  return a.distance - b.distance;
}

const _nWorld = new Matrix4();
const _nInstance = new Matrix4();
const _nMatrix = new Matrix3();

/** World face normal of a hit: normal matrix of world × instance matrix (zero without a face). */
export function writeWorldNormal(hit: Intersection<Object3D>, out: Vector3): void {
  const n = hit.face?.normal;
  if (!n) { out.set(0, 0, 0); return; }
  _nWorld.copy(hit.object.matrixWorld);
  const im = hit.object as InstancedMesh;
  if (im.isInstancedMesh && hit.instanceId !== undefined) {
    im.getMatrixAt(hit.instanceId, _nInstance);
    _nWorld.multiply(_nInstance);
  }
  out.copy(n).applyMatrix3(_nMatrix.getNormalMatrix(_nWorld)).normalize();
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

/** Options of {@link RaycastManager.addAuxRaycastTarget}. */
export interface AuxRaycastTargetOptions {
  /** The target is drawn over the scene (overlay layer, no depth test — a
   *  WebLabel billboard): its hit wins over any geometry in front of it, and it
   *  is never a surface for {@link RaycastManager.raycastSurface}. */
  onTop?: boolean;
  /** Selects its owner but is never a `raycastSurface` surface (EnergyChain hull). */
  pickOnly?: boolean;
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
 * How often a backend wants the POINTER HOVER ray (plan-756 F7 / Q10).
 *
 * - `'throttled'` (the default, and what every backend got before plan-756):
 *   at most one hover ray every {@link THROTTLE_MS}. That interval WAS the whole
 *   CPU budget of hovering when a ray could brute-force a multi-million-triangle
 *   chunk.
 * - `'frame'`: at most one hover ray per animation frame, and only when the
 *   pointer actually moved since the last ray. The baked {@link PickBackend}
 *   declares it — its p95 is ~0.03 ms, so the 50 ms staircase is pure latency.
 *
 * The cadence applies to POINTER HOVER only. A click, an AR tap, an XR ray and
 * every explicit `raycast*` call intersect every backend immediately — they are
 * user-initiated single events with no cadence to speak of.
 */
export type HoverCadence = 'frame' | 'throttled';

/**
 * True when `node` and every ancestor have `.visible === true`.
 *
 * Runtime-hidden subtrees (WebVisibility PLC signal, Groups panel) keep their
 * triangles inside the chunk they were merged into — this gate makes them
 * un-hoverable and un-clickable at hit-resolution time. (The baked pick backend
 * additionally skips their segments during the traversal, plan-756 F2, so the
 * gate is the backstop rather than the only line of defence.) Applied to the
 * RESOLVED node (content ancestor), never to the pick mesh itself. O(tree depth)
 * property reads per hit, allocation-free. The editor instance pick backend needs it less:
 * per-mesh hits fall through past hidden meshes, and its broad-phase
 * visibility walk excludes hidden source meshes themselves.
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
  return getCapabilities(type).pick !== 'none';
}

/**
 * A backend's `resolveHit` may answer with this instead of a node (plan-756 Q5):
 * the hit is REAL, OCCLUDING geometry that resolves to nothing pickable — an
 * opaque baked chunk face whose segment has no pick owner. It is NOT the same
 * answer as `null`: `null` means "not mine / nothing pickable here, try the next
 * hit", BLOCKED means "something solid is in the way, stop looking". The hit
 * loop therefore ends on it with no selection instead of lighting up a part
 * hidden inside a housing. A transparent chunk never answers BLOCKED, so a
 * guard behind safety glass stays selectable.
 */
export const RAYCAST_BLOCKED = 'rv-blocked' as const;

/** What a node-resolving backend may answer for one hit. */
export type BackendHitResolution = Object3D | null | typeof RAYCAST_BLOCKED;

/**
 * Pluggable pick-geometry backend (chunk pick backend, instance pick index).
 * When installed, it is intersected ALONGSIDE the target list (MU pools, aux
 * targets) and its meshes resolve via `resolveHit` / `resolvePath`. The
 * entire gate pipeline (ancestor overrides → visibility → isolation → allow
 * → hover-type) applies unchanged to backend hits.
 */
export interface RaycastBackend {
  /** Append intersections for the current ray. The CALLER sorts by distance. */
  raycast(raycaster: Raycaster, out: Intersection<Object3D>[]): void;
  /** Resolve a hit mesh to its content path; null = not a backend entry. */
  resolvePath(mesh: Object3D): string | null;
  /**
   * Resolve a hit to a NODE reference (plan-753 A1/F3) — consulted BEFORE
   * `resolvePath`, with the whole intersection (so the backend can read its own
   * per-hit data off it). Null = not a backend entry, {@link RAYCAST_BLOCKED} =
   * occluding but unpickable. A node returned here is taken as the innermost
   * pick target: the shared gate tail applies (ancestor overrides → visibility
   * → isolation → allow → hover type) but NOT the RuntimeMetadata promotion — a
   * metadata node with `pick:'select'` owns its segments, its CAD children
   * resolve to it by construction.
   */
  resolveHit?(hit: PickHit): BackendHitResolution;
  /**
   * Hover cadence of THIS backend (plan-756 F7). Absent = `'throttled'`, the
   * historical 50 ms. Cadences are per backend, never global: with a `'frame'`
   * backend installed the manager samples per animation frame, and a
   * `'throttled'` backend is simply skipped in the samples that fall inside its
   * own 50 ms window.
   */
  readonly hoverCadence?: HoverCadence;
}

/**
 * Result record of {@link RaycastManager.raycastSurface} (plan-515 §2.3).
 * Caller-owned and reused — the manager only writes into it.
 */
export interface SurfaceHit {
  /** World hit point. */
  point: Vector3;
  /** Ray distance to the hit (from the ray origin; for ortho that is the near plane). */
  distance: number;
  /** True when the surface is opaque geometry without a pick owner (RAYCAST_BLOCKED). */
  blocked: boolean;
  /** Resolved node path, or null for a blocked surface. */
  path: string | null;
  /**
   * Optional, caller-owned: when present, `raycastSurface` writes the pick ray
   * into it — for a hit AND for background — so navigation moves along exactly
   * the ray it picked with (no second, slightly different cursor ray).
   */
  ray?: { origin: Vector3; direction: Vector3 };
  /** Optional, caller-owned: receives the world face normal (zero without a face). */
  normal?: Vector3;
}

/** The part of an intersection hit resolution reads (a full `Intersection` satisfies it). */
export interface PickHit {
  object: Object3D;
  faceIndex?: number | null;
  instanceId?: number;
}

export class RaycastManager {
  private readonly raycaster = new Raycaster();
  private readonly pointer = new Vector2();
  private lastRaycastMs = 0;

  // ─── Hover cadence (plan-756 F7) ──────────────────────────────────
  /** Client position of the pointermove that has not been answered by a ray yet. */
  private _pendingPointerX = 0;
  private _pendingPointerY = 0;
  /** Did the pointer move since the last hover ray? No movement ⇒ no ray. */
  private _pointerMovedSinceRay = false;
  /** Handle of the scheduled frame-paced sample; null = nothing scheduled. */
  private _hoverFrameHandle: number | null = null;
  /** True only while a POINTER HOVER sample runs (the per-backend cadence gate). */
  private _hoverSampling = false;
  /** Set while a hover sample runs when a throttled backend was skipped for its
   *  cadence — the sample's empty result is then inconclusive (see _doRaycast). */
  private _hoverSkippedBackend = false;
  /** `performance.now()` of the running sample — read once, shared by the gate. */
  private _sampleNowMs = 0;
  /** Per backend: when it last contributed to a hover sample. */
  private readonly _backendLastHoverMs = new WeakMap<RaycastBackend, number>();

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
  /** Cached raycast target list (rebuilt when the instanced meshes change):
   *  InstancedMesh MU pools first, then the aux gizmo targets, which are only
   *  ever appended/removed in the tail. The model's own pick geometry lives in
   *  the backends (chunk pick backend / instance pick index), not here. */
  private _targets: Object3D[] = [];
  /** Optional pick-path timing sink (DevTools "Picking & Highlight"). */
  private _metrics: PickMetrics | null = null;
  /** Per-category timings of the last _timedIntersect call (ms). */
  private readonly _lastIntersectTimings = { total: 0, static: 0, kinematic: 0, other: 0 };
  /** Auxiliary raycast targets registered by plugins/components (e.g. gizmo spheres).
   *  When a ray hits one of these, it is resolved to the owner via _auxOwners. */
  private _auxTargets: Object3D[] = [];
  private _auxOwners = new WeakMap<Object3D, Object3D>();
  /** Aux targets registered `onTop` (see {@link AuxRaycastTargetOptions}). */
  private _auxOnTop = new Set<Object3D>();
  private _auxPickOnly = new Set<Object3D>();
  private get _auxOnTopCount(): number { return this._auxOnTop.size; }
  /** Pluggable pick backend (instance pick index); null = chunk backend + targets only. */
  private _backend: RaycastBackend | null = null;
  /** Additional backends (plan-753 Phase 3: the chunk pick backend). They
   *  coexist with the primary one: each answers only for ITS meshes and
   *  passes everything else through. */
  private _extraBackends: RaycastBackend[] = [];

  private readonly onPointerMove: (e: PointerEvent) => void;
  private readonly onPointerLeave: () => void;
  private readonly onPointerDownCapture: (e: PointerEvent) => void;

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

    // A tap can arrive BEFORE the frame that would have answered the last
    // pointermove (plan-756 F7), and the click path reads `hoveredNode`. Flush the
    // pending sample first — in the CAPTURE phase, so it runs before the viewer's
    // own pointerdown handlers whatever the construction order. Nothing pending
    // means hover is already current and no ray is spent.
    this.onPointerDownCapture = (e: PointerEvent) => {
      if (!this._enabled || !this._pointerMovedSinceRay || this.pickBlocked?.()) return;
      this._sampleHover(e.clientX, e.clientY);
    };
    renderer.domElement.addEventListener('pointerdown', this.onPointerDownCapture, { capture: true });

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
      // The AI agent's camera-body gizmo (plan-740 D-A4/I1). Layer bits do not
      // filter here (see the enableAll() above), so the cone would otherwise be
      // hoverable and clickable — and clicking it would select "the agent"
      // instead of the machine behind it. Its own double-click attach runs on a
      // separate screen-space hit test, not through this pipeline.
      (obj) => !!obj.userData?._agentEyeOverlay,
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
   * plan-529 SOL R2-4: a cursor that takes priority when this manager would
   * RESET the cursor on un-hover — the viewer returns `'pointer'` while a linked
   * WebLabel is under the mouse, `null` otherwise (then the reset is `''`).
   */
  cursorOverride: (() => string | null) | null = null;

  /**
   * plan-2215 2.6: true while a pointer pick from screen coordinates is invalid
   * (the viewer installs `() => viewer.pointerPickBlocked`). Hover and the
   * pointer pick APIs ({@link raycastForRVNodeDetailed}, {@link pickDetailed})
   * then find nothing — independent of {@link setEnabled}, so a manager rebuilt
   * by a model load is blocked from its first event.
   */
  pickBlocked: (() => boolean) | null = null;

  /** Install the pick-path timing sink (null to disable). */
  setMetrics(metrics: PickMetrics | null): void {
    this._metrics = metrics;
  }

  /**
   * Install the instanced MU meshes. Called once after scene load — the
   * model's own pick geometry is a backend (chunk pick backend for a baked
   * load, instance pick index otherwise), never a target here.
   */
  setInstancedMeshes(instancedMeshes: InstancedMesh[]): void {
    this._instancedMeshes = [...instancedMeshes];
    this._rebuildTargetList();
  }

  /**
   * Install (or clear) the primary pick backend (the instance pick index of
   * a non-baked load); MU pools, aux targets and every gate keep working
   * unchanged.
   */
  setBackend(backend: RaycastBackend | null): void {
    this._backend = backend;
  }

  /** The installed pick backend (null outside editor mode). */
  get backend(): RaycastBackend | null {
    return this._backend;
  }

  /** Install an ADDITIONAL backend next to the primary one (idempotent). */
  addBackend(backend: RaycastBackend): void {
    if (!this._extraBackends.includes(backend)) this._extraBackends.push(backend);
  }

  /** Remove an additional backend. Safe on an unknown one. */
  removeBackend(backend: RaycastBackend): void {
    const i = this._extraBackends.indexOf(backend);
    if (i >= 0) this._extraBackends.splice(i, 1);
  }

  /** Any backend installed (primary or additional)? */
  private _hasBackend(): boolean {
    return this._backend !== null || this._extraBackends.length > 0;
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
  addAuxRaycastTarget(mesh: Object3D, owner: Object3D, opts?: AuxRaycastTargetOptions): void {
    if (!this._auxOwners.has(mesh)) {
      this._auxTargets.push(mesh);
      this._targets.push(mesh);
    }
    this._auxOwners.set(mesh, owner);
    if (opts?.onTop) this._auxOnTop.add(mesh);
    else this._auxOnTop.delete(mesh);
    if (opts?.pickOnly) this._auxPickOnly.add(mesh);
    else this._auxPickOnly.delete(mesh);
  }

  /** Remove an auxiliary raycast target. Safe to call with an unregistered mesh. */
  removeAuxRaycastTarget(mesh: Object3D): void {
    const i = this._auxTargets.indexOf(mesh);
    if (i >= 0) this._auxTargets.splice(i, 1);
    const j = this._targets.indexOf(mesh);
    if (j >= 0) this._targets.splice(j, 1);
    this._auxOwners.delete(mesh);
    this._auxOnTop.delete(mesh);
    this._auxPickOnly.delete(mesh);
  }

  /**
   * Distance order, with the on-top aux targets (drawn over everything —
   * WebLabel billboards) moved to the front: what is painted on top is what
   * the pointer is on, however far behind the scene geometry its sprite sits.
   * Stable within each group; allocation-free when nothing is on top.
   */
  private _orderHits(hits: Intersection<Object3D>[]): Intersection<Object3D>[] {
    hits.sort(_byDistance);
    if (this._auxOnTopCount === 0) return hits;
    let write = 0;
    for (let i = 0; i < hits.length; i++) {
      if (!this._auxOnTop.has(hits[i].object)) continue;
      if (i !== write) {
        const h = hits[i];
        for (let k = i; k > write; k--) hits[k] = hits[k - 1];
        hits[write] = h;
      }
      write++;
    }
    return hits;
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
    /** Set when the hit is a pooled (InstancedMesh) MU — it has no node of its own (plan-567). */
    instancedMU?: InstancedMovingUnit;
  } | null {
    // Empty targets is NOT "nothing pickable" when a backend is installed
    // (a model without MU pools has only backend geometry).
    if (!this.registry || (this._targets.length === 0 && !this._hasBackend())) return null;
    if (this.pickBlocked?.()) return null;
    pointerToNDC(e.clientX, e.clientY, this.renderer.domElement, this.pointer);

    this.raycaster.setFromCamera(this.pointer, this.getCamera());
    return this._resolveFirstEnabledHit(this._rankForWirePick(this._timedIntersect()));
  }

  /**
   * RAW GEOMETRY pick (plan-779, planner Align tool): the nearest visible
   * triangle under the pointer — mesh, triangle index and its three vertex
   * indices — WITHOUT the allow filter, the ancestor overrides and pick
   * ownership. A documented exception to doc-bake-picking-internals § 2.3 contract 3 (rule 15):
   * a tool that snaps to geometry needs the triangle, not the selectable node,
   * and must reach the main model while the planner's allow filter only admits
   * placements. Still honoured: exclude filters, on-top / aux gizmo hulls,
   * objects tagged `userData._isAlignOverlay`, effective visibility of
   * non-chunk meshes (chunks skip hidden segments themselves), instanced and
   * skinned meshes (no usable corner). Reads the chunk index, never writes it.
   * Changes no hover state; independent of {@link setEnabled}.
   */
  pickDetailed(e: { clientX: number; clientY: number }): {
    mesh: Mesh;
    faceIndex: number;
    face: { a: number; b: number; c: number };
    point: Vector3;
  } | null {
    if (!this.registry || (this._targets.length === 0 && !this._hasBackend())) return null;
    if (this.pickBlocked?.()) return null;
    pointerToNDC(e.clientX, e.clientY, this.renderer.domElement, this.pointer);
    const prevFar = this.raycaster.far;
    const prevNear = this.raycaster.near;
    try {
      this.raycaster.setFromCamera(this.pointer, this.getCamera());
      const hits = this._timedIntersect();
      for (let i = 0; i < hits.length; i++) {
        const hit = hits[i];
        const obj = hit.object;
        if (!hit.face || hit.faceIndex === undefined || hit.faceIndex === null) continue;
        if (!(obj as Mesh).isMesh) continue;
        if ((obj as InstancedMesh).isInstancedMesh || (obj as { isSkinnedMesh?: boolean }).isSkinnedMesh) continue;
        if (this._isExcluded(obj) || this._auxOnTop.has(obj) || this._auxOwners.has(obj)) continue;
        if (obj.userData?._isAlignOverlay) continue;
        // Chunk hits carry rvSegment: the pick structure already skipped hidden
        // segments. Plain meshes (keep meshes, unbaked content) are not filtered
        // by three.js for a hidden ancestor, so gate them here.
        const isChunkHit = (hit as { rvSegment?: number }).rvSegment !== undefined;
        if (!isChunkHit) {
          if (!isEffectivelyVisible(obj)) continue;
          if (this._isolationGate && !this._isolationGate(obj)) continue;
        }
        return {
          mesh: obj as Mesh,
          faceIndex: hit.faceIndex,
          face: { a: hit.face.a, b: hit.face.b, c: hit.face.c },
          point: hit.point,
        };
      }
      return null;
    } finally {
      // setFromCamera writes near/far for the ortho camera, so both are restored.
      this.raycaster.far = prevFar;
      this.raycaster.near = prevNear;
    }
  }

  /**
   * Wireframe view (asset editor): rank the hits of one ray by how close the
   * cursor is to a wire line instead of by depth, so a part seen through a
   * cover can be hovered and clicked. Applies to the screen pick and to hover —
   * the two paths a user points with; surface probes and arbitrary-ray picks
   * keep their depth order. See rv-wire-pick.ts.
   */
  setWirePickMode(on: boolean): void {
    this._wirePick = on;
  }

  private _wirePick = false;

  private _rankForWirePick(hits: Intersection<Object3D>[]): Intersection<Object3D>[] {
    if (this._wirePick) {
      const el = this.renderer.domElement;
      rankHitsByWireProximity(hits, this.raycaster.ray, this.getCamera(), el.clientWidth, el.clientHeight);
    }
    return hits;
  }

  /**
   * Pick along an ARBITRARY ray instead of a screen position (plan-705).
   *
   * Runs through the SAME resolution chain as raycastForRVNodeDetailed
   * (_timedIntersect → _isExcluded → _resolveHit → _isTypeEnabled) so the
   * visibility, isolation and hover-type gates cannot drift apart
   * (contract-bake-picking.md §2.4 contract 4: do not bypass the resolution
   * pipeline; contract 2: never raycast render meshes or arenas directly).
   * Changes NO hover state and adds no per-frame work — one call per use.
   *
   * Used by `web_camera_fly` (ground=true) to find the surface below the camera.
   */
  raycastRay(origin: Vector3, direction: Vector3, far?: number): {
    path: string;
    hitPoint: [number, number, number];
    hitNormal: [number, number, number];
  } | null {
    if (!this.registry || (this._targets.length === 0 && !this._hasBackend())) return null;
    const dir = direction.clone();
    if (dir.lengthSq() === 0) return null;
    dir.normalize();
    const prevFar = this.raycaster.far;
    const prevNear = this.raycaster.near;
    try {
      this.raycaster.set(origin, dir);
      if (typeof far === 'number' && Number.isFinite(far) && far > 0) this.raycaster.far = far;
      return this._resolveFirstEnabledHit(this._timedIntersect());
    } finally {
      // setFromCamera writes near/far for the ortho camera, so both are restored.
      this.raycaster.far = prevFar;
      this.raycaster.near = prevNear;
    }
  }

  /**
   * NAVIGATION pick (plan-515 §2.3, R2-5): the first surface under the cursor
   * that navigation may anchor on.
   *
   * Same hit collection and the same resolution chain as
   * {@link raycastForRVNodeDetailed} (exclude filters → `_resolveHit` with its
   * visibility / isolation / allow gates) — but WITHOUT the hover-type gate
   * (`_isTypeEnabled`): a visible, non-isolated part is a surface whether or not
   * its type is currently hover-enabled. `RAYCAST_BLOCKED` (opaque geometry
   * without a pick owner) answers `true` with `blocked = true` and the
   * blocker's point/distance; transparent unowned segments and hidden nodes pass
   * (they resolve to null / are skipped by the backend). `false` = background.
   *
   * Writes into the caller-owned `out` (no result allocation of its own; the
   * shared pipeline underneath still allocates — see plan-515 R2-7). Changes
   * no hover state.
   *
   * @param ignoreAllowFilter Skips ONLY the allow filter for this call — a
   *   documented option of the one pipeline (contract-bake-picking rule 15).
   *   Passed by measurement, annotation and the planner drag; never by
   *   navigation, hover or click.
   * @param includePickOnly Pick-only hulls count (planner drag: a chain's only geometry).
   */
  raycastSurface(clientX: number, clientY: number, out: SurfaceHit, ignoreAllowFilter = false, includePickOnly = false): boolean {
    pointerToNDC(clientX, clientY, this.renderer.domElement, this.pointer);
    this.raycaster.setFromCamera(this.pointer, this.getCamera());
    if (!ignoreAllowFilter || !this._allowFilter) return this._surfaceFromCurrentRay(out, includePickOnly);
    const allow = this._allowFilter;
    this._allowFilter = null;
    try {
      return this._surfaceFromCurrentRay(out, includePickOnly);
    } finally {
      this._allowFilter = allow;
    }
  }

  /**
   * {@link raycastSurface} along an arbitrary world-space ray (origin +
   * direction, no pointer) — e.g. a WebLabel casting straight down to find the
   * object it pins to. Same gates, same answer shape.
   */
  raycastSurfaceAlong(origin: Vector3, direction: Vector3, out: SurfaceHit): boolean {
    this.raycaster.set(origin, direction);
    // Sprites (label billboards) raycast against `raycaster.camera`.
    this.raycaster.camera = this.getCamera();
    return this._surfaceFromCurrentRay(out);
  }

  /**
   * The FIRST hit along a world-space ray that belongs to `node` (self or a
   * descendant), looking PAST everything else — other nodes, owner-less
   * blocking chunk geometry, overlays. `out` receives the hit point and
   * distance. The WebLabel pin uses it to cast straight down onto the object
   * it names whatever is in between.
   */
  raycastNodeAlong(origin: Vector3, direction: Vector3, node: Object3D, out: { point: Vector3; distance: number }): boolean {
    if (!this.registry || (this._targets.length === 0 && !this._hasBackend())) return false;
    this.raycaster.set(origin, direction);
    this.raycaster.camera = this.getCamera();
    const hits = this._timedIntersect();
    for (let i = 0; i < hits.length; i++) {
      const hit = hits[i];
      if (this._isExcluded(hit.object) || this._auxOnTop.has(hit.object)) continue;
      const resolved = this._resolveHit(hit);
      if (!resolved || resolved === RAYCAST_BLOCKED) continue;
      let o: Object3D | null = resolved.node;
      for (; o; o = o.parent) if (o === node) break;
      if (!o) continue;
      out.point.copy(hit.point);
      out.distance = hit.distance;
      return true;
    }
    return false;
  }

  private _surfaceFromCurrentRay(out: SurfaceHit, includePickOnly = false): boolean {
    if (out.ray) {
      out.ray.origin.copy(this.raycaster.ray.origin);
      out.ray.direction.copy(this.raycaster.ray.direction);
    }
    if (!this.registry || (this._targets.length === 0 && !this._hasBackend())) return false;
    const hits = this._timedIntersect();
    const resolveStart = this._metrics ? performance.now() : 0;
    for (let i = 0; i < hits.length; i++) {
      const hit = hits[i];
      if (this._isExcluded(hit.object)) continue;
      // On-top overlays (WebLabel billboard) and pick-only hulls are no surface.
      if (this._auxOnTop.has(hit.object) || (!includePickOnly && this._auxPickOnly.has(hit.object))) continue;
      const resolved = this._resolveHit(hit);
      if (resolved === RAYCAST_BLOCKED) {
        out.point.copy(hit.point);
        out.distance = hit.distance;
        out.blocked = true;
        out.path = null;
        if (out.normal) writeWorldNormal(hit, out.normal);
        if (this._metrics) this._reportPick(performance.now() - resolveStart, true);
        return true;
      }
      if (!resolved) continue;
      out.point.copy(hit.point);
      out.distance = hit.distance;
      out.blocked = false;
      out.path = resolved.nodePath;
      if (out.normal) writeWorldNormal(hit, out.normal);
      if (this._metrics) this._reportPick(performance.now() - resolveStart, true);
      return true;
    }
    if (this._metrics) this._reportPick(performance.now() - resolveStart, false);
    return false;
  }

  /**
   * Shared hit-selection tail: first non-excluded, resolvable, type-enabled hit.
   * Extracted (plan-705) so the screen pick and the ray pick cannot grow two
   * different copies of the gate order.
   */
  private _resolveFirstEnabledHit(hits: Intersection<Object3D>[]): {
    path: string;
    hitPoint: [number, number, number];
    hitNormal: [number, number, number];
    instancedMU?: InstancedMovingUnit;
  } | null {
    const resolveStart = this._metrics ? performance.now() : 0;

    for (const hit of hits) {
      if (this._isExcluded(hit.object)) continue;

      const resolved = this._resolveHit(hit);
      // Opaque geometry without a pick owner ends the search (plan-756 Q5).
      if (resolved === RAYCAST_BLOCKED) break;
      if (!resolved) continue; // Unresolved mesh — skip, don't block hits behind it

      if (this._isTypeEnabled(resolved.nodeType)) {
        const normal = hit.face?.normal?.clone().transformDirection(hit.object.matrixWorld);
        if (this._metrics) this._reportPick(performance.now() - resolveStart, true);
        return {
          path: resolved.nodePath,
          hitPoint: [hit.point.x, hit.point.y, hit.point.z],
          hitNormal: normal ? [normal.x, normal.y, normal.z] : [0, 1, 0],
          ...(resolved.instancedMU ? { instancedMU: resolved.instancedMU } : {}),
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
    if (this._targets.length === 0 && !this._hasBackend()) return null;
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
        if (resolved === RAYCAST_BLOCKED) break;
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
    if (this._hoverFrameHandle !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(this._hoverFrameHandle);
    }
    this._hoverFrameHandle = null;
    this._pointerMovedSinceRay = false;
    this.renderer.domElement.removeEventListener('pointermove', this.onPointerMove);
    this.renderer.domElement.removeEventListener('pointerleave', this.onPointerLeave);
    this.renderer.domElement.removeEventListener('pointerdown', this.onPointerDownCapture, { capture: true } as EventListenerOptions);
    this._clearHover();
  }

  // ─── Private ──────────────────────────────────────────────────────

  /** Rebuild the cached target list from the instanced meshes + aux targets. */
  private _rebuildTargetList(): void {
    this._targets = [];

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

    if (!this._enabled || this.pickBlocked?.()) {
      this._clearHover();
      return;
    }

    // plan-756 F7: with a `'frame'`-cadence backend installed, the ray is paced
    // by the animation frame instead of a 50 ms clock. It is still the POINTER
    // that triggers it — a camera move with a stationary pointer produces no
    // pointermove, hence no ray, exactly as before this change.
    if (this._framePacedHover()) {
      this._pendingPointerX = e.clientX;
      this._pendingPointerY = e.clientY;
      this._pointerMovedSinceRay = true;
      this._scheduleHoverFrame();
      return;
    }

    const now = performance.now();
    if (now - this.lastRaycastMs < THROTTLE_MS) return;
    this._sampleHover(e.clientX, e.clientY);
  }

  /** Is any installed backend asking for frame-paced hover (plan-756 F7)? */
  private _framePacedHover(): boolean {
    if (this._backend?.hoverCadence === 'frame') return true;
    for (let i = 0; i < this._extraBackends.length; i++) {
      if (this._extraBackends[i].hoverCadence === 'frame') return true;
    }
    return false;
  }

  /**
   * Queue ONE hover sample for the next animation frame — at most one ray per
   * frame, no matter how many pointermove events arrive in between, and none at
   * all when the pointer did not move.
   *
   * It is deliberately `requestAnimationFrame` and NOT the viewer's render loop:
   * a hover ray must never make the page render (render-on-demand, §1.4). Only a
   * CHANGED hover result marks the scene dirty, through the highlight manager,
   * exactly as on the throttled path. Without `requestAnimationFrame` (SSR, a
   * bare unit-test environment) the throttle answers instead, so hover never
   * stops working.
   */
  private _scheduleHoverFrame(): void {
    if (this._hoverFrameHandle !== null) return;
    if (typeof requestAnimationFrame !== 'function') {
      if (performance.now() - this.lastRaycastMs < THROTTLE_MS) return;
      this._sampleHover(this._pendingPointerX, this._pendingPointerY);
      return;
    }
    this._hoverFrameHandle = requestAnimationFrame(() => {
      this._hoverFrameHandle = null;
      if (!this._pointerMovedSinceRay || !this._enabled || this.pickBlocked?.()) return;
      this._sampleHover(this._pendingPointerX, this._pendingPointerY);
    });
  }

  /** One pointer-hover ray from a client position (the only hover ray path). */
  private _sampleHover(clientX: number, clientY: number): void {
    this._pointerMovedSinceRay = false;
    this._sampleNowMs = performance.now();
    this.lastRaycastMs = this._sampleNowMs;
    pointerToNDC(clientX, clientY, this.renderer.domElement, this.pointer);
    this.raycaster.setFromCamera(this.pointer, this.getCamera());
    this._hoverSampling = true;
    this._hoverSkippedBackend = false;
    try {
      this._doRaycast();
    } finally {
      this._hoverSampling = false;
      this._hoverSkippedBackend = false;
    }
  }

  /**
   * May `backend` answer the ray that is running right now?
   *
   * Only a POINTER HOVER sample can say no, and only to a `'throttled'` backend
   * inside its own 50 ms window — which is how the old editor backend keeps its
   * cadence while the baked one runs per frame (plan-756 F7, "per backend, not
   * global"). Outside hover (click, AR tap, XR, explicit `raycast*`) every
   * backend always answers.
   */
  private _hoverAllows(backend: RaycastBackend): boolean {
    if (!this._hoverSampling) return true;
    if ((backend.hoverCadence ?? 'throttled') === 'frame') return true;
    const last = this._backendLastHoverMs.get(backend);
    if (last !== undefined && this._sampleNowMs - last < THROTTLE_MS) {
      this._hoverSkippedBackend = true;
      return false;
    }
    this._backendLastHoverMs.set(backend, this._sampleNowMs);
    return true;
  }

  /**
   * Resolve a raycast intersection to a realvirtual node.
   * Handles backend hits (chunk windows, instance pick index), aux targets
   * and InstancedMesh MU hits.
   */
  private _resolveHit(hit: PickHit): {
    node: Object3D;
    nodeType: string;
    nodePath: string;
    instancedMU?: InstancedMovingUnit;
  } | null | typeof RAYCAST_BLOCKED {
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
      // A gizmo that is not drawn must not catch the pointer. three.js raycasts
      // a target mesh regardless of a hidden ANCESTOR (the gizmo manager hides
      // an entry by its root group, e.g. an inactive WebError flash hull), so
      // gate on the gizmo's own effective visibility, not only the owner's —
      // otherwise an invisible hull over a whole station steals every pick of
      // the parts below it (editor per-part picking, plan-756 occlusion). The
      // one deliberate exception is the EnergyChain envelope proxy, which is
      // a pick-only mesh and invisible BY DESIGN (`_rvEnergyChainProxy`).
      if (!hit.object.userData?.[RV_CHAIN_PROXY] && !isEffectivelyVisible(hit.object)) return null;
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
    // Node-resolving backends first (chunk pick backend, plan-753 F3): the
    // innermost face window IS the target — no metadata promotion.
    for (let i = 0; i < this._extraBackends.length; i++) {
      const b = this._extraBackends[i];
      if (!b.resolveHit) continue;
      const node = b.resolveHit(hit);
      // Occluding but unpickable (plan-756 Q5) — no fall-through (see _blocks).
      if (node === RAYCAST_BLOCKED) return this._blocks(hit.object);
      if (node) return this._resolveFromNode(node);
    }
    if (this._backend?.resolveHit) {
      const node = this._backend.resolveHit(hit);
      if (node === RAYCAST_BLOCKED) return this._blocks(hit.object);
      if (node) return this._resolveFromNode(node);
    }
    const backendPath = this._backend?.resolvePath(hit.object);
    if (backendPath) return this._resolveFromPath(backendPath, true);
    for (let i = 0; i < this._extraBackends.length; i++) {
      const p = this._extraBackends[i].resolvePath(hit.object);
      if (p) return this._resolveFromPath(p, true);
    }
    // Not a backend mesh, not an aux target, not an MU pool: nothing answers.
    return null;
  }

  /** A blocker counts only inside the isolation (chunk and keep alike). */
  private _blocks(obj: Object3D): typeof RAYCAST_BLOCKED | null {
    return !this._isolationGate || this._isolationGate(obj) ? RAYCAST_BLOCKED : null;
  }

  /**
   * Shared resolution tail for every path-resolved hit (the pick backends):
   * registry lookup → ancestor overrides →
   * visibility gate → isolation gate → allow filter. The node stays EXACT:
   * no component or metadata promotion (editor contract, see below).
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

    // No component promotion: the path-resolving backend (the editor's
    // instance pick index) answers with the EXACT node, and the owning
    // component is surfaced separately (findPickOwner). Grouping a part under
    // its RuntimeMetadata / Drive / … owner is the bake's job (segment owner =
    // nearest pickable ancestor), never this tail's.
    const resolvedNode = node;
    const resolvedPath = objectPath;

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
   * Gate tail for a NODE-resolved backend hit (plan-753 F3): ancestor
   * overrides → visibility → isolation → allow. No metadata promotion — the
   * chunk table already answers with the innermost pick node (Decision 7). An
   * unregistered node (a logic node `processExtras` did not register) falls
   * back to its nearest registered ancestor so the click can still select.
   */
  private _resolveFromNode(node: Object3D): {
    node: Object3D;
    nodeType: string;
    nodePath: string;
  } | null {
    let resolved: Object3D | null = node;
    let path = this.registry.getPathForNode(node);
    while (!path && resolved) {
      resolved = resolved.parent;
      if (resolved) path = this.registry.getPathForNode(resolved);
    }
    if (!path || !resolved) return null;

    for (const override of this._ancestorOverrides) {
      const overrideNode = override(resolved);
      if (overrideNode) {
        const overridePath = this.registry.getPathForNode(overrideNode);
        if (overridePath) {
          if (!isEffectivelyVisible(overrideNode)) return null;
          if (this._isolationGate && !this._isolationGate(overrideNode)) return null;
          if (this._allowFilter && !this._allowFilter(overrideNode)) return null;
          return { node: overrideNode, nodeType: this._resolveNodeType(overrideNode), nodePath: overridePath };
        }
      }
    }

    if (!isEffectivelyVisible(resolved)) return null;
    if (this._isolationGate && !this._isolationGate(resolved)) return null;
    if (this._allowFilter && !this._allowFilter(resolved)) return null;
    return { node: resolved, nodeType: this._resolveNodeType(resolved), nodePath: path };
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
        if (getCapabilities(t).pick !== 'none') return t;
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
    for (const type of getPickableTypes()) {
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
    if (!this._hasBackend()) {
      return this._orderHits(this.raycaster.intersectObjects(this._targets, false));
    }
    const hits: Intersection<Object3D>[] = [];
    if (this._backend && this._hoverAllows(this._backend)) this._backend.raycast(this.raycaster, hits);
    for (let i = 0; i < this._extraBackends.length; i++) {
      const b = this._extraBackends[i];
      if (this._hoverAllows(b)) b.raycast(this.raycaster, hits);
    }
    for (let i = 0; i < this._targets.length; i++) {
      this.raycaster.intersectObject(this._targets[i], false, hits);
    }
    return this._orderHits(hits);
  }

  /**
   * `_collectHits` with per-category timing (primary backend / additional
   * backends / other). The primary backend's time lands in the `static` slot
   * (in editor mode the instance pick index IS the whole scene geometry), the
   * chunk pick backend's in `kinematic`, MU pools + aux targets in `other`.
   * Timings land in `_lastIntersectTimings`; the caller reports them via
   * `_metrics.recordRaycast(...)` once the hit outcome is known.
   */
  private _timedIntersect(): Intersection<Object3D>[] {
    if (!this._metrics) {
      return this._collectHits();
    }
    const hits: Intersection<Object3D>[] = [];
    const t0 = performance.now();
    if (this._backend && this._hoverAllows(this._backend)) this._backend.raycast(this.raycaster, hits);
    const t1 = performance.now();
    for (let b = 0; b < this._extraBackends.length; b++) {
      const backend = this._extraBackends[b];
      if (this._hoverAllows(backend)) backend.raycast(this.raycaster, hits);
    }
    const t2 = performance.now();
    for (let i = 0; i < this._targets.length; i++) this.raycaster.intersectObject(this._targets[i], false, hits);
    this._orderHits(hits);
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
    if (this._targets.length === 0 && !this._hasBackend()) {
      this._clearHover();
      return;
    }

    const hits = this._rankForWirePick(this._timedIntersect());
    const resolveStart = this._metrics ? performance.now() : 0;

    let hitNode: Object3D | null = null;
    let hitType: string | null = null;
    let hitPath: string | null = null;
    let hitInstancedMU: InstancedMovingUnit | null = null;
    let hitPoint: [number, number, number] | null = null;

    for (const hit of hits) {
      if (this._isExcluded(hit.object)) continue;

      const resolved = this._resolveHit(hit);
      // Opaque geometry without a pick owner ends the search (plan-756 Q5).
      if (resolved === RAYCAST_BLOCKED) break;
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
      // A hover sample that SKIPPED a throttled backend (inside its 50 ms window,
      // plan-756 F7) has not looked at that backend's geometry — an empty result
      // is inconclusive, not "nothing under the pointer". Clearing here made the
      // editor hover flicker at 50 ms once the frame-paced baked backend paced
      // the ray per frame (2026-09-22: `_hlOverlay` / `_hlEdge` torn down and
      // rebuilt every frame while the pointer sat on one part). Keep the state
      // until a sample that asked every backend answers.
      if (this._hoverSkippedBackend) return;
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
      this.renderer.domElement.style.cursor = this.cursorOverride?.() ?? '';

      this.emitter.emit('object-unhover', { node: prevNode, nodeType: prevType });
    }
  }
}
