// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-590 F3 — `SignalStore.renameSignal` moves a signal to a new name in every
 * name-keyed index; listeners, force pin and writer telemetry stay; a taken
 * target name throws; a repeated call is a no-op. Plus the rename contract
 * primitives `beginRename` / `endRename`.
 */

import { describe, expect, it } from 'vitest';
import {
  IFACE_PATH_PREFIX, SignalRenameCollisionError, SignalStore, type SignalCatalogChange,
} from '../src/core/engine/rv-signal-store';

function modelStore(): SignalStore {
  const store = new SignalStore();
  store.register('DB.Start', 'Asset/Cell/Start', false, 'PLCInputBool');
  store.register('DB.Other', 'Asset/Cell/Other', 0, 'PLCOutputInt');
  store.buildIndex();
  return store;
}

describe('SignalStore.renameSignal — every index moves', () => {
  it('moves value, type, meta, force pin, liveness and every path index', () => {
    const store = modelStore();
    store.set('DB.Start', true, 1234);
    store.setSignalMeta('DB.Start', { comment: 'start button', originDataType: 'BOOL' });
    store.forceSignal('DB.Start', true);
    const statsBefore = store.stats();

    expect(store.renameSignal('DB.Start', 'DB_FG01.Conveyor.Start')).toBe(true);

    const n = 'DB_FG01.Conveyor.Start';
    expect(store.get('DB.Start')).toBeUndefined();
    expect(store.getType('DB.Start')).toBeUndefined();
    expect(store.getSignalMeta('DB.Start')).toBeUndefined();
    expect(store.isForced('DB.Start')).toBe(false);
    expect(store.getLastUpdateTs('DB.Start')).toBeUndefined();
    expect(store.registeredPaths('DB.Start')).toEqual([]);

    expect(store.get(n)).toBe(true);
    expect(store.getType(n)).toBe('PLCInputBool');
    expect(store.getSignalMeta(n)).toEqual({ comment: 'start button', originDataType: 'BOOL' });
    expect(store.isForced(n)).toBe(true);
    expect(store.getLastUpdateTs(n)).toBe(1234);
    expect(store.getPath(n)).toBe('Asset/Cell/Start');
    expect(store.registeredPaths(n)).toEqual(['Asset/Cell/Start']);
    expect(store.nameForPath('Asset/Cell/Start')).toBe(n);
    expect(store.nameForPath('Cell/Start')).toBe(n); // buildIndex suffix follows
    expect(store.getByPath('Asset/Cell/Start')).toBe(true);

    // Same number of entries everywhere — nothing duplicated, nothing lost.
    const after = store.stats();
    expect(after.signals).toBe(statsBefore.signals);
    expect(after.paths).toBe(statsBefore.paths);
    expect(after.forced).toBe(statsBefore.forced);
    expect(after.meta).toBe(statsBefore.meta);
  });

  it('keeps listeners firing, keeps their unsubscribe working, and does not notify a value change', () => {
    const store = modelStore();
    const seen: unknown[] = [];
    const unsubscribe = store.subscribe('DB.Start', (v) => seen.push(v));
    const version = store.version;

    store.renameSignal('DB.Start', 'DB.Go');
    expect(seen).toEqual([]); // the value did not change, only its name
    expect(store.version).toBeGreaterThan(version);

    store.set('DB.Go', true);
    expect(seen).toEqual([true]);
    expect(store.stats().listeners).toBe(1);

    unsubscribe();
    store.set('DB.Go', false);
    expect(seen).toEqual([true]);
    expect(store.stats().listeners).toBe(0);
    expect(store.stats().listenerKeys).toBe(0);
  });

  it('merges into subscribers that were already waiting on the new name', () => {
    const store = modelStore();
    const a: unknown[] = [];
    const b: unknown[] = [];
    const unsubA = store.subscribe('DB.Start', (v) => a.push(v));
    const unsubB = store.subscribe('DB.Go', (v) => b.push(v)); // HMI widget bound by name, no signal yet

    store.renameSignal('DB.Start', 'DB.Go');
    store.set('DB.Go', true);
    expect(a).toEqual([true]);
    expect(b).toEqual([true]);

    unsubA();
    unsubB();
    expect(store.stats().listeners).toBe(0);
  });

  it('moves the writer inventory under the new name', () => {
    const store = modelStore();
    const writer = store.createWriter('hmi:button', 'hmi');
    writer.set('DB.Start', true);
    store.renameSignal('DB.Start', 'DB.Go');
    const rows = store.getWriterInventory();
    expect(rows.map((r) => [r.signal, r.writerId])).toEqual([['DB.Go', 'hmi:button']]);
  });

  it('moves the interface placeholder and provider registrations of an interface-only symbol', () => {
    const store = new SignalStore();
    store.register('Iface.Sig', `${IFACE_PATH_PREFIX}Iface.Sig`, 3, 'PLCOutputInt');
    store.registerSignalProvider({ interfaceId: 'mqtt', topic: 'plant/io', signal: 'Iface.Sig' }, true);

    store.renameSignal('Iface.Sig', 'Iface.Renamed');

    expect(store.getPath('Iface.Renamed')).toBe(`${IFACE_PATH_PREFIX}Iface.Renamed`);
    expect(store.nameForPath(`${IFACE_PATH_PREFIX}Iface.Sig`)).toBeUndefined();
    expect(store.getSignalProviders('Iface.Sig')).toEqual([]);
    expect(store.getSignalProviders('Iface.Renamed')).toEqual([{ interfaceId: 'mqtt', topic: 'plant/io', signal: 'Iface.Renamed' }]);
    expect(store.hasSignalProviderByParts('mqtt', 'plant/io', 'Iface.Renamed')).toBe(true);
    expect(store.hasSignalProviderByParts('mqtt', 'plant/io', 'Iface.Sig')).toBe(false);
  });

  it('emits ONE catalog change naming the rename, and tells force listeners but not the force sink', () => {
    const store = modelStore();
    const log: SignalCatalogChange[] = [];
    store.onCatalogChanged((c) => log.push(c));
    store.forceSignal('DB.Start', true);
    const sink: unknown[] = [];
    store.setForceSink((name, value) => sink.push([name, value]));
    let forceNotes = 0;
    store.subscribeForce(() => forceNotes++);

    store.renameSignal('DB.Start', 'DB.Go');

    expect(log).toEqual([{
      registered: ['DB.Go'], released: [], removed: ['DB.Start'], metaChanged: [],
      renamed: [{ from: 'DB.Start', to: 'DB.Go' }],
    }]);
    expect(sink).toEqual([]);
    expect(forceNotes).toBe(1);
  });
});

describe('SignalStore.renameSignal — collision and idempotence', () => {
  it('throws on a taken target and changes nothing', () => {
    const store = modelStore();
    store.set('DB.Start', true);
    expect(() => store.renameSignal('DB.Start', 'DB.Other')).toThrow(SignalRenameCollisionError);
    expect(store.get('DB.Start')).toBe(true);
    expect(store.get('DB.Other')).toBe(0);
    expect(store.getPath('DB.Start')).toBe('Asset/Cell/Start');
  });

  it('is a no-op when it already happened (old gone, new present) and when both are unknown', () => {
    const store = modelStore();
    expect(store.renameSignal('DB.Start', 'DB.Go')).toBe(true);
    const version = store.version;
    expect(store.renameSignal('DB.Start', 'DB.Go')).toBe(false);
    expect(store.renameSignal('Nope', 'Nope2')).toBe(false);
    expect(store.renameSignal('DB.Go', 'DB.Go')).toBe(false);
    expect(store.version).toBe(version);
  });

  it('undo is the swapped rename and restores the original state', () => {
    const store = modelStore();
    store.set('DB.Start', true);
    const seen: unknown[] = [];
    store.subscribe('DB.Start', (v) => seen.push(v));
    store.renameSignal('DB.Start', 'DB.Go');
    store.renameSignal('DB.Go', 'DB.Start');
    expect(store.getPath('DB.Start')).toBe('Asset/Cell/Start');
    expect(store.get('DB.Go')).toBeUndefined();
    store.set('DB.Start', false);
    expect(seen).toEqual([false]);
  });
});

describe('SignalStore — rename contract primitives', () => {
  it('beginRename / endRename track the open rename and notify its end once', () => {
    const store = modelStore();
    const ends: unknown[] = [];
    store.onRenameEnded((e) => ends.push(e));

    store.beginRename('DB.Start', 'DB.Go');
    expect(store.hasPendingRename).toBe(true);
    expect(store.pendingRenameOf('DB.Start')).toBe('DB.Go');
    expect(store.isRenamePending('DB.Start')).toBe(true);
    expect(store.isRenamePending('DB.Go')).toBe(true);
    expect(store.isRenamePending('DB.Other')).toBe(false);

    store.endRename('DB.Start', 'DB.Other'); // not the open pair — ignored
    expect(store.hasPendingRename).toBe(true);
    store.endRename('DB.Start', 'DB.Go', 'abort');
    expect(store.hasPendingRename).toBe(false);
    expect(ends).toEqual([{ oldName: 'DB.Start', newName: 'DB.Go', outcome: 'abort' }]);
    // abort restores nothing — and nothing was moved
    expect(store.get('DB.Start')).toBe(false);
  });

  it('unregisterSignalProviderSignal withdraws one signal and keeps the provider key', () => {
    const store = new SignalStore();
    store.registerSignalProvider({ interfaceId: 'ws', signal: 'A' }, true);
    store.registerSignalProvider({ interfaceId: 'ws', signal: 'B' }, true);
    store.unregisterSignalProviderSignal({ interfaceId: 'ws', signal: 'A' });
    expect(store.getSignalProviderCount('A')).toBe(0);
    expect(store.getSignalProviderCount('B')).toBe(1);
    expect(store.isSignalProviderConnectedByParts('ws')).toBe(true);
  });
});
