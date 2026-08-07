// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plc-lifecycle.test.ts — plan-242 Phase 2 (run-state gate, errors, recovery).
 *
 * Lifecycle contract of `RVPlcRunner` (public surface: `PlcControl`):
 *  - tick() without run() is a no-op (run-state gate)
 *  - step() executes exactly one scan, independent of the run state
 *  - a guest runtime error (division by zero) → state 'error' + lastError,
 *    further ticks are no-ops
 *  - run() after an error performs a COLD restart with a fresh sandbox
 *    (also after a poisoned sandbox from an infinite loop)
 *  - reset() restores FB states and program memory (COLD)
 *  - deploy() with a compile error → 'error' state + diagnostics
 *  - PlcControl mini registry (register/get/null)
 *
 * Runs only in the private build (imports `@rv-private/plc/rv-plc-runner`).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { RVPlcRunner } from '@rv-private/plc/rv-plc-runner';
import { registerPlcControl, getPlcControl } from '../src/core/plc-control';

const DT = 1 / 60;

const COUNTER_PROGRAM = `PROGRAM Main
VAR_EXTERNAL CountOut : INT; END_VAR
VAR count : INT; END_VAR
  count := count + 1;
  CountOut := count;
END_PROGRAM`;

const DIVISION_PROGRAM = `PROGRAM Main
VAR_EXTERNAL D : INT; Q : INT; END_VAR
  Q := 10 / D;
END_PROGRAM`;

const TON_PROGRAM = `PROGRAM Main
VAR_EXTERNAL SensorInFeed : BOOL; ConveyorStart : BOOL; END_VAR
VAR tDelay : TON; END_VAR
  tDelay(IN := SensorInFeed, PT := T#1s);
  ConveyorStart := tDelay.Q;
END_PROGRAM`;

const INFINITE_LOOP_PROGRAM = `PROGRAM Main
VAR x : INT; END_VAR
  WHILE TRUE DO x := x + 1; END_WHILE;
END_PROGRAM`;

let store: SignalStore;
const runners: RVPlcRunner[] = [];

function makeRunner(): RVPlcRunner {
  const runner = new RVPlcRunner(store, { scanDeadlineMs: 50 });
  runners.push(runner);
  return runner;
}

function tickFor(runner: RVPlcRunner, seconds: number): void {
  const n = Math.ceil(seconds / DT);
  for (let i = 0; i < n; i++) runner.tick(DT);
}

beforeEach(() => {
  store = new SignalStore();
  store.register('CountOut', 'PLC/CountOut', 0);
  store.register('D', 'PLC/D', 0);
  store.register('Q', 'PLC/Q', 0);
  store.register('SensorInFeed', 'Cell/SensorInFeed', false);
  store.register('ConveyorStart', 'Cell/ConveyorStart', false);
});

afterEach(() => {
  for (const runner of runners) runner.dispose();
  runners.length = 0;
  registerPlcControl(null);
});

// ─── Run-state gate ─────────────────────────────────────────────────────────

describe('PLC lifecycle — run-state gate', () => {
  it('tick() without run() does not scan', async () => {
    const runner = makeRunner();
    await runner.deploy(COUNTER_PROGRAM);
    expect(runner.state).toBe('stopped');
    runner.tick(DT);
    runner.tick(DT);
    expect(store.getInt('CountOut')).toBe(0);
    expect(runner.state).toBe('stopped');
  });

  it('stop() halts scanning (WARM — mem is kept), run() resumes', async () => {
    const runner = makeRunner();
    await runner.deploy(COUNTER_PROGRAM);
    await runner.run();
    runner.tick(DT);
    runner.tick(DT);
    expect(store.getInt('CountOut')).toBe(2);

    runner.stop();
    expect(runner.state).toBe('stopped');
    runner.tick(DT);
    expect(store.getInt('CountOut')).toBe(2); // gated

    await runner.run();
    runner.tick(DT);
    expect(store.getInt('CountOut')).toBe(3); // WARM — counter continued
  });

  it('step() executes exactly one scan, independent of the run state', async () => {
    const runner = makeRunner();
    await runner.deploy(COUNTER_PROGRAM);
    expect(runner.state).toBe('stopped');
    runner.step();
    expect(store.getInt('CountOut')).toBe(1);
    runner.step();
    expect(store.getInt('CountOut')).toBe(2);
    expect(runner.state).toBe('stopped'); // step never changes the run state
  });
});

// ─── Error states and recovery ──────────────────────────────────────────────

describe('PLC lifecycle — errors and COLD restart', () => {
  it('division by zero → state error + lastError, subsequent ticks are no-ops', async () => {
    const runner = makeRunner();
    await runner.deploy(DIVISION_PROGRAM); // D is 0 → division by zero
    await runner.run();
    runner.tick(DT);
    expect(runner.state).toBe('error');
    expect(runner.lastError).toMatch(/Division by zero/);

    // even with a now-valid divisor the PLC stays halted until run()
    store.set('D', 2);
    runner.tick(DT);
    runner.step();
    expect(store.getInt('Q')).toBe(0);
    expect(runner.state).toBe('error');
  });

  it('run() after a runtime error rebuilds the sandbox (COLD) and scans again', async () => {
    const runner = makeRunner();
    await runner.deploy(DIVISION_PROGRAM);
    await runner.run();
    runner.tick(DT);
    expect(runner.state).toBe('error');

    store.set('D', 2);
    await runner.run();
    expect(runner.state).toBe('running');
    expect(runner.lastError).toBeNull();
    runner.tick(DT);
    expect(store.getInt('Q')).toBe(5);
  });

  it('an infinite loop poisons the sandbox → error; run() recovers with a fresh sandbox', async () => {
    const runner = makeRunner();
    await runner.deploy(INFINITE_LOOP_PROGRAM);
    await runner.run();
    runner.tick(DT); // aborted by the interrupt deadline
    expect(runner.state).toBe('error');
    expect(runner.lastError).toBeTruthy();

    await runner.run(); // COLD restart — poisoned sandbox disposed, fresh one built
    expect(runner.state).toBe('running');
    expect(runner.lastError).toBeNull();
  });

  it('deploy() with a compile error → error state + diagnostics returned', async () => {
    const runner = makeRunner();
    const diagnostics = await runner.deploy('PROGRAM P x := ; END_PROGRAM');
    expect(diagnostics.some((d) => d.severity === 'error')).toBe(true);
    expect(runner.state).toBe('error');
    expect(runner.lastError).toMatch(/compile/i);
    runner.tick(DT); // no program — must be a safe no-op
    runner.step();
  });
});

// ─── Reset (COLD) ───────────────────────────────────────────────────────────

describe('PLC lifecycle — reset', () => {
  it('reset() restores FB states: a TON must re-time after reset', async () => {
    const runner = makeRunner();
    await runner.deploy(TON_PROGRAM);
    store.set('SensorInFeed', true);
    await runner.run();
    tickFor(runner, 1.5); // past PT = 1 s
    expect(store.getBool('ConveyorStart')).toBe(true);

    await runner.reset(); // COLD — keeps 'running'
    expect(runner.state).toBe('running');
    runner.tick(DT); // fresh rising edge — far from PT
    expect(store.getBool('ConveyorStart')).toBe(false);

    tickFor(runner, 1.5); // full PT elapses again
    expect(store.getBool('ConveyorStart')).toBe(true);
  });

  it('reset() rebuilds program memory (VAR counters restart at their defaults)', async () => {
    const runner = makeRunner();
    await runner.deploy(COUNTER_PROGRAM);
    await runner.run();
    runner.tick(DT);
    runner.tick(DT);
    runner.tick(DT);
    expect(store.getInt('CountOut')).toBe(3);

    await runner.reset();
    runner.tick(DT);
    expect(store.getInt('CountOut')).toBe(1); // mem was cleared, default 0 + 1
  });
});

// ─── Public PlcControl registry ─────────────────────────────────────────────

describe('PlcControl registry', () => {
  it('register/get/null round-trip', async () => {
    expect(getPlcControl()).toBeNull();
    const runner = makeRunner();
    registerPlcControl(runner);
    expect(getPlcControl()).toBe(runner);

    // the registered control is usable through the public surface
    const control = getPlcControl()!;
    const diagnostics = await control.deploy(COUNTER_PROGRAM);
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    control.step();
    expect(store.getInt('CountOut')).toBe(1);
    expect(control.state).toBe('stopped');
    expect(control.watch().get('CountOut')).toBe(1);

    registerPlcControl(null);
    expect(getPlcControl()).toBeNull();
  });
});
