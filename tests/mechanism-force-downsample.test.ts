// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * T7b (plan-706 F9b) — the force series reduction must not lose the load peak.
 *
 * The series exists so an agent can see a DUTY CYCLE next to peak and RMS. A
 * reduction that drops the peak turns that into a lie with a chart behind it, so
 * this suite pins the envelope property directly — and keeps the naive
 * every-n-th-sample variant as a NEGATIVE control, because "min and max per
 * bucket" is only obviously right once you have watched the obvious alternative
 * delete the spike.
 *
 * Pure arithmetic: no viewer, no Three.js, no recorder.
 */

import { describe, it, expect } from 'vitest';
import { downsampleSeries } from '@rv-private/plugins/asset-editor/mechanism/mechanism-force-downsample';

const MAX = 200;

/** 3000 samples of ±10 N noise with ONE 340 N spike inside bucket 7. */
function seriesWithSpike(): { values: number[]; spikeAt: number } {
  const values: number[] = [];
  for (let i = 0; i < 3000; i++) values.push(((i * 37) % 21) - 10);
  const spikeAt = Math.floor((3000 / (MAX / 2)) * 7) + 3;
  values[spikeAt] = 340;
  return { values, spikeAt };
}

describe('T7b — downsampleSeries keeps the extremes', () => {
  it('caps at maxPoints and the 340 N spike survives', () => {
    const { values } = seriesWithSpike();
    const out = downsampleSeries(values, 0.1, MAX);
    expect(out.values.length).toBeLessThanOrEqual(MAX);
    expect(Math.max(...out.values)).toBe(340);
  });

  it('the whole envelope survives, not just the one spike', () => {
    const { values } = seriesWithSpike();
    const out = downsampleSeries(values, 0.1, MAX);
    expect(Math.max(...out.values)).toBe(Math.max(...values));
    expect(Math.min(...out.values)).toBe(Math.min(...values));
  });

  it('NEGATIVE CONTROL — naive every-n-th sampling loses it', () => {
    const { values } = seriesWithSpike();
    const step = Math.ceil(values.length / MAX);
    const naive = values.filter((_, i) => i % step === 0);
    expect(naive.length).toBeLessThanOrEqual(MAX);
    // This is the whole reason the implementation is min/max per bucket.
    expect(Math.max(...naive)).toBeLessThan(340);
  });

  it('a series already under the cap is returned unchanged', () => {
    const values = [1, 2, 3, 4, 5];
    const out = downsampleSeries(values, 0.1, MAX, 2.5);
    expect(out.values).toEqual(values);
    expect(out.values).not.toBe(values); // copied, never aliased
    expect(out.dt).toBeCloseTo(0.1, 12);
    expect(out.t0).toBeCloseTo(2.5, 12);
  });

  it('dt scales with the reduction so the time span is preserved', () => {
    const values = Array.from({ length: 3000 }, (_, i) => Math.sin(i / 50));
    const dt = 0.1;
    const out = downsampleSeries(values, dt, MAX);
    const spanIn = (values.length - 1) * dt;
    const spanOut = (out.values.length - 1) * out.dt;
    // Within one output interval — the bucket count rarely divides evenly.
    expect(Math.abs(spanOut - spanIn)).toBeLessThan(out.dt * 2);
  });

  it('gaps (NaN) are not counted as zeros', () => {
    // An all-gap stretch must not pull the envelope down to 0: a zero would read
    // as "this axis is unloaded" exactly where nothing was measured.
    const values = Array.from({ length: 3000 }, (_, i) => (i < 1500 ? Number.NaN : 120));
    const out = downsampleSeries(values, 0.1, MAX);
    const finite = out.values.filter((v) => Number.isFinite(v));
    expect(finite.length).toBeGreaterThan(0);
    expect(Math.min(...finite)).toBe(120);
  });

  it('keeps a bucket\'s two extremes in chronological order', () => {
    // A rising ramp must come out monotonically rising: always emitting
    // min-then-max would draw a phantom edge on every falling flank.
    const values = Array.from({ length: 1000 }, (_, i) => i);
    const out = downsampleSeries(values, 0.1, 20);
    for (let i = 1; i < out.values.length; i++) {
      expect(out.values[i]).toBeGreaterThanOrEqual(out.values[i - 1]);
    }
  });
});
