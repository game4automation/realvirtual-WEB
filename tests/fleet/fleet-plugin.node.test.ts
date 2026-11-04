// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Group } from 'three';
import { FleetPlugin, type FleetSceneBinder } from '../../src/plugins/fleet-plugin';
import type { PlantParameters, PlantPluginDefinition } from '../../src/core/fleet/define-plant-plugin';
import type { FleetJobRunner } from '../../src/core/fleet/exec/job-runner';
import type { FleetKernelAdapters } from '../../src/core/fleet/exec/backends';
import type { PlanningDeclaration } from '../../src/core/planning/rv-planning-params';
import type { DesLifecycleEvent } from '../../src/core/material-flow/simulation-kernel';
import type { RVViewer } from '../../src/core/rv-viewer';
import type { LoadResult } from '../../src/core/engine/rv-scene-loader';
import { clearAllProblems, getProblems } from '../../src/core/hmi/problems-store';
import { robotDemoWorld } from '../des/continuation-world-fixture';
import type { DESRunner } from '../../src/plugins/des/des-runner';
import { OrderPool } from '../../src/core/fleet/core/orders';

const fleet = vi.hoisted(() => ({ listeners: new Set<() => void>() }));
vi.mock('../../src/core/engine/rv-agv-fleet', () => ({ getDefaultAgvFleet: () => ({
  onRegister: (fn: () => void) => { fleet.listeners.add(fn); return () => fleet.listeners.delete(fn); },
}) }));

const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}
const active: FleetPlugin[] = [];
interface FakeBackend {
  kind: 'des' | 'continuous';
  onClockRestart: ((why?: string) => void) | null;
  onSnapshotRestored: (() => void) | null;
  attach(): () => void;
  dispose(): void;
}
beforeEach(() => clearAllProblems());
afterEach(() => { for (const p of active.splice(0)) p.dispose(); fleet.listeners.clear(); });

function harness(mode = 'continuous', sceneReady: Promise<void> = Promise.resolve()) {
  const log: string[] = [];
  const listeners = new Map<string, Set<() => void>>();
  const lifecycle = new Set<(e: DesLifecycleEvent) => void>();
  const manager = {};
  const providerLog: string[] = [];
  const runner = { liveInstances: [{}], lifecycleState: 'bound', lifecycleGeneration: 1, getManager: () => manager,
    registerSnapshotProvider: vi.fn(() => { providerLog.push('register'); return () => { providerLog.push('unregister'); }; }) };
  const kernel = {
    mode, desControl: () => runner, hasDesLifecycle: () => true,
    onDesLifecycle(fn: (e: DesLifecycleEvent) => void, opts?: { replay?: boolean }) {
      lifecycle.add(fn);
      if (opts?.replay && kernel.mode === 'des') fn({ type: 'bound', generation: runner.lifecycleGeneration, runnerId: 1 });
      return () => { lifecycle.delete(fn); };
    },
  };
  let declaration!: PlanningDeclaration;
  const handle = { values: () => ({}), get: () => undefined, commitPending: vi.fn(), redeclare: vi.fn(),
    dispose: () => log.push('planning.dispose') };
  const viewer = {
    simulationKernel: kernel, _simLoop: {}, inStructuralEdit: false, simTime: 7,
    whenSceneReady: vi.fn(() => sceneReady),
    getPlugin: () => ({ id: 'planning-parameters', registry: { declare(d: PlanningDeclaration) {
      declaration = d; log.push('planning.declare'); return handle;
    } } }),
    on(name: string, fn: () => void) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name)!.add(fn);
      return () => { listeners.get(name)!.delete(fn); };
    },
  };
  const scheduled: Array<() => void> = [];
  const runs: FleetJobRunner[] = [];
  const backends: FakeBackend[] = [];
  function backend(kind: 'des' | 'continuous'): FakeBackend {
    const b = { kind, onClockRestart: null as ((why?: string) => void) | null,
      onSnapshotRestored: null as (() => void) | null,
      attach: () => { log.push('attach'); return () => log.push('detach'); },
      dispose: () => log.push('backend.dispose'),
    };
    backends.push(b);
    return b;
  }
  const binder: FleetSceneBinder = {
    bindContinuous: vi.fn(() => { log.push('bind.continuous'); return { ok: true, backend: backend('continuous') } as unknown as ReturnType<FleetSceneBinder['bindContinuous']>; }),
    bindDes: vi.fn(() => { log.push('bind.des'); return { ok: true, backend: backend('des') } as unknown as ReturnType<FleetSceneBinder['bindDes']>; }),
    createRun: vi.fn((adapters: FleetKernelAdapters) => {
      log.push('create');
      const rt = { adapters, dispatcher: { orders: new OrderPool(), station: () => ({}) },
        start: () => log.push('start'), prepareReset: () => log.push('prepare'),
        dispose: () => { log.push('dispose'); adapters.handover?.dispose(); },
        frame: () => log.push('frame'), kick: () => log.push('kick'),
        setRng: vi.fn(), // plan-2051: the plugin sets a fresh takt RNG before every start
        scheduleNow: (fn: () => void, valid?: () => boolean) => scheduled.push(() => { if (!valid || valid()) fn(); }),
      } as unknown as FleetJobRunner;
      runs.push(rt); return rt;
    }),
    reconfigure: vi.fn(() => { log.push('reconfigure'); }),
  };
  const parameters: PlantParameters = {
    adoptDocument: () => { log.push('adopt'); },
    declare: () => { log.push('declare'); return { owner: 'minimal', title: 'Minimal plant', params: [] }; },
    onLive: (change, ctx) => { log.push('live'); ctx.reconfigure({ value: change.to }); ctx.applied(7); },
    onStructuralReset: async (_req, ctx) => { log.push('structural'); ctx.reconfigure({ rebuilt: true }); },
    dispose: () => { log.push('parameters.dispose'); },
  };
  const definition: PlantPluginDefinition = { apiVersion: 1, id: 'minimal', config: { project: 42 }, parameters };
  const plugin = new FleetPlugin(definition, binder);
  active.push(plugin);
  plugin.init(viewer as unknown as RVViewer);
  const load = () => plugin.onModelLoaded({ root: new Group() } as unknown as LoadResult);
  const emit = (name: string) => { for (const fn of listeners.get(name) ?? []) fn(); };
  const des = (type: DesLifecycleEvent['type']) => {
    runner.lifecycleState = type === 'reset' ? 'reset' : 'bound';
    runner.lifecycleGeneration++;
    for (const fn of lifecycle) fn({ type, generation: runner.lifecycleGeneration, runnerId: 1 });
  };
  return { plugin, binder, definition, parameters, log, viewer, kernel, runner, load, emit, des,
    runs, backends, scheduled, listeners, lifecycle, providerLog, declaration: () => declaration };
}

describe('FleetPlugin lifecycle with a minimal project binder', () => {
  it('keeps restored orders, completed count and RNG without starting or reseeding', async () => {
    const h = harness('des'); h.load(); await settle();
    const world = robotDemoWorld();
    const runner = world.runner as unknown as DESRunner;
    try {
      const provider = h.runner.registerSnapshotProvider.mock.calls[0] as unknown as [string, Parameters<DESRunner['registerSnapshotProvider']>[1]];
      runner.registerSnapshotProvider(provider[0], provider[1]);
      const runtime = h.runs[0], pool = runtime.dispatcher.orders;
      const done = pool.add({ source: 'S', destination: 'D', priority: 0 }, 0);
      pool.assign(done, 'V', 0); pool.markPicked(done, 0); pool.complete(done, 0);
      pool.add({ source: 'S2', destination: 'D', priority: 0 }, 1);
      const saved = runner.fullSnapshot(), orders = pool.exportState();
      const rng = runner.getManager().snapshot().rngState;
      pool.reset(); runner.getManager().rng.next();
      h.log.length = 0;
      vi.mocked(runtime.setRng).mockClear();
      runner.restoreFull(saved);
      h.des('restored');
      h.backends[0].onSnapshotRestored!();
      h.backends[0].onClockRestart!('restore');
      expect(pool.exportState()).toEqual(orders);
      expect(pool.doneCount).toBe(1);
      expect(pool.pendingCount).toBeGreaterThan(0);
      expect(runner.getManager().snapshot().rngState).toEqual(rng);
      expect(h.log).toEqual([]);
      expect(runtime.setRng).not.toHaveBeenCalled();
      h.backends[0].onClockRestart!('reset');
      expect(h.log).toEqual(['start']);
      expect(runtime.setRng).toHaveBeenCalledOnce();
    } finally { await world.dispose?.(); }
  });

  it('unregisters snapshot providers before a DES generation rebind and on disposal', async () => {
    const h = harness('des'); h.load(); await settle();
    expect(h.runner.registerSnapshotProvider).toHaveBeenCalledWith('minimal:fleet', expect.any(Function));
    h.providerLog.length = 0;
    h.des('reset'); h.des('bound'); await settle();
    expect(h.providerLog.indexOf('unregister')).toBeGreaterThanOrEqual(0);
    expect(h.providerLog.indexOf('unregister')).toBeLessThan(h.providerLog.indexOf('register'));
    h.providerLog.length = 0; h.plugin.dispose();
    expect(h.providerLog).toContain('unregister');
  });
  it('waits for scene readiness, binds once, and wakes on fleet registration without polling', async () => {
    const ready = deferred();
    const h = harness('continuous', ready.promise);
    h.load(); h.emit('placements-materialized'); h.emit('simulation-start');
    await settle();
    expect(h.log).toEqual(['adopt', 'declare', 'planning.declare']);
    ready.resolve(); await settle();
    expect(h.log).toEqual(['adopt', 'declare', 'planning.declare', 'bind.continuous', 'create', 'start', 'attach']);
    h.plugin.tryBind();
    expect(h.binder.createRun).toHaveBeenCalledTimes(1);
    for (const fn of fleet.listeners) fn();
    h.plugin.onRender();
    expect(h.log.slice(-2)).toEqual(['kick', 'frame']);
    expect(h.listeners.has('model-loaded')).toBe(false);
  });

  it('rebinds later placements and switches adapters after disposing the previous run', async () => {
    const h = harness(); h.load(); await settle(); h.log.length = 0;
    h.emit('layout-content-added'); await settle();
    expect(h.log).toEqual(['detach', 'dispose', 'bind.continuous', 'create', 'start', 'attach']);
    expect(h.binder.bindContinuous).toHaveBeenLastCalledWith(expect.objectContaining({ cfg: h.definition.config }));
    h.log.length = 0; h.kernel.mode = 'des'; h.emit('simulation-mode-changed'); await settle();
    expect(h.log).toEqual(['detach', 'dispose', 'bind.des', 'create', 'start']);
    expect(h.binder.bindDes).toHaveBeenCalledWith(expect.objectContaining({ runner: h.runner }));
    h.log.length = 0; h.kernel.mode = 'continuous'; h.emit('simulation-mode-changed'); await settle();
    expect(h.log).toEqual(['dispose', 'bind.continuous', 'create', 'start', 'attach']);
  });

  it('unbinds on DES reset before teardown and rebinds the same runner at its next generation', async () => {
    const h = harness('des'); h.load(); await settle(); h.log.length = 0;
    h.emit('simulation-reset'); h.des('reset');
    expect(h.log).toEqual(['prepare', 'dispose']);
    h.des('bound'); await settle();
    expect(h.log).toEqual(['prepare', 'dispose', 'bind.des', 'create', 'start']);
    h.plugin.tryBind(); expect(h.binder.bindDes).toHaveBeenCalledTimes(2);
    h.log.length = 0;
    h.des('restored');
    h.backends.at(-1)!.onSnapshotRestored!();
    h.backends.at(-1)!.onClockRestart!('restore');
    expect(h.log).toEqual([]);
    h.plugin.tryBind(); expect(h.binder.bindDes).toHaveBeenCalledTimes(2);
    expect(getProblems().filter(p => p.code === 'fleet-snapshot-unsupported')).toHaveLength(0);
    // A restore WITHOUT a fleet snapshot part still restarts the fleet and says so.
    h.backends.at(-1)!.onClockRestart!('restore-replan');
    expect(h.log).toEqual(['start']);
    expect(getProblems().filter(p => p.code === 'fleet-snapshot-unsupported')).toHaveLength(1);
  });

  it('prepares continuous reset before restarting and does not create another run', async () => {
    const h = harness(); h.load(); await settle(); h.log.length = 0;
    h.emit('simulation-reset'); h.emit('simulation-start');
    expect(h.log).toEqual(['prepare', 'start']);
    expect(h.binder.createRun).toHaveBeenCalledTimes(1);
  });

  it('retires an old runner while its replacement is still waiting for instances', async () => {
    const h = harness('des'); h.load(); await settle(); h.log.length = 0;
    const replacement = { ...h.runner, liveInstances: [] as object[] };
    h.kernel.desControl = () => replacement;
    h.emit('simulation-run-started'); await settle();
    expect(h.log).toEqual(['dispose']); expect(h.plugin.runtime).toBeNull();
    replacement.liveInstances.push({});
    h.emit('placements-materialized'); await settle();
    expect(h.log).toEqual(['dispose', 'bind.des', 'create', 'start']);
    expect(h.binder.bindDes).toHaveBeenLastCalledWith(expect.objectContaining({ runner: replacement }));
  });

  it('defers live changes to the run and preserves validity and applied-time acknowledgement', async () => {
    const h = harness(); h.load(); await settle(); h.log.length = 0;
    const applied = vi.fn(); let valid = true;
    const change = { key: 'value', effectiveKey: 'minimal.value', from: 1, to: 2, origin: 'ui', seq: 1 } as const;
    h.declaration().onLive!(change, applied, () => valid);
    expect(h.log).toEqual([]);
    h.scheduled.shift()!();
    expect(h.log).toEqual(['live', 'reconfigure']); expect(applied).toHaveBeenCalledWith(7);
    h.declaration().onLive!(change, applied, () => valid); valid = false;
    h.scheduled.shift()!(); expect(applied).toHaveBeenCalledTimes(1);
  });

  it('calls structural planning after prepare/unbind, blocks intermediate binds, and propagates rejection', async () => {
    const h = harness(); h.load(); await settle(); h.log.length = 0;
    const gate = deferred();
    h.parameters.onStructuralReset = async () => { h.log.push('structural'); await gate.promise; throw new Error('rebuild failed'); };
    const reset = h.declaration().onStructuralReset!({}, {
      documentLoadId: 'doc', signal: new AbortController().signal, awaitPlacements: async () => {},
    });
    const rejected = expect(reset).rejects.toThrow('rebuild failed');
    h.emit('placements-materialized'); await settle(); h.plugin.tryBind();
    expect(h.log).toEqual(['prepare', 'detach', 'dispose', 'structural']);
    gate.resolve(); await rejected;
    expect(h.plugin.runtime).toBeNull();
    h.emit('simulation-start');
    expect(h.log.slice(-4)).toEqual(['bind.continuous', 'create', 'start', 'attach']);
  });

  it('does not bind inside structuralEdit and passes reconfigured values to the next bind', async () => {
    const h = harness(); h.viewer.inStructuralEdit = true; h.load(); await settle();
    expect(h.binder.createRun).not.toHaveBeenCalled();
    h.viewer.inStructuralEdit = false; h.emit('simulation-start');
    await h.declaration().onStructuralReset!({}, {
      documentLoadId: 'doc', signal: new AbortController().signal, awaitPlacements: async () => {},
    });
    h.emit('simulation-start');
    expect(h.binder.bindContinuous).toHaveBeenLastCalledWith(expect.objectContaining({ cfg: { rebuilt: true } }));
  });

  it('retries pending binds only on lifecycle events and reports actual gaps', async () => {
    const h = harness();
    vi.mocked(h.binder.bindContinuous).mockReturnValueOnce({ ok: false, missing: ['placement'], pending: true });
    h.load(); await settle(); expect(h.plugin.runtime).toBeNull(); expect(getProblems()).toEqual([]);
    vi.mocked(h.binder.bindContinuous).mockReturnValueOnce({ ok: false, missing: ['fork'], pending: false });
    h.emit('placements-materialized'); await settle();
    expect(getProblems()).toEqual([expect.objectContaining({ code: 'fleet-bind-incomplete', detail: 'Missing: fork.' })]);
    h.emit('layout-content-added'); await settle(); expect(h.plugin.runtime).not.toBeNull(); expect(getProblems()).toEqual([]);
  });

  it('disposes in order, removes subscriptions, and ignores queued scene-ready work', async () => {
    const h = harness(); h.load(); await settle(); h.log.length = 0;
    h.emit('layout-content-added'); h.plugin.dispose(); await settle(); h.plugin.dispose();
    expect(h.log).toEqual(['detach', 'dispose', 'planning.dispose', 'parameters.dispose']);
    expect([...h.listeners.values()].every(s => s.size === 0)).toBe(true);
    expect(h.lifecycle.size).toBe(0); expect(fleet.listeners.size).toBe(0);
    expect(h.binder.createRun).toHaveBeenCalledTimes(1);
  });

  it('cancels an old document join and adopts the new document once', async () => {
    const ready = deferred(); const h = harness('continuous', ready.promise);
    h.load(); h.plugin.onModelCleared(); ready.resolve(); await settle();
    expect(h.binder.createRun).not.toHaveBeenCalled();
    h.load(); await settle(); expect(h.binder.createRun).toHaveBeenCalledTimes(1);
    expect(h.log.filter(s => s === 'adopt')).toHaveLength(2);
    expect(h.log.filter(s => s === 'parameters.dispose')).toHaveLength(1);
  });

  it('disposes a successful adapter bind if runtime construction fails', async () => {
    const h = harness();
    vi.mocked(h.binder.createRun).mockImplementationOnce(() => { throw new Error('invalid project runtime'); });
    h.load(); await settle();
    expect(h.plugin.runtime).toBeNull();
    expect(h.log.filter(s => s === 'backend.dispose')).toHaveLength(1);
    expect(getProblems()).toEqual([expect.objectContaining({ code: 'fleet-bind-incomplete', detail: expect.stringContaining('invalid project runtime') })]);
    h.emit('layout-content-added'); await settle(); expect(h.plugin.runtime).not.toBeNull();
  });

  it('rejects a structural reset that finishes after its document was cleared', async () => {
    const h = harness(); h.load(); await settle();
    const gate = deferred();
    h.parameters.onStructuralReset = () => gate.promise;
    const reset = h.declaration().onStructuralReset!({}, {
      documentLoadId: 'doc', signal: new AbortController().signal, awaitPlacements: async () => {},
    });
    const rejected = expect(reset).rejects.toThrow('Plant document changed');
    h.plugin.onModelCleared(); gate.resolve(); await rejected;
    expect(h.plugin.runtime).toBeNull();
    expect(h.binder.createRun).toHaveBeenCalledTimes(1);
  });

  it('provides document context and the declaration handle before scene readiness', async () => {
    const ready = deferred(); const h = harness('continuous', ready.promise);
    let context!: Parameters<PlantParameters['adoptDocument']>[1];
    h.parameters.adoptDocument = (_doc, ctx) => { context = ctx; h.log.push('adopt'); };
    h.parameters.afterDeclare = ctx => {
      expect(ctx.viewer).toBe(h.viewer);
      expect(ctx.planning).not.toBeNull();
      h.log.push('reconcile-hold');
    };
    h.load();
    expect(h.log).toEqual(['adopt', 'declare', 'planning.declare', 'reconcile-hold']);
    expect(context.planning).not.toBeNull();
    expect(context.runtime).toBeNull();
    ready.resolve(); await settle(); expect(context.runtime).toBe(h.plugin.runtime);
    h.log.length = 0;
    context.prepareUnbind();
    expect(h.log).toEqual(['prepare', 'detach', 'dispose']);
    expect(context.runtime).toBeNull();
    h.plugin.onModelCleared();
    expect(context.planning).toBeNull();
    context.prepareUnbind(); // a retained old-document context cannot touch a later run
  });

  it('finishes the deferred bind by the existing scene-ready plus one-microtask join', async () => {
    const h = harness(); h.load();
    await h.viewer.whenSceneReady();
    await Promise.resolve();
    expect(h.plugin.runtime).not.toBeNull();
  });

  it('rebinds synchronously on a bound DES lifecycle event once the document is ready', async () => {
    const h = harness('des'); h.load(); await settle();
    const old = h.plugin.runtime;
    h.des('reset'); h.des('bound');
    expect(h.plugin.runtime).not.toBeNull(); expect(h.plugin.runtime).not.toBe(old);
    expect(h.plugin.bindTrigger).toBe('des-lifecycle');
    const current = h.plugin.runtime;
    h.emit('simulation-mode-changed');
    expect(h.plugin.runtime).toBe(current); // no second bind after the kernel's bound event
  });

  it('keeps project presentation on the same bind/frame/reset/unbind lifecycle', async () => {
    const h = harness();
    h.binder.onBound = () => h.log.push('labels.attach');
    h.binder.onFrame = () => h.log.push('labels.update');
    h.binder.onReset = () => h.log.push('labels.clear');
    h.binder.onUnbind = () => h.log.push('labels.detach');
    h.load(); await settle();
    expect(h.log.slice(-3)).toEqual(['start', 'attach', 'labels.attach']);
    h.log.length = 0; h.plugin.onRender(); h.plugin.prepareUnbind();
    expect(h.log).toEqual(['frame', 'labels.update', 'prepare', 'labels.clear', 'detach', 'labels.detach', 'dispose']);
  });
});
