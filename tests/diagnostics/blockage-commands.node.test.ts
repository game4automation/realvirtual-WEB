// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
import { afterEach, expect, it, vi } from 'vitest';
import { CommandRegistry, type CommandContext } from '../../src/core/hmi/rv-command-registry';
import { ensureDiagnoseCommandsRegistered } from '../../src/core/diagnostics/diagnose-command-descriptors';
import { BlockageWatch } from '../../src/core/diagnostics/rv-blockage-watch';
import { BudgetResolver, type BudgetNode } from '../../src/core/diagnostics/rv-blockage-budget';
import { ProgressLedger } from '../../src/core/diagnostics/rv-progress-ledger';
import { WaitRegistry } from '../../src/core/diagnostics/rv-wait-registry';
import { getProblems, resetProblemsForTests, clearBlockageProblems, reportProblem } from '../../src/core/hmi/problems-store';
import { PROBLEM_CODE_CLASSIFICATION } from '../helpers/problem-code-classification';
import { edge } from './blockage-test-data';
import { ProgressWiring } from '../../src/core/diagnostics/rv-progress-wiring';
import { isMacroCommand } from '../../src/plugins/mcp-bridge/rv-mcp-command-tools';
import { selectionSelect } from '../../src/core/hmi/selection-command-impl';

afterEach(resetProblemsForTests);
function fixture() {
  let now = 0;
  const ledger = new ProgressLedger({ clock: { now: () => now } });
  ledger.addPopulation({ id: 'fleet', kind: 'vehicle', expected: () => ['A', 'B', 'C', 'missing'] });
  for (const id of ['A', 'B', 'C']) { ledger.register(id, 'vehicle', 'test'); ledger.arm(id); }
  const registry = new WaitRegistry();
  registry.addSource({ id: 'zones', edges: () => [edge('A', 'R1', ['B']), edge('B', 'R2', ['A']),
    edge('C', 'wide', ['external'], { analysed: false, notAnalysedReason: 'capacity>1' })] });
  const root: BudgetNode = { name: 'Line', parent: null, userData: { realvirtual: { BlockageBudget: { SignalBlockageFound: 'found', Severity: 'info' } } } };
  const nodes = new Map(['A', 'B', 'C'].map(id => [id, { name: id, parent: root, userData: {} }]));
  const writeSignal = vi.fn();
  const budgets = new BudgetResolver({ nodeForUnit: id => nodes.get(id), budgetNodes: () => [root], writeSignal });
  const context = () => ({ ledger, registry, budgets, now });
  const watch = new BlockageWatch(context);
  const viewer = { blockageWatch: watch, waitRegistry: registry, get simTime() { return now; } } as CommandContext['viewer'];
  const commands = new CommandRegistry();
  ensureDiagnoseCommandsRegistered(commands);
  now = 200;
  return { ledger, registry, budgets, watch, viewer, commands, writeSignal,
    execute: (id: string, args = {}) => commands.execute(id, args, { origin: 'mcp', viewer }) };
}

it('registers three lazy read-only, non-recordable commands and one write, idempotently', () => {
  const f = fixture();
  const register = vi.spyOn(f.commands, 'register');
  ensureDiagnoseCommandsRegistered(f.commands);
  expect(register).not.toHaveBeenCalled();
  for (const id of ['diag.blockage', 'diag.waitGraph', 'diag.blockageWatchStatus']) {
    const d = f.commands.list().find(d => d.id === id)!;
    expect(d).toMatchObject({ readOnly: true, available: true, scope: 'none' });
    expect(d.eagerImpl).toBeUndefined();
    expect(d.macro).not.toBe(true);
    expect(isMacroCommand(d)).toBe(false);
  }
  expect(f.commands.list().find(d => d.id === 'diag.blockageWatch')?.readOnly).toBe(false);
});

it('reads stable JSON without sampling adapters, changing ledger/history, writing signals or Problems', async () => {
  const f = fixture();
  const sample = vi.fn(() => f.ledger.bump('A', 'vehicle'));
  f.ledger.addAdapter({ id: 'spy', sample });
  const state = ['A', 'B', 'C'].map(id => f.ledger.entry(id));
  for (const id of ['diag.blockage', 'diag.waitGraph', 'diag.blockageWatchStatus']) {
    const first = await f.execute(id);
    expect(first.ok).toBe(true);
    expect(JSON.stringify(await f.execute(id))).toBe(JSON.stringify(first));
  }
  expect(await f.execute('diag.blockage')).toMatchObject({ ok: true, value: {
    findings: [expect.objectContaining({ cls: 'deadlock' }), expect.objectContaining({ cls: 'stall' })],
    coverage: { expected: 4, registered: 3, missing: ['missing'] }, atSec: 200, exempt: 0,
  } });
  expect(await f.execute('diag.waitGraph')).toMatchObject({ value: { sources: ['zones'], edges: expect.arrayContaining([
    expect.objectContaining({ analysed: false, notAnalysedReason: 'capacity>1' }),
  ]) } });
  expect(['A', 'B', 'C'].map(id => f.ledger.entry(id))).toEqual(state);
  expect(f.ledger.lastFindings).toEqual([]);
  expect(f.watch.lastReport).toBeNull();
  expect(sample).not.toHaveBeenCalled();
  expect(f.writeSignal).not.toHaveBeenCalled();
  expect(getProblems()).toEqual([]);
});

it('publishes chains, severity, actions and coverage only while watching, and retires resolved findings', async () => {
  const f = fixture();
  f.watch.sample();
  expect(getProblems()).toEqual([]);
  expect(await f.execute('diag.blockageWatch', { on: true })).toMatchObject({ value: { on: true, since: 200, sampleEverySec: 1 } });
  expect(await f.execute('diag.blockageWatchStatus')).toMatchObject({ value: { on: true } });
  f.watch.sample();
  expect(f.watch.counters()).toEqual({ deadlock: 1, stall: 1,
    coverage: { expected: 4, registered: 3, armed: 3, missing: 1 } });
  const deadlock = getProblems().find(p => p.code === 'blockage-deadlock')!;
  expect(deadlock).toMatchObject({ severity: 'error', title: 'Deadlock: 2 vehicles wait in a circle', nodePath: 'A',
    action: { label: 'Go to node', commandId: 'selection.select', args: { path: 'A', frame: true } } });
  expect(deadlock.detail).toContain('A -> R1 -> B -> R2 -> A');
  expect(deadlock.detail).toContain('budget 120 s');
  expect(deadlock.detail).toContain('Budget: default');
  expect(getProblems().find(p => p.code === 'blockage-stall')?.severity).toBe('info');
  expect(getProblems().find(p => p.code === 'blockage-coverage-gap')?.severity).toBe('info');
  expect(f.writeSignal).toHaveBeenLastCalledWith('found', expect.anything(), true, 200);
  for (const id of ['A', 'B', 'C']) f.ledger.complete(id);
  f.ledger.register('missing', 'vehicle', 'test');
  f.watch.sample();
  expect(getProblems()).toEqual([]);
  expect(f.writeSignal).toHaveBeenLastCalledWith('found', expect.anything(), false, 200);
  await f.execute('diag.blockageWatch', { on: false });
  expect(await f.execute('diag.blockageWatchStatus')).toMatchObject({ value: { on: false, since: null } });
  expect((await f.execute('diag.blockageWatch', { on: 'yes' })).ok).toBe(false);
});

it('watch off and model reset retire all three codes by code, not just tracked IDs', () => {
  const f = fixture();
  for (const stop of [() => f.watch.setOn(false), () => f.watch.reset(), clearBlockageProblems]) {
    f.watch.setOn(true); f.watch.sample();
    for (const code of ['blockage-deadlock', 'blockage-stall', 'blockage-coverage-gap']) {
      expect(PROBLEM_CODE_CLASSIFICATION[code]).toEqual({ retire: 'clear-model', retiredBy: 'clearBlockageProblems()' });
      reportProblem({ id: `foreign:${code}`, code, severity: 'info', title: 'seed', detail: 'seed' });
    }
    stop();
    expect(getProblems()).toEqual([]);
  }
});

it('the existing selection command frames when the Problems action requests it', async () => {
  const select = vi.fn(), frameSelectionOrScene = vi.fn();
  const viewer = { registry: { findNodeForUser: () => ({ node: {} }), getPathForNode: () => 'A' },
    selectionManager: { select, frameSelectionOrScene } } as unknown as CommandContext['viewer'];
  await selectionSelect.run({ viewer } as CommandContext, { path: 'A', frame: true });
  expect(select).toHaveBeenCalledWith('A');
  expect(frameSelectionOrScene).toHaveBeenCalledOnce();
});

it('runs the watch after the existing 60-tick ledger sample, not on ordinary ticks', () => {
  const f = fixture();
  let wiring: ProgressWiring | undefined;
  const sampled = vi.fn(() => { if (wiring) f.watch.sample(); });
  wiring = new ProgressWiring({ clock: { now: () => 200 }, running: () => true,
    fleet: { all: () => [] }, transport: { mus: [], surfaces: [], sinks: [] }, onSample: sampled });
  sampled.mockClear();
  f.watch.setOn(true);
  for (let i = 0; i < 59; i++) wiring.fixedStep();
  expect(sampled).not.toHaveBeenCalled();
  expect(getProblems()).toEqual([]);
  wiring.fixedStep();
  expect(sampled).toHaveBeenCalledOnce();
  expect(getProblems().some(p => p.code === 'blockage-deadlock')).toBe(true);
  wiring.dispose();
});

it('counts excluded subtrees without double-counting nested declarations', () => {
  const root: BudgetNode = { name: 'root', parent: null, userData: { realvirtual: { BlockageBudget: { Exempt: true } } } };
  const child: BudgetNode = { name: 'child', parent: root, userData: { realvirtual: { BlockageBudget: { Exempt: true } } } };
  expect(new BudgetResolver({ budgetNodes: () => [root, child] }).exemptSubtrees()).toBe(1);
});
