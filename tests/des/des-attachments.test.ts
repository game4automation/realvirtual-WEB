// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { beforeEach, describe, expect, it } from 'vitest';
import { BoxGeometry, Mesh, Object3D } from 'three';
import { DESRunner } from '@rv-private/plugins/des/des-runner';
import { MaterialFlowAdapter } from '@rv-private/plugins/des/material-flow-adapter';
import { Downtime } from '@rv-private/plugins/des/material-flow/Downtime';
import { Processing } from '@rv-private/plugins/des/material-flow/Processing';
import { IndexingConveyor } from '@rv-private/plugins/des/material-flow/IndexingConveyor';
import { PathTransport } from '@rv-private/plugins/des/material-flow/PathTransport';
import { RobotHandling } from '@rv-private/plugins/des/material-flow/RobotHandling';
import { loadMUOnCarrier } from '@rv-private/plugins/des/rv-des-component';
import { _resetDesHookCache } from '@rv-private/plugins/des/des-hook-adapter';
import { resetDESMUCounter, type DESMU } from '@rv-private/plugins/des/rv-des-mu';
import { ConveyorFlow } from '../../src/behaviors/Conveyor';
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
import { getDefaultPathNetwork } from '../../src/core/engine/rv-path-network';

interface Bound {
  readonly def: MaterialFlowDefinition;
  readonly self: MaterialFlowSelf;
  readonly adapter: MaterialFlowAdapter;
  readonly node: Object3D;
}

const Sink = defineMaterialFlow<MaterialFlowSelf>({
  type: 'AttachmentTestSink',
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

const FailureProbe = defineMaterialFlow<MaterialFlowSelf>({
  type: 'AttachmentFailureProbe',
  kind: 'storage',
  schema: { MaxCapacity: { type: 'number', default: 1 } },
  continuous: {},
  des: {},
});

const Collector = defineMaterialFlow<MaterialFlowSelf>({
  type: 'AttachmentRobotCollector',
  kind: 'storage',
  schema: { MaxCapacity: { type: 'number', default: 10 } },
  capacity: (self) => self.prop.MaxCapacity as number,
  continuous: {},
  des: { onAccept: () => true },
});

function host(drives: unknown[] = []): BindContextHost {
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
    drives: drives as never,
    registry: null,
    getPlugin: () => undefined,
  };
}

function context(node: Object3D, drives: unknown[] = []): RVBindContext {
  const accum: KinematicsSpec = {};
  return createBindContext(node, host(drives), accum).ctx;
}

function bindNode(
  runner: DESRunner,
  def: MaterialFlowDefinition,
  node: Object3D,
  config: Record<string, unknown> = {},
  ctx = context(node),
): Bound {
  let adapter!: MaterialFlowAdapter;
  const self = createSelf(ctx, def, {
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

function bind(
  runner: DESRunner,
  def: MaterialFlowDefinition,
  name: string,
  config: Record<string, unknown> = {},
): Bound {
  const node = new Object3D();
  node.name = name;
  return bindNode(runner, def, node, config);
}

function downstreamCanAccept(adapter: MaterialFlowAdapter, mu: MU, port?: Port): boolean {
  if (port) {
    const exact = adapter.nextComponents.find((candidate) => candidate.node === port.ownerRoot);
    if (exact) return exact.canAccept(mu as DESMU);
  }
  return adapter.nextComponents.some((candidate) => candidate.canAccept(mu as DESMU));
}

function connect(from: Bound, ...targets: Bound[]): void {
  from.adapter.nextComponents = targets.map((target) => target.adapter);
  for (const target of targets) target.adapter.previousComponents.push(from.adapter);
}

function start(runner: DESRunner, bounds: readonly Bound[]): void {
  const root = new Object3D();
  root.name = 'AttachmentScene';
  for (const bound of bounds) root.add(bound.node);
  runner.start([...new Set(bounds.map((bound) => bound.def))], { root });
}

function downtime(
  runner: DESRunner,
  targetPath: string,
  mtbf = 1,
  mttr = 1,
  name = 'DowntimeAttachment',
): Bound {
  return bind(runner, Downtime as unknown as MaterialFlowDefinition, name, {
    MTBF: mtbf,
    MTTR: mttr,
    Enabled: true,
    TargetComponentPath: targetPath,
  });
}

function processing(
  runner: DESRunner,
  targetPath: string,
  processingTime: number,
  name = 'ProcessingAttachment',
): Bound {
  return bind(runner, Processing as unknown as MaterialFlowDefinition, name, {
    targetComponentPath: targetPath,
    processingTime,
  });
}

function consumed(sink: Bound): number {
  return typeof sink.self.prop.consumed === 'number' ? sink.self.prop.consumed : 0;
}

function frozenFor(runner: DESRunner, path: string): Array<{ remaining: number }> {
  const component = runner.fullSnapshot().components[path] as unknown as {
    frozen?: Array<{ remaining: number }>;
  };
  return component.frozen ?? [];
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

function conveyor(runner: DESRunner, name: string, lengthMm = 1000, speedMmS = 1000): Bound {
  const node = new Object3D();
  node.name = name;
  const belt = new Mesh(new BoxGeometry(lengthMm / 1000, 0.1, 0.2));
  belt.name = 'Transport-X';
  node.add(belt);
  const sensor = new Object3D();
  sensor.name = 'Sensor';
  node.add(sensor);
  return bindNode(
    runner,
    ConveyorFlow as unknown as MaterialFlowDefinition,
    node,
    {},
    context(node, [{ name: 'Transport-X', node: belt, TargetSpeed: speedMmS }]),
  );
}

function indexing(runner: DESRunner, name: string, dwellTime: number): Bound {
  return bind(runner, IndexingConveyor as unknown as MaterialFlowDefinition, name, {
    slotCount: 1,
    pitch: 1000,
    speed: 1000,
    dwellTime,
    reportFreeAt: 1,
  });
}

function pathTransport(runner: DESRunner, name: string, lengthM = 1): Bound {
  const target = bind(runner, PathTransport as unknown as MaterialFlowDefinition, name, {
    speed: 1000,
    capacity: 1,
  });
  addPath(target.node, lengthM, `${name}-path`);
  return target;
}

function robot(runner: DESRunner, name: string): Bound {
  return bind(runner, RobotHandling as unknown as MaterialFlowDefinition, name, {
    mode: 'unload',
    batchSize: 1,
    timePerPick: 0,
    timePerCycle: 1,
    pickFilter: 'part',
    removeEmptyCarriers: false,
    maxWaitTime: 0,
  });
}

function carrierWithPart(runner: DESRunner): DESMU {
  const carrier = runner.createMU();
  carrier.carrierType = 'blister';
  carrier.carrierCapacity = 1;
  const part = runner.createMU();
  part.carrierType = 'part';
  expect(loadMUOnCarrier(carrier, part, runner.getManager())).toBe(true);
  return carrier;
}

describe('central attachment components (Downtime + Processing)', () => {
  beforeEach(() => {
    _resetDesHookCache();
    resetDESMUCounter();
    getDefaultPathNetwork().clear();
  });

  it('a configured Downtime definition fails the target adapter without a direct setFailure call', () => {
    const runner = new DESRunner();
    const target = bind(runner, FailureProbe, 'FailureTarget', { MaxCapacity: 1 });
    const failure = downtime(runner, 'FailureTarget', 2, 3);
    start(runner, [target, failure]);

    runner.tick(1.99);
    expect(target.adapter.isFailure).toBe(false);
    runner.tick(0.02);
    expect(target.adapter.isFailure).toBe(true);
    expect(failure.self.prop.failureCount).toBe(1);
    runner.tick(2.98);
    expect(target.adapter.isFailure).toBe(true);
    runner.tick(0.02);
    expect(target.adapter.isFailure).toBe(false);
  });

  it('MTBF/MTTR cycle drives freeze/resume of IndexingConveyor, RobotHandling and PathTransport', () => {
    const indexRunner = new DESRunner();
    const indexTarget = indexing(indexRunner, 'IndexingDowntime', 0);
    const indexSink = bind(indexRunner, Sink, 'IndexSink');
    const indexFailure = downtime(indexRunner, 'IndexingDowntime', 0.25, 0.5, 'IndexDowntime');
    connect(indexTarget, indexSink);
    start(indexRunner, [indexTarget, indexSink, indexFailure]);
    expect(indexTarget.adapter.acceptMU(indexRunner.createMU())).toBe(true);
    indexRunner.tick(0.25);
    expect(indexTarget.adapter.isFailure).toBe(true);
    expect(frozenFor(indexRunner, 'IndexingDowntime').length).toBeGreaterThan(0);
    indexRunner.tick(0.5);
    expect(indexTarget.adapter.isFailure).toBe(false);

    const robotRunner = new DESRunner();
    const robotTarget = robot(robotRunner, 'RobotDowntime');
    const robotSink = bind(robotRunner, Collector, 'RobotSink', { MaxCapacity: 10 });
    const robotFailure = downtime(robotRunner, 'RobotDowntime', 0.25, 0.5, 'RobotDowntimeCycle');
    connect(robotTarget, robotSink);
    start(robotRunner, [robotTarget, robotSink, robotFailure]);
    expect(robotTarget.adapter.acceptMU(carrierWithPart(robotRunner))).toBe(true);
    robotRunner.tick(0.25);
    expect(robotTarget.adapter.isFailure).toBe(true);
    expect(robotTarget.self.prop.failurePending).toBe(true);
    robotRunner.tick(0.5);
    expect(robotTarget.adapter.isFailure).toBe(false);
    expect(robotTarget.self.prop.failurePending).toBe(false);

    const pathRunner = new DESRunner();
    const pathTarget = pathTransport(pathRunner, 'PathDowntime');
    const pathSink = bind(pathRunner, Sink, 'PathSink');
    const pathFailure = downtime(pathRunner, 'PathDowntime', 0.25, 0.5, 'PathDowntimeCycle');
    connect(pathTarget, pathSink);
    start(pathRunner, [pathTarget, pathSink, pathFailure]);
    expect(pathTarget.adapter.acceptMU(pathRunner.createMU())).toBe(true);
    pathRunner.tick(0.25);
    expect(pathTarget.adapter.isFailure).toBe(true);
    expect(frozenFor(pathRunner, 'PathDowntime').length).toBeGreaterThan(0);
    pathRunner.tick(0.5);
    expect(pathTarget.adapter.isFailure).toBe(false);
  });

  it('Processing attached to a plain Conveyor holds MUs for processingTime at the exit', () => {
    const runner = new DESRunner();
    const target = conveyor(runner, 'Conveyor');
    const sink = bind(runner, Sink, 'ConveyorSink');
    const process = processing(runner, 'Conveyor', 3);
    connect(target, sink);
    start(runner, [target, sink, process]);
    target.self.signals.set('Flow.Run', true);

    expect(target.adapter.acceptMU(runner.createMU())).toBe(true);
    runner.tick(1.01);
    expect(consumed(sink)).toBe(0);
    expect(target.self.state).toBe('Processing');
    expect(target.adapter.getStatistics().currentState).toBe('Working');
    runner.tick(2.98);
    expect(consumed(sink)).toBe(0);
    runner.tick(0.02);
    expect(consumed(sink)).toBe(1);

    const invalidRunner = new DESRunner();
    const invalidTarget = bind(invalidRunner, FailureProbe, 'InvalidProcessingTarget');
    const invalidProcess = processing(invalidRunner, 'InvalidProcessingTarget', 0);
    expect(() => start(invalidRunner, [invalidTarget, invalidProcess])).toThrow(
      /processingTime must be greater than zero/,
    );
  });

  it('Processing attached to IndexingConveyor extends dwell to max(dwellTime, processingTime) with processing KPI', () => {
    const runner = new DESRunner();
    const target = indexing(runner, 'Indexing', 5);
    const sink = bind(runner, Sink, 'IndexingSink');
    const process = processing(runner, 'Indexing', 7);
    connect(target, sink);
    start(runner, [target, sink, process]);

    expect(target.adapter.acceptMU(runner.createMU())).toBe(true);
    runner.tick(1.01);
    expect(target.self.prop.effectiveDwellTime).toBe(7);
    expect(target.self.state).toBe('Processing');
    runner.tick(6.98);
    expect(consumed(sink)).toBe(0);
    runner.tick(0.02);
    expect(consumed(sink)).toBe(1);
    expect(target.adapter.getStatistics().states.Working).toBeDefined();
  });

  it('Processing + Downtime on the same target freezes the remaining processing time', () => {
    const runner = new DESRunner();
    const target = pathTransport(runner, 'CombinedTarget');
    const sink = bind(runner, Sink, 'CombinedSink');
    const process = processing(runner, 'CombinedTarget', 5, 'CombinedProcessing');
    const failure = downtime(runner, 'CombinedTarget', 5, 3, 'CombinedDowntime');
    connect(target, sink);
    start(runner, [target, sink, process, failure]);
    expect(target.adapter.attachedProcessingTime).toBe(5);

    runner.tick(3);
    expect(target.adapter.acceptMU(runner.createMU())).toBe(true);
    runner.tick(1);
    expect(target.self.state).toBe('Processing');
    runner.tick(1);
    expect(target.adapter.isFailure).toBe(true);
    const snapshot = JSON.parse(runner.snapshotJson()) as ReturnType<DESRunner['fullSnapshot']>;
    const combinedFrozen = (snapshot.components.CombinedTarget as unknown as {
      frozen?: Array<{ remaining: number }>;
    }).frozen;
    expect(combinedFrozen).toHaveLength(1);
    const remaining = combinedFrozen![0].remaining;
    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBeLessThan(5);

    runner.restoreFull(snapshot);
    expect(target.adapter.isFailure).toBe(true);
    runner.tick(3);
    expect(target.adapter.isFailure).toBe(false);
    runner.tick(remaining - 0.01);
    expect(consumed(sink)).toBe(0);
    runner.tick(0.02);
    expect(consumed(sink)).toBe(1);
  });
});
