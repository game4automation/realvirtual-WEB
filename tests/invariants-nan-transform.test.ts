// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-600 test 9.3 — I1 fires, and the message names the PATH. An invariant
 * that has never been red has not been tested.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  checkInvariants,
  checkNoNonFiniteTransforms,
  resetInvariants,
} from '../src/core/engine/rv-invariants';
import { clearAllProblems } from '../src/core/hmi/problems-store';
import { addStubNode, makeStubViewer } from './helpers/invariant-stub-viewer';

describe('I1 — no NaN/Infinity in a registered transform', () => {
  beforeEach(() => { clearAllProblems(); });

  it('stays silent on a clean scene', () => {
    const v = makeStubViewer();
    addStubNode(v, 'Cell/A');
    addStubNode(v, 'Cell/B');
    expect(checkNoNonFiniteTransforms(v)).toEqual([]);
  });

  it('fires on NaN in position and names the path and the field', () => {
    const v = makeStubViewer();
    addStubNode(v, 'Cell/Good');
    addStubNode(v, 'Cell/Broken/Axis').position.x = NaN;

    const found = checkNoNonFiniteTransforms(v);
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('Cell/Broken/Axis');
    expect(found[0]).toContain('position.x');
    expect(found[0]).toMatch(/^I1 /);
  });

  it('fires on Infinity in scale and on NaN in the quaternion', () => {
    const v = makeStubViewer();
    addStubNode(v, 'Cell/S').scale.y = Infinity;
    addStubNode(v, 'Cell/Q').quaternion.w = NaN;

    const found = checkNoNonFiniteTransforms(v);
    expect(found.some((m) => m.includes('Cell/S') && m.includes('scale.y'))).toBe(true);
    expect(found.some((m) => m.includes('Cell/Q') && m.includes('quaternion.w'))).toBe(true);
  });

  it('is returned by checkInvariants — I1 is a SYNCHRONOUS invariant', () => {
    const v = makeStubViewer();
    resetInvariants(v);
    addStubNode(v, 'Cell/Broken').position.z = NaN;
    const returned = checkInvariants(v, 'explicit');
    expect(returned.some((m) => m.startsWith('I1 ') && m.includes('Cell/Broken'))).toBe(true);
  });

  it('caps its output instead of flooding the console', () => {
    const v = makeStubViewer();
    for (let i = 0; i < 40; i++) addStubNode(v, `Cell/N${i}`).position.x = NaN;
    const found = checkNoNonFiniteTransforms(v, 5);
    expect(found.length).toBeLessThanOrEqual(6);
    expect(found[found.length - 1]).toContain('stopped after 5');
  });

  it('checks nothing when there is no registry — rather than claiming clean', () => {
    expect(checkNoNonFiniteTransforms({})).toEqual([]);
  });
});
