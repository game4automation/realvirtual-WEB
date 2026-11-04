// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * laserwelding-station-alignment.test.ts — plan-569 Teil 2/3: every station tool axis of the
 * LaserWeldingAssemblyStation demo sits on the axis of the jig nest it works in.
 *
 * Checked STATICALLY on the saved GLB (no viewer, no PLC) — the alignment is pure geometry, and
 * keeping it out of the viewer-booting suites makes it a seconds-long regression lock.
 *
 * The jig nests sit at a fixed offset from the pallet's lower edge, measured on the rotationally
 * symmetric discs inside the valve (`PART3*`, 18.9 x 2.5 x 18.9 mm): the AABB centre of an affinely
 * transformed body is the image of its centre, so for a disc it lies ON the part axis. The AABB
 * centre of the whole valve does NOT — it has a lateral port (45.3 mm in x against 38.4 mm in z) —
 * which is what the first estimate in plan-569 phase 0 got wrong. Derivation and the full
 * before/after table: plan-569 § Ausrichtungs-Messung.
 */

import { beforeAll, describe, expect, it } from 'vitest';

const MODEL = '/demo-realvirtual/LaserWeldingAssemblyStation.glb';
const NEST_RIGHT = 0.125003; // m from the pallet's lower edge — upright valve in the right jig
const NEST_LEFT = 0.045003; // m — turned valve in the left jig  (pitch exactly 80.000 mm)
const TOL = 0.00005; // 0.05 mm

/* eslint-disable @typescript-eslint/no-explicit-any */
describe('plan-569 — every station tool axis sits on its nest axis', () => {
  let gltf: any;
  beforeAll(async () => {
    const buf = await (await fetch(MODEL)).arrayBuffer();
    const len = new DataView(buf).getUint32(12, true);
    gltf = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 20, len)));
  }, 120_000); // the demo GLB is 21 MB

  const node = (name: string): any => {
    const hits = gltf.nodes.filter((n: any) => n.name === name);
    expect(hits.length, `${name}: ${hits.length} nodes`).toBe(1);
    return hits[0];
  };
  // every node used here sits on the top level or in identity groups (Kinematics/…, Plant/…,
  // plan-610), so its local x IS its world x
  const xOf = (name: string): number => { const n = node(name); return n.matrix ? n.matrix[12] : (n.translation?.[0] ?? 0); };
  const zOf = (name: string): number => { const n = node(name); return n.matrix ? n.matrix[14] : (n.translation?.[2] ?? 0); };
  // lower edge x of a pallet held by an index stopper, from the stopper's Block zone
  const stopX0 = (stopper: string): number => {
    const z = node(stopper).extras.realvirtual.Zone;
    expect(z.Block, `${stopper} blocks`).toBe(true);
    return xOf(stopper) + z.Center.x / 1000 - z.Size.x / 2000 - 0.170005;
  };
  const axisOf = (names: string[]): number => names.reduce((a, n) => a + xOf(n) / names.length, 0);

  it('the five index stops stand on one 300 mm pitch', () => {
    const x0 = [1, 2, 3, 4, 5].map((i) => stopX0(`Index0${i}_Stopper`));
    for (let i = 1; i < x0.length; i++) expect(x0[i] - x0[i - 1], `pitch ${i}`).toBeCloseTo(0.3, 6);
    expect(x0[0], 'Index01 pallet lower edge').toBeCloseTo(3.476484, 5);
  });

  it('every index lift holds the pallet it lifts (the window follows the stop)', () => {
    for (let i = 1; i <= 5; i++) {
      const lift = `Index0${i}_Lift`;
      const z = node(lift).extras.realvirtual.Zone;
      expect([z.Hold, z.Block], lift).toEqual([true, true]);
      const lo = xOf(lift) + z.Center.x / 1000 - z.Size.x / 2000;
      // the authored window is 169.7 mm for a 170.005 mm pallet, so it starts a hair inside it
      expect(lo - stopX0(`Index0${i}_Stopper`), lift).toBeCloseTo(-0.00013, 4);
    }
  });

  it('FG01 swing clamp is centred on the right nest axis', () => {
    const clamp = axisOf(['FG01_Gripper_A', 'FG01_Gripper_B']);
    expect(Math.abs(clamp - (stopX0('Index01_Stopper') + NEST_RIGHT))).toBeLessThan(TOL);
  });

  it('FG03 Gripper2 picks on the right nest axis and places on the left one', () => {
    const x0 = stopX0('Index03_Stopper');
    expect(Math.abs(xOf('FG03_Grip2') - (x0 + NEST_RIGHT)), 'pick').toBeLessThan(TOL);
    const x2 = node('FG03_X2').extras.realvirtual;
    // the stroke is the measured nest pitch, not the 100 mm axis limit it used to be
    expect(x2.Drive_Cylinder.MaxPos - x2.Drive_Cylinder.MinPos, 'X2 stroke [mm]').toBeCloseTo(80, 6);
    expect(x2.Drive.UpperLimit, 'X2 upper limit follows the stroke').toBeCloseTo(80, 6);
    const placed = x0 + NEST_RIGHT - (x2.Drive_Cylinder.MaxPos - x2.Drive_Cylinder.MinPos) / 1000;
    expect(Math.abs(placed - (x0 + NEST_LEFT)), 'place').toBeLessThan(TOL);
  });

  it('FG03 turnover axis R1 sits on the left nest axis, and its vertical axis works downwards', () => {
    expect(Math.abs(xOf('FG03_R1') - (stopX0('Index03_Stopper') + NEST_LEFT))).toBeLessThan(TOL);
    // plan-569 Teil 3: the drawn pose is the PARKED pose; only a downward stroke reaches the valve.
    const vert = node('FG03_Y1').extras.realvirtual;
    expect([vert.Drive_Cylinder.MinPos, vert.Drive_Cylinder.MaxPos, vert.Drive.StartPosition]).toEqual([0, -75, 0]);
  });

  it('FG05 three-finger chuck sits on the left nest axis in x and, after the 150 mm X stroke, in z', () => {
    const fingers = ['FG05_Gripper_1', 'FG05_Gripper_2', 'FG05_Gripper_3'];
    expect(Math.abs(axisOf(fingers) - (stopX0('Index05_Stopper') + NEST_LEFT)), 'x').toBeLessThan(TOL);
    const chuckZ = fingers.reduce((a, n) => a + zOf(n) / fingers.length, 0);
    const x = node('FG05_X').extras.realvirtual.Drive_Cylinder;
    expect(chuckZ + (x.MaxPos - x.MinPos) / 1000, 'z on the pallet centre line').toBeCloseTo(-4.855922, 4);
  });

  it('the pallet-referenced grip targets moved with the stop', () => {
    expect(xOf('FG05_CapSeat')).toBeCloseTo(4.720705, 5);
    expect(xOf('FG05_SeatSensor')).toBeCloseTo(4.711455, 5);
    expect(xOf('FG03_LeftSeat')).toBeCloseTo(4.108127, 5);
    // raised 4.9 mm in plan-569 Teil 3 so the 180 deg turn lands exactly on the CAD turned pose
    expect(node('FG03_LeftSeat').translation[1]).toBeCloseTo(0.95099, 5);
  });

  it('Station03 runs the transfer BEFORE the turnover', () => {
    const code: string = node('Station03').extras.realvirtual.PLCProgram.Code;
    const arms = [...code.matchAll(/^\s+(\d+): \(\* (.+) \*\)\s*$/gm)].map((m) => ({ n: Number(m[1]), c: m[2] }));
    expect(arms.length).toBe(66);
    arms.forEach((a, k) => expect(a.n, 'arms are numbered without gaps').toBe(k));
    const firstTransfer = arms.find((a) => /Axis(Y2|X2)|Gripper2/.test(a.c))!.n;
    const firstTurn = arms.find((a) => /Axis(Y1|X1|R1)|Gripper1/.test(a.c))!.n;
    expect(firstTransfer, 'the transfer group comes first').toBeLessThan(firstTurn);
    for (const m of code.matchAll(/Step := (\d+);/g)) expect(Number(m[1])).toBeLessThan(arms.length);
  });

  it('the turnover grip is gated by a plant sequence, not by the PLC alone', () => {
    const grip = node('FG03_Grip1').extras.realvirtual;
    expect(grip.Group.GroupName, 'rides on the R1 group').toBe('FG03_R1');
    expect(grip.Grip.OneBitControl).toBe(false);
    // deliberately small: a larger radius would find FG03_LeftSeat (104 mm away) and snap the
    // turned valve back into the upright pose
    expect(grip.Grip.GripTargetSearchRadius).toBe(50);
    expect(grip.Grip.SignalPick.path).toBe('Signals/Simulation/SIM_FG03_Grip1Pick');
    expect(grip.Grip.SignalPlace.path).toBe('Signals/FG03/FG03_Y_Gripper1_InHome');
    // ONE cycle anchor, then a LEVEL check — never a chain of edges. Arming on the pallet-arrival
    // edge and then consuming two further edges let the three drift into different station cycles,
    // and Gripper1 turned the already-turned valve of a Typ-4 pallet back (plan-569 § Wendeeinheit).
    const arm = node('FT2_ArmOnTransferClose').extras.realvirtual.LogicStep_WaitForSignalBool;
    expect([arm.Signal.path, arm.WaitForTrue, arm.Edge], 'arms on Gripper2 CLOSE COMMAND, once per cycle')
      .toEqual(['Signals/FG03/FG03_Y_Gripper2_WorkPos', true, 'Rising']);
    const disarm = node('FT3_DisarmIfNestEmpty').extras.realvirtual.LogicStep_JumpOnSignal;
    expect([disarm.Signal.path, disarm.JumpOn, disarm.JumpToStep], 'level check: no valve in the right nest -> disarm')
      .toEqual(['Signals/Simulation/SIM_FG03_RightNestValve', false, 'FT1_PickOff']);
  });
});
