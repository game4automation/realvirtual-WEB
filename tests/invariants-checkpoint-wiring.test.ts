// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-600 test 9.9 — the REAL wiring, not just the function.
 *
 * Why this test has to exist: `tests/helpers/core-toggle-viewer.ts` replaces
 * `emit` with a `vi.fn()` (`:49-87`) and never runs the viewer constructor, so
 * no test built on that harness can notice a checkpoint that was never wired.
 * This one covers exactly that gap — from two sides:
 *
 * 1. behaviourally, that `installInvariants` wires all FIVE events and that
 *    firing them reaches the invariants;
 * 2. structurally, that `rv-viewer.ts` really calls it and really drains the
 *    deferred reservation at the end of `render()`.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  hasInvariantBaseline,
  installInvariants,
  invariantsEnabled,
  invariantsOnRenderedFrame,
  pendingInvariantReservation,
  resetInvariants,
} from '../src/core/engine/rv-invariants';
import { clearAllProblems, reportProblem } from '../src/core/hmi/problems-store';
import { makeStubViewer } from './helpers/invariant-stub-viewer';
import viewerSource from '../src/core/rv-viewer.ts?raw';

/** The four checkpoints plus the load-bound baseline marker. */
const WIRED_EVENTS = ['model-loaded', 'model-cleared', 'mode-changing', 'mode-changed', 'placements-materialized'] as const;

describe('invariant checkpoint wiring — behavioural', () => {
  beforeEach(() => { clearAllProblems(); invariantsOnRenderedFrame(); });

  it('wires exactly the five events, once each', () => {
    const v = makeStubViewer();
    expect(installInvariants(v)).toBe(true);
    for (const event of WIRED_EVENTS) {
      expect(v.handlerCount(event), `handler for ${event}`).toBe(1);
    }
  });

  it('reaches the invariants when model-loaded actually fires', () => {
    const v = makeStubViewer();
    installInvariants(v);
    resetInvariants(v);
    const errors: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errors.push(a.join(' ')); });
    try {
      reportProblem({ id: 'e', severity: 'error', code: 'bake-failed', title: 'Bake failed', detail: 'd' });
      v.fire('model-loaded', { result: {} });
      expect(errors.some((e) => e.includes('I4 bake-failed'))).toBe(true);
    } finally { spy.mockRestore(); }
  });

  it('arms the baseline from placements-materialized, NOT from model-loaded', () => {
    const v = makeStubViewer();
    installInvariants(v);
    resetInvariants(v);

    v.fire('model-loaded', { result: {} });
    invariantsOnRenderedFrame();
    expect(hasInvariantBaseline(v), 'model-loaded is too early (rv-viewer.ts:634-638)').toBe(false);

    v.fire('placements-materialized', { aborted: false, materialized: 0 });
    expect(pendingInvariantReservation(v)).toBe('baseline');
    invariantsOnRenderedFrame();
    expect(hasInvariantBaseline(v)).toBe(true);
  });

  it('files a reservation when mode-changed fires through the bus', () => {
    const v = makeStubViewer();
    installInvariants(v);
    resetInvariants(v);
    v.fire('mode-changing', { from: 'hmi', to: 'commissioning' });
    v.fire('mode-changed', { from: 'hmi', to: 'commissioning' });
    expect(pendingInvariantReservation(v)).toBe('compare');
  });

  it('drops everything when model-cleared fires through the bus', () => {
    const v = makeStubViewer();
    installInvariants(v);
    resetInvariants(v);
    v.fire('placements-materialized', { aborted: false, materialized: 0 });
    invariantsOnRenderedFrame();
    v.fire('mode-changed', { from: 'a', to: 'b' });
    v.fire('model-cleared');
    expect(pendingInvariantReservation(v)).toBeNull();
    expect(hasInvariantBaseline(v)).toBe(false);
  });
});

describe('invariant checkpoint wiring — structural, in rv-viewer.ts', () => {
  it('imports the layer and installs it behind the DEV guard', () => {
    expect(viewerSource).toContain("from './engine/rv-invariants'");
    expect(viewerSource).toMatch(/if \(import\.meta\.env\.DEV\) installInvariants\(this\);/);
  });

  it('drains the deferred reservation at the end of render(), behind the guard', () => {
    expect(viewerSource).toMatch(/if \(import\.meta\.env\.DEV\) invariantsOnRenderedFrame\(\);/);
  });

  it('references the layer ONLY behind a DEV guard — nothing else may reach it', () => {
    const uses = viewerSource
      .split('\n')
      .filter((l) => /installInvariants|invariantsOnRenderedFrame/.test(l) && !/^import /.test(l.trim()));
    expect(uses.length).toBeGreaterThan(0);
    for (const line of uses) {
      expect(line, `unguarded use: ${line.trim()}`).toContain('import.meta.env.DEV');
    }
  });

  it('is active in this development test environment', () => {
    expect(invariantsEnabled()).toBe(true);
  });
});
