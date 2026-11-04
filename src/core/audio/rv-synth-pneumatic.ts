// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-synth-pneumatic.ts — pneumatic cylinder and hydraulic sounds (plan-2019 §2.3).
 *
 * Two halves:
 * - **continuous parameters** (pure): cylinder slide / exhaust / cushion throttle
 *   and the hydraulic pump / flow / relief valve. The sampler advances their
 *   envelopes in simulation time; the engine maps the values onto a pooled voice.
 * - **one-shots** (< ~250 ms, each a small throw-away node graph): valve tick,
 *   end stop (Hard / Cushioned) and the hydraulic valve tock. They take a time
 *   scale so a faster simulation compresses their envelopes (2.3a) without
 *   changing their pitch.
 *
 * All times are seconds and all frequencies Hz — independent of the sample rate.
 */

import { VOICE_REFERENCE_GAIN } from './rv-synth-motor';

export type CylinderVariant = 'Hard' | 'Cushioned';

// ─── Continuous parameters ───────────────────────────────────────────────

/** Mapping of the cylinder envelopes onto the voice's two noise bands. */
export interface CylinderParams {
  /** Slide band (Hz) and level. */
  slideFreq: number;
  slideLevel: number;
  /** Exhaust / throttle band (Hz) and level. */
  airFreq: number;
  airLevel: number;
  /** Overall gain incl. volume. */
  gain: number;
}

export function createCylinderParams(): CylinderParams {
  return { slideFreq: 350, slideLevel: 0, airFreq: 4000, airLevel: 0, gain: 0 };
}

/** Level of the hard end stop's contact transient — the reference of the exhaust level. */
const END_STOP_PEAK = 0.9;
/** Exhaust 27 dB below the end stop, only DURING the stroke. */
const EXHAUST_LEVEL = END_STOP_PEAK * Math.pow(10, -27 / 20);

/**
 * Cylinder voice at slide envelope `slide` (0..1) and throttle (0/1).
 * Cushioned: the throttle phase is the 1.4 kHz restricted exhaust before the end.
 */
export function cylinderParams(variant: CylinderVariant, slide: number, throttle: number, volume = 1,
  out: CylinderParams = createCylinderParams()): CylinderParams {
  out.slideFreq = 350;
  out.slideLevel = 0.12 * slide;
  if (variant === 'Cushioned' && throttle > 0) {
    out.airFreq = 1400;
    out.airLevel = 0.05 * throttle;
  } else {
    out.airFreq = 4000;
    out.airLevel = EXHAUST_LEVEL * slide;
  }
  out.gain = (volume > 0 ? Math.min(1, volume) : 0) * VOICE_REFERENCE_GAIN * 2;
  return out;
}

/** Hydraulic voice parameters. */
export interface HydraulicParams {
  /** Pump frequency (9 pistons × 1500 rpm = 225 Hz, 4 % lower under load). */
  pumpFreq: number;
  pumpLevel: number;
  /** Pressure ripple (Hz) and depth. */
  rippleFreq: number;
  rippleDepth: number;
  /** Flow noise band and level. */
  flowFreq: number;
  flowLevel: number;
  /** Relief valve band, level and flutter. */
  reliefFreq: number;
  reliefLevel: number;
  flutterFreq: number;
  flutterDepth: number;
  /** Load time constant (s, sim time). */
  tau: number;
  gain: number;
}

export function createHydraulicParams(): HydraulicParams {
  return {
    pumpFreq: 225, pumpLevel: 0, rippleFreq: 25, rippleDepth: 0.15, flowFreq: 900, flowLevel: 0,
    reliefFreq: 3200, reliefLevel: 0, flutterFreq: 37, flutterDepth: 0.3, tau: 0.06, gain: 0,
  };
}

/** Hydraulic parameters at the given load (0.15 idle / 0.55 moving / 1 pressure), flow and relief. */
export function hydraulicParams(load: number, flow: number, relief: number, volume = 1,
  out: HydraulicParams = createHydraulicParams()): HydraulicParams {
  out.pumpFreq = 225 * (1 - 0.04 * load);
  out.pumpLevel = 0.25 + 0.35 * load;
  out.rippleFreq = 25;
  out.rippleDepth = 0.15;
  out.flowFreq = 900;
  out.flowLevel = 0.18 * flow;
  out.reliefFreq = 3200;
  out.reliefLevel = 0.05 * relief * 4;
  out.flutterFreq = 37;
  out.flutterDepth = 0.3;
  out.tau = 0.06;
  out.gain = (volume > 0 ? Math.min(1, volume) : 0) * VOICE_REFERENCE_GAIN;
  return out;
}

/** Harmonic amplitudes (1, 2, 3) of the pump wave. */
export const PUMP_HARMONICS: readonly number[] = [0.5, 0.25, 0.12];

// ─── One-shots ───────────────────────────────────────────────────────────

/** Minimal Web Audio surface the one-shots need (a real context or the test fake). */
export type OneShotContext = Pick<BaseAudioContext, 'createOscillator' | 'createGain' | 'createBiquadFilter' | 'createBufferSource' | 'currentTime'>;

/** A scheduled one-shot: its output gain (for fading the oldest) and its end time. */
export interface OneShot {
  readonly out: GainNode;
  readonly end: number;
}

/** Decaying sine partial: f Hz, amplitude a, decay rate r (1/s), attack s. */
function partial(ctx: OneShotContext, dest: AudioNode, t0: number, f: number, a: number, r: number, attack: number, scale: number, len: number): void {
  const o = ctx.createOscillator();
  o.type = 'sine';
  o.frequency.value = Math.min(18000, f);
  const g = ctx.createGain();
  g.gain.value = 0;
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(a, t0 + attack * scale);
  g.gain.setTargetAtTime(0, t0 + attack * scale, Math.max(0.005, scale / r));
  o.connect(g);
  g.connect(dest);
  o.start(t0);
  o.stop(t0 + len * scale);
}

/** Decaying band-limited noise burst from the shared buffer. */
function noiseBurst(ctx: OneShotContext, dest: AudioNode, buffer: AudioBuffer, t0: number, cutoff: number, a: number, r: number,
  attack: number, scale: number, len: number, offset: number): void {
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = Math.min(12000, cutoff);
  const g = ctx.createGain();
  g.gain.value = 0;
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(a, t0 + attack * scale);
  g.gain.setTargetAtTime(0, t0 + attack * scale, Math.max(0.005, scale / r));
  src.connect(lp);
  lp.connect(g);
  g.connect(dest);
  src.start(t0, offset % Math.max(0.01, buffer.duration - len));
  src.stop(t0 + len * scale);
}

function outGain(ctx: OneShotContext, dest: AudioNode, level: number): GainNode {
  const out = ctx.createGain();
  out.gain.value = level;
  out.connect(dest);
  return out;
}

/** Solenoid valve tick: 900 Hz + band-limited noise, 0.5 ms attack, 50 ms; + 180 Hz body. */
export function playValveTick(ctx: OneShotContext, dest: AudioNode, noise: AudioBuffer, t0: number, scale: number,
  level: number, offset = 0): OneShot {
  const out = outGain(ctx, dest, level * 0.35);
  partial(ctx, out, t0, 900, 0.5, 500, 0.0005, scale, 0.05);
  noiseBurst(ctx, out, noise, t0, 12000, 0.3, 500, 0.0005, scale, 0.05, offset);
  partial(ctx, out, t0, 180, 0.25 / 0.35, 120, 0.0005, scale, 0.05);
  return { out, end: t0 + 0.05 * scale };
}

/**
 * End stop. Hard: contact noise + body modes 180 Hz / 1.2 kHz (+6 dB) / 4.5 kHz (+4 dB),
 * bounces at 12 / 22 / 30 ms with 0.30 / 0.12 / 0.04. Cushioned: 10 dB lower,
 * components above 1 kHz another 12 dB lower, no bounce.
 */
export function playEndStop(ctx: OneShotContext, dest: AudioNode, noise: AudioBuffer, variant: CylinderVariant, t0: number,
  scale: number, level: number, offset = 0): OneShot {
  const hard = variant === 'Hard';
  const peak = hard ? 0.5 : 0.5 * Math.pow(10, -10 / 20);
  const hi = hard ? 1 : Math.pow(10, -12 / 20);
  const out = outGain(ctx, dest, level * peak);
  const hit = (t: number, a: number): void => {
    noiseBurst(ctx, out, noise, t, 12000, END_STOP_PEAK * a * hi, 1500, 0.0005, scale, 0.05, offset + t);
    partial(ctx, out, t, 180, 0.9 * Math.pow(10, -8 / 20) * a, 28, 0.0005, scale, 0.3);
    partial(ctx, out, t, 230, 0.5 * a, 45, 0.0005, scale, 0.25);
    partial(ctx, out, t, 1200, 0.18 * 2 * a * hi, 70, 0.0005, scale, 0.15);
    partial(ctx, out, t, 2700, 0.18 * a * hi, 110, 0.0005, scale, 0.1);
    partial(ctx, out, t, 4500, 0.18 * Math.pow(10, 4 / 20) * a * hi, 160, 0.0005, scale, 0.08);
  };
  hit(t0, 1);
  if (hard) {
    hit(t0 + 0.012 * scale, 0.30);
    hit(t0 + 0.022 * scale, 0.12);
    hit(t0 + 0.030 * scale, 0.04);
  }
  return { out, end: t0 + 0.3 * scale };
}

/** Hydraulic directional valve "tock": 140 Hz + 600 Hz + noise, 0.6 ms attack, 0.25 s. */
export function playHydraulicTock(ctx: OneShotContext, dest: AudioNode, noise: AudioBuffer, t0: number, scale: number,
  level: number, offset = 0): OneShot {
  const out = outGain(ctx, dest, level);
  partial(ctx, out, t0, 140, 0.6, 30, 0.0006, scale, 0.25);
  partial(ctx, out, t0, 600, 0.2, 90, 0.0006, scale, 0.25);
  noiseBurst(ctx, out, noise, t0, 6000, 0.15, 400, 0.0006, scale, 0.05, offset);
  return { out, end: t0 + 0.25 * scale };
}

/**
 * Subtle electric-motor transient: a soft start (rising torque thump) or brake
 * (low decaying thud). Much quieter than the pneumatic events - it only marks the move.
 */
export function playMotorTransient(ctx: OneShotContext, dest: AudioNode, noise: AudioBuffer, t0: number, scale: number,
  level: number, brake: boolean, offset = 0): OneShot {
  const out = outGain(ctx, dest, level);
  if (brake) {
    partial(ctx, out, t0, 110, 0.5, 38, 0.002, scale, 0.2);
    noiseBurst(ctx, out, noise, t0, 1800, 0.12, 120, 0.002, scale, 0.12, offset);
    return { out, end: t0 + 0.2 * scale };
  }
  partial(ctx, out, t0, 150, 0.35, 26, 0.012, scale, 0.18);
  noiseBurst(ctx, out, noise, t0, 2500, 0.1, 90, 0.012, scale, 0.14, offset);
  return { out, end: t0 + 0.18 * scale };
}

// ─── Shared noise ────────────────────────────────────────────────────────

/** Length of the shared noise buffer in seconds. */
export const NOISE_SECONDS = 2;

/** Deterministic white noise (LCG, fixed seed) — identical on every load. */
export function fillNoise(data: Float32Array, seed = 12345): void {
  let s = seed >>> 0;
  for (let i = 0; i < data.length; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    data[i] = (s / 4294967296) * 2 - 1;
  }
}
