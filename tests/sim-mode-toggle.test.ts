// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * sim-mode-toggle.test.ts — Plan 194 P6 (Sim mode-toggle UI surface).
 *
 * The `SimModeToggle` React component drives the kernel through a small PUBLIC
 * facade: `viewer.simulationKernel` → `hasDesRunner()` / `setMode()` /
 * `desControl()` (the structural `SimDesControl` surface). These tests exercise
 * that exact contract (the toggle is a thin view over it):
 *   - the DES toggle is gated by `hasDesRunner()` (public build → no-op).
 *   - with a registered DES runner, `setMode('des')` switches the kernel.
 *   - the sub-mode row drives `desControl().setSubMode()` / `setMultiplier()` /
 *     `step()`; `desControl()` is null outside DES mode.
 *   - the KPI snapshot has the shape the public KPI panel reads.
 *   - the SimController plugin registers BOTH leading toolbar slots.
 *
 * The import-boundary guard (V7 — `SimModeToggle` must not import `DESRunner` /
 * private) lives in `sim-mode-toggle.node.test.ts` (node-mode, fs-based).
 */

import { createElement } from 'react';
import { render, cleanup, waitFor, act } from '@testing-library/react';
import { SimModeToggle } from '../src/plugins/sim-controller/SimModeToggle';
import { acquireRunLease } from '../src/core/hmi/rv-run-lease';
import { describe, it, expect } from 'vitest';
import {
  SimulationKernel,
  type SimDesControl,
  type SimSubMode,
  type SimKpiSnapshot,
} from '../src/core/material-flow/simulation-kernel';
import { ContinuousRunner } from '../src/core/material-flow/continuous-runner';
import type { SimulationExecutor } from '../src/core/material-flow/simulation-executor';
import { SimControllerPlugin } from '../src/plugins/sim-controller';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeContinuousRunner(): ContinuousRunner {
  const transport = { mus: [] as unknown[], update(): void {}, reset(): void { this.mus.length = 0; } };
  const behaviors = { tick(): void {} };
  return new ContinuousRunner(transport, behaviors);
}

const TOPO = { root: {} as never };

/** A fake DES executor that ALSO implements the structural `SimDesControl`. */
function makeFakeDesControlExecutor(log: string[]): SimulationExecutor & SimDesControl {
  let subMode: SimSubMode = 'animated';
  let multiplier = 1;
  let mu = 0;
  return {
    // SimulationExecutor
    mode: 'des',
    get muCount(): number { return mu; },
    start(): void { log.push('start'); mu = 2; },
    tick(): void {},
    lateTick(): void {},
    clearMUs(): void { mu = 0; },
    reset(): void {},
    dispose(): void {},
    // SimDesControl
    get subMode(): SimSubMode { return subMode; },
    setSubMode(m: SimSubMode): void { subMode = m; log.push(`setSubMode:${m}`); },
    get multiplier(): number { return multiplier; },
    setMultiplier(n: number): void { multiplier = Math.max(1, n); log.push(`setMultiplier:${n}`); },
    get simTime(): number { return 12.5; },
    step(): boolean { log.push('step'); return true; },
    ffProgress: 0.42,
    kpiSnapshot(): SimKpiSnapshot {
      return {
        simTimeSeconds: 7200,
        throughputPerHour: 1240,
        bottleneck: { name: 'Station-3', utilization: 94 },
        components: [
          { name: 'Conveyor-1', utilization: 78 },
          { name: 'Turntable-1', utilization: 61 },
        ],
      };
    },
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe('SimModeToggle — DES gating by hasDesRunner() (public build)', () => {
  it('public build: hasDesRunner() is false → setMode("des") is a no-op', () => {
    const runner = makeContinuousRunner();
    const k = new SimulationKernel({ continuousRunner: runner, topology: TOPO });
    expect(k.hasDesRunner()).toBe(false);
    // The toggle disables the DES segment in this case; even if invoked, the
    // kernel guards it.
    k.setMode('des');
    expect(k.mode).toBe('continuous');
    // No DES control surface in continuous mode.
    expect(k.desControl()).toBe(null);
  });
});

describe('SimModeToggle — setMode with a registered DES runner', () => {
  it('setMode("des") switches the kernel and exposes the control surface', () => {
    const log: string[] = [];
    const des = makeFakeDesControlExecutor(log);
    const k = new SimulationKernel({
      continuousRunner: makeContinuousRunner(),
      topology: TOPO,
      desRunnerFactory: () => des,
    });

    expect(k.hasDesRunner()).toBe(true);
    expect(k.desControl()).toBe(null); // continuous → no control yet

    k.setMode('des');
    expect(k.mode).toBe('des');
    const ctl = k.desControl();
    expect(ctl).not.toBe(null);
    expect(ctl!.subMode).toBe('animated');
  });

  it('fires onModeChanged after a successful switch (toggle re-render hook)', () => {
    const modes: string[] = [];
    const des = makeFakeDesControlExecutor([]);
    const k = new SimulationKernel({
      continuousRunner: makeContinuousRunner(),
      topology: TOPO,
      desRunnerFactory: () => des,
      onModeChanged: (m) => modes.push(m),
    });
    k.setMode('des');
    k.setMode('continuous');
    expect(modes).toEqual(['des', 'continuous']);
  });
});

describe('SimModeToggle — sub-mode switching via desControl()', () => {
  it('drives setSubMode / setMultiplier / step on the active control surface', () => {
    const log: string[] = [];
    const des = makeFakeDesControlExecutor(log);
    const k = new SimulationKernel({
      continuousRunner: makeContinuousRunner(),
      topology: TOPO,
      desRunnerFactory: () => des,
    });
    k.setMode('des');
    const ctl = k.desControl()!;

    ctl.setSubMode('hybrid');
    ctl.setMultiplier(10);
    ctl.setSubMode('fastforward');
    ctl.step();

    expect(log).toContain('setSubMode:hybrid');
    expect(log).toContain('setMultiplier:10');
    expect(log).toContain('setSubMode:fastforward');
    expect(log).toContain('step');
    expect(ctl.multiplier).toBe(10);
  });

  it('exposes ffProgress + a KPI snapshot for the panel', () => {
    const des = makeFakeDesControlExecutor([]);
    const k = new SimulationKernel({
      continuousRunner: makeContinuousRunner(),
      topology: TOPO,
      desRunnerFactory: () => des,
    });
    k.setMode('des');
    const ctl = k.desControl()!;

    expect(ctl.ffProgress).toBeCloseTo(0.42);
    const kpi = ctl.kpiSnapshot!();
    expect(kpi.throughputPerHour).toBe(1240);
    expect(kpi.bottleneck?.name).toBe('Station-3');
    expect(kpi.components.length).toBe(2);
  });

  it('desControl() returns null for an executor without the control surface', () => {
    // A DES executor that does NOT implement SimDesControl (bare SimulationExecutor).
    const bare: SimulationExecutor = {
      mode: 'des', muCount: 0,
      start(): void {}, tick(): void {}, lateTick(): void {},
      clearMUs(): void {}, reset(): void {}, dispose(): void {},
    };
    const k = new SimulationKernel({
      continuousRunner: makeContinuousRunner(),
      topology: TOPO,
      desRunnerFactory: () => bare,
    });
    k.setMode('des');
    expect(k.mode).toBe('des');
    expect(k.desControl()).toBe(null); // no setSubMode → no control
  });
});

describe('SimControllerPlugin — toolbar slots', () => {
  it('registers ONLY the sim-controls leading slot (mode-toggle removed, plan-198)', () => {
    const plugin = new SimControllerPlugin({ shortcuts: false });
    const leading = plugin.slots.filter(s => s.slot === 'toolbar-button-leading');
    // plan-198 removed the old Realtime/DES execution toggle from the toolbar
    // (DES is now selected via the TopBar workspace-mode dropdown), so the
    // play/pause/reset controls are the only leading slot.
    expect(leading.length).toBe(1);
    expect(leading[0].order).toBe(10);
  });
});

it('disables DES sub-mode controls on lease changes and running batch progress', async () => {
  const ctl = makeFakeDesControlExecutor([]);
  let running = false;
  ctl.batchProgressJson = () => running ? JSON.stringify({ exp: 'Base', replIndex: 1, total: 1, phase: 'running' }) : null;
  const viewer = { simulationKernel: { mode: 'des', isSwitching: false, hasDesRunner: () => true, desControl: () => ctl }, on: () => () => {} };
  const ui = render(createElement(SimModeToggle, { viewer } as never));
  const controls = ['animated', 'hybrid', 'hybrid-multiplier', 'fastforward', 'step'];
  const check = (disabled: boolean) => controls.forEach(id => expect((ui.getByTestId(`sim-submode-${id}`) as HTMLButtonElement).disabled).toBe(disabled));
  const lease = { current: null as ReturnType<typeof acquireRunLease> };
  try {
    check(false);
    act(() => { lease.current = acquireRunLease('toggle-test', 'des-batch'); });
    check(true);
    act(() => { lease.current?.release(); lease.current = null; });
    check(false);
    running = true;
    await waitFor(() => check(true));
    running = false;
    await waitFor(() => check(false));
  } finally { lease.current?.release(); cleanup(); }
});
