// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2019 follow-up: event sounds on plain drives (no Drive_Cylinder needed) and the
 * deterministic per-instance variation.
 *
 * - kind Drive: a subtle start transient and a brake transient, nothing at standstill;
 * - kind Cylinder on a plain drive: an end-stop knock when the move ends at its target,
 *   silence when it stops anywhere else, a slide while it moves;
 * - kind Hydraulic on a plain drive: tock + relief at the target (unchanged);
 * - the variation of a Sound is fixed (same node id = same factors), inside the spread.
 */
import { describe, expect, it } from 'vitest';
import { Object3D } from 'three';
import {
  RVSoundSampler, SOUND_EVENT_END_STOP, SOUND_EVENT_HYDRAULIC_TOCK, SOUND_EVENT_MOTOR_BRAKE,
  SOUND_EVENT_MOTOR_START, SOUND_EVENT_RELIEF, SOUND_EVENT_VALVE_TICK,
} from '../src/core/audio/rv-sound-sampler';
import { LEVEL_SPREAD, PITCH_SPREAD, soundVariation } from '../src/core/audio/rv-sound-variation';
import { VOICE_COUNT } from '../src/core/audio/rv-audio-engine';
import type { ResolvedSoundKind, SoundDriveLike } from '../src/core/engine/rv-sound';

const DT = 1 / 60;

function rig(kind: ResolvedSoundKind) {
  const drive: SoundDriveLike = {
    node: new Object3D(), name: 'D', currentPosition: 0, TargetSpeed: 100, targetSpeed: 100, targetPosition: 0,
  };
  const sampler = new RVSoundSampler();
  sampler.setSources([{ drive, kind, cylinder: null }]);
  const events: number[] = [];
  const sink = { onSoundEvent: (_i: number, e: number) => { events.push(e); } };
  const frames = (n: number, speed: number): void => {
    for (let f = 0; f < n; f++) { drive.currentPosition += speed * DT; sampler.sample(DT, 1, false, sink); }
  };
  return { drive, sampler, events, frames };
}

describe('event sounds on plain drives', () => {
  it('Drive: standstill is silent, a move gives one start and one brake transient', () => {
    const { frames, events } = rig('Drive');
    frames(600, 0);
    expect(events).toEqual([]);
    frames(60, 100); // 1 s at full speed
    frames(30, 0); // standstill: the stop edge
    expect(events).toEqual([SOUND_EVENT_MOTOR_START, SOUND_EVENT_MOTOR_BRAKE]);
    frames(600, 0);
    expect(events.length).toBe(2);
  });

  it('Cylinder without end positions: knock when the move ends at its target, slide while moving', () => {
    const r = rig('Cylinder');
    r.drive.targetPosition = 100;
    r.frames(1, 0);
    let slide = 0;
    for (let f = 0; f < 60; f++) { r.frames(1, 100); slide = Math.max(slide, r.sampler.slide[0]); }
    r.frames(30, 0);
    expect(slide).toBeGreaterThan(0.5);
    expect(r.events).toEqual([SOUND_EVENT_VALVE_TICK, SOUND_EVENT_END_STOP]);
    expect(r.sampler.slide[0]).toBe(0);
  });

  it('Cylinder without end positions: stopped away from the target is silent (no knock)', () => {
    const r = rig('Cylinder');
    r.drive.targetPosition = 500;
    r.frames(1, 0);
    r.frames(60, 100); // 100 mm of 500
    r.frames(30, 0);
    expect(r.events).toEqual([SOUND_EVENT_VALVE_TICK]);
  });

  it('Hydraulic on a plain drive: tock at the start, tock + relief at the target', () => {
    const r = rig('Hydraulic');
    r.drive.targetPosition = 100;
    r.frames(1, 0);
    r.frames(60, 100);
    r.frames(30, 0);
    expect(r.events).toEqual([SOUND_EVENT_HYDRAULIC_TOCK, SOUND_EVENT_HYDRAULIC_TOCK, SOUND_EVENT_RELIEF]);
  });
});

describe('per-instance variation', () => {
  it('is deterministic: the same seed gives the same factors every time', () => {
    const a = soundVariation('node-id-1');
    const b = soundVariation('node-id-1');
    expect(a).toEqual(b);
    expect(soundVariation('node-id-2')).not.toEqual(a);
  });

  it('stays inside the spread and really spreads over many seeds', () => {
    let pMin = 9, pMax = 0, lMin = 9, lMax = 0;
    for (let i = 0; i < 500; i++) {
      const v = soundVariation(`NodeId-${i}`);
      expect(v.pitch).toBeGreaterThanOrEqual(1 - PITCH_SPREAD - 1e-9);
      expect(v.pitch).toBeLessThanOrEqual(1 + PITCH_SPREAD + 1e-9);
      expect(v.level).toBeGreaterThanOrEqual(1 - LEVEL_SPREAD - 1e-9);
      expect(v.level).toBeLessThanOrEqual(1 + LEVEL_SPREAD + 1e-9);
      pMin = Math.min(pMin, v.pitch); pMax = Math.max(pMax, v.pitch);
      lMin = Math.min(lMin, v.level); lMax = Math.max(lMax, v.level);
    }
    expect(pMax - pMin).toBeGreaterThan(1.8 * PITCH_SPREAD);
    expect(lMax - lMin).toBeGreaterThan(1.8 * LEVEL_SPREAD);
  });

  it('the pitch spread is 5-8 percent and the level spread about 10 percent', () => {
    expect(PITCH_SPREAD).toBeGreaterThanOrEqual(0.05);
    expect(PITCH_SPREAD).toBeLessThanOrEqual(0.08);
    expect(LEVEL_SPREAD).toBeCloseTo(0.1, 5);
  });
});

describe('voice limit', () => {
  it('defaults to six continuous voices', () => {
    expect(VOICE_COUNT).toBe(6);
  });
});
