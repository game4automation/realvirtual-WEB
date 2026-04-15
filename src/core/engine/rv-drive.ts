// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { Object3D, Vector3, Quaternion, Euler, MathUtils } from 'three';
import { DriveDirection, directionToGltfAxis, isRotation } from './rv-coordinate-utils';
import type { ComponentSchema, ComponentContext, RVComponent } from './rv-component-registry';
import { registerComponentSchema, registerCapabilities } from './rv-component-registry';
import { MM_TO_METERS } from './rv-constants';

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

/**
 * RVDrive - TypeScript port of realvirtual Drive.cs transform logic.
 *
 * Stores the base (rest) transform from the GLB and applies drive position
 * changes as local transform deltas, exactly matching Unity's SetPosition().
 *
 * Controller scale is hardcoded to 1000 (mm->m) for the PoC.
 * In the GLB, positions are already in meters, so we divide by 1000.
 */
export class RVDrive implements RVComponent {
  static readonly schema: ComponentSchema = {
    Direction: { type: 'enum', enumMap: {
      'LinearX': DriveDirection.LinearX,
      'LinearY': DriveDirection.LinearY,
      'LinearZ': DriveDirection.LinearZ,
      'RotationX': DriveDirection.RotationX,
      'RotationY': DriveDirection.RotationY,
      'RotationZ': DriveDirection.RotationZ,
      'Virtual': DriveDirection.Virtual,
    }},
    ReverseDirection: { type: 'boolean', default: false },
    Offset: { type: 'number', default: 0 },
    StartPosition: { type: 'number', default: 0 },
    TargetSpeed: { type: 'number', default: 100 },
    Acceleration: { type: 'number', default: 100 },
    UseAcceleration: { type: 'boolean', default: false },
    UseLimits: { type: 'boolean', default: false },
    LowerLimit: { type: 'number', default: -180 },
    UpperLimit: { type: 'number', default: 180 },
  };

  readonly node: Object3D;
  readonly name: string;
  isOwner = true;

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

  /** Continuous forward motion at targetSpeed (set by Drive_Simple signal) */
  jogForward = false;
  /** Continuous backward motion at targetSpeed (set by Drive_Simple signal) */
  jogBackward = false;
  /** True if this drive is used by a TransportSurface (set by TransportSurface.init). */
  isTransportSurface = false;

  /** When true, update() skips physics and only applies transform (for DrivesPlayback) */
  positionOverwrite = false;
  /** Previous position for computing speed in overwrite mode */
  private _prevOverwritePos = 0;

  /** Drive behaviors called before physics, mirroring Unity's IDriveBehavior pattern */
  readonly driveBehaviors: IDriveBehavior[] = [];

  /** Optional callback invoked after each update tick (used by Drive_Cylinder for feedback signals) */
  onAfterUpdate: ((drive: RVDrive) => void) | null = null;

  // Direction axis (in local space)
  private axis = new Vector3();
  private controllerScale = MM_TO_METERS; // mm -> m

  constructor(node: Object3D) {
    this.node = node;
    this.name = node.name;
  }

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

    // Apply initial transform so StartPosition + Offset take effect immediately
    // (In Unity this happens on first FixedUpdate after Start())
    this.applyToNode();
  }

  /** Check if drive has reached its target position */
  get isAtTarget(): boolean {
    return Math.abs(this.currentPosition - this.targetPosition) < 0.01;
  }

  /** Check if drive is completely idle (no motion, no jog, no overwrite, no behaviors). */
  get isIdle(): boolean {
    return !this.isRunning && !this.jogForward && !this.jogBackward
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
      this.onAfterUpdate?.(this);
      return;
    }

    // Call drive behaviors first (mirrors Unity: Drive.CalcFixedUpdate calls IDriveBehavior[])
    for (const behavior of this.driveBehaviors) {
      behavior.update(dt);
    }

    // Jog mode: continuous motion at targetSpeed (used by Drive_Simple / conveyors)
    // We update currentSpeed for TransportSurface to use, but do NOT call applyToNode()
    // because conveyor drives should not physically translate the mesh — only belt texture
    // would scroll in Unity, while the frame stays put.
    if (this.jogForward || this.jogBackward) {
      this.currentSpeed = this.targetSpeed;
      this.isRunning = true;
      return;
    }

    if (!this.isRunning) return;

    const dist = this.targetPosition - this.currentPosition;
    if (Math.abs(dist) < 0.01) {
      this.currentPosition = this.targetPosition;
      this.isRunning = false;
      this.currentSpeed = 0;
      this.applyToNode();
      this.onAfterUpdate?.(this);
      return;
    }

    const dir = Math.sign(dist);
    const speed = this.targetSpeed;

    if (this.UseAcceleration && this.Acceleration > 0) {
      // Acceleration/deceleration
      const accel = this.Acceleration;
      const stoppingDist = (this.currentSpeed * this.currentSpeed) / (2 * accel);

      if (stoppingDist >= Math.abs(dist)) {
        // Decelerate
        this.currentSpeed = Math.max(0, this.currentSpeed - accel * dt);
      } else if (this.currentSpeed < speed) {
        // Accelerate
        this.currentSpeed = Math.min(speed, this.currentSpeed + accel * dt);
      }
    } else {
      this.currentSpeed = speed;
    }

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
    this.onAfterUpdate?.(this);
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
   * Transport surface drives: apply speed only — position would displace the mesh.
   * Positioning drives: snap to position and update transform immediately.
   * Relies on high sync rate (60 Hz) for smooth visual result.
   */
  applySyncData(position: number, speed?: number): void {
    if (this.isTransportSurface) {
      // Conveyor: only sync speed — the mesh stays in place, belt scrolls via speed
      this.currentSpeed = speed ?? this.targetSpeed;
    } else {
      // Direct snap — smooth at 60 Hz sync rate
      this.currentPosition = position;
      if (speed !== undefined) this.currentSpeed = speed;
      this.applyToNode();
    }
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

  /** Apply current position to Three.js node transform */
  applyToNode() {
    const pos = this.currentPosition + this.Offset;

    if (this.Direction === DriveDirection.Virtual) return;

    if (this.isRotary) {
      // Rotation: localRotation = baseQuat * Quaternion.Euler(axis * angle)
      // Unity uses degrees, Three.js Euler uses radians
      const rad = MathUtils.degToRad(pos);
      _axisScaled.copy(this.axis).multiplyScalar(rad);
      _euler.set(_axisScaled.x, _axisScaled.y, _axisScaled.z, 'XYZ');
      _deltaQuat.setFromEuler(_euler);
      this.node.quaternion.copy(this.baseQuaternion).multiply(_deltaQuat);
    } else {
      // Linear: localPosition = basePos + axis * (pos / controllerScale)
      // pos is in mm, we convert to meters by dividing by controllerScale
      const offset = pos / this.controllerScale;
      this.node.position.copy(this.basePosition);
      _axisScaled.copy(this.axis).multiplyScalar(offset);
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
  tooltipType: 'drive',
  badgeColor: '#4fc3f7',
  filterLabel: 'Drives',
  simulationActive: true,
  hoverEnabledByDefault: true,
  exclusiveHoverGroup: true,
  hoverPriority: 10,
  pinPriority: 5,
});
