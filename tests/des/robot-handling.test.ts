// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { beforeEach, describe, expect, it } from 'vitest';
import { Object3D } from 'three';
import { DESRunner } from '@rv-private/plugins/des/des-runner';
import { MaterialFlowAdapter } from '@rv-private/plugins/des/material-flow-adapter';
import { RobotHandling } from '@rv-private/plugins/des/material-flow/RobotHandling';
import { PalletSource } from '@rv-private/plugins/des/material-flow/PalletSource';
import { IndexingConveyor } from '@rv-private/plugins/des/material-flow/IndexingConveyor';
import { _resetDesHookCache } from '@rv-private/plugins/des/des-hook-adapter';
import {
  loadMUOnCarrier,
} from '@rv-private/plugins/des/rv-des-component';
import { resetDESMUCounter, type DESMU } from '@rv-private/plugins/des/rv-des-mu';
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

const Collector = defineMaterialFlow<MaterialFlowSelf>({
  type: 'RobotHandlingCollector',
  kind: 'storage',
  schema: { MaxCapacity: { type: 'number', default: 20 } },
  capacity: (self) => self.prop.MaxCapacity as number,
  continuous: {},
  des: { onAccept: () => true },
});

const RobotDefinition = RobotHandling as unknown as MaterialFlowDefinition;

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

function downstreamCanAccept(adapter: MaterialFlowAdapter, mu: MU, port?: Port): boolean {
  if (port) {
    const exact = adapter.nextComponents.find((candidate) => candidate.node === port.ownerRoot);
    if (exact) return exact.canAccept(mu as DESMU);
  }
  return adapter.nextComponents.some((candidate) => candidate.canAccept(mu as DESMU));
}

function bind(
  runner: DESRunner,
  def: MaterialFlowDefinition,
  name: string,
  config: Record<string, unknown> = {},
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

function robotConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    mode: 'unload',
    batchSize: 2,
    timePerPick: 0,
    timePerCycle: 1,
    pickFilter: 'part',
    removeEmptyCarriers: false,
    maxWaitTime: 0,
    ...overrides,
  };
}

function start(
  runner: DESRunner,
  bounds: readonly Bound[],
): void {
  const root = new Object3D();
  for (const bound of bounds) root.add(bound.node);
  const definitions = [...new Set(bounds.map((bound) => bound.def))];
  runner.start(definitions, { root });
}

function connect(from: Bound, ...targets: Bound[]): void {
  from.adapter.nextComponents = targets.map((target) => target.adapter);
  for (const target of targets) target.adapter.previousComponents.push(from.adapter);
}

function part(runner: DESRunner): DESMU {
  const mu = runner.createMU();
  mu.carrierType = 'part';
  return mu;
}

function carrierWithParts(runner: DESRunner, count: number, capacity = count): DESMU {
  const carrier = runner.createMU();
  carrier.carrierType = 'blister';
  carrier.carrierCapacity = capacity;
  for (let i = 0; i < count; i++) {
    expect(loadMUOnCarrier(carrier, part(runner), runner.getManager())).toBe(true);
  }
  return carrier;
}

function cycle(self: MaterialFlowSelf): { reservationId: number; n: number } | null {
  return self.prop.cycle as unknown as { reservationId: number; n: number } | null;
}

beforeEach(() => {
  _resetDesHookCache();
  resetDESMUCounter();
});

describe('RobotHandling', () => {
  it('unload: waits for free capacity >= n, commits batch atomically', () => {
    const runner = new DESRunner();
    const robot = bind(runner, RobotDefinition, 'RobotUnload', robotConfig());
    const target = bind(runner, Collector, 'Collector', { MaxCapacity: 4 });
    connect(robot, target);
    start(runner, [robot, target]);
    target.adapter.setFailure(true);

    const blister = carrierWithParts(runner, 2);
    expect(robot.adapter.acceptMU(blister)).toBe(true);
    expect(cycle(robot.self)).toBeNull();
    expect(target.adapter.currentLoad).toBe(0);

    target.adapter.setFailure(false);
    expect(cycle(robot.self)).toMatchObject({ n: 2 });
    expect(runner.getManager().activeReservationCount).toBe(1);
    runner.tick(0.99);
    expect(target.adapter.currentLoad).toBe(0);
    expect(blister.childMUs).toHaveLength(2);
    runner.tick(0.01);
    expect(target.adapter.currentLoad).toBe(2);
    expect(blister.childMUs).toHaveLength(0);
    expect(runner.getManager().activeReservationCount).toBe(0);

    _resetDesHookCache();
    const e2eRunner = new DESRunner();
    const source = bind(e2eRunner, PalletSource as unknown as MaterialFlowDefinition, 'PalletSource', {
      PalletTemplateRef: '', BlisterTemplateRef: '', PartTemplateRef: '',
      BlisterCount: 1, PartsPerBlister: 1, CarrierCapacity: 1,
      GridRows: 1, GridColumns: 1, GridPitch: 100,
    });
    const e2eRobot = bind(e2eRunner, RobotDefinition, 'RobotE2E', robotConfig({
      batchSize: 1, timePerCycle: 0,
    }));
    const conveyor = bind(
      e2eRunner,
      IndexingConveyor as unknown as MaterialFlowDefinition,
      'IndexingE2E',
      { slotCount: 2, pitch: 1000, speed: 1000, dwellTime: 0, reportFreeAt: 1 },
    );
    const sink = bind(e2eRunner, Collector, 'E2ESink', { MaxCapacity: 4 });
    connect(source, e2eRobot);
    connect(e2eRobot, conveyor);
    connect(conveyor, sink);
    start(e2eRunner, [source, e2eRobot, conveyor, sink]);
    e2eRunner.tick(0);
    expect(source.self.prop.generatedPallets).toBe(1);
    expect(conveyor.adapter.currentLoad).toBe(1);
    expect((conveyor.self.prop.slots as unknown[])[0]).not.toBeNull();
    e2eRunner.tick(1);
    expect((conveyor.self.prop.slots as unknown[])[1]).not.toBeNull();
  });

  it('load: reserves target carrier slots atomically; two robots on same blister never oversubscribe', () => {
    const runner = new DESRunner();
    const config = robotConfig({ mode: 'load', maxWaitTime: 1 });
    const a = bind(runner, RobotDefinition, 'RobotA', config);
    const b = bind(runner, RobotDefinition, 'RobotB', config);
    const target = bind(runner, Collector, 'CarrierStation', { MaxCapacity: 10 });
    connect(a, target);
    connect(b, target);
    start(runner, [a, b, target]);

    const carrier = carrierWithParts(runner, 0, 3);
    expect(target.adapter.acceptMU(carrier)).toBe(true);
    expect(a.adapter.acceptMU(part(runner))).toBe(true);
    expect(a.adapter.acceptMU(part(runner))).toBe(true);
    expect(b.adapter.acceptMU(part(runner))).toBe(true);
    expect(b.adapter.acceptMU(part(runner))).toBe(true);

    expect(cycle(a.self)).toMatchObject({ n: 2 });
    expect(cycle(b.self)).toMatchObject({ n: 1 });
    expect(runner.getManager().activeReservationCount).toBe(2);
    const reservedSlots = (runner.fullSnapshot().reservations ?? [])
      .reduce((sum, reservation) => sum + (reservation.carrier?.slots ?? 0), 0);
    expect(reservedSlots).toBe(3);

    runner.tick(1);
    expect(carrier.childMUs).toHaveLength(3);
    expect(carrier.childMUs.length).toBeLessThanOrEqual(carrier.carrierCapacity ?? 0);
    expect(b.adapter.currentLoad).toBe(1);
    expect(runner.getManager().activeReservationCount).toBe(0);
  });

  it('transfer mode moves parts between neighbors', () => {
    const runner = new DESRunner();
    const robot = bind(runner, RobotDefinition, 'RobotTransfer', robotConfig({
      mode: 'transfer', batchSize: 1, timePerCycle: 2,
    }));
    const target = bind(runner, Collector, 'TransferTarget', { MaxCapacity: 2 });
    connect(robot, target);
    start(runner, [robot, target]);
    const mu = part(runner);
    expect(robot.adapter.acceptMU(mu)).toBe(true);
    runner.tick(1.99);
    expect(robot.adapter.currentLoad).toBe(1);
    expect(target.adapter.currentLoad).toBe(0);
    runner.tick(0.01);
    expect(robot.adapter.currentLoad).toBe(0);
    expect(target.adapter.heldMUs).toContain(mu);

    _resetDesHookCache();
    const invalid = new DESRunner();
    const invalidRobot = bind(invalid, RobotDefinition, 'InvalidRobot', robotConfig({
      mode: 'invalid', batchSize: 0,
    }));
    expect(() => start(invalid, [invalidRobot])).toThrow(/mode must be/);
  });

  it('empty carriers via empty port; visible block when removeEmptyCarriers=false', () => {
    const runner = new DESRunner();
    const robot = bind(runner, RobotDefinition, 'RobotEmpty', robotConfig({
      batchSize: 1, removeEmptyCarriers: true,
    }));
    const target = bind(runner, Collector, 'PartCollector', { MaxCapacity: 2 });
    const empty = bind(runner, Collector, 'EmptyCollector', { MaxCapacity: 2 });
    connect(robot, target, empty);
    start(runner, [robot, target, empty]);
    const emptyBlister = carrierWithParts(runner, 0, 1);
    expect(robot.adapter.acceptMU(emptyBlister)).toBe(true);
    runner.tick(1);
    expect(target.adapter.currentLoad).toBe(0);
    expect(empty.adapter.heldMUs).toContain(emptyBlister);

    _resetDesHookCache();
    const blockedRunner = new DESRunner();
    const blocked = bind(
      blockedRunner,
      RobotDefinition,
      'RobotBlocked',
      robotConfig({ batchSize: 1, removeEmptyCarriers: false }),
    );
    const blockedTarget = bind(blockedRunner, Collector, 'BlockedTarget', { MaxCapacity: 2 });
    const blockedEmpty = bind(blockedRunner, Collector, 'EmptyTarget', { MaxCapacity: 2 });
    connect(blocked, blockedTarget, blockedEmpty);
    start(blockedRunner, [blocked, blockedTarget, blockedEmpty]);
    const retained = carrierWithParts(blockedRunner, 0, 1);
    expect(blocked.adapter.acceptMU(retained)).toBe(true);
    expect(blocked.self.state).toBe('Blocked');
    expect(blocked.adapter.heldMUs).toContain(retained);
    expect(blockedRunner.fullSnapshot().components.RobotBlocked.currentStateName).toBe('Blocked');
  });

  it('cycle time = timePerCycle + n * timePerPick; partial batch after maxWaitTime', () => {
    const runner = new DESRunner();
    const robot = bind(runner, RobotDefinition, 'RobotTimed', robotConfig({
      batchSize: 3,
      timePerCycle: 1,
      timePerPick: 0.5,
      maxWaitTime: 2,
      mode: 'transfer',
    }));
    const target = bind(runner, Collector, 'TimedTarget', { MaxCapacity: 4 });
    connect(robot, target);
    start(runner, [robot, target]);
    expect(robot.adapter.acceptMU(part(runner))).toBe(true);
    expect(robot.adapter.acceptMU(part(runner))).toBe(true);
    expect(cycle(robot.self)).toBeNull();

    runner.tick(1.99);
    expect(cycle(robot.self)).toBeNull();
    runner.tick(0.01);
    expect(cycle(robot.self)).toMatchObject({ n: 2 });
    expect(robot.self.sig.Busy.get()).toBe(true);
    runner.tick(1.99);
    expect(target.adapter.currentLoad).toBe(0);
    runner.tick(0.01);
    expect(target.adapter.currentLoad).toBe(2);
    expect(runner.getManager().currentTime).toBeCloseTo(4);
    expect(robot.self.sig.Busy.get()).toBe(false);
  });

  it('reservation prevents deadlock on full conveyor; rollback on failure/reset; reserved carrier retire', () => {
    const runner = new DESRunner();
    const robot = bind(runner, RobotDefinition, 'RobotReserved', robotConfig({
      mode: 'transfer', maxWaitTime: 1,
    }));
    const target = bind(runner, Collector, 'ReservedTarget', { MaxCapacity: 2 });
    connect(robot, target);
    start(runner, [robot, target]);
    expect(robot.adapter.acceptMU(part(runner))).toBe(true);
    expect(robot.adapter.acceptMU(part(runner))).toBe(true);
    expect(runner.getManager().activeReservationCount).toBe(1);
    expect(target.adapter.canAccept(part(runner))).toBe(false);
    runner.tick(1);
    expect(target.adapter.currentLoad).toBe(2);

    _resetDesHookCache();
    const failureRunner = new DESRunner();
    const failureRobot = bind(
      failureRunner,
      RobotDefinition,
      'FailureRobot',
      robotConfig({ mode: 'transfer', batchSize: 1, timePerCycle: 3 }),
    );
    const failureTarget = bind(failureRunner, Collector, 'FailureTarget', { MaxCapacity: 2 });
    connect(failureRobot, failureTarget);
    start(failureRunner, [failureRobot, failureTarget]);
    const retained = part(failureRunner);
    expect(failureRobot.adapter.acceptMU(retained)).toBe(true);
    failureTarget.adapter.setFailure(true);
    expect(failureRunner.getManager().activeReservationCount).toBe(0);
    failureRunner.tick(3);
    expect(failureRobot.adapter.heldMUs).toContain(retained);
    expect(failureTarget.adapter.currentLoad).toBe(0);

    _resetDesHookCache();
    const resetRunner = new DESRunner();
    const resetRobot = bind(
      resetRunner,
      RobotDefinition,
      'ResetRobot',
      robotConfig({ mode: 'transfer', batchSize: 1, timePerCycle: 3 }),
    );
    const resetTarget = bind(resetRunner, Collector, 'ResetTarget', { MaxCapacity: 2 });
    connect(resetRobot, resetTarget);
    start(resetRunner, [resetRobot, resetTarget]);
    expect(resetRobot.adapter.acceptMU(part(resetRunner))).toBe(true);
    expect(resetRunner.getManager().activeReservationCount).toBe(1);
    resetRunner.reset();
    expect(resetRunner.getManager().activeReservationCount).toBe(0);

    _resetDesHookCache();
    const carrierRunner = new DESRunner();
    const loadRobot = bind(
      carrierRunner,
      RobotDefinition,
      'CarrierRobot',
      robotConfig({ mode: 'load', batchSize: 1, timePerCycle: 2 }),
    );
    const carrierTarget = bind(carrierRunner, Collector, 'CarrierTarget', { MaxCapacity: 3 });
    connect(loadRobot, carrierTarget);
    start(carrierRunner, [loadRobot, carrierTarget]);
    const carrier = carrierWithParts(carrierRunner, 0, 1);
    expect(carrierTarget.adapter.acceptMU(carrier)).toBe(true);
    const sourcePart = part(carrierRunner);
    expect(loadRobot.adapter.acceptMU(sourcePart)).toBe(true);
    expect(carrierRunner.getManager().activeReservationCount).toBe(1);
    carrierRunner.getManager().retireMU(carrier);
    expect(carrierRunner.getManager().activeReservationCount).toBe(0);
    carrierRunner.tick(2);
    expect(loadRobot.adapter.heldMUs).toContain(sourcePart);
  });

  it('failure mid-cycle at safe transition; snapshot mid-cycle restores reservation exactly', () => {
    const runner = new DESRunner();
    const robot = bind(runner, RobotDefinition, 'RobotSnapshot', robotConfig({
      mode: 'transfer', batchSize: 2, maxWaitTime: 1, timePerCycle: 5,
    }));
    const target = bind(runner, Collector, 'SnapshotTarget', { MaxCapacity: 4 });
    connect(robot, target);
    start(runner, [robot, target]);
    expect(robot.adapter.acceptMU(part(runner))).toBe(true);
    expect(robot.adapter.acceptMU(part(runner))).toBe(true);
    runner.tick(2);

    const expectedCycle = structuredClone(robot.self.prop.cycle);
    const snapshot = JSON.parse(runner.snapshotJson());
    expect(snapshot.reservations).toHaveLength(1);
    runner.tick(1);
    runner.restoreFull(snapshot);
    expect(robot.self.prop.cycle).toEqual(expectedCycle);
    expect(runner.getManager().activeReservationCount).toBe(1);
    expect(runner.fullSnapshot().reservations).toEqual(snapshot.reservations);
    expect(robot.self.sig.Busy.get()).toBe(true);

    robot.adapter.setFailure(true);
    expect(robot.adapter.isFailure).toBe(true);
    expect(runner.getManager().activeReservationCount).toBe(1);
    runner.tick(2.9);
    expect(target.adapter.currentLoad).toBe(0);
    expect(robot.self.sig.Busy.get()).toBe(true);
    runner.tick(0.2);
    expect(target.adapter.currentLoad).toBe(2);
    expect(robot.adapter.isFailure).toBe(true);
    expect(robot.self.sig.Busy.get()).toBe(false);
    expect(robot.self.state).toBe('Failure');
    expect(robot.self.prop.cycle).toBeNull();
    expect(runner.getManager().activeReservationCount).toBe(0);
  });
});
