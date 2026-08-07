// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { beforeEach, describe, expect, it } from 'vitest';
import { Object3D, Vector3 } from 'three';
import { DESRunner } from '@rv-private/plugins/des/des-runner';
import { MaterialFlowAdapter } from '@rv-private/plugins/des/material-flow-adapter';
import { IndexingConveyor } from '@rv-private/plugins/des/material-flow/IndexingConveyor';
import { _resetDesHookCache } from '@rv-private/plugins/des/des-hook-adapter';
import { resetDESMUCounter, type DESMU } from '@rv-private/plugins/des/rv-des-mu';
import {
  createSelf,
  type MaterialFlowSelf,
  type MU,
  type MuRef,
  type Port,
} from '../../src/core/material-flow/material-flow-self';
import {
  defineMaterialFlow,
  type MaterialFlowDefinition,
} from '../../src/core/material-flow/define-material-flow';
import {
  createBindContext,
  type BindContextHost,
  type KinematicsSpec,
  type RVBindContext,
} from '../../src/core/behavior-runtime';
import { EventEmitter } from '../../src/core/rv-events';
import { ContextMenuStore } from '../../src/core/hmi/context-menu-store';

interface Bound {
  def: MaterialFlowDefinition;
  self: MaterialFlowSelf;
  adapter: MaterialFlowAdapter;
  node: Object3D;
}

interface Line {
  runner: DESRunner;
  conveyor: Bound;
  sink: Bound;
}

interface VisualTarget {
  position: Vector3;
  node: Object3D;
  isInstanced: false;
  setPosition(value: Vector3): void;
}

const Sink = defineMaterialFlow<MaterialFlowSelf>({
  type: 'IndexingTestSink',
  kind: 'sink',
  schema: {},
  continuous: {},
  des: { onAccept: () => true },
});

function testHost(): BindContextHost {
  const values = new Map<string, boolean | number>();
  const events = new EventEmitter<Record<string, unknown>>();
  return {
    signalStore: {
      get: (name: string) => values.get(name),
      set: (name: string, value: boolean | number) => values.set(name, value),
      subscribe: () => () => {},
    } as never,
    on: (event, callback) => events.on(event, callback as never),
    contextMenu: new ContextMenuStore(),
    drives: [] as never,
    registry: null,
    getPlugin: () => undefined,
  };
}

function bindContext(root: Object3D): RVBindContext {
  const accum: KinematicsSpec = {};
  return createBindContext(root, testHost(), accum).ctx;
}

function bind(
  runner: DESRunner,
  def: MaterialFlowDefinition,
  name: string,
  config: Record<string, number> = {},
): Bound {
  const node = new Object3D();
  node.name = name;
  let adapter!: MaterialFlowAdapter;
  const self = createSelf(bindContext(node), def, {
    mode: 'des',
    scheduler: runner.makeScheduler(def, () => adapter.entityId),
    mus: () => adapter?.heldMUs as unknown as ReadonlyArray<MU> ?? [],
    reservedLoad: () => adapter?.reservedLoad ?? 0,
    downstreamFreeCapacity: (port) => adapter.downstreamFreeCapacity(port),
    reserveDownstream: (n, port, carrier) => adapter.reserveDownstream(n, port, carrier),
    reservation: (id) => adapter.reservation(id),
    canAcceptDownstream: (mu, port) => downstreamCanAccept(adapter, mu, port),
    onTransfer: (mu) => runner.makeTransfer(adapter)(mu),
    spawnMU: () => runner.createMU(),
    onStatState: (state) => adapter.setState(state),
    local: (() => {
      const make = def.state ?? def.local;
      return make ? make() : undefined;
    })(),
  });
  Object.assign(self.prop, config);
  adapter = runner.addInstance(def, self, node);
  return { def, self, adapter, node };
}

function downstreamCanAccept(adapter: MaterialFlowAdapter, mu: MU, port?: Port): boolean {
  if (port) {
    const exact = adapter.nextComponents.find((candidate) => candidate.node === port.ownerRoot);
    if (exact) return exact.canAccept(mu as DESMU);
  }
  return adapter.nextComponents.some((candidate) => candidate.canAccept(mu as DESMU));
}

function line(
  config: Partial<Record<'slotCount' | 'pitch' | 'speed' | 'dwellTime' | 'reportFreeAt', number>> = {},
  carrierPositions: number[] = [],
): Line {
  const runner = new DESRunner({ subMode: 'animated' });
  const conveyor = bind(runner, IndexingConveyor as unknown as MaterialFlowDefinition, 'Indexing', {
    slotCount: 3,
    pitch: 1000,
    speed: 1000,
    dwellTime: 0,
    reportFreeAt: 1,
    ...config,
  });
  for (let i = 0; i < carrierPositions.length; i++) {
    const carrier = new Object3D();
    carrier.name = i === 0 ? 'Carrier' : `Carrier-${i}`;
    carrier.position.x = carrierPositions[i];
    conveyor.node.add(carrier);
  }
  const sink = bind(runner, Sink, 'Sink');
  conveyor.adapter.nextComponents = [sink.adapter];
  sink.adapter.previousComponents = [conveyor.adapter];
  const root = new Object3D();
  root.add(conveyor.node, sink.node);
  runner.start([IndexingConveyor as unknown as MaterialFlowDefinition, Sink], { root });
  return { runner, conveyor, sink };
}

function visual(): VisualTarget {
  const node = new Object3D();
  return {
    position: node.position,
    node,
    isInstanced: false,
    setPosition(value): void { this.node.position.copy(value); },
  };
}

function accept(lineState: Line): { mu: DESMU; visual: VisualTarget } {
  const mu = lineState.runner.createMU();
  const target = visual();
  mu.visual = target as never;
  expect(lineState.conveyor.adapter.acceptMU(mu)).toBe(true);
  return { mu, visual: target };
}

function slotIds(self: MaterialFlowSelf): Array<number | null> {
  return (self.prop.slots as unknown as Array<MuRef | null>).map((slot) => slot?.id ?? null);
}

describe('IndexingConveyor', () => {
  beforeEach(() => {
    _resetDesHookCache();
    resetDESMUCounter();
  });

  it('indexes all slots synchronously; never accumulates', () => {
    const state = line({}, [-1, 0, 1]);
    const { mu, visual: target } = accept(state);
    expect(slotIds(state.conveyor.self)).toEqual([mu.id, null, null]);
    expect(target.position.x).toBeCloseTo(-1);

    state.runner.tick(0.5);
    expect(slotIds(state.conveyor.self)).toEqual([mu.id, null, null]);
    state.runner.tick(0.5);
    expect(slotIds(state.conveyor.self)).toEqual([null, mu.id, null]);
    state.runner.getTweenRegistry().settle(state.runner.getManager().currentTime);
    expect(target.position.x).toBeCloseTo(0);
  });

  it('reports free only when >= reportFreeAt slots empty (FreeSlots signal)', () => {
    const state = line({ reportFreeAt: 2, dwellTime: 2 });
    accept(state);
    expect(state.conveyor.self.sig.FreeSlots.get()).toBe(2);
    expect(state.conveyor.self.prop.isFree).toBe(true);

    state.runner.tick(1);
    expect(state.conveyor.self.state).toBe('Dwell');
    accept(state);
    expect(state.conveyor.self.sig.FreeSlots.get()).toBe(1);
    expect(state.conveyor.self.prop.isFree).toBe(false);
  });

  it('invalid config (speed <= 0, slotCount <= 0, reportFreeAt > slotCount) fails bind validation', () => {
    expect(() => line({ speed: 0 })).toThrow(/speed must be greater than zero/);
    _resetDesHookCache();
    expect(() => line({ slotCount: 0 })).toThrow(/slotCount must be a positive integer/);
    _resetDesHookCache();
    expect(() => line({ slotCount: 2, reportFreeAt: 3 })).toThrow(/must not exceed slotCount/);
  });

  it('index time equals pitch / speed', () => {
    const state = line({ pitch: 500, speed: 250 });
    const { mu, visual: target } = accept(state);
    expect(target.position.x).toBeCloseTo(-0.5);
    state.runner.tick(1.99);
    expect(slotIds(state.conveyor.self)).toEqual([mu.id, null, null]);
    state.runner.tick(0.01);
    expect(slotIds(state.conveyor.self)).toEqual([null, mu.id, null]);
    state.runner.getTweenRegistry().settle(state.runner.getManager().currentTime);
    expect(target.position.x).toBeCloseTo(0);
  });

  it('dwellTime > 0: index -> dwell/processing -> release with processing KPI; 0: free-running indexing', () => {
    const working = line({ slotCount: 1, dwellTime: 2 });
    accept(working);
    working.runner.tick(1);
    expect(working.conveyor.self.state).toBe('Dwell');
    expect(working.conveyor.adapter.currentLoad).toBe(1);
    expect(working.conveyor.adapter.getStatistics().states.Working).toBeDefined();
    working.runner.tick(1.99);
    expect(working.conveyor.adapter.currentLoad).toBe(1);
    working.runner.tick(0.01);
    expect(working.conveyor.adapter.currentLoad).toBe(0);
    expect(working.conveyor.self.prop.completedCycles).toBe(1);

    _resetDesHookCache();
    const freeRunning = line({ slotCount: 1, dwellTime: 0 });
    accept(freeRunning);
    freeRunning.runner.tick(1);
    expect(freeRunning.conveyor.adapter.currentLoad).toBe(0);
    expect(freeRunning.conveyor.self.prop.completedCycles).toBe(1);
  });

  it('failure pauses cycle AND tweens immediately; snapshot during failure; resume with remaining time', () => {
    const state = line({ dwellTime: 1 });
    const first = accept(state);
    state.runner.tick(1);
    const second = accept(state);
    state.runner.tick(1);
    state.runner.getTweenRegistry().settle(state.runner.getManager().currentTime);
    expect(state.runner.getTweenRegistry().activeCount).toBe(2);
    const beforeFailure = slotIds(state.conveyor.self);

    state.runner.tick(0.4);
    state.conveyor.adapter.setFailure(true);
    expect(state.runner.getTweenRegistry().activeCount).toBe(0);
    const snapshot = JSON.parse(state.runner.snapshotJson());
    const frozen = snapshot.components.Indexing.frozen as Array<{ remaining: number; tweens: unknown[] }>;
    expect(frozen).toHaveLength(1);
    expect(frozen[0].remaining).toBeCloseTo(0.6);
    expect(frozen[0].tweens).toHaveLength(2);
    state.runner.tick(5);
    expect(slotIds(state.conveyor.self)).toEqual(beforeFailure);

    state.runner.restoreFull(snapshot);
    expect(slotIds(state.conveyor.self)).toEqual(beforeFailure);
    state.conveyor.adapter.setFailure(false);
    expect(state.runner.getTweenRegistry().activeCount).toBe(2);
    state.runner.tick(0.59);
    expect(slotIds(state.conveyor.self)).toEqual(beforeFailure);
    state.runner.tick(0.02);
    expect(slotIds(state.conveyor.self)).toEqual([null, second.mu.id, first.mu.id]);
  });

  it('snapshot mid-index and mid-dwell restores prop.slots exactly', () => {
    const indexing = line();
    const indexedMU = accept(indexing).mu;
    indexing.runner.tick(0.4);
    const midIndex = JSON.parse(indexing.runner.snapshotJson());
    const midIndexSlots = structuredClone(indexing.conveyor.self.prop.slots);
    indexing.runner.tick(1);
    indexing.runner.restoreFull(midIndex);
    expect(indexing.conveyor.self.prop.slots).toEqual(midIndexSlots);
    indexing.runner.tick(0.59);
    expect(slotIds(indexing.conveyor.self)).toEqual([indexedMU.id, null, null]);
    indexing.runner.tick(0.02);
    expect(slotIds(indexing.conveyor.self)).toEqual([null, indexedMU.id, null]);

    _resetDesHookCache();
    const dwelling = line({ slotCount: 1, dwellTime: 2 });
    accept(dwelling);
    dwelling.runner.tick(1.5);
    expect(dwelling.conveyor.self.state).toBe('Dwell');
    const midDwell = JSON.parse(dwelling.runner.snapshotJson());
    const midDwellSlots = structuredClone(dwelling.conveyor.self.prop.slots);
    dwelling.runner.tick(2);
    dwelling.runner.restoreFull(midDwell);
    expect(dwelling.conveyor.self.prop.slots).toEqual(midDwellSlots);
    expect(dwelling.conveyor.adapter.currentLoad).toBe(1);
    dwelling.runner.tick(1.49);
    expect(dwelling.conveyor.adapter.currentLoad).toBe(1);
    dwelling.runner.tick(0.02);
    expect(dwelling.conveyor.adapter.currentLoad).toBe(0);
  });
});
