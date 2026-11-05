// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { afterEach, describe, expect, it, vi } from 'vitest';
import { SignalStore } from '../../src/core/engine/rv-signal-store';
import { getDriveSpeedOverride, scaleSimDt, setDriveSpeedOverride } from '../../src/core/engine/rv-speed-override';
import { DESManager } from '../../src/plugins/des/rv-des-manager';
import { CycleController, cycleSnapshotParticipant, CYCLE_PRIORITY, type CycleHost } from '../../src/plugins/des/rv-des-cycle';
import { SettleController, settleSnapshotParticipant } from '../../src/plugins/des/rv-des-settle';
import { SnapshotRegistry } from '../../src/plugins/des/rv-snapshot-registry';
import { createCaptureSession, toSnapshotData } from '../../src/plugins/des/rv-snapshot-contract';
import { DESEventQueue } from '../../src/plugins/des/rv-des-event-queue';
import { ACTION_INDEX, ACTION_SCHEMA, getActionSchema } from '../../src/plugins/des/rv-des-named-actions';
import { preflightSnapshot } from '../../src/plugins/des/rv-des-preflight';
import { cycleRunnerFixture } from './cycle-runner-fixture';

describe('runner cycle reset', () => {
  it('cold resets core motion owners and reapplies signals before startup, then awaits async hooks', async () => {
    const log: string[] = [];
    const drive = { reset: () => log.push('drive'), update: () => {}, Behaviors: ['test'],
      driveBehaviors: [],
      isRunning: false, positionOverwrite: false, jogForward: false, jogBackward: false, isTransportSurface: false };
    const w = cycleRunnerFixture({ host: {
      drives: [drive as unknown as import('../../src/core/engine/rv-drive').RVDrive],
      logicEngine: { roots: [{}], activeOnly: 'Always', isStarted: true, fixedUpdate: () => {},
        reset: () => log.push('logic'), resetOwnedOutputs: () => log.push('outputs'), start: () => log.push('start') },
      ikPaths: [{ reset: () => log.push('ik'), fixedUpdate: () => {} }],
      replayRecordings: [{ activeOnly: 'Always', reset: () => log.push('replay'), fixedUpdate: () => {} }],
      playback: { activeOnly: 'Always', isPlaying: false, syncLiveControl: () => {}, update: () => {}, stop: () => log.push('playback') },
      signalReapply: { reapplyAll: () => { log.push('reapply'); } },
    } });
    w.runner.setScriptBindingTarget({ bindDes: () => { log.push('setup'); }, unbindDes: () => {} });
    w.runner.simEvents.registerResetHook('plugin', async () => { log.push('plugin'); await Promise.resolve(); log.push('ready'); });
    w.start(); log.length = 0; w.runner.reset();
    const resetOrder = ['playback', 'ik', 'replay', 'drive', 'logic', 'outputs', 'start', 'reapply', 'setup', 'plugin'];
    expect(log).toEqual(resetOrder);
    await w.runner.whenCycleOwnersReady();
    expect(log).toEqual([...resetOrder, 'ready']);
    // Viewer already performed the core reset; facade hooks still participate.
    Object.assign(w.host, { inViewerReset: true }); log.length = 0;
    w.runner.reset(); await w.runner.whenCycleOwnersReady();
    expect(log).toEqual(['setup', 'plugin', 'ready']);
  });

  it('restarts at k=0 with exactly one cycle handle', () => {
    const w = cycleRunnerFixture({ cycleTime: 0.01 });
    w.runner.simEvents.registerCycleParticipant('motion', 60, { step: () => {}, alive: () => true });
    w.start(); w.runner.step(); w.runner.step();
    expect(w.pending()[0].time).toBe(0.02);
    w.runner.reset(); expect(w.pending()).toHaveLength(1); expect(w.pending()[0].time).toBe(0);
    w.runner.step(); expect(w.pending()).toHaveLength(1); expect(w.pending()[0].time).toBe(0.01);
  });

  it('awaits async reset hooks and refuses event processing until they resolve', async () => {
    const w = cycleRunnerFixture();
    const step = vi.fn(); let resolve!: () => void;
    w.runner.simEvents.registerCycleParticipant('motion', 60, { step, alive: () => true });
    w.runner.simEvents.registerResetHook('plugin', () => new Promise<void>(r => { resolve = r; }));
    w.start(); w.runner.reset();
    const ready = vi.fn(); const wait = w.runner.whenCycleOwnersReady().then(ready);
    expect(w.runner.step()).toBe(false); w.runner.tick(1); expect(step).not.toHaveBeenCalled();
    await Promise.resolve(); expect(ready).not.toHaveBeenCalled();
    resolve(); await wait;
    expect(ready).toHaveBeenCalledOnce(); expect(w.pending()).toHaveLength(1);
    expect(w.pending()[0].time).toBe(0); expect(w.runner.step()).toBe(true); expect(step).toHaveBeenCalledOnce();
  });
});

const cleanups: (() => void)[] = [];
afterEach(() => { cleanups.splice(0).reverse().forEach(off => off()); setDriveSpeedOverride(1); });
function world(host: CycleHost = { motion: () => {}, taktDrives: () => {}, alive: () => false }, ct = 1 / 60) {
  const manager = new DESManager(), store = new SignalStore();
  const settle = new SettleController(manager, store);
  const controller = new CycleController(manager, host, ct, store, settle);
  cleanups.push(() => { controller.dispose(); settle.dispose(); });
  const pending = () => manager.getEventQueueSnapshot().filter(e => !e.cancelled && e.actionName === 'Core.Cycle');
  return { manager, store, settle, controller, pending };
}
function capture(controller: CycleController) {
  const registry = new SnapshotRegistry(); registry.register(cycleSnapshotParticipant(controller));
  return registry.captureAll(createCaptureSession())[0].state;
}

describe('CycleController', () => {
  it('armIfAlive leaves an idle host unchanged; reset schedules one initialization probe', () => {
    const { manager, controller, pending } = world();
    const next = manager.nextEventId;
    controller.armIfAlive();
    expect(pending()).toEqual([]); expect(manager.nextEventId).toBe(next);
    const off = controller.registerCycleParticipant('idle', 0, { step: () => {}, alive: () => false });
    off(); expect(pending()).toEqual([]); expect(manager.nextEventId).toBe(next);
    controller.reset(); expect(pending()).toHaveLength(1);
    manager.processStep(); expect(pending()).toEqual([]); expect(manager.nextEventId).toBe(next + 1);
  });

  it('runs stages in stable order at exact k*CT with neutral speed', () => {
    const order: string[] = [], times: number[] = []; let active = true;
    const ct = 1 / 60;
    const w = world({
      motion: dt => {
        expect(dt).toBe(ct); expect(getDriveSpeedOverride()).toBe(1); expect(scaleSimDt(dt)).toBe(ct);
        order.push('motion'); times.push(w.manager.currentTime);
      },
      taktDrives: () => { order.push('drives'); if (times.length === 1000) active = false; }, alive: () => active,
    }, ct);
    setDriveSpeedOverride(10);
    for (const [id, rank] of [['z', 2], ['b', 1], ['a', 1]] as const)
      w.controller.registerCycleParticipant(id, rank, { step: dt => { expect(dt).toBe(ct); order.push(id); }, alive: () => false });
    w.controller.arm(); w.controller.arm();
    expect(w.pending()).toHaveLength(1); expect(w.pending()[0].priority).toBe(CYCLE_PRIORITY);
    for (let k = 0; k < 1000; k++) { expect(w.manager.processStep()).toBe(true); expect(times[k]).toBe(k * ct); }
    expect(order.slice(0, 10)).toEqual(['motion', 'a', 'b', 'z', 'drives', 'motion', 'a', 'b', 'z', 'drives']);
    expect(w.pending()).toHaveLength(1); expect(w.controller.run.trailing).toBe(true);
    expect(w.manager.processStep()).toBe(true); expect(times[1000]).toBe(1000 * ct);
    expect(w.pending()).toEqual([]); expect(w.controller.run.lastK).toBe(1000); expect(w.controller.run.armed).toBe(false);
    expect(getDriveSpeedOverride()).toBe(10);
  });

  it('uses ceil(now/CT), corrects a rounded-down product, and never repeats lastK', () => {
    const w = world(undefined, 0.1);
    w.manager.processAnimated(0.1 + 0.2);
    w.controller.arm(); w.controller.arm();
    expect(w.pending()).toHaveLength(1); expect(w.pending()[0].time).toBe(0.4);
    w.manager.processStep(); w.controller.arm();
    expect(w.pending()[0].time).toBe(0.5);
    expect(w.controller.run.k).toBe(5);
  });

  it('re-arms after removing and adding the last moving participant with one handle', () => {
    const { manager, controller, pending } = world();
    const off = controller.registerCycleParticipant('moving', 0, { step: () => {}, alive: () => true });
    manager.processStep(); expect(pending()).toHaveLength(1);
    off(); expect(pending()).toHaveLength(0); expect(controller.run.armed).toBe(false);
    const next = controller.registerCycleParticipant('moving', 0, { step: () => {}, alive: () => true });
    off(); // An old unregister must not remove the new registration.
    expect(pending()).toHaveLength(1); expect(pending()[0].time).toBe(1 / 60);
    next(); expect(pending()).toHaveLength(0);
  });

  it('reset cancels the old handle and starts again from the reset clock', () => {
    let n = 0;
    const w = world({ motion: () => { n++; }, taktDrives: () => {}, alive: () => true });
    w.controller.arm(); w.manager.processStep(); w.manager.processStep();
    expect(w.controller.run.lastK).toBe(1);
    // Runner cancels controller handles before resetting the manager's ID allocator.
    w.controller.beginRestore(); w.controller.reset(); w.manager.reset(); w.controller.endRestore(); w.controller.reset();
    expect(w.pending()).toHaveLength(1); expect(w.pending()[0].time).toBe(0);
    w.manager.processStep(); expect(n).toBe(3); expect(w.controller.run.lastK).toBe(0);
  });

  it('keeps an IK pending-reset debt alive for its final signal release', () => {
    let active = true, pendingReset = false;
    const w = world({ motion: () => {
      if (pendingReset) { pendingReset = false; w.store.set('done', false, 0); }
      else if (active) { active = false; pendingReset = true; w.store.set('done', true, 0); }
    }, taktDrives: () => {}, alive: () => active || pendingReset });
    w.controller.arm(); w.manager.processStep();
    expect(w.pending()).toHaveLength(1); expect(w.store.get('done')).toBe(true);
    w.manager.processAnimated(1 / 60);
    expect(w.store.get('done')).toBe(false); expect(w.pending()).toHaveLength(1);
    w.manager.processStep(); expect(w.pending()).toEqual([]);
  });

  it('does not double-arm when a participant removes itself and writes a signal during its step', () => {
    const w = world(); let off = () => {};
    off = w.controller.registerCycleParticipant('self', 0, { alive: () => true, step: () => {
      off(); w.store.set('done', true, 0); w.controller.arm();
    } });
    w.manager.processStep();
    expect(w.pending()).toHaveLength(1); expect(w.controller.run.trailing).toBe(true);
    w.manager.processStep();
    expect(w.pending()).toHaveLength(0); expect(w.controller.run.lastK).toBe(1); expect(w.manager.nextEventId).toBe(2);
  });

  it('a signal write while disarmed arms one cycle, including an idle probe', () => {
    let active = false; const motion = vi.fn(() => { active = false; });
    const w = world({ motion, taktDrives: () => {}, alive: () => active });
    w.store.subscribe('start', value => { active = value === true; });
    w.store.set('start', true, 0); w.store.set('other', true, 0);
    expect(w.pending()).toHaveLength(1); w.manager.processStep(); expect(motion).toHaveBeenCalledOnce();
    expect(w.pending()).toHaveLength(1); expect(w.controller.run.trailing).toBe(true);
    w.manager.processStep(); expect(w.pending()).toEqual([]);
    w.store.set('other', false, 0); expect(w.pending()).toHaveLength(1); w.manager.processStep();
    expect(motion).toHaveBeenCalledTimes(3); expect(w.pending()).toEqual([]);
  });

  it('afterSettle re-arms when a participant starts motion without writing signals', () => {
    let active = false;
    const w = world({ motion: () => { active = false; }, taktDrives: () => {}, alive: () => active });
    w.settle.registerEventParticipant('logic', 0, { readSet: () => [], dueTime: () => null,
      settle: () => { active = true; return false; } });
    w.settle.wake('logic'); w.manager.processStep();
    expect(w.pending()).toHaveLength(1); expect(w.pending()[0].time).toBe(0);
    w.manager.processStep(); expect(w.pending()).toHaveLength(1);
    w.manager.processStep(); expect(w.pending()).toHaveLength(0);
  });

  it('suppresses signal re-arming during restore and unsubscribes on disposal', () => {
    const w = world();
    w.controller.beginRestore(); w.store.set('a', true, 0); w.controller.arm(); w.controller.endRestore();
    expect(w.manager.nextEventId).toBe(0);
    w.controller.dispose(); w.store.set('a', false, 0); expect(w.manager.nextEventId).toBe(0);
  });

  it('declares the Core.Cycle schema and claims takt drives saved by des.drives v2', () => {
    const { controller } = world(); const drive = {};
    controller.setClaimedDrives([drive]);
    expect(controller.claimsDrives()).toEqual([drive]);
    expect(cycleSnapshotParticipant(controller).claimsDrives?.()).toEqual([drive]);
    expect(ACTION_SCHEMA.get('Core.Cycle')).toEqual({ owner: 'core.cycle', payload: 'none', handleFields: ['handle'] });
    expect(ACTION_SCHEMA.get('Core.Settle')).toEqual({ owner: 'core.settle', payload: 'none', handleFields: ['handle'] });
    expect(ACTION_SCHEMA.get('Core.Due')).toMatchObject({ owner: 'core.settle', payload: expect.any(Function) });
  });
});

describe('cycle snapshots', () => {
  it('restores exactly one pending trailing cycle without re-arming or losing the stop feedback', () => {
    let active = true;
    const a = world({ motion: () => { active = false; }, taktDrives: () => {}, alive: () => active });
    a.controller.arm(); a.manager.processStep();
    expect(a.controller.run.trailing).toBe(true);
    const state = capture(a.controller);
    const raw = { simTime: a.manager.currentTime, parts: [],
      eventQueue: a.manager.exportQueue(() => '', d => toSnapshotData(d, { participant: 'queue' })) };
    const feedback = vi.fn();
    const b = world({ motion: feedback, taktDrives: () => {}, alive: () => false });
    const p = cycleSnapshotParticipant(b.controller, raw);
    expect(p.validate(state)).toEqual([]);
    p.commit(p.prepare(state));
    expect(b.manager.nextEventId).toBe(0);
    const queue = new DESEventQueue();
    queue.restoreWithIds(raw.eventQueue.map(e => ({ ...e, entityId: -1, actionIndex: ACTION_INDEX.get(e.action)! })), a.manager.nextEventId);
    b.manager.swapPreparedQueue(queue, new Map()); b.manager.applyRunState(a.manager.exportRunState(), raw.simTime);
    expect(b.manager.processStep()).toBe(true); expect(feedback).toHaveBeenCalledOnce();
    expect(b.pending()).toEqual([]); expect(b.controller.run.trailing).toBe(false);
    expect(b.manager.processStep()).toBe(false);
  });

  it('passes the shared preflight with global cycle, settle and due handles', () => {
    const w = world({ motion: () => {}, taktDrives: () => {}, alive: () => true });
    w.settle.registerEventParticipant('timer', 0, { readSet: () => [], settle: () => false, dueTime: () => 2 });
    w.settle.wake('timer'); w.controller.arm();
    const registry = new SnapshotRegistry();
    registry.register(settleSnapshotParticipant(w.settle)); registry.register(cycleSnapshotParticipant(w.controller));
    const fingerprint = { schemaVersion: 4 as const, rngVersion: 1, modelHash: 'test', runConfigHash: 'test', components: [] };
    const raw = { version: 4, fingerprint, simTime: w.manager.currentTime, muIds: [], nextEventId: w.manager.nextEventId,
      eventQueue: w.manager.exportQueue(() => '', d => toSnapshotData(d, { participant: 'queue' })),
      parts: registry.captureAll(createCaptureSession()) };
    const participants = new Map([
      ['core.settle', settleSnapshotParticipant(w.settle, raw)], ['core.cycle', cycleSnapshotParticipant(w.controller, raw)],
    ]);
    expect(preflightSnapshot(raw, { fingerprint, participants, componentTypeOf: () => undefined, getActionSchema })).toEqual({ ok: true });
    raw.eventQueue.find(e => e.action === 'Core.Due')!.data = { participant: 'foreign' };
    expect(preflightSnapshot(raw, { fingerprint, participants, componentTypeOf: () => undefined, getActionSchema })).toMatchObject({
      ok: false, problems: expect.arrayContaining([expect.objectContaining({ code: 'des-snapshot-contract' })]),
    });
  });

  it('restores the cycle index and handle in a fresh manager without scheduling', () => {
    const a = world({ motion: () => {}, taktDrives: () => {}, alive: () => true });
    a.controller.arm(); for (let i = 0; i < 13; i++) a.manager.processStep();
    const state = capture(a.controller);
    const raw = { simTime: a.manager.currentTime, parts: [],
      eventQueue: a.manager.exportQueue(() => '', d => toSnapshotData(d, { participant: 'queue' })) };
    const b = world({ motion: () => {}, taktDrives: () => {}, alive: () => true });
    const p = cycleSnapshotParticipant(b.controller, raw);
    expect(p.validate(state)).toEqual([]);
    const prepared = p.prepare(JSON.parse(JSON.stringify(state)));
    expect(prepared).not.toBe(a.controller.run);
    p.commit(prepared); expect(b.manager.nextEventId).toBe(0);
    const queue = new DESEventQueue();
    queue.restoreWithIds(raw.eventQueue.map(e => ({ ...e, entityId: -1, actionIndex: ACTION_INDEX.get(e.action)! })), a.manager.nextEventId);
    b.manager.swapPreparedQueue(queue, new Map()); b.manager.applyRunState(a.manager.exportRunState(), raw.simTime);
    expect(capture(b.controller)).toEqual(state);
    for (let i = 0; i < 10; i++) {
      a.manager.processStep(); b.manager.processStep();
      expect(b.manager.currentTime).toBe(a.manager.currentTime); expect(capture(b.controller)).toEqual(capture(a.controller));
    }
  });

  it.each(['handle', 'time', 'orphan', 'armed', 'index', 'trailing', 'disarmed-trailing'])('rejects invalid %s before commit', kind => {
    const w = world({ motion: () => {}, taktDrives: () => {}, alive: () => true });
    w.controller.arm(); const original = w.controller.run;
    const run = { ...original };
    const raw = { simTime: w.manager.currentTime, parts: [],
      eventQueue: w.manager.exportQueue(() => '', d => toSnapshotData(d, { participant: 'queue' })) };
    if (kind === 'handle') run.handle = 999;
    else if (kind === 'time') raw.eventQueue[0].time = 0.1;
    else if (kind === 'orphan') { run.armed = false; run.handle = -1; }
    else if (kind === 'armed') run.armed = false;
    else if (kind === 'trailing') delete (run as Partial<typeof run>).trailing;
    else if (kind === 'disarmed-trailing') Object.assign(run, { armed: false, handle: -1, trailing: true });
    else run.lastK = run.k;
    const p = cycleSnapshotParticipant(w.controller, raw);
    expect(p.validate(toSnapshotData(run, { participant: p.key })).length).toBeGreaterThan(0);
    expect(w.controller.run).toBe(original);
  });
});
