// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * drive-cylinder-mode.test.ts — plan-570 F1/F2: Drive_Cylinder valve modes.
 *
 * `Legacy` (default) keeps the latching behaviour (covered by the existing
 * drive-cylinder-*.test.ts files). The level-based modes evaluate the CURRENT
 * Out/In levels: DoubleActing (5/3, closed centre) moves only while exactly one
 * command is on; SingleActingPositive/Negative follow the Out level with a
 * spring return. Nothing is latched — Enable, reset and re-apply evaluate the
 * levels present at that moment.
 */

import { describe, expect, it } from 'vitest';
import { Object3D } from 'three';
import { RVDrive, DriveDirection } from '../src/core/engine/rv-drive';
import { RVDriveCylinder, type DriveCylinderMode } from '../src/core/engine/rv-drive-cylinder';
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

function build(mode: DriveCylinderMode, opts: {
  withEnable?: boolean; withIn?: boolean; enable?: boolean; out?: boolean; oneBit?: boolean; invert?: boolean;
} = {}): Rig {
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
  cyl.Mode = mode;
  cyl.OneBitCylinder = opts.oneBit ?? false;
  cyl.InvertOutputLogic = opts.invert ?? false;
  cyl.Out = OUT;
  if (opts.withIn !== false) cyl.In = IN;
  if (opts.withEnable) cyl.Enable = EN;
  const reapply = new SignalReapplyRegistry();
  const events = new EventEmitter<Record<string, unknown>>();
  cyl.init({ registry, signalStore: store, reapply, events } as unknown as ComponentContext);
  return {
    drive, cyl, store, reapply, events,
    tick(n = 1) { for (let i = 0; i < n; i++) drive.update(DT); },
  };
}

describe('plan-570 — Drive_Cylinder Mode = DoubleActing (5/3)', () => {
  it('a 0.1-s pulse stops the cylinder after the pulse and holds it', () => {
    const r = build('DoubleActing');
    r.store.setByPath(OUT, true);
    r.tick(6); // 0.1 s ≈ 10 mm
    r.store.setByPath(OUT, false);
    const held = r.drive.currentPosition;
    expect(held).toBeGreaterThan(5);
    expect(held).toBeLessThan(15);
    r.tick(120);
    expect(r.drive.currentPosition).toBeCloseTo(held, 6);
    expect(r.drive.isRunning).toBe(false);
  });

  it('Out held → MaxPos; In held → MinPos', () => {
    const r = build('DoubleActing');
    r.store.setByPath(OUT, true);
    r.tick(70);
    expect(r.drive.currentPosition).toBeCloseTo(100, 3);
    r.store.setByPath(OUT, false);
    r.store.setByPath(IN, true);
    r.tick(70);
    expect(r.drive.currentPosition).toBeCloseTo(0, 3);
  });

  it('both on mid-stroke → hold; Out alone again → continues', () => {
    const r = build('DoubleActing');
    r.store.setByPath(OUT, true);
    r.tick(30);
    r.store.setByPath(IN, true); // both on
    const mid = r.drive.currentPosition;
    r.tick(60);
    expect(r.drive.currentPosition).toBeCloseTo(mid, 6);
    r.store.setByPath(IN, false);
    r.tick(70);
    expect(r.drive.currentPosition).toBeCloseTo(100, 3);
  });

  it('switch order "Out off, then In on" and "In on, then Out off" both end at MinPos', () => {
    const a = build('DoubleActing');
    a.store.setByPath(OUT, true); a.tick(70);
    a.store.setByPath(OUT, false); a.store.setByPath(IN, true); a.tick(70);
    expect(a.drive.currentPosition).toBeCloseTo(0, 3);

    const b = build('DoubleActing');
    b.store.setByPath(OUT, true); b.tick(70);
    b.store.setByPath(IN, true); b.store.setByPath(OUT, false); b.tick(70);
    expect(b.drive.currentPosition).toBeCloseTo(0, 3);
  });

  it('Enable false holds; nothing is latched — Enable true evaluates the CURRENT levels', () => {
    const r = build('DoubleActing', { withEnable: true });
    r.store.setByPath(EN, false);
    r.store.setByPath(OUT, true);
    r.store.setByPath(OUT, false); // a pulse during the hold
    r.tick(30);
    expect(r.drive.currentPosition).toBe(0);
    r.store.setByPath(EN, true);
    r.tick(70);
    expect(r.drive.currentPosition).toBe(0); // the stale pulse is NOT executed

    r.store.setByPath(OUT, true);
    r.tick(30);
    const mid = r.drive.currentPosition;
    r.store.setByPath(EN, false);
    r.tick(60);
    expect(r.drive.currentPosition).toBeCloseTo(mid, 6);
    r.store.setByPath(EN, true); // Out still on → continues
    r.tick(70);
    expect(r.drive.currentPosition).toBeCloseTo(100, 3);
  });

  it('reset: home pose, then the re-apply evaluates the current levels', () => {
    const r = build('DoubleActing');
    r.store.setByPath(OUT, true);
    r.tick(70);
    r.drive.reset();
    r.events.emit('simulation-start', undefined);
    expect(r.drive.currentPosition).toBe(0);
    r.reapply.reapplyAll(); // Out still on
    r.tick(70);
    expect(r.drive.currentPosition).toBeCloseTo(100, 3);

    r.store.setByPath(OUT, false);
    r.drive.reset();
    r.events.emit('simulation-start', undefined);
    r.reapply.reapplyAll(); // both off → stays home
    r.tick(70);
    expect(r.drive.currentPosition).toBe(0);
  });

  it('direct binding released (neutralize) → level false → hold', () => {
    const r = build('DoubleActing');
    r.cyl.commandOut(true);
    r.tick(30);
    const mid = r.drive.currentPosition;
    r.cyl.neutralizeOut();
    r.tick(60);
    expect(r.drive.currentPosition).toBeCloseTo(mid, 6);
    r.cyl.commandIn(true);
    r.tick(70);
    expect(r.drive.currentPosition).toBeCloseTo(0, 3);
    r.cyl.commandOut(true); // both on → hold
    r.cyl.neutralizeIn(); // In released → Out alone
    r.tick(70);
    expect(r.drive.currentPosition).toBeCloseTo(100, 3);
  });

  it('In not wired: Out on → moves, Out off → hold', () => {
    const r = build('DoubleActing', { withIn: false });
    r.store.setByPath(OUT, true);
    r.tick(30);
    r.store.setByPath(OUT, false);
    const mid = r.drive.currentPosition;
    expect(mid).toBeGreaterThan(20);
    r.tick(60);
    expect(r.drive.currentPosition).toBeCloseTo(mid, 6);
  });

  it('OneBitCylinder / InvertOutputLogic are ignored (Mode wins)', () => {
    const r = build('DoubleActing', { oneBit: true, invert: true });
    r.store.setByPath(OUT, true);
    r.tick(70);
    expect(r.drive.currentPosition).toBeCloseTo(100, 3);
    r.store.setByPath(OUT, false);
    r.store.setByPath(IN, true); // In is wired despite OneBit
    r.tick(70);
    expect(r.drive.currentPosition).toBeCloseTo(0, 3);
  });

  it('an Out level present at load moves the cylinder', () => {
    const r = build('DoubleActing', { out: true });
    r.tick(70);
    expect(r.drive.currentPosition).toBeCloseTo(100, 3);
  });

  it('feedback IsMovingOut is false while holding', () => {
    const r = build('DoubleActing');
    r.store.setByPath(OUT, true);
    r.tick(10);
    expect(r.cyl.readFeedbackSlot('IsMovingOut')).toBe(true);
    r.store.setByPath(OUT, false);
    r.tick(1);
    expect(r.cyl.readFeedbackSlot('IsMovingOut')).toBe(false);
    expect(r.cyl.readFeedbackSlot('IsOut')).toBe(false);
    expect(r.cyl.readFeedbackSlot('IsIn')).toBe(false);
  });
});

describe('plan-570 — Drive_Cylinder Mode = SingleActing*', () => {
  it('SingleActingPositive: Out on → MaxPos, off → MinPos (spring); In ignored', () => {
    const r = build('SingleActingPositive');
    r.store.setByPath(OUT, true);
    r.tick(70);
    expect(r.drive.currentPosition).toBeCloseTo(100, 3);
    r.store.setByPath(IN, true); // ignored
    r.tick(10);
    expect(r.drive.currentPosition).toBeCloseTo(100, 3);
    r.store.setByPath(OUT, false);
    r.tick(70);
    expect(r.drive.currentPosition).toBeCloseTo(0, 3);
  });

  it('SingleActingNegative: Out off → MaxPos from load, on → MinPos', () => {
    const r = build('SingleActingNegative');
    r.tick(70);
    expect(r.drive.currentPosition).toBeCloseTo(100, 3);
    r.store.setByPath(OUT, true);
    r.tick(70);
    expect(r.drive.currentPosition).toBeCloseTo(0, 3);
  });

  it('SingleActingPositive with Enable: hold, then follows the current level', () => {
    const r = build('SingleActingPositive', { withEnable: true });
    r.store.setByPath(OUT, true);
    r.tick(30);
    r.store.setByPath(EN, false);
    const mid = r.drive.currentPosition;
    r.store.setByPath(OUT, false);
    r.tick(60);
    expect(r.drive.currentPosition).toBeCloseTo(mid, 6);
    r.store.setByPath(EN, true);
    r.tick(70);
    expect(r.drive.currentPosition).toBeCloseTo(0, 3);
  });

  it('released Out binding on a single-acting cylinder → spring return', () => {
    const r = build('SingleActingPositive');
    r.cyl.commandOut(true);
    r.tick(70);
    r.cyl.neutralizeOut();
    r.tick(70);
    expect(r.drive.currentPosition).toBeCloseTo(0, 3);
  });

  it('released Enable binding evaluates the current level (no stale pulse)', () => {
    const r = build('SingleActingPositive', { withEnable: true });
    r.cyl.commandEnable(false);
    r.cyl.commandOut(true);
    r.tick(30);
    expect(r.drive.currentPosition).toBe(0);
    r.cyl.neutralizeEnable();
    r.tick(70);
    expect(r.drive.currentPosition).toBeCloseTo(100, 3);
  });
});

describe('plan-570 — Legacy stays the default', () => {
  it('a new cylinder defaults to Legacy and latches a pulse', () => {
    expect(new RVDriveCylinder(new Object3D()).Mode).toBe('Legacy');
    const r = build('Legacy');
    r.store.setByPath(OUT, true);
    r.store.setByPath(OUT, false);
    r.tick(70);
    expect(r.drive.currentPosition).toBeCloseTo(100, 3);
  });
});
