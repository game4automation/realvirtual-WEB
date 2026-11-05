// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>
import { describe, expect, it, vi } from 'vitest';
import { Matrix4, Object3D, Scene } from 'three';
import { createTimelineSampler } from '../src/core/usd/motion-sampler';
import { TimeSampleStore, type PoseSamples } from '../src/core/usd/time-sample-store';
import { reduceKeyframes } from '../src/core/usd/keyframe-reduce';

function expectMatrixAt(track: PoseSamples, frame: number, expected: Matrix4): void {
  const index = track.frames.indexOf(frame);
  expect(index, `missing matrix frame ${frame}`).toBeGreaterThanOrEqual(0);
  expect(track.matrix).toBeInstanceOf(Float32Array);
  expect(track.matrix!.length).toBe(track.frames.length * 16);
  for (let j = 0; j < 16; j++) expect(track.matrix![index * 16 + j]).toBeCloseTo(expected.elements[j], 5);
  const reduced = reduceKeyframes(track, { tolerance: { translate: 100, orient: 100, scale: 100 } });
  expect(reduced.matrix?.frames).toEqual(track.frames);
  expect(Float32Array.from(reduced.matrix!.values)).toEqual(track.matrix);
  expect(reduced.matrix!.values.slice(index * 16 + 12, index * 16 + 15)).toEqual(track.translations!.slice(index * 3, index * 3 + 3));
  expect(reduced.translate.frames).toHaveLength(0);
  expect(reduced.orient.frames).toHaveLength(0);
  expect(reduced.scale.frames).toHaveLength(0);
}

describe('PV1 capture-time shear fallback', () => {
  for (const kind of ['local', 'root', 'mu'] as const) {
    it(`${kind}: late Scale(2,1,1) x RotationZ(45deg) promotes the entire recording`, () => {
      const scene = new Scene(), parent = new Object3D(), target = new Object3D(), root = new Object3D();
      scene.add(parent); parent.add(target);
      target.rotation.z = Math.PI / 4;
      const local = new Object3D(); local.matrixAutoUpdate = false;
      if (kind === 'local') { scene.add(root); root.add(local); }
      const store = new TimeSampleStore(30, kind === 'local' ? 2 : 1);
      const mu = { id: 7, node: target, isInstanced: false, getPosition: () => target.position, getQuaternion: () => target.quaternion };
      const sampler = createTimelineSampler({
        nodes: kind === 'local' ? [root, local] : kind === 'root' ? [target] : [root],
        mus: () => kind === 'mu' ? [mu] : [], preplaced: new Map(), templateIndexOf: () => 0, sink: store,
      });
      const expected: Matrix4[] = [];
      const k = 4;
      for (let frame = 0; frame <= 8; frame++) {
        // Return to TRS later: the whole recording must remain a matrix track.
        parent.scale.set(frame >= k && frame < 7 ? 2 : 1, 1, 1);
        target.position.x = frame < 2 ? 0 : frame / 10;
        target.updateWorldMatrix(true, false);
        expected.push(target.matrixWorld.clone());
        // Read the sheared matrix into a local matrix-only runtime node without
        // Object3D.attach(): attach itself decomposes and would lose the shear.
        if (kind === 'local') local.matrix.copy(target.matrixWorld);
        store.beginTick(frame / 30); sampler.sample(); store.endTick();
        if (frame === k - 1) {
          const before = kind === 'mu' ? store.getMuTracks()[0] : store.getPrimTracks().find((t) => t.primIndex === (kind === 'local' ? 1 : 0));
          expect(before?.matrixFallback).toBe(false);
        }

      }
      store.finish();
      const track = kind === 'mu' ? store.getMuTracks()[0] : store.getPrimTracks().find((t) => t.primIndex === (kind === 'local' ? 1 : 0))!;
      expect(track.matrixFallback).toBe(true);
      for (const frame of [0, 2, 3, k, 6, 7, 8]) expectMatrixAt(track, frame, expected[frame]);
      const firstShear = track.frames.indexOf(k);
      expect(track.matrix!.slice(firstShear * 16, (firstShear + 1) * 16)).toEqual(Float32Array.from(expected[k].elements));
      expect(track.defaultValue).toHaveLength(16);
      if (kind !== 'mu') expect(store.getPrimDefault(kind === 'local' ? 1 : 0)).toHaveLength(16);
    });
  }
  it('rejects shear before decompose and never decomposes this prim again, even after TRS returns', () => {
    const store = new TimeSampleStore(30, 1);
    const shear = new Matrix4().makeScale(2, 1, 1).multiply(new Matrix4().makeRotationZ(Math.PI / 4));
    const decompose = vi.spyOn(Matrix4.prototype, 'decompose');
    try {
      store.beginTick(0); store.onNodes(0, shear.elements); store.endTick();
      store.beginTick(1 / 30); store.onNodes(0, new Matrix4().makeTranslation(1, 0, 0).elements); store.endTick();
      expect(decompose).not.toHaveBeenCalled();
    } finally { decompose.mockRestore(); }
  });
  it('keeps reflected, nonuniform TRS on the TRS path', () => {
    const store = new TimeSampleStore(30, 1);
    for (let frame = 0; frame < 3; frame++) {
      const matrix = new Matrix4().makeRotationZ(frame * Math.PI / 4).multiply(new Matrix4().makeScale(-2, 1, 1));
      store.beginTick(frame / 30); store.onNodes(0, matrix.elements); store.endTick();
    }
    store.finish();
    const track = store.getPrimTracks()[0];
    expect(track.matrixFallback).toBe(false); expect(track.matrix).toBeUndefined();
    expect(track.values[7]).toBe(-2);
  });
  it('reconstructs all previously captured TRS frames across chunk boundaries', () => {
    const store = new TimeSampleStore(30, 1), expected: Matrix4[] = [];
    for (let frame = 0; frame <= 320; frame++) {
      const m = new Matrix4().makeTranslation(frame / 100, 1, 2)
        .multiply(new Matrix4().makeScale(frame >= 300 ? 2 : 1, 1, 1))
        .multiply(new Matrix4().makeRotationZ(frame * Math.PI / 400));
      expected.push(m);
      store.beginTick(frame / 30); store.onNodes(0, m.elements); store.endTick();
    }
    store.finish();
    const track = store.getPrimTracks()[0];
    expect(track.frames).toHaveLength(321);
    expect(track.matrix).toBe(track.values);
    for (let frame = 0; frame <= 320; frame++) for (let j = 0; j < 16; j++) {
      expect(track.matrix![frame * 16 + j]).toBeCloseTo(expected[frame].elements[j], 5);
    }
    expectMatrixAt(track, 300, expected[300]);
  });
  it('a sheared tick between grid points still permanently promotes the recording', () => {
    const store = new TimeSampleStore(30, 1);
    const shear = new Matrix4().makeScale(2, 1, 1).multiply(new Matrix4().makeRotationZ(Math.PI / 4));
    for (const [time, m] of [[0, new Matrix4()], [0.01, shear], [0.02, new Matrix4()], [0.04, new Matrix4().makeTranslation(1, 0, 0)]] as const) {
      store.beginTick(time); store.onNodes(0, m.elements); store.endTick();
    }
    store.finish();
    const track = store.getPrimTracks()[0];
    expect(track.matrixFallback).toBe(true);
    expectMatrixAt(track, 0, new Matrix4());
  });
  it('checks reconstruction tolerance and keeps a stationary sheared MU default through reduction', () => {
    const store = new TimeSampleStore(30, 1);
    const nearTrs = new Matrix4(); nearTrs.elements[4] = 1e-7;
    store.beginTick(0); store.onNodes(0, nearTrs.elements); store.endTick();
    const moved = nearTrs.clone(); moved.elements[12] = 1;
    store.beginTick(1 / 30); store.onNodes(0, moved.elements); store.endTick();
    expect(store.getPrimTracks()[0].matrixFallback).toBe(false);
    const shear = new Matrix4().makeScale(2, 1, 1).multiply(new Matrix4().makeRotationZ(Math.PI / 4));
    store.beginTick(2 / 30); store.onMuSpawn(1, 0, shear.elements); store.endTick(); store.finish();
    const mu = store.getMuTracks()[0];
    expect(mu.frames).toHaveLength(0);
    expect(mu.matrix).toHaveLength(0);
    expect(Float32Array.from(reduceKeyframes(mu).matrix!.defaultValue)).toEqual(Float32Array.from(shear.elements));
  });

});
