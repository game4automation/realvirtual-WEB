// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-589 Test 9.4 — local name vs. runtime name across placements.
 *
 * THE naming rule in one sentence: the persisted `rv_extras.<PLC*>.Name` is
 * asset-local, an AUTHORED signal uses it verbatim as its runtime name, and a
 * GENERATED one (flagged `Generated`, written by `addSignal` /
 * `registerBehaviorSignals`) is instance-scoped exactly once.
 *
 * That split is what makes a save/reload round trip stable: the flag survives
 * the GLB, so a reloaded generated leaf is scoped again from its LOCAL name
 * instead of having a second scope stacked onto an already-scoped one.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { Object3D } from 'three';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { traverseAndRegister } from '../src/core/engine/rv-scene-loader';
import { addSignal, isDuplicateSignalName } from '../src/core/engine/rv-signal-construction';
import { stampNestedPlacementMarkers, stampPlacementMarkers } from '../src/core/engine/rv-placement-instancer';
import { syncSignalSubtree } from '../src/core/engine/rv-signal-editor-sync';
import { sanitizeUserDataForExport } from '../src/core/editor/rv-asset-glb-export';
import { clearSignalNameCollisionProblems, getProblems } from '../src/core/hmi/problems-store';
import { node, plc } from './helpers/signal-sync-fixture';
import { collectModelPlcSignals } from '../src/core/import/rv-plc-automap';
import { reconcileSignals } from '../src/core/import/rv-signal-reconcile';
import type { ConnectInterface, ConnectSignalSchema } from '../src/core/hmi/connect-store';

type Extras = Record<string, Record<string, unknown> | undefined>;

const extrasOf = (n: Object3D, type: string): Record<string, unknown> =>
  (n.userData.realvirtual as Extras)[type] as Record<string, unknown>;

/** A placement root with one authored local signal and one authored global. */
function placement(parent: Object3D, name: string, id: string): Object3D {
  const p = node(name, parent);
  stampPlacementMarkers(p, id, name, 'Conv');
  node('Sensor', p, plc('PLCOutputBool', 'Occupied'));
  node('EStop', p, plc('PLCInputBool', '/EStop'));
  return p;
}

function loadModel(build: (model: Object3D) => void) {
  const scene = new Object3D();
  const model = node('Model', scene);
  build(model);
  const registry = new NodeRegistry();
  const store = new SignalStore();
  model.traverse((n) => registry.registerNode(NodeRegistry.computeNodePath(n), n));
  traverseAndRegister(model, registry, store, new Map());
  return { model, registry, store };
}

const collisions = () => getProblems().filter((p) => p.code === 'signal-name-collision');

describe('placement scope — authored raw, generated scoped once', () => {
  beforeEach(() => clearSignalNameCollisionProblems());

  const twoPlacements = () => {
    const l = loadModel((m) => { placement(m, 'Conv', 'p1'); placement(m, 'Conv_1', 'p2'); });
    const gen = l.model.children.map((p) => addSignal(p, 'Flow.Run', 'PLCInputBool', l.store, l.registry));
    return { ...l, gen };
  };

  it('an authored signal stays RAW in both copies — and the collision is reported', () => {
    const { store } = twoPlacements();
    expect(store.get('Conv.Occupied')).toBeUndefined();
    expect(store.get('Conv_1.Occupied')).toBeUndefined();
    expect(store.get('Occupied')).toBe(false);
    expect(store.registeredPaths('Occupied').slice().sort())
      .toEqual(['Model/Conv/Sensor', 'Model/Conv_1/Sensor']);
    expect(isDuplicateSignalName(store, 'Occupied')).toBe(true);
    const list = collisions();
    expect(list).toHaveLength(1);
    expect(list[0].severity).toBe('warning');
    expect(list[0].title).toContain('"Occupied"');
  });

  it('a generated signal is scoped per copy and persists its asset-local name + flag', () => {
    const { gen } = twoPlacements();
    expect(gen.map((g) => g.name)).toEqual(['Conv.Flow.Run', 'Conv_1.Flow.Run']);
    for (const g of gen) {
      const ext = extrasOf(g.node, 'PLCInputBool');
      expect(ext.Name).toBe('Flow.Run');
      expect(ext.Generated).toBe(true);
    }
  });

  it('nothing is scoped twice', () => {
    const { store } = twoPlacements();
    for (const name of store.getAll().keys()) expect(name).not.toMatch(/^(Conv(_1)?\.){2}/);
  });

  it('an authored "/"-global keeps its slash and is shared, not a collision', () => {
    const { store } = twoPlacements();
    expect(store.registeredPaths('/EStop')).toHaveLength(2);
    expect(collisions().some((p) => p.title.includes('EStop'))).toBe(false);
  });

  it('a "/"-global GENERATED signal is NOT scoped (the slash is stripped)', () => {
    const { model, store, registry } = twoPlacements();
    const h = addSignal(model.children[0], '/Plant.Reset', 'PLCInputBool', store, registry);
    expect(h.name).toBe('Plant.Reset');
    expect(h.node.name).toBe('Plant.Reset');        // no `/` inside the node name
    expect(extrasOf(h.node, 'PLCInputBool').Name).toBe('/Plant.Reset');
  });

  it('a nested placement opens its own scope for generated signals', () => {
    const { model, store, registry } = loadModel((m) => {
      const outer = node('Cell', m);
      stampPlacementMarkers(outer, 'p1', 'Cell', 'Cell');
      const inner = node('Conv', outer);
      stampNestedPlacementMarkers(inner, 'p1', 'p1/n1');
      node('Sensor', inner, plc('PLCOutputBool', 'Occupied'));
      const inner2 = node('Conv_1', outer);
      stampNestedPlacementMarkers(inner2, 'p1', 'p1/n2');
      node('Sensor', inner2, plc('PLCOutputBool', 'Occupied'));
    });
    const outer = model.children[0];
    const a = addSignal(outer.children[0], 'Flow.Run', 'PLCInputBool', store, registry);
    const b = addSignal(outer.children[1], 'Flow.Run', 'PLCInputBool', store, registry);
    // Before plan-589 `instanceScope` walked past the nested root to 'Cell',
    // so both copies produced `Cell.Flow.Run` and collided.
    expect(a.name).toBe('Cell.Conv.Flow.Run');
    expect(b.name).toBe('Cell.Conv_1.Flow.Run');
    expect(isDuplicateSignalName(store, a.name)).toBe(false);
  });

  it('renaming a placement root re-scopes ONLY the generated signals of that copy', () => {
    const { model, store, registry } = twoPlacements();
    const conv = model.children[0];
    conv.name = 'Conv_9';
    registry.recomputePathsForSubtrees([conv]);
    syncSignalSubtree({ signalStore: store, registry }, conv);
    // generated: follows the new scope
    expect(store.get('Conv.Flow.Run')).toBeUndefined();
    expect(store.getPath('Conv_9.Flow.Run')).toBe('Model/Conv_9/Signals/Flow.Run');
    // authored: name untouched, only the path moved
    expect(store.getPath('Occupied')).toBeDefined();
    expect(store.registeredPaths('Occupied')).toEqual(
      expect.arrayContaining(['Model/Conv_9/Sensor', 'Model/Conv_1/Sensor']),
    );
    expect(store.registeredPaths('/EStop')).toEqual(expect.arrayContaining(['Model/Conv_9/EStop']));
  });
});

// ─── Save / reload ──────────────────────────────────────────────────────────

/**
 * Save/reload round trip: JSON clone of every node's userData (what the glTF
 * extras write/read does) plus the REAL export sanitiser, which is the step
 * that would drop a field the validator does not know.
 */
function roundTrip(src: Object3D): Object3D {
  const clone = cloneWithUserData(src);
  sanitizeUserDataForExport(clone);
  return clone;
}

function cloneWithUserData(src: Object3D): Object3D {
  const copy = new Object3D();
  copy.name = src.name;
  copy.userData = JSON.parse(JSON.stringify(src.userData)) as Record<string, unknown>;
  for (const c of src.children) copy.add(cloneWithUserData(c));
  return copy;
}

describe('placement scope — save / reload', () => {
  beforeEach(() => clearSignalNameCollisionProblems());

  /** ONE `Signals` container holding an AUTHORED and a GENERATED leaf. */
  const mixedContainer = () => {
    const l = loadModel((m) => {
      const p = node('Conv', m);
      stampPlacementMarkers(p, 'p1', 'Conv', 'Conv');
      const sig = node('Signals', p);
      // authored leaf: no `Generated` flag
      node('Manual', sig, plc('PLCOutputBool', 'Manual'));
    });
    const gen = addSignal(l.model.children[0], 'Flow.Run', 'PLCInputBool', l.store, l.registry);
    return { ...l, gen };
  };

  it('authored and generated leaves share one container and keep their provenance', () => {
    const { store, gen } = mixedContainer();
    expect(store.getPath('Manual')).toBe('Model/Conv/Signals/Manual');
    expect(gen.name).toBe('Conv.Flow.Run');
    expect(extrasOf(gen.node, 'PLCInputBool').Generated).toBe(true);
  });

  it('an extras round trip reproduces exactly the same catalog — no ghost, no double scope', () => {
    const before = mixedContainer();
    const names = [...before.store.getAll().keys()].sort();
    const after = loadModel((m) => {
      for (const p of before.model.children) {
        const c = roundTrip(p);
        stampPlacementMarkers(c, 'p1', c.name, 'Conv');
        m.add(c);
      }
    });
    // the generator re-runs on load (addSignal is idempotent)
    for (const p of after.model.children) addSignal(p, 'Flow.Run', 'PLCInputBool', after.store, after.registry);
    expect([...after.store.getAll().keys()].sort()).toEqual(names);
    expect(after.store.getPath('Conv.Flow.Run')).toBe('Model/Conv/Signals/Flow.Run');
    expect(after.store.getPath('Manual')).toBe('Model/Conv/Signals/Manual');
    expect(after.store.get('Flow.Run')).toBeUndefined();     // no raw ghost
    expect(after.store.get('Conv.Manual')).toBeUndefined();  // authored never scoped
  });

  it('the real GLB export sanitiser keeps Name and Generated on both leaves', () => {
    const { model } = mixedContainer();
    const exported = roundTrip(model.children[0]);
    const container = exported.children.find((c) => c.name === 'Signals')!;
    const manual = container.children.find((c) => c.name === 'Manual')!;
    const flow = container.children.find((c) => c.name === 'Flow.Run')!;
    expect(extrasOf(manual, 'PLCOutputBool')).toMatchObject({ Name: 'Manual' });
    expect(extrasOf(manual, 'PLCOutputBool').Generated).toBeUndefined();
    expect(extrasOf(flow, 'PLCInputBool')).toMatchObject({ Name: 'Flow.Run', Generated: true });
  });

  it('a legacy leaf without the flag but with an already-scoped Name ends up scoped, with no ghost', () => {
    // What the asset editor wrote BEFORE plan-589: scope '' at authoring time,
    // so `Name` is the scoped name and there is no `Generated` flag.
    const { model, store, registry } = loadModel((m) => {
      for (const [name, id] of [['Conv', 'p1'], ['Conv_1', 'p2']] as const) {
        const p = node(name, m);
        stampPlacementMarkers(p, id, name, 'Conv');
        node('Flow.Run', node('Signals', p), plc('PLCInputBool', 'Flow.Run'));
      }
    });
    // read as authored → raw and colliding
    expect(isDuplicateSignalName(store, 'Flow.Run')).toBe(true);
    // the generator run repairs it: local Name + flag, scoped registration, and
    // `register()` moves path ownership so the raw name is retired.
    for (const p of model.children) addSignal(p, 'Flow.Run', 'PLCInputBool', store, registry);
    expect(store.exactNameForPath('Model/Conv/Signals/Flow.Run')).toBe('Conv.Flow.Run');
    expect(store.exactNameForPath('Model/Conv_1/Signals/Flow.Run')).toBe('Conv_1.Flow.Run');
    expect(store.get('Flow.Run')).toBeUndefined();
    expect(store.getPath('Flow.Run')).toBeUndefined();
  });
});

/**
 * plan-589 F7 (test 9.4, last item) — "Create model signals" from a CONNECT entry.
 *
 * The command writes the CONNECT name VERBATIM into `rv_extras.<PLC*>.Name` and marks nothing as
 * generated, which is the whole claim being tested here: an authored name is the runtime name, so
 * a dotted CONNECT symbol like `Cell.Start` — which LOOKS exactly like a scoped name — must come
 * out as `Cell.Start` and reconcile as exactly `mapped`, inside a placement too.
 */
describe('create model signals from a CONNECT entry', () => {
  /** What `createVerbatimSignalNodes` leaves behind: an authored leaf, name unchanged, no flag. */
  const created = (parent: Object3D, name: string, type = 'PLCOutputBool') =>
    node(name.replace(/[./]/g, '_'), node('Signals', parent), plc(type, name, { OriginDataType: 'Bool' }));

  const ifaceWith = (...names: string[]) => ({
    id: 's7', type: 'S7', enabled: true,
    signals: names.map((n) => ({
      name: n, type: 'PLCOutputBool', dataType: 'Bool', protocolAddress: 'DB10.DBX4.1', record: false,
    })),
  }) as unknown as ConnectInterface;

  const REQUIRED = { addressRule: { signals: 'required' } } as unknown as ConnectSignalSchema;

  it('registers the dotted CONNECT name verbatim and reports exactly mapped', () => {
    const { store, registry } = loadModel((m) => { created(m, 'Cell.Start'); });
    // Raw, NOT scoped — and not mistaken for a scoped `Start` under `Cell` either.
    expect(store.exactNameForPath('Model/Signals/Cell_Start')).toBe('Cell.Start');

    const model = collectModelPlcSignals({ registry });
    expect(model.map((x) => [x.name, x.localName])).toEqual([['Cell.Start', 'Cell.Start']]);

    const report = reconcileSignals(model, ifaceWith('Cell.Start'), REQUIRED);
    expect(report.counts).toMatchObject({ mapped: 1, 'name-variant': 0, 'missing-in-plc': 0, 'plc-only': 0 });
    expect(report.entries[0].category).toBe('mapped');
  });

  it('stays mapped inside a placement — an authored name is never scoped', () => {
    const { store, registry } = loadModel((m) => {
      const p = node('Conv', m);
      stampPlacementMarkers(p, 'p1', 'Conv', 'Conv');
      created(p, 'Cell.Start');
    });
    expect(store.exactNameForPath('Model/Conv/Signals/Cell_Start')).toBe('Cell.Start');
    expect(reconcileSignals(collectModelPlcSignals({ registry }), ifaceWith('Cell.Start'), REQUIRED)
      .entries[0].category).toBe('mapped');
  });
});
