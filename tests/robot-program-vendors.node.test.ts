// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * robot-program-vendors.node.test.ts — plan-773 §8 T2: the ABB and SEW
 * postprocessors on a HAND-BUILT program.
 *
 * Hand-built on purpose, exactly as the Unity feature test says of itself
 * (`TestRobotExportABBOutput.cs:10-11`): no robot, no solver, no scene. A
 * postprocessor's whole job is to format numbers that somebody else computed,
 * so a test that first had to rig a robot would be testing the converter again
 * and would go red for reasons that have nothing to do with RAPID syntax.
 *
 * What the assertions are worth, in order:
 *
 * - **Structure** — a RAPID module really is `MODULE … PROC main() … ENDPROC
 *   ENDMODULE`, and a `.srlprg` really does carry the header / REALVAR / dynamic
 *   / MotionSet blocks before the first move. These are copy-paste templates:
 *   a missing `ENDMODULE` is a file the controller's editor rejects.
 * - **The two traps the ABB header names** — the `[w,x,y,z]` quaternion order
 *   and `MoveAbsJ` without `\WObj`. Both produce a file that PARSES either way,
 *   which is why they get their own assertions rather than a glance.
 * - **The refusals of E9** — `AnglesSource: 'none'` and the Cartesian/tool-chain
 *   pairing. A vendor that formatted six zeros would emit a valid-looking joint
 *   vector that drives a real robot home.
 *
 * The SEW header carries a timestamp, a UUID and a user name; all three are
 * injected here, because an assertion against `DateTime.Now` is a test that
 * fails at midnight.
 */

import { describe, expect, it } from 'vitest';
import {
  newRobotMoveInstruction, newRobotProgram,
  type RobotMoveInstruction, type RobotProgram,
} from '../src/core/robot-program/rv-robot-program';
import { fillConfigFlags } from '../src/core/robot-program/rv-robot-coord';
import { fmtInvariant } from '../src/core/robot-program/rv-robot-postprocessor';
import {
  ROBOT_VENDORS, ROBOT_VENDOR_IDS, isRobotVendorId, loadRobotPostProcessor,
} from '../src/core/robot-program/rv-robot-vendors';

/** A waypoint with everything a vendor reads, so nothing is left at a default. */
function waypoint(over: Partial<RobotMoveInstruction> = {}): RobotMoveInstruction {
  const m = newRobotMoveInstruction();
  m.JointAngles = [135, -45, -10, -12, -30, 51];
  m.PositionMm = [1200.5, -340.25, 870];
  // [x, y, z, w] — the house tuple. RAPID wants [w,x,y,z]; that reordering is
  // the vendor's job and is asserted below.
  m.RotationQuat = [0.1, 0.2, 0.3, 0.927];
  m.EulerZYXDeg = [11, 22, 33]; // [C, B, A] = [W, P, R]
  m.LinSpeedMmS = 250;
  m.JointSpeedPct = 80;
  m.Comment = 'P1';
  m.AnglesSource = 'solved';
  fillConfigFlags(m.JointAngles, m.Config);
  return Object.assign(m, over);
}

/** A two-waypoint program with one side effect of every kind. */
function program(over: Partial<RobotProgram> = {}): RobotProgram {
  const p = newRobotProgram();
  p.Name = 'Pick Place 1';
  p.ToolName = 'tool0';
  p.SourceRobotName = 'TestRobot';
  p.ToolOffsetMm = [0, 0, 120];
  p.Instructions = [
    waypoint(),
    waypoint({
      MoveType: 'LIN',
      Comment: 'P2',
      EnableBlending: true,
      BlendRadiusMm: 27,
      DwellSec: 1.5,
      SetSignalName: 'DO_Clamp',
      SetSignalValue: true,
      WaitSignalName: 'DI_Ready',
      WaitSignalValue: true,
      PickPlaceSignalName: 'GRIPPER_tool0',
      PickPlaceSignalValue: true,
    }),
  ];
  p.FkCheck = {
    status: 'ok', reason: 'verified', positionErrorMm: 0.01, orientationErrorDeg: 0.01, targetName: 'P1',
  };
  return Object.assign(p, over);
}

const SEW_FIXED = {
  generatedAt: new Date(2026, 9, 24, 13, 5, 7), // local time, like DateTime.Now
  uuid: '00000000-0000-4000-8000-000000000000',
};

describe('plan-773 T2 — the vendor catalogue', () => {
  it('lists exactly the Phase 5 vendors, in the E2 order', () => {
    expect([...ROBOT_VENDOR_IDS]).toEqual(['abb-rapid', 'sew-srlprg']);
  });

  it('guards a wire value', () => {
    expect(isRobotVendorId('abb-rapid')).toBe(true);
    expect(isRobotVendorId('kuka-krl')).toBe(false); // Phase 6, not yet
    expect(isRobotVendorId(7)).toBe(false);
  });

  it('the static metadata matches the loaded class (the duplication is asserted)', async () => {
    for (const id of ROBOT_VENDOR_IDS) {
      const pp = await loadRobotPostProcessor(id);
      expect(pp.displayName, id).toBe(ROBOT_VENDORS[id].displayName);
      expect(pp.fileExtension, id).toBe(ROBOT_VENDORS[id].fileExtension);
    }
  });

  it('axisBased defaults to true (plan-773 E9) and is settable', async () => {
    expect((await loadRobotPostProcessor('abb-rapid')).axisBased).toBe(true);
    expect((await loadRobotPostProcessor('abb-rapid', { axisBased: false })).axisBased).toBe(false);
  });
});

describe('plan-773 T2 — the invariant formatter', () => {
  it('writes a decimal POINT and three decimals at most', () => {
    expect(fmtInvariant(1.5)).toBe('1.5');
    expect(fmtInvariant(1234.56789)).toBe('1234.568');
    expect(fmtInvariant(-45)).toBe('-45');
    expect(fmtInvariant(0)).toBe('0');
  });

  it('never writes "-0" (C# prints 0, and a signed zero reads like a sign that was meant)', () => {
    expect(fmtInvariant(-0)).toBe('0');
    expect(fmtInvariant(-0.0001)).toBe('0');
  });

  it('is finite-safe', () => {
    expect(fmtInvariant(Number.NaN)).toBe('0');
    expect(fmtInvariant(Number.POSITIVE_INFINITY)).toBe('0');
  });
});

describe('plan-773 T2 — ABB RAPID', () => {
  const abb = async (opts = {}, prog = program()) => {
    const pp = await loadRobotPostProcessor('abb-rapid', opts);
    const r = pp.emit(prog);
    if (!r.ok) throw new Error(`refused: ${r.refusal.message}`);
    return r;
  };

  it('emits one .mod file, named from a sanitized program name', async () => {
    const r = await abb();
    expect(r.files).toHaveLength(1);
    // "Pick Place 1" -> spaces are illegal in a RAPID identifier.
    expect(r.files[0].fileName).toBe('Pick_Place_1.mod');
    expect(r.vendor).toBe('ABB RAPID');
  });

  it('is a well-formed module', async () => {
    const t = (await abb()).files[0].content;
    expect(t.startsWith('MODULE Pick_Place_1\n')).toBe(true);
    expect(t).toContain('    PROC main()');
    expect(t).toContain('    ENDPROC');
    expect(t.trimEnd().endsWith('ENDMODULE')).toBe(true);
    // The constants come BEFORE the procedure that uses them.
    expect(t.indexOf('CONST jointtarget')).toBeLessThan(t.indexOf('PROC main()'));
  });

  it('defaults to MoveAbsJ with the solved angles 1:1, and WITHOUT \\WObj', async () => {
    const t = (await abb()).files[0].content;
    expect(t).toContain('CONST jointtarget jt_p0 := [[135, -45, -10, -12, -30, 51], [9E9,9E9,9E9,9E9,9E9,9E9]];');
    expect(t).toContain('MoveAbsJ jt_p0, v200, fine, tool0;');
    // A joint move is work-object independent — the argument is a RAPID error.
    for (const line of t.split('\n').filter((l) => l.includes('MoveAbsJ'))) {
      expect(line, line).not.toContain('WObj');
    }
  });

  it('writes the robtarget quaternion as [w,x,y,z], not as the house tuple', async () => {
    const t = (await abb()).files[0].content;
    // RotationQuat is [0.1, 0.2, 0.3, 0.927] = [x,y,z,w] -> [0.927, 0.1, 0.2, 0.3].
    expect(t).toContain('[0.927, 0.1, 0.2, 0.3]');
    expect(t).not.toContain('[0.1, 0.2, 0.3, 0.927]');
  });

  it('emits MoveL with a robtarget and the work object', async () => {
    const t = (await abb()).files[0].content;
    expect(t).toContain('CONST robtarget p_p1 := [[1200.5, -340.25, 870], ');
    expect(t).toContain('MoveL p_p1, v200, z20, tool0 \\WObj:=wobj0;');
  });

  it('derives the robconf from the axis angles (cf1/cf4/cf6/cfx)', async () => {
    const t = (await abb()).files[0].content;
    // floor(135/90)=1, floor(-12/90)=-1, floor(51/90)=0, A5=-30<0 -> cfx=1.
    expect(t).toContain('[1, -1, 0, 1], [9E9,9E9,9E9,9E9,9E9,9E9]];');
  });

  it('snaps the speed to a predefined v#### by default, and declares a speeddata otherwise', async () => {
    expect((await abb()).files[0].content).toContain('v200'); // 250 mm/s -> v200
    const raw = (await abb({ snapToPredefined: false })).files[0].content;
    expect(raw).toContain('CONST speeddata v_seg0 := [250, 500, 5000, 1000];');
    expect(raw).toContain('MoveAbsJ jt_p0, v_seg0, fine, tool0;');
  });

  it('blending becomes a zone, no blending stays fine', async () => {
    const t = (await abb()).files[0].content;
    expect(t).toContain(', fine, '); // waypoint 0: EnableBlending false
    expect(t).toContain(', z20, '); // waypoint 1: 27 mm -> the z20 below it
  });

  it('emits the side effects in execution order (gripper, signal, dwell, wait)', async () => {
    const body = (await abb()).files[0].content;
    const order = ['SetDO GRIPPER_tool0, 1;', 'SetDO DO_Clamp, 1;', 'WaitTime 1.5;', 'WaitDI DI_Ready, 1;']
      .map((s) => body.indexOf(s));
    expect(order.every((i) => i >= 0), body).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('names the mode and the tool offset in the header comments', async () => {
    expect((await abb()).files[0].content).toContain('! Mode: MoveAbsJ (axis-based) -- robconf-free');
    expect((await abb()).files[0].content).toContain('! ToolOffset (approx, mm): [0, 0, 120]');
    expect((await abb({ axisBased: false })).files[0].content).toContain('! Mode: Cartesian (MoveJ/MoveL)');
  });

  it('Cartesian mode turns the PTP into MoveJ + robtarget', async () => {
    const t = (await abb({ axisBased: false })).files[0].content;
    expect(t).toContain('MoveJ p_p0, v200, fine, tool0 \\WObj:=wobj0;');
    expect(t).not.toContain('MoveAbsJ');
  });

  it('carries the disclaimer verbatim and the program warnings', async () => {
    const prog = program();
    prog.Warnings.push('a warning the converter made');
    const r = await abb({}, prog);
    expect(r.disclaimer).toContain('copy-paste text template');
    expect(r.warnings).toContain('a warning the converter made');
  });
});

describe('plan-773 T2 — SEW MOVI-C', () => {
  const sew = async (opts = {}, prog = program()) => {
    const pp = await loadRobotPostProcessor('sew-srlprg', { ...SEW_FIXED, ...opts });
    const r = pp.emit(prog);
    if (!r.ok) throw new Error(`refused: ${r.refusal.message}`);
    return r;
  };

  it('emits one .srlprg file with a sanitized name', async () => {
    const r = await sew();
    expect(r.files).toHaveLength(1);
    expect(r.files[0].fileName).toBe('Pick_Place_1.srlprg');
    expect(r.vendor).toBe('SEW MOVI-C (.srlprg)');
  });

  it('writes the header block with KINEMATIC, UUID and the pinned timestamp', async () => {
    const t = (await sew()).files[0].content;
    expect(t).toContain('// PROGRAM:   Pick_Place_1');
    expect(t).toContain('// GENERATED: 2026-10-24 13:05:07');
    expect(t).toContain('// USER:      realvirtual');
    expect(t).toContain('// KINEMATIC: 1');
    expect(t).toContain('// UUID:      {00000000-0000-4000-8000-000000000000}');
    expect(t).toContain('// SOURCE:    realvirtual Robot Program Export');
  });

  it('honours the project-specific header constants', async () => {
    const t = (await sew({ kinematicNumber: 4, motionSet: 2, coordinateSystem: 'Tool' })).files[0].content;
    expect(t).toContain('// KINEMATIC: 4');
    expect(t).toContain('MotionSet := 2');
    expect(t).toContain('// CoordinateSystem := Tool');
  });

  it('gives every distinct signal a REALVAR slot, in order of first appearance', async () => {
    const t = (await sew({ realVarBaseIndex: 20 })).files[0].content;
    // Order within a waypoint: PickPlace, Set, Wait.
    expect(t).toContain('// mapped from: GRIPPER_tool0\nREALVAR[20] := 0.0');
    expect(t).toContain('// mapped from: DO_Clamp\nREALVAR[21] := 0.0');
    expect(t).toContain('// mapped from: DI_Ready\nREALVAR[22] := 0.0');
  });

  it('says so when a program references no signal at all', async () => {
    const bare = program();
    bare.Instructions = [waypoint()];
    expect((await sew({}, bare)).files[0].content).toContain('// (no program signals)');
  });

  it('emits the dynamic-values and motion-setup blocks before the first move', async () => {
    const t = (await sew()).files[0].content;
    expect(t).toContain('TransVel := 100     TransAcc := 1000     TransDec := 1000     TransJerk := 10000');
    expect(t).toContain('J6Vel := 100   J6Acc := 1000   J6Dec := 1000   J6Jerk := 10000');
    expect(t).toContain('BlendRefersToTarget := TRUE');
    expect(t.indexOf('// --- Main Program ---')).toBeLessThan(t.indexOf('PTP_J'));
    expect(t.trimEnd().endsWith('END_PROG')).toBe(true);
  });

  it('PTP_J carries the six joint angles and the blend distance', async () => {
    const t = (await sew()).files[0].content;
    expect(t).toContain('PTP_J J1 := 135 J2 := -45 J3 := -10 J4 := -12 J5 := -30 J6 := 51 BlendDist := 0');
    expect(t).toContain('// Move PTP to point: P1  (speed 80%)');
  });

  it('LIN maps EulerZYXDeg [C,B,A] onto RotZ/RotY/RotX, not the tuple order', async () => {
    const t = (await sew()).files[0].content;
    // EulerZYXDeg = [11, 22, 33] = [C, B, A]: RotZ = A = 33, RotY = B = 22, RotX = C = 11.
    expect(t).toContain('LIN X := 1200.5 Y := -340.25 Z := 870 RotZ := 33 RotY := 22 RotX := 11 BlendDist := 27');
  });

  it('writes the signal, dwells, and warns ONCE that the input-wait form is unverified', async () => {
    const r = await sew();
    const t = r.files[0].content;
    expect(t).toContain('GRIPPER_tool0 := 1');
    expect(t).toContain('DO_Clamp := 1');
    expect(t).toContain('WAIT_TIME 1.5');
    expect(t).toContain('WAIT_UNTIL DI_Ready == 1');
    const warned = r.warnings.filter((w) => w.includes('WAIT_UNTIL'));
    expect(warned).toHaveLength(1);
  });

  it('a second emit() does not accumulate the previous run (buffer and warnings reset)', async () => {
    const pp = await loadRobotPostProcessor('sew-srlprg', SEW_FIXED);
    const first = pp.emit(program());
    const second = pp.emit(program());
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.files[0].content).toBe(first.files[0].content);
    expect(second.warnings).toEqual(first.warnings);
  });
});

describe('plan-773 T2 / E9 — what a vendor refuses', () => {
  it('passes an upstream refusal through untouched instead of restating it', async () => {
    const p = program();
    p.refusal = { code: 'tier', message: 'the licence gate said so' };
    p.Instructions = [];
    for (const id of ROBOT_VENDOR_IDS) {
      const r = (await loadRobotPostProcessor(id)).emit(p);
      expect(r.ok, id).toBe(false);
      if (r.ok) continue;
      expect(r.refusal.code).toBe('tier');
      expect(r.refusal.message).toBe('the licence gate said so');
    }
  });

  it('refuses an empty program rather than writing an empty file', async () => {
    const p = program();
    p.Instructions = [];
    const r = (await loadRobotPostProcessor('abb-rapid')).emit(p);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.refusal.code).toBe('angles');
    expect(r.refusal.message).toContain('no waypoints');
  });

  it('refuses AnglesSource "none" instead of formatting six zeros (E9)', async () => {
    const p = program();
    p.Instructions[1].AnglesSource = 'none';
    p.Instructions[1].JointAngles = [0, 0, 0, 0, 0, 0];
    for (const id of ROBOT_VENDOR_IDS) {
      const r = (await loadRobotPostProcessor(id)).emit(p);
      expect(r.ok, id).toBe(false);
      if (r.ok) continue;
      expect(r.refusal.code).toBe('angles');
      expect(r.refusal.message).toContain('P2');
      expect(r.refusal.message).toContain('home pose');
    }
  });

  it('accepts AnglesSource "baked" — the file\'s own angles are data, not a gap', async () => {
    const p = program();
    p.Instructions[0].AnglesSource = 'baked';
    const r = (await loadRobotPostProcessor('abb-rapid')).emit(p);
    expect(r.ok).toBe(true);
  });

  it('refuses a CARTESIAN export when the tool chain is not vouched for, and lets the axis one out', async () => {
    const p = program();
    p.FkCheck = {
      status: 'unavailable', reason: 'this robot has no resolved TCP node.',
      positionErrorMm: null, orientationErrorDeg: null, targetName: 'P1',
    };
    const cart = (await loadRobotPostProcessor('abb-rapid', { axisBased: false })).emit(p);
    expect(cart.ok).toBe(false);
    if (!cart.ok) {
      expect(cart.refusal.code).toBe('toolchain');
      expect(cart.refusal.message).toContain('no resolved TCP node');
    }
    // E9's graduation: the joint half of the same program still goes out.
    expect((await loadRobotPostProcessor('abb-rapid', { axisBased: true })).emit(p).ok).toBe(true);
  });

  it('a breached FK check refuses in BOTH modes (it arrives as the program\'s refusal)', async () => {
    const p = program();
    p.refusal = { code: 'fk', message: 'off by 239.9 mm' };
    p.Instructions = [];
    for (const axisBased of [true, false]) {
      const r = (await loadRobotPostProcessor('abb-rapid', { axisBased })).emit(p);
      expect(r.ok, String(axisBased)).toBe(false);
      if (!r.ok) expect(r.refusal.code).toBe('fk');
    }
  });

  it('a program with NO FkCheck claim at all may still be exported Cartesian', async () => {
    // A hand-built program (this file, another producer) makes no claim; only a
    // measurement that came back `unavailable` or `breached` is a refusal.
    const p = program();
    p.FkCheck = null;
    expect((await loadRobotPostProcessor('abb-rapid', { axisBased: false })).emit(p).ok).toBe(true);
  });
});
