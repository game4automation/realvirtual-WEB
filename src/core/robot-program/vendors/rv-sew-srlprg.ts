// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-sew-srlprg.ts — SEW MOVI-C / MOVIKIT Robotics sequence program
 * (`.srlprg`), plan-773 Phase 5, F17; E2 put SEW second. Port of
 * `SewPostProcessors.cs`, formatting-faithful.
 *
 * Its C# header says the one thing a reader has to know before trusting the
 * output, and it is stronger than the usual disclaimer:
 *
 * > MOVIKIT Robotics IS an editable robot sequence program on the MOVI-C
 * > CONTROLLER (created via teach-in in MOVISUITE), so — unlike ABB/KUKA/Fanuc —
 * > there is **no public language reference**. This postprocessor emits the
 * > OBSERVED `.srlprg` text form … It is a COPY-PASTE TEMPLATE for MOVISUITE,
 * > NOT a fully calibrated program: KINEMATIC id, MotionSet, the REALVAR
 * > mapping and the tool/base frames stay project-specific and must be verified
 * > on the (virtual) controller.
 *
 * Mapping from the vendor-neutral program (unchanged from C#):
 *
 * - `PTP_J J1..J6`        ← `JointAngles[0..5]`
 * - `LIN X/Y/Z`           ← `PositionMm` (right-handed, mm)
 * - `LIN RotZ/RotY/RotX`  ← `EulerZYXDeg.z / .y / .x` (A/B/C, deg)
 * - `BlendDist`           ← `BlendRadiusMm` (0 when blending is off)
 * - signal writes         ← `SetSignalName` / `PickPlaceSignalName` (`:= 1/0`)
 * - `WAIT_TIME`           ← `DwellSec`
 *
 * ## The three ambient values, and why they are injectable here
 *
 * C# reads `DateTime.Now`, `Guid.NewGuid()` and `Environment.UserName` straight
 * out of the process. Two of those are fine in a browser and one does not exist
 * (there is no OS user name in a tab — C#'s own `catch` fallback `realvirtual`
 * is the honest answer, not a guess at the signed-in account). All three are
 * {@link SewSrlPrgOptions} instead, because a header that changes on every call
 * cannot be asserted: a test pins them, production leaves them alone.
 *
 * ## `EulerZYXDeg` is `[C, B, A]`
 *
 * The tuple is `[x, y, z]` = `[C, B, A]` = `[W, P, R]`, so `RotZ` reads index 2
 * and `RotX` index 0. C# wrote `.z` / `.y` / `.x` on a `Vector3` and meant the
 * same three numbers; getting the order backwards here would rotate the tool by
 * whatever the difference happens to be and still look like a plausible file.
 *
 * ## This file is a lazy chunk
 *
 * Reached only through `rv-robot-vendors.ts`'s `import()` — see the ABB header.
 */

import { RobotPostProcessor } from '../rv-robot-postprocessor';
import type { RobotMoveInstruction, RobotProgram } from '../rv-robot-program';

/** Options of {@link SewSrlPrgPostProcessor}. */
export interface SewSrlPrgOptions {
  /** `// KINEMATIC:` header line — machine-specific controller kinematic id. */
  kinematicNumber?: number;
  /** Emitted as `MotionSet := <n>`. */
  motionSet?: number;
  /** First `REALVAR[]` slot assigned to a program signal. */
  realVarBaseIndex?: number;
  /** Emitted as a `// CoordinateSystem := <x>` comment. */
  coordinateSystem?: string;
  /** Generation timestamp; default `new Date()`. See the module header. */
  generatedAt?: Date;
  /** Program UUID; default a random one. */
  uuid?: string;
  /** `// USER:` line; default `realvirtual` (C#'s own catch fallback). */
  user?: string;
}

/** SEW MOVI-C (`.srlprg`). See the module header. */
export class SewSrlPrgPostProcessor extends RobotPostProcessor {
  readonly displayName = 'SEW MOVI-C (.srlprg)';
  readonly fileExtension = '.srlprg';

  // ── Project-specific header constants (defaults from a real SEW sample) ──
  kinematicNumber = 1;
  motionSet = 1;
  realVarBaseIndex = 10;
  coordinateSystem = 'Base';

  private readonly generatedAt: Date;
  private readonly uuid: string;
  private readonly user: string;
  private waitInputWarned = false;

  constructor(options: SewSrlPrgOptions = {}) {
    super();
    if (options.kinematicNumber !== undefined) this.kinematicNumber = options.kinematicNumber;
    if (options.motionSet !== undefined) this.motionSet = options.motionSet;
    if (options.realVarBaseIndex !== undefined) this.realVarBaseIndex = options.realVarBaseIndex;
    if (options.coordinateSystem !== undefined) this.coordinateSystem = options.coordinateSystem;
    this.generatedAt = options.generatedAt ?? new Date();
    this.uuid = options.uuid ?? randomUuid();
    this.user = options.user ?? 'realvirtual';
  }

  getFileName(prog: RobotProgram): string {
    return sanitize(prog ? prog.Name : 'Path');
  }

  // ── structure ──
  protected override header(prog: RobotProgram): void {
    this.waitInputWarned = false;
    const name = sanitize(prog ? prog.Name : 'Path');

    this.addLine('// ==============================================================================');
    this.addLine(`// PROGRAM:   ${name}`);
    this.addLine(`// GENERATED: ${formatStamp(this.generatedAt)}`);
    this.addLine(`// USER:      ${this.user}`);
    this.addLine('// SOURCE:    realvirtual Robot Program Export');
    this.addLine(`// KINEMATIC: ${this.kinematicNumber}`);
    this.addLine(`// UUID:      {${this.uuid}}`);
    this.addLine('// ==============================================================================');
    this.addLine('// COPY-PASTE TEMPLATE for the SEW MOVI-C CONTROLLER (MOVIKIT Robotics / MOVISUITE) - Beta.');
    this.addLine('// Verify KINEMATIC / MotionSet / REALVAR mapping and tool/base on the (virtual) controller.');
    this.addLine();

    this.emitInitVariables(prog);
    this.emitDynamicValues();
    this.emitMotionSetup();

    this.addLine('// END Initialization');
    this.addLine('// =========================================================');
    this.addLine();
    this.addLine('// --- Main Program ---');
  }

  protected override footer(_prog: RobotProgram): void {
    this.addLine();
    this.addLine('END_PROG');
  }

  /**
   * One REALVAR slot per distinct signal referenced in the program, in order of
   * first appearance. The main program then writes/reads the friendly signal
   * name directly (mirrors the observed SEW sample).
   */
  private emitInitVariables(prog: RobotProgram): void {
    this.addLine('// --- Initialize Variables ---');
    this.addLine();

    const order: string[] = [];
    const seen = new Set<string>();
    const take = (s: string | null): void => {
      if (s && !seen.has(s)) { seen.add(s); order.push(s); }
    };
    for (const m of prog?.Instructions ?? []) {
      take(m.PickPlaceSignalName);
      take(m.SetSignalName);
      take(m.WaitSignalName);
    }

    if (order.length === 0) {
      this.addLine('// (no program signals)');
    } else {
      let idx = this.realVarBaseIndex;
      for (const s of order) {
        this.addLine(`// mapped from: ${s}`);
        this.addLine(`REALVAR[${idx}] := 0.0`);
        idx++;
      }
    }
    this.addLine();
  }

  private emitDynamicValues(): void {
    this.addLine('// --- Initial Dynamic Values ---');
    this.addLine('// For LIN:');
    this.addLine('TransVel := 100     TransAcc := 1000     TransDec := 1000     TransJerk := 10000');
    this.addLine('RotVel   := 100     RotAcc   := 1000     RotDec   := 1000     RotJerk   := 10000');
    this.addLine();
    this.addLine('// For PTP:');
    for (let j = 1; j <= 6; j++) {
      this.addLine(`J${j}Vel := 100   J${j}Acc := 1000   J${j}Dec := 1000   J${j}Jerk := 10000`);
    }
    this.addLine();
  }

  private emitMotionSetup(): void {
    this.addLine('// --- Select MotionSet ---');
    this.addLine(`MotionSet := ${this.motionSet}`);
    this.addLine('// --- Select Coordinate System ---');
    this.addLine(`// CoordinateSystem := ${this.coordinateSystem}`);
    this.addLine('// --- Set blending mode ---');
    this.addLine('BlendRefersToTarget := TRUE');
    this.addLine();
  }

  // ── motion ──
  protected override moveJ(m: RobotMoveInstruction): void {
    this.addLine(`// Move PTP to point: ${safeComment(m)}${this.speedNote(m, false)}`);
    const j = m.JointAngles;
    const a = (i: number): string => this.fmt(j?.[i] ?? 0);
    this.addLine(
      `PTP_J J1 := ${a(0)} J2 := ${a(1)} J3 := ${a(2)} `
      + `J4 := ${a(3)} J5 := ${a(4)} J6 := ${a(5)} BlendDist := ${this.fmt(blend(m))}`,
    );
  }

  protected override moveL(m: RobotMoveInstruction): void {
    this.addLine(`// LIN to point: ${safeComment(m)}${this.speedNote(m, true)}`);
    // EulerZYXDeg is [C, B, A] = [x, y, z]: RotZ = [2], RotY = [1], RotX = [0].
    this.addLine(
      `LIN X := ${this.fmt(m.PositionMm[0])} Y := ${this.fmt(m.PositionMm[1])} Z := ${this.fmt(m.PositionMm[2])} `
      + `RotZ := ${this.fmt(m.EulerZYXDeg[2])} RotY := ${this.fmt(m.EulerZYXDeg[1])} `
      + `RotX := ${this.fmt(m.EulerZYXDeg[0])} BlendDist := ${this.fmt(blend(m))}`,
    );
  }

  // ── side effects ──
  protected override setDigitalOutput(signal: string, value: boolean): void {
    const v = value ? '1' : '0';
    this.addLine(`// OUT: ${signal} := ${v}`);
    this.addLine(`${signal} := ${v}`);
  }

  protected override waitDigitalInput(signal: string, value: boolean): void {
    // No public reference for the input-wait syntax in the observed sample —
    // emit a best-effort form and warn ONCE so the integrator adapts it.
    if (!this.waitInputWarned) {
      this.warn('SEW: WAIT_UNTIL input-wait syntax is unverified (not in the reference sample) - adapt on the controller.');
      this.waitInputWarned = true;
    }
    const v = value ? '1' : '0';
    this.addLine(`// WAIT until: ${signal} == ${v}`);
    this.addLine(`WAIT_UNTIL ${signal} == ${v}`);
  }

  protected override waitTime(seconds: number): void {
    this.addLine(`// Wait for ${this.fmt(seconds)} seconds`);
    this.addLine(`WAIT_TIME ${this.fmt(seconds)}`);
  }

  /**
   * Non-command annotation of the realvirtual speed — SEW dynamics are set
   * globally in the init block, so the per-move value can only be a comment.
   */
  private speedNote(m: RobotMoveInstruction, linear: boolean): string {
    return linear
      ? `  (v=${this.fmt(m.LinSpeedMmS)} mm/s)`
      : `  (speed ${this.fmt(m.JointSpeedPct)}%)`;
  }
}

/** `(m.EnableBlending && m.BlendRadiusMm > 0) ? m.BlendRadiusMm : 0`. */
function blend(m: RobotMoveInstruction): number {
  return m.EnableBlending && m.BlendRadiusMm > 0 ? m.BlendRadiusMm : 0;
}

/** The waypoint comment, or `P` when it has none. */
function safeComment(m: RobotMoveInstruction): string {
  return m.Comment ? m.Comment : 'P';
}

/** `yyyy-MM-dd HH:mm:ss`, local time — C#'s `DateTime.Now` format string. */
function formatStamp(d: Date): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  return `${p(d.getFullYear(), 4)}-${p(d.getMonth() + 1)}-${p(d.getDate())} `
    + `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** A UUID; `crypto.randomUUID` where it exists, a v4-shaped fallback otherwise. */
function randomUuid(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = Math.floor(Math.random() * 16);
    return (ch === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/** Strips characters illegal in a SEW identifier; ensures a leading letter. */
function sanitize(raw: string): string {
  if (!raw) return 'Path';
  let s = '';
  for (const c of raw) s += /[\p{L}\p{Nd}_]/u.test(c) ? c : '_';
  if (!/^\p{L}/u.test(s)) s = `P${s}`;
  return s;
}
