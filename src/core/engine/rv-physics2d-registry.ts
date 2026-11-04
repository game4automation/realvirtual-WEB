// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import type { Object3D } from 'three';

/**
 * rv-physics2d-registry — the public contract of the top-view 2D interaction-zone
 * physics (plan-661, Phase 3).
 *
 * The open-source viewer carries ONLY this seam: plain data types, the provider
 * interface and a registry slot. The engine behind it (Box2D v3 in a Web Worker)
 * is commercial and lives in the private repo (`src/physics2d/`); it registers a
 * factory here. With nothing registered every query answers "no 2D physics" and
 * `WebPhysicsZone2D` zones stay kinematic.
 *
 * ## Frame and units
 *
 * A world is described in its OWN 2D frame, in metres: the belt axis is `+x`, the
 * conveyor width runs along `y`, angles are radians counter-clockwise. The caller
 * (the zone plugin) owns the transform between this frame and the 3D scene. Any
 * internal scaling (Box2D runs in decimetres, plan-656 Phase 0) never leaks out.
 *
 * ## Simulation contract (plan §2.3, binding)
 *
 * - Sim time belongs to the provider: `simTime` is the time of the LAST answer;
 *   sensors / transport / zone control read poses at that time.
 * - At most one step is in flight. `step()` only records that a fixed step is owed.
 * - Slot ids are stable for a body's life; a slot comes back from `allocSlot()`
 *   only after the provider reported it `removed`.
 * - Overload: up to `maxCatchUp` (3) owed steps run per message, the rest is
 *   skipped and counted in `diagnostics().skippedSteps`.
 * - A dead engine (WASM/worker error, watchdog) fails OFF: `onFailOff` lists every
 *   live slot so the caller can hand the MUs back to the transport — none is lost.
 */

/** A static obstacle (guide rail, stopper) as an oriented box, metres / radians. */
export interface Physics2DStaticBox {
  cx: number;
  cy: number;
  hx: number;
  hy: number;
  angle?: number;
  friction?: number;
}

/** A belt section: world-frame rectangle driving bodies along its local direction. */
export interface Physics2DBelt {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  /** Belt speed in m/s along dirX/dirY (+x by default); 0 = stopped, negative = reversed. */
  speed: number;
  /** Extra coupling damping in 1/s (buffer table, `WebPhysicsZone2D.Damping`): bodies follow
   *  the belt speed more tightly; the terminal speed stays the belt speed. Default 0. */
  damping?: number;
  /** Local unit direction; defaults to +x. */
  dirX?: number;
  dirY?: number;
  /** Rigid platform / radial belt velocity field (rad/s). */
  angularVelocity?: number;
  centerX?: number;
  centerY?: number;
}

/**
 * Jam pressure model (plan-661 Phase 4). Box2D's soft contacts yield in proportion to the
 * force, and a belt drives every body of a jam, so the line pressure grows with the jam
 * length (Spike 0b: 17-25 mm overlap at ~700 rows). The model FREEZES a body that has stood
 * still for `freezeSteps` steps into a static body: it no longer carries belt drive into the
 * jam, so only the still-moving tail presses on the plug — the pressure stays bounded by a
 * few bodies, whatever the jam length. A frozen body is released (dynamic again, driven) as
 * soon as the space ahead of it in belt direction is free, so a released jam runs off front
 * first, row by row, like a real accumulation conveyor.
 */
export interface Physics2DJamModel {
  /** Freeze standing bodies; default true. `false` = plain driven bodies (baseline). */
  freeze?: boolean;
  /** Speed in m/s below which a body counts as standing; default 0.05. */
  freezeSpeed?: number;
  /** Consecutive standing steps before a body freezes; default 6. */
  freezeSteps?: number;
  /** Free space in metres ahead of a frozen body that releases it; default 0.002. */
  releaseGap?: number;
  /** Release check every n steps; default 2. */
  releaseEvery?: number;
  /** Speed in m/s at which Box2D pushes overlapping bodies apart; default 3 (Box2D's own
   *  default of 3 length units/s would be 0.3 m/s in the decimetre world). */
  contactPushSpeed?: number;
}

/** A moving obstacle (stopper, block zone, downstream kinematic MU), world frame. */
export interface Physics2DObstacle {
  cx: number;
  cy: number;
  hx: number;
  hy: number;
  /** Velocity along x in m/s (a kinematic MU moving away carries no impact). */
  vx?: number;
}

/** Lanes whose tail positions the provider reports (kinematic infeed, plan §2.4). */
export interface Physics2DLanes {
  count: number;
  /** y of lane 0 in metres. */
  y0: number;
  /** Lane pitch in metres. */
  pitch: number;
  /** Entry strip along x in which a body counts as a lane's tail. */
  stripMinX: number;
  stripMaxX: number;
}

/** Everything needed to build one world (one contact region). */
export interface Physics2DWorldDesc {
  /** Body slots (fixed for the world's life). */
  capacity: number;
  /** Reference belt speed in m/s the damping model is tuned for. */
  vRef: number;
  /** Friction-equivalent of the belt drag (µ); default 0.25. */
  mu?: number;
  /** Box2D substeps; default 4. */
  substeps?: number;
  /** Fixed step in seconds; default 1/60. */
  dt?: number;
  statics?: Physics2DStaticBox[];
  belts?: Physics2DBelt[];
  lanes?: Physics2DLanes;
  /** A body leaving this rectangle is reported once as `exit` (no automatic removal). */
  exit?: { minX: number; minY: number; maxX: number; maxY: number };
  /** Kinematic obstacle slots, set per step with `setObstacle`; default 0. */
  obstacles?: number;
  /** Use per-body forces for changing / non-collinear belt directions. */
  localDrive?: boolean;
  kinematics?: Physics2DStaticBox[];
  jam?: Physics2DJamModel;
}

/** A dynamic body (one MU) as handed to the provider. */
export interface Physics2DBodySpec {
  x: number;
  y: number;
  angle?: number;
  vx?: number;
  vy?: number;
  /** Footprint: a circle (`radius`) or a box (`hx`/`hy`), metres. */
  radius?: number;
  hx?: number;
  hy?: number;
  /** Mass in kg; default 0.5. */
  mass?: number;
  friction?: number;
}

/** Pose of one body at `simTime`, world frame, metres / radians. */
export interface Physics2DPose {
  x: number;
  y: number;
  angle: number;
}

export type Physics2DEventKind = 'sleep' | 'wake' | 'exit' | 'removed';

export interface Physics2DEvent {
  kind: Physics2DEventKind;
  slot: number;
}

export type Physics2DState = 'idle' | 'booting' | 'running' | 'failed' | 'disposed';

export interface Physics2DDiagnostics {
  state: Physics2DState;
  /** `worker` | `inline` | `none`. */
  transport: 'worker' | 'inline' | 'none';
  /** `compat` | `deluxe` | `null` before boot. */
  flavour: string | null;
  bodies: number;
  awake: number;
  /** Bodies frozen into the static jam plug (pressure model). */
  frozen: number;
  simTime: number;
  /** Fixed steps owed by the caller in total. */
  requestedSteps: number;
  /** Steps the engine actually ran. */
  executedSteps: number;
  /** Owed steps dropped because catch-up was capped. */
  skippedSteps: number;
  /** Answers dropped because they belonged to an older epoch. */
  staleAnswers: number;
  /** Last engine step time in ms (worker side), and the round trip. */
  stepMs: number;
  roundTripMs: number;
  failReason: string | null;
}

/** The engine seam. One provider instance = one world. */
export interface Physics2DProvider {
  readonly state: Physics2DState;
  readonly capacity: number;
  /** Sim time of the last answer, seconds. */
  readonly simTime: number;
  /** Builds (or rebuilds) the world. Resolves when the engine runs, rejects on fail-off. */
  createWorld(desc: Physics2DWorldDesc): Promise<void>;
  /** Next free slot, or -1 when every slot is in use or not yet reported `removed`. */
  allocSlot(): number;
  /** Queues a body for the next step. The slot must come from `allocSlot()`. */
  addBody(slot: number, spec: Physics2DBodySpec): void;
  /** Queues removal; the slot is free again only after the `removed` event. */
  removeBody(slot: number): void;
  setBeltSpeed(belt: number, speed: number): void;
  setBelt(belt: number, section: Physics2DBelt): void;
  /** Target reached by velocity over the next simulated step, never teleported. */
  setKinematicPose(index: number, x: number, y: number, angle: number): void;
  /** Teleports a body (rare: corrections). */
  setPose(slot: number, x: number, y: number, angle: number): void;
  /** Places obstacle `index` (< `desc.obstacles`); `null` switches it off. */
  setObstacle(index: number, obstacle: Physics2DObstacle | null): void;
  /** True while the body is frozen into the jam plug. */
  isFrozen(slot: number): boolean;
  /** Records one owed fixed step; sends when nothing is in flight. */
  step(): void;
  /** Writes the last known pose of `slot`; false when the slot is not alive. */
  readPose(slot: number, out: Physics2DPose): boolean;
  isAlive(slot: number): boolean;
  isAwake(slot: number): boolean;
  /** Minimum x of bodies in a lane's entry strip, `Infinity` when free. */
  laneTail(lane: number): number;
  /** Drops the world and every body; slots free immediately (new epoch). */
  reset(): void;
  onEvent(listener: (event: Physics2DEvent) => void): () => void;
  /** Fail-off: `slots` are every body alive at the failure; `readPose` keeps their last poses. */
  onFailOff(listener: (reason: string, slots: number[]) => void): () => void;
  diagnostics(): Physics2DDiagnostics;
  dispose(): void;
}

export type Physics2DProviderFactory = () => Physics2DProvider;

class Physics2DRegistry {
  private motions = new WeakMap<Object3D, Object3D>();

  /** Behaviors identify their platform pivot; routing and drive commands remain theirs. */
  bindMotion(surfaceNode: Object3D, driveNode: Object3D): void {
    this.motions.set(surfaceNode, driveNode);
  }

  motionOf(surfaceNode: Object3D): Object3D | null {
    for (let node: Object3D | null = surfaceNode; node; node = node.parent) {
      const drive = this.motions.get(node);
      if (drive) return drive;
    }
    return null;
  }

  private _factory: Physics2DProviderFactory | null = null;

  /** Register the private engine. `null` unregisters (open-source state). */
  register(factory: Physics2DProviderFactory | null): void {
    this._factory = factory;
  }

  get available(): boolean {
    return this._factory !== null;
  }

  /** A NEW provider (one world), or `null` without an engine. */
  create(): Physics2DProvider | null {
    return this._factory ? this._factory() : null;
  }

  clear(): void {
    this.motions = new WeakMap();
    this._factory = null;
  }
}

/** Singleton 2D physics registry. */
export const physics2dRegistry = new Physics2DRegistry();

/** Answer of the 2D-zone entry seam for one MU in one transport tick. */
export type Zone2DClaim = 'pass' | 'claimed' | 'wait';

/**
 * Entry seam of the 2D interaction zones (plan-661 Phase 4, pattern `physicsMUHook`): the
 * zone plugin installs itself on `RVTransportManager.zone2dHook`; the manager asks it once
 * per tick for every kinematically moving MU, after the driving surface is picked.
 *
 * - `'claimed'` — the MU now belongs to Box2D (`owner === 'box2d'`); the transport skips it.
 * - `'wait'` — the MU stands at a zone entry whose entry position is occupied (the zone's
 *   tail): it does not move this tick, so the kinematic infeed backs up behind the zone.
 * - `'pass'` — not a zone matter; the transport moves the MU as usual.
 */
export interface IZone2DHook {
  tryClaim(mu: IZone2DCandidate, driver: unknown): Zone2DClaim;
}

/** The part of an MU the entry seam needs (both MU classes satisfy it). */
export interface IZone2DCandidate {
  readonly isInstanced: boolean;
  owner: 'transport' | 'rapier' | 'box2d';
}
