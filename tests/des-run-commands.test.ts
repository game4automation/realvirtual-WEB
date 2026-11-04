// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Object3D } from 'three';
import { DESRunner } from '@rv/plugins/des/des-runner';
import { _resetDesHookCache } from '@rv/plugins/des/des-hook-adapter';
import { resetDESMUCounter } from '@rv/plugins/des/rv-des-mu';
import type { MaterialFlowAdapter } from '@rv/plugins/des/material-flow-adapter';
import { createSelf, type MaterialFlowSelf, type MU } from '../src/core/material-flow/material-flow-self';
import { defineMaterialFlow, type MaterialFlowDefinition } from '../src/core/material-flow/define-material-flow';
import { _resetMaterialFlowRegistry } from '../src/core/material-flow/registry';
import { createBindContext, type BindContextHost } from '../src/core/behavior-runtime';
import { EventEmitter } from '../src/core/rv-events';
import { ContextMenuStore } from '../src/core/hmi/context-menu-store';
import { commandRegistry } from '../src/core/hmi/rv-command-registry';
import { ensureDesRunCommandsRegistered } from '../src/core/hmi/des-run-commands';
import { ensureDesPlcCommandsRegistered } from '../src/core/hmi/des-plc-commands';
import { persistDesEndTime, persistDesStatReset } from '../src/core/material-flow/des-manager-node';
import { USER_PAUSE_REASON } from '../src/core/engine/rv-constants';
import type { RVViewer } from '../src/core/rv-viewer';
import { getDesStatsGizmos } from '@rv/plugins/des/hmi/des-stats-gizmos';
import { getDesStatsHiddenKinds, isDesStatsWindowOpen, setDesStatsHiddenKinds, setDesStatsWindowOpen } from '../src/plugins/sim-controller/des-stats-window-store';
import { executeValue } from './helpers/execute-value';
import { ensureSimCommandsRegistered } from '../src/plugins/sim-controller/sim-commands';

const yieldCtl = vi.hoisted(() => ({ manual: false, pending: [] as Array<() => void> }));
vi.mock('../src/core/engine/rv-des-yield', () => {
  const yieldTurn = () => yieldCtl.manual
    ? new Promise<void>(resolve => { yieldCtl.pending.push(resolve); })
    : Promise.resolve();
  return { yieldToBrowser: yieldTurn, yieldToTimers: yieldTurn };
});

vi.mock('../src/core/material-flow/des-manager-node', async importOriginal => ({
  ...await importOriginal<typeof import('../src/core/material-flow/des-manager-node')>(),
  ensureDesManagerNode: () => 'Simulation', persistDesEndTime: vi.fn(), persistDesStatReset: vi.fn(),
}));
vi.mock('@rv/plugins/des/hmi/des-stats-gizmos', () => {
  const gizmo = { enabled: false, setEnabled(on: boolean) { this.enabled = on; } };
  return { getDesStatsGizmos: () => gizmo };
});

function makeBindContext(root: Object3D) {
  const events = new EventEmitter<Record<string, unknown>>();
  const values = new Map<string, boolean | number>();
  const host: BindContextHost = {
    signalStore: { get: (n: string) => values.get(n), set: (n: string, v: boolean | number) => values.set(n, v), subscribe: () => () => {} } as never,
    on: (e, cb) => events.on(e, cb as never), contextMenu: new ContextMenuStore(),
    drives: [] as never, registry: null, getPlugin: () => undefined,
  };
  return createBindContext(root, host, {}).ctx;
}

const runners: DESRunner[] = [];
function fixture(interval = 7, duration = 1200, empty = false) {
  const runner = new DESRunner({ subMode: 'animated', durationSeconds: duration, masterSeed: 42 });
  runners.push(runner);
  const adapters: MaterialFlowAdapter[] = [];
  const generated: number[] = [];
  const headlessAtSpawn: boolean[] = [];
  const source = defineMaterialFlow<MaterialFlowSelf>({
    type: 'CommandSource', kind: 'source', schema: {}, continuous: {},
    des: { onGenerate(self) {
      generated.push(runner.getManager().currentTime);
      headlessAtSpawn.push(runner.headlessSpawnActive);
      self.transfer(self.spawn());
      self.in(interval, 'Generate', null);
    } },
  }) as MaterialFlowDefinition;
  const station = defineMaterialFlow<MaterialFlowSelf>({
    type: 'CommandStation', kind: 'station', schema: {}, continuous: {},
    des: {
      onAccept(self, mu) { self.in(interval / 2, 'ProcessComplete', mu); return true; },
      onProcessComplete(self, mu) { if (mu) self.transfer(mu); },
    },
  }) as MaterialFlowDefinition;
  const sink = defineMaterialFlow<MaterialFlowSelf>({
    type: 'CommandSink', kind: 'sink', schema: {}, continuous: {},
    des: { onAccept() { return true; } },
  }) as MaterialFlowDefinition;
  const defs = empty ? [] : [source, station, sink];
  defs.forEach((def, index) => {
    const node = new Object3D();
    node.name = def.type;
    const self = createSelf(makeBindContext(node), def, {
      mode: 'des', scheduler: runner.makeScheduler(def, () => adapters[index].entityId),
      onTransfer: (mu: MU) => runner.makeTransfer(adapters[index])(mu),
      canAcceptDownstream: (mu: MU) => adapters[index].nextComponents.some(c => c.canAccept(mu as never)),
      spawnMU: () => runner.createMU(),
    });
    adapters.push(runner.addInstance(def, self, node, undefined, { desId: node.name + '@' + def.type }));
  });
  for (let i = 0; i < adapters.length - 1; i++) {
    adapters[i].nextComponents = [adapters[i + 1]];
    adapters[i + 1].previousComponents = [adapters[i]];
  }
  runner.start(defs, { root: new Object3D() });
  const pauseReasons: string[] = [];
  const viewer = {
    simulationKernel: { desControl: () => runner }, simulationPauseReasons: pauseReasons,
    setSimulationPaused(reason: string, paused: boolean) {
      const index = pauseReasons.indexOf(reason);
      if (paused && index < 0) pauseReasons.push(reason);
      if (!paused && index >= 0) pauseReasons.splice(index, 1);
    },
  } as unknown as RVViewer;
  const execute = (id: string, args: unknown) => commandRegistry.execute(id, args, { origin: 'ui', viewer });
  return { runner, manager: runner.getManager(), viewer, generated, headlessAtSpawn, execute };
}

beforeEach(() => {
  _resetMaterialFlowRegistry();
  _resetDesHookCache();
  resetDESMUCounter();
  ensureDesRunCommandsRegistered();
  ensureDesPlcCommandsRegistered();
  vi.clearAllMocks();
});
afterEach(() => {
  for (const runner of runners.splice(0)) runner.dispose();
  yieldCtl.manual = false;
  for (const release of yieldCtl.pending.splice(0)) release();
  vi.restoreAllMocks();
  setDesStatsWindowOpen(false);
  setDesStatsHiddenKinds([]);
  getDesStatsGizmos({} as RVViewer).setEnabled(false);
});

async function startPendingFastForward(f: ReturnType<typeof fixture>) {
  await commandRegistry.preload(['des.fastForward']);
  yieldCtl.manual = true;
  // Force one real batch per slice, independent of host CPU speed.
  let now = 0;
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => now += 20);
  const result = f.execute('des.fastForward', { untilSimTime: '00:00:10:00' });
  try {
    await vi.waitFor(() => expect(yieldCtl.pending).toHaveLength(1), { timeout: 15000, interval: 25 });
  } finally {
    clock.mockRestore();
  }
  expect(f.runner.subMode).toBe('fastforward');
  expect(f.runner.simTime).toBeLessThan(600);
  return { result };
}

/** The toolbar Play button: the real sim.playPause command, no direct manager call. */
async function pressPlay(f: ReturnType<typeof fixture>) {
  ensureSimCommandsRegistered();
  expect(f.viewer.simulationKernel!.desControl()).toBe(f.runner);
  expect(f.runner.runComplete).toBeNull();
  const result = await commandRegistry.execute('sim.playPause', { paused: false }, { origin: 'ui', viewer: f.viewer });
  expect(result).toMatchObject({ ok: true, value: { userPaused: false } });
  // The non-continue path omits `continued`; it must never be true.
  expect((result as { value: { continued?: boolean } }).value.continued ?? false).toBe(false);
  expect(f.viewer.simulationPauseReasons).not.toContain(USER_PAUSE_REASON);
}

async function fastForward(f: ReturnType<typeof fixture>, target = '00:00:10:00') {
  expect(await f.execute('des.setMode', { subMode: 'hybrid', multiplier: 5 })).toMatchObject({ ok: true });
  expect(await f.execute('des.fastForward', { untilSimTime: target })).toMatchObject({ ok: true });
  expect(f.runner.subMode).toBe('hybrid');
  expect(f.runner.multiplier).toBe(5);
  expect(f.manager.isPaused).toBe(true);
  expect(f.viewer.simulationPauseReasons).toContain(USER_PAUSE_REASON);
  // This bind context has no visual template library; assert the documented
  // fallback: FF's headless spawn gate is released by the normal mode exit.
  expect(f.runner.headlessSpawnActive).toBe(false);
  expect(f.runner.subMode).not.toBe('fastforward');
}

describe('DES run commands (plan-2031)', () => {
  it('stops between events at 600, preserves the end and resumes at 5x', async () => {
    const f = fixture();
    const times: number[] = [];
    f.runner.addTimeAdvanceListener(time => times.push(time));
    await fastForward(f);
    expect(f.runner.simTime).toBe(600);
    expect(f.manager.duration).toBe(1200);
    expect(f.manager.nextEventTime).toBe(602);
    expect(times.length).toBeGreaterThan(0);
    expect(Math.max(...times)).toBeLessThanOrEqual(600);
    expect(f.generated.at(-1)).toBe(595);
    expect(f.headlessAtSpawn).toContain(true);
    const processed = f.manager.totalEventsProcessed;
    // Repeating an already reached target is an event-processing no-op.
    await fastForward(f);
    expect(f.manager.totalEventsProcessed).toBe(processed);
    expect(f.runner.simTime).toBe(600);
    await pressPlay(f);
    f.runner.tick(0.2);
    expect(f.manager.isPaused).toBe(false);
    expect(f.runner.renderClock).toBeCloseTo(601, 8);
    f.runner.tick(0.2);
    expect(f.runner.simTime).toBe(602);
    expect(f.generated.at(-1)).toBe(602);
    expect(f.manager.totalEventsProcessed).toBeGreaterThan(processed);
  });

  it('resumes after a single target run through the real Play command and tick', async () => {
    const f = fixture();
    await fastForward(f);
    const processed = f.manager.totalEventsProcessed;
    await pressPlay(f);
    f.runner.tick(0.4);
    expect(f.manager.isPaused).toBe(false);
    expect(f.runner.simTime).toBe(602);
    expect(f.manager.totalEventsProcessed).toBeGreaterThan(processed);
  });

  it.each(['cancel', 'mode switch'] as const)('does not add a user pause after %s during FF', async action => {
    const f = fixture(0.25);
    const { result } = await startPendingFastForward(f);
    if (action === 'cancel') f.runner.cancelFastForward();
    else f.runner.setSubMode('animated');
    expect(await result).toMatchObject({ ok: true, value: { reachedTarget: false } });
    expect(f.viewer.simulationPauseReasons).not.toContain(USER_PAUSE_REASON);
    const processed = f.manager.totalEventsProcessed;
    yieldCtl.manual = false;
    for (const release of yieldCtl.pending.splice(0)) release();
    await Promise.resolve();
    expect(f.manager.totalEventsProcessed).toBe(processed);
    expect(f.viewer.simulationPauseReasons).not.toContain(USER_PAUSE_REASON);
  });

  it('refuses a parallel target run without pausing the first, which still completes', async () => {
    const f = fixture(0.25);
    const { result } = await startPendingFastForward(f);
    expect(await f.execute('des.fastForward', { untilSimTime: '00:00:05:00' })).toMatchObject({
      ok: true, value: { reachedTarget: false },
    });
    expect(f.viewer.simulationPauseReasons).not.toContain(USER_PAUSE_REASON);
    expect(f.manager.isPaused).toBe(false);
    expect(f.runner.subMode).toBe('fastforward');
    expect(yieldCtl.pending).toHaveLength(1);
    yieldCtl.manual = false;
    for (const release of yieldCtl.pending.splice(0)) release();
    expect(await result).toMatchObject({ ok: true, value: { reachedTarget: true } });
    expect(f.runner.simTime).toBe(600);
    expect(f.manager.isPaused).toBe(true);
    expect(f.viewer.simulationPauseReasons).toContain(USER_PAUSE_REASON);
  });

  it('processes an event exactly at the target', async () => {
    const f = fixture(10);
    await fastForward(f);
    expect(f.runner.simTime).toBe(600);
    expect(f.generated.at(-1)).toBe(600);
    expect(f.generated.filter(time => time === 600)).toHaveLength(1);
    expect(f.manager.nextEventTime).toBeGreaterThan(600);
  });

  it('stops inside a batch after more than 2000 events, leaving the first later event queued', async () => {
    const f = fixture(0.25);
    const times: number[] = [];
    f.runner.addTimeAdvanceListener(time => times.push(time));
    await fastForward(f);
    expect(f.manager.totalEventsProcessed).toBeGreaterThan(2000);
    expect(f.runner.simTime).toBe(600);
    expect(Math.max(...times)).toBe(600);
    expect(f.generated.at(-1)).toBe(600);
    expect(f.manager.nextEventTime).toBe(600.125);
    expect(f.manager.duration).toBe(1200);
  });

  it('finishes an empty queue without advancing to an imaginary event', async () => {
    const f = fixture(7, 1200, true);
    await fastForward(f);
    expect(f.runner.simTime).toBe(0);
    expect(f.manager.totalEventsProcessed).toBe(0);
    expect(f.manager.nextEventTime).toBe(Infinity);
    expect(f.manager.isComplete).toBe(true);
  });

  it('caps a target beyond the persisted end at the end time', async () => {
    const f = fixture(7, 60);
    await fastForward(f);
    expect(f.runner.simTime).toBe(60);
    expect(f.manager.duration).toBe(60);
    expect(f.manager.isComplete).toBe(true);
    expect(f.generated.at(-1)).toBeLessThanOrEqual(60);
    expect(f.manager.nextEventTime).toBeGreaterThan(60);
  });

  it('returns the same validation reason directly and via MCP without changing simulation state', async () => {
    const f = fixture();
    const snapshot = () => ({ time: f.runner.simTime, mode: f.runner.subMode, multiplier: f.runner.multiplier,
      end: f.manager.duration, events: f.manager.totalEventsProcessed, next: f.manager.nextEventTime,
      paused: f.manager.isPaused, reasons: [...f.viewer.simulationPauseReasons] });
    const before = snapshot();
    expect(await f.execute('des.fastForward', { untilSimTime: 'abc' })).toMatchObject({
      ok: false, kind: 'threw', reason: 'untilSimTime must be DD:HH:MM:SS',
    });
    expect(snapshot()).toEqual(before);
    expect(JSON.parse(await executeValue(f.viewer, 'des.fastForward', { untilSimTime: 'abc' })))
      .toEqual({ error: 'untilSimTime must be DD:HH:MM:SS' });
    expect(snapshot()).toEqual(before);
  });

  it('persists end and statistics-reset seconds, rejecting invalid input atomically', async () => {
    const f = fixture();
    expect(await f.execute('des.setEnd', { end: '100:00:00:00', statReset: '01:00:00:00' })).toMatchObject({ ok: true });
    expect(f.runner.endTime).toBe(8640000);
    expect(f.runner.statResetTime).toBe(86400);
    expect(persistDesEndTime).toHaveBeenCalledExactlyOnceWith('Simulation', 8640000);
    expect(persistDesStatReset).toHaveBeenCalledExactlyOnceWith('Simulation', 86400);
    expect(await f.execute('des.setEnd', { end: 'xx', statReset: '00:00:00:01' })).toMatchObject({ ok: false, reason: 'end must be DD:HH:MM:SS' });
    expect(f.runner.endTime).toBe(8640000);
    expect(f.runner.statResetTime).toBe(86400);
    expect(persistDesEndTime).toHaveBeenCalledTimes(1);
    expect(persistDesStatReset).toHaveBeenCalledTimes(1);
  });

  it('updates the statistics window, hidden kinds and scene badges', async () => {
    const f = fixture();
    expect(await f.execute('des.stats.window', { open: true, hiddenKinds: ['source', 'sink'] })).toMatchObject({ ok: true });
    expect(isDesStatsWindowOpen()).toBe(true);
    expect([...getDesStatsHiddenKinds()]).toEqual(['source', 'sink']);
    expect(await f.execute('des.badges', { on: true })).toMatchObject({ ok: true });
    expect(getDesStatsGizmos(f.viewer).enabled).toBe(true);
  });

  it('reports missing DES through enabled and a registry refusal', async () => {
    const viewer = { simulationKernel: { desControl: () => null } } as unknown as RVViewer;
    for (const id of ['des.fastForward', 'des.setEnd', 'des.stats.window', 'des.badges']) {
      await commandRegistry.preload([id]);
      expect(commandRegistry.enabled(id, {}, viewer)).toEqual({ reason: expect.stringContaining('DES not active') });
      expect(await commandRegistry.execute(id, {}, { origin: 'ui', viewer })).toMatchObject({
        ok: false, kind: 'disabled', reason: expect.stringContaining('DES not active'),
      });
    }
  });
});
