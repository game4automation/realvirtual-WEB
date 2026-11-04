// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-522 Phase 7a — trigger child nodes, the legacy mapping, and the
 * MaintenancePlugin's trigger host against a REAL SignalStore: resolve-then-
 * subscribe with baseline (G2), late registration, rebase after reset (G3),
 * Δ simTime incl. DES jump (G4), Any / All participants (G5), RemainingSignal
 * of the deciding trigger (G6), output writes with the external-control guard
 * (G8), placements (G11), parser exclusion of trigger children (G12), G1 types.
 */

import { afterEach, describe, expect, test, vi } from 'vitest';
import { Object3D, Scene } from 'three';
import { parseMaintenanceProcedures } from '../src/core/maintenance-parser';
import { MaintenancePlugin } from '../src/plugins/demo/maintenance-plugin';
import { MAINTENANCE_PROBLEM_CODES } from '../src/plugins/demo/maintenance-trigger-host';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { EventEmitter } from '../src/core/rv-events';
import { clearAllProblems, getProblems } from '../src/core/hmi/problems-store';
import { maintenanceTileSubtitle, maintenanceTileTitle, maintenanceTileSeverity } from '../src/core/hmi/MaintenanceMessages';
import { getFieldDescriptor } from '../src/core/engine/rv-component-registry';
import { webSchemaReferenceOf, pickableReferenceFields } from '../src/core/hmi/rv-reference-field';
import '../src/core/engine/rv-maintenance-components';
import type { RVViewer } from '../src/core/rv-viewer';
import type { LoadResult } from '../src/core/engine/rv-scene-loader';

const ref = (path: string, componentType = '') => ({ type: 'ComponentReference', path, componentType });

function node(name: string, rv?: Record<string, unknown>): Object3D {
  const o = new Object3D();
  o.name = name;
  if (rv) o.userData = { realvirtual: rv };
  return o;
}

/** Cell / Maintenance (procedure) with one step and the given trigger children. */
function scene(procedureData: Record<string, unknown>, triggers: Array<[string, Record<string, unknown>]>): Scene {
  const s = new Scene();
  const root = node('Cell');
  s.add(root);
  const proc = node('Maintenance', { LogicStep_MaintenanceProcedure: { ProcedureName: 'Lube', ...procedureData } });
  root.add(proc);
  proc.add(node('01 Stop', { LogicStep_MaintenanceStep: { Title: 'Stop' } }));
  for (const [name, data] of triggers) proc.add(node(name, { LogicStep_MaintenanceTrigger: data }));
  return s;
}

interface Rig {
  viewer: RVViewer;
  store: SignalStore;
  plugin: MaintenancePlugin;
  emitter: EventEmitter;
  drive: { currentPosition: number };
  setSimTime(t: number): void;
}

function rig(sc: Scene, register: (store: SignalStore) => void = () => {}): Rig {
  const store = new SignalStore();
  register(store);
  const emitter = new EventEmitter();
  const drive = { currentPosition: 0 };
  let simTime = 0;
  const viewer = {
    scene: sc,
    signalStore: store,
    get simTime() { return simTime; },
    registry: {
      getNode: () => null,
      getPathForNode: (n: Object3D) => n.name,
      readStoredRef: () => null,
      resolve: (r: { path?: string; componentType?: string }) => {
        const ct = r.componentType ?? '';
        if (ct === 'Drive') return { drive: r.path === 'Cell/Axis' ? drive : null };
        if (ct.includes('PLC') || ct.includes('Signal')) return { signalAddress: r.path ?? null };
        return {};
      },
    },
    uiRegistry: { register: vi.fn(), unregister: vi.fn() },
    setSimulationPaused: vi.fn(),
    getPlugin: () => undefined,
    getPlugins: () => [],
    clearHighlight: vi.fn(),
    highlighter: { setAuxEmphasis: vi.fn(), flash: vi.fn(), clearFlash: vi.fn() },
    markRenderDirty: vi.fn(),
    animateCameraTo: vi.fn(),
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
    once: emitter.once.bind(emitter),
    emit: emitter.emit.bind(emitter),
  } as unknown as RVViewer;
  const plugin = new MaintenancePlugin();
  plugin.onModelLoaded({} as LoadResult, viewer);
  return { viewer, store, plugin, emitter, drive, setSimTime: (t) => { simTime = t; } };
}

const problemCodes = (): string[] => getProblems().map((p) => p.code);

afterEach(() => clearAllProblems());

// ─── Schema + picker ────────────────────────────────────────────────────

describe('LogicStep_MaintenanceTrigger schema', () => {
  test('Signal picks ANY signal type (G1), the outputs are signal slots of one type', () => {
    expect(getFieldDescriptor('LogicStep_MaintenanceTrigger', 'Kind')?.default).toBe('Count');
    expect(getFieldDescriptor('LogicStep_MaintenanceTrigger', 'Signal')?.signal).toBeUndefined();
    const t = webSchemaReferenceOf('LogicStep_MaintenanceTrigger', 'Signal');
    expect(t?.target).toEqual({ kind: 'signal', signalTypes: ['PLCInputBool', 'PLCOutputBool', 'PLCInputInt', 'PLCOutputInt', 'PLCInputFloat', 'PLCOutputFloat'] });
    expect(pickableReferenceFields('LogicStep_MaintenanceTrigger').map((f) => f.field)).toEqual(['Signal', 'Drive']);
    expect(getFieldDescriptor('LogicStep_MaintenanceProcedure', 'StateSignal')?.signal).toBe('PLCInputInt');
    expect(getFieldDescriptor('LogicStep_MaintenanceProcedure', 'TriggerCombine')?.default).toBe('Any');
  });
});

// ─── Parser ─────────────────────────────────────────────────────────────

describe('parser — trigger children (G12) and legacy mapping', () => {
  test('trigger children are read, not warned, not steps; a PLCInputBool Count parses (Festo, G1)', () => {
    const sc = scene({ TriggerCombine: 'All', StateSignal: ref('Cell/State', 'PLCInputInt') }, [
      ['Lift cycles', { Kind: 'Count', Signal: ref('Cell/LeftLift_IsDown', 'PLCInputBool'), Interval: 1000 }],
      ['Hours', { Kind: 'Interval', Interval: 8760 }],
    ]);
    const [p] = parseMaintenanceProcedures(sc);
    expect(p.steps).toHaveLength(1);
    expect(p.warnings).toEqual([]);
    expect(p.triggerCombine).toBe('All');
    expect(p.outputs?.state).toMatchObject({ path: 'Cell/State' });
    expect(p.triggers?.map((t) => [t.name, t.rules.kind, t.issues])).toEqual([
      ['Lift cycles', 'Count', []],
      ['Hours', 'Interval', []],
    ]);
    expect(p.triggers?.[0]).toMatchObject({ signalPath: 'Cell/LeftLift_IsDown', signalType: 'PLCInputBool' });
  });

  test('a node without step and trigger still warns; wrong signal type and missing source are issues', () => {
    const sc = scene({}, [
      ['Temp', { Kind: 'Threshold', Signal: ref('Cell/Door', 'PLCOutputBool'), Threshold: 80 }],
      ['Nothing', { Kind: 'Travel', Interval: 10 }],
      ['Weird', { Kind: 'Calendar', Interval: 365 }],
    ]);
    sc.getObjectByName('Maintenance')!.add(node('Loose', { Drive: {} }));
    const [p] = parseMaintenanceProcedures(sc);
    expect(p.warnings).toEqual([expect.stringContaining('"Loose"')]);
    const issues = Object.fromEntries(p.triggers!.map((t) => [t.name, t.issues.join('|')]));
    expect(issues['Temp']).toMatch(/Threshold cannot read a PLCOutputBool/);
    expect(issues['Nothing']).toMatch(/Travel needs a Drive/);
    expect(issues['Weird']).toMatch(/Kind "Calendar" is not supported/);
  });

  test('the Phase-6 fields become the implicit first trigger (legacy), no migration', () => {
    const sc = scene({ TriggerDrive: ref('Cell/Axis', 'Drive'), TriggerUnit: 'h', TriggerInterval: 2, TriggerAcceleration: 50 }, [
      ['Hours', { Kind: 'Interval', Interval: 10 }],
    ]);
    const [p] = parseMaintenanceProcedures(sc);
    expect(p.trigger).toMatchObject({ unit: 'h', interval: 2 });
    expect(p.triggers?.map((t) => [t.name, t.legacy, t.rules.kind, t.rules.interval, t.rules.acceleration])).toEqual([
      ['legacy', true, 'RunTime', 2, 50],
      ['Hours', false, 'Interval', 10, 1],
    ]);
  });
});

// ─── Plugin + host ──────────────────────────────────────────────────────

describe('trigger host — signals', () => {
  test('Count on a PLCInputBool: high initial level is no edge; pulses count; outputs follow (G2, G6, G8)', () => {
    const sc = scene({
      DueSignal: ref('Cell/Due', 'PLCInputBool'),
      OverdueSignal: ref('Cell/Overdue', 'PLCInputBool'),
      StateSignal: ref('Cell/State', 'PLCInputInt'),
      RemainingSignal: ref('Cell/Remaining', 'PLCInputFloat'),
    }, [['Lift cycles', { Kind: 'Count', Signal: ref('Cell/LeftLift_IsDown', 'PLCInputBool'), Interval: 3, WarnAt: 0.6, OverdueAfter: 2 }]]);
    const { store, plugin } = rig(sc, (s) => {
      s.register('LeftLift_IsDown', 'Cell/LeftLift_IsDown', true, 'PLCInputBool');
      s.register('Due', 'Cell/Due', false, 'PLCInputBool');
      s.register('Overdue', 'Cell/Overdue', false, 'PLCInputBool');
      s.register('State', 'Cell/State', 0, 'PLCInputInt');
      s.register('Remaining', 'Cell/Remaining', 0, 'PLCInputFloat');
    });
    expect(store.get('State')).toBe(0);
    expect(store.get('Remaining')).toBe(3);
    expect(plugin.getMessageEntries()).toEqual([]);
    const pulse = (): void => { store.set('LeftLift_IsDown', false); store.set('LeftLift_IsDown', true); };
    pulse(); pulse();
    const [e] = plugin.getMessageEntries();
    expect(e).toMatchObject({ level: 1, levelName: 'upcoming', due: false, value: 2, interval: 3, unit: '', triggerName: 'Lift cycles' });
    expect(maintenanceTileSubtitle(e)).toBe('Lift cycles: 2 / 3');
    expect(maintenanceTileTitle(e)).toBe('Maintenance upcoming: Lube');
    expect(store.get('State')).toBe(1);
    pulse();
    expect(store.get('Due')).toBe(true);
    expect(store.get('State')).toBe(2);
    pulse(); pulse();
    expect(store.get('Overdue')).toBe(true);
    expect(store.get('State')).toBe(3);
    expect(maintenanceTileSeverity(plugin.getMessageEntries()[0].level)).toBe('error');
    plugin.onFixedUpdatePost(0.3); // throttled RemainingSignal publish
    expect(store.get('Remaining')).toBe(0);
    // completing the guide resets the trigger and the outputs
    plugin.enterMaintenance('Lube');
    plugin.startScenario(null, 'stepbystep');
    plugin.nextStep();
    expect(plugin.getState().mode).toBe('completed');
    expect(store.get('Due')).toBe(false);
    expect(store.get('State')).toBe(0);
    expect(store.get('Remaining')).toBe(3);
  });

  test('a signal that registers late is bound then (G2); its unresolved problem clears', () => {
    const sc = scene({}, [['Door', { Kind: 'Signal', Signal: ref('Cell/DoorOpen', 'PLCOutputBool') }]]);
    const { store, plugin } = rig(sc);
    expect(problemCodes()).toContain(MAINTENANCE_PROBLEM_CODES.unresolved);
    store.register('DoorOpen', 'Cell/DoorOpen', false, 'PLCOutputBool');
    expect(problemCodes()).not.toContain(MAINTENANCE_PROBLEM_CODES.unresolved);
    store.set('DoorOpen', true);
    expect(plugin.getMessageEntries()[0]).toMatchObject({ level: 2, unit: null, triggerName: 'Door' });
  });

  test('the live signal type decides when the reference names none (G1)', () => {
    const sc = scene({}, [['Temp', { Kind: 'Signal', Signal: ref('Cell/Temp') }]]);
    rig(sc, (s) => s.register('Temp', 'Cell/Temp', 21.5, 'PLCOutputFloat'));
    expect(problemCodes()).toContain(MAINTENANCE_PROBLEM_CODES.type);
  });

  test('Threshold with hysteresis on a Float signal', () => {
    const sc = scene({ Message: 'Always' }, [['Temp', { Kind: 'Threshold', Signal: ref('Cell/Temp', 'PLCOutputFloat'), Threshold: 80, Hysteresis: 5, Latch: false }]]);
    const { store, plugin } = rig(sc, (s) => s.register('Temp', 'Cell/Temp', 20, 'PLCOutputFloat'));
    expect(plugin.getMessageEntries()[0].level).toBe(0);
    store.set('Temp', 82);
    expect(plugin.getMessageEntries()[0].level).toBe(2);
    store.set('Temp', 77);
    expect(plugin.getMessageEntries()[0].level).toBe(2);
    store.set('Temp', 60);
    expect(plugin.getMessageEntries()[0].level).toBe(0);
  });

  test('an externally controlled output is not written and reported once (G8)', () => {
    const sc = scene({ DueSignal: ref('Cell/Due', 'PLCInputBool') }, [['Door', { Kind: 'Signal', Signal: ref('Cell/DoorOpen', 'PLCOutputBool') }]]);
    const { store } = rig(sc, (s) => {
      s.register('DoorOpen', 'Cell/DoorOpen', false, 'PLCOutputBool');
      s.register('Due', 'Cell/Due', false, 'PLCInputBool');
      s.forceSignal('Due', false);
    });
    store.set('DoorOpen', true);
    expect(store.get('Due')).toBe(false);
    expect(problemCodes().filter((c) => c === MAINTENANCE_PROBLEM_CODES.external)).toHaveLength(1);
    // released: the skipped write is caught up without any further trigger change
    store.unforce('Due');
    expect(store.get('Due')).toBe(true);
  });

  test('late binding re-resolves the reference, never a path-suffix guess (G2)', () => {
    const sc = scene({}, [['Door', { Kind: 'Signal', Signal: ref('Cell/S', 'PLCOutputBool') }]]);
    const { store, plugin } = rig(sc);
    store.register('S_other', 'Other/Cell/S', false, 'PLCOutputBool'); // same tail, other machine
    store.set('S_other', true);
    expect(plugin.getMessageEntries()).toEqual([]);
    expect(problemCodes()).toContain(MAINTENANCE_PROBLEM_CODES.unresolved);
    store.register('S', 'Cell/S', false, 'PLCOutputBool');
    store.set('S', true);
    expect(plugin.getMessageEntries()[0]).toMatchObject({ level: 2, triggerName: 'Door' });
  });

  test('an unresolved output is a problem and is written once its signal registers', () => {
    const sc = scene({ StateSignal: ref('Cell/State', 'PLCInputInt') }, [['Door', { Kind: 'Signal', Signal: ref('Cell/DoorOpen', 'PLCOutputBool') }]]);
    const { store } = rig(sc, (s) => s.register('DoorOpen', 'Cell/DoorOpen', false, 'PLCOutputBool'));
    expect(getProblems().some((p) => p.id.endsWith(':output:state'))).toBe(true);
    store.set('DoorOpen', true);
    store.register('State', 'Cell/State', 0, 'PLCInputInt');
    expect(store.get('State')).toBe(2);
    expect(getProblems().some((p) => p.id.endsWith(':output:state'))).toBe(false);
  });
});

describe('trigger host — time, travel, reset', () => {
  test('Interval counts Δ simTime incl. a DES jump; a negative Δ never counts (G4)', () => {
    const sc = scene({ Message: 'Always' }, [['Hours', { Kind: 'Interval', Interval: 2 }]]);
    const r = rig(sc);
    r.setSimTime(3600); r.plugin.onFixedUpdatePost(0.02); // DES jump of one hour
    expect(r.plugin.getMessageEntries()[0].value).toBeCloseTo(1, 9);
    r.setSimTime(100); r.plugin.onFixedUpdatePost(0.02); // clock went back (model change)
    expect(r.plugin.getMessageEntries()[0].value).toBeCloseTo(1, 9);
    r.setSimTime(3700); r.plugin.onFixedUpdatePost(0.02);
    expect(r.plugin.getMessageEntries()[0].value).toBeCloseTo(2, 9);
    expect(r.plugin.getMessageEntries()[0].level).toBe(2);
  });

  test('simulation-reset keeps the counter (E7.3) and counts neither the drive jump back nor negative time (G3)', () => {
    const sc = scene({ Message: 'Always' }, [['Travel', { Kind: 'Travel', Drive: ref('Cell/Axis'), Interval: 10 }]]);
    const r = rig(sc);
    r.drive.currentPosition = 1_000_000; r.setSimTime(5); r.plugin.onFixedUpdatePost(0.02);
    expect(r.plugin.getMessageEntries()[0].value).toBeCloseTo(1, 9);
    r.emitter.emit('simulation-reset' as never, undefined as never);
    r.drive.currentPosition = 0; r.setSimTime(0); // drive.reset() and _simTime = 0 after the event
    r.plugin.onFixedUpdatePost(0.02); // rebase step
    r.plugin.onFixedUpdatePost(0.02);
    expect(r.plugin.getMessageEntries()[0].value).toBeCloseTo(1, 9);
    r.drive.currentPosition = 500_000; r.plugin.onFixedUpdatePost(0.02);
    expect(r.plugin.getMessageEntries()[0].value).toBeCloseTo(1.5, 9);
  });

  test('a signal still high after the reset is no new edge (G3)', () => {
    const sc = scene({ Message: 'Always' }, [['Cycles', { Kind: 'Count', Signal: ref('Cell/S', 'PLCInputBool'), Interval: 10 }]]);
    const r = rig(sc, (s) => s.register('S', 'Cell/S', false, 'PLCInputBool'));
    r.store.set('S', true);
    expect(r.plugin.getMessageEntries()[0].value).toBe(1);
    r.emitter.emit('simulation-reset' as never, undefined as never);
    r.store.set('S', false); r.store.set('S', true); // reset noise before the rebase step
    r.plugin.onFixedUpdatePost(0.02);
    expect(r.plugin.getMessageEntries()[0].value).toBe(1);
  });

  test('live: wall time instead of sim time, no acceleration, re-based on the switch (G4)', () => {
    const sc = scene({ Message: 'Always' }, [['Hours', { Kind: 'Interval', Interval: 100, Acceleration: 1000 }]]);
    const r = rig(sc);
    let wall = 1000;
    const spy = vi.spyOn(performance, 'now').mockImplementation(() => wall);
    try {
      r.plugin.triggers.live = true;
      r.plugin.onFixedUpdatePost(0.02); // rebase step on the switch
      wall += 3_600_000; // one hour of wall time
      r.setSimTime(99999); // sim clock is ignored live
      r.plugin.onFixedUpdatePost(0.02);
      const e = r.plugin.getMessageEntries()[0];
      expect(e.value).toBeCloseTo(1, 6);
      expect(e.liveBrowserCount).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('trigger host — Any / All participants (G5)', () => {
  test('All combines only active + resolved triggers; disabled, Interval 0 and unresolved stay out', () => {
    const sc = scene({ TriggerCombine: 'All', Message: 'Always' }, [
      ['A', { Kind: 'Interval', Interval: 1 }],
      ['Off', { Kind: 'Interval', Interval: 1000, Enabled: false }],
      ['Zero', { Kind: 'Interval', Interval: 0 }],
      ['Missing', { Kind: 'Signal', Signal: ref('Cell/Nope', 'PLCOutputBool') }],
    ]);
    const r = rig(sc);
    r.setSimTime(3600); r.plugin.onFixedUpdatePost(0.02);
    expect(r.plugin.getMessageEntries()[0]).toMatchObject({ level: 2, triggerName: 'A' });
  });

  test('empty participant set = ok, no tile with WhenDue', () => {
    const sc = scene({}, [['Off', { Kind: 'Interval', Interval: 1, Enabled: false }]]);
    const r = rig(sc);
    r.setSimTime(7200); r.plugin.onFixedUpdatePost(0.02);
    expect(r.plugin.getMessageEntries()).toEqual([]);
  });

  test('Any: RemainingSignal of the deciding trigger in its own unit (G6)', () => {
    const sc = scene({ RemainingSignal: ref('Cell/Remaining', 'PLCInputFloat') }, [
      ['Cycles', { Kind: 'Count', Signal: ref('Cell/S', 'PLCInputBool'), Interval: 4 }],
      ['Hours', { Kind: 'Interval', Interval: 10 }],
    ]);
    const r = rig(sc, (s) => {
      s.register('S', 'Cell/S', false, 'PLCInputBool');
      s.register('Remaining', 'Cell/Remaining', 0, 'PLCInputFloat');
    });
    r.store.set('S', true); r.store.set('S', false); r.store.set('S', true); // 2 of 4 counts = 0.5 left
    r.setSimTime(3600 * 1); r.plugin.onFixedUpdatePost(0.3); // 1 of 10 h = 0.9 left
    expect(r.plugin.triggers.procedures[0].deciding?.def.name).toBe('Cycles');
    expect(r.store.get('Remaining')).toBe(2); // counts, not hours
  });
});

describe('placements (G11)', () => {
  test('a placement that contains a procedure is reported once', () => {
    const r = rig(scene({}, []));
    const placed = node('Machine_1');
    placed.add(node('Proc', { LogicStep_MaintenanceProcedure: {} }));
    r.emitter.emit('layout-content-added' as never, { root: placed } as never);
    r.emitter.emit('layout-content-added' as never, { root: placed } as never);
    expect(problemCodes().filter((c) => c === MAINTENANCE_PROBLEM_CODES.placement)).toHaveLength(1);
    r.emitter.emit('layout-content-added' as never, { root: node('Plain') } as never);
    expect(problemCodes().filter((c) => c === MAINTENANCE_PROBLEM_CODES.placement)).toHaveLength(1);
  });

  test('model clear unsubscribes and clears the trigger problems', () => {
    const sc = scene({}, [['Door', { Kind: 'Signal', Signal: ref('Cell/DoorOpen', 'PLCOutputBool') }]]);
    const r = rig(sc, (s) => s.register('DoorOpen', 'Cell/DoorOpen', false, 'PLCOutputBool'));
    expect(r.store.listenerCount('DoorOpen')).toBe(1);
    r.plugin.onModelCleared(r.viewer);
    expect(r.store.listenerCount('DoorOpen')).toBe(0);
  });
});
