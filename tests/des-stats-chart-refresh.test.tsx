// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2030 F4 — the refresh tick must not rebuild the static chart options (a notMerge
 * setOption wipes an open axis tooltip). Static parts once per chart instance; per tick only
 * categories + series in merge mode; registered DES states rebuild legend + series together.
 *
 * The echarts instance is faked: the tooltip lives in the real chart's component model, which
 * a merge setOption leaves alone and a notMerge one rebuilds. The contract asserted here is
 * therefore "no tick carries tooltip/grid/axis styles or notMerge".
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { act, cleanup, render, fireEvent, screen } from '@testing-library/react';
import { chartMock, makeRunner, makeViewer, flush, chartReady } from './helpers/des-stats-chart-fixture';
import { commandRegistry } from '../src/core/hmi/rv-command-registry';
import { ensureDesRunCommandsRegistered } from '../src/core/hmi/des-run-commands';
import { getDesStatsHiddenKinds, setDesStatsHiddenKinds, setDesStatsWindowOpen } from '../src/plugins/sim-controller/des-stats-window-store';

vi.mock('../src/core/hmi/echarts-setup', () => ({ echarts: { init: () => chartMock.create() } }));

const { DESUtilizationBody } = await import('../src/plugins/des/hmi/DESStatsChart');
const { registerDesState } = await import('../src/plugins/des/hmi/des-stat-colors');

const resetStores = () => { setDesStatsWindowOpen(false); setDesStatsHiddenKinds([]); };
beforeEach(() => { chartMock.reset(); resetStores(); });
afterEach(() => { cleanup(); chartMock.reset(); resetStores(); });

// Wall-clock ticks (500 ms) + lazy echarts chunk: generous under machine load.
vi.setConfig({ testTimeout: 60_000 });

const hasStatic = (o: any) => 'tooltip' in o || 'grid' in o || 'yAxis' in o;

describe('DESUtilizationBody refresh (merge mode)', () => {
  it('announces missing series data instead of displaying bare axes', async () => {
    render(<DESUtilizationBody viewer={makeViewer(makeRunner([]))} active />);
    await chartReady();
    expect(screen.getByRole('status').textContent).toBe('No values yet — start the simulation to collect statistics.');
  });

  it('labels the kind group and exposes included state and the all-hidden status', async () => {
    render(<DESUtilizationBody viewer={makeViewer(makeRunner(['A', 'B'], n => n === 'A' ? 'source' : 'sink'))} active />);
    await chartReady();
    // The chips appear with the first refresh that discovers the kinds.
    expect(await screen.findByRole('group', { name: 'Component types' })).toBeTruthy();
    for (const kind of ['source', 'sink']) {
      const chip = screen.getByRole('button', { name: kind });
      expect(chip.getAttribute('aria-pressed')).toBe('true');
      fireEvent.click(chip);
      expect(chip.getAttribute('aria-pressed')).toBe('false');
    }
    expect(screen.getByRole('status').textContent).toBe('All component types are hidden.');
  });
  it('reflects command-driven hidden kinds in the mounted chips and chart rows', async () => {
    ensureDesRunCommandsRegistered();
    const runner = makeRunner(['Source', 'Station', 'Sink'], name => name === 'Station' ? 'station' : name.toLowerCase());
    const viewer = makeViewer(runner);
    viewer.simulationKernel.desControl = () => runner;
    render(<DESUtilizationBody viewer={viewer} active={true} />);
    const chart = await chartReady();
    await act(async () => {
      expect(await commandRegistry.execute('des.stats.window', {
        open: true, hiddenKinds: ['source', 'sink'],
      }, { origin: 'ui', viewer })).toMatchObject({ ok: true });
    });
    expect([...getDesStatsHiddenKinds()]).toEqual(['source', 'sink']);
    for (const kind of ['source', 'sink']) {
      expect(screen.getByText(kind).closest('.MuiChip-root')?.classList.contains('MuiChip-outlined')).toBe(true);
    }
    expect(screen.getByText('station').closest('.MuiChip-root')?.classList.contains('MuiChip-filled')).toBe(true);
    await vi.waitFor(() => expect(chart.calls.at(-1)!.opt.xAxis.data).toEqual(['Station']), { timeout: 15000, interval: 50 });
  });

  it('sets tooltip/grid/axes once, then only xAxis + series per tick without notMerge', async () => {
    const viewer = makeViewer(makeRunner(['A', 'B']));
    render(<DESUtilizationBody viewer={viewer} active={true} />);
    const chart = await chartReady();
    expect(chart.calls.length).toBeGreaterThanOrEqual(1);
    expect(hasStatic(chart.calls[0].opt)).toBe(true);
    expect(chart.calls[0].flags?.notMerge).toBe(true);

    const before = chart.calls.length;
    await vi.waitFor(() => expect(chart.calls.length - before).toBeGreaterThanOrEqual(2), { timeout: 15000, interval: 50 }); // two or more 500 ms ticks
    const ticks = chart.calls.slice(before);
    expect(ticks.length).toBeGreaterThanOrEqual(2);
    for (const t of ticks) {
      expect(hasStatic(t.opt)).toBe(false);
      expect(t.flags?.notMerge).toBeFalsy();
      expect(Object.keys(t.opt).sort()).toEqual(['series', 'xAxis']);
    }
    // The tooltip formatter reads the live rows, not a stale closure.
    const fmt = chart.calls[0].opt.tooltip.formatter as (p: unknown) => string;
    expect(fmt([{ dataIndex: 1 }])).toContain('B');
  });

  it('a kind filter change alters only the categories, not the series set', async () => {
    const viewer = makeViewer(makeRunner(['A', 'V'], (n) => (n === 'V' ? 'vehicle' : 'conveyor')));
    render(<DESUtilizationBody viewer={viewer} active={true} />);
    const chart = await chartReady();
    fireEvent.click(await screen.findByText('vehicle'));
    const before = chart.calls.length;
    await vi.waitFor(() => {
      expect(chart.calls.length).toBeGreaterThan(before);
      expect(chart.calls.at(-1)!.opt.xAxis.data).toEqual(['A']);
    }, { timeout: 15000, interval: 50 });
    const t = chart.calls.slice(before).at(-1)!;
    expect(t.flags?.replaceMerge).toBeUndefined();
    expect(t.opt.series.length).toBe(chart.calls[0].opt.series.length);
  });

  it('a state registered while open rebuilds legend + series with replaceMerge', async () => {
    const viewer = makeViewer(makeRunner(['A']));
    render(<DESUtilizationBody viewer={viewer} active={true} />);
    const chart = await chartReady();
    const base = chart.calls[0].opt.series.length;
    let unregister: () => void = () => {};
    act(() => { unregister = registerDesState({ name: 'Plan2030Test', color: '#123456' }); });
    await vi.waitFor(() => expect(chart.calls.find((c) => c.flags?.replaceMerge)).toBeTruthy(), { timeout: 15000, interval: 50 });
    const rebuild = chart.calls.find((c) => c.flags?.replaceMerge);
    expect(rebuild!.flags.replaceMerge).toEqual(['series']);
    expect(rebuild!.opt.series.length).toBe(base + 1);
    expect(rebuild!.opt.legend.data).toContain('Plan2030Test');

    act(() => unregister());
    await vi.waitFor(() => expect(chart.calls.filter((c) => c.flags?.replaceMerge).at(-1)!.opt.series.length).toBe(base), { timeout: 15000, interval: 50 });
    const last = chart.calls.filter((c) => c.flags?.replaceMerge).at(-1)!;
    expect(last.opt.series.length).toBe(base);
    expect(last.opt.legend.data).not.toContain('Plan2030Test');
  });

  it('an inactive tab stops refreshing until it becomes active again', async () => {
    const viewer = makeViewer(makeRunner(['A']));
    const r = render(<DESUtilizationBody viewer={viewer} active={true} />);
    const chart = await chartReady();
    r.rerender(<DESUtilizationBody viewer={viewer} active={false} />);
    const calls = chart.calls.length;
    await flush(1100);
    expect(chart.calls).toHaveLength(calls);
  });

  it('close + reopen creates a new chart instance with the static options again', async () => {
    const viewer = makeViewer(makeRunner(['A']));
    const r = render(<DESUtilizationBody viewer={viewer} active={true} />);
    const first = await chartReady();
    r.rerender(<DESUtilizationBody viewer={viewer} active={false} />);
    r.rerender(<DESUtilizationBody viewer={viewer} active={true} />);
    await vi.waitFor(() => expect(chartMock.charts.length).toBeGreaterThanOrEqual(2), { timeout: 15000, interval: 50 });
    const second = await chartReady();
    expect(second).not.toBe(first);
    expect(hasStatic(second.calls[0].opt)).toBe(true);
  });
});
