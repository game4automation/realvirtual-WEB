// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-664 §9.10 — what the ray basis costs IN THE BROWSER, over the whole
 * per-scan path and not just the kernel.
 *
 * The Node micro-benchmark next door measures `castFan` + `applyNoise` against
 * a prepared candidate list. The budget in the plan, however, is about a tick
 * in a real scene, so this one adds the two stages the kernel benchmark leaves
 * out and runs them in Chromium:
 *
 *   production XZ broad-phase (`SpatialGridXZ`, the grid the transport manager
 *   uses)  →  candidate collection (`collectCandidates`, boxes + vehicle hulls
 *   + self-exclusion)  →  `castFan`  →  `applyNoise`
 *
 * What it still leaves out is the component layer (rate accumulator, latency
 * ring, signal writes) — that is Phase 2 and gets its own measurement there.
 *
 * Budget: 3 scanners × 271 rays × 200 MUs under 0.5 ms p95 per fixed tick.
 * The hard assertion is an order of magnitude (a loaded CI box must not turn a
 * perf note into a red build); the precise p95 is printed for the plan.
 */

import { describe, it, expect } from 'vitest';
import { Object3D } from 'three';
import { AABB } from '../src/core/engine/rv-aabb';
import { SpatialGridXZ } from '../src/core/engine/rv-spatial-grid';
import { buildFan, castFan, applyNoise, type NoiseParams } from '../src/core/engine/rv-ray-scan';
import { collectCandidates, fanBounds, makeBoxBuffer, type MuLike } from '../src/core/engine/rv-ray-scene-query';
import { makeStream, mulberry32 } from '../src/core/engine/rv-prng';

const RAYS = 271;
const SCANNERS = 3;
const MUS = 200;
const REACH = 8;
const BUDGET_MS = 0.5;

const NOISE: NoiseParams = {
  sigma: 0.005, sigmaPerM: 0.002, dropout: 0.001, dropoutPerM: 0.001,
  resolution: 0.001, rangeMin: 0.02, rangeMax: REACH,
};

/** A minimal MU: what the grid and the candidate collector actually touch. */
function makeMu(cx: number, cz: number): MuLike & { readonly aabb: AABB } {
  const aabb = new AABB();
  aabb.min.set(cx - 0.6, 0, cz - 0.4);
  aabb.max.set(cx + 0.6, 1.2, cz + 0.4);
  aabb.center.set(cx, 0.6, cz);
  aabb.halfSize.set(0.6, 0.6, 0.4);
  const node = new Object3D();
  node.position.set(cx, 0, cz);
  node.updateWorldMatrix(true, false);
  return { aabb, node };
}

function p95(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))];
}

describe('plan-664 §9.10 — ray basis cost in the browser (full per-scan path)', () => {
  it('3 scanners x 271 rays over broad-phase + collect + cast + noise stays within the budget order', () => {
    const rnd = mulberry32(664);
    const grid = new SpatialGridXZ<MuLike & { readonly aabb: AABB }>(1.0);
    const mus: (MuLike & { readonly aabb: AABB })[] = [];
    for (let i = 0; i < MUS; i++) {
      const mu = makeMu((rnd() - 0.5) * 40, (rnd() - 0.5) * 40);
      mus.push(mu);
      grid.insert(mu);
    }

    const angles = buildFan(270, 1);
    expect(angles.length).toBe(RAYS);
    const ranges = new Float32Array(RAYS);
    const kinds = new Uint8Array(RAYS);
    const buf = makeBoxBuffer(64);
    const qMin = new Float64Array(3);
    const qMax = new Float64Array(3);
    const queryAabb = new AABB();
    const gridOut: (MuLike & { readonly aabb: AABB })[] = [];
    const streams = Array.from({ length: SCANNERS }, (_, i) => makeStream(1, `Yard/Fork_${i}/Scanner`));
    // Three scanners spread over the yard, so each sees a different candidate set.
    const origins = [[0, 0.2, 0], [10, 0.2, -6], [-8, 0.2, 7]];

    const sources = {
      queryMUs: (min: ArrayLike<number>, max: ArrayLike<number>, out: MuLike[]): number => {
        queryAabb.min.set(min[0], min[1], min[2]);
        queryAabb.max.set(max[0], max[1], max[2]);
        const n = grid.queryXZ(queryAabb, gridOut);
        out.length = 0;
        for (let i = 0; i < n; i++) out.push(gridOut[i]);
        return n;
      },
    };

    let lastCandidates = 0;
    const tick = (): void => {
      for (let s = 0; s < SCANNERS; s++) {
        const o = origins[s];
        fanBounds(o, REACH, 2, qMin, qMax);
        collectCandidates(buf, sources, null, qMin, qMax);
        lastCandidates = buf.count;
        castFan(o, [0, 0, 1], [1, 0, 0], angles, 0.02, REACH, buf, ranges, kinds);
        applyNoise(ranges, NOISE, streams[s].normal, streams[s].uniform);
      }
    };

    // Chromium coarsens `performance.now()` to 100 us (Spectre mitigation), which
    // is the same order as one tick — timing a single tick would measure the
    // clock, not the code. So each sample is a BATCH of ticks divided by the
    // batch size; the p95 is then over per-tick averages.
    const BATCH = 50;
    for (let i = 0; i < 300; i++) tick();           // warm up
    const samples: number[] = [];
    for (let i = 0; i < 60; i++) {
      const t0 = performance.now();
      for (let k = 0; k < BATCH; k++) tick();
      samples.push((performance.now() - t0) / BATCH);
    }
    const sorted = [...samples].sort((a, b) => a - b);
    const median = sorted[samples.length >> 1];
    const worst = p95(samples);
    // eslint-disable-next-line no-console
    console.log(`[plan-664 §9.10 browser] ${SCANNERS} x ${RAYS} rays, ${MUS} MUs in the grid `
      + `(${lastCandidates} candidates in the last fan), batches of ${BATCH} ticks `
      + `-> median ${median.toFixed(4)} ms/tick, p95 ${worst.toFixed(4)} ms/tick `
      + `(budget ${BUDGET_MS} ms per fixed tick)`);
    expect(lastCandidates).toBeGreaterThan(0);
    expect(worst).toBeLessThan(BUDGET_MS * 10);
  });

  it('at the real 25 Hz schedule on a 60 Hz tick the per-tick p95 is well inside the budget', () => {
    // The budget is per FIXED TICK. At 25 Hz a scanner measures on roughly every
    // 2.4th 60 Hz tick, and three scanners with independent rate accumulators are
    // not phase-locked — so the all-three-in-one-tick case above is the ceiling,
    // not the distribution. This measures the distribution.
    const rnd = mulberry32(664);
    const grid = new SpatialGridXZ<MuLike & { readonly aabb: AABB }>(1.0);
    for (let i = 0; i < MUS; i++) grid.insert(makeMu((rnd() - 0.5) * 40, (rnd() - 0.5) * 40));

    const angles = buildFan(270, 1);
    const ranges = new Float32Array(RAYS);
    const kinds = new Uint8Array(RAYS);
    const buf = makeBoxBuffer(64);
    const qMin = new Float64Array(3);
    const qMax = new Float64Array(3);
    const queryAabb = new AABB();
    const gridOut: (MuLike & { readonly aabb: AABB })[] = [];
    const streams = Array.from({ length: SCANNERS }, (_, i) => makeStream(1, `Yard/Fork_${i}/Scanner`));
    const origins = [[0, 0.2, 0], [10, 0.2, -6], [-8, 0.2, 7]];
    const sources = {
      queryMUs: (min: ArrayLike<number>, max: ArrayLike<number>, out: MuLike[]): number => {
        queryAabb.min.set(min[0], min[1], min[2]);
        queryAabb.max.set(max[0], max[1], max[2]);
        const n = grid.queryXZ(queryAabb, gridOut);
        out.length = 0;
        for (let i = 0; i < n; i++) out.push(gridOut[i]);
        return n;
      },
    };
    const DT = 1 / 60;
    const PERIOD = 1 / 25;
    // Independent rate accumulators, phase-shifted as three real sensors are.
    const acc = [0, PERIOD / 3, (2 * PERIOD) / 3];
    const scansPerTick: number[] = [];
    const oneTick = (): void => {
      let fired = 0;
      for (let s = 0; s < SCANNERS; s++) {
        acc[s] += DT;
        if (acc[s] < PERIOD) continue;
        acc[s] -= PERIOD;
        fired++;
        const o = origins[s];
        fanBounds(o, REACH, 2, qMin, qMax);
        collectCandidates(buf, sources, null, qMin, qMax);
        castFan(o, [0, 0, 1], [1, 0, 0], angles, 0.02, REACH, buf, ranges, kinds);
        applyNoise(ranges, NOISE, streams[s].normal, streams[s].uniform);
      }
      scansPerTick.push(fired);
    };

    for (let i = 0; i < 600; i++) oneTick();        // warm up
    scansPerTick.length = 0;
    const BATCH = 60;                                // one second of ticks per sample
    const samples: number[] = [];
    for (let i = 0; i < 60; i++) {
      const t0 = performance.now();
      for (let k = 0; k < BATCH; k++) oneTick();
      samples.push((performance.now() - t0) / BATCH);
    }
    const sorted = [...samples].sort((a, b) => a - b);
    const median = sorted[samples.length >> 1];
    const worst = p95(samples);
    const avgScans = scansPerTick.reduce((a, b) => a + b, 0) / scansPerTick.length;
    // eslint-disable-next-line no-console
    console.log(`[plan-664 §9.10 browser 25Hz] ${SCANNERS} scanners x ${RAYS} rays at 25 Hz on a 60 Hz tick, `
      + `${MUS} MUs -> ${avgScans.toFixed(2)} scans/tick, median ${median.toFixed(4)} ms/tick, `
      + `p95 ${worst.toFixed(4)} ms/tick (budget ${BUDGET_MS} ms)`);
    expect(avgScans).toBeGreaterThan(1.1);          // the schedule really fires
    expect(avgScans).toBeLessThan(1.4);
    expect(worst).toBeLessThan(BUDGET_MS * 10);
  });

  it('the candidate buffer stops growing once it has seen its worst fan (steady state allocates nothing)', () => {
    const rnd = mulberry32(99);
    const grid = new SpatialGridXZ<MuLike & { readonly aabb: AABB }>(1.0);
    for (let i = 0; i < MUS; i++) grid.insert(makeMu((rnd() - 0.5) * 20, (rnd() - 0.5) * 20));
    const angles = buildFan(270, 1);
    const ranges = new Float32Array(RAYS);
    const kinds = new Uint8Array(RAYS);
    const buf = makeBoxBuffer(8);                    // deliberately too small at the start
    const qMin = new Float64Array(3);
    const qMax = new Float64Array(3);
    const queryAabb = new AABB();
    const gridOut: (MuLike & { readonly aabb: AABB })[] = [];
    const sources = {
      queryMUs: (min: ArrayLike<number>, max: ArrayLike<number>, out: MuLike[]): number => {
        queryAabb.min.set(min[0], min[1], min[2]);
        queryAabb.max.set(max[0], max[1], max[2]);
        const n = grid.queryXZ(queryAabb, gridOut);
        out.length = 0;
        for (let i = 0; i < n; i++) out.push(gridOut[i]);
        return n;
      },
    };
    const o = [0, 0.2, 0];
    fanBounds(o, REACH, 2, qMin, qMax);
    collectCandidates(buf, sources, null, qMin, qMax);
    const grownBounds = buf.bounds;
    const grownKinds = buf.kinds;
    expect(buf.count).toBeGreaterThan(8);            // it really had to grow
    for (let i = 0; i < 500; i++) {
      fanBounds(o, REACH, 2, qMin, qMax);
      collectCandidates(buf, sources, null, qMin, qMax);
      castFan(o, [0, 0, 1], [1, 0, 0], angles, 0.02, REACH, buf, ranges, kinds);
    }
    expect(buf.bounds).toBe(grownBounds);            // identity: no further reallocation
    expect(buf.kinds).toBe(grownKinds);
  });
});
