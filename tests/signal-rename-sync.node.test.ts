// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-590 Rename-/Sync-Vertrag (SOL R1 #2).
 *
 * While `beginRename(old, new)` is open:
 *   (a) the editor sync turns "snapshot `old`, desired `new`" into
 *       `renameSignal` — value, force, listeners and writers stay;
 *   (b) interface rediscovery neither registers `new` nor withdraws `old`;
 *   (c) a gateway catalog change arriving before OR after the model edit is
 *       applied only after `endRename`.
 * The reverse phase is the same contract with the names swapped.
 *
 * Runs the REAL `AssetExecutorContext` (setField Name = the rename's model
 * step) against a REAL `SignalStore`, and a minimal live interface whose remote
 * list the test changes the way the gateway does after its own rename.
 */

import { describe, expect, it } from 'vitest';
import { IFACE_PATH_PREFIX, type SignalCatalogChange } from '../src/core/engine/rv-signal-store';
import { BaseIndustrialInterface, type SignalDescriptor } from '../src/interfaces/base-industrial-interface';
import type { InterfaceSettings } from '../src/interfaces/interface-settings-store';
import type { LoadResult } from '../src/core/engine/rv-scene-loader';
import type { RvAssetOp } from '../src/core/ops/rv-unified-ops';
import { trackedSignalOf } from '../src/core/engine/rv-signal-construction';
import { fwd, head, inv, makeSyncFixture, node, plc, type SyncFixture } from './helpers/signal-sync-fixture';

const build = () => makeSyncFixture((root) => {
  const cell = node('Cell', root);
  node('Start', cell, plc('PLCInputBool', 'DB.Start'));
});

const nameOp = (value: string, prev: string): RvAssetOp => ({
  ...head(), kind: 'setField', nodePath: 'Asset/Cell/Start', componentType: 'PLCInputBool',
  fieldName: 'Name', value, prev,
} as RvAssetOp);

/** A gateway-like interface: its remote list is whatever the test says it is now. */
class GatewayLike extends BaseIndustrialInterface {
  readonly id = 'gateway-like';
  readonly protocolName = 'Gateway';
  remote: SignalDescriptor[] = [{ name: 'DB.Start', type: 'bool', direction: 'input', initialValue: false }];
  readonly sent: Record<string, boolean | number>[] = [];
  protected async doConnect(): Promise<void> {}
  protected doDisconnect(): void {}
  protected sendSignals(signals: Record<string, boolean | number>): void { this.sent.push(signals); }
  protected async doDiscoverSignals(): Promise<SignalDescriptor[]> { return this.remote.map((s) => ({ ...s })); }
  receive(signals: Record<string, boolean | number>): void { this.bufferIncoming(signals); }
  /** The gateway renamed the signal and announced a catalog change. */
  gatewayRenamed(to: string): void { this.remote = this.remote.map((s) => (s.name === 'DB.Start' || s.name === 'DB.Go' ? { ...s, name: to } : s)); }
}

async function liveInterface(f: SyncFixture): Promise<GatewayLike> {
  const iface = new GatewayLike();
  iface.setProviderProvenanceEnabled(false); // CONNECT value stream: the model path is the only owner
  iface.onModelLoaded({} as LoadResult, f.viewer);
  await iface.connect({} as InterfaceSettings);
  return iface;
}

function catalogLog(f: SyncFixture): SignalCatalogChange[] {
  const log: SignalCatalogChange[] = [];
  f.store.onCatalogChanged((c) => log.push(c));
  return log;
}

describe('(a) editor sync migrates instead of register/release', () => {
  it('keeps value, force, listener and writer across the model step and its reverse phase', async () => {
    const f = build();
    const node = f.registry.getNode('Asset/Cell/Start')!;
    f.store.createWriter('hmi:panel', 'hmi').set('DB.Start', true);
    f.store.forceSignal('DB.Start', true);
    const seen: unknown[] = [];
    f.store.subscribe('DB.Start', (v) => seen.push(v));
    const log = catalogLog(f);

    f.store.beginRename('DB.Start', 'DB.Go');
    await fwd(f, nameOp('DB.Go', 'DB.Start'));
    f.store.endRename('DB.Start', 'DB.Go');

    expect(f.store.get('DB.Start')).toBeUndefined();
    expect(f.store.get('DB.Go')).toBe(true);
    expect(f.store.isForced('DB.Go')).toBe(true);
    expect(f.store.getPath('DB.Go')).toBe('Asset/Cell/Start');
    expect(f.store.registeredPaths('DB.Go')).toEqual(['Asset/Cell/Start']);
    // hmi:panel and the force writer — both moved with the name
    expect(f.store.getWriterInventory().map((r) => `${r.signal}|${r.writerId}`).sort())
      .toEqual(['DB.Go|hmi:force', 'DB.Go|hmi:panel']);
    expect(trackedSignalOf(f.store, node)?.name).toBe('DB.Go');
    // ONE catalog event — the rename — and no register/release pair besides it.
    expect(log).toHaveLength(1);
    expect(log[0].renamed).toEqual([{ from: 'DB.Start', to: 'DB.Go' }]);

    f.store.unforce('DB.Go');
    f.store.set('DB.Go', false);
    expect(seen).toEqual([false]);

    // Reverse phase: the same contract with the names swapped.
    f.store.beginRename('DB.Go', 'DB.Start');
    await inv(f, nameOp('DB.Go', 'DB.Start'));
    f.store.endRename('DB.Go', 'DB.Start');
    expect(f.store.get('DB.Go')).toBeUndefined();
    expect(f.store.get('DB.Start')).toBe(false);
    expect(trackedSignalOf(f.store, node)?.name).toBe('DB.Start');
    f.store.set('DB.Start', true);
    expect(seen).toEqual([false, true]);
  });

  it('is a pure snapshot update when the coordinator already renamed the store', async () => {
    const f = build();
    f.store.set('DB.Start', true);
    f.store.beginRename('DB.Start', 'DB.Go');
    f.store.renameSignal('DB.Start', 'DB.Go');
    const log = catalogLog(f);
    await fwd(f, nameOp('DB.Go', 'DB.Start'));
    f.store.endRename('DB.Start', 'DB.Go');
    expect(log).toEqual([]);
    expect(f.store.get('DB.Go')).toBe(true);
    expect(f.store.get('DB.Start')).toBeUndefined();
  });

  it('without an open rename the old register/release behaviour is unchanged', async () => {
    const f = build();
    f.store.set('DB.Start', true);
    await fwd(f, nameOp('DB.Go', 'DB.Start'));
    // A plain edit is a NEW signal: the value starts from the extras, the old name is gone.
    expect(f.store.get('DB.Go')).toBe(false);
    expect(f.store.get('DB.Start')).toBeUndefined();
  });
});

describe('(b)+(c) a live interface during the rename', () => {
  it('catalog change BEFORE the model step: deferred to endRename, no double register', async () => {
    const f = build();
    const iface = await liveInterface(f);
    f.store.forceSignal('DB.Start', true);
    const seen: unknown[] = [];
    f.store.subscribe('DB.Start', (v) => seen.push(v));

    f.store.beginRename('DB.Start', 'DB.Go');
    iface.gatewayRenamed('DB.Go');              // step 2: the gateway renamed first …
    await iface.rediscover();                    // … and its catalog_changed arrives now
    expect(f.store.getPath('DB.Go')).toBeUndefined(); // (b) `new` not registered by the interface
    expect(f.store.getPath('DB.Start')).toBe('Asset/Cell/Start'); // (b) `old` not withdrawn

    await fwd(f, nameOp('DB.Go', 'DB.Start')); // step 3
    f.store.endRename('DB.Start', 'DB.Go');     // (c) now the deferred discovery applies

    expect(f.store.registeredPaths('DB.Go')).toEqual(['Asset/Cell/Start']);
    expect(f.store.registeredPaths('DB.Start')).toEqual([]);
    expect(f.store.getPath(`${IFACE_PATH_PREFIX}DB.Go`)).toBeUndefined();
    expect(f.store.isForced('DB.Go')).toBe(true);

    f.store.unforce('DB.Go');
    f.store.set('DB.Go', false);
    expect(seen).toEqual([false]);
    iface.onFixedUpdatePost(0.02);
    expect(iface.sent).toEqual([{ 'DB.Go': false }]);
  });

  it('catalog change AFTER the model step: same end state', async () => {
    const f = build();
    const iface = await liveInterface(f);
    f.store.set('DB.Start', true);

    f.store.beginRename('DB.Start', 'DB.Go');
    iface.gatewayRenamed('DB.Go');
    await fwd(f, nameOp('DB.Go', 'DB.Start'));
    await iface.rediscover();
    expect(f.store.registeredPaths('DB.Go')).toEqual(['Asset/Cell/Start']);
    f.store.endRename('DB.Start', 'DB.Go');

    expect(f.store.registeredPaths('DB.Go')).toEqual(['Asset/Cell/Start']);
    expect(f.store.get('DB.Go')).toBe(true);
    expect(f.store.get('DB.Start')).toBeUndefined();

    // Incoming for the new name lands on the model signal; nothing re-creates the old one.
    iface.receive({ 'DB.Go': false, 'DB.Start': true });
    iface.onFixedUpdatePre(0.02);
    expect(f.store.get('DB.Go')).toBe(false);
  });

  it('an incoming value for the renamed-away name is dropped while the rename is open', async () => {
    const f = build();
    const iface = await liveInterface(f);
    f.store.beginRename('DB.Start', 'DB.Go');
    await fwd(f, nameOp('DB.Go', 'DB.Start'));
    iface.receive({ 'DB.Start': true });
    iface.onFixedUpdatePre(0.02);
    expect(f.store.get('DB.Start')).toBeUndefined();
    f.store.endRename('DB.Start', 'DB.Go');
  });
});
