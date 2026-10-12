// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Deterministic 32-bit PRNG (mulberry32) for tests — no `Math.random`
 * anywhere in a seeded fixture.
 *
 * Extracted from `src/core/engine/perf/rv-synthetic-line.ts` (plan-756 §2.2).
 * The production copy stays where it is on purpose: `src/` must never import
 * from `tests/`, and a shared module for six lines of arithmetic would couple
 * the perf harness to the test tree for no gain.
 */
export function makeRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
