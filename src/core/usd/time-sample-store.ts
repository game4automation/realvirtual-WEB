// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { Matrix4, Quaternion, Vector3 } from 'three';
import type { MotionSink } from './motion-sampler';

/** Bits shared with the reducer: a point must survive in the indicated channels. */
export const SAMPLE_CHANNEL = { translate: 1, orient: 2, scale: 4, all: 7 } as const;
const CHUNK_SIZE = 256;
/** Maximum per-element reconstruction error, relative to max(1, abs(element)). */
export const TRS_RECONSTRUCTION_TOLERANCE = 1e-6;

export interface PoseSamples {
  frames: Uint32Array;
  /** TRS: t(3), q(x,y,z,w), s(3); matrix fallback: 16 column-major elements. */
  values: Float32Array;
  /** Original translations in metres, before any Float32 quantization. */
  translations?: Float64Array;
  defaultTranslation?: Float64Array;
  mandatory: Uint8Array;
  matrixFallback: boolean;
  /** PV1: 16 column-major values per frame; aliases values in matrix mode. */
  matrix?: Float32Array;
  /** Track defaults also exist for stationary MUs without samples. */
  defaultValue?: Float32Array;
}

/** Append-only chunks: no copying of the complete recording on growth. */
class SampleChunks {
  readonly frames: Uint32Array[] = [];
  readonly values: Float32Array[] = [];
  readonly translations: Float64Array[] = [];
  readonly mandatory: Uint8Array[] = [];
  length = 0;
  constructor(readonly width: number) {}
  private get storedWidth(): number { return this.width - 3; }

  append(frame: number, value: ArrayLike<number>, mask = 0): void {
    const c = Math.floor(this.length / CHUNK_SIZE), i = this.length % CHUNK_SIZE;
    if (!this.frames[c]) {
      this.frames.push(new Uint32Array(CHUNK_SIZE));
      // TRS: 7 Float32 rotation/scale + 3 Float64 translation + frame/mask
      // = 57 bytes/sample, still below the 64-byte capture budget.
      this.values.push(new Float32Array(CHUNK_SIZE * this.storedWidth));
      this.translations.push(new Float64Array(CHUNK_SIZE * 3));
      this.mandatory.push(new Uint8Array(CHUNK_SIZE));
    }
    this.frames[c][i] = frame;
    this.replaceValue(this.length, value);
    this.mandatory[c][i] = mask;
    this.length++;
  }

  replaceValue(index: number, value: ArrayLike<number>): void {
    const c = Math.floor(index / CHUNK_SIZE), i = index % CHUNK_SIZE;
    const offset = this.width === 16 ? 12 : 0;
    for (let j = 0, stored = 0; j < this.width; j++) {
      if (j >= offset && j < offset + 3) this.translations[c][i * 3 + j - offset] = value[j];
      else this.values[c][i * this.storedWidth + stored++] = value[j];
    }
  }

  mark(index: number, mask: number): void {
    this.mandatory[Math.floor(index / CHUNK_SIZE)][index % CHUNK_SIZE] |= mask;
  }

  get lastFrame(): number {
    const i = this.length - 1;
    return this.frames[Math.floor(i / CHUNK_SIZE)][i % CHUNK_SIZE];
  }

  snapshot(): PoseSamples {
    const frames = new Uint32Array(this.length);
    const values = new Float32Array(this.length * this.width);
    const translations = new Float64Array(this.length * 3);
    const mandatory = new Uint8Array(this.length);
    for (let c = 0; c < this.frames.length; c++) {
      const n = Math.min(CHUNK_SIZE, this.length - c * CHUNK_SIZE);
      frames.set(this.frames[c].subarray(0, n), c * CHUNK_SIZE);
      translations.set(this.translations[c].subarray(0, n * 3), c * CHUNK_SIZE * 3);
      const offset = this.width === 16 ? 12 : 0;
      for (let i = 0; i < n; i++) for (let j = 0, stored = 0; j < this.width; j++) {
        values[(c * CHUNK_SIZE + i) * this.width + j] = j >= offset && j < offset + 3
          ? this.translations[c][i * 3 + j - offset] : this.values[c][i * this.storedWidth + stored++];
      }
      mandatory.set(this.mandatory[c].subarray(0, n), c * CHUNK_SIZE);
    }
    return { frames, values, translations, mandatory, matrixFallback: this.width === 16, ...(this.width === 16 ? { matrix: values } : {}) };
  }
}

interface PoseState {
  previous: Float64Array;
  current: Float64Array;
  previousMatrix: Float64Array;
  currentMatrix: Float64Array;
  defaultValue: Float64Array;
  lastGrid: Float64Array;
  matrixFallback: boolean;
  samples: SampleChunks | null;
  startFrame: number;
  lastFrame: number;
  lastChange: Int32Array;
  lastChangeIndex: Int32Array;
}
export interface PrimTimeTrack extends PoseSamples { primIndex: number; defaultValue: Float32Array }
export interface MuTimeTrack extends PoseSamples {
  muId: number;
  templateIndex: number;
  spawnFrame: number;
  destroyFrame: number | null;
  defaultValue: Float32Array;
}
interface MuState { pose: PoseState; templateIndex: number; spawnFrame: number; destroyFrame: number | null }

/**
 * Sink for MotionSampler, bracketed by beginTick(simTime) / endTick().
 * Call it at t0 as well as after each fixed tick; all times are SIM seconds.
 * Only changing grid poses are stored. Unmoving nodes retain just a default.
 * finish() closes every moving track at the last crossed grid frame.
 */
export class TimeSampleStore implements MotionSink {
  private readonly nodes: Array<PoseState | undefined>;
  private readonly mus = new Map<number, MuState>();
  private readonly matrix = new Matrix4();
  private readonly recomposed = new Matrix4();
  private readonly t = new Vector3();
  private readonly q = new Quaternion();
  private readonly otherQ = new Quaternion();
  private readonly s = new Vector3();
  private readonly interpolated = new Float64Array(16);
  private startTime: number | null = null;
  private previousTime = 0;
  private time = 0;
  private nextFrame = 0;
  private inTick = false;
  private finished = false;

  constructor(readonly fps: number, primCount: number) {
    if (!Number.isFinite(fps) || fps <= 0 || !Number.isInteger(primCount) || primCount < 0) throw new Error('Invalid sample grid');
    this.nodes = new Array(primCount);
  }

  get endFrame(): number { return Math.max(0, this.nextFrame - 1); }
  get frameCount(): number { return this.nextFrame; }

  beginTick(simTime: number): void {
    if (this.inTick || this.finished || !Number.isFinite(simTime)) throw new Error('Invalid tick lifecycle');
    if (this.startTime !== null && simTime < this.time) throw new Error('Simulation time went backwards');
    this.previousTime = this.time;
    this.time = simTime;
    this.startTime ??= simTime;
    for (const state of this.nodes) if (state) this.advance(state);
    for (const mu of this.mus.values()) if (mu.destroyFrame === null) this.advance(mu.pose);
    this.inTick = true;
  }

  private advance(state: PoseState): void {
    state.previous.set(state.current);
    state.previousMatrix.set(state.currentMatrix);
  }

  onNodes(index: number, matrix: ArrayLike<number>): void {
    this.requireTick();
    if (!Number.isInteger(index) || index < 0 || index >= this.nodes.length) throw new Error('Unknown snapshot index');
    const state = this.nodes[index];
    if (state) this.read(state, matrix);
    else this.nodes[index] = this.create(matrix, 0);
  }

  onMuSpawn(muId: number, templateIndex: number, matrix: ArrayLike<number>): void {
    this.requireTick();
    if (this.mus.has(muId)) throw new Error(`MU id reused during recording: ${muId}`);
    const spawnFrame = this.eventFrame();
    this.mus.set(muId, { pose: this.create(matrix, spawnFrame), templateIndex, spawnFrame, destroyFrame: null });
  }
  onMuDelete(muId: number): void {
    this.requireTick();
    const mu = this.mus.get(muId);
    if (mu && mu.destroyFrame === null) mu.destroyFrame = this.eventFrame();
  }
  onMuPoses(muId: number, matrix: ArrayLike<number>): void {
    this.requireTick();
    const mu = this.mus.get(muId);
    if (mu && mu.destroyFrame === null) this.read(mu.pose, matrix);
  }

  private eventFrame(): number { return Math.max(0, Math.ceil((this.time - this.startTime!) * this.fps - 1e-8)); }
  private requireTick(): void { if (!this.inTick) throw new Error('Pose outside tick'); }

  endTick(): void {
    this.requireTick();
    const end = this.time - this.startTime!;
    const span = this.time - this.previousTime;
    while (this.nextFrame / this.fps <= end + 1e-8) {
      const frame = this.nextFrame++;
      const at = this.startTime! + frame / this.fps;
      const alpha = span > 0 ? Math.max(0, Math.min(1, (at - this.previousTime) / span)) : 1;
      for (const state of this.nodes) if (state) this.sample(state, frame, alpha);
      for (const mu of this.mus.values()) {
        if (frame >= mu.spawnFrame && (mu.destroyFrame === null || frame < mu.destroyFrame)) this.sample(mu.pose, frame, alpha);
      }
    }
    this.inTick = false;
  }

  finish(): void {
    if (this.inTick) throw new Error('Finish inside tick');
    if (this.finished) return;
    for (const state of this.nodes) if (state) this.close(state);
    for (const mu of this.mus.values()) this.close(mu.pose);
    this.finished = true;
  }

  private close(state: PoseState): void {
    if (state.samples && state.lastFrame > state.samples.lastFrame) state.samples.append(state.lastFrame, state.lastGrid, 7);
  }

  getPrimTracks(): PrimTimeTrack[] {
    const out: PrimTimeTrack[] = [];
    this.nodes.forEach((state, primIndex) => {
      if (state?.samples) out.push({ primIndex, defaultValue: Float32Array.from(state.defaultValue.subarray(0, state.matrixFallback ? 16 : 10)),
        defaultTranslation: this.defaultTranslation(state), ...state.samples.snapshot() });
    });
    return out;
  }
  getMuTracks(): MuTimeTrack[] {
    return [...this.mus].map(([muId, mu]) => ({
      muId, templateIndex: mu.templateIndex, spawnFrame: mu.spawnFrame, destroyFrame: mu.destroyFrame,
      defaultValue: Float32Array.from(mu.pose.defaultValue.subarray(0, mu.pose.matrixFallback ? 16 : 10)),
      defaultTranslation: this.defaultTranslation(mu.pose),
      ...(mu.pose.samples ?? new SampleChunks(mu.pose.matrixFallback ? 16 : 10)).snapshot(),
    }));
  }
  getPrimDefault(index: number): Float32Array | undefined {
    const state = this.nodes[index];
    return state ? Float32Array.from(state.defaultValue.subarray(0, state.matrixFallback ? 16 : 10)) : undefined;
  }

  private defaultTranslation(state: PoseState): Float64Array {
    const offset = state.matrixFallback ? 12 : 0;
    return state.defaultValue.slice(offset, offset + 3);
  }

  private create(matrix: ArrayLike<number>, startFrame: number): PoseState {
    const state: PoseState = {
      previous: new Float64Array(16), current: new Float64Array(16),
      previousMatrix: new Float64Array(16), currentMatrix: new Float64Array(16),
      defaultValue: new Float64Array(16), lastGrid: new Float64Array(16), matrixFallback: false,
      samples: null, startFrame, lastFrame: startFrame,
      lastChange: new Int32Array(3).fill(startFrame), lastChangeIndex: new Int32Array(3),
    };
    this.read(state, matrix);
    state.previous.set(state.current);
    state.previousMatrix.set(state.currentMatrix);
    const pose = state.matrixFallback ? state.currentMatrix : state.current;
    state.defaultValue.set(pose); state.lastGrid.set(pose);
    return state;
  }

  private read(state: PoseState, matrix: ArrayLike<number>): void {
    for (let j = 0; j < 16; j++) {
      if (!Number.isFinite(matrix[j])) throw new Error('Non-finite pose');
      state.currentMatrix[j] = matrix[j];
    }
    // Promotion is permanent, including ticks which produce no grid frame.
    // Never decompose an already promoted prim (nor discard its raw matrix).
    if (state.matrixFallback) return;
    this.matrix.fromArray(matrix);
    if (!this.hasTrsBasis(matrix)) {
      this.promoteToMatrix(state);
      return;
    }
    this.matrix.decompose(this.t, this.q, this.s);
    this.q.normalize();
    this.recomposed.compose(this.t, this.q, this.s);
    // Validate the candidate before any TRS is committed to the tick buffers.
    for (let j = 0; j < 16; j++) {
      if (!(Math.abs(matrix[j] - this.recomposed.elements[j]) <= TRS_RECONSTRUCTION_TOLERANCE * Math.max(1, Math.abs(matrix[j])))) {
        this.promoteToMatrix(state);
        return;
      }
    }
    this.t.toArray(state.current, 0);
    this.q.toArray(state.current, 3);
    this.s.toArray(state.current, 7);
    let dot = 0;
    for (let j = 3; j < 7; j++) dot += state.previous[j] * state.current[j];
    if (dot < 0) for (let j = 3; j < 7; j++) state.current[j] = -state.current[j];
  }

  /**
   * Preflight BEFORE decompose: an affine TRS has mutually orthogonal columns.
   * The dot-product bound allows the same component tolerance as reconstruction:
   * |u.v| <= |du| |v| + |dv| |u| + |du| |dv|. Reflections keep orthogonality.
   * Singular bases take the exact matrix path rather than dividing by zero.
   */
  private hasTrsBasis(matrix: ArrayLike<number>): boolean {
    const tolerance = TRS_RECONSTRUCTION_TOLERANCE;
    if (Math.abs(matrix[3]) > tolerance || Math.abs(matrix[7]) > tolerance
      || Math.abs(matrix[11]) > tolerance || Math.abs(matrix[15] - 1) > tolerance) return false;
    for (let a = 0; a < 3; a++) {
      const oa = a * 4;
      const la = Math.hypot(matrix[oa], matrix[oa + 1], matrix[oa + 2]);
      if (!(la > 0) || !Number.isFinite(la)) return false;
      for (let b = a + 1; b < 3; b++) {
        const ob = b * 4;
        const lb = Math.hypot(matrix[ob], matrix[ob + 1], matrix[ob + 2]);
        const dot = matrix[oa] * matrix[ob] + matrix[oa + 1] * matrix[ob + 1] + matrix[oa + 2] * matrix[ob + 2];
        // 2 exceeds sqrt(3), bounding the norm of the three component errors.
        const ea = 2 * tolerance * Math.max(1, la), eb = 2 * tolerance * Math.max(1, lb);
        if (Math.abs(dot) > ea * lb + eb * la + ea * eb) return false;
      }
    }
    return true;
  }

  private compose(value: ArrayLike<number>, out: Float64Array): void {
    this.t.fromArray(value, 0); this.q.fromArray(value, 3); this.s.fromArray(value, 7);
    this.recomposed.compose(this.t, this.q, this.s).toArray(out);
  }

  private promoteToMatrix(state: PoseState): void {
    if (state.samples) {
      const old = state.samples.snapshot();
      state.samples = new SampleChunks(16);
      for (let i = 0; i < old.frames.length; i++) {
        this.compose(old.values.subarray(i * 10, i * 10 + 10), this.interpolated);
        this.interpolated.set(old.translations!.subarray(i * 3, i * 3 + 3), 12);
        state.samples.append(old.frames[i], this.interpolated, 7);
      }
    }
    this.compose(state.defaultValue, this.interpolated); state.defaultValue.set(this.interpolated);
    this.compose(state.lastGrid, this.interpolated); state.lastGrid.set(this.interpolated);
    state.matrixFallback = true;
  }

  private sample(state: PoseState, frame: number, alpha: number): void {
    const value = this.interpolated;
    let mask = 0;
    if (state.matrixFallback) {
      if (alpha === 1) value.set(state.currentMatrix);
      else if (alpha === 0) value.set(state.previousMatrix);
      else for (let j = 0; j < 16; j++) value[j] = state.previousMatrix[j] + (state.currentMatrix[j] - state.previousMatrix[j]) * alpha;
      for (let j = 0; j < 16; j++) if (value[j] !== state.lastGrid[j]) mask = 7;
    } else {
      for (let j = 0; j < 10; j++) value[j] = state.previous[j] + (state.current[j] - state.previous[j]) * alpha;
      if (state.previous[3] === state.current[3] && state.previous[4] === state.current[4]
        && state.previous[5] === state.current[5] && state.previous[6] === state.current[6]) {
        for (let j = 3; j < 7; j++) value[j] = state.current[j];
      } else this.q.fromArray(state.previous, 3).slerp(this.otherQ.fromArray(state.current, 3), alpha).toArray(value, 3);
      for (let j = 0; j < 10; j++) if (value[j] !== state.lastGrid[j]) mask |= j < 3 ? 1 : j < 7 ? 2 : 4;
    }
    if (mask) {
      if (!state.samples) {
        state.samples = new SampleChunks(state.matrixFallback ? 16 : 10);
        state.samples.append(state.startFrame, state.defaultValue, 7);
      }
      let holdMask = 0;
      for (let c = 0; c < 3; c++) if ((mask & (1 << c)) && frame - state.lastChange[c] > 1) {
        holdMask |= 1 << c;
        state.samples.mark(state.lastChangeIndex[c], 1 << c);
      }
      if (holdMask && frame - 1 > state.samples.lastFrame) state.samples.append(frame - 1, state.lastGrid, holdMask);
      else if (holdMask) state.samples.mark(state.samples.length - 1, holdMask);
      // If a newly spawned MU moves before its first grid frame, its first pose is the grid pose.
      if (state.samples.lastFrame === frame) {
        state.samples.replaceValue(0, value);
      } else state.samples.append(frame, value, state.matrixFallback ? 7 : 0);
      for (let c = 0; c < 3; c++) if (mask & (1 << c)) {
        state.lastChange[c] = frame; state.lastChangeIndex[c] = state.samples.length - 1;
      }
    }
    if (state.samples) for (let c = 0; c < 3; c++) {
      if (!(mask & (1 << c)) && frame - state.lastChange[c] === 1) state.samples.mark(state.lastChangeIndex[c], 1 << c);
    }
    state.lastGrid.set(value);
    state.lastFrame = frame;
  }

  /** Release all pose and recording buffers. A disposed store cannot be reused. */
  dispose(): void {
    this.nodes.length = 0; this.mus.clear(); this.finished = true;
  }
}
