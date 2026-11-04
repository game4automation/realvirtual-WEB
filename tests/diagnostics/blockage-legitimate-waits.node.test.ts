// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { expect, it, vi } from 'vitest';
import { BudgetResolver, type BudgetNode } from '../../src/core/diagnostics/rv-blockage-budget';
import { ProgressLedger } from '../../src/core/diagnostics/rv-progress-ledger';
import { WaitRegistry } from '../../src/core/diagnostics/rv-wait-registry';
import { runBlockageChecker } from '../../src/core/diagnostics/rv-blockage-checker';
import { edge } from './blockage-test-data';
function context(budget: Record<string, unknown> = {}) {
  let now = 0;
  const root: BudgetNode = { name: 'Line', parent: null, userData: { realvirtual: { BlockageBudget: budget } } };
  const child: BudgetNode = { name: 'A', parent: root, userData: {} };
  const ledger = new ProgressLedger({ clock: { now: () => now } });
  ledger.addPopulation({ id: 'vehicles', kind: 'vehicle', expected: () => ['A'] });
  ledger.register('A', 'vehicle', 'test');
  const registry = new WaitRegistry();
  const budgets = new BudgetResolver({ nodeForUnit: () => child, readSignal: ref => ref === true });
  return { ledger, registry, budgets, at(t: number) { now = t; return { ledger, registry, budgets, now }; } };
}
it('leaves a vehicle without an active task inactive and never collects edges', () => {
  const c = context(), edges = vi.fn(() => []); c.registry.addSource({ id: 'spy', edges });
  expect(runBlockageChecker(c.at(300)).findings).toEqual([]); expect(edges).not.toHaveBeenCalled();
  runBlockageChecker({ ...c.at(300), waitGraph: true }); expect(edges).toHaveBeenCalledTimes(1);
});
it.each(['charge', 'setup', 'Failure', 'empty', 'fleet:charge'])('treats expected %s as inactive', kind => {
  const c = context(); c.ledger.arm('A'); c.registry.addSource({ id: 'wait', edges: () => [edge('A', 'R', [], { kind })] });
  const report = runBlockageChecker(c.at(300));
  expect(report.findings).toEqual([]); expect(report.coverage).toMatchObject({ armed: 0, inactive: 1 });
});
it.each([{ Exempt: true }, { SignalSuppress: true }, { WarmupSec: 500 }])('suppresses legitimate waiting %j', budget => {
  const c = context(budget); c.ledger.arm('A'); expect(runBlockageChecker(c.at(300)).findings).toEqual([]);
});
it('honours a shorter per-node budget without waiting for the default sampling threshold', () => {
  const c = context({ MaxWaitSec: 2, MaxIdleSec: 5, WarmupSec: 0 }); c.ledger.arm('A');
  expect(runBlockageChecker(c.at(4)).findings).toEqual([]);
  expect(runBlockageChecker(c.at(5)).findings).toHaveLength(1);
});
it('keeps the last findings through completion and subsequent samples until reset', () => {
  const c = context(); c.ledger.arm('A'); const report = runBlockageChecker(c.at(300));
  c.ledger.complete('A'); expect(runBlockageChecker(c.at(301)).findings).toEqual([]);
  expect(c.ledger.lastFindings).toEqual(report.findings);
  c.ledger.reset(); expect(c.ledger.lastFindings).toEqual([]); expect(report.findings).toHaveLength(1);
});
