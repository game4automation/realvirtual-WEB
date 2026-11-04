// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { Scene } from 'three';
import type { RVViewer } from '../../src/core/rv-viewer';
import { parsePathExtras } from '../../src/core/engine/rv-path';
import { getDefaultPathNetwork } from '../../src/core/engine/rv-path-network';
import { PathTracePlugin } from '../../src/plugins/path-trace-plugin';
import PathTrafficSection from '../../src/plugins/path-trace/PathTrafficSection';
import { StatsRegistry } from '../../src/core/stats/rv-stats-registry';
import { StatsHubButton } from '../../src/core/stats/StatsHubButton';
import { StatsHubWindow } from '../../src/core/stats/StatsHubWindow';
import { closeStatsHub, isStatsHubOpen, openStatsHub, resetStatsHubStore } from '../../src/core/stats/stats-hub-store';
import { isOverlayVisible, resetOverlayProducers, setOverlayVisible } from '../../src/core/overlay-visibility-store';
import { getTraceSettings, resetTraceSettings, setTraceLegend, setTracePreset } from '../../src/core/trace-settings-store';
import { clearShared } from '../helpers/agv-harness';

let plugin: PathTracePlugin;
let viewer: RVViewer;
function addPath() {
  getDefaultPathNetwork().register(parsePathExtras({
    type: 'Path', version: 1, id: 'A', closed: false, align: [0, 1, 0], successors: [],
    segments: [{ kind: 'line', from: [0, 0, 0], to: [24, 0, 0] }],
  }, 'A')!);
}
function populate() {
  addPath();
  plugin.poll();
  plugin.trace.advanceTo(2, (_time, sink) => sink.cover(0, 0, 24, true));
}

beforeEach(() => {
  clearShared();
  localStorage.clear();
  resetStatsHubStore();
  resetTraceSettings();
  resetOverlayProducers();
  setOverlayVisible('trace-blocked', false);
  setOverlayVisible('trace-utilization', false);
  plugin = new PathTracePlugin();
  viewer = {
    scene: new Scene(), stats: new StatsRegistry(), markRenderDirty() {},
    getPlugin: (id: string) => id === 'path-trace' ? plugin : undefined,
  } as unknown as RVViewer;
  plugin.init(viewer);
});
afterEach(() => {
  cleanup();
  plugin.dispose();
  closeStatsHub();
  clearShared();
  resetOverlayProducers();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('Path traffic statistics', () => {
  it('announces an empty view once without table headers or the old No data legend', () => {
    setOverlayVisible('trace-blocked', true);
    render(<PathTrafficSection viewer={viewer} active />);
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(screen.getByRole('status').textContent).toBe('No traffic recorded in this time range yet.');
    expect(screen.queryByRole('columnheader')).toBeNull();
    expect(screen.queryByText('No data')).toBeNull();
  });
  it('updates closed-window availability through render polling, clear and disposal', () => {
    vi.useFakeTimers({ toFake: ['performance'] });
    render(<StatsHubButton viewer={viewer} />);
    const button = () => screen.queryByRole('button', { name: 'Statistics' });
    expect(isStatsHubOpen()).toBe(false);
    expect(button()).toBeNull();
    act(() => plugin.onRender());
    const emptyVersion = viewer.stats.getSnapshot();
    act(() => { addPath(); vi.advanceTimersByTime(501); plugin.onRender(); });
    expect(button()).toBeTruthy();
    expect(viewer.stats.getSnapshot()).toBe(emptyVersion + 1);
    const availableVersion = viewer.stats.getSnapshot();
    act(() => { vi.advanceTimersByTime(501); plugin.onRender(); });
    expect(viewer.stats.getSnapshot()).toBe(availableVersion);
    act(() => { getDefaultPathNetwork().unregister('A'); vi.advanceTimersByTime(501); plugin.onRender(); });
    expect(button()).toBeNull();
    act(() => { addPath(); vi.advanceTimersByTime(501); plugin.onRender(); });
    expect(button()).toBeTruthy();
    act(() => plugin.onModelCleared());
    expect(button()).toBeNull();
    expect(isStatsHubOpen()).toBe(false);
    expect(viewer.stats.list().map(s => s.id)).toEqual(['path.traffic']);
    act(() => plugin.dispose());
    expect(viewer.stats.list()).toEqual([]);
  });

  it('binds hub switches, range chips and live legends to the existing stores', async () => {
    populate();
    expect(viewer.stats.available().map(s => s.id)).toEqual(['path.traffic']);
    expect(viewer.stats.list()[0].settings?.every(s => s.persist === false)).toBe(true);
    openStatsHub('path.traffic');
    render(<StatsHubWindow viewer={viewer} />);
    await screen.findByTestId('trace-range-hour', {}, { timeout: 30_000 });
    fireEvent.click(screen.getByRole('switch', { name: 'Blocked share' }));
    fireEvent.click(screen.getByRole('switch', { name: 'Utilization' }));
    expect(isOverlayVisible('trace-blocked')).toBe(true);
    expect(isOverlayVisible('trace-utilization')).toBe(true);
    act(() => { setTraceLegend('blocked', 0.125, 0.5); setTraceLegend('utilization', 0.25, 1); });
    expect(screen.getByTestId('trace-legend-blocked').textContent).toContain('12.5 %');
    expect(screen.getByTestId('trace-legend-blocked').textContent).toContain('50.0 %');
    expect(screen.getByTestId('trace-legend-utilization').textContent).toContain('25.0 %');
    expect(screen.getByTestId('trace-legend-utilization').textContent).toContain('100.0 %');
    fireEvent.click(screen.getByRole('button', { name: 'Last day' }));
    expect(getTraceSettings()).toMatchObject({ range: 'window', windowSec: 86400 });
    expect(plugin.trace.windowSec).toBe(86400);
    fireEvent.click(screen.getByRole('button', { name: 'Since start' }));
    expect(getTraceSettings().range).toBe('start');
    act(() => setTracePreset('hour'));
    expect(screen.getByTestId('trace-range-hour').getAttribute('aria-pressed')).toBe('true');
    act(() => setOverlayVisible('trace-blocked', false));
    expect((screen.getByRole('switch', { name: 'Blocked share' }) as HTMLInputElement).checked).toBe(false);
    expect(screen.queryByTestId('trace-legend-blocked')).toBeNull();
    expect(screen.queryByRole('table', { name: 'Blocked share top 10' })).toBeNull();
    expect(screen.queryByRole('switch', { name: 'Group rows' })).toBeNull();
    const persisted = JSON.parse(localStorage.getItem('rv-stats-hub') ?? '{}');
    expect(persisted.settings ?? {}).not.toHaveProperty('path.trace.blocked');
    expect(persisted.settings ?? {}).not.toHaveProperty('path.trace.utilization');
  });

  it('polls only visible views at 1 Hz while active, reusing output arrays and displaying percentages', () => {
    vi.useFakeTimers();
    populate();
    setOverlayVisible('trace-blocked', true);
    const top = vi.spyOn(plugin.trace, 'topN');
    const mounted = render(<PathTrafficSection viewer={viewer} active={false} />);
    act(() => vi.advanceTimersByTime(2000));
    expect(top).not.toHaveBeenCalled();
    mounted.rerender(<PathTrafficSection viewer={viewer} active />);
    expect(top).toHaveBeenCalledTimes(1);
    expect(top.mock.calls[0].slice(0, 3)).toEqual(['blocked', 'window', 10]);
    const out = top.mock.calls[0][3];
    const table = screen.getByRole('table', { name: 'Blocked share top 10' });
    expect(within(table).getAllByRole('row')).toHaveLength(11);
    // Section bounds show one decimal — curve buckets are arc lengths like 2.35619449019 m.
    expect(within(table).getByText('0.0–2.0 m')).toBeTruthy();
    expect(within(table).getAllByText('100.0 %')).toHaveLength(10);
    expect(screen.queryByRole('table', { name: 'Utilization top 10' })).toBeNull();
    act(() => vi.advanceTimersByTime(999));
    expect(top).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(1));
    expect(top).toHaveBeenCalledTimes(2);
    expect(top.mock.calls[1][3]).toBe(out);
    act(() => setTracePreset('total'));
    expect(top.mock.lastCall?.slice(0, 3)).toEqual(['blocked', 'start', 10]);
    act(() => setOverlayVisible('trace-utilization', true));
    expect(top.mock.lastCall?.slice(0, 3)).toEqual(['utilization', 'start', 10]);
    const utilizationOut = top.mock.lastCall![3];
    expect(utilizationOut).not.toBe(out);
    act(() => vi.advanceTimersByTime(1000));
    expect(top.mock.lastCall![3]).toBe(utilizationOut);
    act(() => { setOverlayVisible('trace-blocked', false); setOverlayVisible('trace-utilization', false); });
    const hiddenCount = top.mock.calls.length;
    act(() => vi.advanceTimersByTime(2000));
    expect(top).toHaveBeenCalledTimes(hiddenCount);
    act(() => setOverlayVisible('trace-blocked', true));
    mounted.rerender(<PathTrafficSection viewer={viewer} active={false} />);
    const count = top.mock.calls.length;
    act(() => vi.advanceTimersByTime(3000));
    expect(top).toHaveBeenCalledTimes(count);
    mounted.unmount();
    act(() => vi.advanceTimersByTime(2000));
    expect(top).toHaveBeenCalledTimes(count);
  });

  it('stops topN when the hub switches tabs or closes', async () => {
    populate();
    setOverlayVisible('trace-blocked', true);
    viewer.stats.register({ id: 'other', title: 'Other statistics', order: 30, rows: () => [] });
    openStatsHub('path.traffic');
    render(<StatsHubWindow viewer={viewer} />);
    await screen.findByRole('table', { name: 'Blocked share top 10' }, { timeout: 30_000 });
    // Switch away before installing fake timers so no real interval survives.
    fireEvent.click(screen.getByRole('tab', { name: 'Other statistics' }));
    vi.useFakeTimers();
    const top = vi.spyOn(plugin.trace, 'topN');
    act(() => vi.advanceTimersByTime(2000));
    expect(top).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('tab', { name: 'Path traffic' }));
    expect(top).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(1000));
    expect(top).toHaveBeenCalledTimes(2);
    act(() => closeStatsHub());
    act(() => vi.advanceTimersByTime(3000));
    expect(top).toHaveBeenCalledTimes(2);
  });
});
