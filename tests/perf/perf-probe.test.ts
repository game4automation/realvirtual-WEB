// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-465 §9.4 — the probe's frame/step accounting.
 *
 * The probe exists because the viewer's own frame metric is averaged over 500 ms
 * AND clamped to 100 ms, so it cannot show a hitch. Every test here therefore
 * checks a property the OLD metric would have got wrong.
 *
 * The probe is driven through a FAKE loop with an injected clock: real frames
 * would make the assertions timing-dependent, and the wrapper contract
 * (`onRender` / `onFixedUpdate` are replaced, called, restored) is exactly what
 * needs testing anyway.
 */

import { describe, it, expect } from 'vitest';
import {
  RVPerfProbe, histAdd, histPercentile, createHistogram,
  TIMING_BIN_MS, TIMING_MAX_MS,
} from '../../src/core/engine/perf/rv-perf-probe';

/** Fake `SimulationLoop`: the probe swaps these two callbacks and we call them. */
function makeLoop() {
  const loop = {
    onFixedUpdate: (_dt: number) => {},
    onRender: (_ft: number) => {},
    clampedSeconds: 0,
    droppedBacklogSeconds: 0,
    pausedSeconds: 0,
    resetCalls: 0,
    resetLostTimeCounters() { this.resetCalls++; },
  };
  return loop;
}

/** Injected monotonic clock in ms. */
function makeClock() {
  let t = 0;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

describe('RVPerfProbe frame accounting', () => {
  it('records the UNCLAMPED wall delta, so a 200 ms hitch is visible in max', () => {
    const loop = makeLoop();
    const clock = makeClock();
    const probe = new RVPerfProbe();
    probe.start({ loop, now: clock.now, isVisible: () => true, windowMs: 1e9 });

    for (let i = 0; i < 999; i++) { clock.advance(10); loop.onRender(0.01); }
    clock.advance(200); loop.onRender(0.1);   // the loop clamped ITS delta to 0.1 s

    const report = probe.report();
    expect(report.frameMs.count).toBe(1000);
    expect(report.frameMs.max).toBeCloseTo(200, 6);
    // One sample in 1000: rank(p50) = 500, rank(p99) = 990 — both still in the
    // 10 ms bin. A single hitch must NOT move p99 (SOL R2#7).
    expect(report.frameMs.p50).toBeLessThanOrEqual(10 + TIMING_BIN_MS);
    expect(report.frameMs.p99).toBeLessThanOrEqual(10 + TIMING_BIN_MS);
    probe.stop();
  });

  it('lifts p99 but not p95 when 2 % of frames are slow', () => {
    const loop = makeLoop();
    const clock = makeClock();
    const probe = new RVPerfProbe();
    probe.start({ loop, now: clock.now, isVisible: () => true, windowMs: 1e9 });

    for (let i = 0; i < 1000; i++) {
      clock.advance(i % 50 === 0 ? 200 : 10);   // 20 slow frames of 1000
      loop.onRender(0.016);
    }

    const report = probe.report();
    // rank(p99) = 990 → inside the top 20 slow samples; rank(p95) = 950 → below them.
    expect(report.frameMs.p99).toBeGreaterThanOrEqual(200);
    expect(report.frameMs.p95).toBeLessThan(200);
    probe.stop();
  });

  it('records one measurement per fixed step, so two steps in a frame give two values', () => {
    const loop = makeLoop();
    const clock = makeClock();
    const probe = new RVPerfProbe();
    let stepBodyCalls = 0;
    loop.onFixedUpdate = () => { stepBodyCalls++; clock.advance(3); };
    probe.start({ loop, now: clock.now, isVisible: () => true, windowMs: 1e9 });

    loop.onFixedUpdate(1 / 60);
    loop.onFixedUpdate(1 / 60);
    clock.advance(10);
    loop.onRender(0.016);

    const report = probe.report();
    expect(stepBodyCalls).toBe(2);
    expect(report.stepMs.count).toBe(2);
    expect(report.stepMs.max).toBeCloseTo(3, 6);
    probe.stop();
  });

  it('routes hidden-tab and GC-forced values into the excluded histograms', () => {
    const loop = makeLoop();
    const clock = makeClock();
    const probe = new RVPerfProbe();
    let visible = true;
    probe.start({ loop, now: clock.now, isVisible: () => visible, windowMs: 1e9 });

    for (let i = 0; i < 10; i++) { clock.advance(10); loop.onRender(0.01); }
    visible = false;
    for (let i = 0; i < 10; i++) { clock.advance(400); loop.onRender(0.1); }
    visible = true;
    probe.markGc(true);
    for (let i = 0; i < 10; i++) { clock.advance(300); loop.onRender(0.1); }
    probe.markGc(false);

    const report = probe.report();
    expect(report.frameMs.count).toBe(10);
    expect(report.frameMs.max).toBeCloseTo(10, 6);      // no 300/400 ms value leaked in
    expect(report.excluded.frameMs.count).toBe(20);
    probe.stop();
  });

  it('restores the original callbacks on stop', () => {
    const loop = makeLoop();
    const render = () => {};
    const fixed = () => {};
    loop.onRender = render;
    loop.onFixedUpdate = fixed;
    const probe = new RVPerfProbe();
    probe.start({ loop, now: makeClock().now });
    expect(loop.onRender).not.toBe(render);
    probe.stop();
    expect(loop.onRender).toBe(render);
    expect(loop.onFixedUpdate).toBe(fixed);
  });

  it('resets the loop lost-time counters on start, so a run owns its own drift', () => {
    const loop = makeLoop();
    const probe = new RVPerfProbe();
    probe.start({ loop, now: makeClock().now });
    expect(loop.resetCalls).toBe(1);
    probe.stop();
  });
});

describe('RVPerfProbe aggregation', () => {
  it('gives the same whole-run percentiles as sorting every raw value', () => {
    // Five ring-buffer wraps with a DIFFERENT number of frames per window: the
    // point of the whole-run histogram is that this is exactly the case where
    // averaging per-window percentiles would give a wrong answer (SOL R2#3).
    const loop = makeLoop();
    const clock = makeClock();
    const probe = new RVPerfProbe();
    probe.start({ loop, now: clock.now, isVisible: () => true, windowMs: 500, ringCapacity: 128 });

    const raw: number[] = [];
    let seed = 12345;
    const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    for (let window = 0; window < 5; window++) {
      const frames = 100 + window * 137;          // deliberately uneven windows
      for (let i = 0; i < frames; i++) {
        const dt = 4 + rand() * 40;
        clock.advance(dt);
        raw.push(dt);
        loop.onRender(0.016);
      }
    }

    const report = probe.report();
    const sorted = [...raw].sort((a, b) => a - b);
    const exact = (p: number) => sorted[Math.max(1, Math.ceil(p * sorted.length)) - 1];
    expect(report.frameMs.count).toBe(raw.length);
    // Histogram percentiles are the bin's UPPER edge, so they land within one
    // bin width above the exact value — never below it.
    for (const p of [0.5, 0.95, 0.99] as const) {
      const key = p === 0.5 ? 'p50' : p === 0.95 ? 'p95' : 'p99';
      expect(report.frameMs[key]).toBeGreaterThanOrEqual(exact(p));
      expect(report.frameMs[key]).toBeLessThanOrEqual(exact(p) + TIMING_BIN_MS);
    }
    probe.stop();
  });

  it('keeps its typed buffers after they fill — no reallocation in the hot path', () => {
    const loop = makeLoop();
    const clock = makeClock();
    const probe = new RVPerfProbe();
    probe.start({ loop, now: clock.now, isVisible: () => true, windowMs: 500, ringCapacity: 64 });

    const ringBuffer = probe.frameRing.values;
    const histBins = probe.frameHist.bins;
    for (let i = 0; i < 5000; i++) { clock.advance(8); loop.onRender(0.016); }

    expect(probe.frameRing.values).toBe(ringBuffer);
    expect(probe.frameHist.bins).toBe(histBins);
    expect(probe.frameRing.length).toBe(64);         // ring is bounded, not grown
    expect(probe.frameHist.count).toBe(5000);        // but nothing was lost from the histogram
    probe.stop();
  });

  it('reports first and last window samples', () => {
    const loop = makeLoop();
    const clock = makeClock();
    const probe = new RVPerfProbe();
    probe.start({ loop, now: clock.now, isVisible: () => true, windowMs: 500 });
    for (let i = 0; i < 300; i++) { clock.advance(10); loop.onRender(0.016); }

    const report = probe.report();
    expect(report.samples).toBeGreaterThanOrEqual(5);
    expect(report.first).not.toBeNull();
    expect(report.last).not.toBeNull();
    expect(report.first!.t).toBeLessThan(report.last!.t);
    probe.stop();
  });
});

describe('histogram primitive', () => {
  it('puts out-of-range values in overflow but still counts and maxes them', () => {
    const h = createHistogram(TIMING_BIN_MS, TIMING_MAX_MS);
    histAdd(h, 10);
    histAdd(h, TIMING_MAX_MS + 250);
    expect(h.count).toBe(2);
    expect(h.overflow).toBe(1);
    expect(h.max).toBe(TIMING_MAX_MS + 250);
    // The overflow value is beyond the last bin, so the top percentile falls back
    // to the recorded max rather than silently reporting the last bin edge.
    expect(histPercentile(h, 1)).toBe(TIMING_MAX_MS + 250);
  });

  it('ignores negative and NaN values instead of corrupting the bins', () => {
    const h = createHistogram(1, 100);
    histAdd(h, -5);
    histAdd(h, Number.NaN);
    expect(h.count).toBe(0);
  });
});

/**
 * plan-465 fix 2026-09-06 — `reset()` opens the observation window.
 *
 * The harness resets the probe AFTER the line has filled. If `reset()` cleared
 * the accumulators but left the clock running from `start()`, the report would
 * still be stamped with the fill phase: the first 2400-MU report claimed a
 * `durationMs` of 374 s for a 120 s window, and its lost-sim-time was charged
 * with hitches from a line that was still coming up.
 */
describe('RVPerfProbe reset re-baselines the window', () => {
  it('reports only the time since reset(), not since start()', () => {
    const loop = makeLoop();
    const clock = makeClock();
    const probe = new RVPerfProbe();
    // Small window so samples (and therefore `durationMs`) actually emit.
    probe.start({ loop, now: clock.now, isVisible: () => true, windowMs: 500 });

    // Fill phase: 60 s of frames that must not appear in the report.
    for (let i = 0; i < 6000; i++) { clock.advance(10); loop.onRender(0.01); }
    expect(probe.report().durationMs).toBeGreaterThan(59_000);

    probe.reset();

    // Observation window: 10 s.
    for (let i = 0; i < 1000; i++) { clock.advance(10); loop.onRender(0.01); }
    const report = probe.report();
    expect(report.durationMs).toBeGreaterThan(9_000);
    expect(report.durationMs).toBeLessThan(11_000);
    expect(report.frameMs.count).toBe(1000);
    probe.stop();
  });

  it('re-zeroes the loop lost-time counters so drift is window-relative', () => {
    const loop = makeLoop();
    const clock = makeClock();
    const probe = new RVPerfProbe();
    probe.start({ loop, now: clock.now, isVisible: () => true, windowMs: 500 });
    expect(loop.resetCalls).toBe(1);           // start() zeroes them once

    loop.clampedSeconds = 4.2;                 // hitches during the fill phase
    probe.reset();
    expect(loop.resetCalls).toBe(2);           // reset() zeroes them again
    probe.stop();
  });

  it('a reset BEFORE start() leaves the clock for start() to set', () => {
    const loop = makeLoop();
    const clock = makeClock();
    const probe = new RVPerfProbe();
    probe.reset();                              // not running — must be a no-op
    expect(loop.resetCalls).toBe(0);
    clock.advance(5_000);
    probe.start({ loop, now: clock.now, isVisible: () => true, windowMs: 500 });
    for (let i = 0; i < 100; i++) { clock.advance(10); loop.onRender(0.01); }
    expect(probe.report().durationMs).toBeLessThan(1_100);
    probe.stop();
  });
});
