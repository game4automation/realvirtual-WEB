// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * drive-cylinder-enable.test.ts — plan-538 F3: Drive_Cylinder motion enable.
 *
 * `Enable` false stops the cylinder and HOLDS it where it stands; `Out`/`In`
 * changes are latched, not executed. `Enable` true executes the latched
 * command (two-bit: the last command; one-bit: the current `Out` level).
 * Without `Enable` the cylinder behaves exactly as before.
 */

import { describe, expect, it } from 'vitest';
import { Object3D } from 'three';
import { RVDrive, DriveDirection } from '../src/core/engine/rv-drive';
import { RVDriveCylinder } from '../src/core/engine/rv-drive-cylinder';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { SignalReapplyRegistry } from '../src/core/engine/rv-signal-reapply-registry';
import { EventEmitter } from '../src/core/rv-events';
import type { ComponentContext } from '../src/core/engine/rv-component-registry';

const OUT = 'Cyl/Out';
const IN = 'Cyl/In';
const EN = 'Cyl/Enable';
const DT = 1 / 60;

interface Rig {
  drive: RVDrive;
  cyl: RVDriveCylinder;
  store: SignalStore;
  reapply: SignalReapplyRegistry;
  events: EventEmitter<Record<string, unknown>>;
  tick(n?: number): void;
}

function build(opts: { oneBit?: boolean; withEnable?: boolean; enable?: boolean; out?: boolean } = {}): Rig {
  const store = new SignalStore();
  store.register(OUT, OUT, opts.out ?? false, 'PLCOutputBool');
  store.register(IN, IN, false, 'PLCOutputBool');
  store.register(EN, EN, opts.enable ?? true, 'PLCOutputBool');
  const registry = new NodeRegistry();
  const node = new Object3D();
  node.name = 'CylAxis';
  const drive = new RVDrive(node);
  drive.Direction = DriveDirection.LinearX;
  drive.TargetSpeed = 100;
  drive.UseAcceleration = false;
  drive.UseLimits = false;
  drive.initDrive();
  registry.register('Drive', NodeRegistry.computeNodePath(node), drive);
  const cyl = new RVDriveCylinder(node);
  cyl.MinPos = 0;
  cyl.MaxPos = 100;
  cyl.TimeOut = 1;
  cyl.TimeIn = 1;
  cyl.OneBitCylinder = opts.oneBit ?? false;
  cyl.Out = OUT;
  cyl.In = IN;
  if (opts.withEnable !== false) cyl.Enable = EN;
  const reapply = new SignalReapplyRegistry();
  const events = new EventEmitter<Record<string, unknown>>();
  cyl.init({ registry, signalStore: store, reapply, events } as unknown as ComponentContext);
  return {
    drive, cyl, store, reapply, events,
    tick(n = 1) { for (let i = 0; i < n; i++) drive.update(DT); },
  };
}

describe('plan-538 F3 — Drive_Cylinder Enable (hold)', () => {
  it('without Enable the cylinder moves as before', () => {
    const r = build({ withEnable: false });
    expect(r.cyl.enabled).toBe(true);
    r.store.setByPath(OUT, true);
    r.tick(70);
    expect(r.drive.currentPosition).toBeCloseTo(100, 3);
  });

  it('Enable false mid-stroke holds the position; Enable true completes the command', () => {
    const r = build();
    r.store.setByPath(OUT, true);
    r.tick(30); // ~50 mm
    const mid = r.drive.currentPosition;
    expect(mid).toBeGreaterThan(20);
    expect(mid).toBeLessThan(80);

    r.store.setByPath(EN, false);
    expect(r.cyl.enabled).toBe(false);
    r.tick(60);
    expect(r.drive.currentPosition).toBeCloseTo(mid, 6);
    expect(r.drive.isRunning).toBe(false);

    r.store.setByPath(EN, true);
    r.tick(70);
    expect(r.drive.currentPosition).toBeCloseTo(100, 3);
  });

  it('Out/In changes while disabled are latched; Enable true executes the LAST command', () => {
    const r = build();
    r.store.setByPath(OUT, true);
    r.tick(70);
    expect(r.drive.currentPosition).toBeCloseTo(100, 3);

    r.store.setByPath(EN, false);
    r.store.setByPath(OUT, false);
    r.store.setByPath(IN, true);
    r.tick(60);
    expect(r.drive.currentPosition).toBeCloseTo(100, 3); // latched, not executed

    r.store.setByPath(EN, true);
    r.tick(70);
    expect(r.drive.currentPosition).toBeCloseTo(0, 3);
  });

  it('two-bit: a command pulse during the hold (both inputs back to false) is executed on enable', () => {
    const r = build();
    r.store.setByPath(EN, false);
    r.store.setByPath(OUT, true);
    r.store.setByPath(OUT, false); // pulse over, In stays false
    r.tick(30);
    expect(r.drive.currentPosition).toBe(0);
    r.store.setByPath(EN, true);
    r.tick(70);
    expect(r.drive.currentPosition).toBeCloseTo(100, 3);
  });

  it('one-bit: Out false while disabled does not move back; enable then follows Out', () => {
    const r = build({ oneBit: true });
    r.store.setByPath(OUT, true);
    r.tick(70);
    expect(r.drive.currentPosition).toBeCloseTo(100, 3);

    r.store.setByPath(EN, false);
    r.store.setByPath(OUT, false);
    r.tick(70);
    expect(r.drive.currentPosition).toBeCloseTo(100, 3);

    r.store.setByPath(EN, true);
    r.tick(70);
    expect(r.drive.currentPosition).toBeCloseTo(0, 3);
  });

  it('Enable already false at load: an Out level present at load is latched, not executed', () => {
    const r = build({ enable: false, out: true });
    expect(r.cyl.enabled).toBe(false);
    r.tick(70);
    expect(r.drive.currentPosition).toBe(0);
    r.store.setByPath(EN, true);
    r.tick(70);
    expect(r.drive.currentPosition).toBeCloseTo(100, 3);
  });

  it('Enable false at a simulation reset: the re-applied Out level stays latched until enable', () => {
    const r = build();
    r.store.setByPath(OUT, true);
    r.tick(70);
    r.store.setByPath(EN, false);
    // Simulation reset: drive back to its start, cylinder re-initialises, then
    // the re-apply re-asserts the current levels (production order).
    r.drive.reset();
    r.events.emit('simulation-start', undefined);
    r.reapply.reapplyAll();
    r.tick(70);
    expect(r.drive.currentPosition).toBe(0);
    expect(r.cyl.enabled).toBe(false);
    r.store.setByPath(EN, true);
    r.tick(70);
    expect(r.drive.currentPosition).toBeCloseTo(100, 3);
  });
});
