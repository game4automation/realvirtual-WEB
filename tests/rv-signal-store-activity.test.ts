// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-signal-store-activity.test.ts — SignalStore liveness instrumentation.
 *
 * Covers:
 *  - setMany / set / setByPath stamp lastUpdateTs → getActivity resolves live
 *  - forceSignal does NOT stamp (a forced dead signal stays no-source/stale, F4)
 *  - getPath returns the registered path (name→path reverse index)
 *  - clear() empties lastUpdateTs and nameToPath
 *  - setConnectionProvider drives the sourceConnected input
 */
import { describe, it, expect } from 'vitest';
import { SignalStore } from '../src/core/engine/rv-signal-store';

/** Provider that reports every source as connected. */
const allConnected = () => true;

describe('SignalStore — activity', () => {
  it('setMany stamps lastUpdateTs → getActivity is live for a supplied signal', () => {
    const store = new SignalStore();
    store.register('A', 'sig/A', false, 'PLCInputBool');
    store.setSignalMeta('A', { source: 'MQTT · Data_I_1' });
    store.setConnectionProvider(allConnected);

    store.setMany({ A: true }, 1_000);

    expect(store.getActivity('A', 1_100, 'live')).toBe('live');
  });

  it('set() stamps lastUpdateTs', () => {
    const store = new SignalStore();
    store.register('A', 'sig/A', false, 'PLCInputBool');
    store.setSignalMeta('A', { source: 'MQTT · Data_I_1' });
    store.setConnectionProvider(allConnected);

    store.set('A', true, 2_000);
    expect(store.getActivity('A', 2_100, 'live')).toBe('live');
    // No freshness decay: a connected signal stays live no matter how much time
    // has passed since the last write (a static value must not become stale).
    expect(store.getActivity('A', 2_000 + 60_000, 'live')).toBe('live');
  });

  it('setByPath() stamps lastUpdateTs', () => {
    const store = new SignalStore();
    store.register('Grip', 'demoglb/Robot/Grip', false, 'PLCInputBool');
    store.setSignalMeta('Grip', { source: 'MQTT · Data_I_1' });
    store.setConnectionProvider(allConnected);

    store.setByPath('Robot/Grip', true, 3_000);
    expect(store.getActivity('Grip', 3_050, 'live')).toBe('live');
  });

  it('forceSignal does NOT stamp lastUpdateTs — a forced dead signal stays no-source', () => {
    const store = new SignalStore();
    store.register('B', 'sig/B', false, 'PLCInputBool');
    // No source assigned, never written via setMany/set.
    store.forceSignal('B', true);

    // Value is forced true, but activity must not be "live".
    expect(store.getBool('B')).toBe(true);
    expect(store.getActivity('B', 1_000, 'live')).toBe('no-source');
  });

  it('forceSignal does NOT stamp — supplied-but-forced signal stays stale (never written)', () => {
    const store = new SignalStore();
    store.register('C', 'sig/C', false, 'PLCInputBool');
    store.setSignalMeta('C', { source: 'MQTT · Data_I_1' });
    store.setConnectionProvider(allConnected);

    store.forceSignal('C', true);
    // Connected source, but no real write → supplied (no timestamp yet), not live.
    expect(store.getActivity('C', 10_000, 'live')).toBe('supplied');
  });

  it('getPath returns the registered path', () => {
    const store = new SignalStore();
    store.register('ConveyorStart', 'Robot/Signals/ConveyorStart', false);
    expect(store.getPath('ConveyorStart')).toBe('Robot/Signals/ConveyorStart');
    expect(store.getPath('unknown')).toBeUndefined();
  });

  it('remapPaths keeps getPath in sync after kinematic re-parenting', () => {
    const store = new SignalStore();
    store.register('ConveyorStart', 'Robot/Signals/ConveyorStart', false);
    store.buildIndex();

    store.remapPaths(new Map([['Robot/Signals/ConveyorStart', 'Cell/Robot/Signals/ConveyorStart']]));

    expect(store.getPath('ConveyorStart')).toBe('Cell/Robot/Signals/ConveyorStart');
    expect(store.getByPath('Cell/Robot/Signals/ConveyorStart')).toBe(false);
  });

  it('clear() empties lastUpdateTs and nameToPath', () => {
    const store = new SignalStore();
    store.register('A', 'sig/A', false, 'PLCInputBool');
    store.setSignalMeta('A', { source: 'MQTT · Data_I_1' });
    store.setConnectionProvider(allConnected);
    store.setMany({ A: true }, 1_000);
    expect(store.getActivity('A', 1_100, 'live')).toBe('live');
    expect(store.getPath('A')).toBe('sig/A');

    store.clear();

    // No timestamp and no meta → no-source; path index cleared.
    expect(store.getActivity('A', 1_100, 'live')).toBe('no-source');
    expect(store.getPath('A')).toBeUndefined();
  });

  it('setConnectionProvider drives sourceConnected — disconnected → stale', () => {
    const store = new SignalStore();
    store.register('A', 'sig/A', false, 'PLCInputBool');
    store.setSignalMeta('A', { source: 'MQTT · Data_I_1' });
    store.setMany({ A: true }, 1_000);

    // No provider yet → treated as disconnected → stale.
    expect(store.getActivity('A', 1_100, 'live')).toBe('stale');

    // Provider reports disconnected → stale even with a fresh timestamp.
    store.setConnectionProvider(() => false);
    expect(store.getActivity('A', 1_100, 'live')).toBe('stale');

    // Provider reports connected → live.
    store.setConnectionProvider(allConnected);
    expect(store.getActivity('A', 1_100, 'live')).toBe('live');
  });

  it('no-source signal in standalone mode is local (not dead)', () => {
    const store = new SignalStore();
    store.register('Local', 'sig/Local', false, 'PLCOutputBool');
    store.set('Local', true, 500);
    // No source meta, standalone → local.
    expect(store.getActivity('Local', 600, 'standalone')).toBe('local');
  });
});
