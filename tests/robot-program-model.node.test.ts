// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * robot-program-model.node.test.ts — plan-773 Phase 4 T1: the TypeScript port of
 * the export mathematics computes what the C# original computes.
 *
 * ## Why this file is the whole defence against R4
 *
 * E1 chose a port over a shared Rust core, and bought one risk with it: the
 * mathematics can diverge between C# and TypeScript in SILENCE. Everything else
 * diverges loudly — a missing vendor is missing, a changed text looks changed —
 * but a wrong `floor` or a different rounding rule produces a program that is
 * plausible and wrong, and nothing in the viewer would show it.
 *
 * So the vectors below are not "some test values". They are the SAME fixed
 * vectors the four existing Unity feature tests assert on
 * (`Packages/io.realvirtual.professional/Tests/FeatureTests/RobotExport/`),
 * which are hand-built and need no robot and no solve
 * (`TestRobotExportABBOutput.cs:10-11`). Where a number below differs from the
 * number in those files, one of the two implementations is wrong.
 *
 * | here | Unity |
 * |---|---|
 * | Z90 → A=90, B=C=0, no gimbal | `TestRobotExportEulerZYX.cs:20-23` |
 * | Y90 → gimbal flagged | `TestRobotExportEulerZYX.cs:26-28` |
 * | `{135,-45,-10,-12,-30,51}` → cf1=1, cf4=-1, Flip=1, Lower=1, KukaTurn=30, KukaStatus=6, FanucTurns[0]=0 | `TestRobotExportConfigDerivation.cs:21-33` |
 *
 * ## And two things the Unity tests cannot cover
 *
 * - **The rounding rule.** `Mathf.RoundToInt` rounds half to EVEN;
 *   `Math.round` rounds half UP. A joint at exactly ±180° is the midpoint of
 *   `deg/360`, so the two languages would disagree by a whole turn. No Unity
 *   test pins this because in C# it is simply the language.
 * - **The frame composition.** Unity's converter is defined on Unity-frame
 *   input; the web's scene graph is glTF. Two different reflections are in play
 *   and applying one of them twice, or the wrong one, yields a mirrored
 *   program. The composition is asserted below so the claim in
 *   `rv-robot-coord.ts` is a test, not a comment.
 */

import { describe, expect, it } from 'vitest';
import {
  abbConfNumber, convertToRightHanded, fanucTurn, fillConfigFlags, kukaTurnBits,
  positionToRightHanded, quaternionToEulerZYX, quaternionToRotationVector, roundToIntUnity,
  type Quat, type Vec3,
} from '../src/core/robot-program/rv-robot-coord';
import {
  ROBOT_PROGRAM_DISCLAIMER, newRobotConfigFlags, newRobotMoveInstruction, newRobotProgram,
} from '../src/core/robot-program/rv-robot-program';
import {
  mirrorPositionGltfUnity, mirrorQuaternionGltfUnity,
} from '../src/core/engine/rv-coordinate-utils';
import { robotProgramDelivery, robotProgramExportGate } from '../src/core/robot-program/rv-robot-program-gate';
import { ikSolverRegistry } from '../src/core/engine/rv-ik-solver';
import { getAppConfig, setAppConfig } from '../src/core/rv-app-config';

/** 90° about Z, exactly as `TestRobotExportEulerZYX.cs:20` spells it. */
const Q_Z90: Quat = [0, 0, 0.70710678, 0.70710678];
/** 90° about Y — Unity's `Quaternion.Euler(0, 90, 0)`. */
const Q_Y90: Quat = [0, 0.70710678, 0, 0.70710678];
/** The angle set of `TestRobotExportConfigDerivation.cs:21`. */
const JOINTS = [135, -45, -10, -12, -30, 51];

describe('plan-773 T1 — ZYX Euler, against TestRobotExportEulerZYX.cs', () => {
  it('turns 90° about Z into A=90, B=C=0 and does not call it gimbal lock', () => {
    const { euler, gimbalLock } = quaternionToEulerZYX(Q_Z90);
    // euler is [C, B, A] — the Unity component order (x=C=W, y=B=P, z=A=R).
    expect(euler[2]).toBeCloseTo(90, 1);   // A (=R, Z)
    expect(euler[1]).toBeCloseTo(0, 1);    // B (=P, Y)
    expect(euler[0]).toBeCloseTo(0, 1);    // C (=W, X)
    expect(gimbalLock).toBe(false);
  });

  it('flags gimbal lock near |B| = 90°', () => {
    expect(quaternionToEulerZYX(Q_Y90).gimbalLock).toBe(true);
  });

  it('keeps the gimbal threshold at |B| > 89°, not >= 89°', () => {
    // The boundary is load-bearing: a vendor emits A/C from here, and at 89°
    // they are still defined. Build a quaternion with sin(B) = sin(88°).
    const b = (88 * Math.PI) / 180;
    const qY88: Quat = [0, Math.sin(b / 2), 0, Math.cos(b / 2)];
    const r = quaternionToEulerZYX(qY88);
    expect(r.euler[1]).toBeCloseTo(88, 1);
    expect(r.gimbalLock).toBe(false);
  });

  it('clamps asin rather than returning NaN on a slightly over-unit quaternion', () => {
    // Rounding in a long transform chain can push 2(wy − zx) a hair past 1.
    const over: Quat = [0, 0.7071080, 0, 0.7071080];
    const r = quaternionToEulerZYX(over);
    expect(Number.isNaN(r.euler[1])).toBe(false);
    expect(Math.abs(r.euler[1])).toBeLessThanOrEqual(90.0001);
  });
});

describe('plan-773 T1 — config flags, against TestRobotExportConfigDerivation.cs', () => {
  it('derives every flag of the fixed angle set exactly as Unity does', () => {
    const cfg = newRobotConfigFlags();
    fillConfigFlags(JOINTS, cfg);

    expect(cfg.AbbConf[0]).toBe(1);    // floor(135/90)
    expect(cfg.AbbConf[3]).toBe(-1);   // floor(-12/90)
    expect(cfg.Flip).toBe(1);          // J5 = -30 < 0 → F
    expect(cfg.Lower).toBe(1);         // J3 = -10 < 0 → D
    expect(cfg.KukaTurn).toBe(30);     // J2,J3,J4,J5 < 0 → 2+4+8+16
    expect(cfg.KukaStatus).toBe(6);    // default 2 | bit2 (A5 < 0)
    expect(cfg.FanucTurns[0]).toBe(0); // round(135/360)
  });

  it('leaves Rear at the documented default — it needs arm geometry', () => {
    const cfg = newRobotConfigFlags();
    fillConfigFlags(JOINTS, cfg);
    expect(cfg.Rear).toBe(0);
  });

  it('keeps KukaStatus at the bare default when A5 is non-negative', () => {
    const cfg = newRobotConfigFlags();
    fillConfigFlags([0, 0, 0, 0, 30, 0], cfg);
    expect(cfg.KukaStatus).toBe(2);
    expect(cfg.Flip).toBe(0);
    expect(cfg.Lower).toBe(0);
    expect(cfg.KukaTurn).toBe(0);
  });

  it('tolerates a short joint vector instead of reading past its end', () => {
    const cfg = newRobotConfigFlags();
    fillConfigFlags([10, 20], cfg);
    expect(cfg.AbbConf[0]).toBe(0);
    expect(cfg.Flip).toBe(1);  // joints.length <= 4 → the else branch, like C#
    expect(cfg.Lower).toBe(1); // joints.length <= 2 → the else branch
  });

  it('floors ABB config numbers instead of truncating them', () => {
    // The difference only shows on negatives, and only there does it matter:
    // trunc(-0.13) = 0, floor(-0.13) = -1 — and Unity floors.
    expect(abbConfNumber(135)).toBe(1);
    expect(abbConfNumber(-12)).toBe(-1);
    expect(abbConfNumber(-90)).toBe(-1);
    expect(abbConfNumber(0)).toBe(0);
  });

  it('sets a KUKA turn bit per negative axis and nothing else', () => {
    expect(kukaTurnBits([-1, 0, 0, 0, 0, 0])).toBe(1);
    expect(kukaTurnBits([0, 0, 0, 0, 0, -1])).toBe(32);
    expect(kukaTurnBits([-1, -1, -1, -1, -1, -1, -1])).toBe(63); // a 7th axis is ignored
  });
});

describe('plan-773 T1 — the rounding rule C# and JavaScript do not share', () => {
  it('rounds halves to EVEN, like Mathf.RoundToInt', () => {
    expect(roundToIntUnity(0.5)).toBe(0);
    expect(roundToIntUnity(1.5)).toBe(2);
    expect(roundToIntUnity(2.5)).toBe(2);
    expect(roundToIntUnity(-0.5)).toBe(0);
    expect(roundToIntUnity(-1.5)).toBe(-2);
    expect(roundToIntUnity(-2.5)).toBe(-2);
  });

  it('rounds everything else the ordinary way', () => {
    expect(roundToIntUnity(0.4)).toBe(0);
    expect(roundToIntUnity(0.6)).toBe(1);
    expect(roundToIntUnity(-0.6)).toBe(-1);
    expect(roundToIntUnity(359)).toBe(359);
  });

  it('gives a joint at exactly ±180° a turn count of 0, not 1', () => {
    // Math.round(0.5) would say 1 here and put a whole extra revolution into a
    // Fanuc program.
    expect(fanucTurn(180)).toBe(0);
    expect(fanucTurn(-180)).toBe(0);
    expect(fanucTurn(540)).toBe(2);
    expect(fanucTurn(135)).toBe(0);
    expect(fanucTurn(400)).toBe(1);
  });
});

describe('plan-773 T1 — the right-handed conversion', () => {
  it('mirrors Y on a position and leaves X and Z alone', () => {
    expect(positionToRightHanded([1, 2, 3])).toEqual([1, -2, 3]);
  });

  it('mirrors the Y component of a quaternion and leaves x, z, w alone', () => {
    expect(convertToRightHanded([0.1, 0.2, 0.3, 0.4])).toEqual([0.1, -0.2, 0.3, 0.4]);
  });

  it('is its own inverse, both of them', () => {
    const p: Vec3 = [1, 2, 3];
    expect(positionToRightHanded(positionToRightHanded(p))).toEqual(p);
    const q: Quat = [0.1, 0.2, 0.3, 0.4];
    expect(convertToRightHanded(convertToRightHanded(q))).toEqual(q);
  });

  it('turns a quaternion into an axis-angle rotation vector in radians', () => {
    // 90° about Z → magnitude π/2, direction +Z.
    const rv = quaternionToRotationVector(Q_Z90);
    expect(rv[0]).toBeCloseTo(0, 6);
    expect(rv[1]).toBeCloseTo(0, 6);
    expect(rv[2]).toBeCloseTo(Math.PI / 2, 6);
  });

  it('returns the zero vector for identity and takes the short way round', () => {
    expect(quaternionToRotationVector([0, 0, 0, 1])).toEqual([0, 0, 0]);
    // The negated quaternion is the SAME rotation and must give the same vector.
    const a = quaternionToRotationVector(Q_Z90);
    const b = quaternionToRotationVector([-Q_Z90[0], -Q_Z90[1], -Q_Z90[2], -Q_Z90[3]]);
    expect(b[2]).toBeCloseTo(a[2], 9);
  });
});

describe('plan-773 T1 — the frame composition glTF → Unity → vendor', () => {
  it('composes to a 180° turn about Z on a position: negate X AND Y', () => {
    const p: [number, number, number] = [1, 2, 3];
    mirrorPositionGltfUnity(p);                 // glTF → Unity: negate X
    expect(positionToRightHanded(p)).toEqual([-1, -2, 3]); // Unity → vendor: negate Y
  });

  it('composes on a quaternion to: negate Z only', () => {
    const q: [number, number, number, number] = [0.1, 0.2, 0.3, 0.4];
    mirrorQuaternionGltfUnity(q);               // glTF → Unity: negate Y and Z
    const out = convertToRightHanded(q);        // Unity → vendor: negate Y
    expect(out[0]).toBeCloseTo(0.1, 12);
    expect(out[1]).toBeCloseTo(0.2, 12);
    expect(out[2]).toBeCloseTo(-0.3, 12);
    expect(out[3]).toBeCloseTo(0.4, 12);
  });

  it('is NOT the identity — applying only one half yields a mirrored program', () => {
    const only: [number, number, number] = [1, 2, 3];
    expect(positionToRightHanded(only)).not.toEqual([-1, -2, 3]);
  });
});

describe('plan-773 T1 — the neutral model carries Unity\'s defaults', () => {
  it('starts an instruction on the C# field initialisers', () => {
    const m = newRobotMoveInstruction();
    expect(m.MoveType).toBe('PTP');
    expect(m.JointAngles).toHaveLength(6);
    expect(m.RotationQuat).toEqual([0, 0, 0, 1]);
    expect(m.JointSpeedPct).toBe(100);
    expect(m.LinSpeedMmS).toBe(500);
    expect(m.LinAccelMmS2).toBe(100);
    expect(m.BlendRadiusMm).toBe(0);
    expect(m.EnableBlending).toBe(false);
    expect(m.SetSignalValue).toBe(true);
    expect(m.WaitSignalValue).toBe(true);
    expect(m.Config.KukaStatus).toBe(2);
    expect(m.Config.AbbConf).toHaveLength(6);
    expect(m.Config.FanucTurns).toHaveLength(6);
  });

  it('starts a program named tool0 with no instructions and no refusal', () => {
    const p = newRobotProgram();
    expect(p.ToolName).toBe('tool0');
    expect(p.SourceRobotName).toBe('(none)');
    expect(p.Instructions).toHaveLength(0);
    expect(p.Warnings).toHaveLength(0);
    expect(p.refusal).toBeNull();
    expect(p.sourcePathNodeId).toBeNull();
  });

  it('gives every instruction its OWN config flags', () => {
    // A shared object would make the last waypoint's configuration overwrite
    // every earlier one — invisible until a vendor prints them.
    const a = newRobotMoveInstruction();
    const b = newRobotMoveInstruction();
    fillConfigFlags(JOINTS, a.Config);
    expect(b.Config.AbbConf[0]).toBe(0);
    expect(b.Config.KukaTurn).toBe(0);
  });

  it('states in ONE place that the output is a template, not a program', () => {
    // The sentence of RobotPostProcessor.cs:26-28. F18 and F19 must not word
    // it differently, so it is a constant rather than two string literals.
    expect(ROBOT_PROGRAM_DISCLAIMER).toContain('NOT a complete, ready-to-run robot program');
    expect(ROBOT_PROGRAM_DISCLAIMER).toContain('copy-paste');
  });
});

describe('plan-773 E3 — the export gate refuses before it computes anything', () => {
  it('reads a node test as a LOCAL delivery, because no bundle defines the dev constant', () => {
    // RV_SERVE_INFO is null outside `vite serve` by construction, and this pool
    // defines no globals — so the gate's default answer here is the delivered,
    // refused one.
    expect(robotProgramDelivery()).toBe('local');
  });

  it('refuses on the TIER first, naming the tier it found', () => {
    // No solver provider is registered in this pool → tier 'none'.
    const v = robotProgramExportGate();
    expect(v.allowed).toBe(false);
    expect(v.tier).toBe('none');
    expect(v.refusal?.code).toBe('tier');
    expect(v.refusal?.message).toContain('"none"');
  });

  it('always reports tier AND delivery, so a refusal is never a bare no', () => {
    const v = robotProgramExportGate();
    expect(v.tier).toBeDefined();
    expect(v.delivery).toBeDefined();
    expect(v.refusal).not.toBeNull();
  });

  it('refuses a LOCAL delivery even at the pro tier (ADR-022/023)', () => {
    // The one combination the browser suite cannot reach, because Vite serves
    // it and that counts as `'dev'`: a licensed solver in a delivered build.
    ikSolverRegistry.register({
      tier: 'pro',
      maxRobots: 8,
      canBlend: true,
      solvePieper: () => [],
      solveCobot: () => [],
    });
    try {
      const v = robotProgramExportGate();
      expect(v.tier).toBe('pro');
      expect(v.delivery).toBe('local');
      expect(v.allowed).toBe(false);
      expect(v.refusal?.code).toBe('delivery');
      expect(v.refusal?.message).toContain('hosted');
    } finally {
      ikSolverRegistry.register(null);
    }
  });

  it('opens once the delivery says hosted', () => {
    ikSolverRegistry.register({
      tier: 'pro',
      maxRobots: 8,
      canBlend: true,
      solvePieper: () => [],
      solveCobot: () => [],
    });
    const before = getAppConfig();
    setAppConfig({ ...before, hostedDeploy: true });
    try {
      const v = robotProgramExportGate();
      expect(v.delivery).toBe('hosted');
      expect(v.allowed).toBe(true);
      expect(v.refusal).toBeNull();
    } finally {
      setAppConfig(before);
      ikSolverRegistry.register(null);
    }
  });
});
