// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { expect, it } from 'vitest';
import { BudgetResolver } from '../../src/core/diagnostics/rv-blockage-budget';
import { probeBlockages } from '../../src/core/diagnostics/rv-blockage-probes';
import { candidate, edge } from './blockage-test-data';
it('explains free resources, named holders, unanalysed edges, and missing edges', () => {
  const findings = probeBlockages({ candidates: ['A', 'B', 'C', 'D'].map(id => candidate(id)),
    edges: [edge('A', 'Sensor', []), edge('B', 'Zone', ['Owner']), edge('C', 'Wide', ['Owner'], { analysed: false, notAnalysedReason: 'capacity>1' })],
    budgets: new BudgetResolver(), now: 200 });
  expect(findings.map(f => f.cls)).toEqual(['stall', 'stall', 'stall', 'stall']);
  expect(findings[0].checks).toContainEqual({ name: 'holders', ok: true, detail: 'free' });
  expect(findings[1].chain).toEqual(['B', 'Zone', 'Owner']);
  expect(findings[2].checks).toContainEqual(expect.objectContaining({ name: 'edge-not-analysed' }));
  expect(findings[3].checks).toContainEqual(expect.objectContaining({ name: 'no-wait-edge' }));
});
it('never adds stalls for members of a deadlock finding', () => {
  const findings = probeBlockages({ candidates: ['A', 'B', 'C'].map(id => candidate(id)), edges: [edge('A', 'R1', ['B']), edge('B', 'R2', ['A'])], budgets: new BudgetResolver(), now: 200 });
  expect(findings.map(f => [f.cls, f.waiterId])).toEqual([['deadlock', 'A'], ['stall', 'C']]);
});
