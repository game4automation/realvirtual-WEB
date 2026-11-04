// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { expect, it } from 'vitest';
import { BudgetResolver } from '../../src/core/diagnostics/rv-blockage-budget';
import { enumerateCycles, probeBlockages } from '../../src/core/diagnostics/rv-blockage-probes';
import { candidate, edge } from './blockage-test-data';
const budgets = new BudgetResolver();
const cycle = [edge('A', 'M1', ['B']), edge('B', 'M2', ['A'], { kind: 'reservation' })];
it('keeps the chain order across mixed reservation and zone edges', () => {
  const findings = probeBlockages({ candidates: ['A', 'B'].map(id => candidate(id)), edges: cycle, budgets, now: 200 });
  expect(findings).toHaveLength(1);
  expect(findings[0]).toMatchObject({ cls: 'deadlock', chain: ['A', 'M1', 'B', 'M2', 'A'], budgetSource: 'default' });
  expect(findings[0].checks.map(c => c.name)).toEqual(['cycle-length', 'all-members-armed', 'no-member-progressed', 'budget-exceeded']);
});
it('does not report a fresh cycle before its idle window', () => {
  const findings = probeBlockages({ candidates: [candidate('A', 199), candidate('B', 199)], edges: cycle, budgets, now: 200 });
  expect(findings).toEqual([]);
});
it('does not call a cycle with one progressing member a deadlock', () => {
  const findings = probeBlockages({ candidates: [candidate('A'), candidate('B', 199)], edges: cycle, budgets, now: 200 });
  expect(findings).toEqual([]);
});
it('combines overlapping cycles in one SCC finding', () => {
  const edges = [...cycle, edge('B', 'M3', ['C']), edge('C', 'M1', ['A']), edge('A', 'M3', ['C'])];
  const findings = probeBlockages({ candidates: ['A', 'B', 'C'].map(id => candidate(id)), edges, budgets, now: 200 });
  expect(findings).toHaveLength(1); expect(findings[0].cycles).toHaveLength(3);
});
it('caps each component independently and still discovers later components', () => {
  const ids = Array.from({ length: 8 }, (_, i) => `A${i}`);
  const edges = ids.flatMap(id => ids.filter(other => id !== other).map(other => edge(id, `R${other}`, [other])));
  edges.push(edge('Y', 'MY', ['Z']), edge('Z', 'MZ', ['Y']));
  const findings = probeBlockages({ candidates: [...ids, 'Y', 'Z'].map(id => candidate(id)), edges, budgets, now: 200 });
  expect(findings).toHaveLength(2); expect(findings[0].cycles).toHaveLength(1000);
  expect(findings[0].checks).toContainEqual(expect.objectContaining({ name: 'cycles-truncated' }));
  expect(findings[1].chain).toEqual(['Y', 'MY', 'Z', 'MZ', 'Y']);
});
it('handles self loops and a deep acyclic graph without recursive stack use', () => {
  expect(enumerateCycles([edge('A', 'R', ['A'])]).cycles).toEqual([['A', 'R', 'A']]);
  expect(enumerateCycles(Array.from({ length: 15000 }, (_, i) => edge(String(i), 'R', [String(i + 1)]))).cycles).toEqual([]);
});
