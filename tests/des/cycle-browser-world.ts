// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { Object3D, Vector3 } from 'three';
import { createTestViewer } from '../helpers/create-test-viewer';
import { testAddressRegistry } from '../helpers/test-address-registry';
import { RVDrive } from '../../src/core/engine/rv-drive';
import { RVDriveDestinationMotor } from '../../src/core/engine/rv-drive-destination-motor';
import { RVSceneButtonBase } from '../../src/core/engine/rv-scene-button-base';
import { RVMovingUnit } from '../../src/core/engine/rv-mu';
import { NodeRegistry } from '../../src/core/engine/rv-node-registry';
import { SignalStore } from '../../src/core/engine/rv-signal-store';
import type { CoreSubsystems } from '../../src/core/engine/rv-core-subsystems';
import type { ComponentContext } from '../../src/core/engine/rv-component-registry';
import { createBindContext } from '../../src/core/behavior-runtime';
import { createSelf, type MaterialFlowSelf } from '../../src/core/material-flow/material-flow-self';
import { defineMaterialFlow, type MaterialFlowDefinition } from '../../src/core/material-flow/define-material-flow';
import { schedulePositionMove } from '../../src/behaviors/_shared/drive-des';
import { DESRunner } from '../../src/plugins/des/des-runner';
import type { MaterialFlowAdapter } from '../../src/plugins/des/material-flow-adapter';
import { resetDESMUCounter, type DESMU } from '../../src/plugins/des/rv-des-mu';
import { __resetDesRunSettingsForTest } from '../../src/core/hmi/des-run-settings-store';

export const END = 30;
export const MODES = ['animated', 'hybrid2', 'hybrid10', 'fastforward', 'step', 'batch', 'switches'] as const;
export type CycleTestMode = typeof MODES[number];

const source = defineMaterialFlow<MaterialFlowSelf>({
  type: 'CycleTestSource', kind: 'source', schema: {}, continuous: {},
  des: { onGenerate(self) { self.transfer(self.spawn()); self.in(40, 'Generate', null); } },
});
const station = defineMaterialFlow<MaterialFlowSelf>({
  type: 'CycleTestStation', kind: 'station', schema: {}, continuous: {},
  des: {
    onAccept(self, mu) {
      schedulePositionMove(self, { target: mu.visual, from: [0, 0, 0], to: [30, 0, 0], time: 30 }, 'ProcessComplete', mu);
      return true;
    },
    onProcessComplete(self, mu) {
      schedulePositionMove(self, { target: mu.visual, from: [30, 0, 0], to: [40, 0, 0], time: 10 }, 'Arrival', mu);
    },
    onArrival(self, mu) { if (mu) self.transfer(mu); },
  },
});
const sink = defineMaterialFlow<MaterialFlowSelf>({
  type: 'CycleTestSink', kind: 'sink', schema: {}, continuous: {}, des: { onAccept() { return true; } },
});
const definitions = [source, station, sink] as MaterialFlowDefinition[];

/** Real browser viewer/core/components, with a small code-built DES line. */
export async function cycleBrowserWorld(options: { seed?: number; controls?: boolean; consumer?: boolean; flow?: boolean } = {}) {
  __resetDesRunSettingsForTest();
  resetDESMUCounter();
  const handle = await createTestViewer('webgl');
  try { return await buildWorld(handle, options); }
  catch (error) { handle.dispose(); throw error; }
}

async function buildWorld(handle: Awaited<ReturnType<typeof createTestViewer>>,
  options: { seed?: number; controls?: boolean; consumer?: boolean; flow?: boolean }) {
  const viewer = handle.viewer;
  viewer.loop.stop();
  const root = new Object3D(); root.name = 'CycleWorld'; viewer.scene.add(root);
  const node = (name: string) => { const n = new Object3D(); n.name = name; root.add(n); return n; };
  node('Simulation').userData.realvirtual = { DESManager: { EndTime: END, CycleTime: 0.1 } };
  const store = new SignalStore(); viewer.signalStore = store; viewer.registry = new NodeRegistry();
  const core = (viewer as unknown as { _coreSubsystems: CoreSubsystems })._coreSubsystems;
  const runner = new DESRunner({ core, subMode: 'animated', masterSeed: options.seed ?? 42, durationSeconds: END });
  const manager = runner.getManager();
  const axisNode = node('Axis'), buttonNode = node('Button');
  const drive = new RVDrive(axisNode); drive.TargetSpeed = 100; drive.initDrive();
  const controls = options.controls !== false;
  const motor = new RVDriveDestinationMotor(axisNode);
  const button = new RVSceneButtonBase(buttonNode);
  const samples: Array<{ t: number; pose: number[] }> = [];
  const initial = () => ({ initialized: false, due: 0.75, count: 0, pressed: false,
    edges: [] as Array<{ t: number; value: boolean }>, targets: [] as number[] });
  let state = initial(), inputsApplied = false;
  const signalDefaults = { destination: 0, start: false, speed: 100, pressed: false };
  for (const [name, value] of Object.entries(signalDefaults))
    store.register(name, `Signals/${name}`, value, typeof value === 'boolean' ? 'PLCOutputBool' : 'PLCOutputFloat');
  const context = { signalStore: store, registry: viewer.registry,
    sceneButtonManager: viewer.sceneButtonManager, reapply: viewer.signalReapply } as ComponentContext;
  if (controls) {
    drive.Behaviors = ['Drive_DestinationMotor']; viewer.drives.push(drive);
    viewer.registry.register('Drive', NodeRegistry.computeNodePath(axisNode), drive);
    motor.Destination = 'Signals/destination'; motor.StartDrive = 'Signals/start'; motor.TargetSpeed = 'Signals/speed';
    motor.init(context);
    button.init(context); button.setStateSignal('Signals/pressed'); button.simpleClickTime = 0.35;
    runner.simEvents.registerEventParticipant('test.due-loop', 10, {
      readSet: () => ['pressed'],
      settle(t, image) {
        let changed = false;
        const pressed = image.get('pressed') === true;
        if (pressed !== state.pressed) {
          state.pressed = pressed; state.edges.push({ t, value: pressed }); changed = true;
        }
        if (!state.initialized || t >= state.due) {
          if (state.initialized) { state.count++; state.due = (state.count + 1) * 0.75; }
          state.initialized = true;
          const target = 25 + Math.floor(manager.rng.next() * 75);
          state.targets.push(target);
          store.set('start', false);
          store.setMany({ destination: target, start: true });
          changed = true;
        }
        return changed;
      },
      dueTime: () => state.due,
    });
  }
  const adapters: MaterialFlowAdapter[] = [];
  const host = {
    signalStore: store, registry: null, drives: viewer.drives, snapshotBlockers: viewer.snapshotBlockers,
    contextMenu: viewer.contextMenu, on: () => () => {}, getPlugin: () => undefined,
    desAddresses: testAddressRegistry(root),
  };
  const makeVisual = () => {
    const n = new Object3D(); n.name = 'MovingMU'; viewer.scene.add(n);
    return new RVMovingUnit(n, 'CycleTestSource', new Vector3(0.1, 0.1, 0.1));
  };
  runner.registerMuVisualFactory('cycle-test-mu', makeVisual, visual => visual.dispose());
  const activeDefinitions = options.flow === false ? [] : definitions;
  for (const [i, def] of activeDefinitions.entries()) {
    const n = node(['Source', 'Station', 'Sink'][i]);
    const { ctx } = createBindContext(n, host, {});
    const self = createSelf(ctx, def, {
      mode: 'des', scheduler: runner.makeScheduler(def, () => adapters[i].entityId),
      onTransfer: mu => runner.makeTransfer(adapters[i])(mu),
      canAcceptDownstream: mu => adapters[i].nextComponents.some(c => c.canAccept(mu as never)),
      spawnMU: () => {
        const mu = runner.createMU(); mu.visual = makeVisual(); mu.visualTemplateId = 'cycle-test-mu'; return mu;
      },
    });
    adapters.push(runner.addInstance(def, self, n, undefined, { desId: `#${n.name}@${def.type}` }));
  }
  for (let i = 0; i < adapters.length - 1; i++) {
    adapters[i].nextComponents = [adapters[i + 1]]; adapters[i + 1].previousComponents = [adapters[i]];
  }
  const poses = () => {
    const result: Array<{ id: number; pose: number[]; quaternion: number[] }> = [];
    for (let i = 0; i < manager.muCount; i++) {
      const mu = manager.getMU(i) as DESMU | null;
      if (mu && !mu.retired && mu.visual) result.push({ id: mu.id,
        pose: mu.visual.node.position.toArray(), quaternion: mu.visual.node.quaternion.toArray() });
    }
    return result;
  };
  if (options.consumer !== false) runner.simEvents.registerCycleParticipant('test.pose-reader', 80, {
    step() { samples.push({ t: manager.currentTime, pose: poses()[0]?.pose ?? [] }); }, alive: () => true,
  });
  runner.simEvents.registerResetHook('test.state', async () => {
    await Promise.resolve();
    state = initial(); inputsApplied = false; samples.length = 0;
    if (controls) store.setMany({ destination: 0, start: false, speed: 100 });
  });
  runner.start(activeDefinitions, { root, host });
  await runner.kpiSourcesReady();

  const frame = (dt: number) => { runner.earlyTick(dt); runner.tick(dt); runner.lateTick(dt); };
  const timed = (to: number, multiplier: number) => {
    runner.setSubMode(multiplier === 1 ? 'animated' : 'hybrid'); runner.setMultiplier(multiplier);
    for (let guard = 0; runner.renderClock < to && guard < 10000; guard++)
      frame(Math.min(0.125, (to - runner.renderClock) / multiplier));
    if (runner.renderClock !== to) throw new Error(`Timed run stopped at ${runner.renderClock}, expected ${to}`);
  };
  return {
    runner, manager, samples, store, drive, button,
    async advance(mode: CycleTestMode, to = END) {
      await runner.whenCycleOwnersReady(); await runner.kpiSourcesReady();
      if (!inputsApplied) { inputsApplied = true; if (controls) button.click(); }
      if (mode === 'animated' || mode === 'hybrid2' || mode === 'hybrid10') {
        timed(to, mode === 'animated' ? 1 : mode === 'hybrid2' ? 2 : 10);
      } else if (mode === 'batch') {
        // Experiment host.fastForward delegates to this runBatch-backed drain.
        if (!await runner.runFastForward()) throw new Error(`Batch drain failed: ${String(runner.lastFfError)}`);
      } else if (mode === 'fastforward') {
        runner.setSubMode('fastforward');
        for (let guard = 0; !manager.isComplete && guard < 10000; guard++) frame(1 / 60);
      } else if (mode === 'step') {
        runner.setSubMode('step');
        for (let guard = 0; !manager.isComplete && guard < 10000; guard++)
          if (!runner.step()) throw new Error('Step stalled');
      } else {
        timed(5, 1); timed(10, 2); timed(15, 10);
        if (!await runner.runFastForward({ untilSimTime: 20 })) throw new Error('FF switch failed');
        runner.setSubMode('step'); manager.resume();
        while (manager.nextModelEventTime <= 25) if (!runner.step()) throw new Error('Switch step stalled');
        timed(to, 1);
      }
      if (runner.lastFfError) throw runner.lastFfError;
    },
    projection: () => ({ simTime: manager.currentTime, eventCount: manager.totalEventsProcessed,
      drives: controls ? [{ position: drive.currentPosition, target: drive.targetPosition, speed: drive.currentSpeed }] : [],
      signals: Object.fromEntries(Object.keys(signalDefaults).map(name => [name, store.get(name)])),
      participant: structuredClone(state), button: { active: button.active, remaining: button.timerRemaining },
      muPoses: poses(), samples: structuredClone(samples) }),
    // Batch beginRun sets its slot and calls runner.reset(); finite settings are fixed in this world.
    async beginRun(seed = options.seed ?? 42) {
      runner.setMasterSeed(seed); runner.reset(); await runner.whenCycleOwnersReady();
    },
    dispose() {
      try { runner.dispose(); }
      finally {
        try { motor.dispose(); button.dispose(); }
        finally { handle.dispose(); }
      }
    },
  };
}
