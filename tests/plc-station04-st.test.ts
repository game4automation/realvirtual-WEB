// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plc-station04-st.test.ts — the first real ST block of the Laser Welding
 * Assembly Station (Station 4, curling check) against a minimal plant fake.
 *
 * Real SignalStore + real QuickJS sandbox + real ST compiler through
 * `RVPlcRunner`, with the `RV_SimulationMode` system variable:
 *  - one full cycle: park → probe down → measure 1 s → probe up → stopper
 *    opens for exactly one pallet → pallet at Index05 → park again
 *  - PLC mode: the block writes nothing (a real PLC owns the outputs) and
 *    restarts at step 0 when Simulation mode returns
 *  - `RV_SimulationMode` is read-only: writing it fails the deploy
 *
 * Runs only in the private build (imports `@rv-private/plc/rv-plc-runner`).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { RVPlcRunner, SYS_SIMULATION_MODE } from '@rv-private/plc/rv-plc-runner';
import STATION04 from './fixtures/plc/station04-curling-check.st?raw';

const DT = 1 / 60;

const SIGNALS = [
  'SIM_AutoRelease', 'SIM_Parked_Station04',
  'FG_TS_Index04_B_Detect', 'FG_TS_Index05_B_Detect', 'FG_TS_Index04_B_Exit',
  'FG_TS_Index04_Y_Stopper_WorkPos',
  'FG04_Y_AxisZ_HomePos', 'FG04_Y_AxisZ_WorkPos', 'FG04_Y_AxisZ_InHome', 'FG04_Y_AxisZ_InWork',
];

let store: SignalStore;
let simulationMode: boolean;
let runner: RVPlcRunner;

/** Minimal plant: the probe follows its valves, the pallet leaves through an open stopper. */
function plantStep(): void {
  const work = store.getBool('FG04_Y_AxisZ_WorkPos');
  const home = store.getBool('FG04_Y_AxisZ_HomePos');
  store.set('FG04_Y_AxisZ_InWork', work && !home);
  store.set('FG04_Y_AxisZ_InHome', home && !work);
  if (store.getBool('FG_TS_Index04_Y_Stopper_WorkPos') && store.getBool('FG_TS_Index04_B_Detect')) {
    store.set('FG_TS_Index04_B_Detect', false);
    store.set('FG_TS_Index04_B_Exit', true);
  } else if (store.getBool('FG_TS_Index04_B_Exit')) {
    store.set('FG_TS_Index04_B_Exit', false);
    store.set('FG_TS_Index05_B_Detect', true);
  }
}

function run(seconds: number): void {
  const n = Math.ceil(seconds / DT);
  for (let i = 0; i < n; i++) {
    runner.tick(DT);
    plantStep();
  }
}

beforeEach(async () => {
  store = new SignalStore();
  for (const name of SIGNALS) store.register(name, `PLC/${name}`, false);
  store.set('FG04_Y_AxisZ_HomePos', true);
  store.set('FG04_Y_AxisZ_InHome', true);
  simulationMode = true;
  runner = new RVPlcRunner(store, {
    scanDeadlineMs: 50,
    systemInputs: new Map([[SYS_SIMULATION_MODE, () => simulationMode]]),
  });
  const diagnostics = await runner.deploy(STATION04);
  expect(diagnostics).toEqual([]);
  await runner.run();
});

afterEach(() => runner.dispose());

describe('Station 4 curling check (ST)', () => {
  it('parks, then runs one full cycle for a pallet at Index04', () => {
    run(0.1);
    expect(store.getBool('SIM_Parked_Station04')).toBe(true);

    store.set('FG_TS_Index04_B_Detect', true);
    run(0.1);
    expect(store.getBool('SIM_Parked_Station04')).toBe(true); // no auto release yet
    expect(store.getBool('FG04_Y_AxisZ_WorkPos')).toBe(false);

    store.set('SIM_AutoRelease', true);
    run(0.1);
    expect(store.getBool('SIM_Parked_Station04')).toBe(false);
    expect(store.getBool('FG04_Y_AxisZ_WorkPos')).toBe(true);
    expect(store.getBool('FG04_Y_AxisZ_InWork')).toBe(true);

    run(0.5); // measuring — probe stays down
    expect(store.getBool('FG04_Y_AxisZ_WorkPos')).toBe(true);
    run(0.6); // 1 s elapsed — probe up, stopper opens, pallet leaves
    expect(store.getBool('FG04_Y_AxisZ_HomePos')).toBe(true);
    expect(store.getBool('FG_TS_Index05_B_Detect')).toBe(true);
    expect(store.getBool('FG_TS_Index04_Y_Stopper_WorkPos')).toBe(false);
    expect(store.getBool('SIM_Parked_Station04')).toBe(true); // back at step 0
  });

  it('writes nothing in PLC mode and restarts at step 0 in Simulation mode', () => {
    store.set('FG_TS_Index04_B_Detect', true);
    store.set('SIM_AutoRelease', true);
    run(0.2);
    expect(store.getBool('FG04_Y_AxisZ_WorkPos')).toBe(true); // mid-cycle

    simulationMode = false; // a real PLC took over
    run(0.1);
    // The real PLC writes the outputs — the block must not overwrite them.
    store.set('FG04_Y_AxisZ_WorkPos', false);
    store.set('FG04_Y_AxisZ_HomePos', true);
    store.set('SIM_Parked_Station04', false);
    run(2);
    expect(store.getBool('FG04_Y_AxisZ_WorkPos')).toBe(false);
    expect(store.getBool('SIM_Parked_Station04')).toBe(false);
    expect(runner.watch().get('RV_SimulationMode')).toBe(false);

    simulationMode = true; // back to Simulation: restart from step 0 (park)
    run(0.1);
    expect(store.getBool('SIM_Parked_Station04')).toBe(false); // pallet still there → new cycle started
    expect(store.getBool('FG04_Y_AxisZ_WorkPos')).toBe(true);
  });

  it('refuses a program that writes the read-only RV_SimulationMode', async () => {
    const diagnostics = await runner.deploy(`PROGRAM Main
VAR_EXTERNAL
  RV_SimulationMode : BOOL;
END_VAR
  RV_SimulationMode := TRUE;
END_PROGRAM`);
    expect(diagnostics.some((d) => d.severity === 'error' && d.message.includes('read-only'))).toBe(true);
    expect(runner.state).toBe('error');
  });
});
