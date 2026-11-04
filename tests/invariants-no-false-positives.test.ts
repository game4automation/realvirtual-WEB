// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-600 test 9.8 — **F9: no false alarms.** One negative test per invariant,
 * because an invariant that goes red on legitimate behaviour gets switched off,
 * which is worse than not having it.
 *
 * Covered: a legitimately mounted extra signal consumer, `warning` and `info`
 * Problems entries (including `placement-cap` and `override-orphaned`), the
 * first-time initialisation of GPU resources during warmup, and a clean scene.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  armInvariantBaseline,
  checkInvariants,
  invariantsOnRenderedFrame,
  resetInvariants,
} from '../src/core/engine/rv-invariants';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { clearAllProblems, reportProblem, reportReferenceRescued } from '../src/core/hmi/problems-store';
import { addStubNode, makeStubViewer, type StubViewer } from './helpers/invariant-stub-viewer';

function completedCycle(v: StubViewer): void {
  checkInvariants(v, 'mode-changing');
  v.activeMode = 'commissioning';
  checkInvariants(v, 'mode-changed');
  invariantsOnRenderedFrame();
  checkInvariants(v, 'mode-changing');
  v.activeMode = 'hmi';
  checkInvariants(v, 'mode-changed');
  invariantsOnRenderedFrame();
}

describe('F9 — legitimate behaviour triggers nothing', () => {
  let errors: string[];

  beforeEach(() => {
    clearAllProblems();
    errors = [];
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errors.push(a.join(' ')); });
    invariantsOnRenderedFrame();
  });

  it('I1: a clean scene with many nodes stays silent', () => {
    const v = makeStubViewer();
    resetInvariants(v);
    for (let i = 0; i < 200; i++) {
      const n = addStubNode(v, `Cell/Part${i}`);
      n.position.set(i, -i, i / 3);
      n.scale.setScalar(0.001);
      n.rotateY(i);
    }
    expect(checkInvariants(v, 'explicit')).toEqual([]);
  });

  it('I1: a zero scale is legitimate, not a violation', () => {
    const v = makeStubViewer();
    resetInvariants(v);
    addStubNode(v, 'Cell/Hidden').scale.set(0, 0, 0);
    expect(checkInvariants(v, 'explicit')).toEqual([]);
  });

  it('I2: a mode switch that cleans up properly stays silent', () => {
    const v = makeStubViewer({ nodeCount: 17456 });
    resetInvariants(v);
    checkInvariants(v, 'mode-changing');
    v.nodeCount = 20000;   // the mode builds its own tree …
    v.nodeCount = 17456;   // … and tears it down again before mode-changed
    expect(checkInvariants(v, 'mode-changed')).toEqual([]);
  });

  it('I3: a legitimately mounted extra consumer does not fire', () => {
    const v = makeStubViewer();
    resetInvariants(v);
    v.listeners.set('do5', 2);
    armInvariantBaseline(v);
    invariantsOnRenderedFrame();

    // A consumer mounts and unmounts WITHIN the cycle — both comparison points
    // share the same named UI state, which is what makes this harmless.
    v.listeners.set('do5', 3);
    checkInvariants(v, 'mode-changing');
    v.activeMode = 'commissioning';
    checkInvariants(v, 'mode-changed');
    invariantsOnRenderedFrame();
    v.listeners.set('do5', 2); // unmounted again
    checkInvariants(v, 'mode-changing');
    v.activeMode = 'hmi';
    checkInvariants(v, 'mode-changed');
    invariantsOnRenderedFrame();

    expect(errors.filter((e) => e.includes('I3'))).toEqual([]);
  });

  it('I3: a real store subscribe/unsubscribe pair leaves no trace', () => {
    const store = new SignalStore();
    store.register('do5', 'Cell/Do5', false);
    const before = store.listenerCounts();
    const unsub = store.subscribe('do5', () => {});
    expect(store.listenerCount('do5')).toBe(1);
    unsub();
    expect(store.listenerCounts()).toEqual(before);
  });

  it('I4: warning and info entries stay silent — incl. the two warning codes', () => {
    const v = makeStubViewer();
    resetInvariants(v);
    reportProblem({ id: 'w1', severity: 'warning', code: 'placement-cap', title: 'Placement cap reached', detail: 'd' });
    reportProblem({ id: 'w2', severity: 'warning', code: 'override-orphaned', title: 'Override orphaned', detail: 'd' });
    reportProblem({ id: 'w3', severity: 'warning', code: 'nested-reference', title: 'Nested reference', detail: 'd' });
    reportProblem({ id: 'i1', severity: 'info', code: 'signal-reconcile', title: 'Signals reconciled', detail: 'd' });
    // plan-610: a reference that binds only by a fallback lookup is a warning.
    reportReferenceRescued({
      referrerPath: 'Cell/Lift', componentType: 'Drive_Cylinder', field: 'In',
      writtenPath: 'FG01/X', resolvedPath: 'Cell/Signals/FG01/X', stage: 'suffix',
    });
    expect(checkInvariants(v, 'explicit')).toEqual([]);
    expect(errors).toEqual([]);
  });

  it('I5: the first-time initialisation of GPU resources is not drift', () => {
    const v = makeStubViewer();
    resetInvariants(v);
    // Warmup: the counters climb BEFORE the baseline is taken (measured
    // 3/27 -> 114/44 over the load), which is exactly why the baseline sits at
    // the load-bound completion and not earlier.
    v.memory.geometries = 3; v.memory.textures = 27;
    v.memory.geometries = 114; v.memory.textures = 44;
    armInvariantBaseline(v);
    invariantsOnRenderedFrame();

    completedCycle(v);
    expect(errors.filter((e) => e.includes('I5'))).toEqual([]);
  });

  it('I5: a mode switch alone changes nothing — the measured null test', () => {
    const v = makeStubViewer();
    resetInvariants(v);
    v.memory.geometries = 114; v.memory.textures = 44; v.programs = 42;
    armInvariantBaseline(v);
    invariantsOnRenderedFrame();
    for (let i = 0; i < 3; i++) completedCycle(v);
    expect(errors).toEqual([]);
  });

  it('nothing at all fires on a healthy viewer over a full lifecycle', () => {
    const v = makeStubViewer();
    resetInvariants(v);
    for (let i = 0; i < 20; i++) addStubNode(v, `Cell/P${i}`);
    checkInvariants(v, 'model-loaded');
    armInvariantBaseline(v);
    invariantsOnRenderedFrame();
    completedCycle(v);
    resetInvariants(v);
    invariantsOnRenderedFrame();
    expect(errors).toEqual([]);
  });
});
