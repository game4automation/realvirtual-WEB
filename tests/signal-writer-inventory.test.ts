// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it } from 'vitest';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { PluginContextImpl } from '../src/core/rv-plugin-context';
import { MultiuserPlugin } from '../src/plugins/multiuser-plugin';

describe('SignalStore writer identity and Phase-0 inventory', () => {
  it('forwards values through a named writer façade and records its identity', () => {
    const store = new SignalStore();
    store.register('Start', 'Cell/Signals/Start', false, 'PLCInputBool');
    const writer = store.createWriter(
      'component:test-drive',
      'component',
      { slotContext: 'Cell/Drive/Start' },
    );

    writer.set('Start', true, 100);

    expect(store.get('Start')).toBe(true);
    expect(store.getWriterInventory()).toEqual([{
      signal: 'Start',
      writerId: 'component:test-drive',
      writerKind: 'component',
      slotContext: 'Cell/Drive/Start',
      firstSeenAt: 100,
      writeCount: 1,
    }]);
  });

  it('deduplicates inventory by signal and writer while counting writes', () => {
    const store = new SignalStore();
    const writer = store.createWriter('interface:websocket-realtime', 'interface');

    writer.setMany({ A: 1, B: true }, 10);
    writer.set('A', 2, 20);
    writer.setMany({ A: 3 }, 30);

    const inventory = store.getWriterInventory()
      .sort((a, b) => a.signal.localeCompare(b.signal));
    expect(inventory.map(({ signal, writerId, writerKind, writeCount }) => ({
      signal,
      writerId,
      writerKind,
      writeCount,
    }))).toEqual([
      {
        signal: 'A',
        writerId: 'interface:websocket-realtime',
        writerKind: 'interface',
        writeCount: 3,
      },
      {
        signal: 'B',
        writerId: 'interface:websocket-realtime',
        writerKind: 'interface',
        writeCount: 1,
      },
    ]);
  });

  it('records an unclassified raw write as unknown and supports reset', () => {
    const store = new SignalStore();

    store.set('Raw', 42, 123);

    const inventory = store.getWriterInventory();
    expect(inventory).toHaveLength(1);
    expect(inventory[0]).toMatchObject({
      signal: 'Raw',
      writerId: 'unknown',
      writeCount: 1,
    });
    store.resetWriterInventory();
    expect(store.getWriterInventory()).toEqual([]);
    expect(store.get('Raw')).toBe(42);
  });
});

describe('writer classification integration', () => {
  it('classifies Multiuser state snapshots as remote writes', () => {
    const store = new SignalStore();
    store.register('RemoteStart', 'Cell/Signals/RemoteStart', false, 'PLCOutputBool');
    const plugin = new MultiuserPlugin();
    (plugin as unknown as { viewer: unknown }).viewer = { signalStore: store };

    (plugin as unknown as {
      _handleStateSnapshot(message: Record<string, unknown>): void;
    })._handleStateSnapshot({
      signals: [{ path: 'Cell/Signals/RemoteStart', value: true }],
    });

    expect(store.get('RemoteStart')).toBe(true);
    expect(store.getWriterInventory()[0]).toMatchObject({
      signal: 'RemoteStart',
      writerId: 'multiuser',
      writerKind: 'remote',
    });
  });

  it('keeps the plugin signal API compatible while binding the plugin id', () => {
    const store = new SignalStore();
    store.register('A', 'Signals/A', false);
    store.register('B', 'Signals/B', 0);
    const viewer = makePluginViewer(store);
    const context = new PluginContextImpl(viewer as never).forPlugin('legacy-plugin');
    const observed: Array<boolean | number> = [];
    const off = context.signals!.subscribe('A', (value) => observed.push(value));

    context.signals!.set('A', true);
    context.signals!.setMany({ B: 7 });
    off();

    expect(context.signals!.get('A')).toBe(true);
    expect(context.signals!.get('B')).toBe(7);
    expect(observed).toEqual([true]);
    expect(store.getWriterInventory().map(({ signal, writerId, writerKind }) => ({
      signal,
      writerId,
      writerKind,
    }))).toEqual([
      { signal: 'A', writerId: 'legacy-plugin', writerKind: 'plugin' },
      { signal: 'B', writerId: 'legacy-plugin', writerKind: 'plugin' },
    ]);
  });
});

function makePluginViewer(signalStore: SignalStore): Record<string, unknown> {
  return {
    signalStore,
    registry: null,
    transportManager: null,
    connectionState: 'Disconnected',
    camera: null,
    controls: null,
    drives: [],
    emit: () => {},
    on: () => () => {},
    loadModel: () => Promise.resolve({}),
    clearModel: () => {},
  };
}
