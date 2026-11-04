// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ThemeProvider } from '@mui/material/styles';
import { rvDarkTheme } from '../../src/core/hmi/theme';
import { StatsRegistry } from '../../src/core/stats/rv-stats-registry';
import { StatsHubWindow } from '../../src/core/stats/StatsHubWindow';
import { closeStatsHub, getStatsHubSnapshot, openStatsHub, resetStatsHubStore, saveStatsHubSetting } from '../../src/core/stats/stats-hub-store';
import { STATS_HUB_KEY } from '../../src/core/hmi/rv-storage-keys';
import { DESHMIPlugin } from '../../src/plugins/des/hmi/des-hmi-plugin';
import { DESUtilizationBody } from '../../src/plugins/des/hmi/DESStatsChart';
import { DesStatsGizmos, getDesStatsGizmos, peekDesStatsGizmos } from '../../src/plugins/des/hmi/des-stats-gizmos';
import { isDesStatsWindowOpen, setDesStatsWindowOpen, subscribeDesStatsWindow, toggleDesStatsWindow } from '../../src/plugins/sim-controller/des-stats-window-store';
import { makeRunner, makeViewer } from '../helpers/des-stats-chart-fixture';

const plugins: DESHMIPlugin[] = [];
function fixture(withRunner = true) {
  const runner = makeRunner(['Source', 'Station']);
  const viewer = makeViewer(withRunner ? runner : null);
  const events = new Map<string, Set<(data?: unknown) => void>>();
  viewer.on = (event: string, cb: (data?: unknown) => void) => {
    if (!events.has(event)) events.set(event, new Set());
    events.get(event)!.add(cb);
    return () => events.get(event)!.delete(cb);
  };
  const emit = (event: string, data?: unknown) => {
    for (const cb of [...(events.get(event) ?? [])]) cb(data);
  };
  viewer.stats = new StatsRegistry();
  viewer.modes = { activeMode: 'des' };
  viewer.getPlugin = () => null;
  const plugin = new DESHMIPlugin();
  plugins.push(plugin);
  plugin.init(viewer);
  return {
    viewer, runner, plugin, emit, events,
    setMode(to: string) {
      viewer.modes.activeMode = to;
      emit('mode-changed', { to });
    },
    clearModel() {
      // RVViewer drops its kernel before emitting model-cleared.
      plugin.onModelCleared();
      viewer.simulationKernel = null;
      emit('model-cleared');
    },
  };
}
beforeEach(() => { localStorage.removeItem(STATS_HUB_KEY); resetStatsHubStore(); });
afterEach(() => {
  cleanup();
  for (const plugin of plugins.splice(0)) plugin.dispose();
  vi.restoreAllMocks();
  localStorage.removeItem(STATS_HUB_KEY);
  resetStatsHubStore();
});

describe('DES statistics hub section', () => {
  it('registers once for the plugin lifetime and requires DES mode and a runner', () => {
    const { viewer, plugin, emit, setMode } = fixture(false);
    const section = viewer.stats.list()[0];
    expect(section).toMatchObject({ id: 'des.utilization', title: 'Material flow', order: 10, Body: DESUtilizationBody });
    expect(viewer.stats.available()).toEqual([]);
    viewer.simulationKernel.activeExecutor = makeRunner(['A']);
    emit('simulation-mode-changed');
    expect(viewer.stats.available()).toEqual([section]);
    setMode('planner');
    expect(viewer.stats.available()).toEqual([]);
    setMode('des');
    plugin.init(viewer);
    expect(viewer.stats.list()).toEqual([section]);
    expect(viewer.stats.available()).toEqual([section]);
  });

  it('the hub badges switch enables real sprites, persists, and reapplies after registration', () => {
    const { viewer, plugin } = fixture();
    const setter = vi.spyOn(DesStatsGizmos.prototype, 'setEnabled');
    openStatsHub('des.utilization');
    render(<ThemeProvider theme={rvDarkTheme}><StatsHubWindow viewer={viewer} /></ThemeProvider>);
    fireEvent.click(screen.getByRole('switch', { name: 'In-scene badges' }));
    expect(setter).toHaveBeenCalledWith(true);
    expect(getDesStatsGizmos(viewer).enabled).toBe(true);
    expect(getDesStatsGizmos(viewer).spriteOf('Yard/Source')).not.toBeNull();
    expect(JSON.parse(localStorage.getItem(STATS_HUB_KEY)!).settings['des.badges']).toBe(true);
    cleanup();
    plugin.dispose();
    resetStatsHubStore();
    plugin.init(viewer);
    expect(setter).toHaveBeenCalledTimes(2);
    expect(getDesStatsGizmos(viewer).enabled).toBe(true);
    expect(getDesStatsGizmos(viewer).spriteOf('Yard/Station')).not.toBeNull();
  });

  it('disposes badges and removes the tab on leaving DES, then reapplies without a duplicate registration', () => {
    saveStatsHubSetting('des.badges', true);
    const { viewer, setMode } = fixture();
    const section = viewer.stats.list()[0];
    const sprite = getDesStatsGizmos(viewer).spriteOf('Yard/Source')!;
    viewer.stats.register({ id: 'other', title: 'Other', rows: () => [] });
    openStatsHub('des.utilization');
    render(<ThemeProvider theme={rvDarkTheme}><StatsHubWindow viewer={viewer} /></ThemeProvider>);
    expect(screen.getByRole('tab', { name: 'Material flow' })).toBeTruthy();
    act(() => setMode('planner'));
    expect(peekDesStatsGizmos(viewer)).toBeUndefined();
    expect(sprite.parent).toBeNull();
    expect(screen.queryByRole('tab', { name: 'Material flow' })).toBeNull();
    expect(getStatsHubSnapshot().activeSection).toBe('other');
    act(() => setMode('des'));
    expect(screen.getByRole('tab', { name: 'Material flow' })).toBeTruthy();
    expect(viewer.stats.list().filter((s: { id: string }) => s.id === section.id)).toEqual([section]);
    expect(getDesStatsGizmos(viewer).enabled).toBe(true);
    expect(getDesStatsGizmos(viewer).spriteOf('Yard/Source')).not.toBe(sprite);
  });

  it('defers stored true until the runner exists, then creates a sprite for every component', () => {
    saveStatsHubSetting('des.badges', true);
    const setter = vi.spyOn(DesStatsGizmos.prototype, 'setEnabled');
    const { viewer, runner, emit } = fixture(false);
    expect(setter).not.toHaveBeenCalled();
    expect(peekDesStatsGizmos(viewer)).toBeUndefined();
    viewer.simulationKernel.activeExecutor = runner;
    emit('simulation-mode-changed');
    expect(setter).toHaveBeenCalledExactlyOnceWith(true);
    for (const { adapter } of runner.instances()) {
      expect(getDesStatsGizmos(viewer).spriteOf(adapter.path)).not.toBeNull();
    }
  });

  it('rebuilds sprites with model B statistics at the same paths and fully cleans up on dispose', () => {
    saveStatsHubSetting('des.badges', true);
    const { viewer, runner, plugin, clearModel, emit, events } = fixture();
    const a = runner.instances().map(({ adapter }) => getDesStatsGizmos(viewer).spriteOf(adapter.path)!);
    const oldReads = runner.liveInstances.map(({ adapter }) => vi.spyOn(adapter, 'getStatistics'));
    clearModel();
    expect(peekDesStatsGizmos(viewer)).toBeUndefined();
    expect(viewer.stats.available()).toEqual([]);
    expect(a.every(sprite => sprite.parent === null)).toBe(true);
    const b = makeRunner(['Source', 'Station']);
    for (const { adapter } of b.liveInstances) {
      const stats = adapter.getStatistics();
      adapter.getStatistics = vi.fn(() => ({ ...stats, outputPerHour: 987 }));
    }
    const draw = vi.spyOn(CanvasRenderingContext2D.prototype, 'fillText');
    viewer.simulationKernel = { mode: 'des', activeExecutor: b };
    emit('model-loaded');
    expect(viewer.stats.available()).toHaveLength(1);
    b.instances().forEach(({ adapter }, i) => {
      const sprite = getDesStatsGizmos(viewer).spriteOf(adapter.path);
      expect(sprite).not.toBeNull();
      expect(sprite).not.toBe(a[i]);
      expect(adapter.getStatistics).toHaveBeenCalled();
    });
    expect(draw.mock.calls.some(args => args[0] === '987/h')).toBe(true);
    for (const read of oldReads) expect(read).not.toHaveBeenCalled();
    const manager = getDesStatsGizmos(viewer);
    plugin.dispose();
    expect(manager.enabled).toBe(false);
    expect(peekDesStatsGizmos(viewer)).toBeUndefined();
    expect(viewer.stats.list()).toEqual([]);
    expect([...events.values()].every(listeners => listeners.size === 0)).toBe(true);
    expect(viewer.scene.children).toHaveLength(0);
  });

  it('keeps the shim and subscriptions working without closing another section', () => {
    const listener = vi.fn();
    const off = subscribeDesStatsWindow(listener);
    setDesStatsWindowOpen(true);
    expect(getStatsHubSnapshot()).toEqual({ open: true, activeSection: 'des.utilization' });
    expect(isDesStatsWindowOpen()).toBe(true);
    expect(listener).toHaveBeenCalled();
    toggleDesStatsWindow();
    expect(isDesStatsWindowOpen()).toBe(false);
    toggleDesStatsWindow();
    expect(isDesStatsWindowOpen()).toBe(true);
    openStatsHub('other');
    expect(isDesStatsWindowOpen()).toBe(false);
    setDesStatsWindowOpen(false);
    expect(getStatsHubSnapshot()).toEqual({ open: true, activeSection: 'other' });
    off();
    listener.mockClear();
    closeStatsHub();
    expect(listener).not.toHaveBeenCalled();
  });

  it('badge clicks still open the hub on Material flow and the retired slots are absent', () => {
    saveStatsHubSetting('des.badges', true);
    const { plugin, emit } = fixture();
    emit('object-clicked', { path: 'Yard/Source' });
    expect(isDesStatsWindowOpen()).toBe(true);
    // plan-2211 G5: the Experiments side button is the core `DesExperimentsSideButton` (same slot,
    // order and visibility id; it opens the experiment window or the commercial notice).
    expect(plugin.slots.map(slot => slot.component.name)).toEqual([
      'DESSnapshotFeedback', 'DESEventQueueButton', 'DESSnapshotMenu', 'DesExperimentsSideButton',
    ]);
    expect(plugin.slots.find(slot => slot.component.name === 'DesExperimentsSideButton')?.visibilityId).toBe('des-experiments');
    expect(plugin.slots.some(slot => ['des-stats', 'des-stats-gizmos'].includes(slot.visibilityId ?? ''))).toBe(false);
  });
});
