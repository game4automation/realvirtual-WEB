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
import { slotDeclare, slotUndeclare, slotWrite } from './rv-slot-io';

/**
 * RVDriveProportionalValve — TypeScript port of Drive_ProportionalValve.cs
 *
 * A hydraulic (or electric) proportional directional valve in front of a Drive.
 * The analog setpoint the PLC sends through a valve amplifier (±10 V, 4–20 mA,
 * 0–100 %) is turned into a signed drive speed through the stages that make a
 * real proportional valve differ from an ideal speed setpoint. Mirrors
 * Drive_ProportionalValve.CalcFixedUpdate() stage by stage:
 *
 *   1. scale:      command = clamp((Setpoint − SetpointZero) / (SetpointFull − SetpointZero), −1, 1)
 *   2. dead band:  |command| ≤ Deadband → 0, else rescaled so flow starts smoothly above it
 *   3. hysteresis: the held command only follows when the change ≥ Hysteresis
 *   4. spool:      SpoolPosition moves toward the held command by dt / ResponseTime per tick
 *   5. flow:       Flow = sign(spool) · |spool| ^ FlowExponent
 *   6. drive:      TargetSpeed = |Flow| · MaxSpeed, jog direction = sign(Flow)
 *
 * Stage 5 is the one deviation from C#: Unity evaluates an `AnimationCurve`
 * (`FlowCurve`), which the GLB exporter cannot carry. `FlowExponent` reproduces
 * the two shapes the curve is used for — 1 = linear (the Unity default curve),
 * > 1 = progressive.
 *
 * PLC IOs (Unity parity — same field names as Drive_ProportionalValve.cs):
 *   SignalSetpoint        — PLCOutput (PLC → drive): raw analog setpoint
 *   SignalSpoolPosition   — PLCInput  (drive → PLC): spool position −1..1
 *   SignalCurrentSpeed    — PLCInput  (drive → PLC): current speed in mm/s
 *   SignalCurrentPosition — PLCInput  (drive → PLC): current position in mm
 */
export class RVDriveProportionalValve implements IDriveBehavior, RVComponent {
  // Loaded from the rv-ODT specification (schema/v1/rv-odt.json, plan-187).
  static readonly schema: ComponentSchema = loadSchemaFromSpec('Drive_ProportionalValve');

  readonly node: Object3D;
  isOwner = true;

  // ComponentRef → resolved to SignalStore address strings (null when not wired).
  SignalSetpoint: string | null = null;
  SignalSpoolPosition: string | null = null;
  SignalCurrentSpeed: string | null = null;
  SignalCurrentPosition: string | null = null;

  // Settings (PascalCase, parity with C#).
  Setpoint = 0;
  SetpointZero = 0;
  SetpointFull = 10;
  Deadband = 0.05;
  EnableHysteresis = false;
  Hysteresis = 0.02;
  FlowExponent = 1;
  ResponseTime = 0.1;
  MaxSpeed = 100;
  Acceleration = 1000;

  /** Normalized command after scaling and dead band (−1..1) — runtime only. */
  Command = 0;
  /** Actual spool position after hysteresis and dynamics (−1..1) — runtime only. */
  SpoolPosition = 0;
  /** Resulting normalized flow after the characteristic (−1..1) — runtime only. */
  Flow = 0;

  private drive: RVDrive | null = null;
  private signalStore: SignalStore | null = null;
  private signalWriter: SignalWriter | null = null;
  private heldCommand = 0;
  private authoredSetpoint = 0;

  constructor(node: Object3D) {
    this.node = node;
  }

  init(context: ComponentContext): void {
    const path = NodeRegistry.computeNodePath(this.node);

    const drive = context.registry.getByPath<RVDrive>('Drive', path);
    if (!drive) {
      console.warn(`[Drive_ProportionalValve] No Drive found at "${path}" — behavior inactive`);
      return;
    }
    this.drive = drive;
    this.signalStore = context.signalStore;
    this.signalWriter = createSignalWriter(
      context.signalStore,
      `component:Drive_ProportionalValve:${path}`,
      'component',
      { slotContext: path },
    );
    this.SpoolPosition = 0;
    this.heldCommand = 0;

    // Register self as a drive behavior so drive.update() calls our update().
    drive.driveBehaviors.push(this);
    // Unwired slots stay bindable in the viewer (SlotIO, rv-slot-io.ts).
    // A direct setpoint overrides Setpoint; neutralize restores the authored one.
    this.authoredSetpoint = this.Setpoint;
    slotDeclare(this, 'SignalSetpoint', 'setter', {
      apply: (value) => { this.Setpoint = Number(value); },
      neutral: () => { this.Setpoint = this.authoredSetpoint; },
      reapply: context.reapply,
    });
    slotDeclare(this, 'SignalSpoolPosition', 'feedback');
    slotDeclare(this, 'SignalCurrentSpeed', 'feedback');
    slotDeclare(this, 'SignalCurrentPosition', 'feedback');

    debug('loader',
      `  Drive_ProportionalValve "${drive.name}": setpoint="${this.SignalSetpoint}" maxSpeed=${this.MaxSpeed}`);
  }

  /** Called every fixed timestep from the drive's update(), before physics. */
  update(dt: number): void {
    const drive = this.drive;
    const store = this.signalStore;
    if (!drive || !store) return;

    // ── 1. Read and scale the analog setpoint ──
    if (this.SignalSetpoint) this.Setpoint = store.getFloatByPath(this.SignalSetpoint);
    const span = this.SetpointFull - this.SetpointZero;
    let command = Math.abs(span) < 1e-6 ? 0 : (this.Setpoint - this.SetpointZero) / span;
    command = Math.max(-1, Math.min(1, command));

    // ── 2. Dead band (spool overlap), rescaled so flow starts smoothly above it ──
    const sign = Math.sign(command);
    let magnitude = Math.abs(command);
    magnitude = magnitude <= this.Deadband ? 0 : (magnitude - this.Deadband) / (1 - this.Deadband);
    command = sign * magnitude;
    this.Command = command;

    // ── 3. Hysteresis — hold the previous command until the change exceeds the band ──
    if (!this.EnableHysteresis || Math.abs(command - this.heldCommand) >= this.Hysteresis) {
      this.heldCommand = command;
    }

    // ── 4. Spool dynamics — full stroke (1.0) takes ResponseTime seconds ──
    if (this.ResponseTime > 0) {
      const maxStep = dt / this.ResponseTime;
      const delta = this.heldCommand - this.SpoolPosition;
      this.SpoolPosition = Math.abs(delta) <= maxStep ? this.heldCommand : this.SpoolPosition + Math.sign(delta) * maxStep;
    } else {
      this.SpoolPosition = this.heldCommand;
    }

    // ── 5. Flow characteristic (sign preserved, evaluated on |spool|) ──
    const flowSign = Math.sign(this.SpoolPosition);
    this.Flow = flowSign * Math.pow(Math.abs(this.SpoolPosition), this.FlowExponent > 0 ? this.FlowExponent : 1);

    // ── 6. Flow → drive speed and direction ──
    if (!drive.positionOverwrite) {
      drive.Acceleration = this.Acceleration;
      drive.UseAcceleration = true;
      drive.targetSpeed = Math.abs(this.Flow) * this.MaxSpeed;
      drive.jogForward = this.Flow > 0;
      drive.jogBackward = this.Flow < 0;
    }

    // ── Feedback (drive → PLC) — previous-tick drive state, like C# ──
    const writer = this.signalWriter;
    slotWrite(this, 'SignalSpoolPosition', this.SignalSpoolPosition, this.SpoolPosition, writer);
    slotWrite(this, 'SignalCurrentSpeed', this.SignalCurrentSpeed, drive.currentSpeed, writer);
    slotWrite(this, 'SignalCurrentPosition', this.SignalCurrentPosition, drive.currentPosition, writer);
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
registerComponentSchema('Drive_ProportionalValve', RVDriveProportionalValve.schema, {
  bake: 'chunk', // sits on the Drive node it extends — moves with it (plan-753 §2.3)
  authorable: true, // addable in the asset editor on a node that carries a Drive
  ui: { badge: '#29b6f6' },
});
