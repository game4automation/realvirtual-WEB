// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import type { Object3D } from 'three';
import { RVDrive, type IDriveBehavior } from './rv-drive';
import type { ComponentSchema, ComponentContext, RVComponent } from './rv-component-registry';
import { registerComponentSchema } from './rv-component-registry';
import { NodeRegistry } from './rv-node-registry';
import type { SignalStore } from './rv-signal-store';
import { debug } from './rv-debug';

/**
 * RVErraticDriver - TypeScript port of Drive_ErraticPosition.cs
 *
 * Continuously moves a drive to random positions between MinPos and MaxPos.
 * When one target is reached, picks a new random target.
 *
 * If SignalEnable is set, the drive only moves while the signal is true.
 * When the signal goes false, the drive returns to position 0 and stops.
 *
 * Implements IDriveBehavior — owned by the drive and called during drive.update(),
 * mirroring Unity's Drive.CalcFixedUpdate() calling its DriveBehaviours.
 *
 * Implements RVComponent — wired via schema + init() like all other components.
 */
export class RVErraticDriver implements IDriveBehavior, RVComponent {
  static readonly schema: ComponentSchema = {
    MinPos: { type: 'number', default: 0 },
    MaxPos: { type: 'number', default: 100 },
    Speed: { type: 'number', default: 100 },
    IterateBetweenMaxAndMin: { type: 'boolean', default: false },
    SignalEnable: { type: 'componentRef' },
  };

  readonly node: Object3D;
  isOwner = true;

  // Schema-mapped properties (PascalCase = C# Inspector field names)
  MinPos = 0;
  MaxPos = 100;
  Speed = 100;
  IterateBetweenMaxAndMin = false;

  /** Signal address that enables/disables erratic movement (null = always enabled).
   *  Resolved from ComponentRef by resolveComponentRefs() before init() is called. */
  SignalEnable: string | null = null;

  // Set in init() after drive lookup
  drive: RVDrive | null = null;
  private signalStore: SignalStore | null = null;

  // Runtime state
  private driving = false;
  private destPos = 0;
  private movingToZero = false;
  private readonly tolerance = 0.01;

  constructor(node: Object3D) {
    this.node = node;
  }

  init(context: ComponentContext): void {
    const path = NodeRegistry.computeNodePath(this.node);

    // Find the Drive registered on the same node
    const drive = context.registry.getByPath<RVDrive>('Drive', path);
    if (!drive) {
      console.warn(`[RVErraticDriver] No Drive found at "${path}" — behavior inactive`);
      return;
    }
    this.drive = drive;

    // Apply fallback from drive limits when schema values are still at their defaults (0)
    if (this.MinPos === 0 && this.MaxPos === 0) {
      // Both zero means no explicit values were set in extras — use drive limits
      this.MinPos = drive.UseLimits ? drive.LowerLimit : 0;
      this.MaxPos = drive.UseLimits ? drive.UpperLimit : 100;
    } else {
      // Apply per-field fallbacks: zero means "use drive default"
      if (this.MinPos === 0 && drive.UseLimits) this.MinPos = drive.LowerLimit;
      if (this.MaxPos === 0 && drive.UseLimits) this.MaxPos = drive.UpperLimit;
    }

    // Speed fallback: 0 or schema default (100) with no explicit extras → use drive's TargetSpeed
    if (this.Speed === 0) {
      this.Speed = drive.TargetSpeed;
    }

    // SignalEnable is already resolved to a string address (or null) by resolveComponentRefs()
    if (this.SignalEnable) {
      this.signalStore = context.signalStore;
      debug('loader', `  Drive_ErraticPosition "${drive.name}": SignalEnable="${this.SignalEnable}"`);
    }

    // Register self as a drive behavior so drive.update() calls our update()
    drive.driveBehaviors.push(this);

    debug('loader',
      `  Drive_ErraticPosition "${drive.name}": ` +
      `min=${this.MinPos} max=${this.MaxPos} speed=${this.Speed} ` +
      `iterate=${this.IterateBetweenMaxAndMin}`
    );
  }

  /** Whether the enable signal is currently true (or no signal = always enabled) */
  private get isEnabled(): boolean {
    if (!this.SignalEnable || !this.signalStore) return true;
    return this.signalStore.getBoolByPath(this.SignalEnable);
  }

  /** Call every fixed timestep - picks targets and checks arrival */
  update(_dt: number) {
    // Guard: drive must be resolved by init()
    if (!this.drive) return;

    // Skip if drive is in positionOverwrite mode (controlled by recording)
    if (this.drive.positionOverwrite) return;

    // Handle SignalEnable: when disabled, return to zero and stop
    if (!this.isEnabled) {
      if (Math.abs(this.drive.currentPosition) > this.tolerance && !this.movingToZero) {
        // Start moving back to zero
        this.drive.stop();
        this.driving = false;
        this.movingToZero = true;
        this.drive.targetPosition = 0;
        this.drive.targetSpeed = this.Speed;
        this.drive.startMove(0);
        return;
      }

      if (this.movingToZero) {
        // Check if reached zero
        if (Math.abs(this.drive.currentPosition) <= this.tolerance) {
          this.movingToZero = false;
          this.driving = false;
          this.drive.stop();
          this.drive.currentPosition = 0;
          this.drive.applyToNode();
        }
        return;
      }

      // Already at zero and disabled — do nothing
      return;
    }

    // Signal re-enabled: cancel return-to-zero if active
    if (this.movingToZero) {
      this.movingToZero = false;
      this.driving = false;
      this.drive.stop();
    }

    // Pick new target when not driving
    if (!this.driving) {
      this.drive.targetSpeed = this.Speed;

      if (!this.IterateBetweenMaxAndMin) {
        // Random position between min and max
        this.drive.targetPosition =
          this.MinPos + Math.random() * (this.MaxPos - this.MinPos);
      } else {
        // Toggle between min and max
        if (Math.abs(this.drive.currentPosition - this.MaxPos) <= this.tolerance) {
          this.drive.targetPosition = this.MinPos;
        } else {
          this.drive.targetPosition = this.MaxPos;
        }
      }

      this.drive.startMove();
      this.driving = true;
      this.destPos = this.drive.targetPosition;
    }

    // Check if target reached
    if (
      this.driving &&
      Math.abs(this.drive.currentPosition - this.destPos) <= this.tolerance
    ) {
      this.driving = false;
    }
  }
}

// Register schema so rv-extras-validator auto-derives CONSUMED fields
registerComponentSchema('Drive_ErraticPosition', RVErraticDriver.schema, {
  badgeColor: '#29b6f6',
});
