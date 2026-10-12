// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-590 F4 — a LIVE interface across a signal rename and its undo.
 *
 * The gateway renames first (CONNECT step), the viewer store second, and the
 * interface's next discovery carries the new name and no longer the old one.
 * After that: incoming and outgoing values flow under the new name, the old
 * name's interface placeholder `__iface__/<old>` and its provider entry are
 * gone, and a value still queued for sending under the old name is dropped.
 * Undo is the same sequence with the names swapped.
 */

import { describe, expect, it } from 'vitest';
import { BaseIndustrialInterface, type SignalDescriptor } from '../src/interfaces/base-industrial-interface';
import { IFACE_PATH_PREFIX, SignalStore } from '../src/core/engine/rv-signal-store';
import type { InterfaceSettings } from '../src/interfaces/interface-settings-store';
import type { LoadResult } from '../src/core/engine/rv-scene-loader';
import type { RVViewer } from '../src/core/rv-viewer';

class RenameInterface extends BaseIndustrialInterface {
  readonly id = 'rename-interface';
  readonly protocolName = 'Rename';
  remote: SignalDescriptor[] = [
    { name: 'Cell.Start', type: 'bool', direction: 'input', initialValue: false },
    { name: 'Cell.Lamp', type: 'bool', direction: 'output', initialValue: false },
  ];
  readonly sent: Record<string, boolean | number>[] = [];
  protected async doConnect(): Promise<void> {}
  protected doDisconnect(): void {}
  protected sendSignals(signals: Record<string, boolean | number>): void { this.sent.push(signals); }
  protected async doDiscoverSignals(): Promise<SignalDescriptor[]> { return this.remote.map((s) => ({ ...s })); }
  receive(signals: Record<string, boolean | number>): void { this.bufferIncoming(signals); }
  remoteRename(from: string, to: string): void {
    this.remote = this.remote.map((s) => (s.name === from ? { ...s, name: to } : s));
  }
}

function viewer(signalStore: SignalStore): RVViewer {
  return { signalStore, emit: () => {}, setConnectionState: () => {} } as unknown as RVViewer;
}

/** Interface-only symbols (no model node) with provider provenance — the MQTT/WebSocket case. */
async function live(): Promise<{ iface: RenameInterface; store: SignalStore }> {
  const store = new SignalStore();
  const iface = new RenameInterface();
  iface.onModelLoaded({} as LoadResult, viewer(store));
  await iface.connect({} as InterfaceSettings);
  return { iface, store };
}

/** The coordinator's order: begin → gateway rename (+ catalog) → store rename → end. */
async function rename(iface: RenameInterface, store: SignalStore, from: string, to: string): Promise<void> {
  store.beginRename(from, to);
  iface.remoteRename(from, to);
  await iface.rediscover();          // the gateway's catalog_changed — deferred while open
  store.renameSignal(from, to);
  store.endRename(from, to);         // the deferred discovery applies now
}

describe('live interface across a signal rename', () => {
  it('incoming values flow under the new name; placeholder and provider of the old name are gone', async () => {
    const { iface, store } = await live();
    expect(store.getPath('Cell.Lamp')).toBe(`${IFACE_PATH_PREFIX}Cell.Lamp`);

    await rename(iface, store, 'Cell.Lamp', 'Cell.Light');

    expect(store.getPath('Cell.Light')).toBe(`${IFACE_PATH_PREFIX}Cell.Light`);
    expect(store.nameForPath(`${IFACE_PATH_PREFIX}Cell.Lamp`)).toBeUndefined();
    expect(store.get('Cell.Lamp')).toBeUndefined();
    expect(store.getSignalProviders('Cell.Lamp')).toEqual([]);
    expect(store.getSignalProviders('Cell.Light')).toEqual([{ interfaceId: 'rename-interface', signal: 'Cell.Light' }]);

    iface.receive({ 'Cell.Light': true });
    iface.onFixedUpdatePre(0.02);
    expect(store.getBool('Cell.Light')).toBe(true);
    expect(store.get('Cell.Lamp')).toBeUndefined();
  });

  it('outgoing values flow under the new name; a value queued under the old name is dropped', async () => {
    const { iface, store } = await live();
    store.set('Cell.Start', true);               // queued in dirtyOutgoing under the OLD name

    await rename(iface, store, 'Cell.Start', 'Cell.Go');

    iface.onFixedUpdatePost(0.02);
    expect(iface.sent).toEqual([]);             // the old-name write never goes out

    store.set('Cell.Go', false);
    iface.onFixedUpdatePost(0.02);
    expect(iface.sent).toEqual([{ 'Cell.Go': false }]);
  });

  it('undo (the swapped rename) restores both directions under the original name', async () => {
    const { iface, store } = await live();
    const seen: unknown[] = [];
    store.subscribe('Cell.Start', (v) => seen.push(v));

    await rename(iface, store, 'Cell.Start', 'Cell.Go');
    await rename(iface, store, 'Cell.Go', 'Cell.Start');

    expect(store.get('Cell.Go')).toBeUndefined();
    expect(store.getSignalProviders('Cell.Go')).toEqual([]);
    expect(store.getPath('Cell.Start')).toBe(`${IFACE_PATH_PREFIX}Cell.Start`);

    store.set('Cell.Start', true);
    iface.onFixedUpdatePost(0.02);
    expect(iface.sent).toEqual([{ 'Cell.Start': true }]);
    expect(seen).toEqual([true]);               // the listener followed both renames

    iface.receive({ 'Cell.Lamp': true });
    iface.onFixedUpdatePre(0.02);
    expect(store.getBool('Cell.Lamp')).toBe(true);
  });

  it('a gateway rename WITHOUT a viewer rename withdraws the old interface-only name (F4)', async () => {
    const { iface, store } = await live();
    iface.remoteRename('Cell.Lamp', 'Cell.Light');
    await iface.rediscover();
    expect(store.get('Cell.Lamp')).toBeUndefined();
    expect(store.getSignalProviders('Cell.Lamp')).toEqual([]);
    expect(store.getPath('Cell.Light')).toBe(`${IFACE_PATH_PREFIX}Cell.Light`);
  });

  it('a withdrawn name that a MODEL node still owns keeps its model path', async () => {
    const { iface, store } = await live();
    store.register('Cell.Lamp', 'Root/Cell/Lamp', false, 'PLCOutputBool');
    iface.remoteRename('Cell.Lamp', 'Cell.Light');
    await iface.rediscover();
    expect(store.getPath('Cell.Lamp')).toBe('Root/Cell/Lamp');
    expect(store.getSignalProviders('Cell.Lamp')).toEqual([]);
  });
});
