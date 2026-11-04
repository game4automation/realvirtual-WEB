// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2030 F2 — a click on a stats bar selects the component through the viewer's
 * SelectionManager; closing the window clears only a selection the chart made itself.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { chartMock, makeRunner, makeViewer, flush, chartReady } from './helpers/des-stats-chart-fixture';

vi.mock('../src/core/hmi/echarts-setup', () => ({ echarts: { init: () => chartMock.create() } }));

const { DESUtilizationBody } = await import('../src/plugins/des/hmi/DESStatsChart');

afterEach(() => { cleanup(); chartMock.reset(); });

async function open(viewer: any) {
  const r = render(<DESUtilizationBody viewer={viewer} active={true} />);
  await chartReady();
  return r;
}

describe('DESUtilizationBody selection', () => {
  it('click on a bar selects row.path via the selection manager', async () => {
    const viewer = makeViewer(makeRunner(['A', 'B']));
    await open(viewer);
    act(() => chartMock.last().emit('click', { dataIndex: 1 }));
    expect(viewer.selectionManager.selectedPaths).toEqual(['Yard/B']);
  });

  it('closing clears the selection the chart made', async () => {
    const viewer = makeViewer(makeRunner(['A', 'B']));
    const r = await open(viewer);
    act(() => chartMock.last().emit('click', { dataIndex: 0 }));
    r.rerender(<DESUtilizationBody viewer={viewer} active={false} />);
    expect(viewer.selectionManager.selectedPaths).toEqual([]);
  });

  it('closing keeps a foreign selection', async () => {
    const viewer = makeViewer(makeRunner(['A', 'B']));
    const r = await open(viewer);
    act(() => chartMock.last().emit('click', { dataIndex: 0 }));
    viewer.selectionManager.select('Somewhere/Else');
    r.rerender(<DESUtilizationBody viewer={viewer} active={false} />);
    expect(viewer.selectionManager.selectedPaths).toEqual(['Somewhere/Else']);
  });

  it('A(chart) -> B(viewer) -> A(viewer) -> close keeps A', async () => {
    const viewer = makeViewer(makeRunner(['A', 'B']));
    const r = await open(viewer);
    act(() => chartMock.last().emit('click', { dataIndex: 0 }));
    viewer.selectionManager.select('Yard/B');
    viewer.selectionManager.select('Yard/A');
    r.rerender(<DESUtilizationBody viewer={viewer} active={false} />);
    expect(viewer.selectionManager.selectedPaths).toEqual(['Yard/A']);
  });

  it('unmounting the hub body clears owned selection, hover, and the chart instance', async () => {
    const viewer = makeViewer(makeRunner(['A']));
    const clear = vi.spyOn(viewer.highlighter, 'clear');
    const r = await open(viewer);
    const chart = chartMock.last();
    const dispose = vi.spyOn(chart, 'dispose');
    act(() => {
      chart.emit('mouseover', { dataIndex: 0 });
      chart.emit('click', { dataIndex: 0 });
    });
    r.unmount();
    expect(clear).toHaveBeenCalled();
    expect(viewer.selectionManager.selectedPaths).toEqual([]);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('the selectNode prop stays an override', async () => {
    const viewer = makeViewer(makeRunner(['A']));
    const selectNode = vi.fn();
    render(<DESUtilizationBody viewer={viewer} active={true} selectNode={selectNode} />);
    await chartReady();
    act(() => chartMock.last().emit('click', { dataIndex: 0 }));
    expect(selectNode).toHaveBeenCalled();
    expect(viewer.selectionManager.selectedPaths).toEqual([]);
  });
});
