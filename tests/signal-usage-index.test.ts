// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * signal-usage-index — plan-566 Phase 1 (the signal cross-reference list).
 *
 *  1. Component fields: schema signal slots / signal reference fields / the
 *     wire componentType → `component-field` with the field name.
 *  2. Logic steps (Bool AND Float) → `logic-step`; a SetSignal step writes.
 *  3. Scope: two placements with the same asset-relative path each resolve to
 *     their OWN signal; a legacy name match is `byName`; a dead path is
 *     `resolved: false` (R5).
 *  4. String signal fields (WebSensor.SignalBool / SignalInt, ConnectSignal) (R6).
 *  5. Operator panel config → `operator-panel`; binding inventory → `binding`
 *     (incl. an orphan); CONNECT bridges → `connect-mapping`, including a
 *     bridge for a signal without a scene node and without a planner binding (R2-1).
 *  6. Invalidation through REAL mutations on a real viewer: a live inspector
 *     edit, a SceneStore setField op (+ undo, the usage moves and comes back), a binding-manager change, an
 *     operator panel added at runtime, and the model clear (F5, R4).
 *
 * Synthetic fixtures (plain Object3D + registerNode + userData.realvirtual),
 * modelled on rv-node-registry-signal-binding.test.ts.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { Group, Object3D } from 'three';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import {
  buildSignalUsageIndex,
  collectBindingUsages,
  collectComponentUsages,
  collectConnectBridgeUsages,
  collectOperatorPanelUsages,
  globMatches,
  groupSignalUsages,
  SignalUsageService,
  type SignalUsage,
  type SignalUsageProvider,
} from '../src/core/engine/rv-signal-usage-index';
import { ensureSignalUsageWiring } from '../src/core/hmi/use-signal-usages';
import { applyLiveEdit } from '../src/core/hmi/rv-value-resolver';
import { SignalBindingManager } from '../src/core/engine/rv-signal-binding-manager';
import { RVWebOperatorPanel } from '../src/core/engine/rv-web-operator-panel';
import { RVWebSensor } from '../src/core/engine/rv-web-sensor';
import { initSceneStore } from '../src/core/hmi/scene/scene-store-singleton';
import { freshOpId } from '../src/core/ops/rv-op-utils';
import { createTestViewer, type TestViewerHandle } from './helpers/create-test-viewer';
import '../src/core/engine/rv-lamp';
import '../src/core/engine/rv-drive-simple';
import '../src/core/engine/rv-drive-cylinder';

// ── Fixture helpers ──────────────────────────────────────────────────────────

function ref(path: string, componentType?: string): Record<string, unknown> {
  return componentType === undefined
    ? { type: 'ComponentReference', path }
    : { type: 'ComponentReference', path, componentType };
}

interface Fixture {
  reg: NodeRegistry;
  store: SignalStore;
  scene: Group;
}

function fixture(): Fixture {
  return { reg: new NodeRegistry(), store: new SignalStore(), scene: new Group() };
}

/** Adds a node under `parent`, registers it (and its component types) and returns it. */
function add(f: Fixture, parent: Object3D, name: string, realvirtual?: Record<string, unknown>): Object3D {
  const node = new Object3D();
  node.name = name;
  parent.add(node);
  const path = NodeRegistry.computeNodePath(node);
  if (realvirtual) {
    node.userData.realvirtual = realvirtual;
    for (const [type, data] of Object.entries(realvirtual)) {
      if (data && typeof data === 'object' && !Array.isArray(data)) f.reg.register(type, path, {});
    }
  }
  f.reg.registerNode(path, node);
  return node;
}

/** A PLC signal node registered in the store under `name`. */
function signal(f: Fixture, parent: Object3D, nodeName: string, name: string, type = 'PLCOutputBool'): Object3D {
  const node = add(f, parent, nodeName, { [type]: { Name: name } });
  f.store.register(name, NodeRegistry.computeNodePath(node), type.endsWith('Bool') ? false : 0, type);
  return node;
}

function index(f: Fixture, ...extra: SignalUsageProvider[]) {
  return buildSignalUsageIndex([
    { collect: (sink) => collectComponentUsages({ registry: f.reg, signalStore: f.store }, sink) },
    { collect: (sink) => collectOperatorPanelUsages({ registry: f.reg, signalStore: f.store }, sink) },
    ...extra,
  ]);
}

const pick = (u: readonly SignalUsage[]) => u.map((x) => ({ kind: x.kind, field: x.field, nodePath: x.nodePath }));

// ── 1. Component fields ──────────────────────────────────────────────────────

describe('component fields', () => {
  it('Drive_Simple.Forward, Drive_Cylinder.Out and Lamp.SignalLampOn are component-field usages', () => {
    const f = fixture();
    const cell = add(f, f.scene, 'Cell');
    const io = add(f, cell, 'IO');
    signal(f, io, 'ConvFwd', 'ConvFwd', 'PLCOutputBool');
    signal(f, io, 'CylOut', 'CylOut', 'PLCOutputBool');
    signal(f, io, 'LampOn', 'LampOn', 'PLCOutputBool');
    add(f, cell, 'Conveyor', { Drive_Simple: { Forward: ref('Cell/IO/ConvFwd', 'realvirtual.PLCOutputBool') } });
    add(f, cell, 'Cylinder', { Drive_Cylinder: { Out: ref('Cell/IO/CylOut', 'realvirtual.PLCOutputBool') } });
    // No wire componentType: the Lamp schema (componentRef + signal) alone must say "signal".
    add(f, cell, 'Lamp', { Lamp: { SignalLampOn: ref('Cell/IO/LampOn') } });

    const idx = index(f);
    expect(pick(idx.get('ConvFwd'))).toEqual([{ kind: 'component-field', field: 'Forward', nodePath: 'Cell/Conveyor' }]);
    expect(pick(idx.get('CylOut'))).toEqual([{ kind: 'component-field', field: 'Out', nodePath: 'Cell/Cylinder' }]);
    expect(pick(idx.get('LampOn'))).toEqual([{ kind: 'component-field', field: 'SignalLampOn', nodePath: 'Cell/Lamp' }]);
    expect(idx.get('ConvFwd')[0]).toMatchObject({ resolved: true, signalPath: 'Cell/IO/ConvFwd', componentType: 'Drive_Simple' });
  });

  it('a non-signal reference (a Drive) is not a signal usage', () => {
    const f = fixture();
    const cell = add(f, f.scene, 'Cell');
    add(f, cell, 'Axis', { Drive: {} });
    add(f, cell, 'Step', { LogicStep_DriveTo: { drive: ref('Cell/Axis', 'realvirtual.Drive') } });
    expect(index(f).names()).toEqual([]);
  });

  it('a signal node does not count as a usage of itself', () => {
    const f = fixture();
    signal(f, add(f, f.scene, 'Cell'), 'Sig', 'Sig');
    expect(index(f).count('Sig')).toBe(0);
  });
});

// ── 2. Logic steps ───────────────────────────────────────────────────────────

describe('logic steps', () => {
  it('SetSignalBool / WaitForSignalBool / JumpOnSignal / SetSignalFloat are logic-step usages', () => {
    const f = fixture();
    const cell = add(f, f.scene, 'Cell');
    const io = add(f, cell, 'IO');
    signal(f, io, 'Start', 'Start', 'PLCInputBool');
    signal(f, io, 'Speed', 'Speed', 'PLCInputFloat');
    const seq = add(f, cell, 'Seq');
    add(f, seq, 'Set', { LogicStep_SetSignalBool: { Signal: ref('Cell/IO/Start', 'realvirtual.PLCInputBool'), SetToTrue: true } });
    add(f, seq, 'Wait', { LogicStep_WaitForSignalBool: { Signal: ref('Cell/IO/Start', 'realvirtual.PLCInputBool') } });
    add(f, seq, 'Jump', { LogicStep_JumpOnSignal: { Signal: ref('Cell/IO/Start', 'realvirtual.PLCInputBool') } });
    add(f, seq, 'SetSpeed', { LogicStep_SetSignalFloat: { Signal: ref('Cell/IO/Speed', 'realvirtual.PLCInputFloat'), Value: 2 } });

    const idx = index(f);
    const start = idx.get('Start');
    expect(start.map((u) => u.kind)).toEqual(['logic-step', 'logic-step', 'logic-step']);
    expect(start.map((u) => u.label).sort()).toEqual(['Jump', 'Set', 'Wait']);
    expect(start.find((u) => u.label === 'Set')!.written).toBe(true);
    expect(idx.get('Speed')).toEqual([expect.objectContaining({ kind: 'logic-step', label: 'SetSpeed', detail: 'SetSignalFloat.Signal' })]);
  });
});

// ── 3. Scope (R5) ────────────────────────────────────────────────────────────

describe('scope and resolution (plan-757 F7, R5)', () => {
  function twoPlacements(): Fixture {
    const f = fixture();
    const layout = add(f, f.scene, 'Layout');
    for (const id of ['Cell_1', 'Cell_2']) {
      const root = add(f, layout, id);
      const signals = add(f, root, 'Signals');
      signal(f, signals, 'Start', `${id}.Start`);
      f.reg.registerScopeNames(root, ['Cell']);
    }
    return f;
  }

  it('two placements with the same asset-relative path each land on their own signal', () => {
    const f = twoPlacements();
    for (const id of ['Cell_1', 'Cell_2']) {
      add(f, f.reg.getNode(`Layout/${id}`)!, 'Conveyor', {
        Drive_Simple: { Forward: ref('Cell/Signals/Start', 'realvirtual.PLCOutputBool') },
      });
    }
    const idx = index(f);
    expect(idx.get('Cell_1.Start').map((u) => [u.nodePath, u.signalPath])).toEqual([['Layout/Cell_1/Conveyor', 'Layout/Cell_1/Signals/Start']]);
    expect(idx.get('Cell_2.Start').map((u) => [u.nodePath, u.signalPath])).toEqual([['Layout/Cell_2/Conveyor', 'Layout/Cell_2/Signals/Start']]);
  });

  it('a legacy hierarchy resolves by name inside the scope (byName); a dead path stays unresolved', () => {
    const f = twoPlacements();
    add(f, f.reg.getNode('Layout/Cell_2')!, 'Conveyor', {
      Drive_Simple: {
        Forward: ref('Old/Hierarchy/Start', 'realvirtual.PLCOutputBool'),
        Backward: ref('Nowhere/Missing', 'realvirtual.PLCOutputBool'),
      },
    });
    const idx = index(f);
    expect(idx.get('Cell_2.Start')).toEqual([expect.objectContaining({ field: 'Forward', resolved: true, byName: true })]);
    expect(idx.get('Missing')).toEqual([expect.objectContaining({ field: 'Backward', resolved: false, signalPath: 'Nowhere/Missing' })]);
  });
});

// ── 4. String signal fields (R6) ─────────────────────────────────────────────

describe('string signal fields', () => {
  it('WebSensor.SignalBool / SignalInt and ConnectSignal name the signal by string', () => {
    const f = fixture();
    const cell = add(f, f.scene, 'Cell');
    signal(f, cell, 'Occ', 'Occ');
    signal(f, cell, 'State', 'State', 'PLCOutputInt');
    add(f, cell, 'Marker', { WebSensor: { SignalBool: 'Occ', SignalInt: 'State', Label: 'Occ' } });
    add(f, cell, 'Copy', { ConnectSignal: { ConnectedSignal: 'Cell/Occ' } });

    const idx = index(f);
    expect(idx.get('Occ').map((u) => [u.componentType, u.field, u.byName])).toEqual([
      ['ConnectSignal', 'ConnectedSignal', true],
      ['WebSensor', 'SignalBool', true],
    ]);
    expect(idx.get('State').map((u) => u.field)).toEqual(['SignalInt']);
    // `Label` is not a signal field even though its value equals a signal name.
    expect(idx.get('Occ').some((u) => u.field === 'Label')).toBe(false);
  });
});

// ── 5. Operator panel, bindings, CONNECT bridges ─────────────────────────────

const PANEL = {
  version: 1, id: 'op', title: 'Station 4',
  selectors: [{ row: 1, col: 1, label: 'MODE', variant: 'knob', signal: 'BT2_OpMode',
    positions: [{ legend: 'H', value: false }, { legend: 'A', value: true }],
    lamp: { signal: 'HL_Auto', color: 'green' } }],
  buttons: [{ row: 1, col: 2, label: 'Start', signal: 'BT_Start', capColor: 'green' }],
  estops: [],
  stackLight: [{ name: 'Red', signal: 'HL_Red', color: 'red' }],
  status: [{ kind: 'fault', tone: 'fault', text: 'Fault', when: { signal: 'Fault', is: true } }],
};

describe('operator panel, bindings, CONNECT bridges', () => {
  it('every element of a WebOperatorPanel config is an operator-panel usage', () => {
    const f = fixture();
    add(f, add(f, f.scene, 'Cell'), 'Panel', { WebOperatorPanel: { Config: JSON.stringify(PANEL) } });
    const idx = index(f);
    expect(idx.get('BT2_OpMode')).toEqual([expect.objectContaining({ kind: 'operator-panel', label: 'Station 4', detail: 'Selector MODE', written: true })]);
    expect(idx.get('HL_Auto')[0].detail).toBe('Selector MODE lamp');
    expect(idx.get('BT_Start')[0].detail).toBe('Button Start');
    expect(idx.get('HL_Red')[0]).toMatchObject({ detail: 'Stack light Red' });
    expect(idx.get('HL_Red')[0].written).toBeUndefined();
    expect(idx.get('Fault')[0].detail).toBe('Status fault condition');
    expect(idx.get('Fault')[0].nodePath).toBe('Cell/Panel');
  });

  it('binding inventory rows and orphans are binding usages', () => {
    const idx = buildSignalUsageIndex([{
      collect: (sink) => collectBindingUsages({
        rows: [{ targetId: 't1', targetLabel: 'Conveyor 1', componentPath: 'Layout/Conveyor_1', slot: 'Forward', direction: 'plcOutput', signal: 'DB1.Fwd', interfaceId: 'plcsim-1' }],
        orphans: [{ targetId: 't2', targetLabel: 'Conveyor 2', slot: 'Forward', signal: 'DB1.Fwd' }],
      }, sink),
    }]);
    expect(idx.get('DB1.Fwd').map((u) => [u.kind, u.label, u.resolved])).toEqual([
      ['binding', 'Conveyor 1', true],
      ['binding', 'Conveyor 2', false],
    ]);
    expect(idx.get('DB1.Fwd')[0]).toMatchObject({ detail: 'Forward ← plcsim-1', nodePath: 'Layout/Conveyor_1' });
  });

  it('a CONNECT bridge indexes source AND destination — no scene node, no planner binding (R2-1)', () => {
    const idx = buildSignalUsageIndex([{
      collect: (sink) => collectConnectBridgeUsages({
        mappings: [{ enabled: true, sourceSignal: 'PLC_A.Out', destSignal: 'MQTT.Out' }],
        mirrors: [{ enabled: false, sourceInterfaceId: 's7', targetInterfaceId: 'mqtt', signalPattern: 'Conv*' }],
      }, [{ id: 's7', signals: [{ name: 'ConvStart' }, { name: 'Other' }] }], sink),
    }]);
    expect(idx.get('PLC_A.Out')).toEqual([expect.objectContaining({ kind: 'connect-mapping', connectBridgeKey: 'mapping:0', detail: '1:1 source' })]);
    expect(idx.get('MQTT.Out')).toEqual([expect.objectContaining({ connectBridgeKey: 'mapping:0', written: true })]);
    expect(idx.get('ConvStart')).toEqual([expect.objectContaining({ connectBridgeKey: 'mirror:0', detail: 'pattern Conv* · disabled' })]);
    expect(idx.count('Other')).toBe(0);
  });

  it('glob matching follows the mirror-rule rules', () => {
    expect(globMatches('*', 'x')).toBe(true);
    expect(globMatches('DB?.*', 'DB1.Start')).toBe(true);
    expect(globMatches('DB?.*', 'DB10.Start')).toBe(false);
    expect(globMatches('a.b', 'aXb')).toBe(false);
  });

  it('groups come out in display order', () => {
    const f = fixture();
    const cell = add(f, f.scene, 'Cell');
    signal(f, cell, 'S', 'S', 'PLCInputBool');
    add(f, cell, 'Step', { LogicStep_WaitForSignalBool: { Signal: ref('Cell/S', 'realvirtual.PLCInputBool') } });
    add(f, cell, 'Drive', { Drive_Simple: { Forward: ref('Cell/S', 'realvirtual.PLCInputBool') } });
    const groups = groupSignalUsages(index(f).get('S'));
    expect(groups.map((g) => g.kind)).toEqual(['component-field', 'logic-step']);
  });
});

// ── 6. Service: lazy, versioned, invalidated by real mutations ───────────────

describe('SignalUsageService', () => {
  it('builds lazily, once per invalidation, and notifies once per microtask', async () => {
    const service = new SignalUsageService();
    let n = 0;
    service.registerProvider('p', { collect: (sink) => { n++; sink.add({ kind: 'binding', signal: 'X', label: 'x', resolved: true }); } });
    await Promise.resolve();
    expect(n).toBe(0); // nothing built until somebody reads
    expect(service.count('X')).toBe(1);
    expect(service.count('X')).toBe(1);
    expect(n).toBe(1);
    let notified = 0;
    service.subscribe(() => notified++);
    const v = service.version;
    service.invalidate();
    service.invalidate();
    service.invalidate();
    await Promise.resolve();
    expect(notified).toBe(1);
    expect(service.version).toBe(v + 1);
    service.count('X');
    expect(n).toBe(2);
  });
});

describe('real viewer — invalidation through real mutations (F5, R4)', () => {
  let handle: TestViewerHandle | null = null;
  afterEach(() => { handle?.dispose(); handle = null; });

  async function viewerWithScene() {
    handle = await createTestViewer('webgl');
    const viewer = handle.viewer;
    const reg = new NodeRegistry();
    const store = new SignalStore();
    viewer.registry = reg;
    viewer.signalStore = store;
    const root = new Object3D();
    root.name = 'Cell';
    const f: Fixture = { reg, store, scene: new Group() };
    f.scene.add(root);
    reg.registerNode('Cell', root);
    signal(f, root, 'A', 'SigA');
    signal(f, root, 'B', 'SigB');
    const sensor = add(f, root, 'Sensor', { WebSensor: { SignalBool: 'SigA' } });
    ensureSignalUsageWiring(viewer);
    viewer.signalUsage.invalidate();
    await Promise.resolve();
    return { viewer, reg, store, root, sensor, f };
  }

  const tick = () => new Promise<void>((r) => setTimeout(r, 0));

  it('a live inspector edit (component-field-changed) invalidates the index', async () => {
    const { viewer, reg, sensor } = await viewerWithScene();
    // A real WebSensor instance: applyLiveEdit only pushes SCALAR schema fields.
    const live = new RVWebSensor(sensor);
    reg.register('WebSensor', 'Cell/Sensor', live);
    expect(viewer.signalUsage.count('SigA')).toBe(1);
    const v = viewer.signalUsage.version;
    applyLiveEdit(viewer, 'Cell/Sensor', 'WebSensor', 'IntStateMap', '0=Low;1=High');
    await tick();
    expect(viewer.signalUsage.version).toBeGreaterThan(v);
  });

  it('a SceneStore setField op moves the usage, its undo moves it back', async () => {
    const { viewer } = await viewerWithScene();
    const sceneStore = initSceneStore(viewer);
    expect(viewer.signalUsage.count('SigA')).toBe(1); // a reader attaches the SceneStore subscription
    const v = viewer.signalUsage.version;
    await sceneStore.applyOp({
      id: freshOpId(), ts: Date.now(), schemaV: 1, kind: 'setField',
      nodePath: 'Cell/Sensor', componentType: 'WebSensor', fieldName: 'SignalBool', value: 'SigB', prev: 'SigA',
    });
    await tick();
    const afterOp = viewer.signalUsage.version;
    expect(afterOp).toBeGreaterThan(v);
    expect(viewer.signalUsage.count('SigA')).toBe(0);
    expect(viewer.signalUsage.count('SigB')).toBe(1);
    await sceneStore.undo();
    await tick();
    expect(viewer.signalUsage.version).toBeGreaterThan(afterOp);
    expect(viewer.signalUsage.count('SigA')).toBe(1);
    expect(viewer.signalUsage.count('SigB')).toBe(0);
  });

  it('a binding-manager change invalidates the index', async () => {
    const { viewer, store, reg } = await viewerWithScene();
    viewer.signalBindingManager = new SignalBindingManager(store, reg);
    viewer.signalUsage.count('SigA'); // a reader attaches the manager listener
    const v = viewer.signalUsage.version;
    viewer.signalBindingManager.unbindAll('anything');
    await tick();
    expect(viewer.signalUsage.version).toBeGreaterThan(v);
  });

  it('an operator panel added at runtime appears without a reload', async () => {
    const { viewer, f, root } = await viewerWithScene();
    expect(viewer.signalUsage.count('BT_Start')).toBe(0);
    const node = add(f, root, 'Panel', { WebOperatorPanel: { Config: JSON.stringify(PANEL) } });
    const panel = new RVWebOperatorPanel(node);
    panel.Config = JSON.stringify(PANEL);
    f.reg.register('WebOperatorPanel', 'Cell/Panel', panel);
    panel.init(); // the component announces itself → host rescan → index invalidated
    await tick();
    await tick();
    expect(viewer.signalUsage.count('BT_Start')).toBe(1);
  });

  it('the model clear drops the cached index', async () => {
    const { viewer } = await viewerWithScene();
    expect(viewer.signalUsage.count('SigA')).toBe(1);
    const builds = viewer.signalUsage.buildCount;
    viewer.emit('model-cleared');
    viewer.registry = null;
    await tick();
    expect(viewer.signalUsage.count('SigA')).toBe(0);
    expect(viewer.signalUsage.buildCount).toBe(builds + 1);
  });
});
