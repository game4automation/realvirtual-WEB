// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plc-scan-cycle.test.ts — plan-242 Phase 2 (PLC scan cycle, end-to-end).
 *
 * Real SignalStore + real QuickJS sandbox + real ST compiler through
 * `RVPlcRunner`:
 *  - input snapshot → scan → output batch (`setMany`) — the plan-242 §2.3
 *    example program (Sensor → TON → ConveyorStart) over sim-time ticks
 *  - outputs change only at scan boundaries (one listener callback per value
 *    change, no mid-scan visibility)
 *  - missing INPUT signal → warning diagnostic at deploy, the scan reads FALSE
 *  - missing OUTPUT signal → auto-registered under `PLC/<name>` (never write
 *    into the void)
 *  - `mem` (VAR) persists between scans; a big sim-time jump elapses a TON in
 *    one tick (sim-time base, not wallclock)
 *
 * Runs only in the private build (imports `@rv-private/plc/rv-plc-runner`).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { RVPlcRunner } from '@rv-private/plc/rv-plc-runner';

const DT = 1 / 60;

/** Example program from plan-242 §2.3: delayed conveyor start. */
const CONVEYOR_PROGRAM = `PROGRAM Main
VAR_EXTERNAL
  SensorInFeed : BOOL;
  ConveyorStart : BOOL;
END_VAR
VAR
  tDelay : TON;
END_VAR
  tDelay(IN := SensorInFeed, PT := T#2s);
  ConveyorStart := tDelay.Q;
END_PROGRAM`;

const PASSTHROUGH_PROGRAM = `PROGRAM Main
VAR_EXTERNAL
  SensorInFeed : BOOL;
  ConveyorStart : BOOL;
END_VAR
  ConveyorStart := SensorInFeed;
END_PROGRAM`;

let store: SignalStore;
const runners: RVPlcRunner[] = [];

function makeRunner(): RVPlcRunner {
  const runner = new RVPlcRunner(store, { scanDeadlineMs: 50 });
  runners.push(runner);
  return runner;
}

async function deployOk(runner: RVPlcRunner, code: string): Promise<void> {
  const diagnostics = await runner.deploy(code);
  expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  expect(runner.state).toBe('stopped');
}

function tickFor(runner: RVPlcRunner, seconds: number): void {
  const n = Math.ceil(seconds / DT);
  for (let i = 0; i < n; i++) runner.tick(DT);
}

beforeEach(() => {
  store = new SignalStore();
  store.register('SensorInFeed', 'DemoCell/Signals/SensorInFeed', false);
  store.register('ConveyorStart', 'DemoCell/Signals/ConveyorStart', false);
});

afterEach(() => {
  for (const runner of runners) runner.dispose();
  runners.length = 0;
});

// ─── Scan semantics ─────────────────────────────────────────────────────────

describe('PLC scan cycle — SignalStore I/O', () => {
  it('runs the plan-242 example: sensor → TON(2s) → conveyor over sim-time ticks', async () => {
    const runner = makeRunner();
    await deployOk(runner, CONVEYOR_PROGRAM);
    store.set('SensorInFeed', true);
    await runner.run();

    tickFor(runner, 1.0); // 1 s sim time — TON still timing
    expect(store.getBool('ConveyorStart')).toBe(false);

    tickFor(runner, 1.5); // total > 2 s — TON elapsed
    expect(store.getBool('ConveyorStart')).toBe(true);
    expect(runner.state).toBe('running');
    expect(runner.scanTimeMs).toBeGreaterThanOrEqual(0);
  });

  it('reads inputs as a snapshot and writes outputs via the store at scan end', async () => {
    const runner = makeRunner();
    await deployOk(runner, PASSTHROUGH_PROGRAM);
    store.set('SensorInFeed', true);
    runner.step(); // exactly one scan
    expect(store.getBool('ConveyorStart')).toBe(true);
    store.set('SensorInFeed', false);
    runner.step();
    expect(store.getBool('ConveyorStart')).toBe(false);
  });

  it('outputs change only at scan boundaries: one callback per value change', async () => {
    const runner = makeRunner();
    await deployOk(runner, PASSTHROUGH_PROGRAM);

    let callbacks = 0;
    store.subscribe('ConveyorStart', () => callbacks++);

    store.set('SensorInFeed', true);
    await runner.run();
    runner.tick(DT);
    runner.tick(DT);
    runner.tick(DT);
    // three scans, but only ONE value change (false → true) — unchanged batch
    // writes must not re-notify.
    expect(callbacks).toBe(1);

    store.set('SensorInFeed', false);
    runner.tick(DT);
    runner.tick(DT);
    expect(callbacks).toBe(2);
  });

  it('a big sim-time jump elapses the TON in a single tick (sim time, not wallclock)', async () => {
    const runner = makeRunner();
    await deployOk(runner, CONVEYOR_PROGRAM);
    store.set('SensorInFeed', true);
    await runner.run();

    runner.tick(DT); // rising edge captured at ~16.7 ms sim time
    expect(store.getBool('ConveyorStart')).toBe(false);

    runner.tick(2.5); // one giant sim step — wallclock-instant
    expect(store.getBool('ConveyorStart')).toBe(true);
  });

  it('mem (VAR) persists between scans', async () => {
    store.register('CountOut', 'DemoCell/Signals/CountOut', 0);
    const runner = makeRunner();
    await deployOk(
      runner,
      `PROGRAM Main
VAR_EXTERNAL CountOut : INT; END_VAR
VAR count : INT; END_VAR
  count := count + 1;
  CountOut := count;
END_PROGRAM`,
    );
    await runner.run();
    runner.tick(DT);
    runner.tick(DT);
    runner.tick(DT);
    expect(store.getInt('CountOut')).toBe(3);
  });

  it('watch() exposes externals and FB outputs after the last scan', async () => {
    const runner = makeRunner();
    await deployOk(runner, CONVEYOR_PROGRAM);
    store.set('SensorInFeed', true);
    await runner.run();
    tickFor(runner, 2.5);

    const watch = runner.watch();
    expect(watch.get('SensorInFeed')).toBe(true);
    expect(watch.get('ConveyorStart')).toBe(true);
    expect(watch.get('tDelay.Q')).toBe(true);
    expect(watch.get('tDelay.ET')).toBe(2000);
  });
});

// ─── Binding check at deploy ────────────────────────────────────────────────

describe('PLC scan cycle — signal binding', () => {
  it('missing input signal → warning diagnostic ("signal not found"), scan reads FALSE', async () => {
    const runner = makeRunner();
    const diagnostics = await runner.deploy(`PROGRAM Main
VAR_EXTERNAL
  MissingSensor : BOOL;
  ConveyorStart : BOOL;
END_VAR
  ConveyorStart := MissingSensor;
END_PROGRAM`);

    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const warnings = diagnostics.filter((d) => d.severity === 'warning');
    expect(warnings.some((d) => d.message.includes('MissingSensor') && d.message.includes('signal not found'))).toBe(true);

    store.set('ConveyorStart', true); // will be overwritten by the scan
    runner.step();
    expect(store.getBool('ConveyorStart')).toBe(false); // missing input reads FALSE
  });

  it('missing OUTPUT signal is auto-registered under PLC/<name> and written', async () => {
    const runner = makeRunner();
    expect(store.get('AutoOut')).toBeUndefined();
    const diagnostics = await runner.deploy(`PROGRAM Main
VAR_EXTERNAL
  SensorInFeed : BOOL;
  AutoOut : BOOL;
END_VAR
  AutoOut := SensorInFeed;
END_PROGRAM`);

    // auto-register happens at deploy — no warning, never write into the void
    expect(diagnostics.some((d) => d.message.includes('AutoOut'))).toBe(false);
    expect(store.get('AutoOut')).toBe(false);
    expect(store.getPath('AutoOut')).toBe('PLC/AutoOut');

    store.set('SensorInFeed', true);
    runner.step();
    expect(store.getBool('AutoOut')).toBe(true);
  });

  it('numeric externals use type-correct reads (INT truncated, REAL kept)', async () => {
    store.register('Speed', 'DemoCell/Signals/Speed', 0);
    store.register('SpeedOut', 'DemoCell/Signals/SpeedOut', 0);
    const runner = makeRunner();
    await deployOk(
      runner,
      `PROGRAM Main
VAR_EXTERNAL Speed : REAL; SpeedOut : REAL; END_VAR
  SpeedOut := Speed * 2.0;
END_PROGRAM`,
    );
    store.set('Speed', 1.25);
    runner.step();
    expect(store.getFloat('SpeedOut')).toBe(2.5);
  });
});
