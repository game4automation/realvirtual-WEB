// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * simulation-kernel.test.ts — Plan 194 P1.
 *
 * Verifies the `SimulationKernel`:
 *  - default mode is 'continuous'; activeExecutor is the continuous runner.
 *  - hasDesRunner() is false with a null factory (DES feature not activated).
 *  - setMode('des') is a guarded no-op when no DES runner is registered.
 *  - rapid-toggle / same-mode guard (W4/W5).
 *  - setMode is try/catch-wrapped — a throwing executor never wedges the toggle.
 *  - with a registered DES factory: switch performs Reset-on-Switch
 *    (clearMUs outgoing → start incoming) and round-trips.
 *  - static handlesTransport === true; tick/lateTick/reset delegate to active.
 */

import { describe, it, expect } from 'vitest';
import { SimulationKernel } from '../src/core/material-flow/simulation-kernel';
import { ContinuousRunner } from '../src/core/material-flow/continuous-runner';
import type { DesRunnerFactory } from '../src/core/material-flow/simulation-kernel';

// plan-680: the stub is gone; `null` is what the kernel holds before the DES feature runs.
const createDesRunner: DesRunnerFactory = null;
import type { SimulationExecutor } from '../src/core/material-flow/simulation-executor';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeContinuousRunner(calls: string[] = []): ContinuousRunner {
  const transport = {
    mus: [] as unknown[],
    update(): void { calls.push('transport.update'); },
    reset(): void { calls.push('transport.reset'); this.mus.length = 0; },
  };
  const behaviors = { tick(): void { calls.push('behaviors.tick'); } };
  return new ContinuousRunner(transport, behaviors);
}

const TOPO = { root: {} as never };

/** A fully-instrumented fake DES executor for switch tests. */
function makeFakeDesExecutor(log: string[]): SimulationExecutor {
  let mu = 0;
  return {
    mode: 'des',
    get muCount(): number { return mu; },
    start(): void { log.push('des.start'); mu = 2; },
    tick(): void { log.push('des.tick'); },
    lateTick(): void { log.push('des.lateTick'); },
    clearMUs(): void { log.push('des.clearMUs'); mu = 0; },
    reset(): void { log.push('des.reset'); },
    dispose(): void { log.push('des.dispose'); },
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe('SimulationKernel — defaults & DES availability', () => {
  it('defaults to continuous mode with the continuous runner active', () => {
    const runner = makeContinuousRunner();
    const k = new SimulationKernel({ continuousRunner: runner, topology: TOPO });
    expect(k.mode).toBe('continuous');
    expect(k.activeExecutor).toBe(runner);
    expect(k.activeExecutor.mode).toBe('continuous');
  });

  it('hasDesRunner() is false with a null factory (DES feature not activated)', () => {
    expect(createDesRunner).toBe(null);
    const k = new SimulationKernel({
      continuousRunner: makeContinuousRunner(),
      topology: TOPO,
      desRunnerFactory: createDesRunner,
    });
    expect(k.hasDesRunner()).toBe(false);
  });

  it('hasDesRunner() is false when no factory is provided at all', () => {
    const k = new SimulationKernel({ continuousRunner: makeContinuousRunner(), topology: TOPO });
    expect(k.hasDesRunner()).toBe(false);
  });

  it('static handlesTransport === true', () => {
    expect(SimulationKernel.handlesTransport).toBe(true);
  });
});

describe('SimulationKernel — setMode guards (public / no DES runner)', () => {
  it('setMode("des") is a no-op when no DES runner is registered', () => {
    const runner = makeContinuousRunner();
    const k = new SimulationKernel({
      continuousRunner: runner,
      topology: TOPO,
      desRunnerFactory: createDesRunner,
    });
    k.setMode('des');
    expect(k.mode).toBe('continuous');
    expect(k.activeExecutor).toBe(runner);
  });

  it('same-mode switch is a no-op (W5)', () => {
    const runner = makeContinuousRunner();
    const k = new SimulationKernel({ continuousRunner: runner, topology: TOPO });
    k.setMode('continuous');
    expect(k.mode).toBe('continuous');
    expect(k.activeExecutor).toBe(runner);
  });
});

describe('SimulationKernel — setMode with a registered DES runner', () => {
  it('Reset-on-Switch: clearMUs outgoing → start incoming on switch to des', () => {
    const log: string[] = [];
    const des = makeFakeDesExecutor(log);
    const contLog: string[] = [];
    const runner = makeContinuousRunner(contLog);
    const k = new SimulationKernel({
      continuousRunner: runner,
      topology: TOPO,
      desRunnerFactory: () => des,
    });

    expect(k.hasDesRunner()).toBe(true);
    k.setMode('des');

    expect(k.mode).toBe('des');
    expect(k.activeExecutor).toBe(des);
    // Outgoing continuous runner's MUs cleared (clearMUs → transport.reset),
    // then the incoming DES executor started fresh.
    expect(contLog).toContain('transport.reset');
    expect(log).toEqual(['des.start']);
    expect(k.activeExecutor.muCount).toBe(2);
  });

  it('round-trips des → continuous, reusing the same DES executor', () => {
    const log: string[] = [];
    const des = makeFakeDesExecutor(log);
    let built = 0;
    const runner = makeContinuousRunner();
    const k = new SimulationKernel({
      continuousRunner: runner,
      topology: TOPO,
      desRunnerFactory: () => { built++; return des; },
    });

    k.setMode('des');
    expect(k.mode).toBe('des');
    k.setMode('continuous');
    expect(k.mode).toBe('continuous');
    expect(k.activeExecutor).toBe(runner);
    // Outgoing DES cleared on the way back.
    expect(log).toContain('des.clearMUs');

    // Second switch to des reuses the cached executor (factory not called again).
    k.setMode('des');
    expect(built).toBe(1);
  });

  it('rapid-toggle guard: re-entrant setMode while switching is ignored (W5)', () => {
    const log: string[] = [];
    const contLog: string[] = [];
    const runner = makeContinuousRunner(contLog);
    // DES executor whose start() re-enters setMode — must be ignored purely by
    // the `_switching` latch (the committed mode is still 'continuous' during
    // start(), so re-targeting 'des' bypasses the same-mode guard and is caught
    // ONLY by the in-flight guard).
    let k: SimulationKernel;
    let starts = 0;
    const des: SimulationExecutor = {
      mode: 'des',
      muCount: 0,
      start(): void {
        starts++;
        log.push('des.start');
        // While _switching === true this re-entrant call MUST be a no-op
        // (else start() would run twice / state would corrupt).
        k.setMode('des');
        log.push(`reentrant.switching=${k.isSwitching}`);
      },
      tick(): void {}, lateTick(): void {}, clearMUs(): void {},
      reset(): void {}, dispose(): void {},
    };
    k = new SimulationKernel({
      continuousRunner: runner,
      topology: TOPO,
      desRunnerFactory: () => des,
    });

    k.setMode('des');
    // start() ran exactly once — the re-entrant setMode was guarded out.
    expect(starts).toBe(1);
    expect(log).toContain('reentrant.switching=true');
    // Outer switch committed cleanly to des; latch released.
    expect(k.mode).toBe('des');
    expect(k.activeExecutor).toBe(des);
    expect(k.isSwitching).toBe(false);
  });

  it('a throwing executor start() does not wedge the toggle (try/catch + finally)', () => {
    const runner = makeContinuousRunner();
    const badDes: SimulationExecutor = {
      mode: 'des', muCount: 0,
      start(): void { throw new Error('boom'); },
      tick(): void {}, lateTick(): void {}, clearMUs(): void {},
      reset(): void {}, dispose(): void {},
    };
    const k = new SimulationKernel({
      continuousRunner: runner,
      topology: TOPO,
      desRunnerFactory: () => badDes,
    });

    expect(() => k.setMode('des')).not.toThrow();
    // Switching latch released even though start() threw.
    expect(k.isSwitching).toBe(false);
    // A failed start() leaves the kernel cleanly in the ORIGINAL mode.
    expect(k.mode).toBe('continuous');
    expect(k.activeExecutor).toBe(runner);
    // The toggle is not wedged — a subsequent (valid) switch still works.
    expect(() => k.setMode('continuous')).not.toThrow();
  });

  it('registerDesRunnerFactory() enables DES at runtime', () => {
    const k = new SimulationKernel({ continuousRunner: makeContinuousRunner(), topology: TOPO });
    expect(k.hasDesRunner()).toBe(false);
    k.registerDesRunnerFactory(() => makeFakeDesExecutor([]));
    expect(k.hasDesRunner()).toBe(true);
  });
});

describe('SimulationKernel — per-tick delegation', () => {
  it('tick/lateTick/reset delegate to the active executor', () => {
    const calls: string[] = [];
    const runner = makeContinuousRunner(calls);
    const k = new SimulationKernel({ continuousRunner: runner, topology: TOPO });

    k.tick(0.016);          // → transport.update + behaviors.tick
    k.lateTick(0.016);      // → no-op for continuous
    k.reset();              // → transport.reset

    expect(calls).toEqual(['transport.update', 'behaviors.tick', 'transport.reset']);
  });
});
