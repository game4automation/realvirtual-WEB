// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-robot-postprocessor.ts — the abstract vendor postprocessor (plan-773
 * Phase 5, F17). Port of `RobotPostProcessor.cs`
 * (`Packages/io.realvirtual.professional/Runtime/IK/Export/`).
 *
 * Its C# header states the shape this file inherits, and it is worth repeating
 * because it is the whole architecture:
 *
 * > Mirrors the RoboDK RobotPost method set (MoveJ/MoveL/MoveC, SetTool,
 * > SetFrame, SetDigitalOutput, WaitDigitalInput, WaitTime) and adds realvirtual
 * > hooks (DisplayName, FileExtension, GetFileName, Header, Footer).
 * > … The generated output is a copy-paste text template for the target
 * > controller's program editor — NOT a complete, ready-to-run robot program.
 *
 * Everything numeric was already decided by {@link ikPathToProgram} and
 * `rv-robot-coord.ts`. A vendor below this class formats text and nothing else:
 * it never converts a frame, never scales, never solves.
 *
 * ## What this port ADDS to the C# original: the refusals of E9
 *
 * Unity cannot decline — it has no tier and no bake that can lose a tool. The
 * web has both, and plan-773 E9 says the two halves of a program are not worth
 * the same:
 *
 * > the axis-based export takes precedence over the Cartesian one … a vendor
 * > must REFUSE at `'none'` instead of formatting zeros.
 *
 * So {@link RobotPostProcessor.emit} is a gate and not just a renderer:
 *
 * | condition | verdict | why |
 * |---|---|---|
 * | `prog.refusal` already set | passed through | the licence gate / F21 already spoke |
 * | no instructions | refused (`angles`) | an empty file is worse than a sentence |
 * | any `AnglesSource === 'none'` | refused (`angles`) | zeros are a valid-LOOKING joint vector and would drive a real robot home |
 * | Cartesian mode, `FkCheck` not `'ok'` | refused (`toolchain`) | a Cartesian pose is only as good as the tool chain (plan-772: 239.90 mm) |
 * | Cartesian mode, `FkCheck === null` | allowed | no producer claim at all — a hand-built program, e.g. a vendor test |
 *
 * `AnglesSource === 'baked'` is NOT a refusal: those are the angles the file
 * itself carries, the converter already warned about them per waypoint, and
 * refusing them would make a legacy model unexportable rather than cautious.
 *
 * ## Why `emit()` and not `generate()` is the public entry
 *
 * KUKA emits two files (`.src` + `.dat`, Phase 6), so the file list — not the
 * string — is the vendor's output. `generate()` stays the single-buffer default
 * that most vendors fill, exactly as in C#.
 */

import {
  ROBOT_PROGRAM_DISCLAIMER,
  type RobotMoveInstruction,
  type RobotProgram,
  type RobotProgramRefusal,
} from './rv-robot-program';

/**
 * One generated output artifact. Most vendors emit a single file; KUKA emits
 * two (`.src` + `.dat`). Port of the `RobotExportFile` struct.
 */
export interface RobotExportFile {
  /** File name including extension. */
  fileName: string;
  /** Full text content. */
  content: string;
}

/** What {@link RobotPostProcessor.emit} answers — files, or a reason. */
export type RobotExportResult =
  | {
    ok: true;
    /** The vendor's human-readable name, e.g. `ABB RAPID`. */
    vendor: string;
    /** True when joint moves were emitted, false for the Cartesian form. */
    axisBased: boolean;
    files: RobotExportFile[];
    /** The program's warnings plus anything the vendor added while formatting. */
    warnings: string[];
    /** {@link ROBOT_PROGRAM_DISCLAIMER}, verbatim — never reworded. */
    disclaimer: string;
  }
  | {
    ok: false;
    vendor: string;
    axisBased: boolean;
    refusal: RobotProgramRefusal;
    warnings: string[];
  };

/**
 * Invariant-culture float formatter, three decimals, trailing zeros stripped —
 * the web's `v.ToString("0.###", CultureInfo.InvariantCulture)`.
 *
 * The invariant part is not decoration: a German locale would write `1,5`, and
 * `MoveAbsJ [[1,5, …]]` is a syntax error in RAPID, not a rounding difference.
 * `toFixed` is already locale-independent, which is exactly why it is used here
 * rather than `toLocaleString`.
 *
 * `-0` is normalised to `0`: C# prints `0` for it, and a `-0` in a joint vector
 * reads like a sign that was meant.
 */
export function fmtInvariant(v: number): string {
  if (!Number.isFinite(v)) return '0';
  const s = v.toFixed(3).replace(/\.?0+$/, '');
  if (s === '' || s === '-' || /^-0$/.test(s)) return '0';
  return s;
}

/**
 * Abstract base of every vendor postprocessor — port of `RobotPostProcessor`.
 *
 * A vendor overrides only the hooks it needs. The naming follows the house
 * convention (camelCase members) rather than C#'s PascalCase: unlike
 * `RobotProgram`, this class is not a data shape whose field names have to
 * survive a mechanical comparison — it is behaviour, and the names are read by
 * TypeScript readers only.
 */
export abstract class RobotPostProcessor {
  /** `ABB RAPID`, `SEW MOVI-C (.srlprg)`, … */
  abstract readonly displayName: string;
  /** `.mod`, `.src`, `.ls`, `.srlprg` — including the dot. */
  abstract readonly fileExtension: string;

  /** Sanitize the program name to a vendor-legal identifier. */
  abstract getFileName(prog: RobotProgram): string;

  /**
   * true => joint moves (MoveAbsJ / PTP_J); false => Cartesian.
   *
   * Default true, and that default is plan-773 E9 rather than taste: joint
   * angles go into the file as they were solved, while a Cartesian pose carries
   * the whole tool chain with it.
   */
  axisBased = true;

  /** Output buffer vendors append to for the single-file default. */
  protected readonly lines: string[] = [];

  protected addLine(line = ''): void {
    this.lines.push(line);
  }

  /** Clear the buffer — `ResetOutput()`. */
  resetOutput(): void {
    this.lines.length = 0;
  }

  /** The buffer as text, one trailing newline per line (C# `AppendLine`). */
  protected buffer(): string {
    return this.lines.length === 0 ? '' : `${this.lines.join('\n')}\n`;
  }

  /** Shared invariant formatter — `Fmt`. */
  protected fmt(v: number): string {
    return fmtInvariant(v);
  }

  /** The program being generated; set by {@link generate}. */
  protected program: RobotProgram | null = null;

  /** Warnings the VENDOR added while formatting (the program is not mutated). */
  protected readonly vendorWarnings: string[] = [];

  /** Record a warning without touching the (shared, transient) program. */
  protected warn(message: string): void {
    this.vendorWarnings.push(message);
  }

  // ── Program structure hooks ──
  /** MODULE/PROC, DEF, /PROG … */
  protected header(_prog: RobotProgram): void { /* vendors override */ }
  /** ENDPROC ENDMODULE, END, /END … */
  protected footer(_prog: RobotProgram): void { /* vendors override */ }

  // ── RoboDK-mirrored motion / IO primitives ──
  /** Joint move (MoveAbsJ / PTP / J P[n]). */
  protected moveJ(_m: RobotMoveInstruction): void { /* vendors override */ }
  /** Linear move (MoveL / LIN / L P[n]). */
  protected moveL(_m: RobotMoveInstruction): void { /* vendors override */ }

  /**
   * Circular move. `ikPathToProgram` produces arc blends internally (LIN→LIN)
   * and does NOT expose MoveC waypoints, so the default converter never calls
   * this. Vendors may override.
   */
  protected moveC(_via: RobotMoveInstruction, _to: RobotMoveInstruction): void {
    this.warn(`${this.displayName}: MoveC not produced by converter.`);
  }

  /** `$TOOL` / tooldata / UTOOL. */
  protected setTool(_prog: RobotProgram): void { /* vendors override */ }
  /** `$BASE` / `\WObj` / UFRAME. */
  protected setFrame(_prog: RobotProgram): void { /* vendors override */ }
  /** SetDO / `$OUT[]=TRUE` / `DO[]=ON`. */
  protected setDigitalOutput(_signal: string, _value: boolean): void { /* vendors override */ }
  /** WaitDI / `WAIT FOR $IN[]` / `WAIT DI[]`. */
  protected waitDigitalInput(_signal: string, _value: boolean): void { /* vendors override */ }
  /** WaitTime / WAIT SEC / WAIT (sec). */
  protected waitTime(_seconds: number): void { /* vendors override */ }
  /** Optional operator comment / TPMSG. */
  protected runMessage(_msg: string): void { /* vendors override */ }

  /**
   * Emits the side effects attached to a move (gripper / set signal / dwell /
   * wait signal), in the order they execute at the target. Shared by all
   * vendors — the order is a behavioural contract, not a formatting choice.
   */
  protected emitSideEffects(m: RobotMoveInstruction): void {
    if (m.PickPlaceSignalName) this.setDigitalOutput(m.PickPlaceSignalName, m.PickPlaceSignalValue);
    if (m.SetSignalName) this.setDigitalOutput(m.SetSignalName, m.SetSignalValue);
    if (m.DwellSec > 0) this.waitTime(m.DwellSec);
    if (m.WaitSignalName) this.waitDigitalInput(m.WaitSignalName, m.WaitSignalValue);
  }

  /**
   * Default sequential generation into a single buffer. Vendors with a split
   * layout (ABB consts vs. proc, KUKA `.src` vs `.dat`) override this.
   */
  generate(prog: RobotProgram): string {
    this.program = prog;
    this.resetOutput();
    this.header(prog);
    this.setTool(prog);
    this.setFrame(prog);
    for (const m of prog.Instructions) {
      if (m.MoveType === 'LIN') this.moveL(m);
      else this.moveJ(m); // PTP + PTPUnsynced
      this.emitSideEffects(m);
    }
    this.footer(prog);
    return this.buffer();
  }

  /**
   * Produce the file(s) — the public entry, and the E9 gate (see the header).
   *
   * Vendors override {@link emitFiles}, never this: the refusals must not be
   * something a vendor can forget to call.
   */
  emit(prog: RobotProgram): RobotExportResult {
    this.vendorWarnings.length = 0;
    const refusal = this.refuse(prog);
    if (refusal) {
      return {
        ok: false,
        vendor: this.displayName,
        axisBased: this.axisBased,
        refusal,
        warnings: [...prog.Warnings, ...this.vendorWarnings],
      };
    }
    const files = this.emitFiles(prog);
    return {
      ok: true,
      vendor: this.displayName,
      axisBased: this.axisBased,
      files,
      warnings: [...prog.Warnings, ...this.vendorWarnings],
      disclaimer: ROBOT_PROGRAM_DISCLAIMER,
    };
  }

  /**
   * All generated files. Default = one file from {@link generate}; KUKA
   * overrides to add the `.dat` (Phase 6). Port of `Emit`.
   */
  protected emitFiles(prog: RobotProgram): RobotExportFile[] {
    return [{ fileName: this.getFileName(prog) + this.fileExtension, content: this.generate(prog) }];
  }

  /**
   * The E9 preconditions, in the order a reader cares about them. A vendor may
   * TIGHTEN this (call `super.refuse` first), never skip it.
   */
  protected refuse(prog: RobotProgram): RobotProgramRefusal | null {
    // The licence gate (E3) and the F21 FK check already spoke — pass their
    // sentence through rather than restating it in vendor words.
    if (prog.refusal) return prog.refusal;

    if (prog.Instructions.length === 0) {
      return {
        code: 'angles',
        message: `${this.displayName}: this program has no waypoints, so there is nothing to format. `
          + 'Add waypoints to the IKPath (ik.target.add) before exporting.',
      };
    }

    const unusable = prog.Instructions
      .map((m, i) => (m.AnglesSource === 'none' ? `#${i} ${m.Comment || '(unnamed)'}` : null))
      .filter((s): s is string => s !== null);
    if (unusable.length > 0) {
      return {
        code: 'angles',
        message: `${this.displayName}: ${unusable.length} waypoint(s) carry no usable joint vector — `
          + `${unusable.join(', ')}. Their angles would be formatted as six zeros, which is a perfectly `
          + 'valid-looking joint vector and would drive a real robot to its home pose. Make them reachable '
          + '(ik.target.set) or remove them; the program is not emitted in a degraded form.',
      };
    }

    if (!this.axisBased) {
      const fk = prog.FkCheck;
      if (fk && fk.status !== 'ok') {
        return {
          code: 'toolchain',
          message: `${this.displayName}: a Cartesian export carries the whole tool chain into every pose, and `
            + `this robot's tool chain is not vouched for (${fk.reason}). The AXIS-BASED export of the same `
            + 'path is unaffected and is emitted on request (axisBased = true) — plan-773 E9.',
        };
      }
    }

    return null;
  }
}
