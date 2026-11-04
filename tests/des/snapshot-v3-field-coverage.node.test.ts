// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
import { expect, it, vi } from 'vitest';
import { lineFixture } from './c2a-fixture';
import { Object3D } from 'three';
import { DESRunner } from '../../src/plugins/des/des-runner';
import { createDESMU } from '../../src/plugins/des/rv-des-mu';

it('captures all field groups and continues identically in the same and fresh runner', () => {
  const a = lineFixture({ statResetTime: 35 }); a.runUntil(23);
  const saved = a.runner.fullSnapshot();
  expect(saved.parts.map(p => p.key)).toEqual(expect.arrayContaining([
    'des.manager', 'des.mus', 'des.rng', 'des.reservations', 'des.tweens', 'des.drives', 'des.signals',
  ]));
  const json = JSON.stringify(saved);
  a.runUntil(63); const expected = a.runner.snapshotJson();
  a.runner.restoreFull(saved); a.runUntil(63);
  expect(a.runner.snapshotJson()).toBe(expected);
  const b = lineFixture({ statResetTime: 35 }); b.runner.restoreJson(json); b.runUntil(63);
  expect(b.runner.snapshotJson()).toBe(expected);
});
it('preserves allocator LIFO order, trailing slots, retirements and custom ids', () => {
  const runner = new DESRunner();
  runner.start([], { root: new Object3D() });
  const manager = runner.getManager();
  const mus = Array.from({ length: 3 }, () => { const m = createDESMU(0, null, manager); manager.registerMU(m); return m; });
  manager.retireMU(mus[1]); manager.retireMU(mus[0]);
  const snapshot = runner.fullSnapshot();
  const make = () => { const m = createDESMU(0, null, manager); manager.registerMU(m); return { id: m.id, customId: m.customId }; };
  const expected = make(); expect(expected.id).toBe(0);
  runner.restoreFull(snapshot); expect(make()).toEqual(expected);
  manager.retireMU(manager.getMU(2)!);
  const trailing = runner.fullSnapshot();
  const expectedEnd = make(); expect(expectedEnd.id).toBe(2);
  runner.restoreFull(trailing); expect(make()).toEqual(expectedEnd);
  const fresh = new DESRunner(); fresh.start([], { root: new Object3D() });
  fresh.restoreJson(JSON.stringify(snapshot));
  const mu = createDESMU(0, null, fresh.getManager()); fresh.getManager().registerMU(mu);
  expect({ id: mu.id, customId: mu.customId }).toEqual(expected);
  fresh.dispose(); runner.dispose();
});
it('replaces force pins without calling the external force sink', () => {
  const { runner, signalStore } = lineFixture();
  signalStore.forceSignal('pin', 7);
  const saved = runner.fullSnapshot();
  signalStore.forceSignal('other', 9); signalStore.unforce('pin');
  const sink = vi.fn(); signalStore.setForceSink(sink);
  runner.restoreFull(saved);
  expect(signalStore.getForced()).toEqual(new Map([['pin', 7]]));
  expect(sink).not.toHaveBeenCalled();
  const fresh = lineFixture(); fresh.runner.restoreJson(JSON.stringify(saved));
  expect(fresh.signalStore.getForced()).toEqual(signalStore.getForced());
  signalStore.set('pin', 99); fresh.signalStore.set('pin', 99);
  expect(fresh.signalStore.get('pin')).toBe(signalStore.get('pin'));
});

it('preserves nested loads, retired queue references, reservations, drives and tweens', () => {
  const a = lineFixture();
  const manager = a.manager;
  const parent = createDESMU(0, null, manager), child = createDESMU(0, null, manager), retired = createDESMU(0, null, manager);
  for (const mu of [parent, child, retired]) manager.registerMU(mu);
  parent.carrierCapacity = 2;
  parent.currentComponent = a.station; parent.loadedOn = a.station; parent.isLoaded = true;
  parent.childMUs = [{ id: child.id, gen: child.generation }];
  child.parentMU = { id: parent.id, gen: parent.generation }; child.loadedOn = a.station; child.isLoaded = true;
  a.station.restoreMURefs([parent]);
  const queued = a.runner.fullSnapshot().eventQueue.find(e => e.componentId !== null)!;
  const owner = a.runner.liveInstances.find(i => i.desId === queued.componentId)!.adapter;
  manager.scheduleEvent(100, queued.action, owner.entityId, retired.id);
  manager.retireMU(retired);
  manager.createReservation(a.station.path, a.sink.path, 1);
  // Shape of RVDrive the des.drives part reads (incl. the phase-8 overwrite state).
  const overwrite = { enabled: false, previousPosition: 0 };
  const drive = { node: a.station.node, currentPosition: 3, targetPosition: 7, currentSpeed: 2, isRunning: true,
    captureOverwriteState: () => ({ ...overwrite }), restoreOverwriteState: (s: typeof overwrite) => { Object.assign(overwrite, s); },
    applyToNode: () => {} };
  (a.station as unknown as { _drives: Map<string, unknown> })._drives.set('drv', drive); // `drives` is a copy
  const tween = { kind: 'position' as const, t0: 0, t1: 10, muId: child.id, from: [0, 0, 0], to: [1, 0, 0] };
  const spy = vi.spyOn((a.runner as unknown as { tweens: { toSnapshot(): unknown[] } }).tweens, 'toSnapshot').mockReturnValue([tween as never]);
  const saved = a.runner.fullSnapshot(); spy.mockRestore();
  drive.currentPosition = 100;
  a.runner.restoreJson(JSON.stringify(saved));
  expect(drive.currentPosition).toBe(3);
  expect(manager.getMU(retired.id)?.retired).toBe(true);
  expect(manager.getMU(retired.id)?.pendingEvents).toBe(1);
  expect(manager.getMU(child.id)?.parentMU).toEqual({ id: parent.id, gen: parent.generation });
  expect(manager.snapshotReservations()).toHaveLength(1);
  const b = lineFixture();
  const freshDrive = { ...drive, node: b.station.node, currentPosition: -1 };
  (b.station as unknown as { _drives: Map<string, unknown> })._drives.set('drv', freshDrive);
  b.runner.restoreJson(JSON.stringify(saved));
  expect(freshDrive.currentPosition).toBe(3);
  expect(b.manager.getMU(retired.id)?.pendingEvents).toBe(1);
  expect(b.manager.getMU(child.id)?.parentMU).toEqual({ id: parent.id, gen: parent.generation });
  expect(b.manager.snapshotReservations()).toEqual(manager.snapshotReservations());
  a.runUntil(53); b.runUntil(53);
  expect(b.runner.fullSnapshot()).toEqual(a.runner.fullSnapshot());
});
