// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plc-logicstep-to-st.test.ts — LogicStep sequences → Structured Text.
 *
 * Parity: the SAME sequence runs once as real RVLogicStep objects and once as
 * generated ST on the virtual PLC, against the same scripted plant stimulus.
 * The output traces (value per tick) must match — set / level wait / rising
 * edge / delay / jump / auto-loop and a parallel container fanned out into
 * chains. Also: connection mode (PLC mode writes nothing, restart at step 0),
 * TIA tag names with dots (@signal pragma) and DriveTo through a mapping.
 *
 * Runs only in the private build (imports `@rv-private`).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import {
  RVSerialContainer, RVParallelContainer, RVSetSignalBool, RVWaitForSignalBool, RVDelay, RVJumpOnSignal,
  type RVLogicStep,
} from '../src/core/engine/rv-logic-step';
import { compileSt } from '@rv-private/plc/st-compiler';
import { RVPlcRunner, SYS_SIMULATION_MODE } from '@rv-private/plc/rv-plc-runner';
import { convertLogicStepsToSt, type LsNode } from '@rv-private/plc/logicstep-to-st';

const DT = 1 / 60;
const ref = (name: string) => ({ type: 'ComponentReference', path: `PLC/${name}`, componentType: 'PLCOutputBool' });
const set = (name: string, sig: string, v: boolean): LsNode => ({ name, type: 'LogicStep_SetSignalBool', data: { Signal: ref(sig), SetToTrue: v }, children: [] });
const waitFor = (name: string, sig: string, v: boolean, edge = 'Level'): LsNode => ({ name, type: 'LogicStep_WaitForSignalBool', data: { Signal: ref(sig), WaitForTrue: v, Edge: edge }, children: [] });
const delay = (name: string, s: number): LsNode => ({ name, type: 'LogicStep_Delay', data: { Duration: s }, children: [] });
const jump = (name: string, sig: string, on: boolean, to: string): LsNode => ({ name, type: 'LogicStep_JumpOnSignal', data: { Signal: ref(sig), JumpOn: on, JumpToStep: to }, children: [] });
const serial = (name: string, children: LsNode[]): LsNode => ({ name, type: 'LogicStep_SerialContainer', data: {}, children });
const parallel = (name: string, children: LsNode[]): LsNode => ({ name, type: 'LogicStep_ParallelContainer', data: {}, children });
const resolveSignal = (r: unknown) => {
  const p = (r as { path?: string })?.path;
  return p ? { name: p.replace(/^PLC\//, '') } : null;
};

/** Builds real RVLogicStep objects from the same LsNode tree. */
function buildEngine(node: LsNode, store: SignalStore, parent: RVSerialContainer | null = null): RVLogicStep {
  const path = (f: string) => (node.data[f] as { path: string }).path;
  let step: RVLogicStep;
  switch (node.type) {
    case 'LogicStep_SerialContainer': {
      const c = new RVSerialContainer([], true);
      c.children = node.children.map((ch) => buildEngine(ch, store, c));
      step = c; break;
    }
    case 'LogicStep_ParallelContainer': step = new RVParallelContainer(node.children.map((ch) => buildEngine(ch, store, null))); break;
    case 'LogicStep_SetSignalBool': step = new RVSetSignalBool(path('Signal'), node.data['SetToTrue'] !== false, store); break;
    case 'LogicStep_WaitForSignalBool': step = new RVWaitForSignalBool(path('Signal'), node.data['WaitForTrue'] !== false, store, (node.data['Edge'] as 'Level') ?? 'Level'); break;
    case 'LogicStep_Delay': step = new RVDelay(node.data['Duration'] as number); break;
    case 'LogicStep_JumpOnSignal': step = new RVJumpOnSignal(path('Signal'), node.data['JumpOn'] !== false, node.data['JumpToStep'] as string, store, parent); break;
    default: throw new Error(node.type);
  }
  step.name = node.name;
  return step;
}

const runners: RVPlcRunner[] = [];
afterEach(() => { for (const r of runners) r.dispose(); runners.length = 0; });

function makeStore(signals: string[]): SignalStore {
  const s = new SignalStore();
  for (const n of signals) s.register(n, `PLC/${n}`, false);
  return s;
}

/**
 * Runs both variants for `ticks` ticks; `plant(store, tick)` plays the
 * environment (inputs) after each tick. Returns the per-tick traces of `outputs`.
 */
async function runBoth(roots: LsNode[], signals: string[], outputs: string[], ticks: number,
  plant: (s: SignalStore, tick: number) => void) {
  // engine
  const se = makeStore(signals);
  const engineRoots = roots.map((r) => buildEngine(r, se));
  for (const r of engineRoots) r.start();
  const te: string[] = [];
  for (let t = 0; t < ticks; t++) {
    for (const r of engineRoots) r.fixedUpdate(DT);
    te.push(outputs.map((o) => (se.getBool(o) ? 1 : 0)).join(''));
    plant(se, t);
  }
  // ST
  const { code, warnings } = convertLogicStepsToSt(roots, { programName: 'Test', resolveSignal });
  expect(warnings).toEqual([]);
  expect(compileSt(code).diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  const ss = makeStore(signals);
  const runner = new RVPlcRunner(ss, { scanDeadlineMs: 50, systemInputs: new Map([[SYS_SIMULATION_MODE, () => true]]) });
  runners.push(runner);
  expect((await runner.deploy(code)).filter((d) => d.severity === 'error')).toEqual([]);
  await runner.run();
  const ts: string[] = [];
  for (let t = 0; t < ticks; t++) {
    runner.tick(DT);
    ts.push(outputs.map((o) => (ss.getBool(o) ? 1 : 0)).join(''));
    plant(ss, t);
  }
  return { te, ts, code };
}

/** First tick at which every output reached its final per-change sequence — compares the CHANGE sequence with timing. */
function changes(trace: string[]): string[] {
  const out: string[] = [];
  trace.forEach((v, i) => { if (i === 0 || v !== trace[i - 1]) out.push(`${i}:${v}`); });
  return out;
}

/**
 * Same output changes in the same order; each change within 2 ticks + 2 % of
 * the elapsed time. Exact tick parity is not meaningful: the engine sums dt,
 * TON compares timestamps, and both round a delay to the next tick differently
 * for some durations (one tick = 16.7 ms), so long runs drift apart slowly.
 */
function expectSameBehaviour(engine: string[], st: string[]): void {
  // Per output: independent chains drift independently, so a combined string would show artefacts.
  for (let o = 0; o < engine[0].length; o++) {
    const a = changes(engine.map((v) => v[o])), b = changes(st.map((v) => v[o]));
    expect(b.map((c) => c.split(':')[1])).toEqual(a.map((c) => c.split(':')[1]));
    a.forEach((c, i) => {
      const t = Number(c.split(':')[0]);
      expect(Math.abs(t - Number(b[i].split(':')[0]))).toBeLessThanOrEqual(2 + t * 0.02);
    });
  }
}

describe('LogicStep → ST parity', () => {
  it('set / level wait / delay / jump / auto-loop — identical output trace', async () => {
    // A station-like cycle: park, wait for part + release, move, delay, return, recheck jump.
    const root = serial('Logic_PLC_Station', [
      set('S0_Park', 'Parked', true),
      waitFor('S1_WaitRelease', 'Release', true),
      waitFor('S2_WaitPart', 'Part', true),
      jump('S3_Recheck', 'Release', false, 'S1_WaitRelease'),
      set('S4_Unpark', 'Parked', false),
      set('S5_Work', 'Work', true),
      waitFor('S6_InWork', 'InWork', true),
      delay('S7_Measure', 1.0),
      set('S8_Home', 'Work', false),
      waitFor('S9_InHome', 'InWork', false),
    ]);
    const plant = (s: SignalStore, t: number) => {
      s.set('Release', t >= 10 && t < 200);
      s.set('Part', (t >= 20 && t < 120) || t >= 150);
      s.set('InWork', s.getBool('Work')); // cylinder follows the valve one tick later
    };
    const { te, ts } = await runBoth([root], ['Parked', 'Release', 'Part', 'Work', 'InWork'], ['Parked', 'Work'], 260, plant);
    expectSameBehaviour(te, ts);
  });

  it('rising edge waits only for a transition after the step started', async () => {
    const root = serial('Logic_PLC_Edge', [
      waitFor('E0', 'Btn', true, 'Rising'),
      set('E1', 'Lamp', true),
      waitFor('E2', 'Btn', false, 'Falling'),
      set('E3', 'Lamp', false),
    ]);
    const plant = (s: SignalStore, t: number) => { s.set('Btn', (t >= 0 && t < 5) || (t >= 30 && t < 40) || (t >= 70 && t < 75)); };
    const { te, ts } = await runBoth([root], ['Btn', 'Lamp'], ['Lamp'], 100, plant);
    expectSameBehaviour(te, ts);
  });

  it('a parallel container becomes independent chains', async () => {
    const root = serial('Logic_PLC_Modes', [parallel('M_Parallel', [
      serial('M_A', [waitFor('A0', 'X', true), set('A1', 'OutA', true), delay('A2', 1.0), set('A3', 'OutA', false), waitFor('A4', 'X', false)]),
      serial('M_B', [delay('B0', 1.5), set('B1', 'OutB', true), delay('B2', 1.0), set('B3', 'OutB', false)]),
    ])]);
    const plant = (s: SignalStore, t: number) => { s.set('X', (t >= 15 && t < 150) || (t >= 300 && t < 420)); };
    const { te, ts } = await runBoth([root], ['X', 'OutA', 'OutB'], ['OutA', 'OutB'], 600, plant);
    expectSameBehaviour(te, ts);
  });
});

describe('LogicStep → ST conversion', () => {
  it('binds TIA tag names with dots through the @signal pragma', () => {
    const root = serial('Logic_PLC_Cam', [set('C0', 'FG01_P_Camera.bTrigger', true)]);
    const { code } = convertLogicStepsToSt([root], { programName: 'P', resolveSignal });
    expect(code).toContain('FG01_P_Camera_bTrigger : BOOL; (* @signal: FG01_P_Camera.bTrigger *)');
    expect(compileSt(code).diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });

  it('maps DriveTo to a command signal and waits for its feedback', async () => {
    const drive: LsNode = { name: 'D0_Lower', type: 'LogicStep_DriveTo', data: { Destination: -15, drive: { path: 'Stopper' } }, children: [] };
    const root = serial('Logic_PLC_Lift', [drive, set('D1', 'Done', true)]);
    const { code, warnings } = convertLogicStepsToSt([root], {
      programName: 'P', resolveSignal,
      mapDriveTo: () => ({ command: { name: 'Lower' }, value: true, done: { name: 'AtLow' } }),
    });
    expect(warnings).toEqual([]);
    const store = makeStore(['Lower', 'AtLow', 'Done']);
    const runner = new RVPlcRunner(store, { scanDeadlineMs: 50, systemInputs: new Map([[SYS_SIMULATION_MODE, () => true]]) });
    runners.push(runner);
    await runner.deploy(code); await runner.run();
    runner.tick(DT);
    expect(store.getBool('Lower')).toBe(true);
    runner.tick(DT); runner.tick(DT);
    expect(store.getBool('Done')).toBe(false); // feedback missing
    store.set('AtLow', true);
    runner.tick(DT);
    expect(store.getBool('Done')).toBe(true);
  });

  it('PLC mode: writes nothing, restarts at step 0 in Simulation mode', async () => {
    const root = serial('Logic_PLC_M', [set('M0', 'A', true), waitFor('M1', 'Go', true), set('M2', 'A', false), waitFor('M3', 'Go', false)]);
    const { code } = convertLogicStepsToSt([root], { programName: 'P', resolveSignal });
    let sim = true;
    const store = makeStore(['A', 'Go']);
    const runner = new RVPlcRunner(store, { scanDeadlineMs: 50, systemInputs: new Map([[SYS_SIMULATION_MODE, () => sim]]) });
    runners.push(runner);
    await runner.deploy(code); await runner.run();
    runner.tick(DT);
    expect(store.getBool('A')).toBe(true);
    sim = false;
    store.set('Go', true);
    for (let i = 0; i < 5; i++) runner.tick(DT);
    store.set('A', true); // a real PLC wrote it — must stay
    runner.tick(DT);
    expect(store.getBool('A')).toBe(true);
    sim = true;
    store.set('A', false);
    runner.tick(DT); // restart at step 0: sets A, Go already TRUE → resets A in the same scan
    expect(store.getBool('A')).toBe(false);
  });

  it('reports unsupported steps instead of guessing', () => {
    const root = serial('Logic_PLC_X', [{ name: 'X0', type: 'LogicStep_GripPick', data: {}, children: [] }]);
    const { warnings } = convertLogicStepsToSt([root], { programName: 'P', resolveSignal });
    expect(warnings.some((w) => w.includes('LogicStep_GripPick is not supported'))).toBe(true);
  });
});


describe('ST v1.1 reserved LogicStep signal identifiers', () => {
  it.each(['Exit', 'Return', 'Constant', 'RV_FirstScan'])('aliases signal %s', (name) => {
    const root = serial('Logic_PLC_Test', [set('S0', name, true)]);
    const { code, warnings } = convertLogicStepsToSt([root], { programName: 'P', resolveSignal });
    expect(warnings).toEqual([]);
    const alias = name === 'RV_FirstScan' ? 'RV_FirstScan_2' : `${name}_`;
    expect(code).toContain(`${alias} : BOOL; (* @signal: ${name} *)`);
    expect(code).toContain(`${alias} := TRUE;`);
    expect(compileSt(code).diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });
  it.each(['SHL', 'SHR', 'ROL', 'ROR'])('preserves non-reserved signal identifier %s', (name) => {
    const root = serial('Logic_PLC_Test', [set('S0', name, true)]);
    const { code, warnings } = convertLogicStepsToSt([root], { programName: 'P', resolveSignal });
    expect(warnings).toEqual([]);
    expect(code).toContain(`${name} : BOOL;`);
    expect(code).toContain(`${name} := TRUE;`);
    expect(compileSt(code).diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });
});
