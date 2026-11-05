// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { afterEach, describe, expect, it, vi } from 'vitest';
import { Object3D } from 'three';
import { RVDrive } from '../../src/core/engine/rv-drive';
import { RVDriveGear } from '../../src/core/engine/rv-drive-gear';
import { RVDriveContinousDestination } from '../../src/core/engine/rv-drive-continous-destination';
import { RVReplayRecording } from '../../src/core/engine/rv-replay-recording';
import type { RVDrivesPlayback } from '../../src/core/engine/rv-drives-playback';
import type { ActiveOnly } from '../../src/core/engine/rv-active-only';
import { slotCommand, slotDeclare, slotUndeclare } from '../../src/core/engine/rv-slot-io';
import { NodeRegistry } from '../../src/core/engine/rv-node-registry';
import { RVLogicEngine } from '../../src/core/engine/rv-logic-engine';
import { RVSerialContainer, StepState } from '../../src/core/engine/rv-logic-step';
import type { ComponentContext } from '../../src/core/engine/rv-component-registry';
import { RVTransportManager } from '../../src/core/engine/rv-transport-manager';
import { setDriveSpeedOverride } from '../../src/core/engine/rv-speed-override';
import { getProblems } from '../../src/core/hmi/problems-store';
import { ACTION_INDEX, registerAction } from '../../src/plugins/des/rv-des-named-actions';
import { cycleRunnerFixture } from './cycle-runner-fixture';
import { addArrivedListener, resetCycleOwners } from '../../src/plugins/des/rv-des-core-takt';
import { PluginContextImpl } from '../../src/core/rv-plugin-context';
import type { RVViewer } from '../../src/core/rv-viewer';

afterEach(() => setDriveSpeedOverride(1));
const noop = ACTION_INDEX.get('Test.B1.Noop') ?? registerAction('Test.B1.Noop', () => {});
function movingDrive() {
  const node = new Object3D(); node.name = 'Axis';
  const drive = new RVDrive(node); drive.initDrive(); drive.TargetSpeed = 100;
  drive.Behaviors = ['test'];
  return drive;
}

function behaviorContext(w: ReturnType<typeof cycleRunnerFixture>, drives: RVDrive[]): ComponentContext {
  const registry = new NodeRegistry();
  for (const drive of drives) registry.register('Drive', NodeRegistry.computeNodePath(drive.node), drive);
  return { registry, signalStore: w.signalStore, scene: w.scene, root: w.scene, transportManager: new RVTransportManager() };
}

describe('DESRunner motion cycle integration', () => {
  it('wakes an idle unwired destination from a direct slot command at the next raster point', () => {
    const drive = movingDrive();
    const w = cycleRunnerFixture({ cycleTime: 0.01, host: { drives: [drive] } });
    const behavior = new RVDriveContinousDestination(drive.node);
    behavior.init(behaviorContext(w, [drive]));
    w.start(); w.runner.step();
    expect(w.pending()).toHaveLength(0);
    w.manager.processAnimated(0.015);
    const version = w.signalStore.version;
    slotCommand(behavior, 'SignalDestination', 1);
    expect(behavior.Destination).toBe(1); expect(drive.isRunning).toBe(false);
    expect(w.signalStore.version).toBe(version);
    expect(w.pending()).toHaveLength(1); expect(w.pending()[0].time).toBe(0.02);
    w.runner.step(); expect(drive.isRunning).toBe(true);
    for (let n = 0; w.pending().length && n < 100; n++) w.runner.step();
    expect(drive.currentPosition).toBe(1); expect(w.pending()).toHaveLength(0);
    slotCommand(behavior, 'SignalDestination', 1);
    expect(w.pending()).toHaveLength(1); w.runner.step(); expect(w.pending()).toHaveLength(0);
    behavior.dispose();
  });

  it('subscribes to direct slot commands only while a cycle is installed', () => {
    const w = cycleRunnerFixture(); const slot = {};
    slotDeclare(slot, 'command', 'poll');
    try {
      w.start();
      const initial = w.manager.nextEventId;
      slotCommand(slot, 'command', 1); expect(w.manager.nextEventId).toBe(initial);
      const off = w.runner.simEvents.registerCycleParticipant('idle', 0, { step: () => {}, alive: () => false });
      w.runner.step(); expect(w.pending()).toHaveLength(0);
      slotCommand(slot, 'command', 2); expect(w.pending()).toHaveLength(1);
      off(); expect(w.runner.cycleMode).toBe(false);
      const detached = w.manager.nextEventId;
      slotCommand(slot, 'command', 3); expect(w.manager.nextEventId).toBe(detached);
      w.runner.simEvents.registerCycleParticipant('idle', 0, { step: () => {}, alive: () => false });
      w.runner.dispose();
      const disposed = w.manager.nextEventId;
      slotCommand(slot, 'command', 4); expect(w.manager.nextEventId).toBe(disposed);
    } finally { slotUndeclare(slot); }
  });

  it.each([false, true])('probes connection changes while connection-gated logic is idle (initial=%s)', initial => {
    const w = cycleRunnerFixture({ cycleTime: 0.01, host: { isConnected: initial } });
    const node = new Object3D(); node.name = 'Sequence'; w.scene.add(node);
    node.userData.realvirtual = { LogicStep_SerialContainer: { Active: initial ? 'Disconnected' : 'Connected' } };
    const delay = new Object3D(); delay.name = 'Delay'; node.add(delay);
    delay.userData.realvirtual = { LogicStep_Delay: { Duration: 100 } };
    const registry = new NodeRegistry();
    w.scene.traverse(n => registry.registerNode(NodeRegistry.computeNodePath(n), n));
    const engine = RVLogicEngine.build(w.scene, registry, w.signalStore);
    (engine.roots[0] as RVSerialContainer).autoLoop = false;
    w.host.logicEngine = engine; engine.start(initial);
    const updateConnection = vi.spyOn(engine, 'updateConnection');
    const fixedUpdate = vi.spyOn(engine, 'fixedUpdate');
    w.start(); w.manager.processAnimated(0); expect(w.pending()).toHaveLength(0);
    updateConnection.mockClear(); fixedUpdate.mockClear();
    w.runner.tick(0.01); expect(w.pending()).toHaveLength(0);
    w.host.isConnected = !initial;
    w.runner.earlyTick(0.01); w.runner.tick(0.01); w.runner.tick(0.01);
    expect(updateConnection).not.toHaveBeenCalled(); expect(w.pending()).toHaveLength(1);
    expect(w.pending()[0].time).toBe(0.01);
    expect(w.pending('Core.Settle').map(e => e.time)).toEqual([0]);
    w.runner.step();
    expect(updateConnection).toHaveBeenCalledWith(!initial); expect(fixedUpdate).toHaveBeenCalledTimes(2);
    expect(engine.isRunning()).toBe(true); expect(w.pending()).toHaveLength(1);
    w.runner.step(); expect(w.pending()).toHaveLength(0);
    w.host.isConnected = initial; w.runner.tick(0.01); w.runner.step(); w.runner.step();
    expect(engine.isRunning()).toBe(false); expect(engine.roots[0].state).toBe(StepState.Idle);
    expect(w.pending()).toHaveLength(0);
    w.runner.tick(0.01); expect(w.pending()).toHaveLength(0);
  });

  it('drains a Never-active replay waiting on a start signal without leaving Core.Cycle', async () => {
    const w = cycleRunnerFixture({ cycleTime: 0.01, end: 1 });
    w.signalStore.register('start', 'start', true, 'PLCOutputBool');
    const playSequence = vi.fn(() => true);
    const replay = new RVReplayRecording('sequence', 'start', null,
      { playSequence, isPlaying: false } as unknown as RVDrivesPlayback, w.signalStore);
    replay.activeOnly = 'Never';
    Object.assign(w.host, { replayRecordings: [replay] });
    w.start(); expect(w.runner.cycleMode).toBe(true); expect(replay.waitingForStart).toBe(true);
    w.runner.step(); expect(w.pending()).toHaveLength(0);
    expect(await w.runner.runFastForward()).toBe(true);
    expect(w.pending()).toHaveLength(0); expect(playSequence).not.toHaveBeenCalled();
  });

  it.each([
    ['Never', false, false], ['Connected', false, false], ['Disconnected', true, false],
    ['Connected', true, true], ['Disconnected', false, true], ['Always', false, true], ['DontChange', true, true],
  ] as const)('gates playback and replay liveness for %s (connected=%s)', (activeOnly: ActiveOnly, isConnected, alive) => {
    for (const owner of ['playback', 'replay'] as const) {
      const update = vi.fn();
      const w = cycleRunnerFixture({ host: { isConnected,
        ...(owner === 'playback'
          ? { playback: { activeOnly, isPlaying: true, hasPendingWork: true, syncLiveControl: () => {}, update } }
          : { replayRecordings: [{ activeOnly, isActive: true, waitingForStart: true, fixedUpdate: update }] }),
      } });
      w.start(); w.runner.step();
      expect(w.pending()).toHaveLength(alive ? 1 : 0);
      expect(update).toHaveBeenCalledTimes(alive ? 1 : 0);
    }
  });

  it('re-arms a disarmed cycle inside fast-forward when an action starts motion at t=1', async () => {
    const drive = movingDrive();
    const w = cycleRunnerFixture({ cycleTime: 0.01, end: 2, host: { drives: [drive] } });
    w.start(); w.runner.step();
    expect(w.pending()).toHaveLength(0);
    const action = ACTION_INDEX.get('Test.F.StartMotion') ?? registerAction('Test.F.StartMotion', ctx => {
      (ctx.data as RVDrive).startMove(10);
    }, 'non-persistent');
    w.manager.scheduleEventByIndex(1, action, -1, -1, 0, drive);
    expect(await w.runner.runFastForward()).toBe(true);
    expect(drive.currentPosition).toBe(10);
    expect(drive.isRunning).toBe(false);
    expect(w.pending()).toHaveLength(0);
  });

  it.each([1, 0.005])('probes an idle authored destination and publishes final feedback (destination=%s)', destination => {
    const drive = movingDrive();
    const w = cycleRunnerFixture({ cycleTime: 0.01, host: { drives: [drive] } });
    const behavior = new RVDriveContinousDestination(drive.node);
    behavior.Destination = destination;
    behavior.SignalIsAtPosition = 'position'; behavior.SignalIsDriving = 'driving';
    w.signalStore.register('position', 'position', 0, 'PLCInputFloat');
    w.signalStore.register('driving', 'driving', false, 'PLCInputBool');
    behavior.init(behaviorContext(w, [drive]));
    expect(drive.isRunning).toBe(false);
    w.start();
    expect(w.pending()).toHaveLength(1); expect(w.pending()[0].time).toBe(0);
    w.runner.step(); expect(drive.isRunning).toBe(destination === 1);
    let steps = 1;
    while (drive.isRunning && steps++ < 100) w.runner.step();
    expect(steps).toBeLessThan(100);
    expect(drive.currentPosition).toBe(destination); expect(drive.isRunning).toBe(false);
    expect(w.signalStore.get('position')).toBeLessThan(destination); expect(w.signalStore.get('driving')).toBe(true);
    expect(w.pending()).toHaveLength(1); const stoppedAt = w.manager.currentTime;
    w.runner.step(); expect(w.manager.currentTime).toBeCloseTo(stoppedAt + 0.01, 12);
    expect(w.signalStore.get('position')).toBe(destination); expect(w.signalStore.get('driving')).toBe(false);
    expect(w.pending()).toHaveLength(0);
    behavior.dispose();
  });

  it('schedules exactly one idle probe on start and reset', async () => {
    const drive = movingDrive(); const update = vi.spyOn(drive, 'update');
    const w = cycleRunnerFixture({ cycleTime: 0.01, host: { drives: [drive] } });
    w.start();
    w.runner.step(); expect(update).toHaveBeenCalledOnce(); expect(w.pending()).toHaveLength(0);
    w.runner.reset(); await w.runner.whenCycleOwnersReady();
    expect(w.pending()).toHaveLength(1); expect(w.pending()[0].time).toBe(0);
    w.runner.step(); expect(update).toHaveBeenCalledTimes(2); expect(w.pending()).toHaveLength(0);
  });

  it.each(['takt', 'des-master', 'des-pair', 'external'])('updates gear followers on their master clock (%s)', owner => {
    const taktMaster = owner === 'takt';
    const master = movingDrive(); master.node.name = 'Master';
    const slave = movingDrive(); slave.node.name = 'Slave';
    slave.node.userData.realvirtual = { Drive_Gear: {} };
    slave.Behaviors = ['Drive_Gear'];
    const w = cycleRunnerFixture({ cycleTime: 0.01, host: {
      drives: owner === 'external' ? [slave] : [master, slave], ikPaths: [{ fixedUpdate: () => {} }],
    } });
    const gear = new RVDriveGear(slave.node); gear.MasterDrive = master; gear.GearFactor = 2;
    gear.init(behaviorContext(w, [master, slave]));
    if (!taktMaster) {
      master.Behaviors = [];
      if (owner !== 'external') vi.spyOn(w.runner as unknown as { collectDrives(): RVDrive[] }, 'collectDrives')
        .mockReturnValue(owner === 'des-pair' ? [master, slave] : [master]);
    } else master.startMove(10);
    const update = vi.spyOn(slave, 'update');
    w.start();
    if (!taktMaster) master.currentPosition = 3; // DES tween / external seek.
    w.runner.tick(0.01);
    expect(update).toHaveBeenCalledTimes(taktMaster ? 0 : 1);
    if (!taktMaster) expect(slave.currentPosition).toBe(6);
    update.mockClear(); w.runner.step();
    expect(update).toHaveBeenCalledTimes(taktMaster ? 1 : 0);
    expect(slave.currentPosition).toBe(master.currentPosition * 2);
    expect(slave.isRunning).toBe(false);
    expect(w.host.snapshotBlockers.reasons().some(r => r.includes('tick ownership conflict'))).toBe(false);
  });

  it('preserves startup motion across direct resets and replication restarts', async () => {
    const drive = movingDrive();
    const w = cycleRunnerFixture({ host: { drives: [drive] } });
    const setup = vi.fn(() => drive.startMove(100));
    w.runner.setScriptBindingTarget({ bindDes: setup, unbindDes: () => {} });
    w.start();
    const resetOwner = vi.spyOn(drive, 'reset');
    for (let run = 0; run < 2; run++) {
      w.runner.step();
      w.runner.reset();
      await w.runner.whenCycleOwnersReady();
      expect(drive.isRunning).toBe(true);
      expect(drive.targetPosition).toBe(100);
      expect(w.pending()).toHaveLength(1);
      expect(w.runner.step()).toBe(true);
      expect(drive.currentPosition).toBeGreaterThan(0);
    }
    expect(setup).toHaveBeenCalledTimes(3);
    expect(resetOwner).toHaveBeenCalledTimes(2);
  });

  it('does not reset core owners twice during a viewer reset', async () => {
    const drive = movingDrive();
    const w = cycleRunnerFixture({ host: { drives: [drive] } });
    w.runner.setScriptBindingTarget({ bindDes: () => drive.startMove(100), unbindDes: () => {} });
    w.start();
    const resetOwner = vi.spyOn(drive, 'reset');
    const host = w.host as typeof w.host & { inViewerReset: boolean };
    host.inViewerReset = true;
    resetCycleOwners(w.core!.desHost, () => true);
    w.runner.reset();
    await w.runner.whenCycleOwnersReady();
    expect(resetOwner).toHaveBeenCalledOnce();
    expect(drive.isRunning).toBe(true);
    expect(drive.targetPosition).toBe(100);
    expect(w.pending()).toHaveLength(1);
  });

  it('blocks events until async reset hooks finish, then re-evaluates owners', async () => {
    const drive = movingDrive();
    const w = cycleRunnerFixture({ host: { drives: [drive] } });
    w.runner.setScriptBindingTarget({ bindDes: () => drive.startMove(100), unbindDes: () => {} });
    w.start();
    let finish!: () => void;
    w.runner.simEvents.registerResetHook('async', () => new Promise<void>(resolve => { finish = resolve; }));
    w.runner.reset();
    expect(w.runner.step()).toBe(false);
    expect(w.manager.totalEventsProcessed).toBe(0);
    finish();
    await w.runner.whenCycleOwnersReady();
    expect(drive.isRunning).toBe(true);
    expect(w.pending()).toHaveLength(1);
    expect(w.runner.step()).toBe(true);
  });

  it('leaves queue ids and snapshots unchanged with only plain drives', () => {
    const drive = movingDrive(); drive.Behaviors = [];
    const a = cycleRunnerFixture({ host: { drives: [drive] } });
    const b = cycleRunnerFixture({ core: false });
    a.start(); b.start();
    expect(a.runner.cycleMode).toBe(false);
    expect(a.manager.onPostDispatch).toBeNull();
    expect(a.pending()).toEqual([]); expect(a.pending('Core.Settle')).toEqual([]);
    const snap = a.runner.fullSnapshot();
    expect(snap.parts.some(p => p.key === 'core.cycle' || p.key === 'core.settle')).toBe(false);
    expect(a.manager.scheduleEventByIndex(1, noop, -1)).toBe(b.manager.scheduleEventByIndex(1, noop, -1));
    expect(a.manager.exportQueue(() => '', () => null)).toEqual(b.manager.exportQueue(() => '', () => null));
  });

  it('runs IK then behavior drives at k*CycleTime, with no render motion and neutral speed', () => {
    const drive = movingDrive(); drive.startMove(3);
    const motion = vi.fn();
    const w = cycleRunnerFixture({ cycleTime: 0.01, host: { drives: [drive], ikPaths: [{ fixedUpdate: motion }] } });
    w.start(); setDriveSpeedOverride(2);
    const arrived = vi.fn(); addArrivedListener(w.core!.desHost, arrived);
    w.runner.earlyTick(0.7); w.runner.tick(0.7);
    expect(motion).not.toHaveBeenCalled(); expect(drive.currentPosition).toBe(0);
    expect(w.runner.simEvents.cycleTime).toBe(0.01);
    const times: number[] = [];
    while (w.pending().length && times.length < 10) {
      expect(w.runner.step()).toBe(true); times.push(w.manager.currentTime);
    }
    expect(times.length).toBeGreaterThanOrEqual(3);
    expect(times).toEqual(times.map((_, k) => k * 0.01));
    expect(motion.mock.calls.every(([dt]) => dt === 0.01)).toBe(true);
    expect(drive.currentPosition).toBe(3); expect(arrived).toHaveBeenCalledOnce();
    expect(w.pending()).toHaveLength(0);
  });

  it('moves by CT*speed rather than twice that distance at override 2', () => {
    const drive = movingDrive(); drive.startMove(1000);
    const w = cycleRunnerFixture({ cycleTime: 0.01, host: { drives: [drive] } });
    w.start(); setDriveSpeedOverride(2); w.runner.step();
    expect(drive.currentPosition).toBeCloseTo(1, 12);
  });

  it('re-arms after a signal write on max(lastK+1, ceil(now/CT))', () => {
    const motion = vi.fn();
    const w = cycleRunnerFixture({ cycleTime: 0.01, host: { ikPaths: [{ fixedUpdate: motion }] } });
    w.start(); w.runner.step(); expect(w.pending()).toHaveLength(0);
    w.signalStore.set('trigger', true, 0); expect(w.pending()).toHaveLength(1);
    w.runner.step(); expect(w.pending()).toHaveLength(0);
    w.signalStore.set('trigger', false, 0); expect(w.pending()[0].time).toBe(0.02);
    w.runner.step();
    w.manager.processAnimated(0.015);
    w.signalStore.set('trigger', true, 0); expect(w.pending()[0].time).toBe(0.04);
    w.signalStore.set('other', true, 0); expect(w.pending()).toHaveLength(1);
  });

  it('retains exactly one handle when the last cycle owner is removed and re-added', () => {
    const w = cycleRunnerFixture(); w.start();
    const owner = { step: vi.fn(), alive: () => true };
    const off = w.runner.simEvents.registerCycleParticipant('plugin', 60, owner);
    w.runner.step(); expect(w.pending()).toHaveLength(1);
    off(); expect(w.pending()).toHaveLength(0);
    w.runner.simEvents.registerCycleParticipant('plugin', 60, owner);
    off(); expect(w.pending()).toHaveLength(1);
    expect(w.pending()[0].time).toBe(1 / 60);
  });

  it('keeps an IK pending signal release alive after motion ends', () => {
    const ik = { PathIsActive: true, hasPendingWork: false, fixedUpdate: vi.fn(() => {
      if (ik.hasPendingWork) { ik.hasPendingWork = false; w.signalStore.set('done', false, 0); }
      else if (ik.PathIsActive) { ik.PathIsActive = false; ik.hasPendingWork = true; w.signalStore.set('done', true, 0); }
    }) };
    const w = cycleRunnerFixture({ host: { ikPaths: [ik] } }); w.start();
    w.runner.step(); expect(w.pending()).toHaveLength(1); expect(w.signalStore.get('done')).toBe(true);
    w.runner.step(); expect(w.pending()).toHaveLength(1); expect(w.signalStore.get('done')).toBe(false);
    w.runner.step(); expect(w.pending()).toHaveLength(0); expect(w.signalStore.get('done')).toBe(false);
  });

  it('reports and blocks a DES-owned drive with a second behavior or IK owner', () => {
    const drive = movingDrive();
    const w = cycleRunnerFixture({ host: { drives: [drive] } });
    // A minimal adapter supplies the same DES ownership list as bound material-flow adapters.
    vi.spyOn(w.runner as unknown as { collectDrives(): RVDrive[] }, 'collectDrives').mockReturnValue([drive]);
    w.start();
    expect(getProblems().some(p => p.code === 'des-tick-ownership-conflict')).toBe(true);
    expect(w.host.snapshotBlockers.reasons()).toContain('des.tick-ownership: tick ownership conflict: #Axis');
    expect(() => w.runner.fullSnapshot()).toThrow(/tick ownership conflict/);
  });

  it('keeps pre-start registrations and captures declared takt drive state', () => {
    const drive = movingDrive();
    const w = cycleRunnerFixture({ host: { drives: [drive] } });
    const step = vi.fn();
    w.runner.simEvents.registerCycleParticipant('plugin', 10, { step, alive: () => true });
    w.runner.simEvents.registerEventParticipant('event', 0, { readSet: () => [], settle: () => false, dueTime: () => null });
    expect(w.runner.simEvents.isEventDriven()).toBe(false); w.start();
    expect(w.runner.simEvents.isEventDriven()).toBe(true); w.runner.step();
    expect(step).toHaveBeenCalledWith(1 / 60);
    const parts = w.runner.fullSnapshot().parts;
    expect(parts.map(p => p.key)).toEqual(expect.arrayContaining(['core.cycle', 'core.settle']));
    drive.currentPosition = 5;
    expect(w.runner.fullSnapshot().parts.find(p => p.key === 'des.drives')).toMatchObject({
      version: 2, state: [{ id: '#Axis', kind: 'takt', drive: { currentPosition: 5 } }],
    });
  });

  it('re-arms motion started by the UI, and re-evaluates owner presence on rebind', () => {
    const drive = movingDrive();
    const w = cycleRunnerFixture({ host: { drives: [drive] } }); w.start();
    w.runner.step();
    expect(w.pending()).toHaveLength(0);
    drive.startMove(100); w.runner.tick(0.5); expect(w.pending()).toHaveLength(1);
    w.host.drives = []; w.runner.rebindScene();
    expect(w.runner.cycleMode).toBe(false); expect(w.pending()).toHaveLength(0);
    expect(w.manager.onPostDispatch).toBeNull();
    w.host.drives = [drive]; w.runner.rebindScene();
    expect(w.runner.cycleMode).toBe(true); expect(w.pending()).toHaveLength(1);
  });

  it('does not leave an orphan event when the last participant unregisters during its own cycle', () => {
    const drive = movingDrive(); drive.Behaviors = []; drive.startMove(100);
    const w = cycleRunnerFixture({ host: { drives: [drive] } }); w.start();
    let off = () => {};
    off = w.runner.simEvents.registerCycleParticipant('self', 0, { step: () => off(), alive: () => true });
    w.runner.step(); expect(w.runner.cycleMode).toBe(false); expect(w.pending()).toHaveLength(0);
  });

  it('exposes the active DES executor facade through a live plugin-context getter', () => {
    const a = cycleRunnerFixture(), b = cycleRunnerFixture();
    const kernel = { mode: 'continuous', activeExecutor: a.runner };
    const viewer = { simulationKernel: kernel };
    const context = new PluginContextImpl(viewer as unknown as RVViewer);
    expect(context.simEvents).toBeNull(); kernel.mode = 'des';
    expect(context.simEvents).toBe(a.runner.simEvents);
    kernel.activeExecutor = b.runner; expect(context.simEvents).toBe(b.runner.simEvents);
    kernel.mode = 'continuous'; expect(context.simEvents).toBeNull();
  });
});
