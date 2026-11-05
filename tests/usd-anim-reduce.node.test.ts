// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>
import { describe, expect, it } from 'vitest';
import { Matrix4, Object3D, Quaternion, Scene, Vector3 } from 'three';
import { TimeSampleStore, type PoseSamples } from '../src/core/usd/time-sample-store';
import { createTimelineSampler } from '../src/core/usd/motion-sampler';
import { reduceKeyframes, type ReducedChannel } from '../src/core/usd/keyframe-reduce';

function makeSamples(n: number): PoseSamples {
  const values = new Float32Array(n * 10);
  for (let i = 0; i < n; i++) values.set([0, 0, 0, 0, 0, 0, 1, 1, 1, 1], i * 10);
  return { frames: Uint32Array.from({ length: n }, (_, i) => i), values, mandatory: new Uint8Array(n), matrixFallback: false };
}
function interpolate(channel: ReducedChannel, frame: number, width: number, quat = false): number[] {
  let i = 0;
  while (i + 1 < channel.frames.length - 1 && channel.frames[i + 1] < frame) i++;
  const a = channel.frames[i], b = channel.frames[i + 1], t = (frame - a) / (b - a);
  const out = new Array<number>(width);
  if (quat) new Quaternion().fromArray(channel.values, i * width).slerp(new Quaternion().fromArray(channel.values, (i + 1) * width), t).toArray(out);
  else for (let c = 0; c < width; c++) out[c] = channel.values[i * width + c] + (channel.values[(i + 1) * width + c] - channel.values[i * width + c]) * t;
  return out;
}

describe('channel reduction', () => {
  it('reconstructs every input within translation, angular and relative-scale tolerances across chunks', () => {
    const input = makeSamples(1025);
    for (let i = 0; i < input.frames.length; i++) {
      const q = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 0.8 * Math.sin(i / 99));
      input.values.set([Math.sin(i / 30), Math.cos(i / 50), i / 1000, q.x, q.y, q.z, q.w, 1 + 0.1 * Math.sin(i / 50), 2, -3], i * 10);
    }
    const tolerance = { translate: 0.002, orient: 0.001, scale: 0.001 };
    const r = reduceKeyframes(input, { tolerance });
    expect(r.translate.frames.length).toBeLessThan(1025 / 2);
    expect(r.orient.frames.length).toBeLessThan(1025 / 2);
    for (let f = 0; f < 1025; f++) {
      const t = interpolate(r.translate, f, 3), q = interpolate(r.orient, f, 4, true), s = interpolate(r.scale, f, 3);
      expect(Math.hypot(...t.map((v, c) => v - input.values[f * 10 + c]))).toBeLessThanOrEqual(tolerance.translate + 1e-7);
      const expected = new Quaternion().fromArray(input.values, f * 10 + 3).normalize();
      expect(new Quaternion().fromArray(q).normalize().angleTo(expected)).toBeLessThanOrEqual(tolerance.orient + 1e-6);
      for (let c = 0; c < 3; c++) {
        const actual = input.values[f * 10 + 7 + c];
        expect(Math.abs(s[c] - actual) / Math.max(Math.abs(s[c]), Math.abs(actual))).toBeLessThanOrEqual(tolerance.scale + 1e-7);
      }
    }
    expect(r.translate.frames[0]).toBe(0); expect(r.translate.frames.at(-1)).toBe(1024);
  });
  it('normalizes quaternion hemisphere (q and -q) and leaves a constant channel at default only', () => {
    const input = makeSamples(20);
    for (let i = 0; i < 20; i++) input.values[i * 10 + 6] = i % 2 ? -1 : 1;
    const r = reduceKeyframes(input);
    expect(r.orient.frames).toHaveLength(0); expect(r.orient.defaultValue).toEqual(new Float32Array([0, 0, 0, 1]));
    expect(r.translate.frames).toHaveLength(0); expect(r.scale.frames).toHaveLength(0);
  });
  it('keeps scale-zero step edges even with a tolerance greater than the entire jump', () => {
    const input = makeSamples(101);
    for (let i = 25; i < 75; i++) input.values.fill(0, i * 10 + 7, i * 10 + 10);
    const r = reduceKeyframes(input, { tolerance: { scale: 100 }, stepFrames: { scale: [25, 75] } });
    expect([...r.scale.frames]).toEqual([0, 24, 25, 74, 75, 100]);
    expect(interpolate(r.scale, 50, 3)).toEqual([0, 0, 0]);
    const sparse = { ...input, frames: new Uint32Array([0, 25]), values: input.values.slice(0, 20), mandatory: new Uint8Array(2) };
    sparse.values[17] = 0;
    expect(() => reduceKeyframes(sparse, { stepFrames: { scale: [25] } })).toThrow('preceding frame');
  });
  it('zero tolerance keeps every moving-channel sample', () => {
    const input = makeSamples(10);
    for (let i = 0; i < 10; i++) input.values[i * 10] = i;
    expect(reduceKeyframes(input, { tolerance: { translate: 0 } }).translate.frames).toEqual(input.frames);
  });
  it('store keeps quaternion hemisphere through 180 degrees and reflected transforms', () => {
    const store = new TimeSampleStore(30, 1);
    for (let f = 0; f <= 400; f++) {
      const q = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), f * Math.PI / 200);
      const m = new Matrix4().compose(new Vector3(f / 1000, 0, 0), q, new Vector3(-1, 2, 3));
      store.beginTick(f / 30); store.onNodes(0, m.elements); store.endTick();
    }
    store.finish();
    const tr = store.getPrimTracks()[0];
    expect(tr.matrixFallback).toBe(false);
    expect(tr.frames.length).toBeGreaterThan(256);
    for (let i = 1; i < tr.frames.length; i++) {
      let dot = 0;
      for (let c = 3; c < 7; c++) dot += tr.values[(i - 1) * 10 + c] * tr.values[i * 10 + c];
      expect(dot).toBeGreaterThan(0);
    }
    expect(tr.values[7]).toBe(-1);
    expect(tr.frames.at(-1)).toBe(400);
  });
  it('shear at start or later uses exact matrix fallback, never lossy TRS', () => {
    for (const fromStart of [false, true]) {
      const store = new TimeSampleStore(30, 1);
      for (let f = 0; f <= 3; f++) {
        const m = new Matrix4().makeTranslation(f, 0, 0);
        if (fromStart || f >= 2) m.elements[4] = 0.25;
        store.beginTick(f / 30); store.onNodes(0, m.elements); store.endTick();
      }
      store.finish();
      const tr = store.getPrimTracks()[0];
      expect(tr.matrixFallback).toBe(true);
      expect(tr.values[2 * 16 + 4]).toBe(0.25);
      expect(tr.values[3 * 16 + 12]).toBe(3);
      expect(Float32Array.from(reduceKeyframes(tr).matrix!.values)).toEqual(tr.values);
    }
  });
  for (const kind of ['mu', 'local', 'root'] as const) {
    it(`stationary ${kind}: zero samples retain the complete nontrivial default pose`, () => {
      const scene = new Scene(), root = new Object3D(), node = new Object3D();
      root.position.set(3, 4, 5); scene.add(root); root.add(node);
      if (kind === 'mu') root.position.set(0, 0, 0);
      node.position.set(7, 8, 9);
      node.quaternion.setFromAxisAngle(new Vector3(1, 2, 3).normalize(), 1.1);
      node.scale.set(-2, 3, 4);
      const target = kind === 'root' ? root : node;
      if (kind === 'root') {
        root.quaternion.copy(node.quaternion); root.scale.copy(node.scale);
      }
      const nodes = kind === 'root' ? [root] : kind === 'local' ? [root, node] : [];
      const store = new TimeSampleStore(30, nodes.length);
      const mu = { id: 4, node, isInstanced: false, getPosition: () => node.position, getQuaternion: () => node.quaternion };
      const sampler = createTimelineSampler({ nodes, mus: () => kind === 'mu' ? [mu] : [], preplaced: new Map(), templateIndexOf: () => 0, sink: store });
      for (let frame = 0; frame < 4; frame++) {
        store.beginTick(frame / 30); sampler.sample(); store.endTick();
      }
      store.finish();
      expect(store.getPrimTracks()).toEqual([]);
      const samples: PoseSamples = kind === 'mu' ? store.getMuTracks()[0] : {
        frames: new Uint32Array(), values: new Float32Array(), mandatory: new Uint8Array(), matrixFallback: false,
        defaultValue: store.getPrimDefault(kind === 'root' ? 0 : 1),
      };
      expect(samples.frames).toHaveLength(0);
      const r = reduceKeyframes(samples);
      expect(r.translate.frames).toHaveLength(0); expect(r.orient.frames).toHaveLength(0); expect(r.scale.frames).toHaveLength(0);
      expect(r.translate.defaultValue).toHaveLength(3); expect(r.orient.defaultValue).toHaveLength(4); expect(r.scale.defaultValue).toHaveLength(3);
      const reconstructed = new Matrix4().compose(new Vector3().fromArray(r.translate.defaultValue), new Quaternion().fromArray(r.orient.defaultValue), new Vector3().fromArray(r.scale.defaultValue));
      target.updateWorldMatrix(true, false);
      const expected = kind === 'local' ? target.matrix : target.matrixWorld;
      for (let i = 0; i < 16; i++) expect(reconstructed.elements[i]).toBeCloseTo(expected.elements[i], 5);
    });
  }
  it('normalizes an explicit quaternion default independently of the sample array', () => {
    const samples = makeSamples(0);
    const q = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 0.7);
    samples.defaultValue = new Float32Array([7, 8, 9, q.x * 3, q.y * 3, q.z * 3, q.w * 3, 2, 3, 4]);
    const r = reduceKeyframes(samples);
    expect(r.translate.defaultValue).toEqual(new Float64Array([7, 8, 9]));
    expect(r.scale.defaultValue).toEqual(new Float32Array([2, 3, 4]));
    expect(new Quaternion().fromArray(r.orient.defaultValue).normalize().angleTo(q)).toBeLessThan(1e-6);
    expect(Math.hypot(...r.orient.defaultValue)).toBeCloseTo(1, 6);
  });

  it('retains constant samples which override a different explicit default', () => {
    const samples = makeSamples(2);
    samples.defaultValue = samples.values.slice(0, 10);
    samples.defaultValue[0] = 7;
    samples.values[0] = samples.values[10] = 8;
    const r = reduceKeyframes(samples);
    expect(r.translate.defaultValue).toEqual(new Float64Array([7, 0, 0]));
    expect(r.translate.frames).toEqual(new Uint32Array([0, 1]));
    expect(r.translate.values).toEqual(new Float64Array([8, 0, 0, 8, 0, 0]));
  });

});
