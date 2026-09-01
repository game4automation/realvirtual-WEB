// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Force chart options — the pure half of the sizing chart (plan-412 test 9.6,
 * pattern `sensor-history-chart-options.test.ts`).
 *
 * The option object is where a chart can be quietly WRONG: a gap bridged into a
 * straight line, a peak line missing on a negative swing, a value dated to the
 * wrong timestamp. None of that needs a canvas to catch, and none of it is
 * visible in a screenshot test either.
 */

import { describe, it, expect } from 'vitest';
import {
  buildForceChartOption,
  pairForceSamples,
  formatForceValue,
  formatSiMagnitude,
  FORCE_PEAK_COLOR,
  FORCE_RMS_COLOR,
  FORCE_HOLDING_COLOR,
} from '@rv-private/plugins/asset-editor/mechanism/mechanism-force-chart-options';

/* eslint-disable @typescript-eslint/no-explicit-any */

const base = {
  label: 'Lift axis',
  unit: 'N·m',
  times: [0.1, 0.2, 0.3, 0.4],
  values: [10, -48.2, 21, 5],
  peak: 48.2,
  rms: 21.7,
  holding: 9.8,
};

function markLines(opt: Record<string, unknown>): any[] {
  return ((opt.series as any[])[0].markLine.data) as any[];
}

describe('pairForceSamples', () => {
  it('pairs times with values and turns NaN into null', () => {
    expect(pairForceSamples([0, 1, 2], [5, Number.NaN, 7]))
      .toEqual([[0, 5], [1, null], [2, 7]]);
  });

  it('aligns on the common TAIL when the buffers differ in length', () => {
    // The series was created one tick after the timestamp was pushed; the newer
    // samples are the ones that correspond.
    expect(pairForceSamples([0, 1, 2], [6, 7])).toEqual([[1, 6], [2, 7]]);
  });
});

describe('SI value formatting', () => {
  it('scales large magnitudes instead of printing digit walls', () => {
    // The Delta run that motivated this printed "Peak 10632343.00 N·m".
    expect(formatForceValue(10632343, 'N·m')).toBe('10.6 MN·m');
    expect(formatForceValue(1710810.41, 'N·m')).toBe('1.71 MN·m');
    expect(formatForceValue(14687.99, 'N·m')).toBe('14.7 kN·m');
    expect(formatSiMagnitude(30000000)).toBe('30.0 M');
  });

  it('keeps small values plain and signs intact', () => {
    expect(formatForceValue(2.4, 'N·m')).toBe('2.40 N·m');
    expect(formatForceValue(-48.2, 'N·m')).toBe('-48.2 N·m');
    expect(formatForceValue(248, 'N')).toBe('248 N');
    // Sub-centinewton readings drop to milli instead of rounding to "0.00".
    expect(formatForceValue(0.004, 'N·m')).toBe('4.00 mN·m');
    expect(formatForceValue(0, 'N·m')).toBe('0.00 N·m');
  });

  it('reports a dash for non-finite values, never NaN text', () => {
    expect(formatForceValue(Number.NaN, 'N')).toBe('—');
    expect(formatSiMagnitude(Number.POSITIVE_INFINITY)).toBe('—');
  });
});

describe('buildForceChartOption', () => {
  it('plots [time, value] pairs on a value x-axis in simulation seconds', () => {
    const opt = buildForceChartOption(base);
    const series = (opt.series as any[])[0];
    expect(series.type).toBe('line');
    expect(series.symbol).toBe('none');
    expect(series.data).toEqual([[0.1, 10], [0.2, -48.2], [0.3, 21], [0.4, 5]]);
    expect((opt.xAxis as any).type).toBe('value');
    expect((opt.xAxis as any).name).toBe('t (s)');
  });

  it('never bridges a gap', () => {
    const opt = buildForceChartOption({ ...base, values: [10, Number.NaN, 21, 5] });
    const series = (opt.series as any[])[0];
    expect(series.connectNulls).toBe(false);
    expect(series.data[1]).toEqual([0.2, null]);
  });

  it('draws peak (both signs), RMS and holding as silent markLines', () => {
    const opt = buildForceChartOption(base);
    const lines = markLines(opt);
    expect((opt.series as any[])[0].markLine.silent).toBe(true);

    const peaks = lines.filter((l) => l.name === 'Peak');
    expect(peaks.map((l) => l.yAxis).sort((a, b) => a - b)).toEqual([-48.2, 48.2]);
    expect(peaks[0].lineStyle.color).toBe(FORCE_PEAK_COLOR);

    const rms = lines.find((l) => l.name === 'RMS');
    expect(rms.yAxis).toBe(21.7);
    expect(rms.lineStyle.color).toBe(FORCE_RMS_COLOR);

    const hold = lines.find((l) => l.name === 'Hold');
    expect(hold.yAxis).toBe(9.8);
    expect(hold.lineStyle.color).toBe(FORCE_HOLDING_COLOR);
  });

  it('labels the reference lines with the magnitude and the unit', () => {
    const lines = markLines(buildForceChartOption(base));
    const mirrored = lines.find((l) => l.name === 'Peak' && l.yAxis < 0);
    // The mirrored line must not read "Peak -48.2" — it is the same peak.
    expect(mirrored.label.formatter).toBe('Peak 48.2 N·m');
  });

  it('omits a reference line that has no value yet', () => {
    const lines = markLines(buildForceChartOption({
      ...base, peak: 0, rms: 0, holding: null,
    }));
    expect(lines).toHaveLength(0);
  });

  it('omits only the holding line when no statics was captured', () => {
    const lines = markLines(buildForceChartOption({ ...base, holding: null }));
    expect(lines.map((l) => l.name)).toEqual(['Peak', 'Peak', 'RMS']);
  });

  it('carries the unit into the title and the tooltip', () => {
    const opt = buildForceChartOption({ ...base, unit: 'N' });
    expect((opt.title as any).text).toBe('Lift axis (N)');
    expect((opt.tooltip as any).valueFormatter(3.14159)).toBe('3.14 N');
  });

  it('keeps the y-axis scaled to the data rather than pinned to zero', () => {
    // A drive that swings between 40 and 42 N·m must not render as a flat line
    // at the top of a 0..42 axis.
    expect((buildForceChartOption(base).yAxis as any).scale).toBe(true);
  });

  it('runs without animation — a 5 Hz refresh would never settle', () => {
    expect(buildForceChartOption(base).animation).toBe(false);
  });
});
