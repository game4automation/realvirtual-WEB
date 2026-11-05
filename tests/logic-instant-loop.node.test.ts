// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { afterEach, describe, expect, it, vi } from 'vitest';
import { Object3D, Vector3 } from 'three';
import { RVLogicEngine } from '../src/core/engine/rv-logic-engine';
import {
  RVDelay, RVDriveTo, RVEnable, RVJumpOnSignal, RVParallelContainer,
  RVSerialContainer, RVWaitForSignalBool, RVWaitForSignalFloat, StepState,
  type RVLogicStep,
} from '../src/core/engine/rv-logic-step';
import { registerLogicStepBuilder } from '../src/core/engine/rv-logic-step-registry';
import { resubscribeEdge } from '../src/plugins/des/rv-des-logic-snapshot';
import { logicStepDesInfo, logicStepNodes, registerLogicStepDesOptions } from '../src/plugins/des/rv-des-logic-check';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { RVDrive } from '../src/core/engine/rv-drive';
import { RVSensor } from '../src/core/engine/rv-sensor';
import { RVZone } from '../src/core/engine/rv-zone';
import { AABB } from '../src/core/engine/rv-aabb';
import { clearAllProblems, getProblems } from '../src/core/hmi/problems-store';
import { setDriveSpeedOverride } from '../src/core/engine/rv-speed-override';

afterEach(() => { clearAllProblems(); setDriveSpeedOverride(1); vi.restoreAllMocks(); });

function engineFor(root: RVLogicStep, eventTime: number | null = null): RVLogicEngine {
  const engine = new RVLogicEngine();
  engine.roots.push(root);
  engine.eventTime = eventTime;
  return engine;
}

function signals() {
  const store = new SignalStore();
  store.register('go', 'Cell/Go', true, 'PLCOutputBool');
  store.register('pos', 'Cell/Pos', 10, 'PLCOutputFloat');
  return store;
}

describe('instant transition budget', () => {
  for (const eventTime of [null, 3]) for (const autoLoop of [false, true]) for (const first of [false, true]) {
    it(`halts a taken self-jump (time=${eventTime}, autoLoop=${autoLoop}, first=${first})`, () => {
      const root = new RVSerialContainer([], autoLoop);
      root.name = 'Root'; root.hierarchyPath = 'Cell/Root';
      const jump = new RVJumpOnSignal('Cell/Go', true, 'Jump', signals(), root);
      jump.name = 'Jump';
      const wait = new RVDelay(100);
      root.children = [...(first ? [] : [new RVDelay(0)]), jump, wait];
      const engine = engineFor(root, eventTime);
      engine.start();
      engine.fixedUpdate(1 / 60);
      expect(root.state).toBe(StepState.Finished);
      expect(root.reason).toBeUndefined();
      expect(wait.state).toBe(StepState.Idle);
      expect(engine.isRunning()).toBe(false);
      expect(getProblems()).toEqual([expect.objectContaining({
        id: 'logic-instant-loop:Cell/Root', code: 'logic-instant-loop', severity: 'error',
        detail: 'Root: Cell/Root',
      })]);
      engine.updateConnection(false);
      engine.fixedUpdate(1 / 60);
      expect(root.state).toBe(StepState.Finished);
    });
  }

  it('halts the owning root and cancels motion without starting later parallel children', () => {
    const inner = new RVSerialContainer([], false);
    inner.hierarchyPath = 'Cell/Root/Inner';
    const jump = new RVJumpOnSignal('Cell/Go', true, 'Jump', signals(), inner);
    jump.name = 'Jump';
    inner.children = [new RVDelay(0), jump];
    const waiting = new RVDelay(100);
    const cancel = vi.fn();
    waiting.cancel = cancel;
    const parallel = new RVParallelContainer([inner, waiting]);
    const target = { visible: false };
    const root = new RVSerialContainer([parallel, new RVEnable(target, true)]);
    root.name = 'Root';
    const engine = engineFor(root);
    engine.start();
    engine.fixedUpdate(1 / 60);
    expect(root.state).toBe(StepState.Finished);
    expect(inner.state).toBe(StepState.Idle);
    expect(cancel).toHaveBeenCalledOnce();
    expect(waiting.elapsed).toBe(0);
    expect(target.visible).toBe(false);
    expect(getProblems()[0].detail).toBe('Root: Cell/Root/Inner');
  });

  it('preserves one autoLoop restart per update', () => {
    const root = new RVSerialContainer([new RVDelay(0)]);
    const engine = engineFor(root);
    engine.start();
    for (let i = 1; i <= 3; i++) {
      engine.fixedUpdate(1 / 60);
      expect(root.completedCycles).toBe(i);
      expect(root.state).toBe(StepState.Active);
    }
    expect(getProblems()).toEqual([]);
  });
});

describe('event time and process image hooks', () => {
  it.each([0.1, 1 / 3])('finishes Delay exactly at the subtraction deadline (%s)', duration => {
    const step = new RVDelay(duration);
    const start = 0.1 + 0.2;
    const engine = engineFor(step, start);
    setDriveSpeedOverride(10);
    engine.start();
    expect(step.startT).toBe(start);
    engine.eventTime = start + duration / 2;
    engine.fixedUpdate(100);
    expect(step.elapsed).toBe(engine.eventTime - start);
    expect(step.state).toBe(StepState.Active);
    let t = start + duration;
    if (!(t - start >= duration)) {
      engine.eventTime = t;
      engine.fixedUpdate(100);
      expect(step.state).toBe(StepState.Active);
      t += Number.EPSILON;
    }
    engine.eventTime = t;
    engine.fixedUpdate(0);
    expect((t - start >= duration)).toBe(true);
    expect(step.state).toBe(StepState.Finished);
  });

  it('preserves Continuous Delay scaling and loose-step behavior', () => {
    const step = new RVDelay(1);
    setDriveSpeedOverride(2);
    step.start();
    step.fixedUpdate(0.25);
    expect(step.elapsed).toBe(0.5);
    expect(step.state).toBe(StepState.Active);
    step.fixedUpdate(0.25);
    expect(step.state).toBe(StepState.Finished);
  });

  it('uses event time for serial cycle statistics', () => {
    const root = new RVSerialContainer([new RVDelay(1)], false);
    const engine = engineFor(root, 5);
    vi.spyOn(performance, 'now').mockReturnValue(100_000);
    engine.start();
    engine.eventTime = 6;
    engine.fixedUpdate(100);
    expect(root.minCycleTime).toBe(1);
  });

  it('Level waits read the image on start/update and fall back to the store', () => {
    const store = signals();
    const wait = new RVWaitForSignalBool('Cell/Go', true, store);
    const engine = engineFor(wait);
    engine.eventImage = new Map([['go', false]]);
    engine.start();
    expect(wait.state).toBe(StepState.Waiting);
    engine.fixedUpdate(0);
    expect(wait.state).toBe(StepState.Waiting);
    engine.eventImage = new Map([['go', true]]);
    engine.fixedUpdate(0);
    expect(wait.state).toBe(StepState.Finished);
    for (const image of [new Map<string, boolean>(), null]) {
      wait.reset(); engine.eventImage = image; wait.start();
      expect(wait.state).toBe(StepState.Finished);
    }
    wait.reset(); engine.eventImage = new Map([['go', true]]); wait.start();
    expect(wait.state).toBe(StepState.Finished);
  });

  it('JumpOnSignal reads the process image instead of taking a store-driven self-jump', () => {
    const root = new RVSerialContainer([], false);
    const wait = new RVDelay(100);
    const jump = new RVJumpOnSignal('Cell/Go', true, 'Jump', signals(), root);
    jump.name = 'Jump';
    root.children = [jump, wait];
    const engine = engineFor(root, 0);
    engine.eventImage = new Map([['go', false]]);
    engine.start(); engine.fixedUpdate(0);
    expect(wait.state).toBe(StepState.Active);
    expect(getProblems()).toEqual([]);
  });

  it('Float waits and DriveTo use image values and retain Continuous numeric reads', () => {
    const store = signals();
    const wait = new RVWaitForSignalFloat('Cell/Pos', 'Equals', 20, 0.001, store);
    const engine = engineFor(wait);
    engine.eventImage = new Map([['pos', 20]]);
    engine.start();
    expect(wait.state).toBe(StepState.Finished);
    wait.reset(); engine.eventImage = null; wait.start();
    expect(wait.state).toBe(StepState.Waiting);
    engine.eventImage = new Map([['pos', 20]]); engine.fixedUpdate(0);
    expect(wait.state).toBe(StepState.Finished);
    const drive = new RVDrive(new Object3D());
    const move = new RVDriveTo(drive, 0, false, 'Cell/Pos', store);
    const motion = engineFor(move);
    motion.eventImage = new Map([['pos', 30]]);
    motion.start();
    expect(move.destination).toBe(30);
    motion.eventImage = null; motion.fixedUpdate(0);
    expect(move.destination).toBe(10);
  });

  it('restores edge subscriptions without losing a latched pulse', () => {
    const store = signals();
    store.set('go', false);
    const wait = new RVWaitForSignalBool('Cell/Go', true, store, 'Rising');
    wait.start();
    store.set('go', true); store.set('go', false);
    resubscribeEdge(wait); resubscribeEdge(wait);
    wait.fixedUpdate(0);
    expect(wait.state).toBe(StepState.Finished);
    wait.reset(); wait.start(); resubscribeEdge(wait); wait.fixedUpdate(0);
    expect(wait.state).toBe(StepState.Waiting);
    store.set('go', true); wait.fixedUpdate(0);
    expect(wait.state).toBe(StepState.Finished);
  });
});

describe('change notifications and engine services', () => {
  it('sensor feedback listeners (logic wake source) fire once per change after the existing callback', () => {
    const node = new Object3D();
    const sensor = new RVSensor(node, AABB.fromHalfSize(node, new Vector3(1, 1, 1)));
    const order: string[] = [];
    sensor.onChanged = value => { order.push(`slot:${value}`); };
    const listener = vi.fn(() => { order.push(`listener:${sensor.occupied}`); });
    sensor.addFeedbackListener(listener);
    const off = () => sensor.removeFeedbackListener(listener);
    sensor.invertSignal = true;
    sensor.applyPhysicsResult(null); sensor.applyPhysicsResult(null);
    sensor.invertSignal = false;
    sensor.applyPhysicsResult(null); sensor.applyPhysicsResult(null);
    expect(order).toEqual(['slot:true', 'listener:true', 'slot:false', 'listener:false']);
    expect(listener).toHaveBeenCalledTimes(2);
    off(); sensor.invertSignal = true; sensor.applyPhysicsResult(null);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('zone listeners fire once per occupied change and can unsubscribe', () => {
    const zone = new RVZone(new Object3D());
    const listener = vi.fn();
    const off = zone.addOccupiedListener(listener);
    const set = (zone as unknown as { setOccupied(value: boolean): void }).setOccupied.bind(zone);
    set(true); set(true); set(false); set(false);
    expect(listener.mock.calls).toEqual([[true, zone], [false, zone]]);
    off(); set(true);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('tracks step nodes and plugin metadata, removes subtree entries, and delegates blockers', () => {
    const scene = new Object3D(); scene.name = 'Cell';
    const root = new Object3D(); root.name = 'Root'; scene.add(root);
    root.userData.realvirtual = { LogicStep_SerialContainer: {} };
    const leaf = new Object3D(); leaf.name = 'Plugin'; root.add(leaf);
    leaf.userData.realvirtual = { LogicStep_Test: {} };
    const registry = new NodeRegistry();
    scene.traverse(node => registry.registerNode(NodeRegistry.computeNodePath(node), node));
    class PluginDelay extends RVDelay {}
    const off = registerLogicStepBuilder('LogicStep_Test', () => new PluginDelay(1));
    const offOptions = registerLogicStepDesOptions('LogicStep_Test', { eventMode: 'wait', snapshot: true });
    try {
      const engine = RVLogicEngine.build(scene, registry, signals());
      const serial = engine.roots[0] as RVSerialContainer;
      expect(logicStepNodes(engine).get(serial)).toBe(root);
      expect(logicStepNodes(engine).get(serial.children[0])).toBe(leaf);
      expect(logicStepDesInfo(serial, engine)).toBeNull();
      expect(logicStepDesInfo(serial.children[0], engine)).toEqual({ type: 'LogicStep_Test', eventMode: 'wait', snapshot: true });
      engine.start();
      expect(engine.snapshotBlockerReason()).toBe('LogicStep Root');
      engine.desHooks = { blockerReason: () => null, now: () => 0, wake: () => {} };
      expect(engine.snapshotBlockerReason()).toBeNull();
      expect(engine.removeSubtree(root)).toBe(1);
      expect(logicStepNodes(engine).size).toBe(0);
      expect(engine.stepByPath.size).toBe(0);
    } finally { offOptions(); off(); }
  });
});
