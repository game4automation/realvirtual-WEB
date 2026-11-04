// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-600 open defect: at BOOT the I3/I5 baseline was sampled while
 * `activeMode` was still null (main.ts sets the first mode after the load), so
 * its UI key was `none|-|-` and every later comparison was skipped. A leak of
 * three geometries stayed silent over a full return cycle.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  armInvariantBaseline,
  checkInvariants,
  hasInvariantBaseline,
  invariantsOnRenderedFrame,
  pendingInvariantReservation,
  resetInvariants,
} from '../src/core/engine/rv-invariants';
import { clearAllProblems } from '../src/core/hmi/problems-store';
import { makeStubViewer, type StubViewer } from './helpers/invariant-stub-viewer';

function setMode(v: StubViewer, mode: string | null): void {
  (v as unknown as { activeMode: string | null }).activeMode = mode;
}

/** hmi -> commissioning -> hmi, each followed by the deferred frame. */
function returnCycle(v: StubViewer): void {
  checkInvariants(v, 'mode-changing');
  setMode(v, 'commissioning');
  checkInvariants(v, 'mode-changed');
  invariantsOnRenderedFrame();

  checkInvariants(v, 'mode-changing');
  setMode(v, 'hmi');
  checkInvariants(v, 'mode-changed');
  invariantsOnRenderedFrame();
}

describe('I3/I5 baseline at boot', () => {
  let errors: string[];

  beforeEach(() => {
    clearAllProblems();
    errors = [];
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errors.push(a.join(' ')); });
  });

  it('detects a leak over the first return cycle when the baseline was taken before any mode', () => {
    const v = makeStubViewer();
    resetInvariants(v);
    setMode(v, null);
    armInvariantBaseline(v);
    invariantsOnRenderedFrame(); // baseline sampled at none|-|-

    // main.ts enters the first mode after the load.
    setMode(v, 'hmi');
    checkInvariants(v, 'mode-changed');
    invariantsOnRenderedFrame(); // baseline re-taken here, nothing compared

    v.memory.geometries += 3; // the leak
    returnCycle(v);
    expect(errors.some((e) => e.includes('I5 geometries: 114 -> 117'))).toBe(true);
  });

  it('stays silent over the same cycle without a leak', () => {
    const v = makeStubViewer();
    resetInvariants(v);
    setMode(v, null);
    armInvariantBaseline(v);
    invariantsOnRenderedFrame();
    setMode(v, 'hmi');
    checkInvariants(v, 'mode-changed');
    invariantsOnRenderedFrame();

    returnCycle(v);
    expect(errors.filter((e) => e.includes('I3') || e.includes('I5'))).toEqual([]);
  });

  it('keeps a still-pending baseline when the first mode arrives before its frame', () => {
    const v = makeStubViewer();
    resetInvariants(v);
    setMode(v, null);
    armInvariantBaseline(v);

    setMode(v, 'hmi');
    checkInvariants(v, 'mode-changed');
    expect(pendingInvariantReservation(v)).toBe('baseline');

    invariantsOnRenderedFrame();
    expect(hasInvariantBaseline(v)).toBe(true);

    v.memory.textures += 1;
    returnCycle(v);
    expect(errors.some((e) => e.includes('I5 textures: 44 -> 45'))).toBe(true);
  });

  it('does not re-take a baseline that already belongs to a real mode', () => {
    const v = makeStubViewer();
    resetInvariants(v);
    armInvariantBaseline(v);
    invariantsOnRenderedFrame(); // hmi|-|-

    checkInvariants(v, 'mode-changed');
    expect(pendingInvariantReservation(v)).toBe('compare');
  });
});
