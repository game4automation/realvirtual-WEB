// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { Quaternion } from 'three';
import type { PoseSamples } from './time-sample-store';

export interface ReductionTolerance {
  /** Metres (default 0.1 mm). Zero retains every sample. */
  translate: number;
  /** Radians (default 0.05 degrees). */
  orient: number;
  /** Relative component error (default 1e-4). */
  scale: number;
}
export interface ReducedChannel {
  defaultValue: Float32Array | Float64Array;
  frames: Uint32Array;
  values: Float32Array | Float64Array;
}
export interface ReducedPose {
  translate: ReducedChannel;
  orient: ReducedChannel;
  scale: ReducedChannel;
  /** Non-TRS fallback is never reduced using TRS error metrics. */
  matrix?: ReducedChannel;
}
type Channel = keyof ReductionTolerance;
export interface ReductionOptions {
  tolerance?: Partial<ReductionTolerance>;
  /** Stages must supply both sides of a step (f-1 and f); neither may be removed. */
  stepFrames?: Partial<Record<Channel, readonly number[]>>;
}

/** Iterative Douglas-Peucker, independently for each USD interpolation channel. */
export function reduceKeyframes(samples: PoseSamples, options: ReductionOptions = {}): ReducedPose {
  const tolerance = { translate: 1e-4, orient: 0.05 * Math.PI / 180, scale: 1e-4, ...options.tolerance };
  for (const value of Object.values(tolerance)) if (!Number.isFinite(value) || value < 0) throw new Error('Invalid reduction tolerance');
  const matrix = samples.matrixFallback ? samples.matrix ?? samples.values : undefined;
  const n = samples.frames.length, stride = matrix ? 16 : 10;
  if ((matrix ?? samples.values).length !== n * stride || samples.mandatory.length !== n) throw new Error('Invalid pose samples');
  for (let i = 0; i < n; i++) {
    if (i && samples.frames[i] <= samples.frames[i - 1]) throw new Error('Frames must increase');
  }
  for (const v of matrix ?? samples.values) if (!Number.isFinite(v)) throw new Error('Non-finite pose sample');
  if (samples.translations) {
    if (samples.translations.length !== n * 3) throw new Error('Invalid translations');
    for (const v of samples.translations) if (!Number.isFinite(v)) throw new Error('Non-finite translation');
  }
  if (samples.defaultTranslation) {
    if (samples.defaultTranslation.length !== 3) throw new Error('Invalid translation default');
    for (const v of samples.defaultTranslation) if (!Number.isFinite(v)) throw new Error('Non-finite translation default');
  }
  if (samples.defaultValue) {
    if (samples.defaultValue.length !== stride) throw new Error('Invalid pose default');
    for (const v of samples.defaultValue) if (!Number.isFinite(v)) throw new Error('Non-finite pose default');
  }
  const normalizeQuaternion = (values: Float32Array | Float64Array, at: number): void => {
    const length = Math.hypot(values[at], values[at + 1], values[at + 2], values[at + 3]);
    if (!length) throw new Error('Zero quaternion');
    for (let c = 0; c < 4; c++) values[at + c] /= length;
  };
  const empty = (): ReducedChannel => ({ defaultValue: new Float32Array(), frames: new Uint32Array(), values: new Float32Array() });
  if (matrix) {
    const values = samples.translations ? Float64Array.from(matrix) : matrix.slice();
    const defaultValue = samples.defaultTranslation ? Float64Array.from((samples.defaultValue ?? matrix).slice(0, 16))
      : (samples.defaultValue ?? matrix).slice(0, 16);
    if (samples.translations) for (let i = 0; i < n; i++) values.set(samples.translations.subarray(i * 3, i * 3 + 3), i * 16 + 12);
    if (samples.defaultTranslation) defaultValue.set(samples.defaultTranslation, 12);
    return {
      translate: empty(), orient: empty(), scale: empty(),
      matrix: { defaultValue, frames: samples.frames.slice(), values },
    };
  }

  const channel = (name: Channel, offset: number, width: number, bit: number): ReducedChannel => {
    // Position keeps its original precision through reduction and USD double3
    // interpolation. Thus the tolerance is the TOTAL positional error budget.
    const Values = name === 'translate' ? Float64Array : Float32Array;
    const values = new Values(n * width);
    const defaultValue = new Values(name === 'translate' && samples.defaultTranslation ? samples.defaultTranslation : samples.defaultValue
      ? samples.defaultValue.slice(offset, offset + width)
      : samples.values.slice(offset, Math.min(samples.values.length, offset + width)));
    if (name === 'orient' && defaultValue.length) normalizeQuaternion(defaultValue, 0);
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < width; c++) values[i * width + c] = name === 'translate' && samples.translations
        ? samples.translations[i * 3 + c] : samples.values[i * 10 + offset + c];
      if (name === 'orient') {
        const at = i * 4;
        normalizeQuaternion(values, at);
        let sign = 1;
        if (i) {
          let dot = 0;
          for (let c = 0; c < 4; c++) dot += values[at - 4 + c] * values[at + c];
          if (dot < 0) sign = -1;
        }
        if (sign < 0) for (let c = 0; c < 4; c++) values[at + c] = -values[at + c];
      }
    }
    // A constant sampled pose can still differ from the authored default
    // (e.g. an MU moving before its first grid point): retain that override.
    let moving = n > 0 && values.subarray(0, width).some((v, c) => v !== defaultValue[c]);
    for (let i = width; i < values.length; i++) if (values[i] !== values[i % width]) { moving = true; break; }
    if (!moving) return { defaultValue, frames: new Uint32Array(), values: new Values() };
    let limit = tolerance[name];
    if (name === 'translate' && limit > 0) {
      let magnitude = 1;
      for (const value of values) magnitude = Math.max(magnitude, Math.abs(value));
      // Reserve a few double ulps for USD's equivalent Lerp arithmetic order.
      limit = Math.max(0, limit - 32 * Number.EPSILON * magnitude * Math.sqrt(3));
    }
    const required = new Uint8Array(n);
    required[0] = required[n - 1] = 1;
    for (let i = 0; i < n; i++) if (samples.mandatory[i] & bit) required[i] = 1;
    for (const frame of options.stepFrames?.[name] ?? []) {
      const index = samples.frames.indexOf(frame);
      if (index <= 0 || samples.frames[index - 1] !== frame - 1) throw new Error(`Step ${frame} needs its preceding frame`);
      required[index - 1] = required[index] = 1;
    }
    const interpolated = new Float32Array(width);
    const qa = new Quaternion(), qb = new Quaternion();
    const error = (start: number, end: number, at: number): number => {
      const alpha = (samples.frames[at] - samples.frames[start]) / (samples.frames[end] - samples.frames[start]);
      if (name === 'orient') {
        qa.fromArray(values, start * 4).slerp(qb.fromArray(values, end * 4), alpha).toArray(interpolated);
        let dot = 0, a = 0, b = 0;
        for (let c = 0; c < 4; c++) {
          const v = values[at * 4 + c], p = interpolated[c];
          dot += p * v; a += v * v; b += p * p;
        }
        return 2 * Math.acos(Math.min(1, Math.abs(dot) / Math.sqrt(a * b)));
      }
      let sum = 0, relative = 0;
      for (let c = 0; c < 3; c++) {
        const expected = values[start * 3 + c] + (values[end * 3 + c] - values[start * 3 + c]) * alpha;
        const actual = values[at * 3 + c], delta = Math.abs(actual - expected);
        sum += delta * delta;
        relative = Math.max(relative, delta / Math.max(Math.abs(actual), Math.abs(expected), 1e-12));
      }
      return name === 'translate' ? Math.sqrt(sum) : relative;
    };
    if (limit === 0) required.fill(1);
    else {
      const anchors: number[] = [];
      for (let i = 0; i < n; i++) if (required[i]) anchors.push(i);
      const stack: number[] = [];
      for (let i = 1; i < anchors.length; i++) stack.push(anchors[i - 1], anchors[i]);
      while (stack.length) {
        const end = stack.pop()!, start = stack.pop()!;
        let worst = limit, split = -1;
        for (let at = start + 1; at < end; at++) {
          const e = error(start, end, at);
          if (e > worst) { worst = e; split = at; }
        }
        if (split >= 0) { required[split] = 1; stack.push(start, split, split, end); }
      }
    }
    const indices: number[] = [];
    for (let i = 0; i < n; i++) if (required[i]) indices.push(i);
    const frames = Uint32Array.from(indices, (i) => samples.frames[i]);
    const reduced = new Values(indices.length * width);
    indices.forEach((index, i) => reduced.set(values.subarray(index * width, (index + 1) * width), i * width));
    return { defaultValue, frames, values: reduced };
  };
  return { translate: channel('translate', 0, 3, 1), orient: channel('orient', 3, 4, 2), scale: channel('scale', 7, 3, 4) };
}
