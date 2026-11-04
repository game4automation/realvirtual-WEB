// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2019 §9.4 — visible speed of the render-frame sampler: Δpos/Δt + EMA,
 * v = 1 at the configured TargetSpeed, one clamp at 2.0 (C5), outliers mute and
 * reset the EMA, and a drive whose position is set from outside (follower /
 * playback — no `isRunning`, no `addAfterUpdate`) is measured just the same.
 */

import { describe, expect, it } from 'vitest';
import { Object3D } from 'three';
import { RVSoundSampler, SPEED_CLAMP } from '../src/core/audio/rv-sound-sampler';
import type { SoundDriveLike } from '../src/core/engine/rv-sound';

function fakeDrive(targetSpeed = 100): SoundDriveLike {
  return { node: new Object3D(), name: 'D', currentPosition: 0, TargetSpeed: targetSpeed, targetSpeed, targetPosition: 0 };
}

/** Run `seconds` of frames at `fps`, moving the drive at `speed` units/s (wall). */
function run(s: RVSoundSampler, d: SoundDriveLike, speed: number, seconds: number, fps = 60, k = 1): void {
  const dt = 1 / fps;
  for (let t = 0; t < seconds; t += dt) {
    d.currentPosition += speed * dt;
    s.sample(dt, k, false, null);
  }
}

describe('sound sampler — speed (plan-2019 9.4)', () => {
  it('v converges to 1 at the configured TargetSpeed (EMA τ 80 ms)', () => {
    const s = new RVSoundSampler();
    const d = fakeDrive(100);
    s.setSources([{ drive: d, kind: 'Drive', cylinder: null }]);
    s.sample(1 / 60, 1, false, null); // primes
    run(s, d, 100, 0.08);
    expect(s.vNorm[0]).toBeGreaterThan(0.55);
    expect(s.vNorm[0]).toBeLessThan(0.75); // ≈ 1 − e^-1 after one τ
    run(s, d, 100, 0.6);
    expect(s.vNorm[0]).toBeCloseTo(1, 2);
    expect(s.speed[0]).toBeCloseTo(100, 0);
  });

  it('is independent of the frame rate', () => {
    const a = new RVSoundSampler(); const da = fakeDrive(); a.setSources([{ drive: da, kind: 'Drive', cylinder: null }]);
    const b = new RVSoundSampler(); const db = fakeDrive(); b.setSources([{ drive: db, kind: 'Drive', cylinder: null }]);
    a.sample(1 / 30, 1, false, null); b.sample(1 / 144, 1, false, null);
    run(a, da, 50, 0.5, 30); run(b, db, 50, 0.5, 144);
    expect(a.vNorm[0]).toBeCloseTo(b.vNorm[0], 2);
  });

  it('clamps at 2.0', () => {
    const s = new RVSoundSampler(); const d = fakeDrive(100);
    s.setSources([{ drive: d, kind: 'Drive', cylinder: null }]);
    s.sample(1 / 60, 1, false, null);
    run(s, d, 250, 1); // 2.5 × TargetSpeed, below the outlier gate (3×)
    expect(s.vNorm[0]).toBe(SPEED_CLAMP);
  });

  it('an outlier (seek / teleport) mutes and resets the EMA', () => {
    const s = new RVSoundSampler(); const d = fakeDrive(100);
    s.setSources([{ drive: d, kind: 'Drive', cylinder: null }]);
    s.sample(1 / 60, 1, false, null);
    run(s, d, 100, 0.5);
    expect(s.vNorm[0]).toBeGreaterThan(0.9);
    d.currentPosition += 5000; // jump
    s.sample(1 / 60, 1, false, null);
    expect(s.muted[0]).toBe(1);
    expect(s.vNorm[0]).toBe(0);
    s.sample(1 / 60, 1, false, null);
    expect(s.muted[0]).toBe(0);
  });

  it('a resting drive decays to 0', () => {
    const s = new RVSoundSampler(); const d = fakeDrive(100);
    s.setSources([{ drive: d, kind: 'Drive', cylinder: null }]);
    s.sample(1 / 60, 1, false, null);
    run(s, d, 100, 0.5);
    run(s, d, 0, 0.6);
    expect(s.vNorm[0]).toBeLessThan(0.001);
  });

  it('a follower / playback drive (position written from outside, render 60 Hz over a 30 Hz source) is measured', () => {
    const s = new RVSoundSampler(); const d = fakeDrive(200);
    s.setSources([{ drive: d, kind: 'Drive', cylinder: null }]);
    s.sample(1 / 60, 1, false, null);
    // The source moves every second frame only (no isRunning, no callbacks).
    for (let f = 0; f < 60; f++) {
      if (f % 2 === 0) d.currentPosition += 100 * (2 / 60);
      s.sample(1 / 60, 1, false, null);
    }
    expect(s.speed[0]).toBeGreaterThan(80);
    expect(s.speed[0]).toBeLessThan(120);
    // The EMA ripples around the mean of a source that moves every second frame.
    expect(s.vNorm[0]).toBeGreaterThan(0.4);
    expect(s.vNorm[0]).toBeLessThan(0.6);
  });

  it('the speed follows the simulation speed factor (visible speed, 2.3a)', () => {
    const s = new RVSoundSampler(); const d = fakeDrive(100);
    s.setSources([{ drive: d, kind: 'Drive', cylinder: null }]);
    s.sample(1 / 60, 2, false, null);
    run(s, d, 200, 0.8, 60, 2); // k = 2: the drive visibly moves twice as fast
    expect(s.vNorm[0]).toBeCloseTo(2, 1);
  });
});
