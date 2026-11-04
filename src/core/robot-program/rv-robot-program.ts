// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-robot-program.ts — the vendor-neutral robot program (plan-773 Phase 4, F14).
 *
 * A port of `RobotProgram.cs` (`Packages/io.realvirtual.professional/Runtime/IK/
 * Export/`). Its own class header states the architecture this file inherits:
 *
 * > All values are precomputed in the core (IKPathToProgram + RobotCoordConverter)
 * > … Each vendor postprocessor only formats text from this model.
 *
 * That sentence is the whole reason plan-773 E1 chose a TypeScript port over a
 * shared Rust core: of ~57 KB of C# the mathematics is 95 trivial lines
 * (`rv-robot-coord.ts`) and everything else is text formatting. So the model is
 * data, the converter is arithmetic, and the vendors (Phase 5) are string
 * builders that read nothing but what is written here.
 *
 * ## Why the field names are PascalCase
 *
 * Deliberate, and the same rule `rv-ik-target.ts` states for component extras:
 * a name that is spelled identically on both sides makes a later comparison
 * mechanical. Every field below carries the name its `RobotProgram.cs`
 * counterpart carries. The exceptions are named in plan-773 §2.2 and are exactly
 * the fields whose MEANING changed:
 *
 * | Unity | here | why |
 * |---|---|---|
 * | `Vector3 PositionMm` | `[number, number, number]` | no Three import in the export core |
 * | `Quaternion RotationQuat` | `[x, y, z, w]` | the house writes tuples (`OpwParams.toolOffset`) |
 * | `[NonSerialized] IKPath SourcePath` | `sourcePathNodeId` | plan-769: a reference is an ADDRESS, not a pointer |
 *
 * ## Two fields Unity does not have
 *
 * - {@link RobotMoveInstruction.AnglesSource} — see its own doc. Unity's
 *   `IKPathToProgram` silently emits whatever `AxisPos` happened to hold when a
 *   target did not solve; that silent reuse of a stale configuration is the
 *   exact defect class plan-773 F10 was written about. Naming the provenance
 *   per instruction costs one enum and lets a Phase 5 postprocessor refuse
 *   instead of formatting zeros as if they were a solve.
 * - {@link RobotProgram.refusal} — Unity has no licence tier, so it has no way
 *   to decline. plan-773 E3 does (`rv-robot-program-gate.ts`), and a refusal
 *   must not be mistakable for one of the `Warnings`.
 *
 * Nothing here imports Three, the viewer or the DOM: that is what makes the
 * parity test (`tests/robot-program-model.node.test.ts`) a node test.
 */

/** Motion type of one instruction. Values parity-identical to `RobotMoveType`. */
export type RobotMoveType = 'PTP' | 'PTPUnsynced' | 'LIN';

/**
 * Where an instruction's {@link RobotMoveInstruction.JointAngles} came from.
 * Not a Unity field — see the module header.
 *
 * - `solved` — the export re-solved this waypoint and the solver answered.
 *   The only value a program may be shipped on without a second look.
 * - `baked` — the re-solve found no configuration, and the angles below are the
 *   ones the file carries from Unity. They describe a pose this rig could not
 *   reproduce today; a warning names the waypoint.
 * - `none` — no configuration at all. `JointAngles` are zeros, which is a
 *   perfectly valid-looking joint vector and would drive a real robot home.
 *   A vendor postprocessor must treat this as a refusal, never as data.
 */
export type RobotAnglesSource = 'solved' | 'baked' | 'none';

/**
 * Robot configuration descriptor — port of `RobotConfigFlags`. Computed once in
 * the core ({@link fillConfigFlags}); each vendor reads the subset it needs.
 */
export interface RobotConfigFlags {
  /** RoboDK-style R (0/1). */
  Rear: number;
  /** RoboDK-style L (0/1); Fanuc U/D. */
  Lower: number;
  /** RoboDK-style F (0/1); Fanuc N/F (J5>=0 -> 0). */
  Flip: number;
  /** ABB cfN = floor(deg/90), six entries; cf1/cf4/cf6 are read from here. */
  AbbConf: number[];
  /** Fanuc per-axis turn count = round(deg/360), six entries. */
  FanucTurns: number[];
  /** KUKA S (model-dependent, configurable, default 2). */
  KukaStatus: number;
  /** KUKA T bitfield: bit i set if JointAngles[i] < 0. */
  KukaTurn: number;
}

/** One motion line plus its side effects — port of `RobotMoveInstruction`. */
export interface RobotMoveInstruction {
  // ── Motion ──
  MoveType: RobotMoveType;
  /** Six joint angles in degrees (the solved or baked `AxisPos`; Unity's `AxisCorrection` is not added). */
  JointAngles: number[];
  /** Right-handed, mm — robot-local target position, mirrored Y, scaled. */
  PositionMm: [number, number, number];
  /** Right-handed quaternion in Unity component order (x, y, z, w). */
  RotationQuat: [number, number, number, number];
  /** Intrinsic ZYX in degrees as `[C, B, A]` = `[W, P, R]` — the Unity order. */
  EulerZYXDeg: [number, number, number];

  // ── Speed / blending ──
  /** `SpeedToTarget * SpeedOverride`, clamped to 0..1, times 100. */
  JointSpeedPct: number;
  LinSpeedMmS: number;
  LinAccelMmS2: number;
  /** 0 => fine/exact stop; >0 => zone / CNT / C_DIS. */
  BlendRadiusMm: number;
  EnableBlending: boolean;

  // ── Side effects executed at this target ──
  DwellSec: number;
  SetSignalName: string | null;
  SetSignalValue: boolean;
  WaitSignalName: string | null;
  WaitSignalValue: boolean;
  /** Convention-mapped gripper DO for PickAndPlace; null => none. */
  PickPlaceSignalName: string | null;
  /** Pick => true (close), Place => false (open). */
  PickPlaceSignalValue: boolean;

  // ── Configuration (computed once; each vendor reads the subset it needs) ──
  Config: RobotConfigFlags;

  /** Target name + diagnostics, emitted as a line comment. */
  Comment: string;

  /** Provenance of {@link JointAngles} — not a Unity field, see the header. */
  AnglesSource: RobotAnglesSource;
}

/** Why an export declined to produce a program at all (plan-773 E3, F21, E9). */
export interface RobotProgramRefusal {
  /**
   * `tier` — the solver licence tier is below `'pro'` (plan-773 E3).
   * `delivery` — this is a locally delivered build (ADR-022/023).
   * `fk` — the runtime forward-kinematics check on the FIRST waypoint breached
   *   its tolerance, so the tool chain this program would be written against is
   *   demonstrably not the one the robot has (plan-773 F21 / R1). Set by
   *   {@link ikPathToProgram}, which clears `Instructions` with it.
   * `angles` — a postprocessor was handed an instruction whose
   *   {@link RobotMoveInstruction.AnglesSource} is `'none'` (plan-773 E9).
   * `toolchain` — a CARTESIAN export was asked for on a program whose
   *   {@link RobotProgram.FkCheck} does not vouch for the tool chain (E9's
   *   graduation: the axis-based export still goes out).
   */
  code: 'tier' | 'delivery' | 'fk' | 'angles' | 'toolchain';
  /** A full sentence for the caller, naming what would lift the refusal. */
  message: string;
}

/**
 * The runtime forward-kinematics check of plan-773 F21 — not a Unity field.
 *
 * Unity has no such check because its export cannot lose the tool: the web's
 * can (a bake that claims no TCP node), and plan-772 measured what that costs
 * when it happens — 239.90 mm / 180.00° written into real robot code. So the
 * export measures the FIRST waypoint it solves, the same measurement
 * `web_robot_verify_fk` makes, and refuses on a breach instead of formatting
 * the error into a file.
 *
 * It is recorded on the program (rather than thrown away after the check)
 * because it is also E9's graduation criterion: the joint half of a program is
 * trustworthy whenever the angles are, while the Cartesian half is only as
 * good as the tool chain. A vendor reads `status` to decide.
 */
export interface RobotFkCheck {
  /**
   * - `ok` — measured, inside tolerance. Both halves may be exported.
   * - `breached` — measured, outside tolerance. The program is refused (`fk`).
   * - `unavailable` — not measurable (no TCP node, no joint chain, or the first
   *   waypoint did not solve). No claim either way: the axis-based export goes
   *   out, a Cartesian one is refused (`toolchain`).
   */
  status: 'ok' | 'breached' | 'unavailable';
  /** Why it is `unavailable` / what breached — a sentence for the caller. */
  reason: string;
  /** Position error in mm, null when `unavailable`. */
  positionErrorMm: number | null;
  /** Orientation error in degrees, null when `unavailable`. */
  orientationErrorDeg: number | null;
  /** The waypoint that was measured, null when none was. */
  targetName: string | null;
}

/**
 * Transient, vendor-neutral representation of a robot program produced from one
 * IKPath (plus its `StartNextPath` chain) — port of `RobotProgram`.
 *
 * Transient is literal: it is consumed by a postprocessor and discarded. It is
 * never persisted, never written into a document, and carries no object
 * references (plan-769) — only {@link sourcePathNodeId}.
 */
export interface RobotProgram {
  /** Program / module name (vendor-sanitized by the postprocessor). */
  Name: string;
  /** Tool identifier emitted into the program. */
  ToolName: string;
  /** `RobotIK.ToolOffset * scale` — approximate, NOT a verified RH tool frame. */
  ToolOffsetMm: [number, number, number];
  /** RobotIK node name (header comment / diagnostics). */
  SourceRobotName: string;
  /** Ordered move instructions. Empty whenever {@link refusal} is set. */
  Instructions: RobotMoveInstruction[];
  /** Unreachable target, gimbal lock, missing robot, field gaps, … */
  Warnings: string[];
  /** Identity of the first IKPath of the chain, `#`-free; null when it has none. */
  sourcePathNodeId: string | null;
  /** Set when the export declined — see {@link RobotProgramRefusal}. */
  refusal: RobotProgramRefusal | null;
  /**
   * The F21 forward-kinematics verdict on the first waypoint — see
   * {@link RobotFkCheck}. Null means the producer made no claim at all (a
   * hand-built program in a vendor test, say), which is NOT the same as
   * `'unavailable'`: an export that ran always sets one.
   */
  FkCheck: RobotFkCheck | null;
}

/**
 * The sentence `RobotPostProcessor.cs` puts on its own output, kept in ONE place
 * so the MCP answer (F18) and the UI (F19) cannot word it differently.
 *
 * It is not boilerplate: a reader who mistakes this for a finished program
 * drives an uncalibrated tool frame onto a real machine.
 */
export const ROBOT_PROGRAM_DISCLAIMER =
  'The generated output is a copy-paste text template for the target controller\'s program editor — '
  + 'NOT a complete, ready-to-run robot program (tool/base/frame/IO calibration stays on the controller).';

/** A fresh flag set with Unity's defaults (`KukaStatus` 2, everything else 0). */
export function newRobotConfigFlags(): RobotConfigFlags {
  return {
    Rear: 0,
    Lower: 0,
    Flip: 0,
    AbbConf: [0, 0, 0, 0, 0, 0],
    FanucTurns: [0, 0, 0, 0, 0, 0],
    KukaStatus: 2,
    KukaTurn: 0,
  };
}

/** A fresh instruction with Unity's field initialisers (`RobotProgram.cs:38-67`). */
export function newRobotMoveInstruction(): RobotMoveInstruction {
  return {
    MoveType: 'PTP',
    JointAngles: [0, 0, 0, 0, 0, 0],
    PositionMm: [0, 0, 0],
    RotationQuat: [0, 0, 0, 1],
    EulerZYXDeg: [0, 0, 0],
    JointSpeedPct: 100,
    LinSpeedMmS: 500,
    LinAccelMmS2: 100,
    BlendRadiusMm: 0,
    EnableBlending: false,
    DwellSec: 0,
    SetSignalName: null,
    SetSignalValue: true,
    WaitSignalName: null,
    WaitSignalValue: true,
    PickPlaceSignalName: null,
    PickPlaceSignalValue: false,
    Config: newRobotConfigFlags(),
    Comment: '',
    AnglesSource: 'none',
  };
}

/** A fresh, empty program with Unity's defaults (`ToolName` = `tool0`). */
export function newRobotProgram(): RobotProgram {
  return {
    Name: '',
    ToolName: 'tool0',
    ToolOffsetMm: [0, 0, 0],
    SourceRobotName: '(none)',
    Instructions: [],
    Warnings: [],
    sourcePathNodeId: null,
    refusal: null,
    FkCheck: null,
  };
}
