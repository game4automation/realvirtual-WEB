// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>
import { describe, expect, it } from 'vitest';
import { Matrix4 } from 'three';
import { TimeSampleStore } from '../src/core/usd/time-sample-store';
import { reduceKeyframes } from '../src/core/usd/keyframe-reduce';

describe('holds and defaults', () => {
  it('keeps hold before restart, hold start and final state through reduction', () => {
    const store = new TimeSampleStore(30, 1);
    for (let f = 0; f <= 200; f++) {
      const x = f === 0 ? 0 : f < 100 ? 1 : 2;
      store.beginTick(f / 30); store.onNodes(0, new Matrix4().makeTranslation(x, 0, 0).elements); store.endTick();
    }
    store.finish();
    const reduced = reduceKeyframes(store.getPrimTracks()[0], { tolerance: { translate: 10 } }).translate;
    expect([...reduced.frames]).toEqual([0, 1, 99, 100, 200]);
    expect([...reduced.values].filter((_, i) => i % 3 === 0)).toEqual([0, 1, 1, 2, 2]);
  });
  it('stationary nodes have defaults and zero samples; a node starting after 5 seconds is still captured', () => {
    const store = new TimeSampleStore(30, 2);
    for (let f = 0; f <= 180; f++) {
      store.beginTick(f / 30);
      store.onNodes(0, new Matrix4().elements);
      store.onNodes(1, new Matrix4().makeTranslation(f < 151 ? 0 : f - 150, 0, 0).elements);
      store.endTick();
    }
    store.finish(); store.finish();
    expect(store.getPrimTracks().map((t) => t.primIndex)).toEqual([1]);
    expect([...store.getPrimTracks()[0].frames]).toContain(150);
    expect(store.getPrimDefault(0)).toHaveLength(10);
    store.dispose(); expect(store.getPrimTracks()).toEqual([]);
    expect(() => store.beginTick(7)).toThrow();
  });
  it('holds are channel-wise when rotation continues during a translation pause', () => {
    const store = new TimeSampleStore(30, 1);
    for (let f = 0; f <= 100; f++) {
      const matrix = new Matrix4().makeRotationY(f / 100);
      matrix.elements[12] = f === 0 ? 0 : f < 100 ? 1 : 2;
      store.beginTick(f / 30); store.onNodes(0, matrix.elements); store.endTick();
    }
    store.finish();
    const reduced = reduceKeyframes(store.getPrimTracks()[0], { tolerance: { translate: 10 } });
    expect([...reduced.translate.frames]).toEqual([0, 1, 99, 100]);
    expect(reduced.orient.frames.length).toBeLessThan(10);
  });
});
