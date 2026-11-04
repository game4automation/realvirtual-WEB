// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-629 §9.1 — the congestion trace accumulator, pure (no simulation):
 * bucket table, stamp de-dupe, sliding window ring, since-start totals,
 * backwards-time reset, geometry rebuild that starts NOW (gate R1-5), topN
 * order, the classifier, and the deterministic work bounds of gate R2-4.
 */

import { describe, it, expect } from 'vitest';
import { parsePathExtras, type RVPath } from '../../src/core/engine/rv-path';
import {
  PathTrace, classifyBlocked, TRACE_SAMPLE_SEC, TRACE_SLOTS, TRACE_BUCKET_M,
  type TraceRow, type TraceSink,
} from '../../src/core/engine/rv-path-trace';

function line(id: string, len: number, z = 0): RVPath {
  return parsePathExtras({
    type: 'Path', version: 1, id, closed: false, align: [0, 1, 0], successors: [],
    segments: [{ kind: 'line', from: [0, 0, z], to: [len, 0, z] }],
  }, id)!;
}

/** Grid points k ≥ 1 with k·Δ < T (the documented count). */
const gridPoints = (T: number): number => Math.max(0, Math.ceil(T / TRACE_SAMPLE_SEC) - 1);

describe('PathTrace accumulator (plan-629 §9.1)', () => {
  it('splits pieces into ~2 m buckets aligned to piece ends', () => {
    const tr = new PathTrace();
    tr.rebuild([line('C', 0.8), line('A', 10), line('B', 3)]);
    expect(tr.paths.map((p) => p.id)).toEqual(['A', 'B', 'C']); // sorted by id
    expect(tr.pathBuckets(0)).toMatchObject({ first: 0, count: 5, length: 2 });
    expect(tr.pathBuckets(1)).toMatchObject({ first: 5, count: 2, length: 1.5 }); // round(1.5) = 2
    expect(tr.pathBuckets(2)).toMatchObject({ first: 7, count: 1 });
    expect(tr.bucketCount).toBe(8);
    expect(tr.bucketRange(4)).toEqual([8, 10]);
    const pos: [number, number, number] = [0, 0, 0];
    expect(tr.bucketPosition(0, pos)[0]).toBeCloseTo(1, 9); // centre of A's first bucket
    expect(TRACE_BUCKET_M).toBe(2);
  });

  it('counts a bucket once per sample even with two vehicles on it', () => {
    const tr = new PathTrace();
    tr.rebuild([line('A', 10)]);
    tr.advanceTo(5.2, (_tk, sink) => {
      sink.cover(0, 0.5, 1.5, true);  // bucket 0
      sink.cover(0, 1.0, 3.0, false); // buckets 0 + 1
    });
    const n = gridPoints(5.2);
    expect(tr.samplesTotal).toBe(n);
    expect(tr.count('utilization', 'start', 0)).toBe(n);
    expect(tr.count('utilization', 'start', 1)).toBe(n);
    expect(tr.count('blocked', 'start', 0)).toBe(n);
    expect(tr.count('blocked', 'start', 1)).toBe(0);
    expect(tr.value('utilization', 'window', 0)).toBe(1);
    expect(tr.count('utilization', 'start', 2)).toBe(0);
  });

  it('window drops slots older than windowSec; start keeps everything', () => {
    const tr = new PathTrace();
    tr.rebuild([line('A', 10)]);
    const sampler = (tk: number, sink: TraceSink): void => { if (tk < 700) sink.cover(0, 0, 1, true); };
    tr.advanceTo(4400, sampler);
    expect(tr.samplesTotal).toBe(gridPoints(4400));
    expect(tr.windowSec).toBe(3600);                                           // default: last hour
    expect(tr.value('blocked', 'window', 0)).toBe(0);
    expect(tr.value('blocked', 'start', 0)).toBe(1399 / gridPoints(4400)); // t = 0.5 … 699.5
    tr.setWindowSec(86400);                                                    // last day still has it
    expect(tr.value('blocked', 'window', 0)).toBe(1399 / gridPoints(4400));
  });

  it('window denominator stays within [(S-1)/S·W, W]', () => {
    const tr = new PathTrace();
    tr.rebuild([line('A', 4)]);
    const W = tr.windowSec;
    const perSec = 1 / TRACE_SAMPLE_SEC;
    for (let T = W + 0.3; T < 3 * W; T += 7.77) {
      tr.advanceTo(T, () => {});
      expect(tr.samplesWindow).toBeGreaterThanOrEqual(((TRACE_SLOTS - 1) / TRACE_SLOTS) * W * perSec - 1);
      expect(tr.samplesWindow).toBeLessThanOrEqual(W * perSec);
    }
  });

  it('time going backwards resets counters and grid', () => {
    const tr = new PathTrace();
    tr.rebuild([line('A', 4)]);
    const s = (_tk: number, sink: TraceSink): void => sink.cover(0, 0, 4, true);
    tr.advanceTo(100.2, s);
    expect(tr.samplesTotal).toBe(gridPoints(100.2));
    tr.advanceTo(3.1, s);                // sim reset: restarts at 0
    expect(tr.simTime).toBe(3.1);
    expect(tr.samplesTotal).toBe(gridPoints(3.1));
    expect(tr.count('blocked', 'start', 0)).toBe(gridPoints(3.1));
    expect(tr.count('blocked', 'window', 0)).toBe(gridPoints(3.1));
  });

  it('a geometry rebuild starts measuring NOW (no back-fill, gate R1-5)', () => {
    const tr = new PathTrace();
    tr.rebuild([line('A', 4)]);
    let calls = 0;
    const s = (_tk: number, sink: TraceSink): void => { calls++; sink.cover(0, 0, 4, false); };
    tr.advanceTo(3600.2, s);
    tr.rebuild([line('A', 4), line('B', 6)]);
    expect(tr.samplesTotal).toBe(0);
    expect(tr.samplesWindow).toBe(0);
    calls = 0;
    tr.advanceTo(3700.2, s);
    expect(calls).toBeLessThanOrEqual(100 / TRACE_SAMPLE_SEC + 1);
    expect(calls).toBe(gridPoints(3700.2) - gridPoints(3600.2));
    expect(tr.samplesTotal).toBe(calls);
    expect(tr.value('utilization', 'start', 0)).toBe(1);
    // A late start (begin mid-run) behaves the same: nothing before `now`.
    const late = new PathTrace();
    late.rebuild([line('A', 4)]);
    late.beginAt(3600);
    calls = 0;
    late.advanceTo(3610.2, s);
    expect(calls).toBe(gridPoints(3610.2) - gridPoints(3600));
  });

  it('setWindowSec selects last hour / last day (others snap) and empties nothing', () => {
    const tr = new PathTrace();
    tr.rebuild([line('A', 4)]);
    tr.advanceTo(50.2, (_tk, sink) => sink.cover(0, 0, 1, true));
    tr.setWindowSec(10);
    expect(tr.windowSec).toBe(3600);
    expect(tr.samplesWindow).toBe(gridPoints(50.2));
    tr.setWindowSec(1e9);
    expect(tr.windowSec).toBe(86400);
    expect(tr.samplesWindow).toBe(gridPoints(50.2));
    expect(tr.value('blocked', 'window', 0)).toBe(1);
    const v0 = tr.version;
    tr.setWindowSec(3600);
    expect(tr.version).toBeGreaterThan(v0); // colour invalidation independent of counter changes
  });

  it('last day holds a full day in bounded storage: 25 h of sim time drop the first hour', () => {
    const tr = new PathTrace();
    tr.rebuild([line('A', 4)]);
    tr.setWindowSec(86400);
    const T = 25 * 3600 + 0.2;
    tr.advanceTo(T, (tk, sink) => { if (tk < 3600) sink.cover(0, 0, 1, true); });
    // Ring of 60 slots × 24 min: the window covers between 23.6 h and 24 h, never the first hour.
    expect(tr.samplesWindow).toBeGreaterThanOrEqual((59 / 60) * 86400 * 2 - 1);
    expect(tr.samplesWindow).toBeLessThanOrEqual(86400 * 2);
    expect(tr.count('blocked', 'window', 0)).toBe(0);
    expect(tr.count('blocked', 'start', 0)).toBe(gridPoints(3600));
  });

  it('topN sorts by value desc, then pathId, then fromM; zeros omitted', () => {
    const tr = new PathTrace();
    tr.rebuild([line('B', 6), line('A', 6, 5)]); // A: buckets 0-2, B: 3-5
    tr.advanceTo(10.2, (tk, sink) => {
      sink.cover(1, 4.5, 5.5, true);              // B bucket 2 (=5): always
      sink.cover(0, 2.5, 3.5, true);              // A bucket 1 (=1): always
      if (tk < 5) sink.cover(0, 0.1, 0.2, true);  // A bucket 0: half
      sink.cover(1, 0.1, 0.2, false);             // B bucket 0: utilization only
    });
    const out: TraceRow[] = [];
    const n = tr.topN('blocked', 'start', 10, out);
    expect(n).toBe(3);
    expect(out.map((r) => [r.pathId, r.fromM])).toEqual([['A', 2], ['B', 4], ['A', 0]]);
    expect(out[0].value).toBe(1);
    expect(out[0].pos[2]).toBeCloseTo(5, 9);
    expect(tr.topN('blocked', 'start', 1, out)).toBe(1);
    expect(out[0].pathId).toBe('A');
    expect(tr.topN('utilization', 'window', 10, out)).toBe(4);
    expect(new PathTrace().topN('blocked', 'start', 5, out)).toBe(0);
  });

  it('classifyBlocked: standing+wantsToMove or blockedFlag; servicing never blocked', () => {
    expect(classifyBlocked(0, true, false)).toBe(true);
    expect(classifyBlocked(0.005, true, false)).toBe(true);
    expect(classifyBlocked(0.5, true, false)).toBe(false);
    expect(classifyBlocked(0, false, false)).toBe(false); // servicing / idle / Run off
    expect(classifyBlocked(0.8, true, true)).toBe(true);  // explicit Agv.Blocked
  });

  it('work counters stay within the gate R2-4 bounds (deterministic)', () => {
    const tr = new PathTrace();
    const paths: RVPath[] = [];
    for (let i = 0; i < 50; i++) paths.push(line(`P${String(i).padStart(2, '0')}`, 20, i * 3));
    tr.rebuild(paths);
    const V = 6, front = 0.8, rear = 1.6;
    const T = 1800.3;
    tr.advanceTo(T, (tk, sink) => {
      for (let v = 0; v < V; v++) {
        tr.work.vehicleEvals++;
        const s = (tk * 0.7 + v * 3.3) % 20;
        sink.cover(v, s - rear, s + front, v % 2 === 0);
      }
    });
    const w = tr.work;
    expect(w.samples).toBe(Math.floor(T / TRACE_SAMPLE_SEC));
    expect(w.vehicleEvals).toBeLessThanOrEqual(V * w.samples);
    expect(w.bucketVisits).toBeLessThanOrEqual(w.covers * (Math.ceil((front + rear) / 2) + 1));
    // Both windows rotate: last hour (60 s slots) and last day (1440 s slots).
    expect(w.slotChanges).toBe(Math.floor(T / (3600 / TRACE_SLOTS)) + Math.floor(T / (86400 / TRACE_SLOTS)));
    expect(w.slotClearBuckets).toBe(w.slotChanges * tr.bucketCount);
    // No full bucket scan per vehicle: total visits are far below vehicles × samples × buckets.
    expect(w.bucketVisits).toBeLessThan(V * w.samples * 4);
  });
});
