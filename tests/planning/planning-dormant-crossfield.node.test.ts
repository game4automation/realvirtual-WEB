// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it } from 'vitest';
import { createPlanningRegistry } from '../../src/core/planning/rv-planning-registry';

describe('plan-2006 9.30: dormant cross-field validation (#17)', () => {
  it('rejects the whole candidate set when target violates a rule reported on threshold', () => {
    const reported: Array<{ code: string }> = [];
    const registry = createPlanningRegistry({
      simTime: () => 0,
      problems: { report: (p) => { reported.push(p); }, clear: () => {} },
    });
    // The owner has not loaded yet. threshold is absent from the scenario.
    registry.loadScenario({ 'yard.target': 20, 'yard.rate': 70 });
    expect(registry.dormant()).toEqual({ 'yard.target': 20, 'yard.rate': 70 });
    const candidates: Array<Readonly<Record<string, unknown>>> = [];
    const owner = registry.declare({
      owner: 'yard', title: 'Yard',
      params: [
        { key: 'threshold', label: 'Threshold', type: 'number', default: 30, group: 'Battery', apply: 'live' },
        { key: 'target', label: 'Target', type: 'number', default: 80, group: 'Battery', apply: 'live' },
        { key: 'rate', label: 'Rate', type: 'number', default: 40, group: 'Load', apply: 'live' },
      ],
      validate(values): Record<string, string> {
        candidates.push(values);
        return Number(values.threshold) >= Number(values.target)
          ? { threshold: 'Threshold must be below target' } : {};
      },
    });
    expect(candidates).toContainEqual({ threshold: 30, target: 20, rate: 70 });
    // Currently target=20 AND rate=70: neither taken key has errs[key].
    expect.soft(owner.values()).toEqual({ threshold: 30, target: 80, rate: 40 });
    expect.soft(reported.length).toBeGreaterThan(0);
    expect(registry.dormant()).toEqual({});
    expect(registry.changeLog()).toEqual([]);
  });
});
