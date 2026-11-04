// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { testAddressRegistry } from '../helpers/test-address-registry';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Object3D } from 'three';
import { DESRunner } from '@rv/plugins/des/des-runner';
import type { MaterialFlowAdapter } from '@rv/plugins/des/material-flow-adapter';
import { _resetDesHookCache } from '@rv/plugins/des/des-hook-adapter';
import { Station } from '@rv/plugins/des/material-flow/Station';
import { CHECKPOINT_ACTION } from '@rv/plugins/des/rv-des-event';
import { createBindContext, type BindContextHost } from '../../src/core/behavior-runtime';
import { createSelf, type MaterialFlowSelf } from '../../src/core/material-flow/material-flow-self';
import { defineMaterialFlow, type MaterialFlowDefinition } from '../../src/core/material-flow/define-material-flow';
import { _resetMaterialFlowRegistry } from '../../src/core/material-flow/registry';
import { SimulationKernel, type SimDesControl, type DesPeekResult } from '../../src/core/material-flow/simulation-kernel';
import { ContinuousRunner } from '../../src/core/material-flow/continuous-runner';
import { computeDesRunState, serializeDesRunStatus } from '../../src/core/material-flow/rv-des-run-state';
import { runScopeStore } from '../../src/core/material-flow/rv-run-history-store';
import { EventEmitter } from '../../src/core/rv-events';
import { reportProblem, getProblems } from '../../src/core/hmi/problems-store';
import { ContextMenuStore } from '../../src/core/hmi/context-menu-store';
import { SignalStore } from '../../src/core/engine/rv-signal-store';
import { CommandRegistry, type CommandContext } from '../../src/core/hmi/rv-command-registry';
import { ensureDiagnoseCommandsRegistered } from '../../src/core/diagnostics/diagnose-command-descriptors';
import { ensureSimCommandsRegistered } from '../../src/plugins/sim-controller/sim-commands';
import { __resetDesRunSettingsForTest, updateDesRunSettings } from '../../src/core/hmi/des-run-settings-store';

const runners: DESRunner[] = [];
beforeEach(() => {
  _resetMaterialFlowRegistry();
  _resetDesHookCache();
  __resetDesRunSettingsForTest();
  runScopeStore.set(() => null);
});
afterEach(() => {
  for (const runner of runners.splice(0)) runner.dispose();
  __resetDesRunSettingsForTest();
});

function commands(control: () => SimDesControl | null) {
  const reasons = new Set<string>();
  const viewer = {
    simulationKernel: { desControl: control },
    resetSimulation() { (control() as unknown as { reset?(): void } | null)?.reset?.(); },
    get isSimulationPaused() { return reasons.size > 0; },
    get simulationPauseReasons() { return [...reasons]; },
    setSimulationPaused(reason: string, paused: boolean) {
      if (paused) reasons.add(reason); else reasons.delete(reason);
    },
  } as unknown as CommandContext['viewer'];
  const registry = new CommandRegistry();
  ensureDiagnoseCommandsRegistered(registry);
  async function execute<T>(id: string, args = {}): Promise<T> {
    const result = await registry.execute<T>(id, args, { origin: 'mcp', viewer });
    if (!result.ok) throw new Error(result.reason);
    return result.value;
  }
  return {
    registry, viewer, execute,
    status: () => execute<ReturnType<typeof serializeDesRunStatus>>('des.status'),
    events: (args = {}) => execute<DesPeekResult & { simTime: number }>('des.events', args),
  };
}

/** Hook-based line with finite generation stored in snapshot-persisted props. */
function line(max = Infinity, endTime = 3600) {
  const runner = new DESRunner({ subMode: 'animated' });
  runners.push(runner);
  const root = new Object3D();
  const host: BindContextHost = {
    signalStore: new SignalStore(),
    on: (e, cb) => events.on(e, cb as never),
    contextMenu: new ContextMenuStore(), drives: [], registry: null, desAddresses: testAddressRegistry(), getPlugin: () => undefined,
  };
  const events = new EventEmitter<Record<string, unknown>>();
  const source = defineMaterialFlow<MaterialFlowSelf>({
    type: 'DiagnoseSource', kind: 'source', schema: {}, continuous: {},
    setup(self) { self.prop.generated = 0; },
    des: {
      onGenerate(self) {
        const generated = Number(self.prop.generated);
        if (generated >= max) return;
        self.prop.generated = generated + 1;
        self.transfer(runner.createMU());
        if (generated + 1 < max) self.in(10, 'Generate', null);
      },
    },
  }) as MaterialFlowDefinition;
  const sink = defineMaterialFlow<MaterialFlowSelf>({
    type: 'DiagnoseSink', kind: 'sink', schema: {}, continuous: {},
    des: { onAccept() { return true; } },
  }) as MaterialFlowDefinition;
  const fired: string[] = [];
  // Custom hook names are not supported; use registered suffixes for the test callbacks.
  const hooks = { Peek: 'RotateComplete', Low: 'Freeze', First: 'Resume', Second: 'AutoRelease' } as const;
  const baseStation = Station as unknown as MaterialFlowDefinition;
  const station: MaterialFlowDefinition = {
    ...baseStation,
    des: {
      ...baseStation.des,
      onRotateComplete() {},
      onFreeze() { fired.push('Low'); },
      onResume() { fired.push('First'); },
      onAutoRelease() { fired.push('Second'); },
    },
  };
  const defs = [source, station, sink];
  const adapters: MaterialFlowAdapter[] = [];
  for (const [i, def] of defs.entries()) {
    const node = new Object3D(); node.name = ['Source', 'Station', 'Sink'][i]; root.add(node);
    const ctx = createBindContext(node, host, {}).ctx;
    const self = createSelf(ctx, def, {
      mode: 'des', local: (def.state ?? def.local)?.() ?? {},
      scheduler: runner.makeScheduler(def, () => adapters[i].entityId),
      onTransfer: mu => runner.makeTransfer(adapters[i])(mu),
    });
    self.prop.ProcessingTime = 5;
    adapters.push(runner.addInstance(def, self, node, undefined, { desId: node.name + '@' + def.type }));
  }
  for (let i = 0; i < adapters.length - 1; i++) {
    adapters[i].nextComponents = [adapters[i + 1]];
    adapters[i + 1].previousComponents = [adapters[i]];
  }
  runner.start(defs, { root });
  runner.setEndTime(endTime);
  return { runner, adapters, fired, hooks, ...commands(() => runner) };
}

/**
 * A recurring checkpoint chain (every `interval` s) through the core manager primitive. Until
 * plan-2211 the checkpoint AUTOSAVE scheduled it (`autoSaveInterval`); the autosave belongs to
 * the commercial experiment manager now (F1/E10), so a Community runner has no checkpoint
 * events by itself. The invariant under test stays the same: checkpoint-only work never counts
 * as pending model work and never appears in `des.events`.
 */
function armCheckpoints(runner: DESRunner, interval: number) {
  const manager = runner.getManager();
  manager.onCheckpoint = t => manager.scheduleCheckpoint(t + interval);
  manager.scheduleCheckpoint(manager.currentTime + interval);
}

function finish(runner: DESRunner) {
  runner.setSubMode('fastforward');
  for (let i = 0; i < 100 && !runner.runComplete; i++) runner.tick(0);
  expect(runner.runComplete).not.toBeNull();
}

describe('DES registry commands', () => {
  it('finishes at 3600 with pending model events and matches the MCP state source', async () => {
    const f = line();
    finish(f.runner);
    const status = await f.status();
    expect(status).toMatchObject({ runState: 'finished', reason: 'duration-reached', endTime: 3600 });
    expect(status.pending).toBeGreaterThan(0);
    expect(status).toMatchObject(serializeDesRunStatus(computeDesRunState(f.runner, {
      simulationPaused: false, pauseReasons: [],
    })));
  });

  it('peeks without checkpoints, filters before truncation, and does not advance time', async () => {
    const f = line();
    armCheckpoints(f.runner, 2);
    const manager = f.runner.getManager();
    const ids: number[] = [];
    for (let i = 1; i <= 8; i++) ids.push(f.adapters[1].self.in(i, f.hooks.Peek, null));
    const peekAction = manager.getEventQueueSnapshot().find(e => e.id === ids[0])!.actionName;
    expect(manager.checkpointEventId).toBeGreaterThanOrEqual(0);
    const before = manager.totalEventsProcessed;
    const result = await f.events({ limit: 5 });
    expect(result.events).toHaveLength(5);
    expect(result.total).toBeGreaterThanOrEqual(5);
    expect(result.truncated).toBe(true);
    expect(result.events.every(e => e.action !== CHECKPOINT_ACTION)).toBe(true);
    const stations = await f.events({ component: 'Station', action: peekAction });
    expect(stations.events).toHaveLength(8);
    expect(stations.events.every(e => e.component.includes('Station'))).toBe(true);
    expect(manager.totalEventsProcessed).toBe(before);
    expect(result.simTime).toBe(0);
  });

  it('lists equal-time events by priority then id, matching the next step', async () => {
    const f = line();
    const manager = f.runner.getManager();
    const self = f.adapters[1].self;
    const low = self.in(1, f.hooks.Low, null, { priority: 0 });
    const first = self.in(1, f.hooks.First, null, { priority: 5 });
    const second = self.in(1, f.hooks.Second, null, { priority: 5 });
    const snapshot = manager.getEventQueueSnapshot();
    const action = (id: number) => snapshot.find(e => e.id === id)!.actionName;
    expect((await f.events({ limit: 3 })).events.map(e => e.action))
      .toEqual([action(first), action(second), action(low)]);
    expect(f.runner.step()).toBe(true);
    expect(f.fired).toEqual(['First']);
  });

  it.each([
    // finite source (5 MUs) = the plan's LimitGeneration case on the new engine
    [5, 86400, 'stalled', 'queue-empty-before-end'],
    [5, Infinity, 'finished', 'queue-drained'],
    [Infinity, 36, 'finished', 'duration-reached'],
  ] as const)('ignores checkpoint-only work (max=%s, end=%s)', async (max, end, runState, reason) => {
    const f = line(max, end);
    armCheckpoints(f.runner, 2);
    expect(f.runner.getManager().checkpointEventId).toBeGreaterThanOrEqual(0);
    finish(f.runner);
    expect(await f.status()).toMatchObject({ runState, reason });
    if (end === Infinity) expect(JSON.parse(JSON.stringify(await f.status())).endTime).toBe('Infinity');
  });

  it.each(['json', 'full'] as const)('invalidates completion on %s restore and completes again', async format => {
    const f = line();
    f.runner.tick(1800);
    const json = f.runner.snapshotJson();
    const full = f.runner.fullSnapshot();
    expect(full.simTime).toBe(1800);
    finish(f.runner);
    expect((await f.status()).runState).toBe('finished');
    if (format === 'json') f.runner.restoreJson(json); else f.runner.restoreFull(full);
    expect((await f.status()).runState).toBe('running');
    expect(f.runner.runComplete).toBeNull();
    finish(f.runner);
    expect((await f.status()).runState).toBe('finished');
  });

  it('reopens an extended run, records a new finish, then drains at Infinity and resets', async () => {
    const f = line(800);
    finish(f.runner);
    const first = (await f.status()).finishedAt;
    f.runner.setEndTime(7200);
    expect((await f.status()).runState).toBe('running');
    finish(f.runner);
    const second = await f.status();
    expect(second.runState).toBe('finished');
    expect(second.finishedAt).not.toBe(first);
    f.runner.setEndTime(Infinity);
    expect((await f.status()).runState).toBe('running');
    finish(f.runner);
    expect(await f.status()).toMatchObject({ runState: 'finished', reason: 'queue-drained' });
    f.runner.reset();
    expect(f.runner.runComplete).toBeNull();
    expect(['idle', 'running']).toContain((await f.status()).runState);
  });

  it('Play after Run finished continues: end doubles, clock runs on, Reset restores the original end', async () => {
    const f = line(Infinity, 3600);
    ensureSimCommandsRegistered(f.registry);
    finish(f.runner);
    expect(await f.status()).toMatchObject({ runState: 'finished', endTime: 3600 });
    const processedAtEnd = f.runner.getManager().totalEventsProcessed;
    const play = await f.registry.execute<{ continued?: boolean }>('sim.playPause', { paused: false }, { origin: 'mcp', viewer: f.viewer });
    expect(play.ok && play.value.continued).toBe(true);
    expect(f.runner.runComplete).toBeNull();
    expect(await f.status()).toMatchObject({ runState: 'running', endTime: 7200 });
    finish(f.runner);
    expect(f.runner.getManager().currentTime).toBeGreaterThan(3600);
    expect(f.runner.getManager().totalEventsProcessed).toBeGreaterThan(processedAtEnd);
    expect(await f.status()).toMatchObject({ runState: 'finished', reason: 'duration-reached', endTime: 7200 });
    // a second continue extends by one more run length (3 x original)
    expect(f.runner.continueRun()).toBe(true);
    expect(f.runner.endTime).toBe(10800);
    // explicit pause never continues
    finish(f.runner);
    const pause = await f.registry.execute<{ continued?: boolean }>('sim.playPause', { paused: true }, { origin: 'mcp', viewer: f.viewer });
    expect(pause.ok && pause.value.continued).toBeUndefined();
    expect(f.runner.runComplete).not.toBeNull();
    f.runner.reset();
    expect(f.runner.endTime).toBe(3600);
    expect(f.runner.getManager().currentTime).toBe(0);
  });

  it('continuing re-arms a warm-up that was dropped at the end boundary', () => {
    const f = line(Infinity, 3600);
    f.runner.setStatResetTime(3600);
    const m = f.runner.getManager();
    let resets = 0;
    const orig = m.resetStatistics.bind(m);
    m.resetStatistics = () => { resets++; orig(); };
    finish(f.runner);
    expect(f.runner.continueRun()).toBe(true);
    finish(f.runner);
    expect(resets).toBe(1);
  });

  it('Reset after Run finished does not autostart: time 0, paused until Play', async () => {
    const f = line(Infinity, 3600);
    ensureSimCommandsRegistered(f.registry);
    finish(f.runner);
    reportProblem({ id: 'des-action-failed:X:1', code: 'des-action-failed', severity: 'error', title: 't', detail: 'd' });
    const reset = await f.registry.execute('sim.reset', {}, { origin: 'mcp', viewer: f.viewer });
    expect(reset.ok).toBe(true);
    expect(getProblems().some(p => p.code === 'des-action-failed')).toBe(false);
    expect(f.runner.getManager().currentTime).toBe(0);
    expect(f.viewer.isSimulationPaused).toBe(true);
    expect(await f.status()).toMatchObject({ runState: 'paused', simTime: 0 });
    const play = await f.registry.execute('sim.playPause', { paused: false }, { origin: 'mcp', viewer: f.viewer });
    expect(play.ok).toBe(true);
    expect(f.viewer.isSimulationPaused).toBe(false);
    expect((await f.status()).runState).not.toBe('paused');
  });

  it('does not continue a drained or unbounded run', () => {
    const f = line(5, Infinity);
    finish(f.runner);
    expect(f.runner.continueRun()).toBe(false);
    expect(f.runner.endTime).toBe(Infinity);
  });

  it('registers before a real kernel mode switch and stays available after switching back', async () => {
    const runner = new DESRunner(); runners.push(runner);
    const kernel = new SimulationKernel({
      continuousRunner: new ContinuousRunner({ update() {}, reset() {} }, { tick() {} }),
      topology: { root: new Object3D() }, desRunnerFactory: () => runner,
    });
    const f = commands(() => kernel.desControl());
    await f.registry.preload(['des.status', 'des.events']);
    for (const id of ['des.status', 'des.events']) {
      expect(f.registry.enabled(id, {}, f.viewer)).toMatchObject({ reason: 'not in DES mode', details: { hint: "web_execute(\"workspace.setMode\", {mode:\"des\"})" } });
    }
    kernel.setMode('des');
    expect((await f.status()).runState).toBe('idle');
    kernel.setMode('continuous');
    expect(f.registry.enabled('des.status', {}, f.viewer)).toMatchObject({ reason: 'not in DES mode' });
    expect(f.registry.get('des.status')?.available).toBe(true);
    kernel.dispose();
    runners.splice(runners.indexOf(runner), 1);
  });

  it('uses the viewer pause reasons through sim.playPause (minimal viewer)', async () => {
    const f = line(); f.runner.tick(20);
    ensureSimCommandsRegistered(f.registry);
    await f.execute('sim.playPause', { paused: true });
    expect(await f.status()).toMatchObject({ runState: 'paused', pauseReasons: ['user'] });
    await f.execute('sim.playPause', { paused: false });
    expect((await f.status()).runState).toBe('running');
  });

  it('returns a value for old runners without peek and clamps limits before delegation', async () => {
    const ctl = { subMode: 'animated', simTime: 0 } as SimDesControl;
    const f = commands(() => ctl);
    expect(await f.execute('des.events')).toEqual({ ok: false, reason: 'runner-without-event-peek' });
    const peek = vi.fn(() => ({ events: [], total: 0, truncated: false }));
    ctl.peekEvents = peek;
    await f.events({ limit: null, component: null, action: null });
    expect(peek).toHaveBeenLastCalledWith(20, { component: undefined, action: undefined });
    for (const [input, expected] of [[undefined, 20], [0, 1], [1000, 200], [2.9, 2]]) {
      await f.events({ limit: input, component: 'Station', action: 'Accept' });
      expect(peek).toHaveBeenLastCalledWith(expected, { component: 'Station', action: 'Accept' });
    }
  });

  it('serializes extra numeric fields and lets active fast-forward override viewer pause', async () => {
    const ctl = {
      subMode: 'fastforward', multiplier: Infinity, statResetTime: NaN,
      simTime: 10, endTime: Infinity, runComplete: null, ffProgress: 0.5,
    } as SimDesControl;
    const f = commands(() => ctl);
    f.viewer.setSimulationPaused('user', true);
    expect(JSON.parse(JSON.stringify(await f.status()))).toMatchObject({
      runState: 'running', endTime: 'Infinity', multiplier: 'Infinity', statResetTime: 'NaN',
    });
  });
});
