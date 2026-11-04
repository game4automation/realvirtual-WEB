// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-652 Phase 3 — DES on demand: the type collector, the component triggers, the
 * synchronous safety net (§2.4.3 #3) and the runtime's `discrete` switch (§9.6b).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Group, Object3D } from 'three';
import {
  addPatchTypes, collectComponentTypes, noteDeferredComponentType, noteDeferredComponentTypes,
  setDeferredComponentHandler, clearDeferredComponentHandler,
} from '../src/core/engine/rv-component-types';
import { FeatureLoader, type FeatureDefinition } from '../src/core/rv-feature-loader';
import { SimulationRuntime, type RuntimeHost } from '../src/core/engine/rv-simulation-runtime';
import { getProblems, clearAllProblems } from '../src/core/hmi/problems-store';
import type { RVViewer } from '../src/core/rv-viewer';

const fakeViewer = (): RVViewer => ({}) as unknown as RVViewer;

function node(name: string, rv?: Record<string, unknown>): Object3D {
  const n = new Group();
  n.name = name;
  if (rv) n.userData.realvirtual = rv;
  return n;
}

function desDef(activate = vi.fn(), over: Partial<FeatureDefinition> = {}): FeatureDefinition {
  return {
    id: 'des', label: 'DES simulation', origin: 'internal',
    activation: ['mode:des', 'command:sim.discrete', 'component:DESSource', 'component:Station'],
    load: async () => ({ activate }),
    ...over,
  };
}

beforeEach(() => {
  clearAllProblems();
  for (const level of ['info', 'debug', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); setDeferredComponentHandler(null); });

describe('collectComponentTypes', () => {
  it('collects the extras keys of every node, numbered duplicates folded', () => {
    const root = node('Root', { Drive: {} });
    const a = node('A', { DESSource: {}, Drive_1: {} });
    root.add(a);
    a.add(node('B'));
    expect([...collectComponentTypes(root)].sort()).toEqual(['DESSource', 'Drive']);
  });

  it('adds the types an overlay introduces (applied only later in the traversal)', () => {
    const root = node('Root');
    const types = collectComponentTypes(root, {
      $schema: 'rv-extras-overlay/1.0', $source: 'test',
      nodes: { 'Root/Cell': { Station: { ProcessingTime: 3 } } },
    });
    expect([...types]).toEqual(['Station']);
  });

  it('with a wanted set collects only those types and stops once all are found', () => {
    const root = node('Root', { Drive: {}, Group_12: {} });
    const a = node('A', { DESSource_3: {} });
    root.add(a);
    a.add(node('B', { DESSink: {} }));
    expect([...collectComponentTypes(root, null, new Set(['DESSource']))]).toEqual(['DESSource']);
    expect([...collectComponentTypes(root, null, new Set(['DESSink', 'Station']))]).toEqual(['DESSink']);
    expect([...collectComponentTypes(root, null, new Set())]).toEqual([]);
    expect([...collectComponentTypes(root)].sort()).toEqual(['DESSink', 'DESSource', 'Drive', 'Group']);
    const overlay = { $schema: 'rv-extras-overlay/1.0', $source: 'test', nodes: { 'Root/X': { Station: {}, Drive: {} } } } as never;
    expect([...collectComponentTypes(node('R'), overlay, new Set(['Station']))]).toEqual(['Station']);
  });

  it('adds placement override types (byNodeId / byPath patches)', () => {
    const types = addPatchTypes(new Set(['Drive']), { n1: { DESSink: {} }, n2: { Drive_2: {} } });
    expect([...types].sort()).toEqual(['DESSink', 'Drive']);
    expect([...addPatchTypes(new Set(), undefined)]).toEqual([]);
  });
});

describe('FeatureLoader component triggers', () => {
  it('a model without DES types activates nothing', async () => {
    const load = vi.fn(async () => ({ activate: vi.fn() }));
    const fl = new FeatureLoader(fakeViewer());
    fl.define(desDef(undefined, { load }));
    await fl.ensureForComponentTypes(['Drive', 'Sensor']);
    expect(load).not.toHaveBeenCalled();
    expect(fl.isActive('des')).toBe(false);
  });

  it('a DES type activates DES once', async () => {
    const activate = vi.fn();
    const fl = new FeatureLoader(fakeViewer());
    fl.define(desDef(activate));
    expect(fl.pendingFeatureForComponentType('DESSource')).toBe('des');
    expect(fl.hasPendingComponentFeatures()).toBe(true);
    await fl.ensureForComponentTypes(['Drive', 'DESSource', 'Station']);
    await fl.ensureForComponentTypes(['DESSource']);
    expect(activate).toHaveBeenCalledTimes(1);
    expect(fl.pendingFeatureForComponentType('DESSource')).toBeNull();
    expect(fl.hasPendingComponentFeatures()).toBe(false);
  });
});

describe('safety net of the synchronous build entries', () => {
  it('without a handler nothing happens (embedder, tests)', () => {
    expect(noteDeferredComponentType('DESSource', 'test')).toBe(false);
  });

  it('a retry builds the component after the activation, no Problems entry', async () => {
    const fl = new FeatureLoader(fakeViewer());
    fl.define(desDef());
    const handler = fl.deferredComponentHandler();
    setDeferredComponentHandler(handler);
    const retry = vi.fn();
    expect(noteDeferredComponentType('Drive', 'constructComponentOnNode', retry)).toBe(false);
    expect(noteDeferredComponentType('DESSource', 'constructComponentOnNode', retry)).toBe(true);
    await vi.waitFor(() => expect(retry).toHaveBeenCalledTimes(1));
    expect(fl.isActive('des')).toBe(true);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('[feature] DESSource needs des'));
    expect(getProblems().filter((p) => p.code === 'feature-late-component')).toEqual([]);
    clearDeferredComponentHandler(handler);
    expect(noteDeferredComponentType('DESSource', 'x')).toBe(false);
  });

  it('a subtree build without retry warns, files a Problems entry and activates', async () => {
    const fl = new FeatureLoader(fakeViewer());
    fl.define(desDef());
    setDeferredComponentHandler(fl.deferredComponentHandler());
    const root = node('Placed', { Station: {} });
    noteDeferredComponentTypes(root, 'processExtras');
    const problems = getProblems().filter((p) => p.code === 'feature-late-component');
    expect(problems).toHaveLength(1);
    expect(problems[0].id).toBe('feature-late-component:Station');
    await vi.waitFor(() => expect(fl.isActive('des')).toBe(true));
    // Active now: the scan is skipped entirely.
    clearAllProblems();
    noteDeferredComponentTypes(root, 'processExtras');
    expect(getProblems()).toEqual([]);
  });

  it('clearDeferredComponentHandler leaves a newer viewer\'s handler alone', () => {
    const a = new FeatureLoader(fakeViewer()).deferredComponentHandler();
    const fl = new FeatureLoader(fakeViewer());
    fl.define(desDef());
    const b = fl.deferredComponentHandler();
    setDeferredComponentHandler(a);
    setDeferredComponentHandler(b);
    clearDeferredComponentHandler(a);
    expect(noteDeferredComponentType('DESSource', 'x')).toBe(true);
  });
});

describe('SimulationRuntime discrete switch (§9.6b)', () => {
  function host(opts: { runner?: boolean; ensure?: () => Promise<void>; kernel?: boolean } = {}) {
    const state = { runner: opts.runner ?? false, mode: 'continuous' as 'continuous' | 'des', kernel: opts.kernel ?? true };
    const kernel = {
      get mode() { return state.mode; },
      hasDesRunner: () => state.runner,
      setMode: vi.fn((m: 'continuous' | 'des') => { state.mode = m; }),
      desControl: () => null,
    };
    const h: RuntimeHost = {
      getLoop: () => ({}) as never,
      getKernel: () => (state.kernel ? kernel as never : null),
      emit: () => {},
      ensureDiscrete: opts.ensure ?? (async () => { state.runner = true; }),
    };
    return { h, kernel, state };
  }

  it('setModeAsync(discrete) activates DES first and resolves after the switch', async () => {
    const { h, kernel } = host();
    const rt = new SimulationRuntime(h);
    expect(await rt.setModeAsync('discrete')).toBe(true);
    expect(kernel.setMode).toHaveBeenCalledWith('des');
    expect(rt.mode).toBe('discrete');
  });

  it('setMode(discrete) without a runner is pending; a newer continuous wins', async () => {
    let release!: () => void;
    const { h, kernel, state } = host({ ensure: () => new Promise<void>((r) => { release = () => { state.runner = true; r(); }; }) });
    const rt = new SimulationRuntime(h);
    rt.setMode('discrete');
    expect(kernel.setMode).not.toHaveBeenCalled();
    rt.setMode('continuous');
    release();
    await new Promise((r) => setTimeout(r, 0));
    expect(kernel.setMode.mock.calls.map((c) => c[0])).toEqual(['continuous']);
    expect(rt.mode).toBe('continuous');
  });

  it('a call rejected for a missing kernel does not cancel a pending switch', async () => {
    let release!: () => void;
    const { h, kernel, state } = host({ ensure: () => new Promise<void>((r) => { release = () => { state.runner = true; r(); }; }) });
    const rt = new SimulationRuntime(h);
    rt.setMode('discrete');
    state.kernel = false;
    rt.setMode('continuous');
    state.kernel = true;
    release();
    await vi.waitFor(() => expect(kernel.setMode).toHaveBeenCalledWith('des'));
  });

  it('a failed activation leaves the mode unchanged', async () => {
    const { h, kernel } = host({ ensure: async () => { throw new Error('chunk 404'); } });
    const rt = new SimulationRuntime(h);
    expect(await rt.setModeAsync('discrete')).toBe(false);
    expect(kernel.setMode).not.toHaveBeenCalled();
  });

  it('with a runner already registered the switch stays synchronous', () => {
    const ensure = vi.fn(async () => {});
    const { h, kernel } = host({ runner: true, ensure });
    new SimulationRuntime(h).setMode('discrete');
    expect(kernel.setMode).toHaveBeenCalledWith('des');
    expect(ensure).not.toHaveBeenCalled();
  });
});
