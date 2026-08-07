// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * des-workspace-coupling.test.ts — DESWorkspacePlugin bridges the DES workspace
 * mode (plan-198) and the unified SimulationKernel execution mode (plan-194).
 *
 * Entering the DES workspace must switch the kernel to its DES executor so the
 * DES sub-mode controls are actually live; leaving it must restore the
 * continuous (Realtime) executor. The continuous SimControllerToolbar must hide
 * itself in `mode:des` so the leading toolbar reflects the active kernel.
 */

import { describe, it, expect } from 'vitest';
import { SimulationKernel } from '../src/core/material-flow/simulation-kernel';
import type { SimDesControl, SimSubMode } from '../src/core/material-flow/simulation-kernel';
import { ContinuousRunner } from '../src/core/material-flow/continuous-runner';
import type { SimulationExecutor } from '../src/core/material-flow/simulation-executor';
import { evaluateVisibilityRule } from '../src/core/hmi/ui-context-store';
import { modeContext } from '../src/core/rv-mode-manager';
import { DESWorkspacePlugin } from '../src/plugins/des/des-workspace-plugin';
import { SimControllerPlugin } from '../src/plugins/sim-controller';
import type { RVViewer } from '../src/core/rv-viewer';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeContinuousRunner(): ContinuousRunner {
  const transport = { mus: [] as unknown[], update(): void {}, reset(): void { this.mus.length = 0; } };
  const behaviors = { tick(): void {} };
  return new ContinuousRunner(transport, behaviors);
}

const TOPO = { root: {} as never };

/** A fake DES executor that ALSO implements the structural `SimDesControl`. */
function makeFakeDesExecutor(): SimulationExecutor & SimDesControl {
  let subMode: SimSubMode = 'animated';
  let multiplier = 1;
  return {
    mode: 'des',
    muCount: 0,
    start(): void {},
    tick(): void {},
    lateTick(): void {},
    clearMUs(): void {},
    reset(): void {},
    dispose(): void {},
    get subMode(): SimSubMode { return subMode; },
    setSubMode(m: SimSubMode): void { subMode = m; },
    get multiplier(): number { return multiplier; },
    setMultiplier(n: number): void { multiplier = Math.max(1, n); },
    get simTime(): number { return 0; },
    step(): boolean { return false; },
  };
}

/** Build a viewer stub exposing a real SimulationKernel (optionally DES-capable). */
function makeViewer(hasDes: boolean): { viewer: RVViewer; kernel: SimulationKernel } {
  const kernel = new SimulationKernel({
    continuousRunner: makeContinuousRunner(),
    topology: TOPO,
    desRunnerFactory: hasDes ? makeFakeDesExecutor : null,
  });
  const viewer = { simulationKernel: kernel } as unknown as RVViewer;
  return { viewer, kernel };
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe('DESWorkspacePlugin — kernel coupling (plan-194 ⇄ plan-198)', () => {
  it('onModeActivate switches the kernel to its DES executor', () => {
    const { viewer, kernel } = makeViewer(true);
    const plugin = new DESWorkspacePlugin();
    expect(kernel.mode).toBe('continuous');
    plugin.onModeActivate!('des', viewer);
    expect(kernel.mode).toBe('des');
    expect(kernel.desControl()).not.toBe(null);
  });

  it('onModeDeactivate restores the continuous (Realtime) executor', () => {
    const { viewer, kernel } = makeViewer(true);
    const plugin = new DESWorkspacePlugin();
    plugin.onModeActivate!('des', viewer);
    expect(kernel.mode).toBe('des');
    plugin.onModeDeactivate!('des', viewer);
    expect(kernel.mode).toBe('continuous');
  });

  it('onModelLoaded re-syncs to DES (boot-into-DES safety net)', () => {
    const { viewer, kernel } = makeViewer(true);
    const plugin = new DESWorkspacePlugin();
    plugin.onModelLoaded!(null as never, viewer);
    expect(kernel.mode).toBe('des');
  });

  it('public build (no DES runner): activate stays continuous', () => {
    const { viewer, kernel } = makeViewer(false);
    const plugin = new DESWorkspacePlugin();
    plugin.onModeActivate!('des', viewer);
    expect(kernel.mode).toBe('continuous');
  });

  it('tolerates a null kernel (no model loaded yet)', () => {
    const viewer = { simulationKernel: null } as unknown as RVViewer;
    const plugin = new DESWorkspacePlugin();
    expect(() => plugin.onModeActivate!('des', viewer)).not.toThrow();
    expect(() => plugin.onModeDeactivate!('des', viewer)).not.toThrow();
    expect(() => plugin.onModelLoaded!(null as never, viewer)).not.toThrow();
  });
});

describe('DESWorkspacePlugin — toolbar slots', () => {
  it('participates only in the DES workspace mode', () => {
    expect(new DESWorkspacePlugin().modes).toEqual(['des']);
  });

  it('registers the DES controls in the leading toolbar slot', () => {
    const plugin = new DESWorkspacePlugin();
    const leading = plugin.slots.filter(s => s.slot === 'toolbar-button-leading');
    expect(leading.length).toBe(1);
    expect(leading[0].order).toBe(10);
  });

  it('registers an overlay panel (honest stub when DES runner missing)', () => {
    const plugin = new DESWorkspacePlugin();
    expect(plugin.slots.some(s => s.slot === 'overlay')).toBe(true);
  });
});

describe('SimControllerPlugin — continuous controls hidden in DES and HMI mode', () => {
  it('the leading slot carries a hiddenIn:[mode:des, mode:hmi] visibility rule', () => {
    const plugin = new SimControllerPlugin({ shortcuts: false });
    const leading = plugin.slots.find(s => s.slot === 'toolbar-button-leading')!;
    expect(leading.visibilityId).toBeTruthy();
    expect(leading.visibilityRule).toBeDefined();

    // Visible only in Planner. Hidden in HMI (operator/monitoring view) and DES.
    expect(evaluateVisibilityRule(leading.visibilityRule!, new Set([modeContext('planner')]))).toBe(true);
    expect(evaluateVisibilityRule(leading.visibilityRule!, new Set([modeContext('hmi')]))).toBe(false);
    expect(evaluateVisibilityRule(leading.visibilityRule!, new Set([modeContext('des')]))).toBe(false);
  });
});
