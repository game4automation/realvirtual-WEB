// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-664 §9.1 — PRNG and the noise layer.
 *
 * Two things are pinned here. First, DETERMINISM: the same seed gives the same
 * stream, two sensors never share one, and the statistics of the Gaussian are
 * what the error model assumes. Second, the CONSOLIDATION: `rv-prng.mulberry32`
 * replaced two identical production copies (`sensor-history-data.ts`,
 * `perf/rv-synthetic-line.ts`), and the reference vector below is what makes
 * that a refactoring rather than a change — a different stream would silently
 * alter every synthetic perf scene and every generated sensor history.
 */

import { describe, it, expect } from 'vitest';
import { mulberry32, hashString, seedFor, gaussian, makeStream } from '../src/core/engine/rv-prng';
import { mulberry32 as historyMulberry, hashPath } from '../src/core/hmi/sensor-history-data';
import { applyNoise, NO_HIT, type NoiseParams } from '../src/core/engine/rv-ray-scan';

/**
 * First eight draws of `mulberry32(42)`, captured from the implementation that
 * lived in `sensor-history-data.ts` BEFORE plan-664 moved it. Do not regenerate
 * these from the current code — that would make the test tautological.
 */
const REF_42 = [
  0.6011037519201636, 0.44829055899754167, 0.8524657934904099, 0.6697340414393693,
  0.17481389874592423, 0.5265925421845168, 0.2732279943302274, 0.6247446539346129,
];
/** Sum of the first 1000 draws of `mulberry32(7)`, captured the same way. */
const REF_SUM_1000_SEED_7 = 519.6141281826422;

const noise = (p: Partial<NoiseParams>): NoiseParams => ({
  sigma: 0, sigmaPerM: 0, dropout: 0, dropoutPerM: 0, resolution: 0, rangeMin: 0, rangeMax: Infinity, ...p,
});

describe('rv-prng — determinism', () => {
  it('the same seed gives the same stream, a different seed a different one', () => {
    const a = mulberry32(1234);
    const b = mulberry32(1234);
    const c = mulberry32(1235);
    const sa: number[] = [];
    const sb: number[] = [];
    const sc: number[] = [];
    for (let i = 0; i < 64; i++) { sa.push(a()); sb.push(b()); sc.push(c()); }
    expect(sb).toEqual(sa);
    expect(sc).not.toEqual(sa);
    expect(sa.every((v) => v >= 0 && v < 1)).toBe(true);
  });

  it('the stream is bit-identical to the pre-consolidation implementation', () => {
    const r = mulberry32(42);
    for (const want of REF_42) expect(r()).toBe(want);
    const r7 = mulberry32(7);
    let sum = 0;
    for (let i = 0; i < 1000; i++) sum += r7();
    expect(sum).toBe(REF_SUM_1000_SEED_7);
    // ... and the historic export is literally the same function now.
    expect(historyMulberry).toBe(mulberry32);
    expect(hashPath).toBe(hashString);
  });

  it('hashString is FNV-1a: stable, uint32, and sensitive to every character', () => {
    expect(hashString('Cell/Conv1/B-IGC01')).toBe(hashString('Cell/Conv1/B-IGC01'));
    expect(hashString('Cell/Conv1/B-IGC01')).not.toBe(hashString('Cell/Conv1/B-IGC02'));
    expect(hashString('')).toBe(0x811c9dc5);
    const h = hashString('ÄÖÜ/∑∆');
    expect(Number.isInteger(h)).toBe(true);
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThanOrEqual(0xffffffff);
  });

  it('every sensor gets its own stream: a different path means different noise', () => {
    const a = makeStream(7, 'Yard/Fork_1/Scanner');
    const b = makeStream(7, 'Yard/Fork_2/Scanner');
    expect(a.seed).not.toBe(b.seed);
    const sa = Array.from({ length: 32 }, () => a.uniform());
    const sb = Array.from({ length: 32 }, () => b.uniform());
    expect(sa).not.toEqual(sb);
    // Same master + path reproduces it exactly.
    expect(Array.from({ length: 32 }, () => makeStream(7, 'Yard/Fork_1/Scanner').uniform()).slice(0, 1))
      .toEqual(sa.slice(0, 1));
  });

  it('neighbouring master seeds do not produce neighbouring streams (the mix is not an add)', () => {
    const p = 'Yard/Fork_1/Scanner';
    const s1 = seedFor(1, p);
    const s2 = seedFor(2, p);
    expect(Math.abs(s1 - s2)).toBeGreaterThan(1000);
    const a = mulberry32(s1)();
    const b = mulberry32(s2)();
    expect(Math.abs(a - b)).toBeGreaterThan(1e-3);
  });

  it('an explicit seed overrides the derivation', () => {
    const a = makeStream(7, 'Any/Path', 99);
    const b = makeStream(123, 'Other/Path', 99);
    expect(a.seed).toBe(99);
    expect(a.uniform()).toBe(b.uniform());
  });
});

describe('rv-prng — gaussian', () => {
  it('mean and sigma are within 1 % over 100 000 samples', () => {
    const g = gaussian(mulberry32(2026));
    const n = 100_000;
    let sum = 0;
    let sumSq = 0;
    for (let i = 0; i < n; i++) { const v = g(); sum += v; sumSq += v * v; }
    const mean = sum / n;
    const sigma = Math.sqrt(sumSq / n - mean * mean);
    expect(Math.abs(mean)).toBeLessThan(0.01);
    expect(Math.abs(sigma - 1)).toBeLessThan(0.01);
  });

  it('uses both Box-Muller outputs (the pair buffer), so it never returns NaN or Infinity', () => {
    const g = gaussian(mulberry32(5));
    for (let i = 0; i < 10_000; i++) {
      const v = g();
      expect(Number.isFinite(v)).toBe(true);
    }
  });
});

describe('rv-ray-scan — applyNoise', () => {
  it('without parameters it is a no-op and draws no random numbers', () => {
    const r = new Float32Array([1, 2, 3, NO_HIT]);
    let draws = 0;
    applyNoise(r, noise({}), () => { draws++; return 0; }, () => { draws++; return 0; });
    expect(Array.from(r)).toEqual([1, 2, 3, NO_HIT]);
    expect(draws).toBe(0);
  });

  it('missed rays stay -1 and consume NO randomness (the stream must not depend on hits)', () => {
    const hit = new Float32Array([NO_HIT, 2, NO_HIT, 4]);
    const seq: number[] = [];
    const s = makeStream(1, 'S');
    applyNoise(hit, noise({ sigma: 0.01, dropout: 0.1 }), () => { seq.push(0); return s.normal(); }, () => s.uniform());
    expect(hit[0]).toBe(NO_HIT);
    expect(hit[2]).toBe(NO_HIT);
    expect(seq.length).toBe(2); // exactly the two real readings
  });

  it('the same seed and the same input give the same noised output', () => {
    const base = [1, 2, 3, 4, 5, 6, 7, 8];
    const run = (): number[] => {
      const r = Float32Array.from(base);
      const s = makeStream(11, 'Yard/Scanner');
      applyNoise(r, noise({ sigma: 0.005, sigmaPerM: 0.002 }), s.normal, s.uniform);
      return Array.from(r);
    };
    expect(run()).toEqual(run());
    expect(run()).not.toEqual(base);
  });

  it('sigma grows with distance: the spread at 10 m exceeds the spread at 1 m', () => {
    const p = noise({ sigma: 0.002, sigmaPerM: 0.01 });
    const spread = (d: number): number => {
      const s = makeStream(3, 'S');
      let sum = 0;
      let sumSq = 0;
      const n = 20_000;
      const r = new Float32Array(1);
      for (let i = 0; i < n; i++) {
        r[0] = d;
        applyNoise(r, p, s.normal, s.uniform);
        sum += r[0] - d;
        sumSq += (r[0] - d) ** 2;
      }
      return Math.sqrt(sumSq / n - (sum / n) ** 2);
    };
    const s1 = spread(1);
    const s10 = spread(10);
    expect(s10).toBeGreaterThan(s1 * 3);
    expect(Math.abs(s1 - (0.002 + 0.01))).toBeLessThan(0.002);
  });

  it('dropout rises with distance and drops rays to -1', () => {
    const p = noise({ dropout: 0.05, dropoutPerM: 0.05 });
    const rate = (d: number): number => {
      const s = makeStream(4, 'S');
      const n = 20_000;
      const r = new Float32Array(n).fill(d);
      applyNoise(r, p, s.normal, s.uniform);
      let dropped = 0;
      for (let i = 0; i < n; i++) if (r[i] === NO_HIT) dropped++;
      return dropped / n;
    };
    expect(rate(1)).toBeGreaterThan(0.08);
    expect(rate(1)).toBeLessThan(0.12);
    expect(rate(5)).toBeGreaterThan(rate(1) * 2);
  });

  it('quantisation snaps to the resolution grid', () => {
    const r = new Float32Array([1.234, 2.567, 0.049]);
    const s = makeStream(1, 'S');
    applyNoise(r, noise({ resolution: 0.05 }), s.normal, s.uniform);
    for (const v of r) expect(Math.abs(Math.round(v / 0.05) * 0.05 - v)).toBeLessThan(1e-6);
    expect(r[0]).toBeCloseTo(1.25, 6);
  });

  it('a reading noise pushes out of range drops out — it is never clamped to a wall that is not there', () => {
    const r = new Float32Array([7.999]);
    // A huge sigma with a stream whose first normal is positive pushes it past rangeMax.
    let normals = 0;
    applyNoise(r, noise({ sigma: 5, rangeMin: 0.02, rangeMax: 8 }), () => { normals++; return 2; }, () => 0);
    expect(normals).toBe(1);
    expect(r[0]).toBe(NO_HIT);
    const r2 = new Float32Array([0.03]);
    applyNoise(r2, noise({ sigma: 5, rangeMin: 0.02, rangeMax: 8 }), () => -2, () => 0);
    expect(r2[0]).toBe(NO_HIT);   // below the dead zone, not clamped to rangeMin
  });
});
