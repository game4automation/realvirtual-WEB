// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-600 test 9.5 — I3 after the measured contract: the SAME named UI state
 * before and after a completed cycle, compared per signal name over the
 * `listeners` map.
 *
 * Two things are checked separately, because they look alike and are not:
 * a legitimately mounted extra consumer (both comparison points share the UI
 * state, so it cannot be a violation) versus a listener still present AFTER its
 * cleanup should have removed it.
 *
 * The real store's `Set` deduplication is covered too: it is why the diagnostic
 * must read `listeners` and never `listenerRefs` (measured 3 -> 4, not 3 -> 5).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  armInvariantBaseline,
  checkInvariants,
  invariantsOnRenderedFrame,
  resetInvariants,
} from '../src/core/engine/rv-invariants';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { clearAllProblems } from '../src/core/hmi/problems-store';
import { makeStubViewer, type StubViewer } from './helpers/invariant-stub-viewer';

/** Baseline at the load-bound marker plus one rendered frame. */
function takeBaseline(v: StubViewer): void {
  armInvariantBaseline(v);
  invariantsOnRenderedFrame();
}

/** A completed return cycle back into the same mode, then the deferred frame. */
function returnCycle(v: StubViewer): void {
  checkInvariants(v, 'mode-changing');
  v.activeMode = 'commissioning';
  checkInvariants(v, 'mode-changed');
  invariantsOnRenderedFrame();

  checkInvariants(v, 'mode-changing');
  v.activeMode = 'hmi';
  checkInvariants(v, 'mode-changed');
  invariantsOnRenderedFrame();
}

describe('I3 — listeners without a living consumer', () => {
  let errors: string[];

  beforeEach(() => {
    clearAllProblems();
    errors = [];
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errors.push(a.join(' ')); });
  });

  it('stays silent when the counts return to the baseline', () => {
    const v = makeStubViewer();
    resetInvariants(v);
    v.listeners.set('do5', 2);
    takeBaseline(v);
    returnCycle(v);
    expect(errors.filter((e) => e.includes('I3'))).toEqual([]);
  });

  it('fires with both numbers when a listener survives the cycle', () => {
    const v = makeStubViewer();
    resetInvariants(v);
    v.listeners.set('do5', 2);
    v.listeners.set('Grip', 2);
    takeBaseline(v);

    v.listeners.set('do5', 3); // a hook registered twice, never released

    returnCycle(v);
    expect(errors.some((e) => e.includes('I3 do5: 2 -> 3'))).toBe(true);
    expect(errors.some((e) => e.includes('I3 Grip'))).toBe(false);
  });

  it('fires for a name that did not exist at the baseline at all', () => {
    const v = makeStubViewer();
    resetInvariants(v);
    takeBaseline(v);
    v.listeners.set('LoadCell', 1);
    returnCycle(v);
    expect(errors.some((e) => e.includes('I3 LoadCell: 0 -> 1'))).toBe(true);
  });

  it('stays silent when a count DROPS — fewer listeners is not a leak', () => {
    const v = makeStubViewer();
    resetInvariants(v);
    v.listeners.set('do5', 3);
    takeBaseline(v);
    v.listeners.set('do5', 1);
    returnCycle(v);
    expect(errors.filter((e) => e.includes('I3'))).toEqual([]);
  });

  it('does not check at all without a baseline, rather than comparing against zero', () => {
    const v = makeStubViewer();
    resetInvariants(v);
    v.listeners.set('do5', 7);
    returnCycle(v);
    expect(errors.filter((e) => e.includes('I3'))).toEqual([]);
  });

  it('does not compare across a DIFFERENT UI state', () => {
    const v = makeStubViewer();
    resetInvariants(v);
    v.listeners.set('do5', 2);
    takeBaseline(v);

    // A panel is left open — this is no longer the baseline's named UI state,
    // so nothing is compared instead of a number being reported.
    v.listeners.set('do5', 5);
    v.panels.left = 'hierarchy';
    checkInvariants(v, 'mode-changing');
    checkInvariants(v, 'mode-changed');
    invariantsOnRenderedFrame();
    expect(errors.filter((e) => e.includes('I3'))).toEqual([]);
  });
});

describe('I3 — the diagnostic reads `listeners`, not `listenerRefs`', () => {
  it('counts the real store per name, and deduplicates one callback reference', () => {
    const store = new SignalStore();
    store.register('do5', 'Cell/Do5', false);
    expect(store.listenerCount('do5')).toBe(0);

    const a = () => {};
    const b = () => {};
    const unsubA = store.subscribe('do5', a);
    const unsubB = store.subscribe('do5', b);
    expect(store.listenerCount('do5')).toBe(2);

    // The SAME reference again: a Set deduplicates, so this is still 2 — the
    // measured 3 -> 4 rather than 3 -> 5. A diagnostic reading subscribe calls
    // would report a leak that does not exist.
    const unsubAgain = store.subscribe('do5', a);
    expect(store.listenerCount('do5')).toBe(2);

    expect(store.listenerCounts().get('do5')).toBe(2);

    unsubA(); unsubB(); unsubAgain();
    expect(store.listenerCount('do5')).toBe(0);
    // A name with zero listeners is ABSENT, never present with 0.
    expect(store.listenerCounts().has('do5')).toBe(false);
  });

  it('reports two DIFFERENT callback instances as two listeners', () => {
    const store = new SignalStore();
    store.register('Grip', 'Cell/Grip', false);
    const u1 = store.subscribe('Grip', () => {});
    const u2 = store.subscribe('Grip', () => {});
    expect(store.listenerCount('Grip')).toBe(2);
    u1(); u2();
  });
});
