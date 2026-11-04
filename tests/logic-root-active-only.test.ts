// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * logic-root-active-only.test.ts — plan-538 F1–F1h + F6: the per-root `Active`
 * lifecycle of the LogicStep engine (virtual PLC vs. real PLC on ONE signal
 * path) and the I/O contract of the simulation reset.
 *
 * Roots are built from GLB-shaped node trees through the real
 * `RVLogicEngine.addSubtree()`; the per-tick transition hook is driven through
 * the real `CoreSubsystems.early()`, the reset through the production
 * `RVViewer.prototype.resetSimulation` and the load start through
 * `RVViewer.prototype._attachLogicSystems` (narrow fakes, the established
 * pattern of logic-step-reset-restart.test.ts).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { Object3D, Quaternion, Vector3 } from 'three';
import { RVLogicEngine } from '../src/core/engine/rv-logic-engine';
import { NodeRegistry, type ComponentRef } from '../src/core/engine/rv-node-registry';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { RVDrive, DriveDirection } from '../src/core/engine/rv-drive';
import { RVDriveCylinder } from '../src/core/engine/rv-drive-cylinder';
import { RVSensor } from '../src/core/engine/rv-sensor';
import { AABB } from '../src/core/engine/rv-aabb';
import { RVTransportManager } from '../src/core/engine/rv-transport-manager';
import { CoreSubsystems, type CoreSubsystemsHost } from '../src/core/engine/rv-core-subsystems';
import { mergePlacedLogic, type PlacementHost } from '../src/core/engine/rv-placement-integrate';
import { registerLogicStepBuilder } from '../src/core/engine/rv-logic-step-registry';
import {
  RVLogicStep,
  RVParallelContainer,
  RVSerialContainer,
  StepState,
} from '../src/core/engine/rv-logic-step';
import { logicRootRuleWarnings } from '../src/core/engine/rv-extras-validator';
import {
  claimBound,
  makeSignalChannelId,
  makeSlotId,
  registerSlotChannel,
  resetSlotAuthority,
  setRemoteOwnershipActive,
  setSignalLiveControlled,
} from '../src/core/engine/rv-slot-authority';
import { RVViewer } from '../src/core/rv-viewer';
import { EventEmitter } from '../src/core/rv-events';
import type { ComponentContext } from '../src/core/engine/rv-component-registry';
import { RVIKTarget } from '../src/core/engine/rv-ik-target';
import { RVIKPath } from '../src/core/engine/rv-ik-path';
import { RVRobotIK } from '../src/core/engine/rv-robot-ik';
import { ikSolverRegistry, type IKSolution, type IKSolverProvider } from '../src/core/engine/rv-ik-solver';
import { buildMechanismPathStep } from '@rv-private/kinematic-mechanism/rv-mechanism-path';
import { releaseAllAxes } from '../src/core/engine/rv-axis-ownership';
import { DT as MECH_DT, buildArmRig, requireRig, type PathRig } from './_mechanism-path-rig';

const DT = 1 / 60;

afterEach(() => {
  resetSlotAuthority();
  setRemoteOwnershipActive(false);
  vi.restoreAllMocks();
});

// ─── GLB-shaped fixture helpers ──────────────────────────────────────────────

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
const parallel = (): Extras => ({ LogicStep_ParallelContainer: {} });
const setBool = (path: string, value = true): Extras => ({ LogicStep_SetSignalBool: { Signal: sigRef(path), SetToTrue: value } });
const waitBool = (path: string, value = true): Extras => ({ LogicStep_WaitForSignalBool: { Signal: sigRef(path), WaitForTrue: value } });
const delay = (s: number): Extras => ({ LogicStep_Delay: { Duration: s } });
const driveTo = (path: string, dest: number): Extras => ({ LogicStep_DriveTo: { drive: driveRef(path), Destination: dest } });
const startDriveTo = (path: string, dest: number): Extras => ({ LogicStep_StartDriveTo: { drive: driveRef(path), Destination: dest } });

interface World {
  scene: Object3D;
  registry: NodeRegistry;
  store: SignalStore;
  drives: Record<string, RVDrive>;
  engine: RVLogicEngine;
  signal(name: string, initial?: boolean): string;
  drive(name: string, start?: number): RVDrive;
  /** Registry path of a drive created with {@link drive}. */
  drivePath(name: string): string;
  /** Add a subtree (each child of `container` that carries a step is a root). */
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
    add(container) {
      if (!container.parent) scene.add(container);
      container.traverse((n) => registry.registerNode(NodeRegistry.computeNodePath(n), n));
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

/** A root: SerialContainer with the given Active and the given child steps. */
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

/** CoreSubsystems with only the logic engine wired (the real per-tick hook). */
function core(engine: RVLogicEngine, state: { connected: boolean }): CoreSubsystems {
  const host: CoreSubsystemsHost = {
    get isConnected() { return state.connected; },
    playback: null,
    logicEngine: engine,
    ikPaths: [],
    replayRecordings: [],
    drives: [],
    transportManager: null,
    tankFillManager: null,
    pipeFlowManager: null,
    gizmoManager: { tick: () => false },
    lampManager: null,
    energyChainManager: null,
    collisionManager: null,
    markRenderDirty() {},
    markShadowsDirty() {},
  };
  return new CoreSubsystems(host);
}

// ─── F1 / F1b / F1c / F1e: per-root gating ───────────────────────────────────

describe('plan-538 F1 — per-root Active gating', () => {
  it('a root without Active runs in both connection states', () => {
    const w = world();
    const out = w.signal('A');
    const asset = nd('Asset', null);
    root(asset, 'Plain', undefined, [['SetA', setBool(out)], ['Wait', delay(10)]]);
    w.add(asset);
    w.engine.start(false);
    w.tick(1);
    expect(rootStep(w.engine, 'Plain').state).toBe(StepState.Active);
    w.engine.setConnected(true);
    expect(rootStep(w.engine, 'Plain').state).toBe(StepState.Active);
    expect(rootStep(w.engine, 'Plain').currentIndex).toBe(1); // not restarted by the flip
    expect(w.store.getBoolByPath(out)).toBe(true);
  });

  it('Disconnected runs only while disconnected, Connected only while connected, Never never', () => {
    const w = world();
    const asset = nd('Asset', null);
    root(asset, 'Virtual', 'Disconnected', [['W', delay(10)]]);
    root(asset, 'Real', 'Connected', [['W', delay(10)]]);
    root(asset, 'Off', 'Never', [['W', delay(10)]]);
    root(asset, 'Keep', 'DontChange', [['W', delay(10)]]);
    w.add(asset);
    w.engine.start(false);
    const state = () => ['Virtual', 'Real', 'Off', 'Keep'].map((n) => rootStep(w.engine, n).state);
    expect(state()).toEqual([StepState.Active, StepState.Idle, StepState.Idle, StepState.Active]);
    w.engine.setConnected(true);
    expect(state()).toEqual([StepState.Idle, StepState.Active, StepState.Idle, StepState.Active]);
    w.engine.setConnected(false);
    expect(state()).toEqual([StepState.Active, StepState.Idle, StepState.Idle, StepState.Active]);
    // An inactive root is never ticked: Real's delay does not advance.
    w.tick(30);
    expect((rootStep(w.engine, 'Real').children[0] as unknown as { elapsed: number }).elapsed).toBe(0);
  });

  it('connected BEFORE load: a Disconnected root never starts and writes nothing (viewer load path)', () => {
    const w = world();
    const out = w.signal('Out');
    const writes: unknown[] = [];
    w.store.subscribeByPath(out, (v) => writes.push(v));
    const asset = nd('Asset', w.scene);
    root(asset, 'Virtual', 'Disconnected', [['Set', setBool(out)], ['W', delay(10)]]);
    asset.traverse((n) => w.registry.registerNode(NodeRegistry.computeNodePath(n), n));

    // The production load start: RVViewer._attachLogicSystems with the viewer
    // already connected. plan-769 Phase 6: the loader builds no engine — the
    // viewer merges the model root's steps itself (a document without
    // placements: at once, through `mergePlacedLogic`).
    const fake = {
      drives: [] as RVDrive[],
      connectionState: 'Connected' as const,
      _plannerSignalLinking: false,
      _loadTrust: { trusted: false },
      signalBindingManager: null,
      signalStore: w.store,
      registry: w.registry,
      logicEngine: null as RVLogicEngine | null,
      playback: null,
      _attachMainLogic: (RVViewer.prototype as unknown as { _attachMainLogic: unknown })._attachMainLogic,
    };
    const result = {
      root: asset, drives: [], transportManager: null, playback: null, replayRecordings: [],
      registry: { getAll: () => [] }, recorderSettings: undefined,
    };
    (RVViewer.prototype as unknown as { _attachLogicSystems(this: typeof fake, r: typeof result): void })
      ._attachLogicSystems.call(fake, result);

    const engine = fake.logicEngine!;
    expect(engine).toBeInstanceOf(RVLogicEngine);
    expect(engine.isStarted).toBe(true);
    expect(rootStep(engine, 'Virtual').state).toBe(StepState.Idle);
    for (let i = 0; i < 10; i++) engine.fixedUpdate(DT);
    expect(writes).toEqual([]);
    expect(w.store.getBoolByPath(out)).toBe(false);
  });

  it('two roots in one placed asset gate independently; remove / re-add the subtree', () => {
    const w = world();
    w.engine.start(false);
    const asset = nd('Placed_1', null);
    root(asset, 'Virtual', 'Disconnected', [['W', delay(10)]]);
    root(asset, 'Real', 'Connected', [['W', delay(10)]]);
    expect(w.add(asset)).toBe(2);
    expect(rootStep(w.engine, 'Virtual').state).toBe(StepState.Active);
    expect(rootStep(w.engine, 'Real').state).toBe(StepState.Idle);

    expect(w.engine.removeSubtree(asset)).toBe(2);
    expect(w.engine.roots).toHaveLength(0);
    w.engine.setConnected(true);
    expect(w.engine.addSubtree(asset, w.registry, w.store)).toBe(2);
    expect(rootStep(w.engine, 'Virtual').state).toBe(StepState.Idle);
    expect(rootStep(w.engine, 'Real').state).toBe(StepState.Active);
  });
});

// ─── F1d / F1c: deactivation and re-activation ───────────────────────────────

describe('suppressed roots — a virtual PLC program replaces a sequence', () => {
  it('a suppressed root deactivates, resets its outputs and stays off in both states and after a restart', () => {
    const w = world();
    const out = w.signal('Out');
    const asset = nd('Asset', null);
    root(asset, 'Logic_PLC_Station', 'Disconnected', [['SetOut', setBool(out)], ['Wait', delay(10)]]);
    root(asset, 'Other', 'Disconnected', [['W', delay(10)]]);
    w.add(asset);
    w.engine.start(false);
    w.tick(1);
    expect(w.store.getBoolByPath(out)).toBe(true);

    expect(w.engine.setRootSuppressed('Logic_PLC_Station', true)).toBe(true);
    expect(rootStep(w.engine, 'Logic_PLC_Station').state).toBe(StepState.Idle);
    expect(w.store.getBoolByPath(out)).toBe(false); // owned output back to its start value
    expect(rootStep(w.engine, 'Other').state).toBe(StepState.Active);
    expect(w.engine.isRootSuppressed('Logic_PLC_Station')).toBe(true);

    w.engine.setConnected(true);
    w.engine.setConnected(false);
    w.engine.reset();
    w.engine.start(false);
    expect(rootStep(w.engine, 'Logic_PLC_Station').state).toBe(StepState.Idle);
    expect(rootStep(w.engine, 'Other').state).toBe(StepState.Active);

    w.engine.setRootSuppressed('Logic_PLC_Station', false);
    expect(rootStep(w.engine, 'Logic_PLC_Station').state).toBe(StepState.Active);
    expect(w.engine.setRootSuppressed('NoSuchRoot', true)).toBe(false);
  });
});

describe('plan-538 F1d — deactivation cancels, holds and resets; F1c — reactivation restarts', () => {
  function flipRig() {
    const w = world();
    const outA = w.signal('OutA');
    const outB = w.signal('OutB');
    const go = w.signal('Go');
    const moving = w.drive('Moving');
    const started = w.drive('Started');
    const pMoving = w.drivePath('Moving');
    const pStarted = w.drivePath('Started');
    const asset = nd('Asset', null);
    const virt = nd('Virtual', asset, serial('Disconnected'));
    nd('SetA', virt, setBool(outA));
    nd('Kick', virt, startDriveTo(pStarted, 500));
    const par = nd('Par', virt, parallel());
    nd('SetB', par, setBool(outB));
    nd('Delay', par, delay(5));
    nd('WaitGo', par, waitBool(go));
    nd('Move', par, driveTo(pMoving, 400));
    nd('Tail', virt, delay(10));
    w.add(asset);
    return { w, outA, outB, go, moving, started };
  }

  it('flip during Delay / WaitFor / Parallel: steps cancelled, Idle, outputs back to start, drives stop and hold', () => {
    const { w, outA, outB, moving, started } = flipRig();
    w.engine.start(false);
    w.tick(30);
    const seq = rootStep(w.engine, 'Virtual');
    const par = seq.children[2] as RVParallelContainer;
    expect(seq.currentIndex).toBe(2);
    expect(par.state).toBe(StepState.Active);
    expect(w.store.getBoolByPath(outA)).toBe(true);
    expect(w.store.getBoolByPath(outB)).toBe(true);
    expect(moving.isRunning).toBe(true);
    expect(started.isRunning).toBe(true);

    w.engine.setConnected(true);
    // Every step Idle (Delay, WaitFor and DriveTo inside the Parallel included).
    expect(seq.state).toBe(StepState.Idle);
    for (const c of par.children) expect(c.state).toBe(StepState.Idle);
    // Owned outputs back to their GLB start values.
    expect(w.store.getBoolByPath(outA)).toBe(false);
    expect(w.store.getBoolByPath(outB)).toBe(false);
    // The DriveTo-moving drive and the StartDriveTo-started drive stop and hold.
    const holdMoving = moving.currentPosition;
    const holdStarted = started.currentPosition;
    expect(moving.isRunning).toBe(false);
    expect(started.isRunning).toBe(false);
    w.tick(60);
    expect(moving.currentPosition).toBe(holdMoving);
    expect(started.currentPosition).toBe(holdStarted);
    expect(seq.state).toBe(StepState.Idle);
  });

  it('flip back: the root restarts at step 0', () => {
    const { w, outA } = flipRig();
    w.engine.start(false);
    w.tick(30);
    w.engine.setConnected(true);
    expect(w.store.getBoolByPath(outA)).toBe(false);
    w.engine.setConnected(false);
    const seq = rootStep(w.engine, 'Virtual');
    expect(seq.state).toBe(StepState.Active);
    // Step 0 (SetA) ran again → the root restarted from the top.
    expect(seq.currentIndex).toBe(0);
    expect(seq.children[0].state).toBe(StepState.Finished);
    expect(w.store.getBoolByPath(outA)).toBe(true);
    w.tick(1);
    expect(seq.currentIndex).toBe(2);
  });

  it('a closed engine-wide guard does not hide the transition (CoreSubsystems.early)', () => {
    const { w, outA, moving } = flipRig();
    const state = { connected: false };
    const pipeline = core(w.engine, state);
    w.engine.start(false);
    for (let i = 0; i < 30; i++) { pipeline.early(DT); for (const d of Object.values(w.drives)) d.update(DT); }
    expect(w.store.getBoolByPath(outA)).toBe(true);
    w.engine.activeOnly = 'Never'; // outer guard closed
    state.connected = true;
    pipeline.early(DT);
    expect(rootStep(w.engine, 'Virtual').state).toBe(StepState.Idle);
    expect(w.store.getBoolByPath(outA)).toBe(false);
    expect(moving.isRunning).toBe(false);
  });
});

// ─── F1f: two-phase transitions + overlap ────────────────────────────────────

describe('plan-538 F1f — two-phase transitions, overlap warning', () => {
  function overlapWorld(order: 'real-first' | 'virtual-first') {
    const w = world();
    const shared = w.signal('Shared');
    const axis = w.drive('Shared', 50);
    const pAxis = w.drivePath('Shared');
    const asset = nd('Asset', null);
    // Move first: an activation commands the shared drive within the transition itself.
    const realSteps: [string, Extras][] = [['Move', driveTo(pAxis, 100)], ['SetShared', setBool(shared)], ['W', delay(10)]];
    const virtSteps: [string, Extras][] = [['Move', driveTo(pAxis, 0)], ['SetShared', setBool(shared)], ['W', delay(10)]];
    if (order === 'real-first') {
      root(asset, 'Real', 'Connected', realSteps);
      root(asset, 'Virtual', 'Disconnected', virtSteps);
    } else {
      root(asset, 'Virtual', 'Disconnected', virtSteps);
      root(asset, 'Real', 'Connected', realSteps);
    }
    w.add(asset);
    return { w, shared, axis };
  }

  it('final output / drive state does not depend on the root order', () => {
    const results: unknown[] = [];
    for (const order of ['real-first', 'virtual-first'] as const) {
      const { w, shared, axis } = overlapWorld(order);
      w.engine.start(false);
      w.tick(40); // virtual root: drive at 0, Shared set
      expect(axis.currentPosition).toBeCloseTo(0, 3);
      expect(w.store.getBoolByPath(shared)).toBe(true);
      // connect: the virtual root steps aside, the real root takes over
      w.engine.setConnected(true);
      const afterConnect = { shared: w.store.getBoolByPath(shared), running: axis.isRunning, target: axis.targetPosition };
      w.tick(5);
      // disconnect again: the real root releases, the virtual root takes over
      w.engine.setConnected(false);
      const afterDisconnect = { shared: w.store.getBoolByPath(shared), running: axis.isRunning, target: axis.targetPosition };
      results.push({ afterConnect, afterDisconnect });
      expect(afterConnect).toEqual({ shared: true, running: true, target: 100 });
      expect(afterDisconnect).toEqual({ shared: true, running: true, target: 0 });
    }
    expect(results[0]).toEqual(results[1]);
  });

  it('the validator warns at load for an output / drive shared between roots with different Active', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { w } = overlapWorld('real-first');
    expect(w.engine.warnings.some((m) => m.includes('output') && m.includes('shared between roots with different Active'))).toBe(true);
    expect(w.engine.warnings.some((m) => m.includes('drive') && m.includes('shared between roots with different Active'))).toBe(true);
    expect(warn).toHaveBeenCalled();
  });

  it('no overlap warning when the sharing roots have the same Active', () => {
    expect(logicRootRuleWarnings([
      { name: 'A', active: 'Always', outputs: ['x'], drives: [], motionWithoutCancel: [] },
      { name: 'B', active: 'DontChange', outputs: ['x'], drives: [], motionWithoutCancel: [] },
    ])).toEqual([]);
  });
});

// ─── F1g: delegated motion cancellation ──────────────────────────────────────

class RVTestMotionStep extends RVLogicStep {
  get startsMotion(): boolean { return true; }
  start(): void { this.state = StepState.Finished; }
  fixedUpdate(): void {}
  get progress(): number { return 0; }
}

describe('plan-538 F1g — cancel hooks and the motion-without-cancel warning', () => {
  it('warns for a motion step without cancel() only in a root whose Active is not Always', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const off = registerLogicStepBuilder('LogicStep_TestMotion', () => new RVTestMotionStep());
    try {
      const w = world();
      const asset = nd('Asset', null);
      root(asset, 'Virtual', 'Disconnected', [['Spin', { LogicStep_TestMotion: {} }]]);
      root(asset, 'Always', undefined, [['Spin2', { LogicStep_TestMotion: {} }]]);
      w.add(asset);
      expect(w.engine.warnings.filter((m) => m.includes('cannot be cancelled'))).toHaveLength(1);
      expect(w.engine.warnings.find((m) => m.includes('cannot be cancelled'))).toContain('"Spin"');
      expect(warn).toHaveBeenCalled();
    } finally {
      off();
    }
  });

  // IKPath rig — a 6-axis robot with a mock live solver (pattern rv-ik-path.test.ts).
  function ikWorld() {
    const w = world();
    const robotNode = nd('Robot', w.scene);
    const axisRefs: ComponentRef[] = [];
    const axes: RVDrive[] = [];
    for (let i = 0; i < 6; i++) {
      const n = nd(`a${i}`, robotNode);
      const d = new RVDrive(n);
      d.Direction = DriveDirection.RotationZ;
      d.TargetSpeed = 100;
      d.UseAcceleration = false;
      d.UseLimits = false;
      d.initDrive();
      const p = NodeRegistry.computeNodePath(n);
      w.registry.register('Drive', p, d);
      w.drives[`a${i}`] = d;
      axes.push(d);
      axisRefs.push(driveRef(p));
    }
    robotNode.userData.realvirtual = {
      RobotIK: {
        Axis: axisRefs,
        a1: 0.1, a2: -0.1, b: 0, c1: 0.5, c2: 0.7, c3: 0.7, c4: 0.1,
        ElbowInUnityX: false,
        ToolOffset: { x: 0, y: 0, z: 0.1 },
      },
    };
    const pathNode = nd('Path', robotNode);
    const targetRef = (p: string): ComponentRef => ({ type: 'ComponentReference', path: p, componentType: 'realvirtual.IKTarget' });
    const ctx = { registry: w.registry, signalStore: w.store, scene: new Object3D(), transportManager: new RVTransportManager(), root: robotNode } as unknown as ComponentContext;
    const mk = (idx: number, axisPos: number[], interp: 'PointToPoint' | 'Linear', x: number): ComponentRef => {
      const tn = nd(`T${idx}`, robotNode);
      tn.position.set(x, 0, 0.8);
      const t = new RVIKTarget(tn);
      t.AxisPos = axisPos;
      t.InterpolationToTarget = interp;
      t.LinearSpeedToTarget = 100;
      t.LinearAcceleration = 10000;
      t.init(ctx);
      const p = NodeRegistry.computeNodePath(tn);
      w.registry.register('IKTarget', p, t);
      return targetRef(p);
    };
    const refs = [mk(0, [60, 60, 60, 60, 60, 60], 'PointToPoint', 0.5), mk(1, [80, 80, 80, 80, 80, 80], 'Linear', 1.1)];
    robotNode.updateMatrixWorld(true);
    pathNode.userData.realvirtual = { IKPath: { Path: refs } };
    w.registry.registerNode(NodeRegistry.computeNodePath(robotNode), robotNode);
    const robotIk = new RVRobotIK(robotNode);
    robotIk.init(ctx);
    w.registry.register('RobotIK', NodeRegistry.computeNodePath(robotNode), robotIk);
    const ikPath = new RVIKPath(pathNode);
    ikPath.init(ctx);
    const pathPath = NodeRegistry.computeNodePath(pathNode);
    w.registry.register('IKPath', pathPath, ikPath);

    const asset = nd('Logic', null);
    root(asset, 'Robot', 'Disconnected', [['RunPath', { LogicStep_IKPath: { IKPath: { type: 'ComponentReference', path: pathPath, componentType: 'realvirtual.IKPath' } } }]]);
    w.add(asset);
    const tickAll = (n: number) => {
      for (let i = 0; i < n; i++) {
        w.engine.fixedUpdate(DT);
        ikPath.fixedUpdate(DT);
        for (const d of axes) d.update(DT);
      }
    };
    return { w, ikPath, axes, tickAll };
  }

  afterEach(() => {
    ikSolverRegistry.register(null);
    ikSolverRegistry.resetLiveSolveClaims();
  });

  it('IKPath PTP move: deactivation stops the axes and later path ticks never move them', () => {
    ikSolverRegistry.register(null);
    const { w, ikPath, axes, tickAll } = ikWorld();
    ikPath.StartPath = true; // a held start trigger must not re-start the path after the cancel
    w.engine.start(false);
    tickAll(10);
    expect(ikPath.PathIsActive).toBe(true);
    expect(axes[0].isRunning).toBe(true);
    w.engine.setConnected(true);
    expect(ikPath.PathIsActive).toBe(false);
    const hold = axes.map((d) => d.currentPosition);
    tickAll(120);
    expect(axes.map((d) => d.currentPosition)).toEqual(hold);
    expect(axes.every((d) => !d.isRunning)).toBe(true);
  });

  it('IKPath LIN move: deactivation mid-segment stops the live solve and holds the axes', () => {
    let calls = 0;
    const provider: IKSolverProvider = {
      tier: 'free', maxRobots: 8, canBlend: false,
      solvePieper: (): IKSolution[] => {
        calls++;
        const a = calls <= 2 ? 60 : Math.min(60 + (calls - 2) * 0.2, 80);
        return [{ angles: [a, a, a, a, a, a], reachable: true }];
      },
    };
    ikSolverRegistry.register(provider);
    ikSolverRegistry.resetLiveSolveClaims();
    const { w, ikPath, axes, tickAll } = ikWorld();
    w.engine.start(false);
    let sawLin = false;
    for (let i = 0; i < 400 && !sawLin; i++) {
      tickAll(1);
      sawLin = axes.some((d) => d.positionOverwrite);
    }
    expect(sawLin).toBe(true);
    tickAll(2);
    w.engine.setConnected(true);
    expect(axes.some((d) => d.positionOverwrite)).toBe(false);
    const hold = axes.map((d) => d.currentPosition);
    const solvesAtCancel = calls;
    tickAll(120);
    expect(axes.map((d) => d.currentPosition)).toEqual(hold);
    expect(calls).toBe(solvesAtCancel);
  });

  let rig: PathRig | null = null;
  afterEach(() => {
    rig?.dispose();
    rig = null;
    releaseAllAxes();
  });

  it('MechanismPath: deactivation stops the path and its drives stay stopped on later ticks', async (ctx) => {
    rig = await buildArmRig({
      waypoints: [{ name: 'A', pos: [0.7, 0.2, 0] }, { name: 'B', pos: [0.6, 0.3, 0] }],
      paths: [{ waypoints: ['A', 'B'], linearSpeed: 50, linearAccel: 1000 }],
    });
    if (!requireRig(ctx, rig)) return;
    const r = rig;
    const off = registerLogicStepBuilder('LogicStep_MechanismPath', buildMechanismPathStep);
    try {
      const seq = nd('MechCycle', r.root, serial('Disconnected'));
      nd('RunPath', seq, {
        LogicStep_MechanismPath: {
          MechanismPath: { type: 'ComponentReference', path: NodeRegistry.computeNodePath(r.path.node), componentType: 'realvirtual.MechanismPath' },
        },
      });
      r.registry.registerNode(NodeRegistry.computeNodePath(seq), seq);
      for (const c of seq.children) r.registry.registerNode(NodeRegistry.computeNodePath(c), c);
      const engine = new RVLogicEngine();
      engine.addSubtree(seq, r.registry, r.store);
      engine.start(false);
      expect(r.path.PathIsActive).toBe(true);
      for (let i = 0; i < 20; i++) { engine.fixedUpdate(MECH_DT); r.tick(); }
      const tipBefore = r.tip(new Vector3()).clone();
      expect(r.path.PathIsActive).toBe(true);

      engine.setConnected(true);
      expect(r.path.PathIsActive).toBe(false);
      const hold = r.drives.map((d) => d.currentPosition);
      for (let i = 0; i < 120; i++) { engine.fixedUpdate(MECH_DT); r.tick(); }
      expect(r.drives.map((d) => d.currentPosition)).toEqual(hold);
      expect(r.path.PathIsActive).toBe(false);
      expect(r.tip(new Vector3()).distanceTo(tipBefore)).toBeLessThan(0.05);
    } finally {
      off();
    }
  });
});

// ─── F1h: placements ─────────────────────────────────────────────────────────

describe('plan-538 F1h — placed asset logic in an already-connected document', () => {
  it('connected, logic-free document: a placed Disconnected root neither starts nor writes; disconnect starts it', () => {
    const w = world();
    const out = w.signal('Out');
    const writes: unknown[] = [];
    w.store.subscribeByPath(out, (v) => writes.push(v));
    const asset = nd('Placed_1', w.scene);
    root(asset, 'Virtual', 'Disconnected', [['Set', setBool(out)], ['W', delay(10)]]);
    asset.traverse((n) => w.registry.registerNode(NodeRegistry.computeNodePath(n), n));

    const host = {
      registry: w.registry,
      signalStore: w.store,
      logicEngine: null as RVLogicEngine | null,
      connectionState: 'Connected' as const,
    } as unknown as PlacementHost;
    mergePlacedLogic(host, asset);
    const engine = host.logicEngine!;
    expect(engine).toBeInstanceOf(RVLogicEngine);
    expect(engine.isStarted).toBe(true);
    expect(rootStep(engine, 'Virtual').state).toBe(StepState.Idle);
    expect(writes).toEqual([]);

    // The per-tick hook sees the disconnect → the placed root starts.
    const pipeline = core(engine, { connected: false });
    pipeline.early(DT);
    expect(rootStep(engine, 'Virtual').state).toBe(StepState.Active);
    expect(w.store.getBoolByPath(out)).toBe(true);
  });

  it('an existing engine learns the current state before the placed roots are added', () => {
    const w = world();
    w.engine.start(false);
    const out = w.signal('Out');
    const asset = nd('Placed_2', w.scene);
    root(asset, 'Virtual', 'Disconnected', [['Set', setBool(out)], ['W', delay(10)]]);
    asset.traverse((n) => w.registry.registerNode(NodeRegistry.computeNodePath(n), n));
    const host = { registry: w.registry, signalStore: w.store, logicEngine: w.engine, connectionState: 'Connected' } as unknown as PlacementHost;
    mergePlacedLogic(host, asset);
    expect(rootStep(w.engine, 'Virtual').state).toBe(StepState.Idle);
    expect(w.store.getBoolByPath(out)).toBe(false);
  });
});

// ─── F6: simulation-reset I/O contract ───────────────────────────────────────

describe('plan-538 F6 — simulation reset I/O contract (production resetSimulation)', () => {
  function resetWorld() {
    const w = world();
    const plain = w.signal('Plain');
    const forced = w.signal('Forced');
    const bound = w.signal('Bound');
    const live = w.signal('Live');
    const sensorSig = w.signal('SensorOcc');
    const realOut = w.signal('RealOut');
    const asset = nd('Asset', null);
    root(asset, 'Virtual', 'Disconnected', [
      ['D0', delay(0.05)],
      ['SetPlain', setBool(plain)], ['SetForced', setBool(forced)], ['SetBound', setBool(bound)], ['SetLive', setBool(live)],
      ['Tail', delay(100)],
    ]);
    root(asset, 'SensorCheck', undefined, [['WaitSensor', waitBool(sensorSig)], ['Tail', delay(100)]]);
    root(asset, 'Real', 'Connected', [['SetReal', setBool(realOut)], ['Tail', delay(100)]]);

    // Cylinder (feedback re-initialised in simulation-start).
    const events = new EventEmitter<Record<string, unknown>>();
    const isIn = w.signal('CylIsIn');
    const cylOut = w.signal('CylOut');
    const cylDrive = w.drive('Cyl');
    const cyl = new RVDriveCylinder(cylDrive.node);
    cyl.MinPos = 0; cyl.MaxPos = 100; cyl.TimeOut = 0.5; cyl.TimeIn = 0.5;
    cyl.Out = cylOut; cyl.IsIn = isIn;
    cyl.init({ registry: w.registry, signalStore: w.store, events } as unknown as ComponentContext);
    root(asset, 'CylCheck', undefined, [['WaitHome', waitBool(isIn)], ['Tail', delay(100)]]);
    w.add(asset);

    // Real transport manager with a sensor and a pre-placed MU sitting in it.
    const tm = new RVTransportManager();
    const sensorNode = nd('Sensor', w.scene);
    const sensor = new RVSensor(sensorNode, AABB.fromHalfSize(sensorNode, new Vector3(0.1, 0.1, 0.1)));
    sensor.onChanged = (occ: boolean) => w.store.setByPath(sensorSig, occ);
    tm.sensors.push(sensor);
    const muNode = nd('Part', w.scene);
    const mu = {
      node: muNode,
      aabb: AABB.fromHalfSize(muNode, new Vector3(0.05, 0.05, 0.05)),
      markedForRemoval: false, isInstanced: false, loadedMus: [] as unknown[],
      getName: () => 'Part',
      updateAABB() { this.aabb.update(); },
      dispose() {},
    };
    // plan-516 stand-in: the reset re-activates the pre-placed MU at its authored pose.
    (tm as unknown as { activatePreplaced: () => number }).activatePreplaced = () => {
      muNode.position.set(0, 0, 0);
      muNode.updateMatrixWorld(true);
      mu.updateAABB();
      tm.mus.push(mu as never);
      return 1;
    };

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
      emit(event: string) { order.push(event); events.emit(event, undefined); },
    };
    const reset = () => (RVViewer.prototype.resetSimulation as unknown as (this: typeof fake) => void).call(fake);
    return { w, plain, forced, bound, live, sensorSig, realOut, isIn, cylOut, cylDrive, muNode, sensor, reset, order, fake };
  }

  it('owned outputs reset, feedback re-initialised before the logic starts, external signals untouched (shadow gate)', () => {
    const r = resetWorld();
    expect(r.w.store.signalWriteGate).toBe('shadow');
    r.w.engine.start(false);
    r.w.tick(10); // past D0 → all four outputs set
    for (const s of [r.plain, r.forced, r.bound, r.live]) expect(r.w.store.getBoolByPath(s)).toBe(true);
    expect(rootStep(r.w.engine, 'Real').state).toBe(StepState.Idle);

    // External owners take three of the outputs.
    r.w.store.forceSignal(r.forced, true);
    const slot = makeSlotId('el', 'Cell/Sig/Bound', 'PLCOutputBool', 'Value');
    registerSlotChannel(slot, makeSignalChannelId(r.bound));
    claimBound(slot);
    setSignalLiveControlled(r.live, true);

    // Plant state before the reset: cylinder out, sensor free (MU moved away).
    r.w.store.setByPath(r.cylOut, true);
    r.w.tick(60);
    expect(r.w.store.getBoolByPath(r.isIn)).toBe(false);
    r.w.store.setByPath(r.cylOut, false);
    expect(r.w.store.getBoolByPath(r.sensorSig)).toBe(false);

    const seen: Record<string, unknown[]> = { plain: [], forced: [], bound: [], live: [] };
    r.w.store.subscribeByPath(r.plain, (v) => seen.plain.push(v));
    r.w.store.subscribeByPath(r.forced, (v) => seen.forced.push(v));
    r.w.store.subscribeByPath(r.bound, (v) => seen.bound.push(v));
    r.w.store.subscribeByPath(r.live, (v) => seen.live.push(v));

    r.reset();

    // (1) the plain owned output went back to its GLB start value …
    expect(seen.plain).toEqual([false]);
    expect(r.w.store.getBoolByPath(r.plain)).toBe(false);
    // (3) … the externally controlled ones were not written at all.
    expect(seen.forced).toEqual([]);
    expect(seen.bound).toEqual([]);
    expect(seen.live).toEqual([]);
    expect(r.w.store.getBoolByPath(r.bound)).toBe(true);
    expect(r.w.store.getBoolByPath(r.live)).toBe(true);
    // (2) feedback re-initialised BEFORE the logic restarted: both waits
    // finished at their start, in the restart itself.
    expect(r.w.store.getBoolByPath(r.sensorSig)).toBe(true);
    expect(r.w.store.getBoolByPath(r.isIn)).toBe(true);
    expect(rootStep(r.w.engine, 'SensorCheck').children[0].state).toBe(StepState.Finished);
    expect(rootStep(r.w.engine, 'CylCheck').children[0].state).toBe(StepState.Finished);
    // (4) roots start per state: Virtual runs, Real stays Idle and wrote nothing.
    expect(rootStep(r.w.engine, 'Virtual').state).toBe(StepState.Active);
    expect(rootStep(r.w.engine, 'Real').state).toBe(StepState.Idle);
    expect(r.w.store.getBoolByPath(r.realOut)).toBe(false);
    expect(r.order).toEqual(['simulation-reset', 'simulation-resetstat', 'simulation-start', 'reapply']);
  });

  it('remote ownership: the reset writes no owned output at all', () => {
    const r = resetWorld();
    r.w.engine.start(false);
    r.w.tick(10);
    setRemoteOwnershipActive(true);
    const seen: unknown[] = [];
    r.w.store.subscribeByPath(r.plain, (v) => seen.push(v));
    r.reset();
    expect(seen).toEqual([]);
    expect(r.w.store.getBoolByPath(r.plain)).toBe(true);
  });

  it('outputs of a root inactive for the current state are left to the real PLC on reset', () => {
    const r = resetWorld();
    r.fake.connectionState = 'Connected' as never;
    r.w.engine.start(true);
    r.w.tick(2);
    expect(r.w.store.getBoolByPath(r.realOut)).toBe(true);
    // The real PLC owns Plain while connected (Virtual is inactive).
    r.w.store.setByPath(r.plain, true);
    r.reset();
    expect(r.w.store.getBoolByPath(r.plain)).toBe(true);
    // Real is active: its output went back to the start value and was re-set by the restart.
    expect(r.w.store.getBoolByPath(r.realOut)).toBe(true);
    expect(rootStep(r.w.engine, 'Virtual').state).toBe(StepState.Idle);
    expect(rootStep(r.w.engine, 'Real').state).toBe(StepState.Active);
  });
});

void Quaternion;
