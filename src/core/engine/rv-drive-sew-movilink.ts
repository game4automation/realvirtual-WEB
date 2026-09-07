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

/**
 * RVDriveSEWMovilink — TypeScript port of Drive_SEWMovilink.cs (plan-457).
 *
 * Behavior model of a SEW-EURODRIVE drive on the MOVILINK unit profile
 * (MOVIDRIVE B / MOVITRAC B / MOVIMOT). The PLC writes control word 1 (PO1) and
 * a speed setpoint (PO2); the drive returns status word 1 (PI1) and the actual
 * speed (PI2).
 *
 * MOVILINK has no numbered state machine — it has three priority-ordered low-byte
 * command bits, and the pitfall this port reproduces faithfully is that they are
 * inverted: control word bit 0 is the controller INHIBIT (1 = inhibit), bits 1
 * and 2 are active low (0 = rapid stop / stop). The enable byte is therefore
 * 0x06, NOT 0x07, and a zeroed control word is the fail-safe "no enable" state.
 *
 * Priority cascade, in order: Fault > Inhibit > RapidStop > Stop > Enable.
 * A fault is sticky: it is only left on a RISING edge of control word bit 6
 * while `SimulateFault` is no longer set.
 *
 * PLC IOs (Unity parity — same field names as Drive_SEWMovilink.cs):
 *   ControlWord1  — PLCOutput (PLC → drive): MOVILINK control word 1 (PO1)
 *   SpeedSetpoint — PLCOutput (PLC → drive): speed setpoint (PO2)
 *   StatusWord1   — PLCInput  (drive → PLC): status word 1 (PI1)
 *   SpeedActual   — PLCInput  (drive → PLC): actual speed (PI2)
 *
 * Implements IDriveBehavior — the command runs in update() (before physics, so
 * the jog block integrates the motion the same tick); feedback is written inline
 * from the drive's previous-tick currentSpeed, exactly as C# reads
 * Drive.CurrentSpeed inside its single CalcFixedUpdate.
 */

/** True when bit `n` of `word` is set. */
function bit(word: number, n: number): boolean {
  return (word & (1 << n)) !== 0;
}

/** MOVILINK command state (C# `Drive_SEWMovilink.MovilinkState`). */
export type MovilinkState = 'Inhibited' | 'RapidStop' | 'Stop' | 'Enabled' | 'Fault';

export class RVDriveSEWMovilink implements IDriveBehavior, RVComponent {
  // Loaded from the rv-ODT specification (schema/v1/rv-odt.json, plan-187).
  static readonly schema: ComponentSchema = loadSchemaFromSpec('Drive_SEWMovilink');

  readonly node: Object3D;
  isOwner = true;

  // ComponentRef → resolved to SignalStore address strings (null when not wired).
  ControlWord1: string | null = null;
  SpeedSetpoint: string | null = null;
  StatusWord1: string | null = null;
  SpeedActual: string | null = null;

  // Settings (PascalCase, parity with C#).
  MaxSpeed = 100;
  Encoding: 'PercentNmax' | 'Rpm' = 'PercentNmax';
  MaxSpeedRpm = 3000;
  Acceleration = 1000;
  SimulateFault = false;
  FaultCode = 6;

  /** Current MOVILINK command state — runtime only, never part of the schema. */
  State: MovilinkState = 'Inhibited';
  /** Last status word written to the PLC — runtime only, useful for debugging. */
  StatusWord1Value = 0;

  /** Set by SignalBindingManager while live signals own the command slots. The
   *  feedback below is written regardless (mirrors rv-drive-simple.ts). */
  liveControlled = false;

  private drive: RVDrive | null = null;
  private signalStore: SignalStore | null = null;
  private signalWriter: SignalWriter | null = null;
  private prevControl = 0;

  constructor(node: Object3D) {
    this.node = node;
  }

  init(context: ComponentContext): void {
    const path = NodeRegistry.computeNodePath(this.node);

    const drive = context.registry.getByPath<RVDrive>('Drive', path);
    if (!drive) {
      console.warn(`[Drive_SEWMovilink] No Drive found at "${path}" — behavior inactive`);
      return;
    }
    this.drive = drive;
    this.signalStore = context.signalStore;
    this.signalWriter = createSignalWriter(
      context.signalStore,
      `component:Drive_SEWMovilink:${path}`,
      'component',
      { slotContext: path },
    );
    this.State = 'Inhibited';
    this.prevControl = 0;

    // Register self as a drive behavior so drive.update() calls our update().
    drive.driveBehaviors.push(this);

    debug('loader',
      `  Drive_SEWMovilink "${drive.name}": ` +
      `cw1="${this.ControlWord1}" setpoint="${this.SpeedSetpoint}"`);
  }

  /** Raw MOVILINK speed setpoint → fraction (-1..1) of MaxSpeed. */
  private speedToFraction(raw: number): number {
    if (this.Encoding === 'PercentNmax') return raw / 16384;
    // Rpm: 0.2 rpm per bit → rpm = raw / 5
    return this.MaxSpeedRpm !== 0 ? (raw / 5) / this.MaxSpeedRpm : 0;
  }

  /** Fraction (-1..1) of MaxSpeed → raw MOVILINK speed value (rounded, JS has no int). */
  private fractionToSpeed(fraction: number): number {
    if (this.Encoding === 'PercentNmax') return Math.round(fraction * 16384);
    return Math.round(fraction * this.MaxSpeedRpm * 5);
  }

  /** Called every fixed timestep from the drive's update(), before physics. */
  update(_dt: number): void {
    const drive = this.drive;
    const store = this.signalStore;
    if (!drive || !store) return;

    // ── Decode control word 1 (PLC → drive) ──
    const cw = this.ControlWord1 ? Math.round(store.getFloatByPath(this.ControlWord1)) : 0;
    const controllerInhibit = bit(cw, 0);
    const noRapidStop = bit(cw, 1);
    const noStop = bit(cw, 2);
    const reset = bit(cw, 6);
    const resetRising = reset && !bit(this.prevControl, 6);
    this.prevControl = cw;

    // While a playback authority owns the transform, the cascade still runs (so
    // the status word stays truthful) but must not command the drive.
    const commands = !drive.positionOverwrite;
    if (commands) drive.Acceleration = this.Acceleration;

    // ── MOVILINK command handling (Fault > Inhibit > RapidStop > Stop > Enable) ──
    if (this.SimulateFault) this.State = 'Fault';

    if (this.State === 'Fault') {
      if (commands) drive.stop();
      if (!this.SimulateFault && resetRising) this.State = 'Inhibited';
    } else if (controllerInhibit) {
      if (commands) drive.stop(); // controller inhibit: high-Z, brake / coast
      this.State = 'Inhibited';
    } else if (!noRapidStop) {
      if (commands) { drive.jogForward = false; drive.jogBackward = false; } // rapid stop ramp
      this.State = 'RapidStop';
    } else if (!noStop) {
      if (commands) { drive.jogForward = false; drive.jogBackward = false; } // stop ramp
      this.State = 'Stop';
    } else {
      // Enable (control word low byte = 0x06): run toward the speed setpoint.
      this.State = 'Enabled';
      const raw = this.SpeedSetpoint ? Math.round(store.getFloatByPath(this.SpeedSetpoint)) : 0;
      const target = this.speedToFraction(raw) * this.MaxSpeed;
      if (commands) {
        drive.targetSpeed = Math.abs(target);
        drive.jogForward = target > 0;
        drive.jogBackward = target < 0;
      }
    }

    // ── Build status word 1 ──
    const faultWarning = this.State === 'Fault';
    const inverterReady = this.State !== 'Fault' && this.State !== 'Inhibited';
    const outputStageEnabled = this.State === 'Enabled';

    let sw = 0;
    if (outputStageEnabled) sw |= 1 << 0;
    if (inverterReady) sw |= 1 << 1;
    sw |= 1 << 2;                 // PoDataEnabled — always set
    if (faultWarning) sw |= 1 << 5;

    // High byte: fault code while faulted, otherwise the device-status digit.
    let highByte: number;
    if (faultWarning) highByte = this.FaultCode & 0xff;
    else if (this.State === 'Enabled') highByte = 4;      // operation enabled
    else if (this.State === 'Inhibited') highByte = 1;    // controller inhibit
    else highByte = 2;                                    // no enable (rapid stop / stop)
    sw |= highByte << 8;
    this.StatusWord1Value = sw;

    // ── Feedback (drive → PLC) — ALWAYS, also under liveControlled ──
    if (this.StatusWord1) this.signalWriter!.setByPath(this.StatusWord1, sw);
    if (this.SpeedActual) {
      const fraction = this.MaxSpeed !== 0 ? drive.currentSpeed / this.MaxSpeed : 0;
      this.signalWriter!.setByPath(this.SpeedActual, this.fractionToSpeed(fraction));
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
registerComponentSchema('Drive_SEWMovilink', RVDriveSEWMovilink.schema, {
  badgeColor: '#29b6f6',
});
