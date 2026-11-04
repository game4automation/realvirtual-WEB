// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { expect, it } from 'vitest';
import { BudgetResolver, type BudgetNode } from '../../src/core/diagnostics/rv-blockage-budget';
export const node = (name: string, parent: BudgetNode | null, budget: Record<string, unknown> = {}): BudgetNode =>
  ({ name, parent, userData: { realvirtual: { BlockageBudget: budget } } });
it('resolves each property from node, parent, then default, with its deciding source', () => {
  const root = node('Root', null, { MaxIdleSec: 300, MaxWaitSec: 70 });
  const child = node('Child', root, { MaxIdleSec: 180 });
  const resolver = new BudgetResolver();
  expect(resolver.resolve(child)).toMatchObject({ MaxIdleSec: 180, MaxWaitSec: 70, WarmupSec: 30,
    budgetSource: 'Child', sources: { MaxIdleSec: 'Child', MaxWaitSec: 'Root', WarmupSec: 'default' } });
  child.userData.realvirtual.BlockageBudget.MaxIdleSec = null;
  expect(resolver.resolve(child)).toMatchObject({ MaxIdleSec: 300, budgetSource: 'Root' });
});
it('does not inherit node-scoped values, including ExpectFlow', () => {
  const root = node('Root', null, { Scope: 'node', MaxIdleSec: 900, ExpectFlow: true });
  const child = node('Child', root);
  const resolver = new BudgetResolver();
  expect(resolver.resolve(root).MaxIdleSec).toBe(900);
  expect(resolver.resolve(child)).toMatchObject({ MaxIdleSec: 120, ExpectFlow: false, budgetSource: 'default' });
  root.userData.realvirtual.BlockageBudget.Scope = 'subtree';
  expect(resolver.expectFlow({ node: child })).toBe(true);
});
it('returns detached expected waits', () => {
  const root = node('Root', null, { ExpectedWaits: ['custom'] });
  const resolver = new BudgetResolver(); const resolved = resolver.resolve(root);
  root.userData.realvirtual.BlockageBudget.ExpectedWaits.push('later');
  expect(resolved.ExpectedWaits).toEqual(['custom']);
});
it('publishes and clears output signals in their declared scope only at samples', () => {
  const root = node('Root', null, { SignalBlockageFound: 'output' });
  const child = node('Child', root);
  const writes: unknown[] = [];
  const resolver = new BudgetResolver({ nodeForUnit: () => child, budgetNodes: () => [root],
    writeSignal: (ref, owner, value, now) => writes.push([ref, owner.name, value, now]) });
  expect(writes).toEqual([]);
  resolver.publishFindings(['A'], 200); resolver.publishFindings([], 201);
  expect(writes).toEqual([['output', 'Root', true, 200], ['output', 'Root', false, 201]]);
});
