// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { afterEach, describe, expect, it, vi } from 'vitest';
import { Object3D, Vector3 } from 'three';
import { RVLogicEngine } from '../../src/core/engine/rv-logic-engine';
import { NodeRegistry } from '../../src/core/engine/rv-node-registry';
import { RVDrive } from '../../src/core/engine/rv-drive';
import { RVSensor } from '../../src/core/engine/rv-sensor';
import { RVZone } from '../../src/core/engine/rv-zone';
import { AABB } from '../../src/core/engine/rv-aabb';
import { RVDelay, RVJumpOnSignal, RVLogicStep, RVParallelContainer, RVSerialContainer, RVWaitForSensor, RVWaitForSignalBool, RVWaitForZone, StepState } from '../../src/core/engine/rv-logic-step';
import { registerLogicStepBuilder } from '../../src/core/engine/rv-logic-step-registry';
import { clearAllProblems, getProblems } from '../../src/core/hmi/problems-store';
import { getActionName } from '../../src/plugins/des/rv-des-named-actions';
import type { DESRunner } from '../../src/plugins/des/des-runner';
import { logicDesFindings, logicSnapshotBlockerReason, logicStepDesInfo, registerLogicStepDesOptions } from '../../src/plugins/des/rv-des-logic-check';
import { cycleRunnerFixture } from './cycle-runner-fixture';

afterEach(() => { clearAllProblems(); vi.restoreAllMocks(); });
type Trace = [string, number][];
type Spec = [string, string, Record<string, unknown>?];
const signal = (name: string, componentType = 'PLCOutputBool') => ({ type: 'ComponentReference', path: `Root/${name}`, componentType });
const hazards = (runner: DESRunner) => (runner as unknown as { _logicHazards(): unknown })._logicHazards();

function world(specs: Spec[], options: { autoLoop?: boolean; connected?: boolean; active?: string } = {}) {
  const w = cycleRunnerFixture({ cycleTime: 0.01 });
  w.signalStore.register('go', 'Root/Go', false, 'PLCOutputBool');
  w.signalStore.register('pos', 'Root/Pos', 0, 'PLCOutputFloat');
  const rootNode = new Object3D(); rootNode.name = 'Sequence'; w.scene.add(rootNode);
  rootNode.userData.realvirtual = { LogicStep_SerialContainer: { Active: options.active ?? 'Always' } };
  for (const [name, type, fields] of specs) {
    const node = new Object3D(); node.name = name;
    node.userData.realvirtual = { [type]: fields ?? {} }; rootNode.add(node);
  }
  const registry = new NodeRegistry();
  w.scene.traverse(node => registry.registerNode(node === w.scene ? 'Root' : `Root/${NodeRegistry.computeNodePath(node)}`, node));
  const engine = RVLogicEngine.build(w.scene, registry, w.signalStore);
  const root = engine.roots[0] as RVSerialContainer;
  root.autoLoop = options.autoLoop ?? false;
  w.host.logicEngine = engine;
  w.host.isConnected = options.connected ?? false;
  const trace: Trace = [];
  const scheduled = new Map<number, Trace[number]>();
  const schedule = w.manager.scheduleEventByIndex.bind(w.manager);
  vi.spyOn(w.manager, 'scheduleEventByIndex').mockImplementation((...args) => {
    const id = schedule(...args);
    scheduled.set(id, [getActionName(args[1]) ?? '', args[0]]);
    return id;
  });
  const consumed = w.manager.onEventConsumed;
  w.manager.onEventConsumed = id => {
    consumed?.(id);
    const event = scheduled.get(id);
    if (event?.[0].startsWith('Core.')) trace.push(event);
  };
  return { ...w, engine, root, registry, rootNode, trace,
    begin(t = 0) {
      w.start();
      if (t) w.manager.processAnimated(t);
      engine.start(w.host.isConnected);
    },
    drain() {
      let count = 0;
      while (w.runner.step()) if (++count > 1000) throw new Error('unexpected event loop');
    },
  };
}

describe('DES event-driven logic', () => {
  it('keeps a queued TRUE/FALSE pulse when a placement adds a root before settling', () => {
    const w = world([['Wait', 'LogicStep_WaitForSignalBool', { Signal: signal('Go') }]]);
    w.begin(); w.manager.processAnimated(0);
    expect(w.root.children[0].state).toBe(StepState.Waiting);
    w.signalStore.set('go', true); w.signalStore.set('go', false);
    const placed = new Object3D(); placed.name = 'Placed'; w.scene.add(placed);
    placed.userData.realvirtual = { LogicStep_SerialContainer: {} };
    const leaf = new Object3D(); leaf.name = 'Delay'; placed.add(leaf);
    leaf.userData.realvirtual = { LogicStep_Delay: { Duration: 1 } };
    for (const node of [placed, leaf]) w.registry.registerNode(`Root/${NodeRegistry.computeNodePath(node)}`, node);
    w.engine.addSubtree(placed, w.registry, w.signalStore);
    w.runner.tick(0); w.manager.processAnimated(0);
    expect(w.root.children[0].state).toBe(StepState.Finished);
    expect(w.root.state).toBe(StepState.Finished);
  });

  it('halts a whole Parallel root, removing Delay deadlines and edge subscriptions', () => {
    const w = world([]);
    w.signalStore.set('go', true);
    const delay = new RVDelay(100);
    const edge = new RVWaitForSignalBool('Root/Go', true, w.signalStore, 'Rising');
    const loop = new RVSerialContainer([], false);
    const jump = new RVJumpOnSignal('Root/Go', true, 'Jump', w.signalStore, loop); jump.name = 'Jump';
    loop.children = [new RVDelay(1), jump];
    const parallel = new RVParallelContainer([delay, edge, loop]);
    w.engine.roots.splice(0, 1, parallel);
    w.begin(); w.manager.processAnimated(0);
    expect(w.pending('Core.Due').map(e => e.time)).toEqual([1]);
    expect((edge as unknown as { _edgeUnsub: unknown })._edgeUnsub).toBeTypeOf('function');
    w.manager.processAnimated(1);
    expect(parallel.state).toBe(StepState.Finished);
    expect(parallel.children.map(step => step.state)).toEqual([StepState.Idle, StepState.Idle, StepState.Idle]);
    expect((edge as unknown as { _edgeUnsub: unknown })._edgeUnsub).toBeNull();
    expect(w.pending('Core.Due')).toEqual([]);
    expect(getProblems().some(problem => problem.code === 'logic-instant-loop')).toBe(true);
  });

  it.each(['suppression', 'connection'] as const)('restarts on the DES clock and wakes after %s release', kind => {
    const w = world([['Delay', 'LogicStep_Delay', { Duration: 1 }]],
      { autoLoop: true, active: kind === 'connection' ? 'Disconnected' : 'Always' });
    w.begin(); w.manager.processAnimated(2);
    const setInactive = (inactive: boolean) => {
      if (kind === 'suppression') w.engine.setRootSuppressed(w.root.name, inactive);
      else { w.host.isConnected = inactive; w.engine.setConnected(inactive); }
    };
    setInactive(true); w.manager.processAnimated(0);
    expect(w.pending('Core.Due')).toEqual([]);
    w.manager.scheduleCheckpoint(5);
    w.manager.processAnimated(3);
    expect(w.manager.currentTime).toBe(5);
    setInactive(false);
    expect((w.root.children[0] as RVDelay).startT).toBe(5);
    expect((w.root as unknown as { cycleStartTime: number }).cycleStartTime).toBe(5);
    expect(w.pending('Core.Settle')).toHaveLength(1);
    w.manager.processAnimated(0);
    expect(w.pending('Core.Due').map(e => e.time)).toEqual([6]);
    w.root.autoLoop = false;
    w.manager.processAnimated(1);
    expect(w.root.state).toBe(StepState.Finished);
    expect(w.root.minCycleTime).toBe(1);
    expect(w.trace.filter(([name, time]) => name === 'Core.Due' && time > 5)).toEqual([['Core.Due', 6]]);
  });

  it('replaces an active Delay deadline immediately after a runtime edit', () => {
    const w = world([['Delay', 'LogicStep_Delay', { Duration: 1 }]]);
    w.begin(); w.manager.processAnimated(0.1);
    expect(w.pending('Core.Due').map(e => e.time)).toEqual([1]);
    const delay = w.root.children[0] as RVDelay;
    expect(w.engine.reapplyStepFields(delay.hierarchyPath, 'LogicStep_Delay', { Duration: 0.25 })).toBe(true);
    expect(w.pending('Core.Settle')).toHaveLength(1);
    w.manager.processAnimated(0);
    expect(w.pending('Core.Due').map(e => e.time)).toEqual([0.25]);
    expect(w.manager.getEventQueueSnapshot().some(e => e.actionName === 'Core.Due' && e.time === 1 && !e.cancelled)).toBe(false);
    w.drain();
    expect(w.root.state).toBe(StepState.Finished);
    expect(w.root.minCycleTime).toBe(0.25);
    expect(w.trace.filter(([name]) => name === 'Core.Due')).toEqual([['Core.Due', 0.25]]);
  });

  it('classifies a plugin through lazy DES options after entry and unregisters only its own options', () => {
    class PluginWait extends RVLogicStep {
      start() { this.state = StepState.Waiting; }
      fixedUpdate() {}
      get progress() { return 0; }
    }
    const off = registerLogicStepBuilder('LogicStep_Registered', () => new PluginWait());
    const offOld = registerLogicStepDesOptions('LogicStep_Registered', { eventMode: 'instant' });
    const offOptions = registerLogicStepDesOptions('LogicStep_Registered', { eventMode: 'wait', snapshot: true });
    try {
      offOld();
      const w = world([['Plugin', 'LogicStep_Registered']]); w.begin();
      const plugin = w.root.children[0];
      expect(w.engine.desHooks).not.toBeNull();
      expect(logicStepDesInfo(plugin, w.engine)).toEqual({ type: 'LogicStep_Registered', eventMode: 'wait', snapshot: true });
      expect(logicDesFindings(w.engine)).toEqual([]);
      expect(logicSnapshotBlockerReason(w.engine)).toBeNull();
      offOptions();
      expect(logicStepDesInfo(plugin, w.engine)).toEqual({ type: 'LogicStep_Registered' });
      expect(logicDesFindings(w.engine)).toEqual([expect.objectContaining({ rule: 'event-mapping' })]);
      expect(logicSnapshotBlockerReason(w.engine)).toBe('LogicStep type LogicStep_Registered has no snapshot participant');
    } finally { offOptions(); offOld(); off(); }
  });

  it.each([0.1, 1 / 3])('uses the first subtraction-safe Delay deadline (%s)', duration => {
    const w = world([['Delay', 'LogicStep_Delay', { Duration: duration }]]);
    const start = 0.1 + 0.2;
    w.begin(start);
    w.runner.step();
    const due = w.pending('Core.Due')[0].time;
    expect(due).toBe(duration === 0.1 ? 0.4000000000000001 : 0.6333333333333334);
    expect(w.root.state).toBe(StepState.Active);
    w.runner.step(); expect(w.manager.currentTime).toBe(due);
    w.runner.step(); expect(w.root.state).toBe(StepState.Finished);
    expect(w.root.minCycleTime).toBe(due - start);
    w.drain();
    expect(w.trace).toEqual([['Core.Cycle', 0], ['Core.Settle', 0], ['Core.Settle', start],
      ['Core.Due', due], ['Core.Settle', due]]);
  });

  it('keeps the native sum when the subtraction deadline is already due', () => {
    const w = world([['Delay', 'LogicStep_Delay', { Duration: 0.1 }]]);
    w.begin(0.2); w.runner.step();
    expect(w.pending('Core.Due')[0].time).toBe(0.30000000000000004);
    w.drain(); expect(w.root.state).toBe(StepState.Finished);
    expect(w.trace.filter(([name]) => name === 'Core.Due')).toEqual([['Core.Due', 0.30000000000000004]]);
  });

  it.each(['Level', 'Rising'])('wakes a %s wait only on relevant writes and preserves a short pulse', edge => {
    const w = world([['Wait', 'LogicStep_WaitForSignalBool', { Signal: signal('Go'), Edge: edge }]]);
    w.begin(); w.drain();
    expect(w.root.state).toBe(StepState.Active);
    expect(w.trace).toEqual([['Core.Cycle', 0], ['Core.Settle', 0]]);
    w.runner.tick(0.5); w.drain();
    w.signalStore.set('pos', 1); w.drain();
    expect(w.trace.filter(([name]) => name === 'Core.Settle')).toHaveLength(1);
    w.signalStore.set('go', true); w.signalStore.set('go', false);
    expect(w.pending('Core.Settle')).toHaveLength(1);
    w.drain();
    expect(w.root.state).toBe(StepState.Finished);
    expect(w.trace.filter(([name]) => name === 'Core.Settle')).toEqual([['Core.Settle', 0], ['Core.Settle', 0.01]]);
  });

  it('reads Float, Jump and signal-driven DriveTo addresses statically', () => {
    const w = world([
      ['Float', 'LogicStep_WaitForSignalFloat', { Signal: signal('Pos', 'PLCOutputFloat'), Comparison: 'GreaterThan', Value: 2 }],
      ['Jump', 'LogicStep_JumpOnSignal', { Signal: signal('Go'), JumpToStep: 'End' }],
      ['Move', 'LogicStep_DriveTo', { DestinationFromPLCOutput: signal('Pos', 'PLCOutputFloat') }],
      ['End', 'LogicStep_Delay', { Duration: 0 }],
    ]);
    w.begin(); w.drain();
    w.signalStore.set('pos', 3); w.signalStore.set('go', true); w.drain();
    expect(w.root.state).toBe(StepState.Finished);
    expect(w.trace.filter(([name]) => name === 'Core.Settle')).toHaveLength(2);
  });

  it('finishes DriveTo in the arrival cycle', () => {
    const w = world([['Move', 'LogicStep_DriveTo', { drive: { type: 'ComponentReference', path: 'Root/Axis', componentType: 'Drive' }, Destination: 2 }]]);
    const axis = new Object3D(); axis.name = 'Axis'; w.scene.add(axis);
    const drive = new RVDrive(axis); drive.initDrive(); drive.TargetSpeed = 100;
    w.host.drives.push(drive);
    // Resolve the drive through the same synthetic node registry as the model loader.
    w.registry.registerNode('Root/Axis', axis); w.registry.register('Drive', 'Root/Axis', drive);
    w.engine.removeSubtree(w.rootNode); w.engine.addSubtree(w.rootNode, w.registry, w.signalStore);
    const root = w.engine.roots[0] as RVSerialContainer; root.autoLoop = false;
    w.begin(); w.drain();
    expect(drive.currentPosition).toBe(2); expect(root.state).toBe(StepState.Finished);
    expect(w.trace).toEqual([['Core.Cycle', 0], ['Core.Settle', 0], ['Core.Cycle', 0.01],
      ['Core.Settle', 0.01], ['Core.Cycle', 0.02], ['Core.Cycle', 0.03]]);
  });

  it.each(['sensor', 'zone'] as const)('wakes from a %s listener and removes it on detach', kind => {
    const w = world([['Placeholder', 'LogicStep_Delay', { Duration: 10 }]]);
    const node = new Object3D();
    const sensor = new RVSensor(node, AABB.fromHalfSize(node, new Vector3(1, 1, 1)));
    const zone = new RVZone(node);
    const wait = kind === 'sensor' ? new RVWaitForSensor(sensor, true) : new RVWaitForZone(zone, true);
    w.root.children = [wait];
    // Reattach context for the direct component references used in this notification test.
    wait.rootContext = w.root.rootContext;
    w.begin(); w.drain();
    const change = () => {
      if (kind === 'sensor') { sensor.invertSignal = true; sensor.applyPhysicsResult(null); }
      else (zone as unknown as { setOccupied(v: boolean): void }).setOccupied(true);
    };
    change(); w.drain();
    expect(w.root.state).toBe(StepState.Finished);
    expect(w.trace).toEqual([['Core.Cycle', 0], ['Core.Settle', 0], ['Core.Settle', 0]]);
    w.runner.clearMUs();
    expect(w.engine.desHooks).toBeNull();
    if (kind === 'sensor') { sensor.invertSignal = false; sensor.applyPhysicsResult(null); }
    else (zone as unknown as { setOccupied(v: boolean): void }).setOccupied(false);
    expect(w.pending('Core.Settle')).toEqual([]);
  });

  it('runs an instant chain in one settle event', () => {
    const w = world(Array.from({ length: 100 }, (_, i) => [`Set${i}`, 'LogicStep_SetSignalBool',
      { Signal: signal('Go'), SetToTrue: i % 2 === 0 }] as Spec));
    w.begin(); w.drain();
    expect(w.root.state).toBe(StepState.Finished);
    expect(w.trace).toEqual([['Core.Cycle', 0], ['Core.Settle', 0], ['Core.Cycle', 0.01]]);
    expect(getProblems()).toEqual([]);
  });

  it('reports an autoLoop without waits before evaluation, names it in batch hazards, and halts on overflow', () => {
    const w = world([['Instant', 'LogicStep_Delay', { Duration: 0 }]], { autoLoop: true });
    w.start();
    expect(getProblems()).toEqual([expect.objectContaining({ code: 'des-logic-not-event-suitable', nodePath: 'Root/Sequence' })]);
    expect(hazards(w.runner)).toEqual([{ system: 'LogicStep', nodes: ['Root/Sequence'] }]);
    w.engine.start(); w.drain();
    expect(w.root.state).toBe(StepState.Finished);
    expect(getProblems().some(p => p.code === 'des-settle-overflow')).toBe(true);
  });

  it.each([false, true])('halts a taken self-jump with an unreachable wait (autoLoop=%s)', autoLoop => {
    const w = world([
      ['Jump', 'LogicStep_JumpOnSignal', { Signal: signal('Go'), JumpToStep: 'Jump' }],
      ['Unreachable', 'LogicStep_Delay', { Duration: 1 }],
    ], { autoLoop });
    w.signalStore.set('go', true); w.begin(); w.drain();
    expect(w.root.state).toBe(StepState.Finished);
    expect(w.root.children[1].state).toBe(StepState.Idle);
    expect(getProblems().some(p => p.code === 'logic-instant-loop')).toBe(true);
    expect(logicDesFindings(w.engine).map(f => f.rule)).toEqual(['instant-jump']);
    clearAllProblems(); w.runner.clearMUs(); w.engine.reset(); w.engine.start(); w.engine.fixedUpdate(0.01);
    expect(w.root.state).toBe(StepState.Finished);
    expect(getProblems().some(p => p.code === 'logic-instant-loop')).toBe(true);
  });

  it('reports WaitForStopped as unsuitable and narrows the snapshot blocker to that active step', () => {
    const w = world([['Placeholder', 'LogicStep_Delay', { Duration: 10 }]]);
    const sensorNode = new Object3D();
    const sensor = new RVSensor(sensorNode, AABB.fromHalfSize(sensorNode, new Vector3(1, 1, 1)));
    const wait = new RVWaitForSensor(sensor, true, true); wait.hierarchyPath = 'Root/Sequence/Stop';
    w.root.children = [wait]; wait.rootContext = w.root.rootContext;
    w.begin(); w.drain();
    expect(logicDesFindings(w.engine)).toEqual([expect.objectContaining({ rule: 'event-mapping', severity: 'error' })]);
    expect(w.engine.snapshotBlockerReason()).toBe('LogicStep WaitForSensor(WaitForStopped) without MU-stop notification');
  });

  it('reports short polling delays as warnings without a batch hazard', () => {
    const w = world([['Poll', 'LogicStep_Delay', { Duration: 0.02 }]], { autoLoop: true });
    w.start();
    expect(getProblems()).toEqual([expect.objectContaining({ code: 'des-logic-poll-hint', severity: 'warning' })]);
    expect(hazards(w.runner)).toEqual([]);
  });

  it('does not let logic keep Core.Cycle alive and holds an infinite interactive run at rest', async () => {
    const w = world([['Wait', 'LogicStep_WaitForSignalBool', { Signal: signal('Go') }]]);
    w.begin(); w.drain();
    expect(w.pending()).toEqual([]); expect(w.manager.isComplete).toBe(false);
    expect(await w.runner.runFastForward()).toBe(false);
    expect(w.trace).toEqual([['Core.Cycle', 0], ['Core.Settle', 0]]);
  });

  it('leaves the event queue untouched without logic', () => {
    const w = cycleRunnerFixture(); w.start();
    expect(w.manager.nextEventId).toBe(0);
    expect(w.pending()).toEqual([]); expect(w.pending('Core.Settle')).toEqual([]);
    w.runner.tick(1); expect(w.manager.nextEventId).toBe(0);
  });

  it.each(['animated', 'fastforward', 'step', 'batch'] as const)('has identical Delay-chain event times in %s', async mode => {
    const w = world([['A', 'LogicStep_Delay', { Duration: 0.1 }], ['B', 'LogicStep_Delay', { Duration: 1 / 3 }]]);
    w.begin();
    if (mode === 'animated') { w.runner.setSubMode('animated'); w.runner.tick(1); }
    else if (mode === 'fastforward') await w.runner.runFastForward({ untilSimTime: 1 });
    else if (mode === 'batch') { w.runner.reset(); await w.runner.whenCycleOwnersReady(); w.drain(); }
    else w.drain();
    expect(w.root.state).toBe(StepState.Finished);
    expect(w.root.minCycleTime).toBe(0.1 + 1 / 3);
    expect(w.trace).toEqual([['Core.Cycle', 0], ['Core.Settle', 0], ['Core.Due', 0.1], ['Core.Settle', 0.1],
      ['Core.Due', 0.1 + 1 / 3], ['Core.Settle', 0.1 + 1 / 3]]);
  });

  it('repeats the start pass after every batch replication and refills a large reset image', async () => {
    const w = world([['Wait', 'LogicStep_WaitForSignalBool', { Signal: signal('Go') }],
      ['Delay', 'LogicStep_Delay', { Duration: 0.1 }]]);
    w.begin(); w.drain();
    const update = vi.spyOn(w.engine, 'fixedUpdate');
    w.runner.simEvents.registerResetHook('test.image', () => {
      for (let i = 0; i < 100; i++) w.signalStore.set('go', i % 2 === 0);
    });
    for (let replication = 0; replication < 2; replication++) {
      // Replication reset discards intermediate writes and fills the image from the final store.
      w.runner.reset(); await w.runner.whenCycleOwnersReady();
      update.mockClear(); w.trace.length = 0;
      w.drain();
      expect(update.mock.calls[0]).toEqual([0]);
      expect(w.root.state).toBe(StepState.Active);
      w.signalStore.set('go', true); w.drain();
      expect(w.root.state).toBe(StepState.Finished);
      expect(w.trace).toEqual([['Core.Cycle', 0], ['Core.Settle', 0], ['Core.Settle', 0],
        ['Core.Cycle', 0.01], ['Core.Due', 0.1], ['Core.Settle', 0.1]]);
      expect(getProblems()).toEqual([]);
      w.signalStore.set('go', false);
    }
  });

  it('starts a placed root on the current event clock while preserving an existing root deadline', () => {
    const w = world([['Delay', 'LogicStep_Delay', { Duration: 10 }]]);
    w.begin(); w.manager.processAnimated(2);
    const placed = new Object3D(); placed.name = 'Placed'; w.scene.add(placed);
    placed.userData.realvirtual = { LogicStep_SerialContainer: {} };
    const leaf = new Object3D(); leaf.name = 'Delay'; placed.add(leaf);
    leaf.userData.realvirtual = { LogicStep_Delay: { Duration: 1 } };
    for (const node of [placed, leaf]) w.registry.registerNode(`Root/${NodeRegistry.computeNodePath(node)}`, node);
    w.engine.addSubtree(placed, w.registry, w.signalStore);
    const added = w.engine.roots[1] as RVSerialContainer; added.autoLoop = false;
    w.runner.tick(0); w.manager.processAnimated(0);
    expect(w.pending('Core.Due').map(e => e.time)).toEqual([3]);
    w.manager.processAnimated(1);
    expect(added.state).toBe(StepState.Finished); expect(added.minCycleTime).toBe(1);
    expect(w.pending('Core.Due').map(e => e.time)).toEqual([10]);
    expect(w.root.state).toBe(StepState.Active);
  });

  it('re-registers for root replacement at the same length and clears findings on disposal', () => {
    const w = world([['Delay', 'LogicStep_Delay', { Duration: 0.02 }]], { autoLoop: true });
    w.begin(); w.runner.step(); w.runner.step();
    const replacement = new RVSerialContainer([new RVDelay(1)], false); replacement.name = 'Replacement';
    w.engine.roots.splice(0, 1, replacement);
    w.engine.start(); w.runner.tick(0);
    expect(getProblems()).toEqual([]);
    expect(w.pending('Core.Settle')).toHaveLength(1);
    w.runner.dispose(); expect(w.engine.desHooks).toBeNull();
    expect(getProblems()).toEqual([]);
  });

  it.each([undefined, 'instant', 'wait', 'motion'] as const)('checks plugin event mapping (%s) and polls motion waits without keeping the cycle alive', mode => {
    class PluginWait extends RVLogicStep {
      start() { this.state = StepState.Waiting; }
      fixedUpdate() {}
      get progress() { return 0; }
    }
    const off = registerLogicStepBuilder('LogicStep_TestEvent', () => new PluginWait());
    const offOptions = registerLogicStepDesOptions('LogicStep_TestEvent', { eventMode: mode });
    try {
      const w = world([['Plugin', 'LogicStep_TestEvent']]); w.begin(); w.manager.processAnimated(0);
      expect(logicDesFindings(w.engine).length).toBe(mode ? 0 : 1);
      expect(logicSnapshotBlockerReason(w.engine)).toBe('LogicStep type LogicStep_TestEvent has no snapshot participant');
      expect(w.pending()).toEqual([]);
      const before = w.trace.length;
      w.runner.simEvents.registerCycleParticipant('test.motion', 20, { alive: () => false, step: () => {} });
      w.runner.setCycleTime(0.02); w.manager.processAnimated(0);
      expect(w.trace.slice(before)).toEqual(mode === 'motion'
        ? [['Core.Cycle', 0], ['Core.Settle', 0]] : [['Core.Cycle', 0]]);
    } finally { offOptions(); off(); }
  });
});
