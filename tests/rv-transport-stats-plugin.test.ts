// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * TransportStatsPlugin Tests
 *
 * Validates ring buffer sampling at 10Hz, event emission on spawn/consume
 * counter changes, and clear/reset behaviour.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { TransportStatsPlugin } from '../src/plugins/transport-stats-plugin';

// Minimal mock viewer with event capture
function createMockViewer(transportManager?: { totalSpawned: number; totalConsumed: number }) {
  const events: Array<{ name: string; data: unknown }> = [];
  return {
    transportManager: transportManager ?? null,
    emit(name: string, data: unknown) {
      events.push({ name, data });
    },
    events,
  };
}

// Minimal mock LoadResult
function createMockLoadResult() {
  return { registry: null } as any;
}

describe('TransportStatsPlugin', () => {
  let plugin: TransportStatsPlugin;

  beforeEach(() => {
    plugin = new TransportStatsPlugin();
  });

  it('should have correct plugin id', () => {
    expect(plugin.id).toBe('transport-stats');
  });

  it('should start with empty buffers', () => {
    expect(plugin.timeBuffer.count).toBe(0);
    expect(plugin.spawnedBuffer.count).toBe(0);
    expect(plugin.consumedBuffer.count).toBe(0);
  });

  it('should not sample without a viewer', () => {
    // Calling onFixedUpdatePost without onModelLoaded should be safe
    plugin.onFixedUpdatePost(0.2);
    expect(plugin.timeBuffer.count).toBe(0);
  });

  it('should sample at 10Hz intervals', () => {
    const tm = { totalSpawned: 0, totalConsumed: 0 };
    const viewer = createMockViewer(tm);
    plugin.onModelLoaded(createMockLoadResult(), viewer as any);

    // 5 ticks of 0.02s each = 0.1s total = 1 sample at 10Hz
    for (let i = 0; i < 5; i++) {
      plugin.onFixedUpdatePost(0.02);
    }
    expect(plugin.timeBuffer.count).toBe(1);
    expect(plugin.spawnedBuffer.last()).toBe(0);
    expect(plugin.consumedBuffer.last()).toBe(0);
  });

  it('should not sample before interval elapses', () => {
    const tm = { totalSpawned: 0, totalConsumed: 0 };
    const viewer = createMockViewer(tm);
    plugin.onModelLoaded(createMockLoadResult(), viewer as any);

    // 0.05s < 0.1s interval
    plugin.onFixedUpdatePost(0.05);
    expect(plugin.timeBuffer.count).toBe(0);
  });

  it('should emit mu-spawned when totalSpawned changes', () => {
    const tm = { totalSpawned: 0, totalConsumed: 0 };
    const viewer = createMockViewer(tm);
    plugin.onModelLoaded(createMockLoadResult(), viewer as any);

    // First sample — no change
    plugin.onFixedUpdatePost(0.1);
    expect(viewer.events.length).toBe(0);

    // Increment spawned counter, trigger another sample
    tm.totalSpawned = 3;
    plugin.onFixedUpdatePost(0.1);

    const spawnEvents = viewer.events.filter((e) => e.name === 'mu-spawned');
    expect(spawnEvents.length).toBe(1);
    expect(spawnEvents[0].data).toEqual({ totalSpawned: 3 });
  });

  it('should emit mu-consumed when totalConsumed changes', () => {
    const tm = { totalSpawned: 0, totalConsumed: 0 };
    const viewer = createMockViewer(tm);
    plugin.onModelLoaded(createMockLoadResult(), viewer as any);

    plugin.onFixedUpdatePost(0.1); // baseline sample
    tm.totalConsumed = 2;
    plugin.onFixedUpdatePost(0.1);

    const consumeEvents = viewer.events.filter((e) => e.name === 'mu-consumed');
    expect(consumeEvents.length).toBe(1);
    expect(consumeEvents[0].data).toEqual({ totalConsumed: 2 });
  });

  it('should not emit duplicate events when counters stay the same', () => {
    const tm = { totalSpawned: 5, totalConsumed: 3 };
    const viewer = createMockViewer(tm);
    plugin.onModelLoaded(createMockLoadResult(), viewer as any);

    // First sample emits both (changed from 0 to 5/3)
    plugin.onFixedUpdatePost(0.1);
    const initialCount = viewer.events.length;

    // Second sample with same values — no new events
    plugin.onFixedUpdatePost(0.1);
    expect(viewer.events.length).toBe(initialCount);
  });

  it('should record correct time, spawned, and consumed values', () => {
    const tm = { totalSpawned: 0, totalConsumed: 0 };
    const viewer = createMockViewer(tm);
    plugin.onModelLoaded(createMockLoadResult(), viewer as any);

    // Sample 1: t=0.1
    plugin.onFixedUpdatePost(0.1);
    // Sample 2: t=0.2, spawned=1
    tm.totalSpawned = 1;
    plugin.onFixedUpdatePost(0.1);
    // Sample 3: t=0.3, consumed=1
    tm.totalConsumed = 1;
    plugin.onFixedUpdatePost(0.1);

    expect(plugin.timeBuffer.count).toBe(3);
    expect(plugin.spawnedBuffer.toArray()).toEqual([0, 1, 1]);
    expect(plugin.consumedBuffer.toArray()).toEqual([0, 0, 1]);
  });

  it('should clear buffers on onModelCleared', () => {
    const tm = { totalSpawned: 5, totalConsumed: 3 };
    const viewer = createMockViewer(tm);
    plugin.onModelLoaded(createMockLoadResult(), viewer as any);

    plugin.onFixedUpdatePost(0.1);
    expect(plugin.timeBuffer.count).toBe(1);

    plugin.onModelCleared!();
    expect(plugin.timeBuffer.count).toBe(0);
    expect(plugin.spawnedBuffer.count).toBe(0);
    expect(plugin.consumedBuffer.count).toBe(0);
  });

  it('should reset counters on onModelLoaded with new model', () => {
    const tm = { totalSpawned: 10, totalConsumed: 5 };
    const viewer = createMockViewer(tm);
    plugin.onModelLoaded(createMockLoadResult(), viewer as any);

    plugin.onFixedUpdatePost(0.1);
    expect(plugin.spawnedBuffer.count).toBe(1);

    // Load new model — should clear
    const tm2 = { totalSpawned: 0, totalConsumed: 0 };
    const viewer2 = createMockViewer(tm2);
    plugin.onModelLoaded(createMockLoadResult(), viewer2 as any);

    expect(plugin.timeBuffer.count).toBe(0);
    expect(plugin.spawnedBuffer.count).toBe(0);
  });

  it('should handle no transportManager gracefully', () => {
    const viewer = createMockViewer(); // no transport manager
    plugin.onModelLoaded(createMockLoadResult(), viewer as any);

    // Should not throw or sample
    plugin.onFixedUpdatePost(0.1);
    expect(plugin.timeBuffer.count).toBe(0);
  });

  it('should accumulate multiple samples over time', () => {
    const tm = { totalSpawned: 0, totalConsumed: 0 };
    const viewer = createMockViewer(tm);
    plugin.onModelLoaded(createMockLoadResult(), viewer as any);

    // 10 samples at 10Hz = 1 second
    for (let i = 0; i < 10; i++) {
      tm.totalSpawned = i;
      plugin.onFixedUpdatePost(0.1);
    }

    expect(plugin.timeBuffer.count).toBe(10);
    expect(plugin.spawnedBuffer.toArray()).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });
});
