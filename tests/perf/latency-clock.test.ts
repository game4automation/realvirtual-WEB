// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-465 §9.7 — the signal-latency time contract.
 *
 * The publisher's clock and the browser's clock are unrelated, so the harness
 * reports JITTER over a running minimum, never an absolute latency. The most
 * important test here is the one that pins the LIMIT of that method: a constant
 * delay present from the first sample is invisible, and the report must never be
 * read as if it were not (SOL R2#1).
 */

import { describe, it, expect } from 'vitest';
import { RVLatencyClock, RVPerfProbe } from '../../src/core/engine/perf/rv-perf-probe';

/** Feed a series of (publisherTime, transportDelay) pairs into a fresh clock. */
function feed(delays: number[], startSeq = 1, plc = 0): RVLatencyClock {
  const clock = new RVLatencyClock();
  delays.forEach((delay, i) => {
    const tPublisher = i * 50;
    clock.record(plc, startSeq + i, tPublisher, tPublisher + delay);
  });
  return clock;
}

describe('RVLatencyClock', () => {
  it('reports jitter exactly, relative to the running minimum', () => {
    // Base 20 ms with +0/+5/+30 ms of jitter on top.
    const delays = [20, 25, 20, 50, 20, 22];
    const report = feed(delays).report();
    expect(report.samples).toBe(6);
    expect(report.minOffsetMs).toBe(20);
    expect(report.jitter.max).toBe(30);        // the 50 ms sample, minus the 20 ms floor
  });

  it('is BLIND to a constant delay that exists from the first sample', () => {
    // This is the documented limitation, not a rounding error: with no clock
    // synchronisation there is nothing in the data that distinguishes "the
    // network takes 40 ms" from "the publisher's clock is 40 ms behind".
    const jitterPattern = [0, 5, 0, 30, 0, 2];
    const withoutBase = feed(jitterPattern).report();
    const withBase = feed(jitterPattern.map((j) => j + 40)).report();

    expect(withBase.jitter.p50).toBe(withoutBase.jitter.p50);
    expect(withBase.jitter.p95).toBe(withoutBase.jitter.p95);
    expect(withBase.jitter.max).toBe(withoutBase.jitter.max);
    // Only the (uninterpretable) offset differs.
    expect(withBase.minOffsetMs - withoutBase.minOffsetMs).toBe(40);
  });

  it('shows a delay that appears AFTER the minimum was established', () => {
    const clock = new RVLatencyClock();
    for (let i = 0; i < 10; i++) clock.record(0, i + 1, i * 50, i * 50 + 20);
    for (let i = 10; i < 20; i++) clock.record(0, i + 1, i * 50, i * 50 + 60);
    const report = clock.report();
    expect(report.minOffsetMs).toBe(20);
    expect(report.jitter.max).toBe(40);
    expect(report.jitter.p95).toBeGreaterThanOrEqual(40);
  });

  it('counts sequence gaps as coalesced updates', () => {
    const clock = new RVLatencyClock();
    clock.record(0, 1, 0, 10);
    clock.record(0, 2, 50, 60);
    clock.record(0, 7, 300, 310);   // 3,4,5,6 never arrived
    clock.record(0, 8, 350, 360);
    expect(clock.report().coalescedGaps).toBe(4);
    expect(clock.report().samples).toBe(4);
  });

  it('treats a SEQ rollback as a publisher restart and re-establishes the minimum', () => {
    const clock = new RVLatencyClock();
    for (let i = 0; i < 5; i++) clock.record(0, i + 1, i * 50, i * 50 + 20);
    // Publisher restarted: its time base is new, so the old 20 ms floor is
    // meaningless. Without the reset every later sample would read as jitter.
    for (let i = 0; i < 5; i++) clock.record(0, i + 1, i * 50, i * 50 + 500);
    const report = clock.report();
    expect(report.restarts).toBe(1);
    expect(report.coalescedGaps).toBe(0);
    expect(report.jitter.max).toBeLessThan(5);   // the post-restart series is itself steady
  });

  it('keeps a separate sequence run per PLC', () => {
    const clock = new RVLatencyClock();
    clock.record(0, 1, 0, 10);
    clock.record(1, 1, 0, 10);      // PLC 1 starting at 1 is not a rollback
    clock.record(0, 2, 50, 60);
    clock.record(1, 2, 50, 60);
    const report = clock.report();
    expect(report.restarts).toBe(0);
    expect(report.coalescedGaps).toBe(0);
  });

  it('records flush latency separately and exactly (single clock)', () => {
    const clock = new RVLatencyClock();
    for (const ms of [0.5, 1.0, 2.0, 16.0]) clock.recordFlush(ms);
    const report = clock.report();
    expect(report.flush.count).toBe(4);
    expect(report.flush.max).toBe(16);
  });
});

describe('probe delta-arrival hook', () => {
  it('extracts the TS/SEQ pair per PLC out of a raw delta payload', () => {
    const probe = new RVPerfProbe();
    // Exactly the shape the WebSocket facade hands over: a flat signal map plus
    // the main-thread arrival time.
    probe.onDeltaArrival({
      'LINE/PLC0/TS': 0, 'LINE/PLC0/SEQ': 1,
      'LINE/PLC1/TS': 0, 'LINE/PLC1/SEQ': 1,
      'LINE/PLC0/Conv0/Run': true,
      'LOAD/PLC0/S3': 42,
    }, 25);
    probe.onDeltaArrival({
      'LINE/PLC0/TS': 50, 'LINE/PLC0/SEQ': 2,
      'LINE/PLC1/TS': 50, 'LINE/PLC1/SEQ': 4,   // PLC1 lost 2 updates to coalescing
    }, 100);

    const report = probe.latency.report();
    expect(report.samples).toBe(4);
    expect(report.coalescedGaps).toBe(2);
    expect(report.minOffsetMs).toBe(25);
    expect(report.jitter.max).toBe(25);          // second pair: 50 ms delta vs 25 ms floor
  });

  it('ignores a TS without its SEQ rather than inventing a sequence', () => {
    const probe = new RVPerfProbe();
    probe.onDeltaArrival({ 'LINE/PLC0/TS': 10 }, 20);
    expect(probe.latency.report().samples).toBe(0);
  });

  it('closes the flush loop when the arrived value becomes visible in the store', () => {
    // tRecv is stamped at the facade; tCommit is the first fixed step in which
    // the value can be read back out of the store. Both come off ONE clock, so
    // unlike the jitter this figure is exact — and it must stay within a fixed
    // step, which is the contract the buffer/flush design promises.
    const store = new Map<string, boolean | number>();
    let clock = 0;
    const loop = {
      onFixedUpdate: (_dt: number) => {},
      onRender: (_ft: number) => {},
      clampedSeconds: 0, droppedBacklogSeconds: 0, pausedSeconds: 0,
    };
    const probe = new RVPerfProbe();
    probe.start({
      loop,
      now: () => clock,
      isVisible: () => true,
      windowMs: 1e9,
      readSignal: (name) => store.get(name),
    });

    // A delta lands at t = 100; the store does not have it yet.
    clock = 100;
    probe.onDeltaArrival({ 'LINE/PLC0/TS': 40, 'LINE/PLC0/SEQ': 1 }, 100);
    loop.onFixedUpdate(1 / 60);
    expect(probe.latency.report().flush.count).toBe(0);

    // The interface commits it during the next fixed step, 8 ms later.
    clock = 108;
    store.set('LINE/PLC0/TS', 40);
    loop.onFixedUpdate(1 / 60);

    const report = probe.latency.report();
    expect(report.flush.count).toBe(1);
    expect(report.flush.max).toBeCloseTo(8, 6);
    expect(report.flush.max).toBeLessThanOrEqual(1000 / 60);

    // Already resolved — a later step must not count it twice.
    clock = 120;
    loop.onFixedUpdate(1 / 60);
    expect(probe.latency.report().flush.count).toBe(1);
    probe.stop();
  });

  it('does not track arrivals at all without a store reader', () => {
    const loop = {
      onFixedUpdate: (_dt: number) => {},
      onRender: (_ft: number) => {},
      clampedSeconds: 0, droppedBacklogSeconds: 0, pausedSeconds: 0,
    };
    const probe = new RVPerfProbe();
    probe.start({ loop, now: () => 0, isVisible: () => true, windowMs: 1e9 });
    probe.onDeltaArrival({ 'LINE/PLC0/TS': 1, 'LINE/PLC0/SEQ': 1 }, 5);
    loop.onFixedUpdate(1 / 60);
    expect(probe.latency.report().flush.count).toBe(0);
    expect(probe.latency.report().samples).toBe(1);   // jitter still works
    probe.stop();
  });
});
