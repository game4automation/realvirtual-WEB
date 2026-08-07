// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import {
  Object3D, Mesh, Vector3, Quaternion, MeshBasicMaterial,
  LineSegments, EdgesGeometry, LineBasicMaterial,
  type Material, type Sprite, type Texture,
} from 'three';
import {
  RVMovingUnit, InstancedMovingUnit, MUInstancePool,
  computeTemplateAABBInfo, analyzeTemplate,
} from './rv-mu';
import type { IMUAccessor } from './rv-mu';
import type { ComponentSchema, ComponentContext, RVComponent } from './rv-component-registry';
import { registerComponent, loadSchemaFromSpec } from './rv-component-registry';
import type { CollisionRoleName } from './rv-collision-role';
import { NodeRegistry } from './rv-node-registry';
import { debug } from './rv-debug';
import { MM_TO_METERS } from './rv-constants';
import { buildSourceMarker } from './rv-source-marker';
import { applyShadowFlags } from './rv-mesh-classifier';
import type { RVTransportManager } from './rv-transport-manager';
import { RVTransportSurface } from './rv-transport-surface';
import { AABB } from './rv-aabb';
import type { EventEmitter } from '../rv-events';
import type { ViewerEvents } from '../rv-viewer-events';
import {
  classifySourcePlacement, anyMUOnSurfaces,
  OCCUPANCY_GATED_BEHAVIORS, SURFACE_TOP_EPS_M,
  type SourcePlacement,
} from './rv-source-placement';

// Pre-allocated temp vectors (no GC in hot path)
const _sourcePos = new Vector3();
const _lastMUPos = new Vector3();
const _placementPos = new Vector3();
const _dischargeDir = new Vector3();
// Spawn orientation (Unity parity: Instantiate(template, transform.position, transform.rotation)
// — `transform.rotation` is the WORLD rotation, so a spawned MU inherits the source's world
// orientation instead of defaulting to identity).
const _spawnQuat = new Quaternion();
const _spawnParentQuat = new Quaternion();

/**
 * True when `n` carries no local transform (identity position/rotation/scale).
 */
export function isTransformNeutral(n: Object3D): boolean {
  const { position: t, quaternion: q, scale: s } = n;
  return (
    t.x === 0 && t.y === 0 && t.z === 0 &&
    q.x === 0 && q.y === 0 && q.z === 0 && q.w === 1 &&
    s.x === 1 && s.y === 1 && s.z === 1
  );
}

/**
 * Resolve the node spawned MUs are parented to.
 *
 * Two invariants, both load-bearing:
 *
 * 1. MUs must never be added inside the source's own subtree — a self-template
 *    source would then `clone()` a growing subtree (exponential nesting), and
 *    every MU would ride along with the source.
 * 2. The parent must be WORLD-ALIGNED. `RVTransportSurface` advances an MU by
 *    adding a WORLD-space delta to `RVMovingUnit.setPosition()`, which writes
 *    `node.position` — a LOCAL value — and eases the MU toward a WORLD-space
 *    centre line. Both only hold while local space === world space. Parenting an
 *    MU under a layout PLACEMENT ROOT (the planner stamps the placement pose
 *    onto it, and since `ensureNeutralPlacementRoot()` that root may be an
 *    inserted identity Group rather than the asset itself) makes the surface
 *    drag the MU sideways off the belt every tick.
 *
 *    Placement roots are rejected STRUCTURALLY, by their `_layoutId` marker, not
 *    by inspecting their transform: the planner stamps `_layoutId` before
 *    `processExtras()` runs but applies the placement POSE afterwards, so at
 *    resolve time the root still looks transform-neutral. The extra
 *    `isTransformNeutral` check stays as a backstop for any other transformed
 *    ancestor.
 */
/**
 * True when `n` is a layout-planner placement root. Mirrors the `_layoutId`
 * predicate used across the planner (see `layout-predicates.ts`); `_layoutObject`
 * is set on every descendant and therefore cannot identify the root.
 */
export function isLayoutPlacementRoot(n: Object3D): boolean {
  return typeof n.userData?.['_layoutId'] === 'string';
}

export function resolveSpawnParent(contextRoot: Object3D, sourceNode: Object3D): Object3D {
  let candidate: Object3D = contextRoot;
  for (let p: Object3D | null = contextRoot; p; p = p.parent) {
    if (p === sourceNode) {
      candidate = sourceNode.parent ?? contextRoot;
      break;
    }
  }
  // Walking UP can never re-enter the source's subtree, so invariant 1 holds.
  while (
    (isLayoutPlacementRoot(candidate) || !isTransformNeutral(candidate)) &&
    candidate.parent
  ) {
    candidate = candidate.parent;
  }
  return candidate;
}

/** Reused spawn-gate query bounds (plan-255 F6a) — only min/max are used. */
const _spawnAreaAABB = new AABB();

/** How often (seconds) a source re-resolves what it stands on. Matches the Conveyor behavior's
 *  neighbour-refresh cadence — fast enough to react to topology changes, cheap enough to ignore. */
const PLACEMENT_REFRESH_SEC = 0.5;

/**
 * Strip authored component / layout metadata from a cloned subtree so it can
 * never be re-instantiated as a live component (Source, Drive, …) or treated
 * as a selectable Layout-Planner object.
 *
 * Three.js `Object3D.clone()` deep-copies `userData`, so the source's ghost,
 * held preview, and every spawned-MU clone would otherwise inherit the source's
 * `realvirtual` rv-extras (including its `Source` entry). When the placed
 * subtree is later (re)processed by `processExtras` (placement re-scan,
 * persistence restore, layout op, multiuser sync) those copies get turned into
 * live `RVSource`s — which spawn their own clones recursively and nest under
 * the source. Removing the metadata from clones breaks that cycle. Pure-visual
 * markers (`_isSourceGhost`, `_isSourcePreview`) are intentionally preserved.
 */
function stripComponentMetadata(obj: Object3D): void {
  obj.traverse((child) => {
    const ud = child.userData;
    if (!ud) return;
    delete ud.realvirtual;
    delete ud._layoutObject;
    delete ud._layoutId;
  });
}

// Transparent-source look: the real source fill is hidden (no colour/depth
// write → full x-ray, never occludes the scene behind it) and replaced by a
// translucent white shell + a white edge outline, so the template reads as a
// frosted ghost distinct from the solid spawned MUs. Cheap (no stencil / no
// render-target changes); where the object's own faces overlap in x-ray the
// shell blends slightly denser, which is acceptable for this marker. All shared
// + module-lived (never disposed); `depthWrite:false` keeps them from occluding
// and the high `renderOrder` per overlay draws them on top.
const _sourceFillHiddenMaterial = new MeshBasicMaterial({ colorWrite: false, depthWrite: false });
const _sourceFillShellMaterial = new MeshBasicMaterial({
  color: 0xffffff,
  transparent: true,
  opacity: 0.22,
  depthWrite: false,
});
const _sourceEdgeMaterial = new LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9 });

/**
 * Node → engine RVSource map for the DES path (off-node, see init()). Kept here
 * (module WeakMap) instead of `userData` because Object3D.clone() JSON-serializes
 * userData and an RVSource ref is circular. Auto-released when the node is GC'd.
 */
const _engineSourceByNode = new WeakMap<Object3D, RVSource>();

/** Resolve the engine RVSource bound to a source LayoutObject node (or null).
 *  The DES runner uses it to clone real MU meshes for its event-driven MUs. */
export function getEngineSourceForNode(node: Object3D): RVSource | null {
  return _engineSourceByNode.get(node) ?? null;
}

/** Bind an engine RVSource to a node (what `init()` does internally). Exported
 *  for tests / custom wirings that stub the source — e.g. the DES headless-MU
 *  materialisation path resolves its visual factory through this map. */
export function registerEngineSourceForNode(node: Object3D, source: RVSource): void {
  _engineSourceByNode.set(node, source);
}

/**
 * RVSource - Spawns new MU instances at regular intervals or by distance.
 *
 * Uses a template MU node from the GLB (found by name) and clones it.
 * Template is hidden at load time and used as a clone source.
 */
export class RVSource implements RVComponent {
  // Loaded from the rv-ODT specification (schema/v1/rv-odt.json, plan-187).
  static readonly schema: ComponentSchema = loadSchemaFromSpec('Source');

  readonly node: Object3D;
  isOwner = true;

  // Properties — exact C# Inspector field names
  AutomaticGeneration = true;
  Interval = 0;
  GenerateIfDistance = 300;
  PlaceOnTransportSurface = true;
  ThisObjectAsMU = '';
  /** Collision role handed to every MU this source spawns (plan-394). It cannot
   *  live on the MU itself: `stripComponentMetadata()` deletes the clone's
   *  rv_extras, so the role travels via the transport manager's spawn hook. */
  CollisionRoleForMUs: CollisionRoleName = 'None';

  // Derived properties (computed from schema properties)
  spawnMode: 'Interval' | 'Distance' | 'OnSignal' = 'Interval';
  spawnInterval = 3;
  spawnDistance = 300;
  muName = '';
  sourceIsTemplate = false;

  /** Template to clone for new MUs */
  muTemplate: Object3D | null = null;
  /** Cached half-size from template (computed once) */
  private templateHalfSize: Vector3 | null = null;
  /** Cached local center offset from template (mesh center vs node origin) */
  private templateLocalCenter: Vector3 | null = null;

  /** Timer for interval-based spawning */
  private timer = 0;
  /** Counter for unique MU names */
  private spawnCount = 0;
  /** Last spawned MU (for distance mode) */
  private lastSpawnedMU: (RVMovingUnit | InstancedMovingUnit) | null = null;
  /** MU ID counter for instanced MUs */
  private muIdCounter = 0;

  /** Parent scene node to add spawned MUs to */
  spawnParent: Object3D | null = null;

  /** Instance pool (non-null when template uses instancing) */
  pool: MUInstancePool | null = null;

  /** Whether this source uses instancing (determined by template analysis) */
  useInstancing = false;

  /** Raw GLB extras for computing spawn config in init() */
  rawExtras: Record<string, unknown> | null = null;

  // ── Placement detection (what the source stands on) ──────────────────
  /** Transport manager — provides the live surface + MU sets for placement. */
  private transportManager: RVTransportManager | null = null;
  /** Viewer event bus — invalidates the placement cache on planner moves. */
  private events: EventEmitter<ViewerEvents> | null = null;
  /** Unsubscribe for the `layout-transform-update` subscription. */
  private _unsubPlacement: (() => void) | null = null;
  /** Cached placement classification; drives the spawn gate in `update()`. */
  private _placement: SourcePlacement<RVTransportSurface> =
    { mode: 'none', surface: null, conveyorRoot: null, conveyorSurfaces: [] };
  /** Accumulator for throttled placement re-resolution. */
  private _placementTimer = 0;
  /** False forces a re-resolve on the next update (initial + after a planner move). */
  private _placementResolved = false;

  /** Always-visible ghost CLONE of the spawned MU (separate-template case),
   *  shown at the source position: a clone of the MU template with its fill
   *  hidden and a white edge outline (the transparent-source look). Lets the
   *  user always see (and select / place in the Layout-Planner) the source, even
   *  before the first MU spawns and while the simulation runs. The real
   *  source/template materials are NEVER mutated. Null for the self-template case
   *  (which adds edges directly onto the source node — see `_edgeOverlays`).
   *  Built in `setTemplate`, removed in `dispose`. */
  private _ghostNode: Object3D | null = null;

  /** White stencil-FILL shell meshes (the uniform translucent silhouette) added
   *  on top of real meshes for the transparent-source look. Share the source
   *  geometry by reference + a module-lived material; detached on `dispose`. */
  private _overlayMeshes: Mesh[] = [];

  /** White edge-outline LineSegments added on top of real meshes for the
   *  transparent-source look (self-template: on the source node; separate-
   *  template: on the ghost clone). Each owns a per-geometry EdgesGeometry that
   *  must be disposed; the edge material is module-lived. Detached + disposed on
   *  `dispose`. */
  private _edgeOverlays: LineSegments[] = [];
  /** Real source meshes whose fill we hid for the transparent look, paired with
   *  their ORIGINAL material. Stored here (NOT in userData) because Object3D.clone()
   *  JSON-round-trips userData, which would corrupt a Material into a plain object
   *  and break spawned MUs. */
  private _hiddenFillMeshes: { mesh: Mesh; real: Material | Material[] }[] = [];

  /** Showcase instance: a real-material preview MU held at the source origin
   *  while spawning is disabled (planner). Rendered ALONGSIDE the ghost. When
   *  spawning is (re-)enabled the held instance is released into the simulation
   *  (the first real spawn) and this is cleared. Parented to `this.node` so it
   *  tracks the source as it is moved. Built lazily in `update()`. */
  private _previewInstance: Object3D | null = null;

  // ── Floor-Marker (plan-181) ─────────────────────────────────────────
  // Always-visible identifier under the source: floor ring + label sprite,
  // both children of `this.node` so they automatically track Source
  // movement (Layout-Planner drag). Built in `setTemplate` alongside the
  // ghost, freed via `_markerDispose()` in `dispose()`.
  private _markerNode: Object3D | null = null;
  private _markerRing: Mesh | null = null;
  private _markerLabel: Sprite | null = null;
  private _markerLabelTexture: Texture | null = null;
  private _markerLabelText: string | null = null;
  private _markerDispose: (() => void) | null = null;

  constructor(node: Object3D) {
    this.node = node;
  }

  /**
   * Resolve the node spawned MUs are added to. MUs must NEVER be added inside
   * the source's own subtree — that would make every MU a child of the source
   * (so it moves with the source) and, for a self-template source, each new
   * `clone()` would copy the growing subtree → exponential, nested duplication.
   *
   * The main `loadGLB` path passes the model root as `context.root` (an
   * ancestor of this source) → used as-is. The Layout-Planner places a source
   * via `processExtras(clone, …)` where `context.root` IS the placed source's
   * own subtree root → walking up from it reaches this source node, so we spawn
   * into the source's parent (the model root the clone was added to) instead.
   *
   * The result is additionally lifted to the nearest TRANSFORM-NEUTRAL ancestor
   * — see {@link resolveSpawnParent} for why that invariant is load-bearing.
   */
  private _resolveSpawnParent(contextRoot: Object3D): Object3D {
    return resolveSpawnParent(contextRoot, this.node);
  }

  /**
   * Find the MU template inside the source's own asset subtree by node name,
   * skipping the source's own ghost / overlay / preview / marker children. The
   * template ref (`muName`) may be a bare name or a relative path — match on the
   * last segment. Returns null when no in-subtree match exists (caller then
   * falls back to the global registry).
   */
  private _resolveTemplateInSubtree(root: Object3D, muName: string): Object3D | null {
    const wanted = muName.includes('/') ? muName.slice(muName.lastIndexOf('/') + 1) : muName;
    let found: Object3D | null = null;
    root.traverse((child) => {
      if (found) return;
      const ud = child.userData;
      if (ud?._isSourceGhost || ud?._isGhostOverlay || ud?._isSourcePreview || ud?._isSourceMarker) return;
      if (child.name === wanted || child.name === muName) found = child;
    });
    return found;
  }

  /**
   * Compute spawn config, resolve template, and register with transport manager.
   * Called after applySchema + resolveComponentRefs.
   */
  init(context: ComponentContext): void {
    // Read raw extras from node (self-contained — no loader dependency)
    if (!this.rawExtras) {
      const rv = this.node.userData?.realvirtual as Record<string, unknown> | undefined;
      this.rawExtras = (rv?.['Source'] as Record<string, unknown>) ?? null;
    }

    // Compute derived spawn properties from raw extras
    if (this.rawExtras) {
      this.computeSpawnConfig(this.rawExtras);
    }
    this.spawnParent = this._resolveSpawnParent(context.root);

    // Find MU template.
    let template: Object3D | null = null;
    if (this.sourceIsTemplate) {
      template = this.node;
      debug('loader', `Source: ${this.node.name} mode=${this.spawnMode} interval=${this.spawnInterval}s template=SELF`);
    } else if (this.muName) {
      // A source's MU template ALWAYS lives within its own asset subtree, so
      // search the placed clone's subtree (context.root) first. This avoids the
      // global registry's name-suffix fallback, which would otherwise resolve a
      // 2nd placement's template to the FIRST source's (hidden, ghosted) node
      // when both assets share internal node names. Fall back to the global
      // registry only when the subtree search comes up empty (e.g. the main
      // loadGLB path where context.root is the whole model root).
      template = this._resolveTemplateInSubtree(context.root, this.muName)
        ?? context.registry.getNode(this.muName);
      if (template) {
        debug('loader', `Source: ${this.node.name} mode=${this.spawnMode} interval=${this.spawnInterval}s template="${this.muName}"`);
      } else {
        console.warn(`  Source: ${this.node.name} - MU template "${this.muName}" not found`);
      }
    } else {
      console.warn(`  Source: ${this.node.name} - no MU template configured`);
    }

    // If the resolved MU template IS the source node itself (e.g. a placed
    // source whose `ThisObjectAsMU` path resolves back to its own node but did
    // not match the name-based `sourceIsTemplate` heuristic), treat it as
    // self-template so the real meshes get hidden behind the ghost (rather than
    // the source node being hidden as a separate template).
    if (template === this.node) this.sourceIsTemplate = true;

    if (template) {
      this.setTemplate(template);
    }

    // Placement detection wiring: keep the live surface/MU sets and invalidate
    // the cached placement whenever a layout object is moved in the planner so
    // the source re-detects what it stands on without polling every frame.
    this.transportManager = context.transportManager;
    this.events = context.events ?? null;
    if (this.events) {
      this._unsubPlacement = this.events.on('layout-transform-update', () => {
        this._placementResolved = false;
      });
    }

    // Register in transport manager
    context.transportManager.sources.push(this);

    // Map node → engine source so the DES path can find THIS source for
    // on-demand mesh spawning (DES reuses RVSource.spawnMU() to give its
    // event-driven MUs a visual — mirrors the Unity DESSource calling the normal
    // Source.Generate()). MUST NOT go in `node.userData`: Object3D.clone()
    // JSON-round-trips userData, and an RVSource ref is circular (→ node →
    // userData) — it would crash every MU clone. A WeakMap keeps it off the node.
    _engineSourceByNode.set(this.node, this);
  }

  /**
   * Compute derived spawn properties from schema properties.
   * Called by loader after applySchema + legacy field handling.
   */
  computeSpawnConfig(extras: Record<string, unknown>): void {
    const interval = this.Interval;
    const distance = this.GenerateIfDistance;
    const autoGen = this.AutomaticGeneration;

    let mode: 'Interval' | 'Distance' | 'OnSignal' = 'Interval';
    if (interval > 0) {
      mode = 'Interval';
    } else if (autoGen && distance > 0) {
      mode = 'Distance';
    }
    // Override with explicit Spawn field if present (legacy WebViewer format)
    const spawnStr = extras['Spawn'] as string | undefined;
    if (spawnStr === 'Distance') mode = 'Distance';
    else if (spawnStr === 'OnSignal') mode = 'OnSignal';

    this.spawnMode = mode;
    this.spawnInterval = interval > 0 ? interval : 3; // default 3s if not set
    this.spawnDistance = distance;

    // ThisObjectAsMU is serialized as a relative path string (or null/empty if self)
    const templateRef = this.ThisObjectAsMU;
    // Use the ORIGINAL (pre-rename) node name when available. The Layout-Planner
    // renames placed clones (`Foo` → `Foo_2`) BEFORE this runs, which would
    // otherwise break the `templateRef === nodeName` self-reference test for the
    // 2nd+ placement and mis-classify a self-template source as separate-template.
    const nodeName = (this.node.userData._originalName as string) ?? this.node.name;
    this.sourceIsTemplate = !templateRef || templateRef === '' ||
      templateRef === nodeName || templateRef.endsWith('/' + nodeName);
    this.muName = this.sourceIsTemplate ? nodeName : templateRef;
  }

  /** Re-derive spawn config after an inspector edit re-applied the schema.
   *  The simulation reads the DERIVED fields (spawnMode / spawnInterval /
   *  spawnDistance), not the raw GenerateIfDistance / Interval config — so an
   *  edit only takes effect once these are recomputed. Idempotent and free of
   *  subscriptions, so it is safe to call post-load.
   *  IMPLEMENTS RVComponent::reapplyConfig */
  reapplyConfig(): void {
    if (this.rawExtras) this.computeSpawnConfig(this.rawExtras);
  }

  /** Set the template MU and pre-compute its half-size and center offset */
  setTemplate(template: Object3D): void {
    this.muTemplate = template;
    const info = computeTemplateAABBInfo(template);
    this.templateHalfSize = info.halfSize;
    this.templateLocalCenter = info.localCenter;

    // Analyze template for instancing capability FIRST — captures the real
    // geometry + material before any ghost recolor below, so spawned instances
    // keep the original look.
    const analysis = analyzeTemplate(template);
    if (analysis) {
      this.useInstancing = true;
      this.pool = new MUInstancePool(
        analysis.geometry,
        analysis.material,
        template.name,
        this.templateHalfSize,
        this.templateLocalCenter ?? undefined,
      );
      debug('loader', `Source "${this.node.name}": using InstancedMesh for template "${template.name}"`);
    } else {
      this.useInstancing = false;
      debug('loader', `Source "${this.node.name}": using clone() for multi-mesh template "${template.name}"`);
    }

    if (this.sourceIsTemplate) {
      // The source node IS the MU template. The source stays visible as its
      // own real-material visual; we just add translucent white overlay shells
      // on top of its meshes so it reads as a "ghost"/template preview. No
      // clone, no hide — avoids the Three.js visibility cascade that would hide
      // a child-ghost when the source node is itself a Mesh. Spawned clones
      // strip the overlay shells (see `_buildRealClone`) so MUs render clean.
      this._addOverlayShells(this.node);
    } else {
      // Separate template: hide it and show an always-visible CLONE of the MU
      // (real materials) with white overlay shells, parented to the source so
      // it tracks the source's movement. Plus the floor marker.
      this._buildGhostClone(template);
      template.visible = false;
      this._buildMarker();
    }
  }

  /**
   * Build the always-visible source ghost CLONE (separate-template case): clone
   * the MU template (keeping real materials), strip component/layout metadata,
   * add white overlay shells, and parent it to `this.node`. The real template
   * materials are never mutated — spawned MUs share them.
   */
  private _buildGhostClone(template: Object3D): void {
    if (this._ghostNode) return; // already built (e.g. setTemplate called twice)

    const ghost = template.clone();
    // The clone inherited the template's rv-extras / layout metadata via
    // Object3D.clone(); strip them so the ghost is a pure visual and never
    // becomes a live (recursively-spawning) Source when the subtree is rescanned.
    stripComponentMetadata(ghost);
    ghost.name = `${template.name}_ghost`;
    // Reset transform — the clone inherits the template's world position,
    // but we want it anchored at the source's local origin (transform-wise
    // it becomes a direct child of `this.node`).
    ghost.position.set(0, 0, 0);
    ghost.rotation.set(0, 0, 0);
    ghost.scale.set(1, 1, 1);

    // Force every descendant visible (the template was hidden, and its
    // visibility flags carry over via clone()) and tag the subtree.
    ghost.traverse((child) => {
      child.visible = true;
      child.userData._isSourceGhost = true;
    });
    ghost.visible = true;

    // Overlay shells on top of the clone's meshes.
    this._addOverlayShells(ghost);

    this.node.add(ghost);
    this._ghostNode = ghost;
  }

  /**
   * Add translucent white overlay shells on top of every real mesh under
   * `root`. Each overlay shares the mesh's geometry by reference (never
   * disposed here) and the module-lived white material, is parented to the
   * mesh (identity local transform) so it co-moves exactly, and is tagged
   * `_isGhostOverlay` + `_isSourceGhost` (so it's excluded from raycasting and
   * stripped from spawned MU clones). Skips meshes that already carry an
   * overlay child to stay idempotent.
   */
  private _addOverlayShells(root: Object3D): void {
    // Snapshot the real meshes first — we mutate the tree by adding overlays.
    // Skip overlay shells themselves and the floor-marker / preview helpers;
    // ghost-clone meshes (tagged `_isSourceGhost`) DO need a shell.
    const meshes: Mesh[] = [];
    root.traverse((child) => {
      const ud = child.userData;
      if (ud._isGhostOverlay || ud._isSourceMarker || ud._isSourcePreview) return;
      const mesh = child as Mesh;
      if (mesh.isMesh) meshes.push(mesh);
    });

    for (const mesh of meshes) {
      // Don't double-process a mesh that already carries our overlay.
      if (mesh.children.some((c) => c.userData._isGhostOverlay)) continue;

      // Translucent white shell. renderOrder above the mesh so it draws on top.
      const fill = new Mesh(mesh.geometry, _sourceFillShellMaterial);
      fill.name = `${mesh.name}_ghostFill`;
      fill.userData._isGhostOverlay = true;
      fill.userData._isSourceGhost = true;
      fill.renderOrder = (mesh.renderOrder ?? 0) + 1;
      fill.castShadow = false;
      fill.receiveShadow = false;
      mesh.add(fill);
      this._overlayMeshes.push(fill);

      // White edge outline on top of the fill.
      const edges = new LineSegments(new EdgesGeometry(mesh.geometry), _sourceEdgeMaterial);
      edges.name = `${mesh.name}_ghostEdges`;
      edges.userData._isGhostOverlay = true;
      edges.userData._isSourceGhost = true;
      edges.renderOrder = (mesh.renderOrder ?? 0) + 2;
      edges.castShadow = false;
      edges.receiveShadow = false;
      mesh.add(edges);
      this._edgeOverlays.push(edges);

      // Hide the real fill (no colour/depth write → x-ray, no scene occlusion).
      this._hiddenFillMeshes.push({ mesh, real: mesh.material });
      mesh.material = _sourceFillHiddenMaterial;
      mesh.castShadow = false;
    }
  }

  /** Toggle the ghost-clone's visibility (separate-template case only; no-op
   *  for self-template sources, whose ghost is in-place overlay shells). */
  setGhostVisible(visible: boolean): void {
    if (this._ghostNode) this._ghostNode.visible = visible;
  }

  /**
   * Build the always-visible floor marker (ring + label) under the source.
   * Same lifecycle rules as `_buildGhostClone`:
   *  - Idempotency guard — second call is a no-op.
   *  - Skip when `sourceIsTemplate=true` (would otherwise be cloned into
   *    every spawned MU and pollute the scene).
   *  - Skip if `templateHalfSize` is missing (no template resolved).
   */
  private _buildMarker(): void {
    if (this._markerNode) return;
    if (this.sourceIsTemplate) return;
    if (!this.templateHalfSize) return;

    const handles = buildSourceMarker({
      templateHalfSize: this.templateHalfSize,
      name: this.node.name,
      visible: true,
    });

    this.node.add(handles.root);
    this._markerNode = handles.root;
    this._markerRing = handles.ring;
    this._markerLabel = handles.label;
    this._markerLabelTexture = handles.labelTexture;
    this._markerLabelText = handles.labelText;
    this._markerDispose = handles.dispose;
  }

  /** Toggle the floor-marker's visibility (visibility-only, no rebuild). */
  setMarkerVisible(visible: boolean): void {
    if (this._markerNode) this._markerNode.visible = visible;
  }

  /**
   * Test-only accessor — exposes the marker internals for unit tests so
   * they don't need direct private-field access. Do not use in production
   * code.
   */
  get markerForTesting(): {
    root: Object3D | null;
    ring: Mesh | null;
    label: Sprite | null;
    texture: Texture | null;
    labelText: string | null;
  } {
    return {
      root: this._markerNode,
      ring: this._markerRing,
      label: this._markerLabel,
      texture: this._markerLabelTexture,
      labelText: this._markerLabelText,
    };
  }

  /** Free resources held by the ghost AND the floor marker. Called when the
   *  source is removed from the scene (e.g. layout-planner remove, model
   *  clear via TransportManager.reset). */
  dispose(): void {
    if (this._unsubPlacement) {
      this._unsubPlacement();
      this._unsubPlacement = null;
    }
    this._disposePreview();
    if (this._ghostNode) {
      if (this._ghostNode.parent) this._ghostNode.parent.remove(this._ghostNode);
      this._ghostNode = null;
    }
    // Translucent fill shells (self-template: on the source node; separate-
    // template clone is already removed with `_ghostNode` above). Shared geometry
    // + module-lived material are NOT disposed.
    for (const fill of this._overlayMeshes) fill.parent?.remove(fill);
    this._overlayMeshes = [];
    // Edge outlines: detach AND dispose their per-geometry EdgesGeometry (not
    // shared). The edge material is module-lived and is NOT disposed.
    for (const edges of this._edgeOverlays) {
      edges.parent?.remove(edges);
      edges.geometry.dispose();
    }
    this._edgeOverlays = [];
    for (const { mesh, real } of this._hiddenFillMeshes) mesh.material = real;
    this._hiddenFillMeshes = [];
    // Marker disposal — frees ring geometry/material + label texture/material
    // and detaches the marker node from `this.node`.
    if (this._markerDispose) {
      this._markerDispose();
      this._markerDispose = null;
    }
    this._markerNode = null;
    this._markerRing = null;
    this._markerLabel = null;
    this._markerLabelTexture = null;
    this._markerLabelText = null;
  }

  /**
   * Re-arm the source for a fresh simulation run (web_sim_reset / resetSimulation).
   * Clears the per-run spawn state (timer, distance reference, id counter, held
   * preview) so spawning restarts cleanly from the first part — but KEEPS the
   * template and the visual (ghost / overlay shells / floor marker). Unlike
   * dispose() (a model-unload teardown), this must NOT remove the source's
   * appearance; calling dispose() on reset is what made web_sim_reset visually
   * "delete" the source (and strip a self-template source's translucent shells).
   */
  reset(): void {
    this.timer = 0;
    this.lastSpawnedMU = null;
    this.muIdCounter = 0;
    this.spawnCount = 0;
    this._disposePreview();
  }

  /**
   * Update source timer and spawn MU if ready.
   * Returns new MU (clone or instanced) or null.
   *
   * @param spawningEnabled  When false (e.g. Layout-Planner active), the source
   *   does not spawn; instead it shows a held "showcase" preview instance at
   *   its origin (alongside the ghost). The frame spawning flips back to true,
   *   the held preview is released as the first real spawn.
   * @param forceClone  When true, spawn CLONE MUs (real Object3Ds) even if the
   *   template could be instanced — the Layout-Planner needs a real node per MU
   *   to register it as a selectable scene object.
   */
  update(dt: number, spawningEnabled = true, forceClone = false): (RVMovingUnit | InstancedMovingUnit) | null {
    if (!this.isOwner) return null; // Server is authority for MU lifecycle
    if (!this.muTemplate || !this.spawnParent) return null;

    if (!spawningEnabled) {
      // Inactive: show the held showcase instance, do not spawn.
      this._ensurePreview();
      return null;
    }

    // Re-resolve what the source stands on (throttled). Force a fresh resolve
    // while a held preview is pending so a spawn decision after a planner move
    // reflects the latest placement rather than a stale pre-move cache.
    this._maybeResolvePlacement(dt, this._previewInstance !== null);

    const mode = this._placement.mode;

    // Case 3 — not on any transport surface: never spawn (and never release the
    // held preview into empty space).
    if (mode === 'none') return null;

    // Spawn gate (plan-255 F6a): when a live MU already occupies the spawn spot
    // (a jam backed up to the source), hold this tick and retry next tick —
    // no error, no MU stacked into a standing one. The interval timer holds
    // too, so spawning resumes cleanly the moment the spot clears.
    if (this._spawnPointOccupied()) return null;

    // Case 2 — on a ConveyorBehavior: gate purely on belt occupancy. Spawn the
    // next part only once the conveyor's surface(s) are clear (no MU on them).
    if (mode === 'conveyor') {
      if (this._conveyorOccupied()) return null;
      if (this._previewInstance) {
        this._disposePreview();
        this.timer = 0;
      }
      return this.spawn(forceClone);
    }

    // Case 1 — plain transport surface: keep the configured Interval/Distance
    // rhythm. A held preview is released as the first real spawn.
    if (this._previewInstance) {
      this._disposePreview();
      this.timer = 0;
      return this.spawn(forceClone);
    }

    if (this.spawnMode === 'Interval') {
      this.timer += dt;
      if (this.timer >= this.spawnInterval) {
        this.timer -= this.spawnInterval;
        return this.spawn(forceClone);
      }
    } else if (this.spawnMode === 'Distance') {
      // Distance mode: spawn when previous MU has moved spawnDistance mm away
      // (or immediately if no MU has been spawned yet)
      if (!this.lastSpawnedMU || this.lastSpawnedMU.markedForRemoval) {
        return this.spawn(forceClone);
      }
      // Measure distance from source to last spawned MU (in meters)
      this.node.getWorldPosition(_sourcePos);
      this.lastSpawnedMU.getWorldPosition(_lastMUPos);
      const distM = _sourcePos.distanceTo(_lastMUPos);
      const distMM = distM * MM_TO_METERS;
      if (distMM >= this.spawnDistance) {
        return this.spawn(forceClone);
      }
    }
    // OnSignal mode not implemented for PoC

    return null;
  }

  /** Re-resolve placement on the first update, when invalidated by a planner
   *  move, when `force` is set, or every `PLACEMENT_REFRESH_SEC` as a backstop
   *  for topology changes (e.g. a conveyor snapped on after the source). */
  private _maybeResolvePlacement(dt: number, force: boolean): void {
    this._placementTimer += dt;
    if (force || !this._placementResolved || this._placementTimer >= PLACEMENT_REFRESH_SEC) {
      this._placementTimer = 0;
      this._placementResolved = true;
      this._resolvePlacement();
    }
  }

  /** Classify what the source stands on from its current world position. */
  private _resolvePlacement(): void {
    if (!this.transportManager) {
      // No transport context wired (a source used outside the manager, e.g. a
      // unit test). Placement can't be detected — fall back to the permissive
      // legacy behavior (plain surface) rather than silently never spawning.
      this._placement = { mode: 'surface', surface: null, conveyorRoot: null, conveyorSurfaces: [] };
      return;
    }
    this.node.getWorldPosition(_placementPos);
    this._placement = classifySourcePlacement(
      _placementPos,
      this.transportManager.surfaces,
      OCCUPANCY_GATED_BEHAVIORS,
      SURFACE_TOP_EPS_M,
    );
  }

  /**
   * Horizontal world-space direction MUs travel when discharged from this source,
   * derived from the surface it stands on (`_placement.surface` or the first
   * conveyor surface). Returns `null` for a free-standing source with no surface,
   * or when the direction is degenerate. Written into `out` and returned. Used to
   * orient the spawn grow-out effect. No allocation in the hot path.
   */
  getDischargeDirection(out: Vector3): Vector3 | null {
    const surface = this._placement.surface ?? this._placement.conveyorSurfaces[0] ?? null;
    if (!surface) return null;
    surface.getWorldDirection(out);
    out.multiplyScalar(Math.sign(surface.speed) || 1); // stopped belt → assume forward
    out.y = 0;
    if (out.lengthSq() < 1e-8) return null;
    out.normalize();
    return out;
  }

  /**
   * True when a live MU's AABB overlaps the spawn spot (the MU template's
   * footprint at the source's world position) — plan-255 F6a. Uses the
   * transport manager's grid-backed occupancy query with the same candidate
   * filters as the accumulation clamp (markedForRemoval/gripped skipped).
   * Disabled together with the global accumulation kill-switch
   * (`RVTransportSurface.accumulateDefault`) and without a manager/template
   * (standalone sources keep the legacy always-spawn behavior).
   */
  private _spawnPointOccupied(): boolean {
    if (!this.transportManager || !this.templateHalfSize) return false;
    if (!RVTransportSurface.accumulateDefault) return false; // feature killed → legacy
    this.node.getWorldPosition(_sourcePos);
    const h = this.templateHalfSize;
    const cx = _sourcePos.x + (this.templateLocalCenter?.x ?? 0);
    const cy = _sourcePos.y + (this.templateLocalCenter?.y ?? 0);
    const cz = _sourcePos.z + (this.templateLocalCenter?.z ?? 0);
    _spawnAreaAABB.min.set(cx - h.x, cy - h.y, cz - h.z);
    _spawnAreaAABB.max.set(cx + h.x, cy + h.y, cz + h.z);
    return this.transportManager.isAreaOccupiedByMU(_spawnAreaAABB);
  }

  /** True when any live MU sits on the conveyor's belt surface(s) (conveyor mode). */
  private _conveyorOccupied(): boolean {
    if (!this.transportManager) return false;
    return anyMUOnSurfaces(this._placement.conveyorSurfaces, this.transportManager.mus);
  }

  /** Create a new MU at this source's position (clone or instanced). When
   *  `forceClone` is true the instanced path is skipped so the MU has a real
   *  per-instance node (used by the Layout-Planner for selection). */
  /**
   * On-demand MU mesh spawn for the DES path (NOT time-gated, unlike `update()`).
   * The event-driven DES runner calls this when its source generates an MU, so a
   * DES MU gets a real visual the tween/`DESMUMover`-equivalent can drive — the
   * same pattern as the Unity `DESSource.GenerateMU()` reusing `Source.Generate()`.
   * Clone path (forceClone) so the DES runner owns each MU's lifecycle simply
   * (no shared instancing pool to reconcile). Returns null if no template.
   */
  spawnMU(): (RVMovingUnit | InstancedMovingUnit) | null {
    return this.spawn(true);
  }

  /** Despawn a DES-spawned MU mesh (sink consumed it / reset). Safe on null. */
  despawnMU(mu: (RVMovingUnit | InstancedMovingUnit) | null): void {
    mu?.dispose();
  }

  private spawn(forceClone = false): (RVMovingUnit | InstancedMovingUnit) | null {
    if (!this.muTemplate || !this.spawnParent || !this.templateHalfSize) return null;

    // ── Instanced path ──
    if (this.useInstancing && this.pool && !forceClone) {
      // Add pool's InstancedMesh to scene if not already added
      if (!this.pool.instancedMesh.parent) {
        this.spawnParent.add(this.pool.instancedMesh);
      }

      this.node.getWorldPosition(_sourcePos);
      // World rotation, not identity — the pool places instances in world space.
      this.node.getWorldQuaternion(_spawnQuat);
      const muId = `imu_${this.node.name}_${this.muIdCounter++}`;

      const mu = this.pool.spawn(_sourcePos, _spawnQuat, muId, this.node.name);
      this.lastSpawnedMU = mu;
      this.spawnCount++;
      return mu;
    }

    // ── Clone path (multi-mesh fallback) ──
    const clone = this._buildRealClone();
    clone.name = `${this.muTemplate.name}_${this.spawnCount++}`;

    // Position at source location (convert world → spawnParent local space)
    this.node.getWorldPosition(clone.position);
    this.spawnParent.worldToLocal(clone.position);

    // Keep the source's WORLD orientation (Unity parity). `Object3D.clone()` copies the
    // template's LOCAL quaternion, but the clone is re-parented under `spawnParent` — so on a
    // rotated import (Z-up→Y-up conversion sits in the ancestors) the template's parent chain
    // is lost and the MU would spawn visibly twisted. Convert world → spawnParent local space,
    // mirroring the position handling above.
    this.node.getWorldQuaternion(_spawnQuat);
    this.spawnParent.getWorldQuaternion(_spawnParentQuat);
    clone.quaternion.copy(_spawnParentQuat.invert()).multiply(_spawnQuat);

    this.spawnParent.add(clone);

    // Pass the template vectors by reference — AABB.fromHalfSize() copies them
    // into its own fields and they are immutable after setTemplate(), so cloning
    // per spawn was pure GC churn (the instanced path already passes by reference).
    const mu = new RVMovingUnit(clone, this.node.name, this.templateHalfSize, this.templateLocalCenter ?? undefined);
    this.lastSpawnedMU = mu;
    return mu;
  }

  /**
   * Clone the MU template into a fully-visible, real-material subtree. The real
   * template materials are never mutated (the ghost is a separate clone with an
   * overlay shell), so clones simply inherit the real materials by reference —
   * no restore step is needed. Shared by `spawn()` (clone path) and the
   * showcase preview.
   */
  private _buildRealClone(): Object3D {
    // Self-template sources hide their own fill (transparent look) by swapping
    // each mesh's material. The clone must inherit the REAL materials, so we
    // un-hide the source meshes for the duration of clone() (Mesh.clone copies
    // `material` by reference) and immediately re-hide them. This is synchronous
    // (no render in between) so the source never flickers. We must NOT stash the
    // real material in userData — Object3D.clone() JSON-round-trips userData and
    // would corrupt the Material into a useless plain object.
    for (const e of this._hiddenFillMeshes) e.mesh.material = e.real;
    const clone = this.muTemplate!.clone();
    for (const e of this._hiddenFillMeshes) e.mesh.material = _sourceFillHiddenMaterial;

    // Strip any editor-only ghost / overlay / showcase-preview subtrees that
    // were cloned in. This happens when the MU template subtree overlaps the
    // source node that carries them (self-template: the ghost + overlay shells
    // live under `this.node`, which IS the template). A real spawned MU must
    // never contain a ghost/overlay/preview.
    const strip: Object3D[] = [];
    clone.traverse((child) => {
      const ud = child.userData;
      if (ud?._isSourceGhost || ud?._isGhostOverlay || ud?._isSourcePreview) strip.push(child);
    });
    for (const n of strip) n.parent?.remove(n);

    // The clone inherited the template's rv-extras / layout metadata via
    // Object3D.clone(). A spawned MU (and the held preview) is a pure visual
    // driven by RVMovingUnit — it must never carry a `Source`/`LayoutObject`
    // definition, or `processExtras` would turn it into a recursive Source.
    stripComponentMetadata(clone);

    // Force everything visible — for self-template sources the real meshes were
    // hidden (`_hideRealMeshes`) and that flag carries over via clone().
    clone.visible = true;
    clone.traverse((child) => { child.visible = true; });

    // Apply the standard shadow policy so MU clones cast/receive shadows like
    // the static scene, independent of how the template entered the scene (a
    // library-placed source template could otherwise carry stale flags).
    applyShadowFlags(clone);
    return clone;
  }

  /**
   * Build the held showcase instance (a real-material preview MU) at the source
   * origin, parented to `this.node` so it tracks the source. Idempotent. Shown
   * while spawning is disabled, alongside the ghost; released by `update()`
   * when spawning re-enables. Not registered as a simulation MU, so transport
   * never moves it — it stays pinned at the source.
   */
  /** Build the held showcase instance now (used when the simulation is paused
   *  — e.g. the planner pauses the sim, so the update loop won't build it). */
  showPreview(): void {
    this._ensurePreview();
  }

  private _ensurePreview(): void {
    if (this._previewInstance || !this.muTemplate) return;
    const inst = this._buildRealClone();
    inst.name = `${this.muTemplate.name}_preview`;
    inst.userData._isSourcePreview = true;
    inst.position.set(0, 0, 0);
    inst.quaternion.identity();
    inst.scale.set(1, 1, 1);
    this.node.add(inst);
    this._previewInstance = inst;
  }

  /** Remove the held showcase instance (shared geometry/materials are NOT
   *  disposed — they belong to the template). */
  private _disposePreview(): void {
    if (!this._previewInstance) return;
    this._previewInstance.parent?.remove(this._previewInstance);
    this._previewInstance = null;
  }
}

// Self-register for auto-discovery by scene loader
registerComponent({
  type: 'Source',
  schema: RVSource.schema,
  capabilities: {
    authorable: true,   // addable in the asset editor (schema-complete)
    badgeColor: '#ab47bc',
  },
  create: (node) => new RVSource(node),
});
