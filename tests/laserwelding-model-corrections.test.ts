// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * laserwelding-model-corrections.test.ts — plan-570: the customer corrections of
 * the Laser Welding Assembly Station demo, checked on the SAVED GLB (static
 * part, parsed from the file) and on the RELOADED model (dynamic part).
 *
 * - F4  Belt_Return ↔ Transport01, Belt_Main ↔ Transport02
 * - F5  gripper Out/In and IsOut/IsIn swapped (FG01, FG03 ×2, FG05), start in the new home pose
 * - F5b FG03 X1/Y1 signals swapped; X1 (vertical node) works DOWNWARDS from the drawn parked pose
 *       (inverted by plan-569 Teil 3 — see the test body for the geometric reason)
 * - F6  Stopper01/02 on the return conveyor, Stopper02 directly before Lift01, no sim-only return stopper
 * - F7  every stopper output has exactly one writer (Lift01: Stopper01/02, Entry: Stopper03)
 * - F8  the Index01..05 lifts LIFT the pallet (Zone with Hold + Block riding on the lift) — the
 *       spike criteria of review #7: take-over from the running belt, XY standstill during
 *       the stroke, return stroke and hand-back to the belt, the neighbouring pallet,
 *       stop and reset in the middle of the stroke, signal edges
 * - F10 valve modes: 24 DoubleActing, 12 SingleActingPositive, Stopper05 Legacy
 *
 * The index lifts are driven by forcing (a PLC connected) — no station program
 * switches them in the virtual PLC.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { PlcPlugin } from '@rv-private/plugins/plc/plc-plugin';
import { registerPlcProgramComponent } from '@rv-private/plc/rv-plc-program';
import { getPlcRuntime } from '../src/core/plc-control';
import { createTestViewer, type TestViewerHandle } from './helpers/create-test-viewer';
import type { RVViewer } from '../src/core/rv-viewer';

const MODEL = '/demo-realvirtual/LaserWeldingAssemblyStation.glb';
const DT = 1 / 60;
const TEST_PLC = 'test-plc';
const T = 'Signals/FG_Transport/';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;
interface MULike {
  getName(): string;
  heldBy: string | null;
  aabb: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } };
}

// ── Static part: the saved GLB ───────────────────────────────────────────

let gltf: Json;
const nodeByName = (name: string): Json => {
  const hits = gltf.nodes.filter((n: Json) => n.name === name);
  if (hits.length !== 1) throw new Error(`${name}: ${hits.length} nodes`);
  return hits[0];
};
const rv = (name: string): Json => nodeByName(name).extras?.realvirtual ?? {};
const refPath = (r: Json): string | undefined => r?.path;

async function readGltfJson(url: string): Promise<Json> {
  const buf = await (await fetch(url)).arrayBuffer();
  const view = new DataView(buf);
  const len = view.getUint32(12, true);
  return JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 20, len)));
}

describe('plan-570 — the saved GLB (static)', () => {
  beforeAll(async () => { gltf = await readGltfJson(MODEL); }, 60_000);

  it('F4: Belt_Return is driven by Transport01, Belt_Main by Transport02', () => {
    const ret = rv('Belt_Return').Drive_Simple;
    const main = rv('Belt_Main').Drive_Simple;
    expect(refPath(ret.Forward)).toBe(`${T}FG_TS_Transport01_M_Conveyor_Plus`);
    expect(refPath(ret.Backward)).toBe(`${T}FG_TS_Transport01_M_Conveyor_Minus`);
    expect(refPath(main.Forward)).toBe(`${T}FG_TS_Transport02_M_Conveyor_Plus`);
    expect(refPath(main.Backward)).toBe(`${T}FG_TS_Transport02_M_Conveyor_Minus`);
  });

  it('F5: gripper commands and feedback are swapped; the grippers start in the new home pose (MaxPos)', () => {
    const cases: [string, string][] = [
      ['FG01_Gripper_A', 'Signals/FG01/FG01_Y_Gripper_'],
      ['FG03_Gripper1_A', 'Signals/FG03/FG03_Y_Gripper1_'],
      ['FG03_Gripper2_A', 'Signals/FG03/FG03_Y_Gripper2_'],
      ['FG05_Gripper_1', 'Signals/FG05/FG05_Y_Gripper_'],
    ];
    for (const [node, p] of cases) {
      const c = rv(node).Drive_Cylinder;
      expect(refPath(c.Out), node).toBe(`${p}HomePos`);
      expect(refPath(c.In), node).toBe(`${p}WorkPos`);
      expect(refPath(c.IsOut), node).toBe(`${p}InHome`);
      expect(refPath(c.IsIn), node).toBe(`${p}InWork`);
      expect(rv(node).Drive.StartPosition, node).toBe(c.MaxPos);
    }
  });

  it('F5b: FG03 X1 and Y1 signals are swapped; X1 (vertical node FG03_Y1) works downwards', () => {
    const vert = rv('FG03_Y1');
    const horiz = rv('FG03_X1').Drive_Cylinder;
    expect(refPath(vert.Drive_Cylinder.Out)).toBe('Signals/FG03/FG03_Y_AxisX1_WorkPos');
    expect(refPath(vert.Drive_Cylinder.In)).toBe('Signals/FG03/FG03_Y_AxisX1_HomePos');
    expect(refPath(vert.Drive_Cylinder.IsIn)).toBe('Signals/FG03/FG03_Y_AxisX1_InHome');
    // plan-569 Teil 3 inverted this cylinder (was [-75, 0, -75], i.e. home at the LOWER limit).
    // The drawn GLB pose is the PARKED pose above the pallet, not the working pose: the jaws only
    // enclose the valve body while the turn axis sits 43.7…130.6 mm above the pallet underside, and
    // from the drawn pose (+162.5 mm) only a downward 75 mm stroke reaches that window (+87.5 mm) —
    // which is also where the CAD-derived turn centre lies (+83.5…+85.1 mm). With home at the lower
    // limit the turnover gripper can never reach a part, which is why it ran empty until now.
    // This contradicts one line of the customer's change list (570 F5b "Grundstellung X1 unten");
    // the geometry is unambiguous and the axis naming in that same list was already swapped.
    // Open for confirmation by Andreas — see plan-569 § Wendeeinheit.
    expect([vert.Drive_Cylinder.MinPos, vert.Drive_Cylinder.MaxPos, vert.Drive.StartPosition]).toEqual([0, -75, 0]);
    expect(refPath(horiz.Out)).toBe('Signals/FG03/FG03_Y_AxisY1_WorkPos');
    expect(refPath(horiz.In)).toBe('Signals/FG03/FG03_Y_AxisY1_HomePos');
    expect(refPath(horiz.IsIn)).toBe('Signals/FG03/FG03_Y_AxisY1_InHome');
  });

  it('F6/F7: no sim-only return stopper left; every stopper output has exactly one writer', () => {
    const text = JSON.stringify(gltf);
    expect(text.match(/ReturnStopper|Stopper_Return/g) ?? []).toEqual([]);
    const programs = gltf.nodes.map((n: Json) => n.extras?.realvirtual?.PLCProgram).filter(Boolean);
    const writers = (sig: string) => programs.filter((p: Json) => p.Code.includes(`${sig} := `)).map((p: Json) => p.Name);
    expect(writers('FG_TS_Stopper01_Y_Stopper_WorkPos')).toEqual(['Lift01']);
    expect(writers('FG_TS_Stopper02_Y_Stopper_WorkPos')).toEqual(['Lift01']);
    expect(writers('FG_TS_Stopper03_Y_Stopper_WorkPos')).toEqual(['Entry']);
  });

  it('F10: valve modes as in the assignment table (24 DoubleActing, 12 SingleActingPositive, Stopper05 Legacy)', () => {
    const count: Record<string, number> = {};
    const legacy: string[] = [];
    for (const n of gltf.nodes) {
      const c = n.extras?.realvirtual?.Drive_Cylinder;
      if (!c) continue;
      const m = c.Mode ?? 'Legacy';
      count[m] = (count[m] ?? 0) + 1;
      if (m === 'Legacy') legacy.push(n.name);
      // Rule: two command signals → DoubleActing, one → SingleActingPositive.
      if (c.Out && c.In) expect(m, n.name).toBe('DoubleActing');
      else if (c.Out) expect(m, n.name).toBe('SingleActingPositive');
    }
    expect(count).toEqual({ DoubleActing: 24, SingleActingPositive: 12, Legacy: 1 });
    expect(legacy).toEqual(['Stopper05']);
  });

  it('F8: every index lift carries a Hold + Block zone activated while it is away from home', () => {
    for (let k = 1; k <= 5; k++) {
      const z = rv(`Index0${k}_Lift`).Zone;
      expect(z, `Index0${k}_Lift`).toBeTruthy();
      expect([z.Hold, z.Detect, z.Block, z.Activation, z.InvertSignal, z.HoldCount]).toEqual([true, false, true, 'Signal', true, 'One']);
      expect(refPath(z.ActivationSignal)).toBe(`${T}FG_TS_Index0${k}_Y_Lift_InHome`);
      // Box = footprint of the pallet waiting at the raised Index stopper (lift-local x -50.85..+118.85 mm).
      // plan-569 Teil 2 moved the pallet stop downstream by 7.455 mm, so this window followed it
      // (26.55 → 34.005); the lift NODE did not move — it is the datum of the CAD positioning unit
      // whose locating pins already sat on the corrected pallet centre.
      expect([z.Center.x, z.Size.x]).toEqual([34.005, 169.7]);
    }
  });
});

// ── Dynamic part: the reloaded model ─────────────────────────────────────

let handle: TestViewerHandle;
let viewer: RVViewer;
const v = (): any => viewer as any;
const store = () => v().signalStore;
const sig = (name: string): boolean => store().get(name) === true;
const setSig = (name: string, value: boolean): void => store().set(name, value);
const force = (name: string, value: boolean): void => store().forceSignal(name, value);
const mus = (): MULike[] => v().transportManager.mus as MULike[];

function tick(seconds: number, each?: () => void): void {
  const n = Math.max(1, Math.round(seconds / DT));
  for (let i = 0; i < n; i++) {
    v()._tickOnce(DT);
    viewer.scene.updateMatrixWorld();
    each?.();
  }
}
function until(pred: () => boolean, max: number, what: string): void {
  for (let i = 0; i < Math.round(max / DT); i++) {
    if (pred()) return;
    tick(DT);
  }
  if (!pred()) {
    const st = ['FG_TS_Index01_Y_Stopper_InHome', 'FG_TS_Index01_Y_Lift_InHome', 'FG_TS_Index01_Y_Lift_InWork', 'FG_TS_Index01_B_Detect', 'SIM_MotionEnable']
      .map((n) => `${n}=${sig(n)}`).join(' ');
    const l = mus().filter((m) => m.aabb.min.x > 3.2 && m.aabb.min.x < 4).map((m) => `${m.getName()}@${m.aabb.min.x.toFixed(3)},${m.aabb.min.y.toFixed(3)}${m.heldBy ? '[' + m.heldBy + ']' : ''}`).join(' ');
    throw new Error(`timeout after ${max} s: ${what} [${st}] [${l}]`);
  }
}
async function plcRunning(): Promise<void> {
  for (let i = 0; i < 300; i++) {
    const ps = getPlcRuntime()?.programs() ?? [];
    if (ps.length >= 11 && ps.every((p: any) => p.state === 'running')) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('PLC programs not running');
}
async function restart(): Promise<void> {
  store().unforceAll();
  // A forced value stays after unforce: release every index command so the level-based
  // cylinders start from home (no station program writes the index lifts).
  for (let k = 1; k <= 5; k++) {
    for (const s of ['Lift_WorkPos', 'Lift_HomePos', 'Stopper_WorkPos']) setSig(`FG_TS_Index0${k}_Y_${s}`, false);
  }
  for (const s of ['Stopper01', 'Stopper02', 'Stopper03']) setSig(`FG_TS_${s}_Y_Stopper_WorkPos`, false);
  setSig('i_SS_ESTOP1', true);
  setSig('i_SS_ESTOP2', true);
  viewer.connectionMode.interfaceDisconnected(TEST_PLC);
  tick(DT);
  viewer.resetSimulation();
  await plcRunning();
  tick(DT);
}
function connect(): void {
  viewer.connectionMode.interfaceConnected(TEST_PLC);
  viewer.connectionMode.interfaceWrites(TEST_PLC, ['FG_TS_Transport01_M_Conveyor_Plus']);
  tick(DT * 2);
}
const worldPos = (name: string): Vector3 => {
  const o = viewer.scene.getObjectByName(name);
  if (!o) throw new Error(`${name} missing`);
  return o.getWorldPosition(new Vector3());
};
/** The pallet held at Index01: the one whose centre lies over the Index01 lift (x 3.46..3.64). */
const atIndex01 = (): MULike | undefined => mus().find((m) => {
  const cx = (m.aabb.min.x + m.aabb.max.x) / 2;
  return m.aabb.min.y > 0.85 && cx > 3.45 && cx < 3.65;
});
function overlaps(): string[] {
  const out: string[] = [];
  const l = mus();
  for (let i = 0; i < l.length; i++) {
    for (let j = i + 1; j < l.length; j++) {
      const a = l[i].aabb, b = l[j].aabb, e = 0.001;
      if (a.min.x + e < b.max.x && a.max.x - e > b.min.x && a.min.y + e < b.max.y && a.max.y - e > b.min.y
        && a.min.z + e < b.max.z && a.max.z - e > b.min.z) out.push(`${l[i].getName()}@${a.min.x.toFixed(4)}..${a.max.x.toFixed(4)},${a.min.y.toFixed(4)}${l[i].heldBy ? '[h]' : ''} / ${l[j].getName()}@${b.min.x.toFixed(4)}..${b.max.x.toFixed(4)},${b.min.y.toFixed(4)}${l[j].heldBy ? '[h]' : ''}`);
    }
  }
  return out;
}

/** Brings a pallet to the raised Index01 stopper with a follower queued behind it (a PLC connected, forcing). */
function palletAtIndex01WithFollower(): MULike {
  connect();
  force('FG_TS_Transport02_M_Conveyor_Plus', true);
  until(() => sig('FG_TS_Index01_Y_Stopper_InHome') && sig('FG_TS_Index01_Y_Lift_InHome'), 1, 'Index01 stopper + lift home');
  if (!sig('FG_TS_Index01_B_Detect')) {
    until(() => sig('FG_TS_Stopper03_B_Detect'), 20, 'a pallet at Stopper03');
    force('FG_TS_Stopper03_Y_Stopper_WorkPos', true);
    until(() => sig('FG_TS_Stopper03_B_Exit'), 3, 'Stopper03 exit');
    force('FG_TS_Stopper03_Y_Stopper_WorkPos', false);
    until(() => sig('FG_TS_Index01_B_Detect'), 5, 'pallet at Index01');
  }
  // The follower: one more pallet through Stopper03, it queues behind the first one.
  until(() => sig('FG_TS_Stopper03_B_Detect'), 20, 'a follower at Stopper03');
  force('FG_TS_Stopper03_Y_Stopper_WorkPos', true);
  until(() => sig('FG_TS_Stopper03_B_Exit'), 3, 'follower past Stopper03');
  force('FG_TS_Stopper03_Y_Stopper_WorkPos', false);
  tick(2); // the follower runs up to the waiting pallet
  const p = atIndex01();
  if (!p) throw new Error('no pallet over Index01');
  return p;
}
const liftWork = (on: boolean) => { force('FG_TS_Index01_Y_Lift_WorkPos', on); force('FG_TS_Index01_Y_Lift_HomePos', !on); };

describe('plan-570 — the reloaded model (dynamic)', () => {
  beforeAll(async () => {
    handle = await createTestViewer('webgl');
    viewer = handle.viewer;
    registerPlcProgramComponent();
    viewer.use(new PlcPlugin(), 'internal');
    await viewer.loadModel(MODEL);
    await viewer.whenSceneReady();
    await new Promise((r) => setTimeout(r, 500));
    await plcRunning();
    viewer.scene.updateMatrixWorld();
  }, 240_000);
  afterAll(() => {
    store()?.unforceAll();
    viewer?.connectionMode.interfaceDisconnected(TEST_PLC);
    handle?.dispose();
  });

  it('F6: Stopper01/02 sit on the return conveyor, Stopper02 directly before Lift01; the stopper geometry moved along', () => {
    const s1 = worldPos('Stopper01');
    const s2 = worldPos('Stopper02');
    expect(s1.y).toBeCloseTo(0.531, 2);
    expect(s2.y).toBeCloseTo(0.531, 2);
    expect(s2.x).toBeCloseTo(2.730, 2); // Lift01 spans x 2.363..2.700
    expect(s1.x).toBeCloseTo(3.035, 2);
    expect(worldPos('Zone_Stopper02_Exit').y).toBeCloseTo(0.58, 2);
    expect(worldPos('Zone_Stopper01_Exit').y).toBeCloseTo(0.58, 2);
    expect(viewer.scene.getObjectByName('Stopper_Return')).toBeUndefined();
  });

  it('F4: forcing Transport01 runs the return conveyor, Transport02 the main conveyor', async () => {
    await restart();
    connect();
    const jog = (n: string) => { const d = v().drives.find((x: any) => x.name === n); return d.jogForward || d.jogBackward; };
    force('FG_TS_Transport01_M_Conveyor_Plus', true);
    tick(DT * 2);
    expect([jog('Belt_Return'), jog('Belt_Main')]).toEqual([true, false]);
    force('FG_TS_Transport01_M_Conveyor_Plus', false);
    force('FG_TS_Transport02_M_Conveyor_Plus', true);
    tick(DT * 2);
    expect([jog('Belt_Return'), jog('Belt_Main')]).toEqual([false, true]);
    store().unforceAll();
  }, 120_000);

  it('F8 spike: take-over from the running belt, 30 mm stroke, XY standstill, neighbour, return stroke, hand-back, signal edges', async () => {
    await restart();
    const p = palletAtIndex01WithFollower();
    const y0 = p.aabb.min.y;
    const x0 = p.aabb.min.x;
    const z0 = p.aabb.min.z;
    expect(y0).toBeCloseTo(0.893, 2);
    expect(overlaps(), 'before the stroke').toEqual([]);

    // Up: the belt keeps running underneath.
    liftWork(true);
    until(() => !sig('FG_TS_Index01_Y_Lift_InHome'), 0.5, 'InHome falls');
    expect(p.heldBy, 'taken over by the lift zone').toBe('zone');
    const fails: string[] = [];
    until(() => {
      if (Math.abs(p.aabb.min.x - x0) > 0.0005 || Math.abs(p.aabb.min.z - z0) > 0.0005) fails.push(`xy moved ${p.aabb.min.x}`);
      fails.push(...overlaps());
      return sig('FG_TS_Index01_Y_Lift_InWork');
    }, 2, 'InWork rises');
        expect(fails.slice(0, 6).join('; '), 'XY standstill + no overlap during the up stroke').toBe('');
    expect(p.aabb.min.y - y0, 'InWork near the top').toBeGreaterThan(0.025);
    expect(v().drives.find((d: any) => d.name === 'Belt_Main').jogForward, 'belt still running').toBe(true);
    tick(2); // dwell at the top: still held, nothing creeps underneath
    expect(p.heldBy).toBe('zone');
    // 30 mm stroke; the zone takes the pallet over one tick after the lift left home
    // (InHome falls with the first 1 mm at 60 mm/s) → the pallet rises 29..30 mm.
    expect(p.aabb.min.y - y0, 'pallet lifted with the 30 mm stroke').toBeGreaterThan(0.0285);
    expect(p.aabb.min.y - y0).toBeLessThan(0.0305);
    expect(sig('FG_TS_Index01_Y_Lift_InWork') && !sig('FG_TS_Index01_Y_Lift_InHome')).toBe(true);
    // Detect sits at the stopper (box up to 8 mm above the belt top): the lifted pallet is not seen
    // (open question 5 to the customer). The neighbour waits behind the lift, not at the stopper.
    expect(sig('FG_TS_Index01_B_Detect'), 'Detect while lifted').toBe(false);
    expect(sig('FG_TS_Index01_B_Exit'), 'no exit flank during the stroke').toBe(false);
    expect(Math.abs(p.aabb.min.x - x0)).toBeLessThan(0.0005);
    expect(overlaps(), 'neighbour while lifted').toEqual([]);

    // Down: return stroke, hand-back to the belt at the stopper.
    liftWork(false);
    until(() => !sig('FG_TS_Index01_Y_Lift_InWork'), 0.5, 'InWork falls');
    until(() => sig('FG_TS_Index01_Y_Lift_InHome'), 2, 'InHome rises');
    tick(DT * 2);
    expect(p.heldBy, 'released on the way home').toBeNull();
    expect(Math.abs(p.aabb.min.y - y0), 'back on the belt top, not sunk').toBeLessThan(0.0002);
    expect(Math.abs(p.aabb.min.x - x0)).toBeLessThan(0.002);
    expect(sig('FG_TS_Index01_B_Detect'), 'pallet back at the stopper').toBe(true);
    expect(overlaps().join('; '), 'after the return stroke').toBe('');

    // The belt takes it on: stopper down → exactly this pallet leaves.
    force('FG_TS_Index01_Y_Stopper_WorkPos', true);
    until(() => sig('FG_TS_Index01_B_Exit'), 3, 'Index01 exit after the hand-back');
    force('FG_TS_Index01_Y_Stopper_WorkPos', false);
    until(() => p.aabb.min.x > x0 + 0.05, 3, 'the pallet is transported again');
    expect(overlaps()).toEqual([]);
    store().unforceAll();
  }, 180_000);

  it('F8 spike: stop (E-stop) and reset in the middle of the stroke', async () => {
    await restart();
    const p = palletAtIndex01WithFollower();
    const y0 = p.aabb.min.y;
    liftWork(true);
    tick(0.2); // half of the 0.5 s stroke
    const mid = p.aabb.min.y - y0;
    expect(mid).toBeGreaterThan(0.005);
    expect(mid).toBeLessThan(0.025);
    // Stop: motion enable off → the lift holds, the pallet stays held where it is.
    setSig('i_SS_ESTOP1', false);
    tick(DT * 3);
    expect(sig('SIM_MotionEnable')).toBe(false);
    const held = p.aabb.min.y;
    tick(1);
    expect(p.aabb.min.y).toBeCloseTo(held, 4);
    expect(p.heldBy).toBe('zone');
    expect(sig('FG_TS_Index01_Y_Lift_InHome') || sig('FG_TS_Index01_Y_Lift_InWork'), 'neither end position').toBe(false);
    // Reset in the middle of the stroke: nothing stays held, the lift is home, every pallet rests on a belt.
    await restart();
    tick(1);
    expect(sig('FG_TS_Index01_Y_Lift_InHome')).toBe(true);
    expect(mus().filter((m) => m.heldBy === 'zone').map((m) => m.getName())).toEqual([]);
    const floating = mus().filter((m) => m.aabb.min.y > 0.9 && m.aabb.min.y < 1.0).map((m) => `${m.getName()}@${m.aabb.min.y.toFixed(3)}`);
    expect(floating, 'no pallet left in the air').toEqual([]);
    expect(overlaps()).toEqual([]);
  }, 180_000);
});
