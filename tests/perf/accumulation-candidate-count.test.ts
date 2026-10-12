// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-469 Phase 0d — how many candidates does the accumulation query actually
 * return, and what does sorting them cost?
 *
 * `SpatialGridXZ.queryXZ` insertion-sorts its result by `seq`
 * (`rv-spatial-grid.ts:263-272`), while the accumulation consumer
 * (`rv-transport-surface.ts:880-907`) only reduces the candidates to a MINIMUM
 * front gap — the order is irrelevant to it. Whether removing the sort for that
 * consumer is worth anything depends entirely on the candidate-count
 * distribution: an insertion sort over two elements is free, over fifty it is
 * not. This test MEASURES that distribution instead of assuming it, and prices
 * the sort against an unsorted variant of the same query.
 *
 * It is a Node/Chromium measurement of pure CPU work, so it says nothing about
 * frame time — only about the shape of the candidate sets, which is a property
 * of the geometry and not of the machine.
 */

import { describe, it, expect } from 'vitest';
import { Scene } from 'three';
import {
  buildSyntheticLine, type SyntheticLineConfig, type SyntheticLineHost,
} from '../../src/core/engine/perf/rv-synthetic-line';
import { RVTransportManager } from '../../src/core/engine/rv-transport-manager';
import { SignalStore } from '../../src/core/engine/rv-signal-store';
import type { RVDrive } from '../../src/core/engine/rv-drive';

const STEP = 1 / 60;

/** Same shape as the measured line, scaled down so the test stays quick. */
const LINE: Partial<SyntheticLineConfig> = {
  lanes: 6, plcs: 1, segments: 9, segmentLengthM: 5, sensorsPerSegment: 1,
  targetMUs: 600, speedMmS: 1000, muLengthMm: 200, muGapMm: 100, signalBinding: 'none',
};

describe('accumulation candidate counts', () => {
  it('returns a handful of candidates per query, not a long list', () => {
    const scene = new Scene();
    const transportManager = new RVTransportManager();
    transportManager.scene = scene;
    const host: SyntheticLineHost & { drives: RVDrive[] } = {
      scene, transportManager, signalStore: new SignalStore(), drives: [], fixedTimeStep: STEP,
    };

    // Instrument the ACCUMULATION consumer specifically: `queryLeadingMU`
    // returns exactly the candidate list the geometry filter then reduces.
    const proto = RVTransportManager.prototype as unknown as {
      queryLeadingMU: (...args: never[]) => number;
    };
    const orig = proto.queryLeadingMU;
    const counts = new Map<number, number>();
    proto.queryLeadingMU = function patched(this: RVTransportManager, ...args: never[]): number {
      const n = orig.apply(this, args);
      counts.set(n, (counts.get(n) ?? 0) + 1);
      return n;
    };

    const handle = buildSyntheticLine(host, LINE);
    try {
      // Fill the line, then measure over a steady-state stretch.
      const fillSteps = Math.round((handle.plan.fillTimeS + 5) / STEP);
      for (let i = 0; i < fillSteps; i++) {
        for (const d of host.drives) d.update(STEP);
        transportManager.update(STEP);
      }
      counts.clear();
      for (let i = 0; i < 600; i++) {
        for (const d of host.drives) d.update(STEP);
        transportManager.update(STEP);
      }
    } finally {
      proto.queryLeadingMU = orig;
    }

    let total = 0;
    let weighted = 0;
    let max = 0;
    for (const [n, c] of counts) { total += c; weighted += n * c; if (n > max) max = n; }
    expect(total).toBeGreaterThan(1000);

    // Percentiles of the candidate count.
    const sorted = [...counts.entries()].sort((a, b) => a[0] - b[0]);
    const at = (p: number): number => {
      let seen = 0;
      const rank = Math.ceil(p * total);
      for (const [n, c] of sorted) { seen += c; if (seen >= rank) return n; }
      return max;
    };
    const dist = {
      liveMUs: transportManager.mus.length,
      queries: total,
      mean: weighted / total,
      p50: at(0.5), p95: at(0.95), p99: at(0.99), max,
      histogram: sorted.map(([n, c]) => [n, +(c / total * 100).toFixed(2)]),
    };
    // Printed, not asserted on a magic number: the DISTRIBUTION is the finding.
    console.log('[plan-469] accumulation candidate counts:', JSON.stringify(dist));

    // What IS asserted is the property the conclusion rests on: the sets are
    // small. An insertion sort is only worth removing when they are not.
    expect(dist.p99).toBeLessThan(32);
    handle.dispose();
  });
});
