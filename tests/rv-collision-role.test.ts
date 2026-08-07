// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-394 §9.1 — role names and the cross-pair rule.
 *
 * The pair rule has TWO conditions, and the second one (F16) is the reason a
 * robot with a gripper does not report its own flange contact on tick one.
 */

import { describe, it, expect } from 'vitest';
import { COLLISION_ROLES, toCollisionRole } from '../src/core/engine/rv-collision-role';
import { buildCrossPairs, type PairableBody } from '../src/core/engine/rv-collision-manager';

describe('CollisionRole', () => {
  it('exposes exactly the agreed english role names with None first', () => {
    expect([...COLLISION_ROLES]).toEqual(
      ['None', 'Tool', 'Workpiece', 'Machine', 'Robot', 'Environment']);
  });

  it('parses unknown / non-string values defensively to None', () => {
    expect(toCollisionRole('Robot')).toBe('Robot');
    expect(toCollisionRole('robot')).toBe('None');
    expect(toCollisionRole('Nonsense')).toBe('None');
    expect(toCollisionRole(undefined)).toBe('None');
    expect(toCollisionRole(3)).toBe('None');
  });
});

describe('buildCrossPairs', () => {
  it('never pairs equal roles and never pairs None', () => {
    const bodies: PairableBody[] = [
      { role: 'Robot' }, { role: 'Robot' }, { role: 'Machine' }, { role: 'None' },
    ];
    const pairs = buildCrossPairs(bodies);
    expect(pairs).toHaveLength(2);            // Robot0-Machine2, Robot1-Machine2
    expect(pairs.every((p) => bodies[p.i].role !== bodies[p.j].role)).toBe(true);
    expect(pairs.some((p) => bodies[p.i].role === 'None' || bodies[p.j].role === 'None')).toBe(false);
  });

  it('skips the parent-child pair but keeps both against unrelated bodies (F16)', () => {
    // Robot (root) > Tool (gripper inside its subtree), plus an unrelated Machine.
    const robot: PairableBody & { ancestorBodies: Set<unknown> } =
      { role: 'Robot', ancestorBodies: new Set() };
    const tool: PairableBody & { ancestorBodies: Set<unknown> } =
      { role: 'Tool', ancestorBodies: new Set() };
    const machine: PairableBody & { ancestorBodies: Set<unknown> } =
      { role: 'Machine', ancestorBodies: new Set() };
    tool.ancestorBodies.add(robot);

    const bodies = [robot, tool, machine];
    const pairs = buildCrossPairs(bodies);
    const has = (a: PairableBody, b: PairableBody) => pairs.some(
      (p) => (bodies[p.i] === a && bodies[p.j] === b) || (bodies[p.i] === b && bodies[p.j] === a),
    );

    expect(has(robot, tool)).toBe(false);     // design-inherent flange contact
    expect(has(robot, machine)).toBe(true);
    expect(has(tool, machine)).toBe(true);    // gripper stays checked
  });

  it('is symmetric — the skip works no matter which body is listed first', () => {
    const tool = { role: 'Tool', ancestorBodies: new Set<unknown>() };
    const robot = { role: 'Robot', ancestorBodies: new Set<unknown>() };
    tool.ancestorBodies.add(robot);
    expect(buildCrossPairs([tool, robot])).toHaveLength(0);
    expect(buildCrossPairs([robot, tool])).toHaveLength(0);
  });
});
