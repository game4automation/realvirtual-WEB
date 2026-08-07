// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { Object3D, Vector3, Quaternion, Euler, MathUtils } from 'three';
import { DriveDirection, directionToGltfAxis, isRotation } from './rv-coordinate-utils';
import type { ComponentSchema, ComponentContext, RVComponent } from './rv-component-registry';
import { registerComponentSchema, registerCapabilities, loadSchemaFromSpec } from './rv-component-registry';
import { MM_TO_METERS } from './rv-constants';
import { parentScaleAlong } from './rv-drive-units';
import { getDriveSpeedOverride } from './rv-speed-override';

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

    // Apply initial transform so StartPosition + Offset take effect immediately
    // (In Unity this happens on first FixedUpdate after Start())
    this.applyToNode();
  }

  /** Check if drive has reached its target position */
  get isAtTarget(): boolean {
    return Math.abs(this.currentPosition - this.targetPosition) < 0.01;
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
  }

  stop() {
    this.isRunning = false;
    this.currentSpeed = 0;
    this.jogForward = false;
    this.jogBackward = false;
    this._wasJogging = false;
    this._stoppingJog = false;
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

  /**
   * Called when ownership changes (multiuser connect/disconnect).
   * When not owner, the drive skips all local physics in update().
   * Position/speed are applied externally via applySyncData().
   */
  onOwnershipChanged(isOwner: boolean): void {
    if (isOwner) {
      this.positionOverwrite = false;
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
