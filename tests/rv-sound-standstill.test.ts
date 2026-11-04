// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2019 follow-up: a standing machine is silent. Drives the sampler with a drive at
 * speed 0 for 60 s of sim time and checks that no kind asks the engine for a voice
 * (the hydraulic pump used to idle permanently = a continuous tone), that motion and
 * pressure relief still do, and that the quiet conveyor volume stays quiet.
 */
import { describe, expect, it } from 'vitest';
import { Object3D } from 'three';
import { RVSoundSampler } from '../src/core/audio/rv-sound-sampler';
import { sourceWantsVoice } from '../src/core/audio/rv-audio-engine';
import { motorParams } from '../src/core/audio/rv-synth-motor';
import type { ResolvedSoundKind, SoundDriveLike } from '../src/core/engine/rv-sound';

const DT = 1 / 60;

function rig(kind: ResolvedSoundKind) {
  const drive: SoundDriveLike = {
    node: new Object3D(), name: 'D', currentPosition: 0, TargetSpeed: 100, targetSpeed: 100, targetPosition: 0,
  };
  const sampler = new RVSoundSampler();
  sampler.setSources([{ drive, kind, cylinder: null }]);
  return { drive, sampler };
}

describe('standstill is silent', () => {
  for (const kind of ['Drive', 'Cylinder', 'Hydraulic'] as const) {
    it(`${kind}: speed 0 for 60 s never wants a voice`, () => {
      const { sampler } = rig(kind);
      let voiced = 0;
      for (let f = 0; f < 3600; f++) { sampler.sample(DT, 1, false, null); if (sourceWantsVoice(kind, sampler, 0)) voiced++; }
      expect(voiced).toBe(0);
    });
  }

  it('hydraulic: voice while moving, silent again after the pressure relief', () => {
    const { drive, sampler } = rig('Hydraulic');
    drive.targetPosition = 100;
    let movingVoice = false;
    for (let f = 0; f < 60; f++) { drive.currentPosition += 100 * DT; sampler.sample(DT, 1, false, null); movingVoice ||= sourceWantsVoice('Hydraulic', sampler, 0); }
    expect(movingVoice).toBe(true);
    let voicedLate = false;
    for (let f = 0; f < 600; f++) { sampler.sample(DT, 1, false, null); if (f > 400) voicedLate ||= sourceWantsVoice('Hydraulic', sampler, 0); }
    expect(voicedLate).toBe(false);
  });

  it('a running Drive wants a voice; Volume 0.12 scales its gain to 12 percent', () => {
    const { drive, sampler } = rig('Drive');
    for (let f = 0; f < 60; f++) { drive.currentPosition += 100 * DT; sampler.sample(DT, 1, false, null); }
    expect(sourceWantsVoice('Drive', sampler, 0)).toBe(true);
    const full = motorParams('Medium', 1, 1).gain;
    const quiet = motorParams('Medium', 1, 0.12).gain;
    expect(quiet / full).toBeCloseTo(0.12, 5);
  });
});
