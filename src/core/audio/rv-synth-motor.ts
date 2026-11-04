// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-synth-motor.ts — parameters of the electric-motor voice (plan-2019 §2.3).
 *
 * Pure functions: the audio engine maps their output onto the preallocated
 * voice graph (fundamental oscillator with a PeriodicWave, inverter whine,
 * filtered noise). Every time constant is in SECONDS and every frequency in Hz,
 * so nothing depends on `AudioContext.sampleRate` (44.1 vs 48 kHz).
 */

export type MotorVariant = 'Large' | 'Medium' | 'Small';

/** Common reference gain of all voices (no per-sound normalisation). */
export const VOICE_REFERENCE_GAIN = 0.35;
/** Highest frequency any oscillator is allowed to reach. */
export const MAX_OSC_HZ = 18000;
/**
 * The noise colour of the reference recording was a one-pole low-pass whose
 * coefficient was given per 44.1 kHz sample; converted once to a cutoff in Hz.
 */
const REFERENCE_RATE = 44100;

interface MotorPreset {
  f0Min: number; f0Span: number;
  whineMin: number; whineSpan: number;
  whineLevel: number; noise: number; noiseLp: number;
  tau: number; levelDb: number;
  /** Amplitudes of harmonics 1, 2, 3 and 6. */
  harmonics: readonly [number, number, number, number];
  /** Sideband modulation depth of the whine at f_el. */
  sideband: number;
}

const PRESETS: Readonly<Record<MotorVariant, MotorPreset>> = {
  Large: {
    f0Min: 15, f0Span: 65, whineMin: 2500, whineSpan: 0, whineLevel: 0.02, noise: 0.35, noiseLp: 0.02,
    tau: 0.18, levelDb: 0, harmonics: [0.18, 0.42, 0.10, 0.05], sideband: 0.2,
  },
  Medium: {
    f0Min: 40, f0Span: 260, whineMin: 1800, whineSpan: 2200, whineLevel: 0.08, noise: 0.25, noiseLp: 0.05,
    tau: 0.045, levelDb: -4, harmonics: [0.5, 0.3, 0.15, 0.12], sideband: 0,
  },
  Small: {
    f0Min: 60, f0Span: 540, whineMin: 10000, whineSpan: 0, whineLevel: 0.05, noise: 0.15, noiseLp: 0.12,
    tau: 0.025, levelDb: -9, harmonics: [0.18, 0.42, 0.10, 0.05], sideband: 0.2,
  },
};

/** Parameter set of one motor voice at one speed. */
export interface MotorParams {
  /** Fundamental (electrical) frequency in Hz. */
  f0: number;
  /** Inverter whine frequency in Hz. */
  whine: number;
  /** Whine amplitude (already scaled with speed). */
  whineLevel: number;
  /** Amplitude of the hum (fundamental + harmonics). */
  humLevel: number;
  /** Noise amplitude. */
  noiseLevel: number;
  /** Noise low-pass cutoff in Hz. */
  noiseCutoff: number;
  /** Whine sideband depth (0 = none). */
  sideband: number;
  /** Inertia time constant in seconds. */
  tau: number;
  /** Overall voice gain incl. volume and variant level. */
  gain: number;
}

/** A fresh, reusable parameter object (allocate once, pass as `out`). */
export function createMotorParams(): MotorParams {
  return { f0: 0, whine: 0, whineLevel: 0, humLevel: 0, noiseLevel: 0, noiseCutoff: 0, sideband: 0, tau: 0, gain: 0 };
}

/** Linear level of a variant relative to Large (0 / −4 / −9 dB). */
export function motorVariantLevel(variant: MotorVariant): number {
  return Math.pow(10, PRESETS[variant].levelDb / 20);
}

/** Harmonic amplitudes (1, 2, 3, 6) of a variant — for the PeriodicWave. */
export function motorHarmonics(variant: MotorVariant): readonly number[] {
  return PRESETS[variant].harmonics;
}

/** Inertia time constant (s) of a variant. */
export function motorTau(variant: MotorVariant): number {
  return PRESETS[variant].tau;
}

/**
 * Motor parameters at the normalised speed `v` (1 = configured TargetSpeed).
 * Allocation-free when `out` is passed.
 */
export function motorParams(variant: MotorVariant, v: number, volume = 1, out: MotorParams = createMotorParams()): MotorParams {
  const p = PRESETS[variant] ?? PRESETS.Medium;
  const s = v > 0 ? v : 0;
  out.f0 = Math.min(MAX_OSC_HZ, p.f0Min + p.f0Span * s);
  out.whine = Math.min(MAX_OSC_HZ, p.whineMin + p.whineSpan * s);
  out.whineLevel = p.whineLevel * (0.3 + s);
  out.humLevel = 0.45 * (0.4 + 0.6 * s);
  out.noiseLevel = p.noise * s;
  out.noiseCutoff = Math.min(MAX_OSC_HZ, (p.noiseLp + 0.25 * s) * REFERENCE_RATE / (2 * Math.PI));
  out.sideband = p.sideband;
  out.tau = p.tau;
  const vol = volume > 0 ? (volume < 1 ? volume : 1) : 0;
  // The (0.4 + 0.6 v) loudness term of §2.3 sits on the hum (humLevel), as in the
  // approved reference recording; whine and noise carry their own speed terms.
  out.gain = Math.min(1, 4 * s) * vol * Math.pow(10, p.levelDb / 20) * VOICE_REFERENCE_GAIN;
  return out;
}
