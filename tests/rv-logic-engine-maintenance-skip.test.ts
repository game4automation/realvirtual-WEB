// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-logic-engine-maintenance-skip.test.ts — plan-522 §9.1 / F2: a maintenance
 * procedure (node with `LogicStep_MaintenanceProcedure`) and its whole subtree
 * never become logic in the web engine — at load, for placements (also with a
 * running engine), after a simulation reset and on an Inspector edit — while
 * the plan-538 root rules of the regular roots stay exactly as they were.
 *
 * Fixtures follow tests/logic-root-active-only.test.ts: GLB-shaped node trees,
 * REAL registered signals and drives, references in the object form
 * `{ type: 'ComponentReference', path, componentType }` (a path string would be
 * dropped silently and let the test pass without the filter). The procedure's
 * own steps sit (a) on step nodes next to `LogicStep_MaintenanceStep` and (b)
 * under a plain folder node — (b) has no LogicStep parent and would be a
 * running root without the filter, so it is what proves the filter.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { Object3D } from 'three';
import { RVLogicEngine } from '../src/core/engine/rv-logic-engine';
import { NodeRegistry, type ComponentRef } from '../src/core/engine/rv-node-registry';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { RVDrive, DriveDirection } from '../src/core/engine/rv-drive';
import { RVTransportManager } from '../src/core/engine/rv-transport-manager';
import { mergePlacedLogic, type PlacementHost } from '../src/core/engine/rv-placement-integrate';
import { RVSerialContainer, StepState } from '../src/core/engine/rv-logic-step';
import { resetSlotAuthority, setRemoteOwnershipActive } from '../src/core/engine/rv-slot-authority';
import { RVViewer } from '../src/core/rv-viewer';
import { MAINTENANCE_PROCEDURE_TYPE } from '../src/core/engine/rv-maintenance-components';

const DT = 1 / 60;

afterEach(() => {
  resetSlotAuthority();
  setRemoteOwnershipActive(false);
  vi.restoreAllMocks();
});

// ─── GLB-shaped fixture helpers (pattern of logic-root-active-only.test.ts) ──

type Extras = Record<string, unknown>;

function nd(name: string, parent: Object3D | null, extras?: Extras): Object3D {
  const n = new Object3D();
  n.name = name;
  if (parent) parent.add(n);
  if (extras) n.userData.realvirtual = extras;
  return n;
}

const sigRef = (path: string): ComponentRef => ({ type: 'ComponentReference', path, componentType: 'realvirtual.PLCOutputBool' });
const driveRef = (path: string): ComponentRef => ({ type: 'ComponentReference', path, componentType: 'realvirtual.Drive' });

const serial = (active?: string): Extras => ({ LogicStep_SerialContainer: active ? { Active: active } : {} });
const setBoolData = (path: string, value = true) => ({ Signal: sigRef(path), SetToTrue: value });
const setBool = (path: string, value = true): Extras => ({ LogicStep_SetSignalBool: setBoolData(path, value) });
const delay = (s: number): Extras => ({ LogicStep_Delay: { Duration: s } });
const driveToData = (path: string, dest: number) => ({ drive: driveRef(path), Destination: dest });
const driveTo = (path: string, dest: number): Extras => ({ LogicStep_DriveTo: driveToData(path, dest) });

interface World {
  scene: Object3D;
  registry: NodeRegistry;
  store: SignalStore;
  drives: Record<string, RVDrive>;
  engine: RVLogicEngine;
  signal(name: string, initial?: boolean): string;
  drive(name: string, start?: number): RVDrive;
  drivePath(name: string): string;
  register(container: Object3D): void;
  add(container: Object3D): number;
  tick(n?: number): void;
}

function world(): World {
  const scene = nd('Cell', null);
  const sig = nd('Sig', scene);
  const axes = nd('Axes', scene);
  const registry = new NodeRegistry();
  const store = new SignalStore();
  const drives: Record<string, RVDrive> = {};
  const engine = new RVLogicEngine();
  const w: World = {
    scene, registry, store, drives, engine,
    signal(name, initial = false) {
      const n = nd(name, sig);
      const path = NodeRegistry.computeNodePath(n);
      registry.registerNode(path, n);
      store.register(path, path, initial, 'PLCOutputBool');
      return path;
    },
    drive(name, start = 0) {
      const n = nd(name, axes);
      const d = new RVDrive(n);
      d.Direction = DriveDirection.LinearX;
      d.StartPosition = start;
      d.TargetSpeed = 100;
      d.UseAcceleration = false;
      d.UseLimits = false;
      d.initDrive();
      const path = NodeRegistry.computeNodePath(n);
      registry.registerNode(path, n);
      registry.register('Drive', path, d);
      drives[name] = d;
      return d;
    },
    drivePath(name) {
      return NodeRegistry.computeNodePath(drives[name].node);
    },
    register(container) {
      if (!container.parent) scene.add(container);
      container.traverse((n) => registry.registerNode(NodeRegistry.computeNodePath(n), n));
    },
    add(container) {
      w.register(container);
      return engine.addSubtree(container, registry, store);
    },
    tick(n = 1) {
      for (let i = 0; i < n; i++) {
        engine.fixedUpdate(DT);
        for (const d of Object.values(drives)) d.update(DT);
      }
    },
  };
  return w;
}

function root(parent: Object3D, name: string, active: string | undefined, steps: [string, Extras][]): Object3D {
  const r = nd(name, parent, serial(active));
  for (const [n, e] of steps) nd(n, r, e);
  return r;
}

function rootStep(engine: RVLogicEngine, name: string): RVSerialContainer {
  const r = engine.roots.find((s) => s.name === name);
  if (!r) throw new Error(`no root "${name}"`);
  return r as RVSerialContainer;
}

/**
 * A maintenance procedure as the web editor authors it: step nodes carry
 * `LogicStep_MaintenanceStep` + action components (also `_N` keys); a plain
 * folder below the procedure holds an action node WITHOUT a LogicStep parent.
 */
interface ProcedureRefs { signal: string; drive?: string; folderSignal: string }

function procedure(parent: Object3D, refs: ProcedureRefs, name = 'Maintenance'): { proc: Object3D; step: Object3D; deep: Object3D } {
  const proc = nd(name, parent, { [MAINTENANCE_PROCEDURE_TYPE]: { ProcedureName: 'Clean nozzles' } });
  const step: Extras = {
    LogicStep_MaintenanceStep: { Title: 'Open doors' },
    LogicStep_SetSignalBool: setBoolData(refs.signal),
  };
  if (refs.drive) {
    step.LogicStep_DriveTo = driveToData(refs.drive, 100);
    step.LogicStep_DriveTo_1 = driveToData(refs.drive, 50);
  }
  const stepNode = nd('03 Open doors', proc, step);
  const folder = nd('Folder', proc);
  const deep = nd('Deep', folder, setBool(refs.folderSignal));
  if (refs.drive) nd('DeepMove', folder, driveTo(refs.drive, 100));
  return { proc, step: stepNode, deep };
}

const pathOf = (n: Object3D) => NodeRegistry.computeNodePath(n);

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('plan-522 §9.1 — the logic engine skips maintenance procedures', () => {
  it('positive control: the same action components WITHOUT a procedure ancestor run', () => {
    const w = world();
    const out = w.signal('Out');
    const asset = nd('Asset', null);
    const deep = nd('Deep', asset, setBool(out));
    expect(w.add(asset)).toBe(1);
    w.engine.start(false);
    w.tick(2);
    expect(w.store.getBoolByPath(out)).toBe(true);
    expect(w.engine.stepByPath.has(pathOf(deep))).toBe(true);
  });

  it('filter: no root, no stepByPath entry, signals untouched, drives not commanded', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const w = world();
    const out = w.signal('Out');
    const deepOut = w.signal('DeepOut');
    const axis = w.drive('Door', 0);
    const asset = nd('Asset', null);
    const { proc, step, deep } = procedure(asset, { signal: out, drive: w.drivePath('Door'), folderSignal: deepOut });
    expect(w.add(asset)).toBe(0);
    w.engine.start(false);
    w.tick(30);
    expect(w.engine.roots).toHaveLength(0);
    for (const n of [proc, step, deep]) expect(w.engine.stepByPath.has(pathOf(n)), pathOf(n)).toBe(false);
    expect(w.engine.stepByPath.size).toBe(0);
    expect(w.store.getBoolByPath(out)).toBe(false);
    expect(w.store.getBoolByPath(deepOut)).toBe(false);
    expect(axis.isRunning).toBe(false);
    expect(axis.currentPosition).toBe(0);
    expect(w.engine.warnings).toEqual([]);
    // Skipped, not attempted: no "Unknown step type" for the procedure / step keys.
    expect(warn.mock.calls.some((c) => String(c[0]).includes('Unknown step type'))).toBe(false);
  });

  it('a subtree that itself lies inside a procedure adds nothing', () => {
    const w = world();
    const deepOut = w.signal('DeepOut');
    const out = w.signal('Out');
    const asset = nd('Asset', null);
    const { deep } = procedure(asset, { signal: out, folderSignal: deepOut });
    w.register(asset);
    w.engine.start(false);
    expect(w.engine.addSubtree(deep.parent!, w.registry, w.store)).toBe(0);
    w.tick(2);
    expect(w.store.getBoolByPath(deepOut)).toBe(false);
  });

  it('plan-538 root rules stay: F1f/F1g warnings identical with and without the procedure; no ownership', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const build = (withProcedure: boolean) => {
      const w = world();
      const shared = w.signal('Shared');
      const procOnly = w.signal('ProcOnly');
      w.drive('Shared', 50);
      const pAxis = w.drivePath('Shared');
      const asset = nd('Asset', null);
      root(asset, 'Real', 'Connected', [['Move', driveTo(pAxis, 100)], ['SetShared', setBool(shared)], ['W', delay(10)]]);
      root(asset, 'Virtual', 'Disconnected', [['Move', driveTo(pAxis, 0)], ['SetShared', setBool(shared)], ['W', delay(10)]]);
      root(asset, 'Off', 'Never', [['W', delay(10)]]);
      // The procedure acts on the SAME shared output and drive and on its own
      // output: as roots its `Always` actions would add overlap warnings.
      if (withProcedure) procedure(asset, { signal: procOnly, drive: pAxis, folderSignal: shared });
      w.add(asset);
      return { w, shared, procOnly };
    };
    const plain = build(false);
    const mixed = build(true);
    expect(plain.w.engine.warnings.length).toBeGreaterThan(0); // the regular overlap warnings exist
    expect(mixed.w.engine.warnings).toEqual(plain.w.engine.warnings);
    expect(mixed.w.engine.roots.map((r) => r.name)).toEqual(['Real', 'Virtual', 'Off']);

    // Lifecycle of the regular roots unchanged: disconnected → Virtual runs.
    mixed.w.engine.start(false);
    mixed.w.tick(5);
    expect(rootStep(mixed.w.engine, 'Virtual').state).toBe(StepState.Active);
    expect(rootStep(mixed.w.engine, 'Real').state).toBe(StepState.Idle);
    expect(rootStep(mixed.w.engine, 'Off').state).toBe(StepState.Idle);

    // No ownership: the owned-output reset never touches the procedure's own signal.
    mixed.w.store.setByPath(mixed.procOnly, true);
    mixed.w.engine.resetOwnedOutputs();
    expect(mixed.w.store.getBoolByPath(mixed.procOnly)).toBe(true);
    // … while the regular owned output still goes back to its start value.
    expect(mixed.w.store.getBoolByPath(mixed.shared)).toBe(false);
  });

  it('placements: a placed procedure starts nothing on a running engine; remove + re-add likewise', () => {
    const w = world();
    const out = w.signal('Out');
    const deepOut = w.signal('DeepOut');
    const regularOut = w.signal('RegularOut');
    w.engine.start(false);
    const host = { registry: w.registry, signalStore: w.store, logicEngine: w.engine, connectionState: 'Disconnected' } as unknown as PlacementHost;

    const placeOnce = (name: string) => {
      const asset = nd(name, w.scene);
      procedure(asset, { signal: out, folderSignal: deepOut });
      nd('Regular', asset, setBool(regularOut));
      w.register(asset);
      mergePlacedLogic(host, asset);
      return asset;
    };

    const first = placeOnce('Placed_1');
    w.tick(3);
    expect(w.engine.roots.map((r) => r.name)).toEqual(['Regular']);
    expect(w.store.getBoolByPath(regularOut)).toBe(true); // the placement's regular logic did start
    expect(w.store.getBoolByPath(out)).toBe(false);
    expect(w.store.getBoolByPath(deepOut)).toBe(false);

    expect(w.engine.removeSubtree(first)).toBe(1);
    w.scene.remove(first);
    w.store.setByPath(regularOut, false);
    placeOnce('Placed_1');
    w.tick(3);
    expect(w.engine.roots.map((r) => r.name)).toEqual(['Regular']);
    expect(w.store.getBoolByPath(regularOut)).toBe(true);
    expect(w.store.getBoolByPath(out)).toBe(false);
    expect(w.store.getBoolByPath(deepOut)).toBe(false);
  });

  it('placements without an engine yet: mergePlacedLogic creates one that holds no procedure root', () => {
    const w = world();
    const out = w.signal('Out');
    const deepOut = w.signal('DeepOut');
    const asset = nd('Placed_2', w.scene);
    procedure(asset, { signal: out, folderSignal: deepOut });
    w.register(asset);
    const host = { registry: w.registry, signalStore: w.store, logicEngine: null as RVLogicEngine | null, connectionState: 'Disconnected' } as unknown as PlacementHost;
    mergePlacedLogic(host, asset);
    const engine = host.logicEngine!;
    expect(engine.roots).toHaveLength(0);
    engine.fixedUpdate(DT);
    expect(w.store.getBoolByPath(out)).toBe(false);
    expect(w.store.getBoolByPath(deepOut)).toBe(false);
  });

  it('reset (production resetSimulation, real RVTransportManager): regular roots restart, the procedure stays inert', () => {
    const w = world();
    const regularOut = w.signal('RegularOut');
    const out = w.signal('Out');
    const deepOut = w.signal('DeepOut');
    w.drive('Door', 0);
    const asset = nd('Asset', null);
    root(asset, 'Plain', undefined, [['SetA', setBool(regularOut)], ['Tail', delay(100)]]);
    procedure(asset, { signal: out, drive: w.drivePath('Door'), folderSignal: deepOut });
    w.add(asset);

    const tm = new RVTransportManager();
    const order: string[] = [];
    const fake = {
      _structuralEditHolds: () => false, // plan-681: resetSimulation asks whether a structural transaction withholds it
      _simTime: 3,
      drives: Object.values(w.drives),
      chainManager: { resetAll() {} },
      ribbonManager: { resetAll() {} },
      blockageWatch: { reset() {} }, // plan-2038: resetSimulation clears the blockage watch
      transportManager: tm,
      logicEngine: w.engine,
      logicRunState: 'active',
      _kernel: null,
      connectionState: 'Disconnected' as const,
      statisticsManager: { resetAll() {} },
      signalReapply: { reapplyAll() { order.push('reapply'); } },
      emit(event: string) { order.push(event); },
    };
    const reset = () => (RVViewer.prototype.resetSimulation as unknown as (this: typeof fake) => void).call(fake);

    w.engine.start(false);
    w.tick(3);
    expect(w.store.getBoolByPath(regularOut)).toBe(true);
    // An operator sets the procedure's signal by hand — not engine-owned.
    w.store.setByPath(out, true);

    reset();
    w.tick(3);
    expect(order).toEqual(['simulation-reset', 'simulation-resetstat', 'simulation-start', 'reapply']);
    expect(w.engine.roots.map((r) => r.name)).toEqual(['Plain']);
    expect(rootStep(w.engine, 'Plain').state).toBe(StepState.Active);
    expect(w.store.getBoolByPath(regularOut)).toBe(true);
    expect(w.store.getBoolByPath(out)).toBe(true); // not reset, not re-set: untouched
    expect(w.store.getBoolByPath(deepOut)).toBe(false);
    expect(w.drives.Door.isRunning).toBe(false);
    expect(w.drives.Door.currentPosition).toBe(0);
  });

  it('reapplyStepFields on a procedure step node builds nothing and returns false', () => {
    const w = world();
    const out = w.signal('Out');
    const deepOut = w.signal('DeepOut');
    const asset = nd('Asset', null);
    const { step, deep } = procedure(asset, { signal: out, folderSignal: deepOut });
    w.add(asset);
    w.engine.start(false);
    const before = w.engine.stats;
    expect(w.engine.reapplyStepFields(pathOf(step), 'LogicStep_SetSignalBool', { SetToTrue: false })).toBe(false);
    expect(w.engine.reapplyStepFields(pathOf(deep), 'LogicStep_SetSignalBool', { SetToTrue: true })).toBe(false);
    expect(w.engine.stats).toEqual(before);
    expect(w.engine.roots).toHaveLength(0);
    expect(w.engine.stepByPath.size).toBe(0);
    w.tick(2);
    expect(w.store.getBoolByPath(out)).toBe(false);
    expect(w.store.getBoolByPath(deepOut)).toBe(false);
  });
});
