// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-589 — placement naming and the pre-sync editor behaviour.
 *
 * Part A pins the LOADER / PLACEMENT rules against the production loader. Where
 * plan-589 deliberately keeps what was measured before the spike, the
 * expectation is unchanged and the test name states the rule (authored names
 * stay raw; two identical placements really do collide, which is now reported;
 * an authored `/`-global keeps its slash). Where plan-589 deliberately CHANGES
 * the measurement — generated signals persist their asset-local name plus a
 * `Generated` flag, nested placements open their own scope, and the reload ghost
 * is fixed — the expectation states the new rule.
 *
 * Part B runs the editor executors with the sync switched OFF
 * (`setSignalEditorSyncEnabled(false)`), i.e. exactly the pre-plan-589 executor
 * behaviour, so the kill switch stays honest. The target behaviour of the same
 * cases lives in `signal-editor-sync.node.test.ts`.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Object3D } from 'three';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { traverseAndRegister } from '../src/core/engine/rv-scene-loader';
import {
  addSignal, isDuplicateSignalName,
} from '../src/core/engine/rv-signal-construction';
import { stampPlacementMarkers, stampNestedPlacementMarkers } from '../src/core/engine/rv-placement-instancer';
import { instanceScope } from '../src/core/engine/rv-instance-scope';
import { setSignalEditorSyncEnabled } from '../src/core/engine/rv-signal-editor-sync';
import { clearSignalNameCollisionProblems, getProblems } from '../src/core/hmi/problems-store';
import { IDENTITY, fwd, head, inv, makeSyncFixture, node, plc } from './helpers/signal-sync-fixture';

// ─── A. Loader / placements (legacy name policy) ─────────────────────────────

function placement(parent: Object3D, name: string, id: string): Object3D {
  const p = node(name, parent);
  stampPlacementMarkers(p, id, name, 'Conv');
  // authored, asset-local PLC signal inside the placed asset
  node('Sensor', p, plc('PLCOutputBool', 'Occupied'));
  node('EStop', p, plc('PLCInputBool', '/EStop'));
  return p;
}

function loadScene(build: (model: Object3D) => void) {
  const scene = new Object3D();
  scene.name = '';
  const model = node('Model', scene);
  build(model);
  const registry = new NodeRegistry();
  const store = new SignalStore();
  model.traverse((n) => registry.registerNode(NodeRegistry.computeNodePath(n), n));
  traverseAndRegister(model, registry, store, new Map());
  return { model, registry, store };
}

describe('A — authored PLC signals in placements', () => {
  beforeAll(() => clearSignalNameCollisionProblems());

  it('an authored Name inside a LayoutObject placement is registered RAW, never scoped', () => {
    const { store } = loadScene((m) => { placement(m, 'Conv', 'p1'); });
    expect(store.get('Occupied')).toBe(false);
    expect(store.get('Conv.Occupied')).toBeUndefined();
    expect(store.getPath('Occupied')).toBe('Model/Conv/Sensor');
  });

  it('two identical placements collide on the raw authored name — and that is reported', () => {
    clearSignalNameCollisionProblems();
    const { store } = loadScene((m) => { placement(m, 'Conv', 'p1'); placement(m, 'Conv_1', 'p2'); });
    expect(store.getPath('Occupied')).toBe('Model/Conv_1/Sensor');
    expect(store.exactNameForPath('Model/Conv/Sensor')).toBe('Occupied');
    expect(isDuplicateSignalName(store, 'Occupied')).toBe(true);
    // plan-589: keeping authored names raw is the user's decision; the price is
    // a warning instead of silence.
    const collisions = getProblems().filter((p) => p.code === 'signal-name-collision');
    expect(collisions).toHaveLength(1);
    expect(collisions[0].title).toContain('"Occupied"');
    expect(collisions[0].detail).toContain('Model/Conv/Sensor');
    expect(collisions[0].detail).toContain('Model/Conv_1/Sensor');
    clearSignalNameCollisionProblems();
  });

  it('an authored "/"-global name is registered WITH the slash, and is not a collision', () => {
    clearSignalNameCollisionProblems();
    const { store } = loadScene((m) => { placement(m, 'Conv', 'p1'); });
    expect(store.get('/EStop')).toBe(false);
    expect(store.get('EStop')).toBeUndefined();
    expect(getProblems().filter((p) => p.code === 'signal-name-collision')).toHaveLength(0);
  });

  it('generated addSignal() inside a placement is scoped once — and persists the ASSET-LOCAL name', () => {
    const { model, registry, store } = loadScene((m) => { placement(m, 'Conv', 'p1'); placement(m, 'Conv_1', 'p2'); });
    const a = addSignal(model.children[0], 'Flow.Run', 'PLCInputBool', store, registry);
    const b = addSignal(model.children[1], 'Flow.Run', 'PLCInputBool', store, registry);
    expect(a.name).toBe('Conv.Flow.Run');
    expect(b.name).toBe('Conv_1.Flow.Run');
    const ext = (a.node.userData.realvirtual as Record<string, { Name: string; Generated: boolean }>).PLCInputBool;
    // plan-589: persisted name is asset-local + flagged as generated, so a
    // reload re-derives the scope instead of scoping an already-scoped name.
    expect(ext.Name).toBe('Flow.Run');
    expect(ext.Generated).toBe(true);
  });

  // The LEGACY case: a leaf saved from the asset editor (scope '') before
  // plan-589 carries a scoped `Name` and NO `Generated` flag. The loader must
  // read it as authored (raw, colliding) — and the generator re-running on load
  // then takes path ownership over, which is what retires the raw name instead
  // of leaving it behind as the reload ghost.
  it('a legacy generated leaf without the flag reloads raw, and the generator run retires the raw name', () => {
    const { model, registry, store } = loadScene((m) => {
      for (const [name, id] of [['Conv', 'p1'], ['Conv_1', 'p2']] as const) {
        const p = node(name, m);
        stampPlacementMarkers(p, id, name, 'Conv');
        // what the asset editor (no LayoutObject → scope '') wrote into the GLB
        const sig = node('Signals', p);
        node('Flow.Run', sig, plc('PLCInputBool', 'Flow.Run'));
      }
    });
    // loader: both placements registered the raw saved name on their leaf path
    expect(isDuplicateSignalName(store, 'Flow.Run')).toBe(true);
    // behaviour provisioning re-runs on the same leaf
    addSignal(model.children[0], 'Flow.Run', 'PLCInputBool', store, registry);
    addSignal(model.children[1], 'Flow.Run', 'PLCInputBool', store, registry);
    expect(store.exactNameForPath('Model/Conv/Signals/Flow.Run')).toBe('Conv.Flow.Run');
    // pre-spike: ghost; now: the raw name lost both owner paths and is gone
    expect(store.get('Flow.Run')).toBeUndefined();
    expect(store.getPath('Flow.Run')).toBeUndefined();
  });

  it('a NESTED placement root opens its own scope — the chain, outermost first', () => {
    const outer = node('Cell', null);
    stampPlacementMarkers(outer, 'p1', 'Cell', 'Cell');
    const nested = node('Conv', outer);
    stampNestedPlacementMarkers(nested, 'p1', 'p1/n1');
    const leaf = node('Sensor', nested);
    // A nested root carries `_layoutNestedOf` and NO LayoutObject stamp; before
    // plan-589 `instanceScope` walked straight past it to 'Cell', so two
    // identical nested references collided.
    expect(instanceScope(leaf)).toBe('Cell.Conv');
  });
});

// ─── B. Editor mutations, sync OFF (= pre-plan-589 executors) ────────────────

describe('B — editor mutations with the sync kill switch off', () => {
  beforeAll(() => setSignalEditorSyncEnabled(false));
  afterAll(() => setSignalEditorSyncEnabled(true));

  const build = () => makeSyncFixture((root) => {
    const cell = node('Cell', root);
    node('Start', cell, plc('PLCOutputBool', 'DB.Start', { Comment: 'old' }));
  });

  it('GAP: addComponent PLCOutputBool does not register', async () => {
    const f = build();
    await fwd(f, { ...head(), kind: 'addComponent', nodePath: 'Asset/Cell', componentType: 'PLCInputBool', fields: { Name: 'DB.New', Status: { Value: false } } });
    expect(f.store.get('DB.New')).toBeUndefined();
  });

  it('GAP: removeComponent leaves the signal registered', async () => {
    const f = build();
    const op = { ...head(), kind: 'removeComponent' as const, nodePath: 'Asset/Cell/Start', componentType: 'PLCOutputBool', prevFields: { Name: 'DB.Start' } };
    await fwd(f, op);
    expect(f.store.get('DB.Start')).toBe(false);
    expect(f.store.exactNameForPath('Asset/Cell/Start')).toBe('DB.Start');
  });

  it('GAP: deleting the PARENT leaves the trashed signal registered under its old path', async () => {
    const f = build();
    await fwd(f, { ...head(), kind: 'deleteNode', nodePath: 'Asset/Cell' });
    expect(f.registry.getNode('Asset/Cell/Start')).toBeNull();
    expect(f.store.getPath('DB.Start')).toBe('Asset/Cell/Start');
  });

  it('GAP: renaming the signal node keeps the OLD path, the new one does not resolve', async () => {
    const f = build();
    await fwd(f, { ...head(), kind: 'renameNode', nodePath: 'Asset/Cell/Start', name: 'Go', prevName: 'Start' });
    expect(f.store.exactNameForPath('Asset/Cell/Go')).toBeUndefined();
    expect(f.store.getPath('DB.Start')).toBe('Asset/Cell/Start');
  });

  it('GAP: renaming a PARENT keeps the old path', async () => {
    const f = build();
    await fwd(f, { ...head(), kind: 'renameNode', nodePath: 'Asset/Cell', name: 'Cell2', prevName: 'Cell' });
    expect(f.store.getPath('DB.Start')).toBe('Asset/Cell/Start');
  });

  it('reparent already carries the canonical path (remapPaths) — but the suffix alias of the old path survives', async () => {
    const f = build();
    node('Other', f.root);
    f.registry.registerNode('Asset/Other', f.root.children[1]);
    await fwd(f, {
      ...head(), kind: 'reparentNode', nodePath: 'Asset/Cell/Start', newParentPath: 'Asset/Other',
      transform: IDENTITY, prevParentPath: 'Asset/Cell', prevIndex: 0, prevTransform: IDENTITY,
    });
    expect(f.store.getPath('DB.Start')).toBe('Asset/Other/Start');
    // buildIndex() suffix entry of the OLD path still resolves
    expect(f.store.exactNameForPath('Cell/Start')).toBe('DB.Start');
  });

  it('GAP: setField Comment does not reach the store meta; undo does not either', async () => {
    const f = build();
    const op = { ...head(), kind: 'setField' as const, nodePath: 'Asset/Cell/Start', componentType: 'PLCOutputBool', fieldName: 'Comment', value: 'new', prev: 'old' };
    await fwd(f, op);
    expect(f.store.getSignalMeta('DB.Start')?.comment).toBe('old');
    await inv(f, op);
    expect(f.store.getSignalMeta('DB.Start')?.comment).toBe('old');
  });
});
