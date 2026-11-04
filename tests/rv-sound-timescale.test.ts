// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2019 §9.11 / C5 — the sound follows the simulation speed: envelopes run
 * in SIMULATION time (k = 2 → the stroke slide and the relief hold last half the
 * wall time), a factor change mid-envelope (0→1, 1→2, 2→0→2) continues from
 * where it was, pause / k = 0 freeze and fade all voices to 0 within 80 ms, and
 * above k = 4 at most 10 one-shots per second sound.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { Object3D, PerspectiveCamera } from 'three';
import { RELIEF_DECAY, RELIEF_HOLD, RVSoundSampler } from '../src/core/audio/rv-sound-sampler';
import {
  MAX_ONE_SHOTS_PER_SECOND_FAST, ONE_SHOT_QUEUE, PAUSE_FADE, RVSoundEngine, audioStats, getSharedAudioContext, setAudioContextFactory,
  type SoundSourceView,
} from '../src/core/audio/rv-audio-engine';
import { SOUND_EVENT_END_STOP, SOUND_EVENT_RELIEF, SOUND_EVENT_VALVE_TICK } from '../src/core/audio/rv-sound-sampler';
import type { SoundDriveLike } from '../src/core/engine/rv-sound';
import { FakeAudioContext, fakeAudioFactory, type FakeGain } from './helpers/fake-audio';

const DT = 1 / 60;

function cylDrive(): SoundDriveLike {
  // Stroke 100 at 200 units per SIM second = 0.5 s stroke.
  return { node: new Object3D(), name: 'C', currentPosition: 0, TargetSpeed: 200, targetSpeed: 200, targetPosition: 100 };
}

/** Wall seconds the slide envelope of one stroke lasts at speed factor k. */
function slideWallTime(k: number): number {
  const s = new RVSoundSampler();
  const d = cylDrive();
  s.setSources([{ drive: d, kind: 'Cylinder', cylinder: { MinPos: 0, MaxPos: 100 } }]);
  s.sample(DT, k, false, null);
  let t = 0; let started = false; let last = 0;
  for (let i = 0; i < 600; i++) {
    d.currentPosition = Math.min(100, d.currentPosition + 200 * k * DT); // visibly k× faster
    s.sample(DT, k, false, null);
    t += DT;
    if (s.slide[0] > 0) { started = true; last = t; }
    if (started && s.slide[0] === 0 && t > last + 0.1) break;
  }
  return last;
}

describe('speed factor (plan-2019 9.11 / C5)', () => {
  it('k = 2 → the slide envelope lasts half the wall time', () => {
    const one = slideWallTime(1);
    const two = slideWallTime(2);
    expect(one).toBeGreaterThan(0.4);
    expect(two / one).toBeCloseTo(0.5, 1);
  });

  /** Hydraulic relief: wall seconds from the arrival to the end of the relief envelope. */
  function reliefRun(schedule: (wall: number) => number): { end: number; frozenStable: boolean } {
    const s = new RVSoundSampler();
    const d: SoundDriveLike = { node: new Object3D(), name: 'H', currentPosition: 0, TargetSpeed: 100, targetSpeed: 100, targetPosition: 50 };
    s.setSources([{ drive: d, kind: 'Hydraulic', cylinder: null }]);
    s.sample(DT, 1, false, null);
    // Move to the target and stop there → relief starts.
    for (let i = 0; i < 40 && d.currentPosition < 50; i++) { d.currentPosition = Math.min(50, d.currentPosition + 100 * DT); s.sample(DT, 1, false, null); }
    let wall = 0;
    let frozenStable = true;
    let started = false;
    for (let i = 0; i < 1200; i++) {
      const k = schedule(wall);
      const before = s.relief[0];
      s.sample(DT, k, false, null);
      if (s.relief[0] > 0) started = true;
      if (k === 0 && started && s.relief[0] !== before) frozenStable = false;
      wall += DT;
      if (started && s.relief[0] === 0 && s.load[0] < 1) return { end: wall, frozenStable };
    }
    return { end: Infinity, frozenStable };
  }

  it('relief hold runs in sim time: k 1 → 2 mid-envelope, and 2 → 0 → 2 freezes in between', () => {
    const total = RELIEF_HOLD + RELIEF_DECAY; // 2.8 sim s
    const k1 = reliefRun(() => 1);
    expect(k1.end).toBeGreaterThan(total - 0.2);
    expect(k1.end).toBeLessThan(total + 0.3);
    // 1 s at k = 1, then k = 2: 1 + 1.8 / 2 ≈ 1.9 s
    const k12 = reliefRun((w) => (w < 1 ? 1 : 2));
    expect(k12.end).toBeGreaterThan(1.7);
    expect(k12.end).toBeLessThan(2.15);
    // 0 → 1: the first 0.5 s nothing advances
    const k01 = reliefRun((w) => (w < 0.5 ? 0 : 1));
    expect(k01.end).toBeGreaterThan(k1.end + 0.3);
    // 2 → 0 → 2: 0.5 s at 2, 1 s frozen, then 2 again → 0.5 + 1 + (2.8 − 1) / 2 ≈ 2.4 s
    const k202 = reliefRun((w) => (w < 0.5 ? 2 : w < 1.5 ? 0 : 2));
    expect(k202.frozenStable).toBe(true);
    expect(k202.end).toBeGreaterThan(2.2);
    expect(k202.end).toBeLessThan(2.65);
  });
});

describe('engine pause and one-shot budget (plan-2019 9.11)', () => {
  const engines: RVSoundEngine[] = [];
  afterEach(() => { for (const e of engines) e.dispose(); engines.length = 0; setAudioContextFactory(null); FakeAudioContext.reset(); });

  function setup(): { e: RVSoundEngine; ctx: FakeAudioContext; view: SoundSourceView } {
    FakeAudioContext.reset();
    setAudioContextFactory(fakeAudioFactory());
    const e = new RVSoundEngine(); engines.push(e);
    e.activate(); e.setEnabled(true);
    const node = new Object3D(); node.updateMatrixWorld(true);
    const drive: SoundDriveLike = { node, name: 'C', currentPosition: 0, TargetSpeed: 100, targetSpeed: 100, targetPosition: 0 };
    const view: SoundSourceView = { node, drive, cylinder: { MinPos: 0, MaxPos: 100 }, kind: 'Cylinder', variant: 'Hard', volume: 1 };
    e.setSources([view]);
    return { e, ctx: getSharedAudioContext() as unknown as FakeAudioContext, view };
  }

  it('pause → all voices fade to 0 within 80 ms; resume fades back in', () => {
    const { e, ctx } = setup();
    const cam = new PerspectiveCamera(); cam.updateMatrixWorld(true);
    e.frame({ dt: DT, timeFactor: 1, paused: false, listener: cam });
    ctx.currentTime = 1;
    e.frame({ dt: DT, timeFactor: 1, paused: true, listener: cam });
    // The pause bus is the first gain after the master.
    const bus = (e as unknown as { _pause: FakeGain })._pause;
    const ramp = bus.gain.last('linearRamp')!;
    expect(ramp.value).toBe(0);
    expect(ramp.time - 1).toBeCloseTo(PAUSE_FADE);
    // k = 0 is a pause as well
    ctx.currentTime = 2;
    e.frame({ dt: DT, timeFactor: 1, paused: false, listener: cam });
    expect(bus.gain.last('linearRamp')!.value).toBe(1);
    e.frame({ dt: DT, timeFactor: 0, paused: false, listener: cam });
    expect(bus.gain.last('linearRamp')!.value).toBe(0);
  });

  it('k = 8 → at most 10 one-shots per second', () => {
    const { e, ctx } = setup();
    const cam = new PerspectiveCamera(); cam.updateMatrixWorld(true);
    e.frame({ dt: DT, timeFactor: 8, paused: false, listener: cam });
    const before = audioStats.oneShots;
    for (let i = 0; i < 40; i++) {
      ctx.currentTime += 0.025; // 40 events in one second
      e.onSoundEvent(0, SOUND_EVENT_VALVE_TICK);
    }
    expect(audioStats.oneShots - before).toBeLessThanOrEqual(MAX_ONE_SHOTS_PER_SECOND_FAST);
    expect(e.activeOneShots()).toBeLessThanOrEqual(8);
  });

  it('at k = 1 every event sounds, but never more than 8 at once', () => {
    const { e, ctx } = setup();
    const cam = new PerspectiveCamera(); cam.updateMatrixWorld(true);
    e.frame({ dt: DT, timeFactor: 1, paused: false, listener: cam });
    const before = audioStats.oneShots;
    for (let i = 0; i < 20; i++) { ctx.currentTime += 0.001; e.onSoundEvent(0, SOUND_EVENT_VALVE_TICK); }
    expect(audioStats.oneShots - before).toBe(20);
    expect(e.activeOneShots()).toBeLessThanOrEqual(8);
  });
it('k = 8 → a bounded queue drops the OLDEST pending event, the newest end stop still sounds (fix-1 #11)', () => {
    const { e, ctx } = setup();
    const cam = new PerspectiveCamera(); cam.updateMatrixWorld(true);
    e.frame({ dt: DT, timeFactor: 8, paused: false, listener: cam });
    const started: number[] = [];
    const startsBefore = audioStats.oneShots;
    const endStopsBefore = audioStats.byEvent[SOUND_EVENT_END_STOP];
    const droppedBefore = audioStats.droppedOneShots;
    // Exhaust the 10-per-second budget …
    for (let i = 0; i < MAX_ONE_SHOTS_PER_SECOND_FAST; i++) { ctx.currentTime += 0.01; e.onSoundEvent(0, SOUND_EVENT_VALVE_TICK); }
    expect(audioStats.oneShots - startsBefore).toBe(MAX_ONE_SHOTS_PER_SECOND_FAST);
    // … then 5 ticks and, last, an end stop within the same second: the queue holds 4,
    // the two OLDEST ticks are dropped, the end stop waits.
    for (let i = 0; i < 5; i++) { ctx.currentTime += 0.01; e.onSoundEvent(0, SOUND_EVENT_VALVE_TICK); }
    ctx.currentTime += 0.01;
    e.onSoundEvent(0, SOUND_EVENT_END_STOP);
    expect(e.pendingOneShots).toBe(ONE_SHOT_QUEUE);
    expect(audioStats.droppedOneShots - droppedBefore).toBe(2);
    expect(audioStats.byEvent[SOUND_EVENT_END_STOP] - endStopsBefore).toBe(0);
    // Frames drain the queue once the rate window allows — at most 10 starts per second.
    const t0 = ctx.currentTime;
    for (let i = 0; i < 90; i++) {
      ctx.currentTime += DT;
      const before = audioStats.oneShots;
      e.frame({ dt: DT, timeFactor: 8, paused: false, listener: cam });
      for (let n = audioStats.oneShots - before; n > 0; n--) started.push(ctx.currentTime);
    }
    expect(e.pendingOneShots).toBe(0);
    expect(audioStats.byEvent[SOUND_EVENT_END_STOP] - endStopsBefore).toBe(1);
    expect(started.length).toBe(ONE_SHOT_QUEUE);
    expect(started[0] - t0).toBeGreaterThan(0.85); // waited for the 1 s window
  });

  it('RELIEF is no one-shot: no panner, no node (fix-1 #8)', () => {
    const { e, ctx } = setup();
    const cam = new PerspectiveCamera(); cam.updateMatrixWorld(true);
    e.frame({ dt: DT, timeFactor: 1, paused: false, listener: cam });
    const panners = ctx.counters.panners;
    const gains = ctx.counters.gains;
    e.onSoundEvent(0, SOUND_EVENT_RELIEF);
    expect(ctx.counters.panners).toBe(panners);
    expect(ctx.counters.gains).toBe(gains);
  });
});
