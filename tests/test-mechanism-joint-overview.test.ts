// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * flattenJoints unit tests (plan-405 §9.1).
 *
 * The one thing that can be silently wrong here is the REFERENCE semantics:
 * a `.slice()` or a `new Vector3()` sneaking into the mapping would still make
 * every visual assertion pass, and would only show up as garbage pressure while
 * someone drags a jog slider. So that is what the first test pins down.
 */

import { describe, it, expect } from 'vitest';
import { flattenJoints } from '@rv-private/plugins/asset-editor/mechanism/mechanism-joint-overview-gizmo';
import type {
  MechanismJointView, MechanismView,
} from '../src/core/engine/rv-kinematic-registry';

function joint(name: string, overrides: Partial<MechanismJointView> = {}): MechanismJointView {
  return {
    nodePath: `/Rig/${name}`,
    name,
    jointType: 'Revolute',
    bodyAName: null, bodyBName: null,
    bodyAPath: null, bodyBPath: null,
    worldAnchored: true,
    driveName: null,
    currentValue: 0,
    joggable: false,
    lowerLimit: -180, upperLimit: 180, useLimits: false,
    originWorld: [1, 2, 3],
    axisWorld: [0, 0, 1],
    ...overrides,
  };
}

function mech(name: string, joints: MechanismJointView[]): MechanismView {
  return {
    nodePath: `/${name}`, name,
    active: true, converged: true, residualError: 0, solveTimeMs: 0, disabledReason: '',
    jointCount: joints.length, linkCount: 0, loopCount: 0, dof: joints.length,
    joints, links: [], findings: [],
  };
}

describe('flattenJoints', () => {
  it('maps every joint of every mechanism to exactly one target', () => {
    const mechs = [
      mech('Press', [joint('J1'), joint('J2')]),
      mech('Gantry', [joint('J3')]),
    ];
    const targets = flattenJoints(mechs);
    expect(targets).toHaveLength(3);
    expect(targets.map((t) => t.name)).toEqual(['J1', 'J2', 'J3']);
    expect(targets[0].jointPath).toBe('/Rig/J1');
    expect(targets[0].jointType).toBe('Revolute');
  });

  it('REFERENCES the world arrays instead of copying them', () => {
    const mechs = [mech('Press', [joint('J1')])];
    const targets = flattenJoints(mechs);
    expect(targets[0].origin).toBe(mechs[0].joints[0].originWorld);
    expect(targets[0].direction).toBe(mechs[0].joints[0].axisWorld);
  });

  it('returns empty for an empty mechanisms list', () => {
    expect(flattenJoints([])).toEqual([]);
  });

  it('produces no targets for a mechanism without joints', () => {
    expect(flattenJoints([mech('Empty', [])])).toEqual([]);
  });

  it('does NOT filter anything — hiding is a visibility decision, not a mapping one', () => {
    // The edited joint is skipped in setTargets, so it must still be mapped here.
    const mechs = [mech('Press', [joint('J1'), joint('J2', { axisWorld: [0, 0, 0] })])];
    expect(flattenJoints(mechs)).toHaveLength(2);
  });
});
