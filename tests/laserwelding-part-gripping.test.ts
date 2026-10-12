// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * laserwelding-part-gripping.test.ts — plan-569 §9: the single parts of the
 * LaserWeldingAssemblyStation demo are real parts.
 *
 * Valve bodies (`PSA.OPCV.ASM_*`, tag `Valve`), connectors (tag `Connector`)
 * and caps (tag `Cap`) are pre-placed MUs that rest as passive loads in their
 * pallet (MU.LoadSeatDepth: pallet 70 mm, valve 40 mm — plan-577). FG05 takes
 * real caps from a feeder (Source → linear feeder → stop, `FG05_B_Part` from
 * a real sensor), screws one onto the valve in the cap seat of the pallet at
 * Index05 (GripTarget `LoadOnCarrier`); a removal grip + sink take the caps off
 * again on the return conveyor at Stopper02, in front of Lift01. FG03
 * Gripper2 transfers the upright valve from the right to the left jig.
 *
 * Grip triggers follow the END POSITION feedback of the gripper (InWork =
 * closed, InHome = open), never the command. A small plant sequence per grip
 * adds the interlock the station program does not have: FG05 only picks while
 * a valve sits in the cap seat, FG03 Gripper2 only while the left jig is free.
 *
 * Loads the shipping demo GLB (no patch) into a real test viewer, steps it with
 * `_tickOnce` (60 Hz). Private build only (imports `@rv-private`).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { PlcPlugin } from '@rv-private/plugins/plc/plc-plugin';
import { registerPlcProgramComponent } from '@rv-private/plc/rv-plc-program';
import { getPlcRuntime } from '../src/core/plc-control';
import { createTestViewer, type TestViewerHandle } from './helpers/create-test-viewer';
import { forEachInLoadTree } from '../src/core/engine/rv-mu-load';
import { getProblems } from '../src/core/hmi/problems-store';
import type { RVViewer } from '../src/core/rv-viewer';

const MODEL = '/demo-realvirtual/LaserWeldingAssemblyStation.glb';
const DT = 1 / 60;
const TEST_PLC = 'test-plc';
const PROGRAMS = 11;

/* eslint-disable @typescript-eslint/no-explicit-any */
let handle: TestViewerHandle;
let viewer: RVViewer;
let simTime = 0;
const v = (): any => viewer as any;
const tm = (): any => v().transportManager;
const store = (): any => v().signalStore;
const sig = (n: string): boolean => store().get(n) === true;
const force = (n: string, val: boolean): void => store().forceSignal(n, val);
const grip = (name: string): any => (tm().grips as any[]).find((g) => g.node.name === name);
const pre = (): any[] => tm().preplacedMUs as any[];
const mu = (name: string): any => pre().find((m) => m.getName() === name);
const tag = (m: any): string => m.node.userData.tag ?? '';
const caps = (): any[] => (tm().mus as any[]).filter((m) => tag(m) === 'Cap');
const capSource = (): any => (tm().sources as any[]).find((s) => s.node.name === 'FG05_CapSource');

function tick(seconds: number, each?: () => void): void {
  const n = Math.max(1, Math.round(seconds / DT));
  for (let i = 0; i < n; i++) {
    v()._tickOnce(DT);
    viewer.scene.updateMatrixWorld();
    simTime += DT;
    each?.();
  }
}
function until(pred: () => boolean, max: number, what: string, each?: () => void): number {
  const t0 = simTime;
  for (let i = 0; i < Math.round(max / DT); i++) {
    if (pred()) return simTime - t0;
    tick(DT, each);
  }
  if (pred()) return simTime - t0;
  throw new Error(`timeout after ${max} s: ${what}`);
}
async function plcRunning(): Promise<void> {
  for (let i = 0; i < 300; i++) {
    const ps = getPlcRuntime()?.programs() ?? [];
    if (ps.length >= PROGRAMS && ps.every((p: any) => p.state === 'running')) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('PLC programs not running');
}
async function restart(): Promise<void> {
  store().unforceAll();
  viewer.connectionMode.interfaceDisconnected(TEST_PLC);
  tick(DT);
  viewer.resetSimulation(); // also a COLD reset of every PLC program (asynchronous)
  // The state the reset restored — read synchronously: while the test awaits the PLC below, the
  // render loop may already tick the plant on (wall-clock dependent).
  atReset = { trees: loadTrees(), poses: poses() };
  await new Promise((r) => setTimeout(r, 500)); // let the cold reset land before the first tick
  await plcRunning();
  tick(DT);
}
function connect(): void {
  viewer.connectionMode.interfaceConnected(TEST_PLC);
  viewer.connectionMode.interfaceWrites(TEST_PLC, ['FG_TS_Transport01_M_Conveyor_Plus']);
  tick(DT * 2);
}
const names = (list: any[]): string[] => list.map((m) => m.getName()).sort();
const loadTree = (root: any): string[] => { const out: string[] = []; forEachInLoadTree(root, (m: any) => out.push(m.getName())); return out.sort(); };
/** Load tree of every pallet (`WT → [loads…]`) — the identity of the pre-placed assembly. */
function loadTrees(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const m of pre()) if (!m.loadedOn && !tag(m)) out[m.getName()] = loadTree(m);
  return out;
}
/** World pose of every pre-placed MU node (position, mm-rounded) — the authored state. */
function poses(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of pre()) {
    const p = m.node.getWorldPosition(new Vector3());
    out[m.getName()] = `${m.node.parent?.name}|${p.toArray().map((x: number) => x.toFixed(3)).join(',')}|${m.node.visible}`;
  }
  return out;
}
/** Max drift (m) of every load against its carrier since `ref` (current AABBs, recursive). */
function loadOffsets(): Map<any, Vector3> {
  const out = new Map<any, Vector3>();
  for (const m of pre()) {
    if (m.loadedOn) continue;
    m.updateAABB();
    forEachInLoadTree(m, (l: any) => {
      l.updateAABB(); l.loadedOn.updateAABB();
      out.set(l, new Vector3().subVectors(l.aabb.center, l.loadedOn.aabb.center));
    });
  }
  return out;
}

let afterLoad: { trees: Record<string, string[]>; poses: Record<string, string> };
/** The state right after a reset of the freshly loaded GLB — the reference of every later reset. */
let afterReset: { trees: Record<string, string[]>; poses: Record<string, string> };
let atReset: { trees: Record<string, string[]>; poses: Record<string, string> } = { trees: {}, poses: {} };

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
  afterLoad = { trees: loadTrees(), poses: poses() };
  await restart();
  afterReset = atReset;
}, 240_000);

afterAll(() => {
  store()?.unforceAll();
  viewer?.connectionMode.interfaceDisconnected(TEST_PLC);
  handle?.dispose();
});

describe('plan-569 — parts as passive loads (F1)', () => {
  it('after the load every part is a passive load; cap → valve → pallet on the three capped pallets; pallet box 93.8 mm', () => {
    // 14 pallets + 17 parts + 7 connectors on the formerly empty pallets + the valve of 1_1 at FG01
    // + valve and cap on 1_5/1_6/1_7 (return, before the removal) — plan-569 Teil 4: the start state
    // matches the line position (2_1 at Index04 carries its valve already turned; 3_1 without its right valve).
    expect(pre().length, 'pre-placed MUs: 14 pallets + 31 parts').toBe(45);
    expect(tm().mus.length, 'only the 14 pallets are active').toBe(14);
    for (const m of pre()) {
      if (!tag(m)) { m.updateAABB(); expect((m.aabb.max.y - m.aabb.min.y) * 1000, `${m.getName()} height`).toBeCloseTo(93.8, 0); continue; }
      expect(m.loadedOn, `${m.getName()} is a load`).not.toBeNull();
      expect(tm().mus.includes(m), `${m.getName()} passive`).toBe(false);
    }
    for (const [wt, valve, cap] of [['PALLET.JIG.ASM.4_1', 'PSA.OPCV.ASM_10', 'PSA.OPCV.CAP_5'],
      ['PALLET.JIG.ASM.4_2', 'PSAOPCVASM_10_1', 'PSAOPCVCAP_5_1'], ['PALLET.JIG.ASM.4_3', 'PSAOPCVASM_10_2', 'PSAOPCVCAP_5_2']]) {
      expect(mu(cap).loadedOn, `${cap} on its valve`).toBe(mu(valve));
      expect(mu(valve).loadedOn, `${valve} on its pallet`).toBe(mu(wt));
    }
    // Every part has exactly the tag of its kind; the cap template is not a pre-placed MU.
    expect(new Set(pre().map(tag))).toEqual(new Set(['', 'Valve', 'Connector', 'Cap']));
    expect(pre().some((m) => m.getName() === 'FG05_CapTemplate')).toBe(false);
  });

  it('FG05_B_Part has exactly one writer — the detect zone at the feeder pickup; the timed Logic_Plant_CapFeed is gone', () => {
    const writers: string[] = [];
    viewer.scene.traverse((o: any) => {
      const rv = o.userData?.realvirtual;
      const s = rv?.LogicStep_SetSignalBool?.Signal?.path as string | undefined;
      if (s?.endsWith('FG05_B_Part')) writers.push(`LogicStep ${o.name}`);
      const so = rv?.Sensor?.SensorOccupied?.path as string | undefined;
      if (so?.endsWith('FG05_B_Part')) writers.push(`Sensor ${o.name}`);
      const zo = rv?.Zone?.SignalOccupied?.path as string | undefined;
      if (zo?.endsWith('FG05_B_Part')) writers.push(`Zone ${o.name}`);
    });
    expect(writers).toEqual(['Zone FG05_PartSensor']);
    expect((v().logicEngine.roots as any[]).some((r) => r.name === 'Logic_Plant_CapFeed')).toBe(false);
    expect(v().logicEngine.warnings).toEqual([]);
  });
});

// Runs early on purpose: after several resets in a row the line can stall at Lift02 (pre-existing,
// plan-569 § Offener Rest), which would starve this throughput check.
describe('plan-569 Teil 4 — the valve body circulates (feed at the entry, removal on the return)', () => {
  it('every pallet is loaded once at the entry, no valve is ever left loose, and the valve balance holds', async () => {
    await restart();
    const feed = (tm().sources as any[]).find((s) => s.node.name === 'PartFeed_Source');
    const vSink = (tm().sinks as any[]).find((s) => s.node.name === 'ValveRemoval_Sink');
    const out: string[] = [];
    const unsub = vSink.subscribeConsumed((m: any) => out.push(m.getName()));
    const held = (m: any): boolean => (tm().grips as any[]).some((g) => g.grippedMUs.includes(m));
    let looseSince = -1; let longestLoose = 0;
    const fedBefore = feed.Created;
    tick(300, () => {
      const loose = (tm().mus as any[]).some((m) => tag(m) === 'Valve' && !held(m));
      if (loose) { if (looseSince < 0) looseSince = simTime; longestLoose = Math.max(longestLoose, simTime - looseSince); } else looseSince = -1;
    });
    unsub();
    const fed = feed.Created - fedBefore;
    let onPallets = 0; let doubled = 0;
    for (const m of tm().mus as any[]) {
      if (tag(m)) continue;
      let n = 0; forEachInLoadTree(m, (l: any) => { if (tag(l) === 'Valve') n++; });
      onPallets += n; if (n > 1) doubled++;
    }
    const active = (tm().mus as any[]).filter((m) => tag(m) === 'Valve').length;
    const preplacedValves = 11;
    expect(fed, 'the entry feeds a valve roughly every pallet cycle (~14 s)').toBeGreaterThan(15);
    expect(out.length, 'valves leave on the return conveyor (removal starts after ~90 s)').toBeGreaterThanOrEqual(12);
    expect(longestLoose, 'no valve is left loose (a refused place is re-used, never doubled)').toBeLessThan(1);
    expect(doubled, 'no pallet carries two valves').toBe(0);
    expect(fed + preplacedValves, `fed ${fed} + 11 = removed ${out.length} + on pallets ${onPallets} + active ${active}`)
      .toBe(out.length + onPallets + active);
    expect(getProblems().filter((p: any) => /seat/i.test(String(p.id)))).toEqual([]);
  }, 600_000);
});

describe('plan-569 — FG05 grips the cap and screws it onto the valve (F2, F3, F6)', () => {
  it('the cap (never the valve) is picked on the closed end position, carried, placed onto the valve at Index05 and rides along', async () => {
    await restart();
    const g = grip('FG05_Grip');
    // The first cycle: pallet 3_1 waits at Index05 with a valve in the cap seat.
    let commandAt = -1;
    let pickAt = -1;
    until(() => {
      if (commandAt < 0 && sig('FG05_Y_Gripper_WorkPos')) commandAt = simTime;
      if (pickAt < 0 && g.grippedMUs.length > 0) pickAt = simTime;
      return pickAt >= 0;
    }, 30, 'FG05 picks a cap');
    expect(commandAt, 'command before the end position').toBeGreaterThanOrEqual(0);
    expect(pickAt - commandAt, 'pick only after the end position (TimeIn 0.3 s)').toBeGreaterThan(0.2);
    const cap = g.grippedMUs[0];
    expect(g.grippedMUs.length).toBe(1);
    expect(tag(cap), 'a cap, not the valve').toBe('Cap');
    expect(cap.isInstanced).toBe(false);
    // Placed on the open end position at the pallet: a load of the VALVE in the cap seat.
    until(() => g.grippedMUs.length === 0, 15, 'FG05 places the cap');
    const valve = cap.loadedOn;
    expect(valve, 'cap is a load').not.toBeNull();
    expect(tag(valve), 'carrier is a valve').toBe('Valve');
    expect(valve.loadedOn?.getName()).toBe('PALLET.JIG.ASM.3_1');
    expect(tm().mus.includes(cap), 'cap passive').toBe(false);
    // Rides along when the pallet leaves Index05 (drift < 0.1 mm).
    const wt = valve.loadedOn;
    const off0 = loadOffsets();
    const x0 = wt.node.getWorldPosition(new Vector3()).x;
    let drift = 0;
    until(() => wt.node.getWorldPosition(new Vector3()).x - x0 > 0.1, 30, 'pallet moves on', () => {
      for (const [l, o] of loadOffsets()) if (off0.has(l)) drift = Math.max(drift, o.distanceTo(off0.get(l)!));
    });
    expect(drift).toBeLessThan(0.0001);
    expect(cap.loadedOn).toBe(valve);
  }, 300_000);

});

describe('plan-569 — FG03 Gripper2 transfer and handover (F2, F4, F6)', () => {
  it('Gripper2 takes the upright valve from the right jig and puts it into the left jig (load of the same pallet); the connector stays', async () => {
    await restart();
    const g = grip('FG03_Grip2');
    let picked: any = null;
    until(() => { if (!picked && g.grippedMUs.length) picked = g.grippedMUs[0]; return !!picked; }, 30, 'Gripper2 picks');
    expect(tag(picked)).toBe('Valve');
    const wt = mu('PALLET.JIG.ASM.2_2');
    expect(loadTree(wt), 'the connector stays on the pallet while the valve is held').toEqual(['PSAOPCVCONNECTORASM_3_1']);
    const x0 = picked.node.getWorldPosition(new Vector3()).x;
    until(() => g.grippedMUs.length === 0, 10, 'Gripper2 places');
    expect(picked.loadedOn, 'load of its pallet again').toBe(wt);
    // plan-569 Teil 2: the X2 stroke is the measured nest pitch (80.000 mm), not the axis limit of 100 mm —
    // that is what puts the valve axis exactly on the axis of the left jig.
    expect(picked.node.getWorldPosition(new Vector3()).x - x0, 'moved by the X2 stroke (= 80 mm nest pitch) into the left jig').toBeCloseTo(-0.08, 3);
  }, 300_000);

  it('handover: a part held by one grip is never taken by another; a pallet and a connector are never gripped', async () => {
    await restart();
    const gripped = new Map<string, Set<string>>();
    const holders = new Map<any, string>();
    tick(120, () => {
      for (const g of tm().grips as any[]) {
        for (const m of g.grippedMUs) {
          (gripped.get(g.node.name) ?? gripped.set(g.node.name, new Set()).get(g.node.name)!).add(tag(m));
          const h = holders.get(m);
          if (h && h !== g.node.name && (tm().grips as any[]).find((x) => x.node.name === h).grippedMUs.includes(m)) {
            throw new Error(`${m.getName()} held by ${h} AND ${g.node.name}`);
          }
          holders.set(m, g.node.name);
        }
      }
    });
    expect([...gripped.get('FG05_Grip') ?? []]).toEqual(['Cap']);
    expect([...gripped.get('FG03_Grip2') ?? []]).toEqual(['Valve']);
    expect([...gripped.get('CapRemoval_Grip') ?? []]).toEqual(['Cap']);
  }, 300_000);

});

describe('plan-569 — cap removal on the return conveyor and material balance (F7)', () => {
  it('the capped pallets lose their cap, THEN their valve at Stopper02; created caps = removed caps + caps in the cell', async () => {
    await restart();
    const removed: string[] = [];
    const valvesOut: string[] = [];
    const sink = (tm().sinks as any[]).find((s) => s.node.name === 'CapRemoval_Sink');
    const vSink = (tm().sinks as any[]).find((s) => s.node.name === 'ValveRemoval_Sink');
    const unsub = sink.subscribeConsumed((m: any) => removed.push(m.getName()));
    // A valve must leave WITHOUT a cap - a cap in its load tree would vanish past the cap sink.
    const unsubV = vSink.subscribeConsumed((m: any) => {
      let capsOn = 0; forEachInLoadTree(m, (l: any) => { if (l !== m && tag(l) === 'Cap') capsOn++; });
      valvesOut.push(`${m.getName()}${capsOn ? ' +cap' : ''}`);
    });
    const valve = mu('PSAOPCVASM_10_1');
    until(() => removed.includes('PSAOPCVCAP_5_1'), 150, 'cap of 4_2 removed');
    expect(valve.loadedOn?.getName(), 'the valve is still on its pallet when the cap leaves').toBe('PALLET.JIG.ASM.4_2');
    until(() => valvesOut.includes('PSAOPCVASM_10_1'), 10, 'valve of 4_2 removed after its cap');
    tick(120);
    unsub(); unsubV();
    expect(valvesOut.filter((n) => n.endsWith('+cap')), 'no valve leaves with its cap').toEqual([]);
    const inCell = caps().length; // feeder + held (a held cap stays an active MU)
    let onPallets = 0;
    for (const m of tm().mus as any[]) forEachInLoadTree(m, (l: any) => { if (tag(l) === 'Cap') onPallets++; });
    const created = capSource().Created;
    const preplacedCaps = 6;
    expect(created + preplacedCaps, `created ${created} + 6 = removed ${removed.length} + active ${inCell} + on pallets ${onPallets}`)
      .toBe(removed.length + inCell + onPallets);
    expect(getProblems().filter((p: any) => /seat/i.test(String(p.id)))).toEqual([]);
  }, 400_000);
});

describe('plan-569 — reset (F8)', () => {
  async function expectAsLoaded(label: string): Promise<void> {
    await restart();
    expect(atReset.trees, `${label}: load trees as loaded`).toEqual(afterLoad.trees);
    expect(atReset.poses, `${label}: parent / pose / visibility as after the first reset`).toEqual(afterReset.poses);
    expect(tm().mus.length, `${label}: MU count`).toBe(14);
    for (const g of tm().grips as any[]) expect(g.grippedMUs.length, `${label}: ${g.node.name} empty`).toBe(0);
    let spawned = 0;
    viewer.scene.traverse((o: any) => { if (/^FG05_CapTemplate_\d+$/.test(o.name)) spawned++; });
    expect(spawned, `${label}: generated caps removed`).toBe(0);
  }
  it('reset while FG05 holds a cap', async () => {
    await restart();
    until(() => grip('FG05_Grip').grippedMUs.length > 0, 30, 'FG05 holds a cap');
    await expectAsLoaded('during grip');
  }, 300_000);
  it('reset while Gripper2 carries a valve (the transfer instead of the turnover, see plan)', async () => {
    await restart();
    until(() => grip('FG03_Grip2').grippedMUs.length > 0, 30, 'Gripper2 holds a valve');
    await expectAsLoaded('during transfer');
  }, 300_000);
  it('reset after the cap was placed and after a cap was removed', async () => {
    await restart();
    until(() => mu('PSAOPCVCAP_5_1').markedForRemoval || !mu('PSAOPCVCAP_5_1').loadedOn, 150, 'a pre-placed cap removed');
    tick(1);
    await expectAsLoaded('after placement and removal');
    await expectAsLoaded('second reset');
  }, 400_000);
});

// Commissioning cases last: they connect a PLC and force outputs (plan-539 F15).
describe('plan-569 — FG05 feed and grip with forced PLC outputs (F3, F6, SOL #3)', () => {
  it('without a real cap FG05_B_Part stays false — also with the linear feeder running for good', async () => {
    await restart();
    connect(); // the virtual PLC steps aside, the plant keeps running
    force('FG05_M_Bunker', false);
    force('FG05_M_Conveyor', true);
    tick(5, () => expect(sig('FG05_B_Part'), 'B_Part without a cap').toBe(false));
    expect(caps().length, 'bunker off → no cap').toBe(0);
    store().unforceAll();
  }, 300_000);

  it('bunker permanently on: caps only at a free inlet, bounded number, staggered; the gripper takes one → refill', async () => {
    await restart();
    connect();
    force('FG05_M_Bunker', true);
    force('FG05_M_Conveyor', true);
    let maxCaps = 0;
    const spawnTimes: number[] = [];
    let lastCreated = capSource().Created;
    const watch = (): void => {
      maxCaps = Math.max(maxCaps, caps().length);
      if (capSource().Created !== lastCreated) { lastCreated = capSource().Created; spawnTimes.push(simTime); }
      // a cap is never generated while the inlet is occupied (the sequence reads the inlet sensor first)
    };
    until(() => sig('FG05_B_Part'), 10, 'first cap at the pickup', watch);
    tick(40, watch);
    expect(sig('SIM_FG05_CapInletOccupied'), 'queue reaches the inlet').toBe(true);
    const full = caps().length;
    expect(full, 'feeder full').toBeGreaterThanOrEqual(8);
    expect(maxCaps, 'bounded').toBeLessThanOrEqual(11);
    for (let i = 1; i < spawnTimes.length; i++) expect(spawnTimes[i] - spawnTimes[i - 1], 'staggered').toBeGreaterThan(0.6);
    for (const c of caps()) expect(c.isInstanced, `${c.getName()} is a clone`).toBe(false);
    // Blocked inlet: nothing more for 5 s.
    const created = capSource().Created;
    tick(5);
    expect(capSource().Created, 'inlet blocked → no spawn').toBe(created);
    // Release: take the front cap with the FG05 grip (pick at the pickup, Z2 down) → the queue moves → refill.
    const g = grip('FG05_Grip');
    force('FG05_Y_AxisZ2_HomePos', false);
    force('FG05_Y_AxisZ2_WorkPos', true);
    until(() => sig('FG05_Y_AxisZ2_InWork'), 2, 'Z2 down');
    force('FG05_Y_Gripper_HomePos', false);
    force('FG05_Y_Gripper_WorkPos', true); // closed end position → plant pick (valve of 3_1 in the seat)
    until(() => g.grippedMUs.length > 0, 2, 'front cap picked');
    expect(g.grippedMUs.map(tag), 'the front cap is picked').toEqual(['Cap']);
    force('FG05_Y_AxisZ2_WorkPos', false);
    force('FG05_Y_AxisZ2_HomePos', true);
    until(() => sig('FG05_Y_AxisZ2_InHome'), 2, 'Z2 up');
    until(() => capSource().Created > created, 10, 'refill after the release');
    store().unforceAll();
  }, 400_000);

  it('end position, not command: a forced command alone never picks; the InWork edge picks exactly once', async () => {
    await restart();
    until(() => sig('FG05_B_Part'), 15, 'a cap at the pickup');
    connect();
    const g = grip('FG05_Grip');
    expect(sig('SIM_FG05_SeatValve'), 'valve in the seat at Index05').toBe(true);
    force('FG05_Y_AxisZ2_HomePos', false);
    force('FG05_Y_AxisZ2_WorkPos', true);
    until(() => sig('FG05_Y_AxisZ2_InWork'), 2, 'Z2 down');
    expect(sig('FG05_Y_Gripper_InHome'), 'neutral: open').toBe(true);
    expect(g.grippedMUs.length, 'neutral: empty').toBe(0);
    force('FG05_Y_Gripper_HomePos', false);
    force('FG05_Y_Gripper_WorkPos', true);
    tick(0.15);
    expect(sig('FG05_Y_Gripper_InWork'), 'end position not reached yet').toBe(false);
    expect(g.grippedMUs.length, 'no pick on the command').toBe(0);
    until(() => sig('FG05_Y_Gripper_InWork'), 1, 'closed');
    tick(DT * 3);
    expect(g.grippedMUs.length, 'exactly one pick').toBe(1);
    tick(1);
    expect(g.grippedMUs.length, 'no second pick while held').toBe(1);
    store().unforceAll();
  }, 300_000);

  it('an occupied seat raises a Problems entry instead of stacking (forced second cap onto a capped valve)', async () => {
    await restart();
    const g = grip('FG05_Grip');
    until(() => g.grippedMUs.length > 0, 30, 'first cap picked');
    until(() => g.grippedMUs.length === 0, 15, 'first cap placed');
    const placed = (pre().find((m) => m.getName() === 'PALLET.JIG.ASM.3_1'));
    connect(); // the station program steps aside, the pallet stays at Index05
    // Fetch a second cap and bring it to the same (now capped) seat by forcing the axes.
    const go = (out: string, on: boolean, fb: string, max = 3): void => {
      force(`${out}_${on ? 'HomePos' : 'WorkPos'}`, false);
      force(`${out}_${on ? 'WorkPos' : 'HomePos'}`, true);
      until(() => sig(`${fb}_${on ? 'InWork' : 'InHome'}`), max, `${out} ${on ? 'work' : 'home'}`);
    };
    go('FG05_Y_AxisX', false, 'FG05_Y_AxisX');
    go('FG05_Y_AxisZ1', false, 'FG05_Y_AxisZ1');
    force('FG05_M_Bunker', true); force('FG05_M_Conveyor', true);
    until(() => sig('FG05_B_Part'), 15, 'a cap at the pickup');
    go('FG05_Y_AxisZ2', true, 'FG05_Y_AxisZ2');
    go('FG05_Y_Gripper', true, 'FG05_Y_Gripper');
    tick(DT * 3);
    expect(g.grippedMUs.length, 'second cap picked').toBe(1);
    go('FG05_Y_AxisZ2', false, 'FG05_Y_AxisZ2');
    go('FG05_Y_AxisX', true, 'FG05_Y_AxisX');
    go('FG05_Y_AxisZ1', true, 'FG05_Y_AxisZ1');
    go('FG05_Y_AxisZ2', true, 'FG05_Y_AxisZ2');
    go('FG05_Y_Gripper', false, 'FG05_Y_Gripper');
    tick(DT * 3);
    expect(g.grippedMUs.length, 'refused: the cap stays in the gripper').toBe(1);
    const seat = getProblems().filter((p: any) => p.code === 'grip-seat-occupied');
    expect(seat.length, JSON.stringify(getProblems())).toBe(1);
    expect(loadTree(placed).filter((n) => /Template/.test(n)).length, 'one cap on the valve, not two').toBe(1);
    store().unforceAll();
  }, 300_000);
});
