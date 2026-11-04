// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/** Browser contract for the statistics hub, using the real floating panel. */
import { useEffect } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { ThemeProvider } from '@mui/material/styles';
import type { RVViewer } from '../src/core/rv-viewer';
import { rvDarkTheme } from '../src/core/hmi/theme';
import { _resetStore as resetUIContext } from '../src/core/hmi/ui-context-store';
import { clearAllRVStorage, STATS_HUB_KEY } from '../src/core/hmi/rv-storage-keys';
import { StatsRegistry, type StatsSectionBodyProps, type StatsSectionSpec } from '../src/core/stats/rv-stats-registry';
import { StatsHubPlugin } from '../src/core/stats/stats-hub-plugin';
import {
  closeStatsHub, getStatsHubSnapshot, isStatsHubOpen, openStatsHub, resetStatsHubStore,
} from '../src/core/stats/stats-hub-store';

const section = (id: string, extra: Partial<StatsSectionSpec> = {}): StatsSectionSpec => ({
  id, title: `Section ${id}`, rows: () => [{ key: id, label: `Row ${id}`, value: 12.4, unit: 's' }], ...extra,
});
function source() {
  let available = true;
  const listeners = new Set<() => void>();
  return {
    isAvailable: () => available,
    subscribe: (cb: () => void) => { listeners.add(cb); return () => { listeners.delete(cb); }; },
    emit: (value: boolean) => act(() => { available = value; for (const cb of listeners) cb(); }),
  };
}
function mount(stats = new StatsRegistry()) {
  const viewer = { stats } as RVViewer;
  const plugin = new StatsHubPlugin();
  const rendered = render(<ThemeProvider theme={rvDarkTheme}>
    {plugin.slots.map(({ component: Component, slot }) => <Component key={slot} viewer={viewer} />)}
  </ThemeProvider>);
  return { stats, ...rendered };
}
function persisted() { return JSON.parse(localStorage.getItem(STATS_HUB_KEY) ?? '{}'); }

const windowChunkRequested = (): boolean => performance.getEntriesByType('resource')
  .some(entry => entry.name.includes('/src/core/stats/StatsHubWindow'));

// The window is a lazy chunk. Resolve it once, so every test below can query the
// open panel synchronously — a `React.lazy` that has resolved stays resolved for the
// module's lifetime. The first assertion is the reason the chunk is lazy at all.
beforeAll(async () => {
  expect(windowChunkRequested(), 'the window chunk loads before the first open').toBe(false);
  localStorage.clear();
  resetStatsHubStore();
  resetUIContext();
  const stats = new StatsRegistry();
  stats.register(section('warmup'));
  mount(stats);
  act(() => openStatsHub());
  // The first import is a cold module transform in the test runner, not a cached chunk.
  await screen.findByRole('table', {}, { timeout: 30_000 });
  expect(windowChunkRequested()).toBe(true);
  cleanup();
  closeStatsHub();
  localStorage.clear();
});
beforeEach(() => {
  localStorage.clear();
  resetStatsHubStore();
  resetUIContext();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  localStorage.clear();
  resetStatsHubStore();
});

describe('Statistics hub', () => {
  it('announces empty rows without table headers in the named region', () => {
    const stats = new StatsRegistry();
    stats.register(section('empty', { rows: () => [] }));
    mount(stats);
    act(() => openStatsHub());
    const region = screen.getByRole('region', { name: 'Statistics' });
    expect(within(region).getByRole('status').textContent).toBe('No values yet — start the simulation to collect statistics.');
    expect(within(region).queryByRole('columnheader')).toBeNull();
  });

  it('restores focus from a removed tab to the selected tab, then to the sole panel', () => {
    const stats = new StatsRegistry();
    const a = source(); const b = source(); const c = source();
    stats.register(section('a', a)); stats.register(section('b', b)); stats.register(section('c', c));
    mount(stats);
    act(() => openStatsHub('b'));
    act(() => screen.getByRole('tab', { name: 'Section b' }).focus());
    b.emit(false);
    const next = screen.getByRole('tab', { name: 'Section c' });
    expect(next.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(next);
    c.emit(false);
    expect(document.activeElement).toBe(screen.getByRole('tabpanel', { name: 'Section a' }));
  });

  it('does not move focus from outside the window when a tab disappears', () => {
    const stats = new StatsRegistry();
    const b = source();
    stats.register(section('a')); stats.register(section('b', b));
    mount(stats);
    act(() => openStatsHub('b'));
    const outside = screen.getByRole('button', { name: 'Statistics' });
    act(() => outside.focus());
    b.emit(false);
    expect(document.activeElement).toBe(outside);
  });
  it('hides without available sections, reacts to registration, and contributes the analysis button and overlay', () => {
    const { stats } = mount();
    expect(screen.queryByRole('button', { name: 'Statistics' })).toBeNull();
    act(() => { stats.register(section('hidden', { isAvailable: () => false })); });
    expect(screen.queryByRole('button', { name: 'Statistics' })).toBeNull();
    act(() => { stats.register(section('a')); });
    expect(screen.getByRole('button', { name: 'Statistics' })).toBeTruthy();
    const slots = new StatsHubPlugin().slots;
    expect(slots.find(s => s.slot === 'button-group')).toMatchObject({ order: 50, group: 'analysis', visibilityRule: {} });
    expect(slots.some(s => s.slot === 'overlay')).toBe(true);
  });

  it('opens and toggles the real panel, showing ordered tabs only for multiple sections', () => {
    const stats = new StatsRegistry();
    stats.register(section('a', { order: 20 }));
    mount(stats);
    const button = screen.getByRole('button', { name: 'Statistics' });
    expect(button.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(button);
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(document.querySelector('[data-ui-panel]')).toBeTruthy();
    expect(screen.getByText('Statistics')).toBeTruthy();
    expect(screen.queryByRole('tablist')).toBeNull();
    act(() => { stats.register(section('b', { order: 10 })); });
    expect(screen.getAllByRole('tab').map(tab => tab.textContent)).toEqual(['Section b', 'Section a']);
    fireEvent.click(button);
    expect(isStatsHubOpen()).toBe(false);
    expect(document.querySelector('[data-ui-panel]')).toBeNull();
  });

  it('formats numbers, strings and null values and persists grouping with an Ungrouped heading', () => {
    const stats = new StatsRegistry();
    stats.register(section('a', { rows: () => [
      { key: 'cycle', label: 'Cycle time', value: 0.1 + 0.2, unit: 's', group: 'Cell A' },
      { key: 'state', label: 'State', value: 'Ready', group: 'Cell B' },
      { key: 'unknown', label: 'Unknown', value: null },
    ] }));
    mount(stats);
    act(() => openStatsHub());
    const table = screen.getByRole('table');
    expect(within(table).getByText('Cycle time')).toBeTruthy();
    expect(within(table).getByText('0.3')).toBeTruthy();
    expect(within(table).getByText('s')).toBeTruthy();
    expect(within(table).getByText('Ready')).toBeTruthy();
    expect(within(table).getByText('—')).toBeTruthy();
    expect(screen.queryByText('Cell A')).toBeNull();
    fireEvent.click(screen.getByRole('switch', { name: 'Group rows' }));
    expect(screen.getByText('Cell A')).toBeTruthy();
    expect(screen.getByText('Cell B')).toBeTruthy();
    expect(screen.getByText('Ungrouped')).toBeTruthy();
    expect(persisted().groupBy.a).toBe(true);
    cleanup();
    resetStatsHubStore();
    mount(stats);
    act(() => openStatsHub());
    expect((screen.getByRole('switch', { name: 'Group rows' }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText('Ungrouped')).toBeTruthy();
  });

  it('polls at 1 Hz only while open on the active rows tab, and clears on tab change, close and unmount', () => {
    vi.useFakeTimers();
    const a = vi.fn(() => [{ key: 'a', label: 'Row a', value: 1 }]);
    const b = vi.fn(() => []);
    const stats = new StatsRegistry();
    stats.register(section('a', { rows: a }));
    stats.register(section('b', { rows: b }));
    const mounted = mount(stats);
    act(() => { vi.advanceTimersByTime(3000); });
    expect(a).not.toHaveBeenCalled();
    expect(b).not.toHaveBeenCalled();
    act(() => openStatsHub('a'));
    expect(a).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('switch', { name: 'Group rows' })).toBeNull();
    act(() => { vi.advanceTimersByTime(999); });
    expect(a).toHaveBeenCalledTimes(1);
    act(() => { vi.advanceTimersByTime(2001); });
    expect(a).toHaveBeenCalledTimes(4);
    expect(b).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('tab', { name: 'Section b' }));
    expect(b).toHaveBeenCalledTimes(1);
    act(() => { vi.advanceTimersByTime(2000); });
    expect(a).toHaveBeenCalledTimes(4);
    expect(b).toHaveBeenCalledTimes(3);
    act(() => closeStatsHub());
    act(() => { vi.advanceTimersByTime(3000); });
    expect(b).toHaveBeenCalledTimes(3);
    act(() => openStatsHub('a'));
    expect(a).toHaveBeenCalledTimes(5);
    mounted.unmount();
    act(() => { vi.advanceTimersByTime(3000); });
    expect(a).toHaveBeenCalledTimes(5);
  });

  it('opens a requested tab, persists tab changes, restores after reload, and does not persist open', () => {
    const stats = new StatsRegistry();
    stats.register(section('a'));
    stats.register(section('b'));
    mount(stats);
    act(() => openStatsHub('b'));
    expect(screen.getByRole('tab', { name: 'Section b' }).getAttribute('aria-selected')).toBe('true');
    fireEvent.click(screen.getByRole('tab', { name: 'Section a' }));
    expect(persisted().activeSection).toBe('a');
    expect(persisted()).not.toHaveProperty('open');
    cleanup();
    resetStatsHubStore();
    expect(getStatsHubSnapshot()).toEqual({ open: false, activeSection: 'a' });
    mount(stats);
    act(() => openStatsHub());
    expect(screen.getByRole('tab', { name: 'Section a' }).getAttribute('aria-selected')).toBe('true');
  });

  it('falls back from an unavailable stored tab to the first available section', () => {
    localStorage.setItem(STATS_HUB_KEY, JSON.stringify({ activeSection: 'missing' }));
    resetStatsHubStore();
    const stats = new StatsRegistry();
    stats.register(section('b', { order: 20 }));
    stats.register(section('a', { order: 10 }));
    mount(stats);
    act(() => openStatsHub());
    expect(screen.getByRole('tab', { name: 'Section a' }).getAttribute('aria-selected')).toBe('true');
    expect(persisted().activeSection).toBe('a');
  });

  it('advances from a disappearing active tab and closes and hides the button when none remain', () => {
    const stats = new StatsRegistry();
    const a = source(); const b = source(); const c = source();
    stats.register(section('a', a)); stats.register(section('b', b)); stats.register(section('c', c));
    mount(stats);
    act(() => openStatsHub('b'));
    b.emit(false);
    expect(getStatsHubSnapshot().activeSection).toBe('c');
    c.emit(false);
    expect(getStatsHubSnapshot().activeSection).toBe('a');
    a.emit(false);
    expect(isStatsHubOpen()).toBe(false);
    expect(screen.queryByRole('button', { name: 'Statistics' })).toBeNull();
    a.emit(true);
    expect(screen.getByRole('button', { name: 'Statistics' })).toBeTruthy();
    expect(isStatsHubOpen()).toBe(false);
  });

  it('passes active only to the visible Body and disposes its work on close', () => {
    const activity = vi.fn(); const stopped = vi.fn();
    function Body({ active, viewer }: StatsSectionBodyProps) {
      useEffect(() => { activity(active, viewer); return stopped; }, [active, viewer]);
      return <div>Rich statistics</div>;
    }
    const stats = new StatsRegistry();
    stats.register(section('a', { rows: undefined, Body }));
    stats.register(section('b'));
    mount(stats);
    act(() => openStatsHub('a'));
    expect(activity.mock.lastCall?.[0]).toBe(true);
    fireEvent.click(screen.getByRole('tab', { name: 'Section b' }));
    expect(activity.mock.lastCall?.[0]).toBe(false);
    expect(activity.mock.lastCall?.[1].stats).toBe(stats);
    stopped.mockClear();
    act(() => closeStatsHub());
    expect(stopped).toHaveBeenCalledTimes(1);
  });

  it('writes persistent switches immediately, observes external changes, and leaves nonpersistent settings to their owner', () => {
    let badges = false;
    let external = false;
    const listeners = new Set<() => void>();
    const setBadges = vi.fn((value: boolean) => { badges = value; });
    const stats = new StatsRegistry();
    stats.register(section('a', { settings: [
      { id: 'badges', label: 'Badges', get: () => badges, set: setBadges,
        subscribe: cb => { listeners.add(cb); return () => { listeners.delete(cb); }; } },
      { id: 'external', label: 'External', get: () => external, set: value => { external = value; }, persist: false },
    ] }));
    mount(stats);
    act(() => openStatsHub());
    fireEvent.click(screen.getByRole('switch', { name: 'Badges' }));
    expect(setBadges).toHaveBeenCalledExactlyOnceWith(true);
    expect(persisted().settings.badges).toBe(true);
    act(() => { badges = false; for (const cb of listeners) cb(); });
    expect((screen.getByRole('switch', { name: 'Badges' }) as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByRole('switch', { name: 'External' }));
    expect(external).toBe(true);
    expect(persisted().settings).not.toHaveProperty('external');
    act(() => closeStatsHub());
    expect(listeners.size).toBe(0);
  });

  it('tolerates corrupt preferences and includes the hub in Reset all', () => {
    localStorage.setItem(STATS_HUB_KEY, '{broken');
    resetStatsHubStore();
    expect(getStatsHubSnapshot()).toEqual({ open: false, activeSection: null });
    localStorage.setItem(STATS_HUB_KEY, JSON.stringify({ activeSection: 42, groupBy: null, settings: [] }));
    resetStatsHubStore();
    expect(getStatsHubSnapshot().activeSection).toBeNull();
    clearAllRVStorage();
    expect(localStorage.getItem(STATS_HUB_KEY)).toBeNull();
  });

  it('shows a section description as a caption, also when it is the only section (no tab bar)', () => {
    const stats = new StatsRegistry();
    stats.register(section('perf', { description: 'Measured — not deterministic' }));
    mount(stats);
    act(() => openStatsHub());
    expect(screen.queryByRole('tab')).toBeNull();
    expect(screen.getByText('Measured — not deterministic')).toBeTruthy();
  });
});
