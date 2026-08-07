// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { beforeEach, describe, expect, it } from 'vitest';
import { Object3D, Vector3 } from 'three';
import { DESRunner } from '@rv-private/plugins/des/des-runner';
import { MaterialFlowAdapter } from '@rv-private/plugins/des/material-flow-adapter';
import { PathTransport } from '@rv-private/plugins/des/material-flow/PathTransport';
import { Processing } from '@rv-private/plugins/des/material-flow/Processing';
import { _resetDesHookCache } from '@rv-private/plugins/des/des-hook-adapter';
import { resetDESMUCounter, type DESMU } from '@rv-private/plugins/des/rv-des-mu';
import { RVMovingUnit } from '../../src/core/engine/rv-mu';
import { getDefaultPathNetwork } from '../../src/core/engine/rv-path-network';
import {
  createSelf,
  type MaterialFlowSelf,
  type MU,
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
  transport: Bound;
  sink: Bound;
  pathId: string;
}

let pathCounter = 0;

const Sink = defineMaterialFlow<MaterialFlowSelf>({
  type: 'PathTransportTestSink',
  kind: 'sink',
  schema: {},
  continuous: {},
  des: {
    onAccept(self): boolean {
      self.prop.consumed = (typeof self.prop.consumed === 'number' ? self.prop.consumed : 0) + 1;
      return true;
    },
  },
});

const Clock = defineMaterialFlow<MaterialFlowSelf>({
  type: 'PathTransportTestClock',
  kind: 'station',
  schema: {},
  continuous: {},
  des: { onProcessComplete() {} },
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
  config: Record<string, number | string> = {},
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
    spawnMU: (templateId) => runner.createMU(templateId),
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

function addPath(root: Object3D, lengthM: number, id: string): void {
  const path = new Object3D();
  path.name = `${id}-node`;
  path.userData.realvirtual = {
    Path: {
      type: 'Path',
      id,
      segments: [{ kind: 'line', from: [0, 0, 0], to: [0, 0, lengthM] }],
    },
  };
  root.add(path);
}

function line(
  config: Partial<Record<'speed' | 'capacity', number>> = {},
  lengthM = 10,
  runner = new DESRunner({ subMode: 'animated' }),
  extraDefinitions: MaterialFlowDefinition[] = [],
  processingTime?: number,
): Line {
  const transport = bind(runner, PathTransport as unknown as MaterialFlowDefinition, 'PathTransport', {
    speed: 1000,
    capacity: 2,
    ...config,
  });
  const pathId = `path-${lengthM}-${++pathCounter}`;
  addPath(transport.node, lengthM, pathId);
  const sink = bind(runner, Sink, 'Sink');
  const processing = processingTime === undefined
    ? null
    : bind(runner, Processing as unknown as MaterialFlowDefinition, 'ProcessingAttachment', {
      targetComponentPath: 'PathTransport',
      processingTime,
    });
  transport.adapter.nextComponents = [sink.adapter];
  sink.adapter.previousComponents = [transport.adapter];
  const root = new Object3D();
  root.add(transport.node, sink.node);
  if (processing) root.add(processing.node);
  runner.start([
    PathTransport as unknown as MaterialFlowDefinition,
    Sink,
    ...extraDefinitions,
    ...(processing ? [Processing as unknown as MaterialFlowDefinition] : []),
  ], { root });
  return { runner, transport, sink, pathId };
}

function visual(template = 'part'): RVMovingUnit {
  const node = new Object3D();
  node.name = template;
  return new RVMovingUnit(node, template);
}

function accept(state: Line, templateId?: string): DESMU {
  const mu = state.runner.createMU(templateId);
  if (!mu.visual && !templateId) mu.visual = visual();
  expect(state.transport.adapter.acceptMU(mu)).toBe(true);
  return mu;
}

function consumed(state: Line): number {
  return typeof state.sink.self.prop.consumed === 'number' ? state.sink.self.prop.consumed : 0;
}

function settle(state: Line): void {
  state.runner.getTweenRegistry().settle(state.runner.simTime);
}

function advance(state: Line, seconds: number): void {
  state.runner.getManager().processAnimated(seconds);
  settle(state);
}

describe('PathTransport', () => {
  beforeEach(() => {
    _resetDesHookCache();
    resetDESMUCounter();
    getDefaultPathNetwork().clear();
    pathCounter = 0;
  });

  it('travelTime = length/speed; visual via json mu path tween', () => {
    expect(Object.keys(PathTransport.schema).sort()).toEqual(['capacity', 'speed']);
    const state = line({ speed: 1000, capacity: 1 }, 5);
    const mu = accept(state);
    const snapshot = JSON.parse(state.runner.snapshotJson()) as {
      tweens: Array<Record<string, unknown>>;
    };
    expect(state.transport.self.prop.travelTime).toBe(5);
    expect(snapshot.tweens).toEqual([expect.objectContaining({
      kind: 'path', pathRef: state.pathId, muId: mu.id, fromS: 0, toS: 5, t0: 0, t1: 5,
    })]);

    advance(state, 2.5);
    expect(mu.visual!.node.position.z).toBeCloseTo(2.5, 9);
    expect(state.transport.adapter.currentLoad).toBe(1);
    advance(state, 2.49);
    expect(consumed(state)).toBe(0);
    advance(state, 0.02);
    expect(consumed(state)).toBe(1);

    _resetDesHookCache();
    getDefaultPathNetwork().clear();
    expect(() => line({ speed: 0 }, 5)).toThrow(/speed must be greater than zero/);
  });

  it('respects capacity without physics', () => {
    const state = line({ capacity: 2 }, 10);
    const first = accept(state);
    const second = accept(state);
    const third = state.runner.createMU();
    third.visual = visual();
    expect(state.transport.adapter.acceptMU(third)).toBe(false);
    expect(state.transport.adapter.currentLoad).toBe(2);

    advance(state, 3);
    expect(first.visual!.node.position.distanceTo(second.visual!.node.position)).toBeLessThan(1e-9);
    expect(first.visual!.node.position.z).toBeCloseTo(3, 9);

    _resetDesHookCache();
    getDefaultPathNetwork().clear();
    expect(() => line({ capacity: 1.5 })).toThrow(/capacity must be a positive integer/);
  });

  it('failure freezes all transits + tweens; snapshot during failure; per-transit resume', () => {
    const state = line({ capacity: 2 }, 10);
    state.runner.registerMuVisualFactory('part', () => visual('part'));
    const first = accept(state, 'part');
    advance(state, 2);
    const second = accept(state, 'part');
    advance(state, 1);
    const firstAtFailure = first.visual!.node.position.clone();
    const secondAtFailure = second.visual!.node.position.clone();

    state.transport.adapter.setFailure(true);
    expect(state.runner.getTweenRegistry().activeCount).toBe(0);
    const snapshot = JSON.parse(state.runner.snapshotJson()) as {
      components: Record<string, { frozen?: Array<{ remaining: number; tween?: { pathRef?: string } }> }>;
    };
    const frozen = snapshot.components.PathTransport.frozen ?? [];
    expect(frozen).toHaveLength(2);
    expect(frozen.map((entry) => entry.remaining).sort((a, b) => a - b)).toEqual([7, 9]);
    expect(frozen.every((entry) => entry.tween?.pathRef === state.pathId)).toBe(true);

    advance(state, 5);
    expect(first.visual!.node.position.distanceTo(firstAtFailure)).toBeLessThan(1e-9);
    expect(second.visual!.node.position.distanceTo(secondAtFailure)).toBeLessThan(1e-9);

    state.runner.restoreFull(snapshot as never);
    expect(state.transport.adapter.isFailure).toBe(true);
    state.transport.adapter.setFailure(false);
    expect(state.runner.getTweenRegistry().activeCount).toBe(2);
    advance(state, 6.9);
    expect(consumed(state)).toBe(0);
    advance(state, 0.2);
    expect(consumed(state)).toBe(1);
    expect(state.transport.adapter.currentLoad).toBe(1);
    advance(state, 1.8);
    expect(consumed(state)).toBe(1);
    advance(state, 0.2);
    expect(consumed(state)).toBe(2);
    expect(state.transport.adapter.currentLoad).toBe(0);
  });

  it('snapshotJson round-trip mid-transit; FastForward headless + materialization', async () => {
    const state = line({ capacity: 1 }, 10);
    state.runner.registerMuVisualFactory('part', () => visual('part'));
    const mu = accept(state, 'part');
    advance(state, 4);
    const snapshot = state.runner.snapshotJson();
    advance(state, 3);
    state.runner.restoreFull(JSON.parse(snapshot));
    expect(state.transport.adapter.currentLoad).toBe(1);
    expect(state.runner.getTweenRegistry().activeCount).toBe(1);
    settle(state);
    const restored = state.runner.getManager().getMU(mu.id) as DESMU;
    expect(restored.visual!.node.position.z).toBeCloseTo(4, 9);
    advance(state, 5.9);
    expect(consumed(state)).toBe(0);
    advance(state, 0.2);
    expect(consumed(state)).toBe(1);

    _resetDesHookCache();
    resetDESMUCounter();
    getDefaultPathNetwork().clear();
    const ffRunner = new DESRunner({ subMode: 'fastforward', durationSeconds: 5 });
    const clock = bind(ffRunner, Clock, 'Clock');
    const ff = line({ capacity: 1 }, 10, ffRunner, [Clock]);
    const root = ff.transport.node.parent;
    root?.add(clock.node);
    ffRunner.registerMuVisualFactory('ff-part', () => visual('ff-part'));
    const headless = accept(ff, 'ff-part');
    expect(headless.visual).toBeNull();
    clock.self.in(5, 'ProcessComplete');
    expect(await ffRunner.runFastForward()).toBe(true);
    expect(ffRunner.simTime).toBe(5);
    expect(headless.visual).toBeNull();

    ffRunner.setSubMode('animated');
    expect(headless.visual).not.toBeNull();
    expect(headless.visual!.node.position.z).toBeCloseTo(5, 9);
  });

  it('attached Processing holds MU at exit before transfer (station semantics via attachment)', () => {
    const state = line({}, 5, new DESRunner({ subMode: 'animated' }), [], 3);
    accept(state);

    advance(state, 5.01);
    expect(consumed(state)).toBe(0);
    expect(state.transport.adapter.currentLoad).toBe(1);
    expect(state.transport.self.state).toBe('Processing');

    advance(state, 2.98);
    expect(consumed(state)).toBe(0);
    advance(state, 0.02);
    expect(consumed(state)).toBe(1);
    expect(state.transport.adapter.getStatistics().states.Working).toBeDefined();
  });
});
