// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-600 test 9.4 — I2 over a RETURN into the same named UI state.
 *
 * Why not the plan's literal `mode-changing` against `mode-changed`: that was
 * measured to be a false positive. On the pilot document `commissioning`
 * creates its own nodes lazily AFTER the switch (315 -> 317) and removes them
 * correctly when it is left, so a single switch legitimately reads 317 -> 315
 * and the literal comparison would call healthy teardown a leak. F9 forbids
 * that. See the contract comment on `checkNodeCountDrift`.
 *
 * What is still caught, and tested below: a mode that does NOT clean up, which
 * shows as a higher count on the next return into the original state.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { checkInvariants, resetInvariants } from '../src/core/engine/rv-invariants';
import { clearAllProblems } from '../src/core/hmi/problems-store';
import { makeStubViewer, type StubViewer } from './helpers/invariant-stub-viewer';

/** Enter `mode`, then let it create its own content, like a real mode does. */
function enterMode(v: StubViewer, mode: string, ownNodes = 0): string[] {
  checkInvariants(v, 'mode-changing');
  v.activeMode = mode;
  const found = checkInvariants(v, 'mode-changed');
  v.nodeCount += ownNodes; // lazily created AFTER mode-changed, as measured
  return found;
}

describe('I2 — node-count drift across a return into the same UI state', () => {
  beforeEach(() => { clearAllProblems(); });

  it('does not compare the FIRST entry into a state', () => {
    const v = makeStubViewer({ nodeCount: 315 });
    resetInvariants(v);
    expect(enterMode(v, 'commissioning')).toEqual([]);
  });

  it('stays silent on a healthy cycle — the measured pilot numbers', () => {
    const v = makeStubViewer({ nodeCount: 315 });
    resetInvariants(v);
    checkInvariants(v, 'mode-changed');          // record hmi = 315
    expect(enterMode(v, 'commissioning', 2)).toEqual([]);   // 315, then 317
    v.nodeCount = 315;                            // commissioning tears down
    v.activeMode = 'hmi';
    expect(checkInvariants(v, 'mode-changed')).toEqual([]);  // back to 315
  });

  it('stays silent over many cycles when nothing accumulates', () => {
    const v = makeStubViewer({ nodeCount: 315 });
    resetInvariants(v);
    for (let i = 0; i < 5; i++) {
      v.activeMode = 'hmi';
      expect(checkInvariants(v, 'mode-changed'), `cycle ${i}`).toEqual([]);
      v.nodeCount = 317;
      v.activeMode = 'commissioning';
      checkInvariants(v, 'mode-changed');
      v.nodeCount = 315;
    }
  });

  it('FIRES when the mode that was left did not clean up', () => {
    const v = makeStubViewer({ nodeCount: 315 });
    resetInvariants(v);
    v.activeMode = 'hmi';
    checkInvariants(v, 'mode-changed');          // record hmi = 315

    v.activeMode = 'commissioning';
    checkInvariants(v, 'mode-changed');
    v.nodeCount = 318;                            // its own tree …
    v.activeMode = 'hmi';                         // … and it is NOT removed
    const found = checkInvariants(v, 'mode-changed');
    expect(found.some((m) => m.startsWith('I2 nodeCount: 315 -> 318'))).toBe(true);
    expect(found[0]).toContain('returning to');
  });

  it('also fires when the count DROPS on a return — drift is drift', () => {
    const v = makeStubViewer({ nodeCount: 1000 });
    resetInvariants(v);
    v.activeMode = 'hmi';
    checkInvariants(v, 'mode-changed');
    v.nodeCount = 990;
    expect(checkInvariants(v, 'mode-changed')).toContain('I2 nodeCount: 1000 -> 990 (returning to hmi|-|-)');
  });

  it('keeps panel configurations apart — a different UI state is not a return', () => {
    const v = makeStubViewer({ nodeCount: 315 });
    resetInvariants(v);
    v.activeMode = 'hmi';
    checkInvariants(v, 'mode-changed');          // hmi, no panels = 315

    v.panels.left = 'hierarchy';                  // the panel owns nodes
    v.nodeCount = 340;
    expect(checkInvariants(v, 'mode-changed'), 'another UI state is a new reference').toEqual([]);

    v.panels.left = null;                         // back to the first state
    v.nodeCount = 315;
    expect(checkInvariants(v, 'mode-changed')).toEqual([]);
  });

  it('forgets its references on model-loaded', () => {
    const v = makeStubViewer({ nodeCount: 315 });
    resetInvariants(v);
    v.activeMode = 'hmi';
    checkInvariants(v, 'mode-changed');
    checkInvariants(v, 'model-loaded');           // a new model: other numbers
    v.nodeCount = 9999;
    expect(checkInvariants(v, 'mode-changed')).toEqual([]);
  });
});
