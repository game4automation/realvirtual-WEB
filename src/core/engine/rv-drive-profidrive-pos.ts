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
import type { ProfidriveState } from './rv-drive-profidrive-speed';

/** True when bit `n` of `word` is set. */
function bit(word: number, n: number): boolean {
  return (word & (1 << n)) !== 0;
}

/** Clamp to the signed 32-bit range (C# casts the NIST_B long to int). */
function toInt32(v: number): number {
  if (v > 2147483647) return 2147483647;
  if (v < -2147483648) return -2147483648;
  return Math.trunc(v);
}

/**
 * RVDriveProfidrivePos — TypeScript port of Drive_ProfidrivePos.cs
 *
 * A PROFIdrive positioning drive (SINAMICS EPOS) on telegram 111. The PLC
 * writes STW1, POS_STW1, POS_STW2, OVERRIDE, MDI_TARPOS and MDI_VELOCITY; the
 * drive runs the same PROFIdrive state machine as the speed variant and, in
 * operation, the EPOS command cascade of Drive_ProfidrivePos.CalcFixedUpdate():
 *
 *   !STW1.4 (reject task)      → brake, discard the task
 *   !STW1.5 (intermediate stop)→ brake, keep the task
 *   POS_STW2.1 rising          → reference point set
 *   STW1.11 (homing)           → referenced (simplified)
 *   STW1.8 / STW1.9 (jog)      → jog at JogSpeed, jog 1 = positive wins
 *   MDI mode (POS_STW1.15):
 *     setup (POS_STW1.14)      → endless travel at MDI velocity in the selected direction
 *     STW1.6 rising or POS_STW1.12 (continuous) → DriveTo(MDI_TARPOS), absolute or relative
 *
 * Speeds: MDI_VELOCITY · VelocityScale · OVERRIDE / 0x4000. Feedback: ZSW1
 * (with standstill / accelerating / decelerating bits), POS_ZSW1 (mirrors
 * ZSW1), POS_ZSW2 (traverses forwards / backwards, command active), XIST_A
 * and NIST_B (0x40000000 = 100 % of ReferenceSpeed).
 *
 * PLC IOs (Unity parity — same field names as Drive_ProfidrivePos.cs):
 *   ControlWord, PosControlWord1, PosControlWord2, Override, MdiTargetPosition,
 *   MdiVelocity                                        — PLCOutputInt (PLC → drive)
 *   StatusWord, PosStatusWord1, PosStatusWord2, PositionActual, SpeedActual
 *                                                      — PLCInputInt  (drive → PLC)
 */
export class RVDriveProfidrivePos implements IDriveBehavior, RVComponent {
  // Loaded from the rv-ODT specification (schema/v1/rv-odt.json, plan-187).
  static readonly schema: ComponentSchema = loadSchemaFromSpec('Drive_ProfidrivePos');

  readonly node: Object3D;
  isOwner = true;

  // ComponentRef → resolved to SignalStore address strings (null when not wired).
  ControlWord: string | null = null;
  PosControlWord1: string | null = null;
  PosControlWord2: string | null = null;
  Override: string | null = null;
  MdiTargetPosition: string | null = null;
  MdiVelocity: string | null = null;
  StatusWord: string | null = null;
  PosStatusWord1: string | null = null;
  PosStatusWord2: string | null = null;
  PositionActual: string | null = null;
  SpeedActual: string | null = null;

  // Settings (PascalCase, parity with C#).
  PositionScale = 1;
  PositionOffset = 0;
  VelocityScale = 1;
  ReferenceSpeed = 100;
  JogSpeed = 50;
  Acceleration = 1000;
  SimulateFault = false;
  SimulateWarning = false;

  /** Current PROFIdrive state — runtime only, never part of the schema. */
  State: ProfidriveState = 'SwitchingOnInhibited';
  /** Last status word ZSW1 written to the PLC — runtime only. */
  ZSW1 = 0;
  /** Last POS_ZSW2 written to the PLC — runtime only. */
  POS_ZSW2 = 0;
  /** ZSW1.11 — set by homing or "set reference point"; runtime only. */
  ReferencePointSet = false;

  private drive: RVDrive | null = null;
  private signalStore: SignalStore | null = null;
  private signalWriter: SignalWriter | null = null;
  private oldActivate = false;
  private oldAck = false;
  private oldSetRef = false;
  private oldSpeed = 0;

  constructor(node: Object3D) {
    this.node = node;
  }

  init(context: ComponentContext): void {
    const path = NodeRegistry.computeNodePath(this.node);

    const drive = context.registry.getByPath<RVDrive>('Drive', path);
    if (!drive) {
      console.warn(`[Drive_ProfidrivePos] No Drive found at "${path}" — behavior inactive`);
      return;
    }
    this.drive = drive;
    this.signalStore = context.signalStore;
    this.signalWriter = createSignalWriter(
      context.signalStore,
      `component:Drive_ProfidrivePos:${path}`,
      'component',
      { slotContext: path },
    );
    this.State = 'SwitchingOnInhibited';
    this.ReferencePointSet = false;
    this.oldActivate = false;
    this.oldAck = false;
    this.oldSetRef = false;
    this.oldSpeed = 0;

    // Register self as a drive behavior so drive.update() calls our update().
    drive.driveBehaviors.push(this);

    debug('loader',
      `  Drive_ProfidrivePos "${drive.name}": stw1="${this.ControlWord}" tarpos="${this.MdiTargetPosition}"`);
  }

  private readInt(address: string | null): number {
    return address ? Math.round(this.signalStore!.getFloatByPath(address)) : 0;
  }

  /** MDI speed in drive units: |MDI_VELOCITY| · VelocityScale · override (falls back to the drive's target speed when unwired). */
  private speedFromMdi(drive: RVDrive, over: number): number {
    const base = this.MdiVelocity ? Math.abs(this.readInt(this.MdiVelocity)) * this.VelocityScale : drive.targetSpeed;
    return base * over;
  }

  /** Called every fixed timestep from the drive's update(), before physics. */
  update(_dt: number): void {
    const drive = this.drive;
    const store = this.signalStore;
    if (!drive || !store) return;

    // ── Decode control words (PLC → drive) ──
    const stw1 = this.readInt(this.ControlWord);
    const posStw1 = this.readInt(this.PosControlWord1);
    const posStw2 = this.readInt(this.PosControlWord2);

    const onOff1 = bit(stw1, 0);
    const noOff2 = bit(stw1, 1);
    const noOff3 = bit(stw1, 2);
    const enableOperation = bit(stw1, 3);
    const doNotRejectTask = bit(stw1, 4);
    const noIntermediateStop = bit(stw1, 5);
    const activateTraversing = bit(stw1, 6);
    const acknowledgeFault = bit(stw1, 7);
    const jog1 = bit(stw1, 8);
    const jog2 = bit(stw1, 9);
    const controlByPlc = bit(stw1, 10);
    const startHoming = bit(stw1, 11);

    const mdiAbsolute = bit(posStw1, 8);
    const mdiDirectionPos = bit(posStw1, 9);
    const mdiDirectionNeg = bit(posStw1, 10);
    const mdiContinuous = bit(posStw1, 12);
    const mdiSetup = bit(posStw1, 14);
    const mdiMode = bit(posStw1, 15);

    const setReferencePoint = bit(posStw2, 1);

    const activateRising = activateTraversing && !this.oldActivate;
    this.oldActivate = activateTraversing;
    const ackRising = acknowledgeFault && !this.oldAck;
    this.oldAck = acknowledgeFault;
    const setRefRising = setReferencePoint && !this.oldSetRef;
    this.oldSetRef = setReferencePoint;

    const over = this.Override ? this.readInt(this.Override) / 16384 : 1; // OVERRIDE 0x4000 = 100 %

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
      if (commands) drive.stop(); // OFF2: immediate coast
      this.State = 'SwitchingOnInhibited';
    } else if (!noOff3) {
      if (commands) { drive.jogForward = false; drive.jogBackward = false; } // OFF3: quick stop ramp
      if (Math.abs(drive.currentSpeed) < 0.01) this.State = 'SwitchingOnInhibited';
    } else {
      switch (this.State) {
        case 'SwitchingOnInhibited':
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
          if (!onOff1) this.State = 'ReadyForSwitchingOn'; // OFF1 ramp down
          else if (!enableOperation) this.State = 'ReadyToOperate';
          else allowMotion = true;
          break;
      }
      if (!allowMotion && commands) {
        drive.jogForward = false;
        drive.jogBackward = false;
      }
    }

    // ── EPOS motion handling (only in operation) ──
    if (allowMotion) {
      if (!doNotRejectTask) {
        // Reject the active traversing task: brake and discard the pending start
        // (C# clears TargetStartMove; a move already under way is not interrupted)
        if (commands) { drive.jogForward = false; drive.jogBackward = false; }
      } else if (!noIntermediateStop) {
        // Intermediate stop: hold without discarding the task
        if (commands) { drive.jogForward = false; drive.jogBackward = false; }
      } else if (setReferencePoint && setRefRising) {
        // Set reference point: mark referenced (coordinate p2599 is not part of the telegram)
        this.ReferencePointSet = true;
      } else if (startHoming) {
        // Homing: simplified — mark the axis as referenced
        this.ReferencePointSet = true;
      } else if (jog1 || jog2) {
        // Jog 1 = positive, jog 2 = negative (forward has priority if both set)
        if (commands) {
          drive.targetSpeed = this.JogSpeed;
          drive.jogForward = jog1;
          drive.jogBackward = jog1 ? false : jog2;
        }
      } else if (mdiMode) {
        if (mdiSetup) {
          // Setup mode: endless travel at velocity in the selected direction
          if (commands) {
            drive.targetSpeed = this.speedFromMdi(drive, over);
            drive.jogForward = mdiDirectionPos && !mdiDirectionNeg;
            drive.jogBackward = mdiDirectionNeg && !mdiDirectionPos;
          }
        } else if (activateRising || mdiContinuous) {
          // MDI positioning: latch on the rising edge of STW1.6 (or continuously)
          if (commands) {
            drive.jogForward = false;
            drive.jogBackward = false;
            drive.targetSpeed = this.speedFromMdi(drive, over);
            const tarpos = this.readInt(this.MdiTargetPosition);
            const targetMm = mdiAbsolute
              ? tarpos * this.PositionScale + this.PositionOffset
              : drive.currentPosition + tarpos * this.PositionScale;
            drive.startMove(targetMm);
          }
        }
      }
    }

    // ── Evaluate status bits ──
    const readyToSwitchOn = this.State !== 'Fault' && this.State !== 'SwitchingOnInhibited';
    const readyToOperate = this.State === 'ReadyToOperate' || this.State === 'Operation';
    const operationEnabled = this.State === 'Operation';
    const faultPresent = this.State === 'Fault';
    const switchOnInhibited = this.State === 'SwitchingOnInhibited';
    const targetReached = operationEnabled && drive.isAtTarget && !(jog1 || jog2) && !mdiSetup;
    const speed = drive.currentSpeed;
    const standstill = Math.abs(speed) < 0.01;
    const accelerating = Math.abs(speed) > Math.abs(this.oldSpeed) + 0.001;
    const decelerating = Math.abs(speed) < Math.abs(this.oldSpeed) - 0.001;
    const fwd = speed > 0.01;
    const bwd = speed < -0.01;
    const commandActive = !standstill;
    this.oldSpeed = speed;

    // ── Build ZSW1 ──
    let zsw1 = 0;
    if (readyToSwitchOn) zsw1 |= 1 << 0;        // ZSW1.0 ready to switch on
    if (readyToOperate) zsw1 |= 1 << 1;         // ZSW1.1 ready to operate
    if (operationEnabled) zsw1 |= 1 << 2;       // ZSW1.2 operation enabled
    if (faultPresent) zsw1 |= 1 << 3;           // ZSW1.3 fault present
    if (noOff2) zsw1 |= 1 << 4;                 // ZSW1.4 no OFF2 active
    if (noOff3) zsw1 |= 1 << 5;                 // ZSW1.5 no OFF3 active
    if (switchOnInhibited) zsw1 |= 1 << 6;      // ZSW1.6 switching-on inhibited
    if (this.SimulateWarning) zsw1 |= 1 << 7;   // ZSW1.7 warning present
    zsw1 |= 1 << 8;                             // ZSW1.8 following error within tolerance (simulation tracks exactly)
    if (controlByPlc) zsw1 |= 1 << 9;           // ZSW1.9 control requested / granted
    if (targetReached) zsw1 |= 1 << 10;         // ZSW1.10 target position reached
    if (this.ReferencePointSet) zsw1 |= 1 << 11; // ZSW1.11 reference point set
    if (standstill) zsw1 |= 1 << 13;            // ZSW1.13 standstill / setpoint static
    if (accelerating) zsw1 |= 1 << 14;          // ZSW1.14 axis accelerates
    if (decelerating) zsw1 |= 1 << 15;          // ZSW1.15 axis decelerates
    this.ZSW1 = zsw1;

    // ── Build POS_ZSW2 ──
    let posZsw2 = 0;
    if (fwd) posZsw2 |= 1 << 4;                 // POS_ZSW2.4 axis traverses forwards
    if (bwd) posZsw2 |= 1 << 5;                 // POS_ZSW2.5 axis traverses backwards
    if (commandActive) posZsw2 |= 1 << 15;      // POS_ZSW2.15 traversing command active
    this.POS_ZSW2 = posZsw2;

    // ── Feedback (drive → PLC) — ALWAYS ──
    const writer = this.signalWriter!;
    if (this.StatusWord) writer.setByPath(this.StatusWord, zsw1);
    if (this.PosStatusWord1) writer.setByPath(this.PosStatusWord1, zsw1); // POS_ZSW1 mirrors ZSW1 in this model
    if (this.PosStatusWord2) writer.setByPath(this.PosStatusWord2, posZsw2);
    if (this.PositionActual) {
      writer.setByPath(this.PositionActual, this.PositionScale !== 0
        ? Math.round((drive.currentPosition - this.PositionOffset) / this.PositionScale)
        : 0);
    }
    if (this.SpeedActual) {
      // NIST_B: 0x40000000 = 100 % of reference speed
      writer.setByPath(this.SpeedActual, this.ReferenceSpeed !== 0
        ? toInt32(speed / this.ReferenceSpeed * 0x40000000)
        : 0);
    }
  }

  dispose(): void {
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
registerComponentSchema('Drive_ProfidrivePos', RVDriveProfidrivePos.schema, {
  bake: 'chunk', // sits on the Drive node it extends — moves with it (plan-753 §2.3)
  authorable: true, // addable in the asset editor on a node that carries a Drive
  ui: { badge: '#29b6f6' },
});
