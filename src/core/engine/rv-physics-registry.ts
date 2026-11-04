// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { readLocalStorage } from '../rv-safe-storage';

/**
 * rv-physics-registry.ts — Public interface + registry for the optional
 * zone-based physics provider (plan-276).
 *
 * The actual physics engine (Rapier, Rust → WASM) is a PRIVATE provider that
 * registers here from the private side (internal tier, `internal-plugins.ts`).
 * When absent — the default for every open-source / public deployment —
 * `physicsRegistry.provider` is `null` and the feature is a strict no-op (F1):
 * kinematic transport runs unchanged and no physics code is loaded.
 *
 * NOT to be confused with `rv-zone-registry.ts` (AGV path zones, plan-268):
 * that registry manages 1D path-segment CAPACITY for vehicle routing. A
 * physics zone here is a 3D box VOLUME inside which MUs become free dynamic
 * rigid bodies (falling, sliding, tipping, stacking).
 *
 * npm note (plan-276 §2.8, Omniverse pattern): the Rapier dependency is
 * OUT-OF-BAND — it is NOT declared in the public package.json. This module
 * must never import Rapier (or Three.js): the interface below uses only
 * lean `{x,y,z}` structural types so it stays dependency-free.
 */

import type { IMUAccessor } from './rv-mu';

// ─── Lean structural types (no Three.js in the provider contract) ──────────

/** Cartesian vector in world meters. */
export interface PhysicsVec3 { x: number; y: number; z: number }

/** Quaternion (x, y, z, w). */
export interface PhysicsQuat { x: number; y: number; z: number; w: number }

/** World pose of a body. */
export interface PhysicsPose { pos: PhysicsVec3; quat: PhysicsQuat }

/** Axis-aligned bounding box in world meters. */
export interface PhysicsAABB { min: PhysicsVec3; max: PhysicsVec3 }

/** Raycast result: hit distance along the (unit) direction + hit body id
 *  (`null` when the hit collider belongs to no registered body). */
export interface PhysicsRayHit { distance: number; bodyId: string | null }

/**
 * Collision shape of a MOVING machine part (plan-467 F2). Authored from the
 * node's Unity collider extras — there is deliberately NO mesh-AABB fallback:
 * a part without collider extras stays invisible to physics, exactly as today.
 *
 * `cuboid` carries the Unity BoxCollider `center` as `localOffset` (already
 * scaled and X-converted): Rapier places the collider at that offset RELATIVE
 * to the body, so an off-centre box no longer collides at the node origin
 * (SOL R1 #6).
 *
 * `convexHull` points are in the NODE frame with the node's world scale baked
 * in, decimated to at most {@link PHYSICS_HULL_MAX_POINTS} vertices, laid out
 * as flat xyz triples — the exact input `ColliderDesc.convexHull()` takes.
 */
export type PhysicsShape =
  | { kind: 'cuboid'; halfExtents: PhysicsVec3; localOffset: PhysicsVec3 }
  | { kind: 'convexHull'; points: Float32Array };

/**
 * Contact load on ONE kinematic body for the last `step()` (plan-467 F6/F7):
 * the force the contact partners exert ON the body (N) and the moment about
 * the WORLD ORIGIN (N·m).
 *
 * The reference point is the world origin — NOT the body — because the inverse
 * dynamics accumulates every wrench about the world origin as well
 * (`inward_pass`, SOL R1 #3). A per-body reference would need a transport
 * theorem shift at every consumer and would be silently wrong wherever one is
 * missing.
 */
export interface PhysicsContactLoad {
  bodyId: string;
  fx: number; fy: number; fz: number;
  mx: number; my: number; mz: number;
}

/** Per-zone simulation config (from `WebPhysicsZone` rv_extras, §2.3). */
export interface PhysicsZoneConfig {
  /** World gravity (m/s²). ONE world for all zones — the first registered
   *  zone wins (F2); omitted → provider default (0, -9.81, 0). */
  gravity?: PhysicsVec3;
  /** Default friction coefficient for MUs inside the zone. */
  friction: number;
  /** Bounciness of MUs inside the zone (0 = none). */
  restitution: number;
  /** MUs falling below this world Y (meters) are removed (F9). */
  removeBelowY: number;
  /** plan-467 F1 authoring hook: `false` keeps MOVING parts (drive/mechanism
   *  subtrees with collider extras) out of the physics world in this zone.
   *  Omitted → true (moving colliders are on wherever physics is on). */
  movingColliders?: boolean;
  /** plan-467 F16: default mass (kg) of an MU handed over inside this zone,
   *  used when the MU carries no `PhysicsMassKg` of its own. Omitted →
   *  {@link PHYSICS_DEFAULT_MU_MASS_KG}. Rapier's own default is DENSITY-based
   *  and gives a 0.2 m cube 8 g, which makes every payload meaningless. */
  muMassKg?: number;
  /** plan-2219: soft-CCD look-ahead (m) of every DYNAMIC MU created in this
   *  zone — guards thin fixed floors against tunnelling. 0 = off. Omitted →
   *  {@link PHYSICS_DEFAULT_SOFT_CCD_PREDICTION_M}. Kinematic parts keep their
   *  own per-tick soft CCD. */
  softCcdPrediction?: number;
}

// ─── Provider contract (implemented by the private Rapier provider) ────────

/**
 * Implemented by the private physics provider (plan-276 §2.3).
 *
 * Lifecycle contract:
 * - `init()` is lazy and re-entrancy-safe (a pending init promise is reused);
 *   it loads the WASM — callers treat a rejection as "provider not available".
 * - `dispose()` frees the WASM world (mandatory — no JS GC) and is safe while
 *   an `init()` is still pending (the init aborts cleanly).
 * - `step(dt)` runs with the FIXED accumulator dt only, never a frame delta;
 *   after the first step exception the provider fails off permanently
 *   (`failed === true`, single error log, every further call is a no-op).
 * - `removeBody()` is two-phase and idempotent: bodies are marked and freed
 *   at the END of the next `step()` (no dangling WASM handles mid-tick).
 */
export interface PhysicsProvider {
  /** True once `init()` completed and the world exists. */
  readonly ready: boolean;
  /** Fail-off latch: true after a `step()` exception — provider is permanently off. */
  readonly failed: boolean;

  /** Load the WASM + create the world. Re-entrancy-safe (promise reuse). */
  init(): Promise<void>;
  /** Free the world/event queue (`world.free()` is mandatory) + clear all
   *  handles. Safe while an `init()` is still pending. */
  dispose(): void;

  /** Register a zone volume (application-level AABB; first zone wins on overlap). */
  addZone(id: string, aabb: PhysicsAABB, cfg: PhysicsZoneConfig): void;
  /** Static collision geometry (chutes, bins, machine frames) as a fixed box body. */
  addStaticBox(id: string, center: PhysicsVec3, halfExtents: PhysicsVec3, quat: PhysicsQuat): void;
  /** Conveyor as kinematic velocity-based box body (friction take-along, F5). */
  addConveyor(id: string, center: PhysicsVec3, halfExtents: PhysicsVec3, quat: PhysicsQuat, friction: number): void;
  /** Update a conveyor's surface velocity (called per tick from drive speed). */
  setConveyorVelocity(id: string, vel: PhysicsVec3): void;
  /** Handover kinematic → dynamic (F4): create a dynamic MU body with an
   *  EXPLICIT initial velocity (belt direction × speed; v = 0 allowed) and an
   *  EXPLICIT mass in kg (plan-467 F16 — never Rapier's density default; CCD is
   *  enabled on the MU because Rapier runs no CCD between kinematic and dynamic
   *  bodies, rapier#303). */
  addDynamicMU(
    muId: string,
    pose: PhysicsPose,
    halfExtents: PhysicsVec3,
    initialVel: PhysicsVec3,
    massKg: number,
    shapes?: Extract<PhysicsShape, { kind: 'cuboid' }>[],
  ): void;
  /**
   * Register a MOVING machine part as a `KinematicPositionBased` body
   * (plan-467 F1/F2). Its pose is pushed every tick via
   * {@link setKinematicPose} BEFORE `step()`, from which Rapier derives the
   * contact velocity — that is what pushes, lifts and carries MUs.
   *
   * `reportContactForces` marks the body for the per-tick contact query behind
   * {@link forEachContactLoad}. Only bodies owned by a mechanism LINK need it
   * (drive-only parts collide but feed nothing back), and querying is not free.
   */
  addKinematicBody(id: string, shape: PhysicsShape, pose: PhysicsPose, reportContactForces: boolean): void;
  /**
   * Push a kinematic body's next world pose. MUST run BEFORE `step()` — a pose
   * written after the step is one tick late and pushes nothing (Rapier derives
   * the contact velocity from `next − current`). The provider copies the values
   * synchronously, so callers may reuse their scratch objects.
   */
  setKinematicPose(id: string, pose: PhysicsPose): void;
  /** Mark a body for removal (two-phase internally, idempotent — F9). */
  removeBody(muId: string): void;
  /** Sensor volume as a fixed sensor collider emitting enter/leave events (F6). */
  addSensorBox(id: string, center: PhysicsVec3, halfExtents: PhysicsVec3, quat: PhysicsQuat): void;
  /** Raycast against the world (`dir` must be unit length). */
  castRay(origin: PhysicsVec3, dir: PhysicsVec3, maxDist: number): PhysicsRayHit | null;

  /** Advance the world one FIXED step (dt = accumulator step). Skips the
   *  solver when no dynamic bodies exist; drains sensor events; flushes
   *  pending removals. Fail-off on the first exception. */
  step(dt: number): void;
  /** Zero-GC pose readback: invokes `out` per dynamic body with REUSED
   *  pos/quat objects — copy the values, never retain the references. */
  syncPoses(out: (muId: string, pos: PhysicsVec3, quat: PhysicsQuat) => void): void;
  /** Sensor enter/leave callback (wired by the plugin; fired during `step()`). */
  onSensorEvent: ((sensorId: string, muId: string, entered: boolean) => void) | null;
  /** Bodies that have been below `maxLinVel` for N CONSECUTIVE ticks
   *  (PHYSICS_SETTLE_FRAMES) AND are upright within `uprightToleranceDeg`
   *  (F7 return handover). Call exactly once per fixed tick — the internal
   *  settle counters advance per call. */
  getSettledBodies(maxLinVel: number, uprightToleranceDeg: number): string[];

  /**
   * Contact loads of the last `step()`, one callback per kinematic body that
   * was created with `reportContactForces` and is actually loaded (plan-467
   * F7). Call AFTER `step()` and at most once per tick.
   *
   * Zero-GC like {@link syncPoses}: `cb` receives a REUSED object — read the
   * numbers, never retain the reference.
   */
  forEachContactLoad(cb: (load: PhysicsContactLoad) => void): void;
}

/**
 * Injection seam for the TransportManager reset chokepoint (F14, pattern:
 * `IAccumulationQuery`). The physics plugin registers itself as this hook;
 * `reset()` AND swap-and-pop call `onMUDisposed(mu)` BEFORE `mu.dispose()`
 * so no Rapier body is ever orphaned on any dispose path.
 */
export interface IPhysicsMUHook {
  onMUDisposed(mu: IMUAccessor): void;
}

// ─── Registry singleton (IK-solver pattern, rv-ik-solver.ts) ───────────────

class PhysicsRegistry {
  private _provider: PhysicsProvider | null = null;

  /** Register the private physics provider. Pass `null` to unregister
   *  (back to the open-source strict-no-op state). */
  register(provider: PhysicsProvider | null): void {
    this._provider = provider;
  }

  /** The active provider, or `null` when physics is unavailable (default). */
  get provider(): PhysicsProvider | null {
    return this._provider;
  }

  /** Drop the registered provider (model switch / embed instance disposal). */
  clear(): void {
    this._provider = null;
  }
}

/** Singleton physics provider registry. */
export const physicsRegistry = new PhysicsRegistry();

// ─── Activation gate (F10 — load-time-only) ────────────────────────────────

/** localStorage ACTIVATION toggle (Settings panel → "Physics (whole scene)").
 *  Scope change 2026-07-11 (plan-276): opt-in switch, not a debug kill-switch. */
export const PHYSICS_FLAG_KEY = 'rv.physics';

/** Default OFF (opt-in, F10): ONLY the explicit activation values
 *  'on' | 'true' | '1' enable physics zones — anything else (including a
 *  missing key) leaves them disabled. */
export function isPhysicsFlagEnabled(): boolean {
  try {
    const v = readLocalStorage(PHYSICS_FLAG_KEY);
    return v === 'on' || v === 'true' || v === '1';
  } catch {
    return false;
  }
}

/** Effective gate = settings.json `simulation.physicsEnabled` (deploy-wide
 *  kill-switch, default true = ALLOWED) AND the localStorage activation
 *  toggle (default OFF). Pure — evaluated once at boot (main.ts). */
export function computePhysicsEnabled(configEnabled: boolean | undefined): boolean {
  return configEnabled !== false && isPhysicsFlagEnabled();
}

/** localStorage toggle for FULL physics (plan-276 F17, Beta): Settings panel →
 *  "Full physics — all conveyors (Beta)". With it, EVERY non-radial
 *  TransportSurface is physics-managed regardless of its authored
 *  `PhysicsMode` extras flag (the deployment kill-switch
 *  `RVTransportSurface.physicsDefault` still wins), and a synthetic
 *  WholeScene zone is always added when the model has no WholeScene zone. */
export const PHYSICS_FULL_FLAG_KEY = 'rv.physics.full';

/** Default OFF (Beta opt-in, F17): ONLY the explicit activation values
 *  'on' | 'true' | '1' enable full physics — anything else (including a
 *  missing key) leaves it disabled. */
export function isFullPhysicsFlagEnabled(): boolean {
  try {
    const v = readLocalStorage(PHYSICS_FULL_FLAG_KEY);
    return v === 'on' || v === 'true' || v === '1';
  } catch {
    return false;
  }
}

/** Effective FULL-physics gate (F17) — strict AND with the base gate: full
 *  physics is only ever effective when zone physics itself is enabled
 *  (`computePhysicsEnabled`, i.e. settings.json kill-switch allows it AND the
 *  user opted in via `rv.physics`) AND the `rv.physics.full` Beta toggle is
 *  on. The full flag alone activates NOTHING. Pure — evaluated once at boot
 *  (main.ts) and re-evaluated by the Settings store for the next model load. */
export function computeFullPhysics(configEnabled: boolean | undefined): boolean {
  return computePhysicsEnabled(configEnabled) && isFullPhysicsFlagEnabled();
}

// ─── Read-only diagnostics (Phase 6) ────────────────────────────────────────

/**
 * Lightweight physics diagnostics, updated in place by the private
 * physics-zone plugin (zero-GC: plain number mutations, no allocations).
 * Consumers: the Settings → Simulation read-only line and the
 * `web_transport_status` MCP tool. All zeros / `active: false` while no
 * physics world is built (the default for every public deployment).
 */
export interface PhysicsDiagnostics {
  /** True while a provider world is built and stepping. */
  active: boolean;
  /** Active zones registered with the provider (explicit + synthetic). */
  zones: number;
  /** Dynamic MU bodies currently owned by the provider. */
  bodies: number;
  /** Kinematic bodies of moving machine parts (plan-467 F13). Counted in
   *  ADDITION to `bodies`; the Settings line renders it as "N (M kinematic)". */
  kinematicBodies: number;
  /** Last measured step+sync duration in ms (one fixed tick). */
  stepMs: number;
}

/** Singleton diagnostics slot (mutated in place by the private plugin). */
export const physicsDiagnostics: PhysicsDiagnostics = {
  active: false,
  zones: 0,
  bodies: 0,
  kinematicBodies: 0,
  stepMs: 0,
};

/**
 * Load-time activation gate (F10), written ONCE at boot in main.ts from
 * settings.json + localStorage. The physics-zone plugin (Phase 3) reads it
 * BEFORE any lazy Rapier import. Default OFF (opt-in): the Settings-panel
 * toggle must be enabled explicitly. With the toggle ON and no explicit
 * zones in the model, the plugin synthesizes a WholeScene zone (F16).
 * Changing it mid-session has no effect until the next model load (v1).
 *
 * `full` (F17, Beta) is the AND-derived full-physics gate: it is only ever
 * true when `enabled` is also true (see `computeFullPhysics`) — consumers may
 * still check `enabled && full` defensively. Load-time-only like `enabled`.
 */
export const physicsSettings = { enabled: false, full: false };

// ─── Effective physics state (plan-525 §2.6 — "the model switches it on") ──

/**
 * The inputs of the effective physics gate (plan-525 §2.6), kept apart so the
 * Browser preference is never confused with the effective state:
 *
 *  - `deployAllowed` — settings.json `simulation.physicsEnabled !== false`
 *    (the deployment KILL-SWITCH, set once at boot);
 *  - `userPref` / `userFullPref` — the Settings toggles (`rv.physics`,
 *    `rv.physics.full`), written by the settings store;
 *  - `modelZone` — the loaded model carries an authored, enabled
 *    `WebPhysicsZone` (set by the physics plugin on model load, reset on clear;
 *    the plugin's synthetic WholeScene zone never counts);
 *  - `sceneFlag` — the model's authored `SceneSettings.physicsEnabled`, or
 *    undefined when it carries none.
 */
export interface PhysicsInputs {
  deployAllowed: boolean;
  userPref: boolean;
  userFullPref: boolean;
  modelZone: boolean;
  sceneFlag?: boolean;
}

/**
 * The truth table of plan-525 §2.6 (user decision "the zone always wins"):
 * kill-switch → off; an active authored zone in the model → on; an authored
 * `SceneSettings` flag → that flag; else the Browser preference. Pure.
 */
export function computeEffectivePhysics(i: PhysicsInputs): boolean {
  if (!i.deployAllowed) return false;
  if (i.modelZone) return true;
  if (typeof i.sceneFlag === 'boolean') return i.sceneFlag;
  return i.userPref;
}

/**
 * Effective FULL physics (F17, Beta): only ever a USER choice — the Browser's
 * `rv.physics` AND `rv.physics.full` toggles under an open kill-switch. A zone
 * model switches plain physics on for itself, never full physics; an authored
 * `SceneSettings` flag always turns full physics off (the model decided). Pure.
 */
export function computeEffectiveFullPhysics(i: PhysicsInputs): boolean {
  if (!i.deployAllowed || typeof i.sceneFlag === 'boolean') return false;
  return i.userPref && i.userFullPref;
}

/** The live inputs (module singleton; boot + settings store + physics plugin write them). */
export const physicsInputs: PhysicsInputs = {
  deployAllowed: true,
  userPref: false,
  userFullPref: false,
  modelZone: false,
  sceneFlag: undefined,
};

const _physicsStateListeners = new Set<() => void>();

/** Subscribe to recomputations of the effective state (Settings panel hint, F8). */
export function subscribePhysicsState(fn: () => void): () => void {
  _physicsStateListeners.add(fn);
  return () => { _physicsStateListeners.delete(fn); };
}

/**
 * Recompute `physicsSettings` from {@link physicsInputs} — the ONE writer of the
 * effective gate (no snapshot/restore). Load-time semantics unchanged: the
 * physics plugin reads the gate when it builds the world, so a change takes
 * effect on the next model load unless the plugin recomputes on that load.
 */
export function recomputePhysics(): void {
  physicsSettings.enabled = computeEffectivePhysics(physicsInputs);
  physicsSettings.full = physicsSettings.enabled && computeEffectiveFullPhysics(physicsInputs);
  for (const fn of _physicsStateListeners) fn();
}

/** True when the loaded model switched physics on although the Browser preference is off (F8). */
export function isPhysicsEnabledByModel(): boolean {
  return physicsInputs.deployAllowed && physicsInputs.modelZone && !physicsInputs.userPref;
}
