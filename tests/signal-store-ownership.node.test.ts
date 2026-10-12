// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-589 Test 9.1 — the SignalStore ownership rule (`unregisterPath`).
 *
 * A signal NAME can have several owners: two `/`-global declarations in
 * different assets, or a model node plus the interface placeholder
 * `__iface__/<name>`. Releasing ONE model path must therefore not remove the
 * name — it removes an OWNER, and the name goes only when the last one does.
 *
 * Two consequences this file pins because they are easy to regress:
 *  - LISTENER SETS ARE NEVER REMOVED. They belong to the subscriber (a drive, an
 *    HMI widget, an interface's outgoing subscription), not to the signal, and
 *    keeping them is exactly what makes undo symmetric.
 *  - `register()` MOVES path ownership. Re-registering a path under a different
 *    name takes it away from the old one, which is what retires the "reload
 *    ghost" (a name whose `getPath()` answered with a path that resolved to
 *    someone else).
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { Object3D } from 'three';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { IFACE_PATH_PREFIX, SignalStore, type SignalCatalogChange } from '../src/core/engine/rv-signal-store';
import { traverseAndRegister } from '../src/core/engine/rv-scene-loader';
import { stampPlacementMarkers } from '../src/core/engine/rv-placement-instancer';
import {
  beginSignalSyncWave, endSignalSyncWave, syncSignalSubtree,
} from '../src/core/engine/rv-signal-editor-sync';
import {
  clearSignalNameCollisionProblems, getProblems, signalNameCollisionProblemId,
} from '../src/core/hmi/problems-store';
import { node, plc } from './helpers/signal-sync-fixture';

const PATH_A = 'M/A/Sig';
const PATH_B = 'M/B/Sig';

describe('unregisterPath — the ownership rule', () => {
  it('a second model path keeps the name alive; releasing the last one removes it', () => {
    const store = new SignalStore();
    store.register('EStop', PATH_A, true, 'PLCInputBool');
    store.register('EStop', PATH_B, true, 'PLCInputBool');
    expect(store.registeredPaths('EStop').slice().sort()).toEqual([PATH_A, PATH_B]);

    expect(store.unregisterPath(PATH_A, 'EStop')).toBe('path');
    expect(store.get('EStop')).toBe(true);
    expect(store.getPath('EStop')).toBe(PATH_B);

    expect(store.unregisterPath(PATH_B, 'EStop')).toBe('name');
    expect(store.get('EStop')).toBeUndefined();
    expect(store.registeredPaths('EStop')).toEqual([]);
  });

  it('an interface-owned name falls back to the __iface__ placeholder', () => {
    const store = new SignalStore();
    store.register('DB.Start', PATH_A, false, 'PLCOutputBool');
    store.registerSignalProvider({ interfaceId: 's7', signal: 'DB.Start' }, true);
    store.set('DB.Start', true);

    expect(store.hasInterfaceOwner('DB.Start')).toBe(true);
    expect(store.unregisterPath(PATH_A, 'DB.Start')).toBe('path');
    expect(store.get('DB.Start')).toBe(true);
    expect(store.getPath('DB.Start')).toBe(`${IFACE_PATH_PREFIX}DB.Start`);

    // A re-registration of the model path takes the canonical path back.
    store.register('DB.Start', PATH_A, true, 'PLCOutputBool');
    expect(store.getPath('DB.Start')).toBe(PATH_A);
  });

  it('releasing an unknown or foreign path is a no-op', () => {
    const store = new SignalStore();
    store.register('A', PATH_A, false, 'PLCInputBool');
    expect(store.unregisterPath('M/Nope')).toBe('none');
    expect(store.unregisterPath(PATH_A, 'OtherName')).toBe('none');
    expect(store.get('A')).toBe(false);
  });

  it('full removal drops value, type, meta, timestamp, writer inventory and the force pin', () => {
    const store = new SignalStore();
    const forced: Array<[string, unknown]> = [];
    store.setForceSink((n, v) => forced.push([n, v]));
    store.register('DB.Start', PATH_A, false, 'PLCOutputBool');
    store.setSignalMeta('DB.Start', { comment: 'hi', originDataType: 'BOOL' });
    store.set('DB.Start', true);
    store.forceSignal('DB.Start', true);
    expect(store.getLastUpdateTs('DB.Start')).not.toBeUndefined();

    expect(store.unregisterPath(PATH_A, 'DB.Start')).toBe('name');
    expect(store.get('DB.Start')).toBeUndefined();
    expect(store.getType('DB.Start')).toBeUndefined();
    expect(store.getSignalMeta('DB.Start')).toBeUndefined();
    expect(store.getLastUpdateTs('DB.Start')).toBeUndefined();
    expect(store.isForced('DB.Start')).toBe(false);
    expect(forced.at(-1)).toEqual(['DB.Start', null]);
    expect(store.nameForPath(PATH_A)).toBeUndefined();
  });

  it('LISTENERS SURVIVE a full removal — a re-registration is live again at once', () => {
    const store = new SignalStore();
    const seen: unknown[] = [];
    store.register('DB.Start', PATH_A, false, 'PLCOutputBool');
    store.subscribe('DB.Start', (v) => seen.push(v));

    expect(store.unregisterPath(PATH_A, 'DB.Start')).toBe('name');
    store.register('DB.Start', PATH_A, false, 'PLCOutputBool');
    store.set('DB.Start', true);
    // No re-binding anywhere: this is the undo symmetry the rule exists for.
    expect(seen).toEqual([true]);
  });

  it('the suffix aliases of a released path go with it', () => {
    const store = new SignalStore();
    store.register('DB.Start', 'M/Cell/Sig', false, 'PLCOutputBool');
    store.buildIndex();
    expect(store.exactNameForPath('Cell/Sig')).toBe('DB.Start');
    store.unregisterPath('M/Cell/Sig', 'DB.Start');
    expect(store.exactNameForPath('Cell/Sig')).toBeUndefined();
  });
});

describe('register() moves path ownership', () => {
  it('re-registering a path under another name leaves no ghost', () => {
    const store = new SignalStore();
    store.register('Flow.Run', PATH_A, false, 'PLCInputBool');
    store.register('A.Flow.Run', PATH_A, false, 'PLCInputBool');
    expect(store.get('Flow.Run')).toBeUndefined();
    expect(store.registeredPaths('Flow.Run')).toEqual([]);
    expect(store.getPath('A.Flow.Run')).toBe(PATH_A);
    expect(store.exactNameForPath(PATH_A)).toBe('A.Flow.Run');
  });

  it('the old name survives the move when it still has another owner', () => {
    const store = new SignalStore();
    store.register('EStop', PATH_A, false, 'PLCInputBool');
    store.register('EStop', PATH_B, false, 'PLCInputBool');
    store.register('A.EStop', PATH_A, false, 'PLCInputBool');
    expect(store.registeredPaths('EStop')).toEqual([PATH_B]);
    expect(store.getPath('EStop')).toBe(PATH_B);
  });
});

describe('onCatalogChanged — exactly one event per wave', () => {
  function sceneWithSignals() {
    const scene = new Object3D();
    const model = node('Model', scene);
    const cell = node('Cell', model);
    node('Start', cell, plc('PLCOutputBool', 'DB.Start'));
    node('Stop', cell, plc('PLCOutputBool', 'DB.Stop'));
    const registry = new NodeRegistry();
    const store = new SignalStore();
    model.traverse((n) => registry.registerNode(NodeRegistry.computeNodePath(n), n));
    traverseAndRegister(model, registry, store, new Map());
    return { model, cell, registry, store };
  }

  it('collapses every change of a wave into ONE event', () => {
    const { model, cell, registry, store } = sceneWithSignals();
    const log: SignalCatalogChange[] = [];
    store.onCatalogChanged((c) => log.push(c));

    beginSignalSyncWave(store);
    beginSignalSyncWave(store);        // nested — folds into the outer wave
    registry.unregisterSubtree(cell);
    syncSignalSubtree({ signalStore: store, registry }, cell);
    endSignalSyncWave(store);
    expect(log).toHaveLength(0);       // still inside the outer wave
    endSignalSyncWave(store);

    expect(log).toHaveLength(1);
    expect(log[0].removed.slice().sort()).toEqual(['DB.Start', 'DB.Stop']);
    expect(store.get('DB.Start')).toBeUndefined();
    void model;
  });

  it('emits nothing when a wave changed nothing', () => {
    const { registry, store } = sceneWithSignals();
    const log: SignalCatalogChange[] = [];
    store.onCatalogChanged((c) => log.push(c));
    beginSignalSyncWave(store);
    endSignalSyncWave(store);
    expect(log).toHaveLength(0);
    void registry;
  });
});

describe('signal-name-collision', () => {
  beforeEach(() => clearSignalNameCollisionProblems());

  it('two placements of the same asset report ONE warning with both paths', () => {
    const scene = new Object3D();
    const model = node('Model', scene);
    for (const [name, id] of [['Conv', 'p1'], ['Conv_1', 'p2']] as const) {
      const p = node(name, model);
      stampPlacementMarkers(p, id, name, 'Conv');
      node('Sensor', p, plc('PLCOutputBool', 'Occupied'));
    }
    const registry = new NodeRegistry();
    const store = new SignalStore();
    model.traverse((n) => registry.registerNode(NodeRegistry.computeNodePath(n), n));
    traverseAndRegister(model, registry, store, new Map());

    const list = getProblems().filter((p) => p.code === 'signal-name-collision');
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(signalNameCollisionProblemId('Occupied'));
    expect(list[0].severity).toBe('warning');
    expect(list[0].detail).toContain('Model/Conv/Sensor');
    expect(list[0].detail).toContain('Model/Conv_1/Sensor');
  });

  it('a single placement reports nothing', () => {
    const scene = new Object3D();
    const model = node('Model', scene);
    const p = node('Conv', model);
    stampPlacementMarkers(p, 'p1', 'Conv', 'Conv');
    node('Sensor', p, plc('PLCOutputBool', 'Occupied'));
    const registry = new NodeRegistry();
    const store = new SignalStore();
    model.traverse((n) => registry.registerNode(NodeRegistry.computeNodePath(n), n));
    traverseAndRegister(model, registry, store, new Map());
    expect(getProblems().filter((pr) => pr.code === 'signal-name-collision')).toHaveLength(0);
    void store;
  });
});
