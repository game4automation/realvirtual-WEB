// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-audio-engine.ts — the Web Audio side of the drive sounds (plan-2019 §2.6).
 *
 * LAZY: loaded only when a user switches sound on (or presses "Preview"). The
 * eager part is `rv-sound.ts` (component) and the `SoundSystem` plugin.
 *
 * - **One `AudioContext` per page** (module singleton, reference counted over
 *   the viewers; `close()` when the last one is disposed), **one master gain per
 *   viewer** (`RVSoundEngine`).
 * - **Two off states (C8):** never activated = no context, no import; switched
 *   off after activation = the context is `suspended`, the voice pool stays.
 *   A context is suspended as soon as NO engine of the page wants audio, and
 *   while the page is hidden (`visibilitychange`).
 * - **Voice pool:** 12 continuous voices built once at activation (oscillators
 *   running, gain 0). Every 0.25 s the 12 most audible sources are (re)assigned
 *   (a source holding a voice counts double — no flapping at the last slot),
 *   a released voice fades out in 50 ms. No `stop()` / re-creation while running.
 *   One-shots: max. 8 at once (the oldest is faded), max. 10 per second above a
 *   speed factor of 4.
 * - **Space:** every voice and one-shot goes through a `PannerNode`
 *   (`HRTF`, fallback `equalpower`; `inverse`, refDistance 2 m) placed at the
 *   world position of the drive node; the listener follows the ACTIVE view
 *   (desktop camera, or the XR head pose while a session is presenting).
 * - **Parameter updates:** `setTargetAtTime` only on a change > 1 % and at most
 *   30 Hz per voice; τ ≥ 5 ms. Long envelopes come from the sampler (sim time).
 */

import type { Object3D } from 'three';
import { identityIdOf } from '../engine/rv-decode-identity';
import { soundVariation } from './rv-sound-variation';
import {
  acquireAudioContext, addAudioContextClient, releaseAudioContext, updateContextState,
} from '../rv-audio-context';
import type { ResolvedSoundKind, ResolvedSoundVariant, SoundCylinderLike, SoundDriveLike } from '../engine/rv-sound';
import {
  RVSoundSampler,
  SOUND_EVENT_END_STOP,
  SOUND_EVENT_HYDRAULIC_TOCK,
  SOUND_EVENT_MOTOR_BRAKE,
  SOUND_EVENT_MOTOR_START,
  SOUND_EVENT_VALVE_TICK,
  type SamplerSource,
  type SoundSamplerSink,
} from './rv-sound-sampler';
import {
  createMotorParams, motorHarmonics, motorParams, type MotorVariant,
} from './rv-synth-motor';
import {
  NOISE_SECONDS, PUMP_HARMONICS, createCylinderParams, createHydraulicParams, cylinderParams, fillNoise,
  hydraulicParams, playEndStop, playHydraulicTock, playMotorTransient, playValveTick, type CylinderVariant, type OneShot,
} from './rv-synth-pneumatic';

// ─── Constants ───────────────────────────────────────────────────────────

/** Default number of continuous voices (configurable per engine); fewer voices = mainly the near drives are heard. */
export const VOICE_COUNT = 6;
/** Distance rolloff of the panner (inverse model; 2 = twice as steep as the Web Audio default). */
export const ROLLOFF_FACTOR = 2;
/** Trim of the continuous voices in favour of the event sounds. */
export const CONTINUOUS_TRIM = 0.7;
/** Level of the subtle electric start / brake transients. */
export const MOTOR_TRANSIENT_LEVEL = 0.3;
export const MAX_ONE_SHOTS = 8;
export const MAX_ONE_SHOTS_PER_SECOND_FAST = 10;
/** Above this speed factor the one-shot rate is limited. */
export const FAST_FACTOR = 4;
export const REASSIGN_INTERVAL = 0.25;
/** Score factor of a source that already holds a voice (assignment hysteresis). */
export const VOICE_HOLD_BONUS = 2;
export const VOICE_FADE = 0.05;
export const PAUSE_FADE = 0.08;
export const PARAM_RATE_HZ = 30;
export const PARAM_REL_CHANGE = 0.01;
export const MIN_TAU = 0.005;
export const REF_DISTANCE = 2;
/** Panner / listener moves below this distance (m) are not scheduled. */
export const POSE_EPS = 0.005;
/** Listener orientation changes below this (unit-vector component) are not scheduled. */
export const ORIENT_EPS = 0.002;
/** Pending one-shots above the fast speed factor (the oldest is dropped on overflow). */
export const ONE_SHOT_QUEUE = 4;

// ─── Views the engine consumes (RVSound satisfies SoundSourceView) ──────

/** What the engine needs from one Sound component. */
export interface SoundSourceView {
  readonly node: Object3D;
  readonly drive: SoundDriveLike | null;
  readonly cylinder: SoundCylinderLike | null;
  readonly kind: ResolvedSoundKind;
  readonly variant: ResolvedSoundVariant;
  readonly volume: number;
}

/** Per-frame input. */
export interface SoundFrameInput {
  /** Wall seconds since the previous rendered frame. */
  dt: number;
  /**
   * Simulated motion time of this frame (fixed steps run × fixed step), when known. The drive
   * speed — and with it the pitch — is measured against it, so the frame jitter does not make
   * a constant-speed drive wobble. Omitted = measured against `dt`.
   */
  motionDt?: number;
  /** Simulation speed factor (rv-speed-override). */
  timeFactor: number;
  /** Simulation / playback paused. */
  paused: boolean;
  /** The object whose world pose the listener takes (camera or XR head). */
  listener: Object3D | null;
}

/** The camera the listener follows: the XR head pose while presenting, else the viewer camera (§2.6). */
export function listenerCameraOf(viewer: { camera: Object3D; renderer?: unknown }): Object3D {
  const xr = (viewer.renderer as { xr?: { isPresenting?: boolean; getCamera?: () => Object3D } } | undefined)?.xr;
  if (xr?.isPresenting && typeof xr.getCamera === 'function') return xr.getCamera();
  return viewer.camera;
}

// ─── The page-wide context (eager starter: src/core/rv-audio-context.ts) ──

export {
  setAudioContextFactory, getSharedAudioContext, getAudioContextRefCount, updateContextState,
} from '../rv-audio-context';

/** Shared noise buffer of the current context (rebuilt for a new context). */
let _noise: AudioBuffer | null = null;
let _noiseCtx: AudioContext | null = null;

function sharedNoise(ctx: AudioContext): AudioBuffer {
  if (_noise && _noiseCtx === ctx) return _noise;
  const len = Math.max(1, Math.round(ctx.sampleRate * NOISE_SECONDS));
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  fillNoise(buf.getChannelData(0));
  _noise = buf;
  _noiseCtx = ctx;
  return buf;
}

// ─── Parameter throttle ──────────────────────────────────────────────────

/** Counts scheduled parameter changes, one-shots per event code (tests read it). */
export const audioStats = {
  paramUpdates: 0, poseUpdates: 0, oneShots: 0, droppedOneShots: 0,
  /** Started one-shots per sampler event code (index = code). */
  byEvent: [0, 0, 0, 0, 0, 0, 0],
};

function setParam(p: AudioParam, value: number, now: number, tau: number): void {
  p.setTargetAtTime(value, now, tau > MIN_TAU ? tau : MIN_TAU);
  audioStats.paramUpdates++;
}

// ─── Voice ───────────────────────────────────────────────────────────────

const P_MIX = 0, P_A_F = 1, P_A_G = 2, P_B_F = 3, P_B_G = 4, P_LB_F = 5, P_LB_D = 6, P_LA_F = 7, P_LA_D = 8,
  P_N1_F = 9, P_N1_G = 10, P_N2_F = 11, P_N2_G = 12, P_LN_D = 13;
const PARAM_SLOTS = 14;

interface VoiceWaves { large: PeriodicWave; medium: PeriodicWave; pump: PeriodicWave }

class Voice {
  readonly oscA: OscillatorNode; readonly gA: GainNode;
  readonly oscB: OscillatorNode; readonly gB: GainNode;
  readonly lfoB: OscillatorNode; readonly dB: GainNode;
  readonly lfoA: OscillatorNode; readonly dA: GainNode;
  readonly nz1: AudioBufferSourceNode; readonly f1: BiquadFilterNode; readonly gN1: GainNode;
  readonly nz2: AudioBufferSourceNode; readonly f2: BiquadFilterNode; readonly gN2: GainNode;
  readonly lfoN: OscillatorNode; readonly dN: GainNode;
  readonly mix: GainNode;
  readonly panner: PannerNode;
  /** Index into the engine's source list; -1 = free. */
  source = -1;
  /** Wall time (ctx clock) from which a released voice may be reused. */
  freeAt = 0;
  readonly sent = new Float32Array(PARAM_SLOTS);
  lastSend = -1;
  /** Last scheduled panner position and its time (ctx clock); -1 = never. */
  readonly pos = new Float64Array(3);
  posAt = -1;

  constructor(ctx: AudioContext, noise: AudioBuffer, dest: AudioNode, offset: number) {
    const osc = (type: OscillatorType, f: number): OscillatorNode => { const o = ctx.createOscillator(); o.type = type; o.frequency.value = f; return o; };
    const gain = (v: number): GainNode => { const g = ctx.createGain(); g.gain.value = v; return g; };
    this.oscA = osc('sine', 100); this.gA = gain(0);
    this.oscB = osc('sine', 1000); this.gB = gain(0);
    this.lfoB = osc('sine', 100); this.dB = gain(0);
    this.lfoA = osc('sine', 25); this.dA = gain(0);
    this.lfoN = osc('sine', 37); this.dN = gain(0);
    this.nz1 = ctx.createBufferSource(); this.nz1.buffer = noise; this.nz1.loop = true;
    this.nz2 = ctx.createBufferSource(); this.nz2.buffer = noise; this.nz2.loop = true;
    this.f1 = ctx.createBiquadFilter(); this.f1.type = 'lowpass'; this.f1.frequency.value = 1000;
    this.f2 = ctx.createBiquadFilter(); this.f2.type = 'bandpass'; this.f2.frequency.value = 4000;
    this.gN1 = gain(0); this.gN2 = gain(0);
    this.mix = gain(0);
    this.panner = createPanner(ctx);
    this.oscA.connect(this.gA).connect(this.mix);
    this.oscB.connect(this.gB).connect(this.mix);
    this.lfoB.connect(this.dB).connect(this.gB.gain);
    this.lfoA.connect(this.dA).connect(this.gA.gain);
    this.nz1.connect(this.f1).connect(this.gN1).connect(this.mix);
    this.nz2.connect(this.f2).connect(this.gN2).connect(this.mix);
    this.lfoN.connect(this.dN).connect(this.gN2.gain);
    this.mix.connect(this.panner).connect(dest);
    const t = ctx.currentTime;
    for (const o of [this.oscA, this.oscB, this.lfoB, this.lfoA, this.lfoN]) o.start(t);
    // Different read positions in the shared noise → uncorrelated voices.
    this.nz1.start(t, offset % NOISE_SECONDS);
    this.nz2.start(t, (offset * 1.7 + 0.5) % NOISE_SECONDS);
  }

  dispose(): void {
    for (const o of [this.oscA, this.oscB, this.lfoB, this.lfoA, this.lfoN]) { try { o.stop(); } catch { /* not started */ } }
    try { this.nz1.stop(); } catch { /* ignore */ }
    try { this.nz2.stop(); } catch { /* ignore */ }
    this.panner.disconnect();
    this.mix.disconnect();
  }
}

function createPanner(ctx: BaseAudioContext): PannerNode {
  const p = ctx.createPanner();
  try {
    p.panningModel = 'HRTF';
  } catch { /* ignore */ }
  if (p.panningModel !== 'HRTF') p.panningModel = 'equalpower';
  p.distanceModel = 'inverse';
  p.refDistance = REF_DISTANCE;
  p.rolloffFactor = ROLLOFF_FACTOR;
  return p;
}

/** Place a panner at the world position of a node at once (no allocation). */
function placePanner(p: PannerNode, node: Object3D): void {
  const e = node.matrixWorld.elements;
  if (p.positionX) {
    p.positionX.value = e[12]; p.positionY.value = e[13]; p.positionZ.value = e[14];
  } else {
    (p as unknown as { setPosition(x: number, y: number, z: number): void }).setPosition(e[12], e[13], e[14]);
  }
}

/**
 * Follow a moving node with a voice's panner: scheduled only when the node moved by
 * more than {@link POSE_EPS} and at most {@link PARAM_RATE_HZ} times per second.
 */
function followPanner(v: Voice, node: Object3D, now: number): void {
  if (v.posAt >= 0 && now - v.posAt < 1 / PARAM_RATE_HZ) return;
  const e = node.matrixWorld.elements;
  const pos = v.pos;
  if (v.posAt >= 0 && Math.abs(e[12] - pos[0]) <= POSE_EPS && Math.abs(e[13] - pos[1]) <= POSE_EPS
    && Math.abs(e[14] - pos[2]) <= POSE_EPS) return;
  pos[0] = e[12]; pos[1] = e[13]; pos[2] = e[14];
  v.posAt = now;
  const p = v.panner;
  audioStats.poseUpdates++;
  if (p.positionX) {
    p.positionX.setTargetAtTime(e[12], now, 0.02);
    p.positionY.setTargetAtTime(e[13], now, 0.02);
    p.positionZ.setTargetAtTime(e[14], now, 0.02);
  } else {
    (p as unknown as { setPosition(x: number, y: number, z: number): void }).setPosition(e[12], e[13], e[14]);
  }
}

// ─── Engine (one per viewer) ─────────────────────────────────────────────

interface PreviewState {
  readonly view: SoundSourceView;
  readonly drive: { node: Object3D; name: string; currentPosition: number; TargetSpeed: number; targetSpeed: number; targetPosition: number };
  readonly src: SamplerSource;
  t: number;
  duration: number;
}

/**
 * Does a source produce continuous sound worth a voice? A standing machine is silent:
 * the hydraulic pump only sounds while the axis moves (flow), under pressure relief or
 * above idle load; the idle load (0.15) alone gives no voice (no hum at standstill).
 */
export function sourceWantsVoice(kind: ResolvedSoundKind, s: RVSoundSampler, i: number): boolean {
  if (kind === 'Hydraulic') return s.moving[i] === 1 || s.flow[i] > 0.001 || s.relief[i] > 0.001 || s.load[i] > 0.2;
  if (kind === 'Cylinder') return s.slide[i] > 0.001 || s.throttle[i] > 0;
  return s.vNorm[i] > 0.002;
}

/** Audio of one viewer: master gain, voice pool, one-shots, sampler. */
export class RVSoundEngine implements SoundSamplerSink {
  readonly sampler = new RVSoundSampler();
  /** Assigned source index per voice (-1 = free) — read by tests. */
  readonly voices: Voice[] = [];

  private _ctx: AudioContext | null = null;
  private _master: GainNode | null = null;
  private _pause: GainNode | null = null;
  private _noise: AudioBuffer | null = null;
  private _waves: VoiceWaves | null = null;
  private _enabled = false;
  private _volume = 1;
  private _paused = false;
  private _views: SoundSourceView[] = [];
  private _list: SoundSourceView[] = [];
  private _preview: PreviewState | null = null;
  private _reassignIn = 0;
  private _timeFactor = 1;
  private readonly _oneShots: (OneShot | null)[] = new Array<OneShot | null>(MAX_ONE_SHOTS).fill(null);
  private _oneShotNext = 0;
  private readonly _rate = new Float64Array(MAX_ONE_SHOTS_PER_SECOND_FAST).fill(-Infinity);
  private _rateNext = 0;
  private _listenerObj: Object3D | null = null;
  private _score = new Float32Array(0);
  private _picked = new Uint8Array(0);
  private _disposed = false;
  private readonly _motor = createMotorParams();
  private readonly _cyl = createCylinderParams();
  private readonly _hyd = createHydraulicParams();
  private _listenerSet = false;
  /** Last scheduled listener pose (position, forward, up) and its time (ctx clock). */
  private readonly _lPose = new Float64Array(9);
  private _lAt = -1;
  /** Pending one-shots above the fast factor: ring of source index + event code. */
  private readonly _qIndex = new Int32Array(ONE_SHOT_QUEUE);
  private readonly _qEvent = new Uint8Array(ONE_SHOT_QUEUE);
  private _qHead = 0;
  private _qLen = 0;
  private readonly _offClient: () => void;

  /** Number of continuous voices of this engine (pool size). */
  readonly voiceCount: number;
  /** Fixed pitch / level factor per source (index-aligned with the source list). */
  private _pitch = new Float32Array(0);
  private _levelMul = new Float32Array(0);

  constructor(voiceCount: number = VOICE_COUNT) {
    this.voiceCount = Math.max(1, Math.floor(voiceCount) || VOICE_COUNT);
    this._offClient = addAudioContextClient(this);
  }

  /** Context created and pool built. */
  get activated(): boolean { return this._ctx !== null; }
  get enabled(): boolean { return this._enabled; }
  /** True while this engine needs a running context (on, or previewing). */
  get wantsAudio(): boolean { return this._ctx !== null && (this._enabled || this._preview !== null); }
  get master(): GainNode | null { return this._master; }
  get context(): AudioContext | null { return this._ctx; }
  get previewing(): boolean { return this._preview !== null; }

  /**
   * Create the context (first engine) + master + voice pool. Call from a user
   * gesture. Idempotent.
   */
  activate(): void {
    if (this._ctx || this._disposed) return;
    const ctx = acquireAudioContext();
    this._ctx = ctx;
    this._noise = sharedNoise(ctx);
    this._master = ctx.createGain();
    this._master.gain.value = 0;
    this._master.connect(ctx.destination);
    this._pause = ctx.createGain();
    this._pause.gain.value = 1;
    this._pause.connect(this._master);
    const wave = (amps: readonly number[], idx: readonly number[]): PeriodicWave => {
      const n = idx[idx.length - 1] + 1;
      const real = new Float32Array(n); const imag = new Float32Array(n);
      for (let i = 0; i < amps.length; i++) imag[idx[i]] = amps[i];
      return ctx.createPeriodicWave(real, imag, { disableNormalization: true });
    };
    this._waves = {
      large: wave(motorHarmonics('Large'), [1, 2, 3, 6]),
      medium: wave(motorHarmonics('Medium'), [1, 2, 3, 6]),
      pump: wave(PUMP_HARMONICS, [1, 2, 3]),
    };
    for (let i = 0; i < this.voiceCount; i++) this.voices.push(new Voice(ctx, this._noise, this._pause, i * 0.137));
    this._applyMaster();
    this._rebuildList();
    updateContextState();
  }

  /** Global switch of this viewer. Off after activation = suspended, pool stays (C8). */
  setEnabled(on: boolean): void {
    if (this._enabled === on) return;
    this._enabled = on;
    this._rebuildList();
    this._applyMaster();
    updateContextState();
  }

  /** Master volume 0..1. */
  setVolume(v: number): void {
    const vol = Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 1;
    if (vol === this._volume) return;
    this._volume = vol;
    this._applyMaster();
  }

  /** Replace the source list (on add / remove / re-resolve; never per frame). */
  setSources(list: readonly SoundSourceView[]): void {
    this._views = list.slice();
    this._rebuildList();
  }

  /** Simulation reset: no edges until standstill. */
  notifyReset(): void {
    this.sampler.notifyReset();
  }

  /**
   * Play a short demo of one source: a 1 s run-up for a motor, one stroke for a
   * cylinder / hydraulic axis. Works with the global switch off (the click that
   * calls this activated the context).
   */
  preview(view: SoundSourceView): void {
    this.activate();
    if (!this._ctx) return;
    const node = view.node;
    const drive = { node, name: node.name, currentPosition: 0, TargetSpeed: 100, targetSpeed: 200, targetPosition: 100 };
    const cyl: SoundCylinderLike = { MinPos: 0, MaxPos: 100 };
    const src: SamplerSource = { drive, kind: view.kind, cylinder: view.kind === 'Drive' ? null : cyl };
    const pv: SoundSourceView = {
      node, drive, cylinder: src.cylinder, kind: view.kind, variant: view.variant, volume: view.volume,
    };
    this._preview = { view: pv, drive, src, t: 0, duration: view.kind === 'Hydraulic' ? 3.6 : view.kind === 'Cylinder' ? 1.0 : 1.6 };
    this._rebuildList();
    this._applyMaster();
    updateContextState();
  }

  private _applyMaster(): void {
    const ctx = this._ctx;
    const m = this._master;
    if (!ctx || !m) return;
    const target = (this._enabled || this._preview) ? this._volume : 0;
    m.gain.cancelScheduledValues(ctx.currentTime);
    m.gain.setTargetAtTime(target, ctx.currentTime, 0.02);
  }

  private _rebuildList(): void {
    this._list.length = 0;
    if (this._enabled) for (const v of this._views) if (v.drive) this._list.push(v);
    if (this._preview) this._list.push(this._preview.view);
    const n = this._list.length;
    const samplerSources: SamplerSource[] = new Array<SamplerSource>(n);
    for (let i = 0; i < n; i++) samplerSources[i] = this._list[i];
    this.sampler.setSources(samplerSources);
    if (this._score.length < n) { this._score = new Float32Array(n); this._picked = new Uint8Array(n); }
    if (this._pitch.length < n) { this._pitch = new Float32Array(n); this._levelMul = new Float32Array(n); }
    for (let i = 0; i < n; i++) {
      const node = this._list[i].node;
      const v = soundVariation(identityIdOf(node) ?? `${node.name}#${node.uuid}`);
      this._pitch[i] = v.pitch; this._levelMul[i] = v.level;
    }
    for (const v of this.voices) this._releaseVoice(v, true);
    this._reassignIn = 0;
    // Queued one-shots address the old list.
    this._qLen = 0;
  }

  /** Index of the sources list currently used (tests). */
  get sources(): readonly SoundSourceView[] { return this._list; }

  /** One rendered frame. */
  frame(input: SoundFrameInput): void {
    const ctx = this._ctx;
    if (!ctx || this._disposed) return;
    if (!this._enabled && !this._preview) return;
    const now = ctx.currentTime;
    const k = input.timeFactor;
    this._timeFactor = k;
    const pv = this._preview;
    const paused = pv ? false : (input.paused || !(k > 0));
    this._setPaused(paused, now);
    if (pv) this._advancePreview(pv, input.dt);

    this._updateListener(input.listener, now);
    // The preview moves its drive in wall time, so it is measured in wall time.
    this.sampler.sample(input.dt, pv ? 1 : k, paused, this, pv ? undefined : input.motionDt);
    if (this._qLen > 0) this._drainOneShots(now);

    this._reassignIn -= input.dt;
    if (this._reassignIn <= 0) {
      this._reassignIn = REASSIGN_INTERVAL;
      this._assign(input.listener, now);
    }
    for (let v = 0; v < this.voices.length; v++) this._updateVoice(this.voices[v], now, paused);
  }

  private _setPaused(paused: boolean, now: number): void {
    if (paused === this._paused || !this._pause) return;
    this._paused = paused;
    const g = this._pause.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(paused ? 0 : 1, now + PAUSE_FADE);
  }

  private _advancePreview(pv: PreviewState, dt: number): void {
    pv.t += dt;
    const d = pv.drive;
    if (pv.src.kind === 'Drive') {
      // 1 s run-up to TargetSpeed, then run-down.
      const t = pv.t;
      const v = t < 0.6 ? t / 0.6 : t < 1.0 ? 1 : Math.max(0, 1 - (t - 1.0) / 0.4);
      d.currentPosition += v * d.TargetSpeed * dt;
    } else if (pv.t > 0.05) {
      // One stroke 0 → 100 at 200/s (0.5 s), then rest at the end.
      d.currentPosition = Math.min(100, d.currentPosition + d.targetSpeed * dt);
    }
    if (pv.t >= pv.duration) {
      this._preview = null;
      this._rebuildList();
      this._applyMaster();
      updateContextState();
    }
  }

  private _updateListener(obj: Object3D | null, now: number): void {
    const ctx = this._ctx!;
    if (!obj) return;
    const l = ctx.listener;
    const e = obj.matrixWorld.elements;
    // Forward = -Z column, up = +Y column of the world matrix.
    let fx = -e[8], fy = -e[9], fz = -e[10];
    let ux = e[4], uy = e[5], uz = e[6];
    const fl = Math.hypot(fx, fy, fz) || 1; fx /= fl; fy /= fl; fz /= fl;
    const ul = Math.hypot(ux, uy, uz) || 1; ux /= ul; uy /= ul; uz /= ul;
    // A camera switch (perspective ↔ orthographic, desktop ↔ XR) glides instead of jumping.
    const switched = this._listenerSet && obj !== this._listenerObj;
    const tau = switched ? 0.15 : 0.01;
    this._listenerObj = obj;
    // Scheduled only on a relevant change and at most 30 Hz — a switch always goes through.
    const q = this._lPose;
    if (this._listenerSet && !switched) {
      if (now - this._lAt < 1 / PARAM_RATE_HZ) return;
      if (Math.abs(e[12] - q[0]) <= POSE_EPS && Math.abs(e[13] - q[1]) <= POSE_EPS && Math.abs(e[14] - q[2]) <= POSE_EPS
        && Math.abs(fx - q[3]) <= ORIENT_EPS && Math.abs(fy - q[4]) <= ORIENT_EPS && Math.abs(fz - q[5]) <= ORIENT_EPS
        && Math.abs(ux - q[6]) <= ORIENT_EPS && Math.abs(uy - q[7]) <= ORIENT_EPS && Math.abs(uz - q[8]) <= ORIENT_EPS) return;
    }
    q[0] = e[12]; q[1] = e[13]; q[2] = e[14]; q[3] = fx; q[4] = fy; q[5] = fz; q[6] = ux; q[7] = uy; q[8] = uz;
    this._lAt = now;
    audioStats.poseUpdates++;
    if (l.positionX) {
      if (!this._listenerSet) {
        l.positionX.value = e[12]; l.positionY.value = e[13]; l.positionZ.value = e[14];
        l.forwardX.value = fx; l.forwardY.value = fy; l.forwardZ.value = fz;
        l.upX.value = ux; l.upY.value = uy; l.upZ.value = uz;
      } else {
        if (switched) {
          // A new target replaces the old glide instead of stacking on it.
          l.positionX.cancelScheduledValues(now); l.positionY.cancelScheduledValues(now); l.positionZ.cancelScheduledValues(now);
          l.forwardX.cancelScheduledValues(now); l.forwardY.cancelScheduledValues(now); l.forwardZ.cancelScheduledValues(now);
          l.upX.cancelScheduledValues(now); l.upY.cancelScheduledValues(now); l.upZ.cancelScheduledValues(now);
        }
        l.positionX.setTargetAtTime(e[12], now, tau); l.positionY.setTargetAtTime(e[13], now, tau); l.positionZ.setTargetAtTime(e[14], now, tau);
        l.forwardX.setTargetAtTime(fx, now, tau); l.forwardY.setTargetAtTime(fy, now, tau); l.forwardZ.setTargetAtTime(fz, now, tau);
        l.upX.setTargetAtTime(ux, now, tau); l.upY.setTargetAtTime(uy, now, tau); l.upZ.setTargetAtTime(uz, now, tau);
      }
    } else {
      const legacy = l as unknown as { setPosition(x: number, y: number, z: number): void; setOrientation(a: number, b: number, c: number, d: number, e2: number, f: number): void };
      legacy.setPosition(e[12], e[13], e[14]);
      legacy.setOrientation(fx, fy, fz, ux, uy, uz);
    }
    this._listenerSet = true;
  }

  /** Does a source currently produce continuous sound worth a voice? */
  private _wantsVoice(i: number): boolean {
    return sourceWantsVoice(this._list[i].kind, this.sampler, i);
  }

  private _assign(listener: Object3D | null, now: number): void {
    const n = this._list.length;
    const score = this._score;
    const picked = this._picked;
    let lx = 0, ly = 0, lz = 0;
    if (listener) { const e = listener.matrixWorld.elements; lx = e[12]; ly = e[13]; lz = e[14]; }
    for (let i = 0; i < n; i++) {
      picked[i] = 0;
      if (!this._wantsVoice(i)) { score[i] = -1; continue; }
      const e = this._list[i].node.matrixWorld.elements;
      const dist = Math.hypot(e[12] - lx, e[13] - ly, e[14] - lz);
      const dd = Math.max(dist, REF_DISTANCE);
      score[i] = (this._list[i].volume + 1e-3) / (dd * dd); // squared: the drives near the camera win
    }
    // Hysteresis: a source that holds a voice keeps it until a newcomer is clearly louder, so two
    // sources near the last slot do not swap voices every round (a 4 Hz fade-out / fade-in).
    for (const v of this.voices) {
      const s = v.source;
      if (s >= 0 && s < n && score[s] > 0) score[s] *= VOICE_HOLD_BONUS;
    }
    // Top-12 by repeated max scan (no sort with a lambda, no allocation).
    const want = Math.min(this.voiceCount, n);
    for (let r = 0; r < want; r++) {
      let best = -1; let bestScore = -1;
      for (let i = 0; i < n; i++) if (!picked[i] && score[i] > bestScore) { bestScore = score[i]; best = i; }
      if (best < 0 || bestScore < 0) break;
      picked[best] = 1;
    }
    // Release voices whose source lost its slot.
    for (const v of this.voices) {
      if (v.source >= 0 && (v.source >= n || !picked[v.source])) this._releaseVoice(v, false);
      else if (v.source >= 0) picked[v.source] = 2; // keeps its voice
    }
    // Give the newcomers a free (faded-out) voice.
    for (let i = 0; i < n; i++) {
      if (picked[i] !== 1) continue;
      let free: Voice | null = null;
      for (const v of this.voices) if (v.source < 0 && v.freeAt <= now) { free = v; break; }
      if (!free) break; // next round
      this._bind(free, i, now);
    }
  }

  private _releaseVoice(v: Voice, immediate: boolean): void {
    if (v.source < 0) return;
    v.source = -1;
    const ctx = this._ctx;
    if (!ctx) return;
    const now = ctx.currentTime;
    v.mix.gain.cancelScheduledValues(now);
    if (immediate) { v.mix.gain.setValueAtTime(0, now); v.freeAt = now; }
    else { v.mix.gain.setTargetAtTime(0, now, VOICE_FADE / 3); v.freeAt = now + VOICE_FADE; }
    v.sent[P_MIX] = 0;
  }

  private _bind(v: Voice, i: number, now: number): void {
    const view = this._list[i];
    v.source = i;
    v.lastSend = -1;
    v.sent.fill(-1);
    const waves = this._waves!;
    if (view.kind === 'Drive') {
      v.oscA.setPeriodicWave(view.variant === 'Medium' ? waves.medium : waves.large);
      v.f1.type = 'lowpass';
      v.f1.Q.value = 0.7;
    } else if (view.kind === 'Hydraulic') {
      v.oscA.setPeriodicWave(waves.pump);
      v.f1.type = 'bandpass';
      v.f1.Q.value = 1.4;
      v.f2.Q.value = 6;
    } else {
      v.f1.type = 'bandpass';
      v.f1.Q.value = 0.8;
      v.f2.Q.value = 1.6;
    }
    placePanner(v.panner, view.node);
    const e = view.node.matrixWorld.elements;
    v.pos[0] = e[12]; v.pos[1] = e[13]; v.pos[2] = e[14];
    v.posAt = now;
    // Start silent; `_updateVoice` fades in over the voice blend time.
    v.mix.gain.cancelScheduledValues(now);
    v.mix.gain.setValueAtTime(0, now);
  }

  private _updateVoice(v: Voice, now: number, paused: boolean): void {
    const i = v.source;
    if (i < 0) return;
    const view = this._list[i];
    const s = this.sampler;
    followPanner(v, view.node, now);
    if (s.muted[i]) {
      // Outlier: silence now, no ramp.
      v.mix.gain.cancelScheduledValues(now);
      v.mix.gain.setValueAtTime(0, now);
      v.sent[P_MIX] = 0;
      return;
    }
    if (paused) return; // the pause bus fades; parameters freeze with the sim
    if (v.lastSend >= 0 && now - v.lastSend < 1 / PARAM_RATE_HZ) return;
    const k = this._timeFactor > 0 ? this._timeFactor : 1;
    let mix = 0;
    let tau = 0.02;
    const pf = this._pitch[i];
    if (view.kind === 'Drive') {
      const m = motorParams(view.variant as MotorVariant, s.vNorm[i], view.volume, this._motor);
      tau = m.tau / Math.max(k, 0.25);
      mix = m.gain;
      this._send(v, P_A_F, v.oscA.frequency, m.f0 * pf, now, tau);
      this._send(v, P_A_G, v.gA.gain, m.humLevel, now, tau);
      this._send(v, P_B_F, v.oscB.frequency, m.whine * pf, now, tau);
      this._send(v, P_B_G, v.gB.gain, m.whineLevel, now, tau);
      this._send(v, P_LB_F, v.lfoB.frequency, m.f0 * pf, now, tau);
      this._send(v, P_LB_D, v.dB.gain, m.sideband * m.whineLevel, now, tau);
      this._send(v, P_LA_D, v.dA.gain, 0, now, tau);
      this._send(v, P_N1_F, v.f1.frequency, m.noiseCutoff, now, tau);
      this._send(v, P_N1_G, v.gN1.gain, m.noiseLevel, now, tau);
      this._send(v, P_N2_G, v.gN2.gain, 0, now, tau);
      this._send(v, P_LN_D, v.dN.gain, 0, now, tau);
    } else if (view.kind === 'Cylinder') {
      const c = cylinderParams(view.variant as CylinderVariant, s.slide[i], s.throttle[i], view.volume, this._cyl);
      mix = c.gain;
      this._send(v, P_A_G, v.gA.gain, 0, now, tau);
      this._send(v, P_B_G, v.gB.gain, 0, now, tau);
      this._send(v, P_LB_D, v.dB.gain, 0, now, tau);
      this._send(v, P_LA_D, v.dA.gain, 0, now, tau);
      this._send(v, P_N1_F, v.f1.frequency, c.slideFreq * pf, now, tau);
      this._send(v, P_N1_G, v.gN1.gain, c.slideLevel, now, tau);
      this._send(v, P_N2_F, v.f2.frequency, c.airFreq * pf, now, tau);
      this._send(v, P_N2_G, v.gN2.gain, c.airLevel, now, tau);
      this._send(v, P_LN_D, v.dN.gain, 0, now, tau);
    } else {
      const h = hydraulicParams(s.load[i], s.flow[i], s.relief[i], view.volume, this._hyd);
      tau = h.tau / Math.max(k, 0.25);
      mix = h.gain;
      this._send(v, P_A_F, v.oscA.frequency, h.pumpFreq * pf, now, tau);
      this._send(v, P_A_G, v.gA.gain, h.pumpLevel, now, tau);
      this._send(v, P_LA_F, v.lfoA.frequency, h.rippleFreq, now, tau);
      this._send(v, P_LA_D, v.dA.gain, h.rippleDepth * h.pumpLevel, now, tau);
      this._send(v, P_B_G, v.gB.gain, 0, now, tau);
      this._send(v, P_LB_D, v.dB.gain, 0, now, tau);
      this._send(v, P_N1_F, v.f1.frequency, h.flowFreq * pf, now, tau);
      this._send(v, P_N1_G, v.gN1.gain, h.flowLevel, now, 0.03 / Math.max(k, 0.25));
      this._send(v, P_N2_F, v.f2.frequency, h.reliefFreq * pf, now, tau);
      this._send(v, P_N2_G, v.gN2.gain, h.reliefLevel, now, 0.02 / Math.max(k, 0.25));
      this._send(v, P_LN_D, v.dN.gain, h.flutterDepth * h.reliefLevel, now, tau);
    }
    this._send(v, P_MIX, v.mix.gain, mix * CONTINUOUS_TRIM * this._levelMul[i], now, Math.max(VOICE_FADE / 3, MIN_TAU));
    v.lastSend = now;
  }

  /** Send one parameter when it changed by more than 1 % (or left / reached zero). */
  private _send(v: Voice, slot: number, p: AudioParam, value: number, now: number, tau: number): void {
    const last = v.sent[slot];
    if (last >= 0) {
      const diff = Math.abs(value - last);
      if (diff === 0) return;
      if (last !== 0 && value !== 0 && diff <= PARAM_REL_CHANGE * Math.abs(last)) return;
    }
    v.sent[slot] = value;
    setParam(p, value, now, tau);
  }

  // ── SoundSamplerSink ──

  /** One-shot event from the sampler. */
  onSoundEvent(index: number, event: number): void {
    // RELIEF is continuous (the voice follows the sampler's relief envelope) — no node at all.
    if (event !== SOUND_EVENT_VALVE_TICK && event !== SOUND_EVENT_END_STOP && event !== SOUND_EVENT_HYDRAULIC_TOCK
      && event !== SOUND_EVENT_MOTOR_START && event !== SOUND_EVENT_MOTOR_BRAKE) return;
    const ctx = this._ctx;
    if (!ctx || !this._noise || !this._pause) return;
    if (!this._list[index]) return;
    const k = this._preview ? 1 : this._timeFactor;
    if (k <= FAST_FACTOR) { this._playOneShot(index, event, ctx.currentTime); return; }
    // Fast simulation: a bounded queue (the OLDEST pending event is dropped on overflow),
    // drained at most 10 starts per second (2.3a).
    if (this._qLen === ONE_SHOT_QUEUE) {
      this._qHead = (this._qHead + 1) % ONE_SHOT_QUEUE;
      this._qLen--;
      audioStats.droppedOneShots++;
    }
    const slot = (this._qHead + this._qLen) % ONE_SHOT_QUEUE;
    this._qIndex[slot] = index;
    this._qEvent[slot] = event;
    this._qLen++;
    this._drainOneShots(ctx.currentTime);
  }

  /** Start pending one-shots, oldest first, within the rate limit (all at once when slow again). */
  private _drainOneShots(now: number): void {
    const limited = (this._preview ? 1 : this._timeFactor) > FAST_FACTOR;
    while (this._qLen > 0) {
      if (limited && now - this._rate[this._rateNext] < 1) return;
      const slot = this._qHead;
      this._qHead = (this._qHead + 1) % ONE_SHOT_QUEUE;
      this._qLen--;
      if (limited) {
        this._rate[this._rateNext] = now;
        this._rateNext = (this._rateNext + 1) % this._rate.length;
      }
      this._playOneShot(this._qIndex[slot], this._qEvent[slot], now);
    }
  }

  private _playOneShot(index: number, event: number, now: number): void {
    const ctx = this._ctx;
    const noise = this._noise;
    const bus = this._pause;
    const view = this._list[index];
    if (!ctx || !noise || !bus || !view) return;
    const k = this._preview ? 1 : this._timeFactor;
    // Envelopes compressed by 1/k when the simulation runs faster; pitch unchanged (2.3a).
    const scale = k > 1 ? 1 / k : 1;
    const panner = createPanner(ctx);
    placePanner(panner, view.node);
    panner.connect(bus);
    const level = view.volume * this._levelMul[index];
    const offset = (index * 0.311 + now) % 1;
    let shot: OneShot;
    if (event === SOUND_EVENT_VALVE_TICK) shot = playValveTick(ctx, panner, noise, now, scale, level, offset);
    else if (event === SOUND_EVENT_END_STOP) shot = playEndStop(ctx, panner, noise, view.variant === 'Hard' ? 'Hard' : 'Cushioned', now, scale, level, offset);
    else if (event === SOUND_EVENT_MOTOR_START || event === SOUND_EVENT_MOTOR_BRAKE) shot = playMotorTransient(ctx, panner, noise, now, scale, level * MOTOR_TRANSIENT_LEVEL, event === SOUND_EVENT_MOTOR_BRAKE, offset);
    else shot = playHydraulicTock(ctx, panner, noise, now, scale, level * 0.6, offset);
    audioStats.oneShots++;
    audioStats.byEvent[event]++;
    // Max. 8 at once: the slot of the oldest is reused, its sound faded.
    const old = this._oneShots[this._oneShotNext];
    if (old && old.end > now) {
      old.out.gain.cancelScheduledValues(now);
      old.out.gain.setTargetAtTime(0, now, 0.01);
    }
    this._oneShots[this._oneShotNext] = shot;
    this._oneShotNext = (this._oneShotNext + 1) % MAX_ONE_SHOTS;
  }

  /** Number of one-shot events waiting for the rate limit (tests). */
  get pendingOneShots(): number { return this._qLen; }

  /** Number of one-shots still sounding (tests). */
  activeOneShots(): number {
    const now = this._ctx?.currentTime ?? 0;
    let n = 0;
    for (const s of this._oneShots) if (s && s.end > now) n++;
    return n;
  }

  /** Free master + voices; the last engine closes the context. */
  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    this._offClient();
    for (const v of this.voices) v.dispose();
    this.voices.length = 0;
    this._pause?.disconnect();
    this._master?.disconnect();
    this._pause = null;
    this._master = null;
    if (this._ctx) {
      this._ctx = null;
      releaseAudioContext();
      updateContextState();
    }
    this._preview = null;
    this._views.length = 0;
    this._list.length = 0;
  }
}

