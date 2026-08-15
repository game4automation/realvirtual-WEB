// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * The multi-curve force chart: which curve lands on which axis.
 *
 * This is the arithmetic the panel gets wrong invisibly — a 200 N bearing load
 * sharing an axis with a 40 N·m torque flattens the torque into the baseline,
 * and the chart still looks plausible. Pin it without a browser.
 */

import { describe, it, expect } from 'vitest';
import { buildMultiForceChartOption } from '@rv-private/plugins/asset-editor/mechanism/mechanism-force-chart-options';

const times = [0, 0.1, 0.2];

function opt(series: { id: string; label: string; unit: string; values: number[] }[]) {
  return buildMultiForceChartOption({ times, series }) as {
    yAxis: { name: string; position: string }[];
    series: { name: string; yAxisIndex: number; data: [number, number | null][] }[];
    legend: { data: string[] };
  };
}

describe('buildMultiForceChartOption', () => {
  it('gives torques and forces their own axis', () => {
    const o = opt([
      { id: 'a', label: 'Arm 0 torque', unit: 'N·m', values: [1, 2, 3] },
      { id: 'b', label: 'Rod bearing', unit: 'N', values: [100, 200, 300] },
    ]);
    expect(o.yAxis.map((a) => a.name)).toEqual(['N·m', 'N']);
    expect(o.yAxis.map((a) => a.position)).toEqual(['left', 'right']);
    expect(o.series[0].yAxisIndex).toBe(0);
    expect(o.series[1].yAxisIndex).toBe(1);
  });

  it('shows only the axis it actually plots against', () => {
    const torquesOnly = opt([
      { id: 'a', label: 'Arm 0', unit: 'N·m', values: [1, 2, 3] },
      { id: 'b', label: 'Arm 1', unit: 'N·m', values: [2, 3, 4] },
    ]);
    expect(torquesOnly.yAxis).toHaveLength(1);
    expect(torquesOnly.yAxis[0].name).toBe('N·m');
    // Both curves share it — neither may point at a non-existent axis 1.
    expect(torquesOnly.series.every((s) => s.yAxisIndex === 0)).toBe(true);

    const forcesOnly = opt([{ id: 'f', label: 'Bearing', unit: 'N', values: [1, 2, 3] }]);
    expect(forcesOnly.yAxis).toHaveLength(1);
    expect(forcesOnly.yAxis[0].name).toBe('N');
    expect(forcesOnly.series[0].yAxisIndex).toBe(0);
  });

  it('plots every series and lists them all in the legend', () => {
    const o = opt([
      { id: 'a', label: 'Arm 0', unit: 'N·m', values: [1, 2, 3] },
      { id: 'b', label: 'Arm 1', unit: 'N·m', values: [4, 5, 6] },
      { id: 'c', label: 'Arm 2', unit: 'N·m', values: [7, 8, 9] },
    ]);
    expect(o.series).toHaveLength(3);
    expect(o.legend.data).toEqual(['Arm 0', 'Arm 1', 'Arm 2']);
  });

  it('keeps gaps as gaps rather than bridging them', () => {
    const o = opt([{ id: 'a', label: 'Arm 0', unit: 'N·m', values: [1, NaN, 3] }]);
    expect(o.series[0].data.map((p) => p[1])).toEqual([1, null, 3]);
  });
});
