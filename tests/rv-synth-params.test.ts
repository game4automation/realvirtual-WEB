// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2019 §9.7 — synthesis parameters per §2.3, time constants in seconds
 * independent of 44.1 / 48 kHz, and throttled parameter updates (fake counter).
 */

import { afterEach, describe, expect, it } from 'vitest';
import { Object3D, PerspectiveCamera } from 'three';
import { MAX_OSC_HZ, VOICE_REFERENCE_GAIN, motorParams, motorTau, motorVariantLevel } from '../src/core/audio/rv-synth-motor';
import { cylinderParams, hydraulicParams } from '../src/core/audio/rv-synth-pneumatic';
import {
  PARAM_RATE_HZ, RVSoundEngine, audioStats, getSharedAudioContext, setAudioContextFactory, type SoundSourceView,
} from '../src/core/audio/rv-audio-engine';
import type { SoundDriveLike } from '../src/core/engine/rv-sound';
import { FakeAudioContext, fakeAudioFactory, type FakeOscillator } from './helpers/fake-audio';

describe('motor params (plan-2019 9.7)', () => {
  it('Medium at configured TargetSpeed', () => {
    const p = motorParams('Medium', 1);
    expect(p.f0).toBeCloseTo(300);
    expect(p.whine).toBeCloseTo(4000);
  });

  it('follows the §2.3 table at v = 0 / 0.5 / 1', () => {
    expect(motorParams('Large', 0).f0).toBeCloseTo(15);
    expect(motorParams('Large', 0.5).f0).toBeCloseTo(47.5);
    expect(motorParams('Large', 1).f0).toBeCloseTo(80);
    expect(motorParams('Large', 0.5).whine).toBe(2500);
    expect(motorParams('Medium', 0).f0).toBeCloseTo(40);
    expect(motorParams('Medium', 0.5).f0).toBeCloseTo(170);
    expect(motorParams('Medium', 0.5).whine).toBeCloseTo(2900);
    expect(motorParams('Small', 0.5).f0).toBeCloseTo(330);
    expect(motorParams('Small', 1).f0).toBeCloseTo(600);
    expect(motorParams('Small', 1).whine).toBe(10000);
    expect(motorParams('Medium', 0).gain).toBe(0);
    expect([motorTau('Large'), motorTau('Medium'), motorTau('Small')]).toEqual([0.18, 0.045, 0.025]);
  });

  it('gain per preset at v = 0 / 0.5 / 1: min(1, 4v) · variant level on the voice, (0.4 + 0.6 v) on the hum (review #12)', () => {
    for (const variant of ['Large', 'Medium', 'Small'] as const) {
      const level = motorVariantLevel(variant) * VOICE_REFERENCE_GAIN;
      for (const v of [0, 0.5, 1]) {
        const p = motorParams(variant, v, 1);
        expect(p.gain, variant + ' gain at v=' + v).toBeCloseTo(Math.min(1, 4 * v) * level, 6);
        expect(p.humLevel, variant + ' hum at v=' + v).toBeCloseTo(0.45 * (0.4 + 0.6 * v), 6);
      }
      // Volume scales the voice linearly.
      expect(motorParams(variant, 1, 0.5).gain).toBeCloseTo(0.5 * level, 6);
    }
    expect(motorParams('Large', 1).gain).toBeGreaterThan(motorParams('Medium', 1).gain);
    expect(motorParams('Medium', 1).gain).toBeGreaterThan(motorParams('Small', 1).gain);
  });

  it('variant levels 0 / −4 / −9 dB, nothing above 18 kHz', () => {
    expect(20 * Math.log10(motorVariantLevel('Medium'))).toBeCloseTo(-4);
    expect(20 * Math.log10(motorVariantLevel('Small'))).toBeCloseTo(-9);
    expect(motorParams('Small', 2).whine).toBeLessThanOrEqual(MAX_OSC_HZ);
    expect(motorParams('Small', 2).noiseCutoff).toBeLessThanOrEqual(MAX_OSC_HZ);
  });

  it('cylinder and hydraulic parameters', () => {
    expect(cylinderParams('Hard', 1, 0).slideLevel).toBeCloseTo(0.12);
    expect(cylinderParams('Cushioned', 0.2, 1).airFreq).toBe(1400);
    expect(cylinderParams('Hard', 0.2, 1).airFreq).toBe(4000);
    const h = hydraulicParams(1, 0, 1);
    expect(h.pumpFreq).toBeCloseTo(216);
    expect(h.pumpLevel).toBeCloseTo(0.6);
    expect(hydraulicParams(0.15, 0, 0).pumpFreq).toBeCloseTo(225 * (1 - 0.006));
  });
});

describe('engine parameter scheduling (plan-2019 9.7)', () => {
  const engines: RVSoundEngine[] = [];
  afterEach(() => { for (const e of engines) e.dispose(); engines.length = 0; setAudioContextFactory(null); FakeAudioContext.reset(); });

  function drive(): { view: SoundSourceView; d: SoundDriveLike } {
    const node = new Object3D();
    node.updateMatrixWorld(true);
    const d: SoundDriveLike = { node, name: 'M', currentPosition: 0, TargetSpeed: 100, targetSpeed: 100, targetPosition: 0 };
    return { view: { node, drive: d, cylinder: null, kind: 'Drive', variant: 'Large', volume: 1 }, d };
  }

  function runAt(sampleRate: number, fps: number, seconds: number, speed: (t: number) => number, measureFrom = 0): { tau: number; updates: number } {
    FakeAudioContext.reset();
    setAudioContextFactory(fakeAudioFactory(sampleRate));
    const e = new RVSoundEngine(); engines.push(e);
    e.activate(); e.setEnabled(true);
    const { view, d } = drive();
    e.setSources([view]);
    const cam = new PerspectiveCamera(); cam.updateMatrixWorld(true);
    const ctx = getSharedAudioContext() as unknown as FakeAudioContext;
    let before = audioStats.paramUpdates;
    let measuring = measureFrom <= 0;
    for (let t = 0; t < seconds; t += 1 / fps) {
      if (!measuring && t >= measureFrom) { measuring = true; before = audioStats.paramUpdates; }
      d.currentPosition += speed(t) / fps;
      ctx.currentTime += 1 / fps;
      e.frame({ dt: 1 / fps, timeFactor: 1, paused: false, listener: cam });
    }
    const voice = e.voices.find((v) => v.source === 0)!;
    const call = (voice.oscA as unknown as FakeOscillator).frequency.last('setTargetAtTime');
    return { tau: call?.arg ?? -1, updates: audioStats.paramUpdates - before };
  }

  it('τ is in seconds — the same at 44.1 and 48 kHz', () => {
    const a = runAt(44100, 60, 1, () => 100);
    const b = runAt(48000, 60, 1, () => 100);
    expect(a.tau).toBeCloseTo(0.18);
    expect(b.tau).toBeCloseTo(a.tau);
  });

  it('updates are throttled to ≤ 30 Hz per voice and stop when nothing changes', () => {
    // 144 fps, a continuously changing speed: at most ~30 sends per parameter per second.
    const ramp = runAt(48000, 144, 2, (t) => 50 + 50 * t);
    const params = 12; // parameter slots a motor voice sends
    expect(ramp.updates).toBeLessThanOrEqual(params * PARAM_RATE_HZ * 2 + params * 4);
    // A constant speed: after the EMA settles almost nothing is sent any more.
    const steady = runAt(48000, 60, 3, () => 100, 2);
    expect(steady.updates).toBeLessThan(params * 2);
  });
});
