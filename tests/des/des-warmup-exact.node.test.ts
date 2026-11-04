// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it, vi } from 'vitest';
import { DESMode } from '@rv/plugins/des/rv-des-manager';
import { registerAction } from '@rv/plugins/des/rv-des-named-actions';
import { statisticsFixture } from './phase1-statistics-fixture';

describe('9.1 exact warmup boundary', () => {
  it('does not finish a target batch before a queued warmup and checkpoint are processed', () => {
    const { manager, component, schedule } = statisticsFixture(15);
    manager.duration = 100;
    schedule(20); // Model events at 10 and 20; target 18 lies between them.
    manager.scheduleCheckpoint(16);
    manager.setProcessingTarget(18);
    const times: number[] = [];
    manager.addTimeAdvanceListener(time => times.push(time));
    const resetTimes: number[] = [];
    const reset = component.resetStatistics.bind(component);
    const resetSpy = vi.spyOn(component, 'resetStatistics').mockImplementation(() => {
      resetTimes.push(manager.currentTime);
      reset();
    });
    const checkpoints: number[] = [];
    manager.onCheckpoint = time => { checkpoints.push(time); };
    try {
      expect(manager.runBatch(1)).toEqual({ done: false, eventsProcessed: 1 });
      expect(manager.currentTime).toBe(10);
      expect(component.getStatistics().totalProcessed).toBe(1);
      expect(resetTimes).toEqual([]);
      expect(manager.nextModelEventTime).toBe(20);

      expect(manager.runBatch(1)).toEqual({ done: false, eventsProcessed: 1 });
      expect(manager.currentTime).toBe(15);
      expect(resetTimes).toEqual([15]);
      expect(component.getStatistics().totalProcessed).toBe(0);
      expect(checkpoints).toEqual([]);

      expect(manager.runBatch(1)).toEqual({ done: true, eventsProcessed: 1 });
      expect(manager.currentTime).toBe(18);
      expect(checkpoints).toEqual([16]);
      expect(manager.totalEventsProcessed).toBe(1);
      expect(manager.nextModelEventTime).toBe(20);
      times.push(manager.currentTime);
      manager.setProcessingTarget(null);
      manager.runBatch(1);
      expect(manager.currentTime).toBe(20);
      expect(component.getStatistics().totalProcessed).toBe(1);
      expect(times).toEqual([10, 15, 16, 18, 20]);
      expect(resetTimes).toEqual([15]);
    } finally {
      resetSpy.mockRestore();
    }
  });

  it('has identical statistics in FF batches 1/2000/5000 and Step, without counting warmup', () => {
    function run(batch: number | 'step', warmup: number) {
      const { manager, component, schedule } = statisticsFixture(warmup);
      schedule();
      manager.mode = batch === 'step' ? DESMode.Step : DESMode.FastForward;
      const resetTimes: number[] = [];
      const reset = component.resetStatistics.bind(component);
      vi.spyOn(component, 'resetStatistics').mockImplementation(() => {
        resetTimes.push(manager.currentTime);
        reset();
      });
      for (let guard = 0; !manager.isComplete && guard < 1000; guard++) {
        if (batch === 'step') manager.processStep();
        else manager.processEvents(batch);
      }
      expect(manager.isComplete).toBe(true);
      return { stats: component.getStatistics(), events: manager.totalEventsProcessed, resetTimes };
    }
    const reference = run('step', 100);
    const noWarmup = run(5000, 0);
    for (const batch of [1, 2000, 5000, 'step'] as const) {
      const actual = run(batch, 100);
      expect.soft(actual.resetTimes, `batch ${batch}`).toEqual([100]);
      expect.soft(actual.stats, `batch ${batch}`).toEqual(reference.stats);
      expect.soft(actual.stats.totalProcessed, `event at t=100 belongs to the new window`).toBe(21);
      expect.soft(actual.events).toBe(noWarmup.events);
    }
  });

  it('orders warmup before the model event before the checkpoint at t=100', () => {
    const { manager, component } = statisticsFixture(100);
    const log: string[] = [];
    const reset = component.resetStatistics.bind(component);
    vi.spyOn(component, 'resetStatistics').mockImplementation(() => {
      log.push(`warmup:${manager.currentTime}`);
      reset();
    });
    const action = registerAction('Plan2006.Warmup.Order', ctx => { log.push(`model:${ctx.simTime}`); });
    manager.scheduleEventByIndex(100, action, component.entityId);
    // Keep a later model event so the checkpoint at 100 is not an orphan.
    manager.scheduleEventByIndex(200, action, component.entityId);
    manager.scheduleCheckpoint(100);
    manager.onCheckpoint = time => { log.push(`checkpoint:${time}`); };
    manager.processUpTo(100, 5000);
    expect(log).toEqual(['warmup:100', 'model:100', 'checkpoint:100']);
    expect(manager.totalEventsProcessed).toBe(1);
  });

  it('ends at the last model event when only warmup/checkpoint system events remain', () => {
    function run(systemEvents: boolean) {
      const { manager, schedule } = statisticsFixture(systemEvents ? 100 : 0);
      schedule(50);
      if (systemEvents) manager.scheduleCheckpoint(100);
      manager.processUpTo(50, 5000);
      expect(manager.isComplete).toBe(true);
      // Explicit drain must discard orphan system events without advancing time.
      manager.runBatch(5000);
      return [manager.currentTime, manager.totalEventsProcessed];
    }
    expect(run(true)).toEqual(run(false));
  });
  it('a warmup set below the current clock resets now and never moves the clock backwards (review finding)', () => {
    const { manager, component, schedule } = statisticsFixture(0);
    schedule();
    manager.processUpTo(150, 5000);
    const t = manager.currentTime;
    expect(t).toBeGreaterThanOrEqual(100);
    const resetTimes: number[] = [];
    const reset = component.resetStatistics.bind(component);
    vi.spyOn(component, 'resetStatistics').mockImplementation(() => {
      resetTimes.push(manager.currentTime);
      reset();
    });
    let minSeen = Number.POSITIVE_INFINITY;
    const watch = registerAction('Plan2006.Warmup.Watch', ctx => { minSeen = Math.min(minSeen, ctx.simTime); });
    manager.scheduleEventByIndex(t + 1, watch, component.entityId);
    manager.statResetTime = 50; // already passed
    manager.processUpTo(t + 1, 5000);
    expect(manager.currentTime).toBeGreaterThanOrEqual(t);
    expect(resetTimes).toEqual([t]);
    expect(minSeen).toBe(t + 1);
  });
});
