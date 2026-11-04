// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { expect, it } from 'vitest';
import { BudgetResolver } from '../../src/core/diagnostics/rv-blockage-budget';
import { probeBlockages } from '../../src/core/diagnostics/rv-blockage-probes';
import { candidate, edge } from './blockage-test-data';
it('is independent of candidate, edge, and holder insertion order', () => {
  const candidates = ['A', 'B', 'C', 'D'].map(id => candidate(id));
  const edges = [edge('A', 'Z1', ['B']), edge('B', 'Z2', ['A']), edge('C', 'S', ['X', 'Y']),
    edge('C', 'S', ['X', 'Y'], { sinceSimSec: 2, nodePath: 'C' })];
  const input = { candidates, edges, budgets: new BudgetResolver(), now: 200 };
  const expected = probeBlockages(input);
  expect(probeBlockages({ ...input, candidates: [...candidates].reverse(), edges: [...edges].reverse().map(e => ({ ...e, ownerIds: [...e.ownerIds].reverse() })) })).toEqual(expected);
});
