// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPlanningRegistry } from '../../src/core/planning/rv-planning-registry';
import {
  createStructuralResetRunner, type StructuralResetViewer,
} from '../../src/plugins/planning-parameters/structural-reset';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function harness(onStructuralReset: () => Promise<void> = async () => {}) {
  let document = 'old';
  let abort = new AbortController();
  const pauses = { old: new Set<string>(), new: new Set<string>() };
  const pauseCalls: Array<{ document: string; paused: boolean }> = [];
  const resets: string[] = [];
  const viewer: StructuralResetViewer = {
    get isSimulationPaused() { return pauses[document as keyof typeof pauses].size > 0; },
    setSimulationPaused(reason, paused) {
      pauseCalls.push({ document, paused });
      const reasons = pauses[document as keyof typeof pauses];
      if (paused) reasons.add(reason); else reasons.delete(reason);
    },
    resetSimulation() { resets.push(document); },
    simulationKernel: {
      mode: 'des',
      hasDesLifecycle: () => true,
      // Deliberately never emits bound: tests control timeout / abort instead.
      onDesLifecycle: () => () => {},
    },
  };
  const registry = createPlanningRegistry({
    simTime: () => 0,
    problems: { report: () => {}, clear: () => {} },
  });
  registry.setApplyRunner(createStructuralResetRunner({
    viewer, documentLoadId: () => document, signal: () => abort.signal, boundTimeoutMs: 20,
  }));
  registry.declare({
    owner: 'yard', title: 'Yard',
    params: [{ key: 'slots', label: 'Slots', type: 'integer', default: 6, group: 'Layout', apply: 'reset' }],
    onStructuralReset,
  });
  registry.set('yard.slots', 2, 'ui');
  return {
    registry, pauses, pauseCalls, resets,
    switchDocument() {
      document = 'new';
      abort.abort();
      abort = new AbortController();
    },
  };
}

afterEach(() => vi.useRealTimers());

// plan-2013 Phase 1: the hull lives in the lazily imported `core/params/rv-param-apply`. Load it
// once up front so the runner's `import()` settles in microtasks under fake timers.
beforeAll(async () => { await import('../../src/core/params/rv-param-apply'); });

describe('plan-2006 9.27-9.28: failed structural apply ownership', () => {
  it('keeps the old document paused after a bind timeout (#14)', async () => {
    vi.useFakeTimers();
    const h = harness();
    const apply = h.registry.applyPendingAndReset();
    await vi.runAllTimersAsync();
    expect(await apply).toMatchObject({ ok: false, error: 'materialize-failed' });
    expect(h.resets).toEqual(['old']);
    // Currently false: the direct timeout return leaves outcome.ok true in finally.
    expect(h.pauses.old.size).toBeGreaterThan(0);
    expect(h.pauses.new.size).toBe(0);
  });

  it('does not pause the new document when the owner finishes after a switch (#14)', async () => {
    const entered = deferred();
    const release = deferred();
    const h = harness(async () => { entered.resolve(); await release.promise; });
    const apply = h.registry.applyPendingAndReset();
    await entered.promise;
    h.switchDocument();
    release.resolve();
    expect(await apply).toMatchObject({ ok: false, error: 'document-changed' });
    expect(h.resets).toEqual([]);
    expect(h.pauses.old.size).toBeGreaterThan(0);
    // Currently one: finally adds the user pause to the active NEW document.
    expect(h.pauses.new.size).toBe(0);
    expect(h.pauseCalls.filter((c) => c.document === 'new' && c.paused)).toEqual([]);
  });

  it('does not reset the new document after a switch inside rollback (#15)', async () => {
    vi.useFakeTimers();
    const rollbackEntered = deferred();
    const releaseRollback = deferred();
    let calls = 0;
    const h = harness(async () => {
      if (++calls === 1) throw new Error('reconfigure failed');
      rollbackEntered.resolve();
      await releaseRollback.promise;
    });
    const apply = h.registry.applyPendingAndReset();
    await rollbackEntered.promise;
    h.switchDocument();
    releaseRollback.resolve();
    await vi.runAllTimersAsync();
    await apply;
    expect(calls).toBe(2);
    // Currently ['new']: rollback has no identity check before the reset.
    expect(h.resets).toEqual([]);
  });
});
