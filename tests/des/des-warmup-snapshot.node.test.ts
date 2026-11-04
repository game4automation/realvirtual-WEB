// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it, vi } from 'vitest';
import { lineFixture } from './runner-fixture';
import type { DESSnapshotV4 } from '@rv/plugins/des/rv-des-snapshot-v4';
import { statisticsFixture } from './phase1-statistics-fixture';

function fixture() {
  const f = lineFixture({ statResetTime: 100 });
  return { ...f, component: f.station };
}

describe('9.2 warmup snapshot state', () => {
  it('preserves post-warmup statistics at a checkpoint and does not reset them again', () => {
    const f = fixture();
    f.manager.processUpTo(100, 5000);
    f.manager.processUpTo(150, 5000);
    const saved = JSON.parse(JSON.stringify(f.snapshot())) as DESSnapshotV4;
    const stats = f.component.getStatistics();
    expect(stats.totalProcessed).toBeGreaterThan(0);
    f.manager.processUpTo(250, 5000);
    f.restore(saved);
    expect(f.component.getStatistics()).toEqual(stats);
    const reset = vi.spyOn(f.component, 'resetStatistics');
    // No model event due: resuming must not erase the restored window.
    f.manager.processUpTo(150, 5000);
    expect.soft(reset).not.toHaveBeenCalled();
    expect(f.component.getStatistics()).toEqual(stats);
  });

  it('restores the pre-warmup boundary and fires it exactly once at t=100', () => {
    const f = fixture();
    f.manager.processUpTo(50, 5000);
    const saved = JSON.parse(JSON.stringify(f.snapshot())) as DESSnapshotV4;
    f.manager.processUpTo(200, 5000);
    f.restore(saved);
    const times: number[] = [];
    const reset = f.component.resetStatistics.bind(f.component);
    vi.spyOn(f.component, 'resetStatistics').mockImplementation(() => {
      times.push(f.manager.currentTime);
      reset();
    });
    f.manager.processUpTo(150, 5000);
    f.manager.processUpTo(300, 5000);
    expect.soft(f.manager.statResetTime).toBe(100);
    expect(times).toEqual([100]);
  });

  it.each([1, 2, 3])('refuses legacy warmup v%s without mutation', version => {
    const f = fixture(); f.runUntil(150);
    const before = f.runner.snapshotJson();
    expect(() => f.restore({ version, simTime: 50 })).toThrow('des-snapshot-legacy');
    expect(f.runner.snapshotJson()).toBe(before);
  });

  it('round-trips warmup configuration and completion through the manager snapshot', () => {
    const { manager, component, schedule } = statisticsFixture(100);
    schedule();
    manager.processUpTo(100, 5000);
    const saved = JSON.parse(JSON.stringify(manager.snapshot())) as ReturnType<typeof manager.snapshot>;
    manager.reset();
    manager.statResetTime = 75;
    manager.restore(saved);
    const reset = vi.spyOn(component, 'resetStatistics');
    manager.processUpTo(150, 5000);
    expect.soft(manager.statResetTime).toBe(100);
    expect(reset).not.toHaveBeenCalled();
  });
});
