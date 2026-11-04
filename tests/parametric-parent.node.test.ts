// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it } from 'vitest';
import { validatePlan, type BuildPlan, type PartInfo, type PlanNode } from '../src/core/engine/rv-parametric-generator';

const parts: PartInfo[] = [{ name: 'Axis', boundsMm: { min: [0, 0, 0], max: [100, 10, 10] } }];
const node = (name: string, parent?: string): PlanNode => ({ name, positionMm: [0, 0, 0], ...(parent === undefined ? {} : { parent }) });
const chain = (hops: number): PlanNode[] => Array.from({ length: hops + 1 }, (_, i) => node(`N${i}`, i ? `N${i - 1}` : undefined));
const check = (raw: unknown) => validatePlan(raw, parts);
const error = (raw: unknown) => {
  const result = check(raw);
  expect('error' in result).toBe(true);
  return 'error' in result ? result.error.code : undefined;
};

describe('validatePlan parent (plan 9.1)', () => {
  it('rejects unknown targets and implicit instance names', () => {
    expect(error({ nodes: [node('A', 'Missing')] })).toBe('unknown-parent');
    expect(error({ instances: [{ part: 'Axis', positionMm: [0, 0, 0] }], nodes: [node('A', 'Axis_0')] })).toBe('unknown-parent');
  });

  it('rejects self references and cycles, including cycles beyond the depth limit', () => {
    expect(error({ nodes: [node('A', 'A')] })).toBe('parent-cycle');
    expect(error({ nodes: [node('A', 'B'), node('B', 'A')] })).toBe('parent-cycle');
    const nodes = chain(18);
    nodes[0].parent = 'N18';
    expect(error({ nodes })).toBe('parent-cycle');
  });

  it('allows 16 parent hops and rejects 17', () => {
    expect('plan' in check({ nodes: chain(16) })).toBe(true);
    expect(error({ nodes: chain(17) })).toBe('parent-depth');
  });

  it('still rejects unknown keys and validates parent strings', () => {
    expect(error({ nodes: [{ ...node('A'), unexpected: true }] })).toBe('invalid-plan');
    expect(error({ instances: [{ part: 'Axis', positionMm: [0, 0, 0], unexpected: true }] })).toBe('invalid-plan');
    for (const parent of ['', 42, null]) expect(error({ nodes: [{ ...node('A'), parent }] })).toBe('invalid-plan');
  });

  for (const name of ['A/B', 'A#B', '_Children']) {
    it(`rejects reserved instance and node name ${name}`, () => {
      expect(error({ instances: [{ part: 'Axis', name, positionMm: [0, 0, 0] }] })).toBe('invalid-name');
      expect(error({ nodes: [node(name)] })).toBe('invalid-name');
    });
  }

  it('preserves parent references and omits absent parent keys', () => {
    const raw: BuildPlan = {
      instances: [{ part: 'Axis', name: 'Base', positionMm: [0, 0, 0] }, { part: 'Axis', name: 'Arm', parent: 'Base', positionMm: [10, 0, 0] }],
      nodes: [node('Tip', 'Arm'), node('Root')], components: [], messages: [],
    };
    const result = check(raw);
    if ('error' in result) throw new Error(result.error.message);
    expect(result.plan).toEqual(raw);
    expect(Object.hasOwn(result.plan.instances[0], 'parent')).toBe(false);
    expect(Object.hasOwn(result.plan.nodes[1], 'parent')).toBe(false);
    const flat = check({ instances: [raw.instances[0]], nodes: [node('Root')] });
    if ('error' in flat) throw new Error(flat.error.message);
    expect(flat.plan).toEqual({ instances: [raw.instances[0]], nodes: [node('Root')], components: [], messages: [] });
    for (const obj of [...flat.plan.instances, ...flat.plan.nodes]) expect(Object.hasOwn(obj, 'parent')).toBe(false);
  });

  it('leaves duplicate explicit names for assembly', () => {
    expect('plan' in check({ nodes: [node('A'), node('A'), node('B', 'A')] })).toBe(true);
  });
});
