// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-469 Phase 0d — the simulation-stage seam in `ContinuousRunner.tick()`.
 *
 * Two things have to hold, or the stage table is worse than no table:
 *
 *  - `simStageProbe.hooks = null` (production) must not change the tick by one
 *    call or one ordering. R1's transport-before-behaviors guarantee is the
 *    whole reason the runner exists; instrumenting it must not weaken it.
 *  - every stage must be entered AND left exactly once per tick, in execution
 *    order, so the four exclusive numbers add up to the step instead of
 *    silently overlapping.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { ContinuousRunner } from '../../src/core/material-flow/continuous-runner';
import { simStageProbe, SIM_STAGES } from '../../src/core/engine/perf/rv-sim-stage-hooks';
import { RVStageTimer } from '../../src/core/engine/perf/rv-perf-probe';
import type { SimStage } from '../../src/core/engine/perf/rv-sim-stage-hooks';

interface Recorder { calls: string[] }

function makeRunner(rec: Recorder, transportGate?: () => boolean): ContinuousRunner {
  const transport = { update: () => rec.calls.push('transport.update'), reset: () => {} };
  const behaviors = { tick: () => rec.calls.push('behaviors.tick') };
  const core = {
    early: () => rec.calls.push('core.early'),
    drives: () => rec.calls.push('core.drives'),
    visuals: () => rec.calls.push('core.visuals'),
  };
  return new ContinuousRunner(
    transport as never, behaviors as never, core as never, transportGate,
  );
}

afterEach(() => { simStageProbe.hooks = null; });

describe('ContinuousRunner stage seam', () => {
  it('is inert with hooks null — same calls, same order as before', () => {
    const rec: Recorder = { calls: [] };
    makeRunner(rec).tick(1 / 60);
    expect(rec.calls).toEqual([
      'core.drives', 'transport.update', 'behaviors.tick', 'core.visuals',
    ]);
  });

  it('enters and leaves every stage exactly once, in execution order', () => {
    const rec: Recorder = { calls: [] };
    const seen: string[] = [];
    simStageProbe.hooks = {
      enter: (s: SimStage) => seen.push(`>${s}`),
      leave: (s: SimStage) => seen.push(`<${s}`),
    };
    makeRunner(rec).tick(1 / 60);
    expect(seen).toEqual([
      '>drives', '<drives',
      '>transport', '<transport',
      '>behaviors', '<behaviors',
      '>visuals', '<visuals',
    ]);
    // The instrumented call order is still R1's order.
    expect(rec.calls).toEqual([
      'core.drives', 'transport.update', 'behaviors.tick', 'core.visuals',
    ]);
  });

  it('skips the transport pair when the gate is closed, and says so in the hooks', () => {
    const rec: Recorder = { calls: [] };
    const seen: string[] = [];
    simStageProbe.hooks = {
      enter: (s: SimStage) => seen.push(`>${s}`),
      leave: (s: SimStage) => seen.push(`<${s}`),
    };
    makeRunner(rec, () => false).tick(1 / 60);
    expect(rec.calls).toEqual(['core.drives', 'core.visuals']);
    expect(seen).toEqual(['>drives', '<drives', '>visuals', '<visuals']);
  });
});

describe('RVStageTimer', () => {
  it('accumulates each stage separately and reports per-tick percentiles', () => {
    let clock = 0;
    const timer = new RVStageTimer(() => clock);
    // drives 2 ms, transport 5 ms, behaviors 1 ms, visuals 0.5 ms.
    const spans: [SimStage, number][] = [
      ['drives', 2], ['transport', 5], ['behaviors', 1], ['visuals', 0.5],
    ];
    for (let tick = 0; tick < 10; tick++) {
      timer.beginTick();
      for (const [stage, ms] of spans) {
        timer.enter(stage);
        clock += ms;
        timer.leave(stage);
      }
      timer.endTick(true);
    }
    const r = timer.report();
    expect(r.ticks).toBe(10);
    for (const [stage, ms] of spans) {
      // Histogram bins are 0.05 ms and the percentile is the bin's upper edge,
      // clamped to the observed maximum — so it lands exactly on the value.
      expect(r.perTick[stage].p50).toBeCloseTo(ms, 6);
    }
    expect(Object.keys(r.perTick)).toEqual([...SIM_STAGES]);
  });

  it('drops invalid ticks (hidden tab / forced GC) instead of recording them', () => {
    let clock = 0;
    const timer = new RVStageTimer(() => clock);
    timer.beginTick();
    timer.enter('drives'); clock += 40; timer.leave('drives');
    timer.endTick(false);
    expect(timer.report().ticks).toBe(0);
    expect(timer.report().perTick.drives.max).toBe(0);
  });

  it('reset() clears everything', () => {
    let clock = 0;
    const timer = new RVStageTimer(() => clock);
    timer.beginTick();
    timer.enter('visuals'); clock += 3; timer.leave('visuals');
    timer.endTick(true);
    timer.reset();
    expect(timer.report().ticks).toBe(0);
    expect(timer.report().perTick.visuals.count).toBe(0);
  });
});
