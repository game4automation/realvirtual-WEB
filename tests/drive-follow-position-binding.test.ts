// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Box3, Object3D } from 'three';
import { createTestViewer, type TestViewerHandle } from './helpers/create-test-viewer';
import { RVDrive, DriveDirection } from '../src/core/engine/rv-drive';
import { RVDrivesPlayback, type CompactRecording } from '../src/core/engine/rv-drives-playback';
import { RVReplayRecording } from '../src/core/engine/rv-replay-recording';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { RVTransportManager } from '../src/core/engine/rv-transport-manager';
import { SignalBindingManager } from '../src/core/engine/rv-signal-binding-manager';
import {
  getBindEligibility,
  resolveBindableSlots,
} from '../src/core/engine/rv-binding-slot-resolver';
import { clearLiveControl } from '../src/core/engine/rv-live-control';
import { enumerateAllBindableTargets } from '../src/plugins/signal-bind/bindable-targets';
import { RobotFollowPositionPlugin } from '../src/plugins/models/DemoRealvirtualWeb/robot-follow-position';
import { TestAxesPlugin } from '../src/plugins/demo/test-axes-plugin';
import { ModelPluginManager } from '../src/core/rv-model-plugin-manager';
import { setContext } from '../src/core/hmi/ui-context-store';
import type { LoadResult } from '../src/core/engine/rv-scene-loader';
import type { RVViewer } from '../src/core/rv-viewer';

interface DriveConfig {
  name: string;
  behaviorKey?: string;
}

interface Harness {
  viewer: RVViewer;
  root: Object3D;
  result: LoadResult;
  store: SignalStore;
  registry: NodeRegistry;
  drives: RVDrive[];
  playback: RVDrivesPlayback;
  manager: SignalBindingManager;
  plugin: RobotFollowPositionPlugin;
}

const DEFAULT_DRIVES: DriveConfig[] = [
  { name: 'A1' },
  { name: 'A2' },
  { name: 'A3' },
  { name: 'A4' },
  { name: 'A5' },
  { name: 'A6' },
  { name: 'SchunkEGH80Gripper', behaviorKey: 'Drive_Cylinder' },
  { name: 'LeftFinger', behaviorKey: 'Drive_Gear' },
  { name: 'RightFinger', behaviorKey: 'Drive_Gear' },
];

let viewerHandle: TestViewerHandle;
let activeHarness: Harness | null = null;

function disposeHarness(): void {
  if (!activeHarness) return;
  activeHarness.plugin.onModelCleared();
  activeHarness.manager.dispose();
  activeHarness.root.removeFromParent();
  activeHarness = null;
}

function buildHarness(viewer: RVViewer, configs: DriveConfig[] = DEFAULT_DRIVES): Harness {
  disposeHarness();
  clearLiveControl();

  const root = new Object3D();
  root.name = 'Robot';
  viewer.scene.add(root);
  const store = new SignalStore();
  const registry = new NodeRegistry();
  registry.registerNode('Robot', root);

  const drives: RVDrive[] = [];
  for (const config of configs) {
    const node = new Object3D();
    node.name = config.name;
    const rv: Record<string, unknown> = { Drive: {} };
    if (config.behaviorKey) rv[config.behaviorKey] = {};
    node.userData.realvirtual = rv;
    root.add(node);
    const path = NodeRegistry.computeNodePath(node);
    registry.registerNode(path, node);

    const drive = new RVDrive(node);
    drive.Direction = DriveDirection.RotationZ;
    drive.initDrive();
    registry.register('Drive', path, drive);
    drives.push(drive);
  }

  const positions = new Array<number>(configs.length * 3).fill(0);
  const recording: CompactRecording = {
    fixedDeltaTime: 0.02,
    numberFrames: 3,
    driveCount: configs.length,
    drives: configs.map((config, index) => ({
      id: index,
      path: `Robot/${config.name}`,
    })),
    sequences: [{ name: 'Loading', startFrame: 0, endFrame: 2 }],
    positions,
  };
  const playback = new RVDrivesPlayback(recording, registry);
  const transportManager = new RVTransportManager();
  const result = {
    root,
    drives,
    transportManager,
    signalStore: store,
    registry,
    playback,
    replayRecordings: [],
    recorderSettings: null,
    logicEngine: null,
    boundingBox: new Box3(),
    triangleCount: 0,
    groups: null,
    modelConfig: {},
  } as unknown as LoadResult;

  viewer.signalStore = store;
  viewer.registry = registry;
  viewer.drives = drives;
  viewer.transportManager = transportManager;
  viewer.playback = playback;
  (viewer as unknown as { replayRecordings: RVReplayRecording[] }).replayRecordings = [];
  viewer.logicEngine = null;
  viewer.ikPaths = [];

  const manager = new SignalBindingManager(store, registry);
  manager.holdMs = 0;
  viewer.signalBindingManager = manager;

  const plugin = new RobotFollowPositionPlugin();
  plugin.onModelLoaded(result, viewer);

  activeHarness = { viewer, root, result, store, registry, drives, playback, manager, plugin };
  return activeHarness;
}

function axis(harness: Harness, name: string): RVDrive {
  const drive = harness.drives.find((candidate) => candidate.name === name);
  if (!drive) throw new Error(`Missing test drive ${name}`);
  return drive;
}

function registerSource(
  harness: Harness,
  name: string,
  value: boolean | number,
  type = 'PLCOutputFloat',
): void {
  harness.store.register(name, `__iface__/${name}`, value, type);
  harness.store.registerSignalProvider({ interfaceId: 'plc', signal: name }, true);
}

function bindAxis(harness: Harness, axisName: string, source: string): void {
  const drive = axis(harness, axisName);
  harness.manager.bind(axisName, drive.node, {
    slot: 'Position',
    signal: source,
    interfaceId: 'plc',
    direction: 'plcOutput',
    enabled: true,
  });
}

function tick(viewer: RVViewer, count = 1, dt = 0.02): void {
  for (let i = 0; i < count; i++) viewer._tickOnce(dt);
}

beforeAll(async () => {
  viewerHandle = await createTestViewer('webgl', { plannerSignalLinking: true });
});

beforeEach(() => {
  disposeHarness();
  clearLiveControl();
});

afterAll(() => {
  disposeHarness();
  clearLiveControl();
  viewerHandle.dispose();
});

describe('Drive_FollowPosition binding and recording handoff', () => {
  it('attaches six idempotent behaviors with 12 unique signals and ComponentReference wiring', () => {
    const harness = buildHarness(viewerHandle.viewer);
    const signalNames = [...harness.store.getAll().keys()]
      .filter((name) => /^A[1-6]\.(Position|CurrentPosition)$/.test(name));
    expect(signalNames).toHaveLength(12);
    expect(new Set(signalNames).size).toBe(12);

    harness.plugin.onModelLoaded(harness.result, harness.viewer);
    expect(harness.registry.getAll('Drive_FollowPosition')).toHaveLength(6);
    expect([...harness.store.getAll().keys()]
      .filter((name) => /^A[1-6]\.(Position|CurrentPosition)$/.test(name))).toHaveLength(12);
    for (const name of ['A1', 'A2', 'A3', 'A4', 'A5', 'A6']) {
      const drive = axis(harness, name);
      expect(drive.driveBehaviors).toHaveLength(1);
      const extras = drive.node.userData.realvirtual.Drive_FollowPosition;
      expect(extras.Position).toMatchObject({
        type: 'ComponentReference',
        componentType: 'PLCOutputFloat',
      });
      expect(extras.CurrentPosition).toMatchObject({
        type: 'ComponentReference',
        componentType: 'PLCInputFloat',
      });
    }
  });

  it('resolves mapped control/feedback slots and exposes eligible node targets', () => {
    const harness = buildHarness(viewerHandle.viewer);
    const drive = axis(harness, 'A1');
    const slots = resolveBindableSlots(drive.node, harness.store, harness.registry);
    expect(slots).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'mapped-signal',
        slot: 'Position',
        direction: 'plcOutput',
        targetName: 'A1.Position',
        drive,
      }),
      expect.objectContaining({
        kind: 'mapped-signal',
        slot: 'CurrentPosition',
        direction: 'plcInput',
        targetName: 'A1.CurrentPosition',
      }),
    ]));
    expect(getBindEligibility(drive.node, harness.registry)).toEqual({ eligible: true });
    expect(enumerateAllBindableTargets(harness.viewer)
      .some((target) => target.node === drive.node)).toBe(true);
  });

  it('hands all nine drives to live control and keeps two axis channels independent', () => {
    const harness = buildHarness(viewerHandle.viewer);
    expect(harness.playback.play()).toBe(true);
    registerSource(harness, 'PLC.A1', 11);
    registerSource(harness, 'PLC.A2', 22);
    registerSource(harness, 'PLC.A3', 33);
    bindAxis(harness, 'A1', 'PLC.A1');
    bindAxis(harness, 'A2', 'PLC.A2');
    bindAxis(harness, 'A3', 'PLC.A3');

    tick(harness.viewer, 2);
    expect(harness.manager.getBindingLiveness('A2', 'Position')).toBe('live');
    expect(axis(harness, 'A2').liveControlled).toBe(true);
    expect(harness.playback.isPlaying).toBe(false);
    expect(harness.playback.boundDrives.every((drive) => drive?.positionOverwrite === false)).toBe(true);
    expect(axis(harness, 'A1').currentPosition).toBe(11);
    expect(axis(harness, 'A2').currentPosition).toBe(22);
    expect(axis(harness, 'A3').currentPosition).toBe(33);
    expect(harness.store.getFloat('A1.CurrentPosition')).toBe(11);
    expect(harness.store.getFloat('A3.CurrentPosition')).toBe(33);
  });

  it('releases overwrite after playback was paused without resetting the frame', () => {
    const harness = buildHarness(viewerHandle.viewer);
    harness.playback.play();
    tick(harness.viewer);
    const frame = harness.playback.frame;
    harness.playback.pause();
    expect(harness.playback.isPlaying).toBe(false);
    expect(axis(harness, 'A2').positionOverwrite).toBe(true);

    registerSource(harness, 'PLC.A2', 25);
    bindAxis(harness, 'A2', 'PLC.A2');
    tick(harness.viewer, 2);
    expect(harness.playback.frame).toBe(frame);
    expect(harness.playback.boundDrives.every((drive) => drive?.positionOverwrite === false)).toBe(true);
  });

  it('releases overwrite while ActiveOnly schedules playback out', () => {
    const harness = buildHarness(viewerHandle.viewer);
    harness.playback.play();
    harness.playback.activeOnly = 'Never';
    registerSource(harness, 'PLC.A2', 25);
    bindAxis(harness, 'A2', 'PLC.A2');

    tick(harness.viewer, 2);
    expect(harness.playback.isPlaying).toBe(false);
    expect(harness.playback.boundDrives.every((drive) => drive?.positionOverwrite === false)).toBe(true);
  });

  it('accepts live zero, latches the last position on disconnect, and lets force-zero release the latch', () => {
    const harness = buildHarness(viewerHandle.viewer);
    registerSource(harness, 'PLC.A2', 0);
    bindAxis(harness, 'A2', 'PLC.A2');
    tick(harness.viewer, 2);
    expect(axis(harness, 'A2').currentPosition).toBe(0);

    harness.store.set('PLC.A2', 27);
    tick(harness.viewer);
    expect(axis(harness, 'A2').currentPosition).toBe(27);

    harness.store.setSignalProviderConnected({ interfaceId: 'plc' }, false);
    tick(harness.viewer);
    expect(harness.store.getFloat('A2.Position')).toBe(0);
    expect(axis(harness, 'A2').currentPosition).toBe(27);

    harness.store.forceSignal('A2.Position', 0);
    tick(harness.viewer);
    expect(axis(harness, 'A2').currentPosition).toBe(0);
  });

  it('rejects a replay edge during live control and keeps IsReplaying false', () => {
    const harness = buildHarness(viewerHandle.viewer);
    harness.store.register('StartLoading', 'Robot/StartLoading', false, 'PLCOutputBool');
    harness.store.register('IsReplaying', 'Robot/IsReplaying', false, 'PLCInputBool');
    harness.store.buildIndex();
    (harness.viewer as unknown as { replayRecordings: RVReplayRecording[] }).replayRecordings = [new RVReplayRecording(
      'Loading',
      'Robot/StartLoading',
      'Robot/IsReplaying',
      harness.playback,
      harness.store,
    )];

    harness.playback.play();
    harness.playback.activeOnly = 'Never';
    registerSource(harness, 'PLC.A2', 18);
    bindAxis(harness, 'A2', 'PLC.A2');
    tick(harness.viewer, 2);
    harness.store.setByPath('Robot/StartLoading', true);
    tick(harness.viewer);

    expect(harness.playback.isPlaying).toBe(false);
    expect(harness.playback.boundDrives.every((drive) => drive?.positionOverwrite === false)).toBe(true);
    expect(harness.store.getBoolByPath('Robot/IsReplaying')).toBe(false);
  });

  it('keeps TestAxesPlugin interleavings consistent for bind and unbind', () => {
    const harness = buildHarness(viewerHandle.viewer);
    const tester = new TestAxesPlugin();
    tester.onModelLoaded(harness.result, harness.viewer);

    tester.open();
    registerSource(harness, 'PLC.A2', 14);
    bindAxis(harness, 'A2', 'PLC.A2');
    tick(harness.viewer, 2);
    tester.close();
    tick(harness.viewer);
    expect(harness.playback.isPlaying).toBe(false);
    expect(harness.playback.boundDrives.every((drive) => drive?.positionOverwrite === false)).toBe(true);

    tester.open();
    harness.manager.unbind('A2', 'Position');
    tick(harness.viewer);
    tester.close();
    expect(axis(harness, 'A2').liveControlled).toBe(false);
    expect(harness.playback.play()).toBe(true);
    tester.onModelCleared();
  });

  it('normalizes glTF suffixes when selecting bare recorded axes', () => {
    const harness = buildHarness(viewerHandle.viewer, [
      { name: 'Pure', behaviorKey: 'Drive_1' },
      { name: 'Cylinder', behaviorKey: 'Drive_Cylinder_1' },
      { name: 'Gear', behaviorKey: 'Drive_Gear_2' },
    ]);

    expect(harness.registry.getAll('Drive_FollowPosition').map((entry) => entry.path))
      .toEqual(['Robot/Pure']);
    expect(harness.store.getAll().has('Pure.Position')).toBe(true);
    expect(harness.store.getAll().has('Cylinder.Position')).toBe(false);
    expect(harness.store.getAll().has('Gear.Position')).toBe(false);
  });

  it('loads the real demo with six follow axes and the existing gripper cylinder binding', async () => {
    disposeHarness();
    const viewer = viewerHandle.viewer;
    viewer.modelPluginManager ??= new ModelPluginManager();
    await viewer.loadModel('/demo-realvirtual/DemoRealvirtualWeb.glb');
    const playback = viewer.playback;
    const registry = viewer.registry;
    const store = viewer.signalStore;
    expect(playback?.boundDrives).toHaveLength(9);
    expect(registry).not.toBeNull();
    expect(store).not.toBeNull();
    if (!playback || !registry || !store) return;

    const followed = registry.getAll<{ node: Object3D }>('Drive_FollowPosition')
      .map((entry) => entry.instance.node.name)
      .sort();
    expect(followed).toEqual(['A1', 'A2', 'A3', 'A4', 'A5', 'A6']);

    const gripper = playback.boundDrives.find((drive) => drive?.name === 'SchunkEGH80Gripper');
    const left = playback.boundDrives.find((drive) => drive?.name === 'LeftFinger');
    const right = playback.boundDrives.find((drive) => drive?.name === 'RightFinger');
    expect(gripper?.node.userData.realvirtual.Drive_FollowPosition).toBeUndefined();
    expect(left?.node.userData.realvirtual.Drive_FollowPosition).toBeUndefined();
    expect(right?.node.userData.realvirtual.Drive_FollowPosition).toBeUndefined();
    expect(resolveBindableSlots(gripper!.node, store, registry))
      .toEqual(expect.arrayContaining([expect.objectContaining({ slot: 'Out' })]));
  }, 30_000);

  it('survives planner enter/exit idempotently and still releases playback in planner mode', async () => {
    disposeHarness();
    const viewer = viewerHandle.viewer;
    viewer.modelPluginManager ??= new ModelPluginManager();
    setContext('planner', false);
    await viewer.loadModel('/demo-realvirtual/DemoRealvirtualWeb.glb');
    const playback = viewer.playback!;
    const store = viewer.signalStore!;
    const registry = viewer.registry!;
    const manager = viewer.signalBindingManager!;
    const beforeSignals = [...store.getAll().keys()]
      .filter((name) => /^A[1-6]\.(Position|CurrentPosition)$/.test(name)).length;

    playback.play();
    setContext('planner', true);
    const a2 = playback.boundDrives.find((drive) => drive?.name === 'A2')!;
    store.register('PLC.PlannerA2', '__iface__/PLC.PlannerA2', 21, 'PLCOutputFloat');
    store.registerSignalProvider({ interfaceId: 'plc', signal: 'PLC.PlannerA2' }, true);
    manager.bind('planner-a2', a2.node, {
      slot: 'Position',
      signal: 'PLC.PlannerA2',
      interfaceId: 'plc',
      direction: 'plcOutput',
      enabled: true,
    });
    tick(viewer, 2);
    expect(playback.isPlaying).toBe(false);
    expect(playback.boundDrives.every((drive) => drive?.positionOverwrite === false)).toBe(true);

    setContext('planner', false);
    expect(registry.getAll('Drive_FollowPosition')).toHaveLength(6);
    expect([...store.getAll().keys()]
      .filter((name) => /^A[1-6]\.(Position|CurrentPosition)$/.test(name))).toHaveLength(beforeSignals);
  }, 30_000);

  it('is a no-op when a handled model has no recording', () => {
    const viewer = viewerHandle.viewer;
    const root = new Object3D();
    root.name = 'NoRecording';
    const node = new Object3D();
    node.name = 'A1';
    node.userData.realvirtual = { Drive: {} };
    root.add(node);
    const store = new SignalStore();
    const registry = new NodeRegistry();
    registry.registerNode('NoRecording/A1', node);
    const drive = new RVDrive(node);
    drive.Direction = DriveDirection.RotationZ;
    drive.initDrive();
    registry.register('Drive', 'NoRecording/A1', drive);
    const result = {
      root,
      drives: [drive],
      signalStore: store,
      registry,
      playback: null,
    } as unknown as LoadResult;
    const plugin = new RobotFollowPositionPlugin();

    expect(() => plugin.onModelLoaded(result, viewer)).not.toThrow();
    expect(registry.getAll('Drive_FollowPosition')).toHaveLength(0);
    expect(store.getAll().size).toBe(0);
    plugin.onModelCleared();
  });
});
