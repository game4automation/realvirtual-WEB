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
import { slotBound, slotDeclare, slotRead, slotReadBool, slotUndeclare, slotWrite } from './rv-slot-io';

/** PLCOutputBool slots of Drive_UniDriveMotor (PLC → drive). */
const BOOL_COMMAND_SLOTS = ['Run', 'JogPlus', 'JogMinus', 'StartCalibration', 'SpeedSelection', 'StartPositioning', 'ResetFault'] as const;
type BoolCommandSlot = typeof BOOL_COMMAND_SLOTS[number];
/** PLCOutputInt slots of Drive_UniDriveMotor (PLC → drive). */
const INT_COMMAND_SLOTS = ['SetPosition', 'SetSpeed', 'SetAcceleration', 'SetDeceleration'] as const;
type IntCommandSlot = typeof INT_COMMAND_SLOTS[number];

/**
 * RVDriveUniDriveMotor — TypeScript port of Drive_UniDriveMotor.cs
 *
 * A UniDrive-style positioning controller: a general release (`Run`) gates all
 * motion, `StartPositioning` moves to integer setpoints (position, speed,
 * acceleration ramp) and `JogPlus` / `JogMinus` jog with the setup speed or the
 * commanded speed. Ready, referenced, in-position and integer actual position /
 * speed are written back. Mirrors Drive_UniDriveMotor.CalcFixedUpdate():
 *
 *   ramps:  Acceleration = SetAcceleration · AccelerationScale (only when > 0)
 *   !Run:   Drive.Stop()  (held at the current position)
 *   jog:    TargetSpeed = SpeedSelection ? SetSpeed · SpeedScale : SetupSpeed; forward wins
 *   pos:    TargetSpeed = SetSpeed · SpeedScale, TargetPosition = SetPosition · PositionScale + PositionOffset,
 *           rising edge of StartPositioning starts the move
 *   feedback: IsReady, IsReferenced, IsAtPosition1 (= at target and not jogging),
 *             ActualPosition = round((pos − PositionOffset) / PositionScale),
 *             ActualSpeed = round(speed / SpeedScale)
 *
 * Note on ramps: the drive brakes with the same (acceleration) ramp;
 * `SetDeceleration` is read into `CurrentDeceleration` for transparency only.
 *
 * PLC IOs (Unity parity — same field names as Drive_UniDriveMotor.cs):
 *   Run, JogPlus, JogMinus, StartCalibration, SpeedSelection, StartPositioning,
 *   ResetFault                                  — PLCOutputBool (PLC → drive)
 *   SetPosition, SetSpeed, SetAcceleration, SetDeceleration — PLCOutputInt (PLC → drive)
 *   IsReady, IsReferenced, IsAtPosition1        — PLCInputBool (drive → PLC)
 *   ActualPosition, ActualSpeed                 — PLCInputInt  (drive → PLC)
 */
export class RVDriveUniDriveMotor implements IDriveBehavior, RVComponent {
  // Loaded from the rv-ODT specification (schema/v1/rv-odt.json, plan-187).
  static readonly schema: ComponentSchema = loadSchemaFromSpec('Drive_UniDriveMotor');

  readonly node: Object3D;
  isOwner = true;

  // ComponentRef → resolved to SignalStore address strings (null when not wired).
  Run: string | null = null;
  JogPlus: string | null = null;
  JogMinus: string | null = null;
  StartCalibration: string | null = null;
  SpeedSelection: string | null = null;
  StartPositioning: string | null = null;
  ResetFault: string | null = null;
  SetPosition: string | null = null;
  SetSpeed: string | null = null;
  SetAcceleration: string | null = null;
  SetDeceleration: string | null = null;
  IsReady: string | null = null;
  IsReferenced: string | null = null;
  IsAtPosition1: string | null = null;
  ActualPosition: string | null = null;
  ActualSpeed: string | null = null;

  // Settings (PascalCase, parity with C#).
  PositionScale = 1;
  PositionOffset = 0;
  SpeedScale = 1;
  AccelerationScale = 1;
  SetupSpeed = 50;
  Ready = true;
  Referenced = true;

  /** Last received deceleration ramp in drive units — informational, runtime only. */
  CurrentDeceleration = 0;

  private drive: RVDrive | null = null;
  private signalStore: SignalStore | null = null;
  private signalWriter: SignalWriter | null = null;
  private prevStart = false;

  constructor(node: Object3D) {
    this.node = node;
  }

  init(context: ComponentContext): void {
    const path = NodeRegistry.computeNodePath(this.node);

    const drive = context.registry.getByPath<RVDrive>('Drive', path);
    if (!drive) {
      console.warn(`[Drive_UniDriveMotor] No Drive found at "${path}" — behavior inactive`);
      return;
    }
    this.drive = drive;
    this.signalStore = context.signalStore;
    this.signalWriter = createSignalWriter(
      context.signalStore,
      `component:Drive_UniDriveMotor:${path}`,
      'component',
      { slotContext: path },
    );
    this.prevStart = false;

    // Register self as a drive behavior so drive.update() calls our update().
    drive.driveBehaviors.push(this);
    // Unwired slots stay bindable in the viewer (SlotIO, rv-slot-io.ts).
    for (const slot of BOOL_COMMAND_SLOTS) slotDeclare(this, slot, 'poll');
    for (const slot of INT_COMMAND_SLOTS) slotDeclare(this, slot, 'poll');
    slotDeclare(this, 'IsReady', 'feedback', { initial: false });
    slotDeclare(this, 'IsReferenced', 'feedback', { initial: false });
    slotDeclare(this, 'IsAtPosition1', 'feedback', { initial: false });
    slotDeclare(this, 'ActualPosition', 'feedback');
    slotDeclare(this, 'ActualSpeed', 'feedback');

    debug('loader',
      `  Drive_UniDriveMotor "${drive.name}": run="${this.Run}" start="${this.StartPositioning}" setPos="${this.SetPosition}"`);
  }

  /** A bool command slot: the wired signal, else the direct value, else `fallback` (the unbound default). */
  private readBool(slot: BoolCommandSlot, fallback: boolean): boolean {
    return slotReadBool(this.signalStore!, this, slot, this[slot], fallback);
  }

  /** An int command slot: the wired signal, else the direct value, else 0. */
  private readInt(slot: IntCommandSlot): number {
    return Math.round(slotRead(this.signalStore!, this, slot, this[slot], 0));
  }

  /** True when an int command slot carries a value (wired or bound directly). */
  private bound(slot: IntCommandSlot): boolean {
    return slotBound(this, slot, this[slot]);
  }

  /** Called every fixed timestep from the drive's update(), before physics. */
  update(_dt: number): void {
    const drive = this.drive;
    const store = this.signalStore;
    if (!drive || !store) return;

    const commands = !drive.positionOverwrite;

    // ── Ramps (always forwarded so the drive uses the current setpoints) ──
    if (this.bound('SetAcceleration')) {
      // Only a valid ramp: the drive divides by Acceleration, so a 0 from the
      // PLC (e.g. before initialization) would produce Infinity/NaN.
      const accel = this.readInt('SetAcceleration') * this.AccelerationScale;
      if (accel > 0 && commands) {
        drive.Acceleration = accel;
        drive.UseAcceleration = true;
      }
    }
    if (this.bound('SetDeceleration')) this.CurrentDeceleration = this.readInt('SetDeceleration') * this.AccelerationScale;

    // ── Motion command ──
    const run = this.readBool('Run', true);
    let jogging = false;
    const start = this.readBool('StartPositioning', false);
    const startRising = start && !this.prevStart;
    this.prevStart = start;

    if (!run) {
      // Release not set: stop and hold at the current position. stop() also
      // clears the jog bits, so the drive cleanly recovers once Run goes high.
      if (commands) drive.stop();
    } else {
      const jogFwd = this.readBool('JogPlus', false);
      const jogBwd = this.readBool('JogMinus', false);
      jogging = jogFwd || jogBwd;

      if (jogging) {
        // Manual jog — forward has priority if both bits are set.
        const manualSpeed = this.readBool('SpeedSelection', true);
        if (commands) {
          if (manualSpeed) {
            if (this.bound('SetSpeed')) drive.targetSpeed = this.readInt('SetSpeed') * this.SpeedScale;
          } else {
            drive.targetSpeed = this.SetupSpeed;
          }
          drive.jogForward = jogFwd;
          drive.jogBackward = jogFwd ? false : jogBwd;
        }
      } else if (commands) {
        // Positioning — the rising edge of StartPositioning starts the move.
        drive.jogForward = false;
        drive.jogBackward = false;
        if (this.bound('SetSpeed')) drive.targetSpeed = this.readInt('SetSpeed') * this.SpeedScale;
        if (this.bound('SetPosition')) drive.targetPosition = this.readInt('SetPosition') * this.PositionScale + this.PositionOffset;
        if (startRising) drive.startMove();
      }
    }

    // ── Feedback (drive → PLC) — previous-tick drive state, like C# ──
    const writer = this.signalWriter;
    slotWrite(this, 'IsReady', this.IsReady, this.Ready, writer);
    slotWrite(this, 'IsReferenced', this.IsReferenced, this.Referenced, writer);
    // "Position 1 reached" only while not jogging away from the commanded target.
    slotWrite(this, 'IsAtPosition1', this.IsAtPosition1, drive.isAtTarget && !jogging, writer);
    slotWrite(this, 'ActualPosition', this.ActualPosition, this.PositionScale !== 0
      ? Math.round((drive.currentPosition - this.PositionOffset) / this.PositionScale)
      : 0, writer);
    slotWrite(this, 'ActualSpeed', this.ActualSpeed, this.SpeedScale !== 0
      ? Math.round(drive.currentSpeed / this.SpeedScale)
      : 0, writer);
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
registerComponentSchema('Drive_UniDriveMotor', RVDriveUniDriveMotor.schema, {
  bake: 'chunk', // sits on the Drive node it extends — moves with it (plan-753 §2.3)
  authorable: true, // addable in the asset editor on a node that carries a Drive
  ui: { badge: '#29b6f6' },
});
