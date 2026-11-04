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
import { slotDeclare, slotRead, slotUndeclare, slotWrite } from './rv-slot-io';

/** True when bit `n` of `word` is set. */
function bit(word: number, n: number): boolean {
  return (word & (1 << n)) !== 0;
}

/** PROFIdrive state machine state (C# `Drive_ProfidriveSpeed.ProfidriveState`). */
export type ProfidriveState =
  | 'SwitchingOnInhibited'
  | 'ReadyForSwitchingOn'
  | 'ReadyToOperate'
  | 'Operation'
  | 'Fault';

/**
 * RVDriveProfidriveSpeed — TypeScript port of Drive_ProfidriveSpeed.cs
 *
 * A PROFIdrive speed-controlled drive (SINAMICS G120 / S120 / V90, …) on
 * standard telegram 1. The PLC writes control word STW1 and the normalized
 * speed setpoint NSOLL_A; the drive runs the PROFIdrive state machine
 * (switching-on inhibited → ready for switching on → ready to operate →
 * operation) and only moves once the PLC has correctly enabled it. Status word
 * ZSW1 and the actual speed NIST_A go back. Mirrors
 * Drive_ProfidriveSpeed.CalcFixedUpdate() including the OFF2 / OFF3 priority,
 * the sticky fault that is only left on a RISING edge of STW1.7, and the
 * setpoint gate (STW1.6 enable setpoint + STW1.4/5 ramp generator bits).
 *
 * Normalization: NSOLL_A = SetpointScale (16384 = 0x4000 for PROFIdrive,
 * 20000 for the ABB Drives profile) is 100 % of ReferenceSpeed; negative
 * values reverse, STW1.11 inverts the setpoint. NIST_A uses the same scale.
 *
 * PLC IOs (Unity parity — same field names as Drive_ProfidriveSpeed.cs):
 *   ControlWord   — PLCOutput (PLC → drive): STW1
 *   SpeedSetpoint — PLCOutput (PLC → drive): NSOLL_A
 *   StatusWord    — PLCInput  (drive → PLC): ZSW1
 *   SpeedActual   — PLCInput  (drive → PLC): NIST_A
 */
export class RVDriveProfidriveSpeed implements IDriveBehavior, RVComponent {
  // Loaded from the rv-ODT specification (schema/v1/rv-odt.json, plan-187).
  static readonly schema: ComponentSchema = loadSchemaFromSpec('Drive_ProfidriveSpeed');

  readonly node: Object3D;
  isOwner = true;

  // ComponentRef → resolved to SignalStore address strings (null when not wired).
  ControlWord: string | null = null;
  SpeedSetpoint: string | null = null;
  StatusWord: string | null = null;
  SpeedActual: string | null = null;

  // Settings (PascalCase, parity with C#).
  ReferenceSpeed = 100;
  SetpointScale = 16384;
  Acceleration = 1000;
  SimulateFault = false;
  SimulateWarning = false;

  /** Current PROFIdrive state — runtime only, never part of the schema. */
  State: ProfidriveState = 'SwitchingOnInhibited';
  /** Last status word ZSW1 written to the PLC — runtime only. */
  ZSW1 = 0;

  private drive: RVDrive | null = null;
  private signalStore: SignalStore | null = null;
  private signalWriter: SignalWriter | null = null;
  private oldAcknowledge = false;

  constructor(node: Object3D) {
    this.node = node;
  }

  init(context: ComponentContext): void {
    const path = NodeRegistry.computeNodePath(this.node);

    const drive = context.registry.getByPath<RVDrive>('Drive', path);
    if (!drive) {
      console.warn(`[Drive_ProfidriveSpeed] No Drive found at "${path}" — behavior inactive`);
      return;
    }
    this.drive = drive;
    this.signalStore = context.signalStore;
    this.signalWriter = createSignalWriter(
      context.signalStore,
      `component:Drive_ProfidriveSpeed:${path}`,
      'component',
      { slotContext: path },
    );
    this.State = 'SwitchingOnInhibited';
    this.oldAcknowledge = false;

    // Register self as a drive behavior so drive.update() calls our update().
    drive.driveBehaviors.push(this);
    // Unwired slots stay bindable in the viewer (SlotIO, rv-slot-io.ts).
    slotDeclare(this, 'ControlWord', 'poll');
    slotDeclare(this, 'SpeedSetpoint', 'poll');
    slotDeclare(this, 'StatusWord', 'feedback');
    slotDeclare(this, 'SpeedActual', 'feedback');

    debug('loader',
      `  Drive_ProfidriveSpeed "${drive.name}": stw1="${this.ControlWord}" nsoll="${this.SpeedSetpoint}"`);
  }

  /** Called every fixed timestep from the drive's update(), before physics. */
  update(_dt: number): void {
    const drive = this.drive;
    const store = this.signalStore;
    if (!drive || !store) return;

    // ── Decode control word STW1 (PLC → drive) ──
    const stw1 = Math.round(slotRead(store, this, 'ControlWord', this.ControlWord, 0));
    const onOff1 = bit(stw1, 0);
    const noOff2 = bit(stw1, 1);
    const noOff3 = bit(stw1, 2);
    const enableOperation = bit(stw1, 3);
    const enableRampGen = bit(stw1, 4);
    const continueRampGen = bit(stw1, 5);
    const enableSetpoint = bit(stw1, 6);
    const acknowledgeFault = bit(stw1, 7);
    const controlByPlc = bit(stw1, 10);
    const invertSetpoint = bit(stw1, 11);

    const ackRising = acknowledgeFault && !this.oldAcknowledge;
    this.oldAcknowledge = acknowledgeFault;

    // While a playback authority owns the transform, the state machine still
    // runs (so the status word stays truthful) but must not command the drive.
    const commands = !drive.positionOverwrite;
    if (commands) {
      drive.Acceleration = this.Acceleration;
      drive.UseAcceleration = true;
    }

    // ── PROFIdrive state machine ──
    let allowMotion = false;

    if (this.SimulateFault) this.State = 'Fault';

    if (this.State === 'Fault') {
      if (commands) drive.stop();
      if (!this.SimulateFault && ackRising) this.State = 'SwitchingOnInhibited';
    } else if (!noOff2) {
      // OFF2: immediate pulse suppression (coast to stop)
      if (commands) drive.stop();
      this.State = 'SwitchingOnInhibited';
    } else if (!noOff3) {
      // OFF3: quick stop along the braking ramp, then switching-on inhibited
      if (commands) { drive.jogForward = false; drive.jogBackward = false; }
      if (Math.abs(drive.currentSpeed) < 0.01) this.State = 'SwitchingOnInhibited';
    } else {
      switch (this.State) {
        case 'SwitchingOnInhibited':
          // The inhibit is cleared only when OFF1 is low (ON = 0) with OFF2/OFF3 released
          if (!onOff1) this.State = 'ReadyForSwitchingOn';
          break;
        case 'ReadyForSwitchingOn':
          if (onOff1) this.State = 'ReadyToOperate';
          break;
        case 'ReadyToOperate':
          if (!onOff1) this.State = 'ReadyForSwitchingOn';
          else if (enableOperation) this.State = 'Operation';
          break;
        case 'Operation':
          if (!onOff1) this.State = 'ReadyForSwitchingOn'; // OFF1: ramp down to standstill
          else if (!enableOperation) this.State = 'ReadyToOperate';
          else allowMotion = true;
          break;
      }
      if (!allowMotion && commands) {
        // OFF1 / not enabled: ramp down to zero with the acceleration ramp
        drive.jogForward = false;
        drive.jogBackward = false;
      }
    }

    // ── Apply the speed setpoint while in operation ──
    if (allowMotion && enableSetpoint && enableRampGen && continueRampGen) {
      const nsoll = Math.round(slotRead(store, this, 'SpeedSetpoint', this.SpeedSetpoint, 0));
      let target = (this.SetpointScale !== 0 ? nsoll / this.SetpointScale : 0) * this.ReferenceSpeed;
      if (invertSetpoint) target = -target;
      if (commands) {
        drive.targetSpeed = Math.abs(target);
        drive.jogForward = target > 0;
        drive.jogBackward = target < 0;
      }
    } else if (allowMotion && commands) {
      // In operation but setpoint not enabled: hold at zero speed
      drive.jogForward = false;
      drive.jogBackward = false;
    }

    // ── Evaluate and build status word ZSW1 ──
    const readyToSwitchOn = this.State !== 'Fault' && this.State !== 'SwitchingOnInhibited';
    const readyToOperate = this.State === 'ReadyToOperate' || this.State === 'Operation';
    const operationEnabled = this.State === 'Operation';
    const faultPresent = this.State === 'Fault';
    const switchOnInhibited = this.State === 'SwitchingOnInhibited';
    // setpoint speed reached (within ~2 % of reference speed) while in operation
    const setpointSpeedReached = operationEnabled &&
      Math.abs(Math.abs(drive.currentSpeed) - drive.targetSpeed) < 0.02 * this.ReferenceSpeed;

    let zsw1 = 0;
    if (readyToSwitchOn) zsw1 |= 1 << 0;       // ZSW1.0 ready to switch on
    if (readyToOperate) zsw1 |= 1 << 1;        // ZSW1.1 ready to operate
    if (operationEnabled) zsw1 |= 1 << 2;      // ZSW1.2 operation enabled
    if (faultPresent) zsw1 |= 1 << 3;          // ZSW1.3 fault present
    if (noOff2) zsw1 |= 1 << 4;                // ZSW1.4 no OFF2 active
    if (noOff3) zsw1 |= 1 << 5;                // ZSW1.5 no OFF3 active
    if (switchOnInhibited) zsw1 |= 1 << 6;     // ZSW1.6 switching-on inhibited
    if (this.SimulateWarning) zsw1 |= 1 << 7;  // ZSW1.7 warning present
    if (controlByPlc) zsw1 |= 1 << 9;          // ZSW1.9 control requested / granted
    if (setpointSpeedReached) zsw1 |= 1 << 10; // ZSW1.10 setpoint speed reached
    this.ZSW1 = zsw1;

    // ── Feedback (drive → PLC) — ALWAYS ──
    const writer = this.signalWriter;
    slotWrite(this, 'StatusWord', this.StatusWord, zsw1, writer);
    slotWrite(this, 'SpeedActual', this.SpeedActual, this.ReferenceSpeed !== 0
      ? Math.round(drive.currentSpeed / this.ReferenceSpeed * this.SetpointScale)
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
registerComponentSchema('Drive_ProfidriveSpeed', RVDriveProfidriveSpeed.schema, {
  bake: 'chunk', // sits on the Drive node it extends — moves with it (plan-753 §2.3)
  authorable: true, // addable in the asset editor on a node that carries a Drive
  ui: { badge: '#29b6f6' },
});
