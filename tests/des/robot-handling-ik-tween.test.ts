// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Object3D, Vector3 } from 'three';
import { DESRunner } from '@rv-private/plugins/des/des-runner';
import { MaterialFlowAdapter } from '@rv-private/plugins/des/material-flow-adapter';
import {
  RobotHandling,
  cycleDuration,
} from '@rv-private/plugins/des/material-flow/RobotHandling';
import { _resetDesHookCache } from '@rv-private/plugins/des/des-hook-adapter';
import type { DESMU } from '@rv-private/plugins/des/rv-des-mu';
import { resetDESMUCounter } from '@rv-private/plugins/des/rv-des-mu';
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
import { NodeRegistry, type ComponentRef } from '../../src/core/engine/rv-node-registry';
import { SignalStore } from '../../src/core/engine/rv-signal-store';
import type { ComponentContext } from '../../src/core/engine/rv-component-registry';
import { RVDrive, DriveDirection } from '../../src/core/engine/rv-drive';
import { RVRobotIK } from '../../src/core/engine/rv-robot-ik';
import { RVIKTarget } from '../../src/core/engine/rv-ik-target';
import { RVIKPath } from '../../src/core/engine/rv-ik-path';
import { RVMovingUnit } from '../../src/core/engine/rv-mu';
import {
  axisOwner,
  claimedAxisCount,
  releaseAllAxes,
} from '../../src/core/engine/rv-axis-ownership';

interface Bound {
  def: MaterialFlowDefinition;
  self: MaterialFlowSelf;
  adapter: MaterialFlowAdapter;
  node: Object3D;
}

interface RobotFixture {
  root: Object3D;
  host: BindContextHost;
  registry: NodeRegistry;
  store: SignalStore;
  robot: RVRobotIK;
  drives: RVDrive[];
  tcp: Object3D;
  targets: Record<'home' | 'pick' | 'place' | 'approachPick' | 'approachPlace', RVIKTarget>;
  targetPaths: Record<'home' | 'pick' | 'place' | 'approachPick' | 'approachPlace', string>;
  path: RVIKPath | null;
}

const Collector = defineMaterialFlow<MaterialFlowSelf>({
  type: 'RobotIkCollector',
  kind: 'storage',
  schema: { MaxCapacity: { type: 'number', default: 20 } },
  capacity: (self) => self.prop.MaxCapacity as number,
  continuous: {},
  des: { onAccept: () => true },
});

const RobotDefinition = RobotHandling as unknown as MaterialFlowDefinition;

const componentRef = (path: string, componentType: string): ComponentRef => ({
  type: 'ComponentReference',
  path,
  componentType,
});

function makeHost(registry: NodeRegistry, store: SignalStore, drives: RVDrive[]): BindContextHost {
  const events = new EventEmitter<Record<string, unknown>>();
  return {
    signalStore: store,
    on: (event: string, callback: (...args: unknown[]) => void) => events.on(event, callback as never),
    contextMenu: new ContextMenuStore(),
    drives,
    registry,
    getPlugin: () => undefined,
  } as unknown as BindContextHost;
}

function createRobotFixture(axisCount = 2, runningPath = false): RobotFixture {
  const root = new Object3D(); root.name = 'Scene';
  const robotNode = new Object3D(); robotNode.name = 'Robot'; root.add(robotNode);
  const tcp = new Object3D(); tcp.name = 'TCP'; robotNode.add(tcp);
  const registry = new NodeRegistry();
  const store = new SignalStore();
  registry.registerNode('Robot', robotNode);
  registry.registerNode('Robot/TCP', tcp);

  const drives: RVDrive[] = [];
  for (let i = 0; i < axisCount; i++) {
    const node = new Object3D(); node.name = `A${i + 1}`; robotNode.add(node);
    const drive = new RVDrive(node);
    drive.Direction = DriveDirection.RotationZ;
    drive.TargetSpeed = 90;
    drive.initDrive();
    const path = `Robot/A${i + 1}`;
    registry.registerNode(path, node);
    registry.register('Drive', path, drive);
    drives.push(drive);
  }
  robotNode.userData.realvirtual = {
    RobotIK: {
      Axis: drives.map((_, i) => componentRef(`Robot/A${i + 1}`, 'realvirtual.Drive')),
      TCP: 'Robot/TCP',
    },
  };
  const robot = new RVRobotIK(robotNode);
  robot.init({ registry, signalStore: store } as unknown as ComponentContext);
  registry.register('RobotIK', 'Robot', robot);

  const values = {
    home: [0, 0],
    approachPick: [10, 20],
    pick: [30, 40],
    approachPlace: [50, 60],
    place: [70, 80],
  } as const;
  const targets = {} as RobotFixture['targets'];
  const targetPaths = {} as RobotFixture['targetPaths'];
  for (const key of Object.keys(values) as Array<keyof typeof values>) {
    const node = new Object3D(); node.name = key; robotNode.add(node);
    const path = `Robot/${key}`;
    const target = new RVIKTarget(node);
    target.AxisPos = [...values[key]].slice(0, axisCount);
    registry.registerNode(path, node);
    registry.register('IKTarget', path, target);
    targets[key] = target;
    targetPaths[key] = path;
  }

  let path: RVIKPath | null = null;
  if (runningPath) {
    const pathNode = new Object3D(); pathNode.name = 'ActivePath'; robotNode.add(pathNode);
    registry.registerNode('Robot/ActivePath', pathNode);
    pathNode.userData.realvirtual = {
      IKPath: { Path: [componentRef(targetPaths.pick, 'realvirtual.IKTarget')] },
    };
    path = new RVIKPath(pathNode);
    path.init({ registry, signalStore: store, root: robotNode } as unknown as ComponentContext);
    registry.register('IKPath', 'Robot/ActivePath', path);
    path.startPath();
  }

  return {
    root,
    host: makeHost(registry, store, drives),
    registry,
    store,
    robot,
    drives,
    tcp,
    targets,
    targetPaths,
    path,
  };
}

function bindContext(root: Object3D, host: BindContextHost): RVBindContext {
  const accum: KinematicsSpec = {};
  return createBindContext(root, host, accum).ctx;
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
  fixture: RobotFixture,
  def: MaterialFlowDefinition,
  name: string,
  config: Record<string, unknown>,
): Bound {
  const node = new Object3D(); node.name = name; fixture.root.add(node);
  let adapter!: MaterialFlowAdapter;
  const self = createSelf(bindContext(node, fixture.host), def, {
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

function robotConfig(fixture: RobotFixture | null, overrides: Record<string, unknown> = {}) {
  return {
    mode: 'transfer',
    batchSize: 1,
    timePerPick: 1,
    timePerCycle: 2,
    pickFilter: 'part',
    removeEmptyCarriers: false,
    maxWaitTime: 0,
    ...(fixture ? {
      robotRef: 'Robot',
      waypointHome: fixture.targetPaths.home,
      waypointPick: fixture.targetPaths.pick,
      waypointPlace: fixture.targetPaths.place,
      waypointApproachPick: fixture.targetPaths.approachPick,
      waypointApproachPlace: fixture.targetPaths.approachPlace,
    } : {}),
    ...overrides,
  };
}

function createHarness(opts: {
  ik?: boolean;
  runningPath?: boolean;
  batchSize?: number;
  config?: Record<string, unknown>;
} = {}) {
  const fixture = createRobotFixture(2, opts.runningPath ?? false);
  const runner = new DESRunner();
  const robot = bind(
    runner,
    fixture,
    RobotDefinition,
    'RobotStation',
    robotConfig(opts.ik === false ? null : fixture, {
      batchSize: opts.batchSize ?? 1,
      maxWaitTime: (opts.batchSize ?? 1) > 1 ? 1 : 0,
      ...opts.config,
    }),
  );
  const collector = bind(runner, fixture, Collector, 'Collector', { MaxCapacity: 50 });
  robot.adapter.nextComponents = [collector.adapter];
  collector.adapter.previousComponents = [robot.adapter];
  runner.start([RobotDefinition, Collector], { root: fixture.root, host: fixture.host });
  return { fixture, runner, robot, collector };
}

function part(runner: DESRunner, template?: string): DESMU {
  const mu = runner.createMU();
  mu.carrierType = 'part';
  if (template) mu.visualTemplateId = template;
  return mu;
}

function acceptBatch(harness: ReturnType<typeof createHarness>, count: number, template?: string): DESMU[] {
  const result: DESMU[] = [];
  for (let i = 0; i < count; i++) {
    const mu = part(harness.runner, template);
    result.push(mu);
    expect(harness.robot.adapter.acceptMU(mu)).toBe(true);
  }
  return result;
}

function currentCycle(self: MaterialFlowSelf) {
  return self.prop.cycle as unknown as {
    reservationId: number;
    n: number;
    cycleStart: number;
    windows: Array<{ at0: number; at1: number; targetKey: string }>;
  } | null;
}

beforeEach(() => {
  _resetDesHookCache();
  resetDESMUCounter();
});

afterEach(() => {
  releaseAllAxes();
  vi.restoreAllMocks();
});

describe('RobotHandling IK binding', () => {
  it('canonical duration: empty move times preserve the exact legacy budget and normalized windows', () => {
    expect(cycleDuration({ timePerCycle: 2, timePerPick: 0.5 }, 3)).toBe(3.5);
    const h = createHarness({ ik: false, batchSize: 3, config: { timePerCycle: 2, timePerPick: 0.5 } });
    acceptBatch(h, 3);
    const cycle = currentCycle(h.robot.self)!;
    expect(cycle.windows).toHaveLength(3 + 2 * 3);
    expect(cycle.windows[0].at0).toBe(0);
    expect(cycle.windows.at(-1)?.at1).toBeCloseTo(1);
    expect(h.runner.getTweenRegistry().activeCount).toBe(0);
    h.runner.tick(3.49);
    expect(h.collector.adapter.currentLoad).toBe(0);
    h.runner.tick(0.01);
    expect(h.collector.adapter.currentLoad).toBe(3);
    h.runner.dispose();

    const load = createHarness({
      ik: false,
      config: { mode: 'load', timePerCycle: 2, timePerPick: 0.5 },
    });
    const targetCarrier = load.runner.createMU();
    targetCarrier.carrierType = 'blister';
    targetCarrier.carrierCapacity = 1;
    expect(load.collector.adapter.acceptMU(targetCarrier)).toBe(true);
    acceptBatch(load, 1);
    expect(currentCycle(load.robot.self)?.windows.map((window) => window.targetKey)).toEqual([
      'place', 'place', 'pick', 'pick', 'home',
    ]);
    load.runner.dispose();
  });

  it('canonical duration: partially set fields follow precedence and are identical with or without IK', () => {
    const config = {
      timePerCycle: 4,
      timePerPick: 1,
      moveTimeToPick: 3,
      moveTimePickToPlace: undefined,
      moveTimeToHome: 5,
      moveTimeLoadedFactor: 2,
    };
    expect(cycleDuration(config, 2)).toBe(12);
    expect(cycleDuration({ ...config }, 2)).toBe(cycleDuration(config, 2));

    const noIk = createHarness({ ik: false, batchSize: 2, config });
    acceptBatch(noIk, 2);
    expect(currentCycle(noIk.robot.self)?.windows.at(-1)?.at1).toBeCloseTo(1);
    noIk.runner.tick(12);
    const noIkProcessed = noIk.collector.adapter.currentLoad;
    const noIkEvents = noIk.runner.getManager().totalEventsProcessed;
    noIk.runner.dispose();

    const withIk = createHarness({ batchSize: 2, config });
    acceptBatch(withIk, 2);
    withIk.runner.tick(12);
    withIk.runner.lateTick(0);
    expect(withIk.collector.adapter.currentLoad).toBe(noIkProcessed);
    expect(withIk.runner.getManager().totalEventsProcessed).toBe(noIkEvents);
    withIk.runner.dispose();
  });

  it('componentRef seeding preserves path strings through reconfigure and snapshot restore', () => {
    const fixture = createRobotFixture();
    const station = new Object3D(); station.name = 'SeededRobotHandling'; fixture.root.add(station);
    station.userData.realvirtual = {
      LayoutObject: { AssetName: 'RobotHandling' },
      RobotHandling: {
        ...robotConfig(null),
        robotRef: componentRef('Robot', 'realvirtual.RobotIK'),
        waypointHome: componentRef(fixture.targetPaths.home, 'realvirtual.IKTarget'),
        waypointPick: componentRef(fixture.targetPaths.pick, 'realvirtual.IKTarget'),
        waypointPlace: componentRef(fixture.targetPaths.place, 'realvirtual.IKTarget'),
        waypointApproachPick: componentRef(fixture.targetPaths.approachPick, 'realvirtual.IKTarget'),
        waypointApproachPlace: componentRef(fixture.targetPaths.approachPlace, 'realvirtual.IKTarget'),
        moveTimeToPick: 1,
        moveTimePickToPlace: 2,
        moveTimeToHome: 1,
      },
    };
    const runner = new DESRunner();
    runner.start([RobotDefinition], { root: fixture.root, host: fixture.host });
    const instance = runner.liveInstances.find((entry) => entry.def.type === 'RobotHandling')!;
    expect(instance.self.prop.robotRef).toBe('Robot');
    expect(instance.self.prop.waypointPick).toBe(fixture.targetPaths.pick);

    const extras = station.userData.realvirtual.RobotHandling as Record<string, unknown>;
    extras.moveTimeToPick = 1.5;
    extras.waypointPick = componentRef(fixture.targetPaths.pick, 'realvirtual.IKTarget');
    runner.reconfigureFromExtras();
    runner.reset();
    expect(instance.self.prop.moveTimeToPick).toBe(1.5);
    expect(instance.self.prop.waypointPick).toBe(fixture.targetPaths.pick);

    const snapshot = JSON.parse(runner.snapshotJson());
    instance.self.prop.robotRef = 'corrupted';
    runner.restoreFull(snapshot);
    expect(instance.self.prop.robotRef).toBe('Robot');
    expect(instance.self.prop.waypointHome).toBe(fixture.targetPaths.home);
    runner.dispose();
  });

  it('animated axes reach the final waypoint exactly at ProcessComplete simulation time', () => {
    const h = createHarness({ config: {
      moveTimeToPick: 1,
      moveTimePickToPlace: 2,
      moveTimeToHome: 1,
    } });
    acceptBatch(h, 1);
    expect(h.runner.getTweenRegistry().activeCount).toBe(h.fixture.drives.length * 5);
    h.runner.tick(2);
    h.runner.lateTick(0);
    expect(h.fixture.drives[0].currentPosition).not.toBe(0);
    h.runner.tick(2);
    h.runner.lateTick(0);
    expect(h.fixture.drives.map((drive) => drive.currentPosition)).toEqual([0, 0]);
    expect(h.collector.adapter.currentLoad).toBe(1);
    expect(h.fixture.drives.every((drive) => drive.positionOverwrite === false)).toBe(true);
    h.runner.dispose();
  });

  it('fastforward suppresses drain-slice and event-settle writes; exit snaps the final pose', () => {
    const h = createHarness({ config: {
      moveTimeToPick: 1,
      moveTimePickToPlace: 2,
      moveTimeToHome: 1,
    } });
    acceptBatch(h, 1);
    const writes = h.fixture.drives.map((drive) => vi.spyOn(drive, 'applyToNode'));
    h.runner.setSubMode('fastforward');
    h.runner.getTweenRegistry().onRender(0.5, 'hybrid', true);
    h.runner.getTweenRegistry().settle(0.5, 'event', true);
    expect(writes.every((write) => write.mock.calls.length === 0)).toBe(true);
    h.runner.setSubMode('animated');
    expect(writes.every((write) => write.mock.calls.length > 0)).toBe(true);
    expect(h.fixture.drives.map((drive) => drive.currentPosition)).toEqual([0, 0]);
    expect(h.runner.getTweenRegistry().activeCount).toBe(0);
    h.runner.dispose();
  });

  it('snapshot restore in an approach window reclaims a previously running IKPath and preserves KPIs', () => {
    const h = createHarness({ runningPath: true, config: {
      moveTimeToPick: 2,
      moveTimePickToPlace: 2,
      moveTimeToHome: 2,
    } });
    expect(h.fixture.path?.getLiveState().PathIsActive).toBe(true);
    acceptBatch(h, 1);
    expect(h.fixture.path?.getLiveState().OwnershipPaused).toBe(true);
    h.runner.tick(1);
    h.runner.lateTick(0);
    const snapshot = JSON.parse(h.runner.snapshotJson());
    h.runner.tick(5);
    h.runner.lateTick(0);
    const expectedKpis = h.runner.kpiSnapshot();
    const expectedRobotUtilization = expectedKpis.components.find(
      (component) => component.name === 'RobotStation',
    )?.utilization;

    h.runner.restoreFull(snapshot);
    expect(h.fixture.drives.map((drive) => drive.currentPosition)).toEqual([10, 20]);
    expect(h.fixture.path?.getLiveState().OwnershipPaused).toBe(true);
    expect(claimedAxisCount()).toBe(h.fixture.drives.length);
    expect(h.runner.getTweenRegistry().activeCount).toBe(0);
    h.runner.tick(5);
    h.runner.lateTick(0);
    const restoredKpis = h.runner.kpiSnapshot();
    expect(restoredKpis.simTimeSeconds).toBe(expectedKpis.simTimeSeconds);
    expect(restoredKpis.throughputPerHour).toBe(expectedKpis.throughputPerHour);
    expect(restoredKpis.bottleneck).toEqual(expectedKpis.bottleneck);
    expect(restoredKpis.components.find(
      (component) => component.name === 'RobotStation',
    )?.utilization).toBe(expectedRobotUtilization);
    expect(h.collector.adapter.currentLoad).toBe(1);
    expect(claimedAxisCount()).toBe(0);
    h.fixture.path?.dispose();
    h.runner.dispose();
  });

  it('materializeMu attaches a visual to TCP and a missing visual falls back to time-only', () => {
    const h = createHarness({ config: {
      moveTimeToPick: 1,
      moveTimePickToPlace: 1,
      moveTimeToHome: 1,
    } });
    h.runner.registerMuVisualFactory('part', () => {
      const node = new Object3D();
      node.position.set(1, 2, 3);
      h.fixture.root.add(node);
      return new RVMovingUnit(node, 'part');
    });
    const materialized = part(h.runner, 'part');
    const result = h.runner.materializeMu(materialized);
    expect(result.ok).toBe(true);
    const visual = materialized.visual as RVMovingUnit;
    const beforeAttach = visual.node.getWorldPosition(new Vector3()).clone();
    expect(h.robot.adapter.acceptMU(materialized)).toBe(true);
    expect(visual.node.parent).toBe(h.fixture.tcp);
    const world = visual.node.getWorldPosition(new Vector3());
    expect(world.toArray()).toEqual(beforeAttach.toArray());
    h.runner.tick(3);
    h.runner.lateTick(0);
    expect(visual.node.parent).toBe(h.collector.node);
    h.runner.dispose();

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fallback = createHarness({ config: {
      moveTimeToPick: 1,
      moveTimePickToPlace: 1,
      moveTimeToHome: 1,
    } });
    acceptBatch(fallback, 1);
    fallback.runner.tick(3);
    fallback.runner.lateTick(0);
    expect(fallback.collector.adapter.currentLoad).toBe(1);
    expect(warn.mock.calls.filter((call) => String(call[0]).includes('time-only'))).toHaveLength(1);
    fallback.runner.dispose();
  });

  it('fastforward exit during a pick window detaches the MU to the destination parent', () => {
    const h = createHarness({ config: {
      moveTimeToPick: 1,
      moveTimePickToPlace: 2,
      moveTimeToHome: 1,
    } });
    h.runner.registerMuVisualFactory('part', () => {
      const node = new Object3D(); h.fixture.root.add(node);
      return new RVMovingUnit(node, 'part');
    });
    const [mu] = acceptBatch(h, 1, 'part');
    const visual = mu.visual as RVMovingUnit;
    h.runner.tick(1.5);
    h.runner.lateTick(0);
    expect(visual.node.parent).toBe(h.fixture.tcp);
    h.runner.setSubMode('fastforward');
    h.runner.setSubMode('animated');
    expect(visual.node.parent).toBe(h.collector.node);
    expect(h.fixture.drives.map((drive) => drive.currentPosition)).toEqual([0, 0]);
    h.runner.dispose();
  });
});

describe('RobotHandling IK lifecycle and pool bounds', () => {
  it('reset, restore, model switch, dispose and repeated FF changes leave only the expected active claim', () => {
    const reset = createHarness({ config: {
      moveTimeToPick: 1, moveTimePickToPlace: 2, moveTimeToHome: 1,
    } });
    acceptBatch(reset, 1);
    expect(claimedAxisCount()).toBe(2);
    reset.runner.reset();
    expect(claimedAxisCount()).toBe(0);
    expect(reset.runner.getTweenRegistry().activeCount).toBe(0);
    expect(reset.fixture.drives.every((drive) => !drive.positionOverwrite)).toBe(true);
    reset.runner.dispose();

    const restored = createHarness({ config: {
      moveTimeToPick: 1, moveTimePickToPlace: 2, moveTimeToHome: 1,
    } });
    acceptBatch(restored, 1);
    restored.runner.tick(1);
    const snapshot = JSON.parse(restored.runner.snapshotJson());
    restored.runner.restoreFull(snapshot);
    expect(claimedAxisCount()).toBe(2);
    expect(restored.fixture.drives.every((drive) => axisOwner(drive) !== null)).toBe(true);
    expect(restored.runner.getTweenRegistry().activeCount).toBe(0);
    restored.runner.tick(3);
    expect(claimedAxisCount()).toBe(0);
    restored.runner.clearMUs();
    expect(restored.runner.getTweenRegistry().activeCount).toBe(0);
    expect(restored.fixture.drives.every((drive) => !drive.positionOverwrite)).toBe(true);
    restored.runner.dispose();

    const ff = createHarness({ config: {
      moveTimeToPick: 1, moveTimePickToPlace: 2, moveTimeToHome: 1,
    } });
    acceptBatch(ff, 1);
    for (let i = 0; i < 3; i++) {
      ff.runner.setSubMode('fastforward');
      ff.runner.setSubMode('animated');
    }
    expect(ff.runner.getTweenRegistry().activeCount).toBe(0);
    expect(claimedAxisCount()).toBe(2);
    ff.runner.tick(4);
    expect(claimedAxisCount()).toBe(0);
    ff.runner.dispose();
    expect(ff.fixture.drives.every((drive) => !drive.positionOverwrite)).toBe(true);
  });

  it('max batch allocates axisCount * (3 + 2n) records without growing the pool', () => {
    const h = createHarness({ batchSize: 12, config: {
      moveTimeToPick: 1,
      moveTimePickToPlace: 1,
      moveTimeToHome: 1,
    } });
    const poolBefore = h.runner.getTweenRegistry().poolSize;
    acceptBatch(h, 12);
    const expected = h.fixture.drives.length * (3 + 2 * 12);
    expect(h.runner.getTweenRegistry().activeCount).toBe(expected);
    expect(expected).toBe(54);
    expect(h.runner.getTweenRegistry().poolSize).toBe(poolBefore);
    h.runner.tick(cycleDuration({
      timePerCycle: 2,
      timePerPick: 1,
      moveTimeToPick: 1,
      moveTimePickToPlace: 1,
      moveTimeToHome: 1,
      moveTimeLoadedFactor: 1,
    }, 12));
    h.runner.lateTick(0);
    expect(h.runner.getTweenRegistry().activeCount).toBe(0);
    h.runner.dispose();
  });
});
