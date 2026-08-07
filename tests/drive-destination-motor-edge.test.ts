// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * drive-destination-motor-edge.test.ts — Plan 232, Phase 1 (Step B), §9.7.
 *
 * HIGH-priority edge cases from the review:
 *  - Scale=0 → feedback stays finite (Scale-0 guard), no NaN / 60 Hz notify storm.
 *  - No Drive at node → init() does not throw, behavior stays silent.
 *  - StartDrive stays true after target reached → no auto-restart (rising edge).
 *  - Destination set without a StartDrive flank → drive does NOT move.
 */

import { describe, it, expect, vi } from 'vitest';
import { Object3D, Scene } from 'three';
import { RVDriveDestinationMotor } from '../src/core/engine/rv-drive-destination-motor';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { RVTransportManager } from '../src/core/engine/rv-transport-manager';
import type { ComponentContext } from '../src/core/engine/rv-component-registry';
import { makeMotorFixture, tickDrive } from './_destination-motor-fixture';

describe('RVDriveDestinationMotor edge cases (plan-232 §9.7)', () => {
  it('Scale=0 → feedback is finite (guard), no NaN storm', () => {
    const { drive, store } = makeMotorFixture({ scale: 0, offset: 5 });
    store.set('DriveNode.Destination', 30);
    store.set('DriveNode.StartDrive', true);
    tickDrive(drive, 50);

    const fb = store.getFloat('DriveNode.IsAtPosition');
    expect(Number.isFinite(fb)).toBe(true);
    expect(Number.isNaN(fb)).toBe(false);
  });

  it('Scale=0 does not trigger an unbounded notify storm', () => {
    const { drive, store } = makeMotorFixture({ scale: 0 });
    let notifies = 0;
    store.subscribe('DriveNode.IsAtPosition', () => { notifies++; });

    store.set('DriveNode.Destination', 100);
    store.set('DriveNode.StartDrive', true);
    tickDrive(drive, 100);

    // With the guard (divisor=1) the value tracks position and settles; the
    // notify count is bounded by actual position changes, not the tick count
    // (an unguarded NaN would notify every single tick → >= 100).
    expect(notifies).toBeLessThan(100);
  });

  it('no Drive at the node → init() does not throw and stays silent', () => {
    const store = new SignalStore();
    const registry = new NodeRegistry();
    const scene = new Scene();
    const root = new Object3D();
    const node = new Object3D();
    node.name = 'DriveNode';
    root.add(node);
    // NOTE: no Drive registered for this path.
    store.register('DriveNode.Destination', 'Root/DriveNode/Signals/Destination', 0, 'PLCOutputFloat');
    store.buildIndex();

    const motor = new RVDriveDestinationMotor(node);
    motor.Destination = 'DriveNode.Destination';
    const ctx: ComponentContext = {
      registry, signalStore: store, scene,
      transportManager: new RVTransportManager(), root,
    };
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => motor.init(ctx)).not.toThrow();
    // Writing the destination signal must not throw (subscription not wired).
    expect(() => store.set('DriveNode.Destination', 42)).not.toThrow();
    errSpy.mockRestore();
  });

  it('StartDrive stays true after target reached → no auto-restart', () => {
    const { drive, store } = makeMotorFixture();
    store.set('DriveNode.Destination', 20);
    store.set('DriveNode.StartDrive', true);
    tickDrive(drive, 100);
    expect(drive.isAtTarget).toBe(true);
    expect(drive.isRunning).toBe(false);

    // StartDrive is STILL true; set a new destination WITHOUT toggling StartDrive.
    store.set('DriveNode.Destination', 60);
    // targetPosition updates, but no rising edge on StartDrive → not running.
    expect(drive.targetPosition).toBeCloseTo(60, 3);
    expect(drive.isRunning).toBe(false);
    tickDrive(drive, 50);
    // Drive stayed at 20 (did NOT auto-restart toward 60).
    expect(drive.currentPosition).toBeCloseTo(20, 3);
  });

  it('toggling StartDrive false→true restarts toward the new destination', () => {
    const { drive, store } = makeMotorFixture();
    store.set('DriveNode.Destination', 20);
    store.set('DriveNode.StartDrive', true);
    tickDrive(drive, 100);
    expect(drive.currentPosition).toBeCloseTo(20, 3);

    store.set('DriveNode.Destination', 60);
    store.set('DriveNode.StartDrive', false);   // reset edge
    store.set('DriveNode.StartDrive', true);    // new rising edge
    expect(drive.isRunning).toBe(true);
    tickDrive(drive, 100);
    expect(drive.currentPosition).toBeCloseTo(60, 3);
  });

  it('Destination without a StartDrive flank → drive does not move', () => {
    const { drive, store } = makeMotorFixture();
    store.set('DriveNode.Destination', 75);
    expect(drive.targetPosition).toBeCloseTo(75, 3);
    expect(drive.isRunning).toBe(false);
    tickDrive(drive, 50);
    expect(drive.currentPosition).toBeCloseTo(0, 3);
  });
});
