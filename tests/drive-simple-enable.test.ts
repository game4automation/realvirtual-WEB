// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * drive-simple-enable.test.ts — plan-539 F14: Drive_Simple motion enable.
 *
 * `Enable` false stops the drive at once and ignores `Forward` / `Backward`;
 * true follows the CURRENT Forward/Backward levels again. Without an `Enable`
 * reference the drive behaves exactly as before.
 */

import { describe, expect, it } from 'vitest';
import { Object3D } from 'three';
import { RVDrive, DriveDirection } from '../src/core/engine/rv-drive';
import { RVDriveSimple } from '../src/core/engine/rv-drive-simple';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { SignalReapplyRegistry } from '../src/core/engine/rv-signal-reapply-registry';
import type { ComponentContext } from '../src/core/engine/rv-component-registry';

const FWD = 'Motor/Forward';
const BWD = 'Motor/Backward';
const EN = 'Motor/Enable';
const DT = 1 / 60;

/** A jog starts one tick late, so a stroke ends within one tick of travel. */
function expectNear(actual: number, target: number): void {
  expect(Math.abs(actual - target)).toBeLessThanOrEqual(100 * DT + 1e-6);
}

interface Rig {
  drive: RVDrive;
  simple: RVDriveSimple;
  store: SignalStore;
  reapply: SignalReapplyRegistry;
  tick(n?: number): void;
}

function build(opts: { withEnable?: boolean; enable?: boolean; forward?: boolean } = {}): Rig {
  const store = new SignalStore();
  store.register(FWD, FWD, opts.forward ?? false, 'PLCOutputBool');
  store.register(BWD, BWD, false, 'PLCOutputBool');
  store.register(EN, EN, opts.enable ?? true, 'PLCOutputBool');
  const registry = new NodeRegistry();
  const node = new Object3D();
  node.name = 'MotorAxis';
  const drive = new RVDrive(node);
  drive.Direction = DriveDirection.LinearX;
  drive.TargetSpeed = 100;
  drive.UseAcceleration = false;
  drive.UseLimits = false;
  drive.initDrive();
  registry.register('Drive', NodeRegistry.computeNodePath(node), drive);
  const simple = new RVDriveSimple(node);
  simple.Forward = FWD;
  simple.Backward = BWD;
  if (opts.withEnable !== false) simple.Enable = EN;
  const reapply = new SignalReapplyRegistry();
  simple.init({ registry, signalStore: store, reapply } as unknown as ComponentContext);
  return {
    drive, simple, store, reapply,
    tick(n = 1) { for (let i = 0; i < n; i++) drive.update(DT); },
  };
}

describe('plan-539 F14 — Drive_Simple Enable', () => {
  it('without an Enable reference the drive jogs as before', () => {
    const r = build({ withEnable: false });
    expect(r.simple.enabled).toBe(true);
    r.store.setByPath(FWD, true);
    r.tick(60);
    expectNear(r.drive.currentPosition, 100);
    r.store.setByPath(FWD, false);
    r.store.setByPath(BWD, true);
    r.tick(30);
    expectNear(r.drive.currentPosition, 50);
  });

  it('Enable false while driving stops at once; Forward is ignored while disabled', () => {
    const r = build();
    r.store.setByPath(FWD, true);
    r.tick(30);
    const p = r.drive.currentPosition;
    expect(p).toBeGreaterThan(40);
    r.store.setByPath(EN, false);
    expect(r.simple.enabled).toBe(false);
    expect(r.drive.jogForward).toBe(false);
    r.tick(30);
    expect(r.drive.currentPosition).toBeCloseTo(p, 6);
    // A new Forward edge while disabled does not move the drive either.
    r.store.setByPath(FWD, false);
    r.store.setByPath(FWD, true);
    r.tick(30);
    expect(r.drive.currentPosition).toBeCloseTo(p, 6);
  });

  it('Enable true follows the CURRENT Forward/Backward levels again', () => {
    const r = build();
    r.store.setByPath(EN, false);
    r.store.setByPath(BWD, true);
    r.tick(30);
    expect(r.drive.currentPosition).toBeCloseTo(0, 6);
    r.store.setByPath(EN, true);
    expect(r.drive.jogBackward).toBe(true);
    r.tick(30);
    expectNear(r.drive.currentPosition, -50);
    // Levels that changed while disabled are the ones that count.
    r.store.setByPath(EN, false);
    r.store.setByPath(BWD, false);
    r.store.setByPath(FWD, true);
    r.store.setByPath(EN, true);
    expect(r.drive.jogForward).toBe(true);
    expect(r.drive.jogBackward).toBe(false);
  });

  it('Enable already false at load holds a Forward that is already true', () => {
    const r = build({ enable: false, forward: true });
    r.tick(30);
    expect(r.drive.currentPosition).toBeCloseTo(0, 6);
    r.store.setByPath(EN, true);
    r.tick(30);
    expectNear(r.drive.currentPosition, 50);
  });

  it('a re-apply after a reset keeps a disabled drive held', () => {
    const r = build({ enable: false, forward: true });
    r.drive.jogForward = true; // a reset re-applies authored jog flags
    r.reapply.reapplyAll();
    expect(r.drive.jogForward).toBe(false);
    r.tick(30);
    expect(r.drive.currentPosition).toBeCloseTo(0, 6);
  });

  it('direct-binding contract: commandEnable / neutralizeEnable', () => {
    const r = build({ withEnable: false });
    r.store.setByPath(FWD, true);
    r.simple.commandEnable(false);
    expect(r.drive.jogForward).toBe(false);
    r.simple.neutralizeEnable();
    expect(r.simple.enabled).toBe(true);
    expect(r.drive.jogForward).toBe(true);
  });
});
