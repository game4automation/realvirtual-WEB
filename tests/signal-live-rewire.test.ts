// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-589 test 9.8 — a LIVE interface after an editor catalog change.
 *
 * The editor can create or delete a model signal at any moment, with no model reload in sight. A
 * connected interface must survive that: its registrations and outgoing subscriptions are REBUILT
 * (`subscribeToCatalog`, `base-industrial-interface.ts`), and both buffers are purged of names the
 * model no longer has — a queued incoming value would otherwise RE-CREATE the deleted signal on
 * the next flush (the store registers on `set`), and a queued outgoing one would be sent for a
 * signal that is gone.
 *
 * The implementation is Phase 1's; this file is the test it did not get.
 */

import { describe, expect, it } from 'vitest';
import { BaseIndustrialInterface, type SignalDescriptor } from '../src/interfaces/base-industrial-interface';
import { SignalStore, IFACE_PATH_PREFIX } from '../src/core/engine/rv-signal-store';
import type { InterfaceSettings } from '../src/interfaces/interface-settings-store';
import type { LoadResult } from '../src/core/engine/rv-scene-loader';
import type { RVViewer } from '../src/core/rv-viewer';

/** Two signals: one the viewer writes (PLC input) and one it reads (PLC output). */
const DISCOVERY: SignalDescriptor[] = [
  { name: 'Cell.Start', type: 'bool', direction: 'input', initialValue: false },
  { name: 'Cell.Lamp', type: 'bool', direction: 'output', initialValue: false },
];

class RewireInterface extends BaseIndustrialInterface {
  readonly id = 'rewire-interface';
  readonly protocolName = 'Rewire';
  readonly sent: Record<string, boolean | number>[] = [];
  protected async doConnect(): Promise<void> {}
  protected doDisconnect(): void {}
  protected sendSignals(signals: Record<string, boolean | number>): void { this.sent.push(signals); }
  protected async doDiscoverSignals(): Promise<SignalDescriptor[]> { return DISCOVERY.map((s) => ({ ...s })); }
  /** The protocol-side entry point, exposed so a test can act like an arriving PLC frame. */
  receive(signals: Record<string, boolean | number>): void { this.bufferIncoming(signals); }
}

function viewer(signalStore: SignalStore): RVViewer {
  return { signalStore, emit: () => {}, setConnectionState: () => {} } as unknown as RVViewer;
}

/**
 * A connected interface on a store that already holds the model's own `Cell.Start` node.
 *
 * `provenance: false` is the CONNECT case (`connect-plugin.tsx` turns provider provenance off for
 * its value stream) and it is the one that makes the MODEL PATH the only owner of the name — so
 * deleting the node really REMOVES the name. With provenance on, the interface's own provider
 * entry keeps the name alive (`hasInterfaceOwner`), which is the other half of the ownership rule
 * and is asserted separately below.
 */
async function live(provenance = false): Promise<{ iface: RewireInterface; store: SignalStore }> {
  const store = new SignalStore();
  store.register('Cell.Start', 'Root/Cell/Start', false, 'PLCInputBool');
  const iface = new RewireInterface();
  iface.setProviderProvenanceEnabled(provenance);
  iface.onModelLoaded({} as LoadResult, viewer(store));
  await iface.connect({} as InterfaceSettings);
  return { iface, store };
}

describe('live interface after a signal catalog change', () => {
  it('keeps sending and receiving for a signal the editor just created', async () => {
    const { iface, store } = await live();
    // `Cell.Lamp` was discovered but the MODEL did not have it, so the interface holds it under
    // its own placeholder path.
    expect(store.getPath('Cell.Lamp')).toBe(`${IFACE_PATH_PREFIX}Cell.Lamp`);

    // The editor creates the model node for it; `register()` moves the path ownership.
    store.register('Cell.Lamp', 'Root/Cell/Lamp', false, 'PLCOutputBool');
    store.notifyCatalogChanged({ registered: ['Cell.Lamp'], released: [], removed: [], metaChanged: [] });
    expect(store.getPath('Cell.Lamp')).toBe('Root/Cell/Lamp');

    // Receiving still lands on the model signal...
    iface.receive({ 'Cell.Lamp': true });
    iface.onFixedUpdatePre(0.02);
    expect(store.getBool('Cell.Lamp')).toBe(true);
    // ...and the rebuilt outgoing subscription still sends the PLC input exactly once.
    store.set('Cell.Start', true);
    iface.onFixedUpdatePost(0.02);
    expect(iface.sent).toEqual([{ 'Cell.Start': true }]);
  });

  it('drops a queued outgoing value for a name the editor deleted', async () => {
    const { iface, store } = await live();
    store.set('Cell.Start', true);          // queued in dirtyOutgoing

    // The editor deletes the node; no owner is left, so the name leaves the store.
    expect(store.unregisterPath('Root/Cell/Start', 'Cell.Start')).toBe('name');
    store.notifyCatalogChanged({ registered: [], released: [], removed: ['Cell.Start'], metaChanged: [] });

    iface.onFixedUpdatePost(0.02);
    expect(iface.sent).toEqual([]);
  });

  it('drops a queued incoming value for a deleted name instead of re-creating the signal', async () => {
    const { iface, store } = await live();
    iface.receive({ 'Cell.Start': true });  // queued in pendingIncoming

    expect(store.unregisterPath('Root/Cell/Start', 'Cell.Start')).toBe('name');
    store.notifyCatalogChanged({ registered: [], released: [], removed: ['Cell.Start'], metaChanged: [] });

    iface.onFixedUpdatePre(0.02);
    // The rebuild re-registers the DISCOVERED signal under the interface placeholder — the
    // interface still knows it — but the queued value did not resurrect the deleted model path.
    expect(store.getPath('Cell.Start')).toBe(`${IFACE_PATH_PREFIX}Cell.Start`);
    expect(store.getBool('Cell.Start')).toBe(false);
  });

  it('keeps a queued value while the INTERFACE still owns the name', async () => {
    // Provider provenance on: the interface is a second owner, so deleting the model node only
    // releases the path. The name — and therefore the queued write — is still legitimate.
    const { iface, store } = await live(true);
    store.set('Cell.Start', true);
    expect(store.unregisterPath('Root/Cell/Start', 'Cell.Start')).toBe('path');
    store.notifyCatalogChanged({ registered: [], released: ['Cell.Start'], removed: [], metaChanged: [] });

    iface.onFixedUpdatePost(0.02);
    expect(iface.sent).toEqual([{ 'Cell.Start': true }]);
    expect(store.getPath('Cell.Start')).toBe(`${IFACE_PATH_PREFIX}Cell.Start`);
  });

  it('leaves the buffers alone for a metadata-only change', async () => {
    const { iface, store } = await live();
    store.set('Cell.Start', true);
    // Comment / OriginDataType moved — no registration changed, so nothing may be purged.
    store.notifyCatalogChanged({ registered: [], released: [], removed: [], metaChanged: ['Cell.Start'] });

    iface.onFixedUpdatePost(0.02);
    expect(iface.sent).toEqual([{ 'Cell.Start': true }]);
  });

  it('reconnects cleanly after a catalog change', async () => {
    const { iface, store } = await live();
    expect(store.unregisterPath('Root/Cell/Start', 'Cell.Start')).toBe('name');
    store.notifyCatalogChanged({ registered: [], released: [], removed: ['Cell.Start'], metaChanged: [] });

    iface.disconnect();
    await iface.connect({} as InterfaceSettings);
    expect(iface.isConnected).toBe(true);

    store.set('Cell.Start', true);
    iface.onFixedUpdatePost(0.02);
    expect(iface.sent).toEqual([{ 'Cell.Start': true }]);

    iface.receive({ 'Cell.Lamp': true });
    iface.onFixedUpdatePre(0.02);
    expect(store.getBool('Cell.Lamp')).toBe(true);
  });

  it('stops following the catalog once disposed', async () => {
    const { iface, store } = await live();
    iface.dispose();
    store.set('Cell.Start', true);
    // No throw, and nothing queued by a dead interface.
    store.notifyCatalogChanged({ registered: [], released: [], removed: ['Cell.Start'], metaChanged: [] });
    iface.onFixedUpdatePost(0.02);
    expect(iface.sent).toEqual([]);
  });
});
