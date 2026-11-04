// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import type { Object3D } from 'three';
import { RVDrive, type IDriveBehavior } from './rv-drive';
import type { ComponentSchema, ComponentContext, RVComponent } from './rv-component-registry';
import { registerComponentSchema, loadSchemaFromSpec } from './rv-component-registry';
import { NodeRegistry } from './rv-node-registry';
import {
  createSignalWriter,
  type SignalStore,
  type SignalWriter,
} from './rv-signal-store';
import { debug } from './rv-debug';
import { scaleFeedbackPosition } from './rv-signal-wiring';
import { slotDeclare, slotUndeclare, slotWrite } from './rv-slot-io';

/**
 * RVDriveContinousDestination — TypeScript port of Drive_ContinousDestination.cs
 *
 * An "intelligent" positioning drive without a start bit: every CHANGE of the
 * destination value starts a move to it (C# compares `Destination` against the
 * previous tick's value and calls `Drive.DriveTo`). Speed and acceleration are
 * forwarded every tick. Mirrors Drive_ContinousDestination.FixedUpdate():
 *
 *   Destination  = SignalDestination * CurrentPositionScale + CurrentPositionOffset (when wired)
 *   TargetSpeed  = SignalTargetSpeed    (when wired)
 *   Acceleration = SignalAcceleration   (when wired)
 *   if (Destination != destinationBefore) Drive.DriveTo(Destination)
 *   feedback: IsAtPosition (scaled) / IsAtSpeed / IsAtDestination / IsDriving
 *
 * PLC IOs (Unity parity — same field names as Drive_ContinousDestination.cs):
 *   SignalDestination     — PLCOutput (PLC → drive): destination in mm
 *   SignalAcceleration    — PLCOutput (PLC → drive): acceleration in mm/s²
 *   SignalTargetSpeed     — PLCOutput (PLC → drive): max speed in mm/s
 *   SignalIsAtPosition    — PLCInput  (drive → PLC): current position in mm
 *   SignalIsAtSpeed       — PLCInput  (drive → PLC): current speed in mm/s
 *   SignalIsAtDestination — PLCInput  (drive → PLC): true at the destination
 *   SignalIsDriving       — PLCInput  (drive → PLC): true while moving
 *
 * The spelling "Continous" is the Unity class name and is kept for GLB parity.
 */
export class RVDriveContinousDestination implements IDriveBehavior, RVComponent {
  // Loaded from the rv-ODT specification (schema/v1/rv-odt.json, plan-187).
  static readonly schema: ComponentSchema = loadSchemaFromSpec('Drive_ContinousDestination');

  readonly node: Object3D;
  isOwner = true;

  // ComponentRef → resolved to SignalStore address strings (null when not wired).
  SignalDestination: string | null = null;
  SignalAcceleration: string | null = null;
  SignalTargetSpeed: string | null = null;
  SignalIsAtPosition: string | null = null;
  SignalIsAtSpeed: string | null = null;
  SignalIsAtDestination: string | null = null;
  SignalIsDriving: string | null = null;

  // Settings (PascalCase, parity with C#).
  Destination = 0;
  Acceleration = 100;
  TargetSpeed = 100;
  CurrentPositionScale = 1;
  CurrentPositionOffset = 0;
  ScaleFeedbackPosition = true;

  private drive: RVDrive | null = null;
  private signalStore: SignalStore | null = null;
  private signalWriter: SignalWriter | null = null;
  private destinationBefore = 0;

  constructor(node: Object3D) {
    this.node = node;
  }

  init(context: ComponentContext): void {
    const path = NodeRegistry.computeNodePath(this.node);

    const drive = context.registry.getByPath<RVDrive>('Drive', path);
    if (!drive) {
      console.warn(`[Drive_ContinousDestination] No Drive found at "${path}" — behavior inactive`);
      return;
    }
    this.drive = drive;
    this.signalStore = context.signalStore;
    this.signalWriter = createSignalWriter(
      context.signalStore,
      `component:Drive_ContinousDestination:${path}`,
      'component',
      { slotContext: path },
    );
    // C# starts with destinationbefore = 0, so an authored non-zero Destination
    // starts a move on the first tick — same here.
    this.destinationBefore = 0;

    // Register self as a drive behavior so drive.update() calls our update().
    drive.driveBehaviors.push(this);
    // Unwired slots stay bindable in the viewer (SlotIO, rv-slot-io.ts).
    // A direct command overrides the property; neutralize restores the authored value.
    const authoredDestination = this.Destination;
    const authoredTargetSpeed = this.TargetSpeed;
    const authoredAcceleration = this.Acceleration;
    slotDeclare(this, 'SignalDestination', 'setter', {
      apply: (value) => {
        this.Destination = Number(value) * this.CurrentPositionScale + this.CurrentPositionOffset;
      },
      neutral: () => { this.Destination = authoredDestination; },
      reapply: context.reapply,
    });
    slotDeclare(this, 'SignalTargetSpeed', 'setter', {
      apply: (value) => { this.TargetSpeed = Number(value); },
      neutral: () => { this.TargetSpeed = authoredTargetSpeed; },
      reapply: context.reapply,
    });
    slotDeclare(this, 'SignalAcceleration', 'setter', {
      apply: (value) => { this.Acceleration = Number(value); },
      neutral: () => { this.Acceleration = authoredAcceleration; },
      reapply: context.reapply,
    });
    slotDeclare(this, 'SignalIsAtPosition', 'feedback');
    slotDeclare(this, 'SignalIsAtSpeed', 'feedback');
    slotDeclare(this, 'SignalIsAtDestination', 'feedback', { initial: false });
    slotDeclare(this, 'SignalIsDriving', 'feedback', { initial: false });

    debug('loader',
      `  Drive_ContinousDestination "${drive.name}": ` +
      `destination="${this.SignalDestination}" speed="${this.SignalTargetSpeed}"`);
  }

  /** Called every fixed timestep from the drive's update(), before physics. */
  update(_dt: number): void {
    const drive = this.drive;
    const store = this.signalStore;
    if (!drive || !store) return;

    // ── Command (PLC → drive) ──
    if (this.SignalDestination) {
      this.Destination = store.getFloatByPath(this.SignalDestination) * this.CurrentPositionScale + this.CurrentPositionOffset;
    }
    if (this.SignalTargetSpeed) this.TargetSpeed = store.getFloatByPath(this.SignalTargetSpeed);
    if (this.SignalAcceleration) this.Acceleration = store.getFloatByPath(this.SignalAcceleration);

    if (!drive.positionOverwrite) {
      if (this.Destination !== this.destinationBefore) drive.startMove(this.Destination);
      drive.targetSpeed = this.TargetSpeed;
      drive.Acceleration = this.Acceleration;
      drive.UseAcceleration = true;
    }

    // ── Feedback (drive → PLC) — from the drive's previous-tick state, exactly
    //    like C# reads Drive.CurrentPosition inside its FixedUpdate. ──
    const writer = this.signalWriter;
    slotWrite(this, 'SignalIsAtPosition', this.SignalIsAtPosition, scaleFeedbackPosition(
      drive.currentPosition,
      this.ScaleFeedbackPosition,
      this.CurrentPositionScale,
      this.CurrentPositionOffset,
    ), writer);
    slotWrite(this, 'SignalIsAtDestination', this.SignalIsAtDestination, drive.isAtTarget, writer);
    slotWrite(this, 'SignalIsDriving', this.SignalIsDriving, drive.isRunning, writer);
    slotWrite(this, 'SignalIsAtSpeed', this.SignalIsAtSpeed, drive.currentSpeed, writer);

    this.destinationBefore = this.Destination;
  }

  dispose(): void {
    slotUndeclare(this);
    if (this.drive) {
      const index = this.drive.driveBehaviors.indexOf(this);
      if (index >= 0) this.drive.driveBehaviors.splice(index, 1);
    }
    this.drive = null;
    this.signalStore = null;
    this.signalWriter = null;
  }
}

// Register schema so rv-extras-validator auto-derives CONSUMED fields.
registerComponentSchema('Drive_ContinousDestination', RVDriveContinousDestination.schema, {
  bake: 'chunk', // sits on the Drive node it extends — moves with it (plan-753 §2.3)
  authorable: true, // addable in the asset editor on a node that carries a Drive
  ui: { badge: '#29b6f6' },
});
