// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-589 Test 9.2 — the editor ↔ SignalStore sync contract.
 *
 * Runs the REAL `AssetExecutorContext` (forward = do/redo, inverse = undo,
 * exactly what `AssetDocument` calls) against a REAL `SignalStore` and the
 * REAL loader traversal. The pre-sync behaviour of the same cases is pinned in
 * `signal-placement-ist.node.test.ts`, the placement/scope rules live in
 * `signal-placement-scope.node.test.ts` and the store's ownership rule in
 * `signal-store-ownership.node.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import { BufferGeometry, Float32BufferAttribute, Mesh } from 'three';
import { SignalStore, type SignalCatalogChange } from '../src/core/engine/rv-signal-store';
import { syncSignalSubtree } from '../src/core/engine/rv-signal-editor-sync';
import type { RvAssetOp } from '../src/core/ops/rv-unified-ops';
import { IDENTITY, fwd, head, inv, makeSyncFixture, node, plc, type SyncFixture } from './helpers/signal-sync-fixture';

// The ownership section below moves the model node out from under an
// interface-owned name; `registerSignalProvider` is the store's own API, so no
// live interface is needed.

const build = () => makeSyncFixture((root) => {
  const cell = node('Cell', root);
  node('Start', cell, plc('PLCOutputBool', 'DB.Start', { Comment: 'old' }));
  node('Plain', cell, plc('PLCInputInt', '')); // no Name → node-name fallback
  node('Other', root);
});

function catalogLog(f: SyncFixture): SignalCatalogChange[] {
  const log: SignalCatalogChange[] = [];
  f.store.onCatalogChanged((c) => log.push(c));
  return log;
}

describe('editor sync — add / remove component', () => {
  it('addComponent registers at once; undo removes; redo registers again', async () => {
    const f = build();
    const log = catalogLog(f);
    const op: RvAssetOp = { ...head(), kind: 'addComponent', nodePath: 'Asset/Other', componentType: 'PLCInputBool', fields: { Name: 'DB.New', Status: { Value: true } } };
    await fwd(f, op);
    expect(f.store.get('DB.New')).toBe(true);
    expect(f.store.getPath('DB.New')).toBe('Asset/Other');
    expect(f.store.getType('DB.New')).toBe('PLCInputBool');
    await inv(f, op);
    expect(f.store.get('DB.New')).toBeUndefined();
    expect(f.store.exactNameForPath('Asset/Other')).toBeUndefined();
    await fwd(f, op);
    expect(f.store.getPath('DB.New')).toBe('Asset/Other');
    expect(log.map((c) => [c.registered, c.removed])).toEqual([
      [['DB.New'], []], [[], ['DB.New']], [['DB.New'], []],
    ]);
  });

  it('removeComponent removes; undo restores name + path; subscribers survive the round trip', async () => {
    const f = build();
    const seen: unknown[] = [];
    f.store.subscribe('DB.Start', (v) => seen.push(v));
    const op: RvAssetOp = { ...head(), kind: 'removeComponent', nodePath: 'Asset/Cell/Start', componentType: 'PLCOutputBool', prevFields: { Name: 'DB.Start', Status: { Value: false }, Comment: 'old' } };
    await fwd(f, op);
    expect(f.store.get('DB.Start')).toBeUndefined();
    expect(f.registry.getByPath('PLCOutputBool', 'Asset/Cell/Start')).toBeNull();
    await inv(f, op);
    expect(f.store.getPath('DB.Start')).toBe('Asset/Cell/Start');
    f.store.set('DB.Start', true);
    expect(seen).toEqual([true]);
  });

  it('a type change (remove + add composite) re-types the name in ONE catalog wave', async () => {
    const f = build();
    const log = catalogLog(f);
    const op: RvAssetOp = { ...head(), kind: 'composite', label: 'retype', ops: [
      { ...head(), kind: 'removeComponent', nodePath: 'Asset/Cell/Start', componentType: 'PLCOutputBool', prevFields: { Name: 'DB.Start' } },
      { ...head(), kind: 'addComponent', nodePath: 'Asset/Cell/Start', componentType: 'PLCInputBool', fields: { Name: 'DB.Start', Status: { Value: false } } },
    ] } as unknown as RvAssetOp;
    await fwd(f, op);
    expect(f.store.getType('DB.Start')).toBe('PLCInputBool');
    expect(log).toHaveLength(1);
    await inv(f, op);
    expect(f.store.getType('DB.Start')).toBe('PLCOutputBool');
    expect(log).toHaveLength(2);
  });
});

describe('editor sync — delete / restore a PARENT subtree', () => {
  it('releases every signal of the trashed subtree; undo restores; redo releases again', async () => {
    const f = build();
    const op: RvAssetOp = { ...head(), kind: 'deleteNode', nodePath: 'Asset/Cell' };
    await fwd(f, op);
    expect(f.store.get('DB.Start')).toBeUndefined();
    expect(f.store.get('Plain')).toBeUndefined();
    expect(f.store.exactNameForPath('Asset/Cell/Start')).toBeUndefined();
    expect(f.store.exactNameForPath('Cell/Start')).toBeUndefined(); // buildIndex suffix gone too
    // trash subtree is NOT re-registered by a later sync of the whole scene
    syncSignalSubtree(f.viewer, f.scene);
    expect(f.store.get('DB.Start')).toBeUndefined();
    await inv(f, op);
    expect(f.store.getPath('DB.Start')).toBe('Asset/Cell/Start');
    expect(f.store.getPath('Plain')).toBe('Asset/Cell/Plain');
    await fwd(f, op);
    expect(f.store.get('DB.Start')).toBeUndefined();
  });

  it('a force pin on a removed name is released (sink + listeners told)', async () => {
    const f = build();
    const sink: Array<[string, unknown]> = [];
    f.store.setForceSink((n, v) => sink.push([n, v]));
    f.store.forceSignal('DB.Start', true);
    await fwd(f, { ...head(), kind: 'deleteNode', nodePath: 'Asset/Cell' });
    expect(f.store.isForced('DB.Start')).toBe(false);
    expect(sink.at(-1)).toEqual(['DB.Start', null]);
  });
});

describe('editor sync — createNode', () => {
  it('a signal added under a created node is released by the create UNDO and comes back on redo', async () => {
    const f = build();
    const create: RvAssetOp = {
      ...head(), kind: 'createNode', nodePath: 'Asset/Fresh', transform: IDENTITY,
    } as unknown as RvAssetOp;
    await fwd(f, create);
    const addComp: RvAssetOp = {
      ...head(), kind: 'addComponent', nodePath: 'Asset/Fresh', componentType: 'PLCInputBool',
      fields: { Name: 'DB.Fresh', Status: { Value: false } },
    };
    await fwd(f, addComp);
    expect(f.store.getPath('DB.Fresh')).toBe('Asset/Fresh');

    // Undo of createNode detaches to the trash — the component added later goes
    // with it, so its signal must be released too.
    await inv(f, create);
    expect(f.store.get('DB.Fresh')).toBeUndefined();
    // Redo restores the subtree from the trash, component included.
    await fwd(f, create);
    expect(f.store.getPath('DB.Fresh')).toBe('Asset/Fresh');
  });
});

describe('editor sync — separate / merge mesh', () => {
  /** Two disconnected triangles in ONE mesh + a PLC signal leaf under it. */
  const meshFixture = () => makeSyncFixture((root) => {
    const mesh = new Mesh(twoIslandGeometry());
    mesh.name = 'Part';
    root.add(mesh);
    node('Sig', mesh, plc('PLCOutputBool', 'DB.Part'));
  });

  it('separateMesh keeps the signal registered under its new path; undo moves it back', async () => {
    const f = meshFixture();
    expect(f.store.getPath('DB.Part')).toBe('Asset/Part/Sig');
    const op: RvAssetOp = {
      ...head(), kind: 'separateMesh', sourcePath: 'Asset/Part', mode: 'islands',
      weldThreshold: 0.0001, childNames: ['Part_1', 'Part_2'],
    } as unknown as RvAssetOp;
    await fwd(f, op);
    // The source mesh became a Group at the SAME path, so the leaf path is
    // unchanged — what matters is that the teardown/revive pair did not lose
    // the registration on the way through.
    expect(f.store.get('DB.Part')).toBe(false);
    expect(f.store.getPath('DB.Part')).toBe('Asset/Part/Sig');
    await inv(f, op);
    expect(f.store.getPath('DB.Part')).toBe('Asset/Part/Sig');
  });
});

/** Indexed geometry with two triangles that share no vertex (two islands). */
function twoIslandGeometry(): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute([
    0, 0, 0, 1, 0, 0, 0, 1, 0,
    5, 0, 0, 6, 0, 0, 5, 1, 0,
  ], 3));
  g.setIndex([0, 1, 2, 3, 4, 5]);
  return g;
}

describe('editor sync — rename', () => {
  it('renaming the signal node moves the path, keeps name, value and the subscriber', async () => {
    const f = build();
    f.store.set('DB.Start', true);
    const op: RvAssetOp = { ...head(), kind: 'renameNode', nodePath: 'Asset/Cell/Start', name: 'Go', prevName: 'Start' };
    await fwd(f, op);
    expect(f.store.getPath('DB.Start')).toBe('Asset/Cell/Go');
    expect(f.store.get('DB.Start')).toBe(true);
    expect(f.store.exactNameForPath('Asset/Cell/Start')).toBeUndefined();
    expect(f.store.exactNameForPath('Cell/Go')).toBe('DB.Start');
    expect(f.store.exactNameForPath('Cell/Start')).toBeUndefined();
    await inv(f, op);
    expect(f.store.getPath('DB.Start')).toBe('Asset/Cell/Start');
    expect(f.store.exactNameForPath('Asset/Cell/Go')).toBeUndefined();
  });

  it('renaming a signal node WITHOUT Name changes the signal name (node-name fallback)', async () => {
    const f = build();
    const op: RvAssetOp = { ...head(), kind: 'renameNode', nodePath: 'Asset/Cell/Plain', name: 'Counter', prevName: 'Plain' };
    await fwd(f, op);
    expect(f.store.get('Plain')).toBeUndefined();
    expect(f.store.getPath('Counter')).toBe('Asset/Cell/Counter');
    await inv(f, op);
    expect(f.store.get('Counter')).toBeUndefined();
    expect(f.store.getPath('Plain')).toBe('Asset/Cell/Plain');
  });

  it('renaming a PARENT re-keys every signal below it', async () => {
    const f = build();
    const op: RvAssetOp = { ...head(), kind: 'renameNode', nodePath: 'Asset/Cell', name: 'Cell2', prevName: 'Cell' };
    await fwd(f, op);
    expect(f.store.getPath('DB.Start')).toBe('Asset/Cell2/Start');
    expect(f.store.getPath('Plain')).toBe('Asset/Cell2/Plain');
    expect(f.store.nameForPath('Asset/Cell/Start')).toBeUndefined();
    await inv(f, op);
    expect(f.store.getPath('DB.Start')).toBe('Asset/Cell/Start');
  });
});

describe('editor sync — reparent', () => {
  it('moves the path, drops the stale suffix of the old path; undo moves back', async () => {
    const f = build();
    const op: RvAssetOp = {
      ...head(), kind: 'reparentNode', nodePath: 'Asset/Cell/Start', newParentPath: 'Asset/Other',
      transform: IDENTITY, prevParentPath: 'Asset/Cell', prevIndex: 0, prevTransform: IDENTITY,
    };
    await fwd(f, op);
    expect(f.store.getPath('DB.Start')).toBe('Asset/Other/Start');
    expect(f.store.exactNameForPath('Cell/Start')).toBeUndefined();
    expect(f.store.exactNameForPath('Other/Start')).toBe('DB.Start');
    await inv(f, op);
    expect(f.store.getPath('DB.Start')).toBe('Asset/Cell/Start');
    expect(f.store.exactNameForPath('Other/Start')).toBeUndefined();
  });
});

describe('editor sync — field ops', () => {
  it('setField Comment updates the meta; undo restores it', async () => {
    const f = build();
    const op: RvAssetOp = { ...head(), kind: 'setField', nodePath: 'Asset/Cell/Start', componentType: 'PLCOutputBool', fieldName: 'Comment', value: 'new', prev: 'old' };
    await fwd(f, op);
    expect(f.store.getSignalMeta('DB.Start')?.comment).toBe('new');
    await inv(f, op);
    expect(f.store.getSignalMeta('DB.Start')?.comment).toBe('old');
  });

  it('setField Comment reports metaChanged — once per op, registration untouched', async () => {
    const f = build();
    const log = catalogLog(f);
    const op: RvAssetOp = { ...head(), kind: 'setField', nodePath: 'Asset/Cell/Start', componentType: 'PLCOutputBool', fieldName: 'Comment', value: 'new', prev: 'old' };
    await fwd(f, op);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ registered: [], released: [], removed: [], metaChanged: ['DB.Start'] });
    await inv(f, op);
    expect(log).toHaveLength(2);
    expect(log[1].metaChanged).toEqual(['DB.Start']);
    expect(f.store.getPath('DB.Start')).toBe('Asset/Cell/Start');
  });

  it('setField OriginDataType reaches SignalMeta and reports metaChanged (set / undo / redo)', async () => {
    const f = build();
    const log = catalogLog(f);
    const op: RvAssetOp = { ...head(), kind: 'setField', nodePath: 'Asset/Cell/Start', componentType: 'PLCOutputBool', fieldName: 'OriginDataType', value: 'BOOL', prev: undefined };
    await fwd(f, op);
    expect(f.store.getSignalMeta('DB.Start')?.originDataType).toBe('BOOL');
    await inv(f, op);
    expect(f.store.getSignalMeta('DB.Start')?.originDataType).toBeUndefined();
    await fwd(f, op);
    expect(f.store.getSignalMeta('DB.Start')?.originDataType).toBe('BOOL');
    // One `metaChanged` per op, never a re-registration.
    expect(log.map((c) => c.metaChanged)).toEqual([['DB.Start'], ['DB.Start'], ['DB.Start']]);
    expect(log.every((c) => c.registered.length === 0 && c.removed.length === 0)).toBe(true);
    expect(f.store.getPath('DB.Start')).toBe('Asset/Cell/Start');
  });

  it('unsetField Comment DELETES the meta comment (not ""); its UNDO restores it', async () => {
    const f = build();
    const log = catalogLog(f);
    const op: RvAssetOp = { ...head(), kind: 'unsetField', nodePath: 'Asset/Cell/Start', componentType: 'PLCOutputBool', fieldName: 'Comment', prev: 'old' };
    await fwd(f, op);
    // plan-589: absent means absent — `setSignalMeta` merges, so the sync has
    // to clear the field instead of writing the empty string.
    expect(f.store.getSignalMeta('DB.Start')?.comment).toBeUndefined();
    expect(log[0].metaChanged).toEqual(['DB.Start']);
    await inv(f, op);
    expect(f.store.getSignalMeta('DB.Start')?.comment).toBe('old');
  });

  it('unsetField OriginDataType deletes the meta field; its UNDO restores it', async () => {
    const f = build();
    await fwd(f, { ...head(), kind: 'setField', nodePath: 'Asset/Cell/Start', componentType: 'PLCOutputBool', fieldName: 'OriginDataType', value: 'DINT', prev: undefined });
    const op: RvAssetOp = { ...head(), kind: 'unsetField', nodePath: 'Asset/Cell/Start', componentType: 'PLCOutputBool', fieldName: 'OriginDataType', prev: 'DINT' };
    await fwd(f, op);
    expect(f.store.getSignalMeta('DB.Start')?.originDataType).toBeUndefined();
    await inv(f, op);
    expect(f.store.getSignalMeta('DB.Start')?.originDataType).toBe('DINT');
  });

  it('unsetField Name falls back to the node name; its UNDO restores the symbol', async () => {
    const f = build();
    const op: RvAssetOp = { ...head(), kind: 'unsetField', nodePath: 'Asset/Cell/Start', componentType: 'PLCOutputBool', fieldName: 'Name', prev: 'DB.Start' };
    await fwd(f, op);
    expect(f.store.get('DB.Start')).toBeUndefined();
    expect(f.store.getPath('Start')).toBe('Asset/Cell/Start');
    await inv(f, op);
    expect(f.store.get('Start')).toBeUndefined();
    expect(f.store.getPath('DB.Start')).toBe('Asset/Cell/Start');
  });
});

describe('ownership rule', () => {
  const twoGlobals = () => makeSyncFixture((root) => {
    node('EStop', node('A', root), plc('PLCInputBool', '/EStop'));
    node('EStop', node('B', root), plc('PLCInputBool', '/EStop'));
  });

  it('two "/"-global declarations: deleting one keeps the name, deleting both removes it', async () => {
    const f = twoGlobals();
    // plan-589: an AUTHORED name is used verbatim — the leading `/` of a global
    // declaration included (unchanged from before; only GENERATED names are
    // scoped, and `scopeSignalName` strips the slash for those).
    expect(f.store.registeredPaths('/EStop').slice().sort()).toEqual(['Asset/A/EStop', 'Asset/B/EStop']);
    const delA: RvAssetOp = { ...head(), kind: 'deleteNode', nodePath: 'Asset/A' };
    const delB: RvAssetOp = { ...head(), kind: 'deleteNode', nodePath: 'Asset/B' };
    f.store.set('/EStop', true);
    await fwd(f, delA);
    expect(f.store.get('/EStop')).toBe(true);
    expect(f.store.getPath('/EStop')).toBe('Asset/B/EStop');
    await fwd(f, delB);
    expect(f.store.get('/EStop')).toBeUndefined();
    await inv(f, delB);
    await inv(f, delA);
    expect(f.store.registeredPaths('/EStop').slice().sort()).toEqual(['Asset/A/EStop', 'Asset/B/EStop']);
  });

  it('deleting the bound model node keeps an interface-owned signal (falls back to __iface__)', async () => {
    const f = build();
    // exactly what base-industrial-interface.registerDiscoveredSignals does for a
    // name the model already owns: no placeholder path, but a provider entry
    f.store.registerSignalProvider({ interfaceId: 's7', signal: 'DB.Start' }, true);
    f.store.set('DB.Start', true);
    await fwd(f, { ...head(), kind: 'deleteNode', nodePath: 'Asset/Cell' });
    expect(f.store.get('DB.Start')).toBe(true);
    expect(f.store.getPath('DB.Start')).toBe('__iface__/DB.Start');
    expect(f.store.exactNameForPath('Asset/Cell/Start')).toBeUndefined();
  });

  it('restoring the model node takes the canonical path back from the placeholder', async () => {
    const f = build();
    f.store.registerSignalProvider({ interfaceId: 's7', signal: 'DB.Start' }, true);
    const op: RvAssetOp = { ...head(), kind: 'deleteNode', nodePath: 'Asset/Cell' };
    await fwd(f, op);
    await inv(f, op);
    expect(f.store.getPath('DB.Start')).toBe('Asset/Cell/Start');
  });

  it('FIXED: re-registering a path under another name no longer leaves a ghost name', () => {
    const store = new SignalStore();
    store.register('Flow.Run', 'M/A/Signals/Flow.Run', false);
    store.register('A.Flow.Run', 'M/A/Signals/Flow.Run', false);
    expect(store.get('Flow.Run')).toBeUndefined();
    expect(store.getPath('A.Flow.Run')).toBe('M/A/Signals/Flow.Run');
  });
});

