// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { Vector3, Quaternion } from 'three';
import type { Scene, Object3D } from 'three';
import { RVTransportSurface } from './rv-transport-surface';
import type { IAccumulationQuery } from './rv-transport-surface';
import type { RVSensor } from './rv-sensor';
import type { RVSource } from './rv-source';
import type { RVSink } from './rv-sink';
import type { RVGrip } from './rv-grip';
import type { RVGripTarget } from './rv-grip-target';
import type { RVMovingUnit, InstancedMovingUnit } from './rv-mu';
import { AABB } from './rv-aabb';
import { SpatialGridXZ } from './rv-spatial-grid';
import { createMUDissolve, createMUGrow } from './rv-mu-dissolve';
import { debug } from './rv-debug';
import { physicsRegistry, physicsSettings } from './rv-physics-registry';
import type { IPhysicsMUHook, PhysicsPose, PhysicsProvider } from './rv-physics-registry';
import { RVPhysicsZone } from './rv-physics-zone';
import { MM_TO_METERS } from './rv-constants';

// Pre-allocated scratch for the driver-selection direction gate (no GC in the
// per-tick transport hot path; single-threaded reuse is safe).
const _pickDir = new Vector3();
const _pickToMu = new Vector3();
// Scratch for the end-of-line dead-end probe (single-threaded reuse, no GC).
const _deadEndDir = new Vector3();
// Scratch for the spawn grow-out effect setup/update (single-threaded reuse, no GC).
const _growDir = new Vector3();

// Pre-allocated scratch for the physics handover (plan-276 F4). The provider
// copies all values synchronously inside `addDynamicMU`, so single-threaded
// reuse is safe — zero GC in the per-tick no-driver branch.
const _handoverPos = new Vector3();
const _handoverQuat = new Quaternion();
const _handoverVel = new Vector3();
const _handoverPose: PhysicsPose = {
  pos: { x: 0, y: 0, z: 0 },
  quat: { x: 0, y: 0, z: 0, w: 1 },
};

/** True when `surface` belongs to a planner-placed layout object — its node (or
 *  any ancestor) carries the `_layoutObject` tag the layout planner propagates to
 *  every descendant of a placed asset. End-of-line vanish is scoped to these, so
 *  MUs reaching a dead end on the authored GLB scene are never deleted.
 *
 *  The parent-chain walk is constant between topology changes, so the result is
 *  cached per surface (cleared in `notifyTopologyChanged()`); the uncached walk
 *  would run per driven MU per tick. */
const _layoutObjectFlag = new Map<RVTransportSurface, boolean>();
function surfaceIsLayoutObject(surface: RVTransportSurface): boolean {
  let flag = _layoutObjectFlag.get(surface);
  if (flag === undefined) {
    flag = false;
    let cur: Object3D | null = surface.node;
    while (cur) {
      if (cur.userData?._layoutObject === true) { flag = true; break; }
      cur = cur.parent;
    }
    _layoutObjectFlag.set(surface, flag);
  }
  return flag;
}
const _growOrigin = new Vector3();
const _growPlane = new Vector3();

/**
 * Cached per-surface dead-end topology (plan-240 Baustein 2). Built lazily on
 * the first `_isAtDeadEnd` after an invalidation (`_adjacencyCache === null`).
 */
interface SurfaceAdjacency {
  /** STATIC stacked junction siblings (`_overlapFractionXZ >= 0.5` at cache
   *  build time), excluding the surface itself. Dynamic surfaces are never
   *  cached as members — they are live-checked per query, because a rotating
   *  footprint can enter/leave the stacking band between cache builds. */
  group: RVTransportSurface[];
  /** True for surfaces whose AABB neighborhood changes during simulation:
   *  `Radial === true` (turntables — rotation is exactly how they "dock" to a
   *  conveyor) or observed moving (see `_observedMoving`). Dynamic surfaces
   *  always take the LIVE dead-end path (correctness over caching). */
  isDynamic: boolean;
  /** XZ AABB signature at build time. A mismatch on any STATIC surface in the
   *  per-tick surface loop invalidates the whole cache — this self-healing
   *  guard subsumes the planner's `layout-transform-update` event (a move
   *  without add/remove), which the manager cannot subscribe to (it has no
   *  event-bus access; see `notifyTopologyChanged`). */
  sigMinX: number;
  sigMinZ: number;
  sigMaxX: number;
  sigMaxZ: number;
}

/**
 * Narrow injection seam for observers of the MU lifecycle (plan-394), same
 * pattern as {@link IPhysicsMUHook}: the observer is assigned to
 * `transportManager.muLifecycleHook`, and every spawn and every dispose path
 * (swap-and-pop removal, `removeMU()`, `reset()`) reports through it.
 *
 * It exists because a spawned MU cannot carry its own configuration: the clone
 * paths call `stripComponentMetadata()`, which deletes `userData.realvirtual`
 * so a clone never resurrects as a live component. Anything an MU should
 * inherit therefore has to be handed over at spawn time by its source.
 */
export interface IMULifecycleHook {
  /** A source just spawned `mu`. `role` is the source's `CollisionRoleForMUs`. */
  onMUSpawned(mu: RVMovingUnit | InstancedMovingUnit, role: string | undefined): void;
  /** `mu` is about to be disposed (any path). Idempotent for unknown MUs. */
  onMURemoved(mu: RVMovingUnit | InstancedMovingUnit): void;
}

/**
 * RVTransportManager - Central coordinator for transport simulation.
 *
 * Manages the update order: Sources -> Transport -> Sensors -> Sinks.
 * Called from SimulationLoop.onFixedUpdate.
 */
export class RVTransportManager implements IAccumulationQuery {
  surfaces: RVTransportSurface[] = [];
  sensors: RVSensor[] = [];
  sources: RVSource[] = [];
  sinks: RVSink[] = [];
  grips: RVGrip[] = [];
  gripTargets: RVGripTarget[] = [];
  mus: (RVMovingUnit | InstancedMovingUnit)[] = [];
  scene: Scene | null = null;

  /** True when the renderer is a WebGPURenderer — passed through to the
   *  GLSL-only MU dissolve/grow effects so they skip their onBeforeCompile
   *  patches (plan-271 PR#0). Set by the scene loader from LoadGLBOptions. */
  isWebGPU = false;

  /** plan-271 Phase 4 SPIKE: when set (real WebGPU backend AND explicit
   *  opt-in — see `LoadGLBOptions.muComputeRenderer`), the MU instance pools
   *  compose their instance matrices in a GPU compute kernel instead of the
   *  CPU loop. null = CPU path (unchanged default). Set by the scene loader
   *  from LoadGLBOptions, same route as `isWebGPU` above. */
  muComputeRenderer: unknown = null;

  /** Monotonic tick counter shared with RVTransportSurface for per-tick world-direction refresh. */
  private _tickId = 0;

  // ── Spatial broad-phase (plan-240) ────────────────────────────────
  /** Below this live-MU count the sensor/sink checks stay on the plain array
   *  scan (grid overhead > gain for small scenes); at/above it, candidates
   *  come from `_muGrid`. `_pickDrivingSurface` applies the same threshold to
   *  the SURFACE count. Public so tests can force either path (0 = always
   *  grid, Infinity = always brute force). */
  bruteForceThreshold = 64;

  /** XZ uniform grid over live MUs (~1 m cells ≈ 1-2× a typical MU footprint).
   *  Maintained unconditionally (cheap no-op updates) so switching across the
   *  brute-force threshold is seamless; entries are LAZY-inserted in the
   *  per-tick MU-AABB loop, which self-heals against every external
   *  `mus.push(...)` (sources, multiuser followers, tests) — plan-240 §2.6. */
  private readonly _muGrid = new SpatialGridXZ<RVMovingUnit | InstancedMovingUnit>(1.0);

  /** XZ uniform grid over transport surfaces. Larger cells (4 m) because
   *  belts are long — keeps a 20 m line at ~6 cells (long-AABB mitigation,
   *  plan-240 §5.2). Rebuilt via the reference/length guard below; moved
   *  surfaces (turntable arms under a rotating drive, planner drags) are
   *  re-indexed right after the per-tick surface-AABB update — a no-op while
   *  the cell span is unchanged, so static surfaces cost O(1) per tick. */
  private readonly _surfaceGrid = new SpatialGridXZ<RVTransportSurface>(4.0);

  /** Reference/length guard for the surface grid (plan-240 §2.6): the
   *  surfaces array is mutated externally (component constructors push during
   *  load AND placement; scene-mutations REASSIGNS it via filter on removal).
   *  Any reference or length change → full grid rebuild at the next tick.
   *  Sensors/sinks need no such guard — they are iterated directly and never
   *  indexed. */
  private _lastSurfacesRef: RVTransportSurface[] | null = null;
  private _lastSurfacesLen = -1;
  /** Set by `notifyTopologyChanged()` to force a surface-grid rebuild even
   *  without an array reference/length change (e.g. a planner move). */
  private _surfaceGridDirty = true;

  /** Reused scratch for MU candidates from `_muGrid` (sensor/sink queries). */
  private readonly _muCandidates: (RVMovingUnit | InstancedMovingUnit)[] = [];
  /** Reused scratch for surface candidates from `_surfaceGrid`. */
  private readonly _surfaceCandidates: RVTransportSurface[] = [];
  /** Reused query bounds for UseRaycast sensors — encloses the full beam
   *  segment (the sensor's own AABB does NOT cover the ray). Only min/max are
   *  ever written/read on this instance. */
  private readonly _rayQueryAABB = new AABB();

  // ── Dead-end adjacency cache (plan-240 Baustein 2) ────────────────
  /** Per-surface junction topology for `_isAtDeadEnd`. `null` = invalidated
   *  (lazy rebuild on next use — same null-sentinel pattern as the viewer's
   *  `_prePluginsSnapshot`). Only ever built while the end-of-line vanish is
   *  active (planner mode), so the per-tick signature check below is free
   *  otherwise. */
  private _adjacencyCache: Map<RVTransportSurface, SurfaceAdjacency> | null = null;
  /** Surfaces classified dynamic by the CURRENT cache build (Radial +
   *  observed-moving) — live-checked for junction membership on every static
   *  query. Rebuilt together with the cache; typically very short. */
  private readonly _dynamicSurfaces: RVTransportSurface[] = [];
  /** Non-Radial surfaces whose AABB was observed changing while cached as
   *  static (e.g. a belt under a moving Drive). They are reclassified as
   *  dynamic on the next cache build so they stop invalidating the cache
   *  every tick (adaptive fallback from plan-240 §5.2: "dynamische Surfaces
   *  als immer-Kandidat fuehren"). Cleared on explicit topology changes. */
  private readonly _observedMoving = new Set<RVTransportSurface>();
  /** Reused degenerate point-AABB for the dead-end forward-probe grid query. */
  private readonly _probeAABB = new AABB();

  // ── Accumulation (plan-255) ───────────────────────────────────────
  /** Reused query-bounds AABB for `queryLeadingMU` / `isAreaOccupiedByMU` —
   *  only min/max are ever written/read (same pattern as `_probeAABB`). */
  private readonly _accumQueryAABB = new AABB();
  /** Reused raw grid-candidate scratch for `queryLeadingMU` (kept separate from
   *  `_muCandidates` so a caller-owned `out` array can never alias it). */
  private readonly _accumGridScratch: (RVMovingUnit | InstancedMovingUnit)[] = [];

  /** Reused scratch for the per-MU overlapping-surface scan (no per-tick alloc). */
  private readonly _overlapScratch: RVTransportSurface[] = [];

  /** Reused scratch for the dead-end junction group (current surface + stacked
   *  transfer siblings). No per-tick allocation. */
  private readonly _deadEndGroup: RVTransportSurface[] = [];

  // ── Physics zones (plan-276) ──────────────────────────────────────
  /** Reset-chokepoint injection seam (F14, pattern `IAccumulationQuery`):
   *  the physics plugin registers itself here; `reset()`, the swap-and-pop
   *  removal loop AND `removeMU()` call `onMUDisposed(mu)` BEFORE
   *  `mu.dispose()` so no physics body is ever orphaned on any dispose path. */
  physicsMUHook: IPhysicsMUHook | null = null;

  /** MU lifecycle observer (plan-394, pattern: `physicsMUHook`). Set by the
   *  viewer to the collision manager so spawned MUs join the collision check
   *  with the role configured on their source, and leave it on every dispose
   *  path. Null (default) = nobody observes. */
  muLifecycleHook: IMULifecycleHook | null = null;

  /** Physics-managed surfaces (plan-276 Phase 4, F5 — narrow seam like
   *  `physicsMUHook`, NO plugin import): maintained by the physics plugin's
   *  world build (surfaces with `PhysicsMode` fully contained in a zone).
   *  An MU whose driving surface is in this set is handed to the provider
   *  IMMEDIATELY on entering the surface (not only at the belt end) — the
   *  provider's kinematic conveyor body carries it via friction from then on.
   *  Null (default) = no surface is physics-managed. */
  physicsManagedSurfaces: Set<RVTransportSurface> | null = null;

  /** Physics-managed sensors (plan-276 Phase 5, F6 — same narrow-seam pattern
   *  as `physicsManagedSurfaces`): maintained by the physics plugin's world
   *  build (sensors with `PhysicsMode` overlapping a zone). A sensor in this
   *  set is SKIPPED by the kinematic detection loop (step 5) — the plugin
   *  drives its `occupied` state from provider sensor events / raycasts and
   *  fires `sensor.onChanged` through `applyPhysicsResult()`. Non-managed
   *  sensors keep detecting ALL MUs — including physics-owned ones — via
   *  their AABB path (the pose sync writes node positions; 1 tick stale).
   *  Null (default) = no sensor is physics-managed. */
  physicsManagedSensors: Set<RVSensor> | null = null;

  /** When false, sources do NOT spawn new MUs (the rest of the simulation —
   *  transport, sensors, sinks — keeps running). The Layout-Planner sets this
   *  false while active so editing/dragging sources doesn't scatter spawned
   *  instances; the always-visible source ghost represents the source instead. */
  spawnEnabled = true;

  /** When true, sources spawn CLONE MUs (real Object3Ds) even if their template
   *  could be instanced. The Layout-Planner sets this while active so spawned
   *  MUs have a real node to register as a selectable scene object (instanced
   *  MUs have no per-instance Object3D). Reset to false on planner exit. */
  preferCloneMU = false;

  /**
   * Enable/disable source spawning. When disabling, each source immediately
   * shows its held "showcase" preview instance (the paused sim loop won't build
   * it). When re-enabling, the held previews are released by the next source
   * update (the first real spawn).
   */
  setSpawnEnabled(enabled: boolean): void {
    this.spawnEnabled = enabled;
    if (!enabled) {
      for (const source of this.sources) source.showPreview();
    }
  }

  /** Total MUs spawned since start */
  totalSpawned = 0;
  /** Total MUs consumed by sinks since start */
  totalConsumed = 0;

  /** Hard safety ceiling on simultaneously-live MUs. A source feeding a belt
   *  with no downstream sink (or a jammed line) would otherwise spawn without
   *  bound until the tab runs out of memory. At the cap, sources hold their
   *  preview instead of spawning and resume automatically once MUs drain. */
  maxLiveMUs = 5000;
  private _muCapWarned = false;

  /** When true, an MU sitting at a DEAD END — the end of a line with no
   *  successor surface ahead of it — is deleted after `vanishDelaySec`. Covers
   *  both an MU parked on a stopped discharge belt (held by an end-stop sensor)
   *  and one that ran off the belt entirely. SCOPED to planner-placed layout
   *  objects: an MU reaching a dead end on the authored GLB scene is left alone
   *  (only MUs whose surface belongs to a layout object vanish — see
   *  `mu.onLayoutObject` / `surfaceIsLayoutObject`). Off by default; toggled from
   *  the Layout-Planner toolbar via `RVViewer.setVanishMUs`. */
  vanishMUsAtEndOfLine = false;
  /** Injected by the viewer: returns true when `surface`'s OUTGOING snap point is
   *  connected to another asset. Gates the end-of-line vanish so a connected
   *  successor (e.g. a rotated turntable whose footprint no longer geometrically
   *  overlaps the discharge edge) never causes a false vanish. Null when no snap
   *  system is wired → geometry-only behaviour (unchanged). The engine must not
   *  depend on the snap-point plugin, hence the injected predicate. */
  isOutputConnected: ((surface: RVTransportSurface) => boolean) | null = null;
  /** Seconds an MU must dwell at a dead end before it vanishes (tolerates a
   *  brief stop at a hand-off; gives freshly-spawned MUs time to reach a belt). */
  readonly vanishDelaySec = 2;
  /** How far ahead of an MU's leading edge (metres, along its surface's
   *  transport direction) to probe for a successor surface. No surface there →
   *  dead end. Large enough to clear the discharge edge / a small inter-belt
   *  gap; successor belts overlap the current one at the seam so a real
   *  successor is always found and false positives are avoided. */
  readonly vanishProbeAheadM = 0.3;
  /** Seconds the sci-fi burn dissolve plays after the dwell delay, before the
   *  MU is finally removed. */
  readonly vanishDurationSec = 0.6;
  /** True while at least one MU is mid-dissolve — the viewer uses this to keep
   *  the (otherwise on-demand) renderer awake so the burn animates. */
  private _hasVanishing = false;

  /** True while at least one MU is mid grow-out (keeps the renderer awake while
   *  it is actually moving). A freshly spawned clone MU starts fully clipped and
   *  physically slides out of a fixed world clip plane at the source as it
   *  travels — the stripe stays put, the MU emerges through it. Distance/vector
   *  based, NOT timed; a stopped belt freezes it mid-emerge. Instanced MUs have
   *  no per-instance material so they skip it. */
  private _hasGrowing = false;

  /** True while any MU effect (vanish dissolve OR spawn grow-out) is animating —
   *  the viewer keeps the on-demand renderer awake while this holds. */
  get hasVanishingMU(): boolean { return this._hasVanishing || this._hasGrowing; }

  /**
   * Main update loop - called every fixed timestep (16.67ms @ 60Hz).
   *
   * Order matters:
   * 1. Sources spawn new MUs
   * 2. Update surface AABBs
   * 3. Transport: each MU is moved by exactly one surface (currentSurface tracking)
   * 4. Update MU AABBs (after transport moved them)
   * 5. Sensors check overlap with MUs
   * 6. Sinks mark overlapping MUs for removal
   * 7. Remove marked MUs (reverse iteration, swap-and-pop)
   */
  update(dt: number): void {
    // Bump the global transport tick id — RVTransportSurface uses this to
    // lazily refresh its world-space direction once per tick (so MUs follow
    // the belt even when a parent drive rotates the platform).
    RVTransportSurface.beginTick(++this._tickId);

    // 1. Sources: spawn new MUs. When spawning is disabled (e.g. the
    //    Layout-Planner is active) the source instead shows a held "showcase"
    //    instance at its origin and does not spawn; the frame spawning
    //    re-enables, the held instance is released as the first real MU.
    const atCap = this.mus.length >= this.maxLiveMUs;
    if (atCap && !this._muCapWarned) {
      this._muCapWarned = true;
      console.warn(`[TransportManager] live-MU cap of ${this.maxLiveMUs} reached — sources are holding. Check for a missing/blocked Sink downstream.`);
    } else if (!atCap && this._muCapWarned && this.mus.length < this.maxLiveMUs * 0.9) {
      // Re-arm the warning once the line has clearly drained (hysteresis).
      this._muCapWarned = false;
    }
    for (const source of this.sources) {
      // Pass spawning-disabled while at the cap so sources show their preview
      // instead of spawning; they resume automatically as MUs drain.
      const mu = source.update(dt, this.spawnEnabled && !atCap, this.preferCloneMU);
      if (mu) {
        this.mus.push(mu);
        this.totalSpawned++;
        debug('transport', `Source "${source.node.name}" spawned MU #${this.totalSpawned}: "${mu.getName()}"`);
        // plan-394: the role travels from the source, not on the clone —
        // stripComponentMetadata() wiped the clone's rv_extras.
        this.muLifecycleHook?.onMUSpawned(mu, source.CollisionRoleForMUs);
        this._startGrow(mu, source);
      }
    }

    // 2. Update surface AABBs every tick. Surfaces under a rotating parent
    //    (e.g. a turntable platform's belt orbiting Drive-Rot-Y) move with
    //    each fixed step — their AABB centre tracks the parent rotation only
    //    if `updateAABB` is called per tick. The cost is one getWorldPosition
    //    + one quaternion multiply per surface per tick — negligible.
    //
    //    Surface-grid self-healing guard first (plan-240 §2.6): rebuild on any
    //    array reference/length change (constructor pushes, scene-mutations
    //    filter reassignment) or explicit notifyTopologyChanged().
    if (
      this._surfaceGridDirty ||
      this.surfaces !== this._lastSurfacesRef ||
      this.surfaces.length !== this._lastSurfacesLen
    ) {
      this._surfaceGrid.rebuild(this.surfaces);
      this._lastSurfacesRef = this.surfaces;
      this._lastSurfacesLen = this.surfaces.length;
      this._surfaceGridDirty = false;
      this._adjacencyCache = null; // surfaces added/removed → junction topology stale
    }
    for (const surface of this.surfaces) {
      // Accumulation (plan-255): inject the manager as the surface's leading-MU
      // query provider. Done per tick (cheap guarded assignment) so it self-heals
      // against any registration path (component init pushes, tests, planner) —
      // surfaces driven WITHOUT a manager keep provider null (legacy behavior).
      if (surface.accumulationProvider !== this) surface.accumulationProvider = this;
      surface.updateAABB();
      // Re-index moved surfaces BEFORE the MU loop (step 3) queries the grid —
      // otherwise `_pickDrivingSurface` would see a current AABB in a stale
      // cell. `update()` is a no-op while the cell span is unchanged, so this
      // covers Radial/drive-moved surfaces AND planner drags at O(1) per
      // static surface (superset of the plan's dynamic-only re-index — simpler
      // and self-healing against ANY movement source).
      this._surfaceGrid.update(surface);
      // Dead-end cache self-healing: a surface cached as STATIC whose AABB
      // changed (planner move, belt under a moving Drive) invalidates the
      // whole cache and is reclassified dynamic on the next build. Subsumes
      // the `layout-transform-update` event, which this manager cannot
      // subscribe to. Only runs while a cache exists (vanish/planner mode).
      if (this._adjacencyCache) {
        const adj = this._adjacencyCache.get(surface);
        if (adj && !adj.isDynamic) {
          const a = surface.aabb;
          if (
            a.min.x !== adj.sigMinX || a.min.z !== adj.sigMinZ ||
            a.max.x !== adj.sigMaxX || a.max.z !== adj.sigMaxZ
          ) {
            this._observedMoving.add(surface);
            this._adjacencyCache = null;
          }
        }
      }
    }

    // 3. Transport: each MU is moved by exactly one surface (currentSurface)
    //    Skip gripped MUs — they move with the grip node via Three.js parent chain
    const tickId = RVTransportSurface.currentTickId;
    this._hasVanishing = false; // recomputed below while any MU is mid-dissolve
    this._hasGrowing = false;   // recomputed below while any MU is mid grow-out
    for (const mu of this.mus) {
      if (mu.markedForRemoval) continue;

      // Accumulation hygiene (plan-255): the gap clamp only runs for MOVING MUs
      // (inside transportMU's speed guard), so `blocked` is reset here every tick
      // — a stopped belt or a runtime `Accumulate=false` toggle never leaves a
      // stale blocked=true behind.
      mu.blocked = false;

      // Spawn grow-out: a freshly-spawned clone MU plays a short clip effect that
      // grows it out of the source along its move direction. Purely visual — it
      // runs independent of transport/grip/vanish below (a gripped MU keeps
      // growing too; the effect is brief).
      if (!mu.isInstanced && (mu as RVMovingUnit).grow) this._advanceGrow(mu as RVMovingUnit);

      if (!mu.isInstanced && (mu as RVMovingUnit).isGripped) continue;

      // Physics ownership (plan-276 F4): the provider drives this MU — skip
      // the whole kinematic pipeline. MUST come AFTER the `mu.blocked = false`
      // reset above (a stale blocked flag would corrupt the accumulation
      // diagnostics) and AFTER the isGripped skip (gripped MUs are never
      // physics-owned — structural exclusion, see plan-276 §5.2/F15).
      if (mu.physicsOwned) continue;

      // Pick the single surface that drives this MU this tick. When a good
      // straddles two belts (a hand-off), an ACTIVE (running) overlapping surface
      // wins so a stopped upstream belt never freezes a good the downstream belt
      // is ready to pull. See `_pickDrivingSurface` for the full priority.
      const prev = mu.currentSurface;
      const driver = this._pickDrivingSurface(mu);
      if (driver) {
        // Physics-mode surface (plan-276 Phase 4, F5): the MU is handed to the
        // provider the MOMENT it enters a physics-managed surface (not only at
        // the belt end) — the provider's conveyor body carries it via friction
        // from here; the gap clamp never runs for it (physicsOwned is filtered
        // everywhere). While the provider is still loading, the MU keeps
        // moving kinematically and the check retries next tick (F4 pattern).
        if (this.physicsManagedSurfaces !== null && this.physicsManagedSurfaces.has(driver)) {
          this._tryPhysicsSurfaceHandover(mu, driver);
          if (mu.physicsOwned) continue; // provider owns it — skip transport + vanish
        }
        if (driver !== prev) {
          // Ownership changed — clear the carry marker so `transportMU` doesn't
          // apply a phantom parent-rotation delta on the entry tick (its carry
          // guard fires only when `lastSurfaceTickId === tickId - 1`).
          mu.lastSurfaceTickId = undefined;
          mu.currentSurface = driver;
          debug('transport', `MU "${mu.getName()}" entered surface "${driver.node.name}"`);
        }
        driver.transportMU(mu, dt);
        // Tag AFTER the call so a STAY sees the previous tick's value (carry),
        // while a SWITCH already reset it to undefined above (no phantom carry).
        mu.lastSurfaceTickId = tickId;
        // Remember it has been transported (gates the end-of-line vanish so
        // freshly-spawned MUs not yet on a belt are never deleted).
        mu.everOnSurface = true;
        // Remember whether the surface it's on belongs to a planner-placed
        // layout object — vanish is scoped to those. Latched while it HAS a
        // surface so it survives the moment the MU runs off (currentSurface null).
        mu.onLayoutObject = surfaceIsLayoutObject(driver);
        // Latch the driving surface so the dead-end vanish can check ITS
        // outgoing-snap connectivity even after the MU runs off (currentSurface
        // becomes null).
        mu.lastSurface = driver;
      } else {
        mu.currentSurface = null;
        mu.lastSurfaceTickId = undefined;
        // Physics handover at the conveyor end (plan-276 F4): no driving
        // surface AND the MU's AABB overlaps a physics zone → the provider
        // takes over with an explicit belt-velocity handover. Runs EVERY tick
        // in this no-driver branch (self-healing retry while the provider is
        // still loading; deliberately independent of the dead-end cache below,
        // which only serves the vanish feature).
        this._tryPhysicsHandover(mu);
        if (mu.physicsOwned) continue; // handed over — skip vanish bookkeeping
      }

      // End-of-line vanish: an MU that has been transported and now sits at a
      // dead end (no successor surface ahead — parked on a stopped discharge
      // belt OR run off the end entirely) is deleted after `vanishDelaySec`.
      // SCOPED to layout objects: MUs reaching a dead end on the authored GLB
      // scene are left alone (only planner-placed lines vanish their MUs).
      // Gripped MUs never reach here (skipped above). The timer resets the
      // instant the MU advances onto / toward another surface.
      if (this.vanishMUsAtEndOfLine && mu.everOnSurface && mu.onLayoutObject
          && this._isAtDeadEnd(mu) && !this._outputConnected(mu)) {
        mu.offSurfaceTime = (mu.offSurfaceTime ?? 0) + dt;
        if (mu.offSurfaceTime >= this.vanishDelaySec) this._advanceVanish(mu, dt);
      } else {
        mu.offSurfaceTime = 0;
        // Picked up again before the dissolve finished — cancel it and restore
        // the MU's normal look.
        if (!mu.isInstanced) {
          const m = mu as RVMovingUnit;
          if (m.dissolve) {
            m.dissolve.dispose();
            m.dissolve = null;
            m.vanishElapsed = undefined;
          }
        }
      }
    }

    // 3b. Grips: flank detection → pick/place
    for (const grip of this.grips) {
      grip.fixedUpdate();
    }

    // 4. Update MU AABBs after transport
    for (const mu of this.mus) {
      if (!mu.markedForRemoval) {
        mu.updateAABB();
        // Keep the MU grid current BEFORE the sensor/sink checks (steps 5/6):
        // `update()` lazy-inserts unknown MUs, so every MU that shows up in
        // `this.mus` — source spawn, multiuser follower push, direct test
        // push — is indexed the same tick (self-healing, plan-240 §2.6).
        // Marked MUs keep their (stale) entry until step 7 removes it; grid
        // queries may therefore return them — callers filter, as with
        // `this.mus` today.
        this._muGrid.update(mu);
      }
    }

    // 5. Sensors: check overlap. Small scenes stay on the plain array scan;
    //    larger ones query the MU grid. Candidate order is the stable spawn
    //    ordinal (seq) — deterministic first-hit even under multi-occupancy
    //    (stricter than the swap-and-pop-mutated `this.mus` order, F1).
    const useGrid = this.mus.length >= this.bruteForceThreshold;
    for (const sensor of this.sensors) {
      sensor.updateAABB();
      // Physics-managed sensor (plan-276 Phase 5, F6): the provider owns its
      // detection — enter/leave events / raycasts drive `occupied` in the
      // physics plugin's onFixedUpdatePost. Skip the kinematic check entirely
      // (it would fight the event-driven state every tick).
      if (this.physicsManagedSensors !== null && this.physicsManagedSensors.has(sensor)) continue;
      if (!useGrid || sensor.liveControlled) {
        // liveControlled sensors skip local detection inside checkOverlap —
        // don't spend a grid query on them.
        sensor.checkOverlap(this.mus);
      } else if (sensor.UseRaycast) {
        // Raycast mode: the query bounds must cover the BEAM segment — the
        // sensor's own AABB does not (the ray extends RayCastLength beyond
        // the node). checkRaycast keeps the exact ray-vs-AABB test.
        sensor.computeRayQueryBounds(this._rayQueryAABB);
        this._muGrid.queryXZ(this._rayQueryAABB, this._muCandidates);
        sensor.checkOverlap(this._muCandidates);
      } else {
        this._muGrid.queryXZ(sensor.aabb, this._muCandidates);
        sensor.checkOverlap(this._muCandidates);
      }
    }

    // 6. Sinks: mark overlapping MUs (skip gripped MUs). Same candidate
    //    sourcing as the sensors; markOverlapping keeps its own exact
    //    overlap + markedForRemoval/isGripped filtering.
    for (const sink of this.sinks) {
      sink.updateAABB();
      if (!useGrid) {
        sink.markOverlapping(this.mus);
      } else {
        this._muGrid.queryXZ(sink.aabb, this._muCandidates);
        sink.markOverlapping(this._muCandidates);
      }
    }

    // 7. Remove marked MUs (reverse iteration, swap-and-pop — no splice!)
    for (let i = this.mus.length - 1; i >= 0; i--) {
      if (this.mus[i].markedForRemoval) {
        const removedMU = this.mus[i];
        // Drop the grid entry first (remove() uses the STORED cell span, so
        // this is exact even though the marked MU skipped its AABB update).
        this._muGrid.remove(removedMU);
        // Physics chokepoint (plan-276 F14): free the provider body BEFORE
        // mu.dispose() — the hook is idempotent for non-owned MUs.
        this.physicsMUHook?.onMUDisposed(removedMU);
        this.muLifecycleHook?.onMURemoved(removedMU);
        // Notify grips of MU disposal
        if (!removedMU.isInstanced) {
          for (const grip of this.grips) {
            grip.onMUDisposed(removedMU as RVMovingUnit);
          }
        }
        // Clear gripTarget occupancy if this MU was placed on one
        for (const target of this.gripTargets) {
          if (target.occupiedBy === removedMU) {
            target.clearOccupied();
          }
        }
        removedMU.dispose();
        this.totalConsumed++;
        // Swap with last element and pop
        this.mus[i] = this.mus[this.mus.length - 1];
        this.mus.pop();
      }
    }

    // 8. Batch-update instance matrices after all position changes
    this.updatePoolMatrices();
  }

  /**
   * Choose the one surface that drives `mu` this tick among all it overlaps (XZ).
   * A good is always carried by exactly one surface (no double-driving); the
   * question is which, when it touches several at once during a hand-off.
   *
   * A good always rests on the TOPMOST surface beneath it: among all surfaces it
   * overlaps in XZ, only those whose top is within `TOP_EPS` of the highest top
   * are eligible. For a normal line (coplanar belts at a seam) every top is equal
   * so the band holds them all and the priority below is unchanged; for STACKED
   * surfaces — the ChainTransfer's fixed Z rollers and its lifting X chains — the
   * good is handed to whichever is currently on top (chains while raised, rollers
   * once the lift drops below them).
   *
   * Within the topmost band, priority:
   *  1. Keep the current surface if it is in the band AND active — sticky
   *     ownership avoids churn and keeps a moving good on its belt.
   *  2. Otherwise an ACTIVE band surface that the good is ENTERING — the
   *     downstream belt pulls the good IN off a stopped upstream belt. The
   *     "entering" gate stops a still-running UPSTREAM belt from shoving a good
   *     that just halted at its sensor further forward.
   *  3. Otherwise the current band surface even if stopped, else the first band
   *     surface.
   *  4. null when the MU overlaps no surface.
   *
   * Attachment stays purely geometric — a stopped belt is still a valid owner, so
   * a good keeps its place and starts moving the instant that belt's drive runs.
   */
  private _pickDrivingSurface(mu: RVMovingUnit | InstancedMovingUnit): RVTransportSurface | null {
    // World positions are metres; stacked ChainTransfer surfaces differ by ≥1 cm,
    // coplanar line belts by ≤ a few mm — 5 mm cleanly separates the two.
    const TOP_EPS = 0.005;

    const overlapping = this._overlapScratch;
    overlapping.length = 0;
    let topY = -Infinity;
    if (this.surfaces.length >= this.bruteForceThreshold) {
      // Grid path (F2): exact XZ-overlap candidates in seq order. seq is the
      // surfaces-array order at rebuild time, so the priority tie-breaks
      // below ("first band surface") match the brute-force path.
      const count = this._surfaceGrid.queryXZ(mu.aabb, this._surfaceCandidates);
      for (let i = 0; i < count; i++) {
        const s = this._surfaceCandidates[i];
        overlapping.push(s);
        if (s.aabb.max.y > topY) topY = s.aabb.max.y;
      }
    } else {
      for (const s of this.surfaces) {
        if (!s.aabb.overlapsXZ(mu.aabb)) continue;
        overlapping.push(s);
        if (s.aabb.max.y > topY) topY = s.aabb.max.y;
      }
    }
    if (overlapping.length === 0) return null;                          // (4)
    const minTop = topY - TOP_EPS;

    const curr = mu.currentSurface;
    const currInBand = !!curr && overlapping.includes(curr) && curr.aabb.max.y >= minTop;
    if (currInBand && curr!.isActive) return curr!;                     // (1)

    let stoppedFallback: RVTransportSurface | null = currInBand ? curr! : null;
    for (const s of overlapping) {
      if (s.aabb.max.y < minTop) continue;                             // not the topmost surface
      if (s.isActive && this._goodIsEntering(s, mu)) return s;          // (2)
      if (!stoppedFallback) stoppedFallback = s;                       // (3)
    }
    return stoppedFallback;
  }

  /**
   * Kinematic → physics handover at a conveyor end (plan-276 F4). Called every
   * tick from the no-driver branch of the MU loop. Containment criterion is
   * AABB OVERLAP with a zone (NOT full containment — an MU that lost its
   * driver but only partially reached the zone box must not freeze mid-air).
   * The initial velocity is direction × speed of the LAST driving surface
   * (sticky driver, survives running off the belt); v = 0 is allowed (stopped
   * belt / free spawn) — the MU then falls straight down. While the provider
   * is absent, not ready or failed the MU simply stays kinematic and the
   * check repeats next tick (self-healing retry).
   */
  private _tryPhysicsHandover(mu: RVMovingUnit | InstancedMovingUnit): void {
    if (mu.physicsOwned || !physicsSettings.enabled) return;
    if (RVPhysicsZone.zones.length === 0) return;
    const provider = physicsRegistry.provider;
    if (!provider || !provider.ready || provider.failed) return;

    const zone = RVPhysicsZone.findZoneOverlapping(mu.aabb);
    if (!zone || !zone.active) return;

    // Belt velocity comes from the LAST driving surface (sticky driver —
    // survives running off the belt); null → v = 0 (F4).
    this._handoverToPhysics(mu, mu.lastSurface ?? null, provider, `zone "${zone.node.name}"`);
  }

  /**
   * Immediate kinematic → physics handover the moment an MU ENTERS a
   * physics-managed surface (plan-276 Phase 4, F5). Unlike the conveyor-end
   * handover (F4) there is NO zone-overlap check on the MU: the plugin only
   * marks surfaces FULLY contained in a zone, so the MU is inside the zone by
   * construction. Same self-healing as F4 — while the provider is absent, not
   * ready or failed, the MU keeps moving kinematically and retries next tick.
   */
  private _tryPhysicsSurfaceHandover(
    mu: RVMovingUnit | InstancedMovingUnit,
    surface: RVTransportSurface,
  ): void {
    if (mu.physicsOwned || !physicsSettings.enabled) return;
    const provider = physicsRegistry.provider;
    if (!provider || !provider.ready || provider.failed) return;
    this._handoverToPhysics(mu, surface, provider, `physics surface "${surface.node.name}"`);
  }

  /**
   * Shared handover tail (F4 + F5): initial velocity = `surface` direction ×
   * speed in m/s (speed is mm/s and SIGNED — a reversed belt hands over with a
   * negative-direction velocity automatically; null surface / no drive → v=0),
   * then the MU's WORLD pose → `provider.addDynamicMU` + ownership flags.
   * Zero-GC: all scratch is module-level and copied synchronously by the
   * provider inside `addDynamicMU`.
   */
  private _handoverToPhysics(
    mu: RVMovingUnit | InstancedMovingUnit,
    surface: RVTransportSurface | null,
    provider: PhysicsProvider,
    debugContext: string,
  ): void {
    if (surface && surface.drive) {
      surface.getWorldDirection(_handoverVel).multiplyScalar(surface.speed / MM_TO_METERS);
    } else {
      _handoverVel.set(0, 0, 0);
    }

    // World pose. Clone MUs store a PARENT-local quaternion on the node —
    // hand over the WORLD rotation; instanced pool quaternions are world-space.
    mu.getWorldPosition(_handoverPos);
    if (mu.isInstanced) {
      _handoverQuat.copy(mu.getQuaternion());
    } else {
      (mu as RVMovingUnit).node.getWorldQuaternion(_handoverQuat);
    }
    _handoverPose.pos.x = _handoverPos.x;
    _handoverPose.pos.y = _handoverPos.y;
    _handoverPose.pos.z = _handoverPos.z;
    _handoverPose.quat.x = _handoverQuat.x;
    _handoverPose.quat.y = _handoverQuat.y;
    _handoverPose.quat.z = _handoverQuat.z;
    _handoverPose.quat.w = _handoverQuat.w;

    const bodyId = String(mu.id);
    provider.addDynamicMU(bodyId, _handoverPose, mu.aabb.halfSize, _handoverVel);
    mu.physicsOwned = true;
    mu.physicsBodyId = bodyId;
    debug('transport', `MU "${mu.getName()}" handed over to physics (${debugContext})`);
  }

  /**
   * True when surface `s`'s motion would carry `mu` DEEPER into `s` (a downstream
   * pull), false when `s` would only shove an already-exiting good further out (an
   * upstream drag). Used to gate hand-off to a non-current active surface during a
   * seam straddle, so a running upstream belt can't drag a good past the sensor it
   * just stopped at. Rule (1) handles a good travelling along its OWN active belt,
   * so this never gates normal mid-belt motion.
   */
  private _goodIsEntering(s: RVTransportSurface, mu: RVMovingUnit | InstancedMovingUnit): boolean {
    // Actual motion direction (sign(speed) handles a reversed belt).
    s.getWorldDirection(_pickDir).multiplyScalar(Math.sign(s.speed));
    _pickToMu.copy(mu.aabb.center).sub(s.aabb.center);
    return _pickDir.dot(_pickToMu) <= 0;                               // mu behind centre along motion → entering
  }

  /**
   * Drive the end-of-line dissolve for an MU whose dwell delay has expired.
   * Instanced MUs have no per-instance material, so they're removed instantly.
   * Clone MUs play a short sci-fi burn (bottom-to-top world-Y clip) and are
   * removed only once it completes.
   */
  /**
   * Begin the spawn grow-out effect on a freshly-spawned MU. Clip-based, so only
   * clone-path MUs (real per-mesh materials) get it; instanced MUs are skipped.
   * Anchors a FIXED world clip plane at the MU's leading edge along the source's
   * horizontal discharge direction — the MU then physically slides out of that
   * static plane as it travels (the stripe stays put). No-ops when the source has
   * no surface direction (free-standing source).
   */
  private _startGrow(mu: RVMovingUnit | InstancedMovingUnit, source: RVSource): void {
    if (mu.isInstanced) return;
    if (!source.getDischargeDirection(_growDir)) return; // free-standing source → no effect

    const m = mu as RVMovingUnit;
    m.updateAABB(); // freshly constructed — make sure center/halfSize are world-current
    m.node.getWorldPosition(_growOrigin);

    // MU extent along the discharge axis, relative to the node origin. Axis is
    // horizontal (y=0), so only x/z contribute to the half-extent radius.
    const c = m.aabb.center;
    const h = m.aabb.halfSize;
    const cOff = (c.x - _growOrigin.x) * _growDir.x + (c.z - _growOrigin.z) * _growDir.z;
    const r = Math.abs(_growDir.x) * h.x + Math.abs(_growDir.z) * h.z;

    // Clip plane fixed in world at the leading edge (node origin + (cOff+r) along
    // the axis) → the whole MU starts behind the plane (fully clipped). The
    // trailing edge sits at (cOff - r) relative to the node origin.
    _growPlane.copy(_growOrigin).addScaledVector(_growDir, cOff + r);
    m.grow = createMUGrow(m.node, _growDir, _growPlane, cOff - r, this.isWebGPU);
    this._hasGrowing = true;
  }

  /**
   * Re-evaluate the spawn grow-out effect for `m` against its current world
   * position. The clip plane is fixed in world, so there is nothing to animate —
   * we only detect full emergence (dispose, restoring materials) and keep the
   * renderer awake while the MU is still moving through the plane. Visual only:
   * AABB / sensors / sinks always see the full MU.
   */
  private _advanceGrow(m: RVMovingUnit): void {
    if (!m.grow) return;
    m.node.getWorldPosition(_growOrigin);
    const { finished, moved } = m.grow.update(_growOrigin);
    if (finished) {
      m.grow.dispose();
      m.grow = null;
    } else if (moved) {
      this._hasGrowing = true; // keep the renderer awake while it emerges
    }
  }

  private _advanceVanish(mu: RVMovingUnit | InstancedMovingUnit, dt: number): void {
    if (mu.isInstanced) {
      mu.markedForRemoval = true;
      return;
    }
    const m = mu as RVMovingUnit;
    if (!m.dissolve) {
      // Sweep the burn edge across the MU's current world-Y bounds.
      m.dissolve = createMUDissolve(m.node, m.aabb.min.y, m.aabb.max.y, this.isWebGPU);
      m.vanishElapsed = 0;
    } else {
      m.vanishElapsed = (m.vanishElapsed ?? 0) + dt;
    }
    const p = (m.vanishElapsed ?? 0) / this.vanishDurationSec;
    m.dissolve.setProgress(p);
    if (p >= 1) {
      mu.markedForRemoval = true; // dispose() restores + frees the burn materials
    } else {
      this._hasVanishing = true;  // keep the renderer awake until the burn ends
    }
  }

  /**
   * True when `mu` sits at a DEAD END — the asset it is on has NO output in any
   * direction, so it is genuinely stuck (only then should it vanish).
   *
   *   • `currentSurface === null` — it already ran off all surfaces.
   *   • Plain belt: probing one MU-half + `vanishProbeAheadM` ahead along the
   *     belt's transport direction finds no surface beyond the discharge edge.
   *
   * Router assets (which can discharge in directions OTHER than the current
   * surface's transport axis) are handled so they are NOT wrongly vanished:
   *   • Turntable — a single `Radial` surface that rotates to any conveyor it
   *     touches; if it overlaps any other surface (an arm), output exists.
   *   • Chain-transfer — two surfaces STACKED on one footprint (rollers + cross
   *     chains) with perpendicular directions. They are grouped (their XZ
   *     overlap dominates a footprint) and the probe runs along EVERY group
   *     member's direction, so the sideways output is seen.
   *
   * Plain belt-to-belt seams overlap only slightly (below the grouping
   * threshold), so they stay external successors and the original single-belt
   * end-of-line behaviour is unchanged.
   */
  /**
   * True when the MU's current (or, after it ran off, most recent) surface has a
   * CONNECTED outgoing snap point — i.e. a real downstream successor exists even
   * if geometry says otherwise (a rotated turntable's footprint may no longer
   * overlap the discharge edge). Used to suppress the end-of-line vanish: a
   * connected line never vanishes its MUs; only a free discharge end does.
   * Returns false when no connectivity predicate is wired (geometry-only).
   */
  private _outputConnected(mu: RVMovingUnit | InstancedMovingUnit): boolean {
    if (!this.isOutputConnected) return false;
    const s = mu.currentSurface ?? mu.lastSurface ?? null;
    return s ? this.isOutputConnected(s) : false;
  }

  private _isAtDeadEnd(mu: RVMovingUnit | InstancedMovingUnit): boolean {
    const s = mu.currentSurface;
    if (!s) return true;                                  // ran off every surface

    // Junction group: the current surface + any surface STACKED on it (a
    // transfer junction whose sibling shares the same footprint). Plain seams
    // overlap only slightly and are NOT grouped — they remain external outputs.
    //
    // Hybrid sourcing (plan-240 Baustein 2): STATIC surfaces read their
    // stacked siblings from the adjacency cache (plus a live check of the few
    // DYNAMIC surfaces, whose overlap can change between cache builds);
    // dynamic surfaces run the live scan — over grid candidates instead of
    // ALL surfaces. `_overlapFractionXZ` stays the single grouping predicate.
    const group = this._deadEndGroup;
    group.length = 0;
    group.push(s);
    const adj = this._ensureAdjacency().get(s);
    if (adj && !adj.isDynamic) {
      for (const g of adj.group) group.push(g);
      for (const d of this._dynamicSurfaces) {
        if (d !== s && this._overlapFractionXZ(d.aabb, s.aabb) >= 0.5) group.push(d);
      }
    } else {
      // Dynamic (Radial/observed-moving) — live scan, grid-narrowed. A ≥0.5
      // overlap fraction requires XZ overlap, so grid candidates suffice.
      const count = this._surfaceGrid.queryXZ(s.aabb, this._surfaceCandidates);
      for (let i = 0; i < count; i++) {
        const surf = this._surfaceCandidates[i];
        if (surf !== s && this._overlapFractionXZ(surf.aabb, s.aabb) >= 0.5) group.push(surf);
      }
    }

    // Turntable: a radial surface discharges to whatever conveyor it touches.
    // Any overlap with a surface OUTSIDE the junction → an output exists.
    // ALWAYS live (Radial is classified dynamic — rotation is exactly how a
    // turntable's AABB neighborhood changes per tick); the grid query returns
    // precisely the XZ-overlapping surfaces.
    if (s.Radial) {
      const count = this._surfaceGrid.queryXZ(s.aabb, this._surfaceCandidates);
      for (let i = 0; i < count; i++) {
        const surf = this._surfaceCandidates[i];
        if (group.includes(surf)) continue;
        if (surf.aabb.overlapsXZ(s.aabb)) return false;
      }
      return true;                                        // lone turntable, no arms → stuck
    }

    // Probe forward along EVERY junction member's direction. A hit on a group
    // member = the MU still has room to travel within this asset (not at the
    // edge yet); a hit on a surface OUTSIDE the group = a real successor.
    //
    // Probe TARGETS are resolved through the surface grid at the probe point
    // (deviation from the plan's precomputed "Sonden-Ziele": the probe reach
    // depends on the querying MU's half-extents and cannot be bounded at
    // cache-build time without risking false vanishes for large MUs — the
    // grid is always current and MU-size-independent; correctness first).
    const c = mu.aabb.center;
    let roomAhead = false;
    for (const js of group) {
      const d = js.getWorldDirection(_deadEndDir);
      const muHalf = Math.abs(d.x) * mu.aabb.halfSize.x + Math.abs(d.z) * mu.aabb.halfSize.z;
      const reach = muHalf + this.vanishProbeAheadM;
      const px = c.x + d.x * reach;
      const pz = c.z + d.z * reach;
      this._probeAABB.min.set(px, 0, pz);
      this._probeAABB.max.set(px, 0, pz);
      const count = this._surfaceGrid.queryXZ(this._probeAABB, this._surfaceCandidates);
      for (let i = 0; i < count; i++) {
        const surf = this._surfaceCandidates[i];
        const a = surf.aabb;
        if (px < a.min.x || px > a.max.x || pz < a.min.z || pz > a.max.z) continue;
        if (group.includes(surf)) roomAhead = true;       // still within this asset
        else return false;                                // external successor → not stuck
      }
    }
    return !roomAhead;
  }

  /**
   * Lazily (re)build the dead-end adjacency cache (plan-240 Baustein 2).
   * Cold path — invalidation is rare (placement/removal/planner move), so the
   * per-build allocations here are acceptable; the per-tick hot path only
   * reads. Must run with a CURRENT surface grid (guaranteed: callers sit in
   * step 3, after the step-2 guard/updates).
   *
   * Classification: `Radial === true` OR observed-moving → dynamic (never
   * cached, always live-scanned). "Under an active Drive" is not cheaply
   * detectable up front, so non-Radial moved surfaces are LEARNED via the
   * per-tick AABB-signature check instead (see `_observedMoving`).
   */
  private _ensureAdjacency(): Map<RVTransportSurface, SurfaceAdjacency> {
    let cache = this._adjacencyCache;
    if (cache) return cache;
    cache = new Map();
    this._dynamicSurfaces.length = 0;
    for (const s of this.surfaces) {
      if (s.Radial || this._observedMoving.has(s)) this._dynamicSurfaces.push(s);
    }
    const candidates: RVTransportSurface[] = [];
    for (const s of this.surfaces) {
      const isDynamic = s.Radial || this._observedMoving.has(s);
      const group: RVTransportSurface[] = [];
      if (!isDynamic) {
        const count = this._surfaceGrid.queryXZ(s.aabb, candidates);
        for (let i = 0; i < count; i++) {
          const other = candidates[i];
          if (other === s) continue;
          if (other.Radial || this._observedMoving.has(other)) continue; // dynamic sibs live-checked per query
          if (this._overlapFractionXZ(other.aabb, s.aabb) >= 0.5) group.push(other);
        }
      }
      cache.set(s, {
        group,
        isDynamic,
        sigMinX: s.aabb.min.x,
        sigMinZ: s.aabb.min.z,
        sigMaxX: s.aabb.max.x,
        sigMaxZ: s.aabb.max.z,
      });
    }
    this._adjacencyCache = cache;
    return cache;
  }

  /**
   * Fraction (0–1) of the SMALLER footprint covered by the XZ overlap of two
   * surface AABBs. ~1 for stacked transfer siblings (same footprint), small for
   * belt-to-belt seams — the signal that separates a routing junction from
   * ordinary neighbours.
   */
  private _overlapFractionXZ(a: AABB, b: AABB): number {
    const ox = Math.min(a.max.x, b.max.x) - Math.max(a.min.x, b.min.x);
    const oz = Math.min(a.max.z, b.max.z) - Math.max(a.min.z, b.min.z);
    if (ox <= 0 || oz <= 0) return 0;
    const overlap = ox * oz;
    const areaA = (a.max.x - a.min.x) * (a.max.z - a.min.z);
    const areaB = (b.max.x - b.min.x) * (b.max.z - b.min.z);
    const fa = areaA > 0 ? overlap / areaA : 0;
    const fb = areaB > 0 ? overlap / areaB : 0;
    return Math.max(fa, fb);
  }

  // ── Accumulation queries (plan-255) ─────────────────────────────────

  /**
   * Collect candidate MUs ahead of `mu` along `moveDir` within `lookahead`
   * metres beyond its AABB (forward probe — same pattern as `_isAtDeadEnd`).
   * IMPLEMENTS IAccumulationQuery::queryLeadingMU.
   *
   * Query bounds = the MU's AABB extruded by `lookahead` along the SIGNED
   * `moveDir` (XZ). Below `bruteForceThreshold` live MUs the plain array scan
   * is used (grid overhead > gain), above it the `_muGrid`. Self,
   * `markedForRemoval`, gripped AND `physicsOwned` candidates are filtered
   * here (gripped MUs stay indexed in the grid but hang from a gripper;
   * physics-owned MUs are the provider's — plan-276, no gap-clamp double
   * logic at the handover point); geometric front/lane/gap filtering stays
   * with the caller. GC-free: reused scratch AABB + caller-owned `out`.
   */
  queryLeadingMU(
    mu: RVMovingUnit | InstancedMovingUnit,
    moveDir: Vector3,
    lookahead: number,
    out: (RVMovingUnit | InstancedMovingUnit)[],
  ): number {
    out.length = 0;
    const qa = this._accumQueryAABB;
    qa.min.copy(mu.aabb.min);
    qa.max.copy(mu.aabb.max);
    const ex = moveDir.x * lookahead;
    const ez = moveDir.z * lookahead;
    if (ex > 0) qa.max.x += ex; else qa.min.x += ex;
    if (ez > 0) qa.max.z += ez; else qa.min.z += ez;

    if (this.mus.length < this.bruteForceThreshold) {
      for (const other of this.mus) {
        if (other === mu || other.markedForRemoval || other.physicsOwned) continue;
        if (!other.isInstanced && (other as RVMovingUnit).isGripped) continue;
        const a = other.aabb;
        if (a.min.x > qa.max.x || a.max.x < qa.min.x || a.min.z > qa.max.z || a.max.z < qa.min.z) continue;
        out.push(other);
      }
      return out.length;
    }

    const count = this._muGrid.queryXZ(qa, this._accumGridScratch);
    for (let i = 0; i < count; i++) {
      const other = this._accumGridScratch[i];
      if (other === mu || other.markedForRemoval || other.physicsOwned) continue;
      if (!other.isInstanced && (other as RVMovingUnit).isGripped) continue;
      out.push(other);
    }
    return out.length;
  }

  /**
   * True when any live MU's AABB overlaps `area` (full 3D test — a belt on
   * another level never counts). Same candidate filters as `queryLeadingMU`.
   * Used by the Source spawn gate (plan-255 F6a) so a jam that backs up to the
   * source delays the next spawn instead of stacking MUs into each other.
   */
  isAreaOccupiedByMU(area: AABB): boolean {
    if (this.mus.length < this.bruteForceThreshold) {
      for (const other of this.mus) {
        if (other.markedForRemoval || other.physicsOwned) continue;
        if (!other.isInstanced && (other as RVMovingUnit).isGripped) continue;
        if (other.aabb.overlaps(area)) return true;
      }
      return false;
    }
    const count = this._muGrid.queryXZ(area, this._muCandidates);
    for (let i = 0; i < count; i++) {
      const other = this._muCandidates[i];
      if (other.markedForRemoval || other.physicsOwned) continue;
      if (!other.isInstanced && (other as RVMovingUnit).isGripped) continue;
      if (other.aabb.overlaps(area)) return true;
    }
    return false;
  }

  /** Number of live MUs currently jam-blocked by the accumulation clamp
   *  (diagnostic — surfaces in `web_transport_status.blockedMuCount`). */
  get blockedMuCount(): number {
    let n = 0;
    for (const mu of this.mus) {
      if (!mu.markedForRemoval && mu.blocked) n++;
    }
    return n;
  }

  /**
   * Immediately remove a single MU from the simulation (full cleanup: grip
   * notification, gripTarget release, dispose, list removal). Unlike setting
   * `markedForRemoval`, this works even when the sim is PAUSED (the removal
   * loop in `update()` never runs while paused) — used by the Layout-Planner
   * to delete a selected MU on demand. Idempotent: a no-op if the MU isn't
   * currently tracked.
   */
  removeMU(mu: RVMovingUnit | InstancedMovingUnit): void {
    const idx = this.mus.indexOf(mu);
    if (idx < 0) return;

    this._muGrid.remove(mu);
    // Physics chokepoint (plan-276 F14): this is a dispose path too.
    this.physicsMUHook?.onMUDisposed(mu);
    this.muLifecycleHook?.onMURemoved(mu);
    if (!mu.isInstanced) {
      for (const grip of this.grips) {
        grip.onMUDisposed(mu as RVMovingUnit);
      }
    }
    for (const target of this.gripTargets) {
      if (target.occupiedBy === mu) target.clearOccupied();
    }
    mu.dispose();
    this.totalConsumed++;

    // Swap-and-pop (matches the update() removal loop).
    this.mus[idx] = this.mus[this.mus.length - 1];
    this.mus.pop();

    // Refresh instanced pool matrices so a released slot stops rendering at
    // its stale position right away (clone removal already detached the node).
    if (mu.isInstanced) this.updatePoolMatrices();
  }

  /**
   * Resolve a live MU by its engine-wide numeric id (plan-259 Phase 2 —
   * the id↔MU lookup behind the script SDK's `ScriptMuRef.id`). Linear scan:
   * calls are event-scoped (sensor enter / mu.release), never per-tick.
   * Returns null for unknown or already-removed ids.
   */
  muById(id: number): (RVMovingUnit | InstancedMovingUnit) | null {
    for (const mu of this.mus) {
      if (mu.id === id && !mu.markedForRemoval) return mu;
    }
    return null;
  }

  /** Get counts for stats display */
  get stats() {
    let occupiedSensors = 0;
    for (const s of this.sensors) {
      if (s.occupied) occupiedSensors++;
    }
    return {
      mus: this.mus.length,
      sensors: this.sensors.length,
      sensorsOccupied: occupiedSensors,
      surfaces: this.surfaces.length,
      sources: this.sources.length,
      sinks: this.sinks.length,
      totalSpawned: this.totalSpawned,
      totalConsumed: this.totalConsumed,
    };
  }

  /**
   * Animate conveyor belt textures (scroll UV based on drive speed).
   * Called separately from update() so it also runs when the physics plugin handles transport.
   */
  updateTextureAnimations(dt: number): void {
    for (const surface of this.surfaces) {
      surface.updateTextureAnimation(dt);
    }
  }

  /**
   * Update all instance pool matrices after transport tick.
   * Call once per frame after all MU positions have been updated.
   */
  updatePoolMatrices(): void {
    for (const source of this.sources) {
      if (source.pool) {
        source.pool.updateInstanceMatrix(this.muComputeRenderer ?? undefined);
      }
    }
  }

  /**
   * Notify the manager that the transport TOPOLOGY changed outside its own
   * arrays' reference/length guard — a planner placement/removal or a layout
   * move (transform change without array mutation). Forces a surface-grid
   * rebuild on the next tick and invalidates the dead-end adjacency cache.
   * Cheap and idempotent — safe to call defensively after any layout mutation.
   */
  notifyTopologyChanged(): void {
    this._surfaceGridDirty = true;
    this._adjacencyCache = null;
    // Fresh topology → drop the learned moving-surface classification so a
    // surface that stopped moving can be cached as static again.
    this._observedMoving.clear();
    // Re-parenting may change which surfaces sit under a layout object.
    _layoutObjectFlag.clear();
  }

  /** Reset all state */
  reset(disposeSources = false): void {
    // Spatial index (plan-240 §2.6): the MU grid always empties with `mus`;
    // the surface grid survives a plain sim reset (surfaces are untouched)
    // and is only dropped on model unload (disposeSources=true), avoiding a
    // needless full rebuild on every restart.
    this._muGrid.clear();
    if (disposeSources) {
      this._surfaceGrid.clear();
      this._lastSurfacesRef = null;
      this._lastSurfacesLen = -1;
      this._surfaceGridDirty = true;
      // Model unload — the surfaces are torn down with the scene.
      this._adjacencyCache = null;
      this._observedMoving.clear();
      this._dynamicSurfaces.length = 0;
      _layoutObjectFlag.clear();
    }
    // Reset grips before disposing MUs (so they release references cleanly)
    for (const grip of this.grips) {
      grip.reset();
    }
    for (const target of this.gripTargets) {
      target.clearOccupied();
    }
    for (const mu of this.mus) {
      // Reset chokepoint (plan-276 F14): `reset()` is "the single reset
      // chokepoint" — it serves resetSimulation(), clearModel() AND
      // SimulationKernel.setMode()→clearMUs(). Free the physics body BEFORE
      // mu.dispose() so no Rapier body is ever orphaned on a bulk dispose.
      this.physicsMUHook?.onMUDisposed(mu);
      this.muLifecycleHook?.onMURemoved(mu);
      mu.dispose();
    }
    this.mus.length = 0;
    this.totalSpawned = 0;
    this.totalConsumed = 0;
    for (const sensor of this.sensors) {
      sensor.occupied = false;
      sensor.occupiedMU = null;
    }
    // Belt surfaces: on a sim restart rewind the scrolled textures + the radial
    // accumulator and drop stale world-matrix-delta tracking, so the conveyors
    // look freshly loaded. Skipped on model unload (disposeSources) — the
    // surfaces are about to be torn down with the scene.
    if (!disposeSources) {
      for (const surface of this.surfaces) surface.reset();
    }
    // Sources: on a sim restart (resetSimulation → disposeSources=false) RE-ARM
    // them — clear the spawn timer/counters/held preview but KEEP the visual.
    // Calling dispose() here is what made web_sim_reset visually "delete" the
    // source (and strip a self-template source's translucent shells). On model
    // unload (clearModel passes disposeSources=true) DISPOSE them to free the
    // per-source GPU resources (pause-ghost plan-180, floor marker plan-181) and
    // the instance pool — otherwise every clearModel() leaks them.
    for (const source of this.sources) {
      if (disposeSources) source.dispose?.();
      else source.reset();
    }
    if (disposeSources) {
      for (const source of this.sources) {
        if (source.pool) source.pool.dispose();
      }
    }
  }
}
