// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { Object3D, Vector3, Quaternion, Euler, MathUtils } from 'three';
import { DriveDirection, directionToGltfAxis, isRotation } from './rv-coordinate-utils';
import type { ComponentSchema, ComponentContext, RVComponent } from './rv-component-registry';
import { registerComponentSchema, registerCapabilities, loadSchemaFromSpec, setComponentInstance } from './rv-component-registry';
import { MM_TO_METERS } from './rv-constants';
import { RV_DRIVE_HOME_KEY } from './rv-pre-bake-keys';
import { parentScaleAlong } from './rv-drive-units';
import { getDriveSpeedOverride } from './rv-speed-override';
// Type-only: the contract imports this file for DEFAULT_ARRIVAL_TOLERANCE, so a
// value import here would be a runtime cycle (plan-673 Phase 4).
import type { RVDynamicAxis } from './rv-dynamic-axis';
import {
  SMOOTH_OK,
  createMotionSnapshot,
  createMotionState,
  smoothMotionRegistry,
  smoothStatusText,
  warnSmoothMotionDegraded,
  type MotionSnapshot,
  type MotionState,
  type MotionStatus,
  type SmoothMotionProvider,
} from './rv-smooth-motion-port';

// Re-export for backward compatibility
export { DriveDirection } from './rv-coordinate-utils';

/**
 * IDriveBehavior - mirrors Unity's IDriveBehavior interface.
 * Behaviors are owned by the drive and called before drive physics,
 * exactly like Unity's Drive.CalcFixedUpdate() calls its DriveBehaviours.
 */
export interface IDriveBehavior {
  /** Called every fixed timestep, before drive physics. Sets targetPosition/targetSpeed/startMove. */
  update(dt: number): void;

  /**
   * OPTIONAL — contribute the axis SETPOINT while an external authority owns the
   * POSITION (plan-673 Phase 5).
   *
   * `update()` is called from the normal branch of `updateMotion()`, which a
   * drive under `positionOverwrite` never reaches: the overwrite branch returns
   * before the behavior loop, by design, because the position is somebody
   * else's answer. For a KINEMATIC overwrite (recording playback, a multiuser
   * follower) that is exactly right and must not change.
   *
   * For a DYNAMIC axis it leaves a hole. A gripper jaw in the realvirtual idiom
   * is a `Drive_Gear` off a `Drive{Direction:'Virtual'}` master that a
   * `Drive_Cylinder` moves; once the jaw is physics-driven, the gear is the only
   * thing that knows where the jaw should BE, and it is the one thing that no
   * longer runs. Phase 4b's MJCF therefore had the actuated lead jaw and the
   * equality row, and nothing commanding either.
   *
   * This method is that one route, and it is the ONLY thing a behavior may do
   * inside the overwrite branch: write the SETPOINT (`commandPosition()` /
   * `commandAxisPosition()`). It must NOT write `currentPosition`,
   * `targetPosition`, `isRunning` or call `applyToNode()` — a behavior that
   * wrote the position would be the "last writer in the tick wins" race the
   * axis contract exists to prevent.
   *
   * Called only when {@link RVDrive.dynamicAxis} is set, so a behavior that
   * implements it stays inert in every non-physics scene — which is precisely
   * where the obvious shortcut (routing `Drive_Gear.update()` through the
   * setpoint) killed the kinematic gripper.
   */
  commandDynamicSetpoint?(dt: number): void;
}

// Reusable temp objects to avoid GC
const _euler = new Euler();
const _deltaQuat = new Quaternion();
const _axisScaled = new Vector3();
/** Scratch for the motion direction in the PARENT frame (unit conversion). */
const _unitDir = new Vector3();

/**
 * The Drive's transform formula as a pure function (plan-641 M6) — extracted
 * from `RVDrive.applyToNode` so a pose can be computed WITHOUT touching any
 * drive state (the pose adapter of `web_check_*`, `rv-pose-adapter.ts`).
 *
 * Rotary: `outQuaternion = baseQuaternion · Euler(axis · positionDeg, 'XYZ')`;
 * `outPosition` untouched. Linear: `outPosition = basePosition +
 * (baseQuaternion ⊗ axis) · localOffset`; `outQuaternion` untouched.
 * `localOffset` is the node-local length of the linear position (mm → parent
 * units, see `RVDrive.positionToLocalOffset`); `positionDeg` the angle in
 * degrees. Both already include the drive's `Offset`.
 */
export function writeDriveLocalTransform(
  isRotary: boolean,
  axis: Vector3,
  basePosition: Vector3,
  baseQuaternion: Quaternion,
  positionDeg: number,
  localOffset: number,
  outPosition: Vector3,
  outQuaternion: Quaternion,
): void {
  if (isRotary) {
    // Rotation: localRotation = baseQuat * Quaternion.Euler(axis * angle)
    // Unity uses degrees, Three.js Euler uses radians
    const rad = MathUtils.degToRad(positionDeg);
    _axisScaled.copy(axis).multiplyScalar(rad);
    _euler.set(_axisScaled.x, _axisScaled.y, _axisScaled.z, 'XYZ');
    _deltaQuat.setFromEuler(_euler);
    outQuaternion.copy(baseQuaternion).multiply(_deltaQuat);
  } else {
    // Linear: move along the object's OWN local axis (Space.Self / Unity
    // "local axis of the game object") — rotate the axis by the node's home
    // orientation so a locally-rotated drive travels along its own X/Y/Z, not
    // the parent's. (baseQuaternion is identity for the common un-rotated
    // node, so this is a no-op there.)
    //   localPosition = basePos + (baseQuat ⊗ axis) * (pos / controllerScale)
    // pos is in mm, converted to meters by dividing by controllerScale — and
    // then into the PARENT's units, which are metres only while the frame is
    // unscaled (a CAD subtree is in millimetres; see rv-drive-units).
    outPosition.copy(basePosition);
    _axisScaled.copy(axis).multiplyScalar(localOffset).applyQuaternion(baseQuaternion);
    outPosition.add(_axisScaled);
  }
}

/**
 * RVDrive - TypeScript port of realvirtual Drive.cs transform logic.
 *
 * Stores the base (rest) transform from the GLB and applies drive position
 * changes as local transform deltas, exactly matching Unity's SetPosition().
 *
 * Controller scale is hardcoded to 1000 (mm->m) for the PoC.
 * In the GLB, positions are already in meters, so we divide by 1000.
 */
/**
 * The Drive's speed ramp as a pure function (extracted from `RVDrive.update`
 * so path-based movers — plan-268 `Agv` — reuse the EXACT drive ramp instead
 * of re-inventing it).
 *
 * @param currentSpeed      live speed (mm/s or deg/s)
 * @param speedLimit        commanded speed limit (TargetSpeed · override; 0 = stop)
 * @param acceleration      accel/decel in units/s²
 * @param useAcceleration   false → jump straight to `speedLimit` (no ramp)
 * @param remainingDistance distance left to the stop target (same unit as speed·s);
 *                          pass ±Infinity when there is no positional stop target
 * @param dt                tick delta in seconds
 * @returns the new speed for this tick
 */
export function computeRampedSpeed(
  currentSpeed: number,
  speedLimit: number,
  acceleration: number,
  useAcceleration: boolean,
  remainingDistance: number,
  dt: number,
): number {
  if (useAcceleration && acceleration > 0) {
    const stoppingDist = (currentSpeed * currentSpeed) / (2 * acceleration);
    if (stoppingDist >= Math.abs(remainingDistance)) {
      // Decelerate toward the stop target
      return Math.max(0, currentSpeed - acceleration * dt);
    }
    if (currentSpeed < speedLimit) {
      // Accelerate
      return Math.min(speedLimit, currentSpeed + acceleration * dt);
    }
    if (currentSpeed > speedLimit) {
      // TargetSpeed was lowered mid-motion — ramp down toward the new limit
      // instead of holding the old (higher) speed until the braking point.
      return Math.max(speedLimit, currentSpeed - acceleration * dt);
    }
    return currentSpeed;
  }
  return speedLimit;
}

/**
 * Sentinel distance for a held jog under the smooth (jerk-limited) core.
 *
 * The core plans point-to-point profiles; an unbounded jog is expressed as a
 * target so far away that the drive cruises at its limit speed, and the host
 * re-arms it before the profile would start braking. This is the SAME ±1e6
 * re-arm policy Unity's `Drive.cs` uses, kept as a HOST rule on purpose
 * (plan-281 E4/F5) — making jog a first-class core command is an explicit ABI-v2
 * follow-up, not part of this port.
 */
const SMOOTH_JOG_SENTINEL = 1e6;

/**
 * True when something OUTSIDE the viewer owns this drive's position — the number
 * on the axis is a measurement now, not a command, and any internal controller
 * writing a set-point to it must stand down.
 *
 * Three ways that happens, and they mean the same thing to a caller:
 *
 *  - `positionOverwrite`: a recording, a multiuser follower, an axis handed to
 *    another owner;
 *  - `liveControlled`: live signal bindings own the drive's command slots;
 *  - a drive behavior with a BOUND position slot — a `Drive_FollowPosition`
 *    wired to the real drive's position, which is exactly the state a
 *    commissioned machine arrives in.
 *
 * The behavior list is tested structurally, so a component that follows an
 * external position under another name is picked up without a registry of types
 * here. (`Array.isArray` because the ribbon fixtures register stand-in drives
 * that implement only the members a roller reads.)
 */
export function isDriveExternallyCommanded(drive: {
  positionOverwrite?: boolean;
  liveControlled?: boolean;
  driveBehaviors?: unknown;
}): boolean {
  if (drive.positionOverwrite || drive.liveControlled) return true;
  const behaviors = drive.driveBehaviors;
  if (!Array.isArray(behaviors)) return false;
  for (const behavior of behaviors) {
    const slot = (behavior as { Position?: unknown } | null)?.Position;
    if (typeof slot === 'string' && slot.length > 0) return true;
  }
  return false;
}

/**
 * Arrival tolerance of a kinematic axis in drive units (mm / deg) — the value
 * `isAtTarget` has always compared against. A dynamic axis replaces it; see
 * {@link RVDrive.arrivalTolerance}.
 */
export const DEFAULT_ARRIVAL_TOLERANCE = 0.01;

/** Move a signed scalar toward a target without overshooting. */
function moveTowards(current: number, target: number, maxDelta: number): number {
  if (current < target) return Math.min(target, current + maxDelta);
  if (current > target) return Math.max(target, current - maxDelta);
  return target;
}

export class RVDrive implements RVComponent {
  // Loaded from the rv-ODT specification (schema/v1/rv-odt.json, plan-187).
  // DriveDirection is a string enum, so the spec's identity enumMap yields the
  // same runtime values as the previous inline definition.
  static readonly schema: ComponentSchema = loadSchemaFromSpec('Drive');

  readonly node: Object3D;
  readonly name: string;
  isOwner = true;
  /** True while live signal bindings own this drive's command slots. */
  liveControlled = false;

  // Properties — exact C# Inspector field names
  Direction: DriveDirection = DriveDirection.LinearX;
  ReverseDirection = false;
  Offset = 0;
  StartPosition = 0;
  TargetSpeed = 100;
  Acceleration = 100;
  UseAcceleration = false;
  UseLimits = false;
  LowerLimit = -180;
  UpperLimit = 180;
  /** Authored continuous forward jog (Unity Drive inspector `JogForward`). Seeds
   *  the runtime `jogForward` on init/reset so the drive spins at TargetSpeed. */
  JogForward = false;
  /** Authored continuous backward jog (Unity Drive inspector `JogBackward`). */
  JogBackward = false;
  /**
   * Use the jerk-limited S-curve instead of the trapezoidal ramp. Only has an
   * effect together with {@link UseAcceleration} (Unity shows it as a sub-toggle
   * of it) AND a registered smooth-motion provider — without one the drive keeps
   * the trapezoidal ramp and the viewer warns once per model (plan-281 G0).
   */
  SmoothAcceleration = false;
  /** Jerk in mm/s³ (deg/s³ for rotary drives). Only used when smooth. */
  Jerk = 1000;
  /**
   * Per-drive speed override factor, multiplied with the global one (F7). It
   * scales PROFILE TIME, not the limits, so pausing (0) and resuming never make
   * position or profile time jump.
   */
  SpeedOverride = 1;
  /**
   * Wrap instead of clamp at the limits: passing `UpperLimit` continues at
   * `LowerLimit` and vice versa (endless rotary axes). Under the smooth core the
   * whole profile is shifted with the state so the motion stays continuous
   * across the seam (plan-281 §2.7).
   */
  JumpToLowerLimitOnUpperLimit = false;

  /** DriveBehaviour component type names found on this node (e.g. "Drive_ErraticPosition") */
  Behaviors: string[] = [];
  /** Raw extras data for each DriveBehaviour, keyed by behavior name */
  BehaviorExtras: Record<string, Record<string, unknown>> = {};

  /** Derived from Direction */
  isRotary = false;

  // Base transform (rest position from GLB)
  private basePosition = new Vector3();
  private baseQuaternion = new Quaternion();

  // Drive state
  currentPosition = 0;
  currentSpeed = 0;
  targetPosition = 0;
  targetSpeed = 0;
  isRunning = false;
  /** Direction of the last positioning / smooth / overwrite move (+1 or -1).
   *  `currentSpeed` stays a magnitude there (plan-281 Phase 4); the jog path
   *  carries its sign in `currentSpeed` itself and resets this to +1. */
  private _moveSign = 1;

  /** Signed speed in mm/s, negative while moving toward lower positions —
   *  Unity `Drive.CurrentSpeed` semantics. Read by TransportSurface so a belt
   *  driven backward with DriveTo transports backward. */
  get signedSpeed(): number {
    return this.currentSpeed * this._moveSign;
  }

  /** Continuous forward motion at targetSpeed. Seeded from the authored
   *  `JogForward` at init/reset; also set live by Drive_Simple signals / jog UI. */
  jogForward = false;
  /** Continuous backward motion at targetSpeed. Seeded from the authored
   *  `JogBackward` at init/reset; also set live by Drive_Simple signals / jog UI. */
  jogBackward = false;
  /** True if this drive is used by a TransportSurface (set by TransportSurface.init). */
  private _isTransportSurface = false;

  get isTransportSurface(): boolean {
    return this._isTransportSurface;
  }

  set isTransportSurface(value: boolean) {
    if (this._isTransportSurface === value) return;

    this._isTransportSurface = value;

    if (value) {
      // TransportSurface discovers its Drive after Drive.initDrive() has already
      // applied StartPosition. Unity discovers the surface before its first
      // SetPosition(), so restore the authored frame transform here for parity.
      this.node.position.copy(this.basePosition);
      this.node.quaternion.copy(this.baseQuaternion);
      this.node.updateMatrix();
    } else {
      this.applyToNode();
    }
  }

  /** When true, update() skips physics and only applies transform (for DrivesPlayback) */
  positionOverwrite = false;
  /**
   * Set by a drive behavior during THIS tick's behavior pass to say it has just
   * written `currentPosition` from an external command, so the drive's own jog
   * and positioning must stay out of the way until the next tick.
   *
   * Cleared at the top of every behavior pass, so it cannot latch: a command
   * signal that goes away hands the axis back on the very next tick.
   */
  positionClaimedThisTick = false;
  /** Previous position for computing speed in overwrite mode */
  private _prevOverwritePos = 0;

  // ── Dynamic axis contract (plan-673 Phase 4) ──────────────────────────────
  //
  // A kinematic drive's position IS its setpoint: it integrates toward
  // `targetPosition` and arrives, so the following error is structurally zero
  // and the quantity does not exist. A DYNAMIC axis (a `DynamicAxis` component
  // next to this drive, its setpoint on a force-limited actuator) has a real
  // one, and on a machine that error is the overload signal.
  //
  // The four fields below are written by whoever owns the axis physically — the
  // MuJoCo adapter through {@link reportDynamicSample} — and read by the HMI,
  // the charts, the recording, MCP and the feedback signals. On a kinematic
  // drive they stay at their initial values and cost nothing.

  /**
   * Last setpoint written through {@link commandPosition} in drive units
   * (mm / deg), `NaN` while nothing has ever commanded the axis.
   *
   * Deliberately NOT `targetPosition`: `targetPosition` is the end of the
   * drive's own motion profile and `isAtTarget` compares against it, while the
   * commanded position is what an external controller asked for — on a dynamic
   * axis the two differ by the following error, which is the whole point.
   */
  commandedPosition = Number.NaN;
  /**
   * `commandedPosition - currentPosition` in drive units (mm / deg) — the RAW
   * following error of a dynamic axis, base share included.
   *
   * The overload model subtracts `DynamicAxis.BaseFollowingError` from this;
   * see `rv-axis-diagnostics.ts`. 0 on a kinematic axis.
   */
  followingError = 0;
  /** Actuator force / torque of a dynamic axis (N / Nm); 0 on a kinematic one. */
  actualTorque = 0;
  /** True while a dynamic axis sits at its actuator force limit. */
  saturated = false;
  /**
   * Arrival tolerance of {@link isAtTarget} in drive units. The kinematic
   * default is 0.01; a dynamic axis widens it (`DynamicAxis.ArrivalTolerance`,
   * or base + window), because a P+D servo never reaches its setpoint exactly
   * and a LogicStep waiting for 0.01 would wait forever.
   */
  arrivalTolerance = DEFAULT_ARRIVAL_TOLERANCE;
  /**
   * The `DynamicAxis` that declares this drive dynamic, or null — set by
   * `bindDynamicAxis()` in `rv-axis-contract.ts`.
   *
   * A field rather than a lookup in that module, because the drive has to read
   * its own role (the setpoint ramp below) and must not import the contract at
   * runtime: the contract imports this file for {@link DEFAULT_ARRIVAL_TOLERANCE}.
   * Typed through a type-only import, so nothing is pulled in at runtime.
   */
  dynamicAxis: RVDynamicAxis | null = null;

  // ── Motion contract (plan-554 F3c) — read-only for consumers ──────────────
  /**
   * Signed distance (mm) / angle (deg) the drive actually TRAVELLED in its last `update()`,
   * before any wrap at the limits (an endless axis that crosses `UpperLimit` reports the real
   * step, not the jump back to `LowerLimit`). Counts: the motion integration (positioning, jog,
   * smooth core), a coupled behavior that moves the axis without claiming it (`Drive_Gear`) and
   * positions streamed in overwrite mode (playback, IK path). Not counted: a discontinuity.
   */
  stepTravel = 0;
  /** Running sum of {@link stepTravel} — unwrapped, so several turns stay representable. */
  travelOdometer = 0;
  /**
   * Incremented whenever `currentPosition` is set from OUTSIDE the motion integration: a direct
   * write between two updates (DES, a cylinder homing, Erratic), a behavior that claims the axis
   * with a forced position (`Drive_FollowPosition`), `reset()`, `applySyncData()` and
   * `setPreviewPosition()`. The cinematic motion blur holds a node whose drive changed this
   * counter during a frame instead of smearing it across the jump.
   */
  discontinuityRev = 0;
  /** `currentPosition` at the end of the last update (detects writes between updates). */
  private _motionLastPos = 0;
  /** Position shift the smooth core's wrap applied during this update (added back to the travel). */
  private _stepWrap = 0;

  /** Marks an external (non-integrated) position change — see {@link discontinuityRev}. */
  private markDiscontinuity(): void {
    this.discontinuityRev++;
    this._motionLastPos = this.currentPosition;
  }
  /** Previous tick had an active jog command (Unity `_lastjog` parity). */
  private _wasJogging = false;
  /** Jog command was released and the drive is decelerating to zero. */
  private _stoppingJog = false;

  // ── Smooth (jerk-limited) motion — plan-281 Phase 4 ──────────────────────
  // All of this is inert unless `UseAcceleration && SmoothAcceleration` AND a
  // provider is registered. `computeRampedSpeed` stays the deliberately separate
  // non-smooth path and is never grown into a second S-curve (plan-281 §5.3).

  /** Core context handle; 0 = none. Created lazily, destroyed in dispose(). */
  private _smoothHandle = 0;
  /** The ONE snapshot object this drive ever uses (no allocation per tick). */
  private readonly _smoothSnapshot: MotionSnapshot = createMotionSnapshot();
  /** Scratch for state pushes (setState/rebase). Reused, never allocated per tick. */
  private readonly _smoothState: MotionState = createMotionState();
  /** A profile is currently planned and being played back. */
  private _smoothPlanned = false;
  /** Requested target of the active PTP plan (NaN while jogging). */
  private _smoothPlanTarget = Number.NaN;
  /** Effective (reachable) end of the active plan — the target at-target uses (F4). */
  private _smoothEffectiveTarget = Number.NaN;
  /** Limits must be pushed to the core before the next replan. */
  private _smoothLimitsDirty = true;
  /** Currently armed jog direction under the smooth core (-1 / 0 / +1). */
  private _smoothJogDir = 0;
  /** An external position change happened; re-seed the core before the next step. */
  private _smoothRebasePending = false;
  /** Direction currently blocked by a hard limit, so the jog does not re-arm into it. */
  private _smoothJogBlocked = 0;
  /** The core rejected this drive's parameters — stop retrying every tick. */
  private _smoothRejected = false;

  /** Drive behaviors called before physics, mirroring Unity's IDriveBehavior pattern */
  readonly driveBehaviors: IDriveBehavior[] = [];

  /** After-update callback list shared by the single active drive behavior and
   *  direct-feedback bindings. Invoked after each update tick at all three
   *  callsites (positionOverwrite, stop-at-target, normal update). Register via
   *  {@link addAfterUpdate}; remove via {@link removeAfterUpdate}. */
  private readonly afterUpdateCallbacks: ((drive: RVDrive) => void)[] = [];
  private behaviorChangedThisTick = false;

  /**
   * True when a drive behavior claimed the axis this tick ({@link positionClaimedThisTick})
   * AND actually changed the drive state ({@link markBehaviorChanged}) — i.e. the
   * geometry moved without `isRunning`. A claimed but resting axis reports false,
   * so it does not keep the on-demand renderer awake.
   */
  get claimedMoveThisTick(): boolean {
    return this.positionClaimedThisTick && this.behaviorChangedThisTick;
  }

  /** Mark that a behavior changed drive state without arming drive physics. */
  markBehaviorChanged(): void {
    this.behaviorChangedThisTick = true;
  }

  /** Register an after-update feedback callback (idempotent — no duplicate adds). */
  addAfterUpdate(cb: (drive: RVDrive) => void): void {
    if (!this.afterUpdateCallbacks.includes(cb)) this.afterUpdateCallbacks.push(cb);
  }

  /** Remove a previously registered after-update callback (dispose / leak-guard). */
  removeAfterUpdate(cb: (drive: RVDrive) => void): void {
    const i = this.afterUpdateCallbacks.indexOf(cb);
    if (i >= 0) this.afterUpdateCallbacks.splice(i, 1);
  }

  /** Dispatch all after-update callbacks. No allocation in the hot path. */
  private dispatchAfterUpdate(): void {
    for (let i = 0; i < this.afterUpdateCallbacks.length; i++) {
      this.afterUpdateCallbacks[i](this);
    }
  }

  /**
   * @deprecated Use {@link addAfterUpdate} / {@link removeAfterUpdate}. Kept as a
   * single-slot compatibility shim: the setter appends to the callback list (it
   * does NOT clear prior callbacks), the getter returns the last registered one.
   * External callers that did `drive.onAfterUpdate = fn` keep working but no
   * longer clobber a sibling behavior's feedback writes.
   */
  get onAfterUpdate(): ((drive: RVDrive) => void) | null {
    return this.afterUpdateCallbacks.length > 0
      ? this.afterUpdateCallbacks[this.afterUpdateCallbacks.length - 1]
      : null;
  }
  set onAfterUpdate(cb: ((drive: RVDrive) => void) | null) {
    if (cb) this.addAfterUpdate(cb);
  }

  // Direction axis (in local space)
  private axis = new Vector3();
  private controllerScale = MM_TO_METERS; // mm -> m

  constructor(node: Object3D) {
    this.node = node;
    this.name = node.name;
    setComponentInstance(node, this);
  }

  captureOverwriteState(): { enabled: boolean; previousPosition: number } {
    return { enabled: this.positionOverwrite, previousPosition: this._prevOverwritePos };
  }

  restoreOverwriteState(state: { enabled: boolean; previousPosition: number }): void {
    this.positionOverwrite = state.enabled;
    this._prevOverwritePos = state.previousPosition;
  }

  /** Home (authored) local position captured at `initDrive` — the node's pose
   *  before any motion. Writes into `out` (or a new Vector3) and returns it. */
  getHomeLocalPosition(out: Vector3 = new Vector3()): Vector3 {
    return out.copy(this.basePosition);
  }

  /** Home (authored) local orientation captured at `initDrive`. Writes into
   *  `out` (or a new Quaternion) and returns it. */
  getHomeLocalQuaternion(out: Quaternion = new Quaternion()): Quaternion {
    return out.copy(this.baseQuaternion);
  }

  /** Direction axis of the drive in the node's LOCAL frame (glTF space),
   *  ReverseDirection already applied — a unit vector, derived at
   *  `initDrive`/`reapplyConfig`. For `Direction === Virtual` this is the
   *  zero vector `(0,0,0)` — callers must guard (e.g. `lengthSq() < 1e-6`).
   *  Writes into `out` (or a new Vector3) and returns it — never the internal
   *  mutable reference. */
  getAxis(out: Vector3 = new Vector3()): Vector3 {
    return out.copy(this.axis);
  }

  /** Converts a LINEAR drive position/distance (mm) into the node-local
   *  offset applied along the axis — mirrors `applyToNode`'s conversion,
   *  including the parent-frame scale correction (see rv-drive-units). */
  positionToLocalOffset(pos: number): number {
    return (pos / this.controllerScale) / this.localUnitScale();
  }

  /** Scene units per node-local unit along the drive's motion direction — 1 in
   *  an unscaled frame, so this whole correction is a no-op there. Recomputed
   *  per call rather than cached: the frame changes on every kinematic attach
   *  and every editor reparent, and the cost is a 3×3 transform. */
  private localUnitScale(): number {
    _unitDir.copy(this.axis).applyQuaternion(this.baseQuaternion);
    return parentScaleAlong(this.node, _unitDir);
  }

  /** Drive-gizmo drag preview: set the live position (the drag driver moves the
   *  node itself, so this only keeps `currentPosition` — read by the gizmo dot /
   *  limit ticks — in sync). IMPLEMENTS DriveGizmoSource::setPreviewPosition */
  setPreviewPosition(pos: number): void {
    this.currentPosition = pos;
    this.markDiscontinuity();
  }

  //! IMPLEMENTS DriveGizmoSource::setPreviewHome
  // No-op: baseQuaternion (home) is captured at initDrive and stays stable
  // through a preview, so the ring frame never drifts for a live drive.
  setPreviewHome(): void { /* home is already stable */ }

  //! IMPLEMENTS DriveGizmoSource::endPreview
  // No-op: the drag driver restores currentPosition via setPreviewPosition.
  endPreview(): void { /* nothing to clear */ }

  init(_context: ComponentContext): void {
    // Drive behavior wiring is handled by the loader (Drive_Simple, Drive_Cylinder, etc.)
  }

  /**
   * Initialize drive internals after properties are set.
   * Called by the loader after applySchema (or by tests after setting properties manually).
   */
  initDrive(): void {
    this.isRotary = isRotation(this.Direction);

    // Store base transform. plan-754 D18: on the destructive pipeline the
    // `Drive` pre-bake hook stamped the AUTHORED home pose into `userData`
    // before anything could move the node (the kinematic re-parent rewrites the
    // local TRS of an axis it attaches). Prefer it; every other load path has no
    // such stamp and reads the live transform exactly as before.
    const home = this.node.userData?.[RV_DRIVE_HOME_KEY] as
      { p?: number[]; q?: number[] } | undefined;
    if (home && Array.isArray(home.p) && Array.isArray(home.q)) {
      this.basePosition.set(home.p[0], home.p[1], home.p[2]);
      this.baseQuaternion.set(home.q[0], home.q[1], home.q[2], home.q[3]);
    } else {
      this.basePosition.copy(this.node.position);
      this.baseQuaternion.copy(this.node.quaternion);
    }

    // Compute axis
    const rawAxis = directionToGltfAxis(this.Direction);
    this.axis.copy(rawAxis);
    if (this.ReverseDirection) {
      this.axis.negate();
    }

    // Set initial position (matches Unity Drive.Start(): CurrentPosition = StartPosition)
    this.currentPosition = this.StartPosition;
    this._motionLastPos = this.currentPosition;
    this.targetSpeed = this.TargetSpeed;

    // Seed the runtime jog flags from the authored inspector values so drives
    // configured to jog continuously (e.g. spinning rolls) run from load.
    this.jogForward = this.JogForward;
    this.jogBackward = this.JogBackward;

    // Authored limits reach the smooth core on its first use, not before: the
    // context is created lazily so a non-smooth model never touches the provider.
    this._smoothLimitsDirty = true;
    this._smoothRejected = false;
    this._smoothEffectiveTarget = Number.NaN;

    // Apply initial transform so StartPosition + Offset take effect immediately
    // (In Unity this happens on first FixedUpdate after Start())
    this.applyToNode();
  }

  /**
   * Check if drive has reached its target position.
   *
   * Under the smooth core this compares against the EFFECTIVE target, never the
   * requested one (plan-281 F4): when a redirect comes in too late to stop at
   * the requested position, the core resolves the profile to the earliest
   * physically reachable stop instead of teleporting. Reporting "not at target"
   * forever at a point the drive can never leave would strand every waiting
   * logic step. Non-smooth drives keep the requested target — nothing there can
   * produce a different endpoint.
   *
   * plan-673 Phase 4: the tolerance is {@link arrivalTolerance} instead of a
   * hard-coded 0.01. A dynamic axis never reaches its setpoint exactly — the
   * P+D servo keeps the declared base sag — so a LogicStep or an IK path
   * polling for 0.01 would wait forever. That is listed in 2.4 as the most
   * common practical stumbling block of the dynamic mode.
   */
  get isAtTarget(): boolean {
    const target = Number.isFinite(this._smoothEffectiveTarget)
      ? this._smoothEffectiveTarget
      : this.targetPosition;
    return Math.abs(this.currentPosition - target) < this.arrivalTolerance;
  }

  /**
   * Write the axis SETPOINT (drive units, mm / deg) — the cascade of the
   * plan-673 axis contract, rule 2.
   *
   * On a dynamic axis this is what the planner, the PLC, the operator jog or a
   * policy writes: the number lands on the actuator and the physics decides
   * whether the axis gets there. The drive's own motion integration is already
   * out of the way (`positionOverwrite`), so the position is NOT touched here —
   * writing it would be exactly the "last writer in the tick wins" race 2.4
   * describes.
   *
   * On a kinematic or planned axis it degenerates to the write the callers did
   * before (`currentPosition = targetPosition = value`), so one call site
   * serves all three roles. Prefer {@link commandAxisPosition} in
   * `rv-axis-contract.ts`, which picks the branch from the axis role; this
   * method is the dynamic half and never integrates.
   */
  commandPosition(value: number): void {
    this.commandedPosition = value;
    this.followingError = value - this.currentPosition;
  }

  /**
   * Feedback of one physics step of a dynamic axis: the measured joint
   * position, the actuator force and whether that force is at its limit.
   *
   * Called by the authority that owns the axis (the MuJoCo dynamic-drive
   * adapter) BEFORE the drive loop of the same tick, in place of writing
   * `currentPosition` directly — so the following error is computed against the
   * setpoint that produced this very step and the three diagnostic quantities
   * can never drift apart.
   */
  reportDynamicSample(actual: number, torque: number, saturated: boolean): void {
    this.currentPosition = actual;
    this.actualTorque = torque;
    this.saturated = saturated;
    this.followingError = Number.isFinite(this.commandedPosition)
      ? this.commandedPosition - actual
      : 0;
  }

  /**
   * plan-673 Phase 4 — one step of the setpoint ramp of a DYNAMIC axis that was
   * commanded through the ordinary `startMove()`.
   *
   * Why this exists: with `positionOverwrite` set, `updateMotion()` returns at
   * the overwrite branch BEFORE the motion integration, so a `startMove()` from
   * a `LogicStep_DriveTo`, a behavior or the jog UI arms a profile that never
   * runs — the axis simply never moves, with no error anywhere. Routing the
   * command through the setpoint instead keeps every one of those callers
   * working: they move the axis by asking the actuator, which is what a real
   * drive does.
   *
   * Velocity-limited only, exactly like the IK path's PTP ramp: shaping the
   * acceleration of a command whose execution is governed by `forcerange` would
   * be a second profile over a physical one. `isRunning` is cleared when the
   * COMMAND arrives, so `isAtTarget` (with the axis's widened tolerance) decides
   * when the AXIS has.
   */
  private stepDynamicSetpoint(dt: number): void {
    if (!this.dynamicAxis || !this.isRunning || dt <= 0) return;
    const dest = this.targetPosition;
    const from = Number.isFinite(this.commandedPosition) ? this.commandedPosition : this.currentPosition;
    if (from === dest) {
      this.commandPosition(dest);
      this.isRunning = false;
      return;
    }
    const step = Math.max(this.targetSpeed, 0) * dt * Math.max(getDriveSpeedOverride(), 0);
    const next = from < dest ? Math.min(dest, from + step) : Math.max(dest, from - step);
    this.commandPosition(next);
    if (next === dest) this.isRunning = false;
  }

  /** Authoritative current runtime values for UI display (live source of truth).
   *  Keys match the PascalCase display/schema names so the value resolver can
   *  merge this directly over static config. */
  getLiveState(): Record<string, unknown> {
    return {
      CurrentPosition: this.currentPosition,
      CurrentSpeed: this.currentSpeed,
      IsRunning: this.isRunning,
      IsAtTarget: this.isAtTarget,
      TargetPosition: this.targetPosition,
      TargetSpeed: this.targetSpeed,
      MotionBlocked: this.motionBlocked,
      JogForward: this.jogForward,
      JogBackward: this.jogBackward,
      // plan-673 Phase 4 — the three quantities a kinematic axis cannot show.
      // Always present so a chart or a readout does not have to know the role;
      // on a kinematic drive they are 0 / false by construction.
      FollowingError: this.followingError,
      ActualTorque: this.actualTorque,
      Saturated: this.saturated,
    };
  }

  /** Apply an inspector edit to the live runtime state. `TargetSpeed` has a
   *  config↔runtime split (config `TargetSpeed` is copied to runtime
   *  `targetSpeed` at initDrive), so editing it must update both for the change
   *  to take effect on motion and display immediately. Other fields fall back
   *  to the caller's generic same-named assignment. */
  setLiveField(fieldName: string, value: unknown): boolean {
    if (fieldName === 'TargetSpeed') {
      const n = Number(value);
      this.TargetSpeed = n;
      this.targetSpeed = n;
      this._smoothLimitsDirty = true;
      this._smoothRejected = false;
      return true;
    }
    if (fieldName === 'Acceleration' || fieldName === 'Jerk') {
      (this as unknown as Record<string, number>)[fieldName] = Number(value);
      this._smoothLimitsDirty = true;
      this._smoothRejected = false;
      return true;
    }
    if (fieldName === 'JogForward') {
      const b = Boolean(value);
      this.JogForward = b;
      this.jogForward = b;
      return true;
    }
    if (fieldName === 'JogBackward') {
      const b = Boolean(value);
      this.JogBackward = b;
      this.jogBackward = b;
      return true;
    }
    // Reported by getLiveState() under its PascalCase name but backed only by the runtime field:
    // without this the generic fallback would assign a dead `TargetPosition` property and the edit
    // would silently do nothing.
    if (fieldName === 'TargetPosition') {
      this.targetPosition = Number(value);
      return true;
    }
    return false;
  }

  /** Check if drive is completely idle (no motion, no jog, no overwrite, no behaviors). */
  get isIdle(): boolean {
    return !this.isRunning && !this.jogForward && !this.jogBackward
      && !this._wasJogging && !this._stoppingJog
      && !this.positionOverwrite && this.driveBehaviors.length === 0;
  }

  /** Start moving to targetPosition (no argument) or to a specific destination */
  startMove(destination?: number) {
    if (destination !== undefined) {
      this.targetPosition = destination;
    }
    this.isRunning = true;
    // A new command invalidates the previous plan's reachable endpoint; the
    // next smooth tick republishes it. Without this, `isAtTarget` would keep
    // answering against the endpoint of the command that just got superseded.
    this._smoothEffectiveTarget = Number.NaN;
    this._smoothPlanned = false;
  }

  private readonly _motionBlocks = new Set<object>();

  /** True while a simulation interlock prevents this axis from moving. */
  get motionBlocked(): boolean { return this._motionBlocks.size > 0; }

  /** Hold this axis for an interlock owner; releasing it does not issue a start command. */
  setMotionBlocked(owner: object, blocked: boolean): void {
    if (blocked) {
      if (this._motionBlocks.has(owner)) return;
      this._motionBlocks.add(owner);
      this.stop();
    } else {
      this._motionBlocks.delete(owner);
    }
  }

  stop() {
    this.isRunning = false;
    this.currentSpeed = 0;
    this.jogForward = false;
    this.jogBackward = false;
    this._wasJogging = false;
    this._stoppingJog = false;
    // Host-side discontinuity: park the core at the position we just froze at,
    // otherwise its profile would keep running internally (plan-281 §5.2 Stop/Reset).
    this.rebaseSmooth(this.currentPosition, 0);
  }

  /**
   * Release the smooth-motion core context.
   *
   * MUST be called when the drive leaves the scene — `RVViewer.clearModel()`
   * (model switch) and `RVViewer.removeDrive()` (editor delete). Nothing else
   * frees the context: it lives in the WASM linear memory, so a dropped
   * JavaScript reference leaks it for the lifetime of the page (plan-281 F12 /
   * Finding #3). Idempotent.
   */
  dispose(): void {
    if (this._smoothHandle !== 0) {
      smoothMotionRegistry.provider?.destroy(this._smoothHandle);
      this._smoothHandle = 0;
    }
    this._smoothPlanned = false;
    this._smoothJogDir = 0;
    this._smoothEffectiveTarget = Number.NaN;
  }

  /**
   * Update drive physics - called every fixed timestep. Also maintains the read-only motion
   * contract (plan-554 F3c): {@link stepTravel}, {@link travelOdometer}, {@link discontinuityRev}.
   */
  update(dt: number) {
    const start = this.currentPosition;
    this.stepTravel = 0;
    this._stepWrap = 0;
    // A write between two updates: streamed (overwrite mode) = motion, anything else = a jump.
    const external = start - this._motionLastPos;
    if (external !== 0) {
      if (this.positionOverwrite) this.stepTravel += external;
      else this.discontinuityRev++;
    }
    this.updateMotion(dt);
    // `_stepWrap` is the shift the wrap applied (−range across UpperLimit) — added back so the
    // travel is the real step, not the jump to the other end.
    const delta = this.currentPosition - start - this._stepWrap;
    if (delta !== 0) {
      // A behavior that CLAIMED the axis forced the position (signal / hold) — a discontinuity.
      if (this.positionClaimedThisTick) this.discontinuityRev++;
      else this.stepTravel += delta;
    }
    this.travelOdometer += this.stepTravel;
    this._motionLastPos = this.currentPosition;
  }

  /** The drive physics of one fixed timestep (behaviors, overwrite, jog, positioning). */
  private updateMotion(dt: number) {
    // Per-tick behavior flags are cleared before ANY early return, so a drive
    // that stops running its behaviors (not owner, blocked, overwrite) can never
    // report a stale claim/change — CoreSubsystems.drives() reads them for the
    // on-demand render flag and a latched value would keep the renderer awake.
    this.behaviorChangedThisTick = false;
    this.positionClaimedThisTick = false;
    // When not owner (multiuser client), skip ALL local physics.
    // Positions are applied directly via applySyncData() from multiuser channel.
    if (!this.isOwner) return;
    if (this.motionBlocked) {
      this.stop();
      return;
    }

    // Early-return for completely idle drives (no motion, no behaviors)
    if (this.isIdle) return;

    if (this.positionOverwrite) {
      // Derive speed from position change so charts show meaningful data
      if (dt > 0) {
        const delta = this.currentPosition - this._prevOverwritePos;
        this.currentSpeed = Math.abs(delta) / dt;
        if (delta !== 0) this._moveSign = delta < 0 ? -1 : 1;
        this._prevOverwritePos = this.currentPosition;
      }
      // The core is NOT advanced while an external authority writes the
      // position (playback, multiuser follower, PLC feedback). Arm a rebase so
      // the tick that returns to local physics re-seeds it from the actual
      // position/speed instead of resuming a profile that describes a past the
      // drive never lived through (plan-281 §2.7 PositionOverwrite/Playback).
      this._smoothRebasePending = true;
      // plan-673 Phase 4/5: the setpoint — and ONLY the setpoint — may be
      // produced here, because the position is somebody else's answer.
      //
      // Guarded by `dynamicAxis` so a KINEMATIC overwrite (recording playback,
      // a multiuser follower) keeps costing exactly what it cost before: one
      // boolean test, no behavior loop. A dynamic axis pays the loop over its
      // own one or two behaviors.
      if (this.dynamicAxis) {
        const behaviors = this.driveBehaviors;
        for (let i = 0; i < behaviors.length; i++) behaviors[i].commandDynamicSetpoint?.(dt);
        // The explicit ramp runs AFTER the behaviors, so a `startMove()` on this
        // very axis outranks a passive follower. In practice they are mutually
        // exclusive: `stepDynamicSetpoint` needs `isRunning`, and a gear slave
        // never runs.
        this.stepDynamicSetpoint(dt);
      }
      this.applyToNode();
      this.dispatchAfterUpdate();
      return;
    }

    // Call drive behaviors first (mirrors Unity: Drive.CalcFixedUpdate calls IDriveBehavior[])
    for (const behavior of this.driveBehaviors) {
      behavior.update(dt);
    }

    // A behavior that FOLLOWED an external position command owns the axis for
    // this tick. Without this the drive's own jog — an authored `JogForward`,
    // say — would integrate straight over the position the behavior just wrote,
    // and a drive wired to a real controller would visibly fight it. Same rule
    // as `positionOverwrite` above, decided one tick at a time because a command
    // signal can be connected and disconnected while the model runs.
    if (this.positionClaimedThisTick) {
      this.dispatchAfterUpdate();
      return;
    }

    // Central master speed override (1 = normal). Scales every drive's effective
    // speed at runtime, preserving relative speeds — see rv-speed-override.ts.
    const speedOverride = getDriveSpeedOverride();

    // Jog is a Drive command, independent of whether a TransportSurface consumes
    // the drive speed. Unity runs the same position/speed/limit state machine for
    // every Drive and suppresses only the final visual transform for belt drives.
    if (this.jogForward || this.jogBackward || this._wasJogging || this._stoppingJog) {
      this.updateJog(dt, speedOverride);
      return;
    }

    if (!this.isRunning) {
      if (this.behaviorChangedThisTick) this.dispatchAfterUpdate();
      return;
    }

    // Smooth (jerk-limited) point-to-point. Returns false when no provider is
    // available, in which case the trapezoidal path below runs unchanged.
    if (this.smoothRequested && this.updateSmoothMove(dt, speedOverride)) return;

    const dist = this.targetPosition - this.currentPosition;
    if (Math.abs(dist) < 0.01) {
      this.currentPosition = this.targetPosition;
      this.isRunning = false;
      this.currentSpeed = 0;
      this.applyToNode();
      this.dispatchAfterUpdate();
      return;
    }

    const dir = Math.sign(dist);
    this._moveSign = dir < 0 ? -1 : 1;
    const speed = this.targetSpeed * speedOverride;

    this.currentSpeed = computeRampedSpeed(
      this.currentSpeed, speed, this.Acceleration, this.UseAcceleration, dist, dt,
    );

    let nextPos = this.currentPosition + dir * this.currentSpeed * dt;

    // Clamp to target
    if (dir > 0 && nextPos > this.targetPosition) nextPos = this.targetPosition;
    if (dir < 0 && nextPos < this.targetPosition) nextPos = this.targetPosition;

    // Apply limits
    if (this.UseLimits) {
      nextPos = Math.max(this.LowerLimit, Math.min(this.UpperLimit, nextPos));
    }

    this.currentPosition = nextPos;
    this.applyToNode();
    this.dispatchAfterUpdate();
  }

  /** Update continuous jog motion, including Unity-style release deceleration. */
  private updateJog(dt: number, speedOverride: number): void {
    // Smooth jog: arm/re-arm a far target while held, plan a braking profile on
    // release. Falls through to the trapezoidal jog when no provider is loaded.
    this._moveSign = 1; // jog carries its sign in currentSpeed (smooth jog too)
    if (this.smoothRequested && this.updateSmoothJog(dt, speedOverride)) return;

    const jogging = this.jogForward || this.jogBackward;

    // Unity integrates the position with the speed from the previous fixed tick,
    // then calculates the speed for the next tick.
    let nextPos = this.currentPosition + this.currentSpeed * dt;

    if (jogging) {
      const desiredSpeed = (this.jogForward ? this.targetSpeed : -this.targetSpeed) * speedOverride;
      if (this.UseAcceleration && this.Acceleration > 0) {
        this.currentSpeed = moveTowards(this.currentSpeed, desiredSpeed, this.Acceleration * dt);
      } else {
        this.currentSpeed = desiredSpeed;
      }
      this._wasJogging = true;
      this._stoppingJog = false;
    } else if (this._wasJogging) {
      this._wasJogging = false;
      if (this.UseAcceleration && this.Acceleration > 0 && this.currentSpeed !== 0) {
        this._stoppingJog = true;
        this.currentSpeed = moveTowards(this.currentSpeed, 0, this.Acceleration * dt);
      } else {
        this._stoppingJog = false;
        this.currentSpeed = 0;
      }
    } else if (this._stoppingJog) {
      this.currentSpeed = moveTowards(this.currentSpeed, 0, this.Acceleration * dt);
      if (this.currentSpeed === 0) this._stoppingJog = false;
    }

    if (this.UseLimits) {
      if (this.jogForward && nextPos >= this.UpperLimit) {
        nextPos = this.UpperLimit;
        this.currentSpeed = 0;
      } else if (this.jogBackward && nextPos <= this.LowerLimit) {
        nextPos = this.LowerLimit;
        this.currentSpeed = 0;
      } else {
        nextPos = Math.max(this.LowerLimit, Math.min(this.UpperLimit, nextPos));
      }
    }

    this.currentPosition = nextPos;
    this.isRunning = this.currentSpeed !== 0;
    this.applyToNode();
    this.dispatchAfterUpdate();
  }

  // #region SmoothMotion
  // ── Smooth (jerk-limited) motion, plan-281 Phase 4 ───────────────────────
  //
  // The host owns commands, limits, wrap, signals, transform and ownership; the
  // core owns the profile and its playback. Nothing below computes a segment,
  // a phase time or a braking distance — that is the whole point of the shared
  // Rust core (plan-281 E3/E4).

  /** True when this drive is CONFIGURED for smooth motion (provider or not). */
  get smoothRequested(): boolean {
    return this.UseAcceleration && this.SmoothAcceleration;
  }

  /** True when this drive is actually being driven by the smooth core. */
  get smoothActive(): boolean {
    return this.smoothRequested && this._smoothHandle !== 0 && this._smoothPlanned;
  }

  /** Read-only view of the live core snapshot (debug/inspection/tests). */
  get smoothSnapshot(): Readonly<MotionSnapshot> {
    return this._smoothSnapshot;
  }

  /**
   * Effective (reachable) end of the active profile, or NaN when no smooth plan
   * has been made since the last command. Differs from `targetPosition` exactly
   * in the reachability case (plan-281 F2).
   */
  get smoothEffectiveTarget(): number {
    return this._smoothEffectiveTarget;
  }

  /**
   * Get the provider and make sure this drive has a configured context.
   * Returns null whenever smooth motion cannot run — no provider, context
   * creation failed, or the drive's own parameters are not a valid limit set
   * (TargetSpeed/Acceleration/Jerk must all be finite and > 0). Every null
   * answer is a fallback to the trapezoidal ramp, warned once per model.
   */
  private acquireSmooth(): SmoothMotionProvider | null {
    if (this._smoothRejected) return null;
    const provider = smoothMotionRegistry.provider;
    if (!provider) {
      warnSmoothMotionDegraded(this.name);
      return null;
    }
    if (this._smoothHandle === 0) {
      const handle = provider.create();
      if (handle === 0) {
        this._smoothRejected = true;
        console.warn(`[smooth-motion] "${this.name}": could not create a motion context — using the trapezoidal ramp.`);
        return null;
      }
      this._smoothHandle = handle;
      this._smoothLimitsDirty = true;
    }
    if (this._smoothLimitsDirty) {
      // vmax is the drive's own limit; the speed overrides scale profile TIME in
      // `stepInto`, never the limits (F7) — otherwise a paused drive would have
      // vmax 0 and the plan would be rejected instead of simply standing still.
      const status = provider.configure(
        this._smoothHandle,
        Math.abs(this.TargetSpeed),
        this.Acceleration,
        this.Jerk,
      );
      if (status !== SMOOTH_OK) {
        // Unconfigurable context: free it rather than keeping a handle whose
        // limits every later rebase/setTarget would reject anyway.
        this.dispose();
        this._smoothRejected = true;
        console.warn(
          `[smooth-motion] "${this.name}": ${smoothStatusText(status)} `
          + `(TargetSpeed=${this.TargetSpeed}, Acceleration=${this.Acceleration}, Jerk=${this.Jerk}) `
          + '— using the trapezoidal ramp.',
        );
        return null;
      }
      this._smoothLimitsDirty = false;
    }
    return provider;
  }

  /** Combined profile-time factor: global × per-drive, clamped to a sane range. */
  private smoothOverride(globalOverride: number): number {
    const local = Number.isFinite(this.SpeedOverride) ? this.SpeedOverride : 1;
    const combined = globalOverride * local;
    return combined > 0 ? combined : 0;
  }

  /** Push the current host state into the core WITHOUT planning. */
  private seedSmoothState(provider: SmoothMotionProvider, velocity: number): MotionStatus {
    this._smoothState.position = this.currentPosition;
    this._smoothState.velocity = velocity;
    // Acceleration continuity matters on a redirect mid-profile: seeding 0 there
    // would fake a kink the drive never had. Outside an active plan there is
    // nothing to continue from, so 0 is the honest value.
    this._smoothState.acceleration = this._smoothPlanned ? this._smoothSnapshot.acceleration : 0;
    return provider.setState(this._smoothHandle, this._smoothState);
  }

  /**
   * Wall-clock velocity for `currentSpeed`.
   *
   * The core's snapshot carries the NOMINAL profile velocity — d(position) /
   * d(profile time) — because a speed override scales profile TIME, not the
   * limits (that is exactly what makes pause/resume jump-free, F7). A drive
   * running at override 0.5 therefore reports a nominal 500 mm/s while covering
   * 250 mm per wall-clock second.
   *
   * `currentSpeed` is consumed as a PHYSICAL speed everywhere in the viewer —
   * TransportSurface moves its MUs with it, `IsAtSpeed` feeds it back to the
   * PLC, the drive chart plots it — and the trapezoidal path has always reported
   * the override-scaled value. Reporting the nominal one here would make a
   * belt run at full speed while its drive crawls. So the override is applied
   * back out; the untouched nominal profile value stays available through
   * {@link smoothSnapshot}.
   *
   * (Unity's legacy `SmoothMotion` reports the nominal value. The divergence is
   * deliberate and belongs on the Phase-5 Unity↔WEB parity list, not in a silent
   * TransportSurface bug.)
   */
  private smoothWallClockVelocity(override: number): number {
    return this._smoothSnapshot.velocity * override;
  }

  /** Signed velocity of the current motion, as the core wants it. */
  private smoothSignedVelocity(): number {
    if (this._smoothPlanned) return this._smoothSnapshot.velocity;
    // Outside a plan `currentSpeed` is a magnitude on the PTP path and signed on
    // the jog path; the jog direction (or the direction to the target) resolves it.
    if (this._smoothJogDir !== 0) return Math.abs(this.currentSpeed) * this._smoothJogDir;
    if (this.currentSpeed < 0) return this.currentSpeed;
    const dir = Math.sign(this.targetPosition - this.currentPosition) || 1;
    return this.currentSpeed * dir;
  }

  /**
   * Park the core at a position with a given velocity — the answer to EVERY
   * discontinuous host-side position change (hard limit clamp, raycast
   * correction, reset, stop, return from PositionOverwrite/ownership).
   * `rebase` sets the authoritative state and plans a continuous stop from it,
   * so the core never keeps playing a profile the drive is no longer on
   * (plan-281 §2.7). No-op without a live context.
   */
  private rebaseSmooth(position: number, velocity: number): void {
    if (this._smoothHandle === 0) return;
    const provider = smoothMotionRegistry.provider;
    if (!provider) return;
    this._smoothState.position = position;
    this._smoothState.velocity = velocity;
    this._smoothState.acceleration = 0;
    provider.rebase(this._smoothHandle, this._smoothState);
    this._smoothPlanned = false;
    this._smoothPlanTarget = Number.NaN;
    this._smoothJogDir = 0;
    this._smoothRebasePending = false;
  }

  /**
   * Smooth point-to-point tick. Returns false when smooth motion is unavailable
   * so the caller runs the trapezoidal path instead.
   */
  private updateSmoothMove(dt: number, globalOverride: number): boolean {
    const provider = this.acquireSmooth();
    if (!provider) return false;
    const handle = this._smoothHandle;

    const needsPlan = !this._smoothPlanned
      || this._smoothRebasePending
      || this._smoothPlanTarget !== this.targetPosition;

    if (needsPlan) {
      const velocity = this._smoothRebasePending ? 0 : this.smoothSignedVelocity();
      if (this.seedSmoothState(provider, velocity) !== SMOOTH_OK) return this.abandonSmooth();
      const status = provider.setTarget(handle, this.targetPosition, 0, this._smoothSnapshot);
      if (status !== SMOOTH_OK) return this.abandonSmooth(status);
      this._smoothPlanned = true;
      this._smoothPlanTarget = this.targetPosition;
      this._smoothEffectiveTarget = this._smoothSnapshot.effectiveTarget;
      this._smoothRebasePending = false;
      this._smoothJogDir = 0;
      this._smoothJogBlocked = 0;
      // Nothing to travel: end the command here rather than stepping a
      // zero-length profile forever.
      if (this._smoothSnapshot.finished) {
        this.currentPosition = this._smoothSnapshot.position;
        this.currentSpeed = 0;
        this.isRunning = false;
        this.applyToNode();
        this.dispatchAfterUpdate();
        return true;
      }
    }

    const override = this.smoothOverride(globalOverride);
    const status = provider.stepInto(handle, dt, override, this._smoothSnapshot);
    if (status !== SMOOTH_OK) return this.abandonSmooth(status);

    // PTP reports an unsigned magnitude, exactly like the trapezoidal path —
    // direction lives in the position delta there and must keep doing so, or
    // every DriveBehaviour feedback slot and TransportSurface flips sign on a
    // backward move (plan-281 Phase 4, signed-velocity regression).
    const velocity = this.smoothWallClockVelocity(override);
    this.currentSpeed = Math.abs(velocity);
    if (velocity !== 0) this._moveSign = velocity < 0 ? -1 : 1;
    this.currentPosition = this.applySmoothLimits(provider, this._smoothSnapshot.position);

    if (this._smoothSnapshot.finished) {
      this.isRunning = false;
      this.currentSpeed = 0;
      this._smoothPlanned = false;
    }

    this.applyToNode();
    this.dispatchAfterUpdate();
    return true;
  }

  /**
   * Smooth jog tick. Returns false when smooth motion is unavailable so the
   * caller runs the trapezoidal jog instead.
   */
  private updateSmoothJog(dt: number, globalOverride: number): boolean {
    const provider = this.acquireSmooth();
    if (!provider) return false;
    const handle = this._smoothHandle;
    const dir = this.jogForward ? 1 : this.jogBackward ? -1 : 0;

    if (dir !== 0 && this.jogBlockedAtLimit(dir)) {
      // Parked against a hard limit: hold position, do not re-arm into it.
      this.currentSpeed = 0;
      this.isRunning = false;
      this._wasJogging = true;
      this._stoppingJog = false;
      this._smoothJogBlocked = dir;
      this.rebaseSmooth(this.currentPosition, 0);
      this.applyToNode();
      this.dispatchAfterUpdate();
      return true;
    }

    if (dir !== 0) {
      this._smoothJogBlocked = 0;
      // Re-arm before the profile would start braking towards the sentinel, so a
      // held jog never decelerates on its own (plan-281 F5).
      const brakingSoon = this._smoothSnapshot.elapsed + dt >= this._smoothSnapshot.decelerationStart;
      if (!this._smoothPlanned || this._smoothJogDir !== dir || this._smoothRebasePending || brakingSoon) {
        const velocity = this._smoothRebasePending ? 0 : this.smoothSignedVelocity();
        if (this.seedSmoothState(provider, velocity) !== SMOOTH_OK) return this.abandonSmooth();
        const sentinel = this.currentPosition + dir * SMOOTH_JOG_SENTINEL;
        const status = provider.setTarget(handle, sentinel, 0, this._smoothSnapshot);
        if (status !== SMOOTH_OK) return this.abandonSmooth(status);
        this._smoothPlanned = true;
        this._smoothPlanTarget = Number.NaN;
        this._smoothEffectiveTarget = Number.NaN;
        this._smoothJogDir = dir;
        this._smoothRebasePending = false;
      }
      this._wasJogging = true;
      this._stoppingJog = false;
    } else if (this._wasJogging) {
      // Release: plan a braking profile from the state the drive is actually in.
      // Seeded with the NOMINAL profile velocity, not `currentSpeed` — the core
      // works in profile time, and an override-scaled seed would plan a braking
      // ramp for a speed the profile never had.
      this._wasJogging = false;
      const velocity = this.smoothSignedVelocity();
      this._smoothJogDir = 0;
      this._smoothJogBlocked = 0;
      if (velocity === 0) {
        this._smoothPlanned = false;
        this.isRunning = false;
        this.currentSpeed = 0;
        this.applyToNode();
        this.dispatchAfterUpdate();
        return true;
      }
      this._smoothState.position = this.currentPosition;
      this._smoothState.velocity = velocity;
      this._smoothState.acceleration = this._smoothPlanned ? this._smoothSnapshot.acceleration : 0;
      const status = provider.rebase(handle, this._smoothState);
      if (status !== SMOOTH_OK) return this.abandonSmooth(status);
      this._smoothPlanned = true;
      this._smoothPlanTarget = Number.NaN;
      this._stoppingJog = true;
    } else if (!this._stoppingJog) {
      return true;
    }

    const override = this.smoothOverride(globalOverride);
    const status = provider.stepInto(handle, dt, override, this._smoothSnapshot);
    if (status !== SMOOTH_OK) return this.abandonSmooth(status);

    // Jog reports SIGNED speed (as the trapezoidal jog does) — TransportSurface
    // reads it directly to drive the belt, so a backward jog must stay negative.
    this.currentSpeed = this.smoothWallClockVelocity(override);
    this.currentPosition = this.applySmoothLimits(provider, this._smoothSnapshot.position);

    if (this._stoppingJog && this._smoothSnapshot.finished) {
      this._stoppingJog = false;
      this.currentSpeed = 0;
      this._smoothPlanned = false;
    }

    this.isRunning = this.currentSpeed !== 0;
    this.applyToNode();
    this.dispatchAfterUpdate();
    return true;
  }

  /** True when a jog in `dir` would push straight through a hard limit. */
  private jogBlockedAtLimit(dir: number): boolean {
    if (!this.UseLimits || this.JumpToLowerLimitOnUpperLimit) return false;
    if (dir > 0) return this.currentPosition >= this.UpperLimit;
    return this.currentPosition <= this.LowerLimit;
  }

  /**
   * Apply `UseLimits` to a position the core produced, keeping the core in sync
   * (plan-281 §2.7). Wrap shifts state AND profile together so the motion
   * continues across the seam; a hard clamp rebases, which parks the core at the
   * limit instead of letting it play on internally.
   */
  private applySmoothLimits(provider: SmoothMotionProvider, position: number): number {
    if (!this.UseLimits) return position;
    const range = this.UpperLimit - this.LowerLimit;

    if (this.JumpToLowerLimitOnUpperLimit && range > 0) {
      if (position > this.UpperLimit) {
        provider.shiftPosition(this._smoothHandle, -range);
        this._smoothEffectiveTarget -= range;
        this._stepWrap -= range;
        return position - range;
      }
      if (position < this.LowerLimit) {
        provider.shiftPosition(this._smoothHandle, range);
        this._smoothEffectiveTarget += range;
        this._stepWrap += range;
        return position + range;
      }
      return position;
    }

    if (position > this.UpperLimit) return this.clampSmoothAtLimit(this.UpperLimit);
    if (position < this.LowerLimit) return this.clampSmoothAtLimit(this.LowerLimit);
    return position;
  }

  /** Hard-stop the drive at `limit` and park the core there. */
  private clampSmoothAtLimit(limit: number): number {
    this.currentSpeed = 0;
    this.isRunning = false;
    this._stoppingJog = false;
    this._smoothEffectiveTarget = limit;
    this.rebaseSmooth(limit, 0);
    return limit;
  }

  /**
   * A core call failed. Give this drive up for smooth motion (no retry storm,
   * and no half-stepped profile) and let the trapezoidal path take over from the
   * next tick — never mid-profile silently, the drive is stopped first (G0.3).
   */
  private abandonSmooth(status: MotionStatus = SMOOTH_OK): boolean {
    console.warn(
      `[smooth-motion] "${this.name}": core call failed (${smoothStatusText(status)}) `
      + '— this drive falls back to the trapezoidal ramp.',
    );
    this.dispose();
    this._smoothRejected = true;
    this.currentSpeed = 0;
    return false;
  }
  // #endregion SmoothMotion

  /**
   * Called when ownership changes (multiuser connect/disconnect).
   * When not owner, the drive skips all local physics in update().
   * Position/speed are applied externally via applySyncData().
   */
  onOwnershipChanged(isOwner: boolean): void {
    if (isOwner) {
      this.positionOverwrite = false;
      // Local physics resumes from a position a remote owner wrote: the core has
      // to be re-seeded before it plans anything (plan-281 §2.7 Multiuser/Live-Sync).
      this._smoothRebasePending = true;
    }
  }

  /**
   * Apply sync data from the multiuser server (port 7000).
   * All drives receive the same position and speed state. `applyToNode()` mirrors
   * Unity's `_istransportsurface` guard and suppresses only the belt-frame transform.
   * Relies on high sync rate (60 Hz) for smooth visual result.
   */
  applySyncData(position: number, speed?: number): void {
    this.currentPosition = position;
    this.markDiscontinuity();
    if (speed !== undefined) this.currentSpeed = speed;
    // Externally written position — the core must be re-seeded before it plans
    // again (plan-281 §2.7 Multiuser/Live-Sync).
    this._smoothRebasePending = true;
    this.applyToNode();
  }

  /**
   * Re-cache base transform from the current node position/quaternion.
   * Must be called after re-parenting (e.g., kinematic group attach) since
   * attach() modifies local transforms to preserve world position.
   */
  refreshBaseTransform(): void {
    this.basePosition.copy(this.node.position);
    this.baseQuaternion.copy(this.node.quaternion);
  }

  /**
   * Re-derive runtime fields from the config fields after a LATE config change
   * (e.g. an overlay override applied after the initial initDrive — see the
   * scene loader's overlay reconciliation). Unlike initDrive(), this does NOT
   * re-cache the base transform or reset currentPosition, so it can be called
   * post-load without compounding the StartPosition offset. Mirrors the
   * config→runtime sync in initDrive (axis, isRotary, targetSpeed).
   */
  reapplyConfig(): void {
    this.isRotary = isRotation(this.Direction);
    const rawAxis = directionToGltfAxis(this.Direction);
    this.axis.copy(rawAxis);
    if (this.ReverseDirection) this.axis.negate();
    this.targetSpeed = this.TargetSpeed;
    // TargetSpeed/Acceleration/Jerk may have changed with the overlay — the new
    // limits must reach the core before its next replan (plan-281 §2.7).
    this._smoothLimitsDirty = true;
    this._smoothRejected = false;
    this.applyToNode();
  }

  /**
   * Restore the drive to its authored start pose for a fresh run
   * (`resetSimulation()` / `web_sim_reset`). Mirrors `initDrive()`'s runtime
   * seeding (currentPosition → StartPosition, targetSpeed → TargetSpeed) WITHOUT
   * re-caching the base transform — the node may have been re-parented since
   * load, so the cached `basePosition`/`baseQuaternion` stay authoritative.
   *
   * All drives drop jog / running / overwrite state. Drive behaviors can issue a
   * fresh command on the next tick, matching Unity's DriveReset/Stop semantics.
   */
  reset(): void {
    this.currentPosition = this.StartPosition;
    this.markDiscontinuity();
    this.travelOdometer = 0; // a fresh run counts from zero (deterministic per run)
    this.stepTravel = 0;
    this.targetPosition = this.StartPosition;
    this.currentSpeed = 0;
    this.isRunning = false;
    this.targetSpeed = this.TargetSpeed;
    this.positionOverwrite = false;
    this.liveControlled = false;
    this._prevOverwritePos = this.StartPosition;
    // plan-673 Phase 4: a run starts without a command and without an error —
    // a latched following error from the previous run would be reported as an
    // overload on the first tick of the new one. `arrivalTolerance` is NOT
    // reset: it is a property of the axis declaration, not of the run.
    this.commandedPosition = Number.NaN;
    this.followingError = 0;
    this.actualTorque = 0;
    this.saturated = false;
    // Restore the authored jog state so drives configured to jog continuously
    // resume after a sim reset (Unity keeps the JogForward inspector bit set).
    this.jogForward = this.JogForward;
    this.jogBackward = this.JogBackward;
    this._wasJogging = false;
    this._stoppingJog = false;
    // Park the core at the authored start pose. The context is KEPT — a sim
    // reset is not a teardown, and re-creating it would churn handles on every
    // reset (plan-281 §2.7 Reset).
    this._smoothEffectiveTarget = Number.NaN;
    this._smoothJogBlocked = 0;
    this.rebaseSmooth(this.StartPosition, 0);
    this.applyToNode();
    this.dispatchAfterUpdate();
  }

  /**
   * Drive the node to its authored BASE pose — the transform captured at
   * `initDrive()`, i.e. position 0 with `Offset` NOT applied.
   *
   * This is the pose the GLB geometry was authored in, and the one Unity
   * parents in: `Kinematic.Awake()` runs before `Drive.Start()` assigns
   * `CurrentPosition = StartPosition` and before the first `FixedUpdate()`
   * writes a transform. The loader's kinematic phases (8b re-parent, 10c/10d
   * bake) must therefore use THIS pose, not `applyToNode()` with position
   * zero — that one still adds `Offset` and leaves the node displaced.
   */
  applyBasePose(): void {
    if (this.Direction === DriveDirection.Virtual || this.isTransportSurface) return;
    if (this.isRotary) this.node.quaternion.copy(this.baseQuaternion);
    else this.node.position.copy(this.basePosition);
  }

  /** Apply current position to Three.js node transform */
  applyToNode() {
    const pos = this.currentPosition + this.Offset;

    // Unity still updates CurrentPosition/CurrentSpeed for TransportSurface
    // drives, but `_istransportsurface` suppresses movement of the belt frame.
    if (this.Direction === DriveDirection.Virtual || this.isTransportSurface) return;

    writeDriveLocalTransform(
      this.isRotary, this.axis, this.basePosition, this.baseQuaternion,
      pos, this.isRotary ? 0 : this.positionToLocalOffset(pos),
      this.node.position, this.node.quaternion,
    );
  }

  /**
   * The local transform this drive's node WOULD have at drive position
   * `position` (mm or deg, `Offset` added like `applyToNode`) — written into
   * `outPosition` / `outQuaternion`, which start as copies of the node's
   * current local transform. Pure: no drive field, motion state or node is
   * touched (plan-641 M6). Returns false — outputs untouched — for a drive
   * that never moves its node (`Virtual`, TransportSurface).
   *
   * Reads the PARENT's world matrix for the linear unit conversion, so a
   * caller posing nested axes refreshes the parent first.
   */
  computePoseTransform(position: number, outPosition: Vector3, outQuaternion: Quaternion): boolean {
    outPosition.copy(this.node.position);
    outQuaternion.copy(this.node.quaternion);
    if (this.Direction === DriveDirection.Virtual || this.isTransportSurface) return false;
    const pos = position + this.Offset;
    writeDriveLocalTransform(
      this.isRotary, this.axis, this.basePosition, this.baseQuaternion,
      pos, this.isRotary ? 0 : this.positionToLocalOffset(pos),
      outPosition, outQuaternion,
    );
    return true;
  }
}

// Register schema for auto-derivation of CONSUMED fields
registerComponentSchema('Drive', RVDrive.schema);

// Register capabilities for Drive
registerCapabilities('Drive', {
  pick: 'select',
  bake: 'chunk',      // the mover: its subtree is one chunk that moves as a unit
  authorable: true,   // addable in the asset editor; constructed by the loader on reload
  ui: { tooltip: 'drive', badge: '#4fc3f7', filter: 'Drives', category: 'drives', priority: 10 },
});
