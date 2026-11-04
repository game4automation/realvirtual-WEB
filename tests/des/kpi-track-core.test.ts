// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2211 G4 / FA9 / R4-5 — KPI recording of a single run is DES core: without any experiment
 * backend, the run identity tracks the published sources of the run's model (a component
 * property and a statistics value row), finalizes the track before the run-end listeners,
 * continues it on Continue and starts it over on Reset. Without sources nothing is tracked and
 * nothing subscribes to the clock.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { lineFixture } from './runner-fixture';
import { registerKpiSourceProvider, setTrackedKpiSources } from '../../src/plugins/des/des-kpi-track';
import { runScopeStore } from '../../src/core/material-flow/rv-run-history-store';
import { __setKpiProviderTimeoutForTest, type RunIdentity } from '../../src/plugins/des/rv-des-run-identity';
import type { KpiTrack } from '../../src/plugins/sim-controller/des-kpi-defs';

const PROP = 'prop:*Sink|Sink|TotalProcessed';
const ROW = 'row:yard/late';

function fixture(model: string | null, sources: readonly string[] | null) {
  if (model) {
    runScopeStore.set({ model, exp: 'live', projectId: null });
    if (sources) setTrackedKpiSources(model, sources);
  }
  let late = 0;
  const f = lineFixture({ experiments: false });
  (f.host as unknown as { stats: unknown }).stats = {
    list: () => [{ id: 'yard', title: 'Yard', rows: () => [{ key: 'late', label: 'Late', value: late }] }],
  };
  const identity = (f.runner as unknown as { identity: RunIdentity }).identity;
  return { ...f, identity, setLate: (v: number) => { late = v; } };
}

afterEach(() => { runScopeStore.set(null); });

describe('KPI recording in the core run identity (G4)', () => {
  it('records a property and a value-row source, finalized before the run-end listeners', async () => {
    const model = `kpi-core-${crypto.randomUUID()}`;
    // The row source must exist from the start: published before the run starts.
    const f = fixture(model, [PROP, ROW]);
    try {
      f.setLate(3);
      let atEnd: KpiTrack | undefined;
      f.identity.subscribe(event => { if (event.type === 'end') atEnd = f.identity.kpiTrack(); }, false);
      f.manager.duration = 600;
      expect(await f.runner.runFastForward()).toBe(true);
      expect(atEnd).toBeDefined();
      expect(atEnd).toMatchObject({ t0: 0, t1: 600 });
      expect(atEnd!.values[PROP].end).toBe(f.sink.totalProcessed);
      expect(f.sink.totalProcessed).toBeGreaterThan(0);
      // Time-weighted from the first clock edge (the first event time), so the mean of a
      // constant row is just below 3 over [0, 600].
      expect(atEnd!.values[ROW]).toMatchObject({ end: 3, max: 3 });
      expect(atEnd!.values[ROW].mean).toBeGreaterThan(2.9);
      expect(atEnd!.values[ROW].mean).toBeLessThanOrEqual(3);
      expect(f.runner.kpiTrack()).toEqual(atEnd);

      // Continue: the same tracker integrates on from the previous end.
      f.manager.duration = 600;
      expect(f.runner.continueRun()).toBe(true);
      await f.runner.runFastForward();
      const continued = f.identity.kpiTrack()!;
      expect(continued.t1).toBe(1200);
      expect(continued.values[PROP].warm).toBe(atEnd!.values[PROP].warm);
      expect(continued.values[PROP].end).toBe(f.sink.totalProcessed);

      // Reset: a new run, tracked from scratch.
      f.runner.reset();
      const fresh = f.identity.kpiTrack()!;
      expect(fresh.t1).toBe(f.manager.currentTime);
      expect(fresh.values[PROP].end).toBe(f.sink.totalProcessed);
      expect(fresh.t1).toBeLessThan(continued.t1);
    } finally { f.runner.dispose(); setTrackedKpiSources(model, []); }
  });

  it('a restored snapshot starts the open run\'s tracking over', async () => {
    const model = `kpi-core-${crypto.randomUUID()}`;
    const f = fixture(model, [PROP]);
    try {
      f.manager.duration = 1200;
      await f.runner.runFastForward({ untilSimTime: 300 });
      const snapshot = f.runner.snapshotJson();
      await f.runner.runFastForward({ untilSimTime: 900 });
      const before = f.identity.kpiTrack()!;
      expect(before.values[PROP]).toBeDefined();
      f.runner.restoreJson(snapshot);
      const after = f.identity.kpiTrack();
      // The new tracker starts at the restored time, after the warm-up end (0): the source
      // cannot be measured whole any more, so nothing is tracked for this run.
      expect(after?.values[PROP]).toBeUndefined();
    } finally { f.runner.dispose(); setTrackedKpiSources(model, []); }
  });

  it('without published sources nothing is tracked and nothing subscribes to the clock', async () => {
    const f = fixture(`kpi-core-${crypto.randomUUID()}`, null);
    try {
      const add = vi.spyOn(f.manager, 'addTimeAdvanceListener');
      f.runner.reset();
      f.manager.duration = 300;
      await f.runner.runFastForward();
      expect(f.identity.kpiTrack()).toBeUndefined();
      expect((f.identity as unknown as { offTracker: unknown }).offTracker).toBeNull();
      // No KPI subscription: whatever subscribed, the identity holds none.
      expect((f.identity as unknown as { tracker: { size: number } | null }).tracker?.size ?? 0).toBe(0);
      add.mockRestore();
    } finally { f.runner.dispose(); }
  });

  it('without a model key (no scope, no model URL) nothing is tracked', async () => {
    const f = fixture(null, null);
    try {
      f.manager.duration = 300;
      await f.runner.runFastForward();
      expect(f.identity.kpiTrack()).toBeUndefined();
    } finally { f.runner.dispose(); }
  });
});

// ── Codex re-check (2026-11-03): #2 the provider timeout is terminal for the run; note 3 the
// readiness barrier does not change the DES result ──

describe('KPI source provider: timeout and determinism', () => {
  const later = <T>(ms: number, value: T) => new Promise<T>(resolve => setTimeout(() => resolve(value), ms));

  it('#2 an answer after the timeout never reaches the running tracker; the track says kpi-sources-timeout', async () => {
    const model = `kpi-timeout-${crypto.randomUUID()}`;
    const restoreTimeout = __setKpiProviderTimeoutForTest(30);
    const off = registerKpiSourceProvider(() => later(150, [PROP]));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const f = fixture(model, null);
    try {
      f.manager.duration = 600;
      expect(await f.runner.runFastForward()).toBe(true); // released by the timeout
      await later(200, null);                              // the late answer arrives meanwhile
      const track = f.identity.kpiTrack()!;
      expect(track).toMatchObject({ incomplete: 'kpi-sources-timeout', values: {} });
      expect(warn.mock.calls.filter(c => String(c[0]).includes('kpi-sources-timeout'))).toHaveLength(1);
      // The late answer filled the session cache: the NEXT run tracks without waiting.
      f.runner.reset();
      expect(f.identity.kpiSourcesPending).toBeNull();
      f.manager.duration = 600;
      await f.runner.runFastForward();
      const next = f.identity.kpiTrack()!;
      expect(next.incomplete).toBeUndefined();
      expect(next.values[PROP].end).toBe(f.sink.totalProcessed);
    } finally { off(); restoreTimeout(); warn.mockRestore(); f.runner.dispose(); setTrackedKpiSources(model, []); }
  });

  it('note 3: the same seed gives the same DES run with a slow provider (ticks during the wait) and without one', async () => {
    const runOnce = async (slow: boolean) => {
      const model = `kpi-determinism-${crypto.randomUUID()}`;
      const off = slow ? registerKpiSourceProvider(() => later(80, [PROP])) : () => {};
      const f = fixture(model, slow ? null : [PROP]);
      const times: number[] = [];
      const offTimes = f.manager.addTimeAdvanceListener(t => { times.push(t); });
      try {
        if (slow) {
          expect(f.identity.kpiSourcesPending).not.toBeNull();
          // Ticks while the barrier waits advance nothing on the DES clock.
          for (let i = 0; i < 20; i++) f.runner.tick(0.5);
          expect(f.manager.currentTime).toBe(0);
          expect(f.manager.totalEventsProcessed).toBe(0);
          await f.runner.kpiSourcesReady();
        }
        f.manager.duration = 1800;
        expect(await f.runner.runFastForward()).toBe(true);
        return {
          times, events: f.manager.totalEventsProcessed, processed: f.sink.totalProcessed,
          stats: JSON.stringify(f.runner.statistics()), track: f.identity.kpiTrack(),
        };
      } finally { offTimes(); off(); f.runner.dispose(); setTrackedKpiSources(model, []); }
    };
    const slow = await runOnce(true);
    const direct = await runOnce(false);
    expect(slow.events).toBeGreaterThan(0);
    expect(slow.times).toEqual(direct.times);
    expect(slow.events).toBe(direct.events);
    expect(slow.processed).toBe(direct.processed);
    expect(slow.stats).toBe(direct.stats);
    expect(slow.track).toEqual(direct.track);
  });
});
