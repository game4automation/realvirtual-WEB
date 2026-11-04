// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-600 test 9.14 — the lifecycle of the deferred measurement (plan 2.6).
 *
 * A reservation overtaken by `model-cleared`, `model-loaded` or a further mode
 * switch before its frame is DISCARDED and reports nothing: a comparison
 * against a state that is no longer the same state is a false alarm, not a
 * finding. There is never more than one open reservation, and `checkInvariants`
 * returns only the synchronous findings.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  armInvariantBaseline,
  checkInvariants,
  hasInvariantBaseline,
  invariantsOnRenderedFrame,
  pendingInvariantReservation,
  pendingInvariantViewerCount,
  resetInvariants,
} from '../src/core/engine/rv-invariants';
import { clearAllProblems, reportProblem } from '../src/core/hmi/problems-store';
import { addStubNode, makeStubViewer, type StubViewer } from './helpers/invariant-stub-viewer';

function baselineWith(v: StubViewer, geometries: number): void {
  v.memory.geometries = geometries;
  armInvariantBaseline(v);
  invariantsOnRenderedFrame();
}

describe('deferred invariants — lifecycle of the one reservation', () => {
  let errors: string[];

  beforeEach(() => {
    clearAllProblems();
    errors = [];
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errors.push(a.join(' ')); });
    // Drain anything a previous test left filed.
    invariantsOnRenderedFrame();
  });

  it('files exactly one reservation at mode-changed', () => {
    const v = makeStubViewer();
    resetInvariants(v);
    expect(pendingInvariantReservation(v)).toBeNull();
    checkInvariants(v, 'mode-changed');
    expect(pendingInvariantReservation(v)).toBe('compare');
  });

  it('never holds more than one reservation per viewer', () => {
    const v = makeStubViewer();
    resetInvariants(v);
    checkInvariants(v, 'mode-changed');
    checkInvariants(v, 'mode-changed');
    checkInvariants(v, 'mode-changed');
    expect(pendingInvariantViewerCount()).toBe(1);
    expect(pendingInvariantReservation(v)).toBe('compare');
  });

  it('executes the reservation exactly once, then clears it', () => {
    const v = makeStubViewer();
    resetInvariants(v);
    baselineWith(v, 114);
    v.memory.geometries = 115;
    checkInvariants(v, 'mode-changed');

    invariantsOnRenderedFrame();
    expect(errors.filter((e) => e.includes('I5 geometries'))).toHaveLength(1);
    expect(pendingInvariantReservation(v)).toBeNull();

    // A second frame must not re-report the same finding.
    invariantsOnRenderedFrame();
    expect(errors.filter((e) => e.includes('I5 geometries'))).toHaveLength(1);
  });

  it('DISCARDS a reservation overtaken by model-cleared', () => {
    const v = makeStubViewer();
    resetInvariants(v);
    baselineWith(v, 114);
    v.memory.geometries = 115;
    checkInvariants(v, 'mode-changed');

    resetInvariants(v); // what the `model-cleared` wiring does
    expect(pendingInvariantReservation(v)).toBeNull();
    invariantsOnRenderedFrame();
    expect(errors.filter((e) => e.includes('I5'))).toEqual([]);
  });

  it('DISCARDS a reservation overtaken by model-loaded', () => {
    const v = makeStubViewer();
    resetInvariants(v);
    baselineWith(v, 114);
    v.memory.geometries = 115;
    checkInvariants(v, 'mode-changed');

    checkInvariants(v, 'model-loaded');
    expect(pendingInvariantReservation(v)).toBeNull();
    expect(hasInvariantBaseline(v)).toBe(false);
    invariantsOnRenderedFrame();
    expect(errors.filter((e) => e.includes('I5'))).toEqual([]);
  });

  it('DISCARDS a reservation overtaken by a further mode switch', () => {
    const v = makeStubViewer();
    resetInvariants(v);
    baselineWith(v, 114);
    v.memory.geometries = 115;
    checkInvariants(v, 'mode-changed');
    expect(pendingInvariantReservation(v)).toBe('compare');

    // The next switch starts before the deferred frame ever happened.
    checkInvariants(v, 'mode-changing');
    expect(pendingInvariantReservation(v)).toBeNull();
    invariantsOnRenderedFrame();
    expect(errors.filter((e) => e.includes('I5'))).toEqual([]);
  });

  it('discards a BASELINE reservation overtaken before its frame', () => {
    const v = makeStubViewer();
    resetInvariants(v);
    armInvariantBaseline(v);
    expect(pendingInvariantReservation(v)).toBe('baseline');
    checkInvariants(v, 'model-loaded');
    invariantsOnRenderedFrame();
    expect(hasInvariantBaseline(v)).toBe(false);
  });

  it('returns ONLY the synchronous findings — never the deferred ones', () => {
    const v = makeStubViewer();
    resetInvariants(v);
    baselineWith(v, 114);
    addStubNode(v, 'Cell/Broken').position.x = NaN;
    reportProblem({ id: 'e', severity: 'error', code: 'bake-failed', title: 'Bake failed', detail: 'd' });
    v.memory.geometries = 115; // a deferred I5 finding is queued up

    const returned = checkInvariants(v, 'mode-changed');
    expect(returned.some((m) => m.startsWith('I1 '))).toBe(true);
    expect(returned.some((m) => m.startsWith('I4 '))).toBe(true);
    expect(returned.some((m) => m.startsWith('I3 ') || m.startsWith('I5 '))).toBe(false);

    // …and it does arrive, on the console, at the next rendered frame.
    invariantsOnRenderedFrame();
    expect(errors.some((e) => e.includes('I5 geometries: 114 -> 115'))).toBe(true);
  });

  it('keeps two viewers independent', () => {
    const a = makeStubViewer();
    const b = makeStubViewer();
    resetInvariants(a); resetInvariants(b);
    baselineWith(a, 114); baselineWith(b, 200);
    a.memory.geometries = 115;
    checkInvariants(a, 'mode-changed');
    checkInvariants(b, 'mode-changed');
    expect(pendingInvariantViewerCount()).toBe(2);
    invariantsOnRenderedFrame();
    expect(errors.filter((e) => e.includes('I5 geometries'))).toHaveLength(1);
    expect(errors[0]).toContain('114 -> 115');
  });
});
