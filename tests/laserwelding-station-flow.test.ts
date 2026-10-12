// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * laserwelding-station-flow.test.ts — plan-539 §9: the LaserWeldingAssemblyStation
 * demo on ONE signal path (TIA tags as PLC signals, virtual PLC + plant behaviour).
 *
 * Loads the shipping demo GLB into a real test viewer and steps it
 * deterministically with `_tickOnce` (60 Hz). The GLB carries
 * `ConnectionMode { StartMode: 'Simulation' }` (plan-539 F15), so the viewer
 * starts disconnected by itself. The station control is the virtual PLC: eleven
 * Structured Text programs (PLC_Programs/*, auto-started on load) that write
 * only while `RV_SimulationMode` is TRUE; plant roots (`Logic_Plant_*`, Active:
 * Always) keep running in commissioning. Commissioning cases connect like a
 * live PLC interface does (connect + first write to a model `%Q`, F15b); its disconnect
 * returns to the saved StartMode.
 *
 * Production cycles are counted from the PLC side: every production unit sets
 * `SIM_Parked_<unit>` FALSE when it leaves its safe point and TRUE when its
 * cycle wraps — a rising edge is one completed cycle.
 *
 * Runs only in the private build (imports `@rv-private`, like the other plc tests).
 *
 * The scene graph is updated after every tick (`scene.updateMatrixWorld()`),
 * as the render loop does in the live viewer — transport surfaces riding a
 * lift read their world matrix from it.
 *
 * plan-570 (customer topology, edited in the WEB editor): `Transport01` drives the
 * lower return conveyor, `Transport02` the upper main conveyor; Stopper01
 * (separator) and Stopper02 (directly before Lift01) sit on the return conveyor
 * and are written only by the Lift01 program; the sim-only return stopper is
 * gone. Every cylinder runs in its valve mode (DoubleActing / SingleActingPositive).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PlcPlugin } from '@rv-private/plugins/plc/plc-plugin';
import { registerPlcProgramComponent } from '@rv-private/plc/rv-plc-program';
import { getPlcRuntime } from '../src/core/plc-control';
import { createTestViewer, type TestViewerHandle } from './helpers/create-test-viewer';
import type { RVViewer } from '../src/core/rv-viewer';
import type { RVLogicStep } from '../src/core/engine/rv-logic-step';
import { StepState } from '../src/core/engine/rv-logic-step';

const MODEL = '/demo-realvirtual/LaserWeldingAssemblyStation.glb';
const DT = 1 / 60;
/** Id of the emulated live PLC interface in the commissioning cases. */
const TEST_PLC = 'test-plc';
const PRODUCTION = ['Lift01', 'Buffer02', 'Entry', 'Station01', 'Station02', 'Station03', 'Station04', 'Station05', 'Lift02'];
/** The eleven ST programs of the station control (production units + operating modes + transport). */
const PROGRAMS = ['Modes', 'Transport', ...PRODUCTION];
const LIFT_X: [number, number][] = [[2.363, 2.700], [5.423, 5.760]];

interface MULike {
  getName(): string;
  aabb: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } };
}
interface DriveLike { name: string; currentPosition: number; isRunning: boolean; jogForward: boolean; jogBackward: boolean }
interface Root extends RVLogicStep { name: string; completedCycles: number; currentIndex: number; children: RVLogicStep[] }

let handle: TestViewerHandle;
let viewer: RVViewer;
let simTime = 0;

// ── Harness ──────────────────────────────────────────────────────────────

const v = (): any => viewer as any; // eslint-disable-line @typescript-eslint/no-explicit-any
const store = () => v().signalStore;
const sig = (name: string): boolean => store().get(name) === true;
const setSig = (name: string, value: boolean): void => store().set(name, value);
const roots = (): Root[] => v().logicEngine.roots as Root[];
const rootByName = (name: string): Root => {
  const r = roots().find((x) => x.name === name);
  if (!r) throw new Error(`root ${name} missing`);
  return r;
};
const mus = (): MULike[] => v().transportManager.mus as MULike[];
const drives = (): DriveLike[] => v().drives as DriveLike[];
const drive = (name: string): DriveLike => {
  const d = drives().find((x) => x.name === name);
  if (!d) throw new Error(`drive ${name} missing`);
  return d;
};

/** Completed cycles per production unit (rising edges of SIM_Parked_<unit>) since the last restart. */
const cycleCount: Record<string, number> = {};
const lastParked: Record<string, boolean> = {};
function resetCycleCounts(): void {
  for (const r of PRODUCTION) { cycleCount[r] = 0; lastParked[r] = sig(`SIM_Parked_${r}`); }
}

function tick(seconds: number, each?: () => void): void {
  const n = Math.max(1, Math.round(seconds / DT));
  for (let i = 0; i < n; i++) {
    v()._tickOnce(DT);
    viewer.scene.updateMatrixWorld();
    simTime += DT;
    for (const r of PRODUCTION) {
      const p = sig(`SIM_Parked_${r}`);
      if (p && !lastParked[r]) cycleCount[r]++;
      lastParked[r] = p;
    }
    each?.();
  }
}

/** The ST programs of the station — every one running, none in error. */
const plcPrograms = () => getPlcRuntime()!.programs().filter((p) => PROGRAMS.includes(p.name));
function expectPlcHealthy(label = ''): void {
  const progs = plcPrograms();
  expect(progs.map((p) => p.name).sort(), `${label} programs`).toEqual([...PROGRAMS].sort());
  for (const p of progs) {
    expect(p.lastError, `${label} ${p.name} error`).toBeNull();
    expect(p.state, `${label} ${p.name} state`).toBe('running');
  }
  expect(getPlcRuntime()!.conflicts(), `${label} outputs written by two programs`).toEqual([]);
}
/** Waits (wall clock) until every program runs again — deploy and reset are asynchronous. */
async function plcRunning(): Promise<void> {
  for (let i = 0; i < 300; i++) {
    const progs = plcPrograms();
    if (progs.length === PROGRAMS.length && progs.every((p) => p.state === 'running')) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`PLC programs not running: ${JSON.stringify(plcPrograms().map((p) => [p.name, p.state, p.lastError]))}`);
}

/** Tick until `pred` holds; returns the elapsed sim time or throws after `max` s. */
function until(pred: () => boolean, max: number, what: string): number {
  const t0 = simTime;
  for (let i = 0; i < Math.round(max / DT); i++) {
    if (pred()) return simTime - t0;
    tick(DT);
  }
  if (pred()) return simTime - t0;
  const near = mus().filter((m) => m.aabb.min.x < 3.3)
    .map((m) => `${m.getName()}@${m.aabb.min.x.toFixed(3)},${m.aabb.min.y.toFixed(3)}`).join(' ');
  const steps = PRODUCTION.map((r) => `${r}:${sig(`SIM_Parked_${r}`) ? 'parked' : 'busy'}/${cycleCount[r]}/step ${getPlcRuntime()?.program(r)?.watch().get('Step') ?? '?'}`).join(' ');
  const b2 = drive('Belt_Lift02');
  const l2 = mus().filter((m) => m.aabb.min.x > 5.0).map((m) => `${m.getName()}@${m.aabb.min.x.toFixed(3)},${m.aabb.min.y.toFixed(3)}`).join(' ');
  const diag = `[Belt_Lift02 jog ${b2.jogForward}/${b2.jogBackward} run ${b2.isRunning} pos ${b2.currentPosition.toFixed(0)}; ME ${sig('SIM_MotionEnable')}; L2exit ${sig('FG_TS_Lift02_B_Exit')} L2det ${sig('FG_TS_Lift02_B_Detect')} Minus ${sig('FG_TS_Lift02_M_Conveyor_Minus')}; MUs x>5: ${l2}]`;
  throw new Error(`timeout after ${max} s: ${what} [MUs x<3.3: ${near}] [steps: ${steps}] [conn: ${viewer.connectionState}] ${diag}`);
}

function press(name: string, seconds = 0.5): void {
  setSig(name, true);
  tick(seconds);
  setSig(name, false);
}

/** Simulation reset in the "no PLC connected" state; every operator input released. */
async function restart(): Promise<void> {
  store().unforceAll();
  for (const b of ['BT4_AutoStart', 'BT5_AutoStop', 'BT6_Ack', 'BT8_ImmediateStop', 'BT3_SingleStep', 'BT7_Reset']) setSig(b, false);
  setSig('i_SS_ESTOP1', true);
  setSig('i_SS_ESTOP2', true);
  for (const c of ['FG01', 'FG02', 'FG05']) setSig(`SIM_${c}_ForceNOK`, false);
  // Back from a commissioning case: the interface disconnects → saved StartMode.
  viewer.connectionMode.interfaceDisconnected(TEST_PLC);
  expect(viewer.connectionState, 'Simulation start mode').toBe('Disconnected');
  tick(DT); // the logic engine takes the connection state over on its next tick
  viewer.resetSimulation(); // also a COLD reset of every PLC program (asynchronous)
  await plcRunning();
  tick(DT);
  resetCycleCounts();
}

const cycles = (): Record<string, number> => ({ ...cycleCount });
const allParked = (): boolean => PRODUCTION.every((r) => sig(`SIM_Parked_${r}`));
const towerOff = (): boolean => ['SignalTower_Green', 'SignalTower_Blue', 'SignalTower_Red'].every((t) => !sig(t));

/** Drives that must hold during a fault: every cylinder and motor (sim helper and doors excluded). */
const HELD_EXCLUDE = /^Door_/;
function snapshotDrives(): Map<string, number> {
  return new Map(drives().filter((d) => !HELD_EXCLUDE.test(d.name)).map((d) => [d.name, d.currentPosition]));
}
function movedSince(snap: Map<string, number>): string[] {
  const moved: string[] = [];
  for (const [name, pos] of snap) if (Math.abs(drive(name).currentPosition - pos) > 1e-6) moved.push(name);
  return moved;
}

/** plan-569: the single parts carry a tag (Valve / Connector / Cap); the pallets carry none. */
const partTag = (m: MULike): string => ((m as any).node?.userData?.tag as string | undefined) ?? ''; // eslint-disable-line @typescript-eslint/no-explicit-any

/**
 * plan-569 F9: an overlap is an ASSEMBLY CONTACT, not a collision, when a part
 * held by a grip sits in the seat of a carrier (pallet jig, seat depth > 0) —
 * the part is picked out of / placed into the jig — within that seat depth.
 */
function isAssemblyContact(a: any, b: any): boolean { // eslint-disable-line @typescript-eslint/no-explicit-any
  for (const [part, carrier] of [[a, b], [b, a]]) {
    if (part.heldBy !== 'grip' || !(carrier.loadSeatDepth > 0)) continue;
    const depth = carrier.aabb.max.y - part.aabb.min.y;
    if (depth <= carrier.loadSeatDepth + 0.005) return true;
  }
  return false;
}

/** Plant-level invariants sampled during a run (plan-530 criteria; plan-569: parts are loads or held). */
function checkPlant(failures: string[]): void {
  const list = mus();
  for (const m of list) {
    if (partTag(m)) continue; // a part on the feeder, in a gripper or released into the cap sink — not a pallet
    const cx = (m.aabb.min.x + m.aabb.max.x) / 2;
    const onLift = LIFT_X.some(([a, b]) => cx > a - 0.05 && cx < b + 0.05);
    if (!onLift && m.aabb.min.y > 0.6 && m.aabb.min.y < 0.88) failures.push(`t=${simTime.toFixed(2)} ${m.getName()} sunk (bottom ${m.aabb.min.y.toFixed(3)})`);
  }
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i].aabb, b = list[j].aabb, e = 0.001;
      if (a.min.x + e < b.max.x && a.max.x - e > b.min.x && a.min.y + e < b.max.y && a.max.y - e > b.min.y
        && a.min.z + e < b.max.z && a.max.z - e > b.min.z && !isAssemblyContact(list[i], list[j])) {
        failures.push(`t=${simTime.toFixed(2)} overlap ${list[i].getName()} / ${list[j].getName()}`);
      }
    }
  }
}

/**
 * plan-569 F9: the load trees of all pallets, recursively, with CURRENT AABBs —
 * every load keeps its offset to its carrier while it stays loaded (drift < 0.1 mm).
 */
const loadOffsetsRef = new Map<object, { carrier: object; x: number; y: number; z: number }>();
function checkLoadTrees(failures: string[]): void {
  const visit = (carrier: any): void => { // eslint-disable-line @typescript-eslint/no-explicit-any
    for (const l of carrier.loadedMus) {
      l.updateAABB(); carrier.updateAABB();
      const c = l.aabb.center, p = carrier.aabb.center;
      const off = { carrier, x: c.x - p.x, y: c.y - p.y, z: c.z - p.z };
      const ref = loadOffsetsRef.get(l);
      if (ref && ref.carrier === carrier) {
        const d = Math.hypot(off.x - ref.x, off.y - ref.y, off.z - ref.z);
        if (d > 0.0001) failures.push(`t=${simTime.toFixed(2)} ${l.getName()} drifts ${(d * 1000).toFixed(3)} mm on ${carrier.getName()}`);
      } else loadOffsetsRef.set(l, off);
      visit(l);
    }
  };
  const before = new Set(loadOffsetsRef.keys());
  const seen = new Set<object>();
  const visitSeen = (carrier: any): void => { for (const l of carrier.loadedMus) { seen.add(l); visitSeen(l); } }; // eslint-disable-line @typescript-eslint/no-explicit-any
  for (const m of mus()) if (!partTag(m)) { visit(m); visitSeen(m); }
  // A load that left its carrier (picked, removed) starts a NEW reference when it is loaded again.
  for (const l of before) if (!seen.has(l)) loadOffsetsRef.delete(l);
}

beforeAll(async () => {
  handle = await createTestViewer('webgl');
  viewer = handle.viewer;
  // The virtual PLC as the internal build wires it (features/plc.register):
  // component first, so the PLCProgram nodes are constructed during the load.
  registerPlcProgramComponent();
  viewer.use(new PlcPlugin(), 'internal');
  await viewer.loadModel(MODEL);
  // Let the asynchronous post-load work settle (scene ready + one wall-clock
  // beat), as the live viewer has before a user acts.
  await viewer.whenSceneReady();
  await new Promise((r) => setTimeout(r, 500));
  await plcRunning(); // auto-start of the Active programs is asynchronous
  // Online view: VAR values (the step of every chain) in the watch — for the timeout diagnostics.
  for (const p of PROGRAMS) getPlcRuntime()!.program(p)!.setOnlineView?.(true);
  viewer.scene.updateMatrixWorld();
  resetCycleCounts();
}, 240_000);

afterAll(() => handle?.dispose());

// ── 1. Simulation ────────────────────────────────────────────────────────

describe('plan-539 — simulation (virtual PLC, no PLC connected)', () => {
  it('starts in Simulation from the GLB (ConnectionMode StartMode) — no explicit connection state', async () => {
    expect(viewer.connectionState).toBe('Disconnected');
    const s = viewer.connectionMode.state;
    expect(s.mode).toBe('Simulation');
    expect(s.startMode).toBe('Simulation');
    expect(s.source).toBe('model');
    expect(s.componentPath?.endsWith('ConnectionMode')).toBe(true);
    expect(roots().filter((r) => r.name.startsWith('Logic_PLC_')), 'no LogicStep station control left').toEqual([]);
    tick(1);
    expectPlcHealthy('after load');
    expect(sig('SIM_AutoRelease')).toBe(true);
    // The demo runs straight from the load (no reset) — as in the live viewer.
    tick(60);
    const c = cycles();
    for (const r of PRODUCTION) expect(c[r], `${r} from load ${JSON.stringify(c)}`).toBeGreaterThanOrEqual(1);
  }, 120_000);

  it('runs 240 s: no sunk pallet, no overlap, exact stops at Stopper01/02 (return) and Stopper03 (main), every production root >= 10 cycles', async () => {
    await restart();
    expect(v().logicEngine.warnings).toEqual([]);
    const failures: string[] = [];
    // plan-570: Stopper01/02 hold on the return conveyor (flow −X, the pallet's min.x touches the face),
    // Stopper03 on the main conveyor (flow +X, max.x touches the face).
    const STOPS = [['Stopper01', 3.050, 'return'], ['Stopper02', 2.745, 'return'], ['Stopper03', 3.195, 'main']] as const;
    const exact: Record<string, number[]> = { Stopper01: [], Stopper02: [], Stopper03: [] };
    // Only a pallet at REST counts (same front as one sample earlier) — Detect already
    // reports a pallet that is still running in within the contact tolerance.
    const lastFront = new Map<string, number>();
    let samples = 0;
    tick(240, () => {
      if (++samples % 30 !== 0) return;
      checkPlant(failures);
      checkLoadTrees(failures);
      for (const [s, face, belt] of STOPS) {
        if (!sig(`FG_TS_${s}_B_Detect`) || !sig(`FG_TS_${s}_Y_Stopper_InHome`)) continue;
        const front = (m: MULike) => (belt === 'main' ? m.aabb.max.x : m.aabb.min.x);
        const held = mus().find((m) => (belt === 'main' ? m.aabb.min.y > 0.88 : m.aabb.min.y < 0.6) && Math.abs(front(m) - face) < 0.02);
        if (!held) continue;
        const key = `${s}/${held.getName()}`;
        const prev = lastFront.get(key);
        lastFront.set(key, front(held));
        if (prev !== undefined && Math.abs(prev - front(held)) < 1e-6) exact[s].push(front(held));
      }
    });
    expect(failures).toEqual([]);
    for (const [s, face] of STOPS) {
      expect(exact[s].length, `${s} samples`).toBeGreaterThan(10);
      for (const x of exact[s]) expect(Math.abs(x - face), `${s} front ${x}`).toBeLessThan(0.004);
    }
    const c = cycles();
    for (const r of PRODUCTION) expect(c[r], `${r} cycles ${JSON.stringify(c)}`).toBeGreaterThanOrEqual(10);
    const init = rootByName('Logic_Plant_Init');
    expect(init.children[init.currentIndex].name).toBe('D8_Hold');
    expect(sig('SignalTower_Green')).toBe(true);
    expect(sig('SIM_MotionEnable')).toBe(true);
    expectPlcHealthy('after 240 s');
  }, 120_000);

  it('plan-569 F7/F9: two complete rounds with the same 14 pallets (parts as loads, caps on and off), no blocked seat, no jam', async () => {
    await restart();
    const pallets = mus().filter((m) => !partTag(m)).map((m) => m.getName()).sort();
    expect(pallets.length).toBe(14);
    // One round = every pallet passes Stopper02 (directly before Lift01) once.
    const passes: Record<string, number> = Object.fromEntries(pallets.map((p) => [p, 0]));
    let lastDetect = sig('FG_TS_Stopper02_B_Detect');
    const failures: string[] = [];
    let samples = 0;
    loadOffsetsRef.clear();
    const t0 = simTime;
    while (!Object.values(passes).every((n) => n >= 2)) {
      if (simTime - t0 > 600) throw new Error(`two rounds not reached in 600 s: ${JSON.stringify(passes)}`);
      tick(DT);
      const d = sig('FG_TS_Stopper02_B_Detect');
      if (d && !lastDetect) {
        const at = mus().find((m) => !partTag(m) && m.aabb.min.y < 0.6 && Math.abs(m.aabb.min.x - 2.745) < 0.03);
        if (at) passes[at.getName()]++;
      }
      lastDetect = d;
      if (++samples % 30 === 0) { checkPlant(failures); checkLoadTrees(failures); }
    }
    expect(mus().filter((m) => !partTag(m)).map((m) => m.getName()).sort(), 'same 14 pallet identities').toEqual(pallets);
    expect(failures).toEqual([]);
    const { getProblems } = await import('../src/core/hmi/problems-store');
    expect(getProblems().filter((p) => p.code === 'grip-seat-occupied'), 'no blocked seat').toEqual([]);
    expectPlcHealthy('after two rounds');
  }, 300_000);
});

describe('plan-539 F6 / F6b — operator window tags, E-stops and tower lamps', () => {
  it('the 3D panel is gone, every operator-window tag is in the model; BT5 is a momentary pulse; the tower lamps follow their signals', async () => {
    await restart();
    tick(1);
    const reg = v().registry;
    // F6b: the operator panel is a window, not 3D buttons — plan-543: the window
    // comes from the GLB's WebOperatorPanel (no model plugin), one per component.
    const wrappers = [...reg.getAll('PushButton3D'), ...reg.getAll('HandleSwitch3D'), ...reg.getAll('EmergencyButton3D')];
    expect(wrappers.length).toBe(0);
    expect(v().scene.getObjectByName('Panel_PLC')).toBeUndefined();
    const panels = viewer.webOperatorPanels.entries;
    expect(panels.map((e) => [e.nodePath.split('/').pop(), e.panelId, e.title, e.errors.length])).toEqual([
      ['OperatorPanel', 'laserwelding-operator-panel', 'Operator panel', 0],
    ]);
    expect(viewer.getPlugins().some((p) => p.id === 'laserwelding-operator-panel')).toBe(false);
    const panel = panels[0].controller;
    expect(panel.getSnapshot().ready).toBe(true);
    expect(panel.signalNames).toHaveLength(23);
    for (const name of panel.signalNames) expect(store().get(name), `${name} in the model`).not.toBeUndefined();
    // The window writes as an operator: BT6 through the panel reaches the signal.
    panel.write('BT6_Ack', true);
    expect(sig('BT6_Ack')).toBe(true);
    panel.write('BT6_Ack', false);
    // NC E-stops report OK while released; the latching selectors start on (control on, Automatic).
    expect(sig('i_SS_ESTOP1') && sig('i_SS_ESTOP2')).toBe(true);
    expect(sig('BT1_ControlOnOff') && sig('BT2_OpMode')).toBe(true);
    press('BT5_AutoStop');
    expect(sig('BT5_AutoStop')).toBe(false);
    expect(sig('SIM_AutoRelease')).toBe(false);
    // Lamps: 3 tower lamps of the CAD + the added blue segment (the button lamps are in the window).
    interface LampLike { node: { name: string }; SignalLampOn: unknown; isLit(): boolean }
    const lamps: LampLike[] = reg.getAll('Lamp').map((e: { instance: LampLike }) => e.instance);
    expect(lamps.length).toBe(4);
    for (const l of lamps) expect(typeof l.SignalLampOn, `${l.node.name} bound`).toBe('string');
    until(() => sig('SignalTower_Blue') || towerOff(), 20, 'stopping or stopped');
    const lampNames = lamps.map((l) => l.node.name).join(',');
    const blue = lamps.find((l) => l.node.name.startsWith('SignalTower_Blue'))!;
    expect(blue, lampNames).toBeTruthy();
    expect(blue.isLit()).toBe(sig('SignalTower_Blue'));
    until(() => allParked() && towerOff(), 30, 'Stopped');
    expect(blue.isLit()).toBe(false);
    press('BT4_AutoStart');
    const green = lamps.find((l) => l.node.name.startsWith('LAMP.G_1'))!;
    expect(green, lampNames).toBeTruthy();
    expect(sig('SignalTower_Green')).toBe(true);
    expect(green.isLit()).toBe(true);
  }, 120_000);
});

// ── 2. Operating modes ───────────────────────────────────────────────────

describe('plan-539 F8 — BT5 stop at the end of the cycle, BT4 start', () => {
  /** One cycle of the slowest production root in the 240 s run (>= 14 cycles), sim seconds. */
  const ONE_CYCLE_S = 240 / 14;

  function stopAndExpectStopped(label: string): void {
    setSig('BT5_AutoStop', true);
    tick(0.1);
    expect(sig('SIM_AutoRelease'), label).toBe(false);
    let sawBlue = false;
    const t = until(() => {
      if (sig('SignalTower_Blue')) sawBlue = true;
      return allParked() && !sig('SIM_Stopping');
    }, 60, `${label}: Stopped`);
    setSig('BT5_AutoStop', false);
    expect(t, `${label}: time to Stopped`).toBeLessThanOrEqual(ONE_CYCLE_S);
    expect(sawBlue || t < 0.2, `${label}: tower blue while stopping`).toBe(true);
    expect(allParked(), label).toBe(true);
    tick(0.1);
    expect(towerOff(), `${label}: tower off`).toBe(true);
    // Stopped means stopped: no cylinder or lift motion any more (belts keep running).
    const snap = snapshotDrives();
    tick(3);
    expect(movedSince(snap).filter((n) => !/^Belt_(Main|Return)$/.test(n)), `${label}: motion while stopped`).toEqual([]);
  }

  it('BT5 in normal production → Stopped within one cycle, tower blue → off; BT4 → runs again', async () => {
    await restart();
    tick(30);
    stopAndExpectStopped('normal');
    const before = cycles();
    press('BT4_AutoStart');
    expect(sig('SIM_AutoRelease')).toBe(true);
    expect(sig('SignalTower_Green')).toBe(true);
    tick(40);
    const after = cycles();
    for (const r of PRODUCTION) expect(after[r], `${r} runs again`).toBeGreaterThan(before[r]);
  }, 120_000);

  it('BT5 during material shortage (no pallet at the entry stopper)', async () => {
    await restart();
    tick(10);
    until(() => !sig('FG_TS_Stopper03_B_Detect'), 120, 'entry without pallet');
    stopAndExpectStopped('material shortage');
  }, 120_000);

  it('BT5 with back-pressure (pallets queued on the return conveyor)', async () => {
    await restart();
    tick(10);
    const queued = () => mus().filter((m) => m.aabb.min.y < 0.6 && m.aabb.max.x < 5.4).length;
    until(() => sig('FG_TS_Stopper01_B_Detect') && sig('FG_TS_Stopper02_B_Detect') && queued() >= 5, 180, 'return queue >= 5');
    stopAndExpectStopped('back-pressure');
  }, 120_000);

  it('BT5 during a Lift01 hand-over', async () => {
    await restart();
    tick(10);
    until(() => sig('FG_TS_Lift01_M_Conveyor_Minus') || sig('FG_TS_Lift01_M_Conveyor_Plus'), 120, 'Lift01 hand-over');
    stopAndExpectStopped('Lift01 hand-over');
  }, 120_000);
});

// ── 3. Faults ────────────────────────────────────────────────────────────

describe('plan-539 F7/F8c/F14 — immediate stop, E-stop, Ack, Auto start (no reset)', () => {
  /** One cycle of the slowest production root in the 240 s run (>= 14 cycles), sim seconds. */
  const ONE_CYCLE_S = 240 / 14;

  function expectHeld(label: string, seconds = 2): void {
    const snap = snapshotDrives();
    tick(seconds);
    expect(movedSince(snap), `${label}: drives moved`).toEqual([]);
  }

  /** F8c step 3: Auto start after Ack — every production root completes a cycle again within one cycle time. */
  function autoStartAndExpectRecovery(label: string): void {
    const before = cycles();
    press('BT4_AutoStart', 0.2);
    expect(sig('SIM_FaultLatch'), `${label}: latch cleared`).toBe(false);
    expect(sig('SIM_MotionEnable'), `${label}: motion enabled`).toBe(true);
    expect(sig('SIM_AutoRelease'), `${label}: Auto`).toBe(true);
    expect(sig('SignalTower_Green'), `${label}: tower green`).toBe(true);
    expect(sig('FG_TS_Transport01_M_Conveyor_Plus') && sig('FG_TS_Transport02_M_Conveyor_Plus'), `${label}: belts on`).toBe(true);
    const failures: string[] = [];
    let samples = 0;
    const t = until(() => {
      if (++samples % 30 === 0) checkPlant(failures);
      const c = cycles();
      return PRODUCTION.every((r) => c[r] > before[r]);
    }, ONE_CYCLE_S, `${label}: every production root cycles again`);
    expect(t, `${label}: time to the last completed cycle`).toBeLessThanOrEqual(ONE_CYCLE_S);
    tick(10, () => { if (++samples % 30 === 0) checkPlant(failures); });
    expect(failures, `${label}: sunk / overlap`).toEqual([]);
    expect(v().logicEngine.warnings).toEqual([]);
    expectPlcHealthy(label);
  }

  it('BT8 during a Lift01 hand-over: every cylinder AND motor stops; Auto start before Ack is ignored; Ack → Auto start continues mid-cycle', async () => {
    await restart();
    tick(30); // steady state: past the pipeline fill after a reset
    // plan-570: the Lift01 hand-over is shorter now (no stopper on the main conveyor), so the FG05
    // motors no longer reliably run at the same moment — they are checked whenever they do.
    until(() => (sig('FG_TS_Lift01_M_Conveyor_Minus') || sig('FG_TS_Lift01_M_Conveyor_Plus')) && drive('Belt_Lift01').isRunning,
      180, 'Lift01 belt moving');
    const running = ['Belt_Main', 'Belt_Return', 'Belt_Lift01', 'VM_FG05_Bunker', 'VM_FG05_Conveyor']
      .filter((m) => drive(m).jogForward || drive(m).jogBackward);
    for (const m of ['Belt_Main', 'Belt_Return', 'Belt_Lift01']) expect(running, `${m} runs before the fault`).toContain(m);
    const liftCycles = cycleCount.Lift01;
    press('BT8_ImmediateStop', 0.2);
    expect(sig('SIM_FaultLatch')).toBe(true);
    expect(sig('SIM_MotionEnable')).toBe(false);
    expect(sig('SignalTower_Red')).toBe(true);
    expect(sig('BT6_ErrFltLight')).toBe(true);
    expect(sig('SIM_AutoRelease')).toBe(false);
    for (const m of ['Belt_Main', 'Belt_Return', 'Belt_Lift01', 'Belt_Lift02', 'VM_FG05_Bunker', 'VM_FG05_Conveyor']) {
      expect(drive(m).jogForward || drive(m).jogBackward || drive(m).isRunning, `${m} stopped`).toBe(false);
    }
    expectHeld('fault, BT8 released');
    // Auto start before Ack is ignored — also after the Ack that follows.
    press('BT4_AutoStart');
    expect(sig('SIM_FaultLatch')).toBe(true);
    expectHeld('BT4 before Ack', 1);
    press('BT6_Ack');
    expect(sig('SIM_FaultActive')).toBe(false);
    expect(sig('SignalTower_Red')).toBe(false);
    expect(sig('BT6_ErrFltLight')).toBe(false);
    expect(sig('SIM_FaultLatch')).toBe(true);
    expect(sig('SIM_AutoRelease')).toBe(false);
    expectHeld('acknowledged, motion still held', 3);
    // The hand-over was interrupted, not restarted: the Lift01 root has not wrapped.
    expect(cycleCount.Lift01).toBe(liftCycles);
    autoStartAndExpectRecovery('BT8 during Lift01 hand-over');
  }, 120_000);

  it('BT8 in normal production → Ack → Auto start: all production roots cycle again within one cycle', async () => {
    await restart();
    tick(60); // plan-570: steady state — Lift01 completes its first cycle ~55 s after a reset
    press('BT8_ImmediateStop', 0.2);
    expectHeld('fault');
    press('BT6_Ack');
    expectHeld('acknowledged');
    autoStartAndExpectRecovery('BT8 normal production');
  }, 120_000);

  it('E-stop: hold, tower red; Ack with the E-stop pressed is ignored; released → Ack → Auto start runs again', async () => {
    await restart();
    tick(60); // plan-570: steady state — Lift01 completes its first cycle ~55 s after a reset
    setSig('i_SS_ESTOP1', false);
    tick(DT * 3);
    expect(sig('SIM_MotionEnable')).toBe(false);
    expect(sig('SignalTower_Red')).toBe(true);
    expect(sig('q_SS_ESTOP1')).toBe(true);
    expectHeld('E-stop pressed');
    press('BT6_Ack'); // E-stop still pressed → no ack
    expect(sig('SIM_FaultActive')).toBe(true);
    press('BT4_AutoStart'); // neither acknowledged nor released → ignored
    expect(sig('SIM_FaultLatch')).toBe(true);
    setSig('i_SS_ESTOP1', true);
    expectHeld('E-stop released, latched');
    expect(sig('SIM_MotionEnable')).toBe(false);
    press('BT6_Ack');
    expect(sig('SIM_FaultActive')).toBe(false);
    expect(sig('q_SS_ESTOP1')).toBe(false);
    expectHeld('after Ack');
    autoStartAndExpectRecovery('E-stop');
  }, 120_000);

  it('a simulation reset still recovers from a latched fault', async () => {
    await restart();
    tick(10);
    press('BT8_ImmediateStop', 0.2);
    expect(sig('SIM_FaultLatch')).toBe(true);
    await restart();
    expect(sig('SIM_FaultLatch')).toBe(false);
    expect(sig('SIM_MotionEnable')).toBe(true);
    // Pipeline fill after the reset: Lift01 needs a pallet up the return conveyor first
    // (plan-570: ~55 s — Lift01 hands a pallet over only into an empty entry, so its first cycle waits for the Entry).
    until(() => PRODUCTION.every((r) => cycleCount[r] >= 1), 90, 'every production unit cycles after the reset');
  }, 120_000);
});

// ── 4. Virtual commissioning ─────────────────────────────────────────────

describe('plan-539 — commissioning (a PLC connected)', () => {
  /** Outputs written by the virtual PLC (must fall back to false on connect). */
  const PLC_OUTPUTS = ['SIM_AutoRelease', 'SignalTower_Green', 'BT4_AutoLight', 'BT1_ControlLight',
    'FG_TS_Transport01_M_Conveyor_Plus', 'FG_TS_Transport02_M_Conveyor_Plus', 'FG05_M_Bunker', 'FG05_M_Conveyor'];

  /** A live PLC interface connects (it overrides the Simulation start mode). */
  function connect(): void {
    viewer.connectionMode.interfaceConnected(TEST_PLC);
    // F15b: an interface takes over with its first write to a model PLC output.
    viewer.connectionMode.interfaceWrites(TEST_PLC, ['FG_TS_Transport01_M_Conveyor_Plus']);
    tick(DT * 2);
  }
  afterAll(() => {
    store().unforceAll();
    viewer.connectionMode.interfaceDisconnected(TEST_PLC);
  });

  it('connect: the PLC programs step aside, their outputs fall back to false and stay there, plant roots keep running', async () => {
    await restart();
    tick(30);
    expect(PLC_OUTPUTS.filter((s) => !s.startsWith('FG05') && !sig(s))).toEqual([]);
    connect();
    for (const r of roots()) {
      if (r.name.startsWith('Logic_Plant_')) expect([StepState.Active, StepState.Waiting], r.name).toContain(r.state);
    }
    expect(PLC_OUTPUTS.filter(sig)).toEqual([]);
    expect(sig('SIM_MotionEnable')).toBe(true);
    // The programs keep scanning but write nothing in PLC mode (RV_SimulationMode = FALSE).
    expectPlcHealthy('PLC mode');
    tick(3);
    expect(PLC_OUTPUTS.filter(sig), 'outputs after 3 s in PLC mode').toEqual([]);
  }, 120_000);

  it('forced outputs drive the plant; the %I feedback follows (stopper, detect, exit, two-bit cylinder)', async () => {
    await restart();
    tick(30);
    connect();
    until(() => sig('FG_TS_Index01_B_Detect') || sig('FG_TS_Stopper03_B_Detect'), 5, 'a pallet at Index01 or Stopper03');
    until(() => sig('FG_TS_Index01_Y_Stopper_InHome'), 0.5, 'Index01 stopper home after connect (outputs false → spring return)');
    store().forceSignal('FG_TS_Transport02_M_Conveyor_Plus', true); // plan-570: main conveyor = Transport02
    if (!sig('FG_TS_Index01_B_Detect')) {
      store().forceSignal('FG_TS_Stopper03_Y_Stopper_WorkPos', true);
      until(() => sig('FG_TS_Stopper03_B_Exit'), 3, 'Stopper03 exit');
      store().forceSignal('FG_TS_Stopper03_Y_Stopper_WorkPos', false);
      until(() => sig('FG_TS_Index01_B_Detect'), 5, 'pallet at Index01');
    }
    store().forceSignal('FG_TS_Index01_Y_Stopper_WorkPos', true);
    until(() => !sig('FG_TS_Index01_Y_Stopper_InHome'), 0.5, 'Index01 stopper leaves home');
    until(() => sig('FG_TS_Index01_B_Exit'), 3, 'Index01 exit sensor');
    until(() => !sig('FG_TS_Index01_B_Detect'), 3, 'Index01 free');
    store().forceSignal('FG_TS_Index01_Y_Stopper_WorkPos', false);
    until(() => sig('FG_TS_Index01_Y_Stopper_InHome'), 0.5, 'Index01 stopper home');
    store().forceSignal('FG04_Y_AxisZ_WorkPos', true);
    until(() => sig('FG04_Y_AxisZ_InWork') && !sig('FG04_Y_AxisZ_InHome'), 1, 'FG04 Z in work');
    store().forceSignal('FG04_Y_AxisZ_WorkPos', false);
    store().forceSignal('FG04_Y_AxisZ_HomePos', true);
    until(() => sig('FG04_Y_AxisZ_InHome') && !sig('FG04_Y_AxisZ_InWork'), 1, 'FG04 Z home');
    store().unforceAll();
  }, 120_000);

  it('camera FG01 handshake (F10): ready, busy, valid/ok, NOK, trigger falling during busy, disable', async () => {
    await restart();
    connect();
    const c = 'FG01_P_Camera.';
    const force = (s: string, val: boolean) => store().forceSignal(`${c}${s}`, val);
    force('bTrigger', false);
    force('bEnable', true);
    until(() => sig(`${c}bReady`), 0.2, 'ready');
    force('bTrigger', true);
    until(() => sig(`${c}bBusy`), 0.1, 'busy');
    expect(sig(`${c}bReady`)).toBe(false);
    expect(sig(`${c}bResultValid`)).toBe(false);
    const busy = until(() => sig(`${c}bResultValid`), 1, 'valid');
    expect(busy).toBeGreaterThan(0.35);
    expect(sig(`${c}bBusy`)).toBe(false);
    expect(sig(`${c}bResultOk`)).toBe(true);
    tick(0.2); // the result holds while the trigger is high
    expect(sig(`${c}bResultValid`)).toBe(true);
    force('bTrigger', false);
    until(() => sig(`${c}bReady`) && !sig(`${c}bResultValid`), 0.2, 'back to ready');
    // NOK.
    store().forceSignal('SIM_FG01_ForceNOK', true);
    force('bTrigger', true);
    until(() => sig(`${c}bResultValid`), 1, 'valid (NOK)');
    expect(sig(`${c}bResultOk`)).toBe(false);
    force('bTrigger', false);
    store().forceSignal('SIM_FG01_ForceNOK', false);
    until(() => sig(`${c}bReady`), 0.2, 'ready after NOK');
    // Trigger falls during Busy: the camera finishes and returns to Ready by itself.
    force('bTrigger', true);
    until(() => sig(`${c}bBusy`), 0.1, 'busy 2');
    tick(0.1);
    force('bTrigger', false);
    until(() => !sig(`${c}bBusy`) && sig(`${c}bReady`), 1, 'ready after a trigger that fell during busy');
    expect(sig(`${c}bResultValid`)).toBe(false);
    // Disable at Ready → everything false.
    force('bEnable', false);
    until(() => !sig(`${c}bReady`), 0.2, 'disabled');
    expect([sig(`${c}bBusy`), sig(`${c}bResultValid`), sig(`${c}bResultOk`)]).toEqual([false, false, false]);
    // A rising trigger while disabled does nothing.
    force('bTrigger', true);
    tick(0.5);
    expect(sig(`${c}bBusy`)).toBe(false);
    store().unforceAll();
  }, 120_000);

  it('connect while pallets wait at Stopper01/02 (return conveyor): forced stoppers release exactly one pallet each (lift driven by forcing)', async () => {
    await restart();
    tick(5);
    // plan-570: a pallet at Stopper02 (before Lift01), one queued at Stopper01, the lift empty.
    until(() => sig('FG_TS_Stopper01_B_Detect') && sig('FG_TS_Stopper02_B_Detect') && !sig('FG_TS_Lift01_B_Detect')
      && !sig('FG_TS_Lift01_B_Exit'), 120, 'pallets at Stopper01 and Stopper02, Lift01 empty');
    connect();
    tick(0.1);
    expect(sig('FG_TS_Stopper01_Y_Stopper_WorkPos') || sig('FG_TS_Stopper02_Y_Stopper_WorkPos'), 'virtual PLC stepped aside').toBe(false);
    // The real PLC (forced): return belt on, lift down, lift belt takes the pallet in.
    const f = (s: string, val: boolean) => store().forceSignal(s, val);
    f('FG_TS_Transport01_M_Conveyor_Plus', true);
    f('FG_TS_Lift01_Y_Lift_WorkPos', false);
    f('FG_TS_Lift01_Y_Lift_HomePos', true);
    f('FG_TS_Lift01_M_Conveyor_Plus', true);
    until(() => sig('FG_TS_Lift01_Y_Lift_InHome'), 10, 'Lift01 down');
    const onLift = () => mus().filter((m) => m.aabb.min.y < 0.6 && m.aabb.max.x < 2.75).length;
    f('FG_TS_Stopper02_Y_Stopper_WorkPos', true);
    until(() => sig('FG_TS_Stopper02_B_Exit'), 5, 'Stopper02 exit');
    until(() => sig('FG_TS_Lift01_B_Detect'), 10, 'pallet on Lift01');
    tick(2);
    expect(onLift(), 'exactly one pallet passed Stopper02 (SingleRelease)').toBe(1);
    f('FG_TS_Stopper02_Y_Stopper_WorkPos', false);
    until(() => sig('FG_TS_Stopper02_Y_Stopper_InHome'), 1, 'Stopper02 home');
    f('FG_TS_Stopper01_Y_Stopper_WorkPos', true);
    until(() => sig('FG_TS_Stopper01_B_Exit'), 5, 'Stopper01 exit');
    until(() => sig('FG_TS_Stopper02_B_Detect'), 10, 'separated pallet at Stopper02');
    tick(2);
    expect(onLift(), 'Stopper02 held the separated pallet').toBe(1);
    const failures: string[] = [];
    checkPlant(failures);
    expect(failures).toEqual([]);
    store().unforceAll();
  }, 120_000);

  it('connect with the fault latch set: latch resets; the motion enable then follows the E-stop level', async () => {
    await restart();
    tick(10);
    press('BT8_ImmediateStop', 0.2);
    expect(sig('SIM_FaultLatch')).toBe(true);
    expect(sig('SIM_MotionEnable')).toBe(false);
    connect();
    tick(0.1);
    expect(sig('SIM_FaultLatch')).toBe(false);
    expect(sig('SIM_MotionEnable')).toBe(true);
    // E-stop pressed: all cylinders and motors hold even with forced PLC outputs.
    setSig('i_SS_ESTOP2', false);
    tick(0.1);
    expect(sig('SIM_MotionEnable')).toBe(false);
    const snap = snapshotDrives();
    store().forceSignal('FG_TS_Transport02_M_Conveyor_Plus', true); // plan-570: main conveyor
    store().forceSignal('FG04_Y_AxisZ_HomePos', false);
    store().forceSignal('FG04_Y_AxisZ_WorkPos', true);
    tick(2);
    expect(movedSince(snap)).toEqual([]);
    // Released: the outputs are followed again.
    setSig('i_SS_ESTOP2', true);
    tick(0.1);
    expect(sig('SIM_MotionEnable')).toBe(true);
    until(() => sig('FG04_Y_AxisZ_InWork'), 1.5, 'FG04 follows WorkPos after the E-stop');
    expect(drive('Belt_Main').jogForward).toBe(true);
    store().unforceAll();
  }, 120_000);
});
