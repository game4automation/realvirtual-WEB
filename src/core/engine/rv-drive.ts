// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { Object3D, Vector3, Quaternion, Euler, MathUtils } from 'three';
import { DriveDirection, directionToGltfAxis, isRotation } from './rv-coordinate-utils';
import type { ComponentSchema, ComponentContext, RVComponent } from './rv-component-registry';
import { registerComponentSchema, registerCapabilities, loadSchemaFromSpec } from './rv-component-registry';
import { MM_TO_METERS } from './rv-constants';
import { parentScaleAlong } from './rv-drive-units';
import { getDriveSpeedOverride } from './rv-speed-override';
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
}

// Reusable temp objects to avoid GC
const _euler = new Euler();
const _deltaQuat = new Quaternion();
const _axisScaled = new Vector3();
/** Scratch for the motion direction in the PARENT frame (unit conversion). */
const _unitDir = new Vector3();

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
  /** Previous position for computing speed in overwrite mode */
  private _prevOverwritePos = 0;
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

    // Store base transform
    this.basePosition.copy(this.node.position);
    this.baseQuaternion.copy(this.node.quaternion);

    // Compute axis
    const rawAxis = directionToGltfAxis(this.Direction);
    this.axis.copy(rawAxis);
    if (this.ReverseDirection) {
      this.axis.negate();
    }

    // Set initial position (matches Unity Drive.Start(): CurrentPosition = StartPosition)
    this.currentPosition = this.StartPosition;
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
   */
  get isAtTarget(): boolean {
    const target = Number.isFinite(this._smoothEffectiveTarget)
      ? this._smoothEffectiveTarget
      : this.targetPosition;
    return Math.abs(this.currentPosition - target) < 0.01;
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
      JogForward: this.jogForward,
      JogBackward: this.jogBackward,
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

  /** Update drive physics - called every fixed timestep */
  update(dt: number) {
    // When not owner (multiuser client), skip ALL local physics.
    // Positions are applied directly via applySyncData() from multiuser channel.
    if (!this.isOwner) return;

    // Early-return for completely idle drives (no motion, no behaviors)
    if (this.isIdle) return;

    if (this.positionOverwrite) {
      // Derive speed from position change so charts show meaningful data
      if (dt > 0) {
        this.currentSpeed = Math.abs(this.currentPosition - this._prevOverwritePos) / dt;
        this._prevOverwritePos = this.currentPosition;
      }
      // The core is NOT advanced while an external authority writes the
      // position (playback, multiuser follower, PLC feedback). Arm a rebase so
      // the tick that returns to local physics re-seeds it from the actual
      // position/speed instead of resuming a profile that describes a past the
      // drive never lived through (plan-281 §2.7 PositionOverwrite/Playback).
      this._smoothRebasePending = true;
      this.applyToNode();
      this.dispatchAfterUpdate();
      return;
    }

    // Call drive behaviors first (mirrors Unity: Drive.CalcFixedUpdate calls IDriveBehavior[])
    this.behaviorChangedThisTick = false;
    for (const behavior of this.driveBehaviors) {
      behavior.update(dt);
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
    this.currentSpeed = Math.abs(this.smoothWallClockVelocity(override));
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
        return position - range;
      }
      if (position < this.LowerLimit) {
        provider.shiftPosition(this._smoothHandle, range);
        this._smoothEffectiveTarget += range;
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
    this.targetPosition = this.StartPosition;
    this.currentSpeed = 0;
    this.isRunning = false;
    this.targetSpeed = this.TargetSpeed;
    this.positionOverwrite = false;
    this.liveControlled = false;
    this._prevOverwritePos = this.StartPosition;
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

    if (this.isRotary) {
      // Rotation: localRotation = baseQuat * Quaternion.Euler(axis * angle)
      // Unity uses degrees, Three.js Euler uses radians
      const rad = MathUtils.degToRad(pos);
      _axisScaled.copy(this.axis).multiplyScalar(rad);
      _euler.set(_axisScaled.x, _axisScaled.y, _axisScaled.z, 'XYZ');
      _deltaQuat.setFromEuler(_euler);
      this.node.quaternion.copy(this.baseQuaternion).multiply(_deltaQuat);
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
      const offset = this.positionToLocalOffset(pos);
      this.node.position.copy(this.basePosition);
      _axisScaled.copy(this.axis).multiplyScalar(offset).applyQuaternion(this.baseQuaternion);
      this.node.position.add(_axisScaled);
    }
  }
}

// Register schema for auto-derivation of CONSUMED fields
registerComponentSchema('Drive', RVDrive.schema);

// Register capabilities for Drive
registerCapabilities('Drive', {
  hoverable: true,
  selectable: true,
  inspectorVisible: true,
  authorable: true,   // addable in the asset editor; constructed by the loader on reload
  tooltipType: 'drive',
  badgeColor: '#4fc3f7',
  filterLabel: 'Drives',
  hoverEnabledByDefault: true,
  exclusiveHoverGroup: true,
  hoverPriority: 10,
  pinPriority: 5,
});
