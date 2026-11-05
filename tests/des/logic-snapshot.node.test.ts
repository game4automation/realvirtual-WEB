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
import { RVDelay, RVLogicStep, RVSerialContainer, RVWaitForSignalBool, StepState } from '../../src/core/engine/rv-logic-step';
import { registerLogicStepBuilder } from '../../src/core/engine/rv-logic-step-registry';
import { clearAllProblems } from '../../src/core/hmi/problems-store';
import { logicStepKeyTable, logicSnapshotParticipant } from '../../src/plugins/des/rv-des-logic-snapshot';
import { logicStepNodes, logicSteps, registerLogicStepDesOptions } from '../../src/plugins/des/rv-des-logic-check';
import { fromSnapshotData, toSnapshotData } from '../../src/plugins/des/rv-snapshot-contract';
import type { SnapshotJson } from '../../src/core/sdk/rv-snapshot-contract-types';
import { assertContinuation, compareFullSnapshots } from '../helpers/des-continuation-harness';
import { continuationWorld } from './continuation-world-fixture';
import { cycleRunnerFixture } from './cycle-runner-fixture';

afterEach(() => { clearAllProblems(); vi.restoreAllMocks(); });
type Spec = [string, string, Record<string, unknown>?, Spec[]?];
const ref = (name: string, componentType: string) => ({ type: 'ComponentReference', path: `Root/${name}`, componentType });
const go = ref('Go', 'PLCOutputBool'), pos = ref('Pos', 'PLCOutputFloat'), axis = ref('Axis', 'Drive');
const delay = (name: string, duration: number): Spec => [name, 'LogicStep_Delay', { Duration: duration }];

function world(specs: Spec[], options: { active?: string; suppressed?: boolean; connected?: boolean; start?: number;
  checkpoints?: boolean; startBeforeAttach?: boolean; cycleTime?: number;
  drive?: Partial<Pick<RVDrive, 'JogForward' | 'Behaviors'>> } = {}) {
  const w = cycleRunnerFixture({ cycleTime: options.cycleTime ?? 0.25 });
  w.signalStore.register('go', 'Root/Go', false, 'PLCOutputBool');
  w.signalStore.register('pos', 'Root/Pos', 2, 'PLCOutputFloat');
  const rootNode = new Object3D(); rootNode.name = 'Sequence';
  rootNode.userData.realvirtual = { LogicStep_SerialContainer: { Active: options.active ?? 'Always' } };
  w.scene.add(rootNode);
  const add = (parent: Object3D, entries: Spec[]) => {
    for (const [name, type, data, children] of entries) {
      const node = new Object3D(); node.name = name; node.userData.realvirtual = { [type]: data ?? {} };
      parent.add(node); if (children) add(node, children);
    }
  };
  add(rootNode, specs);
  const axisNode = new Object3D(); axisNode.name = 'Axis'; w.scene.add(axisNode);
  const target = new Object3D(); target.name = 'Target'; w.scene.add(target);
  const sensorNode = new Object3D(); sensorNode.name = 'Sensor'; w.scene.add(sensorNode);
  const zoneNode = new Object3D(); zoneNode.name = 'Zone'; w.scene.add(zoneNode);
  const drive = new RVDrive(axisNode); drive.TargetSpeed = 1;
  Object.assign(drive, options.drive); drive.initDrive(); w.host.drives.push(drive);
  const sensor = new RVSensor(sensorNode, AABB.fromHalfSize(sensorNode, new Vector3(1, 1, 1)));
  const zone = new RVZone(zoneNode);
  const registry = new NodeRegistry();
  w.scene.traverse(node => registry.registerNode(node === w.scene ? 'Root' : `Root/${NodeRegistry.computeNodePath(node)}`, node));
  registry.register('Drive', 'Root/Axis', drive);
  registry.register('Sensor', 'Root/Sensor', sensor);
  registry.register('Zone', 'Root/Zone', zone);
  const engine = RVLogicEngine.build(w.scene, registry, w.signalStore);
  const root = engine.roots[0] as RVSerialContainer; root.autoLoop = false;
  w.host.logicEngine = engine; w.host.isConnected = options.connected ?? false;
  if (options.suppressed) engine.setRootSuppressed(root.name, true);
  if (options.startBeforeAttach) engine.start(w.host.isConnected);
  w.start();
  const t = options.start ?? 0;
  if (t) w.manager.processAnimated(t);
  if (!options.startBeforeAttach) engine.start(w.host.isConnected);
  if (options.checkpoints !== false) {
    w.manager.scheduleCheckpoint(t + 0.25);
    w.manager.onCheckpoint = time => {
      if (time === 0.75) {
        w.signalStore.set('go', true);
        sensor.invertSignal = true; sensor.applyPhysicsResult(null);
        (zone as unknown as { setOccupied(v: boolean): void }).setOccupied(true);
      }
      if (time === 1.25) w.signalStore.set('pos', 3);
      w.manager.scheduleCheckpoint(time + 0.25);
    };
  }
  const continuation = continuationWorld(w.runner, dt => { w.manager.processAnimated(dt); w.runner.tick(0); });
  return { ...w, ...continuation, runner: w.runner, engine, root, drive, target, sensor, zone, registry };
}

const cases: [string, Spec[], Parameters<typeof world>[1]?][] = [
  ['Delay mid-wait', [delay('Delay', 1.5)]],
  ['Rising wait', [['Wait', 'LogicStep_WaitForSignalBool', { Signal: go, Edge: 'Rising' }], delay('After', 1)]],
  ['Falling wait', [['Wait', 'LogicStep_WaitForSignalBool', { Signal: go, Edge: 'Falling' }], delay('After', 1)]],
  ['JumpOnSignal', [delay('Before', 1), ['Jump', 'LogicStep_JumpOnSignal', { Signal: go, JumpToStep: 'End' }], delay('Skipped', 10), delay('End', 0.5)]],
  ['Parallel half done', [['Parallel', 'LogicStep_ParallelContainer', {}, [delay('Quick', 0.25), delay('Slow', 1.5)]]]],
  ['DriveTo signal destination', [['Move', 'LogicStep_DriveTo', { drive: axis, DestinationFromPLCOutput: pos }], delay('After', 0.5)]],
  ['StartDriveTo', [['Start', 'LogicStep_StartDriveTo', { drive: axis, Destination: 2 }], ['Wait', 'LogicStep_WaitForDrivesAtTarget', { Drives: [axis] }]]],
  ['suppressed root', [delay('Delay', 1)], { suppressed: true }],
  ['inactive Active root', [delay('Delay', 1)], { active: 'Connected' }],
  ['Enable visibility', [['Hide', 'LogicStep_Enable', { Target: 'Root/Target', Enable: false }], delay('Delay', 1.5)]],
  ['Level wait', [['Wait', 'LogicStep_WaitForSignalBool', { Signal: go }], delay('After', 1)]],
  ['Float wait', [['Wait', 'LogicStep_WaitForSignalFloat', { Signal: pos, Comparison: 'GreaterThan', Value: 2 }], delay('After', 1)]],
  ['sensor wake', [['Wait', 'LogicStep_WaitForSensor', { Sensor: ref('Sensor', 'Sensor') }], delay('After', 1)]],
  ['zone wake', [['Wait', 'LogicStep_WaitForZone', { Zone: ref('Zone', 'Zone') }], delay('After', 1)]],
  ['instant commands and nested Serial', [['Serial', 'LogicStep_SerialContainer', {}, [
    ['Bool', 'LogicStep_SetSignalBool', { Signal: go, SetToTrue: true }],
    ['Float', 'LogicStep_SetSignalFloat', { Signal: pos, Value: 2 }],
    ['Speed', 'LogicStep_SetDriveSpeed', { drive: axis, Speed: 1 }], delay('Delay', 1.5),
  ]]]],
];

describe('core.logic continuation', () => {
  it('keeps a suppressed root Idle and its output unchanged after replication reset', async () => {
    const w = world([
      ['Write', 'LogicStep_SetSignalFloat', { Signal: pos, Value: 9 }], delay('Delay', 1),
    ], { suppressed: true, checkpoints: false });
    w.manager.processAnimated(0.05);
    expect(w.engine.isRootSuppressed(w.root.name)).toBe(true);
    expect(w.root.state).toBe(StepState.Idle);
    expect(w.signalStore.getFloatByPath('Root/Pos')).toBe(2);

    w.runner.reset(); await w.runner.whenCycleOwnersReady();
    w.manager.processAnimated(0.05);
    expect(w.engine.isRootSuppressed(w.root.name)).toBe(true);
    expect(w.root.state).toBe(StepState.Idle);
    expect(w.root.children.map(step => step.state)).toEqual([StepState.Idle, StepState.Idle]);
    expect(w.signalStore.getFloatByPath('Root/Pos')).toBe(2);
    expect(w.pending('Core.Due')).toEqual([]);
  });

  it('resets an active DriveTo without clearing a takt drive authored jog', async () => {
    const specs: Spec[] = [['Move', 'LogicStep_DriveTo', { drive: axis, Destination: 2 }]];
    // An authored behavior keeps this drive on Core.Cycle rather than a DES tween.
    const options = { checkpoints: false, cycleTime: 0.01, drive: { JogForward: true, Behaviors: ['test'] } };
    const a = world(specs, options);
    a.manager.processAnimated(0.05);
    expect(a.manager.currentTime).toBe(0.05);
    expect(a.root.children[0].state).toBe(StepState.Active);
    expect(a.drive.currentPosition).toBeGreaterThan(0);

    a.runner.reset(); await a.runner.whenCycleOwnersReady();
    const b = world(specs, options);
    expect(a.drive.jogForward).toBe(b.drive.jogForward);
    expect(a.drive.jogForward).toBe(true);
    for (const w of [a, b]) w.manager.processAnimated(0.05);
    expect(a.manager.currentTime).toBe(b.manager.currentTime);
    expect(b.drive.currentPosition).toBeGreaterThan(0);
    expect(a.drive.currentPosition).toBe(b.drive.currentPosition);
    expect(a.drive.jogForward).toBe(b.drive.jogForward);
    expect(a.drive.jogBackward).toBe(b.drive.jogBackward);
    expect(a.root.children[0].state).toBe(StepState.Active);
  });

  it('restarts a Delay with its runtime-edited duration after replication reset', async () => {
    const w = world([delay('Delay', 1)], { checkpoints: false });
    w.manager.processAnimated(0.25);
    const step = w.root.children[0] as RVDelay;
    expect(w.pending('Core.Due').map(e => e.time)).toEqual([1]);
    expect(w.engine.reapplyStepFields(step.hierarchyPath, 'LogicStep_Delay', { Duration: 2 })).toBe(true);
    expect(step.duration).toBe(2);

    w.runner.reset(); await w.runner.whenCycleOwnersReady();
    w.manager.processAnimated(0);
    expect(step.duration).toBe(2);
    expect(step.startT).toBe(0);
    expect(w.pending('Core.Due').map(e => e.time)).toEqual([2]);
    w.manager.processAnimated(1);
    expect(w.root.state).toBe(StepState.Active);
    expect(step.state).toBe(StepState.Active);
    w.manager.processAnimated(1);
    expect(w.manager.currentTime).toBe(2);
    expect(step.state).toBe(StepState.Finished);
    expect(w.root.state).toBe(StepState.Finished);
    expect(w.root.minCycleTime).toBe(2);
  });

  it.each(cases.filter(([, , options]) => !options?.suppressed))('reset immediately matches a fresh capture: %s', (_name, specs, options) => {
    const a = world(specs, { ...options, checkpoints: false });
    a.step(2);
    a.runner.reset();
    const b = world(specs, { ...options, checkpoints: false });
    expect(a.manager.currentTime).toBe(b.manager.currentTime);
    expect(a.runner.fullSnapshot().parts.find(p => p.key === 'core.logic'))
      .toEqual(b.runner.fullSnapshot().parts.find(p => p.key === 'core.logic'));
  });

  it.each([false, true])('captures before the first settle and continues bit-exactly (started before attach=%s)', startBeforeAttach => {
    const specs = [delay('Delay', 1)];
    const a = world(specs, { checkpoints: false, startBeforeAttach });
    expect((a.root.children[0] as RVDelay).startT).toBe(0);
    expect((a.root as unknown as { cycleStartTime: number }).cycleStartTime).toBe(0);
    const saved = JSON.parse(JSON.stringify(a.runner.fullSnapshot()));
    const b = world(specs, { checkpoints: false });
    b.runner.restoreFull(saved);
    compareFullSnapshots(a.runner.fullSnapshot(), b.runner.fullSnapshot());
    for (const w of [a, b]) {
      w.manager.processAnimated(0);
      expect(w.pending('Core.Due').map(e => e.time)).toEqual([1]);
      w.manager.processAnimated(1);
      expect(w.root.state).toBe(StepState.Finished);
      expect(w.root.minCycleTime).toBe(1);
    }
    compareFullSnapshots(a.runner.fullSnapshot(), b.runner.fullSnapshot());
  });

  it('clears all Serial cycle history on replication reset and replays to a fresh logic state', async () => {
    const specs: Spec[] = [['Nested', 'LogicStep_SerialContainer', {}, [delay('Delay', 0.5)]]];
    const a = world(specs, { checkpoints: false });
    a.manager.processAnimated(0.5);
    const nested = a.root.children[0] as RVSerialContainer;
    expect(a.root.completedCycles).toBe(1); expect(nested.completedCycles).toBe(1);
    a.runner.reset(); await a.runner.whenCycleOwnersReady();
    expect(a.root.completedCycles).toBe(0); expect(nested.completedCycles).toBe(0);
    expect(a.root.minCycleTime).toBe(0); expect(nested.minCycleTime).toBe(0);
    const b = world(specs, { checkpoints: false });
    expect(a.runner.fullSnapshot().parts.find(p => p.key === 'core.logic'))
      .toEqual(b.runner.fullSnapshot().parts.find(p => p.key === 'core.logic'));
    for (const w of [a, b]) w.manager.processAnimated(0.5);
    expect(a.root.completedCycles).toBe(1); expect(nested.completedCycles).toBe(1);
    expect(a.runner.fullSnapshot().parts.find(p => p.key === 'core.logic'))
      .toEqual(b.runner.fullSnapshot().parts.find(p => p.key === 'core.logic'));
  });

  it.each(cases)('%s reaches the intended capture state', (name, specs, options) => {
    const w = world(specs, options); w.step(0.5);
    const child = w.root.children[0];
    if (name === 'suppressed root' || name === 'inactive Active root') {
      expect(w.root.state).toBe(StepState.Idle);
      expect(w.engine.isRootSuppressed(w.root.name)).toBe(name === 'suppressed root');
    } else {
      expect(w.root.state).toBe(StepState.Active);
      if (name !== 'Delay mid-wait' && (name.includes('wait') || name.includes('wake'))) expect(child.state).toBe(StepState.Waiting);
      if (name === 'Parallel half done') expect((child as unknown as { finishedCount: number }).finishedCount).toBe(1);
      if (name === 'DriveTo signal destination' || name === 'StartDriveTo') {
        expect(w.drive.currentPosition).toBeGreaterThan(0); expect(w.drive.currentPosition).toBeLessThan(2);
      }
      if (name === 'StartDriveTo') expect((child as unknown as { _commandedTarget: number })._commandedTarget).toBe(2);
      if (name === 'Enable visibility') expect(w.target.visible).toBe(false);
    }
  });

  for (const mode of ['A', 'B', 'B-immediate'] as const) it.each(cases)(`${mode}: %s`, async (_name, specs, options) => {
    await assertContinuation({ mode, T: 0.5, TPrime: 2, T2: 4, buildWorld: () => world(specs, options) });
  });

  it.each(['Rising', 'Falling'])('retains a stored %s edge and a pending settle in a fresh world', edge => {
    const specs: Spec[] = [['Wait', 'LogicStep_WaitForSignalBool', { Signal: go, Edge: edge }], delay('After', 1)];
    const a = world(specs); a.step(0.5);
    a.signalStore.set('go', true); a.signalStore.set('go', false);
    const saved = JSON.parse(JSON.stringify(a.runner.fullSnapshot()));
    const b = world(specs);
    const writes = vi.fn(); const off = b.signalStore.observeWrites(writes);
    b.runner.restoreFull(saved); off();
    expect(writes).not.toHaveBeenCalled();
    compareFullSnapshots(a.runner.fullSnapshot(), b.runner.fullSnapshot());
    a.step(2); b.step(2);
    expect(a.root.state).toBe(StepState.Finished);
    compareFullSnapshots(a.runner.fullSnapshot(), b.runner.fullSnapshot());
    expect(b.trace()).toEqual(a.trace().slice(a.trace().length - b.trace().length));
  });

  it('does not rebase startT on a fresh-world wake after capture between evaluations', () => {
    const specs: Spec[] = [delay('Delay', 3), ['Read', 'LogicStep_WaitForSignalBool', { Signal: go }]];
    const a = world(specs, { start: 1, checkpoints: false });
    a.manager.processAnimated(0);
    a.manager.processAnimated(0.5); a.runner.simEvents.wake('core.logic'); a.manager.processAnimated(0);
    expect((a.root.children[0] as RVDelay).elapsed).toBe(0.5);
    a.manager.processAnimated(0.5);
    const saved = a.runner.fullSnapshot();
    expect((saved.parts.find(p => p.key === 'core.logic')!.state as { run: { lastEval: number } }).run.lastEval).toBe(1.5);
    const b = world(specs, { checkpoints: false }); b.runner.restoreFull(JSON.parse(JSON.stringify(saved)));
    for (const w of [a, b]) {
      w.manager.processAnimated(0.3); w.signalStore.set('go', true); w.manager.processAnimated(0);
      expect(w.manager.currentTime).toBe(2.3);
      expect((w.root.children[0] as RVDelay).startT).toBe(1);
      expect(w.pending('Core.Due')[0].time).toBe(4);
    }
    compareFullSnapshots(a.runner.fullSnapshot(), b.runner.fullSnapshot());
    a.manager.processAnimated(2); b.manager.processAnimated(2);
    expect(b.root.state).toBe(StepState.Finished);
    compareFullSnapshots(a.runner.fullSnapshot(), b.runner.fullSnapshot());
  });
});

const builtins = ['JavaScript', 'SerialContainer', 'ParallelContainer', 'Delay', 'SetSignalBool',
  'WaitForSignalBool', 'WaitForSensor', 'WaitForZone', 'DriveTo', 'SetDriveSpeed', 'Enable',
  'StartDriveTo', 'WaitForDrivesAtTarget', 'SetSignalFloat', 'WaitForSignalFloat', 'GripPick',
  'GripPlace', 'IKPath', 'JumpOnSignal'];

describe('core.logic ownership and contract', () => {
  it.each(builtins)('%s cold-resets runtime fields and preserves edited configuration before restarting roots', type => {
    const specs: Spec[] = [['Subject', `LogicStep_${type}`]];
    const a = world(specs, { active: 'Connected', checkpoints: false });
    const step = a.root.children[0];
    const fields = step as unknown as Record<string, unknown>;
    const configuration: Record<string, unknown> = {};
    for (const [key, kind] of Object.entries(logicStepKeyTable(step).fields)) {
      fields[key] = kind === 'state' ? StepState.Finished : kind === 'reason' ? 'suppressed-live'
        : kind === 'numbers' ? [7] : kind === 'boolean' ? true : 7;
      if (['duration', 'destination', 'value'].includes(key)) configuration[key] = fields[key];
    }
    a.runner.reset();
    const b = world(specs, { active: 'Connected', checkpoints: false });
    Object.assign(b.root.children[0], configuration);
    expect(a.runner.fullSnapshot().parts.find(p => p.key === 'core.logic'))
      .toEqual(b.runner.fullSnapshot().parts.find(p => p.key === 'core.logic'));
  });

  it('clears a previous commander before a delayed command restarts', () => {
    const specs: Spec[] = [delay('Before', 0.5), ['Start', 'LogicStep_StartDriveTo', { drive: axis, Destination: 2 }], delay('After', 1)];
    const a = world(specs, { checkpoints: false });
    a.step(1);
    const capture = () => a.runner.fullSnapshot().parts.find(p => p.key === 'core.logic')!.state as { lastCommander: unknown[] };
    expect(capture().lastCommander).toHaveLength(1);
    a.runner.reset();
    expect(capture().lastCommander).toEqual([]);
    const b = world(specs, { checkpoints: false });
    expect(capture()).toEqual(b.runner.fullSnapshot().parts.find(p => p.key === 'core.logic')!.state);
  });

  it.each(builtins)('%s declares every own key of an engine-built instance', type => {
    const w = world([['Subject', `LogicStep_${type}`]], { active: 'Connected' });
    const step = w.root.children[0];
    const table = logicStepKeyTable(step);
    expect(new Set([...table.stateKeys, ...table.services])).toEqual(new Set(Reflect.ownKeys(step)));
    expect(table.stateKeys.some(key => table.services.includes(key))).toBe(false);
    expect(() => w.runner.fullSnapshot()).not.toThrow();
  });

  it('owns engine, runtime, run, and every child; claims no drives and orders after signals/drives', () => {
    const w = world([['Start', 'LogicStep_StartDriveTo', { drive: axis, Destination: 2 }], delay('Delay', 2)]);
    w.step(0.5);
    const owner = (w.runner as unknown as { logicOwner: { participant: Parameters<typeof logicSnapshotParticipant>[1] } }).logicOwner;
    const p = logicSnapshotParticipant(w.engine, owner.participant, node => w.host.desAddresses.getAddressForNode(node));
    const owners = [...p.owners!()];
    expect(owners).toHaveLength(6);
    for (const decl of owners) expect(new Set([...decl.stateKeys, ...decl.services ?? []])).toEqual(new Set(Reflect.ownKeys(decl.owner)));
    expect(p.claimsDrives).toBeUndefined();
    const parts = w.runner.fullSnapshot().parts.map(part => part.key);
    expect(parts.indexOf('core.logic')).toBeGreaterThan(parts.indexOf('des.signals'));
    expect(parts.indexOf('core.logic')).toBeGreaterThan(parts.indexOf('des.drives'));
    expect((p.capture() as { lastCommander: string[][] }).lastCommander).toEqual([['#Axis', '#Sequence']]);
    w.runner.clearMUs(); expect(w.engine.desHooks).toBeNull();
    w.engine.reset(); w.drive.reset();
    expect(w.runner.fullSnapshot().parts.some(part => part.key === 'core.logic')).toBe(false);
  });

  it('rejects an undeclared non-enumerable child field with its owner address', () => {
    const w = world([delay('Child', 2)]);
    Object.defineProperty(w.root.children[0], 'newState', { value: 1 });
    expect(() => w.runner.fullSnapshot()).toThrow(/des-state-not-declared: core.logic.*#Child:RVDelay.newState/);
  });

  it('rejects a missing step node as unaddressable', () => {
    const w = world([delay('Child', 2)]);
    logicStepNodes(w.engine).delete(w.root.children[0]);
    expect(() => w.runner.fullSnapshot()).toThrow(/des-snapshot-unaddressable/);
  });

  it('rejects an unknown subclass instead of silently inheriting its base table', () => {
    class Unknown extends RVDelay {}
    const off = registerLogicStepBuilder('LogicStep_Unknown', () => new Unknown(2));
    const offOptions = registerLogicStepDesOptions('LogicStep_Unknown', { eventMode: 'wait', snapshot: true });
    try {
      const w = world([['Unknown', 'LogicStep_Unknown']]);
      expect(() => w.runner.fullSnapshot()).toThrow(/des-snapshot-contract.*unknown step class Unknown/);
    } finally { offOptions(); off(); }
  });

  it.each(['childCount', 'type', 'address', 'missing-step', 'missing-field', 'extra-field', 'bad-primitive', 'non-finite', 'commander'])('rejects %s before changing the destination world', mutation => {
    const w = world([delay('Child', 2)]); w.step(0.5);
    const before = w.runner.fullSnapshot(), bad = structuredClone(before);
    const data = bad.parts.find(p => p.key === 'core.logic')!.state as unknown as {
      steps: { address: string; type: string; childCount: number; state: Record<string, SnapshotJson> }[];
      lastCommander: string[][];
    };
    const child = data.steps.find(s => s.type === 'RVDelay')!;
    if (mutation === 'childCount') data.steps.find(s => s.type === 'RVSerialContainer')!.childCount++;
    if (mutation === 'type') child.type = 'Unknown';
    if (mutation === 'address') child.address = '#Unknown';
    if (mutation === 'missing-step') data.steps.pop();
    if (mutation === 'missing-field') delete child.state.startT;
    if (mutation === 'extra-field') child.state.surprise = 1;
    if (mutation === 'bad-primitive') child.state.startT = '1';
    if (mutation === 'non-finite') child.state.startT = { $num: 'NaN' };
    if (mutation === 'commander') data.lastCommander.push(['#Unknown', '#Sequence']);
    expect(() => w.runner.restoreFull(bad)).toThrow(/des-snapshot-contract/);
    compareFullSnapshots(before, w.runner.fullSnapshot());
  });

  it('roundtrips -0 using number-tags and rejects non-finite logical state', () => {
    const w = world([delay('Child', 2)]); w.step(0.5);
    (w.root.children[0] as RVDelay).elapsed = -0;
    const saved = JSON.parse(JSON.stringify(w.runner.fullSnapshot()));
    (w.root.children[0] as RVDelay).elapsed = 7;
    w.runner.restoreFull(saved);
    expect(Object.is((w.root.children[0] as RVDelay).elapsed, -0)).toBe(true);
    (w.root.children[0] as RVDelay).startT = Infinity;
    expect(() => w.runner.fullSnapshot()).toThrow(/des-snapshot-contract/);
  });

  it('commit performs only field writes; prepare validates again without changing state', () => {
    const w = world([['Hide', 'LogicStep_Enable', { Target: 'Root/Target', Enable: false }], delay('Child', 2)]); w.step(0.5);
    const owner = (w.runner as unknown as { logicOwner: { participant: Parameters<typeof logicSnapshotParticipant>[1] } }).logicOwner;
    const p = logicSnapshotParticipant(w.engine, owner.participant, node => w.host.desAddresses.getAddressForNode(node));
    const json = toSnapshotData(p.capture(), { participant: p.key, ...p.schema });
    const prepared = p.prepare(json);
    const methods = logicSteps(w.root).flatMap(step => [vi.spyOn(step, 'start'), vi.spyOn(step, 'fixedUpdate'), vi.spyOn(step, 'reset')]);
    const wake = vi.spyOn(owner.participant, 'reattachWakeListeners');
    w.target.visible = true;
    p.commit(prepared);
    expect(w.target.visible).toBe(false);
    for (const method of [...methods, wake]) expect(method).not.toHaveBeenCalled();
    const decoded = fromSnapshotData(json, { participant: p.key, ...p.schema }) as { run: { lastEval: unknown } };
    decoded.run.lastEval = false;
    expect(() => p.prepare(toSnapshotData(decoded, { participant: p.key, ...p.schema }))).toThrow(/des-snapshot-contract/);
  });
});

describe('narrow logic snapshot blockers', () => {
  class PluginWait extends RVLogicStep {
    start() { this.state = StepState.Waiting; }
    fixedUpdate() {}
    get progress() { return 0; }
  }
  it.each([
    ['JavaScript', {}, 'LogicStep JavaScriptStep has no snapshot participant'],
    ['WaitForSensor', { Sensor: ref('Sensor', 'Sensor'), WaitForStopped: true }, 'LogicStep WaitForSensor(WaitForStopped) without MU-stop notification'],
    ['PluginWait', {}, 'LogicStep type LogicStep_PluginWait has no snapshot participant'],
  ])('%s names only its unsupported active step', (type, fields, reason) => {
    const off = registerLogicStepBuilder('LogicStep_PluginWait', () => new PluginWait());
    const offOptions = registerLogicStepDesOptions('LogicStep_PluginWait', { eventMode: 'wait' });
    try {
      const w = world([['Subject', `LogicStep_${type}`, fields as Record<string, unknown>]]);
      expect(w.engine.snapshotBlockerReason()).toBe(reason);
      expect(() => w.runner.fullSnapshot()).toThrow(reason as string);
      w.root.children[0].state = StepState.Idle;
      expect(w.engine.snapshotBlockerReason()).toBeNull();
    } finally { offOptions(); off(); }
  });
  it('a waiting blocking GripPick no longer blocks snapshots', () => {
    const w = world([['Subject', 'LogicStep_GripPick', { Blocking: true }]], { active: 'Connected', checkpoints: false });
    w.root.state = StepState.Active;
    w.root.children[0].state = StepState.Waiting;
    expect(w.engine.snapshotBlockerReason()).toBeNull();
    expect(() => w.runner.fullSnapshot()).not.toThrow();
  });
});
