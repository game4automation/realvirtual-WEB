// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildDiagnoseSummary } from '../../src/core/diagnostics/diagnose-commands';
import { ensureDiagnoseCommandsRegistered } from '../../src/core/diagnostics/diagnose-command-descriptors';
import { computeDesRunState, serializeDesRunStatus } from '../../src/core/material-flow/rv-des-run-state';
import type { SimDesControl, SimDesStatistics } from '../../src/core/material-flow/simulation-kernel';
import { CommandRegistry, type CommandContext } from '../../src/core/hmi/rv-command-registry';
import { getDefaultAgvFleet } from '../../src/core/engine/rv-agv-fleet';
import { SignalStore } from '../../src/core/engine/rv-signal-store';
import { reportProblem, resetProblemsForTests } from '../../src/core/hmi/problems-store';

const input = (): Parameters<typeof buildDiagnoseSummary>[0] => ({
  run: serializeDesRunStatus(computeDesRunState(null, { simulationPaused: false, pauseReasons: [] })),
  faulted: { vehicles: [] }, statsSanity: null, problems: { counts: { error: 0, warning: 0, info: 0 } },
});
beforeEach(() => { getDefaultAgvFleet().resetHandles(); resetProblemsForTests(); });
afterEach(() => { getDefaultAgvFleet().resetHandles(); resetProblemsForTests(); });

describe('diagnose summary', () => {
  it('reports 24 hours as finished, not as blocked or a day count', () => {
    const data = input();
    Object.assign(data.run, { runState: 'finished', reason: 'duration-reached', simTime: 86400, endTime: 86400 });
    const summary = buildDiagnoseSummary(data);
    expect(summary[0]).toBe('Run finished: end time 24:00:00 reached (not blocked).');
    expect(summary[0].replace('(not blocked)', '')).not.toContain('blocked');
  });
  it('reports a stall before the end time', () => {
    const data = input();
    Object.assign(data.run, { runState: 'stalled', simTime: 65, endTime: 86400 });
    expect(buildDiagnoseSummary(data)[0]).toBe('Run stalled: no more model events at 00:01:05, before the end time 24:00:00.');
  });
  it('prioritizes run, faults, statistics and problems, limiting the vehicle list to three', () => {
    const data = input();
    data.faulted.vehicles = ['A', 'B', 'C', 'D'].map(id => ({ id, faultReason: 'fork-wait-timeout' }));
    data.statsSanity = { ok: false, issues: [
      { path: '/A', field: 'sum', value: 110, rule: 'shares-over-100' },
      { path: '/A', field: 'working', value: 110, rule: 'over-100' },
      { path: '/B', field: 'sum', value: 110, rule: 'shares-over-100' },
    ] };
    data.problems.counts = { error: 1, warning: 2, info: 0 };
    const summary = buildDiagnoseSummary(data);
    expect(summary).toHaveLength(4);
    expect(summary[0]).toBe('Not in DES mode.');
    expect(summary[1]).toContain('4 vehicles in fault: A – fork-wait-timeout');
    expect(summary[1]).not.toContain('D –');
    expect(summary[2]).toBe('Statistics implausible: 2 components over 100 %.');
    expect(summary[3]).toBe('3 problems (1 error).');
  });
  it.each(['running', 'paused', 'idle', 'not-des'] as const)('supports %s without statistics', runState => {
    const data = input();
    data.run.runState = runState;
    expect(buildDiagnoseSummary(data)).toHaveLength(1);
  });
  it('does not mislabel non-finite values as over 100 percent', () => {
    const data = input();
    data.statsSanity = { ok: false, issues: [{ path: '/A', field: 'outputPerHour', value: Infinity, rule: 'non-finite' }] };
    expect(buildDiagnoseSummary(data)[1]).toBe('Statistics implausible: 1 component with invalid values.');
  });
});

describe('diagnose command', () => {
  it('works with a minimal viewer outside DES', async () => {
    const registry = new CommandRegistry();
    ensureDiagnoseCommandsRegistered(registry);
    expect(await registry.execute('diagnose', {}, { origin: 'mcp', viewer: {} as CommandContext['viewer'] }))
      .toMatchObject({ ok: true, value: { summary: ['Not in DES mode.'], run: { runState: 'not-des' }, statsSanity: null, fleet: { total: 0 } } });
  });
  it('combines failures, fleet faults, top ten problems and statistics with des.status parity', async () => {
    const signals = new SignalStore();
    getDefaultAgvFleet().register({ id: 'Stapler_2', phase: 'idle', task: null, assign() {}, clear() {} });
    signals.set('Stapler_2.Status.Fault', true);
    signals.set('Stapler_2.Status.FaultCode', 1);
    const stats: SimDesStatistics = {
      simTime: 86400, bottleneck: null, meanUtilization: 0, throughputPerHour: 0,
      components: [{ path: '/Line/A', name: 'A', kind: 'conveyor', working: 70, blocked: 40,
        setup: 0, empty: 0, failure: 0, utilization: 70, outputPerHour: 0, totalProcessed: 0, currentState: 'Failure' }],
    };
    const ctl = { simTime: 86400, endTime: 86400, subMode: 'fastforward', multiplier: 1,
      runComplete: { reason: 'duration-reached', simTime: 86400 }, statistics: () => stats } as unknown as SimDesControl;
    for (let i = 0; i < 12; i++) reportProblem({ id: String(i), code: 'test', severity: i === 0 ? 'error' : 'warning', title: 'Test', detail: 'Test', at: i });
    const viewer = { signalStore: signals, simulationKernel: { desControl: () => ctl },
      isSimulationPaused: false, simulationPauseReasons: [] } as unknown as CommandContext['viewer'];
    const registry = new CommandRegistry();
    ensureDiagnoseCommandsRegistered(registry);
    const ctx = { origin: 'mcp' as const, viewer };
    const result = await registry.execute('diagnose', {}, ctx);
    expect(result).toMatchObject({ ok: true, value: {
      summary: [expect.stringContaining('finished'), '1 vehicle in fault: Stapler_2 – fork-wait-timeout.',
        'Statistics implausible: 1 component over 100 %.', '12 problems (1 error).'],
      faulted: { components: [{ path: '/Line/A', name: 'A' }], vehicles: [{ id: 'Stapler_2', faultReason: 'fork-wait-timeout' }] },
      fleet: { total: 1, counts: { fault: 1 } }, statsSanity: { ok: false }, problems: { total: 12, truncated: true },
    } });
    if (!result.ok) throw new Error('diagnose failed');
    const value = result.value as { run: unknown; problems: { problems: unknown[] } };
    expect(Object.keys(value)).toEqual(['summary', 'run', 'problems', 'faulted', 'fleet', 'statsSanity']);
    expect(value.problems.problems).toHaveLength(10);
    expect(await registry.execute('des.status', {}, ctx)).toEqual({ ok: true, value: value.run });
  });
});

it('adds one sentence per blockage class and coverage only when supplied a result', () => {
  const data = input();
  const baseline = buildDiagnoseSummary(data);
  const summary = buildDiagnoseSummary({ ...data, blockage: { deadlock: 1, stall: 2,
    coverage: { missing: 3, expected: 14 } } });
  expect(summary).toEqual([...baseline, 'Deadlock: 1 findings.', 'Stall: 2 findings.',
    'Coverage: 3 of 14 units are not observed.']);
});
