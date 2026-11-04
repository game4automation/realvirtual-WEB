// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it, vi } from 'vitest';
import { Vector3 } from 'three';
import { EntityStream, type EntityStreamConfig } from '@rv/core/engine/rv-entity-stream';
import { LineSegment, RVPath } from '@rv/core/engine/rv-path';

const path = new RVPath('road', [new LineSegment(new Vector3(), new Vector3(100, 0, 0))]);
const paths = { get: (id: string) => id === 'road' ? path : null };
const config: EntityStreamConfig = {
  maxExtrapolationMs: 1000, correctionBlendMs: 100, headingBlendMs: 100,
  entityTimeoutMs: 500, snapDistanceM: 25,
};
const pose = () => ({ position: new Vector3() });

describe('EntityStream', () => {
  it('anchors motion to host time under late arrival jitter', () => {
    const stream = new EntityStream({ paths, config: () => config });
    stream.beginBatch(0, 1000); stream.upsert({ id: 'a', pathId: 'road', s: 0, v: 10, a: 0 }); stream.endBatch();
    stream.beginBatch(0.5, 1600); stream.upsert({ id: 'a', pathId: 'road', s: 5, v: 10, a: 0 }); stream.endBatch();
    const out = pose();
    expect(stream.poseOf('a', 1600, out)).toBe(true);
    expect(out.position.x).toBeCloseTo(5, 5);
  });

  it('holds the newest paused batch and applies it on resume', () => {
    const stream = new EntityStream({ paths, config: () => config });
    stream.beginBatch(0, 0); stream.upsert({ id: 'a', pathId: 'road', s: 1, v: 0, a: 0 }); stream.endBatch();
    stream.setPaused(true, 10);
    stream.beginBatch(2, 20); stream.upsert({ id: 'a', pathId: 'road', s: 20, v: 0, a: 0 }); stream.endBatch();
    expect(stream.entities.get('a')?.s0).toBe(1);
    stream.setPaused(false, 30);
    expect(stream.entities.get('a')?.s0).toBe(20);
  });

  it('suppresses timeouts while paused', () => {
    const removed = vi.fn();
    const stream = new EntityStream({ paths, config: () => config, onRemoved: removed });
    stream.beginBatch(0, 0); stream.upsert({ id: 'a', pathId: 'road', s: 0, v: 0, a: 0 }); stream.endBatch();
    stream.setPaused(true, 10); stream.housekeeping(1000);
    expect(stream.entities.has('a')).toBe(true);
    stream.setPaused(false, 1000); stream.housekeeping(1600);
    expect(removed).toHaveBeenCalledOnce();
  });

  it('snaps corrections beyond the configured distance', () => {
    const stream = new EntityStream({ paths, config: () => config });
    stream.beginBatch(0, 0); stream.upsert({ id: 'a', pathId: 'road', s: 0, v: 0, a: 0 }); stream.endBatch();
    stream.beginBatch(1, 1000); stream.upsert({ id: 'a', pathId: 'road', s: 50, v: 0, a: 0 }); stream.endBatch();
    expect(stream.entities.get('a')?.off1D).toBe(0);
    expect(stream.correction.values()).toEqual([50]);
  });
});
