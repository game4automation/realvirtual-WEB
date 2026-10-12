// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * drive-cylinder-feedback-init.test.ts — plan-538 F2 / F6.
 *
 * Before plan-538 a cylinder wrote `IsIn/IsOut/IsMin/IsMax` only on a CHANGE,
 * so a PLC waiting for "in home" right after load hung until a first move.
 * Now the feedback is written from the actual pose at init (before any logic
 * starts) and again after a simulation reset — for a "real" cylinder (feedback
 * on PLC signal addresses) and a "virtual" one (feedback read through the
 * FeedbackSource contract by a direct-feedback binding listener). The reset is
 * driven through the production `RVViewer.prototype.resetSimulation`.
 */

import { describe, expect, it } from 'vitest';
import { Object3D } from 'three';
import { RVDrive, DriveDirection } from '../src/core/engine/rv-drive';
import { RVDriveCylinder } from '../src/core/engine/rv-drive-cylinder';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { EventEmitter } from '../src/core/rv-events';
import { RVViewer } from '../src/core/rv-viewer';
import { RVLogicEngine } from '../src/core/engine/rv-logic-engine';
import { RVSerialContainer, RVWaitForSignalBool, StepState } from '../src/core/engine/rv-logic-step';
import type { ComponentContext } from '../src/core/engine/rv-component-registry';

const SIG = {
  out: 'Cyl/Out', in: 'Cyl/In',
  isOut: 'Cyl/IsOut', isIn: 'Cyl/IsIn', isMax: 'Cyl/IsMax', isMin: 'Cyl/IsMin',
};

interface Rig {
  drive: RVDrive;
  cyl: RVDriveCylinder;
  store: SignalStore;
  events: EventEmitter<Record<string, unknown>>;
  tick(n?: number): void;
}

function buildCylinder(opts: { min?: number; max?: number; startPosition?: number; withSignals?: boolean; preset?: Partial<Record<keyof typeof SIG, boolean>> } = {}): Rig {
  const store = new SignalStore();
  for (const [key, addr] of Object.entries(SIG)) {
    store.register(addr, addr, opts.preset?.[key as keyof typeof SIG] ?? false, key.startsWith('is') ? 'PLCInputBool' : 'PLCOutputBool');
  }
  const registry = new NodeRegistry();
  const node = new Object3D();
  node.name = 'CylAxis';
  const drive = new RVDrive(node);
  drive.Direction = DriveDirection.LinearX;
  drive.StartPosition = opts.startPosition ?? 0;
  drive.TargetSpeed = 100;
  drive.UseAcceleration = false;
  drive.UseLimits = false;
  drive.initDrive();
  registry.register('Drive', NodeRegistry.computeNodePath(node), drive);

  const cyl = new RVDriveCylinder(node);
  cyl.MinPos = opts.min ?? 0;
  cyl.MaxPos = opts.max ?? 100;
  cyl.TimeOut = 0.5;
  cyl.TimeIn = 0.5;
  if (opts.withSignals !== false) {
    cyl.Out = SIG.out; cyl.In = SIG.in;
    cyl.IsOut = SIG.isOut; cyl.IsIn = SIG.isIn; cyl.IsMax = SIG.isMax; cyl.IsMin = SIG.isMin;
  }
  const events = new EventEmitter<Record<string, unknown>>();
  cyl.init({ registry, signalStore: store, events } as unknown as ComponentContext);
  return {
    drive, cyl, store, events,
    tick(n = 1) { for (let i = 0; i < n; i++) drive.update(1 / 60); },
  };
}

/** Narrow fake viewer for the production resetSimulation (pattern: logic-step-reset-restart.test.ts). */
function resetVia(rig: Rig, logicEngine: RVLogicEngine | null = null, order?: string[]): void {
  const fake = {
    _simTime: 5,
    drives: [rig.drive],
    chainManager: { resetAll() {} },
    ribbonManager: { resetAll() {} },
    transportManager: { reset() {} },
    logicEngine,
    _kernel: null,
    statisticsManager: { resetAll() {} },
    signalReapply: { reapplyAll() { order?.push('reapply'); } },
    emit(event: string) { order?.push(event); rig.events.emit(event, undefined); },
  };
  (RVViewer.prototype.resetSimulation as unknown as (this: typeof fake) => void).call(fake);
}

describe('plan-538 F2 — Drive_Cylinder feedback from the actual pose', () => {
  it('real cylinder at MinPos: IsIn/IsMin true, IsOut/IsMax false right after init — no move needed', () => {
    // Stale store values from the GLB (IsIn false, IsOut true) must be corrected at init.
    const r = buildCylinder({ preset: { isIn: false, isOut: true, isMax: true } });
    expect(r.drive.currentPosition).toBe(0);
    expect(r.store.getBoolByPath(SIG.isIn)).toBe(true);
    expect(r.store.getBoolByPath(SIG.isMin)).toBe(true);
    expect(r.store.getBoolByPath(SIG.isOut)).toBe(false);
    expect(r.store.getBoolByPath(SIG.isMax)).toBe(false);
  });

  it('virtual cylinder (FeedbackSource read by a binding listener) reports the home pose at init', () => {
    const r = buildCylinder({ withSignals: false });
    expect(r.cyl.readFeedbackSlot('IsIn')).toBe(true);
    expect(r.cyl.readFeedbackSlot('IsOut')).toBe(false);
  });

  it('cylinder whose drive starts at MaxPos: IsOut/IsMax true, IsIn false at init', () => {
    const r = buildCylinder({ startPosition: 100 });
    expect(r.drive.currentPosition).toBe(100);
    expect(r.store.getBoolByPath(SIG.isOut)).toBe(true);
    expect(r.store.getBoolByPath(SIG.isMax)).toBe(true);
    expect(r.store.getBoolByPath(SIG.isIn)).toBe(false);
    expect(r.cyl.readFeedbackSlot('IsOut')).toBe(true);
  });

  it('after a simulation reset the feedback is re-initialised (real + virtual), even with StartPosition ≠ MinPos', () => {
    const r = buildCylinder({ min: 10, max: 90, startPosition: 0 });
    expect(r.drive.currentPosition).toBe(10);
    r.store.setByPath(SIG.out, true);
    r.tick(60);
    expect(r.drive.currentPosition).toBeCloseTo(90, 3);
    expect(r.store.getBoolByPath(SIG.isOut)).toBe(true);
    expect(r.store.getBoolByPath(SIG.isIn)).toBe(false);

    let listenerCalls = 0;
    let listenerSawIn = false;
    r.cyl.addFeedbackListener(() => { listenerCalls++; listenerSawIn = r.cyl.readFeedbackSlot('IsIn') === true; });
    r.store.setByPath(SIG.out, false);
    // Someone (a stale write) put IsIn into a wrong state before the reset.
    r.store.setByPath(SIG.isIn, false);
    resetVia(r);
    // Drive.reset() went to StartPosition 0; the cylinder returned to its home 10.
    expect(r.drive.currentPosition).toBe(10);
    expect(r.store.getBoolByPath(SIG.isIn)).toBe(true);
    expect(r.store.getBoolByPath(SIG.isMin)).toBe(true);
    expect(r.store.getBoolByPath(SIG.isOut)).toBe(false);
    expect(r.store.getBoolByPath(SIG.isMax)).toBe(false);
    expect(listenerCalls).toBeGreaterThan(0);
    expect(listenerSawIn).toBe(true);
  });

  it('the reset re-initialises the feedback BEFORE the logic restarts (a WaitFor IsIn step finishes at its start)', () => {
    const r = buildCylinder();
    const wait = new RVWaitForSignalBool(SIG.isIn, true, r.store);
    wait.name = 'WaitHome';
    const seq = new RVSerialContainer([wait], false);
    seq.name = 'Seq';
    const engine = new RVLogicEngine();
    engine.roots.push(seq);
    engine.start();
    // Move out, so IsIn is false right before the reset.
    r.store.setByPath(SIG.out, true);
    r.tick(60);
    expect(r.store.getBoolByPath(SIG.isIn)).toBe(false);
    r.store.setByPath(SIG.out, false);

    const order: string[] = [];
    let isInAtLogicStart: boolean | null = null;
    const origStart = engine.start.bind(engine);
    engine.start = (c?: boolean) => { isInAtLogicStart = r.store.getBoolByPath(SIG.isIn); order.push('logic-start'); origStart(c); };
    resetVia(r, engine, order);
    expect(isInAtLogicStart).toBe(true);
    expect(order.indexOf('simulation-start')).toBeLessThan(order.indexOf('logic-start'));
    expect(wait.state).toBe(StepState.Finished);
  });
});
