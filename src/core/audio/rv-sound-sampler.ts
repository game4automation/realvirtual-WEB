// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-sound-sampler.ts — the render-frame sampler of the drive sounds (plan-2019 §2.5).
 *
 * Reads ONLY `currentPosition` of every active Sound's drive once per rendered
 * frame, so the speed is right in every mode (standalone, live, playback,
 * multiuser follower, behaviour drives) — `addAfterUpdate` would miss resting
 * drives, external `stop()` and followers.
 *
 * Per source it derives
 * - the VISIBLE speed `|Δpos| / Δt_motion` (simulated fixed-step time of the frame,
 *   wall time when unknown), smoothed (EMA τ 80 ms) and normalised
 *   to the configured `TargetSpeed` (clamped to 2.0, plan-2019 C5);
 * - motion edges with a 50 ms standstill hold (the fixed step and the render
 *   frame do not run in lockstep, so single frames without motion are normal);
 * - the cylinder / hydraulic events (valve tick, end stop, valve tock, relief
 *   valve) with the edge rules of §2.3 / C2;
 * - the LONG envelopes (stroke slide, cushion throttle, hydraulic load/flow and
 *   the 2.4 s relief hold) advanced here in SIMULATION time (`dt_wall · k`), so a
 *   change of the speed factor or a pause takes effect at once (C5). The audio
 *   engine only plans short ramps toward these values.
 *
 * Hot path: preallocated typed arrays, no closures, no allocation per frame.
 * Pure TypeScript — no Web Audio, testable with a fake clock.
 */

import type { ResolvedSoundKind, SoundCylinderLike, SoundDriveLike } from '../engine/rv-sound';

/** One-shot event codes delivered to the sink. */
export const SOUND_EVENT_VALVE_TICK = 1;
export const SOUND_EVENT_END_STOP = 2;
export const SOUND_EVENT_HYDRAULIC_TOCK = 3;
export const SOUND_EVENT_RELIEF = 4;
/** Subtle electric start / brake transients (kind Drive). */
export const SOUND_EVENT_MOTOR_START = 5;
export const SOUND_EVENT_MOTOR_BRAKE = 6;

/** EMA time constant of the visible speed (s). */
export const SPEED_EMA_TAU = 0.08;
/** Clamp of the normalised speed (C5: one clamp). */
export const SPEED_CLAMP = 2.0;
/** Standstill hold before a stop edge is declared (s, wall clock). */
export const STOP_HOLD = 0.05;
/** End band: within this fraction of the stroke from MinPos / MaxPos. */
export const END_BAND = 0.01;
/** Relief valve: rise, hold and decay in simulation seconds. */
export const RELIEF_RISE = 0.4;
export const RELIEF_HOLD = 2.4;
export const RELIEF_DECAY = 0.4;
/** Cushioned throttle phase before the end position (sim s). */
export const CUSHION_THROTTLE = 0.12;

/** Receives the one-shot events of one sample pass. */
export interface SoundSamplerSink {
  onSoundEvent(index: number, event: number): void;
}

/** What the sampler needs to know about one source. */
export interface SamplerSource {
  readonly drive: SoundDriveLike | null;
  readonly kind: ResolvedSoundKind;
  readonly cylinder: SoundCylinderLike | null;
}

function grow32(a: Float32Array<ArrayBuffer>, n: number): Float32Array<ArrayBuffer> { if (a.length >= n) return a; const b = new Float32Array(n); b.set(a); return b; }
function grow64(a: Float64Array<ArrayBuffer>, n: number): Float64Array<ArrayBuffer> { if (a.length >= n) return a; const b = new Float64Array(n); b.set(a); return b; }
function grow8(a: Uint8Array<ArrayBuffer>, n: number): Uint8Array<ArrayBuffer> { if (a.length >= n) return a; const b = new Uint8Array(n); b.set(a); return b; }
function growI8(a: Int8Array<ArrayBuffer>, n: number): Int8Array<ArrayBuffer> { if (a.length >= n) return a; const b = new Int8Array(n); b.set(a); return b; }

/** Render-frame sampler over all Sound sources of one viewer. */
export class RVSoundSampler {
  /** Number of sources. */
  count = 0;
  /** The sources (index-aligned with every array below). */
  readonly sources: SamplerSource[] = [];

  /** Smoothed visible speed in drive units per wall second. */
  speed = new Float32Array(0);
  /** Speed normalised to the configured TargetSpeed, clamped to 2.0. */
  vNorm = new Float32Array(0);
  /** 1 on the frame an outlier (seek / reset / teleport) muted the source. */
  muted = new Uint8Array(0);
  /** Cylinder slide envelope 0..1 (sim-time sine over the stroke). */
  slide = new Float32Array(0);
  /** Cushioned throttle 0/1 shortly before the end position. */
  throttle = new Float32Array(0);
  /** Hydraulic load / flow / relief targets 0..1. */
  load = new Float32Array(0);
  flow = new Float32Array(0);
  relief = new Float32Array(0);
  /** 1 while the source moves (after edge hysteresis). */
  moving = new Uint8Array(0);

  private _lastPos = new Float64Array(0);
  private _restPos = new Float64Array(0);
  private _startPos = new Float64Array(0);
  private _still = new Float32Array(0);
  private _armed = new Uint8Array(0);
  private _suppressed = new Uint8Array(0);
  private _side = new Int8Array(0);
  /** Hydraulic on a cylinder: end band reached while moving (-1 / +1), confirmed only at standstill. */
  private _pendingEnd = new Int8Array(0);
  private _slidePhase = new Float32Array(0);
  private _slideDur = new Float32Array(0);
  private _reliefTime = new Float32Array(0);
  private _primed = new Uint8Array(0);

  /** Replace the source list (allocation only here, never per frame). */
  setSources(list: readonly SamplerSource[]): void {
    const n = list.length;
    this.sources.length = 0;
    for (let i = 0; i < n; i++) this.sources.push(list[i]);
    this.count = n;
    this.speed = grow32(this.speed, n); this.vNorm = grow32(this.vNorm, n);
    this.muted = grow8(this.muted, n); this.slide = grow32(this.slide, n);
    this.throttle = grow32(this.throttle, n); this.load = grow32(this.load, n);
    this.flow = grow32(this.flow, n); this.relief = grow32(this.relief, n);
    this.moving = grow8(this.moving, n);
    this._lastPos = grow64(this._lastPos, n); this._restPos = grow64(this._restPos, n);
    this._startPos = grow64(this._startPos, n); this._still = grow32(this._still, n);
    this._armed = grow8(this._armed, n); this._suppressed = grow8(this._suppressed, n);
    this._side = growI8(this._side, n); this._pendingEnd = growI8(this._pendingEnd, n); this._slidePhase = grow32(this._slidePhase, n);
    this._slideDur = grow32(this._slideDur, n); this._reliefTime = grow32(this._reliefTime, n);
    this._primed = grow8(this._primed, n);
    for (let i = 0; i < n; i++) this._resetSource(i);
  }

  private _resetSource(i: number): void {
    this.speed[i] = 0; this.vNorm[i] = 0; this.muted[i] = 0; this.slide[i] = 0; this.throttle[i] = 0;
    this.load[i] = this.sources[i]?.kind === 'Hydraulic' ? 0.15 : 0;
    this.flow[i] = 0; this.relief[i] = 0; this.moving[i] = 0;
    this._still[i] = 0; this._armed[i] = 0; this._suppressed[i] = 0; this._side[i] = 0; this._pendingEnd[i] = 0;
    this._slidePhase[i] = 0; this._slideDur[i] = 0; this._reliefTime[i] = -1; this._primed[i] = 0;
  }

  /**
   * Simulation reset: edges are suppressed until each source has come to a
   * standstill (no clacks on the way home), running envelopes stop.
   */
  notifyReset(): void {
    for (let i = 0; i < this.count; i++) {
      this._suppressed[i] = 1;
      this._armed[i] = 0;
      this._pendingEnd[i] = 0;
      this._slideDur[i] = 0;
      this._reliefTime[i] = -1;
      this.slide[i] = 0; this.throttle[i] = 0; this.relief[i] = 0;
    }
  }

  /**
   * One pass per rendered frame.
   * @param dtWall wall seconds since the previous frame
   * @param timeFactor simulation speed factor k (rv-speed-override)
   * @param paused simulation (or playback) paused — envelopes and edges freeze
   * @param dtMotion simulated motion time of this frame in seconds (fixed steps × fixed dt),
   *   when known. Drives move in whole fixed steps while frames jitter, so one frame holds one
   *   step and the next two: measured against the WALL frame time the speed — and the pitch —
   *   wobbles by several percent at a few Hz. With `dtMotion` the speed is exact; a frame
   *   without a step (and without motion) holds the speed instead of reading 0. Omitted = wall time.
   */
  sample(dtWall: number, timeFactor: number, paused: boolean, sink: SoundSamplerSink | null, dtMotion?: number): void {
    const frozen = paused || !(timeFactor > 0);
    const dt = dtWall > 1e-6 ? dtWall : 1e-6;
    const hasMotionDt = dtMotion !== undefined && dtMotion >= 0 && Number.isFinite(dtMotion);
    const dtSim = frozen ? 0 : dt * timeFactor;
    const alpha = 1 - Math.exp(-dt / SPEED_EMA_TAU);
    const kMax = timeFactor > 1 ? timeFactor : 1;
    for (let i = 0; i < this.count; i++) {
      this.muted[i] = 0;
      const src = this.sources[i];
      const drive = src.drive;
      if (!drive) continue;
      const pos = drive.currentPosition;
      if (!this._primed[i]) {
        this._primed[i] = 1;
        this._lastPos[i] = pos; this._restPos[i] = pos;
        this._side[i] = this._sideOf(i, pos);
        continue;
      }
      const prev = this._lastPos[i];
      this._lastPos[i] = pos;
      if (frozen) continue; // C5: pause / k = 0 freezes everything (the engine fades the gain)

      const kind = src.kind;
      const cyl = src.cylinder;
      const stroke = cyl ? Math.abs(cyl.MaxPos - cyl.MinPos) : 0;
      const useEnds = kind !== 'Drive' && cyl !== null && stroke > 0;
      const d = pos - prev;
      const ad = d < 0 ? -d : d;
      // Denominator of the speed: the simulated motion time when it is known and non-zero; a
      // position change in a frame without a fixed step (external mover) falls back to wall time.
      const dtM = hasMotionDt && dtMotion! > 1e-6 ? dtMotion! : dt;
      // No fixed step and no motion this frame: nothing was measured — hold the speed.
      const hold = hasMotionDt && !(dtMotion! > 1e-6) && ad === 0 && this.moving[i] === 1;

      // Outlier gate (seek / reset / teleport): faster than 3× the drive could
      // possibly move AND (for cylinders) more than half a stroke.
      const ref = Math.max(drive.TargetSpeed > 0 ? drive.TargetSpeed : 0, drive.targetSpeed > 0 ? drive.targetSpeed : 0, 1);
      const outlier = ad > 3 * ref * kMax * dtM && (!useEnds || ad > 0.5 * stroke);
      if (outlier) {
        this.speed[i] = 0; this.vNorm[i] = 0; this.muted[i] = 1;
        this.moving[i] = 0; this._armed[i] = 0; this._still[i] = 0; this._pendingEnd[i] = 0;
        this._restPos[i] = pos; this._side[i] = this._sideOf(i, pos);
        this._slideDur[i] = 0; this.slide[i] = 0; this.throttle[i] = 0;
        this._reliefTime[i] = -1; this.relief[i] = 0; this.flow[i] = 0;
        if (kind === 'Hydraulic') this.load[i] = 0.15;
        continue;
      }

      const inst = ad / dtM;
      if (!hold) {
        this.speed[i] += (inst - this.speed[i]) * alpha;
        const cfg = drive.TargetSpeed > 1e-9 ? drive.TargetSpeed : 1;
        const vn = this.speed[i] / cfg;
        this.vNorm[i] = vn > SPEED_CLAMP ? SPEED_CLAMP : vn;
      }

      this._edges(i, src, pos, inst, stroke, useEnds, dt, sink);
      this._envelopes(i, src, pos, d, stroke, useEnds, dtSim, timeFactor);
    }
  }

  /** -1 = in the MinPos band, +1 = in the MaxPos band, 0 = in between / no cylinder. */
  private _sideOf(i: number, pos: number): number {
    const cyl = this.sources[i].cylinder;
    if (!cyl) return 0;
    const stroke = Math.abs(cyl.MaxPos - cyl.MinPos);
    if (stroke <= 0) return 0;
    const band = END_BAND * stroke;
    if (Math.abs(pos - cyl.MinPos) <= band) return -1;
    if (Math.abs(pos - cyl.MaxPos) <= band) return 1;
    return 0;
  }

  private _edges(
    i: number, src: SamplerSource, pos: number, inst: number,
    stroke: number, useEnds: boolean, dt: number, sink: SoundSamplerSink | null,
  ): void {
    const drive = src.drive!;
    const hydraulic = src.kind === 'Hydraulic';
    const thrSpeed = useEnds ? 0.01 * stroke : 0.005 * Math.max(drive.TargetSpeed, 1);
    const startEps = useEnds ? 0.01 * stroke : 0.1;
    const movingNow = inst > thrSpeed;
    const prevSide = this._side[i];
    const side = useEnds ? this._sideOf(i, pos) : 0;
    this._side[i] = side;

    if (movingNow) {
      this._still[i] = 0;
      if (!this.moving[i]) {
        if (Math.abs(pos - this._restPos[i]) <= startEps) return; // wobble at rest — no edge
        this.moving[i] = 1;
        this._startPos[i] = this._restPos[i];
        this._reliefTime[i] = -1;
        if (this._suppressed[i]) return;
        this._armed[i] = 1;
        if (sink) sink.onSoundEvent(i, hydraulic ? SOUND_EVENT_HYDRAULIC_TOCK : src.kind === 'Drive' ? SOUND_EVENT_MOTOR_START : SOUND_EVENT_VALVE_TICK);
        if (!hydraulic && useEnds) {
          const rt = drive.targetSpeed > 1e-9 ? drive.targetSpeed : Math.max(drive.TargetSpeed, 1e-9);
          this._slideDur[i] = stroke / rt;
          this._slidePhase[i] = 0;
        }
        this._pendingEnd[i] = 0;
        // A stroke shorter than one frame: from one end band straight into the other.
        if (useEnds && prevSide !== 0 && side !== 0 && side !== prevSide) this._arrive(i, hydraulic, side, sink);
        return;
      }
      // Already moving: entering an end band = arrival (only once per start edge).
      if (useEnds && this._armed[i] && side !== 0 && prevSide !== side) this._arrive(i, hydraulic, side, sink);
      // Hydraulic: leaving the band again (passing through, reversing) cancels the pending arrival.
      else if (hydraulic && side !== this._pendingEnd[i]) this._pendingEnd[i] = 0;
      return;
    }

    // No motion this frame.
    this._still[i] += dt;
    if (this._still[i] < STOP_HOLD) return;
    if (!this.moving[i]) {
      if (this._suppressed[i]) this._suppressed[i] = 0; // standstill reached after a reset
      this._restPos[i] = pos;
      return;
    }
    // Stop edge.
    this.moving[i] = 0;
    this._restPos[i] = pos;
    this._slideDur[i] = 0;
    this.throttle[i] = 0;
    if (this._suppressed[i]) { this._suppressed[i] = 0; this._armed[i] = 0; return; }
    if (!this._armed[i]) return; // already arrived at an end (event was due then)
    this._armed[i] = 0;
    if (src.kind === 'Drive') { if (sink) sink.onSoundEvent(i, SOUND_EVENT_MOTOR_BRAKE); return; }
    if (!hydraulic) {
      // A pneumatic axis WITHOUT cylinder end positions (plain Drive): the knock comes when
      // the move ends at its positioning target; stopped anywhere else = silent.
      if (!useEnds) {
        const travelled = Math.abs(pos - this._startPos[i]);
        const tol = Math.max(0.01 * travelled, 0.1);
        if (travelled > tol && Math.abs(pos - drive.targetPosition) <= tol && sink) sink.onSoundEvent(i, SOUND_EVENT_END_STOP);
      }
      return; // cylinder stop outside an end position: silent
    }
    if (useEnds) {
      // Hydraulic on a cylinder: the stop is confirmed (STOP_HOLD at standstill). In the
      // end position it reached → valve tock + pressure relief; anywhere else → tock only.
      const pending = this._pendingEnd[i];
      this._pendingEnd[i] = 0;
      if (sink) sink.onSoundEvent(i, SOUND_EVENT_HYDRAULIC_TOCK);
      if (pending !== 0 && side === pending) this._startRelief(i, sink);
      return;
    }
    // Hydraulic on a plain Drive (C2): pressure build-up only when it stopped at
    // its positioning target after a move; jog end / stop() elsewhere = tock only.
    const travelled = Math.abs(pos - this._startPos[i]);
    const tol = Math.max(0.01 * travelled, 0.1);
    if (sink) sink.onSoundEvent(i, SOUND_EVENT_HYDRAULIC_TOCK);
    if (travelled > 0 && Math.abs(pos - drive.targetPosition) <= tol) this._startRelief(i, sink);
  }

  /**
   * End band reached while moving. A pneumatic cylinder hits its stop NOW (one end
   * stop per start edge). A hydraulic axis only marks the arrival as pending: the
   * tock and the pressure relief wait for the confirmed standstill in that end
   * position (plan-2019 C2) — passing through or reversing inside the band is no stop.
   */
  private _arrive(i: number, hydraulic: boolean, side: number, sink: SoundSamplerSink | null): void {
    if (hydraulic) {
      this._pendingEnd[i] = side;
      return;
    }
    this._armed[i] = 0;
    this._slideDur[i] = 0;
    this.slide[i] = 0;
    this.throttle[i] = 0;
    if (sink) sink.onSoundEvent(i, SOUND_EVENT_END_STOP);
  }

  private _startRelief(i: number, sink: SoundSamplerSink | null): void {
    this._reliefTime[i] = 0;
    if (sink) sink.onSoundEvent(i, SOUND_EVENT_RELIEF);
  }

  private _envelopes(
    i: number, src: SamplerSource, pos: number, d: number, stroke: number,
    useEnds: boolean, dtSim: number, k: number,
  ): void {
    const drive = src.drive!;
    if (src.kind === 'Cylinder') {
      // Slide: sine over the stroke duration, advanced in SIM time.
      const dur = this._slideDur[i];
      if (dur > 0) {
        const ph = this._slidePhase[i] + dtSim;
        this._slidePhase[i] = ph;
        this.slide[i] = ph < dur ? Math.sin(Math.PI * ph / dur) : 0;
        if (ph >= dur) this._slideDur[i] = 0;
      } else if (!useEnds && this.moving[i]) {
        // Plain drive as a pneumatic axis: the slide follows the visible speed.
        this.slide[i] = this.vNorm[i] < 1 ? this.vNorm[i] : 1;
      } else {
        this.slide[i] = 0;
      }
      // Cushion throttle: the last 120 ms (sim) before the end position.
      this.throttle[i] = 0;
      if (useEnds && this.moving[i] && this._armed[i] && d !== 0) {
        const cyl = src.cylinder!;
        const end = d > 0 ? Math.max(cyl.MinPos, cyl.MaxPos) : Math.min(cyl.MinPos, cyl.MaxPos);
        const rem = Math.abs(end - pos);
        const vSim = this.speed[i] / (k > 0 ? k : 1);
        if (vSim > 1e-9 && rem / vSim < CUSHION_THROTTLE && rem > END_BAND * stroke) this.throttle[i] = 1;
      }
      return;
    }
    if (src.kind === 'Hydraulic') {
      let relief = 0;
      const t = this._reliefTime[i];
      if (t >= 0) {
        const nt = t + dtSim;
        if (nt >= RELIEF_HOLD + RELIEF_DECAY) {
          this._reliefTime[i] = -1;
        } else {
          this._reliefTime[i] = nt;
          relief = Math.min(1, nt / RELIEF_RISE) * (nt < RELIEF_HOLD ? 1 : Math.max(0, 1 - (nt - RELIEF_HOLD) / RELIEF_DECAY));
        }
      }
      this.relief[i] = relief;
      const moving = this.moving[i] === 1;
      this.load[i] = this._reliefTime[i] >= 0 ? 1 : moving ? 0.55 : 0.15;
      const rt = drive.targetSpeed > 1e-9 ? drive.targetSpeed : Math.max(drive.TargetSpeed, 1e-9);
      const vSim = this.speed[i] / (k > 0 ? k : 1);
      this.flow[i] = moving ? Math.min(1, vSim / rt) : 0;
    }
  }
}
