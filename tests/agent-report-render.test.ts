// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it } from 'vitest';
import { agentChartToRenderModel } from '../src/plugins/agents/agent-report';

describe('agent report chart mapping', () => {
  it('maps a validated line spec to the shared ECharts shape', () => {
    const model = agentChartToRenderModel({
      type: 'line',
      title: 'Availability',
      labels: ['Mon', 'Tue'],
      series: [{ name: 'OEE', data: [91.2, 92.4] }],
    });
    expect(model.kind).toBe('echarts');
    expect((model.option?.xAxis as { data: string[] }).data).toEqual(['Mon', 'Tue']);
    expect((model.option?.series as Array<{ type: string; data: number[] }>)[0]).toMatchObject({
      type: 'line', data: [91.2, 92.4],
    });
  });

  it('falls back to a table for unknown chart types', () => {
    const model = agentChartToRenderModel({ type: 'radar-3d', secret: 'value' });
    expect(model.kind).toBe('table');
    expect(model.table?.columns).toEqual(['Field', 'Value']);
    expect(model.warnings.join(' ')).toContain('Unsupported chart type');
  });
});
