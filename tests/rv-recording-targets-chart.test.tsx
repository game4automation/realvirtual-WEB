// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { chartMock, chartReady, makeRunner, makeViewer } from './helpers/des-stats-chart-fixture';
import { installRecordingSeam } from '../src/core/engine/rv-recording-targets';
import { setDesStatsHiddenKinds, setDesStatsWindowOpen } from '../src/plugins/sim-controller/des-stats-window-store';

vi.mock('../src/core/hmi/echarts-setup', () => ({
  echarts: {
    init: (container: HTMLElement) => {
      container.dataset.recordingChart = 'true';
      return chartMock.create();
    },
  },
}));

const { DESUtilizationBody } = await import('../src/plugins/des/hmi/DESStatsChart');

// Match the refresh suite's allowance for lazy chart loading and wall-clock ticks.
vi.setConfig({ testTimeout: 60_000 });
const polling = { timeout: 15000, interval: 50 };
let originalUrl: string;
let originalHistoryState: unknown;
const resetStores = () => { setDesStatsWindowOpen(false); setDesStatsHiddenKinds([]); };

beforeEach(() => {
  originalUrl = window.location.href;
  originalHistoryState = window.history.state;
  const url = new URL(originalUrl);
  url.searchParams.set('recording', '1');
  window.history.replaceState(originalHistoryState, '', url);
  delete window.__rvRecording;
  chartMock.reset();
  resetStores();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  chartMock.reset();
  resetStores();
  delete window.__rvRecording;
  window.history.replaceState(originalHistoryState, '', originalUrl);
});

async function openChart() {
  const viewer = makeViewer(makeRunner(['Source', 'Station'], name => name === 'Source' ? 'source' : 'station'));
  await installRecordingSeam(viewer);
  expect(window.__rvRecording).toBeDefined();
  const seam = window.__rvRecording!;
  render(<DESUtilizationBody viewer={viewer} active={true} />);
  const chart = await chartReady();
  const container = document.querySelector<HTMLElement>('[data-recording-chart="true"]');
  expect(container).not.toBeNull();
  let rect = new DOMRect(100, 50, 520, 300);
  vi.spyOn(container!, 'getBoundingClientRect').mockImplementation(() => rect);
  vi.spyOn(container!, 'getClientRects').mockImplementation(() => ({
    0: rect, length: 1, item: (index: number) => index === 0 ? rect : null,
    [Symbol.iterator]: function* () { yield rect; },
  } as DOMRectList));
  await vi.waitFor(() => {
    expect(chart.getOption().xAxis[0].data).toEqual(['Source', 'Station']);
    expect(seam.target('des-stats-bar', 'Station')).not.toBeNull();
  }, polling);
  return {
    chart, seam,
    setRect: (r: DOMRect) => { rect = r; },
    move: () => { rect = new DOMRect(rect.x + 30, rect.y + 20, rect.width, rect.height); },
  };
}

describe('DES stats recording target', () => {
  it('Test_StatsTarget_ReadyChart_ReturnsBarCenterWithContainerOffset', async () => {
    const { seam } = await openChart();
    const point = seam.target('des-stats-bar', 'Station');
    expect(Number.isFinite(point?.x)).toBe(true);
    expect(Number.isFinite(point?.y)).toBe(true);
    // Station is category 1; the 40% working + 10% blocked stack has midpoint 25.
    expect(point).toEqual({ x: 100 + 90, y: 50 + 60 });
    expect(seam.target('des-stats-bar', 'Yard/Station')).toEqual(point);
  });

  it('Test_StatsTarget_OffsetPanel_PointInsideBarPixelRect', async () => {
    const { chart, seam, setRect } = await openChart();
    setRect(new DOMRect(72, 400, 520, 300));
    const point = seam.target('des-stats-bar', 'Station')!;
    const cx = chart.convertToPixel({ xAxisIndex: 0 }, 1);
    const yBottom = chart.convertToPixel({ yAxisIndex: 0 }, 0);
    const yTop = chart.convertToPixel({ yAxisIndex: 0 }, 50); // 40% working + 10% blocked
    expect(point.x - 72).toBeCloseTo(cx, 5);
    expect(point.y - 400).toBeGreaterThanOrEqual(Math.min(yBottom, yTop));
    expect(point.y - 400).toBeLessThanOrEqual(Math.max(yBottom, yTop));
  });

  it('Test_StatsTarget_FilterChange_UsesNewSlotAndHidesFilteredRow', async () => {
    const { chart, seam } = await openChart();
    const before = seam.target('des-stats-bar', 'Station')!;
    expect(seam.target('des-stats-bar', 'Source')).not.toBeNull();
    const callsBefore = chart.calls.length;
    act(() => setDesStatsHiddenKinds(['source']));
    await vi.waitFor(() => {
      expect(chart.calls.length).toBeGreaterThan(callsBefore);
      expect(chart.getOption().xAxis[0].data).toEqual(['Station']);
      expect(seam.target('des-stats-bar', 'Station')).toEqual({ x: before.x - 40, y: before.y });
      expect(seam.target('des-stats-bar', 'Source')).toBeNull();
      expect(seam.target('des-stats-bar', 'Yard/Source')).toBeNull();
    }, polling);
  });

  it('Test_StatsTarget_PanelMoves_ResolvesCurrentContainerOffset', async () => {
    const { seam, move } = await openChart();
    const before = seam.target('des-stats-bar', 'Station')!;
    move();
    expect(seam.target('des-stats-bar', 'Station')).toEqual({ x: before.x + 30, y: before.y + 20 });
  });

  it('Test_StatsTarget_Unmount_UnregistersResolver', async () => {
    const { seam } = await openChart();
    expect(seam.target('des-stats-bar', 'Station')).not.toBeNull();
    cleanup();
    expect(seam.target('des-stats-bar', 'Station')).toBeNull();
  });
});
