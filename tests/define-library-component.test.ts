// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Object3D } from 'three';
import { EventEmitter } from '../src/core/rv-events';
import { ContextMenuStore } from '../src/core/hmi/context-menu-store';
import {
  createBindContext,
  iterateFixedUpdate,
  applyKinematicsSpec,
  type BindContextHost,
  type KinematicsSpec,
} from '../src/core/behavior-runtime';
import {
  getCapabilities,
  _resetCapabilitiesForTesting,
} from '../src/core/engine/rv-component-registry';
import { _resetMaterialFlowRegistry } from '../src/core/material-flow/registry';
import {
  defineLibraryComponent,
  _resetLibraryComponentMarkers,
} from '../src/behaviors/_shared/define-library-component';
import type { MaterialFlowSelf } from '../src/core/material-flow/material-flow-self';
import type { MaterialFlowDefinition } from '../src/core/material-flow/define-material-flow';
import { StatisticsManager } from '../src/core/material-flow/rv-statistics-manager';

const DT = 1 / 60;

beforeEach(() => {
  _resetMaterialFlowRegistry();
  _resetCapabilitiesForTesting();
  _resetLibraryComponentMarkers();
});

// ─── Mock host (mirrors tests/conveyor-behavior.test.ts) ─────────────────────

function makeHost(root: Object3D): { host: BindContextHost; values: Map<string, boolean | number>; events: EventEmitter<Record<string, unknown>> } {
  const subs = new Map<string, Set<(v: boolean | number) => void>>();
  const values = new Map<string, boolean | number>();
  const events = new EventEmitter<Record<string, unknown>>();
  const host: BindContextHost = {
    signalStore: {
      get: (n: string) => values.get(n),
      set: (n: string, v: boolean | number) => { values.set(n, v); subs.get(n)?.forEach((cb) => cb(v)); },
      subscribe: (n: string, cb: (v: boolean | number) => void) => {
        let s = subs.get(n); if (!s) { s = new Set(); subs.set(n, s); }
        s.add(cb); return () => { s!.delete(cb); };
      },
    },
    on: (e, cb) => events.on(e, cb as never),
    contextMenu: new ContextMenuStore(),
    drives: [],
    registry: null,
  };
  return { host, values, events };
}

interface FooLocal { ticks: number; setupRan: boolean; }

function makeDef(over: Partial<MaterialFlowDefinition<MaterialFlowSelf<FooLocal>>> = {}):
  MaterialFlowDefinition<MaterialFlowSelf<FooLocal>> {
  return {
    type: 'Foo',
    kind: 'station',
    models: ['*Foo*'],
    schema: { Period: { type: 'number', default: 2 }, MaxSpeed: { type: 'number', default: 1000 } },
    state: (): FooLocal => ({ ticks: 0, setupRan: false }),
    continuous: {
      setup(self) { self.local.setupRan = true; },
      fixedUpdate(self) { self.local.ticks += 1; },
    },
    ...over,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('defineLibraryComponent — badge registration', () => {
  it('registers the default STANDARD_BADGE capability under <Type>Behavior', () => {
    defineLibraryComponent<FooLocal>(makeDef());
    const caps = getCapabilities('FooBehavior');
    expect(caps.hierarchyVisible).toBe(true);
    // plan-200 C1: the stamped marker section is hidden in the inspector; the
    // hierarchy badge and the 'Behavior' filterLabel gate remain.
    expect(caps.inspectorVisible).toBe(false);
    expect(caps.badgeColor).toBe('#7e57c2');
    expect(caps.filterLabel).toBe('Behavior');
  });

  it('honours an explicit opts.capabilities override', () => {
    defineLibraryComponent<FooLocal>(makeDef(), {
      capabilities: { badgeColor: '#112233', filterLabel: 'Custom', hierarchyVisible: true, inspectorVisible: true },
    });
    expect(getCapabilities('FooBehavior').badgeColor).toBe('#112233');
  });

  it('registers the badge exactly once per type — no double-warn on re-define', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    defineLibraryComponent<FooLocal>(makeDef());
    defineLibraryComponent<FooLocal>(makeDef()); // HMR / second eval — guarded
    const capWarns = warn.mock.calls.filter(([m]) => typeof m === 'string' && m.includes("Capabilities for 'FooBehavior'"));
    expect(capWarns.length).toBe(0);
    warn.mockRestore();
  });
});

describe('defineLibraryComponent — bind fixedUpdate gating', () => {
  it('non-inert with continuous.fixedUpdate registers onFixedUpdate (drives ticks)', () => {
    let captured: MaterialFlowSelf<FooLocal> | null = null;
    const behavior = defineLibraryComponent<FooLocal>(makeDef({
      continuous: {
        setup(self) { captured = self; },
        fixedUpdate(self) { self.local.ticks += 1; },
      },
    }));
    const root = new Object3D(); root.name = 'Foo';
    const { host } = makeHost(root);
    const { ctx, handle } = createBindContext(root, host, {} as KinematicsSpec);
    behavior.bind(ctx);
    iterateFixedUpdate(handle, DT);
    iterateFixedUpdate(handle, DT);
    iterateFixedUpdate(handle, DT);
    expect(captured).not.toBeNull();
    expect(captured!.local.ticks).toBe(3);
  });

  it('inert:true → bind does NOT call rv.onFixedUpdate (counting mock rv)', () => {
    const behavior = defineLibraryComponent<FooLocal>(makeDef(), { inert: true });
    const root = new Object3D(); root.name = 'Foo';
    const mockRv = makeCountingRv(root);
    behavior.bind(mockRv.rv);
    expect(mockRv.counts.onFixedUpdate).toBe(0);
    expect(mockRv.counts.behavior).toBe(1); // marker still stamped
  });

  it('non-inert → bind DOES call rv.onFixedUpdate exactly once (counting mock rv)', () => {
    const behavior = defineLibraryComponent<FooLocal>(makeDef());
    const root = new Object3D(); root.name = 'Foo';
    const mockRv = makeCountingRv(root);
    behavior.bind(mockRv.rv);
    expect(mockRv.counts.onFixedUpdate).toBe(1);
  });
});

describe('defineLibraryComponent — marker + schema-default stamp', () => {
  it('stamps schema defaults + badge payload into userData.realvirtual[<Type>Behavior]', () => {
    const behavior = defineLibraryComponent<FooLocal>(makeDef(), {
      badge: () => ({ Marker: 'hello' }),
    });
    const root = new Object3D(); root.name = 'Foo';
    const { host } = makeHost(root);
    const accum: KinematicsSpec = {};
    const { ctx } = createBindContext(root, host, accum);
    behavior.bind(ctx);
    applyKinematicsSpec(root, accum);
    const stamped = (root.userData.realvirtual as Record<string, unknown>).FooBehavior as Record<string, unknown>;
    expect(stamped).toMatchObject({ Period: 2, MaxSpeed: 1000, Marker: 'hello' });
  });
});

describe('defineLibraryComponent — self.disable() gating', () => {
  it('self.disable() in setup → no continuous.setup, no fixedUpdate, marker not stamped', () => {
    let continuousSetupRan = false;
    const behavior = defineLibraryComponent<FooLocal>(makeDef({
      setup(self) { self.disable('missing node'); },
      continuous: {
        setup() { continuousSetupRan = true; },
        fixedUpdate(self) { self.local.ticks += 1; },
      },
    }));
    const root = new Object3D(); root.name = 'Foo';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const mockRv = makeCountingRv(root);
    behavior.bind(mockRv.rv);
    expect(continuousSetupRan).toBe(false);
    expect(mockRv.counts.onFixedUpdate).toBe(0);
    expect(mockRv.counts.behavior).toBe(0); // skipped before the stamp
    warn.mockRestore();
  });
});

describe('defineLibraryComponent — statistics registration (Plan 201)', () => {
  it('registers stats with the manager and books state time via self.statState', () => {
    const mgr = new StatisticsManager();
    let simTime = 0;
    const root = new Object3D(); root.name = 'Foo';
    const { host } = makeHost(root);
    (host as unknown as { statisticsManager: StatisticsManager }).statisticsManager = mgr;
    Object.defineProperty(host, 'simTime', { get: () => simTime, configurable: true });

    const behavior = defineLibraryComponent<FooLocal>(makeDef({
      continuous: {
        setup(self) { self.statState('Working'); },
        fixedUpdate(self) { self.local.ticks += 1; },
      },
    }));
    const { ctx, handle } = createBindContext(root, host, {} as KinematicsSpec);
    behavior.bind(ctx);

    expect(mgr.size).toBe(1);
    simTime = 10;
    iterateFixedUpdate(handle, DT);

    const agg = mgr.getAggregate();
    expect(agg.components).toHaveLength(1);
    expect(agg.components[0].state).toBe('Working');
    expect(mgr.get('Foo')!.getStatePercentage('Working')).toBeGreaterThan(99);
    expect(agg.bottleneck?.path).toBe('Foo');
  });

  it('does NOT register a disabled component (no dead registry entry)', () => {
    const mgr = new StatisticsManager();
    const root = new Object3D(); root.name = 'Foo';
    const { host } = makeHost(root);
    (host as unknown as { statisticsManager: StatisticsManager }).statisticsManager = mgr;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const behavior = defineLibraryComponent<FooLocal>(makeDef({
      setup(self) { self.disable('missing node'); },
    }));
    const { ctx } = createBindContext(root, host, {} as KinematicsSpec);
    behavior.bind(ctx);

    expect(mgr.size).toBe(0);
    warn.mockRestore();
  });

  it('unregisters on dispose', () => {
    const mgr = new StatisticsManager();
    const root = new Object3D(); root.name = 'Foo';
    const { host } = makeHost(root);
    (host as unknown as { statisticsManager: StatisticsManager }).statisticsManager = mgr;

    const behavior = defineLibraryComponent<FooLocal>(makeDef());
    const { ctx, handle } = createBindContext(root, host, {} as KinematicsSpec);
    behavior.bind(ctx);
    expect(mgr.size).toBe(1);
    handle.dispose();
    expect(mgr.size).toBe(0);
  });
});

describe('defineLibraryComponent — reset lifecycle wiring', () => {
  it('invokes def.reset / def.start / def.resetStat on the matching viewer events', () => {
    const calls: string[] = [];
    const behavior = defineLibraryComponent<FooLocal>(makeDef({
      reset(self) { calls.push('reset'); self.local.ticks = 0; },
      start() { calls.push('start'); },
      resetStat() { calls.push('resetStat'); },
    }));
    const root = new Object3D(); root.name = 'Foo';
    const { host, events } = makeHost(root);
    const { ctx, handle } = createBindContext(root, host, {} as KinematicsSpec);
    behavior.bind(ctx);

    // Drive the instance, then reset — the reset block restores local state.
    iterateFixedUpdate(handle, DT);

    events.emit('simulation-reset', undefined);
    events.emit('simulation-resetstat', undefined);
    events.emit('simulation-start', undefined);
    expect(calls).toEqual(['reset', 'resetStat', 'start']);

    // After dispose the handlers are unsubscribed (no duplicate firing).
    handle.dispose();
    events.emit('simulation-reset', undefined);
    expect(calls.filter((c) => c === 'reset')).toHaveLength(1);
  });

  it('a disabled instance does NOT wire reset/start handlers', () => {
    const calls: string[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const behavior = defineLibraryComponent<FooLocal>(makeDef({
      setup(self) { self.disable('missing node'); },
      reset() { calls.push('reset'); },
      start() { calls.push('start'); },
    }));
    const root = new Object3D(); root.name = 'Foo';
    const { host, events } = makeHost(root);
    const { ctx } = createBindContext(root, host, {} as KinematicsSpec);
    behavior.bind(ctx);
    events.emit('simulation-reset', undefined);
    events.emit('simulation-start', undefined);
    expect(calls).toEqual([]); // disabled before reset/start wiring
    warn.mockRestore();
  });
});

// ─── Counting mock RVBindContext ────────────────────────────────────────────
// A minimal hand-rolled rv that counts onFixedUpdate/behavior calls. createSelf
// only touches root/viewer/signals/drives/contextMenu/signal/behavior, so this
// covers the factory's bind path without a full viewer.

function makeCountingRv(root: Object3D) {
  const counts = { onFixedUpdate: 0, behavior: 0, onDispose: 0 };
  const values = new Map<string, boolean | number>();
  const rv = {
    root,
    viewer: {} as never,
    signals: {
      get: <T,>(n: string) => values.get(n) as T,
      set: (n: string, v: boolean | number) => { values.set(n, v); },
      on: () => {},
    },
    drives: { get: () => null },
    signal() { return rv; },
    behavior() { counts.behavior += 1; return rv; },
    onFixedUpdate() { counts.onFixedUpdate += 1; },
    onDispose() { counts.onDispose += 1; },
    contextMenu() { return rv; },
  } as unknown as Parameters<ReturnType<typeof defineLibraryComponent>['bind']>[0];
  return { rv, counts };
}
