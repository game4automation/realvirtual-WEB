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

/**
 * RVDriveSpeed — TypeScript port of Drive_Speed.cs
 *
 * A continuous "speed" drive: the PLC commands a signed target speed and the
 * drive jogs forward (speed > 0), backward (speed < 0) or stops (speed == 0).
 * Mirrors Drive_Speed.CalcFixedUpdate() exactly:
 *
 *   TargetSpeed  = SignalTargetSpeed   (when wired)
 *   Acceleration = SignalAcceleration  (when wired)
 *   Drive.TargetSpeed  = |TargetSpeed|
 *   jog             = sign(TargetSpeed)   (fwd / stop / bwd)
 *   Drive.Acceleration = Acceleration
 *   feedback: IsDriving / CurrentSpeed / CurrentPosition
 *
 * PLC IOs (Unity parity — same field names as Drive_Speed.cs):
 *   SignalTargetSpeed   — PLCOutput (PLC → drive): target speed in mm/s (signed)
 *   SignalAcceleration  — PLCOutput (PLC → drive): acceleration in mm/s²
 *   SignalCurrentSpeed  — PLCInput  (drive → PLC): current speed in mm/s
 *   SignalCurrentPosition — PLCInput (drive → PLC): current position in mm
 *   SignalIsDriving     — PLCInput  (drive → PLC): true while moving
 *
 * Implements IDriveBehavior — the command runs in update() (before physics, so
 * the jog block integrates the motion the same tick); feedback is written inline
 * from the drive's previous-tick currentSpeed/isRunning, exactly as C# reads
 * Drive.CurrentSpeed inside its single CalcFixedUpdate.
 */
export class RVDriveSpeed implements IDriveBehavior, RVComponent {
  // Loaded from the rv-ODT specification (schema/v1/rv-odt.json, plan-187).
  static readonly schema: ComponentSchema = loadSchemaFromSpec('Drive_Speed');

  readonly node: Object3D;
  isOwner = true;

  // ComponentRef → resolved to SignalStore address strings (null when not wired).
  SignalTargetSpeed: string | null = null;
  SignalAcceleration: string | null = null;
  SignalCurrentSpeed: string | null = null;
  SignalCurrentPosition: string | null = null;
  SignalIsDriving: string | null = null;

  // Settings (PascalCase, parity with C#).
  TargetSpeed = 100;
  Acceleration = 100;
  CurrentPositionScale = 1;
  CurrentPositionOffset = 0;
  ScaleFeedbackPosition = true;

  private drive: RVDrive | null = null;
  private signalStore: SignalStore | null = null;
  private signalWriter: SignalWriter | null = null;
  private authoredTargetSpeed = 100;
  private authoredAcceleration = 100;
  private feedbackCb: ((drive: RVDrive) => void) | null = null;
  private readonly feedbackListeners: (() => void)[] = [];

  constructor(node: Object3D) {
    this.node = node;
  }

  commandSignalTargetSpeed(value: boolean | number): void { this.TargetSpeed = Number(value); }
  commandSignalAcceleration(value: boolean | number): void { this.Acceleration = Number(value); }
  neutralizeSignalTargetSpeed(): void { this.TargetSpeed = this.authoredTargetSpeed; }
  neutralizeSignalAcceleration(): void { this.Acceleration = this.authoredAcceleration; }

  addFeedbackListener(cb: () => void): void {
    if (!this.feedbackListeners.includes(cb)) this.feedbackListeners.push(cb);
  }

  removeFeedbackListener(cb: () => void): void {
    const index = this.feedbackListeners.indexOf(cb);
    if (index >= 0) this.feedbackListeners.splice(index, 1);
  }

  readFeedbackSlot(slot: string): boolean | number {
    const drive = this.drive;
    if (!drive) return slot === 'SignalIsDriving' ? false : 0;
    if (slot === 'SignalCurrentSpeed') return drive.currentSpeed;
    if (slot === 'SignalCurrentPosition') {
      return scaleFeedbackPosition(
        drive.currentPosition,
        this.ScaleFeedbackPosition,
        this.CurrentPositionScale,
        this.CurrentPositionOffset,
      );
    }
    if (slot === 'SignalIsDriving') return drive.isRunning;
    throw new Error(`[Drive_Speed] Unknown feedback slot "${slot}"`);
  }

  init(context: ComponentContext): void {
    const path = NodeRegistry.computeNodePath(this.node);

    const drive = context.registry.getByPath<RVDrive>('Drive', path);
    if (!drive) {
      console.warn(`[Drive_Speed] No Drive found at "${path}" — behavior inactive`);
      return;
    }
    this.drive = drive;
    this.signalStore = context.signalStore;
    this.signalWriter = createSignalWriter(
      context.signalStore,
      `component:Drive_Speed:${path}`,
      'component',
      { slotContext: path },
    );
    this.authoredTargetSpeed = this.TargetSpeed;
    this.authoredAcceleration = this.Acceleration;

    // Register self as a drive behavior so drive.update() calls our update().
    drive.driveBehaviors.push(this);
    this.feedbackCb = () => {
      for (let i = 0; i < this.feedbackListeners.length; i++) this.feedbackListeners[i]();
    };
    drive.addAfterUpdate(this.feedbackCb);

    debug('loader',
      `  Drive_Speed "${drive.name}": ` +
      `targetSpeed="${this.SignalTargetSpeed}" accel="${this.SignalAcceleration}"`);
  }

  /** Called every fixed timestep from the drive's update(), before physics. */
  update(_dt: number): void {
    const drive = this.drive;
    const store = this.signalStore;
    if (!drive || !store) return;
    if (drive.positionOverwrite) return;

    // ── Command (PLC → drive) ──
    if (this.SignalTargetSpeed) this.TargetSpeed = store.getFloatByPath(this.SignalTargetSpeed);
    if (this.SignalAcceleration) this.Acceleration = store.getFloatByPath(this.SignalAcceleration);

    drive.targetSpeed = Math.abs(this.TargetSpeed);
    if (this.TargetSpeed > 0) {
      drive.jogForward = true;
      drive.jogBackward = false;
    } else if (this.TargetSpeed < 0) {
      drive.jogForward = false;
      drive.jogBackward = true;
    } else {
      drive.jogForward = false;
      drive.jogBackward = false;
    }
    drive.Acceleration = this.Acceleration;
    drive.UseAcceleration = true;

    // ── Feedback (drive → PLC) — from the drive's previous-tick state, exactly
    //    like C# reads Drive.CurrentSpeed inside CalcFixedUpdate. ──
    if (this.SignalIsDriving) this.signalWriter!.setByPath(this.SignalIsDriving, this.readFeedbackSlot('SignalIsDriving'));
    if (this.SignalCurrentSpeed) this.signalWriter!.setByPath(this.SignalCurrentSpeed, this.readFeedbackSlot('SignalCurrentSpeed'));
    if (this.SignalCurrentPosition) this.signalWriter!.setByPath(this.SignalCurrentPosition, this.readFeedbackSlot('SignalCurrentPosition'));
  }

  dispose(): void {
    if (this.drive) {
      const index = this.drive.driveBehaviors.indexOf(this);
      if (index >= 0) this.drive.driveBehaviors.splice(index, 1);
      if (this.feedbackCb) this.drive.removeAfterUpdate(this.feedbackCb);
    }
    this.feedbackCb = null;
    this.drive = null;
    this.signalStore = null;
    this.signalWriter = null;
    this.feedbackListeners.length = 0;
  }
}

// Register schema so rv-extras-validator auto-derives CONSUMED fields.
registerComponentSchema('Drive_Speed', RVDriveSpeed.schema, {
  badgeColor: '#29b6f6',
});
