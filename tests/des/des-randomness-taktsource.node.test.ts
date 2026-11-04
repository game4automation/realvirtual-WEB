// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2051 §9.3 (PRIMAER, HEAVY, opt-in) - direct seed-variance proof of
 * `TaktSource`/`production.stochastic` on the REAL PalletYard scene (8 h,
 * plan-559 M3 configuration), not a synthetic harness and not an aggregate
 * metric (SOL round-2 finding 6): produced/delivered/blocked are compared
 * individually, so two inert consumers could not pass this silently.
 *
 * 5 runs with the same seed must be bit-identical (`toEqual`); 5 runs with 5
 * different seeds must ALL differ from each other in at least one of
 * produced/delivered/blocked.
 *
 * ONE browser-vitest child process PER RUN (10 total: 5 same-seed, 5
 * different-seed), the same discipline as
 * tests/des/pallet-yard-s10-compare.node.test.ts's soak/M3 children -
 * deliberately NOT 10 runs sequentially in one process: that exposed a
 * pre-existing, unrelated Fleet/AGV async-lifecycle gap (an in-flight
 * `MF.Agv.Replan` resolving after the next run's `dispose()` already freed
 * the clock, throwing `Fleet DES clock: disposed` as a `des-action-failed`
 * problem) that the existing M3/soak tests never exercise, because they only
 * ever do one load+dispose per process. Out of scope for this test-delivery
 * task; a fresh process per run avoids it entirely. See the Phase 3 report.
 *
 * Heavy (10 browser-vitest child processes, each ~15-30 s incl. boot) - run
 * on its own, in a load window:
 *   RV_RANDOMNESS_WIRING=1 npm run test:node -- tests/des/des-randomness-taktsource.node.test.ts
 * Each child inherits RV_TEST_LOCK_HELD from this process (global-lock-guard),
 * so it does not wait on the machine-wide test lock this run already holds.
 * Guarded like plan-630 §9.9b: skipped unless RV_RANDOMNESS_WIRING=1, so the
 * default `npm run test:node` / `npm run test:all` run stays fast.
 */
import { describe, expect, it } from 'vitest';
import { runChildVitest } from './_child-vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WV = resolve(HERE, '../..');
const FIXTURES = join(HERE, 'fixtures/plan-2051');
const TMP_NAME = '.plan2051-takt';

interface RunResult {
  seed: number; simTimeSec: number;
  produced: number; delivered: number; blocked: number;
  picks: number; stored: number; retrieved: number;
}
function resultLine(out: string, tag: string): RunResult {
  const m = out.match(new RegExp(`${tag} (\\{.*\\})`));
  if (!m) throw new Error(`no ${tag} line in the child output:\n${out.slice(-6000)}`);
  return JSON.parse(m[1]) as RunResult;
}

/** The three fields SOL round-2 finding 6 insists on checking individually. */
const signature = (r: RunResult): string => JSON.stringify([r.produced, r.delivered, r.blocked]);

describe.skipIf(process.env.RV_RANDOMNESS_WIRING !== '1')('plan-2051: TaktSource seed variance on PalletYard', () => {
  it('5 identical seeds are bit-identical; 5 different seeds all differ', () => {
    const script = readFileSync(join(FIXTURES, 'taktsource-variance.test.ts.txt'), 'utf8');
    const config = readFileSync(join(FIXTURES, 'vitest.taktsource.config.ts.txt'), 'utf8');
    const dir = join(WV, 'node_modules', TMP_NAME);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'vitest.taktsource.config.ts'), config.split('__PUBLIC_ROOT__').join(WV.replace(/\\/g, '/')));
    const cfgArgs = ['--config', join(dir, 'vitest.taktsource.config.ts'), join(dir, 'taktsource-variance.test.ts')];
    /** Write the fixture with `seed` substituted in, then run it in its own browser process. */
    const runWithSeed = (seed: number): RunResult => {
      const rewritten = script.split('__PUBLIC_ROOT__').join(WV.replace(/\\/g, '/')).split('__RV_TAKT_SEED__').join(String(seed));
      writeFileSync(join(dir, 'taktsource-variance.test.ts'), rewritten);
      return resultLine(runChildVitest('des-randomness-taktsource', cfgArgs, { timeout: 300_000, label: `seed ${seed}` }), 'TAKT_RUN_RESULT');
    };

    // One fresh browser process PER run (see the file doc comment for why:
    // a pre-existing, unrelated Fleet/AGV async-lifecycle gap surfaces when
    // several loadPalletYardScene()/dispose() cycles share one process).
    const sameSeed: RunResult[] = [];
    for (let i = 0; i < 5; i++) sameSeed.push(runWithSeed(1234));
    const diffSeed: RunResult[] = [];
    for (const seed of [1, 2, 3, 4, 5]) diffSeed.push(runWithSeed(seed));
    console.log('TAKT_VARIANCE_SUMMARY ' + JSON.stringify({ sameSeed, diffSeed }));

    expect(sameSeed).toHaveLength(5);
    expect(diffSeed).toHaveLength(5);

    // Same seed -> bit-identical (produced/delivered/blocked AND the full result object).
    for (const r of sameSeed.slice(1)) expect(r).toEqual(sameSeed[0]);
    // At least some actual production happened (not a degenerate/empty run).
    expect(sameSeed[0].produced).toBeGreaterThan(0);

    // 5 different seeds -> ALL FIVE differ from each other (not just one pair) in
    // produced/delivered/blocked - no aggregate metric that two inert consumers
    // could satisfy identically (SOL round-2 finding 6).
    const sigs = diffSeed.map(signature);
    expect(new Set(sigs).size).toBe(5);
  }, 1_800_000);
});
