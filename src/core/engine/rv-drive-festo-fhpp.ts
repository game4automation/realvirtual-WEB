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

/** True when bit `n` of `word` is set. */
function bit(word: number, n: number): boolean {
  return (word & (1 << n)) !== 0;
}

/** One traversing record of the Record Select table (C# `Drive_FestoFHPP.FhppRecord`). */
export interface FhppRecord {
  /** Target position in mm / degrees. */
  Position: number;
  /** Travel velocity in mm/s (or °/s). */
  Velocity: number;
  /** If true the position is relative to the current position. */
  Relative: boolean;
}

/** Normalize one raw GLB record entry (missing fields take the C# defaults). */
function toRecord(raw: unknown): FhppRecord {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    Position: typeof r.Position === 'number' ? r.Position : 0,
    Velocity: typeof r.Velocity === 'number' ? r.Velocity : 100,
    Relative: r.Relative === true,
  };
}

/**
 * RVDriveFestoFHPP — TypeScript port of Drive_FestoFHPP.cs
 *
 * The Festo Handling and Positioning Profile (FHPP) of the CMMT / CMMO / CMMP
 * motor controllers: the PLC writes the 8-byte output image — CCON (byte 0),
 * CPOS (byte 1), record number or CDIR (byte 2), velocity percent (byte 3) and
 * the target position (bytes 4–7) — and the drive returns SCON, SPOS, the byte 2
 * echo and the actual position. Mirrors Drive_FestoFHPP.CalcFixedUpdate():
 *
 *   fault:      SimulateFault → FAULT, stop; cleared on a RISING edge of CCON.RESET
 *   !ENABLE:    stop (power stage blocked), task dropped
 *   !STOP or !HALT (both active low): brake; STOP also drops the task
 *   enabled:    HOM rising → position := PositionOffset, referenced
 *               JOGP / JOGN (level) → jog at JogSpeed
 *               START rising → Direct mode (OPM = 01): CDIR.0 relative, velocity byte % of BaseVelocity
 *                              Record Select: Records[byte 2] (Position, Velocity, Relative)
 *   SCON: ENABLED, OPEN, WARN, FAULT, VLOAD (always), FCT/MMI echo, OPM echo
 *   SPOS: HALT (1 = not halted), ACK (task active), MC (motion complete), MOV, REF
 *
 * PLC IOs (Unity parity — same field names as Drive_FestoFHPP.cs):
 *   Ccon, Cpos, RecordOrCdir, VelocityPercent, TargetPosition — PLCOutputInt (PLC → drive)
 *   Scon, Spos, RecordOrSdir, PositionActual                  — PLCInputInt  (drive → PLC)
 */
export class RVDriveFestoFHPP implements IDriveBehavior, RVComponent {
  // Loaded from the rv-ODT specification (schema/v1/rv-odt.json, plan-187).
  static readonly schema: ComponentSchema = loadSchemaFromSpec('Drive_FestoFHPP');

  readonly node: Object3D;
  isOwner = true;

  // ComponentRef → resolved to SignalStore address strings (null when not wired).
  Ccon: string | null = null;
  Cpos: string | null = null;
  RecordOrCdir: string | null = null;
  VelocityPercent: string | null = null;
  TargetPosition: string | null = null;
  Scon: string | null = null;
  Spos: string | null = null;
  RecordOrSdir: string | null = null;
  PositionActual: string | null = null;

  // Settings (PascalCase, parity with C#).
  PositionScale = 1;
  PositionOffset = 0;
  BaseVelocity = 100;
  JogSpeed = 50;
  Acceleration = 1000;
  /** Traversing record table (Record Select mode) — raw GLB entries, normalized on read. */
  Records: unknown[] = [];
  SimulateFault = false;
  SimulateWarning = false;

  /** SCON.3 — runtime only. */
  Fault = false;
  /** SPOS.7 — set by homing; runtime only. */
  Referenced = false;
  /** Last SCON byte written to the PLC — runtime only. */
  SconValue = 0;
  /** Last SPOS byte written to the PLC — runtime only. */
  SposValue = 0;

  private drive: RVDrive | null = null;
  private signalStore: SignalStore | null = null;
  private signalWriter: SignalWriter | null = null;
  private prevCcon = 0;
  private prevCpos = 0;
  private taskActive = false;

  constructor(node: Object3D) {
    this.node = node;
  }

  init(context: ComponentContext): void {
    const path = NodeRegistry.computeNodePath(this.node);

    const drive = context.registry.getByPath<RVDrive>('Drive', path);
    if (!drive) {
      console.warn(`[Drive_FestoFHPP] No Drive found at "${path}" — behavior inactive`);
      return;
    }
    this.drive = drive;
    this.signalStore = context.signalStore;
    this.signalWriter = createSignalWriter(
      context.signalStore,
      `component:Drive_FestoFHPP:${path}`,
      'component',
      { slotContext: path },
    );
    this.prevCcon = 0;
    this.prevCpos = 0;
    this.taskActive = false;
    this.Fault = false;
    this.Referenced = false;

    // Register self as a drive behavior so drive.update() calls our update().
    drive.driveBehaviors.push(this);

    debug('loader',
      `  Drive_FestoFHPP "${drive.name}": ccon="${this.Ccon}" cpos="${this.Cpos}" records=${this.records().length}`);
  }

  /** The normalized record table. */
  records(): FhppRecord[] {
    return Array.isArray(this.Records) ? this.Records.map(toRecord) : [];
  }

  private readInt(address: string | null): number {
    return address ? Math.round(this.signalStore!.getFloatByPath(address)) : 0;
  }

  /** Called every fixed timestep from the drive's update(), before physics. */
  update(_dt: number): void {
    const drive = this.drive;
    const store = this.signalStore;
    if (!drive || !store) return;

    const ccon = this.readInt(this.Ccon);
    const cpos = this.readInt(this.Cpos);

    const enable = bit(ccon, 0);
    const stop = bit(ccon, 1);         // active low named action: 0 = stop
    const resetFault = bit(ccon, 3);
    const directMode = bit(ccon, 6) && !bit(ccon, 7); // OPM = 01
    const notHalted = bit(cpos, 0);    // active low: 1 = not halted
    const startBit = bit(cpos, 1);
    const home = bit(cpos, 2);
    const jogPos = bit(cpos, 3);
    const jogNeg = bit(cpos, 4);

    const startRising = startBit && !bit(this.prevCpos, 1);
    const homeRising = home && !bit(this.prevCpos, 2);
    const resetRising = resetFault && !bit(this.prevCcon, 3);
    this.prevCcon = ccon;
    this.prevCpos = cpos;

    const commands = !drive.positionOverwrite;
    if (commands) {
      drive.Acceleration = this.Acceleration;
      drive.UseAcceleration = true;
    }

    const motionAllowed = enable && stop && notHalted && !this.Fault;

    // ── Fault handling and command cascade ──
    if (this.SimulateFault) {
      this.Fault = true;
      if (commands) drive.stop();
      this.taskActive = false;
    } else {
      if (this.Fault && resetRising) this.Fault = false;

      if (!enable) {
        if (commands) drive.stop(); // power stage blocked
        this.taskActive = false;
      } else if (!stop || !notHalted) {
        // Stop (CCON.1 = 0) aborts; Halt (CPOS.0 = 0) pauses — both ramp down
        if (commands) { drive.jogForward = false; drive.jogBackward = false; }
        if (!stop) this.taskActive = false;
      } else {
        // Enabled and free to move
        if (homeRising) {
          if (commands) {
            drive.currentPosition = this.PositionOffset;
            drive.stop(); // parks the motion core at the new position
          }
          this.Referenced = true;
          this.taskActive = false;
        } else if (jogPos || jogNeg) {
          if (commands) {
            drive.targetSpeed = this.JogSpeed;
            drive.jogForward = jogPos && !jogNeg;
            drive.jogBackward = jogNeg && !jogPos;
          }
          this.taskActive = false;
        } else if (startRising) {
          this.startPositioningTask(drive, directMode, commands);
        }
      }
    }

    // ── Motion complete tracking ──
    if (this.taskActive && drive.isAtTarget) this.taskActive = false;

    // ── Build status bytes ──
    this.Fault = this.SimulateFault || this.Fault;
    const enabled = enable && !this.Fault;
    const operationOpen = motionAllowed;
    const acknowledge = this.taskActive;
    const standstill = Math.abs(drive.currentSpeed) < 0.01;
    const moving = !standstill;
    const motionComplete = enabled && !this.taskActive && drive.isAtTarget && !(jogPos || jogNeg);

    let scon = 0;
    if (enabled) scon |= 1 << 0;
    if (operationOpen) scon |= 1 << 1;
    if (this.SimulateWarning) scon |= 1 << 2;
    if (this.Fault) scon |= 1 << 3;
    scon |= 1 << 4;                       // VLOAD: supply voltage present
    if (bit(ccon, 5)) scon |= 1 << 5;     // FCT/MMI follows LOCK
    if (directMode) scon |= 1 << 6;       // OPM echo
    this.SconValue = scon;

    let spos = 0;
    if (notHalted) spos |= 1 << 0;        // SPOS.0 1 = not halted
    if (acknowledge) spos |= 1 << 1;
    if (motionComplete) spos |= 1 << 2;
    if (moving) spos |= 1 << 4;
    if (this.Referenced) spos |= 1 << 7;
    this.SposValue = spos;

    // ── Feedback (drive → PLC) — ALWAYS ──
    const writer = this.signalWriter!;
    if (this.Scon) writer.setByPath(this.Scon, scon);
    if (this.Spos) writer.setByPath(this.Spos, spos);
    if (this.RecordOrSdir) writer.setByPath(this.RecordOrSdir, this.readInt(this.RecordOrCdir)); // echo byte 2
    if (this.PositionActual) {
      writer.setByPath(this.PositionActual, this.PositionScale !== 0
        ? Math.round((drive.currentPosition - this.PositionOffset) / this.PositionScale)
        : 0);
    }
  }

  private startPositioningTask(drive: RVDrive, directMode: boolean, commands: boolean): void {
    let targetMm: number;
    let speed: number;

    if (directMode) {
      const cdir = this.readInt(this.RecordOrCdir);
      const relative = bit(cdir, 0); // CDIR.0 1 = relative
      const tarpos = this.readInt(this.TargetPosition);
      targetMm = relative
        ? drive.currentPosition + tarpos * this.PositionScale
        : tarpos * this.PositionScale + this.PositionOffset;
      const velPercent = this.VelocityPercent ? Math.max(0, Math.min(100, this.readInt(this.VelocityPercent))) : 100;
      speed = velPercent / 100 * this.BaseVelocity;
    } else {
      const recNo = this.readInt(this.RecordOrCdir);
      const records = this.records();
      if (recNo < 0 || recNo >= records.length) return; // unknown record — ignore the start
      const rec = records[recNo];
      targetMm = rec.Relative ? drive.currentPosition + rec.Position : rec.Position + this.PositionOffset;
      speed = rec.Velocity;
    }

    if (commands) {
      drive.jogForward = false;
      drive.jogBackward = false;
      drive.targetSpeed = Math.abs(speed);
      drive.startMove(targetMm);
    }
    this.taskActive = true;
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
registerComponentSchema('Drive_FestoFHPP', RVDriveFestoFHPP.schema, {
  bake: 'chunk', // sits on the Drive node it extends — moves with it (plan-753 §2.3)
  authorable: true, // addable in the asset editor on a node that carries a Drive
  ui: { badge: '#29b6f6' },
});
