// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/** Statistics contribution lifecycle and persistence without browser storage. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  StatsRegistry, ScopedStatsRegistry, getActiveStatsRegistry, setActiveStatsRegistry,
  type StatsSectionSpec, type StatsSetting,
} from '../src/core/stats/rv-stats-registry';
import { ALL_RV_STORAGE_KEYS, STATS_HUB_KEY } from '../src/core/hmi/rv-storage-keys';

function harness() {
  const stored = new Map<string, boolean>([['badges', true], ['external', true]]);
  const loadSetting = vi.fn((id: string) => stored.get(id));
  const saveSetting = vi.fn((id: string, value: boolean) => { stored.set(id, value); });
  return { registry: new StatsRegistry({ loadSetting, saveSetting }), loadSetting, saveSetting };
}
function source() {
  let available = false;
  const listeners = new Set<() => void>();
  return {
    listeners,
    isAvailable: () => available,
    subscribe: (cb: () => void) => { listeners.add(cb); return () => { listeners.delete(cb); }; },
    emit: (value: boolean) => { available = value; for (const cb of listeners) cb(); },
  };
}
const rows = () => [];
const spec = (id: string, extra: Partial<StatsSectionSpec> = {}): StatsSectionSpec => ({ id, title: id, rows, ...extra });
afterEach(() => setActiveStatsRegistry(null));

describe('StatsRegistry', () => {
  it('registers, unregisters once, and supplies stable snapshots and removable listeners', () => {
    const { registry } = harness();
    const listener = vi.fn();
    const unsubscribe = registry.subscribe(listener);
    const before = registry.getSnapshot();
    const section = spec('a');
    const unregister = registry.register(section);
    expect(registry.list()).toEqual([section]);
    expect(registry.getSnapshot()).toBeGreaterThan(before);
    const registered = registry.getSnapshot();
    expect(registry.getSnapshot()).toBe(registered);
    unregister();
    expect(registry.list()).toEqual([]);
    expect(registry.getSnapshot()).toBeGreaterThan(registered);
    expect(listener).toHaveBeenCalledTimes(2);
    unregister();
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    registry.register(spec('b'));
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('replaces by ID, ends the old source subscription, and invalidates the old unregister', () => {
    const { registry } = harness();
    const old = source();
    const next = source();
    const unregisterOld = registry.register(spec('same', old));
    const replacement = spec('same', next);
    const unregisterNext = registry.register(replacement);
    expect(old.listeners.size).toBe(0);
    expect(next.listeners.size).toBe(1);
    unregisterOld();
    expect(registry.list()).toEqual([replacement]);
    unregisterNext();
    expect(next.listeners.size).toBe(0);
  });

  it('sorts by order (default 100), then registration sequence, and filters availability', () => {
    const { registry } = harness();
    registry.register(spec('default'));
    registry.register(spec('early', { order: 5 }));
    registry.register(spec('hidden', { order: 0, isAvailable: () => false }));
    registry.register(spec('tie', { order: 100 }));
    expect(registry.list().map(s => s.id)).toEqual(['hidden', 'early', 'default', 'tie']);
    expect(registry.available().map(s => s.id)).toEqual(['early', 'default', 'tie']);
    registry.register(spec('default'));
    expect(registry.available().map(s => s.id)).toEqual(['early', 'tie', 'default']);
  });

  it('requires exactly one body source and leaves an existing entry intact on invalid replacement', () => {
    const { registry } = harness();
    const section = spec('a');
    registry.register(section);
    expect(() => registry.register(spec('a', { Body: () => null }))).toThrow(/exactly one/);
    expect(() => registry.register(spec('b', { rows: undefined }))).toThrow(/exactly one/);
    expect(registry.list()).toEqual([section]);
    expect(() => registry.register(spec('body', { rows: undefined, Body: () => null }))).not.toThrow();
  });

  it('reapplies stored settings on registration, skips absent/nonpersistent values, and saves UI changes only when persistent', () => {
    const { registry, saveSetting, loadSetting } = harness();
    const setting: StatsSetting = { id: 'badges', label: 'Badges', get: () => false, set: vi.fn() };
    const external = { ...setting, id: 'external', persist: false, set: vi.fn() };
    const missing = { ...setting, id: 'missing', set: vi.fn() };
    const section = spec('a', { settings: [setting, external, missing] });
    registry.register(section);
    expect(setting.set).toHaveBeenCalledExactlyOnceWith(true);
    expect(external.set).not.toHaveBeenCalled();
    expect(missing.set).not.toHaveBeenCalled();
    expect(loadSetting).not.toHaveBeenCalledWith('external');
    expect(saveSetting).not.toHaveBeenCalled();
    registry.setSetting(section, external, false);
    expect(external.set).toHaveBeenCalledExactlyOnceWith(false);
    expect(saveSetting).not.toHaveBeenCalled();
    registry.setSetting(section, setting, false);
    expect(saveSetting).toHaveBeenCalledExactlyOnceWith('badges', false);
  });

  it('never sets while unavailable and reapplies on every unavailable-to-available transition', () => {
    const { registry, saveSetting } = harness();
    const availability = source();
    const set = vi.fn();
    const setting = { id: 'badges', label: 'Badges', get: () => false, set };
    const section = spec('a', { ...availability, settings: [setting] });
    registry.register(section);
    registry.setSetting(section, setting, true);
    expect(set).not.toHaveBeenCalled();
    expect(saveSetting).not.toHaveBeenCalled();
    availability.emit(true);
    expect(set).toHaveBeenCalledExactlyOnceWith(true);
    availability.emit(true);
    availability.emit(false);
    expect(set).toHaveBeenCalledTimes(1);
    availability.emit(true);
    expect(set).toHaveBeenCalledTimes(2);
    expect(set).toHaveBeenLastCalledWith(true);
  });

  it('bumps snapshots only on availability changes and stops listening after unregister', () => {
    const { registry } = harness();
    const availability = source();
    const unregister = registry.register(spec('a', availability));
    const before = registry.getSnapshot();
    availability.emit(false);
    expect(registry.getSnapshot()).toBe(before);
    availability.emit(true);
    expect(registry.getSnapshot()).toBe(before + 1);
    expect(registry.available()).toHaveLength(1);
    availability.emit(true);
    expect(registry.getSnapshot()).toBe(before + 1);
    availability.emit(false);
    expect(registry.available()).toEqual([]);
    expect(registry.getSnapshot()).toBe(before + 2);
    unregister();
    const removed = registry.getSnapshot();
    availability.emit(true);
    expect(availability.listeners.size).toBe(0);
    expect(registry.getSnapshot()).toBe(removed);
  });

  it('keeps the newest viewer active when an older viewer releases its slot', () => {
    const older = harness().registry;
    const newer = harness().registry;
    setActiveStatsRegistry(older);
    expect(getActiveStatsRegistry()).toBe(older);
    setActiveStatsRegistry(newer);
    if (getActiveStatsRegistry() === older) setActiveStatsRegistry(null);
    expect(getActiveStatsRegistry()).toBe(newer);
    if (getActiveStatsRegistry() === newer) setActiveStatsRegistry(null);
    expect(getActiveStatsRegistry()).toBeNull();
    const viewer = readFileSync(new URL('../src/core/rv-viewer.ts', import.meta.url), 'utf8');
    expect(viewer).toContain('setActiveStatsRegistry(this.componentStats)');
    expect(viewer).toMatch(/if \(getActiveStatsRegistry\(\) === this\.componentStats\)\s*\{\s*setActiveStatsRegistry\(null\)/);
  });

  it('leaves no registrations or source subscriptions after 1000 lifecycles', () => {
    const { registry } = harness();
    const availability = source();
    for (let i = 0; i < 1000; i++) {
      const unregister = registry.register(spec(`section-${i}`, availability));
      expect(availability.listeners.size).toBe(1);
      unregister();
    }
    expect(registry.list()).toEqual([]);
    expect(availability.listeners.size).toBe(0);
  });

  it('registers the hub persistence key for the existing reset path', () => {
    expect(STATS_HUB_KEY).toBe('rv-stats-hub');
    expect(ALL_RV_STORAGE_KEYS).toContain(STATS_HUB_KEY);
  });
});


describe('ScopedStatsRegistry', () => {
  it('records registrations and unregisters idempotently', () => {
    const { registry } = harness();
    const scope = new ScopedStatsRegistry(registry);
    const section = spec('component');
    const listener = vi.fn();
    registry.subscribe(listener);
    const unregister = scope.register(section);
    expect(scope.size).toBe(1);
    expect(registry.list()).toEqual([section]);
    unregister();
    unregister();
    expect(scope.size).toBe(0);
    expect(registry.list()).toEqual([]);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('clears its sections and subscriptions, preserves other contributions, and can be reused', () => {
    const { registry } = harness();
    const scope = new ScopedStatsRegistry(registry);
    const external = spec('plugin');
    registry.register(external);
    const availability = source();
    const unregister = scope.register(spec('a', availability));
    scope.register(spec('b'));
    expect(scope.size).toBe(2);
    scope.clear();
    scope.clear();
    unregister();
    expect(scope.size).toBe(0);
    expect(availability.listeners.size).toBe(0);
    expect(registry.list()).toEqual([external]);
    scope.register(spec('next-model'));
    expect(scope.size).toBe(1);
    scope.clear();
    expect(registry.list()).toEqual([external]);
  });

  it('preserves same-id replacement semantics within and outside the scope', () => {
    const { registry } = harness();
    const scope = new ScopedStatsRegistry(registry);
    const unregisterOld = scope.register(spec('same'));
    const replacement = spec('same');
    scope.register(replacement);
    expect(scope.size).toBe(2);
    unregisterOld();
    expect(scope.size).toBe(1);
    expect(registry.list()).toEqual([replacement]);
    scope.clear();
    expect(registry.list()).toEqual([]);
    scope.register(spec('same'));
    const external = spec('same');
    registry.register(external);
    scope.clear();
    expect(scope.size).toBe(0);
    expect(registry.list()).toEqual([external]);
  });
});
