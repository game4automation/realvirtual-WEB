// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2237 F2 — `sim.clock.get`, the read-only clock query the tutorial recorder reads every frame
 * and an agent reaches through `web_query` (contract-commands-mcp rule 5). The factor comes from the
 * STATE (speed override / DES sub-mode), never from an observed rate.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RVViewer } from '../src/core/rv-viewer';
import { commandRegistry } from '../src/core/hmi/rv-command-registry';
import { setDriveSpeedOverride } from '../src/core/engine/rv-speed-override';
import {
  createSimCommandDescriptors, ensureSimCommandsRegistered, SIM_COMMAND_IDS,
} from '../src/plugins/sim-controller/sim-commands';
import { desFactorOf, simClockGet, type SimClockReading } from '../src/plugins/sim-controller/sim-clock-get';
import { McpCommandTools } from '../src/plugins/mcp-bridge/rv-mcp-command-tools';

// The registry is a singleton: substitute a private one for this suite.
vi.mock('../src/core/hmi/rv-command-registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/hmi/rv-command-registry')>();
  return { ...actual, commandRegistry: new actual.CommandRegistry() };
});
vi.mock('../src/plugins/mcp-bridge/rv-mcp-dialog-policy', () => ({
  installMcpDialogPolicy: vi.fn(async () => () => []),
}));

interface FakeDes {
  subMode: string; multiplier: number; simTime: number; renderClock?: number; endTime?: number;
  clampReport?: { at: 'budget' | 'end' | null; budget: number; end: number };
}

function fakeViewer(des: FakeDes | null, state: { paused?: boolean; simTime?: number; steps?: number } = {}): RVViewer {
  return {
    modes: { activeMode: 'hmi' },
    isSimulationPaused: state.paused ?? false,
    simTime: state.simTime ?? 12.5,
    fixedStepCount: state.steps ?? 750,
    simulationKernel: { desControl: () => des },
  } as unknown as RVViewer;
}

function read(viewer: RVViewer): SimClockReading {
  const value = simClockGet.run({ viewer } as never, {} as never);
  return value as SimClockReading;
}

afterEach(() => { setDriveSpeedOverride(1); });

describe('sim.clock.get — continuous (plan-2237 F2)', () => {
  it('Test_SimClockGet_Continuous_FactorIsTheSpeedOverride_ClampedTo100', () => {
    const viewer = fakeViewer(null);
    expect(read(viewer)).toEqual({ mode: 'continuous', paused: false, simTime: 12.5, fixedStepCount: 750, factor: 1, factorSource: 'speedOverride' });
    setDriveSpeedOverride(150);
    expect(read(viewer).factor).toBe(100);
    setDriveSpeedOverride(0.5);
    expect(read(viewer).factor).toBe(0.5);
  });

  it('Test_SimClockGet_Continuous_FactorZeroAndPaused_AreReported', () => {
    setDriveSpeedOverride(0);
    expect(read(fakeViewer(null))).toMatchObject({ factor: 0, paused: false });
    setDriveSpeedOverride(1);
    expect(read(fakeViewer(null, { paused: true }))).toMatchObject({ factor: 1, paused: true });
  });
});

describe('sim.clock.get — DES (plan-2237 F2)', () => {
  it('Test_SimClockGet_Des_SubModeMapping', () => {
    expect(desFactorOf('animated', 50)).toBe(1);
    expect(desFactorOf('hybrid', 50)).toBe(50);
    expect(desFactorOf('hybrid', 0.5)).toBe(1);
    expect(desFactorOf('step', 50)).toBe(0);
    expect(desFactorOf('fastforward', 50)).toBeNull();
  });

  it('Test_SimClockGet_Des_RenderClockEndTimeAndClampReport', () => {
    setDriveSpeedOverride(5); // a continuous override never changes the DES factor (measured)
    const reading = read(fakeViewer({
      subMode: 'hybrid', multiplier: 50, simTime: 393, renderClock: 393, endTime: 393,
      clampReport: { at: 'end', budget: 395, end: 4 },
    }, { simTime: 393 }));
    expect(reading).toEqual({
      mode: 'des', paused: false, simTime: 393, fixedStepCount: 750, factor: 50, factorSource: 'des-subMode',
      des: { subMode: 'hybrid', multiplier: 50, renderClock: 393, simTime: 393, endTime: 393, clampedAt: 'end', clampCounts: { budget: 395, end: 4 } },
    });
  });

  it('Test_SimClockGet_Des_FastForwardNull_InfiniteEndNull_MissingClampReportZero', () => {
    const reading = read(fakeViewer({ subMode: 'fastforward', multiplier: 1, simTime: 100, renderClock: 100, endTime: Infinity }));
    expect(reading.factor).toBeNull();
    expect(reading.des).toMatchObject({ endTime: null, clampedAt: null, clampCounts: { budget: 0, end: 0 } });
  });

  it('Test_SimClockGet_NoViewer_Disabled', () => {
    expect(simClockGet.enabled({ viewer: undefined } as never, {} as never)).toEqual({ reason: 'No viewer' });
  });
});

describe('sim.clock.get — registry and web_query (contract-commands-mcp rules 5, 7)', () => {
  const tools = new McpCommandTools(() => undefined);
  let viewer: RVViewer;

  beforeEach(() => {
    viewer = fakeViewer({ subMode: 'animated', multiplier: 1, simTime: 0, renderClock: 4.2 });
    const attach = commandRegistry.attachViewer.bind(commandRegistry);
    vi.spyOn(commandRegistry, 'attachViewer').mockImplementation((v) => attach(v ?? viewer));
    ensureSimCommandsRegistered(commandRegistry);
  });
  afterEach(() => { vi.restoreAllMocks(); commandRegistry.attachViewer(undefined); });

  it('Test_SimClockGet_Descriptor_ReadOnlyOpenNoMcpMirror', () => {
    const descriptor = createSimCommandDescriptors().find((d) => d.id === 'sim.clock.get');
    expect(descriptor).toMatchObject({ readOnly: true, available: true, scope: 'none' });
    expect(descriptor?.mcp).toBeUndefined(); // a domain query is reached through web_query, not a tool
    expect(SIM_COMMAND_IDS).toContain('sim.clock.get');
  });

  it('Test_SimClockGet_ReachableThroughWebQuery', async () => {
    const answer = JSON.parse(await tools.webQuery('sim.clock.get'));
    expect(answer).toMatchObject({ ok: true, recorded: false, value: { mode: 'des', factor: 1, des: { renderClock: 4.2 } } });
  });
});
