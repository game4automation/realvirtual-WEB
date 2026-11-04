// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * des-rebind-scene.test.ts — plan-612 CP1d-b (boot into DES).
 *
 * `DESRunner.rebindScene()` is the viewer's answer to `placements-materialized`
 * while DES is active: it drops the scene-discovered instances and binds the
 * scene anew. This file pins what it must NOT change:
 *
 *   1. the normal path (scene complete, then DES): a rebind on the unchanged
 *      scene yields the same instance count, the same ordered topology and the
 *      same hand-over trace of a short run as the fresh bind;
 *   2. the user's reset button (`reset()`): keeps the very same instances (no
 *      rediscovery), the same count and the same trace — and it still does NOT
 *      pick up a scope stamp that arrived later (that is `rebindScene()`'s job);
 *   3. a scope stamp that arrives after the start (the placement case): only
 *      `rebindScene()` re-scopes, and the names the dropped instance wrote
 *      unscoped leave the store;
 *   4. programmatic instances (no scene discovery) stay — rebind is `reset()`;
 *   5. the kernel falls back to `reset()` for an executor without `rebindScene`.
 *
 * Runs are bounded by EVENTS and SIM TIME, never wall clock.
 * Imports `@rv/plugins/des/*` — DES is core code since plan-680.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BoxGeometry, Mesh, Object3D, Scene } from 'three';
import { DESRunner } from '@rv/plugins/des/des-runner';
import { _resetDesHookCache } from '@rv/plugins/des/des-hook-adapter';
import { resetDESMUCounter } from '@rv/plugins/des/rv-des-mu';
import type { MaterialFlowAdapter } from '@rv/plugins/des/material-flow-adapter';
import Source from '../src/behaviors/Source';
import Sink from '../src/behaviors/Sink';
import { ConveyorFlow } from '../src/behaviors/Conveyor';
import {
  _resetMaterialFlowRegistry,
  getMaterialFlow,
  registerMaterialFlow,
} from '../src/core/material-flow/registry';
import type { MaterialFlowDefinition } from '../src/core/material-flow/define-material-flow';
import type { SimulationExecutor } from '../src/core/material-flow/simulation-executor';
import { SimulationKernel } from '../src/core/material-flow/simulation-kernel';
import type { ContinuousRunner } from '../src/core/material-flow/continuous-runner';
import type { BindContextHost } from '../src/core/behavior-runtime';
import { EventEmitter } from '../src/core/rv-events';
import { ContextMenuStore } from '../src/core/hmi/context-menu-store';
import { SignalStore } from '../src/core/engine/rv-signal-store';

void Source; void Sink;

const SIM_TIME_S = 60;
const MAX_EVENTS = 4000;

const DEFS: MaterialFlowDefinition[] = [
  getMaterialFlow('Source')!,
  getMaterialFlow('Sink')!,
  ConveyorFlow as unknown as MaterialFlowDefinition,
];

function resetWorld(): void {
  _resetMaterialFlowRegistry();
  for (const d of DEFS) registerMaterialFlow(d);
  _resetDesHookCache();
  resetDESMUCounter();
}

// ─── Scene: Source → Conveyor_1 → Conveyor_2 → Sink (coincident snaps, headless) ──

interface Line { scene: Scene; host: BindContextHost; store: SignalStore; conveyor2: Object3D }

function stamp(root: Object3D): void {
  const rv = (root.userData.realvirtual ??= {}) as Record<string, unknown>;
  rv.LayoutObject = { Name: root.name };
}

function line(stampConveyor2 = true): Line {
  const scene = new Scene();
  const drives: BindContextHost['drives'] = [];
  const add = (name: string, payload: Record<string, unknown>, x: number, stamped = true): Object3D => {
    const root = new Object3D();
    root.name = name;
    root.userData.realvirtual = { ...payload };
    if (stamped) stamp(root);
    root.position.set(x, 0, 0);
    scene.add(root);
    return root;
  };
  const snapAt = (parent: Object3D, name: string, x: number): void => {
    const s = new Object3D(); s.name = name; s.position.set(x, 0, 0); parent.add(s);
  };
  const conveyor = (name: string, x: number, stamped: boolean): Object3D => {
    const root = add(name, { Conveyor: {} }, x, stamped);
    const belt = new Mesh(new BoxGeometry(1, 0.1, 0.4));
    belt.name = 'Transport-X';
    root.add(belt);
    const sensor = new Object3D(); sensor.name = 'Sensor'; root.add(sensor);
    snapAt(root, 'Snap-XN-convroll', -0.5);
    snapAt(root, 'Snap-XP-convroll', 0.5);
    drives.push({ name: 'Transport-X', node: belt, TargetSpeed: 500 });
    return root;
  };
  const src = add('Source_1', { Source: { Interval: 2, AutomaticGeneration: true } }, -0.75);
  const body = new Mesh(new BoxGeometry(0.3, 0.05, 0.3)); body.name = 'SourceBody'; src.add(body);
  snapAt(src, 'Snap-XP-convroll', 0.25);
  conveyor('Conveyor_1', 0, true);
  const conveyor2 = conveyor('Conveyor_2', 1, stampConveyor2);
  const snk = add('Sink_1', { Sink: {} }, 1.75);
  const sbody = new Mesh(new BoxGeometry(0.4, 0.4, 0.4)); sbody.name = 'SinkBody'; snk.add(sbody);
  snapAt(snk, 'Snap-XN-convroll', -0.25);
  let i = 0;
  scene.traverse((n) => { n.uuid = `00000000-0000-4000-8000-${String(i++).padStart(12, '0')}`; });
  scene.updateMatrixWorld(true);

  const events = new EventEmitter<Record<string, unknown>>();
  const store = new SignalStore();
  const host = {
    signalStore: store,
    on: (e: string, cb: (...args: unknown[]) => void) => events.on(e, cb as never),
    contextMenu: new ContextMenuStore(),
    drives,
    registry: null,
    getPlugin: () => undefined,
  } as unknown as BindContextHost;
  return { scene, host, store, conveyor2 };
}

// ─── Capture ────────────────────────────────────────────────────────────────

const nameOf = (a: unknown): string => (a as { node?: Object3D }).node?.name ?? '?';

function topology(runner: DESRunner): string {
  return runner.liveInstances.map((inst) => {
    const a = inst.adapter as MaterialFlowAdapter;
    return `${inst.self.root.name}<${inst.def.type}> next=[${a.nextComponents.map(nameOf).join(',')}] prev=[${a.previousComponents.map(nameOf).join(',')}]`;
  }).join('\n');
}

/** Wrap the CURRENT adapters, run a bounded slice, return the hand-over trace. */
function run(runner: DESRunner): string[] {
  const manager = runner.getManager();
  const trace: string[] = [];
  for (const inst of runner.liveInstances) {
    const a = inst.adapter as MaterialFlowAdapter;
    const orig = a.acceptMU.bind(a);
    a.acceptMU = ((mu: { id: number }) => {
      const ok = orig(mu as never);
      if (ok) trace.push(`${manager.currentTime.toFixed(4)}:${mu.id}>${inst.self.root.name}`);
      return ok;
    }) as typeof a.acceptMU;
  }
  manager.processUpTo(SIM_TIME_S, MAX_EVENTS);
  return trace;
}

function newRunner(): DESRunner {
  return new DESRunner({ subMode: 'fastforward', durationSeconds: SIM_TIME_S, masterSeed: 7 });
}

/** Ids restart per run like a fresh load; the DES MU counter is module-global. */
function fresh(trace: string[]): string[] {
  const ids = new Map<string, number>();
  return trace.map((t) => t.replace(/:(\d+)>/, (_m, id: string) => {
    if (!ids.has(id)) ids.set(id, ids.size);
    return `:${ids.get(id)}>`;
  }));
}

let infoSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  resetWorld();
  infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
});
afterEach(() => { infoSpy.mockRestore(); });

describe('plan-612 CP1d-b — DESRunner.rebindScene()', () => {
  it('normal path: a rebind of the unchanged scene equals the fresh bind (count, topology, trace) with new instances', () => {
    const l = line();
    const runner = newRunner();
    runner.start([...DEFS], { root: l.scene, host: l.host });
    const count0 = runner.liveInstances.length;
    const topo0 = topology(runner);
    const before = [...runner.liveInstances];
    const trace0 = fresh(run(runner));
    expect(count0, 'instances of the fresh bind').toBe(4);
    expect(topo0).toContain('Conveyor_1<Conveyor> next=[Conveyor_2] prev=[Source_1]');
    expect(trace0.length, 'the line delivers in the short run').toBeGreaterThan(10);
    expect(trace0.some((t) => t.endsWith('>Sink_1')), 'MUs reach the sink').toBe(true);

    runner.rebindScene();
    expect(runner.liveInstances.length, 'count after rebind').toBe(count0);
    expect(topology(runner), 'topology after rebind').toBe(topo0);
    for (const inst of runner.liveInstances) expect(before, `${inst.self.root.name} is rebound`).not.toContain(inst);
    expect(runner.getManager().currentTime, 'clock restarted').toBe(0);
    expect(runner.getManager().componentCount, 'one manager registration per instance').toBe(count0);
    expect(fresh(run(runner)), 'trace after rebind').toEqual(trace0);
    runner.dispose();
  });

  it('reset button unchanged: same instances, same count, same trace; a late scope stamp is NOT picked up', () => {
    const l = line(false);
    const runner = newRunner();
    runner.start([...DEFS], { root: l.scene, host: l.host });
    const before = [...runner.liveInstances];
    const trace0 = fresh(run(runner));
    expect(trace0.length, 'the line delivers in the short run').toBeGreaterThan(10);

    runner.reset();
    expect(runner.liveInstances.length, 'count after reset').toBe(before.length);
    runner.liveInstances.forEach((inst, k) => expect(inst, `instance ${k} kept`).toBe(before[k]));
    expect(fresh(run(runner)), 'trace after reset').toEqual(trace0);

    // A scope stamp arriving later (placement materialised) — reset() keeps the old bind.
    stamp(l.conveyor2);
    runner.reset();
    expect(runner.liveInstances.length).toBe(before.length);
    const names = [...l.store.getAll().keys()];
    expect(names, 'reset does not re-scope').not.toContain('Conveyor_2.Flow.Run');
    expect(names, 'the unscoped name stays after reset').toContain('Flow.Run');
    runner.dispose();
  });

  it('late scope stamp: rebindScene re-scopes the instance and releases the unscoped names it wrote', () => {
    const l = line(false);
    const runner = newRunner();
    runner.start([...DEFS], { root: l.scene, host: l.host });
    const unscoped0 = [...l.store.getAll().keys()].filter((n) => n.startsWith('Flow.'));
    expect(unscoped0, 'the unstamped conveyor writes unscoped Flow.*').toContain('Flow.Run');
    const trace0 = fresh(run(runner));

    stamp(l.conveyor2);
    runner.rebindScene();
    const names = [...l.store.getAll().keys()];
    expect(names, 'scoped after the rebind').toContain('Conveyor_2.Flow.Run');
    expect(names.filter((n) => n.startsWith('Flow.')), 'no unscoped Flow.* left').toEqual([]);
    expect(runner.liveInstances.length).toBe(4);
    expect(topology(runner)).toContain('Conveyor_2<Conveyor> next=[Sink_1] prev=[Conveyor_1]');
    expect(fresh(run(runner)), 'the line runs the same after the re-scope').toEqual(trace0);
    runner.dispose();
  });

  it('a forced or path-owned unscoped name is kept by the release', () => {
    const l = line(false);
    const runner = newRunner();
    runner.start([...DEFS], { root: l.scene, host: l.host });
    l.store.forceSignal('Flow.Run', true);
    l.store.register('Flow.Occupied', 'Somewhere/Flow.Occupied', false);
    stamp(l.conveyor2);
    runner.rebindScene();
    const names = [...l.store.getAll().keys()];
    expect(names, 'forced name kept').toContain('Flow.Run');
    expect(l.store.isForced('Flow.Run')).toBe(true);
    expect(names, 'path-owned name kept').toContain('Flow.Occupied');
    expect(names, 'scoped after the rebind').toContain('Conveyor_2.Flow.Run');
    runner.dispose();
  });

  it('programmatic instances stay: without scene discovery rebindScene is reset()', () => {
    const l = line();
    const runner = newRunner();
    runner.start([...DEFS], { root: l.scene, host: l.host });
    const sceneCount = runner.liveInstances.length;
    // A programmatic instance added after the start (no scene marker).
    const extra = runner.liveInstances[0];
    runner.addInstance(extra.def, extra.self, extra.self.root);
    expect(runner.liveInstances.length).toBe(sceneCount + 1);
    runner.rebindScene();
    expect(runner.liveInstances.length, 'scene rebound, programmatic kept').toBe(sceneCount + 1);
    expect(runner.liveInstances.filter((i) => !i.scene), 'exactly the programmatic one').toHaveLength(1);
    runner.dispose();

    // A runner that never discovered (programmatic only, no host): rebind = reset.
    resetWorld();
    const l2 = line();
    const seed = newRunner();
    seed.start([...DEFS], { root: l2.scene, host: l2.host });
    const prog = newRunner();
    for (const inst of seed.liveInstances) prog.addInstance(inst.def, inst.self, inst.self.root);
    prog.start([...DEFS], { root: l2.scene });
    const progBefore = [...prog.liveInstances];
    prog.rebindScene();
    prog.liveInstances.forEach((inst, k) => expect(inst, `programmatic ${k} kept`).toBe(progBefore[k]));
    prog.dispose();
    seed.dispose();
  });
});

describe('plan-612 CP1d-b — SimulationKernel.rebindScene()', () => {
  function fakeExecutor(mode: 'continuous' | 'des', withRebind: boolean): SimulationExecutor & { calls: string[] } {
    const calls: string[] = [];
    const exec: SimulationExecutor & { calls: string[] } = {
      mode, muCount: 0, calls,
      start: () => { calls.push('start'); },
      tick: () => {},
      clearMUs: () => { calls.push('clearMUs'); },
      reset: () => { calls.push('reset'); },
      dispose: () => {},
    };
    if (withRebind) exec.rebindScene = () => { calls.push('rebindScene'); };
    return exec;
  }

  it('delegates to the active executor\'s rebindScene, else falls back to reset()', () => {
    const cont = fakeExecutor('continuous', false);
    const des = fakeExecutor('des', true);
    const kernel = new SimulationKernel({
      continuousRunner: cont as unknown as ContinuousRunner,
      topology: { root: new Scene() },
      desRunnerFactory: () => des,
    });
    kernel.rebindScene();
    expect(cont.calls, 'continuous has no rebindScene → reset').toEqual(['reset']);
    kernel.setMode('des');
    kernel.rebindScene();
    expect(des.calls, 'DES rebinds, reset untouched').toEqual(['start', 'rebindScene']);
    kernel.reset();
    expect(des.calls.at(-1), 'the reset button stays reset()').toBe('reset');
  });
});
