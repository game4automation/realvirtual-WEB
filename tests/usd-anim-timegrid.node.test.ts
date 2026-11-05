// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>
import { describe, expect, it } from 'vitest';
import { Matrix4, Object3D, Quaternion, Scene, Vector3 } from 'three';
import { TimeSampleStore } from '../src/core/usd/time-sample-store';
import { createTimelineSampler } from '../src/core/usd/motion-sampler';

function pose(x: number): number[] { return new Matrix4().makeTranslation(x, 0, 0).elements; }

describe('simulation time grid', () => {
  it('retains original root/MU translations, including a move onto the previous Float32-rounded value', () => {
    const scene = new Scene(), root = new Object3D(), mu = new Object3D(); scene.add(root); root.add(mu);
    const store = new TimeSampleStore(30, 1);
    const trackedMu = { id: 1, node: mu, isInstanced: false, getPosition: () => mu.position, getQuaternion: () => mu.quaternion };
    const sampler = createTimelineSampler({ nodes: [root], mus: () => [trackedMu], preplaced: new Map([[1, mu]]), templateIndexOf: () => -1, sink: store });
    const positions = [1234.0001781, Math.fround(1234.0001781), 1234.1002681, 1234.2001781];
    positions.forEach((x, frame) => {
      root.position.x = x;
      store.beginTick(frame / 30); sampler.sample(); store.endTick();
    });
    store.finish();
    for (const track of [store.getPrimTracks()[0], store.getMuTracks()[0]]) {
      expect(track.frames).toEqual(new Uint32Array([0, 1, 2, 3]));
      expect(track.defaultTranslation![0]).toBe(positions[0]);
      expect([...track.translations!].filter((_, i) => i % 3 === 0)).toEqual(positions);
    }
  });
  for (const fps of [24, 30, 60]) for (const speed of [1, 2]) {
    it(`${fps} fps, override ${speed}: 60 sim seconds, not tick count`, () => {
      const store = new TimeSampleStore(fps, 1);
      for (let tick = 0; tick <= 3600 / speed; tick++) {
        const time = tick * speed / 60;
        store.beginTick(100 + time); store.onNodes(0, pose(time)); store.endTick();
      }
      store.finish();
      expect(store.frameCount).toBe(60 * fps + 1);
      expect(store.endFrame / fps).toBe(60);
      const track = store.getPrimTracks()[0];
      for (let i = 0; i < track.frames.length; i++) expect(track.values[i * 10]).toBeCloseTo(track.frames[i] / fps, 4);
    });
  }
  it('interpolates translation, scale and quaternion between surrounding ticks', () => {
    const store = new TimeSampleStore(24, 1);
    const a = new Matrix4(), b = new Matrix4().compose(new Vector3(6, 0, 0), new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2), new Vector3(3, 3, 3));
    store.beginTick(0); store.onNodes(0, a.elements); store.endTick();
    store.beginTick(1 / 12); store.onNodes(0, b.elements); store.endTick(); store.finish();
    const tr = store.getPrimTracks()[0];
    expect(tr.frames).toEqual(new Uint32Array([0, 1, 2]));
    expect(tr.values[10]).toBe(3);
    expect(tr.values[17]).toBe(2);
    expect(tr.values[14]).toBeCloseTo(Math.sin(Math.PI / 8), 6);
    expect(tr.values[16]).toBeCloseTo(Math.cos(Math.PI / 8), 6);
  });
  it('pause creates no frames and backwards/non-finite times refuse', () => {
    const store = new TimeSampleStore(30, 0);
    for (let i = 0; i < 10; i++) { store.beginTick(4); store.endTick(); }
    expect(store.frameCount).toBe(1);
    expect(() => store.beginTick(3)).toThrow('backwards');
    expect(() => store.beginTick(NaN)).toThrow();
  });
  it('timeline tracks root world pose, non-drive nodes, and preplaced MU only once across grip/release', () => {
    const scene = new Scene(), parent = new Object3D(), root = new Object3D(), late = new Object3D(), muNode = new Object3D();
    scene.add(parent); parent.add(root); root.add(late, muNode); parent.position.x = 8; muNode.position.x = 2;
    const store = new TimeSampleStore(30, 3);
    const sampler = createTimelineSampler({ nodes: [root, late, muNode], mus: () => [], preplaced: new Map([[10, muNode]]), templateIndexOf: () => -1, sink: store });
    const tick = (t: number) => { store.beginTick(t); sampler.sample(); store.endTick(); };
    tick(0);
    scene.attach(muNode); tick(1 / 30);
    late.position.y = 2; parent.position.x = 9; muNode.position.x = 12; tick(2 / 30);
    store.finish();
    expect(store.getPrimDefault(0)?.[0]).toBe(8);
    expect(store.getPrimDefault(2)).toBeUndefined();
    expect(store.getPrimTracks().map((t) => t.primIndex)).toEqual([0, 1]);
    const mu = store.getMuTracks();
    expect(mu).toHaveLength(1); expect(mu[0].templateIndex).toBe(-1);
    expect(mu[0].defaultValue[0]).toBe(10); expect(mu[0].values.at(-10)).toBe(12);
  });
  it('MU lifecycle snaps to first grid at or after the event and never interpolates before spawn', () => {
    const store = new TimeSampleStore(30, 0);
    store.beginTick(0); store.endTick();
    store.beginTick(0.05); store.onMuSpawn(4, 2, pose(7)); store.endTick();
    store.beginTick(0.1); store.onMuPoses(4, pose(10)); store.endTick();
    store.beginTick(0.12); store.onMuDelete(4); store.endTick(); store.finish();
    const mu = store.getMuTracks()[0];
    expect(mu.spawnFrame).toBe(2); expect(mu.destroyFrame).toBe(4);
    expect([...mu.frames].every((f) => f >= 2 && f < 4)).toBe(true);
  });
});
