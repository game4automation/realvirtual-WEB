// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-664 §9.10 — what the ray basis COSTS.
 *
 * The plan's acceptance budget is `3 scanners × 271 rays × 25 Hz` with 200 MUs
 * in the grid under **0.5 ms per fixed tick (p95)**. At 25 Hz and a 60 Hz tick
 * a scanner measures on roughly every second or third tick, so the worst tick —
 * the one measured here — is all three scanners casting in the same tick:
 * 813 rays against the candidates inside their fan.
 *
 * These numbers are a GATE, not decoration: above the budget Phase 3 does not
 * start on this basis but on the worker / GPU options in the plan's §7.
 *
 * ## Why this file asserts loosely
 *
 * A wall-clock assertion that is tight enough to be interesting is also tight
 * enough to go red on a loaded CI box — the repo has been bitten by exactly
 * that. So the hard assertion is an ORDER OF MAGNITUDE (a regression that
 * matters shows up as 10×, not 10 %), and the precise p95 is PRINTED for the
 * plan. The allocation check next to it is exact, because that one is a
 * property and not a timing.
 */

import { describe, it, expect } from 'vitest';
import {
  buildFan, castFan, applyNoise, BOX_STRIDE, HIT_MU, type BoxBuffer, type NoiseParams,
} from '../src/core/engine/rv-ray-scan';
import { mulberry32, makeStream } from '../src/core/engine/rv-prng';

const RAYS_PER_SCAN = 271;      // 270 deg at 1 deg
const SCANNERS = 3;
const MU_COUNT = 200;
/** Acceptance budget (ms) per fixed tick, p95 — plan-664 NFR. */
const BUDGET_MS = 0.5;

/** 200 MU-sized boxes scattered over a 40 × 40 m yard. */
function yardBoxes(seed: number, n = MU_COUNT): BoxBuffer {
  const rnd = mulberry32(seed);
  const b: BoxBuffer = { bounds: new Float32Array(n * BOX_STRIDE), kinds: new Uint8Array(n).fill(HIT_MU), count: n };
  for (let i = 0; i < n; i++) {
    const cx = (rnd() - 0.5) * 40;
    const cz = (rnd() - 0.5) * 40;
    const o = i * BOX_STRIDE;
    b.bounds[o] = cx - 0.6; b.bounds[o + 1] = 0; b.bounds[o + 2] = cz - 0.4;
    b.bounds[o + 3] = cx + 0.6; b.bounds[o + 4] = 1.2; b.bounds[o + 5] = cz + 0.4;
  }
  return b;
}

/** The boxes whose XZ footprint lies inside an 8 m fan around the origin — the broad-phase result. */
function inFan(all: BoxBuffer, reach: number): BoxBuffer {
  const keep: number[] = [];
  for (let i = 0; i < all.count; i++) {
    const o = i * BOX_STRIDE;
    if (all.bounds[o + 3] < -reach || all.bounds[o] > reach) continue;
    if (all.bounds[o + 5] < -reach || all.bounds[o + 2] > reach) continue;
    keep.push(i);
  }
  const b: BoxBuffer = {
    bounds: new Float32Array(keep.length * BOX_STRIDE), kinds: new Uint8Array(keep.length), count: keep.length,
  };
  keep.forEach((src, dst) => {
    b.bounds.set(all.bounds.subarray(src * BOX_STRIDE, src * BOX_STRIDE + BOX_STRIDE), dst * BOX_STRIDE);
    b.kinds[dst] = all.kinds[src];
  });
  return b;
}

function p95(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))];
}

const NOISE: NoiseParams = {
  sigma: 0.005, sigmaPerM: 0.002, dropout: 0.001, dropoutPerM: 0.001,
  resolution: 0.001, rangeMin: 0.02, rangeMax: 8,
};

describe('plan-664 §9.10 — ray basis cost (Node micro-benchmark)', () => {
  it('3 scanners x 271 rays x 200 MUs: p95 per tick is within the budget order of magnitude', () => {
    const angles = buildFan(270, 1);
    expect(angles.length).toBe(RAYS_PER_SCAN);
    const all = yardBoxes(1);
    const cand = inFan(all, 8);
    const ranges = new Float32Array(RAYS_PER_SCAN);
    const kinds = new Uint8Array(RAYS_PER_SCAN);
    const streams = Array.from({ length: SCANNERS }, (_, i) => makeStream(1, `Yard/Fork_${i}/Scanner`));
    const origin = [0, 0.2, 0];
    const fwd = [0, 0, 1];
    const right = [1, 0, 0];

    const tick = (): void => {
      for (let s = 0; s < SCANNERS; s++) {
        castFan(origin, fwd, right, angles, 0.02, 8, cand, ranges, kinds);
        applyNoise(ranges, NOISE, streams[s].normal, streams[s].uniform);
      }
    };

    for (let i = 0; i < 200; i++) tick();           // warm up the JIT
    const samples: number[] = [];
    for (let i = 0; i < 400; i++) {
      const t0 = performance.now();
      tick();
      samples.push(performance.now() - t0);
    }
    const median = p95(samples.slice()) && [...samples].sort((a, b) => a - b)[samples.length >> 1];
    const worst = p95(samples);
    const rays = SCANNERS * RAYS_PER_SCAN;
    // eslint-disable-next-line no-console
    console.log(`[plan-664 §9.10 node] ${SCANNERS} x ${RAYS_PER_SCAN} rays vs ${cand.count}/${MU_COUNT} candidates `
      + `-> median ${median.toFixed(4)} ms, p95 ${worst.toFixed(4)} ms `
      + `(${(rays / Math.max(worst, 1e-6)).toFixed(0)} rays/ms at p95; budget ${BUDGET_MS} ms)`);
    // Order-of-magnitude gate only — see the file header.
    expect(worst).toBeLessThan(BUDGET_MS * 10);
    expect(cand.count).toBeGreaterThan(10);          // the scenario is not accidentally empty
  });

  it('a worst case with EVERY MU inside the fan is still bounded', () => {
    const angles = buildFan(270, 1);
    const cand = yardBoxes(2, MU_COUNT);
    // Squeeze the yard so all 200 boxes sit inside the 8 m fan.
    for (let i = 0; i < cand.bounds.length; i += BOX_STRIDE) {
      cand.bounds[i] *= 0.15; cand.bounds[i + 3] *= 0.15;
      cand.bounds[i + 2] *= 0.15; cand.bounds[i + 5] *= 0.15;
    }
    const ranges = new Float32Array(RAYS_PER_SCAN);
    const kinds = new Uint8Array(RAYS_PER_SCAN);
    const origin = [0, 0.2, 0];
    const tick = (): void => {
      for (let s = 0; s < SCANNERS; s++) castFan(origin, [0, 0, 1], [1, 0, 0], angles, 0.02, 8, cand, ranges, kinds);
    };
    for (let i = 0; i < 100; i++) tick();
    const samples: number[] = [];
    for (let i = 0; i < 200; i++) { const t0 = performance.now(); tick(); samples.push(performance.now() - t0); }
    const worst = p95(samples);
    // eslint-disable-next-line no-console
    console.log(`[plan-664 §9.10 node worst] ${SCANNERS} x ${RAYS_PER_SCAN} rays vs ALL ${cand.count} MUs `
      + `-> p95 ${worst.toFixed(4)} ms (${(SCANNERS * RAYS_PER_SCAN / Math.max(worst, 1e-6)).toFixed(0)} rays/ms)`);
    expect(worst).toBeLessThan(50); // a pure sanity ceiling, not a budget
  });

  it('10 000 scans grow the heap by less than 64 KB (no allocation in the hot path)', () => {
    const angles = buildFan(270, 1);
    const cand = inFan(yardBoxes(3), 8);
    const ranges = new Float32Array(RAYS_PER_SCAN);
    const kinds = new Uint8Array(RAYS_PER_SCAN);
    const s = makeStream(1, 'Yard/Fork_0/Scanner');
    const origin = [0, 0.2, 0];
    const scan = (): void => {
      castFan(origin, [0, 0, 1], [1, 0, 0], angles, 0.02, 8, cand, ranges, kinds);
      applyNoise(ranges, NOISE, s.normal, s.uniform);
    };
    for (let i = 0; i < 2000; i++) scan();
    const gc = (globalThis as { gc?: () => void }).gc;
    gc?.();
    const before = process.memoryUsage().heapUsed;
    for (let i = 0; i < 10_000; i++) scan();
    gc?.();
    const grown = process.memoryUsage().heapUsed - before;
    // eslint-disable-next-line no-console
    console.log(`[plan-664 §9.10 node heap] 10000 scans -> ${(grown / 1024).toFixed(1)} KiB `
      + `(${gc ? 'with --expose-gc' : 'WITHOUT --expose-gc, indicative only'})`);
    if (gc) expect(grown).toBeLessThan(64 * 1024);
    else expect(grown).toBeLessThan(8 * 1024 * 1024); // without gc only a gross-leak guard
  });
});
