// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it, vi } from 'vitest';
import { Object3D } from 'three';
import { RVDrive } from '../../src/core/engine/rv-drive';
import { RVDriveDestinationMotor } from '../../src/core/engine/rv-drive-destination-motor';
import { NodeRegistry } from '../../src/core/engine/rv-node-registry';
import { RVTransportManager } from '../../src/core/engine/rv-transport-manager';
import { getProblems } from '../../src/core/hmi/problems-store';
import { attachDriveBehaviorByCode } from '../../src/core/engine/rv-signal-construction';
import { RVDriveSimple } from '../../src/core/engine/rv-drive-simple';
import { readFileSync } from 'node:fs';
import { readGlb } from '../../scripts/lib/rv-glb.mjs';
import { driveStateOwners } from '../../src/plugins/des/rv-des-drive-state';
import { cycleRunnerFixture } from './cycle-runner-fixture';

function motorWorld(metadata: boolean) {
  const w = cycleRunnerFixture({ cycleTime: 0.01 });
  const node = new Object3D(); node.name = 'Axis'; w.scene.add(node);
  const drive = new RVDrive(node);
  drive.TargetSpeed = 10;
  drive.initDrive();
  const registry = new NodeRegistry();
  const path = NodeRegistry.computeNodePath(node);
  registry.registerNode(path, node);
  registry.register('Drive', path, drive);
  const motor = new RVDriveDestinationMotor(node);
  const slots = {
    Destination: 'P40.Destination', StartDrive: 'P40.StartDrive',
    IsAtDestination: 'P40.IsAtDestination', IsDriving: 'P40.IsDriving',
  };
  for (const [slot, name] of Object.entries(slots)) {
    motor[slot as keyof typeof slots] = `IO/${slot}`;
    w.signalStore.register(name, `IO/${slot}`, slot === 'Destination' ? 0 : false,
      slot === 'Destination' ? 'PLCOutputFloat' : slot === 'StartDrive' ? 'PLCOutputBool' : 'PLCInputBool');
  }
  if (metadata) {
    // constructDrive keeps the first authored Drive_* entry.
    drive.Behaviors = ['Drive_DestinationMotor'];
    drive.BehaviorExtras = { Drive_DestinationMotor: { ...slots } };
  }
  motor.init({ scene: w.scene, root: w.scene, registry, signalStore: w.signalStore,
    transportManager: new RVTransportManager() });
  w.host.drives = [drive];
  return { ...w, drive, motor, slots };
}

describe('PLC-commanded drive takt ownership and feedback', () => {
  it('the first settle of a fresh run already publishes DestinationMotor command feedback synchronously', () => {
    const w = motorWorld(false);
    let calls = 0;
    w.runner.simEvents.registerEventParticipant('plc.first', 0, {
      readSet: () => [], dueTime: () => null,
      settle() {
        if (calls++ > 0) return false;
        expect(w.drive.eventDrivenFeedback).toBe(true);
        expect(w.drive.onCommand).toBeTypeOf('function');
        w.signalStore.setMany({ [w.slots.Destination]: 2, [w.slots.StartDrive]: true }, 0);
        expect(w.signalStore.get(w.slots.IsAtDestination)).toBe(false);
        expect(w.signalStore.get(w.slots.IsDriving)).toBe(true);
        expect(w.drive.currentPosition).toBe(0);
        return false;
      },
    });
    w.start();
    for (let i = 0; calls === 0 && i < 3; i++) expect(w.runner.step()).toBe(true);
    expect(calls).toBeGreaterThan(0);
  });

  it('Turntable DES-owned drives with runtime-created adapters do not acquire a second tick owner', () => {
    const { json } = readGlb(readFileSync('public/library/PalletHandling/Turntable.glb'));
    expect(json.nodes.some((n: { name?: string }) => n.name === 'Drive-Rot-Y')).toBe(true);
    // Its shared setup, not the GLB, attaches DestinationMotor and Simple adapters.
    expect(json.nodes.some((n: { extras?: { realvirtual?: object } }) =>
      Object.keys(n.extras?.realvirtual ?? {}).some(k => k.startsWith('Drive_')))).toBe(false);
    const w = cycleRunnerFixture();
    const registry = new NodeRegistry();
    const viewer = { scene: w.scene, registry, signalStore: w.signalStore, transportManager: new RVTransportManager() };
    for (const [name, type] of [['Drive-Rot-Y', 'Drive_DestinationMotor'], ['Transport-Z', 'Drive_Simple']] as const) {
      const node = new Object3D(); node.name = name; w.scene.add(node);
      const drive = new RVDrive(node); drive.initDrive(); w.host.drives.push(drive);
      const path = NodeRegistry.computeNodePath(node); registry.registerNode(path, node); registry.register('Drive', path, drive);
      const slots = type === 'Drive_DestinationMotor' ? ['StartDrive', 'Destination'] : ['Forward', 'Backward'];
      const wiring: Record<string, string> = {};
      for (const slot of slots) {
        const address = `${path}/${slot}`; wiring[slot] = address;
        w.signalStore.register(address, address, slot === 'Destination' ? 0 : false,
          slot === 'Destination' ? 'PLCOutputFloat' : 'PLCOutputBool');
      }
      const adapter = attachDriveBehaviorByCode(viewer, node, type, wiring);
      expect(adapter).toBeInstanceOf(type === 'Drive_DestinationMotor' ? RVDriveDestinationMotor : RVDriveSimple);
      expect(driveStateOwners(drive)).toEqual([adapter]);
      expect(drive.Behaviors).toEqual([]);
    }
    vi.spyOn(w.runner as unknown as { collectDrives(): RVDrive[] }, 'collectDrives').mockReturnValue(w.host.drives);
    w.start();
    expect(w.runner.cycleMode).toBe(false);
    expect(w.host.snapshotBlockers.reasons()).toEqual([]);
    expect(() => w.runner.fullSnapshot()).not.toThrow();
    expect(w.host.drives.every(d => !d.eventDrivenFeedback && d.onCommand === null)).toBe(true);
  });

  it.each([true, false])('P40 repeats 122 -> 123 -> 130 through real settle and motion (metadata=%s)', metadata => {
    const w = motorWorld(metadata);
    w.start();
    expect(w.runner.cycleMode).toBe(true);
    expect(w.drive.eventDrivenFeedback).toBe(true);
    expect(w.drive.onCommand).toBeTypeOf('function');
    expect(w.drive.driveBehaviors).toEqual([]);
    expect(driveStateOwners(w.drive)).toEqual([w.motor]);
    if (!metadata) {
      expect(w.drive.Behaviors).toEqual([]);
      expect(w.drive.BehaviorExtras).toEqual({});
    }
    w.signalStore.setMany({ [w.slots.StartDrive]: true }, 0);
    expect(w.runner.step()).toBe(true);
    w.signalStore.setMany({ [w.slots.StartDrive]: false }, 0);
    expect(w.signalStore.get(w.slots.IsAtDestination)).toBe(true);

    let st = 130;
    let target = 0;
    const scans: { t: number; st: number; arrived: boolean; driving: boolean }[] = [];
    w.runner.simEvents.registerEventParticipant('plc.p40', 10, {
      readSet: () => [w.slots.IsAtDestination, w.slots.IsDriving],
      dueTime: () => null,
      settle(t, image) {
        scans.push({ t, st, arrived: image.get(w.slots.IsAtDestination) === true,
          driving: image.get(w.slots.IsDriving) === true });
        if (st === 122) {
          w.signalStore.setMany({ [w.slots.Destination]: target, [w.slots.StartDrive]: true }, t * 1000);
          st = 123;
          return true;
        }
        if (st === 123) {
          w.signalStore.setMany({ [w.slots.StartDrive]: false }, t * 1000);
          if (image.get(w.slots.IsAtDestination) === true) { st = 130; return true; }
        }
        return false;
      },
    });

    for (target of [2, -1]) {
      const from = w.drive.currentPosition;
      expect(w.drive.isAtTarget).toBe(true);
      expect(from).not.toBe(target);
      scans.length = 0;
      st = 122;
      w.runner.simEvents.wake('plc.p40');
      for (let guard = 0; scans.length === 0 && guard < 5; guard++) expect(w.runner.step()).toBe(true);
      expect(scans.slice(0, 2)).toEqual([
        { t: scans[0].t, st: 122, arrived: true, driving: false },
        { t: scans[0].t, st: 123, arrived: false, driving: true },
      ]);
      expect(st).toBe(123);
      expect(w.drive.currentPosition).toBe(from);
      expect(w.signalStore.get(w.slots.StartDrive)).toBe(false);
      const commandTime = scans[0].t;
      let cyclesWaiting = 0;
      for (let guard = 0; st !== 130 && guard < 1000; guard++) {
        expect(w.runner.step()).toBe(true);
        if (!w.drive.isAtTarget) {
          expect(st).toBe(123);
          if (w.manager.currentTime > commandTime) cyclesWaiting++;
        }
      }
      expect(cyclesWaiting).toBeGreaterThan(1);
      expect(st).toBe(130);
      expect(w.drive.currentPosition).toBe(target);
      expect(scans.find(scan => scan.st === 130)!.t).toBeGreaterThan(commandTime);
      for (let guard = 0; w.drive.isRunning && guard < 3; guard++) expect(w.runner.step()).toBe(true);
      expect(w.signalStore.get(w.slots.IsDriving)).toBe(false);
    }
    expect(getProblems().filter(p => p.code === 'des-tick-ownership-conflict' && p.nodePath === '#Axis')).toEqual([]);
    w.runner.dispose();
    expect(w.drive.eventDrivenFeedback).toBe(false);
    expect(w.drive.onCommand).toBeNull();
  });

  for (const metadata of [true, false]) {
    it.each(['before start', 'while running'])('reports a DES claim %s instead of hanging (metadata=' + metadata + ')', when => {
      const w = motorWorld(metadata);
      if (when === 'while running') {
        w.start();
        expect(w.drive.eventDrivenFeedback).toBe(true);
      }
      if (!metadata) Object.assign(w.host, { logicEngine: { commandedDrives: () => [w.drive] } });
      w.runner.simEvents.registerSnapshotProvider('test.des-owner', () => [{
        key: 'test.des-owner', version: 1, claimsDrives: () => [w.drive],
        capture: () => null, validate: () => [], prepare: () => null, commit: () => {},
      }]);
      if (when === 'before start') w.start();
      expect(getProblems()).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'des-tick-ownership-conflict', severity: 'error', nodePath: '#Axis' }),
      ]));
      expect(w.host.snapshotBlockers.reasons()).toContain('des.tick-ownership: tick ownership conflict: #Axis');
      expect(() => w.runner.fullSnapshot()).toThrow(/tick ownership conflict/);
      expect(w.drive.eventDrivenFeedback).toBe(false);
      expect(w.drive.onCommand).toBeNull();
    });
  }
});
