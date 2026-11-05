// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { afterEach, describe, expect, it, vi } from 'vitest';
import { Object3D, Scene } from 'three';
import type { ComponentContext } from '../../src/core/engine/rv-component-registry';
import { RVGrip } from '../../src/core/engine/rv-grip';
import { RVSource } from '../../src/core/engine/rv-source';
import { SignalStore } from '../../src/core/engine/rv-signal-store';
import { ContinuousRunner } from '../../src/core/material-flow/continuous-runner';
import { clearAllProblems, getProblems, reportProblem } from '../../src/core/hmi/problems-store';
import { cycleRunnerFixture } from './cycle-runner-fixture';

const cleanup: (() => void)[] = [];
afterEach(() => { cleanup.splice(0).reverse().forEach(off => off()); vi.restoreAllMocks(); clearAllProblems(); });
const node = (name: string) => { const n = new Object3D(); n.name = name; return n; };
const warnings = () => getProblems().filter(p => p.code === 'des-zero-time-pulse');
const detail = (field: string, address: string) => `${field} on ${address} pulses within one DES time step; grippers and classic sources do not run in DES mode until DES MU activation (plan-519)`;

const makeTransport = () => ({ grips: [] as RVGrip[], sources: [] as RVSource[], zones: new Set(), mus: [],
  gripTargets: [], surfaces: [], hasVanishingMU: false, updateTextureAnimations() {} });

function consumers(store: SignalStore, scene: Scene, transport = makeTransport()) {
  for (const name of ['pick', 'place', 'generate', 'unused'])
    store.register(name, `Root/${name}`, false, 'PLCOutputBool');
  const grip = new RVGrip(node('Grip'));
  const source = new RVSource(node('Source'));
  scene.add(grip.node, source.node);
  transport.sources.push(source);
  grip.SignalPick = 'Root/pick'; grip.SignalPlace = 'Root/place';
  source.SourceGenerate = 'Root/generate'; // Resolved loader address.
  grip.init({ signalStore: store, scene, root: scene, transportManager: transport } as unknown as ComponentContext);
  cleanup.push(() => grip.dispose());
  return { grip, source, transport };
}

function world(options: { core?: boolean; initial?: boolean; shared?: boolean; rawName?: boolean; reader?: boolean } = {}) {
  const transport = makeTransport();
  const w = cycleRunnerFixture({ core: options.core, host: { transportManager: transport } });
  const c = consumers(w.signalStore, w.scene, transport);
  if (options.initial) w.signalStore.set('pick', true, 0);
  if (options.shared) c.grip.signalPlaceAddr = 'Root/pick';
  if (options.rawName) c.source.SourceGenerate = 'generate';
  if (options.reader !== false) w.runner.simEvents.registerEventParticipant('test.reader', 0, {
    readSet: () => ['pick', 'place', 'generate', 'unused'], settle: () => false, dueTime: () => null,
  });
  w.start(); w.manager.processAnimated(0);
  return { ...w, ...c,
    settle: () => w.manager.processAnimated(0),
    write: (name: string, value: boolean) => w.signalStore.set(name, value, w.manager.currentTime * 1000),
    advance: () => { w.manager.scheduleCheckpoint(w.manager.currentTime + 1); w.manager.processAnimated(1); },
  };
}

describe('DES zero-time pulses for polling consumers', () => {
  it.each([
    ['plc:Root/Programs/Pulse', 'PLC program Root/Programs/Pulse'],
    ['plc:#live', 'the live PLC program'],
    ['logic:pulse', 'logic:pulse'],
  ])('remembers the first writer %s when another participant completes the pulse', (id, writer) => {
    const w = world();
    const registerWriter = (participant: string, order: number, value: boolean) =>
      w.runner.simEvents.registerEventParticipant(participant, order, {
        readSet: () => [], settle: () => { w.write('pick', value); return false; }, dueTime: () => null,
      });
    registerWriter(id, 0, true); registerWriter('other.writer', 1, false);
    w.runner.simEvents.wake(id); w.runner.simEvents.wake('other.writer'); w.settle();
    expect(warnings()).toEqual([expect.objectContaining({
      id: `des-zero-time-pulse:${w.runner.runnerId}:pick:#Grip:SignalPick`,
      detail: `${detail('SignalPick', '#Grip')} (written by ${writer})`,
    })]);
  });

  it('keeps an unattributed first deviation when a participant completes the pulse', () => {
    const w = world();
    w.write('pick', true);
    w.runner.simEvents.registerEventParticipant('plc:completer', 0, {
      readSet: () => [], settle: () => { w.write('pick', false); return false; }, dueTime: () => null,
    });
    w.runner.simEvents.wake('plc:completer'); w.settle();
    expect(warnings()[0].detail).toBe(detail('SignalPick', '#Grip'));
  });

  it('forgets the previous writer at a new simulation time', () => {
    const w = world();
    w.runner.simEvents.registerEventParticipant('plc:held', 0, {
      readSet: () => [], settle: () => { w.write('pick', true); return false; }, dueTime: () => null,
    });
    w.runner.simEvents.wake('plc:held'); w.settle(); w.advance();
    w.write('pick', false); w.write('pick', true);
    expect(warnings()[0].detail).toBe(detail('SignalPick', '#Grip'));
  });

  it('forgets the previous writer after silent signal restore', () => {
    const w = world();
    w.runner.simEvents.registerEventParticipant('plc:held', 0, {
      readSet: () => [], settle: () => { w.write('pick', true); return false; }, dueTime: () => null,
    });
    w.runner.simEvents.wake('plc:held'); w.settle();
    const values = new Map(w.signalStore.getAll()); values.set('pick', false);
    w.signalStore.restoreValuesSilently(values);
    w.write('pick', true); w.write('pick', false);
    expect(warnings()[0].detail).toBe(detail('SignalPick', '#Grip'));
  });

  it('reports one exact SignalPick warning on the completing write, without latching the input', () => {
    const w = world();
    w.write('pick', true); w.write('pick', false);
    expect(warnings()).toEqual([{
      id: `des-zero-time-pulse:${w.runner.runnerId}:pick:#Grip:SignalPick`,
      code: 'des-zero-time-pulse', severity: 'warning', title: 'Zero-time pulse not evaluated',
      detail: detail('SignalPick', '#Grip'), nodePath: '#Grip', at: 0,
    }]);
    expect(w.grip.pickObjects).toBe(false);
    expect(w.pending('Core.Cycle')).toEqual([]);
    w.write('pick', true); w.write('pick', false); w.settle();
    w.advance(); w.write('pick', true); w.write('pick', false); w.settle();
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0].at).toBe(0);
  });

  it.each(['pick', 'place', 'generate'])('reports %s without a signal reader or settle event', name => {
    const w = world({ reader: false });
    const field = name === 'pick' ? 'SignalPick' : name === 'place' ? 'SignalPlace' : 'SourceGenerate';
    const address = name === 'generate' ? '#Source' : '#Grip';
    expect(w.pending('Core.Settle')).toEqual([]);
    w.write(name, true);
    expect(warnings()).toEqual([]);
    w.write(name, false);
    expect(warnings()).toEqual([expect.objectContaining({
      id: `des-zero-time-pulse:${w.runner.runnerId}:${name}:${address}:${field}`,
      detail: detail(field, address), at: 0,
    })]);
    expect(w.pending('Core.Settle')).toEqual([]);
    expect(w.pending('Core.Cycle')).toEqual([]);
    w.write(name, true); w.write(name, false);
    expect(warnings()).toHaveLength(1);
  });

  it('does not report a held TRUE without a return', () => {
    const w = world();
    w.write('pick', true); w.settle(); w.advance();
    expect(warnings()).toEqual([]);
    expect(w.grip.pickObjects).toBe(true);
  });

  it('does not report transitions at two different simulation times', () => {
    const w = world();
    w.write('pick', true); w.settle(); w.advance();
    w.write('pick', false); w.settle();
    expect(w.manager.currentTime).toBe(1);
    expect(warnings()).toEqual([]);
  });

  it('ignores an unwatched signal', () => {
    const w = world();
    w.write('unused', true); w.write('unused', false); w.settle();
    expect(warnings()).toEqual([]);
  });

  it('reports SignalPlace independently', () => {
    const w = world();
    w.write('place', true); w.write('place', false); w.settle();
    expect(warnings()).toEqual([expect.objectContaining({
      id: `des-zero-time-pulse:${w.runner.runnerId}:place:#Grip:SignalPlace`,
      detail: detail('SignalPlace', '#Grip'), nodePath: '#Grip',
    })]);
    expect(w.grip.placeObjects).toBe(false);
  });

  it.each([false, true])('reports a classic SourceGenerate pulse (raw name: %s)', rawName => {
    const w = world({ rawName });
    w.advance(); w.write('generate', true); w.write('generate', false); w.settle();
    expect(warnings()).toEqual([expect.objectContaining({
      id: `des-zero-time-pulse:${w.runner.runnerId}:generate:#Source:SourceGenerate`,
      detail: detail('SourceGenerate', '#Source'), nodePath: '#Source', at: 1000,
    })]);
  });

  it('reports once per consumer field when a signal is shared', () => {
    const w = world({ shared: true });
    w.source.SourceGenerate = 'Root/pick';
    // Rebind to include the shared source address.
    w.runner.clearMUs(); w.start(); w.settle();
    w.write('pick', true); w.write('pick', false); w.settle();
    expect(warnings().map(p => p.id).sort()).toEqual([
      `des-zero-time-pulse:${w.runner.runnerId}:pick:#Grip:SignalPick`,
      `des-zero-time-pulse:${w.runner.runnerId}:pick:#Grip:SignalPlace`,
      `des-zero-time-pulse:${w.runner.runnerId}:pick:#Source:SourceGenerate`,
    ]);
  });

  it('keeps the start value across multiple settles at the same time', () => {
    const w = world();
    w.write('pick', true); w.settle();
    expect(warnings()).toEqual([]);
    w.write('pick', false); w.settle();
    expect(w.manager.currentTime).toBe(0);
    expect(warnings()).toHaveLength(1);
  });

  it('detects a return to an initially TRUE value', () => {
    const w = world({ initial: true });
    w.write('pick', false); w.write('pick', true); w.settle();
    expect(warnings()).toHaveLength(1);
  });

  it.each(['clearMUs', 'dispose'] as const)('%s detaches the watcher and clears only its warnings', action => {
    const w = world();
    reportProblem({ id: 'other-run-warning', code: 'des-zero-time-pulse', severity: 'warning', title: 'Other', detail: 'Other owner', at: 0 });
    w.write('pick', true); w.write('pick', false); w.settle();
    expect(warnings()).toHaveLength(2);
    w.runner[action]();
    expect(warnings().map(p => p.id)).toEqual(['other-run-warning']);
    w.write('pick', true); w.write('pick', false);
    expect(warnings().map(p => p.id)).toEqual(['other-run-warning']);
    if (action === 'clearMUs') {
      w.start(); w.settle();
      expect(warnings().map(p => p.id)).toEqual(['other-run-warning']);
      w.write('pick', true); w.write('pick', false); w.settle();
      expect(warnings()).toHaveLength(2);
    }
  });

  it('reads polling consumers from the topology host when no core is supplied', () => {
    const w = world({ core: false });
    w.write('pick', true); w.write('pick', false); w.settle();
    expect(warnings()).toHaveLength(1);
  });

  it('refreshes the baseline after silent signal restore', () => {
    const w = world();
    w.write('pick', true); w.settle();
    const values = new Map(w.signalStore.getAll());
    values.set('pick', false);
    w.signalStore.restoreValuesSilently(values);
    w.write('pick', true); w.settle();
    expect(warnings()).toEqual([]);
    w.write('pick', false); w.settle();
    expect(warnings()).toHaveLength(1);
  });

  it('does not attach in Continuous mode without a DES runner', () => {
    const signalStore = new SignalStore(), scene = new Scene();
    const c = consumers(signalStore, scene);
    const runner = new ContinuousRunner({ ...c.transport, update() {}, reset() {} }, { tick() {} });
    cleanup.push(() => runner.dispose());
    const observe = vi.spyOn(signalStore, 'observeWrites');
    runner.start([], { root: scene });
    for (const name of ['pick', 'place', 'generate']) {
      signalStore.set(name, true, 0); signalStore.set(name, false, 0);
    }
    runner.tick(0.02);
    expect(observe).not.toHaveBeenCalled();
    expect(warnings()).toEqual([]);
    expect(c.grip.pickObjects).toBe(false);
  });
});
