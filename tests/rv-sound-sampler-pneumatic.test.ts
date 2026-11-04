// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2019 §9.5 / C2 — edge rules of the cylinder and hydraulic sounds on REAL
 * drives (rig pattern of drive-cylinder-mode.test.ts): start → one tick, end
 * position → exactly one end stop, stop mid-stroke → nothing, reset homing →
 * nothing, a stroke shorter than one frame → tick + end stop, wobble → no second
 * stop, rotary drive (degrees) the same. Hydraulic on a cylinder, on a plain
 * positioning Drive and on a jogged Drive (C2).
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
import type { ResolvedSoundKind } from '../src/core/engine/rv-sound';
import {
  RVSoundSampler, SOUND_EVENT_END_STOP, SOUND_EVENT_HYDRAULIC_TOCK, SOUND_EVENT_RELIEF, SOUND_EVENT_VALVE_TICK,
} from '../src/core/audio/rv-sound-sampler';

const OUT = 'Cyl/Out';
const IN = 'Cyl/In';
const EN = 'Cyl/Enable';
const DT = 1 / 60;

interface Rig {
  drive: RVDrive;
  cyl: RVDriveCylinder;
  store: SignalStore;
  sampler: RVSoundSampler;
  events: number[];
  /** n fixed steps, one render frame each (or two render frames per step). */
  step(n?: number, framesPerStep?: number): void;
}

function build(opts: { mode?: DriveCylinderMode; kind?: ResolvedSoundKind; rotary?: boolean; time?: number; enable?: boolean; max?: number } = {}): Rig {
  const store = new SignalStore();
  store.register(OUT, OUT, false, 'PLCOutputBool');
  store.register(IN, IN, false, 'PLCOutputBool');
  store.register(EN, EN, true, 'PLCOutputBool');
  const registry = new NodeRegistry();
  const node = new Object3D();
  node.name = 'CylAxis';
  const drive = new RVDrive(node);
  drive.Direction = opts.rotary ? DriveDirection.RotationZ : DriveDirection.LinearX;
  drive.TargetSpeed = 100;
  drive.UseAcceleration = false;
  drive.UseLimits = false;
  drive.initDrive();
  registry.register('Drive', NodeRegistry.computeNodePath(node), drive);
  const cyl = new RVDriveCylinder(node);
  cyl.MinPos = 0;
  cyl.MaxPos = opts.max ?? (opts.rotary ? 90 : 100);
  cyl.TimeOut = opts.time ?? 0.5;
  cyl.TimeIn = opts.time ?? 0.5;
  cyl.Mode = opts.mode ?? 'Legacy';
  cyl.Out = OUT;
  cyl.In = IN;
  if (opts.enable) cyl.Enable = EN;
  cyl.init({ registry, signalStore: store, reapply: new SignalReapplyRegistry(), events: new EventEmitter() } as unknown as ComponentContext);
  const sampler = new RVSoundSampler();
  sampler.setSources([{ drive, kind: opts.kind ?? 'Cylinder', cylinder: cyl }]);
  const events: number[] = [];
  const sink = { onSoundEvent: (_i: number, e: number) => { events.push(e); } };
  sampler.sample(DT, 1, false, sink);
  return {
    drive, cyl, store, sampler, events,
    step(n = 1, framesPerStep = 1) {
      for (let i = 0; i < n; i++) {
        drive.update(DT);
        for (let f = 0; f < framesPerStep; f++) sampler.sample(DT / framesPerStep, 1, false, sink);
      }
    },
  };
}

const count = (ev: number[], e: number): number => ev.filter((x) => x === e).length;

describe('cylinder sound edges (plan-2019 9.5)', () => {
  it('start → one tick, end position → exactly one end stop', () => {
    const r = build();
    r.store.setByPath(OUT, true);
    r.step(60);
    expect(count(r.events, SOUND_EVENT_VALVE_TICK)).toBe(1);
    expect(count(r.events, SOUND_EVENT_END_STOP)).toBe(1);
    // back in: one more of each
    r.store.setByPath(OUT, false);
    r.store.setByPath(IN, true);
    r.step(60);
    expect(count(r.events, SOUND_EVENT_VALVE_TICK)).toBe(2);
    expect(count(r.events, SOUND_EVENT_END_STOP)).toBe(2);
  });

  it('the same with two render frames per fixed step (frames without motion are normal)', () => {
    const r = build();
    r.store.setByPath(OUT, true);
    r.step(60, 2);
    expect(r.events).toEqual([SOUND_EVENT_VALVE_TICK, SOUND_EVENT_END_STOP]);
  });

  it('DoubleActing stop mid-stroke → no end stop', () => {
    const r = build({ mode: 'DoubleActing' });
    r.store.setByPath(OUT, true);
    r.step(10);
    r.store.setByPath(OUT, false); // closed centre: holds
    r.step(30);
    expect(r.events).toEqual([SOUND_EVENT_VALVE_TICK]);
  });

  it('Enable hold mid-stroke → no end stop; release → new tick + one end stop', () => {
    const r = build({ enable: true });
    r.store.setByPath(OUT, true);
    r.step(10);
    r.store.setByPath(EN, false);
    r.step(30);
    expect(r.events).toEqual([SOUND_EVENT_VALVE_TICK]);
    r.store.setByPath(EN, true);
    r.step(60);
    expect(r.events).toEqual([SOUND_EVENT_VALVE_TICK, SOUND_EVENT_VALVE_TICK, SOUND_EVENT_END_STOP]);
  });

  it('stop() from outside mid-stroke → nothing', () => {
    const r = build();
    r.store.setByPath(OUT, true);
    r.step(10);
    r.drive.stop();
    r.step(30);
    expect(r.events).toEqual([SOUND_EVENT_VALVE_TICK]);
  });

  it('simulation reset homing → nothing until standstill', () => {
    const r = build({ time: 2 });
    r.store.setByPath(OUT, true);
    r.step(150); // reaches MaxPos (tick + stop)
    r.events.length = 0;
    r.sampler.notifyReset();
    // homing move back without a teleport
    r.drive.targetSpeed = 100;
    r.drive.startMove(0);
    r.step(90);
    expect(r.events).toEqual([]);
    // after the standstill the next real stroke sounds again
    r.drive.targetSpeed = 100;
    r.drive.startMove(100);
    r.step(90);
    expect(r.events).toEqual([SOUND_EVENT_VALVE_TICK, SOUND_EVENT_END_STOP]);
  });

  it('a stroke shorter than one frame → tick + end stop together', () => {
    const r = build({ time: 0.005 });
    r.store.setByPath(OUT, true);
    r.step(5);
    expect(r.events).toEqual([SOUND_EVENT_VALVE_TICK, SOUND_EVENT_END_STOP]);
  });

  it('wobble at the end position → no second end stop', () => {
    const r = build();
    r.store.setByPath(OUT, true);
    r.step(60);
    for (let i = 0; i < 20; i++) {
      r.drive.currentPosition = 100 - (i % 2) * 0.5;
      r.sampler.sample(DT, 1, false, { onSoundEvent: (_i, e) => r.events.push(e) });
    }
    expect(count(r.events, SOUND_EVENT_END_STOP)).toBe(1);
  });

  it('a rotary drive (degrees) behaves the same', () => {
    const r = build({ rotary: true });
    r.store.setByPath(OUT, true);
    r.step(60);
    expect(r.events).toEqual([SOUND_EVENT_VALVE_TICK, SOUND_EVENT_END_STOP]);
  });

  it('a seek (teleport) is no stroke — no tick, no end stop', () => {
    const r = build();
    r.drive.currentPosition = 100;
    r.step(5);
    expect(r.events).toEqual([]);
  });
});

describe('hydraulic sound edges (plan-2019 C2)', () => {
  it('on a Drive_Cylinder: start tock, end position → tock + relief, no clack', () => {
    const r = build({ kind: 'Hydraulic' });
    r.store.setByPath(OUT, true);
    r.step(60);
    expect(r.events).toEqual([SOUND_EVENT_HYDRAULIC_TOCK, SOUND_EVENT_HYDRAULIC_TOCK, SOUND_EVENT_RELIEF]);
    expect(count(r.events, SOUND_EVENT_END_STOP)).toBe(0);
    expect(r.sampler.relief[0]).toBeGreaterThan(0);
    expect(r.sampler.load[0]).toBe(1);
  });

  it('on a Drive_Cylinder: stop mid-stroke → tock only', () => {
    const r = build({ kind: 'Hydraulic', mode: 'DoubleActing' });
    r.store.setByPath(OUT, true);
    r.step(10);
    r.store.setByPath(OUT, false);
    r.step(30);
    expect(r.events).toEqual([SOUND_EVENT_HYDRAULIC_TOCK, SOUND_EVENT_HYDRAULIC_TOCK]);
  });

  function plainDrive(): { drive: RVDrive; sampler: RVSoundSampler; events: number[]; step(n: number): void } {
    const node = new Object3D();
    const drive = new RVDrive(node);
    drive.Direction = DriveDirection.LinearX;
    drive.TargetSpeed = 100;
    drive.UseAcceleration = false;
    drive.UseLimits = false;
    drive.initDrive();
    const sampler = new RVSoundSampler();
    sampler.setSources([{ drive, kind: 'Hydraulic', cylinder: null }]);
    const events: number[] = [];
    const sink = { onSoundEvent: (_i: number, e: number) => { events.push(e); } };
    sampler.sample(DT, 1, false, sink);
    return { drive, sampler, events, step(n: number) { for (let i = 0; i < n; i++) { drive.update(DT); sampler.sample(DT, 1, false, sink); } } };
  }

  it('on a plain Drive: stop at its target after a move → tock + relief; flow follows v', () => {
    const r = plainDrive();
    r.drive.targetSpeed = 100;
    r.drive.startMove(50);
    r.step(12);
    expect(r.sampler.flow[0]).toBeGreaterThan(0.5);
    r.step(50);
    expect(r.events).toEqual([SOUND_EVENT_HYDRAULIC_TOCK, SOUND_EVENT_HYDRAULIC_TOCK, SOUND_EVENT_RELIEF]);
  });

  it('on a plain Drive without a target (jog end) → tock only', () => {
    const r = plainDrive();
    r.drive.targetPosition = 999;
    r.drive.jogForward = true;
    r.step(30);
    r.drive.jogForward = false;
    r.drive.stop();
    r.step(30);
    expect(r.events).toEqual([SOUND_EVENT_HYDRAULIC_TOCK, SOUND_EVENT_HYDRAULIC_TOCK]);
  });
/** A hydraulic cylinder driven frame by frame (positions chosen by the test). */
  function scripted(): { pos: number; sampler: RVSoundSampler; events: number[]; moveTo(target: number, speed?: number): void; hold(frames: number): void } {
    const node = new Object3D();
    const drive = { node, name: 'H', currentPosition: 0, TargetSpeed: 100, targetSpeed: 100, targetPosition: 100 };
    const sampler = new RVSoundSampler();
    sampler.setSources([{ drive, kind: 'Hydraulic', cylinder: { MinPos: 0, MaxPos: 100 } }]);
    const events: number[] = [];
    const sink = { onSoundEvent: (_i: number, e: number) => { events.push(e); } };
    sampler.sample(DT, 1, false, sink);
    const r = {
      get pos() { return drive.currentPosition; },
      sampler, events,
      moveTo(target: number, speed = 100) {
        while (Math.abs(target - drive.currentPosition) > 1e-9) {
          const step = Math.min(speed * DT, Math.abs(target - drive.currentPosition));
          drive.currentPosition += Math.sign(target - drive.currentPosition) * step;
          sampler.sample(DT, 1, false, sink);
        }
      },
      hold(frames: number) { for (let i = 0; i < frames; i++) sampler.sample(DT, 1, false, sink); },
    };
    return r as unknown as { pos: number; sampler: RVSoundSampler; events: number[]; moveTo(target: number, speed?: number): void; hold(frames: number): void };
  }

  it('on a Drive_Cylinder: entering the end band while still moving is only pending (fix-1 #4)', () => {
    const r = scripted();
    r.moveTo(99.5); // inside the 1 % band, still moving
    expect(r.events).toEqual([SOUND_EVENT_HYDRAULIC_TOCK]); // start only — no stop tock, no relief yet
    expect(r.sampler.relief[0]).toBe(0);
    r.moveTo(100);
    r.hold(10); // confirmed standstill in the same end position
    expect(r.events).toEqual([SOUND_EVENT_HYDRAULIC_TOCK, SOUND_EVENT_HYDRAULIC_TOCK, SOUND_EVENT_RELIEF]);
    expect(r.sampler.load[0]).toBe(1);
  });

  it('on a Drive_Cylinder: reversing inside the end band → no pressure relief, tock at the real stop only', () => {
    const r = scripted();
    r.moveTo(99.5);
    r.moveTo(50); // reverses without stopping, leaves the band
    expect(r.events).toEqual([SOUND_EVENT_HYDRAULIC_TOCK]);
    r.hold(10); // stops mid-stroke
    expect(r.events).toEqual([SOUND_EVENT_HYDRAULIC_TOCK, SOUND_EVENT_HYDRAULIC_TOCK]);
    expect(count(r.events, SOUND_EVENT_RELIEF)).toBe(0);
    expect(r.sampler.relief[0]).toBe(0);
  });
});

