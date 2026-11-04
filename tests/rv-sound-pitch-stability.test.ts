// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2019 follow-up (Thomas 2026-10-29, "es eiert"): a drive at CONSTANT speed must give a
 * steady tone. The simulation moves drives in fixed 1/60 s steps while the render frame runs
 * at its own, jittering rate (e.g. ~31 ms on a capped display), so one frame holds one step,
 * the next two. Dividing that by the WALL frame time made the measured speed - and with it the
 * pitch - wobble by about 7 % at 4-5 Hz. The sampler now divides by the simulated motion time
 * of the frame (fixed steps x fixed dt) that the plugin hands in.
 */

import { describe, expect, it } from 'vitest';
import { Object3D } from 'three';
import { RVSoundSampler } from '../src/core/audio/rv-sound-sampler';
import { motorParams, type MotorVariant } from '../src/core/audio/rv-synth-motor';
import type { SoundDriveLike } from '../src/core/engine/rv-sound';

const FIXED = 1 / 60;

function fakeDrive(targetSpeed: number): SoundDriveLike {
  return { node: new Object3D(), name: 'Achse7-X', currentPosition: 0, TargetSpeed: targetSpeed, targetSpeed, targetPosition: 1e9 };
}

/** Deterministic PRNG for the frame jitter. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

/**
 * Accumulator loop like `SimulationLoop`: render frames of `frameMs` +- `jitterMs`, fixed steps of
 * 1/60 s moving the drive at `speed`; returns the pitch (f0) per frame after `settle` seconds.
 */
function pitchTrack(variant: MotorVariant, passMotionDt: boolean, frameMs = 31, jitterMs = 4, seconds = 4, settle = 1): number[] {
  const speed = 800;
  const d = fakeDrive(speed);
  const s = new RVSoundSampler();
  s.setSources([{ drive: d, kind: 'Drive', cylinder: null }]);
  const rnd = lcg(7);
  let acc = 0;
  let t = 0;
  const out: number[] = [];
  s.sample(frameMs / 1000, 1, false, null, passMotionDt ? 0 : undefined);
  while (t < seconds) {
    const dt = (frameMs + (rnd() * 2 - 1) * jitterMs) / 1000;
    t += dt;
    acc += dt;
    let steps = 0;
    while (acc >= FIXED) { acc -= FIXED; d.currentPosition += speed * FIXED; steps++; }
    s.sample(dt, 1, false, null, passMotionDt ? steps * FIXED : undefined);
    if (t > settle) out.push(motorParams(variant, s.vNorm[0]).f0);
  }
  return out;
}

function spread(track: number[]): { mean: number; maxDev: number } {
  const mean = track.reduce((a, b) => a + b, 0) / track.length;
  let maxDev = 0;
  for (const f of track) maxDev = Math.max(maxDev, Math.abs(f - mean) / mean);
  return { mean, maxDev };
}

describe('drive sound - steady pitch at constant speed (frame jitter)', () => {
  it('reproduces the wobble when the speed is measured against the wall frame time', () => {
    const { maxDev } = spread(pitchTrack('Medium', false));
    expect(maxDev).toBeGreaterThan(0.03); // the old behaviour: several percent
  });

  for (const variant of ['Large', 'Medium', 'Small'] as const) {
    it(`${variant}: pitch stays within 0.5 % with the simulated motion time`, () => {
      const { mean, maxDev } = spread(pitchTrack(variant, true));
      expect(maxDev).toBeLessThanOrEqual(0.005);
      expect(mean).toBeCloseTo(motorParams(variant, 1).f0, 0);
    });
  }

  it('also at 60 fps with heavy jitter and at 144 fps (frames without a fixed step)', () => {
    expect(spread(pitchTrack('Medium', true, 16.7, 8)).maxDev).toBeLessThanOrEqual(0.005);
    expect(spread(pitchTrack('Medium', true, 6.9, 1.5)).maxDev).toBeLessThanOrEqual(0.005);
  });
});
