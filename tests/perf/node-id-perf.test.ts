// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-769 test 9.15 — the identity step at decode costs at most +10 % decode time (NFR).
 *
 * "Decode" is what `parseGlbCollectingResources` does for every GLB the viewer loads:
 * the GLTFLoader parse, then `decodeIdentity` (seeded NodeIds, the file's authored
 * index, the one-time migration of its stored paths). The baseline is the same parse
 * WITHOUT the identity step — the decode as it was before plan-769.
 *
 * Method: fresh bytes per run, baseline and identity runs INTERLEAVED (so drift hits
 * both alike), 2 warm-up pairs, median of ≥ 5 measured pairs. CI uses a mid-size
 * public fixture (LaserWeldingAssemblyStation, ~2 400 nodes, 21 MB); the Mauser
 * Cageline (~70 000 nodes) runs only locally behind `VITE_RV_MAUSER_GLB`; the heap
 * delta only locally behind `VITE_RV_PERF_HEAP` (Chrome's `performance.memory`).
 *
 * **The NFR (≤ +10 %) is NOT met today.** Plan open point: plan-769 frontmatter
 * "9.15 NFR verfehlt". The suite therefore has two kinds of cases:
 *  - **strict NFR check**, both fixtures at the plan value (≤ +10 %), only on request:
 *    `VITE_RV_PERF_STRICT=1` (Mauser additionally needs `VITE_RV_MAUSER_GLB`). It reports
 *    the miss honestly — red until the NFR is met;
 *  - **regression guard** (always on, CI fixture only): ≤ +20 %, clearly above the measured
 *    spread (+10.3–12.3 %) and below the pre-pass +23 %. It is NOT the NFR — it only catches
 *    the identity step getting expensive again.
 * (Until 2026-10-22 the NFR cases were `it.fails`; with Laser at +10.3–12.3 % that was a
 * coin flip — any run below 10 % turned the suite red.)
 *
 * Strict run: `VITE_RV_PERF_STRICT=1 VITE_RV_MAUSER_GLB=/private-models/mauser3dhmi/MauserCageline30.glb
 * npx vitest run tests/perf/node-id-perf.test.ts` (Git Bash: `MSYS_NO_PATHCONV=1`).
 *
 * History on Vincent's machine (vitest browser = headless Chromium 145):
 *  - 2026-10-22, first cut: LaserWeldingAssemblyStation (2 391 nodes, 393 references)
 *    +22–25 % (identity ≈ 15–18 ms); Mauser Cageline30 (70 437 nodes, 34 528 references)
 *    +30–33 % (identity ≈ 680–794 ms of ≈ 2 100–2 600 ms decode).
 *  - 2026-10-22, after the 9.15 performance pass (results bit-identical, see
 *    tests/node-id-seed.node.test.ts "bulk seed == reference"): LaserWelding +10.3–12.3 %
 *    (identity ≈ 9–12 ms), Mauser +13.8–14.5 % (identity ≈ 370–430 ms). The pass: the seed
 *    hashes namespace ‖ path bytes written incrementally and resumes SHA-1 from the parent's
 *    last complete block (unrolled compression, Int32 view), "taken" on a 48-bit key table,
 *    pooled scratch arrays; the migration looks paths up by walking the tree instead of
 *    hashing every node's full path, builds the legacy (Three) spelling only per visited node,
 *    computes one verdict per distinct written path, and the reference walk iterates with
 *    `for…in` and allocates nothing for values that cannot hold a reference.
 *    What is left is split roughly evenly between the seed's walk and the reference walk +
 *    lookups; in this runner a good part of it is garbage collection the decode's ~50 MB
 *    (Mauser) of short-lived allocations trigger on the freshly parsed heap.
 */

import { describe, expect, it } from 'vitest';
import { gltfLoader } from '../../src/core/engine/rv-glb-parse';
import { decodeIdentity, type DecodedGltfLike } from '../../src/core/engine/rv-decode-identity';

const env = (import.meta as unknown as { env: Record<string, string | undefined> }).env;
const MAUSER_URL = env.VITE_RV_MAUSER_GLB;
const HEAP = !!env.VITE_RV_PERF_HEAP;
const CI_FIXTURE = '/demo-realvirtual/LaserWeldingAssemblyStation.glb';
/** The NFR of plan-769 §3 (Performance): identity at decode ≤ +10 % decode time. */
const MAX_OVERHEAD = 0.10;
/** Regression guard for the CI fixture — NOT the NFR (see the module doc). */
const GUARD_OVERHEAD = 0.20;
const STRICT = !!env.VITE_RV_PERF_STRICT;
const WARMUP = 2;
const RUNS = 7;

type Parsed = { scene: unknown; parser?: { json?: unknown } };

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

async function parse(bytes: ArrayBuffer): Promise<Parsed> {
  return (gltfLoader as unknown as { parseAsync(b: ArrayBuffer, p: string): Promise<Parsed> }).parseAsync(bytes.slice(0), '');
}

async function baseline(bytes: ArrayBuffer): Promise<number> {
  const t = performance.now();
  await parse(bytes);
  return performance.now() - t;
}

async function withIdentity(bytes: ArrayBuffer): Promise<[number, number]> {
  const t = performance.now();
  const parsed = await parse(bytes);
  const t1 = performance.now();
  const identity = decodeIdentity(parsed as unknown as DecodedGltfLike, { fileKey: 'perf' });
  const t2 = performance.now();
  expect(identity, 'the identity step ran').not.toBeNull();
  return [t2 - t, t2 - t1];
}

/**
 * One interleaved pair: [baseline ms, identity decode ms, identity-step ms]. The order
 * alternates per pair — the second parse of a pair pays the GC of the first, which
 * would otherwise land on one side only.
 */
async function pair(bytes: ArrayBuffer, k: number): Promise<[number, number, number]> {
  if (k % 2 === 0) {
    const base = await baseline(bytes);
    const [w, o] = await withIdentity(bytes);
    return [base, w, o];
  }
  const [w, o] = await withIdentity(bytes);
  return [await baseline(bytes), w, o];
}

/**
 * `overhead` = identity step / baseline decode (medians) — the cost the step adds to a
 * decode; `wallOverhead` = identity decode / baseline − 1, reported for reference (it
 * carries the GC noise of back-to-back parses).
 */
async function measure(bytes: ArrayBuffer): Promise<{ baseMs: number; withMs: number; identityMs: number; overhead: number; wallOverhead: number }> {
  for (let i = 0; i < WARMUP; i++) await pair(bytes, i);
  const base: number[] = [];
  const withId: number[] = [];
  const idOnly: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    const [b, w, o] = await pair(bytes, i);
    base.push(b); withId.push(w); idOnly.push(o);
  }
  const baseMs = median(base);
  const withMs = median(withId);
  const identityMs = median(idOnly);
  return { baseMs, withMs, identityMs, overhead: identityMs / baseMs, wallOverhead: withMs / baseMs - 1 };
}

async function fetchBytes(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url);
  expect(res.ok, `fixture ${url}`).toBe(true);
  return res.arrayBuffer();
}

function report(label: string, r: Awaited<ReturnType<typeof measure>>): void {
  console.log(`[9.15 ${label}] ${JSON.stringify({ ...r, overhead: (r.overhead * 100).toFixed(1) + '%', wallOverhead: (r.wallOverhead * 100).toFixed(1) + '%' })}`);
}

describe('plan-769 9.15 — identity at decode (regression guard always; NFR ≤ +10 % on request)', () => {
  // REGRESSION GUARD, not the NFR: generous ceiling above the measured +10.3–12.3 %.
  it(`regression guard: ${CI_FIXTURE} identity step ≤ +${GUARD_OVERHEAD * 100} % (NOT the NFR)`, async () => {
    const bytes = await fetchBytes(CI_FIXTURE);
    const r = await measure(bytes);
    report(`guard ${CI_FIXTURE}`, r);
    expect(r.overhead).toBeLessThanOrEqual(GUARD_OVERHEAD);
  }, 300_000);

  // STRICT NFR (plan value), only with VITE_RV_PERF_STRICT — NOT met today (+10.3–12.3 %).
  it.runIf(STRICT)(`NFR ≤ +10 %: mid-size fixture (${CI_FIXTURE}) (VITE_RV_PERF_STRICT)`, async () => {
    const bytes = await fetchBytes(CI_FIXTURE);
    const r = await measure(bytes);
    report(CI_FIXTURE, r);
    expect(r.overhead).toBeLessThanOrEqual(MAX_OVERHEAD);
  }, 300_000);

  // STRICT NFR (plan value), only with VITE_RV_PERF_STRICT + VITE_RV_MAUSER_GLB — NOT met today (+13.8–14.5 %).
  it.runIf(STRICT && !!MAUSER_URL)('NFR ≤ +10 %: Mauser Cageline30 (VITE_RV_PERF_STRICT, VITE_RV_MAUSER_GLB)', async () => {
    const bytes = await fetchBytes(MAUSER_URL!);
    const r = await measure(bytes);
    report('Mauser', r);
    expect(r.overhead).toBeLessThanOrEqual(MAX_OVERHEAD);
  }, 1_800_000);

  it.skipIf(!HEAP)('heap delta of the identity step (LOCAL, VITE_RV_PERF_HEAP, Chrome performance.memory)', async () => {
    const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
    expect(mem, 'performance.memory (Chrome)').toBeTruthy();
    const bytes = await fetchBytes(MAUSER_URL ?? CI_FIXTURE);
    const parsed = await parse(bytes);
    const before = mem!.usedJSHeapSize;
    const identity = decodeIdentity(parsed as unknown as DecodedGltfLike, { fileKey: 'perf-heap' });
    const after = mem!.usedJSHeapSize;
    expect(identity).not.toBeNull();
    // Reported, not asserted: Chrome quantises the counter and the GC runs when it wants.
    console.log(`[9.15 heap] ${JSON.stringify({ fixture: MAUSER_URL ?? CI_FIXTURE, deltaMB: +((after - before) / 1048576).toFixed(1) })}`);
  }, 600_000);
});
